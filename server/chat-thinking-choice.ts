import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ClientStateStore } from "./client-state.js";
import type { Conversation } from "./conversation-state.js";
import { rememberLeadThinkingOwner } from "./lead-thinking.js";
import { isWorkerConversation } from "./new-chat-model.js";
import {
	chatThinkingChoice,
	effectiveScopedChoice,
	inModelChangeLane,
	latestThinkingChangeAt,
} from "./model-all-chats.js";

/** Legacy dated bulk choices retain their existing precedence and native persistence behavior. */
export function restoreThinkingChoice(
	conv: Conversation,
	store: ClientStateStore,
	createdAt: number,
): Promise<boolean> {
	return inModelChangeLane(conv, async () => {
		const isWorker = isWorkerConversation(conv);
		const press =
			store.getEffectiveChatsThinking?.(isWorker) ??
			effectiveScopedChoice(
				store.getAllChatsThinking("all"),
				store.getAllChatsThinking(isWorker ? "workers" : "leads"),
			);
		const level = chatThinkingChoice(
			press,
			createdAt,
			conv.session.thinkingLevel,
			latestThinkingChangeAt(conv.session.sessionManager.getBranch()),
		);
		if (!level) return false;
		conv.session.setThinkingLevel(level, { persist: false });
		return conv.session.thinkingLevel === level;
	});
}

/** Existing picker semantics, plus forward-only canonical-home owner provenance. */
export function setStandardThinking(session: AgentSession, level: string): void {
	const thinkingLevel = level as Parameters<AgentSession["setThinkingLevel"]>[0];
	session.setThinkingLevel(thinkingLevel, { persist: true });
	rememberLeadThinkingOwner(session, session.thinkingLevel);
	const model = session.model;
	if (model) session.settingsManager.setModelThinkingLevel(model.provider, model.id, thinkingLevel);
}
