import { describe, expect, it } from "vitest";
import { finishedChats, runEdge, runningSeen } from "../../web/src/done-cues";
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
