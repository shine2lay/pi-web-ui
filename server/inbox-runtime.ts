/** Task 1 acceptance seam only. Not imported by the running host; no activation.
 * Task 2 replaces the explicit unbuilt errors, using the canonical wire and stores.
 * No fixture interpreter, copied priority/ceiling policy or second message store.
 */
import type { RoleMessageGuardHost } from "./role-message-guard-host.js";
import type { RoleMessages, RoleMessageSender, RoleMessageSendInput } from "./role-messages.js";
import type { InboxFence, InboxLine, InboxOutcome, InboxView } from "./shared/inbox-wire.js";

export interface InboxRuntimePorts {
	ledgerFile: string;
	roleMessagesFile: string;
	messages: RoleMessages;
	guard: RoleMessageGuardHost;
	now: () => number;
	/** HOME queue's canonical command/journal boundary, not a second task store. */
	queue?: InboxQueuePort;
}
export interface InboxTaskIntent {
	homeSession: string;
	effectId: string;
	opKey: string;
	payloadSha256: string;
	params: Record<string, unknown>;
	requester: {
		kind: "role";
		role: string;
		id: string;
		message: "question" | "request" | "reply";
		via: "inbox-helper";
		opKey: string;
		payloadSha256: string;
	};
}
export type InboxTaskResult =
	| { status: "accepted"; queuedTask: number; replyOwed: true; semanticReceipt: null }
	| { status: "refused"; code: string; need?: "plan"; queuedTask?: number };
export interface InboxQueuePort {
	homeSession: string;
	accept(intent: InboxTaskIntent): Promise<InboxTaskResult>;
	/** Reads actual HOME journal receipts; undefined means a qualified absence. */
	find(opKey: string): Promise<{ queuedTask: number; payloadSha256: string } | undefined>;
}
export interface InboxAlarmProjection {
	count: number;
	oldestAt: number | null;
	items: Array<{ key: string; sender: string; attempts: number; checkpoint: string; cause: string }>;
}
export type InboxRead = { status: "ok"; items: InboxView[] } | { status: "unknown"; source: string; reason: string };
export type InboxClaim = { key: string; session: string } & InboxFence;
export type InboxClaimResult = InboxClaim | { code: string } | { skipped: true };

const unbuilt = (): never => {
	throw new Error("E_RPI_UNBUILT: Task 1 inert seam; runtime implementation is not installed");
};

/** Constructor only captures real persistence/guard ports. It creates no files or hooks. */
export class InboxRuntime {
	constructor(readonly ports: InboxRuntimePorts) {}
	read(_role: string): InboxRead {
		return unbuilt();
	}
	claim(_key: string, _holder: { kind: "home" | "helper"; role: string; session: string }): Promise<InboxClaimResult> {
		return unbuilt();
	}
	end(_claim: InboxClaim, _outcome: InboxOutcome): Promise<void> {
		return unbuilt();
	}
	recover(): Promise<void> {
		return unbuilt();
	}
	reply(
		_claim: InboxClaim,
		_sender: RoleMessageSender,
		_input: RoleMessageSendInput,
		_toolCallId: string,
	): Promise<{ code?: string; resultRef?: string }> {
		return unbuilt();
	}
	task(_claim: InboxClaim, _params: Record<string, unknown>, _opRef: string): Promise<InboxTaskResult> {
		return unbuilt();
	}
	alarm(_role: string, _requestingRole: string): InboxAlarmProjection {
		return unbuilt();
	}
	/** This is the writer's SAME local key lock, never a test-only alternate coordinator. */
	run<T>(_key: string, _acceptance: () => Promise<T>): Promise<T> {
		return unbuilt();
	}
	/** Role-authorised metadata only; never message text or effect arguments. */
	audit(_role: string, _requestingRole: string): InboxLine[] {
		return unbuilt();
	}
}
