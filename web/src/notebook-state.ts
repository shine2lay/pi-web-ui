/// <reference lib="dom" />
/** The live notebook/notes store, with separately owned authored edits and save attempts.
 * Reads and deletes remain transient. Admission never means server persistence, and reconnect never
 * replays a save. Drafts/attempts survive view teardown in this module; #570 owns durable recovery. */
import { useSyncExternalStore } from "react";
import { appAdmit } from "./app-admit";
import { appSend } from "./app-globals";
import { utf8Bytes } from "./identity-state";
import type { ClientMessage, IdentitySaveError, ServerMessage, UiNoteHit, UiRoleMemory } from "./types";

export type NotebookPayload = Extract<ServerMessage, { type: "identity_notebook" }>;
// Additive local boundary until #570 installs the optional echo in the shared wire protocol.
// An absent echo is never invented from the currently active request.
export type NotebookSavedPayload = Extract<ServerMessage, { type: "identity_file_saved" }> & { reqId?: string };
export type NotesFoundPayload = Extract<ServerMessage, { type: "identity_notes_found" }>;
export type NotePayload = Extract<ServerMessage, { type: "identity_note" }> & { reqId?: string };
export type NoteSavedPayload = Extract<ServerMessage, { type: "identity_note_saved" }> & { reqId?: string };
type NotebookSaveMessage = Extract<ClientMessage, { type: "identity_file_save" }> & { reqId: string };
type NoteSaveMessage = Extract<ClientMessage, { type: "identity_note_save" }> & { reqId: string };
type NoteReadMessage = Extract<ClientMessage, { type: "identity_note_get" }> & { reqId: string };
type NoteDeleteMessage = Extract<ClientMessage, { type: "identity_note_delete" }> & { reqId: string };

export interface NotebookDraft {
	readonly text: string;
	readonly base: string;
	/** Every edit advances this, even A -> B -> A. Reopening also advances it. */
	readonly generation: number;
}

export interface NotebookSaveAttempt {
	readonly message: Readonly<NotebookSaveMessage | NoteSaveMessage>;
	readonly viewGeneration: number;
	readonly openGeneration?: number;
	readonly editGeneration?: number;
	readonly phase: "admitting" | "awaiting" | "unknown" | "refused" | "saved";
	readonly receipt?: NotebookSavedPayload | NoteSavedPayload;
}

type SaveResult = ({ ok: true } | { ok: false; code: IdentitySaveError; problems?: string[] }) & { reqId?: string };

export interface OpenNote {
	ref: string;
	generation: number;
	status: "loading" | "ready" | "error";
	text?: string;
	hash?: string;
	size?: number;
	editable?: boolean;
	error?: string;
	busy: "save" | "delete" | null;
	done?: SaveResult;
	draft?: NotebookDraft;
	save?: NotebookSaveAttempt;
	readReqId?: string;
	deleteReqId?: string;
	/** Transport acceptance is not evidence of deletion. */
	deleteUnknown?: boolean;
}

export interface NotesView {
	query: string;
	status: "idle" | "loading" | "ready" | "error";
	hits: UiNoteHit[];
	total: number;
	error?: string;
	open: OpenNote | null;
	deleted?: string;
}
const blankNotes = (): NotesView => ({ query: "", status: "idle", hits: [], total: 0, open: null });
export const NOTEBOOK_TAB_REF = "notebook-tab";
export const NOTEBOOK_SAVE_UNKNOWN =
	"Save outcome unknown. Your edits are kept; check the current version before saving again.";
export const NOTE_DELETE_UNKNOWN = "Delete outcome unknown. Check the current note before trying again.";

export interface NotebookState {
	id: string;
	generation: number;
	status: "loading" | "ready" | "error";
	text?: string;
	hash?: string;
	size?: number;
	cap?: number;
	memory?: UiRoleMemory;
	error?: string;
	notes: NotesView;
	saving: boolean;
	saved?: SaveResult;
	draft?: NotebookDraft;
	save?: NotebookSaveAttempt;
}

let watched: string | null = null;
let state: NotebookState | null = null;
let generation = 0;
// Authored edits only, not copies of fetched notebooks, notes, archives or search results.
const drafts = new Map<string, NotebookDraft>();
// Keep exact originals even after failure/unknown/teardown. Not a durable journal or replay queue.
const attempts = new Map<string, NotebookSaveAttempt>();
const listeners = new Set<() => void>();
const resource = (id: string, ref?: string): string => JSON.stringify([id, ref ?? null]);
const nextGeneration = (): number => ++generation;
const requestId = (): string => crypto.randomUUID();
function notify(): void {
	for (const l of listeners) l();
}
function setNotes(next: NotesView): void {
	if (!state) return;
	state = { ...state, notes: next };
	notify();
}
/** A transient send can throw after possible delivery. No fallback or false execution claim. */
function sendTransient(msg: ClientMessage): boolean {
	try {
		return appSend(msg) === true;
	} catch {
		return false;
	}
}
function restoreDraft(id: string, ref?: string): NotebookDraft | undefined {
	const key = resource(id, ref);
	const previous = drafts.get(key);
	if (!previous) return undefined;
	const draft = { ...previous, generation: nextGeneration() };
	drafts.set(key, draft);
	return draft;
}
function owns(attempt: NotebookSaveAttempt): boolean {
	if (!state || state.id !== attempt.message.id || state.generation !== attempt.viewGeneration) return false;
	return attempt.message.type === "identity_file_save"
		? state.save?.message.reqId === attempt.message.reqId
		: state.notes.open?.ref === attempt.message.ref &&
				state.notes.open.generation === attempt.openGeneration &&
				state.notes.open.save?.message.reqId === attempt.message.reqId;
}
function publishAttempt(attempt: NotebookSaveAttempt, result?: SaveResult): void {
	attempts.set(attempt.message.reqId, attempt);
	if (!owns(attempt) || !state) return;
	const busy = attempt.phase === "admitting" || attempt.phase === "awaiting";
	if (attempt.message.type === "identity_file_save") {
		state = { ...state, save: attempt, saving: busy, saved: result };
		notify();
	} else if (state.notes.open) {
		setNotes({
			...state.notes,
			open: { ...state.notes.open, save: attempt, busy: busy ? "save" : null, done: result },
		});
	}
}

function detach(attempt?: NotebookSaveAttempt): void {
	if (attempt && (attempt.phase === "admitting" || attempt.phase === "awaiting"))
		attempts.set(attempt.message.reqId, { ...attempt, phase: "unknown" });
}

/** Watch only the current view, while preserving independently owned authored work. */
export function watchNotebook(id: string | null): void {
	if (id === watched) return;
	detach(state?.save);
	detach(state?.notes.open?.save);
	watched = id;
	state =
		id === null
			? null
			: {
					id,
					generation: nextGeneration(),
					status: "loading",
					notes: blankNotes(),
					saving: false,
					draft: restoreDraft(id),
				};
	notify();
	if (!sendTransient({ type: "identity_notebook_watch", id }) && state?.id === id) {
		state = { ...state, status: "error", error: "offline" };
		notify();
	}
}

/** Reconnect restores observations only, never authored saves or deletes. */
export function resendNotebookWatch(): void {
	if (watched === null || !state) return;
	for (const attempt of [state.save, state.notes.open?.save]) {
		if (attempt && (attempt.phase === "admitting" || attempt.phase === "awaiting"))
			publishAttempt({ ...attempt, phase: "unknown" }, { ok: false, code: "io", reqId: attempt.message.reqId });
	}
	const open = state.notes.open;
	if (open?.busy === "delete") {
		setNotes({
			...state.notes,
			open: { ...open, busy: null, deleteReqId: undefined, deleteUnknown: true, done: { ok: false, code: "io" } },
		});
	}
	if (!sendTransient({ type: "identity_notebook_watch", id: watched })) {
		state = { ...state, status: state.status === "ready" ? "ready" : "error", error: "offline" };
		notify();
	}
	if (state.notes.status !== "idle") refreshNotes();
	if (state.notes.open?.status === "loading") readOpenNote();
}

/** Live notebook pushes are observations, not save acknowledgements. Never change a draft here. */
export function receiveNotebook(payload: NotebookPayload): void {
	if (!state || watched === null || payload.id !== watched) return;
	const before = state.memory?.notesVersion;
	if (typeof payload.error === "string" || typeof payload.text !== "string" || typeof payload.hash !== "string") {
		state = { ...state, status: state.status === "ready" ? "ready" : "error", error: payload.error ?? "" };
	} else {
		state = {
			...state,
			status: "ready",
			text: payload.text,
			hash: payload.hash,
			error: undefined,
			size: typeof payload.size === "number" ? payload.size : utf8Bytes(payload.text),
			cap: payload.cap,
			memory: payload.memory,
		};
	}
	notify();
	const after = payload.memory?.notesVersion;
	if (before !== undefined && after !== undefined && before !== after && state.notes.status !== "idle") refreshNotes();
}

/** Explicit Edit, input, Load-new and Cancel actions own draft creation/replacement. */
export function editNotebook(text = state?.text, base = state?.hash): void {
	if (!state || state.status !== "ready" || typeof text !== "string" || typeof base !== "string") return;
	const draft = { text, base, generation: nextGeneration() };
	drafts.set(resource(state.id), draft);
	state = { ...state, draft, saved: undefined };
	notify();
}
export function changeNotebookDraft(text: string): void {
	if (state?.draft) editNotebook(text, state.draft.base);
}
export function cancelNotebookEdit(): void {
	if (!state || state.saving) return;
	drafts.delete(resource(state.id));
	state = { ...state, draft: undefined };
	notify();
}
export function editOpenNote(text = state?.notes.open?.text, base = state?.notes.open?.hash): void {
	const open = state?.notes.open;
	if (
		!state ||
		!open ||
		open.status !== "ready" ||
		!open.editable ||
		typeof text !== "string" ||
		typeof base !== "string"
	)
		return;
	const draft = { text, base, generation: nextGeneration() };
	drafts.set(resource(state.id, open.ref), draft);
	setNotes({ ...state.notes, open: { ...open, draft, done: undefined } });
}
export function changeOpenNoteDraft(text: string): void {
	const draft = state?.notes.open?.draft;
	if (draft) editOpenNote(text, draft.base);
}
export function cancelOpenNoteEdit(): void {
	const open = state?.notes.open;
	if (!state || !open || open.busy) return;
	drafts.delete(resource(state.id, open.ref));
	setNotes({ ...state.notes, open: { ...open, draft: undefined } });
}

export function searchNotes(query: string): boolean {
	return askNotes(query, true);
}
function refreshNotes(): boolean {
	return state ? askNotes(state.notes.query, false) : false;
}
function askNotes(query: string, owner: boolean): boolean {
	if (!state || watched === null) return false;
	const id = state.id,
		view = state.generation,
		q = query.trim();
	setNotes({ ...state.notes, query: q, status: "loading", error: undefined, ...(owner ? { deleted: undefined } : {}) });
	const sent = sendTransient({ type: "identity_notes_search", id, query: q });
	if (!sent && state?.generation === view && state.notes.query === q)
		setNotes({ ...state.notes, status: "error", error: "offline" });
	return sent;
}
export function receiveNotesFound(payload: NotesFoundPayload): void {
	if (!state || payload.id !== state.id || payload.query !== state.notes.query) return;
	setNotes({
		...state.notes,
		status: typeof payload.error === "string" ? "error" : "ready",
		hits: Array.isArray(payload.hits) ? payload.hits : [],
		total: typeof payload.total === "number" ? payload.total : 0,
		error: payload.error,
	});
}

export function openNote(ref: string): boolean {
	if (!state || watched === null) return false;
	detach(state.notes.open?.save);
	setNotes({
		...state.notes,
		open: {
			ref,
			generation: nextGeneration(),
			status: "loading",
			busy: null,
			draft: restoreDraft(state.id, ref),
		},
		deleted: undefined,
	});
	return readOpenNote();
}
function readOpenNote(): boolean {
	const open = state?.notes.open;
	if (!state || !open) return false;
	const msg: NoteReadMessage = { type: "identity_note_get", id: state.id, ref: open.ref, reqId: requestId() };
	const view = state.generation;
	setNotes({ ...state.notes, open: { ...open, readReqId: msg.reqId } });
	const sent = sendTransient(msg);
	if (!sent && state?.generation === view && state.notes.open?.readReqId === msg.reqId)
		setNotes({
			...state.notes,
			open: { ...state.notes.open, status: open.status === "ready" ? "ready" : "error", error: "offline" },
		});
	return sent;
}
/** Same-ref reads/reloads must echo the particular request; a watch cannot stand in for it. */
export function receiveNote(payload: NotePayload): void {
	const open = state?.notes.open;
	if (
		!state ||
		!open ||
		payload.id !== state.id ||
		payload.ref !== open.ref ||
		!open.readReqId ||
		payload.reqId !== open.readReqId
	)
		return;
	if (typeof payload.error === "string" || typeof payload.text !== "string" || typeof payload.hash !== "string") {
		setNotes({
			...state.notes,
			open: {
				...open,
				readReqId: undefined,
				status: open.status === "ready" ? "ready" : "error",
				error: payload.error ?? "",
			},
		});
		return;
	}
	setNotes({
		...state.notes,
		open: {
			...open,
			readReqId: undefined,
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
	detach(state.notes.open.save);
	setNotes({ ...state.notes, open: null });
}

/** Admission is separate from the real result; early receipts wait for its exact true. */
async function admit(attempt: NotebookSaveAttempt): Promise<boolean> {
	let admitted = false;
	try {
		admitted = (await appAdmit(attempt.message)) === true;
	} catch {
		/* possibly committed/delivered */
	}
	const current = attempts.get(attempt.message.reqId);
	// Reconnect/another terminal outcome must not be overwritten by this continuation.
	if (!current || current.phase !== "admitting") return admitted;
	if (!admitted) {
		publishAttempt({ ...current, phase: "unknown" }, { ok: false, code: "io", reqId: attempt.message.reqId });
		return false;
	}
	publishAttempt({ ...current, phase: "awaiting" });
	if (current.receipt?.type === "identity_file_saved") receiveNotebookSaved(current.receipt);
	else if (current.receipt?.type === "identity_note_saved") receiveNoteSaved(current.receipt);
	return true;
}

/** Capture exact original text/base and generations before the first await. No appSend fallback. */
export async function saveNotebook(
	text: string,
	baseHash: string,
	editGeneration = state?.draft?.generation,
): Promise<boolean> {
	if (!state || state.status !== "ready" || state.saving) return false;
	if (state.draft && (state.draft.generation !== editGeneration || state.draft.text !== text)) return false;
	const message: NotebookSaveMessage = Object.freeze({
		type: "identity_file_save",
		id: state.id,
		file: "notebook",
		text,
		baseHash,
		ref: NOTEBOOK_TAB_REF,
		reqId: requestId(),
	});
	const attempt: NotebookSaveAttempt = {
		message,
		viewGeneration: state.generation,
		editGeneration,
		phase: "admitting",
	};
	state = { ...state, save: attempt, saving: true, saved: undefined };
	attempts.set(message.reqId, attempt);
	notify();
	return await admit(attempt);
}
export async function saveOpenNote(
	text: string,
	editGeneration = state?.notes.open?.draft?.generation,
): Promise<boolean> {
	const open = state?.notes.open;
	if (!state || !open || open.status !== "ready" || !open.editable || open.busy || !open.hash) return false;
	if (open.draft && (open.draft.generation !== editGeneration || open.draft.text !== text)) return false;
	const message: NoteSaveMessage = Object.freeze({
		type: "identity_note_save",
		id: state.id,
		ref: open.ref,
		text,
		baseHash: open.draft?.base ?? open.hash,
		reqId: requestId(),
	});
	const attempt: NotebookSaveAttempt = {
		message,
		viewGeneration: state.generation,
		openGeneration: open.generation,
		editGeneration,
		phase: "admitting",
	};
	attempts.set(message.reqId, attempt);
	setNotes({ ...state.notes, open: { ...open, save: attempt, busy: "save", done: undefined } });
	return await admit(attempt);
}

/** Apply a verified current receipt to A's baseline, never to B's text or edit generation. */
function savedDraft(attempt: NotebookSaveAttempt, hash: string, draft?: NotebookDraft): NotebookDraft | undefined {
	const key = resource(
		attempt.message.id,
		attempt.message.type === "identity_note_save" ? attempt.message.ref : undefined,
	);
	if (draft && draft.generation === attempt.editGeneration && draft.text === attempt.message.text) {
		drafts.delete(key);
		return undefined;
	}
	if (!draft) return undefined;
	const next = { ...draft, base: hash };
	drafts.set(key, next);
	return next;
}
export function receiveNotebookSaved(payload: NotebookSavedPayload): void {
	const attempt = payload.reqId ? attempts.get(payload.reqId) : undefined;
	if (
		!attempt ||
		attempt.message.type !== "identity_file_save" ||
		payload.id !== attempt.message.id ||
		payload.file !== "notebook" ||
		payload.ref !== NOTEBOOK_TAB_REF ||
		!owns(attempt) ||
		(attempt.phase !== "admitting" && attempt.phase !== "awaiting")
	)
		return;
	if (attempt.phase === "admitting") {
		if (!attempt.receipt) publishAttempt({ ...attempt, receipt: payload });
		return;
	}
	if (!payload.ok) {
		publishAttempt(
			{ ...attempt, phase: "refused", receipt: payload },
			{ ok: false, code: payload.code ?? "io", reqId: payload.reqId },
		);
		return;
	}
	if (typeof payload.hash !== "string" || !state) {
		publishAttempt({ ...attempt, phase: "unknown", receipt: payload }, { ok: false, code: "io", reqId: payload.reqId });
		return;
	}
	state = {
		...state,
		status: "ready",
		text: attempt.message.text,
		hash: payload.hash,
		size: typeof payload.size === "number" ? payload.size : utf8Bytes(attempt.message.text),
		draft: savedDraft(attempt, payload.hash, state.draft),
	};
	publishAttempt({ ...attempt, phase: "saved", receipt: payload }, { ok: true, reqId: payload.reqId });
}

/** Metadata deletion is transient. Only the correlated server delete result closes the note. */
export function deleteOpenNote(): boolean {
	const open = state?.notes.open;
	if (!state || !open || open.status !== "ready" || !open.editable || open.busy || !open.hash) return false;
	const msg: NoteDeleteMessage = {
		type: "identity_note_delete",
		id: state.id,
		ref: open.ref,
		baseHash: open.hash,
		reqId: requestId(),
	};
	const view = state.generation;
	setNotes({
		...state.notes,
		open: { ...open, busy: "delete", deleteReqId: msg.reqId, deleteUnknown: false, done: undefined },
	});
	const sent = sendTransient(msg);
	if (!sent && state?.generation === view && state.notes.open?.deleteReqId === msg.reqId)
		setNotes({
			...state.notes,
			open: {
				...state.notes.open,
				busy: null,
				deleteReqId: undefined,
				deleteUnknown: true,
				done: { ok: false, code: "io" },
			},
		});
	return sent;
}
export function receiveNoteSaved(payload: NoteSavedPayload): void {
	const open = state?.notes.open;
	if (!state || !open || payload.id !== state.id || payload.ref !== open.ref || !payload.reqId) return;
	if (open.busy === "delete" && payload.reqId === open.deleteReqId) {
		if (!payload.ok) {
			setNotes({
				...state.notes,
				open: {
					...open,
					busy: null,
					deleteReqId: undefined,
					done: { ok: false, code: payload.code ?? "io", problems: payload.problems, reqId: payload.reqId },
				},
			});
		} else if (payload.deleted === true) {
			setNotes({ ...state.notes, open: null, deleted: open.ref });
			refreshNotes();
		} // ok without deleted is not confirmation of this destructive action.
		return;
	}
	const attempt = attempts.get(payload.reqId);
	if (
		!attempt ||
		attempt.message.type !== "identity_note_save" ||
		!owns(attempt) ||
		payload.deleted === true ||
		(attempt.phase !== "admitting" && attempt.phase !== "awaiting")
	)
		return;
	if (attempt.phase === "admitting") {
		if (!attempt.receipt) publishAttempt({ ...attempt, receipt: payload });
		return;
	}
	if (!payload.ok) {
		publishAttempt(
			{ ...attempt, phase: "refused", receipt: payload },
			{ ok: false, code: payload.code ?? "io", problems: payload.problems, reqId: payload.reqId },
		);
		return;
	}
	if (typeof payload.hash !== "string") {
		publishAttempt({ ...attempt, phase: "unknown", receipt: payload }, { ok: false, code: "io", reqId: payload.reqId });
		return;
	}
	setNotes({
		...state.notes,
		open: {
			...open,
			text: attempt.message.text,
			hash: payload.hash,
			size: typeof payload.size === "number" ? payload.size : utf8Bytes(attempt.message.text),
			draft: savedDraft(attempt, payload.hash, open.draft),
		},
	});
	publishAttempt({ ...attempt, phase: "saved", receipt: payload }, { ok: true, reqId: payload.reqId });
	if (!owns(attempt)) return;
	readOpenNote(); // canonical server layout, correlated; cannot replace a draft
	if (owns(attempt)) refreshNotes();
}

export function clearNoteDone(): void {
	const open = state?.notes.open;
	if (state && open?.done) setNotes({ ...state.notes, open: { ...open, done: undefined } });
}
export function clearNotebookSaved(reqId?: string): void {
	if (!state?.saved || (reqId !== undefined && reqId !== state.saved.reqId)) return;
	state = { ...state, saved: undefined };
	notify();
}
/** Retained complete authored operations, including unknown originals after teardown. No replay API. */
export function getNotebookSaveAttempts(): readonly NotebookSaveAttempt[] {
	return [...attempts.values()];
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
export function getWatchedNotebook(): string | null {
	return watched;
}
/** Unit fixtures only. Production teardown must not call this. */
export function resetNotebookState(): void {
	watched = null;
	state = null;
	generation = 0;
	drafts.clear();
	attempts.clear();
}
export function useNotebook(): NotebookState | null {
	return useSyncExternalStore(subscribeNotebook, getNotebook, getNotebook);
}
