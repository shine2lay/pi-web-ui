import { useState } from "react";
import type { UiModelInfo, UiProfilePatch, UiTaskQueue, UiTaskQueueTask } from "../types";
import { effectiveProfile, ProfileEditor, ProfileSummary } from "./QueueProfile";
import { OwnerCardBrief } from "./OwnerCardBrief";
import { OwnerQuestionRoute } from "./OwnerQuestionRoute";
import { briefLines } from "../roles-useful-model";
import { useT } from "../i18n";
import { Markdown } from "./Markdown";
import { lineTime } from "./TldrPanel";
import { TaskPriorityBadge, taskPriority } from "./TaskPriorityBadge";
import {
	AfterLine,
	answerBinding,
	BlockedLine,
	PausedLine,
	TASK_QUEUE_PLAN_PARTS,
	taskQueueHeldOf,
	type TaskQueueAction,
	type TaskQueueAnswerBinding,
	type TaskQueueAnswerRequest,
	type TaskQueueAnswerResult,
} from "./TaskQueueLines";
import { StuckAnswer } from "./TaskQueueAnswer";

export type { TaskQueueAnswerBinding, TaskQueueAnswerRequest, TaskQueueAnswerResult };

export function renderTaskQueueRow({
	task,
	kind,
	index = 0,
	readyCount,
	queue,
	expanded,
	flash,
	laneNo,
	controls,
	busy,
	pendingSetting,
	removing,
	setRemoving,
	run,
	toggle,
	changeProfile,
	models,
	onOpenChat,
	showTask,
	onAnswer,
	onAnswerResult,
	answerBindings,
	conversationId,
}: {
	task: UiTaskQueueTask;
	kind: "current" | "lane" | "waiting" | "ready" | "done" | "dropped";
	index?: number;
	readyCount: number;
	queue: UiTaskQueue;
	expanded: boolean;
	flash: number | null;
	laneNo: ReadonlyMap<number, number>;
	controls?: (action: TaskQueueAction, id?: number, value?: boolean, profile?: UiProfilePatch) => void;
	busy: boolean;
	pendingSetting: boolean;
	removing: number | null;
	setRemoving: (id: number | null) => void;
	run: (action: TaskQueueAction, id?: number) => void;
	toggle: (id: number) => void;
	changeProfile: (profile: UiProfilePatch, id?: number) => void;
	models: UiModelInfo[];
	onOpenChat?: (file: string) => void;
	showTask: (id: number) => void;
	onAnswer?: (taskId: number, text: string) => void;
	onAnswerResult?: TaskQueueAnswerResult;
	answerBindings?: readonly TaskQueueAnswerBinding[];
	conversationId?: string;
}) {
	const t = useT();
	const over = kind === "done" || kind === "dropped";
	const wait = kind === "waiting" ? task.wait : undefined;
	const held = taskQueueHeldOf(queue, task);
	const binding =
		task.status === "stuck" ? answerBinding(answerBindings, conversationId, queue.queueId, task) : undefined;
	const cls = [
		"task-queue-task",
		kind,
		task.status === "stuck" && !held ? "needs-you" : "",
		held ? "paused" : "",
		task.status === "asking" ? "asking" : "",
		task.status === "blocked" ? "blocked" : "",
		wait?.failed ? "wait-failed" : "",
	]
		.filter(Boolean)
		.join(" ");
	const when =
		kind === "done" && task.doneAt
			? t("taskQueueFinishedAt", { time: lineTime(task.doneAt) })
			: kind === "dropped" && task.dropped
				? t("taskQueueDroppedAt", { time: lineTime(task.dropped.at) })
				: (kind === "current" || kind === "lane" || kind === "waiting") && task.startedAt
					? t("taskQueueStarted", { time: lineTime(task.startedAt) })
					: "";
	const prio = taskPriority(task);
	return (
		<li
			key={task.id}
			className={flash === task.id ? `${cls} task-queue-focus` : cls}
			data-task-id={task.id}
			data-priority={prio}
		>
			<div className="task-queue-task-head">
				<button
					type="button"
					className="task-queue-title"
					aria-expanded={expanded}
					title={t("taskQueuePlanToggle")}
					onClick={() => toggle(task.id)}
				>
					<span className="task-queue-id">#{task.id}</span>
					<span className="task-queue-title-text">{task.plan.title}</span>
				</button>
				<TaskPriorityBadge priority={prio} />
				{!over && laneNo.has(task.id) && (
					<span className="task-queue-lane" data-lane={laneNo.get(task.id)}>
						{t("taskQueueLane", { n: laneNo.get(task.id) ?? "" })}
					</span>
				)}
				{task.chat && onOpenChat && (
					<button
						type="button"
						className="task-queue-open-chat"
						title={task.chat.title ?? t("taskQueueOpenChat")}
						onClick={() => task.chat && onOpenChat(task.chat.file)}
					>
						{t("taskQueueOpenChat")}
					</button>
				)}
				{!over && controls && (
					<button
						type="button"
						className={`task-queue-pause ${task.hold ? "resume" : "pause"}`}
						data-pause-task={task.id}
						title={t(task.hold ? "taskQueueResumeHint" : "taskQueuePauseHint")}
						disabled={busy}
						onClick={() => run(task.hold ? "resume" : "pause", task.id)}
					>
						{t(task.hold ? "taskQueueResume" : "taskQueuePause")}
					</button>
				)}
				{kind === "ready" &&
					controls &&
					(removing === task.id ? (
						<span className="task-queue-confirm">
							<span className="task-queue-confirm-text">{t("taskQueueRemoveAsk", { id: task.id })}</span>
							<button
								type="button"
								className="task-queue-remove-yes"
								disabled={busy}
								onClick={() => run("remove", task.id)}
							>
								{t("taskQueueRemoveYes")}
							</button>
							<button type="button" className="task-queue-remove-no" onClick={() => setRemoving(null)}>
								{t("cancel")}
							</button>
						</span>
					) : (
						<span className="task-queue-controls">
							<button
								type="button"
								className="task-queue-up"
								title={t("taskQueueUp")}
								aria-label={t("taskQueueUp")}
								disabled={busy || index === 0}
								onClick={() => run("up", task.id)}
							>
								↑
							</button>
							<button
								type="button"
								className="task-queue-down"
								title={t("taskQueueDown")}
								aria-label={t("taskQueueDown")}
								disabled={busy || index === readyCount - 1}
								onClick={() => run("down", task.id)}
							>
								↓
							</button>
							<button
								type="button"
								className="task-queue-remove"
								title={t("taskQueueRemove")}
								aria-label={t("taskQueueRemove")}
								disabled={busy}
								onClick={() => setRemoving(task.id)}
							>
								✕
							</button>
						</span>
					))}
			</div>
			{held && !over && <PausedLine hold={held} whole={!task.hold} />}
			{kind === "dropped" && (
				<div className="task-queue-dropped">{t("taskQueueDroppedBy", { why: task.dropped?.why ?? "" })}</div>
			)}
			{task.status === "asking" && (
				<div className="task-queue-asking" title={task.question}>
					<span className="task-queue-hint">
						{!task.askOps
							? t("taskQueueAskingMain")
							: task.askLead
								? t("taskQueueAskingLead", { lead: task.askLead })
								: t("taskQueueAskingOps")}
					</span>
				</div>
			)}
			{task.status === "blocked" && task.block && <BlockedLine block={task.block} onOpenChat={onOpenChat} />}
			{task.status === "stuck" && (
				<div className="task-queue-question">
					{!held && <span className="task-queue-badge">{t("taskQueueNeedsYou")}</span>}
					{!held && <OwnerQuestionRoute route={binding?.route} />}
					{!held && <OwnerCardBrief lines={briefLines(binding?.brief)} />}
					{task.question && <span className="task-queue-question-text">{task.question}</span>}
					{task.detail && (
						<details className="task-queue-question-detail" open>
							<summary>{t("taskQueueOwnerContext")}</summary>
							<div
								className="task-queue-question-detail-body"
								tabIndex={0}
								role="region"
								aria-label={t("taskQueueOwnerContext")}
							>
								<Markdown text={task.detail} />
							</div>
						</details>
					)}
					{held ? (
						<span className="task-queue-hint">{t("taskQueuePausedAnswerLater")}</span>
					) : (onAnswer || onAnswerResult || answerBindings !== undefined) && queue.available ? (
						<StuckAnswer
							task={task}
							conversationId={conversationId}
							queueId={queue.queueId}
							binding={binding}
							onAnswerResult={onAnswerResult}
						/>
					) : (
						<span className="task-queue-hint">{t(task.lane ? "taskQueueAnswerInChat" : "taskQueueAnswerHint")}</span>
					)}
				</div>
			)}
			{!over && task.touches !== undefined && (
				<div className="task-queue-touches">
					{task.touches.length > 0 ? `${t("taskQueueTouches")}: ${task.touches.join(", ")}` : t("taskQueueRunsAlone")}
				</div>
			)}
			{!over && (!!task.after?.length || !!task.outside?.length) && (
				<AfterLine task={task} queue={queue} onOpenChat={onOpenChat} onShowTask={showTask} />
			)}
			{wait &&
				(wait.failed ? (
					<div className="task-queue-wait failed">
						<span className="task-queue-wait-text">{t("taskQueueWaitFailed")}</span>
						<span className="task-queue-wait-reason">{wait.failed}</span>
					</div>
				) : wait.overAt ? (
					<div className="task-queue-wait over">
						<span className="task-queue-wait-text">{t("taskQueueWaitOver", { time: lineTime(wait.overAt) })}</span>
					</div>
				) : (
					<div className="task-queue-wait">
						<span className="task-queue-wait-text">
							{t("taskQueueWaitingOn", { what: wait.what, time: lineTime(wait.since) })}
							{" \u00b7 "}
							{held ? t("taskQueueWaitClockStopped") : t("taskQueueWaitGivesUp", { time: lineTime(wait.until) })}
						</span>
						{wait.check && (
							<span className="task-queue-wait-check">
								{t("taskQueueWaitCheck")}: <code className="task-queue-check">{wait.check}</code>
							</span>
						)}
					</div>
				))}
			{task.problem && (
				<p className="queue-profile-problem" role="alert">
					{task.problem}
				</p>
			)}
			{kind === "done" && task.summary && <div className="task-queue-summary">{task.summary}</div>}
			{when && <div className="task-queue-time">{when}</div>}
			{expanded && (
				<div className="task-queue-profile" data-profile-task={task.id}>
					<ProfileSummary
						models={models}
						launch={task.launch ?? effectiveProfile(queue.profile, task.profile, queue.inherited, models)}
						title={t(task.launch ? "queueProfileLaunch" : "queueProfileEffective")}
					/>
					{queue.from && queue.currentProfile && (
						<ProfileSummary
							models={models}
							launch={{ ...queue.currentProfile, from: { model: "app", thinking: "app", speed: "app" } }}
							title={t("queueProfileCurrent")}
						/>
					)}
					{kind === "ready" && task.startedAt === undefined && controls && (
						<ProfileEditor
							label={t("queueProfileOverride")}
							profile={task.profile}
							models={models}
							disabled={busy || pendingSetting}
							effective={effectiveProfile(queue.profile, task.profile, queue.inherited, models)}
							onChange={(patch) => changeProfile(patch, task.id)}
						/>
					)}
					{task.startedAt !== undefined && task.chat && onOpenChat && (
						<button
							type="button"
							className="task-queue-open-chat"
							onClick={() => task.chat && onOpenChat(task.chat.file)}
						>
							{t("queueProfileChatSettings")}
						</button>
					)}
				</div>
			)}
			{expanded && (
				<dl className="task-queue-plan">
					{TASK_QUEUE_PLAN_PARTS.map(([part, label]) =>
						task.plan[part] ? (
							<div key={part} className="task-queue-part">
								<dt>{t(label)}</dt>
								<dd>
									<Markdown text={task.plan[part]} />
								</dd>
							</div>
						) : null,
					)}
				</dl>
			)}
		</li>
	);
}
