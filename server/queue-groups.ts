/**
 * queue-grouping: in the left panel's chat list, an open queued task's own chat ("Queue #n: …") sits under
 * the chat whose queue it came from (its home chat: tooling, RollCall, temper), the way a subagent sits
 * under its parent. Display only: the queue and the task chats work as before.
 *
 * Where the links come from: the queue state the server already replays for the Queue tab
 * (taskQueueFromEntries, cached per chat in ClientSession.taskQueueOfConv). Nothing here reads a chat's
 * file or walks its history, and building the list only looks the links up.
 * - A task's own chat names the queue it came from (UiTaskQueue.from) and keeps its task's state;
 *   pi-queue: "the task's chat is the truth about the task".
 * - A queue chat lists its tasks' chats (tasks[].chat) and follows them.
 * Links outlive the chats being open (and restarts: client-state.json), so a task chat that is only a
 * Recent chats row stays under its home chat while neither chat is open.
 *
 * Pure functions + unit tests: tests/unit/queue-groups.test.ts.
 */
import { resolve } from "node:path";
import type { ConversationSummary, UiTaskQueue } from "./protocol.js";

/** pi-queue's open task states (task-queue.ts OPEN): not done and not removed. */
const OPEN: ReadonlySet<string> = new Set(["ready", "working", "asking", "stuck", "waiting"]);

/** At most this many links are kept; the oldest go first. */
export const QUEUE_HOMES_MAX = 500;
/** stall-watch: at most this many queue chats are opened after a restart (queueHomesToOpen). */
export const QUEUE_HOMES_REOPEN_MAX = 10;

/** An open chat's queue as cached (undefined: not worked out yet, so nothing is learned from it). */
export interface LoadedQueue {
	/** The chat's transcript. */
	file: string;
	queue: UiTaskQueue | undefined;
}

/** A task's own chat holds only its task (pi-queue refuses queue_add there): is that task still open? */
const ownTaskOpen = (queue: UiTaskQueue): boolean => queue.tasks.some((t) => OPEN.has(t.status));

/** What a chat's queue says about the links, as one string (to notice when it changes them). */
export function queueLinksSig(queue: UiTaskQueue | undefined): string {
	if (!queue) return "";
	if (queue.from) return `from\u0001${queue.from.file}\u0001${ownTaskOpen(queue) ? "open" : "closed"}`;
	return queue.tasks
		.filter((t) => t.chat?.file)
		.map((t) => `${t.chat?.file}\u0001${OPEN.has(t.status) ? "open" : "closed"}`)
		.join("\u0002");
}

function sameLinks(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
	if (a.size !== b.size) return false;
	for (const [k, v] of a) if (b.get(k) !== v) return false;
	return true;
}

/**
 * Open task chats → the queue chat each came from (transcripts, resolved): the open chats' queues over
 * what was known before (`known`, left as it is). Returns `known` itself when nothing changed.
 */
export function queueHomesFrom(
	loaded: readonly LoadedQueue[],
	known: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
	const next = new Map(known);
	// A queue chat: its open tasks' chats are under it; the ones it no longer lists as open aren't
	// (done, removed, or done so long ago that the queue dropped them).
	for (const { file, queue } of loaded) {
		if (!queue || queue.from) continue;
		const home = resolve(file);
		const open = new Set<string>();
		for (const t of queue.tasks) if (t.chat?.file && OPEN.has(t.status)) open.add(resolve(t.chat.file));
		for (const [chat, h] of next) if (h === home && !open.has(chat)) next.delete(chat);
		for (const chat of open) if (chat !== home) next.set(chat, home);
	}
	// A task's own chat has the last word on its task. It also knows its queue before the queue has heard
	// of the chat (pi-queue writes the chat's first entry before it tells the queue).
	for (const { file, queue } of loaded) {
		if (!queue?.from?.file) continue;
		const chat = resolve(file);
		const home = resolve(queue.from.file);
		if (home !== chat && ownTaskOpen(queue)) next.set(chat, home);
		else next.delete(chat);
	}
	while (next.size > QUEUE_HOMES_MAX) {
		const oldest = next.keys().next().value;
		if (oldest === undefined) break;
		next.delete(oldest);
	}
	return sameLinks(next, known) ? known : next;
}

/**
 * stall-watch: the queue chats to open after a restart, so pi-queue's watchdog looks after their tasks'
 * chats: each queue chat the links name (an open task's chat → its queue chat) once, newest link first,
 * only those whose transcript is still there, at most QUEUE_HOMES_REOPEN_MAX.
 */
export function queueHomesToOpen(homes: ReadonlyMap<string, string>, exists: (file: string) => boolean): string[] {
	const out: string[] = [];
	for (const [chat, home] of [...homes].reverse()) {
		if (out.length >= QUEUE_HOMES_REOPEN_MAX) break;
		if (chat === home || out.includes(home)) continue;
		if (exists(home)) out.push(home);
	}
	return out;
}

/**
 * Gives each row whose chat is an open task of a queue chat in the same list that row's id
 * (`queueHomeId`). Rows only, no reads. A task chat whose queue chat isn't listed stays a normal row.
 */
export function applyQueueHomes(rows: ConversationSummary[], homes: ReadonlyMap<string, string>): void {
	if (homes.size === 0) return;
	const keyed: Array<[ConversationSummary, string]> = [];
	const idOf = new Map<string, string>();
	for (const r of rows) {
		if (!r.sessionPath || r.isSubagent) continue;
		const key = resolve(r.sessionPath);
		keyed.push([r, key]);
		if (!idOf.has(key)) idOf.set(key, r.id);
	}
	for (const [r, key] of keyed) {
		const home = homes.get(key);
		const homeId = home === undefined ? undefined : idOf.get(home);
		if (homeId !== undefined && homeId !== r.id) r.queueHomeId = homeId;
	}
}
