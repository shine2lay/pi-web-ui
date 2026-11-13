/**
 * effort-level-button (server/effort-level.ts; ops #876 acceptance tests, built by ops task 2b): the server side of
 * the composer's "Department effort level" button, over stand-in deps (pi-queue's route channel api, the open chat,
 * the set-model path). No model call, no files.
 *
 * Ops #876 wrote each case as `notBuilt(` (passing only while the stub threw); ops #878 (task 2b) built the handler
 * and turned every `notBuilt(` into `it(`, with no assertion weakened or deleted.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	EFFORT_LEVELS_NOT_BUILT,
	type EffortChoice,
	type EffortLevelChat,
	type EffortLevelDeps,
	type EffortRouteApi,
	effortLevelsFor,
	effortRouteApi,
	handleEffortLevelMessage,
	ROUTE_CHANNEL_KEY,
} from "../../server/effort-level.js";
import type { EffortLevelServerMessage, EffortTier, UiEffortLevels } from "../../server/effort-level-protocol.js";

const LABELS: Record<EffortTier, string> = {
	max: "Max",
	xhigh: "Extra high",
	high: "High",
	medium: "Medium",
	low: "Low",
};
const CELLS: Record<EffortTier, EffortChoice> = {
	max: { model: "anthropic/claude-fable-5-2", thinking: "xhigh" },
	xhigh: { model: "anthropic/claude-fable-5-2", thinking: "high" },
	high: { model: "anthropic/claude-opus-5-5", thinking: "high" },
	medium: { model: "openai-codex/gpt-6.1-sol", thinking: "high" },
	low: { model: "openai-codex/gpt-6.1-sol", thinking: "low" },
};
const levels = (defaultTier: EffortTier, pickedTier?: EffortTier): UiEffortLevels => ({
	role: "ops",
	kind: "lead",
	defaultTier,
	...(pickedTier ? { pickedTier } : {}),
	rows: (Object.keys(CELLS) as EffortTier[]).map((tier) => ({ tier, label: LABELS[tier], ...CELLS[tier] })),
	problems: [],
});

interface Fake {
	deps: EffortLevelDeps;
	sent: EffortLevelServerMessage[];
	applied: { conversationId: string; choice: EffortChoice }[];
	routed: { sessionId: string; model: string }[];
	order: string[];
	sets: { sessionFile: string; tier: EffortTier | null }[];
}
function fake(
	o: { chat?: Partial<EffortLevelChat> | null; api?: Partial<EffortRouteApi> | null; picked?: EffortTier } = {},
): Fake {
	const f: Fake = { deps: undefined as never, sent: [], applied: [], routed: [], order: [], sets: [] };
	let picked = o.picked;
	const api: EffortRouteApi = {
		effortLevels: () => levels("xhigh", picked),
		setEffortLevel: ({ sessionFile, tier }) => {
			f.sets.push({ sessionFile, tier });
			if (tier !== null && !(tier in CELLS)) throw new Error(`"${tier}" is not a tier`);
			picked = tier ?? undefined;
			return { ...levels("xhigh", picked), apply: CELLS[picked ?? "xhigh"] };
		},
		routedSwitch: (sessionId, model) => {
			f.routed.push({ sessionId, model });
			f.order.push("routed");
		},
		...o.api,
	};
	const chat: EffortLevelChat | undefined =
		o.chat === null
			? undefined
			: { sessionFile: "/s/ops-lead.jsonl", sessionId: "s-ops-lead", isStreaming: false, ...o.chat };
	f.deps = {
		chat: () => chat,
		applyModel: async (conversationId, choice) => {
			f.applied.push({ conversationId, choice });
			f.order.push("apply");
		},
		send: (msg) => f.sent.push(msg),
		routeApi: () => (o.api === null ? undefined : api),
	};
	return f;
}

afterEach(() => {
	delete (globalThis as Record<symbol, unknown>)[ROUTE_CHANNEL_KEY];
});

describe("effort-level seam (passes now)", () => {
	it("the stub says what isn't built", () => {
		expect(EFFORT_LEVELS_NOT_BUILT).toBe("effort levels: not built (ops task 2b)");
	});
	it("finds pi-queue's channel api only when it carries the effort-level seam", () => {
		expect(effortRouteApi()).toBeUndefined();
		(globalThis as Record<symbol, unknown>)[ROUTE_CHANNEL_KEY] = { v: 1, api: { route() {} } };
		expect(effortRouteApi()).toBeUndefined();
		const api = { effortLevels() {}, setEffortLevel() {} };
		(globalThis as Record<symbol, unknown>)[ROUTE_CHANNEL_KEY] = { v: 1, api };
		expect(effortRouteApi()).toBe(api);
	});
});

describe("get_effort_levels", () => {
	it("answers with the open chat's levels", async () => {
		const f = fake();
		await handleEffortLevelMessage({ type: "get_effort_levels", conversationId: "c1" }, f.deps);
		expect(f.sent).toEqual([{ type: "effort_levels", conversationId: "c1", levels: levels("xhigh") }]);
		expect(f.applied).toEqual([]);
	});
	it("a chat of no table, no open chat or no pi-queue: rows [] (the button is hidden), no error", async () => {
		for (const f of [
			fake({ api: { effortLevels: () => ({ rows: [] }) } }),
			fake({ chat: null }),
			fake({ api: null }),
		]) {
			await handleEffortLevelMessage({ type: "get_effort_levels", conversationId: "c1" }, f.deps);
			expect(f.sent).toEqual([{ type: "effort_levels", conversationId: "c1", levels: { rows: [] } }]);
		}
	});
	it("effortLevelsFor asks the channel with the chat's session file", () => {
		const seen: string[] = [];
		const f = fake({ api: { effortLevels: ({ sessionFile }) => (seen.push(sessionFile), levels("xhigh")) } });
		expect(effortLevelsFor("c1", f.deps)).toEqual(levels("xhigh"));
		expect(seen).toEqual(["/s/ops-lead.jsonl"]);
	});
	it("a broken chat-levels.json comes through as a problem (shown as a warning), not an error", async () => {
		const broken = { ...levels("xhigh"), problems: ["/a/model-routing/chat-levels.json: Unexpected token"] };
		const f = fake({ api: { effortLevels: () => broken } });
		await handleEffortLevelMessage({ type: "get_effort_levels", conversationId: "c1" }, f.deps);
		expect(f.sent[0]?.levels.problems).toEqual(broken.problems);
		expect(f.sent[0]?.error).toBeUndefined();
	});
});

describe("set_effort_level", () => {
	it("idle chat: marks routedSwitch, then switches at once through the set-model path", async () => {
		const f = fake();
		await handleEffortLevelMessage({ type: "set_effort_level", conversationId: "c1", tier: "high" }, f.deps);
		expect(f.sets).toEqual([{ sessionFile: "/s/ops-lead.jsonl", tier: "high" }]);
		expect(f.routed).toEqual([{ sessionId: "s-ops-lead", model: "anthropic/claude-opus-5-5" }]);
		expect(f.applied).toEqual([{ conversationId: "c1", choice: CELLS.high }]);
		expect(f.order).toEqual(["routed", "apply"]);
		expect(f.sent).toEqual([
			{ type: "effort_levels", conversationId: "c1", levels: levels("xhigh", "high"), applied: "now" },
		]);
	});
	it("busy chat: records the pick, never switches mid-turn (the next turn start does)", async () => {
		const f = fake({ chat: { isStreaming: true } });
		await handleEffortLevelMessage({ type: "set_effort_level", conversationId: "c1", tier: "medium" }, f.deps);
		expect(f.sets).toHaveLength(1);
		expect(f.applied).toEqual([]);
		expect(f.routed).toEqual([]);
		expect(f.sent[0]).toMatchObject({ type: "effort_levels", applied: "next-turn", levels: { pickedTier: "medium" } });
	});
	it("back to department default (tier null) switches to the default's model", async () => {
		const f = fake({ picked: "high" });
		await handleEffortLevelMessage({ type: "set_effort_level", conversationId: "c1", tier: null }, f.deps);
		expect(f.sets).toEqual([{ sessionFile: "/s/ops-lead.jsonl", tier: null }]);
		expect(f.applied).toEqual([{ conversationId: "c1", choice: CELLS.xhigh }]);
		expect(f.sent[0]?.levels.pickedTier).toBeUndefined();
	});
	it("a refused pick (unknown tier, no table, broken file) answers with the error; nothing switches", async () => {
		const f = fake({
			api: {
				setEffortLevel: () => {
					throw new Error("/a/model-routing/chat-levels.json is broken: fix or delete it");
				},
			},
		});
		await handleEffortLevelMessage({ type: "set_effort_level", conversationId: "c1", tier: "high" }, f.deps);
		expect(f.applied).toEqual([]);
		expect(f.sent).toEqual([
			{
				type: "effort_levels",
				conversationId: "c1",
				levels: levels("xhigh"),
				error: "/a/model-routing/chat-levels.json is broken: fix or delete it",
			},
		]);
	});
	it("no open chat or no pi-queue: refused with an error, nothing recorded", async () => {
		for (const f of [fake({ chat: null }), fake({ api: null })]) {
			await handleEffortLevelMessage({ type: "set_effort_level", conversationId: "c1", tier: "high" }, f.deps);
			expect(f.sets).toEqual([]);
			expect(f.applied).toEqual([]);
			expect(f.sent[0]?.error).toBeTruthy();
		}
	});
});
