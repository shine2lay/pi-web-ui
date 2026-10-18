/**
 * initiatives-plan-data (Ops #223): the whole work registry as the Initiatives page reads it
 * (pi-work-management's events.jsonl, replayed by server/work-page.ts with the store's own rules),
 * joined with the queues' facts from the Roles overview, and pushed to the windows that watch it.
 * Fixed fixtures only: never the live registry.
 */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage, UiRolesOverview, UiWorkPage } from "../../server/protocol.js";
import {
	WORK_PAGE_ACTIVITY_MAX,
	WORK_PAGE_RECORDS_MAX,
	WORK_PAGE_TASKS_MAX,
	WorkPageFile,
	WorkPageWatch,
	workFactsFromOverview,
	workPageFrom,
	type WorkQueueFacts,
} from "../../server/work-page.js";

/** One log line at time ts (its seq too), written by `by`. */
const L = (ts: number, e: Record<string, unknown>, by = "ops") => JSON.stringify({ v: 1, seq: ts, ts, by, ...e });
const Q = "/home/u/.pi/agent/sessions/ops-home.jsonl";
const ref = (task: number, added: number) => ({ queue: Q, queueName: "ops", task, added });

const FIXTURE =
	[
		L(
			1,
			{
				op: "initiative.create",
				id: "team-plan",
				name: "Team plan",
				outcome: "Everyone sees the plan",
				doneWhen: ["Feed is live", "Page shows it"],
				lead: "ops",
			},
			"owner",
		),
		L(2, {
			op: "project.create",
			id: "page-data",
			name: "Page data",
			outcome: "One feed",
			doneWhen: ["Feed landed", "Docs written"],
			lead: "ops",
			initiative: "team-plan",
		}),
		// An old single-text done when; a project in no initiative.
		L(
			3,
			{
				op: "project.create",
				id: "solo-tool",
				name: "Solo tool",
				outcome: "A tool on its own",
				doneWhen: "Tool works",
				lead: "design",
				initiative: null,
			},
			"design",
		),
		L(4, { op: "project.met", id: "page-data", item: "  feed LANDED ", proof: "commit abc123" }),
		L(5, { op: "project.met", id: "page-data", item: "Docs written", proof: "docs/x.md" }),
		L(6, { op: "project.unmet", id: "page-data", item: "docs written", reason: "the doc is empty" }),
		L(7, { op: "initiative.met", id: "team-plan", item: "Feed is live", proof: "deploy 1" }),
		L(8, { op: "initiative.met", id: "team-plan", item: "Page shows it", proof: "screenshot" }),
		// Moved and reworded: the moved item keeps its mark (with the new wording), the reworded one loses it;
		// the name is what it already was, so only doneWhen changed.
		L(9, {
			op: "initiative.change",
			id: "team-plan",
			changes: { doneWhen: ["page shows it", "Feed is live everywhere"], name: "Team plan" },
		}),
		L(10, {
			op: "task.link",
			queue: Q,
			queueName: "ops",
			task: 7,
			added: 500,
			title: "Build the feed",
			parent: { project: "page-data" },
		}),
		L(11, {
			op: "task.state",
			queue: Q,
			task: 7,
			added: 500,
			status: "blocked",
			block: {
				on: ["#3"],
				need: "the design view",
				lead: "design",
				owes: "the view",
				due: 9000,
				reminders: 1,
				lastReminder: 10500,
				since: 10000,
			},
		}),
		L(12, {
			op: "task.link",
			queue: Q,
			queueName: "ops",
			task: 8,
			added: 600,
			title: "Tidy up",
			parent: { standalone: true },
		}),
		L(13, { op: "task.state", queue: Q, task: 8, added: 600, status: "working" }),
		// A change this reader doesn't know, two the store's rules refuse, and one of another version: skipped.
		L(14, { op: "project.archive", id: "solo-tool" }),
		L(15, { op: "project.met", id: "page-data", item: "Not an item", proof: "x" }),
		L(16, {
			op: "task.link",
			queue: Q,
			queueName: "ops",
			task: 9,
			added: 700,
			title: "Old work",
			parent: { project: "no-such-project" },
		}),
		JSON.stringify({ v: 2, seq: 17, ts: 17, by: "ops", op: "project.create", id: "future" }),
		L(18, { op: "project.change", id: "solo-tool", changes: { status: "dropped" } }, "design"),
	].join("\n") +
	"\n" +
	// A half-written last line.
	'{"v":1,"seq":19,"ts":19,"by":"ops","op":"project.cha';

/** The queues' facts: the path written another way still finds the queue. */
const FACTS: WorkQueueFacts[] = [
	{
		file: "/home/u/.pi/agent/sessions/./ops-home.jsonl",
		tasks: new Map([
			[
				7,
				{
					chat: "/s/task-7.jsonl",
					nextAction: { kind: "blocked" as const, who: "design", what: "the view" },
					requester: "You (browser)",
					needsYou: { text: "Which layout?", since: 10600 },
				},
			],
			[8, { added: 600, chat: "/s/task-8.jsonl", paused: { at: 13000, why: "owner: wait" } }],
			// Not in the registry: nothing comes of it.
			[99, { chat: "/s/task-99.jsonl" }],
		]),
	},
];

describe("workPageFrom", () => {
	it("replays the whole registry by the store's rules and joins each task's queue facts", () => {
		expect(workPageFrom(FIXTURE, FACTS, 42)).toEqual({
			at: 42,
			initiatives: [
				{
					id: "team-plan",
					name: "Team plan",
					outcome: "Everyone sees the plan",
					lead: "ops",
					status: "active",
					createdAt: 1,
					createdBy: "owner",
					updatedAt: 9,
					doneWhen: [
						{ item: "page shows it", met: { proof: "screenshot", by: "ops", at: 8 } },
						{ item: "Feed is live everywhere" },
					],
				},
			],
			projects: [
				{
					id: "page-data",
					name: "Page data",
					outcome: "One feed",
					lead: "ops",
					status: "active",
					createdAt: 2,
					createdBy: "ops",
					updatedAt: 6,
					doneWhen: [
						{ item: "Feed landed", met: { proof: "commit abc123", by: "ops", at: 4 } },
						{ item: "Docs written" },
					],
					initiative: "team-plan",
				},
				{
					id: "solo-tool",
					name: "Solo tool",
					outcome: "A tool on its own",
					lead: "design",
					status: "dropped",
					createdAt: 3,
					createdBy: "design",
					updatedAt: 18,
					doneWhen: [{ item: "Tool works" }],
					initiative: null,
				},
			],
			tasks: [
				{
					...ref(7, 500),
					title: "Build the feed",
					parent: { project: "page-data" },
					state: "blocked",
					stateAt: 11,
					block: {
						on: ["#3"],
						need: "the design view",
						lead: "design",
						owes: "the view",
						due: 9000,
						since: 10000,
					},
					chat: "/s/task-7.jsonl",
					nextAction: { kind: "blocked", who: "design", what: "the view" },
					requester: "You (browser)",
					needsYou: { text: "Which layout?", since: 10600 },
				},
				{
					...ref(8, 600),
					title: "Tidy up",
					parent: { standalone: true },
					state: "working",
					stateAt: 13,
					chat: "/s/task-8.jsonl",
					paused: { at: 13000, why: "owner: wait" },
				},
			],
			activity: [
				{ at: 18, by: "design", op: "project.change", id: "solo-tool", changed: ["status"], status: "dropped" },
				{ at: 13, by: "ops", op: "task.state", task: ref(8, 600), status: "working" },
				{ at: 12, by: "ops", op: "task.link", task: ref(8, 600), parent: { standalone: true } },
				{ at: 11, by: "ops", op: "task.state", task: ref(7, 500), status: "blocked" },
				{ at: 10, by: "ops", op: "task.link", task: ref(7, 500), parent: { project: "page-data" } },
				{ at: 9, by: "ops", op: "initiative.change", id: "team-plan", changed: ["doneWhen"] },
				{ at: 8, by: "ops", op: "initiative.met", id: "team-plan", item: "Page shows it", proof: "screenshot" },
				{ at: 7, by: "ops", op: "initiative.met", id: "team-plan", item: "Feed is live", proof: "deploy 1" },
				{ at: 6, by: "ops", op: "project.unmet", id: "page-data", item: "Docs written", reason: "the doc is empty" },
				{ at: 5, by: "ops", op: "project.met", id: "page-data", item: "Docs written", proof: "docs/x.md" },
				{ at: 4, by: "ops", op: "project.met", id: "page-data", item: "Feed landed", proof: "commit abc123" },
				{ at: 3, by: "design", op: "project.create", id: "solo-tool" },
				{ at: 2, by: "ops", op: "project.create", id: "page-data" },
				{ at: 1, by: "owner", op: "initiative.create", id: "team-plan" },
			],
			problem: "unknown-change",
		});
	});

	it("leaves a half-written last line out without calling it a problem", () => {
		const page = workPageFrom(FIXTURE.split("\n").slice(0, 3).join("\n") + "\n" + '{"v":1,"seq":4', [], 1);
		expect(page.problem).toBeUndefined();
		expect(page.projects.map((p) => p.id)).toEqual(["page-data", "solo-tool"]);
	});

	it("says unreadable for a complete line that isn't a JSON object, as the store refuses it", () => {
		const empty = { at: 1, initiatives: [], projects: [], tasks: [], activity: [], problem: "unreadable" };
		expect(workPageFrom(`${FIXTURE.split("\n")[0]}\nnot json\n`, [], 1)).toEqual(empty);
		expect(workPageFrom("[1]\n", [], 1)).toEqual(empty);
	});

	it("joins no facts to a task number its queue linked twice, unless the add time says which", () => {
		const twice =
			FIXTURE.split("\n").slice(0, 2).join("\n") +
			"\n" +
			[
				L(3, {
					op: "task.link",
					queue: Q,
					queueName: "ops",
					task: 5,
					added: 100,
					title: "One branch",
					parent: { project: "page-data" },
				}),
				L(4, {
					op: "task.link",
					queue: Q,
					queueName: "ops",
					task: 5,
					added: 200,
					title: "Another",
					parent: { project: "page-data" },
				}),
			].join("\n") +
			"\n";
		const facts = (added?: number): WorkQueueFacts[] => [
			{ file: Q, tasks: new Map([[5, { ...(added !== undefined ? { added } : {}), chat: "/s/t5.jsonl" }]]) },
		];
		expect(workPageFrom(twice, facts(), 1).tasks.map((t) => t.chat)).toEqual([undefined, undefined]);
		expect(workPageFrom(twice, facts(200), 1).tasks.map((t) => t.chat)).toEqual([undefined, "/s/t5.jsonl"]);
	});

	it("sends at most the first records and tasks over its limits, and says too-big", () => {
		const lines: string[] = [];
		let ts = 0;
		for (let i = 0; i <= WORK_PAGE_RECORDS_MAX; i++) {
			lines.push(
				L(++ts, {
					op: "initiative.create",
					id: `ini-${i}`,
					name: `I ${i}`,
					outcome: "o",
					doneWhen: ["d"],
					lead: "ops",
				}),
			);
		}
		const many = workPageFrom(lines.join("\n") + "\n", [], 1);
		expect(many.problem).toBe("too-big");
		expect(many.initiatives).toHaveLength(WORK_PAGE_RECORDS_MAX);
		expect(many.initiatives[0]?.id).toBe("ini-0");

		const tasks = [
			L(1, { op: "project.create", id: "p", name: "P", outcome: "o", doneWhen: ["d"], lead: "ops", initiative: null }),
		];
		for (let n = 1; n <= WORK_PAGE_TASKS_MAX + 1; n++) {
			tasks.push(
				L(1 + n, {
					op: "task.link",
					queue: Q,
					queueName: "ops",
					task: n,
					added: n,
					title: `T${n}`,
					parent: { project: "p" },
				}),
			);
		}
		const busy = workPageFrom(tasks.join("\n") + "\n", [], 1);
		expect(busy.problem).toBe("too-big");
		expect(busy.tasks).toHaveLength(WORK_PAGE_TASKS_MAX);
		expect(busy.tasks[0]?.task).toBe(1);
		// The newest changes only, newest first.
		expect(busy.activity).toHaveLength(WORK_PAGE_ACTIVITY_MAX);
		expect(busy.activity[0]?.task?.task).toBe(WORK_PAGE_TASKS_MAX + 1);
	});
});

describe("workFactsFromOverview", () => {
	it("takes each role's home-queue tasks and each task's oldest open ask", () => {
		const overview = {
			at: 1,
			asks: [],
			roles: [
				{
					id: "ops",
					homeChat: { file: Q },
					asks: [
						{
							key: "ops:task:7",
							role: "ops",
							kind: "task",
							text: "Which layout?",
							since: 100,
							chat: { file: "/s/t7", where: 7 },
							focus: "task:7",
						},
						{
							key: "ops:tldr:x",
							role: "ops",
							kind: "tldr",
							text: "A later ask",
							since: 200,
							chat: { file: "/s/t7", where: 7 },
							focus: "tldr:x",
						},
						{
							key: "ops:tldr:h",
							role: "ops",
							kind: "tldr",
							text: "A home ask",
							chat: { file: Q, where: "home" },
							focus: "tldr:h",
						},
					],
					queue: {
						running: true,
						active: [
							{
								id: 7,
								status: "asking",
								title: "Build",
								chat: { file: "/s/t7" },
								next: { kind: "answer", who: "owner" },
								requester: { v: 1, inputs: [{ kind: "owner", channel: "browser", id: "ri-0123abcd" }] },
								queueEvent: { kind: "added", at: 500 },
							},
						],
						queued: [
							{
								id: 8,
								status: "ready",
								title: "Tidy",
								paused: { at: 3, why: "owner: wait" },
								queueEvent: { kind: "started", at: 9 },
							},
						],
						counts: { active: 1, queued: 1, done: 0 },
					},
				},
				// No home chat: nothing to find its tasks by.
				{
					id: "design",
					asks: [],
					queue: {
						running: true,
						active: [{ id: 1, status: "working", title: "X" }],
						queued: [],
						counts: { active: 1, queued: 0, done: 0 },
					},
				},
			],
		} as unknown as UiRolesOverview;
		expect(workFactsFromOverview(overview)).toEqual([
			{
				file: Q,
				tasks: new Map([
					[
						7,
						{
							added: 500,
							chat: "/s/t7",
							nextAction: { kind: "answer", who: "owner" },
							requester: "You (browser)",
							needsYou: { text: "Which layout?", since: 100 },
						},
					],
					[8, { paused: { at: 3, why: "owner: wait" } }],
				]),
			},
		]);
	});
});

describe("WorkPageFile", () => {
	let dir = "";
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	it("reads nothing from a missing log, unreadable from a folder, too-big over its limit, and follows changes", async () => {
		dir = mkdtempSync(join(tmpdir(), "work-page-"));
		const file = join(dir, "events.jsonl");
		const none = { at: 5, initiatives: [], projects: [], tasks: [], activity: [] };
		expect(await new WorkPageFile(() => file).get([], 5)).toEqual(none);
		expect(await new WorkPageFile(() => dir).get([], 5)).toEqual({ ...none, problem: "unreadable" });
		writeFileSync(file, `${FIXTURE.split("\n")[0]}\n`);
		const reader = new WorkPageFile(() => file);
		expect((await reader.get([], 5)).initiatives.map((i) => i.id)).toEqual(["team-plan"]);
		appendFileSync(file, `${FIXTURE.split("\n")[1]}\n`);
		expect((await reader.get([], 5)).projects.map((p) => p.id)).toEqual(["page-data"]);
		expect(await new WorkPageFile(() => file, 100).get([], 5)).toEqual({ ...none, problem: "too-big" });
	});
});

describe("WorkPageWatch", () => {
	it("sends the page at once, again only when it changed, and nothing after unwatch", async () => {
		let page: UiWorkPage = workPageFrom("", [], 0);
		let reads = 0;
		const watch = new WorkPageWatch<string>(async () => ({ ...page, at: ++reads }), { pollMs: 60_000 });
		const sent: ServerMessage[] = [];
		await watch.watch("window", (m) => sent.push(m));
		expect(sent).toEqual([{ type: "work_page", page: { ...page, at: 1 } }]);
		expect(watch.polling).toBe(true);
		// Only its time differs: nothing is sent.
		await watch.look();
		expect(sent).toHaveLength(1);
		page = workPageFrom(`${FIXTURE.split("\n")[0]}\n`, [], 0);
		await watch.look();
		expect(sent).toHaveLength(2);
		expect(sent[1]).toEqual({ type: "work_page", page: { ...page, at: 3 } });
		watch.drop("window");
		expect(watch.size).toBe(0);
		expect(watch.polling).toBe(false);
		page = workPageFrom("", [], 0);
		await watch.look();
		expect(sent).toHaveLength(2);
	});
});
