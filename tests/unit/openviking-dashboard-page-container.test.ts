// @vitest-environment jsdom
/**
 * The Memory tab's container (frontend #273): each `/api/openviking/*` call feeds its own panel, and the
 * address it writes reloads to the same tab and open row.
 *
 *  - M4 / #269 F2: the header and cards paint as soon as `/overview` answers; a slow, failed (500)
 *    entries or audit call holds or errors only its own panel.
 *  - #269 F6: the shell strips `?view=` at startup, so the dashboard writes `view=openviking` next to
 *    its own `ovtab` / `ovrow`; a reload of that address opens the Memory tab on the same tab and row.
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenVikingDashboardPage } from "../../web/src/components/OpenVikingDashboardPage.js";
import { initChatLink, takeViewLink } from "../../web/src/open-chat-link.js";
import { click, part, parts, tabButtons, tabPanel, text } from "../openviking-dashboard/openviking-dashboard-dom.js";
import { auditResponse, entriesResponse, liveOverview } from "../openviking-dashboard/openviking-dashboard-fixtures.js";

type Route = "overview" | "entries" | "audit";
type Answer = () => Promise<Response>;

const json = (body: unknown, status = 200): Promise<Response> =>
	Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const never: Answer = () => new Promise<Response>(() => {});
const ok: Record<Route, Answer> = {
	overview: () => json(liveOverview()),
	entries: () => json(entriesResponse()),
	audit: () => json(auditResponse()),
};
const http500 = (): Promise<Response> => json({ error: { code: "INTERNAL", message: "boom" } }, 500);

const SHARED_URI = "viking://resources/rollcall/features/roll-ladder/spec.md";

let root: Root | null = null;
let container: HTMLElement | null = null;

function serve(answers: Partial<Record<Route, Answer>>): void {
	const table = { ...ok, ...answers };
	vi.stubGlobal(
		"fetch",
		vi.fn((input: RequestInfo | URL) => {
			const url = String(input);
			// The open row's deep read (`?uri=…&include_content=true`) answers with that entry alone.
			if (url.includes("include_content=true")) {
				const entry = entriesResponse().entries.find((e) => url.includes(encodeURIComponent(e.uri)));
				return json({ ...entriesResponse(), entries: entry ? [entry] : [] });
			}
			const route = (["overview", "entries", "audit"] as const).find((r) => url.includes(`/api/openviking/${r}`));
			if (!route) throw new Error(`unexpected fetch ${url}`);
			return table[route]();
		}),
	);
}

async function mount(): Promise<HTMLElement> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(createElement(OpenVikingDashboardPage, { active: true }));
	});
	// Let every answered fetch settle into state.
	for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());
	return container;
}

const panelState = (el: HTMLElement, tab: string): string | null =>
	tabPanel(el, tab)?.querySelector("[data-panel-state]")?.getAttribute("data-panel-state") ?? null;

function expectTierOnePainted(el: HTMLElement): void {
	expect(el.querySelector('[data-screen-state="live"]')).not.toBeNull();
	expect(text(part(el, "status-header"))).not.toContain("Loading…");
	for (const card of parts(el, "summary-card")) expect(card.getAttribute("data-health-state")).not.toBe("loading");
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	window.history.replaceState(null, "", "/");
});

afterEach(() => {
	act(() => root?.unmount());
	container?.remove();
	root = null;
	container = null;
	vi.unstubAllGlobals();
	window.history.replaceState(null, "", "/");
});

describe("openviking dashboard page — one slice per call (M4, F2)", () => {
	it("paints the header and cards while the entries call is still out", async () => {
		serve({ entries: never });
		const el = await mount();
		expectTierOnePainted(el);
		expect(panelState(el, "namespace-explorer")).toBe("loading");
		expect(panelState(el, "commit-audit")).toBe("ready");
	});

	it("errors only the Explorer when entries answers 500", async () => {
		serve({ entries: http500 });
		const el = await mount();
		expectTierOnePainted(el);
		expect(panelState(el, "namespace-explorer")).toBe("failed");
		expect(panelState(el, "commit-audit")).toBe("ready");
	});

	it("errors only the audit when audit answers 500", async () => {
		serve({ audit: http500 });
		const el = await mount();
		expectTierOnePainted(el);
		expect(panelState(el, "commit-audit")).toBe("failed");
		expect(panelState(el, "namespace-explorer")).toBe("ready");
	});
});

describe("openviking dashboard page — the address reloads to the same view (F6)", () => {
	it("writes the Memory view, the tab and the open row into the address", async () => {
		serve({});
		const el = await mount();
		const explorerTab = tabButtons(el).find((b) => b.getAttribute("data-tab") === "namespace-explorer");
		await act(async () => click(explorerTab as HTMLElement));
		const params = new URLSearchParams(window.location.search);
		expect(params.get("view")).toBe("openviking");
		expect(params.get("ovtab")).toBe("namespace-explorer");

		const row = parts(el, "memory-row").find((r) => text(r).includes("roll-ladder"));
		await act(async () => click(row?.querySelector("button") as HTMLElement));
		expect(new URLSearchParams(window.location.search).get("ovrow")).toBe(`memory:${SHARED_URI}`);
	});

	it("keeps the dashboard's own parameters when the shell reads `?view=openviking` at startup", () => {
		window.history.replaceState(null, "", `/?view=openviking&ovtab=namespace-explorer&ovrow=memory:${SHARED_URI}`);
		initChatLink();
		expect(takeViewLink()).toEqual({ view: "openviking" });
		const params = new URLSearchParams(window.location.search);
		expect(params.get("ovtab")).toBe("namespace-explorer");
		expect(params.get("ovrow")).toBe(`memory:${SHARED_URI}`);
	});

	it("opens on the tab and row a reloaded address names", async () => {
		window.history.replaceState(
			null,
			"",
			`/?ovtab=namespace-explorer&ovrow=${encodeURIComponent(`memory:${SHARED_URI}`)}`,
		);
		serve({});
		const el = await mount();
		const selected = tabButtons(el).find((b) => b.getAttribute("aria-selected") === "true");
		expect(selected?.getAttribute("data-tab")).toBe("namespace-explorer");
		const drawer = part(document.body, "reader-drawer");
		expect(drawer).not.toBeNull();
		expect(text(drawer)).toContain("roll-ladder");
	});
});
