/**
 * prompt-start-race (Ops #261, H-PROMPT-RACE-1): one prompt start at a time per chat.
 *
 * SDK 1.0.1's AgentSession.prompt() checks isStreaming and then awaits input handlers, auth,
 * compaction and before_agent_start before it marks the run active. A second start in that gap
 * (an extension's sendUserMessage, a triggerTurn message, a UI send) also passes the check, and
 * its agent.prompt() then throws "Agent is already processing a prompt". That failed start's
 * finally block clears the running flag and emits agent_settled while the first run goes on:
 * the message is lost, the chat looks idle for the rest of the run, and no-turn notes stop being
 * held to the end of the turn (one landed between a tool call and its result and broke Temper
 * #106's chat for good, every later request refused with a 400).
 *
 * The guard, installed per session where pi-web-ui makes a chat's session:
 * 1. prompt starts (UI prompt, extension sendUserMessage, triggerTurn custom messages) take turns:
 *    a start waits until the start before it has been taken (started, queued, handled or failed),
 *    and then, with the run going, becomes a follow-up of that run;
 * 2. an extension send without deliverAs that finds a run going becomes a follow-up instead of
 *    failing with "Agent is already processing";
 * 3. backstop: a start that still reaches the run step while a run is active is queued as a
 *    follow-up of that run, so a refused start never clears the flag or settles a live run.
 * Everything else (idle prompts, UI steer/followUp, Stop, nextTurn asides, no-turn notes) passes
 * straight through to the SDK.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";

type PromptOptions = NonNullable<Parameters<AgentSession["prompt"]>[1]>;
type CustomOptions = NonNullable<Parameters<AgentSession["sendCustomMessage"]>[1]>;
type Disposition = Parameters<NonNullable<PromptOptions["preflightResult"]>>[0];

/** SDK 1.0.1 internals the guard leans on; tests/unit/prompt-start-race.test.ts checks they exist. */
interface SessionInternals {
	_isEmittingAgentSettled?: boolean;
	_isAgentRunActive?: boolean;
	_runAgentPrompt?: (messages: unknown) => Promise<void>;
}

type GuardedSession = Pick<AgentSession, "prompt" | "sendCustomMessage" | "isStreaming" | "agent">;

const installed = new WeakSet<object>();
const customMessageGuards = new WeakMap<
	object,
	{
		original: GuardedSession["sendCustomMessage"];
		wrapped: GuardedSession["sendCustomMessage"];
	}
>();

/** Our triggerTurn:false branch calls its original sender before any await; unknown wrappers do not qualify. */
export function isKnownNoTurnMessagePath(
	session: GuardedSession,
	native: GuardedSession["sendCustomMessage"],
): boolean {
	if (session.sendCustomMessage === native) return true;
	const guard = customMessageGuards.get(session);
	return guard?.original === native && guard.wrapped === session.sendCustomMessage;
}

/** A start that arrives while another is under way, or with a run going, follows that run. */
function asFollowUp(options: PromptOptions | undefined): PromptOptions {
	return options?.streamingBehavior ? options : { ...options, streamingBehavior: "followUp" };
}

export function installPromptStartGuard(session: GuardedSession): void {
	if (installed.has(session)) return;
	installed.add(session);
	const inner = session as GuardedSession & SessionInternals;
	const prompt = session.prompt.bind(session);
	const originalCustom = session.sendCustomMessage;
	const sendCustom = originalCustom.bind(session);

	// The line of starts: each waits for the one before it to be taken.
	let line: Promise<void> = Promise.resolve();
	let starting = 0;
	const enter = (): { ready: Promise<void>; done: () => void } => {
		const ready = line;
		let resolve!: () => void;
		line = new Promise<void>((r) => {
			resolve = r;
		});
		starting++;
		let left = false;
		return {
			ready,
			done: () => {
				if (left) return;
				left = true;
				starting--;
				resolve();
			},
		};
	};

	session.prompt = async (text: string, options?: PromptOptions): Promise<void> => {
		// While agent_settled is being emitted the SDK defers the call and replays it through here.
		if (inner._isEmittingAgentSettled) return prompt(text, options);
		if (!starting && session.isStreaming) return prompt(text, asFollowUp(options));
		const turn = enter();
		await turn.ready;
		const preflight = options?.preflightResult;
		const guarded: PromptOptions = {
			...asFollowUp(options),
			// The run is marked active right after "started", before pi's next await.
			preflightResult: (disposition: Disposition) => {
				turn.done();
				preflight?.(disposition);
			},
		};
		try {
			return await prompt(text, guarded);
		} finally {
			turn.done();
		}
	};

	session.sendCustomMessage = async (message, options?: CustomOptions): Promise<void> => {
		// Only a turn-starting message can collide; pi checks and starts it without an await between.
		if (!options?.triggerTurn || options.deliverAs === "nextTurn" || inner._isEmittingAgentSettled || !starting) {
			return sendCustom(message, options);
		}
		const turn = enter();
		await turn.ready;
		const next = session.isStreaming && !options.deliverAs ? { ...options, deliverAs: "followUp" as const } : options;
		// Called without awaiting first: a run it starts is marked active before the call returns.
		const sent = sendCustom(message, next);
		turn.done();
		return sent;
	};

	customMessageGuards.set(session, { original: originalCustom, wrapped: session.sendCustomMessage });

	// Backstop for paths that reach the run step directly (SDK-internal replays): never a second run.
	const run = inner._runAgentPrompt?.bind(inner);
	if (run) {
		inner._runAgentPrompt = async (messages: unknown): Promise<void> => {
			if (!inner._isAgentRunActive) return run(messages);
			const list = (Array.isArray(messages) ? messages : [messages]) as Parameters<
				AgentSession["agent"]["followUp"]
			>[0][];
			for (const message of list) {
				// The SDK's own tool-loadout note belongs to the start that was turned away.
				if ((message as { role?: string }).role === "system") continue;
				session.agent.followUp(message);
			}
		};
	}
}
