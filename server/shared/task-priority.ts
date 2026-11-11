/**
 * Canonical P0-P3 task priority model mirrored for pi-web-ui server and shared helpers.
 * Matches pi-queue queue-priority.ts and docs/task-priority-contract.md.
 */

export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

export type TaskPriority = (typeof PRIORITIES)[number];

export const DEFAULT_PRIORITY: TaskPriority = "P2";

export const PRIORITY_RANK: Readonly<Record<TaskPriority, number>> = {
	P0: 0,
	P1: 1,
	P2: 2,
	P3: 3,
};

const PRIORITY_SET: ReadonlySet<string> = new Set<string>(PRIORITIES);

export type PriorityCheckResult = { ok: true; value?: TaskPriority } | { ok: false; error: string };

/** Validate raw priority input. Undefined returns { ok: true, value: undefined }. */
export function checkPriority(raw: unknown): PriorityCheckResult {
	if (raw === undefined) return { ok: true, value: undefined };
	if (typeof raw === "string" && PRIORITY_SET.has(raw)) {
		return { ok: true, value: raw as TaskPriority };
	}
	return {
		ok: false,
		error: 'priority must be one of "P0", "P1", "P2", or "P3" (exact uppercase).',
	};
}

/** Return normalized TaskPriority when valid, or undefined. */
export function normPriority(raw: unknown): TaskPriority | undefined {
	const res = checkPriority(raw);
	return res.ok ? res.value : undefined;
}

/** Return effective priority for a task (defaults to "P2"). */
export function taskPriority(task: { priority?: unknown } | null | undefined): TaskPriority {
	if (task && typeof task.priority === "string" && PRIORITY_SET.has(task.priority)) {
		return task.priority as TaskPriority;
	}
	return DEFAULT_PRIORITY;
}

/**
 * Insert a task into `tasks` in priority-tier order among `status === "ready"` tasks:
 * after all existing ready tasks with PRIORITY_RANK <= newTask's rank, and before the
 * first ready task with strictly lower priority (PRIORITY_RANK > newTask's rank).
 * Non-ready tasks are never reordered relative to each other.
 */
export function insertByPriority<T extends { status: string; priority?: TaskPriority }>(tasks: T[], task: T): void {
	if (task.status !== "ready") {
		tasks.push(task);
		return;
	}
	const rank = PRIORITY_RANK[taskPriority(task)];
	const idx = tasks.findIndex(
		(existing) => existing.status === "ready" && PRIORITY_RANK[taskPriority(existing)] > rank,
	);
	if (idx === -1) {
		tasks.push(task);
	} else {
		tasks.splice(idx, 0, task);
	}
}

/**
 * Reposition an existing ready task in `tasks` when its priority changes so it moves to the
 * tail of its new priority tier among `status === "ready"` tasks.
 */
export function repositionReadyTaskByPriority<T extends { id: number; status: string; priority?: TaskPriority }>(
	tasks: T[],
	task: T,
): void {
	if (task.status !== "ready") return;
	const currentIdx = tasks.findIndex((x) => x.id === task.id);
	if (currentIdx === -1) return;
	tasks.splice(currentIdx, 1);
	insertByPriority(tasks, task);
}

declare module "../protocol.js" {
	interface UiTaskQueueTask {
		priority?: TaskPriority;
	}
	interface UiRoleTask {
		priority?: TaskPriority;
	}
	interface UiWorkPageTask {
		priority?: TaskPriority;
	}
}
