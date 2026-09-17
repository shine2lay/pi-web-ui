/**
 * 左栏「最近对话」的排列（flat-recent-chats 补丁）：一条扁平列表，无项目分组，
 * 按创建时间倒序。
 *
 * 要验证的**核心性质**只有一条：顺序是输入里 createdAt 的纯函数 —— 收消息、
 * 点开、切工作区、正在流式、messageCount 变化，全都不影响顺序。以前的两个坑
 * （#140 的组标题闪一下、chat-cwd-pin 之后跨文件夹点一条就整列重排）在这个
 * 模型里**结构上**不可能发生：没有分组就没有组标题，不看活动时间就不会因活动重排。
 */
import { describe, expect, it } from "vitest";
import { orderConversations } from "../../web/src/conv-groups.js";
import type { ConversationSummary } from "../../web/src/types.js";

const conv = (
	id: string,
	createdAt: number | undefined,
	extra: Partial<ConversationSummary> = {},
): ConversationSummary => ({
	id,
	title: id,
	cwd: "C:/proj/a",
	messageCount: 1,
	isStreaming: false,
	isSubagent: false,
	...(createdAt === undefined ? {} : { createdAt }),
	...extra,
});

const ids = (list: ConversationSummary[]) => orderConversations(list).map((r) => r.conv.id);

describe("orderConversations", () => {
	it("按创建时间倒序：新的在上", () => {
		expect(ids([conv("old", 100), conv("new", 300), conv("mid", 200)])).toEqual(["new", "mid", "old"]);
	});

	it("跨文件夹的对话混在同一列表里，不按 cwd 分组", () => {
		const rows = orderConversations([
			conv("a1", 100, { cwd: "C:/proj/a" }),
			conv("b1", 300, { cwd: "C:/proj/b" }),
			conv("a2", 200, { cwd: "C:/proj/a" }),
		]);
		// 顺序纯看时间，b1 夹在两条 a 之间 —— 要是还按文件夹分组这不可能。
		expect(rows.map((r) => r.conv.id)).toEqual(["b1", "a2", "a1"]);
		expect(rows.every((r) => r.depth === 0)).toBe(true);
	});

	it("核心性质：活动、点开、流式、消息数 —— 都不改变顺序", () => {
		const base = [conv("c1", 100), conv("c2", 200), conv("c3", 300)];
		const expected = ["c3", "c2", "c1"];
		expect(ids(base)).toEqual(expected);
		// c1（最老）刚收到一条消息，sortAt / messageCount 都变了 —— 位置不变。
		expect(ids([conv("c1", 100, { sortAt: 9999, messageCount: 50 }), base[1], base[2]])).toEqual(expected);
		// c1 正在流式 —— 位置不变。
		expect(ids([conv("c1", 100, { isStreaming: true }), base[1], base[2]])).toEqual(expected);
		// c1 变成活行 / 常驻行 —— 位置不变。
		expect(ids([conv("c1", 100, { live: false }), base[1], base[2]])).toEqual(expected);
		expect(ids([conv("c1", 100, { waiting: true }), base[1], base[2]])).toEqual(expected);
		// 输入顺序被打乱（服务端重推时顺序不保证）—— 输出仍然一样。
		expect(ids([base[2], base[0], base[1]])).toEqual(expected);
	});

	it("子代理缩进挂在父行下面，子代理之间也按创建时间倒序", () => {
		const rows = orderConversations([
			conv("parent", 100),
			conv("kid-old", 110, { parentId: "parent", isSubagent: true }),
			conv("kid-new", 120, { parentId: "parent", isSubagent: true }),
			conv("other", 200),
		]);
		expect(rows.map((r) => [r.conv.id, r.depth])).toEqual([
			["other", 0],
			["parent", 0],
			["kid-new", 1],
			["kid-old", 1],
		]);
	});

	it("父行不在列表里的子代理作为根行出现，不会丢", () => {
		expect(ids([conv("orphan", 100, { parentId: "gone", isSubagent: true }), conv("x", 200)])).toEqual(["x", "orphan"]);
	});

	it("缺 createdAt 的行（老服务端）排最后且保持相对顺序", () => {
		expect(ids([conv("u1", undefined), conv("new", 300), conv("u2", undefined), conv("old", 100)])).toEqual([
			"new",
			"old",
			"u1",
			"u2",
		]);
	});

	it("相同创建时间的行保持输入顺序（稳定排序，不会每次渲染换样）", () => {
		const list = [conv("x", 100), conv("y", 100), conv("z", 100)];
		expect(ids(list)).toEqual(["x", "y", "z"]);
		expect(ids(list)).toEqual(ids(list));
	});
});
