/**
 * queue-panel：server/task-queue.ts 把 pi-queue 的会话条目重放成队列。
 * 规则必须和 pi-queue queue.ts 的 applyOp 一样（面板显示的就是 pi-queue 接下来会做的），
 * 所以前几条用例照搬 pi-queue tests/queue.test.ts 的 replay 用例。
 */
import { describe, expect, it } from "vitest";
import {
	TASK_QUEUE_ENTRY_TYPE,
	TASK_QUEUE_MAX_DONE,
	taskQueueCommandLine,
	taskQueueFromEntries,
	type TaskQueueEntryLike,
} from "../../server/task-queue.js";
import type { UiTaskQueuePlan } from "../../server/protocol.js";

const plan = (title: string, extra: Partial<UiTaskQueuePlan> = {}): UiTaskQueuePlan => ({
	title,
	goal: "Make the settings page load in under a second",
	doneWhen: "The page shows its data within one second on the test account",
	decided: "Cache the account list for a minute; no new dependencies",
	steps: "1. Measure the load\n2. Add the cache\n3. Measure again",
	verify: "The existing tests plus a timing check in the browser",
	mustNot: "Change the page layout",
	...extra,
});

let clock = 1000;
const entries = (ops: Array<Record<string, unknown>>): TaskQueueEntryLike[] =>
	ops.map((op) => ({ type: "custom", customType: TASK_QUEUE_ENTRY_TYPE, data: { v: 1, ts: clock++, ...op } }));
const replay = (e: TaskQueueEntryLike[], available = true) => taskQueueFromEntries(e, available);
const ids = (tasks: { id: number }[]) => tasks.map((t) => t.id);
const ready = (q: ReturnType<typeof replay>) => q.tasks.filter((t) => t.status === "ready");
const current = (q: ReturnType<typeof replay>) => q.tasks.find((t) => t.status === "working" || t.status === "stuck");

describe("taskQueueFromEntries (mirrors pi-queue's replay)", () => {
	it("adds keep their order; start makes the current task", () => {
		const q = replay(
			entries([
				{ op: "add", id: 1, plan: plan("One") },
				{ op: "add", id: 2, plan: plan("Two") },
				{ op: "add", id: 3, plan: plan("Three") },
				{ op: "run" },
				{ op: "start", id: 1 },
			]),
		);
		expect(q.running).toBe(true);
		expect(current(q)?.id).toBe(1);
		expect(ids(ready(q))).toEqual([2, 3]);
		expect(q.available).toBe(true);
	});

	it("ignores other entry types, unknown ops and other versions", () => {
		const q = replay([
			{ type: "message", data: {} },
			{ type: "custom", customType: "tldr", data: { v: 1, op: "add", id: 9, plan: plan("Not ours"), ts: 1 } },
			...entries([
				{ op: "add", id: 1, plan: plan("One") },
				{ op: "fly", id: 1 },
			]),
			{ type: "custom", customType: TASK_QUEUE_ENTRY_TYPE, data: { v: 2, op: "remove", id: 1, ts: 5 } },
		]);
		expect(ids(q.tasks)).toEqual([1]);
		expect(q.tasks[0].status).toBe("ready");
	});

	it("keeps one current task: a second start is ignored", () => {
		const q = replay(
			entries([
				{ op: "add", id: 1, plan: plan("One") },
				{ op: "add", id: 2, plan: plan("Two") },
				{ op: "start", id: 1 },
				{ op: "start", id: 2 },
			]),
		);
		expect(current(q)?.id).toBe(1);
		expect(q.tasks[1].status).toBe("ready");
	});

	it("stuck, resume, done; done is final", () => {
		const base = [
			{ op: "add", id: 1, plan: plan("One") },
			{ op: "start", id: 1 },
			{ op: "stuck", id: 1, question: "Which port?" },
		];
		let q = replay(entries(base));
		expect(current(q)?.status).toBe("stuck");
		expect(current(q)?.question).toBe("Which port?");
		q = replay(entries([...base, { op: "resume", id: 1 }]));
		expect(current(q)?.status).toBe("working");
		expect(current(q)?.question).toBeUndefined();
		q = replay(entries([...base, { op: "resume", id: 1 }, { op: "done", id: 1, summary: "Used 8080" }]));
		expect(current(q)).toBeUndefined();
		expect(q.tasks[0]).toMatchObject({ status: "done", summary: "Used 8080" });
		expect(q.tasks[0].doneAt).toBeGreaterThan(0);
		q = replay(
			entries([...base, { op: "done", id: 1, summary: "x" }, { op: "start", id: 1 }, { op: "remove", id: 1 }]),
		);
		expect(q.tasks[0].status).toBe("done");
	});

	it("move reorders only the waiting tasks, counting among waiting tasks", () => {
		const adds = [1, 2, 3, 4].map((id) => ({ op: "add", id, plan: plan(`T${id}`) }));
		expect(ids(ready(replay(entries([...adds, { op: "move", id: 3, index: 0 }]))))).toEqual([3, 1, 2, 4]);
		expect(ids(ready(replay(entries([...adds, { op: "move", id: 1, index: 1 }]))))).toEqual([2, 1, 3, 4]);
		expect(ids(ready(replay(entries([...adds, { op: "move", id: 1, index: 9 }]))))).toEqual([2, 3, 4, 1]);
		const q = replay(
			entries([...adds, { op: "start", id: 1 }, { op: "done", id: 1, summary: "ok" }, { op: "move", id: 4, index: 0 }]),
		);
		expect(ids(ready(q))).toEqual([4, 2, 3]);
		const w = replay(entries([...adds, { op: "start", id: 2 }, { op: "move", id: 2, index: 3 }]));
		expect(ids(w.tasks)).toEqual([1, 2, 3, 4]);
	});

	it("drops removed tasks and applies plan updates", () => {
		const q = replay(
			entries([
				{ op: "add", id: 1, plan: plan("One") },
				{ op: "add", id: 2, plan: plan("Two") },
				{ op: "remove", id: 2 },
				{ op: "update", id: 1, plan: plan("One, renamed") },
			]),
		);
		expect(ids(q.tasks)).toEqual([1]);
		expect(q.tasks[0].plan.title).toBe("One, renamed");
	});

	it("clear drops the done tasks and keeps the open ones", () => {
		const q = replay(
			entries([
				{ op: "add", id: 1, plan: plan("One") },
				{ op: "add", id: 2, plan: plan("Two") },
				{ op: "add", id: 3, plan: plan("Three") },
				{ op: "start", id: 1 },
				{ op: "done", id: 1, summary: "x" },
				{ op: "start", id: 2 },
				{ op: "clear" },
			]),
		);
		expect(ids(q.tasks)).toEqual([2, 3]);
	});

	it("run and pause, with the reason", () => {
		let q = replay(entries([{ op: "run" }, { op: "pause", reason: "error" }]));
		expect(q.running).toBe(false);
		expect(q.pausedReason).toBe("error");
		q = replay(entries([{ op: "pause", reason: "error" }, { op: "run" }]));
		expect(q.running).toBe(true);
		expect(q.pausedReason).toBeUndefined();
		q = replay(entries([{ op: "run" }, { op: "pause", reason: "nonsense" }]));
		expect(q.running).toBe(false);
		expect("pausedReason" in q).toBe(false);
	});
});

// The "waiting" state (pi-queue queue_wait); these copy pi-queue tests/queue.test.ts's wait replays.
describe("taskQueueFromEntries (tasks on hold)", () => {
	const HOUR = 3_600_000;
	const waitOp = (id: number, extra: Record<string, unknown> = {}) => ({
		op: "wait",
		id,
		what: "temper restart",
		check: "test -f /tmp/flag",
		everyMs: 120_000,
		until: clock + 24 * HOUR,
		...extra,
	});
	const three = () => [1, 2, 3].map((id) => ({ op: "add", id, plan: plan(`T${id}`) }));
	const held = (q: ReturnType<typeof replay>) => q.tasks.filter((t) => t.status === "waiting");

	it("a wait puts the current task on hold and frees the queue for the next one", () => {
		let q = replay(entries([...three(), { op: "run" }, { op: "start", id: 1 }, waitOp(1)]));
		expect(q.tasks[0].status).toBe("waiting");
		expect(q.tasks[0].wait).toMatchObject({ what: "temper restart", check: "test -f /tmp/flag", everyMs: 120_000 });
		expect(q.tasks[0].wait?.overAt).toBeUndefined();
		expect(current(q)).toBeUndefined();
		expect(ids(held(q))).toEqual([1]);
		expect(ids(ready(q))).toEqual([2, 3]);
		q = replay(entries([...three(), { op: "run" }, { op: "start", id: 1 }, waitOp(1), { op: "start", id: 2 }]));
		expect(current(q)?.id).toBe(2);
		expect(q.tasks[0].status).toBe("waiting");
	});

	it("only a task being worked on (or already on hold) can go on hold", () => {
		expect(replay(entries([...three(), waitOp(2)])).tasks[1].status).toBe("ready");
		const stuck = replay(
			entries([...three(), { op: "start", id: 1 }, { op: "stuck", id: 1, question: "?" }, waitOp(1)]),
		);
		expect(stuck.tasks[0].status).toBe("stuck");
		const done = replay(entries([...three(), { op: "start", id: 1 }, { op: "done", id: 1, summary: "ok" }, waitOp(1)]));
		expect(done.tasks[0].status).toBe("done");
		const again = replay(entries([...three(), { op: "start", id: 1 }, waitOp(1), waitOp(1, { what: "CI" })]));
		expect(again.tasks[0].wait?.what).toBe("CI");
	});

	it("a wait that ends while another task runs goes back to work only after that task", () => {
		const base = [
			...three(),
			{ op: "run" },
			{ op: "start", id: 1 },
			waitOp(1),
			{ op: "start", id: 2 },
			{ op: "wait_over", id: 1 },
		];
		let q = replay(entries(base));
		expect(q.tasks[0].wait?.overAt).toBeGreaterThan(0);
		expect(q.tasks[0].status).toBe("waiting");
		q = replay(entries([...base, { op: "resume", id: 1 }]));
		expect(current(q)?.id).toBe(2);
		expect(q.tasks[0].status).toBe("waiting");
		q = replay(entries([...base, { op: "done", id: 2, summary: "ok" }, { op: "resume", id: 1 }]));
		expect(current(q)?.id).toBe(1);
		expect(current(q)?.wait).toBeUndefined();
		expect(ids(ready(q))).toEqual([3]);
	});

	it("wait_over counts once and keeps why a wait failed; a failed wait asks only when nothing else is current", () => {
		const base = [...three(), { op: "start", id: 1 }, waitOp(1)];
		const q = replay(entries([...base, { op: "wait_over", id: 1, failed: "Gave up" }, { op: "wait_over", id: 1 }]));
		expect(q.tasks[0].wait?.failed).toBe("Gave up");
		expect(replay(entries([...three(), { op: "wait_over", id: 2 }])).tasks[1].wait).toBeUndefined();
		const stuck = replay(
			entries([...base, { op: "wait_over", id: 1, failed: "Gave up" }, { op: "stuck", id: 1, question: "How?" }]),
		);
		expect(current(stuck)?.status).toBe("stuck");
		expect(current(stuck)?.wait).toBeUndefined();
		const busy = replay(
			entries([
				...base,
				{ op: "start", id: 2 },
				{ op: "wait_over", id: 1, failed: "x" },
				{ op: "stuck", id: 1, question: "How?" },
			]),
		);
		expect(current(busy)?.id).toBe(2);
		expect(busy.tasks[0].status).toBe("waiting");
	});

	it("a task on hold can be removed, and a wait with missing numbers gets pi-queue's defaults", () => {
		const removed = replay(entries([...three(), { op: "start", id: 1 }, waitOp(1), { op: "remove", id: 1 }]));
		expect(ids(removed.tasks)).toEqual([2, 3]);
		const q = replay(entries([...three(), { op: "start", id: 1 }, { op: "wait", id: 1, what: "x", check: "true" }]));
		const w = q.tasks[0].wait;
		expect(w?.everyMs).toBe(2 * 60_000);
		expect(w && w.until - w.since).toBe(24 * HOUR);
	});
});

describe("taskQueueFromEntries (defensive parts)", () => {
	it("keeps only the newest done tasks, and every open one", () => {
		const ops: Array<Record<string, unknown>> = [];
		const n = TASK_QUEUE_MAX_DONE + 3;
		for (let id = 1; id <= n; id++) {
			ops.push({ op: "add", id, plan: plan(`T${id}`) }, { op: "start", id }, { op: "done", id, summary: `did ${id}` });
		}
		ops.push({ op: "add", id: n + 1, plan: plan("Waiting") });
		const q = replay(entries(ops));
		const done = q.tasks.filter((t) => t.status === "done");
		expect(done).toHaveLength(TASK_QUEUE_MAX_DONE);
		expect(done.some((t) => t.id === 1)).toBe(false);
		expect(done.some((t) => t.id === n)).toBe(true);
		expect(ready(q).map((t) => t.id)).toEqual([n + 1]);
	});

	it("skips bad ids and fills bad plan parts with empty text", () => {
		const q = replay(
			entries([
				{ op: "add", id: 0, plan: plan("Zero") },
				{ op: "add", id: 1.5, plan: plan("Half") },
				{ op: "add", id: "2", plan: plan("String") },
				{ op: "add", id: 3, plan: { title: 42, goal: "A real goal" } },
			]),
		);
		expect(ids(q.tasks)).toEqual([3]);
		expect(q.tasks[0].plan).toMatchObject({ title: "", goal: "A real goal", steps: "" });
	});

	it("caps very long parts", () => {
		const q = replay(entries([{ op: "add", id: 1, plan: plan("Long", { steps: "x".repeat(10_000) }) }]));
		expect(q.tasks[0].plan.steps.length).toBeLessThanOrEqual(4001);
	});

	it("reports whether pi-queue is loaded", () => {
		expect(replay([], false)).toEqual({ running: false, available: false, tasks: [] });
	});
});

describe("taskQueueCommandLine", () => {
	it("turns panel actions into /queue commands", () => {
		expect(taskQueueCommandLine("start", undefined)).toBe("/queue start");
		expect(taskQueueCommandLine("stop", 3)).toBe("/queue stop");
		expect(taskQueueCommandLine("up", 2)).toBe("/queue up 2");
		expect(taskQueueCommandLine("down", 2)).toBe("/queue down 2");
		expect(taskQueueCommandLine("remove", 7)).toBe("/queue remove 7");
		expect(taskQueueCommandLine("clear", undefined)).toBe("/queue clear");
	});

	it("refuses anything else", () => {
		expect(taskQueueCommandLine("remove", undefined)).toBeNull();
		expect(taskQueueCommandLine("up", "2; rm -rf /")).toBeNull();
		expect(taskQueueCommandLine("up", -1)).toBeNull();
		expect(taskQueueCommandLine("list", undefined)).toBeNull();
		expect(taskQueueCommandLine("start now", undefined)).toBeNull();
	});
});
