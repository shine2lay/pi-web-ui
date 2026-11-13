/**
 * effort-level-button (PATCHES.md; ops #876 seam, built by ops task 2b): the server side of the composer's
 * "Department effort level" button. It asks pi-queue's route channel for a chat's levels and records the owner's
 * pick; an idle chat switches at once through the server's set-model and thinking path, marked
 * `api.routedSwitch` first so pi-queue doesn't take it for a hand pick; a busy chat switches at its next turn start
 * (pi-queue's own hook). Pure over its deps: no model call, no chat file written.
 *
 * Seam only (ops #876): the handler throws EFFORT_LEVELS_NOT_BUILT until ops task 2b builds it.
 */
import type {
	EffortLevelClientMessage,
	EffortLevelServerMessage,
	EffortTier,
	UiEffortLevels,
} from "./effort-level-protocol.js";

export const EFFORT_LEVELS_NOT_BUILT = "effort levels: not built (ops task 2b)";

/** pi-queue's route channel (pi-queue model-files.ts ROUTE_CHANNEL_KEY). */
export const ROUTE_CHANNEL_KEY = Symbol.for("pi-queue.model-route");

export interface EffortChoice {
	model: string;
	thinking: string;
}

/** The part of pi-queue's route channel api the button uses (pi-queue docs/model-table-format.md "Effort levels"). */
export interface EffortRouteApi {
	effortLevels(req: { sessionFile: string }): UiEffortLevels;
	/** Throws on an unknown tier, a chat with no table, or a broken chat-levels.json. */
	setEffortLevel(req: { sessionFile: string; tier: EffortTier | null }): UiEffortLevels & { apply?: EffortChoice };
	routedSwitch?(sessionId: string, model: string): void;
}

/** The chat a message names, as the server has it open. */
export interface EffortLevelChat {
	sessionFile: string;
	sessionId: string;
	/** Mid-turn: the switch waits for the chat's next turn start. */
	isStreaming: boolean;
}

export interface EffortLevelDeps {
	/** undefined: no such open chat, or not a pi chat (DSH). */
	chat(conversationId: string): EffortLevelChat | undefined;
	/** The server's existing set-model and thinking path for that chat. */
	applyModel(conversationId: string, choice: EffortChoice): Promise<void>;
	/** To the window that asked (and, for a push, the windows showing the chat). */
	send(msg: EffortLevelServerMessage): void;
	/** pi-queue's channel api; default: effortRouteApi(). undefined: pi-queue isn't loaded (button hidden). */
	routeApi?(): EffortRouteApi | undefined;
}

/** pi-queue's channel api, when pi-queue is loaded and has the effort-level seam. */
export function effortRouteApi(): EffortRouteApi | undefined {
	const api = (globalThis as Record<symbol, { api?: Partial<EffortRouteApi> } | undefined>)[ROUTE_CHANNEL_KEY]?.api;
	return typeof api?.effortLevels === "function" && typeof api.setEffortLevel === "function"
		? (api as EffortRouteApi)
		: undefined;
}

/** A chat's levels for the button and the server's push; `{ rows: [] }` (hidden) for a chat of no table. */
export function effortLevelsFor(_conversationId: string, _deps: EffortLevelDeps): UiEffortLevels {
	throw new Error(EFFORT_LEVELS_NOT_BUILT);
}

/** get_effort_levels and set_effort_level; always answers with one effort_levels. */
export async function handleEffortLevelMessage(_msg: EffortLevelClientMessage, _deps: EffortLevelDeps): Promise<void> {
	throw new Error(EFFORT_LEVELS_NOT_BUILT);
}
