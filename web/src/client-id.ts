// gate-light-tests (Ops #251, docs/gate-light-tests.md): getClientId has its own module, moved unchanged from
// use-chat.ts, so tests/unit/client-id.test.ts loads only this and ./uuid on each fresh page load it simulates,
// not use-chat's whole graph. use-chat.ts imports it and re-exports it for its other importers.
import { randomUuid } from "./uuid";

let cachedClientId: string | null = null;

/**
 * 客户端标识 —— **每次页面加载独立**（不落任何存储）。
 *
 * 演进：localStorage（同源所有标签页共用一个 id → 后端挂到同一个 ClientSession
 * 上互为镜像，B 页切对话把 A 页也切走、甚至中断 A 正在输出的 agent，issue #10）
 * → sessionStorage（每标签页独立，但「复制标签页」/ Ctrl-点链接 / 恢复上次会话
 * 会把它一起克隆，两个窗口照样共用一个 id，镜像原样复现）
 * → 现在：每次加载现生一个，撞车在构造上不可能。
 */
export function getClientId(): string {
	// 每次页面加载一个**全新**的 id，不落任何存储。
	//
	// 为什么不持久化：id 相同 = 后端挂到同一个 ClientSession = 两个窗口互为镜像
	// （一边切对话另一边跟着变，issue #10 的老毛病）。sessionStorage 看似每标签页
	// 独立，但「复制标签页」/ Ctrl-点链接 / 恢复上次会话都会把它一起克隆，于是
	// 两个窗口又拿到同一个 id。改成每次加载现生，撞车在构造上就不可能发生。
	//
	// 代价（刻意接受）：刷新后不再自动回到上次那条对话 —— 对话本身在服务端好好
	// 跑着，左栏「最近对话」里点回去就是。工作目录另有 localStorage 记忆（见 use-chat.ts
	// 的 lastCwd），不依赖 clientId。
	cachedClientId ??= randomUuid();
	return cachedClientId;
}
