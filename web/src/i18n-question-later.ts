/**
 * The model's question dialog (ask_user_question), and Keep for later (Ops #1087, Shine m104353: "lets make it so
 * questions can be kept for later"): the dialog's Later and explicit Cancel question buttons, and the one-line bar in
 * the asking chat that reopens a question kept for later.
 * The waiting-questions bell (Ops #1090, Shine 2026-11-25 m104486 "We need a way to see questions waiting for us tho",
 * m104524 "Top bar maybe a notification icon ?"): the top bar's bell, its list of the questions waiting on you, and
 * the list's buttons (`waitingQuestions*`).
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
	waitingQuestions: "Questions",
	waitingQuestionsNone: "No questions waiting",
	waitingQuestionsOne: "1 question waiting for you",
	waitingQuestionsMany: "{n} questions waiting for you",
	waitingQuestionsTitle: "Questions waiting for you",
	waitingQuestionsEmpty: "No questions waiting for you.",
	waitingQuestionsClose: "Close",
	waitingQuestionsAnswer: "Answer",
	waitingQuestionsOpenChat: "Open chat",
	waitingQuestionsCancel: "Cancel question",
	waitingQuestionsCancelTip: "Decline it: the chat is told you cancelled it",
	waitingQuestionsSaved: "Saved for later",
	waitingQuestionsChat: "A chat",
	waitingQuestionsKindQuestion: "Question",
	waitingQuestionsKindDialog: "Question",
	waitingQuestionsKindApproval: "Approval",
	waitingQuestionsKindStuck: "Task",
	waitingQuestionsOffline: "Not connected: the list may be out of date.",
};
