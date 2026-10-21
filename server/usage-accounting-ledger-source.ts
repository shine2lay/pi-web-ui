/** Explicit-file, worker-local numeric reader. Inert until called; no discovery, SDK, transcript or runtime importer. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
	factId,
	parseAccountingInput,
	type AccountingInput,
	type IdentityAlias,
	type Tokens,
	type UsageFact,
} from "./usage-accounting-contract.js";
import type { MeterFaultCode, MeterFaultCount } from "./usage-accounting-meter-contract.js";

// Structural W0 types: importing even collector/reader types would violate their exact importer guards.
type Rows = Pick<
	AccountingInput,
	"facts" | "allocations" | "aliases" | "roots" | "policies" | "memberships" | "snapshots"
>;
interface SourceCursor {
	ordinal: number;
	token: string;
}
export interface LedgerSourceBatch {
	v: "usage-source-batch/1";
	stream: string;
	incarnation: string;
	adapterRef: string;
	fromCursor: SourceCursor | null;
	toCursor: SourceCursor;
	from: string;
	through: string;
	observedAt: string;
	status: "partial";
	reason: "reported-gap";
	rows: Rows;
}
export interface LedgerSource {
	stream: string;
	incarnation: string;
	adapterRef: string;
	producer: "pi";
	occurrenceStreams: string[];
	retainedFrom: string;
	grants: (keyof Rows)[];
}
/** Structurally assignable to W0's file MeterNativeCursor. Private, not a charge or coverage watermark. */
export interface LedgerCursor {
	kind: "file";
	stream: string;
	incarnation: string;
	ordinal: number;
	byte: number;
	line: number;
	headerSha256: string;
	anchor: { start: number; bytes: number; sha256: string };
}
export const LEDGER_SOURCE_LIMITS = Object.freeze({
	readBytes: 262_144,
	lineBytes: 16_384,
	batchBytes: 262_144,
	batchRows: 256,
	records: 128, // leaves room for a fact plus an alias per observed response
	spanMs: 169 * 60 * 60 * 1000,
	workMs: 100,
});
export type LedgerFaultCode =
	| "production-unprovable"
	| "skipped-writes-unobservable"
	| "producer-disabled"
	| "producer-state-unknown"
	| "source-unreadable"
	| "source-unsafe"
	| "source-truncated"
	| "source-changed"
	| "cursor-invalid"
	| "cursor-changed"
	| "partial-last-line"
	| "line-limit"
	| "read-limit"
	| "record-limit"
	| "batch-limit"
	| "work-limit"
	| "invalid-json"
	| "invalid-record"
	| "month-mismatch"
	| "window-mismatch"
	| "future-observation"
	| "actual-model-unknown"
	| "response-identity-missing"
	| "aggregate-not-attempt"
	| "legacy-token-presence"
	| "token-total-unknown"
	| "price-missing"
	| "price-unrepresentable"
	| "overlap-unresolved"
	| "index-unavailable"
	| "native-response-conflict"
	| "same-call-unverified"
	| "fileless-helper-membership";
export interface LedgerFault {
	code: LedgerFaultCode;
	line: number;
}
const METER_FAULT: Record<LedgerFaultCode, MeterFaultCode> = {
	"production-unprovable": "source-coverage",
	"skipped-writes-unobservable": "source-coverage",
	"producer-disabled": "source-unavailable",
	"producer-state-unknown": "source-unavailable",
	"source-unreadable": "source-unavailable",
	"source-unsafe": "provenance-mismatch",
	"source-truncated": "truncated-source",
	"source-changed": "provenance-mismatch",
	"cursor-invalid": "cursor-conflict",
	"cursor-changed": "cursor-conflict",
	"partial-last-line": "source-coverage",
	"line-limit": "batch-limit",
	"read-limit": "batch-limit",
	"record-limit": "batch-limit",
	"batch-limit": "batch-limit",
	"work-limit": "time-limit",
	"invalid-json": "invalid-batch",
	"invalid-record": "invalid-batch",
	"month-mismatch": "provenance-mismatch",
	"window-mismatch": "source-coverage",
	"future-observation": "provenance-mismatch",
	"actual-model-unknown": "unpriced",
	"response-identity-missing": "unresolved-identity",
	"aggregate-not-attempt": "unresolved-identity",
	"legacy-token-presence": "source-coverage",
	"token-total-unknown": "source-coverage",
	"price-missing": "unpriced",
	"price-unrepresentable": "unpriced",
	"overlap-unresolved": "unresolved-identity",
	"index-unavailable": "index-unavailable",
	"native-response-conflict": "event-conflict",
	"same-call-unverified": "native-unverified",
	"fileless-helper-membership": "invalid-subject-binding",
};
/** W0/W5 merge seam: one bucket per code in THIS source, not rows or new charges. Caller deduplicates across pages by source. */
export function ledgerMeterFaultCounts(faults: readonly LedgerFault[]): MeterFaultCount[] {
	return [...new Set(faults.map((f) => METER_FAULT[f.code] ?? "unknown-accounting-fault"))]
		.sort()
		.map((code) => ({ code, count: 1 }));
}
/** Direct #305 allowlist only. Fileless helpers remain unsupported by #305; app origin stays unassigned. */
export interface LedgerConversation {
	v: "usage-ledger/1";
	conversationId: string;
	sessionId: string;
	sessionFile: string | null;
	persist: boolean;
	origin: "chat" | "helper" | "app";
	parentConversationId: string | null;
	at: string;
	occurredAt: string;
}
export interface LedgerObservation {
	line: number;
	kind: "assistant" | "cache_warm" | "compaction" | "branch_summary";
	at: string;
	occurredAt: string;
	factId: string | null;
	disposition: "original" | "duplicate" | "alias" | "unresolved" | "aggregate" | "conflict";
	tokens: Tokens & { total: number | null };
	/** Recorded estimate diagnostic, never a reprice or an independently additive charge. */
	recordedPrice: {
		amount: string | null;
		basis: "list-estimate";
		rateVersion: "pi-recorded-1";
		exactTokenQuote: false;
	};
}
/** Persist atomically with its first committed batch. Never write on lookup or before the journal commit. */
export interface LedgerNativeReceipt {
	v: "usage-ledger-native/1";
	key: string;
	numericSha256: string;
	fact: UsageFact;
	alias: IdentityAlias | null;
}
/** An injected reader must verify an approved native [provider,responseId] map, not proximity/amounts or labels. */
export interface LedgerSameCall {
	provider: string;
	responseId: string;
	canonical: UsageFact;
	evidenceRef: string;
}
export interface LedgerEvidenceReaders {
	/** null is a proven absent key in the recovered committed index; missing/throw/undefined is unavailable. */
	first?: (key: string) => unknown;
	/** No default transcript scan. A missing witness leaves persistent overlap unresolved. */
	sameCall?: (provider: string, responseId: string) => unknown;
}
export interface LedgerReadRequest {
	/** Absolute, explicit private usage-ledger directory. No files or parents are discovered. */
	directory: string;
	month: string;
	from: string;
	through: string;
	observedAt: string;
	production: "enabled" | "disabled" | "unknown";
	/** Must be restored from the same proved durable journal/index generation, never a speculative prior result. */
	cursor: LedgerCursor | null;
}
export interface LedgerReadResult {
	v: "usage-ledger-read/1";
	status: "partial";
	source: LedgerSource | null;
	batch: LedgerSourceBatch | null;
	/** Candidate only: caller must durably commit batch AND metadata/fault/index sidecars before saving it. */
	cursor: LedgerCursor | null;
	endOfFile: boolean;
	bytesRead: number;
	observations: LedgerObservation[];
	conversations: LedgerConversation[];
	nativeReceipts: LedgerNativeReceipt[];
	faults: LedgerFault[];
	/** Numeric affected-row counts for optional O0. Never totals, identifiers, examples or raw values. */
	counters: {
		records: number;
		facts: number;
		aliases: number;
		missingResponseIdentity: number;
		unknownActualModel: number;
		aggregateRecords: number;
		legacyTokenPresence: number;
		zeroInput: number;
		zeroOutput: number;
		zeroCacheRead: number;
		zeroCacheWrite: number;
		totalUnknown: number;
		roundedAmounts: number;
	};
}
type RecordValue = Record<string, unknown>;
interface Projection extends LedgerConversation {
	kind: LedgerObservation["kind"];
	provider: string | null;
	model: string | null;
	modelSource: "response" | "requested";
	responseId: string | null;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costTotal: number | null;
}
const REF = /^[A-Za-z0-9_./:@+-]{1,256}$/;
const SHA = /^[a-f0-9]{64}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const ref = (v: unknown): v is string => typeof v === "string" && REF.test(v);
function stamp(v: unknown): v is string {
	return (
		typeof v === "string" &&
		/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
		Number.isFinite(Date.parse(v)) &&
		new Date(v).toISOString() === v
	);
}
function closed(v: unknown, keys: string[]): v is RecordValue {
	if (!v || typeof v !== "object" || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v)))
		return false;
	const descriptors = Object.getOwnPropertyDescriptors(v);
	return (
		Reflect.ownKeys(v).length === keys.length &&
		keys.every((k) => descriptors[k]?.enumerable && "value" in descriptors[k])
	);
}
/** Deliberately never enumerate or stringify the untrusted source record or its extra payload fields. */
function field(v: unknown, k: string): unknown {
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	const d = Object.getOwnPropertyDescriptor(v, k);
	return d && "value" in d ? d.value : undefined;
}
function project(raw: unknown): Projection | null {
	const keys = [
		"v",
		"at",
		"occurredAt",
		"kind",
		"provider",
		"model",
		"modelSource",
		"responseId",
		"stopReason",
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"totalTokens",
		"costTotal",
		"conversationId",
		"sessionId",
		"sessionFile",
		"persist",
		"origin",
		"parentConversationId",
		"app",
	];
	const p: RecordValue = {};
	for (const k of keys) {
		const value = field(raw, k);
		if (value !== undefined && value !== null && !["string", "number", "boolean"].includes(typeof value)) return null;
		p[k] = value;
	}
	if (
		p.v !== "usage-ledger/1" ||
		!stamp(p.at) ||
		!stamp(p.occurredAt) ||
		p.occurredAt > p.at ||
		!["assistant", "cache_warm", "compaction", "branch_summary"].includes(String(p.kind)) ||
		!["response", "requested"].includes(String(p.modelSource)) ||
		!["stop", "length", "toolUse", "error", "aborted", null].includes(p.stopReason as string | null) ||
		!["chat", "helper", "app"].includes(String(p.origin)) ||
		typeof p.persist !== "boolean" ||
		![p.conversationId, p.sessionId].every(ref) ||
		![p.provider, p.model, p.responseId, p.sessionFile, p.parentConversationId].every((v) => v === null || ref(v)) ||
		!TOKEN_KEYS.every((k) => uint(p[k])) ||
		!uint(p.totalTokens) ||
		!(p.costTotal === null || (typeof p.costTotal === "number" && Number.isFinite(p.costTotal) && p.costTotal >= 0)) ||
		(!p.persist && p.sessionFile !== null) ||
		(p.origin === "app" &&
			!["plugin-llm", "decision-model", "decision-bounded-model", "goal-wizard", "goal-reviewer"].includes(
				String(p.app),
			))
	)
		return null;
	// p is a fresh scalar-only allowlist, not a spread/copy of the source object.
	return p as unknown as Projection;
}
function conversation(p: Projection): LedgerConversation {
	return {
		v: p.v,
		conversationId: p.conversationId,
		sessionId: p.sessionId,
		sessionFile: p.sessionFile,
		persist: p.persist,
		origin: p.origin,
		parentConversationId: p.parentConversationId,
		at: p.at,
		occurredAt: p.occurredAt,
	};
}
function rows(): Rows {
	return { facts: [], aliases: [], allocations: [], roots: [], policies: [], memberships: [], snapshots: [] };
}
/** Shortest JS round-trip decimal, explicitly half-even rounded to the contract's twelve fraction digits. */
function recordedUsd(n: number | null): { amount: string | null; rounded: boolean } {
	if (n === null || n === 0) return { amount: null, rounded: false }; // Pi zero never establishes free usage
	const [mantissa, exponent = "0"] = String(n).toLowerCase().split("e");
	const [whole, fraction = ""] = mantissa.split(".");
	const digits = whole + fraction,
		point = whole.length + Number(exponent);
	const expanded =
		point <= 0
			? `0.${"0".repeat(-point)}${digits}`
			: point >= digits.length
				? digits + "0".repeat(point - digits.length)
				: `${digits.slice(0, point)}.${digits.slice(point)}`;
	const [integer, decimals = ""] = expanded.split(".");
	if (integer.length > 18) return { amount: null, rounded: false };
	const discarded = decimals.slice(12);
	let units = BigInt(integer) * 1_000_000_000_000n + BigInt(decimals.slice(0, 12).padEnd(12, "0"));
	if (
		discarded &&
		(discarded[0] > "5" || (discarded[0] === "5" && (/[1-9]/.test(discarded.slice(1)) || units % 2n === 1n)))
	)
		units++;
	const leading = String(units / 1_000_000_000_000n),
		trailing = String(units % 1_000_000_000_000n)
			.padStart(12, "0")
			.replace(/0+$/, "");
	return {
		amount: units > 0n && leading.length <= 18 ? leading + (trailing ? `.${trailing}` : "") : null,
		rounded: /[1-9]/.test(discarded),
	};
}
/** Finite UTC target list only, never readdir/glob. Months partition observation time, not occurrence time. */
export function ledgerUtcMonths(from: string, through: string): string[] {
	if (
		!stamp(from) ||
		!stamp(through) ||
		from > through ||
		Date.parse(through) - Date.parse(from) > LEDGER_SOURCE_LIMITS.spanMs
	)
		throw new Error("ledger-window");
	return from.slice(0, 7) === through.slice(0, 7) ? [from.slice(0, 7)] : [from.slice(0, 7), through.slice(0, 7)];
}
function sourceCursor(c: LedgerCursor): SourceCursor {
	return {
		ordinal: c.ordinal,
		token: `ledger1:${c.byte}:${c.line}:${c.anchor.start}:${c.anchor.bytes}:${c.anchor.sha256}:${c.headerSha256}`,
	};
}
function validCursor(c: unknown): c is LedgerCursor {
	if (
		!closed(c, ["kind", "stream", "incarnation", "ordinal", "byte", "line", "headerSha256", "anchor"]) ||
		c.kind !== "file" ||
		!ref(c.stream) ||
		!ref(c.incarnation) ||
		!uint(c.ordinal) ||
		c.ordinal < 1 ||
		!uint(c.byte) ||
		!uint(c.line) ||
		c.line !== c.ordinal ||
		!SHA.test(String(c.headerSha256)) ||
		!closed(c.anchor, ["start", "bytes", "sha256"])
	)
		return false;
	return (
		uint(c.anchor.start) &&
		uint(c.anchor.bytes) &&
		c.anchor.bytes > 0 &&
		c.anchor.bytes <= LEDGER_SOURCE_LIMITS.lineBytes &&
		c.anchor.start + c.anchor.bytes === c.byte &&
		SHA.test(String(c.anchor.sha256)) &&
		sourceCursor(c as unknown as LedgerCursor).token.length <= 256
	);
}
class Stop extends Error {
	constructor(readonly code: LedgerFaultCode) {
		super(code);
	}
}
interface Line {
	bytes: Buffer;
	start: number;
	end: number;
}
/** All actual read bytes, including header/anchor rechecks and read-ahead, share this request's one budget. */
class Lines {
	private pending = Buffer.alloc(0);
	private readAt: number;
	private at: number;
	constructor(
		private fd: number,
		private size: number,
		start: number,
		private budget: { bytes: number },
	) {
		this.at = this.readAt = start;
	}
	next(): Line | null {
		const pieces: Buffer[] = [];
		let length = 0;
		const start = this.at;
		for (;;) {
			if (!this.pending.length) {
				if (this.readAt === this.size) {
					if (length) throw new Stop("partial-last-line");
					return null;
				}
				const n = Math.min(
					4096,
					LEDGER_SOURCE_LIMITS.lineBytes + 1 - length,
					LEDGER_SOURCE_LIMITS.readBytes - 2 * LEDGER_SOURCE_LIMITS.lineBytes - this.budget.bytes,
					this.size - this.readAt,
				);
				if (n <= 0) throw new Stop(length >= LEDGER_SOURCE_LIMITS.lineBytes ? "line-limit" : "read-limit");
				const b = Buffer.alloc(n),
					got = readSync(this.fd, b, 0, n, this.readAt);
				this.budget.bytes += got;
				if (!got) throw new Stop("source-truncated");
				this.pending = b.subarray(0, got);
				this.readAt += got;
			}
			const newline = this.pending.indexOf(10),
				n = newline < 0 ? this.pending.length : newline + 1;
			if (length + n > LEDGER_SOURCE_LIMITS.lineBytes) throw new Stop("line-limit");
			pieces.push(this.pending.subarray(0, n));
			length += n;
			this.at += n;
			this.pending = this.pending.subarray(n);
			if (newline >= 0) return { bytes: Buffer.concat(pieces, length), start, end: this.at };
		}
	}
}
function readAnchor(fd: number, start: number, length: number, budget: { bytes: number }): Buffer {
	if (budget.bytes + length > LEDGER_SOURCE_LIMITS.readBytes) throw new Stop("read-limit");
	const b = Buffer.alloc(length);
	let got = 0;
	while (got < length) {
		const n = readSync(fd, b, got, length - got, start + got);
		budget.bytes += n;
		if (!n) throw new Stop("source-truncated");
		got += n;
	}
	return b;
}
function validatedFact(v: unknown): UsageFact | null {
	if (
		!closed(v, [
			"v",
			"id",
			"revision",
			"supersedes",
			"identity",
			"identityStatus",
			"occurredAt",
			"provider",
			"model",
			"kind",
			"tokens",
			"prices",
			"source",
			"links",
		]) ||
		!closed(v.identity, ["producer", "incarnation", "attempt"]) ||
		!closed(v.tokens, [...TOKEN_KEYS]) ||
		!closed(v.source, ["stream", "event", "observedAt", "coverage"]) ||
		!closed(v.links, ["task", "session", "run"]) ||
		(v.links.task !== null &&
			!closed(v.links.task, ["queue", "task", "addedAt", "project", "initiative", "effectiveAt"])) ||
		!Array.isArray(v.prices) ||
		v.prices.length > 3 ||
		!v.prices.every((p) => closed(p, ["basis", "currency", "amount", "status", "rateVersion"]))
	)
		return null;
	const parsed = parseAccountingInput({
		v: 1,
		...rows(),
		facts: [v],
		requiredStreams: ["ledger-validation"],
		coverage: [],
	});
	return parsed.ok ? structuredClone(parsed.value.facts[0]) : null;
}
function receipt(raw: unknown, key: string): LedgerNativeReceipt | null {
	if (
		!closed(raw, ["v", "key", "numericSha256", "fact", "alias"]) ||
		raw.v !== "usage-ledger-native/1" ||
		raw.key !== key ||
		!SHA.test(String(raw.numericSha256))
	)
		return null;
	const fact = validatedFact(raw.fact);
	if (
		!fact ||
		fact.identity.producer !== "pi" ||
		fact.revision !== 0 ||
		fact.source.event !== `response:${key}` ||
		fact.links.task !== null ||
		fact.links.run !== null ||
		fact.source.coverage !== "partial"
	)
		return null;
	if (raw.alias !== null && !closed(raw.alias, ["aliasFactId", "canonicalFactId", "provenance", "evidenceRef"]))
		return null;
	const parsed = parseAccountingInput({
		v: 1,
		...rows(),
		facts: [fact],
		aliases: raw.alias === null ? [] : [raw.alias],
		requiredStreams: ["ledger-validation"],
		coverage: [],
	});
	if (!parsed.ok || (raw.alias !== null && parsed.value.aliases[0].aliasFactId !== fact.id)) return null;
	return {
		v: "usage-ledger-native/1",
		key,
		numericSha256: raw.numericSha256 as string,
		fact,
		alias: structuredClone(parsed.value.aliases[0] ?? null),
	};
}
function sameCall(raw: unknown, p: Projection, fact: UsageFact): IdentityAlias | null {
	if (
		!closed(raw, ["provider", "responseId", "canonical", "evidenceRef"]) ||
		raw.provider !== p.provider ||
		raw.responseId !== p.responseId ||
		!ref(raw.evidenceRef)
	)
		return null;
	const canonical = validatedFact(raw.canonical);
	if (
		!canonical ||
		!["pi", "acp"].includes(canonical.identity.producer) ||
		canonical.id === fact.id ||
		canonical.identityStatus !== "verified" ||
		canonical.provider !== fact.provider ||
		canonical.model !== fact.model ||
		canonical.kind !== fact.kind ||
		canonical.occurredAt !== fact.occurredAt
	)
		return null;
	if (
		TOKEN_KEYS.some(
			(k) => canonical.tokens[k] !== null && fact.tokens[k] !== null && canonical.tokens[k] !== fact.tokens[k],
		)
	)
		return null;
	const amount = canonical.prices.find((price) => price.basis === "list-estimate")?.amount ?? null;
	if (amount !== null && fact.prices[0].amount !== null && amount !== fact.prices[0].amount) return null;
	return {
		aliasFactId: fact.id,
		canonicalFactId: canonical.id,
		provenance: "native-call-map/1",
		evidenceRef: raw.evidenceRef,
	};
}

/** One bounded worker-local read. Never mutates reader/index/cursor state and never logs caught input/errors. */
export function readUsageLedger(
	request: LedgerReadRequest,
	readers: LedgerEvidenceReaders = {},
	clock: () => number = () => performance.now(),
): LedgerReadResult {
	if (
		!isAbsolute(request.directory) ||
		resolve(request.directory) !== request.directory ||
		basename(request.directory) !== "usage-ledger" ||
		!MONTH.test(request.month) ||
		![request.from, request.through, request.observedAt].every(stamp) ||
		request.from > request.through ||
		request.through > request.observedAt ||
		Date.parse(request.through) - Date.parse(request.from) > LEDGER_SOURCE_LIMITS.spanMs ||
		!["enabled", "disabled", "unknown"].includes(request.production)
	)
		throw new Error("ledger-request");
	const validSaved = request.cursor === null || validCursor(request.cursor);
	const out: LedgerReadResult = {
		v: "usage-ledger-read/1",
		status: "partial",
		source: null,
		batch: null,
		cursor: validSaved ? structuredClone(request.cursor) : null,
		endOfFile: false,
		bytesRead: 0,
		observations: [],
		conversations: [],
		nativeReceipts: [],
		faults: [
			{ code: "production-unprovable", line: 0 },
			{ code: "skipped-writes-unobservable", line: 0 },
		],
		counters: {
			records: 0,
			facts: 0,
			aliases: 0,
			missingResponseIdentity: 0,
			unknownActualModel: 0,
			aggregateRecords: 0,
			legacyTokenPresence: 0,
			zeroInput: 0,
			zeroOutput: 0,
			zeroCacheRead: 0,
			zeroCacheWrite: 0,
			totalUnknown: 0,
			roundedAmounts: 0,
		},
	};
	const fault = (code: LedgerFaultCode, line: number) => {
		if (!out.faults.some((f) => f.code === code && f.line === line)) out.faults.push({ code, line });
	};
	if (!validSaved) {
		fault("cursor-invalid", 0);
		return out;
	}
	if (request.production !== "enabled") {
		fault(request.production === "disabled" ? "producer-disabled" : "producer-state-unknown", 0);
		return out;
	}
	const started = clock();
	const tick = () => {
		const elapsed = clock() - started;
		if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > LEDGER_SOURCE_LIMITS.workMs) throw new Stop("work-limit");
	};
	let fd: number | null = null,
		dir: number | null = null,
		lineNumber = request.cursor?.line ?? 0;
	const budget = { bytes: 0 },
		native = new Map<string, LedgerNativeReceipt>();
	try {
		tick();
		// Reject symlink components before opening; pin the validated private directory through its Linux fd.
		for (let path = request.directory; ; path = dirname(path)) {
			const s = lstatSync(path);
			if (s.isSymbolicLink() || !s.isDirectory()) throw new Stop("source-unsafe");
			if (dirname(path) === path) break;
		}
		dir = openSync(
			request.directory,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		const ds = fstatSync(dir),
			uid = process.getuid?.();
		if (uid === undefined || ds.uid !== uid || (ds.mode & 0o777) !== 0o700) throw new Stop("source-unsafe");
		fd = openSync(
			`/proc/self/fd/${dir}/${request.month}.jsonl`,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || !uint(stat.size))
			throw new Stop("source-unsafe");
		const stream = `usage-ledger:${hash(join(request.directory, `${request.month}.jsonl`))}`;
		const incarnation = `ledger1:${request.month}:${hash(`${stat.dev}:${stat.ino}`)}`;
		// A byte belongs to its named native stream: another month is not evidence of truncation.
		if (request.cursor && (request.cursor.stream !== stream || request.cursor.incarnation !== incarnation))
			throw new Stop("cursor-changed");
		if (request.cursor && stat.size < request.cursor.byte) throw new Stop("source-truncated");
		let lines = new Lines(fd, stat.size, 0, budget);
		const first = lines.next();
		if (!first) {
			out.endOfFile = true;
			return out;
		}
		const headerSha256 = hash(first.bytes);
		out.source = {
			stream,
			incarnation,
			adapterRef: "usage-ledger-source/1",
			producer: "pi",
			occurrenceStreams: [stream],
			retainedFrom: request.from,
			grants: ["facts", "aliases"],
		};
		let next: Line | null = first;
		if (request.cursor) {
			const c = request.cursor;
			if (c.headerSha256 !== headerSha256) throw new Stop("cursor-changed");
			const anchor = readAnchor(fd, c.anchor.start, c.anchor.bytes, budget);
			if (anchor.at(-1) !== 10 || hash(anchor) !== c.anchor.sha256) throw new Stop("cursor-changed");
			lines = new Lines(fd, stat.size, c.byte, budget);
			next = lines.next();
		}
		const batch: LedgerSourceBatch = {
			v: "usage-source-batch/1",
			stream,
			incarnation,
			adapterRef: "usage-ledger-source/1",
			fromCursor: request.cursor ? sourceCursor(request.cursor) : null,
			toCursor: { ordinal: 0, token: "uncommitted" },
			from: request.from,
			through: request.through,
			observedAt: request.observedAt,
			status: "partial",
			reason: "reported-gap",
			rows: rows(),
		};
		try {
			while (next) {
				tick();
				if (out.counters.records >= LEDGER_SOURCE_LIMITS.records) {
					fault("record-limit", lineNumber + 1);
					break;
				}
				const n = lineNumber + 1,
					localFaults: LedgerFaultCode[] = [];
				let p: Projection | null = null;
				try {
					p = project(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(next.bytes)));
					if (!p) localFaults.push("invalid-record");
				} catch {
					localFaults.push("invalid-json");
				}
				if (p && p.at.slice(0, 7) !== request.month) {
					fault("month-mismatch", n);
					break;
				}
				if (p && p.at > request.observedAt) {
					fault("future-observation", n);
					break;
				}
				if (p && (p.occurredAt < request.from || p.occurredAt > request.through)) {
					fault("window-mismatch", n);
					break;
				}
				let proposed: LedgerNativeReceipt | null = null,
					fact: UsageFact | null = null,
					alias: IdentityAlias | null = null;
				let observation: LedgerObservation | null = null;
				if (p) {
					const tokens = Object.fromEntries(TOKEN_KEYS.map((k) => [k, p[k] > 0 ? p[k] : null])) as unknown as Tokens;
					const total =
						TOKEN_KEYS.every((k) => tokens[k] !== null) &&
						p.totalTokens === p.input + p.output + p.cacheRead + p.cacheWrite
							? p.totalTokens
							: null;
					const price = recordedUsd(p.costTotal),
						actual =
							p.modelSource === "response" &&
							p.provider !== null &&
							p.provider !== "unknown" &&
							p.model !== null &&
							p.model !== "unknown";
					if (!actual) localFaults.push("actual-model-unknown");
					if (!p.responseId || !p.provider) localFaults.push("response-identity-missing");
					if (TOKEN_KEYS.some((k) => tokens[k] === null)) localFaults.push("legacy-token-presence");
					if (total === null) localFaults.push("token-total-unknown");
					if (price.amount === null)
						localFaults.push(p.costTotal === null || p.costTotal === 0 ? "price-missing" : "price-unrepresentable");
					if (p.origin === "helper" && p.sessionFile === null) localFaults.push("fileless-helper-membership");
					observation = {
						line: n,
						kind: p.kind,
						at: p.at,
						occurredAt: p.occurredAt,
						factId: null,
						disposition: "unresolved",
						tokens: { ...tokens, total },
						recordedPrice: {
							amount: price.amount,
							basis: "list-estimate",
							rateVersion: "pi-recorded-1",
							exactTokenQuote: false,
						},
					};
					if (p.kind !== "assistant") {
						observation.disposition = "aggregate";
						localFaults.push("aggregate-not-attempt");
					} else if (p.responseId && p.provider) {
						const key = hash(JSON.stringify([p.provider, p.responseId]));
						let firstReceipt: LedgerNativeReceipt | null;
						try {
							const raw = native.get(key) ?? readers.first?.(key);
							firstReceipt = raw === null ? null : receipt(raw, key);
							if (raw !== null && firstReceipt === null) throw new Stop("index-unavailable");
						} catch {
							fault("index-unavailable", n);
							break;
						}
						const numericSha256 = hash(
							JSON.stringify([
								p.occurredAt,
								p.kind,
								p.provider,
								p.model,
								p.modelSource,
								tokens,
								p.totalTokens,
								p.costTotal,
							]),
						);
						const identity = {
							producer: "pi" as const,
							incarnation: `ledger-response:${hash(p.provider)}`,
							attempt: `response:${hash(p.responseId)}`,
						};
						if (firstReceipt) {
							if (
								firstReceipt.fact.id !== factId(identity) ||
								firstReceipt.fact.source.observedAt > p.at ||
								firstReceipt.numericSha256 !== numericSha256
							) {
								observation.disposition = "conflict";
								localFaults.push("native-response-conflict");
							} else {
								alias = firstReceipt.alias;
								if (!alias && actual && readers.sameCall) {
									try {
										const witness = readers.sameCall(p.provider, p.responseId);
										if (witness !== null) {
											alias = sameCall(witness, p, firstReceipt.fact);
											if (alias) proposed = { ...firstReceipt, alias };
											else localFaults.push("same-call-unverified");
										}
									} catch {
										localFaults.push("same-call-unverified");
									}
								}
								observation.factId = firstReceipt.fact.id;
								observation.disposition = alias ? "alias" : "duplicate";
							}
						} else {
							fact = {
								v: "usage-fact/1",
								id: factId(identity),
								revision: 0,
								supersedes: null,
								identity,
								identityStatus: "unresolved",
								occurredAt: p.occurredAt,
								provider: actual ? p.provider : "unknown",
								model: actual ? p.model! : "unknown",
								kind: "assistant",
								tokens,
								prices: [
									{
										basis: "list-estimate",
										currency: "USD",
										amount: actual ? price.amount : null,
										status: !actual ? "unknown-model" : price.amount !== null ? "known" : "unpriced",
										rateVersion: actual && price.amount !== null ? "pi-recorded-1" : null,
									},
								],
								source: { stream, event: `response:${key}`, observedAt: p.at, coverage: "partial" },
								links: { task: null, session: p.sessionId, run: null },
							};
							if (actual && readers.sameCall) {
								try {
									const witness = readers.sameCall(p.provider, p.responseId);
									if (witness !== null) {
										alias = sameCall(witness, p, fact);
										if (!alias) localFaults.push("same-call-unverified");
									}
								} catch {
									localFaults.push("same-call-unverified");
								}
							}
							if (
								actual &&
								(alias || (!p.persist && p.sessionFile === null && !localFaults.includes("same-call-unverified")))
							)
								fact.identityStatus = "verified";
							if (fact.identityStatus === "unresolved") localFaults.push("overlap-unresolved");
							observation.factId = fact.id;
							observation.disposition = alias
								? "alias"
								: fact.identityStatus === "verified"
									? "original"
									: "unresolved";
							proposed = { v: "usage-ledger-native/1", key, numericSha256, fact, alias };
						}
					}
				}
				const candidate = {
					...batch,
					rows: {
						...batch.rows,
						facts: fact ? [...batch.rows.facts, fact] : batch.rows.facts,
						aliases: alias ? [...batch.rows.aliases, alias] : batch.rows.aliases,
					},
				};
				const cursor: LedgerCursor = {
					kind: "file",
					stream,
					incarnation,
					ordinal: n,
					byte: next.end,
					line: n,
					headerSha256,
					anchor: { start: next.start, bytes: next.bytes.length, sha256: hash(next.bytes) },
				};
				candidate.toCursor = sourceCursor(cursor);
				if (
					candidate.rows.facts.length + candidate.rows.aliases.length > LEDGER_SOURCE_LIMITS.batchRows ||
					Buffer.byteLength(JSON.stringify(candidate)) > LEDGER_SOURCE_LIMITS.batchBytes
				) {
					fault("batch-limit", n);
					break;
				}
				batch.rows = candidate.rows;
				batch.toCursor = candidate.toCursor;
				out.cursor = cursor;
				lineNumber = n;
				for (const code of localFaults) fault(code, n);
				out.counters.records++;
				if (p && observation) {
					out.observations.push(observation);
					out.conversations.push(conversation(p));
					const c = out.counters;
					if (localFaults.includes("actual-model-unknown")) c.unknownActualModel++;
					if (localFaults.includes("response-identity-missing")) c.missingResponseIdentity++;
					if (p.kind !== "assistant") c.aggregateRecords++;
					if (localFaults.includes("legacy-token-presence")) c.legacyTokenPresence++;
					if (observation.tokens.total === null) c.totalUnknown++;
					if (recordedUsd(p.costTotal).rounded) c.roundedAmounts++;
					if (p.input === 0) c.zeroInput++;
					if (p.output === 0) c.zeroOutput++;
					if (p.cacheRead === 0) c.zeroCacheRead++;
					if (p.cacheWrite === 0) c.zeroCacheWrite++;
				}
				if (proposed) {
					native.set(proposed.key, proposed);
					out.nativeReceipts.push(proposed);
				}
				out.batch = batch;
				next = lines.next();
			}
			if (next === null) out.endOfFile = true;
		} catch (error) {
			if (
				!(error instanceof Stop) ||
				!["partial-last-line", "line-limit", "read-limit", "work-limit"].includes(error.code)
			)
				throw error;
			fault(error.code, lineNumber + 1);
		}
		const after = fstatSync(fd),
			dsAfter = lstatSync(request.directory),
			pathAfter = lstatSync(`/proc/self/fd/${dir}/${request.month}.jsonl`);
		if (after.size < stat.size) throw new Stop("source-truncated");
		if (
			!after.isFile() ||
			after.nlink !== 1 ||
			after.dev !== stat.dev ||
			after.ino !== stat.ino ||
			(after.mode & 0o777) !== 0o600 ||
			after.uid !== uid ||
			pathAfter.isSymbolicLink() ||
			pathAfter.dev !== stat.dev ||
			pathAfter.ino !== stat.ino ||
			dsAfter.isSymbolicLink() ||
			dsAfter.ino !== ds.ino ||
			dsAfter.dev !== ds.dev ||
			dsAfter.uid !== uid ||
			(dsAfter.mode & 0o777) !== 0o700
		)
			throw new Stop("source-changed");
		// Recheck both complete-line anchors, even after a bounded/torn prefix stop.
		if (out.batch && out.cursor) {
			const anchor = out.cursor.anchor,
				checked = readAnchor(fd, anchor.start, anchor.bytes, budget);
			if (hash(checked) !== anchor.sha256 || hash(readAnchor(fd, 0, first.bytes.length, budget)) !== headerSha256)
				throw new Stop("cursor-changed");
		}
	} catch (error) {
		const code = error instanceof Stop ? error.code : "source-unreadable";
		fault(code, lineNumber + 1);
		// Native I/O/cursor failures discard every proposal. Bounded prefix stops are checked inside the loop.
		out.batch = null;
		out.cursor = request.cursor ? structuredClone(request.cursor) : null;
		out.observations = [];
		out.conversations = [];
		out.nativeReceipts = [];
		for (const key of Object.keys(out.counters) as (keyof LedgerReadResult["counters"])[]) out.counters[key] = 0;
		out.endOfFile = false;
	} finally {
		out.bytesRead = budget.bytes;
		for (const handle of [fd, dir])
			if (handle !== null) {
				try {
					closeSync(handle);
				} catch {
					fault("source-unreadable", 0);
				}
			}
	}
	out.counters.facts = out.batch?.rows.facts.length ?? 0;
	out.counters.aliases = out.batch?.rows.aliases.length ?? 0;
	return out;
}
