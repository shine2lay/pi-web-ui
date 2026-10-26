/// <reference lib="dom" />
/**
 * identities: the chat identities (pi-identity) on the page, a module-level store.
 *
 * Two things live here:
 *  - the identity list (`identities`, pushed on attach and after every save): the chat menu, the
 *    blank-chat picker, the header label's menu and Settings -> Identities all read it;
 *  - the one file open in Settings -> Identities (about.md or notebook.md): its text as it is on
 *    disk, its hash (goes back with the save, so a file changed meanwhile isn't overwritten) and the
 *    last save's answer. Authored text/form stays separately in page memory across editor unmounts.
 *  - identity-config: the one role draft open (role-drafts/<id>/, waiting for the owner): its suggested
 *    prompt, settings and reasons, its hash, and the answer to the last save, accept or discard. Opening
 *    a draft closes the file editor and the other way round. about-drafts: and its suggested about page,
 *    with the role's about page as it is now (for "What changes").
 *  - identity-config: each role's own skills (`identity_skills`, which Settings -> Identities asks for):
 *    they live in the role's private folder, so the identity list every window gets only counts them.
 *  - role-messages: the last messages between role chats and the owner's pause switch (`role_messages`,
 *    which Settings -> Identities asks for; pushed to every window when it changes).
 *
 * Same pattern as tool-info-state.ts: module-level `cached` values + listeners +
 * `useSyncExternalStore`; the getters return stable references between changes.
 */
import { useSyncExternalStore } from "react";
import { appSend } from "./app-globals";
import { appAdmit } from "./app-admit";
import type { OwnerGoalDraft } from "./owner-fields";
import type {
	ClientMessage,
	IdentityDraftAction,
	IdentityFileName,
	IdentitySaveError,
	ServerMessage,
	UiIdentityInfo,
	UiRoleMessageRow,
	UiRoleSkill,
} from "./types";

export type IdentitiesPayload = Extract<ServerMessage, { type: "identities" }>;
export type IdentityFilePayload = Extract<ServerMessage, { type: "identity_file" }>;
/** #570 owns the shared optional reqId schema and server echo; no echo is never Saved. */
export type IdentitySavedPayload = Extract<ServerMessage, { type: "identity_file_saved" }> & { reqId?: string };
export type IdentityDraftPayload = Extract<ServerMessage, { type: "identity_draft" }>;
export type IdentityDraftDonePayload = Extract<ServerMessage, { type: "identity_draft_done" }> & { reqId?: string };
export type IdentitySkillsPayload = Extract<ServerMessage, { type: "identity_skills" }>;
export type RoleMessagesPayload = Extract<ServerMessage, { type: "role_messages" }>;

/** role-messages: the list in Settings -> Identities. loaded = the server has answered at least once. */
export interface RoleMessagesState {
	enabled: boolean;
	paused: boolean;
	messages: UiRoleMessageRow[];
	loaded: boolean;
}

const EMPTY_ROLE_MESSAGES: RoleMessagesState = { enabled: false, paused: false, messages: [], loaded: false };
let roleMessages: RoleMessagesState = EMPTY_ROLE_MESSAGES;

/** The identity list. loaded = the server has sent it at least once. */
export interface IdentityListState {
	identities: UiIdentityInfo[];
	problems: string[];
	loaded: boolean;
}

/** Complete form options, including temporarily inactive/unvalidated goals. Page memory only. */
export interface IdentityOwnerForm {
	mode: "default" | "self-start" | "request-only";
	ownGoals: boolean;
	goals: OwnerGoalDraft[];
}

interface IdentityEditorRevision {
	generation: number;
	revision: number;
	operationId?: string;
	/** Unknown delivery is not evidence that nothing was written. */
	uncertain?: boolean;
}

/** The file open in the editor. */
export interface IdentityFileState extends IdentityEditorRevision {
	id: string;
	/** Authored text/form is independent of the server baseline. Never journal raw config. */
	editText?: string;
	ownerForm?: IdentityOwnerForm;
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
	saved?: { ok: true; revision: number } | { ok: false; code: IdentitySaveError; problems?: string[] };
}

/** identity-config: the role draft open in Settings -> Identities. */
export interface IdentityDraftState extends IdentityEditorRevision {
	id: string;
	edits?: { about: string; prompt: string; config: string };
	/** loading = asked, not back yet; ready = the draft as it is on disk; error = none waits (or unreadable). */
	status: "loading" | "ready" | "error";
	/** about-drafts: the suggested about page ("" = none) and the role's about page now. */
	about?: string;
	currentAbout?: string;
	prompt?: string;
	config?: string;
	notes?: string;
	hash?: string;
	error?: string;
	/** An action on its way. */
	busy?: IdentityDraftAction;
	/** The last action's answer. */
	done?: {
		action: IdentityDraftAction;
		ok: boolean;
		code?: IdentitySaveError;
		problems?: string[];
		revision: number;
	};
}

const EMPTY_LIST: IdentityListState = { identities: [], problems: [], loaded: false };

let list: IdentityListState = EMPTY_LIST;
let open: IdentityFileState | null = null;
let draft: IdentityDraftState | null = null;
let generation = 0;
const fileEditors = new Map<string, IdentityFileState>();
const draftEditors = new Map<string, IdentityDraftState>();
type FileRequest = Extract<ClientMessage, { type: "identity_file_save" }> & { reqId: string };
type DraftRequest = Extract<
	ClientMessage,
	{ type: "identity_draft_save" | "identity_draft_accept" | "identity_draft_discard" }
> & { reqId: string };
type OperationPhase = "sending" | "waiting" | "unknown" | "saved" | "refused";
interface OperationBase {
	generation: number;
	revision: number;
	phase: OperationPhase;
}
export type IdentityOperation =
	| (OperationBase & {
			kind: "file";
			editor: "text" | "owner-form";
			request: FileRequest;
			ownerForm?: IdentityOwnerForm;
			reply?: IdentitySavedPayload;
	  })
	| (OperationBase & {
			kind: "draft";
			request: DraftRequest;
			action: IdentityDraftAction;
			baseHash: string;
			values: { about?: string; prompt: string; config: string };
			reply?: IdentityDraftDonePayload;
	  });
/** In-memory originals/unknown outcomes survive view teardown. Not a recovery journal or replay queue. */
const operations = new Map<string, IdentityOperation>();
const fileKey = (id: string, file: IdentityFileName) => JSON.stringify([id, file]);
const copyForm = (form: IdentityOwnerForm): IdentityOwnerForm => ({
	...form,
	goals: form.goals.map((goal) => ({ ...goal })),
});
function putFile(next: IdentityFileState): void {
	fileEditors.set(fileKey(next.id, next.file), next);
	if (open?.generation === next.generation) open = next;
}
function putDraft(next: IdentityDraftState): void {
	draftEditors.set(next.id, next);
	if (draft?.generation === next.generation) draft = next;
}
function currentFile(expected: IdentityFileState | null): expected is IdentityFileState {
	return (
		!!expected &&
		!!open &&
		open.id === expected.id &&
		open.file === expected.file &&
		open.generation === expected.generation &&
		open.revision === expected.revision &&
		open.hash === expected.hash
	);
}
function currentDraft(expected: IdentityDraftState | null): expected is IdentityDraftState {
	return (
		!!expected &&
		!!draft &&
		draft.id === expected.id &&
		draft.generation === expected.generation &&
		draft.revision === expected.revision &&
		draft.hash === expected.hash
	);
}

/** Native editors keep their complete current draft in page memory, including close/reopen. */
export function editIdentityFile(expected: IdentityFileState, text: string): void {
	if (!currentFile(expected)) return;
	putFile({ ...open!, editText: text, revision: open!.revision + 1 });
	notify();
}
export function editIdentityOwnerForm(expected: IdentityFileState, form: IdentityOwnerForm): void {
	if (!currentFile(expected) || expected.file !== "config") return;
	putFile({ ...open!, ownerForm: copyForm(form), revision: open!.revision + 1 });
	notify();
}
export function editIdentityDraft(expected: IdentityDraftState, edits: NonNullable<IdentityDraftState["edits"]>): void {
	if (!currentDraft(expected)) return;
	putDraft({ ...draft!, edits: { ...edits }, revision: draft!.revision + 1 });
	notify();
}
/** Diagnostic/reconciliation input only: never resubmit these operations automatically. */
export function getIdentityOperations(): readonly IdentityOperation[] {
	return [...operations.values()];
}
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

/** role-messages: ask for the list (Settings -> Identities opened). */
export function requestRoleMessages(): void {
	appSend({ type: "role_messages_get" });
}

/** role-messages: the owner's switch (the answer comes back as `role_messages`). */
export function setRoleMessagesPaused(paused: boolean): void {
	appSend({ type: "role_messages_pause", paused });
}

/** role-messages: `role_messages` from the server (use-chat). */
export function receiveRoleMessages(payload: RoleMessagesPayload): void {
	roleMessages = {
		enabled: payload.enabled === true,
		paused: payload.paused === true,
		messages: Array.isArray(payload.messages) ? payload.messages : [],
		loaded: true,
	};
	notify();
}

export function getRoleMessages(): RoleMessagesState {
	return roleMessages;
}

/** role-messages: the list and the switch (re-renders when they change). */
export function useRoleMessages(): RoleMessagesState {
	return useSyncExternalStore(subscribeIdentities, getRoleMessages, getRoleMessages);
}

/** New open generation; unsaved content survives switching resources or leaving Settings. */
export function openIdentityFile(id: string, file: IdentityFileName): void {
	const previous = fileEditors.get(fileKey(id, file));
	const retain =
		previous &&
		(previous.editText !== undefined || previous.ownerForm !== undefined || previous.saving || previous.uncertain);
	open = {
		...(retain ? previous : {}),
		id,
		file,
		generation: ++generation,
		revision: previous?.revision ?? 0,
		status: "loading",
		saving: false,
		operationId: undefined,
		saved: undefined,
	};
	fileEditors.set(fileKey(id, file), open);
	draft = null;
	notify();
	appSend({ type: "identity_file_get", id, file });
}

export function closeIdentityFile(): void {
	if (open === null) return;
	open = null;
	notify();
}

/** Read replies never reset authored fields or an in-flight save. Only an explicit open is loading. */
export function receiveIdentityFile(payload: IdentityFilePayload): void {
	if (!open || open.id !== payload.id || open.file !== payload.file || open.status !== "loading") return;
	if (typeof payload.error === "string" || typeof payload.text !== "string" || typeof payload.hash !== "string") {
		putFile({ ...open, status: open.hash ? "ready" : "error", error: payload.error ?? "" });
	} else {
		putFile({
			...open,
			status: "ready",
			text: payload.text,
			hash: payload.hash,
			error: undefined,
			...(typeof payload.cap === "number" ? { cap: payload.cap } : {}),
		});
	}
	notify();
}

/** Resolve one captured operation only. A result may precede the admission Promise. */
function finishFile(op: Extract<IdentityOperation, { kind: "file" }>): void {
	if (op.phase !== "waiting" || !op.reply) return;
	const reply = op.reply;
	const ok = reply.ok === true && typeof reply.hash === "string";
	op.phase = ok ? "saved" : "refused";
	const editor = fileEditors.get(fileKey(op.request.id, op.request.file));
	if (!editor || editor.generation !== op.generation || editor.operationId !== op.request.reqId) return;
	const problems = Array.isArray(reply.problems) ? { problems: [...reply.problems] } : {};
	putFile({
		...editor,
		saving: false,
		uncertain: false,
		...(ok ? { text: op.request.text, hash: reply.hash } : {}),
		// The baseline becomes A, never B. A→B→A still has a newer revision and is retained.
		// The other config view may hold a separate unsent draft; it wasn't part of this save.
		...(ok && editor.revision === op.revision
			? op.editor === "text"
				? { editText: undefined }
				: { ownerForm: undefined }
			: {}),
		saved: ok ? { ok: true, revision: op.revision } : { ok: false, code: reply.code ?? "io", ...problems },
	});
}

/** Whole-file action. true means local handoff only, never Saved; every consumer must await it. */
export async function saveOpenIdentityFile(
	text: string,
	expected: IdentityFileState | null = open,
	editor: "text" | "owner-form" = "text",
): Promise<boolean> {
	if (
		!currentFile(expected) ||
		expected.status !== "ready" ||
		open!.saving ||
		typeof expected.hash !== "string" ||
		(editor === "owner-form" && (expected.file !== "config" || !expected.ownerForm))
	)
		return false;
	const { id, file, hash } = expected;
	const reqId = crypto.randomUUID();
	const revision =
		expected.revision + (editor === "text" && text !== (expected.editText ?? expected.text ?? "") ? 1 : 0);
	const request: FileRequest = Object.freeze({ type: "identity_file_save", id, file, text, baseHash: hash, reqId });
	const op: Extract<IdentityOperation, { kind: "file" }> = {
		kind: "file",
		editor,
		request,
		generation: expected.generation,
		revision,
		phase: "sending",
		...(expected.ownerForm ? { ownerForm: copyForm(expected.ownerForm) } : {}),
	};
	operations.set(reqId, op);
	putFile({
		...expected,
		revision,
		editText: editor === "owner-form" ? expected.editText : text,
		operationId: reqId,
		saving: true,
		saved: undefined,
		uncertain: false,
	});
	notify();
	let admitted = false;
	try {
		// Positive E classification only. Config/composite authority is never generic recovery.
		if (file === "about" || file === "notebook" || file === "prompt") admitted = (await appAdmit(request)) === true;
		else if (file === "config") admitted = appSend(request) === true;
	} catch {
		// A handler may have committed before failing: preserve both copies, don't retry/fallback.
	}
	if (!admitted) {
		op.phase = "unknown";
		const editor = fileEditors.get(fileKey(id, file));
		if (editor?.generation === op.generation && editor.operationId === reqId)
			putFile({ ...editor, saving: false, uncertain: true, saved: { ok: false, code: "io" } });
	} else {
		op.phase = "waiting";
		finishFile(op);
	}
	notify();
	return admitted;
}

/** Old/no-echo, wrong-resource and duplicate results cannot release or overwrite another action. */
export function receiveIdentitySaved(payload: IdentitySavedPayload): void {
	const op = typeof payload.reqId === "string" ? operations.get(payload.reqId) : undefined;
	if (
		!op ||
		op.kind !== "file" ||
		op.request.id !== payload.id ||
		op.request.file !== payload.file ||
		op.reply ||
		(op.phase !== "sending" && op.phase !== "waiting")
	)
		return;
	op.reply = { ...payload, ...(payload.problems ? { problems: [...payload.problems] } : {}) };
	finishFile(op);
	notify();
}

export function openIdentityDraft(id: string): void {
	const previous = draftEditors.get(id);
	draft = {
		...previous,
		id,
		generation: ++generation,
		revision: previous?.revision ?? 0,
		status: "loading",
		busy: undefined,
		operationId: undefined,
		done: undefined,
	};
	draftEditors.set(id, draft);
	open = null;
	notify();
	appSend({ type: "identity_draft_get", id });
}

export function closeIdentityDraft(): void {
	if (draft === null) return;
	draft = null;
	notify();
}

export function receiveIdentityDraft(payload: IdentityDraftPayload): void {
	if (!draft || draft.id !== payload.id || draft.status !== "loading") return;
	if (typeof payload.error === "string" || typeof payload.hash !== "string") {
		putDraft({ ...draft, status: draft.hash ? "ready" : "error", error: payload.error ?? "" });
	} else {
		putDraft({
			...draft,
			status: "ready",
			about: payload.about ?? "",
			currentAbout: payload.currentAbout ?? "",
			prompt: payload.prompt ?? "",
			config: payload.config ?? "",
			notes: payload.notes ?? "",
			hash: payload.hash,
			error: undefined,
		});
	}
	notify();
}

function finishDraft(op: Extract<IdentityOperation, { kind: "draft" }>): void {
	if (op.phase !== "waiting" || !op.reply) return;
	const reply = op.reply;
	const ok = reply.ok === true && (op.action !== "save" || typeof reply.hash === "string");
	op.phase = ok ? "saved" : "refused";
	const editor = draftEditors.get(op.request.id);
	if (!editor || editor.generation !== op.generation || editor.operationId !== op.request.reqId) return;
	const done = {
		action: op.action,
		ok,
		revision: op.revision,
		...(!ok ? { code: reply.code ?? "io" } : {}),
		...(Array.isArray(reply.problems) ? { problems: [...reply.problems] } : {}),
	};
	putDraft({
		...editor,
		busy: undefined,
		uncertain: false,
		done,
		...(ok && op.action === "save" ? { ...op.values, hash: reply.hash } : {}),
		...(ok && op.action === "save" && editor.revision === op.revision ? { edits: undefined } : {}),
	});
}

/** Mixed/config draft actions keep the existing transient/server-result path, never appAdmit. */
export async function sendIdentityDraftAction(
	action: IdentityDraftAction,
	prompt: string,
	config: string,
	about?: string,
	expected: IdentityDraftState | null = draft,
): Promise<boolean> {
	if (
		!currentDraft(expected) ||
		expected.status !== "ready" ||
		draft!.busy ||
		typeof expected.hash !== "string" ||
		(draft!.done?.ok && draft!.done.action !== "save")
	)
		return false;
	const { id, hash } = expected;
	const reqId = crypto.randomUUID();
	const values = Object.freeze({ ...(about !== undefined ? { about } : {}), prompt, config });
	const revision =
		expected.revision +
		(JSON.stringify(
			expected.edits ?? { about: expected.about ?? "", prompt: expected.prompt ?? "", config: expected.config ?? "" },
		) !== JSON.stringify({ about: about ?? expected.about ?? "", prompt, config })
			? 1
			: 0);
	const request: DraftRequest = Object.freeze(
		action === "discard"
			? { type: "identity_draft_discard", id, reqId }
			: {
					type: action === "accept" ? "identity_draft_accept" : "identity_draft_save",
					id,
					...values,
					baseHash: hash,
					reqId,
				},
	);
	const op: Extract<IdentityOperation, { kind: "draft" }> = {
		kind: "draft",
		request,
		action,
		values,
		baseHash: hash,
		generation: expected.generation,
		revision,
		phase: "sending",
	};
	operations.set(reqId, op);
	putDraft({
		...expected,
		revision,
		edits: { about: about ?? expected.about ?? "", prompt, config },
		busy: action,
		operationId: reqId,
		done: undefined,
		uncertain: false,
	});
	notify();
	let admitted = false;
	try {
		admitted = appSend(request) === true;
	} catch {
		// Not sent/unknown is not Saved or permission to replay an accept/discard.
	}
	if (!admitted) {
		op.phase = "unknown";
		const editor = draftEditors.get(id);
		if (editor?.generation === op.generation && editor.operationId === reqId)
			putDraft({ ...editor, busy: undefined, uncertain: true, done: { action, ok: false, code: "io", revision } });
	} else {
		op.phase = "waiting";
		finishDraft(op);
	}
	notify();
	return admitted;
}

export function receiveIdentityDraftDone(payload: IdentityDraftDonePayload): void {
	const op = typeof payload.reqId === "string" ? operations.get(payload.reqId) : undefined;
	if (
		!op ||
		op.kind !== "draft" ||
		op.request.id !== payload.id ||
		op.action !== payload.action ||
		op.reply ||
		(op.phase !== "sending" && op.phase !== "waiting")
	)
		return;
	op.reply = { ...payload, ...(payload.problems ? { problems: [...payload.problems] } : {}) };
	finishDraft(op);
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
	draft = null;
	generation = 0;
	fileEditors.clear();
	draftEditors.clear();
	operations.clear();
	ownSkills = null;
	roleMessages = EMPTY_ROLE_MESSAGES;
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
