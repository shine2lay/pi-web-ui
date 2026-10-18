// Local content-receipt timestamps, not transport freshness or server confirmation.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { receiveRoles, resetRolesState, useRoles, type RolesState } from "../../web/src/roles-state.js";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const overview = { at: NOW - 60_000, roles: [], asks: [], paused: false, reportTz: "UTC" };
function snapshot(): RolesState {
	let current: RolesState | undefined;
	function Read() {
		current = useRoles("off");
		return null;
	}
	renderToStaticMarkup(createElement(Read));
	if (!current) throw new Error("missing store snapshot");
	return current;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	resetRolesState();
});
afterEach(() => {
	resetRolesState();
	vi.useRealTimers();
});

describe("the displayed Roles overview's receipt", () => {
	it("does not create a content receipt from an error, count or heartbeat before any overview", () => {
		for (const extra of [{ error: "unavailable" }, { asks: 2 }, { asks: 0, checkedAt: NOW }]) {
			receiveRoles({ type: "roles", asks: 0, ...extra });
			expect(snapshot().overview).toBeNull();
			expect(snapshot().overviewReceivedAt).toBeUndefined();
			expect(snapshot().heardAt).toBe(NOW);
		}
	});

	it("preserves the content receipt while errors, counts and checked heartbeats advance transport time", () => {
		receiveRoles({ type: "roles", asks: 0, overview, checkedAt: NOW - 60_000 });
		expect(snapshot().overviewReceivedAt).toBe(NOW);
		for (const [i, extra] of [{ error: "unavailable" }, { asks: 2 }, { asks: 0, checkedAt: NOW }].entries()) {
			vi.setSystemTime(NOW + (i + 1) * 1000);
			receiveRoles({ type: "roles", asks: 0, ...extra });
			expect(snapshot().overview).toBe(overview);
			expect(snapshot().overviewReceivedAt).toBe(NOW);
			expect(snapshot().heardAt).toBe(NOW + (i + 1) * 1000);
		}
		expect(snapshot().checkedAt).toBe(NOW);
		expect(snapshot().appliedAt).toBe(NOW + 3000);
	});

	it("replaces the receipt only with another full overview and clears it on reset", () => {
		receiveRoles({ type: "roles", asks: 0, overview });
		vi.setSystemTime(NOW + 5000);
		const next = { ...overview, at: NOW };
		receiveRoles({ type: "roles", asks: 0, overview: next });
		expect(snapshot().overview).toBe(next);
		expect(snapshot().overviewReceivedAt).toBe(NOW + 5000);
		expect(snapshot().checkedAt).toBe(NOW);
		resetRolesState();
		expect(snapshot().overview).toBeNull();
		expect(snapshot().overviewReceivedAt).toBeUndefined();
	});
});
