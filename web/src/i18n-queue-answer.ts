/**
 * The Queue tab's answer card on a task that waits on the user: its hints and what it says when an
 * answer doesn't go through (frontend #286).
 *
 * Split out of `i18n.tsx` so the card's states can be named without growing that file; the strings
 * are spread back into `en`, so `t("taskQueueAnswerSend")` and friends keep working unchanged.
 */
export const queueAnswerEn = {
	taskQueueAnswerHint: "Answer in the chat and it carries on.",
	taskQueueAnswerInChat: "Answer in its own chat and it carries on.",
	taskQueueAnswerPlaceholder: "Or type your answer",
	taskQueueAnswerSend: "Send",
	taskQueueAnswerGoesHere: "Your answer goes into this chat and the task carries on.",
	taskQueueAnswerGoesToTaskChat: "Your answer goes into the task's own chat and it carries on.",
	// frontend #286: a card that can't take an answer says so instead of showing dead buttons.
	taskQueueAnswerUnavailable: "This card can't take an answer right now. Answer in the task's own chat.",
	taskQueueAnswerUnavailableHere: "This card can't take an answer right now. Answer in the chat.",
	// frontend #286: an answer that didn't go through. The card keeps the words and offers a retry.
	taskQueueAnswerRetry: "Try again",
	taskQueueAnswerNoReply: "No reply from the server, so your answer may not have gone through.",
	taskQueueAnswerRefused: "Your answer didn't go through: {reason}.",
	taskQueueAnswerFailed: "Your answer didn't go through.",
	taskQueueAnswerOffline: "The connection dropped before your answer was confirmed.",
	taskQueueAnswerStale: "This question changed before your answer was sent. Check it first.",
	taskQueueAnswerMovedOn: "This question moved on while your answer was on its way. Check the card first.",
} as const;
