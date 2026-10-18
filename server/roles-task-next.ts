/** Display-only facts from an already replayed queue. Never parse plans or change the queue. */
import type { UiRoleTask, UiRoleTaskNext, UiTaskQueueHold, UiTaskQueueTask } from "./protocol.js";
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
