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
import { setViewFresh } from "./page-live";
import type {
	ClientMessage,
	ServerMessage,
	UiRolesOverview,
	UiRoleUsageGeneration,
	UiRolesUsageRenderTiming,
} from "./types";

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
	/** When the displayed full overview arrived (this clock, ms); not a heartbeat or an error. */
	overviewReceivedAt?: number;
	/** roles-needs-you: when this window last heard that the server looked again since its latest full
	 *  watch (this clock, ms): a full update or a heartbeat whose server checkedAt is strictly newer
	 *  than the first full update's since that watch, which may be a replay of an old look. Cleared by
	 *  every full watch, every error and every full update that isn't newer; counts never set it. */
	appliedAt?: number;
	/** When the last look failed (this clock, ms). */
	failedAt?: number;
	/** pages-live (Ops #244): since when (this clock, ms) the page has waited to hear the server looking
	 *  again: set by a full watch, a lost connection or a failed look, kept through later ones (the
	 *  earliest counts), cleared with appliedAt set and when the page stops watching. The page's alarms
	 *  wait LIVE_GRACE_MS of visible time from it (page-live.ts). */
	waitingSince?: number;
	/** Optional watch binding and server-clock telemetry; never source freshness. */
	usageRender?: { watch: number; pushedAt: number };
	usageRenderTimings?: UiRolesUsageRenderTiming[];
}

let state: RolesState = { overview: null, asks: 0, status: "idle" };
/** How many parts of the window want the whole snapshot / just the count. */
let fullWatchers = 0;
let countWatchers = 0;
/** What this window asked the server for last ("off": nothing). */
let asked: "off" | "count" | "full" = "off";
/** roles-needs-you (Security R1): the server's checkedAt on the first full update since the latest
 *  full watch; null until it comes. On a watch the server first replays what it had, with that old
 *  look's checkedAt, and looks again only later, so that first update says nothing about now. */
let firstCheckedAt: number | null = null;
const usageAcknowledged = new Set<string>();
let usageConnected = false;

const listeners = new Set<() => void>();

function notify(): void {
	for (const l of listeners) l();
}

function set(next: RolesState): void {
	state = next;
	// pages-live: the app's "Reconnecting…" note on the Roles view ends with Roles' own fresh data.
	setViewFresh("roles", fullWatchers > 0 && state.appliedAt !== undefined);
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
	usageAcknowledged.clear();
	if (state.usageRender) set({ ...state, usageRender: undefined, usageRenderTimings: undefined });
	if (want !== "full" && state.waitingSince !== undefined) set({ ...state, waitingSince: undefined });
	if (want === "off") {
		appSend({ type: "roles_unwatch" });
		return;
	}
	if (want === "full") {
		firstCheckedAt = null;
		set({
			...state,
			appliedAt: undefined,
			waitingSince: state.waitingSince ?? Date.now(),
			...(state.status !== "ready" ? { status: "loading" as const } : {}),
		});
	}
	appSend({ type: "roles_watch", full: want === "full" });
}

/** Whether a payload shows the server looked again since the latest full watch: its checkedAt (a
 *  safe integer, at least 0) is strictly newer than the first full update's. The first full update
 *  only marks where that is; a heartbeat ahead of it marks nothing. */
function lookedAgain(value: unknown, overview: boolean): boolean {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return false;
	if (firstCheckedAt === null) {
		if (overview) firstCheckedAt = value;
		return false;
	}
	return value > firstCheckedAt;
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

/** pages-live: the socket was lost (onclose, or dropped by the watchdog). The data on screen is no
 *  longer known to be current: the wait for the server to look again starts now (unless it already
 *  had), and `ready` on the next socket asks again. */
export function rolesConnectionLost(): void {
	usageConnected = false;
	usageAcknowledged.clear();
	if (state.usageRender) set({ ...state, usageRender: undefined, usageRenderTimings: undefined });
	if (wanted() !== "full") return;
	if (state.appliedAt === undefined && state.waitingSince !== undefined) return;
	set({ ...state, appliedAt: undefined, waitingSince: state.waitingSince ?? Date.now() });
}

/** A new socket (`ready`): the server has forgotten this window's watch, so ask again. */
export function resendRolesWatch(): void {
	if (wanted() === "off") {
		asked = "off";
		return;
	}
	sync(true);
}

const usageUint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const usageGeneration = (v: unknown): v is UiRoleUsageGeneration => {
	if (!v || typeof v !== "object" || Array.isArray(v)) return false;
	const g = v as UiRoleUsageGeneration;
	return (
		Object.keys(v).sort().join(",") === "epoch,sequence" &&
		typeof g.epoch === "string" &&
		g.epoch.length === 64 &&
		/^[a-f0-9]{64}$/.test(g.epoch) &&
		usageUint(g.sequence)
	);
};

/** Called ONLY by a successful active-visible DOM update/refit, never by receipt or projection. */
export function acknowledgeRenderedRolesUsage(
	overview: UiRolesOverview,
	roles: { role: string; generation: UiRoleUsageGeneration }[],
): number {
	const binding = state.usageRender;
	if (
		!usageConnected ||
		state.status !== "ready" ||
		state.error !== undefined ||
		fullWatchers === 0 ||
		wanted() !== "full" ||
		asked !== "full" ||
		!binding ||
		state.overview !== overview ||
		typeof document === "undefined" ||
		document.visibilityState !== "visible"
	)
		return 0;
	let sent = 0;
	for (const item of roles.slice(0, 64)) {
		if (!usageGeneration(item.generation)) continue;
		const cost = overview.roles.find((r) => r.id === item.role)?.usageCost;
		if (
			cost?.role !== item.role ||
			cost.state !== "ready" ||
			cost.generation?.epoch !== item.generation.epoch ||
			cost.generation.sequence !== item.generation.sequence
		)
			continue;
		const key = `${item.role}:${item.generation.epoch}:${item.generation.sequence}`;
		if (usageAcknowledged.has(key)) continue;
		if (
			!appSend({
				type: "roles_watch",
				full: true,
				renderedUsage: { watch: binding.watch, role: item.role, generation: { ...item.generation } },
			})
		)
			continue;
		usageAcknowledged.add(key);
		sent++;
	}
	return sent;
}

/** `roles` from the server. */
export function receiveRoles(payload: RolesPayload): void {
	const now = Date.now();
	usageConnected = true;
	const asks = typeof payload.asks === "number" && payload.asks >= 0 ? payload.asks : state.asks;
	if (payload.overview) {
		usageAcknowledged.clear();
		const render = payload.usageRender;
		const usageRender =
			render &&
			Object.keys(render).sort().join(",") === "pushedAt,watch" &&
			usageUint(render.watch) &&
			render.watch > 0 &&
			usageUint(render.pushedAt)
				? { ...render }
				: undefined;
		const checkedAt = payload.checkedAt ?? payload.overview.at;
		const applied = lookedAgain(checkedAt, true);
		set({
			overview: payload.overview,
			...(usageRender ? { usageRender } : {}),
			asks: payload.overview.asks.length,
			status: "ready",
			checkedAt,
			heardAt: now,
			overviewReceivedAt: now,
			appliedAt: applied ? now : undefined,
			...(applied || wanted() !== "full" ? {} : { waitingSince: state.waitingSince ?? now }),
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
			usageRender: undefined,
			usageRenderTimings: undefined,
			heardAt: now,
			appliedAt: undefined,
			...(wanted() === "full" ? { waitingSince: state.waitingSince ?? now } : {}),
		});
		return;
	}
	// A closed accepted receipt is optional diagnostics, never a freshness confirmation.
	const timing = payload.usageRenderTiming;
	if (
		timing &&
		Object.keys(timing).sort().join(",") ===
			"acknowledgedAt,firstNativeObservedAt,firstObservationToAckMs,generation,pushToAckMs,pushedAt,role,watch" &&
		timing.watch === state.usageRender?.watch &&
		usageGeneration(timing.generation) &&
		typeof timing.role === "string" &&
		overviewHasGeneration(state.overview, timing.role, timing.generation) &&
		usageUint(timing.pushedAt) &&
		usageUint(timing.acknowledgedAt) &&
		timing.acknowledgedAt >= timing.pushedAt &&
		timing.pushToAckMs === timing.acknowledgedAt - timing.pushedAt &&
		(timing.firstNativeObservedAt === null
			? timing.firstObservationToAckMs === null
			: usageUint(timing.firstNativeObservedAt) &&
				timing.firstNativeObservedAt > 0 &&
				timing.firstNativeObservedAt <= timing.pushedAt &&
				timing.firstObservationToAckMs === timing.acknowledgedAt - timing.firstNativeObservedAt)
	) {
		set({
			...state,
			usageRenderTimings: [
				...(state.usageRenderTimings ?? []).filter((t) => t.role !== timing.role),
				structuredClone(timing),
			].slice(-64),
		});
		return;
	}
	// The count only (top bar), or "still the same, checked at" (the page).
	const applied = lookedAgain(payload.checkedAt, false);
	set({
		...state,
		asks,
		...(typeof payload.checkedAt === "number" ? { checkedAt: payload.checkedAt, error: undefined } : {}),
		...(applied ? { appliedAt: now, waitingSince: undefined } : {}),
		heardAt: now,
	});
}

function overviewHasGeneration(
	overview: UiRolesOverview | null,
	role: string,
	generation: UiRoleUsageGeneration,
): boolean {
	const cost = overview?.roles.find((r) => r.id === role)?.usageCost;
	return (
		cost?.role === role &&
		cost.generation?.epoch === generation.epoch &&
		cost.generation.sequence === generation.sequence
	);
}

function subscribe(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

function snapshot(): RolesState {
	return state;
}

/** The roles' state now, outside React (tests). */
export const rolesSnapshot = snapshot;

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
	firstCheckedAt = null;
	usageConnected = false;
	usageAcknowledged.clear();
	setViewFresh("roles", null);
	notify();
}
