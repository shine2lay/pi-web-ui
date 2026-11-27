/**
 * roles-by-project producer (spec-data.md, spec-build.md §Modules): builds UiRolesOverview.taskBoard from the rows
 * the overview reader already gathers (active, every ready row, done, dropped). Pure: no second read of any queue.
 */
import type { UiRoleOverview, UiRoleTask, UiWorkRecords } from "./protocol.js";
import type { UiBoardGroup, UiBoardState, UiBoardTask, UiTaskBoard } from "./roles-board-protocol.js";
import { boardStateOf, donePredecessors, groupKeyOf } from "./shared/roles-by-project/groups.js";

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

type OpenState = Exclude<UiBoardState, "done">;

const WINDOW_MS = 14 * 86_400_000;
const DONE_ROWS_PER_GROUP = 6;
const PREDECESSOR_STEPS = 4;
const NONE_LABEL = "No project or tag";
const PICKED = [
	"id",
	"role",
	"title",
	"status",
	"lifecycleStatus",
	"project",
	"initiative",
	"tags",
	"dependsOnRefs",
	"howToUnblock",
	"finishedAt",
	"doneSummary",
	"stuck",
	"phaseId",
] as const satisfies readonly (keyof UiBoardTask)[];

const refOf = (t: UiRoleTask) => `${t.role ?? ""} #${t.id}`;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function boardTaskOf(row: TaskBoardRow, groupKey: string, state: UiBoardState): UiBoardTask {
	const out: Record<string, unknown> = {};
	for (const k of PICKED) if (row.task[k] !== undefined) out[k] = row.task[k];
	return {
		...(out as Pick<UiBoardTask, (typeof PICKED)[number]>),
		ref: refOf(row.task),
		groupKey,
		state,
		queueIndex: state === "done" ? null : row.queueIndex,
	};
}

function emptyGroup(key: string, kind: UiBoardGroup["kind"], label: string): UiBoardGroup {
	const counts = { "needs-you": 0, blocked: 0, waiting: 0, working: 0, queued: 0 };
	return { key, kind, label, open: 0, counts, done14d: 0, doneShown: 0, roles: [], lastFinishedAt: null };
}

/** Tallies one group over every row read (`all`) and the rows sent (`sent`). */
function tally(
	group: UiBoardGroup,
	all: readonly UiBoardTask[],
	sent: readonly UiBoardTask[],
	from: number,
	to: number,
) {
	const roleOpen = new Map<string, number>();
	for (const t of all) {
		const role = t.role ?? "";
		roleOpen.set(role, roleOpen.get(role) ?? 0);
		if (t.state === "done") {
			if (t.finishedAt === undefined) continue;
			if (t.finishedAt >= from && t.finishedAt <= to) group.done14d += 1;
			group.lastFinishedAt = Math.max(group.lastFinishedAt ?? t.finishedAt, t.finishedAt);
			continue;
		}
		group.open += 1;
		group.counts[t.state as OpenState] += 1;
		roleOpen.set(role, (roleOpen.get(role) ?? 0) + 1);
	}
	group.doneShown = sent.filter((t) => t.state === "done").length;
	if (group.kind !== "role")
		group.roles = [...roleOpen].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([role]) => role);
}

/** Order tier: needs-you > held (blocked/waiting) > active (working/queued) > done-only. */
function tierOf(g: UiBoardGroup): number {
	if (g.counts["needs-you"]) return 0;
	if (g.counts.blocked || g.counts.waiting) return 1;
	return g.open ? 2 : 3;
}

function compareGroups(a: UiBoardGroup, b: UiBoardGroup): number {
	return (
		tierOf(a) - tierOf(b) ||
		Number(a.kind === "none") - Number(b.kind === "none") ||
		b.open - a.open ||
		a.label.localeCompare(b.label, "en") ||
		cmp(a.key, b.key)
	);
}

/** Newest first, ties: higher id, then ref. */
const newestDone = (a: UiBoardTask, b: UiBoardTask) =>
	(b.finishedAt ?? 0) - (a.finishedAt ?? 0) || b.id - a.id || cmp(a.ref, b.ref);

export function buildTaskBoard(input: TaskBoardInput): UiTaskBoard {
	const { at, work, roster, problem } = input;
	const from = at - WINDOW_MS;
	const projects = work?.projects ?? [];
	const projectIds = new Set(projects.map((p) => p.id));
	// Every row read once by ref (first wins), dropped ones off the board.
	const read = new Map<string, UiBoardTask>();
	for (const row of input.rows) {
		const state = boardStateOf(row.task);
		const ref = refOf(row.task);
		if (state === null || read.has(ref)) continue;
		read.set(ref, boardTaskOf(row, groupKeyOf(row.task, projectIds), state));
	}
	const all = [...read.values()];
	const byGroup = new Map<string, UiBoardTask[]>();
	for (const t of all) {
		const rows = byGroup.get(t.groupKey);
		if (rows) rows.push(t);
		else byGroup.set(t.groupKey, [t]);
	}

	// Sent: every open row, each group's newest done rows in the window, every done predecessor within 4 steps.
	const sentRefs = new Set(all.filter((t) => t.state !== "done").map((t) => t.ref));
	for (const rows of byGroup.values()) {
		const recent = rows.filter(
			(t) => t.state === "done" && t.finishedAt !== undefined && t.finishedAt >= from && t.finishedAt <= at,
		);
		for (const t of recent.sort(newestDone).slice(0, DONE_ROWS_PER_GROUP)) sentRefs.add(t.ref);
	}
	for (const ref of donePredecessors(all, PREDECESSOR_STEPS)) sentRefs.add(ref);
	const sent = all.filter((t) => sentRefs.has(t.ref));

	const groups = new Map<string, UiBoardGroup>();
	for (const p of projects) {
		groups.set(`project:${p.id}`, {
			...emptyGroup(`project:${p.id}`, "project", p.name),
			projectId: p.id,
			projectStatus: p.status,
		});
	}
	for (const t of sent) {
		if (groups.has(t.groupKey)) continue;
		const kind = t.groupKey === "none" ? "none" : "tag";
		groups.set(t.groupKey, emptyGroup(t.groupKey, kind, kind === "none" ? NONE_LABEL : t.groupKey.slice(4)));
	}
	for (const g of groups.values()) {
		tally(
			g,
			byGroup.get(g.key) ?? [],
			sent.filter((t) => t.groupKey === g.key),
			from,
			at,
		);
	}
	const ordered = [...groups.values()].sort(compareGroups);

	const roleGroups = roster.map((r) => {
		const g = emptyGroup(`role:${r.id}`, "role", r.title);
		tally(
			g,
			all.filter((t) => t.role === r.id),
			sent.filter((t) => t.role === r.id),
			from,
			at,
		);
		return { ...g, roles: [r.id] };
	});

	const groupIndex = new Map(ordered.map((g, i) => [g.key, i]));
	const tasks = sent.sort(
		(a, b) =>
			(groupIndex.get(a.groupKey) ?? 0) - (groupIndex.get(b.groupKey) ?? 0) ||
			Number(a.state === "done") - Number(b.state === "done") ||
			(a.queueIndex ?? Number.MAX_SAFE_INTEGER) - (b.queueIndex ?? Number.MAX_SAFE_INTEGER) ||
			(b.finishedAt ?? 0) - (a.finishedAt ?? 0) ||
			cmp(a.ref, b.ref),
	);
	return { asOf: at, groups: ordered, roleGroups, tasks, ...(problem ? { problem } : {}) };
}

/** The overview reader's rows for the board: per role, open non-ready rows first, then ready ones, in queue order
 *  (queueIndex); done and dropped rows get null. `tasks` = every row the reader gathered, in each queue's order. */
export function taskBoardRowsOf(tasks: readonly UiRoleTask[]): TaskBoardRow[] {
	const next = new Map<string, number>();
	const index = new Map<UiRoleTask, number>();
	const open = tasks.filter((t) => t.status !== "done" && t.status !== "dropped");
	for (const t of [...open.filter((x) => x.status !== "ready"), ...open.filter((x) => x.status === "ready")]) {
		const i = next.get(t.role ?? "") ?? 0;
		index.set(t, i);
		next.set(t.role ?? "", i + 1);
	}
	return tasks.map((task) => ({ task, queueIndex: index.get(task) ?? null }));
}

/** The live overview's board: rows from what the reader gathered, roster and unread queues from its roles. */
export function taskBoardOf(
	at: number,
	roles: readonly UiRoleOverview[],
	tasks: readonly UiRoleTask[],
	work?: UiWorkRecords,
) {
	const unread = roles.filter((r) => r.problems?.includes("home chat")).map((r) => r.id);
	const problem = unread.length ? `Queues that could not be read: ${unread.join(", ")}` : undefined;
	return buildTaskBoard({ at, rows: taskBoardRowsOf(tasks), work, roster: roles, ...(problem ? { problem } : {}) });
}
