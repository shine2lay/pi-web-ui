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
 *
 * queue-lanes: a task can list what it touches (projects, repos, services). Tasks that share a touch
 * form a lane and run one after another; unrelated lanes run side by side, each task in a fresh chat
 * of its own (pi-queue starts it through pi-web-ui's queue host, see queue-host.ts). The mirror keeps
 * pi-queue's lane rules: lane tasks may be open at the same time, the in-chat "one current task" rule
 * applies to the other tasks only. In a task's own chat the first entry (`assigned`) says which queue
 * it came from.
 *
 * queue-side-by-side: touches in pi-queue's shareable list (~/.pi/agent/pi-queue.json `shareable`;
 * by default every "* repo" and pi-web-deploy) don't join lanes, so tasks that share only those run side
 * by side; and a task can come after others (`after`): it starts only once each is done or removed.
 * tests/unit/task-queue.test.ts replays the same queues through pi-queue's own queue.ts to keep the two
 * sets of rules equal.
 */

import { readFileSync, statSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { checkPatch, normProfile, normLaunch, patchProfile } from "./queue-profile.js";
import type {
	UiTaskQueue,
	UiTaskQueueChat,
	UiTaskQueueLane,
	UiTaskQueuePlan,
	UiTaskQueueTask,
	UiTaskQueueWait,
	UiTaskProfile,
} from "./protocol.js";

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
	launchPrepared?: boolean;
}

interface State {
	queueId?: string;
	autoApprove: boolean;
	autoStart: boolean;
	profile?: UiTaskProfile;
	tasks: Task[];
	running: boolean;
	pausedReason?: PauseReason;
	/** queue-lanes: how many lanes may run at once (pi-queue's DEFAULT_LANES / MAX_LANES). */
	lanes: number;
	/** queue-lanes: set in a task's own chat — the queue it came from. */
	from?: UiTaskQueueChat;
}

export const TASK_QUEUE_DEFAULT_LANES = 2;
export const TASK_QUEUE_MAX_LANES = 8;

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

const OPEN: ReadonlySet<Status> = new Set(["ready", "working", "stuck", "waiting"]);
/** 当前任务：正在做或卡住的那个（最多一个）。搁着等的任务不算当前任务，别的任务可以接着做。
 *  queue-lanes: tasks running in chats of their own don't count (they run side by side). */
const current = (s: State) => s.tasks.find((t) => !t.lane && (t.status === "working" || t.status === "stuck"));

/** pi-queue's normTouches: trimmed, lower case, inner spaces collapsed, no duplicates; undefined = not a list. */
export function normTouches(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: string[] = [];
	for (const x of raw) {
		if (typeof x !== "string") continue;
		const t = x.trim().replace(/\s+/g, " ").toLowerCase();
		if (t && t.length <= 80 && !out.includes(t)) out.push(t);
	}
	return out.slice(0, 20);
}

/** queue-side-by-side: pi-queue's normAfter: whole task numbers ("#4" too), no duplicates, never the task
 *  itself; undefined = not a list. */
export function normAfter(raw: unknown, self?: number): number[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: number[] = [];
	for (const x of raw) {
		const n = typeof x === "number" ? x : typeof x === "string" ? Number(x.trim().replace(/^#/, "")) : Number.NaN;
		if (Number.isInteger(n) && n > 0 && n !== self && !out.includes(n)) out.push(n);
	}
	return out.slice(0, 20);
}

/** queue-side-by-side: pi-queue's DEFAULT_SHAREABLE: touches tasks may share and still run side by side. */
export const TASK_QUEUE_DEFAULT_SHAREABLE: readonly string[] = ["* repo", "pi-web-deploy"];

/** queue-side-by-side: pi-queue's shareableOf: `*` stands for any run of characters, the rest matches itself. */
export function taskQueueShareableOf(
	patterns: readonly unknown[] = TASK_QUEUE_DEFAULT_SHAREABLE,
): (touch: string) => boolean {
	const exact = new Set<string>();
	const globs: RegExp[] = [];
	for (const p of normTouches([...patterns]) ?? []) {
		if (!p.includes("*")) exact.add(p);
		else
			globs.push(
				new RegExp(
					`^${p
						.split("*")
						.map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
						.join(".*")}$`,
				),
			);
	}
	return (touch) => exact.has(touch) || globs.some((g) => g.test(touch));
}

/** queue-side-by-side: pi-queue's shareableSetting: the settings' `shareable` list, or the default without one. */
export function taskQueueShareableSetting(settings: unknown): string[] {
	const list = settings && typeof settings === "object" ? (settings as { shareable?: unknown }).shareable : undefined;
	return normTouches(list) ?? [...TASK_QUEUE_DEFAULT_SHAREABLE];
}

let shareableCache: { file: string; stamp: string; patterns: string[] } | undefined;

/**
 * queue-side-by-side: the shareable patterns in pi-queue's settings file (read again only when it
 * changes, like pi-queue does), and a stamp that changes with them (for the snapshot cache). A missing
 * or unreadable file means the default.
 */
export function taskQueueShareableFrom(file: string): { stamp: string; patterns: string[] } {
	let stamp = "none";
	try {
		const st = statSync(file);
		stamp = `${st.mtimeMs}:${st.size}`;
	} catch {
		// no settings file: the default
	}
	if (shareableCache?.file === file && shareableCache.stamp === stamp) return shareableCache;
	let settings: unknown;
	if (stamp !== "none") {
		try {
			settings = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			// unreadable or half written: the default until it reads
		}
	}
	shareableCache = { file, stamp, patterns: taskQueueShareableSetting(settings) };
	return shareableCache;
}

/** telegram-answers: pi-queue's MAX_CHOICES / CHOICE_MAX. */
const MAX_CHOICES = 4;
const CHOICE_MAX = 100;

/** telegram-answers: pi-queue's normChoices: a stuck task's answers to pick from, trimmed, inner spaces
 *  collapsed, no empties or duplicates (any case), each cut to CHOICE_MAX, at most MAX_CHOICES. */
export function normChoices(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const x of raw) {
		if (typeof x !== "string") continue;
		const c = x.replace(/\s+/g, " ").trim();
		if (!c || out.some((o) => o.toLowerCase() === c.toLowerCase())) continue;
		out.push(c.length > CHOICE_MAX ? `${c.slice(0, CHOICE_MAX - 1)}\u2026` : c);
	}
	return out.slice(0, MAX_CHOICES);
}

/** A chat reference from an entry ({file, title?}); null when it isn't one. */
function chatOf(raw: unknown): UiTaskQueueChat | null {
	const c = (raw ?? {}) as Record<string, unknown>;
	if (typeof c.file !== "string" || !c.file) return null;
	const title = typeof c.title === "string" && c.title ? cap(c.title, 200) : undefined;
	return { file: c.file, ...(title ? { title } : {}) };
}

/** wait 条目缺数字时用 pi-queue 的默认值（queue.ts 的 DEFAULT_EVERY_MS / DEFAULT_GIVE_UP_MS）。 */
const DEFAULT_EVERY_MS = 2 * 60_000;
const DEFAULT_GIVE_UP_MS = 24 * 3_600_000;
const numOr = (x: unknown, fallback: number) => (typeof x === "number" && Number.isFinite(x) ? x : fallback);

/** 应用一条变化（pi-queue applyOp 的镜像）：和队列现状对不上的变化忽略。 */
function apply(s: State, raw: unknown): void {
	if (!raw || typeof raw !== "object") return;
	const op = raw as Record<string, unknown>;
	if (op.v !== 1) return;
	if (op.op === "autonomy") {
		if (s.from || !s.queueId || op.queueId !== s.queueId) return;
		if (op.setting !== "autoApprove" && op.setting !== "autoStart") return;
		s[op.setting] = op.value === true;
		if (op.setting === "autoStart" && s.autoStart && s.pausedReason === "user") s.pausedReason = undefined;
		return;
	}
	if (op.op === "profile" || op.op === "task_profile") {
		if (s.from || !s.queueId || op.queueId !== s.queueId) return;
		const { patch } = checkPatch(op);
		if (!Object.keys(patch).length) return;
		if (op.op === "profile") {
			s.profile = patchProfile(s.profile, patch);
			for (const t of s.tasks) if (t.status === "ready") t.problem = undefined;
		} else {
			const task = s.tasks.find((t) => t.id === op.id);
			if (!task || task.status !== "ready" || task.startedAt !== undefined) return;
			task.profile = patchProfile(task.profile, patch);
			task.problem = undefined;
		}
		return;
	}
	if (op.op === "run") {
		if (op.queueId !== undefined && op.queueId !== s.queueId) return;
		s.running = true;
		s.pausedReason = undefined;
		return;
	}
	if (op.op === "pause") {
		s.running = false;
		const reason = op.reason as PauseReason;
		s.pausedReason = PAUSE_REASONS.has(reason) ? reason : undefined;
		if (reason === "user") s.autoStart = false;
		return;
	}
	if (op.op === "clear") {
		for (const t of s.tasks) if (t.status === "done") t.status = "removed";
		return;
	}
	if (op.op === "lanes") {
		const n = typeof op.n === "number" && Number.isFinite(op.n) ? op.n : TASK_QUEUE_DEFAULT_LANES;
		s.lanes = Math.round(Math.min(TASK_QUEUE_MAX_LANES, Math.max(1, n)));
		return;
	}
	if (!isId(op.id)) return;
	if (op.op === "add" || op.op === "assigned") {
		if (s.tasks.some((t) => t.id === op.id)) return;
		const task: Task = { id: op.id, plan: planOf(op.plan), status: "ready", addedAt: num(op.ts) };
		if (op.op === "add" && (op.approval === "dialog" || op.approval === "auto")) task.approval = op.approval;
		const touches = normTouches(op.touches);
		if (touches) task.touches = touches;
		const after = normAfter(op.after, op.id);
		if (after?.length) task.after = after;
		if (op.op === "add") task.profile = normProfile(op.profile);
		if (op.op === "assigned") {
			task.launch = normLaunch(op.launch);
			s.profile = undefined;
			// A task's own chat: it works on this one task from the start.
			const from = chatOf(op.from);
			if (s.from || !from) return;
			s.from = from;
			s.autoApprove = false;
			s.autoStart = false;
			task.status = "working";
			task.startedAt = num(op.ts);
			s.running = true;
			s.pausedReason = undefined;
		}
		s.tasks.push(task);
		return;
	}
	const task = s.tasks.find((t) => t.id === op.id);
	if (!task || !OPEN.has(task.status)) return;
	switch (op.op) {
		case "update": {
			task.plan = planOf(op.plan);
			task.approval = op.approval === "dialog" || op.approval === "auto" ? op.approval : undefined;
			const touches = normTouches(op.touches);
			if (touches) task.touches = touches;
			// queue-side-by-side: after is replaced when given ([] clears it), kept when not.
			const after = normAfter(op.after, task.id);
			if (after?.length) task.after = after;
			else if (after) delete task.after;
			if (op.profile && task.status === "ready" && task.startedAt === undefined) {
				const { patch } = checkPatch(op.profile);
				if (Object.keys(patch).length) {
					task.profile = patchProfile(task.profile, patch);
					task.problem = undefined;
				}
			}
			return;
		}
		case "prepared": {
			if (!task.lane || !task.launch || task.launchPrepared) return;
			const launch = normLaunch(op.launch);
			if (launch) {
				task.launch = launch;
				task.launchPrepared = true;
			}
			return;
		}
		case "blocked":
			if (task.status === "ready" && typeof op.reason === "string" && op.reason) task.problem = op.reason.slice(0, 500);
			return;
		case "chat": {
			const chat = chatOf(op);
			if (!task.lane || task.chat || !chat) return;
			task.chat = chat;
			return;
		}
		case "requeue":
			// A lane task whose chat never got going goes back to its place in the queue.
			if ((!task.lane || task.chat) && !(!task.lane && task.touches !== undefined && task.status === "working")) return;
			task.status = "ready";
			task.lane = undefined;
			task.question = undefined;
			task.choices = undefined;
			task.wait = undefined;
			task.startedAt = undefined;
			task.launch = undefined;
			task.launchPrepared = undefined;
			return;
		case "start":
		case "resume": {
			if (op.op === "start" && task.status !== "ready") return;
			// Lane tasks run in chats of their own, side by side. In this chat: 同一时间只有一个当前任务，
			// 新任务或搁着的任务只在没有当前任务时开始（和 pi-queue 一样）。
			const lane = op.op === "start" ? op.lane === true : task.lane === true;
			if (!lane) {
				const cur = current(s);
				if ((op.op === "start" || task.status === "waiting") && cur && cur !== task) return;
			}
			if (lane) task.lane = true;
			if (op.op === "start") {
				task.problem = undefined;
				task.launch = normLaunch(op.launch);
			}
			task.status = "working";
			task.question = undefined;
			task.choices = undefined;
			task.wait = undefined;
			task.startedAt ??= num(op.ts);
			return;
		}
		case "stuck": {
			const cur = current(s);
			if (!task.lane && cur && cur !== task) return;
			task.status = "stuck";
			task.question = str(op.question, NOTE_MAX);
			const choices = normChoices(op.choices);
			if (choices.length) task.choices = choices;
			else delete task.choices;
			task.wait = undefined;
			task.startedAt ??= num(op.ts);
			return;
		}
		case "wait": {
			if (task.status !== "working" && task.status !== "waiting") return;
			const since = num(op.ts);
			const wait: UiTaskQueueWait = {
				what: str(op.what, 200),
				check: str(op.check, 1000),
				everyMs: numOr(op.everyMs, DEFAULT_EVERY_MS),
				since,
				until: numOr(op.until, since + DEFAULT_GIVE_UP_MS),
			};
			task.status = "waiting";
			task.question = undefined;
			task.choices = undefined;
			task.wait = wait;
			task.startedAt ??= since;
			return;
		}
		case "wait_over":
			if (task.status !== "waiting" || !task.wait || task.wait.overAt) return;
			task.wait.overAt = num(op.ts);
			if (op.failed) task.wait.failed = cap(String(op.failed), NOTE_MAX);
			return;
		case "done":
			task.status = "done";
			task.question = undefined;
			task.choices = undefined;
			task.wait = undefined;
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
 * queue-side-by-side: `shareable`: pi-queue's shareable patterns (taskQueueShareableFrom).
 */
export function taskQueueFromEntries(
	entries: Iterable<TaskQueueEntryLike>,
	available: boolean,
	maxDone = TASK_QUEUE_MAX_DONE,
	shareable: readonly string[] = TASK_QUEUE_DEFAULT_SHAREABLE,
	queueId?: string,
): UiTaskQueue {
	const s: State = {
		tasks: [],
		running: false,
		lanes: TASK_QUEUE_DEFAULT_LANES,
		autoApprove: false,
		autoStart: false,
		queueId,
	};
	for (const e of entries) {
		if (e.type === "custom" && e.customType === TASK_QUEUE_ENTRY_TYPE) apply(s, e.data);
	}
	const done = s.tasks.filter((t) => t.status === "done").sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
	const dropped = new Set(done.slice(maxDone));
	// queue-side-by-side: an open task that comes after others shows which of them are still open
	// (pi-queue's openDeps: not done or removed yet, in queue order).
	for (const t of s.tasks) {
		if (!t.after || !OPEN.has(t.status)) continue;
		const open = s.tasks.filter((d) => t.after?.includes(d.id) && OPEN.has(d.status)).map((d) => d.id);
		if (open.length) t.waitingFor = open;
	}
	const tasks = s.tasks.filter((t): t is UiTaskQueueTask => t.status !== "removed" && !dropped.has(t));
	// queue-lanes: only a queue with tasks that run in chats of their own shows lanes (a task's own chat never).
	const lanes = s.from ? [] : lanesOf(s.tasks, taskQueueShareableOf(shareable));
	return {
		...(queueId ? { queueId } : {}),
		autoApprove: s.autoApprove,
		autoStart: s.autoStart,
		...(s.profile ? { profile: s.profile } : {}),
		running: s.running,
		...(s.pausedReason ? { pausedReason: s.pausedReason } : {}),
		available,
		tasks,
		...(lanes.some((l) => !l.inChat)
			? { lanes: lanes.map((l) => ({ n: l.n, touches: l.touches, alone: l.alone, taskIds: l.taskIds })) }
			: {}),
		...(s.lanes !== TASK_QUEUE_DEFAULT_LANES ? { lanesAtOnce: s.lanes } : {}),
		...(s.from ? { from: s.from } : {}),
	};
}

/**
 * queue-lanes: the open tasks grouped into lanes (pi-queue's lanesOf, with pi-web-ui as the host):
 * tasks that share a touch, directly or through other open tasks, are one lane. A task that runs
 * alone (nothing declared, or added before lanes existed: it runs in the queue's own chat) is a lane
 * of its own. Lanes are numbered in queue order of their first open task.
 * queue-side-by-side: shareable touches don't join lanes (a task with only those still has its own).
 */
function lanesOf(all: Task[], shareable: (touch: string) => boolean): (UiTaskQueueLane & { inChat: boolean })[] {
	const open = all.filter((t) => OPEN.has(t.status));
	const inChat = (t: Task) => !t.lane && t.touches === undefined;
	const alone = (t: Task) => inChat(t) || !t.touches || t.touches.length === 0;
	const parent = open.map((_, i) => i);
	const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
	const owner = new Map<string, number>();
	open.forEach((t, i) => {
		if (alone(t)) return;
		for (const touch of t.touches ?? []) {
			if (shareable(touch)) continue;
			const j = owner.get(touch);
			if (j === undefined) owner.set(touch, i);
			else parent[find(i)] = find(j);
		}
	});
	const byRoot = new Map<number, UiTaskQueueLane & { inChat: boolean }>();
	const lanes: (UiTaskQueueLane & { inChat: boolean })[] = [];
	open.forEach((t, i) => {
		const root = find(i);
		let lane = byRoot.get(root);
		if (!lane) {
			lane = { n: lanes.length + 1, touches: [], alone: alone(t), taskIds: [], inChat: inChat(t) };
			byRoot.set(root, lane);
			lanes.push(lane);
		}
		lane.taskIds.push(t.id);
		for (const touch of t.touches ?? []) if (!lane.touches.includes(touch)) lane.touches.push(touch);
	});
	return lanes;
}

/** 面板按钮 → pi-queue 的命令行；参数不对返回 null（不发）。 */
export function taskQueueCommandLine(action: unknown, id: unknown): string | null {
	if (action === "start" || action === "stop" || action === "clear") return `/queue ${action}`;
	// queue-lanes: how many lanes may run at once (id carries the number).
	if (action === "lanes") {
		return isId(id) && id <= TASK_QUEUE_MAX_LANES ? `/queue lanes ${id}` : null;
	}
	if (action === "up" || action === "down" || action === "remove") return isId(id) ? `/queue ${action} ${id}` : null;
	return null;
}

/**
 * queue-done-hidden: one entry of a transcript, read from the start. A queued task's own chat starts
 * with pi-queue's "assigned" entry (the task, and the queue it came from), written before its first
 * message. true = that entry, false = a message came first (not a task's chat), undefined = neither:
 * read on.
 */
export function taskChatHeadEntry(raw: unknown): boolean | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const e = raw as { type?: unknown; customType?: unknown; data?: unknown };
	if (e.type === "message") return false;
	if (e.type !== "custom" || e.customType !== TASK_QUEUE_ENTRY_TYPE) return undefined;
	const op = (e.data ?? {}) as { op?: unknown; from?: unknown };
	return op.op === "assigned" ? chatOf(op.from) !== null : undefined;
}

/** queue-done-hidden: whether these entries (oldest first) are a queued task's own chat. */
export function isQueueTaskChatEntries(entries: Iterable<unknown>): boolean {
	for (const e of entries) {
		const verdict = taskChatHeadEntry(e);
		if (verdict !== undefined) return verdict;
	}
	return false;
}

/**
 * queue-done-hidden: whether the transcript at `file` is a queued task's own chat. Reads only its
 * start, up to the first message (at most `maxBytes`); false when it can't tell.
 */
export async function isQueueTaskChatFile(file: string, maxBytes = 1024 * 1024): Promise<boolean> {
	let fh: FileHandle | undefined;
	try {
		fh = await open(file, "r");
		const decoder = new StringDecoder("utf8");
		const chunk = Buffer.alloc(64 * 1024);
		let carry = "";
		const verdictOf = (line: string): boolean | undefined => {
			if (!line.includes('"type":"message"') && !line.includes(`"${TASK_QUEUE_ENTRY_TYPE}"`)) return undefined;
			try {
				return taskChatHeadEntry(JSON.parse(line));
			} catch {
				return undefined;
			}
		};
		for (let pos = 0; pos < maxBytes;) {
			const { bytesRead } = await fh.read(chunk, 0, Math.min(chunk.length, maxBytes - pos), pos);
			if (!bytesRead) return verdictOf(carry + decoder.end()) === true;
			pos += bytesRead;
			const lines = (carry + decoder.write(chunk.subarray(0, bytesRead))).split("\n");
			carry = lines.pop() ?? "";
			for (const line of lines) {
				const verdict = verdictOf(line);
				if (verdict !== undefined) return verdict;
			}
		}
		return false;
	} catch {
		return false;
	} finally {
		await fh?.close().catch(() => {});
	}
}
