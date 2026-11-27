import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueueLaneWatchdog } from "../../server/queue-lane-watchdog.js";

// Timer delivery and the deadline clock are deliberately independent: a callback
// is a wake-up, not proof that the no-progress deadline has passed.
let now: number;
beforeEach(() => {
	vi.useFakeTimers();
	now = 1000;
	vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});
function watch() {
	return new QueueLaneWatchdog({}).watch({
		role: "architecture",
		lane: "open",
		phase: "attaching_client",
		deadlineMs: 50,
	});
}

describe("queue deadline delivery controls", () => {
	it("does not expire on early delivery; expires at the unchanged deadline", async () => {
		const w = watch();
		const expired = vi.fn();
		void w.expired.then(expired);
		now += 49;
		await vi.advanceTimersByTimeAsync(50);
		expect(expired).not.toHaveBeenCalled();
		now += 1;
		await vi.advanceTimersByTimeAsync(1);
		expect(expired).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ elapsedMs: 50, deadlineMs: 50 }));
	});

	it.each([50, 500])("expires on valid delivery at elapsed %i without an extra delay", async (elapsed) => {
		const w = watch();
		const expired = vi.fn();
		void w.expired.then(expired);
		now += elapsed;
		await vi.advanceTimersByTimeAsync(50);
		expect(expired).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ elapsedMs: elapsed, deadlineMs: 50 }));
	});

	it("progress restarts the deadline and stop cancels a rearmed timer", async () => {
		const w = watch();
		const expired = vi.fn();
		void w.expired.then(expired);
		now += 40;
		await vi.advanceTimersByTimeAsync(40);
		w.progress("creating_runtime");
		now += 49;
		await vi.advanceTimersByTimeAsync(50);
		expect(expired).not.toHaveBeenCalled();
		w.stop();
		now += 100;
		await vi.advanceTimersByTimeAsync(100);
		expect(expired).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
