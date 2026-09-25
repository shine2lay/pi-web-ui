/**
 * exchange-digest 单测 —— 分页窗口之前几轮的摘要（server/exchange-digest.ts）。
 *
 * 覆盖：一轮的摘要（提问 + 附件、回答只留文字、回答之后的消息、计数、状态、折不折）、
 * `!` 命令、以错误收尾、partial；按轮数 / 按区间取、上限；快照带几份、跨窗口那一轮；
 * 以及和前端 planExchangeFolds 算出来的一样（摘要是服务端文件，折叠规则是前端文件，
 * 没法共用一份代码，这里拿同一批样本钉住两边）。
 */
import { describe, expect, it } from "vitest";
import {
	MAX_DIGESTS,
	digestExchange,
	digestsBefore,
	exchangeHeads,
	snapshotDigests,
	straddleDigest,
} from "../../server/exchange-digest.js";
import type { UiExchangeDigest, UiMessage } from "../../server/protocol.js";
import { planExchangeFolds } from "../../web/src/exchange-fold.js";

let seq = 0;
const T0 = 1_700_000_000_000;

function user(text: string, ts = T0): UiMessage {
	return { id: `u${++seq}`, role: "user", content: [{ type: "text", text }], timestamp: ts };
}
function asst(blocks: Array<"think" | "tool" | string>, ts = T0, extra: Partial<UiMessage> = {}): UiMessage {
	const id = `a${++seq}`;
	const content = blocks.map((b, i) =>
		b === "think"
			? { type: "thinking", thinking: "hmm" }
			: b === "tool"
				? { type: "toolCall", id: `${id}-c${i}`, name: "bash", argumentsText: '{"command":"ls"}' }
				: { type: "text", text: b },
	);
	return { id, role: "assistant", content, timestamp: ts, stopReason: "stop", ...extra } as UiMessage;
}
function result(of: UiMessage, ts = T0): UiMessage {
	const call = of.content.find((b) => b.type === "toolCall") as { id: string };
	return {
		id: `t-${call.id}`,
		role: "toolResult",
		toolCallId: call.id,
		content: [{ type: "text", text: "ok" }],
		timestamp: ts,
	} as UiMessage;
}
function custom(customType: string, ts = T0): UiMessage {
	return {
		id: `c${++seq}`,
		role: "custom",
		customType,
		content: [{ type: "text", text: customType }],
		timestamp: ts,
	} as UiMessage;
}
function bang(ts = T0): UiMessage {
	return { id: `b${++seq}`, role: "bashExecution", content: [], timestamp: ts } as UiMessage;
}

/** 五轮：多步 + 附件 + 收尾提醒 / 纯文字回答 / `!` 命令 / 以错误收尾 / 一长串工具调用。 */
function conversation() {
	const q1 = user("first", T0);
	const f1 = custom("file", T0);
	const a1 = asst(["think", "tool"], T0 + 1_000);
	const r1 = result(a1, T0 + 2_000);
	const a2 = asst(["tool"], T0 + 3_000);
	const r2 = result(a2, T0 + 4_000);
	const a3 = asst(["Answer one."], T0 + 5_000);
	const n1 = custom("note", T0 + 6_000);
	const ex1 = [q1, f1, a1, r1, a2, r2, a3, n1];

	const q2 = user("second", T0 + 10_000);
	const b1 = asst(["Answer two."], T0 + 11_000);
	const ex2 = [q2, b1];

	const ex3 = [bang(T0 + 20_000)];

	const q4 = user("fourth", T0 + 30_000);
	const c1 = asst(["Partial text.", "tool"], T0 + 31_000);
	const cr = result(c1, T0 + 32_000);
	const c2 = asst([], T0 + 33_000, { stopReason: "error", errorMessage: "boom" });
	const ex4 = [q4, c1, cr, c2];

	const q5 = user("fifth", T0 + 40_000);
	const ex5: UiMessage[] = [q5];
	for (let i = 0; i < 6; i++) {
		const a = asst(["tool"], T0 + 41_000 + i * 10);
		ex5.push(a, result(a, T0 + 41_005 + i * 10));
	}
	ex5.push(asst(["Answer five."], T0 + 42_000));

	const exchanges = [ex1, ex2, ex3, ex4, ex5];
	return { messages: exchanges.flat(), exchanges, q5, a1, a3, n1, b1, c1, c2 };
}

const ids = (list: readonly UiMessage[]) => list.map((m) => m.id);
const spans = (list: readonly UiExchangeDigest[]) => list.map((d) => `${d.index}-${d.end}${d.partial ? "p" : ""}`);
const isStep = (b: { type: string }) => b.type === "thinking" || b.type === "toolCall";

describe("digestExchange", () => {
	it("keeps what a folded exchange shows: question + attachments, the answer, what follows it", () => {
		const { messages, exchanges, a3, n1 } = conversation();
		const d = digestExchange(messages, 0, exchanges[0].length, false);
		expect(ids(d.head)).toEqual(ids(exchanges[0].slice(0, 2)));
		expect(ids(d.answers)).toEqual([a3.id]);
		expect(ids(d.after)).toEqual([n1.id]);
		expect(d).toMatchObject({ index: 0, end: 8, folded: true, turns: 3, thinking: 1, toolCalls: 2, status: "done" });
		expect(d.startTs).toBe(T0);
		expect(d.endTs).toBe(T0 + 6_000);
		expect(d.partial).toBeUndefined();
	});

	it("a plain text answer has nothing to fold", () => {
		const { messages, b1 } = conversation();
		const d = digestExchange(messages, 8, 10, false);
		expect(ids(d.answers)).toEqual([b1.id]);
		expect(d.folded).toBe(false);
		expect(d.turns).toBe(1);
	});

	it("a `!` command is its own exchange with no answer", () => {
		const { messages } = conversation();
		const d = digestExchange(messages, 10, 11, false);
		expect(d.head[0].role).toBe("bashExecution");
		expect(d.answers).toEqual([]);
		expect(d.after).toEqual([]);
		expect(d.folded).toBe(false);
	});

	it("ending in an error also shows the last assistant message; answers keep only their text", () => {
		const { messages, c1, c2 } = conversation();
		const d = digestExchange(messages, 11, 15, false);
		expect(d.status).toBe("error");
		expect(ids(d.answers)).toEqual([c1.id, c2.id]);
		expect(d.answers[0].content.some(isStep)).toBe(false);
		expect(d.answers[0].content).toHaveLength(1);
		expect(d.folded).toBe(true);
	});

	it("partial: only the start of an exchange (its end is inside the window) — no answer yet", () => {
		const { messages } = conversation();
		const d = digestExchange(messages, 15, 20, true);
		expect(d).toMatchObject({ index: 15, end: 20, partial: true, folded: true, turns: 2, toolCalls: 2 });
		expect(d.answers).toEqual([]);
		expect(d.after).toEqual([]);
	});
});

describe("digestsBefore", () => {
	it("the newest `count` exchanges before `before`, each running to the next head", () => {
		const { messages } = conversation();
		expect(spans(digestsBefore(messages, messages.length, { count: 2 }))).toEqual(["11-15", "15-29"]);
	});

	it("an exchange that runs past `before` comes back partial", () => {
		const { messages } = conversation();
		expect(spans(digestsBefore(messages, 19, { count: 2 }))).toEqual(["11-15", "15-19p"]);
	});

	it("`from` = every exchange whose head is in [from, before)", () => {
		const { messages } = conversation();
		expect(spans(digestsBefore(messages, 15, { from: 8 }))).toEqual(["8-10", "10-11", "11-15"]);
		expect(spans(digestsBefore(messages, 15, { from: 9 }))).toEqual(["10-11", "11-15"]);
	});

	it(`never more than MAX_DIGESTS (${MAX_DIGESTS}), the newest ones`, () => {
		const messages: UiMessage[] = [];
		for (let i = 0; i < MAX_DIGESTS + 5; i++) messages.push(user(`q${i}`), asst([`a${i}`]));
		const out = digestsBefore(messages, messages.length, { from: 0 });
		expect(out).toHaveLength(MAX_DIGESTS);
		expect(out.at(-1)?.end).toBe(messages.length);
	});
});

describe("snapshotDigests", () => {
	it("no window start, no digests", () => {
		const { messages } = conversation();
		expect(snapshotDigests(messages, 0, 5)).toEqual([]);
	});

	it("tops up to k exchanges: the ones starting in the window count", () => {
		const { messages } = conversation();
		// 窗口从第五轮的提问开始：窗口里一轮，补四轮
		const out = snapshotDigests(messages, 15, 5);
		expect(spans(out)).toEqual(["0-8", "8-10", "10-11", "11-15"]);
	});

	it("a window starting mid-exchange always brings that exchange's start (partial, last)", () => {
		const { messages } = conversation();
		expect(spans(snapshotDigests(messages, 20, 3))).toEqual(["10-11", "11-15", "15-20p"]);
		// 窗口里已经有够多轮了，跨窗口那一轮的开头照样要带
		expect(spans(snapshotDigests(messages, 3, 3))).toEqual(["0-3p"]);
	});

	it("enough exchanges in the window and it starts on a head: nothing", () => {
		const { messages } = conversation();
		expect(snapshotDigests(messages, 8, 3)).toEqual([]);
	});
});

describe("straddleDigest", () => {
	it("only when the start is mid-exchange", () => {
		const { messages } = conversation();
		expect(straddleDigest(messages, 15)).toBeUndefined();
		expect(spans([straddleDigest(messages, 18)!])).toEqual(["15-18p"]);
	});

	it("nothing before the first question", () => {
		const messages = [custom("note"), custom("note"), user("q"), asst(["a"])];
		expect(straddleDigest(messages, 1)).toBeUndefined();
		expect(exchangeHeads(messages)).toEqual([2]);
	});
});

describe("parity with the page's fold planner (web/src/exchange-fold.ts)", () => {
	it("same counts, answers, status and row / no row; shown = question + answers + after", () => {
		const { exchanges } = conversation();
		for (const ex of exchanges) {
			const d = digestExchange(ex, 0, ex.length, false);
			const plan = planExchangeFolds(ex, { live: false, streaming: false });
			expect(d.folded, `row for ${ex[0].id}`).toBe(plan.folds.length === 1);
			const f = plan.folds[0];
			if (f) {
				expect([d.turns, d.thinking, d.toolCalls]).toEqual([f.turns, f.thinking, f.toolCalls]);
				expect(d.status).toBe(f.status);
				expect(ids(d.answers)).toEqual(f.answers);
			}
			const hidden = new Set(f?.hidden ?? []);
			const shown = ex.filter((m) => !hidden.has(m.id)).map((m) => m.id);
			expect(ids([...d.head, ...d.answers, ...d.after]), `shown for ${ex[0].id}`).toEqual(shown);
		}
	});
});
