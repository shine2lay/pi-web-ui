/**
 * queue-blocked: server/queue-blocks.ts, the background check for blocked tasks and outside `after`s,
 * and the queue host's queueRefs request check. Queues are made from ops (as pi-queue saves them), the
 * clock is fake; the chats themselves are covered by tests/queue-blocked-test.mjs (sealed E2E).
 */
import { describe, expect, it } from "vitest";
import { parseQueueRefsRequest } from "../../server/queue-host.js";
import {
	blockPokesMs,
	blockVerdict,
	parseTaskRef,
	QueueBlocks,
	type QueueBlocksHost,
	queueBlocksEveryMs,
	RENUDGE_MS,
} from "../../server/queue-blocks.js";
import type { UiTaskQueue } from "../../server/protocol.js";
import { taskQueueFromEntries } from "../../server/task-queue.js";

const MIN = 60_000;
const plan = (title: string) => ({
	title,
	goal: "g",
	doneWhen: "d",
	decided: "x",
	steps: "s",
	verify: "v",
	mustNot: "m",
});
const A = "/s/a.jsonl";
const B = "/s/b.jsonl";
const T = "/s/task-1.jsonl";

class World {
	now = 1_000_000;
	files = new Map<string, Record<string, unknown>[]>();
	versions = new Map<string, number>();
	commands: [string, string][] = [];
	watchSaved: string[] = [];
	changes = 0;
	logs: string[] = [];
	titles: [string, string][] = [];
	roles = [{ id: "temper", homeChat: B }, { id: "docs" }];
	ops(file: string, ...ops: Record<string, unknown>[]) {
		const list = this.files.get(file) ?? [];
		for (const op of ops) list.push({ v: 1, ts: this.now, ...op });
		this.files.set(file, list);
		this.versions.set(file, (this.versions.get(file) ?? 0) + 1);
	}
	host(): QueueBlocksHost {
		return {
			now: () => this.now,
			readQueue: async (f) =>
				this.files.has(f) ? this.files.get(f)!.map((data) => ({ type: "custom", customType: "queue", data })) : null,
			stamp: (f) =>
				this.files.has(f) ? { size: this.files.get(f)!.length, mtimeMs: this.versions.get(f)! } : undefined,
			runCommand: async (f, line) => {
				this.commands.push([f, line]);
				return true;
			},
			roles: () => this.roles,
			titledChats: async () => this.titles,
			sameFile: (a, b) => a === b,
			loadWatch: () => [],
			saveWatch: (f) => {
				this.watchSaved = f;
			},
			changed: () => {
				this.changes++;
			},
			log: (l) => this.logs.push(l),
		};
	}
}

/** Queue B ("temper"): #1 at work, #2 waiting. Queue A: #1 at work in its own chat, #2 waiting. */
function world() {
	const w = new World();
	w.ops(
		B,
		{ op: "add", id: 1, plan: plan("Team runner") },
		{ op: "add", id: 2, plan: plan("Docs") },
		{ op: "start", id: 1, lane: true },
	);
	w.ops(
		A,
		{ op: "add", id: 1, plan: plan("Task 1") },
		{ op: "add", id: 2, plan: plan("Task 2") },
		{ op: "run" },
		{ op: "start", id: 1, lane: true },
		{ op: "chat", id: 1, file: T, title: "Queue #1" },
	);
	const blocks = new QueueBlocks(w.host());
	return { w, blocks };
}
const onB = (id: number) => ({ file: B, name: "temper", id });

/** The Queue panel's copy of a queue made of these ops (the panel is there, so tasks may have chats). */
const panelOf = (ops: readonly Record<string, unknown>[]): UiTaskQueue =>
	taskQueueFromEntries(
		ops.map((data) => ({ type: "custom", customType: "queue", data })),
		true,
	);

describe("parseTaskRef", () => {
	it("reads #12, 12, temper #38 and a queue title with spaces", () => {
		expect(parseTaskRef("#12")).toEqual({ name: "", id: 12 });
		expect(parseTaskRef(12)).toEqual({ name: "", id: 12 });
		expect(parseTaskRef("temper #38")).toEqual({ name: "temper", id: 38 });
		expect(parseTaskRef("  Release   prep #4 ")).toEqual({ name: "Release prep", id: 4 });
		expect(parseTaskRef("temper")).toBeUndefined();
		expect(parseTaskRef("#0")).toBeUndefined();
		expect(parseTaskRef(null)).toBeUndefined();
	});
});

describe("blockVerdict (pi-queue's, mirrored)", () => {
	const look = (m: Record<number, string>) => (r: { id: number }) => ({ status: (m[r.id] ?? "working") as never });
	const b = { since: 100, start: 100, tries: 0 };
	it("waits while a blocker is open, counting the ones that need the user", () => {
		expect(blockVerdict({ ...b, on: [onB(1), onB(2)] }, look({ 1: "stuck", 2: "done" }))).toEqual({
			kind: "wait",
			needsYou: 1,
		});
	});
	it("is due at once when all are done or one was removed", () => {
		expect(blockVerdict({ ...b, on: [onB(1), onB(2)] }, look({ 1: "done", 2: "done" }))).toEqual({
			kind: "due",
			at: 100,
			why: "over",
		});
		expect(blockVerdict({ ...b, on: [onB(1), onB(2)] }, look({ 1: "removed" }))).toEqual({
			kind: "due",
			at: 100,
			why: "over",
		});
	});
	it("pokes a need at start + 10, 30, 60 min, then asks", () => {
		expect(blockVerdict({ ...b, need: "x" }, () => undefined)).toEqual({
			kind: "due",
			at: 100 + 10 * MIN,
			why: "need",
		});
		expect(blockVerdict({ ...b, need: "x", tries: 2, since: 200 }, () => undefined)).toEqual({
			kind: "due",
			at: 100 + 60 * MIN,
			why: "need",
		});
		expect(blockVerdict({ ...b, need: "x", tries: 3, since: 300 }, () => undefined)).toEqual({
			kind: "due",
			at: 300,
			why: "ask",
		});
	});
	it("takes the test schedule only in test mode", () => {
		expect(blockPokesMs({ PI_QUEUE_TEST_BLOCK_POKES_MS: "1,2,3" })).toEqual([10 * MIN, 30 * MIN, 60 * MIN]);
		expect(blockPokesMs({ PI_QUEUE_TEST_FAST: "1", PI_QUEUE_TEST_BLOCK_POKES_MS: "1000,2000,3000" })).toEqual([
			1000, 2000, 3000,
		]);
		expect(queueBlocksEveryMs({})).toBe(60_000);
		expect(queueBlocksEveryMs({ PI_WEB_QUEUE_BLOCKS_MS: "1000" })).toBe(1000);
	});
});

describe("QueueBlocks: the background check", () => {
	it("does nothing while the blocker is worked on; nudges the queue's chat once it's done, and not again within 5 min", async () => {
		const { w, blocks } = world();
		w.ops(A, { op: "block", id: 1, on: [onB(1)], start: w.now, tries: 0 });
		blocks.watchQueue(A);
		expect(w.watchSaved).toEqual([A]);
		for (let i = 0; i < 90; i++) {
			w.now += MIN;
			await blocks.tick();
		}
		expect(w.commands).toEqual([]);
		w.ops(B, { op: "done", id: 1, summary: "Landed" });
		await blocks.tick();
		expect(w.commands).toEqual([[A, "/queue blocks"]]);
		w.now += MIN;
		await blocks.tick();
		expect(w.commands).toHaveLength(1);
		w.now += RENUDGE_MS;
		await blocks.tick();
		expect(w.commands).toHaveLength(2);
		// Once the queue records the poke, it's the queue's turn: no more nudges.
		w.ops(A, { op: "poke", id: 1, since: 1_000_000, note: "over" });
		w.now += RENUDGE_MS + MIN;
		await blocks.tick();
		expect(w.commands).toHaveLength(2);
	});

	it("nudges at once when a blocker is removed; never for one that needs the user", async () => {
		const { w, blocks } = world();
		w.ops(A, { op: "block", id: 1, on: [onB(1)], start: w.now, tries: 0 });
		blocks.watchQueue(A);
		w.ops(B, { op: "stuck", id: 1, question: "Which port?", choices: ["a", "b"] });
		w.now += 120 * MIN;
		await blocks.tick();
		expect(w.commands).toEqual([]);
		const q = panelOf(w.files.get(A)!);
		blocks.enrich(A, q);
		expect(q.tasks[0].block?.on?.[0]).toMatchObject({ name: "temper", id: 1, status: "stuck", title: "Team runner" });
		w.ops(B, { op: "remove", id: 1 });
		await blocks.tick();
		expect(w.commands).toEqual([[A, "/queue blocks"]]);
	});

	it("a need: due at 10, 30 and 60 min from the first block, then the ask; the panel shows the next poke", async () => {
		const { w, blocks } = world();
		const t0 = w.now;
		w.ops(A, { op: "block", id: 1, need: "a login", start: t0, tries: 0 });
		blocks.watchQueue(A);
		w.now = t0 + 9 * MIN;
		await blocks.tick();
		expect(w.commands).toEqual([]);
		const q = panelOf(w.files.get(A)!);
		blocks.enrich(A, q);
		expect(q.tasks[0].block).toMatchObject({ need: "a login", nextPokeAt: t0 + 10 * MIN });
		w.now = t0 + 10 * MIN;
		await blocks.tick();
		expect(w.commands).toHaveLength(1);
		// Poked, back to work, blocked again on the same need (try 2): due at 30 min.
		w.ops(A, { op: "poke", id: 1, since: t0, note: "n" }, { op: "resume", id: 1 });
		w.now = t0 + 11 * MIN;
		w.ops(A, { op: "block", id: 1, need: "a login", start: t0, tries: 1 });
		w.now = t0 + 29 * MIN;
		await blocks.tick();
		expect(w.commands).toHaveLength(1);
		w.now = t0 + 30 * MIN;
		await blocks.tick();
		expect(w.commands).toHaveLength(2);
		// After the third poke, a block on the same thing asks at once.
		w.ops(A, { op: "poke", id: 1, since: t0 + 11 * MIN, note: "n" }, { op: "resume", id: 1 });
		w.now = t0 + 61 * MIN;
		w.ops(A, { op: "block", id: 1, need: "a login", start: t0, tries: 3 });
		const q2 = panelOf(w.files.get(A)!);
		blocks.enrich(A, q2);
		expect(q2.tasks[0].block).toMatchObject({ nextPokeAt: t0 + 61 * MIN, nextIsAsk: true });
		await blocks.tick();
		expect(w.commands).toHaveLength(3);
		expect(w.logs.at(-1)).toMatch(/:ask\)$/);
	});

	it("an outside after: nudges the waiting queue once that task is over; drops queues with nothing left", async () => {
		const { w, blocks } = world();
		w.ops(A, { op: "add", id: 3, plan: plan("After temper"), outside: [onB(2)] });
		const q = panelOf(w.files.get(A)!);
		blocks.enrich(A, q); // the panel showing it starts the watch
		expect(blocks.watched()).toEqual([A]);
		await blocks.tick();
		expect(w.commands).toEqual([]);
		w.ops(B, { op: "start", id: 2 }, { op: "done", id: 2, summary: "Docs written" });
		await blocks.tick();
		expect(w.commands).toEqual([[A, "/queue blocks"]]);
		w.ops(A, { op: "after_over", id: 3, file: B, n: 2, summary: "Docs written" });
		await blocks.tick();
		expect(blocks.watched()).toEqual([]);
		expect(w.watchSaved).toEqual([]);
	});

	it("tells the panels when a blocker's state changes", async () => {
		const { w, blocks } = world();
		w.ops(A, { op: "block", id: 1, on: [onB(1)], start: w.now, tries: 0 });
		blocks.watchQueue(A);
		await blocks.tick();
		const first = w.changes;
		await blocks.tick();
		expect(w.changes).toBe(first);
		w.ops(B, { op: "stuck", id: 1, question: "q", choices: ["a", "b"] });
		await blocks.tick();
		expect(w.changes).toBe(first + 1);
	});
});

/** queue-paused: a task the owner paused, or any task of a queue he paused, is never nudged. */
describe("QueueBlocks: paused by you", () => {
	const hold = (id?: number) => ({
		op: "hold",
		...(id !== undefined ? { id } : {}),
		why: "owner: pause it",
		by: "panel",
	});
	const release = (id?: number) => ({ op: "release", ...(id !== undefined ? { id } : {}) });

	it("a paused task blocked on a need gets no pokes and no ask, however long; after the resume they count from then", async () => {
		const { w, blocks } = world();
		const t0 = w.now;
		w.ops(A, { op: "block", id: 1, need: "a login", start: t0, tries: 0 });
		blocks.watchQueue(A);
		w.now = t0 + 5 * MIN;
		w.ops(A, hold(1));
		for (let i = 0; i < 180; i++) {
			w.now += MIN;
			await blocks.tick();
		}
		expect(w.commands).toEqual([]);
		const q = panelOf(w.files.get(A)!);
		blocks.enrich(A, q);
		expect(q.tasks[0].hold).toMatchObject({ why: "owner: pause it" });
		expect(q.tasks[0].block?.nextPokeAt).toBeUndefined();
		// Still watched, so it carries on once the pause is lifted: the first poke 10 min after the resume.
		expect(blocks.watched()).toEqual([A]);
		const back = w.now;
		w.ops(A, release(1));
		const q2 = panelOf(w.files.get(A)!);
		blocks.enrich(A, q2);
		expect(q2.tasks[0].block?.nextPokeAt).toBe(back + 10 * MIN);
		w.now = back + 9 * MIN;
		await blocks.tick();
		expect(w.commands).toEqual([]);
		w.now = back + 10 * MIN;
		await blocks.tick();
		expect(w.commands).toEqual([[A, "/queue blocks"]]);
	});

	it("a paused queue: a blocker that's done nudges nobody until the queue is resumed", async () => {
		const { w, blocks } = world();
		w.ops(A, { op: "block", id: 1, on: [onB(1)], start: w.now, tries: 0 }, hold());
		blocks.watchQueue(A);
		w.ops(B, { op: "done", id: 1, summary: "Landed" });
		for (let i = 0; i < 30; i++) {
			w.now += MIN;
			await blocks.tick();
		}
		expect(w.commands).toEqual([]);
		w.ops(A, release());
		await blocks.tick();
		expect(w.commands).toEqual([[A, "/queue blocks"]]);
	});

	it("a paused task with an outside after isn't nudged when that task is over", async () => {
		const { w, blocks } = world();
		w.ops(A, { op: "add", id: 3, plan: plan("After temper"), outside: [onB(2)] }, hold(3));
		blocks.watchQueue(A);
		w.ops(B, { op: "start", id: 2 }, { op: "done", id: 2, summary: "Docs written" });
		await blocks.tick();
		expect(w.commands).toEqual([]);
		w.ops(A, release(3));
		await blocks.tick();
		expect(w.commands).toEqual([[A, "/queue blocks"]]);
	});

	it("a paused blocker shows as paused, doesn't count as needs-you, and the panels are told when it's paused", async () => {
		const { w, blocks } = world();
		w.ops(A, { op: "block", id: 1, on: [onB(1)], start: w.now, tries: 0 });
		blocks.watchQueue(A);
		w.ops(B, { op: "stuck", id: 1, question: "Which port?", choices: ["a", "b"] });
		await blocks.tick();
		const first = w.changes;
		w.ops(B, hold(1));
		await blocks.tick();
		expect(w.changes).toBe(first + 1);
		const q = panelOf(w.files.get(A)!);
		blocks.enrich(A, q);
		expect(q.tasks[0].block?.on?.[0]).toMatchObject({ id: 1, status: "stuck", held: true });
		expect(w.commands).toEqual([]);
		const b = { since: 100, start: 100, tries: 0, on: [onB(1), onB(2)] };
		expect(blockVerdict(b, (r) => ({ status: "stuck", ...(r.id === 1 ? { held: true } : {}) }))).toEqual({
			kind: "wait",
			needsYou: 1,
		});
		expect(blockVerdict(b, () => ({ status: "asking", held: true }))).toEqual({ kind: "wait", needsYou: 0 });
	});
});

describe("QueueBlocks.resolveRefs", () => {
	it("resolves #n in the own queue, a role id to its home chat, a chat title; with status and title", async () => {
		const { w, blocks } = world();
		w.ops("/s/c.jsonl", { op: "add", id: 4, plan: plan("Prep") });
		w.titles = [["/s/c.jsonl", "Release prep"]];
		const r = await blocks.resolveRefs({
			file: A,
			self: 1,
			refs: ["#2", "temper #1", "release PREP #4"],
			why: "block",
		});
		expect(r).toEqual({
			refs: [
				{ file: A, name: "", id: 2, status: "ready", title: "Task 2" },
				{ file: B, name: "temper", id: 1, status: "working", title: "Team runner" },
				{ file: "/s/c.jsonl", name: "Release prep", id: 4, status: "ready", title: "Prep" },
			],
		});
	});

	it("refuses unknown refs, the task itself, a role without a home chat, a missing task", async () => {
		const { blocks } = world();
		expect(await blocks.resolveRefs({ file: A, self: 1, refs: ["soon"], why: "block" })).toMatchObject({
			problem: expect.stringMatching(/isn't a task/),
		});
		expect(await blocks.resolveRefs({ file: A, self: 1, refs: ["nobody #2"], why: "block" })).toMatchObject({
			problem: expect.stringMatching(/isn't a role or a queue chat's title/),
		});
		expect(await blocks.resolveRefs({ file: A, self: 1, refs: ["#1"], why: "block" })).toEqual({
			problem: "#1 is this task itself",
		});
		expect(await blocks.resolveRefs({ file: A, self: 1, refs: ["docs #1"], why: "block" })).toMatchObject({
			problem: expect.stringMatching(/has no home chat/),
		});
		expect(await blocks.resolveRefs({ file: A, self: 1, refs: ["temper #9"], why: "block" })).toEqual({
			problem: "temper #9 doesn't exist in temper's queue",
		});
	});

	it("refuses a loop through blocks and afters in other queues", async () => {
		const { w, blocks } = world();
		// temper #2 comes after tooling (A) #3; A #3 comes after A #1. So A #1 can't block on temper #2.
		w.titles = [[A, "tooling"]];
		w.ops(A, { op: "add", id: 3, plan: plan("Three"), after: [1] });
		w.ops(B, { op: "update", id: 2, after: [], outside: [{ file: A, name: "tooling", id: 3 }] });
		expect(await blocks.resolveRefs({ file: A, self: 1, refs: ["temper #2"], why: "block" })).toEqual({
			problem: "that makes a loop: temper #2 waits on this task (directly or through others)",
		});
		// A blocked task's blockers count too.
		w.ops(
			B,
			{ op: "chat", id: 1, file: "/s/b-task-1.jsonl" },
			{ op: "block", id: 1, on: [{ file: A, name: "tooling", id: 1 }], start: w.now, tries: 0 },
		);
		expect(await blocks.resolveRefs({ file: A, self: 1, refs: ["temper #1"], why: "block" })).toMatchObject({
			problem: expect.stringMatching(/loop: temper #1/),
		});
	});
});

describe("parseQueueRefsRequest", () => {
	it("keeps a good request and refuses a bad one", () => {
		expect(parseQueueRefsRequest({ file: A, self: 2, refs: ["temper #1"], after: [1, "x"], why: "after" })).toEqual({
			file: A,
			self: 2,
			refs: ["temper #1"],
			after: [1],
			why: "after",
		});
		expect(parseQueueRefsRequest({ file: "rel", self: 2, refs: [] })).toBe("no queue chat given");
		expect(parseQueueRefsRequest({ file: A, self: 0, refs: [] })).toBe("no task number given");
		expect(parseQueueRefsRequest({ file: A, self: 1, refs: [3] })).toBe("refs must be up to 20 short texts");
	});
});
