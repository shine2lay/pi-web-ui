// Ops #233 (H-GUARD-STORE-PERF-1, docs/guard-store-perf.md): the faster guard store writes exactly the bytes the
// old one wrote, gives the same answers and hands its callers the same values. Every store under test is paired
// with the reference copy of the old store (role-message-guard-store-reference.ts, the store as it was at 2efa5834)
// on a folder of its own. Each call goes to both; after each call their answers, the state each handed to the
// update, and journal.json and accepted.json byte for byte must be the same.
//   G1: test (a)'s worst-window sends through the real host (every 8th send by default; all 428 sends with
//       GUARD_STORE_GOLDEN=full, the one-time proof recorded in docs/guard-store-perf.md).
//   G2: both stores driven directly with awkward values a caller could hand them, refusals, crashes at each file
//       boundary, recovery, and files changed on disk.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	GuardAcceptedReceipt,
	GuardAtomicMutation,
	GuardCommitResult,
	GuardLegacyAcceptedMessage,
	GuardLookupResult,
	GuardOperationIdentity,
	GuardReadResult,
	GuardStorePort,
	GuardStoreState,
} from "../../server/role-message-guard-contract.js";
import { RoleMessageGuardHost } from "../../server/role-message-guard-host.js";
import {
	GuardFileStore,
	guardDigest,
	guardTransactionId,
	type GuardFileBoundary,
	type GuardFileStoreOptions,
	type GuardLegacyFile,
} from "../../server/role-message-guard-store.js";
import { useGuardWorld, world } from "./role-message-guard-host-harness.js";
import { GuardFileStore as ReferenceStore } from "./role-message-guard-store-reference.js";
import { replayWorstWindow } from "./role-message-guard-worst-window-replay.js";

useGuardWorld();

// ---- faithful copies and a strict comparison (key order, holes, -0, prototypes) ----

function copy<T>(value: T, seen = new Map<object, unknown>()): T {
	if (value === null || typeof value !== "object") return value;
	const known = seen.get(value);
	if (known !== undefined) return known as T;
	if (Array.isArray(value)) {
		const out: unknown[] = new Array(value.length);
		seen.set(value, out);
		for (let i = 0; i < value.length; i++) if (i in value) out[i] = copy(value[i], seen);
		return out as T;
	}
	if (value instanceof Date) {
		const out = new Date(value.getTime());
		seen.set(value, out);
		return out as T;
	}
	const out = Object.create(Object.getPrototypeOf(value) as object | null) as Record<PropertyKey, unknown>;
	seen.set(value, out);
	for (const key of Reflect.ownKeys(value)) {
		const d = Object.getOwnPropertyDescriptor(value, key)!;
		Object.defineProperty(
			out,
			key,
			"value" in d ? { value: copy(d.value, seen), enumerable: d.enumerable, writable: true, configurable: true } : d,
		);
	}
	return out as T;
}
function kind(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	if (typeof v !== "object") return typeof v;
	if (v instanceof Date) return "date";
	const proto = Object.getPrototypeOf(v) as object | null;
	return proto === Object.prototype ? "object" : proto === null ? "object(null)" : "object(other)";
}
/** The first difference between two values, or null: types, own key order, holes and Object.is on leaves. */
function difference(a: unknown, b: unknown, at = "$"): string | null {
	const [ka, kb] = [kind(a), kind(b)];
	if (ka !== kb) return `${at}: ${ka} vs ${kb}`;
	if (ka === "array") {
		const [x, y] = [a as unknown[], b as unknown[]];
		if (x.length !== y.length) return `${at}: length ${x.length} vs ${y.length}`;
		for (let i = 0; i < x.length; i++) {
			if (i in x !== i in y) return `${at}[${i}]: hole on one side`;
			const d = difference(x[i], y[i], `${at}[${i}]`);
			if (d) return d;
		}
		return null;
	}
	if (ka === "date") return (a as Date).getTime() === (b as Date).getTime() ? null : `${at}: dates differ`;
	if (ka.startsWith("object")) {
		const [x, y] = [Reflect.ownKeys(a as object), Reflect.ownKeys(b as object)];
		if (x.length !== y.length || x.some((k, i) => k !== y[i]))
			return `${at}: keys ${x.map(String).join(",")} vs ${y.map(String).join(",")}`;
		for (const k of x) {
			const d = difference(
				(a as Record<PropertyKey, unknown>)[k],
				(b as Record<PropertyKey, unknown>)[k],
				`${at}.${String(k)}`,
			);
			if (d) return d;
		}
		return null;
	}
	return Object.is(a, b) ? null : `${at}: ${String(a)} vs ${String(b)}`;
}

// ---- the pair: the store under test and the reference, call by call ----

interface Report {
	mismatches: string[];
	calls: Record<string, number>;
	updates: number;
	compared: number;
	inFlight: number;
	maxInFlight: number;
	largestJournal: number;
}
const report = (): Report => ({
	mismatches: [],
	calls: {},
	updates: 0,
	compared: 0,
	inFlight: 0,
	maxInFlight: 0,
	largestJournal: 0,
});
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
async function settle<T>(work: () => Promise<T>): Promise<Settled<T>> {
	try {
		return { ok: true, value: await work() };
	} catch (error) {
		return { ok: false, error };
	}
}
const errorText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
function read(path: string): Buffer | null {
	try {
		return readFileSync(path);
	} catch {
		return null;
	}
}
const leftovers = (path: string) => readdirSync(dirname(path)).filter((n) => n.endsWith(".tmp"));

class Pair implements GuardStorePort {
	constructor(
		readonly live: GuardFileStore,
		readonly reference: ReferenceStore,
		readonly liveOptions: GuardFileStoreOptions,
		readonly referenceOptions: GuardFileStoreOptions,
		readonly r: Report,
	) {}
	private mismatch(text: string): void {
		if (this.r.mismatches.length < 20) this.r.mismatches.push(text);
	}
	private files(what: string): void {
		this.r.compared++;
		for (const [name, a, b] of [
			["journal", this.referenceOptions.journalPath, this.liveOptions.journalPath],
			["legacy", this.referenceOptions.legacyPath, this.liveOptions.legacyPath],
		] as const) {
			const [x, y] = [read(a), read(b)];
			if (name === "journal") this.r.largestJournal = Math.max(this.r.largestJournal, y?.length ?? 0);
			if (x === null || y === null ? x !== y : !x.equals(y))
				this.mismatch(`${what}: ${name} file differs (${x?.length ?? "none"} vs ${y?.length ?? "none"} bytes)`);
		}
		const left = [...leftovers(this.referenceOptions.journalPath), ...leftovers(this.liveOptions.journalPath)];
		if (left.length) this.mismatch(`${what}: temporary files left: ${left.join(", ")}`);
	}
	private async both<T>(what: string, first: () => Promise<T>, second: () => Promise<T>, liveFirst = false) {
		this.r.calls[what] = (this.r.calls[what] ?? 0) + 1;
		this.r.maxInFlight = Math.max(this.r.maxInFlight, ++this.r.inFlight);
		try {
			const a = await settle(first);
			const b = await settle(second);
			const [ref, live] = liveFirst ? [b, a] : [a, b];
			if (ref.ok !== live.ok)
				this.mismatch(
					`${what}: ${ref.ok ? "answered" : `threw ${errorText(ref.error)}`} vs ${live.ok ? "answered" : `threw ${errorText(live.error)}`}`,
				);
			else if (!ref.ok && !live.ok && errorText(ref.error) !== errorText(live.error))
				this.mismatch(`${what}: threw ${errorText(ref.error)} vs ${errorText(live.error)}`);
			else if (ref.ok && live.ok) {
				const d = difference(ref.value, live.value);
				if (d) this.mismatch(`${what} answer: ${d}`);
			}
			this.files(what);
			if (!live.ok) throw live.error;
			return live.value;
		} finally {
			this.r.inFlight--;
		}
	}
	initialize(state: GuardStoreState, legacy: GuardLegacyFile): Promise<GuardReadResult> {
		return this.both(
			"initialize",
			() => this.reference.initialize(copy(state), copy(legacy)),
			() => this.live.initialize(state, legacy),
		);
	}
	read(): Promise<GuardReadResult> {
		return this.both(
			"read",
			() => this.reference.read(),
			() => this.live.read(),
		);
	}
	recover(): Promise<GuardReadResult> {
		return this.both(
			"recover",
			() => this.reference.recover(),
			() => this.live.recover(),
		);
	}
	lookup(identity: GuardOperationIdentity): Promise<GuardLookupResult> {
		return this.both(
			"lookup",
			() => this.reference.lookup(copy(identity)),
			() => this.live.lookup(identity),
		);
	}
	/** The update runs once, on the store under test; the reference gets a faithful copy of what it returned. */
	transact(
		identity: GuardOperationIdentity,
		update: (current: GuardStoreState) => Promise<GuardAtomicMutation>,
	): Promise<GuardCommitResult> {
		let seen: { current: GuardStoreState; outcome: Settled<GuardAtomicMutation> } | null = null;
		return this.both(
			"transact",
			() =>
				this.live.transact(identity, async (current) => {
					this.r.updates++;
					const snapshot = copy(current);
					const outcome = await settle(() => update(current));
					seen = { current: snapshot, outcome: outcome.ok ? { ok: true, value: copy(outcome.value) } : outcome };
					if (!outcome.ok) throw outcome.error;
					return outcome.value;
				}),
			() =>
				this.reference.transact(copy(identity), async (current) => {
					if (!seen) {
						this.mismatch("transact: only the reference ran the update");
						throw new Error("golden: update not run by the store under test");
					}
					const d = difference(current, seen.current);
					if (d) this.mismatch(`transact: state handed to the update: ${d}`);
					const outcome = seen.outcome;
					seen = null;
					if (!outcome.ok) throw outcome.error;
					return copy(outcome.value);
				}),
			true,
		).finally(() => {
			if (seen) this.mismatch("transact: only the store under test ran the update");
		});
	}
}
function referenceOptions(live: GuardFileStoreOptions, folder: string): GuardFileStoreOptions {
	return {
		...live,
		journalPath: join(folder, basename(live.journalPath)),
		legacyPath: join(folder, basename(live.legacyPath)),
		withExclusive: (work) => work(),
	};
}

// ---- G1: test (a)'s sends through the real host ----

const folders: string[] = [];
const folder = (prefix: string) => {
	const f = mkdtempSync(join(tmpdir(), prefix));
	folders.push(f);
	return f;
};
afterEach(() => {
	for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true });
});

describe("H-GUARD-STORE-PERF-1 golden: the guard store writes what the old store wrote", () => {
	const full = process.env.GUARD_STORE_GOLDEN === "full";
	let r = report();
	beforeEach(() => {
		r = report();
		type HostStores = { newStore(dir: string): GuardFileStore };
		const proto = RoleMessageGuardHost.prototype as unknown as HostStores;
		const original = proto.newStore;
		vi.spyOn(proto, "newStore").mockImplementation(function (this: HostStores, dir: string) {
			const live = original.call(this, dir);
			const liveOptions = (live as unknown as { options: GuardFileStoreOptions }).options;
			const refOptions = referenceOptions(liveOptions, folder("rmguard-golden-"));
			return new Pair(live, new ReferenceStore(refOptions), liveOptions, refOptions, r) as unknown as GuardFileStore;
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it(`G1: test (a)'s worst-window sends (${full ? "all of them" : "every 8th"}): same answers, states and bytes after every call`, async () => {
		const w = await world();
		const sent = await replayWorstWindow(w, { stride: full ? 1 : 8 });
		const summary = { sent, ...r };
		if (process.env.GUARD_STORE_GOLDEN_OUT) writeFileSync(process.env.GUARD_STORE_GOLDEN_OUT, JSON.stringify(summary));
		expect(r.mismatches).toEqual([]);
		expect(sent).toBe(full ? 428 : 54);
		expect(r.calls.initialize).toBe(1);
		expect(r.calls.transact).toBeGreaterThan(sent);
		expect(r.updates).toBeGreaterThan(sent);
		expect(r.maxInFlight).toBe(1); // calls never overlapped, so every file comparison saw a settled pair
		expect(r.largestJournal).toBeGreaterThan(full ? 4_000_000 : 300_000);
		expect(w.logs.filter((l) => l.includes("guard store generation"))).toHaveLength(0);
	}, 3_600_000);
});

// ---- G2: the stores driven directly ----

const now = 2000000000;
const initial = (): GuardStoreState => ({
	version: "role-message-guard/v1",
	revision: "golden-v1",
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
			sessionFile: "/golden/alpha.jsonl",
			sessionId: "golden-alpha",
			runtimeIncarnation: "golden-runtime",
			task: { kind: "home" },
			currentHome: true,
			identityRevision: "golden-v1",
		},
	};
}
function message(id: string, extra: Record<string, unknown> = {}): GuardLegacyAcceptedMessage {
	return {
		id,
		at: now,
		from: { role: "alpha", title: "Alpha", chat: "golden home", file: "/golden/alpha.jsonl" },
		to: { role: "beta", title: "Beta" },
		kind: "fyi",
		text: 'Exact golden words — 中文 \u2028 "quoted"',
		chain: 1,
		state: "waiting",
		sends: 0,
		attempts: 0,
		forOwner: true,
		ownerIds: ["golden-owner-id"],
		ownerChannel: "telegram",
		initiative: "golden-initiative",
		...extra,
	} as GuardLegacyAcceptedMessage;
}
/** An accepted send, as the core builds one (the store test's shape); `shape` bends the parts a caller controls. */
function accepted(
	state: GuardStoreState,
	id: GuardOperationIdentity,
	record: GuardLegacyAcceptedMessage,
	shape: (m: GuardAtomicMutation) => GuardAtomicMutation = (m) => m,
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
			anchorId: "golden-boundary",
			incomingRecordId: "golden-incoming",
			incomingHash: "golden-word-digest",
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
	return shape({
		next: {
			...state,
			revision: `golden-revision-${id.operationId}`,
			outbox: [
				...state.outbox,
				{ receipt, message: record, state: "committed", wakeState: "not_requested", lastEvidence: null },
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
		legacyAccepted: [record],
		result,
	});
}
/** Plain JSON objects with their keys written in the reverse order, all the way down. */
function reversed<T>(value: T): T {
	if (Array.isArray(value)) return value.map(reversed) as T;
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.reverse()
				.map(([k, v]) => [k, reversed(v)]),
		) as T;
	return value;
}
function pair(r: Report, maximumBytes = 32 * 1024 * 1024, fault: { at: GuardFileBoundary | null } = { at: null }) {
	const dir = folder("guard-golden-live-");
	let tail: Promise<unknown> = Promise.resolve();
	const options: GuardFileStoreOptions = {
		journalPath: join(dir, "guard-journal.json"),
		legacyPath: join(dir, "role-messages.json"),
		maximumBytes,
		withExclusive: <T>(work: () => Promise<T>): Promise<T> => {
			const run = tail.then(work, work);
			tail = run.catch(() => {});
			return run;
		},
		boundary: (point) => {
			if (fault.at === point) throw new Error(`golden fault:${point}`);
		},
	};
	const refOptions = referenceOptions(options, folder("guard-golden-reference-"));
	const open = () => new Pair(new GuardFileStore(options), new ReferenceStore(refOptions), options, refOptions, r);
	return { open, options, refOptions, fault };
}

describe("H-GUARD-STORE-PERF-1 golden: awkward values, refusals, crashes and changed files", () => {
	it("G2a: ordinary sends, reads, lookups and a second store over the same files", async () => {
		const r = report();
		const p = pair(r);
		const store = p.open();
		expect((await store.initialize(initial(), { v: 1, paused: false, messages: [] })).state).toBe("ready");
		for (let i = 1; i <= 6; i++) {
			const id = identity(`op-${i}`);
			const result = await store.transact(id, async (current) => accepted(current, id, message(`rm-${i}`)));
			expect(result.state).toBe("committed");
			await store.read();
			await store.lookup(id);
		}
		await store.lookup(identity("op-unknown"));
		// The same operation again: answered from the journal without running the update.
		await store.transact(identity("op-3"), async () => {
			throw new Error("must not run");
		});
		const again = p.open();
		expect((await again.recover()).state).toBe("ready");
		const id = identity("op-7");
		expect((await again.transact(id, async (c) => accepted(c, id, message("rm-7")))).state).toBe("committed");
		await again.read();
		expect(r.mismatches).toEqual([]);
		expect(r.updates).toBe(7);
	});

	it("G2b: keys in any order, index-like keys, -0, Date, own __proto__, lone surrogates, shared objects", async () => {
		const r = report();
		const store = pair(r).open();
		await store.initialize(initial(), { v: 1, paused: false, messages: [] });
		const proto = JSON.parse('{"__proto__": {"x": 1}, "plain": true}') as Record<string, unknown>;
		const cases: Array<[string, (c: GuardStoreState, id: GuardOperationIdentity) => GuardAtomicMutation]> = [
			["reversed keys", (c, id) => reversed(accepted(c, id, message("rm-rev")))],
			[
				"index-like keys",
				(c, id) => accepted(c, id, message("rm-idx", { meta: { "10": 1, "2": 2, b: 3, a: 4, "01": 5 } })),
			],
			["minus zero", (c, id) => accepted(c, id, message("rm-zero", { meta: { z: -0, list: [-0, 0] } }))],
			["a Date", (c, id) => accepted(c, id, message("rm-date", { meta: { when: new Date(now) } }))],
			["own __proto__", (c, id) => accepted(c, id, message("rm-proto", { meta: proto }))],
			["lone surrogate", (c, id) => accepted(c, id, message("rm-lone", { text: "half \ud800 pair \udc00 end" }))],
			[
				"one object twice",
				(c, id) => {
					const record = message("rm-shared");
					const m = accepted(c, id, record);
					return { ...m, next: { ...m.next, audits: [...m.next.audits, m.next.audits.at(-1)!] } };
				},
			],
			[
				"items reordered",
				(c, id) => {
					const m = accepted(c, id, message("rm-order"));
					return {
						...m,
						next: { ...m.next, audits: [...m.next.audits].reverse(), usage: [...m.next.usage].reverse() },
					};
				},
			],
			["undefined value", (c, id) => accepted(c, id, message("rm-undef", { meta: { gone: undefined } }))],
			["a hole", (c, id) => accepted(c, id, message("rm-hole", { ownerIds: [, "x"] }))],
			["unknown kind", (c, id) => accepted(c, id, message("rm-kind", { kind: "shout" }))],
			[
				"result throws",
				() => {
					throw new Error("golden refusal");
				},
			],
		];
		for (const [name, make] of cases) {
			const id = identity(`op-${name}`);
			await store.transact(id, async (current) => make(current, id));
			await store.read();
			await store.lookup(id);
			expect(r.mismatches, name).toEqual([]);
		}
		expect(r.calls.transact).toBe(cases.length);
	});

	it("G2c: the size cap refuses the same send in both", async () => {
		const r = report();
		const store = pair(r, 9000).open();
		await store.initialize(initial(), { v: 1, paused: false, messages: [] });
		for (let i = 1; i <= 4; i++) {
			const id = identity(`op-cap-${i}`);
			await store.transact(id, async (c) => accepted(c, id, message(`rm-cap-${i}`, { text: "y".repeat(1500) })));
		}
		expect(r.mismatches).toEqual([]);
		expect(r.calls.transact).toBe(4);
	});

	it("G2d: a crash at each file boundary, then recovery by a fresh store, the same in both", async () => {
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
		for (const at of boundaries) {
			const r = report();
			const p = pair(r);
			const store = p.open();
			await store.initialize(initial(), { v: 1, paused: false, messages: [] });
			const first = identity("op-before");
			await store.transact(first, async (c) => accepted(c, first, message("rm-before")));
			p.fault.at = at;
			const id = identity("op-crash");
			await store.transact(id, async (c) => accepted(c, id, message("rm-crash")));
			await store.read();
			p.fault.at = null;
			const fresh = p.open();
			await fresh.recover();
			await fresh.read();
			await fresh.lookup(id);
			const next = identity("op-after");
			await fresh.transact(next, async (c) => accepted(c, next, message("rm-after")));
			expect(r.mismatches, at).toEqual([]);
		}
	});

	it("G2e: files changed on disk are refused the same way", async () => {
		const r = report();
		const p = pair(r);
		const store = p.open();
		await store.initialize(initial(), { v: 1, paused: false, messages: [] });
		for (let i = 1; i <= 3; i++) {
			const id = identity(`op-disk-${i}`);
			await store.transact(id, async (c) => accepted(c, id, message(`rm-disk-${i}`)));
		}
		await store.read();
		const write = (path: string, text: string) => writeFileSync(path, text);
		const both = (pick: (o: GuardFileStoreOptions) => string, change: (text: string) => string) => {
			for (const o of [p.options, p.refOptions]) write(pick(o), change(readFileSync(pick(o), "utf8")));
		};
		// The words of an accepted message changed in the canonical file.
		both(
			(o) => o.legacyPath,
			(t) => t.replace("rm-disk-2", "rm-disk-9"),
		);
		await store.read();
		await store.transact(identity("op-disk-4"), async (c) => accepted(c, identity("op-disk-4"), message("rm-disk-4")));
		both(
			(o) => o.legacyPath,
			(t) => t.replace("rm-disk-9", "rm-disk-2"),
		);
		await store.read();
		// One character of the journal changed (its checksum no longer fits).
		both(
			(o) => o.journalPath,
			(t) => t.replace("golden-revision-op-disk-3", "golden-revision-op-disk-X"),
		);
		await store.read();
		await store.lookup(identity("op-disk-1"));
		await p.open().recover();
		// The journal put back as it was: the same text reads as before.
		both(
			(o) => o.journalPath,
			(t) => t.replace("golden-revision-op-disk-X", "golden-revision-op-disk-3"),
		);
		await store.read();
		await p.open().recover();
		expect(r.mismatches).toEqual([]);
	});
});
