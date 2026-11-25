/// <reference lib="dom" />
/**
 * The waiting-questions bell (Ops #1090, Shine 2026-11-25 m104486 + m104524): this window's list of the questions
 * waiting on its owner, from any chat. The server pushes the whole list (`owner_asks`, already filtered to this
 * window's owner, never another owner's nor one held for COO) when the window connects and after every change; the
 * top bar's bell shows its count and WaitingQuestionsModal the list. Opening and answering go through
 * roles-answer-state.ts (OWNER_ASK_CHANNEL).
 *
 * A module-level store like roles-state.ts: values + listeners + `useSyncExternalStore`; the getter returns a stable
 * reference between changes.
 */
import { useSyncExternalStore } from "react";
import type { Translate } from "./i18n";
import { agoOf } from "./roles-view-model";
import type { NeedsYouItem, UsefulOpenTarget } from "./roles-useful-model";
import type { ServerMessage, UiOwnerAskItem } from "./types";

export interface OwnerAsksState {
	asks: readonly UiOwnerAskItem[];
	/** The server sent this window its list since it connected. */
	received: boolean;
}

let state: OwnerAsksState = { asks: [], received: false };
const listeners = new Set<() => void>();

function set(next: OwnerAsksState): void {
	state = next;
	for (const l of listeners) l();
}

/** The server's whole list for this window (replaces the one before). */
export function receiveOwnerAsks(msg: Extract<ServerMessage, { type: "owner_asks" }>): void {
	set({ asks: Array.isArray(msg.asks) ? msg.asks : [], received: true });
}

/** The socket dropped: the list stays on screen but is marked not current until the server sends it again. */
export function disconnectOwnerAsks(): void {
	if (state.received) set({ ...state, received: false });
}

export function getOwnerAsks(): OwnerAsksState {
	return state;
}

function subscribe(l: () => void): () => void {
	listeners.add(l);
	return () => listeners.delete(l);
}

export function useOwnerAsks(): OwnerAsksState {
	return useSyncExternalStore(subscribe, getOwnerAsks, getOwnerAsks);
}

/** The bell's tooltip and label: "2 questions waiting for you" / "No questions waiting". */
export function bellLabel(t: Translate, count: number): string {
	if (count <= 0) return t("waitingQuestionsNone");
	return count === 1 ? t("waitingQuestionsOne") : t("waitingQuestionsMany", { n: count });
}

/** The badge's text: the count, "99+" past 99, nothing at 0. */
export function bellBadge(count: number): string | null {
	if (count <= 0) return null;
	return count > 99 ? "99+" : String(count);
}

type Key = Parameters<Translate>[0];
const KIND_KEY: Record<UiOwnerAskItem["kind"], Key> = {
	question: "waitingQuestionsKindQuestion",
	dialog: "waitingQuestionsKindDialog",
	approval: "waitingQuestionsKindApproval",
	stuck: "waitingQuestionsKindStuck",
};
export const ownerAskKindKey = (kind: UiOwnerAskItem["kind"]): Key => KIND_KEY[kind] ?? KIND_KEY.question;

/** Who asks: the role's name, else the chat's title, else "A chat". */
export function ownerAskWho(item: UiOwnerAskItem, t: Translate): string {
	return item.roleTitle || item.conversationTitle || t("waitingQuestionsChat");
}

/** "just now", "14m ago"; nothing for a time that isn't one. */
export function ownerAskAge(item: UiOwnerAskItem, now: number): string {
	return Number.isFinite(item.createdAt) && item.createdAt > 0 ? agoOf(item.createdAt, now) : "";
}

/** The asking chat to open, at its question; null when the list doesn't know the chat's transcript. */
export function ownerAskOpenTarget(item: UiOwnerAskItem): UsefulOpenTarget | null {
	if (!item.sessionFile) return null;
	return { file: item.sessionFile, focus: { kind: "question", id: item.askId } };
}

/** The item as the Answer dialog (RoleAnswerDialog over OWNER_ASK_CHANNEL) takes it: `key` is the ask's id. */
export function ownerAskDialogItem(item: UiOwnerAskItem, t: Translate): NeedsYouItem {
	return {
		roleId: item.roleId ?? null,
		key: item.askId,
		answer: { key: item.askId, id: item.askId },
		roleLabel: ownerAskWho(item, t),
		text: item.summary ?? item.title,
		since: Number.isFinite(item.createdAt) ? item.createdAt : null,
		link: ownerAskOpenTarget(item),
	};
}
