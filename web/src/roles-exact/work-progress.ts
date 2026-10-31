/** The lines of a department's "Work progress": its Current task, Latest progress and next step, its task lanes,
 *  linked work and completion evidence. The card shows some of them; its panel's Work progress tab shows all. */
import { NR, exactWhen } from "../roles-exact-model";
import type { PanelTask, PanelTaskEvent } from "../roles-panel-model";
import type { UsefulLinks, UsefulRecord } from "../roles-useful-model";
import { EVIDENCE_STEPS, type UsefulEvidence } from "../roles-useful-model";

/** roles-evidence: the supplied design's evidence styles (its EV map): done, not yet; plus the page's
 *  missing-data style for a step with no record or not tracked for the repo. */
const EV_DONE = { fg: "#9FD8B8", bg: "rgba(159,216,184,0.08)", bd: "#2F4A3C", bs: "solid" };
const EV_PENDING = { fg: "#A9AEB6", bg: "transparent", bd: "#3A3F46", bs: "dashed" };
const EV_MISSING = { fg: "#C7B8FF", bg: "transparent", bd: "rgba(199,184,255,0.5)", bs: "dashed" };

/** roles-evidence (task #207): the Completion evidence row for a task: each step's time, "not yet", "Not
 *  recorded" (no record links it to a branch, or no task), or "Not tracked for <repo>". */
export function exactEvidence(
	evidence: UsefulEvidence | undefined,
	now: number,
): { label: string; at: string; fg: string; bg: string; bd: string; bs: string }[] {
	return EVIDENCE_STEPS.map((label, i) => {
		const step = evidence?.steps[i];
		if (step && "at" in step) return { label, at: exactWhen(step.at, now), ...EV_DONE };
		if (step?.not === "yet") return { label, at: "not yet", ...EV_PENDING };
		if (step?.not === "tracked")
			return { label, at: evidence?.repo ? `Not tracked for ${evidence.repo}` : "Not tracked", ...EV_MISSING };
		return { label, at: NR, ...EV_MISSING };
	});
}
/** roles-lanes: the supplied design's lane pills (its LS map): a lane in use is "working", a free one "free". */
const LANE_BUSY = { bg: "#7DB8FF", bd: "#7DB8FF", bs: "solid" };
const LANE_IDLE = { bg: "transparent", bd: "#4A4F57", bs: "solid" };

/** roles-links (Ops #222): the panel's Linked work line, like "5 in projects · 1 under an initiative · 2 standalone
 *  · 3 not recorded" with zero parts left out; "No open tasks" when there are none; not recorded without a
 *  readable queue's counts (an older server, or a queue that couldn't be read). */
export function exactLinks(links: UsefulLinks | null | undefined): string {
	if (!links) return NR;
	const parts: [number, string][] = [
		[links.project, links.project === 1 ? "1 in a project" : `${links.project} in projects`],
		[links.initiative, links.initiative === 1 ? "1 under an initiative" : `${links.initiative} under initiatives`],
		[links.standalone, `${links.standalone} standalone`],
		[links.unrecorded, `${links.unrecorded} not recorded`],
	];
	const shown = parts.filter(([n]) => n > 0).map(([, text]) => text);
	return shown.length ? shown.join(" · ") : "No open tasks";
}
/** roles-lanes: a card's lane pills and sentence; not recorded without a readable queue's lanes. */
export function exactLanes(lanes: { atOnce: number; inUse: number } | null | undefined): {
	lanes: { bg: string; bd: string; bs: string }[];
	lanesText: string;
	lanesLabel: string;
} {
	if (!lanes) return { lanes: [], lanesText: NR, lanesLabel: "Task-lane occupancy is not recorded" };
	const text = `${lanes.inUse} of ${lanes.atOnce} ${lanes.atOnce === 1 ? "lane" : "lanes"} in use`;
	return {
		lanes: Array.from({ length: lanes.atOnce }, (_, i) => (i < lanes.inUse ? LANE_BUSY : LANE_IDLE)),
		lanesText: text,
		lanesLabel: text,
	};
}
/** Fixed language around checked queue fields; no inferred plan steps or imperative actions. */
export function nextText(task: PanelTask | undefined): string {
	// roles-live (Ops #272): a question still with a lead says so; it isn't waiting on the owner.
	const withLead = task?.withLead;
	if (withLead && withLead.kind !== "owner")
		return `Question with ${withLead.kind === "role" ? withLead.label : withLead.id}`;
	const next = task?.next;
	if (!next) return NR;
	const actor =
		next.who?.kind === "owner"
			? "you"
			: next.who?.kind === "role"
				? next.who.label
				: next.who?.kind === "other"
					? next.who.id
					: null;
	const due = next.until === null ? "" : ` · checkpoint ${new Date(next.until).toLocaleString("en-US")}`;
	switch (next.kind) {
		case "queue":
			return next.after.length
				? `Waiting for tasks: ${next.after.join(", ")}`
				: "Queued; starts when the queue can run it";
		case "check":
			return `${next.what ? `Recorded wait: ${next.what}` : "Waiting for its recorded check"}${next.everyMs === null ? "" : ` · checked every ${next.everyMs / 60_000} min`}${next.until === null ? "" : ` · until ${new Date(next.until).toLocaleString("en-US")}`}`;
		case "blocked":
			return `${actor ? `Waiting for ${actor}` : "Waiting on a recorded blocker"}${next.what ? ` — ${next.what}` : ""}${next.after.length ? ` · tasks ${next.after.join(", ")}` : ""}${due}`;
		case "answer":
			return actor === "you" ? "Awaiting your answer" : `Awaiting ${actor ?? "the recorded lead"} to answer`;
		case "resume":
			return "Paused by you; awaits your resume";
		case "unrecorded":
			return "Next step not recorded";
		case "none":
			return "No next action: task ended";
	}
}
const QUEUE_EVENT: Record<PanelTaskEvent["kind"], string> = {
	added: "Queue recorded: task added",
	started: "Queue recorded: task started",
	waiting: "Queue recorded: waiting for a check",
	blocked: "Queue recorded: blocked",
	answer: "Queue status: awaiting an answer",
	paused: "Queue recorded: paused by you",
	done: "Queue recorded: task completed",
	dropped: "Queue recorded: task dropped",
};
/**
 * roles-live (Ops #272, docs/live-progress.md): a card's Latest progress for its current task: the newer of its
 * own chat's newest line and its queue milestone, with that one's time; the line when neither has a time.
 */
export function exactProgress(
	task: UsefulRecord,
	event: PanelTaskEvent | undefined,
): { text: string; at: number | null } | null {
	const line = task.latest ? { text: task.latest, at: task.latestAt ?? null } : null;
	const milestone = event ? { text: QUEUE_EVENT[event.kind], at: event.at } : null;
	if (line && milestone && milestone.at !== null && (line.at === null || milestone.at > line.at)) return milestone;
	return line ?? milestone;
}
/**
 * roles-current-task (Ops #277, docs/live-progress.md H-ROLES-CURRENT-1): the task a role's card and panel name as its
 * Current task: the busy one (its chat is at work now); else a started task that isn't paused; else any task that
 * isn't paused; else the first (all paused: still shown, with its paused wording). Queue order among equals.
 * It was the busy one, else the first in queue order: between turns a paused task stood in front of the working ones.
 */
export function currentTask(records: readonly UsefulRecord[]): UsefulRecord | undefined {
	const unpaused = (t: UsefulRecord) => t.pause !== "reported-paused";
	return (
		records.find((t) => t.busy) ??
		records.find((t) => t.state === "working" && unpaused(t)) ??
		records.find(unpaused) ??
		records[0]
	);
}
