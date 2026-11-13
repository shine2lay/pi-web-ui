/**
 * effort-level-button (PATCHES.md; ops #876 seam, built by ops task 2b): the server side of the composer's
 * "Department effort level" button. It asks pi-queue's route channel for a chat's levels and records the owner's
 * pick; an idle chat switches at once through the server's set-model and thinking path, marked
 * `api.routedSwitch` first so pi-queue doesn't take it for a hand pick; a busy chat switches at its next turn start
 * (pi-queue's own hook). Pure over its deps: no model call, no chat file written.
 *
 * Built by ops #878 (task 2b). EFFORT_LEVELS_NOT_BUILT stays exported: #876's seam test names it.
 */
import { identityRegistry } from "./identities.js";
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

/** The part of an open pi chat the button reads (agent-service's Conversation). */
export interface EffortLevelConv {
	session: { sessionFile?: string; isStreaming: boolean; sessionManager: { getSessionId(): string } };
}

/** The window's set-model and thinking path (agent-service's ClientSession; both act on the chat it shows). */
export interface EffortLevelSwitcher {
	switchModelOrThrow(modelId: string): Promise<void>;
	setThinking(level: string): void;
}

/** A window's deps: `conv` finds the chat only while that window shows it, `emit` reaches it and its viewers. */
export function effortLevelDeps(
	conv: (conversationId: string) => EffortLevelConv | undefined,
	emit: (msg: EffortLevelServerMessage) => void,
	switcher: EffortLevelSwitcher,
): EffortLevelDeps {
	return {
		chat(conversationId) {
			const session = conv(conversationId)?.session;
			if (!session?.sessionFile) return undefined;
			const sessionId = session.sessionManager.getSessionId();
			return { sessionFile: session.sessionFile, sessionId, isStreaming: session.isStreaming };
		},
		async applyModel(conversationId, { model, thinking }) {
			if (!conv(conversationId)) throw new Error("the chat is no longer open in this window");
			await switcher.switchModelOrThrow(model);
			switcher.setThinking(thinking);
		},
		send: emit,
	};
}

const HIDDEN: UiEffortLevels = { rows: [] };

/** Reuse the Roles page's canonical identity reader; pi-queue owns routing, not display names. */
function withDepartmentTitle(levels: UiEffortLevels): UiEffortLevels {
	const title = levels.role ? identityRegistry().identities.find((role) => role.id === levels.role)?.title : undefined;
	return title ? { ...levels, title } : levels;
}

/** A chat's levels for the button and the server's push; `{ rows: [] }` (hidden) for a chat of no table. */
export function effortLevelsFor(conversationId: string, deps: EffortLevelDeps): UiEffortLevels {
	const chat = deps.chat(conversationId);
	const api = (deps.routeApi ?? effortRouteApi)();
	if (!chat || !api) return { ...HIDDEN };
	try {
		return withDepartmentTitle(api.effortLevels({ sessionFile: chat.sessionFile }));
	} catch (err) {
		// pi-queue failing to read its files: no button, and the reason in the server log.
		console.error(`[effort-level] effortLevels(${chat.sessionFile}) failed:`, err);
		return { ...HIDDEN };
	}
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** get_effort_levels and set_effort_level; always answers with one effort_levels. */
export async function handleEffortLevelMessage(msg: EffortLevelClientMessage, deps: EffortLevelDeps): Promise<void> {
	const { conversationId } = msg;
	const answer = (rest: Omit<EffortLevelServerMessage, "type" | "conversationId">) =>
		deps.send({ type: "effort_levels", conversationId, ...rest });
	if (msg.type === "get_effort_levels") return answer({ levels: effortLevelsFor(conversationId, deps) });

	const chat = deps.chat(conversationId);
	const api = (deps.routeApi ?? effortRouteApi)();
	if (!chat) return answer({ levels: { ...HIDDEN }, error: "This chat isn't open here; open it and try again." });
	if (!api) return answer({ levels: { ...HIDDEN }, error: "pi-queue isn't loaded, so there is no department table." });
	let picked: ReturnType<EffortRouteApi["setEffortLevel"]>;
	try {
		picked = api.setEffortLevel({ sessionFile: chat.sessionFile, tier: msg.tier });
	} catch (err) {
		return answer({ levels: effortLevelsFor(conversationId, deps), error: message(err) });
	}
	const { apply, ...table } = picked;
	const levels = withDepartmentTitle(table);
	// Busy: pi-queue's turn-start hook switches it before the next turn, never mid-turn.
	if (chat.isStreaming) return answer({ levels, applied: "next-turn" });
	if (!apply) return answer({ levels });
	try {
		api.routedSwitch?.(chat.sessionId, apply.model);
		await deps.applyModel(conversationId, apply);
	} catch (err) {
		return answer({ levels, error: `Level kept, but the switch failed: ${message(err)}` });
	}
	return answer({ levels, applied: "now" });
}
