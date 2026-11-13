/**
 * stuck-runtime (ops #861): dispose a chat's runtime whose run will never end.
 *
 * pi 1.5.2's AgentSessionRuntime.dispose() starts with `await session.abort()`, and
 * session.abort() waits until the run is idle. A run stuck in a tool that never settles and
 * ignores the abort signal never goes idle (pi-agent-core awaits tool.execute with no race
 * against the abort), so dispose() never returned and the force-reset behind Stop and the hang
 * guard never finished: on 2026-11-12 five lead chats stayed busy for up to 2h17m until a restart.
 *
 * Here the abort is still signalled (the tool's signal fires, bash process trees die), but the
 * wait for idle is skipped, and the SDK's own dispose does the rest (session_shutdown to the
 * add-ons, invalidating the session, settling credential writes). The stuck run is disconnected
 * from the session by then, so if its tool ever settles, nothing of it reaches the chat.
 */
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

/** A promise (`done`) that resolves once `open()` is called: interruptRun races session.abort()
 *  against the end of the force-reset, since the old session's abort() may never return. */
export function latch(): { done: Promise<void>; open: () => void } {
	let open: () => void = () => {};
	const done = new Promise<void>((r) => {
		open = r;
	});
	return { done, open };
}

export async function disposeStuckRuntime(runtime: AgentSessionRuntime): Promise<void> {
	const session = runtime.session;
	// Signal the abort; its wait for idle may never resolve, so nothing awaits it.
	session.abort().catch(() => {});
	// dispose() awaits session.abort() first: the abort is already signalled, so skip the wait.
	session.abort = async () => {};
	await runtime.dispose();
}
