/**
 * reload-adopt 补丁：新连接接入时「接管已经开着的对话」而不是从磁盘再恢复一份。
 *
 * 背景：`server-owned-chats` 已经把对话归给了服务端（`ClientSession.sharedConvs`），
 * 一条对话在整个进程里只有一个 runtime，第二个 writer 在结构上不可能出现。但
 * `ClientSession.create()` 仍然沿用上游写法：每个新连接一律 `continueRecent(cwd)`,
 * 也就是**从磁盘再恢复一份**最近的转录 —— 于是同一份 JSONL 被两个 runtime 打开。
 * 上游用 issue #145 那套「别处正在跑 → 停在空白对话 + 提示」来兜这个洞，而
 * client-per-load 之后每次刷新都是新 clientId，那个提示就变成了「你自己刷新前的
 * 那个窗口」，用户被自己的上一秒挡在了自己的对话外面。
 *
 * 这里换成共享表的口径：这个 cwd 下**已经开着**的对话直接接管。刷新回到原处，
 * 也不需要任何提示。
 */

/** 接管候选：共享对话表里的一条（只取判断需要的字段，便于单测）。 */
export interface AdoptCandidate {
	id: string;
	cwd: string;
	/** 最后一次被某个客户端切到/使用的时间戳。 */
	lastActiveAt: number;
	/** 子代理对话（`sa-*`）也在共享表里，而且跟父对话同一个 cwd。 */
	isSubagent: boolean;
}

/**
 * 挑出新连接应当接管的对话；没有则返回 null（此时照常从磁盘恢复）。
 *
 * 口径与「切项目」那条路径一致（`Prefer the target project's own most recently
 * active conversation`）：同 cwd 里 `lastActiveAt` 最大的一条。并列时先到先得，
 * 保证同一份输入永远得到同一个结果。
 *
 * **子代理对话永不入选**：它跟父对话同 cwd，建立时 `lastActiveAt = Date.now()`，
 * 所以刚派出一个子代理就刷新的话，不过滤就会直接把用户丢进子代理会话里。
 * （共享表里按 cwd 挑对话的地方都过滤它，见 `conv.cwd !== cwd || conv.isSubagent`。）
 */
export function pickAdoptTarget(cwd: string, candidates: Iterable<AdoptCandidate>): string | null {
	let best: AdoptCandidate | undefined;
	for (const c of candidates) {
		if (c.cwd !== cwd || c.isSubagent) continue;
		if (!best || c.lastActiveAt > best.lastActiveAt) best = c;
	}
	return best?.id ?? null;
}
