/**
 * live-progress (Ops #270, docs/live-progress.md): the live-progress fields of the Roles overview and the
 * Initiatives page, copied or clipped from records the server already reads. Pure functions: no file, no model.
 *
 *   - progress: a task's own chat's newest TL;DR line that a page may show, with its time;
 *   - withLead: the role whose home chat has a task's question while it hasn't reached the owner (the owner rule);
 *   - doneRecent / doneSummary: a queue's done tasks with their queue_done summaries, clipped.
 */
import type { UiRoleDoneTask, UiRolesOverview, UiTaskProgress, UiTaskQueueTask, UiTldrLine } from "./protocol.js";

/** A role's newest done tasks sent in its overview (newest first). */
export const LIVE_DONE_RECENT_MAX = 10;
/** A queue_done summary is clipped to this many characters (the first one less, then "…"). */
export const LIVE_SUMMARY_MAX = 300;

/** The pages' unsafe-text rule (web/src/roles-useful-model.ts UNSAFE, plain()): such a line is never shown. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029]/u;
/** A role id as identity.json names one (lowercase letters, digits, dashes). */
const ROLE_ID = /^[a-z0-9][a-z0-9-]{0,59}$/;

/** A line a page would show: not empty and no unsafe character once tabs and line breaks are spaces. */
export function safeLine(text: unknown): text is string {
	if (typeof text !== "string") return false;
	const flat = text.replace(/[\t\n\r]+/g, " ").trim();
	return !!flat && !UNSAFE.test(flat);
}

/** Clipped to `max` characters (code points): the first max - 1, then "…". */
export function clipText(text: string, max = LIVE_SUMMARY_MAX): string {
	if (text.length <= max) return text;
	const points = Array.from(text);
	return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
}

/** progress: the newest line with a known time that a page may show (the newest one in file order on a tie). */
export function progressOf(lines: readonly UiTldrLine[]): UiTaskProgress | undefined {
	let best: UiTldrLine | undefined;
	for (const l of lines) {
		if (!(l.ts > 0) || !safeLine(l.text)) continue;
		if (!best || l.ts >= best.ts) best = l;
	}
	return best ? { text: best.text, at: best.ts } : undefined;
}

/** Where a stuck task's question went, as its newest "stuck" record's `ask` says (pi-queue's TaskAsk route). */
export interface StuckRoute {
	passed?: boolean;
	why?: string;
	to?: string;
	lead?: string;
	step?: number;
	chain?: string[];
}

/** The route fields of a "stuck" record's `ask`; undefined when it has none (the queue gave it to the owner directly). */
export function stuckRouteOf(ask: unknown): StuckRoute | undefined {
	if (!ask || typeof ask !== "object" || Array.isArray(ask)) return undefined;
	const a = ask as Record<string, unknown>;
	const chain = Array.isArray(a.chain) ? a.chain.filter((x): x is string => typeof x === "string") : undefined;
	return {
		...(a.passed === true ? { passed: true } : {}),
		...(typeof a.why === "string" && a.why ? { why: a.why } : {}),
		...(typeof a.to === "string" ? { to: a.to } : {}),
		...(typeof a.lead === "string" ? { lead: a.lead } : {}),
		...(typeof a.step === "number" && Number.isInteger(a.step) && a.step > 0 ? { step: a.step } : {}),
		...(chain ? { chain } : {}),
	};
}

/**
 * The owner rule for a stuck task: the role whose home chat still has its question, or undefined when the question
 * reached the owner. It reached him when the record has no route (every direct path: a block no lead answered, his
 * stop of a run, a needs_owner package, a task in its main chat's own queue, an unreachable incident), or it was
 * passed on (`passed`, which an escalate record's delivery also writes), or it went on without an answer (`why`),
 * or its route's chain ended at the owner. Only a record that names the lead holding it (`lead`, or the chain's
 * step) keeps it with that lead, and only when that lead is a role with a home chat: an ask is never hidden on a
 * doubt (a route that names nobody, `to: "ops"` alone included, stays the owner's).
 */
export function stuckWithLead(route: StuckRoute | undefined, roles: ReadonlySet<string>): string | undefined {
	if (!route || route.passed || route.why) return undefined;
	const chain = route.chain ?? [];
	const step = route.step ?? 0;
	if (step > chain.length) return undefined;
	const lead = route.lead ?? (step > 0 ? chain[step - 1] : undefined);
	if (!lead || lead === "owner" || !ROLE_ID.test(lead) || !roles.has(lead)) return undefined;
	return lead;
}

/**
 * withLead for an open task: an asking task's decider (as the Queue tab names it: `askOps ? (askLead ?? "ops") :`
 * the role whose queue holds it), a stuck one by the owner rule. `roles`: the roles with a home chat; a decider that
 * isn't one leaves it out.
 */
export function withLeadOf(
	t: Pick<UiTaskQueueTask, "status" | "askOps" | "askLead">,
	route: StuckRoute | undefined,
	department: string,
	roles: ReadonlySet<string>,
): string | undefined {
	if (t.status === "asking") {
		const lead = t.askOps ? (t.askLead ?? "ops") : department;
		return roles.has(lead) ? lead : undefined;
	}
	if (t.status === "stuck") return stuckWithLead(route, roles);
	return undefined;
}

/** A role's newest done tasks, newest first; a done task without its time is left out. */
export function doneRecentOf(tasks: readonly UiTaskQueueTask[], max = LIVE_DONE_RECENT_MAX): UiRoleDoneTask[] {
	return tasks
		.filter(
			(t): t is UiTaskQueueTask & { doneAt: number } =>
				t.status === "done" && typeof t.doneAt === "number" && t.doneAt > 0,
		)
		.sort((a, b) => b.doneAt - a.doneAt)
		.slice(0, max)
		.map((t) => ({ id: t.id, title: t.plan.title, summary: t.summary ? clipText(t.summary) : "", at: t.doneAt }));
}

/** One done task of a home queue, for the Initiatives page's join (added tells it apart from another branch's). */
export interface DoneFact {
	added: number;
	summary?: string;
}

/** Each home queue's done tasks, by its chat file, for the overview they were read with (never sent to a page). */
const DONE_FACTS = new WeakMap<UiRolesOverview, Map<string, Map<number, DoneFact>>>();

/** A queue's done tasks with their clipped summaries (absent when none was recorded). */
export function doneFactsOfTasks(tasks: readonly UiTaskQueueTask[]): Map<number, DoneFact> {
	const out = new Map<number, DoneFact>();
	for (const t of tasks) {
		if (t.status !== "done" || out.has(t.id)) continue;
		out.set(t.id, { added: t.addedAt, ...(t.summary ? { summary: clipText(t.summary) } : {}) });
	}
	return out;
}

export function setDoneFacts(overview: UiRolesOverview, facts: Map<string, Map<number, DoneFact>>): void {
	DONE_FACTS.set(overview, facts);
}

/** The done tasks read with this overview, by home chat file (none for an overview made elsewhere). */
export function doneFactsOf(overview: UiRolesOverview): ReadonlyMap<string, ReadonlyMap<number, DoneFact>> {
	return DONE_FACTS.get(overview) ?? new Map();
}
