/**
 * ask-delivery: the waiting cards as the windows see them.
 *
 * Snapshot rule (why questions once vanished): pendingQuestionForSnapshot used to filter by activeId, so a question came
 * back only when the user happened to open its chat. A card belongs to its chat, not a window: every window's snapshot
 * carries one, whichever chat it shows. nonblocking-ask (Ops #1087): the tool no longer waits, so no grace timer and no
 * cancel when the last window closes (NB-4 in nonblocking-ask-question.test.ts); a card kept for later never pops up
 * again and is offered only in its own chat's bar (NB-7).
 */
import { describe, expect, it } from "vitest";
import { pickPendingQuestionForSnapshot, savedQuestionsOf } from "../../server/ask-delivery.js";

describe("pickPendingQuestionForSnapshot", () => {
	const q = [{ id: "q1", question: "?" }];

	it("a card of another chat is in the snapshot too: the path that used to lose questions", () => {
		const entries = new Map([["q-7", { questions: q, conversationId: "conv-B" }]]);
		expect(pickPendingQuestionForSnapshot(entries)).toEqual({
			id: "q-7",
			questions: q,
			conversationId: "conv-B",
		});
	});

	it("no conversationId (an old entry): still carried, no empty fields", () => {
		const entries = new Map([["q-1", { questions: q }]]);
		const got = pickPendingQuestionForSnapshot(entries);
		expect(got).toEqual({ id: "q-1", questions: q });
		expect(got && "conversationId" in got).toBe(false);
		expect(got && "conversationTitle" in got).toBe(false);
	});

	it("carries the chat's title: another device may show another chat and must see who asks", () => {
		const entries = new Map([
			["q-9", { questions: q, conversationId: "conv-B", conversationTitle: "temper workflow" }],
		]);
		expect(pickPendingQuestionForSnapshot(entries)).toEqual({
			id: "q-9",
			questions: q,
			conversationId: "conv-B",
			conversationTitle: "temper workflow",
		});
	});

	it("no waiting card: null (the page collapses a panel the snapshot restored)", () => {
		expect(pickPendingQuestionForSnapshot(new Map())).toBeNull();
	});

	it("several: the first", () => {
		const entries = new Map([
			["q-1", { questions: q, conversationId: "conv-A" }],
			["q-2", { questions: q, conversationId: "conv-B" }],
		]);
		expect(pickPendingQuestionForSnapshot(entries)?.id).toBe("q-1");
	});

	// QA #244 F2 (Ops #1091): the shown chat's own live card comes before another chat's.
	it("several: the shown chat's own first, else the first of any chat", () => {
		const entries = new Map([
			["q-1", { questions: q, conversationId: "conv-A" }],
			["q-2", { questions: q, conversationId: "conv-B", later: true }],
			["q-3", { questions: q, conversationId: "conv-B" }],
		]);
		expect(pickPendingQuestionForSnapshot(entries, "conv-B")?.id).toBe("q-3");
		expect(pickPendingQuestionForSnapshot(entries, "conv-C")?.id).toBe("q-1");
		expect(pickPendingQuestionForSnapshot(entries, undefined)?.id).toBe("q-1");
	});

	it("skips cards kept for later: they never pop up again, over their own chat or another", () => {
		const entries = new Map([
			["q-1", { questions: q, conversationId: "conv-A", later: true }],
			["q-2", { questions: q, conversationId: "conv-B" }],
		]);
		expect(pickPendingQuestionForSnapshot(entries)?.id).toBe("q-2");
		expect(pickPendingQuestionForSnapshot(new Map([["q-1", entries.get("q-1")!]]))).toBeNull();
	});
});

describe("savedQuestionsOf", () => {
	const q = [{ id: "q1", question: "?" }];
	const entries = new Map([
		["q-1", { questions: q, conversationId: "conv-A", conversationTitle: "COO lead", later: true }],
		["q-2", { questions: q, conversationId: "conv-A" }],
		["q-3", { questions: q, conversationId: "conv-B", later: true }],
	]);

	it("only the shown chat's cards kept for later", () => {
		expect(savedQuestionsOf(entries, "conv-A")).toEqual([
			{ id: "q-1", questions: q, conversationId: "conv-A", conversationTitle: "COO lead" },
		]);
		expect(savedQuestionsOf(entries, "conv-B").map((s) => s.id)).toEqual(["q-3"]);
		expect(savedQuestionsOf(entries, "conv-C")).toEqual([]);
		expect(savedQuestionsOf(entries, undefined)).toEqual([]);
	});
});
