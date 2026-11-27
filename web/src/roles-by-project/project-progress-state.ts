/** Card-local availability guard. Counts/criterion projection remain owned by goalsOf. */
import type { UiWorkRecord } from "../types";
import { goalsOf, rankOf, type BoardContext, type TileModel } from "./model";

type Goals = ReturnType<typeof goalsOf>;
export interface Milestones {
	goals: Goals;
	notice: string | null;
	warning: boolean;
}
const unavailable = (notice: string): Milestones => ({ goals: null, notice, warning: true });
const count = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

function milestonesOf(ctx: BoardContext, tile: TileModel): Milestones {
	const { work, coherent } = ctx.progress;
	if (!coherent)
		return unavailable("Milestones unavailable: the last-known board and this registry weren't received together.");
	if (!work) return unavailable("Milestones unknown: the project registry was not supplied by this server.");
	if (work.problem === "unreadable") return unavailable("Milestones couldn't be read just now (not zero: unknown).");
	if (!Array.isArray(work.projects)) return unavailable("Milestones unavailable: inconsistent project registry.");
	const project = ctx.projects.get(tile.group.projectId ?? "");
	if (!project) return unavailable("Milestones unavailable: this project wasn't found in the supplied registry.");
	const partial = !!work.problem;
	const prefix = partial ? `Milestone registry incomplete (${work.problem}). ` : "";
	const invalid = () => unavailable(`${prefix}Milestones unavailable: inconsistent criterion data.`);
	if (!count(project.items) || !count(project.met) || project.met > project.items) return invalid();
	if (
		project.doneWhen !== undefined &&
		(!Array.isArray(project.doneWhen) ||
			project.doneWhen.some(
				(it) => !it || typeof it.item !== "string" || !it.item.trim() || typeof it.met !== "boolean",
			))
	)
		return invalid();
	// Validation precedes the sole display projection. Compare its result, never reimplement its count formula.
	const goals = goalsOf(project as UiWorkRecord)!;
	if (project.doneWhen !== undefined && (project.doneWhen.length !== project.items || goals.met !== project.met))
		return invalid();
	if (!goals.total)
		return {
			goals: null,
			warning: partial,
			notice: partial
				? `${prefix}Milestones unknown; a partial registry cannot prove an empty plan.`
				: "No milestones recorded for this project.",
		};
	return {
		goals,
		warning: partial,
		notice: `${prefix}${project.doneWhen === undefined ? "Milestone names weren't sent by this server." : ""}` || null,
	};
}

export function projectProgressOf(ctx: BoardContext, tile: TileModel, filtered: boolean) {
	const milestones = milestonesOf(ctx, tile);
	const now = tile.shown
		.filter((t) => t.state !== "done" && t.state !== "queued")
		.sort((a, b) => rankOf(a) - rankOf(b));
	// Source-board order is stable; queueIndex only has meaning within one role.
	const queued = tile.shown.filter((t) => t.state === "queued");
	const incomplete = !!ctx.board.problem;
	const lastKnown = ctx.progress.lastKnown || !ctx.progress.coherent;
	const record = ctx.projects.get(tile.group.projectId ?? "");
	const lifecycle = tile.group.projectStatus;
	return {
		milestones,
		now,
		queued,
		lastKnown,
		lifecycle,
		mismatch: !!lifecycle && !!record?.status && lifecycle !== record.status,
		nowEmpty: filtered
			? "No matching current work"
			: incomplete || lastKnown
				? "Current work unknown: queues are incomplete or last-known."
				: "Nothing running right now.",
		queuedEmpty: filtered
			? "No matching queued work"
			: incomplete || lastKnown
				? "Queued work unknown: queues are incomplete or last-known."
				: "Next: not recorded · nothing queued.",
		queueWarning: incomplete ? "Queues incomplete: observed work cannot prove nothing is running or queued." : null,
	};
}
