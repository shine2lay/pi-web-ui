/** A department's card on the ring and the panel it grows into: its state, current task, lanes and budget line on
 *  the card; the Work progress and Configuration tabs, the owner's asks and messages, initiatives and spending in the
 *  panel. */
import { NR, exactClock, exactWhen, type ExactRole, type ExactRoles } from "../roles-exact-model";
import { CONFIG_NOT_RECORDED, configHistoryActs } from "../roles-config-history";
import type { PanelRoleStatus } from "../roles-panel-model";
import { panelActivity, panelTasks } from "../roles-panel-model";
import type { SurfaceValues } from "../roles-u0/types";
import type { RowState, UsefulRecord } from "../roles-useful-model";
import { instructionsOf } from "./instructions";
import { askValues } from "./owner-asks";
import { contactValues } from "./owner-contacts";
import { exactSentText, exactWaitingOn } from "./sent-requests";
import { exactCardSpend } from "./spending";
import type { ExactViewState } from "./view-state";
import { currentTask, exactEvidence, exactLanes, exactLinks, exactProgress, nextText } from "./work-progress";

const ROLE_STATE: Record<PanelRoleStatus, string> = {
	"needs-you": "waiting",
	busy: "working",
	paused: "paused",
	idle: "idle",
	"nothing-yet": "unknown",
	unknown: "unknown",
};
const GROUPS: readonly [string, string, readonly RowState[]][] = [
	["Running", "#7DB8FF", ["working", "asking", "asking-main", "asking-ops", "asking-lead"]],
	["Ready to start", "#D6D9DD", ["ready"]],
	["Waiting on something", "#F0B95A", ["ready-after", "blocked", "needs-decision", "on-hold"]],
	["Other reported tasks", "#C7B8FF", ["unknown"]],
	["Completed (latest)", "#9FD8B8", ["done"]],
];

function count(n: number | string): string {
	return typeof n === "number" ? String(n) : "Unknown";
}
function taskTitle(task: UsefulRecord | undefined): string {
	return task ? (task.name ?? `Task #${task.taskId}`) : NR;
}

export function departmentValues(role: ExactRole, model: ExactRoles, view: ExactViewState): SurfaceValues {
	const { hover, tab } = view;
	const { row, panel, spend } = role;
	const tasks = [...row.active.records, ...row.queued.records];
	const lead = currentTask(row.active.records);
	const state = ROLE_STATE[panel?.status ?? "unknown"];
	const questions = model.needs.items.filter((item) => item.roleId === row.roleId);
	const roleContacts = (model.contacts ?? []).filter((c) => c.role === row.roleId);
	const onYou = model.needs.tell === "can-tell" && (panel?.status === "needs-you" || questions.length > 0);
	// roles-sent: who it waits on, and (the design's hover) a card linked to the hovered one by an open pair.
	const relText = exactWaitingOn(model, row.roleId);
	const linked =
		!!hover &&
		hover !== row.roleId &&
		(model.pairs ?? []).some(
			(p) => (p.from === hover && p.to === row.roleId) || (p.from === row.roleId && p.to === hover),
		);
	const blocked = tasks.find((t) => t.waitsOn !== null);
	const openTasks = panel ? panelTasks(panel) : [];
	const ownTask = lead ? openTasks.find((t) => t.taskId === lead.taskId) : undefined;
	const progress = lead ? exactProgress(lead, ownTask?.queueEvent) : null;
	const rowDetail = (task: UsefulRecord) => {
		const detail = openTasks.find((t) => t.taskId === task.taskId);
		const next = nextText(detail);
		return {
			srcText: detail?.requester ? `From ${detail.requester}` : NR,
			srcFg: detail?.requester ? "#9CC7FF" : "#A9AEB6",
			hasDep: next === NR && !!task.waitsOn,
			dep: task.waitsOn ?? "",
			hasNext: next !== NR,
			nextText: next === NR ? "" : next,
		};
	};
	const owing = blocked ? openTasks.find((t) => t.taskId === blocked.taskId)?.owing : null;
	const resolver =
		owing?.lead?.kind === "role"
			? owing.lead.label
			: owing?.lead?.kind === "owner"
				? "You"
				: owing?.lead?.kind === "other"
					? owing.lead.id
					: NR;
	const lines = panel?.lines ?? [];
	// roles-config-history (Ops #209): Config lists the recorded settings changes, newest first.
	// roles-live (Ops #272): Activity merges the task lines and the done summaries, newest first.
	const acts =
		tab === "work"
			? (panel ? panelActivity(panel) : []).map((l) => ({ at: exactClock(l.at), text: l.text }))
			: configHistoryActs(role.configHistory, (at) => exactWhen(at, model.now));
	const omittedTasks =
		typeof row.counts.active === "number" && typeof row.counts.queued === "number"
			? Math.max(0, row.counts.active + row.counts.queued - tasks.length)
			: null;
	// roles-small-fixes N3: counts both cuts (20 active, 20 queued), in plain words for one task too.
	const taskOmission = omittedTasks
		? `${omittedTasks} more ${omittedTasks === 1 ? "task" : "tasks"} not shown here. Open the full queue.`
		: row.active.notAllShown || row.queued.notAllShown
			? "Some tasks could not be shown. Open the full queue."
			: "";
	return {
		id: row.roleId,
		name: row.roleLabel,
		state,
		onYou,
		ownPaused: false,
		hasRel: relText !== "",
		relText,
		...exactLanes(row.lanes),
		// roles-budget-card: a reported role's own-work budget line on its card; spending first in its panel.
		...exactCardSpend(spend, row.roleLabel, model.lastReceived, !!role.usageCost),
		// roles-links: the panel's Linked work line only; the cards stay as designed.
		linksText: exactLinks(row.links),
		op: hover && hover !== row.roleId && !linked ? "0.38" : model.lastReceived ? "0.8" : "1",
		bdNow: hover === row.roleId ? "#9CC7FF" : linked ? "#3D5A80" : onYou ? "#6B5426" : "#2A2E34",
		hoverOn: (e: Event | Element) => view.spotlight(row.roleId, e),
		expand: (e: Event | Element) => view.openRole(row.roleId, e),
		glance: lead ? `#${lead.taskId} ${taskTitle(lead)}` : "Current task not recorded",
		modeLabel:
			panel?.workMode === "self-start"
				? "Starts own work"
				: panel?.workMode === "request-only"
					? "Starts work when asked"
					: "Work mode unknown",
		taskId: lead ? `#${lead.taskId}` : "",
		taskTitle: taskTitle(lead),
		taskSrc: ownTask?.requester ? `· From ${ownTask.requester}` : "· requester not recorded",
		taskSrcFg: ownTask?.requester ? "#9CC7FF" : "#A9AEB6",
		progressText: lead ? (progress?.text ?? NR) : (lines[0]?.text ?? NR),
		progressAt: lead ? exactClock(progress?.at ?? null) : exactClock(lines[0]?.ts ?? null),
		nextShort: nextText(ownTask),
		mix: "Reported status",
		updated: exactClock(lines[0]?.ts ?? null),
		outText: exactSentText(panel?.sent, model.now),
		reqInText: panel?.requests.open === null || panel?.requests.open === undefined ? NR : `${panel.requests.open} open`,
		hasBlocker: !!blocked,
		blocker: { waitingFor: blocked?.waitsOn ?? NR, resolver, check: exactClock(owing?.due ?? null) },
		boxBg: "#1B1912",
		boxBd: "#4D3F1F",
		boxFg: "#F0B95A",
		boxTitle: "What it’s waiting on",
		hasEvidence: true,
		ev: exactEvidence(lead?.evidence, model.now),
		queueText: `${count(row.counts.active)} active · ${count(row.counts.queued)} queued · ${count(row.counts.done)} done`,
		hasTaskOmission: !!taskOmission,
		taskOmission,
		chatHref: "#exact-route:home",
		queueHref: "#exact-route:queue",
		...instructionsOf(role.instructions, model.now),
		// roles-model: the home chat's model as its header names it.
		model: row.model ?? NR,
		purpose: panel?.focus ?? NR,
		respList: (panel?.goals ?? []).map((g) => ({ t: `Goal: ${g.name ?? NR}${g.scope ? ` — ${g.scope}` : ""}` })),
		hasBudgetNote: true,
		budgetNote: `${model.lastReceived ? "Last received data. " : ""}${role.usageCost?.lines.join(" · ") ?? "Automatic usage unavailable; funding not evaluated; UNKNOWN — no certified budget remainder."} · Manual tally — stale/unverified reference only. ${spend.note}`,
		taskGroups: [
			...GROUPS.map(([label, fg, states]) => ({
				label,
				fg,
				items: tasks
					.filter((t) => t.pause !== "reported-paused" && states.includes(t.state))
					.map((t) => ({
						id: `#${t.taskId}`,
						title: taskTitle(t),
						...rowDetail(t),
					})),
			})),
			{
				label: "Paused by you",
				fg: "#B9BEC5",
				items: tasks
					.filter((t) => t.pause === "reported-paused")
					.map((t) => ({
						id: `#${t.taskId}`,
						title: taskTitle(t),
						...rowDetail(t),
					})),
			},
		].filter((g) => g.items.length > 0),
		acts: acts.length
			? acts
			: [
					{
						at: "",
						text: tab === "config" ? CONFIG_NOT_RECORDED : "No progress text is available in this snapshot.",
					},
				],
		actsEmpty: false,
		inits: (panel?.leads.initiatives ?? []).map((i) => ({
			name: i.name ?? i.id,
			status: i.status ?? "Unknown",
			fg: "#C7B8FF",
			goal: "",
			tasksText: i.items === null || i.met === null ? NR : `${i.met} of ${i.items} outcome checks met`,
		})),
		initEmpty: false,
		hasRegistryNote: panel?.work !== "ok" || panel.leads.initiatives.length === 0,
		registryNote:
			panel?.work === "ok" || panel?.work === "none"
				? "No led initiatives in the received registry."
				: "The initiative registry is unavailable in this snapshot.",
		initCount:
			panel?.work === "ok" || panel?.work === "none" ? `${panel.leads.initiatives.length} led initiatives` : NR,
		spend: { own: spend.reported ? `${spend.amount} of ${spend.budget}` : NR, req: NR },
		decisions: questions.map((item) => askValues(item, model, view)),
		hasDecisions: questions.length > 0,
		questions: roleContacts.slice(0, 8).map((c) => contactValues(c, model, view)),
		hasQuestions: model.contacts === null || roleContacts.length > 0,
		missingContacts: model.contacts === null,
	};
}
