/// <reference lib="dom" />
/**
 * subs-limits-box: the Limits box under History, a module-level store.
 *
 * The server sends `subs_limits` (every subscription's readings, from pi-multi-pass's file) to every
 * window whenever they change, and to a window that asks (`subs_limits_get`, on every connect). Only
 * the refresh button runs checks (`subs_limits_refresh`); the server answers a refresh that couldn't
 * start with `error`, to this window alone.
 *
 * Same pattern as notebook-state.ts: module-level values + listeners + `useSyncExternalStore`; the
 * getter returns a stable reference between changes.
 */
import { useSyncExternalStore } from "react";
import { appSend } from "./app-globals";
import type { ServerMessage, UiLimitWindow, UiLimitsAccount } from "./types";

export type SubsLimitsPayload = Extract<ServerMessage, { type: "subs_limits" }>;

export interface SubsLimitsState {
	/** The server has answered at least once. */
	loaded: boolean;
	accounts: UiLimitsAccount[];
	/** The last full check (ms); missing = never checked. */
	checkedAt?: number;
	/** A check runs (any window's press, or /subs limit-check in a chat). */
	checking: boolean;
	/** This window pressed refresh and the server hasn't answered yet (the spinner starts at once). */
	pressed: boolean;
	/** Why this window's last refresh couldn't run. */
	error?: string;
}

/** A press the server never answers (an older server drops it) stops spinning after this long. */
export const PRESS_TIMEOUT_MS = 60_000;

let state: SubsLimitsState = { loaded: false, accounts: [], checking: false, pressed: false };
let pressTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function set(next: SubsLimitsState): void {
	state = next;
	for (const l of listeners) l();
}

function clearPressTimer(): void {
	if (pressTimer !== null) clearTimeout(pressTimer);
	pressTimer = null;
}

/** Ask for the readings: on every (re)connect, the box needs them before anything changes. */
export function requestSubsLimits(): void {
	appSend({ type: "subs_limits_get" });
}

/** The refresh button. A press while a check runs joins it (the server sees to that). */
export function refreshSubsLimits(): void {
	clearPressTimer();
	if (!appSend({ type: "subs_limits_refresh" })) {
		set({ ...state, pressed: false, error: undefined });
		return;
	}
	set({ ...state, pressed: true, error: undefined });
	pressTimer = setTimeout(() => {
		pressTimer = null;
		if (state.pressed) set({ ...state, pressed: false });
	}, PRESS_TIMEOUT_MS);
}

/** `subs_limits` from the server. */
export function receiveSubsLimits(msg: SubsLimitsPayload): void {
	const accounts = Array.isArray(msg.accounts) ? msg.accounts : [];
	const checking = msg.checking === true;
	// The press is answered once the server says a check runs, that the one running is over, or why it
	// couldn't start. Anything else (numbers from a reply) leaves it waiting.
	const waiting = state.pressed && !state.checking && !checking && !msg.error;
	if (!waiting) clearPressTimer();
	set({
		loaded: true,
		accounts,
		...(typeof msg.checkedAt === "number" ? { checkedAt: msg.checkedAt } : {}),
		checking,
		pressed: waiting,
		...(msg.error ? { error: msg.error } : state.error && !checking ? { error: state.error } : {}),
	});
}

export function getSubsLimits(): SubsLimitsState {
	return state;
}

function subscribe(l: () => void): () => void {
	listeners.add(l);
	return () => listeners.delete(l);
}

export function useSubsLimits(): SubsLimitsState {
	return useSyncExternalStore(subscribe, getSubsLimits, getSubsLimits);
}

/** Tests only. */
export function resetSubsLimitsForTest(): void {
	clearPressTimer();
	state = { loaded: false, accounts: [], checking: false, pressed: false };
}

// ---- what a row shows (pure, unit-tested) ----

export type LimitLevel = "ok" | "warn" | "bad";

/** Plain under 75%, amber from 75%, red from 90% or when limited. */
export function limitLevel(w: Pick<UiLimitWindow, "usedPercent" | "limited">): LimitLevel {
	if (w.limited) return "bad";
	const used = w.usedPercent ?? 0;
	if (used >= 90) return "bad";
	if (used >= 75) return "warn";
	return "ok";
}

/** The account is limited: its own mark, or a window at its cap. */
export function accountLimited(a: UiLimitsAccount): boolean {
	return a.limited === true || a.windows.some((w) => w.limited === true);
}

/** "4d 2h", "3h 20m", "12m", "<1m". undefined when there's no time; null when it's passed. */
export function formatResetIn(resetAt: number | undefined, now: number): string | null | undefined {
	if (resetAt === undefined) return undefined;
	const ms = resetAt * 1000 - now;
	if (ms <= 0) return null;
	const mins = Math.floor(ms / 60_000);
	if (mins < 1) return "<1m";
	const days = Math.floor(mins / 1440);
	const hours = Math.floor((mins % 1440) / 60);
	const m = mins % 60;
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return m > 0 ? `${hours}h ${m}m` : `${hours}h`;
	return `${m}m`;
}

/** How long ago, in whole units: {unit: "now"} under a minute, else minutes, hours or days. */
export function agoParts(at: number, now: number): { unit: "now" | "min" | "h" | "d"; n: number } {
	const mins = Math.floor(Math.max(0, now - at) / 60_000);
	if (mins < 1) return { unit: "now", n: 0 };
	if (mins < 60) return { unit: "min", n: mins };
	const hours = Math.floor(mins / 60);
	if (hours < 48) return { unit: "h", n: hours };
	return { unit: "d", n: Math.floor(hours / 24) };
}

/** 5-hour first, then weekly, then the rest (per-model weekly windows) as pi-multi-pass listed them. */
export function orderedWindows(windows: UiLimitWindow[]): UiLimitWindow[] {
	const rank = (w: UiLimitWindow) => (w.key === "5h" ? 0 : w.key === "7d" ? 1 : 2);
	return windows
		.map((w, i) => ({ w, i }))
		.sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i)
		.map(({ w }) => w);
}

/** Who the account is: its label, else its email. */
export function accountWho(a: UiLimitsAccount): string | undefined {
	return a.label || a.email || undefined;
}
