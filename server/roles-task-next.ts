/** Display-only facts from an already replayed queue. Never parse plans or change the queue. */
import type {
	UiRoleQueue,
	UiRoleTask,
	UiRoleTaskNext,
	UiRoleTaskOwing,
	UiTaskParent,
	UiTaskQueueHold,
	UiTaskQueueTask,
} from "./protocol.js";
import { requesterOf } from "./queue-requester.js";
import { taskRefLabel } from "./task-queue.js";

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

export function taskOf(t: UiTaskQueueTask, department: string, held?: UiTaskQueueHold): UiRoleTask {
	const display = roleTaskNext(t, department, held);
	const requester = requesterOf(t.origin);
	const queued = t.status === "ready" ? roleTaskNext(t, department).next : undefined;
	let waitsOn: string | undefined;
	if (t.status === "waiting" && t.wait?.what) waitsOn = t.wait.what;
	else if (t.status === "blocked" && t.block) {
		const on = (t.block.on ?? []).map((r) => taskRefLabel(r)).join(", ");
		waitsOn = [on, t.block.need].filter(Boolean).join("; ") || undefined;
	} else if (queued?.after?.length) waitsOn = queued.after.join(", ");
	return {
		id: t.id,
		status: t.status,
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
