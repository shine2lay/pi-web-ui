/**
 * 消息窗口合并（chat-window-pagination）。
 *
 * 服务端快照只带最新一截消息（UiState.messagesStart = 窗口起点），更老的由
 * load_older 按需取回。这里是三条合并规则的唯一实现，reducer 直接调：
 *
 *   - older_messages 到达 → 拼在窗口**前面**，起点前移；
 *   - snapshot_delta 到达 → 只往后追加，所以窗口起点**不变**，
 *     提问索引没重发就沿用上一份；
 *   - 整份 snapshot 到达 → 同一会话且接得上时，已加载的更早历史**保留**。
 *
 * 不变量：窗口永远贴着末尾，所以完整长度恒等于 messagesStart + messages.length
 * （服务端因此不发 total，见 server/protocol.ts 的 messagesStart 注释）。
 *
 * 窗口之前还有一串摘要（exchange-digest，UiState.exchanges）：最近几轮的提问 + 回答 +
 * 折叠行计数。它的不变量见 chainDigests。
 */

import type { UiExchangeDigest, UiMessage, UiQuestionRef, UiState } from "./types";

/** older_messages 的回执内容（只取合并要用的字段）。 */
export interface OlderMessagesMsg {
	conversationId: string;
	start: number;
	messages: UiMessage[];
	/** 新起点落在一轮中间时，这一轮开头那一截的摘要。 */
	straddle?: UiExchangeDigest;
}

/** older_exchanges 的回执内容。 */
export interface OlderExchangesMsg {
	conversationId: string;
	beforeIndex: number;
	exchanges: UiExchangeDigest[];
}

/**
 * 摘要链规整（exchange-digest）：只留窗口之前、首尾相接、最新一份正好接到窗口起点的那一串。
 *
 *   - 覆盖到窗口里的（index >= start 或 end > start）不要：那一段已经是真消息，
 *     计数再算一遍就重了；
 *   - 同一轮有两份时取排在后面的（调用方把新鲜的放后面）；
 *   - 从最新的往前走，每一份都得正好接到后一份的开头（最新的接到 start），接不上的地方
 *     往前一律丢掉——宁可让用户再点一次「显示更早的对话」，也不拼出一段有洞的历史。
 */
export function chainDigests(list: readonly UiExchangeDigest[], start: number): UiExchangeDigest[] {
	const byIndex = new Map<number, UiExchangeDigest>();
	for (const d of list) if (d.index < start && d.end <= start) byIndex.set(d.index, d);
	const sorted = [...byIndex.values()].sort((a, b) => a.index - b.index);
	const out: UiExchangeDigest[] = [];
	let expect = start;
	for (let i = sorted.length - 1; i >= 0; i--) {
		if (sorted[i].end !== expect) break;
		out.push(sorted[i]);
		expect = sorted[i].index;
	}
	return out.reverse();
}

/**
 * 往前拼几轮摘要（「显示更早的对话」/ 导航跳转）。返回 null = 这条回执作废，状态不动：
 * 切了对话、服务端不发摘要、接不到客户端最老的一份上（重复/迟到的回执）、或者没带来新的。
 */
export function prependOlderExchanges(ui: UiState, m: OlderExchangesMsg): UiState | null {
	if (ui.conversationId !== m.conversationId || !ui.exchanges || m.exchanges.length === 0) return null;
	const start = ui.messagesStart ?? 0;
	if (m.beforeIndex !== (ui.exchanges[0]?.index ?? start)) return null;
	const next = chainDigests([...m.exchanges, ...ui.exchanges], start);
	return next.length > ui.exchanges.length ? { ...ui, exchanges: next } : null;
}

/** 完整列表下标 i 那一条的 id：已载入的消息，或某份摘要的提问。不知道 = undefined。 */
function idAt(ui: UiState, i: number): string | undefined {
	const start = ui.messagesStart ?? 0;
	if (i >= start) return ui.messages[i - start]?.id;
	return ui.exchanges?.find((d) => d.index === i)?.head[0]?.id;
}

/**
 * 整份快照到达时，把用户多取的更早几轮摘要留下来（和 keepLoadedHistory 同一个道理：重连、
 * resync 不该把用户点出来的东西冲掉）。只在接缝处那一条的 id 对得上时才接：同一下标
 * 同一条 = 从头到这里是同一条分支，更早的摘要还成立。
 */
function keepLoadedDigests(prev: UiState, merged: UiState): UiState {
	if (!merged.exchanges) return merged;
	const start = merged.messagesStart ?? 0;
	const fresh = chainDigests(merged.exchanges, start);
	const seamIndex = fresh[0]?.index ?? start;
	const seamId = fresh.length > 0 ? fresh[0].head[0]?.id : merged.messages[0]?.id;
	const older = (prev.exchanges ?? []).filter((d) => d.index < seamIndex);
	if (older.length === 0 || !seamId || idAt(prev, seamIndex) !== seamId) return { ...merged, exchanges: fresh };
	return { ...merged, exchanges: chainDigests([...older, ...fresh], start) };
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
	// 摘要：载入的这一段覆盖到的丢掉，新起点落在一轮中间时换上这一轮开头那一截。
	const exchanges = ui.exchanges && chainDigests(m.straddle ? [...ui.exchanges, m.straddle] : ui.exchanges, m.start);
	return {
		...ui,
		messages: [...m.messages, ...ui.messages],
		messagesStart: m.start,
		...(exchanges ? { exchanges } : {}),
	};
}

/**
 * 整份快照到达时，把用户已经加载的更早历史留下来（load-older-survives-snapshot）。
 *
 * 整份快照只带最新一截（messagesStart = 窗口起点）。如果原样替换，用户点
 * 「加载更早消息」拿到的历史就会被冲掉——而整份快照并不罕见：重连、rev/seq
 * 出缺口后的 get_state、同一客户端的另一个标签页重连都会触发。
 *
 * 只在能证明历史没被改写时才拼：同一对话、同一会话（同一对话槽可能换了
 * 会话）、客户端手里的消息一直连到快照窗口的第一条、且那一条的 id 对得上
 * （压缩/分叉会让同一下标上换成别的消息）。任何一条不满足就原样采用快照——
 * 宁可让用户再点一次，也不拼出一段错的历史。
 */
export function keepLoadedHistory(prev: UiState | null | undefined, next: UiState): UiState {
	if (!prev || prev.conversationId !== next.conversationId || prev.sessionId !== next.sessionId) return next;
	const prevStart = prev.messagesStart ?? 0;
	const nextStart = next.messagesStart ?? 0;
	// 没有比快照更早的消息可保留（摘要另算）。
	if (prevStart >= nextStart) return keepLoadedDigests(prev, next);
	// 快照窗口第一条在客户端数组里的下标。超出 = 客户端的消息连不到快照（中间有洞）。
	const offset = nextStart - prevStart;
	const first = next.messages[0];
	if (!first || offset >= prev.messages.length || prev.messages[offset]?.id !== first.id)
		return keepLoadedDigests(prev, next);
	return keepLoadedDigests(prev, {
		...next,
		messages: [...prev.messages.slice(0, offset), ...next.messages],
		messagesStart: prevStart,
	});
}

/**
 * snapshot_delta 之后的分页字段。delta 只往末尾追加：
 *   - 窗口起点不变（服务端压根不在 delta 里发它）；
 *   - 提问索引只在真多了提问时重发，缺省沿用上一份（流式期间每 60ms 一条
 *     delta，十几 KB 的索引跟着走就是纯浪费）。
 */
export function paginationAfterDelta(
	ui: Pick<UiState, "messagesStart" | "questionIndex" | "exchanges">,
	deltaState: Pick<UiState, "questionIndex">,
): { messagesStart?: number; questionIndex?: UiQuestionRef[]; exchanges?: UiExchangeDigest[] } {
	return {
		messagesStart: ui.messagesStart,
		questionIndex: deltaState.questionIndex ?? ui.questionIndex,
		// 摘要只随整份快照变（窗口前面的历史不动）。
		exchanges: ui.exchanges,
	};
}
