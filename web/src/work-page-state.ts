/// <reference lib="dom" />
/**
 * initiatives-page (docs/initiatives-page-exact.md, Ops #225): the work registry feed the Initiatives tab
 * shows (#223's work_page), a module-level store in the initiatives-state.ts pattern (module values +
 * listeners + `useSyncExternalStore`, a stable snapshot between changes).
 *
 * The tab watches while it is shown (`work_page_watch`); the server sends the whole page at once and again
 * when it changes, and stops on `work_page_unwatch`. A watch always gets a fresh answer, so "Try again" and
 * a new socket (`ready`) simply watch again.
 */
import { useEffect, useSyncExternalStore } from "react";
import { appSend } from "./app-globals";
import type { WorkPageFeed } from "./initiatives-page/model";
import type { ServerMessage } from "./types";

export type WorkPagePayload = Extract<ServerMessage, { type: "work_page" }>;

let state: WorkPageFeed = { page: null, status: "idle" };
let watchers = 0;
let watching = false;
const listeners = new Set<() => void>();

function set(next: WorkPageFeed): void {
	state = next;
	for (const l of listeners) l();
}

/** Tells the server what this window wants now. */
function sync(force = false): void {
	const want = watchers > 0;
	if (!force && want === watching) return;
	watching = want;
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

/** `work_page` from the server. A failure keeps the last page (shown as out of date). */
export function receiveWorkPage(payload: WorkPagePayload): void {
	if (payload.page) {
		set({ page: payload.page, status: "ready" });
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
	listeners.clear();
}
