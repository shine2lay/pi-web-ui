/** Inert, pure reporting adapter. Only the frozen, pure #293 contract is a value dependency. */
import {
	accountUsage,
	checkTaskBinding,
	pacificWeekStart,
	pacificWeekStartUtc,
	parseAccountingInput,
	taskId,
	type AccountingInput,
	type AccountingReport,
	type ReportingPolicy,
	type Usd,
} from "./usage-accounting-contract.js";
import type { UiRoleSpend } from "./protocol.js";

export type UsageSubject =
	| { kind: "role"; role: string }
	| { kind: "task"; queue: string; task: number; addedAt: string }
	| { kind: "initiative"; initiative: string };
export type PolicySubject = Exclude<UsageSubject, { kind: "task" }>;
export interface UsageViewRequest {
	subject: UsageSubject;
	policyRef: string;
	/** Explicit supported policy extent, not the title/lead/membership of a task. */
	policySubject: PolicySubject;
	asOf: string;
	staleAfterMs: number;
}
/** Numeric-only, already scoped by a future supported producer. This is NOT an authority API. */
export interface SubjectUsageSource {
	v: "subject-usage/1";
	subject: UsageSubject;
	evidenceRef: string;
	/** Independent source binding for every fact identity; null does not guess a payer. */
	factRoles: { factId: string; role: string | null; evidenceRef: string }[];
	input: AccountingInput;
}
/** Already-read legacy projection; never read a file or infer its update time from the read time. */
export interface LegacyManualInput {
	role: string;
	spend: UiRoleSpend;
	updatedAt: string | null;
	weekStart: string | null;
	weekEnd: string | null;
}
export interface ManualCostReference {
	label: "Manual tally — stale/unverified reference only";
	legacyState: UiRoleSpend["state"];
	updatedAt: string | null;
	weekStart: string | null;
	weekEnd: string | null;
	spent: string | null;
	budget: string | null;
	byInitiative: { id: string; amount: string }[];
}
export type CostViewIssue =
	| "invalid-request"
	| "source-unavailable"
	| "invalid-source"
	| "invalid-subject-binding"
	| "invalid-policy-binding"
	| "unpriced"
	| "unallocated"
	| "unresolved-identity"
	| "source-incomplete"
	| "stale-source"
	| "policy-subset"
	| "policy-not-effective"
	| "accounting-fault";
const FAULT_CODES = [
	"revision-conflict",
	"record-conflict",
	"orphan-allocation",
	"rewritten-occurrence",
	"missing-alias-target",
	"alias-cycle",
	"unresolved-identity",
	"identity-conflict",
	"alias-allocation-conflict",
	"task-binding-mismatch",
	"unassigned-task",
	"unknown-allocation",
	"partial-fact",
	"snapshot-conflict",
	"snapshot-coverage",
	"snapshot-unpriced",
	"snapshot-mismatch",
	"source-coverage",
	"coverage-conflict",
	"uninventoried-stream",
	"unknown-accounting-fault",
] as const;
export type CostFaultCode = (typeof FAULT_CODES)[number];
export interface CostMetric {
	usd: Usd;
	label: string;
}
export interface CostSourceView {
	/** Inventory position only: never expose arbitrary stream names, raw errors or paths. */
	index: number;
	state: "complete" | "partial" | "unknown" | "unavailable" | "missing" | "conflict";
	from: string | null;
	through: string | null;
	observedAt: string | null;
}
export interface UsageCostView {
	v: "usage-cost-view/1";
	reportingOnly: true;
	subject: UsageSubject | null;
	state: "complete" | "partial" | "stale" | "source-unavailable" | "invalid";
	label: string;
	/** Evaluation target, NOT a source freshness timestamp. */
	evaluatedAt: string | null;
	weekStart: string | null;
	/** Conservative covered watermark and oldest required observation, not wall-clock read time. */
	asOf: string | null;
	observedAt: string | null;
	freshness: "fresh" | "stale" | "unknown";
	coverage: "complete" | "partial" | "unavailable";
	policy: (ReportingPolicy & { wholePolicySubject: boolean }) | null;
	list: {
		basis: "list-estimate";
		currency: "USD";
		grossObservations: CostMetric;
		deduplicatedRecorded: CostMetric;
		verifiedOwnLowerBound: CostMetric;
		exempt: CostMetric;
		otherPolicy: CostMetric;
		unallocated: CostMetric;
	} | null;
	otherBases: { basis: "provider-reported" | "invoice"; label: string; knownUsd: Usd; unpriced: number }[];
	counts: { unpriced: number; unallocated: number; unresolvedIdentities: number } | null;
	sources: CostSourceView[];
	faults: { code: CostFaultCode; count: number }[];
	issues: CostViewIssue[];
	/** No green state, percentage, stop, or permission can be inferred from this reporting value. */
	balance: { remainingUsd: Usd | null; label: string; tone: "neutral"; progress: null };
	manual: ManualCostReference | null;
}

const REF = /^[A-Za-z0-9_./:@+-]{1,256}$/;
const ID = /^[a-z][a-z0-9-]{0,31}$/;
const MONEY = /^\$(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d{2})?$/;
const MAX_ROWS = 100_000;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function closed(v: unknown, keys: string[]): v is Record<string, unknown> {
	return record(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
}
const reference = (v: unknown): v is string => typeof v === "string" && REF.test(v);
const id = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const initiativeId = (v: unknown): v is string =>
	typeof v === "string" && v.length <= 60 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v);
function timestamp(v: unknown): v is string {
	return (
		typeof v === "string" &&
		/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
		Number.isFinite(Date.parse(v)) &&
		new Date(v).toISOString() === v
	);
}
function date(v: unknown): v is string {
	return typeof v === "string" && /^\d{4}-\d\d-\d\d$/.test(v) && timestamp(`${v}T00:00:00.000Z`);
}
function subjectOf(v: unknown): UsageSubject | null {
	if (!record(v)) return null;
	if (v.kind === "role" && closed(v, ["kind", "role"]) && id(v.role)) return { kind: "role", role: v.role };
	if (v.kind === "initiative" && closed(v, ["kind", "initiative"]) && initiativeId(v.initiative))
		return { kind: "initiative", initiative: v.initiative };
	if (
		v.kind === "task" &&
		closed(v, ["kind", "queue", "task", "addedAt"]) &&
		reference(v.queue) &&
		typeof v.task === "number" &&
		Number.isSafeInteger(v.task) &&
		v.task > 0 &&
		timestamp(v.addedAt)
	)
		return { kind: "task", queue: v.queue, task: v.task, addedAt: v.addedAt };
	return null;
}
const sameSubject = (a: UsageSubject, b: UsageSubject) => JSON.stringify(a) === JSON.stringify(b);
const policyScope = (s: PolicySubject) => (s.kind === "role" ? `role:${s.role}` : `initiative:${s.initiative}`);
function validRequest(v: UsageViewRequest): boolean {
	if (!closed(v, ["subject", "policyRef", "policySubject", "asOf", "staleAfterMs"])) return false;
	const p = subjectOf(v.policySubject);
	return (
		subjectOf(v.subject) !== null &&
		p !== null &&
		p.kind !== "task" &&
		reference(v.policyRef) &&
		timestamp(v.asOf) &&
		typeof v.staleAfterMs === "number" &&
		Number.isSafeInteger(v.staleAfterMs) &&
		v.staleAfterMs >= 0
	);
}

/** Ignore legacy line/age prose. Even legacy `ok`/`over` is only a manual report, never authority. */
function manualReference(raw: unknown, subject: UsageSubject | null): ManualCostReference | null {
	if (
		!subject ||
		subject.kind !== "role" ||
		!closed(raw, ["role", "spend", "updatedAt", "weekStart", "weekEnd"]) ||
		raw.role !== subject.role ||
		!record(raw.spend)
	)
		return null;
	const s = raw.spend;
	const state = s.state;
	if (!["none", "unreadable", "old-week", "ok", "over", "stale"].includes(String(state))) return null;
	if (Object.keys(s).some((k) => !["state", "line", "spent", "budget", "age", "byInitiative"].includes(k))) return null;
	if (raw.updatedAt !== null && !timestamp(raw.updatedAt)) return null;
	if (raw.weekStart !== null && !date(raw.weekStart)) return null;
	if (raw.weekEnd !== null && !date(raw.weekEnd)) return null;
	if (typeof s.line !== "string" || s.line.length > 1000) return null;
	const money = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && MONEY.test(v);
	const hasAmounts = state === "ok" || state === "over" || state === "stale";
	if (hasAmounts && (!money(s.spent) || !money(s.budget))) return null;
	if (!hasAmounts && ["spent", "budget", "age", "byInitiative"].some((k) => Object.hasOwn(s, k))) return null;
	const byInitiative: ManualCostReference["byInitiative"] = [];
	if (s.byInitiative !== undefined) {
		if (!Array.isArray(s.byInitiative) || s.byInitiative.length > 1000) return null;
		for (const row of s.byInitiative) {
			if (!closed(row, ["id", "amount"]) || !initiativeId(row.id) || !money(row.amount)) return null;
			byInitiative.push({ id: row.id, amount: row.amount });
		}
	}
	return {
		label: "Manual tally — stale/unverified reference only",
		legacyState: state as UiRoleSpend["state"],
		updatedAt: raw.updatedAt as string | null,
		weekStart: raw.weekStart as string | null,
		weekEnd: raw.weekEnd as string | null,
		spent: hasAmounts ? (s.spent as string) : null,
		budget: hasAmounts ? (s.budget as string) : null,
		byInitiative,
	};
}
function emptyView(request: UsageViewRequest, issue: CostViewIssue, manual: unknown): UsageCostView {
	const subject = subjectOf(request?.subject);
	const at = timestamp(request?.asOf) ? request.asOf : null;
	return {
		v: "usage-cost-view/1",
		reportingOnly: true,
		subject,
		state: issue === "source-unavailable" ? "source-unavailable" : "invalid",
		label:
			issue === "source-unavailable"
				? "Automatic source unavailable — total unknown"
				: "Invalid automatic binding — total unknown",
		evaluatedAt: at,
		weekStart: at ? pacificWeekStart(at) : null,
		asOf: null,
		observedAt: null,
		freshness: "unknown",
		coverage: "unavailable",
		policy: null,
		list: null,
		otherBases: [],
		counts: null,
		sources: [],
		faults: [],
		issues: [issue],
		balance: { remainingUsd: null, label: "UNKNOWN — no certified budget remainder", tone: "neutral", progress: null },
		manual: manualReference(manual, subject),
	};
}
function sourceViews(input: AccountingInput, at: string): CostSourceView[] {
	return input.requiredStreams.map((stream, index) => {
		const rows = input.coverage.filter((c) => c.stream === stream && c.observedAt <= at);
		const latestAt = rows
			.map((c) => c.observedAt)
			.sort()
			.at(-1);
		const latest = rows.filter((c) => c.observedAt === latestAt);
		const c = latest[0];
		if (!c) return { index, state: "missing", from: null, through: null, observedAt: null };
		if (latest.some((r) => r.from !== c.from || r.through !== c.through || r.status !== c.status))
			return { index, state: "conflict", from: null, through: null, observedAt: latestAt! };
		return {
			index,
			state: c.status,
			from: c.from,
			through: c.through,
			observedAt: c.observedAt,
		};
	});
}
function safeFaults(report: AccountingReport): UsageCostView["faults"] {
	const counts = new Map<CostFaultCode, number>();
	for (const f of report.faults) {
		const code: CostFaultCode = FAULT_CODES.includes(f.code as CostFaultCode)
			? (f.code as CostFaultCode)
			: "unknown-accounting-fault";
		counts.set(code, (counts.get(code) ?? 0) + 1);
	}
	return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({ code, count }));
}
/** Source labels alone are insufficient: check every fact against independent role or event-time task evidence. */
function boundSource(raw: Record<string, unknown>, input: AccountingInput, subject: UsageSubject, at: string): boolean {
	if (!Array.isArray(raw.factRoles) || raw.factRoles.length > MAX_ROWS) return false;
	const roles = new Map<string, { role: string | null; evidenceRef: string }>();
	const factIds = new Set(input.facts.map((f) => f.id));
	for (const r of raw.factRoles) {
		if (
			!closed(r, ["factId", "role", "evidenceRef"]) ||
			typeof r.factId !== "string" ||
			!factIds.has(r.factId) ||
			(r.role !== null && !id(r.role)) ||
			!reference(r.evidenceRef)
		)
			return false;
		const old = roles.get(r.factId);
		if (old && (old.role !== r.role || old.evidenceRef !== r.evidenceRef)) return false;
		roles.set(r.factId, { role: r.role as string | null, evidenceRef: r.evidenceRef });
	}
	if (roles.size !== factIds.size) return false;
	for (const f of input.facts.filter((f) => f.source.observedAt <= at)) {
		if (subject.kind === "role") {
			if (roles.get(f.id)!.role !== subject.role) return false;
		} else {
			if (checkTaskBinding(f, input.memberships) !== "verified" || !f.links.task) return false;
			if (
				subject.kind === "task"
					? taskId(f.links.task) !== taskId(subject)
					: f.links.task.initiative !== subject.initiative
			)
				return false;
		}
	}
	for (const a of input.allocations.filter((a) => a.recordedAt <= at)) {
		const role = roles.get(a.factId)?.role;
		if (a.payerRole !== null && a.payerRole !== role) return false;
	}
	// An aggregate with unmapped leaves cannot prove which subject incurred it.
	return input.snapshots.every((s) => s.observedAt > at || s.coveredFactIds.every((f) => factIds.has(f)));
}

/** No I/O, globals, cache, timer, production importer or authority effect. Null source is explicitly unavailable. */
export function projectUsageCost(source: unknown, request: UsageViewRequest, manual?: unknown): UsageCostView {
	if (!validRequest(request)) return emptyView(request, "invalid-request", manual);
	const subject = subjectOf(request.subject)!;
	const policySubject = subjectOf(request.policySubject) as PolicySubject;
	if (source === null || source === undefined) return emptyView(request, "source-unavailable", manual);
	if (
		!closed(source, ["v", "subject", "evidenceRef", "factRoles", "input"]) ||
		source.v !== "subject-usage/1" ||
		!reference(source.evidenceRef)
	)
		return emptyView(request, "invalid-source", manual);
	const declared = subjectOf(source.subject);
	if (!declared || !sameSubject(subject, declared)) return emptyView(request, "invalid-subject-binding", manual);
	const parsed = parseAccountingInput(source.input);
	if (!parsed.ok) return emptyView(request, "invalid-source", manual);
	const input = parsed.value;
	if (!boundSource(source, input, subject, request.asOf)) return emptyView(request, "invalid-subject-binding", manual);
	const policies = input.policies.filter((p) => p.ref === request.policyRef);
	const policy = policies[0];
	if (
		!policy ||
		policies.some((p) =>
			Object.keys(policy).some((key) => p[key as keyof ReportingPolicy] !== policy[key as keyof ReportingPolicy]),
		) ||
		policy.scopeRef !== policyScope(policySubject) ||
		!id(policy.role) ||
		(policySubject.kind === "role" && policySubject.role !== policy.role) ||
		(subject.kind === "role" && subject.role !== policy.role)
	)
		return emptyView(request, "invalid-policy-binding", manual);
	let report: AccountingReport;
	try {
		// Equal-time conflicts stay faults. Stable ordering prevents a conflict's incidental
		// input order from choosing a different set of secondary coverage fault codes.
		const coverage = [...input.coverage].sort((a, b) =>
			JSON.stringify([a.stream, a.observedAt, a.from, a.through, a.status]).localeCompare(
				JSON.stringify([b.stream, b.observedAt, b.from, b.through, b.status]),
			),
		);
		report = accountUsage(
			{ ...input, coverage },
			{ policyRef: policy.ref, asOf: request.asOf, staleAfterMs: request.staleAfterMs },
		);
	} catch {
		// Never forward an exception message, even if a future contract starts including raw source text.
		return emptyView(request, "invalid-source", manual);
	}
	const sources = sourceViews(input, request.asOf);
	const minTime = (key: "through" | "observedAt") =>
		sources.every((s) => s[key] !== null && (key !== "through" || s.state === "complete" || s.state === "partial"))
			? sources.map((s) => s[key]!).sort()[0]
			: null;
	const asOf = minTime("through");
	const observedAt = minTime("observedAt");
	const watermark = asOf && observedAt ? (asOf < observedAt ? asOf : observedAt) : null;
	const freshness =
		watermark === null
			? "unknown"
			: Date.parse(request.asOf) - Date.parse(watermark) > request.staleAfterMs
				? "stale"
				: "fresh";
	const sourcesComplete = sources.every(
		(s) => s.state === "complete" && s.from! <= pacificWeekStartUtc(request.asOf) && s.through! >= request.asOf,
	);
	const unavailable = sources.some((s) => s.state === "unavailable" || s.state === "missing");
	const complete = report.coverage === "complete" && sourcesComplete && freshness === "fresh";
	const wholePolicySubject = sameSubject(subject, policySubject);
	const remainingUsd = complete && wholePolicySubject ? report.remainingUsd : null;
	const issues: CostViewIssue[] = [];
	if (unavailable) issues.push("source-unavailable");
	if (!sourcesComplete) issues.push("source-incomplete");
	if (freshness === "stale") issues.push("stale-source");
	if (report.unpricedFacts) issues.push("unpriced");
	if (report.unallocatedFacts) issues.push("unallocated");
	if (report.unresolvedIdentities) issues.push("unresolved-identity");
	if (!wholePolicySubject) issues.push("policy-subset");
	if (policy.effectiveAt > request.asOf) issues.push("policy-not-effective");
	if (report.faults.length) issues.push("accounting-fault");
	const state = unavailable
		? "source-unavailable"
		: freshness === "stale"
			? "stale"
			: complete
				? "complete"
				: "partial";
	return {
		v: "usage-cost-view/1",
		reportingOnly: true,
		subject,
		state,
		label:
			state === "complete"
				? "Complete recorded list estimate for this subject"
				: state === "stale"
					? "Stale source — recorded subtotals only"
					: state === "source-unavailable"
						? "Source unavailable — recorded subtotals only"
						: "Partial evidence — recorded subtotals only",
		evaluatedAt: request.asOf,
		weekStart: report.weekStart,
		asOf,
		observedAt,
		freshness,
		coverage: complete ? "complete" : "partial",
		policy: { ...policy, wholePolicySubject },
		list: {
			basis: "list-estimate",
			currency: "USD",
			grossObservations: {
				usd: report.grossKnownListUsd,
				label: "Gross priced observations — may overlap; not a spend lower bound",
			},
			deduplicatedRecorded: {
				usd: report.dedupKnownListUsd,
				label: "Deduplicated recorded list subtotal — all scopes",
			},
			verifiedOwnLowerBound: {
				usd: report.verifiedOwnLowerBoundUsd,
				label: "Verified own-policy lower bound — not total spend",
			},
			exempt: { usd: report.exemptKnownListUsd, label: "Verified requested/Team list subtotal — included above" },
			otherPolicy: { usd: report.otherPolicyKnownListUsd, label: "Other-policy list subtotal — included above" },
			unallocated: { usd: report.unallocatedKnownListUsd, label: "Unallocated list subtotal — included above" },
		},
		otherBases: report.otherBases.map((b) => ({
			...b,
			label:
				b.basis === "invoice"
					? "Recorded invoice amounts — separate basis"
					: "Provider-reported amounts — separate basis",
		})),
		counts: {
			unpriced: report.unpricedFacts,
			unallocated: report.unallocatedFacts,
			unresolvedIdentities: report.unresolvedIdentities,
		},
		sources,
		faults: safeFaults(report),
		issues,
		balance: {
			remainingUsd,
			label:
				remainingUsd === null
					? "UNKNOWN — no certified budget remainder"
					: "Recorded policy remainder — reporting only, not spending permission",
			tone: "neutral",
			progress: null,
		},
		manual: manualReference(manual, subject),
	};
}
