// @vitest-environment jsdom
// roles-panel (owner, 2026-10-16): one role's panel on the Roles page. Fixed cases for its closed projection
// (roles-panel-model.ts: tasks grouped by initiative and project, a blocked task's lead, the work registry,
// TL;DR lines, the 6 am report, unsafe text), its source route and its strings in every locale pack.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../../web/src/i18n.js";
import { plainBlock, projectRolePanel, type PanelTask, type RolePanel } from "../../web/src/roles-panel-model.js";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const DIR = "/home/u/.pi/agent/sessions/--home-u--";
const HOME = `${DIR}/ops-home.jsonl`;
const chatOf = (n: number) => `${DIR}/task-${n}.jsonl`;
type Row = Record<string, unknown>;

const task = (id: number, status = "ready", extra: Row = {}) => ({ id, status, title: `Name of ${id}`, ...extra });
const started = (id: number, status = "working", extra: Row = {}) =>
	task(id, status, { chat: { file: chatOf(id), where: id }, ...extra });
const work = (extra: Row = {}) => ({
	initiatives: [
		{ id: "team-in-temper", name: "Team in Temper", lead: "architecture", status: "active", items: 1, met: 0 },
	],
	projects: [
		{
			id: "roles-page",
			name: "Roles page",
			lead: "ops",
			status: "active",
			initiative: "team-in-temper",
			items: 2,
			met: 1,
		},
		{ id: "solo", name: "Solo work", lead: "ops", status: "active", initiative: null, items: 1, met: 0 },
	],
	...extra,
});
const ops = (extra: Row = {}) => ({
	id: "ops",
	title: "Ops / tooling",
	status: "busy",
	focus: "Keeps the owner's tools working",
	workMode: "request-only",
	workModeFrom: "rules",
	goals: [{ name: "Fewer stalls", scope: "Blocked tasks get chased", approvedAt: "2026-10-16" }],
	homeChat: { file: HOME, where: "home" },
	tldr: [
		{ id: "a1", text: "Built the role panel", ts: NOW - 60_000, chat: { file: HOME, where: "home" } },
		{
			id: "a2",
			text: "Need your pick on the panel",
			ts: NOW - 120_000,
			needsYou: true,
			chat: { file: chatOf(7), where: 7 },
		},
	],
	report: {
		state: "report",
		date: "2026-10-16",
		sections: [
			{ heading: "Done", text: "Line one\nLine two" },
			{ heading: "Next", text: "More" },
		],
		chat: { file: HOME },
		messageAt: NOW - 3_600_000,
	},
	requests: {
		open: 2,
		newest: { id: "rm-1", from: "security", kind: "question", firstLine: "Can you check?", at: NOW },
	},
	queue: {
		running: true,
		active: [
			started(1, "blocked", {
				parent: { project: "roles-page" },
				waitsOn: "a review",
				owing: {
					lead: "security",
					owes: "a review of the panel",
					due: NOW + 3_600_000,
					reminders: 1,
					chain: ["architecture"],
				},
			}),
			started(2, "working", { parent: { initiative: "team-in-temper" } }),
			started(3, "working", { parent: { project: "solo" } }),
		],
		queued: [
			task(4, "ready", { parent: { project: "ghost" } }),
			task(5, "ready", { parent: { standalone: true } }),
			task(6, "ready"),
			task(7, "ready", { parent: { initiative: "old-thing" } }),
		],
		counts: { active: 3, queued: 4, done: 9 },
	},
	...extra,
});
const roster = (extra: Row = {}) => [
	ops(extra),
	{ id: "security", title: "Security", status: "idle" },
	{ id: "architecture", title: "Architecture", status: "idle" },
];
const snapshot = (roles: unknown[] = roster(), extra: Row = {}) => ({
	status: "ready",
	overview: { at: NOW, roles, asks: [], work: work(), ...extra },
	checkedAt: NOW,
	appliedAt: NOW,
});
const panelOf = (roles: unknown[] = roster(), extra: Row = {}, id = "ops"): RolePanel => {
	const p = projectRolePanel(snapshot(roles, extra), id);
	if (!p) throw new Error("no panel");
	return p;
};
const ids = (tasks: PanelTask[]) => tasks.map((t) => t.taskId);
const allTasks = (p: RolePanel) => [
	...p.groups.flatMap((g) => [...g.tasks, ...g.projects.flatMap((pg) => pg.tasks)]),
	...p.standalone,
	...p.unrecorded,
];

describe("the role panel's projection", () => {
	it("question-lead: an asking task names the department whose lead has its question", () => {
		const queue = ops().queue;
		const p = panelOf(
			roster({
				queue: {
					...queue,
					active: [started(8, "asking", { askOps: true, askLead: "temper" }), started(9, "asking", { askOps: true })],
					queued: [],
					counts: { active: 2, queued: 0, done: 0 },
				},
			}),
		);
		const byTask = (id: number) => allTasks(p).find((t) => t.taskId === id);
		expect(byTask(8)).toMatchObject({ state: "asking-lead", askLead: "temper" });
		expect(byTask(9)).toMatchObject({ state: "asking-ops", askLead: null });
	});

	it("groups open tasks by initiative and project as each task's queue entry names its parent", () => {
		const p = panelOf();
		expect(p.work).toBe("ok");
		expect(p.groups.map((g) => g.initiative?.id ?? null)).toEqual(["team-in-temper", "old-thing", null]);
		const [team, old, none] = p.groups;
		expect(team.initiative).toMatchObject({ name: "Team in Temper", lead: { kind: "role", id: "architecture" } });
		expect(team.projects.map((pg) => [pg.project.id, ids(pg.tasks)])).toEqual([["roles-page", [1]]]);
		expect(team.projects[0].project).toMatchObject({ name: "Roles page", items: 2, met: 1, status: "active" });
		expect(ids(team.tasks)).toEqual([2]);
		// An initiative the registry doesn't have keeps its id, no name or lead.
		expect(old.initiative).toEqual({ id: "old-thing", name: null, lead: null, status: null, items: null, met: null });
		expect(ids(old.tasks)).toEqual([7]);
		// Projects under no initiative: a standalone project, and one the registry doesn't have.
		expect(none.projects.map((pg) => [pg.project.id, pg.project.name, ids(pg.tasks)])).toEqual([
			["solo", "Solo work", [3]],
			["ghost", null, [4]],
		]);
		expect(ids(p.standalone)).toEqual([5]);
		expect(ids(p.unrecorded)).toEqual([6]);
	});

	it("every open task shows exactly once; a duplicated id shows nowhere and is said", () => {
		const p = panelOf();
		expect(ids(allTasks(p)).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect(p.tasksOmitted).toBe(false);
		const dup = panelOf(
			roster({
				queue: {
					running: true,
					active: [started(1, "working", { parent: { project: "solo" } })],
					queued: [task(1, "ready"), task(2, "ready")],
					counts: { active: 1, queued: 2, done: 0 },
				},
			}),
		);
		expect(ids(allTasks(dup))).toEqual([2]);
		expect(dup.tasksOmitted).toBe(true);
	});

	it("a malformed parent counts as not recorded, and is said", () => {
		const p = panelOf(
			roster({
				queue: {
					running: true,
					active: [],
					queued: [
						task(1, "ready", { parent: { project: "Not An Id" } }),
						task(2, "ready", { parent: { project: "a", initiative: "b" } }),
					],
					counts: { active: 0, queued: 2, done: 0 },
				},
			}),
		);
		expect(ids(p.unrecorded)).toEqual([1, 2]);
		expect(p.tasksOmitted).toBe(true);
	});

	it("a blocked task says who it waits on, for what, when it is due, the reminders and who comes next", () => {
		const t1 = panelOf().groups[0].projects[0].tasks[0];
		expect(t1.state).toBe("blocked");
		expect(t1.owing).toEqual({
			lead: { kind: "role", id: "security", label: "Security" },
			owes: "a review of the panel",
			due: NOW + 3_600_000,
			reminders: 1,
			next: [{ kind: "role", id: "architecture", label: "Architecture" }],
		});
		const owing = (o: Row) =>
			panelOf(
				roster({ queue: { running: true, active: [started(1, "blocked", { owing: o })], queued: [], counts: {} } }),
			).unrecorded[0].owing;
		// No chain recorded yet: nobody is named as next. An empty chain: the owner is next.
		expect(owing({ lead: "temper", reminders: 0 })).toEqual({
			lead: { kind: "other", id: "temper" },
			owes: null,
			due: null,
			reminders: 0,
			next: null,
		});
		expect(owing({ lead: "owner", reminders: 0, chain: [] })?.next).toEqual([]);
		expect(owing({ lead: "owner", reminders: 0 })?.lead).toEqual({ kind: "owner" });
		// A task that isn't blocked never shows an owing line, even if one came.
		const working = panelOf(
			roster({
				queue: {
					running: true,
					active: [started(1, "working", { owing: { lead: "security", reminders: 0 } })],
					queued: [],
					counts: {},
				},
			}),
		);
		expect(working.unrecorded[0].owing).toBeNull();
	});

	it("leads lists the initiatives and projects this role leads", () => {
		const p = panelOf();
		expect(p.leads.initiatives).toEqual([]);
		expect(p.leads.projects.map((w) => w.id)).toEqual(["roles-page", "solo"]);
		expect(Object.keys(p.leads.projects[0]).sort()).toEqual(["id", "items", "lead", "met", "name", "status"]);
		const arch = panelOf(roster(), {}, "architecture");
		expect(arch.leads.initiatives.map((w) => w.id)).toEqual(["team-in-temper"]);
	});

	it("says how the registry was read, and its problems never hide the tasks", () => {
		expect(panelOf(roster(), { work: undefined }).work).toBe("not-sent");
		expect(panelOf(roster(), { work: { initiatives: [], projects: [] } }).work).toBe("none");
		expect(panelOf(roster(), { work: { initiatives: [], projects: [], problem: "too-big" } }).work).toBe("too-big");
		expect(panelOf(roster(), { work: { ...work(), problem: "unknown-change" } }).work).toBe("unknown-change");
		const bad = panelOf(roster(), {
			work: work({
				projects: [{ id: "roles-page", name: "Roles page", lead: "ops", items: 1, met: 5, initiative: null }],
			}),
		});
		expect(bad.work).toBe("partial");
		expect(ids(allTasks(bad)).length).toBe(7);
		expect(panelOf(roster(), { work: "nonsense" }).work).toBe("unreadable");
	});

	it("unsafe agent text is dropped whole, never shown in part", () => {
		const p = panelOf(
			roster({
				focus: "Tools\u202e evil",
				tldr: [
					{ id: "x", text: "bad \u0007 bell", ts: NOW, chat: { file: HOME, where: "home" } },
					{ id: "y", text: "fine line", ts: NOW, chat: { file: HOME, where: "home" } },
				],
				report: { state: "report", sections: [{ heading: "Done", text: "ok\u0000no" }], chat: { file: HOME } },
				queue: {
					running: true,
					active: [started(1, "working", { title: "Name\u200b hidden" })],
					queued: [],
					counts: {},
				},
			}),
		);
		expect(p.focus).toBeNull();
		expect(p.lines.map((l) => l.text)).toEqual(["fine line"]);
		expect(p.report.sections).toEqual([{ heading: "Done", text: null }]);
		expect(p.unrecorded[0].name).toBeNull();
	});

	// Security's review of 2cadd193, note 3: a report's error text can name a file; it is never shown.
	it("a report's error text never reaches the panel; its state has fixed words", () => {
		const p = panelOf(
			roster({ report: { state: "failed", error: "ENOENT: open '/home/u/.pi/agent/sessions/x.jsonl'" } }),
		);
		expect(p.report.state).toBe("failed");
		expect(JSON.stringify(p.report)).not.toContain("jsonl");
	});

	it("a report keeps its line breaks; tabs read as spaces", () => {
		expect(plainBlock("a\r\nb\tc", 100)).toEqual({ text: "a\nb  c", clipped: false });
		expect(plainBlock("a\u0007b", 100)).toBeNull();
		expect(panelOf().report.sections[0].text).toBe("Line one\nLine two");
	});

	it("TL;DR lines, the report's chat and the home chat are links in memory; the report jumps to its message", () => {
		const p = panelOf();
		expect(p.lines.map((l) => [l.text, l.needsYou, l.where])).toEqual([
			["Built the role panel", false, "home"],
			["Need your pick on the panel", true, 7],
		]);
		expect(p.lines[1].link).toEqual({ file: chatOf(7), focus: { kind: "tldr", id: "a2" } });
		expect(p.report.link).toEqual({ file: HOME, jumpAt: NOW - 3_600_000 });
		expect(p.home).toEqual({ file: HOME });
		expect(p.requests).toEqual({ open: 2, newest: { from: "Security", text: "Can you check?", at: NOW } });
		expect(p.done).toBe(9);
	});

	it("a role that isn't in the snapshot, or is in it twice, has no panel", () => {
		expect(projectRolePanel(snapshot(), "qa")).toBeNull();
		expect(projectRolePanel(snapshot([ops(), ops()]), "ops")).toBeNull();
		expect(projectRolePanel(snapshot(), "../ops")).toBeNull();
		expect(projectRolePanel(null, "ops")).toBeNull();
	});

	// queue-drop (owner 2026-10-17): tasks the queue's lead dropped are listed apart, with why.
	it("lists the tasks its lead dropped apart from the open ones, each with why", () => {
		const queue = ops().queue;
		const gone = (id: number, why: unknown) => task(id, "dropped", { dropped: { why, at: NOW - 60_000 } });
		const p = panelOf(
			roster({
				queue: {
					...queue,
					dropped: [gone(11, "Superseded by #4"), gone(12, 7)],
					counts: { ...queue.counts, dropped: 3 },
				},
			}),
		);
		expect(p.dropped.map((t) => [t.taskId, t.state, t.dropped])).toEqual([
			[11, "dropped", "Superseded by #4"],
			[12, "dropped", null],
		]);
		expect(p.droppedCount).toBe(3);
		expect(ids(allTasks(p))).not.toContain(11);
		expect(allTasks(p).every((t) => t.dropped === null)).toBe(true);
		// A queue with none: nothing listed, no count.
		const none = panelOf();
		expect(none.dropped).toEqual([]);
		expect(none.droppedCount).toBeNull();
	});
});

describe("the role panel's model source and strings", () => {
	it("source route: no side-effect APIs in the model; every panel string in all eight packs", () => {
		const model = readFileSync(resolve(process.cwd(), "web/src/roles-panel-model.ts"), "utf8");
		expect(model).not.toMatch(
			/localStorage|sessionStorage|fetch\(|WebSocket|setTimeout|appSend|dangerouslySetInnerHTML|innerHTML|href|Markdown|window\.open|title=\{|aria-label=\{(?!t\()/,
		);
		const newKeys = Object.keys(en).filter((key) => /^rp[A-Z]/.test(key)) as (keyof typeof en)[];
		expect(newKeys.length).toBeGreaterThan(60);
		for (const lang of ["de", "es", "fr", "it", "ja", "ko", "pt", "ru"]) {
			const pack = JSON.parse(readFileSync(resolve(process.cwd(), `locales/${lang}.json`), "utf8"));
			for (const key of newKeys) expect({ lang, key, value: pack.strings[key] }).toEqual({ lang, key, value: en[key] });
		}
	});
});
