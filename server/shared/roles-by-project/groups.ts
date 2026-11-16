/**
 * roles-by-project (spec-data.md §Group key, §Board state; spec-graph.md §Done predecessors): the one group key,
 * board state and done-predecessor walk. Shared by the server producer and the page: imports only types.
 */
import type { UiBoardState, UiBoardTask } from "../../roles-board-protocol.js";
import type { UiRoleTask } from "../../protocol.js";

/** The seam's not-built signal (frontend #293): its B11 case raises it when a record comes without `doneWhen`, as
 *  an older server sends it. */
export const ROLES_BY_PROJECT_GROUPS_NOT_BUILT = "roles-by-project: not built (Backend task)";

/** Group key of a task: "project:<id>" | "tag:<tag>" | "none" (rules 1-4). `projectIds` = every work.projects id.
 *  Tags are already canonical (normTags folds aliases at read), so a task lands in exactly one group. */
export function groupKeyOf(task: Pick<UiRoleTask, "project" | "tags">, projectIds: ReadonlySet<string>): string {
	if (task.project && projectIds.has(task.project)) return `project:${task.project}`;
	const tags = task.tags ?? [];
	const projectTag = tags.find((t) => projectIds.has(t));
	if (projectTag) return `project:${projectTag}`;
	return tags.length ? `tag:${tags[0]}` : "none";
}

/** Board state of a task; null for a dropped task (not on the board, not counted). */
export function boardStateOf(task: Pick<UiRoleTask, "status" | "paused">): UiBoardState | null {
	if (task.status === "dropped") return null;
	if (task.status === "done") return "done";
	if (task.paused) return "waiting";
	switch (task.status) {
		case "stuck":
			return "needs-you";
		case "blocked":
			return "blocked";
		case "asking":
		case "waiting":
			return "waiting";
		case "working":
			return "working";
		case "ready":
			return "queued";
	}
}

/** Refs of done rows reachable backwards from an open task in at most `maxSteps` steps (step 1 = a direct
 *  predecessor). Breadth-first from every open task at once; a ref met twice is visited once (cycles end);
 *  a ref not among `tasks` is skipped. */
export function donePredecessors(
	tasks: readonly Pick<UiBoardTask, "ref" | "state" | "dependsOnRefs">[],
	maxSteps: 4,
): Set<string> {
	const byRef = new Map(tasks.map((t) => [t.ref, t]));
	const done = new Set<string>();
	let frontier = tasks.filter((t) => t.state !== "done");
	const seen = new Set(frontier.map((t) => t.ref));
	for (let step = 1; step <= maxSteps && frontier.length; step++) {
		const next: typeof frontier = [];
		for (const t of frontier) {
			for (const ref of t.dependsOnRefs ?? []) {
				const dep = byRef.get(ref);
				if (!dep || seen.has(ref)) continue;
				seen.add(ref);
				if (dep.state === "done") done.add(ref);
				next.push(dep);
			}
		}
		frontier = next;
	}
	return done;
}
