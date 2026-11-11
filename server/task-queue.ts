import { type FileHandle, open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { normTags, resolveInheritedTags } from "./shared/task-tags.js";
import {
	DEFAULT_PRIORITY,
	PRIORITIES,
	PRIORITY_RANK,
	checkPriority,
	insertByPriority,
	normPriority,
	repositionReadyTaskByPriority,
	taskPriority,
	type PriorityCheckResult,
	type TaskPriority,
} from "./shared/task-priority.js";
import type {
	UiTaskQueue,
	UiTaskQueueChat,
	UiTaskQueueHold,
	UiTaskQueueRef,
	UiTaskQueueLane,
	UiTaskQueueTask,
} from "./protocol.js";
import {
	chatOf,
	DETAIL_MAX,
	detailOf,
	heldBy,
	isId,
	LEAD_CHAIN_MAX,
	LEAD_REMINDERS,
	leadOfReminder,
	leadRounds,
	leadsOf,
	normAfter,
	normChoices,
	normTaskRefs,
	normTouches,
	OPEN,
	roleTaskRefLabel,
	type State,
	type Status,
	type Task,
	TASK_QUEUE_DEFAULT_LANES,
	TASK_QUEUE_DEFAULT_SHAREABLE,
	TASK_QUEUE_DROP_WHY_MAX,
	TASK_QUEUE_ENTRY_TYPE,
	TASK_QUEUE_MAX_DONE,
	TASK_QUEUE_MAX_LANES,
	TASK_QUEUE_PANEL_PAUSE_WHY,
	type TaskQueueBack,
	type TaskQueueEntryLike,
	type TaskQueueTaskAny,
	taskQueueShareableFrom,
	taskQueueShareableOf,
	taskQueueShareableSetting,
	taskRefLabel,
} from "./task-queue-fields.js";
import { replayState, resetTaskQueueReplayCounts, taskQueueReplayCounts } from "./task-queue-replay.js";

export {
	DETAIL_MAX,
	DEFAULT_PRIORITY,
	LEAD_CHAIN_MAX,
	LEAD_REMINDERS,
	PRIORITIES,
	PRIORITY_RANK,
	TASK_QUEUE_DEFAULT_LANES,
	TASK_QUEUE_DEFAULT_SHAREABLE,
	TASK_QUEUE_DROP_WHY_MAX,
	TASK_QUEUE_ENTRY_TYPE,
	TASK_QUEUE_MAX_DONE,
	TASK_QUEUE_MAX_LANES,
	TASK_QUEUE_PANEL_PAUSE_WHY,
	checkPriority,
	detailOf,
	insertByPriority,
	leadOfReminder,
	leadRounds,
	leadsOf,
	normAfter,
	normChoices,
	normPriority,
	normTags,
	normTaskRefs,
	normTouches,
	repositionReadyTaskByPriority,
	resetTaskQueueReplayCounts,
	resolveInheritedTags,
	roleTaskRefLabel,
	taskPriority,
	taskQueueReplayCounts,
	taskQueueShareableFrom,
	taskQueueShareableOf,
	taskQueueShareableSetting,
	taskRefLabel,
	type PriorityCheckResult,
	type TaskPriority,
	type TaskQueueBack,
	type TaskQueueEntryLike,
	type TaskQueueTaskAny,
};

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
	const s = replayState(Array.isArray(entries) ? entries : [...entries], queueId);
	const done = s.tasks.filter((t) => t.status === "done").sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
	const dropped = s.tasks
		.filter((t) => t.status === "dropped")
		.sort((a, b) => (b.dropped?.at ?? 0) - (a.dropped?.at ?? 0));
	const hidden = new Set([...done.slice(maxDone), ...dropped.slice(maxDone)]);
	const tasks = s.tasks
		.filter((t): t is Task & UiTaskQueueTask => t.status !== "removed" && !hidden.has(t))
		.map((t) => shownTask(s, t));
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
		...(s.hold ? { hold: s.hold } : {}),
	};
}

/**
 * A task as the Queue panel shows it, on a copy of its own: the replayed task is shared and frozen (H-QUEUE-REPLAY-2),
 * and queue-blocks.ts fills in its block and the refs in it and in `outside` afterwards.
 */
function shownTask(s: State, t: Task & UiTaskQueueTask): UiTaskQueueTask {
	const { heldFrom: _heldFrom, stuckAt: _stuckAt, back: _back, card, inShort, ...c } = t;
	if (c.status !== "asking" || !c.askOps) delete c.askLead;
	const open =
		c.after && OPEN.has(c.status) ? s.tasks.filter((d) => c.after?.includes(d.id) && OPEN.has(d.status)) : [];
	if (open.length) {
		c.waitingFor = open.map((d) => d.id);
		if (!s.from)
			c.waitingForRefs = open.map((d): UiTaskQueueRef => ({
				file: "",
				name: "",
				id: d.id,
				status: d.status,
				title: d.plan.title,
				...(d.chat ? { chat: d.chat } : {}),
				...(heldBy(s, d) ? { held: true } : {}),
			}));
	}
	if (c.block) {
		const block = { ...c.block };
		if (Array.isArray(block.on)) block.on = block.on.map((r) => (r.name || s.from ? { ...r } : ownQueueRef(s, r)));
		c.block = block;
	}
	if (Array.isArray(c.outside)) c.outside = c.outside.map((r) => ({ ...r }));
	return c.status === "stuck" ? { ...c, ...(card ? { card } : {}), ...(inShort ? { inShort } : {}) } : c;
}

/** queue-blocked: a copy of an own-queue ref ("#12") with how that task stands here. */
function ownQueueRef(s: State, r: UiTaskQueueRef): UiTaskQueueRef {
	const c = { ...r };
	const d = s.tasks.find((x) => x.id === r.id);
	c.status = d ? d.status : "gone";
	if (d) c.title = d.plan.title;
	if (d?.chat) c.chat = d.chat;
	if (d?.dropped && (d.status === "dropped" || d.status === "removed")) c.dropped = d.dropped.why;
	if (d && heldBy(s, d)) c.held = true;
	return c;
}

/**
 * queue-blocked: every task in a queue as replayed (removed ones and every done one too), and in a
 * task's own chat the queue it came from. For looking up tasks other tasks wait on (queue-blocks.ts).
 */
export function taskQueueAll(entries: Iterable<TaskQueueEntryLike>): {
	tasks: TaskQueueTaskAny[];
	from?: UiTaskQueueChat;
	hold?: UiTaskQueueHold;
	running: boolean;
} {
	const list = Array.isArray(entries) ? entries : [...entries];
	const head = list[0];
	const queueId = head?.type === "session" && typeof head.id === "string" && head.id ? head.id : undefined;
	const s = replayState(list, queueId);
	return {
		tasks: s.tasks,
		...(s.from ? { from: s.from } : {}),
		...(s.hold ? { hold: s.hold } : {}),
		running: s.running,
	};
}

/** queue-paused: the pause an open task is under (its own, else its whole queue's); undefined when it isn't paused. */
export function taskQueueHeld(
	t: Pick<TaskQueueTaskAny, "status" | "hold">,
	queue: { hold?: UiTaskQueueHold },
): UiTaskQueueHold | undefined {
	if (!OPEN.has(t.status)) return undefined;
	return t.hold ?? queue.hold;
}

/** queue-paused (Ops #393): whether the resumed task is owed its "Back to task" note. */
export function taskQueueBackOwed(t: Pick<TaskQueueTaskAny, "status" | "back">): boolean {
	return t.status === "working" && t.back !== undefined;
}

const LANE_AT_WORK: ReadonlySet<Status> = new Set(["working", "asking", "stuck"]);

/** queue-answer-frees-slot (Ops #526): pi-queue's answerFrees. */
export function taskQueueAnswerFrees(t: Pick<TaskQueueTaskAny, "status" | "lane" | "touches">): boolean {
	return t.lane === true && (t.status === "asking" || t.status === "stuck") && (t.touches?.length ?? 0) > 0;
}

/** roles-lanes: how many lanes a queue may run at once (`atOnce`) and how many are in use now (`inUse`). */
export function taskQueueLaneUse(q: Pick<UiTaskQueue, "tasks" | "lanesAtOnce">): {
	atOnce: number;
	inUse: number;
} {
	const atOnce = q.lanesAtOnce ?? TASK_QUEUE_DEFAULT_LANES;
	const inUse = q.tasks.filter(
		(t) => t.lane && LANE_AT_WORK.has(t.status as Status) && !t.hold && !taskQueueAnswerFrees(t),
	).length;
	return { atOnce, inUse: Math.min(inUse, atOnce) };
}

/** queue-wait-frees-lane: pi-queue's waitFrees. */
export function taskQueueWaitFrees(t: Pick<TaskQueueTaskAny, "status" | "wait" | "hold">): boolean {
	return t.status === "waiting" && !t.wait?.overAt && !t.hold;
}

/** queue-lanes: the open tasks grouped into lanes (pi-queue's lanesOf). */
function lanesOf(all: Task[], shareable: (touch: string) => boolean): (UiTaskQueueLane & { inChat: boolean })[] {
	const open = all.filter((t) => OPEN.has(t.status) && !taskQueueWaitFrees(t));
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
	if (action === "lanes") {
		return isId(id) && id <= TASK_QUEUE_MAX_LANES ? `/queue lanes ${id}` : null;
	}
	if (action === "up" || action === "down" || action === "remove") return isId(id) ? `/queue ${action} ${id}` : null;
	if (action === "pause" || action === "resume") {
		if (id !== undefined && id !== null && !isId(id)) return null;
		const which = isId(id) ? ` ${id}` : "";
		if (action === "resume") return `/queue resume${which}`;
		return `/queue pause${which} ${Buffer.from(TASK_QUEUE_PANEL_PAUSE_WHY, "utf8").toString("base64url")}`;
	}
	return null;
}

/**
 * queue-done-hidden + queue-resilience (Q-ISO-1): one entry of a transcript, read from the start: the queue chat
 * (`from.file`) of a queued task's own chat, null when it isn't one (a message came first, or no queue chat),
 * undefined when this entry doesn't tell.
 */
export function taskChatOriginEntry(raw: unknown): string | null | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const e = raw as { type?: unknown; customType?: unknown; data?: unknown };
	if (e.type === "message") return null;
	if (e.type !== "custom" || e.customType !== TASK_QUEUE_ENTRY_TYPE) return undefined;
	const op = (e.data ?? {}) as { op?: unknown; from?: unknown };
	return op.op === "assigned" ? (chatOf(op.from)?.file ?? null) : undefined;
}

/** queue-done-hidden: one entry of a transcript, read from the start. */
export function taskChatHeadEntry(raw: unknown): boolean | undefined {
	const origin = taskChatOriginEntry(raw);
	return origin === undefined ? undefined : origin !== null;
}

/** queue-done-hidden: whether these entries (oldest first) are a queued task's own chat. */
export function isQueueTaskChatEntries(entries: Iterable<unknown>): boolean {
	for (const e of entries) {
		const verdict = taskChatHeadEntry(e);
		if (verdict !== undefined) return verdict;
	}
	return false;
}

/** queue-done-hidden: whether the transcript at `file` is a queued task's own chat. */
export async function isQueueTaskChatFile(file: string, maxBytes = 1024 * 1024): Promise<boolean> {
	return (await queueTaskChatOrigin(file, maxBytes)) !== null;
}

/** queue-resilience (Q-ISO-1): the queue chat of the queued task whose own chat is at `file`; null if it isn't one. */
export async function queueTaskChatOrigin(file: string, maxBytes = 1024 * 1024): Promise<string | null> {
	let fh: FileHandle | undefined;
	try {
		fh = await open(file, "r");
		const decoder = new StringDecoder("utf8");
		const chunk = Buffer.alloc(64 * 1024);
		let carry = "";
		const verdictOf = (line: string): string | null | undefined => {
			if (!line.includes('"type":"message"') && !line.includes(`"${TASK_QUEUE_ENTRY_TYPE}"`)) return undefined;
			try {
				return taskChatOriginEntry(JSON.parse(line));
			} catch {
				return undefined;
			}
		};
		for (let pos = 0; pos < maxBytes;) {
			const { bytesRead } = await fh.read(chunk, 0, Math.min(chunk.length, maxBytes - pos), pos);
			if (!bytesRead) return verdictOf(carry + decoder.end()) ?? null;
			pos += bytesRead;
			const lines = (carry + decoder.write(chunk.subarray(0, bytesRead))).split("\n");
			carry = lines.pop() ?? "";
			for (const line of lines) {
				const verdict = verdictOf(line);
				if (verdict !== undefined) return verdict;
			}
		}
		return null;
	} catch {
		return null;
	} finally {
		await fh?.close().catch(() => {});
	}
}
