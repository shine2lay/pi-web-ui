/** Native peer envelope adapter. All approval policy and grant consumption stay in the existing guard. */
import type { RoleMessageDraft, RoleMessageRecord, RoleMessages, RoleMessageSender } from "./role-messages.js";
import type { GuardCommandAny } from "./role-message-guard-contract-v2.js";
import {
	preparePeerNote,
	peerArgs,
	peerTextHash,
	type PeerDecision,
	type PeerSendInput,
	type PeerToolAllowed,
	type PeerBlock,
} from "./peer-notes.js";

export interface PeerGuardEnvelope {
	id: string;
	target: string;
	peer: PeerBlock;
	textHash: string;
	draft: RoleMessageDraft;
	sender: RoleMessageSender;
	decision: PeerDecision;
}
export type PeerGuardPreparation =
	{ ready: true; envelope: PeerGuardEnvelope } | { ready: false; decision: PeerDecision };
/** Check non-approval constraints only. The core computes/checks actual chain authority, not this adapter. */
export function preparePeerGuard(
	store: RoleMessages,
	sender: RoleMessageSender,
	input: PeerSendInput,
	allowed: PeerToolAllowed,
	outbox: RoleMessageRecord[] = [],
): PeerGuardPreparation {
	if (sender.file !== input.sender.file || sender.role !== input.home_dept)
		return { ready: false, decision: { result: "refuse", code: "E_PEER_SENDER", records_added: 0 } };
	const checked = { ...input, store: [...store.recent(-Infinity), ...outbox] };
	const decision = preparePeerNote(checked, allowed);
	if (decision.result !== "allow" || !decision.records_added) return { ready: false, decision };
	const args = peerArgs(checked)!;
	return {
		ready: true,
		envelope: {
			id: decision.id!,
			target: decision.target!,
			peer: decision.peer!,
			textHash: peerTextHash(String(args.text)),
			sender: { ...sender, specialist: decision.from_specialist },
			decision,
			draft: {
				kind: decision.kind!,
				text: String(args.text).trim(),
				to: { role: sender.role, title: sender.title },
				replyTo: typeof args.reply_to === "string" ? args.reply_to : null,
				initiative: "",
			},
		},
	};
}
/** Invoked under the core writer, before native materialization. Never selects or spends a grant. */
export function peerGuardRoute(
	envelope: PeerGuardEnvelope | undefined,
	command: Extract<GuardCommandAny, { kind: "business_send" }>,
): { id: string; target: string } | undefined {
	if (!envelope) return;
	if (
		command.identity.actor.sessionFile !== envelope.sender.file ||
		command.identity.actor.role !== envelope.sender.role ||
		command.to !== envelope.draft.to.role ||
		command.text !== envelope.draft.text ||
		command.businessKind !== envelope.draft.kind ||
		command.replyTo !== envelope.draft.replyTo ||
		!/^pn-[0-9a-f]{16}$/.test(envelope.id)
	)
		throw new Error("peer envelope does not match guarded business send");
	return { id: envelope.id, target: envelope.target };
}
/** Persist these fields in the guarded outbox itself, so restart dispatch needs no live call context. */
export function stampGuardedPeer(
	record: RoleMessageRecord,
	envelope: PeerGuardEnvelope | undefined,
): RoleMessageRecord {
	if (!envelope) return record;
	if (record.id !== envelope.id || record.target !== envelope.target || record.text !== envelope.draft.text)
		throw new Error("peer materialization mismatch");
	return { ...record, peer: structuredClone(envelope.peer), peerTextHash: envelope.textHash, scanFrom: 0 };
}
