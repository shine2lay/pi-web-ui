/** U602.1 canonical host codec boundary. Task 1: inert, no runtime callers. */
export type InboxPriority = "P0" | "P1" | "P2" | "P3";
export type InboxClass = "reply_required" | "turn_required" | "passive";
export type InboxState = "open" | "claimed" | "replied" | "processed" | "failed";
export type InboxEffect = {
	opKey: string;
	kind: "reply" | "task";
	status: "intent" | "accepted";
	resultRef: string | null;
	queuedTask: string | null;
};
export type InboxView = {
	v: "rpi/1";
	key: string;
	contentHash: string;
	at: number;
	role: string;
	source: {
		kind: "role-message" | "board-order" | "board-news" | "queue-card" | "owner-turn";
		ref: string;
	};
	class: InboxClass;
	basePriority: InboxPriority;
	effectivePriority: InboxPriority;
	promotedAt: number | null;
	route: "home_only" | "helper_eligible";
	reason: string;
	person: "Shine" | "Wai" | null;
	payloadAuthority: "none";
	lifecycle: {
		state: InboxState;
		lease: string | null;
		attempts: number;
		cursor: number;
		receipt: { transport: string | null; semantic: string | null };
		effect?: InboxEffect | null;
	};
};
export type InboxDecode<T> = { ok: true; value: T } | { ok: false; code: "E_RPI_SCHEMA" };
export type InboxFence = { leaseId: string; epoch: number };
export type InboxOutcome =
	"replied" | "turn_completed" | "turn_ended_unanswered" | "aborted" | "crashed" | "released_to_home" | "fenced";
export type InboxNeed = "capability" | "check" | "owner_consent" | "plan" | "lead" | "grant";
export type InboxLine = {
	v: "rpi/1";
	seq: number;
	at: number;
	key: string;
	contentHash: string;
} & (
	| ({ op: "claim"; holder: { kind: "home" | "helper"; role: string; session: string } } & InboxFence)
	| ({ op: "release" } & InboxFence &
			({ reason: "needs_home"; need: InboxNeed } | { reason: "spawn_failed"; need?: never }))
	| ({
			op: "attempt";
			n: number;
			outcome: InboxOutcome;
			cause?: "no_effect" | "limit" | "spawn_failed";
			passive?: { cursor: [number, string]; packetId: string };
	  } & InboxFence)
	| ({
			op: "effect_intent";
			effect: "reply" | "task";
			opKey: string;
			payloadSha256: string;
			opRef: string;
	  } & InboxFence)
	| ({ op: "effect_done"; effect: "reply" | "task"; opKey: string; resultRef: string } & InboxFence)
	| {
			op: "alarm";
			attempts: number;
			cause?: "unanswered" | "unknown" | "conflict" | "retention_over_keep" | "history_unknown";
	  }
	| { op: "conflict"; seenHash: string }
	| { op: "refusal"; code: string; leaseId?: string; epoch?: number }
);

export { decodeInboxView, decodeInboxLine, inboxClaimable, inboxNextDispatch } from "./inbox-codec.js";
