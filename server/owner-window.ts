// ---------------------------------------------------------------------------
// owner-window.ts — what one browser window shows of the owner's asks
// ---------------------------------------------------------------------------
// Two rules decide it, both in owner-question-surfaces.ts: owner-question routing (Ops #685: an ask held for
// COO first, or a queued task's card not made yet, isn't the owner's yet; switch on only) and owner-requester
// (Ops #1051: an ask is shown only in the windows of the owner it is for, askIsForViewer). ClientSession hands
// in a chat's facts; this file puts the rules together for each window surface: the chat list's needs-you line,
// pi-queue's pop-up notice, the "Needs decision" label and the page's passive "Waiting on <name>" line.
// docs/owner-question-routing.md.
// ---------------------------------------------------------------------------

import { resolve } from "node:path";
import { type Ask, askHub, isAskHeld } from "./asks.js";
import {
	dialogAskId,
	lineAboutOtherOwnersTask,
	lineAboutUnseenCard,
	linesAboutHeldAsks,
	linesAboutOtherOwnersAsks,
	queueNoticeAboutOtherOwner,
	queueNoticeAboutUnseenCard,
	queueStatusesShownToOwner,
	taskIsOtherOwners,
} from "./owner-question-surfaces.js";
import { askIsForViewer, askOwnerName, type OwnerViewer, waitingOnLine } from "./owner-requester.js";
import type { UiDialog, UiTaskQueue, UiTaskQueueTask, UiTldrLine } from "./protocol.js";

/** A listed chat as the owner-question rules need it. `reached` is set only while routing (#685) is on: whether
 *  the queued task's card for `target` (a task chat's transcript) has reached the owner. */
export interface OwnerChatFacts {
	chatFile: string | undefined;
	tasks: readonly UiTaskQueueTask[];
	reached: ((target: string) => boolean) | undefined;
}

/** The open queues' stuck tasks by their own chat's transcript (resolved): whose answer each task chat waits on. */
export type StuckTaskChats = ReadonlyMap<string, UiTaskQueueTask>;

/** Whether a window of `viewer` gets `ask` (popped up, listed, counted, alerted): it is his (owner-requester). */
export function viewerSees(ask: Ask | undefined, viewer: OwnerViewer): boolean {
	return askIsForViewer(ask?.requester, viewer);
}

/** No "?", Needs you or count for `ask` in this window: held for COO first (its page shows it) or another owner's. */
export function askHiddenFrom(ask: Ask | undefined, viewer: OwnerViewer): boolean {
	return isAskHeld(ask) || !viewerSees(ask, viewer);
}

/** The chat list's needs-you line (and so the lead bar) waits: the chat's latest TL;DR line asks the owner about an
 *  ask not his yet (held for COO, a card not made yet) or another owner's ask or queued-task card. */
export function needsYouLineHidden(
	lines: readonly UiTldrLine[],
	viewer: OwnerViewer,
	facts: () => OwnerChatFacts,
): boolean {
	const last = lines[lines.length - 1];
	if (!last?.needsYou || last.answered) return false;
	try {
		const { chatFile, tasks, reached } = facts();
		const asks = [...askHub.list(), ...askHub.heldList()];
		if (chatFile && linesAboutOtherOwnersAsks(lines, chatFile, asks, viewer).has(last.id)) return true;
		if (lineAboutOtherOwnersTask(last.chat?.file, tasks, viewer)) return true;
		if (!reached) return false;
		return (
			(chatFile !== undefined && linesAboutHeldAsks(lines, chatFile, askHub.heldList()).has(last.id)) ||
			lineAboutUnseenCard(last.chat?.file, chatFile, tasks, reached)
		);
	} catch {
		return false; // the line shows as before rather than the chat list failing
	}
}

/** pi-queue's "Task #N needs you" pop-up notice waits: its card hasn't reached the owner yet, or is another owner's. */
export function queueNoticeHidden(message: string, viewer: OwnerViewer, facts: () => OwnerChatFacts): boolean {
	try {
		const { chatFile, tasks, reached } = facts();
		if (queueNoticeAboutOtherOwner(message, tasks, viewer)) return true;
		return reached !== undefined && queueNoticeAboutUnseenCard(message, chatFile, tasks, reached);
	} catch {
		return false; // the notice shows as before rather than the extension's call failing
	}
}

/** The open queues' stuck tasks by their own chat's transcript. */
export function stuckTaskChatsOf(queues: Iterable<{ queue: UiTaskQueue }>): StuckTaskChats {
	const out = new Map<string, UiTaskQueueTask>();
	for (const { queue } of queues)
		for (const t of queue.tasks) if (t.status === "stuck" && t.chat?.file) out.set(resolve(t.chat.file), t);
	return out;
}

/** left-task-status as `viewer` sees it: no "Needs decision" on a task chat stuck on another owner's answer, nor
 *  (routing on, `reached` set) on one whose card hasn't reached the owner yet. */
export function queueStatusesForViewer<S extends { kind: string }>(
	statuses: ReadonlyMap<string, S>,
	stuck: StuckTaskChats,
	viewer: OwnerViewer,
	reached: ((target: string) => boolean) | undefined,
): ReadonlyMap<string, S> {
	const others = [...stuck.values()].some((t) => taskIsOtherOwners(t, viewer));
	if (!reached && !others) return statuses;
	return queueStatusesShownToOwner(
		statuses,
		(file) => !taskIsOtherOwners(stuck.get(resolve(file)), viewer) && (!reached || reached(file)),
	);
}

/** The asks a chat waits on, by its pending questions, permission prompts and dialog (ids into askHub). */
export interface ChatPendingAsks {
	conversationId: string | undefined;
	questions: Iterable<[string, { conversationId?: string; askId?: string }]>;
	approvals: Iterable<[string, { conversationId?: string }]>;
	dialog: Pick<UiDialog, "id"> | null | undefined;
}

/** The chat list's "?" for a chat's pop-up: not one held for COO (its page shows it), nor another owner's. */
export function dialogIdListed(dialog: Pick<UiDialog, "id"> | null, viewer: OwnerViewer): { dialogId?: number } {
	return dialog && !askHiddenFrom(dialogAskOf(dialog), viewer) ? { dialogId: dialog.id } : {};
}

/** A chat pop-up's ask in the list of asks (telegram-answers). */
export function dialogAskOf(dialog: Pick<UiDialog, "id"> | null | undefined): Ask | undefined {
	return dialog ? askHub.get(dialogAskId(dialog)) : undefined;
}

/** The page's passive line: "Waiting on <name>" when the chat shown waits on another owner's answer, else null.
 *  Nothing of the ask itself (no question, options or answer form). */
export function waitingOnLineFor(pending: ChatPendingAsks, viewer: OwnerViewer): string | null {
	const ids: string[] = [];
	for (const [id, p] of pending.questions) if (p.conversationId === pending.conversationId) ids.push(p.askId ?? id);
	for (const [id, p] of pending.approvals) if (p.conversationId === pending.conversationId) ids.push(id);
	if (pending.dialog) ids.push(dialogAskId(pending.dialog));
	const other = ids.flatMap((id) => askHub.get(id) ?? []).find((a) => !viewerSees(a, viewer));
	return other ? waitingOnLine(askOwnerName(other.requester, viewer)) : null;
}
