import { resolveQuestionAction, type NativeDialogSummary } from "../roles-answer-actions";
import { projectRoleAsk, roleAnswerForm } from "../roles-answer-model";
import { answerRoleAsk, openRoleAsk } from "../roles-answer-state";
import { reloadRoles } from "../roles-state";
import type { NeedsYou, NeedsYouItem, UsefulOpenTarget } from "../roles-useful-model";
import type { LiveTasksRolesAdaptedResult, MountedTasksRolesV8Controller, UiRoleTask } from "../tasks-roles-v8";
import type { UiRoleAskView } from "../types";
import { reloadWorkPage } from "../work-page-state";

export interface LiveV8AnswerDialogState {
	item: NeedsYouItem;
	from: HTMLElement;
	taskId: number;
	initialView?: UiRoleAskView | null;
	initialChoice?: string;
}

export interface HandleLiveV8TaskAnswerParams {
	taskId: number;
	choice: string;
	adapted: Pick<LiveTasksRolesAdaptedResult, "dataset" | "asksByTaskId" | "chatByTaskId">;
	needs: NeedsYou;
	dialogs: readonly NativeDialogSummary[];
	connected: boolean;
	fromEl: HTMLElement;
	getController: () => MountedTasksRolesV8Controller | null;
	openDialog: (state: LiveV8AnswerDialogState) => void;
	openChat?: (target: UsefulOpenTarget) => void;
	onFallbackAnswer?: (task: UiRoleTask | undefined, displayId: number, choice: string) => boolean;
}

export function markLiveV8TaskAnswered(
	ctrl: MountedTasksRolesV8Controller | null,
	taskId: number,
	choice: string,
): void {
	if (!ctrl) return;
	const prev = ctrl.getState();
	ctrl.setState({
		answeredTasks: {
			...prev.answeredTasks,
			[taskId]: choice,
		},
	});
}

export async function handleLiveV8TaskAnswer(params: HandleLiveV8TaskAnswerParams): Promise<void> {
	const {
		taskId,
		choice,
		adapted,
		needs,
		dialogs,
		connected,
		fromEl,
		getController,
		openDialog,
		openChat,
		onFallbackAnswer,
	} = params;

	const task = adapted.dataset.tasks.find((t) => t.id === taskId);
	const displayId = task?.displayId ?? taskId;
	const adaptedAsk = adapted.asksByTaskId.get(taskId) ?? adapted.asksByTaskId.get(displayId);
	const expectedTaskKey = task?.role ? `${task.role}:task:${displayId}` : undefined;

	const matchNeed =
		needs.items.find(
			(n) =>
				(adaptedAsk?.key && (n.answer?.key === adaptedAsk.key || n.chatAnswer?.key === adaptedAsk.key)) ||
				(expectedTaskKey && (n.answer?.key === expectedTaskKey || n.chatAnswer?.key === expectedTaskKey)) ||
				((!task?.role || n.roleId === task.role) &&
					(n.link?.focus?.id === String(displayId) || n.link?.focus?.id === String(taskId))),
		) ?? (task ? needs.items.find((n) => n.roleId === task.role) : undefined);

	const askKey = matchNeed?.answer?.key ?? matchNeed?.chatAnswer?.key ?? adaptedAsk?.key ?? expectedTaskKey;
	const fallbackChat: UsefulOpenTarget | null =
		matchNeed?.link ??
		adapted.chatByTaskId.get(taskId) ??
		adapted.chatByTaskId.get(displayId) ??
		(task?.chat ? { file: task.chat.file, focus: { kind: "task", id: String(displayId) } } : null);

	if (connected && askKey) {
		const reply = await openRoleAsk(askKey);
		const form = reply.ok && reply.ask ? projectRoleAsk(reply.ask) : null;
		if (form) {
			const cleanChoice = choice && choice !== "Answer question" ? choice : "";
			if (cleanChoice) {
				const firstField = form.fields[0];
				const matchedOption = firstField?.options.find((o) => o.value === cleanChoice || o.label === cleanChoice);
				if (firstField && matchedOption) {
					const drafts = new Map([[firstField.id, { selected: [matchedOption.value], text: "" }]]);
					const evaluated = roleAnswerForm(form, drafts);
					if (evaluated.complete) {
						const ansReply = await answerRoleAsk(askKey, form.id, form.revision, evaluated.answers);
						if (ansReply.ok === true) {
							markLiveV8TaskAnswered(getController(), taskId, cleanChoice);
							reloadRoles();
							reloadWorkPage();
							return;
						}
					}
				}
			}

			const dialogItem: NeedsYouItem = matchNeed
				? {
						...matchNeed,
						answer: { key: askKey, id: form.id },
						...(matchNeed.link ? {} : fallbackChat ? { link: fallbackChat } : {}),
					}
				: {
						key: askKey,
						roleId: task?.role ?? null,
						roleLabel: task?.roleTitle ?? task?.role ?? null,
						answer: { key: askKey, id: form.id },
						text: task?.stuck?.question ?? form.title,
						since: task?.stuck?.sinceAt ?? null,
						link: fallbackChat,
					};

			openDialog({
				item: dialogItem,
				from: fromEl,
				taskId,
				initialView: form,
				...(cleanChoice ? { initialChoice: cleanChoice } : {}),
			});
			return;
		}
	}

	if (matchNeed) {
		const inlineResolved = resolveQuestionAction(needs, matchNeed, dialogs, "inline");
		if (inlineResolved) {
			openDialog({
				item: inlineResolved.item,
				from: fromEl,
				taskId,
				...(choice && choice !== "Answer question" ? { initialChoice: choice } : {}),
			});
			return;
		}
		const chatResolved = resolveQuestionAction(needs, matchNeed, dialogs, "chat");
		if (chatResolved && chatResolved.action.kind === "chat" && openChat) {
			openChat(chatResolved.action.target);
			return;
		}
	}

	if (onFallbackAnswer?.(task, displayId, choice)) {
		return;
	}

	if (fallbackChat && openChat) {
		openChat(fallbackChat);
	}
}
