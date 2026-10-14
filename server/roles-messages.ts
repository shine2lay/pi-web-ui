/** I-MESSAGE -> C0, M0 (#139). INERT: no production importer, instance, registration, journal, I/O or writer.
 * Three capability adapters turn typed native message metadata into C0 event roots, and one pure projection joins
 * them into directed arrows. "Processed in a settled turn" comes only from C0's rtpiProcessed on an inclusion record of
 * the exact message and a settlement of the SAME whole-ref witness (C02). T01 (an exact, metadata-only final-input hook
 * with native run/attempt identity) is missing in pi SDK 1.0.1, so on today's seams every badge stays unknown.
 * No message text, header, hash, path or model input is read or stored here. See docs/roles-messages.md.
 */
import {
	isRtpiAccepted,
	isRtpiCapability,
	RTPI_NATIVE_SEAMS_C0,
	rtpiCanonical,
	rtpiPendingWindow,
	rtpiProcessed,
	rtpiValidate,
	type RtpiAccepted,
	type RtpiCapability,
	type RtpiNamespace,
	type RtpiProcessedState,
	type RtpiQualification,
	type RtpiRef,
	type RtpiVerdict,
} from "./rtpi-core.js";

// ---------------------------------------------------------------- native metadata in (I-MESSAGE/1)

export type RolesMessageKind = "question" | "request" | "fyi" | "reply" | "report";
/** Where the message went: a role's home chat, or a queue task chat (bound by queueId+taskId, never a label). */
export type RolesMessageRoute = "home" | "task";
/** The three receipt classes kept apart: an FYI starts no turn, so it is its own class wherever it goes. */
export type RolesMessageClass = "home" | "task" | "fyi";

/** The target chat's native binding (session header id, epoch, branch, home revision); never a path or label. */
export interface RolesMessageTarget {
	readonly sessionId: string;
	readonly sessionEpoch: string;
	readonly branchId: string;
	readonly homeRevision: number;
}
/** Q0's I-QUEUE task key subset: the native queue (session) id, task id and plan revision. */
export interface RolesMessageTask {
	readonly queueId: string;
	readonly taskId: number;
	readonly planRevision: number;
}
/** Exactly these fields; anything else a caller passes (text, header, hash, path, title) is never read. */
export interface RolesMessageMeta {
	readonly schema: "i-message/1";
	readonly id: string;
	readonly kind: RolesMessageKind;
	readonly route: RolesMessageRoute;
	readonly from: { readonly role: string; readonly homeRevision: number };
	readonly to: { readonly role: string; readonly homeRevision: number };
	readonly target: RolesMessageTarget | null;
	readonly task: RolesMessageTask | null;
	/** kind reply: the message it answers (the reply keeps its own new id). */
	readonly replyTo: string | null;
}
/** The native ids of one model attempt; issued by the native source, never parsed or guessed. */
export interface RolesAttemptIds {
	readonly turnId: string;
	readonly runId: string;
	readonly attemptId: string;
}
/** A delivery receipt: the persisted delivery revision (sends) and whether that delivery got in. */
export interface RolesDeliveryReceipt {
	readonly revision: number;
	readonly delivered: boolean;
}
/** A turn's terminal settlement as the native source issued it. "error" covers an empty error message. */
export interface RolesSettlementReceipt {
	readonly recipient: string;
	readonly target: RolesMessageTarget;
	readonly attempt: RolesAttemptIds;
	readonly outcome: "success" | "error" | "aborted" | "unknown";
}
/** Must eventually come from the admitted issuer/outbox, never model, tool or client arguments. */
export interface RolesMessageEnvelope {
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
export interface RolesMessageOptions {
	readonly enabled?: boolean;
	readonly capability?: RtpiCapability | null;
	readonly qualification?: RtpiQualification;
}
export interface RolesMessageResult {
	readonly state: "off" | "unknown" | "accepted" | "unavailable" | "rejected";
	readonly reason: string;
	readonly verdict: RtpiVerdict | null;
}

/** The native seams M0 runs on today: C0's, all missing (T01 included). */
export const ROLES_MESSAGE_SEAMS = RTPI_NATIVE_SEAMS_C0;

const token = (v: unknown): v is string =>
	typeof v === "string" && v.length > 0 && v.length <= 128 && !/[^A-Za-z0-9_.:-]/.test(v);
const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 1;
const KINDS: readonly string[] = ["question", "request", "fyi", "reply", "report"];

/** The receipt class of a message: FYI wherever it went, else its route. */
export function rolesMessageClass(m: Pick<RolesMessageMeta, "kind" | "route">): RolesMessageClass {
	return m.kind === "fyi" ? "fyi" : m.route;
}

function targetOk(t: RolesMessageTarget | null | undefined): t is RolesMessageTarget {
	return !!t && [t.sessionId, t.sessionEpoch, t.branchId].every(token) && positive(t.homeRevision);
}

/** Whole metadata check; a bad or partial binding is unknown, never defaulted. */
function metaOk(m: RolesMessageMeta | null | undefined): m is RolesMessageMeta {
	if (!m || m.schema !== "i-message/1" || !token(m.id) || !KINDS.includes(m.kind)) return false;
	if (m.route !== "home" && m.route !== "task") return false;
	if (!m.from || !m.to || !token(m.from.role) || !token(m.to.role)) return false;
	if (!positive(m.from.homeRevision) || !positive(m.to.homeRevision)) return false;
	if (!targetOk(m.target) || m.target.homeRevision !== m.to.homeRevision) return false;
	if (m.route === "task") {
		const t = m.task;
		if (!t || !token(t.queueId) || !positive(t.taskId) || !positive(t.planRevision)) return false;
	} else if (m.task !== null) return false;
	if (m.kind === "reply" ? !token(m.replyTo) : m.replyTo !== null) return false;
	return true;
}

const attemptOk = (a: RolesAttemptIds | null | undefined): a is RolesAttemptIds =>
	!!a && token(a.turnId) && token(a.runId) && token(a.attemptId);

// ---------------------------------------------------------------- root construction (typed fields only)

type Ctx = Record<string, unknown>;

function refOf(ns: RtpiNamespace, kind: string, id: string, revision: string): RtpiRef {
	return { namespace: ns, kind, id, revision };
}

/** The message as an operation ref: id = the message id, revision fixed (identity, not a version). */
export function rolesMessageRef(ns: RtpiNamespace, id: string): RtpiRef {
	return refOf(ns, "operation", id, "1");
}

/** The whole-ref witness for an attempt in a target chat (session, epoch, turn, run, attempt). */
export function rolesWitness(ns: RtpiNamespace, target: RolesMessageTarget, a: RolesAttemptIds) {
	return {
		session: refOf(ns, "session", target.sessionId, target.branchId),
		epoch: refOf(ns, "epoch", target.sessionEpoch, String(target.homeRevision)),
		turn: refOf(ns, "turn", a.turnId, "1"),
		run: refOf(ns, "run", a.runId, "1"),
		attempt: refOf(ns, "attempt", a.attemptId, "1"),
	};
}

function context(
	ns: RtpiNamespace,
	recipient: string,
	target: RolesMessageTarget,
	task: RolesMessageTask | null,
	action: string | null,
	attempt: RolesAttemptIds | null,
): Ctx {
	const w = attempt ? rolesWitness(ns, target, attempt) : null;
	return {
		queue: task ? refOf(ns, "queue", task.queueId, "1") : null,
		taskId: task ? task.taskId : null,
		planRevision: task ? task.planRevision : null,
		session: refOf(ns, "session", target.sessionId, target.branchId),
		epoch: refOf(ns, "epoch", target.sessionEpoch, String(target.homeRevision)),
		turn: w ? w.turn : null,
		run: w ? w.run : null,
		attempt: w ? w.attempt : null,
		recipient: refOf(ns, "role", recipient, "1"),
		channel: "role",
		action: action === null ? null : rolesMessageRef(ns, action),
		artifact: null,
		owner: null,
		client: null,
		window: null,
		projection: null,
		coverage: null,
		policy: null,
		challenge: null,
	};
}

function root(
	envelope: RolesMessageEnvelope,
	ctx: Ctx,
	fact: string,
	success: boolean | null,
	errorCode: string,
	refs: RtpiRef[],
) {
	return {
		schema: "rtpi/event/1",
		eventId: envelope.eventId,
		source: envelope.source,
		issuer: envelope.issuer,
		subject: envelope.subject,
		lineage: envelope.lineage,
		incarnation: envelope.incarnation,
		sequence: envelope.sequence,
		revision: envelope.revision,
		expectedRevision: envelope.expectedRevision,
		occurredAt: envelope.occurredAt,
		context: ctx,
		body: { fact, status: "known", success, errorCode, refs },
	};
}

function verdictOf(value: unknown, options: RolesMessageOptions): RolesMessageResult {
	const verdict = rtpiValidate(value, options.capability ?? null, options.qualification);
	return verdict.status === "accepted"
		? { state: "accepted", reason: "fixture-or-admitted-receipt", verdict }
		: { state: verdict.status, reason: verdict.reason, verdict };
}

const OFF: RolesMessageResult = Object.freeze({ state: "off", reason: "message-adapter-off", verdict: null });
const unknownResult = (reason: string): RolesMessageResult => ({ state: "unknown", reason, verdict: null });

// ---------------------------------------------------------------- the three capability adapters

/** message-admission-native: an accepted message (message-admitted), or a reply's own new id linked to the exact
 * original (message-replied, recipient = the original's sender). Off unless enabled; never processes anything. */
export function rolesMessageAdmission(
	fact: "message-admitted" | "message-replied",
	meta: RolesMessageMeta | null,
	envelope: RolesMessageEnvelope,
	options: RolesMessageOptions = {},
): RolesMessageResult {
	if (options.enabled !== true) return OFF;
	if (!metaOk(meta)) return unknownResult("message-binding-unknown");
	const ns = envelope.source.namespace;
	if (fact === "message-replied") {
		if (meta.kind !== "reply" || meta.replyTo === null) return unknownResult("reply-original-unknown");
		const ctx = context(ns, meta.to.role, meta.target!, meta.task, meta.id, null);
		return verdictOf(root(envelope, ctx, fact, null, "none", [rolesMessageRef(ns, meta.replyTo)]), options);
	}
	const ctx = context(ns, meta.to.role, meta.target!, meta.task, meta.id, null);
	return verdictOf(root(envelope, ctx, fact, null, "none", []), options);
}

/** message-delivery-native: the exact persisted delivery revision. Delivered is not included and not processed. */
export function rolesMessageDelivery(
	meta: RolesMessageMeta | null,
	receipt: RolesDeliveryReceipt | null,
	envelope: RolesMessageEnvelope,
	options: RolesMessageOptions = {},
): RolesMessageResult {
	if (options.enabled !== true) return OFF;
	if (!metaOk(meta)) return unknownResult("message-binding-unknown");
	if (!receipt || !positive(receipt.revision) || typeof receipt.delivered !== "boolean")
		return unknownResult("delivery-receipt-unknown");
	const ctx = context(envelope.source.namespace, meta.to.role, meta.target!, meta.task, meta.id, null);
	const ok = receipt.delivered;
	return verdictOf(root(envelope, ctx, "message-delivered", ok, ok ? "none" : "error", []), options);
}

/** input-settlement-native: exact inclusion of this message in an attempt's final input (message-included), or
 * that attempt's terminal settlement (message-settled). The generic producer for home, task and FYI alike. Refused
 * before any record is built while the capability does not declare the T01 input seam. */
export function rolesMessageInputSettlement(
	input:
		| {
				readonly fact: "message-included";
				readonly meta: RolesMessageMeta | null;
				readonly attempt: RolesAttemptIds | null;
		  }
		| { readonly fact: "message-settled"; readonly settlement: RolesSettlementReceipt | null },
	envelope: RolesMessageEnvelope,
	options: RolesMessageOptions = {},
): RolesMessageResult {
	if (options.enabled !== true) return OFF;
	const cap = options.capability ?? null;
	if (!isRtpiCapability(cap) || !cap.seams.inputHook) return unknownResult("input-hook-unsupported");
	const ns = envelope.source.namespace;
	if (input.fact === "message-included") {
		const m = input.meta;
		if (!metaOk(m)) return unknownResult("message-binding-unknown");
		if (!attemptOk(input.attempt)) return unknownResult("witness-unknown");
		const ctx = context(ns, m.to.role, m.target!, m.task, m.id, input.attempt);
		return verdictOf(root(envelope, ctx, "message-included", null, "none", []), options);
	}
	const s = input.settlement;
	if (!s || !token(s.recipient) || !targetOk(s.target) || !attemptOk(s.attempt))
		return unknownResult("witness-unknown");
	if (s.outcome === "unknown") return unknownResult("settlement-outcome-unknown");
	const success = s.outcome === "success";
	const code = success ? "none" : s.outcome === "aborted" ? "aborted" : "error";
	const ctx = context(ns, s.recipient, s.target, null, null, s.attempt);
	return verdictOf(root(envelope, ctx, "message-settled", success, code, []), options);
}

// ---------------------------------------------------------------- directed arrows (pure projection)

/** The native message index the arrows are built from. Totals only from a complete index; a 100-row tail or a
 * truncated store is partial. currentHome: the registry's current home revision per role (S02). */
export interface RolesMessageIndex {
	readonly messages: readonly RolesMessageMeta[];
	readonly coverage: "complete" | "partial" | "unknown";
	readonly total: number | null;
	readonly currentHome: Readonly<Record<string, number>>;
}
export interface RolesMessageView {
	readonly id: string;
	readonly kind: RolesMessageKind;
	readonly receiptClass: RolesMessageClass;
	readonly taskId: number | null;
	readonly admitted: boolean;
	readonly delivered: "yes" | "failed" | "unknown";
	readonly inputBound: boolean;
	/** Ids of replies linked to this message: each its own message and arrow; a reply never processes this one. */
	readonly replies: readonly string[];
	readonly processed: RtpiProcessedState;
	readonly reason: string;
	readonly pending: boolean;
}
export interface RolesArrow {
	readonly from: string;
	readonly to: string;
	readonly toHomeRevision: number;
	/** A message bound to an older home revision stays in its own domain, never the new home's arrow. */
	readonly stale: boolean;
	readonly byClass: Readonly<Record<RolesMessageClass, { readonly shown: number; readonly processed: number }>>;
	readonly pending: readonly RolesMessageView[];
	readonly pendingTotal: number | null;
	readonly messages: readonly RolesMessageView[];
}
export interface RolesArrows {
	readonly arrows: readonly RolesArrow[];
	readonly complete: boolean;
	readonly total: number | null;
	readonly shown: number;
	readonly badge: { readonly ready: boolean; readonly blocked: string | null };
	/** Messages whose records conflict (same dedup key, different bytes): shown unknown, never resolved. */
	readonly conflicts: readonly string[];
}

type Rec = RtpiAccepted;

function factOf(v: RtpiAccepted): string {
	return String((v.root.body as Ctx).fact);
}
function ctxOf(v: RtpiAccepted): Ctx {
	return v.root.context as Ctx;
}
const same = (a: unknown, b: unknown): boolean =>
	a !== null && b !== null && a !== undefined && b !== undefined && rtpiCanonical(a) === rtpiCanonical(b);
const WITNESS_KEYS = ["session", "epoch", "turn", "run", "attempt"] as const;

const RANK: Readonly<Record<RtpiProcessedState, number>> = { unknown: 0, "not-processed": 1, processed: 2 };

/** Directed arrows from the native index and qualified receipts. Pure: no I/O, no clock, nothing written. */
export function rolesMessageArrows(
	index: RolesMessageIndex,
	records: readonly RtpiVerdict[],
	capability: RtpiCapability | null,
): RolesArrows {
	const hook = isRtpiCapability(capability) && capability.seams.inputHook;
	const accepted = records.filter((r): r is Rec => isRtpiAccepted(r) && r.qualified && r.schema === "rtpi/event/1");
	// V04: same dedup key with other bytes is a conflict; every message it touches stays unknown.
	const byKey = new Map<string, Rec>();
	const conflicted = new Set<string>();
	const kept: Rec[] = [];
	for (const r of accepted) {
		const prior = byKey.get(r.dedupKey);
		if (prior === undefined) {
			byKey.set(r.dedupKey, r);
			kept.push(r);
		} else if (prior.digest !== r.digest) {
			for (const x of [prior, r]) {
				const a = ctxOf(x).action as RtpiRef | null;
				if (a) conflicted.add(a.id);
			}
		}
	}
	const settled = kept.filter((r) => factOf(r) === "message-settled");
	const views = new Map<string, RolesMessageView>();
	const valid = index.messages.filter(metaOk);
	for (const m of valid) {
		const target = m.target!;
		const mine = (fact: string) =>
			kept.filter((r) => {
				if (factOf(r) !== fact) return false;
				const c = ctxOf(r);
				return (
					same(c.action, rolesMessageRef(r.namespace, m.id)) &&
					same(c.session, refOf(r.namespace, "session", target.sessionId, target.branchId)) &&
					same(c.epoch, refOf(r.namespace, "epoch", target.sessionEpoch, String(target.homeRevision))) &&
					same(c.recipient, refOf(r.namespace, "role", m.to.role, "1")) &&
					(m.task === null
						? c.taskId === null && c.queue === null
						: c.taskId === m.task.taskId && same(c.queue, refOf(r.namespace, "queue", m.task.queueId, "1")))
				);
			});
		const delivery = mine("message-delivered");
		const included = hook ? mine("message-included") : [];
		const replies = kept
			.filter(
				(r) =>
					factOf(r) === "message-replied" &&
					((r.root.body as Ctx).refs as RtpiRef[]).some((x) => same(x, rolesMessageRef(r.namespace, m.id))),
			)
			.map((r) => (ctxOf(r).action as RtpiRef).id);
		let processed: RtpiProcessedState = "unknown";
		let reason = hook ? "inclusion-unknown" : "input-hook-unsupported";
		for (const inc of included) {
			const ic = ctxOf(inc);
			// The settlement of this exact witness first; else one of the same turn (another attempt) to say why.
			const exact = settled.find((s) => WITNESS_KEYS.every((k) => same(ctxOf(s)[k], ic[k])));
			const sameTurn = settled.find((s) => same(ctxOf(s).session, ic.session) && same(ctxOf(s).turn, ic.turn));
			const p = rtpiProcessed(inc, exact ?? sameTurn ?? null, capability);
			if (RANK[p.state] >= RANK[processed]) {
				processed = p.state;
				reason = p.reason;
			}
		}
		if (conflicted.has(m.id)) {
			processed = "unknown";
			reason = "receipt-conflict";
		}
		const failed = delivery.some((r) => (r.root.body as Ctx).success === false);
		const view: RolesMessageView = {
			id: m.id,
			kind: m.kind,
			receiptClass: rolesMessageClass(m),
			taskId: m.task ? m.task.taskId : null,
			admitted: mine("message-admitted").length > 0,
			delivered: delivery.some((r) => (r.root.body as Ctx).success === true) ? "yes" : failed ? "failed" : "unknown",
			inputBound: included.length > 0,
			replies,
			processed,
			reason,
			pending: processed !== "processed" && !failed,
		};
		views.set(m.id, view);
	}
	const complete =
		index.coverage === "complete" && index.total === valid.length && valid.length === index.messages.length;
	const groups = new Map<string, { m: RolesMessageMeta; v: RolesMessageView[] }>();
	for (const m of valid) {
		const key = `${m.from.role}\u0000${m.to.role}\u0000${m.to.homeRevision}`;
		const g = groups.get(key) ?? { m, v: [] };
		g.v.push(views.get(m.id)!);
		groups.set(key, g);
	}
	const arrows: RolesArrow[] = [];
	for (const { m, v } of groups.values()) {
		const byClass = {
			home: { shown: 0, processed: 0 },
			task: { shown: 0, processed: 0 },
			fyi: { shown: 0, processed: 0 },
		};
		for (const x of v) {
			byClass[x.receiptClass].shown++;
			if (x.processed === "processed") byClass[x.receiptClass].processed++;
		}
		const pend = v.filter((x) => x.pending);
		const current = index.currentHome[m.to.role];
		arrows.push({
			from: m.from.role,
			to: m.to.role,
			toHomeRevision: m.to.homeRevision,
			stale: current !== m.to.homeRevision,
			byClass,
			pending: rtpiPendingWindow(pend, pend.length).shown,
			pendingTotal: complete ? pend.length : null,
			messages: v,
		});
	}
	return {
		arrows,
		complete,
		total: complete ? index.total : null,
		shown: valid.length,
		badge: hook ? { ready: true, blocked: null } : { ready: false, blocked: "input-hook-unsupported" },
		conflicts: [...conflicted],
	};
}
