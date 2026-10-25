/**
 * Design B's current-week pass (Ops #423; Ops #420 PLAN.md 5.1, 5.3, 5.8; Architecture rm-8fb0f6a3 M7-M11, C1-C10).
 *
 * One bounded, single-flight pass, run by the host every 30 s inside a Worker (usage-accounting-pass-worker.ts):
 * a stat-only inventory of the current Pacific week's chat files, the appended bytes of changed files through the
 * #304 reader and its cursors, the usage-ledger tail through W2 with first/sameCall answered from the week store's
 * hash-checked receipts, a fold into B2's week log/observations, and the W5 SnapshotBuildInput. No model call, no
 * timer, no deletion or retention, no seal: B4 installs and B5 seals/backfills. Same-UID check-then-use windows
 * remain; the store's scope (docs/usage-accounting-week-store.md) excludes a hostile writer running as the same UID.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";
import type { IdentityAlias, SourceCoverage, UsageFact, AccountingInput } from "./usage-accounting-contract.js";
import type { WeekPassEvidence } from "./usage-accounting-evidence.js";
import {
	LEDGER_SOURCE_LIMITS,
	ledgerMeterFaultCounts,
	readUsageLedger,
	type LedgerCursor,
	type LedgerEvidenceReaders,
	type LedgerFault,
	type LedgerNativeReceipt,
	type LedgerSameCall,
} from "./usage-accounting-ledger-source.js";
import type { MeterCoveredSourceStatus } from "./usage-accounting-meter-contract.js";
import {
	closePassInventory,
	newPassInventory,
	passFileKey,
	scanPassInventory,
	type PassInventory,
} from "./usage-accounting-pass-scan.js";
import {
	decodePiSessionRecovery,
	encodePiSessionRecovery,
	PI_SESSION_LIMITS,
	PiSessionUsageReader,
	type PiSessionReadResult,
} from "./usage-accounting-pi-sessions.js";
import type { SnapshotBuildInput, SnapshotPartition, SnapshotSubjectRequest } from "./usage-accounting-snapshot.js";
import {
	UsageWeekStore,
	usageWeekBounds,
	usageWeekOf,
	type UsageWeekCheckpoint,
	type UsageWeekCursors,
	type UsageWeekObservationInput,
	type UsageWeekReceipt,
	type UsageWeekRecord,
	type UsageWeekReplayCursor,
	type UsageWeekStoreLimits,
} from "./usage-accounting-week-store.js";

/** PLAN 5.1: 64 MiB and 2 s of work a pass, slices of at most 25 ms; 10 min grace after Monday 00:00 Pacific. */
export const PASS_LIMITS = Object.freeze({
	bytes: 64 * 1024 * 1024,
	workMs: 2000,
	sliceMs: 25,
	graceMs: 10 * 60 * 1000,
	/** Architecture M8: one reader instance indexes at most 64 files and 10,000 entries; renew before either. */
	readerFiles: PI_SESSION_LIMITS.sources,
	readerEntries: PI_SESSION_LIMITS.indexEntries - PI_SESSION_LIMITS.batchRows,
	/** Architecture C1: worst real cost of one #304 read (old anchor + stretched line + skip piece + budgets). */
	readWorstBytes: 3 * PI_SESSION_LIMITS.lineBytes + 2 * PI_SESSION_LIMITS.readBytes + 65_536,
	/** Units (record + its observations/receipts) per store append: well inside B2's per-call limits. */
	flushUnits: 2048,
	flushObservationBytes: 12 * 1024 * 1024,
	/** One W5 partition: under METER_LIMITS.lookupRows (4,096) and lookupBytes (4 MiB) with margin. */
	partitionRows: 4000,
	partitionBytes: 3_500_000,
	/** Store pages replayed per catching-up step. */
	replayRows: 4096,
});
export type PassBudget = { bytes: number; workMs: number };
export type PassRole = { role: string; evidenceRef: string };
export interface PassOptions {
	dataDir: string;
	lease: SharedArrayBuffer;
	/** W5 generation epoch (hex64), fixed for this Worker. */
	epoch: string;
	/** Absolute chat-session roots (~/.pi/agent/sessions); nothing outside them is discovered. */
	sessionRoots: readonly string[];
	/** Native, source-owned Temper pi-worker roots, excluded (T0 owns them); never inferred from names. */
	temperRoots: readonly string[];
	/** Absolute usage-ledger directory, or null when the ledger is not a source. */
	ledgerDirectory: string | null;
	production: "enabled" | "disabled" | "unknown";
	subjects?: SnapshotSubjectRequest[];
	/** Verified source-role witness for a fact; B3 has no producer of its own (B4 wires one). Never from payerRole. */
	roleOf?: (file: string | null, fact: UsageFact) => PassRole | null;
	now?: () => number;
	clock?: () => number;
	storeLimits?: Partial<UsageWeekStoreLimits>;
	scan?: { files?: number; stats?: number };
	/** Tests only: awaited inside the pass to force a slow pass. */
	slow?: () => Promise<void>;
	/** Tests only: the order the pass reads changed files in (paths in, paths out), to control parent/child order. */
	readOrder?: (paths: readonly string[]) => readonly string[];
}
type Cursor = { ordinal: number; token: string };
type Group = "sessions" | "ledger";
type Rows = Pick<
	AccountingInput,
	"facts" | "allocations" | "aliases" | "roots" | "policies" | "memberships" | "snapshots"
>;
interface Unit {
	record: UsageWeekRecord | null;
	receipts: UsageWeekReceipt[];
	observations: UsageWeekObservationInput[];
	bytes: number;
}
interface WeekFold {
	week: string;
	start: string;
	end: string;
	state: "open" | "sealed" | "unavailable";
	/** Identity key (record k of an original) -> its numeric fingerprint and canonical fact id. */
	keys: Map<string, { fp: string; id: string | null }>;
	/** Every record key in the week log (the store keeps the first record under a key). */
	recs: Set<string>;
	/** Fact ids with revision (id#revision) in the week. */
	ids: Set<string>;
	unknown: Record<Group, number>;
	checkpoint: UsageWeekCheckpoint | null;
	/**
	 * Fact ids W5 must see in one partition (alias rows and revisions), as a union-find parent map. Only these stay
	 * in memory: the W5 rows themselves stream from the store's committed observations at build time (R-MEM).
	 */
	links: Map<string, string>;
	staged: Unit[];
	/**
	 * This pass's ledger-native proposals that are staged but not yet appended (Architecture #277 MF1). W2 remembers its
	 * own proposals only within one call, and a pass makes many calls before it commits, so first(key) answers from
	 * here before the store: a repeat in a later call meets its first, never a second "first". Cleared once appended.
	 */
	native: Map<string, LedgerNativeReceipt>;
	replay: {
		cursor: UsageWeekReplayCursor | null;
		ids: Set<string>;
		bound: Map<string, string>;
		links: Map<string, string>;
	} | null;
	replayed: boolean;
	/** Last week after the grace: its fold is dropped and the store no longer holds it. */
	released: boolean;
}
interface FileState {
	key: string;
	file: string;
	/** Week whose checkpoint holds this file's cursor. */
	week: string;
	cursor: Cursor | null;
	size: number;
	mtimeMs: number;
	/** Size at the last end of file, so an unchanged file is not opened again. */
	readSize: number | null;
	hint: string | null;
	state: "ready" | "eof" | "waiting" | "faulted";
	/**
	 * Waiting for the file to grow: it ends in a partial last line, or inside an unfinished line over the reader's
	 * line limit (Architecture #277 MF2, S3). Such a file is read again only once its size or mtime changes; a file
	 * waiting on event time is checked again every pass.
	 */
	growth: boolean;
	retried: boolean;
}
export interface PassState {
	options: Required<Pick<PassOptions, "now" | "clock">> & PassOptions;
	store: UsageWeekStore;
	running: boolean;
	broken: boolean;
	sequence: number;
	cur: WeekFold | null;
	prev: WeekFold | null;
	inventory: PassInventory | null;
	files: Map<string, FileState>;
	/** month: the file being read; the cursor stays the old month's until the new month's first read moves. */
	ledger: {
		cursor: LedgerCursor | null;
		month: string | null;
		window: string | null;
		eof: boolean;
		faults: LedgerFault[];
		/** [week, month, stat] taken before the read that last reached a clean end of the current month's file. */
		unchanged: string | null;
	};
	reader: { instance: PiSessionUsageReader; files: Set<string>; entries: number };
	lastComplete: Record<Group, string | null>;
	faults: Map<string, number>;
	history: number;
	readBytes: number;
	/** Set per pass: true once 10 min have passed since Monday 00:00 Pacific; last week then takes no rows. */
	graceOver: boolean;
	/** Code of the last refused pass (store error code or error name), never source contents. */
	lastError: string | null;
}
export interface PassResult {
	status: "busy" | "unavailable" | "catching-up" | "partial" | "fresh";
	week: string | null;
	asOf: string;
	sequence: number;
	completed: boolean;
	input: SnapshotBuildInput | null;
	stats: {
		workMs: number;
		ioMs: number;
		bytesRead: number;
		files: number;
		reads: number;
		records: number;
		history: number;
		backlogFiles: number;
		ledgerBytes: number;
	};
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const keyOf = (parts: unknown[]): string => sha(JSON.stringify(parts));
const iso = (ms: number): string => new Date(ms).toISOString();
const REF = /^[A-Za-z0-9_./:@+-]{1,128}$/;
const RATE = /^[A-Za-z0-9_./:@+-]{1,64}$/;
const ref = (v: unknown): string | null => (typeof v === "string" && REF.test(v) ? v : null);
const listPrice = (f: UsageFact) => f.prices.find((p) => p.basis === "list-estimate") ?? null;
const usdOf = (f: UsageFact): string | null => {
	const p = listPrice(f);
	return p && p.status === "known" && p.amount !== null ? p.amount : null;
};
const tokOf = (f: UsageFact): [number | null, number | null, number | null, number | null] => [
	f.tokens.input,
	f.tokens.output,
	f.tokens.cacheRead,
	f.tokens.cacheWrite,
];
const fpOf = (usd: string | null, tok: readonly (number | null)[]): string => JSON.stringify([usd, tok]);
const groupStream = (g: Group, week: string) =>
	`week-pass:${g === "sessions" ? "pi-sessions" : "usage-ledger"}:${week}`;
/** Meter fault codes for the pass's own faults (W5's METER_FAULT_CODES). */
const PASS_FAULT = {
	inventory: "inventory-partial",
	cursor: "cursor-conflict",
	truncated: "truncated-source",
	gap: "source-coverage",
	"event-time-order": "source-coverage",
	conflict: "event-conflict",
	unresolved: "unresolved-identity",
	backlog: "time-limit",
	store: "store-capacity",
	io: "io-failure",
	late: "source-coverage",
} as const;
/** W2 fault buckets that mean the ledger's coverage is unproven (identity/price buckets do not: the contract
 * already keeps those facts out of the known totals and counts them). */
const LEDGER_COVERAGE = new Set([
	"source-coverage",
	"source-unavailable",
	"truncated-source",
	"provenance-mismatch",
	"cursor-conflict",
	"batch-limit",
	"time-limit",
	"invalid-batch",
	"index-unavailable",
	"unknown-accounting-fault",
]);
/** Ledger stops the pass handles itself by reading on; everything else is a real fault bucket. */
const LEDGER_TRANSIENT = new Set([
	"window-mismatch",
	"read-limit",
	"record-limit",
	"batch-limit",
	"work-limit",
	"partial-last-line",
	"line-limit",
]);

function newWeek(week: string): WeekFold {
	const { start, end } = usageWeekBounds(week);
	return {
		week,
		start,
		end,
		state: "open",
		keys: new Map(),
		recs: new Set(),
		ids: new Set(),
		unknown: { sessions: 0, ledger: 0 },
		checkpoint: null,
		links: new Map(),
		staged: [],
		native: new Map(),
		replay: null,
		replayed: false,
		released: false,
	};
}
/** Union-find over fact ids: the root of id's component, or null when id is in no alias or revision chain. */
function linkRoot(links: Map<string, string>, id: string): string | null {
	if (!links.has(id)) return null;
	let r = id;
	for (let p = links.get(r)!; p !== r; p = links.get(r)!) r = p;
	for (let y = id; y !== r;) {
		const next = links.get(y)!;
		links.set(y, r);
		y = next;
	}
	return r;
}
function link(links: Map<string, string>, a: string, b: string = a): void {
	if (!links.has(a)) links.set(a, a);
	if (!links.has(b)) links.set(b, b);
	const ra = linkRoot(links, a)!,
		rb = linkRoot(links, b)!;
	if (ra !== rb) links.set(ra, rb);
}
const openStore = (o: PassState["options"]): UsageWeekStore =>
	UsageWeekStore.open({ dataDir: o.dataDir, lease: o.lease, limits: o.storeLimits, now: o.now });
const previousWeek = (week: string): string => usageWeekOf(iso(Date.parse(usageWeekBounds(week).start) - 1));

/** Opens the Worker's pass state. Nothing is read until the first runPass. */
export function openPassState(options: PassOptions): PassState {
	if (isMainThread) throw new Error("usage-pass-worker-required");
	if (!/^[0-9a-f]{64}$/.test(options.epoch)) throw new Error("usage-pass-epoch");
	const o = { now: () => Date.now(), clock: () => performance.now(), ...options };
	return {
		options: o,
		store: openStore(o),
		running: false,
		broken: false,
		sequence: 0,
		cur: null,
		prev: null,
		inventory: null,
		files: new Map(),
		ledger: { cursor: null, month: null, window: null, eof: false, faults: [], unchanged: null },
		reader: { instance: new PiSessionUsageReader(), files: new Set(), entries: 0 },
		lastComplete: { sessions: null, ledger: null },
		faults: new Map(),
		history: 0,
		readBytes: 0,
		graceOver: false,
		lastError: null,
	};
}
export function closePassState(s: PassState): void {
	if (s.inventory) closePassInventory(s.inventory);
	s.store.close();
}

/** Ledger month files' digests a week's records may carry as src (to group unknown records by source kind). */
function ledgerSrcs(s: PassState, w: WeekFold): Set<string> {
	const dir = s.options.ledgerDirectory;
	const out = new Set<string>();
	if (!dir) return out;
	for (let t = Date.parse(w.start) - 32 * 86_400_000; t <= Date.parse(w.end); t += 86_400_000)
		out.add(passFileKey(join(dir, `${iso(t).slice(0, 7)}.jsonl`)));
	return out;
}

/** Loads one week's numeric log (keys, record keys, unknowns); observations are replayed by catchUp. */
function loadWeek(s: PassState, w: WeekFold): void {
	const ledger = ledgerSrcs(s, w);
	const records: UsageWeekRecord[] = [];
	const load = s.store.reload(w.week, (r, from) => {
		if (from === "log") records.push(r);
	});
	if (load.state === "unavailable") {
		w.state = "unavailable";
		return;
	}
	if (load.state === "empty") {
		w.replayed = true;
		return;
	}
	if (load.state === "sealed") w.state = "sealed";
	const coverage = s.store.observationCoverage(w.week);
	if (coverage.state === "legacy") {
		w.state = "unavailable";
		return;
	}
	w.checkpoint = load.checkpoint && load.checkpoint.v === "usage-week-checkpoint/2" ? load.checkpoint : null;
	for (const r of records) {
		w.recs.add(r.k);
		if (r.d === "original") w.keys.set(r.k, { fp: fpOf(r.usd, r.tok), id: null });
		else if (r.d !== "alias") w.unknown[ledger.has(r.src) ? "ledger" : "sessions"]++;
	}
	w.replay = { cursor: null, ids: new Set(), bound: new Map(), links: new Map() };
}

/** Replays the week's committed observations in pages; nothing folds until every page is in (pages are
 * provisional until the store's final hash check). Returns true when done. */
function catchUp(s: PassState, w: WeekFold, deadline: number): boolean {
	if (w.replayed || w.state === "unavailable") return true;
	const r = w.replay!;
	while (s.options.clock() < deadline) {
		const page = s.store.observations(w.week, r.cursor, PASS_LIMITS.replayRows);
		for (const o of page.observations) {
			if (o.o === "fact") {
				r.ids.add(`${o.r.id}#${o.r.revision}`);
				if (o.rk !== null && !r.bound.has(o.rk)) r.bound.set(o.rk, o.r.id);
				if (o.r.revision > 0) link(r.links, o.r.id);
			} else if (o.o === "alias") link(r.links, o.r.aliasFactId, o.r.canonicalFactId);
		}
		r.cursor = page.next;
		if (page.next === null) {
			w.ids = r.ids;
			for (const [k, id] of r.bound) {
				const key = w.keys.get(k);
				if (key && key.id === null) key.id = id;
			}
			w.links = r.links;
			w.replay = null;
			w.replayed = true;
			return true;
		}
	}
	return false;
}

function bump(s: PassState, code: keyof typeof PASS_FAULT, n = 1): void {
	s.faults.set(PASS_FAULT[code], (s.faults.get(PASS_FAULT[code]) ?? 0) + n);
}

/** The week a timestamp is accounted in: current, previous (only until the grace ends), or history: older weeks
 * are B5's backfill, and last week's rows after the grace are B5's adjustments (counted here as late). */
function weekFor(s: PassState, at: string): WeekFold | "history" | "future" {
	if (at >= s.cur!.end) return "future";
	if (at >= s.cur!.start) return s.cur!;
	if (s.prev && at >= s.prev.start && !s.graceOver) return s.prev;
	return "history";
}
const lastWeek = (s: PassState, at: string | null): boolean =>
	!!s.prev && !!at && at >= s.prev.start && at < s.prev.end;

interface Candidate {
	fact: UsageFact;
	/** Identity key parts, or null when the source gives none (then the record is unknown, never charged). */
	key: unknown[] | null;
	alias: IdentityAlias | null;
	src: string;
	off: number;
	len: number | null;
	group: Group;
	file: string | null;
	evidenceRef: string;
	sameCall: { provider: string; responseId: string } | null;
}

/**
 * Folds one observed fact into its week (PLAN 5.3, Architecture M7/M8/C9): an unseen identity key becomes the
 * original; a seen key with another fact id and the same numbers becomes an alias of the committed canonical
 * (counted once); the same fact id again is a duplicate (nothing written); different numbers are an event
 * conflict, kept unknown. Exported for the W0 fixture equality tests; the pass uses it for every source.
 */
export function foldCandidate(s: PassState, w: WeekFold, c: Candidate): "original" | "alias" | "duplicate" | "unknown" {
	const f = c.fact;
	const usd = usdOf(f),
		tok = tokOf(f);
	const fp = fpOf(usd, tok);
	const role = s.options.roleOf?.(c.file, f) ?? null;
	const task = f.links.task;
	const sub: UsageWeekRecord["sub"] = {
		role: role && REF.test(role.role) ? role.role : null,
		project: ref(task?.project),
		initiative: ref(task?.initiative),
		task: task ? { q: sha(task.queue), n: task.task, at: task.addedAt } : null,
	};
	const rate = listPrice(f)?.rateVersion ?? null;
	const record = (k: string, d: UsageWeekRecord["d"]): UsageWeekRecord => ({
		k,
		d,
		at: f.occurredAt,
		src: c.src,
		off: c.off,
		len: c.len,
		sub,
		usd,
		tok,
		rate: rate !== null && RATE.test(rate) ? rate : null,
	});
	const unknown = (k: string, fact: UsageFact): "unknown" => {
		if (w.recs.has(k) || w.ids.has(`${fact.id}#${fact.revision}`)) return "unknown";
		stage(w, record(k, fact.identityStatus === "unresolved" ? "unresolved" : "unverified"), fact, null, role, []);
		w.unknown[c.group]++;
		return "unknown";
	};
	if (c.key === null || f.identityStatus === "unresolved") {
		bump(s, "unresolved");
		return unknown(keyOf(["unresolved", f.id, f.revision]), { ...f, identityStatus: "unresolved" });
	}
	let k = keyOf(c.key);
	if (f.revision > 0) k = keyOf([k, "revision", f.revision]);
	const old = w.keys.get(k);
	// A native alias names its canonical directly; adopt the committed canonical when the key maps elsewhere.
	if (c.alias) {
		const canonical = old?.id ?? (w.ids.has(`${c.alias.canonicalFactId}#0`) ? c.alias.canonicalFactId : null);
		if (canonical !== null && canonical !== f.id) return alias(canonical);
	}
	if (!old) {
		if (w.ids.has(`${f.id}#${f.revision}`)) return "duplicate";
		w.keys.set(k, { fp, id: f.id });
		const receipts: UsageWeekReceipt[] = [];
		if (c.sameCall)
			receipts.push({
				kind: "same-call",
				k: keyOf([c.sameCall.provider, c.sameCall.responseId]),
				r: {
					provider: c.sameCall.provider,
					responseId: c.sameCall.responseId,
					canonical: f,
					evidenceRef: c.evidenceRef,
				} satisfies LedgerSameCall,
			});
		stage(w, record(k, "original"), f, null, role, receipts);
		return "original";
	}
	if (old.id === f.id) {
		if (old.fp !== fp) {
			bump(s, "conflict");
			const gap = keyOf(["conflict", c.src, c.off]);
			if (!w.recs.has(gap)) {
				stage(
					w,
					{ ...record(gap, "gap"), usd: null, tok: [null, null, null, null], rate: null, len: c.len ?? 1 },
					null,
					null,
					null,
					[],
				);
				w.unknown[c.group]++;
			}
		}
		return "duplicate";
	}
	if (old.id === null || old.fp !== fp) {
		bump(s, "conflict");
		return unknown(keyOf(["conflict", f.id, f.revision]), { ...f, identityStatus: "unresolved" });
	}
	return alias(old.id);

	function alias(canonical: string): "alias" | "duplicate" {
		const ak = keyOf(["alias", f.id, f.revision]);
		if (w.recs.has(ak) || w.ids.has(`${f.id}#${f.revision}`)) return "duplicate";
		const row: IdentityAlias = {
			aliasFactId: f.id,
			canonicalFactId: canonical,
			provenance: "native-call-map/1",
			evidenceRef: c.alias?.evidenceRef ?? c.evidenceRef,
		};
		stage(w, record(ak, "alias"), f, row, role, []);
		return "alias";
	}
}

function stage(
	w: WeekFold,
	record: UsageWeekRecord,
	fact: UsageFact | null,
	alias: IdentityAlias | null,
	role: PassRole | null,
	receipts: UsageWeekReceipt[],
): void {
	const observations: UsageWeekObservationInput[] = [];
	let bytes = 1024;
	if (fact) {
		const text = JSON.stringify(fact);
		observations.push({ o: "fact", r: fact, rk: record.k });
		bytes += text.length;
		w.ids.add(`${fact.id}#${fact.revision}`);
		if (fact.revision > 0) link(w.links, fact.id);
		// The role witness right after its fact, in the same unit: W5's partitions place it by that adjacency.
		if (role)
			observations.push({
				o: "fact-role",
				r: { factId: fact.id, role: role.role, evidenceRef: role.evidenceRef },
				rk: record.k,
			});
	}
	if (alias) {
		observations.push({ o: "alias", r: alias, rk: record.k });
		link(w.links, alias.aliasFactId, alias.canonicalFactId);
	}
	for (const r of receipts) bytes += JSON.stringify(r).length;
	w.recs.add(record.k);
	w.staged.push({ record, receipts, observations, bytes });
}

/** Commits a week's staged units, then its checkpoint with the given cursors (the commit point, B2 doc :41-55). */
function flush(s: PassState, w: WeekFold, cursors: UsageWeekCursors | undefined): void {
	if (w.state !== "open") {
		if (w.staged.length) bump(s, "late", w.staged.length);
		w.staged = [];
		w.native.clear();
		return;
	}
	let i = 0;
	while (i < w.staged.length) {
		const records: UsageWeekRecord[] = [],
			receipts: UsageWeekReceipt[] = [],
			observations: UsageWeekObservationInput[] = [];
		let bytes = 0;
		for (; i < w.staged.length && records.length < PASS_LIMITS.flushUnits; i++) {
			const u = w.staged[i];
			if (records.length && bytes + u.bytes > PASS_LIMITS.flushObservationBytes) break;
			if (u.record) records.push(u.record);
			receipts.push(...u.receipts);
			observations.push(...u.observations);
			bytes += u.bytes;
		}
		s.store.append(w.week, records, receipts, observations);
	}
	w.staged = [];
	// Appended: the store answers these keys now (a failed append throws first, and the folds are rebuilt).
	w.native.clear();
	w.checkpoint = s.store.checkpoint(w.week, cursors);
}

function cursorsFor(s: PassState, w: WeekFold): UsageWeekCursors {
	const files: UsageWeekCursors["files"] = { ...w.checkpoint?.files };
	for (const f of s.files.values())
		if (f.week === w.week && f.cursor)
			files[f.key] = { cursor: f.cursor, size: f.size, mtimeMs: Math.floor(f.mtimeMs) };
	return { files, ledger: w === s.cur ? s.ledger.cursor : (w.checkpoint?.ledger ?? null) };
}

function commit(s: PassState): void {
	if (s.prev && (s.prev.staged.length || [...s.files.values()].some((f) => f.week === s.prev!.week)))
		flush(s, s.prev, s.prev.state === "open" ? cursorsFor(s, s.prev) : undefined);
	flush(s, s.cur!, cursorsFor(s, s.cur!));
}

/**
 * After the grace last week takes no rows (weekFor), so its fold is dropped and the store reopened: the store keeps
 * every week it has loaded until close(), so without this a long-lived Worker would hold one more week each week
 * (R-MEM). The current week, if any, is loaded again into the new store; the pass's own fold of it is kept.
 */
function releasePrevious(s: PassState): void {
	const p = s.prev!;
	const stub = newWeek(p.week);
	stub.state = p.state === "unavailable" ? "unavailable" : "sealed";
	stub.checkpoint = p.checkpoint;
	stub.replayed = true;
	stub.released = true;
	s.prev = stub;
	s.store.close();
	s.store = openStore(s.options);
	if (!s.cur) return;
	// A replay in progress belonged to the old store's stream: it starts again from the first page.
	if (s.cur.replay) s.cur.replay = { cursor: null, ids: new Set(), bound: new Map(), links: new Map() };
	if (s.store.status().state === "ready" && s.store.reload(s.cur.week).state === "unavailable")
		s.cur.state = "unavailable";
}

/** Week change, restart or a broken store: rebuild the folds and file table from the committed checkpoints. */
function startWeek(s: PassState, week: string, graceOver: boolean): void {
	const old = s.cur;
	if (old && old.week === previousWeek(week) && !s.broken) {
		// Monday rollover: last week stays appendable (keys only) through the grace; its files keep their cursors.
		s.prev = old;
	} else {
		s.prev = newWeek(previousWeek(week));
		s.files.clear();
		if (!graceOver) loadWeek(s, s.prev);
		else {
			const load = s.store.reload(s.prev.week);
			if (load.state === "unavailable") s.prev.state = "unavailable";
			else if (load.state !== "empty" && load.checkpoint?.v === "usage-week-checkpoint/2")
				s.prev.checkpoint = load.checkpoint;
		}
	}
	// Past the grace already (a restart mid-week): keep last week's checkpoint (file and ledger cursors), not its fold.
	s.cur = null;
	if (graceOver) releasePrevious(s);
	s.cur = newWeek(week);
	loadWeek(s, s.cur);
	if (s.inventory) closePassInventory(s.inventory);
	s.inventory = newPassInventory(week);
	const ledgerCursor = s.cur.checkpoint?.ledger ?? s.prev.checkpoint?.ledger ?? null;
	s.ledger = {
		cursor: ledgerCursor,
		month: ledgerCursor ? ledgerMonth(ledgerCursor, s.cur.start.slice(0, 7)) : null,
		window: null,
		eof: false,
		faults: [],
		unchanged: null,
	};
	if (s.files.size === 0)
		for (const w of [s.prev, s.cur])
			for (const [key, c] of Object.entries(w.checkpoint?.files ?? {}))
				s.files.set(key, {
					key,
					file: "",
					week: w.week,
					cursor: c.cursor,
					size: c.size,
					mtimeMs: c.mtimeMs,
					readSize: null,
					hint: null,
					state: "ready",
					growth: false,
					retried: false,
				});
	s.lastComplete = { sessions: null, ledger: null };
	s.broken = false;
}

function renewReader(s: PassState): void {
	s.reader = { instance: new PiSessionUsageReader(), files: new Set(), entries: 0 };
}

/** Folds one #304 read's observations (Architecture M7/M8, C10). */
function foldSession(s: PassState, f: FileState, r: PiSessionReadResult, w: WeekFold): void {
	const facts = new Map((r.batch?.rows.facts ?? []).map((x) => [x.id, x]));
	const aliases = new Map((r.batch?.rows.aliases ?? []).map((x) => [x.aliasFactId, x]));
	for (const o of r.observations) {
		const at = o.entryTimestamp && o.entryTimestamp >= w.start && o.entryTimestamp < w.end ? o.entryTimestamp : w.start;
		const fact = o.factId ? facts.get(o.factId) : undefined;
		if (!fact) {
			// Same fact id already produced by another file (a resumed session's copy): nothing new to count.
			if (o.factId && w.ids.has(`${o.factId}#0`)) continue;
			const k = keyOf(["unverified", f.key, o.offset]);
			if (!w.recs.has(k)) {
				stage(
					w,
					{
						k,
						d: "unverified",
						at,
						src: f.key,
						off: o.offset,
						len: o.bytes,
						sub: { role: null, project: null, initiative: null, task: null },
						usd: null,
						tok: [null, null, null, null],
						rate: null,
					},
					null,
					null,
					null,
					[],
				);
				w.unknown.sessions++;
				bump(s, "unresolved");
			}
			continue;
		}
		let use = fact;
		// A copy without responseId whose parent this reader instance has not indexed is unverified only for lack
		// of the parent (M8). The week's [entryId, entryTimestamp] key decides it: unseen -> counts, seen -> alias.
		if (
			o.disposition === "unverified" &&
			!o.responseId &&
			r.parentFileKey !== null &&
			o.canonicalFactId === o.factId &&
			o.entryId !== null
		)
			use = { ...fact, identityStatus: "verified" };
		const key = o.responseId ? [use.provider, o.responseId] : o.entryId ? ["entry", o.entryId, o.entryTimestamp] : null;
		foldCandidate(s, w, {
			fact: use,
			key,
			alias: aliases.get(fact.id) ?? null,
			src: f.key,
			off: o.offset,
			len: o.bytes,
			group: "sessions",
			file: f.file,
			evidenceRef: `week-pass:${f.key}:${o.offset}`,
			sameCall:
				o.responseId && use.identityStatus === "verified" ? { provider: use.provider, responseId: o.responseId } : null,
		});
	}
}

/** Reads one file as far as the budget allows. Returns false when the pass must stop (budget). */
async function readFile(
	s: PassState,
	f: FileState,
	T: string,
	budget: { bytes: number; deadline: number },
	stats: PassResult["stats"],
): Promise<boolean> {
	const Tms = Date.parse(T);
	for (;;) {
		if (s.options.clock() >= budget.deadline || budget.bytes < PASS_LIMITS.readWorstBytes) return false;
		// The window is the week of the first unread entry (the reader's timestamp hint), else the current week.
		const at = f.hint ?? s.cur!.start;
		if (Date.parse(at) > Tms) {
			f.state = "waiting";
			bump(s, "event-time-order");
			return true;
		}
		const target = weekFor(s, at);
		const week = target === "history" ? usageWeekOf(at) : target === "future" ? s.cur!.week : target.week;
		const bounds = usageWeekBounds(week);
		const through = iso(Math.min(Date.parse(bounds.end) - 1, Tms));
		if (!s.reader.files.has(f.key) && s.reader.files.size >= PASS_LIMITS.readerFiles) renewReader(s);
		if (s.reader.entries >= PASS_LIMITS.readerEntries) renewReader(s);
		s.reader.files.add(f.key);
		const saved = f.cursor;
		const recovery = saved && saved.token.startsWith("pis1:") ? decodePiSessionRecovery(saved) : null;
		const t0 = s.options.clock();
		const r = await s.reader.instance.read({
			file: f.file,
			producer: "pi",
			from: bounds.start,
			through,
			observedAt: T,
			...(recovery ? { recovery } : { cursor: saved }),
			recoverOversized: true,
		});
		stats.ioMs += s.options.clock() - t0;
		stats.reads++;
		stats.bytesRead += r.bytesRead;
		budget.bytes -= r.bytesRead;
		s.reader.entries += r.observations.length;
		const codes = new Set(r.faults.map((x) => x.code));
		if (codes.has("cursor-changed") || codes.has("cursor-invalid") || codes.has("source-truncated")) {
			// M7: rewritten, shrunk or replaced file: drop its cursor and read again from byte 0; keys dedupe.
			bump(s, codes.has("source-truncated") ? "truncated" : "cursor");
			renewReader(s);
			if (f.retried || saved === null) {
				f.state = "faulted";
				f.readSize = f.size;
				return true;
			}
			f.retried = true;
			f.cursor = null;
			f.hint = null;
			continue;
		}
		if (codes.has("source-unreadable") || codes.has("header-invalid")) {
			bump(s, "gap");
			f.state = "faulted";
			f.readSize = f.size;
			return true;
		}
		if (codes.has("index-limit")) {
			renewReader(s);
			if (!r.batch) continue;
		}
		const history = target === "history";
		const w = history ? null : target === "future" ? s.cur! : target;
		if (w && w.state === "open") {
			foldSession(s, f, r, w);
			if (r.skipped) {
				const k = keyOf(["oversized", f.key, r.skipped.start]);
				if (!w.recs.has(k)) {
					stage(
						w,
						{
							k,
							d: "gap",
							at: w === s.cur ? T : w.start,
							src: f.key,
							off: r.skipped.start,
							len: Math.max(1, r.skipped.bytes),
							sub: { role: null, project: null, initiative: null, task: null },
							usd: null,
							tok: [null, null, null, null],
							rate: null,
						},
						null,
						null,
						null,
						[],
					);
					w.unknown.sessions++;
					bump(s, "gap");
				}
			}
			for (const x of r.faults)
				if (x.code === "invalid-json" || x.code === "invalid-record") {
					const k = keyOf(["fault", f.key, x.code, x.line]);
					if (!w.recs.has(k)) {
						stage(
							w,
							{
								k,
								d: "gap",
								at: w === s.cur ? T : w.start,
								src: f.key,
								off: x.line,
								len: 1,
								sub: { role: null, project: null, initiative: null, task: null },
								usd: null,
								tok: [null, null, null, null],
								rate: null,
							},
							null,
							null,
							null,
							[],
						);
						w.unknown.sessions++;
						bump(s, "gap");
					}
				}
		} else if (r.observations.length || r.skipped) {
			s.history += r.observations.length;
			stats.history += r.observations.length;
			if (w || lastWeek(s, at)) bump(s, "late", Math.max(1, r.observations.length));
		}
		const before = f.cursor?.token ?? null;
		f.cursor = r.recovery ? encodePiSessionRecovery(r.recovery) : (r.cursor ?? f.cursor);
		const moved = (f.cursor?.token ?? null) !== before;
		if (r.skipped && (!moved || r.skipped.bytes === 0)) {
			// Architecture #277 MF2: the file ends inside an unfinished line over the line limit. Its gap is recorded
			// once (above); reading again before the file grows would only re-check the same anchor, round after round.
			f.state = "waiting";
			f.growth = true;
			f.readSize = f.size;
			return true;
		}
		if (codes.has("window-mismatch") && r.nextWindowAt) {
			const next = usageWeekOf(r.nextWindowAt);
			if (next === week && !moved) {
				f.state = "waiting";
				bump(s, "event-time-order");
				return true;
			}
			f.hint = r.nextWindowAt;
			continue;
		}
		if (r.endOfFile) {
			f.state = "eof";
			f.readSize = f.size;
			f.hint = null;
			return true;
		}
		if (codes.has("partial-last-line")) {
			// Only an append can finish the line: wait for the file to grow (Architecture #277 S3).
			f.state = "waiting";
			f.growth = true;
			f.readSize = f.size;
			return true;
		}
		if (!moved && !r.skipped) {
			// No progress and no known reason to read again this pass.
			f.state = "waiting";
			bump(s, "gap");
			return true;
		}
	}
}

function ledgerMonth(cursor: LedgerCursor | null, fallback: string): string {
	const m = cursor ? /^ledger1:(\d{4}-\d{2}):/.exec(cursor.incarnation) : null;
	return m ? m[1] : fallback;
}

/** Reads the ledger tail one Pacific-week window at a time (Architecture M10), after the sessions. */
function readLedger(s: PassState, T: string, deadline: number, stats: PassResult["stats"]): void {
	const dir = s.options.ledgerDirectory;
	if (!dir) return;
	const Tmonth = T.slice(0, 7);
	// First run: the UTC month of the current week's start; older lines are B5's history.
	let month = s.ledger.month ?? s.cur!.start.slice(0, 7);
	const signature = () => {
		try {
			const st = statSync(join(dir, `${month}.jsonl`), { bigint: true });
			return JSON.stringify([
				s.cur!.week,
				month,
				`${st.dev}`,
				`${st.ino}`,
				`${st.size}`,
				`${st.mtimeNs}`,
				`${st.ctimeNs}`,
			]);
		} catch {
			return null;
		}
	};
	// Stat-only, like the session files (PLAN 5.1): the last read reached a clean end of this month's file and
	// nothing about the file has changed since, so there is nothing new to read and its faults still stand.
	// Within the week store's scope (no hostile same-UID writer); W2's anchors recheck once the file changes.
	if (s.ledger.eof && s.ledger.unchanged !== null && month === Tmonth && signature() === s.ledger.unchanged) return;
	s.ledger.unchanged = null;
	s.ledger.faults = [];
	s.ledger.eof = false;
	s.ledger.month = month;
	const src = () => passFileKey(join(dir, `${month}.jsonl`));
	const cursorOf = () => (s.ledger.cursor && ledgerMonth(s.ledger.cursor, "") === month ? s.ledger.cursor : null);
	let calls = 0;
	while (s.options.clock() < deadline && calls < 64) {
		calls++;
		const monthStart = Date.parse(`${month}-01T00:00:00.000Z`);
		const weeks: string[] = [];
		for (let w = usageWeekOf(iso(monthStart)); Date.parse(usageWeekBounds(w).start) <= Date.parse(T);) {
			weeks.push(w);
			w = usageWeekOf(usageWeekBounds(w).end);
		}
		const startAt =
			s.ledger.window && weeks.includes(s.ledger.window) ? weeks.indexOf(s.ledger.window) : weeks.length - 1;
		const order = [...weeks.slice(startAt), ...weeks.slice(0, startAt).reverse()];
		let progressed = false,
			stop = false;
		for (const week of order) {
			if (s.options.clock() >= deadline) return;
			const bounds = usageWeekBounds(week);
			const target = weekFor(s, bounds.start);
			const w = typeof target === "string" ? null : target;
			// A week not loaded (history) gets null readers: its rows go to history below and are never folded, so W2's
			// "null is a proven absent key" can never charge from them.
			const readers: LedgerEvidenceReaders = w
				? {
						// This pass's staged proposals first (MF1), then the hash-checked committed receipts.
						first: (key) =>
							w.native.get(key) ?? (s.store.receipt(w.week, "ledger-native", key) as LedgerNativeReceipt | null),
						sameCall: (provider, responseId) =>
							s.store.receipt(w.week, "same-call", keyOf([provider, responseId])) as LedgerSameCall | null,
					}
				: { first: () => null, sameCall: () => null };
			const t0 = s.options.clock();
			const before = signature();
			let r;
			try {
				r = readUsageLedger(
					{
						directory: dir,
						month,
						from: bounds.start,
						through: iso(Math.min(Date.parse(bounds.end) - 1, Date.parse(T))),
						observedAt: T,
						production: s.options.production,
						cursor: cursorOf(),
					},
					readers,
					s.options.clock,
				);
			} catch {
				s.ledger.faults.push({ code: "source-unreadable", line: 0 } as LedgerFault);
				return;
			}
			stats.ioMs += s.options.clock() - t0;
			stats.ledgerBytes += r.bytesRead;
			s.readBytes += r.bytesRead;
			const from = cursorOf()?.byte ?? -1;
			if (r.cursor && r.cursor.byte !== from) {
				progressed = true;
				s.ledger.window = week;
				if (w && w.state === "open") foldLedger(s, w, r, src(), T);
				else {
					s.history += r.observations.length;
					stats.history += r.observations.length;
					if ((w || lastWeek(s, bounds.start)) && r.observations.length) bump(s, "late", r.observations.length);
				}
				s.ledger.cursor = r.cursor;
			}
			for (const x of r.faults) if (!LEDGER_TRANSIENT.has(x.code)) s.ledger.faults.push(x);
			const codes = new Set(r.faults.map((x) => x.code));
			if (r.endOfFile) {
				if (month < Tmonth) {
					month = iso(Date.parse(`${month}-01T00:00:00.000Z`) + 32 * 86_400_000).slice(0, 7);
					s.ledger.month = month;
					s.ledger.window = null;
					progressed = true;
					break;
				}
				s.ledger.eof = true;
				s.ledger.unchanged = codes.has("partial-last-line") ? null : before;
				return;
			}
			if (progressed) break;
			if (!codes.has("window-mismatch")) {
				if (!codes.has("partial-last-line")) stop = true;
				else s.ledger.eof = true;
				break;
			}
		}
		if (stop || !progressed) {
			if (!progressed && !s.ledger.eof) bump(s, "event-time-order");
			return;
		}
	}
}

function foldLedger(s: PassState, w: WeekFold, r: ReturnType<typeof readUsageLedger>, src: string, T: string): void {
	const facts = new Map((r.batch?.rows.facts ?? []).map((x) => [x.id, x]));
	const aliases = new Map((r.batch?.rows.aliases ?? []).map((x) => [x.aliasFactId, x]));
	for (const o of r.observations) {
		if (o.disposition === "duplicate" || o.disposition === "aggregate") continue;
		const fact = o.factId ? facts.get(o.factId) : undefined;
		if (!fact || o.disposition === "conflict" || fact.occurredAt < w.start || fact.occurredAt >= w.end) {
			const k = keyOf(["ledger-gap", src, o.line]);
			if (!w.recs.has(k)) {
				stage(
					w,
					{
						k,
						d: "gap",
						at: w === s.cur ? T : w.start,
						src,
						off: o.line,
						len: 1,
						sub: { role: null, project: null, initiative: null, task: null },
						usd: null,
						tok: [null, null, null, null],
						rate: null,
					},
					null,
					null,
					null,
					[],
				);
				w.unknown.ledger++;
				bump(s, o.disposition === "conflict" ? "conflict" : "gap");
			}
			continue;
		}
		foldCandidate(s, w, {
			fact,
			key: ["ledger", fact.id],
			alias: o.disposition === "alias" ? (aliases.get(fact.id) ?? null) : null,
			src,
			off: o.line,
			len: null,
			group: "ledger",
			file: null,
			evidenceRef: `week-pass:${src}:${o.line}`,
			sameCall: null,
		});
	}
	// W2's own first-receipts, committed with the batch so first(key) is answered from the hash-checked store.
	const units = w.staged.length ? w.staged[w.staged.length - 1] : null;
	for (const n of r.nativeReceipts) {
		if (n.fact.occurredAt < w.start || n.fact.occurredAt >= w.end) continue;
		const receipt: UsageWeekReceipt = { kind: "ledger-native", k: n.key, r: n };
		w.native.set(n.key, n);
		if (units) units.receipts.push(receipt);
		else w.staged.push({ record: null, receipts: [receipt], observations: [], bytes: JSON.stringify(receipt).length });
	}
}

/** W5's input from the current week's rows: alias/revision components packed into partitions (M9, C5). */
export function buildPassInput(s: PassState, T: string, completed: boolean): SnapshotBuildInput {
	const w = s.cur!;
	const groups: Group[] = s.options.ledgerDirectory ? ["sessions", "ledger"] : ["sessions"];
	const coverage: SourceCoverage[] = [];
	const sources: SnapshotBuildInput["sources"] = [];
	const inventoryComplete = !!s.inventory?.complete;
	const backlog = [...s.files.values()].some((f) => f.week === w.week && f.state === "ready");
	groups.forEach((g, index) => {
		const done =
			g === "sessions"
				? inventoryComplete && !backlog && [...s.files.values()].every((f) => f.week !== w.week || f.state === "eof")
				: s.ledger.eof && ledgerMeterFaultCounts(s.ledger.faults).every((f) => !LEDGER_COVERAGE.has(f.code));
		const complete = done && w.unknown[g] === 0 && w.state === "open";
		if (complete) s.lastComplete[g] = T;
		const through = complete ? T : (s.lastComplete[g] ?? w.start);
		coverage.push({
			stream: groupStream(g, w.week),
			from: w.start,
			through,
			observedAt: T,
			status: complete ? "complete" : "partial",
		});
		const status: MeterCoveredSourceStatus = {
			index,
			kind: "pi",
			required: true,
			enabled: true,
			state: complete ? "complete" : "partial",
			complete_through: through,
			observedAt: T,
			lastProgressAt: T,
			stalled: false,
			alarm: null,
		};
		sources.push({ stream: groupStream(g, w.week), status });
	});
	const faultCounts = new Map<string, number>(s.faults);
	if (!inventoryComplete) faultCounts.set("inventory-partial", (faultCounts.get("inventory-partial") ?? 0) + 1);
	if (backlog) faultCounts.set("time-limit", (faultCounts.get("time-limit") ?? 0) + 1);
	for (const f of ledgerMeterFaultCounts(s.ledger.faults))
		faultCounts.set(f.code, (faultCounts.get(f.code) ?? 0) + f.count);
	const evidence: WeekPassEvidence = {
		v: "usage-evidence/2",
		producer: "week-pass",
		sequence: s.sequence,
		asOf: T,
		storage: w.state === "unavailable" ? "unavailable" : "healthy",
		inventoryComplete,
		requiredStreams: sources.map((x) => x.stream).sort(),
		faults: [],
		faultCounts: [...faultCounts].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({ code, count })),
	};
	return {
		epoch: s.options.epoch,
		asOf: T,
		evidence,
		coverage,
		sources,
		subjects: s.options.subjects ?? [],
		// The sequence is read now: a generator's body runs only when W5 starts taking partitions.
		partitions: partitions(s, w, evidence, s.sequence),
		completed,
	};
}

type FactRole = SnapshotPartition["factRoles"][number];
/** A buffered alias/revision component: W5 needs all of its facts and aliases in one partition. */
interface Held {
	facts: UsageFact[];
	aliases: IdentityAlias[];
	roles: FactRole[];
	bytes: number;
}

/**
 * W5's partitions, streamed from the week's committed observations (the store's hash-checked replay; a mismatch at
 * the end throws, so W5 builds nothing from a changed file). Facts outside any alias or revision chain go out in file
 * order with the role witness that follows them; chained facts are held until the end and go out by component.
 * Only for the pass that built the input: a later pass makes it throw (its evidence would no longer match).
 */
function* partitions(
	s: PassState,
	w: WeekFold,
	evidence: WeekPassEvidence,
	sequence: number,
): Generator<SnapshotPartition> {
	const fresh = () => {
		if (s.sequence !== sequence || s.running || s.cur !== w) throw new Error("usage-pass-stale-input");
	};
	fresh();
	// W5 allows at most 1,024 sources and #304 streams are per file, so facts move onto their group's stream here
	// (the store keeps the native row). The contract's event-collision key is [producer, incarnation, stream,
	// event]: the event becomes a digest of the native [stream, event] pair, so two files that share a header id
	// and an entry id (a resumed copy) stay two events, exactly as under their native streams.
	const stream = (f: UsageFact): UsageFact => ({
		...f,
		source: {
			...f.source,
			stream: groupStream(f.source.stream.startsWith("usage-ledger:") ? "ledger" : "sessions", w.week),
			event: `e:${sha(JSON.stringify([f.source.stream, f.source.event])).slice(0, 40)}`,
		},
	});
	let facts: UsageFact[] = [],
		aliases: IdentityAlias[] = [],
		factRoles: SnapshotPartition["factRoles"] = [],
		count = 0,
		bytes = 0;
	const out = (): SnapshotPartition => {
		const rowsOut: Rows = { facts, allocations: [], aliases, roots: [], policies: [], memberships: [], snapshots: [] };
		const p = { evidence, rows: rowsOut, factRoles };
		facts = [];
		aliases = [];
		factRoles = [];
		count = 0;
		bytes = 0;
		return p;
	};
	// W5 measures Buffer.byteLength(JSON.stringify({rows, factRoles})) against METER_LIMITS.lookupBytes, so the
	// budget counts what goes out: the projected fact (its stream and event change size), aliases and roles.
	const size = (x: unknown) => Buffer.byteLength(JSON.stringify(x)) + 1;
	// A role witness may follow its fact into the partition after the size check: PASS_LIMITS.partitionBytes leaves
	// more than half a MiB under W5's 4 MiB for it.
	const held = new Map<string, Held>();
	const hold = (root: string): Held =>
		held.get(root) ?? held.set(root, { facts: [], aliases: [], roles: [], bytes: 0 }).get(root)!;
	let last: string | null = null;
	let cursor: UsageWeekReplayCursor | null = null;
	do {
		fresh();
		let page: ReturnType<UsageWeekStore["observations"]>;
		try {
			page = s.store.observations(w.week, cursor, PASS_LIMITS.replayRows);
		} catch (error) {
			// A changed or damaged observations file: W5 records index-unavailable, the next pass rebuilds from the
			// checkpoints (and finds the week unavailable until it is repaired).
			s.broken = true;
			const code = (error as { code?: unknown })?.code;
			s.lastError = typeof code === "string" && /^[a-z0-9-]{1,64}$/.test(code) ? code : "observations";
			throw error;
		}
		for (const o of page.observations) {
			if (o.o === "fact") {
				const f = stream(o.r);
				const b = size(f);
				const root = linkRoot(w.links, o.r.id);
				if (root !== null) {
					const h = hold(root);
					h.facts.push(f);
					h.bytes += b;
					last = null;
					continue;
				}
				if (count && (count + 1 > PASS_LIMITS.partitionRows || bytes + b > PASS_LIMITS.partitionBytes)) yield out();
				facts.push(f);
				count++;
				bytes += b;
				last = o.r.id;
			} else if (o.o === "fact-role") {
				const root = linkRoot(w.links, o.r.factId);
				if (root !== null) {
					const h = hold(root);
					h.roles.push(o.r);
					h.bytes += size(o.r);
				} else if (o.r.factId === last) {
					factRoles.push(o.r);
					bytes += size(o.r);
					last = null;
				} else throw new Error("usage-pass-role-order");
			} else if (o.o === "alias") {
				const h = hold(linkRoot(w.links, o.r.aliasFactId) ?? o.r.aliasFactId);
				h.aliases.push(o.r);
				h.bytes += size(o.r);
			}
		}
		cursor = page.next;
	} while (cursor !== null);
	for (const h of held.values()) {
		// An alias row needs both of its facts in the partition (W5 split-alias); this week's writer only files aliases
		// whose canonical is in the week, so a row without both is left out, never sent alone.
		const ids = new Set(h.facts.map((f) => f.id));
		const keep = h.aliases.filter((a) => ids.has(a.aliasFactId) && ids.has(a.canonicalFactId));
		const roles = h.roles.filter((r) => ids.has(r.factId));
		const n = h.facts.length + keep.length;
		if (n === 0) continue;
		if (count && (count + n > PASS_LIMITS.partitionRows || bytes + h.bytes > PASS_LIMITS.partitionBytes)) yield out();
		facts.push(...h.facts);
		aliases.push(...keep);
		factRoles.push(...roles);
		count += n;
		bytes += h.bytes;
	}
	if (count) yield out();
}

/**
 * One bounded pass. Single flight: a call while another runs returns status "busy" and touches nothing (C3).
 * budget.workMs bounds scan + reads + fold + commit (the W5 build is the caller's, timed as R-W5); budget.bytes
 * bounds actual read(2) bytes plus one worst-case read (C1).
 */
export async function runPass(s: PassState, budget: PassBudget = PASS_LIMITS): Promise<PassResult> {
	const o = s.options;
	const T = iso(o.now());
	const stats: PassResult["stats"] = {
		workMs: 0,
		ioMs: 0,
		bytesRead: 0,
		files: 0,
		reads: 0,
		records: 0,
		history: 0,
		backlogFiles: 0,
		ledgerBytes: 0,
	};
	const result = (status: PassResult["status"], completed: boolean, input: SnapshotBuildInput | null): PassResult => ({
		status,
		week: s.cur?.week ?? null,
		asOf: T,
		sequence: s.sequence,
		completed,
		input,
		stats,
	});
	if (s.running) return result("busy", false, null);
	s.running = true;
	const t0 = o.clock();
	const deadline = t0 + budget.workMs;
	try {
		// A store that is not ready (closed by a failed reopen, or still waiting for a previous writer) is opened again
		// once per pass; the folds are then rebuilt from the checkpoints.
		if (s.store.status().state !== "ready") {
			s.store.close();
			s.store = openStore(o);
			s.broken = true;
			if (s.store.status().state !== "ready") return result("unavailable", false, null);
		}
		s.sequence++;
		s.faults = new Map();
		const week = usageWeekOf(T);
		// Grace: last week's files are read on until drained or 10 min after Monday 00:00 Pacific, then dropped.
		const graceOver = Date.parse(T) >= Date.parse(usageWeekBounds(week).start) + PASS_LIMITS.graceMs;
		s.graceOver = graceOver;
		if (!s.cur || s.cur.week !== week || s.broken) startWeek(s, week, graceOver);
		if (graceOver && !s.prev!.released) releasePrevious(s);
		const cur = s.cur!,
			prev = s.prev!;
		if (cur.state === "unavailable" || s.store.status().state !== "ready") return result("unavailable", false, null);
		if (!catchUp(s, prev, deadline) || !catchUp(s, cur, deadline)) return result("catching-up", false, null);
		await o.slow?.();
		if (graceOver)
			for (const f of s.files.values())
				if (f.week === prev.week) {
					if (f.state === "ready" && f.file) bump(s, "late");
					s.files.delete(f.key);
				}
		// 1. Stat-only inventory (bounded, resumable), at most a quarter of the work time.
		const inv = s.inventory!;
		const scanStop = t0 + budget.workMs / 4;
		scanPassInventory(inv, {
			roots: o.sessionRoots,
			temperRoots: o.temperRoots,
			asOf: T,
			...o.scan,
			stop: () => o.clock() >= scanStop,
		});
		for (const p of inv.files.values()) {
			const f = s.files.get(p.key);
			if (!f)
				s.files.set(p.key, {
					key: p.key,
					file: p.file,
					week: cur.week,
					cursor: null,
					size: p.size,
					mtimeMs: p.mtimeMs,
					readSize: null,
					hint: null,
					state: "ready",
					growth: false,
					retried: false,
				});
			else {
				const changed = f.readSize === null || p.size !== f.size || Math.floor(p.mtimeMs) !== Math.floor(f.mtimeMs);
				f.file = p.file;
				f.week = cur.week;
				// A file waiting for growth is read again only once it changed (MF2, S3); one waiting on event time each pass.
				if (changed || (f.state === "waiting" && !f.growth)) {
					f.state = "ready";
					f.growth = false;
				}
				f.size = p.size;
				f.mtimeMs = p.mtimeMs;
			}
		}
		// 2. Changed chat files, appended bytes only, one read at a time (C2), sessions before the ledger.
		const bytes = { bytes: budget.bytes, deadline: t0 + (budget.workMs * 4) / 5 };
		let stopped = false;
		let order = [...s.files.values()];
		if (o.readOrder) {
			const rank = new Map(o.readOrder(order.flatMap((f) => (f.file ? [f.file] : []))).map((p, i) => [p, i]));
			order = order.sort((a, b) => (rank.get(a.file ?? "") ?? order.length) - (rank.get(b.file ?? "") ?? order.length));
		}
		for (const f of order) {
			if (f.state !== "ready" || !f.file) continue;
			stats.files++;
			f.retried = false;
			if (!(await readFile(s, f, T, bytes, stats))) {
				stopped = true;
				break;
			}
			if (o.clock() - t0 > PASS_LIMITS.sliceMs) await new Promise<void>((r) => setImmediate(r));
		}
		s.readBytes += stats.bytesRead;
		for (const f of s.files.values()) if (f.state === "ready" && f.file) stats.backlogFiles++;
		commit(s);
		// 3. Ledger tail, only once the sessions have no readable backlog (keeps ledger behind its witnesses).
		if (!stopped && stats.backlogFiles === 0) {
			readLedger(s, T, deadline, stats);
			commit(s);
		}
		stats.records = cur.recs.size;
		const completed = !stopped && stats.backlogFiles === 0 && (s.ledger.eof || !o.ledgerDirectory) && inv.walk === null;
		const input = buildPassInput(s, T, completed);
		stats.workMs = o.clock() - t0;
		const clean =
			completed && input.coverage.every((c) => c.status === "complete") && input.evidence.faultCounts.length === 0;
		return result(
			stopped || stats.backlogFiles || inv.walk !== null ? "catching-up" : clean ? "fresh" : "partial",
			completed,
			input,
		);
	} catch (error) {
		// A refused append/checkpoint or a hash failure: never a healthy empty week; rebuild from checkpoints.
		s.broken = true;
		bump(s, "store");
		const code = (error as { code?: unknown })?.code;
		s.lastError =
			typeof code === "string" && /^[a-z0-9-]{1,64}$/.test(code) ? code : error instanceof Error ? error.name : "error";
		return result("unavailable", false, null);
	} finally {
		stats.workMs = o.clock() - t0;
		s.running = false;
	}
}
export { LEDGER_SOURCE_LIMITS };
