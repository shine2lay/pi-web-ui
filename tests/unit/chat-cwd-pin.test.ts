import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientSession, chatFollowsWorkspace } from "../../server/agent-service.js";

/**
 * 切到**别的文件夹**的对话时，工作区**不跟着跳**（chat-cwd-pin 补丁）。
 *
 * 老行为：`switchConversation()` / `switchSession()` 一旦发现目标对话的 cwd 与当前
 * 工作区不同，就顺手把整个工作区搬过去（文件树、最近项目排序、项目模型/密钥、新建
 * 对话的落点）。左栏「最近对话」本来就是跨文件夹的一列，来回点几条就等于来回搬家
 * —— 用户只是想看/继续那条对话。
 *
 * 新行为：工作区只由**显式**动作改变（选项目 / set_cwd）。对话自己的 cwd
 * （`conv.cwd`，工具真正跑的地方）不受影响 —— 它绑在运行时上，跨文件夹的行在左栏
 * 有文件夹分组标题可认。`PI_WEB_UI_CHAT_FOLLOWS_CWD=1` 恢复上游行为。
 *
 * 零 token、零端口：直接调生产代码的 switchConversation()，其余协作者用桩。
 */

const HERE = "/work/current";
const THERE = "/work/other-project";

type Proto = { switchConversation(this: FakeSession, id: string): Promise<void> };
const proto = ClientSession.prototype as unknown as Proto;

interface FakeConv {
	id: string;
	cwd: string;
	listed: boolean;
	promptedSinceActive: boolean;
	lastActiveAt: number;
	session: { sessionFile?: string; isStreaming: boolean; getSessionStats(): { totalMessages: number } };
}

interface FakeSession {
	cwd: string;
	roots: string[];
	activeId: string;
	convs: Map<string, FakeConv>;
	/** 记录「工作区搬家」相关的副作用有没有被触发。 */
	effects: string[];
	conv: FakeConv;
	[k: string]: unknown;
}

function conv(id: string, cwd: string): FakeConv {
	return {
		id,
		cwd,
		listed: true,
		promptedSinceActive: false,
		lastActiveAt: 0,
		session: {
			sessionFile: `/sessions/${id}.jsonl`,
			isStreaming: false,
			getSessionStats: () => ({ totalMessages: 2 }),
		},
	};
}

function session(): FakeSession {
	const effects: string[] = [];
	const convs = new Map<string, FakeConv>([
		["here", conv("here", HERE)],
		["there", conv("there", THERE)],
	]);
	const s: FakeSession = {
		cwd: HERE,
		roots: [],
		activeId: "here",
		convs,
		effects,
		get conv() {
			return convs.get(s.activeId)!;
		},
		displaceActive: () => null,
		markRecentSeen: () => {},
		removeConversation: () => {},
		webUi: { refresh: () => {} },
		emitConversations: () => {},
		goalSvc: { emitGoalStatus: () => {} },
		pushTerminals: () => {},
		pushSlashCommands: async () => {},
		notifyConversationChanged: () => {},
		flushSnapshot: () => {},
		// 下面这些只要被调用，就说明「工作区搬家」发生了。
		stateStore: {
			getWorkspaceRoots: () => [],
			remember: () => effects.push("remember-project"),
		},
		restoreProjectProviderKeysForCwd: async () => {
			effects.push("provider-keys");
		},
		restoreProjectModelForCwd: async () => {
			effects.push("project-model");
		},
		onCwdChanged: () => effects.push("cwd-changed-hook"),
		pushProjects: async () => effects.push("push-projects"),
		// 上游 v0.94：切对话时改调 refreshSessionsOnSwitch()（历史面板没打开过就不扫盘）。
		refreshSessionsOnSwitch: () => effects.push("refresh-sessions"),
		listFiles: async () => effects.push("list-files"),
		listCommands: async () => effects.push("list-commands"),
	} as unknown as FakeSession;
	return s;
}

const original = process.env.PI_WEB_UI_CHAT_FOLLOWS_CWD;
beforeEach(() => {
	delete process.env.PI_WEB_UI_CHAT_FOLLOWS_CWD;
});
afterEach(() => {
	if (original === undefined) delete process.env.PI_WEB_UI_CHAT_FOLLOWS_CWD;
	else process.env.PI_WEB_UI_CHAT_FOLLOWS_CWD = original;
});

describe("chatFollowsWorkspace()", () => {
	it("默认钉住工作区；显式置 1/true/yes 才跟随", () => {
		expect(chatFollowsWorkspace()).toBe(false);
		for (const v of ["1", "true", "YES"]) {
			process.env.PI_WEB_UI_CHAT_FOLLOWS_CWD = v;
			expect(chatFollowsWorkspace(), v).toBe(true);
		}
		for (const v of ["0", "false", "", "  "]) {
			process.env.PI_WEB_UI_CHAT_FOLLOWS_CWD = v;
			expect(chatFollowsWorkspace(), JSON.stringify(v)).toBe(false);
		}
	});
});

describe("切到别的文件夹的对话", () => {
	it("默认：工作区原地不动，也不重排最近项目/不重列文件树", async () => {
		const s = session();
		await proto.switchConversation.call(s, "there");
		expect(s.activeId).toBe("there");
		expect(s.cwd).toBe(HERE);
		expect(s.effects).toEqual([]);
	});

	it("对话自己的 cwd 不受影响（工具仍在它自己的目录里跑）", async () => {
		const s = session();
		await proto.switchConversation.call(s, "there");
		expect(s.conv.cwd).toBe(THERE);
	});

	it("同一文件夹内切换本来就没有搬家动作", async () => {
		const s = session();
		s.convs.set("here2", conv("here2", HERE));
		await proto.switchConversation.call(s, "here2");
		expect(s.cwd).toBe(HERE);
		expect(s.effects).toEqual([]);
	});

	it("PI_WEB_UI_CHAT_FOLLOWS_CWD=1 时恢复上游行为（整套副作用都回来）", async () => {
		process.env.PI_WEB_UI_CHAT_FOLLOWS_CWD = "1";
		const s = session();
		await proto.switchConversation.call(s, "there");
		expect(s.cwd).toBe(THERE);
		expect(s.effects).toContain("cwd-changed-hook");
		expect(s.effects).toContain("remember-project");
		expect(s.effects).toContain("list-files");
		expect(s.effects).toContain("project-model");
	});
});

/**
 * 从历史/「最近对话」打开（`switchSession()`）走的是另一条入口：它自建运行时，
 * 整段流程要真跑得起 SDK，不适合在单测里拼装。这里做**静态**体检：那条路径上的
 * 工作区搬家必须同样被 chatFollowsWorkspace() 守着，别只修了一半。
 */
describe("switchSession 入口同样被钉住（静态体检）", () => {
	it("this.cwd = targetCwd 必须在 chatFollowsWorkspace() 守卫内", () => {
		const src = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "..", "..", "server", "agent-service.ts"),
			"utf8",
		);
		const at = src.indexOf("this.cwd = targetCwd;");
		expect(at, "switchSession 里应仍有工作区赋值").toBeGreaterThan(-1);
		// 往前找最近的 200 字符：守卫应该就在紧邻的上方。
		expect(src.slice(Math.max(0, at - 200), at)).toMatch(/if \(chatFollowsWorkspace\(\)\) \{/);
	});
});
