/**
 * 切换对话的「进行中 / 失败」状态（switch-loading 补丁）—— 纯函数，不碰 React。
 *
 * 以前点左栏一条对话，界面纹丝不动，直到服务端把整份转录序列化完推来新快照
 * （大会话要好几秒）。用户看到的是「点了没反应」，于是再点一次、或者点别的。
 * 现在：发出 switch_* 的那一刻就记下目标（pendingSwitch），聊天区盖一层「正在打开…」，
 * 左栏高亮立刻挪到目标行；服务端回执（switch_done / switch_failed）或一份对得上
 * 目标的快照到达时撤掉。失败留在原地，把原因显示出来并给一个「重试」。
 *
 * 为什么同时认「回执」和「快照对上」两种结束信号：回执是主信号（引擎无关，DSH 的
 * 快照没有 sessionFile，按路径根本对不上）；快照对上是保险 —— 万一某条服务端路径
 * 漏发回执，只要要的那条对话已经显示出来了，就没理由还盖着「正在打开」。
 */
import type { SwitchTarget } from "./types";

export interface PendingSwitch {
	target: SwitchTarget;
	/** 发出请求的时刻（ms），遮罩层据此显示「已等待 N 秒」。 */
	startedAt: number;
	/** 用户点了「隐藏」：遮罩不显示，但左栏的目标行仍然标着打开中。 */
	hidden: boolean;
}

export interface SwitchError {
	target: SwitchTarget;
	error: string;
	errorEn?: string;
}

/** 转录路径比较：只做分隔符归一（Windows 的 `\`），不做大小写/符号链接解析 ——
 *  两边都是服务端 list_sessions 给出的同一份字符串，过度归一反而会把不同文件当成一个。 */
export function sameSessionPath(a: string | undefined | null, b: string | undefined | null): boolean {
	if (!a || !b) return false;
	return a.replace(/\\/g, "/") === b.replace(/\\/g, "/");
}

export function sameSwitchTarget(a: SwitchTarget | null | undefined, b: SwitchTarget | null | undefined): boolean {
	if (!a || !b || a.kind !== b.kind) return false;
	return a.kind === "session"
		? sameSessionPath(a.path, (b as { path: string }).path)
		: a.id === (b as { id: string }).id;
}

/** 这份快照显示的就是目标对话吗（保险信号，见文件头）。 */
export function switchTargetReached(
	target: SwitchTarget,
	ui: { sessionFile?: string; conversationId: string } | null | undefined,
): boolean {
	if (!ui) return false;
	return target.kind === "session" ? sameSessionPath(ui.sessionFile, target.path) : ui.conversationId === target.id;
}

/** 已经显示着目标了就不必进入「打开中」（左栏本来就拦了点当前行，这里是给全局搜索
 *  等不拦的入口兜底，否则永远等不到一份「新」快照）。 */
export function switchAlreadyShown(
	target: SwitchTarget,
	ui: { sessionFile?: string; conversationId: string } | null | undefined,
): boolean {
	return switchTargetReached(target, ui);
}

/** 左栏某一行是不是正在打开的目标（活行按 id 或转录路径，历史行按路径）。 */
export function isSwitchTargetRow(
	target: SwitchTarget | null | undefined,
	row: { id?: string; sessionPath?: string; path?: string },
): boolean {
	if (!target) return false;
	if (target.kind === "conversation") return row.id === target.id;
	return sameSessionPath(row.sessionPath ?? row.path, target.path);
}

/** 遮罩上显示的目标名：会话列表的名字/首条消息 → 运行列表的标题 → 路径尾巴。
 *  在渲染时解而不是点击时记：发送入口不止左栏一个（全局搜索、插件），它们不一定知道标题。 */
export function switchTargetTitle(
	target: SwitchTarget,
	sessions: readonly { path: string; name?: string; firstMessage?: string }[],
	conversations: readonly { id: string; title: string; sessionPath?: string }[],
): string {
	if (target.kind === "conversation") {
		return conversations.find((c) => c.id === target.id)?.title ?? target.id;
	}
	const s = sessions.find((x) => sameSessionPath(x.path, target.path));
	const fromSession = (s?.name ?? "").trim() || (s?.firstMessage ?? "").trim();
	if (fromSession) return fromSession.length > 60 ? `${fromSession.slice(0, 60)}…` : fromSession;
	const live = conversations.find((c) => sameSessionPath(c.sessionPath, target.path));
	if (live) return live.title;
	return target.path.replace(/\\/g, "/").split("/").pop() || target.path;
}

/** 快照到达：结束对得上的 pending / error。返回 null 表示什么都不用改。 */
export function settleOnSnapshot(
	pending: PendingSwitch | null,
	error: SwitchError | null,
	ui: { sessionFile?: string; conversationId: string } | null | undefined,
): { pendingSwitch: PendingSwitch | null; switchError: SwitchError | null } | null {
	const clearPending = pending !== null && switchTargetReached(pending.target, ui);
	// 之前失败的那条现在显示出来了（别的路径打开了它）→ 错误态也没意义了。
	const clearError = error !== null && switchTargetReached(error.target, ui);
	if (!clearPending && !clearError) return null;
	return { pendingSwitch: clearPending ? null : pending, switchError: clearError ? null : error };
}
