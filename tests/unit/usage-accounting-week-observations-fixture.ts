// Ops #500: the worker side of tests/unit/usage-accounting-week-observations.test.ts. The week store does its file
// work synchronously and refuses the main thread (worker-required), so, as in B2's own fixture, each case runs in a
// worker and returns what the test compares. Every row below is a literal: verified, unresolved and no-responseId
// facts, an alias, a revision, allocations, a root, a policy, a membership, a run snapshot, a coverage row and role
// witnesses, so each expected replay is known without running the store. Nothing is mocked but the clock and the
// named crash points, and no chat file is read.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	closeSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type {
	Allocation,
	DispatchRoot,
	IdentityAlias,
	ReportingPolicy,
	RunSnapshot,
	SourceCoverage,
	TaskMembership,
	UsageFact,
} from "../../server/usage-accounting-contract.js";
import {
	USAGE_WEEK_DIRECTORY,
	UsageWeekStore,
	UsageWeekStoreError,
	type UsageWeekCoverage,
	type UsageWeekCursors,
	type UsageWeekFactRole,
	type UsageWeekLoad,
	type UsageWeekObservation,
	type UsageWeekObservationCoverage,
	type UsageWeekObservationInput,
	type UsageWeekPoint,
	type UsageWeekReceipt,
	type UsageWeekRecord,
	type UsageWeekReplayCursor,
	type UsageWeekStoreOptions,
} from "../../server/usage-accounting-week-store.js";

const data = workerData as { caseName: string; dir: string; lease: SharedArrayBuffer; extra: Record<string, unknown> };
const variant = String(data.extra.variant ?? "");
const W = "2026-10-19";
const DURING = Date.parse("2026-10-23T12:00:00.000Z"),
	AFTER = Date.parse("2026-10-26T07:10:00.000Z");
const PARTIAL: UsageWeekCoverage = { state: "partial", gaps: [{ code: "line-limit", count: 1 }] };
let clock = DURING;
const stores = new Set<UsageWeekStore>();

function open(o: Partial<UsageWeekStoreOptions> = {}, dir = data.dir, lease = data.lease): UsageWeekStore {
	const s = UsageWeekStore.open({ dataDir: dir, lease, now: () => clock, ...o });
	stores.add(s);
	return s;
}
function shut(s: UsageWeekStore): void {
	s.close();
	stores.delete(s);
}
function reopen(s: UsageWeekStore, o: Partial<UsageWeekStoreOptions> = {}, dir = data.dir, lease = data.lease) {
	shut(s);
	return open(o, dir, lease);
}
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const file = (kind: string, dir = data.dir) => join(dir, USAGE_WEEK_DIRECTORY, `week-${W}.${kind}`);
const bytes = (kind: string, dir = data.dir) =>
	existsSync(file(kind, dir)) ? readFileSync(file(kind, dir), "latin1") : null;
const KINDS = ["log", "receipts", "observations", "checkpoint", "sealed", "adjust"] as const;
/** Every week file's sha256 (null when absent). */
function weekFiles(dir = data.dir): Record<string, string | null> {
	return Object.fromEntries(KINDS.map((k) => [k, existsSync(file(k, dir)) ? sha(readFileSync(file(k, dir))) : null]));
}
function codeOf(fn: () => unknown): string {
	try {
		fn();
		return "no-error";
	} catch (error) {
		if (error instanceof UsageWeekStoreError) return error.code;
		throw error;
	}
}
/** Sorted-key JSON, written here apart from the store's, so an expected line is built without the store. */
function canonical(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
	if (v !== null && typeof v === "object")
		return `{${Object.keys(v)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	return JSON.stringify(v);
}
/** The documented key: sha256 of [kind, row], a fact's source.observedAt (when it was read) left out. */
function keyOf(x: { o: string; r: unknown }): string {
	const row =
		x.o === "fact" ? { ...(x.r as UsageFact), source: { ...(x.r as UsageFact).source, observedAt: null } } : x.r;
	return sha(canonical([x.o, row]));
}
/** The documented line: k, o, p, rk, then the row with sorted keys. */
function lineOf(x: UsageWeekObservationInput, p: "open" | "late"): string {
	const rk = x.rk === null ? "null" : `"${x.rk}"`;
	return `{"k":"${keyOf(x)}","o":"${x.o}","p":"${p}","rk":${rk},"r":${canonical(x.r)}}\n`;
}
const OBS_HEADER = `{"v":"usage-week-observations/1","week":"${W}","kind":"observations"}\n`;
function expected(rows: readonly UsageWeekObservationInput[], p: "open" | "late"): UsageWeekObservation[] {
	return rows.map((x) => ({ ...x, k: keyOf(x), p }) as UsageWeekObservation);
}

// The literal rows. Facts are the contract's UsageFact exactly as a reader hands them over: a verified pi call keyed
// by its responseId, a verified compaction without one, an unresolved fork entry whose provider and model are
// unknown, the fork's copy of the first call (an alias), a temper delegate call with its revision, and a late acp call.
const RESPONSE_1 = "response:5d3c1f0e9b8a7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605f4";
const RESPONSE_4 = "response:a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const F1: UsageFact = {
	v: "usage-fact/1",
	id: '["usage-fact/1","pi","session-7f3a","response:5d3c1f0e9b8a7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605f4"]',
	revision: 0,
	supersedes: null,
	identity: { producer: "pi", incarnation: "session-7f3a", attempt: RESPONSE_1 },
	identityStatus: "verified",
	occurredAt: "2026-10-20T15:04:05.123Z",
	provider: "anthropic",
	model: "claude-opus-4-5",
	kind: "assistant",
	tokens: { input: 1200, output: 340, cacheRead: 52000, cacheWrite: 800 },
	prices: [
		{ basis: "list-estimate", currency: "USD", amount: "0.41235", status: "known", rateVersion: "pi-recorded-1" },
	],
	source: {
		stream: "pi-session:7f3a",
		event: "entry-0001",
		observedAt: "2026-10-20T15:04:06.000Z",
		coverage: "complete",
	},
	links: { task: null, session: "session-7f3a", run: null },
};
const F2: UsageFact = {
	v: "usage-fact/1",
	id: '["usage-fact/1","pi","session-7f3a","entry-0002"]',
	revision: 0,
	supersedes: null,
	identity: { producer: "pi", incarnation: "session-7f3a", attempt: "entry-0002" },
	identityStatus: "verified",
	occurredAt: "2026-10-20T15:09:00.000Z",
	provider: "anthropic",
	model: "claude-opus-4-5",
	kind: "compaction",
	tokens: { input: 9000, output: 1500, cacheRead: null, cacheWrite: null },
	prices: [{ basis: "list-estimate", currency: "USD", amount: null, status: "unpriced", rateVersion: null }],
	source: {
		stream: "pi-session:7f3a",
		event: "entry-0002",
		observedAt: "2026-10-20T15:09:01.000Z",
		coverage: "complete",
	},
	links: { task: null, session: "session-7f3a", run: null },
};
const F3: UsageFact = {
	v: "usage-fact/1",
	id: '["usage-fact/1","pi","session-91c2","entry-0003"]',
	revision: 0,
	supersedes: null,
	identity: { producer: "pi", incarnation: "session-91c2", attempt: "entry-0003" },
	identityStatus: "unresolved",
	occurredAt: "2026-10-21T09:30:00.000Z",
	provider: "unknown",
	model: "unknown",
	kind: "assistant",
	tokens: { input: 800, output: null, cacheRead: null, cacheWrite: null },
	prices: [{ basis: "list-estimate", currency: "USD", amount: null, status: "unknown-model", rateVersion: null }],
	source: {
		stream: "pi-session:91c2",
		event: "entry-0003",
		observedAt: "2026-10-21T09:30:02.000Z",
		coverage: "complete",
	},
	links: { task: null, session: "session-91c2", run: null },
};
const F4: UsageFact = {
	v: "usage-fact/1",
	id: '["usage-fact/1","pi","session-91c2","response:a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"]',
	revision: 0,
	supersedes: null,
	identity: { producer: "pi", incarnation: "session-91c2", attempt: RESPONSE_4 },
	identityStatus: "verified",
	occurredAt: "2026-10-20T15:04:05.123Z",
	provider: "anthropic",
	model: "claude-opus-4-5",
	kind: "assistant",
	tokens: { input: 1200, output: 340, cacheRead: 52000, cacheWrite: 800 },
	prices: [
		{ basis: "list-estimate", currency: "USD", amount: "0.41235", status: "known", rateVersion: "pi-recorded-1" },
	],
	source: {
		stream: "pi-session:91c2",
		event: "entry-0001",
		observedAt: "2026-10-21T09:29:58.000Z",
		coverage: "complete",
	},
	links: { task: null, session: "session-7f3a", run: null },
};
const M: TaskMembership = {
	queue: "ops",
	task: 500,
	addedAt: "2026-10-19T08:00:00.000Z",
	project: "automatic-cost-accounting",
	initiative: null,
	effectiveAt: "2026-10-19T08:00:00.000Z",
};
const F5: UsageFact = {
	v: "usage-fact/1",
	id: '["usage-fact/1","temper","temper-dev-1","run-42:attempt-1"]',
	revision: 0,
	supersedes: null,
	identity: { producer: "temper", incarnation: "temper-dev-1", attempt: "run-42:attempt-1" },
	identityStatus: "verified",
	occurredAt: "2026-10-22T18:00:00.000Z",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	kind: "delegate",
	tokens: { input: 20000, output: 4000, cacheRead: 0, cacheWrite: 0 },
	prices: [
		{ basis: "list-estimate", currency: "USD", amount: "0.12", status: "known", rateVersion: "anthropic-list/2026-10" },
	],
	source: {
		stream: "temper-ledger",
		event: "run-42:attempt-1:0",
		observedAt: "2026-10-22T18:00:01.000Z",
		coverage: "complete",
	},
	links: { task: M, session: null, run: "run-42" },
};
const F5R1: UsageFact = {
	...F5,
	revision: 1,
	supersedes: 0,
	tokens: { input: 20000, output: 4100, cacheRead: 0, cacheWrite: 0 },
	prices: [
		{
			basis: "list-estimate",
			currency: "USD",
			amount: "0.1215",
			status: "known",
			rateVersion: "anthropic-list/2026-10",
		},
	],
	source: {
		stream: "temper-ledger",
		event: "run-42:attempt-1:1",
		observedAt: "2026-10-22T18:30:00.000Z",
		coverage: "complete",
	},
};
const F6: UsageFact = {
	v: "usage-fact/1",
	id: '["usage-fact/1","acp","acp-session-5","entry-0009"]',
	revision: 0,
	supersedes: null,
	identity: { producer: "acp", incarnation: "acp-session-5", attempt: "entry-0009" },
	identityStatus: "verified",
	occurredAt: "2026-10-23T11:00:00.000Z",
	provider: "anthropic",
	model: "claude-haiku-4-5",
	kind: "cache-warm",
	tokens: { input: 10, output: 1, cacheRead: 90000, cacheWrite: null },
	prices: [
		{
			basis: "list-estimate",
			currency: "USD",
			amount: "0.009",
			status: "known",
			rateVersion: "anthropic-list/2026-10",
		},
	],
	source: { stream: "acp-session:5", event: "entry-0009", observedAt: "2026-10-23T11:00:04.000Z", coverage: "partial" },
	links: { task: null, session: "acp-session-5", run: null },
};
const L4: IdentityAlias = {
	aliasFactId: F4.id,
	canonicalFactId: F1.id,
	provenance: "native-call-map/1",
	evidenceRef: "pi-session-map:91c2-entry-0001",
};
const ROOT: DispatchRoot = {
	ref: "root:ops-500",
	scopeRef: "queue:ops/500",
	scope: "requested",
	occurredAt: "2026-10-22T17:59:00.000Z",
	policyRef: null,
	payerRole: "ops",
	provenance: "trusted-native/1",
	evidenceRef: "temper-dispatch:run-42",
};
const A1: Allocation = {
	v: "allocation/1",
	factId: F5.id,
	revision: 0,
	supersedes: null,
	rootRef: "root:ops-500",
	scope: "requested",
	policyRef: null,
	payerRole: "ops",
	recordedAt: "2026-10-22T18:00:02.000Z",
	reason: "native-root",
};
// The unresolved fork entry has no root: its allocation says unknown, and names no payer.
const A2: Allocation = {
	v: "allocation/1",
	factId: F3.id,
	revision: 0,
	supersedes: null,
	rootRef: null,
	scope: "unknown",
	policyRef: null,
	payerRole: null,
	recordedAt: "2026-10-21T09:30:03.000Z",
	reason: "missing-root",
};
const SNAP: RunSnapshot = {
	producer: "temper",
	incarnation: "temper-dev-1",
	run: "run-42",
	observedAt: "2026-10-22T18:05:00.000Z",
	state: "ended",
	price: {
		basis: "list-estimate",
		currency: "USD",
		amount: "0.12",
		status: "known",
		rateVersion: "anthropic-list/2026-10",
	},
	coveredFactIds: [F5.id],
	coverage: "complete",
};
const POLICY: ReportingPolicy = {
	ref: "policy:design-weekly",
	role: "design",
	scopeRef: "role:design",
	effectiveAt: "2026-10-12T07:00:00.000Z",
	weeklyUsd: "2000",
	basis: "list-estimate",
	timeZone: "America/Los_Angeles",
	sourceRef: "bp-b7f97619",
};
const COV: SourceCoverage = {
	stream: "pi-session:91c2",
	from: "2026-10-21T09:00:00.000Z",
	through: "2026-10-21T10:00:00.000Z",
	observedAt: "2026-10-21T10:00:05.000Z",
	status: "partial",
};
const W1: UsageWeekFactRole = { factId: F1.id, role: "ops", evidenceRef: "queue-task:ops/500" };
const W2: UsageWeekFactRole = { factId: F2.id, role: null, evidenceRef: "pi-session-map:7f3a-entry-0002" };
const W3: UsageWeekFactRole = { factId: F6.id, role: "design", evidenceRef: "acp-session-map:5-entry-0009" };

// The numeric records B3 decides for the same attempts (B2's format, unchanged): the unverified attempt and the gap
// have no fact, so no fact is written for them.
const OPS = {
	role: "ops",
	project: "automatic-cost-accounting",
	initiative: null,
	task: { q: sha("fixture-queue:ops"), n: 500, at: "2026-10-19T08:00:00.000Z" },
};
const DESIGN = { role: "design", project: null, initiative: "design-in-temper", task: null };
function rec(
	i: number,
	d: UsageWeekRecord["d"],
	at: string,
	usd: string | null,
	tok: UsageWeekRecord["tok"],
	rate: string | null,
	sub: UsageWeekRecord["sub"] = OPS,
): UsageWeekRecord {
	return {
		k: sha(`obs-attempt:${i}`),
		d,
		at,
		src: sha(`obs-source:${i % 3}`).slice(0, 16),
		off: i * 1013,
		len: 600 + i,
		sub,
		usd,
		tok,
		rate,
	};
}
const R1 = rec(1, "original", F1.occurredAt, "0.412350000000", [1200, 340, 52000, 800], "pi-recorded-1");
const R2 = rec(2, "original", F2.occurredAt, null, [9000, 1500, null, null], null);
const R3 = rec(3, "unresolved", F3.occurredAt, null, [800, null, null, null], null, DESIGN);
const R4 = rec(4, "alias", F4.occurredAt, "0.412350000000", [1200, 340, 52000, 800], "pi-recorded-1");
const R5 = rec(5, "unverified", "2026-10-21T11:00:00.000Z", null, [null, null, null, null], null, DESIGN);
const R6 = { ...rec(6, "gap", "2026-10-21T12:00:00.000Z", null, [null, null, null, null], null, DESIGN), len: 4096 };
const R7 = rec(7, "original", F5.occurredAt, "0.120000000000", [20000, 4000, 0, 0], "anthropic-list/2026-10");
const R8 = rec(8, "original", F6.occurredAt, "0.009000000000", [10, 1, 90000, null], "anthropic-list/2026-10");
const RECORDS = [R1, R2, R3, R4, R5, R6, R7];
const RESPONSE_ID_1 = "msg_01Fq7XyZ3a9B";
// W2's same-call receipt for the first call, B2's format, unchanged.
const SAME_CALL_1: UsageWeekReceipt = {
	kind: "same-call",
	k: sha(JSON.stringify(["anthropic", RESPONSE_ID_1])),
	r: { provider: "anthropic", responseId: RESPONSE_ID_1, canonical: F1, evidenceRef: "native-response-map/1" },
};
const O = {
	f1: { o: "fact", r: F1, rk: R1.k },
	w1: { o: "fact-role", r: W1, rk: R1.k },
	f2: { o: "fact", r: F2, rk: R2.k },
	w2: { o: "fact-role", r: W2, rk: null },
	f3: { o: "fact", r: F3, rk: R3.k },
	a2: { o: "allocation", r: A2, rk: R3.k },
	f4: { o: "fact", r: F4, rk: R4.k },
	l4: { o: "alias", r: L4, rk: R4.k },
	m: { o: "membership", r: M, rk: null },
	root: { o: "root", r: ROOT, rk: null },
	f5: { o: "fact", r: F5, rk: R7.k },
	a1: { o: "allocation", r: A1, rk: R7.k },
	snap: { o: "snapshot", r: SNAP, rk: null },
	policy: { o: "policy", r: POLICY, rk: null },
	cov: { o: "coverage", r: COV, rk: null },
	f5r1: { o: "fact", r: F5R1, rk: R7.k },
	f6: { o: "fact", r: F6, rk: R8.k },
	w3: { o: "fact-role", r: W3, rk: R8.k },
} satisfies Record<string, UsageWeekObservationInput>;
const ALL: UsageWeekObservationInput[] = [
	O.f1,
	O.w1,
	O.f2,
	O.w2,
	O.f3,
	O.a2,
	O.f4,
	O.l4,
	O.m,
	O.root,
	O.f5,
	O.a1,
	O.snap,
	O.policy,
	O.cov,
];
const NAME = new Map<unknown, string>(Object.entries(O).map(([name, x]) => [x, name]));

function cursors(n: number): UsageWeekCursors {
	return {
		files: {
			[sha("fixture-source:0").slice(0, 16)]: {
				cursor: {
					ordinal: n,
					token: `pi1:${n * 400}:${n * 400 - 400}:400:${sha(`fixture-line:${n}`)}:${sha("fixture-h")}`,
				},
				size: n * 400,
				mtimeMs: 1_792_700_000_000 + n,
			},
			[sha("fixture-source:1").slice(0, 16)]: { cursor: null, size: 0, mtimeMs: 1_792_700_000_000 },
		},
		ledger: {
			kind: "file",
			stream: "fixture-ledger",
			incarnation: "fixture-ledger-incarnation",
			ordinal: n,
			byte: 100 + n * 50,
			line: n,
			headerSha256: sha("fixture-ledger-header"),
			anchor: { start: 50 + n * 50, bytes: 50, sha256: sha(`fixture-ledger-line:${n}`) },
		},
	};
}
const pick = (x: object) => {
	const r = x as Record<string, unknown>;
	return {
		appended: r.appended ?? r.added,
		duplicates: r.duplicates,
		observations: r.observations,
		observationDuplicates: r.observationDuplicates,
		unobserved: r.unobserved,
	};
};

/** Every page of one replay stream, `rows` at a time; each page's coverage must be the first page's. */
function replayAll(s: UsageWeekStore, rows?: number) {
	const out: UsageWeekObservation[] = [],
		pages: number[] = [];
	let page = s.observations(W, null, rows);
	const coverage = page.coverage;
	for (;;) {
		out.push(...page.observations);
		pages.push(page.observations.length);
		assert.deepEqual(page.coverage, coverage);
		if (page.next === null) break;
		assert(pages.length <= 1_100_000, "replay does not end");
		page = s.observations(W, page.next, rows);
	}
	return { rows: out, pages, coverage };
}
function reloadAll(s: UsageWeekStore) {
	const records: string[] = [];
	const load = s.reload(W, (r, from) => {
		records.push(`${from}:${r.d}:${r.k.slice(0, 8)}`);
	});
	return { load, records };
}
interface WeekView {
	load: UsageWeekLoad;
	records: string[];
	rows?: UsageWeekObservation[];
	coverage?: UsageWeekObservationCoverage;
}
/** A week as reload and replay give it back. */
function weekView(s: UsageWeekStore): WeekView {
	const { load, records } = reloadAll(s);
	if (load.state === "unavailable") return { load, records };
	const replay = replayAll(s);
	return { load, records, rows: replay.rows, coverage: replay.coverage };
}
/** The view without what reload cut off; an open week with no checkpoint has nothing committed, as an empty one. */
function committedView(v: WeekView) {
	let load: unknown = v.load;
	if (v.load.state === "open" && v.load.checkpoint === null) {
		assert.equal(v.load.records + v.load.receipts, 0);
		load = { state: "empty", week: W };
	} else if ("dropped" in v.load) load = { ...v.load, dropped: null };
	return { ...v, load, coverage: v.coverage === undefined ? undefined : { ...v.coverage, dropped: null } };
}
function dropped(v: WeekView) {
	return { ...("dropped" in v.load ? v.load.dropped : { records: 0, receipts: 0 }), observations: v.coverage?.dropped };
}

/** A crash seam: "point", "point@n" (its n-th time, from 0) or "point:short" (a short write there). */
function crashAt(spec: string) {
	const m = /^([a-z-]+)(?:@(\d+))?(:short)?$/.exec(spec);
	assert(m !== null, `bad crash spec ${spec}`);
	const point = m[1] as UsageWeekPoint,
		skip = Number(m[2] ?? 0),
		short = m[3] !== undefined;
	let armed = false,
		seen = 0,
		hit = false;
	return {
		fault(p: UsageWeekPoint): number | undefined {
			if (!armed || p !== point || seen++ < skip) return undefined;
			armed = false;
			hit = true;
			if (short) return 10;
			throw new Error(`fixture crash at ${p}`);
		},
		arm() {
			armed = true;
			seen = 0;
		},
		hit: () => hit,
	};
}
const HEADERS: Record<string, string> = {
	log: `{"v":"usage-week-log/1","week":"${W}","kind":"log"}\n`,
	receipts: `{"v":"usage-week-log/1","week":"${W}","kind":"receipts"}\n`,
	adjust: `{"v":"usage-week-log/1","week":"${W}","kind":"adjust"}\n`,
	observations: OBS_HEADER,
};
interface Step {
	/** Done before the step, crash seam off. */
	setup(s: UsageWeekStore): void;
	/** The step crashed at the seam, then done again after the restart. */
	act(s: UsageWeekStore): void;
}
/**
 * One crash: a reference folder runs setup and the step with no crash; the crash folder runs setup, crashes the step
 * at the seam, restarts (optionally crashing the recovery's truncate too) and must come back exactly as the
 * reference was before the step (or after it, once the step's checkpoint is in place), with nothing uncommitted
 * replayed and no cursor ahead; then it does the step again and must end byte for byte as the reference.
 */
function crashCase(step: Step, spec: string, recoverSpec: string | null) {
	const refDir = join(data.dir, "ref"),
		mainDir = join(data.dir, "main"),
		refLease = new SharedArrayBuffer(4);
	mkdirSync(refDir, { mode: 0o700 });
	mkdirSync(mainDir, { mode: 0o700 });
	clock = DURING;
	let r = open({}, refDir, refLease);
	r.reload(W);
	step.setup(r);
	r = reopen(r, {}, refDir, refLease);
	const before = weekView(r),
		beforeFiles = Object.fromEntries(KINDS.map((k) => [k, bytes(k, refDir)]));
	step.act(r);
	r = reopen(r, {}, refDir, refLease);
	const after = weekView(r),
		afterFiles = weekFiles(refDir);
	shut(r);

	clock = DURING;
	const crash = crashAt(spec);
	let s = open({ fault: crash.fault }, mainDir);
	s.reload(W);
	step.setup(s);
	crash.arm();
	const code = codeOf(() => step.act(s));
	assert(crash.hit(), `crash point ${spec} was not reached`);
	assert.notEqual(code, "no-error");
	if (recoverSpec !== null) {
		const again = crashAt(recoverSpec);
		s = reopen(s, { fault: again.fault }, mainDir);
		again.arm();
		const recoverCode = codeOf(() => s.reload(W));
		assert(again.hit(), `recovery point ${recoverSpec} was not reached`);
		assert.notEqual(recoverCode, "no-error");
	}
	s = reopen(s, {}, mainDir);
	const recovered = weekView(s);
	const committed = spec === "after-checkpoint-rename";
	assert.deepEqual(committedView(recovered), committedView(committed ? after : before));
	if (!committed)
		for (const k of KINDS) {
			const got = bytes(k, mainDir);
			// Cut back to the committed bytes; a log the step created holds its header at most.
			if (beforeFiles[k] !== null) assert.equal(got, beforeFiles[k], `${k} not cut back`);
			else assert(got === null || got === HEADERS[k], `${k} left with uncommitted bytes`);
		}
	step.act(s);
	s = reopen(s, {}, mainDir);
	assert.deepEqual(weekView(s), after);
	assert.deepEqual(weekFiles(mainDir), afterFiles);
	return { code, committed, dropped: dropped(recovered) };
}
function writeStep(
	records: UsageWeekRecord[],
	receipts: UsageWeekReceipt[],
	obs: UsageWeekObservationInput[],
	n: number,
) {
	return (s: UsageWeekStore) => {
		s.append(W, records, receipts, obs);
		s.checkpoint(W, cursors(n));
	};
}
const STEPS: Record<string, Step> = {
	// An open week with a committed first batch; the second brings the receipts log's header with it.
	open: {
		setup: writeStep([R2, R3], [], [O.f2, O.w2, O.f3, O.a2], 1),
		act: writeStep(
			[R1, R4, R5, R6, R7],
			[SAME_CALL_1],
			[O.f1, O.w1, O.f4, O.l4, O.m, O.root, O.f5, O.a1, O.snap, O.policy, O.cov],
			2,
		),
	},
	// A new week's first batch: the log's header (@0), the receipts' (@1) and the observations' (@2).
	first: { setup: () => {}, act: writeStep(RECORDS, [SAME_CALL_1], ALL, 1) },
	// Observations alone first: the log's header (@0) still comes before the observations' (@1).
	only: { setup: () => {}, act: writeStep([], [], [O.m, O.policy, O.cov], 1) },
	// A sealed week's late batch, committed by adjust itself: the adjustment log's header (@0).
	adjust: {
		setup(s) {
			writeStep(RECORDS, [SAME_CALL_1], ALL, 1)(s);
			clock = AFTER;
			s.seal(W, PARTIAL);
		},
		act(s) {
			s.adjust(W, [R8], [], [O.f6, O.f5r1, O.w3]);
		},
	},
	// A week sealed with no observations log: adjust brings the adjustments' header (@0) and the observations' (@1).
	bare: {
		setup(s) {
			s.append(W, RECORDS, [SAME_CALL_1]);
			s.checkpoint(W, cursors(1));
			clock = AFTER;
			s.seal(W, PARTIAL);
		},
		act(s) {
			s.adjust(W, [R8], [], [O.f6, O.f5r1, O.w3]);
		},
	},
};

/** Rewrites the checkpoint with its sha256 recomputed, so only the changed field is wrong. */
function resign(change: (c: Record<string, unknown>) => void): void {
	const c = JSON.parse(bytes("checkpoint")!) as Record<string, unknown>;
	delete c.sha256;
	change(c);
	writeFileSync(file("checkpoint"), `${canonical({ ...c, sha256: sha(canonical(c)) })}\n`, "latin1");
}
/** Replaces the observations log and commits exactly it, so only the lines themselves can be wrong. */
function recommit(text: string, records: number): void {
	writeFileSync(file("observations"), text, "latin1");
	resign((c) => {
		c.observations = { length: text.length, records, sha256: sha(text) };
	});
}
/** Damage done to a committed week (RECORDS, the receipt and ALL, closed) before a restart. */
const DAMAGE: Record<string, (text: string, lines: string[]) => void> = {
	missing: () => rmSync(file("observations")),
	flip: (text) => {
		const i = OBS_HEADER.length + 10;
		writeFileSync(file("observations"), text.slice(0, i) + (text[i] === "0" ? "1" : "0") + text.slice(i + 1), "latin1");
	},
	truncated: (text) => truncateSync(file("observations"), text.length - 5),
	empty: () => truncateSync(file("observations"), 0),
	"header-version": (text) =>
		writeFileSync(
			file("observations"),
			text.replace("usage-week-observations/1", "usage-week-observations/2"),
			"latin1",
		),
	"header-week": (text) =>
		writeFileSync(file("observations"), text.replace(`"week":"${W}"`, '"week":"2026-10-12"'), "latin1"),
	"header-family": (text) =>
		writeFileSync(file("observations"), text.replace("usage-week-observations/1", "usage-week-log/1"), "latin1"),
	count: () =>
		resign((c) => {
			(c.observations as { records: number }).records++;
		}),
	sha: () =>
		resign((c) => {
			(c.observations as { sha256: string }).sha256 = sha("another log");
		}),
	length: () =>
		resign((c) => {
			(c.observations as { length: number }).length--;
		}),
	"unobserved-high": () =>
		resign((c) => {
			c.unobserved = (c.log as { records: number }).records + 1;
		}),
	"unobserved-negative": () =>
		resign((c) => {
			c.unobserved = -1;
		}),
	"no-observations-key": () =>
		resign((c) => {
			delete c.observations;
		}),
	"checkpoint-v3": () =>
		resign((c) => {
			c.v = "usage-week-checkpoint/3";
		}),
	"v1-with-observations": () =>
		resign((c) => {
			c.v = "usage-week-checkpoint/1";
		}),
	"extra-key": () =>
		resign((c) => {
			c.extra = 1;
		}),
	"duplicate-line": (text, lines) => recommit(text + lines[0], lines.length + 1),
	// The membership's row with its keys in reverse order: the same row and key, but not the store's bytes.
	reordered: (_text, lines) => {
		const x = JSON.parse(lines[8]) as Record<string, unknown>;
		const r = Object.fromEntries(Object.entries(x.r as object).reverse());
		const swapped = `${JSON.stringify({ k: x.k, o: x.o, p: x.p, rk: x.rk, r })}\n`;
		assert.equal(x.o, "membership");
		assert.notEqual(swapped, lines[8]);
		recommit(OBS_HEADER + [...lines.slice(0, 8), swapped, ...lines.slice(9)].join(""), lines.length);
	},
	"wrong-key": (_text, lines) => {
		const changed = lines[2].replace(keyOf(O.f2), sha("not this row"));
		recommit(OBS_HEADER + [...lines.slice(0, 2), changed, ...lines.slice(3)].join(""), lines.length);
	},
	"bad-row": (_text, lines) => {
		const bad = { o: "fact", r: { ...F2, supersedes: 0 }, rk: R2.k } as UsageWeekObservationInput;
		recommit(OBS_HEADER + [...lines.slice(0, 2), lineOf(bad, "open"), ...lines.slice(3)].join(""), lines.length);
	},
	"bad-phase": (_text, lines) => {
		const changed = lines[2].replace('"p":"open"', '"p":"sealed"');
		recommit(OBS_HEADER + [...lines.slice(0, 2), changed, ...lines.slice(3)].join(""), lines.length);
	},
	"torn-tail": () => appendFileSync(file("observations"), '{"k":"ab', "latin1"),
	"uncommitted-line": () => appendFileSync(file("observations"), lineOf(O.f5r1, "open"), "latin1"),
	symlink: () => {
		renameSync(file("observations"), join(data.dir, "elsewhere"));
		symlinkSync(join(data.dir, "elsewhere"), file("observations"));
	},
	mode: () => chmodSync(file("observations"), 0o644),
};

// B2's own bytes for R1-R3 and the receipt, checkpointed with cursors(1) at DURING: case legacySource's result on
// B2's code (6dc6a396), pasted unchanged, so the legacy case reads a week B2 actually wrote.
const LEGACY = {
	log:
		'{"v":"usage-week-log/1","week":"2026-10-19","kind":"log"}\n' +
		'{"k":"a5edd9c70706b47239d1d2c90897e8bbead0a1736cbb46e60b5a6ba122f4c6a3","d":"original","at":"2026-10-20T15:04:05.123Z","src":"5c8407a638d0e704","off":1013,"len":601,"sub":{"role":"ops","project":"automatic-cost-accounting","initiative":null,"task":{"q":"5831a68bec6cb40ffbc7a2d8f6715181c449c38e1be0c5db7687263aa77205b5","n":500,"at":"2026-10-19T08:00:00.000Z"}},"usd":"0.412350000000","tok":[1200,340,52000,800],"rate":"pi-recorded-1"}\n' +
		'{"k":"f867ca1d5b63b84222b573e4cfbbbac027a84fb5bcffbe5900b0c3620c59a5b7","d":"original","at":"2026-10-20T15:09:00.000Z","src":"def9ddf27f0b9992","off":2026,"len":602,"sub":{"role":"ops","project":"automatic-cost-accounting","initiative":null,"task":{"q":"5831a68bec6cb40ffbc7a2d8f6715181c449c38e1be0c5db7687263aa77205b5","n":500,"at":"2026-10-19T08:00:00.000Z"}},"usd":null,"tok":[9000,1500,null,null],"rate":null}\n' +
		'{"k":"4aaf4dadde201a084838c24fdda957938f219e233a2afe679f95dfc09c265937","d":"unresolved","at":"2026-10-21T09:30:00.000Z","src":"feab13a06818a112","off":3039,"len":603,"sub":{"role":"design","project":null,"initiative":"design-in-temper","task":null},"usd":null,"tok":[800,null,null,null],"rate":null}\n',
	receipts:
		'{"v":"usage-week-log/1","week":"2026-10-19","kind":"receipts"}\n' +
		'{"k":"fdbd3ac513a3343586e70aba775c9a785fcd281b35074fd4d9904fb672062073","kind":"same-call","r":{"canonical":{"id":"[\\"usage-fact/1\\",\\"pi\\",\\"session-7f3a\\",\\"response:5d3c1f0e9b8a7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605f4\\"]","identity":{"attempt":"response:5d3c1f0e9b8a7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605f4","incarnation":"session-7f3a","producer":"pi"},"identityStatus":"verified","kind":"assistant","links":{"run":null,"session":"session-7f3a","task":null},"model":"claude-opus-4-5","occurredAt":"2026-10-20T15:04:05.123Z","prices":[{"amount":"0.41235","basis":"list-estimate","currency":"USD","rateVersion":"pi-recorded-1","status":"known"}],"provider":"anthropic","revision":0,"source":{"coverage":"complete","event":"entry-0001","observedAt":"2026-10-20T15:04:06.000Z","stream":"pi-session:7f3a"},"supersedes":null,"tokens":{"cacheRead":52000,"cacheWrite":800,"input":1200,"output":340},"v":"usage-fact/1"},"evidenceRef":"native-response-map/1","provider":"anthropic","responseId":"msg_01Fq7XyZ3a9B"}}\n',
	checkpoint:
		'{"adjust":null,"at":"2026-10-23T12:00:00.000Z","files":{"d152558397a8a525":{"cursor":null,"mtimeMs":1792700000000,"size":0},"d94af485e8cae36f":{"cursor":{"ordinal":1,"token":"pi1:400:0:400:88246879e93a3e721ec7588b4fdd8f536dab23103cefc36d223b4015a69d099d:125b21ca79356b030acfaef0d487f3f3d5667fa89667e20689d928fe941a1ce7"},"mtimeMs":1792700000001,"size":400}},"ledger":{"anchor":{"bytes":50,"sha256":"88664cea2959c2d496b6ba34c07bb696615c0e5fe48a55e723735322ebdc73de","start":100},"byte":150,"headerSha256":"d2e5e541f70a52b5bba45c20ba6ed3cf3807f3b1b19dd25051388a3bc5617937","incarnation":"fixture-ledger-incarnation","kind":"file","line":1,"ordinal":1,"stream":"fixture-ledger"},"log":{"length":1209,"records":3,"sha256":"3a9fe207505c087963c46e00af7649ab80b39e68ed2288940ecf0d74cf75743d"},"receipts":{"length":1097,"records":1,"sha256":"d5364ebac48ea6cc9e3fff260db5e2d4c0110191e5b41d328ee6941155245ea5"},"sha256":"06bc3648950c63af332e99c30a6defe49b01255dcd7278419558f1840538db84","v":"usage-week-checkpoint/1","week":"2026-10-19"}\n',
};

const cases: Record<string, () => unknown> = {
	literalReplay() {
		const s = open();
		assert.deepEqual(s.reload(W), { state: "empty", week: W });
		const appended = s.append(W, RECORDS, [SAME_CALL_1], ALL);
		assert.deepEqual(appended, {
			appended: 7,
			duplicates: 0,
			receipts: 1,
			receiptDuplicates: 0,
			records: 7,
			length: appended.length,
			observations: 15,
			observationDuplicates: 0,
			unobserved: 0,
		});
		const cp = s.checkpoint(W, cursors(1));
		const text = OBS_HEADER + ALL.map((x) => lineOf(x, "open")).join("");
		assert.equal(bytes("observations"), text);
		assert.equal(cp.v, "usage-week-checkpoint/2");
		assert.deepEqual(cp.observations, { length: text.length, records: 15, sha256: sha(text) });
		assert.equal(cp.unobserved, 0);
		const paged = replayAll(s, 4);
		assert.deepEqual(paged.pages, [4, 4, 4, 3]);
		assert.deepEqual(paged.rows, expected(ALL, "open"));
		assert.deepEqual(paged.coverage, { state: "complete", observations: 15, unobserved: 0, dropped: 0 });
		// W2's receipt and the numbers are B2's, unchanged.
		assert.deepEqual(s.receipt(W, "same-call", SAME_CALL_1.k), SAME_CALL_1.r);
		const s2 = reopen(s);
		const again = reloadAll(s2);
		assert.equal(again.load.state, "open");
		assert.deepEqual(
			again.records,
			RECORDS.map((r) => `log:${r.d}:${r.k.slice(0, 8)}`),
		);
		const whole = replayAll(s2);
		assert.deepEqual(whole.pages, [15]);
		assert.deepEqual(whole.rows, paged.rows);
		// Gaps stay gaps: nothing is written for the unverified attempt or the gap.
		const bound = new Set(whole.rows.map((x) => x.rk));
		assert(!bound.has(R5.k) && !bound.has(R6.k));
		return { sha256: sha(text), bytes: text.length, line: lineOf(O.f2, "open") };
	},

	numericOnly() {
		// What B2's numbers and receipts alone give back (this case runs on B2's own code too): the receipt-attached
		// verified original, nothing else. Records carry no fact id, role, root, revision or alias.
		let s = open();
		s.reload(W);
		s.append(W, RECORDS, [SAME_CALL_1]);
		s.checkpoint(W, cursors(1));
		s = reopen(s);
		const records: UsageWeekRecord[] = [];
		s.reload(W, (r) => {
			records.push(r);
		});
		const found = new Set<string>();
		const receipt = s.receipt(W, "same-call", SAME_CALL_1.k);
		if (receipt !== null && "canonical" in receipt) found.add(keyOf({ o: "fact", r: receipt.canonical }));
		const all = [...ALL, O.f5r1];
		return {
			records: records.length,
			recovered: all.filter((x) => found.has(keyOf(x))).map((x) => NAME.get(x)),
			missing: all.filter((x) => !found.has(keyOf(x))).map((x) => NAME.get(x)),
		};
	},

	legacySource() {
		// B2's calls only. Run on B2's code (variant capture) its bytes are LEGACY; on this code the log and the receipts
		// must be B2's bytes exactly, and only the checkpoint differs (version 2).
		const s = open();
		s.reload(W);
		s.append(W, [R1, R2, R3], [SAME_CALL_1]);
		s.checkpoint(W, cursors(1));
		const got = { log: bytes("log")!, receipts: bytes("receipts")!, checkpoint: bytes("checkpoint")! };
		if (variant === "capture") return got;
		return {
			log: got.log === LEGACY.log,
			receipts: got.receipts === LEGACY.receipts,
			checkpoint: got.checkpoint === LEGACY.checkpoint,
			version: (JSON.parse(got.checkpoint) as { v: string }).v,
			observations: bytes("observations"),
		};
	},

	dedupe() {
		let s = open();
		s.reload(W);
		s.append(W, [R1, R2, R7], [], [O.f1, O.w1, O.f2, O.f5]);
		s.checkpoint(W, cursors(1));
		// F1 read again later: the same fact, kept once, with the first read's time. W1's role named otherwise by other
		// evidence: kept beside it (W5 refuses the conflict; the store never picks). F5's revision 1: a fact of its own.
		const F1_AGAIN: UsageFact = { ...F1, source: { ...F1.source, observedAt: "2026-10-23T08:00:00.000Z" } };
		const W1_OTHER: UsageWeekObservationInput = {
			o: "fact-role",
			r: { factId: F1.id, role: "design", evidenceRef: "queue-task:design/9" },
			rk: null,
		};
		const batch: UsageWeekObservationInput[] = [
			{ o: "fact", r: F1_AGAIN, rk: R1.k },
			O.f5r1,
			W1_OTHER,
			O.f6,
			O.f6,
			O.f2,
		];
		const second = s.append(W, [R1, R8], [], batch);
		assert.deepEqual(pick(second), {
			appended: 1,
			duplicates: 1,
			observations: 3,
			observationDuplicates: 3,
			unobserved: 0,
		});
		s.checkpoint(W, cursors(2));
		const third = s.append(W, [R1, R8], [], batch);
		assert.deepEqual(pick(third), {
			appended: 0,
			duplicates: 2,
			observations: 0,
			observationDuplicates: 6,
			unobserved: 0,
		});
		const cp = s.checkpoint(W, cursors(2));
		const want = expected([O.f1, O.w1, O.f2, O.f5, O.f5r1, W1_OTHER, O.f6], "open");
		assert.deepEqual(replayAll(s).rows, want);
		for (let i = 0; i < 2; i++) {
			s = reopen(s);
			reloadAll(s);
			assert.deepEqual(replayAll(s).rows, want);
			assert.deepEqual(s.observationCoverage(W), { state: "complete", observations: 7, unobserved: 0, dropped: 0 });
		}
		// F2 read again with other content under the same identity and revision: kept as a line of its own (the
		// contract and W5 decide between them; the store never picks).
		const F2_OTHER: UsageWeekObservationInput = {
			o: "fact",
			r: { ...F2, tokens: { ...F2.tokens, output: 1501 } },
			rk: null,
		};
		const sameRevision = pick(s.append(W, [], [], [F2_OTHER]));
		s.checkpoint(W, cursors(3));
		assert.deepEqual(replayAll(s).rows, [...want, ...expected([F2_OTHER], "open")]);
		return { rows: want.length, records: cp.observations!.records, sameRevision };
	},

	partialCoverage() {
		let s = open();
		s.reload(W);
		// An original committed without its fact, and an alias without one: only the original is unobserved.
		assert.equal(s.append(W, [R1, R4], [], []).unobserved, 1);
		s.checkpoint(W, cursors(1));
		assert.deepEqual(s.observationCoverage(W), { state: "partial", observations: 0, unobserved: 1, dropped: 0 });
		// Its fact coming later is kept, but the count stays: coverage is never upgraded afterwards.
		assert.equal(s.append(W, [], [], [O.f1]).unobserved, 0);
		s.checkpoint(W);
		assert.deepEqual(s.observationCoverage(W), { state: "partial", observations: 1, unobserved: 1, dropped: 0 });
		// A fact already kept doesn't vouch for a new original: F2 first unbound, then again with R2.
		s.append(W, [], [], [{ ...O.f2, rk: null }]);
		assert.deepEqual(pick(s.append(W, [R2], [], [O.f2])), {
			appended: 1,
			duplicates: 0,
			observations: 0,
			observationDuplicates: 1,
			unobserved: 1,
		});
		// B2's three-argument append: its result is B2's, and its originals are unobserved.
		assert.deepEqual(Object.keys(s.append(W, [R7], [])).sort(), [
			"appended",
			"duplicates",
			"length",
			"receiptDuplicates",
			"receipts",
			"records",
		]);
		// Until a checkpoint, coverage is what the last one committed.
		assert.deepEqual(s.observationCoverage(W), { state: "partial", observations: 1, unobserved: 1, dropped: 0 });
		s.checkpoint(W, cursors(2));
		const committed = s.observationCoverage(W);
		assert.deepEqual(committed, { state: "partial", observations: 2, unobserved: 3, dropped: 0 });
		// Uncommitted appends are cut on reload, and so is the count they added.
		s.append(W, [R8], [], [O.f6, { ...O.m, rk: null }]);
		s = reopen(s);
		const load = s.reload(W);
		assert(load.state === "open");
		assert.equal(load.records, 4);
		const after = s.observationCoverage(W);
		assert.deepEqual({ ...after, dropped: 0 }, committed);
		assert.equal(after.dropped, lineOf(O.f6, "open").length + lineOf(O.m, "open").length);
		return { committed, dropped: after.dropped };
	},

	refusals() {
		let s = open();
		s.reload(W);
		s.append(W, [R1, R2], [], [O.f1, O.f2]);
		s.checkpoint(W, cursors(1));
		const before = weekFiles();
		const one = (x: unknown) => () => s.append(W, [], [], [x as UsageWeekObservationInput]);
		const moved = (f: UsageFact, at: string): UsageFact => ({
			...f,
			occurredAt: at,
			source: { ...f.source, observedAt: at },
		});
		const got: Record<string, string> = {
			"unknown-kind": codeOf(one({ o: "note", r: { text: "hello" }, rk: null })),
			"extra-key": codeOf(one({ ...O.m, extra: 1 })),
			"no-rk": codeOf(one({ o: "membership", r: M })),
			"rk-not-hex": codeOf(one({ ...O.m, rk: "R1" })),
			"rk-unknown": codeOf(one({ ...O.m, rk: sha("no such record") })),
			"fact-id-mismatch": codeOf(one({ o: "fact", r: { ...F3, id: F2.id }, rk: null })),
			"fact-responseId-added": codeOf(one({ o: "fact", r: { ...F2, responseId: RESPONSE_ID_1 }, rk: null })),
			"fact-payer-added": codeOf(one({ o: "fact", r: { ...F3, payerRole: "ops" }, rk: null })),
			"fact-status-invented": codeOf(one({ o: "fact", r: { ...F3, identityStatus: "assumed" }, rk: null })),
			"fact-revision-chain": codeOf(one({ o: "fact", r: { ...F5R1, supersedes: null }, rk: null })),
			"fact-price-guessed": codeOf(
				one({ o: "fact", r: { ...F3, prices: [{ ...F3.prices[0], amount: "0.01" }] }, rk: null }),
			),
			"role-uppercase": codeOf(one({ o: "fact-role", r: { ...W1, role: "Ops" }, rk: null })),
			"role-not-reference": codeOf(one({ o: "fact-role", r: { ...W1, factId: "session-7f3a" }, rk: null })),
			"role-producer": codeOf(
				one({ o: "fact-role", r: { ...W1, factId: '["usage-fact/1","codex","s-1","a-1"]' }, rk: null }),
			),
			"role-extra-key": codeOf(one({ o: "fact-role", r: { ...W1, scope: "own" }, rk: null })),
			"role-evidence-missing": codeOf(one({ o: "fact-role", r: { factId: F1.id, role: "ops" }, rk: null })),
			"allocation-payer-without-root": codeOf(
				one({ o: "allocation", r: { ...A2, scope: "requested", payerRole: "ops" }, rk: null }),
			),
			"allocation-native-without-root": codeOf(one({ o: "allocation", r: { ...A1, rootRef: null }, rk: null })),
			"not-ascii": codeOf(one({ o: "membership", r: { ...M, project: "caf\u00e9" }, rk: null })),
			"fact-before-week": codeOf(one({ o: "fact", r: moved(F2, "2026-10-19T06:59:59.999Z"), rk: null })),
			"fact-at-week-end": codeOf(one({ o: "fact", r: moved(F2, "2026-10-26T07:00:00.000Z"), rk: null })),
			"all-or-none": codeOf(() => s.append(W, [R7], [], [O.f5, { ...O.m, rk: "x" }])),
			"not-an-array": codeOf(() => s.append(W, [], [], {} as unknown as UsageWeekObservationInput[])),
			"not-loaded": codeOf(() => s.observations("2026-10-12")),
			"coverage-not-loaded": codeOf(() => s.observationCoverage("2026-10-12")),
			"invalid-week": codeOf(() => s.observations("2026-10-20")),
		};
		assert.deepEqual(weekFiles(), before);
		assert.deepEqual(s.status(), { state: "ready", code: null });
		// Lowered caps, one at a time (a store may only lower them).
		const capped = (limits: Partial<UsageWeekStoreOptions["limits"]>, x: UsageWeekObservationInput[]) => {
			s = reopen(s, { limits });
			s.reload(W);
			return codeOf(() => s.append(W, [], [], x));
		};
		const big: UsageWeekObservationInput = {
			o: "snapshot",
			r: { ...SNAP, coveredFactIds: Array.from({ length: 40 }, (_, i) => `["usage-fact/1","temper","t","a-${i}"]`) },
			rk: null,
		};
		got["cap-line"] = capped({ observationBytes: 2048 }, [big]);
		got["cap-count"] = capped({ appendObservations: 2 }, [O.m, O.policy, O.cov]);
		got["cap-bytes"] = capped({ appendObservationBytes: 600 }, [O.m, O.policy, O.cov]);
		got["cap-week"] = capped({ weekObservations: 3 }, [O.m, O.policy]);
		assert.deepEqual(weekFiles(), before);
		// The week's own bounds: its first millisecond is in, as is everything a refused call held back.
		s = reopen(s);
		s.reload(W);
		const first: UsageFact = {
			...moved(F2, "2026-10-19T07:00:00.000Z"),
			id: '["usage-fact/1","pi","session-7f3a","entry-0000"]',
			identity: { producer: "pi", incarnation: "session-7f3a", attempt: "entry-0000" },
		};
		const ok = s.append(W, [R7], [], [O.f5, { o: "fact", r: first, rk: null }]);
		assert.deepEqual(pick(ok), {
			appended: 1,
			duplicates: 0,
			observations: 2,
			observationDuplicates: 0,
			unobserved: 0,
		});
		return got;
	},

	crash() {
		const [name, spec, recoverSpec] = variant.split("/");
		return crashCase(STEPS[name], spec, recoverSpec ?? null);
	},

	emptyCommit() {
		let s = open();
		s.reload(W);
		// A checkpoint with nothing appended: no observations log, nothing to replay, complete over nothing.
		const cp = s.checkpoint(W, cursors(1));
		assert.equal(cp.observations, null);
		assert.deepEqual(replayAll(s), {
			rows: [],
			pages: [0],
			coverage: { state: "complete", observations: 0, unobserved: 0, dropped: 0 },
		});
		// The observations log's header lands, its first lines tear: reload cuts it back to its header...
		const crash = crashAt("observations-write:short");
		s = reopen(s, { fault: crash.fault });
		s.reload(W);
		crash.arm();
		const code = codeOf(() => s.append(W, [], [], [O.m, O.policy]));
		assert(crash.hit());
		s = reopen(s);
		s.reload(W);
		assert.equal(bytes("observations"), OBS_HEADER);
		assert.deepEqual(s.observationCoverage(W), { state: "complete", observations: 0, unobserved: 0, dropped: 10 });
		assert.deepEqual(replayAll(s).rows, []);
		// ...and the next checkpoint commits the header alone: an empty log, replayed as nothing, hash-checked.
		const empty = s.checkpoint(W);
		assert.deepEqual(empty.observations, { length: OBS_HEADER.length, records: 0, sha256: sha(OBS_HEADER) });
		assert.deepEqual(replayAll(s, 1), {
			rows: [],
			pages: [0],
			coverage: { state: "complete", observations: 0, unobserved: 0, dropped: 10 },
		});
		s = reopen(s);
		s.reload(W);
		assert.deepEqual(replayAll(s).rows, []);
		s.append(W, [], [], [O.m, O.policy]);
		s.checkpoint(W);
		assert.deepEqual(replayAll(s).rows, expected([O.m, O.policy], "open"));
		return { code };
	},

	replayCursor() {
		let s = open();
		s.reload(W);
		const members = Array.from({ length: 28 }, (_, i): UsageWeekObservationInput => ({
			o: "membership",
			r: { ...M, task: i + 1 },
			rk: null,
		}));
		s.append(W, [], [], members.slice(0, 25));
		s.checkpoint(W, cursors(1));
		const p1 = s.observations(W, null, 4);
		assert.equal(p1.observations.length, 4);
		const next = p1.next!;
		const flip = (t: string) => (t[0] === "0" ? "1" : "0") + t.slice(1);
		const refused = {
			tag: codeOf(() => s.observations(W, { ...next, tag: flip(next.tag) }, 4)),
			offset: codeOf(() => s.observations(W, { ...next, offset: next.offset + 1 }, 4)),
			ordinal: codeOf(() => s.observations(W, { ...next, ordinal: next.ordinal - 1 }, 4)),
			extra: codeOf(() => s.observations(W, { ...next, extra: 1 } as UsageWeekReplayCursor, 4)),
			partial: codeOf(() => s.observations(W, { offset: next.offset, ordinal: 4 } as UsageWeekReplayCursor, 4)),
			rows0: codeOf(() => s.observations(W, next, 0)),
			rowsAboveCap: codeOf(() => s.observations(W, next, 4097)),
			rowsFraction: codeOf(() => s.observations(W, next, 1.5)),
		};
		// Each refusal left the stream as it was. Appends and a checkpoint meanwhile don't change what it replays.
		const rows = [...p1.observations];
		let page = s.observations(W, next, 4);
		rows.push(...page.observations);
		s.append(W, [], [], members.slice(25));
		s.checkpoint(W);
		while (page.next !== null) {
			page = s.observations(W, page.next, 4);
			rows.push(...page.observations);
			assert.deepEqual(page.coverage, p1.coverage);
		}
		assert.deepEqual(rows, expected(members.slice(0, 25), "open"));
		const ended = codeOf(() => s.observations(W, next, 4));
		// A new stream sees the commit, and ends any older one.
		const q = s.observations(W, null, 4);
		s.observations(W, null, 4);
		const superseded = codeOf(() => s.observations(W, q.next!, 4));
		const ones = replayAll(s, 1),
			whole = replayAll(s, 4096);
		assert.deepEqual(ones.rows, expected(members, "open"));
		assert.deepEqual(whole.rows, ones.rows);
		assert.deepEqual(whole.pages, [28]);
		// No stream goes on across a restart.
		const r = s.observations(W, null, 4);
		s = reopen(s);
		const notLoaded = codeOf(() => s.observations(W, r.next!, 4));
		s.reload(W);
		const restarted = codeOf(() => s.observations(W, r.next!, 4));
		return { refused, ended, superseded, notLoaded, restarted, pages: ones.pages.length };
	},

	legacy() {
		assert(LEGACY.log !== "", "LEGACY not filled in");
		let s = open();
		shut(s);
		for (const [kind, text] of Object.entries(LEGACY))
			writeFileSync(file(kind), text, { encoding: "latin1", mode: 0o600, flag: "wx" });
		s = open();
		const { load, records } = reloadAll(s);
		assert(load.state === "open" && load.checkpoint !== null);
		assert.equal(load.checkpoint.v, "usage-week-checkpoint/1");
		assert.deepEqual(
			records,
			[R1, R2, R3].map((r) => `log:${r.d}:${r.k.slice(0, 8)}`),
		);
		const coverage = s.observationCoverage(W);
		const refused = {
			replay: codeOf(() => s.observations(W)),
			append: codeOf(() => s.append(W, [R4], [])),
			appendObserved: codeOf(() => s.append(W, [], [], [O.m])),
			checkpoint: codeOf(() => s.checkpoint(W)),
			checkpointCursors: codeOf(() => s.checkpoint(W, cursors(2))),
		};
		for (const [kind, text] of Object.entries(LEGACY)) assert.equal(bytes(kind), text);
		assert.deepEqual(s.receipt(W, "same-call", SAME_CALL_1.k), SAME_CALL_1.r);
		// A stray observations log next to B2's checkpoint was never committed: cut to its header on reload.
		shut(s);
		writeFileSync(file("observations"), OBS_HEADER + lineOf(O.m, "open"), { encoding: "latin1", mode: 0o600 });
		s = open();
		s.reload(W);
		assert.equal(bytes("observations"), OBS_HEADER);
		const stray = s.observationCoverage(W);
		assert.equal(stray.dropped, lineOf(O.m, "open").length);
		// Its numbers can still be sealed; its observations stay unknown, and late writes are refused.
		clock = AFTER;
		const sealed = s.seal(W, PARTIAL);
		s = reopen(s);
		const sealedLoad = s.reload(W);
		assert(sealedLoad.state === "sealed");
		assert.equal(sealedLoad.checkpoint.v, "usage-week-checkpoint/1");
		assert.deepEqual(s.sealedTotals(W), { state: "sealed", week: W, sealed });
		return {
			coverage,
			refused,
			stray,
			sealedCoverage: s.observationCoverage(W),
			sealedReplay: codeOf(() => s.observations(W)),
			adjust: codeOf(() => s.adjust(W, [R8], [], [O.f6])),
			adjustNumbers: codeOf(() => s.adjust(W, [R8], [])),
			listing: s.listWeeks(),
		};
	},

	listing() {
		const s = open();
		s.reload(W);
		s.append(W, [R1], []);
		s.checkpoint(W, cursors(1));
		const without = s.listWeeks();
		s.append(W, [], [], [O.f1]);
		s.checkpoint(W);
		const withObservations = s.listWeeks();
		const moved = s
			.quarantineWeek(W)
			.moved.map((n) => n.replace(/[a-f0-9]{16}$/, "<tag>"))
			.sort();
		return { without, withObservations, moved, after: s.listWeeks(), reload: s.reload(W) };
	},

	seal() {
		let s = open();
		s.reload(W);
		s.append(W, RECORDS, [SAME_CALL_1], ALL);
		s.checkpoint(W, cursors(1));
		// Observations past the last checkpoint hold the seal back, as records and receipts do.
		s.append(W, [], [], [O.f5r1]);
		clock = AFTER;
		const behind = codeOf(() => s.seal(W, PARTIAL));
		s.checkpoint(W);
		const sealed = s.seal(W, PARTIAL);
		const atSeal = replayAll(s).rows;
		assert.deepEqual(atSeal, expected([...ALL, O.f5r1], "open"));
		// A late row bound to a record neither the sealed week nor the call has is refused, all or none.
		const sealedFiles = weekFiles();
		const unknownRk = codeOf(() => s.adjust(W, [R8], [], [O.f6, { ...O.m, rk: sha("no such record") }]));
		assert.deepEqual(weekFiles(), sealedFiles);
		assert.deepEqual(s.status(), { state: "ready", code: null });
		// Late facts for a sealed week are marked late and committed by adjust itself; sealed totals don't change.
		const late = s.adjust(W, [R8], [], [O.f6, O.w3, O.f5r1]);
		assert.deepEqual(pick(late), {
			appended: 1,
			duplicates: 0,
			observations: 2,
			observationDuplicates: 1,
			unobserved: 0,
		});
		const want = [...atSeal, ...expected([O.f6, O.w3], "late")];
		assert.deepEqual(replayAll(s).rows, want);
		s = reopen(s);
		const { load, records } = reloadAll(s);
		assert(load.state === "sealed");
		assert.equal(load.adjustments, 1);
		assert.deepEqual(records, [`adjust:original:${R8.k.slice(0, 8)}`]);
		assert.deepEqual(replayAll(s).rows, want);
		assert.deepEqual(s.sealedTotals(W), { state: "sealed", week: W, sealed });
		assert.deepEqual(s.observationCoverage(W), { state: "complete", observations: 18, unobserved: 0, dropped: 0 });
		// The test-only removal takes the observations log with the rest.
		const removed = s.deleteWeek(W).removed;
		return { behind, unknownRk, removed };
	},

	integrity() {
		let s = open();
		s.reload(W);
		s.append(W, RECORDS, [SAME_CALL_1], ALL);
		s.checkpoint(W, cursors(1));
		shut(s);
		const text = bytes("observations")!,
			lines = text.slice(OBS_HEADER.length).split(/(?<=\n)/);
		assert.equal(lines.length, 15);
		DAMAGE[variant](text, lines);
		s = open();
		const got: { load?: UsageWeekLoad } = {};
		const reload = codeOf(() => {
			got.load = s.reload(W);
		});
		const load = got.load;
		// A file the store can't trust as its own (a symlink, other permissions) stops the store, not just the week.
		if (load === undefined) return { reload, store: s.status() };
		if (load.state === "unavailable") return { load: load.code, after: codeOf(() => s.observations(W)) };
		// Reload proved the week; a line that isn't exactly the store's is found by replay, which then fails closed.
		const replay = codeOf(() => replayAll(s));
		const out: Record<string, unknown> = { load: load.state, replay, after: codeOf(() => s.observations(W)) };
		if (replay === "no-error") {
			out.rows = replayAll(s).rows.length;
			out.dropped = s.observationCoverage(W).dropped;
			out.cut = bytes("observations") === text;
			if (variant === "uncommitted-line") assert.equal(out.dropped, lineOf(O.f5r1, "open").length);
		}
		return out;
	},

	betweenPages() {
		// Damage while a stream is between pages: its next page refuses it and the week becomes unavailable.
		let s = open();
		s.reload(W);
		s.append(W, RECORDS, [SAME_CALL_1], ALL);
		s.checkpoint(W, cursors(1));
		s = reopen(s);
		s.reload(W);
		const p = s.observations(W, null, 4);
		if (variant === "rewrite") {
			// Same inode, same size, every line still valid: the two committed lines right after this page swap places
			// in one positioned write. Each page's own checks can't see it; only the running SHA256 at the end can.
			const total = s.observationCoverage(W).observations,
				path = file("observations"),
				before = statSync(path),
				text = readFileSync(path, "latin1"),
				at = p.next!.offset,
				mid = text.indexOf("\n", at) + 1,
				end = text.indexOf("\n", mid) + 1;
			assert(mid > at && end > mid && text.slice(at, mid) !== text.slice(mid, end));
			const swapped = Buffer.from(text.slice(mid, end) + text.slice(at, mid), "latin1"),
				fd = openSync(path, "r+");
			try {
				assert.equal(writeSync(fd, swapped, 0, swapped.length, at), swapped.length);
			} finally {
				closeSync(fd);
			}
			const after = statSync(path);
			assert(after.ino === before.ino && after.size === before.size && readFileSync(path, "latin1") !== text);
			let q = p,
				served = 0;
			const last = codeOf(() => {
				for (;;) {
					q = s.observations(W, q.next, 4);
					if (q.next === null) return;
					served++;
				}
			});
			// left: the rows of the refused page, so it is the stream's last (all pages but the last hold 4 rows).
			return { served, left: total - 4 - served * 4, last, after: codeOf(() => s.observations(W)) };
		}
		if (variant === "append") appendFileSync(file("observations"), "x\n", "latin1");
		else {
			copyFileSync(file("observations"), join(data.dir, "copy"));
			renameSync(join(data.dir, "copy"), file("observations"));
		}
		return { next: codeOf(() => s.observations(W, p.next, 4)), after: codeOf(() => s.observations(W)) };
	},

	large() {
		// E1/E2 (Ops #420 PLAN): a week of `attempts` pi attempts in batches of 4,096, each with its numeric record and
		// its fact, a role witness every 10th and an allocation every 50th, checkpointed per batch; then, as after a
		// restart, a reload and a whole paged replay.
		const attempts = Number(data.extra.attempts),
			batch = 4096;
		let s = open();
		s.reload(W);
		let appendMs = 0,
			checkpointMs = 0,
			observations = 0;
		const base = Date.parse("2026-10-19T08:00:00.000Z");
		for (let i = 0, n = 1; i < attempts; i += batch, n++) {
			const records: UsageWeekRecord[] = [],
				obs: UsageWeekObservationInput[] = [];
			for (let j = i; j < Math.min(attempts, i + batch); j++) {
				const at = new Date(base + j * 2000).toISOString(),
					session = `session-${(j % 2408).toString(16)}`,
					attempt = `response:${sha(`large-response:${j}`)}`;
				const fact: UsageFact = {
					...F1,
					id: JSON.stringify(["usage-fact/1", "pi", session, attempt]),
					identity: { producer: "pi", incarnation: session, attempt },
					occurredAt: at,
					tokens: { input: 1000 + (j % 977), output: 200 + (j % 61), cacheRead: 30000, cacheWrite: j % 3 ? 50 : null },
					source: { stream: `pi-session:${session}`, event: `entry-${j}`, observedAt: at, coverage: "complete" },
					links: { task: null, session, run: null },
				};
				const r = rec(j + 100, "original", at, "0.412350000000", [1000, 200, 30000, null], "pi-recorded-1");
				records.push(r);
				obs.push({ o: "fact", r: fact, rk: r.k });
				if (j % 10 === 0)
					obs.push({
						o: "fact-role",
						r: { factId: fact.id, role: "ops", evidenceRef: `queue-task:ops/${j}` },
						rk: r.k,
					});
				if (j % 50 === 0) obs.push({ o: "allocation", r: { ...A1, factId: fact.id, recordedAt: at }, rk: r.k });
			}
			let started = performance.now();
			const result = s.append(W, records, [], obs);
			appendMs += performance.now() - started;
			assert.equal(result.appended, records.length);
			assert.equal(result.observations, obs.length);
			observations += obs.length;
			started = performance.now();
			s.checkpoint(W, cursors(n));
			checkpointMs += performance.now() - started;
		}
		shut(s);
		const reloadMs: number[] = [],
			replayMs: number[] = [];
		let heapAfterReload = 0,
			heapAfterReplay = 0,
			pages = 0,
			maxPageBytes = 0,
			rows = 0;
		for (let run = 0; run < 2; run++) {
			s = open();
			let started = performance.now();
			const load = s.reload(W);
			reloadMs.push(performance.now() - started);
			assert(load.state === "open" && load.records === attempts && load.checkpoint?.v === "usage-week-checkpoint/2");
			const total = load.checkpoint.observations!.length;
			if (run === 0) heapAfterReload = process.memoryUsage().heapUsed;
			started = performance.now();
			let page = s.observations(W),
				offset = 0;
			rows = 0;
			pages = 0;
			for (;;) {
				rows += page.observations.length;
				pages++;
				const end = page.next === null ? total : page.next.offset;
				maxPageBytes = Math.max(maxPageBytes, end - offset);
				offset = end;
				if (page.next === null) break;
				page = s.observations(W, page.next);
			}
			replayMs.push(performance.now() - started);
			if (run === 0) heapAfterReplay = process.memoryUsage().heapUsed;
			assert.equal(rows, observations);
			shut(s);
		}
		return {
			attempts,
			observations,
			appendMs: Math.round(appendMs),
			checkpointMs: Math.round(checkpointMs),
			reloadMs: reloadMs.map((x) => Math.round(x * 100) / 100),
			replayMs: replayMs.map((x) => Math.round(x)),
			pages,
			maxPageBytes,
			heapAfterReload,
			heapAfterReplay,
			logBytes: statSync(file("log")).size,
			observationBytes: statSync(file("observations")).size,
			checkpointBytes: statSync(file("checkpoint")).size,
		};
	},
};

let message: { kind: "result"; value: unknown } | { kind: "failure"; code: string };
try {
	const run = cases[data.caseName];
	assert(run, `unknown case ${data.caseName}`);
	message = { kind: "result", value: run() ?? "ok" };
} catch (error) {
	message = { kind: "failure", code: String((error as Error)?.stack ?? error).slice(0, 3000) };
} finally {
	for (const s of stores) s.close();
	stores.clear();
}
parentPort!.postMessage(message);
parentPort!.close();
