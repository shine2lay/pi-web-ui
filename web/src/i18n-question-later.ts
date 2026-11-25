/**
 * The model's question dialog (ask_user_question), and Keep for later (Ops #1087, Shine m104353: "lets make it so
 * questions can be kept for later"): the dialog's Later and explicit Cancel question buttons, and the one-line bar in
 * the asking chat that reopens a question kept for later.
 *
 * Split out of `i18n.tsx` so it doesn't grow; spread back into `en`, so `t("questionLater")` works as usual.
 */
export const questionLaterEn = {
	modelQuestion: "Model question",
	modelQuestionSubmit: "Submit answer",
	questionNoneAvailable: "No answerable questions under the current conditions",
	questionLater: "Later",
	questionLaterTip: "Keep it for later: it stops popping up, stays on its chat, the Roles page and Telegram",
	questionCancel: "Cancel question",
	questionCancelTip: "Decline it: the chat is told you cancelled it",
	questionSavedForLater: "Question saved for later",
	questionLaterAnswer: "Answer",
	questionLaterNext: "Next saved question",
};
