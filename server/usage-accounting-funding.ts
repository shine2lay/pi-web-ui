/** Pure reporting projection. No source discovery, authority registration, debit or runtime importer. */
import { REQUESTER_INPUTS_MAX, requesterOf } from "./queue-requester.js";
import {
	accountUsage,
	checkTaskBinding,
	observeUsage,
	pacificWeekStartUtc,
	parseAccountingInput,
	taskId,
	type AccountingInput,
	type AccountingReport,
	type Allocation,
	type DispatchRoot,
	type ObservedUsageReport,
	type ReportingPolicy,
	type Scope,
	type TaskMembership,
	type UsageFact,
} from "./usage-accounting-contract.js";
import { METER_LIMITS } from "./usage-accounting-meter-contract.js";

export const REPORTING_RULE_REF = "dr-e108f47f8033";
export const FUNDING_LIMITS = Object.freeze({ rows: METER_LIMITS.pageRows, recordBytes: 65_536, lookups: 4096 });
type TaskKey = Pick<TaskMembership, "queue" | "task" | "addedAt">;
type EvidenceKind = "rule" | "policy" | "cap" | "proposal" | "input" | "team";
/** Server-private, independently sourced metadata projections, NOT JSON supplied by a tool/client.
 * These ports are a reviewed dependency boundary, not an authentication mechanism. None is installed.
 * In particular nativeRoot must be backed by an independently vetted native store, not a DTO lookup.
 * See docs/usage-accounting-funding.md for the closed records and outstanding admission requirement. */
export interface ReportingFundingSources {
	read?: (kind: EvidenceKind, ref: string) => unknown;
	originalTask?: (key: TaskKey) => unknown;
	payer?: (factId: string) => unknown;
	nativeRoot?: (ref: string) => unknown;
	policyCoverage?: (policyRef: string, from: string, through: string) => unknown;
}
export interface ReportingFundingOptions {
	policyRef: string;
	asOf: string;
	staleAfterMs: number;
}
export type FundingGapCode =
	| "source-unavailable"
	| "invalid-evidence"
	| "evidence-limit"
	| "reporting-rule-unavailable"
	| "policy-unavailable"
	| "policy-mismatch"
	| "task-unavailable"
	| "task-birth-mismatch"
	| "parent-unavailable"
	| "requester-unavailable"
	| "requester-overflow"
	| "requester-binding-mismatch"
	| "requester-mixed"
	| "payer-unavailable"
	| "payer-mismatch"
	| "native-root-source-unavailable"
	| "native-root-unavailable"
	| "native-root-mismatch"
	| "policy-coverage-unavailable";
export interface FundingGap {
	code: FundingGapCode;
	/** Private fact/policy reference only; no exception, prose, or credential is returned. */
	ref: string;
}
export interface ReportingFundingProjection {
	v: "reporting-funding/1";
	reportingOnly: true;
	observed: ObservedUsageReport;
	fundingCoverage: "complete" | "partial" | "unavailable";
	/** Forwarded native roots only. The adapter never constructs one from a scope decision. */
	rows: Pick<AccountingInput, "allocations" | "roots" | "policies" | "memberships">;
	budget: AccountingReport | null;
	remainingUsd: string | null;
	gaps: FundingGap[];
}

type Rec = Record<string, unknown>;
class Gap extends Error {
	constructor(readonly code: FundingGapCode) {
		super(code);
	}
}
function need(value: unknown, code: FundingGapCode): asserts value {
	if (!value) throw new Gap(code);
}
/** Reject accessors and extra/payload fields without reading them. Ports must project at the source. */
function closed(raw: unknown, fields: readonly string[]): Rec {
	need(raw && typeof raw === "object" && !Array.isArray(raw), "invalid-evidence");
	need(Object.getPrototypeOf(raw) === Object.prototype, "invalid-evidence");
	const keys = Reflect.ownKeys(raw);
	need(keys.length === fields.length && fields.every((k) => keys.includes(k)), "invalid-evidence");
	for (const key of keys) {
		const d = Object.getOwnPropertyDescriptor(raw, key)!;
		need(d.enumerable && Object.hasOwn(d, "value"), "invalid-evidence");
	}
	return raw as Rec;
}
function list(raw: unknown, max: number = FUNDING_LIMITS.rows): unknown[] {
	need(Array.isArray(raw) && raw.length <= max, "evidence-limit");
	need(Reflect.ownKeys(raw).length === raw.length + 1, "invalid-evidence");
	for (let i = 0; i < raw.length; i++)
		need(Object.hasOwn(Object.getOwnPropertyDescriptor(raw, String(i)) ?? {}, "value"), "invalid-evidence");
	return raw;
}
function ref(raw: unknown): asserts raw is string {
	need(typeof raw === "string" && /^[A-Za-z0-9_./:@+-]{1,256}$/.exec(raw)?.[0] === raw, "invalid-evidence");
}
function time(raw: unknown): asserts raw is string {
	need(
		typeof raw === "string" &&
			/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(raw) &&
			Number.isFinite(Date.parse(raw)) &&
			new Date(raw).toISOString() === raw,
		"invalid-evidence",
	);
}
function same(a: unknown, b: unknown): boolean {
	const canonical = (v: unknown): string => {
		if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
		if (v && typeof v === "object")
			return `{${Object.keys(v)
				.sort()
				.map((k) => `${k}:${canonical((v as Rec)[k])}`)
				.join(",")}}`;
		return JSON.stringify(v) ?? "undefined";
	};
	return canonical(a) === canonical(b);
}
const empty = (): AccountingInput => ({
	v: 1,
	facts: [],
	allocations: [],
	aliases: [],
	roots: [],
	policies: [],
	memberships: [],
	snapshots: [],
	coverage: [],
	// A row-only #293 shape check still needs a valid, nonempty stream inventory.
	// This envelope is never used for observation or coverage; real streams stay intact.
	requiredStreams: ["funding-shape-validation"],
});
function membership(raw: unknown): TaskMembership {
	closed(raw, ["queue", "task", "addedAt", "project", "initiative", "effectiveAt"]);
	need(parseAccountingInput({ ...empty(), memberships: [raw] }).ok, "invalid-evidence");
	return structuredClone(raw) as TaskMembership;
}
function keyOf(raw: unknown): TaskKey {
	const k = closed(raw, ["queue", "task", "addedAt"]);
	ref(k.queue);
	time(k.addedAt);
	need(Number.isSafeInteger(k.task) && Number(k.task) > 0, "invalid-evidence");
	return { queue: k.queue, task: k.task as number, addedAt: k.addedAt };
}
/** Stricter closed/getter-free envelope BEFORE the display-only v1 validator. No authority promotion. */
function requester(raw: unknown): NonNullable<ReturnType<typeof requesterOf>> {
	const r = closed(raw, ["v", "inputs"]);
	const inputs = list(r.inputs, REQUESTER_INPUTS_MAX);
	for (const input of inputs) {
		need(input && typeof input === "object", "invalid-evidence");
		const kind = Object.getOwnPropertyDescriptor(input, "kind")?.value;
		const fields =
			kind === "unknown" ? ["kind"] : kind === "owner" ? ["kind", "channel", "id"] : ["kind", "role", "id", "message"];
		if (kind === "role") {
			for (const optional of ["forOwner", "ownerIds"]) if (Object.hasOwn(input, optional)) fields.push(optional);
		}
		const i = closed(input, fields);
		if (i.ownerIds !== undefined) list(i.ownerIds, 10).forEach(ref);
	}
	const result = requesterOf(raw);
	need(result && result.inputs.length === inputs.length, "requester-unavailable");
	return result;
}

/** Pure, bounded reporting batch. All numeric usage stays visible, even without funding sources.
 * The caller must include the WHOLE policy subject to claim a remainder; a task subset cannot do so.
 * No admitted native root/payer producer exists today: the default/live result is unavailable. */
export function projectReportingFunding(
	raw: unknown,
	options: ReportingFundingOptions,
	sources: ReportingFundingSources = {},
): ReportingFundingProjection {
	const parsed = parseAccountingInput(raw);
	if (!parsed.ok) throw new Error(`invalid-accounting-input:${parsed.code}`);
	ref(options.policyRef);
	const input: AccountingInput = structuredClone({
		...parsed.value,
		allocations: [],
		roots: [],
		policies: [],
		memberships: [],
	});
	const observed = observeUsage(input, {
		asOf: options.asOf,
		staleAfterMs: options.staleAfterMs,
		window: { from: pacificWeekStartUtc(options.asOf), through: options.asOf },
	});
	const rows: ReportingFundingProjection["rows"] = { allocations: [], roots: [], policies: [], memberships: [] };
	const gaps: FundingGap[] = [];
	const gap = (code: FundingGapCode, reference: string) => {
		if (!gaps.some((g) => g.code === code && g.ref === reference)) gaps.push({ code, ref: reference });
	};
	let lookups = 0;
	const lookup = (read: (() => unknown) | undefined, missing: FundingGapCode): unknown => {
		need(++lookups <= FUNDING_LIMITS.lookups, "evidence-limit");
		need(read, missing);
		try {
			const value = read();
			need(value !== undefined && value !== null, missing);
			return value;
		} catch (error) {
			if (error instanceof Gap) throw error;
			throw new Gap("source-unavailable");
		}
	};
	const read = (kind: EvidenceKind, reference: string, missing: FundingGapCode) =>
		lookup(sources.read && (() => sources.read!(kind, reference)), missing);
	const record = (rawRecord: unknown, fields: string[], version: string): Rec => {
		const r = closed(rawRecord, ["v", ...fields]);
		need(r.v === version, "invalid-evidence");
		return r;
	};
	const policies = new Map<string, { policy: ReportingPolicy; initiative: string }>();
	function policy(reference: string): { policy: ReportingPolicy; initiative: string } {
		const cached = policies.get(reference);
		if (cached) return cached;
		const p = record(read("policy", reference, "policy-unavailable"), ["policy", "initiative"], "reporting-policy/1");
		ref(p.initiative);
		const value = closed(p.policy, [
			"ref",
			"role",
			"scopeRef",
			"effectiveAt",
			"weeklyUsd",
			"basis",
			"timeZone",
			"sourceRef",
		]);
		need(parseAccountingInput({ ...empty(), policies: [value] }).ok, "invalid-evidence");
		const projected = structuredClone(value) as unknown as ReportingPolicy;
		need(projected.ref === reference && projected.effectiveAt <= options.asOf, "policy-mismatch");
		const cap = record(
			read("cap", projected.sourceRef, "policy-unavailable"),
			["ref", "from", "kind", "role", "initiative", "effectiveAt", "weeklyUsd", "basis", "timeZone"],
			"budget-source/1",
		);
		need(
			cap.ref === projected.sourceRef &&
				cap.from === "owner" &&
				(cap.kind === "answer" || cap.kind === "order") &&
				cap.role === projected.role &&
				cap.initiative === p.initiative &&
				cap.effectiveAt === projected.effectiveAt &&
				cap.weeklyUsd === projected.weeklyUsd &&
				cap.basis === projected.basis &&
				cap.timeZone === projected.timeZone,
			"policy-mismatch",
		);
		// This adapter cannot turn generic policy support into a different Design cap.
		need(
			projected.role !== "design" || (projected.sourceRef === "bp-b7f97619" && projected.weeklyUsd === "2000"),
			"policy-mismatch",
		);
		const result = { policy: projected, initiative: p.initiative };
		policies.set(reference, result);
		rows.policies.push(projected);
		return result;
	}
	let ruleAvailable = false;
	try {
		const rule = record(
			read("rule", REPORTING_RULE_REF, "reporting-rule-unavailable"),
			["ref", "from", "source", "picked", "recordedAt"],
			"funding-rule-source/1",
		);
		time(rule.recordedAt);
		need(
			rule.ref === REPORTING_RULE_REF &&
				rule.from === "owner" &&
				rule.source === "answer" &&
				rule.picked === "Initiative, unless asked for" &&
				rule.recordedAt <= options.asOf,
			"reporting-rule-unavailable",
		);
		ruleAvailable = true;
	} catch (error) {
		gap(error instanceof Gap ? error.code : "invalid-evidence", REPORTING_RULE_REF);
	}
	let target: ReportingPolicy | undefined;
	try {
		target = policy(options.policyRef).policy;
	} catch (error) {
		gap(error instanceof Gap ? error.code : "invalid-evidence", options.policyRef);
	}
	if (!sources.nativeRoot) gap("native-root-source-unavailable", options.policyRef);

	function scopeFor(
		fact: UsageFact,
		add: Rec,
		task: Rec,
		payerRole: string,
		queueSession: string,
	): Exclude<Scope, "unknown" | "team"> {
		if (task.requesterState === "legacy-absent") {
			need(add.origin === null && task.proposalRef === null, "requester-binding-mismatch");
			return "own";
		}
		need(task.requesterState !== "overflow", "requester-overflow");
		need(task.requesterState === "recorded", "requester-unavailable");
		const origin = requester(add.origin);
		ref(task.proposalRef);
		const proposal = record(
			read("proposal", task.proposalRef, "requester-unavailable"),
			["ref", "task", "queueSession", "proposedAt", "origin", "inputRefs"],
			"task-proposal/1",
		);
		time(proposal.proposedAt);
		need(
			proposal.ref === task.proposalRef &&
				taskId(keyOf(proposal.task)) === taskId(fact.links.task!) &&
				proposal.queueSession === queueSession &&
				proposal.proposedAt <= fact.links.task!.addedAt,
			"requester-binding-mismatch",
		);
		need(same(requester(proposal.origin), origin), "requester-binding-mismatch");
		const refs = list(proposal.inputRefs, REQUESTER_INPUTS_MAX);
		refs.forEach(ref);
		need(refs.length === origin.inputs.length && new Set(refs).size === refs.length, "requester-binding-mismatch");
		const decisions: boolean[] = [];
		for (let i = 0; i < refs.length; i++) {
			const witness = record(
				read("input", refs[i] as string, "requester-unavailable"),
				["ref", "queueSession", "acceptedAt", "input"],
				"requester-input/1",
			);
			time(witness.acceptedAt);
			const actual = requester({ v: 1, inputs: [witness.input] }).inputs[0];
			need(
				witness.ref === refs[i] &&
					witness.queueSession === queueSession &&
					witness.acceptedAt <= proposal.proposedAt &&
					same(actual, origin.inputs[i]),
				"requester-binding-mismatch",
			);
			// A reply/forOwner hint or our own role's request never becomes a peer request.
			decisions.push(
				actual.kind === "owner" ||
					(actual.kind === "role" &&
						actual.role !== payerRole &&
						(actual.message === "question" || actual.message === "request")),
			);
		}
		need(new Set(decisions).size === 1, "requester-mixed");
		return decisions[0] ? "requested" : "own";
	}

	const roots = new Map<string, DispatchRoot>();
	const seenRoots = new Map<string, DispatchRoot>();
	const badRoots = new Set<string>();
	let supported = 0;
	if (input.facts.length > FUNDING_LIMITS.rows) gap("evidence-limit", options.policyRef);
	else
		for (const fact of new Map(input.facts.map((f) => [f.id, f])).values()) {
			if (fact.occurredAt > options.asOf || fact.source.observedAt > options.asOf) continue;
			const allocation: Allocation = {
				v: "allocation/1",
				factId: fact.id,
				revision: 0,
				supersedes: null,
				rootRef: null,
				scope: "unknown",
				policyRef: null,
				payerRole: null,
				recordedAt: options.asOf,
				reason: "missing-root",
			};
			rows.allocations.push(allocation);
			try {
				need(ruleAvailable, "reporting-rule-unavailable");
				const member = fact.links.task;
				need(member, "task-unavailable");
				const key: TaskKey = { queue: member.queue, task: member.task, addedAt: member.addedAt };
				const t = record(
					lookup(sources.originalTask && (() => sources.originalTask!(key)), "task-unavailable"),
					["ref", "queue", "queueSession", "add", "requesterState", "proposalRef", "history", "historyThrough"],
					"task-add/1",
				);
				ref(t.ref);
				ref(t.queueSession);
				time(t.historyThrough);
				const add = closed(t.add, ["v", "op", "id", "ts", "origin"]);
				need(
					add.v === 1 &&
						add.op === "add" &&
						t.queue === member.queue &&
						add.id === member.task &&
						add.ts === Date.parse(member.addedAt),
					"task-birth-mismatch",
				);
				const history = list(t.history).map(membership);
				need(Buffer.byteLength(JSON.stringify(history), "utf8") <= FUNDING_LIMITS.recordBytes, "evidence-limit");
				const historyThrough = t.historyThrough;
				need(
					history.length > 0 &&
						history.every((m) => taskId(m) === taskId(member)) &&
						history[0].effectiveAt === member.addedAt &&
						historyThrough >= fact.occurredAt &&
						historyThrough <= options.asOf &&
						history.every(
							(m, i) => m.effectiveAt <= historyThrough && (i === 0 || history[i - 1].effectiveAt < m.effectiveAt),
						) &&
						checkTaskBinding(fact, history) === "verified",
					"parent-unavailable",
				);
				const payer = record(
					lookup(sources.payer && (() => sources.payer!(fact.id)), "payer-unavailable"),
					["ref", "factId", "task", "role", "policyRef", "scopeRef", "rootRef", "kind", "teamSourceRef", "recordedAt"],
					"funding-payer/1",
				);
				for (const k of ["ref", "role", "scopeRef", "rootRef"]) ref(payer[k]);
				time(payer.recordedAt);
				need(
					payer.factId === fact.id && taskId(keyOf(payer.task)) === taskId(member) && payer.recordedAt <= options.asOf,
					"payer-mismatch",
				);
				let scope: Exclude<Scope, "unknown">;
				let policyRef: string | null = null;
				if (payer.kind === "team") {
					need(payer.policyRef === null, "payer-mismatch");
					ref(payer.teamSourceRef);
					const team = record(
						read("team", payer.teamSourceRef, "policy-unavailable"),
						["ref", "from", "scopeRef", "initiative", "effectiveAt", "uncapped"],
						"team-source/1",
					);
					time(team.effectiveAt);
					need(
						team.ref === "bp-b7f97619" &&
							payer.teamSourceRef === team.ref &&
							team.from === "owner" &&
							team.uncapped === true &&
							team.scopeRef === payer.scopeRef &&
							team.initiative === member.initiative &&
							team.effectiveAt <= fact.occurredAt,
						"policy-mismatch",
					);
					scope = "team";
				} else {
					need(payer.kind === "department" && payer.teamSourceRef === null, "payer-mismatch");
					ref(payer.policyRef);
					const p = policy(payer.policyRef);
					need(
						p.policy.role === payer.role &&
							p.policy.scopeRef === payer.scopeRef &&
							p.initiative === member.initiative &&
							p.policy.effectiveAt <= fact.occurredAt,
						"policy-mismatch",
					);
					scope = scopeFor(fact, add, t, payer.role as string, t.queueSession);
					policyRef = scope === "own" ? p.policy.ref : null;
				}
				need(sources.nativeRoot, "native-root-source-unavailable");
				const rawRoot = lookup(() => sources.nativeRoot!(payer.rootRef as string), "native-root-unavailable");
				closed(rawRoot, [
					"ref",
					"scopeRef",
					"scope",
					"occurredAt",
					"policyRef",
					"payerRole",
					"provenance",
					"evidenceRef",
				]);
				need(parseAccountingInput({ ...empty(), roots: [rawRoot] }).ok, "native-root-unavailable");
				const root = structuredClone(rawRoot) as DispatchRoot;
				need(root.ref === payer.rootRef, "native-root-mismatch");
				const previous = seenRoots.get(root.ref);
				if (previous && !same(previous, root)) badRoots.add(root.ref);
				seenRoots.set(root.ref, root);
				need(
					root.scope === scope &&
						root.scopeRef === payer.scopeRef &&
						root.payerRole === payer.role &&
						root.policyRef === policyRef &&
						root.occurredAt <= fact.occurredAt,
					"native-root-mismatch",
				);
				roots.set(root.ref, root);
				rows.memberships.push(...history);
				Object.assign(allocation, {
					rootRef: root.ref,
					scope,
					policyRef,
					payerRole: payer.role,
					reason: "native-root",
				});
				supported++;
			} catch (error) {
				gap(error instanceof Gap ? error.code : "invalid-evidence", fact.id);
			}
		}
	for (const allocation of rows.allocations)
		if (allocation.rootRef && badRoots.has(allocation.rootRef)) {
			gap("native-root-mismatch", allocation.factId);
			Object.assign(allocation, {
				rootRef: null,
				scope: "unknown",
				policyRef: null,
				payerRole: null,
				reason: "mixed-root",
			});
			supported--;
		}
	rows.roots = [...roots.values()].filter((r) => !badRoots.has(r.ref));
	rows.memberships = [...new Map(rows.memberships.map((m) => [JSON.stringify(m), m])).values()];
	let coverage = false;
	try {
		const c = record(
			lookup(
				sources.policyCoverage &&
					(() => sources.policyCoverage!(options.policyRef, observed.window.from, options.asOf)),
				"policy-coverage-unavailable",
			),
			["policyRef", "from", "through", "observedAt", "requiredStreams", "wholePolicySubject"],
			"funding-coverage/1",
		);
		time(c.from);
		time(c.through);
		time(c.observedAt);
		const streams = list(c.requiredStreams);
		streams.forEach(ref);
		need(
			c.policyRef === options.policyRef &&
				c.from <= observed.window.from &&
				c.through >= options.asOf &&
				c.through <= c.observedAt &&
				c.observedAt <= options.asOf &&
				c.wholePolicySubject === true &&
				streams.length > 0 &&
				same([...streams].sort(), [...input.requiredStreams].sort()),
			"policy-coverage-unavailable",
		);
		coverage = true;
	} catch (error) {
		gap(error instanceof Gap ? error.code : "invalid-evidence", options.policyRef);
	}
	const budget = target ? accountUsage({ ...input, ...rows }, options) : null;
	const complete = gaps.length === 0 && coverage && budget?.coverage === "complete";
	// Never leave a reassuring nested balance when the evidence outside #293 is incomplete.
	if (budget && !complete) {
		budget.remainingUsd = null;
		budget.coverage = "partial";
		budget.faults.push(...gaps.map((g) => ({ code: `funding:${g.code}`, ref: g.ref })));
		budget.faults.sort((a, b) => a.code.localeCompare(b.code) || a.ref.localeCompare(b.ref));
	}
	return {
		v: "reporting-funding/1",
		reportingOnly: true,
		observed,
		fundingCoverage: complete ? "complete" : supported > 0 ? "partial" : "unavailable",
		rows,
		budget,
		remainingUsd: complete ? budget.remainingUsd : null,
		gaps: gaps.sort((a, b) => a.code.localeCompare(b.code) || a.ref.localeCompare(b.ref)),
	};
}
