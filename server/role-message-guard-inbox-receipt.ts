import type { GuardReadResultAny } from "./role-message-guard-contract-v2.js";
import { guardDigest, guardOperationKey } from "./role-message-guard-store.js";

/** The physical send identity, independent of the logical inbox opKey. */
export function guardSendOperationId(file: string, toolCallId: string): string {
	return `send-${guardDigest({ file, toolCallId }).slice(0, 16)}`;
}

export type GuardInboxOperationReceipt =
	| { readonly state: "accepted"; readonly resultRef: string }
	| { readonly state: "refused"; readonly reason: string }
	| { readonly state: "unaccepted" }
	| { readonly state: "unknown"; readonly reason: string };

/** Project only a canonical GuardFileStore read: never a second reader or recovery writer.
 * Only the current generation covers absence. The caller rechecks coverage after reading. */
export function guardInboxOperationReceipt(
	opRef: string,
	generation: number,
	read: GuardReadResultAny,
): GuardInboxOperationReceipt {
	const match = /^guard:([1-9]\d*):(send-[a-f0-9]{16})$/.exec(opRef);
	if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) !== generation)
		return { state: "unknown", reason: "operation generation is not covered by the current store" };
	if (read.state !== "ready") return { state: "unknown", reason: read.reason };
	const operationId = match[2];
	const state = read.value;
	// Acceptance outranks delivery state, a send error, and any later refusal.
	const outbox = state.outbox.find((entry) => entry.receipt.identity.operationId === operationId);
	if (outbox) return { state: "accepted", resultRef: outbox.receipt.messageId };
	const transaction = state.transactions.find((entry) => entry.identity.operationId === operationId);
	if (transaction) {
		if (transaction.state !== "committed")
			return { state: "unknown", reason: "unsettled guard reservation; guard reconciliation required" };
		const result = transaction.result;
		if (result.state === "accepted") return { state: "accepted", resultRef: result.receipt.messageId };
		return { state: "refused", reason: result.state === "blocked" ? result.reason : "communication_not_accepted" };
	}
	const operationKey = guardOperationKey({ version: "role-message-guard/v1", operationId });
	if (state.tombstones.some((entry) => entry.kind === "operation" && entry.identityDigest === operationKey))
		return { state: "unknown", reason: "pruned operation is not authoritatively absent" };
	if (state.transactions.some((entry) => entry.state !== "committed"))
		return { state: "unknown", reason: "store has unsettled reservations" };
	return { state: "unaccepted" };
}
