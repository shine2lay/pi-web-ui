/**
 * ask-delivery：问卷「不弹」的两条根因的回归。
 *
 * 根因 1（永久挂死）：askUser 不设超时 + emit 在没有页面连着时静默丢弃
 *   → question_pending 没人收到，这轮 agent 永远阻塞。同文件的 pageCall 早有
 *   sinks.size === 0 守卫，askUser 漏了。
 * 根因 2（快照救不回来）：pendingQuestionForSnapshot 以前按 activeId 过滤，
 *   问卷只在用户恰好回到那条对话时才复活；打开别的对话就永远丢了。
 *
 * multi-device（本轮）：问卷属于对话、不属于客户端 —— 注册表进程共享、广播给所有
 *   在线设备。随之而来的一条：某个客户端 dispose 不能再连带取消问卷，否则
 *   关掉笔记本那一页就把台式机还能答的问卷打掉了（client-per-load 之后，
 *   每次刷新都 dispose 一个旧会话 = 每次刷新都打掉自己的问卷）。
 */
import { describe, expect, it } from "vitest";
import {
	ASK_USER_NO_CLIENT_ERROR,
	ASK_USER_NO_CLIENT_GRACE_MS,
	askDeliveryOnAsk,
	askDeliveryOnGraceExpiry,
	pickPendingQuestionForSnapshot,
	shouldCancelOnClientDispose,
} from "../../server/ask-delivery.js";

describe("askDeliveryOnAsk", () => {
	it("有页面连着 → 走即时通道（原行为不变）", () => {
		expect(askDeliveryOnAsk(1)).toBe("emit");
		expect(askDeliveryOnAsk(3)).toBe("emit");
	});

	it("没有页面连着 → 不 emit（emit 会静默丢弃），先挂起等宽限期", () => {
		expect(askDeliveryOnAsk(0)).toBe("grace");
	});
});

describe("askDeliveryOnGraceExpiry", () => {
	it("到点还是没人在线 → 拒掉，别让模型永远等下去", () => {
		expect(askDeliveryOnGraceExpiry({ clientCount: 0, stillPending: true })).toBe("reject");
	});

	it("期间页面回来了 → 保持挂起，交给快照恢复对话框", () => {
		expect(askDeliveryOnGraceExpiry({ clientCount: 1, stillPending: true })).toBe("keep");
	});

	it("已经被回答/取消 → 什么都不做（不能去动已 settle 的 promise）", () => {
		expect(askDeliveryOnGraceExpiry({ clientCount: 0, stillPending: false })).toBe("keep");
		expect(askDeliveryOnGraceExpiry({ clientCount: 2, stillPending: false })).toBe("keep");
	});

	it("宽限期足够覆盖一次刷新/重连，又不至于让模型干等太久", () => {
		expect(ASK_USER_NO_CLIENT_GRACE_MS).toBeGreaterThanOrEqual(5_000);
		expect(ASK_USER_NO_CLIENT_GRACE_MS).toBeLessThanOrEqual(120_000);
	});

	it("给模型的错误要说清楚「改用正文提问」，否则它会原地重试", () => {
		expect(ASK_USER_NO_CLIENT_ERROR).toContain("no browser connected");
		expect(ASK_USER_NO_CLIENT_ERROR).toContain("ask_user_question");
	});
});

describe("pickPendingQuestionForSnapshot", () => {
	const q = [{ id: "q1", question: "?" }];

	it("非当前对话的问卷也要带进快照 —— 这正是以前丢问卷的那条路径", () => {
		const entries = new Map([["q-7", { questions: q, conversationId: "conv-B" }]]);
		expect(pickPendingQuestionForSnapshot(entries)).toEqual({
			id: "q-7",
			questions: q,
			conversationId: "conv-B",
		});
	});

	it("没有 conversationId（旧条目）也能带上，不加空字段", () => {
		const entries = new Map([["q-1", { questions: q }]]);
		const got = pickPendingQuestionForSnapshot(entries);
		expect(got).toEqual({ id: "q-1", questions: q });
		expect(got && "conversationId" in got).toBe(false);
		expect(got && "conversationTitle" in got).toBe(false);
	});

	it("带上对话标题 —— 另一台设备可能在看别的对话，要能看出是谁在问", () => {
		const entries = new Map([
			["q-9", { questions: q, conversationId: "conv-B", conversationTitle: "temper workflow" }],
		]);
		expect(pickPendingQuestionForSnapshot(entries)).toEqual({
			id: "q-9",
			questions: q,
			conversationId: "conv-B",
			conversationTitle: "temper workflow",
		});
	});

	it("没有待答提问 → null（前端据此收起由快照恢复的面板）", () => {
		expect(pickPendingQuestionForSnapshot(new Map())).toBeNull();
	});

	it("多张并存时取第一张（正常只会有一张：agent 阻塞在工具执行上）", () => {
		const entries = new Map([
			["q-1", { questions: q, conversationId: "conv-A" }],
			["q-2", { questions: q, conversationId: "conv-B" }],
		]);
		expect(pickPendingQuestionForSnapshot(entries)?.id).toBe("q-1");
	});
});

describe("shouldCancelOnClientDispose", () => {
	it("还有别的设备连着 → 保留问卷（在笔记本上被问、走到台式机上回答）", () => {
		expect(shouldCancelOnClientDispose({ connectedClientsLeft: 1 })).toBe("keep");
		expect(shouldCancelOnClientDispose({ connectedClientsLeft: 5 })).toBe("keep");
	});

	it("一台都不剩 → 取消，别让模型挂死", () => {
		expect(shouldCancelOnClientDispose({ connectedClientsLeft: 0 })).toBe("cancel");
	});
});
