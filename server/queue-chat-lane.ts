import { basename, resolve } from "node:path";
import { makeChain, waitUntil } from "./queue-host.js";
import { isQueueTaskChatEntries, isQueueTaskChatFile } from "./task-queue.js";

/**
 * Maximum time `queueCloseChat` waits for a finished task chat to go idle before
 * logging a warning and leaving the still-working chat open without blocking the close lane.
 * Must stay above Ops #771's 10-minute settle window so legitimate post-`queue_done` replies finish undisturbed.
 */
export const QUEUE_CLOSE_DEADLINE_MS = 15 * 60_000;

export type QueueLaneChain = <T>(fn: () => Promise<T>) => Promise<T>;

export interface QueueCloseSessionView {
	isStreaming?: boolean;
	isCompacting?: boolean;
	sessionManager: {
		getEntries(): unknown[];
		getSessionName?(): string | undefined;
	};
}

export interface QueueCloseClientView {
	releaseQueueChat(file: string): boolean;
}

export interface QueueCloseHostContext {
	clients: Map<string, QueueCloseClientView>;
	stateStore: { removeRecent(path: string): void };
	queueSessionFor(file: string): QueueCloseSessionView | null;
	queueCloseChain?: QueueLaneChain;
	queueCloseDeadlineMs?: number;
}

/**
 * Wait (up to `queueCloseDeadlineMs`, default 15 minutes) for a finished task's chat to go idle,
 * then release it on the dedicated `queueCloseChain` (separate from `queueTasksChain` so closing
 * a finished chat never blocks opening a new task chat). If the chat is still streaming or compacting
 * at the deadline, log loudly naming the chat and leave it open (never disposing a chat mid-turn).
 */
export async function runQueueCloseChat(
	host: QueueCloseHostContext,
	file: string,
	onRecentChanged: () => void,
): Promise<boolean> {
	const deadlineMs =
		typeof host.queueCloseDeadlineMs === "number" &&
		Number.isFinite(host.queueCloseDeadlineMs) &&
		host.queueCloseDeadlineMs > 0
			? host.queueCloseDeadlineMs
			: QUEUE_CLOSE_DEADLINE_MS;
	const settled = await waitUntil(
		() => {
			const session = host.queueSessionFor(file);
			return !session || (!session.isStreaming && !session.isCompacting);
		},
		deadlineMs,
		500,
	);
	if (!settled) {
		const busy = host.queueSessionFor(file);
		const name = busy?.sessionManager?.getSessionName?.()?.trim() || basename(file);
		console.warn(
			`[queue-lanes] finished task chat "${name}" (${file}) is still busy after ${deadlineMs}ms; leaving it open so its turn is not cut off`,
		);
		return false;
	}
	const open = host.queueSessionFor(file);
	const taskChat = open ? isQueueTaskChatEntries(open.sessionManager.getEntries()) : await isQueueTaskChatFile(file);
	const closeChain = (host.queueCloseChain ??= makeChain());
	return closeChain(async () => {
		if (taskChat) host.stateStore.removeRecent(resolve(file));
		for (const cs of host.clients.values()) {
			try {
				if (cs.releaseQueueChat(file)) return true;
			} catch {
				// try the next client
			}
		}
		if (taskChat) onRecentChanged();
		return taskChat;
	});
}
