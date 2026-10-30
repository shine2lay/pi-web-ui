/**
 * first-send: a chat's start-up as one logical attempt, so the first message typed while a chat
 * starts is neither lost nor sent to the wrong chat.
 *
 * Before this, the composer treated the first bind of a new chat (its conversation/session ids
 * arriving) as a navigation and cleared the box, after submit had already refused the send
 * ("Session is initializing"). On New chat the composer even kept the old chat's ids until the new
 * one arrived, so a send could land in the old chat.
 *
 * An attempt has a generation. It starts on page load (via "load") or on New chat (via "new_chat",
 * with a request id the server answers). It ends bound (the chat it made is current), failed (the
 * existing failure notice shows; no retry) or left (a navigation replaced it). Only a bind of the
 * same generation keeps the draft and releases the one pending send; any other change of the
 * composer's ids stays a navigation.
 */

export type StartupPhase = "starting" | "bound" | "failed" | "left";

export interface ChatIds {
	conversationId: string;
	sessionId: string;
}

export interface StartupAttempt {
	generation: number;
	via: "load" | "new_chat";
	phase: StartupPhase;
	/** via "new_chat": the request the server's new_chat_result answers. */
	reqId?: string;
	/** via "new_chat": the chat the server said it made, while its session is still on the way. */
	confirmedConversationId?: string;
	/** bound / failed: the ids the composer shows from then on. */
	conversationId?: string;
	sessionId?: string;
}

export type StartupEvent =
	/** switch to another chat or project, take over a chat: replaces any attempt. */
	| { type: "navigate" }
	| { type: "new_chat"; reqId: string }
	| { type: "snapshot"; conversationId: string; sessionId: string }
	| { type: "new_chat_result"; reqId: string; ok: boolean; conversationId?: string; current: ChatIds }
	/** the page's first chat could not start (server notice with startupFailed). */
	| { type: "startup_failed"; current: ChatIds };

export const INITIAL_STARTUP: StartupAttempt = { generation: 1, via: "load", phase: "starting" };

const settle = (s: StartupAttempt, phase: "bound" | "failed", ids: ChatIds): StartupAttempt => ({
	generation: s.generation,
	via: s.via,
	phase,
	...(s.reqId ? { reqId: s.reqId } : {}),
	conversationId: ids.conversationId,
	sessionId: ids.sessionId,
});

export function advanceStartup(s: StartupAttempt, e: StartupEvent): StartupAttempt {
	switch (e.type) {
		case "navigate":
			return { generation: s.generation + 1, via: s.via, phase: "left" };
		case "new_chat":
			return { generation: s.generation + 1, via: "new_chat", phase: "starting", reqId: e.reqId };
		case "snapshot": {
			if (s.phase !== "starting" || !e.sessionId) return s;
			if (s.via === "load") return settle(s, "bound", e);
			if (s.confirmedConversationId && s.confirmedConversationId === e.conversationId) return settle(s, "bound", e);
			return s;
		}
		case "new_chat_result": {
			if (s.phase !== "starting" || s.via !== "new_chat" || s.reqId !== e.reqId) return s;
			if (!e.ok) return settle(s, "failed", e.current);
			const target = e.conversationId || e.current.conversationId;
			if (target === e.current.conversationId && e.current.sessionId) return settle(s, "bound", e.current);
			return { ...s, confirmedConversationId: target };
		}
		case "startup_failed":
			if (s.phase !== "starting" || s.via !== "load") return s;
			return settle(s, "failed", e.current);
	}
}

/** The ids the composer works with: none while a chat starts, so it can't reach the old chat. */
export function composerIds(s: StartupAttempt, real: ChatIds, isDsh: boolean): ChatIds {
	if (!isDsh && s.phase === "starting") return { conversationId: "", sessionId: "" };
	return real;
}

/** The left bar's current row ('' = none). While New chat starts, the chat it left is no longer the current
 *  row, so clicking it goes back there (a navigation that cancels a waiting send). The middle pane's title
 *  (chat-title) reads the same row. */
export function leftBarCurrentRowId(s: Pick<StartupAttempt, "via" | "phase">, activeConversationId: string): string {
	return s.via === "new_chat" && s.phase === "starting" ? "" : activeConversationId;
}

/** The key the composer's attachments are reset by: one per attempt until the user leaves its chat. */
export function attachmentScope(s: StartupAttempt, realSessionId: string): string {
	if (s.phase === "starting") return `startup:${s.generation}`;
	if ((s.phase === "bound" || s.phase === "failed") && s.sessionId === realSessionId) return `startup:${s.generation}`;
	return realSessionId;
}

/** What the composer saw last: its ids and the attempt they belonged to. */
export interface SeenIdentity extends ChatIds {
	generation: number;
}

/**
 * A change of the composer's ids that is this attempt binding (or failing back), not a navigation:
 * from the attempt's empty start-up ids to exactly the ids the same generation settled on.
 */
export function isStartupBind(previous: SeenIdentity, next: ChatIds, s: StartupAttempt): boolean {
	return (
		previous.conversationId === "" &&
		previous.sessionId === "" &&
		previous.generation === s.generation &&
		(s.phase === "bound" || s.phase === "failed") &&
		next.conversationId === (s.conversationId ?? "") &&
		next.sessionId === (s.sessionId ?? "")
	);
}

/** The one send waiting for its chat to be ready. */
export interface PendingSend {
	generation: number;
}

/** Enter while a chat starts: wait for it once; a second Enter changes nothing. */
export function requestPendingSend(pending: PendingSend | null, s: StartupAttempt): PendingSend | null {
	if (s.phase !== "starting") return pending;
	return pending ?? { generation: s.generation };
}

/**
 * What happens to a pending send: release it once, when its own attempt bound and the composer can
 * send into that chat; cancel it when another attempt replaced it or the start-up failed or was left.
 */
export function pendingSendFate(
	pending: PendingSend | null,
	s: StartupAttempt,
	composerReady: boolean,
): "none" | "wait" | "release" | "cancel" {
	if (!pending) return "none";
	if (pending.generation !== s.generation) return "cancel";
	if (s.phase === "failed" || s.phase === "left") return "cancel";
	if (s.phase === "bound") return composerReady ? "release" : "wait";
	return "wait";
}
