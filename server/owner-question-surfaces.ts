// ---------------------------------------------------------------------------
// owner-question-surfaces.ts — what each owner surface shows of an ask's route (Ops #685)
// ---------------------------------------------------------------------------
// One place decides, from an ask's route alone (owner-question-router.ts sets it), what the owner's
// surfaces show: the line that says which way it came (first, before #682's brief), COO's note and
// recommendation once COO let it through, and whether it is still held. A held ask shows only on
// the asking chat's own page and the Queue tab, marked HELD_FOR_COO_LINE; plugins (Telegram), other
// windows, Needs you and the counts don't get it. An ask with no route (the switch off) shows no line,
// as before. docs/owner-question-routing.md.
// ---------------------------------------------------------------------------

import { resolve } from "node:path";
import { type Ask, type AskEvent, isAskHeld } from "./asks.js";
import type { UiDialog, UiOwnerQuestionRoute, UiTaskQueueTask, UiTldrLine } from "./protocol.js";
import { CAME_THROUGH_COO_LABEL } from "./owner-question-route.js";
import { newestWaiting, writtenForAsk } from "./roles-row.js";
import { stuckTarget } from "./stuck-asks.js";

/** The line a held ask shows where it is still shown (the asking chat's page, the Queue tab). */
export const HELD_FOR_COO_LINE = "With COO first. You can answer here.";

/** The route lines the owner sees on an ask; undefined = no line (no route, or a direct one without a label). */
export function ownerQuestionRouteView(ask: Pick<Ask, "route"> | undefined): UiOwnerQuestionRoute | undefined {
	const route = ask?.route;
	if (!route) return undefined;
	if (route.to === "direct") return route.label ? { line: route.label } : undefined;
	if (isAskHeld(ask as Ask)) return { line: HELD_FOR_COO_LINE, held: true };
	return {
		line: route.label ?? CAME_THROUGH_COO_LABEL,
		...(route.note ? { note: route.note } : {}),
		...(route.recommendation ? { recommendation: route.recommendation } : {}),
	};
}

/** Spread into a card's wire shape: `{ route }` when it has a line, nothing otherwise (off = as before). */
export function routeOfAsk(ask: Pick<Ask, "route"> | undefined): { route?: UiOwnerQuestionRoute } {
	const route = ownerQuestionRouteView(ask);
	return route ? { route } : {};
}

/**
 * Whether an AskHub event goes on to plugins (Telegram). The routing events are the router's own
 * bookkeeping; a held ask hasn't reached the owner, so nothing about it (answered on its page, gone)
 * goes out. A released one goes out as the "appeared" that follows its release.
 */
export function ownerSeesAskEvent(ev: AskEvent): boolean {
	if (ev.type === "held" || ev.type === "released" || ev.type === "returned") return false;
	return !isAskHeld(ev.ask);
}

const dialogViews = new WeakMap<UiDialog, { sig: string; view: UiDialog }>();

/**
 * An extension's dialog as its chat's page gets it: with its route lines when it has any. With none
 * (the switch off) it is the dialog itself, as before; otherwise the same view object while its lines
 * stay the same, so the snapshot sends it again only when they change.
 */
export function dialogView(dialog: UiDialog | null, ask: Pick<Ask, "route"> | undefined): UiDialog | null {
	if (!dialog) return dialog;
	const route = ownerQuestionRouteView(ask);
	if (!route) return dialog;
	const sig = JSON.stringify(route);
	const had = dialogViews.get(dialog);
	if (had && had.sig === sig) return had.view;
	const view: UiDialog = { ...dialog, route };
	dialogViews.set(dialog, { sig, view });
	return view;
}

// ---------------------------------------------------------------------------
// A chat's own needs-you line about its held ask (the left list, so the lead bar, and the Roles page)
// ---------------------------------------------------------------------------
// A chat that asks the owner mostly writes a needs-you TL;DR line just before it asks. While the ask is held
// for COO first, that line doesn't say he is needed anywhere either: it isn't the chat's row line in the
// left list (no needs-you highlight there or in the lead bar), nor a needs-you line on the Roles page, where
// it is folded into the held ask. Its line is the one the Roles page pairs with the ask: the newest waiting
// one written before it, or at most a few seconds after (roles-row.ts writtenForAsk). It shows again once
// the ask reaches him or ends. Between the line and the ask (a moment) it shows: nothing knows yet that an
// ask will follow, and a line never sounds or notifies.

/** The ids of the needs-you lines `lines` (one chat's, `chatFile`) wrote for its asks held for COO first. */
export function linesAboutHeldAsks(
	lines: readonly UiTldrLine[],
	chatFile: string | null | undefined,
	asks: Iterable<Ask>,
): Set<string> {
	const ids = new Set<string>();
	if (!chatFile) return ids;
	const file = resolve(chatFile);
	for (const ask of asks) {
		if (ask.kind === "stuck" || !isAskHeld(ask) || !ask.sessionFile || resolve(ask.sessionFile) !== file) continue;
		const line = newestWaiting(lines.filter((l) => !l.chat && writtenForAsk(l, ask.createdAt)));
		if (line) ids.add(line.id);
	}
	return ids;
}

/** Whether a window showing `windowConversationId` gets an ask from `askConversationId` popped up. */
export function shownToWindow(
	held: boolean,
	askConversationId: string | undefined,
	windowConversationId: string | undefined,
): boolean {
	return !held || (askConversationId !== undefined && askConversationId === windowConversationId);
}

// ---------------------------------------------------------------------------
// The left list (and so the lead bar): a queued task's card that hasn't reached the owner
// ---------------------------------------------------------------------------
// While the switch is on, a stuck task's card is held for COO first, and for a moment (the stuck-ask
// reconcile runs 100 ms after the queue changes) it isn't made yet. Meanwhile its chats don't say it
// needs him either: pi-queue's "Task #N needs you: <question>" TL;DR line isn't the queue chat's row
// line in the left list (no needs-you highlight there or in the lead bar; the row shows its message
// count instead), the task chat's row loses its "Needs decision" label (whose tooltip holds the
// question), and pi-queue's "Task #N needs you: <question>" pop-up notice isn't shown in the window.
// The marks come back once the card reaches him (the card itself pops up then, so the notice isn't
// needed). With the switch off nothing changes.

/** A queued task's card as the stuck-ask reconcile keeps it: its ask, and the chat its answer goes into. */
export interface StuckCardRef {
	askId: string;
	target: string;
}

/** Whether a card whose answer goes into `target` has reached the owner: made, and not held for COO first. */
export function stuckCardReachedOwner(
	target: string,
	cards: Iterable<StuckCardRef>,
	askOf: (askId: string) => Ask | undefined,
): boolean {
	const file = resolve(target);
	for (const card of cards) {
		if (resolve(card.target) !== file) continue;
		const ask = askOf(card.askId);
		if (ask && !isAskHeld(ask)) return true;
	}
	return false;
}

/**
 * Whether pi-queue's TL;DR line about the task in the chat `lineChatFile` (the line's `chat`) speaks of a
 * stuck task, in the queue of the chat `queueFile`, whose card hasn't reached the owner.
 */
export function lineAboutUnseenCard(
	lineChatFile: string | undefined,
	queueFile: string | undefined,
	tasks: readonly UiTaskQueueTask[],
	reached: (target: string) => boolean,
): boolean {
	if (!lineChatFile || !queueFile) return false;
	const about = resolve(lineChatFile);
	const task = tasks.find((t) => t.chat?.file !== undefined && resolve(t.chat.file) === about);
	if (task?.status !== "stuck") return false;
	const target = stuckTarget(queueFile, task);
	return target !== undefined && !reached(target);
}

/** pi-queue's pop-up notice for a task that needs the owner: "Task #N needs you", then the question. */
const QUEUE_NEEDS_YOU_NOTICE = /^Task #(\d+) needs you(?::|$)/;

/**
 * Whether `message`, a notice from the chat whose transcript is `queueFile`, is pi-queue's "Task #N needs
 * you" about a stuck task in that chat's queue (its own copy, in a task's chat) whose card hasn't reached
 * the owner. A task with no card to wait for (no chat to answer in) keeps its notice.
 */
export function queueNoticeAboutUnseenCard(
	message: string,
	queueFile: string | undefined,
	tasks: readonly UiTaskQueueTask[],
	reached: (target: string) => boolean,
): boolean {
	const m = QUEUE_NEEDS_YOU_NOTICE.exec(message);
	if (!m || !queueFile) return false;
	const task = tasks.find((t) => t.id === Number(m[1]));
	if (task?.status !== "stuck") return false;
	const target = stuckTarget(queueFile, task);
	return target !== undefined && !reached(target);
}

/** The task chats' row statuses (by transcript) without "Needs decision" where the card hasn't reached him. */
export function queueStatusesShownToOwner<S extends { kind: string }>(
	statuses: ReadonlyMap<string, S>,
	reached: (taskChatFile: string) => boolean,
): ReadonlyMap<string, S> {
	let shown: Map<string, S> | undefined;
	for (const [file, status] of statuses) {
		if (status.kind !== "stuck" || reached(file)) continue;
		shown ??= new Map(statuses);
		shown.delete(file);
	}
	return shown ?? statuses;
}
