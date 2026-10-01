/// <reference lib="dom" />
/**
 * identities: the chat identities (pi-identity) on the page, a module-level store.
 *
 * Two things live here:
 *  - the identity list (`identities`, pushed on attach and after every save): the chat menu, the
 *    blank-chat picker, the header label's menu and Settings -> Identities all read it;
 *  - the one file open in Settings -> Identities (about.md or notebook.md): its text as it is on
 *    disk, its hash (goes back with the save, so a file changed meanwhile isn't overwritten) and the
 *    last save's answer. The draft being typed stays in the editor component.
 *
 * Same pattern as tool-info-state.ts: module-level `cached` values + listeners +
 * `useSyncExternalStore`; the getters return stable references between changes.
 */
import { useSyncExternalStore } from "react";
import { appSend } from "./app-globals";
import type { IdentityFileName, IdentitySaveError, ServerMessage, UiIdentityInfo } from "./types";

export type IdentitiesPayload = Extract<ServerMessage, { type: "identities" }>;
export type IdentityFilePayload = Extract<ServerMessage, { type: "identity_file" }>;
export type IdentitySavedPayload = Extract<ServerMessage, { type: "identity_file_saved" }>;

/** The identity list. loaded = the server has sent it at least once. */
export interface IdentityListState {
	identities: UiIdentityInfo[];
	problems: string[];
	loaded: boolean;
}

/** The file open in the editor. */
export interface IdentityFileState {
	id: string;
	file: IdentityFileName;
	/** loading = asked, not back yet; ready = text/hash are the file on disk; error = couldn't read it. */
	status: "loading" | "ready" | "error";
	text?: string;
	hash?: string;
	/** The notebook's cap in bytes (notebook only). */
	cap?: number;
	error?: string;
	/** A save is on its way. */
	saving: boolean;
	/** The last save's answer (cleared when the file is opened again). */
	saved?: { ok: true } | { ok: false; code: IdentitySaveError };
}

const EMPTY_LIST: IdentityListState = { identities: [], problems: [], loaded: false };

let list: IdentityListState = EMPTY_LIST;
let open: IdentityFileState | null = null;
/** The text of the save on its way (becomes the file's text when the server says ok). */
let pendingText: string | null = null;

const listeners = new Set<() => void>();

function notify(): void {
	for (const l of listeners) l();
}

/** `identities` from the server (use-chat). */
export function receiveIdentities(payload: IdentitiesPayload): void {
	list = {
		identities: Array.isArray(payload.identities) ? payload.identities : [],
		problems: Array.isArray(payload.problems) ? payload.problems : [],
		loaded: true,
	};
	notify();
}

/** Ask the server for the list again (Settings -> Identities opened). */
export function requestIdentities(): void {
	appSend({ type: "identities_get" });
}

/** Open about.md / notebook.md in the editor: shows "loading" and asks the server for the text. */
export function openIdentityFile(id: string, file: IdentityFileName): void {
	open = { id, file, status: "loading", saving: false };
	pendingText = null;
	notify();
	appSend({ type: "identity_file_get", id, file });
}

/** Close the editor. */
export function closeIdentityFile(): void {
	if (open === null) return;
	open = null;
	pendingText = null;
	notify();
}

/** `identity_file` from the server. Only the file the editor is waiting for counts. */
export function receiveIdentityFile(payload: IdentityFilePayload): void {
	if (!open || open.id !== payload.id || open.file !== payload.file) return;
	if (typeof payload.error === "string" || typeof payload.text !== "string" || typeof payload.hash !== "string") {
		open = { id: open.id, file: open.file, status: "error", error: payload.error ?? "", saving: false };
	} else {
		open = {
			id: open.id,
			file: open.file,
			status: "ready",
			text: payload.text,
			hash: payload.hash,
			...(typeof payload.cap === "number" ? { cap: payload.cap } : {}),
			saving: false,
		};
	}
	pendingText = null;
	notify();
}

/** Save the whole file. Does nothing while the file isn't loaded or a save is on its way. */
export function saveOpenIdentityFile(text: string): boolean {
	if (!open || open.status !== "ready" || open.saving || typeof open.hash !== "string") return false;
	const { id, file, hash } = open;
	pendingText = text;
	open = { ...open, saving: true, saved: undefined };
	notify();
	appSend({ type: "identity_file_save", id, file, text, baseHash: hash });
	return true;
}

/** `identity_file_saved` from the server: ok -> the saved text is the file now; refused -> keep the draft. */
export function receiveIdentitySaved(payload: IdentitySavedPayload): void {
	if (!open || open.id !== payload.id || open.file !== payload.file || !open.saving) return;
	if (payload.ok && typeof payload.hash === "string" && pendingText !== null) {
		open = { ...open, text: pendingText, hash: payload.hash, saving: false, saved: { ok: true } };
	} else {
		open = { ...open, saving: false, saved: { ok: false, code: payload.code ?? "io" } };
	}
	pendingText = null;
	notify();
}

export function subscribeIdentities(cb: () => void): () => void {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
}

export function getIdentityList(): IdentityListState {
	return list;
}

export function getIdentityFile(): IdentityFileState | null {
	return open;
}

/** Only for unit tests: back to the start (no notifications). */
export function resetIdentityState(): void {
	list = EMPTY_LIST;
	open = null;
	pendingText = null;
}

/** The identity list (re-renders when it changes). */
export function useIdentityList(): IdentityListState {
	return useSyncExternalStore(subscribeIdentities, getIdentityList, getIdentityList);
}

/** The file open in Settings -> Identities (null = none). */
export function useIdentityFile(): IdentityFileState | null {
	return useSyncExternalStore(subscribeIdentities, getIdentityFile, getIdentityFile);
}

/** How many bytes a text takes in UTF-8 (what the notebook cap counts). */
export function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** A home chat not in the chat lists yet, by its short session id (".../<time>_<uuid>.jsonl" -> the uuid's first 8). */
export function shortChatName(path: string): string {
	const base = (path.split(/[\\/]/).pop() || path).replace(/\.jsonl$/, "");
	const cut = base.lastIndexOf("_");
	return cut >= 0 && cut < base.length - 1 ? base.slice(cut + 1, cut + 9) : base;
}
