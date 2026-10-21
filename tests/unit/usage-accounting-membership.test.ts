import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";
import { afterAll, describe, expect, it } from "vitest";
import { taskQueueAll } from "../../server/task-queue.js";
import { checkTaskBinding, type TaskMembership, type UsageFact } from "../../server/usage-accounting-contract.js";
import {
	COLLECTOR_LIMITS,
	UsageAccountingCollector,
	type CollectorIO,
	type SourceInventory,
	type SourceBatch,
} from "../../server/usage-accounting-collector.js";
import {
	MEMBERSHIP_LIMITS,
	mapUsageMembership,
	membershipSourceBatches,
	projectMembershipConversation,
	projectMembershipDelegate,
	projectMembershipRegistryEvent,
	projectMembershipSessionEntry,
	taskMembershipAt,
	type MembershipMap,
	type MembershipPage,
	type MembershipSources,
	type SessionMembershipPage,
} from "../../server/usage-accounting-membership.js";

type Rec = Record<string, unknown>;
const Q = "/synthetic/queue.jsonl";
const T = 1791792000000;
const time = (n: number) => new Date(n).toISOString();
function page(records: unknown[], status: MembershipPage["status"] = "complete"): MembershipPage {
	return { status, records, bytesRead: Buffer.byteLength(JSON.stringify(records), "utf8") };
}
function fixture(): MembershipSources {
	// Only checked-in synthetic fixtures; never discover queue, registry, chat or ledger paths.
	const sources = JSON.parse(
		readFileSync(new URL("../fixtures/usage-accounting-membership/sources.json", import.meta.url), "utf8"),
	) as MembershipSources;
	for (const p of [...sources.sessions, sources.registry, sources.conversations, sources.delegates])
		p.bytesRead = Buffer.byteLength(JSON.stringify(p.records), "utf8");
	return sources;
}
function expected(): MembershipMap {
	return JSON.parse(
		readFileSync(new URL("../fixtures/usage-accounting-membership/expected.json", import.meta.url), "utf8"),
	) as MembershipMap;
}
const map = (sources = fixture()) => mapUsageMembership(sources, () => 0);
const own = (sources: MembershipSources, file: string) => sources.sessions.find((s) => s.file === file)!;
const data = (entry: unknown) => (entry as { data?: Rec }).data;
const header = (file: string, sessionId: string, at = T - 1000, parentSession?: string): SessionMembershipPage => ({
	file,
	...page([{ type: "session", id: sessionId, timestamp: time(at), ...(parentSession ? { parentSession } : {}) }]),
});
const op = (name: string, id: number, at = T, extra: Rec = {}) => ({
	type: "custom",
	customType: "queue",
	data: { v: 1, op: name, id, ts: at, ...extra },
});
function minimal(): MembershipSources {
	const queue = header(Q, "q");
	queue.records = [
		...queue.records,
		op("add", 1, T, { standalone: true }),
		op("start", 1, T + 1000, { lane: true }),
		op("chat", 1, T + 2000, { file: "/synthetic/a.jsonl" }),
	];
	const a = header("/synthetic/a.jsonl", "a", T + 1000);
	a.records = [...a.records, op("assigned", 1, T + 2000, { from: { file: Q }, standalone: true })];
	return { sessions: [queue, a], registry: page([]), conversations: page([]), delegates: page([]) };
}
function ledger(
	conversationId: string,
	sessionFile: string | null,
	sessionId: string | null,
	origin = "chat",
	parentConversationId: string | null = null,
	at = T + 2000,
): Rec {
	return {
		v: "usage-ledger/1",
		conversationId,
		sessionId,
		sessionFile,
		persist: true,
		origin,
		parentConversationId,
		at: time(at),
		occurredAt: time(at),
	};
}
function gapCodes(value: MembershipMap): string[] {
	return value.gaps.map((g) => g.code);
}
const CONTEXT = {
	stream: "fixture:membership",
	incarnation: "fixture:feed-1",
	adapterRef: "fixture:metadata-only",
	fromCursor: null,
	cursorTokens: ["fixture:cursor-1"],
	from: "2026-10-11T00:00:00.000Z",
	through: "2026-10-18T00:00:00.000Z",
	observedAt: "2026-10-18T00:00:00.000Z",
};
/** In-memory numeric journal, not a source/session writer or a production I/O adapter. */
class MemoryIO implements CollectorIO {
	segments: string[] = [];
	checkpointText: string | null = null;
	async read(): Promise<{ segments: string[]; checkpoint: string | null }> {
		return { segments: [...this.segments], checkpoint: this.checkpointText };
	}
	async append(segment: number, expectedBytes: number, line: string): Promise<void> {
		const previous = this.segments[segment - 1] ?? "";
		if (Buffer.byteLength(previous) !== expectedBytes) throw new Error("fixture-cas");
		this.segments[segment - 1] = previous + line;
	}
	async sync(): Promise<void> {}
	async checkpoint(text: string): Promise<void> {
		this.checkpointText = text;
	}
}
async function collector() {
	const inventory: SourceInventory = {
		v: "usage-inventory/1",
		evidenceRef: "fixture:inventory",
		observedAt: CONTEXT.observedAt,
		complete: false,
		sources: [
			{
				stream: CONTEXT.stream,
				incarnation: CONTEXT.incarnation,
				adapterRef: CONTEXT.adapterRef,
				producer: "pi",
				occurrenceStreams: [CONTEXT.stream],
				retainedFrom: CONTEXT.from,
				grants: ["memberships"],
			},
		],
	};
	return UsageAccountingCollector.open({
		inventory,
		io: new MemoryIO(),
		clock: () => 0,
		verifier: {
			inventory: (v) => v.evidenceRef === "fixture:inventory",
			batch: (b) => b.stream === CONTEXT.stream && b.adapterRef === CONTEXT.adapterRef,
		},
	});
}

describe("usage-accounting-membership: H-AUTOCOST-6, fixed source witnesses only", () => {
	it("produces exactly every expected membership, original birth, parent-history and unassigned row", () => {
		expect(map()).toEqual(expected());
	});
	it("is independent of source enumeration order and does not mutate its inputs", () => {
		const sources = fixture();
		const before = structuredClone(sources);
		const reversed = structuredClone(sources);
		reversed.sessions = [...reversed.sessions].reverse();
		reversed.conversations.records = [...reversed.conversations.records].reverse();
		expect(map(reversed)).toEqual(map(sources));
		expect(sources).toEqual(before);
	});
	it("re-runs share the original add key, not assigned's later birth", () => {
		const result = map();
		const ownRows = result.memberships.filter((m) =>
			["/synthetic/task.jsonl", "/synthetic/rerun.jsonl"].includes(m.file),
		);
		expect(ownRows).toHaveLength(2);
		expect(ownRows.map(({ queue, task, addedAt }) => ({ queue, task, addedAt }))).toEqual([
			{ queue: Q, task: 7, addedAt: time(T) },
			{ queue: Q, task: 7, addedAt: time(T) },
		]);
	});
	it("does not apply latest task/project parents backwards; the contract rejects that substitution", () => {
		const result = map();
		const earlier = taskMembershipAt(result, "/synthetic/task.jsonl", "2026-10-12T12:00:00.000Z", "chat")!;
		const projectMoved = taskMembershipAt(result, "/synthetic/task.jsonl", "2026-10-14T00:00:00.000Z", "chat")!;
		const taskMoved = taskMembershipAt(result, "/synthetic/task.jsonl", "2026-10-15T00:00:00.000Z", "chat")!;
		expect([
			earlier.project,
			earlier.initiative,
			projectMoved.project,
			projectMoved.initiative,
			taskMoved.project,
			taskMoved.initiative,
		]).toEqual(["alpha", "old", "alpha", "new", "beta", "third"]);
		const numericFact = { occurredAt: "2026-10-12T12:00:00.000Z", links: { task: earlier } } as UsageFact;
		expect(checkTaskBinding(numericFact, result.parentHistory)).toBe("verified");
		expect(checkTaskBinding({ ...numericFact, links: { task: taskMoved } } as UsageFact, result.parentHistory)).toBe(
			"mismatch",
		);
		expect(taskMembershipAt(result, "/synthetic/task.jsonl", "2026-10-12T09:00:00.000Z", "chat")).toBeNull();
	});
	it("uses the existing queue replay's lifecycle: parent edits after done are ignored", () => {
		const sources = fixture();
		const entries = own(sources, Q)
			.records.map(projectMembershipSessionEntry)
			.filter((e) => e !== null);
		const replayed = taskQueueAll(entries);
		expect(replayed.tasks.find((t) => t.id === 7)?.parent).toEqual({ project: "beta" });
		expect(map(sources).parentHistory.some((m) => m.initiative === "forbidden-late-parent")).toBe(false);
	});
	it("home/ad-hoc/unnamed helpers stay outside tasks despite matching names, folder and time", () => {
		const result = map();
		expect(result.notInAnyTask).toEqual(expected().notInAnyTask);
		for (const row of result.notInAnyTask)
			expect(taskMembershipAt(result, row.file, "2026-10-13T12:00:00.000Z", "chat")).toBeNull();
		expect(result.parentHistory.every((m) => m.queue === Q)).toBe(true); // copied queue adds cannot mint births
	});
	it("never reads forbidden payload properties, even getters that throw, or emits planted text", () => {
		const sources = fixture();
		let opened = 0;
		const poison = (object: object, key: string) =>
			Object.defineProperty(object, key, {
				configurable: true,
				get() {
					opened++;
					throw new Error("forbidden-payload-access");
				},
			});
		for (const s of sources.sessions)
			for (const entry of s.records) {
				poison(entry as object, "message");
				poison(entry as object, "cwd");
				const d = data(entry);
				if (d) for (const key of ["plan", "summary", "question", "title", "prompt", "results"]) poison(d, key);
			}
		for (const entry of sources.registry.records) {
			poison(entry as object, "goal");
			const changes = (entry as Rec).changes;
			if (changes) poison(changes as object, "name");
		}
		for (const entry of [...sources.conversations.records, ...sources.delegates.records])
			for (const key of ["systemPrompt", "initialMessages", "prompt", "result", "title"]) poison(entry as object, key);
		const result = map(sources);
		expect(result).toEqual(expected());
		expect(opened).toBe(0);
		expect(JSON.stringify([result, membershipSourceBatches(result, CONTEXT)])).not.toContain("NEVER_EXPOSE_");
	});
	it("individual projectors strip every non-metadata key without serializing the raw source", () => {
		expect(projectMembershipSessionEntry({ type: "message", message: { content: "NEVER_EXPOSE_" } })).toBeNull();
		expect(
			projectMembershipRegistryEvent({
				v: 1,
				seq: 1,
				op: "project.change",
				ts: T,
				id: "alpha",
				changes: { initiative: null, goal: "NEVER_EXPOSE_" },
			}),
		).toEqual({ v: 1, seq: 1, op: "project.change", ts: T, id: "alpha", changes: { initiative: null } });
		expect(
			Object.keys(projectMembershipConversation({ ...ledger("c", null, null), content: "NEVER_EXPOSE_" })),
		).toEqual([
			"v",
			"conversationId",
			"sessionId",
			"sessionFile",
			"persist",
			"origin",
			"parentConversationId",
			"at",
			"occurredAt",
		]);
		expect(
			projectMembershipDelegate({
				runId: "r",
				parentFile: Q,
				file: "/synthetic/a.jsonl",
				ts: T,
				result: "NEVER_EXPOSE_",
			}),
		).toEqual({ runId: "r", parentFile: Q, file: "/synthetic/a.jsonl", ts: T });
	});
	it.each(["missing", "unreadable", "partial", "unsupported"] as const)(
		"reports %s source evidence explicitly and refuses to turn the gap into a verified call link",
		(status) => {
			const sources = fixture();
			sources.delegates = page([], status);
			const result = map(sources);
			expect(gapCodes(result)).toContain(status);
			expect(result.memberships.some((m) => m.file === "/synthetic/delegate.jsonl")).toBe(false);
			expect(taskMembershipAt(result, "/synthetic/task.jsonl", time(T + 999999), "chat")).toBeNull();
			expect(
				membershipSourceBatches(result, CONTEXT).every((b) => b.status === "partial" && b.reason === "reported-gap"),
			).toBe(true);
		},
	);
	it("a missing original add is a gap, never substituted from assigned time or the registry task index", () => {
		const sources = fixture();
		own(sources, Q).records = own(sources, Q).records.filter((r) => data(r)?.op !== "add");
		const result = map(sources);
		expect(gapCodes(result)).toContain("missing-add");
		expect(result.memberships).toEqual([]);
		expect(result.parentHistory).toEqual([]);
	});
	it("keeps the same task number in different queues/original births distinct", () => {
		const sources = minimal();
		const other = header("/synthetic/other-queue.jsonl", "other-q");
		other.records = [...other.records, op("add", 1, T + 5000, { standalone: true })];
		sources.sessions = [...sources.sessions, other];
		expect(
			map(sources)
				.parentHistory.map(({ queue, task, addedAt }) => ({ queue, task, addedAt }))
				.sort((a, b) => a.queue.localeCompare(b.queue)),
		).toEqual([
			{ queue: "/synthetic/other-queue.jsonl", task: 1, addedAt: time(T + 5000) },
			{ queue: Q, task: 1, addedAt: time(T) },
		]);
	});
	it("represents explicit reassignment as half-open file intervals and leaves a fork on its original task", () => {
		const sources = minimal();
		const a = own(sources, "/synthetic/a.jsonl");
		own(sources, Q).records = [
			...own(sources, Q).records,
			op("add", 2, T + 5000, { standalone: true }),
			op("start", 2, T + 5500, { lane: true }),
			op("chat", 2, T + 6000, { file: a.file }),
		];
		sources.sessions = [...sources.sessions, header("/synthetic/fork.jsonl", "fork", T + 4000, a.file)];
		const result = map(sources);
		expect(result.memberships.filter((m) => m.file === a.file).map((m) => [m.task, m.from, m.until])).toEqual([
			[1, time(T + 2000), time(T + 6000)],
			[2, time(T + 6000), null],
		]);
		expect(taskMembershipAt(result, a.file, time(T + 5999), "chat")?.task).toBe(1);
		expect(taskMembershipAt(result, a.file, time(T + 6000), "chat")?.task).toBe(2);
		expect(taskMembershipAt(result, "/synthetic/fork.jsonl", time(T + 7000), "chat")?.task).toBe(1);
	});
	it("does not manufacture a new queue from a same-ID copy when its original file is explicitly named", () => {
		const sources = minimal();
		const copy = structuredClone(own(sources, Q));
		copy.file = "/synthetic/queue-copy.jsonl";
		sources.sessions = [...sources.sessions, copy];
		const result = map(sources);
		expect(result.gaps).toEqual([]);
		expect(result.parentHistory.map((m) => m.queue)).toEqual([Q]);
	});
	it("does not choose an original queue among ambiguous same-ID copies by filename or enumeration", () => {
		const sources = minimal();
		sources.sessions = sources.sessions.filter((s) => s.file === Q);
		own(sources, Q).records = own(sources, Q).records.filter((r) => !["start", "chat"].includes(String(data(r)?.op)));
		const copy = structuredClone(own(sources, Q));
		copy.file = "/synthetic/copy.jsonl";
		sources.sessions = [...sources.sessions, copy];
		expect(map(sources).parentHistory).toEqual([]);
		expect(gapCodes(map(sources))).toContain("conflicting-file");
	});
	it("a same-session resume cannot conceal conflicting direct bindings", () => {
		const sources = minimal();
		own(sources, Q).records = [
			...own(sources, Q).records.slice(0, 2),
			op("add", 2, T, { standalone: true }),
			...own(sources, Q).records.slice(2),
		];
		const copy = header("/synthetic/other.jsonl", "a", T + 1000);
		copy.records = [...copy.records, op("assigned", 2, T + 2000, { from: { file: Q } })];
		sources.sessions = [...sources.sessions, copy];
		const result = map(sources);
		expect(result.memberships).toEqual([]);
		expect(gapCodes(result)).toContain("conflicting-membership");
	});
	it("missing headers, files and parent endpoints remain explicit gaps", () => {
		const sources = minimal();
		sources.sessions = [
			...sources.sessions,
			{ file: "/synthetic/no-header.jsonl", ...page([]) },
			header("/synthetic/orphan.jsonl", "orphan", T, "/synthetic/missing.jsonl"),
		];
		own(sources, Q).records = [
			...own(sources, Q).records,
			op("add", 2, T + 3000, { standalone: true }),
			op("start", 2, T + 4000, { lane: true }),
			op("chat", 2, T + 5000, { file: "/synthetic/absent.jsonl" }),
		];
		expect(new Set(gapCodes(map(sources)))).toEqual(new Set(["missing-header", "missing-parent", "missing-session"]));
	});
	it("cycles are explicit, fail closed and do not depend on enumeration", () => {
		const sources = minimal();
		sources.sessions = [
			...sources.sessions,
			header("/synthetic/x.jsonl", "x", T + 5000, "/synthetic/y.jsonl"),
			header("/synthetic/y.jsonl", "y", T + 5000, "/synthetic/x.jsonl"),
		];
		const result = map(sources);
		expect(gapCodes(result).filter((c) => c === "parent-cycle")).toHaveLength(2);
		expect(result.memberships.some((m) => ["x", "y"].includes(m.sessionId))).toBe(false);
		sources.sessions = [...sources.sessions].reverse();
		expect(map(sources)).toEqual(result);
	});
	it("does not fill missing registry history from the latest project link", () => {
		const sources = fixture();
		const events = [...sources.registry.records];
		events.splice(5, 1); // missing seq 6: later seq 7 cannot be applied
		sources.registry.records = events;
		const result = map(sources);
		expect(gapCodes(result)).toContain("registry-sequence");
		expect(result.parentHistory.some((m) => m.initiative === "new")).toBe(false);
	});
	it("a project attached only after task birth is not retroactive", () => {
		const sources = minimal();
		data(own(sources, Q).records[1])!.project = "late-project";
		sources.registry = page([
			{ v: 1, seq: 1, op: "initiative.create", id: "later", ts: T + 3000 },
			{ v: 1, seq: 2, op: "project.create", id: "late-project", initiative: "later", ts: T + 4000 },
		]);
		const result = map(sources);
		expect(result.parentHistory.map((m) => [m.effectiveAt, m.project, m.initiative])).toEqual([
			[time(T), "late-project", null],
			[time(T + 4000), "late-project", "later"],
		]);
		expect(gapCodes(result)).toContain("missing-parent");
	});
	it("parent replacement, explicit clearing and direct initiative history follow replay", () => {
		const sources = minimal();
		own(sources, Q).records = [
			...own(sources, Q).records,
			op("update", 1, T + 3000, { initiative: "direct" }),
			op("update", 1, T + 4000, { initiative: "" }),
			op("update", 1, T + 5000, { standalone: true }),
		];
		expect(map(sources).parentHistory.map((m) => [m.effectiveAt, m.project, m.initiative])).toEqual([
			[time(T), null, null],
			[time(T + 3000), null, "direct"],
			[time(T + 4000), null, null],
		]);
	});
	it("in-chat tasks without a recorded separate chat are a gap, not permission to assign a home chat", () => {
		const sources = minimal();
		own(sources, Q).records = own(sources, Q)
			.records.map((r) => (data(r)?.op === "start" ? op("start", 1, T + 1000) : r))
			.filter((r) => data(r)?.op !== "chat");
		sources.sessions = sources.sessions.filter((s) => s.file === Q);
		const result = map(sources);
		expect(gapCodes(result)).toContain("in-chat-task");
		expect(result.memberships).toEqual([]);
	});
	it("reads #306's exact ledger field names and uses the parent's task at the observed occurrence time", () => {
		const sources = minimal();
		const helper = header("/synthetic/h.jsonl", "h", T + 3000);
		sources.sessions = [...sources.sessions, helper];
		const a = own(sources, "/synthetic/a.jsonl");
		own(sources, Q).records = [
			...own(sources, Q).records,
			op("add", 2, T + 5000, { standalone: true }),
			op("start", 2, T + 5500, { lane: true }),
			op("chat", 2, T + 6000, { file: a.file }),
		];
		sources.conversations = page([
			ledger("p", a.file, "a"),
			ledger("h", helper.file, "h", "helper", "p", T + 4000),
			ledger("h", helper.file, "h", "helper", "p", T + 7000),
		]);
		const result = map(sources);
		expect(result.gaps).toEqual([]);
		expect(result.memberships.filter((m) => m.file === helper.file).map((m) => [m.task, m.from, m.until])).toEqual([
			[1, time(T + 4000), time(T + 7000)],
			[2, time(T + 7000), null],
		]);
		expect(taskMembershipAt(result, helper.file, time(T + 6999), "helper")?.task).toBe(1);
	});
	it("a later conversation/file witness is never backfilled into an earlier helper observation", () => {
		const sources = minimal();
		const helper = header("/synthetic/h.jsonl", "h", T + 3000);
		sources.sessions = [...sources.sessions, helper];
		sources.conversations = page([
			ledger("p", "/synthetic/a.jsonl", "a", "chat", null, T + 5000),
			ledger("h", helper.file, "h", "helper", "p", T + 4000),
		]);
		const result = map(sources);
		expect(gapCodes(result)).toContain("missing-parent");
		expect(result.memberships.some((m) => m.file === helper.file)).toBe(false);
	});
	it("origin app is always outside tasks even when it supplies an apparent parent and task file", () => {
		const sources = fixture();
		sources.conversations.records = [
			...sources.conversations.records,
			ledger("overhead", "/synthetic/task.jsonl", "task-7", "app", "parent-conv", T + 500000),
		];
		const result = map(sources);
		expect(result).toEqual(expected());
		expect(taskMembershipAt(result, "/synthetic/task.jsonl", time(T + 999999), "app")).toBeNull();
	});
	it("does not recover a delegate's runId or parent from human-readable transcript prose", () => {
		const sources = fixture();
		sources.delegates = page([], "unsupported");
		const task = own(sources, "/synthetic/task.jsonl");
		task.records = [
			...task.records,
			{ type: "message", message: { content: "runId acp-run-7 /synthetic/delegate.jsonl Task 7 NEVER_EXPOSE_" } },
		];
		expect(map(sources).memberships.some((m) => m.sessionId === "delegate-7")).toBe(false);
	});
	it.each(["bytes", "records", "sessions", "clock"] as const)("fails closed on the collector's %s budget", (which) => {
		const sources = minimal();
		if (which === "bytes") sources.registry.bytesRead = COLLECTOR_LIMITS.batchBytes + 1;
		if (which === "records")
			sources.registry.records = Array.from({ length: COLLECTOR_LIMITS.batchRows + 1 }, () => ({}));
		if (which === "sessions")
			sources.sessions = Array.from({ length: COLLECTOR_LIMITS.sources + 1 }, (_, i) =>
				header(`/synthetic/s${i}.jsonl`, `s${i}`),
			);
		let ticks = 0;
		const result =
			which === "clock" ? mapUsageMembership(sources, () => ticks++ * (COLLECTOR_LIMITS.workMs + 1)) : map(sources);
		expect(result.memberships).toEqual([]);
		expect(result.parentHistory).toEqual([]);
		expect(gapCodes(result)).toContain(
			which === "bytes" ? "byte-limit" : which === "clock" ? "work-limit" : "record-limit",
		);
	});
	it("fails closed on allowed-field getters, oversized identifiers, conflicting file records and regressing event times", () => {
		const accessor = minimal();
		Object.defineProperty(own(accessor, Q).records[0], "id", {
			get() {
				throw new Error("raw-exception-NEVER_EXPOSE_");
			},
		});
		const long = minimal();
		(own(long, Q).records[0] as Rec).id = "a".repeat(257);
		const conflict = minimal();
		const duplicate = structuredClone(own(conflict, Q));
		(duplicate.records[0] as Rec).id = "conflict";
		conflict.sessions = [...conflict.sessions, duplicate];
		const backwards = minimal();
		own(backwards, Q).records = [...own(backwards, Q).records, op("update", 1, T - 1, { initiative: "wrong" })];
		for (const [sources, code] of [
			[accessor, "invalid-metadata"],
			[long, "invalid-metadata"],
			[conflict, "conflicting-file"],
			[backwards, "event-time-order"],
		] as const) {
			const result = map(sources);
			expect(gapCodes(result)).toContain(code);
			expect(JSON.stringify(result)).not.toContain("NEVER_EXPOSE_");
		}
	});
	it("also caps projected bytes when a source understates its native byte count", () => {
		const sources = minimal();
		sources.sessions = Array.from({ length: 5 }, (_, i) => {
			const s = header(`/synthetic/large-${i}.jsonl`, `large-${i}`);
			s.bytesRead = 0;
			s.records = [
				...s.records,
				...Array.from({ length: 255 }, () => op("chat", 1, T, { file: `/synthetic/${"x".repeat(230)}.jsonl` })),
			];
			return s;
		});
		const result = map(sources);
		expect(result.memberships).toEqual([]);
		expect(gapCodes(result)).toContain("byte-limit");
	});
	it("a replay-ignored duplicate chat cannot steal a file back from its newer recorded task", () => {
		const sources = minimal();
		own(sources, Q).records = [
			...own(sources, Q).records,
			op("add", 2, T + 3000, { standalone: true }),
			op("start", 2, T + 4000, { lane: true }),
			op("chat", 2, T + 5000, { file: "/synthetic/a.jsonl" }),
			op("chat", 1, T + 6000, { file: "/synthetic/a.jsonl" }),
		];
		const result = map(sources);
		expect(result.gaps).toEqual([]);
		expect(taskMembershipAt(result, "/synthetic/a.jsonl", time(T + 7000), "chat")?.task).toBe(2);
	});
	it("a project can explicitly leave an initiative without erasing its earlier link", () => {
		const sources = fixture();
		sources.registry.records = [
			...sources.registry.records,
			{ v: 1, seq: 9, op: "project.change", id: "beta", changes: { initiative: null }, ts: 1792195200000 },
		];
		const result = map(sources);
		expect(result.gaps).toEqual([]);
		expect(result.parentHistory.at(-2)).toEqual({
			queue: Q,
			task: 7,
			addedAt: time(T),
			project: "beta",
			initiative: null,
			effectiveAt: "2026-10-17T00:00:00.000Z",
		});
		expect(taskMembershipAt(result, "/synthetic/task.jsonl", "2026-10-16T12:00:00.000Z", "chat")?.initiative).toBe(
			"old",
		);
	});
	it("pins the five collector policy limits without depending on its inert module", () => {
		expect(MEMBERSHIP_LIMITS).toEqual({
			batchBytes: COLLECTOR_LIMITS.batchBytes,
			batchRows: COLLECTOR_LIMITS.batchRows,
			workMs: COLLECTOR_LIMITS.workMs,
			historyRows: COLLECTOR_LIMITS.historyRows,
			sources: COLLECTOR_LIMITS.sources,
		});
	});
	it("feeds every fixed batch to the unchanged collector without granting usage coverage or copying file-map fields", async () => {
		const batches: SourceBatch[] = membershipSourceBatches(map(), CONTEXT);
		const c = await collector();
		expect(batches).toHaveLength(1);
		for (const b of batches) {
			expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThanOrEqual(COLLECTOR_LIMITS.batchBytes);
			expect(b.status).toBe("partial");
			expect(b.rows.memberships).toEqual(expected().parentHistory);
			expect((await c.collect(b.stream, JSON.stringify(b), CONTEXT.observedAt)).status).toBe("committed");
		}
	});
	it("chunks 300 canonical rows into collector-sized batches using injected consecutive cursors", async () => {
		const result = map(minimal());
		const source = result.parentHistory[0];
		result.parentHistory = Array.from({ length: 300 }, (_, i): TaskMembership => ({ ...source, task: i + 1 }));
		const batches = membershipSourceBatches(result, { ...CONTEXT, cursorTokens: ["fixture:c1", "fixture:c2"] });
		expect(batches.map((b) => b.rows.memberships.length)).toEqual([256, 44]);
		expect(batches[1].fromCursor).toEqual(batches[0].toCursor);
		const c = await collector();
		for (const b of batches)
			expect((await c.collect(b.stream, JSON.stringify(b), CONTEXT.observedAt)).status).toBe("committed");
		expect(membershipSourceBatches(result, CONTEXT)).toEqual([]); // no invented second cursor token
	});
	it("has no native path, filesystem call, timer, collector dependency or model invocation", () => {
		const server = new URL("../../server/", import.meta.url);
		const source = readFileSync(new URL("usage-accounting-membership.ts", server), "utf8");
		expect(source).not.toMatch(/usage-accounting-collector/);
		expect(source).not.toMatch(
			/node:fs|readFile|writeFile|setInterval|setTimeout|homedir\(|\.pi-web-ui\/|["']\/[^"']*usage-ledger\//,
		);
	});
});

// H-WIRE-0: keep membership pure and permit only the worker consumers owned in W2-W6.
describe("usage-accounting-membership reviewed worker importers", () => {
	const project = fileURLToPath(new URL("../../", import.meta.url));
	const server = join(project, "server");
	const membership = join(server, "usage-accounting-membership.ts");
	const allowed = [
		"usage-accounting-ledger-source.ts", // W2: project conversation/helper metadata for #305.
		"usage-accounting-pi-source.ts", // W3: bounded #304/#305 source adapter.
		"usage-accounting-funding.ts", // W4: independent event-time membership evidence.
		"usage-accounting-snapshot.ts", // W5: worker-only subject builder, never the cache.
		"usage-accounting-worker.ts", // W6: collection orchestration.
	];
	type ImportHost = { readFile(file: string): string | undefined };
	type ImportOptions = { paths?: Record<string, string[]>; baseUrl?: string };
	const config = JSON.parse(readFileSync(join(project, "tsconfig.server.json"), "utf8")) as {
		extends?: unknown;
		compilerOptions: ImportOptions;
	};
	if (config.extends) throw new Error("import guard must resolve extended server config before accepting it");
	const syntaxDir = join(project, ".membership-import-guard-memory");
	const syntaxFs = createVirtualFileSystem({});
	const parser = new API({
		cwd: project,
		fs: { ...syntaxFs, readFile: (file) => syntaxFs.readFile!(file) ?? null },
	});
	let parserProject: string | undefined;
	let syntaxBatch = 0;
	afterAll(() => parser.close());
	const referenceCache = new Map<string, string[]>();
	function referenceKey(file: string, text: string): string {
		return `${[".tsx", ".jsx"].includes(extname(file)) ? ".tsx" : ".ts"}\0${text}`;
	}
	function cacheReferences(files: string[], host: ImportHost): void {
		const pending = new Map<string, { file: string; text: string }>();
		for (const file of files) {
			const text = host.readFile(file);
			if (text === undefined) throw new Error(`missing graph module: ${file}`);
			const key = referenceKey(file, text);
			if (!referenceCache.has(key)) pending.set(key, { file, text });
		}
		if (!pending.size) return;
		// Immutable file AND project identities avoid TS 7 retaining the first AST at a reused path.
		// Batch a real-tree scan into one snapshot instead of rebuilding a project for every module.
		const syntaxConfig = join(syntaxDir, String(syntaxBatch++), "tsconfig.json");
		const inputs = [...pending].map(([key, { file, text }], index) => {
			const input = join(dirname(syntaxConfig), `${index}${[".tsx", ".jsx"].includes(extname(file)) ? ".tsx" : ".ts"}`);
			syntaxFs.writeFile!(input, text);
			return { key, file, text, input };
		});
		syntaxFs.writeFile!(
			syntaxConfig,
			JSON.stringify({
				compilerOptions: { noResolve: true, noLib: true, types: [], noEmit: true, jsx: "preserve" },
				files: inputs.map(({ input }) => input),
			}),
		);
		const snapshot = parser.updateSnapshot({
			openProjects: [syntaxConfig],
			...(parserProject ? { closeProjects: [parserProject] } : {}),
		});
		parserProject = syntaxConfig;
		try {
			const program = snapshot.getProject(syntaxConfig)?.program;
			if (!program) throw new Error(`missing virtual project: ${syntaxConfig}`);
			for (const { key, file, text, input } of inputs) {
				const source = program.getSourceFile(input);
				if (!source) throw new Error(`missing virtual AST: ${file}`);
				if (source.text !== text) throw new Error(`stale virtual AST: ${file}`);
				referenceCache.set(key, readReferences(source));
			}
		} finally {
			snapshot.dispose();
		}
	}
	function references(file: string, text: string): string[] {
		const key = referenceKey(file, text);
		if (!referenceCache.has(key)) cacheReferences([file], { readFile: () => text });
		return referenceCache.get(key)!;
	}
	function readReferences(source: ts.SourceFile): string[] {
		const result: string[] = [];
		function visit(node: ts.Node): void {
			let specifier: ts.Node | undefined;
			if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
			else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
				specifier = node.moduleReference.expression;
			else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
			else if (
				ts.isCallExpression(node) &&
				(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
					(ts.isIdentifier(node.expression) && node.expression.text === "require") ||
					(ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "require"))
			)
				specifier = node.arguments[0];
			if (specifier && ts.isStringLiteralLikeNode(specifier)) result.push(specifier.text);
			node.forEachChild(visit);
		}
		visit(source);
		return result;
	}
	function unreviewed(files: string[], host: ImportHost, options = config.compilerOptions): string[] {
		cacheReferences(files, host);
		function pointsToMembership(file: string, specifier: string): boolean {
			let candidates: string[] = [];
			if (specifier.startsWith(".") || isAbsolute(specifier)) candidates = [resolve(dirname(file), specifier)];
			else {
				const aliases = Object.entries(options.paths ?? {}).sort(
					([a], [b]) => Number(b === specifier) - Number(a === specifier) || b.indexOf("*") - a.indexOf("*"),
				);
				for (const [alias, paths] of aliases) {
					const star = alias.indexOf("*");
					const matches =
						star < 0
							? alias === specifier
							: specifier.startsWith(alias.slice(0, star)) && specifier.endsWith(alias.slice(star + 1));
					if (!matches) continue;
					const match = star < 0 ? "" : specifier.slice(star, specifier.length - alias.length + star + 1);
					candidates = paths.map((path) => resolve(project, options.baseUrl ?? ".", path.replace("*", match)));
					break;
				}
			}
			return candidates.some(
				(path) =>
					path === membership ||
					path + ".ts" === membership ||
					(extname(path) === ".js" && path.slice(0, -3) + ".ts" === membership),
			);
		}
		return files
			.filter(
				(file) =>
					file !== membership &&
					!allowed.some((name) => file === join(server, name)) &&
					references(file, host.readFile(file)!).some((specifier) => pointsToMembership(file, specifier)),
			)
			.map((file) => relative(server, file))
			.sort();
	}
	function memoryHost(modules: Record<string, string>): ImportHost {
		const files = new Map(Object.entries(modules).map(([name, text]) => [join(server, name), text]));
		return { readFile: (file) => files.get(resolve(file)) };
	}
	it("keeps successive virtual texts and empty sources distinct, including cache hits", () => {
		for (const name of ["fresh-control.ts", "fresh-control.tsx"]) {
			const file = join(server, name);
			const first = "import './fresh-runtime-control.js';";
			const second = "export type { Value } from './fresh-type-control.js';";
			expect(references(file, first)).toEqual(["./fresh-runtime-control.js"]);
			expect(references(file, second)).toEqual(["./fresh-type-control.js"]);
			expect(references(file, "")).toEqual([]);
			expect(references(file, first)).toEqual(["./fresh-runtime-control.js"]);
		}
	});
	it("admits only exact W2-W6 membership importers throughout the production server tree", () => {
		function serverFiles(dir = server): string[] {
			return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
				const file = join(dir, entry.name);
				return entry.isDirectory()
					? serverFiles(file)
					: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"].includes(extname(file))
						? [file]
						: [];
			});
		}
		const files = serverFiles();
		expect(files).toContain(membership);
		expect(
			unreviewed(files, { readFile: (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined) }),
		).toEqual([]);
		// Native full-tree parsing competes with the full suite; this is harness startup, not a runtime budget.
	}, 15_000);
	it("permits each reviewed edge and rejects main-thread, unreviewed and nested-lookalike importers", () => {
		const forms = [
			(specifier: string) => `import { value } from '${specifier}';`,
			(specifier: string) => `import '${specifier}';`,
			(specifier: string) => `export { value } from '${specifier}';`,
			(specifier: string) => `export * from '${specifier}';`,
			(specifier: string) => `void import('${specifier}');`,
			(specifier: string) => `void require('${specifier}');`,
			(specifier: string) => `void module.require('${specifier}');`,
			(specifier: string) => `import value = require('${specifier}');`,
			(specifier: string) => `void import(\`${specifier}\`);`,
			(specifier: string) => `import type { Value } from '${specifier}';`,
			(specifier: string) => `type Value = import('${specifier}').Value;`,
		];
		for (const form of forms) {
			const modules: Record<string, string> = { "usage-accounting-membership.ts": "export const value = 1;" };
			for (const name of allowed) modules[name] = form("./usage-accounting-membership.js");
			const rejected = [
				"index.ts",
				"roles-overview.ts",
				"protocol.ts",
				"usage-accounting-meter-cache.ts",
				"unreviewed.ts",
			];
			for (const name of rejected) modules[name] = form("./usage-accounting-membership.js");
			modules["nested/usage-accounting-worker.ts"] = form("../usage-accounting-membership.js");
			const host = memoryHost(modules);
			expect(
				unreviewed(
					allowed.map((name) => join(server, name)),
					host,
				),
			).toEqual([]);
			expect(
				unreviewed(
					Object.keys(modules).map((name) => join(server, name)),
					host,
				),
			).toEqual([...rejected, "nested/usage-accounting-worker.ts"].sort());
		}
	});
	it("resolves configured aliases and ignores comments and string literals that are not imports", () => {
		const host = memoryHost({
			"usage-accounting-membership.ts": "export const value = 1;",
			"unreviewed.ts": "export * from '@meter/usage-accounting-membership.js';",
			"safe.ts":
				"// import './usage-accounting-membership.js'\nconst text = \"require('./usage-accounting-membership.js')\";",
		});
		const options = { ...config.compilerOptions, paths: { "@meter/*": [join(server, "*")] } };
		expect(unreviewed([join(server, "unreviewed.ts"), join(server, "safe.ts")], host, options)).toEqual([
			"unreviewed.ts",
		]);
	});
});
