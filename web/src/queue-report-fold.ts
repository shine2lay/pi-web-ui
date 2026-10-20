/**
 * queue-fold (fork patch, Ops #267): which messages are the queue's reports, and the one line each shows
 * while it is folded. Pure; display only (the transcript and what the model reads don't change).
 *
 * The owner, 2026-10-19: "i also want queue reports in chat collapsed by default"; which ones: "queue
 * reports, by plugin". Both kinds pi-queue posts into a chat:
 *  - notes: custom messages whose customType starts with "queue-" (queue-report, queue-wait, and
 *    pi-web-ui's own queue-paused);
 *  - report cards: user messages whose text starts with "[Queue] " (done, on hold, blocked, lead and Ops
 *    cards, reminders, decisions, answers, needs the user, dropped, wake-ups, back to work…).
 * A task's own plan stays open: the message that starts it (pi-queue queue.ts kickoffText and
 * taskKickoffText), told by its fixed second paragraph. The owner's own messages never fold: only a text
 * that starts with "[Queue] " is a card, so one that mentions [Queue] later stays open.
 */
import type { UiMessage } from "./types";

/** How every report card's text starts. */
export const QUEUE_CARD_HEAD = "[Queue] ";
/** customType prefix of the queue's notes. */
export const QUEUE_NOTE_TYPE = "queue-";
/** kickoffText's second paragraph: a task worked in the queue's own chat. */
export const PLAN_HERE = "The user planned this task with you and approved the plan.";
/** taskKickoffText's second paragraph: a task in a chat of its own ("… started by the queue in the chat "X". …"). */
const PLAN_OWN_CHAT =
	/^You're working on this task in a chat of its own, started by the queue in .+\. The user planned it there and approved the plan\./;
/** Both start messages' first line: "[Queue] Task #N: <title>". */
const PLAN_HEAD = /^\[Queue\] Task #\d+: /;

type Foldable = Pick<UiMessage, "role" | "customType" | "content">;

/** The message's text blocks, joined (no text when its content isn't a list of blocks). */
function textOf(m: Foldable): string {
	let out = "";
	if (!Array.isArray(m.content)) return out;
	for (const b of m.content)
		if (b.type === "text" && typeof (b as { text?: unknown }).text === "string") out += (b as { text: string }).text;
	return out;
}

/** A task's own plan: the message pi-queue starts a task with. Stays open. */
export function isQueuePlanText(text: string): boolean {
	if (!PLAN_HEAD.test(text)) return false;
	const gap = text.indexOf("\n\n");
	if (gap < 0) return false;
	const second = text.slice(gap + 2);
	return second.startsWith(PLAN_HERE) || PLAN_OWN_CHAT.test(second);
}

/**
 * The folded row's line when `m` is a queue report: its first line without the "[Queue] " head (the row
 * says Queue already), spaces collapsed. null: not a queue report, shown as before.
 */
export function queueReportFold(m: Foldable): string | null {
	if (m.role === "custom" ? !m.customType?.startsWith(QUEUE_NOTE_TYPE) : m.role !== "user") return null;
	const text = textOf(m);
	if (m.role === "user" && !text.startsWith(QUEUE_CARD_HEAD)) return null;
	if (isQueuePlanText(text)) return null;
	const first = text.split("\n").find((l) => l.trim()) ?? "";
	return first
		.replace(/^\s*\[Queue\]\s*/, "")
		.replace(/\s+/g, " ")
		.trim();
}
