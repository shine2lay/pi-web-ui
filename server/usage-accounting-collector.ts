/** Inert numeric collector. No filesystem/source adapter, importer, timer, root registry or budget authority. */
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
	| "collector-off";
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
function inventory(raw: unknown): SourceInventory {
	const v = closed(raw, ["v", "evidenceRef", "observedAt", "complete", "sources"]);
	requireValue(v.v === "usage-inventory/1" && typeof v.complete === "boolean");
	reference(v.evidenceRef);
	timestamp(v.observedAt);
	requireValue(Array.isArray(v.sources) && v.sources.length > 0 && v.sources.length <= COLLECTOR_LIMITS.sources);
	const streams = new Set<string>();
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
			Array.isArray(s.occurrenceStreams) &&
				s.occurrenceStreams.length > 0 &&
				s.occurrenceStreams.length <= COLLECTOR_LIMITS.sources,
		);
		for (const stream of s.occurrenceStreams) reference(stream);
		requireValue(new Set(s.occurrenceStreams).size === s.occurrenceStreams.length);
		requireValue(
			Array.isArray(s.grants) &&
				s.grants.every((k) => ROW_KEYS.includes(k)) &&
				new Set(s.grants).size === s.grants.length,
		);
		requireValue(!streams.has(s.stream));
		streams.add(s.stream);
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
function consistency(rows: NumericRows, tick: () => void): CollectorCode | null {
	function revisions<T extends { revision: number }>(values: T[], key: (row: T) => string): CollectorCode | null {
		const groups = new Map<string, Map<number, T>>();
		for (const row of values) {
			tick();
			const id = key(row);
			const versions = groups.get(id) ?? new Map<number, T>();
			const prior = versions.get(row.revision);
			if (prior && !same(prior, row)) return "revision-conflict";
			versions.set(row.revision, row);
			groups.set(id, versions);
		}
		for (const versions of groups.values()) {
			const max = Math.max(...versions.keys());
			if (versions.size !== max + 1) return "revision-gap";
		}
		return null;
	}
	const revisionFault = revisions(rows.facts, (f) => f.id) ?? revisions(rows.allocations, (a) => a.factId);
	if (revisionFault) return revisionFault;
	const originals = new Map(rows.facts.filter((f) => f.revision === 0).map((f) => [f.id, f]));
	const factVersions = new Map(rows.facts.map((f) => [canonical([f.id, f.revision]), f]));
	const allocationVersions = new Map(rows.allocations.map((a) => [canonical([a.factId, a.revision]), a]));
	for (const a of rows.allocations) {
		const prior = allocationVersions.get(canonical([a.factId, a.revision - 1]));
		if (prior && a.recordedAt < prior.recordedAt) return "revision-conflict";
	}
	const events = new Map<string, string>();
	for (const f of rows.facts) {
		tick();
		const original = originals.get(f.id)!;
		const prior = factVersions.get(canonical([f.id, f.revision - 1]));
		if (prior && f.source.observedAt < prior.source.observedAt) return "rewritten-occurrence";
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
			return "rewritten-occurrence";
		const event = canonical([f.identity.producer, f.identity.incarnation, f.source.stream, f.source.event]);
		if (events.has(event) && events.get(event) !== f.id) return "event-conflict";
		events.set(event, f.id);
		if (checkTaskBinding(f, rows.memberships) === "mismatch") return "binding-mismatch";
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
	if (
		!unique(rows.roots, (r) => r.ref) ||
		!unique(rows.policies, (p) => p.ref) ||
		!unique(rows.memberships, (m) => canonical([taskId(m), m.effectiveAt]))
	)
		return "metadata-conflict";
	if (!unique(rows.snapshots, (s) => canonical([s.producer, s.incarnation, s.run, s.observedAt])))
		return "snapshot-conflict";
	if (!unique(rows.aliases, (a) => a.aliasFactId)) return "alias-conflict";
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
			if (seen.has(id)) return "alias-conflict";
			seen.add(id);
			id = aliases.get(id)!;
		}
		if (!latest.has(id)) return "alias-conflict";
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
			return "alias-conflict";
		for (const f of group)
			if (
				f.occurredAt !== primary.occurredAt ||
				f.provider !== primary.provider ||
				f.model !== primary.model ||
				f.kind !== primary.kind
			)
				return "alias-conflict";
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
			if (new Set(group.map((f) => f.tokens[key]).filter((n) => n !== null)).size > 1) return "alias-conflict";
		for (const basis of ["list-estimate", "provider-reported", "invoice"])
			if (
				new Set(
					group.flatMap((f) =>
						f.prices.filter((p) => p.basis === basis && p.amount !== null).map((p) => addUsd([p.amount!])),
					),
				).size > 1
			)
				return "alias-conflict";
	}
	for (const a of rows.aliases)
		if (!latest.has(a.aliasFactId) || !latest.has(a.canonicalFactId)) return "alias-conflict";
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
]);
