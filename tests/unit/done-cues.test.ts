import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DONE_SETTLE_MS, DoneCues, type DoneCue, finishedChats, runEdge, runningSeen } from "../../web/src/done-cues";
import type { ConversationSummary } from "../../web/src/types";

const row = (id: string, isStreaming: boolean, extra: Partial<ConversationSummary> = {}): ConversationSummary => ({
	id,
	title: `chat ${id}`,
	cwd: "/w",
	messageCount: 2,
	isStreaming,
	isSubagent: false,
	...extra,
});

describe("runEdge (the open chat's own start / end)", () => {
	it("cues when the same chat starts and stops", () => {
		expect(runEdge({ id: "a", streaming: false }, { id: "a", streaming: true })).toBe("start");
		expect(runEdge({ id: "a", streaming: true }, { id: "a", streaming: false })).toBe("done");
	});

	it("stays quiet when nothing changed", () => {
		expect(runEdge({ id: "a", streaming: true }, { id: "a", streaming: true })).toBeNull();
		expect(runEdge({ id: "a", streaming: false }, { id: "a", streaming: false })).toBeNull();
	});

	it("does not cue on the first observation", () => {
		expect(runEdge(null, { id: "a", streaming: true })).toBeNull();
		expect(runEdge(null, { id: "a", streaming: false })).toBeNull();
	});

	it("switching from a running chat to an idle one is not a finished run", () => {
		expect(runEdge({ id: "a", streaming: true }, { id: "b", streaming: false })).toBeNull();
		expect(runEdge({ id: "a", streaming: false }, { id: "b", streaming: true })).toBeNull();
	});

	it("a gap with no snapshot (switching, reconnecting) is not an edge either", () => {
		expect(runEdge({ id: "a", streaming: true }, { id: "", streaming: false })).toBeNull();
		expect(runEdge({ id: "", streaming: false }, { id: "a", streaming: false })).toBeNull();
		expect(runEdge({ id: "", streaming: false }, { id: "", streaming: true })).toBeNull();
	});
});

describe("finishedChats (every other chat, from the list)", () => {
	it("a background chat that stops running has finished", () => {
		const prev = runningSeen([row("a", true), row("b", false)]);
		const list = [row("a", false), row("b", false)];
		expect(finishedChats(prev, list, "b").map((c) => c.id)).toEqual(["a"]);
	});

	it("the open chat is left to runEdge (no double cue)", () => {
		const prev = runningSeen([row("a", true)]);
		expect(finishedChats(prev, [row("a", false)], "a")).toEqual([]);
	});

	it("nothing is known before the first list (load, reconnect)", () => {
		expect(finishedChats(null, [row("a", false)], "b")).toEqual([]);
	});

	it("a chat the last list didn't have is not guessed at", () => {
		const prev = runningSeen([row("b", false)]);
		expect(finishedChats(prev, [row("a", false), row("b", false)], "b")).toEqual([]);
	});

	it("still running, starting, or idle all along is not finished", () => {
		const prev = runningSeen([row("a", true), row("b", false), row("c", false)]);
		const list = [row("a", true), row("b", true), row("c", false)];
		expect(finishedChats(prev, list, "x")).toEqual([]);
	});

	it("a chat that left the list is not finished", () => {
		const prev = runningSeen([row("a", true), row("b", false)]);
		expect(finishedChats(prev, [row("b", false)], "b")).toEqual([]);
	});

	it("subagents don't cue: their parent is still running and cues when it ends", () => {
		const sub = (s: boolean) => row("s", s, { isSubagent: true, parentId: "a" });
		const prev = runningSeen([row("a", true), sub(true)]);
		expect(finishedChats(prev, [row("a", true), sub(false)], "x")).toEqual([]);
		expect(runningSeen([sub(true)]).has("s")).toBe(false);
	});

	it("history rows are ignored", () => {
		const hist = (s: boolean) => row("h", s, { live: false });
		expect(runningSeen([hist(true)]).has("h")).toBe(false);
		expect(finishedChats(new Map([["h", true]]), [hist(false)], "x")).toEqual([]);
	});

	it("several chats finishing in one list are all reported", () => {
		const prev = runningSeen([row("a", true), row("b", true), row("c", false)]);
		const list = [row("a", false), row("b", false), row("c", false)];
		expect(finishedChats(prev, list, "c").map((c) => c.id)).toEqual(["a", "b"]);
	});
});

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
