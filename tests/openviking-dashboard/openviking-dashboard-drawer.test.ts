// @vitest-environment jsdom
/**
 * OpenViking Memory Dashboard — rendered acceptance assertions for the L0/L1/L2 reader drawer,
 * its keyboard path, and the field tooltips (frontend #261, Task 1).
 *
 * These encode Design's verify findings (VERIFICATION.md §4, VERIFICATION-2.md): the drawer always
 * shows the row that was clicked, closing returns focus to that row, Escape closes a tooltip, and a
 * tooltip never shifts the layout. They fail today because the view is still the Task 1 stub.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenVikingDashboardSnapshot } from "../../web/src/openviking-dashboard/OpenVikingDashboardView.js";
import {
	HASH_64,
	accessibleName,
	click,
	focus,
	mountDashboard,
	part,
	parts,
	pressKey,
	queryAllByRole,
	queryByRole,
	requireSeamImplemented,
	tabPanel,
	text,
	type MountedDashboard,
} from "./openviking-dashboard-dom.js";
import {
	ISOLATED_ROLE_SECRET,
	NOW_MS,
	auditResponse,
	entriesResponse,
	leakyAgentEntry,
	liveOverview,
} from "./openviking-dashboard-fixtures.js";

let mounted: MountedDashboard | null = null;

function renderExplorer(entries = entriesResponse()): HTMLElement {
	const snapshot: OpenVikingDashboardSnapshot = {
		status: "ready",
		overview: liveOverview(),
		entries,
		audit: auditResponse(),
	};
	mounted = mountDashboard({ snapshot, nowMs: NOW_MS, activeTab: "namespace-explorer" });
	requireSeamImplemented(mounted.container);
	return mounted.container;
}

function memoryRows(container: HTMLElement): HTMLElement[] {
	return parts(tabPanel(container, "namespace-explorer") ?? container, "memory-row");
}

/** The control a user actually operates to open a row: the row itself, or its reader button. */
function opener(row: HTMLElement): HTMLElement {
	if (row.matches('button, [role="button"]')) return row;
	const inner = row.querySelector<HTMLElement>('[data-open-reader="true"], button, [role="button"]');
	if (!inner) throw new Error(`memory row ${row.getAttribute("data-row-key")} has no control to open the reader`);
	return inner;
}

function drawer(container: HTMLElement): HTMLElement | null {
	return part(container, "reader-drawer");
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
	mounted?.unmount();
	mounted = null;
	vi.unstubAllGlobals();
});

describe("openviking dashboard drawer — the clicked row's own data", () => {
	it("opens as a labelled dialog showing that row's scope, levels and provenance", () => {
		const container = renderExplorer();
		const row = memoryRows(container)[0]!;
		expect(drawer(container)).toBeNull();
		click(opener(row));

		const panel = drawer(container);
		expect(panel).not.toBeNull();
		expect(panel?.getAttribute("role")).toBe("dialog");
		expect(panel?.getAttribute("aria-modal")).toBe("true");
		expect(accessibleName(panel!)).not.toBe("");
		expect(panel?.getAttribute("data-row-key")).toBe(row.getAttribute("data-row-key"));
		expect(text(panel)).toContain("viking://resources/rollcall/core/map.md");
		expect(text(panel)).not.toMatch(HASH_64);
		expect(text(panel)).toContain("Layer 1 Shared");
		for (const tier of ["L0", "L1", "L2"]) {
			expect(panel?.querySelector(`[data-tier="${tier}"]`)).not.toBeNull();
		}
		expect(part(panel!, "provenance")).not.toBeNull();
	});

	it("never shows the previous row's content after opening another row", () => {
		const container = renderExplorer();
		const rows = memoryRows(container);
		click(opener(rows[0]!));
		const first = text(drawer(container));
		pressKey(drawer(container)!, "Escape");

		click(opener(rows[1]!));
		const second = text(drawer(container));
		expect(drawer(container)?.getAttribute("data-row-key")).toBe(rows[1]?.getAttribute("data-row-key"));
		expect(second).not.toBe(first);
		expect(second).toContain("viking://resources/rollcall/features/roll-ladder/spec.md");
		expect(second).not.toContain("viking://resources/rollcall/core/map.md");
	});

	it("switches content when another row is opened while the drawer stays open", () => {
		const container = renderExplorer();
		const rows = memoryRows(container);
		click(opener(rows[0]!));
		click(opener(rows[2]!));
		const panel = drawer(container);
		expect(panel?.getAttribute("data-row-key")).toBe(rows[2]?.getAttribute("data-row-key"));
		expect(text(panel)).toContain("viking://resources/pi-web-ui/core/map.md");
	});

	it("shows an isolation notice instead of another role's memory text", () => {
		const entries = entriesResponse();
		const container = renderExplorer({ ...entries, entries: [...entries.entries, leakyAgentEntry()] });
		const personal = memoryRows(container).filter((r) => r.getAttribute("data-layer") === "layer2_personal");
		expect(personal.length).toBeGreaterThan(0);
		click(opener(personal.at(-1)!));

		const panel = drawer(container);
		expect(text(panel)).toMatch(/isolat/i);
		expect(text(panel)).not.toContain(ISOLATED_ROLE_SECRET);
		expect(text(panel)).toContain("Layer 2 Personal");
		expect(text(panel)).not.toMatch(/\bL2 Personal\b/);
	});
});

describe("openviking dashboard drawer — keyboard path", () => {
	it("opens from the keyboard", () => {
		const container = renderExplorer();
		const control = opener(memoryRows(container)[0]!);
		focus(control);
		pressKey(control, "Enter");
		expect(drawer(container)).not.toBeNull();
	});

	it("returns focus to the row it was opened from when closed with the close button", () => {
		const container = renderExplorer();
		const control = opener(memoryRows(container)[1]!);
		focus(control);
		click(control);
		const close = queryAllByRole(drawer(container)!, "button").find((b) => /close/i.test(accessibleName(b)));
		expect(close).toBeDefined();
		click(close!);
		expect(drawer(container)).toBeNull();
		expect(document.activeElement).toBe(control);
	});

	it("returns focus to the row when closed with Escape", () => {
		const container = renderExplorer();
		const control = opener(memoryRows(container)[2]!);
		focus(control);
		click(control);
		pressKey(drawer(container)!, "Escape");
		expect(drawer(container)).toBeNull();
		expect(document.activeElement).toBe(control);
	});

	it("marks the open row as expanded while the drawer is open", () => {
		const container = renderExplorer();
		const control = opener(memoryRows(container)[0]!);
		expect(control.getAttribute("aria-expanded")).toBe("false");
		click(control);
		expect(control.getAttribute("aria-expanded")).toBe("true");
		pressKey(drawer(container)!, "Escape");
		expect(control.getAttribute("aria-expanded")).toBe("false");
	});
});

describe("openviking dashboard tooltips", () => {
	function anyTooltipTrigger(container: HTMLElement): HTMLElement {
		const trigger = container.querySelector<HTMLElement>("[data-tooltip-trigger]");
		if (!trigger) throw new Error("no field tooltip trigger on the page");
		return trigger;
	}

	it("describes its field through a role=tooltip element, opened from the keyboard", () => {
		const container = renderExplorer();
		const trigger = anyTooltipTrigger(container);
		expect(queryByRole(container, "tooltip")).toBeNull();
		focus(trigger);
		click(trigger);
		const tip = queryByRole(container, "tooltip");
		expect(tip).not.toBeNull();
		expect(trigger.getAttribute("aria-describedby")).toBe(tip?.id);
		expect(text(tip)).not.toBe("");
	});

	it("closes on Escape and gives focus back to its trigger", () => {
		const container = renderExplorer();
		const trigger = anyTooltipTrigger(container);
		focus(trigger);
		click(trigger);
		expect(queryByRole(container, "tooltip")).not.toBeNull();
		pressKey(trigger, "Escape");
		expect(queryByRole(container, "tooltip")).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});

	it("floats above the page instead of shifting the layout", () => {
		const container = renderExplorer();
		const trigger = anyTooltipTrigger(container);
		const before = container.innerHTML.length;
		click(trigger);
		const tip = queryByRole(container, "tooltip")!;
		expect(container.innerHTML.length).toBeGreaterThan(before);
		expect(tip.getAttribute("data-floating")).toBe("true");
		const style = (tip.getAttribute("style") ?? "") + (tip.getAttribute("class") ?? "");
		expect(style).toMatch(/absolute|fixed|floating/i);
	});
});
