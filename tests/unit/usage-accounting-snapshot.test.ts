import { createHash } from "node:crypto";
import fs, { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { CollectorEvidence, CollectorEvidenceCode, NumericRows } from "../../server/usage-accounting-collector.js";
import { factId, type UsageFact } from "../../server/usage-accounting-contract.js";
import { createUsageMeterCache } from "../../server/usage-accounting-meter-cache.js";
import {
	METER_FAULT_CODES,
	parseMeterWorkerMessage,
	validateMeterSnapshot,
	type UsageMeterSnapshot,
} from "../../server/usage-accounting-meter-contract.js";
import type { SubjectUsageSource, UsageSubject } from "../../server/usage-accounting-roles.js";
import {
	buildUsageMeterSnapshot,
	type SnapshotBuildInput,
	type SnapshotPartition,
} from "../../server/usage-accounting-snapshot.js";

const AT = "2026-10-20T12:00:00.000Z";
const BIRTH = "2026-10-01T10:00:00.000Z";
const EPOCH = "a".repeat(64);
// Exhaustive: a new collector fault must get a preservation case before the typecheck passes.
const COLLECTOR_CODES: Record<CollectorEvidenceCode, true> = {
	"invalid-batch": true,
	"batch-limit": true,
	"time-limit": true,
	"unapproved-source": true,
	"source-unavailable": true,
	"native-unverified": true,
	"provenance-mismatch": true,
	"retention-gap": true,
	"truncated-source": true,
	"cursor-gap": true,
	"cursor-conflict": true,
	"revision-gap": true,
	"revision-conflict": true,
	"rewritten-occurrence": true,
	"metadata-conflict": true,
	"binding-mismatch": true,
	"event-conflict": true,
	"alias-conflict": true,
	"snapshot-conflict": true,
	"journal-tail": true,
	"journal-corrupt": true,
	"checkpoint-corrupt": true,
	"store-capacity": true,
	"io-failure": true,
	"collector-off": true,
	"index-unavailable": true,
	"inventory-partial": true,
};
const rows = (s: SubjectUsageSource): NumericRows => {
	const { facts, allocations, aliases, roots, policies, memberships, snapshots } = s.input;
	return structuredClone({ facts, allocations, aliases, roots, policies, memberships, snapshots });
};
function fixture(): SubjectUsageSource {
	return JSON.parse(
		readFileSync(new URL("../fixtures/usage-accounting-roles/source.json", import.meta.url), "utf8"),
	) as SubjectUsageSource;
}
function buildInput(s = fixture(), policy = true): SnapshotBuildInput {
	const evidence: CollectorEvidence = {
		v: "usage-collector-evidence/1",
		sequence: 7,
		asOf: AT,
		storage: "healthy",
		inventoryComplete: true,
		requiredStreams: ["fixture-stream"],
		faults: [],
		faultCounts: [],
	};
	return {
		epoch: EPOCH,
		asOf: AT,
		evidence,
		completed: true,
		coverage: structuredClone(s.input.coverage),
		sources: [
			{
				stream: "fixture-stream",
				status: {
					index: 0,
					kind: "pi",
					required: true,
					enabled: true,
					state: "complete",
					complete_through: AT,
					observedAt: AT,
					lastProgressAt: AT,
					stalled: false,
					alarm: null,
				},
			},
		],
		subjects: [
			{
				subject: { kind: "role", role: "design" },
				policy: policy ? { policyRef: "fixture:design-policy", policySubject: { kind: "role", role: "design" } } : null,
			},
		],
		partitions: [{ evidence: structuredClone(evidence), rows: rows(s), factRoles: structuredClone(s.factRoles) }],
	};
}
const parts = (b: SnapshotBuildInput) => b.partitions as SnapshotPartition[];
const build = (s = fixture(), policy = true) => buildUsageMeterSnapshot(buildInput(s, policy));
function retime(b: SnapshotBuildInput, at: string, sourceToo = false): void {
	b.asOf = at;
	b.evidence.asOf = at;
	for (const p of parts(b)) p.evidence.asOf = at;
	if (sourceToo) {
		for (const c of b.coverage) {
			c.through = at;
			c.observedAt = at;
		}
		for (const { status } of b.sources)
			if (status.kind !== "temper") {
				status.complete_through = at;
				status.observedAt = at;
				status.lastProgressAt = at;
			}
	}
}
function append(s: SubjectUsageSource, attempt: string, amount: string, role = "design"): UsageFact {
	const f = structuredClone(s.input.facts[0]);
	f.identity.attempt = attempt;
	f.id = factId(f.identity);
	f.source.event = `event:${attempt}`;
	f.prices[0].amount = amount;
	s.input.facts.push(f);
	s.input.allocations.push({ ...s.input.allocations[0], factId: f.id, payerRole: role });
	s.factRoles.push({ factId: f.id, role, evidenceRef: `fixture:witness:${attempt}` });
	return f;
}
function exempt(s: SubjectUsageSource, f: UsageFact, scope: "requested" | "team"): void {
	const allocation = s.input.allocations.find((a) => a.factId === f.id)!;
	const root = {
		...s.input.roots[0],
		ref: `fixture:${scope}`,
		scope,
		policyRef: null,
		payerRole: allocation.payerRole!,
	};
	s.input.roots.push(root);
	Object.assign(allocation, { rootRef: root.ref, scope, policyRef: null });
}
function headerFault(b: SnapshotBuildInput, code: CollectorEvidenceCode, n = 1): void {
	b.evidence.storage = "partial";
	b.evidence.faultCounts.push({ code, count: n });
	b.evidence.faults.push({ code: `collector:${code}`, ref: "/private/store/credential:NEVER-PUBLIC" });
	for (const p of parts(b)) p.evidence = structuredClone(b.evidence);
}
const subtotal = (v: UsageMeterSnapshot, i = 0) => v.subjects[i].list?.deduplicatedRecorded;
function wire(v: UsageMeterSnapshot): void {
	expect(validateMeterSnapshot(v)).toEqual(v);
	expect(parseMeterWorkerMessage(JSON.stringify(v))).toEqual(v);
	const c = createUsageMeterCache();
	c.activateEpoch(v.generation.epoch);
	expect(c.accept(JSON.stringify(v))).toBe(true);
}
function unknownRemainder(v: UsageMeterSnapshot): void {
	for (const s of v.subjects) expect(s.funding?.remainingUsd ?? null).toBeNull();
}

describe("#315 H-WIRE-5 subject-scoped fault-bearing worker fold", () => {
	it("matches the entire clean closed DTO exactly", () => {
		expect(build()).toEqual({
			v: "usage-meter-snapshot/1",
			reportingOnly: true,
			generation: { epoch: EPOCH, sequence: 7 },
			evaluatedAt: AT,
			weekStart: "2026-10-19",
			state: "ready",
			storage: "healthy",
			inventory: "complete",
			oldestCoveredThrough: AT,
			oldestObservedAt: AT,
			sources: [
				{
					index: 0,
					kind: "pi",
					required: true,
					enabled: true,
					state: "complete",
					complete_through: AT,
					observedAt: AT,
					lastProgressAt: AT,
					stalled: false,
					alarm: null,
				},
			],
			subjects: [
				{
					subject: { kind: "role", role: "design" },
					window: { from: "2026-10-19T07:00:00.000Z", through: AT },
					usageCoverage: "complete",
					fundingCoverage: "complete",
					freshness: "fresh",
					coveredThrough: AT,
					observedAt: AT,
					list: { grossObservations: "0.1", deduplicatedRecorded: "0.1" },
					otherBases: [
						{ basis: "invoice", knownUsd: "0", unpriced: 1 },
						{ basis: "provider-reported", knownUsd: "0", unpriced: 1 },
					],
					counts: { unpriced: 0, unresolvedIdentities: 0 },
					funding: {
						wholePolicySubject: true,
						verifiedOwnLowerBound: "0.1",
						exempt: "0",
						otherPolicy: "0",
						unallocated: "0",
						unallocatedFacts: 0,
						remainingUsd: "1999.9",
					},
					faults: [],
				},
			],
			faults: [],
		});
		wire(build());
	});
	it("partitions every independent source role; never copies global or payer totals", () => {
		const s = fixture();
		append(s, "ops-only", "17.000000000001", "ops");
		// Funding can disagree: independent observed source role still wins; no Ops policy is inferred.
		s.input.allocations[1].payerRole = "design";
		const b = buildInput(s, false);
		b.subjects.push(
			{ subject: { kind: "role", role: "ops" }, policy: null },
			{ subject: { kind: "role", role: "qa" }, policy: null },
		);
		const v = buildUsageMeterSnapshot(b);
		expect(v.subjects.map((s) => s.list?.deduplicatedRecorded)).toEqual(["0.1", "17.000000000001", "0"]);
		expect(
			v.subjects.every(
				(s) => s.usageCoverage === "complete" && s.fundingCoverage === "not-evaluated" && s.funding === null,
			),
		).toBe(true);
		wire(v);
	});
	it("requires per-fact independent binding, not a source label or guessed payer", () => {
		for (const missing of [true, false]) {
			const b = buildInput();
			parts(b)[0].factRoles = missing ? [] : [{ ...parts(b)[0].factRoles[0], role: null }];
			const v = buildUsageMeterSnapshot(b);
			expect(v.subjects[0].faults).toContainEqual({ code: "invalid-subject-binding", count: 1 });
			expect(v.subjects[0].usageCoverage).not.toBe("complete");
			unknownRemainder(v);
			wire(v);
		}
		const b = buildInput();
		parts(b)[0].factRoles[0].role = "ops";
		expect(subtotal(buildUsageMeterSnapshot(b))).toBe("0"); // A real independent Ops binding is not Design usage.
	});
	it("task/initiative binding remains independent when a role witness is missing", () => {
		const s = fixture();
		s.input.coverage[0].from = BIRTH;
		const b = buildInput(s, false);
		parts(b)[0].factRoles = [];
		b.subjects.push(
			{ subject: { kind: "task", queue: "fixture-queue", task: 1, addedAt: BIRTH }, policy: null },
			{ subject: { kind: "initiative", initiative: "fixture-initiative" }, policy: null },
		);
		const v = buildUsageMeterSnapshot(b);
		expect(v.subjects.map((s) => s.usageCoverage)).toEqual(["partial", "complete", "complete"]);
		expect(v.subjects.map((s) => s.list?.deduplicatedRecorded)).toEqual(["0", "0.1", "0.1"]);
		expect(v.faults).toEqual([]);
		wire(v);
	});
	it("preserves all requested/Team usage with no policy; separates exempt funding when supported", () => {
		const s = fixture();
		exempt(s, append(s, "requested", "0.2"), "requested");
		exempt(s, append(s, "team", "0.3"), "team");
		const v = build(s);
		expect(v.subjects[0].list).toEqual({ grossObservations: "0.6", deduplicatedRecorded: "0.6" });
		expect(v.subjects[0].funding).toEqual({
			wholePolicySubject: true,
			verifiedOwnLowerBound: "0.1",
			exempt: "0.5",
			otherPolicy: "0",
			unallocated: "0",
			unallocatedFacts: 0,
			remainingUsd: "1999.9",
		});
		s.input.policies = [];
		s.input.roots = [];
		s.input.allocations = [];
		const observed = build(s, false);
		expect(subtotal(observed)).toBe("0.6");
		expect(observed.subjects[0].usageCoverage).toBe("complete");
		expect(observed.subjects[0].funding).toBeNull();
		wire(observed);
		const unavailable = build(s, true);
		expect(subtotal(unavailable)).toBe("0.6");
		expect(unavailable.subjects[0].fundingCoverage).toBe("unavailable");
		unknownRemainder(unavailable);
		wire(unavailable);
	});
	it("zero is known; unpriced, missing source and null policy are distinct", () => {
		const s = fixture();
		s.input.facts[0].prices[0].amount = "0";
		expect(build(s).subjects[0]).toMatchObject({
			list: { deduplicatedRecorded: "0" },
			counts: { unpriced: 0 },
			usageCoverage: "complete",
		});
		s.input.facts[0].prices[0] = { ...s.input.facts[0].prices[0], amount: null, status: "unknown-model" };
		const unpriced = build(s);
		expect(unpriced.subjects[0]).toMatchObject({
			list: { deduplicatedRecorded: "0" },
			counts: { unpriced: 1 },
			usageCoverage: "partial",
		});
		unknownRemainder(unpriced);
		wire(unpriced);
		const b = buildInput();
		b.partitions = [];
		b.evidence.storage = "unavailable";
		headerFault(b, "collector-off");
		b.evidence.storage = "unavailable";
		const absent = buildUsageMeterSnapshot(b);
		expect(absent.subjects[0].list).toBeNull();
		unknownRemainder(absent);
		wire(absent);
	});
	it("keeps aliases/revisions/run reconciliation nonadditive within a complete component", () => {
		const s = fixture();
		const correction = structuredClone(s.input.facts[0]);
		correction.revision = 1;
		correction.supersedes = 0;
		correction.prices[0].amount = "0.2";
		s.input.facts.push(correction);
		const alias = append(s, "alias", "0.2");
		s.input.aliases.push({
			aliasFactId: alias.id,
			canonicalFactId: correction.id,
			provenance: "native-call-map/1",
			evidenceRef: "fixture:alias",
		});
		s.input.snapshots.push({
			producer: "pi",
			incarnation: correction.identity.incarnation,
			run: "fixture-run",
			observedAt: AT,
			state: "ended",
			price: { ...correction.prices[0], amount: "0.2" },
			coveredFactIds: [correction.id],
			coverage: "complete",
		});
		const v = build(s);
		expect(v.subjects[0].list).toEqual({ grossObservations: "0.4", deduplicatedRecorded: "0.2" });
		expect(v.subjects[0].funding?.remainingUsd).toBe("1999.8");
		wire(v);
	});
	it("reconciles a mixed-role run before scoping leaves, without copying or pruning its aggregate", () => {
		const s = fixture();
		const ops = append(s, "ops-run-leaf", "0.2", "ops");
		s.input.snapshots.push({
			producer: "pi",
			incarnation: ops.identity.incarnation,
			run: "fixture-run",
			observedAt: AT,
			state: "ended",
			price: { ...ops.prices[0], amount: "0.3" },
			coveredFactIds: [s.input.facts[0].id, ops.id],
			coverage: "complete",
		});
		const b = buildInput(s);
		b.subjects.push({ subject: { kind: "role", role: "ops" }, policy: null });
		const clean = buildUsageMeterSnapshot(b);
		expect(clean.subjects.map((s) => s.list?.deduplicatedRecorded)).toEqual(["0.1", "0.2"]);
		expect(clean.subjects.every((s) => s.usageCoverage === "complete")).toBe(true);
		wire(clean);
		parts(b)[0].rows.snapshots[0].price.amount = "0.4";
		const bad = buildUsageMeterSnapshot(b);
		expect(bad.subjects.map((s) => s.list?.deduplicatedRecorded)).toEqual(["0.1", "0.2"]);
		for (const view of bad.subjects) {
			expect(view.faults).toContainEqual({ code: "snapshot-conflict", count: 1 });
			expect(view.usageCoverage).toBe("partial");
		}
		unknownRemainder(bad);
		wire(bad);
	});
	it("folds separate complete components with exact decimal, not per-partition remainders", () => {
		const b = buildInput();
		const s = fixture();
		s.input.facts[0].identity.attempt = "second";
		s.input.facts[0].id = factId(s.input.facts[0].identity);
		s.input.facts[0].prices[0].amount = "0.200000000001";
		s.input.allocations[0].factId = s.input.facts[0].id;
		s.factRoles[0].factId = s.input.facts[0].id;
		parts(b).push({ evidence: structuredClone(b.evidence), rows: rows(s), factRoles: s.factRoles });
		const v = buildUsageMeterSnapshot(b);
		expect(subtotal(v)).toBe("0.300000000001");
		expect(v.subjects[0].funding?.remainingUsd).toBe("1999.699999999999");
		wire(v);
	});
	it("rejects split/repeated components, changed headers, incomplete scans and thrown iteration", () => {
		for (const [i, mutate] of [
			(b: SnapshotBuildInput) => {
				parts(b).push(structuredClone(parts(b)[0]));
			},
			(b: SnapshotBuildInput) => {
				parts(b)[0].evidence.sequence++;
			},
			(b: SnapshotBuildInput) => {
				b.completed = false;
			},
			(b: SnapshotBuildInput) => {
				b.partitions = {
					*[Symbol.iterator]() {
						yield parts(buildInput())[0];
						throw new Error("/private/path raw credential");
					},
				};
			},
		].entries()) {
			const b = buildInput();
			mutate(b);
			const v = buildUsageMeterSnapshot(b);
			expect(v.state).toBe("unavailable");
			expect(subtotal(v)).toBe(i < 2 ? undefined : "0.1");
			expect(v.faults).toContainEqual({ code: "index-unavailable", count: 1 });
			unknownRemainder(v);
			wire(v);
		}
	});
	it("retains birth lifetime and event-time initiative parents, never sums overlapping views", () => {
		const s = fixture();
		s.input.coverage[0].from = BIRTH;
		const priorWeek = append(s, "prior-week", "0.4");
		priorWeek.occurredAt = "2026-10-18T10:00:00.000Z";
		priorWeek.source.observedAt = "2026-10-18T10:01:00.000Z";
		const next = append(s, "reparented", "0.2");
		const membership = {
			...s.input.memberships[0],
			initiative: "next-initiative",
			effectiveAt: "2026-10-20T11:00:00.000Z",
		};
		s.input.memberships.push(membership);
		next.occurredAt = "2026-10-20T11:01:00.000Z";
		next.source.observedAt = "2026-10-20T11:02:00.000Z";
		next.links.task = structuredClone(membership);
		const b = buildInput(s, false);
		b.subjects.push(
			...[
				{ kind: "initiative", initiative: "fixture-initiative" },
				{ kind: "initiative", initiative: "next-initiative" },
				{ kind: "task", queue: "fixture-queue", task: 1, addedAt: BIRTH },
			].map((subject) => ({ subject: subject as UsageSubject, policy: null })),
		);
		const v = buildUsageMeterSnapshot(b);
		expect(v.subjects.map((s) => s.list?.deduplicatedRecorded)).toEqual(["0.3", "0.1", "0.2", "0.7"]);
		expect(v.subjects[3].window).toEqual({ from: BIRTH, through: AT });
		expect(v.subjects[3].subject).toEqual({
			kind: "task",
			queueKey: createHash("sha256").update("fixture-queue").digest("hex"),
			task: 1,
			addedAt: BIRTH,
		});
		wire(v);
		b.subjects[3].subject = { kind: "task", queue: "fixture-queue", task: 1, addedAt: "2026-10-02T10:00:00.000Z" };
		const wrongBirth = buildUsageMeterSnapshot(b);
		expect(wrongBirth.subjects[3].usageCoverage).not.toBe("complete");
		expect(wrongBirth.subjects[3].faults).toContainEqual({ code: "invalid-subject-binding", count: 1 });
		wire(wrongBirth);
	});
	it("initiative subtotal includes every role's requested and Team costs without inventing a policy", () => {
		const s = fixture();
		exempt(s, s.input.facts[0], "requested");
		exempt(s, append(s, "team-ops", "0.2", "ops"), "team");
		s.factRoles[1].role = null;
		const b = buildInput(s, false);
		b.subjects = [{ subject: { kind: "initiative", initiative: "fixture-initiative" }, policy: null }];
		const v = buildUsageMeterSnapshot(b);
		expect(subtotal(v)).toBe("0.3");
		expect(v.subjects[0].usageCoverage).toBe("complete");
		wire(v);
	});
	it("evaluates initiative funding only with its explicit full policy context", () => {
		const s = fixture();
		s.input.policies[0] = {
			...s.input.policies[0],
			ref: "fixture:init-policy",
			scopeRef: "initiative:fixture-initiative",
			weeklyUsd: "5",
		};
		s.input.roots[0] = {
			...s.input.roots[0],
			scopeRef: "initiative:fixture-initiative",
			policyRef: "fixture:init-policy",
		};
		s.input.allocations[0].policyRef = "fixture:init-policy";
		exempt(s, append(s, "requested", "0.2"), "requested");
		exempt(s, append(s, "team", "0.3", "ops"), "team");
		const b = buildInput(s, false);
		b.subjects = [
			{
				subject: { kind: "initiative", initiative: "fixture-initiative" },
				policy: {
					policyRef: "fixture:init-policy",
					policySubject: { kind: "initiative", initiative: "fixture-initiative" },
				},
			},
		];
		const v = buildUsageMeterSnapshot(b);
		expect(subtotal(v)).toBe("0.6");
		expect(v.subjects[0].funding).toEqual({
			wholePolicySubject: true,
			verifiedOwnLowerBound: "0.1",
			exempt: "0.5",
			otherPolicy: "0",
			unallocated: "0",
			unallocatedFacts: 0,
			remainingUsd: "4.9",
		});
		wire(v);
		parts(b)[0].factRoles[2].role = null;
		const incompleteFunding = buildUsageMeterSnapshot(b);
		expect(subtotal(incompleteFunding)).toBe("0.6");
		expect(incompleteFunding.subjects[0].fundingCoverage).toBe("unavailable");
		expect(incompleteFunding.subjects[0].funding).toBeNull();
		unknownRemainder(incompleteFunding);
		wire(incompleteFunding);
	});
	it("keeps Temper frontier diagnostic-only, never promotes it to complete coverage", () => {
		const b = buildInput();
		b.evidence.requiredStreams.push("temper:private");
		parts(b)[0].evidence = structuredClone(b.evidence);
		b.coverage.push({
			stream: "temper:private",
			from: "2026-10-19T07:00:00.000Z",
			through: AT,
			observedAt: AT,
			status: "unknown",
		});
		b.sources.push({
			stream: "temper:private",
			status: {
				index: 1,
				kind: "temper",
				required: true,
				enabled: true,
				state: "available",
				coverage: "unknown",
				observedAt: AT,
				frontier: {
					diagnosticOnly: true,
					recorded_through: AT,
					pending_count: 0,
					oldest_pending: null,
					last_drain: AT,
					assessed_from: AT,
					assessed_through: AT,
					freshness: "fresh",
					stallCodes: [],
				},
			},
		});
		const v = buildUsageMeterSnapshot(b);
		expect(subtotal(v)).toBe("0.1");
		expect(v.oldestCoveredThrough).toBeNull();
		expect(v.oldestObservedAt).toBe(AT);
		expect(v.subjects[0].usageCoverage).toBe("partial");
		unknownRemainder(v);
		wire(v);
	});
	it("retains required source coverage, oldest timestamps and stale rereads", () => {
		const b = buildInput();
		const old = "2026-10-20T11:59:30.000Z";
		b.evidence.requiredStreams.push("metadata:private");
		parts(b)[0].evidence = structuredClone(b.evidence);
		b.coverage.push({
			stream: "metadata:private",
			from: "2026-10-19T07:00:00.000Z",
			through: old,
			observedAt: old,
			status: "partial",
		});
		b.sources.push({
			stream: "metadata:private",
			status: {
				...b.sources[0].status,
				index: 1,
				kind: "metadata",
				complete_through: old,
				observedAt: old,
				lastProgressAt: old,
			} as (typeof b.sources)[0]["status"],
		});
		const v = buildUsageMeterSnapshot(b);
		expect(v.oldestCoveredThrough).toBe(old);
		expect(v.oldestObservedAt).toBe(old);
		expect(v.subjects[0].usageCoverage).toBe("partial");
		unknownRemainder(v);
		wire(v);
		const reread = buildInput();
		retime(reread, "2026-10-20T12:01:00.001Z");
		const stale = buildUsageMeterSnapshot(reread);
		expect(stale.state).toBe("stale");
		expect(stale.oldestObservedAt).toBe(AT);
		expect(subtotal(stale)).toBe("0.1");
		unknownRemainder(stale);
		wire(stale);
	});
	it.each(Object.keys(COLLECTOR_CODES) as CollectorEvidenceCode[])(
		"cannot omit collector %s from any subject or global faults",
		(code) => {
			const b = buildInput();
			b.subjects.push({ subject: { kind: "role", role: "ops" }, policy: null });
			headerFault(b, code, 3);
			const v = buildUsageMeterSnapshot(b);
			expect(v.faults).toContainEqual({ code, count: 3 });
			for (const s of v.subjects) {
				expect(s.faults).toContainEqual({ code, count: 3 });
				expect(s.usageCoverage).not.toBe("complete");
			}
			unknownRemainder(v);
			wire(v);
			// Fault-bearing header still prevents omission if a producer accidentally omits its count bucket.
			b.evidence.faultCounts = [];
			for (const p of parts(b)) p.evidence = structuredClone(b.evidence);
			expect(buildUsageMeterSnapshot(b).subjects[0].faults).toContainEqual({ code, count: 1 });
		},
	);
	it("computes source-stalled alarms from scalar progress without reclassifying a reread", () => {
		const b = buildInput();
		retime(b, "2026-10-20T12:05:00.000Z");
		const v = buildUsageMeterSnapshot(b);
		expect(v.sources[0]).toMatchObject({
			state: "partial",
			alarm: "source-stalled",
			stalled: true,
			lastProgressAt: AT,
		});
		expect(v.faults).toContainEqual({ code: "source-stalled", count: 1 });
		expect(subtotal(v)).toBe("0.1");
		unknownRemainder(v);
		wire(v);
	});
	it("public DTO contains no audit links, streams, paths, roots, raw errors or credential", () => {
		const s = fixture();
		s.evidenceRef = "/private/source/credential";
		s.input.roots[0].evidenceRef = "/private/native/stamp";
		const b = buildInput(s);
		headerFault(b, "journal-corrupt");
		const v = buildUsageMeterSnapshot(b);
		const text = JSON.stringify(v);
		expect(text).not.toMatch(
			/fixture-stream|fixture-queue|fixture-only|fixture:|\/private|credential|NEVER-PUBLIC|evidenceRef|rootRef|factId|policyRef|sourceRef|stack|raw/i,
		);
		wire(v);
	});
	it("public capacity fallback retains every subject and shared collector fault without an oversized wire DTO", () => {
		const b = buildInput();
		b.subjects = Array.from({ length: 256 }, (_, i) => ({
			subject: { kind: "role" as const, role: `role-${i}` },
			policy: null,
		}));
		for (const code of Object.keys(COLLECTOR_CODES) as CollectorEvidenceCode[]) headerFault(b, code);
		const v = buildUsageMeterSnapshot(b);
		expect(v.subjects).toHaveLength(256);
		expect(Buffer.byteLength(JSON.stringify(v))).toBeLessThanOrEqual(262144);
		expect(v.state).toBe("unavailable");
		for (const code of Object.keys(COLLECTOR_CODES)) expect(v.faults).toContainEqual({ code, count: 1 });
		expect(
			v.subjects.every(
				(s) =>
					s.list === null && s.usageCoverage === "unavailable" && s.faults.some((f) => f.code === "store-capacity"),
			),
		).toBe(true);
		wire(v);
		const c = createUsageMeterCache();
		c.activateEpoch(EPOCH);
		c.accept(JSON.stringify(v));
		for (const code of Object.keys(COLLECTOR_CODES))
			expect(c.getRole("role-0", AT)?.faults).toContainEqual({ code, count: 1 });
	});
	it("bounds dependency rows and safe decimal sums, never truncates into a clean subtotal", () => {
		const b = buildInput();
		parts(b)[0].rows.facts = Array.from({ length: 4097 }, () => structuredClone(parts(b)[0].rows.facts[0]));
		const v = buildUsageMeterSnapshot(b);
		expect(v.state).toBe("unavailable");
		expect(v.subjects[0].list).toBeNull();
		wire(v);
		const s = fixture();
		s.input.facts[0].prices[0].amount = "999999999999999999.999999999999";
		append(s, "overflow", "0.000000000001");
		const overflow = build(s);
		expect(overflow.state).toBe("unavailable");
		expect(overflow.subjects[0].list).toBeNull();
		wire(overflow);
	});
});

describe("#315 types-only main-thread cache", () => {
	it("requires the current epoch, increasing sequence and detached immutable ownership", () => {
		const c = createUsageMeterCache();
		const v = build();
		expect(c.accept(JSON.stringify(v))).toBe(false);
		expect(c.get(AT)).toBeNull();
		expect(c.activateEpoch(EPOCH)).toBe(true);
		expect(c.accept(JSON.stringify(v))).toBe(true);
		expect(c.accept(JSON.stringify(v))).toBe(false);
		const copy = c.get(AT)!;
		copy.subjects[0].list!.deduplicatedRecorded = "100";
		expect(c.getRole("design", AT)?.list?.deduplicatedRecorded).toBe("0.1");
		expect(c.getRole("ops", AT)).toBeNull();
		const next = structuredClone(v);
		next.generation.sequence++;
		expect(c.accept(JSON.stringify(next))).toBe(true);
		c.activateEpoch("b".repeat(64));
		expect(c.get(AT)).toBeNull();
		expect(c.accept(JSON.stringify(next))).toBe(false);
		next.generation.epoch = "b".repeat(64);
		next.generation.sequence = 0;
		expect(c.accept(JSON.stringify(next))).toBe(true);
	});
	it("instant age/week invalidation works with a blocked Worker and never refreshes timestamps", () => {
		const c = createUsageMeterCache();
		c.activateEpoch(EPOCH);
		c.accept(JSON.stringify(build()));
		expect(c.get("2026-10-20T12:01:00.000Z")?.state).toBe("ready");
		const stale = c.get("2026-10-20T12:01:00.001Z")!;
		expect(stale.state).toBe("stale");
		expect(stale.subjects[0].freshness).toBe("stale");
		expect(stale.oldestObservedAt).toBe(AT);
		unknownRemainder(stale);
		wire(stale);
		for (const [last, monday] of [
			["2026-10-26T06:59:59.999Z", "2026-10-26T07:00:00.000Z"],
			["2026-11-02T07:59:59.999Z", "2026-11-02T08:00:00.000Z"],
		]) {
			const b = buildInput();
			retime(b, last, true);
			const v = buildUsageMeterSnapshot(b);
			const weekCache = createUsageMeterCache();
			weekCache.activateEpoch(EPOCH);
			expect(weekCache.accept(JSON.stringify(v))).toBe(true);
			expect(weekCache.get(last)?.state).toBe("ready");
			expect(weekCache.get(monday)?.state).toBe("stale");
			unknownRemainder(weekCache.get(monday)!);
		}
	});
	it("fixed health downgrades retained subtotals; old health/snapshots cannot revive them", () => {
		const c = createUsageMeterCache();
		c.activateEpoch(EPOCH);
		c.accept(JSON.stringify(build()));
		const health = {
			v: "usage-meter-health/1",
			epoch: EPOCH,
			at: AT,
			state: "unavailable",
			code: "worker-unavailable",
		};
		expect(c.accept(JSON.stringify(health))).toBe(true);
		const v = c.get(AT)!;
		expect(v.state).toBe("unavailable");
		expect(subtotal(v)).toBe("0.1");
		unknownRemainder(v);
		wire(v);
		expect(c.accept(JSON.stringify({ ...health, state: "ready" }))).toBe(false);
		expect(c.accept(JSON.stringify(build()))).toBe(false);
	});
	it("closed wire validator agrees with W0 on optimistic and hostile mutations", () => {
		const clean = build();
		const mutations: ((v: Record<string, unknown>) => void)[] = [
			(v) => {
				v.path = "/private";
			},
			(v) => {
				v.reportingOnly = false;
			},
			(v) => {
				v.state = "ready-green";
			},
			(v) => {
				v.oldestObservedAt = "2026-10-20T12:00:00.001Z";
			},
			(v) => {
				v.weekStart = "2026-10-20";
			},
			(v) => {
				(v.subjects as UsageMeterSnapshot["subjects"])[0].list!.deduplicatedRecorded = "1e2";
			},
			(v) => {
				(v.subjects as UsageMeterSnapshot["subjects"])[0].counts.unpriced = 1;
			},
			(v) => {
				v.faults = [{ code: "journal-corrupt", count: 1 }];
			},
			(v) => {
				v.faults = [{ code: "/private/raw-error", count: 1 }];
			},
			(v) => {
				v.faults = [{ code: "unpriced", count: Number.MAX_SAFE_INTEGER + 1 }];
			},
			(v) => {
				(v.subjects as UsageMeterSnapshot["subjects"]).push(structuredClone(clean.subjects[0]));
			},
			(v) => {
				v.storage = "partial";
			},
			(v) => {
				v.inventory = "partial";
			},
			(v) => {
				(v.sources as UsageMeterSnapshot["sources"])[0].enabled = false;
			},
			(v) => {
				v.subjects = Array.from({ length: 257 }, () => clean.subjects[0]);
			},
		];
		for (const mutate of mutations) {
			const bad = structuredClone(clean) as unknown as Record<string, unknown>;
			mutate(bad);
			const text = JSON.stringify(bad);
			const c = createUsageMeterCache();
			c.activateEpoch(EPOCH);
			expect(parseMeterWorkerMessage(text)).toBeNull();
			expect(c.accept(text)).toBe(false);
		}
		for (const text of ["{", " ".repeat(262145), JSON.stringify({ ...clean, __proto__: { bypass: true } }) + "x"]) {
			const c = createUsageMeterCache();
			c.activateEpoch(EPOCH);
			expect(c.accept(text)).toBe(false);
		}
		const c = createUsageMeterCache();
		c.activateEpoch(EPOCH);
		expect(c.accept(clean)).toBe(false); // Wire strings only: getters/prototypes are never invoked.
	});
	it("has only a W0 type edge and getter performs zero filesystem operations", () => {
		const path = new URL("../../server/usage-accounting-meter-cache.ts", import.meta.url);
		const source = readFileSync(path, "utf8");
		const imports = source.match(/(?:^|\n)import[\s\S]*?from ["'][^"']+["'];/g) ?? [];
		expect(imports).toHaveLength(1);
		expect(imports[0]).toMatch(/^\s*import type\s/);
		expect(imports[0]).toContain('from "./usage-accounting-meter-contract.js"');
		expect(source).not.toMatch(/\bexport\s+(type\s+)?[\{*]/); // W0's separate positive AST graph guard covers all transitive main roots.
		expect(source).not.toMatch(
			/\b(import\(|require\(|readFile|writeFile|setInterval|setTimeout|usage-accounting-snapshot)/,
		);
		const c = createUsageMeterCache();
		c.activateEpoch(EPOCH);
		c.accept(JSON.stringify(build()));
		const read = vi.spyOn(fs, "readFileSync");
		const stat = vi.spyOn(fs, "statSync");
		const readdir = vi.spyOn(fs, "readdirSync");
		try {
			for (let i = 0; i < 10; i++) {
				c.get(AT);
				c.getRole("design", AT);
			}
			expect(read).not.toHaveBeenCalled();
			expect(stat).not.toHaveBeenCalled();
			expect(readdir).not.toHaveBeenCalled();
		} finally {
			read.mockRestore();
			stat.mockRestore();
			readdir.mockRestore();
		}
	});
	it("public fault vocabulary is finite and cache accepts each W0 code on partial evidence", () => {
		for (const code of METER_FAULT_CODES) {
			const v = build();
			v.subjects[0].usageCoverage = "partial";
			v.subjects[0].fundingCoverage = "partial";
			v.subjects[0].funding!.remainingUsd = null;
			v.faults = [{ code, count: 1 }];
			v.subjects[0].faults = [{ code, count: 1 }];
			wire(v);
		}
	});
});
