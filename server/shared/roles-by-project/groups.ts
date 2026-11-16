/**
 * roles-by-project (spec-data.md §Group key, §Board state; spec-graph.md §Done predecessors): the one group key,
 * board state and done-predecessor walk. Shared by the server producer and the page: imports only types.
 * Seam stub (frontend #293); Backend's build implements it and makes tests/unit/roles-by-project-board.test.ts pass.
 */
import type { UiBoardState, UiBoardTask } from "../../roles-board-protocol.js";
import type { UiRoleTask } from "../../protocol.js";

export const ROLES_BY_PROJECT_GROUPS_NOT_BUILT = "roles-by-project: not built (Backend task)";

/** Group key of a task: "project:<id>" | "tag:<tag>" | "none" (rules 1-4). `projectIds` = every work.projects id. */
export function groupKeyOf(_task: Pick<UiRoleTask, "project" | "tags">, _projectIds: ReadonlySet<string>): string {
	throw new Error(ROLES_BY_PROJECT_GROUPS_NOT_BUILT);
}

/** Board state of a task; null for a dropped task (not on the board, not counted). */
export function boardStateOf(_task: Pick<UiRoleTask, "status" | "paused">): UiBoardState | null {
	throw new Error(ROLES_BY_PROJECT_GROUPS_NOT_BUILT);
}

/** Refs of done rows reachable backwards from an open task in at most `maxSteps` steps (cycles end). */
export function donePredecessors(
	_tasks: readonly Pick<UiBoardTask, "ref" | "state" | "dependsOnRefs">[],
	_maxSteps: 4,
): Set<string> {
	throw new Error(ROLES_BY_PROJECT_GROUPS_NOT_BUILT);
}
