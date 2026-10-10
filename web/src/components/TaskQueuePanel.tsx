/**
 * 右栏的「队列」tab（queue-panel）。
 *
 * pi-queue 扩展给每条对话一个任务队列：用户和 agent 先把一个任务计划透，用户在对话框里批准了
 * 才进队列；按「开始」后 agent 一个接一个自己做完。这里显示当前对话的队列（UiState.taskQueue，
 * server/task-queue.ts 从会话条目重放出来的）：
 *
 * - 顶上一行状态，和「开始」/「停下」；
 * - 正在做的任务；卡住等用户时琥珀色，带 agent 的问题；
 * - 搁着等外面的事的任务（pi-queue 的 queue_wait）：等什么、检查命令、几点放弃；等到了说一声，
 *   没等到（放弃或检查一直出错）变琥珀色，带原因；
 * - 排着的任务，按要做的顺序，带 ↑ ↓ ✕（✕ 先在行内确认）；
 * - 做完的任务变灰，带 agent 的总结，最近做完的在上。
 *
 * 点任务标题展开整份计划（六部分，叫法和 pi-queue 批准对话框里的一样）。按钮一律变成 `/queue …`
 * 命令交给 pi-queue（task_queue_command），面板自己不改队列：点下去先把按钮禁用，等服务端发来
 * 新的队列（或 5 秒后）再放开，防连点。
 */

import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type {
	UiTaskQueue,
	UiTaskQueueBlock,
	UiTaskQueueHold,
	UiTaskQueuePlan,
	UiTaskQueueRef,
	UiTaskQueueTask,
	UiModelInfo,
	UiProfilePatch,
} from "../types";
import { effectiveProfile, ProfileEditor, ProfileSummary } from "./QueueProfile";
import { useT, type Translate } from "../i18n";
import { Markdown } from "./Markdown";
import { lineTime } from "./TldrPanel";
import { FOCUS_FLASH_MS } from "../chat-focus";

type TKey = Parameters<Translate>[0];

/** 面板按钮能发的命令（服务端 taskQueueCommandLine 转成 `/queue …`）。 */
export type TaskQueueAction =
	| "start"
	| "stop"
	// queue-paused: the owner's pause on a task (id) or the whole queue (no id), and its lifting.
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

/** queue-lanes: the most lanes that may run at once (pi-queue MAX_LANES); 2 when not set. */
const MAX_LANES = 8;
const DEFAULT_LANES = 2;

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
	/** queue-lanes: tasks working in chats of their own (working, asking their main chat, stuck or on hold
	 *  there), in queue order. */
	inChats: UiTaskQueueTask[];
	/** 正在做或卡住等用户的那个（最多一个）。 */
	current?: UiTaskQueueTask;
	/** 搁着等外面的事的，按队列顺序（等到了、没等到的也在这，直到它们接着做）。 */
	waiting: UiTaskQueueTask[];
	/** 排着的，按要做的顺序。 */
	ready: UiTaskQueueTask[];
	/** 做完的，最近做完的在前。 */
	done: UiTaskQueueTask[];
}

export function taskQueueSections(q: UiTaskQueue | undefined): TaskQueueSections {
	const tasks = q?.tasks ?? [];
	const open = (t: UiTaskQueueTask) =>
		t.status === "working" ||
		t.status === "asking" ||
		t.status === "stuck" ||
		t.status === "waiting" ||
		t.status === "blocked";
	return {
		inChats: tasks.filter((t) => t.lane && open(t)),
		current: tasks.find((t) => !t.lane && (t.status === "working" || t.status === "asking" || t.status === "stuck")),
		waiting: tasks.filter((t) => !t.lane && t.status === "waiting"),
		ready: tasks.filter((t) => t.status === "ready"),
		done: tasks.filter((t) => t.status === "done").sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)),
	};
}

/** 顶上那行状态说哪句话。 */
export function taskQueueStatusKey(q: UiTaskQueue, s: TaskQueueSections): TKey {
	// queue-paused: the owner paused the whole queue; a task he paused doesn't wait on him.
	if (q.hold) return "taskQueueStatusPausedByYou";
	const needsYou = (t: UiTaskQueueTask | undefined) => t?.status === "stuck" && !t.hold;
	if (needsYou(s.current) || s.inChats.some(needsYou)) return "taskQueueStatusStuck";
	if (q.running) {
		if (s.current) return "taskQueueStatusWorking";
		if (s.inChats.length === 1) return "taskQueueStatusLane";
		if (s.inChats.length > 1) return "taskQueueStatusLanes";
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

/** queue-paused: the owner's pause an open task is under: its own, else its whole queue's. */
export function taskQueueHeldOf(q: Pick<UiTaskQueue, "hold">, task: UiTaskQueueTask): UiTaskQueueHold | undefined {
	return task.status === "done" ? undefined : (task.hold ?? q.hold);
}

/** queue-paused: "Paused by you \u00b7 since 12:10 \u00b7 why" ("with the whole queue" when it's the queue's pause). */
function PausedLine({
	hold,
	whole,
	banner,
	children,
}: {
	hold: UiTaskQueueHold;
	/** A task paused with its whole queue (not on its own). */
	whole?: boolean;
	/** The queue's own banner. */
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

/** queue-side-by-side: "#31", "#31, #32", "#1, #2, #3": plain numbers, so every language reads them. */
export function taskNumbers(ids: number[]): string {
	return ids.map((n) => `#${n}`).join(", ");
}

/** queue-blocked: "#12" in its own queue, "temper #38" in another. */
export function refLabel(r: Pick<UiTaskQueueRef, "name" | "id">): string {
	return r.name ? `${r.name} #${r.id}` : `#${r.id}`;
}

/** queue-blocked: an outside `after` its queue hasn't recorded over, and that isn't over there either. */
function outsideOpen(r: UiTaskQueueRef): boolean {
	return !r.over && r.status !== "done" && r.status !== "removed" && r.status !== "gone";
}

/**
 * queue-blocked: the after line's parts: every task it comes after (this queue's numbers, then other queues'
 * tasks, "temper #38"), and the ones still open. queue-why: the open ones with how each stands (this queue's
 * from the server's waitingForRefs; an older server sends only their numbers), and the ones only the owner can
 * move on: paused by him (`resume`). Those count only while it hasn't started (after only holds back a start),
 * and not for a task in this queue paused only with the whole queue (the queue's banner says that).
 */
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

/** queue-blocked: how a task a blocked task waits on stands, in a word or two (queue-why: the after line's too). */
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
		case "removed":
		case "gone":
			return "taskQueueRefRemoved";
		default:
			return undefined;
	}
}

/**
 * queue-blocked: a task another one waits on, "temper #38 (working)": a link when it has somewhere to go (its
 * chat, or queue-why: the task in this panel) and how it stands. One its owner paused shows as "paused by you"
 * and doesn't need him while paused.
 */
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
			{key && <span className="task-queue-ref-state"> ({t(key)})</span>}
		</span>
	);
}

const SLOT = "\u0000";
/** queue-why: a text with SLOT in it, the slot filled with nodes (so each language keeps its own word order). */
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

/**
 * queue-why: "After #12, #45 \u00b7 still waiting for #45 (paused by you)": every open one with how it stands; one
 * in this queue shows it in the panel, one in another queue opens its chat. Below it, muted: "Can't start until
 * you resume #45" when the owner's pause holds it back (his own choice, so not a needs-you).
 */
function AfterLine({
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
	// Another queue's task: its own chat once it has one, else that queue's chat (where it can be resumed).
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

/** queue-blocked: the Blocked line: "on temper #38 (working)", or the need, plus when it's poked next. One line. */
function BlockedLine({ block, onOpenChat }: { block: UiTaskQueueBlock; onOpenChat?: (file: string) => void }) {
	const t = useT();
	const refs = block.on ?? [];
	const next = block.poke
		? t("taskQueueBlockedPoked", { time: lineTime(block.poke.at) })
		: block.nextPokeAt !== undefined
			? t(block.nextIsAsk ? "taskQueueBlockedAsk" : "taskQueueBlockedNext", { time: lineTime(block.nextPokeAt) })
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
				{next && <span className="task-queue-blocked-next">{` \u00b7 ${next}`}</span>}
			</span>
		</div>
	);
}

/** telegram-answers: answer a stuck task here: one of its choices, or typed words. The answer goes
 *  into the chat the task runs in, as your reply, and it carries on (Telegram gets told too). */
function StuckAnswer({ task, onAnswer }: { task: UiTaskQueueTask; onAnswer: (taskId: number, text: string) => void }) {
	const t = useT();
	const [text, setText] = useState("");
	const [sent, setSent] = useState(false);
	const choicesKey = (task.choices ?? []).join("\u0001");
	// A new question (or new choices) can be answered again.
	useEffect(() => setSent(false), [task.question, choicesKey]);
	useEffect(() => {
		if (!sent) return;
		const timer = setTimeout(() => setSent(false), BUSY_MS);
		return () => clearTimeout(timer);
	}, [sent]);
	const send = (value: string) => {
		const words = value.trim();
		if (!words || sent) return;
		setSent(true);
		setText("");
		onAnswer(task.id, words);
	};
	return (
		<div className="task-queue-answer">
			{task.choices && task.choices.length > 0 && (
				<div className="task-queue-choices">
					{task.choices.map((c) => (
						<button key={c} type="button" className="task-queue-choice" disabled={sent} onClick={() => send(c)}>
							{c}
						</button>
					))}
				</div>
			)}
			<form
				className="task-queue-answer-form"
				onSubmit={(e) => {
					e.preventDefault();
					send(text);
				}}
			>
				<input
					className="task-queue-answer-input"
					value={text}
					disabled={sent}
					placeholder={t("taskQueueAnswerPlaceholder")}
					aria-label={t("taskQueueAnswerPlaceholder")}
					onChange={(e) => setText(e.target.value)}
				/>
				<button type="submit" className="task-queue-answer-send" disabled={sent || !text.trim()}>
					{t("taskQueueAnswerSend")}
				</button>
			</form>
			<span className="task-queue-hint">
				{t(task.lane ? "taskQueueAnswerGoesToTaskChat" : "taskQueueAnswerGoesHere")}
			</span>
		</div>
	);
}

export const TaskQueuePanel = memo(function TaskQueuePanel({
	queue,
	onCommand,
	onAnswer,
	onOpenChat,
	models = [],
	defaultOpen = [],
	focus,
}: {
	queue: UiTaskQueue | undefined;
	/** telegram-answers: answer a stuck task (a choice or typed words). Not given = answer in the chat. */
	onAnswer?: (taskId: number, text: string) => void;
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
	// roles-overview: the task asked for from the Roles page (a done one beyond the first few shows them all).
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
		// Only a new request (seq) moves the view; later queue updates don't.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [focus?.seq, queue === undefined]);
	useEffect(() => {
		if (flash === null) return;
		const el = rootRef.current?.querySelector(`[data-task-id="${flash}"]`);
		if (el instanceof HTMLElement) el.scrollIntoView?.({ block: "nearest" });
	}, [flash, allDone]);
	// queue-why: a task named on an after line, shown the same way (and its title focused, for the keyboard).
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

	if (!queue) {
		return (
			<div className="task-queue-panel">
				<p className="task-queue-empty">{t("taskQueueEmpty")}</p>
			</div>
		);
	}

	const s = taskQueueSections(queue);
	// queue-lanes: a task's own chat only shows its task; the queue is steered from the queue's chat.
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
	// queue-lanes: which lane each open task is in, and whether the lanes setting is worth showing.
	const laneNo = new Map<number, number>();
	for (const lane of queue.lanes ?? []) for (const id of lane.taskIds) laneNo.set(id, lane.n);
	const lanesAtOnce = queue.lanesAtOnce ?? DEFAULT_LANES;
	const showLanes =
		!queue.from &&
		(!!queue.lanes ||
			queue.lanesAtOnce !== undefined ||
			queue.tasks.some((x) => x.touches !== undefined && x.status !== "done"));
	const stuckInChat = s.inChats.find((x) => x.status === "stuck" && !taskQueueHeldOf(queue, x));
	const currentNeedsYou = s.current?.status === "stuck" && !taskQueueHeldOf(queue, s.current);

	const row = (task: UiTaskQueueTask, kind: "current" | "lane" | "waiting" | "ready" | "done", index = 0) => {
		const expanded = open.has(task.id);
		const wait = kind === "waiting" ? task.wait : undefined;
		// queue-paused: the owner's pause on it (its own, or its whole queue's).
		const held = taskQueueHeldOf(queue, task);
		// queue-main-chat: a task asking its main chat doesn't need the user (yet): plain, no needs-you.
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
				: (kind === "current" || kind === "lane" || kind === "waiting") && task.startedAt
					? t("taskQueueStarted", { time: lineTime(task.startedAt) })
					: "";
		return (
			<li key={task.id} className={flash === task.id ? `${cls} task-queue-focus` : cls} data-task-id={task.id}>
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
					{kind !== "done" && laneNo.has(task.id) && (
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
					{kind !== "done" && controls && (
						// queue-paused: the owner's Pause / Resume on this task (Resume lifts only its own pause).
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
				{held && kind !== "done" && <PausedLine hold={held} whole={!task.hold} />}
				{task.status === "asking" && (
					<div className="task-queue-asking" title={task.question}>
						<span className="task-queue-hint">{t("taskQueueAskingMain")}</span>
					</div>
				)}
				{task.status === "blocked" && task.block && <BlockedLine block={task.block} onOpenChat={onOpenChat} />}
				{task.status === "stuck" && (
					<div className="task-queue-question">
						{/* queue-paused: a paused task doesn't need you while paused: resume it to answer. */}
						{!held && <span className="task-queue-badge">{t("taskQueueNeedsYou")}</span>}
						{task.question && <span className="task-queue-question-text">{task.question}</span>}
						{held ? (
							<span className="task-queue-hint">{t("taskQueuePausedAnswerLater")}</span>
						) : onAnswer && queue.available ? (
							<StuckAnswer task={task} onAnswer={onAnswer} />
						) : (
							<span className="task-queue-hint">{t(task.lane ? "taskQueueAnswerInChat" : "taskQueueAnswerHint")}</span>
						)}
					</div>
				)}
				{kind !== "done" && task.touches !== undefined && (
					<div className="task-queue-touches">
						{task.touches.length > 0 ? `${t("taskQueueTouches")}: ${task.touches.join(", ")}` : t("taskQueueRunsAlone")}
					</div>
				)}
				{kind !== "done" && (!!task.after?.length || !!task.outside?.length) && (
					// queue-blocked: tasks in other queues ("temper #38") after this queue's numbers.
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
								{/* queue-paused: its give-up clock stops while paused (it moves later on resume). */}
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
								disabled={busy || !!pendingSetting}
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
	};

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
						id: s.current?.id ?? stuckInChat?.id ?? s.inChats[0]?.id ?? s.waiting[0]?.id ?? "",
						n: s.inChats.length,
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
					// queue-paused: the owner's pause on the whole queue (separate from Stop, and stronger).
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
		</div>
	);
});
