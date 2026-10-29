/**
 * task-chat-start (Ops #629, H-LAUNCH-ONCE-1): when a queued task's chat counts as started.
 *
 * openTaskChat used to wait 20 s for the first turn to show (isStreaming, or a new message) and
 * otherwise report "the chat didn't start". But pi (SDK 1.0.1 AgentSession.prompt) only marks the
 * run active after its input handlers, the pre-prompt compaction check and the add-ons'
 * before_agent_start step, and pi-worktree makes the task's worktree in that step (`wt new`, with
 * `npm ci` for pi-web-ui: over a minute under load; its own timeout is 20 min). session.abort() at
 * that point does nothing (it only flags a run that is already active, and the run clears the
 * flag when it starts), so the "failed" chat ran anyway, and the queue's retry gave the task a
 * second chat and worktree (Ops #628 on 2026-10-28).
 *
 * Now the start is decided by pi's own answer to the prompt:
 * - started: pi takes the prompt (preflightResult "started" or "queued": the run starts right
 *   after, before pi's next await), or a turn shows (isStreaming, a new message);
 * - failed: pi refuses it (the reason comes back through `ended`), or the prompt call ends without
 *   a turn (an add-on handled the text, or pi put it off).
 * There is no time limit: every step before the run is bounded by its own owner, and a window
 * shorter than those refused real starts. Once failure is reported the gate is shut: pi calls
 * preflightResult synchronously right before it starts the run, so the gate's throw makes the
 * prompt fail there and no turn can follow a reported failure.
 */
export type StartDisposition = "started" | "queued" | "handled";

/** What the prompt path calls (ClientSession.prompt's taskStart option). */
export interface TaskStartHooks {
	/** First thing in pi's preflightResult. Throws once the start was reported failed: pi then starts no run. */
	gate(disposition: StartDisposition): void;
	/** The prompt call is over for this text (prompt()'s finally); `refusal` = why it didn't reach the chat. */
	ended(refusal?: string): void;
}

/** The message a gate throws when pi tries to start a run that was already reported failed. */
export const START_GIVEN_UP = "the task's chat start was already reported failed";

/**
 * Send the first prompt (`send` gets the hooks; it must not reject for a refusal it reports) and
 * resolve once the chat is under way; reject with the reason when it never will be.
 */
export function startTaskChat(o: {
	send: (hooks: TaskStartHooks) => Promise<void>;
	/** Whether a turn shows (isStreaming, or more messages than before the send). */
	ranTurn: () => boolean;
}): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let state: "pending" | "started" | "failed" = "pending";
		const start = () => {
			if (state !== "pending") return;
			state = "started";
			resolve();
		};
		const fail = (why: string) => {
			if (state !== "pending") return;
			state = "failed";
			reject(new Error(why));
		};
		const turned = (): boolean => {
			try {
				return o.ranTurn();
			} catch {
				return false;
			}
		};
		const over = (refusal?: string) => {
			if (state !== "pending") return;
			if (turned()) start();
			else fail(refusal || "its first message started no turn");
		};
		const hooks: TaskStartHooks = {
			gate: (disposition) => {
				if (state === "failed") throw new Error(START_GIVEN_UP);
				if (disposition !== "handled") start();
			},
			ended: (refusal) => over(refusal),
		};
		let sent: Promise<void>;
		try {
			sent = o.send(hooks);
		} catch (err) {
			sent = Promise.reject(err);
		}
		sent.then(
			() => over(),
			(err) => over(err instanceof Error ? err.message : String(err)),
		);
	});
}
