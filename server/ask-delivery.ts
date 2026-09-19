/**
 * ask_user_question 的投递判定 —— 纯函数，有单测。
 *
 * 背景（这两条合起来就是「问卷不弹」的根因）：
 *  1. `askUser` **故意不设超时**——等的是人，不是挂死的工具（见 agent-service.ts
 *     的注释）。所以它永远不会自己回来。
 *  2. `emit` 在 `sinks` 为空（没有任何页面连着）时是**静默丢弃**的。
 *  两者相遇 = `question_pending` 没人收到、对话框不出现、这轮 agent 永远阻塞。
 *  同文件里的 `pageCall` 早就有 `sinks.size === 0` 的守卫，`askUser` 漏了。
 *
 * multi-device（本轮）：问卷属于**对话**，不属于某个客户端。注册表是进程共享的，
 * `question_pending` 广播给**所有连着的客户端**（不管它在看哪条对话），任何一台都能
 * 回答，第一个答的生效、其余的收到 `question_retracted` 自动关掉。于是「在笔记本上被
 * 问、走到台式机上回答」是成立的。下面的 clientCount 一律指**全进程**的在线客户端数，
 * 不再是某个 ClientSession 自己的 sinks。
 *
 * 但不能一看见「当前没连页面」就立刻报错：刷新页面 / WS 重连有个几秒的空窗，
 * 那种情况下用户马上就回来了，报错反而把好好的提问打掉。所以给一个宽限期：
 *  - 提问时有页面连着 → 立即走即时通道（原行为不变）；
 *  - 没有 → 先挂着、等 `ASK_USER_NO_CLIENT_GRACE_MS`：
 *      · 期间有页面接上 → 快照会把对话框补出来（见 pickPendingQuestionForSnapshot），
 *        不需要补发即时消息；
 *      · 到点还是没有 → 拒掉，让模型知道「没人在线」，可以改用正文提问而不是干等。
 */

import type { QuestionAnswer, UiQuestion } from "./protocol.js";

/** 一张待答问卷的服务端状态。 */
export interface PendingQuestionEntry {
	resolve: (value: QuestionAnswer[] | null) => void;
	questions: UiQuestion[];
	/** 发起提问的对话（不一定是用户当前在看的那条）。 */
	conversationId?: string;
	/** 发起提问的对话标题 —— 别的设备可能正在看别的对话，要能看出这是谁在问。 */
	conversationTitle?: string;
	/** 「没页面连着」时的宽限计时器；答完/取消/dispose 都要清掉。 */
	graceTimer?: ReturnType<typeof setTimeout>;
}

/** 没有页面连着时，等待页面回来的宽限期（毫秒）。刷新/重连通常 1-3 秒。 */
export const ASK_USER_NO_CLIENT_GRACE_MS = 30_000;

/** 宽限期满仍无人在线时给模型的错误（与 pageCall 的无页面错误同一口径）。 */
export const ASK_USER_NO_CLIENT_ERROR =
	"没有已连接的 pi-web-ui 页面，无法向用户提问（no browser connected）。" +
	"请直接在回答里把问题写给用户，不要再调用 ask_user_question。";

/** 提问那一刻：有页面就即时推（广播给所有在线客户端），没有就先挂着等。
 *  clientCount = 全进程在线客户端数。 */
export function askDeliveryOnAsk(clientCount: number): "emit" | "grace" {
	return clientCount > 0 ? "emit" : "grace";
}

/** 某个客户端 dispose 了，它名下的问卷该不该一起取消？
 *
 *  以前问卷是「本客户端自己的东西」，dispose 就连带取消 —— multi-device 之后这是
 *  错的：关掉笔记本那一页，不该把台式机还能回答的问卷打掉（而 client-per-load 之后
 *  每次刷新都会 dispose 一个旧会话，等于每次刷新都打掉自己的问卷）。
 *  只有「一台都不剩」时才取消，否则留给还连着的设备。 */
export function shouldCancelOnClientDispose(args: { connectedClientsLeft: number }): "cancel" | "keep" {
	return args.connectedClientsLeft > 0 ? "keep" : "cancel";
}

/** 宽限期到点：只有「仍在等待 且 依旧没有任何页面」才拒。
 *  - 已被回答/取消（stillPending=false）→ 什么都不做，别去动别人的 promise；
 *  - 期间有页面接上 → 交给快照恢复，保持挂起。 */
export function askDeliveryOnGraceExpiry(args: { clientCount: number; stillPending: boolean }): "reject" | "keep" {
	if (!args.stillPending) return "keep";
	return args.clientCount > 0 ? "keep" : "reject";
}

/** 快照要带上的待答提问。
 *
 *  以前这里按 `conversationId === activeId` 过滤，只肯把「当前对话」的提问放进
 *  快照——于是「提问时没人在线」的问卷只有在用户**恰好回到那条对话**时才会重新
 *  出现；打开别的对话 → 快照里是 null → 对话框永远不回来，而服务端还阻塞着。
 *  对话框是问卷的唯一入口，侧栏没有任何「这条对话在等你回答」的提示，所以丢了
 *  就是真丢了。改为：不分对话一律带上，由 `conversationId` 告诉前端它属于谁。 */
export function pickPendingQuestionForSnapshot<Q>(
	entries: Iterable<[string, { questions: Q; conversationId?: string; conversationTitle?: string }]>,
): { id: string; questions: Q; conversationId?: string; conversationTitle?: string } | null {
	for (const [id, p] of entries) {
		return {
			id,
			questions: p.questions,
			...(p.conversationId ? { conversationId: p.conversationId } : {}),
			...(p.conversationTitle ? { conversationTitle: p.conversationTitle } : {}),
		};
	}
	return null;
}
