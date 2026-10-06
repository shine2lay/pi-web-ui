/**
 * roles-overview: what the Roles page shows, worked out from the server's snapshot (pure functions, no
 * React, so the unit tests cover them). The page itself is components/RolesView.tsx.
 *
 * Rules (design-lab/roles-page/SPEC.md):
 * - Two groups, "Start their own work" and "Work on request", alphabetical inside each, so a role is
 *   always in the same place.
 * - A tile's one line: its newest open ask, else its newest TL;DR line (home chat and task chats), else
 *   for a role that works on request the open request to it ("<from> asked: ...") or "Waiting for
 *   requests", and for a role that starts its own work "Nothing yet". A quiet role (nothing going on and
 *   no TL;DR line in 24 h) is a tile that steps back.
 * - A tile's queue words: the first active task in the order needs you, working, asking, on hold
 *   (queue order among equals) and the counts, never cut.
 * - Whether the "Waiting on you" strip is open is kept on this device, the phone and the desktop layouts
 *   each their own.
 */
import { stripMarkdown } from "./copy-text";
import type { Translate } from "./i18n";
import type { UiRoleAsk, UiRoleGoal, UiRoleOverview, UiRoleQueue, UiRoleReport, UiRoleTask } from "./types";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
/** A role without a TL;DR line this long (and nothing going on) is a quiet tile. */
export const QUIET_MS = DAY_MS;
/** Goals shown before "+N more". */
export const GOALS_SHOWN = 3;
/** TL;DR lines a role's details panel shows before "More (n)". */
export const CARD_LINES_SHOWN = 5;
/** No word from the server this long (it pushes at least every 30 s while watched): not live. */
export const STALE_MS = 75_000;

export type RolesLayout = "phone" | "desktop";

/** The two groups, alphabetical inside each. */
export function groupRoles(roles: readonly UiRoleOverview[]): {
	selfStart: UiRoleOverview[];
	onRequest: UiRoleOverview[];
} {
	const byId = [...roles].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return {
		selfStart: byId.filter((r) => r.workMode === "self-start"),
		onRequest: byId.filter((r) => r.workMode !== "self-start"),
	};
}

/** Nothing going on and no TL;DR line in 24 h: a quiet tile. */
export function isQuiet(role: UiRoleOverview, now: number): boolean {
	if (role.asks.length > 0) return false;
	if (role.status === "needs-you" || role.status === "busy" || role.status === "paused") return false;
	if ((role.queue?.counts.active ?? 0) > 0) return false;
	const newest = role.tldr[0];
	return !newest || now - newest.ts >= QUIET_MS;
}

/** The newest of a role's open asks (the latest known start; asks without one count as oldest). */
export function newestAsk(asks: readonly UiRoleAsk[]): UiRoleAsk | undefined {
	let best: UiRoleAsk | undefined;
	for (const a of asks) {
		if (a.since === undefined) continue;
		if (!best || (best.since ?? 0) <= a.since) best = a;
	}
	return best ?? asks[asks.length - 1];
}

export type NowLine =
	| { kind: "ask"; ask: UiRoleAsk }
	| { kind: "line"; line: UiRoleOverview["tldr"][number] }
	| { kind: "request"; from: string; text: string }
	| { kind: "waiting" }
	| { kind: "nothing" };

/** A tile's one line (SPEC section 4). */
export function nowLineOf(role: UiRoleOverview, now: number): NowLine {
	const ask = newestAsk(role.asks);
	if (ask) return { kind: "ask", ask };
	const line = role.tldr[0];
	if (line) {
		// A role on request shows a line from the last day; one that starts its own work its newest.
		if (role.workMode === "self-start" || now - line.ts < QUIET_MS) return { kind: "line", line };
	}
	if (role.workMode === "self-start") return { kind: "nothing" };
	const req = role.requests.newest;
	return req ? { kind: "request", from: req.from, text: req.firstLine } : { kind: "waiting" };
}

function taskRank(task: UiRoleTask): number {
	// queue-paused: a task the owner paused neither needs him nor works: it ranks with the ones on hold.
	if (task.paused) return 3;
	if (task.status === "stuck") return 0;
	if (task.status === "working" || task.busy) return 1;
	if (task.status === "asking") return 2;
	if (task.status === "waiting" || task.status === "blocked") return 3;
	return 4;
}

/** The task a tile names: needs you, working, asking, on hold (queue order among equals). */
export function leadTask(queue: UiRoleQueue | undefined): UiRoleTask | undefined {
	let best: UiRoleTask | undefined;
	for (const task of queue?.active ?? []) {
		if (!best || taskRank(task) < taskRank(best)) best = task;
	}
	return best;
}

/** queue-paused: "Queue paused by you since 12:10: why" when the owner paused the whole queue. */
export function queuePausedText(t: Translate, queue: UiRoleQueue | undefined, now: number): string {
	return queue?.hold ? t("rolesQueuePausedSince", { time: clockOf(queue.hold.at, now), why: queue.hold.why }) : "";
}

/** The queue stopped (by the owner or its run) while it still has open tasks. */
export function queueStopped(queue: UiRoleQueue | undefined): boolean {
	if (!queue || queue.running) return false;
	return queue.counts.active + queue.counts.queued > 0;
}

/** Anything in the queue worth a line: an open task or a queued one. */
export function queueHasWork(queue: UiRoleQueue | undefined): boolean {
	return !!queue && queue.counts.active + queue.counts.queued > 0;
}

/** "+1 active · 2 queued · 11 done" (`shown`: one active task is on the line already). */
export function queueCounts(t: Translate, queue: UiRoleQueue | undefined, shown: boolean, withDone: boolean): string {
	if (!queue) return "";
	const parts: string[] = [];
	const more = queue.counts.active - (shown ? 1 : 0);
	if (more > 0) parts.push(shown ? t("rolesMoreActive", { n: more }) : t("rolesActive", { n: more }));
	if (queue.counts.queued > 0 || withDone) parts.push(t("rolesQueued", { n: queue.counts.queued }));
	if (withDone) parts.push(t("rolesDone", { n: queue.counts.done }));
	return parts.join(" \u00b7 ");
}

/** A task's status in a word or a few (an icon carries it too). */
export function taskWord(t: Translate, task: UiRoleTask, short = false): string {
	// `short` (a tile): the word alone; what a hold waits on is often a paragraph, so it stays in the panel
	const waitsOn = short ? undefined : task.waitsOn;
	// queue-paused: the owner paused it (or its whole queue); the panel says since when and why.
	if (task.paused) {
		return short
			? t("rolesTaskPausedByYou")
			: t("rolesTaskPausedSince", { time: clockOf(task.paused.at, Date.now()), why: task.paused.why });
	}
	switch (task.status) {
		case "stuck":
			return t("rolesTaskNeedsYou");
		case "working":
			return t("rolesTaskWorking");
		case "asking":
			return t("rolesTaskAsking");
		case "waiting":
			return waitsOn ? t("rolesTaskOnHoldOn", { what: waitsOn }) : t("rolesTaskOnHold");
		case "blocked":
			return waitsOn ? t("rolesTaskBlockedOn", { what: waitsOn }) : t("rolesTaskBlocked");
		case "ready":
			return task.busy ? t("rolesTaskWorking") : t("rolesTaskQueued");
		default:
			return t("rolesTaskDone");
	}
}

export type TaskLook = "needs" | "working" | "hold" | "asking" | "queued" | "paused";

/** How a task looks: needs (amber), working (accent), hold (dashed), asking (dim), queued, paused (by the owner). */
export function taskLook(task: UiRoleTask): TaskLook {
	if (task.paused) return "paused";
	if (task.status === "stuck") return "needs";
	if (task.status === "working" || task.busy) return "working";
	if (task.status === "waiting" || task.status === "blocked") return "hold";
	if (task.status === "asking") return "asking";
	return "queued";
}

/** Where a line comes from: "Home" or "#42". */
export function whereTag(t: Translate, where: "home" | number): string {
	return where === "home" ? t("rolesWhereHome") : `#${where}`;
}

/** Where an ask is answered: "Home chat" or "Task #3". */
export function askWhere(t: Translate, ask: UiRoleAsk): string {
	return ask.chat.where === "home" ? t("rolesWhereHomeChat") : t("rolesWhereTask", { n: ask.chat.where });
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** "07:05" today, "Sun 23:40" this past week, "Oct 3 23:40" before (the browser's clock). */
export function clockOf(ms: number, now: number): string {
	const d = new Date(ms);
	const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	const today = new Date(now);
	if (d.toDateString() === today.toDateString()) return hm;
	const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
	if (ms >= startOfToday - 6 * DAY_MS && ms < startOfToday + DAY_MS) {
		return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${hm}`;
	}
	return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${hm}`;
}

/** "25m", "9h", "2d" ("now" under a minute). */
export function ageOf(ms: number, now: number): string {
	const min = Math.floor(Math.max(0, now - ms) / 60_000);
	if (min < 1) return "now";
	if (min < 60) return `${min}m`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

/** "just now", "14m ago", "5h ago", "1d ago". */
export function agoOf(ms: number, now: number): string {
	const min = Math.floor(Math.max(0, now - ms) / 60_000);
	if (min < 1) return "just now";
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

/** The oldest known ask start (ms), for "oldest 9h". */
export function oldestSince(asks: readonly UiRoleAsk[]): number | undefined {
	let min: number | undefined;
	for (const a of asks) if (a.since !== undefined && (min === undefined || a.since < min)) min = a.since;
	return min;
}

/** "14 roles · 6 busy · 1 paused". */
export function rolesSummary(t: Translate, roles: readonly UiRoleOverview[]): string {
	const busy = roles.filter((r) => r.status === "busy").length;
	const paused = roles.filter((r) => r.status === "paused").length;
	const parts = [roles.length === 1 ? t("rolesCountOne") : t("rolesCount", { n: roles.length })];
	if (busy > 0) parts.push(t("rolesCountBusy", { n: busy }));
	if (paused > 0) parts.push(t("rolesCountPaused", { n: paused }));
	return parts.join(" \u00b7 ");
}

/** "On request · plus 2 goals you approved" (a role on request with approved goals), else "". The desktop
 *  board (`lead`) says "Plus 2 goals you approved:" above the names: its group already says "on request". */
export function goalsLine(t: Translate, role: UiRoleOverview, lead = false): string {
	if (role.workMode !== "request-only" || role.goals.length === 0) return "";
	if (lead) return role.goals.length === 1 ? t("rolesGoalsLeadOne") : t("rolesGoalsLead", { n: role.goals.length });
	return role.goals.length === 1 ? t("rolesGoalsLineOne") : t("rolesGoalsLine", { n: role.goals.length });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-04" or "2026-10-04T22:20" -> "Oct 4" (as written; no time zone sums). */
export function dayOfStamp(stamp: string): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(stamp);
	if (!m) return stamp;
	const month = MONTHS[Number(m[2]) - 1];
	return month ? `${month} ${Number(m[3])}` : stamp;
}

/** A goal's details in one line: "scope · approved Oct 4" (+ " · until Oct 20"). */
export function goalRest(t: Translate, goal: UiRoleGoal): string {
	const parts = [goal.scope, t("rolesGoalApproved", { day: dayOfStamp(goal.approvedAt) })];
	if (goal.endsAt) parts.push(t("rolesGoalUntil", { day: dayOfStamp(goal.endsAt) }));
	return parts.filter(Boolean).join(" \u00b7 ");
}

/** The weekday a report was asked for, in the job's time zone ("Mon"). */
export function reportDay(report: UiRoleReport, tz: string): string {
	let at = report.askedAt;
	if (!at && report.date) {
		// The day it is about + 1 (the report is asked for the next morning).
		const t = Date.parse(`${report.date}T12:00:00Z`);
		if (Number.isFinite(t)) at = t + DAY_MS;
	}
	if (!at) return "";
	return weekdayIn(at, tz);
}

function weekdayIn(at: number, tz: string): string {
	try {
		return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(at);
	} catch {
		return new Date(at).toLocaleDateString("en-US", { weekday: "short" });
	}
}

/** A time as "Mon 6:00" in the job's time zone. */
export function whenIn(at: number, tz: string): string {
	try {
		// h23 pads the hour ("06:00"); the page writes "6:00", so the hour is taken as a number.
		const parts = new Intl.DateTimeFormat("en-US", {
			hour: "numeric",
			minute: "2-digit",
			hourCycle: "h23",
			timeZone: tz,
		}).formatToParts(at);
		const hour = Number(parts.find((p) => p.type === "hour")?.value);
		const minute = parts.find((p) => p.type === "minute")?.value;
		if (!Number.isFinite(hour) || !minute) throw new Error("no time");
		return `${weekdayIn(at, tz)} ${hour % 24}:${minute}`;
	} catch {
		const d = new Date(at);
		return `${weekdayIn(at, tz)} ${d.getHours()}:${pad2(d.getMinutes())}`;
	}
}

/** A report's opening for a card, as plain text: its Goal part ("Goal"; before 2026-10-06 "Goal or
 *  hypothesis"), else its first part or the reply as it is; Markdown marks dropped, one paragraph. */
export function reportLead(report: UiRoleReport): string {
	const goal = report.sections?.find((s) => s.heading.toLowerCase().startsWith("goal"));
	const text = goal?.text ?? report.sections?.[0]?.text ?? report.text ?? "";
	return stripMarkdown(text).replace(/\s+/g, " ").trim();
}

/** Why there is no report, in a few words (null: there is one). */
export function reportReason(t: Translate, report: UiRoleReport, tz: string): string | null {
	switch (report.state) {
		case "report":
			return null;
		case "first":
			return report.next ? t("rolesReportFirst", { when: whenIn(report.next, tz) }) : t("rolesReportFirstSoon");
		case "not-active":
			return t("rolesReportNotActive");
		case "not-in-job":
			return t("rolesReportNotInJob");
		case "pending":
			return report.askedAt
				? t("rolesReportPending", { when: whenIn(report.askedAt, tz) })
				: t("rolesReportPendingSoon");
		case "failed":
			return report.error ? t("rolesReportFailedWhy", { why: report.error }) : t("rolesReportFailed");
		case "no-answer":
			return t("rolesReportNoAnswer");
		default:
			return report.error ? t("rolesReportUnavailableWhy", { why: report.error }) : t("rolesReportUnavailable");
	}
}

/** The roles the "6 am reports" view lists: every role the job asks (with its report or why not). */
export function reportRoles(roles: readonly UiRoleOverview[]): UiRoleOverview[] {
	return roles.filter((r) => r.report.state !== "not-in-job");
}

/** What couldn't be read for a role, by part. */
export function hasProblem(role: UiRoleOverview, part: "queue" | "tldr" | "report" | "home chat"): boolean {
	return role.problems?.includes(part) ?? false;
}

/** `?chat=<file>` (and `&focus=`), the link the page's targets carry (a new tab opens it the same way). */
export function chatHref(file: string, focus?: string): string {
	const q = new URLSearchParams({ chat: file });
	if (focus) q.set("focus", focus);
	return `?${q.toString()}`;
}

// ---------------------------------------------------------------------------
// Whether the strip is open, kept on this device (phone and desktop each their own)
// ---------------------------------------------------------------------------

type ReadStore = Pick<Storage, "getItem">;
type WriteStore = Pick<Storage, "setItem" | "removeItem">;

export function stripKey(layout: RolesLayout): string {
	return `pi-web-ui:roles:strip:${layout}`;
}

/** The strip's fold: open by default on the desktop, folded on the phone. */
export function readStripOpen(layout: RolesLayout, storage: ReadStore | null = safeStorage()): boolean {
	try {
		const raw = storage?.getItem(stripKey(layout));
		if (raw === "open") return true;
		if (raw === "closed") return false;
	} catch {
		/* the default below */
	}
	return layout === "desktop";
}

export function saveStripOpen(layout: RolesLayout, open: boolean, storage: WriteStore | null = safeStorage()): void {
	try {
		storage?.setItem(stripKey(layout), open ? "open" : "closed");
	} catch {
		/* not remembered */
	}
}

function safeStorage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}
