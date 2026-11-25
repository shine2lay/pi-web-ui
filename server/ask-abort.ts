/**
 * stop-cancels-ask (Ops #1085; Shine 2026-11-24): Stop ends a waiting ask_user_question at once.
 *
 * The tool's abort signal lives as long as the whole run, so a listener added for one question must go the moment
 * that question's wait ends (answered, cancelled, handed back, refused), whichever way it ends: `endOnAbort` adds it
 * for the wait and drops it when the wait settles, so a long run that asks many questions leaks none.
 */

/** The error a stopped wait ends with (the same words an already-stopped call always got). */
export const ASK_ABORTED_ERROR = "ask_user_question aborted";

/** `wait`, with `onAbort` run if `signal` aborts before `wait` settles; the listener never outlives the wait. */
export function endOnAbort<T>(signal: AbortSignal | undefined, onAbort: () => void, wait: Promise<T>): Promise<T> {
	if (!signal) return wait;
	signal.addEventListener("abort", onAbort, { once: true });
	const drop = () => signal.removeEventListener("abort", onAbort);
	return wait.then(
		(value) => {
			drop();
			return value;
		},
		(err: unknown) => {
			drop();
			throw err;
		},
	);
}

/** A split call (one dialog per owner) that was stopped fails as a whole, whatever another owner answered. */
export function stoppedError(errors: ReadonlyArray<Error | undefined>): Error | undefined {
	return errors.find((e) => e?.message === ASK_ABORTED_ERROR);
}
