/**
 * The page's half of a chat-open row (web/src/chat-open-timing.ts, Ops #690): device class, test-browser
 * flag, where an open starts, and the marks a ChatOpenTimer reports, driven by a fake clock and fake
 * paint frames. The report carries no title, path or message.
 */
import { describe, expect, it } from "vitest";
import { automatedBrowser, ChatOpenTimer, deviceClass, openStartOf } from "../../web/src/chat-open-timing";
import type { ChatOpenReport } from "../../web/src/types";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36";
const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141 Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141 Safari/537.36";
const touch = (q: string) => q === "(pointer: coarse)" || q === "(hover: none)";
const mouse = () => false;
const PATH = "/home/someone/.pi/agent/sessions/--x--/2026-10-31_Secret-Title.jsonl";
const TARGET = { kind: "session", path: PATH } as const;

describe("device class", () => {
	it("phones and tablets are phone; mouse screens and touch laptops are desktop", () => {
		expect(deviceClass({ query: touch, userAgent: IPHONE })).toBe("phone");
		expect(deviceClass({ query: touch, userAgent: ANDROID })).toBe("phone");
		expect(deviceClass({ query: touch, userAgent: IPAD, maxTouchPoints: 5 })).toBe("phone");
		expect(deviceClass({ query: mouse, userAgent: LINUX })).toBe("desktop");
		expect(deviceClass({ query: touch, userAgent: WINDOWS })).toBe("desktop");
		expect(deviceClass({})).toBe("desktop");
	});

	it("flags test browsers", () => {
		expect(automatedBrowser({ webdriver: true, userAgent: LINUX })).toBe(true);
		expect(automatedBrowser({ userAgent: "Mozilla/5.0 HeadlessChrome/141.0" })).toBe(true);
		expect(automatedBrowser({ webdriver: false, userAgent: IPHONE })).toBe(false);
	});
});

describe("open start", () => {
	it("starts at the input event's time when an input caused it, else now", () => {
		expect(openStartOf({ type: "click", timeStamp: 900 }, 1000)).toEqual({ start: 900, via: "click" });
		expect(openStartOf({ type: "keydown", timeStamp: 990 }, 1000)).toEqual({ start: 990, via: "key" });
		expect(openStartOf({ type: "popstate", timeStamp: 995 }, 1000)).toEqual({ start: 995, via: "nav" });
		expect(openStartOf({ type: "message", timeStamp: 900 }, 1000)).toEqual({ start: 1000, via: "auto" });
		expect(openStartOf({ type: "click", timeStamp: 900 }, 20_000)).toEqual({ start: 20_000, via: "auto" });
		expect(openStartOf(null, 1000)).toEqual({ start: 1000, via: "auto" });
	});
});

function harness(over: { event?: { type: string; timeStamp: number } | null; device?: "phone" | "desktop" } = {}) {
	const clock = { now: 1000 };
	const frames: (() => void)[] = [];
	const state = { visible: true };
	const reports: ChatOpenReport[] = [];
	const timer = new ChatOpenTimer({
		now: () => clock.now,
		afterPaint: (fn) => frames.push(fn),
		visible: () => state.visible,
		device: () => over.device ?? "desktop",
		automated: () => false,
		currentEvent: () => (over.event === undefined ? { type: "click", timeStamp: 990 } : over.event),
		newId: () => "a1b2c3d4e5f60718",
	});
	timer.setReporter((r) => reports.push(r));
	const paint = (at: number) => {
		clock.now = at;
		const due = frames.splice(0);
		for (const f of due) f();
	};
	return { clock, timer, reports, paint, state };
}

const snapshotState = { sessionFile: PATH, conversationId: "c7" };

describe("ChatOpenTimer", () => {
	it("a not-loaded open: request, preview, paint of the server's copy, done", () => {
		const h = harness();
		expect(h.timer.begin(TARGET, false)).toBe("a1b2c3d4e5f60718");
		h.clock.now = 1002;
		h.timer.requested();
		h.clock.now = 1400;
		h.timer.preview(TARGET);
		h.timer.listCommitted();
		h.paint(1450);
		h.clock.now = 3000;
		h.timer.snapshot(snapshotState);
		h.timer.listCommitted();
		h.timer.done(TARGET, true);
		expect(h.reports).toEqual([]);
		h.paint(3020);
		expect(h.reports).toEqual([
			{
				type: "chat_open",
				open: "a1b2c3d4e5f60718",
				outcome: "done",
				via: "click",
				device: "desktop",
				visible: true,
				cached: false,
				automated: false,
				startToRequestMs: 12,
				toFirstFrameMs: 410,
				toPaintMs: 460,
				toDoneMs: 2010,
			},
		]);
		expect(JSON.stringify(h.reports)).not.toContain("Secret");
	});

	it("a cached copy painted first is toCachePaintMs, not toPaintMs", () => {
		const h = harness({ event: null, device: "phone" });
		h.timer.begin(TARGET, true);
		h.timer.requested();
		h.timer.listCommitted();
		h.paint(1016);
		h.clock.now = 1200;
		h.timer.snapshot(snapshotState);
		h.timer.done(TARGET, true);
		h.timer.listCommitted();
		h.paint(1230);
		expect(h.reports[0]).toMatchObject({
			outcome: "done",
			via: "auto",
			device: "phone",
			cached: true,
			toCachePaintMs: 16,
			toFirstFrameMs: 200,
			toPaintMs: 230,
			toDoneMs: 200,
		});
	});

	it("done with nothing new to commit counts the next painted frame", () => {
		const h = harness();
		h.timer.begin(TARGET, false);
		h.clock.now = 1100;
		h.timer.done(TARGET, true);
		h.paint(1116);
		expect(h.reports[0]).toMatchObject({ outcome: "done", toPaintMs: 126, toDoneMs: 110 });
	});

	it("snapshots of another chat and frames for another target don't count", () => {
		const h = harness();
		h.timer.begin(TARGET, false);
		h.timer.snapshot({ sessionFile: "/other.jsonl", conversationId: "c1" });
		h.timer.preview({ kind: "conversation", id: "c1" });
		h.timer.done({ kind: "conversation", id: "c1" }, true);
		h.timer.listCommitted();
		h.paint(1500);
		expect(h.reports).toEqual([]);
	});

	it("failed, replaced, hidden and dropped opens", () => {
		const h = harness();
		h.timer.begin(TARGET, false);
		h.clock.now = 1300;
		h.timer.done(TARGET, false);
		expect(h.reports.at(-1)).toMatchObject({ outcome: "failed", toDoneMs: 310 });
		h.timer.begin(TARGET, false);
		h.timer.begin({ kind: "conversation", id: "c2" }, false);
		expect(h.reports.at(-1)).toMatchObject({ outcome: "left" });
		h.state.visible = false;
		h.timer.hidden();
		expect(h.reports.at(-1)).toMatchObject({ outcome: "hidden", visible: false });
		h.state.visible = true;
		h.timer.begin(TARGET, false);
		h.timer.reset();
		h.timer.done(TARGET, true);
		h.paint(2000);
		expect(h.reports).toHaveLength(3);
	});
});
