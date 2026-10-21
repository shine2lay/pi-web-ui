/** Inert numeric collector. No filesystem/source adapter, importer, timer, root registry or budget authority. */
import { createHash } from "node:crypto";
import { METER_LIMITS } from "./usage-accounting-meter-contract.js";
import {
	accountUsage,
	addUsd,
	checkTaskBinding,
	pacificWeekStartUtc,
	parseAccountingInput,
	taskId,
	type AccountingFault,
	type AccountingInput,
	type AccountingReport,
	type Completeness,
	type Producer,
	type SourceCoverage,
} from "./usage-accounting-contract.js";

export const COLLECTOR_LIMITS = Object.freeze({
	batchBytes: 262_144,
	batchRows: 256,
	// A Pacific week containing the fall DST change is 169 hours, not 168.
	spanMs: 169 * 60 * 60 * 1000,
	workMs: 100,
	segmentBytes: 1_048_576,
	journalBytes: 16_777_216,
	segments: 128,
	frames: 4096,
	historyRows: 10_000,
	checkpointBytes: 65_536,
	sources: 64,
});
const ROW_KEYS = ["facts", "allocations", "aliases", "roots", "policies", "memberships", "snapshots"] as const;
export type NumericRowKind = (typeof ROW_KEYS)[number];
export type NumericRows = Pick<AccountingInput, NumericRowKind>;
export interface SourceCursor {
	ordinal: number;
	token: string;
}
export interface CollectorSource {
	stream: string;
	/** Feed lifetime, NOT the original occurrence incarnation in a copied/forked fact. */
	incarnation: string;
	adapterRef: string | null;
	producer: Producer;
	/** Approved original evidence streams; copies must not rewrite immutable occurrence evidence. */
	occurrenceStreams: string[];
	retainedFrom: string | null;
	grants: NumericRowKind[];
}
export interface SourceInventory {
	v: "usage-inventory/1";
	evidenceRef: string;
	observedAt: string;
	complete: boolean;
	sources: CollectorSource[];
}
export type SourceReason = "none" | "reported-gap" | "missing" | "unsupported" | "retention-gap" | "truncated";
export interface SourceBatch {
	v: "usage-source-batch/1";
	stream: string;
	incarnation: string;
	adapterRef: string;
	fromCursor: SourceCursor | null;
	toCursor: SourceCursor;
	/** Native cumulative occurrence coverage, not a claim derived from row count. */
	from: string;
	through: string;
	observedAt: string;
	status: Completeness | "unavailable";
	reason: SourceReason;
	rows: NumericRows;
}
/** Must consult approved native metadata; no default verifier or authority registration exists. */
export interface CollectorVerifier {
	inventory(value: SourceInventory): boolean;
	/** Verify original stamps, aliases, task birth/event-time parents, prices and any native roots/policies. */
	batch(value: SourceBatch, source: CollectorSource): boolean;
}
/** Implement only in a separately approved wiring task. All calls require lifetime single-writer exclusion.
 * read must enforce the supplied byte/count caps BEFORE allocating; return fixed, consecutive segments from 1.
 * append uses CAS on segment length, creates a new segment exclusively, never rewrites history.
 * sync includes file AND directory durability. checkpoint = write scratch, fsync, rename, fsync directory.
 * No source id is a filename. No I/O implementation or default path is included here. */
export interface CollectorIO {
	read(limits: typeof COLLECTOR_LIMITS): Promise<{ segments: string[]; checkpoint: string | null }>;
	append(segment: number, expectedBytes: number, line: string): Promise<void>;
	sync(segment: number): Promise<void>;
	checkpoint(text: string): Promise<void>;
}
export type CollectorCode =
	| "invalid-batch"
	| "batch-limit"
	| "time-limit"
	| "unapproved-source"
	| "source-unavailable"
	| "native-unverified"
	| "provenance-mismatch"
	| "retention-gap"
	| "truncated-source"
	| "cursor-gap"
	| "cursor-conflict"
	| "revision-gap"
	| "revision-conflict"
	| "rewritten-occurrence"
	| "metadata-conflict"
	| "binding-mismatch"
	| "event-conflict"
	| "alias-conflict"
	| "snapshot-conflict"
	| "journal-tail"
	| "journal-corrupt"
	| "checkpoint-corrupt"
	| "store-capacity"
	| "io-failure"
	| "collector-off"
	| "index-unavailable";
export interface CollectorResult {
	status: "committed" | "duplicate" | "quarantined" | "rejected" | "unavailable";
	code: CollectorCode | null;
	sequence: number;
	cursor: SourceCursor | null;
}
export interface CollectorCheckpoint {
	v: "usage-checkpoint/1";
	sequence: number;
	cursors: { stream: string; incarnation: string; cursor: SourceCursor }[];
}
export interface SourceRequest {
	stream: string;
	incarnation: string;
	cursor: SourceCursor | null;
	priority: "current-week" | "historical-low";
	from: string;
	through: string;
	maxBytes: number;
	maxRows: number;
	maxWorkMs: number;
}
type BatchFrame = {
	v: "usage-journal/1";
	sequence: number;
	at: string;
	kind: "batch";
	batch: SourceBatch;
	code: CollectorCode | null;
};
type FaultFrame = {
	v: "usage-journal/1";
	sequence: number;
	at: string;
	kind: "fault";
	stream: string | null;
	code: CollectorCode;
};
type Frame = BatchFrame | FaultFrame;
class Reject extends Error {
	constructor(readonly code: CollectorCode) {
		super(code);
	}
}
function requireValue(ok: unknown, code: CollectorCode = "invalid-batch"): asserts ok {
	if (!ok) throw new Reject(code);
}
function closed(raw: unknown, fields: readonly string[]): Record<string, unknown> {
	requireValue(raw !== null && typeof raw === "object" && !Array.isArray(raw));
	const v = raw as Record<string, unknown>;
	requireValue(Object.keys(v).length === fields.length && fields.every((k) => Object.hasOwn(v, k)));
	return v;
}
function reference(raw: unknown): asserts raw is string {
	requireValue(typeof raw === "string" && /^[A-Za-z0-9_./:@+-]{1,256}$/.test(raw));
}
function timestamp(raw: unknown): asserts raw is string {
	requireValue(
		typeof raw === "string" &&
			/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(raw) &&
			Number.isFinite(Date.parse(raw)) &&
			new Date(raw).toISOString() === raw,
	);
}
function cursor(raw: unknown): void {
	const c = closed(raw, ["ordinal", "token"]);
	requireValue(Number.isSafeInteger(c.ordinal) && Number(c.ordinal) > 0);
	reference(c.token);
}
function bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}
/** Closed validated numeric JSON only. Never hashes or retains rejected input. */
function canonical(raw: unknown): string {
	if (Array.isArray(raw)) return `[${raw.map(canonical).join(",")}]`;
	if (raw !== null && typeof raw === "object")
		return `{${Object.keys(raw)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical((raw as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	return JSON.stringify(raw) ?? "null";
}
function emptyRows(): NumericRows {
	return { facts: [], allocations: [], aliases: [], roots: [], policies: [], memberships: [], snapshots: [] };
}
function rowCount(rows: NumericRows): number {
	return ROW_KEYS.reduce((n, key) => n + rows[key].length, 0);
}
function normalized(rows: NumericRows): NumericRows {
	const copy = structuredClone(rows);
	for (const f of copy.facts) f.prices.sort((a, b) => a.basis.localeCompare(b.basis));
	for (const s of copy.snapshots) s.coveredFactIds.sort();
	for (const key of ROW_KEYS) {
		const unique = new Map<string, unknown>();
		for (const row of copy[key]) unique.set(canonical(row), row);
		(copy[key] as unknown[]) = [...unique.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
	}
	return copy;
}
function merge(a: NumericRows, b: NumericRows): NumericRows {
	const rows = emptyRows();
	for (const key of ROW_KEYS) (rows[key] as unknown[]) = [...a[key], ...b[key]];
	return normalized(rows);
}
function inventory(raw: unknown, maxSources: number = COLLECTOR_LIMITS.sources, maxBytes = Infinity): SourceInventory {
	const v = closed(raw, ["v", "evidenceRef", "observedAt", "complete", "sources"]);
	requireValue(v.v === "usage-inventory/1" && typeof v.complete === "boolean");
	reference(v.evidenceRef);
	timestamp(v.observedAt);
	requireValue(Array.isArray(v.sources) && v.sources.length > 0 && v.sources.length <= maxSources);
	const streams = new Set<string>();
	let used = maxBytes < Infinity ? bytes(canonical({ ...v, sources: [] })) : 0;
	for (const item of v.sources) {
		const s = closed(item, [
			"stream",
			"incarnation",
			"adapterRef",
			"producer",
			"occurrenceStreams",
			"retainedFrom",
			"grants",
		]);
		reference(s.stream);
		reference(s.incarnation);
		if (s.adapterRef !== null) reference(s.adapterRef);
		if (s.retainedFrom !== null) timestamp(s.retainedFrom);
		requireValue(["pi", "acp", "temper"].includes(String(s.producer)));
		requireValue(
			Array.isArray(s.occurrenceStreams) && s.occurrenceStreams.length > 0 && s.occurrenceStreams.length <= maxSources,
		);
		for (const stream of s.occurrenceStreams) reference(stream);
		requireValue(new Set(s.occurrenceStreams).size === s.occurrenceStreams.length);
		requireValue(
			Array.isArray(s.grants) &&
				s.grants.length <= ROW_KEYS.length &&
				s.grants.every((k) => ROW_KEYS.includes(k)) &&
				new Set(s.grants).size === s.grants.length,
		);
		requireValue(!streams.has(s.stream));
		streams.add(s.stream);
		if (maxBytes < Infinity) {
			used += bytes(canonical(s)) + 1;
			requireValue(used <= maxBytes, "store-capacity");
		}
	}
	return structuredClone(raw) as SourceInventory;
}
function parseBatch(text: string, tick: () => void): SourceBatch {
	requireValue(typeof text === "string" && bytes(text) <= COLLECTOR_LIMITS.batchBytes, "batch-limit");
	const raw: unknown = JSON.parse(text);
	const b = closed(raw, [
		"v",
		"stream",
		"incarnation",
		"adapterRef",
		"fromCursor",
		"toCursor",
		"from",
		"through",
		"observedAt",
		"status",
		"reason",
		"rows",
	]);
	requireValue(b.v === "usage-source-batch/1");
	for (const k of ["stream", "incarnation", "adapterRef"]) reference(b[k]);
	if (b.fromCursor !== null) cursor(b.fromCursor);
	cursor(b.toCursor);
	for (const k of ["from", "through", "observedAt"]) timestamp(b[k]);
	requireValue(String(b.from) <= String(b.through) && String(b.through) <= String(b.observedAt));
	requireValue(Date.parse(String(b.through)) - Date.parse(String(b.from)) <= COLLECTOR_LIMITS.spanMs, "batch-limit");
	requireValue(["complete", "partial", "unknown", "unavailable"].includes(String(b.status)));
	requireValue(
		["none", "reported-gap", "missing", "unsupported", "retention-gap", "truncated"].includes(String(b.reason)),
	);
	requireValue((b.status === "complete") === (b.reason === "none"));
	const rows = closed(b.rows, ROW_KEYS) as unknown as NumericRows;
	for (const key of ROW_KEYS) requireValue(Array.isArray(rows[key]));
	requireValue(rowCount(rows) <= COLLECTOR_LIMITS.batchRows, "batch-limit");
	requireValue(b.status !== "unavailable" || rowCount(rows) === 0);
	const parsed = parseAccountingInput({ v: 1, ...rows, coverage: [], requiredStreams: [b.stream] });
	requireValue(parsed.ok);
	tick();
	return { ...(raw as SourceBatch), rows: normalized(rows) };
}
function provenance(b: SourceBatch, s: CollectorSource, verifier: CollectorVerifier): void {
	requireValue(
		b.stream === s.stream && b.incarnation === s.incarnation && b.adapterRef === s.adapterRef,
		"provenance-mismatch",
	);
	for (const key of ROW_KEYS) requireValue(b.rows[key].length === 0 || s.grants.includes(key), "native-unverified");
	for (const f of b.rows.facts)
		requireValue(
			s.occurrenceStreams.includes(f.source.stream) &&
				f.identity.producer === s.producer &&
				f.occurredAt >= b.from &&
				f.occurredAt <= b.through &&
				f.source.observedAt <= b.observedAt,
			"provenance-mismatch",
		);
	for (const a of b.rows.allocations) requireValue(a.recordedAt <= b.observedAt, "provenance-mismatch");
	for (const snap of b.rows.snapshots) requireValue(snap.observedAt <= b.observedAt, "provenance-mismatch");
	requireValue(verifier.batch(structuredClone(b), structuredClone(s)) === true, "native-unverified");
}
function batchKey(b: SourceBatch): string {
	return canonical([b.stream, b.incarnation, b.toCursor.ordinal]);
}
function same(a: unknown, b: unknown): boolean {
	return canonical(a) === canonical(b);
}
/** Whole retained history, never a last-file-wins choice. Missing predecessors can later be reread/promoted. */
interface ConsistencyWitness {
	code: CollectorCode;
	phase: number;
	order: string;
	sub: number;
}
function consistency(
	rows: NumericRows,
	tick: () => void,
	witness?: (value: ConsistencyWitness) => void,
): CollectorCode | null {
	let phase = 0;
	let order = "";
	const fail = (code: CollectorCode, sub = 0): CollectorCode => {
		witness?.({ code, phase, order, sub });
		return code;
	};
	function revisions<T extends { revision: number }>(
		values: T[],
		key: (row: T) => string,
		startPhase: number,
	): CollectorCode | null {
		phase = startPhase;
		const groups = new Map<string, Map<number, T>>();
		for (const row of values) {
			tick();
			const id = key(row);
			const versions = groups.get(id) ?? new Map<number, T>();
			const prior = versions.get(row.revision);
			if (prior && !same(prior, row)) {
				order = canonical(row);
				return fail("revision-conflict");
			}
			versions.set(row.revision, row);
			groups.set(id, versions);
		}
		phase = startPhase + 1;
		for (const versions of groups.values()) {
			const max = Math.max(...versions.keys());
			if (versions.size !== max + 1) {
				order = canonical(versions.values().next().value);
				return fail("revision-gap");
			}
		}
		return null;
	}
	const revisionFault = revisions(rows.facts, (f) => f.id, 0) ?? revisions(rows.allocations, (a) => a.factId, 2);
	if (revisionFault) return revisionFault;
	const originals = new Map(rows.facts.filter((f) => f.revision === 0).map((f) => [f.id, f]));
	const factVersions = new Map(rows.facts.map((f) => [canonical([f.id, f.revision]), f]));
	const allocationVersions = new Map(rows.allocations.map((a) => [canonical([a.factId, a.revision]), a]));
	phase = 4;
	for (const a of rows.allocations) {
		const prior = allocationVersions.get(canonical([a.factId, a.revision - 1]));
		if (prior && a.recordedAt < prior.recordedAt) {
			order = canonical(a);
			return fail("revision-conflict");
		}
	}
	phase = 5;
	const events = new Map<string, string>();
	for (const f of rows.facts) {
		tick();
		order = witness ? canonical(f) : "";
		const original = originals.get(f.id)!;
		const prior = factVersions.get(canonical([f.id, f.revision - 1]));
		if (prior && f.source.observedAt < prior.source.observedAt) return fail("rewritten-occurrence");
		if (
			f.occurredAt !== original.occurredAt ||
			!same(f.links, original.links) ||
			f.provider !== original.provider ||
			f.model !== original.model ||
			f.kind !== original.kind ||
			f.source.event !== original.source.event ||
			f.source.stream !== original.source.stream ||
			f.source.observedAt < original.source.observedAt
		)
			return fail("rewritten-occurrence");
		const event = canonical([f.identity.producer, f.identity.incarnation, f.source.stream, f.source.event]);
		if (events.has(event) && events.get(event) !== f.id) return fail("event-conflict", 1);
		events.set(event, f.id);
		if (checkTaskBinding(f, rows.memberships) === "mismatch") return fail("binding-mismatch", 2);
	}
	function unique<T>(values: T[], key: (row: T) => string): boolean {
		const seen = new Map<string, T>();
		for (const row of values) {
			tick();
			const id = key(row);
			if (seen.has(id) && !same(seen.get(id), row)) return false;
			seen.set(id, row);
		}
		return true;
	}
	phase = 6;
	order = "";
	if (
		!unique(rows.roots, (r) => r.ref) ||
		!unique(rows.policies, (p) => p.ref) ||
		!unique(rows.memberships, (m) => canonical([taskId(m), m.effectiveAt]))
	)
		return fail("metadata-conflict");
	phase = 7;
	if (!unique(rows.snapshots, (s) => canonical([s.producer, s.incarnation, s.run, s.observedAt])))
		return fail("snapshot-conflict");
	phase = 8;
	if (!unique(rows.aliases, (a) => a.aliasFactId)) return fail("alias-conflict");
	const aliases = new Map(rows.aliases.map((a) => [a.aliasFactId, a.canonicalFactId]));
	const latest = new Map(
		rows.facts
			.slice()
			.sort((a, b) => a.revision - b.revision)
			.map((f) => [f.id, f]),
	);
	const allocations = new Map(
		rows.allocations
			.slice()
			.sort((a, b) => a.revision - b.revision)
			.map((a) => [a.factId, a]),
	);
	const groups = new Map<string, typeof rows.facts>();
	for (const f of latest.values()) {
		tick();
		let id = f.id;
		const seen = new Set<string>();
		while (aliases.has(id)) {
			if (seen.has(id)) return fail("alias-conflict");
			seen.add(id);
			id = aliases.get(id)!;
		}
		if (!latest.has(id)) return fail("alias-conflict");
		groups.set(id, [...(groups.get(id) ?? []), f]);
	}
	for (const [id, group] of groups) {
		const primary = latest.get(id)!;
		const assigned = group.flatMap((f) => {
			const a = allocations.get(f.id);
			return a ? [canonical([a.rootRef, a.scope, a.policyRef, a.payerRole])] : [];
		});
		if (
			new Set(assigned).size > 1 ||
			new Set(group.flatMap((f) => (f.links.task ? [canonical(f.links.task)] : []))).size > 1
		)
			return fail("alias-conflict");
		for (const f of group)
			if (
				f.occurredAt !== primary.occurredAt ||
				f.provider !== primary.provider ||
				f.model !== primary.model ||
				f.kind !== primary.kind
			)
				return fail("alias-conflict");
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
			if (new Set(group.map((f) => f.tokens[key]).filter((n) => n !== null)).size > 1) return fail("alias-conflict");
		for (const basis of ["list-estimate", "provider-reported", "invoice"])
			if (
				new Set(
					group.flatMap((f) =>
						f.prices.filter((p) => p.basis === basis && p.amount !== null).map((p) => addUsd([p.amount!])),
					),
				).size > 1
			)
				return fail("alias-conflict");
	}
	for (const a of rows.aliases)
		if (!latest.has(a.aliasFactId) || !latest.has(a.canonicalFactId)) return fail("alias-conflict");
	return null;
}

/** Caller-owned instance; import does nothing. I/O and verifiers are explicit and fail closed. */
export class UsageAccountingCollector {
	private rows: NumericRows = emptyRows();
	private coverage: SourceCoverage[] = [];
	private cursors = new Map<string, SourceCursor>();
	private receipts = new Map<string, { batch: string; code: CollectorCode | null; sequence: number }>();
	private quarantines = new Map<string, { code: CollectorCode; stream: string; at: string }>();
	private faults: { code: CollectorCode; stream: string | null; at: string }[] = [];
	private sequence = 0;
	private segment = 1;
	private segmentBytes = 0;
	private totalBytes = 0;
	private writable = false;
	private serial: Promise<unknown> = Promise.resolve();
	private pendingRecovery = new Set<CollectorCode>();
	private constructor(
		private readonly sources: SourceInventory | null,
		private readonly verifier: CollectorVerifier | null,
		private readonly io: CollectorIO | null,
		private readonly clock: () => number,
	) {}

	/** Additive worker-only lane; unlike input(), its evidence is paged and always fault-bearing. */
	static openPaged(options: PagedCollectorOptions): Promise<PagedUsageAccountingCollector> {
		return PagedUsageAccountingCollector.open(options);
	}

	static async open(options: {
		inventory: unknown;
		verifier: CollectorVerifier | null;
		io: CollectorIO | null;
		/** Monotonic work clock; not a source of occurrence or observation timestamps. */
		clock?: () => number;
	}): Promise<UsageAccountingCollector> {
		let approved: SourceInventory | null = null;
		try {
			const parsed = inventory(options.inventory);
			if (options.verifier?.inventory(structuredClone(parsed)) === true) approved = parsed;
		} catch {
			/* No input or verifier exception is exposed. */
		}
		const c = new UsageAccountingCollector(
			approved,
			options.verifier,
			options.io,
			options.clock ?? (() => performance.now()),
		);
		if (!approved || !options.io || !options.verifier) {
			c.faults.push({ code: "collector-off", stream: null, at: "0000-01-01T00:00:00.000Z" });
			return c;
		}
		await c.recover();
		return c;
	}
	private deadline(): () => void {
		const start = this.clock();
		return () => requireValue(this.clock() - start <= COLLECTOR_LIMITS.workMs, "time-limit");
	}
	private checkpointValue(): CollectorCheckpoint {
		return {
			v: "usage-checkpoint/1",
			sequence: this.sequence,
			cursors: [...this.cursors]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([stream, value]) => ({
					stream,
					incarnation: this.sources!.sources.find((s) => s.stream === stream)!.incarnation,
					cursor: structuredClone(value),
				})),
		};
	}
	/** A copy, never permission to seek a source before the I/O commit has finished. */
	checkpoint(): CollectorCheckpoint {
		return structuredClone(this.checkpointValue());
	}
	private apply(frame: Frame): void {
		this.sequence = frame.sequence;
		if (frame.kind === "fault") {
			this.faults.push({ code: frame.code, stream: frame.stream, at: frame.at });
			return;
		}
		const b = frame.batch;
		this.rows = merge(this.rows, b.rows);
		this.receipts.set(batchKey(b), { batch: canonical(b), code: frame.code, sequence: frame.sequence });
		if (frame.code === null) {
			this.cursors.set(b.stream, structuredClone(b.toCursor));
			this.quarantines.delete(batchKey(b));
		} else this.quarantines.set(batchKey(b), { code: frame.code, stream: b.stream, at: frame.at });
		if (frame.code === null)
			this.coverage.push({
				stream: b.stream,
				from: b.from,
				through: b.through,
				observedAt: b.observedAt,
				status: b.status,
			});
	}
	private batchCode(b: SourceBatch, tick: () => void): CollectorCode | null {
		const source = this.sources!.sources.find((s) => s.stream === b.stream)!;
		if (b.reason === "truncated") return "truncated-source";
		if (b.status === "unavailable") return "source-unavailable";
		if (source.retainedFrom === null || b.from < source.retainedFrom) return "retention-gap";
		if (!same(this.cursors.get(b.stream) ?? null, b.fromCursor) || b.toCursor.ordinal <= (b.fromCursor?.ordinal ?? 0))
			return "cursor-gap";
		const merged = merge(this.rows, b.rows);
		requireValue(rowCount(merged) <= COLLECTOR_LIMITS.historyRows, "store-capacity");
		return consistency(merged, tick);
	}
	private async recover(): Promise<void> {
		const checkpointImages = new Map<number, string>([[0, canonical(this.checkpointValue()) + "\n"]]);
		try {
			const image = await this.io!.read(COLLECTOR_LIMITS);
			requireValue(image.segments.length <= COLLECTOR_LIMITS.segments, "store-capacity");
			for (let index = 0; index < image.segments.length; index++) {
				const text = image.segments[index];
				requireValue(typeof text === "string" && bytes(text) <= COLLECTOR_LIMITS.segmentBytes, "store-capacity");
				this.totalBytes += bytes(text);
				requireValue(this.totalBytes <= COLLECTOR_LIMITS.journalBytes, "store-capacity");
				const lines = text.split("\n");
				const tail = lines.pop()!;
				if (tail !== "") this.pendingRecovery.add("journal-tail");
				for (const line of lines) {
					const tick = this.deadline();
					const raw = JSON.parse(line);
					requireValue(canonical(raw) === line, "journal-corrupt");
					const fields =
						raw?.kind === "batch"
							? ["v", "sequence", "at", "kind", "batch", "code"]
							: ["v", "sequence", "at", "kind", "stream", "code"];
					closed(raw, fields);
					requireValue(
						raw.v === "usage-journal/1" &&
							raw.sequence === this.sequence + 1 &&
							raw.sequence <= COLLECTOR_LIMITS.frames,
						"journal-corrupt",
					);
					timestamp(raw.at);
					if (raw.kind === "batch") {
						const b = parseBatch(JSON.stringify(raw.batch), tick);
						const source = this.sources!.sources.find((s) => s.stream === b.stream);
						requireValue(source?.adapterRef !== null && source !== undefined, "native-unverified");
						provenance(b, source, this.verifier!);
						const prior = this.receipts.get(batchKey(b));
						requireValue(!prior || (prior.batch === canonical(b) && prior.code !== null), "journal-corrupt");
						requireValue(b.observedAt <= raw.at && raw.code === this.batchCode(b, tick), "journal-corrupt");
						raw.batch = b;
					} else {
						requireValue(raw.kind === "fault" && CODES.has(raw.code), "journal-corrupt");
						requireValue(
							raw.stream === null || this.sources!.sources.some((s) => s.stream === raw.stream),
							"journal-corrupt",
						);
					}
					this.apply(raw as Frame);
					checkpointImages.set(this.sequence, canonical(this.checkpointValue()) + "\n");
				}
				this.segment = index + 1;
				this.segmentBytes = bytes(text);
				if (tail !== "") {
					this.segment++;
					this.segmentBytes = 0;
				}
			}
			if (image.checkpoint !== null) {
				try {
					requireValue(bytes(image.checkpoint) <= COLLECTOR_LIMITS.checkpointBytes);
					const cp = JSON.parse(image.checkpoint);
					requireValue(checkpointImages.get(cp.sequence) === image.checkpoint);
				} catch {
					this.pendingRecovery.add("checkpoint-corrupt");
				}
			}
			// Surviving complete frames are synced before exposing recovered cursors (also after a process-only crash).
			for (let n = 1; n <= image.segments.length; n++) await this.io!.sync(n);
			this.writable = true;
		} catch (e) {
			this.cursors.clear();
			this.faults.push({
				code: e instanceof Reject ? e.code : "journal-corrupt",
				stream: null,
				at: this.sources!.observedAt,
			});
		}
		for (const code of this.pendingRecovery) this.faults.push({ code, stream: null, at: this.sources!.observedAt });
	}
	private async persist(frame: Frame): Promise<void> {
		const line = canonical(frame) + "\n";
		requireValue(bytes(line) <= COLLECTOR_LIMITS.segmentBytes, "store-capacity");
		requireValue(
			this.totalBytes + bytes(line) <= COLLECTOR_LIMITS.journalBytes && frame.sequence <= COLLECTOR_LIMITS.frames,
			"store-capacity",
		);
		if (this.segmentBytes + bytes(line) > COLLECTOR_LIMITS.segmentBytes) {
			this.segment++;
			this.segmentBytes = 0;
		}
		requireValue(this.segment <= COLLECTOR_LIMITS.segments, "store-capacity");
		await this.io!.append(this.segment, this.segmentBytes, line);
		await this.io!.sync(this.segment);
		// Commit point: all facts/revisions and the decision are durable before any cursor becomes visible.
		this.segmentBytes += bytes(line);
		this.totalBytes += bytes(line);
		this.apply(frame);
		await this.io!.checkpoint(canonical(this.checkpointValue()) + "\n");
	}
	private result(status: CollectorResult["status"], stream: string, code: CollectorCode | null): CollectorResult {
		return { status, code, sequence: this.sequence, cursor: structuredClone(this.cursors.get(stream) ?? null) };
	}
	/** Numeric UTF-8 JSON from an approved injected adapter; raw rejects are neither persisted nor returned. */
	collect(stream: string, text: string, receivedAt: string): Promise<CollectorResult> {
		const run = this.serial.then(() => this.collectOne(stream, text, receivedAt));
		this.serial = run.catch(() => undefined);
		return run;
	}
	private async collectOne(stream: string, text: string, receivedAt: string): Promise<CollectorResult> {
		if (!this.writable) return this.result("unavailable", stream, "collector-off");
		let invalidReceiptTime = false;
		try {
			timestamp(receivedAt);
		} catch {
			// Untimed collector fault, NOT an invented occurrence/observation time for a charge.
			receivedAt = "0000-01-01T00:00:00.000Z";
			invalidReceiptTime = true;
		}
		const source = this.sources!.sources.find((s) => s.stream === stream);
		let batch: SourceBatch | null = null;
		let code: CollectorCode | null = null;
		try {
			const tick = this.deadline();
			requireValue(!invalidReceiptTime, "invalid-batch");
			requireValue(source, "unapproved-source");
			requireValue(source.adapterRef !== null, "source-unavailable");
			batch = parseBatch(text, tick);
			requireValue(batch.stream === stream && batch.observedAt <= receivedAt, "provenance-mismatch");
			provenance(batch, source, this.verifier!);
			tick();
			const prior = this.receipts.get(batchKey(batch));
			if (prior) {
				requireValue(prior.batch === canonical(batch), "cursor-conflict");
				if (prior.code === null) return this.result("duplicate", stream, null);
			}
			code = this.batchCode(batch, tick);
			tick();
		} catch (e) {
			code = e instanceof Reject ? e.code : "invalid-batch";
			batch = null;
		}
		try {
			for (const reason of this.pendingRecovery) {
				await this.persist({
					v: "usage-journal/1",
					sequence: this.sequence + 1,
					at: receivedAt,
					kind: "fault",
					stream: null,
					code: reason,
				});
				this.pendingRecovery.delete(reason);
			}
			if (batch) {
				await this.persist({
					v: "usage-journal/1",
					sequence: this.sequence + 1,
					at: receivedAt,
					kind: "batch",
					batch,
					code,
				});
				return this.result(code === null ? "committed" : "quarantined", stream, code);
			}
			await this.persist({
				v: "usage-journal/1",
				sequence: this.sequence + 1,
				at: receivedAt,
				kind: "fault",
				stream: source ? stream : null,
				code: code!,
			});
			return this.result("rejected", stream, code);
		} catch (e) {
			this.writable = false;
			const reason = e instanceof Reject ? e.code : "io-failure";
			this.faults.push({ code: reason, stream: source ? stream : null, at: receivedAt });
			return this.result("unavailable", stream, reason);
		}
	}
	/** All known initiative facts, not just policy-eligible usage. History and originals are retained. */
	input(asOf: string): AccountingInput | null {
		timestamp(asOf);
		if (!this.sources) return null;
		return structuredClone({
			v: 1,
			...this.rows,
			// Backfill of an older window must not replace a current-week watermark.
			coverage: this.coverage.filter((c) => c.through >= pacificWeekStartUtc(asOf)),
			requiredStreams: this.sources.sources.map((s) => s.stream).sort(),
		});
	}
	report(options: { policyRef: string; asOf: string; staleAfterMs: number }): AccountingReport | null {
		const input = this.input(options.asOf);
		if (!input || !input.policies.some((p) => p.ref === options.policyRef)) return null;
		const report = accountUsage(input, options);
		const extra: AccountingFault[] = [...this.faults, ...this.quarantines.values()]
			.filter(
				(f) =>
					["journal-tail", "journal-corrupt", "checkpoint-corrupt", "store-capacity", "collector-off"].includes(
						f.code,
					) || f.at <= options.asOf,
			)
			.map((f) => ({ code: `collector:${f.code}`, ref: f.stream ?? "collector" }));
		if (!this.sources!.complete) extra.push({ code: "collector:inventory-partial", ref: "collector" });
		if (
			this.totalBytes + COLLECTOR_LIMITS.segmentBytes > COLLECTOR_LIMITS.journalBytes ||
			this.sequence >= COLLECTOR_LIMITS.frames ||
			rowCount(this.rows) + COLLECTOR_LIMITS.batchRows > COLLECTOR_LIMITS.historyRows
		)
			extra.push({ code: "collector:store-capacity", ref: "collector" });
		for (const s of this.sources!.sources) {
			if (s.adapterRef === null) extra.push({ code: "collector:source-unavailable", ref: s.stream });
			if (s.retainedFrom === null || s.retainedFrom > pacificWeekStartUtc(options.asOf))
				extra.push({ code: "collector:retention-gap", ref: s.stream });
		}
		const unique = new Map([...report.faults, ...extra].map((f) => [canonical(f), f]));
		report.faults = [...unique.values()].sort((a, b) => a.code.localeCompare(b.code) || a.ref.localeCompare(b.ref));
		if (extra.length) {
			report.coverage = "partial";
			report.remainingUsd = null;
		}
		return report;
	}
	/** Inert scheduling hints only. No fetch, scan, timer, queue operation or continuation is started. */
	requests(asOf: string, historicalFrom: string | null = null): SourceRequest[] {
		timestamp(asOf);
		if (historicalFrom !== null) {
			timestamp(historicalFrom);
			requireValue(historicalFrom <= asOf);
		}
		const current = pacificWeekStartUtc(asOf);
		const sources = this.sources?.sources.filter((s) => s.adapterRef !== null) ?? [];
		const request = (
			s: CollectorSource,
			priority: SourceRequest["priority"],
			from: string,
			through: string,
		): SourceRequest => ({
			stream: s.stream,
			incarnation: s.incarnation,
			cursor: structuredClone(this.cursors.get(s.stream) ?? null),
			priority,
			from,
			through,
			maxBytes: COLLECTOR_LIMITS.batchBytes,
			maxRows: COLLECTOR_LIMITS.batchRows,
			maxWorkMs: COLLECTOR_LIMITS.workMs,
		});
		return [
			...sources.map((s) => request(s, "current-week", current, asOf)),
			...(historicalFrom !== null && historicalFrom < current
				? sources.map((s) =>
						request(
							s,
							"historical-low",
							historicalFrom,
							new Date(
								Math.min(Date.parse(current), Date.parse(historicalFrom) + COLLECTOR_LIMITS.spanMs),
							).toISOString(),
						),
					)
				: []),
		];
	}
}
const CODES = new Set<CollectorCode>([
	"invalid-batch",
	"batch-limit",
	"time-limit",
	"unapproved-source",
	"source-unavailable",
	"native-unverified",
	"provenance-mismatch",
	"retention-gap",
	"truncated-source",
	"cursor-gap",
	"cursor-conflict",
	"revision-gap",
	"revision-conflict",
	"rewritten-occurrence",
	"metadata-conflict",
	"binding-mismatch",
	"event-conflict",
	"alias-conflict",
	"snapshot-conflict",
	"journal-tail",
	"journal-corrupt",
	"checkpoint-corrupt",
	"store-capacity",
	"io-failure",
	"collector-off",
	"index-unavailable",
]);

export interface JournalPosition {
	segment: number;
	offset: number;
}
export interface PagedCollectorCheckpoint {
	v: "usage-paged-checkpoint/1";
	sequence: number;
	end: JournalPosition;
	sha256: string;
}
type AnyNumericRow = NumericRows[NumericRowKind][number];
export type CollectorIndexValue =
	| { kind: "row"; rowKind: NumericRowKind; row: AnyNumericRow }
	| { kind: "node"; identity: string; component: string }
	| { kind: "witness"; component: string; witness: ConsistencyWitness }
	| { kind: "receipt"; batch: string; code: CollectorCode | null; sequence: number }
	| { kind: "quarantine"; stream: string; code: CollectorCode; at: string }
	| { kind: "coverage"; coverage: SourceCoverage }
	| { kind: "fault"; stream: string | null; code: CollectorCode; at: string };
export interface CollectorIndexEntry {
	key: string;
	value: CollectorIndexValue;
}
export interface CollectorIndexPage {
	entries: CollectorIndexEntry[];
	after: string | null;
}
/** Derived, private numeric data only. reset invalidates only the cache, NEVER a journal segment.
 * Reads/negative lookups are over this rebuilt generation; missing/corrupt storage pages MUST throw.
 * W1 validates disk/cache checksums and honors indexBytes/indexEntries and an <=8MiB page cache.
 * scan uses ascending binary key order; after is the last key, not an opaque native source cursor. */
export interface CollectorNumericIndex {
	reset(): Promise<void>;
	/** Conservative numeric-cache admission before append. Leaves two entries/1KiB for the final fault. */
	reserve(newEntries: number, newBytes: number): Promise<boolean>;
	get(keys: string[], limits: { maxBytes: number; maxRows: number }): Promise<CollectorIndexEntry[]>;
	scan(
		prefix: string,
		after: string | null,
		limits: { maxBytes: number; maxRows: number },
	): Promise<CollectorIndexPage>;
	write(
		entries: { key: string; value: CollectorIndexValue | null }[],
		limits: { maxBytes: number; maxRows: number },
	): Promise<void>;
}
/** No implementation/path/default is supplied. All methods run in the lifetime-locked worker.
 * head validates consecutive segment identities and sizes BEFORE allocating; readPage reads <=maxBytes.
 * append/sync/checkpoint keep the legacy durability contract. Provision a separate final fault reserve.
 * Index publication is derived; on any partial update/failure the collector closes and rebuilds on open. */
export interface PagedCollectorIO extends Pick<CollectorIO, "append" | "sync" | "checkpoint"> {
	v: "usage-collector-paged-io/1";
	head(limits: typeof METER_LIMITS): Promise<{ sizes: number[]; checkpoint: string | null }>;
	readPage(position: JournalPosition, maxBytes: number): Promise<Uint8Array>;
	index: CollectorNumericIndex;
	/** Must yield to the event loop (setImmediate or equivalent), never Promise.resolve(). */
	yield(): Promise<void>;
}
export interface PagedCollectorOptions {
	inventory: unknown;
	verifier: CollectorVerifier | null;
	io: PagedCollectorIO | null;
	clock?: () => number;
}
export type CollectorEvidenceCode = CollectorCode | "inventory-partial";
export interface CollectorEvidence {
	v: "usage-collector-evidence/1";
	sequence: number;
	asOf: string;
	storage: "healthy" | "partial" | "unavailable";
	inventoryComplete: boolean;
	requiredStreams: string[];
	faults: AccountingFault[];
	/** Affected (code,source) buckets, not occurrence/charge counts. Multi-source refs collapse conservatively. */
	faultCounts: { code: CollectorEvidenceCode; count: number }[];
}
export interface CollectorEvidencePage {
	v: "usage-collector-evidence-page/1";
	evidence: CollectorEvidence;
	rows: NumericRows;
	coverage: SourceCoverage[];
}
interface ComponentPlan {
	id: string;
	old: string[];
	rows: NumericRows;
	witness: ConsistencyWitness | null;
}
const PAGE = Object.freeze({ maxBytes: METER_LIMITS.pageBytes, maxRows: METER_LIMITS.pageRows });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const START_DIGEST = "0".repeat(64);
const FRAME_BYTES = METER_LIMITS.pageBytes + 1024;
const capacity = () => {
	throw new Reject("store-capacity");
};
function nodes(kind: NumericRowKind, row: AnyNumericRow): string[] {
	const r = row as unknown as Record<string, unknown>;
	const node = (...parts: unknown[]) => canonical(parts);
	if (kind === "facts") {
		const f = row as NumericRows["facts"][number];
		return [
			node("fact", f.id),
			node("event", f.identity.producer, f.identity.incarnation, f.source.stream, f.source.event),
			...(f.links.task ? [node("task", taskId(f.links.task))] : []),
		];
	}
	if (kind === "allocations") return [node("fact", r.factId)];
	if (kind === "aliases") return [node("fact", r.aliasFactId), node("fact", r.canonicalFactId)];
	if (kind === "memberships") return [node("task", taskId(row as NumericRows["memberships"][number]))];
	if (kind === "snapshots") return [node(kind, r.producer, r.incarnation, r.run, r.observedAt)];
	return [node(kind, r.ref)];
}
function* entries(rows: NumericRows): Generator<{ rowKind: NumericRowKind; row: AnyNumericRow }> {
	for (const rowKind of ROW_KEYS) for (const row of rows[rowKind]) yield { rowKind, row };
}
function pushRow(rows: NumericRows, kind: NumericRowKind, row: AnyNumericRow): void {
	(rows[kind] as AnyNumericRow[]).push(row);
}
function firstWitness(a: ConsistencyWitness | null, b: ConsistencyWitness | null): ConsistencyWitness | null {
	if (!a) return b;
	if (!b) return a;
	const comparison = a.phase - b.phase || a.order.localeCompare(b.order) || a.sub - b.sub;
	return comparison <= 0 ? a : b;
}

/** Paged lane: no retained journal/whole-history arrays, no timers, no production I/O. */
export class PagedUsageAccountingCollector {
	private sequence = 0;
	private segment = 1;
	private segmentBytes = 0;
	private totalBytes = 0;
	private digest = START_DIGEST;
	private writable = false;
	private mutating = false;
	private capacitySealed = false;
	private cursors = new Map<string, SourceCursor>();
	private memoryFaults: { code: CollectorCode; stream: string | null; at: string }[] = [];
	private pending = new Set<CollectorCode>();
	private serial: Promise<unknown> = Promise.resolve();
	private maxActiveMs = 0;
	private yields = 0;
	private readonly weeks = new Map<string, string>();
	/** Pacific transitions and Monday boundaries are whole UTC hours; bounded cache avoids per-attempt Intl allocation. */
	private week(at: string): string {
		const key = at.slice(0, 13),
			cached = this.weeks.get(key);
		if (cached) return cached;
		const value = pacificWeekStartUtc(at);
		if (this.weeks.size >= PAGE.maxRows) this.weeks.delete(this.weeks.keys().next().value!);
		this.weeks.set(key, value);
		return value;
	}
	private constructor(
		private readonly sources: SourceInventory | null,
		private readonly verifier: CollectorVerifier | null,
		private readonly io: PagedCollectorIO | null,
		private readonly clock: () => number,
	) {}
	static async open(o: PagedCollectorOptions): Promise<PagedUsageAccountingCollector> {
		let approved: SourceInventory | null = null;
		try {
			const parsed = inventory(o.inventory, METER_LIMITS.sources, METER_LIMITS.checkpointBytes);
			requireValue(
				bytes(canonical(parsed)) <= METER_LIMITS.checkpointBytes &&
					bytes(canonical(parsed.sources.map((s) => s.stream))) <= METER_LIMITS.pageBytes / 2,
				"store-capacity",
			);
			if (o.verifier?.inventory(structuredClone(parsed)) === true) approved = parsed;
		} catch {
			/* supplied metadata is not authority */
		}
		const c = new PagedUsageAccountingCollector(approved, o.verifier, o.io, o.clock ?? (() => performance.now()));
		if (!approved || !o.io || !o.verifier || o.io.v !== "usage-collector-paged-io/1") {
			c.memoryFaults.push({ code: "collector-off", stream: null, at: "0000-01-01T00:00:00.000Z" });
			return c;
		}
		await c.recover();
		return c;
	}
	private active<T>(fn: (tick: () => void) => T): T {
		const start = this.clock();
		const tick = () => requireValue(this.clock() - start <= METER_LIMITS.unitWorkMs, "time-limit");
		try {
			const value = fn(tick);
			tick();
			return value;
		} finally {
			this.maxActiveMs = Math.max(this.maxActiveMs, this.clock() - start);
		}
	}
	private async pause(): Promise<void> {
		await this.io!.yield();
		this.yields++;
	}
	metrics(): { maxActiveMs: number; yields: number; journalBytes: number; sequence: number } {
		return {
			maxActiveMs: this.maxActiveMs,
			yields: this.yields,
			journalBytes: this.totalBytes,
			sequence: this.sequence,
		};
	}
	checkpoint(): CollectorCheckpoint {
		return {
			v: "usage-checkpoint/1",
			sequence: this.sequence,
			cursors:
				this.writable || this.capacitySealed
					? [...this.cursors]
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([stream, value]) => ({
								stream,
								incarnation: this.sources!.sources.find((s) => s.stream === stream)!.incarnation,
								cursor: structuredClone(value),
							}))
					: [],
		};
	}
	private prefix(): PagedCollectorCheckpoint {
		return {
			v: "usage-paged-checkpoint/1",
			sequence: this.sequence,
			end: { segment: this.segment, offset: this.segmentBytes },
			sha256: this.digest,
		};
	}
	private async get(keys: string[]): Promise<Map<string, CollectorIndexValue>> {
		const result = new Map<string, CollectorIndexValue>();
		for (let start = 0; start < keys.length; start += PAGE.maxRows) {
			const query = keys.slice(start, start + PAGE.maxRows);
			const found = await this.io!.index.get(query, PAGE).catch(() => {
				throw new Reject("index-unavailable");
			});
			requireValue(
				Array.isArray(found) && found.length <= query.length && bytes(JSON.stringify(found)) <= PAGE.maxBytes,
				"index-unavailable",
			);
			for (const e of found) {
				requireValue(query.includes(e.key) && !result.has(e.key), "index-unavailable");
				result.set(e.key, e.value);
			}
			await this.pause();
		}
		return result;
	}
	private async *scan(prefix: string): AsyncGenerator<CollectorIndexEntry> {
		let after: string | null = null,
			totalRows = 0,
			totalBytes = 0;
		do {
			const page: CollectorIndexPage = await this.io!.index.scan(prefix, after, PAGE).catch(() => {
				throw new Reject("index-unavailable");
			});
			const pageBytes = bytes(JSON.stringify(page));
			requireValue(
				Array.isArray(page.entries) && page.entries.length <= PAGE.maxRows && pageBytes <= PAGE.maxBytes,
				"index-unavailable",
			);
			totalRows += page.entries.length;
			totalBytes += pageBytes;
			requireValue(
				totalRows <= METER_LIMITS.indexEntries && totalBytes <= METER_LIMITS.indexBytes,
				"index-unavailable",
			);
			let last: string | null = after;
			for (const e of page.entries) {
				requireValue(e.key.startsWith(prefix) && (last === null || e.key > last), "index-unavailable");
				last = e.key;
				yield e;
			}
			requireValue(page.after === null || (page.entries.length > 0 && page.after === last), "index-unavailable");
			after = page.after;
			await this.pause();
		} while (after !== null);
	}
	private async write(
		values:
			| Iterable<{ key: string; value: CollectorIndexValue | null }>
			| AsyncIterable<{ key: string; value: CollectorIndexValue | null }>,
	): Promise<void> {
		let page: { key: string; value: CollectorIndexValue | null }[] = [];
		let size = 2;
		const flush = async () => {
			if (!page.length) return;
			await this.io!.index.write(page, PAGE);
			page = [];
			size = 2;
			await this.pause();
		};
		for await (const e of values) {
			const n = bytes(JSON.stringify(e)) + 1;
			if (n + 2 > PAGE.maxBytes) capacity();
			if (page.length >= PAGE.maxRows || size + n > PAGE.maxBytes) await flush();
			page.push(e);
			size += n;
		}
		await flush();
	}
	/** All validated retained revisions participate, including quarantines and cold originals. */
	private async prepare(delta: NumericRows): Promise<{ plans: ComponentPlan[]; code: CollectorCode | null }> {
		const parent = new Map<string, string>();
		const find = (x: string): string => {
			if (!parent.has(x)) parent.set(x, x);
			let at = x;
			while (parent.get(at) !== at) at = parent.get(at)!;
			while (parent.get(x) !== x) {
				const next = parent.get(x)!;
				parent.set(x, at);
				x = next;
			}
			return at;
		};
		const union = (a: string, b: string) => {
			const x = find(a),
				y = find(b);
			if (x !== y) parent.set(y, x);
		};
		const incoming = [...entries(delta)].map((e) => ({ ...e, nodes: nodes(e.rowKind, e.row) }));
		const identities = [...new Set(incoming.flatMap((e) => e.nodes))];
		const known = await this.get(identities.map((n) => `n:${n}`));
		const oldIds = new Set<string>();
		for (const e of incoming) {
			for (const n of e.nodes) {
				find(n);
				union(e.nodes[0], n);
			}
		}
		for (const n of identities) {
			const value = known.get(`n:${n}`);
			if (!value) continue;
			requireValue(
				value.kind === "node" && value.identity === n && /^[a-f0-9]{64}$/.test(value.component),
				"index-unavailable",
			);
			union(n, `component:${value.component}`);
			oldIds.add(value.component);
		}
		const groups = new Map<string, { old: string[]; rows: NumericRows }>();
		const group = (root: string) => {
			let g = groups.get(root);
			if (!g) {
				g = { old: [], rows: emptyRows() };
				groups.set(root, g);
			}
			return g;
		};
		for (const e of incoming) pushRow(group(find(e.nodes[0])).rows, e.rowKind, e.row);
		const cleanNew = oldIds.size === 0 && this.active((tick) => consistency(delta, tick)) === null;
		let count = rowCount(delta),
			size = bytes(canonical(delta));
		for (const id of oldIds) {
			const g = group(find(`component:${id}`));
			g.old.push(id);
			let found = false;
			for await (const e of this.scan(`r:${id}:`)) {
				requireValue(e.value.kind === "row", "index-unavailable");
				if (++count > METER_LIMITS.lookupRows || (size += bytes(canonical(e.value))) > METER_LIMITS.lookupBytes)
					capacity();
				pushRow(g.rows, e.value.rowKind, e.value.row);
				found = true;
			}
			requireValue(found, "index-unavailable");
		}
		const plans: ComponentPlan[] = [];
		for (const [root, g] of groups) {
			if (cleanNew) {
				// The source boundary already proved these canonical subsequences. Global retained
				// witnesses are STILL read below: a new delta is not proof of index health.
				plans.push({ id: hash(root), old: g.old, rows: g.rows, witness: null });
				continue;
			}
			const rows = this.active((tick) => {
				const value = normalized(g.rows);
				tick();
				return value;
			});
			const parsed = this.active(() =>
				parseAccountingInput({ v: 1, ...rows, requiredStreams: ["index:verified"], coverage: [] }),
			);
			requireValue(parsed.ok, "index-unavailable");
			let witness: ConsistencyWitness | null = null;
			this.active((tick) =>
				consistency(rows, tick, (value) => {
					witness = value;
				}),
			);
			plans.push({ id: g.old.sort()[0] ?? hash(root), old: g.old, rows, witness });
			await this.pause();
		}
		let witness: ConsistencyWitness | null = null;
		let witnessBytes = 0;
		let witnessRows = 0;
		for await (const e of this.scan("w:")) {
			requireValue(e.value.kind === "witness", "index-unavailable");
			if (oldIds.has(e.value.component)) continue;
			if (
				++witnessRows > METER_LIMITS.lookupRows ||
				(witnessBytes += bytes(canonical(e.value))) > METER_LIMITS.lookupBytes
			)
				capacity();
			witness = firstWitness(witness, e.value.witness);
		}
		for (const p of plans) witness = firstWitness(witness, p.witness);
		return { plans, code: witness?.code ?? null };
	}
	private async apply(frame: Frame, plans: ComponentPlan[]): Promise<void> {
		if (frame.kind === "fault") {
			const key = `f:${canonical([frame.code, frame.stream])}`,
				previous = (await this.get([key])).get(key);
			if (previous && previous.kind !== "fault") throw new Reject("index-unavailable");
			if (!previous || previous.at > frame.at)
				await this.write([{ key, value: { kind: "fault", stream: frame.stream, at: frame.at, code: frame.code } }]);
			if (frame.code === "store-capacity") this.capacitySealed = true;
		} else {
			// One bounded pager spans independent components; never accumulate their operations.
			const mutations = async function* (
				collector: PagedUsageAccountingCollector,
			): AsyncGenerator<{ key: string; value: CollectorIndexValue | null }> {
				for (const plan of plans) {
					for (const old of plan.old) {
						for await (const e of collector.scan(`r:${old}:`)) {
							requireValue(e.value.kind === "row", "index-unavailable");
							yield { key: e.key, value: null };
						}
						yield { key: `w:${old}`, value: null };
					}
					const all = [...entries(plan.rows)];
					const ids = [...new Set(all.flatMap((e) => nodes(e.rowKind, e.row)))];
					const weeks = [...new Set(plan.rows.facts.map((f) => collector.week(f.occurredAt)))];
					const exposure = weeks.length ? weeks : ["metadata"];
					// Reverse manifests avoid a cold-history scan when a component is replaced.
					for (const old of plan.old) {
						for await (const e of collector.scan(`x:${old}:`)) {
							yield { key: e.key.slice(`x:${old}:`.length), value: null };
							yield { key: e.key, value: null };
						}
					}
					for (const n of ids) yield { key: `n:${n}`, value: { kind: "node", identity: n, component: plan.id } };
					for (const e of all)
						yield { key: `r:${plan.id}:${e.rowKind}:${hash(canonical(e.row))}`, value: { kind: "row", ...e } };
					for (const week of exposure) {
						const key = `e:${week}:${plan.id}`;
						const value: CollectorIndexValue = { kind: "node", identity: week, component: plan.id };
						yield { key, value };
						yield { key: `x:${plan.id}:${key}`, value };
					}
					if (plan.witness)
						yield { key: `w:${plan.id}`, value: { kind: "witness", component: plan.id, witness: plan.witness } };
				}
			};
			await this.write(mutations(this));
			const b = frame.batch,
				key = batchKey(b),
				ref = `qref:${key}`;
			const previous = (await this.get([ref])).get(ref);
			if (previous && previous.kind !== "quarantine") throw new Reject("index-unavailable");
			const group = (code: CollectorCode) => canonical([b.stream, code]);
			const quarantineKey = (code: CollectorCode, at: string) => `q:${group(code)}:${at}:${key}`;
			const operations: { key: string; value: CollectorIndexValue | null }[] = [
				{
					key: `b:${key}`,
					value: { kind: "receipt", batch: canonical(b), code: frame.code, sequence: frame.sequence },
				},
				{
					key: ref,
					value: frame.code === null ? null : { kind: "quarantine", stream: b.stream, code: frame.code, at: frame.at },
				},
			];
			if (previous) operations.push({ key: quarantineKey(previous.code, previous.at), value: null });
			if (frame.code !== null)
				operations.push({
					key: quarantineKey(frame.code, frame.at),
					value: { kind: "quarantine", stream: b.stream, code: frame.code, at: frame.at },
				});
			await this.write(operations);
			// Keep the earliest active receipt per (code,source). Historical quarantines are never scanned on a view.
			for (const code of new Set([previous?.code, frame.code].filter((v): v is CollectorCode => v != null))) {
				let earliest: CollectorIndexValue | null = null;
				for await (const e of this.scan(`q:${group(code)}:`)) {
					earliest = e.value;
					await this.pause();
					break;
				}
				await this.write([{ key: `a:${group(code)}`, value: earliest }]);
			}
			if (frame.code === null) {
				await this.write([
					{
						key: `c:${this.week(b.through)}:${b.stream}:${String(frame.sequence).padStart(10, "0")}`,
						value: {
							kind: "coverage",
							coverage: {
								stream: b.stream,
								from: b.from,
								through: b.through,
								observedAt: b.observedAt,
								status: b.status,
							},
						},
					},
				]);
				this.cursors.set(b.stream, structuredClone(b.toCursor));
			}
		}
		this.sequence = frame.sequence;
	}
	private code(b: SourceBatch, integrity: CollectorCode | null): CollectorCode | null {
		const s = this.sources!.sources.find((s) => s.stream === b.stream)!;
		if (b.reason === "truncated") return "truncated-source";
		if (b.status === "unavailable") return "source-unavailable";
		if (s.retainedFrom === null || b.from < s.retainedFrom) return "retention-gap";
		if (!same(this.cursors.get(b.stream) ?? null, b.fromCursor) || b.toCursor.ordinal <= (b.fromCursor?.ordinal ?? 0))
			return "cursor-gap";
		return integrity;
	}
	private async receipt(b: SourceBatch): Promise<Extract<CollectorIndexValue, { kind: "receipt" }> | null> {
		const prior = (await this.get([`b:${batchKey(b)}`])).get(`b:${batchKey(b)}`);
		if (!prior) return null;
		requireValue(prior.kind === "receipt", "index-unavailable");
		return prior;
	}
	private async recover(): Promise<void> {
		try {
			const head = await this.io!.head(METER_LIMITS);
			requireValue(
				Array.isArray(head.sizes) &&
					head.sizes.length <= METER_LIMITS.segments &&
					head.sizes.every((n) => Number.isSafeInteger(n) && n >= 0 && n <= METER_LIMITS.segmentBytes),
				"store-capacity",
			);
			this.totalBytes = head.sizes.reduce((a, b) => a + b, 0);
			requireValue(this.totalBytes <= METER_LIMITS.journalBytes, "store-capacity");
			await this.io!.index.reset();
			let cp: PagedCollectorCheckpoint | null = null;
			try {
				if (head.checkpoint !== null) {
					requireValue(bytes(head.checkpoint) <= METER_LIMITS.checkpointBytes);
					const raw = closed(JSON.parse(head.checkpoint), ["v", "sequence", "end", "sha256"]);
					requireValue(
						raw.v === "usage-paged-checkpoint/1" &&
							Number.isSafeInteger(raw.sequence) &&
							Number(raw.sequence) >= 0 &&
							Number(raw.sequence) <= METER_LIMITS.frames &&
							typeof raw.sha256 === "string" &&
							/^[a-f0-9]{64}$/.test(raw.sha256),
					);
					const end = closed(raw.end, ["segment", "offset"]);
					requireValue(
						Number.isSafeInteger(end.segment) &&
							Number(end.segment) > 0 &&
							Number.isSafeInteger(end.offset) &&
							Number(end.offset) >= 0 &&
							Number(end.offset) <= METER_LIMITS.segmentBytes,
					);
					cp = raw as unknown as PagedCollectorCheckpoint;
				}
			} catch {
				this.pending.add("checkpoint-corrupt");
			}
			let matched = cp === null || (cp.sequence === 0 && same(cp, this.prefix()));
			for (let s = 1; s <= head.sizes.length; s++) {
				let offset = 0,
					completeOffset = 0,
					carry = Buffer.alloc(0);
				while (offset < head.sizes[s - 1]) {
					const page = await this.io!.readPage(
						{ segment: s, offset },
						Math.min(PAGE.maxBytes, head.sizes[s - 1] - offset),
					);
					requireValue(
						page instanceof Uint8Array && page.byteLength === Math.min(PAGE.maxBytes, head.sizes[s - 1] - offset),
						"journal-corrupt",
					);
					offset += page.byteLength;
					const buffer = Buffer.concat([carry, page]);
					let start = 0,
						end: number;
					while ((end = buffer.indexOf(10, start)) >= 0) {
						const lineBytes = buffer.subarray(start, end);
						requireValue(lineBytes.length <= FRAME_BYTES, "store-capacity");
						const line = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes);
						completeOffset += lineBytes.length + 1;
						start = end + 1;
						const raw = this.active(() => {
							const value = JSON.parse(line);
							requireValue(canonical(value) === line, "journal-corrupt");
							return value as Record<string, unknown>;
						});
						closed(
							raw,
							raw.kind === "batch"
								? ["v", "sequence", "at", "kind", "batch", "code"]
								: ["v", "sequence", "at", "kind", "stream", "code"],
						);
						requireValue(
							raw.v === "usage-journal/1" &&
								raw.sequence === this.sequence + 1 &&
								Number(raw.sequence) <= METER_LIMITS.frames,
							"journal-corrupt",
						);
						timestamp(raw.at);
						let plans: ComponentPlan[] = [];
						if (raw.kind === "batch") {
							requireValue(!this.capacitySealed, "journal-corrupt");
							const b = this.active((tick) => parseBatch(JSON.stringify(raw.batch), tick));
							const source = this.sources!.sources.find((s) => s.stream === b.stream);
							requireValue(source && source.adapterRef !== null, "native-unverified");
							this.active(() => provenance(b, source, this.verifier!));
							const prior = await this.receipt(b);
							requireValue(!prior || (prior.batch === canonical(b) && prior.code !== null), "journal-corrupt");
							const prepared = await this.prepare(b.rows);
							plans = prepared.plans;
							requireValue(b.observedAt <= raw.at && raw.code === this.code(b, prepared.code), "journal-corrupt");
							raw.batch = b;
						} else {
							requireValue(
								raw.kind === "fault" &&
									CODES.has(raw.code as CollectorCode) &&
									(raw.stream === null || this.sources!.sources.some((s) => s.stream === raw.stream)),
								"journal-corrupt",
							);
						}
						await this.apply(raw as unknown as Frame, plans);
						this.digest = hash(this.digest + line + "\n");
						this.segment = s;
						this.segmentBytes = completeOffset;
						if (cp?.sequence === this.sequence) matched = same(cp, this.prefix());
						await this.pause();
					}
					carry = Buffer.from(buffer.subarray(start));
					requireValue(carry.length <= FRAME_BYTES, "store-capacity");
					await this.pause();
				}
				this.segment = s;
				this.segmentBytes = head.sizes[s - 1];
				if (carry.length) {
					this.pending.add("journal-tail");
					this.segment = s + 1;
					this.segmentBytes = 0;
				}
			}
			if (!matched) this.pending.add("checkpoint-corrupt");
			for (let s = 1; s <= head.sizes.length; s++) {
				await this.io!.sync(s);
				await this.pause();
			}
			this.writable = !this.capacitySealed;
		} catch (e) {
			this.cursors.clear();
			this.memoryFaults.push({
				code: e instanceof Reject ? e.code : "journal-corrupt",
				stream: null,
				at: this.sources!.observedAt,
			});
		}
		for (const code of this.pending) this.memoryFaults.push({ code, stream: null, at: this.sources!.observedAt });
	}
	private async persist(frame: Frame, plans: ComponentPlan[], reserve = false): Promise<void> {
		const line = this.active(() => canonical(frame) + "\n"),
			length = bytes(line);
		requireValue(length <= FRAME_BYTES, "store-capacity");
		// Ordinary writes leave a whole segment, one frame and 1KiB bytes for a durable capacity fence.
		requireValue(
			this.totalBytes + length + (reserve ? 0 : 1024) <= METER_LIMITS.journalBytes &&
				frame.sequence <= METER_LIMITS.frames - (reserve ? 0 : 1),
			"store-capacity",
		);
		let segment = this.segment,
			offset = this.segmentBytes;
		if (offset + length > METER_LIMITS.segmentBytes) {
			segment++;
			offset = 0;
		}
		requireValue(segment <= METER_LIMITS.segments - (reserve ? 0 : 1), "store-capacity");
		if (!reserve) {
			// Upper bound includes replacement components, receipt, coverage, quarantine and reverse manifests.
			let newEntries = 8,
				newBytes = length * 2 + 4096;
			if (frame.kind === "batch")
				requireValue(
					bytes(
						canonical({
							key: `b:${batchKey(frame.batch)}`,
							value: { kind: "receipt", batch: canonical(frame.batch), code: frame.code, sequence: frame.sequence },
						}),
					) +
						3 <=
						PAGE.maxBytes,
					"store-capacity",
				);
			for (const p of plans) {
				const all = [...entries(p.rows)],
					identities = new Set(all.flatMap((e) => nodes(e.rowKind, e.row)));
				const exposures = Math.max(1, new Set(p.rows.facts.map((f) => this.week(f.occurredAt))).size);
				if (p.witness)
					requireValue(
						bytes(canonical({ key: `w:${p.id}`, value: { kind: "witness", component: p.id, witness: p.witness } })) +
							3 <=
							PAGE.maxBytes,
						"store-capacity",
					);
				for (const n of identities)
					requireValue(
						bytes(canonical({ key: `n:${n}`, value: { kind: "node", identity: n, component: p.id } })) + 3 <=
							PAGE.maxBytes,
						"store-capacity",
					);
				const evidenceBytes = PAGE.maxBytes - bytes(canonical(this.sources!.sources.map((s) => s.stream))) - 32 * 1024;
				for (const e of all)
					requireValue(
						bytes(canonical(e.row)) <= evidenceBytes &&
							bytes(
								canonical({ key: `r:${p.id}:${e.rowKind}:${hash(canonical(e.row))}`, value: { kind: "row", ...e } }),
							) +
								3 <=
								PAGE.maxBytes,
						"store-capacity",
					);
				newEntries += all.length + identities.size + exposures * 2 + 1;
				newBytes +=
					bytes(canonical(p.rows)) * 2 +
					[...identities].reduce((n, id) => n + bytes(id) * 2 + 256, 0) +
					exposures * 512 +
					1024;
			}
			requireValue(
				await this.io!.index.reserve(newEntries, newBytes).catch(() => {
					throw new Reject("index-unavailable");
				}),
				"store-capacity",
			);
		}
		this.mutating = true;
		try {
			await this.io!.append(segment, offset, line);
			await this.io!.sync(segment);
			this.segment = segment;
			this.segmentBytes = offset + length;
			this.totalBytes += length;
			await this.apply(frame, plans);
			this.digest = hash(this.digest + line);
			await this.io!.checkpoint(canonical(this.prefix()) + "\n");
			await this.pause();
		} catch {
			this.writable = false;
			throw new Reject("io-failure");
		} finally {
			this.mutating = false;
		}
	}
	private result(status: CollectorResult["status"], stream: string, code: CollectorCode | null): CollectorResult {
		return { status, code, sequence: this.sequence, cursor: structuredClone(this.cursors.get(stream) ?? null) };
	}
	collect(stream: string, text: string, at: string): Promise<CollectorResult> {
		const run = this.serial.then(() => this.collectOne(stream, text, at));
		this.serial = run.catch(() => undefined);
		return run;
	}
	private async collectOne(stream: string, text: string, at: string): Promise<CollectorResult> {
		if (!this.writable)
			return this.result("unavailable", stream, this.capacitySealed ? "store-capacity" : "collector-off");
		const source = this.sources!.sources.find((s) => s.stream === stream);
		let batch: SourceBatch | null = null,
			code: CollectorCode | null = null,
			plans: ComponentPlan[] = [];
		try {
			timestamp(at);
			requireValue(source, "unapproved-source");
			requireValue(source.adapterRef !== null, "source-unavailable");
			batch = this.active((tick) => parseBatch(text, tick));
			requireValue(batch.stream === stream && batch.observedAt <= at, "provenance-mismatch");
			this.active(() => provenance(batch!, source, this.verifier!));
			const prior = await this.receipt(batch);
			if (prior) {
				requireValue(prior.batch === canonical(batch), "cursor-conflict");
				if (prior.code === null) return this.result("duplicate", stream, null);
			}
			const prepared = await this.prepare(batch.rows);
			plans = prepared.plans;
			code = this.code(batch, prepared.code);
		} catch (e) {
			code = e instanceof Reject ? e.code : "invalid-batch";
			batch = null;
			plans = [];
		}
		try {
			try {
				timestamp(at);
			} catch {
				at = "0000-01-01T00:00:00.000Z";
			}
			try {
				for (const reason of this.pending) {
					await this.persist(
						{ v: "usage-journal/1", sequence: this.sequence + 1, at, kind: "fault", stream: null, code: reason },
						[],
					);
					this.pending.delete(reason);
				}
			} catch (e) {
				if (e instanceof Reject && e.code === "store-capacity") return await this.fence(stream, at);
				throw e;
			}
			if (code === "store-capacity") return await this.fence(stream, at);
			const frame: Frame = batch
				? { v: "usage-journal/1", sequence: this.sequence + 1, at, kind: "batch", batch, code }
				: {
						v: "usage-journal/1",
						sequence: this.sequence + 1,
						at,
						kind: "fault",
						stream: source ? stream : null,
						code: code!,
					};
			try {
				await this.persist(frame, plans);
			} catch (e) {
				if (e instanceof Reject && e.code === "store-capacity") return await this.fence(stream, at);
				throw e;
			}
			if (code === "index-unavailable") this.writable = false;
			return this.result(batch ? (code === null ? "committed" : "quarantined") : "rejected", stream, code);
		} catch (e) {
			this.writable = false;
			const reason = e instanceof Reject ? e.code : "io-failure";
			this.memoryFaults.push({ code: reason, stream: source ? stream : null, at });
			return this.result("unavailable", stream, reason);
		}
	}
	private async fence(stream: string, at: string): Promise<CollectorResult> {
		await this.persist(
			{
				v: "usage-journal/1",
				sequence: this.sequence + 1,
				at,
				kind: "fault",
				stream: this.sources!.sources.some((s) => s.stream === stream) ? stream : null,
				code: "store-capacity",
			},
			[],
			true,
		);
		this.writable = false;
		this.capacitySealed = true;
		return this.result("rejected", stream, "store-capacity");
	}
	/** Fault-bearing header; raw refs stay worker-private. No input()-only optimistic projection exists here. */
	async evidence(asOf: string): Promise<CollectorEvidence> {
		const pin = this.serial;
		await pin;
		const sequence = this.sequence;
		timestamp(asOf);
		const unique = new Map<CollectorEvidenceCode, Set<string>>();
		const add = (code: CollectorEvidenceCode, stream: string | null) => {
			const refs = unique.get(code) ?? new Set<string>();
			refs.add(stream ?? "collector");
			unique.set(code, refs);
		};
		for (const f of this.memoryFaults) add(f.code, f.stream);
		try {
			if (this.io && this.sources)
				for (const prefix of ["f:", "a:"])
					for await (const e of this.scan(prefix)) {
						requireValue(
							(e.value.kind === "fault" || e.value.kind === "quarantine") && CODES.has(e.value.code),
							"index-unavailable",
						);
						if (
							e.value.at <= asOf ||
							["store-capacity", "journal-corrupt", "checkpoint-corrupt", "journal-tail"].includes(e.value.code)
						)
							add(e.value.code, e.value.stream);
					}
		} catch {
			add("index-unavailable", null);
		}
		if (!this.sources?.complete) add("inventory-partial", null);
		if (this.capacitySealed) add("store-capacity", null);
		for (const s of this.sources?.sources ?? []) {
			if (s.adapterRef === null) add("source-unavailable", s.stream);
			if (s.retainedFrom === null || s.retainedFrom > this.week(asOf)) add("retention-gap", s.stream);
		}
		if (this.serial !== pin || this.sequence !== sequence || this.mutating) add("index-unavailable", null);
		const faultCounts = [...unique]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([code, refs]) => ({ code, count: refs.size }));
		const faults = faultCounts.map(({ code }) => ({
			code: `collector:${code}`,
			ref: unique.get(code)!.size === 1 ? unique.get(code)!.values().next().value! : "collector",
		}));
		return {
			v: "usage-collector-evidence/1",
			sequence: this.sequence,
			asOf,
			storage: !this.writable && !this.capacitySealed ? "unavailable" : faults.length ? "partial" : "healthy",
			inventoryComplete: this.sources?.complete ?? false,
			requiredStreams: this.sources?.sources.map((s) => s.stream).sort() ?? [],
			faults,
			faultCounts,
		};
	}
	/** Current week by default; "all" pages all retained numeric history. A changed generation aborts, never mixes.
	 * W5 must preserve this header/fault state and independent subject coverage on EVERY projection. */
	async *evidencePages(
		asOf: string,
		window: "current-week" | "all" = "current-week",
	): AsyncGenerator<CollectorEvidencePage> {
		const evidence = await this.evidence(asOf),
			sequence = evidence.sequence,
			pin = this.serial;
		const check = () =>
			requireValue(this.sequence === sequence && this.serial === pin && !this.mutating, "index-unavailable");
		let rows = emptyRows(),
			count = 0;
		const headerBytes = bytes(canonical({ v: "usage-collector-evidence-page/1", evidence, rows, coverage: [] })) + 16;
		requireValue(headerBytes < PAGE.maxBytes, "store-capacity");
		let size = headerBytes;
		const emit = (): CollectorEvidencePage => ({
			v: "usage-collector-evidence-page/1",
			evidence: structuredClone(evidence),
			rows,
			coverage: [],
		});
		if (!this.io || !this.sources) {
			yield emit();
			return;
		}
		const rowPages = async function* (c: PagedUsageAccountingCollector): AsyncGenerator<CollectorIndexEntry> {
			if (window === "all") {
				yield* c.scan("r:");
				return;
			}
			for (const prefix of [`e:${c.week(asOf)}:`, "e:metadata:"])
				for await (const e of c.scan(prefix)) {
					requireValue(e.value.kind === "node", "index-unavailable");
					yield* c.scan(`r:${e.value.component}:`);
				}
		};
		for await (const e of rowPages(this)) {
			check();
			requireValue(e.value.kind === "row", "index-unavailable");
			const n = bytes(canonical(e.value.row)) + 1;
			if (count >= PAGE.maxRows || size + n > PAGE.maxBytes) {
				yield emit();
				rows = emptyRows();
				count = 0;
				size = headerBytes;
			}
			requireValue(n + headerBytes <= PAGE.maxBytes, "store-capacity");
			pushRow(rows, e.value.rowKind, structuredClone(e.value.row));
			count++;
			size += n;
		}
		check();
		yield emit();
		let coverage: SourceCoverage[] = [];
		size = headerBytes;
		for await (const e of this.scan(`c:${this.week(asOf)}:`)) {
			check();
			requireValue(e.value.kind === "coverage", "index-unavailable");
			if (e.value.coverage.through < this.week(asOf)) continue;
			const n = bytes(canonical(e.value.coverage)) + 1;
			if (coverage.length >= PAGE.maxRows || size + n > PAGE.maxBytes) {
				yield {
					v: "usage-collector-evidence-page/1",
					evidence: structuredClone(evidence),
					rows: emptyRows(),
					coverage,
				};
				coverage = [];
				size = headerBytes;
			}
			requireValue(n + headerBytes <= PAGE.maxBytes, "store-capacity");
			coverage.push(structuredClone(e.value.coverage));
			size += n;
		}
		check();
		if (coverage.length)
			yield { v: "usage-collector-evidence-page/1", evidence: structuredClone(evidence), rows: emptyRows(), coverage };
	}
}
