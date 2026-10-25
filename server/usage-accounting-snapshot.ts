/** Worker-only pure fold. Never import from a main-thread entry point or the meter cache. */
import { createHash } from "node:crypto";
import {
	checkTaskBinding,
	observeUsage,
	pacificWeekStart,
	pacificWeekStartUtc,
	parseAccountingInput,
	taskId,
	type AccountingFault,
	type AccountingInput,
	type SourceCoverage,
} from "./usage-accounting-contract.js";
import type { NumericRows } from "./usage-accounting-collector.js";
import { supportedUsageEvidence, type UsageEvidence } from "./usage-accounting-evidence.js";
import {
	METER_FAULT_CODES,
	METER_LIMITS,
	validateMeterSnapshot,
	type MeterFaultCode,
	type MeterFaultCount,
	type MeterSourceStatus,
	type MeterSubject,
	type MeterSubjectSnapshot,
	type UsageMeterSnapshot,
} from "./usage-accounting-meter-contract.js";
import {
	projectObservedUsage,
	projectUsageCost,
	type PolicySubject,
	type SubjectUsageSource,
	type UsageSubject,
} from "./usage-accounting-roles.js";

export interface SnapshotSubjectRequest {
	subject: UsageSubject;
	/** Null means no supported funding context, NOT a zero budget. */
	policy: { policyRef: string; policySubject: PolicySubject } | null;
}
export interface SnapshotPartition {
	/** Identical versioned producer evidence across every partition, not input() alone. */
	evidence: UsageEvidence;
	/** Complete revisions/alias/run-leaf dependency component, never a transport page. */
	rows: NumericRows;
	/** Independently verified source role for each fact. Never derive from payerRole. */
	factRoles: SubjectUsageSource["factRoles"];
}
export interface SnapshotBuildInput {
	epoch: string;
	asOf: string;
	evidence: UsageEvidence;
	coverage: SourceCoverage[];
	/** Private stream -> public ordinal/kind mapping, already approved by the worker. */
	sources: { stream: string; status: MeterSourceStatus }[];
	subjects: SnapshotSubjectRequest[];
	partitions: Iterable<SnapshotPartition>;
	/** False when the producer aborted its planned work; a finished pass may still have partial coverage. */
	completed: boolean;
}
const ROWS = ["facts", "allocations", "aliases", "roots", "policies", "memberships", "snapshots"] as const;
const USD = /^(0|[1-9]\d{0,17})(?:\.\d{1,12})?$/;
const SCALE = 1_000_000_000_000n;
const MAX_USD = 10n ** 30n - 1n;
const emptyRows = (): NumericRows => ({
	facts: [],
	allocations: [],
	aliases: [],
	roots: [],
	policies: [],
	memberships: [],
	snapshots: [],
});
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const validTime = (s: string) =>
	/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) &&
	Number.isFinite(Date.parse(s)) &&
	new Date(s).toISOString() === s;
function units(s: string): bigint {
	if (!USD.test(s)) throw new Error("invalid-money");
	const [whole, fraction = ""] = s.split(".");
	return BigInt(whole) * SCALE + BigInt(fraction.padEnd(12, "0"));
}
function decimal(n: bigint): string {
	if (n < 0n || n > MAX_USD) throw new Error("money-capacity");
	const fraction = String(n % SCALE)
		.padStart(12, "0")
		.replace(/0+$/, "");
	return `${n / SCALE}${fraction ? `.${fraction}` : ""}`;
}
function add(a: string, b: string): string {
	return decimal(units(a) + units(b));
}
function count(a: number, b: number): number {
	if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0 || !Number.isSafeInteger(a + b))
		throw new Error("count-capacity");
	return a + b;
}
function publicCode(code: string): MeterFaultCode {
	const bare = code.replace(/^collector:/, "");
	if (METER_FAULT_CODES.includes(bare as MeterFaultCode)) return bare as MeterFaultCode;
	if (bare === "task-binding-mismatch" || bare === "unassigned-task") return "invalid-subject-binding";
	if (bare === "snapshot-coverage" || bare === "snapshot-mismatch" || bare === "snapshot-unpriced")
		return "snapshot-conflict";
	return "unknown-accounting-fault";
}
type Faults = Map<MeterFaultCode, number>;
function fault(m: Faults, code: string, n = 1, mode: "sum" | "max" = "sum"): void {
	const k = publicCode(code);
	m.set(k, mode === "max" ? Math.max(m.get(k) ?? 0, n) : count(m.get(k) ?? 0, n));
}
const faultList = (m: Faults): MeterFaultCount[] =>
	[...m].sort(([a], [b]) => a.localeCompare(b)).map(([code, n]) => ({ code, count: n }));
function collectorFaults(e: UsageEvidence): Faults {
	const m: Faults = new Map();
	for (const f of e.faultCounts) fault(m, f.code, f.count);
	// Never allow omission from faultCounts to erase a normalized collector fault.
	for (const f of e.faults) if (!m.has(publicCode(f.code))) fault(m, f.code);
	if (!e.inventoryComplete) fault(m, "inventory-partial", 1, "max");
	if (e.storage !== "healthy" && !m.size) fault(m, "io-failure");
	return m;
}
function publicSubject(s: UsageSubject): MeterSubject {
	return s.kind === "task" ? { kind: "task", queueKey: hash(s.queue), task: s.task, addedAt: s.addedAt } : { ...s };
}
function emptySubject(s: UsageSubject, at: string): MeterSubjectSnapshot {
	return {
		subject: publicSubject(s),
		window: { from: s.kind === "task" ? s.addedAt : pacificWeekStartUtc(at), through: at },
		usageCoverage: "unavailable",
		fundingCoverage: "not-evaluated",
		freshness: "unknown",
		coveredThrough: null,
		observedAt: null,
		list: null,
		otherBases: [],
		counts: { unpriced: null, unresolvedIdentities: null },
		funding: null,
		faults: [],
	};
}
function minimum(values: (string | null)[]): string | null {
	return values.length && values.every((v) => v !== null) ? values.sort()[0] : null;
}
function sourceStatuses(build: SnapshotBuildInput): MeterSourceStatus[] {
	const required = new Set(build.evidence.requiredStreams);
	if (
		build.sources.length > METER_LIMITS.sources ||
		new Set(build.sources.map((s) => s.stream)).size !== build.sources.length ||
		required.size !== build.evidence.requiredStreams.length
	)
		throw new Error("source-capacity");
	if ([...required].some((s) => !build.sources.some((v) => v.stream === s))) throw new Error("missing-inventory");
	return build.sources.map(({ stream, status }) => {
		if (status.required !== required.has(stream)) throw new Error("inventory-mismatch");
		if (status.kind === "temper") return structuredClone(status); // Diagnostic frontier never proves coverage.
		const rows = build.coverage.filter((c) => c.stream === stream && c.observedAt <= build.asOf);
		const latest = rows
			.map((c) => c.observedAt)
			.sort()
			.at(-1);
		const candidates = rows.filter((c) => c.observedAt === latest);
		const c = candidates[0];
		const conflict = candidates.some((v) => JSON.stringify(v) !== JSON.stringify(c));
		const due =
			status.required &&
			status.enabled &&
			status.lastProgressAt !== null &&
			Date.parse(build.asOf) - Date.parse(status.lastProgressAt) >= METER_LIMITS.alarmAfterMs;
		const stalled = status.stalled || due;
		const state = !status.enabled
			? "unavailable"
			: !c || conflict
				? "unknown"
				: c.status === "complete" && stalled
					? "partial"
					: c.status;
		return {
			...status,
			state,
			stalled,
			alarm: due ? "source-stalled" : null,
			complete_through:
				c && !conflict && status.enabled && (state === "complete" || state === "partial") ? c.through : null,
			observedAt: c && !conflict ? c.observedAt : null,
		};
	});
}
function scopedInput(
	input: AccountingInput,
	subject: UsageSubject,
	witnesses: SubjectUsageSource["factRoles"],
	faults: Faults,
): SubjectUsageSource {
	const roles = new Map<string, { role: string | null; evidenceRef: string }>();
	const ids = new Set(input.facts.map((f) => f.id));
	for (const witness of witnesses) {
		if (
			!ids.has(witness.factId) ||
			!/^[A-Za-z0-9_./:@+-]{1,256}$/.test(witness.evidenceRef) ||
			(witness.role !== null && !/^[a-z][a-z0-9-]{0,31}$/.test(witness.role))
		)
			throw new Error("invalid-witness");
		const previous = roles.get(witness.factId);
		if (previous && (previous.role !== witness.role || previous.evidenceRef !== witness.evidenceRef))
			throw new Error("conflicting-witness");
		roles.set(witness.factId, { role: witness.role, evidenceRef: witness.evidenceRef });
	}
	if (
		subject.kind === "task" &&
		input.memberships.some((m) => m.queue === subject.queue && m.task === subject.task && m.addedAt !== subject.addedAt)
	)
		fault(faults, "invalid-subject-binding", 1, "max");
	const facts = input.facts.filter((f) => {
		if (subject.kind === "role") {
			if (!roles.has(f.id) || roles.get(f.id)?.role === null) fault(faults, "invalid-subject-binding", 1, "max");
			return roles.get(f.id)?.role === subject.role;
		}
		if (checkTaskBinding(f, input.memberships) !== "verified" || !f.links.task) {
			fault(faults, "invalid-subject-binding", 1, "max");
			return false;
		}
		return subject.kind === "task"
			? taskId(f.links.task) === taskId(subject)
			: f.links.task.initiative === subject.initiative;
	});
	const selected = new Set(facts.map((f) => f.id));
	// Preserve complete dependencies: a cross-subject alias/run must fail binding, not lose its other leaf.
	const aliases = input.aliases.filter((a) => selected.has(a.aliasFactId) || selected.has(a.canonicalFactId));
	const snapshots = input.snapshots.filter(
		(s) => s.coveredFactIds.some((f) => selected.has(f)) || s.coveredFactIds.length === 0,
	);
	return {
		v: "subject-usage/1",
		subject: { ...subject },
		evidenceRef: "worker:pinned-component",
		factRoles: [...selected].map((factId) => ({
			factId,
			role: roles.get(factId)?.role ?? null,
			evidenceRef: roles.get(factId)?.evidenceRef ?? "worker:role-unavailable",
		})),
		input: {
			...input,
			facts,
			allocations: input.allocations.filter((a) => selected.has(a.factId)),
			aliases,
			snapshots,
		},
	};
}
/** Repeated native context must be identical across the pinned fold, including full parent history. */
function dependencyContext(input: AccountingInput, known: Map<string, string>): void {
	const groups = new Map<string, string[]>();
	const keep = (key: string, row: unknown) => {
		const values = groups.get(key) ?? [];
		values.push(JSON.stringify(row));
		groups.set(key, values);
	};
	for (const r of input.roots) keep(`root:${r.ref}`, r);
	for (const p of input.policies) keep(`policy:${p.ref}`, p);
	for (const m of input.memberships) keep(`task:${taskId(m)}`, m);
	for (const s of input.snapshots) keep(`run:${JSON.stringify([s.producer, s.incarnation, s.run])}`, s);
	for (const [key, values] of groups) {
		const digest = hash(JSON.stringify([...new Set(values)].sort()));
		if (known.has(key) && (key.startsWith("run:") || known.get(key) !== digest)) throw new Error("split-context");
		known.set(key, digest);
	}
}
interface Accumulator {
	request: SnapshotSubjectRequest;
	view: MeterSubjectSnapshot;
	faults: Faults;
	usageComplete: boolean;
	fundingComplete: boolean;
	policy: string | null;
	budget: string | null;
}
function fold(a: Accumulator, raw: SubjectUsageSource, at: string, reconciliation: AccountingFault[] = []): void {
	// Run totals reconcile the complete component ONCE; never copy an aggregate's money
	// into a subject, or prune its covered-leaf list to pretend it was subject-scoped.
	const runs = new Set(raw.input.snapshots.map((s) => JSON.stringify([s.producer, s.incarnation, s.run])));
	for (const f of reconciliation) {
		const version: unknown = JSON.parse(f.ref);
		if (runs.has(f.ref) || (Array.isArray(version) && runs.has(String(version[0])))) fault(a.faults, f.code);
	}
	const source = { ...raw, input: { ...raw.input, snapshots: [] } };
	// Observed role means source attribution, NOT a payer/funding assertion. Keep funding rows
	// intact for the separate policy projection; they cannot gate policy-free observations.
	const observedSource = { ...source, input: { ...source.input, allocations: [], roots: [], policies: [] } };
	const o = projectObservedUsage(observedSource, {
		subject: a.request.subject,
		asOf: at,
		staleAfterMs: METER_LIMITS.staleAfterMs,
	});
	for (const f of o.faults) fault(a.faults, f.code, f.count);
	if (o.issues.includes("invalid-subject-binding") || o.issues.includes("invalid-source")) {
		fault(a.faults, "invalid-subject-binding", 1, "max");
		a.usageComplete = false;
		a.fundingComplete = false;
		return;
	}
	a.usageComplete &&= o.usageCoverage === "complete";
	if (o.list) {
		const v = a.view;
		v.list ??= { grossObservations: "0", deduplicatedRecorded: "0" };
		v.list.grossObservations = add(v.list.grossObservations, o.list.grossObservations.usd);
		v.list.deduplicatedRecorded = add(v.list.deduplicatedRecorded, o.list.deduplicatedRecorded.usd);
		v.counts.unpriced = count(v.counts.unpriced ?? 0, o.counts.unpriced ?? 0);
		v.counts.unresolvedIdentities = count(v.counts.unresolvedIdentities ?? 0, o.counts.unresolvedIdentities ?? 0);
		for (const b of o.otherBases) {
			let target = v.otherBases.find((v) => v.basis === b.basis);
			if (!target) {
				target = { basis: b.basis, knownUsd: "0", unpriced: 0 };
				v.otherBases.push(target);
			}
			target.knownUsd = add(target.knownUsd, b.knownUsd);
			target.unpriced = count(target.unpriced, b.unpriced);
		}
	}
	const p = a.request.policy;
	if (!p) return;
	if (a.request.subject.kind === "task") {
		fault(a.faults, "funding-unavailable", 1, "max");
		a.fundingComplete = false;
		return;
	}
	const funding = projectUsageCost(source, {
		subject: a.request.subject,
		...p,
		asOf: at,
		staleAfterMs: METER_LIMITS.staleAfterMs,
	});
	if (!funding.policy || !funding.list || !funding.counts) {
		fault(a.faults, "funding-unavailable", 1, "max");
		a.fundingComplete = false;
		return;
	}
	const signature = JSON.stringify(funding.policy);
	if (a.policy !== null && a.policy !== signature) throw new Error("policy-conflict");
	a.policy = signature;
	a.budget = funding.policy.weeklyUsd;
	a.fundingComplete &&= funding.coverage === "complete" && funding.counts.unallocated === 0;
	for (const f of funding.faults) fault(a.faults, f.code, f.count, "max");
	const v = a.view;
	v.funding ??= {
		wholePolicySubject: funding.policy.wholePolicySubject,
		verifiedOwnLowerBound: "0",
		exempt: "0",
		otherPolicy: "0",
		unallocated: "0",
		unallocatedFacts: 0,
		remainingUsd: null,
	};
	for (const k of ["verifiedOwnLowerBound", "exempt", "otherPolicy", "unallocated"] as const)
		v.funding[k] = add(v.funding[k], funding.list[k].usd);
	v.funding.unallocatedFacts = count(v.funding.unallocatedFacts, funding.counts.unallocated);
}

/** No source reads, timers or retained numeric history. Throws only for invalid caller metadata. */
export function buildUsageMeterSnapshot(build: SnapshotBuildInput): UsageMeterSnapshot {
	if (!validTime(build.asOf) || !/^[a-f0-9]{64}$/.test(build.epoch) || build.subjects.length > METER_LIMITS.subjects)
		throw new Error("invalid-snapshot-request");
	const global = collectorFaults(build.evidence);
	const accumulators = build.subjects.map((request): Accumulator => ({
		request,
		view: emptySubject(request.subject, build.asOf),
		faults: new Map(),
		usageComplete: true,
		fundingComplete: true,
		policy: null,
		budget: null,
	}));
	if (new Set(accumulators.map((a) => JSON.stringify(a.view.subject))).size !== accumulators.length)
		throw new Error("duplicate-subject");
	let sources: MeterSourceStatus[] = [];
	let broken = false;
	let unavailable = false;
	try {
		sources = sourceStatuses(build);
	} catch {
		fault(global, "source-coverage");
		unavailable = true;
	}
	for (const s of sources) if (s.kind !== "temper" && s.alarm === "source-stalled") fault(global, "source-stalled");
	const pin = JSON.stringify(build.evidence);
	const seen = new Set<string>();
	const contexts = new Map<string, string>();
	let partitions = 0;
	let processing = true;
	try {
		if (
			!supportedUsageEvidence(build.evidence) ||
			build.evidence.asOf !== build.asOf ||
			!Number.isSafeInteger(build.evidence.sequence) ||
			build.evidence.sequence < 0
		)
			throw new Error("invalid-pin");
		processing = false;
		for (const partition of build.partitions) {
			processing = true;
			if (JSON.stringify(partition.evidence) !== pin) throw new Error("changed-pin");
			if (
				ROWS.reduce((n, key) => n + partition.rows[key].length, 0) > METER_LIMITS.lookupRows ||
				Buffer.byteLength(JSON.stringify({ rows: partition.rows, factRoles: partition.factRoles })) >
					METER_LIMITS.lookupBytes
			)
				throw new Error("partition-capacity");
			const parsed = parseAccountingInput({
				v: 1,
				...partition.rows,
				coverage: build.coverage,
				requiredStreams: build.evidence.requiredStreams,
			});
			if (!parsed.ok) throw new Error("invalid-component");
			dependencyContext(parsed.value, contexts);
			if (seen.size + contexts.size > METER_LIMITS.indexEntries) throw new Error("context-capacity");
			const identities = new Set(parsed.value.facts.map((f) => f.id));
			for (const id of identities) {
				if (seen.has(id) || seen.size + contexts.size >= METER_LIMITS.indexEntries) throw new Error("split-component");
				seen.add(id);
			}
			for (const alias of parsed.value.aliases)
				if (!identities.has(alias.aliasFactId) || !identities.has(alias.canonicalFactId))
					throw new Error("split-alias");
			for (const snapshot of parsed.value.snapshots)
				if (snapshot.coveredFactIds.some((id) => !identities.has(id))) throw new Error("split-run");
			const reconciliation = parsed.value.snapshots.length
				? observeUsage(parsed.value, {
						asOf: build.asOf,
						staleAfterMs: METER_LIMITS.staleAfterMs,
						window: { from: pacificWeekStartUtc(build.asOf), through: build.asOf },
					}).faults.filter((f) => f.code.startsWith("snapshot-"))
				: [];
			for (const a of accumulators)
				fold(
					a,
					scopedInput(parsed.value, a.request.subject, partition.factRoles, a.faults),
					build.asOf,
					reconciliation,
				);
			partitions = count(partitions, 1);
			processing = false;
		}
		// Empty completed scans can prove clean zero, but never use an empty global report as a role total.
		if (
			partitions === 0 &&
			build.completed &&
			!broken &&
			build.evidence.storage === "healthy" &&
			build.evidence.inventoryComplete &&
			sources.some((s) => s.required)
		) {
			const input: AccountingInput = {
				v: 1,
				...emptyRows(),
				coverage: build.coverage,
				requiredStreams: build.evidence.requiredStreams,
			};
			for (const a of accumulators) fold(a, scopedInput(input, a.request.subject, [], a.faults), build.asOf);
		}
	} catch {
		broken = processing;
		unavailable = true;
		fault(global, "index-unavailable", 1, "max");
	}
	if (!build.completed) {
		unavailable = true;
		fault(global, "index-unavailable", 1, "max");
	}
	const required = sources.filter((s) => s.required);
	const covered = minimum(required.map((s) => (s.kind === "temper" ? null : s.complete_through)));
	const observed = minimum(required.map((s) => s.observedAt));
	const watermark = minimum([covered, observed]);
	const fresh = watermark !== null && Date.parse(build.asOf) - Date.parse(watermark) <= METER_LIMITS.staleAfterMs;
	const healthy =
		!broken &&
		!unavailable &&
		build.evidence.storage === "healthy" &&
		build.evidence.inventoryComplete &&
		global.size === 0 &&
		required.length > 0 &&
		required.every((s) => s.enabled && s.state === "complete");
	for (const a of accumulators) {
		const v = a.view;
		for (const [code, n] of global) fault(a.faults, code, n, "max");
		if (v.counts.unpriced) fault(a.faults, "unpriced", v.counts.unpriced, "max");
		if (v.counts.unresolvedIdentities) fault(a.faults, "unresolved-identity", v.counts.unresolvedIdentities, "max");
		if (broken) {
			v.list = null;
			v.otherBases = [];
			v.counts = { unpriced: null, unresolvedIdentities: null };
			v.funding = null;
		}
		v.coveredThrough = covered;
		v.observedAt = observed;
		v.freshness =
			broken || unavailable || build.evidence.storage === "unavailable" || watermark === null
				? "unknown"
				: fresh
					? "fresh"
					: "stale";
		v.usageCoverage = !v.list
			? "unavailable"
			: healthy && fresh && a.usageComplete && !a.faults.size
				? "complete"
				: "partial";
		v.fundingCoverage = !a.request.policy
			? "not-evaluated"
			: !v.funding
				? "unavailable"
				: v.usageCoverage === "complete" && a.fundingComplete
					? "complete"
					: "partial";
		if (v.funding && v.fundingCoverage === "complete" && v.funding.wholePolicySubject && a.budget !== null) {
			v.funding.remainingUsd = decimal(
				units(a.budget) > units(v.funding.verifiedOwnLowerBound)
					? units(a.budget) - units(v.funding.verifiedOwnLowerBound)
					: 0n,
			);
		}
		v.otherBases.sort((a, b) => a.basis.localeCompare(b.basis));
		v.faults = faultList(a.faults);
	}
	// Only SHARED collector/storage faults belong on the outer envelope. Subject dimensions
	// overlap; summing their faults or money would poison independently verified subjects.
	const snapshot: UsageMeterSnapshot = {
		v: "usage-meter-snapshot/1",
		reportingOnly: true,
		generation: { epoch: build.epoch, sequence: build.evidence.sequence },
		evaluatedAt: build.asOf,
		weekStart: pacificWeekStart(build.asOf),
		state:
			broken || unavailable || build.evidence.storage === "unavailable"
				? "unavailable"
				: watermark !== null && !fresh
					? "stale"
					: "ready",
		storage: build.evidence.storage,
		inventory: build.evidence.inventoryComplete ? "complete" : "partial",
		oldestCoveredThrough: covered,
		oldestObservedAt: observed,
		sources,
		subjects: accumulators.map((a) => a.view),
		faults: faultList(global),
	};
	const validated = validateMeterSnapshot(snapshot);
	if (validated) return validated;
	// Oversized or semantically invalid public envelope: no truncation and no private failure text.
	fault(global, "store-capacity", 1, "max");
	const fallback: UsageMeterSnapshot = {
		...snapshot,
		state: "unavailable",
		storage: "unavailable",
		inventory: "unavailable",
		sources: [],
		oldestCoveredThrough: null,
		oldestObservedAt: null,
		subjects: build.subjects.map((r) => ({
			...emptySubject(r.subject, build.asOf),
			fundingCoverage: r.policy ? "unavailable" : "not-evaluated",
			faults: faultList(global),
		})),
		faults: faultList(global),
	};
	const safe = validateMeterSnapshot(fallback);
	if (safe) return safe;
	// At the Cartesian subject/fault cap, repeating every shared fault exceeds the wire cap.
	// Keep EVERY shared code/count on the envelope; each subject explicitly says unavailable
	// due to capacity. The cache's role getter also includes these shared faults.
	fallback.subjects = fallback.subjects.map((s) => ({ ...s, faults: [{ code: "store-capacity", count: 1 }] }));
	const compact = validateMeterSnapshot(fallback);
	if (!compact) throw new Error("invalid-snapshot-request");
	return compact;
}
