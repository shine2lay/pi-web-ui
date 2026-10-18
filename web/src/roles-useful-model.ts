/** Closed presentation only. The inherited full wire/store is NOT a confidentiality boundary.
 * No native identity or execution claim can be derived from this feed.
 * Each call constructs a fresh projection of one received snapshot; nothing is retained or joined.
 *
 * roles-needs-you (task #200, owner plan 2026-10-16): widens the 2026-10-15 closed contract by
 * existing feed fields only: task names, blockers, asking/working/paused markers, the newest line
 * of a working task, the owner's open asks and in-app chat targets. Agent-written text becomes
 * bounded plain text or a fixed fallback; chat targets stay in memory and only ever reach the app's
 * existing openFromRoles path (switch_session, which the server path-checks again).
 * Security's design disposition (security-lab/roles-existing-feed-2026-10-15/ADDENDUM-OPS200.md)
 * sets the conditions kept here: whole-string rejection, "needs a decision" and "paused" wording,
 * every ask counted, a scoped "none reported" line only after a full update in this connection,
 * and zero counts only under the same guards as any other number.
 */
import { parseFocus } from "./chat-focus";

export const ROLE_LIMIT = 64;
export const RECORD_LIMIT = 20;
export const LABEL_LIMIT = 120;
export const NAME_LIMIT = 160;
export const TEXT_LIMIT = 300;
export const ASK_LIMIT = 50;
export const PATH_LIMIT = 4096;
/** No word from the server for this long while connected (it confirms every ~30 s): not live. */
export const STALE_MS = 120_000;
/** An ask's start may be this far ahead of this browser's clock (another device); more: "time unknown". */
export const CLOCK_SKEW_MS = 300_000;
/** The server reads at most this many started task chats per role (ROLES_TASK_CHATS_MAX): open
 *  dialogs in the others aren't seen, so "nothing waits on you" can't be said then. */
export const TASK_CHATS_READ = 8;
const KEY_LIMIT = 300;

const STATUSES = ["ready", "working", "asking", "stuck", "waiting", "blocked", "done", "dropped"] as const;
const STOP_REASONS = ["user", "stopped", "error", "restart", "finished"] as const;
/** Rejects the whole text: controls, format characters (every bidi control, zero-width characters,
 *  the soft hyphen, tag characters), lone surrogates, private-use and unassigned code points, and
 *  line/paragraph separators. In agent text, tab, CR and LF read as one space first: visible
 *  whitespace a text node shows as a space anyway (multi-line task questions). Paths get no such pass. */
export const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029]/u;

export type ReportedStatus = (typeof STATUSES)[number];
export type StopReason = (typeof STOP_REASONS)[number];
export type PauseMarker = "reported-paused" | "not-reported" | "unknown";
/** A reported number (0 included), or why there is none. */
export type ReplayCount = number | "unavailable" | "no-queue";
export type SourceState =
	| "awaiting"
	| "error"
	| "cached-error"
	| "disconnected"
	| "cached"
	| "stale"
	| "partial"
	| "unknown"
	| "connected-source-unverified";
/** What a task row says, in plain words (the view maps each to one fixed string). */
export type RowState =
	| "ready"
	| "ready-after"
	| "working"
	| "asking-ops"
	| "asking-lead"
	| "asking-main"
	| "asking"
	| "needs-decision"
	| "on-hold"
	| "blocked"
	| "done"
	| "dropped"
	| "unknown";
/** Whether the "Needs you" list is the current one (only then may an empty list read "none reported"). */
export type TellState = "can-tell" | "not-live" | "feed-error" | "awaiting" | "partial" | "decision" | "unknown";

/** An existing chat, maybe at one item of it (the Queue tab's task, a TL;DR line, a question). */
export interface UsefulOpenTarget {
	file: string;
	focus?: { kind: "tldr" | "task" | "question"; id: string };
	/** roles-panel: a message in that chat to jump to (its time), like a 6 am report's answer. */
	jumpAt?: number;
}
export interface UsefulRecord {
	taskId: number;
	/** null: absent or unsafe; the row says "Task #N" only. */
	name: string | null;
	state: RowState;
	/** asking-lead (owner 2026-10-17): the role whose lead has its question (its department, or one up the chain). */
	askLead: string | null;
	waitsOn: string | null;
	busy: boolean;
	/** The newest line of its own chat; working tasks only. */
	latest: string | null;
	/** queue-drop: why its lead dropped it; dropped tasks only (null: absent or unsafe). */
	dropped: string | null;
	pause: PauseMarker;
	link: UsefulOpenTarget | null;
}
export interface UsefulRecords {
	available: boolean;
	omitted: boolean;
	notAllShown: boolean;
	records: UsefulRecord[];
}
export interface UsefulSpend {
	state: "ok" | "over" | "stale" | "none" | "old-week" | "unreadable";
	line: string;
	amounts: string | null;
	initiatives: { id: string; amount: string }[];
}
/** The existing tally is reported, not independently measured or enforced by this view. */
export function projectSpend(value: unknown): UsefulSpend | null {
	const s = object(value);
	const state = s?.state;
	if (
		state !== "ok" &&
		state !== "over" &&
		state !== "stale" &&
		state !== "none" &&
		state !== "old-week" &&
		state !== "unreadable"
	)
		return null;
	const line = plain(s?.line, 420);
	if (!line || line.clipped || /(?:\/|[a-z]:\\)[^\n\r]*?\.jsonl\b/i.test(line.text)) return null;
	const money = (v: unknown): v is string =>
		typeof v === "string" && v.length <= 40 && /^\$(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d{2})?$/.test(v);
	const amounts = money(s?.spent) && money(s?.budget) ? `${s.spent} / ${s.budget}` : null;
	if ((state === "ok" || state === "stale" || state === "over") && amounts === null) return null;
	const initiatives: UsefulSpend["initiatives"] = [];
	if (Array.isArray(s?.byInitiative))
		for (const raw of s.byInitiative.slice(0, 20)) {
			const row = object(raw);
			if (
				typeof row?.id === "string" &&
				row.id.length <= 60 &&
				/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.id) &&
				money(row.amount)
			)
				initiatives.push({ id: row.id, amount: row.amount });
		}
	return { state, line: line.text, amounts, initiatives };
}
export interface UsefulRole {
	roleId: string;
	roleLabel: string;
	labelTruncated: boolean;
	partial: boolean;
	queueEnabled: boolean | null;
	stopReason: StopReason | null;
	hold: PauseMarker;
	counts: { active: ReplayCount; queued: ReplayCount; done: ReplayCount; dropped: ReplayCount };
	active: UsefulRecords;
	queued: UsefulRecords;
	/** queue-drop: the tasks its lead dropped, newest first (the server sends at most ROLES_DROPPED_MAX). */
	dropped: UsefulRecords;
	spend?: UsefulSpend | null;
}
export interface NeedsYouItem {
	/** Validated roster id, for associating the ask with one role's panel, never its display name. */
	roleId: string | null;
	/** Its place in the feed; React only, never rendered. */
	key: string;
	/** Opaque AskHub target, kept only in memory. No URL or DOM data attribute. */
	answer?: { key: string; id: string };
	/** null: an unknown or invalid role; the row says "Unknown role". */
	roleLabel: string | null;
	/** null: absent or unsafe; the row says "Open item". */
	text: string | null;
	/** null: absent, invalid or in the future; the row says "time unknown". */
	since: number | null;
	link: UsefulOpenTarget | null;
}
export interface NeedsYou {
	tell: TellState;
	/** When this window applied the last full update in this connection (its clock); only when "can-tell". */
	asOf: number | null;
	/** Every ask the feed reported, unreadable ones included. */
	total: number;
	items: NeedsYouItem[];
	/** Asks beyond ASK_LIMIT, unreadable ones included. */
	more: number;
}
export interface UsefulRoles {
	source: SourceState;
	roster: "reported" | "unavailable";
	omitted: boolean;
	/** The roles below are as last received, not current (not live, feed error, no full update yet). */
	lastReceived: boolean;
	roles: UsefulRole[];
	needsYou: NeedsYou;
}

export type Fields = Record<string, unknown>;
type Bounded = { text: string; clipped: boolean };
/* roles-panel: the role panel (roles-panel-model.ts) projects through the same checks; they are exported for it. */
export function object(value: unknown): Fields | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : null;
}
export function roleId(value: unknown): value is string {
	// Require the entire matched value, not a prefix match.
	return typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.exec(value)?.[0] === value;
}
export function taskId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
export function time(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
function status(value: unknown): ReportedStatus | null {
	return STATUSES.find((candidate) => candidate === value) ?? null;
}
function stop(value: unknown): StopReason | null {
	return STOP_REASONS.find((candidate) => candidate === value) ?? null;
}
export function marker(record: Fields | null, key: string): PauseMarker {
	if (!record) return "unknown";
	if (!Object.hasOwn(record, key)) return "not-reported";
	const value = object(record[key]);
	return value &&
		typeof value.at === "number" &&
		Number.isFinite(value.at) &&
		typeof value.why === "string" &&
		value.why.trim().length > 0
		? "reported-paused"
		: "unknown";
}
/** A reported number, 0 included, only when the role's queue was read without problems, the field is
 *  a safe integer >= 0 (no defaults) and it fits the rows received. Otherwise "couldn't read". */
function count(value: unknown, readable: boolean, fits: (n: number) => boolean = () => true): ReplayCount {
	return readable && typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && fits(value)
		? value
		: "unavailable";
}
/** Any reported problem (or a malformed list); absence or an empty list means none. */
function anyProblem(value: unknown): boolean {
	return value !== undefined && (!Array.isArray(value) || value.length > 0);
}
/** An ask's start: a safe integer, not further ahead of this browser's clock than CLOCK_SKEW_MS. */
function sinceOf(value: unknown, now: number | undefined): number | null {
	return typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value > 0 &&
		(now === undefined || value <= now + CLOCK_SKEW_MS)
		? value
		: null;
}
/** Agent-written text -> bounded plain text, or null when absent or unsafe. Never partly shown:
 *  an unsafe character anywhere rejects all of it. */
export function plain(value: unknown, limit: number): Bounded | null {
	if (typeof value !== "string") return null;
	const text = value.replace(/[\t\n\r]+/g, " ").trim();
	if (!text || UNSAFE.test(text)) return null;
	// At most 2 code units per code point: this head holds limit + 1 whole code points if more exist.
	const head = Array.from(text.slice(0, limit * 2 + 2));
	if (text.length <= limit * 2 + 2 && head.length <= limit) return { text, clipped: false };
	return { text: head.slice(0, limit - 1).join("") + "…", clipped: true };
}
function label(value: unknown, id: string): { text: string; truncated: boolean } {
	const bounded = plain(value, LABEL_LIMIT);
	return bounded ? { text: bounded.text, truncated: bounded.clipped } : { text: id, truncated: false };
}
/** A transcript path as the feed gives it: absolute, .jsonl, no empty, "." or ".." segment, no unsafe
 *  character. The server checks it again (inside the sessions folder) when it is opened. */
export function chatFile(value: unknown): string | null {
	if (typeof value !== "string" || value.length > PATH_LIMIT || UNSAFE.test(value) || !value.endsWith(".jsonl"))
		return null;
	const root = /^(\/|[A-Za-z]:[\\/])/.exec(value)?.[0];
	if (!root) return null;
	return value
		.slice(root.length)
		.split(/[\\/]/)
		.every((segment) => segment !== "" && segment !== "." && segment !== "..")
		? value
		: null;
}
export function focusOf(value: unknown): UsefulOpenTarget["focus"] | null {
	if (typeof value !== "string" || value !== value.trim()) return null;
	const focus = parseFocus(value);
	if (!focus) return null;
	return focus.kind === "tldr" || focus.kind === "task" || focus.kind === "question"
		? { kind: focus.kind, id: focus.id }
		: null;
}
export function idFrequencies(
	rows: unknown[],
	getId: (value: unknown) => string | number | null,
): Map<string | number, number> {
	const seen = new Map<string | number, number>();
	for (const row of rows) {
		const id = getId(row);
		if (id !== null) seen.set(id, (seen.get(id) ?? 0) + 1);
	}
	return seen;
}
function rowState(row: Fields, reported: ReportedStatus | null): RowState {
	switch (reported) {
		case "ready":
			// A ready task that waits on other tasks never reads as "ready".
			return typeof row.waitsOn === "string" && row.waitsOn.trim() ? "ready-after" : "ready";
		case "working":
			return "working";
		case "asking":
			if (row.askOps === true) return roleId(row.askLead) && row.askLead !== "ops" ? "asking-lead" : "asking-ops";
			return row.askOps === undefined ? "asking-main" : "asking";
		case "stuck":
			// Task questions go to Ops or the task's lead first (rule 21): "needs you" is for asks only.
			return "needs-decision";
		case "waiting":
			return "on-hold";
		case "blocked":
			return "blocked";
		case "done":
			return "done";
		case "dropped":
			return "dropped";
		default:
			return "unknown";
	}
}
/** Started: its own chat. Not started: its queue (the home chat's Queue tab, at the task). */
function taskLink(row: Fields, id: number, home: string | null): UsefulOpenTarget | null {
	if (row.chat !== undefined) {
		const file = chatFile(object(row.chat)?.file);
		return file ? { file } : null;
	}
	const focus = focusOf(`task:${id}`);
	return home && focus ? { file: home, focus } : null;
}
export function record(row: Fields, id: number, home: string | null): UsefulRecord {
	const reported = status(row.status);
	const pause = marker(row, "paused");
	const state = rowState(row, reported);
	const latest = state === "working" ? plain(object(row.latest)?.text, TEXT_LIMIT) : null;
	return {
		taskId: id,
		name: plain(row.title, NAME_LIMIT)?.text ?? null,
		state,
		askLead: state === "asking-lead" && roleId(row.askLead) ? row.askLead : null,
		waitsOn: plain(row.waitsOn, NAME_LIMIT)?.text ?? null,
		busy: row.busy === true,
		latest: latest ? latest.text : null,
		dropped: state === "dropped" ? (plain(object(row.dropped)?.why, TEXT_LIMIT)?.text ?? null) : null,
		pause,
		link: taskLink(row, id, home),
	};
}
function records(
	value: unknown,
	seen: Map<string | number, number>,
	reported: ReplayCount,
	home: string | null,
): UsefulRecords {
	const result: UsefulRecords = {
		available: Array.isArray(value),
		omitted: false,
		notAllShown: typeof reported === "number" && reported > 0,
		records: [],
	};
	if (!Array.isArray(value)) return result;
	// omitted: rows that can't be shown (malformed, or an id seen twice); capped: valid rows past the cap.
	let capped = false;
	for (const raw of value) {
		const row = object(raw);
		if (!row || !taskId(row.id) || seen.get(row.id) !== 1) {
			result.omitted = true;
			continue;
		}
		if (result.records.length >= RECORD_LIMIT) {
			capped = true;
			continue;
		}
		result.records.push(record(row, row.id, home));
	}
	result.notAllShown = capped || (typeof reported === "number" && reported > result.records.length);
	return result;
}
interface ProjectedRole {
	role: UsefulRole;
	/** Every started task chat was read (open dialogs in the rest aren't seen). */
	asksSeen: boolean;
	/** The ask key each stuck task should have ("<role>:task:<n>"), unless reported paused. */
	decisionKeys: string[];
}
function projectRole(row: Fields, id: string): ProjectedRole {
	const name = label(row.title, id);
	const queuePresent = row.queue !== undefined;
	const queue = object(row.queue);
	const problems = anyProblem(row.problems);
	const home = chatFile(object(row.homeChat)?.file);
	const rawCounts = object(queue?.counts);
	const activeRows = Array.isArray(queue?.active) ? queue.active.length : null;
	const queuedRows = Array.isArray(queue?.queued) ? queue.queued.length : null;
	// queue-drop: the server sends the dropped list (capped) and its count only when there are some.
	const droppedRows = Array.isArray(queue?.dropped) ? queue.dropped.length : null;
	// Zero is shown like any other number, under the same guards (Security addendum, item 8). Active
	// rows aren't capped, so they must match; queued rows are capped, so the count may be larger.
	const readable = queue !== null && !problems;
	const counts: UsefulRole["counts"] =
		!queuePresent && !problems
			? { active: "no-queue", queued: "no-queue", done: "no-queue", dropped: "no-queue" }
			: {
					active: count(rawCounts?.active, readable, (n) => n === activeRows),
					queued: count(rawCounts?.queued, readable, (n) => queuedRows !== null && n >= queuedRows),
					done: count(rawCounts?.done, readable),
					// Counts read, with neither the dropped count nor the list: none dropped (0).
					dropped: count(
						rawCounts && rawCounts.dropped === undefined && droppedRows === null ? 0 : rawCounts?.dropped,
						readable,
						(n) => (droppedRows === null ? n === 0 : n >= droppedRows),
					),
				};
	// Ambiguity is role-local and spans both received lists, even beyond the display cap.
	const taskRows: unknown[] = [];
	if (Array.isArray(queue?.active)) for (const task of queue.active) taskRows.push(task);
	if (Array.isArray(queue?.queued)) for (const task of queue.queued) taskRows.push(task);
	if (Array.isArray(queue?.dropped)) for (const task of queue.dropped) taskRows.push(task);
	const seen = idFrequencies(taskRows, (raw) => {
		const candidate = object(raw)?.id;
		return taskId(candidate) ? candidate : null;
	});
	const active = records(queue?.active, seen, counts.active, home);
	const queued = records(queue?.queued, seen, counts.queued, home);
	const dropped = records(queue?.dropped, seen, counts.dropped, home);
	let startedChats = 0;
	if (Array.isArray(queue?.active)) for (const task of queue.active) if (object(task)?.chat) startedChats++;
	// The server lists every stuck task's question unless the task, or else its queue, is paused
	// (taskQueueHeld). Only a well-formed pause excuses a missing question.
	const hold = queuePresent ? marker(queue, "hold") : "not-reported";
	const decisionKeys: string[] = [];
	for (const raw of taskRows) {
		const task = object(raw);
		if (!task || task.status !== "stuck" || !taskId(task.id)) continue;
		if (marker(task, "paused") === "reported-paused" || hold === "reported-paused") continue;
		decisionKeys.push(`${id}:task:${task.id}`);
	}
	return {
		role: {
			roleId: id,
			roleLabel: name.text,
			labelTruncated: name.truncated,
			partial: problems || (queuePresent && (!queue || !active.available || !queued.available)),
			queueEnabled: typeof queue?.running === "boolean" ? queue.running : null,
			stopReason: stop(queue?.pausedReason),
			hold,
			counts,
			active,
			queued,
			dropped,
			spend: projectSpend(row.spend),
		},
		asksSeen: startedChats <= TASK_CHATS_READ,
		decisionKeys,
	};
}
function askLink(ask: Fields): UsefulOpenTarget | null {
	const file = chatFile(object(ask.chat)?.file);
	if (!file) return null;
	const focus = focusOf(ask.focus);
	return focus ? { file, focus } : { file };
}
function askKey(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= KEY_LIMIT;
}
function answerTarget(ask: Fields, unique: boolean): NeedsYouItem["answer"] {
	if (
		!unique ||
		!roleId(ask.role) ||
		(ask.kind !== "question" && ask.kind !== "task") ||
		!askKey(ask.key) ||
		UNSAFE.test(ask.key) ||
		typeof ask.askId !== "string" ||
		!ask.askId ||
		ask.askId.length > 200 ||
		UNSAFE.test(ask.askId)
	)
		return undefined;
	const focus = focusOf(ask.focus);
	if (!focus || focus.kind !== ask.kind || ask.key !== `${ask.role}:${ask.kind}:${focus.id}`) return undefined;
	return { key: ask.key, id: ask.askId };
}
function needsYou(
	overview: Fields | null,
	labels: Map<string, string>,
	source: SourceState,
	roles: { asksSeen: boolean; decisionKeys: string[] },
	applied: number | null,
	now: number | undefined,
): NeedsYou {
	const listed = Array.isArray(overview?.asks);
	const raw: unknown[] = Array.isArray(overview?.asks) ? overview.asks : [];
	const items: NeedsYouItem[] = [];
	const keys = new Set<string>();
	const counts = idFrequencies(raw, (value) => {
		const key = object(value)?.key;
		return askKey(key) ? key : null;
	});
	// Feed order (oldest first). Every entry counts; one that can't be read still shows, as "Open item".
	raw.forEach((value, index) => {
		const ask = object(value) ?? {};
		if (askKey(ask.key)) keys.add(ask.key);
		if (index >= ASK_LIMIT) return;
		items.push({
			key: String(index),
			roleId: roleId(ask.role) && labels.has(ask.role) ? ask.role : null,
			answer: answerTarget(ask, counts.get(String(ask.key)) === 1),
			roleLabel: roleId(ask.role) ? (labels.get(ask.role) ?? null) : null,
			text: plain(ask.text, TEXT_LIMIT)?.text ?? null,
			since: sinceOf(ask.since, now),
			link: askLink(ask),
		});
	});
	let tell: TellState;
	if (source === "disconnected" || source === "cached" || source === "stale") tell = "not-live";
	else if (source === "error" || source === "cached-error") tell = "feed-error";
	else if (source === "awaiting") tell = "awaiting";
	else if (source === "partial" || !roles.asksSeen || (overview !== null && !listed)) tell = "partial";
	else if (source !== "connected-source-unverified") tell = "unknown";
	// Withdrawn on every new watch and every error until the server is heard looking again (roles-state appliedAt).
	else if (applied === null) tell = "awaiting";
	// A stuck task whose question isn't in the list: the list can't be the whole story.
	else if (roles.decisionKeys.some((key) => !keys.has(key))) tell = "decision";
	else tell = "can-tell";
	return {
		tell,
		asOf: tell === "can-tell" ? applied : null,
		total: raw.length,
		items,
		more: Math.max(0, raw.length - ASK_LIMIT),
	};
}

/** Input deliberately unknown: validate at the actual store/consumer boundary, not only by DTO types.
 *  `now` (this browser's clock) turns a silent feed into "stale"; without it nothing is aged. */
export function projectUsefulRoles(state: unknown, connection: unknown, now?: number): UsefulRoles {
	const input = object(state);
	const overview = object(input?.overview);
	const rows = Array.isArray(overview?.roles) ? overview.roles : [];
	const seen = idFrequencies(rows, (raw) => {
		const candidate = object(raw)?.id;
		return roleId(candidate) ? candidate : null;
	});
	const roles: UsefulRole[] = [];
	const labels = new Map<string, string>();
	let omitted = false;
	const coverage = { asksSeen: true, decisionKeys: [] as string[] };
	for (const raw of rows) {
		const row = object(raw);
		if (!row || !roleId(row.id) || seen.get(row.id) !== 1 || roles.length >= ROLE_LIMIT) {
			omitted = true;
			continue;
		}
		const projected = projectRole(row, row.id);
		roles.push(projected.role);
		labels.set(projected.role.roleId, projected.role.roleLabel);
		if (!projected.asksSeen) coverage.asksSeen = false;
		for (const key of projected.decisionKeys) coverage.decisionKeys.push(key);
	}
	const cached = overview !== null;
	const error =
		input?.status === "error" || (input !== null && Object.hasOwn(input, "error") && input.error !== undefined);
	const heard = time(input?.heardAt);
	const stale = cached && typeof now === "number" && (heard === null || now - heard > STALE_MS);
	let source: SourceState;
	if (connection === "closed" || connection === "connecting") source = cached ? "cached" : "disconnected";
	else if (error) source = cached ? "cached-error" : "error";
	else if (!cached && (input?.status === "idle" || input?.status === "loading")) source = "awaiting";
	else if (connection !== "open" || !cached) source = "unknown";
	else if (stale) source = "stale";
	else if (!roles.length || omitted || roles.some((row) => row.partial)) source = "partial";
	else source = "connected-source-unverified";
	const needs = needsYou(overview, labels, source, coverage, time(input?.appliedAt), now);
	return {
		source,
		roster: roles.length ? "reported" : "unavailable",
		omitted,
		// Security addendum (item 8): whenever the page can't tell, counts are marked last received, not current.
		lastReceived: roles.length > 0 && needs.tell !== "can-tell",
		roles,
		needsYou: needs,
	};
}
