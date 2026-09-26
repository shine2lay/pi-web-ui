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
 *
 * 用户在 tab 里折叠 / 重新展开的行（tldr-collapse）也存在会话里，是 pi-web-ui 自己的条目：
 *
 *   { type: "custom", customType: "pi-web-ui/tldr-collapse", data: { v: 1, ids, collapsed } }
 *
 * 沿分支按顺序重放，最后折叠着的行带 `collapsed: true`。跟行本身一样随会话走：刷新、
 * 重启服务、别的窗口和设备看到的都一样。
 *
 * 左栏（tldr-sidebar）在每条加载着的对话标题下面显示最新的一行，代替「N 条消息」：
 * 见 latestUnseenTldr。
 *
 * needs-you 行之后用户回过话（tldr-answered：发了消息，或在问卷 / 计划批准框里作了答，见
 * isTldrReply），这一行带 `answered: true`：tab 和左栏都不再高亮它。同样是沿分支按顺序算的。
 */

import type { UiTldrLine } from "./protocol.js";

/** pi-tldr 的 customType（与 pi-tldr index.ts 的 ENTRY_TYPE 一致）。 */
export const TLDR_ENTRY_TYPE = "tldr";

/** 最多发多少行：只留最新的。一行约一百字节；agent 几轮才写一行，500 行是好几天的活。 */
export const TLDR_MAX_LINES = 500;

/** 一行的字数上限：工具说明要的是一句话，防一个失控的调用把快照撑大。 */
const TEXT_MAX = 400;

/** 折叠状态条目的 customType（tldr-collapse，pi-web-ui 自己写的）。 */
export const TLDR_COLLAPSE_TYPE = "pi-web-ui/tldr-collapse";

/** 行 id 的长度上限：pi 的条目 id 是 8 位十六进制，这里只防坏数据。 */
const ID_MAX = 64;

/** 一条折叠条目的 data。 */
export interface TldrCollapseData {
	v: 1;
	ids: string[];
	collapsed: boolean;
}

/** 规整折叠条目的 data：写之前（客户端发来的）和读的时候（会话里的）都过一遍。
 *  id 去重、去掉非字符串和超长的，最多 TLDR_MAX_LINES 个（「全部折叠」一次也就这么多）；
 *  一个都不剩或 collapsed 不是布尔就返回 null。 */
export function tldrCollapseData(ids: unknown, collapsed: unknown): TldrCollapseData | null {
	if (!Array.isArray(ids) || typeof collapsed !== "boolean") return null;
	const clean = [
		...new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= ID_MAX)),
	].slice(0, TLDR_MAX_LINES);
	return clean.length > 0 ? { v: 1, ids: clean, collapsed } : null;
}

/** 只用到的会话条目字段（SessionEntry 的子集，测试好造）。 */
export interface TldrEntryLike {
	type: string;
	id?: string;
	customType?: string;
	data?: unknown;
	timestamp?: string;
	/** type "message" 的条目才有（AgentMessage）。 */
	message?: unknown;
}

/** 用户在这两个工具的弹窗里作答也算回话：问卷，和 pi-queue 的任务计划批准框。 */
const REPLY_TOOLS = new Set(["ask_user_question", "queue_add"]);

/** 自动发的「用户消息」开头：定时任务唤醒（server/index.ts、agent-service 无头执行）、pi-queue 交任务和
 *  催办（pi-queue queue.ts）、pi-web-ui 自己的系统提醒（终端没输出、后台命令结束、用户停了 bash）。 */
const AUTOMATED_PREFIXES = ["[定时任务", "[Queue]", "（系统"];

/** 这条会话消息算不算「用户回话了」（tldr-answered）：
 *  - 用户发的消息（文字、只有图都算），自动发的不算（AUTOMATED_PREFIXES）；
 *  - 问卷 / 计划批准框的工具结果，只要不是错误（用户取消问卷回的是错误，不算）。
 *  同项目并行提醒这类是 custom 消息，本来就不是 role "user"。 */
export function isTldrReply(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const m = message as { role?: unknown; content?: unknown; toolName?: unknown; isError?: unknown };
	if (m.role === "toolResult") {
		return typeof m.toolName === "string" && REPLY_TOOLS.has(m.toolName) && m.isError !== true;
	}
	if (m.role !== "user") return false;
	const text =
		typeof m.content === "string"
			? m.content
			: Array.isArray(m.content)
				? m.content
						.map((p) => {
							const part = p as { type?: unknown; text?: unknown } | null;
							return part?.type === "text" && typeof part.text === "string" ? part.text : "";
						})
						.join("")
				: "";
	const head = text.trimStart();
	return !AUTOMATED_PREFIXES.some((p) => head.startsWith(p));
}

/** 分支条目（按根 → 叶的顺序）→ TL;DR 行，按时间升序；只留最新 `max` 行。 */
export function tldrLinesFromEntries(entries: readonly TldrEntryLike[], max = TLDR_MAX_LINES): UiTldrLine[] {
	const out: UiTldrLine[] = [];
	/** 重放到当前为止折叠着的行 id。 */
	const folded = new Set<string>();
	/** 还没等到用户回话的 needs-you 行（tldr-answered）。 */
	const waiting: UiTldrLine[] = [];
	for (const e of entries) {
		if (e.type === "message") {
			if (waiting.length > 0 && isTldrReply(e.message)) {
				for (const l of waiting) l.answered = true;
				waiting.length = 0;
			}
			continue;
		}
		if (e.type !== "custom") continue;
		if (e.customType === TLDR_COLLAPSE_TYPE) {
			const d = (e.data ?? {}) as { ids?: unknown; collapsed?: unknown };
			const c = tldrCollapseData(d.ids, d.collapsed);
			for (const id of c?.ids ?? []) {
				if (c?.collapsed) folded.add(id);
				else folded.delete(id);
			}
			continue;
		}
		if (e.customType !== TLDR_ENTRY_TYPE) continue;
		const d = (e.data ?? {}) as { text?: unknown; needsYou?: unknown; ts?: unknown };
		const text = typeof d.text === "string" ? d.text.trim() : "";
		if (!text || !e.id) continue;
		const ts = typeof d.ts === "number" && Number.isFinite(d.ts) ? d.ts : Date.parse(e.timestamp ?? "") || 0;
		const line: UiTldrLine = {
			id: e.id,
			text: text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}…` : text,
			needsYou: d.needsYou === true,
			ts,
		};
		out.push(line);
		if (line.needsYou) waiting.push(line);
	}
	const kept = out.length > max ? out.slice(out.length - max) : out;
	// 没折叠的行不带 collapsed 字段（快照里每行省几个字节，老客户端也不受影响）。
	return folded.size === 0 ? kept : kept.map((l) => (folded.has(l.id) ? { ...l, collapsed: true } : l));
}

/** 左栏显示的那一行（tldr-sidebar）：只看最新的一行（`lines` 按时间升序，同 tldrLinesFromEntries）。
 *  用户在 TL;DR tab 里把它折叠了（看过了）就没有，左栏回到「N 条消息」；更早的行永远不上左栏。
 *  needs-you 行用户回过话了（answered）：行还在，只是不再高亮。 */
export function latestUnseenTldr(lines: readonly UiTldrLine[]): Pick<UiTldrLine, "text" | "needsYou"> | undefined {
	const last = lines[lines.length - 1];
	return last && !last.collapsed ? { text: last.text, needsYou: last.needsYou && !last.answered } : undefined;
}

/** 这条对话最新的一行正在等用户回话（左栏高亮着）：用户一回话就要马上推左栏。 */
export function latestAwaitingReply(lines: readonly UiTldrLine[]): boolean {
	return latestUnseenTldr(lines)?.needsYou === true;
}
