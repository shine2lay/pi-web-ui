// initiatives-page-gaps (docs/initiatives-page-gaps.md, Ops #228): step 4's module. For every initiative and the
// "in no initiative" box: the gaps the lead hasn't covered, a fixed list worked out by script from the registry
// and its queues; all activity (the registry's changes to it, its projects and their tasks, plus the lead's
// progress updates), newest first; and the open hand-offs between roles that carry its id. Items, proof and
// first lines only as recorded; what nobody records says "Not recorded". No model.
// initiatives-live (docs/live-progress.md, H-INIT-LIVE-1): Latest updates are the newest three of all the records
// (the activity above, open tasks' progress lines and done tasks' summaries), not only the lead's posts.
import type {
	InitiativesExactActivity,
	InitiativesExactHandoff,
	InitiativesExactHandoffKind,
	InitiativesExactInitiative,
} from "../initiatives-exact-model";
import { roleName } from "../initiatives-view-model";
import { plain } from "../roles-useful-model";
import { clockOf } from "../roles-view-model";
import type {
	UiProgress,
	UiWorkActivity,
	UiWorkHandoff,
	UiWorkPage,
	UiWorkPageRecord,
	UiWorkPageTask,
	UiWorkTaskBlock,
	UiWorkTaskRef,
} from "../types";
import { NO_INITIATIVE, partIds, type InitiativesPageOpen, type InitiativesPagePart } from "./types";

/** What step 4 needs besides the registry page. */
export interface GapsInput {
	/** The decision log's progress feed: the open initiative's lead updates (absent until it comes). */
	progress?: UiProgress;
	/** This window's clock (ms) for the times shown; absent: the page's snapshot time. */
	now?: number;
}

export const NOT_RECORDED = "Not recorded";
export const NO_HANDOFFS = "No open question or request between roles carries this initiative.";
export const BOX_HANDOFFS = "Not recorded: role messages carry an initiative's id, and these projects are in none.";

/** A task its queue recorded as no longer open. */
const CLOSED = new Set<string>(["done", "dropped", "removed"]);
const FIELD: Record<string, string> = {
	name: "name",
	outcome: "outcome",
	doneWhen: "done-when items",
	lead: "lead",
	initiative: "initiative",
};
const STATE: Record<string, string> = {
	ready: "ready",
	working: "working",
	asking: "asking its main chat",
	stuck: "stuck",
	waiting: "waiting",
	blocked: "blocked",
	done: "done",
	dropped: "dropped",
	removed: "removed",
};
/** A queue task's own chat, as role messages name it. */
const TASK_CHAT = /^Queue #(\d+)$/;

/** live-progress: the server's clips (docs/live-progress.md): a progress line 400, a done summary 300. */
const PROGRESS_MAX = 400;
const SUMMARY_MAX = 300;
/** Latest updates: the newest this many records. */
export const LATEST_MAX = 3;

const q = (s: string) => `\u201c${s}\u201d`;
const taskKey = (t: UiWorkTaskRef) => `${t.queue}\u0000${t.task}\u0000${t.added}`;
const unmet = (r: UiWorkPageRecord) => r.doneWhen.filter((d) => !d.met);

/** "Ops #12": the queue's role (or its chat's title) and the task's number. */
export function taskLabel(t: UiWorkTaskRef): string {
	return t.queueName ? `${roleName(t.queueName)} #${t.task}` : `#${t.task}`;
}

/** What one initiative (or the box) covers: its record, its projects and their tasks, and its own tasks. */
interface Scope {
	initiative?: UiWorkPageRecord;
	projects: UiWorkPageRecord[];
	tasks: UiWorkPageTask[];
}

function scopeOf(page: UiWorkPage, id: string): Scope {
	const known = new Set(page.initiatives.map((i) => i.id));
	const projects =
		id === NO_INITIATIVE
			? page.projects.filter((p) => !p.initiative || !known.has(p.initiative))
			: page.projects.filter((p) => p.initiative === id);
	const ids = new Set(projects.map((p) => p.id));
	const tasks = page.tasks.filter((t) =>
		"project" in t.parent ? ids.has(t.parent.project) : "initiative" in t.parent && t.parent.initiative === id,
	);
	return { initiative: page.initiatives.find((i) => i.id === id), projects, tasks };
}

/** A blocked task's block as its queue recorded it: the tasks, the need, and which lead owes what by when. */
function blockedText(b: UiWorkTaskBlock | undefined, now: number): string {
	const parts: string[] = [];
	if (b?.on?.length) parts.push(b.on.join(", "));
	if (b?.need) parts.push(b.need);
	if (b?.lead) {
		const who = roleName(b.lead);
		parts.push((b.owes ? `${who} owes ${b.owes}` : `the ${who} lead`) + (b.due ? ` (due ${clockOf(b.due, now)})` : ""));
	}
	return parts.length ? `waits on ${parts.join("; ")}` : "what it waits on is not recorded";
}

/**
 * Whose answer a stuck task waits on (it called queue_stuck): "asking" waits on its department's lead, "stuck"
 * on the owner. From its Needs-you entry or its queue's next action.
 */
function stuckText(t: UiWorkPageTask): string {
	// live-progress: a question a lead's home chat holds hasn't reached the owner (docs/live-progress.md).
	if (t.withLead) return `its question is with ${roleName(t.withLead)}`;
	const who = t.nextAction?.kind === "answer" ? t.nextAction.who : undefined;
	if (t.needsYou || who === "owner") return "waits on your answer";
	return who ? `waits on an answer from ${roleName(who)}` : "whose answer it waits on is not recorded";
}

/**
 * The gaps the lead hasn't covered, in this order: (1) blocked or stuck tasks (queue states blocked, asking and
 * stuck) with what they wait on; (2) active projects with unmet done-when items and no open task; (3) an active
 * initiative's unmet done-when items while none of its projects is active (none at all, or all done or dropped).
 * A linked task whose state isn't recorded counts as open: no gap is claimed on a guess.
 */
export function gapsOf(s: Scope, now: number): string[] {
	const out: string[] = [];
	for (const t of s.tasks) {
		const held = t.paused ? " (you paused it)" : "";
		if (t.state === "blocked")
			out.push(`${taskLabel(t)} ${q(t.title)} is blocked: ${blockedText(t.block, now)}${held}`);
		else if (t.state === "asking" || t.state === "stuck")
			out.push(`${taskLabel(t)} ${q(t.title)} is stuck: ${stuckText(t)}${held}`);
	}
	for (const p of s.projects) {
		const left = unmet(p).length;
		if (p.status !== "active" || left === 0) continue;
		const open = s.tasks.some((t) => "project" in t.parent && t.parent.project === p.id && !CLOSED.has(t.state ?? ""));
		if (!open)
			out.push(
				`Project ${q(p.name)} (lead ${roleName(p.lead)}): ${left} of ${p.doneWhen.length} done-when items unmet, and no open task`,
			);
	}
	const i = s.initiative;
	if (i?.status === "active" && !s.projects.some((p) => p.status === "active"))
		for (const d of unmet(i)) out.push(`Done-when item with no active project: ${q(d.item)}`);
	return out;
}

/** One registry change in words; items and proof as recorded. */
function changeText(e: UiWorkActivity, page: UiWorkPage, tasks: ReadonlyMap<string, UiWorkPageTask>): string {
	const nameOf = (list: readonly UiWorkPageRecord[], id?: string) =>
		q(list.find((r) => r.id === id)?.name ?? id ?? NOT_RECORDED);
	const project = e.op.startsWith("project.");
	const what = project
		? `the project ${nameOf(page.projects, e.id)}`
		: `the initiative ${nameOf(page.initiatives, e.id)}`;
	const task = () => {
		const t = e.task ? tasks.get(taskKey(e.task)) : undefined;
		return t ? `${taskLabel(t)} ${q(t.title)}` : e.task ? taskLabel(e.task) : NOT_RECORDED;
	};
	switch (e.op) {
		case "initiative.create":
		case "project.create":
			return `Made ${what}`;
		case "initiative.change":
		case "project.change": {
			const fields = (e.changed ?? []).map((f) =>
				f === "status" ? (e.status ? `status ${e.status}` : "status") : (FIELD[f] ?? f),
			);
			if (!fields.length && e.status) fields.push(`status ${e.status}`);
			return fields.length ? `Changed ${what}: ${fields.join(", ")}` : `Changed ${what}`;
		}
		case "initiative.met":
		case "project.met":
			return `Marked met on ${what}: ${q(e.item ?? NOT_RECORDED)} \u00b7 proof: ${e.proof ?? NOT_RECORDED}`;
		case "initiative.unmet":
		case "project.unmet":
			return `Took back the met mark on ${what}: ${q(e.item ?? NOT_RECORDED)} \u00b7 why: ${e.reason ?? NOT_RECORDED}`;
		case "task.link": {
			const p = e.parent;
			const where = !p
				? NOT_RECORDED
				: "project" in p
					? `the project ${nameOf(page.projects, p.project)}`
					: "initiative" in p
						? `the initiative ${nameOf(page.initiatives, p.initiative)}`
						: "nothing (standalone)";
			return `Linked ${task()} to ${where}`;
		}
		case "task.state":
			return `${task()}: ${e.status ? (STATE[e.status] ?? e.status) : `status ${NOT_RECORDED.toLowerCase()}`}`;
		default:
			return NOT_RECORDED;
	}
}

/** One line with its time; `doneOf`: the task (taskKey) a registry "done" change is about. */
interface Timed {
	ms: number;
	line: InitiativesExactActivity;
	doneOf?: string;
}

/** All activity, newest first: the registry's changes to the scope, plus the lead's progress updates. */
export function activityOf(
	page: UiWorkPage,
	id: string,
	s: Scope,
	progress: UiProgress | undefined,
	now: number,
): InitiativesExactActivity[] {
	return activityTimed(page, id, s, progress, now).map((l) => l.line);
}

function activityTimed(page: UiWorkPage, id: string, s: Scope, progress: UiProgress | undefined, now: number): Timed[] {
	const projects = new Set(s.projects.map((p) => p.id));
	const tasks = new Map(s.tasks.map((t) => [taskKey(t), t]));
	const lines: Timed[] = [];
	for (const e of page.activity) {
		const mine = e.op.startsWith("initiative.")
			? !!s.initiative && e.id === s.initiative.id
			: e.op.startsWith("project.")
				? !!e.id && projects.has(e.id)
				: !!e.task && tasks.has(taskKey(e.task));
		if (!mine) continue;
		lines.push({
			ms: e.at,
			line: {
				at: clockOf(e.at, now),
				role: e.by === "owner" ? "You" : roleName(e.by),
				text: changeText(e, page, tasks),
			},
			...(e.op === "task.state" && e.status === "done" && e.task ? { doneOf: taskKey(e.task) } : {}),
		});
	}
	// The feed sends its newest updates in full and the rest in brief (H-INITIATIVES-PAGE-4b): list them all.
	if (progress?.initiative === id)
		for (const u of [
			...progress.updates.map((f) => ({ at: f.at, by: f.by, byName: f.byName, changed: f.fields.changed })),
			...(progress.older ?? []),
		])
			lines.push({
				ms: u.at,
				line: {
					at: clockOf(u.at, now),
					role: u.byName || roleName(u.by),
					text: `Progress update: ${u.changed}`,
				},
			});
	// Stable: equal times keep the registry's newest-first order, then the updates'.
	return lines.sort((a, b) => b.ms - a.ms);
}

/**
 * live-progress (H-INIT-LIVE-1): Latest updates, the newest LATEST_MAX of every record for the scope: the
 * activity (registry changes and the lead's posts, as above), each open task's newest progress line ("#N <line>",
 * by its queue's role, at the line's time) and each done task's summary ("#N done: <summary>", at when it was
 * done), in place of the registry's bare "done" line for that task. Fields an older server leaves out simply add
 * nothing; agent-written text goes through the Roles page's unsafe-text filter (plain) or isn't shown.
 */
export function latestOf(
	page: UiWorkPage,
	id: string,
	s: Scope,
	progress: UiProgress | undefined,
	now: number,
): InitiativesExactActivity[] {
	const summarized = new Set<string>();
	const lines: Timed[] = [];
	const line = (t: UiWorkPageTask, ms: number, text: string): Timed => ({
		ms,
		line: { at: clockOf(ms, now), role: t.queueName ? roleName(t.queueName) : NOT_RECORDED, text },
	});
	for (const t of s.tasks) {
		if (t.state === "done") {
			const summary = plain(t.doneSummary, SUMMARY_MAX);
			if (!summary) continue;
			summarized.add(taskKey(t));
			lines.push(line(t, t.stateAt ?? t.added, `#${t.task} done: ${summary.text}`));
		} else if (!CLOSED.has(t.state ?? "") && t.progress && Number.isFinite(t.progress.at)) {
			const text = plain(t.progress.text, PROGRESS_MAX);
			if (text) lines.push(line(t, t.progress.at, `#${t.task} ${text.text}`));
		}
	}
	for (const l of activityTimed(page, id, s, progress, now)) if (!l.doneOf || !summarized.has(l.doneOf)) lines.push(l);
	return lines
		.sort((a, b) => b.ms - a.ms)
		.slice(0, LATEST_MAX)
		.map((l) => l.line);
}

/** One open hand-off: from \u2192 to (with the task number when sent from or to a queue task's chat), what, where it stands. */
export function handoffOf(h: UiWorkHandoff, now: number): InitiativesExactHandoff {
	const taskOf = (chat?: string) => {
		const m = chat ? TASK_CHAT.exec(chat) : null;
		return m ? `#${m[1]}` : undefined;
	};
	const [state, kind]: [string, InitiativesExactHandoffKind] =
		h.state === "delivered"
			? [`Delivered${h.deliveredAt ? " " + clockOf(h.deliveredAt, now) : ""} \u00b7 no reply yet`, "wait"]
			: h.state === "held"
				? [`Held: role messages are paused \u00b7 sent ${clockOf(h.at, now)}`, "paused"]
				: [`Not delivered yet \u00b7 sent ${clockOf(h.at, now)}`, "active"];
	return {
		from: roleName(h.from),
		fromTask: taskOf(h.fromChat),
		to: roleName(h.to),
		toTask: taskOf(h.toChat),
		what: `${h.kind === "question" ? "Question" : "Request"}: ${h.firstLine}`,
		state,
		kind,
	};
}

function sectionsOf(page: UiWorkPage, id: string, input: GapsInput, now: number): Partial<InitiativesExactInitiative> {
	const s = scopeOf(page, id);
	const out: Partial<InitiativesExactInitiative> = {
		gaps: gapsOf(s, now),
		activity: activityOf(page, id, s, input.progress, now),
		latest: latestOf(page, id, s, input.progress, now),
	};
	if (id === NO_INITIATIVE) {
		// The box has no lead: Latest updates keeps the core's "No lead, so no updates." instead of the design's
		// newest three activity lines.
		return { ...out, latest: [], handoffs: [], handoffsNote: BOX_HANDOFFS };
	}
	if (!page.handoffs) return { ...out, handoffs: [], handoffsNote: NOT_RECORDED };
	const handoffs = page.handoffs.filter((h) => h.initiative === id).map((h) => handoffOf(h, now));
	return { ...out, handoffs, ...(handoffs.length ? {} : { handoffsNote: NO_HANDOFFS }) };
}

export function gapsPart(
	page: UiWorkPage,
	_selected: string | undefined,
	_open: InitiativesPageOpen,
	input: GapsInput = {},
): InitiativesPagePart {
	const now = input.now ?? page.at;
	return { initiatives: Object.fromEntries(partIds(page).map((id) => [id, sectionsOf(page, id, input, now)])) };
}
