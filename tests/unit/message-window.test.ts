/**
 * chat-window-pagination —— 客户端窗口合并（web/src/message-window.ts）。
 *
 * 分页最容易出的两类错：历史消息拼歪了（留空洞/重复/串对话），以及流式期间
 * 一条 snapshot_delta 把分页状态冲掉（窗口起点被抹平 → 「载入更早」按钮消失；
 * 提问索引被 undefined 覆盖 → 导轨塌回只剩已加载的提问）。这里把这两类钉死。
 */

import { describe, expect, it } from "vitest";
import { keepLoadedHistory, paginationAfterDelta, prependOlderMessages } from "../../web/src/message-window.js";
import type { UiMessage, UiState } from "../../web/src/types.js";

function msg(id: string): UiMessage {
	return { id, role: "user", content: [{ type: "text", text: id }] } as UiMessage;
}

/** 当前窗口：完整列表 200 条，装着 [100,200)。 */
function uiState(over: Partial<UiState> = {}): UiState {
	return {
		conversationId: "c1",
		messages: [msg("m100"), msg("m101")],
		messagesStart: 100,
		questionIndex: [{ id: "m0", index: 0, text: "第一个问题" }],
		...over,
	} as UiState;
}

describe("prependOlderMessages", () => {
	it("紧挨着窗口的一截拼在前面，起点前移", () => {
		const ui = uiState();
		const next = prependOlderMessages(ui, { conversationId: "c1", start: 98, messages: [msg("m98"), msg("m99")] });
		expect(next).not.toBeNull();
		expect(next!.messages.map((m) => m.id)).toEqual(["m98", "m99", "m100", "m101"]);
		expect(next!.messagesStart).toBe(98);
	});

	it("原状态不被改动（reducer 靠引用变化判定重渲染）", () => {
		const ui = uiState();
		const before = ui.messages;
		prependOlderMessages(ui, { conversationId: "c1", start: 99, messages: [msg("m99")] });
		expect(ui.messages).toBe(before);
		expect(ui.messagesStart).toBe(100);
	});

	it("切了对话的迟到回执作废——不能把别的对话的消息塞进来", () => {
		const ui = uiState();
		expect(prependOlderMessages(ui, { conversationId: "c2", start: 99, messages: [msg("x99")] })).toBeNull();
	});

	it("接不上当前窗口的作废——宁可不合并也不留空洞", () => {
		const ui = uiState();
		// [90,95) 跟 100 之间缺了 95..99。
		expect(prependOlderMessages(ui, { conversationId: "c1", start: 90, messages: [msg("m90")] })).toBeNull();
	});

	it("重复回执作废（start 不比当前起点更早）", () => {
		const ui = uiState();
		expect(prependOlderMessages(ui, { conversationId: "c1", start: 100, messages: [msg("m100")] })).toBeNull();
		expect(prependOlderMessages(ui, { conversationId: "c1", start: 120, messages: [msg("m120")] })).toBeNull();
	});

	it("空回执作废", () => {
		expect(prependOlderMessages(uiState(), { conversationId: "c1", start: 99, messages: [] })).toBeNull();
	});

	it("一路拼到顶，起点归零（到顶后前端收起按钮）", () => {
		let ui = uiState({ messages: [msg("m2")], messagesStart: 2 });
		ui = prependOlderMessages(ui, { conversationId: "c1", start: 0, messages: [msg("m0"), msg("m1")] })!;
		expect(ui.messagesStart).toBe(0);
		expect(ui.messages.map((m) => m.id)).toEqual(["m0", "m1", "m2"]);
	});

	it("没分页的老状态（messagesStart 缺省=0）收到历史回执也作废", () => {
		const ui = uiState({ messagesStart: undefined });
		expect(prependOlderMessages(ui, { conversationId: "c1", start: 0, messages: [msg("m0")] })).toBeNull();
	});
});

describe("paginationAfterDelta", () => {
	it("delta 只往后追加，窗口起点不变", () => {
		expect(paginationAfterDelta({ messagesStart: 100 }, {}).messagesStart).toBe(100);
	});

	it("delta 没带提问索引时沿用上一份——不能被 undefined 冲掉", () => {
		const ui = uiState();
		expect(paginationAfterDelta(ui, {}).questionIndex).toBe(ui.questionIndex);
	});

	it("delta 带了新索引（刚发了新提问）就用新的", () => {
		const fresh = [
			{ id: "m0", index: 0, text: "第一个问题" },
			{ id: "m200", index: 200, text: "新问题" },
		];
		expect(paginationAfterDelta(uiState(), { questionIndex: fresh }).questionIndex).toBe(fresh);
	});
});

/**
 * load-older-survives-snapshot：用户点了「加载更早消息」之后，一份整份快照（重连、
 * resync、或者服务端退回整份快照）不该把那段历史冲掉——但历史被改写时必须放手。
 */
describe("keepLoadedHistory", () => {
	/** 客户端：已经往前加载到 [96,102)。 */
	const loaded = (over: Partial<UiState> = {}) =>
		uiState({
			sessionId: "s1",
			messages: ["m96", "m97", "m98", "m99", "m100", "m101"].map(msg),
			messagesStart: 96,
			...over,
		});
	/** 快照：又来了一条，窗口是 [100,103)。 */
	const snap = (over: Partial<UiState> = {}) =>
		uiState({ sessionId: "s1", messages: ["m100", "m101", "m102"].map(msg), messagesStart: 100, ...over });

	it("同一会话、接得上：已加载的更早历史留下，起点不回退", () => {
		const out = keepLoadedHistory(loaded(), snap());
		expect(out.messagesStart).toBe(96);
		expect(out.messages.map((m) => m.id)).toEqual(["m96", "m97", "m98", "m99", "m100", "m101", "m102"]);
	});

	it("拼好之后不变量仍成立：messagesStart + 条数 = 快照的完整长度", () => {
		const next = snap();
		const out = keepLoadedHistory(loaded(), next);
		expect((out.messagesStart ?? 0) + out.messages.length).toBe((next.messagesStart ?? 0) + next.messages.length);
	});

	it("重叠部分用快照的（权威），轻量字段也全是快照的", () => {
		const next = snap({ questionIndex: [] });
		const out = keepLoadedHistory(loaded(), next);
		expect(out.messages[4]).toBe(next.messages[0]);
		expect(out.questionIndex).toBe(next.questionIndex);
	});

	it("换了对话：原样采用快照", () => {
		const next = snap({ conversationId: "c2" });
		expect(keepLoadedHistory(loaded(), next)).toBe(next);
	});

	it("同一对话槽换了会话：原样采用快照", () => {
		const next = snap({ sessionId: "s2" });
		expect(keepLoadedHistory(loaded(), next)).toBe(next);
	});

	it("历史被改写（压缩/分叉）：窗口第一条对不上就放手", () => {
		const next = snap({ messages: ["x100", "x101", "x102"].map(msg) });
		expect(keepLoadedHistory(loaded(), next)).toBe(next);
	});

	it("客户端的消息连不到快照窗口（中间有洞）：放手，不拼出空洞", () => {
		const next = snap({ messages: ["m110", "m111"].map(msg), messagesStart: 110 });
		expect(keepLoadedHistory(loaded(), next)).toBe(next);
	});

	it("没加载过更早的：原样采用快照", () => {
		const next = snap();
		expect(keepLoadedHistory(snap(), next)).toBe(next);
	});

	it("还没有状态（首次连接）：原样采用快照", () => {
		const next = snap();
		expect(keepLoadedHistory(null, next)).toBe(next);
	});

	it("快照窗口为空：原样采用快照", () => {
		const next = snap({ messages: [], messagesStart: 0 });
		expect(keepLoadedHistory(loaded(), next)).toBe(next);
	});
});
