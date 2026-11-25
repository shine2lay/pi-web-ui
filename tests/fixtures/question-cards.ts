// nonblocking-ask (Ops #1087): ask_user_question posts a card and returns; its answer reaches the chat later as a wake.
// For tests written around "ask, then see what the owner's answer was", this asks through the real tool (its owners
// from the chat's data, ClientSession.postQuestion) into a temporary pending-questions.json and gives back a promise of
// what the card's wake carries: the answers, COO's hand-back `{ returned }`, or null for a cancel.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientSession, makeAskUserQuestionTool } from "../../server/agent-service.js";
import { PendingQuestionsStore, type QuestionWake } from "../../server/pending-questions-store.js";
import type { QuestionAnswer, UiQuestion } from "../../server/protocol.js";

export type CardOutcome = QuestionAnswer[] | { returned: string } | null;

let seq = 0;

/** Install a temporary card store as ClientSession's; `close()` restores the previous one and deletes the folder. */
export function questionCards() {
	const dir = mkdtempSync(join(tmpdir(), "question-cards-"));
	const store = PendingQuestionsStore.inDataDir(dir);
	const waiting = new Map<string, (outcome: CardOutcome) => void>();
	const wakes: QuestionWake[] = [];
	const prior = ClientSession.pendingQuestionsHost;
	ClientSession.pendingQuestionsHost = {
		store,
		deliver: async (wake) => {
			wakes.push(wake);
			const rec = store.get(wake.id);
			const r = rec?.state === "delivering" ? rec.resolution : undefined;
			waiting.get(wake.id)?.(
				r?.kind === "answered" ? r.answers : r?.kind === "returned" ? { returned: r.note } : null,
			);
			waiting.delete(wake.id);
			return { ok: true };
		},
	};
	return {
		store,
		wakes,
		/** ask_user_question from `conversationId` (one owner's questions), shown at once; resolves with what its wake
		 *  carries. */
		ask(client: ClientSession, questions: UiQuestion[], conversationId: string, toolCallId?: string): Promise<CardOutcome> {
			const id = toolCallId ?? `toolu_card_${++seq}`;
			const outcome = new Promise<CardOutcome>((resolve) => waiting.set(id, resolve));
			const tool = makeAskUserQuestionTool(
				{
					postQuestion: (q, callId, convId, owner) => client.postQuestion(q, callId, convId, owner),
					questionOwners: (convId) => client.questionOwners(convId),
				},
				conversationId,
			);
			// The tool posts synchronously before its first await: the card is up when this returns.
			void tool.execute(id, { questions }, undefined, undefined, {} as never);
			return outcome;
		},
		close() {
			ClientSession.pendingQuestionsHost = prior;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
