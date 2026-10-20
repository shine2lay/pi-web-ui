// @vitest-environment jsdom
// roles-current-task (Ops #277, docs/live-progress.md, H-ROLES-CURRENT-1): the Roles page's Current task (the card's
// line and the panel's Current task) is the task the role is on: the busy one, else a started task that isn't
// paused, else any task that isn't paused, else the first. Before, the first open task in queue order stood in front
// between turns even when the owner had paused it (Design #41 while #45 and #63 were in progress).
// Fixed fictional data only; no chats, no server, no model.
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectExactRoles } from "../../web/src/roles-exact-model.js";
import { createExactRolesView } from "../../web/src/roles-exact-view.js";
import type { SurfaceValue, SurfaceValues } from "../../web/src/roles-u0/types.js";

const NOW = Date.parse("2026-10-19T20:00:00Z");
const DAY = 24 * 60 * 60_000;
const DIR = "/home/test/.pi/agent/sessions/fixture";
const HOME = `${DIR}/design-home.jsonl`;
type Row = Record<string, unknown>;

const task = (id: number, extra: Row = {}): Row => ({
	id,
	title: `Task ${id}`,
	status: "working",
	chat: { file: `${DIR}/task-${id}.jsonl`, where: id },
	...extra,
});
/** The owner's pause as the server sends it on a task row (server/roles-overview.ts taskOf); the row keeps its status. */
const PAUSED: Row = { paused: { at: NOW - 10 * DAY, why: "Owner: hold this one" } };
const input = (active: Row[]) => ({
	status: "ready",
	overview: {
		at: NOW,
		roles: [
			{
				id: "design",
				title: "Design",
				status: "busy",
				workMode: "self-start",
				homeChat: { file: HOME, where: "home" },
				queue: { running: true, active, queued: [], counts: { active: active.length, queued: 0, done: 0 } },
			},
		],
		asks: [],
		work: { initiatives: [], projects: [] },
	},
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
/** The task the card names and the one the opened panel names as its Current task. */
function current(active: Row[]): { card: SurfaceValue; panel: SurfaceValue } {
	vi.useFakeTimers();
	const model = projectExactRoles(input(active), "open", NOW);
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
	view.openRole("design");
	vi.runAllTimers();
	const values = view.values(1400, 780);
	const card = list(object(values.glance).boxes)
		.map(object)
		.find((b) => b.id === "design");
	const ex = object(values.ex);
	return { card: card?.glance, panel: `${ex.taskId} ${ex.taskTitle}` };
}
const shows = (n: number) => ({ card: `#${n} Task ${n}`, panel: `#${n} Task ${n}` });
afterEach(() => {
	for (const clean of cleanups.splice(0)) clean();
	vi.useRealTimers();
});

describe("roles-current-task: the Current task is the task the role is on", () => {
	it("a paused task first, then working ones: the first working one (was the paused one)", () => {
		expect(current([task(41, PAUSED), task(45), task(63)])).toEqual(shows(45));
	});

	it("the busy task wins, wherever it is in the queue", () => {
		expect(current([task(41, PAUSED), task(45), task(63, { busy: true })])).toEqual(shows(63));
	});

	it("all paused: the first, still shown", () => {
		expect(current([task(41, PAUSED), task(42, { ...PAUSED, status: "waiting" })])).toEqual(shows(41));
	});

	it("none started: the first that isn't paused", () => {
		expect(
			current([
				task(41, { ...PAUSED, status: "waiting" }),
				task(50, { status: "blocked" }),
				task(51, { status: "waiting" }),
			]),
		).toEqual(shows(50));
	});
});
