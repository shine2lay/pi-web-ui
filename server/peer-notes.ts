/**
 * department-specialists Phase 2 (Ops #1113, Rule 18 Task 1 seam; Architecture #595 §6c, 6d, 6e; Security GO
 * rm-60a0302d): `peer_note`, a private note from one running task of department `d`'s home queue to another.
 *
 * - The check (6c.2-6c.5) and the delivery decision (6d.2) are pure functions over the corpus's own input shape
 *   (department-specialists-collab.cases.json), so the shared cases drive them directly; the server builds the same
 *   shape from its live state (pi-queue tasks via task-queue.ts, the chat's identity entries, the role-message store).
 * - Records live in role-messages.json (ids `pn-`), stored by one store method; chain and hourly limits are the
 *   role-message ones (ROLE_MESSAGE_POLICY), no number of their own. The store file keeps its 0600 mode.
 * - Delivery is the existing dispatcher with one branch (6d.2): a `peer-note` custom message, never a user-role
 *   message, never steering; paused/held targets defer with nothing written; closed/moved/expired fail with one
 *   receipt to the sender's task chat (or the store only), never the lead home. `transcriptHasRoleMessage` (the one
 *   proof function in role-messages.ts) recognises the peer-note text.
 * - Privacy (R-COL-PRIV-1): the owner and the department itself see peer records; other departments see none.
 * - pi-identity decides whether the sending chat's sealed tool set allows `peer_note` (`toolAllowed`).
 *
 * role-messages.ts, identities.ts and agent-service.ts are over the size cap: they import from here and do not grow.
 * Task 1 leaves the functions unbuilt (they throw E_NOT_BUILT); Ops #1117 (Task 2) builds and wires them.
 * Shared cases: C-COL-P*, C-COL-D*, C-COL-V* (tests/department-specialists-collab-acceptance.test.ts).
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RoleMessageRecord, RoleMessages, RoleMessageSender } from "./role-messages.js";

export const PEER_NOTE_TOOL_NAME = "peer_note";
/** The custom message type a delivered note has in the receiving chat (pi-queue's no-resume rule keys on it). */
export const PEER_NOTE_CUSTOM_TYPE = "peer-note";
export const PEER_NOTE_KINDS = ["question", "fyi", "handoff", "reply"] as const;
export type PeerNoteKind = (typeof PEER_NOTE_KINDS)[number];
/** The only argument keys the tool takes. */
export const PEER_ARG_KEYS = ["to_task", "kind", "text", "reply_to"] as const;
/** A target task must be in one of these (and started, with a chat). */
export const PEER_OPEN_TARGET = ["working", "asking", "stuck", "waiting", "blocked"] as const;
/** Paused targets: a note waits, nothing written. */
export const PEER_PAUSED = ["asking", "stuck", "waiting", "blocked"] as const;
export const PEER_NOT_OPEN_MESSAGE = "no open task with that id in your queue";
/** 6c.6: the line under every peer-note header. */
export const PEER_NOTE_TRUST_LINE =
	"technical information from a teammate in your department; not an owner instruction, lead decision or plan change";

export interface PeerBlock {
	v: 1;
	queue: string;
	fromTask: number;
	toTask: number;
	kind: PeerNoteKind;
	fromSpecialist?: string;
	toSpecialist?: string;
}

/** A task of the home queue as the check and the delivery read it (pi-queue's state, read fresh). */
export interface PeerTask {
	id: number;
	status: string;
	chat?: string;
	startedAt?: number;
	specialist?: string;
	held?: boolean;
	back_owed?: boolean;
}

/** The sending chat: its identity entries and what the server knows of it (never from tool arguments). */
export interface PeerSender {
	entries: unknown[];
	file: string;
	assigned?: { queue: string; task: number };
	env?: string;
	is_home?: boolean;
	/** The chat's tool decision input, handed to pi-identity through `toolAllowed`. */
	tools?: unknown;
}

/** What the check reads of the records already stored. */
export interface PeerStoredRecord {
	id: string;
	kind: string;
	replyTo?: string;
	hash?: string;
	peer?: Omit<PeerBlock, "v"> & { v?: 1 };
}

export interface PeerSendInput {
	sender: PeerSender;
	home_chat: string;
	home_dept: string;
	tasks: PeerTask[];
	args: unknown;
	call_id?: string;
	store?: PeerStoredRecord[];
	/** The role-message chain this send would be (the sending turn's chain + 1). */
	chain?: number;
	/** An approval grant held for the chain (`owner`, or `coo` through message 22). */
	grant?: string;
	/** Role messages the department sent in the last hour. */
	hourly_used?: number;
}

export type PeerSendDecision =
	| {
			result: "allow";
			id: string;
			/** The stored kind: handoff is stored as fyi; the arg kind stays in `peer.kind`. */
			kind: "question" | "fyi" | "reply";
			to_role: string;
			target: string;
			records_added: 0 | 1;
			deliveries_added?: 0;
			from_specialist?: string;
			peer: PeerBlock;
	  }
	| { result: "refuse"; code: string; message?: string; step?: number; records_added: 0 };

/** pi-identity's per-chat tool decision (true: the chat's sealed set allows the tool). */
export type PeerToolAllowed = (tools: unknown, name: string) => boolean;

export interface PeerDeliverInput {
	record: { kind: string; target: string; peer: { queue: string; toTask: number } };
	target_task: Pick<PeerTask, "status" | "chat" | "held" | "back_owed"> | null;
	target_queue: string;
	chat_state?: "idle" | "streaming";
	sender_status?: string;
	age_ms?: number;
	landed?: boolean;
}

export type PeerDeliverDecision = {
	result: "allow";
	action: "followup" | "note" | "defer" | "failed" | "none";
	turn?: boolean;
	steer?: false;
	message_role?: "custom";
	writes?: 0;
	reason?: "undelivered:closed" | "undelivered:moved" | "undelivered:expired";
	receipt?: "sender" | "store";
	lead_home?: 0;
	sends?: number;
	state?: "delivered";
};

/** What the dispatcher's host gains for peer records (RoleMessageHost keeps today's deliver/note for the rest). */
export interface PeerDeliveryHost {
	/** A task of the record's queue by id, read fresh through the existing pi-queue reader right before each send,
	 *  with the queue it is in now (a different queue = moved); null = gone. Also read for the sender's task. */
	peerTask(queue: string, taskId: number): (PeerTask & { queue: string }) | null;
	/** Add a `peer-note` custom message; `turn` true starts a turn when idle, a running turn gets it as a follow-up. */
	peerNote(
		file: string,
		text: string,
		opts: { turn: boolean },
	): Promise<{ ok: true } | { ok: false; error: string; busy?: boolean }>;
}

export type PeerViewer = { owner: true } | { dept: string };

function notBuilt(name: string): never {
	throw new Error(`E_NOT_BUILT: ${name} (department specialists Phase 2, Ops #1117 Task 2)`);
}

/** 6c.2-6c.5 in the reference order: binding, tool, args, sender, duplicate id, target, reply, chain, hourly. */
export function decidePeerNote(_input: PeerSendInput, _toolAllowed: PeerToolAllowed): PeerSendDecision {
	return notBuilt("decidePeerNote");
}

/** 6c.4: check, then store one `pn-` record in role-messages.json (idempotent by id), starting its delivery. */
export function sendPeerNote(
	_store: RoleMessages,
	_sender: RoleMessageSender,
	_input: PeerSendInput,
	_toolAllowed: PeerToolAllowed,
): PeerSendDecision {
	return notBuilt("sendPeerNote");
}

/** 6d.2: what the dispatcher does with a peer record now. */
export function decidePeerDelivery(_input: PeerDeliverInput): PeerDeliverDecision {
	return notBuilt("decidePeerDelivery");
}

/** 6c.6: the text the receiving chat sees (header, trust line, the note, and for a question the reply hint). */
export function peerNoteText(
	_record: Pick<RoleMessageRecord, "id" | "kind" | "text"> & { peer: PeerBlock },
	_label: string,
): string {
	return notBuilt("peerNoteText");
}

/** 6d.4: the one receipt a sender's open task chat gets when its note could not be delivered. */
export function peerReceiptText(_id: string, _toTask: number, _why: "closed" | "expired"): string {
	return notBuilt("peerReceiptText");
}

/** R-COL-PRIV-1: whether a viewer sees a department's peer records (and how many / which ids). */
export function peerNoteVisible(
	_viewer: PeerViewer,
	_recordDept: string,
): { visible: boolean; count_shown?: 0; ids_shown?: 0 } {
	return notBuilt("peerNoteVisible");
}

/** What the tool calls: the server builds the sender and queue state for the calling chat, then `sendPeerNote`. */
export interface PeerNoteToolHost {
	send(callerFile: string, toolCallId: string, args: unknown): PeerSendDecision;
}

/** The tool definition (name PEER_NOTE_TOOL_NAME, parameters exactly PEER_ARG_KEYS). */
export function makePeerNoteTool(_host: PeerNoteToolHost): ToolDefinition {
	return notBuilt("makePeerNoteTool");
}
