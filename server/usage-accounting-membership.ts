/** Inert, source-projected metadata only. No filesystem, source discovery, runtime importer or authority. */
import { taskQueueAll, type TaskQueueEntryLike } from "./task-queue.js";
import { taskId, type AccountingInput, type TaskMembership } from "./usage-accounting-contract.js";

/** Pinned #300-compatible policy, verified in unit tests without importing its inert module. */
export const MEMBERSHIP_LIMITS = Object.freeze({
	batchBytes: 262_144,
	batchRows: 256,
	workMs: 100,
	historyRows: 10_000,
	sources: 64,
});
/** Structural output only: the unchanged collector checks assignability in tests, not at runtime. */
export interface MembershipSourceBatch {
	v: "usage-source-batch/1";
	stream: string;
	incarnation: string;
	adapterRef: string;
	fromCursor: { ordinal: number; token: string } | null;
	toCursor: NonNullable<MembershipSourceBatch["fromCursor"]>;
	from: string;
	through: string;
	observedAt: string;
	status: "partial";
	reason: "reported-gap";
	rows: Pick<AccountingInput, "facts" | "allocations" | "aliases" | "roots" | "policies" | "memberships" | "snapshots">;
}

export type MetadataStatus = "complete" | "partial" | "missing" | "unreadable" | "unsupported";
/** Inject at the source, after bounding the underlying read, not after loading a whole private file.
 * bytesRead includes skipped payload bytes. It is source evidence, not independently authenticated here. */
export interface MembershipPage {
	status: MetadataStatus;
	bytesRead: number;
	records: readonly unknown[];
}
export interface SessionMembershipPage extends MembershipPage {
	file: string;
}
export interface MembershipSources {
	sessions: readonly SessionMembershipPage[];
	registry: MembershipPage;
	conversations: MembershipPage;
	/** Explicit ID/file/parent witnesses only. Current ACP transcript producer is unsupported. */
	delegates: MembershipPage;
}
export type TaskKey = Pick<TaskMembership, "queue" | "task" | "addedAt">;
export interface ChatMembership extends TaskKey {
	file: string;
	sessionId: string;
	from: string;
	/** Half-open interval; null means no later recorded reassignment, not a completeness claim. */
	until: string | null;
}
export type MembershipGapCode =
	| "missing"
	| "unreadable"
	| "unsupported"
	| "partial"
	| "invalid-metadata"
	| "byte-limit"
	| "record-limit"
	| "work-limit"
	| "missing-header"
	| "conflicting-file"
	| "missing-add"
	| "missing-session"
	| "missing-parent"
	| "parent-cycle"
	| "conflicting-membership"
	| "conflicting-parent"
	| "registry-sequence"
	| "event-time-order"
	| "in-chat-task";
export interface MembershipGap {
	code: MembershipGapCode;
	file: string | null;
	task: number | null;
}
export interface MembershipMap {
	v: "usage-membership-map/1";
	/** File/session association, separate from #293's canonical parent snapshots. */
	memberships: ChatMembership[];
	parentHistory: TaskMembership[];
	notInAnyTask: { file: string; sessionId: string }[];
	gaps: MembershipGap[];
}

type Rec = Record<string, unknown>;
type Parent = { project: string } | { initiative: string } | { standalone: true };
type Header = { id: string; timestamp: string; parentSession?: string };
type Session = { file: string; header: Header; entries: TaskQueueEntryLike[] };
type Task = { key: TaskKey; parents: { at: string; parent: Parent | undefined }[] };
type Edge = { child: string; parent: string; at: string };
type Anchor = { file: string; key: TaskKey; at: string };
const REF = /^[A-Za-z0-9_./:@+-]{1,256}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATUSES = new Set(["complete", "partial", "missing", "unreadable", "unsupported"]);
const QUEUE_FIELDS = ["v", "op", "id", "ts", "queueId", "file", "project", "initiative", "standalone", "lane"];
const REGISTRY_FIELDS = ["v", "seq", "op", "ts", "id", "initiative", "queue", "task", "added"];
const QUEUE_OPS = new Set([
	"add",
	"update",
	"start",
	"profile",
	"task_profile",
	"prepared",
	"blocked",
	"chat",
	"requeue",
	"lanes",
	"assigned",
	"stuck",
	"ask",
	"route",
	"woke",
	"long_turn",
	"resume",
	"done",
	"remove",
	"drop",
	"closed",
	"wait",
	"wait_over",
	"block",
	"poke",
	"remind",
	"lead",
	"after_over",
	"move",
	"autonomy",
	"run",
	"clear",
	"pause",
	"hold",
	"release",
	"back",
	"kept",
	"relay",
	"wake_due",
	"wake_sent",
	"held_note",
]);
class Stop extends Error {
	constructor(readonly code: MembershipGapCode) {
		super(code);
	}
}
/** Never invoke a getter, traverse a payload, enumerate a raw record, stringify it, or copy its prototype. */
function field(raw: unknown, key: string): unknown {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const d = Object.getOwnPropertyDescriptor(raw, key);
	if (!d) return undefined;
	if (!("value" in d)) throw new Stop("invalid-metadata");
	return d.value;
}
function pick(raw: unknown, keys: readonly string[]): Rec {
	const out: Rec = {};
	for (const key of keys) {
		const value = field(raw, key);
		if (value === undefined) continue;
		if (!["string", "number", "boolean"].includes(typeof value) && value !== null) throw new Stop("invalid-metadata");
		if (typeof value === "string" && value.length > 256) throw new Stop("invalid-metadata");
		out[key] = value;
	}
	return out;
}
function reference(value: unknown): value is string {
	return typeof value === "string" && REF.test(value);
}
function slug(value: unknown): value is string {
	return typeof value === "string" && value.length <= 60 && SLUG.test(value);
}
function iso(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 253402300799999)
		return new Date(value).toISOString();
	if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return undefined;
	return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : undefined;
}
function id(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
function parentOf(value: unknown): Parent | undefined {
	const project = field(value, "project");
	if (typeof project === "string" && slug(project.trim())) return { project: project.trim() };
	const initiative = field(value, "initiative");
	if (typeof initiative === "string" && slug(initiative.trim())) return { initiative: initiative.trim() };
	if (field(value, "standalone") === true) return { standalone: true };
	return undefined;
}

/** Source-side allowlist: header + queue IDs/times/parents only. Messages/tool results are not opened. */
export function projectMembershipSessionEntry(raw: unknown): TaskQueueEntryLike | null {
	const type = field(raw, "type");
	if (type === "session") return { type, ...pick(raw, ["id", "timestamp", "parentSession"]) };
	if (type !== "custom" || field(raw, "customType") !== "queue") return null;
	const source = field(raw, "data");
	const data = pick(source, QUEUE_FIELDS);
	const from = field(source, "from");
	if (from !== undefined) data.from = pick(from, ["file"]);
	return { type, customType: "queue", data };
}
/** Mirrors only work-store.ts's identity/sequence/time/parent fields, never its prose or latest-state index. */
export function projectMembershipRegistryEvent(raw: unknown): Rec {
	const out = pick(raw, REGISTRY_FIELDS);
	const changes = field(raw, "changes");
	if (changes !== undefined) out.changes = pick(changes, ["initiative"]);
	return out;
}
/** #306 ledger field names, not an adapter/import of #306. Both endpoints need time-valid file witnesses. */
export function projectMembershipConversation(raw: unknown): Rec {
	return pick(raw, [
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
}
/** Prospective source-owned witness. Not extracted from ACP prose, tool arguments, or tool results. */
export function projectMembershipDelegate(raw: unknown): Rec {
	return pick(raw, ["runId", "parentFile", "file", "ts"]);
}

/** Pure bounded replay. Missing evidence remains a gap; nothing here authenticates a live source. */
export function mapUsageMembership(
	sources: MembershipSources,
	clock: () => number = () => performance.now(),
): MembershipMap {
	const result: MembershipMap = {
		v: "usage-membership-map/1",
		memberships: [],
		parentHistory: [],
		notInAnyTask: [],
		gaps: [],
	};
	const gap = (code: MembershipGapCode, file: string | null = null, task: number | null = null) => {
		if (!result.gaps.some((g) => g.code === code && g.file === file && g.task === task))
			result.gaps.push({ code, file, task });
	};
	let bytes = 0;
	let records = 0;
	const start = clock();
	const tick = () => {
		const elapsed = clock() - start;
		if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > MEMBERSHIP_LIMITS.workMs) throw new Stop("work-limit");
	};
	function page<T>(raw: MembershipPage, project: (record: unknown) => T, file: string | null): T[] {
		tick();
		if (
			!STATUSES.has(raw.status) ||
			!Number.isSafeInteger(raw.bytesRead) ||
			raw.bytesRead < 0 ||
			!Array.isArray(raw.records)
		)
			throw new Stop("invalid-metadata");
		bytes += raw.bytesRead;
		records += raw.records.length;
		if (bytes > MEMBERSHIP_LIMITS.batchBytes) throw new Stop("byte-limit");
		if (raw.records.length > MEMBERSHIP_LIMITS.batchRows || records > MEMBERSHIP_LIMITS.historyRows)
			throw new Stop("record-limit");
		if (raw.status !== "complete") gap(raw.status, file);
		if (raw.status !== "complete" && raw.status !== "partial") return [];
		return raw.records.map((record) => {
			tick();
			return project(record);
		});
	}
	try {
		if (!Array.isArray(sources.sessions) || sources.sessions.length > MEMBERSHIP_LIMITS.sources)
			throw new Stop("record-limit");
		const sessions = new Map<string, Session>();
		const badFiles = new Set<string>();
		for (const source of sources.sessions) {
			if (!reference(source.file)) throw new Stop("invalid-metadata");
			const entries = page(source, projectMembershipSessionEntry, source.file).filter(
				(e): e is TaskQueueEntryLike => e !== null,
			);
			const headers = entries.filter((e) => e.type === "session");
			const h = headers[0];
			const timestamp = iso(field(h, "timestamp"));
			const parentSession = field(h, "parentSession");
			if (
				headers.length !== 1 ||
				!reference(h?.id) ||
				!timestamp ||
				(parentSession !== undefined && !reference(parentSession))
			) {
				gap("missing-header", source.file);
				continue;
			}
			const session: Session = {
				file: source.file,
				header: { id: h.id, timestamp, ...(parentSession ? { parentSession: parentSession as string } : {}) },
				entries,
			};
			if (badFiles.has(source.file)) continue;
			const previous = sessions.get(source.file);
			if (previous && !same(previous, session)) {
				gap("conflicting-file", source.file);
				sessions.delete(source.file);
				badFiles.add(source.file);
			} else sessions.set(source.file, session);
		}
		const registry = page(sources.registry, projectMembershipRegistryEvent, null);
		const conversations = page(sources.conversations, projectMembershipConversation, null);
		const delegates = page(sources.delegates, projectMembershipDelegate, null);
		// Bound normalized metadata too, independently of the injected native byte count.
		if (
			Buffer.byteLength(JSON.stringify([[...sessions.values()], registry, conversations, delegates]), "utf8") >
			MEMBERSHIP_LIMITS.batchBytes
		)
			throw new Stop("byte-limit");

		const tasks = new Map<string, Task>();
		const byQueue = new Map<string, Map<number, Task>>();
		const anchors: Anchor[] = [];
		const edges: Edge[] = [];
		const namedQueues = new Set<string>();
		for (const s of sessions.values())
			for (const e of s.entries) {
				const op = e.data as Rec | undefined;
				const from = op?.op === "assigned" ? field(op.from, "file") : undefined;
				if (reference(from)) namedQueues.add(from);
			}
		for (const s of sessions.values()) {
			tick();
			const ops = s.entries.filter((e) => e.type === "custom").map((e) => e.data as Rec);
			// A fork/copy of a queue cannot mint another set of original adds.
			const assigned = ops.some((op) => op.v === 1 && op.op === "assigned");
			const foreign = ops.some((op) => typeof op.queueId === "string" && op.queueId !== s.header.id);
			if (assigned || s.header.parentSession || foreign) continue;
			if (ops.some((op) => op.op === "add")) {
				const copies = [...sessions.values()].filter((other) => other.header.id === s.header.id);
				if (copies.length > 1) {
					const named = copies.filter((other) => namedQueues.has(other.file));
					if (named.length !== 1) {
						gap("conflicting-file", s.file);
						continue;
					}
					if (named[0].file !== s.file) continue;
				}
			}
			const queue = new Map<number, Task>();
			byQueue.set(s.file, queue);
			const prefix: TaskQueueEntryLike[] = [{ type: "session", id: s.header.id }];
			const recordedChats = new Set<number>();
			let lastAt = s.header.timestamp;
			for (const op of ops) {
				tick();
				if (op.v !== 1 || !QUEUE_OPS.has(String(op.op))) {
					gap("invalid-metadata", s.file);
					continue;
				}
				const at = typeof op.ts === "number" ? iso(op.ts) : undefined;
				if (!at || at < lastAt) {
					gap("event-time-order", s.file);
					break;
				}
				lastAt = at;
				prefix.push({ type: "custom", customType: "queue", data: op });
				const replay = taskQueueAll(prefix);
				for (const current of replay.tasks) {
					let task = queue.get(current.id);
					if (!task) {
						const addedAt = iso(current.addedAt);
						if (!addedAt || !id(current.id)) {
							gap("missing-add", s.file, current.id);
							continue;
						}
						task = { key: { queue: s.file, task: current.id, addedAt }, parents: [] };
						queue.set(current.id, task);
						tasks.set(taskId(task.key), task);
					}
					const parent = parentOf(current.parent);
					if (!task.parents.length || !same(task.parents.at(-1)?.parent, parent)) task.parents.push({ at, parent });
					if (
						current.id === op.id &&
						op.op === "chat" &&
						current.chat?.file === op.file &&
						reference(op.file) &&
						!recordedChats.has(current.id)
					) {
						anchors.push({ file: op.file, key: task.key, at });
						recordedChats.add(current.id);
					}
					if (current.id === op.id && op.op === "start" && !current.lane && current.status === "working")
						gap("in-chat-task", s.file, current.id);
				}
			}
		}
		// Only original parent queues establish birth. Every assignment, including a re-run, reuses that key.
		for (const s of sessions.values()) {
			let firstAssigned: number | undefined;
			for (const e of s.entries) {
				tick();
				const op = e.data as Rec | undefined;
				if (!op || op.v !== 1 || op.op !== "assigned") continue;
				if (firstAssigned !== undefined) {
					if (firstAssigned !== op.id) gap("conflicting-membership", s.file);
					continue;
				}
				if (id(op.id)) firstAssigned = op.id;
				const queueFile = field(op.from, "file");
				const task = reference(queueFile) && id(op.id) ? byQueue.get(queueFile)?.get(op.id) : undefined;
				const at = typeof op.ts === "number" ? iso(op.ts) : undefined;
				if (!task) {
					gap("missing-add", s.file, id(op.id) ? op.id : null);
					continue;
				}
				// A native fork copies earlier entries but starts a new header/identity.
				if (at && at < s.header.timestamp && s.header.parentSession) continue;
				if (!at || at < task.key.addedAt || at < s.header.timestamp) {
					gap("event-time-order", s.file, task.key.task);
					continue;
				}
				anchors.push({ file: s.file, key: task.key, at });
			}
			if (s.header.parentSession) edges.push({ child: s.file, parent: s.header.parentSession, at: s.header.timestamp });
		}

		const projects = new Map<string, { at: string; initiative: string | null }[]>();
		const initiatives = new Set<string>();
		let seq = 0;
		let previousAt = "";
		for (const event of registry) {
			tick();
			if (event.v !== 1 || event.seq !== seq + 1) {
				gap("registry-sequence");
				break;
			}
			const at = iso(event.ts);
			if (!at || at < previousAt) {
				gap("event-time-order");
				break;
			}
			seq++;
			previousAt = at;
			if (event.op === "initiative.create") {
				if (!slug(event.id) || initiatives.has(event.id)) {
					gap("invalid-metadata");
					break;
				}
				initiatives.add(event.id);
			} else if (event.op === "project.create" || event.op === "project.change") {
				if (!slug(event.id)) {
					gap("invalid-metadata");
					break;
				}
				const history = projects.get(event.id);
				if ((event.op === "project.create") === Boolean(history)) {
					gap("conflicting-parent");
					break;
				}
				const initiative = event.op === "project.create" ? event.initiative : field(event.changes, "initiative");
				if (initiative === undefined && event.op === "project.change") continue;
				if (initiative !== null && (!slug(initiative) || !initiatives.has(initiative))) {
					gap("missing-parent");
					break;
				}
				const next = history ?? [];
				if (!next.length || next.at(-1)?.initiative !== initiative)
					next.push({ at, initiative: initiative as string | null });
				projects.set(event.id, next);
			} else if (event.op === "task.link") {
				const key =
					reference(event.queue) && id(event.task) && iso(event.added)
						? { queue: event.queue, task: event.task, addedAt: iso(event.added)! }
						: null;
				if (!key || !tasks.has(taskId(key)))
					gap("missing-add", reference(event.queue) ? event.queue : null, id(event.task) ? event.task : null);
			} else if (
				!new Set([
					"initiative.change",
					"initiative.met",
					"initiative.unmet",
					"initiative.wait",
					"initiative.resume",
					"project.met",
					"project.unmet",
					"project.wait",
					"project.resume",
					"task.state",
				]).has(String(event.op))
			) {
				gap("invalid-metadata");
				break;
			}
		}
		for (const task of tasks.values()) {
			const times = new Set(task.parents.map((p) => p.at));
			for (const p of task.parents)
				if (p.parent && "project" in p.parent)
					for (const change of projects.get(p.parent.project) ?? [])
						if (change.at >= task.key.addedAt) times.add(change.at);
			let previous: { project: string | null; initiative: string | null } | undefined;
			for (const at of [...times].sort()) {
				tick();
				const parent = task.parents.findLast((p) => p.at <= at)?.parent;
				const project = parent && "project" in parent ? parent.project : null;
				let initiative = parent && "initiative" in parent ? parent.initiative : null;
				if (project) {
					const history = projects.get(project)?.findLast((p) => p.at <= at);
					if (!history) gap("missing-parent", task.key.queue, task.key.task);
					else initiative = history.initiative;
				}
				const snapshot = { project, initiative };
				if (!previous || !same(previous, snapshot))
					result.parentHistory.push({ ...task.key, ...snapshot, effectiveAt: at });
				previous = snapshot;
			}
		}

		const convs = new Map<string, { record: Rec; at: string }[]>();
		const badConvs = new Set<string>();
		for (const conv of conversations) {
			tick();
			const at = iso(conv.occurredAt ?? conv.at);
			if (
				conv.v !== "usage-ledger/1" ||
				!reference(conv.conversationId) ||
				!at ||
				typeof conv.persist !== "boolean" ||
				!new Set(["chat", "helper", "app"]).has(String(conv.origin)) ||
				(conv.sessionFile !== null && !reference(conv.sessionFile)) ||
				(conv.sessionId !== null && !reference(conv.sessionId)) ||
				(conv.parentConversationId !== null && !reference(conv.parentConversationId))
			) {
				gap("invalid-metadata");
				continue;
			}
			// App overhead never supplies a parent/file witness, even if it happens to name a task file.
			if (conv.origin === "app") continue;
			if (badConvs.has(conv.conversationId)) continue;
			const history = convs.get(conv.conversationId) ?? [];
			if (
				history.some(
					(h) =>
						h.record.parentConversationId !== conv.parentConversationId ||
						h.record.origin !== conv.origin ||
						(h.at === at && (h.record.sessionFile !== conv.sessionFile || h.record.sessionId !== conv.sessionId)),
				)
			) {
				badConvs.add(conv.conversationId);
				convs.delete(conv.conversationId);
				gap("conflicting-parent", reference(conv.sessionFile) ? conv.sessionFile : null);
				continue;
			}
			history.push({ record: conv, at });
			convs.set(conv.conversationId, history);
		}
		for (const history of convs.values()) history.sort((a, b) => a.at.localeCompare(b.at));
		for (const history of convs.values())
			for (const { record: conv, at } of history) {
				if (conv.origin !== "helper" || conv.parentConversationId === null) continue;
				const file = reference(conv.sessionFile) ? conv.sessionFile : null;
				if (!file || !sessions.has(file) || sessions.get(file)!.header.id !== conv.sessionId) {
					gap("missing-session", file);
					continue;
				}
				const parent = convs.get(conv.parentConversationId as string)?.findLast((h) => h.at <= at)?.record;
				if (
					!parent ||
					!reference(parent.sessionFile) ||
					!sessions.has(parent.sessionFile) ||
					sessions.get(parent.sessionFile)!.header.id !== parent.sessionId
				) {
					gap("missing-parent", file);
					continue;
				}
				edges.push({ child: file, parent: parent.sessionFile, at });
			}
		const runs = new Map<string, Rec>();
		const badRuns = new Set<string>();
		for (const run of delegates) {
			if (!reference(run.runId) || !reference(run.file) || !reference(run.parentFile) || !iso(run.ts)) {
				gap("invalid-metadata");
				continue;
			}
			if (badRuns.has(run.runId)) continue;
			if (runs.has(run.runId) && !same(runs.get(run.runId), run)) {
				badRuns.add(run.runId);
				runs.delete(run.runId);
				gap("conflicting-membership", run.file);
				continue;
			}
			runs.set(run.runId, run);
		}
		for (const run of runs.values())
			edges.push({ child: run.file as string, parent: run.parentFile as string, at: iso(run.ts)! });

		const direct = new Map<string, Anchor[]>();
		for (const anchor of anchors) {
			if (!sessions.has(anchor.file)) {
				gap("missing-session", anchor.file, anchor.key.task);
				continue;
			}
			if (anchor.at < sessions.get(anchor.file)!.header.timestamp) {
				gap("event-time-order", anchor.file, anchor.key.task);
				continue;
			}
			const list = direct.get(anchor.file) ?? [];
			if (!list.some((a) => a.at === anchor.at && taskId(a.key) === taskId(anchor.key))) list.push(anchor);
			direct.set(anchor.file, list);
		}
		const parents = new Map<string, Edge[]>();
		for (const edge of edges) {
			if (!sessions.has(edge.child) || !sessions.has(edge.parent)) {
				gap("missing-parent", edge.child);
				continue;
			}
			if (
				edge.at < sessions.get(edge.child)!.header.timestamp ||
				edge.at < sessions.get(edge.parent)!.header.timestamp
			) {
				gap("event-time-order", edge.child);
				continue;
			}
			const list = parents.get(edge.child) ?? [];
			list.push(edge);
			parents.set(edge.child, list);
		}
		const resolved = new Map<string, ChatMembership[]>();
		const visiting: string[] = [];
		const cycles = new Set<string>();
		function resolve(file: string): ChatMembership[] {
			tick();
			if (resolved.has(file)) return resolved.get(file)!;
			const cycle = visiting.indexOf(file);
			if (cycle !== -1) {
				for (const member of visiting.slice(cycle)) {
					cycles.add(member);
					gap("parent-cycle", member);
				}
				return [];
			}
			visiting.push(file);
			const s = sessions.get(file)!;
			const candidates = [...(direct.get(file) ?? [])];
			for (const edge of parents.get(file) ?? []) {
				const at = edge.at > s.header.timestamp ? edge.at : s.header.timestamp;
				const inherited = resolve(edge.parent).filter((m) => m.from <= at && (m.until === null || at < m.until));
				for (const m of inherited) {
					candidates.push({ file, key: { queue: m.queue, task: m.task, addedAt: m.addedAt }, at });
				}
			}
			// Native same-session resume/copy. A new ID without parentSession cannot inherit by filename.
			if (!parents.has(file)) {
				for (const other of sessions.values()) {
					if (other.file === file || other.header.id !== s.header.id) continue;
					for (const a of direct.get(other.file) ?? [])
						candidates.push({ ...a, file, at: a.at > s.header.timestamp ? a.at : s.header.timestamp });
				}
			}
			const groups = new Map<string, Map<string, TaskKey>>();
			for (const c of candidates) {
				const at = c.at > s.header.timestamp ? c.at : s.header.timestamp;
				const group = groups.get(at) ?? new Map<string, TaskKey>();
				group.set(taskId(c.key), c.key);
				groups.set(at, group);
			}
			const rows: ChatMembership[] = [];
			let open: ChatMembership | undefined;
			if (!cycles.has(file))
				for (const [at, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
					const previous = open;
					if (open) open.until = at;
					open = undefined;
					if (group.size !== 1) {
						gap("conflicting-membership", file);
						continue;
					}
					const key = [...group.values()][0];
					if (previous && taskId(previous) === taskId(key)) {
						previous.until = null;
						open = previous;
						continue;
					}
					open = { ...key, file, sessionId: s.header.id, from: at, until: null };
					rows.push(open);
				}
			visiting.pop();
			resolved.set(file, rows);
			return rows;
		}
		for (const s of sessions.values()) {
			const rows = resolve(s.file);
			result.memberships.push(...rows);
			if (!rows.length) result.notInAnyTask.push({ file: s.file, sessionId: s.header.id });
		}
		if (result.memberships.length + result.parentHistory.length > MEMBERSHIP_LIMITS.historyRows)
			throw new Stop("record-limit");
	} catch (error) {
		// Never return a partial association after a capacity/shape failure or raw exception text.
		result.memberships = [];
		result.parentHistory = [];
		result.notInAnyTask = [];
		gap(error instanceof Stop ? error.code : "invalid-metadata");
	}
	result.memberships.sort((a, b) => a.file.localeCompare(b.file) || a.from.localeCompare(b.from));
	result.parentHistory.sort((a, b) => taskId(a).localeCompare(taskId(b)) || a.effectiveAt.localeCompare(b.effectiveAt));
	result.notInAnyTask.sort((a, b) => a.file.localeCompare(b.file));
	result.gaps.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	return result;
}

/** Conservative join for a caller with an original event time. A gap is never silently accepted.
 * null is unassigned OR insufficient evidence; inspect map.gaps to distinguish them. */
export function taskMembershipAt(
	map: MembershipMap,
	file: string,
	occurredAt: string,
	origin: "chat" | "helper" | "app",
): TaskMembership | null {
	if (origin === "app" || map.gaps.length || !iso(occurredAt)) return null;
	const matches = map.memberships.filter(
		(m) => m.file === file && m.from <= occurredAt && (m.until === null || occurredAt < m.until),
	);
	if (matches.length !== 1) return null;
	const history = map.parentHistory.filter((m) => taskId(m) === taskId(matches[0]) && m.effectiveAt <= occurredAt);
	const at = history
		.map((m) => m.effectiveAt)
		.sort()
		.at(-1);
	const latest = history.filter((m) => m.effectiveAt === at);
	return latest.length === 1 ? structuredClone(latest[0]) : null;
}

/** Feed only #293 parent snapshots to #300; file mappings/gaps cannot be smuggled into NumericRows.
 * Context times/cursors/incarnation are native caller evidence, never inferred from row timestamps.
 * Partial status is mandatory even on a clean map: this is not usage/occurrence coverage. */
export function membershipSourceBatches(
	map: MembershipMap,
	context: Omit<MembershipSourceBatch, "v" | "rows" | "status" | "reason" | "fromCursor" | "toCursor"> & {
		fromCursor: MembershipSourceBatch["fromCursor"];
		cursorTokens: readonly string[];
	},
): MembershipSourceBatch[] {
	const chunks: TaskMembership[][] = [];
	for (let i = 0; i < map.parentHistory.length; i += MEMBERSHIP_LIMITS.batchRows)
		chunks.push(map.parentHistory.slice(i, i + MEMBERSHIP_LIMITS.batchRows));
	if (!chunks.length) chunks.push([]);
	if (context.cursorTokens.length !== chunks.length || context.cursorTokens.some((t) => !reference(t))) return [];
	let fromCursor = context.fromCursor;
	return chunks.map((memberships, i) => {
		const toCursor = { ordinal: (fromCursor?.ordinal ?? 0) + 1, token: context.cursorTokens[i] };
		const batch: MembershipSourceBatch = {
			v: "usage-source-batch/1",
			stream: context.stream,
			incarnation: context.incarnation,
			adapterRef: context.adapterRef,
			fromCursor,
			toCursor,
			from: context.from,
			through: context.through,
			observedAt: context.observedAt,
			status: "partial",
			reason: "reported-gap",
			rows: {
				facts: [],
				allocations: [],
				aliases: [],
				roots: [],
				policies: [],
				memberships: structuredClone(memberships),
				snapshots: [],
			},
		};
		fromCursor = toCursor;
		return batch;
	});
}
