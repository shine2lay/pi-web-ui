/**
 * dead-end (Ops #483, owner order bp-36910028, AGENTS.md rule 30; docs/stall-watch.md "Dead end"): whether an
 * active project of the work registry has nothing moving, from the work page alone (no model). The one place
 * this is decided: the stall check's "dead-end" rule (stall-watch.ts) and pi-queue's drop and reply results
 * (the queue host's deadEnd, queue-host.ts) both ask deadEndOf.
 *
 * A project is dead-ended when it is active, has had at least one task linked, and none of its tasks (in any
 * queue) is moving:
 * - working, waiting on a queue_wait check, or asking (its question is with its lead: that card is the poke);
 * - ready and able to start now: no unmet `after`, or an `after` on a task outside this project (a link);
 * - blocked, but let go by its queue (answered, or what it waited on is over): it comes back to work next;
 * - blocked "on" an open task outside this project (a link to the work it really waits on);
 * - waiting on the owner: its question is in the owner's Needs-you list, or it is stuck (with the owner);
 * and no open question to the owner that isn't a task's (a home chat's dialog, a TL;DR line) names the project or
 * its initiative (by id or name). A task blocked only on a "need" text, or only on tasks of this same project,
 * doesn't count as moving.
 *
 * Quiet (never dead-ended): a recorded wait that holds (work_project wait), every open task paused by the owner
 * or in a stopped queue, a project with no task linked yet or whose last task was done (the "empty"
 * rule covers those, with its grace), or one not active.
 */
import { resolve } from "node:path";
import type { UiWorkPage, UiWorkPageRecord, UiWorkPageTask, UiWorkTaskState } from "./protocol.js";

/** A wait never counts for longer than this after it was recorded (pi-queue's own cap, Ops #282). */
const WAIT_MAX_MS = 14 * 24 * 3_600_000;
const CLOSED: ReadonlySet<string> = new Set(["done", "dropped", "removed"]);

/** What the check reads: the page's tasks, and (when there) its initiatives and the owner's other open questions. */
export type DeadEndPage = Pick<UiWorkPage, "tasks"> & Partial<Pick<UiWorkPage, "initiatives" | "ownerAsks">>;

/** Open: not done, dropped or removed (a link with no status recorded yet counts as open, as ready). */
export const isOpenTask = (t: Pick<UiWorkPageTask, "state">): boolean => !CLOSED.has(t.state ?? "ready");

export type DeadEndVerdict =
	{ state: "dead"; since: number; why: string } | { state: "moving"; why: string } | { state: "quiet"; why: string };

/** How people call a task: "<queue> #<n>". */
export const deadEndTaskName = (t: Pick<UiWorkPageTask, "queueName" | "queue" | "task">): string =>
	`${t.queueName || t.queue} #${t.task}`;

/** A task ref as the queue writes it ("#12" in the task's own queue, "temper #38" elsewhere): queue name and number. */
function parseRef(ref: string): { name: string; n: number } | undefined {
	const m = /^(.*?)\s*#(\d+)$/.exec(String(ref ?? "").trim());
	return m ? { name: m[1].trim(), n: Number(m[2]) } : undefined;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `text` names a record: its id as a whole word, or its whole name (both in any case). */
export function namesRecord(text: string, r: { id: string; name?: string }): boolean {
	const t = text.toLowerCase();
	const id = r.id.trim().toLowerCase();
	if (id && new RegExp(`(^|[^a-z0-9-])${escapeRe(id)}($|[^a-z0-9-])`).test(t)) return true;
	const name = (r.name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
	return name.length >= 4 && t.replace(/\s+/g, " ").includes(name);
}

/**
 * Whether the project `id` is dead-ended now. `page` is the whole work page (its tasks with their queues' facts);
 * `now` decides whether a recorded wait still holds.
 */
export function projectDeadEnd(
	page: Pick<UiWorkPage, "projects"> & DeadEndPage,
	id: string,
	now: number,
): DeadEndVerdict {
	const r = page.projects.find((p) => p.id === id);
	if (!r) return { state: "quiet", why: "not in the registry" };
	return deadEndOf(r, page, now);
}

/** projectDeadEnd for a record already found (the stall check's loop). */
export function deadEndOf(r: UiWorkPageRecord, page: DeadEndPage, now: number): DeadEndVerdict {
	if (r.status !== "active") return { state: "quiet", why: `status ${r.status}` };
	const w = r.wait;
	if (w && now < Math.min(w.until, w.at + WAIT_MAX_MS)) return { state: "quiet", why: `waits on purpose: ${w.why}` };
	const all = page.tasks;
	const own = all.filter((t) => "project" in t.parent && t.parent.project === r.id);
	if (!own.length) return { state: "quiet", why: "no task linked to it yet" };
	const open = own.filter(isOpenTask);
	if (!open.length) {
		// Its last task finished (done): nothing was cut off; the "empty" rule gives its lead the usual grace.
		const last = [...own].sort((a, b) => (b.stateAt ?? b.added) - (a.stateAt ?? a.added))[0];
		if (last.state === "done") return { state: "quiet", why: `its last task ${deadEndTaskName(last)} is done` };
	}
	// Held: paused by the owner, or in a queue someone stopped (the Roles page counts it paused too).
	const held = (t: UiWorkPageTask) => !!t.paused || !!t.queueStopped;
	if (open.length && open.every(held)) {
		return {
			state: "quiet",
			why: `every open task is paused by the owner or in a stopped queue: ${open.map(deadEndTaskName).join(", ")}`,
		};
	}
	/** A ref from task t: is it one of this project's own tasks? */
	const ownRef = (t: UiWorkPageTask, ref: string): boolean => {
		const p = parseRef(ref);
		if (!p) return false;
		return own.some((o) => o.task === p.n && (p.name ? (o.queueName || o.queue) === p.name : o.queue === t.queue));
	};
	/** A ref outside this project that is still open (or not known to have closed). */
	const openOutside = (t: UiWorkPageTask, ref: string): boolean => {
		if (ownRef(t, ref)) return false;
		const p = parseRef(ref);
		if (!p) return true;
		const linked = all.filter(
			(o) => o.task === p.n && (p.name ? (o.queueName || o.queue) === p.name : o.queue === t.queue),
		);
		// The newest link with that number decides; one the registry doesn't know counts as open.
		const last = linked.sort((a, b) => b.added - a.added)[0];
		return !last || isOpenTask(last);
	};
	for (const t of open) {
		if (held(t)) continue;
		const name = deadEndTaskName(t);
		if (t.needsYou || t.state === "stuck") return { state: "moving", why: `${name} waits on the owner` };
		switch (t.state ?? "ready") {
			case "working":
				return { state: "moving", why: `${name} is at work` };
			case "waiting":
				return { state: "moving", why: `${name} waits on a check` };
			case "asking":
				return { state: "moving", why: `${name}'s question is with its lead` };
			case "ready": {
				// Only a queue step's list is its afters (a blocked task's next step lists what it is blocked on).
				const after = t.nextAction?.kind === "queue" ? (t.nextAction.after ?? []) : [];
				if (!after.length) return { state: "moving", why: `${name} is ready to start` };
				const outside = after.find((ref) => openOutside(t, ref));
				if (outside) return { state: "moving", why: `${name} starts after ${outside}` };
				break;
			}
			case "blocked": {
				if (t.poked !== undefined) return { state: "moving", why: `${name} was let go and comes back to work next` };
				const on = t.block?.on ?? [];
				const outside = on.find((ref) => openOutside(t, ref));
				if (outside) return { state: "moving", why: `${name} waits on ${outside}` };
				break;
			}
		}
	}
	// An open question to the owner that isn't a task's, naming the project or its initiative.
	const ini = r.initiative ? page.initiatives?.find((i) => i.id === r.initiative) : undefined;
	const named = [{ id: r.id, name: r.name }, ...(r.initiative ? [{ id: r.initiative, name: ini?.name }] : [])];
	const ask = (page.ownerAsks ?? []).find((a) => named.some((x) => namesRecord(a.text, x)));
	if (ask) return { state: "moving", why: `a question to the owner (${ask.role}) names it` };
	// When it got here: the newest closing, block or link among its tasks (a block's own start, not its reminders).
	let since = Number.NEGATIVE_INFINITY;
	for (const t of own) {
		const at = isOpenTask(t) && t.state === "blocked" && t.block ? t.block.since : (t.stateAt ?? t.added);
		if (at > since) since = at;
	}
	if (w) since = Math.max(since, Math.min(w.until, w.at + WAIT_MAX_MS));
	const why = open.length
		? `nothing moving: ${open.map((t) => `${deadEndTaskName(t)} ${t.state ?? "ready"}`).join(", ")}`
		: "no open task left";
	return { state: "dead", since, why };
}

/**
 * The queue host's deadEnd (queue-host.ts): the verdict for `project`, with the task pi-queue just changed (its
 * queue chat `file`, number `id`) taken at its new `state`, as the queue file may not have been read again yet.
 */
export function deadEndAnswer(
	page: Pick<UiWorkPage, "projects"> & DeadEndPage,
	req: { project: string; file?: string; id?: number; state?: UiWorkTaskState },
	now: number,
): { state: DeadEndVerdict["state"]; why: string; name: string; waysOut?: string } {
	const r = page.projects.find((p) => p.id === req.project);
	if (!r) return { state: "quiet", why: "not in the work registry", name: req.project };
	const file = req.file ? resolve(req.file) : undefined;
	// The newest link of that queue and number (an older one with the same number is another task).
	let hit: UiWorkPageTask | undefined;
	if (file && req.id && req.state) {
		for (const t of page.tasks) {
			if (t.task === req.id && resolve(t.queue) === file && (!hit || t.added > hit.added)) hit = t;
		}
	}
	const changed = (t: UiWorkPageTask): UiWorkPageTask => {
		// Its new status from pi-queue, without the old status's facts (a let-go block, a next step).
		const { poked: _p, nextAction: _n, ...rest } = t;
		return { ...rest, state: req.state, stateAt: Math.max(t.stateAt ?? 0, now) };
	};
	const tasks = hit ? page.tasks.map((t) => (t === hit ? changed(t) : t)) : page.tasks;
	const v = deadEndOf(r, { ...page, tasks }, now);
	return { state: v.state, why: v.why, name: r.name, ...(v.state === "dead" ? { waysOut: deadEndWaysOut(r.id) } : {}) };
}

/** The ways out, as both the tool results and the wake say them (rule 30). */
export function deadEndWaysOut(id: string): string {
	return (
		`queue the fix task (queue_add with project ${id}); link the other queue's task it really waits on ` +
		"(queue_blocked on, in the task's own chat; or queue_add with after that task); or ask the owner with the full package " +
		`(queue_stuck needs_owner in a task's own chat, or a question dialog naming project ${id}). ` +
		"If its work is finished, close it with work_project instead."
	);
}
