// Real filesystem on sealed, throwaway synthetic data. No native messages, Owner approvals or producer events.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IdentityDef } from "../../server/identities.js";
import { RoleMessages, type RoleMessageHost, type RoleMessageRecord } from "../../server/role-messages.js";
import type {
	GuardAcceptedReceipt,
	GuardAtomicMutation,
	GuardOperationIdentity,
	GuardStoreState,
} from "../../server/role-message-guard-contract.js";
import {
	GuardFileStore,
	guardDigest,
	guardTransactionId,
	type GuardFileBoundary,
	type GuardFileStoreOptions,
	type GuardLegacyFile,
} from "../../server/role-message-guard-store.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const now = 2000000000;
const initial = (): GuardStoreState => ({
	version: "role-message-guard/v1",
	revision: "synthetic-v1",
	mode: "enabled",
	lastTrustedTime: now,
	requests: [],
	grants: [],
	incidents: [],
	usage: [],
	transactions: [],
	outbox: [],
	audits: [],
	tombstones: [],
	overflow: { count: 0, state: "none" },
});
function identity(id: string): GuardOperationIdentity {
	return {
		version: "role-message-guard/v1",
		operationId: id,
		fingerprint: guardDigest({ id }),
		actor: {
			role: "alpha",
			sessionFile: "/synthetic/alpha.jsonl",
			sessionId: "synthetic-alpha",
			runtimeIncarnation: "synthetic-runtime",
			task: { kind: "home" },
			currentHome: true,
			identityRevision: "synthetic-v1",
		},
	};
}
const legacy = (): GuardLegacyFile => ({ v: 1, paused: false, messages: [] });
function message(id: string, chain = 1): RoleMessageRecord {
	return {
		id,
		at: now,
		from: { role: "alpha", title: "Alpha", chat: "synthetic home", file: "/synthetic/alpha.jsonl" },
		to: { role: "beta", title: "Beta" },
		kind: "fyi",
		text: "Exact synthetic legacy words — 中文",
		chain,
		state: "waiting",
		sends: 0,
		attempts: 0,
		forOwner: true,
		ownerIds: ["synthetic-owner-id"],
		ownerChannel: "telegram",
		initiative: "synthetic-initiative",
	};
}
function mutation(
	state: GuardStoreState,
	id: GuardOperationIdentity,
	record = message(`rm-${guardDigest(id).slice(0, 8)}`),
): GuardAtomicMutation {
	const transactionId = guardTransactionId(id);
	const receipt: GuardAcceptedReceipt = {
		version: id.version,
		identity: id,
		transactionId,
		committedAt: now,
		messageId: record.id,
		causal: {
			kind: "legacy_boundary",
			anchorId: "synthetic-boundary",
			incomingRecordId: "original-old-incoming",
			incomingHash: "original-word-digest",
			nextHop: record.chain,
			historicalRoot: "unknown",
		},
		class: "business",
		usage: {
			ordinaryOrigin: 1,
			grantBusinessUse: 0,
			protectedOrigin: 0,
			protectedDestination: 0,
			protectedSystem: 0,
			newIncidentOrigin: 0,
		},
		outboxId: `outbox-${transactionId}`,
		dispatchKey: `dispatch-${transactionId}`,
		wakeKey: `wake-${transactionId}`,
		legacyMessageDigest: guardDigest(record),
	};
	const result = { state: "accepted" as const, receipt, delivery: "committed" as const };
	return {
		next: {
			...state,
			revision: `synthetic-revision-${id.operationId}`,
			outbox: [
				...state.outbox,
				{
					receipt,
					message: { ...record, kind: "fyi" },
					state: "committed",
					wakeState: "not_requested",
					lastEvidence: null,
				},
			],
			usage: [
				...state.usage,
				{ transactionId, committedAt: now, origin: "alpha", destination: "beta", usage: receipt.usage },
			],
			transactions: [...state.transactions, { state: "committed", identity: id, transactionId, result }],
			audits: [
				...state.audits,
				{ id: `audit-${transactionId}`, transactionId, subjectId: id.operationId, event: "used", proof: null, at: now },
			],
		},
		legacyAccepted: [{ ...record, kind: "fyi" }],
		result,
	};
}
async function fixture(maximumBytes = 32 * 1024 * 1024, create = true) {
	const dir = mkdtempSync(join(tmpdir(), "guard-store-unit-"));
	dirs.push(dir);
	let tail: Promise<unknown> = Promise.resolve();
	const withExclusive = <T>(work: () => Promise<T>): Promise<T> => {
		const run = tail.then(work, work);
		tail = run.catch(() => {});
		return run;
	};
	const f = { fault: null as GuardFileBoundary | null, calls: [] as GuardFileBoundary[] };
	const options: GuardFileStoreOptions = {
		journalPath: join(dir, "guard-journal.json"),
		legacyPath: join(dir, "role-messages.json"),
		maximumBytes,
		withExclusive,
		boundary: (point) => {
			f.calls.push(point);
			if (f.fault === point) throw new Error(`synthetic fault:${point}`);
		},
	};
	const store = new GuardFileStore(options);
	if (create) expect((await store.initialize(initial(), legacy())).state).toBe("ready");
	return { dir, f, store, options };
}
const boundaries: GuardFileBoundary[] = [
	"prepare:write",
	"prepare:flush",
	"prepare:rename",
	"prepare:directory_flush",
	"commit:write",
	"commit:flush",
	"commit:rename",
	"commit:directory_flush",
	"legacy:write",
	"legacy:flush",
	"legacy:rename",
	"legacy:directory_flush",
];

describe("E durable prepare/commit/publication boundary", () => {
	it("does not touch paths on construction and never creates an empty history on read", async () => {
		const t = await fixture(undefined, false);
		expect(existsSync(t.options.journalPath)).toBe(false);
		expect((await t.store.read()).state).toBe("unknown");
		expect((await t.store.lookup(identity("not-initialized"))).state).not.toBe("absent");
		expect(existsSync(t.options.journalPath)).toBe(false);
	});
	it("rejects default/relative paths, invalid capacities and journal reset", async () => {
		const t = await fixture();
		expect(() => new GuardFileStore({ ...t.options, journalPath: "relative" })).toThrow(/explicit/);
		expect(() => new GuardFileStore({ ...t.options, maximumBytes: Infinity })).toThrow(/explicit/);
		expect((await t.store.initialize(initial(), legacy())).state).toBe("unavailable");
	});
	it("only acknowledges after prepare, commit and canonical publication all flush", async () => {
		const t = await fixture();
		t.f.calls = [];
		const id = identity("one");
		const r = await t.store.transact(id, async (s) => mutation(s, id));
		expect(r.state).toBe("committed");
		expect(t.f.calls).toEqual(boundaries);
		const restart = new GuardFileStore({ ...t.options, boundary: null });
		expect((await restart.recover()).state).toBe("ready");
		expect((await restart.lookup(id)).state).toBe("found");
		expect(JSON.parse(readFileSync(t.options.legacyPath, "utf8")).messages).toHaveLength(1);
	});
	it.each(boundaries)(
		"fails loudly at %s; restart does not lose words, reset an allowance or invent acceptance",
		async (boundary) => {
			const t = await fixture();
			const id = identity(`crash-${boundary}`);
			t.f.fault = boundary;
			const attempted = await t.store.transact(id, async (s) => mutation(s, id));
			expect(attempted.state).toBe("unknown");
			if (attempted.state === "unknown") expect(attempted.reservation).toBe("held");
			expect((await t.store.read()).state).toBe("unknown");
			t.f.fault = null;
			const restart = new GuardFileStore({ ...t.options, boundary: null });
			const recovered = await restart.recover();
			if (boundary === "prepare:write" || boundary === "prepare:flush" || boundary === "prepare:rename") {
				expect(recovered.state).toBe("ready");
				expect((await restart.lookup(id)).state).toBe("absent");
				expect(JSON.parse(readFileSync(t.options.legacyPath, "utf8")).messages).toHaveLength(0);
			} else if (
				boundary === "prepare:directory_flush" ||
				boundary === "commit:write" ||
				boundary === "commit:flush" ||
				boundary === "commit:rename"
			) {
				expect(recovered.state).toBe("unknown");
				expect((await restart.read()).state).toBe("unknown");
				const raw = JSON.parse(readFileSync(t.options.journalPath, "utf8"));
				expect(raw.stage).toBe("prepared");
				expect(raw.reservation.usage.ordinaryOrigin).toBe(1);
				expect(JSON.parse(readFileSync(t.options.legacyPath, "utf8")).messages).toHaveLength(0);
			} else {
				expect(recovered.state).toBe("ready");
				const read = await restart.read();
				if (read.state !== "ready") throw new Error("fixture");
				expect(read.value.usage).toHaveLength(1);
				expect(JSON.parse(readFileSync(t.options.legacyPath, "utf8")).messages).toHaveLength(1);
				expect((await restart.lookup(id)).state).toBe("found");
				expect(
					(
						await restart.transact(id, async () => {
							throw new Error("MUST NOT REPLAY");
						})
					).state,
				).toBe("committed");
			}
		},
	);
	it("two instances sharing the host lease never admit the same operation twice", async () => {
		const t = await fixture();
		const second = new GuardFileStore({ ...t.options, boundary: null });
		await second.recover();
		const id = identity("concurrent");
		let updates = 0;
		const update = async (s: GuardStoreState) => {
			updates++;
			return mutation(s, id);
		};
		const r = await Promise.all([t.store.transact(id, update), second.transact(id, update)]);
		expect(r.every((v) => v.state === "committed")).toBe(true);
		expect(updates).toBe(1);
		expect(JSON.parse(readFileSync(t.options.legacyPath, "utf8")).messages).toHaveLength(1);
	});
	it("same operation with a new actor/fingerprint conflicts rather than resetting identity", async () => {
		const t = await fixture();
		const id = identity("same-id");
		await t.store.transact(id, async (s) => mutation(s, id));
		const conflict = await t.store.lookup({
			...id,
			fingerprint: "different",
			actor: { ...id.actor, sessionId: "another-session" },
		});
		expect(conflict.state).toBe("found");
		if (conflict.state === "found")
			expect(conflict.result).toMatchObject({ state: "blocked", reason: "identity_conflict" });
	});
	it("a corrupt/checksum-mismatched/reordered journal is never authoritative absence", async () => {
		const t = await fixture();
		const id = identity("corrupt");
		await t.store.transact(id, async (s) => mutation(s, id));
		const raw = JSON.parse(readFileSync(t.options.journalPath, "utf8"));
		raw.state.usage = [];
		writeFileSync(t.options.journalPath, JSON.stringify(raw));
		expect((await new GuardFileStore(t.options).recover()).state).toBe("unknown");
		expect((await t.store.lookup(identity("other"))).state).toBe("unknown");
	});
	it("legacy mutation after commit is fenced; recovery refuses stale overwrite", async () => {
		const t = await fixture();
		const id = identity("divergence");
		await t.store.transact(id, async (s) => mutation(s, id));
		const raw = JSON.parse(readFileSync(t.options.legacyPath, "utf8"));
		raw.messages.push(message("rm-ffffffff"));
		writeFileSync(t.options.legacyPath, JSON.stringify(raw));
		const expected = readFileSync(t.options.legacyPath, "utf8");
		expect((await t.store.recover()).state).toBe("unknown");
		expect(readFileSync(t.options.legacyPath, "utf8")).toBe(expected);
	});
	it("silent save failure or unbound acceptance is not a commit", async () => {
		const t = await fixture();
		const id = identity("bad-publication");
		const r = await t.store.transact(id, async (s) => ({ ...mutation(s, id), legacyAccepted: [] }));
		expect(r.state).toBe("not_committed");
		expect(JSON.parse(readFileSync(t.options.legacyPath, "utf8")).messages).toHaveLength(0);
	});
	it("mutation exception before prepare proves no commit, without partially changing quota", async () => {
		const t = await fixture();
		const id = identity("throw");
		expect(
			(
				await t.store.transact(id, async () => {
					throw new Error("synthetic pre-prepare exception");
				})
			).state,
		).toBe("not_committed");
		const read = await t.store.read();
		if (read.state !== "ready") throw new Error("fixture");
		expect(read.value.usage).toHaveLength(0);
	});
	it("explicit byte capacity blocks growth without truncating words", async () => {
		const t = await fixture(1200);
		const before = readFileSync(t.options.legacyPath, "utf8");
		const id = identity("capacity");
		expect((await t.store.transact(id, async (s) => mutation(s, id))).state).toBe("not_committed");
		expect(readFileSync(t.options.legacyPath, "utf8")).toBe(before);
	});
	it("bootstrap cannot omit recent old-reader ordinary charges or discard old words", async () => {
		const t = await fixture(undefined, false);
		const old = message("rm-00000001");
		expect((await t.store.initialize(initial(), { ...legacy(), messages: [old] })).state).toBe("unknown");
		expect(existsSync(t.options.journalPath)).toBe(false);
	});
});

describe("E actual previous-reader compatibility on synthetic files", () => {
	function oldReader(file: string) {
		// Same partial-identity fixture convention as tests/unit/role-replies.test.ts: the old reader only reads id/title/homeChat.
		const target = {
			id: "beta",
			title: "Beta",
			folder: null,
			homeChat: "/synthetic/beta.jsonl",
			pastHomeChats: [],
			dir: "/synthetic/beta",
			raw: {},
		} as unknown as IdentityDef;
		const host: RoleMessageHost = {
			roles: () => [target],
			chatState: () => "closed",
			deliver: async () => ({ ok: false, error: "synthetic reader must never deliver" }),
			note: async () => ({ ok: false, error: "synthetic reader must never wake" }),
			log: () => {},
		};
		return new RoleMessages(file, host, () => now);
	}
	it("reads exact words, original depth and all Owner/initiative metadata through the real old loader", async () => {
		const t = await fixture();
		const id = identity("old-readable");
		const m = message("rm-12345678", 11);
		await t.store.transact(id, async (s) => mutation(s, id, m));
		const reader = oldReader(t.options.legacyPath);
		try {
			expect(reader.byId(m.id)).toEqual(m);
		} finally {
			reader.stop();
		}
	});
	it("real old hourly gate counts EVERY new non-report class and blocks its21st", async () => {
		const t = await fixture();
		for (let n = 0; n < 20; n++) {
			const id = identity(`old-hour-${n}`);
			await t.store.transact(id, async (s) => {
				const change = mutation(s, id);
				const cls = n % 3 === 0 ? ("protected" as const) : n % 3 === 1 ? ("control" as const) : ("business" as const);
				if (change.result.state !== "accepted") throw new Error("fixture");
				const r = { ...change.result.receipt, class: cls };
				return {
					...change,
					next: {
						...change.next,
						outbox: change.next.outbox.map((o) =>
							o.receipt.transactionId === r.transactionId ? { ...o, receipt: r } : o,
						),
						transactions: change.next.transactions.map((tx) =>
							tx.state === "committed" && tx.transactionId === r.transactionId
								? { ...tx, result: { state: "accepted", receipt: r, delivery: "committed" } }
								: tx,
						),
					},
					result: { state: "accepted", receipt: r, delivery: "committed" },
				};
			});
		}
		const reader = oldReader(t.options.legacyPath);
		try {
			const result = reader.send(
				{ role: "alpha", title: "Alpha", chat: "synthetic home", file: "/synthetic/alpha.jsonl", handling: 0 },
				{ to: "beta", kind: "fyi", text: "Synthetic21st" },
			);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toMatch(/20 role messages/);
		} finally {
			reader.stop();
		}
	});
	it("old reader write preserves words but changed pause state requires host lease/reconciliation, not blind overwrite", async () => {
		const t = await fixture();
		const id = identity("old-pause");
		const m = message("rm-87654321", 12);
		await t.store.transact(id, async (s) => mutation(s, id, m));
		const reader = oldReader(t.options.legacyPath);
		try {
			reader.setPaused(true);
			expect(reader.byId(m.id)).toEqual(m);
		} finally {
			reader.stop();
		}
		const expected = readFileSync(t.options.legacyPath, "utf8");
		expect((await t.store.recover()).state).toBe("unknown");
		expect(readFileSync(t.options.legacyPath, "utf8")).toBe(expected);
	});
});
