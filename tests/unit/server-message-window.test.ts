import { describe, expect, it } from "vitest";
import {
	DEFAULT_CONFIG,
	DEFAULT_HISTORY_CHARS,
	DEFAULT_HISTORY_PAGE,
	DEFAULT_HISTORY_WINDOW,
	type EarlierMessagesReply,
	type HistoryWindow,
	MAX_CACHED_CONVERSATIONS,
	MAX_HISTORY_PAGE,
	MessageWindowTap,
	type MessageWindowConfig,
	OFF_CONFIG,
	computeWindowStart,
	estimateMessageChars,
	historyWindowAt,
	pickWindowStart,
	readEarlierSlice,
	readMessageWindowConfig,
} from "../../server/message-window.js";

/**
 * server-message-window (Ops #565, W1-B): the per-socket history window ported from upstream 0.111.0.
 * A full snapshot keeps the newest 300 messages within 1.5 million characters, and the messages it
 * holds back come down in exact pages (by whole-chat index), so the client can rebuild the chat
 * message for message.
 */

type Msg = { type: string; [k: string]: unknown };
type TestMessage = { id: string; role: string; content: { type: string; text: string }[] };
type SnapState = {
	conversationId: string;
	messages: unknown[];
	messagesStart?: number;
	historyStart?: number;
	historyTotal?: number;
	historyWindow?: HistoryWindow;
};

function textMessage(i: number, chars = 20): TestMessage {
	return {
		id: `m${i}`,
		role: i % 2 ? "assistant" : "user",
		content: [{ type: "text", text: `#${i} `.padEnd(chars, "x") }],
	};
}

function messages(n: number, chars = 20, from = 0): TestMessage[] {
	return Array.from({ length: n }, (_, k) => textMessage(from + k, chars));
}

function snapshot(conversationId: string, msgs: unknown[], extra: Record<string, unknown> = {}): Msg {
	return { type: "snapshot", state: { conversationId, rev: 1, messages: msgs, ...extra } };
}

function delta(conversationId: string, appended: unknown[], state: Record<string, unknown> = {}): Msg {
	return {
		type: "snapshot_delta",
		conversationId,
		rev: 2,
		baseRev: 1,
		appended,
		state: { conversationId, rev: 2, ...state },
	};
}

function makeTap(cfg: MessageWindowConfig = DEFAULT_CONFIG): { tap: MessageWindowTap<Msg>; sent: Msg[] } {
	const sent: Msg[] = [];
	return { tap: new MessageWindowTap<Msg>((m) => sent.push(m), cfg), sent };
}

const stateOf = (m: Msg | undefined): SnapState => m?.state as SnapState;
const replyOf = (m: Msg | undefined): EarlierMessagesReply => m as unknown as EarlierMessagesReply;
const charsOf = (list: readonly unknown[]): number => list.reduce<number>((n, m) => n + estimateMessageChars(m), 0);

function expectSameItems(actual: readonly unknown[], expected: readonly unknown[]): void {
	expect(actual).toHaveLength(expected.length);
	actual.forEach((m, i) => expect(m).toBe(expected[i]));
}

describe("server message window: the first full snapshot", () => {
	it("trims a 1,000-message snapshot to the newest 300 within 1.5M chars, saying what is held back", () => {
		const full = messages(1000);
		const { tap, sent } = makeTap();
		const engine = snapshot("c1", full);
		tap.accept(engine);

		expect(sent).toHaveLength(1);
		const st = stateOf(sent[0]);
		expect(st.messages).toHaveLength(DEFAULT_HISTORY_WINDOW);
		expectSameItems(st.messages, full.slice(700));
		expect(charsOf(st.messages)).toBeLessThanOrEqual(DEFAULT_HISTORY_CHARS);
		expect(st.messagesStart).toBe(700);
		expect(st.historyStart).toBe(700);
		expect(st.historyTotal).toBe(1000);
		expect(st.historyWindow).toEqual({ hasEarlier: true, hiddenCount: 700, earliestIndex: 700 });
		// The engine's own message isn't changed (other sockets may send the same object).
		expect(stateOf(engine).messages).toBe(full);
		expect(full).toHaveLength(1000);
	});

	it("keeps fewer messages when 300 would weigh more than the char budget", () => {
		const full = messages(1000, 10_000); // 10M chars in all
		const { tap, sent } = makeTap();
		tap.accept(snapshot("heavy", full));

		const st = stateOf(sent[0]);
		expect(st.messages).toHaveLength(150); // 150 x 10,000 = exactly 1.5M; one more would be over
		expectSameItems(st.messages, full.slice(850));
		expect(charsOf(st.messages)).toBeLessThanOrEqual(DEFAULT_HISTORY_CHARS);
		expect(charsOf(full.slice(849))).toBeGreaterThan(DEFAULT_HISTORY_CHARS);
		expect(JSON.stringify(sent[0]).length).toBeLessThan(1_600_000);
		expect(st.historyWindow).toEqual({ hasEarlier: true, hiddenCount: 850, earliestIndex: 850 });
	});

	it("always keeps the newest message, even one bigger than the whole budget", () => {
		const full = [...messages(5), textMessage(5, 2_000_000)];
		const { tap, sent } = makeTap();
		tap.accept(snapshot("big", full));
		const st = stateOf(sent[0]);
		expectSameItems(st.messages, [full[5]]);
		expect(st.historyWindow).toEqual(historyWindowAt(5));
	});

	it("sends a short chat whole, with hasEarlier false", () => {
		const full = messages(40);
		const { tap, sent } = makeTap();
		tap.accept(snapshot("short", full));
		const st = stateOf(sent[0]);
		expect(st.messages).toBe(full);
		expect(st.historyWindow).toEqual({ hasEarlier: false, hiddenCount: 0, earliestIndex: 0 });
		expect(st.historyTotal).toBe(40);
	});
});

describe("server message window: load_earlier_messages pages", () => {
	it("serves exact 30-message pages back to the first message, losslessly", () => {
		const full = messages(1000);
		const { tap, sent } = makeTap();
		tap.accept(snapshot("c1", full));
		const first = stateOf(sent[0]);

		const pages: unknown[][] = [];
		let earliest = first.historyWindow?.earliestIndex ?? -1;
		while (earliest > 0) {
			expect(tap.handleRequest({ conversationId: "c1", beforeIndex: earliest, limit: DEFAULT_HISTORY_PAGE })).toBe(
				true,
			);
			const reply = replyOf(sent.at(-1));
			const start = Math.max(0, earliest - DEFAULT_HISTORY_PAGE);
			expect(reply.type).toBe("earlier_messages");
			expect(reply.conversationId).toBe("c1");
			expect(reply.historyStart).toBe(start);
			expect(reply.historyTotal).toBe(1000);
			expect(reply.historyWindow).toEqual(historyWindowAt(start));
			expectSameItems(reply.messages, full.slice(start, earliest));
			pages.unshift(reply.messages);
			earliest = reply.historyWindow.earliestIndex;
		}
		expect(pages).toHaveLength(24); // 23 pages of 30, then the last 10
		expect(pages[0]).toHaveLength(10);
		expect(replyOf(sent.at(-1)).historyWindow).toEqual({ hasEarlier: false, hiddenCount: 0, earliestIndex: 0 });
		expectSameItems([...pages.flat(), ...first.messages], full);

		// Asking before the first message: an empty page, not an error.
		expect(tap.handleRequest({ conversationId: "c1", beforeIndex: 0 })).toBe(true);
		expect(replyOf(sent.at(-1)).messages).toEqual([]);
	});

	it("serves the same page again when asked again (pages are by index, not a moving cursor)", () => {
		const full = messages(1000);
		const { tap, sent } = makeTap();
		tap.accept(snapshot("c1", full));
		tap.loadEarlierBefore(700, 30, "c1");
		const a = replyOf(sent.at(-1));
		tap.loadEarlierBefore(700, 30, "c1");
		const b = replyOf(sent.at(-1));
		expectSameItems(a.messages, full.slice(670, 700));
		expectSameItems(b.messages, a.messages);
		expect(b.historyStart).toBe(670);
	});

	it("keeps the pages exact after deltas append messages", () => {
		const full = messages(1000);
		const extra = messages(2, 20, 1000);
		const { tap, sent } = makeTap();
		tap.accept(snapshot("c1", full));
		const engineDelta = delta("c1", extra, { messagesStart: 0 });
		tap.accept(engineDelta);

		const d = sent.at(-1);
		expect(d?.appended).toBe(engineDelta.appended); // the very list the engine sent
		expectSameItems(d?.appended as unknown[], extra);
		const st = stateOf(d);
		expect(st.messagesStart).toBe(700);
		expect(st.historyStart).toBe(700);
		expect(st.historyTotal).toBe(1002);
		expect(st.historyWindow).toEqual({ hasEarlier: true, hiddenCount: 700, earliestIndex: 700 });

		expect(tap.handleRequest({ conversationId: "c1", beforeIndex: 700, limit: 30 })).toBe(true);
		expectSameItems(replyOf(sent.at(-1)).messages, full.slice(670, 700));
		expect(replyOf(sent.at(-1)).historyTotal).toBe(1002);

		// A delta without messagesStart doesn't gain one.
		tap.accept(delta("c1", []));
		expect("messagesStart" in stateOf(sent.at(-1))).toBe(false);
		expect(stateOf(sent.at(-1)).historyWindow).toEqual(historyWindowAt(670));
	});

	it("serves upstream's count / all requests for the latest snapshot's conversation", () => {
		const full = messages(1000);
		const { tap, sent } = makeTap();
		tap.accept(snapshot("c1", full));

		expect(tap.loadEarlier(50)).toBe(true);
		expectSameItems(replyOf(sent.at(-1)).messages, full.slice(650, 700));
		expect(tap.handleRequest({ count: 10 })).toBe(true);
		expectSameItems(replyOf(sent.at(-1)).messages, full.slice(640, 650));
		expect(tap.loadEarlier(undefined, true)).toBe(true);
		expectSameItems(replyOf(sent.at(-1)).messages, full.slice(0, 640));
		expect(replyOf(sent.at(-1)).historyWindow.hasEarlier).toBe(false);
	});

	it("caps one page at 2,000 messages and treats a bad limit as 1", () => {
		const full = messages(5000);
		const { tap, sent } = makeTap();
		tap.accept(snapshot("c1", full));
		tap.loadEarlierBefore(4700, 999_999, "c1");
		expect(replyOf(sent.at(-1)).messages).toHaveLength(MAX_HISTORY_PAGE);
		tap.loadEarlierBefore(100, -3, "c1");
		expectSameItems(replyOf(sent.at(-1)).messages, [full[99]]);
	});

	it("says no for a conversation it doesn't hold", () => {
		const { tap, sent } = makeTap();
		expect(tap.loadEarlier(30)).toBe(false);
		tap.accept(snapshot("c1", messages(500)));
		expect(tap.handleRequest({ conversationId: "other", beforeIndex: 100 })).toBe(false);
		expect(tap.loadEarlier(30, false, "other")).toBe(false);
		expect(sent).toHaveLength(1);
	});
});

describe("server message window: the fork's own engine window", () => {
	it("counts indices from the engine's messagesStart and leaves older pages to the engine", () => {
		const engineWindow = messages(500, 20, 4000); // whole-chat 4000..4499
		const { tap, sent } = makeTap();
		tap.accept(snapshot("c1", engineWindow, { messagesStart: 4000 }));
		const st = stateOf(sent[0]);
		expectSameItems(st.messages, engineWindow.slice(200));
		expect(st.messagesStart).toBe(4200);
		expect(st.historyTotal).toBe(4500);
		expect(st.historyWindow).toEqual({ hasEarlier: true, hiddenCount: 4200, earliestIndex: 4200 });

		expect(tap.handleRequest({ conversationId: "c1", beforeIndex: 4200, limit: 30 })).toBe(true);
		const page = replyOf(sent.at(-1));
		expect(page.historyStart).toBe(4170);
		expectSameItems(page.messages, engineWindow.slice(170, 200));

		// Down to the engine window's start, then the engine's own load_older takes over.
		expect(tap.loadEarlier(undefined, true, "c1")).toBe(true);
		expect(replyOf(sent.at(-1)).historyStart).toBe(4000);
		expect(tap.handleRequest({ conversationId: "c1", beforeIndex: 4000, limit: 30 })).toBe(false);
		expect(tap.loadEarlier(30, false, "c1")).toBe(false);
	});

	it("passes the engine's older_messages through and moves its window start back", () => {
		const { tap, sent } = makeTap();
		tap.accept(snapshot("c1", messages(100, 20, 4000), { messagesStart: 4000 }));
		const older = { type: "older_messages", conversationId: "c1", start: 3900, messages: messages(100, 20, 3900) };
		tap.accept(older);
		expect(sent.at(-1)).toBe(older);
		tap.accept(delta("c1", [textMessage(4100)], { messagesStart: 3900 }));
		expect(stateOf(sent.at(-1)).historyWindow).toEqual(historyWindowAt(3900));
		expect(stateOf(sent.at(-1)).historyTotal).toBe(4101);
	});

	it("lets a switch-cache (reuse) snapshot and the deltas after it through untouched", () => {
		const full = messages(1000);
		const { tap, sent } = makeTap();
		tap.accept(snapshot("c1", full));
		const reuse = {
			type: "snapshot",
			reuse: { start: 900, count: 90 },
			state: { conversationId: "c1", messages: full.slice(990), messagesStart: 900 },
		};
		tap.accept(reuse);
		expect(sent.at(-1)).toBe(reuse);
		expect(tap.cachedConversations).not.toContain("c1");
		const d = delta("c1", [textMessage(1000)]);
		tap.accept(d);
		expect(sent.at(-1)).toBe(d);
		expect(tap.handleRequest({ conversationId: "c1", beforeIndex: 700 })).toBe(false);
	});
});

describe("server message window: later snapshots, cache and settings", () => {
	it("never moves the start forward on a later full snapshot, and keeps the char budget there too", () => {
		const full = messages(1000, 10_000);
		const { tap, sent } = makeTap();
		tap.accept(snapshot("heavy", full));
		expect(stateOf(sent[0]).historyStart).toBe(850);

		// Without paging: one more message, the start stays (the client already holds these).
		const plusOne = [...full, textMessage(1000, 10_000)];
		tap.accept(snapshot("heavy", plusOne));
		expect(stateOf(sent.at(-1)).historyStart).toBe(850);
		expect(stateOf(sent.at(-1)).messages).toHaveLength(151);

		// After paging back 30, a later snapshot keeps those 30 but doesn't grow back to 300 (upstream did).
		tap.loadEarlierBefore(850, 30, "heavy");
		tap.accept(snapshot("heavy", plusOne));
		const st = stateOf(sent.at(-1));
		expect(st.historyStart).toBe(820);
		expectSameItems(st.messages, plusOne.slice(820));

		// A compaction rewrite (a much shorter list): the tail window wins.
		const compacted = messages(200, 20, 0);
		tap.accept(snapshot("heavy", compacted));
		expect(stateOf(sent.at(-1)).historyStart).toBe(0);
		expect(stateOf(sent.at(-1)).messages).toBe(compacted);
	});

	it("keeps the last 4 conversations (least recently used goes first)", () => {
		expect(MAX_CACHED_CONVERSATIONS).toBe(4);
		const { tap } = makeTap();
		for (const id of ["a", "b", "c", "d", "e"]) tap.accept(snapshot(id, messages(400)));
		expect(tap.cachedConversations).toEqual(["b", "c", "d", "e"]);
		expect(tap.handleRequest({ conversationId: "a", beforeIndex: 100 })).toBe(false);

		expect(tap.handleRequest({ conversationId: "b", beforeIndex: 100, limit: 30 })).toBe(true); // b is used again
		tap.accept(snapshot("f", messages(400)));
		expect(tap.cachedConversations).toEqual(["d", "e", "b", "f"]);
	});

	it("passes other messages, and snapshots it can't read, through as they are", () => {
		const { tap, sent } = makeTap();
		const notice = { type: "notice", text: "hi" };
		const noConv = { type: "snapshot", state: { messages: messages(500) } };
		const noMessages = { type: "snapshot", state: { conversationId: "c1" } };
		const strayDelta = delta("nobody", [textMessage(1)]);
		for (const m of [notice, noConv, noMessages, strayDelta]) tap.accept(m);
		expect(sent).toEqual([notice, noConv, noMessages, strayDelta]);
		sent.forEach((m, i) => expect(m).toBe([notice, noConv, noMessages, strayDelta][i]));
	});

	it("does nothing when switched off", () => {
		const { tap, sent } = makeTap(readMessageWindowConfig({ PI_WEB_HISTORY_WINDOW: "off" }));
		expect(tap.enabled).toBe(false);
		const snap = snapshot("c1", messages(1000));
		tap.accept(snap);
		expect(sent[0]).toBe(snap);
		expect(tap.cachedConversations).toEqual([]);
		expect(tap.loadEarlier(30)).toBe(false);
	});

	it("reads PI_WEB_HISTORY_WINDOW like upstream", () => {
		expect(readMessageWindowConfig({})).toEqual({ windowSize: 300, charBudget: 1_500_000, pageSize: 30 });
		for (const off of ["0", "off", "false", "no", " OFF "]) {
			expect(readMessageWindowConfig({ PI_WEB_HISTORY_WINDOW: off })).toEqual({ ...OFF_CONFIG });
		}
		expect(readMessageWindowConfig({ PI_WEB_HISTORY_WINDOW: "120" })).toEqual({ ...DEFAULT_CONFIG, windowSize: 120 });
		expect(readMessageWindowConfig({ PI_WEB_HISTORY_WINDOW: "120.7" }).windowSize).toBe(120);
		for (const bad of ["", "abc", "-5"]) {
			expect(readMessageWindowConfig({ PI_WEB_HISTORY_WINDOW: bad })).toEqual({ ...DEFAULT_CONFIG });
		}
		const copy = readMessageWindowConfig({});
		copy.windowSize = 1;
		expect(DEFAULT_CONFIG.windowSize).toBe(300);
	});
});

describe("server message window: pure helpers", () => {
	it("readEarlierSlice returns exactly [before - limit, before)", () => {
		const list = Array.from({ length: 100 }, (_, i) => i);
		expect(readEarlierSlice(list, 50, 30)).toEqual({ start: 20, messages: list.slice(20, 50) });
		expect(readEarlierSlice(list, 50)).toEqual({ start: 20, messages: list.slice(20, 50) });
		expect(readEarlierSlice(list, 10, 30)).toEqual({ start: 0, messages: list.slice(0, 10) });
		expect(readEarlierSlice(list, 150, 30)).toEqual({ start: 70, messages: list.slice(70) });
		expect(readEarlierSlice(list, -3, 30)).toEqual({ start: 0, messages: [] });
		expect(readEarlierSlice(list, Number.NaN, 30)).toEqual({ start: 0, messages: [] });
		expect(readEarlierSlice(list, 50, 0)).toEqual({ start: 49, messages: [49] });
		expect(readEarlierSlice(list, 50, Number.NaN)).toEqual({ start: 49, messages: [49] });
		expect(readEarlierSlice(list, 50, Infinity)).toEqual({ start: 0, messages: list.slice(0, 50) });
		expect(readEarlierSlice(list, 50, 12.9)).toEqual({ start: 38, messages: list.slice(38, 50) });
	});

	it("estimateMessageChars adds up the text fields of the content blocks and the summary", () => {
		const m = {
			content: [
				{ type: "text", text: "abc" },
				{ type: "image", dataUrl: "data" },
				{ type: "toolCall", argumentsText: "12", command: "ls" },
				{ type: "thinking", thinking: "hmm", other: "not counted" },
				null,
			],
			summary: "s",
		};
		expect(estimateMessageChars(m)).toBe(3 + 4 + 2 + 2 + 3 + 1);
		expect(estimateMessageChars({ content: "plain string" })).toBe(0);
		expect(estimateMessageChars(null)).toBe(0);
		expect(estimateMessageChars("text")).toBe(0);
	});

	it("pickWindowStart and computeWindowStart follow upstream's rules", () => {
		const cfg = DEFAULT_CONFIG;
		expect(pickWindowStart(messages(1000), cfg)).toBe(700);
		expect(pickWindowStart(messages(10), cfg)).toBe(0);
		expect(pickWindowStart(messages(1000), { ...cfg, charBudget: 0 })).toBe(700);
		expect(pickWindowStart(messages(1000), OFF_CONFIG)).toBe(0);
		expect(pickWindowStart([], cfg)).toBe(0);

		expect(computeWindowStart(-1, 1000, 300)).toBe(700);
		expect(computeWindowStart(650, 1000, 300)).toBe(650);
		expect(computeWindowStart(900, 1000, 300)).toBe(700);
		expect(computeWindowStart(500, 200, 300)).toBe(0);
		expect(computeWindowStart(500, 1000, 0)).toBe(0);
	});

	it("historyWindowAt", () => {
		expect(historyWindowAt(0)).toEqual({ hasEarlier: false, hiddenCount: 0, earliestIndex: 0 });
		expect(historyWindowAt(12)).toEqual({ hasEarlier: true, hiddenCount: 12, earliestIndex: 12 });
		expect(historyWindowAt(-4)).toEqual({ hasEarlier: false, hiddenCount: 0, earliestIndex: 0 });
	});
});
