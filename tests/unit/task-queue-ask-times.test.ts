/**
 * silence-watch (Ops #1059, F1): the one queue mirror keeps an asking task's question times (task-queue-ask.ts),
 * so the silence watch needs no second parser. Runs with the fallback replay here and with pi-queue's own replay
 * through task-queue-canonical.test.ts. Synthetic records only.
 */
import { describe, expect, it } from "vitest";
import { askTimesOf, askWaitStart } from "../../server/task-queue-ask.js";
import { replayState } from "../../server/task-queue-replay.js";
import { taskQueueFromEntries } from "../../server/task-queue.js";

const MIN = 60_000;
const T0 = 1_763_700_000_000;
const plan = { title: "Task", goal: "g", doneWhen: "d", decided: "x", steps: "s", verify: "v", mustNot: "m" };
const line = (op: Record<string, unknown>, ts: number) => ({
	type: "custom",
	customType: "queue",
	data: { v: 1, ts, ...op },
});
const started = (id: number) => [
	line({ op: "add", id, plan: { ...plan, title: `Task ${id}` } }, T0),
	line({ op: "start", id, lane: true }, T0),
];
const askOf = (ops: ReturnType<typeof line>[], id = 1) =>
	replayState([...started(id), ...ops], `/q/ask-times-${ops.length}-${ops.at(-1)?.data.ts}.jsonl`).tasks.find(
		(t) => t.id === id,
	)?.ask;

describe("F1: the queue mirror keeps an asking task's question times", () => {
	it("a question to the task's main chat: its number and when it was asked, no route fields", () => {
		const ask = askOf([line({ op: "ask", id: 1, n: 2, question: "Q?" }, T0 + 5 * MIN)]);
		expect(ask).toEqual({ n: 2, at: T0 + 5 * MIN });
		expect(askWaitStart(ask!)).toBe(T0 + 5 * MIN);
	});

	it("a question routed to a lead keeps step, routedAt and parked; a route op on it updates them, not n or at", () => {
		const asked = line(
			{ op: "ask", id: 1, n: 6, question: "Q?", to: "ops", lead: "design", step: 1, routedAt: T0 + 6 * MIN },
			T0 + 6 * MIN,
		);
		expect(askOf([asked])).toEqual({ n: 6, at: T0 + 6 * MIN, step: 1, routedAt: T0 + 6 * MIN });
		const routed = line({ op: "route", id: 1, n: 6, at: T0 + 6 * MIN, lead: "coo", step: 2 }, T0 + 40 * MIN);
		expect(askOf([asked, routed])).toEqual({ n: 6, at: T0 + 6 * MIN, step: 2, routedAt: T0 + 40 * MIN });
		const other = line({ op: "route", id: 1, n: 5, at: T0 + MIN, lead: "coo", step: 3 }, T0 + 50 * MIN);
		expect(askOf([asked, other])).toEqual({ n: 6, at: T0 + 6 * MIN, step: 1, routedAt: T0 + 6 * MIN });
	});

	it("paused and resumed while asking: the wait counts from the resume (ask.from), as pi-queue's unhold sets it", () => {
		const ops = [
			line({ op: "ask", id: 1, n: 1, question: "Q?" }, T0 + 5 * MIN),
			line({ op: "hold", id: 1, why: "owner: pause it", by: "panel" }, T0 + 10 * MIN),
			line({ op: "release", id: 1 }, T0 + 70 * MIN),
		];
		const ask = askOf(ops);
		expect(ask).toEqual({ n: 1, at: T0 + 5 * MIN, from: T0 + 70 * MIN });
		expect(askWaitStart(ask!)).toBe(T0 + 70 * MIN);
	});

	it("answered (the task works again): no question times left", () => {
		const ops = [
			line({ op: "ask", id: 1, n: 1, question: "Q?" }, T0 + 5 * MIN),
			line({ op: "resume", id: 1 }, T0 + 20 * MIN),
		];
		expect(askOf(ops)).toBeUndefined();
	});

	it("the Queue panel never shows them", () => {
		const panel = taskQueueFromEntries(
			[...started(1), line({ op: "ask", id: 1, n: 1, question: "Q?" }, T0 + MIN)],
			true,
		);
		const task = panel.tasks.find((t) => t.id === 1);
		expect(task?.status).toBe("asking");
		expect(task && "ask" in task).toBe(false);
	});

	it("askTimesOf refuses a question without a number or time and drops route fields of an unrouted one", () => {
		expect(askTimesOf({ n: 0, at: T0 })).toBeUndefined();
		expect(askTimesOf({ n: 1 })).toBeUndefined();
		expect(askTimesOf({ n: 1, at: T0, step: 2, parked: "limit", routedAt: T0 })).toEqual({ n: 1, at: T0 });
		expect(askTimesOf({ n: 1, at: T0, to: "ops", step: 9, parked: "x" })).toEqual({ n: 1, at: T0 });
	});
});
