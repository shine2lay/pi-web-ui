/**
 * TL;DR 行（tldr-panel）。
 *
 * pi-tldr 扩展（~/projects/pi-tldr）给 agent 一个 `tldr` 工具：长任务里每换一件事、
 * 或者出了大事，就写一句大白话进展。每一行存成会话里的自定义条目：
 *
 *   { type: "custom", customType: "tldr", data: { v: 1, text, needsYou, ts } }
 *
 * 右栏的 TL;DR tab 显示的就是**当前分支**上的这些条目（getBranch 从叶子走到根）：
 * - 压缩不影响：压缩只加一条 compaction 条目，老条目还在分支上；
 * - 改写分叉后，被丢下的那条分支上的行不再显示（和消息列表一致）。
 *
 * 条目格式是和 pi-tldr 的约定，这里对坏数据一律跳过，不抛。
 */

import type { UiTldrLine } from "./protocol.js";

/** pi-tldr 的 customType（与 pi-tldr index.ts 的 ENTRY_TYPE 一致）。 */
export const TLDR_ENTRY_TYPE = "tldr";

/** 最多发多少行：只留最新的。一行约一百字节；agent 几轮才写一行，500 行是好几天的活。 */
export const TLDR_MAX_LINES = 500;

/** 一行的字数上限：工具说明要的是一句话，防一个失控的调用把快照撑大。 */
const TEXT_MAX = 400;

/** 只用到的会话条目字段（SessionEntry 的子集，测试好造）。 */
export interface TldrEntryLike {
	type: string;
	id?: string;
	customType?: string;
	data?: unknown;
	timestamp?: string;
}

/** 分支条目（按根 → 叶的顺序）→ TL;DR 行，按时间升序；只留最新 `max` 行。 */
export function tldrLinesFromEntries(entries: readonly TldrEntryLike[], max = TLDR_MAX_LINES): UiTldrLine[] {
	const out: UiTldrLine[] = [];
	for (const e of entries) {
		if (e.type !== "custom" || e.customType !== TLDR_ENTRY_TYPE) continue;
		const d = (e.data ?? {}) as { text?: unknown; needsYou?: unknown; ts?: unknown };
		const text = typeof d.text === "string" ? d.text.trim() : "";
		if (!text || !e.id) continue;
		const ts = typeof d.ts === "number" && Number.isFinite(d.ts) ? d.ts : Date.parse(e.timestamp ?? "") || 0;
		out.push({
			id: e.id,
			text: text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}…` : text,
			needsYou: d.needsYou === true,
			ts,
		});
	}
	return out.length > max ? out.slice(out.length - max) : out;
}
