import { readFileSync, statSync } from "node:fs";
import type {
	UiTaskQueue,
	UiTaskQueueChat,
	UiTaskQueueHold,
	UiTaskQueueRef,
	UiTaskQueuePlan,
	UiTaskQueueTask,
	UiTaskParent,
	UiTaskProfile,
} from "./protocol.js";

/** pi-queue 的 customType（与 pi-queue queue.ts 的 ENTRY_TYPE 一致）。 */
export const TASK_QUEUE_ENTRY_TYPE = "queue";

/** 最多发多少个做完的任务：只留最近做完的。排着的和正在做的一个不少。 */
export const TASK_QUEUE_MAX_DONE = 20;

/** 计划每一部分的字数上限：pi-queue 不限长，防一份失控的计划把快照撑大。 */
export const PART_MAX = 4000;
/** 问题 / 总结的字数上限（pi-queue 自己把「停了两次」的问题截在 400）。 */
export const NOTE_MAX = 2000;
/** task-question decisions (rule 21): pi-queue's OWNER_DETAIL_MAX; it refuses a longer owner package. */
export const DETAIL_MAX = 12_000;
/** queue-drop: pi-queue's DROP_WHY_MAX, the longest reason a lead gives for dropping a task. */
export const TASK_QUEUE_DROP_WHY_MAX = 300;

/** queue-drop: a reason as pi-queue keeps it: one line, at most `max` characters ("" when it isn't text). */
export function oneLine(x: unknown, max: number): string {
	return typeof x === "string" ? x.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** A stuck question's package (rule 21): whole, or, past DETAIL_MAX, a notice instead (never clipped). */
export function detailOf(raw: unknown): string | undefined {
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	if (raw.length <= DETAIL_MAX) return raw;
	return (
		`This question came with ${raw.length} characters of context, more than the ${DETAIL_MAX} that can be shown, ` +
		"so none of it is shown here (it is never cut short). Ask Ops for the whole picture before you answer."
	);
}

/** owner-card-brief (Ops #682): the longest card kind kept (pi-queue's are one or two words). */
const CARD_MAX = 40;

/**
 * owner-card-brief (Ops #682): the kind of card and its one plain sentence (`card`, `in_short`) that pi-queue
 * saves with a stuck question, as given; the brief checks them. Older questions have neither.
 */
export function cardOf(raw: Record<string, unknown>): Pick<UiTaskQueueTask, "card" | "inShort"> {
	const card = oneLine(raw.card, CARD_MAX);
	const inShort = oneLine(raw.in_short, NOTE_MAX);
	return { ...(card ? { card } : {}), ...(inShort ? { inShort } : {}) };
}

export type PauseReason = NonNullable<UiTaskQueue["pausedReason"]>;
export const PAUSE_REASONS = new Set<PauseReason>(["user", "stopped", "error", "restart", "finished"]);

export type Status = UiTaskQueueTask["status"] | "removed";

/** 重放用的任务（带 removed；发出去之前滤掉）。 */
export interface Task extends Omit<UiTaskQueueTask, "status"> {
	status: Status;
	launchPrepared?: boolean;
	/** queue-paused: since when it has been paused (by itself or its queue), for the clock shift on release. */
	heldFrom?: number;
	/** queue-why: pi-queue's stuckAt: when it started needing the user (the same question again keeps it). */
	stuckAt?: number;
	/** queue-paused (Ops #393): pi-queue's `back`, the pause it was resumed from (see taskQueueBackOwed). */
	back?: TaskQueueBack;
}

/** queue-paused (Ops #393): the pause a task was resumed from, while it is owed its "Back to task" note. */
export interface TaskQueueBack {
	from: number;
	to: number;
}

export interface State {
	queueId?: string;
	autoApprove: boolean;
	autoStart: boolean;
	profile?: UiTaskProfile;
	tasks: Task[];
	running: boolean;
	pausedReason?: PauseReason;
	/** queue-lanes: how many lanes may run at once (pi-queue's DEFAULT_LANES / MAX_LANES). */
	lanes: number;
	/** queue-paused: the owner paused the whole queue. */
	hold?: UiTaskQueueHold;
	/** queue-lanes: set in a task's own chat — the queue it came from. */
	from?: UiTaskQueueChat;
}

/** 只用到的会话条目字段（SessionEntry 的子集，测试好造）。 */
export interface TaskQueueEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
	/** queue-lead-reminders: a session header's id (type "session"; see taskQueueAll). */
	id?: unknown;
}

/** queue-blocked: a task as replayed, removed ones too. */
export type TaskQueueTaskAny = Omit<UiTaskQueueTask, "status"> & {
	status: Status;
	/** queue-why: when it started needing the user (pi-queue's stuckAt); kept after, read it only while stuck. */
	stuckAt?: number;
	/** queue-paused (Ops #393): pi-queue's `back` (see taskQueueBackOwed); never sent to the page. */
	back?: TaskQueueBack;
};

export const TASK_QUEUE_DEFAULT_LANES = 2;
export const TASK_QUEUE_MAX_LANES = 8;

export const cap = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);
export const str = (x: unknown, max: number) => (typeof x === "string" ? cap(x, max) : "");
export const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
export const isId = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x > 0;

/** roles-panel: pi-queue's normInitiative: a saved project or initiative id, checked (INITIATIVE_MAX, INITIATIVE_ID). */
export function parentId(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const id = raw.trim();
	return id.length <= 60 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ? id : undefined;
}

/** roles-panel: pi-queue's nextParent: a project, initiative or standalone given replaces the parent; an empty
 *  project or initiative, or standalone false, clears it only when that is what it had; nothing given keeps it. */
export function nextParent(
	cur: UiTaskParent | undefined,
	given: { project?: string; initiative?: string; standalone?: boolean },
): UiTaskParent | undefined {
	const project = parentId(given.project);
	if (project) return { project };
	const initiative = parentId(given.initiative);
	if (initiative) return { initiative };
	if (given.standalone === true) return { standalone: true };
	if (cur && "project" in cur && given.project !== undefined) return undefined;
	if (cur && "initiative" in cur && given.initiative !== undefined) return undefined;
	if (cur && "standalone" in cur && given.standalone === false) return undefined;
	return cur;
}

/** roles-panel: an update's parent fields as pi-queue reads them (a text that isn't a short id or "" is ignored). */
export function parentGiven(op: Record<string, unknown>): {
	project?: string;
	initiative?: string;
	standalone?: boolean;
} {
	const text = (x: unknown) => (typeof x === "string" && (!x.trim() || parentId(x)) ? x.trim() : undefined);
	const project = text(op.project);
	const initiative = text(op.initiative);
	return {
		...(project !== undefined ? { project } : {}),
		...(initiative !== undefined ? { initiative } : {}),
		...(typeof op.standalone === "boolean" ? { standalone: op.standalone } : {}),
	};
}

export function setParent(task: Task, parent: UiTaskParent | undefined): void {
	if (parent) task.parent = parent;
	else delete task.parent;
}

export function planOf(raw: unknown): UiTaskQueuePlan {
	const p = (raw ?? {}) as Record<string, unknown>;
	return {
		title: str(p.title, 200),
		goal: str(p.goal, PART_MAX),
		doneWhen: str(p.doneWhen, PART_MAX),
		decided: str(p.decided, PART_MAX),
		steps: str(p.steps, PART_MAX),
		verify: str(p.verify, PART_MAX),
		mustNot: str(p.mustNot, PART_MAX),
	};
}

export const OPEN: ReadonlySet<Status> = new Set(["ready", "working", "asking", "stuck", "waiting", "blocked"]);
export const STATUSES: ReadonlySet<Status> = new Set<Status>([...OPEN, "done", "dropped", "removed"]);

/** queue-blocked: pi-queue's REF_NAME_MAX / NEED_MAX. */
const REF_NAME_MAX = 120;
const NEED_MAX = 300;

/** queue-blocked: pi-queue's normRef. */
function refOf(raw: unknown): UiTaskQueueRef | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	const id = typeof r.id === "number" ? r.id : Number.NaN;
	if (typeof r.file !== "string" || !r.file || !Number.isInteger(id) || id < 1) return undefined;
	const name = typeof r.name === "string" ? r.name.trim().slice(0, REF_NAME_MAX) : "";
	return { file: r.file, name, id };
}

/** queue-blocked: pi-queue's normRefs: checked, no duplicates (same file and number), at most 20; undefined when none. */
export function normTaskRefs(raw: unknown): UiTaskQueueRef[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: UiTaskQueueRef[] = [];
	for (const x of raw) {
		const r = refOf(x);
		if (r && !out.some((o) => o.file === r.file && o.id === r.id)) out.push(r);
	}
	return out.length ? out.slice(0, 20) : undefined;
}

/** queue-blocked: pi-queue's normNeed. */
export function needOf(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const t = raw.replace(/\s+/g, " ").trim();
	return t ? t.slice(0, NEED_MAX) : undefined;
}

/** queue-lead-reminders: pi-queue's OWES_MAX, ROLE_ID and LEAD_REMINDERS. */
const OWES_MAX = 200;
const ROLE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const LEAD_REMINDERS = 2;
/** queue-escalation: pi-queue's LEAD_CHAIN_MAX: at most this many leads above a block's own lead. */
export const LEAD_CHAIN_MAX = 2;

/** question-lead: the department lead a task's question is with, when it isn't Ops (a role id; never the owner). */
export function askLeadOf(raw: unknown): string | undefined {
	const lead = leadOf(raw);
	return lead && lead !== "ops" && lead !== "owner" ? lead : undefined;
}

/** queue-lead-reminders: pi-queue's normLead: a role id, lowercased; undefined when it isn't one. */
export function leadOf(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const id = raw.trim().toLowerCase();
	return ROLE_ID.test(id) ? id : undefined;
}

/** queue-lead-reminders: pi-queue's normOwes. */
export function owesOf(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const t = raw.replace(/\s+/g, " ").trim();
	return t ? t.slice(0, OWES_MAX) : undefined;
}

/** queue-lead-reminders: a time as saved (ms), or undefined. */
export const timeOf = (x: unknown): number | undefined =>
	typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.round(x) : undefined;

/** queue-lead-reminders: pi-queue's normReminders: sorted, at most LEAD_REMINDERS + LEAD_CHAIN_MAX; undefined when none. */
export function remindersOf(raw: unknown): number[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out = raw
		.map(timeOf)
		.filter((x): x is number => x !== undefined)
		.sort((a, b) => a - b)
		.slice(0, LEAD_REMINDERS + LEAD_CHAIN_MAX);
	return out.length ? out : undefined;
}

/**
 * queue-escalation: pi-queue's normChain: role ids in order, without the block's own lead, the owner or
 * repeats, at most LEAD_CHAIN_MAX. undefined when it isn't a list.
 */
export function chainOf(raw: unknown, lead: string | undefined): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: string[] = [];
	for (const x of raw) {
		const id = leadOf(x);
		if (id && id !== lead && id !== "owner" && !out.includes(id)) out.push(id);
	}
	return out.slice(0, LEAD_CHAIN_MAX);
}

/** queue-escalation: pi-queue's leadRounds: the reminders a lead block gets in all. */
export function leadRounds(b: { chain?: string[] }): number {
	return LEAD_REMINDERS + (b.chain?.length ?? 0);
}

/** queue-escalation: pi-queue's leadOf: who reminder n (from 1) goes to: the block's lead twice, then its chain. */
export function leadOfReminder(b: { lead?: string; chain?: string[] }, n: number): string {
	return n <= LEAD_REMINDERS ? (b.lead ?? "") : (b.chain?.[n - LEAD_REMINDERS - 1] ?? "");
}

/** queue-escalation: pi-queue's leadsOf: the leads that may answer a lead block. */
export function leadsOf(b: { lead?: string; chain?: string[] }): string[] {
	return b.lead ? [b.lead, ...(b.chain ?? [])] : [];
}

/** queue-blocked: pi-queue's outsideOf: a saved outside list, keeping what was recorded over already. */
export function outsideOf(raw: unknown, old: UiTaskQueueRef[] | undefined): UiTaskQueueRef[] | undefined {
	const refs = normTaskRefs(raw);
	if (!refs) return undefined;
	return refs.map((r) => {
		const was = old?.find((o) => o.file === r.file && o.id === r.id);
		return was?.over ? { ...r, over: was.over } : r;
	});
}

/** queue-blocked: "#12" in its own queue, "temper #38" in another (pi-queue's refLabel). */
export function taskRefLabel(r: { name: string; id: number }): string {
	return r.name ? `${r.name} #${r.id}` : `#${r.id}`;
}

/**
 * R6d: taskRefLabel in text that leaves the queue's department (roles_overview): task numbers repeat across queues,
 * so a task of this queue reads "ops #12" with the queue's role id (pi-queue's roleRefLabel).
 */
export function roleTaskRefLabel(r: { name: string; id: number }, role: string | undefined): string {
	return taskRefLabel(!r.name && role ? { name: role, id: r.id } : r);
}

export const current = (s: State) =>
	s.tasks.find((t) => !t.lane && (t.status === "working" || t.status === "asking" || t.status === "stuck"));

const LAND_ID_RE = /^(?:land-)?\d+-[0-9a-f]+$/i;
const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;
const REPO_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

export function deliveryOf(raw: unknown): UiTaskQueueTask["delivery"] | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const d = raw as Record<string, unknown>;
	const repo = typeof d.repo === "string" && REPO_SLUG_RE.test(d.repo.trim()) ? d.repo.trim() : undefined;
	const rawLandId =
		typeof d.landId === "string" ? d.landId.trim() : typeof d.land_id === "string" ? d.land_id.trim() : "";
	const landId = rawLandId && LAND_ID_RE.test(rawLandId) ? rawLandId : undefined;
	const rawCommit =
		typeof d.landedCommit === "string"
			? d.landedCommit.trim()
			: typeof d.landed_commit === "string"
				? d.landed_commit.trim()
				: "";
	const landedCommit = rawCommit && COMMIT_SHA_RE.test(rawCommit) ? rawCommit.toLowerCase() : undefined;
	if (!repo && !landId && !landedCommit) return undefined;
	return {
		...(repo ? { repo } : {}),
		...(landId ? { landId } : {}),
		...(landedCommit ? { landedCommit } : {}),
	};
}

/** pi-queue's normTouches: trimmed, lower case, inner spaces collapsed, no duplicates; undefined = not a list. */
export function normTouches(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: string[] = [];
	for (const x of raw) {
		if (typeof x !== "string") continue;
		const t = x.trim().replace(/\s+/g, " ").toLowerCase();
		if (t && t.length <= 80 && !out.includes(t)) out.push(t);
	}
	return out.slice(0, 20);
}

/** queue-side-by-side: pi-queue's normAfter: whole task numbers ("#4" too), no duplicates, never the task itself. */
export function normAfter(raw: unknown, self?: number): number[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: number[] = [];
	for (const x of raw) {
		const n = typeof x === "number" ? x : typeof x === "string" ? Number(x.trim().replace(/^#/, "")) : Number.NaN;
		if (Number.isInteger(n) && n > 0 && n !== self && !out.includes(n)) out.push(n);
	}
	return out.slice(0, 20);
}

/** queue-side-by-side: pi-queue's DEFAULT_SHAREABLE: touches tasks may share and still run side by side. */
export const TASK_QUEUE_DEFAULT_SHAREABLE: readonly string[] = ["* repo", "pi-web-deploy"];

/** queue-side-by-side: pi-queue's shareableOf: `*` stands for any run of characters, the rest matches itself. */
export function taskQueueShareableOf(
	patterns: readonly unknown[] = TASK_QUEUE_DEFAULT_SHAREABLE,
): (touch: string) => boolean {
	const exact = new Set<string>();
	const globs: RegExp[] = [];
	for (const p of normTouches([...patterns]) ?? []) {
		if (!p.includes("*")) exact.add(p);
		else
			globs.push(
				new RegExp(
					`^${p
						.split("*")
						.map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
						.join(".*")}$`,
				),
			);
	}
	return (touch) => exact.has(touch) || globs.some((g) => g.test(touch));
}

/** queue-side-by-side: pi-queue's shareableSetting: the settings' `shareable` list, or the default without one. */
export function taskQueueShareableSetting(settings: unknown): string[] {
	const list = settings && typeof settings === "object" ? (settings as { shareable?: unknown }).shareable : undefined;
	return normTouches(list) ?? [...TASK_QUEUE_DEFAULT_SHAREABLE];
}

let shareableCache: { file: string; stamp: string; patterns: string[] } | undefined;

export function taskQueueShareableFrom(file: string): { stamp: string; patterns: string[] } {
	let stamp = "none";
	try {
		const st = statSync(file);
		stamp = `${st.mtimeMs}:${st.size}`;
	} catch {
		// no settings file: the default
	}
	if (shareableCache?.file === file && shareableCache.stamp === stamp) return shareableCache;
	let settings: unknown;
	if (stamp !== "none") {
		try {
			settings = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			// unreadable or half written: the default until it reads
		}
	}
	shareableCache = { file, stamp, patterns: taskQueueShareableSetting(settings) };
	return shareableCache;
}

const MAX_CHOICES = 4;
const CHOICE_MAX = 100;

export function normChoices(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const x of raw) {
		if (typeof x !== "string") continue;
		const c = x.replace(/\s+/g, " ").trim();
		if (!c || out.some((o) => o.toLowerCase() === c.toLowerCase())) continue;
		out.push(c.length > CHOICE_MAX ? `${c.slice(0, CHOICE_MAX - 1)}\u2026` : c);
	}
	return out.slice(0, MAX_CHOICES);
}

/** A chat reference from an entry ({file, title?}); null when it isn't one. */
export function chatOf(raw: unknown): UiTaskQueueChat | null {
	const c = (raw ?? {}) as Record<string, unknown>;
	if (typeof c.file !== "string" || !c.file) return null;
	const title = typeof c.title === "string" && c.title ? cap(c.title, 200) : undefined;
	return { file: c.file, ...(title ? { title } : {}) };
}

export const DEFAULT_EVERY_MS = 2 * 60_000;
export const DEFAULT_GIVE_UP_MS = 24 * 3_600_000;
export const numOr = (x: unknown, fallback: number) => (typeof x === "number" && Number.isFinite(x) ? x : fallback);

export const HOLD_WHY_MAX = 500;
export const TASK_QUEUE_PANEL_PAUSE_WHY = "pressed Pause in the Queue panel";

export function heldBy(s: State, t: Task): UiTaskQueueHold | undefined {
	if (!OPEN.has(t.status)) return undefined;
	return t.hold ?? s.hold;
}

export function unhold(t: Task, at: number): void {
	const from = t.heldFrom ?? at;
	t.heldFrom = undefined;
	if (t.status === "waiting" && t.wait && !t.wait.overAt)
		t.wait.until += Math.max(0, at - Math.max(from, t.wait.since));
	if (t.status === "blocked" && t.block && !t.block.poke) t.block.start = Math.max(t.block.start, at);
	if (t.status === "working" && t.lane) t.back = { from, to: at };
}

export function endHold(t: Task): void {
	t.hold = undefined;
	t.heldFrom = undefined;
	t.back = undefined;
}

export function applyHold(s: State, op: Record<string, unknown>): void {
	const at = numOr(op.at, num(op.ts));
	const one = op.id === undefined ? undefined : s.tasks.find((t) => t.id === op.id);
	if (op.id !== undefined && (!one || !OPEN.has(one.status))) return;
	const open = one ? [one] : s.tasks.filter((t) => OPEN.has(t.status));
	const was = new Set(open.filter((t) => heldBy(s, t)).map((t) => t.id));
	if (op.op === "hold") {
		const why = typeof op.why === "string" ? op.why.trim().slice(0, HOLD_WHY_MAX) : "";
		if (!why) return;
		const before = one ? one.hold : s.hold;
		const hold: UiTaskQueueHold = { at: before?.at ?? at, why };
		if (one) one.hold = hold;
		else s.hold = hold;
		for (const t of open) if (!was.has(t.id)) t.heldFrom = at;
		return;
	}
	if (one ? !one.hold : !s.hold) return;
	if (one) one.hold = undefined;
	else s.hold = undefined;
	for (const t of open) if (was.has(t.id) && !heldBy(s, t)) unhold(t, at);
}
