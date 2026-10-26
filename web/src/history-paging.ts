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

export type EarlierPage = OlderMessagesMsg & HistoryFields;

export function readEarlierPage(value: unknown, currentStart: number): EarlierPage | null {
	if (!value || typeof value !== "object") return null;
	const page = value as {
		type?: string;
		conversationId?: string;
		messages?: UiMessage[];
		start?: number;
	} & HistoryFields;
	if (page.type !== "earlier_messages" || typeof page.conversationId !== "string" || !Array.isArray(page.messages))
		return null;
	const start =
		page.historyWindow?.earliestIndex ?? page.historyStart ?? page.start ?? currentStart - page.messages.length;
	if (!index(start)) return null;
	return {
		conversationId: page.conversationId,
		start,
		messages: page.messages,
		...(page.historyWindow ? { historyWindow: page.historyWindow } : {}),
	};
}

/** Keep both protocol spellings coherent after an accepted, contiguous prepend. */
export function mergeEarlierPage(state: UiState & HistoryFields, page: EarlierPage): UiState | null {
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
