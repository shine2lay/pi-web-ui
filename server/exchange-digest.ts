/**
 * 最近几轮的摘要（exchange-digest，fork 补丁；接 chat-window-pagination 与 exchange-fold）。
 *
 * 分页之后快照只带最新的 MESSAGE_WINDOW 条消息。agent 一轮动辄几百上千步，这一截
 * 常常全落在最后一轮里：前端把步骤折起来以后，页面上只剩一行，前面几轮问了什么、
 * 答了什么都看不到。把最近几轮原样发过来又太重（实测长会话最近 5 轮 11–12MB，
 * 现在的快照是 0.2–1.8MB）。
 *
 * 所以窗口之前的每一轮只发前端折叠时会显示的东西：提问（连同附件）、回答（只留文字）、
 * 回答之后照常显示的消息，和折叠行的计数。一轮几 KB。点开折叠行才去取这一轮的
 * 全部步骤（load_older）。
 *
 * 规则与 web/src/exchange-fold.ts 的 planSegment 一致（边界、附件、回答、状态、计数）。
 * 那边是前端文件，这边是服务端文件，没法共用一份；tests/unit/exchange-digest.test.ts
 * 拿同一批样本钉住两边算出来的一样。
 */

import type { UiContentBlock, UiExchangeDigest, UiMessage } from "./protocol.js";

/** 一次最多发多少份摘要（点导轨上很老的提问时按区间取，防一次取爆）。 */
export const MAX_DIGESTS = 1000;

function blocksOf(m: UiMessage): UiContentBlock[] {
	return Array.isArray(m.content) ? m.content : [];
}

/** 一轮的边界：用户提问，或用户自己跑的 `!` 命令。 */
function isBoundary(m: UiMessage): boolean {
	return m.role === "user" || m.role === "bashExecution";
}

/** 提问后紧跟的附件（custom "file"）属于提问本身。 */
function isAttachment(m: UiMessage): boolean {
	return m.role === "custom" && m.customType === "file";
}

function isStepBlock(b: UiContentBlock): boolean {
	return b.type === "thinking" || b.type === "toolCall";
}

function hasVisibleText(m: UiMessage): boolean {
	return blocksOf(m).some((b) => {
		if (b.type !== "text") return false;
		const text = (b as { text?: unknown }).text;
		return typeof text === "string" && text.trim() !== "";
	});
}

/** 回答只留文字（去掉思考和工具调用），和前端折着时显示的一样。 */
function textOnly(m: UiMessage): UiMessage {
	const blocks = blocksOf(m);
	return blocks.some(isStepBlock) ? { ...m, content: blocks.filter((b) => !isStepBlock(b)) } : m;
}

/** 每一轮开头的下标（升序）。 */
export function exchangeHeads(messages: readonly UiMessage[]): number[] {
	const out: number[] = [];
	for (let i = 0; i < messages.length; i++) if (isBoundary(messages[i])) out.push(i);
	return out;
}

/** 第一个 >= x 的位置（heads 升序）。 */
function lowerBound(heads: readonly number[], x: number): number {
	let lo = 0;
	let hi = heads.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (heads[mid] < x) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * [a, b) 这一段的摘要，a 是一轮的开头。partial = 这一轮在 b 之后还没完
 * （后半截在消息窗口里，前端只拿提问和计数接到那一段前面，所以不带回答）。
 */
export function digestExchange(
	messages: readonly UiMessage[],
	a: number,
	b: number,
	partial: boolean,
): UiExchangeDigest {
	const head: UiMessage[] = [messages[a]];
	let bodyStart = a + 1;
	if (messages[a].role === "user") {
		while (bodyStart < b && isAttachment(messages[bodyStart])) head.push(messages[bodyStart++]);
	}

	let lastAsst = -1;
	let turns = 0;
	let thinking = 0;
	let toolCalls = 0;
	let endTs: number | undefined;
	for (let i = bodyStart; i < b; i++) {
		const m = messages[i];
		if (typeof m.timestamp === "number" && (endTs === undefined || m.timestamp > endTs)) endTs = m.timestamp;
		if (m.role !== "assistant") continue;
		lastAsst = i;
		turns++;
		for (const blk of blocksOf(m)) {
			if (blk.type === "thinking") thinking++;
			else if (blk.type === "toolCall") toolCalls++;
		}
	}
	const base = { index: a, end: b, head, turns, thinking, toolCalls, startTs: messages[a].timestamp, endTs };

	if (partial) return { ...base, partial: true, answers: [], after: [], folded: b > bodyStart, status: "done" };

	if (lastAsst < 0) {
		// 没有助手消息（`!` 命令、没等到回答就中止的提问）：前端不出折叠行，正文照常显示。
		return { ...base, answers: [], after: messages.slice(bodyStart, b), folded: false, status: "done" };
	}

	const last = messages[lastAsst];
	const status = last.stopReason === "error" ? "error" : last.stopReason === "aborted" ? "aborted" : "done";
	// 回答 = 最后一条有文字的助手消息（最后一轮常常只剩一次收尾的工具调用，真正的回答在前面）。
	const answerIdx: number[] = [];
	for (let i = lastAsst; i >= bodyStart; i--) {
		if (messages[i].role === "assistant" && hasVisibleText(messages[i])) {
			answerIdx.push(i);
			break;
		}
	}
	// 以错误收尾：最后一条助手消息也显示（错误信息挂在它上面）。
	if (answerIdx[0] !== lastAsst && (status === "error" || !!last.errorMessage)) answerIdx.push(lastAsst);

	let hidden = 0;
	const after: UiMessage[] = [];
	for (let i = bodyStart; i < b; i++) {
		if (answerIdx.includes(i)) continue;
		// 最后一条助手消息之前的都是过程；工具结果本来就画在工具卡里。之后的（目标评审、
		// 手动压缩摘要……）不是这一轮的过程，照常显示。
		if (i <= lastAsst || messages[i].role === "toolResult") hidden++;
		else after.push(messages[i]);
	}
	const answerHasSteps = answerIdx.some((i) => blocksOf(messages[i]).some(isStepBlock));
	return {
		...base,
		answers: answerIdx.map((i) => textOnly(messages[i])),
		after,
		folded: hidden > 0 || answerHasSteps,
		status,
	};
}

/**
 * before 之前的几轮的摘要（升序）：默认取最近的 count 轮；给了 from 就取开头落在
 * [from, before) 里的每一轮（最多 MAX_DIGESTS 份，取最近的）。每份覆盖到下一轮的开头，
 * 最多到 before——越过 before 的那一轮是 partial。
 */
export function digestsBefore(
	messages: readonly UiMessage[],
	before: number,
	pick: { count?: number; from?: number },
	heads: readonly number[] = exchangeHeads(messages),
): UiExchangeDigest[] {
	const limit = Math.min(Math.max(0, Math.floor(before)), messages.length);
	const hi = lowerBound(heads, limit);
	let lo =
		pick.from !== undefined
			? lowerBound(heads, Math.max(0, Math.floor(pick.from)))
			: hi - Math.max(0, Math.floor(pick.count ?? 0));
	lo = Math.max(0, lo, hi - MAX_DIGESTS);
	const out: UiExchangeDigest[] = [];
	for (let k = lo; k < hi; k++) {
		const next = k + 1 < heads.length ? heads[k + 1] : messages.length;
		out.push(digestExchange(messages, heads[k], Math.min(next, limit), next > limit));
	}
	return out;
}

/**
 * 整份快照带的摘要：让页面至少看得到最近 k 轮（窗口里开头的也算）。窗口从一轮中间
 * 开始时，那一轮的开头总要带上——不然窗口里第一段连提问都没有。
 */
export function snapshotDigests(messages: readonly UiMessage[], windowStart: number, k: number): UiExchangeDigest[] {
	if (windowStart <= 0 || windowStart >= messages.length || k <= 0) return [];
	const heads = exchangeHeads(messages);
	const hi = lowerBound(heads, windowStart);
	const inWindow = heads.length - hi;
	const straddles = hi > 0 && !isBoundary(messages[windowStart]);
	const need = Math.max(k - inWindow, straddles ? 1 : 0);
	return need > 0 ? digestsBefore(messages, windowStart, { count: need }, heads) : [];
}

/** 窗口起点落在一轮中间时，这一轮开头那一截的摘要（partial，随 older_messages 发）；否则 undefined。 */
export function straddleDigest(messages: readonly UiMessage[], start: number): UiExchangeDigest | undefined {
	if (start <= 0 || start >= messages.length || isBoundary(messages[start])) return undefined;
	const heads = exchangeHeads(messages);
	if (lowerBound(heads, start) === 0) return undefined;
	return digestsBefore(messages, start, { count: 1 }, heads)[0];
}
