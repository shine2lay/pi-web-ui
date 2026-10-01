/// <reference lib="dom" />
/**
 * identity-notebook-tab: the right panel's Notebook tab, a module-level store.
 *
 * The tab watches one identity's notebook (`identity_notebook_watch`); the server sends it at once and
 * again whenever the file changes (a chat's notebook tool, the owner, the weekly tidy-up). Here lives
 * the notebook as it is on disk (text, hash, size, cap) and the last save's answer; the draft being
 * typed stays in the panel. Saves carry NOTEBOOK_TAB_REF, so their answers come here and not to
 * Settings -> Identities (identity-state.ts).
 *
 * Same pattern as identity-state.ts: module-level values + listeners + `useSyncExternalStore`; the
 * getter returns a stable reference between changes.
 */
import { useSyncExternalStore } from "react";
import { appSend } from "./app-globals";
import { utf8Bytes } from "./identity-state";
import type { IdentitySaveError, ServerMessage } from "./types";

export type NotebookPayload = Extract<ServerMessage, { type: "identity_notebook" }>;
export type NotebookSavedPayload = Extract<ServerMessage, { type: "identity_file_saved" }>;

/** The ref the tab's saves carry (identity_file_save.ref, echoed in identity_file_saved). */
export const NOTEBOOK_TAB_REF = "notebook-tab";

export interface NotebookState {
	id: string;
	/** loading = asked, not back yet; ready = text/hash are the file on disk; error = couldn't read it. */
	status: "loading" | "ready" | "error";
	text?: string;
	hash?: string;
	size?: number;
	cap?: number;
	error?: string;
	/** A save is on its way. */
	saving: boolean;
	/** The last save's answer (cleared by the next save). */
	saved?: { ok: true } | { ok: false; code: IdentitySaveError };
}

/** The identity the tab shows (null: no tab). */
let watched: string | null = null;
let state: NotebookState | null = null;
/** The text of the save on its way (becomes the notebook's text when the server says ok). */
let pendingText: string | null = null;

const listeners = new Set<() => void>();

function notify(): void {
	for (const l of listeners) l();
}

/** The tab now shows identity `id`'s notebook (null: it closed). Asks the server to watch it. */
export function watchNotebook(id: string | null): void {
	if (id === watched) return;
	watched = id;
	state = id === null ? null : { id, status: "loading", saving: false };
	pendingText = null;
	notify();
	appSend({ type: "identity_notebook_watch", id });
}

/** A new socket (`ready`): the server has forgotten this window's watch, so ask again. A save that was
 *  on its way may have been lost with the old socket: it shows as not saved (the push says what's on disk). */
export function resendNotebookWatch(): void {
	if (watched === null) return;
	if (state?.saving) {
		state = { ...state, saving: false, saved: { ok: false, code: "io" } };
		pendingText = null;
		notify();
	}
	appSend({ type: "identity_notebook_watch", id: watched });
}

/** `identity_notebook` from the server. Only the watched identity counts. */
export function receiveNotebook(payload: NotebookPayload): void {
	if (watched === null || payload.id !== watched) return;
	const keep = { saving: state?.saving ?? false, ...(state?.saved ? { saved: state.saved } : {}) };
	if (typeof payload.error === "string" || typeof payload.text !== "string" || typeof payload.hash !== "string") {
		state = { id: payload.id, status: "error", error: payload.error ?? "", ...keep };
	} else {
		state = {
			id: payload.id,
			status: "ready",
			text: payload.text,
			hash: payload.hash,
			size: typeof payload.size === "number" ? payload.size : utf8Bytes(payload.text),
			...(typeof payload.cap === "number" ? { cap: payload.cap } : {}),
			...keep,
		};
	}
	notify();
}

/** Save the whole notebook. baseHash = the version the draft started from: if the file changed since,
 *  the server refuses ("changed") instead of overwriting. False = not sent (no notebook, a save on its way). */
export function saveNotebook(text: string, baseHash: string): boolean {
	if (!state || state.status !== "ready" || state.saving) return false;
	const id = state.id;
	pendingText = text;
	state = { ...state, saving: true, saved: undefined };
	notify();
	const sent = appSend({ type: "identity_file_save", id, file: "notebook", text, baseHash, ref: NOTEBOOK_TAB_REF });
	if (!sent && state) {
		state = { ...state, saving: false, saved: { ok: false, code: "io" } };
		pendingText = null;
		notify();
	}
	return sent;
}

/** `identity_file_saved` with the tab's ref: ok -> the saved text is the notebook now; refused -> the
 *  panel keeps the draft and says why. */
export function receiveNotebookSaved(payload: NotebookSavedPayload): void {
	if (!state || payload.id !== state.id || payload.file !== "notebook" || !state.saving) return;
	if (payload.ok && typeof payload.hash === "string" && pendingText !== null) {
		state = {
			...state,
			status: "ready",
			text: pendingText,
			hash: payload.hash,
			size: typeof payload.size === "number" ? payload.size : utf8Bytes(pendingText),
			saving: false,
			saved: { ok: true },
		};
	} else {
		state = { ...state, saving: false, saved: { ok: false, code: payload.code ?? "io" } };
	}
	pendingText = null;
	notify();
}

/** Forget the last save's answer (the panel's note goes away). */
export function clearNotebookSaved(): void {
	if (!state?.saved) return;
	state = { ...state, saved: undefined };
	notify();
}

export function subscribeNotebook(cb: () => void): () => void {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
}

export function getNotebook(): NotebookState | null {
	return state;
}

/** The identity the tab watches (tests). */
export function getWatchedNotebook(): string | null {
	return watched;
}

/** Only for unit tests: back to the start (no notifications). */
export function resetNotebookState(): void {
	watched = null;
	state = null;
	pendingText = null;
}

/** The watched notebook (re-renders when it changes). */
export function useNotebook(): NotebookState | null {
	return useSyncExternalStore(subscribeNotebook, getNotebook, getNotebook);
}
