/**
 * 任务队列（queue-panel）。
 *
 * pi-queue 扩展（~/projects/pi-queue）给每条对话一个任务队列：用户和 agent 先把一个任务
 * 计划透（目标、怎样算做完、一起定下的、步骤、怎么验收、不做什么），用户在对话框里批准了
 * 才进队列；按下「开始」后 agent 一个接一个自己做完。队列从不整份存：每次变化是会话里的
 * 一条自定义条目，
 *
 *   { type: "custom", customType: "queue", data: { v: 1, op: "add" | "update" | "start" | …, … } }
 *
 * 沿**当前分支**按顺序重放出队列，规则和 pi-queue queue.ts 的 applyOp 一字不差（面板显示的
 * 必须就是 pi-queue 接下来会做的）。右栏的「队列」tab 显示它，按钮（开始 / 停下 / 调顺序 /
 * 删除）一律转成 `/queue …` 命令交给 pi-queue 执行：pi-web-ui 自己从不写队列条目。
 *
 * 和 UiState.queue（输入框里排队 / 插队的提问）不是一回事，所以这边一律叫 task queue。
 *
 * 条目格式是和 pi-queue 的约定，这里对坏数据一律跳过或兜底，不抛。
 */

import type { UiTaskQueue, UiTaskQueuePlan, UiTaskQueueTask } from "./protocol.js";

/** pi-queue 的 customType（与 pi-queue queue.ts 的 ENTRY_TYPE 一致）。 */
export const TASK_QUEUE_ENTRY_TYPE = "queue";

/** 最多发多少个做完的任务：只留最近做完的。排着的和正在做的一个不少。 */
export const TASK_QUEUE_MAX_DONE = 20;

/** 计划每一部分的字数上限：pi-queue 不限长，防一份失控的计划把快照撑大。 */
const PART_MAX = 4000;
/** 问题 / 总结的字数上限（pi-queue 自己把「停了两次」的问题截在 400）。 */
const NOTE_MAX = 2000;

type PauseReason = NonNullable<UiTaskQueue["pausedReason"]>;
const PAUSE_REASONS = new Set<PauseReason>(["user", "stopped", "error", "restart", "finished"]);

type Status = UiTaskQueueTask["status"] | "removed";

/** 重放用的任务（带 removed；发出去之前滤掉）。 */
interface Task extends Omit<UiTaskQueueTask, "status"> {
	status: Status;
}

interface State {
	tasks: Task[];
	running: boolean;
	pausedReason?: PauseReason;
}

const cap = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);
const str = (x: unknown, max: number) => (typeof x === "string" ? cap(x, max) : "");
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const isId = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x > 0;

function planOf(raw: unknown): UiTaskQueuePlan {
	const p = (raw ?? {}) as Record<string, unknown>;
	return {
		title: str(p.title, 200),
		goal: str(p.goal, PART_MAX),
		doneWhen: str(p.doneWhen, PART_MAX),
		decided: str(p.decided, PART_MAX),
		steps: str(p.steps, PART_MAX),
		verify: str(p.verify, PART_MAX),
		mustNot: str(p.mustNot, PART_MAX),
	};
}

const OPEN: ReadonlySet<Status> = new Set(["ready", "working", "stuck"]);
const current = (s: State) => s.tasks.find((t) => t.status === "working" || t.status === "stuck");

/** 应用一条变化（pi-queue applyOp 的镜像）：和队列现状对不上的变化忽略。 */
function apply(s: State, raw: unknown): void {
	if (!raw || typeof raw !== "object") return;
	const op = raw as Record<string, unknown>;
	if (op.v !== 1) return;
	if (op.op === "run") {
		s.running = true;
		s.pausedReason = undefined;
		return;
	}
	if (op.op === "pause") {
		s.running = false;
		const reason = op.reason as PauseReason;
		s.pausedReason = PAUSE_REASONS.has(reason) ? reason : undefined;
		return;
	}
	if (!isId(op.id)) return;
	if (op.op === "add") {
		if (s.tasks.some((t) => t.id === op.id)) return;
		s.tasks.push({ id: op.id, plan: planOf(op.plan), status: "ready", addedAt: num(op.ts) });
		return;
	}
	const task = s.tasks.find((t) => t.id === op.id);
	if (!task || !OPEN.has(task.status)) return;
	switch (op.op) {
		case "update":
			task.plan = planOf(op.plan);
			return;
		case "start":
		case "resume": {
			const cur = current(s);
			if (op.op === "start" && cur && cur !== task) return;
			task.status = "working";
			task.question = undefined;
			task.startedAt ??= num(op.ts);
			return;
		}
		case "stuck":
			task.status = "stuck";
			task.question = str(op.question, NOTE_MAX);
			task.startedAt ??= num(op.ts);
			return;
		case "done":
			task.status = "done";
			task.question = undefined;
			task.summary = str(op.summary, NOTE_MAX);
			task.doneAt = num(op.ts);
			return;
		case "remove":
			task.status = "removed";
			return;
		case "move": {
			if (task.status !== "ready") return;
			const others = s.tasks.filter((t) => t !== task);
			// 和 pi-queue 一样：index 不是数时 Math.max 得 NaN，取不到锚点，排到最后。
			const anchor = others.filter((t) => t.status === "ready")[Math.max(0, op.index as number)];
			others.splice(anchor ? others.indexOf(anchor) : others.length, 0, task);
			s.tasks = others;
			return;
		}
	}
}

/** 只用到的会话条目字段（SessionEntry 的子集，测试好造）。 */
export interface TaskQueueEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

/**
 * 分支条目（按根 → 叶的顺序）→ 这条对话的任务队列。
 * tasks 按队列顺序（排着的就按这个顺序做），删掉的不带；做完的只留最近 `maxDone` 个。
 * `available`：这条对话装了 pi-queue（有 /queue 命令），面板据此决定给不给按钮。
 */
export function taskQueueFromEntries(
	entries: Iterable<TaskQueueEntryLike>,
	available: boolean,
	maxDone = TASK_QUEUE_MAX_DONE,
): UiTaskQueue {
	const s: State = { tasks: [], running: false };
	for (const e of entries) {
		if (e.type === "custom" && e.customType === TASK_QUEUE_ENTRY_TYPE) apply(s, e.data);
	}
	const done = s.tasks.filter((t) => t.status === "done").sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
	const dropped = new Set(done.slice(maxDone));
	const tasks = s.tasks.filter((t): t is UiTaskQueueTask => t.status !== "removed" && !dropped.has(t));
	return {
		running: s.running,
		...(s.pausedReason ? { pausedReason: s.pausedReason } : {}),
		available,
		tasks,
	};
}

/** 面板按钮 → pi-queue 的命令行；参数不对返回 null（不发）。 */
export function taskQueueCommandLine(action: unknown, id: unknown): string | null {
	if (action === "start" || action === "stop") return `/queue ${action}`;
	if (action === "up" || action === "down" || action === "remove") return isId(id) ? `/queue ${action} ${id}` : null;
	return null;
}
