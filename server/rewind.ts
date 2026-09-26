/**
 * 「回到这里」与「对话太大」卡片（rewind-to-here）。
 *
 * 对话一旦大过 provider 的请求上限（Anthropic 32 MB，多半是一堆截图），每次请求都 413，
 * 自动压缩又被上下文插件取消，对话就卡死了。解法是 pi 自己的 /tree：把会话叶子挪回某条
 * 消息（navigateTree + summarize），跳过的那段在原文件里原样留着（只是另一条分支），
 * 并在新位置加一条简短的自动摘要。这里是纯函数部分：
 *
 * - contextItems：当前分支上发给模型的消息，每条带它所在的会话条目 id；
 * - planRewind：回到某条消息时，navigateTree 该去哪个条目、保留多少条；
 *   · 用户消息：从它之前继续，这条的文字放回输入框（pi 的 navigateTree 就是这么做的）；
 *   · 带工具调用的助手消息：连同紧跟其后的工具结果一起保留（气泡里看到的是一整块）；
 * - sizeOf：一组消息按 JSON 算的字节数和图片数（图片是 base64，JSON 大小≈请求大小）；
 * - suggestRewindIndex：「对话太大」卡片的按钮回到哪条：保留部分 ≤ 24 MB 的最新一条，
 *   优先完整回复的结尾（不带工具调用的助手消息），其次任务中途，最后才是用户消息；
 * - tooBigKind：哪些报错算「太大」。
 */

import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { UiTooBig } from "./protocol.js";
import type { AgentMessage } from "./serialize.js";

/** Anthropic 的请求体上限（32 MB）。卡片里说的「上限」。 */
export const REQUEST_LIMIT_BYTES = 32 * 1024 * 1024;
/** 卡片按钮回到的位置：保留部分不超过它，给之后的新消息和截图留出余量。 */
export const REWIND_FIT_BYTES = 24 * 1024 * 1024;

/** 会话条目里和这里有关的部分（SessionEntry 的子集，测试好造）。 */
export interface EntryLike {
	type: string;
	id: string;
	parentId?: string | null;
	[k: string]: unknown;
}

export interface ContextItem {
	entryId: string;
	message: AgentMessage;
}

/** 当前分支（buildContextEntries 的结果）上发给模型的消息，按顺序，每条带条目 id。 */
export function contextItems(entries: readonly EntryLike[]): ContextItem[] {
	const out: ContextItem[] = [];
	for (const entry of entries) {
		let msgs: AgentMessage[];
		try {
			msgs = sessionEntryToContextMessages(entry as never) as AgentMessage[];
		} catch {
			continue;
		}
		for (const message of msgs) out.push({ entryId: entry.id, message });
	}
	return out;
}

export interface SizeCount {
	bytes: number;
	images: number;
}

function countImages(value: unknown): number {
	if (Array.isArray(value)) {
		let n = 0;
		for (const v of value) n += countImages(v);
		return n;
	}
	if (!value || typeof value !== "object") return 0;
	const o = value as Record<string, unknown>;
	if (o.type === "image" || o.type === "image_url" || o.type === "input_image") return 1;
	let n = 0;
	for (const v of Object.values(o)) if (v && typeof v === "object") n += countImages(v);
	return n;
}

/** 一条消息的 JSON 字节数与图片数。 */
export function messageSize(m: unknown): SizeCount {
	let bytes = 0;
	try {
		bytes = Buffer.byteLength(JSON.stringify(m) ?? "", "utf8");
	} catch {
		bytes = 0;
	}
	return { bytes, images: countImages(m) };
}

/** 一组消息的 JSON 字节数与图片数。 */
export function sizeOf(messages: readonly unknown[]): SizeCount {
	let bytes = 0;
	let images = 0;
	for (const m of messages) {
		const s = messageSize(m);
		bytes += s.bytes;
		images += s.images;
	}
	return { bytes, images };
}

function roleOf(m: AgentMessage): string {
	return (m as { role?: string }).role ?? "";
}

function toolCallIds(m: AgentMessage): Set<string> {
	const ids = new Set<string>();
	const content = (m as { content?: unknown }).content;
	if (!Array.isArray(content)) return ids;
	for (const b of content) {
		const block = b as { type?: string; id?: string };
		if (block?.type === "toolCall" && typeof block.id === "string") ids.add(block.id);
	}
	return ids;
}

function textOf(m: AgentMessage): string {
	const content = (m as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b) => {
			const block = b as { type?: string; text?: string };
			return block?.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

export interface RewindPlan {
	/** 用户点的那条在 items 里的下标。 */
	index: number;
	/** 传给 navigateTree 的条目 id。 */
	navigateEntryId: string;
	/** 回退后还发给模型的条数：items[0 .. keepCount-1]。 */
	keepCount: number;
	/** 点的是用户消息（或 pi 当作输入处理的自定义消息）：它本身也不保留，文字回到输入框。 */
	toComposer: boolean;
	/** 放回输入框的文字（toComposer 时）。 */
	editorText?: string;
}

/** 回到 items[index] 时 navigateTree 去哪、保留多少（与 pi navigateTree 的语义一致）。 */
export function planRewind(items: readonly ContextItem[], index: number): RewindPlan | null {
	const item = items[index];
	if (!item) return null;
	const role = roleOf(item.message);
	if (role === "user" || role === "custom") {
		// pi：用户消息 / 自定义消息 → 叶子挪到它的父条目，文字进输入框。
		return {
			index,
			navigateEntryId: item.entryId,
			keepCount: index,
			toComposer: true,
			editorText: textOf(item.message),
		};
	}
	let last = index;
	if (role === "assistant") {
		const calls = toolCallIds(item.message);
		if (calls.size > 0) {
			// 连同这条消息自己的工具结果一起保留：否则工具调用没有结果，模型那边只看到占位。
			for (let j = index + 1; j < items.length; j++) {
				const m = items[j].message as { role?: string; toolCallId?: string };
				if (m.role !== "toolResult" || !m.toolCallId || !calls.has(m.toolCallId)) break;
				last = j;
			}
		}
	}
	return { index, navigateEntryId: items[last].entryId, keepCount: last + 1, toComposer: false };
}

/** 跳过的部分里有几条对话消息（用户 + 助手；工具结果算在助手气泡里）。 */
export function droppedMessageCount(items: readonly ContextItem[], keepCount: number): number {
	let n = 0;
	for (let i = keepCount; i < items.length; i++) {
		const r = roleOf(items[i].message);
		if (r === "user" || r === "assistant") n++;
	}
	return n;
}

/** 「一次完整回复的结尾」：不带工具调用、也不是报错的助手消息。 */
function isReplyEnd(m: AgentMessage): boolean {
	if (roleOf(m) !== "assistant") return false;
	const stop = (m as { stopReason?: string }).stopReason;
	if (stop === "error" || stop === "aborted") return false;
	return toolCallIds(m).size === 0;
}

/**
 * 「对话太大」卡片的按钮回到哪条（items 下标）：保留部分（按当前分支累计）≤ fitBytes 的最新一条，
 * 且确实会跳过点东西。优先完整回复的结尾，其次带工具调用的助手消息（连同结果），最后用户消息。
 * 一条都不行（开头第一条就超了）→ null。
 */
export function suggestRewindIndex(items: readonly ContextItem[], fitBytes = REWIND_FIT_BYTES): number | null {
	const prefix: number[] = [0];
	for (const it of items) prefix.push(prefix[prefix.length - 1] + messageSize(it.message).bytes);
	const tiers: Array<(m: AgentMessage) => boolean> = [
		isReplyEnd,
		(m) => roleOf(m) === "assistant" && (m as { stopReason?: string }).stopReason !== "error",
		(m) => roleOf(m) === "user",
	];
	for (const accept of tiers) {
		for (let i = items.length - 1; i >= 0; i--) {
			if (!accept(items[i].message)) continue;
			const plan = planRewind(items, i);
			if (!plan || plan.keepCount >= items.length) continue;
			if (prefix[plan.keepCount] <= fitBytes) return i;
		}
	}
	return null;
}

/**
 * 这条报错是不是「对话太大发不出去」：
 * - "bytes"：请求体超过上限（Anthropic 413 request_too_large）；
 * - "tokens"：超过模型的上下文窗口（prompt is too long 等）。
 * 都不是 → null。
 */
export function tooBigKind(errorText: string | undefined | null): "bytes" | "tokens" | null {
	if (!errorText) return null;
	if (
		/request_too_large|request exceeds the maximum size|payload too large|\b413\b[^\n]*(too large|exceed)/i.test(
			errorText,
		)
	)
		return "bytes";
	if (
		/prompt is too long|exceeds the context window|maximum context length|context[_ ]length[_ ]exceeded|input is too long for requested model/i.test(
			errorText,
		)
	)
		return "tokens";
	return null;
}

const PREFIX_ROLE: Record<string, string> = {
	a: "assistant",
	c: "custom",
	b: "bashExecution",
	bs: "branchSummary",
	cs: "compactionSummary",
};

/**
 * 气泡 id（serialize.ts 给的 UiMessage.id）→ items 里的下标。
 * - `u-<ts>-<seq>`：同一时间戳的第 seq 条用户消息（与 resolveUserMessageEntryId 同口径）；
 * - `t-<toolCallId>`：工具结果；
 * - `a|c|b|bs|cs-<ts>-<n>`：角色 + 时间戳；同一毫秒有好几条时用 nOf（对话的消息序号表）对 n。
 * 找不到（流式中的 `stream-*`、别的分支上的、已经被压缩掉的）→ null。
 */
export function findItemIndex(
	items: readonly ContextItem[],
	messageId: string,
	nOf?: (m: AgentMessage) => number | undefined,
): number | null {
	const tool = /^t-(.+)$/.exec(messageId);
	if (tool) {
		const i = items.findIndex(
			(it) => roleOf(it.message) === "toolResult" && (it.message as { toolCallId?: string }).toolCallId === tool[1],
		);
		return i >= 0 ? i : null;
	}
	const user = /^u-(\d+)(?:-(\d+))?$/.exec(messageId);
	if (user) {
		const ts = Number(user[1]);
		const seq = user[2] ? Number(user[2]) : 1;
		let count = 0;
		for (let i = 0; i < items.length; i++) {
			const m = items[i].message as { role?: string; timestamp?: number };
			if (m.role !== "user" || m.timestamp !== ts) continue;
			count += 1;
			if (count === seq) return i;
		}
		return null;
	}
	const other = /^(bs|cs|a|c|b)-(\d+)-(\d+)$/.exec(messageId);
	if (!other) return null;
	const role = PREFIX_ROLE[other[1]];
	const ts = Number(other[2]);
	const n = Number(other[3]);
	const candidates: number[] = [];
	for (let i = 0; i < items.length; i++) {
		const m = items[i].message as { role?: string; timestamp?: number };
		if (m.role === role && m.timestamp === ts) candidates.push(i);
	}
	if (candidates.length === 1) return candidates[0];
	if (candidates.length === 0 || !nOf) return null;
	for (const i of candidates) if (nOf(items[i].message) === n) return i;
	return null;
}

/** 消息开头一小段文字（卡片里说「回到：…」用）。 */
export function snippetOf(m: AgentMessage, max = 80): string {
	const text = textOf(m).replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * 「对话太大」卡片的数据：当前分支多大、几张图、按钮回到哪条。
 * items = 当前分支的消息（contextItems(buildContextEntries())）。
 */
export function measureTooBig(
	items: readonly ContextItem[],
	kind: "bytes" | "tokens",
	errorText: string,
	opts: { contextWindow?: number; now?: number; fitBytes?: number } = {},
): UiTooBig {
	const total = sizeOf(items.map((it) => it.message));
	const idx = suggestRewindIndex(items, opts.fitBytes ?? REWIND_FIT_BYTES);
	let suggest: UiTooBig["suggest"] = null;
	if (idx !== null) {
		const plan = planRewind(items, idx);
		if (plan) {
			const kept = sizeOf(items.slice(0, plan.keepCount).map((it) => it.message));
			const m = items[idx].message as { role?: string; timestamp?: number };
			suggest = {
				role: m.role ?? "",
				text: snippetOf(items[idx].message),
				timestamp: m.timestamp,
				dropCount: droppedMessageCount(items, plan.keepCount),
				keepBytes: kept.bytes,
				keepImages: kept.images,
			};
		}
	}
	return {
		kind,
		bytes: total.bytes,
		images: total.images,
		limitBytes: REQUEST_LIMIT_BYTES,
		...(opts.contextWindow ? { contextWindow: opts.contextWindow } : {}),
		errorText,
		suggest,
		at: opts.now ?? Date.now(),
	};
}

/** 字节 → 「42.1 MB」这样的短文字（卡片、确认框用）。 */
export function formatMb(bytes: number): string {
	const mb = bytes / (1024 * 1024);
	return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}
