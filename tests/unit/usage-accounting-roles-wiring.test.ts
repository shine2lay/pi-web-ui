/// <reference types="vite/client" />
/// <reference path="../../web/src/roles-design-fonts.d.ts" />
// @vitest-environment jsdom
// W7: synthetic admitted scalars + the actual projection, transport and DOM-completion seams.
// No native sources, live chats, worker starts, model requests or production browser interaction.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { IdentityDef } from "../../server/identities.js";
import type {
	ClientMessage,
	ServerMessage,
	UiRoleUsageCost,
	UiRolesOverview,
	UiRolesUsageRenderAck,
} from "../../server/protocol.js";
import { RolesOverviewReader, RolesWatch, roleUsageCost, type RolesOverviewHost } from "../../server/roles-overview.js";
import { createUsageMeterCache } from "../../server/usage-accounting-meter-cache.js";
import { validateMeterSnapshot, type UsageMeterSnapshot } from "../../server/usage-accounting-meter-contract.js";
import { RolesExactView, updateRolesUsageDOM } from "../../web/src/components/RolesExactView.js";
import { projectExactRoles } from "../../web/src/roles-exact-model.js";
import { createExactRolesView } from "../../web/src/roles-exact-view.js";
import { projectRolePanel } from "../../web/src/roles-panel-model.js";
import {
	acknowledgeRenderedRolesUsage,
	receiveRoles,
	resetRolesState,
	rolesConnectionLost,
	watchRoles,
} from "../../web/src/roles-state.js";
import { bindRolesSurface } from "../../web/src/roles-u0/surface.js";
import { projectRoleUsageCost, projectSpend, projectUsefulRoles } from "../../web/src/roles-useful-model.js";
import type { UiRoleUsageCost as WebCost, UiRolesUsageRenderTiming as WebTiming } from "../../web/src/types.js";

const send = vi.hoisted(() => vi.fn<(msg: ClientMessage) => boolean>(() => true));
const prepare = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => undefined));
vi.mock("../../web/src/app-globals", () => ({ appSend: send, useAppField: () => "open" }));
vi.mock("../../web/src/roles-exact-fonts", () => ({
	exactRolesFonts: { geist: new Uint8Array(), mono: new Uint8Array() },
}));
vi.mock("../../web/src/roles-u0/surface", async (original) => ({
	...(await original<typeof import("../../web/src/roles-u0/surface.js")>()),
	prepareRolesDocument: prepare,
}));
const NOW = Date.parse("2026-10-20T19:00:00.000Z");
const ISO = new Date(NOW).toISOString();
const WEEK = "2026-10-19";
const EPOCH = "a".repeat(64);
const EXACT = "9007199254740993.123456789012";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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
function mounted(cost = dto()) {
	const model = projectExactRoles(state(overview(cost)), "open", NOW);
	let binding: ReturnType<typeof bindRolesSurface> | null = null;
	const view = createExactRolesView(
		() => model,
		{ open: vi.fn(), about: vi.fn(), answer: vi.fn(), reload: vi.fn() },
		{
			raf: (f) => setTimeout(f, 0),
			cancelRaf: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
			setTimeout: (f, ms) => setTimeout(f, ms),
			clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
		},
		() => binding?.update(),
	);
	binding = bindRolesSurface(document, () => view.values(1400, 780));
	cleanups.push(() => {
		binding?.dispose();
		view.dispose();
	});
	return { view, binding };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	resetRolesState();
	send.mockReset().mockReturnValue(true);
	prepare.mockReset().mockResolvedValue(undefined);
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
		expectTypeOf<Extract<ClientMessage, { type: "roles_watch" }>["renderedUsage"]>().toEqualTypeOf<
			UiRolesUsageRenderAck | undefined
		>();
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
		const { view } = mounted(roleUsageCost({}, "ops", NOW));
		const before = view.values(1400, 780);
		expect(before.spendAmountText).toContain("12.50");
		view.openRole("ops", document.body);
		vi.runAllTimers();
		const region = document.querySelector('[role="region"]')!;
		expect(region.textContent).toContain("known list subtotal: UNKNOWN");
		expect(region.textContent).toContain("Manual tally — stale/unverified reference only");
		expect(region.textContent).not.toContain(`$${EXACT}`);
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
		const { view } = mounted(cost);
		const values = view.values(1400, 780);
		// The geometry and amount remain the manual $12.50 reference, not the automatic decimal/remainder.
		expect(values.spendAmountText).toContain("12.50");
		expect(values.spendBarWidth).toBe("0.625%");
		expect(values.spendBarColor).toBe("#7DB8FF");
		expect(values.spendAria).not.toContain("1998.876543210988");
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

describe("existing watch transport: optional post-DOM generation acknowledgement", () => {
	// Execute just the real existing handler's bounded case, never import/start server/index.ts.
	function route(watch: RolesWatch<object>, ws: object, msg: ClientMessage, receive: (m: ServerMessage) => void) {
		const code = readFileSync(join(project, "server/index.ts"), "utf8");
		const start = code.indexOf('case "roles_watch":');
		const end = code.indexOf('case "roles_unwatch":', start);
		expect(start >= 0 && end > start).toBe(true);
		const handler = new Function("rolesWatch", "ws", "msg", "send", `switch(msg.type) { ${code.slice(start, end)} }`);
		handler(watch, ws, msg, receive);
	}
	function transport(first: number | null = null, temper = false) {
		let now = NOW;
		let current = overview(dto(snapshot(temper), NOW, first));
		let displayed = current;
		const messages: ServerMessage[] = [];
		const ws = {};
		const watch = new RolesWatch<object>(async () => ({ ...current, at: now }), { now: () => now });
		cleanups.push(() => watch.stop());
		const receive = (m: ServerMessage) => {
			messages.push(m);
			if (m.type === "roles") {
				if (m.overview) displayed = m.overview;
				receiveRoles(m);
			}
		};
		send.mockImplementation((msg?: ClientMessage) => {
			if (msg) route(watch, ws, msg, receive);
			return true;
		});
		const stop = watchRoles(true);
		cleanups.push(stop);
		return {
			watch,
			ws,
			messages,
			get current() {
				return displayed;
			},
			now: (v: number) => {
				now = v;
			},
			next: (c: UiRoleUsageCost) => {
				current = overview(c);
			},
			receive,
		};
	}
	const acks = () =>
		send.mock.calls.map((call) => call[0]).filter((m) => m.type === "roles_watch" && m.renderedUsage !== undefined);
	it("the real mounted component acknowledges only after the active-visible iframe DOM update", async () => {
		const f = transport();
		await f.watch.look();
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((fn) => window.setTimeout(() => fn(NOW), 16));
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => window.clearTimeout(id));
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		cleanups.push(() => {
			act(() => root.unmount());
			host.remove();
		});
		const fonts = { geist: new Uint8Array(), mono: new Uint8Array() };
		const render = async (active: boolean) => {
			await act(async () =>
				root.render(createElement(RolesExactView, { active, fonts, onOpen: vi.fn(), onAbout: vi.fn() })),
			);
		};
		await render(false);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(20);
		});
		expect(host.querySelector("iframe")?.contentDocument?.querySelector("[data-boxgrid]")).not.toBeNull();
		expect(acks()).toHaveLength(0);
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		await render(true);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(20);
		});
		expect(acks()).toHaveLength(0);
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		await render(false);
		await render(true);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(20);
		});
		expect(acks()).toHaveLength(0); // a visible unopened panel is not rendered cost evidence
		const doc = host.querySelector("iframe")!.contentDocument!;
		const open = doc.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
		expect(open).not.toBeNull();
		await act(async () => open!.click());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(20);
		});
		expect(doc.querySelector('[role="region"]')?.textContent).toContain(`$${EXACT}`);
		expect(acks()).toHaveLength(1);
		expect(f.watch.usageRenderTimings(f.ws)[0]).toMatchObject({
			role: "ops",
			generation,
			firstObservationToAckMs: null,
		});
	});
	it("failed component mounting and unmount-before-preparation never acknowledge a generation", async () => {
		const f = transport();
		await f.watch.look();
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		const host = document.createElement("div");
		document.body.appendChild(host);
		let root = createRoot(host);
		const fonts = { geist: new Uint8Array(), mono: new Uint8Array() };
		prepare.mockRejectedValueOnce(new Error("synthetic font preparation failed"));
		await act(async () =>
			root.render(createElement(RolesExactView, { active: true, fonts, onOpen: vi.fn(), onAbout: vi.fn() })),
		);
		expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not be loaded");
		expect(acks()).toHaveLength(0);
		await act(async () => root.unmount());
		let ready: () => void = () => undefined;
		prepare.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					ready = resolve;
				}),
		);
		root = createRoot(host);
		await act(async () =>
			root.render(createElement(RolesExactView, { active: true, fonts, onOpen: vi.fn(), onAbout: vi.fn() })),
		);
		await act(async () => root.unmount());
		await act(async () => ready());
		expect(host.querySelector("iframe")).toBeNull();
		expect(acks()).toHaveLength(0);
		host.remove();
	});
	it("push and values() alone never acknowledge rendering; actual DOM update/refit then carries the same generation", async () => {
		const f = transport(NOW - 250);
		await f.watch.look();
		const { view, binding } = mounted(f.current.roles[0].usageCost);
		view.values(1400, 780);
		expect(view.usageRenderCandidates()).toEqual([]);
		expect(acks()).toHaveLength(0);
		view.openRole("ops", document.body);
		expect(view.usageRenderCandidates()).toEqual([{ role: "ops", generation }]);
		binding.update();
		expect(document.querySelector('[role="region"]')?.textContent).toContain(`$${EXACT}`);
		f.now(NOW + 12);
		vi.setSystemTime(NOW + 900_000); // client clock never becomes native first-observation evidence
		const count = vi.fn();
		updateRolesUsageDOM(
			binding,
			() => false,
			() => count(acknowledgeRenderedRolesUsage(f.current, view.usageRenderCandidates())),
		);
		expect(count).toHaveBeenCalledExactlyOnceWith(1);
		expect(acks()).toHaveLength(1);
		expect(f.watch.usageRenderTimings(f.ws)).toEqual([
			{
				watch: 1,
				role: "ops",
				generation,
				pushedAt: NOW,
				acknowledgedAt: NOW + 12,
				firstNativeObservedAt: NOW - 250,
				pushToAckMs: 12,
				firstObservationToAckMs: 262,
			},
		]);
		expect(acknowledgeRenderedRolesUsage(f.current, [{ role: "ops", generation }])).toBe(0);
	});
	it("missing native receipt stays null; fresh Temper UNKNOWN can be rendered without certifying coverage", async () => {
		const f = transport(null, true);
		await f.watch.look();
		const { view, binding } = mounted(f.current.roles[0].usageCost);
		view.openRole("ops", document.body);
		f.now(NOW + 5);
		updateRolesUsageDOM(
			binding,
			() => false,
			() => acknowledgeRenderedRolesUsage(f.current, view.usageRenderCandidates()),
		);
		expect(f.watch.usageRenderTimings(f.ws)[0]).toMatchObject({
			firstNativeObservedAt: null,
			firstObservationToAckMs: null,
			pushToAckMs: 5,
		});
		expect(f.current.roles[0].usageCost?.usage?.usageCoverage).toBe("partial");
		expect(projected(f.current.roles[0].usageCost).lines.join(" ")).toContain("coverage UNKNOWN");
	});
	it("does not acknowledge failed/unmounted bindings or send failures", async () => {
		const f = transport();
		await f.watch.look();
		const done = vi.fn();
		updateRolesUsageDOM(null, () => false, done);
		expect(() =>
			updateRolesUsageDOM(
				{
					update: () => {
						throw new Error("failed DOM");
					},
				},
				() => false,
				done,
			),
		).toThrow("failed DOM");
		expect(() =>
			updateRolesUsageDOM(
				{ update: () => undefined },
				() => {
					throw new Error("failed refit");
				},
				done,
			),
		).toThrow("failed refit");
		expect(done).not.toHaveBeenCalled();
		send.mockReturnValue(false);
		expect(acknowledgeRenderedRolesUsage(f.current, [{ role: "ops", generation }])).toBe(0);
		send.mockReturnValue(true);
		expect(acknowledgeRenderedRolesUsage(f.current, [{ role: "ops", generation }])).toBe(1);
	});
	it("rejects hidden, disconnected, old snapshot, count-only and unwatched client renders", async () => {
		const f = transport();
		await f.watch.look();
		const ack = () => acknowledgeRenderedRolesUsage(f.current, [{ role: "ops", generation }]);
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		expect(ack()).toBe(0);
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		expect(acknowledgeRenderedRolesUsage(structuredClone(f.current), [{ role: "ops", generation }])).toBe(0);
		rolesConnectionLost();
		expect(ack()).toBe(0);
		resetRolesState();
		watchRoles(false);
		receiveRoles({ type: "roles", overview: f.current, asks: 0, usageRender: { watch: 1, pushedAt: NOW } });
		expect(ack()).toBe(0);
		resetRolesState();
		expect(ack()).toBe(0);
	});
	it("server binds connection, watch, role and generation; closes clocks/extra fields and rejects replay", async () => {
		const f = transport(NOW - 100);
		await f.watch.look();
		const good = { watch: 1, role: "ops", generation };
		for (const raw of [
			null,
			{ ...good, watch: 99 },
			{ ...good, role: "design" },
			{ ...good, clientAt: NOW },
			{ ...good, generation: { ...generation, sequence: 6 } },
			{ ...good, generation: { ...generation, extra: true } },
		])
			expect(f.watch.acknowledgeUsage(f.ws, raw)).toBe(false);
		expect(f.watch.acknowledgeUsage({}, good)).toBe(false);
		f.watch.watch({}, false, vi.fn());
		f.now(NOW + 1);
		expect(f.watch.acknowledgeUsage(f.ws, good)).toBe(true);
		expect(f.watch.acknowledgeUsage(f.ws, good)).toBe(false);
		const timing = f.watch.usageRenderTimings(f.ws);
		timing[0].acknowledgedAt = 0;
		expect(f.watch.usageRenderTimings(f.ws)[0].acknowledgedAt).toBe(NOW + 1);
		f.watch.watch(f.ws, true, f.receive);
		expect(f.watch.acknowledgeUsage(f.ws, good)).toBe(false);
		f.watch.drop(f.ws);
		expect(f.watch.usageRenderTimings(f.ws)).toEqual([]);
	});
	it("old or superseded generations, failed source reads and Pacific-week rollover cannot get accepted", async () => {
		const f = transport();
		await f.watch.look();
		const good = { watch: 1, role: "ops", generation };
		f.now(NOW + 60_001);
		expect(f.watch.acknowledgeUsage(f.ws, good)).toBe(false);
		f.now(NOW);
		const next = dto();
		next.generation!.sequence++;
		f.next(next);
		await f.watch.look();
		expect(f.watch.acknowledgeUsage(f.ws, good)).toBe(false);
		f.now(Date.parse("2026-10-26T07:00:00.000Z"));
		expect(f.watch.acknowledgeUsage(f.ws, { ...good, generation: next.generation })).toBe(false);
	});
	it("old-server pushes without optional watch metadata do not fabricate acknowledgement", () => {
		watchRoles(true);
		const o = overview();
		receiveRoles({ type: "roles", overview: o, asks: 0 });
		expect(acknowledgeRenderedRolesUsage(o, [{ role: "ops", generation }])).toBe(0);
	});
});
