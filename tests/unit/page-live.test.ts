// @vitest-environment jsdom
// pages-live (Ops #244): the shared pieces (page-live.ts) and the Roles store's wait (roles-state.ts).
// The Roles page's Updating pill: roles-exact.test.ts; the server's quick confirmation: roles-overview.test.ts;
// the trace fields: conn-trace.test.ts and conn-events.test.ts; the real return: tests/pages-live-test.mjs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import {
	graceLeft,
	graceView,
	LIVE_GRACE_MS,
	liveVisibleAt,
	pageView,
	pageVisibilityChanged,
	resetPageLive,
	setPageView,
	setViewFresh,
	subscribePageLive,
	viewFresh,
} from "../../web/src/page-live.js";
import {
	receiveRoles,
	resendRolesWatch,
	resetRolesState,
	rolesConnectionLost,
	rolesSnapshot,
	watchRoles,
	type RolesPayload,
} from "../../web/src/roles-state.js";
import type { UiRolesOverview } from "../../web/src/types.js";

const T0 = Date.parse("2026-10-18T12:00:00Z");

describe("page-live: the grace and the shared store", () => {
	beforeEach(() => resetPageLive(T0 - 60_000));

	it("is 8 s of visible time, from the later of the wait's start and the tab coming back", () => {
		expect(LIVE_GRACE_MS).toBe(8_000);
		expect(graceLeft(T0, T0, T0 - 60_000)).toBe(8_000);
		expect(graceLeft(T0, T0 + 3_000, T0 - 60_000)).toBe(5_000);
		expect(graceLeft(T0, T0 + 8_000, T0 - 60_000)).toBe(0);
		expect(graceLeft(T0, T0 + 60_000, T0 - 60_000)).toBe(0);
		// came back after the wait began: counted from coming back
		expect(graceLeft(T0 - 600_000, T0 + 2_000, T0)).toBe(6_000);
		// hidden: nothing used up
		expect(graceLeft(T0 - 600_000, T0, null)).toBe(8_000);
		// a clock read before the start never gives more than the grace
		expect(graceLeft(T0, T0 - 5_000, T0 - 60_000)).toBe(8_000);
	});

	it("only Roles and Initiatives wait", () => {
		expect(graceView("roles")).toBe(true);
		expect(graceView("initiatives")).toBe(true);
		expect(graceView("chat")).toBe(false);
		expect(graceView("other")).toBe(false);
	});

	it("tells its listeners about each change of view, visibility or freshness, once", () => {
		const heard = vi.fn();
		const stop = subscribePageLive(heard);
		setPageView("roles");
		setPageView("roles");
		expect(pageView()).toBe("roles");
		expect(heard).toHaveBeenCalledTimes(1);
		pageVisibilityChanged(false, T0);
		pageVisibilityChanged(false, T0 + 1);
		expect(liveVisibleAt()).toBeNull();
		pageVisibilityChanged(true, T0 + 5_000);
		expect(liveVisibleAt()).toBe(T0 + 5_000);
		expect(heard).toHaveBeenCalledTimes(3);
		expect(viewFresh("roles")).toBeNull();
		setViewFresh("roles", false);
		setViewFresh("roles", false);
		setViewFresh("roles", true);
		expect(viewFresh("roles")).toBe(true);
		setViewFresh("roles", null);
		expect(viewFresh("roles")).toBeNull();
		expect(heard).toHaveBeenCalledTimes(6);
		stop();
		setPageView("chat");
		expect(heard).toHaveBeenCalledTimes(6);
	});
});

const overview = (at: number): UiRolesOverview =>
	({ at, roles: [], asks: [], work: { initiatives: [], projects: [] } }) as unknown as UiRolesOverview;

describe("roles-state: the page's wait for the server to look again", () => {
	let now = T0;
	beforeEach(() => {
		now = T0;
		vi.useFakeTimers();
		vi.setSystemTime(now);
		resetPageLive(T0 - 60_000);
		resetRolesState();
		resetAppGlobals();
		setAppSend(() => true);
	});
	afterEach(() => {
		resetRolesState();
		resetAppGlobals();
		vi.useRealTimers();
	});
	const at = (ms: number) => {
		now = T0 + ms;
		vi.setSystemTime(now);
	};
	const receive = (p: RolesPayload) => receiveRoles(p);

	it("starts with a full watch, ends with a newer look, and Roles' freshness follows", () => {
		const stop = watchRoles(true);
		expect(rolesSnapshot().waitingSince).toBe(T0);
		expect(viewFresh("roles")).toBe(false);
		// the replay of the last look: data, but not yet current
		at(300);
		receive({ type: "roles", overview: overview(T0 - 7_000), asks: 0, checkedAt: T0 - 7_000 });
		expect(rolesSnapshot()).toMatchObject({ status: "ready", waitingSince: T0 });
		expect(rolesSnapshot().appliedAt).toBeUndefined();
		// the next look found nothing new and says so at once (server pages-live)
		at(1_200);
		receive({ type: "roles", asks: 0, checkedAt: T0 + 1_100 });
		expect(rolesSnapshot().appliedAt).toBe(T0 + 1_200);
		expect(rolesSnapshot().waitingSince).toBeUndefined();
		expect(viewFresh("roles")).toBe(true);
		stop();
		expect(rolesSnapshot().waitingSince).toBeUndefined();
	});

	it("a lost connection starts the wait at once and keeps its start through the reconnect's new watch", () => {
		const stop = watchRoles(true);
		receive({ type: "roles", overview: overview(T0), asks: 0, checkedAt: T0 });
		at(500);
		receive({ type: "roles", overview: overview(T0 + 400), asks: 0, checkedAt: T0 + 400 });
		expect(viewFresh("roles")).toBe(true);
		at(60_000);
		rolesConnectionLost();
		expect(rolesSnapshot().waitingSince).toBe(T0 + 60_000);
		expect(rolesSnapshot().appliedAt).toBeUndefined();
		expect(viewFresh("roles")).toBe(false);
		at(62_000);
		rolesConnectionLost();
		act(() => resendRolesWatch());
		expect(rolesSnapshot().waitingSince).toBe(T0 + 60_000);
		at(62_400);
		receive({ type: "roles", overview: overview(T0 + 61_000), asks: 0, checkedAt: T0 + 61_000 });
		expect(rolesSnapshot().waitingSince).toBe(T0 + 60_000);
		at(63_000);
		receive({ type: "roles", overview: overview(T0 + 62_900), asks: 1, checkedAt: T0 + 62_900 });
		expect(rolesSnapshot().waitingSince).toBeUndefined();
		expect(rolesSnapshot().appliedAt).toBe(T0 + 63_000);
		stop();
	});

	it("a failed look waits too; the top bar's count-only watch never starts a wait", () => {
		const badge = watchRoles(false);
		rolesConnectionLost();
		receive({ type: "roles", asks: 0, error: "boom" });
		expect(rolesSnapshot().waitingSince).toBeUndefined();
		const stop = watchRoles(true);
		receive({ type: "roles", overview: overview(T0), asks: 0, checkedAt: T0 });
		at(400);
		receive({ type: "roles", overview: overview(T0 + 300), asks: 0, checkedAt: T0 + 300 });
		expect(rolesSnapshot().waitingSince).toBeUndefined();
		at(9_000);
		receive({ type: "roles", asks: 0, error: "boom" });
		expect(rolesSnapshot().waitingSince).toBe(T0 + 9_000);
		expect(viewFresh("roles")).toBe(false);
		stop();
		// leaving the page forgets the wait: coming back later starts a new one
		expect(rolesSnapshot().waitingSince).toBeUndefined();
		at(600_000);
		const again = watchRoles(true);
		expect(rolesSnapshot().waitingSince).toBe(T0 + 600_000);
		again();
		badge();
	});
});

function act(fn: () => void): void {
	fn();
}
