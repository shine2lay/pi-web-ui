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
 *  - identity-config: the one role draft open (role-drafts/<id>/, waiting for the owner): its suggested
 *    prompt, settings and reasons, its hash, and the answer to the last save, accept or discard. Opening
 *    a draft closes the file editor and the other way round.
 *  - identity-config: each role's own skills (`identity_skills`, which Settings -> Identities asks for):
 *    they live in the role's private folder, so the identity list every window gets only counts them.
 *
 * Same pattern as tool-info-state.ts: module-level `cached` values + listeners +
 * `useSyncExternalStore`; the getters return stable references between changes.
 */
import { useSyncExternalStore } from "react";
import { appSend } from "./app-globals";
import type {
	IdentityDraftAction,
	IdentityFileName,
	IdentitySaveError,
	ServerMessage,
	UiIdentityInfo,
	UiRoleSkill,
} from "./types";

export type IdentitiesPayload = Extract<ServerMessage, { type: "identities" }>;
export type IdentityFilePayload = Extract<ServerMessage, { type: "identity_file" }>;
export type IdentitySavedPayload = Extract<ServerMessage, { type: "identity_file_saved" }>;
export type IdentityDraftPayload = Extract<ServerMessage, { type: "identity_draft" }>;
export type IdentityDraftDonePayload = Extract<ServerMessage, { type: "identity_draft_done" }>;
export type IdentitySkillsPayload = Extract<ServerMessage, { type: "identity_skills" }>;

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
	/** The last save's answer (cleared when the file is opened again). identity-config: problems = why
	 *  pi-identity would refuse the settings (code "invalid"). */
	saved?: { ok: true } | { ok: false; code: IdentitySaveError; problems?: string[] };
}

/** identity-config: the role draft open in Settings -> Identities. */
export interface IdentityDraftState {
	id: string;
	/** loading = asked, not back yet; ready = the draft as it is on disk; error = none waits (or unreadable). */
	status: "loading" | "ready" | "error";
	prompt?: string;
	config?: string;
	notes?: string;
	hash?: string;
	error?: string;
	/** An action on its way. */
	busy?: IdentityDraftAction;
	/** The last action's answer. */
	done?: { action: IdentityDraftAction; ok: boolean; code?: IdentitySaveError; problems?: string[] };
}

const EMPTY_LIST: IdentityListState = { identities: [], problems: [], loaded: false };

let list: IdentityListState = EMPTY_LIST;
let open: IdentityFileState | null = null;
/** The text of the save on its way (becomes the file's text when the server says ok). */
let pendingText: string | null = null;
/** identity-config: the draft open, and the texts of a draft save on its way. */
let draft: IdentityDraftState | null = null;
let pendingDraft: { prompt: string; config: string } | null = null;
/** identity-config: each role's own skills by role id, as last asked (null = not asked yet). */
const NO_SKILLS: Record<string, UiRoleSkill[]> = {};
let ownSkills: Record<string, UiRoleSkill[]> | null = null;

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

/** identity-config: ask for each role's own skills (Settings -> Identities, when it opens and when the
 *  list changes). */
export function requestOwnSkills(): void {
	appSend({ type: "identity_skills_get" });
}

/** identity-config: `identity_skills` from the server (use-chat). */
export function receiveOwnSkills(payload: IdentitySkillsPayload): void {
	const got = payload.skills && typeof payload.skills === "object" ? payload.skills : {};
	const next: Record<string, UiRoleSkill[]> = {};
	for (const [id, skills] of Object.entries(got)) if (Array.isArray(skills)) next[id] = skills;
	ownSkills = next;
	notify();
}

/** Open about.md / notebook.md in the editor: shows "loading" and asks the server for the text. */
export function openIdentityFile(id: string, file: IdentityFileName): void {
	open = { id, file, status: "loading", saving: false };
	pendingText = null;
	draft = null;
	pendingDraft = null;
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
		const problems = Array.isArray(payload.problems) ? { problems: payload.problems } : {};
		open = { ...open, saving: false, saved: { ok: false, code: payload.code ?? "io", ...problems } };
	}
	pendingText = null;
	notify();
}

/** identity-config: open a role's waiting draft (closes the file editor) and ask the server for it. */
export function openIdentityDraft(id: string): void {
	draft = { id, status: "loading" };
	pendingDraft = null;
	open = null;
	pendingText = null;
	notify();
	appSend({ type: "identity_draft_get", id });
}

/** identity-config: close the draft. */
export function closeIdentityDraft(): void {
	if (draft === null) return;
	draft = null;
	pendingDraft = null;
	notify();
}

/** identity-config: `identity_draft` from the server. Only the draft open counts. */
export function receiveIdentityDraft(payload: IdentityDraftPayload): void {
	if (!draft || draft.id !== payload.id) return;
	if (typeof payload.error === "string" || typeof payload.hash !== "string") {
		draft = { id: draft.id, status: "error", error: payload.error ?? "" };
	} else {
		draft = {
			id: draft.id,
			status: "ready",
			prompt: payload.prompt ?? "",
			config: payload.config ?? "",
			notes: payload.notes ?? "",
			hash: payload.hash,
		};
	}
	pendingDraft = null;
	notify();
}

/**
 * identity-config: save the owner's edits to the draft, accept it as shown, or discard it. Does nothing
 * while it isn't loaded or an action is on its way.
 */
export function sendIdentityDraftAction(action: IdentityDraftAction, prompt: string, config: string): boolean {
	if (!draft || draft.status !== "ready" || draft.busy || typeof draft.hash !== "string") return false;
	const { id, hash } = draft;
	draft = { ...draft, busy: action, done: undefined };
	pendingDraft = action === "save" ? { prompt, config } : null;
	notify();
	if (action === "discard") appSend({ type: "identity_draft_discard", id });
	else {
		const type = action === "accept" ? "identity_draft_accept" : "identity_draft_save";
		appSend({ type, id, prompt, config, baseHash: hash });
	}
	return true;
}

/** identity-config: `identity_draft_done` from the server: a saved draft's texts are the draft now. */
export function receiveIdentityDraftDone(payload: IdentityDraftDonePayload): void {
	if (!draft || draft.id !== payload.id || draft.busy !== payload.action) return;
	const done = {
		action: payload.action,
		ok: payload.ok === true,
		...(payload.code ? { code: payload.code } : {}),
		...(Array.isArray(payload.problems) ? { problems: payload.problems } : {}),
	};
	if (done.ok && payload.action === "save" && pendingDraft && typeof payload.hash === "string") {
		draft = { ...draft, ...pendingDraft, hash: payload.hash, busy: undefined, done };
	} else {
		// Accepted or discarded: the draft is gone; the row says what happened until it's closed.
		draft = { ...draft, busy: undefined, done };
	}
	pendingDraft = null;
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

export function getIdentityDraft(): IdentityDraftState | null {
	return draft;
}

/** identity-config: each role's own skills by role id ({} until the server has answered). */
export function getOwnSkills(): Record<string, UiRoleSkill[]> {
	return ownSkills ?? NO_SKILLS;
}

/** Only for unit tests: back to the start (no notifications). */
export function resetIdentityState(): void {
	list = EMPTY_LIST;
	open = null;
	pendingText = null;
	draft = null;
	pendingDraft = null;
	ownSkills = null;
}

/** The identity list (re-renders when it changes). */
export function useIdentityList(): IdentityListState {
	return useSyncExternalStore(subscribeIdentities, getIdentityList, getIdentityList);
}

/** The file open in Settings -> Identities (null = none). */
export function useIdentityFile(): IdentityFileState | null {
	return useSyncExternalStore(subscribeIdentities, getIdentityFile, getIdentityFile);
}

/** identity-config: the role draft open in Settings -> Identities (null = none). */
export function useIdentityDraft(): IdentityDraftState | null {
	return useSyncExternalStore(subscribeIdentities, getIdentityDraft, getIdentityDraft);
}

/** identity-config: each role's own skills by role id (re-renders when they come). */
export function useOwnSkills(): Record<string, UiRoleSkill[]> {
	return useSyncExternalStore(subscribeIdentities, getOwnSkills, getOwnSkills);
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
