/**
 * Design B's week store (Ops #422; #420 PLAN.md section 5.8, B2, with Architecture's M1-M6 from rm-8fb0f6a3). Each
 * Pacific week gets an append-only numeric log (one record per attempt, with its disposition: unknowns and gaps are
 * recorded too), an append-only receipts log (what W2's first() and sameCall() return), a checkpoint that is the commit
 * point (the readers' cursors plus each log's length and sha256), sealed totals with 16-byte key digests, and an
 * adjustment log for late attempts. Worker-private and synchronous: B3's pass and B5's seal write only through it. No
 * chat text (closed numeric and identifier fields only), no model calls and no deletion run: the owner chose to keep
 * all usage detail (dr-8795124dce74), so deleteWeek exists for a later retention choice and no production code calls
 * it. Formats, crash points and the H-B2 measurement: docs/usage-accounting-week-store.md.
 *
 * Ops #500 (Architecture rm-21ceb823): an observations log keeps every typed row B3 actually has (facts, unresolved
 * and responseId-less ones included, allocations, aliases, dependency rows, run snapshots, source coverage and W5's
 * role witnesses), each checked by the contract alone and never built or completed here, committed by the same
 * checkpoint (version 2) as the numeric log and the cursors, and replayed in bounded, hash-checked pages. A week
 * committed by a version 1 checkpoint is a legacy numeric-only week: readable, never reported complete.
 */
import {
	closeSync,
	constants,
	fchmodSync,
	fdatasyncSync,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	openSync,
	opendirSync,
	readSync,
	renameSync,
	unlinkSync,
	writeSync,
	type Stats,
} from "node:fs";
import { createHash, randomBytes, type Hash } from "node:crypto";
import { resolve, sep } from "node:path";
import { isMainThread } from "node:worker_threads";
import { GuardFileLock } from "./role-message-guard-lock.js";
import {
	addUsd,
	factId,
	pacificWeekStart,
	pacificWeekStartUtc,
	parseAccountingInput,
	type AccountingInput,
	type Allocation,
	type DispatchRoot,
	type IdentityAlias,
	type Producer,
	type ReportingPolicy,
	type RunSnapshot,
	type SourceCoverage,
	type TaskMembership,
	type UsageFact,
	type Usd,
} from "./usage-accounting-contract.js";
import {
	LEDGER_SOURCE_LIMITS,
	type LedgerCursor,
	type LedgerNativeReceipt,
	type LedgerSameCall,
} from "./usage-accounting-ledger-source.js";

/** The store's folder inside the data folder (~/.pi-web-ui/usage-week/), 0700; every file in it is 0600. */
export const USAGE_WEEK_DIRECTORY = "usage-week";
export const USAGE_WEEK_STORE_LIMITS = Object.freeze({
	/** One record line with its newline. The largest valid record is under 1,000 B; a typical one about 390 B. */
	recordBytes: 1024,
	/** One receipt line with its newline: a validated UsageFact plus its envelope, typically 1-2 KiB. */
	receiptBytes: 16 * 1024,
	/** Records, and receipts, in one append. */
	appendRecords: 4096,
	appendBytes: 4 * 1024 * 1024,
	appendReceiptBytes: 16 * 1024 * 1024,
	/** Records per log: four times the 125,231 attempts measured in one week, twice the 2x projection. */
	weekRecords: 500_000,
	/** Receipt lines per week: one per key and kind, plus at most one alias supersede each. */
	weekReceipts: 1_000_000,
	checkpointBytes: 4 * 1024 * 1024,
	/** #304 file cursors in one checkpoint: B3's cap of 4,096 files a week. */
	files: 4096,
	sealedBytes: 64 * 1024 * 1024,
	directoryEntries: 8192,
	/** One observation line with its newline: W0's page size (METER_LIMITS.pageBytes), so any row a page can carry
	 *  fits; a typical fact line is about 1 KiB. */
	observationBytes: 262_144,
	/** Observations in one append or adjust (four per record), and their bytes. */
	appendObservations: 16_384,
	appendObservationBytes: 16 * 1024 * 1024,
	/** Observation lines per week: a fact and a role witness for each of E2's 250,462 attempts use half. */
	weekObservations: 1_000_000,
});
export type UsageWeekStoreLimits = { -readonly [K in keyof typeof USAGE_WEEK_STORE_LIMITS]: number };

/** The store as a whole stops on these until it is opened again (a new worker). */
const STORE_CODES = [
	"worker-required",
	"unsafe-path",
	"permission-denied",
	"waiting-for-previous-writer",
	"writer-lost",
	"io-failure",
	"closed",
] as const;
/** A refused call: nothing was written and the store stays ready. */
const REFUSAL_CODES = [
	"invalid-week",
	"invalid-record",
	"invalid-receipt",
	"invalid-cursors",
	"invalid-coverage",
	"wrong-week",
	"store-capacity",
	"not-loaded",
	"sealed",
	"not-sealed",
	"week-not-ended",
	"checkpoint-behind",
	"week-unavailable",
	"invalid-observation",
	"invalid-replay",
	"legacy-week",
] as const;
/** One week's files failed a check: that week is unavailable (its figures unknown, never zero), its bytes stay as
 *  they are, and other weeks go on. */
const WEEK_CODES = [
	"store-version",
	"log-missing",
	"log-mismatch",
	"log-corrupt",
	"log-changed",
	"checkpoint-corrupt",
	"sealed-corrupt",
	"adjust-missing",
	"adjust-mismatch",
	"adjust-corrupt",
	"receipts-missing",
	"receipts-mismatch",
	"receipts-corrupt",
	"observations-missing",
	"observations-mismatch",
	"observations-corrupt",
] as const;
export type UsageWeekStoreCode =
	(typeof STORE_CODES)[number] | (typeof REFUSAL_CODES)[number] | (typeof WEEK_CODES)[number];
const REFUSALS: ReadonlySet<string> = new Set(REFUSAL_CODES);
const WEEK_FAILURES: ReadonlySet<string> = new Set(WEEK_CODES);
export type UsageWeekStoreState = "ready" | "waiting-for-previous-writer" | "unavailable" | "closed";
/** Deterministic crash seam: a number at a *-write point makes a short write; throwing stops right there. */
export type UsageWeekPoint =
	| "reopen"
	| "header-write"
	| "header-sync"
	| "header-rename"
	| "after-header-rename"
	| "log-write"
	| "log-sync"
	| "after-log-sync"
	| "checkpoint-write"
	| "checkpoint-sync"
	| "checkpoint-rename"
	| "after-checkpoint-rename"
	| "seal-write"
	| "seal-sync"
	| "seal-rename"
	| "after-seal-rename"
	| "adjust-write"
	| "adjust-sync"
	| "after-adjust-sync"
	| "receipts-write"
	| "receipts-sync"
	| "after-receipts-sync"
	| "observations-write"
	| "observations-sync"
	| "after-observations-sync"
	| "truncate"
	| "quarantine-rename";
export interface UsageWeekStoreOptions {
	/** The data folder (~/.pi-web-ui); the store lives in its usage-week folder. */
	dataDir: string;
	/** One host-owned process-lifetime cell shared by every worker for this dataDir. Never cleared on uncertain death. */
	lease: SharedArrayBuffer;
	/** Smaller capacities for fixtures; never above USAGE_WEEK_STORE_LIMITS. */
	limits?: Partial<UsageWeekStoreLimits>;
	fault?: (point: UsageWeekPoint) => number | void;
	/** Clock for the week-ended checks and the written times; Date.now by default. */
	now?: () => number;
}

/** Links to whom an attempt counts for. Identifiers only: no free text can fit any field. */
export interface UsageWeekSubject {
	role: string | null;
	project: string | null;
	initiative: string | null;
	/** Queue task: queue key digest, task number and the task's addedAt. */
	task: { q: string; n: number; at: string } | null;
}
export type UsageWeekTokens = [number | null, number | null, number | null, number | null];
/**
 * What B3 decided about the attempt (Architecture M6). Only an original counts money and tokens; an alias is the same
 * call as an original counted elsewhere; unverified, unresolved and gap are unknowns, so the week stays partial after a
 * restart instead of turning them into zeros.
 */
export type UsageWeekDisposition = "original" | "alias" | "unverified" | "unresolved" | "gap";
export const USAGE_WEEK_DISPOSITIONS: readonly UsageWeekDisposition[] = Object.freeze([
	"original",
	"alias",
	"unverified",
	"unresolved",
	"gap",
]);
/** One attempt, or one gap. Numbers, digests and identifiers only. */
export interface UsageWeekRecord {
	/** sha256 hex of the attempt's dedupe key; for a gap, B3's key of its file position. */
	k: string;
	d: UsageWeekDisposition;
	/** occurredAt (ledger) or entry timestamp (sessions); decides the week. */
	at: string;
	/** 64-bit hex digest of the source file, with the byte offset of the attempt's line in it. */
	src: string;
	off: number;
	/** The line's byte length; a gap's skipped bytes (required, above 0). */
	len: number | null;
	sub: UsageWeekSubject;
	/** Exact contract decimal (12 fraction digits), null when unpriced; a gap's is null. */
	usd: Usd | null;
	/** input, output, cacheRead, cacheWrite; null when unknown. */
	tok: UsageWeekTokens;
	rate: string | null;
}
export interface UsageWeekFileCursor {
	/** #304's structural cursor, without importing W0; null before the first complete line. */
	cursor: { ordinal: number; token: string } | null;
	size: number;
	mtimeMs: number;
}
export interface UsageWeekCursors {
	/** Keyed by the same 16-hex file digest as the records' src. */
	files: Record<string, UsageWeekFileCursor>;
	ledger: LedgerCursor | null;
}
export interface UsageWeekLogState {
	length: number;
	records: number;
	sha256: string;
}
interface UsageWeekCheckpointFields extends UsageWeekCursors {
	week: string;
	at: string;
	log: UsageWeekLogState;
	/** null until the week has a receipts log. */
	receipts: UsageWeekLogState | null;
	adjust: UsageWeekLogState | null;
	sha256: string;
}
/** The commit point since Ops #500: the numeric log, receipts, adjustments, observations and cursors together. */
export interface UsageWeekCheckpoint extends UsageWeekCheckpointFields {
	v: "usage-week-checkpoint/2";
	/** null until the week has an observations log. */
	observations: UsageWeekLogState | null;
	/** Committed original records that came without a newly written fact bound to them in their own call. */
	unobserved: number;
}
/** A week B2 committed before Ops #500: numeric only, its observations unknown (never "none"). */
export interface UsageWeekLegacyCheckpoint extends UsageWeekCheckpointFields {
	v: "usage-week-checkpoint/1";
}
export interface UsageWeekTotals {
	/** Records by disposition. */
	count: Record<UsageWeekDisposition, number>;
	/** Sum of the originals' known amounts, exact. */
	usd: Usd;
	/** Originals without an amount. */
	usdUnknown: number;
	/** The originals' token counts, and how many originals had each one unknown. */
	tok: [number, number, number, number];
	tokUnknown: [number, number, number, number];
}
export interface UsageWeekCoverage {
	state: "complete" | "partial" | "unknown";
	gaps: { code: string; count: number }[];
}
export interface UsageWeekSealed {
	v: "usage-week-sealed/1";
	week: string;
	sealedAt: string;
	log: UsageWeekLogState;
	coverage: UsageWeekCoverage;
	total: UsageWeekTotals & { rates: { rate: string | null; attempts: number }[] };
	subjects: (UsageWeekTotals & { sub: UsageWeekSubject })[];
	keys: { count: number; bytes: 16; sha256: string };
	sha256: string;
}
/** Bytes past the checkpoint (synced or not: the checkpoint is the commit point) cut off by reload; the observations'
 *  are in observationCoverage(). */
export interface UsageWeekRecovered {
	/** From the log (open week) or the adjustment log (sealed week). */
	records: number;
	receipts: number;
}
/**
 * Gets a reloaded week's records in file order (the log's, or a sealed week's adjustments), only after the week is
 * proven, so a week that turns out unavailable hands over nothing. It must not throw: an error from it stops the
 * store, as any unexpected error does.
 */
export type UsageWeekEach = (record: UsageWeekRecord, from: "log" | "adjust") => void;
export type UsageWeekLoad =
	| { state: "empty"; week: string }
	| {
			state: "open";
			week: string;
			/** How many records the log holds; the records themselves go to reload's `each`. */
			records: number;
			/** Receipt keys (kind and key) the week answers for. */
			receipts: number;
			checkpoint: UsageWeekCheckpoint | UsageWeekLegacyCheckpoint | null;
			dropped: UsageWeekRecovered;
	  }
	| {
			state: "sealed";
			week: string;
			sealed: UsageWeekSealed;
			checkpoint: UsageWeekCheckpoint | UsageWeekLegacyCheckpoint;
			/** How many adjustments the week holds; they go to reload's `each`. */
			adjustments: number;
			receipts: number;
			dropped: UsageWeekRecovered;
	  }
	| { state: "unavailable"; week: string; code: UsageWeekStoreCode };
export type UsageWeekReceiptKind = "ledger-native" | "same-call";
/**
 * What W2's readers return for a key, committed with its batch (Architecture M5): first(key) gets the ledger source's
 * own LedgerNativeReceipt back; sameCall(provider, responseId) gets the session original's canonical fact, under
 * k = sha256(JSON.stringify([provider, responseId])). A ledger-native receipt may be appended again once, only to
 * attach an alias to one that had none; any other change to a stored receipt is refused.
 */
export type UsageWeekReceipt =
	{ kind: "ledger-native"; k: string; r: LedgerNativeReceipt } | { kind: "same-call"; k: string; r: LedgerSameCall };
export interface UsageWeekAppend {
	appended: number;
	duplicates: number;
	receipts: number;
	receiptDuplicates: number;
	records: number;
	length: number;
}
export interface UsageWeekAdjust {
	added: number;
	duplicates: number;
	receipts: number;
	receiptDuplicates: number;
	records: number;
}
export type UsageWeekSealedRead =
	| { state: "sealed"; week: string; sealed: UsageWeekSealed }
	| { state: "none"; week: string }
	| { state: "unavailable"; week: string; code: UsageWeekStoreCode };

/** Ops #500: what B3 actually has, kept to replay later. Every kind but fact-role is the contract's own row. */
export type UsageWeekObservationKind =
	"fact" | "allocation" | "alias" | "root" | "policy" | "membership" | "snapshot" | "coverage" | "fact-role";
export const USAGE_WEEK_OBSERVATION_KINDS: readonly UsageWeekObservationKind[] = Object.freeze([
	"fact",
	"allocation",
	"alias",
	"root",
	"policy",
	"membership",
	"snapshot",
	"coverage",
	"fact-role",
]);
/** W5's role witness for one fact (SubjectUsageSource["factRoles"]); role null names no payer. */
export interface UsageWeekFactRole {
	factId: string;
	role: string | null;
	evidenceRef: string;
}
export type UsageWeekObservationRow =
	| { o: "fact"; r: UsageFact }
	| { o: "allocation"; r: Allocation }
	| { o: "alias"; r: IdentityAlias }
	| { o: "root"; r: DispatchRoot }
	| { o: "policy"; r: ReportingPolicy }
	| { o: "membership"; r: TaskMembership }
	| { o: "snapshot"; r: RunSnapshot }
	| { o: "coverage"; r: SourceCoverage }
	| { o: "fact-role"; r: UsageWeekFactRole };
/**
 * What a caller appends: one row, bound by rk to the key of the numeric record it came with (a record in the same
 * call, or one the week already has), or to none.
 */
export type UsageWeekObservationInput = UsageWeekObservationRow & { rk: string | null };
/** One replayed line: the row as appended, with its key and whether it came while the week was open or sealed. */
export type UsageWeekObservation = UsageWeekObservationRow & { k: string; p: "open" | "late"; rk: string | null };
/** In append's and adjust's result when they were given observations. */
export interface UsageWeekObserved {
	observations: number;
	observationDuplicates: number;
	/** New original records in this call without a newly written fact bound to them. */
	unobserved: number;
}
export interface UsageWeekObservationCoverage {
	/** complete: every committed original has its fact line; partial: some don't; legacy: observations unknown. */
	state: "complete" | "partial" | "legacy";
	/** Committed observation lines. */
	observations: number;
	/** Committed original records without their fact line; null for a legacy week. */
	unobserved: number | null;
	/** Uncommitted observation bytes the last reload cut off. */
	dropped: number;
}
/** Opaque: good only for the next page of the same replay stream. */
export interface UsageWeekReplayCursor {
	offset: number;
	ordinal: number;
	tag: string;
}
export interface UsageWeekObservationPage {
	week: string;
	coverage: UsageWeekObservationCoverage;
	observations: UsageWeekObservation[];
	/** null once the whole committed prefix was replayed and its SHA256 matched the checkpoint. */
	next: UsageWeekReplayCursor | null;
}

type WeekFile = "log" | "receipts" | "checkpoint" | "sealed" | "adjust";
type StoredFile = WeekFile | "observations";
type Appended = "log" | "adjust" | "receipts" | "observations";
export interface UsageWeekListing {
	/** observations: true only when the week has that file (so B2's listing shape is unchanged without it). */
	weeks: ({ week: string } & Record<WeekFile, boolean> & { observations?: true })[];
	/** Temp files a stopped write left behind (never deleted). */
	scratch: number;
	quarantined: number;
	other: number;
}

export class UsageWeekStoreError extends Error {
	constructor(readonly code: UsageWeekStoreCode) {
		super(code);
	}
}
const fail = (code: UsageWeekStoreCode): never => {
	throw new UsageWeekStoreError(code);
};
function check(ok: unknown, code: UsageWeekStoreCode = "io-failure"): asserts ok {
	if (!ok) fail(code);
}

const LOG_V = "usage-week-log/1",
	OBSERVATIONS_V = "usage-week-observations/1",
	CHECKPOINT_V = "usage-week-checkpoint/2",
	LEGACY_CHECKPOINT_V = "usage-week-checkpoint/1",
	SEALED_V = "usage-week-sealed/1";
const READ_BYTES = 4 * 1024 * 1024,
	WRITE_BYTES = 4 * 1024 * 1024,
	HEAD_BYTES = 64 * 1024,
	USD_BATCH = 4096,
	DAY_MS = 86_400_000;
const WEEK = /^\d{4}-\d\d-\d\d$/,
	TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
	HEX64 = /^[a-f0-9]{64}$/,
	HEX16 = /^[a-f0-9]{16}$/,
	HEXES = /^[a-f0-9]*$/,
	REF = /^[A-Za-z0-9_./:@+-]{1,128}$/,
	LEDGER_REF = /^[A-Za-z0-9_./:@+-]{1,256}$/,
	RATE = /^[A-Za-z0-9_./:@+-]{1,64}$/,
	DECIMAL = /^(0|[1-9]\d{0,17})(?:\.\d{1,12})?$/,
	TOKEN = /^[A-Za-z0-9:._-]{1,256}$/,
	GAP = /^[a-z0-9-]{1,64}$/,
	NAME = /^[a-z0-9.-]+$/,
	ROLE = /^[a-z][a-z0-9-]{0,31}$/,
	WEEK_NAME = /^week-(\d{4}-\d\d-\d\d)\.(log|receipts|checkpoint|sealed|adjust|observations)$/,
	PRINTABLE = /^[\x20-\x7e]*\n$/,
	SCRATCH = /\.next-[a-f0-9]{16}$/,
	QUARANTINE = /\.quarantine-[a-f0-9]{16}$/;
const WEEK_FILES = ["log", "receipts", "checkpoint", "sealed", "adjust"] as const;
const STORED_FILES = [...WEEK_FILES, "observations"] as const;

type Fields = Record<string, unknown>;
/** A plain object with exactly these keys (sorted, comma-joined). */
function closed(v: unknown, keys: string): v is Fields {
	return v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === keys;
}
const uint = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const ref = (v: unknown): boolean => v === null || (typeof v === "string" && REF.test(v));
function time(v: unknown): v is string {
	if (typeof v !== "string" || !TIME.test(v)) return false;
	const ms = Date.parse(v);
	return !Number.isNaN(ms) && new Date(ms).toISOString() === v;
}
const sha = (data: string) => createHash("sha256").update(data).digest("hex");
function canonical(raw: unknown): string {
	if (Array.isArray(raw)) return `[${raw.map(canonical).join(",")}]`;
	if (raw !== null && typeof raw === "object")
		return `{${Object.keys(raw)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical((raw as Fields)[k])}`)
			.join(",")}}`;
	return JSON.stringify(raw) ?? "null";
}
/** Same family, other version: told apart from damage. */
function version(raw: unknown, expected: string, code: UsageWeekStoreCode): void {
	const v = raw !== null && typeof raw === "object" ? (raw as Fields).v : undefined;
	if (v === expected) return;
	fail(
		typeof v === "string" && v.startsWith(expected.slice(0, expected.lastIndexOf("/") + 1)) ? "store-version" : code,
	);
}

function validWeek(week: unknown): week is string {
	if (typeof week !== "string" || !WEEK.test(week)) return false;
	const day = new Date(`${week}T00:00:00.000Z`);
	return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === week && day.getUTCDay() === 1;
}
/** The Pacific week (its Monday, YYYY-MM-DD) an attempt counts in. */
export function usageWeekOf(at: string): string {
	check(time(at), "invalid-record");
	return pacificWeekStart(at);
}
/** The week's UTC bounds, start inclusive, end exclusive: 167, 168 or 169 hours around DST changes. */
export function usageWeekBounds(week: string): { start: string; end: string } {
	check(validWeek(week), "invalid-week");
	const next = new Date(Date.parse(`${week}T00:00:00.000Z`) + 7 * DAY_MS).toISOString().slice(0, 10);
	return { start: pacificWeekStartUtc(`${week}T12:00:00.000Z`), end: pacificWeekStartUtc(`${next}T12:00:00.000Z`) };
}
const weekName = (week: string, kind: StoredFile) => `week-${week}.${kind}`;
const family = (kind: Appended) => (kind === "observations" ? OBSERVATIONS_V : LOG_V);
const headerLine = (week: string, kind: Appended) => `${JSON.stringify({ v: family(kind), week, kind })}\n`;
const DISPOSITIONS: ReadonlySet<unknown> = new Set(USAGE_WEEK_DISPOSITIONS);

function recordProblem(r: unknown, start: string, end: string): "invalid-record" | "wrong-week" | null {
	if (!closed(r, "at,d,k,len,off,rate,src,sub,tok,usd")) return "invalid-record";
	const { k, d, at, src, off, len, sub, usd, tok, rate } = r;
	if (
		typeof k !== "string" ||
		!HEX64.test(k) ||
		!DISPOSITIONS.has(d) ||
		!time(at) ||
		typeof src !== "string" ||
		!HEX16.test(src) ||
		!uint(off) ||
		(len !== null && !uint(len))
	)
		return "invalid-record";
	if (!closed(sub, "initiative,project,role,task") || !ref(sub.role) || !ref(sub.project) || !ref(sub.initiative))
		return "invalid-record";
	const task = sub.task;
	if (
		task !== null &&
		(!closed(task, "at,n,q") ||
			typeof task.q !== "string" ||
			!HEX64.test(task.q) ||
			!uint(task.n) ||
			(task.n as number) < 1 ||
			!time(task.at))
	)
		return "invalid-record";
	if (usd !== null && (typeof usd !== "string" || !DECIMAL.test(usd))) return "invalid-record";
	if (!Array.isArray(tok) || tok.length !== 4) return "invalid-record";
	for (let i = 0; i < 4; i++) if (tok[i] !== null && !uint(tok[i])) return "invalid-record";
	if (rate !== null && (typeof rate !== "string" || !RATE.test(rate))) return "invalid-record";
	// A gap's amount is unknown: no figures, and the skipped bytes are required.
	if (d === "gap" && (len === null || len === 0 || usd !== null || rate !== null || tok.some((t) => t !== null)))
		return "invalid-record";
	return at < start || at >= end ? "wrong-week" : null;
}
/** Fixed field order; every value is validated ASCII that JSON never escapes, so bytes = characters. */
function serialize(r: UsageWeekRecord): string {
	const { sub } = r,
		task = sub.task;
	return JSON.stringify({
		k: r.k,
		d: r.d,
		at: r.at,
		src: r.src,
		off: r.off,
		len: r.len,
		sub: {
			role: sub.role,
			project: sub.project,
			initiative: sub.initiative,
			task: task === null ? null : { q: task.q, n: task.n, at: task.at },
		},
		usd: r.usd,
		tok: [r.tok[0], r.tok[1], r.tok[2], r.tok[3]],
		rate: r.rate,
	});
}
/** The contract's own parser decides whether a fact (and its alias) is valid, as W2's receipt() does. */
function acceptedFact(fact: unknown, aliases: unknown[]): boolean {
	return parseAccountingInput({
		v: 1,
		facts: [fact],
		aliases,
		allocations: [],
		roots: [],
		policies: [],
		memberships: [],
		snapshots: [],
		requiredStreams: ["ledger-validation"],
		coverage: [],
	}).ok;
}
const ledgerRef = (v: unknown): v is string => typeof v === "string" && LEDGER_REF.test(v);
const RECEIPT_HEAD = '{"k":"';
/** The receipts index key: kind's first letter and the key. */
const receiptTag = (kind: UsageWeekReceiptKind, k: string) => `${kind === "ledger-native" ? "n" : "s"}${k}`;
/**
 * A receipt's line, or null when it is not one this store keeps: k first at a fixed place (reload reads the key and
 * kind there without parsing), the receipt itself canonical (sorted keys), printable ASCII only. Every identifier the
 * contract allows is ASCII without spaces, so no chat text can fit. It is also one W2 itself takes back (Architecture
 * HOME F3): the checks W2's receipt() and sameCall() make without their reader's projection are made here too, at
 * admission and on return; the ones that compare with the projection stay W2's.
 */
function receiptLine(x: unknown): string | null {
	if (!closed(x, "k,kind,r")) return null;
	const { k, kind, r } = x;
	if (typeof k !== "string" || !HEX64.test(k)) return null;
	if (kind === "ledger-native") {
		if (
			!closed(r, "alias,fact,key,numericSha256,v") ||
			r.v !== "usage-ledger-native/1" ||
			r.key !== k ||
			typeof r.numericSha256 !== "string" ||
			!HEX64.test(r.numericSha256)
		)
			return null;
		const alias = r.alias;
		if (alias !== null && !closed(alias, "aliasFactId,canonicalFactId,evidenceRef,provenance")) return null;
		if (
			!closed(
				r.fact,
				"id,identity,identityStatus,kind,links,model,occurredAt,prices,provider,revision,source,supersedes,tokens,v",
			)
		)
			return null;
		if (alias !== null && alias.aliasFactId !== r.fact.id) return null;
		if (!acceptedFact(r.fact, alias === null ? [] : [alias])) return null;
		// W2's receipt() (usage-accounting-ledger-source.ts): pi's own first call for this key, nothing linked yet.
		const fact = r.fact as unknown as LedgerNativeReceipt["fact"];
		if (
			fact.identity.producer !== "pi" ||
			fact.revision !== 0 ||
			fact.source.event !== `response:${k}` ||
			fact.links.task !== null ||
			fact.links.run !== null ||
			fact.source.coverage !== "partial"
		)
			return null;
	} else if (kind === "same-call") {
		if (
			!closed(r, "canonical,evidenceRef,provider,responseId") ||
			!ledgerRef(r.provider) ||
			!ledgerRef(r.responseId) ||
			!ledgerRef(r.evidenceRef) ||
			sha(JSON.stringify([r.provider, r.responseId])) !== k ||
			!acceptedFact(r.canonical, [])
		)
			return null;
		// W2's sameCall(): the original is a verified pi or acp call.
		const original = r.canonical as unknown as LedgerSameCall["canonical"];
		if (!["pi", "acp"].includes(original.identity.producer) || original.identityStatus !== "verified") return null;
	} else return null;
	const line = `${RECEIPT_HEAD}${k}","kind":"${kind}","r":${canonical(r)}}\n`;
	return PRINTABLE.test(line) ? line : null;
}
/**
 * When a receipt's call happened: the native fact's time, or the same-call original's. Like a record, a receipt belongs
 * to the week its call happened in (Architecture HOME F2).
 */
const receiptAt = (x: UsageWeekReceipt) =>
	x.kind === "ledger-native" ? x.r.fact.occurredAt : x.r.canonical.occurredAt;
/** A ledger-native receipt may change once: from no alias to an alias, everything else the same (W2 :859). */
function aliasAttached(before: string, x: UsageWeekReceipt): boolean {
	if (x.kind !== "ledger-native" || x.r.alias === null) return false;
	let stored: unknown;
	try {
		stored = JSON.parse(before);
	} catch {
		return false;
	}
	const r = (stored as Fields).r as Fields;
	return r.alias === null && canonical({ ...r, alias: null }) === canonical({ ...x.r, alias: null });
}

/** Ops #500: the AccountingInput list that checks a row of each contract kind. */
const ROW_LISTS = {
	fact: "facts",
	allocation: "allocations",
	alias: "aliases",
	root: "roots",
	policy: "policies",
	membership: "memberships",
	snapshot: "snapshots",
	coverage: "coverage",
} as const satisfies Record<Exclude<UsageWeekObservationKind, "fact-role">, keyof AccountingInput>;
const OBSERVATION_KINDS: ReadonlySet<unknown> = new Set(USAGE_WEEK_OBSERVATION_KINDS),
	PRODUCERS: readonly unknown[] = ["pi", "acp", "temper"];
/** The contract's fact reference: the JSON identity tuple exactly as factId() writes it. */
function factReference(v: unknown): v is string {
	if (typeof v !== "string" || v.length > 800) return false;
	let tuple: unknown;
	try {
		tuple = JSON.parse(v);
	} catch {
		return false;
	}
	return (
		Array.isArray(tuple) &&
		tuple.length === 4 &&
		tuple[0] === "usage-fact/1" &&
		PRODUCERS.includes(tuple[1]) &&
		ledgerRef(tuple[2]) &&
		ledgerRef(tuple[3]) &&
		factId({ producer: tuple[1] as Producer, incarnation: tuple[2], attempt: tuple[3] }) === v
	);
}
/** A row the contract takes as it is, alone; a fact-role row as W5's witness check takes it. Never repaired. */
function acceptedRow(o: UsageWeekObservationKind, r: unknown): boolean {
	if (o === "fact-role")
		return (
			closed(r, "evidenceRef,factId,role") &&
			factReference(r.factId) &&
			(r.role === null || (typeof r.role === "string" && ROLE.test(r.role))) &&
			ledgerRef(r.evidenceRef)
		);
	const input: Record<string, unknown> = {
		v: 1,
		facts: [],
		allocations: [],
		aliases: [],
		roots: [],
		policies: [],
		memberships: [],
		snapshots: [],
		coverage: [],
		requiredStreams: ["ledger-validation"],
	};
	input[ROW_LISTS[o]] = [r];
	return parseAccountingInput(input).ok;
}
/** The row a key is made of: a fact's observedAt is when it was read, so a fact read again later is the same one. */
function keyRow(o: UsageWeekObservationKind, r: unknown): unknown {
	if (o !== "fact") return r;
	const fact = r as UsageFact;
	return { ...fact, source: { ...fact.source, observedAt: null } };
}
/**
 * An observation's key and line, or null when it is not one this store keeps: k first at a fixed place (reload reads
 * it without parsing), then kind, phase and binding, then the row canonical (sorted keys), printable ASCII only. The
 * row is the caller's, checked and stored as it is: nothing is added, filled in or changed.
 */
function observationLine(o: unknown, r: unknown, p: unknown, rk: unknown): { k: string; line: string } | null {
	if (
		!OBSERVATION_KINDS.has(o) ||
		(p !== "open" && p !== "late") ||
		(rk !== null && (typeof rk !== "string" || !HEX64.test(rk)))
	)
		return null;
	const kind = o as UsageWeekObservationKind;
	if (!acceptedRow(kind, r)) return null;
	const k = sha(canonical([kind, keyRow(kind, r)])),
		line = `${JSON.stringify({ k, o: kind, p, rk }).slice(0, -1)},"r":${canonical(r)}}\n`;
	return PRINTABLE.test(line) ? { k, line } : null;
}
/**
 * A committed line back as the row it was appended as (line with its newline): parsed, then rebuilt by the same check
 * and compared byte for byte, key included; null when it isn't exactly a line this store writes.
 */
function storedObservation(line: string): UsageWeekObservation | null {
	let x: unknown;
	try {
		x = JSON.parse(line);
	} catch {
		return null;
	}
	if (!closed(x, "k,o,p,r,rk")) return null;
	const built = observationLine(x.o, x.r, x.p, x.rk);
	return built !== null && built.k === x.k && built.line === line ? (x as unknown as UsageWeekObservation) : null;
}
function validLedger(c: unknown): c is LedgerCursor {
	if (!closed(c, "anchor,byte,headerSha256,incarnation,kind,line,ordinal,stream")) return false;
	const a = c.anchor;
	return (
		c.kind === "file" &&
		typeof c.stream === "string" &&
		LEDGER_REF.test(c.stream) &&
		typeof c.incarnation === "string" &&
		LEDGER_REF.test(c.incarnation) &&
		uint(c.ordinal) &&
		c.ordinal >= 1 &&
		uint(c.byte) &&
		uint(c.line) &&
		c.line === c.ordinal &&
		typeof c.headerSha256 === "string" &&
		HEX64.test(c.headerSha256) &&
		closed(a, "bytes,sha256,start") &&
		uint(a.start) &&
		uint(a.bytes) &&
		a.bytes > 0 &&
		a.bytes <= LEDGER_SOURCE_LIMITS.lineBytes &&
		a.start + a.bytes === c.byte &&
		typeof a.sha256 === "string" &&
		HEX64.test(a.sha256) &&
		`ledger1:${c.byte}:${c.line}:${a.start}:${a.bytes}:${a.sha256}:${c.headerSha256}`.length <= 256
	);
}
function validCursors(c: unknown, files: number): c is UsageWeekCursors {
	if (!closed(c, "files,ledger") || c.files === null || typeof c.files !== "object" || Array.isArray(c.files))
		return false;
	const entries = Object.entries(c.files);
	if (entries.length > files) return false;
	for (const [key, value] of entries) {
		if (!HEX16.test(key) || !closed(value, "cursor,mtimeMs,size") || !uint(value.size) || !uint(value.mtimeMs))
			return false;
		const cursor = value.cursor;
		if (
			cursor !== null &&
			(!closed(cursor, "ordinal,token") ||
				!uint(cursor.ordinal) ||
				cursor.ordinal < 1 ||
				typeof cursor.token !== "string" ||
				!TOKEN.test(cursor.token))
		)
			return false;
	}
	return c.ledger === null || validLedger(c.ledger);
}
function validCoverage(c: unknown): c is UsageWeekCoverage {
	if (
		!closed(c, "gaps,state") ||
		(c.state !== "complete" && c.state !== "partial" && c.state !== "unknown") ||
		!Array.isArray(c.gaps) ||
		c.gaps.length > 64
	)
		return false;
	const seen = new Set<string>();
	for (const g of c.gaps as unknown[]) {
		if (
			!closed(g, "code,count") ||
			typeof g.code !== "string" ||
			!GAP.test(g.code) ||
			!uint(g.count) ||
			seen.has(g.code)
		)
			return false;
		seen.add(g.code);
	}
	return c.state !== "complete" || c.gaps.length === 0;
}
const logState = (v: unknown): v is UsageWeekLogState =>
	closed(v, "length,records,sha256") &&
	uint(v.length) &&
	uint(v.records) &&
	typeof v.sha256 === "string" &&
	HEX64.test(v.sha256);
const sameLog = (a: UsageWeekLogState, b: UsageWeekLogState) =>
	a.length === b.length && a.records === b.records && a.sha256 === b.sha256;
/** Binary search over sorted, concatenated 32-hex digests. */
function sortedHas(keys: string, digest: string): boolean {
	let lo = 0,
		hi = keys.length / 32;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1,
			value = keys.slice(mid * 32, mid * 32 + 32);
		if (value === digest) return true;
		if (value < digest) lo = mid + 1;
		else hi = mid;
	}
	return false;
}

/** Exact decimal sum; a total past the contract's 18 whole digits doesn't fit a sealed file. */
function sumUsd(values: readonly Usd[]): Usd {
	try {
		return addUsd(values);
	} catch {
		return fail("store-capacity");
	}
}
class Totals {
	count: Record<UsageWeekDisposition, number> = { original: 0, alias: 0, unverified: 0, unresolved: 0, gap: 0 };
	usdUnknown = 0;
	private usd: Usd[] = [];
	private tok: [number, number, number, number] = [0, 0, 0, 0];
	private tokUnknown: [number, number, number, number] = [0, 0, 0, 0];
	add(r: UsageWeekRecord): void {
		this.count[r.d]++;
		if (r.d !== "original") return;
		if (r.usd === null) this.usdUnknown++;
		else if (this.usd.push(r.usd) >= USD_BATCH) this.usd = [sumUsd(this.usd)];
		for (let i = 0; i < 4; i++) {
			const t = r.tok[i];
			if (t === null) this.tokUnknown[i]++;
			else this.tok[i] += t;
		}
	}
	done(): UsageWeekTotals {
		check(
			this.tok.every((t) => Number.isSafeInteger(t)),
			"store-capacity",
		);
		const usd = sumUsd(this.usd);
		check(DECIMAL.test(usd), "store-capacity");
		return {
			count: { ...this.count },
			usd,
			usdUnknown: this.usdUnknown,
			tok: [...this.tok],
			tokUnknown: [...this.tokUnknown],
		};
	}
}
class WeekFold {
	private total = new Totals();
	private rates = new Map<string | null, number>();
	private subjects = new Map<string, { sub: UsageWeekSubject; totals: Totals }>();
	add(r: UsageWeekRecord): void {
		this.total.add(r);
		if (r.d === "original") this.rates.set(r.rate, (this.rates.get(r.rate) ?? 0) + 1);
		const key = JSON.stringify(r.sub);
		let entry = this.subjects.get(key);
		if (entry === undefined) this.subjects.set(key, (entry = { sub: r.sub, totals: new Totals() }));
		entry.totals.add(r);
	}
	done(): Pick<UsageWeekSealed, "total" | "subjects"> {
		const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
		return {
			total: {
				...this.total.done(),
				rates: [...this.rates]
					.sort(([a], [b]) => order(a ?? "", b ?? ""))
					.map(([rate, attempts]) => ({ rate, attempts })),
			},
			subjects: [...this.subjects]
				.sort(([a], [b]) => order(a, b))
				.map(([, entry]) => ({ sub: entry.sub, ...entry.totals.done() })),
		};
	}
}

const uid = () => process.getuid?.() ?? fail("unsafe-path");
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const identity = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const fdPath = (fd: number, name?: string) => `/proc/self/fd/${fd}${name === undefined ? "" : `/${name}`}`;
function codeOf(e: unknown): UsageWeekStoreCode {
	if (e instanceof UsageWeekStoreError) return e.code;
	const errno = (e as NodeJS.ErrnoException | null)?.code;
	if (errno === "ELOOP" || errno === "ENOTDIR" || errno === "EEXIST") return "unsafe-path";
	if (errno === "EACCES" || errno === "EPERM") return "permission-denied";
	return "io-failure";
}
function privateFile(st: Stats): void {
	check(st.isFile() && st.nlink === 1 && st.uid === uid(), "unsafe-path");
	check((st.mode & 0o777) === 0o600, "permission-denied");
}
function directory(path: string, mode?: number): number {
	const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const st = fstatSync(fd);
		check(st.isDirectory(), "unsafe-path");
		if (mode !== undefined) {
			check(st.uid === uid(), "unsafe-path");
			check((st.mode & 0o777) === mode, "permission-denied");
		}
		return fd;
	} catch (e) {
		closeSync(fd);
		throw e;
	}
}
/** Walk every component with O_NOFOLLOW; pin the final trusted parent, not a string realpath. */
function dataDirectory(path: string): number {
	let fd = directory(sep);
	try {
		for (const part of resolve(path).split(sep).filter(Boolean)) {
			const next = directory(fdPath(fd, part));
			closeSync(fd);
			fd = next;
		}
		const st = fstatSync(fd);
		check(st.uid === uid(), "unsafe-path");
		check((st.mode & 0o022) === 0, "permission-denied");
		return fd;
	} catch (e) {
		closeSync(fd);
		throw e;
	}
}

interface LogTrack {
	kind: Appended;
	name: string;
	/** Bytes committed or appended since: the header plus complete lines. */
	length: number;
	/** Lines after the header. */
	records: number;
	/** sha256 over [0, length). */
	hash: Hash;
	/** log and adjust: the record keys; observations: the observation keys. */
	keys: Set<string>;
	/** receipts: receipt tag -> the offset of its latest line. */
	index: Map<string, number>;
	/** The file on disk; null until it exists. */
	stat: Stats | null;
}
interface Scan {
	track: LogTrack;
	/** The file's size when proven; the bytes past track.length are uncommitted and get cut. */
	size: number;
}
const NOTHING = Buffer.alloc(0),
	KEY_HEAD = Buffer.from(RECEIPT_HEAD, "latin1"),
	KEY_END = KEY_HEAD.length + 64,
	KIND_HEAD = Buffer.from('","kind":"', "latin1"),
	KINDS = ["ledger-native", "same-call"] as const;
/**
 * A certified line's key, read where the store writes it (k first, 64 hex digits), without parsing the line: the
 * prefix's sha256 proves the rest. A copy, so the Set never pins the read buffer.
 */
function lineKey(data: Buffer, from: number, nl: number): string | null {
	if (nl - from <= KEY_END || data.compare(KEY_HEAD, 0, KEY_HEAD.length, from, from + KEY_HEAD.length) !== 0)
		return null;
	if (data[from + KEY_END] !== 0x22) return null;
	const k = data.toString("latin1", from + KEY_HEAD.length, from + KEY_END);
	return HEX64.test(k) ? k : null;
}
/** A certified receipt line's tag, read at its fixed place like lineKey. */
function lineTag(data: Buffer, from: number, nl: number): string | null {
	const k = lineKey(data, from, nl);
	if (k === null) return null;
	const at = from + KEY_END;
	if (data.compare(KIND_HEAD, 0, KIND_HEAD.length, at, at + KIND_HEAD.length) !== 0) return null;
	for (const kind of KINDS) {
		const end = at + KIND_HEAD.length + kind.length;
		if (end < nl && data.toString("latin1", at + KIND_HEAD.length, end + 1) === `${kind}"`) return receiptTag(kind, k);
	}
	return null;
}
interface WeekState {
	week: string;
	start: string;
	end: string;
	phase: "open" | "sealed" | "unavailable";
	code: UsageWeekStoreCode | null;
	log: LogTrack;
	receipts: LogTrack;
	checkpoint: UsageWeekCheckpoint | UsageWeekLegacyCheckpoint | null;
	/** Sealed weeks: sorted 32-hex key digests, proven against the sealed file's sha256. */
	sealedKeys: string;
	adjust: LogTrack;
	observations: LogTrack;
	/** The checkpoint's unobserved count plus what appends since added; the next checkpoint commits it. */
	unobserved: number;
	/** Uncommitted observation bytes the last reload cut off. */
	dropped: number;
	/**
	 * The one replay stream: where its next page starts, the sha256 of every byte before that, and the checkpoint's
	 * committed observations and coverage when it started (what it replays, whatever is appended meanwhile).
	 */
	replay: {
		offset: number;
		ordinal: number;
		tag: string;
		hash: Hash;
		committed: UsageWeekLogState;
		coverage: UsageWeekObservationCoverage;
	} | null;
}
const track = (week: string, kind: Appended): LogTrack => ({
	kind,
	name: weekName(week, kind),
	length: 0,
	records: 0,
	hash: createHash("sha256"),
	keys: new Set(),
	index: new Map(),
	stat: null,
});
const MISMATCH = {
		log: "log-mismatch",
		adjust: "adjust-mismatch",
		receipts: "receipts-mismatch",
		observations: "observations-mismatch",
	} as const,
	CORRUPT = {
		log: "log-corrupt",
		adjust: "adjust-corrupt",
		receipts: "receipts-corrupt",
		observations: "observations-corrupt",
	} as const,
	MISSING = {
		log: "log-missing",
		adjust: "adjust-missing",
		receipts: "receipts-missing",
		observations: "observations-missing",
	} as const;
const legacy = (c: UsageWeekCheckpoint | UsageWeekLegacyCheckpoint | null): c is UsageWeekLegacyCheckpoint =>
	c !== null && c.v === LEGACY_CHECKPOINT_V;
/** What a checkpoint commits of the observations: nothing without one or with a legacy one (a file there is not
 *  committed). */
const committedObservations = (c: UsageWeekCheckpoint | UsageWeekLegacyCheckpoint | null): UsageWeekLogState | null =>
	c === null || legacy(c) ? null : c.observations;

/** All filesystem and hash work stays in one lifetime-locked worker; every call is synchronous. */
export class UsageWeekStore {
	readonly limits: Readonly<UsageWeekStoreLimits>;
	private badLimits = false;
	private phase: UsageWeekStoreState = "unavailable";
	private code: UsageWeekStoreCode | null = null;
	private parent = -1;
	private root = -1;
	private rootStat: Stats | null = null;
	private lock: GuardFileLock | null = null;
	private lease: Int32Array | null = null;
	private heldLease = false;
	private weeks = new Map<string, WeekState>();
	private constructor(private readonly o: UsageWeekStoreOptions) {
		const limits: UsageWeekStoreLimits = { ...USAGE_WEEK_STORE_LIMITS };
		for (const [key, value] of Object.entries(o.limits ?? {})) {
			if (
				Object.hasOwn(limits, key) &&
				Number.isSafeInteger(value) &&
				value! > 0 &&
				value! <= limits[key as keyof UsageWeekStoreLimits]
			)
				limits[key as keyof UsageWeekStoreLimits] = value!;
			else this.badLimits = true;
		}
		this.limits = Object.freeze(limits);
	}
	/** Never throws: a store that can't start says why in status() and refuses every call. */
	static open(o: UsageWeekStoreOptions): UsageWeekStore {
		const store = new UsageWeekStore(o);
		try {
			store.start();
		} catch (e) {
			store.unavailable(e);
		}
		return store;
	}
	status(): { state: UsageWeekStoreState; code: UsageWeekStoreCode | null } {
		if (this.phase === "ready") {
			try {
				this.owned();
			} catch (e) {
				this.unavailable(e);
			}
		}
		return { state: this.phase, code: this.code };
	}
	private unavailable(e: unknown): void {
		this.code = codeOf(e);
		this.phase = "unavailable";
		this.weeks.clear();
	}
	private waiting(): void {
		this.phase = "waiting-for-previous-writer";
		this.code = "waiting-for-previous-writer";
	}
	private start(): void {
		check(!isMainThread, "worker-required");
		check(!this.badLimits, "store-capacity");
		check(this.o.lease instanceof SharedArrayBuffer && this.o.lease.byteLength === 4, "unsafe-path");
		this.lease = new Int32Array(this.o.lease);
		if (Atomics.compareExchange(this.lease, 0, 0, 1) !== 0) return this.waiting();
		this.heldLease = true;
		this.parent = dataDirectory(this.o.dataDir);
		let created = false;
		try {
			mkdirSync(fdPath(this.parent, USAGE_WEEK_DIRECTORY), { mode: 0o700 });
			created = true;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		if (created) {
			const fd = directory(fdPath(this.parent, USAGE_WEEK_DIRECTORY));
			try {
				fchmodSync(fd, 0o700);
			} finally {
				closeSync(fd);
			}
			fsyncSync(this.parent);
		}
		this.root = directory(fdPath(this.parent, USAGE_WEEK_DIRECTORY), 0o700);
		this.rootStat = fstatSync(this.root);
		this.lock = new GuardFileLock({ dir: fdPath(this.root), log: () => undefined });
		const lockPath = fdPath(this.root, "lock");
		try {
			privateFile(lstatSync(lockPath));
			const pid = Number(this.readText("lock", 32, "unsafe-path").trim());
			check(Number.isSafeInteger(pid) && pid > 0, "unsafe-path");
			let alive = true;
			try {
				process.kill(pid, 0);
			} catch (e) {
				alive = (e as NodeJS.ErrnoException).code !== "ESRCH";
			}
			// Our own pid counts as alive: a same-process writer is never displaced.
			if (alive) return this.waiting();
		} catch (e) {
			if (!missing(e)) throw e;
		}
		if (this.lock.check() !== null || this.lock.takeLock() !== null) return this.waiting();
		privateFile(lstatSync(lockPath));
		this.fault("reopen");
		this.phase = "ready";
		this.code = null;
	}
	private anchored(): void {
		check(this.root >= 0 && this.parent >= 0 && this.rootStat, "unsafe-path");
		check(identity(lstatSync(fdPath(this.parent, USAGE_WEEK_DIRECTORY)), this.rootStat), "unsafe-path");
		const st = fstatSync(this.root);
		check(st.uid === uid() && (st.mode & 0o777) === 0o700, "permission-denied");
	}
	private owned(): void {
		this.anchored();
		check(
			this.heldLease && this.lease !== null && Atomics.load(this.lease, 0) === 1 && this.lock?.lockLost() === null,
			"writer-lost",
		);
	}
	/** Refusals leave the store ready; a week's failed check makes that week unavailable; anything else stops it. */
	private run<T>(week: string | null, fn: () => T): T {
		if (this.phase !== "ready") throw new UsageWeekStoreError(this.code ?? "closed");
		try {
			this.owned();
			return fn();
		} catch (e) {
			const code = e instanceof UsageWeekStoreError ? e.code : null;
			if (code !== null && REFUSALS.has(code)) throw e;
			if (code !== null && WEEK_FAILURES.has(code) && week !== null) {
				this.markWeek(week, code);
				throw e;
			}
			this.unavailable(e);
			throw new UsageWeekStoreError(this.code!);
		}
	}
	private fault(point: UsageWeekPoint): void {
		this.o.fault?.(point);
	}
	private now(): number {
		return this.o.now?.() ?? Date.now();
	}
	private fresh(week: string): WeekState {
		const { start, end } = usageWeekBounds(week);
		return {
			week,
			start,
			end,
			phase: "open",
			code: null,
			log: track(week, "log"),
			receipts: track(week, "receipts"),
			checkpoint: null,
			sealedKeys: "",
			adjust: track(week, "adjust"),
			observations: track(week, "observations"),
			unobserved: 0,
			dropped: 0,
			replay: null,
		};
	}
	private markWeek(week: string, code: UsageWeekStoreCode): void {
		const s = this.weeks.get(week) ?? this.fresh(week);
		s.phase = "unavailable";
		s.code = code;
		this.weeks.set(week, s);
	}
	private loaded(week: string): WeekState {
		check(validWeek(week), "invalid-week");
		const s = this.weeks.get(week);
		check(s !== undefined, "not-loaded");
		check(s.phase !== "unavailable", "week-unavailable");
		return s;
	}
	private state(week: string, phase: "open" | "sealed"): WeekState {
		const s = this.loaded(week);
		check(s.phase === phase, phase === "open" ? "sealed" : "not-sealed");
		return s;
	}
	/** A week that can take writes: a legacy week can't, since its next checkpoint would claim coverage it never had. */
	private writable(week: string, phase: "open" | "sealed"): WeekState {
		const s = this.state(week, phase);
		check(!legacy(s.checkpoint), "legacy-week");
		return s;
	}

	/** Which weeks have which files, from the folder's names alone. */
	listWeeks(): UsageWeekListing {
		return this.run(null, () => {
			const weeks = new Map<string, Record<WeekFile, boolean> & { observations?: true }>();
			let scratch = 0,
				quarantined = 0,
				other = 0;
			for (const name of this.names()) {
				const m = WEEK_NAME.exec(name);
				if (m !== null && validWeek(m[1])) {
					const entry = weeks.get(m[1]) ?? {
						log: false,
						receipts: false,
						checkpoint: false,
						sealed: false,
						adjust: false,
					};
					if (m[2] === "observations") entry.observations = true;
					else entry[m[2] as WeekFile] = true;
					weeks.set(m[1], entry);
				} else if (SCRATCH.test(name)) scratch++;
				else if (QUARANTINE.test(name)) quarantined++;
				else if (name !== "lock" && !/^lock\.(?:tmp|stale)-\d+$/.test(name)) other++;
			}
			return {
				weeks: [...weeks].sort(([a], [b]) => (a < b ? -1 : 1)).map(([week, files]) => ({ week, ...files })),
				scratch,
				quarantined,
				other,
			};
		});
	}

	/**
	 * Loads one week from disk and proves it before anything is written to it. The checkpoint is the commit point
	 * (Architecture M4): each log's bytes up to the checkpointed length must hash to the checkpoint's sha256, or the
	 * week is unavailable (figures unknown, never zero, and its bytes left as they are). Once every file is proven,
	 * everything past the checkpointed lengths, synced or not, is cut off and synced, so the readers' cursors and the
	 * week's records always agree. The proof reads only each line's key (the hash covers the rest); `each`, when given,
	 * gets the records afterwards. Streaming avoids retaining 250,000 record objects; receipt-inclusive timing still
	 * missed H-B2's 1 s target (docs/usage-accounting-week-store.md).
	 */
	reload(week: string, each?: UsageWeekEach): UsageWeekLoad {
		return this.run(null, () => {
			check(validWeek(week), "invalid-week");
			this.weeks.delete(week);
			try {
				return this.load(week, each);
			} catch (e) {
				if (!(e instanceof UsageWeekStoreError) || !WEEK_FAILURES.has(e.code)) throw e;
				this.markWeek(week, e.code);
				return { state: "unavailable", week, code: e.code };
			}
		});
	}
	private load(week: string, each: UsageWeekEach | undefined): UsageWeekLoad {
		const s = this.fresh(week);
		const has = Object.fromEntries(STORED_FILES.map((kind) => [kind, this.exists(weekName(week, kind))])) as Record<
			StoredFile,
			boolean
		>;
		if (STORED_FILES.every((kind) => !has[kind])) {
			this.weeks.set(week, s);
			return { state: "empty", week };
		}
		check(has.log, "log-missing");
		const checkpoint = has.checkpoint ? this.readCheckpoint(week) : null;
		if (has.sealed) return this.loadSealed(s, checkpoint, has, each);
		check(!has.adjust && (checkpoint === null || checkpoint.adjust === null), "adjust-corrupt");
		const log = this.scanLog(s, "log", checkpoint?.log ?? null),
			receipts = this.scanOptional(s, "receipts", has.receipts, checkpoint?.receipts ?? null),
			observations = this.scanOptional(s, "observations", has.observations, committedObservations(checkpoint));
		const dropped = { records: this.cut(log), receipts: receipts === null ? 0 : this.cut(receipts) };
		s.dropped = observations === null ? 0 : this.cut(observations);
		if (each) this.replay(s, log.track, each);
		s.log = log.track;
		if (receipts !== null) s.receipts = receipts.track;
		if (observations !== null) s.observations = observations.track;
		s.checkpoint = checkpoint;
		s.unobserved = checkpoint === null || legacy(checkpoint) ? 0 : checkpoint.unobserved;
		this.weeks.set(week, s);
		return {
			state: "open",
			week,
			records: s.log.records,
			receipts: s.receipts.index.size,
			checkpoint,
			dropped,
		};
	}
	/**
	 * A sealed week's main log is frozen: its sha256 was proven when sealed, so here only its length and its header are
	 * checked (Architecture HOME F4: another version, or another week's header, is not this week's log).
	 */
	private loadSealed(
		s: WeekState,
		checkpoint: UsageWeekCheckpoint | UsageWeekLegacyCheckpoint | null,
		has: Record<StoredFile, boolean>,
		each: UsageWeekEach | undefined,
	): UsageWeekLoad {
		const { head, keys } = this.readSealed(s.week);
		check(checkpoint !== null && sameLog(checkpoint.log, head.log), "sealed-corrupt");
		const log = this.file(s.log.name);
		try {
			check(log.stat.size === head.log.length, "log-mismatch");
			this.checkHeader(log.fd, log.stat.size, "log", s.week);
			s.log = { ...track(s.week, "log"), length: head.log.length, records: head.log.records, stat: log.stat };
		} finally {
			closeSync(log.fd);
		}
		const adjust = this.scanOptional(s, "adjust", has.adjust, checkpoint.adjust),
			receipts = this.scanOptional(s, "receipts", has.receipts, checkpoint.receipts),
			observations = this.scanOptional(s, "observations", has.observations, committedObservations(checkpoint));
		if (adjust !== null) for (const k of adjust.track.keys) check(!sortedHas(keys, k.slice(0, 32)), "adjust-corrupt");
		const dropped = {
			records: adjust === null ? 0 : this.cut(adjust),
			receipts: receipts === null ? 0 : this.cut(receipts),
		};
		s.dropped = observations === null ? 0 : this.cut(observations);
		if (adjust !== null) {
			if (each) this.replay(s, adjust.track, each);
			s.adjust = adjust.track;
		}
		if (receipts !== null) s.receipts = receipts.track;
		if (observations !== null) s.observations = observations.track;
		s.phase = "sealed";
		s.sealedKeys = keys;
		s.checkpoint = checkpoint;
		s.unobserved = legacy(checkpoint) ? 0 : checkpoint.unobserved;
		this.weeks.set(s.week, s);
		return {
			state: "sealed",
			week: s.week,
			sealed: head,
			checkpoint,
			adjustments: s.adjust.records,
			receipts: s.receipts.index.size,
			dropped,
		};
	}
	/**
	 * A log the checkpoint may or may not name: named -> it must exist and match; not named -> it is uncommitted
	 * (a crash before its first checkpoint), proven down to its header and cut to it; absent -> null.
	 */
	private scanOptional(
		s: WeekState,
		kind: "receipts" | "adjust" | "observations",
		has: boolean,
		certified: UsageWeekLogState | null,
	): Scan | null {
		if (certified !== null) check(has, MISSING[kind]);
		return has ? this.scanLog(s, kind, certified) : null;
	}

	/**
	 * Appends an open week's records, receipts and observations (O_APPEND, fdatasync) before returning; nothing is
	 * committed until the next checkpoint, which B3 writes right after with its cursors. A record key already in the
	 * week, or twice in the batch, is skipped and counted; so is a receipt identical to the stored one, and an
	 * observation already kept. Lookups (receipt) see appended receipts at once: a crash drops them together with the
	 * records, observations and cursors they came with. The result has the observation counts when observations were
	 * given (so B2's result is unchanged without them).
	 */
	append(week: string, records: readonly UsageWeekRecord[], receipts?: readonly UsageWeekReceipt[]): UsageWeekAppend;
	append(
		week: string,
		records: readonly UsageWeekRecord[],
		receipts: readonly UsageWeekReceipt[],
		observations: readonly UsageWeekObservationInput[],
	): UsageWeekAppend & UsageWeekObserved;
	append(
		week: string,
		records: readonly UsageWeekRecord[],
		receipts: readonly UsageWeekReceipt[] = [],
		observations?: readonly UsageWeekObservationInput[],
	): UsageWeekAppend | (UsageWeekAppend & UsageWeekObserved) {
		return this.run(week, () => {
			const s = this.writable(week, "open");
			const r = this.prepare(s, records, (k) => s.log.keys.has(k)),
				x = this.prepareReceipts(s, receipts),
				b = this.prepareObservations(s, observations ?? [], r.all, (k) => s.log.keys.has(k), "open");
			check(s.log.records + r.lines.length <= this.limits.weekRecords, "store-capacity");
			// The main log's header comes before any receipt or observation (Architecture HOME F1): a first batch of them
			// alone, cut after they synced, then reloads as an open week with nothing committed, never as a week whose log
			// is missing.
			if (x.lines.length + b.lines.length > 0) this.ensureLog(s.log, s.week);
			this.addLines(s, s.log, r.lines, r.keys);
			this.addLines(s, s.receipts, x.lines, []);
			this.addLines(s, s.observations, b.lines, b.keys);
			const unobserved = r.originals.filter((k) => !b.bound.has(k)).length;
			s.unobserved += unobserved;
			const result: UsageWeekAppend = {
				appended: r.lines.length,
				duplicates: r.duplicates,
				receipts: x.lines.length,
				receiptDuplicates: x.duplicates,
				records: s.log.records,
				length: s.log.length,
			};
			return observations === undefined
				? result
				: { ...result, observations: b.lines.length, observationDuplicates: b.duplicates, unobserved };
		});
	}
	private addLines(s: WeekState, t: LogTrack, lines: string[], keys: string[]): void {
		if (lines.length === 0) return;
		this.ensureLog(t, s.week);
		this.appendLines(t, lines);
		for (const k of keys) t.keys.add(k);
	}
	/** New lines and keys; all: every record key in the call; originals: the new originals' keys. */
	private prepare(s: WeekState, records: readonly unknown[], seen: (k: string) => boolean) {
		check(Array.isArray(records) && records.length <= this.limits.appendRecords, "store-capacity");
		const lines: string[] = [],
			keys: string[] = [],
			originals: string[] = [],
			all = new Set<string>();
		let duplicates = 0,
			bytes = 0;
		for (const r of records) {
			const problem = recordProblem(r, s.start, s.end);
			if (problem !== null) fail(problem);
			const record = r as UsageWeekRecord,
				line = `${serialize(record)}\n`;
			check(line.length <= this.limits.recordBytes, "invalid-record");
			if (seen(record.k) || all.has(record.k)) {
				duplicates++;
				continue;
			}
			all.add(record.k);
			keys.push(record.k);
			if (record.d === "original") originals.push(record.k);
			lines.push(line);
			bytes += line.length;
		}
		check(bytes <= this.limits.appendBytes, "store-capacity");
		for (const r of records) all.add((r as UsageWeekRecord).k);
		return { lines, keys, duplicates, originals, all };
	}
	/**
	 * Ops #500: the whole batch checked before anything is written. A row the contract refuses, or rk naming no record
	 * of this call or the week, is invalid-observation; a fact of another week is wrong-week. An observation already
	 * kept, or twice in the batch, is skipped and counted. bound: the records a newly written fact is bound to.
	 */
	private prepareObservations(
		s: WeekState,
		observations: readonly unknown[],
		call: ReadonlySet<string>,
		known: (k: string) => boolean,
		p: "open" | "late",
	) {
		check(Array.isArray(observations) && observations.length <= this.limits.appendObservations, "store-capacity");
		const lines: string[] = [],
			keys: string[] = [],
			batch = new Set<string>(),
			bound = new Set<string>();
		let duplicates = 0,
			bytes = 0;
		for (const x of observations) {
			check(closed(x, "o,r,rk"), "invalid-observation");
			const built = observationLine(x.o, x.r, p, x.rk);
			check(built !== null && built.line.length <= this.limits.observationBytes, "invalid-observation");
			const rk = x.rk as string | null;
			check(rk === null || call.has(rk) || known(rk), "invalid-observation");
			if (x.o === "fact") {
				const at = (x.r as UsageFact).occurredAt;
				check(at >= s.start && at < s.end, "wrong-week");
			}
			if (s.observations.keys.has(built.k) || batch.has(built.k)) {
				duplicates++;
				continue;
			}
			batch.add(built.k);
			keys.push(built.k);
			lines.push(built.line);
			bytes += built.line.length;
			if (x.o === "fact" && rk !== null) bound.add(rk);
		}
		check(
			bytes <= this.limits.appendObservationBytes &&
				s.observations.records + lines.length <= this.limits.weekObservations,
			"store-capacity",
		);
		return { lines, keys, duplicates, bound };
	}
	private prepareReceipts(s: WeekState, receipts: readonly unknown[]) {
		check(Array.isArray(receipts) && receipts.length <= this.limits.appendRecords, "store-capacity");
		const lines: string[] = [],
			pending = new Map<string, string>();
		let duplicates = 0,
			bytes = 0;
		for (const x of receipts) {
			const line = receiptLine(x);
			check(line !== null && line.length <= this.limits.receiptBytes, "invalid-receipt");
			const at = receiptAt(x as UsageWeekReceipt);
			check(at >= s.start && at < s.end, "wrong-week");
			const { kind, k } = x as UsageWeekReceipt,
				tag = receiptTag(kind, k),
				before = pending.get(tag) ?? this.storedReceipt(s, tag);
			if (before === line) {
				duplicates++;
				continue;
			}
			check(before === null || aliasAttached(before, x as UsageWeekReceipt), "invalid-receipt");
			pending.set(tag, line);
			lines.push(line);
			bytes += line.length;
		}
		check(
			bytes <= this.limits.appendReceiptBytes && s.receipts.records + lines.length <= this.limits.weekReceipts,
			"store-capacity",
		);
		return { lines, duplicates };
	}
	/** The stored line for a receipt tag (its latest), read back from the file; null when the week has none. */
	private storedReceipt(s: WeekState, tag: string): string | null {
		const at = s.receipts.index.get(tag);
		if (at === undefined) return null;
		const t = s.receipts,
			f = this.file(t.name);
		try {
			check(t.stat !== null && identity(f.stat, t.stat) && f.stat.size === t.length, "receipts-mismatch");
			const length = Math.min(this.limits.receiptBytes, t.length - at),
				buffer = Buffer.allocUnsafe(length);
			this.readInto(f.fd, buffer, length, at);
			const nl = buffer.indexOf(0x0a);
			check(nl > 0, "receipts-corrupt");
			return buffer.toString("latin1", 0, nl + 1);
		} finally {
			closeSync(f.fd);
		}
	}

	/**
	 * What W2's first(key) (kind ledger-native) or sameCall(provider, responseId) (kind same-call, key =
	 * sha256(JSON.stringify([provider, responseId]))) should return for this week: the stored receipt, re-validated,
	 * or null when the week proves it has none. Bound to one loaded week (Architecture M10: B3 reads the ledger one week
	 * at a time); a week that is unavailable or not loaded throws, which W2 treats as index-unavailable, never as null.
	 */
	receipt(week: string, kind: UsageWeekReceiptKind, k: string): LedgerNativeReceipt | LedgerSameCall | null {
		return this.run(week, () => {
			const s = this.loaded(week);
			check(
				(kind === "ledger-native" || kind === "same-call") && typeof k === "string" && HEX64.test(k),
				"invalid-receipt",
			);
			const line = this.storedReceipt(s, receiptTag(kind, k));
			if (line === null) return null;
			let x: UsageWeekReceipt;
			try {
				x = JSON.parse(line) as UsageWeekReceipt;
			} catch {
				return fail("receipts-corrupt");
			}
			check(x.kind === kind && x.k === k && receiptLine(x) === line, "receipts-corrupt");
			const at = receiptAt(x);
			check(at >= s.start && at < s.end, "receipts-corrupt");
			return x.r;
		});
	}

	/**
	 * Certifies the log, receipts and observations as they stand (length, records, sha256 each) with the readers'
	 * cursors and the unobserved count, in one file; omitted cursors keep the last checkpoint's. An empty week gets its
	 * log (header only) first, so a checkpoint always names a log. A legacy week is refused (legacy-week).
	 */
	checkpoint(week: string, cursors?: UsageWeekCursors): UsageWeekCheckpoint {
		return this.run(week, () => {
			const s = this.writable(week, "open");
			const next = cursors ?? { files: s.checkpoint?.files ?? {}, ledger: s.checkpoint?.ledger ?? null };
			check(validCursors(next, this.limits.files), "invalid-cursors");
			this.ensureLog(s.log, week);
			return this.writeCheckpoint(s, next, this.logState(s.log), null);
		});
	}
	private logState(t: LogTrack): UsageWeekLogState {
		return { length: t.length, records: t.records, sha256: t.hash.copy().digest("hex") };
	}
	/**
	 * Commits the logs as they stand: the main log as given, the receipts, observations and adjustment logs as
	 * appended, with the week's unobserved count (Ops #500: one commit point for all of them and the cursors).
	 */
	private writeCheckpoint(
		s: WeekState,
		cursors: UsageWeekCursors,
		log: UsageWeekLogState,
		adjust: UsageWeekLogState | null,
	): UsageWeekCheckpoint {
		this.unchanged(s.log, "log-changed");
		if (s.receipts.stat !== null) this.unchanged(s.receipts, "receipts-mismatch");
		if (s.adjust.stat !== null) this.unchanged(s.adjust, "adjust-mismatch");
		if (s.observations.stat !== null) this.unchanged(s.observations, "observations-mismatch");
		const body = {
			v: CHECKPOINT_V,
			week: s.week,
			at: new Date(this.now()).toISOString(),
			log,
			receipts: s.receipts.stat === null ? null : this.logState(s.receipts),
			adjust,
			observations: s.observations.stat === null ? null : this.logState(s.observations),
			unobserved: s.unobserved,
			files: cursors.files,
			ledger: cursors.ledger,
		};
		const text = `${canonical({ ...body, sha256: sha(canonical(body)) })}\n`;
		check(text.length <= this.limits.checkpointBytes, "store-capacity");
		this.atomic(weekName(s.week, "checkpoint"), text, "checkpoint");
		s.checkpoint = JSON.parse(text) as UsageWeekCheckpoint;
		return s.checkpoint;
	}

	/**
	 * Freezes an ended week: per-subject totals (USD exact), 16-byte key digests and the log's sha256, from the log
	 * re-read and re-proven on disk. The caller (B5) seals after its grace; the store refuses a week not yet ended and
	 * a log with records the last checkpoint doesn't cover.
	 */
	seal(week: string, coverage: UsageWeekCoverage): UsageWeekSealed {
		return this.run(week, () => {
			const s = this.state(week, "open");
			check(validCoverage(coverage), "invalid-coverage");
			check(this.now() >= Date.parse(s.end), "week-not-ended");
			const committed = (t: LogTrack, c: UsageWeekLogState | null | undefined) =>
				t.stat === null ? c === null : c != null && sameLog(c, this.logState(t));
			// A legacy week can still be sealed by its numbers: it can't have observations (writes to it are refused, and
			// a stray file next to its checkpoint is cut to its header on reload); its coverage stays legacy.
			check(
				s.checkpoint !== null &&
					s.log.stat !== null &&
					committed(s.log, s.checkpoint.log) &&
					committed(s.receipts, s.checkpoint.receipts) &&
					(legacy(s.checkpoint) ? s.observations.records === 0 : committed(s.observations, s.checkpoint.observations)),
				"checkpoint-behind",
			);
			const fold = new WeekFold();
			const scan = this.scanLog(s, "log", s.checkpoint.log);
			check(scan.track.length === s.log.length && scan.size === s.log.length, "log-changed");
			scan.track.stat = s.log.stat;
			this.replay(s, scan.track, (r) => fold.add(r));
			const total = fold.done();
			// Unknowns and gaps make a week partial: "complete" with any of them would show unknown as zero (M6).
			const c = total.total.count;
			check(coverage.state !== "complete" || c.unverified + c.unresolved + c.gap === 0, "invalid-coverage");
			const keys = Array.from(scan.track.keys, (k) => k.slice(0, 32))
				.sort()
				.join("");
			const body = {
				v: SEALED_V,
				week,
				sealedAt: new Date(this.now()).toISOString(),
				log: s.checkpoint.log,
				coverage: {
					state: coverage.state,
					gaps: coverage.gaps.map((g) => ({ code: g.code, count: g.count })).sort((a, b) => (a.code < b.code ? -1 : 1)),
				},
				...total,
				keys: { count: scan.track.keys.size, bytes: 16, sha256: sha(keys) },
			};
			const head = canonical({ ...body, sha256: sha(canonical(body)) });
			const text = `${head}\n${keys}\n`;
			check(text.length <= this.limits.sealedBytes, "store-capacity");
			this.atomic(weekName(week, "sealed"), text, "seal");
			s.phase = "sealed";
			s.sealedKeys = keys;
			s.log.keys = new Set();
			return JSON.parse(head) as UsageWeekSealed;
		});
	}

	/**
	 * Late attempts for a sealed week, with their receipts and observations: a key in the sealed digests or already
	 * adjusted is a duplicate (counted, not added), and so is an observation already kept; the rest go to the week's
	 * adjustment log (and receipts and observations logs, observations marked late), synced, then committed by the
	 * week's checkpoint before returning. Sealed totals and the current week never change. A legacy week is refused.
	 */
	adjust(week: string, records: readonly UsageWeekRecord[], receipts?: readonly UsageWeekReceipt[]): UsageWeekAdjust;
	adjust(
		week: string,
		records: readonly UsageWeekRecord[],
		receipts: readonly UsageWeekReceipt[],
		observations: readonly UsageWeekObservationInput[],
	): UsageWeekAdjust & UsageWeekObserved;
	adjust(
		week: string,
		records: readonly UsageWeekRecord[],
		receipts: readonly UsageWeekReceipt[] = [],
		observations?: readonly UsageWeekObservationInput[],
	): UsageWeekAdjust | (UsageWeekAdjust & UsageWeekObserved) {
		return this.run(week, () => {
			const s = this.writable(week, "sealed");
			check(s.checkpoint !== null, "sealed-corrupt");
			// A sealed key is known by its 16-byte digest, as for B2's duplicates.
			const known = (k: string) => sortedHas(s.sealedKeys, k.slice(0, 32)) || s.adjust.keys.has(k);
			const r = this.prepare(s, records, known),
				x = this.prepareReceipts(s, receipts),
				b = this.prepareObservations(s, observations ?? [], r.all, known, "late");
			check(s.adjust.records + r.lines.length <= this.limits.weekRecords, "store-capacity");
			this.addLines(s, s.adjust, r.lines, r.keys);
			this.addLines(s, s.receipts, x.lines, []);
			this.addLines(s, s.observations, b.lines, b.keys);
			const unobserved = r.originals.filter((k) => !b.bound.has(k)).length;
			s.unobserved += unobserved;
			if (r.lines.length + x.lines.length + b.lines.length > 0) {
				const { files, ledger, log } = s.checkpoint;
				this.writeCheckpoint(s, { files, ledger }, log, s.adjust.stat === null ? null : this.logState(s.adjust));
			}
			const result: UsageWeekAdjust = {
				added: r.lines.length,
				duplicates: r.duplicates,
				receipts: x.lines.length,
				receiptDuplicates: x.duplicates,
				records: s.adjust.records,
			};
			return observations === undefined
				? result
				: { ...result, observations: b.lines.length, observationDuplicates: b.duplicates, unobserved };
		});
	}

	/** The sealed totals alone (the sealed file's first line, self-checked), for history; reads no log. */
	sealedTotals(week: string): UsageWeekSealedRead {
		return this.run(null, () => {
			check(validWeek(week), "invalid-week");
			const name = weekName(week, "sealed");
			if (!this.exists(name)) return { state: "none", week };
			try {
				const line = this.readFirstLine(name, this.limits.sealedBytes, "sealed-corrupt");
				return { state: "sealed", week, sealed: this.sealedHead(line.slice(0, -1), week) };
			} catch (e) {
				if (!(e instanceof UsageWeekStoreError) || !WEEK_FAILURES.has(e.code)) throw e;
				return { state: "unavailable", week, code: e.code };
			}
		});
	}

	/**
	 * Ops #500: what a week's observations cover, as its last checkpoint committed them: complete (every committed
	 * original record came with its fact), partial (some didn't), or legacy (B2 committed the week: its observations
	 * are unknown, never "none"). dropped: uncommitted observation bytes the last reload cut off.
	 */
	observationCoverage(week: string): UsageWeekObservationCoverage {
		return this.run(week, () => this.coverage(this.loaded(week)));
	}
	private coverage(s: WeekState): UsageWeekObservationCoverage {
		const c = s.checkpoint;
		if (legacy(c)) return { state: "legacy", observations: 0, unobserved: null, dropped: s.dropped };
		const unobserved = c?.unobserved ?? 0;
		return {
			state: unobserved === 0 ? "complete" : "partial",
			observations: c?.observations?.records ?? 0,
			unobserved,
			dropped: s.dropped,
		};
	}
	/**
	 * Ops #500: the next page of a week's committed observations, in the order they were appended. from = null starts
	 * a stream (ending any other of the week) over what the last checkpoint committed at that moment; each page's next
	 * continues it, and nothing else does (refused: invalid-replay, as is a stream a reload ended). Appends and
	 * checkpoints meanwhile don't change what the stream replays or the coverage its pages carry. A page holds at most
	 * `rows` lines and reads at most 4 MiB, from the file proven on reload, its identity and length checked before and
	 * after each page; each line must be exactly what append writes for its row (the row checked again, its key
	 * recomputed, byte for byte). At the last page (next null) the bytes read must hash to the checkpoint's sha256 over
	 * its count of lines. Rows count only once next is null: a failure on any page makes the week unavailable. A legacy
	 * week is refused (legacy-week), so unknown is never read as none.
	 */
	observations(
		week: string,
		from: UsageWeekReplayCursor | null = null,
		rows: number = this.limits.appendRecords,
	): UsageWeekObservationPage {
		return this.run(week, () => {
			const s = this.loaded(week);
			check(!legacy(s.checkpoint), "legacy-week");
			check(Number.isSafeInteger(rows) && rows >= 1 && rows <= this.limits.appendRecords, "invalid-replay");
			if (from === null) {
				s.replay = null;
				const committed = committedObservations(s.checkpoint),
					coverage = this.coverage(s);
				if (committed === null) return { week, coverage, observations: [], next: null };
				s.replay = {
					offset: 0,
					ordinal: 0,
					tag: randomBytes(8).toString("hex"),
					hash: createHash("sha256"),
					committed,
					coverage,
				};
			}
			const stream = s.replay;
			check(
				stream !== null &&
					(from === null ||
						(closed(from, "offset,ordinal,tag") &&
							from.offset === stream.offset &&
							from.ordinal === stream.ordinal &&
							from.tag === stream.tag)),
				"invalid-replay",
			);
			const { committed, coverage } = stream,
				t = s.observations,
				header = headerLine(week, "observations"),
				end = committed.length,
				f = this.file(t.name);
			try {
				const same = (st: Stats) => t.stat !== null && identity(st, t.stat) && st.size === t.length;
				check(same(f.stat) && end <= t.length && stream.offset < end, "observations-mismatch");
				const first = stream.offset === 0 ? header.length : 0,
					n = Math.min(READ_BYTES, end - stream.offset, first + rows * this.limits.observationBytes),
					buffer = Buffer.allocUnsafe(n);
				this.readInto(f.fd, buffer, n, stream.offset);
				check(first === 0 || buffer.toString("latin1", 0, first) === header, "observations-corrupt");
				const out: UsageWeekObservation[] = [];
				let at = first;
				for (let nl = buffer.indexOf(0x0a, at); nl !== -1 && out.length < rows; nl = buffer.indexOf(0x0a, at)) {
					const x = storedObservation(buffer.toString("latin1", at, nl + 1));
					check(x !== null, "observations-corrupt");
					out.push(x);
					at = nl + 1;
				}
				check(at > 0 && (out.length > 0 || stream.offset + at === end), "observations-corrupt");
				stream.hash.update(buffer.subarray(0, at));
				stream.offset += at;
				stream.ordinal += out.length;
				check(same(fstatSync(f.fd)), "observations-mismatch");
				if (stream.offset < end)
					return {
						week,
						coverage,
						observations: out,
						next: { offset: stream.offset, ordinal: stream.ordinal, tag: stream.tag },
					};
				s.replay = null;
				check(
					stream.hash.digest("hex") === committed.sha256 && stream.ordinal === committed.records,
					"observations-mismatch",
				);
				return { week, coverage, observations: out, next: null };
			} finally {
				closeSync(f.fd);
			}
		});
	}

	/**
	 * Moves an open or unavailable week's files aside (renamed, never deleted) so the week can be rebuilt from the
	 * sources; a proven sealed week is refused. The week is empty afterwards.
	 */
	quarantineWeek(week: string): { moved: string[] } {
		return this.run(week, () => {
			check(validWeek(week), "invalid-week");
			const s = this.weeks.get(week);
			check(s !== undefined, "not-loaded");
			check(s.phase !== "sealed", "sealed");
			const tag = randomBytes(8).toString("hex"),
				moved: string[] = [];
			for (const kind of STORED_FILES) {
				const name = weekName(week, kind);
				if (!this.exists(name)) continue;
				const aside = `${name}.quarantine-${tag}`;
				check(!this.exists(aside), "unsafe-path");
				this.fault("quarantine-rename");
				this.owned();
				renameSync(fdPath(this.root, name), fdPath(this.root, aside));
				moved.push(aside);
			}
			fsyncSync(this.root);
			this.weeks.set(week, this.fresh(week));
			return { moved };
		});
	}

	/**
	 * Removes a proven sealed, ended week's files, the sealed totals last. For a later retention choice only: the owner
	 * chose to keep all usage detail (dr-8795124dce74), so no production code calls this; a test checks that.
	 */
	deleteWeek(week: string): { removed: string[] } {
		return this.run(week, () => {
			const s = this.state(week, "sealed");
			check(this.now() >= Date.parse(s.end), "week-not-ended");
			const removed: string[] = [];
			for (const kind of ["adjust", "receipts", "observations", "checkpoint", "log", "sealed"] as const) {
				const name = weekName(week, kind);
				if (!this.exists(name)) continue;
				this.owned();
				unlinkSync(fdPath(this.root, name));
				removed.push(name);
			}
			fsyncSync(this.root);
			this.weeks.delete(week);
			return { removed };
		});
	}

	close(): void {
		this.phase = "closed";
		this.code = "closed";
		this.weeks.clear();
		try {
			this.lock?.stop();
		} finally {
			if (this.root >= 0) {
				closeSync(this.root);
				this.root = -1;
			}
			if (this.parent >= 0) {
				closeSync(this.parent);
				this.parent = -1;
			}
			if (this.heldLease && this.lease) {
				Atomics.compareExchange(this.lease, 0, 1, 0);
				this.heldLease = false;
			}
		}
	}

	/**
	 * Proves one log's committed part: [0, certified.length) must hash to certified.sha256 with certified.records lines
	 * (no checkpoint: the header alone). This store wrote and validated those lines, so only each line's key (and a
	 * receipt's kind) is read, at its fixed place; replay parses records later, once all is proven. Bytes past the
	 * committed length are not read: cut() drops them. Writes nothing.
	 */
	private scanLog(s: WeekState, kind: Appended, certified: UsageWeekLogState | null): Scan {
		const mismatch = MISMATCH[kind],
			corrupt = CORRUPT[kind],
			lost = certified === null ? corrupt : mismatch,
			receipts = kind === "receipts",
			observed = kind === "observations",
			lineBytes = receipts
				? this.limits.receiptBytes
				: observed
					? this.limits.observationBytes
					: this.limits.recordBytes,
			weekLines = receipts
				? this.limits.weekReceipts
				: observed
					? this.limits.weekObservations
					: this.limits.weekRecords;
		const t = track(s.week, kind),
			header = headerLine(s.week, kind),
			f = this.file(t.name);
		try {
			const size = f.stat.size,
				limit = certified?.length ?? header.length,
				buffer = Buffer.allocUnsafe(READ_BYTES);
			this.checkHeader(f.fd, size, kind, s.week);
			check(limit >= header.length && limit <= size, lost);
			check(limit <= header.length + weekLines * lineBytes, corrupt);
			let offset = 0,
				carry = NOTHING,
				damaged = false;
			while (offset < limit) {
				const n = Math.min(buffer.length, limit - offset);
				this.readInto(f.fd, buffer, n, offset);
				const chunk = buffer.subarray(0, n);
				t.hash.update(chunk);
				const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk,
					base = offset - carry.length;
				let from = offset === 0 ? header.length : 0;
				for (let nl = data.indexOf(0x0a, from); nl !== -1; nl = data.indexOf(0x0a, from)) {
					if (receipts) {
						// A later line for the same tag is an alias attach; the index keeps the latest.
						const tag = lineTag(data, from, nl);
						if (tag === null || nl + 1 - from > lineBytes) damaged = true;
						else t.index.set(tag, base + from);
					} else {
						const k = lineKey(data, from, nl);
						if (k === null || t.keys.has(k)) damaged = true;
						else t.keys.add(k);
					}
					t.records++;
					from = nl + 1;
				}
				carry = Buffer.from(data.subarray(from));
				check(carry.length < lineBytes, lost);
				offset += n;
			}
			check(carry.length === 0, lost);
			if (certified !== null)
				check(t.hash.copy().digest("hex") === certified.sha256 && t.records === certified.records, mismatch);
			check(!damaged, corrupt);
			t.length = limit;
			t.stat = f.stat;
			return { track: t, size };
		} finally {
			closeSync(f.fd);
		}
	}
	/**
	 * Cuts a proven log back to its committed length and syncs it, so the first append after a reload starts there
	 * (Architecture M4). Returns the bytes dropped; a crash in it leaves bytes the next reload drops again.
	 */
	private cut(scan: Scan): number {
		const t = scan.track;
		if (scan.size === t.length) return 0;
		const f = this.file(t.name);
		try {
			check(t.stat !== null && identity(f.stat, t.stat) && f.stat.size === scan.size, MISMATCH[t.kind]);
			this.fault("truncate");
			this.owned();
			ftruncateSync(f.fd, t.length);
			fsyncSync(f.fd);
			t.stat = fstatSync(f.fd);
			return scan.size - t.length;
		} finally {
			closeSync(f.fd);
		}
	}
	/**
	 * Hands a proven log's records to `each`, in file order, parsed from the same file (its identity and length
	 * unchanged since it was proven and cut, checked before and after).
	 */
	private replay(s: WeekState, t: LogTrack, each: UsageWeekEach): void {
		const kind = t.kind as "log" | "adjust",
			mismatch = MISMATCH[kind],
			f = this.file(t.name);
		try {
			const same = (st: Stats) => t.stat !== null && identity(st, t.stat) && st.size === t.length;
			check(same(f.stat), mismatch);
			const buffer = Buffer.allocUnsafe(READ_BYTES);
			let offset = 0,
				carry = NOTHING;
			while (offset < t.length) {
				const n = Math.min(buffer.length, t.length - offset);
				this.readInto(f.fd, buffer, n, offset);
				const chunk = buffer.subarray(0, n),
					data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
				let from = offset === 0 ? headerLine(s.week, kind).length : 0;
				for (let nl = data.indexOf(0x0a, from); nl !== -1; nl = data.indexOf(0x0a, from)) {
					let r: UsageWeekRecord;
					try {
						r = JSON.parse(data.toString("latin1", from, nl)) as UsageWeekRecord;
					} catch {
						return fail(mismatch);
					}
					each(r, kind);
					from = nl + 1;
				}
				carry = Buffer.from(data.subarray(from));
				offset += n;
			}
			check(carry.length === 0 && same(fstatSync(f.fd)), mismatch);
		} finally {
			closeSync(f.fd);
		}
	}

	/** The current checkpoint, or B2's (legacy: numeric only); any other version of the family is store-version. */
	private readCheckpoint(week: string): UsageWeekCheckpoint | UsageWeekLegacyCheckpoint {
		const text = this.readText(weekName(week, "checkpoint"), this.limits.checkpointBytes, "checkpoint-corrupt");
		let c: unknown;
		try {
			c = JSON.parse(text);
		} catch {
			return fail("checkpoint-corrupt");
		}
		const old = c !== null && typeof c === "object" && (c as Fields).v === LEGACY_CHECKPOINT_V;
		if (!old) version(c, CHECKPOINT_V, "checkpoint-corrupt");
		check(
			closed(
				c,
				old
					? "adjust,at,files,ledger,log,receipts,sha256,v,week"
					: "adjust,at,files,ledger,log,observations,receipts,sha256,unobserved,v,week",
			) &&
				c.week === week &&
				time(c.at) &&
				logState(c.log) &&
				(c.receipts === null || logState(c.receipts)) &&
				(c.adjust === null || logState(c.adjust)) &&
				(old ||
					((c.observations === null || logState(c.observations)) &&
						uint(c.unobserved) &&
						c.unobserved <= c.log.records + (c.adjust === null ? 0 : (c.adjust as UsageWeekLogState).records))) &&
				validCursors({ files: c.files, ledger: c.ledger }, this.limits.files) &&
				typeof c.sha256 === "string" &&
				HEX64.test(c.sha256),
			"checkpoint-corrupt",
		);
		const { sha256: claimed, ...body } = c;
		check(sha(canonical(body)) === claimed && `${canonical(c)}\n` === text, "checkpoint-corrupt");
		return c as unknown as UsageWeekCheckpoint | UsageWeekLegacyCheckpoint;
	}
	private readSealed(week: string): { head: UsageWeekSealed; keys: string } {
		const text = this.readText(weekName(week, "sealed"), this.limits.sealedBytes, "sealed-corrupt");
		const nl = text.indexOf("\n");
		check(nl > 0 && text.endsWith("\n"), "sealed-corrupt");
		const head = this.sealedHead(text.slice(0, nl), week),
			keys = text.slice(nl + 1, -1);
		check(keys.length === head.keys.count * 32 && HEXES.test(keys) && sha(keys) === head.keys.sha256, "sealed-corrupt");
		for (let i = 32; i < keys.length; i += 32) check(keys.slice(i - 32, i) <= keys.slice(i, i + 32), "sealed-corrupt");
		return { head, keys };
	}
	private sealedHead(line: string, week: string): UsageWeekSealed {
		let h: unknown;
		try {
			h = JSON.parse(line);
		} catch {
			return fail("sealed-corrupt");
		}
		version(h, SEALED_V, "sealed-corrupt");
		check(
			closed(h, "coverage,keys,log,sealedAt,sha256,subjects,total,v,week") &&
				h.week === week &&
				time(h.sealedAt) &&
				logState(h.log) &&
				validCoverage(h.coverage) &&
				closed(h.keys, "bytes,count,sha256") &&
				h.keys.bytes === 16 &&
				uint(h.keys.count) &&
				typeof h.keys.sha256 === "string" &&
				HEX64.test(h.keys.sha256) &&
				closed(h.total, "count,rates,tok,tokUnknown,usd,usdUnknown") &&
				Array.isArray(h.subjects) &&
				typeof h.sha256 === "string",
			"sealed-corrupt",
		);
		const { sha256: claimed, ...body } = h;
		check(sha(canonical(body)) === claimed && canonical(h) === line, "sealed-corrupt");
		return h as unknown as UsageWeekSealed;
	}

	/** Creates a log with its header line: temp file, fsync, rename, directory fsync. */
	private ensureLog(t: LogTrack, week: string): void {
		if (t.stat !== null) return;
		const header = headerLine(week, t.kind);
		this.atomic(t.name, header, "header");
		const f = this.file(t.name);
		try {
			check(f.stat.size === header.length, "io-failure");
			t.stat = f.stat;
		} finally {
			closeSync(f.fd);
		}
		t.length = header.length;
		t.records = 0;
		t.hash = createHash("sha256").update(header);
		t.keys = new Set();
		t.index = new Map();
	}
	/**
	 * Appends whole lines in place (Architecture M3): O_APPEND on the same inode, then fdatasync. Never a rewrite: the
	 * bytes written per pass are the new lines plus one checkpoint.
	 */
	private appendLines(t: LogTrack, lines: string[]): void {
		const f = this.file(t.name, "append");
		try {
			check(
				t.stat !== null && identity(f.stat, t.stat) && f.stat.size === t.length,
				t.kind === "log" ? "log-changed" : MISMATCH[t.kind],
			);
			const bytes = Buffer.from(lines.join(""), "latin1");
			this.write(f.fd, bytes, null, `${t.kind}-write`);
			this.fault(`${t.kind}-sync`);
			this.owned();
			fdatasyncSync(f.fd);
			if (t.kind === "receipts") {
				let at = t.length;
				for (const line of lines) {
					const x = JSON.parse(line) as UsageWeekReceipt;
					t.index.set(receiptTag(x.kind, x.k), at);
					at += line.length;
				}
			}
			t.length += bytes.length;
			t.records += lines.length;
			t.hash.update(bytes);
			t.stat = fstatSync(f.fd);
			this.fault(`after-${t.kind}-sync`);
		} finally {
			closeSync(f.fd);
		}
	}
	private unchanged(t: LogTrack, code: UsageWeekStoreCode): void {
		const st = lstatSync(fdPath(this.root, t.name));
		privateFile(st);
		check(t.stat !== null && identity(st, t.stat) && st.size === t.length, code);
	}
	/** Temp file, write, fsync, rename over the target (unchanged since we looked), directory fsync. */
	private atomic(name: string, text: string, point: "header" | "checkpoint" | "seal"): void {
		let previous: Stats | null = null;
		try {
			previous = lstatSync(fdPath(this.root, name));
			privateFile(previous);
		} catch (e) {
			if (!missing(e)) throw e;
		}
		check(point !== "header" || previous === null, "unsafe-path");
		const scratch = `${name}.next-${randomBytes(8).toString("hex")}`,
			f = this.file(scratch, "create");
		try {
			const bytes = Buffer.from(text, "utf8");
			for (let at = 0; at < bytes.length; at += WRITE_BYTES)
				this.write(f.fd, bytes.subarray(at, at + WRITE_BYTES), at, `${point}-write`);
			this.fault(`${point}-sync`);
			this.owned();
			this.checkFile(scratch, f.fd);
			fsyncSync(f.fd);
			this.fault(`${point}-rename`);
			this.owned();
			this.checkFile(scratch, f.fd);
			let target: Stats | null = null;
			try {
				target = lstatSync(fdPath(this.root, name));
				privateFile(target);
			} catch (e) {
				if (!missing(e)) throw e;
			}
			check(previous === null ? target === null : target !== null && identity(previous, target), "unsafe-path");
			renameSync(fdPath(this.root, scratch), fdPath(this.root, name));
			this.fault(`after-${point}-rename`);
			this.owned();
			this.checkFile(name, f.fd);
			fsyncSync(this.root);
		} finally {
			closeSync(f.fd);
		}
	}
	/** offset null: at the end (an O_APPEND file). */
	private write(fd: number, buffer: Uint8Array, offset: number | null, point: UsageWeekPoint): void {
		const injected = this.o.fault?.(point);
		this.owned();
		const length =
			typeof injected === "number" ? Math.max(0, Math.min(buffer.byteLength - 1, injected)) : buffer.byteLength;
		check(writeSync(fd, buffer, 0, length, offset) === buffer.byteLength, "io-failure");
	}
	private checkFile(name: string, fd: number): void {
		const path = lstatSync(fdPath(this.root, name)),
			st = fstatSync(fd);
		privateFile(path);
		privateFile(st);
		check(identity(path, st), "unsafe-path");
	}
	private exists(name: string): boolean {
		try {
			privateFile(lstatSync(fdPath(this.root, name)));
			return true;
		} catch (e) {
			if (missing(e)) return false;
			throw e;
		}
	}
	/** Opens a file in the store folder, never through a link: "create" makes a new one (O_EXCL, 0600). */
	private file(name: string, mode: "open" | "create" | "append" = "open"): { fd: number; stat: Stats } {
		check(NAME.test(name), "unsafe-path");
		const path = fdPath(this.root, name),
			create = mode === "create";
		if (!create) privateFile(lstatSync(path));
		const fd = openSync(
			path,
			(mode === "append" ? constants.O_WRONLY | constants.O_APPEND : constants.O_RDWR) |
				constants.O_NOFOLLOW |
				constants.O_NONBLOCK |
				(create ? constants.O_CREAT | constants.O_EXCL : 0),
			0o600,
		);
		try {
			if (create) fchmodSync(fd, 0o600);
			const stat = fstatSync(fd);
			privateFile(stat);
			const after = lstatSync(path);
			privateFile(after);
			check(identity(stat, after), "unsafe-path");
			return { fd, stat };
		} catch (e) {
			closeSync(fd);
			throw e;
		}
	}
	/**
	 * A log's first line (at most 512 bytes read) must be its own header: the same family with another version is
	 * store-version, anything else is `corrupt`. Shared by every reload path, the sealed one included.
	 */
	private checkHeader(fd: number, size: number, kind: Appended, week: string): void {
		const header = headerLine(week, kind),
			peek = Math.min(size, 512),
			buffer = Buffer.allocUnsafe(peek);
		this.readInto(fd, buffer, peek, 0);
		const newline = buffer.indexOf(0x0a),
			first = buffer.toString("latin1", 0, newline < 0 ? peek : newline + 1);
		if (first === header) return;
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(first);
		} catch {
			/* not a header at all */
		}
		version(parsed, family(kind), CORRUPT[kind]);
		fail(CORRUPT[kind]);
	}
	private readInto(fd: number, buffer: Buffer, length: number, offset: number): void {
		for (let done = 0; done < length;) {
			const n = readSync(fd, buffer, done, length - done, offset + done);
			check(n > 0, "io-failure");
			done += n;
		}
	}
	private readText(name: string, cap: number, code: UsageWeekStoreCode): string {
		const f = this.file(name);
		try {
			check(f.stat.size <= cap, code);
			const bytes = Buffer.allocUnsafe(f.stat.size);
			this.readInto(f.fd, bytes, f.stat.size, 0);
			try {
				return new TextDecoder("utf8", { fatal: true }).decode(bytes);
			} catch {
				return fail(code);
			}
		} finally {
			closeSync(f.fd);
		}
	}
	/** The first line with its newline, read in small pieces so the key digests after it are never read. */
	private readFirstLine(name: string, cap: number, code: UsageWeekStoreCode): string {
		const f = this.file(name);
		try {
			const pieces: Buffer[] = [];
			for (let offset = 0; ;) {
				check(offset < f.stat.size && offset < cap, code);
				const length = Math.min(HEAD_BYTES, f.stat.size - offset),
					piece = Buffer.allocUnsafe(length);
				this.readInto(f.fd, piece, length, offset);
				const nl = piece.indexOf(0x0a);
				if (nl >= 0) {
					pieces.push(piece.subarray(0, nl + 1));
					break;
				}
				pieces.push(piece);
				offset += length;
			}
			try {
				return new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(pieces));
			} catch {
				return fail(code);
			}
		} finally {
			closeSync(f.fd);
		}
	}
	private names(): string[] {
		const dir = opendirSync(fdPath(this.root)),
			result: string[] = [];
		try {
			for (;;) {
				const e = dir.readSync();
				if (e === null) break;
				check(result.length < this.limits.directoryEntries, "store-capacity");
				result.push(e.name);
			}
		} finally {
			dir.closeSync();
		}
		return result;
	}
}
