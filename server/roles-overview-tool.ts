// ---------------------------------------------------------------------------
// roles-overview-tool.ts — roles_overview: every role's state in one call (telegram-coo)
// ---------------------------------------------------------------------------
// The Roles page's snapshot (roles-overview.ts) as plain text for a chat, e.g. the COO's: each role's
// title, home chat, status, last activity, newest TL;DR lines, what waits on the owner, its queue,
// open requests to it and its latest 6 am report. Read-only: nothing is loaded or written.
// All roles come in short (a few lines each); `role` gives one role in full.
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
	UiRoleAsk,
	UiRoleChatRef,
	UiRoleOverview,
	UiRoleReport,
	UiRolesOverview,
	UiRoleStatus,
	UiRoleTask,
} from "./protocol.js";
import { ROLES_OVERVIEW_TOOL_NAME } from "./tool-manager.js";
import { audienceOf, BOARD_FIRST_NEWS_DAYS } from "./role-board.js";

export { ROLES_OVERVIEW_TOOL_NAME };

/** Implemented by AgentService (its readRolesOverview). */
export interface RolesOverviewToolHost {
	read(): Promise<UiRolesOverview>;
}

/** The whole answer's cap (characters). */
export const ROLES_OVERVIEW_TEXT_MAX = 24_000;

/** How much of each part a role shows: all roles in short, or one role in full. */
const SHORT = { tldr: 3, asks: 3, tasks: 5, queued: 0, sectionMax: 300, lineMax: 200 };
const FULL = { tldr: 20, asks: 20, tasks: 20, queued: 20, sectionMax: 3_000, lineMax: 600 };
type Limits = typeof SHORT;

const STATUS_WORDS: Record<UiRoleStatus, string> = {
	"needs-you": "needs the owner",
	busy: "working",
	paused: "paused",
	idle: "idle",
	"nothing-yet": "nothing yet",
};

const clip = (s: unknown, max: number): string => {
	const t = String(s ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
};

/** A moment in the report job's time zone ("2026-10-06 07:10"), with how long ago. */
export function whenText(ms: number | undefined, tz: string, now: number): string {
	if (!ms || !Number.isFinite(ms)) return "unknown";
	let stamp: string;
	try {
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone: tz || undefined,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		}).formatToParts(new Date(ms));
		const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
		stamp = `${p("year")}-${p("month")}-${p("day")} ${p("hour")}:${p("minute")}`;
	} catch {
		stamp = new Date(ms).toISOString().slice(0, 16).replace("T", " ");
	}
	const mins = Math.round((now - ms) / 60_000);
	const ago =
		mins < 1
			? "just now"
			: mins < 60
				? `${mins} min ago`
				: mins < 48 * 60
					? `${Math.round(mins / 60)} h ago`
					: `${Math.round(mins / 1440)} days ago`;
	return `${stamp} (${ago})`;
}

const whereText = (c: UiRoleChatRef | undefined): string =>
	!c ? "" : c.where === "home" ? "home chat" : `task #${c.where}`;

/** queue-paused: "Paused by you (since <when>: <why>)". */
const pausedText = (h: { at: number; why: string }, tz: string, now: number): string =>
	`Paused by you (since ${whenText(h.at, tz, now)}: ${clip(h.why, 160)})`;

function taskLine(t: UiRoleTask, tz: string, now: number, lim: Limits): string {
	const bits = [`#${t.id} ${t.status}${t.busy ? " (working now)" : ""}: ${clip(t.title, 120)}`];
	// queue-paused: the owner paused it (or its whole queue): it doesn't need him while paused.
	if (t.paused) bits.push(pausedText(t.paused, tz, now));
	if (t.waitsOn) bits.push(`waits on: ${clip(t.waitsOn, 160)}`);
	if (t.latest) bits.push(`latest: ${clip(t.latest.text, lim.lineMax)}`);
	return `- ${bits.join("; ")}`;
}

function askLine(a: UiRoleAsk, tz: string, now: number, lim: Limits): string {
	const since = a.since ? `, since ${whenText(a.since, tz, now)}` : "";
	return `- ${a.kind} in ${whereText(a.chat)}${since}: ${clip(a.text, lim.lineMax)}`;
}

function reportLines(r: UiRoleReport, tz: string, now: number, lim: Limits): string[] {
	const day = r.date ? ` (${r.date})` : "";
	switch (r.state) {
		case "report": {
			const out = [`6 am report${day}:`];
			if (r.sections?.length) for (const s of r.sections) out.push(`  ${s.heading}: ${clip(s.text, lim.sectionMax)}`);
			else if (r.text) out.push(`  ${clip(r.text, lim.sectionMax * 4)}`);
			if (r.cut) out.push("  (the report was cut)");
			return out;
		}
		case "pending":
			return [`6 am report${day}: asked${r.askedAt ? ` at ${whenText(r.askedAt, tz, now)}` : ""}, no answer yet`];
		case "failed":
			return [`6 am report${day}: failed${r.error ? `: ${clip(r.error, 160)}` : ""}`];
		case "no-answer":
			return [`6 am report${day}: no answer`];
		case "unavailable":
			return [`6 am report: unavailable${r.error ? ` (${clip(r.error, 160)})` : ""}`];
		case "first":
			return [`6 am report: none yet${r.next ? `; first one ${whenText(r.next, tz, now)}` : ""}`];
		case "not-active":
			return ["6 am report: not asked (no activity that day)"];
		case "not-in-job":
			return ["6 am report: not in the 6 am job"];
		default:
			return [];
	}
}

/** One role's lines. */
export function roleText(r: UiRoleOverview, tz: string, now: number, lim: Limits): string {
	const out = [
		`## ${r.id} (${clip(r.title, 80)}): ${STATUS_WORDS[r.status] ?? r.status}${r.homeBusy ? ", home chat working now" : ""}`,
	];
	out.push(
		r.homeChat
			? `Home chat: ${r.homeChat.file}${r.homeChat.title ? ` ("${clip(r.homeChat.title, 80)}")` : ""}`
			: "Home chat: none",
	);
	if (r.lastActivity) out.push(`Last activity: ${whenText(r.lastActivity, tz, now)}`);
	if (r.tldr.length) {
		out.push("TL;DR, newest first:");
		for (const l of r.tldr.slice(0, lim.tldr)) {
			const marks = [
				l.needsYou && !l.answered ? "needs the owner" : "",
				l.chat.where === "home" ? "" : whereText(l.chat),
			]
				.filter(Boolean)
				.join(", ");
			out.push(`- ${whenText(l.ts, tz, now)}: ${clip(l.text, lim.lineMax)}${marks ? ` [${marks}]` : ""}`);
		}
		if (r.tldr.length > lim.tldr) out.push(`- (${r.tldr.length - lim.tldr} older lines not shown)`);
	}
	if (r.asks.length) {
		out.push(`Waiting on the owner (${r.asks.length}):`);
		for (const a of r.asks.slice(0, lim.asks)) out.push(askLine(a, tz, now, lim));
		if (r.asks.length > lim.asks) out.push(`- (${r.asks.length - lim.asks} more)`);
	}
	if (r.queue) {
		const q = r.queue;
		const state = q.running ? "running" : `stopped${q.pausedReason ? ` (${clip(q.pausedReason, 100)})` : ""}`;
		// queue-paused: the owner paused the whole queue.
		const held = q.hold ? `, the whole queue ${pausedText(q.hold, tz, now).replace(/^P/, "p")}` : "";
		out.push(
			`Queue: ${state}${held}; ${q.counts.active} active, ${q.counts.queued} waiting to start, ${q.counts.done} done`,
		);
		for (const t of q.active.slice(0, lim.tasks)) out.push(taskLine(t, tz, now, lim));
		if (q.active.length > lim.tasks) out.push(`- (${q.active.length - lim.tasks} more active)`);
		for (const t of q.queued.slice(0, lim.queued)) out.push(taskLine(t, tz, now, lim));
	}
	if (r.requests.open) {
		const n = r.requests.newest;
		out.push(
			`Open requests to it: ${r.requests.open}${
				n ? ` (newest: ${n.kind} from ${n.from}, ${whenText(n.at, tz, now)}: ${clip(n.firstLine, 160)})` : ""
			}`,
		);
	}
	if (r.boardOrders?.length) {
		out.push(`Board orders it hasn't marked done (${r.boardOrders.length}):`);
		for (const o of r.boardOrders.slice(0, lim.asks)) {
			out.push(
				`- ${o.id} "${clip(o.title, lim.lineMax)}" from ${o.via ? `${o.from} via ${o.via}` : o.from}, ${whenText(o.at, tz, now)}`,
			);
		}
		if (r.boardOrders.length > lim.asks) out.push(`- (${r.boardOrders.length - lim.asks} more)`);
	}
	out.push(...reportLines(r.report, tz, now, lim));
	if (r.problems?.length) out.push(`Couldn't read: ${r.problems.join(", ")}`);
	return out.join("\n");
}

/** Open orders the board summary lists at most. */
const BOARD_SUMMARY_ORDERS = 6;

/** board (task #76): the board in short: its open orders and who hasn't done each, and recent news. */
export function boardSummary(view: UiRolesOverview, tz: string, now: number): string[] {
	const posts = view.board?.posts;
	if (!posts) return [];
	const roleIds = view.roles.map((r) => r.id);
	const orders = posts.filter((p) => p.kind === "order" && !p.closed);
	const newsFrom = now - BOARD_FIRST_NEWS_DAYS * 24 * 3600_000;
	const news = posts.filter((p) => p.kind === "news" && !p.closed && p.at >= newsFrom).length;
	const newsText = news ? `; ${news} news post${news === 1 ? "" : "s"} in the last ${BOARD_FIRST_NEWS_DAYS} days` : "";
	if (!orders.length) return [`Board: no open orders${newsText}.`];
	const out = [`Board: ${orders.length} open order${orders.length === 1 ? "" : "s"}${newsText}.`];
	for (const p of orders.slice(0, BOARD_SUMMARY_ORDERS)) {
		const audience = audienceOf(p, roleIds);
		const notDone = audience.filter((r) => !p.done?.[r]);
		const from = p.via ? `${p.from} via ${p.via}` : p.from;
		out.push(
			`- ${p.id} "${clip(p.title, 100)}" from ${from}, ${whenText(p.at, tz, now)}: done ${audience.length - notDone.length}/${audience.length}${
				notDone.length ? `; not done: ${notDone.join(", ")}` : ""
			}`,
		);
	}
	if (orders.length > BOARD_SUMMARY_ORDERS) out.push(`- (${orders.length - BOARD_SUMMARY_ORDERS} more open orders)`);
	return out;
}

/** The overview as text: all roles in short, or one role in full. Throws for a role that isn't there. */
export function formatRolesOverview(view: UiRolesOverview, opts: { role?: string; now?: number } = {}): string {
	const now = opts.now ?? Date.now();
	const tz = view.reportTz;
	const wanted = String(opts.role ?? "").trim();
	const roles = wanted ? view.roles.filter((r) => r.id === wanted) : view.roles;
	if (wanted && !roles.length)
		throw new Error(
			`There is no role "${clip(wanted, 40)}". Roles: ${view.roles.map((r) => r.id).join(", ") || "none"}.`,
		);
	let lim = wanted ? FULL : SHORT;
	const head = [
		`Roles overview at ${whenText(view.at, tz, now)}, times in ${tz || "the server's time zone"}.`,
		`${view.roles.length} roles; ${view.asks.length} things wait on the owner.${view.paused ? " Role messages are paused by the owner." : ""}`,
	];
	if (!wanted) {
		const counts = new Map<string, number>();
		for (const r of view.roles) counts.set(STATUS_WORDS[r.status], (counts.get(STATUS_WORDS[r.status]) ?? 0) + 1);
		head.push(`By status: ${[...counts].map(([s, n]) => `${n} ${s}`).join(", ")}.`);
		head.push(...boardSummary(view, tz, now));
	}
	let text = head.join("\n");
	let parts = roles.map((r) => `\n\n${roleText(r, tz, now, lim)}`);
	// Keep all the usual role cards in one call, even on a busy day. Shorten their details
	// together before the hard cap, rather than dropping the roles at the end of the list.
	for (let n = 0; !wanted && n < 4 && text.length + parts.join("").length > ROLES_OVERVIEW_TEXT_MAX - 200; n++) {
		lim = {
			...lim,
			tldr: Math.max(1, lim.tldr - 1),
			asks: Math.max(1, lim.asks - 1),
			tasks: Math.max(1, lim.tasks - 1),
			lineMax: Math.max(40, Math.floor(lim.lineMax / 2)),
			sectionMax: Math.max(40, Math.floor(lim.sectionMax / 2)),
		};
		parts = roles.map((r) => `\n\n${roleText(r, tz, now, lim)}`);
	}
	for (const part of parts) {
		if (text.length + part.length > ROLES_OVERVIEW_TEXT_MAX - 200) {
			text += `\n\n(Cut here to stay short: ask for one role with role "<id>" to see the rest.)`;
			break;
		}
		text += part;
	}
	if (!wanted) text += `\n\n(For one role in full, call ${ROLES_OVERVIEW_TOOL_NAME} with role "<id>".)`;
	return text;
}

export function makeRolesOverviewTool(host: RolesOverviewToolHost): ToolDefinition {
	return defineTool({
		name: ROLES_OVERVIEW_TOOL_NAME,
		label: "Roles overview",
		description:
			"Every role's state in one call, as the Roles page shows it: status, home chat, last activity, newest TL;DR lines, what waits on the owner, its queue (active tasks and counts), open requests to it, the board orders it hasn't marked done and its latest 6 am report; with all roles, the board's open orders and who hasn't done each. " +
			"Read-only. Without role: all roles in short. With role (an id): that role in full.",
		promptSnippet: "every role's state at once (status, TL;DR, asks, queue, 6 am report); role: one role in full",
		parameters: Type.Object({
			role: Type.Optional(
				Type.String({ description: "A role id, for that role alone in full. Leave it out for all roles in short." }),
			),
		}),
		execute: async (_id, p, _signal, _onUpdate, _ctx) => {
			const view = await host.read();
			const text = formatRolesOverview(view, p.role ? { role: p.role } : {});
			return {
				content: [{ type: "text", text }],
				details: { roles: view.roles.length, role: p.role ?? null, chars: text.length },
			};
		},
	});
}
