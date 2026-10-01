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
import { parseQueueFolds, QUEUE_FOLDS_MAX, queueFoldKey, toggledQueueFolds } from "../../web/src/queue-folds.js";
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

/**
 * queue-grouping: an open queued task's chat carries `queueHomeId` (the row of the queue chat it came from,
 * set by the server) and hangs under that row like a subagent, newest first; the queue chat's toggle folds
 * its task chats away. Titles, badges and the rows themselves stay as they are.
 */
describe("orderConversations: queued tasks' chats under their queue chat (queue-grouping)", () => {
	const list = () => [
		conv("tooling", 100, { sessionPath: "/s/tooling.jsonl" }),
		conv("task-old", 300, { queueHomeId: "tooling", title: "Queue #33: Older" }),
		conv("user-chat", 250),
		conv("task-new", 400, { queueHomeId: "tooling", title: "Queue #34: Newer", isStreaming: true }),
		conv("helper", 350, { parentId: "tooling", isSubagent: true }),
		conv("rollcall", 200),
		conv("rc-task", 260, { queueHomeId: "rollcall", hasQuestion: true }),
	];

	it("task chats sit under their queue chat, newest first, mixed with its subagents by creation time", () => {
		const rows = orderConversations(list());
		expect(rows.map((r) => [r.conv.id, r.depth, r.queueTask ?? false])).toEqual([
			["user-chat", 0, false],
			["rollcall", 0, false],
			["rc-task", 1, true],
			["tooling", 0, false],
			["task-new", 1, true],
			["helper", 1, false],
			["task-old", 1, true],
		]);
		// The rows are the server's own objects: titles and badges as they came.
		const byId = new Map(rows.map((r) => [r.conv.id, r.conv]));
		expect(byId.get("task-old")?.title).toBe("Queue #33: Older");
		expect(byId.get("rc-task")?.hasQuestion).toBe(true);
	});

	it("a queue chat's row knows its group: how many, working, needs you; subagents don't count", () => {
		const rows = orderConversations(list());
		const group = (id: string) => rows.find((r) => r.conv.id === id)?.queueGroup;
		expect(group("tooling")).toEqual({ count: 2, folded: false, streaming: true, needsYou: false });
		expect(group("rollcall")).toEqual({ count: 1, folded: false, streaming: false, needsYou: true });
		expect(group("user-chat")).toBeUndefined();
		// A parent with only subagents has no queue group (its subagents are shown as always).
		expect(orderConversations([conv("p", 1), conv("k", 2, { parentId: "p", isSubagent: true })])[0].queueGroup).toBe(
			undefined,
		);
	});

	it("needs you: a question, a pop-up, or a TL;DR line that needs the user", () => {
		const needs = (extra: Partial<ConversationSummary>) =>
			orderConversations([conv("home", 1), conv("t", 2, { queueHomeId: "home", ...extra })])[0].queueGroup?.needsYou;
		expect(needs({})).toBe(false);
		expect(needs({ hasQuestion: true })).toBe(true);
		expect(needs({ dialogId: 0 })).toBe(true);
		expect(needs({ tldr: { text: "Pick one", needsYou: true } })).toBe(true);
		expect(needs({ tldr: { text: "Working", needsYou: false } })).toBe(false);
	});

	it("folded: the queue chat's task chats leave the rows; its subagents and other groups stay", () => {
		const rows = orderConversations(list(), (home) => home.id === "tooling");
		expect(rows.map((r) => r.conv.id)).toEqual(["user-chat", "rollcall", "rc-task", "tooling", "helper"]);
		expect(rows.find((r) => r.conv.id === "tooling")?.queueGroup).toEqual({
			count: 2,
			folded: true,
			streaming: true,
			needsYou: false,
		});
	});

	it("folded: whatever hangs under a folded task chat goes with it (and the orphan pass doesn't bring it back)", () => {
		const rows = orderConversations(
			[
				conv("home", 1),
				conv("task", 2, { queueHomeId: "home" }),
				conv("task-helper", 3, { parentId: "task", isSubagent: true }),
			],
			() => true,
		);
		expect(rows.map((r) => r.conv.id)).toEqual(["home"]);
		// Unfolded: the task's own subagent sits under the task.
		expect(
			orderConversations([
				conv("home", 1),
				conv("task", 2, { queueHomeId: "home" }),
				conv("task-helper", 3, { parentId: "task", isSubagent: true }),
			]).map((r) => [r.conv.id, r.depth]),
		).toEqual([
			["home", 0],
			["task", 1],
			["task-helper", 2],
		]);
	});

	it("a task chat whose queue chat isn't in the list stays a normal row", () => {
		const rows = orderConversations([conv("task", 2, { queueHomeId: "gone" }), conv("x", 1)]);
		expect(rows.map((r) => [r.conv.id, r.depth, r.queueTask ?? false])).toEqual([
			["task", 0, false],
			["x", 0, false],
		]);
		// Pointing at itself: a normal row too.
		expect(orderConversations([conv("self", 1, { queueHomeId: "self" })]).map((r) => r.depth)).toEqual([0]);
	});

	it("a subagent's parent link wins over a queue link", () => {
		const rows = orderConversations([
			conv("home", 1),
			conv("parent", 2),
			conv("kid", 3, { parentId: "parent", queueHomeId: "home", isSubagent: true }),
		]);
		expect(rows.map((r) => [r.conv.id, r.depth])).toEqual([
			["parent", 0],
			["kid", 1],
			["home", 0],
		]);
		expect(rows.find((r) => r.conv.id === "home")?.queueGroup).toBeUndefined();
	});

	it("without queue links the rows are exactly as before (subagents unchanged)", () => {
		const before = [
			conv("parent", 100),
			conv("kid-old", 110, { parentId: "parent", isSubagent: true }),
			conv("kid-new", 120, { parentId: "parent", isSubagent: true }),
			conv("other", 200),
		];
		const rows = orderConversations(before, () => true);
		expect(rows).toEqual([
			{ conv: before[3], depth: 0 },
			{ conv: before[0], depth: 0 },
			{ conv: before[2], depth: 1 },
			{ conv: before[1], depth: 1 },
		]);
	});
});

describe("queue-folds: the folded queue chats kept in the browser (queue-grouping)", () => {
	it("a queue chat's fold is kept by its transcript (its id changes on a restart), else by its id", () => {
		expect(queueFoldKey({ id: "c7", sessionPath: "/s/tooling.jsonl" })).toBe("/s/tooling.jsonl");
		expect(queueFoldKey({ id: "c7" })).toBe("c7");
	});

	it("reads what localStorage holds; anything unreadable is no folds", () => {
		expect([...parseQueueFolds('["/s/a.jsonl","/s/b.jsonl"]')]).toEqual(["/s/a.jsonl", "/s/b.jsonl"]);
		expect(parseQueueFolds(null).size).toBe(0);
		expect(parseQueueFolds("not json").size).toBe(0);
		expect(parseQueueFolds('{"a":1}').size).toBe(0);
		expect([...parseQueueFolds('["/s/a.jsonl", 3, null]')]).toEqual(["/s/a.jsonl"]);
	});

	it("flips one queue chat, newest fold first, at most QUEUE_FOLDS_MAX kept", () => {
		const folded = toggledQueueFolds(new Set(["/s/a.jsonl"]), "/s/b.jsonl");
		expect(folded).toEqual(["/s/b.jsonl", "/s/a.jsonl"]);
		expect(toggledQueueFolds(new Set(folded), "/s/b.jsonl")).toEqual(["/s/a.jsonl"]);
		// Survives a reload: what's written is what's read back.
		expect([...parseQueueFolds(JSON.stringify(folded))]).toEqual(folded);
		const many = new Set(Array.from({ length: QUEUE_FOLDS_MAX }, (_, i) => `/s/${i}.jsonl`));
		const capped = toggledQueueFolds(many, "/s/new.jsonl");
		expect(capped).toHaveLength(QUEUE_FOLDS_MAX);
		expect(capped[0]).toBe("/s/new.jsonl");
		expect(capped).not.toContain(`/s/${QUEUE_FOLDS_MAX - 1}.jsonl`);
	});
});
