// initiatives-page-tasks (Ops #227, docs/initiatives-page-tasks.md): step 3's module. Under each project row, its
// open tasks: "#N title", the department, the status, the next step or what it waits on, and when it last
// changed; a click opens the task's own chat, or its queue's chat while that isn't known. Tasks linked straight
// to an initiative get a row of their own, "Directly under this initiative". What waits on the owner (the linked
// tasks' needsYou) fills Waiting on you and the ON YOU bar, which never says nothing waits unless the registry
// was read whole and is live. statusOf works out each initiative's and project's status from its open tasks by
// fixed rules (ruleOf), for the chips and the filter counts. Read-only: a click only opens a chat.
import type {
	InitiativesExactAsk,
	InitiativesExactInitiative,
	InitiativesExactRole,
	InitiativesExactStatus,
} from "../initiatives-exact-model";
import { roleName } from "../initiatives-view-model";
import { ageOf, clockOf } from "../roles-view-model";
import type { UiWorkPage, UiWorkPageRecord, UiWorkPageTask } from "../types";
import { looseProjects } from "./model";
import { NO_INITIATIVE, projectFrameId, type InitiativesPageOpen, type InitiativesPagePart } from "./types";

/** The chip's words for a status (the view's own labels). */
const WORD: Record<InitiativesExactStatus, string> = {
	you: "Needs you",
	attention: "Needs attention",
	paused: "Paused by you",
	moving: "Moving",
	unknown: "Unknown",
};
const ENDED: Record<string, string> = { done: "Done", dropped: "Dropped" };
const MOVING = new Set<UiWorkPageTask["state"]>(["ready", "working", "asking", "waiting"]);

/** Open: not done, dropped or removed. A task whose state isn't recorded yet counts as open. */
export const isOpen = (t: UiWorkPageTask): boolean =>
	t.state !== "done" && t.state !== "dropped" && t.state !== "removed";

/**
 * A record's status from its linked tasks, by the fixed rules in this order: 1 a done or dropped record keeps
 * its registry status; 2 an open task waits on the owner: Needs you; 3 one is stuck or blocked: Needs
 * attention; 4 the owner paused every open one: Paused by you; 5 one is ready, working, asking or waiting:
 * Moving; open tasks whose state isn't recorded: Unknown; 6 none open: a grey "No tasks yet" ("No open tasks"
 * once every task ended).
 */
export function ruleOf(
	record: UiWorkPageRecord["status"],
	tasks: readonly UiWorkPageTask[],
): { status?: InitiativesExactStatus; label: string } {
	const ended = ENDED[record];
	if (ended) return { label: ended };
	const open = tasks.filter(isOpen);
	const status: InitiativesExactStatus | undefined = open.some((t) => t.needsYou)
		? "you"
		: open.some((t) => t.state === "stuck" || t.state === "blocked")
			? "attention"
			: open.length && open.every((t) => t.paused)
				? "paused"
				: open.some((t) => MOVING.has(t.state))
					? "moving"
					: open.length
						? "unknown"
						: undefined;
	return status ? { status, label: WORD[status] } : { label: tasks.length ? "No open tasks" : "No tasks yet" };
}

/** The page's tasks by what they are linked to; tasks of no project or initiative on the page don't show. */
interface Links {
	project: Map<string, UiWorkPageTask[]>;
	/** Linked straight to an initiative. */
	direct: Map<string, UiWorkPageTask[]>;
}
const LINKS = new WeakMap<UiWorkPage, Links>();

function linksOf(page: UiWorkPage): Links {
	const known = LINKS.get(page);
	if (known) return known;
	const links: Links = { project: new Map(), direct: new Map() };
	const add = (map: Map<string, UiWorkPageTask[]>, id: string, t: UiWorkPageTask) => {
		const list = map.get(id);
		if (list) list.push(t);
		else map.set(id, [t]);
	};
	for (const t of page.tasks) {
		if ("project" in t.parent) add(links.project, t.parent.project, t);
		else if ("initiative" in t.parent) add(links.direct, t.parent.initiative, t);
	}
	LINKS.set(page, links);
	return links;
}

/** An initiative's projects (NO_INITIATIVE: the projects in no initiative). */
const projectsOf = (page: UiWorkPage, id: string): UiWorkPageRecord[] =>
	id === NO_INITIATIVE ? looseProjects(page) : page.projects.filter((p) => p.initiative === id);

/** An initiative's tasks: linked straight to it or to one of its projects. */
function scopeOf(page: UiWorkPage, id: string): UiWorkPageTask[] {
	const links = linksOf(page);
	const direct = id === NO_INITIATIVE ? [] : (links.direct.get(id) ?? []);
	return [...direct, ...projectsOf(page, id).flatMap((p) => links.project.get(p.id) ?? [])];
}

/** An initiative's status for its chip and the filters (NO_INITIATIVE: the projects in no initiative's).
 *  Nothing for a done or dropped one, or one with no open task: its chip shows a word in grey. */
export function statusOf(page: UiWorkPage, id: string): InitiativesExactStatus | undefined {
	const record = page.initiatives.find((i) => i.id === id);
	if (!record && id !== NO_INITIATIVE) return undefined;
	return ruleOf(record?.status ?? "active", scopeOf(page, id)).status;
}

/** When a task last changed, as far as the registry and its queue say. */
const changedAt = (t: UiWorkPageTask): number =>
	Math.max(t.added, t.stateAt ?? 0, t.paused?.at ?? 0, t.needsYou?.since ?? 0, t.block?.since ?? 0);

/** Row order: waits on you, stuck or blocked, working or asking, waiting, queued, paused, state unknown. */
function rank(t: UiWorkPageTask): number {
	if (t.needsYou) return 0;
	if (t.paused) return 5;
	switch (t.state) {
		case "stuck":
		case "blocked":
			return 1;
		case "working":
		case "asking":
			return 2;
		case "waiting":
			return 3;
		case "ready":
			return 4;
		default:
			return 6;
	}
}
const byUrgency = (a: UiWorkPageTask, b: UiWorkPageTask) =>
	rank(a) - rank(b) || changedAt(b) - changedAt(a) || a.task - b.task;

/** The queue's next step for a task, in the Roles page's words. Nothing when it isn't recorded. */
function nextText(t: UiWorkPageTask, now: number): string | undefined {
	const n = t.nextAction;
	if (!n) return undefined;
	const actor = n.who === "owner" ? "you" : n.who ? roleName(n.who) : undefined;
	const after = n.after ?? [];
	switch (n.kind) {
		case "queue":
			return after.length ? `Waiting for tasks: ${after.join(", ")}` : "Queued; starts when the queue can run it";
		case "check":
			return (
				(n.what ? `Recorded wait: ${n.what}` : "Waiting for its recorded check") +
				(n.everyMs ? ` · checked every ${Math.round(n.everyMs / 60_000)} min` : "") +
				(n.until ? ` · until ${clockOf(n.until, now)}` : "")
			);
		case "blocked":
			return (
				(actor ? `Waiting for ${actor}` : "Waiting on a recorded blocker") +
				(n.what ? ` \u2014 ${n.what}` : "") +
				(after.length ? ` · tasks ${after.join(", ")}` : "") +
				(n.until ? ` · checkpoint ${clockOf(n.until, now)}` : "")
			);
		case "answer":
			return actor === "you" ? "Awaiting your answer" : `Awaiting ${actor ?? "the recorded lead"} to answer`;
		case "resume":
			return "Paused by you; awaits your resume";
		default:
			return undefined;
	}
}

/** What a blocked task waits on: the tasks, the need, and which lead owes what by when. */
function blockText(t: UiWorkPageTask, now: number): string | undefined {
	const b = t.block;
	if (!b) return undefined;
	const owed = b.lead
		? roleName(b.lead) + (b.owes ? " owes " + b.owes : "") + (b.due ? ` (due ${clockOf(b.due, now)})` : "")
		: b.owes;
	const parts = [b.on?.length ? b.on.join(", ") : undefined, b.need, owed].filter((s): s is string => !!s);
	return parts.length ? parts.join(" · ") : undefined;
}

/** A task row's chip and its next step or what it waits on. */
function lookOf(t: UiWorkPageTask, now: number): InitiativesExactRole {
	if (t.needsYou) return { statusLabel: WORD.you, statusTone: "you", note: "Awaiting your answer" };
	if (t.paused) return { kind: "paused", note: "Paused by you; awaits your resume" };
	switch (t.state) {
		case "stuck":
			return { kind: "blocked", note: "Waiting on you, but its question isn\u2019t listed: open its chat" };
		case "blocked": {
			const wait = blockText(t, now);
			if (wait) return { kind: "blocked", wait };
			return { kind: "blocked", note: nextText(t, now) ?? "Blocked; what it waits on isn\u2019t recorded" };
		}
		case "asking":
			return { kind: "waiting", note: nextText(t, now) ?? "Asking its lead a question" };
		case "waiting":
			return { kind: "waiting", note: nextText(t, now) ?? "Waiting for its recorded check" };
		case "working":
			return { kind: "working", note: nextText(t, now) };
		case "ready":
			return { kind: "queued", note: nextText(t, now) ?? "Queued; starts when the queue can run it" };
		default:
			return { kind: "unknown", note: "Its queue hasn\u2019t recorded a state for it yet" };
	}
}

/** The chat a task's click opens: its own, else its queue's. */
const opener = (t: UiWorkPageTask, open: InitiativesPageOpen): (() => void) | undefined => {
	const file = t.chat || t.queue;
	return file ? () => open(file) : undefined;
};

function taskRow(t: UiWorkPageTask, now: number, open: InitiativesPageOpen): InitiativesExactRole {
	return {
		name: roleName(t.queueName),
		task: "#" + t.task,
		taskTitle: t.title,
		...lookOf(t, now),
		at: clockOf(changedAt(t), now),
		open: opener(t, open),
	};
}

const openCount = (n: number) => (n === 1 ? "1 open task" : `${n} open tasks`);

/** A row's chip by the rules, and its open tasks as child rows. */
function rowFields(
	record: UiWorkPageRecord["status"],
	tasks: readonly UiWorkPageTask[],
	now: number,
	open: InitiativesPageOpen,
): InitiativesExactRole {
	const rule = ruleOf(record, tasks);
	const live = tasks.filter(isOpen).sort(byUrgency);
	return {
		statusLabel: rule.label,
		statusTone: rule.status ?? "neutral",
		...(live.length ? { tasks: live.map((t) => taskRow(t, now, open)) } : {}),
	};
}

/** What waits on the owner among these tasks, the longest-waiting first. */
function asksOf(tasks: readonly UiWorkPageTask[], now: number, open: InitiativesPageOpen): InitiativesExactAsk[] {
	const out: { since: number; ask: InitiativesExactAsk }[] = [];
	for (const t of tasks) {
		if (!t.needsYou || !isOpen(t)) continue;
		const since = t.needsYou.since ?? t.stateAt ?? t.added;
		out.push({
			since,
			ask: {
				id: `${t.queue}#${t.task}`,
				kind: "Question",
				from: roleName(t.queueName),
				age: ageOf(since, now),
				title: t.needsYou.text,
				context: `#${t.task} ${t.title}`,
				open: opener(t, open),
			},
		});
	}
	return out.sort((a, b) => a.since - b.since).map((x) => x.ask);
}

/** The owner paused every open task here: which ones. */
function pausedText(tasks: readonly UiWorkPageTask[]): string {
	const names = tasks.filter(isOpen).map((t) => `${roleName(t.queueName)} #${t.task}`);
	return `You paused every open task here: ${names.join(", ")}.`;
}

/** The ON YOU bar: how many things wait on the owner, said only as far as it is known. */
function summaryOf(page: UiWorkPage, n: number, stale: boolean): InitiativesPagePart["page"] {
	const things = n === 1 ? "1 thing is" : `${n} things are`;
	if (page.problem === "too-big" || page.problem === "unknown-change")
		return {
			summary: n
				? `At least ${things} waiting on you; the registry couldn\u2019t be read whole, so there may be more.`
				: "What\u2019s waiting on you isn\u2019t fully known: the registry couldn\u2019t be read whole.",
			filtersNote: "Not fully known: the registry couldn\u2019t be read whole.",
		};
	if (n) return { summary: `${things} waiting on you across initiatives.` };
	// The view says "As of <time>: " first while the page is out of date.
	if (stale) return { summary: "Nothing was waiting on you then; that may have changed since." };
	return {};
}

export interface TasksPartOptions {
	/** The clock "updated" times and waiting ages count from; absent: the page's own time. */
	now?: number;
	/** The page couldn't refresh: what it shows is as of its last update. */
	stale?: boolean;
}

export function tasksPart(
	page: UiWorkPage,
	_selected: string | undefined,
	open: InitiativesPageOpen,
	opts: TasksPartOptions = {},
): InitiativesPagePart {
	const now = opts.now ?? page.at;
	const links = linksOf(page);
	const projects: Record<string, InitiativesExactRole> = {};
	for (const p of page.projects) {
		const tasks = links.project.get(p.id) ?? [];
		const fields = rowFields(p.status, tasks, now, open);
		const live = fields.tasks?.length ?? 0;
		projects[p.id] = { ...fields, ...(live ? { note: openCount(live) } : {}) };
	}

	const initiatives: Record<string, Partial<InitiativesExactInitiative>> = {};
	const rows: Record<string, InitiativesExactRole[]> = {};
	let waiting = 0;
	/** A detail's chip rule, what waits on the owner there, and the paused banner's text. */
	const scoped = (record: UiWorkPageRecord | undefined, tasks: readonly UiWorkPageTask[]) => {
		const rule = ruleOf(record?.status ?? "active", tasks);
		const onYou = asksOf(tasks, now, open);
		const out: Partial<InitiativesExactInitiative> = { onYou };
		if (rule.status === "paused") out.pausedText = pausedText(tasks);
		return { rule, onYou, out };
	};
	for (const i of page.initiatives) {
		const { rule, onYou, out } = scoped(i, scopeOf(page, i.id));
		// An active initiative with no open task: its grey chip says so, not just "Active".
		if (!rule.status && i.status === "active") out.statusLabel = rule.label;
		initiatives[i.id] = out;
		waiting += onYou.length;
		const direct = links.direct.get(i.id) ?? [];
		const fields = rowFields("active", direct, now, open);
		const live = fields.tasks ?? [];
		if (live.length) {
			const last = Math.max(...direct.filter(isOpen).map(changedAt));
			rows[i.id] = [
				{
					...fields,
					name: "Directly under this initiative",
					part: "Tasks linked to the initiative itself, not to one of its projects",
					taskTitle: openCount(live.length),
					at: clockOf(last, now),
				},
			];
		}
	}

	// The projects in no initiative: their box's detail lists what waits on the owner and gets its chip by the
	// same rules (H-INITIATIVES-PAGE-3b); with no open task it keeps step 1's "No initiative". An item asks him.
	const loose = looseProjects(page);
	const loosePart: Record<string, { onYou: true }> = {};
	if (loose.length) {
		const { rule, onYou, out } = scoped(undefined, scopeOf(page, NO_INITIATIVE));
		if (rule.status) out.status = rule.status;
		initiatives[NO_INITIATIVE] = out;
		waiting += onYou.length;
		for (const p of loose) {
			if (asksOf(links.project.get(p.id) ?? [], now, open).length) loosePart[p.id] = { onYou: true };
		}
	}

	// A project's own detail: what waits on the owner there and its chip by the same rules. Its grey chip keeps
	// the registry's word (the plan step's frame).
	for (const p of page.projects) {
		const tasks = links.project.get(p.id) ?? [];
		const { rule, out } = scoped(p, tasks);
		if (rule.status) out.status = rule.status;
		initiatives[projectFrameId(p.id)] = out;
	}

	return { projects, initiatives, rows, loose: loosePart, page: summaryOf(page, waiting, !!opts.stale) };
}
