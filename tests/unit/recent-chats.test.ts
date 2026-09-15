import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientSession, recentChatLimit } from "../../server/agent-service.js";
import { ClientStateStore } from "../../server/client-state.js";
import type { ConversationSummary, ServerMessage, SessionSummary } from "../../server/protocol.js";

/**
 * 左栏「最近对话」（recent-chats 补丁）的**服务端口径**。
 *
 * 老行为：这一列叫「运行的对话」，只含**活着的运行时**——一条对话空闲后被换到
 * 后台就从左栏消失了，想找回来只能去下面的 History 里翻。
 *
 * 新行为：
 *  - 列表 = 活着的对话 + 磁盘上最近 recentChatLimit() 条转录（`live: false` 的
 *    常驻行）。运行时被释放不再让一行消失。
 *  - ✕ = 只从这一列移出（client-state 里打 tombstone），**转录一个字都不动**，
 *    History 里照样能找到并重新打开；重新打开/继续聊会撤销 tombstone。
 *  - 状态灯：`isStreaming` → 黄灯闪（前端），跑完但用户没看过 → `waiting: true`
 *    → 绿灯常亮；打开该对话即灭（markRecentSeen）。当前正看着的对话不点绿灯。
 *
 * 零 token、零端口：直接调生产代码的 emitConversations、markRecentWaiting、
 * markRecentSeen、removeRecentChat，配一个临时 client-state.json 的真 ClientStateStore。
 */

type Proto = {
	emitConversations(this: FakeSession): void;
	shownInRunningList(this: FakeSession, conv: FakeConv): boolean;
	recentHistoryRows(this: FakeSession, live: Set<string>, waiting: Set<string>): ConversationSummary[];
	markRecentWaiting(this: FakeSession, conv: FakeConv): void;
	markRecentSeen(this: FakeSession, conv: FakeConv | undefined): void;
	removeRecentChat(this: FakeSession, path: string): Promise<void>;
};
const proto = ClientSession.prototype as unknown as Proto;

const CWD = "/work/project";

interface FakeConv {
	id: string;
	title: string;
	cwd: string;
	listed: boolean;
	isSubagent?: boolean;
	parentId?: string;
	session: { sessionFile?: string; isStreaming: boolean; getSessionStats(): { totalMessages: number } };
}

interface FakeSession {
	cwd: string;
	activeId: string;
	convs: Map<string, FakeConv>;
	stateStore: ClientStateStore;
	recentSessions: SessionSummary[];
	emitted: ServerMessage[];
	emit(msg: ServerMessage): void;
	emitConversations(): void;
	shownInRunningList(conv: FakeConv): boolean;
	recentHistoryRows(live: Set<string>, waiting: Set<string>): ConversationSummary[];
	subagentRunOutcome(conv: FakeConv): Record<string, unknown>;
}

function conv(id: string, opts: Partial<FakeConv> & { messages?: number; streaming?: boolean } = {}): FakeConv {
	const messages = opts.messages ?? 4;
	return {
		id,
		title: opts.title ?? `chat ${id}`,
		cwd: opts.cwd ?? CWD,
		listed: opts.listed ?? true,
		isSubagent: opts.isSubagent,
		parentId: opts.parentId,
		session: {
			sessionFile: opts.session?.sessionFile ?? `/sessions/${id}.jsonl`,
			isStreaming: opts.streaming ?? false,
			getSessionStats: () => ({ totalMessages: messages }),
		},
	};
}

function session(path: string, modified = Date.now()): SessionSummary {
	return { path, firstMessage: `history ${path}`, messageCount: 2, modified, source: "web", cwd: CWD };
}

let dir = "";
let s: FakeSession;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-web-recent."));
	s = {
		cwd: CWD,
		activeId: "a",
		convs: new Map(),
		stateStore: new ClientStateStore(join(dir, "client-state.json")),
		recentSessions: [],
		emitted: [],
		emit(msg) {
			this.emitted.push(msg);
		},
		emitConversations() {
			proto.emitConversations.call(this);
		},
		// 真实实现（展示口径）——本用例的对话都是 listed 或当前对话。
		shownInRunningList(conv: FakeConv) {
			return proto.shownInRunningList.call(this, conv);
		},
		recentHistoryRows(live: Set<string>, waiting: Set<string>) {
			return proto.recentHistoryRows.call(this, live, waiting);
		},
		subagentRunOutcome: () => ({}),
	};
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** 最近一次推送的对话列表。 */
function pushed(): ConversationSummary[] {
	proto.emitConversations.call(s);
	const last = [...s.emitted].reverse().find((m) => m.type === "conversations");
	expect(last).toBeTruthy();
	return (last as Extract<ServerMessage, { type: "conversations" }>).conversations;
}

describe("最近对话：列表口径", () => {
	it("活着的对话 + 磁盘上的最近对话一起入列，历史行标 live:false", () => {
		s.convs.set("a", conv("a"));
		s.recentSessions = [session("/sessions/old-1.jsonl"), session("/sessions/old-2.jsonl")];
		const rows = pushed();
		expect(rows.map((r) => r.sessionPath)).toEqual([
			"/sessions/a.jsonl",
			"/sessions/old-1.jsonl",
			"/sessions/old-2.jsonl",
		]);
		expect(rows[0].live).toBe(true);
		expect(rows[1].live).toBe(false);
		// 历史行点开走 switch_session：必须带着路径。
		expect(rows[1].sessionPath).toBe("/sessions/old-1.jsonl");
	});

	it("同一条对话既活着又在磁盘列表里时只出现一次（活的那份）", () => {
		s.convs.set("a", conv("a"));
		s.recentSessions = [session("/sessions/a.jsonl"), session("/sessions/old.jsonl")];
		const rows = pushed();
		expect(rows.filter((r) => r.sessionPath === "/sessions/a.jsonl")).toHaveLength(1);
		expect(rows.find((r) => r.sessionPath === "/sessions/a.jsonl")?.live).toBe(true);
	});

	it("常驻历史行有上限（recentChatLimit），活着的对话不受限", () => {
		for (let i = 0; i < 3; i++) s.convs.set(`live-${i}`, conv(`live-${i}`));
		s.recentSessions = Array.from({ length: recentChatLimit() + 10 }, (_, i) => session(`/sessions/h-${i}.jsonl`));
		const rows = pushed();
		expect(rows.filter((r) => r.live === true)).toHaveLength(3);
		expect(rows.filter((r) => r.live === false)).toHaveLength(recentChatLimit());
	});
});

describe("最近对话：✕ 只从这一列移出", () => {
	it("移出后不再入列，转录路径原样保留在 History（服务端不碰文件）", async () => {
		s.recentSessions = [session("/sessions/keep.jsonl"), session("/sessions/drop.jsonl")];
		await proto.removeRecentChat.call(s, "/sessions/drop.jsonl");
		expect(pushed().map((r) => r.sessionPath)).toEqual(["/sessions/keep.jsonl"]);
		// tombstone 落在 client-state 里（全局键，换标签页/重启仍然有效）。
		expect(s.stateStore.getRecentRemoved()).toContain("/sessions/drop.jsonl");
	});

	it("重新打开（markRecentSeen）撤销移出：它又是最近对话了", async () => {
		s.recentSessions = [session("/sessions/drop.jsonl")];
		await proto.removeRecentChat.call(s, "/sessions/drop.jsonl");
		expect(pushed()).toHaveLength(0);
		proto.markRecentSeen.call(s, conv("drop", { session: { sessionFile: "/sessions/drop.jsonl" } as never }));
		expect(pushed().map((r) => r.sessionPath)).toEqual(["/sessions/drop.jsonl"]);
	});
});

describe("最近对话：状态灯", () => {
	it("跑完且用户没在看 → waiting:true（绿灯常亮）", () => {
		const c = conv("b", { listed: true });
		s.convs.set("a", conv("a"));
		s.convs.set("b", c);
		proto.markRecentWaiting.call(s, c);
		const row = pushed().find((r) => r.id === "b");
		expect(row?.waiting).toBe(true);
		expect(row?.isStreaming).toBe(false);
	});

	it("当前正看着的对话跑完不点绿灯（人就在那儿）", () => {
		const c = conv("a");
		s.convs.set("a", c);
		proto.markRecentWaiting.call(s, c);
		expect(pushed().find((r) => r.id === "a")?.waiting).toBe(false);
		expect(s.stateStore.getRecentWaiting()).toHaveLength(0);
	});

	it("正在跑的行不叠绿灯（黄灯闪优先）", () => {
		const c = conv("b", { streaming: true });
		s.convs.set("a", conv("a"));
		s.convs.set("b", c);
		s.stateStore.setRecentWaiting("/sessions/b.jsonl", true);
		const row = pushed().find((r) => r.id === "b");
		expect(row?.isStreaming).toBe(true);
		expect(row?.waiting).toBe(false);
	});

	it("打开该对话 → 绿灯灭；运行时释放后（历史常驻行）绿灯仍然记得", () => {
		const c = conv("b");
		s.convs.set("a", conv("a"));
		s.convs.set("b", c);
		proto.markRecentWaiting.call(s, c);
		// 运行时被释放：同一条对话变成磁盘上的常驻行，绿灯不能丢。
		s.convs.delete("b");
		s.recentSessions = [session("/sessions/b.jsonl")];
		expect(pushed().find((r) => r.sessionPath === "/sessions/b.jsonl")?.waiting).toBe(true);
		// 用户打开它 → 灭灯（行本身永远留在列表里）。
		proto.markRecentSeen.call(s, c);
		const rows = pushed();
		expect(rows.find((r) => r.sessionPath === "/sessions/b.jsonl")?.waiting).toBe(false);
		// 灯灭了，行还在（当前对话 a + 常驻历史行 b）——「看过了不会让它消失」。
		expect(rows.map((r) => r.sessionPath)).toEqual(["/sessions/a.jsonl", "/sessions/b.jsonl"]);
	});

	it("被移出最近对话的行不再持有绿灯", async () => {
		const c = conv("b");
		s.convs.set("a", conv("a"));
		s.convs.set("b", c);
		proto.markRecentWaiting.call(s, c);
		await proto.removeRecentChat.call(s, "/sessions/b.jsonl");
		expect(s.stateStore.getRecentWaiting()).toHaveLength(0);
	});
});
