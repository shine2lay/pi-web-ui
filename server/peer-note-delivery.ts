/** Peer routing gates and durable terminal receipts; retry/proof remain in RoleMessages. */
import { existsSync } from "node:fs";
import type { RoleMessageRecord } from "./role-messages.js";
import { ROLE_MESSAGE_GIVE_UP_MS } from "./role-messages.js";
import { peerTaskOpen, peerReceiptText, type PeerBlock, type PeerTask } from "./peer-notes.js";
import { transcriptHasPeerReceipt } from "./role-message-transcript.js";

export interface PeerDeliveryHost {
	peerTask(queue: string, id: number): PeerTask | null | Promise<PeerTask | null>;
	peerNote(
		file: string,
		text: string,
		opts: { turn: boolean; followUp?: boolean },
	): Promise<{ ok: true } | { ok: false; busy?: boolean; error: string }>;
}
export interface PeerDeliverInput {
	record: { target: string; kind: string; peer: PeerBlock };
	target_task: (Partial<PeerTask> & { status: string }) | null;
	target_queue?: string;
	chat_state?: string;
	sender_status?: string;
	age_ms?: number;
	landed?: boolean;
}
export interface PeerDeliveryDecision {
	result: "allow";
	action: "none" | "failed" | "defer" | "note" | "followup";
	reason?: string;
	receipt?: "sender" | "store";
	lead_home?: number;
	turn?: boolean;
	steer?: boolean;
	message_role?: "custom";
	writes?: number;
	sends?: number;
	state?: "delivered";
}
export function decidePeerDelivery(input: PeerDeliverInput): PeerDeliveryDecision {
	const base = { result: "allow" as const };
	if (input.landed) return { ...base, action: "none", sends: 0, state: "delivered" };
	const fail = (reason: string): PeerDeliveryDecision => ({
		...base,
		action: "failed",
		reason: `undelivered:${reason}`,
		receipt: peerTaskOpen({ status: input.sender_status ?? "" }) ? "sender" : "store",
		lead_home: 0,
	});
	if ((input.age_ms ?? 0) > ROLE_MESSAGE_GIVE_UP_MS) return fail("expired");
	const t = input.target_task;
	if (!t) return fail("moved");
	if (input.target_queue !== input.record.peer.queue || (t.chat && t.chat !== input.record.target))
		return fail("moved");
	if (!t.chat || t.chatGone || ["done", "dropped", "removed"].includes(t.status ?? "")) return fail("closed");
	if (t.status !== "working" || t.held || t.backOwed) return { ...base, action: "defer", writes: 0 };
	return input.record.kind === "fyi" || input.record.peer.kind === "handoff"
		? { ...base, action: "note", turn: false }
		: {
				...base,
				action: "followup",
				turn: input.chat_state !== "streaming" && input.chat_state !== "working",
				steer: false,
				message_role: "custom",
			};
}
/** No host hooks means fail closed: never fall back to a user-message delivery. */
export async function peerDeliveryGate(
	r: RoleMessageRecord,
	host: Partial<PeerDeliveryHost>,
	now: number,
	resumedAt: number,
	chatState: string,
): Promise<PeerDeliveryDecision> {
	if (!r.peer || !r.target || !host.peerTask || !host.peerNote) return { result: "allow", action: "defer", writes: 0 };
	const t = await host.peerTask(r.peer.queue, r.peer.toTask);
	return decidePeerDelivery({
		record: { target: r.target, kind: r.kind, peer: r.peer },
		target_task: t ? { ...t, chatGone: t.chatGone || !existsSync(r.target) } : null,
		target_queue: t?.queue,
		chat_state: chatState,
		age_ms: now - Math.max(r.at, resumedAt),
	});
}
/** Saved pending on failure; retried after restart, transcript proof prevents duplicate receipts. */
export async function settlePeerReceipt(r: RoleMessageRecord, host: Partial<PeerDeliveryHost>): Promise<boolean> {
	if (!r.peer || r.peerReceipt !== "pending" || !host.peerTask || !host.peerNote) return false;
	const sender = await host.peerTask(r.peer.queue, r.peer.fromTask);
	if (
		!sender ||
		!peerTaskOpen(sender) ||
		!sender.startedAt ||
		sender.chat !== r.from.file ||
		sender.chatGone ||
		!existsSync(r.from.file)
	) {
		r.peerReceipt = "store";
		return true;
	}
	if (await transcriptHasPeerReceipt(r.from.file, r.id)) {
		r.peerReceipt = "delivered";
		return true;
	}
	const result = await host.peerNote(
		r.from.file,
		peerReceiptText(r.id, r.peer.toTask, r.error?.split(":")[1] ?? "closed"),
		{ turn: false, followUp: false },
	);
	// Admission is not proof. Leave pending until a later tick finds the receipt.
	if (result.ok && (await transcriptHasPeerReceipt(r.from.file, r.id))) {
		r.peerReceipt = "delivered";
		return true;
	}
	return false;
}
