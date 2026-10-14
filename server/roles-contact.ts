/** I-CONTACT -> C0, O0 (#140). INERT: no production importer, instance, registration, route, I/O or writer.
 *
 * Keeps an owner contact's stages apart: contact accepted, role delivered, reply, answer saved (callback
 * persisted), Telegram transport, matching-client rendered, explicitly opened. None implies the next; a missing
 * stage is "not recorded" or "unknown", never "failed" without a native failure receipt.
 *
 * Inputs are the native marks Ops108 (pi-web-ui 0af824f) already writes: the turn cause, the ownerChannel stamp
 * (role-replies.ts ownerChannelOf / browserRoleInput) and the forOwner record. This file reads no text, changes
 * no routing, sends nothing and replays no callback. Untyped owner turns are neutral "Your contacts" (C02): no
 * prose classifier, and "?" never types a question. Telegram API acceptance is transport, never a read. Browser
 * origin admission is not owner authentication. Render is not open, sight, consent or confirmation.
 *
 * Records are display-only (C01): any same-UID writer can forge them. Under the C0 seams (T02, T03, T05 absent)
 * every owner root validates unknown or unavailable. The owner principal, owner admission, server time and the RTPI
 * capability come only from roles-owner-native.ts or a handler-minted receipt (Security rm-4c755cd7 B1, B4): no
 * argument, env, config or flag selects them.
 */
import { ownerChannelOf, type RoleTurnCause } from "./role-replies.js";
import { rtpiValidate, type RtpiQualification, type RtpiRef, type RtpiVerdict } from "./rtpi-core.js";
import { isOwnerActionReceipt, type OwnerActionReceipt } from "./roles-owner-challenge.js";
import { nativeContactCapability, nativeOwnerOfSession, serverWallNow } from "./roles-owner-native.js";

// ---------------------------------------------------------------- browser / plugin / callback adapters

/** Where a native record came from. Only "native-record" (rehydrated by the host from the canonical store) counts;
 * a model, tool, plugin argument or client message claiming owner/forOwner/verified is refused (S01). */
export type ContactSource = "native-record" | "model" | "tool" | "plugin-argument" | "client";

export interface NativeContactInput {
	readonly source: ContactSource;
	/** Every cause seen for the turn (Ops108 RoleTurnRecord causes). More than one owner channel = mixed. */
	readonly causes: readonly RoleTurnCause[];
	/** The Ops108 ownerChannel stamp as stored (unknown values fail closed). */
	readonly ownerChannel: unknown;
	readonly pseudoClient: boolean;
	/** The answer was recorded only in a task's chat (queue relay/answer card), not in the owner's chat. */
	readonly taskOnly: boolean;
}

export type ContactChannel = "browser" | "telegram" | "task-only" | "role" | "unknown";
export interface ContactClass {
	readonly channel: ContactChannel;
	/** C02: always neutral until an explicit native typed intent is separately approved. */
	readonly kind: "contact";
	readonly label: "Your contacts" | "Task answer" | "Role message" | "Unknown contact";
	readonly reason: string;
	/** Owner-chat delivery can be claimed only for these; a task-only answer never counts as owner delivery. */
	readonly ownerDelivery: boolean;
}

/** No explicit native typed owner intent is approved (C02); a typed kind is not produced. */
export const OWNER_TYPED_INTENT_APPROVED = false;

const OWNER_CAUSES: ReadonlySet<RoleTurnCause> = new Set(["browser", "telegram"]);

function contact(channel: ContactChannel, reason: string): ContactClass {
	const label =
		channel === "browser" || channel === "telegram"
			? "Your contacts"
			: channel === "task-only"
				? "Task answer"
				: channel === "role"
					? "Role message"
					: "Unknown contact";
	return Object.freeze({
		channel,
		kind: "contact",
		label,
		reason,
		ownerDelivery: channel === "browser" || channel === "telegram",
	});
}

/** Browser and plugin (Telegram) adapter: classify an owner contact from Ops108's native marks only. */
export function classifyOwnerContact(input: NativeContactInput): ContactClass {
	if (input.source !== "native-record") return contact("unknown", "non-native-owner-flag");
	if (input.pseudoClient) return contact("unknown", "pseudo-client");
	if (input.taskOnly) return contact("task-only", "task-only-answer");
	const causes = new Set(input.causes);
	const owner = [...causes].filter((c) => OWNER_CAUSES.has(c));
	if (owner.length > 1 || (owner.length === 1 && causes.size > 1)) return contact("unknown", "mixed-cause");
	const stamp = ownerChannelOf(input.ownerChannel);
	const stamped = input.ownerChannel !== undefined && input.ownerChannel !== null;
	if (stamped && stamp === undefined) return contact("unknown", "owner-channel-invalid");
	if (owner.length === 0) {
		if (stamp !== undefined) return contact("unknown", "owner-channel-without-owner-cause");
		if (causes.size === 1 && causes.has("role")) return contact("role", "role-message");
		return contact("unknown", "cause-unknown");
	}
	const cause = owner[0] as "browser" | "telegram";
	// Ops108: browserRoleInput stamps ownerChannel "browser" only for an accepted, non-pseudo browser client.
	if (cause === "browser")
		return stamp === "browser" ? contact("browser", "ops108-browser") : contact("unknown", "browser-unadmitted");
	// Ops108: Telegram-origin input keeps its own route; a legacy unstamped Telegram record stays Telegram.
	return stamp === undefined || stamp === "telegram"
		? contact("telegram", "ops108-telegram")
		: contact("unknown", "channel-conflict");
}

export type StageName = "accepted" | "delivered" | "replied" | "saved" | "transport" | "rendered" | "opened";
export const CONTACT_STAGES: readonly StageName[] = Object.freeze([
	"accepted",
	"delivered",
	"replied",
	"saved",
	"transport",
	"rendered",
	"opened",
]);
export type StageState =
	"recorded" | "not-yet" | "not-recorded" | "partial" | "failed" | "not-applicable" | "unknown" | "unavailable";
export interface StageView {
	readonly state: StageState;
	readonly reason: string;
	readonly label: string;
}

/** Callback adapter input: what the native store holds for the owner's answer (agent-service onReply / forOwner). */
export type NativeCallback =
	{ readonly kind: "persisted"; readonly at: number } | { readonly kind: "failed"; readonly proof: string } | null;
/** Plugin adapter input: the Telegram plugin's own send outcome for this contact (never sent from here). */
export type NativeTransport =
	| { readonly kind: "api-accepted"; readonly messageIds: readonly number[]; readonly parts: number }
	| { readonly kind: "api-failed"; readonly code: number }
	| null;
export interface NativeReplyIndex {
	readonly complete: boolean;
	readonly replyIds: readonly string[];
}
export interface ContactEvidence {
	readonly accepted: boolean | null;
	readonly delivered: boolean | null;
	readonly replyIndex: NativeReplyIndex | null;
	readonly callback: NativeCallback;
	readonly transport: NativeTransport;
	/** The verdicts ownerActionRoot returned for this contact's owner-rendered / owner-opened roots; any other
	 * object (a direct rtpiValidate verdict, a copy or a parsed record) counts as unknown. */
	readonly rendered: RtpiVerdict | null;
	readonly opened: RtpiVerdict | null;
}

const stage = (state: StageState, reason: string, label: string): StageView => Object.freeze({ state, reason, label });

function seen(v: boolean | null, what: string): StageView {
	return v === true
		? stage("recorded", what + "-recorded", "Recorded")
		: stage("not-recorded", what + "-not-recorded", "Not recorded");
}

function receiptStage(v: RtpiVerdict | null, fact: "owner-rendered" | "owner-opened"): StageView {
	if (v === null) return stage("unknown", "owner-principal-not-admitted", "Unknown");
	// Only a verdict this adapter minted counts: a copy, parsed record or hand-built object is not one.
	if (!CONTACT_VERDICTS.has(v)) return stage("unknown", "verdict-not-from-contact-adapter", "Unknown");
	if (v.status === "rejected") return stage("not-recorded", v.reason, "Not counted");
	if (v.status !== "accepted") return stage(v.status, v.reason, "Unknown");
	const body = v.root.body as { fact?: unknown; status?: unknown } | undefined;
	if (body?.fact !== fact || body.status !== "known") return stage("unknown", "receipt-fact-mismatch", "Unknown");
	return stage("recorded", fact, fact === "owner-rendered" ? "Shown on your screen" : "Opened by you");
}

/** One state per stage. No stage is derived from another (save is not render, render is not open). */
export function contactStages(cls: ContactClass, e: ContactEvidence): Readonly<Record<StageName, StageView>> {
	const replied: StageView =
		e.replyIndex === null || e.replyIndex.complete !== true
			? stage("not-recorded", "reply-index-incomplete", "Reply not recorded")
			: e.replyIndex.replyIds.length === 0
				? stage("not-yet", "reply-index-complete-empty", "Not yet")
				: stage("recorded", "reply-recorded", "Replied");
	const saved: StageView =
		e.callback === null
			? stage("not-recorded", "callback-missing", "Delivery not recorded")
			: e.callback.kind === "persisted"
				? stage("recorded", "callback-persisted", "Answer saved")
				: typeof e.callback.proof === "string" && e.callback.proof.length > 0
					? stage("failed", "callback-failure-proven", "Failed")
					: stage("not-recorded", "callback-failure-unproven", "Delivery not recorded");
	let transport: StageView;
	if (cls.channel !== "telegram") transport = stage("not-applicable", "not-telegram", "");
	else if (e.transport === null) transport = stage("not-recorded", "transport-missing", "Not recorded");
	else if (e.transport.kind === "api-failed") transport = stage("failed", "telegram-api-failed", "Failed");
	else if (e.transport.messageIds.length > 0 && e.transport.messageIds.length === e.transport.parts)
		transport = stage("recorded", "telegram-api-accepted", "Accepted by Telegram (not a read)");
	else transport = stage("partial", "telegram-partial", "Partly sent");
	const ownerChat = cls.ownerDelivery;
	const notOwner = (s: StageName): StageView =>
		stage(
			"not-applicable",
			cls.channel === "task-only" ? "task-only-not-owner-delivery" : "not-owner-contact",
			s === "delivered" ? "Task only" : "",
		);
	return Object.freeze({
		accepted: ownerChat ? seen(e.accepted, "contact") : notOwner("accepted"),
		delivered: ownerChat ? seen(e.delivered, "delivery") : notOwner("delivered"),
		replied,
		saved,
		transport,
		rendered: ownerChat ? receiptStage(e.rendered, "owner-rendered") : notOwner("rendered"),
		opened: ownerChat ? receiptStage(e.opened, "owner-opened") : notOwner("opened"),
	});
}

// ---------------------------------------------------------------- RTPI roots (owner-saved / rendered / opened)

/** Native envelope: from the admitted issuer/outbox, never model, tool or client arguments. */
export interface ContactEnvelope {
	readonly eventId: string;
	readonly source: RtpiRef;
	readonly issuer: RtpiRef;
	readonly subject: RtpiRef;
	readonly lineage: RtpiRef;
	readonly incarnation: string;
	readonly sequence: number;
	readonly revision: number;
	readonly expectedRevision: number;
	readonly occurredAt: number;
}

const EMPTY_CONTEXT = Object.freeze({
	queue: null,
	taskId: null,
	planRevision: null,
	session: null,
	epoch: null,
	turn: null,
	run: null,
	attempt: null,
	recipient: null,
	channel: "unknown",
	action: null,
	artifact: null,
	owner: null,
	client: null,
	window: null,
	projection: null,
	coverage: null,
	policy: null,
	challenge: null,
});

/** Host facts a caller may give (J0 rehydrates them from the live host). Owner admission and server time are not
 * among them: the adapter reads those natively and replaces any caller value. */
export type ContactQualification = Omit<RtpiQualification, "ownerPrincipalAdmitted" | "serverNow">;
/** No capability option: the capability is the native one (none exists), never a caller's choice. */
export interface ContactRootOptions {
	readonly enabled?: boolean;
	readonly qualification?: ContactQualification;
}
export interface ContactRootResult {
	readonly state: "off" | "validated" | "unknown" | "unavailable" | "rejected";
	readonly reason: string;
	readonly verdict: RtpiVerdict | null;
}

/** Verdicts minted by finish() below, the only ones contactStages counts. */
const CONTACT_VERDICTS = new WeakSet<object>();

function finish(
	root: unknown,
	options: ContactRootOptions,
	native: { readonly ownerPrincipalAdmitted: boolean; readonly serverNow: number },
): ContactRootResult {
	// Native facts last: a caller's ownerPrincipalAdmitted or serverNow, even one smuggled past the type, is replaced.
	const verdict = rtpiValidate(root, nativeContactCapability(), { ...options.qualification, ...native });
	CONTACT_VERDICTS.add(verdict);
	return verdict.status === "accepted"
		? { state: "validated", reason: "receipt-validated", verdict }
		: { state: verdict.status, reason: verdict.reason, verdict };
}

/** Callback adapter -> owner-saved. The owner is the native T03 principal of the session (missing, so unknown);
 * never a caller's argument. */
export function ownerSavedRoot(
	input: {
		readonly session: RtpiRef;
		readonly receipt: RtpiRef;
		readonly serverNow: number;
	},
	envelope: ContactEnvelope,
	options: ContactRootOptions = {},
): ContactRootResult {
	if (options.enabled !== true) return { state: "off", reason: "contact-adapter-off", verdict: null };
	const owner = nativeOwnerOfSession(input.session);
	const known = owner !== null;
	const root = {
		schema: "rtpi/event/1",
		...envelope,
		context: { ...EMPTY_CONTEXT, owner, session: input.session },
		body: {
			fact: "owner-saved",
			status: known ? "known" : "unknown",
			receipt: input.receipt,
			clientRole: "owner",
			issuedAt: null,
			expiresAt: null,
			serverNow: input.serverNow,
			mode: "new",
			refs: [],
		},
	};
	return finish(root, options, { ownerPrincipalAdmitted: known, serverNow: serverWallNow() });
}

/** Matching-client render or explicit open -> owner-rendered / owner-opened, only from an accepted challenge
 * receipt of the matching kind. clientRole comes from the host scope (always "owner" here: observers never get a
 * receipt from the handler). Nothing here makes acknowledged, confirmed or approved. */
export function ownerActionRoot(
	receipt: OwnerActionReceipt,
	receiptRef: RtpiRef,
	envelope: ContactEnvelope,
	options: ContactRootOptions = {},
): ContactRootResult {
	if (options.enabled !== true) return { state: "off", reason: "contact-adapter-off", verdict: null };
	if (!isOwnerActionReceipt(receipt))
		return { state: "rejected", reason: "receipt-not-minted-by-handler", verdict: null };
	const fact = receipt.action === "render" ? "owner-rendered" : receipt.action === "open" ? "owner-opened" : null;
	if (fact === null) return { state: "rejected", reason: "action-not-in-o0", verdict: null };
	const root = {
		schema: "rtpi/event/1",
		...envelope,
		context: {
			...EMPTY_CONTEXT,
			session: receipt.session,
			channel: "browser",
			action: { ...receipt.challenge, kind: "operation", id: receipt.action + ":" + receipt.challenge.id },
			artifact: receipt.artifact,
			owner: receipt.principal,
			client: receipt.client,
			window: receipt.window,
			projection: receipt.projection,
			coverage: receipt.coverage,
			policy: receipt.policy,
			challenge: receipt.challenge,
		},
		body: {
			fact,
			status: "known",
			receipt: receiptRef,
			clientRole: "owner",
			issuedAt: receipt.issuedAt,
			expiresAt: receipt.expiresAt,
			serverNow: receipt.serverNow,
			mode: "new",
			refs: [],
		},
	};
	// A minted receipt is the handler's proof of native admission and of the server time it read (60 s window).
	return finish(root, options, { ownerPrincipalAdmitted: true, serverNow: receipt.serverNow });
}

// ---------------------------------------------------------------- diagnostic observer (read-only)

export interface ContactObserverView {
	readonly scope: "observer";
	readonly contact: ContactClass;
	readonly stages: Readonly<Record<StageName, StageView>>;
}
/** The look-only inspector's view: a frozen copy for an observer connection the host marked as such. It takes no
 * challenge handler, holds no capability and can mint no receipt; its own reads are never render or open. */
export function observeContact(hostScope: "observer", cls: ContactClass, e: ContactEvidence): ContactObserverView {
	if (hostScope !== "observer") throw new Error("observer-scope-required");
	return Object.freeze({ scope: "observer", contact: cls, stages: contactStages(cls, e) });
}
