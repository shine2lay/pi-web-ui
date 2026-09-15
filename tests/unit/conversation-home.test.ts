/**
 * server-owned-chats × 上游 v0.94 的 findConversationHome（桥接工具的投递目标）。
 *
 * 上游口径：一条对话任一时刻只属于一个客户端，所以「第一个持有它的客户端」就是
 * 归属方。server-owned-chats 之后对话表进程共享，**每个**客户端都持有每条对话，
 * 「第一个持有者」就成了 clients 表里最早接入的那个：
 *  - 插件/调度伪客户端：sink 是空函数，page_request 石沉大海，browser_page 干等到超时；
 *  - 早已刷新掉的旧标签页：client-per-load 每次刷新都是新会话，旧的留在表里、没有
 *    socket，browser_page 当场报「没有已连接的页面」—— 哪怕用户的页面明明开着。
 * 问卷走广播 + 进程共享登记表，挑谁都一样；真正在乎的是 browser_page（只发给一个客户端）。
 */
import { describe, expect, it } from "vitest";
import { AgentService } from "../../server/agent-service.js";

type Home = { session: unknown; convId: string } | undefined;
const findHome = AgentService.prototype.findConversationHome as unknown as (this: unknown, sdk: unknown) => Home;

const SDK = { tag: "sdk-session" };
const OTHER_SDK = { tag: "someone-else" };

interface FakeClient {
	name: string;
	conversationIdOfSession(sdk: unknown): string | undefined;
	sinkCount(): number;
	isViewing(convId: string): boolean;
}

function client(name: string, opts: { sinks: number; viewing?: string; holds?: boolean }): FakeClient {
	return {
		name,
		conversationIdOfSession: (sdk) => (sdk === SDK && opts.holds !== false ? "c1" : undefined),
		sinkCount: () => opts.sinks,
		isViewing: (convId) => opts.viewing === convId,
	};
}

/** 按接入顺序排好的客户端表 → 被选中的那个的名字。 */
function home(entries: [string, FakeClient][]): string | undefined {
	const found = findHome.call({ clients: new Map(entries) }, SDK);
	return (found?.session as FakeClient | undefined)?.name;
}

describe("findConversationHome（共享对话表）", () => {
	it("挑正开着这条对话的在线浏览器，而不是表里最早的那个", () => {
		expect(
			home([
				["plugin:temper:default", client("plugin", { sinks: 1 })],
				["stale-tab", client("stale", { sinks: 0, viewing: "c1" })],
				["viewer", client("viewer", { sinks: 1, viewing: "c1" })],
				["newer", client("newer", { sinks: 1, viewing: "c2" })],
			]),
		).toBe("viewer");
	});

	it("两个在线窗口都在看：取最新接入的", () => {
		expect(
			home([
				["laptop", client("laptop", { sinks: 1, viewing: "c1" })],
				["desktop", client("desktop", { sinks: 1, viewing: "c1" })],
			]),
		).toBe("desktop");
	});

	it("没人在看：取最新接入的在线浏览器（伪客户端、断线的旧标签都不算）", () => {
		expect(
			home([
				["scheduler:job-1", client("scheduler", { sinks: 1 })],
				["old", client("old", { sinks: 1, viewing: "c2" })],
				["stale", client("stale", { sinks: 0 })],
				["new", client("new", { sinks: 1, viewing: "c3" })],
				["plugin:x:y", client("plugin", { sinks: 1 })],
			]),
		).toBe("new");
	});

	it("一个在线浏览器都没有：宁可挑断线的浏览器（pageCall 当场报没有页面），也不挑伪客户端（干等超时）", () => {
		expect(
			home([
				["plugin:x:y", client("plugin", { sinks: 1 })],
				["stale", client("stale", { sinks: 0 })],
			]),
		).toBe("stale");
	});

	it("只有伪客户端持有：照旧给它（上游口径）", () => {
		expect(home([["scheduler:job-1", client("scheduler", { sinks: 1 })]])).toBe("scheduler");
	});

	it("非共享口径（只有一个持有者）照旧就是它，哪怕它不在线", () => {
		expect(
			home([
				["a", client("a", { sinks: 1, holds: false })],
				["b", client("b", { sinks: 0 })],
			]),
		).toBe("b");
	});

	it("谁都不持有 → undefined（bridgeTarget 兜底用建时的会话）", () => {
		const found = findHome.call({ clients: new Map([["a", client("a", { sinks: 1 })]]) }, OTHER_SDK);
		expect(found).toBeUndefined();
	});

	it("单个客户端抛错不影响解析", () => {
		const broken: FakeClient = {
			name: "broken",
			conversationIdOfSession: () => {
				throw new Error("boom");
			},
			sinkCount: () => 1,
			isViewing: () => true,
		};
		expect(
			home([
				["broken", broken],
				["ok", client("ok", { sinks: 1, viewing: "c1" })],
			]),
		).toBe("ok");
	});
});
