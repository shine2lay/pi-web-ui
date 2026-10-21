import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	factId,
	pacificWeekStartUtc,
	type AccountingInput,
	type DispatchRoot,
	type ReportingPolicy,
	type TaskMembership,
	type UsageFact,
} from "../../server/usage-accounting-contract.js";
import {
	FUNDING_LIMITS,
	REPORTING_RULE_REF,
	projectReportingFunding,
	type ReportingFundingProjection,
	type ReportingFundingSources,
} from "../../server/usage-accounting-funding.js";
import { requesterOf } from "../../server/queue-requester.js";

type Input = NonNullable<ReturnType<typeof requesterOf>>["inputs"][number];
type Rec = Record<string, unknown>;
const AS_OF = "2026-10-20T23:00:00.000Z";
const BIRTH = "2026-10-01T10:00:00.000Z";
const options = (asOf = AS_OF) => ({ policyRef: "fixture:design-policy", asOf, staleAfterMs: 60_000 });
interface TaskEvidence {
	v: string;
	ref: string;
	queue: string;
	queueSession: string;
	add: { v: number; op: string; id: number; ts: number; origin: unknown };
	requesterState: string;
	proposalRef: string | null;
	history: TaskMembership[];
	historyThrough: string;
}
interface PayerEvidence {
	v: string;
	ref: string;
	factId: string;
	task: Pick<TaskMembership, "queue" | "task" | "addedAt">;
	role: string;
	policyRef: string | null;
	scopeRef: string;
	rootRef: string;
	kind: string;
	teamSourceRef: string | null;
	recordedAt: string;
}
/** Independent fixed source projections. Not a live-reader/authentication proof. No real chats read. */
function fixture(asOf = AS_OF) {
	const input = JSON.parse(
		readFileSync(new URL("../fixtures/usage-accounting/ledger.json", import.meta.url), "utf8"),
	) as AccountingInput;
	const seed = structuredClone(input.facts[0]);
	input.facts = [];
	input.allocations = [];
	input.roots = [];
	input.policies = [];
	input.memberships = [];
	input.coverage[0] = {
		stream: "fixture-stream",
		from: pacificWeekStartUtc(asOf),
		through: asOf,
		observedAt: asOf,
		status: "complete",
	};
	const policy: ReportingPolicy = {
		ref: "fixture:design-policy",
		role: "design",
		scopeRef: "role:design",
		effectiveAt: "2026-10-10T07:00:00.000Z",
		weeklyUsd: "2000",
		basis: "list-estimate",
		timeZone: "America/Los_Angeles",
		sourceRef: "bp-b7f97619",
	};
	const records = new Map<string, unknown>();
	const set = (kind: string, ref: string, value: unknown) => records.set(`${kind}:${ref}`, value);
	const row = (kind: string, ref: string) => records.get(`${kind}:${ref}`) as Rec;
	set("policy", policy.ref, { v: "reporting-policy/1", policy, initiative: "design-in-temper" });
	set("cap", policy.sourceRef, {
		v: "budget-source/1",
		ref: policy.sourceRef,
		from: "owner",
		kind: "order",
		role: policy.role,
		initiative: "design-in-temper",
		effectiveAt: policy.effectiveAt,
		weeklyUsd: "2000",
		basis: policy.basis,
		timeZone: policy.timeZone,
	});
	set("rule", REPORTING_RULE_REF, {
		v: "funding-rule-source/1",
		ref: REPORTING_RULE_REF,
		from: "owner",
		source: "answer",
		picked: "Initiative, unless asked for",
		recordedAt: "2026-10-20T22:01:41.983Z",
	});
	set("team", "bp-b7f97619", {
		v: "team-source/1",
		ref: "bp-b7f97619",
		from: "owner",
		scopeRef: "team:temper",
		initiative: "team-in-temper",
		effectiveAt: policy.effectiveAt,
		uncapped: true,
	});
	const tasks: TaskEvidence[] = [];
	const payers: PayerEvidence[] = [];
	const roots: DispatchRoot[] = [];
	for (let i = 0; i < 3; i++) {
		const fact: UsageFact = structuredClone(seed);
		fact.identity.attempt = `funding-${i}`;
		fact.id = factId(fact.identity);
		fact.source.event = `funding-event-${i}`;
		fact.occurredAt = asOf;
		fact.source.observedAt = asOf;
		fact.prices[0].amount = ["0.1", "0.2", "0.3"][i];
		const member: TaskMembership = {
			queue: "fixture-queue",
			task: i + 1,
			addedAt: BIRTH,
			project: null,
			initiative: i === 2 ? "team-in-temper" : "design-in-temper",
			effectiveAt: BIRTH,
		};
		fact.links.task = member;
		input.facts.push(fact);
		input.memberships.push(structuredClone(member));
		tasks.push({
			v: "task-add/1",
			ref: `fixture:add:${i}`,
			queue: member.queue,
			queueSession: "fixture-queue-session",
			add: { v: 1, op: "add", id: member.task, ts: Date.parse(BIRTH), origin: null },
			requesterState: "legacy-absent",
			proposalRef: null,
			history: [structuredClone(member)],
			historyThrough: asOf,
		});
		payers.push({
			v: "funding-payer/1",
			ref: `fixture:payer:${i}`,
			factId: fact.id,
			task: { queue: member.queue, task: member.task, addedAt: BIRTH },
			role: "design",
			policyRef: i === 2 ? null : policy.ref,
			scopeRef: i === 2 ? "team:temper" : policy.scopeRef,
			rootRef: `fixture:native-root:${i}`,
			kind: i === 2 ? "team" : "department",
			teamSourceRef: i === 2 ? policy.sourceRef : null,
			recordedAt: asOf,
		});
		roots.push({
			ref: payers[i].rootRef,
			scopeRef: payers[i].scopeRef,
			scope: i === 2 ? "team" : i === 1 ? "requested" : "own",
			occurredAt: "2026-10-20T22:02:00.000Z",
			policyRef: i === 0 ? policy.ref : null,
			payerRole: "design",
			provenance: "trusted-native/1",
			evidenceRef: `fixture:native-store-witness:${i}`,
		});
	}
	const sources: ReportingFundingSources = {
		read: (kind, ref) => records.get(`${kind}:${ref}`),
		originalTask: (key) => tasks.find((t) => t.queue === key.queue && t.add.id === key.task),
		payer: (id) => payers.find((p) => p.factId === id),
		nativeRoot: (ref) => roots.find((r) => r.ref === ref),
		policyCoverage: (policyRef, from, through) => ({
			v: "funding-coverage/1",
			policyRef,
			from,
			through,
			observedAt: through,
			requiredStreams: ["fixture-stream"],
			wholePolicySubject: true,
		}),
	};
	function inputs(index: number, values: Input[]) {
		const t = tasks[index];
		t.requesterState = "recorded";
		t.add.origin = { v: 1, inputs: structuredClone(values) };
		t.proposalRef = `fixture:proposal:${index}`;
		const refs = values.map((_, n) => `fixture:accepted-input:${index}:${n}`);
		set("proposal", t.proposalRef, {
			v: "task-proposal/1",
			ref: t.proposalRef,
			task: structuredClone(payers[index].task),
			queueSession: t.queueSession,
			proposedAt: "2026-10-01T09:59:00.000Z",
			origin: structuredClone(t.add.origin),
			inputRefs: refs,
		});
		values.forEach((value, n) =>
			set("input", refs[n], {
				v: "requester-input/1",
				ref: refs[n],
				queueSession: t.queueSession,
				acceptedAt: "2026-10-01T09:58:00.000Z",
				input: structuredClone(value),
			}),
		);
	}
	inputs(1, [{ kind: "owner", channel: "browser", id: "ri-12345678" }]);
	return {
		input,
		sources,
		tasks,
		payers,
		roots,
		records,
		policy,
		inputs,
		set,
		row,
		run: () => projectReportingFunding(input, options(asOf), sources),
	};
}
function missing(result: ReportingFundingProjection, code: string, unallocated?: string) {
	expect(result.gaps.some((g) => g.code === code)).toBe(true);
	expect(result.remainingUsd).toBeNull();
	expect(result.budget?.remainingUsd ?? null).toBeNull();
	expect(result.observed.dedupKnownListUsd).toBe("0.6");
	if (unallocated) expect(result.budget?.unallocatedKnownListUsd).toBe(unallocated);
}
const owner = (channel: "browser" | "telegram" = "browser"): Extract<Input, { kind: "owner" }> => ({
	kind: "owner",
	channel,
	id: "ri-12345678",
});
const peer = (message: "question" | "request" | "reply", role = "qa"): Extract<Input, { kind: "role" }> => ({
	kind: "role",
	role,
	id: "rm-12345678",
	message,
});

describe("W4 independent reporting evidence, never dispatch authority", () => {
	it("exact 0.1 own + 0.2 requested + 0.3 Team, no float loss or hidden initiative spend", () => {
		const f = fixture();
		const before = structuredClone(f.input);
		const result = f.run();
		expect(result).toMatchObject({
			reportingOnly: true,
			fundingCoverage: "complete",
			observed: { dedupKnownListUsd: "0.6" },
			remainingUsd: "1999.9",
			gaps: [],
		});
		expect(result.budget).toMatchObject({
			verifiedOwnLowerBoundUsd: "0.1",
			exemptKnownListUsd: "0.5",
			unallocatedKnownListUsd: "0",
			remainingUsd: "1999.9",
			coverage: "complete",
		});
		expect(result.rows.allocations.map((a) => a.scope)).toEqual(["own", "requested", "team"]);
		expect(result.rows.roots).toEqual(f.roots);
		expect(f.input).toEqual(before);
	});
	it("live/default has no admitted native root or payer source, preserves all numeric usage", () => {
		const f = fixture();
		f.input.roots = structuredClone(f.roots);
		f.input.policies = [f.policy];
		f.input.allocations = f.run().rows.allocations;
		const result = projectReportingFunding(f.input, options());
		missing(result, "native-root-source-unavailable");
		expect(result.fundingCoverage).toBe("unavailable");
		expect(result.rows.roots).toEqual([]);
		expect(result.rows.allocations.every((a) => a.scope === "unknown" && a.rootRef === null)).toBe(true);
	});
	it("a matching-looking trusted-native DTO cannot replace the independent root port", () => {
		const f = fixture();
		f.input.roots = structuredClone(f.roots);
		delete f.sources.nativeRoot;
		const result = f.run();
		missing(result, "native-root-source-unavailable", "0.6");
		expect(result.rows.roots).toEqual([]);
	});
	it.each(["payer", "originalTask"] as const)("missing %s is not a default own or exempt allocation", (port) => {
		const f = fixture();
		delete f.sources[port];
		missing(f.run(), port === "payer" ? "payer-unavailable" : "task-unavailable", "0.6");
	});
	it("missing task binding never defaults legacy own", () => {
		const f = fixture();
		f.input.facts[0].links.task = null;
		missing(f.run(), "task-unavailable", "0.1");
	});
	it("no native sources and no usage still cannot manufacture USD 2000 headroom", () => {
		const f = fixture();
		f.input.facts = [];
		delete f.sources.nativeRoot;
		const result = f.run();
		expect(result.observed.dedupKnownListUsd).toBe("0");
		expect(result.remainingUsd).toBeNull();
		expect(result.budget?.remainingUsd).toBeNull();
	});
	it("unknown requester inside a verified in-scope task defaults own, not exemption", () => {
		const f = fixture();
		f.inputs(0, [{ kind: "unknown" }]);
		expect(f.run()).toMatchObject({ fundingCoverage: "complete", remainingUsd: "1999.9" });
	});
	it("legacy origin absence is not a present requester whose proposal/input binding is missing", () => {
		const f = fixture();
		f.tasks[0].requesterState = "recorded";
		missing(f.run(), "invalid-evidence", "0.1");
	});
	it.each([owner(), owner("telegram"), peer("question"), peer("request")])(
		"source-backed requested input %j",
		(value) => {
			const f = fixture();
			f.inputs(1, [value]);
			expect(f.run().fundingCoverage).toBe("complete");
		},
	);
	it.each([
		peer("reply"),
		{ ...peer("reply"), forOwner: true as const, ownerIds: ["rs-12345678"] },
		peer("request", "design"),
	])("reply/self/hint is not a request exemption: %j", (value) => {
		const f = fixture();
		f.inputs(1, [value]);
		f.roots[1].scope = "own";
		f.roots[1].policyRef = f.policy.ref;
		expect(f.run().budget).toMatchObject({
			verifiedOwnLowerBoundUsd: "0.3",
			exemptKnownListUsd: "0.3",
			remainingUsd: "1999.7",
		});
	});
	it("a requested root paired with only a reply fails, even with owner forwarding hints", () => {
		const f = fixture();
		f.inputs(1, [{ ...peer("reply"), forOwner: true }]);
		missing(f.run(), "native-root-mismatch", "0.2");
	});
	it("multiple independently bound requested inputs remain requested", () => {
		const f = fixture();
		f.inputs(1, [owner(), peer("question"), { ...peer("request", "docs"), id: "rm-87654321" }]);
		expect(f.run().fundingCoverage).toBe("complete");
	});
	it.each(
		[
			[owner(), { kind: "unknown" } as Input],
			[peer("request"), peer("reply")],
			[owner(), peer("request", "design")],
		].map((values) => ({ values })),
	)("mixed input scopes fail conservatively: $values", ({ values }) => {
		const f = fixture();
		f.inputs(1, values);
		missing(f.run(), "requester-mixed", "0.2");
	});
	it.each(["overflow", "unavailable"])("%s requester capture cannot become reassuring funding", (state) => {
		const f = fixture();
		f.tasks[0].requesterState = state;
		missing(f.run(), state === "overflow" ? "requester-overflow" : "requester-unavailable", "0.1");
	});
	it("oversized requester lists do not retain a partial exemption", () => {
		const f = fixture();
		f.inputs(
			1,
			Array.from({ length: 33 }, (_, i) => ({
				kind: "owner",
				channel: "browser",
				id: `ri-${String(i).padStart(8, "0")}`,
			})),
		);
		missing(f.run(), "evidence-limit", "0.2");
	});
	it.each(["proposal", "input"])("missing original %s evidence is not a valid-looking v1 record", (kind) => {
		const f = fixture();
		f.records.delete(kind === "proposal" ? `proposal:${f.tasks[1].proposalRef}` : "input:fixture:accepted-input:1:0");
		missing(f.run(), "requester-unavailable", "0.2");
	});
	it.each(["task", "queueSession", "proposedAt"])("foreign original proposal %s fails", (field) => {
		const f = fixture();
		const p = f.row("proposal", f.tasks[1].proposalRef!);
		p[field] =
			field === "task"
				? { ...f.payers[1].task, addedAt: "2026-10-02T10:00:00.000Z" }
				: field === "queueSession"
					? "other-session"
					: AS_OF;
		missing(f.run(), "requester-binding-mismatch", "0.2");
	});
	it("self-claimed owner requester contradicting the actual admitted peer reply fails", () => {
		const f = fixture();
		f.row("input", "fixture:accepted-input:1:0").input = peer("reply");
		missing(f.run(), "requester-binding-mismatch", "0.2");
	});
	it("approval/title/prose fields cannot substitute for a requester witness", () => {
		const f = fixture();
		Object.assign(f.tasks[1].add, { approval: "dialog", title: "owner requested" });
		missing(f.run(), "invalid-evidence", "0.2");
	});
	it.each(["op", "id", "ts"])("wrong original add %s (not assigned time or reused task number) fails", (field) => {
		const f = fixture();
		if (field === "op") f.tasks[0].add.op = "assigned";
		else if (field === "id") f.tasks[0].add.id = 19;
		else f.tasks[0].add.ts++;
		missing(f.run(), field === "id" ? "task-unavailable" : "task-birth-mismatch", "0.1");
	});
	it.each(["role", "task"])("payer %s must independently bind this task birth", (field) => {
		const f = fixture();
		if (field === "role") f.payers[0].role = "qa";
		else f.payers[0].task.addedAt = "2026-10-02T10:00:00.000Z";
		missing(f.run(), field === "role" ? "policy-mismatch" : "payer-mismatch", "0.1");
	});
	it.each(["role", "initiative", "weeklyUsd", "from"])("cross-role or unsupported source policy %s fails", (field) => {
		const f = fixture();
		f.row("cap", f.policy.sourceRef)[field] = field === "weeklyUsd" ? "9999" : "qa";
		missing(f.run(), "policy-mismatch");
	});
	it("generic policy support cannot add or change Design's cap", () => {
		const f = fixture();
		f.policy.weeklyUsd = "3000";
		f.row("cap", f.policy.sourceRef).weeklyUsd = "3000";
		missing(f.run(), "policy-mismatch");
	});
	it("no cap witness means no borrowed policy, even with a complete valid ReportingPolicy DTO", () => {
		const f = fixture();
		f.records.delete(`cap:${f.policy.sourceRef}`);
		f.input.policies = [structuredClone(f.policy)];
		missing(f.run(), "policy-unavailable");
		expect(f.run().rows.policies).toEqual([]);
	});
	it("the canonical policy selection must be backed by the recorded owner answer", () => {
		const f = fixture();
		f.row("rule", REPORTING_RULE_REF).picked = "Initiative only";
		missing(f.run(), "reporting-rule-unavailable", "0.6");
	});
	it("Team is independently source-backed, not a display label or borrowed Design cap", () => {
		const f = fixture();
		f.records.delete("team:bp-b7f97619");
		missing(f.run(), "policy-unavailable", "0.3");
	});
	it("reparent uses event-time history; today's parent cannot replace the earlier one", () => {
		const f = fixture();
		const fact = f.input.facts[0];
		fact.occurredAt = "2026-10-20T22:10:00.000Z";
		const current = {
			...f.tasks[0].history[0],
			initiative: "other-initiative",
			effectiveAt: "2026-10-20T22:20:00.000Z",
		};
		f.tasks[0].history.push(current);
		f.input.memberships.push(current);
		expect(f.run().fundingCoverage).toBe("complete");
		// A valid numeric row falsely substitutes today's parent for the occurrence's.
		fact.links.task = { ...current, effectiveAt: BIRTH };
		missing(f.run(), "parent-unavailable", "0.1");
	});
	it("valid reparent away from the budget initiative is unknown, never blanket own", () => {
		const f = fixture();
		const current = {
			...f.tasks[0].history[0],
			initiative: "other-initiative",
			effectiveAt: "2026-10-20T22:20:00.000Z",
		};
		f.tasks[0].history.push(current);
		f.input.facts[0].links.task = current;
		missing(f.run(), "policy-mismatch", "0.1");
	});
	it.each(["empty", "stale", "late-start", "conflicting"])("missing/ambiguous parent history: %s", (kind) => {
		const f = fixture();
		const t = f.tasks[0];
		if (kind === "empty") t.history = [];
		if (kind === "stale") t.historyThrough = "2026-10-20T22:59:59.000Z";
		if (kind === "late-start") t.history[0].effectiveAt = "2026-10-01T10:01:00.000Z";
		if (kind === "conflicting") t.history.push({ ...t.history[0], initiative: "other" });
		missing(f.run(), "parent-unavailable", "0.1");
	});
	it.each(["scope", "scopeRef", "payerRole", "policyRef", "occurredAt", "provenance"])(
		"native root %s must agree, never repaired by the adapter",
		(field) => {
			const f = fixture();
			const r = f.roots[0] as unknown as Rec;
			r[field] = field === "occurredAt" ? "2026-10-20T23:01:00.000Z" : field === "scope" ? "requested" : "foreign";
			missing(
				f.run(),
				field === "scope" || field === "provenance" ? "native-root-unavailable" : "native-root-mismatch",
				"0.1",
			);
		},
	);
	it("conflicting native witnesses invalidate every allocation sharing that root", () => {
		const f = fixture();
		f.payers[1].rootRef = f.roots[0].ref;
		let seen = 0;
		f.sources.nativeRoot = (ref) => {
			if (ref !== f.roots[0].ref) return f.roots.find((r) => r.ref === ref);
			return seen++ === 0 ? f.roots[0] : { ...f.roots[0], scope: "requested", policyRef: null };
		};
		const result = f.run();
		missing(result, "native-root-mismatch", "0.3");
		expect(result.rows.roots.map((r) => r.ref)).not.toContain(f.roots[0].ref);
		expect(result.budget?.verifiedOwnLowerBoundUsd).toBe("0");
	});
	it.each(["missing", "subset", "wrong-policy", "missing-stream"])(
		"policy-wide funding coverage %s leaves both remainders null",
		(kind) => {
			const f = fixture();
			const coverage = f.sources.policyCoverage!;
			if (kind === "missing") delete f.sources.policyCoverage;
			else
				f.sources.policyCoverage = (...args) => ({
					...(coverage(...args) as Rec),
					...(kind === "subset"
						? { wholePolicySubject: false }
						: kind === "wrong-policy"
							? { policyRef: "foreign" }
							: { requiredStreams: [] }),
				});
			missing(f.run(), "policy-coverage-unavailable", "0");
		},
	);
	it.each(["coverage", "pricing", "identity", "stale"])("numeric %s gaps cannot become a complete balance", (kind) => {
		const f = fixture();
		if (kind === "coverage") f.input.coverage[0].status = "unknown";
		if (kind === "pricing") Object.assign(f.input.facts[0].prices[0], { amount: null, status: "unpriced" });
		if (kind === "identity") f.input.facts[0].identityStatus = "unresolved";
		if (kind === "stale") {
			f.input.coverage[0].observedAt = "2026-10-20T22:58:00.000Z";
			f.input.coverage[0].through = "2026-10-20T22:58:00.000Z";
		}
		const result = f.run();
		expect(result.remainingUsd).toBeNull();
		expect(result.budget?.remainingUsd).toBeNull();
	});
	it.each([
		["2026-11-01T08:59:59.000Z", "2026-10-26T07:00:00.000Z"],
		["2026-11-01T09:00:00.000Z", "2026-10-26T07:00:00.000Z"],
		["2026-11-02T07:59:59.000Z", "2026-10-26T07:00:00.000Z"],
		["2026-11-02T08:00:00.000Z", "2026-11-02T08:00:00.000Z"],
		["2027-03-14T09:59:59.000Z", "2027-03-08T08:00:00.000Z"],
		["2027-03-14T10:00:00.000Z", "2027-03-08T08:00:00.000Z"],
		["2027-03-15T07:00:00.000Z", "2027-03-15T07:00:00.000Z"],
	])("Pacific occurrence week and DST %s", (asOf, start) => {
		const result = fixture(asOf).run();
		expect(result.observed.window.from).toBe(start);
		expect(result.remainingUsd).toBe("1999.9");
	});
	it("birth week is not the usage week; old occurrences stay visible only in their own window", () => {
		const f = fixture();
		f.input.facts[0].occurredAt = "2026-10-18T23:00:00.000Z";
		f.roots[0].occurredAt = "2026-10-18T22:00:00.000Z";
		expect(f.run()).toMatchObject({ observed: { dedupKnownListUsd: "0.5" }, remainingUsd: "2000" });
	});
	it("a throwing evidence port does not leak exceptions or drop observed usage", () => {
		const f = fixture();
		f.sources.payer = () => {
			throw new Error("private diagnostic must not escape");
		};
		const result = f.run();
		missing(result, "source-unavailable", "0.6");
		expect(JSON.stringify(result)).not.toContain("private diagnostic");
	});
	it("payload fields/accessors are refused without invoking them", () => {
		const f = fixture();
		let touched = false;
		Object.defineProperty(f.tasks[0].add, "title", {
			enumerable: true,
			get() {
				touched = true;
				throw new Error("payload");
			},
		});
		missing(f.run(), "invalid-evidence", "0.1");
		expect(touched).toBe(false);
	});
	it("a batch over the W0 row boundary retains observation, not partial funding or headroom", () => {
		const f = fixture();
		f.input.facts = Array.from({ length: FUNDING_LIMITS.rows + 1 }, () => structuredClone(f.input.facts[0]));
		const result = f.run();
		expect(result.observed.dedupKnownListUsd).toBe("0.1");
		expect(result.gaps.some((g) => g.code === "evidence-limit")).toBe(true);
		expect(result.remainingUsd).toBeNull();
		expect(result.rows.allocations).toEqual([]);
	});
});
