/**
 * OpenViking Memory Dashboard — acceptance assertions for the status header, the three summary
 * cards and the five mount rows (frontend #261, Task 1; built by #258, proved blind by #259).
 *
 * These assertions come from `.temper/features/openviking-dashboard/spec.md` + `spec-states.md`
 * (behaviour and field names) and `design.md` §Screen States (wording and visuals). Task 2 may not
 * delete or weaken them (owner rule bp-31e47f57).
 *
 * They all fail today for one reason: every seam function is a Task 1 stub.
 */

import { describe, expect, it } from "vitest";
import { OPENVIKING_CONTEXT_SLOTS } from "../../server/openviking/types.js";
import {
	formatAge,
	formatFigure,
	formatLastAnswered,
	formatPanelAge,
	formatPercent,
} from "../../web/src/openviking-dashboard/format.js";
import {
	buildSlotRows,
	buildStatePresentation,
	buildStatusHeader,
	buildSummaryCards,
} from "../../web/src/openviking-dashboard/overview-view-model.js";
import {
	OPENVIKING_NOT_MEASURED_TEXT,
	OPENVIKING_NO_CONTACT_TEXT,
	OPENVIKING_UNREACHABLE_TEXT,
} from "../../web/src/openviking-dashboard/text.js";
import {
	NOW_MS,
	daysAgo,
	emptyOverview,
	hoursAgo,
	liveOverview,
	minutesAgo,
	offlineOverview,
	secondsAgo,
	staleOverview,
} from "./openviking-dashboard-fixtures.js";

const BANNED_LIVENESS = /roles live|\bonline\b|\blive\b/i;

describe("openviking dashboard — age and figure formatting", () => {
	it("reads seconds under a minute, hours and days above an hour, and never ages a null timestamp", () => {
		expect(formatAge(secondsAgo(3), NOW_MS)).toBe("3s");
		expect(formatAge(secondsAgo(59), NOW_MS)).toBe("59s");
		expect(formatAge(minutesAgo(18), NOW_MS)).toBe("18m");
		expect(formatAge(hoursAgo(5), NOW_MS)).toBe("5h");
		expect(formatAge(daysAgo(3), NOW_MS)).toBe("3d");
		expect(formatAge(null, NOW_MS)).toBeNull();
	});

	it("never reports a long outage in minutes (design #286: hours and days above 60m)", () => {
		expect(formatAge(minutesAgo(4_320), NOW_MS)).not.toMatch(/\d+m$/);
		expect(formatAge(minutesAgo(4_320), NOW_MS)).toBe("3d");
	});

	it("formats the last-answered line as a duration, and a null as the no-contact sentence", () => {
		const answered = formatLastAnswered(minutesAgo(18), NOW_MS);
		expect(answered.text).toBe("Last answered 18m ago");
		expect(answered.isDuration).toBe(true);
		expect(answered.sourceField).toBe("observer.last_reachable_at");

		const fresh = formatLastAnswered(secondsAgo(3), NOW_MS);
		expect(fresh.text).toBe("Last answered 3s ago");
		expect(fresh.text).not.toContain("0m");

		const never = formatLastAnswered(null, NOW_MS);
		expect(never.text).toBe(OPENVIKING_NO_CONTACT_TEXT);
		expect(never.isDuration).toBe(false);
		expect(never.text).not.toMatch(/\d/);
		expect(never.text).not.toMatch(/just now|ago|—/);
	});

	it("renders a null figure as — (Unreachable) and an unmeasured one as Not measured, never 0", () => {
		const missing = formatFigure(null, "observer.role_memory_folder_count");
		expect(missing.text).toBe(OPENVIKING_UNREACHABLE_TEXT);
		expect(missing.unreachable).toBe(true);
		expect(missing.text).not.toMatch(/\b0\b|healthy/i);

		const counted = formatFigure(48, "metrics.turns_sampled_24h", { suffix: "turns" });
		expect(counted.text).toBe("48 turns");
		expect(counted.unreachable).toBe(false);

		const unmeasured = formatFigure(null, "slots[].avg_tokens", { notMeasured: true });
		expect(unmeasured.text).toBe(OPENVIKING_NOT_MEASURED_TEXT);
		expect(unmeasured.notMeasured).toBe(true);
		expect(unmeasured.unreachable).toBe(false);

		expect(formatPercent(94.2, "metrics.slot_hit_rate_pct").text).toBe("94.2%");
		expect(formatPercent(null, "metrics.slot_hit_rate_pct").text).toBe(OPENVIKING_UNREACHABLE_TEXT);
		expect(formatPercent(null, "slots[].hit_rate_pct", { notMeasured: true }).text).toBe(OPENVIKING_NOT_MEASURED_TEXT);
	});

	it("dates a panel from its own timestamp, and shows no age line when there is none", () => {
		const age = formatPanelAge("Updated", minutesAgo(5), NOW_MS, "changelog.last_event_at");
		expect(age?.text).toBe("Updated 5m ago");
		expect(age?.sourceField).toBe("changelog.last_event_at");
		expect(formatPanelAge("Updated", null, NOW_MS, "changelog.last_event_at")).toBeNull();
	});
});

describe("openviking dashboard — status header", () => {
	it("shows the server's mode label and the folder count as folders, never as liveness", () => {
		const header = buildStatusHeader(liveOverview(), NOW_MS, "live");
		expect(header.modeLabel).toBe("Active");
		expect(header.roleMemoryFolders.text).toBe("15 role memory folders");
		expect(header.roleMemoryFolders.sourceField).toBe("observer.role_memory_folder_count");
		expect(header.roleMemoryFolders.text).not.toMatch(BANNED_LIVENESS);
		expect(header.checkedAge.text).toBe("Checked 4s ago");
		expect(header.checkedAge.sourceField).toBe("observer.checked_at");
		expect(header.lastAnswered).toBeNull();
	});

	it("uses the degraded and offline mode labels verbatim", () => {
		expect(buildStatusHeader(staleOverview(), NOW_MS, "stale").modeLabel).toBe("Degraded Local Fallback");
		expect(buildStatusHeader(offlineOverview(), NOW_MS, "error").modeLabel).toBe("Offline");
	});

	it("renders the last-answered line in the error state only, and never as a duration when null", () => {
		expect(buildStatusHeader(liveOverview(), NOW_MS, "live").lastAnswered).toBeNull();
		expect(buildStatusHeader(staleOverview(), NOW_MS, "stale").lastAnswered).toBeNull();

		const offline = buildStatusHeader(offlineOverview(minutesAgo(18)), NOW_MS, "error");
		expect(offline.lastAnswered?.text).toBe("Last answered 18m ago");

		const noContact = buildStatusHeader(offlineOverview(null), NOW_MS, "error");
		expect(noContact.lastAnswered?.text).toBe(OPENVIKING_NO_CONTACT_TEXT);
		expect(noContact.lastAnswered?.isDuration).toBe(false);
	});

	it("lets last_reachable_at gate nothing: flipping it changes no state, label or pill", () => {
		const withAge = buildStatusHeader(offlineOverview(minutesAgo(18)), NOW_MS, "error");
		const withNull = buildStatusHeader(offlineOverview(null), NOW_MS, "error");
		const withOld = buildStatusHeader(offlineOverview(daysAgo(3)), NOW_MS, "error");
		for (const other of [withNull, withOld]) {
			expect(other.modeLabel).toBe(withAge.modeLabel);
			expect(other.renderState).toBe(withAge.renderState);
			expect(other.presentation).toEqual(withAge.presentation);
			expect(other.roleMemoryFolders).toEqual(withAge.roleMemoryFolders);
		}
	});

	it("shows an unreachable folder count instead of 0 while :1933 is down", () => {
		const header = buildStatusHeader(offlineOverview(), NOW_MS, "error");
		expect(header.roleMemoryFolders.text).toBe(OPENVIKING_UNREACHABLE_TEXT);
		expect(header.roleMemoryFolders.unreachable).toBe(true);
		expect(header.roleMemoryFolders.text).not.toMatch(/\b0\b/);
	});

	it("shows no faked counters and no status glyph while loading", () => {
		const header = buildStatusHeader(null, NOW_MS, "loading");
		expect(header.renderState).toBe("loading");
		expect(header.presentation.glyph).toBeNull();
		expect(header.presentation.dataIcon).toBeNull();
		expect(header.roleMemoryFolders.text).not.toMatch(/\b0\b/);
		expect(header.lastAnswered).toBeNull();
	});
});

describe("openviking dashboard — summary cards", () => {
	it("builds three cards, in order, each with at most five text fields", () => {
		const cards = buildSummaryCards(liveOverview(), NOW_MS, "live");
		expect(cards.map((c) => c.cardId)).toEqual(["system-health", "context-injection", "commit-governance"]);
		for (const card of cards) {
			expect(card.fields.length).toBeLessThanOrEqual(5);
			expect(card.title.trim()).not.toBe("");
		}
	});

	it("labels the 24h commit figure as session commits, never as bare commits", () => {
		const cards = buildSummaryCards(liveOverview(), NOW_MS, "live");
		const governance = cards.find((c) => c.cardId === "commit-governance");
		const commits = governance?.fields.find((f) => f.sourceField === "changelog.session_commits_24h");
		expect(commits?.text).toBe("18 session commits");
		expect(commits?.text).not.toMatch(/^\d+\s+commits$/);
	});

	it("renders the always-null queue depth as unavailable, never as 0", () => {
		const cards = buildSummaryCards(liveOverview(), NOW_MS, "live");
		const health = cards.find((c) => c.cardId === "system-health");
		const queue = health?.fields.find((f) => f.sourceField === "observer.queue_depth");
		expect(queue).toBeDefined();
		expect(queue?.text).toMatch(/unavailable/i);
		expect(queue?.text).not.toMatch(/\b0\b/);
	});

	it("gives every card its own panel health, so a local-log card is never Server Unreachable", () => {
		const cards = buildSummaryCards(offlineOverview(), NOW_MS, "error");
		const [health, injection, governance] = cards;
		expect(health?.presentation.healthState).toBe("server-unreachable");
		expect(injection?.presentation.healthState).not.toBe("server-unreachable");
		expect(governance?.presentation.healthState).not.toBe("server-unreachable");
		expect(injection?.presentation.staleBadge).toBe("> 5m");
		expect(governance?.presentation.staleBadge).toBe("> 15m");
		expect(injection?.sourceNote).toMatch(/local metrics log/i);
		expect(governance?.sourceNote).toMatch(/local audit log/i);
		expect(governance?.age?.text).toBe("Updated 23m ago");
	});

	it("blanks the daemon figures while :1933 is down and keeps the local counts", () => {
		const cards = buildSummaryCards(offlineOverview(), NOW_MS, "error");
		const health = cards.find((c) => c.cardId === "system-health");
		for (const field of health?.fields ?? []) {
			expect(field.text).not.toMatch(/healthy/i);
		}
		expect(health?.fields.some((f) => f.unreachable && f.text === OPENVIKING_UNREACHABLE_TEXT)).toBe(true);
		const governance = cards.find((c) => c.cardId === "commit-governance");
		const commits = governance?.fields.find((f) => f.sourceField === "changelog.session_commits_24h");
		expect(commits?.text).toBe("18 session commits");
		expect(commits?.unreachable).toBe(false);
	});

	it("says zero activity on an online empty window, not Healthy, Stale or Server Unreachable", () => {
		const cards = buildSummaryCards(emptyOverview(), NOW_MS, "empty");
		const governance = cards.find((c) => c.cardId === "commit-governance");
		expect(governance?.presentation.healthState).toBe("zero-activity");
		expect(governance?.presentation.label).not.toMatch(/healthy|stale|unreachable/i);
		expect(governance?.fields.some((f) => f.text.includes("server online"))).toBe(true);
	});

	it("fakes no counter while loading and shows a loading pill without a status glyph", () => {
		const cards = buildSummaryCards(null, NOW_MS, "loading");
		expect(cards).toHaveLength(3);
		for (const card of cards) {
			expect(card.presentation.healthState).toBe("loading");
			expect(card.presentation.glyph).toBeNull();
			expect(card.presentation.dataIcon).toBeNull();
			for (const field of card.fields) {
				expect(field.text).not.toMatch(/\b0\b/);
			}
		}
	});
});

describe("openviking dashboard — mount rows and state presentation", () => {
	it("lists the five slots with the labels from server/openviking/types.ts", () => {
		const rows = buildSlotRows(liveOverview(), NOW_MS, "live");
		expect(rows.map((r) => r.slotId)).toEqual([1, 2, 3, 4, 5]);
		expect(rows.map((r) => r.label)).toEqual(OPENVIKING_CONTEXT_SLOTS.map((s) => s.label));
		expect(rows.map((r) => r.uriPrefix)).toEqual(OPENVIKING_CONTEXT_SLOTS.map((s) => s.uri_prefix));
	});

	it("marks an unmeasured slot neutral — never a healthy Hit badge (spec G3)", () => {
		for (const row of buildSlotRows(liveOverview(), NOW_MS, "live")) {
			expect(row.hitRate.text).toBe(OPENVIKING_NOT_MEASURED_TEXT);
			expect(row.avgTokens.text).toBe(OPENVIKING_NOT_MEASURED_TEXT);
			expect(row.hitRate.notMeasured).toBe(true);
			expect(row.presentation.healthState).not.toBe("healthy");
			expect(row.presentation.label).not.toMatch(/\bhit\b|healthy/i);
			expect(row.tooltipId.trim()).not.toBe("");
		}
	});

	it("passes the server's stale reason through verbatim and never invents an age", () => {
		expect(buildStatePresentation("stale", "> 15m").staleBadge).toBe("> 15m");
		expect(buildStatePresentation("stale", "pending sync").staleBadge).toBe("pending sync");
		expect(buildStatePresentation("stale", "pending sync").label).not.toMatch(/>\s*\d/);
		expect(buildStatePresentation("healthy", null).staleBadge).toBeNull();
	});

	it("gives each state its own glyph, icon and border, so colour is never the only cue", () => {
		const states = [
			buildStatePresentation("healthy", null),
			buildStatePresentation("stale", "> 30s"),
			buildStatePresentation("zero-activity", null),
			buildStatePresentation("server-unreachable", null),
		];
		expect(new Set(states.map((s) => s.glyph)).size).toBe(4);
		expect(new Set(states.map((s) => s.dataIcon)).size).toBe(4);
		expect(new Set(states.map((s) => s.border)).size).toBe(4);
		expect(states.every((s) => s.label.trim() !== "")).toBe(true);

		const loading = buildStatePresentation("loading", null);
		expect(loading.glyph).toBeNull();
		expect(loading.dataIcon).toBeNull();
	});
});
