/**
 * frontend #286: an answer from the Queue tab always settles, and says why when it didn't go through.
 * Before: with the socket open and no reply from the server (design #305, 2026-11-12), the waiter never
 * settled, so the card read "Sending…" for good with every button disabled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRecoveryChatTransport } from "../../web/src/recovery-chat";
import { QUEUE_ANSWER_RECHECK_MS, QUEUE_ANSWER_REPLY_MS } from "../../web/src/queue-answer-waiter";
import type { ClientMessage, UiState } from "../../web/src/types";

const occ = {
	conversationId: "c-design",
	queueId: "q-design",
	taskId: 305,
	questionId: "stuck-305",
	question: "Which of the four first drafts?",
	choices: ["W", "X", "Y", "Z"],
	detail: "The whole picture",
};
const stuckTask = {
	id: 305,
	status: "stuck",
	plan: { title: "Blind bake-off", goal: "g", doneWhen: "d", decided: "", steps: "s", verify: "v", mustNot: "m" },
	question: occ.question,
	choices: occ.choices,
	detail: occ.detail,
	createdAt: 1,
};
const stateWith = (task: object, bound = true): UiState =>
	({
		conversationId: occ.conversationId,
		sessionId: "s-design",
		cwd: "/tmp",
		messages: [],
		notices: [],
		taskQueue: {
			running: false,
			available: true,
			lanes: [],
			queueId: occ.queueId,
			tasks: [task],
			answerBindings: bound ? [occ] : [],
		},
	}) as unknown as UiState;

function setup() {
	const sent: ClientMessage[] = [];
	const socket = { readyState: 1 as const, send: (raw: string) => void sent.push(JSON.parse(raw) as ClientMessage) };
	let state = stateWith(stuckTask);
	const transport = createRecoveryChatTransport({
		view: () => ({ state, preview: null }),
		captureOriginal: (message) => ({ message }),
		pending: () => {},
		problem: () => {},
	});
	transport.connect(socket);
	transport.ready(socket, "gen-1");
	transport.initialize(socket, "gen-1");
	transport.bindSnapshot(socket, state);
	const answers = () => sent.filter((m) => m.type === "task_queue_answer");
	const lastAnswer = () => answers().at(-1) as Extract<ClientMessage, { type: "task_queue_answer" }>;
	return {
		socket,
		sent,
		transport,
		answers,
		lastAnswer,
		setState: (next: UiState) => (state = next),
		answer: (text = "Z") => transport.answerQueueTask({ binding: occ, text }),
	};
}

describe("Queue tab answer waiter (frontend #286)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("no reply over an open socket: after the deadline it asks for fresh state, then says no reply (no resend)", async () => {
		const t = setup();
		let outcome: unknown = "unsettled";
		void t.answer().then((r) => (outcome = r));
		expect(t.answers()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(QUEUE_ANSWER_REPLY_MS - 1);
		expect(outcome).toBe("unsettled");
		expect(t.sent.filter((m) => m.type === "get_state")).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		// It checks the task's current state instead of resending.
		expect(t.sent.filter((m) => m.type === "get_state")).toHaveLength(1);
		t.transport.bindSnapshot(t.socket, stateWith(stuckTask));
		await vi.advanceTimersByTimeAsync(0);
		expect(outcome).toEqual({ applied: false, why: "no-reply" });
		expect(t.answers()).toHaveLength(1);
		// A reply that turns up after that changes nothing (the queue's own snapshots show what happened).
		t.transport.receiveTaskQueueAnswerResult(t.socket, {
			type: "task_queue_answer_result",
			reqId: t.lastAnswer().reqId!,
			conversationId: occ.conversationId,
			queueId: occ.queueId,
			taskId: occ.taskId,
			questionId: occ.questionId,
			applied: true,
		});
		expect(outcome).toEqual({ applied: false, why: "no-reply" });
	});

	it("no reply and the task moved on meanwhile: says so instead of offering a blind retry", async () => {
		const t = setup();
		const pending = t.answer();
		await vi.advanceTimersByTimeAsync(QUEUE_ANSWER_REPLY_MS);
		t.transport.bindSnapshot(t.socket, stateWith({ ...stuckTask, status: "running" }, false));
		await vi.advanceTimersByTimeAsync(0);
		expect(await pending).toEqual({ applied: false, why: "moved-on" });
	});

	it("no reply and no fresh snapshot either: still settles, judged from what the view knows", async () => {
		const t = setup();
		const pending = t.answer();
		await vi.advanceTimersByTimeAsync(QUEUE_ANSWER_REPLY_MS + QUEUE_ANSWER_RECHECK_MS);
		expect(await pending).toEqual({ applied: false, why: "no-reply" });
	});

	it("refused by the server: settles with its reason", async () => {
		const t = setup();
		const pending = t.answer();
		t.transport.receiveTaskQueueAnswerResult(t.socket, {
			type: "task_queue_answer_result",
			reqId: t.lastAnswer().reqId!,
			conversationId: occ.conversationId,
			queueId: occ.queueId,
			taskId: occ.taskId,
			questionId: occ.questionId,
			applied: false,
			reason: "an answer is already on its way",
		});
		expect(await pending).toEqual({ applied: false, why: "refused", reason: "an answer is already on its way" });
		// The deadline that would have fired is gone: no state check afterwards.
		await vi.advanceTimersByTimeAsync(QUEUE_ANSWER_REPLY_MS * 2);
		expect(t.sent.filter((m) => m.type === "get_state")).toHaveLength(0);
	});

	it("applied: true, as before, and no deadline left behind", async () => {
		const t = setup();
		const pending = t.answer();
		t.transport.receiveTaskQueueAnswerResult(t.socket, {
			type: "task_queue_answer_result",
			reqId: t.lastAnswer().reqId!,
			conversationId: occ.conversationId,
			queueId: occ.queueId,
			taskId: occ.taskId,
			questionId: occ.questionId,
			applied: true,
		});
		expect(await pending).toBe(true);
		await vi.advanceTimersByTimeAsync(QUEUE_ANSWER_REPLY_MS * 2);
		expect(t.sent.filter((m) => m.type === "get_state")).toHaveLength(0);
	});

	it("socket closes while waiting: settles offline", async () => {
		const t = setup();
		const pending = t.answer();
		t.transport.disconnect(t.socket);
		expect(await pending).toEqual({ applied: false, why: "offline" });
	});
});
