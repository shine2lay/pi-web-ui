/**
 * nonblocking-ask (Ops #1087, Task 2 of 2; Shine 2026-11-24, dr-36efc6499afe: "Non-blocking everywhere", and m104353:
 * "lets make it so questions can be kept for later"): the live side of ask_user_question's cards.
 *
 * The tool posts one card per owner and returns at once (formatPostedQuestionsResult); the chat's turn ends. Each card
 * is kept in pending-questions-store.ts ("waiting") and shown everywhere (the windows' question_pending, the list of
 * asks: Telegram, the Roles page, the chat list's "?"). How it ends:
 * - answered or cancelled (a window, Telegram, a plugin) or handed back by COO: recorded "delivering" first, every
 *   window closes it, then the wake goes into the asking chat as the owner's message (queued behind a running turn,
 *   reopening a closed chat) and the card leaves the file once the chat took it;
 * - its chat closed or was force-reset: dropped with no wake.
 * A window closing never ends a card (it waits on disk); a restart puts waiting cards back and replays a
 * "delivering" one once. Keep for later: the owner tucks a card away (`later`), it stops popping up over chats but stays
 * open everywhere, and its own chat shows a one-line bar to reopen it.
 * ClientSession (agent-service.ts) owns the process-wide map and the windows; this file holds the rules.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type PendingQuestionEntry, questionPendingMessage } from "./ask-delivery.js";
import { planOwnerSlices, type QuestionOwnerData, sliceToolCallId } from "./ask-question-owners.js";
import { askUserQuestionParameters } from "./ask-question-schema.js";
import {
	type Ask,
	type AskAnswerFn,
	type AskRouteInput,
	askHub,
	isAskHeld,
	questionAsk,
	summarizeQuestionAnswers,
} from "./asks.js";
import { routeOfAsk } from "./owner-question-surfaces.js";
import {
	formatPostedQuestionsResult,
	type PendingQuestionDelivering,
	type PendingQuestionsHost,
	type PostedQuestionCard,
	type QuestionResolution,
	questionWakeOf,
} from "./pending-questions-store.js";
import type { QuestionAnswer, ServerMessage, UiQuestion } from "./protocol.js";
import { wakeInTranscript } from "./question-wake-admission.js";
import { answeredBy, personSentBy } from "./sent-by.js";

/** What the rules need from ClientSession's statics. */
export interface QuestionRuntimeHost {
	/** The process-wide waiting cards, keyed by their question id (= their ask id). */
	readonly shared: Map<string, PendingQuestionEntry>;
	/** The durable list and the way wakes go in (AgentService sets it; none: nothing is kept or woken). */
	store(): PendingQuestionsHost | null;
	/** To every window, or with `ask` only to its owner's windows (owner-requester, Ops #1051). */
	broadcast(msg: ServerMessage, ask?: Ask): void;
	/** Every window's chat list (the "?" marks). */
	conversationsChanged(): void;
	/** Every window's snapshot (held cards, the saved-for-later bar). */
	snapshotsChanged(): void;
}

/** A card as ClientSession builds it, before it is posted. */
export interface NewCard {
	entry: PendingQuestionEntry;
	ask: Ask;
	owner: string;
	route?: AskRouteInput;
}

/** Post one owner's card: kept on disk, in the list of asks, and shown in the owner's windows (none while it is held
 *  for COO: its own chat's page shows it). Never waits for an answer. */
export function postCard(host: QuestionRuntimeHost, card: NewCard, onAnswer: AskAnswerFn): void {
	const { entry, ask } = card;
	host.store()?.store.post({
		id: entry.recordId,
		askId: ask.id,
		toolCallId: entry.recordId,
		...(entry.conversationId !== undefined ? { conversationId: entry.conversationId } : {}),
		...(ask.sessionFile ? { sessionFile: ask.sessionFile } : {}),
		...(entry.conversationTitle ? { conversationTitle: entry.conversationTitle } : {}),
		owner: card.owner,
		...(ask.requester ? { requester: ask.requester } : {}),
		questions: entry.questions,
		createdAt: Date.now(),
	});
	showCard(host, ask.id, entry, ask, onAnswer, card.route);
}

function showCard(
	host: QuestionRuntimeHost,
	id: string,
	entry: PendingQuestionEntry,
	ask: Ask,
	onAnswer: AskAnswerFn,
	route?: AskRouteInput,
): void {
	host.shared.set(id, entry);
	askHub.add(ask, onAnswer, route);
	const kept = askHub.get(id);
	if (isAskHeld(kept)) {
		host.snapshotsChanged();
		return;
	}
	host.conversationsChanged();
	if (!entry.later) host.broadcast({ ...questionPendingMessage(id, entry), ...routeOfAsk(kept) }, kept);
}

/** How a card ends: the owner's answers, his cancel, or COO's hand-back (whose ask the router already settled). */
export type CardEnd =
	| { kind: "answered"; answers: QuestionAnswer[]; from: string }
	| { kind: "cancelled"; from: string }
	| { kind: "returned"; note: string };

/** End a waiting card: recorded as delivering, settled in the list of asks, closed in every window, then its wake
 *  goes into the asking chat. False when it no longer waits (answered elsewhere first). */
export function settleCard(host: QuestionRuntimeHost, id: string, end: CardEnd): boolean {
	const entry = host.shared.get(id);
	if (!entry) return false;
	host.shared.delete(id);
	const { by } = answeredBy();
	const pq = host.store();
	// Rule 37 (Ops #1088 D2): the wake is the answerer's message (`[From: <name>]`, its sender in the transcript); kept
	// in the record so a replay after a restart carries it too. COO's hand-back is not an owner's message.
	const sentBy = personSentBy(by ?? pq?.store.get(entry.recordId)?.owner ?? "");
	const summary = end.kind === "answered" ? summarizeQuestionAnswers(entry.questions, end.answers) : "";
	const resolution: QuestionResolution =
		end.kind === "answered"
			? { kind: "answered", answers: end.answers, summary, from: end.from, ...(by ? { by } : {}), sentBy }
			: end.kind === "cancelled"
				? { kind: "cancelled", from: end.from, ...(by ? { by } : {}), sentBy }
				: { kind: "returned", note: end.note };
	const settled = pq?.store.settle(entry.recordId, resolution);
	if (end.kind === "answered")
		askHub.settle(entry.askId, {
			how: "answered",
			summary,
			from: end.from,
			answers: end.answers.map((a) => ({
				id: a.id,
				selected: a.selected ?? [],
				...(a.custom ? { text: a.custom } : {}),
			})),
		});
	else if (end.kind === "cancelled")
		askHub.settle(entry.askId, { how: "gone", reason: `cancelled in the ${end.from}` });
	host.broadcast({ type: "question_retracted", id });
	host.conversationsChanged();
	if (pq && settled?.ok) void deliverWake(pq, settled.record);
	return true;
}

const deliveringNow = new Set<string>();

/** Put a settled card's wake into its chat; once it is in the chat's transcript (not just pi's in-memory queue behind
 *  a busy turn: Ops #1088 D1), the card leaves the file. A refused or unfinished delivery keeps it as delivering
 *  (replayed at the next start, never twice: restoreCards). */
async function deliverWake(pq: PendingQuestionsHost, record: PendingQuestionDelivering): Promise<void> {
	if (deliveringNow.has(record.id)) return;
	deliveringNow.add(record.id);
	try {
		const out = await pq
			.deliver(questionWakeOf(record))
			.catch((err: Error) => ({ ok: false as const, error: err.message }));
		if (!out.ok) console.warn(`[pending-questions] ${record.id}: the answer did not reach its chat yet: ${out.error}`);
		else if (!out.admitted) pq.store.admitted(record.id);
		else void out.admitted.then(() => pq.store.admitted(record.id));
	} finally {
		deliveringNow.delete(record.id);
	}
}

/** The chat closed or was force-reset: its cards end with no wake, off disk, closed in every window. */
export function dropChatCards(host: QuestionRuntimeHost, conversationId: string, why: string): void {
	let any = false;
	for (const [id, entry] of [...host.shared]) {
		if (entry.conversationId !== conversationId) continue;
		host.shared.delete(id);
		host.store()?.store.drop(entry.recordId);
		askHub.settle(entry.askId, { how: "gone", reason: why });
		host.broadcast({ type: "question_retracted", id });
		any = true;
	}
	if (any) host.conversationsChanged();
}

/** Keep a card for later (`later` true: tucked away in every window of its owner, still open everywhere, 0 cancels
 *  and 0 wakes) or bring it back up (false). False when it no longer waits. */
export function setCardLater(host: QuestionRuntimeHost, id: string, later: boolean): boolean {
	const entry = host.shared.get(id);
	if (!entry) return false;
	if (later) entry.later = true;
	else delete entry.later;
	host.store()?.store.setLater(entry.recordId, later);
	const ask = askHub.get(entry.askId);
	host.broadcast(
		later ? { type: "question_retracted", id } : { ...questionPendingMessage(id, entry), ...routeOfAsk(ask) },
		ask,
	);
	host.snapshotsChanged();
	return true;
}

/** What a restart needs from ClientSession to put a card back. */
export interface RestoreHooks {
	nextId(): string;
	/** The chat's id in this process (by its transcript), when it is open. */
	conversationIdOf(sessionFile: string): string | undefined;
	onAnswer(id: string): AskAnswerFn;
}

/** The delivering cards each store already replayed in this process (a second start-up pass replays none). */
const replayed = new WeakMap<object, Set<string>>();

/** A card put back while its chat was closed has no chat id yet (ids are per process): it gets one once the chat with
 *  its transcript is open, so the chat's "?" and its reopen bar find it. */
export function bindRestoredCards(host: QuestionRuntimeHost, conversationIdOf: (file: string) => string | undefined) {
	for (const entry of host.shared.values()) {
		if (entry.conversationId !== undefined || !entry.sessionFile) continue;
		const id = conversationIdOf(entry.sessionFile);
		if (id !== undefined) entry.conversationId = id;
	}
}

/** At start-up: every waiting card back on every surface (once: already shown ones are skipped), every delivering
 *  one's wake replayed once. A card of a chat with no transcript (its chat is gone with the old process) ends. */
export async function restoreCards(host: QuestionRuntimeHost, hooks: RestoreHooks): Promise<void> {
	const pq = host.store();
	if (!pq) return;
	const shownRecords = new Set([...host.shared.values()].map((e) => e.recordId));
	for (const rec of pq.store.waiting()) {
		if (shownRecords.has(rec.id)) continue;
		if (!rec.sessionFile) {
			pq.store.drop(rec.id);
			continue;
		}
		const id = hooks.nextId();
		// Chat ids are per process: the old one may name another chat now; the open chat with its transcript, or none yet.
		const conversationId = hooks.conversationIdOf(rec.sessionFile);
		const meta = {
			...(conversationId !== undefined ? { conversationId } : {}),
			...(rec.conversationTitle ? { conversationTitle: rec.conversationTitle } : {}),
			sessionFile: rec.sessionFile,
			...(rec.requester ? { requester: rec.requester } : {}),
		};
		const entry: PendingQuestionEntry = {
			questions: rec.questions,
			askId: id,
			recordId: rec.id,
			sessionFile: rec.sessionFile,
			...(conversationId !== undefined ? { conversationId } : {}),
			...(rec.conversationTitle ? { conversationTitle: rec.conversationTitle } : {}),
			...(rec.later ? { later: true } : {}),
		};
		const ask: Ask = { ...questionAsk(id, rec.questions, meta, rec.createdAt), toolCallId: rec.toolCallId };
		showCard(host, id, entry, ask, hooks.onAnswer(id));
	}
	const done = replayed.get(pq.store) ?? new Set<string>();
	replayed.set(pq.store, done);
	for (const rec of pq.store.delivering()) {
		if (done.has(rec.id)) continue;
		done.add(rec.id);
		// Already in its transcript (the last run stopped between writing it and the card leaving the file): 0 sends.
		if (!rec.sessionFile || wakeInTranscript(rec.sessionFile, questionWakeOf(rec).text, rec.settledAt))
			pq.store.admitted(rec.id);
		else await deliverWake(pq, rec);
	}
}

// ---------------------------------------------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------------------------------------------

/** Whose card it is: his name, and (another owner's) the requester his windows and Telegram go by (Ops #1051). */
export interface CardOwner {
	owner: string;
	requester?: string;
}

/** What the tool needs from its chat's ClientSession (bridgeTarget). */
export interface AskUserQuestionBridge {
	/** Post one owner's card under this tool call id; throws (nothing shown) when questions are turned off. */
	postQuestion(questions: UiQuestion[], toolCallId: string, conversationId: string | undefined, owner: CardOwner): void;
	/** ask-question-owners (Ops #1079): the chat's requester records and people.json's names. */
	questionOwners(conversationId?: string): QuestionOwnerData;
}

/**
 * The standard engine's ask_user_question (a customTool, like bash/edit; the DSH engine asks through goal-rpc). It
 * checks the call (1-3 questions; each question's owner from data, ask-question-owners.ts), posts one card per owner
 * and returns at once; the answers come later as new messages in the chat.
 */
export function makeAskUserQuestionTool(
	bridge: AskUserQuestionBridge,
	/** The chat this runtime belongs to: the card follows it. */
	ownerId?: string,
): ToolDefinition {
	return {
		name: "ask_user_question",
		label: "Ask the user",
		description:
			"Ask the user focused questions to clarify ambiguous requirements (clarify the task, confirm decisions, get preferences). " +
			"Strictly ask 1 to 3 questions per call (prefer 1, max 3); provide 2 to 4 mutually exclusive options with the " +
			"recommended option first, and explain impact/tradeoff in each option description. " +
			"Each question renders a browser dialog with markdown/HTML rich text; options may carry a `preview`. " +
			"Non-blocking: the call posts the question and returns at once; the answer arrives later as a new message " +
			"in this chat. Set `owner` on each question when the turn is for several owners or asks another owner.",
		promptSnippet: "ask the user 1-3 focused questions with recommended options and tradeoffs to clarify requirements",
		promptGuidelines: [
			"When requirements are ambiguous, use ask_user_question to clarify instead of guessing: " +
				"ask 1 to 3 focused questions (prefer 1, max 3), provide 2-4 mutually exclusive options with the " +
				"recommended option first, and explain impact/tradeoff in description",
			"ask_user_question does not wait: after it posts, do not ask the same thing again and do not wait or poll; " +
				"finish work that doesn't depend on the answer, then end your turn. The answer (or a cancel) arrives as a " +
				"new message in this chat; respect a cancel and continue without re-asking immediately",
			"ask_user_question: when a turn carries work for more than one owner (e.g. Shine and Wai), or you ask an owner " +
				"other than the one the turn is for, set `owner` on every question; each owner gets his own dialog",
		],
		parameters: askUserQuestionParameters,
		execute: async (toolCallId: string, params: unknown): Promise<unknown> => {
			const qs = (params as { questions: UiQuestion[] }).questions;
			if (!Array.isArray(qs) || qs.length === 0) throw new Error("ask_user_question requires at least one question");
			if (qs.length > 3)
				throw new Error("ask_user_question allows at most 3 questions per call to prevent question fatigue");
			// Each question's owner from data, refused before anything is shown when unclear (Ops #1079).
			const slices = planOwnerSlices(qs, bridge.questionOwners(ownerId));
			const posted: PostedQuestionCard[] = slices.map((slice) => {
				const id = slices.length === 1 ? toolCallId : sliceToolCallId(toolCallId, slice.owner);
				bridge.postQuestion(slice.questions, id, ownerId, {
					owner: slice.owner,
					...(slice.requester ? { requester: slice.requester } : {}),
				});
				return { owner: slice.owner, toolCallId: id, questions: slice.questions };
			});
			return formatPostedQuestionsResult(posted);
		},
	} as unknown as ToolDefinition;
}
