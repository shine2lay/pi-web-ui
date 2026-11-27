import type { LeadScheduler } from "./lead-compaction-scheduler.js";

export interface LeadLifecycleHooks {
	/** Host scalar event bridge; agent_settled only after retries/continuations finish. */
	onAgentEvent(listener: (sessionId: string, type: string) => void): () => void;
	onHomeOpen(listener: (sessionId: string) => void): () => void;
	/** Reuse the host's idle cadence; no new polling interval or process-global timer. */
	onIdle(listener: () => void): () => void;
	/** Existing diagnostics fault sink, machine code only. */
	onError(code: "E_LEAD_LIFECYCLE"): void;
}

/** Explicit integration activation seam. Merely importing this module starts nothing. */
export function attachLeadLifecycle(scheduler: LeadScheduler, hooks: LeadLifecycleHooks): () => void {
	let stopped = false;
	const detach: Array<() => void> = [];
	function run(work: () => Promise<unknown>): void {
		if (stopped) return;
		void Promise.resolve()
			.then(() => (stopped ? undefined : work()))
			.catch(() => {
				try {
					hooks.onError("E_LEAD_LIFECYCLE");
				} catch {
					/* host diagnostics unavailable */
				}
			});
	}
	function stop(): void {
		stopped = true;
		for (const unsubscribe of detach.splice(0).reverse()) unsubscribe();
	}
	try {
		detach.push(
			hooks.onAgentEvent((sessionId, type) => {
				if (type === "agent_settled") run(() => scheduler.requestCheck({ sessionId, trigger: "settled" }));
			}),
		);
		detach.push(
			hooks.onHomeOpen((sessionId) => run(() => scheduler.requestCheck({ sessionId, trigger: "home-open" }))),
		);
		detach.push(hooks.onIdle(() => run(() => scheduler.scan("idle"))));
		run(() => scheduler.scan("startup"));
		return stop;
	} catch (error) {
		stop();
		throw error;
	}
}
