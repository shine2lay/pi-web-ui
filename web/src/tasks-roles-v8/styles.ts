import { TASK_PRIORITY_BADGE_CSS } from "../components/TaskPriorityBadge";
import { TASKS_ROLES_V8_CARDS_CSS } from "./styles-cards";
import { TASKS_ROLES_V8_DAG_CSS } from "./styles-dag";
import { TASKS_ROLES_V8_SHELL_CSS } from "./styles-shell";
import { TASKS_ROLES_V8_TOKENS_CSS } from "./styles-tokens";

export const TASKS_ROLES_V8_CSS = [
	TASKS_ROLES_V8_TOKENS_CSS,
	TASKS_ROLES_V8_SHELL_CSS,
	TASKS_ROLES_V8_DAG_CSS,
	TASKS_ROLES_V8_CARDS_CSS,
	TASK_PRIORITY_BADGE_CSS,
].join("\n");

export function injectTasksRolesV8Styles(doc: Document = document): HTMLStyleElement {
	const existing = doc.getElementById("tasks-roles-v8-styles") as HTMLStyleElement | null;
	if (existing) return existing;
	const styleEl = doc.createElement("style");
	styleEl.id = "tasks-roles-v8-styles";
	styleEl.textContent = TASKS_ROLES_V8_CSS;
	doc.head.appendChild(styleEl);
	return styleEl;
}
