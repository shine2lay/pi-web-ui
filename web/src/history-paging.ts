/** Wire compatibility at the client boundary. The fork's reducer/cache continue to use
 * messagesStart and the same contiguous-page merge, whichever server sent the page. */
import { prependOlderMessages, type OlderMessagesMsg } from "./message-window";
import type { UiMessage, UiState } from "./types";

export interface HistoryFields {
	historyWindow?: { hasEarlier: boolean; hiddenCount: number; earliestIndex: number };
	historyStart?: number;
	historyTotal?: number;
}

function index(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function usesEarlierProtocol(state: HistoryFields): boolean {
	return Boolean(state.historyWindow) || index(state.historyStart);
}

export function normalizeHistoryState(state: UiState & HistoryFields): UiState {
	const start = state.historyWindow?.earliestIndex ?? state.historyStart;
	return index(start) ? { ...state, messagesStart: start } : state;
}

export function hasEarlierMessages(state: UiState & HistoryFields): boolean {
	return (state.messagesStart ?? 0) > 0 && state.historyWindow?.hasEarlier !== false;
}

export function earlierRequest(conversationId: string, beforeIndex: number, count = 30) {
	return { type: "load_earlier_messages" as const, conversationId, beforeIndex, limit: count, count };
}

export type EarlierPage = OlderMessagesMsg & HistoryFields & { sessionId?: string };

// One browser owns one chat connection. A monotonic cancellation generation
// survives batched disconnect/reconnect events with the same final identity.
let cancellationGeneration = 0;
const cancellationListeners = new Set<() => void>();
export const earlierPageGeneration = () => cancellationGeneration;
export function subscribeEarlierPageCancellation(listener: () => void): () => void {
	cancellationListeners.add(listener);
	return () => {
		cancellationListeners.delete(listener);
	};
}

/** requestedBefore is the captured request boundary, never a moving render cursor. */
export function readEarlierPage(value: unknown, requestedBefore?: number): EarlierPage | null {
	if (!value || typeof value !== "object") return null;
	const page = value as {
		type?: string;
		conversationId?: string;
		sessionId?: string;
		messages?: UiMessage[];
		start?: number;
	} & HistoryFields &
		Pick<OlderMessagesMsg, "straddle" | "quietLead">;
	if (page.type !== "earlier_messages" || typeof page.conversationId !== "string" || !Array.isArray(page.messages))
		return null;
	const start =
		page.historyWindow?.earliestIndex ??
		page.historyStart ??
		page.start ??
		(requestedBefore === undefined ? undefined : requestedBefore - page.messages.length);
	if (!index(start)) return null;
	return {
		conversationId: page.conversationId,
		start,
		messages: page.messages,
		...(page.straddle ? { straddle: page.straddle } : {}),
		...(page.quietLead ? { quietLead: page.quietLead } : {}),
		...(typeof page.sessionId === "string" ? { sessionId: page.sessionId } : {}),
		...(page.historyWindow ? { historyWindow: page.historyWindow } : {}),
	};
}

/** One request at a time on this socket. Consuming happens before dispatch, so
 * duplicate events cannot reuse a boundary even when React has not rendered yet. */
export class EarlierPageRequests {
	private scope: { conversationId: string; sessionId: string } | null = null;
	private pending: { conversationId: string; sessionId: string; before: number; count: number } | null = null;
	private completedBefore: number | null = null;
	private abandoned = new Map<string, Set<string>>();

	bind(state: Pick<UiState, "conversationId" | "sessionId">): void {
		if (this.scope?.conversationId === state.conversationId && this.scope.sessionId === state.sessionId) return;
		this.cancel();
		this.scope = { conversationId: state.conversationId, sessionId: state.sessionId };
	}

	cancel(): void {
		// Without a wire request id, a late unpositioned reply after leaving a
		// request behind cannot be distinguished from a new request's reply.
		// Completed-page duplicates also matter across session replacement.
		const retired = this.pending ?? (this.completedBefore !== null ? this.scope : null);
		if (retired) {
			const sessions = this.abandoned.get(retired.conversationId) ?? new Set<string>();
			sessions.add(retired.sessionId);
			this.abandoned.set(retired.conversationId, sessions);
		}
		this.pending = null;
		this.completedBefore = null;
		cancellationGeneration++;
		for (const listener of cancellationListeners) listener();
	}

	request(state: UiState, before: number, count = 30): boolean {
		this.bind(state);
		if (!index(before) || before === 0 || before !== (state.messagesStart ?? 0) || !index(count) || count === 0)
			return false;
		if (this.pending || this.completedBefore === before) return false;
		this.pending = { conversationId: state.conversationId, sessionId: state.sessionId, before, count };
		return true;
	}

	receive(value: unknown, state: UiState | null): EarlierPage | null {
		const request = this.pending;
		if (!request || !state || state.conversationId !== request.conversationId || state.sessionId !== request.sessionId)
			return null;
		const abandoned = this.abandoned.get(request.conversationId);
		const page = readEarlierPage(value, abandoned ? undefined : request.before);
		if (!page || page.conversationId !== request.conversationId) return null;
		if (page.sessionId !== undefined && page.sessionId !== request.sessionId) return null;
		// A position alone cannot distinguish two sessions in the same slot.
		// Such replies need an echoed session id (or a fresh socket), not a guess.
		if (abandoned && [...abandoned].some((session) => session !== request.sessionId) && page.sessionId === undefined)
			return null;
		if (page.messages.length > request.count || page.start + page.messages.length !== request.before) return null;
		// An old unpositioned reply can arrive while the *next* request is pending.
		// Its IDs reveal that it is not that page; do not consume the real request.
		if (!mergeEarlierPage(state, page)) return null;
		this.pending = null;
		this.completedBefore = request.before;
		return { ...page, sessionId: request.sessionId };
	}
}

/** Keep both protocol spellings coherent after an accepted, contiguous prepend. */
export function mergeEarlierPage(state: UiState & HistoryFields, page: EarlierPage): UiState | null {
	if (page.sessionId !== undefined && page.sessionId !== state.sessionId) return null;
	const ids = new Set(state.messages.map((message) => message.id));
	for (const message of page.messages) {
		if (typeof message?.id !== "string" || ids.has(message.id)) return null;
		ids.add(message.id);
	}
	const next = prependOlderMessages(state, page);
	if (!next || (!state.historyWindow && !page.historyWindow)) return next;
	return {
		...next,
		historyWindow: {
			hasEarlier: page.historyWindow?.hasEarlier ?? page.start > 0,
			hiddenCount: page.historyWindow?.hiddenCount ?? page.start,
			earliestIndex: page.start,
		},
	} as UiState & HistoryFields;
}

/** Pure scroll math used after a prepend, including when the user moved during the request. */
export function scrollAfterPrepend(scrollTop: number, previousHeight: number, nextHeight: number): number {
	return scrollTop + Math.max(0, nextHeight - previousHeight);
}
