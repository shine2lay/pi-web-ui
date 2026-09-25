/**
 * 右栏的「队列」tab（queue-panel）。
 *
 * pi-queue 扩展给每条对话一个任务队列：用户和 agent 先把一个任务计划透，用户在对话框里批准了
 * 才进队列；按「开始」后 agent 一个接一个自己做完。这里显示当前对话的队列（UiState.taskQueue，
 * server/task-queue.ts 从会话条目重放出来的）：
 *
 * - 顶上一行状态，和「开始」/「停下」；
 * - 正在做的任务；卡住等用户时琥珀色，带 agent 的问题；
 * - 排着的任务，按要做的顺序，带 ↑ ↓ ✕（✕ 先在行内确认）；
 * - 做完的任务变灰，带 agent 的总结，最近做完的在上。
 *
 * 点任务标题展开整份计划（六部分，叫法和 pi-queue 批准对话框里的一样）。按钮一律变成 `/queue …`
 * 命令交给 pi-queue（task_queue_command），面板自己不改队列：点下去先把按钮禁用，等服务端发来
 * 新的队列（或 5 秒后）再放开，防连点。
 */

import { memo, useEffect, useState } from "react";
import type { UiTaskQueue, UiTaskQueuePlan, UiTaskQueueTask } from "../types";
import { useT, type Translate } from "../i18n";
import { Markdown } from "./Markdown";
import { lineTime } from "./TldrPanel";

type TKey = Parameters<Translate>[0];

/** 面板按钮能发的命令（服务端 taskQueueCommandLine 转成 `/queue …`）。 */
export type TaskQueueAction = "start" | "stop" | "up" | "down" | "remove";

/** 点了按钮后最多等服务端这么久；命令没改队列时（比如没东西可开始）按钮也会放开。 */
const BUSY_MS = 5000;

/** 做完的任务默认显示几个（最近做完的）。 */
export const TASK_QUEUE_DONE_SHOWN = 5;

/** 计划的六部分，顺序和叫法跟 pi-queue 批准对话框里的一样（pi-queue queue.ts PARTS）。 */
export const TASK_QUEUE_PLAN_PARTS: readonly (readonly [Exclude<keyof UiTaskQueuePlan, "title">, TKey])[] = [
	["goal", "taskQueueGoal"],
	["doneWhen", "taskQueueDoneWhen"],
	["decided", "taskQueueDecided"],
	["steps", "taskQueueSteps"],
	["verify", "taskQueueVerify"],
	["mustNot", "taskQueueMustNot"],
];

export interface TaskQueueSections {
	/** 正在做或卡住等用户的那个（最多一个）。 */
	current?: UiTaskQueueTask;
	/** 排着的，按要做的顺序。 */
	ready: UiTaskQueueTask[];
	/** 做完的，最近做完的在前。 */
	done: UiTaskQueueTask[];
}

export function taskQueueSections(q: UiTaskQueue | undefined): TaskQueueSections {
	const tasks = q?.tasks ?? [];
	return {
		current: tasks.find((t) => t.status === "working" || t.status === "stuck"),
		ready: tasks.filter((t) => t.status === "ready"),
		done: tasks.filter((t) => t.status === "done").sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)),
	};
}

/** 顶上那行状态说哪句话。 */
export function taskQueueStatusKey(q: UiTaskQueue, s: TaskQueueSections): TKey {
	if (s.current?.status === "stuck") return "taskQueueStatusStuck";
	if (q.running) return s.current ? "taskQueueStatusWorking" : "taskQueueStatusRunning";
	if (!s.current && s.ready.length === 0) return "taskQueueStatusFinished";
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

export const TaskQueuePanel = memo(function TaskQueuePanel({
	queue,
	onCommand,
	defaultOpen = [],
}: {
	queue: UiTaskQueue | undefined;
	/** 发一条 `/queue …` 命令给这条对话的 pi-queue。不给就不出按钮（只读）。 */
	onCommand?: (action: TaskQueueAction, id?: number) => void;
	/** 初始展开计划的任务（测试用；界面上点标题切换）。 */
	defaultOpen?: readonly number[];
}) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const [removing, setRemoving] = useState<number | null>(null);
	const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set(defaultOpen));
	const [allDone, setAllDone] = useState(false);
	// 服务端发来新的队列 = 刚才的命令有结果了（或者别的窗口改了它）。
	useEffect(() => {
		setBusy(false);
		setRemoving((id) => (id !== null && queue?.tasks.some((x) => x.id === id && x.status === "ready") ? id : null));
	}, [queue]);
	useEffect(() => {
		if (!busy) return;
		const timer = setTimeout(() => setBusy(false), BUSY_MS);
		return () => clearTimeout(timer);
	}, [busy]);

	if (!queue || queue.tasks.length === 0) {
		return (
			<div className="task-queue-panel">
				<p className="task-queue-empty">{t("taskQueueEmpty")}</p>
				{queue && !queue.available && <p className="task-queue-note">{t("taskQueueNotLoaded")}</p>}
			</div>
		);
	}

	const s = taskQueueSections(queue);
	const controls = queue.available && onCommand ? onCommand : undefined;
	const run = (action: TaskQueueAction, id?: number) => {
		if (!controls || busy) return;
		setBusy(true);
		setRemoving(null);
		controls(action, id);
	};
	const toggle = (id: number) =>
		setOpen((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	const statusKey = taskQueueStatusKey(queue, s);
	const canStart = !!s.current || s.ready.length > 0;

	const row = (task: UiTaskQueueTask, kind: "current" | "ready" | "done", index = 0) => {
		const expanded = open.has(task.id);
		const cls = ["task-queue-task", kind, task.status === "stuck" ? "needs-you" : ""].filter(Boolean).join(" ");
		const when =
			kind === "done" && task.doneAt
				? t("taskQueueFinishedAt", { time: lineTime(task.doneAt) })
				: kind === "current" && task.startedAt
					? t("taskQueueStarted", { time: lineTime(task.startedAt) })
					: "";
		return (
			<li key={task.id} className={cls} data-task-id={task.id}>
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
									disabled={busy || index === s.ready.length - 1}
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
				{task.status === "stuck" && (
					<div className="task-queue-question">
						<span className="task-queue-badge">{t("taskQueueNeedsYou")}</span>
						{task.question && <span className="task-queue-question-text">{task.question}</span>}
						<span className="task-queue-hint">{t("taskQueueAnswerHint")}</span>
					</div>
				)}
				{kind === "done" && task.summary && <div className="task-queue-summary">{task.summary}</div>}
				{when && <div className="task-queue-time">{when}</div>}
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
	};

	const doneShown = allDone ? s.done : s.done.slice(0, TASK_QUEUE_DONE_SHOWN);
	return (
		<div className="task-queue-panel">
			<div className="task-queue-head">
				<span
					className={s.current?.status === "stuck" ? "task-queue-status needs-you" : "task-queue-status"}
					data-running={queue.running ? "true" : "false"}
				>
					{t(statusKey, { id: s.current?.id ?? "" })}
				</span>
				{controls &&
					(queue.running ? (
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
			</div>
			{!queue.available && <p className="task-queue-note">{t("taskQueueNotLoaded")}</p>}
			{s.current && (
				<section className="task-queue-section">
					<h4 className="task-queue-heading">{t("taskQueueNow")}</h4>
					<ul className="task-queue-list">{row(s.current, "current")}</ul>
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
					<h4 className="task-queue-heading">{t("taskQueueDone")}</h4>
					<ul className="task-queue-list">{doneShown.map((task) => row(task, "done"))}</ul>
					{s.done.length > TASK_QUEUE_DONE_SHOWN && (
						<button type="button" className="task-queue-more" onClick={() => setAllDone((v) => !v)}>
							{allDone ? t("taskQueueShowFewer") : t("taskQueueShowAllDone", { n: s.done.length })}
						</button>
					)}
				</section>
			)}
		</div>
	);
});
