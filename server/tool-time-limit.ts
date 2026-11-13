/**
 * tool-time-limit (ops #863): a 2-minute limit on google_search and queue_reply, the owner's choice.
 *
 * On 2026-11-12 google_search (three lead chats) and queue_reply (two lead chats) never returned, for
 * 21 min to 2h17m, and each chat's turn stayed busy. The owner picked "Yes, 2-minute limit" (COO
 * rm-625df2d1): "A frozen search or reply errors out after 2 minutes and the chat carries on; a rare
 * slow-but-working search could be cut off."
 *
 * The limit races the tool's run: past it, the tool's own abort signal fires and the call returns an
 * error result, so only that call fails and the turn goes on to the next model step. Exactly these two
 * tools (rule 21: no limit on any other); the 20-minute hang guard stays as it is. It is laid over the
 * add-on's own tool through tool-overrides (composeWith), so no add-on carries a copy of it.
 * PI_WEB_TOOL_TIME_LIMIT_MS sets every limit in this map to another value (tests use seconds).
 */
import type { AnyToolDefinition, ToolOverrideSpec } from "./tool-overrides.js";

interface ToolTimeLimit {
	/** How long the tool may run, in milliseconds. */
	ms: number;
	/** The error result the model gets past it. */
	words: string;
}

/** The tools with a limit, by name. */
export const TOOL_TIME_LIMITS: Readonly<Record<string, ToolTimeLimit>> = {
	google_search: {
		ms: 120_000,
		words: "Search gave no answer within 2 minutes; try again or use another search tool.",
	},
	// The relay may have gone through: pi-queue refuses a second relay of the same answer.
	queue_reply: {
		ms: 120_000,
		words:
			"No answer within 2 minutes. It may still have gone through: check the task (queue list / roles_overview) before replying again.",
	},
};

/** The limit for `name` in milliseconds (PI_WEB_TOOL_TIME_LIMIT_MS overrides it), or undefined: no limit. */
export function toolTimeLimitMs(name: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
	const limit = TOOL_TIME_LIMITS[name];
	if (!limit) return undefined;
	const override = Number(env.PI_WEB_TOOL_TIME_LIMIT_MS);
	return env.PI_WEB_TOOL_TIME_LIMIT_MS && Number.isFinite(override) && override > 0 ? override : limit.ms;
}

/** `base` with a time limit: past `ms`, its abort signal fires and the call returns `words` as an error. */
export function withTimeLimit(base: AnyToolDefinition, ms: number, words: string): AnyToolDefinition {
	type Execute = AnyToolDefinition["execute"];
	return {
		...base,
		// Our result shape is the SDK's; the cast bridges its two copies of the same types.
		execute: (async (...[toolCallId, params, signal, onUpdate, ctx]: Parameters<Execute>) => {
			const own = new AbortController();
			const passOn = () => own.abort(signal?.reason);
			if (signal?.aborted) passOn();
			else signal?.addEventListener("abort", passOn, { once: true });
			let over = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const limit = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					over = true;
					own.abort(new Error(words));
					reject(new Error(words));
				}, ms);
			});
			// Progress after the limit has nowhere to go: the call is over.
			const update: typeof onUpdate = onUpdate
				? (...args) => {
						if (!over) onUpdate(...args);
					}
				: undefined;
			// Started right away (not a microtask later), so Stop and progress reach it as before.
			let run: Promise<unknown>;
			try {
				run = Promise.resolve(base.execute(toolCallId, params, own.signal, update, ctx));
			} catch (err) {
				run = Promise.reject(err);
			}
			run.catch(() => {}); // a run that fails after the limit is nobody's to report
			try {
				return await Promise.race([run, limit]);
			} catch (err) {
				if (!over) throw err;
				return { content: [{ type: "text", text: words }], details: { timedOut: true, limitMs: ms }, isError: true };
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", passOn);
			}
		}) as Execute,
	};
}

/** The limits as tool-overrides specs: laid over the add-on's tool of that name, nothing when there is none. */
export function toolTimeLimitSpecs(env: NodeJS.ProcessEnv = process.env): ToolOverrideSpec[] {
	return Object.entries(TOOL_TIME_LIMITS).map(([name, { words }]) => ({
		name,
		composeWith: (base: AnyToolDefinition) => withTimeLimit(base, toolTimeLimitMs(name, env) ?? 0, words),
	}));
}
