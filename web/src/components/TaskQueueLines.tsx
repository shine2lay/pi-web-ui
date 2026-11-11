import type { ReactNode } from "react";
import type {
	UiOwnerCardBriefLine,
	UiTaskQueue,
	UiTaskQueueBlock,
	UiTaskQueueHold,
	UiTaskQueuePlan,
	UiTaskQueueRef,
	UiTaskQueueTask,
} from "../types";
import { useT, type Translate } from "../i18n";
import { lineTime } from "./TldrPanel";

export type TKey = Parameters<Translate>[0];

/** 面板按钮能发的命令（服务端 taskQueueCommandLine 转成 `/queue …`）。 */
export type TaskQueueAction =
	| "start"
	| "stop"
	| "pause"
	| "resume"
	| "up"
	| "down"
	| "remove"
	| "clear"
	| "lanes"
	| "autoApprove"
	| "autoStart"
	| "defaults"
	| "taskProfile";

export const MAX_LANES = 8;
export const DEFAULT_LANES = 2;
export const BUSY_MS = 5000;
export const TASK_QUEUE_DONE_SHOWN = 5;

export const TASK_QUEUE_PLAN_PARTS: readonly (readonly [Exclude<keyof UiTaskQueuePlan, "title">, TKey])[] = [
	["goal", "taskQueueGoal"],
	["doneWhen", "taskQueueDoneWhen"],
	["decided", "taskQueueDecided"],
	["steps", "taskQueueSteps"],
	["verify", "taskQueueVerify"],
	["mustNot", "taskQueueMustNot"],
];

export interface TaskQueueSections {
	inChats: UiTaskQueueTask[];
	atWork: UiTaskQueueTask[];
	current?: UiTaskQueueTask;
	waiting: UiTaskQueueTask[];
	ready: UiTaskQueueTask[];
	done: UiTaskQueueTask[];
	dropped: UiTaskQueueTask[];
}

export function taskQueueSections(q: UiTaskQueue | undefined): TaskQueueSections {
	const tasks = q?.tasks ?? [];
	const open = (t: UiTaskQueueTask) =>
		t.status === "working" ||
		t.status === "asking" ||
		t.status === "stuck" ||
		t.status === "waiting" ||
		t.status === "blocked";
	const atWork = (t: UiTaskQueueTask) => t.status === "working" || t.status === "asking" || t.status === "stuck";
	const freed = (t: UiTaskQueueTask) => t.status === "waiting" && !t.wait?.overAt && !t.hold;
	const inChats = tasks.filter((t) => t.lane && open(t) && !freed(t));
	return {
		inChats,
		atWork: inChats.filter((t) => atWork(t) && !t.hold),
		current: tasks.find((t) => !t.lane && atWork(t)),
		waiting: tasks.filter((t) => t.status === "waiting" && (!t.lane || freed(t))),
		ready: tasks.filter((t) => t.status === "ready"),
		done: tasks.filter((t) => t.status === "done").sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)),
		dropped: tasks.filter((t) => t.status === "dropped").sort((a, b) => (b.dropped?.at ?? 0) - (a.dropped?.at ?? 0)),
	};
}

export function taskQueueStatusKey(q: UiTaskQueue, s: TaskQueueSections): TKey {
	if (q.hold) return "taskQueueStatusPausedByYou";
	const needsYou = (t: UiTaskQueueTask | undefined) => t?.status === "stuck" && !t.hold;
	if (needsYou(s.current) || s.inChats.some(needsYou)) return "taskQueueStatusStuck";
	if (q.running) {
		if (s.current) return "taskQueueStatusWorking";
		if (s.atWork.length === 1) return "taskQueueStatusLane";
		if (s.atWork.length > 1) return "taskQueueStatusLanes";
		return s.waiting.length > 0 ? "taskQueueStatusOnHold" : "taskQueueStatusRunning";
	}
	if (!s.current && s.ready.length === 0 && s.waiting.length === 0 && s.inChats.length === 0) {
		return q.autoStart ? "taskQueueStatusArmed" : "taskQueueStatusFinished";
	}
	switch (q.pausedReason) {
		case "user":
			return "taskQueueStatusStopped";
		case "stopped":
			return "taskQueueStatusRunStopped";
		case "error":
			return "taskQueueStatusError";
		case "restart":
			return "taskQueueStatusRestart";
		default:
			return "taskQueueStatusIdle";
	}
}

export function taskQueueHeldOf(q: Pick<UiTaskQueue, "hold">, task: UiTaskQueueTask): UiTaskQueueHold | undefined {
	return task.status === "done" || task.status === "dropped" ? undefined : (task.hold ?? q.hold);
}

export function PausedLine({
	hold,
	whole,
	banner,
	children,
}: {
	hold: UiTaskQueueHold;
	whole?: boolean;
	banner?: boolean;
	children?: ReactNode;
}) {
	const t = useT();
	return (
		<div className="task-queue-paused" data-paused={banner ? "banner" : whole ? "queue" : "task"}>
			<span className="task-queue-paused-badge">{t("taskQueuePausedByYou")}</span>
			<span className="task-queue-paused-text" title={hold.why}>
				{whole ? `${t("taskQueuePausedWithQueue")} \u00b7 ` : ""}
				{t("taskQueuePausedSince", { time: lineTime(hold.at), why: hold.why })}
			</span>
			{children}
		</div>
	);
}

export function taskNumbers(ids: number[]): string {
	return ids.map((n) => `#${n}`).join(", ");
}

export function refLabel(r: Pick<UiTaskQueueRef, "name" | "id">): string {
	return r.name ? `${r.name} #${r.id}` : `#${r.id}`;
}

function outsideOpen(r: UiTaskQueueRef): boolean {
	return !r.over && r.status !== "done" && r.status !== "dropped" && r.status !== "removed" && r.status !== "gone";
}

export function afterParts(
	task: Pick<UiTaskQueueTask, "status" | "after" | "waitingFor" | "waitingForRefs" | "outside">,
	queue: Pick<UiTaskQueue, "hold" | "tasks">,
): { list: string; open: UiTaskQueueRef[]; resume: UiTaskQueueRef[] } {
	const list = [...(task.after ?? []).map((n) => `#${n}`), ...(task.outside ?? []).map(refLabel)].join(", ");
	const here: UiTaskQueueRef[] =
		task.waitingForRefs ?? (task.waitingFor ?? []).map((id): UiTaskQueueRef => ({ file: "", name: "", id }));
	const open = [...here, ...(task.outside ?? []).filter(outsideOpen)];
	const ownPause = (id: number) => !!queue.tasks.find((x) => x.id === id)?.hold;
	const resume =
		task.status === "ready" ? open.filter((r) => r.held && (r.file !== "" || !queue.hold || ownPause(r.id))) : [];
	return { list, open, resume };
}

function refStateKey(status: UiTaskQueueRef["status"]): TKey | undefined {
	switch (status) {
		case "working":
			return "taskQueueRefWorking";
		case "asking":
			return "taskQueueRefAsking";
		case "stuck":
			return "taskQueueRefNeedsYou";
		case "waiting":
			return "taskQueueRefOnHold";
		case "blocked":
			return "taskQueueRefBlocked";
		case "ready":
			return "taskQueueRefNotStarted";
		case "done":
			return "taskQueueRefDone";
		case "dropped":
			return "taskQueueRefDropped";
		case "removed":
		case "gone":
			return "taskQueueRefRemoved";
		default:
			return undefined;
	}
}

function RefItem({ r, first, onOpen }: { r: UiTaskQueueRef; first: boolean; onOpen?: () => void }) {
	const t = useT();
	const key = r.held ? "taskQueueRefPaused" : refStateKey(r.status);
	const needsYou = r.status === "stuck" && !r.held;
	return (
		<span className={`task-queue-ref${needsYou ? " needs-you" : ""}`} data-ref={refLabel(r)}>
			{!first && ", "}
			{onOpen ? (
				<button type="button" className="task-queue-ref-link" title={r.title ?? r.chat?.title} onClick={onOpen}>
					{refLabel(r)}
				</button>
			) : (
				<span title={r.title}>{refLabel(r)}</span>
			)}
			{key && <span className="task-queue-ref-state" title={r.dropped}>{` (${t(key)})`}</span>}
		</span>
	);
}

const SLOT = "\u0000";
function withSlot(text: string, node: ReactNode): ReactNode {
	const at = text.indexOf(SLOT);
	if (at < 0) return text;
	return (
		<>
			{text.slice(0, at)}
			{node}
			{text.slice(at + SLOT.length)}
		</>
	);
}

export function AfterLine({
	task,
	queue,
	onOpenChat,
	onShowTask,
}: {
	task: UiTaskQueueTask;
	queue: UiTaskQueue;
	onOpenChat?: (file: string) => void;
	onShowTask: (id: number) => void;
}) {
	const t = useT();
	const { list, open, resume } = afterParts(task, queue);
	const openOf = (r: UiTaskQueueRef) => {
		if (r.file === "") return () => onShowTask(r.id);
		const file = r.chat?.file ?? r.file;
		return onOpenChat ? () => onOpenChat(file) : undefined;
	};
	return (
		<>
			<div
				className={`task-queue-after${open.length ? " waiting" : ""}`}
				data-after={[...(task.after ?? []).map(String), ...(task.outside ?? []).map(refLabel)].join(",")}
			>
				{t("taskQueueAfter", { list })}
				{open.length > 0 && (
					<>
						{" \u00b7 "}
						{withSlot(
							t("taskQueueAfterStill", { refs: SLOT }),
							open.map((r, i) => <RefItem key={`${r.file}#${r.id}`} r={r} first={i === 0} onOpen={openOf(r)} />),
						)}
					</>
				)}
			</div>
			{resume.length > 0 && (
				<div className="task-queue-resume-first" data-resume={resume.map(refLabel).join(",")}>
					{t("taskQueueResumeFirst", { refs: resume.map(refLabel).join(", ") })}
				</div>
			)}
		</>
	);
}

export function BlockedLine({ block, onOpenChat }: { block: UiTaskQueueBlock; onOpenChat?: (file: string) => void }) {
	const t = useT();
	const refs = block.on ?? [];
	const next = block.poke
		? t("taskQueueBlockedPoked", { time: lineTime(block.poke.at) })
		: block.nextRemindAt !== undefined && block.lead
			? t("taskQueueBlockedRemind", { lead: block.nextRemindLead || block.lead, time: lineTime(block.nextRemindAt) })
			: block.nextPokeAt !== undefined
				? t(
						block.nextIsOwner
							? "taskQueueBlockedOwner"
							: block.nextIsAsk
								? "taskQueueBlockedAsk"
								: "taskQueueBlockedNext",
						{ time: lineTime(block.nextPokeAt) },
					)
				: "";
	return (
		<div className="task-queue-blocked">
			<span className="task-queue-blocked-badge">{t("taskQueueBlocked")}</span>
			<span className="task-queue-blocked-text">
				{refs.length > 0 && (
					<>
						{t("taskQueueBlockedOn")}{" "}
						{refs.map((r, i) => {
							const chat = r.chat;
							return (
								<RefItem
									key={`${r.file}#${r.id}`}
									r={r}
									first={i === 0}
									onOpen={chat && onOpenChat ? () => onOpenChat(chat.file) : undefined}
								/>
							);
						})}
					</>
				)}
				{block.need && (
					<span className="task-queue-blocked-need">
						{refs.length > 0 && "; "}
						{t("taskQueueBlockedNeed", { need: block.need })}
					</span>
				)}
				{block.lead && (
					<span className="task-queue-blocked-lead" data-lead={block.lead}>
						{(refs.length > 0 || block.need) && "; "}
						{t("taskQueueBlockedLead", { lead: block.lead })}
						{block.owes ? `: ${block.owes}` : ""}
					</span>
				)}
				{next && <span className="task-queue-blocked-next">{` \u00b7 ${next}`}</span>}
			</span>
		</div>
	);
}

export interface TaskQueueAnswerBinding {
	readonly conversationId: string;
	readonly queueId: string;
	readonly taskId: number;
	readonly questionId: string;
	readonly question: string;
	readonly choices: readonly string[];
	readonly detail?: string;
	readonly brief?: readonly UiOwnerCardBriefLine[];
	readonly route?: unknown;
}

export interface TaskQueueAnswerRequest {
	readonly binding: TaskQueueAnswerBinding;
	readonly text: string;
}

export type TaskQueueAnswerResult = (request: TaskQueueAnswerRequest) => Promise<boolean>;

export function answerBinding(
	bindings: readonly TaskQueueAnswerBinding[] | undefined,
	conversationId: string | undefined,
	queueId: string | undefined,
	task: UiTaskQueueTask,
): TaskQueueAnswerBinding | undefined {
	if (!conversationId?.trim() || !queueId?.trim()) return undefined;
	const matches = (bindings ?? []).filter(
		(b) => b.conversationId === conversationId && b.queueId === queueId && b.taskId === task.id,
	);
	if (matches.length !== 1) return undefined;
	const b = matches[0];
	return typeof b.questionId === "string" &&
		b.questionId.trim() !== "" &&
		b.question === (task.question ?? "") &&
		JSON.stringify(b.choices) === JSON.stringify(task.choices ?? []) &&
		(b.detail ?? "") === (task.detail ?? "")
		? b
		: undefined;
}
