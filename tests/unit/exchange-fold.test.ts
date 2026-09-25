/**
 * exchange-fold 单测 —— 每一轮对话折成一行的切分与去向（web/src/exchange-fold.ts）。
 *
 * 覆盖：多轮折叠与计数、回答取最后一条有文字的助手消息、纯文字回答不出行、
 * 单轮思考也折、错误收尾、提问附件与收尾后的消息照常显示、`!` 命令是边界、
 * 分页窗口从一轮中间开始、直播轮（含刚发出正文还空着、已写完回答的那一瞬）、
 * textOnly 的引用缓存、直播行的当前步骤、耗时格式。
 */
import { describe, expect, it } from "vitest";
import {
	formatSpan,
	liveStep,
	planExchangeFolds,
	textOnly,
	type ExchangeFold,
	type FoldLead,
	type FoldPlan,
} from "../../web/src/exchange-fold.js";
import type { UiMessage } from "../../web/src/types.js";

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
	return { id, role: "assistant", content, timestamp: ts, stopReason: "stop", ...extra };
}
function result(of: UiMessage, ts = T0): UiMessage {
	const call = of.content.find((b) => b.type === "toolCall") as { id: string };
	return {
		id: `t-${call.id}`,
		role: "toolResult",
		toolCallId: call.id,
		content: [{ type: "text", text: "ok" }],
		timestamp: ts,
	};
}
function custom(customType: string, ts = T0): UiMessage {
	return { id: `c${++seq}`, role: "custom", customType, content: [{ type: "text", text: customType }], timestamp: ts };
}

const DONE = { live: false, streaming: false };

function only(plan: FoldPlan): ExchangeFold {
	expect(plan.folds).toHaveLength(1);
	return plan.folds[0];
}

describe("planExchangeFolds: finished exchanges", () => {
	it("folds every step between the question and the answer and counts them", () => {
		const q = user("check it", T0);
		const a1 = asst(["think", "I'll look first", "tool"], T0 + 1_000);
		const t1 = result(a1, T0 + 5_000);
		const a2 = asst(["tool"], T0 + 6_000);
		const t2 = result(a2, T0 + 9_000);
		const a3 = asst(["All good."], T0 + 250_000);
		const plan = planExchangeFolds([q, a1, t1, a2, t2, a3], DONE);
		const f = only(plan);
		expect(f.key).toBe(q.id);
		expect(f.rowBefore).toBe(a1.id);
		expect(f.hidden).toEqual([a1.id, t1.id, a2.id, t2.id]);
		expect(f.answers).toEqual([a3.id]);
		expect([f.turns, f.thinking, f.toolCalls]).toEqual([3, 1, 2]);
		expect(f.status).toBe("done");
		expect(f.live).toBe(false);
		expect(f.endTs! - f.startTs!).toBe(250_000);
		expect(plan.role.get(a1.id)).toBe("hidden");
		expect(plan.role.get(a3.id)).toBe("answer");
		expect(plan.role.has(q.id)).toBe(false);
		expect(plan.rowBefore.get(a1.id)).toBe(f);
	});

	it("takes the last assistant message that has text as the answer", () => {
		const q = user("q");
		const a1 = asst(["tool"]);
		const t1 = result(a1);
		const a2 = asst(["Here is the summary.", "tool"]);
		const t2 = result(a2);
		const a3 = asst(["  "]);
		const f = only(planExchangeFolds([q, a1, t1, a2, t2, a3], DONE));
		expect(f.answers).toEqual([a2.id]);
		expect(f.hidden).toEqual([a1.id, t1.id, t2.id, a3.id]);
	});

	it("leaves a plain one-message answer alone", () => {
		const plan = planExchangeFolds([user("hi"), asst(["hello"])], DONE);
		expect(plan.folds).toHaveLength(0);
		expect(plan.role.size).toBe(0);
	});

	it("still folds a single turn whose answer carries thinking", () => {
		const a = asst(["think", "answer"]);
		const f = only(planExchangeFolds([user("q"), a], DONE));
		expect(f.hidden).toEqual([]);
		expect(f.answers).toEqual([a.id]);
		expect([f.turns, f.thinking, f.toolCalls]).toEqual([1, 1, 0]);
	});

	it("keeps the failed last message visible next to the answer", () => {
		const q = user("q");
		const a1 = asst(["Working on it", "tool"]);
		const t1 = result(a1);
		const a2 = asst([], T0, { stopReason: "error", errorMessage: "overloaded" });
		const f = only(planExchangeFolds([q, a1, t1, a2], DONE));
		expect(f.status).toBe("error");
		expect(f.answers).toEqual([a1.id, a2.id]);
		expect(f.hidden).toEqual([t1.id]);
	});

	it("reports an aborted run", () => {
		const a1 = asst(["tool"]);
		const a2 = asst(["partial"], T0, { stopReason: "aborted" });
		expect(only(planExchangeFolds([user("q"), a1, result(a1), a2], DONE)).status).toBe("aborted");
	});

	it("keeps the question's attachments and what comes after the answer visible", () => {
		const q = user("look at this");
		const file = custom("file");
		const a1 = asst(["tool"]);
		const t1 = result(a1);
		const a2 = asst(["Done."]);
		const review = custom("goal-review");
		const plan = planExchangeFolds([q, file, a1, t1, a2, review], DONE);
		const f = only(plan);
		expect(f.rowBefore).toBe(a1.id);
		expect(plan.role.has(file.id)).toBe(false);
		expect(plan.role.has(review.id)).toBe(false);
	});

	it("hides a mid-run compaction summary or reminder with the steps", () => {
		const a1 = asst(["tool"]);
		const t1 = result(a1);
		const note = custom("reminder");
		const a2 = asst(["Done."]);
		const plan = planExchangeFolds([user("q"), a1, t1, note, a2], DONE);
		expect(plan.role.get(note.id)).toBe("hidden");
	});

	it("treats the user's own ! command as a boundary", () => {
		const q = user("q");
		const a1 = asst(["tool"]);
		const t1 = result(a1);
		const a2 = asst(["Done."]);
		const bash: UiMessage = { id: "b1", role: "bashExecution", content: [], timestamp: T0 };
		const plan = planExchangeFolds([q, a1, t1, a2, bash], DONE);
		expect(only(plan).answers).toEqual([a2.id]);
		expect(plan.role.has(bash.id)).toBe(false);
	});

	it("folds an exchange cut in half by the pagination window", () => {
		const a0 = asst(["tool"]);
		const t0 = result(a0);
		const a1 = asst(["Old answer."]);
		const q2 = user("next");
		const b = asst(["New answer."]);
		const plan = planExchangeFolds([a0, t0, a1, q2, b], DONE);
		const f = only(plan);
		expect(f.key).toBe(a0.id);
		expect(f.rowBefore).toBe(a0.id);
		expect(f.hidden).toEqual([a0.id, t0.id]);
		expect(f.answers).toEqual([a1.id]);
	});

	it("continues an exchange whose start is before the window (lead from the digest)", () => {
		const a0 = asst(["think", "tool"], T0 + 5_000);
		const t0 = result(a0);
		const a1 = asst(["Old answer."], T0 + 9_000);
		const lead: FoldLead = { key: "u-before", turns: 7, thinking: 3, toolCalls: 6, startTs: T0 };
		const f = only(planExchangeFolds([a0, t0, a1], { ...DONE, lead }));
		expect(f.key).toBe("u-before");
		expect(f.turns).toBe(9);
		expect(f.thinking).toBe(4);
		expect(f.toolCalls).toBe(7);
		expect(f.startTs).toBe(T0);
		expect(f.hidden).toEqual([a0.id, t0.id]);
		expect(f.answers).toEqual([a1.id]);
	});

	it("keeps a row for the lead even when the window's part has nothing to fold", () => {
		// 窗口正好从最后一条工具结果开始：这段没有助手消息，但前面的步骤要靠这一行取
		const t0: UiMessage = {
			id: "t-x",
			role: "toolResult",
			toolCallId: "x",
			content: [{ type: "text", text: "ok" }],
			timestamp: T0,
		};
		const q2 = user("next");
		const b = asst(["New answer."]);
		const lead: FoldLead = { key: "u-before", turns: 3, thinking: 0, toolCalls: 3, startTs: T0 };
		const f = only(planExchangeFolds([t0, q2, b], { ...DONE, lead }));
		expect(f.key).toBe("u-before");
		expect(f.hidden).toEqual([t0.id]);
		expect(f.turns).toBe(3);
		expect(f.status).toBe("done");
	});

	it("ignores the lead when the window starts on a question", () => {
		const q = user("q");
		const a = asst(["tool"]);
		const t = result(a);
		const b = asst(["done"]);
		const lead: FoldLead = { key: "u-before", turns: 5, thinking: 5, toolCalls: 5 };
		const f = only(planExchangeFolds([q, a, t, b], { ...DONE, lead }));
		expect(f.key).toBe(q.id);
		expect(f.turns).toBe(2);
		expect(f.toolCalls).toBe(1);
	});

	it("carries the lead into the live exchange (the window sits inside a long run)", () => {
		const a0 = asst(["tool"], T0 + 1_000);
		const t0 = result(a0);
		const lead: FoldLead = { key: "u-live", turns: 40, thinking: 10, toolCalls: 39, startTs: T0 };
		const f = only(planExchangeFolds([a0, t0], { live: true, streaming: true, lead }));
		expect(f.key).toBe("u-live");
		expect(f.live).toBe(true);
		expect(f.status).toBe("working");
		expect(f.turns).toBe(41);
		expect(f.toolCalls).toBe(40);
		expect(f.startTs).toBe(T0);
		expect(f.hidden).toEqual([a0.id, t0.id]);
	});

	it("splits a steered run into two exchanges", () => {
		const a1 = asst(["tool"]);
		const t1 = result(a1);
		const steer = user("also check B");
		const a2 = asst(["tool"]);
		const t2 = result(a2);
		const a3 = asst(["Both checked."]);
		const plan = planExchangeFolds([user("check A"), a1, t1, steer, a2, t2, a3], DONE);
		expect(plan.folds.map((f) => f.hidden)).toEqual([
			[a1.id, t1.id],
			[a2.id, t2.id],
		]);
		expect(plan.folds[1].answers).toEqual([a3.id]);
	});
});

describe("planExchangeFolds: the live exchange", () => {
	it("hides the whole body while the agent works", () => {
		const q = user("q");
		const a1 = asst(["Let me check", "tool"]);
		const t1 = result(a1);
		const f = only(planExchangeFolds([q, a1, t1], { live: true, streaming: true }));
		expect(f.live).toBe(true);
		expect(f.status).toBe("working");
		expect(f.hidden).toEqual([a1.id, t1.id]);
		expect(f.answers).toEqual([]);
		expect(f.lastAssistant).toBe(a1);
	});

	it("puts the row at the end while the body is still empty", () => {
		const q = user("q");
		const plan = planExchangeFolds([q], { live: true, streaming: true });
		const f = only(plan);
		expect(f.rowBefore).toBeUndefined();
		expect(plan.tailRow).toBe(f);
		expect(f.turns).toBe(0);
	});

	it("waits for the model after a tool result without showing an answer", () => {
		const a1 = asst(["tool"]);
		const f = only(planExchangeFolds([user("q"), a1, result(a1)], { live: true, streaming: false }));
		expect(f.live).toBe(true);
		expect(f.answers).toEqual([]);
	});

	it("does not flash 'working' once the answer is written", () => {
		const a1 = asst(["tool"]);
		const t1 = result(a1);
		const a2 = asst(["Done."]);
		const f = only(planExchangeFolds([user("q"), a1, t1, a2], { live: true, streaming: false }));
		expect(f.live).toBe(false);
		expect(f.status).toBe("done");
		expect(f.answers).toEqual([a2.id]);
	});

	it("keeps the previous exchange finished while the new question is in flight", () => {
		const a1 = asst(["tool"]);
		const plan = planExchangeFolds([user("q1"), a1, result(a1), asst(["Done."]), user("q2")], {
			live: true,
			streaming: true,
		});
		expect(plan.folds.map((f) => f.live)).toEqual([false, true]);
	});

	it("shows an earlier answer while an extension-driven turn waits for the model", () => {
		const a1 = asst(["tool"]);
		const a2 = asst(["Done."]);
		const nudge = custom("goal-continue");
		const f = only(planExchangeFolds([user("q"), a1, result(a1), a2, nudge], { live: true, streaming: false }));
		expect(f.live).toBe(true);
		expect(f.answers).toEqual([a2.id]);
		expect(f.hidden).toContain(nudge.id);
	});
});

describe("textOnly", () => {
	it("drops thinking and tool calls, keeps the rest, and caches the result", () => {
		const a = asst(["think", "answer", "tool"]);
		const v = textOnly(a);
		expect(v.content.map((b) => b.type)).toEqual(["text"]);
		expect(textOnly(a)).toBe(v);
		expect(a.content).toHaveLength(3);
	});

	it("returns the message itself when there is nothing to drop", () => {
		const a = asst(["answer"]);
		expect(textOnly(a)).toBe(a);
	});
});

describe("liveStep", () => {
	const none = () => false;
	it("reads the streaming message's last block", () => {
		expect(liveStep(asst(["think"]), undefined, none)).toEqual({ kind: "thinking" });
		expect(liveStep(asst(["think", "text"]), undefined, none)).toEqual({ kind: "writing" });
		expect(liveStep(asst(["text", "tool"]), undefined, none)).toMatchObject({ kind: "tool", name: "bash" });
		expect(liveStep(asst([]), undefined, none)).toEqual({ kind: "waiting" });
	});

	it("between turns, shows the first tool that has not finished", () => {
		const a = asst(["tool", "tool"]);
		const first = (a.content[0] as { id: string }).id;
		expect(liveStep(null, a, none)).toMatchObject({ kind: "tool", argumentsText: '{"command":"ls"}' });
		expect(liveStep(null, a, () => true)).toEqual({ kind: "waiting" });
		expect(liveStep(null, a, (id) => id === first)).toMatchObject({ kind: "tool" });
	});
});

describe("formatSpan", () => {
	it("formats seconds, minutes and hours", () => {
		expect(formatSpan(45_900)).toBe("45s");
		expect(formatSpan(250_000)).toBe("4m 10s");
		expect(formatSpan(3_900_000)).toBe("1h 05m");
		expect(formatSpan(-5)).toBe("0s");
	});
});
