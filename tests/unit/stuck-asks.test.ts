/**
 * telegram-answers: server/stuck-asks.ts — which queued tasks wait on the user, across open chats'
 * queues, keyed by the chat the answer goes into.
 */
import { describe, expect, it } from "vitest";
import type { UiTaskQueue, UiTaskQueueTask } from "../../server/protocol.js";
import {
	stuckGoneReason,
	stuckKey,
	stuckSig,
	stuckTarget,
	wantedStuckAsks,
	type StuckSource,
} from "../../server/stuck-asks.js";

const task = (id: number, over: Partial<UiTaskQueueTask> = {}): UiTaskQueueTask =>
	({
		id,
		plan: { title: `Task ${id}` },
		status: "ready",
		...over,
	}) as UiTaskQueueTask;

const queue = (tasks: UiTaskQueueTask[]): UiTaskQueue => ({ tasks }) as unknown as UiTaskQueue;

const src = (file: string, tasks: UiTaskQueueTask[], title = file): StuckSource => ({
	file,
	queue: queue(tasks),
	meta: { conversationId: `c-${file}`, conversationTitle: title, cwd: "/p", sessionFile: file },
});

describe("stuckTarget", () => {
	it("a task in the queue chat answers there; a lane task in its own chat, once known", () => {
		expect(stuckTarget("/q.jsonl", task(1))).toBe("/q.jsonl");
		expect(stuckTarget("/q.jsonl", task(2, { lane: true, chat: { file: "/t2.jsonl" } }))).toBe("/t2.jsonl");
		expect(stuckTarget("/q.jsonl", task(3, { lane: true }))).toBeUndefined();
	});
});

describe("wantedStuckAsks", () => {
	it("a stuck task in the queue chat: one ask, with its question and choices", () => {
		const { wanted, seen } = wantedStuckAsks([
			src(
				"/q.jsonl",
				[task(1, { status: "stuck", question: "Which?", choices: ["A", "B"] }), task(2, { status: "ready" })],
				"Queue chat",
			),
		]);
		expect([...wanted.keys()]).toEqual([stuckKey("/q.jsonl", 1)]);
		expect(wanted.get("/q.jsonl#1")).toMatchObject({
			target: "/q.jsonl",
			taskId: 1,
			taskTitle: "Task 1",
			question: "Which?",
			choices: ["A", "B"],
			meta: { conversationTitle: "Queue chat", sessionFile: "/q.jsonl" },
		});
		expect(seen.get("/q.jsonl#2")).toBe("ready");
	});

	it("a lane task: its own chat speaks for it while open; else the queue chat's copy, named after the task's chat", () => {
		const laneCopy = task(4, {
			lane: true,
			status: "stuck",
			question: "Old question?",
			chat: { file: "/t4.jsonl", title: "Lane chat" },
		});
		const own = task(4, { status: "working" });
		// Both open: the task's own chat (where it is working again) wins over the lagging copy.
		const both = wantedStuckAsks([src("/q.jsonl", [laneCopy]), src("/t4.jsonl", [own])]);
		expect(both.wanted.size).toBe(0);
		expect(both.seen.get("/t4.jsonl#4")).toBe("working");
		// Only the queue chat open: its copy asks, answered in the task's chat.
		const onlyQueue = wantedStuckAsks([src("/q.jsonl", [laneCopy])]);
		expect(onlyQueue.wanted.get("/t4.jsonl#4")).toMatchObject({
			target: "/t4.jsonl",
			question: "Old question?",
			meta: { conversationTitle: "Lane chat", cwd: "/p", sessionFile: "/t4.jsonl" },
		});
		expect(onlyQueue.wanted.get("/t4.jsonl#4")?.meta.conversationId).toBeUndefined();
	});

	it("a lane task with no chat yet is skipped; no question gives an empty one", () => {
		const { wanted } = wantedStuckAsks([
			src("/q.jsonl", [task(5, { lane: true, status: "stuck" }), task(6, { status: "stuck" })]),
		]);
		expect([...wanted.keys()]).toEqual(["/q.jsonl#6"]);
		expect(wanted.get("/q.jsonl#6")).toMatchObject({ question: "", choices: [] });
	});
});

describe("stuckSig / stuckGoneReason", () => {
	it("a new question or new choices make a new signature", () => {
		const a = stuckSig({ question: "Q", choices: ["A", "B"] });
		expect(stuckSig({ question: "Q", choices: ["A", "B"] })).toBe(a);
		expect(stuckSig({ question: "Q", choices: ["A"] })).not.toBe(a);
		expect(stuckSig({ question: "Q2", choices: ["A", "B"] })).not.toBe(a);
	});

	it("why it went away, from how the task looks now", () => {
		expect(stuckGoneReason(undefined)).toEqual({ answered: false, reason: "the chat was closed" });
		expect(stuckGoneReason("working")).toEqual({ answered: true, reason: "answered in the chat" });
		expect(stuckGoneReason("waiting").answered).toBe(true);
		expect(stuckGoneReason("done").reason).toBe("the task is done");
		expect(stuckGoneReason("stuck").reason).toBe("it asks something else now");
		expect(stuckGoneReason("ready").reason).toBe("the task moved on");
		// queue-main-chat: back at work with its main chat's answer; asking its main chat again.
		expect(stuckGoneReason("working", true)).toEqual({ answered: false, reason: "its main chat answered it" });
		expect(stuckGoneReason("waiting", true).answered).toBe(true);
		expect(stuckGoneReason("asking")).toEqual({ answered: false, reason: "it asks something else now" });
	});
});

/** queue-main-chat: a task asking its main chat doesn't wait on the user. */
describe("wantedStuckAsks: a task asking its main chat", () => {
	it("makes no ask, and its chat is listed as asking (the speaking chat decides)", () => {
		const laneCopy = task(4, {
			lane: true,
			status: "asking",
			question: "Which port?",
			choices: ["8080", "9090"],
			chat: { file: "/t4.jsonl", title: "Lane chat" },
		});
		const onlyQueue = wantedStuckAsks([src("/q.jsonl", [laneCopy])]);
		expect(onlyQueue.wanted.size).toBe(0);
		expect(onlyQueue.seen.get("/t4.jsonl#4")).toBe("asking");
		expect([...onlyQueue.asking]).toEqual(["/t4.jsonl"]);
		// The task's own chat is open and says it asks: same answer from its own record.
		const own = wantedStuckAsks([src("/q.jsonl", [laneCopy]), src("/t4.jsonl", [task(4, { status: "asking" })])]);
		expect([...own.asking]).toEqual(["/t4.jsonl"]);
		// Its own chat is back at work (the queue chat's copy lags): not asking any more.
		const back = wantedStuckAsks([
			src("/q.jsonl", [laneCopy]),
			src("/t4.jsonl", [task(4, { status: "working", mainAnswered: true })]),
		]);
		expect(back.asking.size).toBe(0);
		expect([...back.mainAnswered]).toEqual(["/t4.jsonl#4"]);
	});

	it("a question passed on to the user is an ask again; the main chat's later answer is told apart", () => {
		const stuck = task(4, {
			lane: true,
			status: "stuck",
			question: "Port 8080 or 9090?",
			choices: ["8080 (recommended)", "9090"],
			chat: { file: "/t4.jsonl", title: "Lane chat" },
		});
		const passed = wantedStuckAsks([src("/q.jsonl", [stuck])]);
		expect(passed.wanted.get("/t4.jsonl#4")).toMatchObject({ question: "Port 8080 or 9090?" });
		expect(passed.asking.size).toBe(0);
		const owner = wantedStuckAsks([src("/q.jsonl", [{ ...stuck, status: "working" }])]);
		expect(owner.mainAnswered.size).toBe(0);
		const main = wantedStuckAsks([src("/q.jsonl", [{ ...stuck, status: "working", mainAnswered: true }])]);
		expect([...main.mainAnswered]).toEqual(["/t4.jsonl#4"]);
	});
});
