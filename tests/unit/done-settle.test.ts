import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DONE_SETTLE_MS, DoneCues, type DoneCue } from "../../web/src/done-settle";

describe("DoneCues (done waits a moment, so a running queue sounds like one run)", () => {
	let fired: DoneCue[][];
	let cues: DoneCues;
	beforeEach(() => {
		vi.useFakeTimers();
		fired = [];
		cues = new DoneCues((batch) => fired.push(batch));
	});
	afterEach(() => {
		cues.clear();
		vi.useRealTimers();
	});

	it("waits long enough to catch the next task, but not long", () => {
		expect(DONE_SETTLE_MS).toBeGreaterThanOrEqual(500);
		expect(DONE_SETTLE_MS).toBeLessThanOrEqual(3000);
	});

	it("a finished chat cues once, after the wait", () => {
		cues.finished({ id: "a", open: true });
		vi.advanceTimersByTime(DONE_SETTLE_MS - 1);
		expect(fired).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(fired).toEqual([[{ id: "a", open: true }]]);
		vi.advanceTimersByTime(DONE_SETTLE_MS * 3);
		expect(fired).toHaveLength(1);
	});

	it("starting again within the wait is as if it never stopped", () => {
		cues.finished({ id: "a", open: true });
		vi.advanceTimersByTime(DONE_SETTLE_MS / 2);
		expect(cues.started("a")).toBe(true);
		vi.advanceTimersByTime(DONE_SETTLE_MS * 3);
		expect(fired).toEqual([]);
		// Only that one stop is swallowed: the next start is a real start.
		expect(cues.started("a")).toBe(false);
	});

	it("a start with nothing waiting is a real start", () => {
		expect(cues.started("a")).toBe(false);
		cues.finished({ id: "a", open: true });
		expect(cues.started("b")).toBe(false);
		vi.advanceTimersByTime(DONE_SETTLE_MS);
		expect(fired).toEqual([[{ id: "a", open: true }]]);
	});

	it("chats finishing close together cue once, together", () => {
		cues.finished({ id: "a", open: true });
		vi.advanceTimersByTime(DONE_SETTLE_MS - 100);
		cues.finished({ id: "b", title: "chat b", open: false });
		vi.advanceTimersByTime(DONE_SETTLE_MS - 1);
		expect(fired).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(fired).toEqual([
			[
				{ id: "a", open: true },
				{ id: "b", title: "chat b", open: false },
			],
		]);
	});

	it("one of them starting again leaves the others to cue", () => {
		cues.finished({ id: "a", open: true });
		cues.finished({ id: "b", title: "chat b", open: false });
		expect(cues.started("a")).toBe(true);
		vi.advanceTimersByTime(DONE_SETTLE_MS);
		expect(fired).toEqual([[{ id: "b", title: "chat b", open: false }]]);
	});

	it("the same chat finishing twice is one cue (the latest)", () => {
		cues.finished({ id: "a", title: "old", open: false });
		cues.finished({ id: "a", title: "new", open: false });
		vi.advanceTimersByTime(DONE_SETTLE_MS);
		expect(fired).toEqual([[{ id: "a", title: "new", open: false }]]);
	});

	it("clear drops everything waiting (disconnect, unmount)", () => {
		cues.finished({ id: "a", open: true });
		cues.finished({ id: "b", open: false });
		cues.clear();
		vi.advanceTimersByTime(DONE_SETTLE_MS * 3);
		expect(fired).toEqual([]);
		expect(cues.started("a")).toBe(false);
	});
});
