import type { InboxDecode, InboxLine, InboxView } from "./inbox-wire.js";

type Row = Record<string, unknown>;
const row = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const num = (v: unknown, min = 0): boolean => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
const one = (v: unknown, values: string): boolean => typeof v === "string" && values.split(" ").includes(v);
const hash = (v: unknown): boolean => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
function keys(v: Row, required: string, optional = ""): boolean {
	const req = required.split(" ");
	const allowed = [...req, ...optional.split(" ")];
	return req.every((k) => Object.hasOwn(v, k)) && Object.keys(v).every((k) => allowed.includes(k));
}
const nullableId = (v: unknown): boolean => v === null || id(v);
const result = <T>(input: unknown, valid: boolean): InboxDecode<T> =>
	valid ? { ok: true, value: input as T } : { ok: false, code: "E_RPI_SCHEMA" };

function validEffect(e: unknown, state: unknown, semantic: unknown): boolean {
	if (e === null || e === undefined) return true;
	if (!row(e) || !keys(e, "opKey kind status resultRef queuedTask") || one(state, "replied processed failed"))
		return false;
	if (!hash(e.opKey) || !one(e.kind, "reply task") || !one(e.status, "intent accepted")) return false;
	if (!nullableId(e.queuedTask) || (e.queuedTask !== null && e.queuedTask === semantic)) return false;
	if (e.kind === "task") return e.resultRef === null && (e.queuedTask !== null) === (e.status === "accepted");
	return nullableId(e.resultRef) && (e.resultRef !== null) === (e.status === "accepted");
}
function validView(v: unknown): boolean {
	if (
		!row(v) ||
		!keys(
			v,
			"v key contentHash at role source class basePriority effectivePriority promotedAt route reason person payloadAuthority lifecycle",
		)
	)
		return false;
	if (v.v !== "rpi/1" || v.payloadAuthority !== "none" || !id(v.contentHash) || !v.contentHash.startsWith("sha256:"))
		return false;
	if (!num(v.at) || !(v.promotedAt === null || num(v.promotedAt))) return false;
	if (!one(v.class, "reply_required turn_required passive") || !one(v.route, "home_only helper_eligible")) return false;
	if (!one(v.basePriority, "P0 P1 P2 P3") || !one(v.effectivePriority, "P0 P1 P2 P3")) return false;
	const s = v.source,
		l = v.lifecycle;
	if (!row(s) || !keys(s, "kind ref") || !one(s.kind, "role-message board-order board-news queue-card owner-turn"))
		return false;
	if (
		!row(l) ||
		!keys(l, "state lease attempts cursor receipt", "effect") ||
		!one(l.state, "open claimed replied processed failed")
	)
		return false;
	if (!num(l.attempts) || !num(l.cursor) || !row(l.receipt) || !keys(l.receipt, "transport semantic")) return false;
	if (!nullableId(l.receipt.transport) || !nullableId(l.receipt.semantic)) return false;
	if (
		v.class === "reply_required" &&
		(l.state === "processed" || (l.receipt.semantic !== null) !== (l.state === "replied"))
	)
		return false;
	return validEffect(l.effect, l.state, l.receipt.semantic);
}
export function decodeInboxView(input: unknown): InboxDecode<InboxView> {
	return result(input, validView(input));
}

const ops: Record<string, [string, string]> = {
	claim: ["leaseId epoch holder", ""],
	release: ["leaseId epoch reason", "need"],
	attempt: ["n leaseId epoch outcome", "cause passive"],
	effect_intent: ["leaseId epoch effect opKey payloadSha256 opRef", ""],
	effect_done: ["leaseId epoch effect opKey resultRef", ""],
	alarm: ["attempts", "cause"],
	conflict: ["seenHash", ""],
	refusal: ["code", "leaseId epoch"],
};
function validLine(l: unknown): boolean {
	if (!row(l) || l.v !== "rpi/1" || !id(l.op) || !Object.hasOwn(ops, l.op)) return false;
	const [req, opt] = ops[l.op];
	if (!keys(l, `v seq at op key contentHash ${req}`, opt) || !num(l.seq, 1) || !num(l.at)) return false;
	for (const k of ["epoch", "n", "attempts"]) if (k in l && !num(l[k], k === "attempts" ? 0 : 1)) return false;
	for (const k of ["key", "contentHash", "leaseId", "opRef", "resultRef", "code", "seenHash"])
		if (k in l && !id(l[k])) return false;
	if (
		l.op === "release" &&
		(!one(l.reason, "needs_home spawn_failed") ||
			"need" in l !== (l.reason === "needs_home") ||
			("need" in l && !one(l.need, "capability check owner_consent plan lead grant")))
	)
		return false;
	if (l.op === "attempt") {
		if (!one(l.outcome, "replied turn_completed turn_ended_unanswered aborted crashed released_to_home fenced"))
			return false;
		if ("cause" in l) {
			const pairs: Record<string, string> = {
				no_effect: "turn_ended_unanswered",
				limit: "aborted",
				spawn_failed: "crashed",
			};
			if (!id(l.cause) || !Object.hasOwn(pairs, l.cause) || pairs[l.cause] !== l.outcome) return false;
		}
		if ("passive" in l) {
			const p = l.passive;
			if (
				!row(p) ||
				!keys(p, "cursor packetId") ||
				!id(p.packetId) ||
				!Array.isArray(p.cursor) ||
				p.cursor.length !== 2 ||
				!num(p.cursor[0]) ||
				!id(p.cursor[1])
			)
				return false;
		}
	}
	if (one(l.op, "effect_intent effect_done") && (!one(l.effect, "reply task") || !hash(l.opKey))) return false;
	if (l.op === "effect_intent" && !hash(l.payloadSha256)) return false;
	if (
		l.op === "alarm" &&
		"cause" in l &&
		!one(l.cause, "unanswered unknown conflict retention_over_keep history_unknown")
	)
		return false;
	return true;
}
export function decodeInboxLine(input: unknown): InboxDecode<InboxLine> {
	return result(input, validLine(input));
}
export function inboxClaimable(input: unknown): boolean {
	const d = decodeInboxView(input);
	if (!d.ok) return false;
	const l = d.value.lifecycle;
	return l.state === "open" && (!l.effect || (l.effect.kind === "task" && l.effect.status === "accepted"));
}
export function inboxNextDispatch(input: unknown): "order" | "reply_only" | null {
	if (!inboxClaimable(input)) return null;
	return (input as InboxView).lifecycle.effect?.queuedTask ? "reply_only" : "order";
}
