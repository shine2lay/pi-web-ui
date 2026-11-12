// @vitest-environment jsdom
/**
 * OpenViking Memory Dashboard — two sentences that must match what the page knows (frontend #280,
 * QA #136 final check F3 + F4).
 *
 *   F3  Card 2 says "Not measured per slot" only when every slot is `unmeasured-gap` (spec.md
 *       `slots[]`: per-slot figures if present, else unmeasured-gap). Live, the slot rows show measured
 *       figures while the card still said nothing measures a slot.
 *   F4  The header's sidecar sentence follows the health check: it answers while healthy, it does not
 *       answer while the server is unreachable (it said "answers" beside "Server Unreachable · Offline").
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenVikingDashboardSnapshot } from "../../web/src/openviking-dashboard/OpenVikingDashboardView.js";
import {
	mountDashboard,
	part,
	parts,
	requireSeamImplemented,
	text,
	type MountedDashboard,
} from "./openviking-dashboard-dom.js";
import {
	NOW_MS,
	auditResponse,
	entriesResponse,
	liveOverview,
	measuredSlotsOverview,
	offlineOverview,
	readySnapshot,
	staleOverview,
} from "./openviking-dashboard-fixtures.js";

const GAP_NOTE = "Not measured per slot";

let mounted: MountedDashboard | null = null;

function render(snapshot: OpenVikingDashboardSnapshot): HTMLElement {
	mounted = mountDashboard({ snapshot, nowMs: NOW_MS });
	requireSeamImplemented(mounted.container);
	return mounted.container;
}

const ready = (overview = liveOverview()): OpenVikingDashboardSnapshot =>
	readySnapshot(overview, entriesResponse(), auditResponse());

function injectionCard(container: HTMLElement): HTMLElement {
	const card = parts(container, "summary-card").find((c) => c.getAttribute("data-card-id") === "context-injection");
	if (!card) throw new Error("no context-injection card rendered");
	return card;
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
	mounted?.unmount();
	mounted = null;
	vi.unstubAllGlobals();
});

describe("openviking dashboard — card 2's per-slot gap note (QA #136 F3)", () => {
	it("drops the gap note when every slot has measured figures", () => {
		const container = render(ready(measuredSlotsOverview()));
		expect(text(injectionCard(container))).not.toContain(GAP_NOTE);
		expect(injectionCard(container).querySelector('[data-not-measured="true"]')).toBeNull();
	});

	it("drops the gap note when only some slots are measured", () => {
		const container = render(ready(measuredSlotsOverview([4, 5])));
		expect(text(injectionCard(container))).not.toContain(GAP_NOTE);
	});

	it("keeps the gap note when every slot is unmeasured", () => {
		const container = render(ready(liveOverview()));
		const card = injectionCard(container);
		expect(text(card)).toContain(GAP_NOTE);
		expect(card.querySelector('[data-source-field="slots[].hit_rate_pct"]')?.getAttribute("data-not-measured")).toBe(
			"true",
		);
	});
});

describe("openviking dashboard — the header's sidecar sentence (QA #136 F4)", () => {
	const subtitle = (container: HTMLElement): string =>
		text(part(container, "status-header")?.querySelector(".ovk-status-subtitle") ?? null);

	it("never says the sidecar answers while the server is unreachable", () => {
		const container = render(ready(offlineOverview()));
		const header = part(container, "status-header");
		expect(text(header)).toContain("Offline");
		expect(text(header)).not.toContain("answers the");
		expect(subtitle(container)).toContain("127.0.0.1:1933 does not answer the dashboard's health check");
	});

	it("says the sidecar answers while the health check answers", () => {
		for (const overview of [liveOverview(), staleOverview()]) {
			const container = render(ready(overview));
			expect(subtitle(container)).toContain("127.0.0.1:1933 answers the dashboard's health check");
			mounted?.unmount();
			mounted = null;
		}
	});
});
