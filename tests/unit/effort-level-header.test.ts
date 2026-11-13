import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { UiEffortLevels } from "../../server/effort-level-protocol.js";
import { effortLevelsFor, handleEffortLevelMessage, type EffortLevelDeps } from "../../server/effort-level.js";
import { EffortLevelButton } from "../../web/src/components/EffortLevelButton.js";

const state = vi.hoisted(() => ({ levels: { rows: [] } as UiEffortLevels }));
vi.mock("../../web/src/effort-level-state.js", () => ({ useEffortLevels: () => state, pickEffortLevel: vi.fn() }));
vi.mock("../../web/src/i18n.js", () => ({
	useT: () => (key: string, args?: { department?: string }) =>
		key === "effortLevelTable" ? `Effort level · ${args?.department}` : key,
}));
// Render the real header even while closed; no browser or production test-only branch.
vi.mock("../../web/src/components/Dropdown.js", () => ({
	Dropdown: ({ children }: { children: unknown }) => children,
}));
vi.mock("../../server/identities.js", () => ({
	identityRegistry: () => ({
		identities: [
			{ id: "qa", title: "QA" },
			{ id: "ops", title: "ops/tooling" },
		],
	}),
}));

function levels(role: string, title?: string): UiEffortLevels {
	return {
		role,
		...(title ? { title } : {}),
		defaultTier: "xhigh",
		rows: [{ tier: "xhigh", label: "Extra high", model: "test/model" }],
	};
}

describe("effort-level department header (row 18)", () => {
	it.each([
		["qa", "QA", "QA"],
		["rollcall", "RollCall", "RollCall"],
		["coo", "COO", "COO"],
		["design", "Design", "Design"],
		["temper", "temper", "temper"],
		["ops", "ops/tooling", "Ops"],
		["frontend", "Frontend engineering", "Frontend"],
		["data", "Data & analytics", "Data"],
		["qa", undefined, "Qa"],
	])("role %s + title %s renders Effort level · %s", (role, title, expected) => {
		state.levels = levels(role, title);
		expect(renderToStaticMarkup(createElement(EffortLevelButton, { conversationId: "c1", connected: true }))).toContain(
			`Effort level · ${expected}`,
		);
	});
	it("get, set and refused set carry the canonical role title", async () => {
		const sent: unknown[] = [];
		const deps: EffortLevelDeps = {
			chat: () => ({ sessionFile: "/sealed/chat", sessionId: "s1", isStreaming: true }),
			applyModel: async () => {},
			send: (msg) => sent.push(msg),
			routeApi: () => ({
				effortLevels: () => levels("qa"),
				setEffortLevel: ({ tier }) => {
					if (tier === "low") throw new Error("refused");
					return levels("qa");
				},
			}),
		};
		expect(effortLevelsFor("c1", deps)).toMatchObject({ role: "qa", title: "QA" });
		await handleEffortLevelMessage({ type: "get_effort_levels", conversationId: "c1" }, deps);
		await handleEffortLevelMessage({ type: "set_effort_level", conversationId: "c1", tier: "high" }, deps);
		await handleEffortLevelMessage({ type: "set_effort_level", conversationId: "c1", tier: "low" }, deps);
		expect(sent).toHaveLength(3);
		for (const msg of sent) expect(msg).toMatchObject({ levels: { role: "qa", title: "QA" } });
	});
});
