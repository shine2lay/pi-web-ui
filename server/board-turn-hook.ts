/**
 * board-turn-hook (Ops #858, pi 1.5.2 upgrade fix c): the before_agent_start handler of the
 * "pi-webui-board" extension. The "[Board]" note goes only on turns that start with a prompt (typed,
 * RPC, or an extension's sendUserMessage).
 *
 * pi 1.2.0+ also fires before_agent_start for a run an extension starts with a custom message
 * (pi.sendMessage(..., { triggerTurn: true }), e.g. a queue report waking a lead chat): messageType
 * "custom", no prompt. Such a turn gets no note, as on pi 1.0.1, which never fired the event for it.
 * Written against both event shapes (1.0.1: prompt only; 1.2.0+: messageType + prompt or message).
 * Test: tests/unit/board-turn-hook.test.ts.
 */
import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";

/** The prompt that starts this run, or undefined for a run a custom message starts. */
function promptOf(event: BeforeAgentStartEvent): string | undefined {
	const e = event as { messageType?: string; prompt?: unknown };
	if (e.messageType !== undefined && e.messageType !== "user") return undefined;
	return typeof e.prompt === "string" ? e.prompt : undefined;
}

/** before_agent_start handler: `note(prompt)` for a prompt's turn, nothing for any other turn. */
export function boardTurnHook<R>(
	note: (prompt: string) => R | undefined,
): (event: BeforeAgentStartEvent) => R | undefined {
	return (event) => {
		const prompt = promptOf(event);
		return prompt === undefined ? undefined : note(prompt);
	};
}
