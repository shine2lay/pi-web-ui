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
import type { ServerMessage, UiDecisionRecordView, UiDecisionsPage } from "./types";

export type InitiativesPayload = Extract<ServerMessage, { type: "initiatives" }>;
export type DecisionRecordPayload = Extract<ServerMessage, { type: "decision_record" }>;

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
const listeners = new Set<() => void>();

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

/** Tests: forget everything. */
export function resetInitiativesState(): void {
	state = { page: null, status: "idle", limit: INITIATIVES_PAGE_SIZE };
	watchers = 0;
	watching = false;
	records.clear();
	notify();
}
