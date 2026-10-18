/**
 * acp-fold (server/acp-fold.ts): billion-context-pi's folds as the window reads them. A fold takes old
 * messages out of pi's working list; "Show older messages" must show exactly what the list held before,
 * so the folded messages followed by the live ones (after the fold's card) are the chat as if it had
 * never been folded.
 */

import { buildSessionProjection, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { foldedMessagesOf, isAcpFoldEntry, isAcpFoldResult } from "../../server/acp-fold.js";

let clock = 1_760_000_000_000;

/** Both chats get the same messages; only `folded` gets the folds. Returns the user message ids of each. */
function turn(chats: SessionManager[], text: string): string[] {
	const ids = chats.map((sm) =>
		sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: clock }),
	);
	clock += 1;
	for (const sm of chats) {
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `re ${text}` }],
			timestamp: clock,
			stopReason: "stop",
		} as never);
	}
	clock += 1;
	return ids;
}

function texts(messages: readonly unknown[]): string[] {
	return messages.map((m) => {
		const x = m as { role: string; content?: unknown; summary?: unknown };
		if (typeof x.summary === "string") return `${x.role}:${x.summary}`;
		const first = Array.isArray(x.content) ? (x.content[0] as { text?: unknown } | undefined) : undefined;
		return `${x.role}:${typeof first?.text === "string" ? first.text : ""}`;
	});
}

function fold(sm: SessionManager, firstKept: string, n: number): string {
	return sm.appendCompaction(
		`[ACP fold 2026-10-18T12:0${n}:00.000Z] fold ${n}`,
		firstKept,
		1000,
		{ acp: { v: 1 } },
		true,
	);
}

describe("foldedMessagesOf", () => {
	it("is null for a chat without a fold, pi's own compactions included", () => {
		const sm = SessionManager.inMemory("/tmp");
		const ids = [];
		for (let i = 0; i < 4; i++) ids.push(turn([sm], `q${i}`)[0]);
		sm.appendCompaction("summary by the model", ids[2], 500);
		turn([sm], "q4");
		expect(foldedMessagesOf(sm.getBranch())).toBeNull();
	});

	it("gives what pi's list held before the fold, and with the live list the whole chat", () => {
		const sm = SessionManager.inMemory("/tmp");
		const plain = SessionManager.inMemory("/tmp");
		const ids: string[] = [];
		for (let i = 0; i < 10; i++) ids.push(turn([sm, plain], `q${i}`)[0]);
		const before = sm.buildSessionContext().messages;
		const foldId = fold(sm, ids[6], 1);
		turn([sm, plain], "q10");

		const got = foldedMessagesOf(sm.getBranch());
		expect(got?.foldId).toBe(foldId);
		// Everything before turn 6, exactly as pi's list held it before the fold.
		expect(got?.messages).toEqual(before.slice(0, 12));
		const live = sm.buildSessionContext().messages;
		expect(texts(live.slice(0, 1))).toEqual(["compactionSummary:[ACP fold 2026-10-18T12:01:00.000Z] fold 1"]);
		expect(texts([...(got?.messages ?? []), ...live.slice(1)])).toEqual(texts(plain.buildSessionContext().messages));
	});

	it("reads past several folds and keeps a real compaction's summary at the start", () => {
		const sm = SessionManager.inMemory("/tmp");
		const plain = SessionManager.inMemory("/tmp");
		const ids: string[][] = [];
		for (let i = 0; i < 6; i++) ids.push(turn([sm, plain], `q${i}`));
		// pi's own compaction (made by the model) stays what it is.
		for (const [k, m] of [sm, plain].entries()) m.appendCompaction("summary by the model", ids[3][k], 500);
		for (let i = 6; i < 12; i++) ids.push(turn([sm, plain], `q${i}`));
		const firstFold = fold(sm, ids[8][0], 1);
		for (let i = 12; i < 16; i++) ids.push(turn([sm, plain], `q${i}`));
		const secondFold = fold(sm, ids[13][0], 2);
		turn([sm, plain], "q16");

		const branch = sm.getBranch();
		expect(branch.filter(isAcpFoldEntry).map((e) => e.id)).toEqual([firstFold, secondFold]);
		const got = foldedMessagesOf(branch);
		expect(got?.foldId).toBe(secondFold);
		const all = texts(plain.buildSessionContext().messages);
		expect(all[0]).toBe("compactionSummary:summary by the model");
		// The window before the second fold's card: the model's summary, then turns 3 to 12.
		expect(texts(got?.messages ?? [])).toEqual(all.slice(0, all.indexOf("user:q13")));
		const live = sm.buildSessionContext().messages;
		expect(texts([...(got?.messages ?? []), ...live.slice(1)])).toEqual(all);
	});

	it("is empty when the fold's first kept entry isn't on the branch any more", () => {
		const sm = SessionManager.inMemory("/tmp");
		for (let i = 0; i < 3; i++) turn([sm], `q${i}`);
		const id = fold(sm, "gone", 1);
		expect(foldedMessagesOf(sm.getBranch())).toEqual({ foldId: id, messages: [] });
	});

	it("matches pi's own reading of the unfolded branch", () => {
		const sm = SessionManager.inMemory("/tmp");
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) ids.push(turn([sm], `q${i}`)[0]);
		const projection = buildSessionProjection(sm.getBranch());
		fold(sm, ids[2], 1);
		expect(texts(foldedMessagesOf(sm.getBranch())?.messages ?? [])).toEqual(texts(projection.messages.slice(0, 4)));
	});
});

describe("isAcpFoldResult", () => {
	it("tells a fold from a compaction the model wrote", () => {
		expect(isAcpFoldResult({ summary: "x", details: { acp: { v: 1 } } })).toBe(true);
		expect(isAcpFoldResult({ summary: "x", details: { readFiles: [] } })).toBe(false);
		expect(isAcpFoldResult({ summary: "x" })).toBe(false);
		expect(isAcpFoldResult(undefined)).toBe(false);
	});
});
