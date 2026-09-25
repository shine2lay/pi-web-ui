/**
 * switch-cache：浏览器里给看过的对话留一份，切回来时只取差异（纯函数 + 一个小 LRU，不碰 React）。
 *
 * 以前切回一条对话，服务端每次都整份重发最新一截（大会话 300 多 KB），页面整份重新渲染。
 * 现在：
 *  - 每条对话最后显示的那份状态按转录路径记在 ChatCache 里（最多 CHAT_CACHE_MAX 条，最久没看的先扔）；
 *  - 切回去时 switch_* 带上 `have`（cachedWindow：会话 id + 窗口起点/条数 + id 指纹），
 *    点下去的那一刻聊天区就先显示缓存的这份（预览，遮罩透明但照样挡住输入）；
 *  - 服务端对得上就只发新增的尾巴 + `reuse`，applyReuse 把缓存那截接在前面。缓存那截的消息对象
 *    原样沿用，已经渲染出来的行不用重画。对不上 → 客户端要一份完整的（get_state）。
 *
 * 用转录路径做键：对话 id 是服务端进程内的序号，重启后会重号；从历史重新打开的对话也会换 id。
 */
import { messagesHash } from "../../server/window-hash.js";
import type { CachedWindow, SwitchTarget, UiState } from "./types";

/** 最多记几条对话（和服务端每个项目最多开着的对话数一致）。 */
export const CHAT_CACHE_MAX = 8;

function pathKey(p: string): string {
	// 和 switch-pending.ts 的 sameSessionPath 一样只做分隔符归一。
	return p.replace(/\\/g, "/");
}

export class ChatCache {
	private readonly byPath = new Map<string, UiState>();

	constructor(private readonly max = CHAT_CACHE_MAX) {}

	/** 记下（或刷新）一条对话当前显示的状态。只存引用；没有转录路径或还没有消息的不记。 */
	put(ui: UiState | null | undefined): void {
		if (!ui?.sessionFile || !ui.sessionId || ui.messages.length === 0) return;
		const key = pathKey(ui.sessionFile);
		// 删了再放 = 挪到最近使用的一端（Map 按插入顺序迭代）。
		this.byPath.delete(key);
		this.byPath.set(key, ui);
		while (this.byPath.size > this.max) {
			const oldest = this.byPath.keys().next().value;
			if (oldest === undefined) break;
			this.byPath.delete(oldest);
		}
	}

	get(path: string | null | undefined): UiState | undefined {
		return path ? this.byPath.get(pathKey(path)) : undefined;
	}

	/** 切换目标对应的缓存。活对话按左栏那一行的转录路径找（行上没有路径就不认，
	 *  免得服务端重启后对话 id 重号、认错人）。 */
	forTarget(target: SwitchTarget, conversations: readonly { id: string; sessionFile?: string }[]): UiState | undefined {
		if (target.kind === "session") return this.get(target.path);
		return this.get(conversations.find((c) => c.id === target.id)?.sessionFile);
	}

	get size(): number {
		return this.byPath.size;
	}
}

/** 缓存里这份状态的窗口描述（随 switch_* 发给服务端）。没有消息就没有窗口。 */
export function cachedWindow(ui: UiState): CachedWindow | null {
	if (!ui.sessionId || ui.messages.length === 0) return null;
	return {
		sessionId: ui.sessionId,
		start: ui.messagesStart ?? 0,
		count: ui.messages.length,
		hash: messagesHash(ui.messages),
	};
}

/** 一个窗口的唯一键：发出去的 have 和服务端回的 reuse 靠它对上当时用的那份缓存（连点几条时不串）。 */
export function windowKey(w: CachedWindow): string {
	return `${w.sessionId}|${w.start}|${w.count}|${w.hash}`;
}

/** 服务端回了 `reuse`：把缓存那截接在新增的尾巴前面。缓存对不上（会话不同、窗口变了、
 *  指纹不一样）返回 null，调用方去要一份完整快照。 */
export function applyReuse(base: UiState | null | undefined, snap: UiState, reuse: CachedWindow): UiState | null {
	if (!base || base.sessionId !== reuse.sessionId || snap.sessionId !== reuse.sessionId) return null;
	if ((base.messagesStart ?? 0) !== reuse.start || base.messages.length < reuse.count) return null;
	if (messagesHash(base.messages, 0, reuse.count) !== reuse.hash) return null;
	return {
		...snap,
		messages:
			reuse.count === base.messages.length && snap.messages.length === 0
				? base.messages
				: [...base.messages.slice(0, reuse.count), ...snap.messages],
		messagesStart: reuse.start,
	};
}

/** MessageList 的 key 随显示的状态往前推：对话 id 或会话 id 有一个没变就沿用原来的 key。
 *  - 对话 id 没变、会话换了：改写分支（fork），和以前一样不重建列表；
 *  - 会话没变、对话 id 换了：预览（缓存里的旧 id）换成从历史重开后的真快照，列表也不该整个重建
 *    （那正是这个补丁要省的渲染）。
 *  两个都变了才是另一条对话，用它的对话 id 做新 key。纯函数：同样的输入总是同样的输出。 */
export interface ListKey {
	key: string;
	conversationId: string;
	sessionId: string;
}

export function nextListKey(prev: ListKey | null, ui: UiState | null | undefined): ListKey | null {
	if (!ui) return null;
	const conversationId = ui.conversationId ?? "";
	const sessionId = ui.sessionId ?? "";
	const same =
		prev !== null &&
		((conversationId !== "" && prev.conversationId === conversationId) ||
			(sessionId !== "" && prev.sessionId === sessionId));
	const key = same ? prev.key : conversationId || sessionId || "boot";
	if (prev && prev.key === key && prev.conversationId === conversationId && prev.sessionId === sessionId) return prev;
	return { key, conversationId, sessionId };
}
