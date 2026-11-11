/**
 * 右栏的「队列」tab（queue-panel）。
 * Displays the current conversation's pi-queue tasks, controls, lanes, and P0–P3 task priority badges.
 */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { UiModelInfo, UiProfilePatch, UiTaskQueue, UiTaskQueueTask } from "../types";
import { effectiveProfile, ProfileEditor, ProfileSummary } from "./QueueProfile";
import { useT } from "../i18n";
import { FOCUS_FLASH_MS } from "../chat-focus";
import {
	DEFAULT_PRIORITY,
	PRIORITIES,
	PRIORITY_RANK,
	TaskPriorityBadge,
	formatTaskPriorityBadge,
	renderTaskPriorityBadgeHtml,
	taskPriority,
	type TaskPriority,
} from "./TaskPriorityBadge";
import {
	BUSY_MS,
	DEFAULT_LANES,
	MAX_LANES,
	PausedLine,
	TASK_QUEUE_DONE_SHOWN,
	TASK_QUEUE_PLAN_PARTS,
	afterParts,
	refLabel,
	taskNumbers,
	taskQueueHeldOf,
	taskQueueSections,
	taskQueueStatusKey,
	type TKey,
	type TaskQueueAction,
	type TaskQueueSections,
} from "./TaskQueueLines";
import {
	renderTaskQueueRow,
	type TaskQueueAnswerBinding,
	type TaskQueueAnswerRequest,
	type TaskQueueAnswerResult,
} from "./TaskQueueRow";

export {
	DEFAULT_PRIORITY,
	PRIORITIES,
	PRIORITY_RANK,
	TASK_QUEUE_DONE_SHOWN,
	TASK_QUEUE_PLAN_PARTS,
	TaskPriorityBadge,
	afterParts,
	formatTaskPriorityBadge,
	refLabel,
	renderTaskPriorityBadgeHtml,
	taskNumbers,
	taskPriority,
	taskQueueHeldOf,
	taskQueueSections,
	taskQueueStatusKey,
	type TaskPriority,
	type TaskQueueAction,
	type TaskQueueAnswerBinding,
	type TaskQueueAnswerRequest,
	type TaskQueueAnswerResult,
	type TaskQueueSections,
};

export const TaskQueuePanel = memo(function TaskQueuePanel({
	queue,
	onCommand,
	onAnswer,
	onAnswerResult,
	answerBindings,
	conversationId,
	onOpenChat,
	models = [],
	defaultOpen = [],
	focus,
}: {
	queue: UiTaskQueue | undefined;
	/** @deprecated Render-only compatibility. Never dispatched: a void callback cannot prove an answer result. */
	onAnswer?: (taskId: number, text: string) => void;
	/** Separate, genuine applied-result path for consent-bearing answers. No legacy fallback. */
	onAnswerResult?: TaskQueueAnswerResult;
	answerBindings?: readonly TaskQueueAnswerBinding[];
	conversationId?: string;
	/** 发一条 `/queue …` 命令给这条对话的 pi-queue。不给就不出按钮（只读）。 */
	onCommand?: (action: TaskQueueAction, id?: number, value?: boolean, profile?: UiProfilePatch) => void;
	models?: UiModelInfo[];
	/** queue-lanes: open a task's own chat (or the queue's chat). Not given = no links. */
	onOpenChat?: (file: string) => void;
	/** 初始展开计划的任务（测试用；界面上点标题切换）。 */
	defaultOpen?: readonly number[];
	/** roles-overview: show this task (scrolled to and marked for a moment); seq grows with every request. */
	focus?: { id: number; seq: number } | null;
}) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const [removing, setRemoving] = useState<number | null>(null);
	const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set(defaultOpen));
	const [allDone, setAllDone] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const [flash, setFlash] = useState<number | null>(null);
	useEffect(() => {
		if (!focus || !queue) return;
		const task = queue.tasks.find((x) => x.id === focus.id);
		if (!task) return;
		if (task.status === "done") setAllDone(true);
		setFlash(task.id);
		const timer = setTimeout(() => setFlash(null), FOCUS_FLASH_MS);
		return () => clearTimeout(timer);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [focus?.seq, queue === undefined]);
	useEffect(() => {
		if (flash === null) return;
		const el = rootRef.current?.querySelector(`[data-task-id="${flash}"]`);
		if (el instanceof HTMLElement) el.scrollIntoView?.({ block: "nearest" });
	}, [flash, allDone]);
	const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(showTimer.current), []);
	const showTask = useCallback((id: number) => {
		const el = rootRef.current?.querySelector(`[data-task-id="${id}"]`);
		if (el instanceof HTMLElement) {
			el.scrollIntoView?.({ block: "nearest" });
			el.querySelector<HTMLElement>(".task-queue-title")?.focus({ preventScroll: true });
		}
		setFlash(id);
		clearTimeout(showTimer.current);
		showTimer.current = setTimeout(() => setFlash(null), FOCUS_FLASH_MS);
	}, []);
	const [pendingSetting, setPendingSetting] = useState<{
		key: "autoApprove" | "autoStart";
		value: boolean;
		queueId?: string;
	} | null>(null);
	useEffect(() => {
		if (!pendingSetting) return;
		if (queue?.queueId !== pendingSetting.queueId || queue?.[pendingSetting.key] === pendingSetting.value) {
			setPendingSetting(null);
			return;
		}
		const timer = setTimeout(() => setPendingSetting(null), BUSY_MS);
		return () => clearTimeout(timer);
	}, [pendingSetting, queue]);
	useEffect(() => {
		setBusy(false);
		setRemoving((id) => (id !== null && queue?.tasks.some((x) => x.id === id && x.status === "ready") ? id : null));
	}, [queue]);
	useEffect(() => {
		if (!busy) return;
		const timer = setTimeout(() => setBusy(false), BUSY_MS);
		return () => clearTimeout(timer);
	}, [busy]);

	if (!queue) {
		return (
			<div className="task-queue-panel">
				<p className="task-queue-empty">{t("taskQueueEmpty")}</p>
			</div>
		);
	}

	const s = taskQueueSections(queue);
	const controls = queue.available && onCommand && !queue.from ? onCommand : undefined;
	const run = (action: TaskQueueAction, id?: number) => {
		if (!controls || busy || pendingSetting) return;
		setBusy(true);
		setRemoving(null);
		controls(action, id);
	};
	const settingControl = (key: "autoApprove" | "autoStart", label: TKey) => (
		<button
			type="button"
			role="switch"
			aria-label={t(label)}
			aria-checked={queue[key] === true}
			className="task-queue-switch"
			disabled={!controls || !queue.queueId || busy || !!pendingSetting}
			onClick={() => {
				if (!controls || !queue.queueId) return;
				const value = queue[key] !== true;
				setPendingSetting({ key, value, queueId: queue.queueId });
				controls(key, undefined, value);
			}}
		>
			<span>{t(label)}</span>
			<span className="task-queue-switch-state" aria-hidden="true">
				{t(queue[key] === true ? "taskQueueOn" : "taskQueueOff")}
			</span>
		</button>
	);
	const toggle = (id: number) =>
		setOpen((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	const changeProfile = (profile: UiProfilePatch, id?: number) => {
		if (!controls || !queue.queueId || busy) return;
		setBusy(true);
		controls(id === undefined ? "defaults" : "taskProfile", id, undefined, profile);
	};
	const defaultsEffective = effectiveProfile(queue.profile, undefined, queue.inherited, models);
	const statusKey = taskQueueStatusKey(queue, s);
	const canStart = !!s.current || s.ready.length > 0 || s.waiting.length > 0 || s.inChats.length > 0;
	const laneNo = new Map<number, number>();
	for (const lane of queue.lanes ?? []) for (const id of lane.taskIds) laneNo.set(id, lane.n);
	const lanesAtOnce = queue.lanesAtOnce ?? DEFAULT_LANES;
	const showLanes =
		!queue.from &&
		(!!queue.lanes ||
			queue.lanesAtOnce !== undefined ||
			queue.tasks.some((x) => x.touches !== undefined && x.status !== "done" && x.status !== "dropped"));
	const stuckInChat = s.inChats.find((x) => x.status === "stuck" && !taskQueueHeldOf(queue, x));
	const currentNeedsYou = s.current?.status === "stuck" && !taskQueueHeldOf(queue, s.current);

	const row = (task: UiTaskQueueTask, kind: "current" | "lane" | "waiting" | "ready" | "done" | "dropped", index = 0) =>
		renderTaskQueueRow({
			task,
			kind,
			index,
			readyCount: s.ready.length,
			queue,
			expanded: open.has(task.id),
			flash,
			laneNo,
			controls,
			busy,
			pendingSetting: !!pendingSetting,
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
		});

	const doneShown = allDone ? s.done : s.done.slice(0, TASK_QUEUE_DONE_SHOWN);
	return (
		<div className="task-queue-panel" ref={rootRef}>
			<div className="task-queue-head">
				<span
					className={currentNeedsYou || stuckInChat ? "task-queue-status needs-you" : "task-queue-status"}
					data-running={queue.running ? "true" : "false"}
					data-paused={queue.hold ? "true" : undefined}
				>
					{t(statusKey, {
						id: s.current?.id ?? stuckInChat?.id ?? s.atWork[0]?.id ?? s.waiting[0]?.id ?? "",
						n: s.atWork.length,
					})}
				</span>
				{controls &&
					(queue.running || queue.autoStart ? (
						<button
							type="button"
							className="task-queue-toggle stop"
							title={t("taskQueueStopHint")}
							disabled={busy}
							onClick={() => run("stop")}
						>
							{t("taskQueueStop")}
						</button>
					) : (
						<button
							type="button"
							className="task-queue-toggle start"
							title={t("taskQueueStartHint")}
							disabled={busy || !canStart}
							onClick={() => run("start")}
						>
							{t("taskQueueStart")}
						</button>
					))}
				{controls && (
					<button
						type="button"
						className={`task-queue-pause-queue ${queue.hold ? "resume" : "pause"}`}
						title={t(queue.hold ? "taskQueueResumeQueueHint" : "taskQueuePauseQueueHint")}
						disabled={busy}
						onClick={() => run(queue.hold ? "resume" : "pause")}
					>
						{t(queue.hold ? "taskQueueResumeQueue" : "taskQueuePauseQueue")}
					</button>
				)}
			</div>
			{queue.hold && (
				<div className="task-queue-paused-banner" role="status">
					<PausedLine hold={queue.hold} banner />
				</div>
			)}
			{!queue.from && (
				<div className="task-queue-autonomy" role="group" aria-label={t("taskQueueThisQueue")}>
					{settingControl("autoApprove", "taskQueueAutoApprove")}
					{settingControl("autoStart", "taskQueueAutoStart")}
				</div>
			)}
			{!queue.from && (
				<details className="queue-defaults">
					<summary>{t("queueProfileDefaults")}</summary>
					<ProfileSummary models={models} launch={defaultsEffective} />
					<ProfileEditor
						label={t("queueProfileDefaults")}
						profile={queue.profile}
						effective={defaultsEffective}
						models={models}
						disabled={!controls || !queue.queueId || busy || !!pendingSetting}
						onChange={(patch) => changeProfile(patch)}
					/>
				</details>
			)}
			{queue.tasks.length === 0 && <p className="task-queue-empty">{t("taskQueueEmpty")}</p>}
			{!queue.available && <p className="task-queue-note">{t("taskQueueNotLoaded")}</p>}
			{queue.from && (
				<p className="task-queue-from">
					{queue.from.title ? t("taskQueueFrom", { title: queue.from.title }) : t("taskQueueFromUntitled")}
					{onOpenChat && (
						<button
							type="button"
							className="task-queue-open-chat"
							onClick={() => queue.from && onOpenChat(queue.from.file)}
						>
							{t("taskQueueOpenQueue")}
						</button>
					)}
				</p>
			)}
			{showLanes && (
				<div className="task-queue-lanes-at-once">
					<span className="task-queue-lanes-label">{t("taskQueueLanesAtOnce")}</span>
					{controls && (
						<button
							type="button"
							className="task-queue-lanes-fewer"
							title={t("taskQueueLanesFewer")}
							aria-label={t("taskQueueLanesFewer")}
							disabled={busy || lanesAtOnce <= 1}
							onClick={() => run("lanes", lanesAtOnce - 1)}
						>
							-
						</button>
					)}
					<span className="task-queue-lanes-n">{lanesAtOnce}</span>
					{controls && (
						<button
							type="button"
							className="task-queue-lanes-more"
							title={t("taskQueueLanesMore")}
							aria-label={t("taskQueueLanesMore")}
							disabled={busy || lanesAtOnce >= MAX_LANES}
							onClick={() => run("lanes", lanesAtOnce + 1)}
						>
							+
						</button>
					)}
				</div>
			)}
			{s.inChats.length > 0 && (
				<section className="task-queue-section">
					<h4 className="task-queue-heading">{t("taskQueueInChats")}</h4>
					<ul className="task-queue-list">{s.inChats.map((task) => row(task, "lane"))}</ul>
				</section>
			)}
			{s.current && (
				<section className="task-queue-section">
					<h4 className="task-queue-heading">{t("taskQueueNow")}</h4>
					<ul className="task-queue-list">{row(s.current, "current")}</ul>
				</section>
			)}
			{s.waiting.length > 0 && (
				<section className="task-queue-section">
					<h4 className="task-queue-heading">{t("taskQueueOnHold")}</h4>
					<ul className="task-queue-list">{s.waiting.map((task) => row(task, "waiting"))}</ul>
				</section>
			)}
			{s.ready.length > 0 && (
				<section className="task-queue-section">
					<h4 className="task-queue-heading">{t("taskQueueNext")}</h4>
					<ol className="task-queue-list">{s.ready.map((task, i) => row(task, "ready", i))}</ol>
				</section>
			)}
			{s.done.length > 0 && (
				<section className="task-queue-section">
					<div className="task-queue-heading-row">
						<h4 className="task-queue-heading">{t("taskQueueDone")}</h4>
						{controls && (
							<button
								type="button"
								className="task-queue-clear"
								title={t("taskQueueClearDoneHint")}
								disabled={busy}
								onClick={() => run("clear")}
							>
								{t("taskQueueClearDone")}
							</button>
						)}
					</div>
					<ul className="task-queue-list">{doneShown.map((task) => row(task, "done"))}</ul>
					{s.done.length > TASK_QUEUE_DONE_SHOWN && (
						<button type="button" className="task-queue-more" onClick={() => setAllDone((v) => !v)}>
							{allDone ? t("taskQueueShowFewer") : t("taskQueueShowAllDone", { n: s.done.length })}
						</button>
					)}
				</section>
			)}
			{s.dropped.length > 0 && (
				<section className="task-queue-section">
					<div className="task-queue-heading-row">
						<h4 className="task-queue-heading">{t("taskQueueDropped")}</h4>
						{controls && s.done.length === 0 && (
							<button
								type="button"
								className="task-queue-clear"
								title={t("taskQueueClearDoneHint")}
								disabled={busy}
								onClick={() => run("clear")}
							>
								{t("taskQueueClearDone")}
							</button>
						)}
					</div>
					<ul className="task-queue-list">{s.dropped.map((task) => row(task, "dropped"))}</ul>
				</section>
			)}
		</div>
	);
});
