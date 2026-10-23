/** Roles actions describe capability, never consent. All targets stay in memory. */
import type { ChatFocus } from "./chat-focus";
import type { NeedsYou, NeedsYouItem, UsefulOpenTarget } from "./roles-useful-model";

export interface NativeDialogSummary {
	sessionFile?: string;
	dialogId?: number;
}
export const QUESTION_ACTION_REASONS = {
	unconfirmed: "Current questions are not confirmed. Open chat to check; no answer is sent by navigation.",
	missing: "The original chat is not available from this page.",
	unverified: "An exact current answer target could not be verified. Open chat to check the question.",
	native:
		"This native question is not the chat’s currently shown dialog. Open chat to check; another question may come first.",
} as const;
export type QuestionAction =
	| { kind: "inline" }
	| { kind: "chat"; target: UsefulOpenTarget }
	| { kind: "unavailable"; reason: keyof typeof QUESTION_ACTION_REASONS };

/** Summaries expose only the oldest native dialog. Never infer that a later or ordinary question
 *  can be selected by focus: native questionnaires have a different, independently selected id. */
export function questionAction(
	needs: NeedsYou,
	item: NeedsYouItem,
	dialogs: readonly NativeDialogSummary[] = [],
	inlineAvailable = true,
): QuestionAction {
	if (needs.tell !== "can-tell") return { kind: "unavailable", reason: "unconfirmed" };
	if (item.answer && inlineAvailable) return { kind: "inline" };
	if (!item.link) return { kind: "unavailable", reason: "missing" };
	if (!item.chatAnswer || !item.link.focus) return { kind: "unavailable", reason: "unverified" };
	if (item.link.focus.kind === "question") {
		const matches = dialogs.filter((row) => row.sessionFile === item.link?.file);
		const id = matches.length === 1 ? matches[0].dialogId : undefined;
		if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || item.link.focus.id !== `dlg-${id}`)
			return { kind: "unavailable", reason: "native" };
	}
	return { kind: "chat", target: item.link };
}

/** Retained callbacks re-resolve the complete opaque identity, never the feed index or label.
 *  A newly stuck task/restarted dialog must not inherit an older action even if its number repeats. */
export function resolveQuestionAction(
	needs: NeedsYou,
	item: NeedsYouItem,
	dialogs: readonly NativeDialogSummary[],
	kind: "inline" | "chat",
): { item: NeedsYouItem; action: QuestionAction } | null {
	const matches = needs.items.filter(
		(row) =>
			row.roleId === item.roleId &&
			row.since === item.since &&
			JSON.stringify(row.link) === JSON.stringify(item.link) &&
			(kind === "inline"
				? !!item.answer && row.answer?.key === item.answer.key && row.answer?.id === item.answer.id
				: !!item.chatAnswer && row.chatAnswer?.key === item.chatAnswer.key && !row.answer),
	);
	if (matches.length !== 1) return null;
	const action = questionAction(needs, matches[0], dialogs);
	return action.kind === kind ? { item: matches[0], action } : null;
}

/** Final arrival guard: focus the non-submitting native container only after the actual chat and
 *  actual rendered dialog match. A window-owned dialog masking it is not a match. */
export function nativeDialogFocusMatches(
	focus: ChatFocus | null,
	file: string | undefined,
	dialogId: number | undefined,
): boolean {
	return (
		!!focus &&
		focus.file === file &&
		focus.kind === "question" &&
		typeof dialogId === "number" &&
		Number.isSafeInteger(dialogId) &&
		dialogId > 0 &&
		focus.id === `dlg-${dialogId}`
	);
}
