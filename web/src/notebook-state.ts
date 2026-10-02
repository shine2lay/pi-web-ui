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
 *
 * identity-notes: pi-identity's second layer too. The push carries `memory` (the notes index and what
 * rules + index take); `notes` here is the tab's list or search (identity_notes_search) and the note it
 * has open (identity_note_get), with its edit or delete on the way. A push whose notes changed (a chat
 * recorded one) re-runs the list or search, so the tab stays live.
 */
import { useSyncExternalStore } from "react";
import { appSend } from "./app-globals";
import { utf8Bytes } from "./identity-state";
import type { IdentitySaveError, ServerMessage, UiNoteHit, UiRoleMemory } from "./types";

export type NotebookPayload = Extract<ServerMessage, { type: "identity_notebook" }>;
export type NotebookSavedPayload = Extract<ServerMessage, { type: "identity_file_saved" }>;
export type NotesFoundPayload = Extract<ServerMessage, { type: "identity_notes_found" }>;
export type NotePayload = Extract<ServerMessage, { type: "identity_note" }>;
export type NoteSavedPayload = Extract<ServerMessage, { type: "identity_note_saved" }>;

/** identity-notes: the note the tab has open. */
export interface OpenNote {
	ref: string;
	status: "loading" | "ready" | "error";
	text?: string;
	hash?: string;
	size?: number;
	/** A note (an old archive stretch isn't). */
	editable?: boolean;
	error?: string;
	/** An edit or a delete is on its way. */
	busy: "save" | "delete" | null;
	/** The last edit's answer (cleared by the next). */
	done?: { ok: true } | { ok: false; code: IdentitySaveError; problems?: string[] };
}

/** identity-notes: the tab's notes list (query "") or search, and the open note. */
export interface NotesView {
	query: string;
	/** idle = not asked yet. */
	status: "idle" | "loading" | "ready" | "error";
	hits: UiNoteHit[];
	/** How many notes the role has. */
	total: number;
	error?: string;
	open: OpenNote | null;
	/** The note the owner just deleted (says so until the next open or search). */
	deleted?: string;
}

const blankNotes = (): NotesView => ({ query: "", status: "idle", hits: [], total: 0, open: null });

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
	/** identity-notes: the notes index and what rules + index take. */
	memory?: UiRoleMemory;
	error?: string;
	/** identity-notes: the list or search, and the open note. */
	notes: NotesView;
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
	state = id === null ? null : { id, status: "loading", notes: blankNotes(), saving: false };
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
	// identity-notes: an edit or delete on its way may be lost too; a list or search is asked again.
	const open = state?.notes.open;
	if (state && open?.busy) {
		state = { ...state, notes: { ...state.notes, open: { ...open, busy: null, done: { ok: false, code: "io" } } } };
		notify();
	}
	appSend({ type: "identity_notebook_watch", id: watched });
	if (state && state.notes.status !== "idle")
		appSend({ type: "identity_notes_search", id: watched, query: state.notes.query });
	if (state?.notes.open?.status === "loading")
		appSend({ type: "identity_note_get", id: watched, ref: state.notes.open.ref });
}

/** `identity_notebook` from the server. Only the watched identity counts. */
export function receiveNotebook(payload: NotebookPayload): void {
	if (watched === null || payload.id !== watched) return;
	const notes = state?.notes ?? blankNotes();
	const keep = { notes, saving: state?.saving ?? false, ...(state?.saved ? { saved: state.saved } : {}) };
	const before = state?.memory?.notesVersion;
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
			...(payload.memory ? { memory: payload.memory } : {}),
			...keep,
		};
	}
	notify();
	// identity-notes: the notes changed (a chat recorded, edited or distilled one): the list follows.
	const after = payload.memory?.notesVersion;
	if (before !== undefined && after !== undefined && before !== after && notes.status !== "idle") {
		refreshNotes();
	}
}

// ---------------------------------------------------------------------------
// identity-notes: list, search, open, edit, delete
// ---------------------------------------------------------------------------

function setNotes(next: NotesView): void {
	if (!state) return;
	state = { ...state, notes: next };
	notify();
}

/** List the notes (query "": newest first) or search them. False = not sent (no tab, or offline). */
export function searchNotes(query: string): boolean {
	return askNotes(query, true);
}

/** The list follows a change (a delete, a chat's record): "... deleted" stays up, unlike the owner's own search. */
function refreshNotes(): boolean {
	return state ? askNotes(state.notes.query, false) : false;
}

function askNotes(query: string, owner: boolean): boolean {
	if (!state || watched === null) return false;
	const q = query.trim();
	setNotes({ ...state.notes, query: q, status: "loading", error: undefined, ...(owner ? { deleted: undefined } : {}) });
	const sent = appSend({ type: "identity_notes_search", id: watched, query: q });
	if (!sent && state) setNotes({ ...state.notes, status: "error", error: "offline" });
	return sent;
}

/** `identity_notes_found`: only the answer to the tab's current query counts. */
export function receiveNotesFound(payload: NotesFoundPayload): void {
	if (!state || payload.id !== state.id || payload.query !== state.notes.query) return;
	setNotes({
		...state.notes,
		status: typeof payload.error === "string" ? "error" : "ready",
		hits: Array.isArray(payload.hits) ? payload.hits : [],
		total: typeof payload.total === "number" ? payload.total : 0,
		...(typeof payload.error === "string" ? { error: payload.error } : { error: undefined }),
	});
}

/** Open a note (or an old archive stretch). */
export function openNote(ref: string): boolean {
	if (!state || watched === null) return false;
	setNotes({ ...state.notes, open: { ref, status: "loading", busy: null }, deleted: undefined });
	const sent = appSend({ type: "identity_note_get", id: watched, ref });
	if (!sent && state?.notes.open)
		setNotes({ ...state.notes, open: { ...state.notes.open, status: "error", error: "offline" } });
	return sent;
}

/** `identity_note`: the open note's text (only the one the tab asked for). */
export function receiveNote(payload: NotePayload): void {
	const open = state?.notes.open;
	if (!state || !open || payload.id !== state.id || payload.ref !== open.ref) return;
	if (typeof payload.error === "string" || typeof payload.text !== "string" || typeof payload.hash !== "string") {
		setNotes({ ...state.notes, open: { ...open, status: "error", error: payload.error ?? "" } });
		return;
	}
	setNotes({
		...state.notes,
		open: {
			...open,
			status: "ready",
			text: payload.text,
			hash: payload.hash,
			size: typeof payload.size === "number" ? payload.size : utf8Bytes(payload.text),
			editable: payload.editable === true,
			error: undefined,
		},
	});
}

export function closeNote(): void {
	if (!state?.notes.open) return;
	setNotes({ ...state.notes, open: null });
}

/** Save the open note as edited (its whole file). False = not sent. */
export function saveOpenNote(text: string): boolean {
	const open = state?.notes.open;
	if (!state || watched === null || !open || open.status !== "ready" || !open.editable || open.busy || !open.hash)
		return false;
	setNotes({ ...state.notes, open: { ...open, busy: "save", done: undefined } });
	const sent = appSend({ type: "identity_note_save", id: watched, ref: open.ref, text, baseHash: open.hash });
	if (!sent && state?.notes.open) {
		setNotes({ ...state.notes, open: { ...state.notes.open, busy: null, done: { ok: false, code: "io" } } });
	}
	return sent;
}

/** Delete the open note (it goes to removed.md). False = not sent. */
export function deleteOpenNote(): boolean {
	const open = state?.notes.open;
	if (!state || watched === null || !open || open.status !== "ready" || !open.editable || open.busy || !open.hash)
		return false;
	setNotes({ ...state.notes, open: { ...open, busy: "delete", done: undefined } });
	const sent = appSend({ type: "identity_note_delete", id: watched, ref: open.ref, baseHash: open.hash });
	if (!sent && state?.notes.open) {
		setNotes({ ...state.notes, open: { ...state.notes.open, busy: null, done: { ok: false, code: "io" } } });
	}
	return sent;
}

/** `identity_note_saved`: an edit -> the note is read again (the server writes it in its own layout);
 *  a delete -> the note closes and the tab says so; refused -> why. The list follows either way. */
export function receiveNoteSaved(payload: NoteSavedPayload): void {
	const open = state?.notes.open;
	if (!state || !open || payload.id !== state.id || payload.ref !== open.ref || !open.busy) return;
	if (!payload.ok) {
		const done = {
			ok: false as const,
			code: payload.code ?? "io",
			...(payload.problems ? { problems: payload.problems } : {}),
		};
		setNotes({ ...state.notes, open: { ...open, busy: null, done } });
		return;
	}
	if (open.busy === "delete") {
		setNotes({ ...state.notes, open: null, deleted: open.ref });
		refreshNotes();
		return;
	}
	setNotes({
		...state.notes,
		open: {
			...open,
			busy: null,
			done: { ok: true },
			...(typeof payload.hash === "string" ? { hash: payload.hash } : {}),
		},
	});
	if (watched !== null) appSend({ type: "identity_note_get", id: watched, ref: open.ref });
	refreshNotes();
}

/** Forget the open note's last answer. */
export function clearNoteDone(): void {
	const open = state?.notes.open;
	if (!state || !open?.done) return;
	setNotes({ ...state.notes, open: { ...open, done: undefined } });
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
