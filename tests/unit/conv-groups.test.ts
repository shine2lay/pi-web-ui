/**
 * 左栏「最近对话」分组：当前项目（= **工作区**）那组排最前且不显示组标题。
 *
 * 两条必须同时成立的性质：
 * 1. **切对话不动位置**（chat-cwd-pin 的配套）：切到别的文件夹的对话不再搬工作区，
 *    所以也不该把那组提到最前 —— 否则每点一条跨文件夹的对话，整列就重排一次，
 *    行在鼠标下面跳走。
 * 2. **#140 的回归**：显式切工作区时 `conversations` 比带新 cwd 的快照早到一帧，
 *    新工作区还没有任何分组时回落到当前对话所在组，顶上不该闪一下项目名。
 */
import { describe, expect, it } from "vitest";
import { groupConversations } from "../../web/src/conv-groups.js";
import type { ConversationSummary } from "../../web/src/types.js";

const conv = (id: string, cwd: string, extra: Partial<ConversationSummary> = {}): ConversationSummary => ({
	id,
	title: id,
	cwd,
	messageCount: 1,
	isStreaming: false,
	isSubagent: false,
	...extra,
});

const A = "C:/proj/a";
const B = "C:/proj/b";

describe("groupConversations", () => {
	it("按 cwd 分组，当前项目排最前并标记 isCurrent", () => {
		const groups = groupConversations([conv("c1", A), conv("c2", B)], B, "c2");
		expect(groups.map((g) => g.cwd)).toEqual([B, A]);
		expect(groups[0].isCurrent).toBe(true);
		expect(groups[1].isCurrent).toBe(false);
	});

	it("打开别的文件夹的对话：顺序纹丝不动，那组照旧显示文件夹名", () => {
		// 工作区是 A，用户点开了 B 里的一条对话（chat-cwd-pin：工作区不搬家）。
		// A 仍是当前项目、仍排最前；B 带着文件夹名待在原位。
		const groups = groupConversations([conv("c1", A), conv("c2", B)], A, "c2");
		expect(groups.map((g) => g.cwd)).toEqual([A, B]);
		expect(groups[0].isCurrent).toBe(true);
		expect(groups[1].isCurrent).toBe(false);
	});

	it("在同一列里来回切跨文件夹的对话，分组顺序始终一致", () => {
		const list = [conv("c1", A), conv("c2", B), conv("c3", "C:/proj/c")];
		const order = (activeId: string) => groupConversations(list, A, activeId).map((g) => g.cwd);
		const baseline = order("c1");
		expect(order("c2")).toEqual(baseline);
		expect(order("c3")).toEqual(baseline);
		expect(order("c-blank")).toEqual(baseline);
	});

	it("新工作区还没有任何分组时（#140 的那一帧）回落到 activeId 所在组", () => {
		const groups = groupConversations([conv("c9", A)], B, "c9");
		expect(groups).toHaveLength(1);
		expect(groups[0].isCurrent).toBe(true);
	});

	it("activeId 不在列表里（空白新对话）时只按 cwd 判定", () => {
		const groups = groupConversations([conv("c1", A), conv("c2", B)], A, "c-blank");
		expect(groups[0].cwd).toBe(A);
		expect(groups[0].isCurrent).toBe(true);
		expect(groups[1].isCurrent).toBe(false);
	});

	it("子代理挂在父对话的项目下（即使自己 cwd 不同）", () => {
		// 工作区 B 在列表里没有分组（子代理归到父的 A 组）→ 回落到当前对话所在组。
		const groups = groupConversations([conv("p", A), conv("s", B, { isSubagent: true, parentId: "p" })], B, "s");
		expect(groups).toHaveLength(1);
		expect(groups[0].cwd).toBe(A);
		expect(groups[0].convs.map((c) => c.id)).toEqual(["p", "s"]);
		// 父组是当前项目（其中就有当前对话），所以不显示组标题
		expect(groups[0].isCurrent).toBe(true);
	});

	it("空列表 → 空分组", () => {
		expect(groupConversations([], A, "")).toEqual([]);
	});
});
