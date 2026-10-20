import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	accountUsage,
	addUsd,
	checkTaskBinding,
	factId,
	pacificWeekStart,
	pacificWeekStartUtc,
	parseAccountingInput,
	quoteListUsd,
	reconcileTemperUsd,
	taskId,
	type AccountingInput,
	type AccountingReport,
	type Basis,
	type RunSnapshot,
	type Tokens,
	type UsageFact,
} from "../../server/usage-accounting-contract.js";

const fixture = (name: string): unknown =>
	JSON.parse(readFileSync(new URL(`../fixtures/usage-accounting/${name}.json`, import.meta.url), "utf8"));
const numbers = fixture("numbers") as {
	mainUsd: string;
	warmUsd: string;
	delegateUsd: string;
	mainWarmUsd: string;
	mainDelegateUsd: string;
	doubleDelegateRedUsd: string;
	retryUsd: string;
	temperCallsUsd: string[];
	temperTotalUsd: string;
	doubleSummaryRedUsd: string;
	tokenRatesPerMillionUsd: Record<keyof Tokens, string>;
	tokens: Tokens;
	quotedUsd: string;
	pacificCases: [string, string, string][];
};
const AS_OF = "2026-10-20T12:00:00.000Z";
const options = { policyRef: "fixture:design-policy", asOf: AS_OF, staleAfterMs: 3_600_000 };
function ledger(): AccountingInput {
	const parsed = parseAccountingInput(fixture("ledger"));
	if (!parsed.ok) throw new Error(parsed.code);
	return parsed.value;
}
function report(input = ledger()): AccountingReport {
	return accountUsage(input, options);
}
function append(input: AccountingInput, attempt: string, amount: string): UsageFact {
	const f = structuredClone(input.facts[0]);
	f.identity.attempt = attempt;
	f.id = factId(f.identity);
	f.source.event = `event:${attempt}`;
	f.prices[0].amount = amount;
	input.facts.push(f);
	input.allocations.push({ ...input.allocations[0], factId: f.id });
	return f;
}
function alias(input: AccountingInput, secondary: UsageFact, primary = input.facts[0]): void {
	input.aliases.push({
		aliasFactId: secondary.id,
		canonicalFactId: primary.id,
		provenance: "native-call-map/1",
		evidenceRef: "fixture-only:alias",
	});
}
function snapshot(input: AccountingInput, amount: string, basis: Basis = "list-estimate"): RunSnapshot {
	return {
		producer: input.facts[0].identity.producer,
		incarnation: input.facts[0].identity.incarnation,
		run: "fixture-run",
		observedAt: AS_OF,
		state: "ended",
		price: { basis, currency: "USD", amount, status: "known", rateVersion: "fixture-rates/1" },
		coveredFactIds: input.facts.map((f) => f.id),
		coverage: "complete",
	};
}
function hasFault(value: AccountingReport, code: string): void {
	expect(value.faults.some((f) => f.code === code)).toBe(true);
	expect(value.remainingUsd).toBeNull();
}

describe("inert usage-accounting/1 exact synthetic fixtures", () => {
	it("closed fixture validates; exact own lower bound and reporting-only balance", () => {
		expect(report()).toMatchObject({
			reportingOnly: true,
			weekStart: "2026-10-19",
			grossKnownListUsd: "0.1",
			dedupKnownListUsd: "0.1",
			verifiedOwnLowerBoundUsd: "0.1",
			remainingUsd: "1999.9",
			faults: [],
			coverage: "complete",
		});
	});
	it("main plus successful cache-warm, including replay, not assistant-only", () => {
		const input = ledger();
		const warm = append(input, "warm-1", numbers.warmUsd);
		warm.kind = "cache-warm";
		input.facts.push(structuredClone(warm));
		expect(report(input).dedupKnownListUsd).toBe(numbers.mainWarmUsd);
		expect(report(input).dedupKnownListUsd).not.toBe("0.1");
	});
	it("decimal rates include four exclusive token classes, no binary rounding", () => {
		expect(quoteListUsd(numbers.tokens, numbers.tokenRatesPerMillionUsd)).toBe(numbers.quotedUsd);
		expect(addUsd(["0.1", "0.2", "0.000000000001"])).toBe("0.300000000001");
		expect(addUsd(["999999999999999999.999999999999", "0.000000000001"])).toBe("1000000000000000000");
		expect(quoteListUsd({ ...numbers.tokens, input: null }, numbers.tokenRatesPerMillionUsd)).toBeNull();
		expect(() =>
			quoteListUsd(
				{ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
				{ input: "0.000000000001", output: "0", cacheRead: "0", cacheWrite: "0" },
			),
		).toThrow("price-precision");
	});
	it.each(["separate", "merged", "wait-replay"])("ACP %s reporting does not add another actual charge", (mode) => {
		const input = ledger();
		const delegate = append(input, "delegate-1", numbers.delegateUsd);
		delegate.kind = "delegate";
		if (mode === "merged") {
			const merged = append(input, "merged-report", numbers.delegateUsd);
			merged.kind = "delegate";
			alias(input, merged, delegate);
			expect(addUsd(input.facts.map((f) => f.prices[0].amount!))).toBe(numbers.doubleDelegateRedUsd);
		} else if (mode === "wait-replay") input.facts.push(structuredClone(delegate), structuredClone(delegate));
		expect(report(input).grossKnownListUsd).toBe(
			mode === "merged" ? numbers.doubleDelegateRedUsd : numbers.mainDelegateUsd,
		);
		expect(report(input).dedupKnownListUsd).toBe(numbers.mainDelegateUsd);
	});
	it("Temper ended summary and replay are upserts, not additive leaves", () => {
		const input = ledger();
		input.facts[0].prices[0].amount = numbers.temperCallsUsd[0];
		append(input, "attempt-2", numbers.temperCallsUsd[1]);
		const s = snapshot(input, numbers.temperTotalUsd);
		input.snapshots.push({ ...s, observedAt: "2026-10-20T11:00:00.000Z", state: "running" }, s, structuredClone(s));
		expect(report(input).dedupKnownListUsd).toBe("0.1");
		expect(addUsd([report(input).dedupKnownListUsd, s.price.amount!])).toBe("0.2");
		expect(addUsd([numbers.temperTotalUsd, numbers.temperTotalUsd])).toBe("0.2");
		expect(report(input).faults).toEqual([]);
	});
	it("same Pi/Temper charge requires a native alias; leaves/run summaries never stack", () => {
		const input = ledger();
		const box = append(input, "box-1", numbers.mainUsd);
		const originalId = box.id;
		box.identity.producer = "temper";
		box.id = factId(box.identity);
		input.allocations.find((a) => a.factId === originalId)!.factId = box.id;
		alias(input, box);
		expect(report(input)).toMatchObject({ grossKnownListUsd: "0.2", dedupKnownListUsd: "0.1", faults: [] });
	});
	it("producer reconciliation includes retired attempts, interrupted calls and parked floor; final wins", () => {
		const agents = [
			{ endedUsd: "0.03", callsUsd: ["0.04", "0.06"] },
			{ endedUsd: null, callsUsd: ["0.02"] },
		];
		expect(reconcileTemperUsd({ finalUsd: null, parkedFloorUsd: "0.15", agents })).toEqual({
			spendUsd: "0.12",
			displayFloorUsd: "0.15",
		});
		expect(reconcileTemperUsd({ finalUsd: "0.11", parkedFloorUsd: "0.15", agents })).toEqual({
			spendUsd: "0.11",
			displayFloorUsd: "0.11",
		});
		expect(reconcileTemperUsd({ finalUsd: "0", parkedFloorUsd: null, agents })).toEqual({
			spendUsd: "0",
			displayFloorUsd: "0",
		});
	});
	it("copied/forked original history replays once, real retries and compaction are distinct attempts", () => {
		const input = ledger();
		input.facts.push(structuredClone(input.facts[0]));
		expect(report(input).dedupKnownListUsd).toBe("0.1");
		append(input, "retry-2", numbers.mainUsd);
		expect(report(input).dedupKnownListUsd).toBe("0.2");
		append(input, "compaction-3", numbers.warmUsd).kind = "compaction";
		expect(report(input).dedupKnownListUsd).toBe("0.22");
	});
	it("same numeric event under different attempts is unresolved, never two charges", () => {
		const input = ledger();
		append(input, "bad-copy", numbers.mainUsd).source.event = input.facts[0].source.event;
		const r = report(input);
		expect(r.dedupKnownListUsd).toBe("0");
		expect(r.unresolvedIdentities).toBe(2);
		hasFault(r, "unresolved-identity");
	});
	it("durable producer incarnation prevents independent attempts with reused local IDs merging", () => {
		const input = ledger();
		const retry = append(input, "other-instance", numbers.mainUsd);
		const oldId = retry.id;
		retry.identity = { ...input.facts[0].identity, incarnation: "fixture-instance-2" };
		retry.id = factId(retry.identity);
		input.allocations.find((a) => a.factId === oldId)!.factId = retry.id;
		expect(report(input).dedupKnownListUsd).toBe("0.2");
	});
	it.each(["unpriced", "unknown-model", "basis-unproven"] as const)(
		"%s list price is not a free zero or headroom",
		(status) => {
			const input = ledger();
			input.facts[0].prices[0] = { ...input.facts[0].prices[0], amount: null, status, rateVersion: null };
			const r = report(input);
			expect(r).toMatchObject({ dedupKnownListUsd: "0", unpricedFacts: 1, remainingUsd: null, coverage: "partial" });
		},
	);
	it("explicit versioned known zero is different from missing price", () => {
		const input = ledger();
		input.facts[0].prices[0].amount = "0";
		expect(report(input)).toMatchObject({
			dedupKnownListUsd: "0",
			unpricedFacts: 0,
			remainingUsd: "2000",
			coverage: "complete",
		});
	});
	it("provider and invoice amounts never impersonate list-price estimates", () => {
		const input = ledger();
		input.facts[0].prices.push(
			{ basis: "provider-reported", currency: "USD", amount: "0.05", status: "known", rateVersion: null },
			{ basis: "invoice", currency: "USD", amount: "0.07", status: "known", rateVersion: null },
		);
		expect(report(input)).toMatchObject({
			dedupKnownListUsd: "0.1",
			otherBases: [
				{ basis: "provider-reported", knownUsd: "0.05", unpriced: 0 },
				{ basis: "invoice", knownUsd: "0.07", unpriced: 0 },
			],
		});
		input.facts[0].prices[0] = { ...input.facts[0].prices[0], amount: null, status: "unpriced", rateVersion: null };
		expect(report(input).remainingUsd).toBeNull();
	});
	it("conflicting alias prices or actual model cannot pick a cheaper charge", () => {
		for (const change of ["price", "model"]) {
			const input = ledger();
			const copy = append(input, "copy", change === "price" ? "0.2" : numbers.mainUsd);
			if (change === "model") copy.model = "other-model";
			alias(input, copy);
			const r = report(input);
			expect(r.dedupKnownListUsd).toBe("0");
			hasFault(r, "identity-conflict");
		}
	});
	it("alias cycles, missing targets and contradictory mappings stay unresolved", () => {
		const input = ledger();
		const copy = append(input, "copy", numbers.mainUsd);
		alias(input, copy);
		alias(input, input.facts[0], copy);
		hasFault(report(input), "alias-cycle");
		input.aliases.pop();
		const absent = { ...copy, identity: { ...copy.identity, attempt: "absent" } };
		input.aliases[0].canonicalFactId = factId(absent.identity);
		hasFault(report(input), "missing-alias-target");
		input.aliases[0].canonicalFactId = input.facts[0].id;
		const third = append(input, "third", numbers.mainUsd);
		alias(input, copy, third);
		expect(report(input).dedupKnownListUsd).toBe("0");
		hasFault(report(input), "record-conflict");
	});
	it("append-only corrections supersede, replay safely, require full unambiguous history", () => {
		const input = ledger();
		const correction = structuredClone(input.facts[0]);
		correction.revision = 1;
		correction.supersedes = 0;
		correction.prices[0].amount = "0.12";
		input.facts.push(correction, structuredClone(correction));
		expect(report(input).dedupKnownListUsd).toBe("0.12");
		expect(input.facts).toHaveLength(3);
		input.facts.shift();
		hasFault(report(input), "revision-conflict");
	});
	it("same revision with conflicting price is not last-file-wins", () => {
		const input = ledger();
		const conflict = structuredClone(input.facts[0]);
		conflict.prices[0].amount = "0.01";
		input.facts.push(conflict);
		expect(report(input).dedupKnownListUsd).toBe("0");
		hasFault(report(input), "revision-conflict");
	});
	it("task birth uses canonical parent add, never child assignment time or task number alone", () => {
		const input = ledger();
		const f = input.facts[0];
		const original = structuredClone(f.links.task!);
		f.links.task!.addedAt = "2026-10-20T09:00:00.000Z";
		f.links.task!.effectiveAt = f.links.task!.addedAt;
		expect(taskId(original)).not.toBe(taskId(f.links.task!));
		expect(checkTaskBinding(f, input.memberships)).toBe("mismatch");
		hasFault(report(input), "task-binding-mismatch");
	});
	it.each(["queue", "project", "initiative"] as const)(
		"foreign/mismatched %s binding is rejected without omitting gross dollars",
		(field) => {
			const input = ledger();
			input.facts[0].links.task![field] = "foreign-value";
			expect(report(input)).toMatchObject({
				grossKnownListUsd: "0.1",
				verifiedOwnLowerBoundUsd: "0",
				unallocatedKnownListUsd: "0.1",
			});
			hasFault(report(input), "task-binding-mismatch");
		},
	);
	it("missing task and mixed untrusted home turn remain explicit, not inferred from a role", () => {
		const input = ledger();
		input.facts[0].links.task = null;
		input.allocations[0] = {
			...input.allocations[0],
			rootRef: null,
			scope: "unknown",
			policyRef: null,
			reason: "mixed-root",
		};
		expect(report(input)).toMatchObject({
			unallocatedFacts: 1,
			unallocatedKnownListUsd: "0.1",
			verifiedOwnLowerBoundUsd: "0",
		});
		hasFault(report(input), "unassigned-task");
	});
	it("event-time parent snapshots survive reparent; latest-parent red control fails", () => {
		const input = ledger();
		const after = append(input, "after-reparent", numbers.warmUsd);
		after.occurredAt = "2026-10-20T11:00:00.000Z";
		after.source.observedAt = "2026-10-20T11:01:00.000Z";
		input.allocations[1].recordedAt = after.source.observedAt;
		const parent = {
			...input.memberships[0],
			project: "new-project",
			initiative: "new-initiative",
			effectiveAt: "2026-10-20T10:30:00.000Z",
		};
		input.memberships.push(parent);
		after.links.task = structuredClone(parent);
		expect(report(input).dedupKnownListUsd).toBe(numbers.mainWarmUsd);
		expect(report(input).faults).toEqual([]);
		input.facts[0].links.task = structuredClone(parent);
		expect(parseAccountingInput(input)).toMatchObject({ ok: false, code: "future-membership" });
	});
	it.each(["requested", "team"] as const)("native verified %s is exempt without changing cap/policy", (scope) => {
		const input = ledger();
		input.roots[0].scope = scope;
		input.roots[0].policyRef = null;
		input.allocations[0].scope = scope;
		input.allocations[0].policyRef = null;
		expect(report(input)).toMatchObject({
			verifiedOwnLowerBoundUsd: "0",
			exemptKnownListUsd: "0.1",
			remainingUsd: "2000",
		});
	});
	it("no installed authenticated root: own/requested labels alone establish neither eligibility nor exemption", () => {
		for (const scope of ["own", "requested", "team"] as const) {
			const input = ledger();
			input.roots = [];
			input.allocations[0].scope = scope;
			input.allocations[0].policyRef = scope === "own" ? options.policyRef : null;
			expect(report(input)).toMatchObject({
				verifiedOwnLowerBoundUsd: "0",
				exemptKnownListUsd: "0",
				unallocatedKnownListUsd: "0.1",
			});
			hasFault(report(input), "unknown-allocation");
		}
	});
	it("helper payer is independent of dispatch origin; no implicit charge transfer", () => {
		const input = ledger();
		input.allocations[0].payerRole = "ops";
		hasFault(report(input), "unknown-allocation");
		expect(report(input).verifiedOwnLowerBoundUsd).toBe("0");
	});
	it("generic source-backed Architecture initiative policy is supported, never Design-hardcoded", () => {
		const input = ledger();
		const p = input.policies[0];
		Object.assign(p, {
			ref: "fixture:architecture-policy",
			role: "architecture",
			scopeRef: "initiative:system-arch-in-temper",
			sourceRef: "dr-9f87e79c317d",
		});
		Object.assign(input.roots[0], { policyRef: p.ref, payerRole: p.role, scopeRef: p.scopeRef });
		Object.assign(input.allocations[0], { policyRef: p.ref, payerRole: p.role });
		expect(accountUsage(input, { ...options, policyRef: p.ref })).toMatchObject({
			verifiedOwnLowerBoundUsd: "0.1",
			remainingUsd: "1999.9",
		});
	});
	it("policy/root occurrence cannot retroactively allocate an earlier call", () => {
		const input = ledger();
		input.roots[0].occurredAt = "2026-10-20T11:00:00.000Z";
		hasFault(report(input), "unknown-allocation");
		input.roots[0].occurredAt = "2026-10-20T09:00:00.000Z";
		input.policies[0].effectiveAt = "2026-10-20T11:00:00.000Z";
		hasFault(report(input), "unknown-allocation");
	});
	it.each(numbers.pacificCases)("Pacific Monday/DST: %s", (at, week, start) => {
		expect(pacificWeekStart(at)).toBe(week);
		expect(pacificWeekStartUtc(at)).toBe(start);
	});
	it("call occurrence, not task-add or observation week, determines numerator", () => {
		const input = ledger();
		input.facts[0].occurredAt = "2026-10-19T06:59:59.999Z";
		expect(report(input).dedupKnownListUsd).toBe("0");
		expect(report(input).weekStart).toBe("2026-10-19");
	});
	it.each(["partial", "unknown", "unavailable"] as const)(
		"%s/missing producers cannot establish headroom",
		(status) => {
			const input = ledger();
			input.coverage[0].status = status;
			hasFault(report(input), "source-coverage");
			input.coverage = [];
			hasFault(report(input), "source-coverage");
		},
	);
	it("late coverage start on Monday misses early costs despite correct calendar week", () => {
		const input = ledger();
		input.coverage[0].from = "2026-10-19T12:00:00.000Z";
		hasFault(report(input), "source-coverage");
	});
	it("stale/gapped watermark and unknown token coverage remain partial", () => {
		const input = ledger();
		input.coverage[0].observedAt = "2026-10-20T10:00:00.000Z";
		input.coverage[0].through = input.coverage[0].observedAt;
		expect(report(input).freshness).toBe("stale");
		hasFault(report(input), "source-coverage");
		const partial = ledger();
		partial.facts[0].tokens.cacheWrite = null;
		hasFault(report(partial), "partial-fact");
	});
	it("aggregate-only/newest1000 view or mismatched ended snapshot is not a complete ledger", () => {
		const input = ledger();
		input.snapshots.push(snapshot(input, "0.3"));
		hasFault(report(input), "snapshot-mismatch");
		input.snapshots[0].coverage = "partial";
		input.snapshots[0].coveredFactIds = [];
		input.facts = [];
		input.allocations = [];
		expect(report(input).dedupKnownListUsd).toBe("0");
		hasFault(report(input), "snapshot-coverage");
	});
	it("cross-week run reconciliation retains historical evidence but only debits call occurrence week", () => {
		const input = ledger();
		const previous = append(input, "previous-week", "0.1");
		previous.occurredAt = "2026-10-18T10:00:00.000Z";
		previous.source.observedAt = "2026-10-18T10:01:00.000Z";
		input.allocations[1].recordedAt = previous.source.observedAt;
		input.roots[0].occurredAt = "2026-10-17T09:00:00.000Z";
		input.snapshots.push(snapshot(input, "0.2"));
		expect(report(input)).toMatchObject({
			dedupKnownListUsd: "0.1",
			verifiedOwnLowerBoundUsd: "0.1",
			remainingUsd: "1999.9",
			coverage: "complete",
			faults: [],
		});
	});
	it("future observations and corrections cannot alter as-of totals", () => {
		const input = ledger();
		const future = append(input, "future", "10");
		future.source.observedAt = "2026-10-20T13:00:00.000Z";
		input.allocations[1].recordedAt = future.source.observedAt;
		expect(report(input).dedupKnownListUsd).toBe("0.1");
	});
	it.each(["running", "parked"] as const)("%s same-basis total above leaves prevents false headroom", (state) => {
		const input = ledger();
		input.snapshots.push({ ...snapshot(input, "0.20"), state });
		expect(report(input).dedupKnownListUsd).toBe("0.1");
		hasFault(report(input), "snapshot-mismatch");
	});
	it("all aliases must agree even when the primary lacks that basis/token field", () => {
		const input = ledger();
		for (const [attempt, amount] of [
			["a", "0.05"],
			["b", "0.07"],
		]) {
			const copy = append(input, attempt, numbers.mainUsd);
			copy.prices.push({ basis: "provider-reported", currency: "USD", amount, status: "known", rateVersion: null });
			alias(input, copy);
		}
		hasFault(report(input), "identity-conflict");
		expect(report(input).dedupKnownListUsd).toBe("0");
	});
	it("complementary nonconflicting alias price is retained once, without inventing a fallback model", () => {
		const input = ledger();
		const copy = append(input, "priced-copy", numbers.mainUsd);
		copy.prices.push({ basis: "invoice", currency: "USD", amount: "0.07", status: "known", rateVersion: null });
		input.facts[0].prices[0] = { ...input.facts[0].prices[0], amount: null, status: "unpriced", rateVersion: null };
		alias(input, copy);
		expect(report(input)).toMatchObject({
			dedupKnownListUsd: "0.1",
			unpricedFacts: 0,
			faults: [],
			otherBases: [
				{ basis: "provider-reported", knownUsd: "0", unpriced: 1 },
				{ basis: "invoice", knownUsd: "0.07", unpriced: 0 },
			],
		});
	});
	it("future immutable-field rewrites do not affect an earlier as-of projection", () => {
		const input = ledger();
		const later = structuredClone(input.facts[0]);
		later.revision = 1;
		later.supersedes = 0;
		later.source.observedAt = "2026-10-20T13:00:00.000Z";
		later.links.session = "future-session";
		input.facts.push(later);
		expect(report(input).faults).toEqual([]);
		expect(report(input).remainingUsd).toBe("1999.9");
		hasFault(accountUsage(input, { ...options, asOf: later.source.observedAt }), "rewritten-occurrence");
	});
	it("snapshot reconciliation uses merged alias prices, never an unpriced raw primary", () => {
		const input = ledger();
		const copy = append(input, "priced-alias", "0.1");
		alias(input, copy);
		input.facts[0].prices[0] = { ...input.facts[0].prices[0], amount: null, status: "unpriced", rateVersion: null };
		input.snapshots.push({ ...snapshot(input, "0.2"), coveredFactIds: [input.facts[0].id] });
		expect(report(input).dedupKnownListUsd).toBe("0.1");
		hasFault(report(input), "snapshot-mismatch");
	});
	it("unavailable same-basis snapshot comparison is partial, not certified complete", () => {
		const input = ledger();
		input.snapshots.push(snapshot(input, "0.2", "invoice"));
		hasFault(report(input), "snapshot-unpriced");
	});
	it("two conflicting alias tasks invalidate allocation even when primary task is null", () => {
		const input = ledger();
		const a = append(input, "task-a", "0.1");
		const b = append(input, "task-b", "0.1");
		alias(input, a);
		alias(input, b);
		input.facts[0].links.task = null;
		b.links.task!.task = 2;
		input.memberships.push(structuredClone(b.links.task!));
		expect(report(input)).toMatchObject({ verifiedOwnLowerBoundUsd: "0", unallocatedKnownListUsd: "0.1" });
		hasFault(report(input), "alias-allocation-conflict");
	});
	it("older conflicting snapshots fault once per version independently of replay order", () => {
		const input = ledger();
		const a = { ...snapshot(input, "0.1"), observedAt: "2026-10-20T11:00:00.000Z" };
		const b = { ...snapshot(input, "0.2"), observedAt: a.observedAt };
		const next = snapshot(input, "0.1");
		input.snapshots = [a, b, b, next];
		const first = report(input);
		for (const rows of [
			[b, a, b, next],
			[a, next, b, b],
			[next, b, b, a],
		]) {
			input.snapshots = rows;
			expect(report(input)).toEqual(first);
		}
		hasFault(first, "snapshot-conflict");
	});
	it("latest ambiguous snapshot is excluded rather than picked by replay order", () => {
		const input = ledger();
		const a = snapshot(input, "0.1");
		const b = snapshot(input, "0.2");
		input.snapshots = [a, b, b];
		const first = report(input);
		input.snapshots = [b, a, b];
		expect(report(input)).toEqual(first);
		hasFault(first, "snapshot-conflict");
	});
	it("deterministic replay order and key order do not change exact projection or input", () => {
		const input = ledger();
		append(input, "second", numbers.warmUsd);
		const before = JSON.stringify(input);
		const expected = report(input);
		const reordered = structuredClone(input);
		reordered.facts.reverse();
		reordered.allocations.reverse();
		expect(report(reordered)).toEqual(expected);
		expect(JSON.stringify(input)).toBe(before);
	});
	it.each([
		["version", (i: AccountingInput) => ({ ...i, v: 2 })],
		["payload bag", (i: AccountingInput) => ({ ...i, payload: {} })],
		[
			"negative tokens",
			(i: AccountingInput) => {
				i.facts[0].tokens.input = -1;
				return i;
			},
		],
		[
			"fractional tokens",
			(i: AccountingInput) => {
				i.facts[0].tokens.output = 0.5;
				return i;
			},
		],
		[
			"unsafe integer",
			(i: AccountingInput) => {
				i.facts[0].tokens.input = Number.MAX_SAFE_INTEGER + 1;
				return i;
			},
		],
		[
			"decimal exponent",
			(i: AccountingInput) => {
				i.facts[0].prices[0].amount = "1e-3";
				return i;
			},
		],
		[
			"decimal precision",
			(i: AccountingInput) => {
				i.facts[0].prices[0].amount = "0.0000000000001";
				return i;
			},
		],
		[
			"foreign currency",
			(i: AccountingInput) => ({
				...i,
				facts: [{ ...i.facts[0], prices: [{ ...i.facts[0].prices[0], currency: "EUR" }] }],
			}),
		],
		[
			"missing rate certainty",
			(i: AccountingInput) => {
				i.facts[0].prices[0].rateVersion = null;
				return i;
			},
		],
		[
			"unpriced zero",
			(i: AccountingInput) => {
				i.facts[0].prices[0].status = "unpriced";
				i.facts[0].prices[0].amount = "0";
				return i;
			},
		],
		[
			"noncanonical identity",
			(i: AccountingInput) => {
				i.facts[0].id = "other";
				return i;
			},
		],
		[
			"invalid date",
			(i: AccountingInput) => {
				i.facts[0].occurredAt = "2026-02-30T12:00:00.000Z";
				return i;
			},
		],
		[
			"local date",
			(i: AccountingInput) => {
				i.facts[0].occurredAt = "2026-10-20T12:00:00";
				return i;
			},
		],
		[
			"missing inventory",
			(i: AccountingInput) => {
				i.requiredStreams = [];
				return i;
			},
		],
		[
			"bad correction chain",
			(i: AccountingInput) => {
				i.facts[0].supersedes = 0;
				return i;
			},
		],
	] as const)("closed validator rejects %s rather than silently zeroing/exempting", (_name, change) => {
		const raw = change(ledger());
		expect(parseAccountingInput(raw).ok).toBe(false);
		expect(() => accountUsage(raw, options)).toThrow();
	});
});
