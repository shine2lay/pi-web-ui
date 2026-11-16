/**
 * roles-by-project producer (spec-data.md, spec-build.md §Modules): builds UiRolesOverview.taskBoard from the rows
 * the overview reader already gathers (active, every ready row, done, dropped). Pure: no second read of any queue.
 * Seam stub (frontend #293); Backend's build implements it and makes tests/unit/roles-by-project-board.test.ts pass.
 */
import type { UiRoleOverview, UiRoleTask, UiWorkRecords } from "./protocol.js";
import type { UiTaskBoard } from "./roles-board-protocol.js";

export const ROLES_BY_PROJECT_BOARD_NOT_BUILT = "roles-by-project: not built (Backend task)";

/** One queue row as the overview reader holds it: the task (role set) and its place in its role's queue. */
export interface TaskBoardRow {
	task: UiRoleTask;
	/** Position in its role's queue (active first), null for done and dropped. */
	queueIndex: number | null;
}

export interface TaskBoardInput {
	/** = UiRolesOverview.at (ms); the 14-day window ends here. */
	at: number;
	rows: readonly TaskBoardRow[];
	/** The work registry (absent: none read; then no project groups). */
	work?: UiWorkRecords;
	/** Every roster role, for roleGroups (Department view). */
	roster: readonly Pick<UiRoleOverview, "id" | "title">[];
	/** A queue that could not be read (UiTaskBoard.problem). */
	problem?: string;
}

export function buildTaskBoard(_input: TaskBoardInput): UiTaskBoard {
	throw new Error(ROLES_BY_PROJECT_BOARD_NOT_BUILT);
}
