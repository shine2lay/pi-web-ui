/**
 * roles-overview: the every-chat rules' word on how each role works (AGENTS.md rule 14, owner 2026-10-04).
 *
 * Read-only defaults for a role whose identity.json doesn't set the owner's fields (workMode, goals):
 * product, design and qa start their own work, every other role (and any role added later) works on
 * request, and Architecture keeps the two goals the owner approved before the goals field existed.
 * Nothing reads these to start, stop or schedule work: the Roles page and Settings only show them, and an
 * owner's setting that disagrees is shown as a conflict, never acted on.
 */

import type { RoleGoal, WorkMode } from "./identity-config.js";

/** The roles the rules let start their own work. */
export const RULES_SELF_START: ReadonlySet<string> = new Set(["product", "design", "qa"]);

/** The goals the owner approved before the goals field existed (2026-10-04, rule 14's exception). */
export const RULES_GOALS: Readonly<Record<string, readonly RoleGoal[]>> = {
	architecture: [
		{
			name: "Team in Temper",
			scope: "Pi-in-Temper build plan M1-M8, through the first real trial",
			approvedAt: "2026-10-04T22:20",
		},
		{
			name: "Land check workflow (#23)",
			scope: "arch_land_check in waves of at most 3, each after a limits check",
			approvedAt: "2026-10-04T22:50",
		},
	],
};

/** How the rules say a role works. */
export function rulesWorkMode(id: string): WorkMode {
	return RULES_SELF_START.has(id) ? "self-start" : "request-only";
}

/** The goals the rules give a role (copies). */
export function rulesGoals(id: string): RoleGoal[] {
	return (Object.hasOwn(RULES_GOALS, id) ? RULES_GOALS[id] : []).map((g) => ({ ...g }));
}
