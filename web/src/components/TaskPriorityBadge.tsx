import { memo } from "react";
import {
	DEFAULT_PRIORITY,
	PRIORITIES,
	PRIORITY_RANK,
	checkPriority,
	normPriority,
	taskPriority,
	type TaskPriority,
} from "../../../server/shared/task-priority";

export { DEFAULT_PRIORITY, PRIORITIES, PRIORITY_RANK, checkPriority, normPriority, taskPriority, type TaskPriority };

/** Format a task priority badge label ("P0" | "P1" | "P2" | "P3"). */
export function formatTaskPriorityBadge(priority?: unknown): TaskPriority {
	return taskPriority({ priority });
}

/** Render HTML string for a P0-P3 priority badge in v8 task cards and Role views. */
export function renderTaskPriorityBadgeHtml(priority?: unknown): string {
	const p = formatTaskPriorityBadge(priority);
	const tierCls = `task-priority-${p.toLowerCase()}`;
	return `<span class="task-priority-badge ${tierCls}" data-priority="${p}" title="Priority ${p}">${p}</span>`;
}

/** React badge component for P0 / P1 / P2 / P3 task priority in TaskQueuePanel and Roles views. */
export const TaskPriorityBadge = memo(function TaskPriorityBadge({
	priority,
	className,
}: {
	priority?: TaskPriority | string;
	className?: string;
}) {
	const p = formatTaskPriorityBadge(priority);
	const tierCls = `task-priority-${p.toLowerCase()}`;
	const cls = ["task-queue-priority", "task-priority-badge", tierCls, className ?? ""].filter(Boolean).join(" ");
	return (
		<span className={cls} data-priority={p} title={`Priority ${p}`}>
			{p}
		</span>
	);
});

declare module "../tasks-roles-v8/types" {
	interface UiRoleTask {
		priority?: TaskPriority;
	}
}
