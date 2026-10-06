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
import type { ServerMessage, UiRolesOverview } from "./types";

export type RolesPayload = Extract<ServerMessage, { type: "roles" }>;

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

/** Tests: forget everything. */
export function resetRolesState(): void {
	state = { overview: null, asks: 0, status: "idle" };
	fullWatchers = 0;
	countWatchers = 0;
	asked = "off";
	notify();
}
