// initiatives-page (docs/initiatives-page-exact.md, Ops #225): the core of the live Initiatives page. It
// turns the work registry page (work_page), the decision log's page (initiatives_watch, with the open
// initiative's progress feed) and the roles' home chats into the supplied design's input
// (InitiativesExactInput): page states, header, cards, the "Projects in no initiative" box, the detail's
// frame, lead, counts, project rows, buttons, decisions and lead updates. The plan, task and gap sections
// come from their own modules (plan.ts, tasks.ts, gaps.ts), laid over the core's fields in that order.
import type { Translate } from "../i18n";
import type {
	InitiativesExactDecision,
	InitiativesExactFinishedProject,
	InitiativesExactInitiative,
	InitiativesExactInput,
	InitiativesExactLooseItem,
	InitiativesExactRole,
} from "../initiatives-exact-model";
import {
	approvalLabel,
	creditKind,
	creditLabel,
	filedText,
	headSource,
	roleName,
	sourceLabel,
	writerLabel,
} from "../initiatives-view-model";
import { agoOf, clockOf } from "../roles-view-model";
import type { UiDecision, UiDecisionSource, UiDecisionsPage, UiWorkPage, UiWorkPageRecord } from "../types";
import { gapsPart } from "./gaps";
import { planPart } from "./plan";
import { stallLine, stallPart } from "./stall";
import { statusOf, tasksPart } from "./tasks";
import { NO_INITIATIVE, projectFrameId, type InitiativesPageOpen, type InitiativesPagePart } from "./types";

/** The work registry feed as the page holds it (work-page-state.ts). */
export interface WorkPageFeed {
	/** The latest page, kept when a later one fails. */
	page: UiWorkPage | null;
	/** loading: asked, nothing back yet; ready: `page` holds data; error: nothing to show. */
	status: "idle" | "loading" | "ready" | "error";
	error?: string;
	/** When the last error came (this window's clock, ms). */
	failedAt?: number;
}

export interface InitiativesPageArgs {
	work: WorkPageFeed;
	/** The decision log's page, null until it comes. */
	decisions: UiDecisionsPage | null;
	/** Each role's home chat file, by role id (only those that can be opened). */
	homeChats: Readonly<Record<string, string>>;
	/** The initiative (or NO_INITIATIVE) the owner opened; absent: the first card. */
	selected?: string;
	now: number;
	t: Translate;
	open: InitiativesPageOpen;
}

export interface InitiativesPageModel {
	input: InitiativesExactInput;
	/** The open initiative or NO_INITIATIVE: the owner's pick while it is still there, else the first card. */
	selected?: string;
	/** The lead's home chat by initiative id, where Message <lead> shows. */
	leadChats: Record<string, string>;
	/** Initiatives whose lead the decision log keeps: Change lead shows for these. */
	changeLead: string[];
	/** A decision's source by the ref its link hands back. */
	sources: Record<string, UiDecisionSource>;
}

const STATUS_WORD: Record<UiWorkPageRecord["status"], string> = {
	active: "Active",
	done: "Done",
	dropped: "Dropped",
};
const RANK: Record<UiWorkPageRecord["status"], number> = { active: 0, done: 1, dropped: 2 };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Active first, then done, then dropped; the registry's order within each. */
export function byStatus<T extends Pick<UiWorkPageRecord, "status">>(list: readonly T[]): T[] {
	return [...list].sort((a, b) => (RANK[a.status] ?? 3) - (RANK[b.status] ?? 3));
}

/** How many of a record's done-when items are met, of how many. */
export function doneCount(r: Pick<UiWorkPageRecord, "doneWhen">): { done: number; total: number } {
	return { done: r.doneWhen.filter((d) => !!d.met).length, total: r.doneWhen.length };
}

/** "Sun Oct 18". */
export function dateOf(ms: number): string {
	const d = new Date(ms);
	return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Projects in no initiative: none named, or one the registry doesn't hold. */
export function looseProjects(page: UiWorkPage): UiWorkPageRecord[] {
	const ids = new Set(page.initiatives.map((i) => i.id));
	return byStatus(page.projects.filter((p) => !p.initiative || !ids.has(p.initiative)));
}

const rolesLine = (n: number) => (n === 1 ? "1 role" : `${n} roles · lead + ${n - 1}`);

function projectRow(p: UiWorkPageRecord, now: number): InitiativesExactRole {
	const c = doneCount(p);
	return {
		name: p.name,
		opens: projectFrameId(p.id),
		part: "Lead · " + roleName(p.lead),
		taskTitle: c.total ? `${c.done} of ${c.total} done` : "No done-when items yet",
		statusLabel: STATUS_WORD[p.status] ?? p.status,
		statusTone: "neutral",
		at: clockOf(p.updatedAt, now),
	};
}

// initiatives-projects-done (docs/initiatives-projects-done.md): finished projects leave the rows for their own fold.
const NO_ACTIVE = "No active projects.";
/** Over: done or dropped. */
const finished = (p: Pick<UiWorkPageRecord, "status">) => p.status === "done" || p.status === "dropped";

/** How many projects are done, of all but the dropped ones, and how many were dropped (the card's line). */
export function projectCount(list: readonly Pick<UiWorkPageRecord, "status">[]): {
	done: number;
	total: number;
	dropped: number;
} {
	const dropped = list.filter((p) => p.status === "dropped").length;
	return { done: list.filter((p) => p.status === "done").length, total: list.length - dropped, dropped };
}

/** The done and dropped projects as the fold's rows, newest first (their last recorded change). */
export function finishedProjects(list: readonly UiWorkPageRecord[]): InitiativesExactFinishedProject[] {
	return list
		.filter(finished)
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.map((p) => {
			const c = doneCount(p);
			return {
				name: p.name,
				opens: projectFrameId(p.id),
				lead: roleName(p.lead),
				state: p.status === "dropped" ? "dropped" : "done",
				at: dateOf(p.updatedAt),
				count: c.total ? `${c.done} of ${c.total} done` : "No done-when items yet",
			};
		});
}

export function buildInitiativesPage(args: InitiativesPageArgs): InitiativesPageModel {
	const { work, now, t } = args;
	const page = work.page;
	const empty: InitiativesPageModel = { input: {}, leadChats: {}, changeLead: [], sources: {} };
	if (!page) {
		const state = work.status === "error" ? "error" : "loading";
		const at = state === "error" && work.failedAt ? clockOf(work.failedAt, now) : undefined;
		return { ...empty, input: { page: { state, at } } };
	}
	const at = clockOf(page.at, now);
	if (page.problem === "unreadable") return { ...empty, input: { page: { state: "error", at } } };
	const old = page.problem === "too-big" || page.problem === "unknown-change" ? at : undefined;

	const initiatives = byStatus(page.initiatives);
	const loose = looseProjects(page);
	const ids = new Set(initiatives.map((i) => i.id));
	// initiatives-page-plan: a project's own detail (its frame in the view's `details`) can be open too.
	const frames = new Set(page.projects.map((p) => projectFrameId(p.id)));
	const pick = args.selected;
	const selected =
		pick !== undefined && (ids.has(pick) || frames.has(pick) || (pick === NO_INITIATIVE && loose.length > 0))
			? pick
			: (initiatives[0]?.id ?? (loose.length ? NO_INITIATIVE : undefined));

	const dec = args.decisions;
	const logRows = new Map((dec?.initiatives ?? []).map((r) => [r.id, r]));
	const parts: InitiativesPagePart[] = [
		planPart(page, selected, args.open),
		tasksPart(page, selected, args.open, { now, stale: work.status === "error" }),
		gapsPart(page, selected, args.open, { progress: dec?.progress, now }),
		// stall-wake (Ops #284): last, so a stall or wait line takes the row's note slot.
		stallPart(page, now),
	];
	const leadChats: Record<string, string> = {};
	const changeLead: string[] = [];
	const sources: Record<string, UiDecisionSource> = {};

	const rows = (projects: readonly UiWorkPageRecord[]): InitiativesExactRole[] =>
		projects.map((p) => {
			let row = projectRow(p, now);
			for (const part of parts) row = { ...row, ...part.projects?.[p.id] };
			return row;
		});
	const lay = (base: InitiativesExactInitiative): InitiativesExactInitiative => {
		let out = base;
		for (const part of parts) out = { ...out, ...part.initiatives?.[base.id] };
		return out;
	};

	const decision = (d: UiDecision, lead: string): InitiativesExactDecision => {
		const h = headSource(d);
		const ref = h ? `${d.id}#${d.sources.indexOf(h)}` : undefined;
		if (h && ref) sources[ref] = h;
		return {
			title: d.title,
			body: d.what,
			at: clockOf(d.at, now),
			who: h ? writerLabel(t, h) : undefined,
			how: h ? approvalLabel(t, h.approval) : undefined,
			verdict: h ? creditLabel(t, h) : undefined,
			by: h && creditKind(h) === "you" ? "you" : h?.writer === lead ? "lead" : "role",
			impact: d.impact?.text,
			options: d.options?.text,
			until: d.until?.text,
			source: h ? sourceLabel(t, h) : undefined,
			sourceRef: ref,
			quote: h?.quotes[0] ? `\u201c${h.quotes[0]}\u201d` : undefined,
			filed: filedText(t, d.filedBy, d.initiative),
		};
	};

	const initiative = (i: UiWorkPageRecord): InitiativesExactInitiative => {
		const projects = byStatus(page.projects.filter((p) => p.initiative === i.id));
		const live = projects.filter((p) => !finished(p));
		const others = [...new Set(projects.map((p) => p.lead))].filter((r) => r !== i.lead);
		const logRow = logRows.get(i.id);
		const progress = dec?.progress?.initiative === i.id ? dec.progress : undefined;
		const updates = progress?.updates ?? [];
		const decisions = dec && dec.selected === i.id ? dec.decisions : undefined;
		const chat = args.homeChats[i.lead];
		if (chat) leadChats[i.id] = chat;
		if (logRow) changeLead.push(i.id);
		return {
			id: i.id,
			name: i.name,
			status: statusOf(page, i.id),
			statusLabel: STATUS_WORD[i.status] ?? i.status,
			lead: roleName(i.lead),
			outcomeCount: doneCount(i),
			rolesLine: rolesLine(1 + others.length),
			members: others.map(roleName),
			// initiatives-page-tasks: a section's own rows after the project rows (tasks linked to the initiative itself).
			roles: [...rows(live), ...parts.flatMap((part) => part.rows?.[i.id] ?? [])],
			rowsNote: projects.length ? (live.length ? undefined : NO_ACTIVE) : "No projects in this initiative yet.",
			projectCount: projects.length ? projectCount(projects) : undefined,
			finishedProjects: finishedProjects(projects),
			// initiatives-live (H-INIT-LIVE-1): Latest updates come from every record (gaps.ts, latestOf), the lead's
			// posts among them; this note shows only when there is none.
			latestNote: logRow && !progress ? "Loading the lead's updates…" : "No updates recorded yet.",
			leadNext: updates[0]?.fields.next || undefined,
			// "Lead's report · 2h ago": the lead's newest post with its age, so it isn't read as the current state.
			leadReport: updates[0]?.fields.changed || undefined,
			leadReportAt: updates[0] ? agoOf(updates[0].at, now) : undefined,
			decisions: decisions?.map((d) => decision(d, i.lead)),
			decisionsTotal: decisions ? dec?.total : (logRow?.decisions ?? 0),
			decisionsNote: !logRow
				? "No decisions are recorded for this initiative yet."
				: !decisions
					? "Loading decisions…"
					: decisions.length === 0
						? "No decisions are recorded for this initiative yet."
						: undefined,
			canMessageLead: !!chat,
			canChangeLead: !!logRow,
			oldSince: old,
		};
	};

	// initiatives-page-plan: a project's own detail, opened from its row or its item in the box. Its row is its
	// own; what an initiative keeps (the lead's updates, decisions, hand-offs, gaps, activity) says where it shows.
	const project = (p: UiWorkPageRecord): InitiativesExactInitiative => {
		const home = initiatives.find((i) => i.id === p.initiative);
		const on = (what: string) =>
			what + " on " + (home ? `its initiative, ${home.name}.` : "\u201cProjects in no initiative\u201d.");
		return {
			id: projectFrameId(p.id),
			name: p.name,
			statusLabel: STATUS_WORD[p.status] ?? p.status,
			statusNote: home ? `Project in ${home.name}` : "Project in no initiative",
			lead: roleName(p.lead),
			outcomeCount: doneCount(p),
			rolesLine: "1 role",
			members: [],
			roles: rows([p]),
			leadNext: on("The lead\u2019s next step shows"),
			leadReport: on("The lead\u2019s reports show"),
			latestNote: on("Updates show"),
			decisions: [],
			decisionsTotal: 0,
			decisionsNote: on("Decisions show"),
			handoffsNote: on("Hand-offs show"),
			gapsNote: on("Gaps show"),
			activityNote: on("Activity shows"),
			canMessageLead: false,
			canChangeLead: false,
			oldSince: old,
		};
	};

	const looseCount = loose.reduce(
		(n, p) => {
			const c = doneCount(p);
			return { done: n.done + c.done, total: n.total + c.total };
		},
		{ done: 0, total: 0 },
	);
	const looseLeads = [...new Set(loose.map((p) => p.lead))];
	const input: InitiativesExactInput = {
		page: { state: work.status === "error" ? "stale" : "live", at, date: dateOf(page.at) },
		initiatives: initiatives.map((i) => lay(initiative(i))),
		selected,
		loose: loose.length
			? {
					heading: "Projects in no initiative · " + loose.length,
					items: loose.map((p) => {
						const c = doneCount(p);
						const stall = stallLine(p, now);
						let item: InitiativesExactLooseItem = {
							id: p.id,
							name: p.name,
							opens: projectFrameId(p.id),
							note:
								`Lead · ${roleName(p.lead)} · ${c.done} of ${c.total} done · ${STATUS_WORD[p.status] ?? p.status}` +
								(stall ? ` · ${stall}` : ""),
						};
						// initiatives-page-tasks: a section's fields for the item (ON YOU when one of its tasks asks).
						for (const part of parts) item = { ...item, ...part.loose?.[p.id] };
						return item;
					}),
					detail: lay({
						id: NO_INITIATIVE,
						name: "Projects in no initiative",
						statusLabel: "No initiative",
						leadName: "No one",
						outcomeCount: looseCount,
						rolesLine: looseLeads.length === 1 ? "1 role" : `${looseLeads.length} roles`,
						roles: rows(loose.filter((p) => !finished(p))),
						rowsNote: loose.some((p) => !finished(p)) ? undefined : NO_ACTIVE,
						finishedProjects: finishedProjects(loose),
						leadNext: "These projects serve no initiative, so no lead plans across them.",
						leadReport: "No lead, so no reports.",
						latestNote: "No lead, so no updates.",
						decisions: [],
						decisionsTotal: 0,
						decisionsNote: "Decisions are kept by initiative; these projects are in none.",
						canMessageLead: false,
						canChangeLead: false,
						oldSince: old,
					}),
				}
			: undefined,
		details: page.projects.map((p) => lay(project(p))),
	};
	for (const part of parts) Object.assign(input, part.page);
	return { input, selected, leadChats, changeLead, sources };
}
