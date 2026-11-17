/**
 * The task a queued task's chat works on, read from its own entries (pi-queue's "assigned" first entry).
 * Moved unchanged out of role-messages.ts by owner-requester (Ops #973), which adds the task's `origin`
 * (who asked, with the owner's person when not the default) for owner asks and message_role.
 */
import { chatPersonOf } from "./owner-requester.js";
import type { UiTaskRequester } from "./protocol.js";
import { requesterOfTurn, type RequesterTurn } from "./queue-requester.js";
import * as tagRules from "./role-message-tags.js";
import { taskQueueFromEntries, taskQueueHeld, type TaskQueueEntryLike } from "./task-queue.js";

export type OwnTask = {
	id?: number;
	done: boolean;
	queueChat?: string;
	held: boolean;
	/** owner-requester (Ops #973): who the task is for (its origin as queued). */
	origin?: UiTaskRequester;
} & tagRules.WorkerTaskTags;

/** The task a queued task's chat works on (from its own entries); undefined = not a task's chat.
 *  queue-paused: `held`: its own chat recorded the owner's pause (the queue's chat tells it). */
export function ownTaskOf(entries: Iterable<TaskQueueEntryLike>): OwnTask | undefined {
	const q = taskQueueFromEntries(entries, true, Number.POSITIVE_INFINITY);
	if (!q.from) return undefined;
	const own = q.tasks[0];
	return {
		id: own?.id,
		...tagRules.taskTagFacts(own),
		// queue-drop: a task its lead dropped is over too.
		done: !own || own.status === "done" || own.status === "dropped",
		queueChat: q.from.file,
		held: !!own && !!taskQueueHeld(own, q),
		...(own?.origin ? { origin: own.origin } : {}),
	};
}

/** A live chat, as far as who its work is for goes. */
export interface RequesterChat {
	turnRecord?: RequesterTurn;
	session: { sessionManager: { getBranch(): Iterable<TaskQueueEntryLike> } };
}

/** owner-requester (Ops #973): `{ requester }` when a chat's work (its running turn's, else its own task's) is
 *  for a named owner such as Wai; `{}` for the default owner (Shine). Asks, message_role and plugin tools use it. */
export function chatRequester(conv: RequesterChat | undefined): { requester?: string } {
	if (!conv) return {};
	let origin: UiTaskRequester | undefined;
	try {
		origin = ownTaskOf(conv.session.sessionManager.getBranch())?.origin;
	} catch {
		origin = undefined; // runtime being replaced
	}
	const person = chatPersonOf(requesterOfTurn(conv.turnRecord), origin);
	return person ? { requester: person } : {};
}
