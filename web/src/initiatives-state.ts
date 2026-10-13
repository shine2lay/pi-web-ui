/// <reference lib="dom" />
/**
 * initiatives-page (task #84): the Initiatives tab's data, a module-level store (the roles-state.ts
 * pattern: module values + listeners + `useSyncExternalStore`, a stable snapshot between changes).
 *
 * The tab watches one initiative at a time (`initiatives_watch {initiative, limit}`); the server sends the
 * page at once and again when the decisions or the reader change, and stops on `initiatives_unwatch`. A new
 * socket forgets the watch, so `ready` asks again (resendInitiativesWatch). A card's source opens one kept
 * record, asked for on demand (`decision_record`) and kept here for the window's life.
 */
import { useEffect, useSyncExternalStore } from "react";
import { appSend } from "./app-globals";
import type { ServerMessage, UiDecisionRecordView, UiDecisionsPage, UiUpdateDecision, UiUpdateLink } from "./types";

export type InitiativesPayload = Extract<ServerMessage, { type: "initiatives" }>;
export type DecisionRecordPayload = Extract<ServerMessage, { type: "decision_record" }>;
export type InitiativeResultPayload = Extract<ServerMessage, { type: "initiative_result" }>;
export type UpdateLinksPayload = Extract<ServerMessage, { type: "initiative_update_links" }>;

/** progress-feed (task #85): a lead change or an "Ask for an update" on its way, or how it ended. */
export interface FeedAction {
	op: "lead" | "poke";
	initiative: string;
	status: "sending" | "done" | "error";
	error?: string;
	/** This window's clock when it was sent (a stale "sending" turns into an error). */
	sentAt: number;
}

/** progress-feed: everything one update links, asked for on demand. */
export interface UpdateLinksState {
	status: "loading" | "ready" | "error";
	links?: UiUpdateLink[];
	decisions?: UiUpdateDecision[];
	error?: string;
}

/** How many decisions the tab asks for at first, and how many more each "Show more" adds. */
export const INITIATIVES_PAGE_SIZE = 100;
/** The server's ceiling (server/initiatives-watch.ts INITIATIVES_LIMIT_MAX). */
export const INITIATIVES_LIMIT_MAX = 2000;

export interface InitiativesState {
	/** The latest page (kept when a later one fails). */
	page: UiDecisionsPage | null;
	/** loading = asked, nothing back yet; ready = page holds data; error = nothing to show. */
	status: "idle" | "loading" | "ready" | "error";
	error?: string;
	/** The initiative this window asked for (undefined: the server's first one; "" = Unfiled). */
	selected?: string;
	/** How many decisions this window asked for. */
	limit: number;
	/** When this window last heard from the server (this clock, ms). */
	heardAt?: number;
	failedAt?: number;
}

export interface RecordState {
	status: "loading" | "ready" | "error";
	view?: UiDecisionRecordView;
	error?: string;
}

let state: InitiativesState = { page: null, status: "idle", limit: INITIATIVES_PAGE_SIZE };
let watchers = 0;
let watching = false;
const records = new Map<string, RecordState>();
const updateLinks = new Map<string, UpdateLinksState>();
const actions = new Map<string, FeedAction>();
const listeners = new Set<() => void>();
let reqSeq = 0;

function notify(): void {
	for (const l of listeners) l();
}

function set(next: InitiativesState): void {
	state = next;
	notify();
}

function ask(): void {
	appSend({
		type: "initiatives_watch",
		...(state.selected !== undefined ? { initiative: state.selected } : {}),
		limit: state.limit,
	});
}

/** Tells the server what this window wants now. */
function sync(force = false): void {
	const want = watchers > 0;
	if (!force && want === watching) return;
	watching = want;
	if (!want) {
		appSend({ type: "initiatives_unwatch" });
		return;
	}
	if (state.status !== "ready") set({ ...state, status: "loading" });
	ask();
}

/** The tab starts (or stops) watching. Returns its undo. */
export function watchInitiatives(): () => void {
	watchers++;
	sync();
	let done = false;
	return () => {
		if (done) return;
		done = true;
		watchers = Math.max(0, watchers - 1);
		sync();
	};
}

/** Show another initiative ("" = Unfiled). Starts again from the first page of its decisions. */
export function selectInitiative(id: string): void {
	if (state.selected === id && state.page?.selected === id) return;
	set({ ...state, selected: id, limit: INITIATIVES_PAGE_SIZE });
	if (watching) ask();
}

/** "Show more": ask for the next page of decisions. */
export function showMoreDecisions(): void {
	const limit = Math.min(state.limit + INITIATIVES_PAGE_SIZE, INITIATIVES_LIMIT_MAX);
	if (limit === state.limit) return;
	set({ ...state, limit });
	if (watching) ask();
}

/** Reload: the server answers with what it has now. */
export function reloadInitiatives(): void {
	if (!watching) return;
	if (state.status === "error") set({ ...state, status: "loading", error: undefined });
	ask();
}

/** A new socket (`ready`): the server has forgotten this window's watch, so ask again. */
export function resendInitiativesWatch(): void {
	if (watchers === 0) {
		watching = false;
		return;
	}
	sync(true);
}

/** `initiatives` from the server. */
export function receiveInitiatives(payload: InitiativesPayload): void {
	const now = Date.now();
	if (payload.page) {
		set({ ...state, page: payload.page, status: "ready", error: undefined, heardAt: now });
		return;
	}
	set({
		...state,
		status: state.page ? "ready" : "error",
		error: typeof payload.error === "string" ? payload.error : "The page couldn't be made.",
		failedAt: now,
		heardAt: now,
	});
}

/** A card's source: ask for the kept record once (again after an error). */
export function requestDecisionRecord(id: string): void {
	const have = records.get(id);
	if (have && have.status !== "error") return;
	records.set(id, { status: "loading" });
	notify();
	if (!appSend({ type: "decision_record", record: id })) {
		records.set(id, { status: "error", error: "Not connected to the server." });
		notify();
	}
}

/** `decision_record` from the server. */
export function receiveDecisionRecord(payload: DecisionRecordPayload): void {
	if (!payload.record) return;
	records.set(
		payload.record,
		payload.view
			? { status: "ready", view: payload.view }
			: { status: "error", error: payload.error || "That record isn't kept here." },
	);
	// A new map entry needs a new snapshot object for useSyncExternalStore.
	state = { ...state };
	notify();
}

export function decisionRecordState(id: string): RecordState | undefined {
	return records.get(id);
}

function subscribe(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

function snapshot(): InitiativesState {
	return state;
}

/** The tab's data; `watch` true while the tab is shown. */
export function useInitiatives(watch: boolean): InitiativesState {
	useEffect(() => {
		if (!watch) return;
		return watchInitiatives();
	}, [watch]);
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** One kept record for a source dialog (asked for when `id` is set). */
export function useDecisionRecord(id: string | null): RecordState | undefined {
	useSyncExternalStore(subscribe, snapshot, snapshot);
	useEffect(() => {
		if (id) requestDecisionRecord(id);
	}, [id]);
	return id ? records.get(id) : undefined;
}

// progress-feed (task #85) ---------------------------------------------------

const actionKey = (op: "lead" | "poke", initiative: string): string => `${op}:${initiative}`;

function sendAction(op: "lead" | "poke", initiative: string, msg: Record<string, unknown>): void {
	const reqId = `ini-${Date.now().toString(36)}-${++reqSeq}`;
	actions.set(actionKey(op, initiative), { op, initiative, status: "sending", sentAt: Date.now() });
	if (!appSend({ ...msg, reqId } as Parameters<typeof appSend>[0])) {
		actions.set(actionKey(op, initiative), {
			op,
			initiative,
			status: "error",
			error: "Not connected to the server.",
			sentAt: Date.now(),
		});
	}
	state = { ...state };
	notify();
}

/** The owner sets (or clears, null) an initiative's lead. */
export function setInitiativeLead(initiative: string, lead: string | null): void {
	sendAction("lead", initiative, { type: "initiative_lead", initiative, lead });
}

/** The owner's "Ask for an update". */
export function askForUpdate(initiative: string): void {
	sendAction("poke", initiative, { type: "initiative_poke", initiative });
}

/** The owner looked at an initiative's Progress. */
export function markInitiativeSeen(initiative: string): void {
	appSend({ type: "initiative_seen", initiative });
}

/** `initiative_result` from the server. */
export function receiveInitiativeResult(payload: InitiativeResultPayload): void {
	if (!payload.initiative || (payload.op !== "lead" && payload.op !== "poke")) return;
	actions.set(actionKey(payload.op, payload.initiative), {
		op: payload.op,
		initiative: payload.initiative,
		status: payload.ok ? "done" : "error",
		...(payload.ok ? {} : { error: payload.error || "It didn't go through." }),
		sentAt: Date.now(),
	});
	state = { ...state };
	notify();
}

export function feedAction(op: "lead" | "poke", initiative: string): FeedAction | undefined {
	return actions.get(actionKey(op, initiative));
}

/** Everything one update links: ask once (again after an error). */
export function requestUpdateLinks(id: string): void {
	const have = updateLinks.get(id);
	if (have && have.status !== "error") return;
	updateLinks.set(id, { status: "loading" });
	state = { ...state };
	notify();
	if (!appSend({ type: "initiative_update_links", update: id })) {
		updateLinks.set(id, { status: "error", error: "Not connected to the server." });
		state = { ...state };
		notify();
	}
}

/** `initiative_update_links` from the server. */
export function receiveUpdateLinks(payload: UpdateLinksPayload): void {
	if (!payload.update) return;
	updateLinks.set(
		payload.update,
		payload.links
			? { status: "ready", links: payload.links, decisions: payload.decisions ?? [] }
			: { status: "error", error: payload.error || "That update isn't kept here." },
	);
	state = { ...state };
	notify();
}

export function updateLinksState(id: string): UpdateLinksState | undefined {
	return updateLinks.get(id);
}

/** Tests: forget everything. */
export function resetInitiativesState(): void {
	state = { page: null, status: "idle", limit: INITIATIVES_PAGE_SIZE };
	watchers = 0;
	watching = false;
	records.clear();
	updateLinks.clear();
	actions.clear();
	notify();
}
