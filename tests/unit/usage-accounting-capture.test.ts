import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	captureCapabilities,
	captureUsage,
	type CaptureEvidenceReaders,
	type CaptureProjection,
	type CaptureResult,
	type NativeAttemptEvidence,
	type NativePriceEvidence,
} from "../../server/usage-accounting-capture.js";
import {
	accountUsage,
	checkTaskBinding,
	factId,
	pacificWeekStart,
	pacificWeekStartUtc,
	parseAccountingInput,
	type AccountingInput,
	type TaskMembership,
	type Tokens,
} from "../../server/usage-accounting-contract.js";

const fixture = (name: string): unknown =>
	JSON.parse(readFileSync(new URL(`../fixtures/usage-accounting-capture/${name}.json`, import.meta.url), "utf8"));
const known = fixture("known") as {
	projection: CaptureProjection;
	attemptEvidence: NativeAttemptEvidence;
	priceEvidence: NativePriceEvidence;
	parentHistory: TaskMembership[];
	expectedAccounting: AccountingInput;
	expectedObservation: Extract<CaptureResult, { ok: true }>["observation"];
	expectedFaults: string[];
};
const cases = fixture("cases") as {
	charges: { attempt: string; kind: CaptureProjection["kind"]; amountUsd: string }[];
	totalUsd: string;
	retryTotalUsd: string;
	withoutReadersFaults: string[];
	withoutUsageFaults: string[];
	legacyFaults: string[];
	nullTokens: Tokens;
	pacificCases: [string, string, string][];
};
function input(): CaptureProjection {
	return structuredClone(known.projection);
}
/** Synthetic evidence only. These closures are not installed native adapters. */
function readers(c = input()): CaptureEvidenceReaders {
	return {
		attempt: () => ({
			...structuredClone(known.attemptEvidence),
			identity: c.identity,
			occurredAt: c.occurredAt,
			provider: c.provider,
			model: c.model,
			kind: c.kind,
			session: c.subject.session,
			run: c.subject.run,
			sourceStamp: { ...known.attemptEvidence.sourceStamp, event: c.event },
		}),
		price: () => {
			if (c.price.amountUsd === null) return null;
			return {
				...structuredClone(known.priceEvidence),
				amountUsd: c.price.amountUsd,
				provider: c.provider,
				model: c.model,
				basis: c.price.basis,
				rateVersion: c.price.rateVersion,
				evidenceRef: c.price.evidenceRef,
			};
		},
		parentHistory: () => structuredClone(known.parentHistory),
	};
}
function capture(c = input(), evidence = readers(c)): Extract<CaptureResult, { ok: true }> {
	const result = captureUsage(c, evidence);
	if (!result.ok) throw new Error(result.code);
	return result;
}
function combine(results: Extract<CaptureResult, { ok: true }>[]): AccountingInput {
	const a: AccountingInput = {
		v: 1,
		facts: [],
		allocations: [],
		aliases: [],
		roots: [],
		policies: [],
		memberships: [],
		snapshots: [],
		coverage: [],
		requiredStreams: [],
	};
	for (const result of results)
		for (const key of [
			"facts",
			"allocations",
			"aliases",
			"memberships",
			"snapshots",
			"coverage",
			"requiredStreams",
		] as const)
			(a[key] as unknown[]).push(...result.accounting[key]);
	a.requiredStreams = [...new Set(a.requiredStreams)];
	// Reporting fixture only; no payer/root or live policy registration.
	a.policies.push({
		ref: "fixture-only:report-policy",
		role: "design",
		scopeRef: "fixture-only:scope",
		effectiveAt: "2026-10-01T00:00:00.000Z",
		weeklyUsd: "2000",
		basis: "list-estimate",
		timeZone: "America/Los_Angeles",
		sourceRef: "fixture-only:policy-source",
	});
	return a;
}
function report(results: Extract<CaptureResult, { ok: true }>[]) {
	return accountUsage(combine(results), {
		policyRef: "fixture-only:report-policy",
		asOf: "2026-10-20T12:00:00.000Z",
		staleAfterMs: 3_600_000,
	});
}
function expectUnallocated(r: Extract<CaptureResult, { ok: true }>, reason = "missing-root") {
	expect(r.producerRegistered).toBe(false);
	expect(r.accounting.roots).toEqual([]);
	expect(r.accounting.policies).toEqual([]);
	expect(r.accounting.coverage).toEqual([]);
	for (const allocation of r.accounting.allocations)
		expect(allocation).toMatchObject({ rootRef: null, scope: "unknown", policyRef: null, payerRole: null, reason });
}

describe("capture/1 — exact synthetic projections, not live producer proofs", () => {
	it("matches every closed output field of the supported fixed fixture", () => {
		expect(capture()).toEqual({
			ok: true,
			projectionOnly: true,
			producerRegistered: false,
			accounting: known.expectedAccounting,
			observation: known.expectedObservation,
			faults: known.expectedFaults,
		});
		expect(parseAccountingInput(capture().accounting).ok).toBe(true);
	});
	it("trust-looking strings without native readers authenticate nothing", () => {
		const r = capture(input(), {});
		expect(r.faults).toEqual(cases.withoutReadersFaults);
		expect(r.observation).toEqual({
			...known.expectedObservation,
			identityStatus: "unresolved",
			taskStatus: "unavailable",
			priceStatus: "basis-unproven",
			unprovenUsd: "0.10",
		});
		expect(r.accounting.facts[0]).toMatchObject({
			identityStatus: "unresolved",
			prices: [{ basis: "list-estimate", amount: null, status: "basis-unproven", rateVersion: null }],
			links: { task: null },
		});
		expectUnallocated(r);
	});
	it("main + warm + compaction + delegate are four actual attempts, not assistant-only", () => {
		const results = cases.charges.map((charge) => {
			const c = input();
			c.identity!.attempt = charge.attempt;
			c.event = charge.attempt;
			c.kind = charge.kind;
			c.price.amountUsd = charge.amountUsd;
			return capture(c);
		});
		expect(results.map((r) => r.accounting.facts[0].kind)).toEqual([
			"assistant",
			"cache-warm",
			"compaction",
			"delegate",
		]);
		expect(report(results)).toMatchObject({
			grossKnownListUsd: cases.totalUsd,
			dedupKnownListUsd: cases.totalUsd,
			verifiedOwnLowerBoundUsd: "0",
			unallocatedKnownListUsd: cases.totalUsd,
			remainingUsd: null,
			coverage: "partial",
		});
		expect(report(results).dedupKnownListUsd).not.toBe("0.1");
		results.forEach((r) => expectUnallocated(r));
	});
	it("branch-summary remains identified and uses #293's compaction class", () => {
		const c = input();
		c.kind = "branch-summary";
		const r = capture(c);
		expect(r.observation.kind).toBe("branch-summary");
		expect(r.accounting.facts[0].kind).toBe("compaction");
	});
	it.each(["assistant", "cache-warm", "compaction", "delegate"] as const)(
		"reported failed/aborted %s usage survives",
		(kind) => {
			for (const outcome of ["error", "aborted"] as const) {
				const c = input();
				c.kind = kind;
				c.outcome = outcome;
				const r = capture(c);
				expect(r.observation.outcome).toBe(outcome);
				expect(r.accounting.facts[0].tokens).toEqual(known.expectedAccounting.facts[0].tokens);
				expect(r.accounting.facts[0].prices[0].amount).toBe("0.10");
			}
		},
	);
	it("failed attempt without reported usage is unknown, never free", () => {
		const c = input();
		c.outcome = "error";
		c.usageEvidence = "not-reported";
		c.price.amountUsd = null;
		for (const key of Object.keys(c.tokens) as (keyof typeof c.tokens)[]) c.tokens[key] = null;
		const r = capture(c);
		expect(r.faults).toEqual(cases.withoutUsageFaults);
		expect(r.observation).toMatchObject({
			outcome: "error",
			tokens: cases.nullTokens,
			priceStatus: "unpriced",
			unprovenUsd: null,
		});
		expect(r.accounting.facts[0].prices[0]).toEqual({
			basis: "list-estimate",
			amount: null,
			currency: "USD",
			status: "unpriced",
			rateVersion: null,
		});
		expect(report([r]).remainingUsd).toBeNull();
	});
	it("unreported initialized SDK zeros do not become token or price evidence", () => {
		const c = input();
		c.usageEvidence = "unknown";
		c.price.amountUsd = "0";
		for (const key of Object.keys(c.tokens) as (keyof typeof c.tokens)[]) c.tokens[key] = 0;
		const r = capture(c);
		expect(r.observation.tokens).toEqual(cases.nullTokens);
		expect(r.observation.reportedTokens).toEqual(c.tokens);
		expect(r.observation.unprovenUsd).toBe("0");
		expect(r.faults).toContain("unmarked-zero");
	});
	it.each(["provider", "model", "occurredAt", "identity"] as const)(
		"missing %s preserves an observation, not a fabricated fact",
		(field) => {
			const c = input();
			c[field] = null;
			const r = capture(c);
			expect(r.accounting.facts).toEqual([]);
			expect(r.observation[field]).toBeNull();
			expect(r.faults).toContain("fact-fields-unavailable");
		},
	);
	it.each(["rate", "evidence", "amount", "window", "model", "convention"])(
		"price %s gap cannot be backpriced",
		(gap) => {
			const c = input();
			const e = structuredClone(known.priceEvidence);
			if (gap === "rate") {
				c.price.rateVersion = null;
				e.rateVersion = null;
			}
			if (gap === "evidence") c.price.evidenceRef = null;
			if (gap === "amount") e.amountUsd = "0.09";
			if (gap === "window") e.validFrom = "2026-10-20T00:00:00.000Z";
			if (gap === "model") e.model = "fixture:other-model";
			if (gap === "convention") (e as unknown as Record<string, unknown>).tokenConvention = "raw-inclusive";
			const r = capture(c, { ...readers(c), price: () => e });
			expect(r.observation.priceStatus).toBe("basis-unproven");
			expect(r.observation.unprovenUsd).toBe("0.10");
			expect(r.accounting.facts[0].prices[0].amount).toBeNull();
		},
	);
	it("a source-proven explicit zero is allowed, an unmarked zero remains unknown", () => {
		const c = input();
		c.price.amountUsd = "0";
		c.price.zero = "explicit";
		const e = { ...known.priceEvidence, amountUsd: "0", explicitZero: true };
		expect(capture(c, { ...readers(c), price: () => e }).accounting.facts[0].prices[0].amount).toBe("0");
		c.price.zero = "unmarked";
		expect(capture(c, { ...readers(c), price: () => e }).observation.priceStatus).toBe("basis-unproven");
	});
	it.each(["provider-reported", "invoice"] as const)("known %s is separate from list, never summed twice", (basis) => {
		const c = input();
		c.price.basis = basis;
		c.price.rateVersion = null;
		const r = capture(c);
		expect(r.accounting.facts[0].prices).toEqual([
			{ basis: "list-estimate", currency: "USD", amount: null, status: "basis-unproven", rateVersion: null },
			{ basis, currency: "USD", amount: "0.10", status: "known", rateVersion: null },
		]);
		const totals = report([r]);
		expect(totals.dedupKnownListUsd).toBe("0");
		expect(totals.otherBases.find((p) => p.basis === basis)?.knownUsd).toBe("0.1");
		expect(totals.remainingUsd).toBeNull();
	});
	it.each(["raw-inclusive", "unknown"] as const)("%s token convention is not guessed/subtracted", (convention) => {
		const c = input();
		c.tokenConvention = convention;
		const r = capture(c);
		expect(r.observation.tokens).toEqual(cases.nullTokens);
		expect(r.observation.reportedTokens).toEqual(c.tokens);
		expect(r.faults).toContain("token-convention-unavailable");
		expect(r.accounting.facts[0].prices[0].amount).toBeNull();
	});
	it.each(["reasoning", "cacheWrite1h", "total"] as const)(
		"%s overlap/total mismatch invalidates normalization",
		(field) => {
			const c = input();
			c.tokens[field] = 999;
			const r = capture(c);
			expect(r.observation.tokens).toEqual(cases.nullTokens);
			expect(r.faults).toContain("token-convention-mismatch");
			expect(r.observation.priceStatus).toBe("basis-unproven");
		},
	);
	it("reasoning/cache-write subsets are not added twice", () => {
		expect(capture().observation.tokens).toEqual({ input: 100, output: 10, cacheRead: 30, cacheWrite: 5 });
	});
	it("partial numeric classes stay null rather than zero", () => {
		const c = input();
		c.tokens.cacheWrite = null;
		c.tokens.cacheWrite1h = null;
		c.tokens.total = null;
		const r = capture(c);
		expect(r.observation.tokens).toEqual({ input: 100, output: 10, cacheRead: 30, cacheWrite: null });
		expect(r.faults).toContain("partial-tokens");
	});
	it("restart/fork/replay preserve the original native source and first observation", () => {
		const c = input();
		c.observedAt = "2026-10-20T11:30:00.000Z";
		c.event = "fixture:copied-observation";
		c.stream = "fixture:fork-observer";
		const r = capture(c, readers(input()));
		expect(r.accounting.facts).toEqual(capture().accounting.facts);
		expect(r.accounting.allocations).toEqual(capture().accounting.allocations);
		expect(r.observation.event).toBe("fixture:copied-observation");
		expect(report([capture(), r, r]).dedupKnownListUsd).toBe("0.1");
		expect(report([capture(), r]).faults.some((f) => f.code === "revision-conflict")).toBe(false);
	});
	it("a real retry has a new native attempt, not a replay or another incarnation", () => {
		const results = cases.charges.map((charge) => {
			const c = input();
			c.identity!.attempt = charge.attempt;
			c.event = charge.attempt;
			c.kind = charge.kind;
			c.price.amountUsd = charge.amountUsd;
			return capture(c);
		});
		const retry = input();
		retry.identity!.attempt = "fixture:retry-2";
		retry.event = "fixture:retry-event";
		results.push(capture(retry));
		expect(report(results).dedupKnownListUsd).toBe(cases.retryTotalUsd);
	});
	it.each(["12345678", "file:/copied-session", "offset:128", "wait-result:1"])(
		"%s is not proven identity without a native reader",
		(attempt) => {
			const c = input();
			c.identity!.attempt = attempt;
			expect(capture(c, {}).observation.identityStatus).toBe("unresolved");
		},
	);
	it("a changed incarnation or moved occurrence is not accepted as a replay", () => {
		for (const field of ["identity", "occurredAt"] as const) {
			const c = input();
			if (field === "identity") c.identity!.incarnation = "fixture:copy-process";
			else c.occurredAt = "2026-10-19T09:00:00.000Z";
			const r = capture(c, readers(input()));
			expect(r.observation.identityStatus).toBe("unresolved");
			expect(r.faults).toContain("attempt-evidence-mismatch");
		}
	});
	it("cross-producer Pi/ACP overlap requires a native same-attempt alias", () => {
		const c = input();
		c.source = "acp/deb0e772";
		c.identity!.producer = "acp";
		c.stream = "fixture:acp";
		const missing = capture(c, {
			...readers(c),
			attempt: () => ({ ...known.attemptEvidence, identity: c.identity, overlap: "unknown" }),
		});
		expect(missing.observation.identityStatus).toBe("unresolved");
		expect(missing.accounting.aliases).toEqual([]);
		const mapped = capture(c, {
			...readers(c),
			attempt: () => ({
				...known.attemptEvidence,
				identity: c.identity,
				overlap: "alias",
				canonical: known.projection.identity,
			}),
		});
		expect(mapped.accounting.aliases).toEqual([
			{
				aliasFactId: factId(c.identity!),
				canonicalFactId: factId(known.projection.identity!),
				provenance: "native-call-map/1",
				evidenceRef: "fixture-only:native-attempt",
			},
		]);
		expect(report([capture(), mapped])).toMatchObject({
			grossKnownListUsd: "0.2",
			dedupKnownListUsd: "0.1",
			remainingUsd: null,
		});
	});
	it("Pi/Temper native alias projection cannot create the missing Temper feed", () => {
		const c = input();
		const canonical = { producer: "temper" as const, incarnation: "fixture:temper", attempt: "fixture:temper-call" };
		const absent = capture(c, { ...readers(c), attempt: () => ({ ...known.attemptEvidence, overlap: "unknown" }) });
		expect(absent.accounting.aliases).toEqual([]);
		const present = capture(c, {
			...readers(c),
			attempt: () => ({ ...known.attemptEvidence, overlap: "alias", canonical }),
		});
		expect(present.accounting.aliases[0].canonicalFactId).toBe(factId(canonical));
		expect(report([present]).faults.some((f) => f.code === "missing-alias-target")).toBe(true);
		expect(report([present]).dedupKnownListUsd).toBe("0");
		expectUnallocated(present);
	});
	it.each(["report", "snapshot"] as const)(
		"ACP separate/merged/wait %s is a nonadditive numeric observation",
		(shape) => {
			const c = input();
			c.source = "acp/deb0e772";
			c.identity = null;
			c.shape = shape;
			c.kind = "delegate";
			const r = capture(c);
			expect(r.accounting.facts).toEqual([]);
			expect(r.accounting.snapshots).toEqual([]);
			expect(r.observation).toMatchObject({ shape, identityStatus: "not-an-attempt", unprovenUsd: "0.10" });
			expect(report([capture(), r, r]).dedupKnownListUsd).toBe("0.1");
		},
	);
	it("legacy Temper amount remains useful but unproven, not a list/invoice leaf", () => {
		const c = input();
		c.source = "temper/legacy-summary";
		c.identity = null;
		c.shape = "snapshot";
		const r = capture(c);
		expect(r.faults).toEqual(cases.legacyFaults);
		expect(r.observation).toMatchObject({
			tokens: cases.nullTokens,
			reportedTokens: c.tokens,
			unprovenUsd: "0.10",
			priceStatus: "basis-unproven",
		});
		expect(r.accounting.facts).toEqual([]);
		expect(r.accounting.snapshots).toEqual([]);
		expect(report([capture(), r]).dedupKnownListUsd).toBe("0.1");
	});
	it("unsupported Temper attempts are explicitly unavailable, not invented SDK usage", () => {
		const c = input();
		c.source = "temper/legacy-summary";
		c.identity!.producer = "temper";
		const r = capture(c);
		expect(r.observation.identityStatus).toBe("unresolved");
		expect(r.accounting.facts).toEqual([]);
		expect(r.faults).toContain("source-attempt-unavailable");
	});
	it("original add and event-time parent win over later reparent/latest resumer", () => {
		const r = capture();
		expect(r.accounting.facts[0].links.task).toEqual(known.parentHistory[0]);
		expect(checkTaskBinding(r.accounting.facts[0], r.accounting.memberships)).toBe("verified");
		const c = input();
		c.occurredAt = "2026-10-20T01:00:00.000Z";
		const evidence = readers(c);
		evidence.attempt = () => ({
			...known.attemptEvidence,
			occurredAt: c.occurredAt,
			sourceStamp: { ...known.attemptEvidence.sourceStamp, observedAt: "2026-10-20T01:00:01.000Z" },
		});
		expect(capture(c, evidence).accounting.facts[0].links.task).toEqual(known.parentHistory[1]);
	});
	it.each(["add", "foreign-queue", "foreign-number", "assignment-time"])(
		"%s cannot replace canonical original task birth",
		(change) => {
			const c = input();
			if (change === "foreign-queue") c.task!.queue = "fixture:foreign";
			else if (change === "foreign-number") c.task!.task = 302;
			else c.task!.addedAt = change === "add" ? "2026-10-16T12:00:00.000Z" : "2026-10-18T12:00:00.000Z";
			const r = capture(c);
			expect(r.observation.taskStatus).toBe("mismatch");
			expect(r.accounting.facts[0].links.task).toBeNull();
		},
	);
	it("canonical history alone cannot attach a valid but foreign task to this attempt", () => {
		const c = input();
		c.task!.task = 302;
		const foreign = known.parentHistory.map((m) => ({ ...m, task: 302 }));
		const r = capture(c, { ...readers(c), parentHistory: () => foreign });
		expect(r.observation.taskStatus).toBe("mismatch");
		expect(r.accounting.facts[0].links.task).toBeNull();
		const noAttempt = capture(input(), { parentHistory: () => known.parentHistory });
		expect(noAttempt.observation.taskStatus).toBe("unavailable");
	});
	it.each(["latest-only", "conflict", "missing"])("%s parent history does not authenticate membership", (change) => {
		const history =
			change === "latest-only"
				? known.parentHistory.slice(1)
				: change === "missing"
					? []
					: [...known.parentHistory, { ...known.parentHistory[0], project: "fixture:conflicting" }];
		const r = capture(input(), { ...readers(), parentHistory: () => history });
		expect(r.observation.taskStatus).toBe("mismatch");
		expect(r.accounting.facts[0].links.task).toBeNull();
	});
	it.each(["design", "ops", "requested", "team"])(
		"observed %s/helper payer and grouping never supply policy eligibility",
		(role) => {
			const c = input();
			c.subject.role = role;
			c.ancestry = "mixed";
			const r = capture(c);
			expect(r.observation.subject.role).toBe(role);
			expectUnallocated(r, "mixed-root");
			expect(report([r])).toMatchObject({
				verifiedOwnLowerBoundUsd: "0",
				exemptKnownListUsd: "0",
				unallocatedKnownListUsd: "0.1",
				remainingUsd: null,
			});
		},
	);
	it.each(cases.pacificCases)(
		"occurrence %s keeps Pacific week %s even when observed later",
		(occurredAt, week, utc) => {
			const c = input();
			c.occurredAt = occurredAt;
			c.observedAt = "2027-01-01T00:00:00.000Z";
			c.task = null;
			const r = capture(c, {});
			expect(r.accounting.facts[0].occurredAt).toBe(occurredAt);
			expect(pacificWeekStart(r.accounting.facts[0].occurredAt)).toBe(week);
			expect(pacificWeekStartUtc(r.accounting.facts[0].occurredAt)).toBe(utc);
		},
	);
	it("capability report never advertises installed native identity/cause/feed", () => {
		expect(captureCapabilities()).toEqual(
			["pi-sdk/1.0.1", "acp/deb0e772", "temper/legacy-summary"].map((source, i) => ({
				source,
				producer: ["pi", "acp", "temper"][i],
				numericProjection: i === 2 ? "summary-only" : "supported",
				tokens: i === 2 ? "unavailable" : "pi-usage/1.0.1",
				nativeAttempts: "unavailable",
				priceEvidence: "unavailable",
				originalTaskBinding: "unavailable",
				nativeCause: "unavailable",
				liveProducer: false,
			})),
		);
	});
	it("output does not retain mutable caller or evidence objects", () => {
		const c = input();
		const e = structuredClone(known.attemptEvidence);
		const r = capture(c, { ...readers(c), attempt: () => e });
		c.tokens.input = 999;
		c.subject.role = "other";
		e.identity.attempt = "other";
		expect(r.observation.tokens.input).toBe(100);
		expect(r.observation.subject.role).toBe("design");
		expect(r.accounting.facts[0].identity.attempt).toBe("fixture:main-attempt");
	});
});

describe("strict metadata privacy and bounds", () => {
	it.each([
		"content",
		"messages",
		"data",
		"payload",
		"prompt",
		"toolArgs",
		"toolResults",
		"error",
		"credentials",
		"rootRef",
		"payerRole",
		"policyRef",
		"title",
		"requester",
		"lead",
		"approval",
	])("rejects unexpected %s with a fixed code, no echo", (key) => {
		const c = { ...input(), [key]: "fixture-only:must-not-escape" };
		expect(captureUsage(c)).toEqual({ ok: false, code: "closed-fields" });
	});
	it.each(["tokens", "price", "subject", "task", "identity"] as const)("rejects nested %s payload bags", (field) => {
		const c = input();
		Object.assign(c[field]!, { content: "fixture-only:must-not-escape" });
		expect(captureUsage(c)).toEqual({ ok: false, code: "closed-fields" });
	});
	it.each(["symbol", "hidden", "getter", "prototype"])("rejects %s fields without reading/logging them", (kind) => {
		const c = input();
		if (kind === "symbol") Object.defineProperty(c, Symbol("extra"), { value: 1 });
		if (kind === "hidden") Object.defineProperty(c, "extra", { value: 1, enumerable: false });
		if (kind === "getter")
			Object.defineProperty(c, "event", {
				enumerable: true,
				get: () => {
					throw new Error("fixture-only:must-not-escape");
				},
			});
		if (kind === "prototype") Object.setPrototypeOf(c, { extra: 1 });
		const r = captureUsage(c);
		expect(r.ok).toBe(false);
		expect(JSON.stringify(r)).not.toContain("must-not-escape");
	});
	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "1"])("rejects unsafe token count %s", (count) => {
		const c = input();
		(c.tokens as unknown as Record<string, unknown>).input = count;
		expect(captureUsage(c)).toEqual({ ok: false, code: "token-count" });
	});
	it.each(["-1", "1e3", "0.0000000000001", "9999999999999999999", "00", "1."])("rejects unsafe USD %s", (amount) => {
		const c = input();
		c.price.amountUsd = amount;
		expect(captureUsage(c)).toEqual({ ok: false, code: "decimal-usd" });
	});
	it("rejects overbound refs, invalid dates, future occurrence, wrong producer and version", () => {
		const mutations: ((c: CaptureProjection) => void)[] = [
			(c) => {
				c.event = "x".repeat(257);
			},
			(c) => {
				c.occurredAt = "2026-02-30T00:00:00.000Z";
			},
			(c) => {
				c.occurredAt = "2027-01-01T00:00:00.000Z";
			},
			(c) => {
				c.identity!.producer = "temper";
			},
			(c) => {
				(c as unknown as Record<string, unknown>).v = "other";
			},
		];
		for (const mutate of mutations) {
			const c = input();
			mutate(c);
			expect(captureUsage(c).ok).toBe(false);
		}
	});
	it("reader failures and invalid evidence return codes, never errors or values", () => {
		const r = capture(input(), {
			attempt: () => {
				throw new Error("fixture-only:must-not-escape");
			},
			price: () => ({ ...known.priceEvidence, content: "fixture-only:must-not-escape" }),
			parentHistory: () => new Array(1025).fill(known.parentHistory[0]),
		});
		expect(r.faults).toContain("attempt-evidence-invalid");
		expect(r.faults).toContain("price-evidence-invalid");
		const badHistory = capture(input(), {
			...readers(),
			parentHistory: () => new Array(1025).fill(known.parentHistory[0]),
		});
		expect(badHistory.faults).toContain("parent-history-invalid");
		expect(JSON.stringify(r)).not.toContain("must-not-escape");
	});
	it("the module imports only the frozen inert contract, not any producer/listener", () => {
		const source = readFileSync(new URL("../../server/usage-accounting-capture.ts", import.meta.url), "utf8");
		expect([...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])).toEqual(["./usage-accounting-contract.js"]);
		expect(source).not.toMatch(
			/node:|\.subscribe\(|\.on\(|setInterval\(|process\.env|fetch\(|console\.|JSON\.stringify\(raw/,
		);
	});
});
