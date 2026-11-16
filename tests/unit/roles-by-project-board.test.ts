/**
 * roles-by-project B-cases (spec-acceptance.md §B; spec-data.md): the board producer `buildTaskBoard`, the group key,
 * the board state, the done-predecessor walk and the done-when marks. Failing first (frontend #293 seam); Backend's
 * build makes them pass by turning `notBuilt(` into `it(`, never by deleting or weakening a case.
 * Counts are checked against plain recount loops in this file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UiRoleTask, UiWorkRecord, UiWorkRecords } from "../../server/protocol.js";
import type { UiBoardState, UiBoardTask, UiTaskBoard } from "../../server/roles-board-protocol.js";
import { buildTaskBoard, type TaskBoardRow } from "../../server/roles-by-project.js";
import {
	boardStateOf,
	donePredecessors,
	groupKeyOf,
	ROLES_BY_PROJECT_GROUPS_NOT_BUILT,
} from "../../server/shared/roles-by-project/groups.js";
import { normTags } from "../../server/shared/task-tags.js";
import { workRecordsFrom, workRecordsFromState } from "../../server/work-records.js";
import type { RolesByProjectFixture } from "../fixtures/roles-by-project/make-fixtures.js";
import { notBuilt } from "./roles-by-project-not-built.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const AT = Date.UTC(2026, 10, 16, 12, 0, 0);
const OPEN_STATES = ["needs-you", "blocked", "waiting", "working", "queued"] as const;
const ROSTER = ["architecture", "backend", "frontend", "ops", "qa"].map((id) => ({
	id,
	title: id[0].toUpperCase() + id.slice(1),
}));

const refOf = (role: string, id: number) => `${role} #${id}`;
const task = (role: string, id: number, over: Partial<UiRoleTask> = {}): UiRoleTask => ({
	id,
	role,
	title: `${role} task ${id}`,
	status: "ready",
	...over,
});
const doneTask = (role: string, id: number, finishedAt: number | undefined, over: Partial<UiRoleTask> = {}) =>
	task(role, id, { status: "done", ...(finishedAt === undefined ? {} : { finishedAt }), ...over });
const isOpen = (t: UiRoleTask) => t.status !== "done" && t.status !== "dropped";

/** Rows as the overview reader holds them: per role, open active tasks first (input order), then ready ones. */
function rowsOf(tasks: readonly UiRoleTask[]): TaskBoardRow[] {
	const next = new Map<string, number>();
	const ordered = [...tasks.filter((t) => isOpen(t) && t.status !== "ready"), ...tasks.filter((t) => t.status === "ready")];
	const index = new Map<UiRoleTask, number>();
	for (const t of ordered) {
		const i = next.get(t.role ?? "") ?? 0;
		index.set(t, i);
		next.set(t.role ?? "", i + 1);
	}
	return tasks.map((t) => ({ task: t, queueIndex: index.get(t) ?? null }));
}

const record = (id: string, name: string, status: UiWorkRecord["status"] = "active"): UiWorkRecord => ({
	id,
	name,
	lead: "ops",
	status,
	initiative: null,
	items: 0,
	met: 0,
});
const workOf = (...projects: UiWorkRecord[]): UiWorkRecords => ({ initiatives: [], projects });

function boardOf(tasks: readonly UiRoleTask[], work: UiWorkRecords = workOf(), problem?: string): UiTaskBoard {
	return buildTaskBoard({ at: AT, rows: rowsOf(tasks), work, roster: ROSTER, ...(problem ? { problem } : {}) });
}

const byRef = (board: UiTaskBoard) => new Map(board.tasks.map((t) => [t.ref, t]));
const groupOf = (board: UiTaskBoard, key: string) => {
	const g = board.groups.find((x) => x.key === key);
	if (!g) throw new Error(`no group ${key} in ${board.groups.map((x) => x.key).join(", ")}`);
	return g;
};
const openOf = (rows: readonly UiBoardTask[]) => rows.filter((t) => t.state !== "done");

/** Invariants every board keeps (spec-data.md): a plain recount over the rows it sent. */
function expectBoardInvariants(board: UiTaskBoard) {
	const refs = board.tasks.map((t) => t.ref);
	expect(new Set(refs).size).toBe(refs.length);
	for (const t of board.tasks) expect(t.ref).toBe(refOf(t.role ?? "", t.id));
	const keys = new Set(board.groups.map((g) => g.key));
	expect(keys.size).toBe(board.groups.length);
	for (const t of board.tasks) expect(keys.has(t.groupKey)).toBe(true);
	for (const g of board.groups) {
		const rows = board.tasks.filter((t) => t.groupKey === g.key);
		let open = 0;
		const counts: Record<string, number> = Object.fromEntries(OPEN_STATES.map((s) => [s, 0]));
		for (const t of rows) {
			if (t.state === "done") continue;
			open += 1;
			counts[t.state] += 1;
		}
		expect(g.open).toBe(open);
		expect(g.counts).toEqual(counts);
		expect(Object.values(g.counts).reduce((a, b) => a + b, 0)).toBe(g.open);
		expect(g.doneShown).toBe(rows.length - open);
	}
}

describe("roles-by-project B1: group key", () => {
	const work = workOf(record("p-alpha", "Alpha project"), record("p-beta", "Beta project"));
	const tasks = [
		task("backend", 1, { project: "p-alpha", tags: ["ui"] }),
		task("backend", 2, { status: "working", tags: ["misc", "p-beta"] }),
		task("frontend", 3, { tags: ["ui-polish", "roles-page"] }),
		task("frontend", 4, { status: "blocked", project: "gone-project", tags: ["roles-page"] }),
		task("qa", 5, { status: "waiting" }),
		doneTask("qa", 6, AT - DAY),
		task("ops", 7, { project: "gone-project" }),
	];
	const expected: Record<string, string> = {
		"backend #1": "project:p-alpha",
		"backend #2": "project:p-beta",
		"frontend #3": "tag:ui-polish",
		"frontend #4": "tag:roles-page",
		"qa #5": "none",
		"qa #6": "none",
		"ops #7": "none",
	};

	notBuilt("B1 groupKeyOf: registry project, project-id tag, first tag, nothing", () => {
		const ids = new Set(work.projects.map((p) => p.id));
		for (const t of tasks) expect(groupKeyOf(t, ids)).toBe(expected[refOf(t.role ?? "", t.id)]);
	});

	notBuilt("B1 board: each task in one group; group open sums equal the role queues' open counts", () => {
		const board = boardOf(tasks, work);
		expectBoardInvariants(board);
		const rows = byRef(board);
		for (const [ref, key] of Object.entries(expected)) expect(rows.get(ref)?.groupKey).toBe(key);
		expect(groupOf(board, "tag:roles-page").open).toBe(1);
		expect(groupOf(board, "tag:ui-polish").open).toBe(1);
		const roleOpen = new Map<string, number>();
		for (const t of tasks) if (isOpen(t)) roleOpen.set(t.role ?? "", (roleOpen.get(t.role ?? "") ?? 0) + 1);
		const totalOpen = [...roleOpen.values()].reduce((a, b) => a + b, 0);
		expect(board.groups.reduce((a, g) => a + g.open, 0)).toBe(totalOpen);
		expect(board.roleGroups.map((g) => g.key)).toEqual(ROSTER.map((r) => `role:${r.id}`));
		for (const g of board.roleGroups) {
			expect(g.kind).toBe("role");
			expect(g.open).toBe(roleOpen.get(g.key.slice("role:".length)) ?? 0);
		}
		const alpha = groupOf(board, "project:p-alpha");
		expect([alpha.kind, alpha.label, alpha.projectId, alpha.projectStatus]).toEqual([
			"project",
			"Alpha project",
			"p-alpha",
			"active",
		]);
		expect([groupOf(board, "tag:ui-polish").kind, groupOf(board, "tag:ui-polish").label]).toEqual(["tag", "ui-polish"]);
		expect([groupOf(board, "none").kind, groupOf(board, "none").label]).toEqual(["none", "No project or tag"]);
	});
});

describe("roles-by-project B2: aliased tags", () => {
	it("normTags folds both aliases to one canonical tag (the input B2 relies on)", () => {
		expect(normTags(["openviking"])).toEqual(["openviking-v2"]);
		expect(normTags(["openviking-fixes"])).toEqual(["openviking-v2"]);
	});
	notBuilt("B2 tags folded by normTags land in one group, no twin groups", () => {
		const tasks = [
			task("backend", 1, { tags: normTags(["openviking"]) }),
			task("frontend", 2, { status: "working", tags: normTags(["openviking-fixes"]) }),
		];
		const board = boardOf(tasks);
		expectBoardInvariants(board);
		expect(board.groups.filter((g) => g.key.startsWith("tag:openviking")).map((g) => g.key)).toEqual([
			"tag:openviking-v2",
		]);
		expect(groupOf(board, "tag:openviking-v2").open).toBe(2);
	});
});

describe("roles-by-project B3: board state and counts", () => {
	const hold = { at: AT - HOUR, why: "owner paused it" };
	const cases: [UiRoleTask, UiBoardState | null][] = [
		[task("backend", 1, { status: "stuck" }), "needs-you"],
		[task("backend", 2, { status: "blocked" }), "blocked"],
		[task("backend", 3, { status: "asking" }), "waiting"],
		[task("backend", 4, { status: "waiting" }), "waiting"],
		[task("backend", 5, { status: "working" }), "working"],
		[task("backend", 6, { status: "ready" }), "queued"],
		[task("backend", 7, { status: "ready", paused: hold }), "waiting"],
		[task("backend", 8, { status: "working", paused: hold }), "waiting"],
		[doneTask("backend", 9, AT - HOUR), "done"],
		[task("backend", 10, { status: "dropped", dropped: { why: "not needed", at: AT - HOUR } }), null],
	];
	const tasks = cases.map(([t]) => ({ ...t, tags: ["states"] }));

	notBuilt("B3 boardStateOf: every status, paused open task -> waiting, dropped -> null", () => {
		for (const [t, state] of cases) expect([t.id, boardStateOf(t)]).toEqual([t.id, state]);
	});

	notBuilt("B3 counts per state sum to open; dropped in no count and not sent", () => {
		const board = boardOf(tasks);
		expectBoardInvariants(board);
		const g = groupOf(board, "tag:states");
		expect(g.open).toBe(8);
		expect(g.counts).toEqual({ "needs-you": 1, blocked: 1, waiting: 4, working: 1, queued: 1 });
		expect(byRef(board).has("backend #10")).toBe(false);
		expect(byRef(board).get("backend #7")?.state).toBe("waiting");
		const backend = board.roleGroups.find((r) => r.key === "role:backend");
		expect(backend?.open).toBe(8);
		expect(backend?.counts).toEqual(g.counts);
	});
});

describe("roles-by-project B4-B5: done rows in the 14-day window", () => {
	notBuilt("B4 40 done in 14 days: done14d 40, 6 rows sent, the 6 newest (tie: higher id)", () => {
		const tasks: UiRoleTask[] = [];
		for (let id = 1; id <= 40; id++) tasks.push(doneTask("backend", id, AT - id * HOUR, { tags: ["busy-tag"] }));
		tasks[6] = doneTask("backend", 7, AT - 6 * HOUR, { tags: ["busy-tag"] }); // ties with #6; #7 wins
		const board = boardOf(tasks);
		expectBoardInvariants(board);
		const g = groupOf(board, "tag:busy-tag");
		expect([g.done14d, g.doneShown, g.open, g.lastFinishedAt]).toEqual([40, 6, 0, AT - HOUR]);
		expect(board.tasks.filter((t) => t.groupKey === g.key).map((t) => t.id)).toEqual([1, 2, 3, 4, 5, 7]);
	});

	notBuilt("B5 window [asOf - 14 d, asOf]: 15 d out, exactly 14 d in, no finishedAt out, future out", () => {
		const tasks = [
			doneTask("qa", 1, AT - 15 * DAY, { tags: ["window"] }),
			doneTask("qa", 2, AT - 14 * DAY, { tags: ["window"] }),
			doneTask("qa", 3, undefined, { tags: ["window"] }),
			doneTask("qa", 4, AT, { tags: ["window"] }),
			doneTask("qa", 5, AT + 1000, { tags: ["window"] }),
		];
		const board = boardOf(tasks);
		expectBoardInvariants(board);
		const g = groupOf(board, "tag:window");
		expect(g.done14d).toBe(2);
		expect(board.tasks.filter((t) => t.groupKey === g.key).map((t) => t.ref).sort()).toEqual(["qa #2", "qa #4"]);
	});
});

describe("roles-by-project B6-B7: done predecessors", () => {
	const old = AT - 30 * DAY;
	const chain = [
		task("backend", 100, { tags: ["chain"], dependsOnRefs: ["backend #101"] }),
		doneTask("backend", 101, old, { tags: ["chain"], dependsOnRefs: ["backend #102"] }),
		doneTask("backend", 102, old, { tags: ["chain"], dependsOnRefs: ["backend #103"] }),
		doneTask("backend", 103, old, { tags: ["chain"], dependsOnRefs: ["backend #104"] }),
		doneTask("backend", 104, old, { tags: ["chain"], dependsOnRefs: ["backend #105"] }),
		doneTask("backend", 105, old, { tags: ["chain"] }),
	];
	const walkInput = (tasks: readonly UiRoleTask[]) =>
		tasks.map((t) => ({
			ref: refOf(t.role ?? "", t.id),
			state: (isOpen(t) ? "queued" : "done") as UiBoardState,
			dependsOnRefs: t.dependsOnRefs,
		}));

	notBuilt("B6 donePredecessors: 4 steps back from an open task, step 5 never", () => {
		expect([...donePredecessors(walkInput(chain), 4)].sort()).toEqual([
			"backend #101",
			"backend #102",
			"backend #103",
			"backend #104",
		]);
	});

	notBuilt("B6 board: chain open <- d1..d5 (30 days old): d1-d4 sent, d5 not", () => {
		const board = boardOf(chain);
		expectBoardInvariants(board);
		const sent = byRef(board);
		for (const id of [101, 102, 103, 104]) expect(sent.get(refOf("backend", id))?.state).toBe("done");
		expect(sent.has("backend #105")).toBe(false);
		const g = groupOf(board, "tag:chain");
		expect([g.open, g.done14d, g.doneShown]).toEqual([1, 0, 4]);
	});

	notBuilt("B6 a done predecessor in another group is sent in its own group", () => {
		const tasks = [
			task("frontend", 1, { tags: ["front"], dependsOnRefs: ["backend #2"] }),
			doneTask("backend", 2, old, { tags: ["back"] }),
		];
		const board = boardOf(tasks);
		expectBoardInvariants(board);
		expect(byRef(board).get("backend #2")?.groupKey).toBe("tag:back");
		const back = groupOf(board, "tag:back");
		expect([back.open, back.done14d, back.doneShown]).toEqual([0, 0, 1]);
	});

	const loop = [
		task("backend", 200, { tags: ["loop"], dependsOnRefs: ["backend #201", "temper #38"] }),
		doneTask("backend", 201, old, { tags: ["loop"], dependsOnRefs: ["backend #202"] }),
		doneTask("backend", 202, old, { tags: ["loop"], dependsOnRefs: ["backend #201"] }),
	];

	notBuilt("B7 donePredecessors: cycle A -> B -> A among done predecessors ends", () => {
		expect([...donePredecessors(walkInput(loop), 4)].sort()).toEqual(["backend #201", "backend #202"]);
	});

	notBuilt("B7 board: cycle sent once each, every ref in tasks once", () => {
		const board = boardOf(loop);
		expectBoardInvariants(board);
		expect(board.tasks.map((t) => t.ref).sort()).toEqual(["backend #200", "backend #201", "backend #202"]);
	});
});

describe("roles-by-project B8: order and determinism", () => {
	const work = workOf(record("p-n", "Needs project"));
	const tasks = [
		task("backend", 1, { status: "stuck", project: "p-n" }),
		task("qa", 2, { status: "blocked", tags: ["held-a"] }),
		task("qa", 3, { status: "waiting", tags: ["held-b"] }),
		task("qa", 4, { status: "waiting", tags: ["held-b"] }),
		task("frontend", 5, { status: "asking", tags: ["held-b"] }),
		task("backend", 6, { status: "working", tags: ["act-z"] }),
		task("backend", 7, { status: "working", tags: ["act-z"] }),
		task("ops", 8, { tags: ["act-a"] }),
		task("ops", 9, { tags: ["act-a"] }),
		task("qa", 10, { status: "working" }),
		task("qa", 11, { status: "working" }),
		task("backend", 12, { status: "working" }),
		task("backend", 13, { status: "working" }),
		task("ops", 14, { status: "working" }),
		doneTask("frontend", 15, AT - DAY, { tags: ["done-only"] }),
		doneTask("ops", 16, AT - 2 * DAY, { tags: ["act-a"] }),
		doneTask("ops", 17, AT - DAY, { tags: ["act-a"] }),
	];

	notBuilt("B8 same input twice (and rows in another order) -> byte-identical JSON", () => {
		const rows = rowsOf(tasks);
		const once = JSON.stringify(buildTaskBoard({ at: AT, rows, work, roster: ROSTER }));
		expect(JSON.stringify(buildTaskBoard({ at: AT, rows, work, roster: ROSTER }))).toBe(once);
		expect(JSON.stringify(buildTaskBoard({ at: AT, rows: [...rows].reverse(), work, roster: ROSTER }))).toBe(once);
	});

	notBuilt("B8 groups: needs-you > held > active > done-only, then open desc, then label; none last in its tier", () => {
		const board = boardOf(tasks, work);
		expectBoardInvariants(board);
		expect(board.groups.map((g) => g.key)).toEqual([
			"project:p-n",
			"tag:held-b",
			"tag:held-a",
			"tag:act-a",
			"tag:act-z",
			"none",
			"tag:done-only",
		]);
		expect(groupOf(board, "none").roles).toEqual(["backend", "qa", "ops"]);
		expect(board.asOf).toBe(AT);
	});

	notBuilt("B8 tasks: group order, open before done, queueIndex, finishedAt desc, ref", () => {
		const board = boardOf(tasks, work);
		const groupIndex = new Map(board.groups.map((g, i) => [g.key, i]));
		const keyOf = (t: UiBoardTask) => [
			groupIndex.get(t.groupKey) ?? -1,
			t.state === "done" ? 1 : 0,
			t.queueIndex ?? Number.MAX_SAFE_INTEGER,
			-(t.finishedAt ?? 0),
		];
		for (let i = 1; i < board.tasks.length; i++) {
			const a = keyOf(board.tasks[i - 1]);
			const b = keyOf(board.tasks[i]);
			const cmp = a.map((x, k) => Math.sign(x - b[k])).find((s) => s !== 0) ?? 0;
			const inOrder = cmp < 0 || (cmp === 0 && board.tasks[i - 1].ref < board.tasks[i].ref);
			expect([board.tasks[i - 1].ref, board.tasks[i].ref, inOrder]).toEqual([
				board.tasks[i - 1].ref,
				board.tasks[i].ref,
				true,
			]);
		}
		const actA = board.tasks.filter((t) => t.groupKey === "tag:act-a").map((t) => t.ref);
		expect(actA).toEqual(["ops #8", "ops #9", "ops #17", "ops #16"]);
	});
});

describe("roles-by-project B9-B10: which groups, partial reads", () => {
	notBuilt("B9 every work.projects record has a group (0-task ones included); old-done-only tags do not", () => {
		const work = workOf(
			record("p-active", "Quiet project"),
			record("p-done", "Finished project", "done"),
			record("p-dropped", "Dropped project", "dropped"),
			record("p-busy", "Busy project"),
		);
		const tasks = [task("backend", 1, { project: "p-busy" }), doneTask("backend", 2, AT - 30 * DAY, { tags: ["old-tag"] })];
		const board = boardOf(tasks, work);
		expectBoardInvariants(board);
		for (const [key, status, label, open] of [
			["project:p-active", "active", "Quiet project", 0],
			["project:p-done", "done", "Finished project", 0],
			["project:p-dropped", "dropped", "Dropped project", 0],
			["project:p-busy", "active", "Busy project", 1],
		] as const) {
			const g = groupOf(board, key);
			expect([g.projectStatus, g.label, g.open]).toEqual([status, label, open]);
		}
		expect(board.groups.some((g) => g.key === "tag:old-tag")).toBe(false);
		expect(byRef(board).has("backend #2")).toBe(false);
	});

	notBuilt("B10 one unreadable queue: problem set, other groups intact, no guessed counts", () => {
		const tasks = [
			task("backend", 1, { tags: ["seen"] }),
			task("backend", 2, { status: "working", tags: ["seen"] }),
			task("frontend", 3, { status: "blocked" }),
		];
		const clean = boardOf(tasks);
		const partial = boardOf(tasks, workOf(), "qa: queue could not be read");
		expect(typeof partial.problem).toBe("string");
		expect(partial.problem?.length).toBeGreaterThan(0);
		const { problem: _problem, ...rest } = partial;
		expect(rest).toEqual(clean);
		expect(groupOf(partial, "tag:seen").counts).toEqual({ "needs-you": 0, blocked: 0, waiting: 0, working: 1, queued: 1 });
		expect(groupOf(partial, "none").open).toBe(1);
	});
});

describe("roles-by-project B11: done-when marks (server/work-records.ts)", () => {
	let seq = 0;
	const line = (e: Record<string, unknown>) => JSON.stringify({ v: 1, seq: ++seq, ts: 1000 + seq, by: "ops", ...e });
	const items = ["Ship the page", "Tests pass", "Docs updated"];
	const log =
		[
			{ op: "project.create", id: "p1", name: "Project p1", outcome: "x", doneWhen: items, lead: "ops", initiative: null },
			{ op: "project.met", id: "p1", item: "  ship the PAGE ", proof: "commit" },
			{ op: "project.met", id: "p1", item: "Docs updated", proof: "doc" },
			{ op: "project.create", id: "p2", name: "Project p2", outcome: "x", doneWhen: [], lead: "ops", initiative: null },
		]
			.map(line)
			.join("\n") + "\n";
	const state = {
		initiatives: new Map(),
		projects: new Map<string, unknown>([
			["p1", { name: "Project p1", lead: "ops", status: "active", doneWhen: items, met: [{ item: " ship the PAGE " }, { item: "Docs updated" }], initiative: null }],
			["p2", { name: "Project p2", lead: "ops", status: "active", doneWhen: [], met: [], initiative: null }],
		]),
	};
	const marks = [
		{ item: "Ship the page", met: true },
		{ item: "Tests pass", met: false },
		{ item: "Docs updated", met: true },
	];

	/** The producer's not-built signal: doneWhen absent is what an unbuilt (older) server sends. */
	const doneWhenOf = (r: UiWorkRecord | undefined) => {
		if (r?.doneWhen === undefined) throw new Error(ROLES_BY_PROJECT_GROUPS_NOT_BUILT);
		return r.doneWhen;
	};

	for (const [name, read] of [
		["workRecordsFrom (log)", () => workRecordsFrom(log)],
		["workRecordsFromState (pi-queue state)", () => workRecordsFromState(state)],
	] as const) {
		notBuilt(`B11 ${name}: met follows itemKey (case, outer spaces); items/met agree with the list`, () => {
			const records = read();
			expect(records).toBeDefined();
			const p1 = records?.projects.find((p) => p.id === "p1");
			expect([p1?.items, p1?.met]).toEqual([3, 2]);
			const list = doneWhenOf(p1);
			expect(list).toEqual(marks);
			expect(p1?.items).toBe(list.length);
			expect(p1?.met).toBe(list.filter((m) => m.met).length);
			expect(doneWhenOf(records?.projects.find((p) => p.id === "p2"))).toEqual([]);
		});
	}
});

describe("roles-by-project B12: the design's real snapshots", () => {
	const load = (name: string): RolesByProjectFixture =>
		JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/roles-by-project", `${name}.json`), "utf8"));

	for (const [name, openRows] of [
		["busy", 61],
		["tonight", 13],
	] as const) {
		const fixture = load(name);
		const work = workRecordsFromState({
			initiatives: new Map(fixture.registry.initiatives),
			projects: new Map(fixture.registry.projects),
		});

		it(`${name}.json: ${openRows} open rows, registry readable (the input B12 relies on)`, () => {
			expect(fixture.rows.filter((r) => isOpen(r.task)).length).toBe(openRows);
			expect(work?.projects.length).toBe(fixture.registry.projects.length);
		});

		notBuilt(`B12 ${name}.json: open rows ${openRows}; every group count equals the recount; one group per task`, () => {
			const board = buildTaskBoard({ at: fixture.at, rows: fixture.rows, work, roster: fixture.roster });
			expectBoardInvariants(board);
			expect(openOf(board.tasks).length).toBe(openRows);

			const projectIds = new Set((work?.projects ?? []).map((p) => p.id));
			type Tally = { open: number; counts: Record<string, number>; done14d: number };
			const tally = new Map<string, Tally>();
			const roleOpen = new Map<string, number>();
			const openRefs = new Set<string>();
			const ofKey = (key: string) => {
				let t = tally.get(key);
				if (!t) tally.set(key, (t = { open: 0, counts: Object.fromEntries(OPEN_STATES.map((s) => [s, 0])), done14d: 0 }));
				return t;
			};
			for (const { task: t } of fixture.rows) {
				const state = boardStateOf(t);
				if (state === null) continue;
				const g = ofKey(groupKeyOf(t, projectIds));
				if (state === "done") {
					if (t.finishedAt !== undefined && t.finishedAt >= fixture.at - 14 * DAY && t.finishedAt <= fixture.at) g.done14d += 1;
					continue;
				}
				g.open += 1;
				g.counts[state] += 1;
				roleOpen.set(t.role ?? "", (roleOpen.get(t.role ?? "") ?? 0) + 1);
				openRefs.add(refOf(t.role ?? "", t.id));
			}
			expect(new Set(openOf(board.tasks).map((t) => t.ref))).toEqual(openRefs);
			for (const g of board.groups) {
				const want = tally.get(g.key) ?? { open: 0, counts: Object.fromEntries(OPEN_STATES.map((s) => [s, 0])), done14d: 0 };
				expect([g.key, g.open, g.counts, g.done14d]).toEqual([g.key, want.open, want.counts, want.done14d]);
			}
			for (const [key, t] of tally) if (t.open > 0) expect(board.groups.some((g) => g.key === key)).toBe(true);
			for (const g of board.roleGroups) expect([g.key, g.open]).toEqual([g.key, roleOpen.get(g.key.slice(5)) ?? 0]);
			for (const p of projectIds) expect(board.groups.some((g) => g.key === `project:${p}`)).toBe(true);
		});
	}
});
