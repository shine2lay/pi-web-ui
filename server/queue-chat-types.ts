import type { ChatSpeed, UiTaskLaunch } from "./protocol.js";

/** What startChat gets, checked. */
export interface QueueChatStart {
	cwd: string;
	name: string;
	prompt: string;
	entries: { customType: string; data: unknown }[];
	/** "provider/id" */
	model?: string;
	thinking?: string;
	speed?: ChatSpeed;
	launch?: UiTaskLaunch;
	/** Queue extension commits the completed snapshot synchronously; false cancels a stale launch. */
	onPrepared?: (launch: UiTaskLaunch) => boolean;
}

/** Whether a chat is working now (see chatState). */
export type ChatStateName = "working" | "idle" | "closed";

export interface ChatState {
	state: ChatStateName;
	/** When it last did something: its transcript's last write (ms). Missing when that can't be read. */
	lastActiveAt?: number;
	/** Running-list turn start (ms); absent when no turn is known to run. */
	turnSince?: number;
	/** Active helper chats; absent when none. A paused chat may still have active helpers. */
	subagents?: number;
}
