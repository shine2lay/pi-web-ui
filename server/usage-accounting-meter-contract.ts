/** Closed scalar-only worker seam. Intentionally no imports (including type imports) from an engine or host. */
export const METER_LIMITS = Object.freeze({
	pageBytes: 262_144,
	pageRows: 256,
	segmentBytes: 1_048_576,
	unitWorkMs: 100,
	sliceMs: 25,
	sources: 1024,
	indexCacheBytes: 8 * 1024 * 1024,
	stagingBytes: 1024 * 1024,
	indexBytes: 1024 * 1024 * 1024,
	indexEntries: 2_000_000,
	lookupRows: 4096,
	lookupBytes: 4 * 1024 * 1024,
	journalBytes: 4 * 1024 * 1024 * 1024,
	segments: 4096,
	frames: 1_000_000,
	checkpointBytes: 512 * 1024,
	snapshotBytes: 262_144,
	subjects: 256,
	faultKinds: 64,
	staleAfterMs: 60_000,
	alarmAfterMs: 300_000,
	updateMs: 30_000,
	acceptedHeapBytes: 448 * 1024 * 1024,
	acceptedProcessRssBytes: 1280 * 1024 * 1024,
});
/** Operational isolation only; neither a spending limit nor permission. W6 must pass these to Worker. */
export const METER_WORKER_RESOURCE_LIMITS = Object.freeze({
	maxOldGenerationSizeMb: 512,
	maxYoungGenerationSizeMb: 32,
	codeRangeSizeMb: 16,
	stackSizeMb: 4,
});
export type MeterSubject =
	| { kind: "role"; role: string }
	| { kind: "initiative"; initiative: string }
	| { kind: "task"; queueKey: string; task: number; addedAt: string };
export const METER_FAULT_CODES = [
	"collector-off",
	"inventory-partial",
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
	"index-unavailable",
	"source-coverage",
	"coverage-conflict",
	"unpriced",
	"unallocated",
	"unresolved-identity",
	"invalid-subject-binding",
	"funding-unavailable",
	"unknown-accounting-fault",
	"worker-unavailable",
	"worker-stale",
	"source-stalled",
	"waiting-for-previous-writer",
] as const;
export type MeterFaultCode = (typeof METER_FAULT_CODES)[number];
export interface MeterFaultCount {
	code: MeterFaultCode;
	count: number;
}
/** No native stream name/path, feed token, exception or evidence reference may cross the port. */
export interface MeterCoveredSourceStatus {
	index: number;
	kind: "pi" | "acp" | "metadata";
	required: boolean;
	enabled: boolean;
	state: "complete" | "partial" | "unknown" | "unavailable";
	complete_through: string | null;
	observedAt: string | null;
	lastProgressAt: string | null;
	stalled: boolean;
	alarm: "source-stalled" | null;
}
/** S0: these diagnose the numeric frontier, never source completeness. */
export const METER_TEMPER_STALL_CODES = [
	"pending",
	"delayed",
	"drain-stalled",
	"dead-man",
	"off",
	"forbidden",
	"unavailable",
	"timeout",
	"malformed-page",
	"cursor-quarantined",
] as const;
export interface MeterTemperSourceStatus {
	index: number;
	kind: "temper";
	required: boolean;
	enabled: boolean;
	state: "available" | "unavailable";
	coverage: "unknown";
	observedAt: string | null;
	frontier: {
		diagnosticOnly: true;
		recorded_through: string | null;
		pending_count: number | null;
		oldest_pending: string | null;
		last_drain: string | null;
		/** Inspected interval only; not a coverage proof. */
		assessed_from: string | null;
		assessed_through: string | null;
		freshness: "fresh" | "delayed" | "stalled" | "dead-man" | "unknown";
		stallCodes: (typeof METER_TEMPER_STALL_CODES)[number][];
	};
}
export type MeterSourceStatus = MeterCoveredSourceStatus | MeterTemperSourceStatus;
/** Reader failure never advances a cursor; 409 preserves the old bytes in quarantine. */
export type MeterFeedFailure =
	| { status: 409; cursor: "quarantine"; coverage: "unknown"; fault: "source-unavailable" }
	| {
			status: "off" | 403 | 503 | "timeout" | "malformed-page";
			cursor: "retain";
			coverage: "unknown";
			fault: "source-unavailable";
	  };
export interface MeterSubjectSnapshot {
	subject: MeterSubject;
	window: { from: string; through: string };
	usageCoverage: "complete" | "partial" | "unavailable";
	fundingCoverage: "complete" | "partial" | "unavailable" | "not-evaluated";
	freshness: "fresh" | "stale" | "unknown";
	coveredThrough: string | null;
	observedAt: string | null;
	list: { grossObservations: string; deduplicatedRecorded: string } | null;
	otherBases: { basis: "provider-reported" | "invoice"; knownUsd: string; unpriced: number }[];
	counts: { unpriced: number | null; unresolvedIdentities: number | null };
	/** Only policy-wide, fresh, clean funding evidence may supply this neutral reporting remainder. */
	funding: {
		wholePolicySubject: boolean;
		verifiedOwnLowerBound: string;
		exempt: string;
		otherPolicy: string;
		unallocated: string;
		unallocatedFacts: number;
		remainingUsd: string | null;
	} | null;
	faults: MeterFaultCount[];
}
export interface UsageMeterSnapshot {
	v: "usage-meter-snapshot/1";
	reportingOnly: true;
	generation: { epoch: string; sequence: number };
	evaluatedAt: string;
	/** Pacific Monday date; the main-thread scalar health check must independently reject an old week. */
	weekStart: string;
	state: "ready" | "recovering" | "stale" | "unavailable" | "waiting-for-previous-writer";
	storage: "healthy" | "partial" | "unavailable";
	inventory: "complete" | "partial" | "unavailable";
	oldestCoveredThrough: string | null;
	oldestObservedAt: string | null;
	sources: MeterSourceStatus[];
	subjects: MeterSubjectSnapshot[];
	faults: MeterFaultCount[];
}
export type MeterHostMessage = {
	v: "usage-meter-command/1";
	kind: "evaluate";
	request: number;
	asOf: string;
};
export type MeterWorkerMessage =
	| UsageMeterSnapshot
	| {
			v: "usage-meter-health/1";
			epoch: string;
			at: string;
			state: "recovering" | "unavailable" | "waiting-for-previous-writer";
			code: "worker-unavailable" | "waiting-for-previous-writer" | "store-capacity" | "index-unavailable";
	  };
/** Worker-private metadata. Tokens are opaque bytes-as-text, NOT ordinal/seq or occurrence watermarks. */
export type MeterNativeCursor =
	| {
			kind: "file";
			stream: string;
			incarnation: string;
			ordinal: number;
			byte: number;
			line: number;
			headerSha256: string;
			anchor: { start: number; bytes: number; sha256: string };
	  }
	| {
			kind: "feed";
			stream: string;
			readerEpoch: string;
			token: string;
			state: "committed" | "quarantined";
	  };
/** Derived index only. Replay must prove this exact journal prefix before any cursor is exposed. */
export interface MeterIndexCheckpoint {
	v: "usage-meter-index/1";
	storeMajor: 1;
	generation: string;
	sequence: number;
	journal: { segment: number; byte: number; sha256: string };
	index: { generation: string; sequence: number; sha256: string };
	cursors: MeterNativeCursor[];
}

const object = (v: unknown): v is Record<string, unknown> => {
	if (!v || typeof v !== "object" || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) return false;
	return Reflect.ownKeys(v).every(
		(k) =>
			typeof k === "string" &&
			Object.getOwnPropertyDescriptor(v, k)?.enumerable === true &&
			Object.hasOwn(Object.getOwnPropertyDescriptor(v, k)!, "value"),
	);
};
function closed(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
	return object(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
}
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const hex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v) && v.length <= 60;
const reference = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_./:@+-]{1,256}$/.test(v);
const time = (v: unknown): v is string =>
	typeof v === "string" &&
	/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
	Number.isFinite(Date.parse(v)) &&
	new Date(v).toISOString() === v;
const nullableTime = (v: unknown): boolean => v === null || time(v);
const usd = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9]\d{0,17})(?:\.\d{1,12})?$/.test(v);
const oneOf = (v: unknown, choices: readonly unknown[]) => choices.includes(v);
function list(v: unknown, cap: number, check: (item: unknown) => boolean): v is unknown[] {
	return (
		Array.isArray(v) &&
		v.length <= cap &&
		Reflect.ownKeys(v).length === v.length + 1 &&
		Object.keys(v).every((k, i) => k === String(i) && Object.hasOwn(Object.getOwnPropertyDescriptor(v, k)!, "value")) &&
		v.every(check)
	);
}
function faults(v: unknown): v is MeterFaultCount[] {
	return (
		list(
			v,
			METER_LIMITS.faultKinds,
			(f) => closed(f, ["code", "count"]) && oneOf(f.code, METER_FAULT_CODES) && uint(f.count) && f.count > 0,
		) && new Set((v as MeterFaultCount[]).map((f) => f.code)).size === v.length
	);
}
function subject(v: unknown): boolean {
	if (!object(v)) return false;
	if (v.kind === "role") return closed(v, ["kind", "role"]) && id(v.role);
	if (v.kind === "initiative") return closed(v, ["kind", "initiative"]) && id(v.initiative);
	return (
		v.kind === "task" &&
		closed(v, ["kind", "queueKey", "task", "addedAt"]) &&
		hex(v.queueKey) &&
		uint(v.task) &&
		v.task > 0 &&
		time(v.addedAt)
	);
}
function source(v: unknown, at: string): boolean {
	if (object(v) && v.kind === "temper") {
		if (
			!closed(v, ["index", "kind", "required", "enabled", "state", "coverage", "observedAt", "frontier"]) ||
			!uint(v.index) ||
			v.index >= METER_LIMITS.sources ||
			typeof v.required !== "boolean" ||
			typeof v.enabled !== "boolean" ||
			!oneOf(v.state, ["available", "unavailable"]) ||
			v.coverage !== "unknown" ||
			!nullableTime(v.observedAt) ||
			(v.observedAt !== null && String(v.observedAt) > at) ||
			(!v.enabled && v.state !== "unavailable")
		)
			return false;
		const f = v.frontier;
		if (
			!closed(f, [
				"diagnosticOnly",
				"recorded_through",
				"pending_count",
				"oldest_pending",
				"last_drain",
				"assessed_from",
				"assessed_through",
				"freshness",
				"stallCodes",
			]) ||
			f.diagnosticOnly !== true ||
			![f.recorded_through, f.oldest_pending, f.last_drain, f.assessed_from, f.assessed_through].every(
				(t) => nullableTime(t) && (t === null || String(t) <= at),
			) ||
			(f.pending_count !== null && !uint(f.pending_count)) ||
			(f.pending_count === 0 && f.oldest_pending !== null) ||
			(f.assessed_from === null) !== (f.assessed_through === null) ||
			(f.assessed_from !== null && String(f.assessed_from) > String(f.assessed_through)) ||
			!oneOf(f.freshness, ["fresh", "delayed", "stalled", "dead-man", "unknown"]) ||
			!list(f.stallCodes, METER_TEMPER_STALL_CODES.length, (c) => oneOf(c, METER_TEMPER_STALL_CODES)) ||
			new Set(f.stallCodes).size !== f.stallCodes.length
		)
			return false;
		return (
			f.freshness !== "fresh" ||
			(v.enabled &&
				v.state === "available" &&
				v.observedAt !== null &&
				Date.parse(at) - Date.parse(String(v.observedAt)) <= METER_LIMITS.staleAfterMs)
		);
	}
	if (
		!closed(v, [
			"index",
			"kind",
			"required",
			"enabled",
			"state",
			"complete_through",
			"observedAt",
			"lastProgressAt",
			"stalled",
			"alarm",
		])
	)
		return false;
	if (
		!uint(v.index) ||
		v.index >= METER_LIMITS.sources ||
		!oneOf(v.kind, ["pi", "acp", "metadata"]) ||
		typeof v.required !== "boolean" ||
		typeof v.enabled !== "boolean" ||
		typeof v.stalled !== "boolean" ||
		!oneOf(v.state, ["complete", "partial", "unknown", "unavailable"])
	)
		return false;
	if (
		![v.complete_through, v.observedAt, v.lastProgressAt].every(
			(t) => nullableTime(t) && (t === null || String(t) <= at),
		)
	)
		return false;
	if (v.complete_through !== null && (v.observedAt === null || String(v.complete_through) > String(v.observedAt)))
		return false;
	const alarmDue =
		v.required &&
		v.enabled &&
		v.lastProgressAt !== null &&
		Date.parse(at) - Date.parse(String(v.lastProgressAt)) >= METER_LIMITS.alarmAfterMs;
	if (
		!oneOf(v.alarm, [null, "source-stalled"]) ||
		(v.alarm !== null && (!v.required || !v.enabled || !v.stalled || !alarmDue)) ||
		(alarmDue && (v.alarm !== "source-stalled" || !v.stalled))
	)
		return false;
	if (!v.enabled && v.state !== "unavailable") return false;
	return (
		v.state !== "complete" ||
		(v.enabled && !v.stalled && v.complete_through !== null && v.observedAt !== null && v.lastProgressAt !== null)
	);
}
function subjectKey(s: MeterSubject): string {
	return s.kind === "role"
		? JSON.stringify([s.kind, s.role])
		: s.kind === "initiative"
			? JSON.stringify([s.kind, s.initiative])
			: JSON.stringify([s.kind, s.queueKey, s.task, s.addedAt]);
}
function entry(
	v: unknown,
	at: string,
	healthy: boolean,
	covered: string | null,
	observed: string | null,
	canBeFresh: boolean,
): boolean {
	if (
		!closed(v, [
			"subject",
			"window",
			"usageCoverage",
			"fundingCoverage",
			"freshness",
			"coveredThrough",
			"observedAt",
			"list",
			"otherBases",
			"counts",
			"funding",
			"faults",
		]) ||
		!subject(v.subject)
	)
		return false;
	if (
		(v.subject as MeterSubject).kind === "task" &&
		(v.subject as Extract<MeterSubject, { kind: "task" }>).addedAt > at
	)
		return false;
	if (
		!closed(v.window, ["from", "through"]) ||
		!time(v.window.from) ||
		!time(v.window.through) ||
		v.window.from > v.window.through ||
		v.window.through > at
	)
		return false;
	if (
		!oneOf(v.usageCoverage, ["complete", "partial", "unavailable"]) ||
		!oneOf(v.fundingCoverage, ["complete", "partial", "unavailable", "not-evaluated"]) ||
		!oneOf(v.freshness, ["fresh", "stale", "unknown"])
	)
		return false;
	if (
		![v.coveredThrough, v.observedAt].every((t) => nullableTime(t) && (t === null || String(t) <= at)) ||
		!faults(v.faults)
	)
		return false;
	if (v.coveredThrough !== null && (v.observedAt === null || String(v.coveredThrough) > String(v.observedAt)))
		return false;
	if (
		v.freshness === "fresh" &&
		(!canBeFresh ||
			v.observedAt === null ||
			Date.parse(at) - Date.parse(String(v.observedAt)) > METER_LIMITS.staleAfterMs)
	)
		return false;
	if (
		v.list !== null &&
		(!closed(v.list, ["grossObservations", "deduplicatedRecorded"]) ||
			!usd(v.list.grossObservations) ||
			!usd(v.list.deduplicatedRecorded))
	)
		return false;
	if (
		!list(
			v.otherBases,
			2,
			(b) =>
				closed(b, ["basis", "knownUsd", "unpriced"]) &&
				oneOf(b.basis, ["provider-reported", "invoice"]) &&
				usd(b.knownUsd) &&
				uint(b.unpriced),
		)
	)
		return false;
	if (new Set(v.otherBases.map((b) => (b as { basis: string }).basis)).size !== v.otherBases.length) return false;
	if (
		!closed(v.counts, ["unpriced", "unresolvedIdentities"]) ||
		![v.counts.unpriced, v.counts.unresolvedIdentities].every((n) => n === null || uint(n))
	)
		return false;
	const complete =
		healthy &&
		v.freshness === "fresh" &&
		covered !== null &&
		observed !== null &&
		v.coveredThrough !== null &&
		String(v.coveredThrough) >= v.window.through &&
		String(v.coveredThrough) <= covered &&
		v.observedAt !== null &&
		String(v.observedAt) <= observed &&
		Date.parse(at) - Date.parse(String(v.observedAt)) <= METER_LIMITS.staleAfterMs &&
		v.list !== null &&
		v.counts.unpriced === 0 &&
		v.counts.unresolvedIdentities === 0 &&
		v.faults.length === 0;
	if (v.usageCoverage === "complete" && !complete) return false;
	if (v.funding === null) return v.fundingCoverage !== "complete";
	if (
		!closed(v.funding, [
			"wholePolicySubject",
			"verifiedOwnLowerBound",
			"exempt",
			"otherPolicy",
			"unallocated",
			"unallocatedFacts",
			"remainingUsd",
		]) ||
		typeof v.funding.wholePolicySubject !== "boolean" ||
		![v.funding.verifiedOwnLowerBound, v.funding.exempt, v.funding.otherPolicy, v.funding.unallocated].every(usd) ||
		!uint(v.funding.unallocatedFacts) ||
		(v.funding.remainingUsd !== null && !usd(v.funding.remainingUsd))
	)
		return false;
	if (v.fundingCoverage === "not-evaluated" || v.fundingCoverage === "unavailable") return false;
	if (
		v.fundingCoverage === "complete" &&
		(!complete || v.usageCoverage !== "complete" || v.funding.unallocatedFacts !== 0)
	)
		return false;
	return (
		v.funding.remainingUsd === null ||
		(complete &&
			v.usageCoverage === "complete" &&
			v.fundingCoverage === "complete" &&
			v.funding.wholePolicySubject &&
			v.funding.unallocatedFacts === 0)
	);
}
function snapshot(v: unknown): v is UsageMeterSnapshot {
	if (
		!closed(v, [
			"v",
			"reportingOnly",
			"generation",
			"evaluatedAt",
			"weekStart",
			"state",
			"storage",
			"inventory",
			"oldestCoveredThrough",
			"oldestObservedAt",
			"sources",
			"subjects",
			"faults",
		]) ||
		v.v !== "usage-meter-snapshot/1" ||
		v.reportingOnly !== true
	)
		return false;
	if (
		!closed(v.generation, ["epoch", "sequence"]) ||
		!hex(v.generation.epoch) ||
		!uint(v.generation.sequence) ||
		!time(v.evaluatedAt) ||
		typeof v.weekStart !== "string" ||
		!/^\d{4}-\d\d-\d\d$/.test(v.weekStart) ||
		!time(`${v.weekStart}T00:00:00.000Z`) ||
		new Date(`${v.weekStart}T00:00:00.000Z`).getUTCDay() !== 1
	)
		return false;
	if (
		!oneOf(v.state, ["ready", "recovering", "stale", "unavailable", "waiting-for-previous-writer"]) ||
		!oneOf(v.storage, ["healthy", "partial", "unavailable"]) ||
		!oneOf(v.inventory, ["complete", "partial", "unavailable"]) ||
		!faults(v.faults)
	)
		return false;
	if (
		![v.oldestCoveredThrough, v.oldestObservedAt].every(
			(t) => nullableTime(t) && (t === null || String(t) <= String(v.evaluatedAt)),
		)
	)
		return false;
	if (!list(v.sources, METER_LIMITS.sources, (s) => source(s, String(v.evaluatedAt)))) return false;
	const sources = v.sources as unknown as MeterSourceStatus[];
	if (new Set(sources.map((s) => s.index)).size !== sources.length) return false;
	const required = sources.filter((s) => s.required);
	for (const [field, outer] of [
		["complete_through", "oldestCoveredThrough"],
		["observedAt", "oldestObservedAt"],
	] as const) {
		const values = required.map((s) =>
			field === "observedAt" ? s.observedAt : s.kind === "temper" ? null : s.complete_through,
		);
		const oldest = values.length && values.every((t) => t !== null) ? values.sort()[0] : null;
		if (v[outer] !== oldest) return false;
	}
	const healthy =
		v.state === "ready" &&
		v.storage === "healthy" &&
		v.inventory === "complete" &&
		v.faults.length === 0 &&
		required.length > 0 &&
		required.every((s) => s.state === "complete");
	return (
		list(v.subjects, METER_LIMITS.subjects, (s) =>
			entry(
				s,
				String(v.evaluatedAt),
				healthy,
				v.oldestCoveredThrough as string | null,
				v.oldestObservedAt as string | null,
				v.state === "ready" && v.storage !== "unavailable",
			),
		) &&
		new Set((v.subjects as unknown as MeterSubjectSnapshot[]).map((s) => subjectKey(s.subject))).size ===
			v.subjects.length
	);
}
/** Bounded wire JSON parser: reject length before parsing; never return an exception or invalid input. */
export function parseMeterWorkerMessage(text: string): MeterWorkerMessage | null {
	try {
		if (typeof text !== "string" || Buffer.byteLength(text) > METER_LIMITS.snapshotBytes) return null;
		const v: unknown = JSON.parse(text);
		if (snapshot(v)) return v;
		if (
			closed(v, ["v", "epoch", "at", "state", "code"]) &&
			v.v === "usage-meter-health/1" &&
			hex(v.epoch) &&
			time(v.at) &&
			oneOf(v.state, ["recovering", "unavailable", "waiting-for-previous-writer"]) &&
			oneOf(v.code, ["worker-unavailable", "waiting-for-previous-writer", "store-capacity", "index-unavailable"])
		)
			return v as unknown as MeterWorkerMessage;
	} catch {
		/* fixed unavailable result, not a raw exception */
	}
	return null;
}
/** postMessage structured clones are checked before being copied or cached. */
export function validateMeterSnapshot(value: unknown): UsageMeterSnapshot | null {
	try {
		if (!snapshot(value)) return null;
		const text = JSON.stringify(value);
		return Buffer.byteLength(text) <= METER_LIMITS.snapshotBytes ? (JSON.parse(text) as UsageMeterSnapshot) : null;
	} catch {
		return null;
	}
}
export function parseMeterHostMessage(value: unknown): MeterHostMessage | null {
	try {
		return closed(value, ["v", "kind", "request", "asOf"]) &&
			value.v === "usage-meter-command/1" &&
			value.kind === "evaluate" &&
			uint(value.request) &&
			time(value.asOf)
			? { v: value.v, kind: value.kind, request: value.request, asOf: value.asOf }
			: null;
	} catch {
		return null;
	}
}
/** Private cursor metadata is never accepted as a public snapshot. A reset/409 preserves it for quarantine. */
export function validateMeterIndexCheckpoint(v: unknown): MeterIndexCheckpoint | null {
	try {
		if (
			!closed(v, ["v", "storeMajor", "generation", "sequence", "journal", "index", "cursors"]) ||
			v.v !== "usage-meter-index/1" ||
			v.storeMajor !== 1 ||
			!hex(v.generation) ||
			!uint(v.sequence)
		)
			return null;
		if (
			!closed(v.journal, ["segment", "byte", "sha256"]) ||
			!uint(v.journal.segment) ||
			v.journal.segment < 1 ||
			v.journal.segment > METER_LIMITS.segments ||
			!uint(v.journal.byte) ||
			v.journal.byte > METER_LIMITS.segmentBytes ||
			!hex(v.journal.sha256)
		)
			return null;
		if (
			!closed(v.index, ["generation", "sequence", "sha256"]) ||
			!hex(v.index.generation) ||
			v.index.sequence !== v.sequence ||
			!hex(v.index.sha256)
		)
			return null;
		if (
			!list(v.cursors, METER_LIMITS.sources, (c) => {
				if (!object(c) || !reference(c.stream)) return false;
				if (c.kind === "feed")
					return (
						closed(c, ["kind", "stream", "readerEpoch", "token", "state"]) &&
						typeof c.readerEpoch === "string" &&
						c.readerEpoch.length > 0 &&
						c.readerEpoch.length <= 256 &&
						typeof c.token === "string" &&
						c.token.length > 0 &&
						c.token.length <= 256 &&
						oneOf(c.state, ["committed", "quarantined"])
					);
				return (
					c.kind === "file" &&
					reference(c.incarnation) &&
					uint(c.ordinal) &&
					closed(c, ["kind", "stream", "incarnation", "ordinal", "byte", "line", "headerSha256", "anchor"]) &&
					uint(c.byte) &&
					uint(c.line) &&
					hex(c.headerSha256) &&
					closed(c.anchor, ["start", "bytes", "sha256"]) &&
					uint(c.anchor.start) &&
					uint(c.anchor.bytes) &&
					c.anchor.bytes <= METER_LIMITS.pageBytes &&
					c.anchor.start + c.anchor.bytes === c.byte &&
					hex(c.anchor.sha256)
				);
			})
		)
			return null;
		if (new Set((v.cursors as unknown as MeterNativeCursor[]).map((c) => c.stream)).size !== v.cursors.length)
			return null;
		const text = JSON.stringify(v);
		return Buffer.byteLength(text) <= METER_LIMITS.checkpointBytes ? (JSON.parse(text) as MeterIndexCheckpoint) : null;
	} catch {
		return null;
	}
}
