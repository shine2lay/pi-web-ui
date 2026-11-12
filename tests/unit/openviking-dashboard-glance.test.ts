// @vitest-environment jsdom
/**
 * OpenViking Memory Dashboard — honest partial lists and per-panel loading (frontend #273).
 *
 * Design's production sign-off (PROD-SIGNOFF.md M1, M4) and #269's F2:
 *  - M1: a listing the daemon only partly answered never reads as the whole store, a row whose L0 was
 *    not read never reads as a row with no abstract, and an entries answer under an unreachable server
 *    shows the unreachable treatment instead of a fresh "Updated" age;
 *  - M4: the status header and the three cards paint from `/overview` alone; the Explorer and the audit
 *    keep their own loading state, and a list of ~1,800 rows paints a bounded first page;
 *  - F2: a failed entries or audit call errors only its own panel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenVikingEntriesResponse, OpenVikingExplorerEntry } from "../../server/openviking/types.js";
import type { OpenVikingDashboardSnapshot } from "../../web/src/openviking-dashboard/OpenVikingDashboardView.js";
import { OPENVIKING_EXPLORER_PAGE_SIZE } from "../../web/src/openviking-dashboard/text.js";
import {
	click,
	mountDashboard,
	part,
	parts,
	tabPanel,
	text,
	type MountedDashboard,
} from "../openviking-dashboard/openviking-dashboard-dom.js";
import {
	NOW_ISO,
	NOW_MS,
	auditResponse,
	entriesResponse,
	liveOverview,
	minutesAgo,
	offlineOverview,
	readySnapshot,
} from "../openviking-dashboard/openviking-dashboard-fixtures.js";

let mounted: MountedDashboard | null = null;

function render(snapshot: OpenVikingDashboardSnapshot): HTMLElement {
	mounted = mountDashboard({ snapshot, nowMs: NOW_MS, activeTab: "namespace-explorer" });
	return mounted.container;
}

const explorer = (container: HTMLElement): HTMLElement => {
	const panel = tabPanel(container, "namespace-explorer");
	if (!panel) throw new Error("no Memory Explorer panel");
	return panel;
};
const audit = (container: HTMLElement): HTMLElement => {
	const panel = tabPanel(container, "commit-audit");
	if (!panel) throw new Error("no audit panel");
	return panel;
};
const panelState = (panel: HTMLElement): string | null =>
	panel.querySelector("[data-panel-state]")?.getAttribute("data-panel-state") ?? null;

function partialEntries(unread: number): OpenVikingEntriesResponse {
	return { ...entriesResponse(), entries_partial: true, unread_count: unread };
}

function manyEntries(count: number): OpenVikingEntriesResponse {
	const base = entriesResponse().entries[0] as OpenVikingExplorerEntry;
	return {
		...entriesResponse(),
		entries: Array.from({ length: count }, (_, i) => ({
			...base,
			uri: `viking://resources/rollcall/docs/note-${i + 1}.md`,
			title: `Note ${i + 1}`,
		})),
	};
}

/** Tier 1 has painted: the header names a state and no card is still a skeleton. */
function expectTierOnePainted(container: HTMLElement): void {
	expect(container.querySelector('[data-screen-state="live"]')).not.toBeNull();
	expect(text(part(container, "status-header"))).not.toContain("Loading…");
	const cards = parts(container, "summary-card");
	expect(cards).toHaveLength(3);
	for (const card of cards) expect(card.getAttribute("data-health-state")).not.toBe("loading");
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
	mounted?.unmount();
	mounted = null;
	vi.unstubAllGlobals();
});

describe("openviking explorer — a partial listing says so (M1)", () => {
	it("puts the unread count beside the panel age, with a glyph and words, not colour alone", () => {
		const container = render(readySnapshot(liveOverview(), partialEntries(37)));
		const panel = explorer(container);
		const badge = part(panel, "unread-badge");
		expect(badge).not.toBeNull();
		expect(badge?.getAttribute("data-unread-count")).toBe("37");
		expect(text(badge)).toContain("◐");
		expect(text(badge)).toContain("37 not read");
		expect(badge?.getAttribute("aria-label") ?? "").toMatch(/may be missing/i);
		// A short list is not an outage: the panel keeps its own age and the screen stays healthy.
		expect(text(panel)).toMatch(/Updated 3m ago/);
		expect(container.querySelector('[data-screen-state="live"]')).not.toBeNull();
		expect(panel.querySelector('[data-health-state="server-unreachable"]')).toBeNull();
	});

	it("shows no unread badge for a listing that read everything", () => {
		const container = render(readySnapshot());
		expect(part(explorer(container), "unread-badge")).toBeNull();
	});

	it("marks a row whose L0 abstract did not answer as not read, never as an empty abstract", () => {
		const entries = entriesResponse();
		const first = entries.entries[0] as OpenVikingExplorerEntry;
		const second = entries.entries[1] as OpenVikingExplorerEntry;
		entries.entries[0] = { ...first, l0_abstract: null };
		entries.entries[1] = { ...second, l0_abstract: "A read abstract" };
		// The row's own deep read answered and still carried no L0: the drawer must say so too.
		mounted = mountDashboard({
			snapshot: readySnapshot(liveOverview(), entries),
			nowMs: NOW_MS,
			activeTab: "namespace-explorer",
			entryContent: { uri: first.uri, status: "ready", entry: { ...first, l0_abstract: null } },
		});
		const container = mounted.container;
		const rows = parts(explorer(container), "memory-row");
		const unread = rows.find((row) => row.getAttribute("data-row-key") === "mem-1");
		const read = rows.find((row) => row.getAttribute("data-row-key") === "mem-2");
		const marker = unread?.querySelector('[data-l0-state="not-read"]');
		expect(marker).not.toBeNull();
		expect(text(marker ?? null)).toMatch(/abstract not read/i);
		expect(text(unread ?? null)).not.toMatch(/no abstract/i);
		expect(read?.querySelector('[data-l0-state="not-read"]')).toBeNull();
		expect(text(read ?? null)).toContain("A read abstract");

		// The drawer's L0 tier says the same, never an empty tier.
		click(unread?.querySelector("button") as HTMLElement);
		expect(text(part(document.body, "reader-drawer"))).toMatch(/abstract not read/i);
	});

	it("gives an entries answer under an unreachable server the unreachable treatment and no fresh age", () => {
		const unreachable: OpenVikingEntriesResponse = {
			panel_updated_at: NOW_ISO,
			health_state: "server-unreachable",
			stale_badge: null,
			entries_partial: true,
			unread_count: 17,
			entries: [],
		};
		const container = render(readySnapshot(offlineOverview(minutesAgo(18)), unreachable));
		const panel = explorer(container);
		const pill = panel.querySelector('[data-health-state="server-unreachable"]');
		expect(pill).not.toBeNull();
		expect(text(pill)).toContain("✕");
		expect(text(part(panel, "explorer-unreachable"))).toMatch(/unreachable/i);
		expect(text(panel)).toMatch(/Last answered 18m ago/);
		expect(text(panel)).not.toMatch(/Updated \d/);
		expect(text(panel)).not.toContain("No memory entries in this view.");
	});

	it("prints no age at all for a failed listing while /health still answers", () => {
		// Design's probe-mixed.json: /overview healthy (last answered seconds ago), /entries unreachable.
		const unreachable: OpenVikingEntriesResponse = {
			panel_updated_at: NOW_ISO,
			health_state: "server-unreachable",
			stale_badge: null,
			entries_partial: true,
			unread_count: 17,
			entries: [],
		};
		const container = render(readySnapshot(liveOverview(), unreachable));
		const panel = explorer(container);
		expect(panel.querySelector('[data-health-state="server-unreachable"]')).not.toBeNull();
		expect(text(part(panel, "listing-failed"))).toMatch(/health check still answers/i);
		expect(part(panel, "last-answered")).toBeNull();
		expect(text(panel)).not.toMatch(/(Updated|Last answered) \d/);
		expect(text(panel)).not.toContain("No memory entries in this view.");
	});
});

describe("openviking dashboard — each panel loads on its own (M4, F2)", () => {
	it("lists rows that answered before /overview did, never an empty-list note", () => {
		const container = render({
			overview: { status: "loading" },
			entries: { status: "ready", data: entriesResponse() },
			audit: { status: "ready", data: auditResponse() },
		});
		const panel = explorer(container);
		expect(panelState(panel)).toBe("ready");
		expect(parts(panel, "memory-row").length).toBe(entriesResponse().entries.length);
		expect(text(panel)).not.toMatch(/No memory entries/);
		expect(parts(audit(container), "audit-row").length).toBe(auditResponse().events.length);
	});

	it("paints the header and cards from overview while entries and audit are still pending", () => {
		const container = render({
			overview: { status: "ready", data: liveOverview() },
			entries: { status: "loading" },
			audit: { status: "loading" },
		});
		expectTierOnePainted(container);
		expect(panelState(explorer(container))).toBe("loading");
		expect(panelState(audit(container))).toBe("loading");
		expect(text(explorer(container))).not.toContain("No memory entries in this view.");
		expect(parts(container, "memory-row")).toHaveLength(0);
	});

	it("errors only the Explorer when entries answers 500", () => {
		const container = render({
			overview: { status: "ready", data: liveOverview() },
			entries: { status: "failed", message: "/api/openviking/entries answered 500" },
			audit: { status: "ready", data: auditResponse() },
		});
		expectTierOnePainted(container);
		const panel = explorer(container);
		expect(panelState(panel)).toBe("failed");
		expect(text(panel)).toMatch(/could not be read/i);
		expect(text(panel)).not.toMatch(/Updated \d/);
		expect(panelState(audit(container))).toBe("ready");
		expect(parts(container, "audit-row").length).toBeGreaterThan(0);
	});

	it("errors only the audit when audit answers 500", () => {
		const container = render({
			overview: { status: "ready", data: liveOverview() },
			entries: { status: "ready", data: entriesResponse() },
			audit: { status: "failed", message: "/api/openviking/audit answered 500" },
		});
		expectTierOnePainted(container);
		const panel = audit(container);
		expect(panelState(panel)).toBe("failed");
		expect(text(panel)).toMatch(/could not be read/i);
		expect(text(panel)).not.toMatch(/Updated \d/);
		expect(panelState(explorer(container))).toBe("ready");
		expect(parts(container, "memory-row").length).toBeGreaterThan(0);
	});

	it("puts a bounded first page of a large listing in the DOM and pages the rest on request", () => {
		const container = render(readySnapshot(liveOverview(), manyEntries(1_841)));
		expect(parts(container, "memory-row")).toHaveLength(OPENVIKING_EXPLORER_PAGE_SIZE);
		const more = part(explorer(container), "explorer-show-more");
		expect(text(more)).toMatch(/Show \d+ more/);
		expect(text(part(explorer(container), "explorer-page-count"))).toContain(`of 1,841`);
		click(more as HTMLElement);
		expect(parts(container, "memory-row")).toHaveLength(OPENVIKING_EXPLORER_PAGE_SIZE * 2);
	});
});
