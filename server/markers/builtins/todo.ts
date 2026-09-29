/**
 * builtins/todo.ts — 内置任务标记（复刻 pi-marker-tools）。
 */

import type { ApplyResult, MarkerTool, MarkerOverlay, ParsedToken, MarkerContext } from "../marker.js";
import { type ServerLang } from "../../i18n.js";

export const TODO_NAMESPACE = "todo";

export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface Todo {
	id: number;
	subject: string;
	status: TodoStatus;
	activeForm?: string;
	blockedBy: number[];
	createdAt: number;
}

export interface TodoState {
	tasks: Todo[];
	nextId: number;
}

export function initTodoState(): TodoState {
	return { tasks: [], nextId: 1 };
}

function findTask(state: TodoState, id: number): Todo | undefined {
	return state.tasks.find((t) => t.id === id && t.status !== "deleted");
}

function parseId(raw: string | undefined): number | null {
	if (raw === undefined) return null;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
}

function formatStatus(s: TodoStatus): string {
	switch (s) {
		case "pending":
			return "pending";
		case "in_progress":
			return "in_progress";
		case "completed":
			return "completed";
		default:
			return s;
	}
}

export function describeTodos(state: TodoState, includeDeleted = false, _lang: ServerLang = "en"): string {
	const visible = state.tasks.filter((t) => includeDeleted || t.status !== "deleted");
	if (visible.length === 0) return "[todo] (empty)";
	return visible
		.map((t) => {
			const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
			const deps = t.blockedBy.length ? ` ⛓ ${t.blockedBy.join(",")}` : "";
			return `[${formatStatus(t.status)}] #${t.id} ${t.subject}${form}${deps}`;
		})
		.join("\n");
}

const TODO_GUIDANCE_EN: string[] = [
	"# Inline marker tools (express state changes inline in your reply text — never call a tool for them)",
	"- Marker syntax: [[todo:new:<subject>]] to create; [[todo:set:<id>,completed|in_progress|pending]] for status; [[todo:remove:<id>]] to delete; [[todo:dep:<id>,blocks=<dep ids, comma-separated>]] to set dependencies.",
	"- Express all status changes with the [[todo:...]] inline markers above; they never interrupt your reply and need no waiting for a result.",
	"- Only use the `todo_list` tool (the read path goes through the tool) when you want to list the current tasks.",
	"- Never invent task ids; ids are assigned by [[todo:new:...]], starting from incrementing integers.",
];

/** 语言感知的 todo guidance（issue #91）：en 用英译、zh 用中文，默认英文。 */
export function getTodoGuidance(_lang: ServerLang = "en"): string[] {
	return TODO_GUIDANCE_EN;
}

export const todoMarker: MarkerTool<TodoState> = {
	name: "todo",
	guidance: TODO_GUIDANCE_EN,
	getGuidance: getTodoGuidance,

	async apply(
		token: ParsedToken,
		_ctx: MarkerContext,
		_state: TodoState,
		_lang: ServerLang = "en",
	): Promise<ApplyResult> {
		const state = _state;
		const op = token.op;
		switch (op) {
			case "new": {
				const subject = token.args[0]?.trim();
				if (!subject)
					return {
						applied: false,
						error: "todo:new requires a subject argument [[todo:new:<subject>]]",
					};
				const id = state.nextId++;
				state.tasks.push({ id, subject, status: "pending", blockedBy: [], createdAt: Date.now() });
				return {
					applied: true,
					feedback: `Created #${id}: ${subject} (pending)`,
				};
			}
			case "set": {
				const id = parseId(token.args[0]);
				if (id === null) {
					const rawId = token.args[0] ?? "";
					return {
						applied: false,
						error: `todo:set has an invalid id: "${rawId}"`,
					};
				}
				const status = token.args[1]?.trim() as TodoStatus | undefined;
				if (!status || !(status === "pending" || status === "in_progress" || status === "completed")) {
					const statusText = status ?? "";
					return {
						applied: false,
						error: `todo:set has an invalid status: "${statusText}", expected pending|in_progress|completed`,
					};
				}
				const task = findTask(state, id);
				if (!task)
					return {
						applied: false,
						error: `todo:set task #${id} does not exist`,
					};
				const activeForm = token.kwargs["activeForm"];
				const from = task.status;
				if (status === "pending" && from === "completed") {
					return {
						applied: false,
						error: `Task #${id} is completed and cannot be set back to pending`,
					};
				}
				if (status === "in_progress" && from === "completed") {
					return {
						applied: false,
						error: `Task #${id} is completed and cannot be set back to in_progress`,
					};
				}
				task.status = status;
				if (status === "in_progress" && activeForm) task.activeForm = activeForm;
				const change = from !== status ? ` (${from} → ${status})` : "";
				return {
					applied: true,
					feedback: `Updated #${id}${change}`,
				};
			}
			case "remove": {
				const id = parseId(token.args[0]);
				if (id === null) {
					const rawId = token.args[0] ?? "";
					return {
						applied: false,
						error: `todo:remove has an invalid id: "${rawId}"`,
					};
				}
				const task = findTask(state, id);
				if (!task)
					return {
						applied: false,
						error: `todo:remove task #${id} does not exist`,
					};
				task.status = "deleted";
				return {
					applied: true,
					feedback: `Deleted #${id}: ${task.subject}`,
				};
			}
			case "dep": {
				const id = parseId(token.args[0]);
				if (id === null) {
					const rawId = token.args[0] ?? "";
					return {
						applied: false,
						error: `todo:dep has an invalid id: "${rawId}"`,
					};
				}
				const task = findTask(state, id);
				if (!task)
					return {
						applied: false,
						error: `todo:dep task #${id} does not exist`,
					};
				const depRaw = token.kwargs["blocks"] ?? token.args[1] ?? "";
				const deps = depRaw
					.split(",")
					.map((x) => parseId(x.trim()))
					.filter((x): x is number => x !== null);
				const bad = deps.filter((d) => d === id || !findTask(state, d));
				if (bad.length) {
					const badList = bad.join(",");
					return {
						applied: false,
						error: `todo:dep detected invalid dependencies ${badList} (missing or self-referencing)`,
					};
				}
				task.blockedBy = deps;
				const depsText = deps.length ? deps.join(",") : "(none)";
				return {
					applied: true,
					feedback: `#${id} blocks: ${depsText}`,
				};
			}
			default:
				return {
					applied: false,
					error: `todo unknown operation: ${op}`,
				};
		}
	},

	overlay(state: TodoState): MarkerOverlay | undefined {
		if (!state || state.tasks.length === 0) return undefined;
		const visible = state.tasks.filter((t) => t.status !== "deleted");
		if (visible.length === 0) return undefined;
		const done = visible.filter((t) => t.status === "completed").length;
		const lines = visible.map((t) => {
			const mark = t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○";
			const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
			return ` ${mark} #${t.id} ${t.subject}${form}`;
		});
		return { tool: "todo", lines: [`${done}/${visible.length} done`, ...lines] };
	},

	init: initTodoState,
};
