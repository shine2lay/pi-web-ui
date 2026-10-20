// @vitest-environment jsdom
// roles-live (Ops #272, docs/live-progress.md, H-ROLES-LIVE-1): the Roles page's Latest progress with its time,
// the panel's Activity with task lines and done summaries, and a lead's question that isn't the owner's.
// Fixed fictional data only; no chats, no server, no model.
import { afterEach, describe, expect, it, vi } from "vitest";
import { exactClock, projectExactRoles } from "../../web/src/roles-exact-model.js";
import { createExactRolesView, exactProgress } from "../../web/src/roles-exact-view.js";
import { panelActivity, projectRolePanel } from "../../web/src/roles-panel-model.js";
import { projectUsefulRoles, record } from "../../web/src/roles-useful-model.js";
import type { SurfaceValue, SurfaceValues } from "../../web/src/roles-u0/types.js";

const NOW = Date.parse("2026-10-19T20:00:00Z");
const DIR = "/home/test/.pi/agent/sessions/fixture";
const HOME = `${DIR}/ops-home.jsonl`;
const chatOf = (n: number) => `${DIR}/task-${n}.jsonl`;
const MIN = 60_000;
type Row = Record<string, unknown>;

const task = (id: number, extra: Row = {}) => ({
	id,
	title: `Task ${id}`,
	status: "working",
	chat: { file: chatOf(id), where: id },
	...extra,
});
const role = (extra: Row = {}, active: Row[] = [task(7, { busy: true })]) => ({
	id: "ops",
	title: "Ops",
	status: "busy",
	workMode: "request-only",
	homeChat: { file: HOME, where: "home" },
	tldr: [{ id: "h1", text: "Home line", ts: NOW - 30 * MIN, chat: { file: HOME, where: "home" } }],
	queue: { running: true, active, queued: [], counts: { active: active.length, queued: 0, done: 3 } },
	...extra,
});
const architecture = {
	id: "architecture",
	title: "Architecture",
	status: "idle",
	homeChat: { file: `${DIR}/a.jsonl` },
};
const state = (roles: unknown[], asks: unknown[] = []) => ({
	status: "ready",
	overview: { at: NOW, roles, asks, work: { initiatives: [], projects: [] } },
	checkedAt: NOW,
	heardAt: NOW,
	overviewReceivedAt: NOW,
	appliedAt: NOW,
});

function object(value: SurfaceValue): SurfaceValues {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
	return value;
}
function list(value: SurfaceValue): SurfaceValue[] {
	if (!Array.isArray(value)) throw new Error("expected list");
	return value;
}
const cleanups: (() => void)[] = [];
/** The opened role's panel values (the card's Latest progress, next-action text and Activity). */
function panelValues(input: ReturnType<typeof state>, id = "ops"): SurfaceValues {
	vi.useFakeTimers();
	const model = projectExactRoles(input, "open", NOW);
	const view = createExactRolesView(
		() => model,
		{ open: vi.fn(), about: vi.fn(), answer: vi.fn(), reload: vi.fn() },
		{
			raf: (fn) => setTimeout(fn, 0),
			cancelRaf: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
			setTimeout: (fn, ms) => setTimeout(fn, ms),
			clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
		},
		() => {},
		() => false,
	);
	cleanups.push(() => view.dispose());
	view.openRole(id);
	vi.runAllTimers();
	return object(view.values(1400, 780).ex);
}
const acts = (ex: SurfaceValues) => list(ex.acts).map((a) => [object(a).at, object(a).text]);
const nextOf = (ex: SurfaceValues, id: string) =>
	list(ex.taskGroups)
		.flatMap((g) => list(object(g).items))
		.map(object)
		.find((i) => i.id === id)?.nextText;
afterEach(() => {
	for (const clean of cleanups.splice(0)) clean();
	vi.useRealTimers();
});

describe("roles-live: Latest progress with its time", () => {
	it("shows the task's progress line with its time (was Not recorded)", () => {
		const ex = panelValues(
			state([role({}, [task(7, { busy: true, progress: { text: "Wiring the page", at: NOW - 2 * MIN } })])]),
		);
		expect(ex.progressText).toBe("Wiring the page");
		expect(ex.progressAt).toBe(exactClock(NOW - 2 * MIN));
		expect(ex.progressAt).not.toBe("Not recorded");
	});

	it("an older server's latest line keeps its own time", () => {
		const latest = { id: "t1", text: "Older server line", ts: NOW - 5 * MIN, chat: { file: chatOf(7), where: 7 } };
		const ex = panelValues(state([role({}, [task(7, { busy: true, latest })])]));
		expect(ex.progressText).toBe("Older server line");
		expect(ex.progressAt).toBe(exactClock(NOW - 5 * MIN));
	});

	it("progress wins over latest, and an unsafe progress line falls back to latest", () => {
		const latest = { id: "t1", text: "Older line", ts: NOW - 9 * MIN };
		const row = (progress: unknown) => task(7, { busy: true, latest, progress });
		expect(record(row({ text: "Newer line", at: NOW - MIN }), 7, HOME)).toMatchObject({
			latest: "Newer line",
			latestAt: NOW - MIN,
		});
		expect(record(row({ text: "Bad\u202eline", at: NOW - MIN }), 7, HOME)).toMatchObject({
			latest: "Older line",
			latestAt: NOW - 9 * MIN,
		});
		expect(record(row({ text: "No time" }), 7, HOME)).toMatchObject({ latest: "Older line" });
	});

	it("picks the newer of the line and the queue milestone, each with its time", () => {
		const line = { taskId: 7, name: "T", latest: "Line", latestAt: NOW - 10 * MIN } as never;
		expect(exactProgress(line, { kind: "started", at: NOW - 5 * MIN })).toEqual({
			text: "Queue recorded: task started",
			at: NOW - 5 * MIN,
		});
		expect(exactProgress(line, { kind: "started", at: NOW - 20 * MIN })).toEqual({ text: "Line", at: NOW - 10 * MIN });
		expect(exactProgress(line, { kind: "started", at: null })).toEqual({ text: "Line", at: NOW - 10 * MIN });
		const untimed = { taskId: 7, name: "T", latest: "Line" } as never;
		expect(exactProgress(untimed, { kind: "started", at: NOW - 5 * MIN })).toEqual({
			text: "Queue recorded: task started",
			at: NOW - 5 * MIN,
		});
		expect(exactProgress(untimed, undefined)).toEqual({ text: "Line", at: null });
	});

	it("through the view: a newer milestone than the line shows the milestone and its time", () => {
		const ex = panelValues(
			state([
				role({}, [
					task(7, {
						busy: true,
						progress: { text: "Line", at: NOW - 10 * MIN },
						next: { kind: "unrecorded" },
						queueEvent: { kind: "started", at: NOW - 4 * MIN },
					}),
				]),
			]),
		);
		expect(ex.progressText).toBe("Queue recorded: task started");
		expect(ex.progressAt).toBe(exactClock(NOW - 4 * MIN));
	});

	it("absent fields: a line without any time still reads Not recorded, as before", () => {
		const ex = panelValues(state([role({}, [task(7, { busy: true, latest: { text: "No time here" } })])]));
		expect(ex.progressText).toBe("No time here");
		expect(ex.progressAt).toBe("Not recorded");
	});
});

describe("roles-live: Activity merges task lines and done summaries, newest first", () => {
	const tldr = [
		{ id: "h1", text: "Home line", ts: NOW - 30 * MIN, chat: { file: HOME, where: "home" } },
		{ id: "t1", text: "Task seven line", ts: NOW - 3 * MIN, chat: { file: chatOf(7), where: 7 } },
	];
	const doneRecent = [
		{ id: 5, title: "Five", summary: "Landed and checked", at: NOW - MIN },
		{ id: 4, title: "Four", summary: "", at: NOW - 40 * MIN },
		{ id: 3, title: "Three", summary: "Bad\u202esummary", at: NOW - 50 * MIN },
		{ id: 2, title: "Two", summary: "No time" },
		{ id: 5, title: "Five again", summary: "Duplicate id", at: NOW - 2 * MIN },
	];
	const active = [
		task(7, { busy: true, progress: { text: "Task seven line", at: NOW - 3 * MIN } }),
		task(9, { status: "asking", askOps: true, progress: { text: "Task nine line", at: NOW - 20 * MIN } }),
	];

	it("lists home lines, task lines (#N), progress lines not already listed and done summaries, each timed", () => {
		const ex = panelValues(state([role({ tldr, doneRecent }, active)]));
		expect(acts(ex)).toEqual([
			[exactClock(NOW - 3 * MIN), "#7 Task seven line"],
			[exactClock(NOW - 20 * MIN), "#9 Task nine line"],
			[exactClock(NOW - 30 * MIN), "Home line"],
			[exactClock(NOW - 40 * MIN), "#4 done: Four"],
			[exactClock(NOW - 50 * MIN), "#3 done: Three"],
		]);
	});

	it("a done summary newer than every line comes first", () => {
		const ex = panelValues(
			state([role({ tldr, doneRecent: [{ id: 6, title: "Six", summary: "Shipped", at: NOW }] }, active)]),
		);
		expect(acts(ex)[0]).toEqual([exactClock(NOW), "#6 done: Shipped"]);
	});

	it("absent fields: an older server's Activity is its TL;DR lines, as before (with #N on task lines)", () => {
		const panel = projectRolePanel(state([role({ tldr }, [task(7, { busy: true })])]), "ops");
		expect(panel?.doneRecent).toBeUndefined();
		expect(panelActivity(panel!)).toEqual([
			{ at: NOW - 3 * MIN, text: "#7 Task seven line" },
			{ at: NOW - 30 * MIN, text: "Home line" },
		]);
	});

	it("a home chat line about a task (pi-queue's own line) reads as it is, without #N", () => {
		const copy = { id: "h2", text: "Task #7 done: Task 7", ts: NOW - 5 * MIN, chat: { file: HOME, where: 7 } };
		const panel = projectRolePanel(state([role({ tldr: [copy, ...tldr] }, [task(7, { busy: true })])]), "ops");
		expect(panelActivity(panel!).map((a) => a.text)).toEqual([
			"#7 Task seven line",
			"Task #7 done: Task 7",
			"Home line",
		]);
	});

	it("a malformed doneRecent shows no done lines", () => {
		const panel = projectRolePanel(state([role({ tldr, doneRecent: "nope" })]), "ops");
		expect(panel?.doneRecent).toBeUndefined();
		expect(panelActivity(panel!).some((a) => a.text.includes("done"))).toBe(false);
	});
});

describe("roles-live: a lead's question isn't the owner's", () => {
	it("a stuck task with withLead reads Question with <lead>, and doesn't make the asks unconfirmed", () => {
		const stuck = task(9, { status: "stuck", withLead: "architecture", next: { kind: "answer", who: "owner" } });
		const input = state([role({}, [task(7, { busy: true }), stuck]), architecture]);
		expect(nextOf(panelValues(input), "#9")).toBe("Question with Architecture");
		const useful = projectUsefulRoles(input, "open", NOW);
		expect(useful.needsYou.tell).toBe("can-tell");
		expect(useful.needsYou.total).toBe(0);
	});

	it("without withLead a stuck task stays the owner's (asks unconfirmed while its question is missing)", () => {
		const stuck = task(9, { status: "stuck", next: { kind: "answer", who: "owner" } });
		const input = state([role({}, [task(7, { busy: true }), stuck]), architecture]);
		expect(nextOf(panelValues(input), "#9")).toBe("Awaiting your answer");
		expect(projectUsefulRoles(input, "open", NOW).needsYou.tell).toBe("decision");
	});

	it("an asking task with withLead reads Question with <lead>; a working task ignores it", () => {
		const asking = task(9, { status: "asking", askOps: true, withLead: "ops" });
		const working = task(7, { busy: true, withLead: "architecture" });
		const ex = panelValues(state([role({}, [working, asking]), architecture]));
		expect(nextOf(ex, "#9")).toBe("Question with Ops");
		expect(nextOf(ex, "#7")).not.toContain("Question with");
		expect(record(working, 7, HOME).withLead).toBeUndefined();
	});

	it("withLead owner or a malformed id is ignored", () => {
		for (const withLead of ["owner", "Not A Role", 7]) {
			const stuck = task(9, { status: "stuck", withLead });
			expect(record(stuck, 9, HOME).withLead).toBeUndefined();
			expect(projectUsefulRoles(state([role({}, [stuck])]), "open", NOW).needsYou.tell).toBe("decision");
		}
	});
});
