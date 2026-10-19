/**
 * reconnect-trace (Ops #157): the page's record of each "Reconnecting…" episode (web/src/conn-trace.ts).
 * Fake clock, fake store: each cause gives the right record, a reload keeps what waits (an episode cut
 * short says so), and a record carries metadata only.
 */
import { describe, expect, it } from "vitest";
import {
	BannerTrace,
	MAX_KEPT,
	PAGE_STALL_WINDOW_MS,
	type TraceContext,
	type TraceStore,
} from "../../web/src/conn-trace";
import { sanitizeRecord } from "../../server/conn-events";

const T0 = 1_760_000_000_000;

function ids() {
	let n = 0;
	return () => `ep${(++n).toString(16).padStart(8, "0")}`;
}

function ctx(now: number, over: Partial<TraceContext> = {}): TraceContext {
	return {
		now,
		visible: true,
		online: true,
		openedAt: T0 - 60_000,
		lastHeardAt: now - 5_200,
		patience: 1,
		conn: "a1b2c3d4e5f6",
		...over,
	};
}

function memStore(): TraceStore & { value: string | null } {
	const s = {
		value: null as string | null,
		load: () => s.value,
		save: (v: string | null) => {
			s.value = v;
		},
	};
	return s;
}

describe("conn-trace: one record per episode, with its cause", () => {
	it("a socket that closed by itself: reason close with its code", () => {
		const t = new BannerTrace(ids());
		t.noteCause({ reason: "close", closeCode: 1006 });
		t.bannerChanged(true, ctx(T0));
		t.socketOpened(T0 + 1_200);
		t.bannerChanged(false, ctx(T0 + 2_000));
		const [r] = t.take(T0 + 2_500);
		expect(r).toMatchObject({
			reason: "close",
			closeCode: 1006,
			durMs: 2_000,
			endAgoMs: 500,
			sockAgeMs: 60_000,
			sinceFrameMs: 5_200,
			visible: true,
			online: true,
			endVisible: true,
			patience: 1,
			sockets: 1,
			drops: 0,
			catchUpMs: 800,
			conn: "a1b2c3d4e5f6",
		});
		expect(t.waiting).toBe(0);
	});

	it("pages-live: records the view at the end and how long the tab had been visible then (not when it ended hidden)", () => {
		const t = new BannerTrace(ids());
		// came up while hidden on Roles; the tab came back at T0 + 60 s; fresh data 1.8 s later
		t.noteCause({ reason: "close", closeCode: 1006 });
		t.bannerChanged(true, ctx(T0, { visible: false, view: "roles", visibleAt: null }));
		t.bannerChanged(false, ctx(T0 + 61_800, { view: "roles", visibleAt: T0 + 60_000 }));
		// a chat-view episode that ended while hidden: a view, no shownMs
		t.noteCause({ reason: "close", closeCode: 1006 });
		t.bannerChanged(true, ctx(T0 + 70_000, { view: "chat", visibleAt: T0 + 60_000 }));
		t.bannerChanged(false, ctx(T0 + 75_000, { visible: false, view: "chat", visibleAt: null }));
		// an old caller without the new fields: neither
		t.noteCause({ reason: "doubt" });
		t.bannerChanged(true, ctx(T0 + 80_000));
		t.bannerChanged(false, ctx(T0 + 81_000));
		const [a, b, c] = t.take(T0 + 90_000);
		expect(a).toMatchObject({ durMs: 61_800, visible: false, endVisible: true, view: "roles", shownMs: 1_800 });
		expect(b).toMatchObject({ view: "chat", endVisible: false });
		expect(b).not.toHaveProperty("shownMs");
		expect(c).not.toHaveProperty("view");
		expect(c).not.toHaveProperty("shownMs");
		// what the server keeps
		for (const r of [a, b, c]) expect(sanitizeRecord(r)).toEqual(r);
	});

	it("silence (unexplained and explained), probe, connect_timeout and doubt keep their reason and numbers", () => {
		const cases = [
			{ cause: { reason: "silence", quietMs: 5_100, allowedMs: 5_000 } },
			{ cause: { reason: "silence_explained", quietMs: 9_000, allowedMs: 5_000 } },
			{ cause: { reason: "probe", quietMs: 31_000 } },
			{ cause: { reason: "connect_timeout" } },
			{ cause: { reason: "doubt" } },
		] as const;
		for (const { cause } of cases) {
			const t = new BannerTrace(ids());
			t.noteCause({ ...cause });
			t.bannerChanged(true, ctx(T0));
			t.bannerChanged(false, ctx(T0 + 1_500));
			const [r] = t.take(T0 + 1_500);
			expect(r.reason).toBe(cause.reason);
			expect(r.quietMs).toBe("quietMs" in cause ? cause.quietMs : undefined);
			expect(r.allowedMs).toBe("allowedMs" in cause ? cause.allowedMs : undefined);
			expect(r.closeCode).toBeUndefined();
			expect(r.durMs).toBe(1_500);
		}
	});

	it("no cause noted: unknown; later drops while it shows are counted, the last one kept", () => {
		const t = new BannerTrace(ids());
		t.bannerChanged(true, ctx(T0));
		t.noteCause({ reason: "connect_timeout" });
		t.noteCause({ reason: "close", closeCode: 1006 });
		t.socketOpened(T0 + 12_000);
		t.socketOpened(T0 + 14_000);
		t.bannerChanged(false, ctx(T0 + 15_000));
		const [r] = t.take(T0 + 15_000);
		expect(r).toMatchObject({ reason: "unknown", drops: 2, then: "close", sockets: 2, catchUpMs: 1_000 });
	});

	it("a cause from a first connection that never showed the note is forgotten once a socket opens", () => {
		const t = new BannerTrace(ids());
		t.noteCause({ reason: "close", closeCode: 1006 });
		t.socketOpened(T0);
		t.bannerChanged(true, ctx(T0 + 1_000));
		t.bannerChanged(false, ctx(T0 + 2_000));
		expect(t.take(T0 + 2_000)[0].reason).toBe("unknown");
	});

	it("only a change of the note counts: refreshing it while it shows or while it's off does nothing", () => {
		const t = new BannerTrace(ids());
		t.bannerChanged(false, ctx(T0));
		t.noteCause({ reason: "silence", quietMs: 5_001, allowedMs: 5_000 });
		t.bannerChanged(true, ctx(T0 + 100));
		t.bannerChanged(true, ctx(T0 + 600));
		expect(t.showing).toBe(true);
		t.bannerChanged(false, ctx(T0 + 900));
		t.bannerChanged(false, ctx(T0 + 1_900));
		const out = t.take(T0 + 2_000);
		expect(out).toHaveLength(1);
		expect(out[0].durMs).toBe(800);
	});

	it("hidden or offline when it came up, and visible when it went, are kept as they were", () => {
		const t = new BannerTrace(ids());
		t.noteCause({ reason: "silence_explained", quietMs: 40_000, allowedMs: 5_000 });
		t.bannerChanged(true, ctx(T0, { visible: false, online: false, patience: 4 }));
		t.bannerChanged(false, ctx(T0 + 3_000, { visible: true }));
		expect(t.take(T0 + 3_000)[0]).toMatchObject({ visible: false, online: false, endVisible: true, patience: 4 });
	});

	it("the page's own timers held up shortly before (or while it shows) are recorded; long before, not", () => {
		const t = new BannerTrace(ids());
		t.notePageStall(3_100, T0 - PAGE_STALL_WINDOW_MS - 1);
		t.bannerChanged(true, ctx(T0));
		t.bannerChanged(false, ctx(T0 + 1_000));
		expect(t.take(T0 + 1_000)[0].pageStallMs).toBeUndefined();

		t.notePageStall(2_600, T0 + 5_000);
		t.bannerChanged(true, ctx(T0 + 6_000));
		t.notePageStall(8_000, T0 + 9_000);
		t.bannerChanged(false, ctx(T0 + 10_000));
		expect(t.take(T0 + 10_000)[0].pageStallMs).toBe(8_000);
	});

	it(`keeps at most ${MAX_KEPT} waiting episodes (oldest dropped); discard forgets them`, () => {
		const t = new BannerTrace(ids());
		for (let i = 0; i < MAX_KEPT + 3; i++) {
			t.bannerChanged(true, ctx(T0 + i * 10_000));
			t.bannerChanged(false, ctx(T0 + i * 10_000 + 1_000));
		}
		expect(t.waiting).toBe(MAX_KEPT);
		expect(t.dropped).toBe(3);
		t.discard(T0);
		expect(t.waiting).toBe(0);
	});
});

describe("conn-trace: a reload keeps what waits", () => {
	it("finished episodes survive a reload and go out from the new page", () => {
		const store = memStore();
		const a = new BannerTrace(ids(), store);
		a.noteCause({ reason: "close", closeCode: 1012 });
		a.bannerChanged(true, ctx(T0));
		a.bannerChanged(false, ctx(T0 + 4_000));
		const b = new BannerTrace(ids(), store);
		expect(b.waiting).toBe(1);
		const [r] = b.take(T0 + 10_000);
		expect(r).toMatchObject({ reason: "close", closeCode: 1012, durMs: 4_000, endAgoMs: 6_000 });
		expect(r.cut).toBeUndefined();
		expect(store.value).toBeNull();
	});

	it("an episode still showing when the tab reloads ends as cut, at the last moment it was saved", () => {
		const store = memStore();
		const a = new BannerTrace(ids(), store);
		a.noteCause({ reason: "silence", quietMs: 5_400, allowedMs: 5_000 });
		a.bannerChanged(true, ctx(T0));
		a.touch(T0 + 1_000); // too soon after the last save: not saved
		a.touch(T0 + 2_500);
		a.touch(T0 + 7_000);
		// reload here
		const b = new BannerTrace(ids(), store);
		expect(b.showing).toBe(false);
		const [r] = b.take(T0 + 9_000);
		expect(r).toMatchObject({ reason: "silence", cut: true, durMs: 7_000, endVisible: false, endAgoMs: 2_000 });
	});

	it("a broken or foreign saved copy is ignored", () => {
		for (const bad of ["{", "[]", '{"v":2,"at":1}', '{"v":1,"at":"x"}', '{"v":1,"at":5,"done":[{"rec":{"ep":1}}]}']) {
			const store = memStore();
			store.value = bad;
			const t = new BannerTrace(ids(), store);
			expect(t.waiting).toBe(0);
		}
	});
});

describe("conn-trace: metadata only", () => {
	it("every record is accepted as-is by the server's strict check, and holds no free text", () => {
		const t = new BannerTrace(ids(), memStore());
		t.notePageStall(2_400, T0 - 1_000);
		t.noteCause({ reason: "probe", quietMs: 12_000 });
		t.bannerChanged(true, ctx(T0));
		t.noteCause({ reason: "close", closeCode: 1006 });
		t.socketOpened(T0 + 3_000);
		t.bannerChanged(false, ctx(T0 + 4_000));
		const [r] = t.take(T0 + 4_000);
		expect(sanitizeRecord(r)).toEqual(r);
		const strings = Object.entries(r).filter(([, v]) => typeof v === "string");
		expect(strings.map(([k]) => k).sort()).toEqual(["conn", "ep", "reason", "then"]);
		for (const [, v] of strings) expect(v).toMatch(/^[a-z0-9_]+$/);
	});
});
