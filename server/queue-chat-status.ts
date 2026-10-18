/**
 * left-task-status (owner 2026-10-18, Ops #213): in the left panel, an open queued task's own chat shows how
 * its task stands while it is parked: "Waiting: <what>", "Blocked on #12, temper #38", "Blocked: <need>",
 * "Needs decision", "Asking its lead", "Paused". Before, a waiting or blocked task's chat looked idle.
 *
 * Where it comes from: the queue state the server already keeps per open chat (taskQueueOfConv's cache), as
 * for queue-groups.ts and stuck-asks.ts. A task's own chat speaks for its task while it's open (pi-queue: "the
 * task's chat is the truth about the task"); its queue chat's copy only when it isn't. The queue chat has the
 * last word on the owner's pause (it records it) and on a task it closed (done, or dropped by its lead).
 * Nothing here reads a file. The page words it (web/src/queue-chat-status.ts).
 *
 * Pure functions + unit tests: tests/unit/queue-chat-status.test.ts.
 */
import { resolve } from "node:path";
import type {
	ConversationSummary,
	ElsewhereRunning,
	UiQueueChatStatus,
	UiTaskQueueHold,
	UiTaskQueueTask,
} from "./protocol.js";
import type { LoadedQueue } from "./queue-groups.js";

/** The label's own words are cut to this many characters ("…" included); the tooltip has them whole. */
export const QUEUE_STATUS_TEXT_MAX = 60;

/** pi-queue's open task states (task-queue.ts OPEN): not done, dropped or removed. */
const OPEN: ReadonlySet<string> = new Set(["ready", "working", "asking", "stuck", "waiting", "blocked"]);

/** One line, at most `max` characters, with "…" at the end when cut. */
export function cutText(text: string, max = QUEUE_STATUS_TEXT_MAX): string {
	const one = text.replace(/\s+/g, " ").trim();
	if (one.length <= max) return one;
	return `${one.slice(0, max - 1).trimEnd()}\u2026`;
}

/** "#12" in its own queue, "temper #38" in another (the Queue panel's refLabel). */
const refLabel = (r: { name: string; id: number }): string => (r.name ? `${r.name} #${r.id}` : `#${r.id}`);

/**
 * How a task stands, for its chat's row: undefined when there's nothing to say (ready: no chat yet; working:
 * its chat says so itself; done, dropped). The owner's pause comes first (`held`: on the task or its whole queue).
 */
export function queueChatStatus(task: UiTaskQueueTask, held?: UiTaskQueueHold): UiQueueChatStatus | undefined {
	if (!OPEN.has(task.status) || task.status === "ready") return undefined;
	if (held) return { kind: "paused", text: "", ...(held.why ? { detail: held.why } : {}), since: held.at };
	switch (task.status) {
		case "waiting": {
			const w = task.wait;
			if (!w) return { kind: "waiting", text: "" };
			return {
				kind: "waiting",
				text: cutText(w.what),
				...(w.what ? { detail: w.what } : {}),
				since: w.since,
				everyMs: w.everyMs,
				giveUpAt: w.until,
			};
		}
		case "blocked": {
			const b = task.block;
			if (!b) return { kind: "blocked", text: "" };
			const refs = (b.on ?? []).map(refLabel).join(", ");
			// The label: the tasks it waits on, else its need, else the lead that owes the result.
			const text = refs || b.need || b.lead || "";
			return {
				kind: "blocked",
				text: cutText(text),
				...(refs || (!b.need && b.lead) ? { on: true } : {}),
				...(refs ? { refs } : {}),
				...(b.need ? { need: b.need } : {}),
				...(b.lead ? { lead: b.lead } : {}),
				...(b.lead && b.owes ? { owes: b.owes } : {}),
				since: b.since,
			};
		}
		case "stuck":
			return { kind: "stuck", text: "", ...(task.question ? { detail: task.question } : {}) };
		case "asking": {
			// The lead that has its question (the Queue panel's rule): its queue's department (askLead) or Ops when
			// askOps; else its main chat.
			const lead = task.askOps ? (task.askLead ?? "ops") : undefined;
			return {
				kind: "asking",
				text: "",
				...(task.question ? { detail: task.question } : {}),
				...(lead ? { lead } : {}),
			};
		}
		default:
			return undefined;
	}
}

/**
 * Every open task chat's status, by transcript (resolved), from the open chats' queues as cached. A queue
 * chat's own transcript never gets one (a task worked on in the queue's chat has no chat of its own).
 */
export function queueChatStatuses(loaded: readonly LoadedQueue[]): Map<string, UiQueueChatStatus> {
	// The queue chats' copies of their tasks in chats of their own, with the owner's pause on each; and the
	// task chats whose queue chat closed the task (its main chat marked it done, or its lead dropped it).
	const copies = new Map<string, { task: UiTaskQueueTask; held?: UiTaskQueueHold }>();
	const closed = new Set<string>();
	for (const { file, queue } of loaded) {
		if (!queue || queue.from) continue;
		const home = resolve(file);
		for (const t of queue.tasks) {
			if (!t.chat?.file) continue;
			const chat = resolve(t.chat.file);
			if (chat === home) continue;
			if (OPEN.has(t.status)) copies.set(chat, { task: t, held: t.hold ?? queue.hold });
			else closed.add(chat);
		}
	}
	const out = new Map<string, UiQueueChatStatus>();
	const own = new Set<string>();
	// A task's own chat, while open, speaks for its task.
	for (const { file, queue } of loaded) {
		if (!queue?.from) continue;
		const chat = resolve(file);
		own.add(chat);
		if (closed.has(chat) || chat === resolve(queue.from.file)) continue;
		const task = queue.tasks.find((t) => OPEN.has(t.status)) ?? queue.tasks[0];
		if (!task) continue;
		const copy = copies.get(chat);
		// The owner's pause as its queue chat records it; the chat's own word only while that chat isn't open.
		const held = copy ? copy.held : (task.hold ?? queue.hold);
		const status = queueChatStatus(task, held);
		if (status) out.set(chat, status);
	}
	for (const [chat, { task, held }] of copies) {
		if (own.has(chat)) continue;
		const status = queueChatStatus(task, held);
		if (status) out.set(chat, status);
	}
	return out;
}

/** The statuses as one string, to notice when they change (in key order). */
export function queueChatStatusesSig(statuses: ReadonlyMap<string, UiQueueChatStatus>): string {
	return JSON.stringify([...statuses].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Gives every row and chat running elsewhere that is an open task's chat its task's status. Rows only, no reads. */
export function applyQueueChatStatuses(
	rows: ConversationSummary[],
	elsewhere: ElsewhereRunning[],
	statuses: ReadonlyMap<string, UiQueueChatStatus>,
): void {
	if (statuses.size === 0) return;
	for (const r of rows) {
		if (!r.sessionPath || r.isSubagent) continue;
		const status = statuses.get(resolve(r.sessionPath));
		if (status) r.queueStatus = status;
	}
	for (const w of elsewhere) {
		if (!w.sessionFile) continue;
		const status = statuses.get(resolve(w.sessionFile));
		if (status) w.queueStatus = status;
	}
}
