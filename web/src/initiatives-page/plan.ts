// initiatives-page, step 2's module (Ops #226, docs/initiatives-page-plan.md): each initiative's and project's
// goal, the day it started and its done-when items, from the work registry, in the design's own sections.
// A met item is done on the day it was marked, with its proof and who marked it. An open item's steps are the
// open projects working toward it, and never a done step, so only met items count as done. The "in no
// initiative" box has no goal or items of its own: each of its projects opens with its own (projectFrameId).
import type {
	InitiativesExactInitiative,
	InitiativesExactOutcome,
	InitiativesExactStep,
} from "../initiatives-exact-model";
import { roleName } from "../initiatives-view-model";
import type { UiWorkPage, UiWorkPageRecord } from "../types";
import { dateOf, doneCount } from "./model";
import { NO_INITIATIVE, projectFrameId, type InitiativesPageOpen, type InitiativesPagePart } from "./types";

type Plan = Partial<InitiativesExactInitiative>;

/** Who marked an item met: "you" for the owner, else the role. */
const markedBy = (by: string) => "Marked by " + (by === "owner" ? "you" : roleName(by));

/** A project as a step of an open item: its name, and how many of its own items are met. */
function projectStep(p: UiWorkPageRecord): InitiativesExactStep {
	const c = doneCount(p);
	return {
		label: p.status === "active" ? p.name : `${p.name} (${p.status})`,
		kind: p.status === "active" ? "active" : "pending",
		at: c.total ? `${c.done} of ${c.total} done` : "No done-when items yet",
	};
}

/** One done-when item. Met: done on the day it was marked, its proof as its one step. Open: `open` as its steps. */
function outcome(
	d: UiWorkPageRecord["doneWhen"][number],
	lead: string,
	open: InitiativesExactStep[],
): InitiativesExactOutcome {
	if (!d.met) return { title: d.item, owner: roleName(lead) + " (lead)", steps: open };
	return {
		title: d.item,
		owner: markedBy(d.met.by),
		steps: [{ label: "Proof: " + d.met.proof, kind: "done", at: dateOf(d.met.at) }],
	};
}

/** A record's goal, start day and done-when items, in the registry's order; `open` are its open items' steps. */
function planOf(r: UiWorkPageRecord, open: InitiativesExactStep[]): Plan {
	const goal = r.outcome.trim();
	return {
		...(goal ? { goal } : {}),
		started: dateOf(r.createdAt),
		...(r.doneWhen.length
			? { outcomes: r.doneWhen.map((d) => outcome(d, r.lead, open)) }
			: { outcomesNote: "No done-when items recorded yet." }),
	};
}

export function planPart(
	page: UiWorkPage,
	_selected: string | undefined,
	_open: InitiativesPageOpen,
): InitiativesPagePart {
	const out: Record<string, Plan> = {};
	for (const i of page.initiatives) {
		const projects = page.projects.filter((p) => p.initiative === i.id);
		const active = projects.filter((p) => p.status === "active");
		const open: InitiativesExactStep[] = active.length
			? active.map(projectStep)
			: [{ label: projects.length ? "No open project" : "No project yet", kind: "pending" }];
		out[i.id] = planOf(i, open);
	}
	// A project's own items: the project itself is the one working toward each open one.
	for (const p of page.projects) out[projectFrameId(p.id)] = planOf(p, [projectStep(p)]);
	const ids = new Set(page.initiatives.map((i) => i.id));
	if (page.projects.some((p) => !p.initiative || !ids.has(p.initiative)))
		out[NO_INITIATIVE] = {
			goal: "Each project here has its own goal: open one to see it.",
			started: "Each project\u2019s own",
			outcomesNote: "Each project\u2019s done-when items show when you open it.",
		};
	return { initiatives: out };
}
