/**
 * 消息窗口合并（chat-window-pagination）。
 *
 * 服务端快照只带最新一截消息（UiState.messagesStart = 窗口起点），更老的由
 * load_older 按需取回。这里是两条合并规则的唯一实现，reducer 直接调：
 *
 *   - older_messages 到达 → 拼在窗口**前面**，起点前移；
 *   - snapshot_delta 到达 → 只往后追加，所以窗口起点**不变**，
 *     提问索引没重发就沿用上一份。
 *
 * 不变量：窗口永远贴着末尾，所以完整长度恒等于 messagesStart + messages.length
 * （服务端因此不发 total，见 server/protocol.ts 的 messagesStart 注释）。
 */

import type { UiMessage, UiQuestionRef, UiState } from "./types";

/** older_messages 的回执内容（只取合并要用的字段）。 */
export interface OlderMessagesMsg {
	conversationId: string;
	start: number;
	messages: UiMessage[];
}

/**
 * 把一截历史消息拼在窗口前面。返回 null = 这条回执作废，状态不动：
 *   - 切了对话（conversationId 对不上）——迟到的回执不能污染新对话；
 *   - 不是紧挨着当前窗口（start + length !== 当前起点）——接不上就会留空洞，
 *     宁可不合并，用户再点一次即可；
 *   - 已经加载过（start >= 当前起点）——重复回执。
 */
export function prependOlderMessages(ui: UiState, m: OlderMessagesMsg): UiState | null {
	if (ui.conversationId !== m.conversationId) return null;
	const curStart = ui.messagesStart ?? 0;
	if (m.messages.length === 0) return null;
	if (m.start >= curStart) return null;
	if (m.start + m.messages.length !== curStart) return null;
	return { ...ui, messages: [...m.messages, ...ui.messages], messagesStart: m.start };
}

/**
 * snapshot_delta 之后的分页字段。delta 只往末尾追加：
 *   - 窗口起点不变（服务端压根不在 delta 里发它）；
 *   - 提问索引只在真多了提问时重发，缺省沿用上一份（流式期间每 60ms 一条
 *     delta，十几 KB 的索引跟着走就是纯浪费）。
 */
export function paginationAfterDelta(
	ui: Pick<UiState, "messagesStart" | "questionIndex">,
	deltaState: Pick<UiState, "questionIndex">,
): { messagesStart?: number; questionIndex?: UiQuestionRef[] } {
	return {
		messagesStart: ui.messagesStart,
		questionIndex: deltaState.questionIndex ?? ui.questionIndex,
	};
}
