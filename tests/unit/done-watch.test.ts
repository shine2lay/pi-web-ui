import { describe, expect, it } from "vitest";
import { cueConversations, withoutAskingChats } from "../../web/src/done-watch.js";
import { diffStreamingCues } from "../../web/src/streaming-cues.js";

type Row = { id: string; title?: string; isStreaming?: boolean; isSubagent?: boolean; live?: boolean };

/** One run of App.tsx's cue effect: upstream's diff over the rows that may sound. */
function step(prev: Map<string, boolean> | null, activeId: string, activeStreaming: boolean, rows: Row[]) {
	return diffStreamingCues(prev, activeId, activeStreaming, cueConversations(rows), activeId);
}

/** queue-main-chat: a task chat that stopped to ask its main chat makes no "done" cue. */
describe("withoutAskingChats", () => {
	it("drops the chats whose task asks its main chat, as the list says when the cue goes off", () => {
		const cues = [{ id: "a" }, { id: "task" }, { id: "b" }];
		const list = [{ id: "a" }, { id: "task", queueAsking: true }, { id: "b", queueAsking: false }];
		expect(withoutAskingChats(cues, list).map((c) => c.id)).toEqual(["a", "b"]);
		expect(withoutAskingChats(cues, undefined)).toEqual(cues);
		expect(withoutAskingChats([{ id: "task" }], list)).toEqual([]);
	});
});

describe("cueConversations (done-any-chat)", () => {
	it("keeps ordinary chats and drops subagents and history rows", () => {
		const rows: Row[] = [
			{ id: "a" },
			{ id: "sa-1", isSubagent: true },
			{ id: "old", live: false },
			{ id: "b", live: true, isSubagent: false },
		];
		expect(cueConversations(rows).map((r) => r.id)).toEqual(["a", "b"]);
	});

	it("a background chat that finishes sounds; a subagent that finishes does not", () => {
		const first = step(null, "open", false, [
			{ id: "open", isStreaming: false },
			{ id: "bg", title: "Background", isStreaming: true },
			{ id: "sa-1", isSubagent: true, isStreaming: true },
		]);
		const second = step(first.nextMap, "open", false, [
			{ id: "open", isStreaming: false },
			{ id: "bg", title: "Background", isStreaming: false },
			{ id: "sa-1", isSubagent: true, isStreaming: false },
		]);
		expect(second.finishedConvs.map((c) => c.id)).toEqual(["bg"]);
	});

	it("an open subagent still gets its own done cue", () => {
		const first = step(null, "sa-1", true, [{ id: "sa-1", isSubagent: true, isStreaming: true }]);
		const second = step(first.nextMap, "sa-1", false, [{ id: "sa-1", isSubagent: true, isStreaming: false }]);
		expect(second.finishedConvs).toEqual([expect.objectContaining({ id: "sa-1", isActive: true })]);
	});

	it("after a reconnect (App.tsx resets the map to null) runs the restart ended don't sound", () => {
		const before = step(null, "open", false, [{ id: "open" }, { id: "bg", isStreaming: true }]);
		expect(before.nextMap.get("bg")).toBe(true);
		const after = step(null, "open", false, [{ id: "open" }, { id: "bg", isStreaming: false }]);
		expect(after.finishedConvs).toEqual([]);
	});
});
