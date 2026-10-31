/**
 * roles-row: the pieces one role's row on the Roles page is made from: its TL;DR lines, its status, its work mode
 * and goals, and its model's name. Each one only shapes what the overview's reader already read. Split out of
 * roles-overview.ts (Backend #15), which still exports these names.
 */

import { goalEnded, type RoleGoal, type WorkMode } from "./identity-config.js";
import type {
	UiRoleChatRef,
	UiRoleGoal,
	UiRoleOverview,
	UiRoleStatus,
	UiRoleTldrLine,
	UiTldrLine,
} from "./protocol.js";
import { rulesGoals, rulesWorkMode } from "./role-rules.js";

/** roles-model: the most the page gets of a model's name. */
export const ROLE_MODEL_MAX = 120;

/** roles-model: a model name fit for the page (trimmed, short, no control characters), else undefined. */
export function roleModelLabel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text && text.length <= ROLE_MODEL_MAX && !/[\u0000-\u001f\u007f]/.test(text) ? text : undefined;
}

// ---------------------------------------------------------------------------
// Work mode and goals: the owner's fields, else the every-chat rules (read-only)
// ---------------------------------------------------------------------------

/** How a role works and its running goals: the owner's fields where set, else the rules' default. */
export function roleWorkMode(
	id: string,
	config: { workMode: WorkMode | null; goals: RoleGoal[] | null },
	now: number,
): Pick<UiRoleOverview, "workMode" | "workModeFrom" | "goals" | "goalsFrom" | "conflict"> {
	const rules: WorkMode = rulesWorkMode(id);
	const workMode = config.workMode ?? rules;
	const all = config.goals ?? rulesGoals(id);
	const goals: UiRoleGoal[] = all.filter((g) => !goalEnded(g, now)).map((g) => ({ ...g }));
	let conflict: string | undefined;
	if (config.workMode && config.workMode !== rules) {
		conflict =
			rules === "request-only"
				? "Set to start its own work, but the every-chat rules say it works on request. The page shows your setting; the rules still decide."
				: "Set to work on request, but the every-chat rules let it start its own work. The page shows your setting; the rules still decide.";
	}
	return {
		workMode,
		workModeFrom: config.workMode ? "owner" : "rules",
		goals,
		goalsFrom: config.goals ? "owner" : "rules",
		...(conflict ? { conflict } : {}),
	};
}

// ---------------------------------------------------------------------------
// TL;DR lines and status
// ---------------------------------------------------------------------------

/** quiet (queue-paused): the line is from a task the owner paused: it doesn't say it needs him. */
export function lineOf(l: UiTldrLine, chat: UiRoleChatRef, quiet = false): UiRoleTldrLine {
	return {
		id: l.id,
		text: l.text,
		ts: l.ts,
		...(l.needsYou && !l.answered && !quiet ? { needsYou: true } : {}),
		...(l.needsYou && l.answered ? { answered: true } : {}),
		...(l.kind ? { kind: l.kind } : {}),
		chat,
	};
}

export function newestWaiting(lines: UiTldrLine[]): UiTldrLine | undefined {
	let best: UiTldrLine | undefined;
	for (const l of lines) if (l.needsYou && !l.answered && (!best || l.ts >= best.ts)) best = l;
	return best;
}

/** The first state that applies: needs you, busy, paused, idle, nothing yet. */
export function statusOf(s: { asks: number; busy: boolean; paused: boolean; something: boolean }): UiRoleStatus {
	if (s.asks > 0) return "needs-you";
	if (s.busy) return "busy";
	if (s.paused) return "paused";
	return s.something ? "idle" : "nothing-yet";
}
