/**
 * canonical-readers (Ops #621): the server reads queues and the work registry with pi-queue's own readers once
 * pi-queue has loaded in its process (server/pi-queue-readers.ts), and with this repo's own readers until then.
 *
 * Here fake readers stand in for pi-queue's, so each case shows one thing: which reader ran, what of pi-queue's
 * records reaches the page (only what apply() keeps, in its shape), and that a reader that can't help hands the
 * work back to this repo's own replay. tests/unit/task-queue-canonical.test.ts runs the Queue panel's own tests
 * with pi-queue's real readers; the last part here compacts a work log with pi-queue's own compaction.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PI_QUEUE_READERS_KEY, piQueueReaders, type PiQueueReaders } from "../../server/pi-queue-readers.js";
import {
	TASK_QUEUE_ENTRY_TYPE,
	taskQueueAll,
	taskQueueFromEntries,
	type TaskQueueEntryLike,
} from "../../server/task-queue.js";
import { replayWork } from "../../server/work-page.js";
import { WorkRecordsFile, workRecordsFrom, workRecordsFromState } from "../../server/work-records.js";

const slot = globalThis as Record<symbol, unknown>;
const unused = () => {
	throw new Error("not used in this test");
};
/** Puts fake readers where pi-queue puts its own. */
const install = (r: Partial<PiQueueReaders>) => {
	slot[PI_QUEUE_READERS_KEY] = { version: 1, replay: unused, readWork: unused, ...r };
};
afterEach(() => {
	delete slot[PI_QUEUE_READERS_KEY];
});

const plan = (title: string) => ({
	title,
	goal: "A goal",
	doneWhen: "It works",
	decided: "",
	steps: "1. Do it",
	verify: "A test",
	mustNot: "",
});
let clock = 1000;
const entries = (ops: Array<Record<string, unknown>>): TaskQueueEntryLike[] =>
	ops.map((op) => ({ type: "custom", customType: TASK_QUEUE_ENTRY_TYPE, data: { v: 1, ts: clock++, ...op } }));
/** One of pi-queue's tasks (its QueueTask), as its replay gives it. */
const task = (id: number, status: string, extra: Record<string, unknown> = {}) => ({
	id,
	status,
	addedAt: 1000 + id,
	plan: plan(`Task ${id}`),
	...extra,
});
/** pi-queue's QueueState. */
const queueState = (tasks: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
	autoApprove: false,
	autoStart: false,
	running: true,
	nextId: tasks.length + 1,
	tasks,
	...extra,
});

describe("piQueueReaders", () => {
	it("is pi-queue's version-1 readers, and nothing else in their place", () => {
		expect(piQueueReaders()).toBeUndefined();
		slot[PI_QUEUE_READERS_KEY] = "readers";
		expect(piQueueReaders()).toBeUndefined();
		slot[PI_QUEUE_READERS_KEY] = { version: 2, replay: unused, readWork: unused };
		expect(piQueueReaders()).toBeUndefined();
		slot[PI_QUEUE_READERS_KEY] = { version: 1, replay: unused };
		expect(piQueueReaders()).toBeUndefined();
		install({});
		expect(piQueueReaders()?.version).toBe(1);
		// pi-queue's unversioned key is never read: a new shape comes under a new versioned key.
		expect(PI_QUEUE_READERS_KEY).toBe(Symbol.for("pi-queue.readers.v1"));
	});
});

describe("the Queue panel with pi-queue's readers", () => {
	it("replays with pi-queue's own replay, given the entries and the queue's id", () => {
		const seen: unknown[] = [];
		install({
			replay: (list, queueId) => {
				seen.push([...list].length, queueId);
				return queueState([task(7, "ready")]);
			},
		});
		const q = taskQueueFromEntries(
			entries([{ op: "add", id: 1, plan: plan("The mirror's") }]),
			true,
			undefined,
			undefined,
			"q-1",
		);
		expect(q.tasks.map((t) => [t.id, t.plan.title])).toEqual([[7, "Task 7"]]);
		expect(seen).toEqual([1, "q-1"]);
	});

	it("hands the page only what apply() keeps, in its shape", () => {
		install({
			replay: () =>
				queueState(
					[
						task(1, "asking", {
							project: "first-trial",
							question: "Which port?",
							choices: ["8080", "9090"],
							ask: { n: 1, at: 5, to: "ops", lead: "temper" },
							asks: 2,
							source: "from-a-role",
							closeChat: true,
							stalled: 3,
						}),
						task(2, "working", {
							initiative: "team-in-temper",
							answered: 2,
							question: "An earlier one",
							choices: ["a"],
						}),
						task(3, "removed", {
							standalone: true,
							question: "Stale",
							choices: ["x"],
							wait: { what: "CI", check: "true", everyMs: 1000, since: 1, until: 2 },
						}),
						task(4, "blocked", {
							block: {
								on: [{ file: "/q.jsonl", name: "ops", id: 9 }],
								need: "a fix",
								since: 10,
								start: 10,
								tries: 1,
								poke: { at: 20, ask: true, note: "The note the poke sent" },
							},
						}),
						task(5, "ready", {
							hold: { at: 30, why: "Owner: wait for Monday", by: "owner" },
							outside: [{ file: "/other.jsonl", name: "ops", id: 9, over: { at: 40, summary: "It finished" } }],
						}),
					],
					{ hold: { at: 50, why: "Owner: pause it all", by: "owner" }, pausedReason: "stopped" },
				),
		});
		const q = taskQueueFromEntries([], true);
		const byId = (id: number) => q.tasks.find((t) => t.id === id);
		expect(byId(1)).toMatchObject({
			status: "asking",
			parent: { project: "first-trial" },
			question: "Which port?",
			choices: ["8080", "9090"],
			askOps: true,
			askLead: "temper",
		});
		for (const k of ["ask", "asks", "source", "closeChat", "stalled"]) expect(byId(1)).not.toHaveProperty(k);
		expect(byId(2)).toMatchObject({ parent: { initiative: "team-in-temper" }, mainAnswered: true });
		expect(byId(2)).not.toHaveProperty("question");
		expect(byId(2)).not.toHaveProperty("choices");
		expect(byId(4)?.block).toMatchObject({
			need: "a fix",
			since: 10,
			start: 10,
			tries: 1,
			poke: { at: 20, ask: true },
		});
		expect(byId(4)?.block?.poke).not.toHaveProperty("note");
		expect(byId(5)?.hold).toEqual({ at: 30, why: "Owner: wait for Monday" });
		expect(byId(5)?.outside).toEqual([{ file: "/other.jsonl", name: "ops", id: 9, over: { at: 40 } }]);
		expect(q.hold).toEqual({ at: 50, why: "Owner: pause it all" });
		expect(q.pausedReason).toBe("stopped");
		// A removed task isn't on the page; looked up (taskQueueAll), it keeps no question or wait from before.
		expect(byId(3)).toBeUndefined();
		const removed = taskQueueAll([]).tasks.find((t) => t.id === 3);
		expect(removed).toMatchObject({ status: "removed", parent: { standalone: true } });
		for (const k of ["question", "choices", "wait"]) expect(removed).not.toHaveProperty(k);
	});

	it("replays by apply() when pi-queue's replay throws, or gives a status the page doesn't know", () => {
		const e = entries([
			{ op: "add", id: 1, plan: plan("First") },
			{ op: "add", id: 2, plan: plan("Second") },
			{ op: "start", id: 1 },
		]);
		const mirror = taskQueueFromEntries(e, true);
		expect(mirror.tasks.map((t) => [t.id, t.status])).toEqual([
			[1, "working"],
			[2, "ready"],
		]);
		install({
			replay: () => {
				throw new Error("an entry this pi-queue can't replay");
			},
		});
		expect(taskQueueFromEntries(e, true)).toEqual(mirror);
		install({ replay: () => queueState([task(1, "sleeping")]) });
		expect(taskQueueFromEntries(e, true)).toEqual(mirror);
		install({ replay: () => ({ tasks: "none" }) });
		expect(taskQueueFromEntries(e, true)).toEqual(mirror);
	});
});

/** pi-queue's WorkState (its readWork). */
const workState = (
	initiatives: Array<[string, Record<string, unknown>]>,
	projects: Array<[string, Record<string, unknown>]>,
) => ({
	seq: initiatives.length + projects.length,
	initiatives: new Map(initiatives),
	projects: new Map(projects),
	links: new Map(),
});
const record = (extra: Record<string, unknown> = {}) => ({
	name: "A record",
	outcome: "Something",
	doneWhen: ["First", "Second"],
	met: [] as unknown[],
	lead: "ops",
	status: "active",
	createdAt: 1,
	createdBy: "ops",
	updatedAt: 1,
	version: 1,
	...extra,
});

describe("the Roles page's records with pi-queue's readers", () => {
	let dir = "";
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	it("turns pi-queue's records into the page's, counting only marks its done-when list still has", () => {
		const state = workState(
			[["team", record({ name: "Team", met: [{ item: " first ", proof: "p", by: "ops", at: 2 }] })]],
			[
				[
					"trial",
					record({
						name: "Trial",
						lead: "temper",
						status: "done",
						initiative: "team",
						met: [{ item: "Reworded", proof: "p", by: "ops", at: 2 }],
					}),
				],
				["loose", record({ name: "Loose", doneWhen: ["Only"], initiative: null })],
			],
		);
		expect(workRecordsFromState(state)).toEqual({
			initiatives: [{ id: "team", name: "Team", lead: "ops", status: "active", items: 2, met: 1 }],
			projects: [
				{ id: "trial", name: "Trial", lead: "temper", status: "done", initiative: "team", items: 2, met: 0 },
				{ id: "loose", name: "Loose", lead: "ops", status: "active", initiative: null, items: 1, met: 0 },
			],
		});
	});

	it("gives nothing for records it can't show, so the log is read here instead", () => {
		expect(workRecordsFromState(undefined)).toBeUndefined();
		expect(workRecordsFromState({ initiatives: [], projects: [] })).toBeUndefined();
		expect(workRecordsFromState(workState([["Not An Id", record()]], []))).toBeUndefined();
		expect(workRecordsFromState(workState([["team", record({ status: "paused" })]], []))).toBeUndefined();
		expect(workRecordsFromState(workState([], [["p", record({ initiative: "Not An Id" })]]))).toBeUndefined();
		expect(workRecordsFromState(workState([["team", record({ met: [{ proof: "no item" }] })]], []))).toBeUndefined();
	});

	it("WorkRecordsFile takes pi-queue's records for the log's folder, and reads the log itself when readWork can't", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-queue-readers-"));
		const file = join(dir, "events.jsonl");
		const own = `${JSON.stringify({ v: 1, seq: 1, ts: 1, by: "ops", op: "initiative.create", id: "from-the-log", name: "From the log", outcome: "o", doneWhen: ["x"], lead: "ops" })}\n`;
		writeFileSync(file, own);
		const asked: string[] = [];
		install({
			readWork: (d) => {
				asked.push(d);
				return workState([["from-pi-queue", record()]], []);
			},
		});
		expect((await new WorkRecordsFile(() => file).get()).initiatives.map((r) => r.id)).toEqual(["from-pi-queue"]);
		expect(asked).toEqual([dir]);
		install({
			readWork: () => {
				throw new Error("line 1 is damaged");
			},
		});
		expect(await new WorkRecordsFile(() => file).get()).toEqual(workRecordsFrom(own));
		expect(workRecordsFrom(own).initiatives.map((r) => r.id)).toEqual(["from-the-log"]);
		// pi-queue's readWork reads only <folder>/events.jsonl: a log by another name is read here.
		const other = join(dir, "other.jsonl");
		writeFileSync(other, own);
		install({ readWork: (d) => (asked.push(d), workState([["from-pi-queue", record()]], [])) });
		expect(await new WorkRecordsFile(() => other).get()).toEqual(workRecordsFrom(own));
		expect(asked).toEqual([dir]);
	});

	it("never hands pi-queue's readWork a FIFO in the log's place", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-queue-readers-"));
		const file = join(dir, "events.jsonl");
		execFileSync("mkfifo", [file]);
		let asked = 0;
		install({ readWork: () => (asked++, workState([], [])) });
		expect(await new WorkRecordsFile(() => file).get()).toEqual({
			initiatives: [],
			projects: [],
			problem: "unreadable",
		});
		expect(asked).toBe(0);
	});
});

describe("a work log compacted by pi-queue (work-store.ts compactWorkEvents, Ops #619)", () => {
	let dir = "";
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	// Its first import of pi-queue's work-store.ts is nearly all of its time.
	it("reads to the same records, task links and newest activity as the log before it", async () => {
		const pkg = process.env.PI_QUEUE_PKG ?? join(userInfo().homedir, "projects", "pi-queue");
		const storeFile = join(pkg, "work-store.ts");
		if (!existsSync(storeFile)) throw new Error(`pi-queue not found at ${pkg} (set PI_QUEUE_PKG)`);
		const ws = await import(/* @vite-ignore */ pathToFileURL(storeFile).href);
		dir = mkdtempSync(join(tmpdir(), "pi-queue-compact-"));
		let at = 1_790_000_000_000;
		const now = () => (at += 1000);
		const write = (...drafts: Array<Record<string, unknown>>) => ws.writeWork(dir, "ops", () => drafts, { now });
		await write(
			{
				op: "initiative.create",
				id: "team-in-temper",
				name: "Team in Temper",
				outcome: "Roles work as a team",
				doneWhen: ["Runs show", "Trials pass"],
				lead: "architecture",
			},
			{
				op: "project.create",
				id: "first-trial",
				name: "First trial",
				outcome: "One trial",
				doneWhen: ["Trial ran"],
				lead: "temper",
				initiative: "team-in-temper",
			},
			{
				op: "project.create",
				id: "loose",
				name: "Loose",
				outcome: "Alone",
				doneWhen: ["Done"],
				lead: "ops",
				initiative: null,
			},
		);
		const queue = "/home/u/.pi/agent/sessions/queue.jsonl";
		for (let n = 1; n <= 6; n++) {
			const added = 1_789_000_000_000 + n;
			const parent = n % 2 ? { project: "first-trial" } : { initiative: "team-in-temper" };
			await write({ op: "task.link", queue, queueName: "ops", task: n, added, title: `Task ${n}`, parent });
			for (const status of ["working", "waiting", "working", "done"])
				await write({ op: "task.state", queue, task: n, added, status });
		}
		await write({ op: "project.met", id: "first-trial", item: "Trial ran", proof: "run 1" });
		await write({ op: "initiative.change", id: "team-in-temper", changes: { lead: "ops" } });
		await write({ op: "project.change", id: "first-trial", changes: { status: "done" } });
		const file = join(dir, "events.jsonl");
		const before = readFileSync(file, "utf8");
		expect(await ws.compactWorkEvents(dir, { minSaving: 0, keepRecent: 3 })).toMatchObject({ wrote: true });
		const after = readFileSync(file, "utf8");
		expect(after.split("\n").length).toBeLessThan(before.split("\n").length);

		// The Roles page: the same records, by this repo's replay and by pi-queue's readWork.
		const records = workRecordsFrom(before);
		expect(records.projects.map((r) => [r.id, r.status, r.met])).toEqual([
			["first-trial", "done", 1],
			["loose", "active", 0],
		]);
		expect(workRecordsFrom(after)).toEqual(records);
		expect(workRecordsFromState(ws.readWork(dir))).toEqual(records);
		install({ readWork: ws.readWork });
		expect(await new WorkRecordsFile(() => file).get()).toEqual(records);

		// The Work page: the same records and task links; its activity keeps the newest changes as they were.
		const was = replayWork(before);
		const now2 = replayWork(after);
		expect(now2.unknown).toBe(false);
		expect(now2.problem).toBeUndefined();
		expect(now2.initiatives).toEqual(was.initiatives);
		expect(now2.projects).toEqual(was.projects);
		expect(now2.links).toEqual(was.links);
		expect(now2.links.size).toBe(6);
		const lines = new Set(was.activity.map((a) => JSON.stringify(a)));
		expect(now2.activity.every((a) => lines.has(JSON.stringify(a)))).toBe(true);
		expect(now2.activity.slice(-3)).toEqual(was.activity.slice(-3));
	}, 30_000);
});
