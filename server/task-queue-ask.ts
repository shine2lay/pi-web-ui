/**
 * silence-watch (Ops #1059, F1; docs/silence-watch.md): the times of a task's open question, as pi-queue's TaskAsk
 * keeps them (queue-asks.ts normAsk, queue-task-ops.ts "route"), kept by the one queue mirror (task-queue-replay.ts
 * and its fallback task-queue-apply.ts) so the silence watch reads no second copy of the queue. Times only: never
 * the question's words. Server-only: the Queue panel never shows it (task-queue.ts shownTask).
 */

/** The open question's times. `from`: when it came back from a pause (pi-queue unhold), so its wait counts from then. */
export interface TaskAskTimes {
	/** Its number in the task's questions (1 = the first). */
	n: number;
	/** When it was asked (ms). */
	at: number;
	from?: number;
	/** Routed to a lead (to "ops"): when the newest route said who has it now, how far up (1..4), and whether parked. */
	routedAt?: number;
	step?: number;
	parked?: "limit" | "absent";
}

/** pi-queue's ASK_CHAIN_MAX: the most leads a question goes up through. */
const ASK_STEP_MAX = 4;

const positive = (v: unknown): number | undefined =>
	typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;

/** A TaskAsk (or an "ask" op with `at` set to its time) checked into its times; undefined when it has no n or at.
 *  Route fields and parked count only for a question routed to a lead (to "ops"), as pi-queue's normAsk keeps them. */
export function askTimesOf(raw: unknown): TaskAskTimes | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const a = raw as Record<string, unknown>;
	const n = typeof a.n === "number" && Number.isFinite(a.n) ? Math.round(a.n) : 0;
	const at = positive(a.at);
	if (n < 1 || !at) return undefined;
	const ops = a.to === "ops";
	const from = positive(a.from);
	const routedAt = ops ? positive(a.routedAt) : undefined;
	const step =
		ops && typeof a.step === "number" && Number.isInteger(a.step) && a.step > 0 && a.step <= ASK_STEP_MAX
			? a.step
			: undefined;
	const parked = ops && (a.parked === "limit" || a.parked === "absent") ? a.parked : undefined;
	return {
		n,
		at,
		...(from ? { from } : {}),
		...(routedAt ? { routedAt } : {}),
		...(step ? { step } : {}),
		...(parked ? { parked } : {}),
	};
}

/** A "route" op on the open question it names (same n and at): its new route times; `from` stays. Another
 *  question's route changes nothing. */
export function routedAsk(ask: TaskAskTimes | undefined, op: Record<string, unknown>): TaskAskTimes | undefined {
	if (!ask || ask.n !== op.n || ask.at !== op.at) return ask;
	const routed = askTimesOf({ ...op, n: ask.n, at: ask.at, to: "ops", from: ask.from, routedAt: op.routedAt ?? op.ts });
	return routed ?? ask;
}

/** When an asking task's wait began: asked, or back from a pause (pi-queue's own clock, queue-replay.ts). */
export const askWaitStart = (a: TaskAskTimes): number => a.from ?? a.at;
