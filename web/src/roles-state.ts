/// <reference lib="dom" />
/**
 * roles-overview: the Roles page's data, a module-level store.
 *
 * Two kinds of watchers: the Roles page wants the whole snapshot (every role's state), the top bar
 * only the number of open asks (its badge). The server pushes to the windows that watch
 * (`roles_watch {full}`) and stops on `roles_unwatch`; a new socket forgets every watch, so `ready`
 * asks again (resendRolesWatch).
 *
 * Same pattern as identity-state.ts: module-level values + listeners + `useSyncExternalStore`; the
 * getter returns a stable reference between changes.
 */
import { useEffect, useSyncExternalStore } from "react";
import { appSend } from "./app-globals";
import type { ClientMessage, ServerMessage, UiRolesOverview } from "./types";

export type RolesPayload = Extract<ServerMessage, { type: "roles" }>;

/** board (task #76): what a board_post / board_close did. */
export type BoardResult = Extract<ServerMessage, { type: "board_result" }>;
type BoardAsk =
	| Omit<Extract<ClientMessage, { type: "board_post" }>, "reqId">
	| Omit<Extract<ClientMessage, { type: "board_close" }>, "reqId">;
/** How long the page waits for the server's answer to a post or a close. */
export const BOARD_ANSWER_MS = 20_000;

export interface RolesState {
	/** The latest snapshot (kept when a later look fails). */
	overview: UiRolesOverview | null;
	/** Open asks (the top bar's badge). */
	asks: number;
	/** loading = asked, nothing back yet; ready = overview holds data; error = nothing to show. */
	status: "idle" | "loading" | "ready" | "error";
	/** The last look's problem (cleared by the next good one). */
	error?: string;
	/** When the server last confirmed the data (its clock, ms). */
	checkedAt?: number;
	/** When this window last heard from the server (this clock, ms). */
	heardAt?: number;
	/** When the last look failed (this clock, ms). */
	failedAt?: number;
}

let state: RolesState = { overview: null, asks: 0, status: "idle" };
/** How many parts of the window want the whole snapshot / just the count. */
let fullWatchers = 0;
let countWatchers = 0;
/** What this window asked the server for last ("off": nothing). */
let asked: "off" | "count" | "full" = "off";

const listeners = new Set<() => void>();

function notify(): void {
	for (const l of listeners) l();
}

function set(next: RolesState): void {
	state = next;
	notify();
}

function wanted(): "off" | "count" | "full" {
	return fullWatchers > 0 ? "full" : countWatchers > 0 ? "count" : "off";
}

/** Tells the server what this window wants now (only when it changed, unless `force`). */
function sync(force = false): void {
	const want = wanted();
	if (!force && want === asked) return;
	asked = want;
	if (want === "off") {
		appSend({ type: "roles_unwatch" });
		return;
	}
	if (want === "full" && state.status !== "ready") set({ ...state, status: "loading" });
	appSend({ type: "roles_watch", full: want === "full" });
}

/** A part of the window starts (full: the page) or stops wanting the roles. Returns its undo. */
export function watchRoles(full: boolean): () => void {
	if (full) fullWatchers++;
	else countWatchers++;
	sync();
	let done = false;
	return () => {
		if (done) return;
		done = true;
		if (full) fullWatchers = Math.max(0, fullWatchers - 1);
		else countWatchers = Math.max(0, countWatchers - 1);
		sync();
	};
}

/** Ask again (the page's Reload): the server answers with what it has and looks again. */
export function reloadRoles(): void {
	if (wanted() === "off") return;
	if (state.status === "error") set({ ...state, status: "loading", error: undefined });
	sync(true);
}

/** A new socket (`ready`): the server has forgotten this window's watch, so ask again. */
export function resendRolesWatch(): void {
	if (wanted() === "off") {
		asked = "off";
		return;
	}
	sync(true);
}

/** `roles` from the server. */
export function receiveRoles(payload: RolesPayload): void {
	const now = Date.now();
	const asks = typeof payload.asks === "number" && payload.asks >= 0 ? payload.asks : state.asks;
	if (payload.overview) {
		set({
			overview: payload.overview,
			asks: payload.overview.asks.length,
			status: "ready",
			checkedAt: payload.checkedAt ?? payload.overview.at,
			heardAt: now,
		});
		return;
	}
	if (typeof payload.error === "string") {
		set({
			...state,
			asks,
			status: state.overview ? "ready" : "error",
			error: payload.error,
			failedAt: now,
			heardAt: now,
		});
		return;
	}
	// The count only (top bar), or "still the same, checked at" (the page).
	set({
		...state,
		asks,
		...(typeof payload.checkedAt === "number" ? { checkedAt: payload.checkedAt, error: undefined } : {}),
		heardAt: now,
	});
}

function subscribe(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

function snapshot(): RolesState {
	return state;
}

/** The roles' state; `watch`: "full" (the page), "count" (the top bar) or "off" (just read). */
export function useRoles(watch: "full" | "count" | "off" = "off"): RolesState {
	useEffect(() => {
		if (watch === "off") return;
		return watchRoles(watch === "full");
	}, [watch]);
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}

// ---------------------------------------------------------------------------
// board (task #76): the owner posts and closes from the Board view
// ---------------------------------------------------------------------------

const boardWaits = new Map<string, (r: BoardResult) => void>();
let boardSeq = 0;

/** Send a post or a close; resolves with the server's answer (ok false: nothing changed, or no answer in
 *  BOARD_ANSWER_MS, when the page can't tell). The Roles snapshot that follows shows the change. */
export function boardRequest(ask: BoardAsk, answerMs = BOARD_ANSWER_MS): Promise<BoardResult> {
	const reqId = `board-${Date.now().toString(36)}-${++boardSeq}`;
	const op = ask.type === "board_post" ? "post" : "close";
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			boardWaits.delete(reqId);
			resolve({
				type: "board_result",
				reqId,
				op,
				ok: false,
				error: "no answer from the server: look at the board before trying again",
			});
		}, answerMs);
		boardWaits.set(reqId, (r) => {
			clearTimeout(timer);
			resolve(r);
		});
		if (!appSend({ ...ask, reqId } as ClientMessage)) {
			clearTimeout(timer);
			boardWaits.delete(reqId);
			resolve({ type: "board_result", reqId, op, ok: false, error: "not connected to the server" });
		}
	});
}

/** `board_result` from the server. */
export function receiveBoardResult(r: BoardResult): void {
	if (!r.reqId) return;
	const wait = boardWaits.get(r.reqId);
	if (!wait) return;
	boardWaits.delete(r.reqId);
	wait(r);
}

/** Tests: forget everything. */
export function resetRolesState(): void {
	state = { overview: null, asks: 0, status: "idle" };
	fullWatchers = 0;
	countWatchers = 0;
	asked = "off";
	notify();
}
