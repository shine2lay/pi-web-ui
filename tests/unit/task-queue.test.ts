/**
 * queue-panel：server/task-queue.ts 把 pi-queue 的会话条目重放成队列。
 * 规则必须和 pi-queue queue.ts 的 applyOp 一样（面板显示的就是 pi-queue 接下来会做的），
 * 所以前几条用例照搬 pi-queue tests/queue.test.ts 的 replay 用例。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	normAfter,
	normChoices,
	normTouches,
	TASK_QUEUE_DEFAULT_SHAREABLE,
	TASK_QUEUE_ENTRY_TYPE,
	TASK_QUEUE_MAX_DONE,
	taskQueueAll,
	taskQueueCommandLine,
	taskQueueFromEntries,
	taskQueueShareableFrom,
	taskQueueShareableOf,
	taskQueueShareableSetting,
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

	// telegram-answers: pi-queue's stuck op carries answers to pick from (its tests/queue.test.ts "stuck: the choices").
	it("stuck keeps the choices (as pi-queue saves them); they go when the task moves on", () => {
		const base = [
			{ op: "add", id: 1, plan: plan("One") },
			{ op: "start", id: 1 },
		];
		const stuckWith = { op: "stuck", id: 1, question: "Which port?", choices: [" 8080 ", "9090", "8080", "", 7] };
		expect(current(replay(entries([...base, stuckWith])))?.choices).toEqual(["8080", "9090"]);
		expect(
			current(replay(entries([...base, { op: "stuck", id: 1, question: "Which port?" }])))?.choices,
		).toBeUndefined();
		expect(
			current(replay(entries([...base, stuckWith, { op: "stuck", id: 1, question: "Sure?" }])))?.choices,
		).toBeUndefined();
		expect(current(replay(entries([...base, stuckWith, { op: "resume", id: 1 }])))?.choices).toBeUndefined();
		expect(
			replay(entries([...base, stuckWith, { op: "done", id: 1, summary: "ok" }])).tasks[0].choices,
		).toBeUndefined();
	});

	it("normChoices mirrors pi-queue's", () => {
		expect(normChoices("8080")).toEqual([]);
		expect(normChoices(["  Yes  please ", "yes PLEASE", "No", "", null])).toEqual(["Yes please", "No"]);
		expect(normChoices(["a", "b", "c", "d", "e"])).toEqual(["a", "b", "c", "d"]);
		const long = normChoices(["x".repeat(150)])[0];
		expect(long).toHaveLength(100);
		expect(long?.endsWith("\u2026")).toBe(true);
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
		expect(replay([], false)).toEqual({
			running: false,
			available: false,
			tasks: [],
			autoApprove: false,
			autoStart: false,
		});
	});
});

/** queue-lanes: the same rules as pi-queue's lanes (tests/lanes.test.ts there), seen from the Queue tab. */
describe("taskQueueFromEntries (lanes)", () => {
	const byId = (q: ReturnType<typeof replay>, id: number) => q.tasks.find((t) => t.id === id);

	it("groups open tasks that share a touch into one lane; unrelated ones get lanes of their own", () => {
		const q = replay(
			entries([
				{ op: "add", id: 1, plan: plan("One"), touches: ["pi-web-ui repo", "pi memory files"] },
				{ op: "add", id: 2, plan: plan("Two"), touches: ["temper"] },
				{ op: "add", id: 3, plan: plan("Three"), touches: ["  PI MEMORY  FILES "] },
				{ op: "add", id: 4, plan: plan("Four"), touches: [] },
			]),
		);
		expect(byId(q, 3)?.touches).toEqual(["pi memory files"]);
		expect(q.lanes).toEqual([
			{ n: 1, touches: ["pi-web-ui repo", "pi memory files"], alone: false, taskIds: [1, 3] },
			{ n: 2, touches: ["temper"], alone: false, taskIds: [2] },
			{ n: 3, touches: [], alone: true, taskIds: [4] },
		]);
	});

	it("joins lanes through a task that touches both, and drops finished tasks from them", () => {
		const q = replay(
			entries([
				{ op: "add", id: 1, plan: plan("A"), touches: ["a"] },
				{ op: "add", id: 2, plan: plan("B"), touches: ["b"] },
				{ op: "add", id: 3, plan: plan("AB"), touches: ["a", "b"] },
			]),
		);
		expect(q.lanes?.map((l) => l.taskIds)).toEqual([[1, 2, 3]]);
		const after = replay(
			entries([
				{ op: "add", id: 1, plan: plan("A"), touches: ["a"] },
				{ op: "add", id: 2, plan: plan("B"), touches: ["b"] },
				{ op: "add", id: 3, plan: plan("AB"), touches: ["a", "b"] },
				{ op: "remove", id: 3 },
			]),
		);
		expect(after.lanes?.map((l) => l.taskIds)).toEqual([[1], [2]]);
	});

	it("lets lane tasks work side by side, next to this chat's one current task", () => {
		const q = replay(
			entries([
				{ op: "add", id: 1, plan: plan("Old") },
				{ op: "add", id: 2, plan: plan("Lane A"), touches: ["a"] },
				{ op: "add", id: 3, plan: plan("Lane B"), touches: ["b"] },
				{ op: "run" },
				{ op: "start", id: 1 },
				{ op: "start", id: 2, lane: true },
				{ op: "start", id: 3, lane: true },
				{ op: "stuck", id: 3, question: "Which port?" },
				{ op: "chat", id: 2, file: "/s/a.jsonl", title: "Queue #2: Lane A" },
				{ op: "chat", id: 2, file: "/s/other.jsonl" },
				{ op: "chat", id: 1, file: "/s/not-a-lane.jsonl" },
			]),
		);
		expect(byId(q, 1)).toMatchObject({ status: "working" });
		expect(byId(q, 1)?.lane).toBeUndefined();
		expect(byId(q, 1)?.chat).toBeUndefined();
		expect(byId(q, 2)).toMatchObject({
			status: "working",
			lane: true,
			chat: { file: "/s/a.jsonl", title: "Queue #2: Lane A" },
		});
		expect(byId(q, 3)).toMatchObject({ status: "stuck", lane: true, question: "Which port?" });
		// The old task runs in this chat, alone; the lane tasks each have their own lane.
		expect(q.lanes).toEqual([
			{ n: 1, touches: [], alone: true, taskIds: [1] },
			{ n: 2, touches: ["a"], alone: false, taskIds: [2] },
			{ n: 3, touches: ["b"], alone: false, taskIds: [3] },
		]);
		// A second start doesn't restart a task that's already going.
		const again = replay(
			entries([
				{ op: "add", id: 1, plan: plan("A"), touches: ["a"] },
				{ op: "start", id: 1, lane: true },
				{ op: "stuck", id: 1, question: "?" },
				{ op: "start", id: 1, lane: true },
			]),
		);
		expect(byId(again, 1)?.status).toBe("stuck");
	});

	it("puts a lane task whose chat never got going back in its place", () => {
		const q = replay(
			entries([
				{ op: "add", id: 1, plan: plan("A"), touches: ["a"] },
				{ op: "add", id: 2, plan: plan("B"), touches: ["b"] },
				{ op: "start", id: 1, lane: true },
				{ op: "start", id: 2, lane: true },
				{ op: "chat", id: 2, file: "/s/b.jsonl" },
				{ op: "requeue", id: 1 },
				{ op: "requeue", id: 2 },
			]),
		);
		expect(byId(q, 1)).toMatchObject({ status: "ready" });
		expect(byId(q, 1)?.lane).toBeUndefined();
		expect(byId(q, 1)?.startedAt).toBeUndefined();
		// Its chat is known: it did get going, so it stays.
		expect(byId(q, 2)).toMatchObject({ status: "working", lane: true });
	});

	it("keeps the lanes-at-once setting (1 to 8) and only reports it when it isn't the default 2", () => {
		const at = (n: unknown) => replay(entries([{ op: "lanes", n }])).lanesAtOnce;
		expect(at(2)).toBeUndefined();
		expect(at(3)).toBe(3);
		expect(at(0)).toBe(1);
		expect(at(40)).toBe(8);
		expect(at("3")).toBeUndefined();
	});

	it("reads a task's own chat: the one task it works on and the queue it came from", () => {
		const from = { file: "/s/queue.jsonl", title: "tooling" };
		const q = replay(
			entries([
				{ op: "assigned", id: 7, plan: plan("Seven"), touches: ["a"], from },
				{ op: "assigned", id: 8, plan: plan("Eight"), from: { file: "/s/other.jsonl" } },
				{ op: "stuck", id: 7, question: "Which one?" },
			]),
		);
		expect(q.from).toEqual(from);
		expect(q.running).toBe(true);
		expect(ids(q.tasks)).toEqual([7]);
		expect(q.tasks[0]).toMatchObject({ status: "stuck", question: "Which one?", touches: ["a"] });
		// No lanes in a task's own chat.
		expect(q.lanes).toBeUndefined();
		// An assignment without a queue to report to is ignored.
		expect(replay(entries([{ op: "assigned", id: 1, plan: plan("X") }])).tasks).toEqual([]);
	});

	it("keeps old queues exactly as they were: no lanes, no new fields", () => {
		const q = replay(entries([{ op: "add", id: 1, plan: plan("One") }, { op: "run" }, { op: "start", id: 1 }]));
		expect(Object.keys(q).sort()).toEqual(["autoApprove", "autoStart", "available", "running", "tasks"]);
		expect(q.tasks[0].touches).toBeUndefined();
	});

	it("normTouches cleans the list like pi-queue does", () => {
		expect(normTouches([" Pi-Web-UI  repo ", "pi-web-ui repo", 3, "", "temper"])).toEqual(["pi-web-ui repo", "temper"]);
		expect(normTouches("temper")).toBeUndefined();
		expect(normTouches([])).toEqual([]);
		expect(normTouches(["x".repeat(81)])).toEqual([]);
	});
});

/**
 * queue-side-by-side: shareable touches and "after", the same rules as pi-queue's (its tests/lanes.test.ts),
 * and a check against pi-queue's own queue.ts so the two never drift.
 */
describe("taskQueueFromEntries (queue-side-by-side)", () => {
	const byId = (q: ReturnType<typeof replay>, id: number) => q.tasks.find((t) => t.id === id);
	/** The open tasks of the queue in the chat "tooling" on 2026-09-30, with what they touch. */
	const TODAY: Array<[number, string[]]> = [
		[29, ["pi-web-ui repo", "pi-web-deploy"]],
		[31, ["pi-web-ui repo", "pi-web-deploy"]],
		[32, ["pi-web-ui repo", "pi-web-deploy", "pi-identity repo", "pi memory files"]],
		[33, ["pi-worktree repo", "pi-identity repo", "pi memory files", "scheduler", "pi-web-deploy"]],
		[34, ["pi-web-ui repo", "pi-web-deploy"]],
	];
	const today = () => entries(TODAY.map(([id, touches]) => ({ op: "add", id, plan: plan(`Task ${id}`), touches })));

	it("today's queue: #29, #31, #32 and #34 side by side, and #33 in #32's lane (both change the memory files)", () => {
		const q = replay(today());
		expect(q.lanes?.map((l) => [l.taskIds, l.alone])).toEqual([
			[[29], false],
			[[31], false],
			[[32, 33], false],
			[[34], false],
		]);
		// Before shareable touches (an empty list in the settings): one lane.
		const old = taskQueueFromEntries(today(), true, TASK_QUEUE_MAX_DONE, []);
		expect(old.lanes?.map((l) => l.taskIds)).toEqual([[29, 31, 32, 33, 34]]);
	});

	it("shareable: every repo and pi-web-deploy by default; a list in pi-queue's settings replaces it", () => {
		const byDefault = taskQueueShareableOf();
		for (const t of ["pi-web-ui repo", "agent-tools repo", "pi-web-deploy"]) expect(byDefault(t)).toBe(true);
		for (const t of ["pi memory files", "scheduler", "temper-deploy", "repo", "chrome extension"]) {
			expect(byDefault(t)).toBe(false);
		}
		expect(taskQueueShareableSetting(undefined)).toEqual(["* repo", "pi-web-deploy"]);
		expect(taskQueueShareableSetting({ shareable: "x" })).toEqual(["* repo", "pi-web-deploy"]);
		expect(taskQueueShareableSetting({ shareable: [" Temper-Deploy "] })).toEqual(["temper-deploy"]);
		const q = taskQueueFromEntries(
			entries([
				{ op: "add", id: 1, plan: plan("A"), touches: ["temper", "temper-deploy"] },
				{ op: "add", id: 2, plan: plan("B"), touches: ["temper-deploy"] },
				{ op: "add", id: 3, plan: plan("C"), touches: ["pi-web-ui repo"] },
				{ op: "add", id: 4, plan: plan("D"), touches: ["pi-web-ui repo"] },
			]),
			true,
			TASK_QUEUE_MAX_DONE,
			["temper-*"],
		);
		expect(q.lanes?.map((l) => l.taskIds)).toEqual([[1], [2], [3, 4]]);
	});

	it("a task with only shareable touches has a lane of its own; one that lists nothing still runs alone", () => {
		const q = replay(
			entries([
				{ op: "add", id: 1, plan: plan("A"), touches: ["pi-web-ui repo"] },
				{ op: "add", id: 2, plan: plan("B"), touches: [] },
				{ op: "add", id: 3, plan: plan("C"), touches: ["pi-web-ui repo", "pi-web-deploy"] },
			]),
		);
		expect(q.lanes).toEqual([
			{ n: 1, touches: ["pi-web-ui repo"], alone: false, taskIds: [1] },
			{ n: 2, touches: [], alone: true, taskIds: [2] },
			{ n: 3, touches: ["pi-web-ui repo", "pi-web-deploy"], alone: false, taskIds: [3] },
		]);
	});

	it("after: kept as pi-queue saves it, with the tasks still open; done or removed ones release it", () => {
		const base = [
			{ op: "add", id: 1, plan: plan("A"), touches: ["a"] },
			{ op: "add", id: 2, plan: plan("B"), touches: ["b"] },
			{ op: "add", id: 3, plan: plan("C"), touches: ["c"], after: [1, "#2", 3, 0, "x", 1] },
		];
		const q = replay(entries(base));
		expect(byId(q, 3)).toMatchObject({ after: [1, 2], waitingFor: [1, 2] });
		expect(byId(q, 1)?.after).toBeUndefined();
		const one = replay(entries([...base, { op: "start", id: 1, lane: true }, { op: "done", id: 1, summary: "ok" }]));
		expect(byId(one, 3)).toMatchObject({ after: [1, 2], waitingFor: [2] });
		const both = replay(
			entries([
				...base,
				{ op: "start", id: 1, lane: true },
				{ op: "done", id: 1, summary: "ok" },
				{ op: "remove", id: 2 },
			]),
		);
		expect(byId(both, 3)?.after).toEqual([1, 2]);
		expect(byId(both, 3)?.waitingFor).toBeUndefined();
		// Stuck or on hold, a task still holds back the ones after it.
		const stuck = replay(entries([...base, { op: "start", id: 1, lane: true }, { op: "stuck", id: 1, question: "?" }]));
		expect(byId(stuck, 3)?.waitingFor).toEqual([1, 2]);
		// update: replaced when given, [] clears it, kept when not; never the task itself.
		const upd = (more: Record<string, unknown>) =>
			byId(replay(entries([...base, { op: "update", id: 3, plan: plan("C2"), ...more }])), 3);
		expect(upd({})?.after).toEqual([1, 2]);
		expect(upd({ after: [2, 3] })?.after).toEqual([2]);
		expect(upd({ after: [] })?.after).toBeUndefined();
		expect(upd({ after: [] })?.waitingFor).toBeUndefined();
		// A task's own chat keeps it too.
		const own = replay(
			entries([
				{ op: "assigned", id: 5, plan: plan("Five"), touches: ["a"], after: [3], from: { file: "/s/q.jsonl" } },
			]),
		);
		expect(own.tasks[0].after).toEqual([3]);
		expect(normAfter([3, "#4", " 5 ", 3, 0, -1, 2.5, "x", 7], 7)).toEqual([3, 4, 5]);
		expect(normAfter("3")).toBeUndefined();
	});

	it("reads the shareable list from pi-queue's settings file, again only when it changes", () => {
		const dir = mkdtempSync(join(tmpdir(), "queue-shareable-"));
		try {
			const file = join(dir, "pi-queue.json");
			const none = taskQueueShareableFrom(file);
			expect(none.patterns).toEqual(["* repo", "pi-web-deploy"]);
			writeFileSync(file, JSON.stringify({ lanes: 3, shareable: ["* repo", "temper-deploy"] }));
			const set = taskQueueShareableFrom(file);
			expect(set.patterns).toEqual(["* repo", "temper-deploy"]);
			expect(set.stamp).not.toBe(none.stamp);
			expect(taskQueueShareableFrom(file)).toBe(set);
			writeFileSync(file, "{ half written");
			expect(taskQueueShareableFrom(file).patterns).toEqual(["* repo", "pi-web-deploy"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// The Queue tab must show what pi-queue will do: replay the same queues through pi-queue's own queue.ts.
	it("draws the same lanes and the same 'after' as pi-queue itself", async () => {
		const pkg = process.env.PI_QUEUE_PKG ?? join(userInfo().homedir, "projects", "pi-queue");
		const file = join(pkg, "queue.ts");
		if (!existsSync(file)) throw new Error(`pi-queue not found at ${pkg} (set PI_QUEUE_PKG)`);
		const pq = await import(/* @vite-ignore */ pathToFileURL(file).href);
		const patternSets: string[][] = [["* repo", "pi-web-deploy"], [], ["temper-*", "scheduler"]];
		const scenarios: Array<Array<Record<string, unknown>>> = [
			TODAY.map(([id, touches]) => ({ op: "add", id, plan: plan(`Task ${id}`), touches })),
			[
				...TODAY.map(([id, touches]) => ({ op: "add", id, plan: plan(`Task ${id}`), touches })),
				{ op: "update", id: 33, plan: plan("Task 33"), after: [32] },
				{ op: "run" },
				{ op: "start", id: 29, lane: true },
				{ op: "done", id: 29, summary: "ok" },
				{ op: "start", id: 32, lane: true },
				{ op: "stuck", id: 32, question: "?" },
			],
			[
				{ op: "add", id: 1, plan: plan("Old") },
				{ op: "add", id: 2, plan: plan("A"), touches: ["a", "x repo"] },
				{ op: "add", id: 3, plan: plan("B"), touches: ["b", "x repo"], after: [2, "#9"] },
				{ op: "add", id: 4, plan: plan("AB"), touches: ["a", "b"] },
				{ op: "add", id: 5, plan: plan("None"), touches: [], after: [4] },
				{ op: "add", id: 6, plan: plan("T"), touches: ["temper-deploy", "scheduler"] },
				{ op: "add", id: 7, plan: plan("U"), touches: ["temper-deploy"], after: [6, 5] },
				{ op: "run" },
				{ op: "start", id: 2, lane: true },
				{ op: "remove", id: 4 },
				{ op: "start", id: 6, lane: true },
				{ op: "wait", id: 6, what: "CI", check: "false", everyMs: 60_000, until: 9e12 },
				{ op: "update", id: 7, plan: plan("U2"), after: [] },
			],
		];
		for (const ops of scenarios) {
			const e = entries(ops);
			for (const patterns of patternSets) {
				const mine = taskQueueFromEntries(e, true, TASK_QUEUE_MAX_DONE, patterns);
				const s = pq.replay(e);
				const theirs = pq.lanesOf(s, true, pq.shareableOf(patterns)) as Array<{
					n: number;
					tasks: Array<{ id: number }>;
					touches: string[];
					alone: boolean;
				}>;
				const open = s.tasks.filter((t: { status: string }) => t.status !== "done" && t.status !== "removed");
				expect(mine.lanes ?? []).toEqual(
					theirs.map((l) => ({ n: l.n, touches: l.touches, alone: l.alone, taskIds: l.tasks.map((t) => t.id) })),
				);
				for (const t of open as Array<{ id: number; after?: number[] }>) {
					const deps = (pq.openDeps(s, t) as Array<{ id: number }>).map((d) => d.id);
					expect(byId(mine, t.id)?.after, `#${t.id} after`).toEqual(t.after);
					expect(byId(mine, t.id)?.waitingFor ?? [], `#${t.id} waiting for`).toEqual(deps);
				}
			}
		}
		// The settings read the same way, and touches and "after" lists are cleaned the same way.
		for (const settings of [undefined, {}, { shareable: "x" }, { shareable: [" A *", 3, "b"] }, { shareable: [] }]) {
			expect(taskQueueShareableSetting(settings)).toEqual(pq.shareableSetting(settings));
		}
		expect([...TASK_QUEUE_DEFAULT_SHAREABLE]).toEqual([...pq.DEFAULT_SHAREABLE]);
		const touches = ["pi-web-ui repo", "repo", "x.repo", "pi-web-deploy", "temper-deploy", "a.b (x) y", "axb (x) y"];
		for (const patterns of [...patternSets, ["a.b (x) *"]]) {
			const a = taskQueueShareableOf(patterns);
			const b = pq.shareableOf(patterns);
			expect(touches.map((t) => a(t))).toEqual(touches.map((t) => b(t)));
		}
		const raw = [3, "#4", " 5 ", 3, 0, -1, 2.5, "x", 7];
		expect(normAfter(raw, 7)).toEqual(pq.normAfter(raw, 7));
	});
});

/** queue-main-chat: pi-queue's "ask" op (a task in a chat of its own asked its main chat). */
describe("taskQueueFromEntries (queue-main-chat)", () => {
	const byId = (q: ReturnType<typeof replay>, id: number) => q.tasks.find((t) => t.id === id);
	const laneBase = [
		{ op: "add", id: 1, plan: plan("One") },
		{ op: "add", id: 2, plan: plan("Two") },
		{ op: "run" },
		{ op: "start", id: 1, lane: true },
		{ op: "chat", id: 1, file: "/chats/one.jsonl", title: "Queue #1: One" },
	];
	const ask = { op: "ask", id: 1, question: "Which port?", choices: ["8080", "9090"], n: 1 };

	it("an ask makes the task 'asking' with its question and choices; nothing else changes", () => {
		const q = replay(entries([...laneBase, ask]));
		expect(byId(q, 1)).toMatchObject({ status: "asking", question: "Which port?", choices: ["8080", "9090"] });
		expect(byId(q, 1)?.mainAnswered).toBeUndefined();
		expect(byId(q, 2)?.status).toBe("ready");
		// Still an open task in its lane.
		expect(q.lanes?.flatMap((l) => l.taskIds)).toContain(1);
	});

	it("refuses an ask without a number or time, or for a task not started", () => {
		for (const bad of [{ n: 0 }, { n: "1" }, { ts: 0 }]) {
			expect(byId(replay(entries([...laneBase, { ...ask, ...bad }])), 1)?.status).toBe("working");
		}
		expect(byId(replay(entries([...laneBase, { ...ask, id: 2 }])), 2)?.status).toBe("ready");
	});

	it("in a task's own chat the asking task stays the current one", () => {
		const own = [
			{ op: "add", id: 7, plan: plan("Seven") },
			{ op: "start", id: 7 },
			{ ...ask, id: 7 },
		];
		const q = replay(entries(own));
		expect(byId(q, 7)?.status).toBe("asking");
		// A second task can't start beside it, the same as beside a stuck one.
		const second = replay(entries([...own, { op: "add", id: 8, plan: plan("Eight") }, { op: "start", id: 8 }]));
		expect(byId(second, 8)?.status).toBe("ready");
	});

	it("the main chat's answer (resume with answered) is marked; the user's own answer isn't", () => {
		const main = replay(entries([...laneBase, ask, { op: "resume", id: 1, answered: 1 }]));
		expect(byId(main, 1)).toMatchObject({ status: "working", mainAnswered: true });
		expect(byId(main, 1)?.question).toBeUndefined();
		expect(byId(main, 1)?.choices).toBeUndefined();
		const owner = replay(entries([...laneBase, ask, { op: "resume", id: 1 }]));
		expect(byId(owner, 1)?.mainAnswered).toBeUndefined();
		// Passed on to the user (stuck), asked again, on hold or done: the mark goes.
		for (const next of [
			{ op: "stuck", id: 1, question: "Port?" },
			{ ...ask, n: 2 },
			{ op: "wait", id: 1, what: "CI", check: "false", everyMs: 60_000, until: 9e12 },
			{ op: "done", id: 1, summary: "ok" },
		]) {
			const q = replay(entries([...laneBase, ask, { op: "resume", id: 1, answered: 1 }, next]));
			expect(byId(q, 1)?.mainAnswered, next.op).toBeUndefined();
		}
	});

	it("a question passed on to the user is stuck as before, with the main chat's wording", () => {
		const q = replay(
			entries([
				...laneBase,
				ask,
				{
					op: "stuck",
					id: 1,
					question: "Port 8080 or 9090?",
					choices: ["8080 (recommended)", "9090"],
					ask: { n: 1, at: 5, passed: true },
				},
			]),
		);
		expect(byId(q, 1)).toMatchObject({
			status: "stuck",
			question: "Port 8080 or 9090?",
			choices: ["8080 (recommended)", "9090"],
		});
	});

	it("says the same as pi-queue's own replay", async () => {
		const pkg = process.env.PI_QUEUE_PKG ?? join(userInfo().homedir, "projects", "pi-queue");
		const file = join(pkg, "queue.ts");
		if (!existsSync(file)) throw new Error(`pi-queue not found at ${pkg} (set PI_QUEUE_PKG)`);
		const pq = await import(/* @vite-ignore */ pathToFileURL(file).href);
		// An older pi-queue has no asking state yet: nothing to compare.
		if (typeof pq.normAsk !== "function") return;
		const scenarios: Array<Array<Record<string, unknown>>> = [
			[...laneBase, ask],
			[...laneBase, ask, { op: "resume", id: 1, answered: 1 }],
			[...laneBase, ask, { op: "stuck", id: 1, question: "Port?", choices: ["a", "b"], ask: { n: 1, at: 9 } }],
			[...laneBase, ask, { op: "resume", id: 1 }, { ...ask, n: 2, question: "Again?" }],
			[...laneBase, { ...ask, n: 0 }, { ...ask, id: 2 }],
			[
				{ op: "add", id: 7, plan: plan("Seven") },
				{ op: "start", id: 7 },
				{ ...ask, id: 7 },
				{ op: "remove", id: 7 },
			],
			[
				{ op: "add", id: 7, plan: plan("Seven") },
				{ op: "start", id: 7 },
				{ ...ask, id: 7 },
				{ op: "done", id: 7 },
			],
		];
		for (const ops of scenarios) {
			const e = entries(ops);
			const mine = taskQueueFromEntries(e, true);
			const s = pq.replay(e) as {
				tasks: Array<{ id: number; status: string; question?: string; choices?: string[]; answered?: number }>;
			};
			const theirs = s.tasks.filter((t) => t.status !== "removed");
			expect(mine.tasks.map((t) => [t.id, t.status, t.question, t.choices])).toEqual(
				theirs.map((t) => [t.id, t.status, t.question, t.choices]),
			);
		}
	});
});

describe("taskQueueFromEntries (queue-blocked)", () => {
	const byId = (q: ReturnType<typeof replay>, id: number) => q.tasks.find((t) => t.id === id);
	const laneBase = [
		{ op: "add", id: 1, plan: plan("One"), touches: ["a"] },
		{ op: "add", id: 2, plan: plan("Two"), touches: ["b"] },
		{ op: "run" },
		{ op: "start", id: 1, lane: true },
		{ op: "chat", id: 1, file: "/chats/one.jsonl", title: "Queue #1: One" },
	];
	const ref = { file: "/chats/temper.jsonl", name: "temper", id: 38 };
	const block = { op: "block", id: 1, on: [ref], need: "  the staging   login ", start: 0, tries: 0 };

	it("a block makes the task 'blocked' with what it waits on; it keeps its lane", () => {
		const q = replay(entries([...laneBase, block]));
		const t = byId(q, 1);
		expect(t?.status).toBe("blocked");
		expect(t?.block).toMatchObject({ on: [ref], need: "the staging login", tries: 0 });
		expect(t?.block?.start).toBe(0);
		expect(q.lanes?.flatMap((l) => l.taskIds)).toContain(1);
	});

	it("refuses a block for a task not being worked on, not in a chat of its own, or with nothing to wait on", () => {
		expect(byId(replay(entries([...laneBase, { ...block, id: 2 }])), 2)?.status).toBe("ready");
		expect(byId(replay(entries([...laneBase, { ...block, on: [], need: " " }])), 1)?.status).toBe("working");
		const inChat = [
			{ op: "add", id: 3, plan: plan("Three") },
			{ op: "run" },
			{ op: "start", id: 3 },
			{ ...block, id: 3 },
		];
		expect(byId(replay(entries(inChat)), 3)?.status).toBe("working");
	});

	it("a poke is recorded once, for the same block only; any status change ends the block", () => {
		const e = entries([...laneBase, block]);
		const since = (e.at(-1)?.data as { ts: number }).ts;
		const poked = replay([...e, ...entries([{ op: "poke", id: 1, since, note: "x" }])]);
		expect(byId(poked, 1)?.block?.poke?.at).toBeGreaterThan(0);
		const wrong = replay([...e, ...entries([{ op: "poke", id: 1, since: since + 1, note: "x" }])]);
		expect(byId(wrong, 1)?.block?.poke).toBeUndefined();
		for (const next of [
			{ op: "resume", id: 1 },
			{ op: "done", id: 1, summary: "ok" },
			{ op: "stuck", id: 1, question: "?" },
		]) {
			const q = replay([...e, ...entries([next])]);
			expect(byId(q, 1)?.block, next.op).toBeUndefined();
		}
	});

	it("outside after: kept with after, and recorded over by after_over", () => {
		const add = [{ op: "add", id: 4, plan: plan("Four"), outside: [ref, ref, { file: "", id: 1 }] }];
		const q = replay(entries(add));
		expect(byId(q, 4)?.outside).toEqual([ref]);
		const over = replay(entries([...add, { op: "after_over", id: 4, file: ref.file, n: 38, removed: true }]));
		expect(byId(over, 4)?.outside?.[0].over).toMatchObject({ removed: true });
		// An update without after keeps it; with after it's replaced (and [] with no outside clears it).
		expect(byId(replay(entries([...add, { op: "update", id: 4, plan: plan("Four") }])), 4)?.outside).toEqual([ref]);
		expect(
			byId(replay(entries([...add, { op: "update", id: 4, plan: plan("Four"), after: [] }])), 4)?.outside,
		).toBeUndefined();
	});

	it("says the same as pi-queue's own replay", async () => {
		const pkg = process.env.PI_QUEUE_PKG ?? join(userInfo().homedir, "projects", "pi-queue");
		const file = join(pkg, "queue.ts");
		if (!existsSync(file)) throw new Error(`pi-queue not found at ${pkg} (set PI_QUEUE_PKG)`);
		const pq = await import(/* @vite-ignore */ pathToFileURL(file).href);
		// An older pi-queue has no blocked state yet: nothing to compare.
		if (typeof pq.blockVerdict !== "function") return;
		const scenarios: Array<Array<Record<string, unknown>>> = [
			[...laneBase, block],
			[...laneBase, block, { op: "resume", id: 1 }],
			[...laneBase, block, { op: "resume", id: 1 }, { ...block, need: "other" }],
			[...laneBase, { ...block, id: 2 }, { ...block, on: [], need: "" }],
			[...laneBase, block, { op: "done", id: 1, summary: "ok" }],
			[...laneBase, block, { op: "remove", id: 1 }],
			[...laneBase, block, { op: "ask", id: 1, question: "?", n: 1 }],
			[
				{ op: "add", id: 4, plan: plan("Four"), outside: [ref] },
				{ op: "after_over", id: 4, file: ref.file, n: 38, summary: "s" },
			],
			[
				{ op: "add", id: 4, plan: plan("Four"), outside: [ref] },
				{ op: "update", id: 4, plan: plan("4"), after: [] },
			],
		];
		for (const ops of scenarios) {
			const e = entries(ops);
			const mine = taskQueueFromEntries(e, true);
			const s = pq.replay(e) as {
				tasks: Array<{
					id: number;
					status: string;
					block?: { on?: unknown[]; need?: string; since: number; start: number; tries: number };
					outside?: Array<{ file: string; id: number; over?: { removed?: boolean } }>;
				}>;
			};
			const theirs = s.tasks.filter((t) => t.status !== "removed");
			const shape = (t: (typeof theirs)[number] | (typeof mine.tasks)[number]) => [
				t.id,
				t.status,
				t.block ? [t.block.on ?? null, t.block.need ?? null, t.block.since, t.block.start, t.block.tries] : null,
				(t.outside ?? []).map((o) => [o.file, o.id, !!o.over, o.over?.removed ?? false]),
			];
			expect(mine.tasks.map(shape), JSON.stringify(ops.at(-1))).toEqual(theirs.map(shape));
		}
	});
});

/** queue-paused: the owner's pause on a task or the whole queue (pi-queue's "hold" and "release" ops). */
describe("taskQueueFromEntries (queue-paused)", () => {
	const byId = (q: ReturnType<typeof replay>, id: number) => q.tasks.find((t) => t.id === id);
	const laneBase = [
		{ op: "add", id: 1, plan: plan("One"), touches: ["a"] },
		{ op: "add", id: 2, plan: plan("Two"), touches: ["b"] },
		{ op: "run" },
		{ op: "start", id: 1, lane: true },
		{ op: "chat", id: 1, file: "/chats/one.jsonl", title: "Queue #1: One" },
	];
	const wait = { op: "wait", id: 1, what: "CI", check: "false", everyMs: 60_000, until: 50_000, ts: 10_000 };
	const hold = (id: number | undefined, ts: number, why = "owner on Telegram: pause it") => ({
		op: "hold",
		...(id !== undefined ? { id } : {}),
		why,
		by: "tool",
		ts,
	});
	const release = (id: number | undefined, ts: number) => ({ op: "release", ...(id !== undefined ? { id } : {}), ts });

	it("a pause is a layer on the task: it keeps its status, and shows since when and why", () => {
		const q = replay(entries([...laneBase, wait, hold(1, 20_000, "  owner:   keep quiet ")]));
		expect(byId(q, 1)).toMatchObject({ status: "waiting", hold: { at: 20_000, why: "owner:   keep quiet" } });
		expect(byId(q, 1)?.wait?.until).toBe(50_000);
		expect(byId(q, 2)?.hold).toBeUndefined();
		expect(q.hold).toBeUndefined();
		// The mirror's own bookkeeping doesn't reach the UI.
		expect(byId(q, 1)).not.toHaveProperty("heldFrom");
		const back = replay(entries([...laneBase, wait, hold(1, 20_000), release(1, 35_000)]));
		expect(byId(back, 1)?.status).toBe("waiting");
		expect(byId(back, 1)?.hold).toBeUndefined();
	});

	it("the pause doesn't count: a wait gives up as much later as it was paused", () => {
		const q = replay(entries([...laneBase, wait, hold(1, 20_000), release(1, 35_000)]));
		expect(byId(q, 1)?.wait?.until).toBe(65_000);
		// Paused before the wait began (the wait came while paused): only the time since the wait counts.
		const early = replay(entries([...laneBase, hold(1, 5_000), { ...wait, ts: 10_000 }, release(1, 30_000)]));
		expect(byId(early, 1)?.wait?.until).toBe(70_000);
	});

	it("an unpoked block's pokes count from the release", () => {
		const block = { op: "block", id: 1, need: "the staging login", start: 0, tries: 0, ts: 10_000 };
		const q = replay(entries([...laneBase, block, hold(1, 20_000), release(1, 40_000)]));
		expect(byId(q, 1)?.status).toBe("blocked");
		expect(byId(q, 1)?.block?.start).toBe(40_000);
	});

	it("the whole queue: every open task is paused; a task paused on its own stays paused after the queue's resume", () => {
		const ops = [...laneBase, wait, hold(undefined, 20_000, "queue why"), hold(1, 25_000, "task why")];
		const both = replay(entries(ops));
		expect(both.hold).toEqual({ at: 20_000, why: "queue why" });
		expect(byId(both, 1)?.hold).toEqual({ at: 25_000, why: "task why" });
		const queueBack = replay(entries([...ops, release(undefined, 30_000)]));
		expect(queueBack.hold).toBeUndefined();
		expect(byId(queueBack, 1)?.hold).toEqual({ at: 25_000, why: "task why" });
		// Still paused: the wait hasn't moved yet.
		expect(byId(queueBack, 1)?.wait?.until).toBe(50_000);
		// Lifting the task's own pause counts the whole time from the queue's pause on.
		const allBack = replay(entries([...ops, release(undefined, 30_000), release(1, 40_000)]));
		expect(byId(allBack, 1)?.hold).toBeUndefined();
		expect(byId(allBack, 1)?.wait?.until).toBe(70_000);
	});

	it("pausing again keeps since when, with the new why; done or removed ends a pause", () => {
		const again = replay(entries([...laneBase, hold(1, 20_000, "a"), hold(1, 30_000, "b")]));
		expect(byId(again, 1)?.hold).toEqual({ at: 20_000, why: "b" });
		const done = replay(entries([...laneBase, hold(1, 20_000), { op: "done", id: 1, summary: "ok" }]));
		expect(byId(done, 1)?.status).toBe("done");
		expect(byId(done, 1)?.hold).toBeUndefined();
		// A ready task can be paused too, and keeps its pause when it's moved.
		const ready2 = replay(entries([...laneBase, hold(2, 20_000), { op: "move", id: 2, index: 0 }]));
		expect(byId(ready2, 2)).toMatchObject({ status: "ready", hold: { at: 20_000 } });
	});

	it("ignores a pause without a why, for a finished or unknown task, and a resume with nothing paused", () => {
		expect(byId(replay(entries([...laneBase, hold(1, 20_000, "   ")])), 1)?.hold).toBeUndefined();
		const done = [...laneBase, { op: "done", id: 1, summary: "ok" }];
		expect(byId(replay(entries([...done, hold(1, 20_000)])), 1)?.hold).toBeUndefined();
		const unknown = replay(entries([...laneBase, hold(9, 20_000)]));
		expect(unknown.hold).toBeUndefined();
		expect(unknown.tasks.every((t) => !t.hold)).toBe(true);
		const stray = replay(entries([...laneBase, wait, release(1, 30_000), release(undefined, 30_000)]));
		expect(byId(stray, 1)?.wait?.until).toBe(50_000);
		// A task's pause isn't lifted by the queue's resume, nor the queue's by a task's.
		const mixed = replay(entries([...laneBase, hold(undefined, 20_000), release(1, 30_000)]));
		expect(mixed.hold).toMatchObject({ at: 20_000 });
	});

	it("a task waiting on a paused task of its own queue shows that it's paused", () => {
		const ops = [
			{ op: "add", id: 1, plan: plan("One"), touches: ["a"] },
			{ op: "add", id: 2, plan: plan("Two"), touches: ["b"] },
			{ op: "run" },
			{ op: "start", id: 1, lane: true },
			{ op: "chat", id: 1, file: "/chats/one.jsonl", title: "Queue #1: One" },
			{ op: "start", id: 2, lane: true },
			{ op: "chat", id: 2, file: "/chats/two.jsonl", title: "Queue #2: Two" },
			{ op: "block", id: 2, on: [{ file: "/chats/main.jsonl", id: 1 }], start: 0, tries: 0 },
		];
		const before = replay(entries(ops));
		expect(byId(before, 2)?.block?.on?.[0]).toMatchObject({ id: 1, status: "working" });
		expect(byId(before, 2)?.block?.on?.[0]?.held).toBeUndefined();
		const paused = replay(entries([...ops, hold(1, 20_000)]));
		expect(byId(paused, 2)?.block?.on?.[0]).toMatchObject({ id: 1, status: "working", held: true });
		const whole = replay(entries([...ops, hold(undefined, 20_000)]));
		expect(byId(whole, 2)?.block?.on?.[0]?.held).toBe(true);
	});

	it("says the same as pi-queue's own replay", async () => {
		const pkg = process.env.PI_QUEUE_PKG ?? join(userInfo().homedir, "projects", "pi-queue");
		const file = join(pkg, "queue.ts");
		if (!existsSync(file)) throw new Error(`pi-queue not found at ${pkg} (set PI_QUEUE_PKG)`);
		const pq = await import(/* @vite-ignore */ pathToFileURL(file).href);
		// An older pi-queue has no pause yet: nothing to compare.
		if (typeof pq.heldBy !== "function") return;
		const block = { op: "block", id: 1, need: "the staging login", start: 0, tries: 0, ts: 10_000 };
		const scenarios: Array<Array<Record<string, unknown>>> = [
			[...laneBase, wait, hold(1, 20_000)],
			[...laneBase, wait, hold(1, 20_000), release(1, 35_000)],
			[...laneBase, hold(1, 5_000), wait, release(1, 30_000)],
			[...laneBase, wait, hold(undefined, 20_000), hold(1, 25_000), release(undefined, 30_000)],
			[...laneBase, wait, hold(undefined, 20_000), hold(1, 25_000), release(undefined, 30_000), release(1, 40_000)],
			[...laneBase, block, hold(1, 20_000), release(1, 40_000)],
			[...laneBase, block, hold(undefined, 20_000), release(undefined, 40_000)],
			[...laneBase, hold(1, 20_000, "a"), hold(1, 30_000, "b")],
			[...laneBase, hold(1, 20_000), { op: "done", id: 1, summary: "ok" }],
			[...laneBase, hold(1, 20_000, " "), hold(9, 20_000), release(undefined, 25_000)],
			[...laneBase, hold(undefined, 20_000), { op: "add", id: 3, plan: plan("Three") }, release(undefined, 30_000)],
			[...laneBase, hold(2, 20_000), { op: "start", id: 2, lane: true }, release(2, 30_000)],
		];
		type Theirs = {
			hold?: { at: number; why: string };
			tasks: Array<{
				id: number;
				status: string;
				hold?: { at: number; why: string };
				wait?: { until: number };
				block?: { start: number };
			}>;
		};
		const holdOf = (h: { at: number; why: string } | undefined) => (h ? [h.at, h.why] : null);
		for (const ops of scenarios) {
			const e = entries(ops);
			const mine = taskQueueFromEntries(e, true);
			const s = pq.replay(e) as Theirs;
			const theirs = s.tasks.filter((t) => t.status !== "removed");
			const shape = (t: Theirs["tasks"][number] | (typeof mine.tasks)[number]) => [
				t.id,
				t.status,
				holdOf(t.hold),
				t.wait?.until ?? null,
				t.block?.start ?? null,
			];
			const what = JSON.stringify(ops.slice(laneBase.length));
			expect(mine.tasks.map(shape), what).toEqual(theirs.map(shape));
			expect(holdOf(mine.hold), what).toEqual(holdOf(s.hold));
		}
	});
});

/** queue-why: a waiting task's open afters, with how each stands, so the panel can say why it can't start. */
describe("taskQueueFromEntries (queue-why)", () => {
	const byId = (q: ReturnType<typeof replay>, id: number) => q.tasks.find((t) => t.id === id);
	const chat = (id: number) => ({ op: "chat", id, file: `/chats/${id}.jsonl`, title: `Queue #${id}` });
	/** #1-#7 in every state there is, and #9 after all of them. */
	const states = [
		{ op: "add", id: 1, plan: plan("Working"), touches: ["a"] },
		{ op: "add", id: 2, plan: plan("Not started"), touches: ["b"] },
		{ op: "add", id: 3, plan: plan("On hold"), touches: ["c"] },
		{ op: "add", id: 4, plan: plan("Blocked"), touches: ["d"] },
		{ op: "add", id: 5, plan: plan("Needs you"), touches: ["e"] },
		{ op: "add", id: 6, plan: plan("Asking"), touches: ["f"] },
		{ op: "add", id: 7, plan: plan("Done"), touches: ["g"] },
		{ op: "add", id: 9, plan: plan("Waits"), touches: ["h"], after: [1, 2, 3, 4, 5, 6, 7] },
		{ op: "run" },
		...[1, 3, 4, 5, 6, 7].flatMap((id) => [{ op: "start", id, lane: true }, chat(id)]),
		{ op: "wait", id: 3, what: "CI", check: "false", everyMs: 60_000, until: 9e12 },
		{ op: "block", id: 4, need: "the staging login", start: 0, tries: 0 },
		{ op: "stuck", id: 5, question: "Which port?", choices: ["8080", "9090"] },
		{ op: "ask", id: 6, n: 1, question: "Which branch?" },
		{ op: "done", id: 7, summary: "ok" },
	];
	const hold = (id?: number) => ({
		op: "hold",
		...(id !== undefined ? { id } : {}),
		why: "owner: not now",
		by: "panel",
	});
	const release = (id?: number) => ({ op: "release", ...(id !== undefined ? { id } : {}) });

	it("a waiting task's open afters come with how each stands (status, title, chat), in queue order", () => {
		const q = replay(entries(states));
		const nine = byId(q, 9);
		expect(nine?.waitingFor).toEqual([1, 2, 3, 4, 5, 6]);
		expect(nine?.waitingForRefs).toEqual([
			{
				file: "",
				name: "",
				id: 1,
				status: "working",
				title: "Working",
				chat: { file: "/chats/1.jsonl", title: "Queue #1" },
			},
			{ file: "", name: "", id: 2, status: "ready", title: "Not started" },
			{
				file: "",
				name: "",
				id: 3,
				status: "waiting",
				title: "On hold",
				chat: { file: "/chats/3.jsonl", title: "Queue #3" },
			},
			{
				file: "",
				name: "",
				id: 4,
				status: "blocked",
				title: "Blocked",
				chat: { file: "/chats/4.jsonl", title: "Queue #4" },
			},
			{
				file: "",
				name: "",
				id: 5,
				status: "stuck",
				title: "Needs you",
				chat: { file: "/chats/5.jsonl", title: "Queue #5" },
			},
			{
				file: "",
				name: "",
				id: 6,
				status: "asking",
				title: "Asking",
				chat: { file: "/chats/6.jsonl", title: "Queue #6" },
			},
		]);
		// None of them is paused, and the tasks that wait on nothing have none.
		expect(nine?.waitingForRefs?.some((r) => r.held)).toBe(false);
		for (const t of q.tasks) if (t.id !== 9) expect(t.waitingForRefs, `#${t.id}`).toBeUndefined();
		// Once they're all over, nothing is left to wait for.
		const over = replay(entries([...states, ...[1, 2, 3, 4, 5, 6].map((id) => ({ op: "remove", id }))]));
		expect(byId(over, 9)?.waitingFor).toBeUndefined();
		expect(byId(over, 9)?.waitingForRefs).toBeUndefined();
	});

	it("paused by the owner: through the task's own pause, and through the whole queue's", () => {
		const own = byId(replay(entries([...states, hold(5), hold(2)])), 9)?.waitingForRefs;
		expect(own?.filter((r) => r.held).map((r) => [r.id, r.status])).toEqual([
			[2, "ready"],
			[5, "stuck"],
		]);
		const whole = byId(replay(entries([...states, hold()])), 9)?.waitingForRefs;
		expect(whole?.every((r) => r.held === true)).toBe(true);
		// Resumed: no longer paused.
		const back = byId(replay(entries([...states, hold(), hold(2), release(), release(2)])), 9)?.waitingForRefs;
		expect(back?.some((r) => r.held)).toBe(false);
		// The queue's resume leaves #2's own pause.
		const still = byId(replay(entries([...states, hold(), hold(2), release()])), 9)?.waitingForRefs;
		expect(still?.filter((r) => r.held).map((r) => r.id)).toEqual([2]);
	});

	it("not in a task's own chat (it has only its task)", () => {
		const own = replay(
			entries([
				{ op: "assigned", id: 5, plan: plan("Five"), touches: ["a"], after: [3], from: { file: "/s/q.jsonl" } },
			]),
		);
		expect(own.tasks[0].after).toEqual([3]);
		expect(own.tasks[0].waitingForRefs).toBeUndefined();
	});

	it("keeps when a task started needing the user, as pi-queue does, without showing it", async () => {
		const base = [
			{ op: "add", id: 1, plan: plan("One"), touches: ["a"] },
			{ op: "run" },
			{ op: "start", id: 1, lane: true },
		];
		const stuck = (question: string, ts: number) => ({ op: "stuck", id: 1, question, choices: ["a", "b"], ts });
		const stuckAt = (ops: Array<Record<string, unknown>>) => taskQueueAll(entries(ops)).tasks[0].stuckAt;
		expect(stuckAt([...base, stuck("Which port?", 5_000)])).toBe(5_000);
		// The same question again: since the first time. Another question, or after an answer: anew.
		expect(stuckAt([...base, stuck("Which port?", 5_000), stuck("Which port?", 9_000)])).toBe(5_000);
		expect(stuckAt([...base, stuck("Which port?", 5_000), stuck("Which host?", 9_000)])).toBe(9_000);
		const answered = [...base, stuck("Which port?", 5_000), { op: "resume", id: 1, ts: 7_000 }];
		expect(stuckAt([...answered, stuck("Which port?", 9_000)])).toBe(9_000);
		expect(replay(entries([...base, stuck("Which port?", 5_000)])).tasks[0]).not.toHaveProperty("stuckAt");
		const pkg = process.env.PI_QUEUE_PKG ?? join(userInfo().homedir, "projects", "pi-queue");
		const file = join(pkg, "queue.ts");
		if (!existsSync(file)) throw new Error(`pi-queue not found at ${pkg} (set PI_QUEUE_PKG)`);
		const pq = await import(/* @vite-ignore */ pathToFileURL(file).href);
		const scenarios = [
			[...base, stuck("Which port?", 5_000)],
			[...base, stuck("Which port?", 5_000), stuck("Which port?", 9_000)],
			[...base, stuck("Which port?", 5_000), stuck("Which host?", 9_000)],
			[...answered, stuck("Which port?", 9_000)],
			[...answered, { op: "wait", id: 1, what: "CI", check: "false", everyMs: 60_000, until: 9e12, ts: 8_000 }],
		];
		for (const ops of scenarios) {
			const e = entries(ops);
			const theirs = (pq.replay(e) as { tasks: Array<{ stuckAt?: number }> }).tasks[0].stuckAt;
			expect(taskQueueAll(e).tasks[0].stuckAt, JSON.stringify(ops.slice(base.length))).toEqual(theirs);
		}
	});
});

describe("taskQueueCommandLine", () => {
	it("queue-paused: the owner's Pause and Resume, on a task or the whole queue", () => {
		const why = Buffer.from("pressed Pause in the Queue panel", "utf8").toString("base64url");
		expect(taskQueueCommandLine("pause", 3)).toBe(`/queue pause 3 ${why}`);
		expect(taskQueueCommandLine("pause", undefined)).toBe(`/queue pause ${why}`);
		expect(taskQueueCommandLine("resume", 3)).toBe("/queue resume 3");
		expect(taskQueueCommandLine("resume", undefined)).toBe("/queue resume");
		expect(taskQueueCommandLine("pause", "3; rm -rf /")).toBeNull();
		expect(taskQueueCommandLine("resume", -1)).toBeNull();
		expect(taskQueueCommandLine("resume", 2.5)).toBeNull();
	});

	it("queue-lanes: sets how many lanes run at once", () => {
		expect(taskQueueCommandLine("lanes", 3)).toBe("/queue lanes 3");
		expect(taskQueueCommandLine("lanes", 8)).toBe("/queue lanes 8");
		expect(taskQueueCommandLine("lanes", 9)).toBeNull();
		expect(taskQueueCommandLine("lanes", 0)).toBeNull();
		expect(taskQueueCommandLine("lanes", undefined)).toBeNull();
		expect(taskQueueCommandLine("lanes", "2")).toBeNull();
	});

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
