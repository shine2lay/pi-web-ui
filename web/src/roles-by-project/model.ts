/**
 * roles-by-project page model (spec-page.md, design-elements.md): pure reads of the server's task board for the
 * four groupings, search, the fleet bar and the lede. No React, no DOM; the server's groups and states are the
 * truth (Backend's groups.ts), this file only filters and arranges them.
 */
import { heldOnOf } from "../../../server/shared/roles-by-project/graph";
import type {
	UiBoardGroup,
	UiBoardState,
	UiBoardTask,
	UiRolesOverview,
	UiTaskBoard,
	UiWorkRecord,
	UiWorkRecords,
} from "../types";

export type GroupBy = "project" | "now" | "department" | "status";
export const GROUP_BYS: readonly GroupBy[] = ["project", "now", "department", "status"];
export type OpenState = Exclude<UiBoardState, "done">;
/** Short state keys used for classes (colour) and icons; every state also shows its word. */
export type StateKey = "you" | "blk" | "wt" | "wk" | "q" | "ok";

export const STATE_KEY: Record<UiBoardState, StateKey> = {
	"needs-you": "you",
	blocked: "blk",
	waiting: "wt",
	working: "wk",
	queued: "q",
	done: "ok",
};
export const STATE_WORD: Record<UiBoardState, string> = {
	"needs-you": "Needs you",
	blocked: "Blocked",
	waiting: "Waiting",
	working: "Working",
	queued: "Queued",
	done: "Done",
};
export const OPEN_STATES: readonly OpenState[] = ["needs-you", "blocked", "waiting", "working", "queued"];
const RANK: Record<UiBoardState, number> = { "needs-you": 0, blocked: 1, waiting: 2, working: 3, queued: 4, done: 5 };
export const rankOf = (t: Pick<UiBoardTask, "state">) => RANK[t.state];
export const isOpen = (t: Pick<UiBoardTask, "state">) => t.state !== "done";

const ROLE_NAMES: Record<string, string> = {
	architecture: "Architecture",
	backend: "Backend",
	coo: "COO",
	data: "Data",
	design: "Design",
	docs: "Docs",
	frontend: "Frontend",
	marketing: "Marketing",
	ops: "Ops",
	product: "Product",
	qa: "QA",
	rollcall: "RollCall",
	security: "Security",
	systems: "Systems",
	temper: "Temper",
};
/** A role's short name as the design writes it ("QA", "Ops"); unknown ids capitalised. */
export const roleName = (id: string | undefined | null) =>
	!id ? "" : (ROLE_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1));
/** "<Role> #<id>" for display. */
export const refLabel = (t: Pick<UiBoardTask, "role" | "id">) => `${roleName(t.role)} #${t.id}`;
/** Pretty refs inside free text ("ops #957" -> "Ops #957"). */
export const prettyRefs = (text: string) =>
	text.replace(/\b([a-z][a-z0-9-]*) #(\d+)/g, (m, r: string, n: string) =>
		ROLE_NAMES[r] ? `${ROLE_NAMES[r]} #${n}` : m,
	);
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type Counts = Record<OpenState, number>;
export function countsOf(rows: readonly Pick<UiBoardTask, "state">[]): Counts {
	const c: Counts = { "needs-you": 0, blocked: 0, waiting: 0, working: 0, queued: 0 };
	for (const r of rows) if (r.state !== "done") c[r.state] += 1;
	return c;
}
export const openOf = (c: Counts) => OPEN_STATES.reduce((n, s) => n + c[s], 0);
export const heldOf = (c: Counts) => c.blocked + c.waiting;

/** What the page reads besides the board: names for search and the tiles. */
export interface BoardContext {
	board: UiTaskBoard;
	/** Availability of this card's registry binding; no second snapshot or reader. */
	progress: { work: UiWorkRecords | undefined; coherent: boolean; lastKnown: boolean };
	projects: Map<string, UiWorkRecord>;
	initiatives: Map<string, string>;
	roleTitles: Map<string, string>;
	groups: Map<string, UiBoardGroup>;
}
export function contextOf(overview: UiRolesOverview, board: UiTaskBoard, lastKnown = false): BoardContext {
	return {
		board,
		progress: { work: overview.work, coherent: overview.taskBoard === board, lastKnown },
		projects: new Map(
			(Array.isArray(overview.work?.projects) ? overview.work.projects : [])
				.filter((p) => p && typeof p.id === "string")
				.map((p) => [p.id, p]),
		),
		initiatives: new Map(
			(Array.isArray(overview.work?.initiatives) ? overview.work.initiatives : [])
				.filter((i) => i && typeof i.id === "string")
				.map((i) => [i.id, i.name]),
		),
		roleTitles: new Map(overview.roles.map((r) => [r.id, r.title])),
		groups: new Map([...board.groups, ...board.roleGroups].map((g) => [g.key, g])),
	};
}
export const groupLabelOf = (ctx: BoardContext, key: string) => ctx.groups.get(key)?.label ?? key.replace(/^tag:/, "");

/** spec-page.md §Search: case-insensitive substring, one leading # ignored. */
export const searchKey = (q: string) => q.trim().toLowerCase().replace(/^#/, "");

function initiativeNameOf(ctx: BoardContext, t: UiBoardTask): string | undefined {
	const project = t.project ? ctx.projects.get(t.project) : undefined;
	const id = t.initiative ?? project?.initiative ?? undefined;
	return id ? ctx.initiatives.get(id) : undefined;
}
export function taskMatches(ctx: BoardContext, t: UiBoardTask, key: string): boolean {
	if (!key) return true;
	const role = t.role ?? "";
	const fields = [
		t.title,
		String(t.id),
		role,
		roleName(role),
		ctx.roleTitles.get(role),
		t.ref,
		refLabel(t),
		groupLabelOf(ctx, t.groupKey),
		...(t.tags ?? []),
		initiativeNameOf(ctx, t),
	];
	return fields.some((f) => !!f && f.toLowerCase().includes(key));
}
/** The rows a group shows under a search: all of them when its label matches, else the matching ones. */
export function shownRows(ctx: BoardContext, label: string, rows: readonly UiBoardTask[], key: string): UiBoardTask[] {
	if (!key || label.toLowerCase().includes(key)) return [...rows];
	return rows.filter((t) => taskMatches(ctx, t, key));
}

export interface TileModel {
	group: UiBoardGroup;
	/** The group's rows on the board (open + sent done rows). */
	all: UiBoardTask[];
	/** What this view shows (= all without a search). */
	shown: UiBoardTask[];
	counts: Counts;
	open: number;
	heldOn: { role: string; count: number } | null;
}
function tileOf(ctx: BoardContext, group: UiBoardGroup, all: UiBoardTask[], key: string): TileModel | null {
	const shown = shownRows(ctx, group.label, all, key);
	if (key && !shown.length && !group.label.toLowerCase().includes(key)) return null;
	const counts = key ? countsOf(shown) : group.counts;
	return { group, all, shown, counts, open: openOf(counts), heldOn: heldOnOf(all) };
}
function rowsByGroup(board: UiTaskBoard, keyOf: (t: UiBoardTask) => string) {
	const by = new Map<string, UiBoardTask[]>();
	for (const t of board.tasks) {
		const k = keyOf(t);
		by.set(k, [...(by.get(k) ?? []), t]);
	}
	return by;
}

export interface GroupedTiles {
	/** Bento tiles, server order. */
	tiles: TileModel[];
	/** Active projects with nothing open ("Nothing open right now"). */
	quiet: TileModel[];
	/** Finished projects and tag groups with only done rows ("Done lately"); quiet roles in Department. */
	done: TileModel[];
}

/** Project view (spec-page.md §Views): the server's groups in its order. */
export function projectTiles(ctx: BoardContext, key: string, opened: ReadonlySet<string>): GroupedTiles {
	const by = rowsByGroup(ctx.board, (t) => t.groupKey);
	const out: GroupedTiles = { tiles: [], quiet: [], done: [] };
	for (const group of ctx.board.groups) {
		const tile = tileOf(ctx, group, by.get(group.key) ?? [], key);
		if (!tile) continue;
		const finished = group.kind === "project" && group.projectStatus && group.projectStatus !== "active";
		if (group.open > 0 && !finished) out.tiles.push(tile);
		else if (key && tile.shown.length) out.tiles.push(tile);
		else if (opened.has(group.key)) out.tiles.push(tile);
		else if (group.kind === "project" && !finished) out.quiet.push(tile);
		else if (group.kind !== "none" && (finished || group.doneShown > 0 || group.done14d > 0)) out.done.push(tile);
	}
	return out;
}

/** Department view: one tile per role with open work, the rest folded as quiet roles. */
export function departmentTiles(ctx: BoardContext, key: string, opened: ReadonlySet<string>): GroupedTiles {
	const by = rowsByGroup(ctx.board, (t) => `role:${t.role ?? ""}`);
	const out: GroupedTiles = { tiles: [], quiet: [], done: [] };
	for (const group of ctx.board.roleGroups) {
		const tile = tileOf(ctx, group, by.get(group.key) ?? [], key);
		if (!tile) continue;
		if (group.open > 0 || opened.has(group.key) || (key && tile.shown.length)) out.tiles.push(tile);
		else out.done.push(tile);
	}
	return out;
}

export interface StatusTile {
	key: string;
	name: string;
	state: UiBoardState;
	rows: UiBoardTask[];
	/** Rows clustered by group, groups with most rows first, "No project or tag" last. */
	clusters: { key: string; label: string; rows: UiBoardTask[] }[];
}
const STATUS_TILES: [string, string, UiBoardState[]][] = [
	["status:you", "Needs you", ["needs-you"]],
	["status:held", "Blocked or waiting", ["blocked", "waiting"]],
	["status:working", "Working", ["working"]],
	["status:queued", "Queued", ["queued"]],
	["status:done", "Done lately", ["done"]],
];
const FOURTEEN_DAYS = 14 * 24 * 3600_000;
export function statusTiles(ctx: BoardContext, key: string): StatusTile[] {
	const since = ctx.board.asOf - FOURTEEN_DAYS;
	const out: StatusTile[] = [];
	for (const [k, name, states] of STATUS_TILES) {
		const rows = ctx.board.tasks.filter(
			(t) =>
				states.includes(t.state) && (t.state !== "done" || (t.finishedAt ?? 0) >= since) && taskMatches(ctx, t, key),
		);
		if (!rows.length && (key || k === "status:done")) continue;
		const by = new Map<string, UiBoardTask[]>();
		for (const t of rows) by.set(t.groupKey, [...(by.get(t.groupKey) ?? []), t]);
		const clusters = [...by]
			.sort((a, b) => Number(a[0] === "none") - Number(b[0] === "none") || b[1].length - a[1].length)
			.map(([g, rs]) => ({ key: g, label: groupLabelOf(ctx, g), rows: [...rs].sort((a, b) => rankOf(a) - rankOf(b)) }));
		out.push({ key: k, name, state: states[0], rows, clusters });
	}
	return out;
}

export interface NowLane {
	role: string;
	rows: UiBoardTask[];
	running: UiBoardTask[];
	held: UiBoardTask[];
	next: UiBoardTask[];
}
/** Now: one lane per role with open work: needs-you first, then most running, then most open. */
export function nowLanes(ctx: BoardContext, key: string): NowLane[] {
	const by = new Map<string, UiBoardTask[]>();
	for (const t of ctx.board.tasks)
		if (isOpen(t) && taskMatches(ctx, t, key)) by.set(t.role ?? "", [...(by.get(t.role ?? "") ?? []), t]);
	const lanes = [...by].map(([role, rows]) => ({
		role,
		rows,
		running: rows.filter((t) => t.state === "working"),
		held: rows
			.filter((t) => t.state === "needs-you" || t.state === "blocked" || t.state === "waiting")
			.sort((a, b) => rankOf(a) - rankOf(b)),
		next: rows
			.filter((t) => t.state === "queued")
			.sort((a, b) => (a.queueIndex ?? Infinity) - (b.queueIndex ?? Infinity) || a.id - b.id),
	}));
	const you = (l: NowLane) => (l.held.some((t) => t.state === "needs-you") ? 0 : 1);
	return lanes.sort(
		(a, b) =>
			you(a) - you(b) ||
			b.running.length - a.running.length ||
			b.rows.length - a.rows.length ||
			(a.role < b.role ? -1 : 1),
	);
}

/** Lede: "N things need you." and the busiest group (not "none"): open and held. */
export function busiestOf(ctx: BoardContext): { label: string; open: number; held: number } | null {
	let top: UiBoardGroup | null = null;
	for (const g of ctx.board.groups) if (g.kind !== "none" && g.open > 0 && (!top || g.open > top.open)) top = g;
	return top ? { label: top.label, open: top.open, held: heldOf(top.counts) } : null;
}

/** Fleet bar: one mark per open task in the board's order, and the legend counts. */
export function fleetOf(board: UiTaskBoard) {
	const open = board.tasks.filter(isOpen);
	return { open, counts: countsOf(open), roles: new Set(open.map((t) => t.role ?? "")).size };
}

/** The 3 search suggestions of "No results": a role, a group and a task number from the board. */
export function suggestionsOf(ctx: BoardContext): string[] {
	const open = ctx.board.tasks.filter(isOpen);
	const role = open[0]?.role;
	const group = ctx.board.groups.find((g) => g.open > 0 && g.kind !== "none");
	const task = open.find((t) => t.role !== role) ?? open[0];
	return [...new Set([role ? roleName(role) : "", group?.label ?? "", task ? String(task.id) : ""].filter(Boolean))];
}

/** "Done when" marks of a project: its doneWhen list, else none. */
export function goalsOf(
	project: UiWorkRecord | undefined,
): { met: number; total: number; items: { item: string; met: boolean }[] } | null {
	if (!project) return null;
	const items = project.doneWhen ?? [];
	if (items.length) return { met: items.filter((i) => i.met).length, total: items.length, items };
	return { met: Math.min(project.met, project.items), total: project.items, items: [] };
}

/** The ask key "<role>:task:<id>" -> the board ref "<role> #<id>" (no task: null). */
export function refOfAskKey(key: string | undefined): string | null {
	const m = key ? /^([a-z0-9-]+):task:(\d+)$/.exec(key) : null;
	return m ? `${m[1]} #${m[2]}` : null;
}

const DEPT: Record<string, string> = {
	design: "design",
	frontend: "frontend",
	backend: "backend",
	qa: "qa",
	ops: "ops",
	architecture: "architecture",
	temper: "backend",
	systems: "ops",
	security: "qa",
	product: "design",
	data: "architecture",
	docs: "frontend",
	marketing: "qa",
	coo: "design",
	rollcall: "backend",
};
/** The department colour a role's dot uses (the v8 tokens' dept palette). */
export const deptOf = (role: string | undefined) => DEPT[role ?? ""] ?? "architecture";
