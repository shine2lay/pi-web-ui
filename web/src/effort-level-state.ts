/// <reference lib="dom" />
/**
 * effort-level-button (PATCHES.md): the composer's "Department effort level" button's data, per chat. The window
 * asks for the chat it shows (`get_effort_levels`) when it opens it, and once each socket's session is initialized
 * (the server refuses anything sent while it replays a new socket's startup commands); the server answers with
 * `effort_levels`, and pushes the same message to every window showing the chat after a pick. A module store in the
 * work-page-state.ts pattern (module values + listeners + `useSyncExternalStore`, a stable snapshot between changes).
 */
import { useEffect, useSyncExternalStore } from "react";
import type { EffortTier, UiEffortLevels } from "../../server/effort-level-protocol";
import { appSend } from "./app-globals";
import type { ServerMessage } from "./types";

export type EffortLevelsMsg = Extract<ServerMessage, { type: "effort_levels" }>;

/** What the button shows for one chat. */
export interface EffortLevelsView {
	levels: UiEffortLevels;
	/** The last pick's refusal or failed switch, shown in the menu until the next answer. */
	error?: string;
	/** The last pick: "next-turn" = the chat is busy and switches at its next turn start. */
	applied?: "now" | "next-turn";
	/** A pick was sent and its answer hasn't come yet. */
	pending?: boolean;
}

const byChat = new Map<string, EffortLevelsView>();
const listeners = new Set<() => void>();

function put(conversationId: string, view: EffortLevelsView): void {
	byChat.set(conversationId, view);
	for (const l of listeners) l();
}

/** `effort_levels` from the server: an answer to this window, or a push after a pick elsewhere. */
export function receiveEffortLevels(msg: EffortLevelsMsg): void {
	if (!msg.conversationId) return;
	put(msg.conversationId, { levels: msg.levels, error: msg.error, applied: msg.applied });
}

/** The owner's pick for the chat; `null` = "Back to department default". False when the socket is down. */
export function pickEffortLevel(conversationId: string, tier: EffortTier | null): boolean {
	if (!appSend({ type: "set_effort_level", conversationId, tier })) return false;
	const cur = byChat.get(conversationId);
	if (cur) put(conversationId, { ...cur, pending: true, error: undefined, applied: undefined });
	return true;
}

function subscribe(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

let initialized = false;
let shown: string | undefined;
const ask = () => shown && initialized && appSend({ type: "get_effort_levels", conversationId: shown });

/** use-chat: false at a socket's `ready` (its startup commands still replay), true once its session is initialized. */
export function effortLevelsSession(ready: boolean): void {
	initialized = ready;
	ask();
}

/** The chat the composer shows; asks for it when it changes and the session is initialized. */
export function showEffortLevelsChat(conversationId: string | undefined): void {
	if (conversationId === shown) return;
	shown = conversationId;
	ask();
}

/** The chat's levels; asks the server whenever the chat changes or the session (re)initializes. undefined: no answer yet. */
export function useEffortLevels(conversationId: string | undefined): EffortLevelsView | undefined {
	useEffect(() => showEffortLevelsChat(conversationId), [conversationId]);
	const snap = () => (conversationId ? byChat.get(conversationId) : undefined);
	return useSyncExternalStore(subscribe, snap, snap);
}
