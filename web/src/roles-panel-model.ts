/**
 * roles-panel (owner, 2026-10-16): one role's panel on the Roles page, as a closed projection of the same
 * snapshot the cards use (roles-useful-model.ts), with the same checks: agent-written text is bounded plain
 * text or nothing (an unsafe character anywhere drops all of it), ids and times are checked, chat targets
 * stay in memory and only reach the app's existing open path.
 *
 * What it adds to a card: the role's status, focus, work mode and goals; its TL;DR lines; its latest 6 am
 * report; its open requests; the initiatives and projects it leads; and its open tasks grouped by initiative
 * and project, as each task's own queue entry names its parent and the work registry (pi-work-management)
 * names the project's initiative, with a blocked task's lead, what it owes, when it is due and the reminders.
 */
import { requesterText } from "../../server/queue-requester";
import {
	chatFile,
	focusOf,
	idFrequencies,
	marker,
	object,
	plain,
	projectSpend,
	record,
	roleId,
	taskId,
	time,
	UNSAFE,
	type Fields,
	type PauseMarker,
	type RowState,
	type UsefulOpenTarget,
	type UsefulSpend,
} from "./roles-useful-model";

export const LINE_LIMIT = 300;
export const GOAL_LIMIT = 300;
export const FOCUS_LIMIT = 300;
export const REPORT_LIMIT = 12_000;
export const HEADING_LIMIT = 80;
export const WORK_NAME_LIMIT = 80;
/** The panel shows at most this many of a role's open tasks, lines, goals and records. */
export const PANEL_TASKS_MAX = 100;
export const PANEL_LINES_MAX = 20;
export const PANEL_GOALS_MAX = 20;
export const WORK_RECORDS_MAX = 500;
/** pi-work-management's done-when list holds at most this many items. */
const DONE_ITEMS_MAX = 20;
const WORK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_OR_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;

const ROLE_STATUSES = ["needs-you", "busy", "paused", "idle", "nothing-yet"] as const;
const WORK_STATUSES = ["active", "done", "dropped"] as const;
const REPORT_STATES = [
	"report",
	"pending",
	"failed",
	"no-answer",
	"unavailable",
	"first",
	"not-active",
	"not-in-job",
] as const;

export type PanelRoleStatus = (typeof ROLE_STATUSES)[number] | "unknown";
export type WorkStatus = (typeof WORK_STATUSES)[number];
export type ReportState = (typeof REPORT_STATES)[number] | "unknown";
/** How the registry was read: fine, never written yet, or why its records can't all be shown. */
export type WorkSource = "ok" | "none" | "not-sent" | "unreadable" | "too-big" | "unknown-change" | "partial";

/** A lead: a role on the roster (its label), the owner, or a role id the roster doesn't have. */
export type PanelLead = { kind: "role"; id: string; label: string } | { kind: "owner" } | { kind: "other"; id: string };

export interface WorkView {
	id: string;
	/** null: the registry doesn't have it (an old tag, or a record that couldn't be shown). */
	name: string | null;
	lead: PanelLead | null;
	status: WorkStatus | null;
	/** Done-when items, and how many are marked met (null: not known). */
	items: number | null;
	met: number | null;
}
export interface PanelOwing {
	lead: PanelLead | null;
	owes: string | null;
	due: number | null;
	reminders: number | null;
	/** The leads reminded next if that lead stays silent, in order, then the owner; null: not recorded yet. */
	next: PanelLead[] | null;
}
export interface PanelTaskNext {
	kind: "queue" | "check" | "blocked" | "answer" | "resume" | "unrecorded" | "none";
	who: PanelLead | null;
	what: string | null;
	after: string[];
	until: number | null;
	everyMs: number | null;
}
export interface PanelTaskEvent {
	kind: "added" | "started" | "waiting" | "blocked" | "answer" | "paused" | "done" | "dropped";
	at: number | null;
}
export interface PanelTask {
	/** Plain text of recorded proposal inputs; missing stays unknown. */
	requester?: string;
	taskId: number;
	next?: PanelTaskNext;
	queueEvent?: PanelTaskEvent;
	name: string | null;
	state: RowState;
	/** asking-lead: the role whose lead has its question. */
	askLead: string | null;
	waitsOn: string | null;
	owing: PanelOwing | null;
	pause: PauseMarker;
	link: UsefulOpenTarget | null;
	started: boolean;
	/** queue-drop: why its lead dropped it; dropped tasks only. */
	dropped: string | null;
}
export interface ProjectGroup {
	project: WorkView;
	tasks: PanelTask[];
}
export interface InitiativeGroup {
	/** null: projects under no initiative (standalone projects, and projects the registry doesn't have). */
	initiative: WorkView | null;
	projects: ProjectGroup[];
	/** Tasks filed straight under the initiative (no project). */
	tasks: PanelTask[];
}
export interface PanelLine {
	key: string;
	text: string;
	ts: number | null;
	needsYou: boolean;
	answered: boolean;
	blocked: boolean;
	/** "home": its home chat; a number: that task's chat. */
	where: "home" | number | null;
	link: UsefulOpenTarget | null;
}
export interface PanelGoal {
	name: string | null;
	scope: string | null;
	approvedAt: string | null;
	endsAt: string | null;
}
export interface PanelReport {
	state: ReportState;
	date: string | null;
	askedAt: number | null;
	sections: { heading: string; text: string | null }[];
	text: string | null;
	cut: boolean;
	next: number | null;
	/* No error text: it can name a file on the machine (a path, a chat file). Each state has fixed words. */
	link: UsefulOpenTarget | null;
}
export interface RolePanel {
	spend?: UsefulSpend | null;
	roleId: string;
	roleLabel: string;
	status: PanelRoleStatus;
	focus: string | null;
	workMode: "self-start" | "request-only" | null;
	workModeFrom: "owner" | "rules" | null;
	conflict: string | null;
	goals: PanelGoal[];
	goalsOmitted: boolean;
	home: UsefulOpenTarget | null;
	lines: PanelLine[];
	report: PanelReport;
	requests: { open: number | null; newest: { from: string | null; text: string | null; at: number | null } | null };
	/** The initiatives and projects it leads. */
	leads: { initiatives: WorkView[]; projects: WorkView[] };
	groups: InitiativeGroup[];
	/** Deliberately in no project or initiative. */
	standalone: PanelTask[];
	/** Where it belongs isn't recorded. */
	unrecorded: PanelTask[];
	/** The queue couldn't be read, or some tasks couldn't be shown. */
	tasksAvailable: boolean;
	tasksOmitted: boolean;
	/** Waiting tasks beyond what the server sends (it sends at most 20). */
	queuedNotAllShown: boolean;
	done: number | null;
	/** queue-drop: the tasks its lead dropped, newest first (the server sends the newest few), and how many
	 *  its queue lists (null: not reported). */
	dropped: PanelTask[];
	droppedCount: number | null;
	work: WorkSource;
	/** Something of this role couldn't be read (the rest is shown). */
	partial: boolean;
}

type Bounded = { text: string; clipped: boolean };

/** Like plain(), but a report keeps its lines: tabs read as spaces, line breaks stay, anything else unsafe
 *  rejects the whole text. */
export function plainBlock(value: unknown, limit: number): Bounded | null {
	if (typeof value !== "string") return null;
	const text = value.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").trim();
	if (!text || UNSAFE.test(text.replace(/\n/g, " "))) return null;
	const points = Array.from(text.slice(0, limit * 2 + 2));
	if (text.length <= limit * 2 + 2 && points.length <= limit) return { text, clipped: false };
	return { text: points.slice(0, limit - 1).join("") + "…", clipped: true };
}

function oneOf<T extends string>(list: readonly T[], value: unknown): T | null {
	return list.find((x) => x === value) ?? null;
}
function workId(value: unknown): value is string {
	return typeof value === "string" && value.length <= 60 && WORK_ID.test(value);
}
function count(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
}
function day(value: unknown, re: RegExp): string | null {
	return typeof value === "string" && re.test(value) ? value : null;
}

function leadOf(value: unknown, labels: Map<string, string>): PanelLead | null {
	if (value === "owner") return { kind: "owner" };
	if (!roleId(value)) return null;
	const label = labels.get(value);
	return label === undefined ? { kind: "other", id: value } : { kind: "role", id: value, label };
}

interface Registry {
	source: WorkSource;
	initiatives: Map<string, WorkView>;
	projects: Map<string, WorkView & { initiative: string | null }>;
	/** Registry order, for the panel's order. */
	order: string[];
}

function registryOf(overview: Fields | null, labels: Map<string, string>): Registry {
	const reg: Registry = { source: "ok", initiatives: new Map(), projects: new Map(), order: [] };
	if (!overview || overview.work === undefined) {
		reg.source = "not-sent";
		return reg;
	}
	const work = object(overview.work);
	if (!work) {
		reg.source = "unreadable";
		return reg;
	}
	const problem = oneOf(["unreadable", "too-big", "unknown-change"] as const, work.problem);
	if (work.problem !== undefined && !problem) reg.source = "partial";
	if (problem) reg.source = problem;
	let omitted = false;
	let seen = 0;
	const view = (row: Fields): WorkView | null => {
		const items = count(row.items, DONE_ITEMS_MAX);
		const met = count(row.met, DONE_ITEMS_MAX);
		if (!workId(row.id) || items === null || met === null || met > items) return null;
		return {
			id: row.id,
			name: plain(row.name, WORK_NAME_LIMIT)?.text ?? null,
			lead: leadOf(row.lead, labels),
			status: oneOf(WORK_STATUSES, row.status),
			items,
			met,
		};
	};
	const initiatives = Array.isArray(work.initiatives) ? work.initiatives : null;
	const projects = Array.isArray(work.projects) ? work.projects : null;
	if (!initiatives || !projects) omitted = true;
	for (const raw of initiatives ?? []) {
		const row = object(raw);
		const v = row && seen++ < WORK_RECORDS_MAX ? view(row) : null;
		if (!v || reg.initiatives.has(v.id)) {
			omitted = true;
			continue;
		}
		reg.initiatives.set(v.id, v);
		reg.order.push(v.id);
	}
	for (const raw of projects ?? []) {
		const row = object(raw);
		const v = row && seen++ < WORK_RECORDS_MAX ? view(row) : null;
		const initiative =
			row?.initiative === null ? null : workId(row?.initiative) ? (row.initiative as string) : undefined;
		if (!v || initiative === undefined || reg.projects.has(v.id)) {
			omitted = true;
			continue;
		}
		reg.projects.set(v.id, { ...v, initiative });
	}
	if (omitted && reg.source === "ok") reg.source = "partial";
	if (reg.source === "ok" && !reg.initiatives.size && !reg.projects.size) reg.source = "none";
	return reg;
}

/** A task's parent as its queue entry names it (undefined: not recorded or malformed). */
function parentOf(row: Fields): { project: string } | { initiative: string } | { standalone: true } | undefined {
	const p = object(row.parent);
	if (!p) return undefined;
	const keys = Object.keys(p);
	if (keys.length !== 1) return undefined;
	if (workId(p.project)) return { project: p.project };
	if (workId(p.initiative)) return { initiative: p.initiative };
	if (p.standalone === true) return { standalone: true };
	return undefined;
}

function owingOf(row: Fields, labels: Map<string, string>): PanelOwing | null {
	const o = object(row.owing);
	if (!o) return null;
	const next = Array.isArray(o.chain)
		? o.chain
				.slice(0, 4)
				.map((x) => leadOf(x, labels))
				.filter((x): x is PanelLead => x !== null)
		: null;
	return {
		lead: leadOf(o.lead, labels),
		owes: plain(o.owes, LINE_LIMIT)?.text ?? null,
		due: time(o.due),
		reminders: count(o.reminders, 1000),
		next,
	};
}

/** A next-action payload must agree with the task state; it cannot turn a pause into a command. */
function nextOf(
	row: Fields,
	base: ReturnType<typeof record>,
	labels: Map<string, string>,
	department: string,
): PanelTaskNext | undefined {
	if (base.pause === "unknown") return undefined;
	const expected: Partial<Record<RowState, PanelTaskNext["kind"]>> = {
		ready: "queue",
		"ready-after": "queue",
		working: "unrecorded",
		"on-hold": "check",
		blocked: "blocked",
		asking: "answer",
		"asking-main": "answer",
		"asking-ops": "answer",
		"asking-lead": "answer",
		"needs-decision": "answer",
		done: "none",
		dropped: "none",
	};
	const kind = base.pause === "reported-paused" ? "resume" : expected[base.state];
	const raw = object(row.next);
	if (!raw || !kind || raw.kind !== kind) return undefined;
	if (kind === "resume" && raw.who !== "owner") return undefined;
	if (kind === "answer") {
		const expectedWho =
			base.state === "needs-decision"
				? "owner"
				: base.state === "asking-ops"
					? "ops"
					: base.state === "asking-lead"
						? base.askLead
						: base.state === "asking-main"
							? department
							: null;
		if (!expectedWho || raw.who !== expectedWho) return undefined;
	}
	const who = raw.who === undefined ? null : leadOf(raw.who, labels);
	if (raw.who !== undefined && !who) return undefined;
	const what = raw.what === undefined ? null : plain(raw.what, LINE_LIMIT);
	if (raw.what !== undefined && (!what || what.clipped)) return undefined;
	const after: string[] = [];
	if (raw.after !== undefined) {
		if (!Array.isArray(raw.after) || raw.after.length > 40) return undefined;
		for (const value of raw.after) {
			const text = plain(value, LINE_LIMIT);
			if (!text || text.clipped) return undefined;
			after.push(text.text);
		}
	}
	const until = displayTime(raw.until);
	const everyMs = count(raw.everyMs, 3_600_000);
	if ((raw.until !== undefined && until === null) || (raw.everyMs !== undefined && (everyMs === null || everyMs < 1)))
		return undefined;
	return { kind, who, what: what?.text ?? null, after, until, everyMs };
}

function queueEventOf(row: Fields, next: PanelTaskNext | undefined): PanelTaskEvent | undefined {
	if (!next) return undefined;
	const expected: Record<PanelTaskNext["kind"], PanelTaskEvent["kind"][]> = {
		queue: ["added"],
		check: ["waiting"],
		blocked: ["blocked"],
		answer: ["answer"],
		resume: ["paused"],
		unrecorded: ["started"],
		none: ["done", "dropped"],
	};
	const raw = object(row.queueEvent);
	const kind = oneOf(expected[next.kind], raw?.kind);
	if (!raw || !kind) return undefined;
	const at = displayTime(raw.at);
	if (raw.at !== undefined && at === null) return undefined;
	return { kind, at };
}

function displayTime(value: unknown): number | null {
	const at = time(value);
	return at !== null && Number.isSafeInteger(at) && Number.isFinite(new Date(at).getTime()) ? at : null;
}

function unknownWork(id: string): WorkView {
	return { id, name: null, lead: null, status: null, items: null, met: null };
}

function lineOf(raw: unknown, index: number): PanelLine | null {
	const l = object(raw);
	if (!l) return null;
	const text = plain(l.text, LINE_LIMIT);
	if (!text) return null;
	const chat = object(l.chat);
	const file = chatFile(chat?.file);
	const focus = typeof l.id === "string" ? focusOf(`tldr:${l.id}`) : null;
	const where = chat?.where === "home" ? "home" : taskId(chat?.where) ? chat.where : null;
	return {
		key: String(index),
		text: text.text,
		ts: time(l.ts),
		needsYou: l.needsYou === true,
		answered: l.answered === true,
		blocked: l.kind === "blocked",
		where,
		link: file ? (focus ? { file, focus } : { file }) : null,
	};
}

function reportOf(raw: unknown): PanelReport {
	const r = object(raw);
	const state = r ? (oneOf(REPORT_STATES, r.state) ?? "unknown") : "unknown";
	const sections: PanelReport["sections"] = [];
	if (state === "report" && Array.isArray(r?.sections)) {
		for (const s of r.sections.slice(0, 8)) {
			const sec = object(s);
			const heading = plain(sec?.heading, HEADING_LIMIT);
			if (!heading) continue;
			sections.push({ heading: heading.text, text: plainBlock(sec?.text, REPORT_LIMIT)?.text ?? null });
		}
	}
	const file = state === "report" ? chatFile(object(r?.chat)?.file) : null;
	const jumpAt = time(r?.messageAt);
	return {
		state,
		date: day(r?.date, DAY),
		askedAt: time(r?.askedAt),
		sections,
		text: state === "report" && !sections.length ? (plainBlock(r?.text, REPORT_LIMIT)?.text ?? null) : null,
		cut: r?.cut === true,
		next: time(r?.next),
		link: file ? { file, ...(jumpAt !== null ? { jumpAt } : {}) } : null,
	};
}

/** One role's panel from the received snapshot, or null when that role isn't in it (once). */
export function projectRolePanel(state: unknown, id: string): RolePanel | null {
	const input = object(state);
	const overview = object(input?.overview);
	const rows = Array.isArray(overview?.roles) ? overview.roles : [];
	const seen = idFrequencies(rows, (raw) => {
		const candidate = object(raw)?.id;
		return roleId(candidate) ? candidate : null;
	});
	const labels = new Map<string, string>();
	for (const raw of rows) {
		const row = object(raw);
		if (!row || !roleId(row.id) || seen.get(row.id) !== 1) continue;
		labels.set(row.id, plain(row.title, 120)?.text ?? row.id);
	}
	if (!roleId(id) || seen.get(id) !== 1) return null;
	const row = rows.map(object).find((r) => r?.id === id);
	if (!row) return null;
	const reg = registryOf(overview, labels);
	const home = chatFile(object(row.homeChat)?.file);

	// Its open tasks, each once.
	const queue = object(row.queue);
	const active = Array.isArray(queue?.active) ? queue.active : null;
	const queued = Array.isArray(queue?.queued) ? queue.queued : null;
	const taskRows: unknown[] = [...(active ?? []), ...(queued ?? [])];
	// queue-drop: dropped tasks are listed apart; an id seen in two lists is shown in neither.
	const droppedRows: unknown[] = Array.isArray(queue?.dropped) ? queue.dropped : [];
	const ids = idFrequencies([...taskRows, ...droppedRows], (raw) => {
		const candidate = object(raw)?.id;
		return taskId(candidate) ? candidate : null;
	});
	let tasksOmitted = false;
	const groups = new Map<string | null, InitiativeGroup>();
	const groupOf = (initiative: string | null): InitiativeGroup => {
		let g = groups.get(initiative);
		if (!g) {
			g = {
				initiative: initiative === null ? null : (reg.initiatives.get(initiative) ?? unknownWork(initiative)),
				projects: [],
				tasks: [],
			};
			groups.set(initiative, g);
		}
		return g;
	};
	const standalone: PanelTask[] = [];
	const unrecorded: PanelTask[] = [];
	let shown = 0;
	for (const raw of taskRows) {
		const t = object(raw);
		if (!t || !taskId(t.id) || ids.get(t.id) !== 1 || shown >= PANEL_TASKS_MAX) {
			tasksOmitted = true;
			continue;
		}
		shown++;
		const base = record(t, t.id, home);
		const next = nextOf(t, base, labels, id);
		const queueEvent = queueEventOf(t, next);
		const requester = requesterText(t.requester, (role) => labels.get(role) ?? role);
		const task: PanelTask = {
			taskId: base.taskId,
			...(requester ? { requester } : {}),
			...(next ? { next } : {}),
			...(queueEvent ? { queueEvent } : {}),
			name: base.name,
			state: base.state,
			askLead: base.askLead,
			waitsOn: base.waitsOn,
			owing: base.state === "blocked" ? owingOf(t, labels) : null,
			pause: base.pause,
			link: base.link,
			started: t.chat !== undefined,
			dropped: null,
		};
		const parent = parentOf(t);
		if (!parent) {
			if (t.parent !== undefined) tasksOmitted = true;
			unrecorded.push(task);
		} else if ("standalone" in parent) standalone.push(task);
		else if ("initiative" in parent) groupOf(parent.initiative).tasks.push(task);
		else {
			const project = reg.projects.get(parent.project);
			const g = groupOf(project ? project.initiative : null);
			let pg = g.projects.find((p) => p.project.id === parent.project);
			if (!pg) {
				pg = { project: project ?? unknownWork(parent.project), tasks: [] };
				g.projects.push(pg);
			}
			pg.tasks.push(task);
		}
	}
	const dropped: PanelTask[] = [];
	for (const raw of droppedRows) {
		const t = object(raw);
		if (!t || !taskId(t.id) || ids.get(t.id) !== 1 || dropped.length >= PANEL_TASKS_MAX) {
			tasksOmitted = true;
			continue;
		}
		const base = record(t, t.id, home);
		dropped.push({
			taskId: base.taskId,
			name: base.name,
			state: base.state,
			askLead: null,
			waitsOn: null,
			owing: null,
			pause: "not-reported",
			link: base.link,
			started: t.chat !== undefined,
			dropped: base.dropped,
		});
	}
	// Registry order first, then initiatives it doesn't have (by id), then the projects under none.
	const known = reg.order.filter((i) => groups.has(i)).map((i) => groups.get(i) as InitiativeGroup);
	const unknown = [...groups.keys()]
		.filter((k): k is string => k !== null && !reg.initiatives.has(k))
		.sort()
		.map((k) => groups.get(k) as InitiativeGroup);
	const none = groups.get(null);

	const goalsRaw = Array.isArray(row.goals) ? row.goals : [];
	const goals: PanelGoal[] = goalsRaw.slice(0, PANEL_GOALS_MAX).map((raw) => {
		const g = object(raw);
		return {
			name: plain(g?.name, 160)?.text ?? null,
			scope: plain(g?.scope, GOAL_LIMIT)?.text ?? null,
			approvedAt: day(g?.approvedAt, DAY_OR_TIME),
			endsAt: day(g?.endsAt, DAY_OR_TIME),
		};
	});

	const lines: PanelLine[] = [];
	if (Array.isArray(row.tldr)) {
		row.tldr.slice(0, PANEL_LINES_MAX).forEach((raw, i) => {
			const l = lineOf(raw, i);
			if (l) lines.push(l);
		});
	}

	const requests = object(row.requests);
	const newest = object(requests?.newest);

	const leads = {
		initiatives: [...reg.initiatives.values()].filter((w) => w.lead?.kind === "role" && w.lead.id === id),
		projects: [...reg.projects.values()]
			.filter((w) => w.lead?.kind === "role" && w.lead.id === id)
			.map(({ initiative: _initiative, ...w }) => w),
	};

	const counts = object(queue?.counts);
	const queuedCount = count(counts?.queued);
	return {
		roleId: id,
		roleLabel: labels.get(id) ?? id,
		spend: projectSpend(row.spend),
		status: oneOf(ROLE_STATUSES, row.status) ?? "unknown",
		focus: plain(row.focus, FOCUS_LIMIT)?.text ?? null,
		workMode: oneOf(["self-start", "request-only"] as const, row.workMode),
		workModeFrom: oneOf(["owner", "rules"] as const, row.workModeFrom),
		conflict: plain(row.conflict, LINE_LIMIT)?.text ?? null,
		goals,
		goalsOmitted: goalsRaw.length > goals.length || (row.goals !== undefined && !Array.isArray(row.goals)),
		home: home ? { file: home } : null,
		lines,
		report: reportOf(row.report),
		requests: {
			open: count(requests?.open),
			newest: newest
				? {
						from: roleId(newest.from) ? (labels.get(newest.from) ?? newest.from) : null,
						text: plain(newest.firstLine, LINE_LIMIT)?.text ?? null,
						at: time(newest.at),
					}
				: null,
		},
		leads,
		groups: [...known, ...unknown, ...(none ? [none] : [])],
		standalone,
		unrecorded,
		tasksAvailable: row.queue === undefined || (queue !== null && active !== null && queued !== null),
		tasksOmitted,
		queuedNotAllShown: queuedCount !== null && queued !== null && queuedCount > queued.length,
		done: count(counts?.done),
		dropped,
		droppedCount: count(counts?.dropped),
		work: reg.source,
		partial: Array.isArray(row.problems) ? row.problems.length > 0 : row.problems !== undefined,
	};
}

/** Whether a task's owing lead is this one (the reminder chain's places, for the view's words). */
export function sameLead(a: PanelLead | null, b: PanelLead | null): boolean {
	if (!a || !b) return false;
	if (a.kind === "owner" || b.kind === "owner") return a.kind === b.kind;
	return a.id === b.id;
}

export type { PauseMarker, RowState, UsefulOpenTarget } from "./roles-useful-model";
export { marker };
