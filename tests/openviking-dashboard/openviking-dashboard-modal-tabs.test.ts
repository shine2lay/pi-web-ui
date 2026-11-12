// @vitest-environment jsdom
/**
 * OpenViking Memory Dashboard — the reader is a real modal, and both tablists are whole tabs patterns
 * (frontend #274; Design PROD-SIGNOFF M2, frontend #269 F3/F4/F13).
 *
 * Design measured on the live page that `aria-modal="true"` was a false promise: the trap's list of
 * stops included the two unselected tier tabs (`tabIndex=-1`), so its "last stop" was one the browser
 * never Tabs to, the wrap never fired and the third Tab left the dialog; Escape then did nothing,
 * because only the dialog listened for it; and the shell behind stayed live (`shellInert: false`).
 *
 * jsdom has no sequential focus navigation, so these assertions drive what the page itself must do:
 * Tab on the last stop a browser really reaches wraps to the first, Shift+Tab on the first wraps to
 * that last one, Escape closes from wherever focus is, and everything outside the dialog is inert.
 * The real-browser trail (Tab x12 / Shift+Tab x12 never leaving) is `tests/openviking-modal-keyboard-test.mjs`.
 */

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	accessibleName,
	click,
	focus,
	mountDashboard,
	part,
	parts,
	pressKey,
	queryAllByRole,
	requireSeamImplemented,
	tabButtons,
	tabPanel,
	type MountedDashboard,
} from "./openviking-dashboard-dom.js";
import {
	NOW_MS,
	auditResponse,
	entriesResponse,
	liveOverview,
	readySnapshot,
} from "./openviking-dashboard-fixtures.js";
import { nextTabIndex } from "../../web/src/openviking-dashboard/view-composition.js";

let mounted: MountedDashboard | null = null;
let shell: HTMLElement | null = null;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	// Stands in for the app's top bar and status bar: page chrome outside the dashboard's own root.
	shell = document.createElement("nav");
	shell.innerHTML = '<button type="button" data-probe="app-chrome">Chat</button>';
	document.body.prepend(shell);
});

afterEach(() => {
	mounted?.unmount();
	mounted = null;
	shell?.remove();
	shell = null;
	vi.unstubAllGlobals();
});

/** `own`: the view keeps its own tab (opens on Live Activity), as it does when no container drives it. */
function render(activeTab: "mount-map" | "namespace-explorer" | "own" = "namespace-explorer"): HTMLElement {
	mounted = mountDashboard({
		snapshot: readySnapshot(liveOverview(), entriesResponse(), auditResponse()),
		nowMs: NOW_MS,
		...(activeTab === "own" ? {} : { activeTab }),
	});
	requireSeamImplemented(mounted.container);
	return mounted.container;
}

function openFirstRow(container: HTMLElement): { readonly control: HTMLElement; readonly dialog: HTMLElement } {
	const row = parts(tabPanel(container, "namespace-explorer")!, "memory-row")[0]!;
	const control = row.matches("button") ? row : row.querySelector<HTMLElement>('[data-open-reader="true"], button')!;
	focus(control);
	click(control);
	const dialog = part(container, "reader-drawer");
	if (!dialog) throw new Error("the reader did not open");
	return { control, dialog };
}

/** The stops a browser's Tab key really visits inside the dialog: focusable, enabled, tabIndex >= 0. */
function realStops(dialog: HTMLElement): HTMLElement[] {
	return [...dialog.querySelectorAll<HTMLElement>("button, [href], select, textarea, input, [tabindex]")].filter(
		(el) => !el.hasAttribute("disabled") && el.tabIndex >= 0,
	);
}

function pressShiftTab(el: Element): void {
	act(() => {
		el.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
	});
}

describe("openviking reader — a real modal (#274, M2)", () => {
	it("wraps Tab from the last stop the browser reaches back to the first", () => {
		const { dialog } = openFirstRow(render());
		const stops = realStops(dialog);
		expect(stops.length).toBeGreaterThanOrEqual(2);
		focus(stops.at(-1)!);
		pressKey(stops.at(-1)!, "Tab");
		expect(document.activeElement).toBe(stops[0]);
	});

	it("wraps Shift+Tab from the first stop to the last stop the browser reaches", () => {
		const { dialog } = openFirstRow(render());
		const stops = realStops(dialog);
		focus(stops[0]!);
		pressShiftTab(stops[0]!);
		expect(document.activeElement).toBe(stops.at(-1));
		expect(stops.at(-1)!.tabIndex).toBeGreaterThanOrEqual(0);
	});

	it("closes on Escape wherever focus is, and gives focus back to the row", () => {
		const { control, dialog } = openFirstRow(render());
		expect(dialog.isConnected).toBe(true);
		// Focus stranded outside the dialog (a click on the dimmed page puts it on <body>).
		(document.activeElement as HTMLElement | null)?.blur();
		expect(document.activeElement).toBe(document.body);
		pressKey(document.body, "Escape");
		expect(part(mounted!.container, "reader-drawer")).toBeNull();
		expect(document.activeElement).toBe(control);
	});

	it("makes the dashboard and the app chrome inert while open, and live again after closing", () => {
		const container = render();
		const dashboard = part(container, "openviking-dashboard")!;
		const chrome = shell!.querySelector<HTMLElement>('[data-probe="app-chrome"]')!;
		expect(dashboard.closest("[inert]")).toBeNull();
		const { control, dialog } = openFirstRow(container);
		expect(dashboard.hasAttribute("inert")).toBe(true);
		expect(chrome.closest("[inert]")).not.toBeNull();
		expect(dialog.closest("[inert]")).toBeNull();
		expect(dashboard.contains(dialog)).toBe(false);
		const close = queryAllByRole(dialog, "button").find((b) => /close/i.test(accessibleName(b)))!;
		click(close);
		expect(dashboard.closest("[inert]")).toBeNull();
		expect(chrome.closest("[inert]")).toBeNull();
		expect(document.activeElement).toBe(control);
	});
});

describe("openviking workspace tabs — the whole tabs pattern (#274, #269 F4)", () => {
	it("ties every tab to its panel and every panel back to its tab", () => {
		const container = render("mount-map");
		const tabs = tabButtons(container);
		expect(tabs).toHaveLength(3);
		for (const tab of tabs) {
			expect(tab.id).not.toBe("");
			const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
			expect(panel?.getAttribute("role")).toBe("tabpanel");
			expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
			expect(panel?.getAttribute("data-tabpanel")).toBe(tab.getAttribute("data-tab"));
		}
	});

	it("is one tab stop: only the selected tab is in the Tab order", () => {
		const tabs = tabButtons(render("mount-map"));
		expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
		expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
	});

	it("moves selection and focus with Left / Right / Home / End", () => {
		const container = render("own");
		const selected = (): string | null =>
			tabButtons(container)
				.find((tab) => tab.getAttribute("aria-selected") === "true")
				?.getAttribute("data-tab") ?? null;
		const tabNamed = (id: string): HTMLElement => tabButtons(container).find((tab) => tab.dataset.tab === id)!;

		focus(tabNamed("mount-map"));
		pressKey(tabNamed("mount-map"), "ArrowRight");
		expect(selected()).toBe("namespace-explorer");
		expect(document.activeElement).toBe(tabNamed("namespace-explorer"));
		expect(tabNamed("namespace-explorer").tabIndex).toBe(0);
		expect(tabPanel(container, "namespace-explorer")!.classList.contains("ovk-is-hidden")).toBe(false);

		pressKey(tabNamed("namespace-explorer"), "End");
		expect(selected()).toBe("commit-audit");
		pressKey(tabNamed("commit-audit"), "ArrowRight");
		expect(selected()).toBe("mount-map");
		pressKey(tabNamed("mount-map"), "ArrowLeft");
		expect(selected()).toBe("commit-audit");
		pressKey(tabNamed("commit-audit"), "Home");
		expect(selected()).toBe("mount-map");
		expect(document.activeElement).toBe(tabNamed("mount-map"));
	});

	it("gives the reader's L0 / L1 / L2 tablist the same single tab stop", () => {
		const { dialog } = openFirstRow(render());
		const tiers = queryAllByRole(dialog, "tab");
		expect(tiers.length).toBeGreaterThanOrEqual(2);
		expect(tiers.filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
		for (const tab of tiers) {
			const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
			expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
		}
	});

	it("moves both tablists by one rule: arrows step and wrap, Home and End jump, other keys do nothing", () => {
		expect(nextTabIndex("ArrowRight", 2, 3)).toBe(0);
		expect(nextTabIndex("ArrowLeft", 0, 3)).toBe(2);
		expect(nextTabIndex("ArrowDown", 0, 3)).toBe(1);
		expect(nextTabIndex("ArrowUp", 1, 3)).toBe(0);
		expect(nextTabIndex("Home", 2, 3)).toBe(0);
		expect(nextTabIndex("End", 0, 3)).toBe(2);
		expect(nextTabIndex("Enter", 1, 3)).toBeNull();
		expect(nextTabIndex("ArrowRight", 0, 0)).toBeNull();
	});
});
