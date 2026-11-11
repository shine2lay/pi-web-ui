// @vitest-environment jsdom
/**
 * OpenViking Memory Dashboard — rendered acceptance assertions for the first view: status header,
 * three summary cards, three workspace tabs, and every screen state (frontend #261, Task 1).
 *
 * Queries go by role, accessible name and the contract's `data-*` attributes.
 * They all fail today for one reason: the view is still the Task 1 stub.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENVIKING_CONTEXT_SLOTS } from "../../server/openviking/types.js";
import type {
	OpenVikingDashboardSnapshot,
	OpenVikingDashboardViewProps,
} from "../../web/src/openviking-dashboard/OpenVikingDashboardView.js";
import {
	HASH_64,
	RAW_PATH,
	click,
	mountDashboard,
	part,
	parts,
	queryAllByRole,
	requireSeamImplemented,
	tabButtons,
	tabPanel,
	text,
	type MountedDashboard,
} from "./openviking-dashboard-dom.js";
import {
	NOW_MS,
	auditResponse,
	emptyOverview,
	entriesResponse,
	liveOverview,
	minutesAgo,
	offlineOverview,
	staleOverview,
} from "./openviking-dashboard-fixtures.js";

let mounted: MountedDashboard | null = null;

const ready = (
	overview = liveOverview(),
	entries = entriesResponse(),
	audit = auditResponse(),
): OpenVikingDashboardSnapshot => ({ status: "ready", overview, entries, audit });

function render(snapshot: OpenVikingDashboardSnapshot, extra?: Partial<OpenVikingDashboardViewProps>): HTMLElement {
	mounted = mountDashboard({ snapshot, nowMs: NOW_MS, ...extra });
	requireSeamImplemented(mounted.container);
	return mounted.container;
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
	mounted?.unmount();
	mounted = null;
	vi.unstubAllGlobals();
});

describe("openviking dashboard page — status header", () => {
	it("reads Active with a folder count, never a liveness claim", () => {
		const container = render(ready());
		const header = part(container, "status-header");
		expect(header).not.toBeNull();
		expect(text(header)).toContain("Active");
		const folders = header?.querySelector('[data-source-field="observer.role_memory_folder_count"]') ?? null;
		expect(text(folders)).toBe("15 role memory folders");
		expect(text(container)).not.toMatch(/roles live|\bonline\b/i);
		expect(container.querySelector('[data-screen-state="live"]')).not.toBeNull();
	});

	it("reads Offline with the honest check line and the muted last-answered line", () => {
		const container = render(ready(offlineOverview(minutesAgo(18))));
		const header = part(container, "status-header");
		expect(text(header)).toContain("Offline");
		expect(text(header?.querySelector('[data-source-field="observer.checked_at"]') ?? null)).toContain("4s ago");
		const lastAnswered = header?.querySelector('[data-source-field="observer.last_reachable_at"]') ?? null;
		expect(text(lastAnswered)).toBe("Last answered 18m ago");
	});

	it("never turns a null last_reachable_at into a duration, a 0 or a recent-looking dash", () => {
		const container = render(ready(offlineOverview(null)));
		const line =
			part(container, "status-header")?.querySelector('[data-source-field="observer.last_reachable_at"]') ?? null;
		expect(text(line)).toBe("No successful contact since the dashboard server started");
		expect(text(line)).not.toMatch(/ago|just now|\d/);
	});

	it("hides the last-answered line outside the offline state", () => {
		for (const snapshot of [ready(), ready(staleOverview()), ready(emptyOverview())]) {
			const container = render(snapshot);
			expect(container.querySelector('[data-source-field="observer.last_reachable_at"]')).toBeNull();
			mounted?.unmount();
			mounted = null;
		}
	});
});

describe("openviking dashboard page — summary cards", () => {
	it("shows three cards, each with at most five text fields and its own panel age", () => {
		const container = render(ready());
		const cards = parts(container, "summary-card");
		expect(cards.map((c) => c.getAttribute("data-card-id"))).toEqual([
			"system-health",
			"context-injection",
			"commit-governance",
		]);
		for (const card of cards) {
			expect(card.querySelectorAll("[data-field]").length).toBeLessThanOrEqual(5);
			expect(card.getAttribute("data-panel-updated-at")).toBeTruthy();
			expect(card.getAttribute("data-health-state")).toBeTruthy();
		}
	});

	it("labels the commit figure as session commits and the queue depth as unavailable", () => {
		const container = render(ready());
		expect(text(container.querySelector('[data-source-field="changelog.session_commits_24h"]'))).toBe(
			"18 session commits",
		);
		const queue = container.querySelector('[data-source-field="observer.queue_depth"]');
		expect(text(queue)).toMatch(/unavailable/i);
		expect(text(queue)).not.toMatch(/\b0\b/);
	});

	it("keeps the local-log cards out of Server Unreachable while :1933 is down", () => {
		const container = render(ready(offlineOverview()));
		const [health, injection, governance] = parts(container, "summary-card");
		expect(health?.getAttribute("data-health-state")).toBe("server-unreachable");
		expect(injection?.getAttribute("data-health-state")).not.toBe("server-unreachable");
		expect(governance?.getAttribute("data-health-state")).not.toBe("server-unreachable");
		expect(text(governance)).toMatch(/local audit log/i);
		expect(text(injection)).toMatch(/local metrics log/i);
		const unreachable = container.querySelectorAll('[data-unreachable-value="true"]');
		expect(unreachable.length).toBeGreaterThan(0);
		for (const el of unreachable) expect(text(el)).toBe("— (Unreachable)");
	});

	it("fakes no zero while loading", () => {
		const container = render({ status: "loading" });
		expect(container.querySelector('[data-screen-state="loading"]')).not.toBeNull();
		for (const field of container.querySelectorAll("[data-field]")) {
			expect(text(field)).not.toMatch(/\b0\b/);
		}
		for (const el of container.querySelectorAll("[data-icon]")) {
			expect(el.getAttribute("data-icon")).not.toMatch(/circle-check|clock-stale|octagon-x|circle-empty/);
		}
	});

	it("claims zero activity only while no tab lists an event", () => {
		const quiet = render(
			ready(emptyOverview(), { ...entriesResponse(), entries: [] }, { ...auditResponse(), events: [] }),
		);
		expect(text(quiet)).toContain("0 events in window (server online)");
		mounted?.unmount();
		mounted = null;

		const busy = render(ready(emptyOverview()));
		const auditRows = parts(tabPanel(busy, "commit-audit") ?? busy, "audit-row");
		expect(auditRows.length).toBeGreaterThan(0);
		expect(text(busy)).not.toContain("0 events in window");
		expect(busy.querySelectorAll('[data-health-state="zero-activity"]').length).toBe(0);
	});
});

describe("openviking dashboard page — workspace tabs", () => {
	it("offers three named tabs and switches panels on click", () => {
		const container = render(ready());
		const tabs = tabButtons(container);
		expect(tabs.map((t) => t.getAttribute("data-tab"))).toEqual(["mount-map", "namespace-explorer", "commit-audit"]);
		expect(tabs.every((t) => t.tagName === "BUTTON" && text(t) !== "")).toBe(true);
		expect(tabs.filter((t) => t.getAttribute("aria-selected") === "true")).toHaveLength(1);

		click(tabs[2]!);
		expect(tabs[2]?.getAttribute("aria-selected")).toBe("true");
		expect(queryAllByRole(container, "tabpanel").length).toBeGreaterThan(0);
		expect(tabPanel(container, "commit-audit")).not.toBeNull();
	});

	it("lists the five mount slots with their contract labels and no measured claim", () => {
		const container = render(ready(), { activeTab: "mount-map" });
		const panel = tabPanel(container, "mount-map");
		const rows = parts(panel ?? container, "slot-row");
		expect(rows).toHaveLength(5);
		expect(rows.map((r) => text(r.querySelector("[data-slot-label]")))).toEqual(
			OPENVIKING_CONTEXT_SLOTS.map((s) => s.label),
		);
		for (const row of rows) {
			expect(text(row)).toContain("Not measured");
			expect(text(row)).not.toMatch(/\bhit\b/i);
		}
	});

	it("groups the memory explorer by repo and role instead of a flat list", () => {
		const container = render(ready(), { activeTab: "namespace-explorer" });
		const panel = tabPanel(container, "namespace-explorer");
		const groups = parts(panel ?? container, "memory-group");
		expect(groups.length).toBeGreaterThan(1);
		const rows = parts(panel ?? container, "memory-row");
		expect(rows.length).toBe(entriesResponse().entries.length);
		for (const group of groups) {
			expect(text(group.querySelector("[data-group-title]"))).not.toBe("");
			expect(parts(group, "memory-row").length).toBeGreaterThan(0);
		}
		for (const row of rows) {
			expect(text(row)).not.toMatch(HASH_64);
			expect(text(row)).not.toMatch(RAW_PATH);
		}
	});

	it("streams the audit with its five actions and filter controls", () => {
		const container = render(ready(), { activeTab: "commit-audit" });
		const panel = tabPanel(container, "commit-audit");
		const rows = parts(panel ?? container, "audit-row");
		expect(rows.map((r) => r.getAttribute("data-action"))).toEqual([
			"commit",
			"role_memory_write",
			"promote_shared",
			"reject_noise",
			"sidecar_timeout",
		]);
		const write = rows.find((r) => r.getAttribute("data-action") === "role_memory_write");
		expect(text(write?.querySelector("[data-action-label]") ?? null)).not.toMatch(/commit/i);
		expect(part(panel ?? container, "audit-filters")).not.toBeNull();
		expect(text(panel).toLowerCase()).not.toContain("design's private note");
	});
});

describe("openviking dashboard page — states and prototype chrome", () => {
	it("marks every tab stale, with the server's own reason and no fresh age", () => {
		const staleEntries = { ...entriesResponse(), health_state: "stale" as const, stale_badge: "> 15m" as const };
		const staleAudit = { ...auditResponse(), health_state: "stale" as const, stale_badge: "> 15m" as const };
		const container = render(ready(staleOverview(), staleEntries, staleAudit));
		expect(container.querySelector('[data-screen-state="stale"]')).not.toBeNull();
		for (const tab of ["mount-map", "namespace-explorer", "commit-audit"]) {
			const panel = tabPanel(container, tab);
			expect(panel?.querySelector('[data-stale-badge="true"]')).not.toBeNull();
		}
	});

	it("shows no fresh daemon age inside a tab while :1933 is unreachable", () => {
		const container = render(ready(offlineOverview()));
		for (const tab of ["mount-map", "namespace-explorer", "commit-audit"]) {
			expect(text(tabPanel(container, tab))).not.toMatch(/\b\d{1,2}s ago\b/);
		}
	});

	it("renders none of the prototype-only chrome", () => {
		const container = render(ready());
		expect(document.getElementById("stateStrip")).toBeNull();
		expect(document.querySelectorAll("[data-st-state]")).toHaveLength(0);
		expect(container.querySelectorAll("[data-st-state]")).toHaveLength(0);
		expect(document.querySelector("script#openviking-fixture-data")).toBeNull();
		expect((globalThis as Record<string, unknown>)["__hidePrototypeChrome"]).toBeUndefined();
		expect((globalThis as Record<string, unknown>)["__OPENVIKING_FIXTURE__"]).toBeUndefined();
	});
});
