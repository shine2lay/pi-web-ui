import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { factId, type UsageFact } from "../../server/usage-accounting-contract.js";
import {
	projectObservedUsage,
	projectUsageCost,
	type LegacyManualInput,
	type ObservedUsageView,
	type ObservedUsageViewRequest,
	type SubjectUsageSource,
	type UsageCostView,
	type UsageSubject,
	type UsageViewRequest,
} from "../../server/usage-accounting-roles.js";

const fixture = (name: string): unknown =>
	JSON.parse(readFileSync(new URL(`../fixtures/usage-accounting-roles/${name}.json`, import.meta.url), "utf8"));
const cases = fixture("cases") as {
	manual: LegacyManualInput;
	pacific: [string, string, string][];
	exact: [string, string, string][];
};
const observedFixture = (name: string): unknown =>
	JSON.parse(readFileSync(new URL(`../fixtures/usage-accounting-observed/${name}.json`, import.meta.url), "utf8"));
const observedExpected = observedFixture("expected") as {
	options: { asOf: string; staleAfterMs: number; window: { from: string; through: string } };
	viewKeys: string[];
	gap: { firstThrough: string; nextFrom: string; firstObservedAt: string };
};
const observedSource = () => observedFixture("source") as SubjectUsageSource;
const observedRequest = (s = observedSource()): ObservedUsageViewRequest => ({
	subject: structuredClone(s.subject),
	asOf: observedExpected.options.asOf,
	staleAfterMs: observedExpected.options.staleAfterMs,
});
function noFunding(v: ObservedUsageView): void {
	expect(Object.keys(v)).toEqual(observedExpected.viewKeys);
	expect(v.fundingCoverage).toBe("not-evaluated");
	expect(v.funding).toBe("funding: not evaluated");
	const forbidden =
		/^(policy|policies|policyRef|policySubject|allocation|allocations|balance|progress|budget|budgetBar|remainingUsd|verifiedOwnLowerBoundUsd|exemptKnownListUsd|otherPolicyKnownListUsd|unallocatedKnownListUsd|unallocatedFacts|manual)$/;
	function keys(value: unknown): void {
		if (!value || typeof value !== "object") return;
		for (const [key, child] of Object.entries(value)) {
			expect(key).not.toMatch(forbidden);
			keys(child);
		}
	}
	keys(v);
	expect(JSON.stringify(v)).not.toMatch(/lower bound|spend/i);
}

const AT = "2026-10-20T12:00:00.000Z";
const source = () => fixture("source") as SubjectUsageSource;
const request = (): UsageViewRequest => ({
	subject: { kind: "role", role: "design" },
	policyRef: "fixture:design-policy",
	policySubject: { kind: "role", role: "design" },
	asOf: AT,
	staleAfterMs: 3_600_000,
});
const view = (s = source(), r = request(), manual?: unknown) => projectUsageCost(s, r, manual);
function scoped(s: SubjectUsageSource, subject: UsageSubject): UsageViewRequest {
	s.subject = structuredClone(subject);
	return { ...request(), subject };
}
function unknown(v: UsageCostView): void {
	expect(v.balance).toEqual({
		remainingUsd: null,
		label: "UNKNOWN — no certified budget remainder",
		tone: "neutral",
		progress: null,
	});
	expect(v.reportingOnly).toBe(true);
}
function invalid(v: UsageCostView, code: string): void {
	unknown(v);
	expect(v).toMatchObject({ state: "invalid", coverage: "unavailable", list: null, asOf: null, issues: [code] });
}
function append(s: SubjectUsageSource, attempt: string, amount: string): UsageFact {
	const f = structuredClone(s.input.facts[0]);
	f.identity.attempt = attempt;
	f.id = factId(f.identity);
	f.source.event = `fixture-event:${attempt}`;
	f.prices[0].amount = amount;
	s.input.facts.push(f);
	s.input.allocations.push({ ...s.input.allocations[0], factId: f.id });
	s.factRoles.push({ ...s.factRoles[0], factId: f.id });
	return f;
}
function exempt(s: SubjectUsageSource, f: UsageFact, scope: "requested" | "team"): void {
	const ref = `fixture-only:${scope}`;
	s.input.roots.push({ ...s.input.roots[0], ref, scope, policyRef: null });
	Object.assign(
		s.input.allocations.find((a) => a.factId === f.id)!,
		{ rootRef: ref, scope, policyRef: null },
	);
}
function architecture(s: SubjectUsageSource): UsageViewRequest {
	const p = s.input.policies[0];
	Object.assign(p, {
		ref: "fixture:architecture-policy",
		role: "architecture",
		scopeRef: "initiative:system-arch-in-temper",
		sourceRef: "dr-9f87e79c317d",
	});
	Object.assign(s.input.roots[0], { policyRef: p.ref, payerRole: p.role, scopeRef: p.scopeRef });
	Object.assign(s.input.allocations[0], { policyRef: p.ref, payerRole: p.role });
	s.factRoles[0].role = "architecture";
	s.input.memberships[0].initiative = "system-arch-in-temper";
	s.input.facts[0].links.task = structuredClone(s.input.memberships[0]);
	return {
		...scoped(s, { kind: "initiative", initiative: "system-arch-in-temper" }),
		policyRef: p.ref,
		policySubject: { kind: "initiative", initiative: "system-arch-in-temper" },
	};
}

describe("#302 inert subject-bound cost view — fixed synthetic evidence", () => {
	it("matches every field and label of the clean weekly view", () => {
		expect(view()).toEqual(fixture("complete-view"));
	});
	it.each(cases.exact)("exact USD %s -> recorded %s, reporting remainder %s", (amount, exact, remaining) => {
		const s = source();
		s.input.facts[0].prices[0].amount = amount;
		const v = view(s);
		expect(v.list?.grossObservations.usd).toBe(exact);
		expect(v.list?.deduplicatedRecorded.usd).toBe(exact);
		expect(v.list?.verifiedOwnLowerBound.usd).toBe(exact);
		expect(v.balance).toMatchObject({ remainingUsd: remaining, tone: "neutral", progress: null });
		expect(v.state).toBe("complete");
	});
	it("same-fact replay is idempotent; native alias changes gross observations, not recorded spend", () => {
		const s = source();
		s.input.facts.push(structuredClone(s.input.facts[0]));
		expect(view(s)).toEqual(view());
		const alias = append(s, "alias", "0.1");
		s.input.aliases.push({
			aliasFactId: alias.id,
			canonicalFactId: s.input.facts[0].id,
			provenance: "native-call-map/1",
			evidenceRef: "fixture-only:alias",
		});
		const v = view(s);
		expect(v.list?.grossObservations).toEqual({
			usd: "0.2",
			label: "Gross priced observations — may overlap; not a spend lower bound",
		});
		expect(v.list?.deduplicatedRecorded.usd).toBe("0.1");
		expect(v.list?.verifiedOwnLowerBound.usd).toBe("0.1");
	});
	it("numeric corrections replace, rather than add to, an earlier recorded amount", () => {
		const s = source();
		const revised = structuredClone(s.input.facts[0]);
		Object.assign(revised, { revision: 1, supersedes: 0 });
		revised.prices[0].amount = "0.2";
		revised.source.observedAt = "2026-10-20T11:00:00.000Z";
		s.input.facts.push(revised);
		const v = view(s);
		expect(v.list).toMatchObject({
			grossObservations: { usd: "0.2" },
			deduplicatedRecorded: { usd: "0.2" },
			verifiedOwnLowerBound: { usd: "0.2" },
		});
		expect(v.balance.remainingUsd).toBe("1999.8");
	});
	it("reconciled run snapshots are not added to the observation or deduplicated totals", () => {
		const s = source();
		s.input.snapshots.push({
			producer: "pi",
			incarnation: "fixture-instance",
			run: "fixture-run",
			observedAt: AT,
			state: "ended",
			price: s.input.facts[0].prices[0],
			coveredFactIds: [s.input.facts[0].id],
			coverage: "complete",
		});
		expect(view(s)).toEqual(view());
		s.input.snapshots[0].price = { ...s.input.facts[0].prices[0], amount: "0.2" };
		const v = view(s);
		expect(v.list?.deduplicatedRecorded.usd).toBe("0.1");
		expect(v.faults).toContainEqual({ code: "snapshot-mismatch", count: 1 });
		unknown(v);
	});
	it("retains requested and Team costs in initiative totals, separate from policy eligibility", () => {
		const s = source();
		exempt(s, append(s, "requested", "0.2"), "requested");
		exempt(s, append(s, "team", "0.3"), "team");
		const r = scoped(s, { kind: "initiative", initiative: "fixture-initiative" });
		const v = view(s, r);
		expect(v).toMatchObject({ state: "complete", coverage: "complete", issues: ["policy-subset"] });
		expect(v.list).toMatchObject({
			grossObservations: { usd: "0.6" },
			deduplicatedRecorded: { usd: "0.6" },
			verifiedOwnLowerBound: { usd: "0.1" },
			exempt: { usd: "0.5" },
			unallocated: { usd: "0" },
		});
		expect(v.policy).toMatchObject({ ref: r.policyRef, wholePolicySubject: false });
		unknown(v);
	});
	it.each(["requested", "team"] as const)("a wholly %s initiative is not omitted or shown as zero spend", (scope) => {
		const s = source();
		exempt(s, s.input.facts[0], scope);
		const v = view(s, scoped(s, { kind: "initiative", initiative: "fixture-initiative" }));
		expect(v.list).toMatchObject({
			deduplicatedRecorded: { usd: "0.1" },
			exempt: { usd: "0.1" },
			verifiedOwnLowerBound: { usd: "0" },
		});
		unknown(v);
	});
	it("generic Architecture initiative policy has its own supported source and exact reporting balance", () => {
		const s = source();
		const r = architecture(s);
		const v = view(s, r);
		expect(v).toMatchObject({
			state: "complete",
			policy: { role: "architecture", sourceRef: "dr-9f87e79c317d", wholePolicySubject: true },
		});
		expect(v.list?.deduplicatedRecorded.usd).toBe("0.1");
		expect(v.balance.remainingUsd).toBe("1999.9");
		expect(v.balance.label).toBe("Recorded policy remainder — reporting only, not spending permission");
	});
	it("a role slice of an initiative policy does not pretend to be the whole policy extent", () => {
		const s = source();
		const r = architecture(s);
		r.subject = { kind: "role", role: "architecture" };
		s.subject = r.subject;
		const v = view(s, r);
		expect(v.list?.verifiedOwnLowerBound.usd).toBe("0.1");
		expect(v.policy?.wholePolicySubject).toBe(false);
		unknown(v);
	});
	it("other-policy amounts stay in the subject total but not the selected own-policy subtotal", () => {
		const s = source();
		const f = append(s, "other-policy", "0.2");
		const p = { ...s.input.policies[0], ref: "fixture:other-policy", scopeRef: "initiative:other" };
		s.input.policies.push(p);
		s.input.roots.push({ ...s.input.roots[0], ref: "fixture-only:other-root", policyRef: p.ref, scopeRef: p.scopeRef });
		Object.assign(s.input.allocations[1], { factId: f.id, rootRef: "fixture-only:other-root", policyRef: p.ref });
		const v = view(s);
		expect(v.list).toMatchObject({
			deduplicatedRecorded: { usd: "0.3" },
			verifiedOwnLowerBound: { usd: "0.1" },
			otherPolicy: { usd: "0.2" },
		});
	});
	it("task slice uses canonical queue, number AND original birth, not policy-wide headroom", () => {
		const s = source();
		const m = s.input.memberships[0];
		const r = scoped(s, { kind: "task", queue: m.queue, task: m.task, addedAt: m.addedAt });
		const v = view(s, r);
		expect(v).toMatchObject({ state: "complete", subject: r.subject, issues: ["policy-subset"] });
		expect(v.list?.deduplicatedRecorded.usd).toBe("0.1");
		unknown(v);
	});
	it.each(["queue", "task", "addedAt"] as const)(
		"wrong task %s invalidates the subject rather than guessing",
		(field) => {
			const s = source();
			const m = s.input.memberships[0];
			const subject = { kind: "task" as const, queue: m.queue, task: m.task, addedAt: m.addedAt };
			if (field === "task") subject.task++;
			else subject[field] = field === "addedAt" ? "2026-10-01T11:00:00.000Z" : "foreign-queue";
			invalid(view(s, scoped(s, subject)), "invalid-subject-binding");
		},
	);
	it.each(["missing", "wrong-parent", "latest-parent"])(
		"initiative binding %s does not display guessed totals",
		(mode) => {
			const s = source();
			if (mode === "missing") s.input.facts[0].links.task = null;
			else if (mode === "wrong-parent") s.input.memberships[0].initiative = "foreign";
			else
				s.input.memberships.push({
					...s.input.memberships[0],
					initiative: "foreign",
					effectiveAt: "2026-10-20T09:30:00.000Z",
				});
			invalid(view(s, scoped(s, { kind: "initiative", initiative: "fixture-initiative" })), "invalid-subject-binding");
		},
	);
	it("historical initiative binding survives later reparenting; today's label cannot replace event time", () => {
		const s = source();
		s.input.memberships.push({
			...s.input.memberships[0],
			initiative: "new-initiative",
			effectiveAt: "2026-10-20T11:00:00.000Z",
		});
		expect(
			view(s, scoped(s, { kind: "initiative", initiative: "fixture-initiative" })).list?.deduplicatedRecorded.usd,
		).toBe("0.1");
		invalid(view(s, scoped(s, { kind: "initiative", initiative: "new-initiative" })), "invalid-subject-binding");
	});
	it("helper payer is independent of the queue/origin; only the verified helper role gets its view", () => {
		const s = source();
		const r = architecture(s);
		// The task remains in the original fixture queue/project; they do not supply a payer.
		r.subject = { kind: "role", role: "architecture" };
		s.subject = r.subject;
		expect(view(s, r).list?.deduplicatedRecorded.usd).toBe("0.1");
		r.subject = { kind: "role", role: "design" };
		s.subject = r.subject;
		invalid(view(s, r), "invalid-subject-binding");
	});
	it("mixed home turns show unallocated known usage, not inferred own/requested spend", () => {
		const s = source();
		s.input.facts[0].links.task = null;
		Object.assign(s.input.allocations[0], {
			rootRef: null,
			scope: "unknown",
			policyRef: null,
			payerRole: null,
			reason: "mixed-root",
		});
		const v = view(s);
		expect(v).toMatchObject({
			state: "partial",
			counts: { unallocated: 1 },
			issues: ["unallocated", "accounting-fault"],
		});
		expect(v.list).toMatchObject({
			grossObservations: { usd: "0.1" },
			verifiedOwnLowerBound: { usd: "0" },
			unallocated: { usd: "0.1" },
		});
		expect(v.faults).toContainEqual({ code: "unassigned-task", count: 1 });
		unknown(v);
	});
	it("unknown payer can stay visible on a task/initiative, but cannot be projected onto a role", () => {
		const s = source();
		s.factRoles[0].role = null;
		Object.assign(s.input.allocations[0], {
			rootRef: null,
			scope: "unknown",
			policyRef: null,
			payerRole: null,
			reason: "missing-root",
		});
		const v = view(s, scoped(s, { kind: "initiative", initiative: "fixture-initiative" }));
		expect(v.list?.deduplicatedRecorded.usd).toBe("0.1");
		unknown(v);
		invalid(view(s, scoped(s, { kind: "role", role: "design" })), "invalid-subject-binding");
	});
	it.each(["missing-root", "own-label", "requested-label", "team-label"])(
		"%s alone cannot certify allocation",
		(mode) => {
			const s = source();
			s.input.roots = [];
			if (mode === "requested-label" || mode === "team-label")
				Object.assign(s.input.allocations[0], { scope: mode === "team-label" ? "team" : "requested", policyRef: null });
			const v = view(s);
			expect(v.list).toMatchObject({
				verifiedOwnLowerBound: { usd: "0" },
				exempt: { usd: "0" },
				unallocated: { usd: "0.1" },
			});
			expect(v.counts?.unallocated).toBe(1);
			unknown(v);
		},
	);
	it.each(["unpriced", "unknown-model", "basis-unproven"] as const)(
		"%s is explicit; exact zero subtotal is NOT complete zero spend",
		(status) => {
			const s = source();
			Object.assign(s.input.facts[0].prices[0], { amount: null, status, rateVersion: null });
			const v = view(s);
			expect(v).toMatchObject({ state: "partial", counts: { unpriced: 1 }, issues: ["unpriced"] });
			expect(v.list?.deduplicatedRecorded.usd).toBe("0");
			expect(v.list?.verifiedOwnLowerBound.usd).toBe("0");
			unknown(v);
		},
	);
	it("subscription list estimate, provider amount and invoice retain three distinct bases", () => {
		const s = source();
		s.input.facts[0].prices.push(
			{ basis: "provider-reported", currency: "USD", amount: "0.05", status: "known", rateVersion: null },
			{ basis: "invoice", currency: "USD", amount: "0.07", status: "known", rateVersion: null },
		);
		let v = view(s);
		expect(v.list?.deduplicatedRecorded.usd).toBe("0.1");
		expect(v.otherBases).toEqual([
			{
				basis: "provider-reported",
				label: "Provider-reported amounts — separate basis",
				knownUsd: "0.05",
				unpriced: 0,
			},
			{ basis: "invoice", label: "Recorded invoice amounts — separate basis", knownUsd: "0.07", unpriced: 0 },
		]);
		expect(v.balance.remainingUsd).toBe("1999.9");
		Object.assign(s.input.facts[0].prices[0], { amount: null, status: "basis-unproven", rateVersion: null });
		v = view(s);
		expect(v.list?.deduplicatedRecorded.usd).toBe("0");
		expect(v.otherBases[0].knownUsd).toBe("0.05");
		unknown(v);
	});
	it("unresolved identity does not turn the gross observation into a deduplicated lower bound", () => {
		const s = source();
		s.input.facts[0].identityStatus = "unresolved";
		const v = view(s);
		expect(v.list).toMatchObject({
			grossObservations: { usd: "0.1" },
			deduplicatedRecorded: { usd: "0" },
			verifiedOwnLowerBound: { usd: "0" },
		});
		expect(v).toMatchObject({
			state: "partial",
			counts: { unresolvedIdentities: 1 },
			issues: ["unresolved-identity", "accounting-fault"],
		});
		unknown(v);
	});
	it("known alias conflict is safely coded and the raw source/fault references never leave the adapter", () => {
		const s = source();
		const f = append(s, "conflict", "0.2");
		s.input.aliases.push({
			aliasFactId: f.id,
			canonicalFactId: s.input.facts[0].id,
			provenance: "native-call-map/1",
			evidenceRef: "fixture-only:private-marker",
		});
		const v = view(s);
		expect(v.faults).toContainEqual({ code: "identity-conflict", count: 1 });
		expect(JSON.stringify(v)).not.toContain("private-marker");
		expect(JSON.stringify(v.faults)).not.toContain("fixture-instance");
		unknown(v);
	});
	it.each(["partial", "unknown", "unavailable", "missing"] as const)(
		"required source %s is not a free allowance",
		(status) => {
			const s = source();
			if (status === "missing") s.input.coverage = [];
			else s.input.coverage[0].status = status;
			const v = view(s);
			expect(v.sources[0].state).toBe(status);
			expect(v.state).toBe(status === "unavailable" || status === "missing" ? "source-unavailable" : "partial");
			expect(v.issues).toContain("source-incomplete");
			expect(v.list?.deduplicatedRecorded.usd).toBe("0.1");
			unknown(v);
		},
	);
	it("absent whole source is unavailable, not a fabricated zero report or no-budget permission", () => {
		const v = projectUsageCost(null, request());
		expect(v).toMatchObject({
			state: "source-unavailable",
			label: "Automatic source unavailable — total unknown",
			list: null,
			policy: null,
			counts: null,
		});
		unknown(v);
	});
	it("one missing stream suppresses any global as-of, while preserving the actual known subtotal", () => {
		const s = source();
		s.input.requiredStreams.push("fixture-missing-stream");
		const v = view(s);
		expect(v).toMatchObject({
			asOf: null,
			observedAt: null,
			freshness: "unknown",
			sources: [
				{ index: 0, state: "complete" },
				{ index: 1, state: "missing" },
			],
		});
		expect(v.list?.deduplicatedRecorded.usd).toBe("0.1");
		unknown(v);
	});
	it("stale source newly read stays stale, with the source timestamps rather than evaluation time", () => {
		const s = source();
		s.input.coverage[0].through = "2026-10-20T10:00:00.000Z";
		s.input.coverage[0].observedAt = s.input.coverage[0].through;
		const v = view(s);
		expect(v).toMatchObject({
			state: "stale",
			label: "Stale source — recorded subtotals only",
			asOf: "2026-10-20T10:00:00.000Z",
			observedAt: "2026-10-20T10:00:00.000Z",
			evaluatedAt: AT,
			freshness: "stale",
		});
		unknown(v);
	});
	it("recent reread of an old covered watermark does not freshen the underlying observations", () => {
		const s = source();
		s.input.coverage[0].through = "2026-10-20T10:00:00.000Z";
		const v = view(s);
		expect(v).toMatchObject({ state: "stale", asOf: "2026-10-20T10:00:00.000Z", observedAt: AT, freshness: "stale" });
		unknown(v);
	});
	it("conflicting coverage has no chosen watermark and is invariant to source order", () => {
		const s = source();
		s.input.coverage.push({ ...s.input.coverage[0], status: "partial" });
		const v = view(s);
		expect(v.sources[0]).toMatchObject({ state: "conflict", through: null });
		expect(v.freshness).toBe("unknown");
		s.input.coverage.reverse();
		expect(view(s)).toEqual(v);
		unknown(v);
	});
	it("partial numeric fact coverage is distinct from complete stream coverage", () => {
		const s = source();
		s.input.facts[0].tokens.cacheRead = null;
		const v = view(s);
		expect(v.sources[0].state).toBe("complete");
		expect(v).toMatchObject({ state: "partial", faults: [{ code: "partial-fact", count: 1 }] });
		unknown(v);
	});
	it("future usage/corrections do not change the earlier as-of view", () => {
		const s = source();
		const f = append(s, "future", "10");
		f.source.observedAt = "2026-10-20T13:00:00.000Z";
		s.input.allocations[1].recordedAt = f.source.observedAt;
		expect(view(s)).toEqual(view());
	});
	it.each([
		"unscoped",
		"foreign-role",
		"unknown-role",
		"missing-manifest",
		"conflicting-manifest",
		"foreign-allocation",
	])("%s is not copied onto every role", (mode) => {
		const s = source();
		if (mode === "unscoped") {
			invalid(projectUsageCost({ ...s, subject: { kind: "global" } }, request()), "invalid-subject-binding");
			return;
		}
		if (mode === "foreign-role") s.factRoles[0].role = "architecture";
		else if (mode === "unknown-role") s.factRoles[0].role = null;
		else if (mode === "missing-manifest") s.factRoles = [];
		else if (mode === "conflicting-manifest") s.factRoles.push({ ...s.factRoles[0], role: "architecture" });
		else s.input.allocations[0].payerRole = "architecture";
		invalid(view(s), "invalid-subject-binding");
	});
	it("a renamed role report still cannot absorb another role's facts into a global total", () => {
		const s = source();
		append(s, "foreign-helper", "0.2");
		s.factRoles[1].role = "architecture";
		s.input.allocations[1].payerRole = "architecture";
		invalid(view(s), "invalid-subject-binding");
	});
	it.each(["absent", "scope", "role", "conflict"])("%s policy binding is not guessed from a display label", (mode) => {
		const s = source();
		if (mode === "absent") s.input.policies = [];
		else if (mode === "scope") s.input.policies[0].scopeRef = "initiative:foreign";
		else if (mode === "role") s.input.policies[0].role = "architecture";
		else s.input.policies.push({ ...s.input.policies[0], weeklyUsd: "3000" });
		invalid(view(s), "invalid-policy-binding");
	});
	it("future policy label cannot activate spending or establish headroom", () => {
		const s = source();
		s.input.policies[0].effectiveAt = "2026-10-21T12:00:00.000Z";
		const v = view(s);
		expect(v.state).toBe("partial");
		expect(v.issues).toContain("policy-not-effective");
		unknown(v);
	});
	it("aggregate without mapped subject leaves invalidates binding, not a positive/zero role balance", () => {
		const s = source();
		s.input.snapshots.push({
			producer: "pi",
			incarnation: "fixture-instance",
			run: "fixture-run",
			observedAt: AT,
			state: "ended",
			price: s.input.facts[0].prices[0],
			coveredFactIds: [factId({ producer: "pi", incarnation: "fixture-instance", attempt: "absent" })],
			coverage: "partial",
		});
		invalid(view(s), "invalid-subject-binding");
	});
	it.each(["extra-payload", "wrong-currency", "exponent", "unpriced-zero", "bad-time"])(
		"malformed %s has a bounded error, no raw body/error echo",
		(mode) => {
			const s = source();
			let raw: unknown = s;
			if (mode === "extra-payload") raw = { ...s, error: "PRIVATE_RAW_ERROR_MARKER" };
			else if (mode === "wrong-currency")
				raw = {
					...s,
					input: {
						...s.input,
						facts: [{ ...s.input.facts[0], prices: [{ ...s.input.facts[0].prices[0], currency: "EUR" }] }],
					},
				};
			else if (mode === "exponent") s.input.facts[0].prices[0].amount = "1e-3";
			else if (mode === "unpriced-zero") s.input.facts[0].prices[0].status = "unpriced";
			else s.input.facts[0].source.observedAt = "PRIVATE_RAW_ERROR_MARKER";
			const v = projectUsageCost(raw, request());
			invalid(v, "invalid-source");
			expect(JSON.stringify(v)).not.toContain("PRIVATE_RAW_ERROR_MARKER");
		},
	);
	it.each([
		{ ...request(), staleAfterMs: -1 },
		{ ...request(), asOf: "2026-02-30T00:00:00.000Z" },
		{ ...request(), subject: { kind: "global" } },
		{
			...request(),
			policySubject: { kind: "task", queue: "fixture-queue", task: 1, addedAt: "2026-10-01T00:00:00.000Z" },
		},
		{ ...request(), extra: "PRIVATE_RAW_ERROR_MARKER" },
		null,
	])("closed request rejects malformed or unsupported fields", (r) => {
		invalid(projectUsageCost(source(), r as UsageViewRequest), "invalid-request");
	});
	it("manual stale/old-week amounts remain separate and never replace unavailable automatic totals", () => {
		const v = projectUsageCost(null, request(), cases.manual);
		expect(v.manual).toEqual({
			label: "Manual tally — stale/unverified reference only",
			legacyState: "stale",
			updatedAt: cases.manual.updatedAt,
			weekStart: "2026-10-10",
			weekEnd: "2026-10-18",
			spent: "$123.45",
			budget: "$2,000",
			byInitiative: [{ id: "fixture-initiative", amount: "$123.45" }],
		});
		expect(v.list).toBeNull();
		unknown(v);
	});
	it.each(["none", "unreadable", "old-week", "ok", "over", "stale"] as const)(
		"legacy %s remains explicitly manual, never a fresh automatic state or stop",
		(state) => {
			const m = structuredClone(cases.manual);
			const hasAmounts = state === "ok" || state === "over" || state === "stale";
			const raw = { ...m, spend: hasAmounts ? { ...m.spend, state } : { state, line: "Legacy reference" } };
			const v = view(source(), request(), raw);
			expect(v.manual).toMatchObject({
				legacyState: state,
				label: "Manual tally — stale/unverified reference only",
				updatedAt: m.updatedAt,
			});
			expect(v.balance.remainingUsd).toBe("1999.9");
			expect(v.state).toBe("complete");
		},
	);
	it("a manual reference does not become current after a new week/reread or on another subject", () => {
		const s = source();
		const first = view(s, request(), cases.manual).manual;
		const r = { ...request(), asOf: "2026-10-26T07:00:00.000Z" };
		const v = view(s, r, cases.manual);
		expect(v.manual).toEqual(first);
		expect(v).toMatchObject({ weekStart: "2026-10-26", freshness: "stale" });
		unknown(v);
		expect(view(s, request(), { ...cases.manual, role: "architecture" }).manual).toBeNull();
		expect(
			view(s, scoped(s, { kind: "initiative", initiative: "fixture-initiative" }), cases.manual).manual,
		).toBeNull();
	});
	it("manual prose/age are not reflected; missing update time stays unknown", () => {
		const m = {
			...cases.manual,
			updatedAt: null,
			spend: { ...cases.manual.spend, line: "PRIVATE_RAW_ERROR_MARKER", age: "fresh today" },
		};
		const v = view(source(), request(), m);
		expect(v.manual?.updatedAt).toBeNull();
		expect(JSON.stringify(v)).not.toMatch(/PRIVATE_RAW_ERROR_MARKER|fresh today/);
	});
	it.each(cases.pacific)("Pacific week and full-source coverage at %s", (at, week, start) => {
		const s = source();
		const m = {
			...s.input.memberships[0],
			addedAt: "2025-01-01T00:00:00.000Z",
			effectiveAt: "2025-01-01T00:00:00.000Z",
		};
		s.input.memberships = [m];
		s.input.facts[0].links.task = { ...m };
		s.input.facts[0].occurredAt = at;
		s.input.facts[0].source.observedAt = at;
		s.input.allocations[0].recordedAt = at;
		s.input.roots[0].occurredAt = m.addedAt;
		s.input.policies[0].effectiveAt = m.addedAt;
		s.input.coverage = [{ stream: "fixture-stream", from: start, through: at, observedAt: at, status: "complete" }];
		const r = { ...request(), asOf: at };
		expect(view(s, r)).toMatchObject({
			weekStart: week,
			state: "complete",
			asOf: at,
			sources: [{ from: start }],
			balance: { remainingUsd: "1999.9" },
		});
		if (at > start) {
			s.input.coverage[0].from = new Date(Date.parse(start) + 1).toISOString();
			unknown(view(s, r));
		}
	});
	it("Sunday occurrence observed on Monday is not assigned to the observation week", () => {
		const s = source();
		s.input.facts[0].occurredAt = "2026-10-19T06:59:59.999Z";
		s.input.roots[0].occurredAt = "2026-10-18T00:00:00.000Z";
		const v = view(s);
		expect(v).toMatchObject({ state: "complete", weekStart: "2026-10-19" });
		expect(v.list?.deduplicatedRecorded.usd).toBe("0");
	});
	it("projection is pure: order/replay do not alter view, input is untouched, outputs do not alias it", () => {
		const s = source();
		append(s, "second", "0.000000000001");
		const m = structuredClone(cases.manual);
		const before = JSON.stringify({ s, m });
		const v = view(s, request(), m);
		expect(JSON.stringify({ s, m })).toBe(before);
		s.input.facts.reverse();
		s.input.allocations.reverse();
		s.factRoles.reverse();
		expect(view(s, request(), m)).toEqual(v);
		v.policy!.weeklyUsd = "10";
		v.manual!.byInitiative[0].amount = "$0";
		expect(s.input.policies[0].weeklyUsd).toBe("2000");
		expect(m.spend).toMatchObject({ byInitiative: [{ amount: "$123.45" }] });
	});
	it("has no I/O/runtime-state imports or production reader wiring", () => {
		const module = readFileSync(new URL("../../server/usage-accounting-roles.ts", import.meta.url), "utf8");
		const imports = [...module.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
		expect(imports).toEqual(["./usage-accounting-contract.js", "./protocol.js"]);
		expect(module).toContain('import type { UiRoleSpend } from "./protocol.js"');
		expect(module).not.toMatch(/\b(?:fetch|readFile|writeFile|setInterval|setTimeout|readRoleSpend)\s*\(/);
		for (const path of [
			"server/roles-spend.ts",
			"server/roles-overview.ts",
			"server/protocol.ts",
			"web/src/roles-useful-model.ts",
		])
			expect(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")).not.toContain(
				'from "./usage-accounting-roles',
			);
	});
});

describe("policy-free observed subject view — H-AUTOCOST-4", () => {
	it("H4 fixed case: recorded 0.1, complete usage, zero unresolved, funding not evaluated", () => {
		const s = observedSource();
		const r = observedRequest(s);
		const before = JSON.stringify([s, r]);
		const v = projectObservedUsage(s, r);
		expect(s.input.policies).toEqual([]);
		expect(v).toMatchObject({
			v: "usage-observed-view/1",
			state: "complete",
			usageCoverage: "complete",
			freshness: "fresh",
			label: "recorded known list subtotal",
			window: observedExpected.options.window,
			list: { deduplicatedRecorded: { usd: "0.1", label: "recorded known list subtotal" } },
			counts: { unpriced: 0, unresolvedIdentities: 0 },
			issues: [],
			faults: [],
		});
		noFunding(v);
		expect(JSON.stringify([s, r])).toBe(before);
		expect(projectObservedUsage(s, r)).toEqual(v);
	});
	it("H4-D2 wrong-subject or unverified event-time membership is an invalid binding", () => {
		const changes: ((s: SubjectUsageSource) => void)[] = [
			(s) => {
				if (s.subject.kind === "task") s.subject.task = 2;
			},
			(s) => {
				s.input.memberships = [];
			},
			(s) => {
				s.input.memberships[0].effectiveAt = "2026-10-20T11:00:00.000Z";
			},
			(s) => {
				s.factRoles = [];
			},
			(s) => {
				s.subject = { kind: "role", role: "other-role" };
			},
		];
		for (const change of changes) {
			const s = observedSource();
			change(s);
			const v = projectObservedUsage(s, observedRequest(s));
			expect(v).toMatchObject({
				state: "invalid",
				usageCoverage: "unavailable",
				list: null,
				issues: ["invalid-subject-binding"],
			});
			noFunding(v);
		}
	});
	it("H4-D3 the view always carries unpriced and unresolved counts, not a fabricated known zero", () => {
		const s = observedSource();
		for (const f of s.input.facts) Object.assign(f.prices[0], { amount: null, status: "unpriced", rateVersion: null });
		const v = projectObservedUsage(s, observedRequest(s));
		expect(v).toMatchObject({
			state: "partial",
			usageCoverage: "partial",
			counts: { unpriced: 1, unresolvedIdentities: 0 },
			issues: ["unpriced"],
		});
		noFunding(v);
	});
	it("H4-D4 the whole task lifetime, not only this week, needs usage coverage", () => {
		const s = observedSource();
		s.input.coverage[0].from = "2026-10-19T07:00:00.000Z";
		const v = projectObservedUsage(s, observedRequest(s));
		expect(v).toMatchObject({ state: "partial", usageCoverage: "partial", window: observedExpected.options.window });
		expect(v.issues).toContain("source-incomplete");
		noFunding(v);
	});
	it("H4-D5 an allocation or policy present still emits no funding output or budget bar", () => {
		const s = observedSource();
		const before = projectObservedUsage(s, observedRequest(s));
		const policySource = source();
		s.input.allocations = policySource.input.allocations;
		s.input.roots = policySource.input.roots;
		s.input.policies = policySource.input.policies;
		const after = projectObservedUsage(s, observedRequest(s));
		noFunding(after);
		expect(after).toEqual(before);
	});
	it("roles are source attribution (own/requested mixed), never own-work spend", () => {
		const s = observedSource();
		s.subject = { kind: "role", role: "design" };
		Object.assign(s.input.allocations[0], {
			scope: "requested",
			rootRef: "fixture-only:requested",
			payerRole: "design",
			reason: "native-root",
		});
		const f = structuredClone(s.input.facts[0]);
		f.identity.attempt = "own-call";
		f.id = factId(f.identity);
		f.source.event = "own-call";
		s.input.facts.push(f);
		s.factRoles.push({ ...s.factRoles[0], factId: f.id });
		s.input.allocations.push({ ...s.input.allocations[0], factId: f.id, scope: "own" });
		const v = projectObservedUsage(s, observedRequest(s));
		expect(v).toMatchObject({
			state: "complete",
			usageCoverage: "complete",
			attribution: "usage source-attributed to this role — own and requested mixed",
			window: { from: "2026-10-19T07:00:00.000Z", through: AT },
			list: { deduplicatedRecorded: { usd: "0.2" } },
		});
		noFunding(v);
	});
	it("roles/initiatives accept explicit windows and otherwise default to the Pacific week", () => {
		for (const subject of [
			{ kind: "role", role: "design" },
			{ kind: "initiative", initiative: "fixture-initiative" },
		] as UsageSubject[]) {
			const s = observedSource();
			s.subject = subject;
			const r = observedRequest(s);
			expect(projectObservedUsage(s, r)).toMatchObject({
				usageCoverage: "complete",
				window: { from: "2026-10-19T07:00:00.000Z", through: AT },
			});
			r.window = structuredClone(observedExpected.options.window);
			expect(projectObservedUsage(s, r)).toMatchObject({ usageCoverage: "complete", window: r.window });
			s.input.coverage[0].from = "2026-10-19T07:00:00.000Z";
			expect(projectObservedUsage(s, r).usageCoverage).toBe("partial");
		}
	});
	it("keeps usage and funding coverage independent, with unknown counts for unavailable sources", () => {
		const r = observedRequest();
		for (const s of [null, undefined]) {
			const v = projectObservedUsage(s, r);
			expect(v).toMatchObject({
				state: "source-unavailable",
				usageCoverage: "unavailable",
				counts: { unpriced: null, unresolvedIdentities: null },
			});
			noFunding(v);
		}
		const s = observedSource();
		s.input.coverage[0].status = "unavailable";
		const v = projectObservedUsage(s, r);
		expect(v).toMatchObject({
			state: "source-unavailable",
			usageCoverage: "partial",
			counts: { unpriced: 0, unresolvedIdentities: 0 },
		});
		noFunding(v);
	});
	it("rejects policy-bearing requests and invalid task windows instead of silently borrowing a policy", () => {
		const s = observedSource();
		for (const r of [
			{ ...observedRequest(), policyRef: "fixture:borrowed" },
			{ ...observedRequest(), window: { from: "2026-10-19T07:00:00.000Z", through: AT } },
			{ ...observedRequest(), window: { from: AT, through: "2026-10-19T07:00:00.000Z" } },
			{ ...observedRequest(), asOf: "2026-10-01T09:59:59.999Z" },
		]) {
			const v = projectObservedUsage(s, r);
			expect(v).toMatchObject({
				state: "invalid",
				usageCoverage: "unavailable",
				list: null,
				issues: ["invalid-request"],
			});
			noFunding(v);
		}
	});
	it("treats a declared subject mismatch, malformed source and missing per-fact role evidence as invalid", () => {
		const s = observedSource();
		const r = observedRequest(s);
		s.subject = { kind: "role", role: "design" };
		expect(projectObservedUsage(s, r).issues).toEqual(["invalid-subject-binding"]);
		expect(projectObservedUsage({}, r).issues).toEqual(["invalid-source"]);
		const noRoles = observedSource();
		noRoles.factRoles = [];
		expect(projectObservedUsage(noRoles, r).issues).toEqual(["invalid-subject-binding"]);
	});
	it("keeps deterministic coverage conflicts, freshness and public fault sanitization", () => {
		const s = observedSource();
		const c = s.input.coverage[0];
		s.input.coverage.push({ ...c, status: "partial" });
		const r = observedRequest(s);
		const v = projectObservedUsage(s, r);
		expect(v).toMatchObject({ usageCoverage: "partial", asOf: null, freshness: "unknown" });
		s.input.coverage.reverse();
		expect(projectObservedUsage(s, r)).toEqual(v);
		const stale = observedSource();
		stale.input.coverage[0].through = "2026-10-20T10:00:00.000Z";
		stale.input.coverage[0].observedAt = "2026-10-20T10:00:00.000Z";
		expect(projectObservedUsage(stale, r)).toMatchObject({
			state: "stale",
			usageCoverage: "partial",
			freshness: "stale",
		});
		const unresolved = observedSource();
		for (const f of unresolved.input.facts) f.identityStatus = "unresolved";
		const unresolvedView = projectObservedUsage(unresolved, r);
		expect(unresolvedView).toMatchObject({
			usageCoverage: "partial",
			counts: { unresolvedIdentities: 1 },
			faults: [{ code: "unresolved-identity", count: 1 }],
		});
		expect(JSON.stringify(unresolvedView.faults)).not.toContain("fixture-instance");
	});
});
