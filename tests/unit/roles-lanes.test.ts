// roles-lanes: a role card's "N of M lanes in use", from the queue state the Roles overview already reads.
// Fixed queue entries only; no chats, models or writes.
import { describe, expect, it } from "vitest";
import { taskQueueFromEntries, taskQueueLaneUse, type TaskQueueEntryLike } from "../../server/task-queue.js";
import { exactLanes } from "../../web/src/roles-exact-view.js";
import { projectUsefulRoles } from "../../web/src/roles-useful-model.js";

const T0 = Date.parse("2026-10-18T09:00:00Z");
const plan = (title: string) => ({
	title,
	goal: "g",
	doneWhen: "d",
	decided: "x",
	steps: "s",
	verify: "v",
	mustNot: "m",
});
const op = (data: Record<string, unknown>): TaskQueueEntryLike =>
	({ type: "custom", customType: "queue", data: { v: 1, ts: T0, ...data } }) as TaskQueueEntryLike;
const add = (id: number, touches: string[]) => op({ op: "add", id, plan: plan(`Task ${id}`), touches });
const startInChat = (id: number) => [
	op({ op: "start", id, lane: true }),
	op({ op: "chat", id, file: `/sessions/task-${id}.jsonl`, title: `Task ${id}` }),
];
const use = (entries: TaskQueueEntryLike[]) => taskQueueLaneUse(taskQueueFromEntries(entries, true));

describe("taskQueueLaneUse: lanes at once and in use", () => {
	it("takes 2 lanes at once when the queue never set lanesAtOnce, and the queue's own number when it did", () => {
		expect(use([add(1, ["a"]), op({ op: "run" })])).toEqual({ atOnce: 2, inUse: 0 });
		expect(use([op({ op: "lanes", n: 4 }), add(1, ["a"])])).toEqual({ atOnce: 4, inUse: 0 });
	});

	// queue-wait-frees-lane (owner 2026-10-18): only tasks at work count, the way pi-queue counts its lanes at once.
	it("counts tasks at work (working, asking, stuck); on hold, blocked or paused by the owner, a task uses none", () => {
		const q = [
			op({ op: "lanes", n: 4 }),
			add(1, ["a"]),
			add(2, ["b"]),
			add(3, ["c"]),
			add(4, ["d"]),
			op({ op: "run" }),
			...startInChat(1),
			...startInChat(2),
			...startInChat(3),
			op({ op: "wait", id: 2, what: "deploy", check: "true" }),
			op({ op: "block", id: 3, need: "an answer" }),
		];
		const queue = taskQueueFromEntries(q, true);
		expect(queue.tasks.map((t) => [t.id, t.status])).toEqual([
			[1, "working"],
			[2, "waiting"],
			[3, "blocked"],
			[4, "ready"],
		]);
		expect(taskQueueLaneUse(queue)).toEqual({ atOnce: 4, inUse: 1 });
		// Asking its main chat or stuck, a task is still at work.
		const asking = [...startInChat(4), op({ op: "ask", id: 4, question: "Which port?", choices: ["a", "b"], n: 1 })];
		expect(use([...q, ...asking])).toEqual({ atOnce: 4, inUse: 2 });
		expect(use([...q, ...startInChat(4), op({ op: "stuck", id: 4, question: "How?" })])).toEqual({
			atOnce: 4,
			inUse: 2,
		});
		// Its wait over, a task counts again only once it is back at work (pi-queue brings it back).
		expect(use([...q, op({ op: "wait_over", id: 2 })])).toEqual({ atOnce: 4, inUse: 1 });
		// Paused by the owner, a task at work uses none (pi-queue starts no other task in its lane meanwhile).
		const paused = taskQueueFromEntries([...q, op({ op: "hold", id: 1, why: "owner" })], true);
		expect(paused.tasks[0]?.hold?.why).toBe("owner");
		expect(taskQueueLaneUse(paused)).toEqual({ atOnce: 4, inUse: 0 });
		// Done frees it.
		expect(use([...q, op({ op: "done", id: 1, summary: "ok" })])).toEqual({ atOnce: 4, inUse: 0 });
	});

	it("counts tasks, as pi-queue does: two at work in lanes a newer task joined use two", () => {
		const q = [
			add(1, ["x"]),
			add(2, ["y"]),
			op({ op: "run" }),
			...startInChat(1),
			...startInChat(2),
			add(3, ["x", "y"]),
		];
		const queue = taskQueueFromEntries(q, true);
		expect(queue.lanes?.map((l) => l.taskIds)).toEqual([[1, 2, 3]]);
		expect(taskQueueLaneUse(queue)).toEqual({ atOnce: 2, inUse: 2 });
	});

	it("never says more lanes in use than at once", () => {
		const q = [
			add(1, ["a"]),
			add(2, ["b"]),
			op({ op: "run" }),
			...startInChat(1),
			...startInChat(2),
			op({ op: "lanes", n: 1 }),
		];
		expect(use(q)).toEqual({ atOnce: 1, inUse: 1 });
	});

	it("leaves out a task worked on in the queue's own chat (no lane of its own)", () => {
		expect(use([op({ op: "add", id: 1, plan: plan("Old") }), op({ op: "run" }), op({ op: "start", id: 1 })])).toEqual({
			atOnce: 2,
			inUse: 0,
		});
	});
});

describe("the page's checks and words", () => {
	const NOW = T0;
	const role = (queue: unknown, extra: Record<string, unknown> = {}) => ({
		id: "ops",
		title: "Ops",
		homeChat: { file: "/sessions/home.jsonl", where: "home" },
		...(queue === undefined ? {} : { queue }),
		...extra,
	});
	const queue = (lanes: unknown) => ({
		running: true,
		active: [],
		queued: [],
		counts: { active: 0, queued: 0, done: 0 },
		...(lanes === undefined ? {} : { lanes }),
	});
	const lanesOf = (r: unknown) =>
		projectUsefulRoles(
			{ status: "ready", overview: { at: NOW, roles: [r], asks: [] }, checkedAt: NOW, heardAt: NOW },
			"open",
			NOW,
		).roles[0]?.lanes;

	it("takes well-formed lanes from a readable queue only", () => {
		expect(lanesOf(role(queue({ atOnce: 3, inUse: 2 })))).toEqual({ atOnce: 3, inUse: 2 });
		expect(lanesOf(role(queue({ atOnce: 2, inUse: 0 })))).toEqual({ atOnce: 2, inUse: 0 });
		// no queue, an older server without lanes, or a queue read with problems: not recorded
		expect(lanesOf(role(undefined))).toBeUndefined();
		expect(lanesOf(role(queue(undefined)))).toBeUndefined();
		expect(lanesOf(role(queue({ atOnce: 2, inUse: 1 }), { problems: ["home chat"] }))).toBeUndefined();
		for (const bad of [
			{ atOnce: 2, inUse: 3 },
			{ atOnce: 0, inUse: 0 },
			{ atOnce: 9, inUse: 1 },
			{ atOnce: 2.5, inUse: 1 },
			{ atOnce: 2, inUse: -1 },
			{ atOnce: "2", inUse: 1 },
			{ atOnce: 2 },
			[2, 1],
		])
			expect(lanesOf(role(queue(bad)))).toBeUndefined();
	});

	it("draws M pills, the first N busy, and says N of M lanes in use", () => {
		const busy = { bg: "#7DB8FF", bd: "#7DB8FF", bs: "solid" };
		const idle = { bg: "transparent", bd: "#4A4F57", bs: "solid" };
		expect(exactLanes({ atOnce: 3, inUse: 2 })).toEqual({
			lanes: [busy, busy, idle],
			lanesText: "2 of 3 lanes in use",
			lanesLabel: "2 of 3 lanes in use",
		});
		expect(exactLanes({ atOnce: 1, inUse: 0 })).toEqual({
			lanes: [idle],
			lanesText: "0 of 1 lane in use",
			lanesLabel: "0 of 1 lane in use",
		});
		expect(exactLanes(null)).toEqual({
			lanes: [],
			lanesText: "Not recorded",
			lanesLabel: "Task-lane occupancy is not recorded",
		});
		expect(exactLanes(undefined).lanesText).toBe("Not recorded");
	});
});
