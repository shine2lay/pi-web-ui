/**
 * The Queue tab's answers in flight (AskHub #592 occurrence transport), split out of recovery-chat.ts.
 *
 * frontend #286: every answer settles. Before, a waiter only settled on the server's reply or on the
 * socket closing; when the server never replied over an open socket (design #305, 2026-11-12: the
 * Ops #860 relay deadlock held the server's answer route), the card read "Sending…" for good with
 * every button disabled. Now a waiter has a reply deadline. When it passes, the waiter asks the
 * server for a fresh snapshot (get_state) and looks at the task again before it settles: still
 * waiting on the same question -> "no-reply" (the card offers a retry); moved on -> "moved-on".
 * It never resends: a retry is the user's own tap, and the server refuses a second answer to one
 * questionId while the first is on its way or after it landed.
 */
import type { AdmissionBinding } from "./recovery-admission";
import { newPromptId } from "./pending-sends";
import type { ClientMessage, ServerMessage, UiState } from "./types";
import type {
	TaskQueueAnswerBinding,
	TaskQueueAnswerFailure,
	TaskQueueAnswerOutcome,
	TaskQueueAnswerRequest,
} from "./components/TaskQueueLines";

/** How long the server gets to say how an answer went. It normally answers within a few seconds. */
export const QUEUE_ANSWER_REPLY_MS = 30_000;
/** After the deadline: how long to wait for the fresh snapshot asked for, before judging from what is known. */
export const QUEUE_ANSWER_RECHECK_MS = 5_000;

type Socket = Pick<WebSocket, "readyState" | "send">;
type ResultMessage = Extract<ServerMessage, { type: "task_queue_answer_result" }>;
type Queue = NonNullable<UiState["taskQueue"]>;
type Snapshot = Pick<UiState, "conversationId" | "taskQueue">;

export interface QueueAnswerDeps {
	socket(): Socket | null;
	captureBinding(): AdmissionBinding | null;
	isCurrent(binding: AdmissionBinding): boolean;
	view(): { state: UiState | null };
}

interface Waiter {
	socket: Socket;
	binding: AdmissionBinding;
	occ: TaskQueueAnswerBinding;
	resolve(value: TaskQueueAnswerOutcome): void;
	timer: ReturnType<typeof setTimeout>;
}

const fail = (why: TaskQueueAnswerFailure["why"], reason?: string): TaskQueueAnswerFailure =>
	Object.freeze({ applied: false, why, ...(reason ? { reason } : {}) });

function wellFormed(req: TaskQueueAnswerRequest | undefined): boolean {
	const occ = req?.binding;
	return (
		!!req &&
		!!occ &&
		typeof occ.conversationId === "string" &&
		!!occ.conversationId.trim() &&
		typeof occ.queueId === "string" &&
		!!occ.queueId.trim() &&
		Number.isInteger(occ.taskId) &&
		occ.taskId > 0 &&
		typeof occ.questionId === "string" &&
		!!occ.questionId.trim() &&
		typeof req.text === "string" &&
		!!req.text.trim() &&
		typeof occ.question === "string" &&
		Array.isArray(occ.choices) &&
		occ.choices.every((c: unknown) => typeof c === "string") &&
		(occ.detail === undefined || typeof occ.detail === "string")
	);
}

/** Is this queue still waiting on exactly this question occurrence (same task, text, choices, detail)? */
function stillAsks(queue: Queue | undefined, conversationId: string | undefined, occ: TaskQueueAnswerBinding): boolean {
	if (conversationId !== occ.conversationId || !queue || queue.queueId !== occ.queueId) return false;
	const bound = queue.answerBindings?.find(
		(b) =>
			b.conversationId === occ.conversationId &&
			b.queueId === occ.queueId &&
			b.taskId === occ.taskId &&
			b.questionId === occ.questionId,
	);
	const task = queue.tasks?.find((t) => t.id === occ.taskId);
	return (
		!!bound &&
		!!task &&
		task.status === "stuck" &&
		(task.question ?? "") === occ.question &&
		JSON.stringify(task.choices ?? []) === JSON.stringify(occ.choices) &&
		(task.detail ?? undefined) === (occ.detail ?? undefined)
	);
}

export function createQueueAnswerWaiters(deps: QueueAnswerDeps) {
	const waiters = new Map<string, Waiter>();
	/** Deadline passed: waiting for the fresh snapshot asked for. */
	const rechecks = new Map<(state?: Snapshot) => void, Socket>();

	const recheck = (owner: Socket, occ: TaskQueueAnswerBinding, resolve: Waiter["resolve"]) => {
		let done = false;
		const judge = (fresh?: Snapshot) => {
			if (done) return;
			done = true;
			rechecks.delete(judge);
			clearTimeout(grace);
			const state = fresh ?? deps.view().state;
			resolve(stillAsks(state?.taskQueue, state?.conversationId, occ) ? fail("no-reply") : fail("moved-on"));
		};
		const grace = setTimeout(judge, QUEUE_ANSWER_RECHECK_MS);
		rechecks.set(judge, owner);
		try {
			owner.send(JSON.stringify({ type: "get_state" } satisfies ClientMessage));
		} catch {
			judge();
		}
	};

	return {
		answer(req: TaskQueueAnswerRequest): Promise<TaskQueueAnswerOutcome> {
			if (!wellFormed(req)) return Promise.resolve(fail("stale"));
			const occ = req.binding;
			const socket = deps.socket();
			const binding = deps.captureBinding();
			const state = deps.view().state;
			if (!socket || socket.readyState !== 1 || !binding) return Promise.resolve(fail("offline"));
			if (binding.conversationId !== occ.conversationId || !stillAsks(state?.taskQueue, state?.conversationId, occ))
				return Promise.resolve(fail("stale"));
			const owner = socket;
			const reqId = `qa-${newPromptId()}`;
			const snapshotOcc: TaskQueueAnswerBinding = {
				conversationId: occ.conversationId,
				queueId: occ.queueId,
				taskId: occ.taskId,
				questionId: occ.questionId,
				question: occ.question,
				choices: [...occ.choices],
				...(occ.detail !== undefined ? { detail: occ.detail } : {}),
			};
			const textSnapshot = req.text;
			return new Promise((resolve) => {
				const timer = setTimeout(() => {
					if (waiters.get(reqId)?.timer !== timer) return;
					// A late reply is dropped from here on; the queue's own snapshots show what really happened.
					waiters.delete(reqId);
					recheck(owner, snapshotOcc, resolve);
				}, QUEUE_ANSWER_REPLY_MS);
				waiters.set(reqId, { socket: owner, binding, occ: snapshotOcc, resolve, timer });
				try {
					owner.send(
						JSON.stringify({
							type: "task_queue_answer",
							reqId,
							conversationId: snapshotOcc.conversationId,
							queueId: snapshotOcc.queueId,
							taskId: snapshotOcc.taskId,
							questionId: snapshotOcc.questionId,
							text: textSnapshot,
							question: snapshotOcc.question,
							choices: [...snapshotOcc.choices],
							...(snapshotOcc.detail !== undefined ? { detail: snapshotOcc.detail } : {}),
						} satisfies ClientMessage),
					);
				} catch {
					clearTimeout(timer);
					waiters.delete(reqId);
					resolve(fail("offline"));
				}
			});
		},
		receive(owner: Socket, message: ResultMessage): void {
			if (!message.reqId) return;
			const waiter = waiters.get(message.reqId);
			if (!waiter || waiter.socket !== owner) return;
			waiters.delete(message.reqId);
			clearTimeout(waiter.timer);
			const sameOccurrence =
				message.conversationId === waiter.occ.conversationId &&
				message.queueId === waiter.occ.queueId &&
				message.taskId === waiter.occ.taskId &&
				message.questionId === waiter.occ.questionId;
			if (!deps.isCurrent(waiter.binding)) return waiter.resolve(fail("offline"));
			if (!sameOccurrence) return waiter.resolve(fail("stale"));
			waiter.resolve(message.applied === true ? true : fail("refused", message.reason));
		},
		/** A full snapshot arrived on this socket: deadline-passed answers judge from it. */
		snapshot(owner: Socket, state: Snapshot): void {
			for (const [judge, socket] of [...rechecks]) if (socket === owner) judge(state);
		},
		/** The socket closed or changed: nothing in flight can be confirmed any more. */
		settleAll(): void {
			for (const waiter of waiters.values()) {
				clearTimeout(waiter.timer);
				waiter.resolve(fail("offline"));
			}
			waiters.clear();
			for (const judge of [...rechecks.keys()]) judge();
		},
	};
}
