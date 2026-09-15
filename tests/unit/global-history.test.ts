import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ClientSession, historyScope } from "../../server/agent-service.js";
import type { ServerMessage } from "../../server/protocol.js";

/**
 * History 面板 / 会话搜索的**范围**（`historyScope()`）。
 *
 * 原来的行为是「按文件夹」：`SessionManager.list(this.cwd)` 只列当前工作目录的
 * 转录，于是切项目（最近项目 / set_cwd）会把左栏历史整列换掉 —— 用户找一个别的
 * 文件夹里的旧对话，得先猜它属于哪个项目。
 *
 * 现在默认 `"all"`：走 `SessionManager.listAll()`（`pushProjects()` 本来就用它
 * 汇总最近项目），一次列出所有文件夹的对话，按时间倒序；每条带上自己的 `cwd`，
 * 左栏据此给「不属于当前工作目录」的对话标文件夹徽章。点开别的文件夹的对话仍会
 * 跟着切到该对话自己的 cwd（`switchSession()` 的既有行为，工具要在它的目录里跑）。
 * `PI_WEB_UI_HISTORY_SCOPE=project` 切回按文件夹。
 *
 * 零 token、零端口：用 SDK 真的写两个文件夹的转录到临时 agent 目录，再直接调
 * 生产代码的 loadSessionInfos/pushSessions/searchSessions。
 */

// SDK 在调用时读 PI_CODING_AGENT_DIR，所以这里可以整段隔离掉 ~/.pi。
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-global-history."));
const projA = join(agentDir, "work", "alpha-project");
const projB = join(agentDir, "work", "beta-project");
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
const originalScope = process.env.PI_WEB_UI_HISTORY_SCOPE;

let fileA = "";
let fileB = "";

/** SDK 只有在会话里出现 assistant 消息后才把转录落盘，所以每条各写一轮对话。 */
function writeTranscript(cwd: string, userText: string, at: number): string {
	const sm = SessionManager.create(cwd);
	sm.appendMessage({ role: "user", content: [{ type: "text", text: userText }], timestamp: at });
	sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: `ok: ${userText}` }],
		timestamp: at + 1000,
		// 转录落盘只看 role；这几个字段是 AssistantMessage 的必填属性。
		api: "anthropic-messages",
		provider: "test",
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
		stopReason: "stop",
	} as unknown as Parameters<typeof sm.appendMessage>[0]);
	const file = sm.getSessionFile();
	expect(file).toBeTruthy();
	return file!;
}

type Proto = {
	loadSessionInfos(this: FakeSession): Promise<{ path: string; cwd: string }[]>;
	pushSessions(this: FakeSession): Promise<void>;
	searchSessions(this: FakeSession, query: string, reqId: number): Promise<void>;
};
const proto = ClientSession.prototype as unknown as Proto;

interface FakeSession {
	cwd: string;
	sessionInfosCache: { cwd: string } | null;
	sessionsRequested: boolean;
	emitted: ServerMessage[];
	emit(msg: ServerMessage): void;
	/** pushSessions/searchSessions 调 `this.loadSessionInfos()` —— 挂上真实实现。 */
	loadSessionInfos: Proto["loadSessionInfos"];
	/** recent-chats 补丁：pushSessions 把这份列表存给「最近对话」并重推左栏。
	 *  本用例只关心 sessions 推送，这里只给出最小承载点。 */
	recentSessions: unknown[];
	emitConversations(): void;
}

function fakeSession(cwd: string): FakeSession {
	const emitted: ServerMessage[] = [];
	return {
		cwd,
		sessionInfosCache: null,
		sessionsRequested: true,
		emitted,
		emit(msg: ServerMessage) {
			emitted.push(msg);
		},
		loadSessionInfos: proto.loadSessionInfos,
		recentSessions: [],
		emitConversations() {
			/* 左栏推送不在本用例范围内（见 recent-chats.test.ts） */
		},
	};
}

beforeAll(() => {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_CODING_AGENT_SESSION_DIR;
	delete process.env.PI_WEB_UI_HISTORY_SCOPE;
	mkdirSync(projA, { recursive: true });
	mkdirSync(projB, { recursive: true });
	fileA = writeTranscript(projA, "alpha task about quotas", Date.now() - 600_000);
	fileB = writeTranscript(projB, "beta task about badges", Date.now() - 60_000);
});

afterAll(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
	else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir;
	if (originalScope === undefined) delete process.env.PI_WEB_UI_HISTORY_SCOPE;
	else process.env.PI_WEB_UI_HISTORY_SCOPE = originalScope;
	rmSync(agentDir, { recursive: true, force: true });
});

describe("historyScope()", () => {
	it("默认全局；PI_WEB_UI_HISTORY_SCOPE=project 切回按文件夹", () => {
		delete process.env.PI_WEB_UI_HISTORY_SCOPE;
		expect(historyScope()).toBe("all");
		process.env.PI_WEB_UI_HISTORY_SCOPE = "project";
		expect(historyScope()).toBe("project");
		process.env.PI_WEB_UI_HISTORY_SCOPE = "nonsense";
		expect(historyScope()).toBe("all");
		delete process.env.PI_WEB_UI_HISTORY_SCOPE;
	});
});

describe("History 列表（全局范围）", () => {
	it("两个文件夹的转录都在，与当前 cwd 无关", async () => {
		const s = fakeSession(projA);
		const infos = await proto.loadSessionInfos.call(s);
		expect(infos.map((i) => i.path).sort()).toEqual([fileA, fileB].sort());
		expect(new Set(infos.map((i) => i.cwd))).toEqual(new Set([projA, projB]));
		expect(s.sessionInfosCache?.cwd).toBe("*");
	});

	it("TTL 内切工作目录复用同一份缓存（不重新解析全部转录）", async () => {
		const s = fakeSession(projA);
		const first = await proto.loadSessionInfos.call(s);
		s.cwd = projB;
		const second = await proto.loadSessionInfos.call(s);
		expect(second).toBe(first);
	});

	it("scope=project 时恢复原来的按文件夹列表", async () => {
		process.env.PI_WEB_UI_HISTORY_SCOPE = "project";
		try {
			const s = fakeSession(projA);
			expect((await proto.loadSessionInfos.call(s)).map((i) => i.path)).toEqual([fileA]);
			expect(s.sessionInfosCache?.cwd).toBe(projA);
			s.cwd = projB;
			expect((await proto.loadSessionInfos.call(s)).map((i) => i.path)).toEqual([fileB]);
		} finally {
			delete process.env.PI_WEB_UI_HISTORY_SCOPE;
		}
	});

	it("推给浏览器的列表：时间倒序、每条带自己的 cwd、切项目不变", async () => {
		const s = fakeSession(projA);
		await proto.pushSessions.call(s);
		expect(s.emitted).toHaveLength(1);
		const msg = s.emitted[0];
		expect(msg.type).toBe("sessions");
		const sessions = msg.type === "sessions" ? msg.sessions : [];
		expect(sessions.map((x) => [x.path, x.cwd])).toEqual([
			[fileB, projB],
			[fileA, projA],
		]);
		for (const row of sessions) {
			expect(typeof row.firstMessage).toBe("string");
			expect(row.messageCount).toBe(2);
			expect(row.source).toBe("web");
			expect(typeof row.modified).toBe("number");
		}
		// 换工作目录只改「当前文件夹」（左栏据此决定给谁标徽章），列表本身不动。
		const other = fakeSession(projB);
		await proto.pushSessions.call(other);
		const otherMsg = other.emitted[0];
		expect(otherMsg.type === "sessions" ? otherMsg.sessions.map((x) => x.path) : []).toEqual(
			sessions.map((x) => x.path),
		);
	});

	it("面板没要过列表就不推（不为没开过历史的客户端扫盘）", async () => {
		const s = fakeSession(projA);
		s.sessionsRequested = false;
		await proto.pushSessions.call(s);
		expect(s.emitted).toHaveLength(0);
	});

	it("全局搜索同样跨文件夹，并带上 cwd", async () => {
		const s = fakeSession(projA);
		await proto.searchSessions.call(s, "badges", 1);
		const msg = s.emitted.at(-1)!;
		expect(msg.type).toBe("session_search_results");
		if (msg.type !== "session_search_results") return;
		expect(msg.reqId).toBe(1);
		expect(msg.ok).toBe(true);
		expect(msg.results.map((r) => [r.path, r.cwd])).toEqual([[fileB, projB]]);
		await proto.searchSessions.call(s, "task", 2);
		const all = s.emitted.at(-1)!;
		expect(all.type === "session_search_results" ? all.results.map((r) => r.path) : []).toEqual([fileB, fileA]);
	});
});
