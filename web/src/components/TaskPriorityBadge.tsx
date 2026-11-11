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

/** Canonical CSS for P0 / P1 / P2 / P3 task priority badges across Queue and Roles surfaces. */
export const TASK_PRIORITY_BADGE_CSS = `
.task-priority-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: 4px;
  border: 1px solid var(--border, rgba(148, 163, 184, 0.28));
  font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  font-weight: 700;
  line-height: 16px;
}
.task-priority-p0 {
  background: rgba(239, 68, 68, 0.16);
  color: #fca5a5;
  border-color: rgba(239, 68, 68, 0.45);
}
.theme-light .task-priority-p0,
[data-tasks-roles-v8-theme="light"] .task-priority-p0,
html[data-theme="light"] .task-priority-p0 {
  background: rgba(220, 38, 38, 0.12);
  color: #b91c1c;
  border-color: rgba(220, 38, 38, 0.35);
}
.task-priority-p1 {
  background: rgba(245, 158, 11, 0.16);
  color: #fcd34d;
  border-color: rgba(245, 158, 11, 0.45);
}
.theme-light .task-priority-p1,
[data-tasks-roles-v8-theme="light"] .task-priority-p1,
html[data-theme="light"] .task-priority-p1 {
  background: rgba(217, 119, 6, 0.12);
  color: #b45309;
  border-color: rgba(217, 119, 6, 0.35);
}
.task-priority-p2 {
  background: rgba(59, 130, 246, 0.14);
  color: #93c5fd;
  border-color: rgba(59, 130, 246, 0.38);
}
.theme-light .task-priority-p2,
[data-tasks-roles-v8-theme="light"] .task-priority-p2,
html[data-theme="light"] .task-priority-p2 {
  background: rgba(37, 99, 235, 0.1);
  color: #1d4ed8;
  border-color: rgba(37, 99, 235, 0.3);
}
.task-priority-p3 {
  background: rgba(148, 163, 184, 0.12);
  color: var(--text-dim, #94a3b8);
  border-color: rgba(148, 163, 184, 0.28);
}
.theme-light .task-priority-p3,
[data-tasks-roles-v8-theme="light"] .task-priority-p3,
html[data-theme="light"] .task-priority-p3 {
  background: rgba(100, 116, 139, 0.1);
  color: #475569;
  border-color: rgba(100, 116, 139, 0.28);
}
`;

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
