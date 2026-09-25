/**
 * done-any-chat（本 fork 补丁）：**任何一条对话**跑完都响「完成」提示音、发系统通知，
 * 不只是正开着的那条。
 *
 * - 正开着的那条仍看快照里的 `state.isStreaming`（App 里原来那个 effect）。但只认**同一条
 *   对话自己的**变化：以前从一条在跑的对话切到一条闲着的，isStreaming 从 true 变 false，
 *   会误响一次「完成」（见 `runEdge`）。
 * - 其余对话看左栏列表每一行的 `isStreaming`：上一份列表里在跑、这一份里不跑了，就是刚跑完
 *   （见 `finishedChats`）。服务端在一轮开跑和真正收尾（`agent_settled`）时把列表推给**所有**
 *   窗口，不然没订阅这条对话的窗口看不到它开始和结束。
 *
 * 这里全是纯函数，App 只负责记住上一份、响铃、发通知。「跑完」响之前先等一下，见 `DoneCues`。
 */
import type { ConversationSummary } from "./types";

/** 正开着的那条对话此刻的状态。`id` 为空 = 还没有快照（刚加载 / 切换途中）。 */
export interface RunState {
	id: string;
	streaming: boolean;
}

/**
 * 正开着的那条对话的开始 / 结束。只认同一条对话自己的变化：换了一条对话，两边的 isStreaming
 * 不一样，并不是谁开始了或结束了。`prev` 为 null（第一次观察）也不算。
 */
export function runEdge(prev: RunState | null, next: RunState): "start" | "done" | null {
	if (!prev || !next.id || prev.id !== next.id) return null;
	if (!prev.streaming && next.streaming) return "start";
	if (prev.streaming && !next.streaming) return "done";
	return null;
}

/** 上一份列表里每条要提示的对话是否在跑。 */
export type RunningSeen = ReadonlyMap<string, boolean>;

/**
 * 只提示真正的聊天：子代理跑完时它的父对话还在跑，父对话跑完自己会响（不然并行派几个子代理
 * 就响几次）；历史行（`live === false`）根本不在跑。
 */
function watched(c: ConversationSummary): boolean {
	return !c.isSubagent && c.live !== false;
}

/** 记下这一份列表里谁在跑，下一份列表拿来比。 */
export function runningSeen(list: readonly ConversationSummary[]): Map<string, boolean> {
	const seen = new Map<string, boolean>();
	for (const c of list) if (watched(c)) seen.set(c.id, c.isStreaming);
	return seen;
}

/**
 * 这一份列表里刚跑完的对话：上一份里在跑、这一份里不跑了，而且不是正开着的那条（那条归
 * `runEdge` 管，这里再算就响两次）。上一份里没有的对话不算（不知道它之前在不在跑，就不猜）；
 * `prev` 为 null（刚加载 / 刚重连）时一律不算。
 */
export function finishedChats(
	prev: RunningSeen | null,
	list: readonly ConversationSummary[],
	activeId: string,
): ConversationSummary[] {
	if (!prev) return [];
	return list.filter((c) => watched(c) && c.id !== activeId && prev.get(c.id) === true && !c.isStreaming);
}

/**
 * done-settle（queue-panel）：「跑完」先等这么久再响。
 *
 * pi-queue 做完一个任务、接着开始下一个时，对话会闲一下：SDK 在 agent_settled 里先跑扩展，
 * pi-queue 发下一条消息并不等它开跑，服务端就先推出一份「没在跑」。不等的话，每个任务都响一次
 * 完成、一次开始。pi-queue 的提醒（任务没做完 agent 就停了）也是这样。
 */
export const DONE_SETTLE_MS = 1500;

/** 一条跑完、还没响的对话。 */
export interface DoneCue {
	id: string;
	/** 左栏里的标题（后台对话的通知用）。 */
	title?: string;
	/** 跑完时正开着的那条（通知用通用文案）。 */
	open: boolean;
}

/**
 * 跑完的对话先记下，等 `settleMs`：这期间它又开跑了，就当没停过（完成和开始都不响），
 * 一整条队列听起来就是一次运行。等满了还没开跑的一起交给 `fire`（一批只响一次）。
 */
export class DoneCues {
	private readonly pending = new Map<string, DoneCue>();
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly fire: (cues: DoneCue[]) => void,
		private readonly settleMs = DONE_SETTLE_MS,
	) {}

	/** 这条对话跑完了。等的时候又有对话跑完，就从它算起再等一遍，一起响。 */
	finished(cue: DoneCue): void {
		this.pending.set(cue.id, cue);
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => this.flush(), this.settleMs);
	}

	/** 这条对话开跑了。true：它刚才的「跑完」还没响，就当没停过，开始提示也别响。 */
	started(id: string): boolean {
		if (!this.pending.delete(id)) return false;
		if (this.pending.size === 0) this.cancel();
		return true;
	}

	/** 断线 / 卸载：没响的都不响了（重连后不知道这期间谁跑过）。 */
	clear(): void {
		this.pending.clear();
		this.cancel();
	}

	private flush(): void {
		this.timer = null;
		const cues = [...this.pending.values()];
		this.pending.clear();
		if (cues.length > 0) this.fire(cues);
	}

	private cancel(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}
}
