/**
 * silence-watch (Ops #1058 step 1 of 2; Q-STALL-1 B+, docs/silence-watch.md): the backup for when the queue's
 * own reminders fail. A task that is asking or blocked, has waited `waitMinutes` (60), whose deciding chat has
 * had no turn since the wait began, and that no other nudge still covers, gets one wake to the deciding lead;
 * after `waitMinutes` more with still no turn there, one wake to COO. A watch only: it never stops, pauses or
 * limits work. On an incomplete registry read it reports nothing (the whole-list alarm of
 * work-registry-reader.ts covers that round).
 *
 * Step 1 (Ops #1058) landed the types and the cases; step 2 (Ops #1059) builds them here and feeds them in
 * silence-wake.ts from the one registry reader, the one queue mirror and the one home-chat reader.
 */

import type { RegistryComplete, RegistryIncompleteReason, RegistryRead } from "./work-registry-reader.js";

/** The silence the watch waits for before the lead wake, and again before the COO wake (minutes). */
export const SILENCE_WAIT_MINUTES = 60;

/** Who gets the second wake. */
export const SILENCE_COO_ROLE = "coo";

/** A queued task: its queue (a role's queue is named by the role id) and its id there. */
export interface SilenceTaskRef {
	queue: string;
	id: number;
}

/** One open wait, as the watch reads it. */
export interface SilentWaitInput {
	task: SilenceTaskRef;
	/** The role whose queue holds the task. */
	role: string;
	kind: "question" | "block";
	/** When the wait began (ms): ask.from ?? ask.at for a question, block.start for a block. */
	start: number;
	/** The role whose home chat must act: the task's lead for a question, the owing role for a block. */
	decidingRole: string;
	/**
	 * When another nudge is still due (ms): the block's rule-16 checkpoint; Infinity while it waits on another
	 * task or is a need-only block the queue pokes. Always null for a question: the watch reads no pi-queue timer
	 * for questions (docs/silence-watch.md). The watch wakes only when this is null or already past.
	 */
	nextNudgeAt: number | null;
}

/** Turn times (ms, ascending) of each role's home chat, by role id. */
export type HomeChatTurns = ReadonlyMap<string, readonly number[]>;

export type SilenceStep = "lead" | "coo";

/** One wake that is due now. */
export interface SilentWait {
	task: SilenceTaskRef;
	role: string;
	kind: SilentWaitInput["kind"];
	start: number;
	decidingRole: string;
	/** Whole minutes since the wait began. */
	waitedMinutes: number;
	step: SilenceStep;
	/** Who is woken: the deciding role (lead step) or COO. */
	to: string;
}

export interface SilenceOptions {
	waitMinutes: number;
	/** The wakes already sent (silenceWakeKey -> sent at, ms), read back from the stall watch's ledger. */
	sent: ReadonlyMap<string, number>;
}

/** The stall ledger's stretch of one wait (stall-wake.ts stretchOf of its item: kind task, rule silent). */
export function silenceStretch(w: Pick<SilentWaitInput, "task" | "start">): string {
	return `task:${w.task.queue}#${w.task.id}:silent:${w.start}`;
}

/** The ledger step of a wake: 1 the lead, 2 COO. */
export const silenceStepNo = (step: SilenceStep): number => (step === "lead" ? 1 : 2);

/** The ledger key of one wake (`<stretch>#<step>`, as the stall ledger keys its lines): one per wait (task +
 *  start) and step, so a restart never wakes twice. */
export function silenceWakeKey(w: Pick<SilentWaitInput, "task" | "start">, step: SilenceStep): string {
	return `${silenceStretch(w)}#${silenceStepNo(step)}`;
}

const MINUTE = 60_000;

/** A turn of the deciding chat in [start, now] (inclusive, as the replay counts it). */
function spoke(times: readonly number[] | undefined, start: number, now: number): boolean {
	return !!times?.some((t) => t >= start && t <= now);
}

/**
 * The wakes due at `now`: the lead step at start + waitMinutes when no turn in the deciding chat since `start` and
 * no nudge still covers it; the COO step waitMinutes after the lead wake was sent, still with no turn. Each step
 * at most once per wait (by `sent`). Pure: no clock, no files.
 */
export function findSilentWaits(
	waits: readonly SilentWaitInput[],
	turns: HomeChatTurns,
	now: number,
	opts: SilenceOptions,
): SilentWait[] {
	const gap = opts.waitMinutes * MINUTE;
	const out: SilentWait[] = [];
	for (const w of waits) {
		if (spoke(turns.get(w.decidingRole), w.start, now)) continue;
		const leadAt = opts.sent.get(silenceWakeKey(w, "lead"));
		let step: SilenceStep;
		if (leadAt === undefined) {
			if (now < w.start + gap || (w.nextNudgeAt !== null && w.nextNudgeAt > now)) continue;
			step = "lead";
		} else {
			if (opts.sent.has(silenceWakeKey(w, "coo")) || now < leadAt + gap) continue;
			step = "coo";
		}
		out.push({
			task: w.task,
			role: w.role,
			kind: w.kind,
			start: w.start,
			decidingRole: w.decidingRole,
			waitedMinutes: Math.floor((now - w.start) / MINUTE),
			step,
			to: step === "lead" ? w.decidingRole : SILENCE_COO_ROLE,
		});
	}
	return out;
}

/** A round's answer: the findings of a complete read, or nothing on an incomplete one. */
export type SilenceRound =
	{ complete: true; findings: SilentWait[] } | { complete: false; reason: RegistryIncompleteReason; detail: string };

/**
 * One round over a registry read: on a complete read, the waits it holds (`waitsOf`) go through
 * findSilentWaits; on an incomplete read, no finding at all and `waitsOf` is never called.
 */
export function silenceRound(
	read: RegistryRead,
	waitsOf: (read: RegistryComplete) => readonly SilentWaitInput[],
	turns: HomeChatTurns,
	now: number,
	opts: SilenceOptions,
): SilenceRound {
	if (!read.complete) return { complete: false, reason: read.reason, detail: read.detail };
	return { complete: true, findings: findSilentWaits(waitsOf(read), turns, now, opts) };
}
