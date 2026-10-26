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
import { appAdmit } from "./app-admit";
import { appSend } from "./app-globals";
import { setViewFresh } from "./page-live";
import type {
	ClientMessage,
	ServerMessage,
	UiBoardPostKind,
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

/** Raw authored source, not a replayable action or an authority/owner receipt. */
export type BoardDraftForm =
	| Readonly<{
			type: "board_post";
			kind: UiBoardPostKind;
			toAll: boolean;
			picked: readonly string[];
			title: string;
			text: string;
	  }>
	| Readonly<{ type: "board_close"; id: string; note: string }>;
export interface BoardDraftSource {
	readonly editorId: string;
	readonly revision: number;
	readonly form: BoardDraftForm;
}
export interface BoardDraftAttempt {
	readonly reqId: string;
	readonly source: BoardDraftSource;
	readonly admission: "pending" | "admitted" | "unconfirmed";
	readonly result?: BoardResult;
}
export interface BoardDraftRecovery {
	readonly current: BoardDraftSource;
	readonly attempts: readonly BoardDraftAttempt[];
	readonly restoredSources: readonly BoardDraftSource[];
}
type BoardRecord = {
	current: BoardDraftSource;
	attempts: { -readonly [K in keyof BoardDraftAttempt]: BoardDraftAttempt[K] }[];
	restoredSources: BoardDraftSource[];
};
const boardDrafts = new Map<string, BoardRecord>();
let boardSources = new WeakMap<ClientMessage, BoardDraftSource>();
let boardSeq = 0;

function copyBoardSource(source: BoardDraftSource): BoardDraftSource {
	const f = source.form;
	const form: BoardDraftForm = Object.freeze(
		f.type === "board_post"
			? {
					type: f.type,
					kind: f.kind,
					toAll: f.toAll,
					picked: Object.freeze([...f.picked]),
					title: f.title,
					text: f.text,
				}
			: { type: f.type, id: f.id, note: f.note },
	);
	return Object.freeze({ editorId: source.editorId, revision: source.revision, form });
}
function boardRecord(source: BoardDraftSource): BoardRecord {
	let record = boardDrafts.get(source.editorId);
	if (!record) {
		record = { current: source, attempts: [], restoredSources: [] };
		boardDrafts.set(source.editorId, record);
	}
	return record;
}

/** New editor lifetime. Copies and retains every source field, including inactive choices. */
export function createBoardDraft(form: BoardDraftForm): BoardDraftSource {
	const source = copyBoardSource({ editorId: crypto.randomUUID(), revision: 0, form });
	boardRecord(source);
	return source;
}
/** Every actual edit advances ownership, including A → B → A. */
export function reviseBoardDraft(source: BoardDraftSource, form: BoardDraftForm): BoardDraftSource {
	const next = copyBoardSource({ editorId: source.editorId, revision: source.revision + 1, form });
	boardRecord(source).current = next;
	return next;
}
/** The registered #570 handler must read this exact-identity lookup BEFORE clone/await. */
export function getBoardAdmissionSource(message: ClientMessage): BoardDraftSource | undefined {
	return boardSources.get(message);
}
/** Page memory only; immutable originals and independent current edits. No executable packets. */
export function getBoardDraftRecoveries(): readonly BoardDraftRecovery[] {
	return Object.freeze(
		[...boardDrafts.values()].map((r) =>
			Object.freeze({
				current: r.current,
				attempts: Object.freeze(r.attempts.map((a) => Object.freeze({ ...a }))),
				restoredSources: Object.freeze([...r.restoredSources]),
			}),
		),
	);
}

function boardPlain(value: unknown, keys: string[]): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
	const own = Reflect.ownKeys(value);
	return (
		own.length === keys.length &&
		keys.every((k) => {
			const d = Object.getOwnPropertyDescriptor(value, k);
			return d && "value" in d;
		})
	);
}
function boardSourceValid(value: unknown): value is BoardDraftSource {
	if (
		!boardPlain(value, ["editorId", "revision", "form"]) ||
		typeof value.editorId !== "string" ||
		!value.editorId ||
		typeof value.revision !== "number" ||
		!Number.isSafeInteger(value.revision) ||
		value.revision < 0
	)
		return false;
	const f = value.form;
	if (!f || typeof f !== "object") return false;
	const tag = Object.getOwnPropertyDescriptor(f, "type");
	if (!tag || !("value" in tag)) return false;
	if (tag.value === "board_close")
		return boardPlain(f, ["type", "id", "note"]) && typeof f.id === "string" && !!f.id && typeof f.note === "string";
	if (
		!boardPlain(f, ["type", "kind", "toAll", "picked", "title", "text"]) ||
		f.type !== "board_post" ||
		(f.kind !== "news" && f.kind !== "order") ||
		typeof f.toAll !== "boolean" ||
		typeof f.title !== "string" ||
		typeof f.text !== "string" ||
		!Array.isArray(f.picked)
	)
		return false;
	const picked = f.picked;
	return (
		Reflect.ownKeys(picked).length === picked.length + 1 &&
		Array.from({ length: picked.length }, (_, i) => {
			const d = Object.getOwnPropertyDescriptor(picked, i);
			return d && "value" in d && typeof d.value === "string";
		}).every(Boolean)
	);
}
/** LOOK/EDIT ONLY: retain a validated full original; never open, submit, close or replay it. */
export function restoreBoardDraft(value: unknown): boolean {
	try {
		if (!boardSourceValid(value)) return false;
		const source = copyBoardSource(value);
		const record = boardDrafts.get(source.editorId);
		const known = record ? [record.current, ...record.attempts.map((a) => a.source), ...record.restoredSources] : [];
		if (known.some((s) => s.revision === source.revision && JSON.stringify(s) !== JSON.stringify(source))) return false;
		const retained = boardRecord(source);
		if (!retained.restoredSources.some((s) => JSON.stringify(s) === JSON.stringify(source)))
			retained.restoredSources.push(source);
		return true;
	} catch {
		return false;
	}
}

type BoardWait = {
	op: "post" | "close";
	id?: string;
	admitted: boolean;
	early?: BoardResult;
	finish: (r: BoardResult) => void;
};
const boardWaits = new Map<string, BoardWait>();
const boardUnknown = "no answer from the server: look at the board before trying again";

function copyBoardResult(r: BoardResult): BoardResult {
	const copy: BoardResult = {
		type: r.type,
		op: r.op,
		ok: r.ok,
		...(r.reqId !== undefined ? { reqId: r.reqId } : {}),
		...(r.id !== undefined ? { id: r.id } : {}),
		...(r.error !== undefined ? { error: r.error } : {}),
		...(r.direct ? { direct: [...r.direct] } : {}),
		...(r.later ? { later: [...r.later] } : {}),
	};
	if (copy.direct) Object.freeze(copy.direct);
	if (copy.later) Object.freeze(copy.later);
	return Object.freeze(copy);
}

/** Local exact-true admission PLUS a genuine correlated board_result. Never a fallback send.
 *  The original answer deadline starts before admission; unknown outcomes require explicit review/retry. */
export function boardRequest(
	ask: BoardAsk,
	source: BoardDraftSource,
	answerMs = BOARD_ANSWER_MS,
): Promise<BoardResult> {
	const original = copyBoardSource(source);
	const reqId = `board-${Date.now().toString(36)}-${++boardSeq}`;
	const op = ask.type === "board_post" ? "post" : "close";
	const message = {
		...ask,
		...(ask.type === "board_post" && Array.isArray(ask.to) ? { to: [...ask.to] } : {}),
		reqId,
	} as ClientMessage;
	if (message.type === "board_post" && Array.isArray(message.to)) Object.freeze(message.to);
	Object.freeze(message);
	boardSources.set(message, original);
	const attempt: BoardRecord["attempts"][number] = { reqId, source: original, admission: "pending" };
	boardRecord(original).attempts.push(attempt);
	return new Promise((resolve) => {
		let finished = false;
		const finish = (result: BoardResult) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			boardWaits.delete(reqId);
			attempt.result = copyBoardResult(result);
			resolve(attempt.result);
		};
		const timer = setTimeout(
			() => finish({ type: "board_result", reqId, op, ok: false, error: boardUnknown }),
			answerMs,
		);
		const wait: BoardWait = { op, ...(ask.type === "board_close" ? { id: ask.id } : {}), admitted: false, finish };
		// The real result can arrive synchronously inside the host, BEFORE its admission promise settles.
		boardWaits.set(reqId, wait);
		void appAdmit(message).then(
			(admitted) => {
				attempt.admission = admitted === true ? "admitted" : "unconfirmed";
				if (finished) return;
				if (admitted !== true) {
					finish({ type: "board_result", reqId, op, ok: false, error: `not locally admitted: ${boardUnknown}` });
					return;
				}
				wait.admitted = true;
				if (wait.early) finish(wait.early);
			},
			() => {
				attempt.admission = "unconfirmed";
				finish({ type: "board_result", reqId, op, ok: false, error: `local admission failed: ${boardUnknown}` });
			},
		);
	});
}

/** Only an actual result for this operation can finish it; duplicates/stale/wrong results are inert. */
export function receiveBoardResult(r: BoardResult): void {
	if (r.type !== "board_result" || typeof r.reqId !== "string" || !r.reqId) return;
	if ((r.id !== undefined && typeof r.id !== "string") || (r.error !== undefined && typeof r.error !== "string"))
		return;
	if (
		[r.direct, r.later].some(
			(list) => list !== undefined && (!Array.isArray(list) || !list.every((id) => typeof id === "string")),
		)
	)
		return;
	const wait = boardWaits.get(r.reqId);
	if (!wait || r.op !== wait.op || typeof r.ok !== "boolean" || wait.early) return;
	if (r.ok && (typeof r.id !== "string" || !r.id || (wait.op === "close" && r.id !== wait.id))) return;
	if (wait.op === "close" && r.id !== undefined && r.id !== wait.id) return;
	const result = copyBoardResult(r);
	if (wait.admitted) wait.finish(result);
	else wait.early = result;
}

/** Tests only: forget the synthetic Board records, settling pending promises without authority. */
export function resetBoardDrafts(): void {
	for (const [reqId, wait] of boardWaits)
		wait.finish({ type: "board_result", reqId, op: wait.op, ok: false, error: boardUnknown });
	boardDrafts.clear();
	boardSources = new WeakMap();
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
