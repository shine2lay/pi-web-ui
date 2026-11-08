/** Display-only facts from an already replayed queue. Never parse plans or change the queue. */
import { clipText } from "./live-progress.js";
import type {
	UiRoleQueue,
	UiRoleTask,
	UiRoleTaskNext,
	UiRoleTaskOwing,
	UiTaskEvidence,
	UiTaskParent,
	UiTaskQueueHold,
	UiTaskQueueTask,
} from "./protocol.js";
import { requesterOf } from "./queue-requester.js";
import {
	collectDependsOnRefs,
	type QueuesByRoleInput,
	resolveBlockedState,
	resolveQueuedDetail,
	resolveTaskDeps,
	resolveWaitState,
} from "./shared/task-blocker-resolver.js";
import {
	computeGroupRollup,
	computeTagGroups,
	computeTouchSystems,
	type DeployStateSnapshots,
	resolveTaskLifecycleAndDelivery,
} from "./shared/task-delivery-resolver.js";
import { normalizeTouches } from "./shared/touch-normalizer.js";
import { taskRefLabel } from "./task-queue.js";

export {
	collectDependsOnRefs,
	computeGroupRollup,
	computeTagGroups,
	computeTouchSystems,
	resolveBlockedState,
	resolveQueuedDetail,
	resolveTaskDeps,
	resolveTaskLifecycleAndDelivery,
	resolveWaitState,
};

type Display = Pick<UiRoleTask, "next" | "queueEvent">;

export function roleTaskNext(t: UiTaskQueueTask, department: string, held?: UiTaskQueueHold): Display {
	if (held && t.status !== "done" && t.status !== "dropped")
		return { next: { kind: "resume", who: "owner" }, queueEvent: { kind: "paused", at: held.at } };
	const event = (kind: NonNullable<UiRoleTask["queueEvent"]>["kind"], at?: number) => ({
		kind,
		...(at !== undefined ? { at } : {}),
	});
	switch (t.status) {
		case "ready": {
			const after = [
				...(t.waitingFor ?? []).map((id) => `#${id}`),
				...(t.outside ?? []).filter((r) => !r.over).map(taskRefLabel),
			];
			return {
				next: { kind: "queue", ...(after.length ? { after: [...new Set(after)].slice(0, 40) } : {}) },
				queueEvent: event("added", t.addedAt),
			};
		}
		case "waiting":
			return {
				next: {
					kind: "check",
					...(t.wait ? { what: t.wait.what, everyMs: t.wait.everyMs, until: t.wait.until } : {}),
				},
				queueEvent: event("waiting", t.wait?.since),
			};
		case "blocked": {
			const b = t.block;
			const next: UiRoleTaskNext = { kind: "blocked" };
			if (b?.lead) next.who = b.lead;
			if (b?.owes || b?.need) next.what = b.owes || b.need;
			if (b?.checkpoint !== undefined) next.until = b.checkpoint;
			if (b?.on?.length) next.after = b.on.slice(0, 20).map(taskRefLabel);
			return { next, queueEvent: event("blocked", b?.since) };
		}
		case "asking":
			return {
				next: { kind: "answer", who: t.askOps ? (t.askLead ?? "ops") : department },
				queueEvent: event("answer"),
			};
		case "stuck":
			return { next: { kind: "answer", who: "owner" }, queueEvent: event("answer") };
		case "working":
			return { next: { kind: "unrecorded" }, queueEvent: event("started", t.startedAt) };
		case "done":
			return { next: { kind: "none" }, queueEvent: event("done", t.doneAt) };
		case "dropped":
			return { next: { kind: "none" }, queueEvent: event("dropped", t.dropped?.at) };
	}
}

// A task's whole row on the Roles page (moved here from roles-overview.ts, Backend #15).

/** roles-links (Ops #222): which count an open task goes into: the parent its queue entry names, as its row
 *  shows it (taskOf's parent); none recorded = unrecorded. */
export function linkOf(parent: UiTaskParent | undefined): keyof NonNullable<UiRoleQueue["links"]> {
	if (!parent) return "unrecorded";
	if ("project" in parent) return "project";
	if ("initiative" in parent) return "initiative";
	return "standalone";
}

export interface TaskOfOptions {
	queuesByRole?: QueuesByRoleInput;
	queueRunning?: boolean;
	queueHold?: UiTaskQueueHold;
	lanesAtOnce?: number;
	queueTasks?: readonly UiTaskQueueTask[];
	deploySnapshots?: DeployStateSnapshots;
	evidence?: UiTaskEvidence;
	withLead?: string;
	now?: number;
}

export function taskOf(
	t: UiTaskQueueTask,
	department: string,
	held?: UiTaskQueueHold,
	options?: TaskOfOptions,
): UiRoleTask {
	const now = options?.now ?? Date.now();
	const display = roleTaskNext(t, department, held);
	const requester = requesterOf(t.origin);
	const queued = t.status === "ready" ? roleTaskNext(t, department).next : undefined;
	let waitsOn: string | undefined;
	if (t.status === "waiting" && t.wait?.what) waitsOn = t.wait.what;
	else if (t.status === "blocked" && t.block) {
		const on = (t.block.on ?? []).map((r) => taskRefLabel(r)).join(", ");
		waitsOn = [on, t.block.need].filter(Boolean).join("; ") || undefined;
	} else if (queued?.after?.length) waitsOn = queued.after.join(", ");

	const normalizedTouches = t.touches?.length ? normalizeTouches(t.touches) : undefined;
	const wait = t.status === "waiting" && t.wait ? resolveWaitState(t.wait, now) : undefined;
	const blockedRes =
		t.status === "blocked" && t.block
			? resolveBlockedState(t.block, {
					currentRole: department,
					currentTaskId: t.id,
					queuesByRole: options?.queuesByRole,
					now,
				})
			: undefined;
	const queuedRes =
		t.status === "ready"
			? resolveQueuedDetail(t, {
					currentRole: department,
					queueRunning: options?.queueRunning,
					lanesAtOnce: options?.lanesAtOnce,
					queueTasks: options?.queueTasks,
					queuesByRole: options?.queuesByRole,
				})
			: undefined;

	const dependsOnRefs = collectDependsOnRefs(department, t.block?.on, t.after, t.outside);
	const afterList: (number | string)[] = [...(t.after ?? []), ...(t.outside ?? []).map((r) => taskRefLabel(r))];

	const evidenceSummary = options?.evidence
		? {
				repo: options.evidence.repo,
				commit: options.evidence.commit,
				checkedAt: "at" in options.evidence.checked ? options.evidence.checked.at : undefined,
				installedAt: "at" in options.evidence.installed ? options.evidence.installed.at : undefined,
				live: "at" in options.evidence.live,
			}
		: undefined;

	const effectiveStatus = t.status === "stuck" && options?.withLead ? "asking" : t.status;

	const { lifecycleStatus, statusTone, delivery } = resolveTaskLifecycleAndDelivery(
		{
			id: t.id,
			role: department,
			status: effectiveStatus,
			paused: held,
			touches: t.touches,
			normalizedTouches,
			doneSummary: t.summary,
			delivery: t.delivery,
			wait: wait ?? t.wait,
		},
		{
			...options?.deploySnapshots,
			role: department,
			queueRunning: options?.queueRunning,
			queuePaused: Boolean(options?.queueHold),
			waitOverdue: wait?.overdue,
			hasUpstreamDeadlock: queuedRes?.hasUpstreamDeadlock,
			evidence: evidenceSummary,
		},
	);

	let howToUnblock: string | undefined;
	if (lifecycleStatus === "paused") {
		howToUnblock = t.hold
			? `How to unblock: Resume paused task ${department ? `${department} ` : ""}#${t.id}`
			: `How to unblock: Resume ${department ? `${department}'s` : "the"} paused queue`;
	} else if (lifecycleStatus === "stuck") {
		howToUnblock = `How to unblock: Answer ${department ? `${department} ` : ""}#${t.id}'s owner question`;
	} else if (lifecycleStatus === "asking") {
		const decider = options?.withLead ?? (t.askOps ? (t.askLead ?? "ops") : department);
		howToUnblock = `How to unblock: Have ${decider} lead answer ${department ? `${department} ` : ""}#${t.id}'s question`;
	} else if (lifecycleStatus === "blocked" && blockedRes) {
		howToUnblock = blockedRes.blocked.howToUnblock;
	} else if (lifecycleStatus === "waiting" && wait) {
		howToUnblock = wait.howToUnblock;
	} else if (lifecycleStatus === "queued" && queuedRes?.howToUnblock) {
		howToUnblock = queuedRes.howToUnblock;
	}

	const updatedAt = Math.max(
		t.doneAt ?? 0,
		t.dropped?.at ?? 0,
		t.block?.since ?? 0,
		t.wait?.since ?? 0,
		t.startedAt ?? 0,
		t.addedAt ?? 0,
	);

	const stuckDetail =
		(t.status === "stuck" || t.status === "asking") && t.question
			? {
					question: t.question,
					...(t.choices?.length ? { choices: [...t.choices] } : {}),
					sinceAt: t.startedAt ?? t.addedAt,
					tier: (effectiveStatus === "stuck" ? "owner" : "lead") as "lead" | "owner",
				}
			: undefined;

	return {
		id: t.id,
		...(department ? { role: department } : {}),
		status: t.status,
		lifecycleStatus,
		statusTone,
		...(howToUnblock ? { howToUnblock } : {}),
		...(dependsOnRefs ? { dependsOnRefs } : {}),
		title: t.plan.title,
		...display,
		...(requester ? { requester } : {}),
		...(t.chat ? { chat: { file: t.chat.file, ...(t.chat.title ? { title: t.chat.title } : {}) } } : {}),
		...(t.status === "dropped" && t.dropped ? { dropped: { why: t.dropped.why, at: t.dropped.at } } : {}),
		...(waitsOn ? { waitsOn } : {}),
		...(t.status === "asking" && t.askOps ? { askOps: true, ...(t.askLead ? { askLead: t.askLead } : {}) } : {}),
		...(held ? { paused: { at: held.at, why: held.why } } : {}),
		// roles-panel: where it belongs (its queue entry), and a lead block's who, what, when and reminders.
		...(t.parent ? { parent: { ...t.parent } } : {}),
		...(t.parent && "initiative" in t.parent ? { initiative: t.parent.initiative } : {}),
		...(t.parent && "project" in t.parent ? { project: t.parent.project } : {}),
		...(t.parent && "standalone" in t.parent ? { standalone: true } : {}),
		...(t.tags?.length ? { tags: [...t.tags] } : {}),
		...(t.touches?.length ? { touches: [...t.touches] } : {}),
		...(normalizedTouches?.length ? { normalizedTouches } : {}),
		createdAt: t.addedAt,
		...(t.startedAt !== undefined ? { startedAt: t.startedAt } : {}),
		...(t.doneAt !== undefined ? { finishedAt: t.doneAt } : {}),
		updatedAt,
		...(t.origin ? { origin: t.origin } : {}),
		...(t.plan.goal ? { goal: t.plan.goal } : {}),
		...(t.summary ? { doneSummary: clipText(t.summary) } : {}),
		...(delivery ? { delivery } : {}),
		...(wait ? { wait } : {}),
		...(blockedRes ? { blocked: blockedRes.blocked } : {}),
		...(stuckDetail ? { stuck: stuckDetail } : {}),
		...(afterList.length ? { after: afterList } : {}),
		...(queuedRes ? { queuedDetail: queuedRes.queuedDetail } : {}),
		...(t.status === "blocked" && t.block?.lead ? { owing: owingOf(t.block, t.block.lead) } : {}),
		// dead-end (Ops #483): a block the queue let go; the task comes back to work next.
		...(t.status === "blocked" && t.block?.poke ? { poked: t.block.poke.at } : {}),
	};
}

/** roles-panel: a blocked task's lead block as the Roles page shows it. */
function owingOf(b: NonNullable<UiTaskQueueTask["block"]>, lead: string): UiRoleTaskOwing {
	return {
		lead,
		...(b.owes ? { owes: b.owes } : {}),
		...(b.checkpoint ? { due: b.checkpoint } : {}),
		reminders: b.reminders?.length ?? 0,
		// Recorded ([] too: then the owner is next); absent until the queue's chat records it.
		...(b.chain ? { chain: [...b.chain] } : {}),
	};
}
