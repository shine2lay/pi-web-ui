/**
 * switch-cache —— 客户端的对话缓存（web/src/chat-cache.ts）。
 *
 * 切回看过的对话时：先显示缓存那份，服务端只补差异（snapshot.reuse）。最容易出的错：
 *  - 接歪了：缓存和服务端说的不是同一截，却照样拼起来（留空洞/重复/串对话）；
 *  - 认错人：对话 id 在服务端重启后会重号，按 id 找缓存会找到别的对话；
 *  - 列表整个重建：预览换成真快照时 key 变了，省下来的渲染又全花回去。
 */

import { describe, expect, it } from "vitest";
import {
	applyReuse,
	CHAT_CACHE_MAX,
	cachedWindow,
	ChatCache,
	nextListKey,
	windowKey,
} from "../../web/src/chat-cache.js";
import { messagesHash } from "../../server/window-hash.js";
import type { CachedWindow, UiMessage, UiState } from "../../web/src/types.js";

function msg(id: string): UiMessage {
	return { id, role: "user", content: [{ type: "text", text: id }] } as UiMessage;
}

function msgs(...ids: string[]): UiMessage[] {
	return ids.map(msg);
}

function ui(over: Partial<UiState> = {}): UiState {
	return {
		conversationId: "c1",
		sessionId: "s1",
		sessionFile: "/home/u/.pi/sessions/a.jsonl",
		messages: msgs("m0", "m1", "m2"),
		messagesStart: 0,
		isStreaming: false,
		...over,
	} as UiState;
}

describe("ChatCache：按转录路径记、最久没看的先扔", () => {
	it("按路径取回同一个对象；反斜杠路径也认", () => {
		const cache = new ChatCache();
		const a = ui({ sessionFile: "C:\\u\\a.jsonl" });
		cache.put(a);
		expect(cache.get("C:/u/a.jsonl")).toBe(a);
		expect(cache.get("C:\\u\\a.jsonl")).toBe(a);
	});

	it("没有转录路径、没有会话 id、还没有消息的都不记", () => {
		const cache = new ChatCache();
		cache.put(null);
		cache.put(ui({ sessionFile: undefined }));
		cache.put(ui({ sessionId: undefined }));
		cache.put(ui({ messages: [] }));
		expect(cache.size).toBe(0);
	});

	it("同一条对话再记一次是覆盖，不是多一条", () => {
		const cache = new ChatCache();
		const a1 = ui();
		const a2 = ui({ messages: msgs("m0", "m1", "m2", "m3") });
		cache.put(a1);
		cache.put(a2);
		expect(cache.size).toBe(1);
		expect(cache.get(a1.sessionFile)).toBe(a2);
	});

	it(`超过上限（默认 ${CHAT_CACHE_MAX}）扔最久没记的；刚记过的往后排`, () => {
		const cache = new ChatCache(2);
		const a = ui({ sessionFile: "/a" });
		const b = ui({ sessionFile: "/b", sessionId: "sb" });
		const c = ui({ sessionFile: "/c", sessionId: "sc" });
		cache.put(a);
		cache.put(b);
		cache.put(a); // a 又看了一眼：现在 b 最旧
		cache.put(c);
		expect(cache.get("/a")).toBe(a);
		expect(cache.get("/b")).toBeUndefined();
		expect(cache.get("/c")).toBe(c);
	});

	it("forTarget：历史行按路径；活行按左栏那一行的转录路径，不按对话 id", () => {
		const cache = new ChatCache();
		const a = ui({ conversationId: "c1", sessionFile: "/a" });
		cache.put(a);
		expect(cache.forTarget({ kind: "session", path: "/a" }, [])).toBe(a);
		// 服务端重启后 c1 可能已经是别的对话：认的是行上的路径
		expect(cache.forTarget({ kind: "conversation", id: "c1" }, [{ id: "c1", sessionFile: "/other" }])).toBeUndefined();
		expect(cache.forTarget({ kind: "conversation", id: "c7" }, [{ id: "c7", sessionFile: "/a" }])).toBe(a);
		// 行上没有路径 / 找不到行：不认
		expect(cache.forTarget({ kind: "conversation", id: "c1" }, [{ id: "c1" }])).toBeUndefined();
		expect(cache.forTarget({ kind: "conversation", id: "c9" }, [])).toBeUndefined();
	});
});

describe("cachedWindow / windowKey", () => {
	it("窗口 = 会话 id + 起点 + 条数 + 这一截 id 的指纹", () => {
		const a = ui({ messages: msgs("m5", "m6"), messagesStart: 5 });
		expect(cachedWindow(a)).toEqual({ sessionId: "s1", start: 5, count: 2, hash: messagesHash(a.messages) });
	});

	it("没有消息或没有会话 id：没有窗口", () => {
		expect(cachedWindow(ui({ messages: [] }))).toBeNull();
		expect(cachedWindow(ui({ sessionId: undefined }))).toBeNull();
	});

	it("窗口不同 key 就不同", () => {
		const w: CachedWindow = { sessionId: "s1", start: 0, count: 3, hash: "h" };
		expect(windowKey(w)).toBe(windowKey({ ...w }));
		expect(windowKey(w)).not.toBe(windowKey({ ...w, count: 4 }));
		expect(windowKey(w)).not.toBe(windowKey({ ...w, start: 1 }));
		expect(windowKey(w)).not.toBe(windowKey({ ...w, hash: "g" }));
		expect(windowKey(w)).not.toBe(windowKey({ ...w, sessionId: "s2" }));
	});
});

describe("applyReuse：把缓存那截接在新增的尾巴前面", () => {
	const base = ui({ messages: msgs("m5", "m6", "m7"), messagesStart: 5 });
	const reuse = cachedWindow(base)!;

	it("接上：缓存的消息对象原样沿用，其余字段用新快照的", () => {
		const snap = ui({ messages: msgs("m8", "m9"), messagesStart: 5, isStreaming: true, conversationId: "c4" });
		const merged = applyReuse(base, snap, reuse)!;
		expect(merged.messages.map((m) => m.id)).toEqual(["m5", "m6", "m7", "m8", "m9"]);
		expect(merged.messages[0]).toBe(base.messages[0]);
		expect(merged.messages[2]).toBe(base.messages[2]);
		expect(merged.messagesStart).toBe(5);
		expect(merged.isStreaming).toBe(true);
		expect(merged.conversationId).toBe("c4");
	});

	it("什么都没新增：连数组都是缓存里那一个", () => {
		const merged = applyReuse(base, ui({ messages: [], messagesStart: 5 }), reuse)!;
		expect(merged.messages).toBe(base.messages);
	});

	it("缓存比报上去的长（只用前 count 条）", () => {
		const longer = ui({ messages: msgs("m5", "m6", "m7", "mX"), messagesStart: 5 });
		const merged = applyReuse(longer, ui({ messages: msgs("m8"), messagesStart: 5 }), reuse)!;
		expect(merged.messages.map((m) => m.id)).toEqual(["m5", "m6", "m7", "m8"]);
	});

	it("对不上一律不接（调用方去要整份）", () => {
		const snap = ui({ messages: msgs("m8"), messagesStart: 5 });
		expect(applyReuse(undefined, snap, reuse)).toBeNull();
		expect(applyReuse(ui({ ...base, sessionId: "s2" }), snap, reuse)).toBeNull();
		expect(applyReuse(base, ui({ ...snap, sessionId: "s2" }), reuse)).toBeNull();
		expect(applyReuse(ui({ ...base, messagesStart: 4 }), snap, reuse)).toBeNull();
		expect(applyReuse(ui({ ...base, messages: msgs("m5", "m6") }), snap, reuse)).toBeNull();
		expect(applyReuse(ui({ ...base, messages: msgs("m5", "mY", "m7") }), snap, reuse)).toBeNull();
		expect(applyReuse(base, snap, { ...reuse, hash: "nope" })).toBeNull();
	});
});

describe("nextListKey：预览换成真快照时列表不重建", () => {
	it("没有状态就没有 key；第一份用对话 id", () => {
		expect(nextListKey(null, null)).toBeNull();
		expect(nextListKey(null, ui({ conversationId: "c1" }))?.key).toBe("c1");
	});

	it("同一对话换了会话（改写分支）：key 不变", () => {
		const k1 = nextListKey(null, ui({ conversationId: "c1", sessionId: "s1" }));
		expect(nextListKey(k1, ui({ conversationId: "c1", sessionId: "s2" }))?.key).toBe("c1");
	});

	it("同一会话换了对话 id（从历史重开，预览里是旧 id）：key 不变", () => {
		const k1 = nextListKey(null, ui({ conversationId: "c1", sessionId: "s1" }));
		expect(nextListKey(k1, ui({ conversationId: "c5", sessionId: "s1" }))?.key).toBe("c1");
	});

	it("两个都变了才是另一条对话：新 key", () => {
		const k1 = nextListKey(null, ui({ conversationId: "c1", sessionId: "s1" }));
		expect(nextListKey(k1, ui({ conversationId: "c2", sessionId: "s2" }))?.key).toBe("c2");
	});

	it("一样的输入返回同一个对象（渲染里调用两次也稳定）", () => {
		const k1 = nextListKey(null, ui());
		expect(nextListKey(k1, ui())).toBe(k1);
	});

	it("没有会话 id（DSH）：按对话 id", () => {
		const k1 = nextListKey(null, ui({ conversationId: "c1", sessionId: undefined }));
		expect(nextListKey(k1, ui({ conversationId: "c2", sessionId: undefined }))?.key).toBe("c2");
		expect(nextListKey(k1, ui({ conversationId: "c1", sessionId: undefined }))?.key).toBe("c1");
	});
});
