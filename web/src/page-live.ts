/// <reference lib="dom" />
/**
 * pages-live (Ops #244, H-PAGES-LIVE-2 in docs/pages-live.md): the Roles and Initiatives pages stay calm
 * across a tab switch.
 *
 * Coming back to a tab often finds the socket gone or in doubt. Roles' own data is back about 0.4 s after a
 * new socket, but the alarms fired at the first gap ("Reconnecting…", the red or amber pill) and the app's
 * note waited for the chat to catch up even on a page that shows no chat. Here, while one of these pages
 * is the visible view, an alarm waits up to LIVE_GRACE_MS of visible time for the page's own fresh data;
 * the last data stays on screen meanwhile, with its time. Chat views keep showing the note at once.
 *
 * Module-level store: which view is shown (App.tsx), when the tab last became visible, and whether a view
 * that has its own data signal has fresh data (roles-state.ts). Pure helpers take the times as arguments.
 */

/** How long an alarm waits, in visible time, for the page's own fresh data. One constant for every alarm. */
export const LIVE_GRACE_MS = 8_000;

/** What the window shows, as the connection trace records it. */
export type PageView = "roles" | "initiatives" | "chat" | "other";

let view: PageView = "chat";
/** When the tab last became visible (this clock, ms); null while it is hidden. */
let visibleAt: number | null =
	typeof document === "undefined" || document.visibilityState !== "hidden" ? Date.now() : null;
/** Views with their own data signal: whether that data is fresh now. Missing: no signal of its own. */
const fresh = new Map<PageView, boolean>();
const listeners = new Set<() => void>();

function notify(): void {
	for (const l of listeners) l();
}

/** The views whose alarms wait for their own data. */
export function graceView(v: PageView): boolean {
	return v === "roles" || v === "initiatives";
}

/** How much of the grace is left for a wait that began at `start`: counted from the later of the start
 *  and the tab becoming visible; while hidden (visible null) nothing is used up. 0 when it is over. */
export function graceLeft(start: number, now: number, visible: number | null): number {
	if (visible === null) return LIVE_GRACE_MS;
	return Math.max(0, LIVE_GRACE_MS - Math.max(0, now - Math.max(start, visible)));
}

/** App.tsx: the view now shown. */
export function setPageView(v: PageView): void {
	if (v === view) return;
	view = v;
	notify();
}

export function pageView(): PageView {
	return view;
}

/** When the tab last became visible; null while hidden. */
export function liveVisibleAt(): number | null {
	return visibleAt;
}

/** A view's own data signal (roles-state.ts): fresh or not; null takes the signal away. */
export function setViewFresh(v: PageView, isFresh: boolean | null): void {
	const before = fresh.get(v);
	if (isFresh === null) {
		if (before === undefined) return;
		fresh.delete(v);
	} else {
		if (before === isFresh) return;
		fresh.set(v, isFresh);
	}
	notify();
}

/** Whether the view's own data is fresh; null when the view has no signal of its own. */
export function viewFresh(v: PageView): boolean | null {
	return fresh.get(v) ?? null;
}

/** Called on every change of view, visibility or freshness. Returns its undo. */
export function subscribePageLive(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

/** The tab became visible (at `now`) or hidden. Exported for tests; the page calls it from its events. */
export function pageVisibilityChanged(visible: boolean, now = Date.now()): void {
	if (visible) {
		if (visibleAt !== null) return;
		visibleAt = now;
	} else {
		if (visibleAt === null) return;
		visibleAt = null;
	}
	notify();
}

// Registered when the module loads, before use-chat's own listeners, so they see the new time.
if (typeof document !== "undefined" && typeof window !== "undefined") {
	document.addEventListener("visibilitychange", () => pageVisibilityChanged(document.visibilityState !== "hidden"));
	// A page restored from the back/forward cache, or a frozen tab resumed, is visible again from now.
	window.addEventListener("pagehide", () => pageVisibilityChanged(false));
	window.addEventListener("pageshow", () => pageVisibilityChanged(document.visibilityState !== "hidden"));
	document.addEventListener("freeze", () => pageVisibilityChanged(false));
	document.addEventListener("resume", () => pageVisibilityChanged(document.visibilityState !== "hidden"));
}

/** Tests: back to the start. */
export function resetPageLive(visible: number | null = Date.now()): void {
	view = "chat";
	visibleAt = visible;
	fresh.clear();
	listeners.clear();
}
