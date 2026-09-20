/**
 * 切换对话的进行中 / 失败状态（switch-loading 补丁）—— 纯规则。
 *
 * 要守住的几条：
 *  1. 只有**对得上目标**的回执/快照才结束等待：连点两条时，第一条的回执不能把第二条的
 *     遮罩撤掉；旧对话流式中的快照（sessionFile 是旧的）也不能。
 *  2. DSH 的快照没有 sessionFile —— 按路径对不上是正常的，结束只能靠回执（所以回执是主信号）。
 *  3. 已经显示着目标了就不进入等待（否则永远等不到新快照）。
 *  4. 失败后那条对话被别的路径打开了 → 错误态自动消失。
 */
import { describe, expect, it } from "vitest";
import {
	isSwitchTargetRow,
	sameSessionPath,
	sameSwitchTarget,
	settleOnSnapshot,
	switchAlreadyShown,
	switchTargetReached,
	switchTargetTitle,
	type PendingSwitch,
} from "../../web/src/switch-pending.js";

const P = "/home/me/.pi/agent/sessions/--home-me--/2026-09-14T01-39-55-678Z_abc.jsonl";
const pending = (target: PendingSwitch["target"]): PendingSwitch => ({ target, startedAt: 1000, hidden: false });

describe("switch-pending", () => {
	it("路径比较只归一分隔符：Windows 反斜杠算同一个文件，大小写/别的路径不算", () => {
		expect(sameSessionPath("C:\\s\\a.jsonl", "C:/s/a.jsonl")).toBe(true);
		expect(sameSessionPath("/s/a.jsonl", "/s/A.jsonl")).toBe(false);
		expect(sameSessionPath("/s/a.jsonl", undefined)).toBe(false);
		expect(sameSessionPath("", "")).toBe(false);
	});

	it("目标相等：同 kind 同 key；kind 不同永远不等", () => {
		expect(sameSwitchTarget({ kind: "session", path: P }, { kind: "session", path: P })).toBe(true);
		expect(sameSwitchTarget({ kind: "conversation", id: "c2" }, { kind: "conversation", id: "c2" })).toBe(true);
		expect(sameSwitchTarget({ kind: "conversation", id: "c2" }, { kind: "conversation", id: "c3" })).toBe(false);
		expect(sameSwitchTarget({ kind: "session", path: P }, { kind: "conversation", id: P })).toBe(false);
		expect(sameSwitchTarget(null, { kind: "conversation", id: "c2" })).toBe(false);
	});

	it("快照对上目标：session 看 sessionFile，conversation 看 conversationId", () => {
		expect(switchTargetReached({ kind: "session", path: P }, { sessionFile: P, conversationId: "c9" })).toBe(true);
		expect(switchTargetReached({ kind: "session", path: P }, { sessionFile: "/x.jsonl", conversationId: "c9" })).toBe(
			false,
		);
		// DSH：快照没有 sessionFile —— 对不上是**正常**的，结束靠回执。
		expect(switchTargetReached({ kind: "session", path: P }, { conversationId: "c9" })).toBe(false);
		expect(switchTargetReached({ kind: "conversation", id: "c9" }, { conversationId: "c9" })).toBe(true);
		expect(switchTargetReached({ kind: "conversation", id: "c9" }, null)).toBe(false);
	});

	it("已经显示着目标 → 不进入等待（全局搜索点当前对话不会挂一层永远撤不掉的遮罩）", () => {
		expect(switchAlreadyShown({ kind: "session", path: P }, { sessionFile: P, conversationId: "c1" })).toBe(true);
		expect(switchAlreadyShown({ kind: "conversation", id: "c1" }, { sessionFile: P, conversationId: "c1" })).toBe(true);
		expect(switchAlreadyShown({ kind: "conversation", id: "c2" }, { sessionFile: P, conversationId: "c1" })).toBe(
			false,
		);
	});

	it("settleOnSnapshot：对上的 pending 清掉；旧对话的快照（流式中）不动它", () => {
		const pend = pending({ kind: "session", path: P });
		expect(settleOnSnapshot(pend, null, { sessionFile: "/old.jsonl", conversationId: "c1" })).toBeNull();
		expect(settleOnSnapshot(pend, null, { sessionFile: P, conversationId: "c7" })).toEqual({
			pendingSwitch: null,
			switchError: null,
		});
	});

	it("settleOnSnapshot：连点两条 —— 第一条的快照到了，不撤第二条的遮罩", () => {
		const second = pending({ kind: "conversation", id: "c3" });
		expect(settleOnSnapshot(second, null, { conversationId: "c2" })).toBeNull();
		expect(settleOnSnapshot(second, null, { conversationId: "c3" })?.pendingSwitch).toBeNull();
	});

	it("settleOnSnapshot：失败的那条后来被显示出来了 → 错误态也清掉；无关快照留着", () => {
		const err = { target: { kind: "session" as const, path: P }, error: "boom" };
		expect(settleOnSnapshot(null, err, { sessionFile: "/other.jsonl", conversationId: "c1" })).toBeNull();
		expect(settleOnSnapshot(null, err, { sessionFile: P, conversationId: "c1" })).toEqual({
			pendingSwitch: null,
			switchError: null,
		});
	});

	it("左栏行匹配：活行按 id 或转录路径，历史行按路径；没有目标时都不匹配", () => {
		const live = { id: "c2", sessionPath: P };
		const hist = { path: P };
		expect(isSwitchTargetRow({ kind: "conversation", id: "c2" }, live)).toBe(true);
		expect(isSwitchTargetRow({ kind: "conversation", id: "c2" }, hist)).toBe(false);
		expect(isSwitchTargetRow({ kind: "session", path: P }, live)).toBe(true);
		expect(isSwitchTargetRow({ kind: "session", path: P }, hist)).toBe(true);
		expect(isSwitchTargetRow({ kind: "session", path: "/nope.jsonl" }, hist)).toBe(false);
		expect(isSwitchTargetRow(null, live)).toBe(false);
	});

	it("遮罩标题：会话名 → 首条消息 → 活行标题 → 路径尾巴；对话目标直接用标题", () => {
		const sessions = [{ path: P, name: "temper", firstMessage: "hello there" }];
		const convs = [{ id: "c2", title: "tooling", sessionPath: P }];
		expect(switchTargetTitle({ kind: "session", path: P }, sessions, convs)).toBe("temper");
		expect(switchTargetTitle({ kind: "session", path: P }, [{ path: P, firstMessage: "hello there" }], convs)).toBe(
			"hello there",
		);
		expect(switchTargetTitle({ kind: "session", path: P }, [], convs)).toBe("tooling");
		expect(switchTargetTitle({ kind: "session", path: P }, [], [])).toBe("2026-09-14T01-39-55-678Z_abc.jsonl");
		expect(switchTargetTitle({ kind: "conversation", id: "c2" }, sessions, convs)).toBe("tooling");
		expect(switchTargetTitle({ kind: "conversation", id: "zz" }, sessions, convs)).toBe("zz");
		// 超长首条消息截断，不把整段话塞进一行标题。
		const long = "x".repeat(200);
		expect(switchTargetTitle({ kind: "session", path: P }, [{ path: P, firstMessage: long }], []).length).toBe(61);
	});
});
