/* External shared-case completion only: never imported by production. */
import good from "../../.temper/features/roles-project-progress/good.cases.json";
import bad from "../../.temper/features/roles-project-progress/bad.cases.json";
import { boardOf, boardTask, overviewOf, WORK } from "./roles-by-project-page-data";
import type { UiBoardTask, UiRolesOverview, UiWorkRecord } from "../../web/src/types";

export { good, bad };
export const PROJECT = "roles-by-project";
export const GROUP = `project:${PROJECT}`;
export type Scenario = Record<string, any>;
export const expanded = good.cases.flatMap(
	(c) =>
		(c.input as Scenario).variants?.map((variant: unknown, n: number) => ({ ...c, variant, key: `${c.id}[${n}]` })) ?? [
			{ ...c, variant: undefined, key: c.id },
		],
) as ((typeof good.cases)[number] & { variant: unknown; key: string })[];

export function frame(input: Scenario, variant?: unknown): UiRolesOverview {
	const tasks: UiBoardTask[] = (
		input.tasks ?? (input.howToUnblock ? [{ ref: "qa #1", state: "blocked", howToUnblock: input.howToUnblock }] : [])
	).map((t: Scenario, n: number) =>
		boardTask(t.ref ?? `frontend #${n + 1}`, GROUP, t.state ?? "working", t.title ?? "Recorded work", t),
	);
	const board = boardOf(tasks);
	board.asOf = Date.now();
	const group = board.groups.find((g) => g.key === GROUP)!;
	Object.assign(group, input.group ?? {});
	if (input.group && !Object.hasOwn(input.group, "projectStatus")) delete group.projectStatus;
	if (input.taskBoard) Object.assign(board, input.taskBoard);
	const overview = overviewOf(board, Date.now());
	const project: UiWorkRecord = {
		...WORK.projects[0],
		items: 0,
		met: 0,
		doneWhen: [],
		...(input.project ?? {}),
		...(typeof variant === "object" ? variant : {}),
	};
	if (input.project && !Object.hasOwn(input.project, "doneWhen")) delete project.doneWhen;
	if (input.project && !Object.hasOwn(input.project, "status")) project.status = group.projectStatus ?? "active";
	overview.work = { projects: [project], initiatives: [] };
	if (input.work) overview.work = input.work;
	if (typeof variant === "string") overview.work!.problem = variant as "too-big" | "unknown-change";
	if (input.overview) delete overview.work;
	if (input.previousWorkProblem) overview.work!.problem = input.previousWorkProblem;
	return overview;
}
