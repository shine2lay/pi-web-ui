/**
 * done-settle（queue-panel）：「跑完」先等一下再响，一整条队列听起来是一次运行。
 *
 * pi-queue 做完一个任务、接着开始下一个时，对话会闲一下：SDK 在 agent_settled 里先跑扩展，
 * pi-queue 发下一条消息并不等它开跑，服务端就先推出一份「没在跑」。不等的话，每个任务都响一次
 * 完成、一次开始。pi-queue 的提醒（任务没做完 agent 就停了）也是这样。
 *
 * 边沿本身由上游的 `diffStreamingCues`（streaming-cues.ts）算；这里只负责「先记下、等一等、
 * 这期间又开跑就当没停过」。纯逻辑，App 只负责响铃、发通知、朗读。
 */

/** 「跑完」先等这么久再响。 */
export const DONE_SETTLE_MS = 1500;

/** 一条跑完、还没响的对话。 */
export interface DoneCue {
	id: string;
	/** 左栏里的标题（后台对话的通知用）。 */
	title?: string;
	/** 跑完时正开着的那条（通知用通用文案，朗读回答）。 */
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
