/** Inert, explicit-file Pi JSONL adapter. No discovery, production importer, model call or budget authority. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { factId, type AccountingInput, type Tokens, type UsageFact } from "./usage-accounting-contract.js";

// Closed structural wire types, not a collector dependency. Tests check assignability against #300.
type NumericRows = Pick<
	AccountingInput,
	"facts" | "allocations" | "aliases" | "roots" | "policies" | "memberships" | "snapshots"
>;
interface SourceCursor {
	ordinal: number;
	token: string;
}
interface CollectorSource {
	stream: string;
	incarnation: string;
	adapterRef: string;
	producer: "pi" | "acp";
	occurrenceStreams: string[];
	retainedFrom: string;
	grants: (keyof NumericRows)[];
}
interface SourceBatch {
	v: "usage-source-batch/1";
	stream: string;
	incarnation: string;
	adapterRef: string;
	fromCursor: SourceCursor | null;
	toCursor: SourceCursor;
	from: string;
	through: string;
	observedAt: string;
	status: "complete" | "partial";
	reason: "none" | "reported-gap";
	rows: NumericRows;
}
// Mirror #300's frozen bounds without importing/loading the inert collector. Unit checks prevent drift.
export const PI_SESSION_LIMITS = Object.freeze({
	lineBytes: 65_536,
	readBytes: 262_144,
	batchBytes: 262_144,
	batchRows: 256,
	indexEntries: 10_000,
	sources: 64,
	spanMs: 169 * 60 * 60 * 1000,
});
// Pi's recorded call-time estimate, not an identified historical model-table revision.
export const PI_RECORDED_RATE_VERSION = "pi-recorded-1";
type Limits = { [K in keyof typeof PI_SESSION_LIMITS]: number };
export type PiSessionFaultCode =
	| "source-unreadable"
	| "source-truncated"
	| "header-invalid"
	| "cursor-invalid"
	| "cursor-changed"
	| "partial-last-line"
	| "line-limit"
	| "read-limit"
	| "batch-limit"
	| "index-limit"
	| "invalid-json"
	| "invalid-record"
	| "window-mismatch"
	| "tokens-invalid"
	| "model-unverified"
	| "price-missing"
	| "price-invalid"
	| "identity-unverified";
export interface PiSessionFault {
	code: PiSessionFaultCode;
	line: number;
}
export interface PiSessionObservation {
	line: number;
	entryId: string | null;
	entryTimestamp: string | null;
	responseId: string | null;
	factId: string | null;
	canonicalFactId: string | null;
	disposition: "original" | "alias" | "unverified";
	/** Recorded list estimate; duplicate observations and unknown models must not be added to fact totals. */
	recordedPrice: { basis: "list-estimate"; amount: string | null; rateVersion: null };
}
export interface PiSessionReadRequest {
	/** Explicit path only. Neither parentSession nor a delegate report is opened automatically. */
	file: string;
	producer: "pi" | "acp";
	from: string;
	through: string;
	observedAt: string;
	cursor?: SourceCursor | null;
}
export interface PiSessionReadResult {
	v: "pi-session-read/1";
	status: "complete" | "partial";
	source: CollectorSource | null;
	batch: SourceBatch | null;
	/** Last complete line only; commit it only after the collector commits the corresponding batch. */
	cursor: SourceCursor | null;
	endOfFile: boolean;
	observations: PiSessionObservation[];
	/** Number of observed recorded totals changed by half-even rounding to 12 fraction digits. */
	roundedAmounts: number;
	faults: PiSessionFault[];
}
type ObjectValue = Record<string, unknown>;
interface Header {
	id: string;
	timestamp: string;
	parent: string | null;
	hash: string;
}
interface Projection {
	entryId: string | null;
	entryTimestamp: string;
	responseId: string | null;
	occurredAt: string;
	provider: string;
	model: string;
	kind: UsageFact["kind"];
	tokens: Tokens;
	amount: string | null;
	recordedTotal: number | null;
	rounded: boolean;
	priced: boolean;
	invalidIdentity: boolean;
	faults: PiSessionFaultCode[];
}
interface Evidence {
	projection: Projection;
	fact: UsageFact;
	canonical: UsageFact;
}
interface FileIndex {
	header: Header;
	producer: "pi" | "acp";
	retainedFrom: string;
	entries: Map<string, Evidence>;
	complete: boolean;
	gap: boolean;
}
const REF = /^[A-Za-z0-9_./:@+-]{1,256}$/;
const SHA = /^[a-f0-9]{64}$/;
function hash(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}
function object(raw: unknown): ObjectValue | null {
	return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as ObjectValue) : null;
}
function reference(raw: unknown): raw is string {
	return typeof raw === "string" && REF.test(raw);
}
function timestamp(raw: unknown): raw is string {
	return (
		typeof raw === "string" &&
		/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(raw) &&
		Number.isFinite(Date.parse(raw)) &&
		new Date(raw).toISOString() === raw
	);
}
function occurrence(raw: unknown): string | null {
	if (timestamp(raw)) return raw;
	if (typeof raw !== "number" || !Number.isSafeInteger(raw) || Math.abs(raw) > 8_640_000_000_000_000) return null;
	const value = new Date(raw).toISOString();
	return timestamp(value) ? value : null;
}
/** Expand JS's shortest round-trip representation, then explicitly half-even round recorded totals. */
function usd(raw: unknown): { amount: string; rounded: boolean } | null {
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
	const [mantissa, power = "0"] = String(raw).toLowerCase().split("e");
	const [integer, fraction = ""] = mantissa.split(".");
	const digits = integer + fraction;
	const point = integer.length + Number(power);
	const expanded =
		point <= 0
			? `0.${"0".repeat(-point)}${digits}`
			: point >= digits.length
				? digits + "0".repeat(point - digits.length)
				: `${digits.slice(0, point)}.${digits.slice(point)}`;
	const [whole, decimals = ""] = expanded.split(".");
	if (whole.length > 18) return null;
	const discarded = decimals.slice(12);
	let units = BigInt(whole) * 1_000_000_000_000n + BigInt(decimals.slice(0, 12).padEnd(12, "0"));
	if (
		discarded &&
		(discarded[0] > "5" || (discarded[0] === "5" && (/[1-9]/.test(discarded.slice(1)) || units % 2n === 1n)))
	)
		units++;
	const normalizedWhole = String(units / 1_000_000_000_000n);
	if (normalizedWhole.length > 18) return null;
	const normalizedFraction = String(units % 1_000_000_000_000n)
		.padStart(12, "0")
		.replace(/0+$/, "");
	return {
		amount: normalizedWhole + (normalizedFraction ? `.${normalizedFraction}` : ""),
		rounded: /[1-9]/.test(discarded),
	};
}
function emptyRows(): NumericRows {
	return { facts: [], allocations: [], aliases: [], roots: [], policies: [], memberships: [], snapshots: [] };
}
interface Line {
	kind: "line";
	bytes: Buffer;
	start: number;
	end: number;
}
type LineResult = Line | { kind: "end" | "partial-last-line" | "line-limit" | "read-limit" | "source-truncated" };
/** Bounded byte reader: no readFile, readline's unbounded lines, content-bearing errors or content output. */
class Lines {
	private pending = Buffer.alloc(0);
	private readAt: number;
	private at: number;
	scanned = 0;
	constructor(
		private readonly file: FileHandle,
		private readonly size: number,
		start: number,
		private readonly budget: number,
		private readonly lineBytes: number,
	) {
		this.at = this.readAt = start;
	}
	async next(): Promise<LineResult> {
		const start = this.at;
		const pieces: Buffer[] = [];
		let length = 0;
		for (;;) {
			if (this.pending.length === 0) {
				if (this.readAt === this.size) return { kind: length ? "partial-last-line" : "end" };
				if (this.scanned >= this.budget) return { kind: "read-limit" };
				const n = Math.min(4096, this.lineBytes + 1 - length, this.budget - this.scanned, this.size - this.readAt);
				if (n <= 0) return { kind: "line-limit" };
				const buffer = Buffer.alloc(n);
				const { bytesRead } = await this.file.read(buffer, 0, n, this.readAt);
				if (!bytesRead) return { kind: "source-truncated" };
				this.pending = buffer.subarray(0, bytesRead);
				this.readAt += bytesRead;
				this.scanned += bytesRead;
			}
			const newline = this.pending.indexOf(10);
			const n = newline < 0 ? this.pending.length : newline + 1;
			if (length + n > this.lineBytes) return { kind: "line-limit" };
			pieces.push(this.pending.subarray(0, n));
			length += n;
			this.pending = this.pending.subarray(n);
			this.at += n;
			if (newline >= 0) return { kind: "line", start, end: this.at, bytes: Buffer.concat(pieces, length) };
		}
	}
}
function parseLine(line: Line): ObjectValue | null {
	try {
		return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line.bytes)));
	} catch {
		return null;
	}
}
function cursorFor(line: Line, ordinal: number, header: Header): SourceCursor {
	return { ordinal, token: `pi1:${line.end}:${line.start}:${line.bytes.length}:${hash(line.bytes)}:${header.hash}` };
}
function decodeCursor(
	cursor: SourceCursor,
): { offset: number; start: number; bytes: number; sha: string; header: string } | null {
	if (!Number.isSafeInteger(cursor.ordinal) || cursor.ordinal < 1 || typeof cursor.token !== "string") return null;
	const parts = cursor.token.split(":");
	if (parts.length !== 6 || parts[0] !== "pi1" || !SHA.test(parts[4]) || !SHA.test(parts[5])) return null;
	if (!parts.slice(1, 4).every((n) => /^(0|[1-9]\d{0,15})$/.test(n))) return null;
	const [offset, start, bytes] = parts.slice(1, 4).map(Number);
	if (![offset, start, bytes].every(Number.isSafeInteger) || bytes < 1 || start + bytes !== offset) return null;
	return { offset, start, bytes, sha: parts[4], header: parts[5] };
}
function projection(entry: ObjectValue): Projection | "invalid" | null {
	let value: ObjectValue | null;
	let kind: UsageFact["kind"];
	if (entry.type === "message") {
		value = object(entry.message);
		if (value?.role !== "assistant") return null; // In particular, never inspect tool-result usage/details.
		kind = "assistant";
	} else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
		value = entry;
		kind = entry.type === "usage" ? (entry.kind === "cache_warm" ? "cache-warm" : "assistant") : "compaction";
	} else return null;
	if (value.usage === undefined) return null;
	const usage = object(value.usage);
	const occurredAt =
		entry.type === "message" && value.timestamp !== undefined
			? occurrence(value.timestamp)
			: occurrence(entry.timestamp);
	if (!usage || !timestamp(entry.timestamp) || !occurredAt) return "invalid";
	const faults: PiSessionFaultCode[] = [];
	const tokens = Object.fromEntries(
		(["input", "output", "cacheRead", "cacheWrite"] as const).map((key) => {
			const n = usage[key];
			return [key, typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null];
		}),
	) as unknown as Tokens;
	if (Object.values(tokens).some((n) => n === null)) faults.push("tokens-invalid");
	const provider = reference(value.provider) ? value.provider : "unknown";
	const model = reference(value.model) ? value.model : "unknown";
	if (provider === "unknown" || model === "unknown") faults.push("model-unverified");
	const rawTotal = object(usage.cost)?.total;
	const price = usd(rawTotal);
	const knownZeroTokens =
		Object.values(tokens).every((n) => n === 0) && (usage.totalTokens === undefined || usage.totalTokens === 0);
	const priced = price !== null && (rawTotal !== 0 || knownZeroTokens);
	if (!priced)
		faults.push(rawTotal === undefined || rawTotal === null || rawTotal === 0 ? "price-missing" : "price-invalid");
	return {
		entryId: reference(entry.id) ? entry.id : null,
		entryTimestamp: entry.timestamp,
		responseId: reference(value.responseId) ? value.responseId : null,
		occurredAt,
		provider,
		model,
		kind,
		tokens,
		amount: price?.amount ?? null,
		recordedTotal: typeof rawTotal === "number" && Number.isFinite(rawTotal) && rawTotal >= 0 ? rawTotal : null,
		rounded: price?.rounded ?? false,
		priced,
		invalidIdentity: value.responseId !== undefined && !reference(value.responseId),
		faults,
	};
}
function concordant(a: Projection, b: Projection): boolean {
	return (
		a.occurredAt === b.occurredAt &&
		a.provider === b.provider &&
		a.model === b.model &&
		a.kind === b.kind &&
		JSON.stringify(a.tokens) === JSON.stringify(b.tokens) &&
		a.amount === b.amount &&
		a.recordedTotal === b.recordedTotal
	);
}

/** Caller-owned, bounded numeric identity index. Read parents before children; replay originals after a restart.
 * One read at a time per instance. No filesystem paths, content or exception messages escape in results. */
export class PiSessionUsageReader {
	private readonly limits: Limits;
	private files = new Map<string, FileIndex>();
	private responses = new Map<string, Evidence>();
	private originals = new Map<string, Evidence>();
	private entries = 0;
	private busy = false;
	constructor(limits: Partial<Limits> = {}) {
		this.limits = { ...PI_SESSION_LIMITS, ...limits };
		if (this.limits.batchBytes < 4096) throw new Error("pi-session-limits");
		for (const key of Object.keys(PI_SESSION_LIMITS) as (keyof Limits)[]) {
			if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1 || this.limits[key] > PI_SESSION_LIMITS[key])
				throw new Error("pi-session-limits");
		}
	}
	async read(request: PiSessionReadRequest): Promise<PiSessionReadResult> {
		if (
			this.busy ||
			typeof request.file !== "string" ||
			!request.file ||
			!["pi", "acp"].includes(request.producer) ||
			![request.from, request.through, request.observedAt].every(timestamp) ||
			request.from > request.through ||
			request.through > request.observedAt ||
			Date.parse(request.through) - Date.parse(request.from) > this.limits.spanMs
		)
			throw new Error("pi-session-request");
		this.busy = true;
		const previous = { files: this.files, responses: this.responses, originals: this.originals, entries: this.entries };
		// Transactional numeric index: an I/O failure must not create aliases to an unreturned batch.
		this.files = new Map(this.files);
		this.responses = new Map(this.responses);
		this.originals = new Map(this.originals);
		try {
			const result = await this.readFile(request);
			if (!result.batch && result.faults.some((f) => f.code === "source-unreadable")) {
				this.files = previous.files;
				this.responses = previous.responses;
				this.originals = previous.originals;
				this.entries = previous.entries;
				const old = this.files.get(resolve(request.file));
				if (old) old.complete = false;
			}
			return structuredClone(result);
		} finally {
			this.busy = false;
		}
	}
	private async readFile(request: PiSessionReadRequest): Promise<PiSessionReadResult> {
		const path = resolve(request.file);
		const stream = `pi-session:${hash(path)}`;
		const result: PiSessionReadResult = {
			v: "pi-session-read/1",
			status: "partial",
			source: null,
			batch: null,
			cursor:
				request.cursor && decodeCursor(request.cursor)
					? { ordinal: request.cursor.ordinal, token: request.cursor.token }
					: null,
			endOfFile: false,
			observations: [],
			roundedAmounts: 0,
			faults: [],
		};
		const fault = (code: PiSessionFaultCode, line: number) => result.faults.push({ code, line });
		let file: FileHandle | null = null;
		try {
			file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			const stat = await file.stat();
			if (!stat.isFile() || !Number.isSafeInteger(stat.size)) {
				fault("source-unreadable", 0);
				return result;
			}
			let lines = new Lines(file, stat.size, 0, this.limits.readBytes, this.limits.lineBytes);
			const first = await lines.next();
			if (first.kind !== "line") {
				fault(first.kind === "end" ? "header-invalid" : first.kind, 1);
				return result;
			}
			const raw = parseLine(first);
			if (
				raw?.type !== "session" ||
				raw.version !== 3 ||
				!reference(raw.id) ||
				!timestamp(raw.timestamp) ||
				raw.timestamp > request.observedAt ||
				(raw.parentSession !== undefined && (typeof raw.parentSession !== "string" || !raw.parentSession))
			) {
				fault("header-invalid", 1);
				return result;
			}
			const header: Header = {
				id: raw.id,
				timestamp: raw.timestamp,
				parent: typeof raw.parentSession === "string" ? resolve(dirname(path), raw.parentSession) : null,
				hash: hash(first.bytes),
			};
			const existing = this.files.get(path);
			if (existing && (existing.header.hash !== header.hash || existing.producer !== request.producer)) {
				fault("cursor-changed", 1);
				return result;
			}
			if (!existing && this.files.size >= this.limits.sources) {
				fault("index-limit", 1);
				return result;
			}
			const index: FileIndex = existing
				? { ...existing, entries: new Map(existing.entries), complete: false }
				: {
						header,
						producer: request.producer,
						retainedFrom: request.from,
						entries: new Map<string, Evidence>(),
						complete: false,
						gap: false,
					};
			this.files.set(path, index);
			const source: CollectorSource = {
				stream,
				incarnation: header.id,
				adapterRef: "pi-session-jsonl/1",
				producer: request.producer,
				occurrenceStreams: [stream],
				retainedFrom: index.retainedFrom, // First requested window; stable across later windows, not the fork's creation.
				grants: ["facts", "aliases"],
			};
			result.source = source;
			let current = cursorFor(first, 1, header);
			if (request.cursor) {
				const saved = decodeCursor(request.cursor);
				if (!saved || saved.bytes > this.limits.lineBytes || saved.offset < first.end || saved.header !== header.hash) {
					fault("cursor-invalid", request.cursor.ordinal);
					return result;
				}
				if (stat.size < saved.offset) {
					fault("source-truncated", request.cursor.ordinal);
					return result;
				}
				if (lines.scanned + saved.bytes > this.limits.readBytes) {
					fault("read-limit", request.cursor.ordinal);
					return result;
				}
				const tail = Buffer.alloc(saved.bytes);
				const checked = await file.read(tail, 0, tail.length, saved.start);
				if (checked.bytesRead !== tail.length || tail.at(-1) !== 10 || hash(tail) !== saved.sha) {
					fault("cursor-changed", request.cursor.ordinal);
					return result;
				}
				lines = new Lines(
					file,
					stat.size,
					saved.offset,
					this.limits.readBytes - lines.scanned - tail.length,
					this.limits.lineBytes,
				);
				current = { ordinal: request.cursor.ordinal, token: request.cursor.token };
			}
			const batch: SourceBatch = {
				v: "usage-source-batch/1",
				stream,
				incarnation: header.id,
				adapterRef: source.adapterRef!,
				fromCursor: request.cursor ? { ordinal: request.cursor.ordinal, token: request.cursor.token } : null,
				toCursor: current,
				from: request.from,
				through: request.through,
				observedAt: request.observedAt,
				status: "partial",
				reason: "reported-gap",
				rows: emptyRows(),
			};
			let gap = index.gap;
			for (;;) {
				const lineNumber = current.ordinal + 1;
				if (result.faults.length >= Math.min(PI_SESSION_LIMITS.batchRows, Math.floor(this.limits.batchBytes / 256))) {
					fault("batch-limit", lineNumber);
					break;
				}
				const line = await lines.next();
				if (line.kind !== "line") {
					if (line.kind === "end") result.endOfFile = true;
					else fault(line.kind, lineNumber);
					break;
				}
				const entry = parseLine(line);
				const projected = entry ? projection(entry) : "invalid";
				if (projected === "invalid") {
					fault(entry ? "invalid-record" : "invalid-json", lineNumber);
					gap = true;
				} else if (projected) {
					if (projected.occurredAt < request.from || projected.occurredAt > request.through) {
						fault("window-mismatch", lineNumber);
						break; // Leave this complete line unread for an appropriate occurrence window.
					}
					const key = JSON.stringify([projected.entryId, projected.entryTimestamp]);
					if (!index.entries.has(key) && this.entries >= this.limits.indexEntries) {
						fault("index-limit", lineNumber);
						break;
					}
					const candidate = this.identify(projected, index, stream, request.producer, request.observedAt);
					const rows = candidate.evidence ? [candidate.evidence.fact] : [];
					// A same-id resume observation must not rewrite the original source stamps.
					const addedFacts = rows.filter((f) => f.source.stream === stream);
					const addedAliases =
						candidate.evidence && candidate.evidence.fact.id !== candidate.evidence.canonical.id
							? [
									{
										aliasFactId: candidate.evidence.fact.id,
										canonicalFactId: candidate.evidence.canonical.id,
										provenance: "native-call-map/1" as const,
										evidenceRef: `pi-session-map:${hash(JSON.stringify([projected.responseId, projected.entryId, projected.entryTimestamp]))}`,
									},
								]
							: [];
					const next: SourceBatch = {
						...batch,
						toCursor: cursorFor(line, lineNumber, header),
						rows: {
							...batch.rows,
							facts: [...batch.rows.facts, ...addedFacts],
							aliases: [...batch.rows.aliases, ...addedAliases],
						},
					};
					const size = Buffer.byteLength(JSON.stringify(next));
					// Leave room for the closed observation/fault envelope as well as the collector batch.
					const observation: PiSessionObservation = {
						line: lineNumber,
						entryId: projected.entryId,
						entryTimestamp: projected.entryTimestamp,
						responseId: projected.responseId,
						factId: candidate.evidence?.fact.id ?? null,
						canonicalFactId: candidate.evidence?.canonical.id ?? null,
						disposition: candidate.unverified ? "unverified" : candidate.aliased ? "alias" : "original",
						recordedPrice: {
							basis: "list-estimate",
							amount: projected.priced ? projected.amount : null,
							rateVersion: null,
						},
					};
					const codes = [...projected.faults, ...(candidate.unverified ? ["identity-unverified" as const] : [])];
					const envelope = {
						...result,
						batch: next,
						cursor: next.toCursor,
						observations: [...result.observations, observation],
						roundedAmounts: result.roundedAmounts + Number(projected.rounded),
						faults: [...result.faults, ...codes.map((code) => ({ code, line: lineNumber }))],
					};
					if (
						next.rows.facts.length + next.rows.aliases.length > this.limits.batchRows ||
						size > this.limits.batchBytes ||
						Buffer.byteLength(JSON.stringify(envelope)) + 256 > this.limits.batchBytes
					) {
						fault("batch-limit", lineNumber);
						break;
					}
					batch.rows = next.rows;
					result.observations.push(observation);
					result.roundedAmounts = envelope.roundedAmounts;
					for (const code of codes) fault(code, lineNumber);
					if (candidate.evidence && !index.entries.has(key)) {
						index.entries.set(key, candidate.evidence);
						this.entries++;
						if (!candidate.unverified) {
							if (projected.responseId)
								this.responses.set(JSON.stringify([projected.provider, projected.responseId]), candidate.evidence);
							else
								this.originals.set(
									JSON.stringify([request.producer, header.id, projected.entryId]),
									candidate.evidence,
								);
						}
					}
				}
				current = cursorFor(line, lineNumber, header);
				batch.toCursor = current;
			}
			index.gap = gap;
			index.complete = result.endOfFile && !gap;
			result.status = index.complete ? "complete" : "partial";
			result.cursor = current;
			batch.status = result.status;
			batch.reason = result.status === "complete" ? "none" : "reported-gap";
			// No fake cursor movement just to report an unavailable/torn/truncated source.
			if (current.ordinal > (request.cursor?.ordinal ?? 0)) result.batch = batch;
			return result;
		} catch {
			fault("source-unreadable", 0); // Never expose OS paths, error text, parsed input or content.
			return result;
		} finally {
			await file?.close().catch(() => undefined);
		}
	}
	private identify(
		p: Projection,
		index: FileIndex,
		stream: string,
		producer: "pi" | "acp",
		observedAt: string,
	): { evidence: Evidence | null; unverified: boolean; aliased: boolean } {
		if (!p.entryId || p.invalidIdentity || (p.responseId && p.provider === "unknown"))
			return { evidence: null, unverified: true, aliased: false };
		const key = JSON.stringify([p.entryId, p.entryTimestamp]);
		const old = index.entries.get(key);
		const parent = index.header.parent ? this.files.get(index.header.parent) : null;
		const response = p.responseId ? this.responses.get(JSON.stringify([p.provider, p.responseId])) : null;
		const original = this.originals.get(JSON.stringify([producer, index.header.id, p.entryId]));
		const inherited = parent?.entries.get(key);
		const matched = old ?? (p.responseId ? response : (original ?? inherited));
		if (
			matched &&
			(!concordant(p, matched.projection) || (!p.responseId && p.entryTimestamp !== matched.projection.entryTimestamp))
		)
			return { evidence: null, unverified: true, aliased: false };
		if (old)
			return {
				evidence: old,
				unverified: old.fact.identityStatus === "unresolved",
				aliased: old.fact.id !== old.canonical.id,
			};
		const unverified =
			(!p.responseId && !!index.header.parent && !matched && (!parent?.complete || parent === index)) ||
			matched?.canonical.identityStatus === "unresolved";
		const identity = {
			producer,
			incarnation: index.header.id,
			attempt: p.responseId
				? `response:${hash(JSON.stringify([p.provider, p.responseId, stream, p.entryId]))}`
				: p.entryId,
		};
		const id = factId(identity);
		if (matched?.fact.id === id)
			return { evidence: matched, unverified: !!unverified, aliased: matched.fact.source.stream !== stream };
		const fact: UsageFact = {
			v: "usage-fact/1",
			id,
			revision: 0,
			supersedes: null,
			identity,
			identityStatus: unverified ? "unresolved" : "verified",
			occurredAt: p.occurredAt,
			provider: p.provider,
			model: p.model,
			kind: p.kind,
			tokens: p.tokens,
			prices: [
				{
					basis: "list-estimate",
					currency: "USD",
					amount: p.priced && p.provider !== "unknown" && p.model !== "unknown" ? p.amount : null,
					status: !p.priced
						? "unpriced"
						: p.provider === "unknown" || p.model === "unknown"
							? "unknown-model"
							: "known",
					rateVersion: p.priced && p.provider !== "unknown" && p.model !== "unknown" ? PI_RECORDED_RATE_VERSION : null,
				},
			],
			source: { stream, event: p.entryId, observedAt, coverage: "complete" },
			links: { task: null, session: matched?.canonical.links.session ?? index.header.id, run: null },
		};
		return {
			evidence: { projection: p, fact, canonical: matched?.canonical ?? fact },
			unverified: !!unverified,
			aliased: !!matched,
		};
	}
}
