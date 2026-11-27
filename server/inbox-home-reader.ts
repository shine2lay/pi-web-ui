import { createHash } from "node:crypto";
export { readRoleMessagesSource as readHomeMessages } from "./role-messages-source.js";
import type { RoleMessageRecord } from "./role-messages.js";
import type { InboxRuntimePorts } from "./inbox-runtime.js";
import type { InboxClass, InboxLine, InboxPriority, InboxView } from "./shared/inbox-wire.js";

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([k, v]) => [k, canonical(v)]),
		);
	return value;
}
export function inboxDigest(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(value)))
		.digest("hex");
}
function classification(
	r: RoleMessageRecord,
	records: RoleMessageRecord[],
	ports: InboxRuntimePorts,
): Pick<InboxView, "class" | "basePriority" | "route" | "reason"> {
	const out = (cls: InboxClass, base: InboxPriority, route: InboxView["route"], rule: string) => ({
		class: cls,
		basePriority: base,
		route,
		reason: `R-RPI-${rule}`,
	});
	if (r.kind === "report" ? r.script?.kind === "fyi" : r.kind === "fyi" && r.guard?.phase !== "decision")
		return out("passive", "P3", "home_only", "PRI-5");
	if ((r.kind === "report" && r.stall) || (r.kind === "fyi" && r.guard?.phase === "decision"))
		return out("turn_required", "P1", "home_only", "PRI-6");
	if (r.ci || r.script?.kind === "request") return out("turn_required", "P2", "home_only", "PRI-6");
	if (r.kind === "reply") {
		const original = records.find((m) => m.id === r.replyTo);
		return out("turn_required", original?.forOwner ? "P0" : "P2", "home_only", original ? "PRI-7" : "ROUTE-3");
	}
	if (r.kind === "question" || r.kind === "request") {
		if (r.forOwner) return out("reply_required", "P1", "home_only", "PRI-8");
		try {
			const bound = ports.senderTask?.(r.from.file);
			const task = bound?.queue.tasks.find((t) => t.id === bound.own.id);
			if (bound && !task) return out("turn_required", "P2", "home_only", "ROUTE-3");
			if (bound && r.from.role === r.to.role)
				return out(
					"reply_required",
					task && task.status !== "done" && task.status !== "dropped" ? (task.priority ?? "P2") : "P2",
					"home_only",
					"ROUTE-2",
				);
			if (task && task.status !== "done" && task.status !== "dropped") {
				if (task.priority === "P0") return out("reply_required", "P0", "home_only", "PRI-9");
				if (task.priority === "P1" || (task.status === "blocked" && task.block?.lead === r.to.role))
					return out("reply_required", "P1", "helper_eligible", "PRI-9");
			}
		} catch {
			return out("turn_required", "P2", "home_only", "ROUTE-3");
		}
		return out("reply_required", "P2", "helper_eligible", "PRI-10");
	}
	return out("turn_required", "P2", "home_only", "ROUTE-3");
}
export function homeView(
	r: RoleMessageRecord,
	records: RoleMessageRecord[],
	lines: InboxLine[],
	ports: InboxRuntimePorts,
): InboxView {
	const key = `rm:${r.id}`;
	const contentHash = `sha256:${inboxDigest(Object.fromEntries(["id", "at", "from", "to", "kind", "replyTo", "text"].map((k) => [k, r[k as keyof RoleMessageRecord] ?? null])))}`;
	const own = lines.filter((l) => l.key === key);
	if (own.some((l) => l.contentHash !== contentHash)) throw new Error("E_RPI_CONFLICT");
	const cls = classification(r, records, ports);
	const life: InboxView["lifecycle"] = {
		state: r.state === "failed" ? "failed" : cls.class === "passive" && r.state === "delivered" ? "processed" : "open",
		lease: null,
		attempts: 0,
		cursor: 0,
		receipt: { transport: r.state === "delivered" ? r.id : null, semantic: null },
	};
	for (const l of own) {
		if (l.op === "claim") {
			life.state = "claimed";
			life.lease = l.leaseId;
		}
		if (l.op === "release") {
			life.state = "open";
			life.lease = null;
		}
		if (l.op === "attempt") {
			life.attempts = l.n;
			life.lease = null;
			if (l.cause === "no_effect") life.effect = null;
			life.state =
				l.outcome === "turn_completed" && r.kind !== "question" && r.kind !== "request" ? "processed" : "open";
		}
		if (l.op === "refusal" && l.code === "E_RPI_NOT_ACCEPTED") {
			life.effect = null;
			life.state = "open";
			life.lease = null;
		}
		if (l.op === "effect_intent")
			life.effect = { opKey: l.opKey, kind: l.effect, status: "intent", resultRef: null, queuedTask: null };
		if (l.op === "effect_done")
			life.effect = {
				opKey: l.opKey,
				kind: l.effect,
				status: "accepted",
				resultRef: l.effect === "reply" ? l.resultRef : null,
				queuedTask: l.effect === "task" ? l.resultRef : null,
			};
	}
	const reply = records.find(
		(m) =>
			m.id === r.replyId &&
			m.kind === "reply" &&
			m.replyTo === r.id &&
			m.from.role === r.to.role &&
			m.to.role === r.from.role,
	);
	if (reply) {
		life.state = "replied";
		life.receipt.semantic = reply.id;
		life.lease = null;
		life.effect = null;
	}
	const needsHome = own.some((line) => line.op === "release" && line.reason === "needs_home");
	const aged =
		cls.basePriority === "P2" && ["open", "claimed"].includes(life.state) && ports.now() - r.at >= 45 * 60_000;
	return {
		v: "rpi/1",
		key,
		contentHash,
		at: r.at,
		role: r.to.role,
		source: { kind: "role-message", ref: r.id },
		...cls,
		route: needsHome ? "home_only" : cls.route,
		effectivePriority: aged || (needsHome && cls.basePriority > "P1") ? "P1" : cls.basePriority,
		promotedAt: aged ? r.at + 45 * 60_000 : null,
		person: null,
		payloadAuthority: "none",
		lifecycle: life,
	};
}
