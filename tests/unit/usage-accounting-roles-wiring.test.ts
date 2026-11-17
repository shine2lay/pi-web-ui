/// <reference types="vite/client" />
// @vitest-environment jsdom
// W7: synthetic admitted scalars + the actual projection, transport and DOM-completion seams.
// No native sources, live chats, worker starts, model requests or production browser interaction.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { IdentityDef } from "../../server/identities.js";
import type { ClientMessage, UiRoleUsageCost, UiRolesOverview } from "../../server/protocol.js";
import { RolesOverviewReader, roleUsageCost, type RolesOverviewHost } from "../../server/roles-overview.js";
import { createUsageMeterCache } from "../../server/usage-accounting-meter-cache.js";
import { validateMeterSnapshot, type UsageMeterSnapshot } from "../../server/usage-accounting-meter-contract.js";
import { projectExactRoles } from "../../web/src/roles-exact-model.js";
import { projectRolePanel } from "../../web/src/roles-panel-model.js";
import { resetRolesState } from "../../web/src/roles-state.js";
import { projectRoleUsageCost, projectSpend, projectUsefulRoles } from "../../web/src/roles-useful-model.js";
import type { UiRoleUsageCost as WebCost, UiRolesUsageRenderTiming as WebTiming } from "../../web/src/types.js";

const send = vi.hoisted(() => vi.fn<(msg: ClientMessage) => boolean>(() => true));
vi.mock("../../web/src/app-globals", () => ({ appSend: send, useAppField: () => "open" }));
const NOW = Date.parse("2026-10-20T19:00:00.000Z");
const ISO = new Date(NOW).toISOString();
const WEEK = "2026-10-19";
const EPOCH = "a".repeat(64);
const EXACT = "9007199254740993.123456789012";
const cleanups: (() => void)[] = [];
const generation = { epoch: EPOCH, sequence: 7 };
const iso = (ms: number) => new Date(ms).toISOString();

function snapshot(temper = false): UsageMeterSnapshot {
	return {
		v: "usage-meter-snapshot/1",
		reportingOnly: true,
		generation: { ...generation },
		evaluatedAt: ISO,
		weekStart: WEEK,
		state: "ready",
		storage: "healthy",
		inventory: "complete",
		oldestCoveredThrough: temper ? null : ISO,
		oldestObservedAt: ISO,
		sources: temper
			? [
					{
						index: 0,
						kind: "temper",
						required: true,
						enabled: true,
						state: "available",
						coverage: "unknown",
						observedAt: ISO,
						frontier: {
							diagnosticOnly: true,
							recorded_through: ISO,
							pending_count: 0,
							oldest_pending: null,
							last_drain: ISO,
							assessed_from: "2026-10-19T07:00:00.000Z",
							assessed_through: ISO,
							freshness: "fresh",
							stallCodes: [],
						},
					},
				]
			: [
					{
						index: 0,
						kind: "pi",
						required: true,
						enabled: true,
						state: "complete",
						complete_through: ISO,
						observedAt: ISO,
						lastProgressAt: ISO,
						stalled: false,
						alarm: null,
					},
				],
		subjects: [
			{
				subject: { kind: "role", role: "ops" },
				window: { from: "2026-10-19T07:00:00.000Z", through: ISO },
				usageCoverage: temper ? "partial" : "complete",
				fundingCoverage: "not-evaluated",
				freshness: "fresh",
				coveredThrough: temper ? null : ISO,
				observedAt: ISO,
				list: { grossObservations: EXACT, deduplicatedRecorded: EXACT },
				otherBases: [
					{ basis: "provider-reported", knownUsd: "0.000000000001", unpriced: 0 },
					{ basis: "invoice", knownUsd: "14.0", unpriced: 0 },
				],
				counts: { unpriced: 0, unresolvedIdentities: 0 },
				funding: null,
				faults: [],
			},
		],
		faults: [],
	};
}
function cached(value = snapshot()) {
	const cache = createUsageMeterCache();
	expect(validateMeterSnapshot(value)).toEqual(value);
	expect(cache.activateEpoch(EPOCH)).toBe(true);
	expect(cache.accept(JSON.stringify(value))).toBe(true);
	return cache;
}
function dto(value = snapshot(), at = NOW, first?: number | null): UiRoleUsageCost {
	return roleUsageCost(
		{
			usageMeterCache: () => cached(value),
			...(first === undefined ? {} : { usageMeterFirstObservedAt: () => first }),
		},
		"ops",
		at,
	);
}
const manual = {
	state: "ok",
	spent: "$12.50",
	budget: "$2,000",
	line: "$12.50 / $2,000 this week",
	byInitiative: [{ id: "test-work", amount: "$9" }],
};
function overview(cost: UiRoleUsageCost | undefined = dto()): UiRolesOverview {
	return {
		at: NOW,
		roles: [
			{
				id: "ops",
				title: "Ops",
				status: "idle",
				focus: "Tools",
				workMode: "request-only",
				workModeFrom: "rules",
				requests: { open: 0 },
				goals: [],
				tldr: [],
				report: { state: "none" },
				spend: manual,
				...(cost ? { usageCost: cost } : {}),
				queue: { running: true, active: [], queued: [], counts: { active: 0, queued: 0, done: 0 } },
			},
		],
		asks: [],
		work: { initiatives: [], projects: [] },
	} as unknown as UiRolesOverview;
}
function state(o = overview()) {
	return { status: "ready", overview: o, checkedAt: NOW, heardAt: NOW, overviewReceivedAt: NOW, appliedAt: NOW };
}
function projected(cost = dto(), now = NOW) {
	const value = projectRoleUsageCost(cost, "ops", now);
	expect(value).not.toBeNull();
	return value!;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	resetRolesState();
	send.mockReset().mockReturnValue(true);
});
afterEach(() => {
	for (const clean of cleanups.splice(0)) clean();
	resetRolesState();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	document.body.replaceChildren();
});

describe("W7 closed cache-to-protocol bridge", () => {
	it("keeps protocol parity on the existing web export path", () => {
		expectTypeOf<WebCost>().toEqualTypeOf<UiRoleUsageCost>();
		expectTypeOf<WebTiming>().toEqualTypeOf<import("../../server/protocol.js").UiRolesUsageRenderTiming>();
	});
	it("pins only this role, not task/initiative amounts; preserves exact money and leaves the cache untouched", () => {
		const v = snapshot();
		v.subjects.push({
			...structuredClone(v.subjects[0]),
			subject: { kind: "initiative", initiative: "test-work" },
			list: { grossObservations: "88", deduplicatedRecorded: "88" },
		});
		v.subjects.push({
			...structuredClone(v.subjects[0]),
			subject: { kind: "task", queueKey: "b".repeat(64), task: 7, addedAt: ISO },
			list: { grossObservations: "99", deduplicatedRecorded: "99" },
		});
		const cache = cached(v);
		const before = JSON.stringify(cache.get(ISO));
		const cost = roleUsageCost({ usageMeterCache: () => cache }, "ops", NOW);
		expect(cost.usage?.list?.deduplicatedRecorded).toBe(EXACT);
		expect(cost.sources[0]).toHaveProperty("coveredThrough", ISO);
		expect(JSON.stringify(cost)).not.toMatch(
			/complete_through|complete through|queueKey|initiative|subject|cursor|token|session/,
		);
		cost.usage!.list!.deduplicatedRecorded = "1";
		expect(JSON.stringify(cache.get(ISO))).toBe(before);
		expect(roleUsageCost({ usageMeterCache: () => cache }, "design", NOW).usage).toBeNull();
	});
	it.each([undefined, null, 0, -1, NOW + 1, Number.NaN])(
		"keeps missing/invalid native admission timing null (%s)",
		(first) => {
			const cost = dto(snapshot(), NOW, first);
			expect(cost.firstNativeObservedAt).toBeNull();
			expect(cost.usage?.list?.deduplicatedRecorded).toBe(EXACT);
		},
	);
	it("admits only an injected generation-bound receipt, without substituting page/cache clocks", () => {
		const receipt = vi.fn((g) => (g.epoch === EPOCH && g.sequence === 7 ? NOW - 200 : null));
		const cost = roleUsageCost({ usageMeterCache: () => cached(), usageMeterFirstObservedAt: receipt }, "ops", NOW);
		expect(receipt).toHaveBeenCalledExactlyOnceWith(generation);
		expect(cost.firstNativeObservedAt).toBe(NOW - 200);
		const thrown = roleUsageCost(
			{
				usageMeterCache: () => cached(),
				usageMeterFirstObservedAt: () => {
					throw new Error("not admitted");
				},
			},
			"ops",
			NOW,
		);
		expect(thrown.firstNativeObservedAt).toBeNull();
		expect(thrown.usage).not.toBeNull();
	});
	it("makes absent or failed injection explicitly unavailable, never an automatic zero", () => {
		for (const host of [
			{},
			{ usageMeterCache: () => null },
			{
				usageMeterCache: () => {
					throw new Error("unavailable");
				},
			},
		]) {
			const cost = roleUsageCost(host, "ops", NOW);
			expect(cost).toMatchObject({ generation: null, state: "unavailable", usage: null, firstNativeObservedAt: null });
			expect(projected(cost).lines.join(" ")).toContain("known list subtotal: UNKNOWN");
			expect(projected(cost).lines.join(" ")).not.toContain("$0");
		}
	});
	it("the real Roles reader adds cached automatic figures beside unchanged readRoleSpend output", async () => {
		const dir = mkdtempSync(join(tmpdir(), "roles-w7-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const roleDir = join(dir, "ops");
		mkdirSync(roleDir);
		const file = join(roleDir, "spend.json");
		const contents = JSON.stringify({
			v: 1,
			budgetUsd: 2000,
			budgetFrom: "owner",
			weekStart: WEEK,
			weekEnd: "2026-10-25",
			spentUsd: 12.5,
			updatedAt: "2026-10-20T12:00:00-07:00",
			stopped: false,
			byInitiative: { "test-work": 9 },
		});
		writeFileSync(file, contents);
		const host: RolesOverviewHost = {
			identities: () => [
				{
					id: "ops",
					title: "Ops",
					pastHomeChats: [],
					raw: {},
					dir: roleDir,
					role: { config: { workMode: "request-only", goals: [] }, problems: [] },
				} as unknown as IdentityDef,
			],
			chatState: () => "closed",
			asks: () => [],
			openRequestsTo: () => ({ open: 0 }),
			latestReportTo: () => undefined,
			rolePaused: () => false,
			sessionRoots: () => [],
			reportRunsFile: () => join(dir, "no-runs"),
			schedulerJobsFile: () => join(dir, "no-jobs"),
			usageMeterCache: () => cached(),
			now: () => NOW,
		};
		const result = await new RolesOverviewReader(host).read();
		expect(result.roles[0].spend).toMatchObject({
			state: "ok",
			spent: "$12.50",
			budget: "$2,000",
			byInitiative: [{ id: "test-work", amount: "$9" }],
		});
		expect(result.roles[0].usageCost?.usage?.list?.deduplicatedRecorded).toBe(EXACT);
		expect(readFileSync(file, "utf8")).toBe(contents);
	});
});

describe("W7 useful, panel and exact consumers", () => {
	it("renders 12-decimal known list amounts and separate bases without adding or passing them to projectSpend", () => {
		const cost = dto();
		const s = state(overview(cost));
		const useful = projectUsefulRoles(s, "open", NOW).roles[0];
		const panel = projectRolePanel(s, "ops", NOW)!;
		const exact = projectExactRoles(s, "open", NOW).roles[0];
		for (const value of [useful.usageCost, panel.usageCost, exact.usageCost]) {
			expect(value?.lines.join(" ")).toContain(`known list subtotal: $${EXACT} USD`);
			expect(value?.lines.join(" ")).toContain("provider-reported known subtotal: $0.000000000001 USD");
			expect(value?.lines.join(" ")).toContain("invoice known subtotal: $14.0 USD");
			expect(value?.lines.join(" ")).toContain("separate basis, not added to list");
			expect(value?.lines.join(" ")).toContain("own and requested mixed");
			expect(value?.lines.join(" ")).toContain("Funding: not evaluated; UNKNOWN");
		}
		expect(useful.spend).toEqual(projectSpend(manual));
		expect(panel.spend).toEqual(projectSpend(manual));
		expect(projectSpend(cost)).toBeNull();
	});
	it("distinguishes an exact known zero from missing money and null counts", () => {
		const cost = dto(snapshot(true));
		cost.usage!.list = { grossObservations: "0", deduplicatedRecorded: "0.000000000000" };
		cost.usage!.counts = { unpriced: null, unresolvedIdentities: null };
		const text = projected(cost).lines.join(" ");
		expect(text).toContain("subtotal: $0.000000000000 USD");
		expect(text).toContain("Unpriced list facts: UNKNOWN; unresolved identities: UNKNOWN");
		cost.usage!.list = null;
		expect(projected(cost).lines[0]).toContain("subtotal: UNKNOWN");
	});
	it.each(["unpriced", "cursor-gap", "retention-gap", "funding-unavailable"] as const)(
		"keeps %s partial and unknown, never a certified budget remainder",
		(code) => {
			const cost = dto(snapshot(true));
			cost.usage!.faults = [{ code, count: 1 }];
			cost.usage!.counts.unpriced = code === "unpriced" ? 1 : null;
			const result = projected(cost);
			expect(result.lines.join(" ")).toContain(`${code} (1)`);
			expect(result.lines.join(" ")).toContain("UNKNOWN — no certified budget remainder");
			expect(result.lines.join(" ")).not.toMatch(/balance|safe to|allowance|remaining budget/i);
		},
	);
	it.each(["complete", "partial", "unavailable"] as const)(
		"supports Pi-only %s coverage without borrowing manual funding",
		(coverage) => {
			const cost = dto();
			cost.usage!.usageCoverage = coverage;
			if (coverage !== "complete") {
				cost.sources[0] = {
					...cost.sources[0],
					state: coverage === "partial" ? "partial" : "unavailable",
				} as (typeof cost.sources)[0];
				if (coverage === "unavailable") cost.usage!.list = null;
			}
			const text = projected(cost).lines.join(" ");
			expect(text).toContain(`usage coverage: ${coverage}`);
			expect(text).toContain("Funding: not evaluated; UNKNOWN");
			expect(text).not.toContain("Temper");
		},
	);
	it("keeps the manual fallback and layout geometry on old servers and unavailable automatic data", () => {
		const old = overview();
		delete old.roles[0].usageCost;
		const model = projectExactRoles(state(old), "open", NOW);
		expect(model.roles[0].usageCost).toBeNull();
		expect(projectRolePanel(state(old), "ops", NOW)?.spend).toEqual(projectSpend(manual));
	});
	it("only admits synthetic policy-wide clean funding, and never draws an automatic safety bar", () => {
		const v = snapshot();
		v.subjects[0].fundingCoverage = "complete";
		v.subjects[0].funding = {
			wholePolicySubject: true,
			verifiedOwnLowerBound: "1.123456789012",
			exempt: "2",
			otherPolicy: "3",
			unallocated: "0",
			unallocatedFacts: 0,
			remainingUsd: "1998.876543210988",
		};
		const cost = dto(v);
		expect(projected(cost).lines.join(" ")).toContain(
			"reporting remainder $1998.876543210988 USD — not spending permission",
		);
		expect(projected(cost).lines.join(" ")).toContain("already included, not additional");
		expect(projected(cost, NOW + 60_001).lines.join(" ")).toContain("UNKNOWN — no certified budget remainder");
	});
	it("independently downgrades stale native age and Pacific-week mismatch; polls do not renew it", () => {
		const cost = dto();
		for (const at of [NOW + 60_001, Date.parse("2026-10-26T07:00:00.000Z")]) {
			const p = projected(cost, at);
			expect(p.stale).toBe(true);
			expect(p.lines.join(" ")).toContain("usage coverage: partial; stale/unverified");
			const s = { ...state(overview(cost)), checkedAt: at, heardAt: at, overviewReceivedAt: at, appliedAt: at };
			expect(projectExactRoles(s, "open", at).roles[0].usageCost?.stale).toBe(true);
		}
		const weekOnly = dto();
		weekOnly.weekStart = "2026-10-12";
		expect(projected(weekOnly).stale).toBe(true);
	});
	it.each([
		(c: UiRoleUsageCost) => {
			c.role = "design";
		},
		(c: UiRoleUsageCost) => {
			Object.assign(c, { path: "/private/source" });
		},
		(c: UiRoleUsageCost) => {
			c.usage!.list!.deduplicatedRecorded = "1.1234567890123";
		},
		(c: UiRoleUsageCost) => {
			c.usage!.list!.deduplicatedRecorded = "1e3";
		},
		(c: UiRoleUsageCost) => {
			c.usage!.list!.deduplicatedRecorded = "1\n";
		},
		(c: UiRoleUsageCost) => {
			c.usage!.list!.deduplicatedRecorded = 1 as unknown as string;
		},
		(c: UiRoleUsageCost) => {
			c.usage!.counts.unpriced = -1;
		},
		(c: UiRoleUsageCost) => {
			c.usage!.usageCoverage = "complete";
			c.sources = dto(snapshot(true)).sources;
		},
		(c: UiRoleUsageCost) => {
			c.usage!.fundingCoverage = "complete";
		},
		(c: UiRoleUsageCost) => {
			Object.assign(c.sources[0], { complete_through: ISO });
		},
	])("rejects the whole unsafe automatic DTO (case %i), preserving the manual reference", (mutate) => {
		const c = dto();
		mutate(c);
		expect(projectRoleUsageCost(c, "ops", NOW)).toBeNull();
		const s = state(overview(c));
		expect(projectUsefulRoles(s, "open", NOW).roles[0].usageCost).toBeNull();
		expect(projectRolePanel(s, "ops", NOW)?.usageCost).toBeNull();
		expect(projectExactRoles(s, "open", NOW).roles[0].usageCost).toBeNull();
		expect(projectRolePanel(s, "ops", NOW)?.spend).toEqual(projectSpend(manual));
	});
});

describe("S0 Temper frontier is diagnostic, always UNKNOWN", () => {
	it("shows date, UTC, recorded frontier, pending/progress, and UNKNOWN even when fresh", () => {
		const text = projected(dto(snapshot(true))).lines.join(" ");
		expect(text).toContain("Temper recorded through 2026-10-20 19:00 UTC; coverage UNKNOWN; diagnostic only: fresh");
		expect(text).toContain("frontier age 0s; pending 0; oldest pending UNKNOWN; last drain 2026-10-20 19:00 UTC");
		expect(text).toContain("usage coverage: UNKNOWN (Temper); partial");
		expect(text).not.toMatch(/complete_through|complete through|coverage: complete|safe|allowance/i);
	});
	it.each([
		["delayed", ["delayed"]],
		["stalled", ["drain-stalled"]],
		["dead-man", ["dead-man"]],
	] as const)("closed %s labels cannot improve coverage", (freshness, codes) => {
		const cost = dto(snapshot(true));
		const source = cost.sources[0];
		if (source.kind !== "temper") throw new Error("fixture");
		source.frontier.freshness = freshness;
		source.frontier.stallCodes = [...codes];
		const text = projected(cost).lines.join(" ");
		expect(text).toContain(`diagnostic only: ${freshness}`);
		expect(text).toContain("coverage UNKNOWN");
	});
	it("clock advances, fresh page polls, and frontier/alarm recovery all leave Temper UNKNOWN", () => {
		const cost = dto(snapshot(true));
		for (const [delta, label] of [
			[60_001, "delayed"],
			[300_000, "dead-man"],
		] as const) {
			const s = { ...state(overview(cost)), heardAt: NOW + delta, checkedAt: NOW + delta, appliedAt: NOW + delta };
			const text = projectExactRoles(s, "open", NOW + delta).roles[0].usageCost!.lines.join(" ");
			expect(text).toContain(`diagnostic only: ${label}`);
			expect(text).toContain("coverage UNKNOWN");
		}
		const source = cost.sources[0];
		if (source.kind !== "temper") throw new Error("fixture");
		source.frontier.freshness = "stalled";
		source.frontier.stallCodes = ["drain-stalled"];
		expect(projected(cost).lines.join(" ")).toContain("coverage UNKNOWN");
		source.frontier.freshness = "fresh";
		source.frontier.stallCodes = [];
		cost.generation!.sequence++;
		expect(projected(cost).lines.join(" ")).toContain("coverage UNKNOWN");
		source.frontier.recorded_through = "2026-10-20T18:59:59.000Z";
		expect(projected(cost).lines.join(" ")).toContain("coverage UNKNOWN");
	});
	it("rejects completeness claims, open-ended stall text and hidden legacy frontier coverage", () => {
		for (const extra of [
			{ coverage: "complete" },
			{ complete_through: ISO },
			{ frontier: { diagnosticOnly: false } },
		]) {
			const c = dto(snapshot(true));
			Object.assign(c.sources[0], extra);
			expect(projectRoleUsageCost(c, "ops", NOW)).toBeNull();
		}
		const c = dto(snapshot(true));
		if (c.sources[0].kind !== "temper") throw new Error("fixture");
		c.sources[0].frontier.stallCodes = ["run-again" as "pending"];
		expect(projectRoleUsageCost(c, "ops", NOW)).toBeNull();
	});
});
