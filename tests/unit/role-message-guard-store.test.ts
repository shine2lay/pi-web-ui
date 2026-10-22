// Real filesystem on sealed, throwaway synthetic data. No native messages, Owner approvals or producer events.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IdentityDef } from "../../server/identities.js";
import { RoleMessages, type RoleMessageHost, type RoleMessageRecord } from "../../server/role-messages.js";
import type {
	GuardAcceptedReceipt,
	GuardApprovalBinding,
	GuardApprovalContext,
	GuardAtomicMutation,
	GuardOperationIdentity,
	GuardProofReference,
	GuardRequest,
	GuardStoreState,
	GuardVerifiedDecision,
} from "../../server/role-message-guard-contract.js";
import {
	GuardFileStore,
	guardDigest,
	guardJournalRefusal,
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

describe("#122 H-ROLE-LADDER-PERF-1: same digests, cached reads only for identical text", () => {
	// The digest before PERF-1, kept verbatim as the reference.
	function referenceDigest(value: unknown): string {
		function sort(v: unknown): unknown {
			if (Array.isArray(v)) return v.map(sort);
			if (v && typeof v === "object") {
				return Object.fromEntries(
					Object.entries(v)
						.filter(([, x]) => x !== undefined)
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([k, x]) => [k, sort(x)]),
				);
			}
			return v;
		}
		return createHash("sha256")
			.update(JSON.stringify(sort(value)))
			.digest("hex");
	}
	it("guardDigest equals the old sort-then-stringify digest on fixed and random values", () => {
		const fixed: unknown[] = [
			null,
			0,
			-1.5,
			NaN,
			Infinity,
			"",
			'\u2028\ud800 "quote"',
			true,
			[],
			{},
			[undefined, () => 1, Symbol("s"), null],
			{
				b: 1,
				a: undefined,
				c: () => 1,
				d: Symbol("x"),
				"10": 1,
				"2": 2,
				"02": 3,
				"-1": 4,
				"4294967295": 5,
				"4294967294": 6,
			},
			{ "\u00e9": 1, é: 2, E: 3, e: 4, _: 5, "": 6, Z: 7, a1: 8, a10: 9, a2: 10 },
			JSON.parse('{"__proto__":{"x":1},"y":[1,{"b":2,"a":[{}]}]}'),
			new Date(0),
			// eslint-disable-next-line no-sparse-arrays
			[1, , 3],
		];
		let seed = 122;
		const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
		const keys = ["a", "B", "b", "0", "1", "10", "01", "\u00e9", "z", "id", "Id", "_x", "x y", "\u4e2d"];
		const gen = (depth: number): unknown => {
			const r = rand();
			if (depth > 4 || r < 0.35) {
				const p = rand();
				if (p < 0.2) return Math.floor(rand() * 1e6);
				if (p < 0.4) return keys[Math.floor(rand() * keys.length)] + '\n\t"';
				if (p < 0.55) return rand() < 0.5;
				if (p < 0.7) return null;
				if (p < 0.8) return undefined;
				return rand() * 1e3;
			}
			if (r < 0.6) return Array.from({ length: Math.floor(rand() * 4) }, () => gen(depth + 1));
			const o: Record<string, unknown> = {};
			for (let i = Math.floor(rand() * 6); i > 0; i--) o[keys[Math.floor(rand() * keys.length)]] = gen(depth + 1);
			return o;
		};
		const values = [...fixed, ...Array.from({ length: 2000 }, () => gen(0))];
		for (const [i, value] of values.entries())
			if (value !== undefined) expect(guardDigest(value), `value ${i}`).toBe(referenceDigest(value));
		expect(() => guardDigest(undefined)).toThrow();
	});
	it("a journal changed on disk after a cached read is decoded again, never served from the cache", async () => {
		const t = await fixture();
		const first = await t.store.read();
		if (first.state !== "ready") throw new Error("store not ready");
		// Same length, one byte different: the checksum no longer matches, so the store must refuse it.
		const raw = readFileSync(t.options.journalPath, "utf8");
		const at = raw.indexOf('"revision":') + '"revision":'.length;
		const digit = raw[at];
		writeFileSync(
			t.options.journalPath,
			raw.slice(0, at) + (digit === "9" ? "8" : String(Number(digit) + 1)) + raw.slice(at + 1),
		);
		const second = await t.store.read();
		expect(second.state).toBe("unknown");
		// The original text again: the store reads it as before.
		writeFileSync(t.options.journalPath, raw);
		expect(await t.store.read()).toEqual(first);
		// What a read hands out is a copy: changing it changes nothing stored.
		const copy = await t.store.read();
		if (copy.state !== "ready") throw new Error("store not ready");
		(copy.value as unknown as { revision: string }).revision += "-changed";
		expect(await t.store.read()).toEqual(first);
		// After a commit (whose own text the store remembers), a changed journal is again refused.
		const id = identity("perf-cache");
		expect((await t.store.transact(id, async (s) => mutation(s, id))).state).toBe("committed");
		const after = await t.store.read();
		expect(after.state).toBe("ready");
		const written = readFileSync(t.options.journalPath, "utf8");
		writeFileSync(t.options.journalPath, written.replace('"stage":"committed"', '"stage":"prepared"'));
		expect((await t.store.read()).state).toBe("unknown");
		writeFileSync(t.options.journalPath, written);
		expect(await t.store.read()).toEqual(after);
	});
	it("PERF-2: the files a commit writes are the sorted JSON of their own content, and a fresh store reads them in full", async () => {
		const t = await fixture();
		for (const name of ["perf-2-a", "perf-2-b"]) {
			const id = identity(name);
			expect((await t.store.transact(id, async (s) => mutation(s, id))).state).toBe("committed");
		}
		const after = await t.store.read();
		expect(after.state).toBe("ready");
		const sha = (text: string) => createHash("sha256").update(text).digest("hex");
		const journal = readFileSync(t.options.journalPath, "utf8");
		const legacyText = readFileSync(t.options.legacyPath, "utf8");
		const parsed = JSON.parse(journal) as { checksum: string; stage: string; legacy: unknown };
		expect(sha(journal)).toBe(guardDigest(parsed));
		expect(sha(legacyText)).toBe(guardDigest(JSON.parse(legacyText)));
		const { checksum, ...body } = parsed;
		expect(checksum).toBe(guardDigest(body));
		expect(parsed.stage).toBe("committed");
		expect(guardDigest(parsed.legacy)).toBe(sha(legacyText));
		// No cache: a second store decodes and re-digests both files in full.
		const fresh = new GuardFileStore(t.options);
		expect((await fresh.recover()).state).toBe("ready");
		expect(await fresh.read()).toEqual(after);
		expect(readFileSync(t.options.journalPath, "utf8")).toBe(journal);
	});
	it("an accepted copy changed on disk after a cached read makes the store not ready", async () => {
		const t = await fixture();
		expect((await t.store.read()).state).toBe("ready");
		const legacy = JSON.parse(readFileSync(t.options.legacyPath, "utf8"));
		writeFileSync(t.options.legacyPath, JSON.stringify({ ...legacy, paused: !legacy.paused }));
		expect((await t.store.read()).state).toBe("unknown");
		writeFileSync(t.options.legacyPath, JSON.stringify(legacy));
		expect((await t.store.read()).state).toBe("ready");
	});
});

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
	// Ops #253 (Architecture A3): one test of "the journal holds a prepared send" for the fresh start and recover().
	it.each(boundaries)(
		"stopped at %s: the fresh start's check and recover() agree on a prepared send",
		async (boundary) => {
			const t = await fixture();
			const id = identity(`stop-${boundary}`);
			t.f.fault = boundary;
			expect((await t.store.transact(id, async (s) => mutation(s, id))).state).toBe("unknown");
			const prepared = JSON.parse(readFileSync(t.options.journalPath, "utf8")).stage === "prepared";
			const refusal = guardJournalRefusal(readFileSync(t.options.journalPath, "utf8"));
			const recovered = await new GuardFileStore({ ...t.options, boundary: null }).recover();
			expect(refusal).toBe(prepared ? `the journal holds a prepared send (operation ${id.operationId})` : null);
			expect(recovered.state === "unknown" ? recovered.reason : "ready").toBe(
				prepared ? "prepared reservation held; no speculative commit/refund/retry" : "ready",
			);
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

describe("#426: continuing acceptance is not an hourly charge or new authority", () => {
	async function accepted() {
		const t = await fixture();
		const id = identity("original-acceptance");
		expect((await t.store.transact(id, async (s) => mutation(s, id))).state).toBe("committed");
		return t;
	}
	function lateUpdate(
		s: GuardStoreState,
		elapsed: number,
		change: (r: GuardAcceptedReceipt) => GuardAcceptedReceipt = (r) => r,
	): GuardAtomicMutation {
		const receipt = change(s.outbox[0].receipt);
		const result = { state: "accepted" as const, receipt, delivery: "dispatching" as const };
		const id = identity("late-maintenance");
		return {
			result,
			legacyAccepted: [],
			next: {
				...s,
				lastTrustedTime: now + elapsed,
				usage: [],
				outbox: [{ ...s.outbox[0], state: "dispatching", receipt }],
				transactions: [
					...s.transactions.map((t) => (t.state === "committed" ? { ...t, result } : t)),
					{ state: "committed", identity: id, transactionId: guardTransactionId(id), result },
				],
			},
		};
	}
	it.each([3600000, 3660000])(
		"uses the existing committed receipt at %i ms without renewing usage",
		async (elapsed) => {
			const t = await accepted();
			expect((await t.store.transact(identity("late-maintenance"), async (s) => lateUpdate(s, elapsed))).state).toBe(
				"committed",
			);
			const read = await t.store.read();
			expect(read.state).toBe("ready");
			if (read.state !== "ready") throw new Error("fixture");
			expect(read.value.usage).toEqual([]);
		},
	);
	it("cannot remove a charge at 1 h minus 1 ms", async () => {
		const t = await accepted();
		expect(await t.store.transact(identity("late-maintenance"), async (s) => lateUpdate(s, 3599999))).toMatchObject({
			state: "not_committed",
			reason: "recent accepted charge cannot be removed",
		});
	});
	it("cannot manufacture a charge-free acceptance, even by backdating it and inserting its own receipt", async () => {
		const t = await fixture();
		const id = identity("unpaid-new-acceptance");
		expect(
			await t.store.transact(id, async (s) => {
				const m = mutation(s, id);
				return { ...m, next: { ...m.next, lastTrustedTime: now + 3660000, usage: [] } };
			}),
		).toMatchObject({ state: "not_committed", reason: "acceptance missing canonical words or charge" });
	});
	it.each<[string, (r: GuardAcceptedReceipt) => GuardAcceptedReceipt]>([
		["identity", (r) => ({ ...r, identity: identity("forged") })],
		["transaction", (r) => ({ ...r, transactionId: "forged" })],
		["time", (r) => ({ ...r, committedAt: r.committedAt - 1 })],
		["cause", (r) => ({ ...r, causal: { ...r.causal, nextHop: r.causal.nextHop + 1 } })],
		["class", (r) => ({ ...r, class: "control" })],
		["usage", (r) => ({ ...r, usage: { ...r.usage, grantBusinessUse: 1 } })],
		["outbox", (r) => ({ ...r, outboxId: "forged" })],
		["dispatch", (r) => ({ ...r, dispatchKey: "forged" })],
		["wake", (r) => ({ ...r, wakeKey: "forged" })],
	])("cannot change the accepted %s binding when the charge is gone", async (_, change) => {
		const t = await accepted();
		expect(
			await t.store.transact(identity("late-maintenance"), async (s) => lateUpdate(s, 3660000, change)),
		).toMatchObject({
			state: "not_committed",
			reason: "acceptance missing canonical words or charge",
		});
	});
});

describe("E request history is immutable at the single writer (Ops rm-1bb3c77b item 3)", () => {
	const proof: GuardProofReference = {
		sourceId: "synthetic-source",
		sourceVersion: "synthetic-v1",
		sourceIncarnation: "synthetic-incarnation",
		eventId: "synthetic-event",
		revision: "synthetic-revision",
		digest: "synthetic-digest",
		observedAt: now,
	};
	const approver = { ...identity("coo").actor, role: "coo", sessionFile: "/synthetic/coo.jsonl" };
	const lowerBinding: GuardApprovalBinding = {
		version: "role-message-guard/v1",
		requestId: "synthetic-request",
		generation: "synthetic-generation-1",
		requester: identity("requester").actor,
		causal: {
			kind: "legacy_boundary",
			anchorId: "synthetic-boundary",
			incomingRecordId: "synthetic-incoming",
			incomingHash: "synthetic-hash",
			nextHop: 9,
			historicalRoot: "unknown",
		},
		scope: {
			scopeId: "synthetic-scope",
			operation: "synthetic-operation",
			participants: ["alpha", "beta"],
			recipients: ["beta"],
			task: { kind: "home" },
		},
		tier: "lower",
		quantity: 3,
		upperHop: 11,
	};
	const ownerBinding: GuardApprovalBinding = {
		...lowerBinding,
		generation: "owner-escalation-synthetic",
		tier: "owner",
	};
	const context: GuardApprovalContext = {
		goal: "Synthetic goal",
		progressAndChanges: "Synthetic progress",
		priorDecisions: ["Synthetic lower escalation, not a grant or a final approval."],
		whyNeeded: "Synthetic reason",
		nextStepAndOutcome: "Synthetic next step",
		outstandingQuestions: ["Synthetic question"],
		optionsAndTradeoffs: ["Synthetic option"],
		timeCostRisk: "Synthetic cost",
		exactCommunicationAuthority: "Synthetic communication-only authority",
		nativeFacts: [proof],
		declaredClaims: [],
		safetyScopeAndHolds: ["Synthetic holds"],
	};
	const selection = { tier: "lower" as const, role: "coo", route: "coo" as const, home: approver, proof };
	const escalation: GuardVerifiedDecision = {
		binding: lowerBinding,
		choice: "escalate_owner",
		reason: "Synthetic: the Owner should decide",
		authority: { tier: "lower", selection, decisionId: "synthetic-lower-decision", proof },
		answeredAt: now,
		firstAnswerEventId: "synthetic-lower-answer",
	};
	const ownerDenial: GuardVerifiedDecision = {
		binding: ownerBinding,
		choice: "deny",
		reason: "Synthetic Owner denial",
		authority: {
			tier: "owner",
			questionId: "synthetic-question",
			questionGeneration: ownerBinding.generation,
			choicesDigest: "synthetic-choices",
			decisionId: "synthetic-owner-decision",
			source: { kind: "authenticated_browser", authenticatedOwnerBindingId: "synthetic-owner-binding" },
			proof,
		},
		answeredAt: now,
		firstAnswerEventId: "synthetic-owner-answer",
	};
	const lower: GuardRequest = {
		binding: lowerBinding,
		context: { ...context, priorDecisions: [] },
		selectedApprover: selection,
		createdAt: now,
		expiresAt: now + 86400000,
		state: "revoked",
		upwardEscalations: 0,
		initialNotificationKey: "synthetic-initial-key",
		decisionNotificationKey: "synthetic-decision-key",
		firstDecision: escalation,
		grantId: null,
	};
	const phase: GuardRequest = {
		...lower,
		binding: ownerBinding,
		context,
		selectedApprover: { tier: "owner", reason: "explicit_escalation" },
		state: "awaiting_owner",
		upwardEscalations: 1,
		firstDecision: null,
	};
	const tombstone = (b: GuardApprovalBinding) => ({
		kind: "request" as const,
		identityDigest: guardDigest({ requestId: b.requestId, generation: b.generation }),
		invalidThrough: "source_horizon_unknown" as const,
		lastTransactionId: null,
	});
	function rewrite(
		state: GuardStoreState,
		id: GuardOperationIdentity,
		requests: GuardRequest[],
		tombstones: GuardStoreState["tombstones"] = state.tombstones,
	): GuardAtomicMutation {
		const transactionId = guardTransactionId(id);
		const result = {
			state: "recorded" as const,
			transactionId,
			request: requests[0] ?? phase,
			communicationAccepted: false as const,
		};
		return {
			next: {
				...state,
				revision: `synthetic-revision-${id.operationId}`,
				requests,
				tombstones,
				transactions: [...state.transactions, { state: "committed", identity: id, transactionId, result }],
			},
			legacyAccepted: [],
			result,
		};
	}
	async function seeded() {
		const t = await fixture(undefined, false);
		expect((await t.store.initialize({ ...initial(), requests: [lower, phase] }, legacy())).state).toBe("ready");
		return t;
	}
	const forgeries: [string, GuardRequest[], GuardStoreState["tombstones"] | undefined][] = [
		["reset the lower first answer", [{ ...lower, firstDecision: null, state: "awaiting_approver" }, phase], undefined],
		[
			"rewrite the lower first answer",
			[{ ...lower, firstDecision: { ...escalation, choice: "deny" } }, phase],
			undefined,
		],
		["attach a grant to the escalated lower phase", [{ ...lower, grantId: "grant-synthetic" }, phase], undefined],
		[
			"widen the Owner phase's bounds",
			[lower, { ...phase, binding: { ...ownerBinding, quantity: 5, upperHop: 13 } }],
			undefined,
		],
		["give the Owner phase a fresh request lifetime", [lower, { ...phase, expiresAt: now + 2 * 86400000 }], undefined],
		["reset the escalation count", [lower, { ...phase, upwardEscalations: 0 }], undefined],
		["clip the Owner context", [lower, { ...phase, context: { ...context, priorDecisions: [] } }], undefined],
		["move the notification keys", [lower, { ...phase, decisionNotificationKey: "synthetic-fresh-key" }], undefined],
		["drop the lower phase without its tombstone", [phase], undefined],
		["drop the lower phase under another request's tombstone", [phase], [tombstone(ownerBinding)]],
	];
	it.each(forgeries)("refuses to %s before prepare, with the files unchanged", async (_name, requests, tombstones) => {
		const t = await seeded();
		const journal = readFileSync(t.options.journalPath, "utf8");
		const words = readFileSync(t.options.legacyPath, "utf8");
		const id = identity("forged-history");
		const r = await t.store.transact(id, async (s) => rewrite(s, id, requests, tombstones));
		expect(r.state === "not_committed" && r.reason).toMatch(
			/^request history cannot (be rewritten|leave without its tombstone)$/,
		);
		expect(readFileSync(t.options.journalPath, "utf8")).toBe(journal);
		expect(readFileSync(t.options.legacyPath, "utf8")).toBe(words);
		const read = await t.store.read();
		if (read.state !== "ready") throw new Error("store fenced by a refused mutation");
		expect(read.value.requests).toEqual([lower, phase]);
	});
	it("#122 caps C: only a tombstone whose verified end has passed may leave; unknown or future ends never", async () => {
		const stone = (name: string, end: number | "source_horizon_unknown") => ({
			kind: "operation" as const,
			identityDigest: guardDigest({ name }),
			invalidThrough: end,
			lastTransactionId: null,
		});
		const unknownEnd = stone("unknown-end", "source_horizon_unknown");
		const passed = stone("passed", now);
		const future = stone("future", now + 1);
		const t = await fixture(undefined, false);
		expect((await t.store.initialize({ ...initial(), tombstones: [unknownEnd, passed, future] }, legacy())).state).toBe(
			"ready",
		);
		for (const [label, kept] of [
			["drop an unknown end", [passed, future]],
			["drop a future end", [unknownEnd, passed]],
		] as const) {
			const id = identity(`forget-${label}`);
			const r = await t.store.transact(id, async (s) => rewrite(s, id, [...s.requests], [...kept]));
			expect(r.state === "not_committed" && r.reason, label).toBe("replay tombstone cannot be reset");
		}
		const id = identity("forget-passed");
		expect((await t.store.transact(id, async (s) => rewrite(s, id, [...s.requests], [unknownEnd, future]))).state).toBe(
			"committed",
		);
		const read = await t.store.read();
		if (read.state !== "ready") throw new Error("store not ready");
		expect(read.value.tombstones).toEqual([unknownEnd, future]);
	});
	it("still commits the legitimate moves: first Owner answer, expiry, and whole-lineage pruning with tombstones", async () => {
		const t = await seeded();
		const decided = { ...phase, firstDecision: ownerDenial, state: "denied" as const };
		const first = identity("owner-denies");
		expect((await t.store.transact(first, async (s) => rewrite(s, first, [lower, decided]))).state).toBe("committed");
		const expire = identity("expire");
		const expired = [
			{ ...lower, state: "expired" as const },
			{ ...decided, state: "expired" as const },
		];
		expect((await t.store.transact(expire, async (s) => rewrite(s, expire, expired))).state).toBe("committed");
		const later = identity("later-owner-answer");
		const rewritten = await t.store.transact(later, async (s) =>
			rewrite(s, later, [expired[0], { ...expired[1], firstDecision: { ...ownerDenial, choice: "one_send" } }]),
		);
		expect(rewritten.state === "not_committed" && rewritten.reason).toBe("request history cannot be rewritten");
		const prune = identity("prune-lineage");
		expect(
			(
				await t.store.transact(prune, async (s) =>
					rewrite(s, prune, [], [...s.tombstones, tombstone(lowerBinding), tombstone(ownerBinding)]),
				)
			).state,
		).toBe("committed");
		const read = await t.store.read();
		if (read.state !== "ready") throw new Error("fixture");
		expect(read.value.requests).toHaveLength(0);
		expect(read.value.tombstones).toHaveLength(2);
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
