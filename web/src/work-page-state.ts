/// <reference lib="dom" />
/**
 * initiatives-page (docs/initiatives-page-exact.md, Ops #225): the work registry feed the Initiatives tab
 * shows (#223's work_page), a module-level store in the initiatives-state.ts pattern (module values +
 * listeners + `useSyncExternalStore`, a stable snapshot between changes).
 *
 * The tab watches while it is shown (`work_page_watch`); the server sends the whole page at once and again
 * when it changes, and stops on `work_page_unwatch`. A watch always gets a fresh answer, so "Try again" and
 * a new socket (`ready`) simply watch again.
 *
 * pages-fresh (Ops #245): the page's own data signal for the app's "Reconnecting…" note (page-live.ts), as
 * the Roles page has: fresh once the server has answered this window's latest watch with a page (the server
 * answers at once from the copy it keeps fresh in the background), not fresh from a new watch or a lost
 * connection until then. The last page stays on screen meanwhile, with its time.
 */
import { useEffect, useSyncExternalStore } from "react";
import { appSend } from "./app-globals";
import type { WorkPageFeed } from "./initiatives-page/model";
import { setViewFresh } from "./page-live";
import type { ServerMessage } from "./types";

export type WorkPagePayload = Extract<ServerMessage, { type: "work_page" }>;

let state: WorkPageFeed = { page: null, status: "idle" };
let watchers = 0;
let watching = false;
/** pages-fresh: a page came for this window's latest watch, on the socket it was sent on. */
let answered = false;
const listeners = new Set<() => void>();

function set(next: WorkPageFeed): void {
	state = next;
	for (const l of listeners) l();
}

/** pages-fresh: whether the page has its own fresh data now (only while it watches). */
function signal(): void {
	setViewFresh("initiatives", watchers > 0 && answered);
}

/** Tells the server what this window wants now. */
function sync(force = false): void {
	const want = watchers > 0;
	if (!force && want === watching) return;
	watching = want;
	// pages-fresh: a new watch (or none) waits for its own answer.
	answered = false;
	signal();
	if (!want) {
		appSend({ type: "work_page_unwatch" });
		return;
	}
	// Not connected yet: it stays loading, and the socket's `ready` asks again (resendWorkPageWatch).
	if (!state.page) set({ ...state, status: "loading", error: undefined });
	appSend({ type: "work_page_watch" });
}

/** The tab starts watching. Returns its undo. */
export function watchWorkPage(): () => void {
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

/** "Try again": watch again; the server answers with what it has now. */
export function reloadWorkPage(): void {
	if (!watching) return;
	sync(true);
}

/** A new socket (`ready`): the server has forgotten this window's watch, so ask again. */
export function resendWorkPageWatch(): void {
	if (watchers === 0) {
		watching = false;
		return;
	}
	sync(true);
}

/** pages-fresh: the socket was lost (onclose, or dropped by the watchdog). The page on screen is no longer
 *  known to be current until the next socket's watch is answered. */
export function workPageConnectionLost(): void {
	if (!answered) return;
	answered = false;
	signal();
}

/** `work_page` from the server. A failure keeps the last page (shown as out of date). */
export function receiveWorkPage(payload: WorkPagePayload): void {
	if (payload.page) {
		if (watchers > 0) answered = true;
		set({ page: payload.page, status: "ready" });
		signal();
		return;
	}
	set({
		...state,
		status: "error",
		error: typeof payload.error === "string" ? payload.error : "The page couldn't be made.",
		failedAt: Date.now(),
	});
}

function subscribe(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

function snapshot(): WorkPageFeed {
	return state;
}

/** The work registry feed; `watch` true while the tab is shown. */
export function useWorkPage(watch: boolean): WorkPageFeed {
	useEffect(() => {
		if (!watch) return;
		return watchWorkPage();
	}, [watch]);
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Tests: start clean. */
export function resetWorkPageState(): void {
	state = { page: null, status: "idle" };
	watchers = 0;
	watching = false;
	answered = false;
	listeners.clear();
	setViewFresh("initiatives", null);
}
