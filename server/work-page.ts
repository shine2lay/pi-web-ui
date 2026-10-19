/**
 * initiatives-plan-data (owner, 2026-10-18; Ops #223): the whole work registry, read for the Initiatives page.
 *
 * pi-work-management (the pi-queue repo, work-store.ts) keeps initiatives, projects and its index of linked
 * tasks in an append-only log, `events.jsonl` in the work folder (PI_WORK_DIR, or "work" in pi's agent folder),
 * one change per line. This replays all of it by the store's own rules (its applyEvent): every initiative and
 * project with its outcome, lead, status and done-when items with their met marks (proof, who, when), every
 * linked task with the status and block its queue recorded, and the newest changes. A change the store could
 * never have written (one its rules refuse, or one this reader doesn't know) is skipped and said
 * ("unknown-change"), never guessed at; a half-written last line is left out; a line that isn't JSON makes the
 * whole log "unreadable", as the store refuses it too.
 *
 * Each task is then joined with what its live queue says (its own chat, next action, requester, the owner's
 * pause, and whether its question waits on the owner), taken from the Roles overview's own projection (each
 * role's home queue and open asks); what isn't found there stays absent.
 *
 * It only reads, like the Roles reader (work-records.ts, whose output is left as it is): one open and stat per
 * look, of a regular file only, and the file again only when it changed, at most WORK_LOG_MAX bytes of it.
 */

import { open, stat, type FileHandle } from "node:fs/promises";
import { samePath } from "./identities.js";
import type {
	ServerMessage,
	UiRoleTaskNext,
	UiRolesOverview,
	UiTaskParent,
	UiTaskQueueHold,
	UiWorkActivity,
	UiWorkActivityOp,
	UiWorkDoneItem,
	UiWorkPage,
	UiWorkPageRecord,
	UiWorkPageTask,
	UiWorkTaskBlock,
	UiWorkTaskRef,
	UiWorkTaskState,
} from "./protocol.js";
import { requesterText } from "./queue-requester.js";
import { readUpTo, STATE_READ_FLAGS } from "./state-file-read.js";
import { WORK_LOG_MAX } from "./work-records.js";

/** At most this many initiatives and projects are sent (initiatives first); more says "too-big". */
export const WORK_PAGE_RECORDS_MAX = 500;
/** At most this many linked tasks are sent (in the order they were first linked); more says "too-big". */
export const WORK_PAGE_TASKS_MAX = 2000;
/** The newest this many changes are sent (newest first). */
export const WORK_PAGE_ACTIVITY_MAX = 1000;
/** While a page watches, the log and the queues are looked at this often. */
export const WORK_PAGE_POLL_MS = 5_000;
/** Several pokes close together make one look. */
export const WORK_PAGE_DEBOUNCE_MS = 500;

/** The store's own limits (pi-work-management work-store.ts). */
const WORK_ID_MAX = 60;
const WORK_NAME_MAX = 80;
const WORK_TEXT_MAX = 2000;
const WORK_TITLE_MAX = 200;
const WORK_DONE_ITEMS_MAX = 20;
const WORK_DONE_ITEM_MAX = 300;
const WORK_PROOF_MAX = 500;
const WORK_NEED_MAX = 500;
const WORK_ON_MAX = 20;
const WORK_REF_MAX = 120;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The log is read in pieces of this size, so one that grows while it is read stops at the limit. */
const READ_CHUNK = 1 << 20;

type Status = UiWorkPageRecord["status"];
const STATUSES: readonly string[] = ["active", "done", "dropped"];
const TASK_STATES: readonly string[] = [
	"ready",
	"working",
	"asking",
	"stuck",
	"waiting",
	"blocked",
	"done",
	"dropped",
	"removed",
];
/** The fields a change may set (the store's WorkChange; a project's also its initiative). */
const CHANGE_FIELDS: Record<"initiative" | "project", readonly string[]> = {
	initiative: ["name", "outcome", "doneWhen", "lead", "status"],
	project: ["name", "outcome", "doneWhen", "lead", "status", "initiative"],
};

interface Mark {
	item: string;
	proof: string;
	by: string;
	at: number;
}

interface Rec {
	kind: "initiative" | "project";
	id: string;
	name: string;
	outcome: string;
	doneWhen: string[];
	/** In list order, with the list's wording (the store's marksFor). */
	met: Mark[];
	lead: string;
	status: Status;
	/** Projects only: the initiative it serves, or null. */
	initiative?: string | null;
	createdAt: number;
	createdBy: string;
	updatedAt: number;
}

/** A blocked task's block as the store keeps it (TaskBlockInfo). */
interface Block {
	on?: string[];
	need?: string;
	lead?: string;
	owes?: string;
	due?: number;
	reminders: number;
	lastReminder?: number;
	since: number;
}

interface Link {
	queue: string;
	queueName?: string;
	task: number;
	added: number;
	title: string;
	parent: UiTaskParent;
	state?: UiWorkTaskState;
	stateAt?: number;
	block?: Block;
}

/** The log replayed (kept while the file is unchanged). Its records are never handed out, only copies. */
export interface WorkReplay {
	initiatives: Map<string, Rec>;
	projects: Map<string, Rec>;
	/** Keyed like the store's linkKey(queue, task, added), in the order they were first linked. */
	links: Map<string, Link>;
	/** The newest changes, oldest first. */
	activity: UiWorkActivity[];
	/** A change was skipped: one this reader doesn't know, or one the store's rules refuse. */
	unknown: boolean;
	/** The log as a whole couldn't be used. */
	problem?: "unreadable" | "too-big";
}

/** What a live queue says about one of its tasks, beyond the registry (the Roles overview's projection). */
export interface WorkTaskFacts {
	/** When it was added (ms), when the projection still says so (its newest milestone is being added). */
	added?: number;
	/** Its own chat's file, once started. */
	chat?: string;
	nextAction?: UiRoleTaskNext;
	requester?: string;
	paused?: UiTaskQueueHold;
	needsYou?: { text: string; since?: number };
}

/** One queue's facts: its chat file and its tasks by number. */
export interface WorkQueueFacts {
	file: string;
	tasks: Map<number, WorkTaskFacts>;
}

/** A change the store could never have written: skipped and said, never guessed at. */
class Skip extends Error {}

function must(ok: unknown): asserts ok {
	if (!ok) throw new Skip("skipped");
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** The store's textProblem: not empty, at most max characters, and on one line when it must be. */
const isText = (v: unknown, max: number, oneLine: boolean): v is string =>
	typeof v === "string" && v.trim().length > 0 && v.length <= max && !(oneLine && /[\r\n]/.test(v));
/** The store's isWorkId: ids and leads are short ids ("owner" is one too). */
const isWorkId = (v: unknown): v is string => typeof v === "string" && v.length <= WORK_ID_MAX && SLUG.test(v);
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
/** The store's itemKey: two done-when items are the same when their texts match, ignoring case and outer spaces. */
const itemKey = (item: string) => item.trim().toLowerCase();
/** An old single-text done when reads as its one item (the store's doneList). */
const doneList = (v: unknown): unknown => (typeof v === "string" ? [v] : v);
const linkKey = (queue: string, task: number, added: number) => `${queue}\u0000${task}\u0000${added}`;

/** The store's doneWhenProblem: 1 to 20 one-line items, none repeating another. */
function isDoneWhen(v: unknown): v is string[] {
	if (!Array.isArray(v) || !v.length || v.length > WORK_DONE_ITEMS_MAX) return false;
	const seen = new Set<string>();
	for (const item of v) {
		if (!isText(item, WORK_DONE_ITEM_MAX, true) || seen.has(itemKey(item))) return false;
		seen.add(itemKey(item));
	}
	return true;
}

/** The store's checkFields: the given fields (all of them when made) as the store takes them. */
function fieldsOk(d: Record<string, unknown>, all: boolean): boolean {
	return (
		((!all && d.name === undefined) || isText(d.name, WORK_NAME_MAX, true)) &&
		((!all && d.outcome === undefined) || isText(d.outcome, WORK_TEXT_MAX, false)) &&
		((!all && d.doneWhen === undefined) || isDoneWhen(d.doneWhen)) &&
		((!all && d.lead === undefined) || isWorkId(d.lead))
	);
}

/** The store's parentProblem: exactly one of project, initiative or standalone. */
function parentOf(v: unknown): UiTaskParent | undefined {
	if (!isObject(v) || Object.keys(v).length !== 1) return undefined;
	if ("project" in v) return isWorkId(v.project) ? { project: v.project } : undefined;
	if ("initiative" in v) return isWorkId(v.initiative) ? { initiative: v.initiative } : undefined;
	return v.standalone === true ? { standalone: true } : undefined;
}

const sameParent = (a: UiTaskParent, b: UiTaskParent) => JSON.stringify(a) === JSON.stringify(b);

/** The store's blockProblem: a blocked task's block as the index keeps it. */
function isBlock(v: unknown): v is Block {
	if (!v || typeof v !== "object") return false;
	const x = v as Record<string, unknown>;
	if (x.on !== undefined) {
		if (!Array.isArray(x.on) || !x.on.length || x.on.length > WORK_ON_MAX) return false;
		if (!x.on.every((r) => isText(r, WORK_REF_MAX, true))) return false;
	}
	if (x.need !== undefined && !isText(x.need, WORK_NEED_MAX, false)) return false;
	if (x.lead !== undefined && !isText(x.lead, WORK_ID_MAX, true)) return false;
	if (x.owes !== undefined && (x.lead === undefined || !isText(x.owes, WORK_NEED_MAX, false))) return false;
	if (x.due !== undefined && (x.lead === undefined || !isTime(x.due))) return false;
	if (!Number.isSafeInteger(x.reminders) || (x.reminders as number) < 0) return false;
	if (x.lastReminder !== undefined && (!isTime(x.lastReminder) || !x.reminders)) return false;
	if (!isTime(x.since)) return false;
	return x.on !== undefined || x.need !== undefined || x.lead !== undefined;
}

/** The store's copyBlock: its fields in a fixed order, so two copies of the same block compare equal. */
function copyBlock(b: Block): Block {
	return {
		...(b.on ? { on: [...b.on] } : {}),
		...(b.need !== undefined ? { need: b.need } : {}),
		...(b.lead !== undefined ? { lead: b.lead } : {}),
		...(b.owes !== undefined ? { owes: b.owes } : {}),
		...(b.due !== undefined ? { due: b.due } : {}),
		reminders: b.reminders,
		...(b.lastReminder !== undefined ? { lastReminder: b.lastReminder } : {}),
		since: b.since,
	};
}

function sameBlock(a: Block | undefined, b: Block | undefined): boolean {
	if (!a || !b) return !a && !b;
	return JSON.stringify(copyBlock(a)) === JSON.stringify(copyBlock(b));
}

/** The store's marksFor: the marks that still hold for this list, in its order and wording (a reworded item loses its mark). */
function marksFor(doneWhen: string[], marks: Mark[]): Mark[] {
	const byKey = new Map(marks.map((m) => [itemKey(m.item), m]));
	return doneWhen.flatMap((item) => {
		const m = byKey.get(itemKey(item));
		return m ? [{ ...m, item }] : [];
	});
}

/** The store's activeInitiative / activeProject: there, and still active. */
function activeInitiative(s: WorkReplay, id: unknown): string {
	must(typeof id === "string" && s.initiatives.get(id)?.status === "active");
	return id;
}

function activeProject(s: WorkReplay, id: string): void {
	must(s.projects.get(id)?.status === "active");
}

const taskRef = (l: Link): UiWorkTaskRef => ({
	queue: l.queue,
	...(l.queueName !== undefined ? { queueName: l.queueName } : {}),
	task: l.task,
	added: l.added,
});

type LogEvent = Record<string, unknown> & { op: string; ts: number; by: string };

/** One recorded change applied by the store's rules (applyEvent), or Skip. Nothing changes before every check passed. */
function apply(s: WorkReplay, e: LogEvent): UiWorkActivity {
	const at = e.ts;
	const by = e.by;
	const [kind, act, extra] = e.op.split(".");
	if ((kind === "initiative" || kind === "project") && extra === undefined) {
		const recs = kind === "initiative" ? s.initiatives : s.projects;
		const op = e.op as UiWorkActivityOp;
		if (act === "create") {
			const { id, name, outcome, lead } = e;
			const doneWhen = doneList(e.doneWhen);
			must(isWorkId(id) && !s.initiatives.has(id) && !s.projects.has(id));
			must(
				isText(name, WORK_NAME_MAX, true) &&
					isText(outcome, WORK_TEXT_MAX, false) &&
					isDoneWhen(doneWhen) &&
					isWorkId(lead),
			);
			const initiative =
				kind === "project" ? { initiative: e.initiative === null ? null : activeInitiative(s, e.initiative) } : {};
			recs.set(id, {
				kind,
				id,
				name,
				outcome,
				doneWhen: [...doneWhen],
				met: [],
				lead,
				status: "active",
				...initiative,
				createdAt: at,
				createdBy: by,
				updatedAt: at,
			});
			return { at, by, op, id };
		}
		const cur = typeof e.id === "string" ? recs.get(e.id) : undefined;
		must(cur);
		if (act === "change") {
			must(isObject(e.changes));
			const given: Record<string, unknown> = { ...e.changes };
			if (given.doneWhen !== undefined) given.doneWhen = doneList(given.doneWhen);
			// The store's realChanges: a field equal to what it already says changes nothing.
			const ch: Record<string, unknown> = Object.create(null);
			for (const [k, v] of Object.entries(given)) {
				if (v === undefined) continue;
				if (JSON.stringify((cur as unknown as Record<string, unknown>)[k]) !== JSON.stringify(v)) ch[k] = v;
			}
			const changed = Object.keys(ch);
			must(changed.length > 0 && changed.every((k) => CHANGE_FIELDS[kind].includes(k)));
			must(fieldsOk(ch, false));
			if (ch.status !== undefined) must(STATUSES.includes(ch.status as string));
			// An initiative closes only once none of its projects is active.
			if (kind === "initiative" && ch.status !== undefined && ch.status !== "active") {
				must(![...s.projects.values()].some((p) => p.initiative === cur.id && p.status === "active"));
			}
			if (kind === "project") {
				if (ch.initiative !== undefined && ch.initiative !== null) activeInitiative(s, ch.initiative);
				// Reopening a project under a closed initiative would hide active work under closed work.
				if (ch.status === "active" && ch.initiative === undefined && cur.initiative != null) {
					activeInitiative(s, cur.initiative);
				}
			}
			const doneWhen = (ch.doneWhen as string[] | undefined) ?? cur.doneWhen;
			const next: Rec = {
				...cur,
				...(ch as Partial<Rec>),
				doneWhen: [...doneWhen],
				met: marksFor(doneWhen, cur.met),
				updatedAt: at,
			};
			// Done means every done-when item is met, with its proof.
			must(next.status !== "done" || next.met.length === next.doneWhen.length);
			recs.set(cur.id, next);
			return { at, by, op, id: cur.id, changed, ...(ch.status !== undefined ? { status: ch.status as string } : {}) };
		}
		if (act === "met" || act === "unmet") {
			// Done-when items are marked only while it is active.
			must(cur.status === "active");
			const given = typeof e.item === "string" ? e.item : "";
			const n = cur.doneWhen.findIndex((item) => itemKey(item) === itemKey(given));
			must(given.trim() && n >= 0);
			const item = cur.doneWhen[n] as string;
			const was = cur.met.find((m) => itemKey(m.item) === itemKey(item));
			if (act === "met") {
				const proof = e.proof;
				must(isText(proof, WORK_PROOF_MAX, true) && !(was && was.proof === proof));
				const marks = [...cur.met.filter((m) => m !== was), { item, proof, by, at }];
				recs.set(cur.id, { ...cur, met: marksFor(cur.doneWhen, marks), updatedAt: at });
				return { at, by, op, id: cur.id, item, proof };
			}
			const reason = e.reason;
			must(isText(reason, WORK_PROOF_MAX, true) && was);
			recs.set(cur.id, { ...cur, met: cur.met.filter((m) => m !== was), updatedAt: at });
			return { at, by, op, id: cur.id, item, reason };
		}
		throw new Skip("unknown change");
	}
	if (e.op === "task.link") {
		const { queue, queueName, task, added, title } = e;
		must(typeof queue === "string" && queue && Number.isSafeInteger(task) && (task as number) >= 1);
		must(typeof added === "number" && Number.isFinite(added) && isText(title, WORK_TITLE_MAX, false));
		// The store keeps how people call the queue as given (pi-queue always gives one).
		must(queueName === undefined || typeof queueName === "string");
		const parent = parentOf(e.parent);
		must(parent);
		const key = linkKey(queue, task as number, added);
		const was = s.links.get(key);
		// A new or changed parent must be there and open; a title change under a closed parent is still recorded.
		if (!was || !sameParent(was.parent, parent)) {
			if ("project" in parent) activeProject(s, parent.project);
			if ("initiative" in parent) activeInitiative(s, parent.initiative);
		}
		must(!(was && sameParent(was.parent, parent) && was.title === title && was.queueName === queueName));
		const link: Link = {
			queue,
			...(queueName !== undefined ? { queueName } : {}),
			task: task as number,
			added,
			title,
			parent,
			// Its recorded status stays with it when its parent or title changes.
			...(was?.state ? { state: was.state } : {}),
			...(was?.stateAt !== undefined ? { stateAt: was.stateAt } : {}),
			...(was?.block ? { block: was.block } : {}),
		};
		s.links.set(key, link);
		return { at, by, op: "task.link", task: taskRef(link), parent: { ...parent } };
	}
	if (e.op === "task.state") {
		const { queue, task, added, status, block } = e;
		must(typeof queue === "string" && queue && Number.isSafeInteger(task));
		must(typeof added === "number" && Number.isFinite(added));
		const was = s.links.get(linkKey(queue, task as number, added));
		must(was && TASK_STATES.includes(status as string));
		// Only a blocked task has a block.
		must(block === undefined || (status === "blocked" && isBlock(block)));
		const b = block === undefined ? undefined : copyBlock(block as Block);
		must(!(was.state === status && sameBlock(was.block, b)));
		const { block: _old, ...rest } = was;
		const next: Link = { ...rest, state: status as UiWorkTaskState, stateAt: at, ...(b ? { block: b } : {}) };
		s.links.set(linkKey(queue, task as number, added), next);
		return { at, by, op: "task.state", task: taskRef(next), status: status as string };
	}
	throw new Skip("unknown change");
}

const replayOf = (problem?: WorkReplay["problem"]): WorkReplay => ({
	initiatives: new Map(),
	projects: new Map(),
	links: new Map(),
	activity: [],
	unknown: false,
	...(problem ? { problem } : {}),
});

/** The log's text, replayed. A half-written last line is left out; a line that isn't JSON makes it unreadable. */
export function replayWork(log: string): WorkReplay {
	const s = replayOf();
	const lines = log.split("\n");
	lines.pop();
	for (const line of lines) {
		if (!line.trim()) continue;
		let e: unknown;
		try {
			e = JSON.parse(line);
		} catch {
			// The store refuses to work with a log it can't read: so does the page.
			return replayOf("unreadable");
		}
		if (!isObject(e)) return replayOf("unreadable");
		// A line of another version, or without its time or author, isn't a change this reader knows.
		if (e.v !== 1 || typeof e.op !== "string" || !isTime(e.ts) || !isText(e.by, WORK_ID_MAX, true)) {
			s.unknown = true;
			continue;
		}
		try {
			s.activity.push(apply(s, e as LogEvent));
		} catch (err) {
			if (!(err instanceof Skip)) throw err;
			s.unknown = true;
			continue;
		}
		if (s.activity.length >= WORK_PAGE_ACTIVITY_MAX * 2) s.activity.splice(0, WORK_PAGE_ACTIVITY_MAX);
	}
	if (s.activity.length > WORK_PAGE_ACTIVITY_MAX) s.activity.splice(0, s.activity.length - WORK_PAGE_ACTIVITY_MAX);
	return s;
}

function recordOut(r: Rec): UiWorkPageRecord {
	const marks = new Map(r.met.map((m) => [itemKey(m.item), m]));
	return {
		id: r.id,
		name: r.name,
		outcome: r.outcome,
		lead: r.lead,
		status: r.status,
		createdAt: r.createdAt,
		createdBy: r.createdBy,
		updatedAt: r.updatedAt,
		doneWhen: r.doneWhen.map((item): UiWorkDoneItem => {
			const m = marks.get(itemKey(item));
			return m ? { item, met: { proof: m.proof, by: m.by, at: m.at } } : { item };
		}),
		...(r.kind === "project" ? { initiative: r.initiative ?? null } : {}),
	};
}

function blockOut(b: Block): UiWorkTaskBlock {
	return {
		...(b.on ? { on: [...b.on] } : {}),
		...(b.need !== undefined ? { need: b.need } : {}),
		...(b.lead !== undefined ? { lead: b.lead } : {}),
		...(b.owes !== undefined ? { owes: b.owes } : {}),
		...(b.due !== undefined ? { due: b.due } : {}),
		since: b.since,
	};
}

function taskOut(l: Link, f: WorkTaskFacts | undefined): UiWorkPageTask {
	return {
		...taskRef(l),
		title: l.title,
		parent: { ...l.parent },
		...(l.state ? { state: l.state } : {}),
		...(l.stateAt !== undefined ? { stateAt: l.stateAt } : {}),
		...(l.block ? { block: blockOut(l.block) } : {}),
		...(f?.chat ? { chat: f.chat } : {}),
		...(f?.nextAction ? { nextAction: { ...f.nextAction } } : {}),
		...(f?.requester ? { requester: f.requester } : {}),
		...(f?.paused ? { paused: { ...f.paused } } : {}),
		...(f?.needsYou ? { needsYou: { ...f.needsYou } } : {}),
	};
}

/** The page from a replayed log and the queues' facts: each task gets its own queue's facts, or none. A link
 *  whose queue file is `gone` is left out (initiatives-page-tasks, H-INITIATIVES-PAGE-3c): a deleted chat's, or
 *  a throwaway copy's, like the one pi-web-deploy's big-chat check opens, whose queue wrote into the registry. */
export function workPageOf(
	r: WorkReplay,
	facts: readonly WorkQueueFacts[] = [],
	at = Date.now(),
	gone: ReadonlySet<string> = new Set(),
): UiWorkPage {
	if (r.problem) return { at, initiatives: [], projects: [], tasks: [], activity: [], problem: r.problem };
	const initiatives = [...r.initiatives.values()];
	const projects = [...r.projects.values()];
	const links = [...r.links.values()].filter((l) => !gone.has(l.queue));
	// A bloated log never enlarges every look past these.
	const tooMany = initiatives.length + projects.length > WORK_PAGE_RECORDS_MAX || links.length > WORK_PAGE_TASKS_MAX;
	const sentInitiatives = initiatives.slice(0, WORK_PAGE_RECORDS_MAX);
	const sentProjects = projects.slice(0, WORK_PAGE_RECORDS_MAX - sentInitiatives.length);
	const queues = new Map<string, WorkQueueFacts | undefined>();
	const queueOf = (file: string) => {
		if (!queues.has(file))
			queues.set(
				file,
				facts.find((q) => samePath(q.file, file)),
			);
		return queues.get(file);
	};
	// The same number linked more than once in one queue (another branch of its chat): only the projection's
	// own add time can tell which one it means.
	const numbers = new Map<string, number>();
	for (const l of links) numbers.set(`${l.queue}\u0000${l.task}`, (numbers.get(`${l.queue}\u0000${l.task}`) ?? 0) + 1);
	const factsOf = (l: Link): WorkTaskFacts | undefined => {
		const f = queueOf(l.queue)?.tasks.get(l.task);
		if (!f) return undefined;
		if (f.added !== undefined) return f.added === l.added ? f : undefined;
		return (numbers.get(`${l.queue}\u0000${l.task}`) ?? 0) > 1 ? undefined : f;
	};
	const problem = tooMany ? ("too-big" as const) : r.unknown ? ("unknown-change" as const) : undefined;
	return {
		at,
		initiatives: sentInitiatives.map(recordOut),
		projects: sentProjects.map(recordOut),
		tasks: links.slice(0, WORK_PAGE_TASKS_MAX).map((l) => taskOut(l, factsOf(l))),
		activity: r.activity.slice(-WORK_PAGE_ACTIVITY_MAX).reverse(),
		...(problem ? { problem } : {}),
	};
}

/** The page straight from the log's text (tests, and anything that has the text already). */
export function workPageFrom(log: string, facts: readonly WorkQueueFacts[] = [], at = Date.now()): UiWorkPage {
	return workPageOf(replayWork(log), facts, at);
}

/**
 * What the Roles overview already knows about each role's home queue: its listed tasks (open, not started yet,
 * dropped) with their chat, next action, requester and the owner's pause, and each task's oldest open ask.
 */
export function workFactsFromOverview(overview: UiRolesOverview): WorkQueueFacts[] {
	const out: WorkQueueFacts[] = [];
	for (const role of overview.roles) {
		const file = role.homeChat?.file;
		if (!file) continue;
		const tasks = new Map<number, WorkTaskFacts>();
		const q = role.queue;
		for (const t of q ? [...q.active, ...q.queued, ...(q.dropped ?? [])] : []) {
			if (tasks.has(t.id)) continue;
			const requester = t.requester ? requesterText(t.requester) : undefined;
			tasks.set(t.id, {
				...(t.queueEvent?.kind === "added" && t.queueEvent.at !== undefined ? { added: t.queueEvent.at } : {}),
				...(t.chat?.file ? { chat: t.chat.file } : {}),
				...(t.next ? { nextAction: t.next } : {}),
				...(requester ? { requester } : {}),
				...(t.paused ? { paused: t.paused } : {}),
			});
		}
		// Its open asks come oldest first: a task's first one is what waits on the owner.
		for (const a of role.asks) {
			const n = a.chat.where;
			if (typeof n !== "number") continue;
			const f = tasks.get(n) ?? {};
			if (f.needsYou) continue;
			f.needsYou = { text: a.text, ...(a.since !== undefined ? { since: a.since } : {}) };
			tasks.set(n, f);
		}
		if (tasks.size) out.push({ file, tasks });
	}
	return out;
}

/** The links' queue files that no longer exist, each looked up once (whether it's there, never what's in it).
 *  Only a missing file or folder counts: one it can't look up stays in. */
async function goneQueues(r: WorkReplay): Promise<Set<string>> {
	const gone = new Set<string>();
	const files = new Set([...r.links.values()].map((l) => l.queue));
	await Promise.all(
		[...files].map(async (file) => {
			try {
				await stat(file);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException)?.code;
				if (code === "ENOENT" || code === "ENOTDIR") gone.add(file);
			}
		}),
	);
	return gone;
}

/** The registry for the page: the log replayed again only when it changed, joined with the queues' facts. */
export class WorkPageFile {
	private seen: { mtimeMs: number; size: number; replay: WorkReplay } | null = null;

	constructor(
		private readonly path: () => string,
		private readonly maxBytes = WORK_LOG_MAX,
	) {}

	async get(facts: readonly WorkQueueFacts[] = [], at = Date.now()): Promise<UiWorkPage> {
		const r = await this.replay();
		return workPageOf(r, facts, at, await goneQueues(r));
	}

	private async replay(): Promise<WorkReplay> {
		const p = this.path();
		let fh: FileHandle;
		try {
			// Non-blocking, so a FIFO in the log's place can't stall the look: it is refused below.
			fh = await open(p, STATE_READ_FLAGS);
		} catch (err) {
			this.seen = null;
			// No log yet: nothing was ever recorded.
			if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return replayOf();
			return replayOf("unreadable");
		}
		try {
			const st = await fh.stat();
			// Only a regular file: never a FIFO, a device or a folder (a link is followed to what it names).
			if (!st.isFile()) {
				this.seen = null;
				return replayOf("unreadable");
			}
			if (st.size > this.maxBytes) {
				this.seen = null;
				return replayOf("too-big");
			}
			if (this.seen && this.seen.mtimeMs === st.mtimeMs && this.seen.size === st.size) return this.seen.replay;
			const bytes = await readUpTo(fh, this.maxBytes, READ_CHUNK);
			// It grew past the limit while being read.
			if (bytes === null) {
				this.seen = null;
				return replayOf("too-big");
			}
			const replay = replayWork(bytes.toString("utf8"));
			this.seen = { mtimeMs: st.mtimeMs, size: st.size, replay };
			return replay;
		} catch {
			this.seen = null;
			return replayOf("unreadable");
		} finally {
			await fh.close().catch(() => undefined);
		}
	}
}

export interface WorkPageWatchOptions {
	/** How often to look again while a page watches (the queues have no change signal of their own). */
	pollMs?: number;
	debounceMs?: number;
	log?: (line: string) => void;
}

/**
 * The windows watching the work page, keyed by their socket. A window gets the page at once, then again only
 * when it changed (its snapshot time aside): looked at every pollMs while any window watches, and soon after
 * a poke. A failure is sent as an error the page can show (it keeps what it had), and said in the log once.
 */
export class WorkPageWatch<K> {
	private readonly watchers = new Map<K, { send: (msg: ServerMessage) => void; seen?: string }>();
	private poll: ReturnType<typeof setInterval> | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private running: Promise<void> | null = null;
	private again = false;
	private lastError: string | null = null;
	private readonly pollMs: number;
	private readonly debounceMs: number;

	constructor(
		private readonly read: () => Promise<UiWorkPage>,
		private readonly opts: WorkPageWatchOptions = {},
	) {
		this.pollMs = opts.pollMs ?? WORK_PAGE_POLL_MS;
		this.debounceMs = opts.debounceMs ?? WORK_PAGE_DEBOUNCE_MS;
	}

	/** This window wants the page (again, if it watched already): it gets it as soon as it is made. */
	watch(key: K, send: (msg: ServerMessage) => void): Promise<void> {
		this.watchers.set(key, { send });
		if (!this.poll) {
			this.poll = setInterval(() => void this.look(), this.pollMs);
			this.poll.unref?.();
		}
		return this.look();
	}

	drop(key: K): void {
		this.watchers.delete(key);
		if (this.watchers.size) return;
		if (this.poll) clearInterval(this.poll);
		this.poll = null;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	/** Something changed: look again once things settle. */
	poke(): void {
		if (!this.watchers.size) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.look();
		}, this.debounceMs);
		this.timer.unref?.();
	}

	get size(): number {
		return this.watchers.size;
	}

	/** Whether it is looking on its timer (only while a window watches). */
	get polling(): boolean {
		return this.poll !== null;
	}

	/** Looks once, and once more if asked meanwhile (tests call it directly). */
	look(): Promise<void> {
		if (this.running) {
			this.again = true;
			return this.running;
		}
		this.running = (async () => {
			try {
				do {
					this.again = false;
					await this.lookOnce();
				} while (this.again && this.watchers.size);
			} finally {
				this.running = null;
			}
		})();
		return this.running;
	}

	private async lookOnce(): Promise<void> {
		if (!this.watchers.size) return;
		let msg: ServerMessage;
		let sig: string;
		try {
			const page = await this.read();
			const { at: _at, ...rest } = page;
			sig = JSON.stringify(rest);
			msg = { type: "work_page", page };
			this.lastError = null;
		} catch (err) {
			const error = (err as Error)?.message || String(err);
			if (error !== this.lastError) this.opts.log?.(`[work-page] couldn't make the page: ${error}`);
			this.lastError = error;
			sig = `error\u0000${error}`;
			msg = { type: "work_page", error };
		}
		for (const w of this.watchers.values()) {
			if (w.seen === sig) continue;
			w.seen = sig;
			try {
				w.send(msg);
			} catch {
				/* a closing socket */
			}
		}
	}
}
