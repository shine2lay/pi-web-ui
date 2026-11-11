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
import {
	OPENVIKING_ISOLATION_NOTICE_TEXT,
	OPENVIKING_TIER_BODY_LIMIT,
} from "../../web/src/openviking-dashboard/text.js";
import { applyEntryContent } from "../../web/src/openviking-dashboard/view-composition.js";
import type { OpenVikingEntryContent } from "../../web/src/openviking-dashboard/view-model-types.js";

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

	// #259 (Task 3) measured the live page: the drawer opened with focus still on the row button, so a
	// real Escape keypress never reached the dialog's handler and Tab had to cross every remaining row
	// before it could enter the drawer. The three assertions below are that keyboard path, not a
	// synthetic Escape dispatched straight at the dialog element.
	it("moves focus into the drawer when it opens", () => {
		const container = renderExplorer();
		const control = opener(memoryRows(container)[0]!);
		focus(control);
		click(control);
		const panel = drawer(container)!;
		expect(panel.contains(document.activeElement)).toBe(true);
	});

	it("closes on Escape pressed where the focus actually is after opening", () => {
		const container = renderExplorer();
		const control = opener(memoryRows(container)[1]!);
		focus(control);
		click(control);
		pressKey(document.activeElement as HTMLElement, "Escape");
		expect(drawer(container)).toBeNull();
		expect(document.activeElement).toBe(control);
	});

	it("keeps Tab inside the open drawer, which is what aria-modal promises", () => {
		const container = renderExplorer();
		click(opener(memoryRows(container)[0]!));
		const panel = drawer(container)!;
		const stops = [...panel.querySelectorAll<HTMLElement>("button")];
		const last = stops.at(-1)!;
		focus(last);
		pressKey(last, "Tab");
		expect(panel.contains(document.activeElement)).toBe(true);
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

/**
 * The drawer's deep read of `L1` / `L2` (frontend #259, Task 3 fix-forward).
 *
 * The live page failed its fresh-eyes check here: `/api/openviking/entries` (the list) carries `L0`
 * only, so every deeper tier said "Not stored for this entry" even where the daemon holds 177- and
 * 966,173-character bodies. The view now names the URI it needs and paints what comes back.
 */
const SHARED_URI = "viking://resources/rollcall/core/map.md";
const L1_TEXT = "# RollCall Overview (L1)\n\nThe repo's own summary of what lives where.";
const L2_TEXT = "# map.md\n\nEvery directory of the repository, with what it owns.";

/** What the list endpoint really answers: metadata and `L0`, never `L1`/`L2`. */
function listEntries() {
	const listed = entriesResponse();
	return { ...listed, entries: listed.entries.map((e) => ({ ...e, l1_overview: null, l2_content: null })) };
}

function listedEntry(uri: string) {
	return listEntries().entries.find((entry) => entry.uri === uri)!;
}

function rowIndexOf(uri: string): number {
	return listEntries().entries.findIndex((entry) => entry.uri === uri);
}

function renderDeep(extra: Record<string, unknown>): HTMLElement {
	mounted = mountDashboard({
		snapshot: { status: "ready", overview: liveOverview(), entries: listEntries(), audit: auditResponse() },
		nowMs: NOW_MS,
		activeTab: "namespace-explorer",
		...extra,
	} as never);
	requireSeamImplemented(mounted.container);
	return mounted.container;
}

function tierText(container: HTMLElement, name: "L0" | "L1" | "L2"): string {
	return text(drawer(container)?.querySelector(`[data-tier="${name}"]`) ?? null);
}

function readyContent(l1: string | null, l2: string | null): OpenVikingEntryContent {
	return { uri: SHARED_URI, status: "ready", entry: { ...listedEntry(SHARED_URI), l1_overview: l1, l2_content: l2 } };
}

describe("openviking drawer — the deep read of L1 / L2 (#259)", () => {
	it("names the open row's URI for the container and drops it when the drawer closes", () => {
		const asked: Array<string | null> = [];
		const container = renderDeep({ onDeepReadUriChange: (uri: string | null) => asked.push(uri) });
		click(opener(memoryRows(container)[rowIndexOf(SHARED_URI)]!));
		expect(asked.at(-1)).toBe(SHARED_URI);

		click(drawer(container)!.querySelector<HTMLElement>("button.ovk-drawer-close")!);
		expect(asked.at(-1)).toBeNull();
	});

	it("says Loading… while the read is in flight — never 'Not stored'", () => {
		const container = renderDeep({ entryContent: { uri: SHARED_URI, status: "loading" } });
		click(opener(memoryRows(container)[rowIndexOf(SHARED_URI)]!));
		for (const name of ["L1", "L2"] as const) {
			expect(tierText(container, name)).toContain("Loading");
			expect(tierText(container, name)).not.toContain("Not stored");
		}
	});

	it("paints the real L1 and L2 text once the content read answers", () => {
		const container = renderDeep({ entryContent: readyContent(L1_TEXT, L2_TEXT) });
		click(opener(memoryRows(container)[rowIndexOf(SHARED_URI)]!));
		expect(tierText(container, "L1")).toContain("The repo's own summary of what lives where.");
		expect(tierText(container, "L2")).toContain("Every directory of the repository, with what it owns.");
	});

	it("calls a tier empty only after the read answered with nothing", () => {
		const container = renderDeep({ entryContent: readyContent(null, null) });
		click(opener(memoryRows(container)[rowIndexOf(SHARED_URI)]!));
		expect(tierText(container, "L1")).toContain("Not stored for this entry");
	});

	it("says a failed read failed instead of calling the tier empty", () => {
		const entryContent: OpenVikingEntryContent = {
			uri: SHARED_URI,
			status: "failed",
			error: { code: "DAEMON_TIMEOUT", message: "127.0.0.1:1933 did not answer in time." },
		};
		const container = renderDeep({ entryContent });
		click(opener(memoryRows(container)[rowIndexOf(SHARED_URI)]!));
		expect(tierText(container, "L1")).toContain("Could not be read just now");
		expect(tierText(container, "L1")).not.toContain("Not stored");
	});

	it("clamps a huge L2 and says how much of it is on screen", () => {
		const container = renderDeep({
			entryContent: readyContent(L1_TEXT, "x".repeat(OPENVIKING_TIER_BODY_LIMIT + 5_000)),
		});
		click(opener(memoryRows(container)[rowIndexOf(SHARED_URI)]!));
		const painted = tierText(container, "L2");
		expect(painted.length).toBeLessThan(OPENVIKING_TIER_BODY_LIMIT + 500);
		expect(painted).toContain("showing the first 20,000 of 25,000 characters");
	});

	it("never asks for another role's memory and keeps the isolation notice", () => {
		const asked: Array<string | null> = [];
		const container = renderDeep({ onDeepReadUriChange: (uri: string | null) => asked.push(uri) });
		click(opener(memoryRows(container)[rowIndexOf("viking://agent/memories/cases/n126.md")]!));
		expect(asked.at(-1)).toBeNull();
		expect(text(drawer(container))).toContain(OPENVIKING_ISOLATION_NOTICE_TEXT);
	});
});

describe("applyEntryContent — content belongs to the row it was read for (#259)", () => {
	const source = { kind: "memory" as const, rowKey: "mem-1", entry: listedEntry(SHARED_URI) };

	it("treats a read that has not started as pending", () => {
		expect(applyEntryContent(source, null)?.read).toBe("pending");
	});

	it("never paints another row's content", () => {
		const other = { ...readyContent(L1_TEXT, L2_TEXT), uri: "viking://resources/pi-web-ui/core/map.md" };
		const applied = applyEntryContent(source, other as OpenVikingEntryContent);
		expect(applied?.read).toBe("pending");
		expect(applied?.source.kind === "memory" && applied.source.entry.l1_overview).toBeNull();
	});

	it("hands the drawer the deep bodies read for this row", () => {
		const applied = applyEntryContent(source, readyContent(L1_TEXT, L2_TEXT));
		expect(applied?.read).toBe("settled");
		expect(applied?.source.kind === "memory" && applied.source.entry.l2_content).toBe(L2_TEXT);
	});
});
