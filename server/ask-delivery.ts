/**
 * ask_user_question's waiting cards as the windows see them — pure functions, unit-tested.
 *
 * multi-device: a card belongs to its chat, not to a window. The list is process-wide; `question_pending` goes to
 * every connected window of its owner (whichever chat it shows), any of them may answer, the first answer wins and
 * the others get `question_retracted`. nonblocking-ask (Ops #1087): the tool no longer waits, so a card with no window
 * open just waits on disk (pending-questions-store.ts) and comes back with the next window's snapshot or on Telegram.
 */

import type { ServerMessage, UiPendingQuestion, UiQuestion } from "./protocol.js";
import type { QuestionAcceptanceSource } from "./queue-question-acceptance.js";

/** One waiting card's live state (pending-questions-runtime.ts). */
export interface PendingQuestionEntry {
	questions: UiQuestion[];
	/** The chat that asks (not necessarily the one a window shows). */
	conversationId?: string;
	/** Its title when asked: a window showing another chat must see who asks. */
	conversationTitle?: string;
	/** Its id in the list of asks (server/asks.ts); the same as its question id. */
	askId: string;
	/** Its key in pending-questions.json: the tool call id (per owner for a split call). */
	recordId: string;
	/** The asking chat's transcript: a card put back after a restart finds its chat by it. */
	sessionFile?: string;
	/** Native source at presentation; not a queue/question binding or answer authority. */
	nativeSource?: QuestionAcceptanceSource;
	/** Kept for later (Shine m104353): it pops up nowhere, its chat shows the reopen bar. */
	later?: boolean;
}

/** The message every window gets for a waiting question, named after the chat that asks. */
export function questionPendingMessage(
	id: string,
	entry: Pick<PendingQuestionEntry, "questions" | "conversationId" | "conversationTitle">,
): Extract<ServerMessage, { type: "question_pending" }> {
	return {
		type: "question_pending",
		id,
		questions: entry.questions,
		...(entry.conversationId !== undefined ? { conversationId: entry.conversationId } : {}),
		...(entry.conversationTitle ? { conversationTitle: entry.conversationTitle } : {}),
	};
}

/** What the model was told before Ops #1087 when no page was open. Never the outcome now (NB-4 checks it isn't):
 *  a card with no window open waits on disk and reaches Telegram. */
export const ASK_USER_NO_CLIENT_ERROR =
	"No pi-web-ui page is connected, so the user cannot be asked (no browser connected). " +
	"Write the question to the user directly in your reply; do not call ask_user_question again.";

type SnapshotEntry<Q> = { questions: Q; conversationId?: string; conversationTitle?: string; later?: boolean };

const cardOf = <Q>(id: string, p: SnapshotEntry<Q>) => ({
	id,
	questions: p.questions,
	...(p.conversationId ? { conversationId: p.conversationId } : {}),
	...(p.conversationTitle ? { conversationTitle: p.conversationTitle } : {}),
});

/** The card a window's snapshot pops up: the shown chat's (`activeId`) own first, else the first one shown to it from
 *  any chat (a refresh brings it back). One kept for later never pops up again, over its own chat or another (Shine
 *  m104353). */
export function pickPendingQuestionForSnapshot<Q>(
	entries: Iterable<[string, SnapshotEntry<Q>]>,
	activeId?: string,
): { id: string; questions: Q; conversationId?: string; conversationTitle?: string } | null {
	const live = [...entries].filter(([, p]) => !p.later);
	const [id, p] = live.find(([, e]) => activeId !== undefined && e.conversationId === activeId) ?? live[0] ?? [];
	return id !== undefined && p ? cardOf(id, p) : null;
}

/** The cards kept for later that a window showing `activeId` offers in its reopen bar: that chat's own. */
export function savedQuestionsOf(
	entries: Iterable<[string, SnapshotEntry<UiQuestion[]>]>,
	activeId: string | undefined,
): UiPendingQuestion[] {
	const saved: UiPendingQuestion[] = [];
	for (const [id, p] of entries) if (p.later && p.conversationId === activeId) saved.push(cardOf(id, p));
	return saved;
}
