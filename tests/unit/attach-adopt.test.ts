import { describe, expect, it } from "vitest";
import { type AdoptCandidate, pickAdoptTarget } from "../../server/attach-adopt.js";

/**
 * reload-adopt：新连接该接管哪条对话。
 *
 * 这条判断在 `attach()` 里、`attachSink()` 之前跑 —— 选错的代价是用户刷新后
 * 落在别的对话上（或者更糟：同一份 JSONL 被第二个 runtime 打开）。
 */

const conv = (id: string, cwd: string, lastActiveAt: number): AdoptCandidate => ({
	id,
	cwd,
	lastActiveAt,
	isSubagent: false,
});
const subagent = (id: string, cwd: string, lastActiveAt: number): AdoptCandidate => ({
	...conv(id, cwd, lastActiveAt),
	isSubagent: true,
});

describe("pickAdoptTarget", () => {
	it("这个 cwd 下没有开着的对话 → null（照常从磁盘恢复）", () => {
		expect(pickAdoptTarget("/p/a", [])).toBeNull();
		expect(pickAdoptTarget("/p/a", [conv("c1", "/p/b", 100)])).toBeNull();
	});

	it("刷新时那条正开着 → 接管它，而不是再恢复一份", () => {
		expect(pickAdoptTarget("/p/a", [conv("c1", "/p/a", 100)])).toBe("c1");
	});

	it("同项目多条 → 取最后活跃的那条（与切项目路径同口径）", () => {
		const list = [conv("old", "/p/a", 100), conv("recent", "/p/a", 300), conv("mid", "/p/a", 200)];
		expect(pickAdoptTarget("/p/a", list)).toBe("recent");
	});

	it("只认同一个 cwd：别的项目更活跃也不抢", () => {
		const list = [conv("mine", "/p/a", 100), conv("other", "/p/b", 999)];
		expect(pickAdoptTarget("/p/a", list)).toBe("mine");
	});

	it("时间戳并列 → 先到先得（同一份输入永远同一个结果）", () => {
		const list = [conv("first", "/p/a", 500), conv("second", "/p/a", 500)];
		expect(pickAdoptTarget("/p/a", list)).toBe("first");
		expect(pickAdoptTarget("/p/a", [...list].reverse())).toBe("second");
	});

	it("cwd 按字面比较：尾斜杠/子目录都不算同一个项目", () => {
		const list = [conv("trailing", "/p/a/", 100), conv("child", "/p/a/sub", 200)];
		expect(pickAdoptTarget("/p/a", list)).toBeNull();
	});

	it("lastActiveAt 为 0（刚建还没被切过）也能被选中，不会被当成假值跳过", () => {
		expect(pickAdoptTarget("/p/a", [conv("fresh", "/p/a", 0)])).toBe("fresh");
	});

	// 子代理对话跟父对话**同一个 cwd**，而且建立时就是 Date.now() ——
	// 刚派出一个子代理再刷新，它就是这个 cwd 里最「新」的那条。
	it("子代理对话永不被接管（即使它是唯一候选）", () => {
		expect(pickAdoptTarget("/p/a", [subagent("sa-1234abcd", "/p/a", 900)])).toBeNull();
	});

	it("子代理更新也不能挤掉用户自己的对话", () => {
		const list = [conv("mine", "/p/a", 100), subagent("sa-1234abcd", "/p/a", 999)];
		expect(pickAdoptTarget("/p/a", list)).toBe("mine");
	});
});
