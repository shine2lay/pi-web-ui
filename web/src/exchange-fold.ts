/**
 * exchange-fold（fork 补丁）：把每一轮对话里 agent 的中间步骤折成一行。
 *
 * 一轮（exchange）= 一条用户提问（或用户自己跑的 `!` 命令）到下一条之间的所有消息。
 * 折叠时，agent 在这中间做的事——思考、工具调用及其结果、步骤之间顺手写的话、
 * 运行中插进来的提醒/压缩摘要——全部收进一行摘要：
 *
 *     ▸ 23 turns · 11 thinking · 31 tool calls · 4m 10s
 *
 * 只留下回答（只显示文字），一眼看到「我问了什么、它答了什么」。
 * agent 还在跑时这一行是直播行：计数实时增长，下面一行显示当前步骤；
 * 回答写出来时照常流式出现在行下方。点这一行展开 = 和以前一样的完整视图。
 *
 * 这里只有纯逻辑（不碰 React），MessageList 用它决定每条消息画不画、怎么画。
 */
import type { UiMessage, UiToolCallBlock } from "./types";

export type FoldStatus = "done" | "working" | "error" | "aborted";

/** 一轮对话折叠后的摘要。 */
export interface ExchangeFold {
	/** 稳定键：这一轮第一条消息的 id（通常是用户的提问）。 */
	key: string;
	/** 折叠行画在这条消息之前（正文的第一条：隐藏成员或回答）。
	 *  undefined = 正文还没有任何已持久化的消息（刚发出，第一轮还在生成）→ 行画在已持久化消息的末尾。 */
	rowBefore?: string;
	/** 折叠时隐藏的消息 id（按消息顺序）。 */
	hidden: string[];
	/** 折叠时照常显示、但只显示文字的消息：回答；以错误收尾时最后一条也在（错误信息和重试按钮挂在它上面）。 */
	answers: string[];
	/** 最后一条已持久化的助手消息（直播行在两轮之间从它找正在跑的工具）。 */
	lastAssistant?: UiMessage;
	/** agent 轮数（已持久化的助手消息条数；直播行另加正在生成的那条）。 */
	turns: number;
	/** 思考块数。 */
	thinking: number;
	/** 工具调用块数。 */
	toolCalls: number;
	/** 起点：提问的时间戳；分页窗口从一轮中间开始时是第一条已载入消息的。 */
	startTs?: number;
	/** 这一轮已持久化消息里最晚的时间戳（助手消息记的是开始生成的时刻，所以不含最后一轮的生成时间）。 */
	endTs?: number;
	/** agent 正在跑的那一轮。 */
	live: boolean;
	status: FoldStatus;
}

/** 消息在折叠时的去向。不在表里 = 不归任何折叠管（提问、附件、收尾后的消息……），照常显示。 */
export type FoldRole = "hidden" | "answer";

export interface FoldPlan {
	/** 按消息顺序。 */
	folds: ExchangeFold[];
	/** 消息 id → 它所属的折叠（隐藏成员与回答）。 */
	byMsg: Map<string, ExchangeFold>;
	/** 消息 id → 折叠时的去向。 */
	role: Map<string, FoldRole>;
	/** 折叠行锚点：消息 id → 画在它之前的折叠行。 */
	rowBefore: Map<string, ExchangeFold>;
	/** 正文还空着的直播轮：行画在已持久化消息的末尾（流式消息之前）。 */
	tailRow?: ExchangeFold;
}

export interface PlanOptions {
	/** agent 正在跑（UiState.isStreaming）。 */
	live: boolean;
	/** 此刻有正在流式生成的助手消息（UiState.streamingMessage 非空）。 */
	streaming: boolean;
	/** 窗口之前那一截（exchange-digest 的 partial 摘要）。分页窗口从一轮中间开始时，
	 *  这一轮的提问和前面的步骤不在消息列表里。给了它，开头那段（没有提问的那段）
	 *  就接上它：键和起始时间用它的，计数加上它的。 */
	lead?: FoldLead;
}

/** 见 PlanOptions.lead。 */
export interface FoldLead {
	/** 这一轮提问的 id——载入以后真正的折叠也是这个键，展开状态接得上。 */
	key: string;
	turns: number;
	thinking: number;
	toolCalls: number;
	startTs?: number;
}

/** 一轮的边界：用户提问，或用户自己跑的 `!` 命令。 */
function isBoundary(m: UiMessage): boolean {
	return m.role === "user" || m.role === "bashExecution";
}

/** 提问后紧跟的附件（custom "file"）属于提问本身，不折。 */
function isAttachment(m: UiMessage): boolean {
	return m.role === "custom" && m.customType === "file";
}

/** 有非空白的文字块。 */
export function hasVisibleText(m: UiMessage): boolean {
	return m.content.some((b) => b.type === "text" && typeof b.text === "string" && b.text.trim() !== "");
}

export function hasToolCall(m: UiMessage): boolean {
	return m.content.some((b) => b.type === "toolCall");
}

/** 只显示文字时会被拿掉的块（它们计入折叠行）。 */
function isStepBlock(b: { type: string }): boolean {
	return b.type === "thinking" || b.type === "toolCall";
}

/** 一条消息里的思考块、工具调用块数。 */
export function countSteps(m: UiMessage): { thinking: number; toolCalls: number } {
	let thinking = 0;
	let toolCalls = 0;
	for (const b of m.content) {
		if (b.type === "thinking") thinking++;
		else if (b.type === "toolCall") toolCalls++;
	}
	return { thinking, toolCalls };
}

/** 只显示文字的版本按原消息对象缓存：Message 是 memo 组件，引用稳定才不会每帧重画 Markdown。 */
const textOnlyCache = new WeakMap<UiMessage, UiMessage>();

/** 回答的只显示文字版本：去掉思考和工具调用，其余（文字、图片……）原样保留。 */
export function textOnly(m: UiMessage): UiMessage {
	if (!m.content.some(isStepBlock)) return m;
	let v = textOnlyCache.get(m);
	if (!v) {
		v = { ...m, content: m.content.filter((b) => !isStepBlock(b)) };
		textOnlyCache.set(m, v);
	}
	return v;
}

/**
 * 把消息列表切成一轮一轮，算出每一轮的折叠方案。
 *
 * 规则（结束了的一轮）：
 * - 提问、以及紧跟在提问后的附件照常显示。
 * - 回答 = 最后一条有文字的助手消息（最后一轮常常只剩一句空话或一次收尾的工具调用，
 *   真正的回答在前一轮）；只显示文字。
 * - 以错误收尾（stopReason error / 带 errorMessage）时，最后一条助手消息也显示。
 * - 从提问到最后一条助手消息之间的其它消息全部隐藏；工具结果本来就画在工具卡里，也算隐藏。
 * - 最后一条助手消息之后的非助手消息（目标评审、手动压缩摘要……）不是这一轮的过程，照常显示。
 * - 没有可折的东西（只有一条纯文字回答）就不出折叠行。
 *
 * 最后一轮在 agent 跑着时是直播轮，除非它已经写完了回答（最后一条是不带工具调用的助手消息、
 * 且没有流式消息）——agent_end 到达前的那一瞬、以及刚发出新提问还没进列表的那一瞬，
 * 都不该让上一轮闪成「进行中」。
 * 直播轮的正文全部隐藏；没有流式消息、且最后一条已完成的助手消息只有文字时，它就是刚写完的回答。
 * 流式消息本身由调用方决定画不画（有文字且还没开始调工具 → 当回答画）。
 */
export function planExchangeFolds(messages: readonly UiMessage[], opts: PlanOptions): FoldPlan {
	const plan: FoldPlan = { folds: [], byMsg: new Map(), role: new Map(), rowBefore: new Map() };
	const segs: Array<[number, number]> = [];
	let start = 0;
	for (let i = 1; i <= messages.length; i++) {
		if (i === messages.length || isBoundary(messages[i])) {
			if (i > start) segs.push([start, i]);
			start = i;
		}
	}
	for (let s = 0; s < segs.length; s++) {
		const [a, b] = segs[s];
		const fold = planSegment(messages, a, b, s === segs.length - 1, opts, s === 0 ? opts.lead : undefined);
		if (!fold) continue;
		plan.folds.push(fold);
		for (const id of fold.hidden) {
			plan.byMsg.set(id, fold);
			plan.role.set(id, "hidden");
		}
		for (const id of fold.answers) {
			plan.byMsg.set(id, fold);
			plan.role.set(id, "answer");
		}
		if (fold.rowBefore) plan.rowBefore.set(fold.rowBefore, fold);
		else plan.tailRow = fold;
	}
	return plan;
}

function planSegment(
	messages: readonly UiMessage[],
	a: number,
	b: number,
	lastSegment: boolean,
	opts: PlanOptions,
	lead?: FoldLead,
): ExchangeFold | null {
	const head = isBoundary(messages[a]) ? messages[a] : undefined;
	// 窗口之前那一截只接在没有提问的开头那段上。
	const leadIn = head ? undefined : lead;
	let bodyStart = head ? a + 1 : a;
	if (head?.role === "user") {
		while (bodyStart < b && isAttachment(messages[bodyStart])) bodyStart++;
	}

	let lastAsst = -1;
	let turns = leadIn?.turns ?? 0;
	let thinking = leadIn?.thinking ?? 0;
	let toolCalls = leadIn?.toolCalls ?? 0;
	const leadSteps = !!leadIn && leadIn.turns > 0;
	let endTs: number | undefined;
	for (let i = bodyStart; i < b; i++) {
		const m = messages[i];
		if (typeof m.timestamp === "number" && (endTs === undefined || m.timestamp > endTs)) endTs = m.timestamp;
		if (m.role !== "assistant") continue;
		lastAsst = i;
		turns++;
		const c = countSteps(m);
		thinking += c.thinking;
		toolCalls += c.toolCalls;
	}

	const lastBody = b - 1 >= bodyStart ? messages[b - 1] : undefined;
	const answered = !!lastBody && lastBody.role === "assistant" && !hasToolCall(lastBody);
	const live = lastSegment && opts.live && (opts.streaming || !answered);

	const hidden: string[] = [];
	const answerIdx: number[] = [];
	let status: FoldStatus;
	if (live) {
		status = "working";
		if (!opts.streaming && lastAsst >= 0) {
			const last = messages[lastAsst];
			if (hasVisibleText(last) && !hasToolCall(last)) answerIdx.push(lastAsst);
		}
		for (let i = bodyStart; i < b; i++) {
			if (!answerIdx.includes(i)) hidden.push(messages[i].id);
		}
	} else {
		// 接在窗口之前那一截后面时，哪怕窗口里这段没什么可折，也要有这一行：前面的步骤靠它取。
		if (lastAsst < 0 && !leadSteps) return null;
		const last = lastAsst >= 0 ? messages[lastAsst] : undefined;
		status = last?.stopReason === "error" ? "error" : last?.stopReason === "aborted" ? "aborted" : "done";
		if (last) {
			for (let i = lastAsst; i >= bodyStart; i--) {
				if (messages[i].role === "assistant" && hasVisibleText(messages[i])) {
					answerIdx.push(i);
					break;
				}
			}
			if (answerIdx[0] !== lastAsst && (status === "error" || !!last.errorMessage)) answerIdx.push(lastAsst);
		}
		for (let i = bodyStart; i < b; i++) {
			if (answerIdx.includes(i)) continue;
			if (i <= lastAsst || messages[i].role === "toolResult") hidden.push(messages[i].id);
		}
		const answerHasSteps = answerIdx.some((i) => messages[i].content.some(isStepBlock));
		if (hidden.length === 0 && !answerHasSteps && !leadSteps) return null;
	}

	return {
		key: leadIn ? leadIn.key : messages[a].id,
		rowBefore: bodyStart < b ? messages[bodyStart].id : undefined,
		hidden,
		answers: answerIdx.map((i) => messages[i].id),
		lastAssistant: lastAsst >= 0 ? messages[lastAsst] : undefined,
		turns,
		thinking,
		toolCalls,
		startTs: leadIn ? leadIn.startTs : messages[a].timestamp,
		endTs,
		live,
		status,
	};
}

/** 直播行「当前步骤」。 */
export type LiveStep =
	| { kind: "tool"; name: string; argumentsText?: string }
	| { kind: "thinking" }
	| { kind: "writing" }
	| { kind: "waiting" };

function toolStep(b: UiToolCallBlock): LiveStep {
	return { kind: "tool", name: b.name, argumentsText: b.argumentsText };
}

/**
 * 正在流式生成时看它的最后一块（思考 / 写字 / 正在写的工具调用）；
 * 两轮之间看最后一条助手消息里还没跑完的工具（finished = 已有结果或已收到结束状态）；
 * 都没有就是在等模型。
 */
export function liveStep(
	streaming: UiMessage | null | undefined,
	lastAssistant: UiMessage | undefined,
	finished: (toolCallId: string) => boolean,
): LiveStep {
	if (streaming) {
		const last = streaming.content[streaming.content.length - 1];
		if (!last) return { kind: "waiting" };
		if (last.type === "thinking") return { kind: "thinking" };
		if (last.type === "toolCall") return toolStep(last as UiToolCallBlock);
		return { kind: "writing" };
	}
	for (const b of lastAssistant?.content ?? []) {
		if (b.type === "toolCall" && !finished((b as UiToolCallBlock).id)) return toolStep(b as UiToolCallBlock);
	}
	return { kind: "waiting" };
}

/** 折叠行的耗时："45s" / "4m 10s" / "1h 05m"（直播时每秒刷新，不带小数）。 */
export function formatSpan(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
