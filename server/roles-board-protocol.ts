/**
 * roles-by-project (frontend #293 seam; .temper/features/roles-by-project/spec-data.md): the Roles overview and its
 * task board, grouped by project. Types only, like protocol.ts, which re-exports this file (`export type *`), so
 * `web/src/types.ts` sees every name here. Every new field is optional: an older server reads as "not sent".
 */
import type {
	UiBoard,
	UiMessageApprovals,
	UiOwnerContact,
	UiRoleAsk,
	UiRoleOpenPair,
	UiRoleOverview,
	UiRoleTask,
	UiTaskGroupRollup,
	UiTouchSystemSummary,
	UiWorkRecords,
} from "./protocol.js";

/** G1: one done-when item of a work-registry record, in registry order; `met` by itemKey (trim, lower case). */
export interface UiWorkDoneWhenMark {
	item: string;
	met: boolean;
}

/** A task's place on the board; `dropped` tasks are not on it. */
export type UiBoardState = "needs-you" | "blocked" | "waiting" | "working" | "queued" | "done";

export type UiBoardGroupKind = "project" | "tag" | "none" | "role";

/** G2: one group of the board (spec-data.md §Group key, §Which groups). */
export interface UiBoardGroup {
	/** "project:<projectId>" | "tag:<tag>" | "none" | "role:<roleId>". */
	key: string;
	kind: UiBoardGroupKind;
	/** Project name from work.projects, the tag, or "No project or tag". */
	label: string;
	/** Kind "project" only; joins work.projects[].id (ring, lead, initiative, doneWhen). */
	projectId?: string;
	/** Kind "project" only, from the registry. */
	projectStatus?: "active" | "done" | "dropped";
	/** Every non-done, non-dropped task in the group, never capped. */
	open: number;
	/** Open tasks per state; sums to `open`. */
	counts: Record<Exclude<UiBoardState, "done">, number>;
	/** Tasks with finishedAt in [asOf - 14 d, asOf], over ALL done rows read. */
	done14d: number;
	/** Done rows of this group in `UiTaskBoard.tasks` (<= done14d + predecessors). */
	doneShown: number;
	/** Role ids with a task in the group, by open count desc, then id. */
	roles: string[];
	/** Newest finishedAt in the group, for "Done lately" order. */
	lastFinishedAt: number | null;
}

/** G2: one task row of the board. */
export interface UiBoardTask
	extends Pick<
		UiRoleTask,
		| "id"
		| "role"
		| "title"
		| "status"
		| "lifecycleStatus"
		| "project"
		| "initiative"
		| "tags"
		| "dependsOnRefs"
		| "howToUnblock"
		| "finishedAt"
		| "doneSummary"
		| "stuck"
	> {
	/** "<role> #<id>", the same canonical form as dependsOnRefs. */
	ref: string;
	/** UiBoardGroup.key. */
	groupKey: string;
	state: UiBoardState;
	/** Position in its role's queue (active first), null for done. */
	queueIndex: number | null;
}

/** G2: the board (spec-data.md). Named taskBoard because UiRolesOverview.board is the roles' message board. */
export interface UiTaskBoard {
	/** = UiRolesOverview.at; the 14-day window ends here. */
	asOf: number;
	/** spec-data.md §Which groups, in §Order. */
	groups: UiBoardGroup[];
	/** Kind "role": one per roster role, same counts by task.role (Department view). */
	roleGroups: UiBoardGroup[];
	/** Every open task + the done rows of §Done rows; no duplicates by ref. */
	tasks: UiBoardTask[];
	/** A queue that could not be read: groups are partial, the page says so. */
	problem?: string;
}

/** roles-overview: the Roles page's snapshot. */
export interface UiRolesOverview {
	/** When it was made (ms). */
	at: number;
	roles: UiRoleOverview[];
	/** Every open ask, oldest first (an ask whose time isn't known goes last). */
	asks: UiRoleAsk[];
	/** Role messages are paused (the owner's switch in Settings). */
	paused: boolean;
	/** The 6 am report job's time zone (its days and "6 am" are in it). */
	reportTz: string;
	/** board: the roles' shared board (absent: this server has none). */
	board?: UiBoard;
	/** roles-panel: the work registry's initiatives and projects (absent: this server reads none). */
	work?: UiWorkRecords;
	/** owner-contacts (Roles D3): the owner's own messages to role home chats, newest first (absent: none read). */
	contacts?: UiOwnerContact[];
	/** roles-sent: sender → receiver pairs with open requests or questions (absent: this server reads none). */
	openPairs?: UiRoleOpenPair[];
	/** ladder-alarm: the approval step beyond the active free-chain boundary. on false = it's off this run
	 *  (chains stop at that boundary; nobody can approve more), with the reason its start logged and since = when this
	 *  server started. Absent: not known yet (still starting) or this server has no such step. */
	approvals?: UiMessageApprovals;
	/** Multi-tag group roll-ups across all roles, sorted by priority. */
	tagGroups?: UiTaskGroupRollup[];
	/** Pre-aggregated index of appOrSystem -> tags for App/System filtering. */
	touchSystems?: UiTouchSystemSummary[];
	/** roles-by-project (G2): exact per-group counts, every open task and the sent done rows (absent: not built
	 *  this look; spec-data.md §Absent). */
	taskBoard?: UiTaskBoard;
}
