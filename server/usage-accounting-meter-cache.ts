/** Main-thread boundary: only bounded wire validation, replacement and scalar health. No runtime imports. */
import type {
	MeterFaultCode,
	MeterSubject,
	MeterSubjectSnapshot,
	MeterWorkerMessage,
	UsageMeterSnapshot,
} from "./usage-accounting-meter-contract.js";

// Deliberately local wire constants; parity with the frozen W0 validator is a fixed regression.
const BYTES = 262_144;
const AGE = 60_000;
const ALARM = 300_000;
const CODES: readonly MeterFaultCode[] = [
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
];
const STALLS = [
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
];
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const closed = (v: unknown, keys: string): v is Record<string, unknown> =>
	object(v) && Object.keys(v).sort().join(",") === keys.split(" ").sort().join(",");
const choice = (v: unknown, choices: readonly unknown[]) => choices.includes(v);
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const hex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const time = (v: unknown): v is string =>
	typeof v === "string" &&
	/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
	Number.isFinite(Date.parse(v)) &&
	new Date(v).toISOString() === v;
const optionalTime = (v: unknown) => v === null || time(v);
const usd = (v: unknown) => typeof v === "string" && /^(0|[1-9]\d{0,17})(?:\.\d{1,12})?$/.test(v);
const id = (v: unknown) => typeof v === "string" && v.length <= 60 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v);
const list = (v: unknown, max: number, valid: (v: unknown) => boolean): v is unknown[] =>
	Array.isArray(v) && v.length <= max && v.every(valid);
const times = (vs: unknown[], at: string) => vs.every((t) => optionalTime(t) && (t === null || String(t) <= at));
function faults(v: unknown): boolean {
	return (
		list(v, 64, (f) => closed(f, "code count") && choice(f.code, CODES) && uint(f.count) && f.count > 0) &&
		new Set(v.map((f) => (f as { code: string }).code)).size === v.length
	);
}
function subject(v: unknown): boolean {
	return (
		object(v) &&
		(v.kind === "role"
			? closed(v, "kind role") && id(v.role)
			: v.kind === "initiative"
				? closed(v, "kind initiative") && id(v.initiative)
				: v.kind === "task" &&
					closed(v, "kind queueKey task addedAt") &&
					hex(v.queueKey) &&
					uint(v.task) &&
					v.task > 0 &&
					time(v.addedAt))
	);
}
function key(v: MeterSubject): string {
	return v.kind === "role"
		? `role:${v.role}`
		: v.kind === "initiative"
			? `initiative:${v.initiative}`
			: JSON.stringify([v.kind, v.queueKey, v.task, v.addedAt]);
}
function source(v: unknown, at: string): boolean {
	if (
		!object(v) ||
		!uint(v.index) ||
		v.index >= 1024 ||
		typeof v.required !== "boolean" ||
		typeof v.enabled !== "boolean"
	)
		return false;
	if (v.kind === "temper") {
		if (
			!closed(v, "index kind required enabled state coverage observedAt frontier") ||
			!choice(v.state, ["available", "unavailable"]) ||
			v.coverage !== "unknown" ||
			!times([v.observedAt], at) ||
			(!v.enabled && v.state !== "unavailable")
		)
			return false;
		const f = v.frontier;
		if (
			!closed(
				f,
				"diagnosticOnly recorded_through pending_count oldest_pending last_drain assessed_from assessed_through freshness stallCodes",
			) ||
			f.diagnosticOnly !== true ||
			!times([f.recorded_through, f.oldest_pending, f.last_drain, f.assessed_from, f.assessed_through], at) ||
			(f.pending_count !== null && !uint(f.pending_count)) ||
			(f.pending_count === 0 && f.oldest_pending !== null) ||
			(f.assessed_from === null) !== (f.assessed_through === null) ||
			(f.assessed_from !== null && String(f.assessed_from) > String(f.assessed_through)) ||
			!choice(f.freshness, ["fresh", "delayed", "stalled", "dead-man", "unknown"]) ||
			!list(f.stallCodes, STALLS.length, (c) => choice(c, STALLS)) ||
			new Set(f.stallCodes).size !== f.stallCodes.length
		)
			return false;
		return (
			f.freshness !== "fresh" ||
			(v.enabled &&
				v.state === "available" &&
				v.observedAt !== null &&
				Date.parse(at) - Date.parse(String(v.observedAt)) <= AGE)
		);
	}
	if (
		!closed(v, "index kind required enabled state complete_through observedAt lastProgressAt stalled alarm") ||
		!choice(v.kind, ["pi", "acp", "metadata"]) ||
		typeof v.stalled !== "boolean" ||
		!choice(v.state, ["complete", "partial", "unknown", "unavailable"]) ||
		!times([v.complete_through, v.observedAt, v.lastProgressAt], at) ||
		(v.complete_through !== null && (v.observedAt === null || String(v.complete_through) > String(v.observedAt)))
	)
		return false;
	const due =
		v.required &&
		v.enabled &&
		v.lastProgressAt !== null &&
		Date.parse(at) - Date.parse(String(v.lastProgressAt)) >= ALARM;
	return (
		choice(v.alarm, [null, "source-stalled"]) &&
		!(v.alarm !== null && (!v.required || !v.enabled || !v.stalled || !due)) &&
		!(due && (v.alarm !== "source-stalled" || !v.stalled)) &&
		!(!v.enabled && v.state !== "unavailable") &&
		(v.state !== "complete" ||
			(v.enabled && !v.stalled && v.complete_through !== null && v.observedAt !== null && v.lastProgressAt !== null))
	);
}
function entry(
	raw: unknown,
	at: string,
	healthy: boolean,
	covered: string | null,
	observed: string | null,
	canBeFresh: boolean,
): boolean {
	if (
		!closed(
			raw,
			"subject window usageCoverage fundingCoverage freshness coveredThrough observedAt list otherBases counts funding faults",
		) ||
		!subject(raw.subject)
	)
		return false;
	const v = raw as unknown as MeterSubjectSnapshot;
	if (v.subject.kind === "task" && v.subject.addedAt > at) return false;
	if (
		!closed(v.window, "from through") ||
		!time(v.window.from) ||
		!time(v.window.through) ||
		v.window.from > v.window.through ||
		v.window.through > at ||
		!choice(v.usageCoverage, ["complete", "partial", "unavailable"]) ||
		!choice(v.fundingCoverage, ["complete", "partial", "unavailable", "not-evaluated"]) ||
		!choice(v.freshness, ["fresh", "stale", "unknown"]) ||
		!times([v.coveredThrough, v.observedAt], at) ||
		!faults(v.faults)
	)
		return false;
	if (v.coveredThrough !== null && (v.observedAt === null || v.coveredThrough > v.observedAt)) return false;
	if (
		v.freshness === "fresh" &&
		(!canBeFresh || v.observedAt === null || Date.parse(at) - Date.parse(v.observedAt) > AGE)
	)
		return false;
	if (
		v.list !== null &&
		(!closed(v.list, "grossObservations deduplicatedRecorded") ||
			!usd(v.list.grossObservations) ||
			!usd(v.list.deduplicatedRecorded))
	)
		return false;
	if (
		!list(
			v.otherBases,
			2,
			(b) =>
				closed(b, "basis knownUsd unpriced") &&
				choice(b.basis, ["provider-reported", "invoice"]) &&
				usd(b.knownUsd) &&
				uint(b.unpriced),
		) ||
		new Set(v.otherBases.map((b) => b.basis)).size !== v.otherBases.length ||
		!closed(v.counts, "unpriced unresolvedIdentities") ||
		![v.counts.unpriced, v.counts.unresolvedIdentities].every((n) => n === null || uint(n))
	)
		return false;
	const complete =
		healthy &&
		v.freshness === "fresh" &&
		covered !== null &&
		observed !== null &&
		v.coveredThrough !== null &&
		v.coveredThrough >= v.window.through &&
		v.coveredThrough <= covered &&
		v.observedAt !== null &&
		v.observedAt <= observed &&
		Date.parse(at) - Date.parse(v.observedAt) <= AGE &&
		v.list !== null &&
		v.counts.unpriced === 0 &&
		v.counts.unresolvedIdentities === 0 &&
		v.faults.length === 0;
	if (v.usageCoverage === "complete" && !complete) return false;
	const f = v.funding;
	if (f === null) return v.fundingCoverage !== "complete";
	return (
		closed(
			f,
			"wholePolicySubject verifiedOwnLowerBound exempt otherPolicy unallocated unallocatedFacts remainingUsd",
		) &&
		typeof f.wholePolicySubject === "boolean" &&
		[f.verifiedOwnLowerBound, f.exempt, f.otherPolicy, f.unallocated].every(usd) &&
		uint(f.unallocatedFacts) &&
		(f.remainingUsd === null || usd(f.remainingUsd)) &&
		!choice(v.fundingCoverage, ["not-evaluated", "unavailable"]) &&
		!(v.fundingCoverage === "complete" && (!complete || v.usageCoverage !== "complete" || f.unallocatedFacts !== 0)) &&
		(f.remainingUsd === null ||
			(complete &&
				v.usageCoverage === "complete" &&
				v.fundingCoverage === "complete" &&
				f.wholePolicySubject &&
				f.unallocatedFacts === 0))
	);
}
function snapshot(raw: unknown): raw is UsageMeterSnapshot {
	if (
		!closed(
			raw,
			"v reportingOnly generation evaluatedAt weekStart state storage inventory oldestCoveredThrough oldestObservedAt sources subjects faults",
		) ||
		raw.v !== "usage-meter-snapshot/1" ||
		raw.reportingOnly !== true ||
		!closed(raw.generation, "epoch sequence") ||
		!hex(raw.generation.epoch) ||
		!uint(raw.generation.sequence) ||
		!time(raw.evaluatedAt) ||
		typeof raw.weekStart !== "string" ||
		!/^\d{4}-\d\d-\d\d$/.test(raw.weekStart) ||
		!time(`${raw.weekStart}T00:00:00.000Z`) ||
		new Date(`${raw.weekStart}T00:00:00.000Z`).getUTCDay() !== 1 ||
		!choice(raw.state, ["ready", "recovering", "stale", "unavailable", "waiting-for-previous-writer"]) ||
		!choice(raw.storage, ["healthy", "partial", "unavailable"]) ||
		!choice(raw.inventory, ["complete", "partial", "unavailable"]) ||
		!faults(raw.faults) ||
		!times([raw.oldestCoveredThrough, raw.oldestObservedAt], raw.evaluatedAt) ||
		!list(raw.sources, 1024, (s) => source(s, String(raw.evaluatedAt)))
	)
		return false;
	const v = raw as unknown as UsageMeterSnapshot;
	if (new Set(v.sources.map((s) => s.index)).size !== v.sources.length) return false;
	const required = v.sources.filter((s) => s.required);
	for (const field of ["complete_through", "observedAt"] as const) {
		const values = required.map((s) =>
			field === "observedAt" ? s.observedAt : s.kind === "temper" ? null : s.complete_through,
		);
		const oldest = values.length && values.every((t) => t !== null) ? values.sort()[0] : null;
		if (v[field === "observedAt" ? "oldestObservedAt" : "oldestCoveredThrough"] !== oldest) return false;
	}
	const healthy =
		v.state === "ready" &&
		v.storage === "healthy" &&
		v.inventory === "complete" &&
		!v.faults.length &&
		required.length > 0 &&
		required.every((s) => s.state === "complete");
	return (
		list(v.subjects, 256, (s) =>
			entry(
				s,
				v.evaluatedAt,
				healthy,
				v.oldestCoveredThrough,
				v.oldestObservedAt,
				v.state === "ready" && v.storage !== "unavailable",
			),
		) && new Set(v.subjects.map((s) => key(s.subject))).size === v.subjects.length
	);
}
function parse(text: unknown): MeterWorkerMessage | null {
	if (typeof text !== "string" || Buffer.byteLength(text) > BYTES) return null;
	try {
		const v: unknown = JSON.parse(text);
		if (snapshot(v)) return v;
		return closed(v, "v epoch at state code") &&
			v.v === "usage-meter-health/1" &&
			hex(v.epoch) &&
			time(v.at) &&
			choice(v.state, ["recovering", "unavailable", "waiting-for-previous-writer"]) &&
			choice(v.code, ["worker-unavailable", "waiting-for-previous-writer", "store-capacity", "index-unavailable"])
			? (v as unknown as MeterWorkerMessage)
			: null;
	} catch {
		return null;
	}
}
const pacific = new Intl.DateTimeFormat("en-CA", {
	timeZone: "America/Los_Angeles",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});
function week(at: string): string {
	const parts = pacific.formatToParts(new Date(at));
	const part = (name: string) => parts.find((p) => p.type === name)!.value;
	const day = new Date(`${part("year")}-${part("month")}-${part("day")}T00:00:00.000Z`);
	day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
	return day.toISOString().slice(0, 10);
}
function addFault(v: { faults: { code: MeterFaultCode; count: number }[] }, code: MeterFaultCode): void {
	if (!v.faults.some((f) => f.code === code)) v.faults.push({ code, count: 1 });
	v.faults.sort((a, b) => a.code.localeCompare(b.code));
}
/** Caller-owned; constructing/importing starts nothing. Wire strings only, exactly like W0's parser. */
export function createUsageMeterCache() {
	let epoch: string | null = null;
	let current: UsageMeterSnapshot | null = null;
	let sequence = -1;
	let health: Exclude<MeterWorkerMessage, UsageMeterSnapshot> | null = null;
	function get(asOf: string): UsageMeterSnapshot | null {
		if (!current || !time(asOf)) return null;
		const v = structuredClone(current);
		const expired =
			asOf < v.evaluatedAt ||
			week(asOf) !== v.weekStart ||
			[v.evaluatedAt, v.oldestCoveredThrough, v.oldestObservedAt].some(
				(t) => t !== null && Date.parse(asOf) - Date.parse(t) > AGE,
			);
		if (health || expired) {
			v.state = health?.state ?? "stale";
			const code = health?.code ?? "worker-stale";
			addFault(v, code);
			for (const s of v.subjects) {
				if (s.usageCoverage === "complete") s.usageCoverage = "partial";
				if (s.fundingCoverage === "complete") s.fundingCoverage = "partial";
				s.freshness = expired ? "stale" : "unknown";
				if (s.funding) s.funding.remainingUsd = null;
				addFault(s, code);
			}
		}
		return v;
	}
	return {
		activateEpoch(next: string): boolean {
			if (!hex(next)) return false;
			if (epoch !== next) {
				epoch = next;
				current = null;
				sequence = -1;
				health = null;
			}
			return true;
		},
		accept(text: unknown): boolean {
			const value = parse(text);
			if (!value || epoch === null) return false;
			if (value.v === "usage-meter-health/1") {
				if (value.epoch !== epoch || (current && value.at < current.evaluatedAt) || (health && value.at < health.at))
					return false;
				health = value;
				return true;
			}
			if (
				value.generation.epoch !== epoch ||
				value.generation.sequence <= sequence ||
				(current && value.evaluatedAt < current.evaluatedAt) ||
				(health && value.evaluatedAt < health.at)
			)
				return false;
			current = value;
			sequence = value.generation.sequence;
			health = null;
			return true;
		},
		get,
		getRole(role: string, asOf: string): MeterSubjectSnapshot | null {
			const snapshot = get(asOf);
			const subject = snapshot?.subjects.find((s) => s.subject.kind === "role" && s.subject.role === role);
			if (!snapshot || !subject) return null;
			for (const shared of snapshot.faults) {
				const existing = subject.faults.find((f) => f.code === shared.code);
				if (existing) existing.count = Math.max(existing.count, shared.count);
				else subject.faults.push({ ...shared });
			}
			subject.faults.sort((a, b) => a.code.localeCompare(b.code));
			return subject;
		},
	};
}
