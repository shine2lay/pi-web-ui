/** I-ORIGIN -> C0 + display-only own policy, R0 (#141). INERT: no production importer/route/instance/writer.
 * Structural seam with pi-queue/queue-origin.ts; no deployment-path dependency, new auth or owner affordance.
 * Only the sealed native module supplies admissions/capabilities/policies. Until T02/T03/T05 exist all native
 * classifications are unavailable, all legacy rows are unclassified and policy reads "Not recorded".
 */
import { createHash } from "node:crypto";
import {
	isRtpiAccepted,
	rtpiCanonical,
	rtpiValidate,
	type RtpiAccepted,
	type RtpiQualification,
	type RtpiRef,
	type RtpiVerdict,
} from "./rtpi-core.js";
import { nativeOriginCapability, nativeOriginInput, nativeOwnWorkPolicy } from "./roles-origin-native.js";
import type { RolesQueueEnvelope } from "./roles-queue.js";

export type RolesOriginClass = "own" | "owner-requested" | "role-requested" | "unclassified";
export interface RolesOriginKey {
	readonly queueId: string;
	readonly sessionId: string;
	readonly sessionEpoch: string;
	readonly branchId: string;
	readonly homeRevision: number;
	readonly taskId: number;
	readonly planRevision: number;
}
export interface RolesOriginRecord {
	readonly schema: "i-origin/1";
	readonly context: {
		readonly key: RolesOriginKey;
		readonly target: RtpiRef;
		readonly operation: RtpiRef;
		readonly sourceRequest: RtpiRef | null;
		readonly committedAt: number;
	};
	readonly classification: RolesOriginClass;
	readonly request: RtpiRef | null;
	readonly actor: RtpiRef | null;
	readonly forwardChain: readonly RtpiRef[];
	readonly reason: string;
}
/** Native host already validated the request/owner-forwarding chain with the canonical add-on checker.
 * This is not a tool DTO. Its source context and qualification must come from the admitted atomic host.
 */
export interface NativeOriginInput {
	readonly record: RolesOriginRecord;
	readonly queueRevision: string;
	/** T03 principal of the original owner request, supplied only by the native request admission. */
	readonly ownerPrincipal: RtpiRef | null;
	readonly envelope: RolesQueueEnvelope;
	readonly qualification: RtpiQualification;
}
export interface RolesOriginResult {
	readonly state: "unavailable" | "unknown" | "rejected" | "accepted";
	readonly reason: string;
	readonly verdict: RtpiVerdict | null;
}
const token = (v: unknown): v is string =>
	typeof v === "string" && v.length > 0 && v.length <= 128 && !/[^A-Za-z0-9_.:-]/.test(v);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const time = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const closed = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
	!!v &&
	typeof v === "object" &&
	!Array.isArray(v) &&
	Object.keys(v).length === keys.length &&
	keys.every((k) => Object.hasOwn(v, k));
const ref = (v: unknown, kind?: string): v is RtpiRef =>
	closed(v, ["namespace", "kind", "id", "revision"]) &&
	(v.namespace === "rtpi-native" || v.namespace === "rtpi-fixture") &&
	token(v.kind) &&
	token(v.id) &&
	token(v.revision) &&
	(!kind || v.kind === kind);
const equal = (a: unknown, b: unknown): boolean => rtpiCanonical(a) === rtpiCanonical(b);
const sameRef = (a: unknown, b: unknown): boolean => ref(a) && ref(b) && equal(a, b);
const BINDING_FIELDS = ["queueId", "sessionId", "sessionEpoch", "branchId", "homeRevision"] as const;
const KEY_FIELDS = [...BINDING_FIELDS, "taskId", "planRevision"] as const;
function key(v: unknown): v is RolesOriginKey {
	return (
		closed(v, KEY_FIELDS) &&
		["queueId", "sessionId", "sessionEpoch", "branchId"].every((k) => token(v[k])) &&
		v.queueId === v.sessionId &&
		["homeRevision", "taskId", "planRevision"].every((k) => positive(v[k]))
	);
}
/** Branded accepted results additionally retain the exact native key/target; copied JSON is not an admission. */
const RECORDS = new WeakMap<RtpiAccepted, RolesOriginRecord>();
function recordValid(r: RolesOriginRecord): boolean {
	if (
		!closed(r, ["schema", "context", "classification", "request", "actor", "forwardChain", "reason"]) ||
		r.schema !== "i-origin/1" ||
		!closed(r.context, ["key", "target", "operation", "sourceRequest", "committedAt"]) ||
		!key(r.context.key) ||
		!ref(r.context.target, "role") ||
		!ref(r.context.operation, "operation") ||
		!time(r.context.committedAt) ||
		!Array.isArray(r.forwardChain) ||
		r.forwardChain.length > 4 ||
		!r.forwardChain.every((x) => ref(x, "receipt")) ||
		!token(r.reason)
	)
		return false;
	const ns = r.context.target.namespace;
	if (![r.context.operation, ...r.forwardChain].every((x) => x.namespace === ns)) return false;
	if (
		r.context.sourceRequest !== null &&
		(!ref(r.context.sourceRequest, "request") || r.context.sourceRequest.namespace !== ns)
	)
		return false;
	if (r.classification === "unclassified") return r.request === null && r.actor === null && r.forwardChain.length === 0;
	if (
		!ref(r.request, "request") ||
		!ref(r.actor) ||
		!sameRef(r.request, r.context.sourceRequest) ||
		r.actor.namespace !== ns ||
		r.request.namespace !== ns
	)
		return false;
	if (r.classification === "own") return sameRef(r.actor, r.context.target) && r.forwardChain.length === 0;
	if (r.classification === "owner-requested") return r.actor.kind === "owner";
	return (
		r.classification === "role-requested" &&
		r.actor.kind === "role" &&
		!sameRef(r.actor, r.context.target) &&
		r.forwardChain.length === 0
	);
}
/** No input/options accepted: neither a caller's "validated" label nor O0 render/open/plan approval is a request. */
export function rolesNativeOriginRoot(): RolesOriginResult {
	const native = nativeOriginInput();
	if (native === null) return { state: "unavailable", reason: "native-origin-admission-unavailable", verdict: null };
	const { record: r, envelope: e } = native;
	if (!recordValid(r) || !token(native.queueRevision) || e.occurredAt !== r.context.committedAt)
		return { state: "rejected", reason: "native-origin-context-mismatch", verdict: null };
	const k = r.context.key;
	const ns = r.context.target.namespace;
	const mkRef = (kind: string, id: string, revision: string): RtpiRef => ({ namespace: ns, kind, id, revision });
	const root = {
		schema: "rtpi/event/1",
		...e,
		context: {
			queue: mkRef("queue", k.queueId, native.queueRevision),
			taskId: k.taskId,
			planRevision: k.planRevision,
			session: mkRef("session", k.sessionId, k.branchId),
			epoch: mkRef("epoch", k.sessionEpoch, String(k.homeRevision)),
			turn: null,
			run: null,
			attempt: null,
			recipient: r.context.target,
			channel: "unknown",
			action: r.context.operation,
			artifact: null,
			owner: r.actor?.kind === "owner" ? r.actor : null,
			client: null,
			window: null,
			projection: null,
			coverage: null,
			policy: null,
			challenge: null,
		},
		body: {
			fact: "origin-classified",
			classification: r.classification === "unclassified" ? "unknown" : r.classification,
			request: r.request,
			actor: r.actor,
			forwardChain: [...r.forwardChain],
			refs: [r.context.operation],
		},
	};
	const capability = nativeOriginCapability();
	if (
		r.classification === "owner-requested" &&
		(!capability?.seams.ownerPrincipal ||
			native.qualification.ownerPrincipalAdmitted !== true ||
			!sameRef(native.ownerPrincipal, r.actor))
	)
		return { state: "unknown", reason: "owner-principal-not-admitted", verdict: null };
	const verdict = rtpiValidate(root, capability, native.qualification);
	if (verdict.status === "accepted") RECORDS.set(verdict, Object.freeze(structuredClone(r)));
	return { state: verdict.status, reason: verdict.status === "accepted" ? "admitted-origin" : verdict.reason, verdict };
}
export interface RolesOriginQueue {
	readonly schema: "i-queue/1";
	readonly binding: Omit<RolesOriginKey, "taskId" | "planRevision"> | null;
	readonly revision: string | null;
	readonly observedAt: number | null;
	readonly queueCoverage: "complete" | "partial" | "stale" | "unknown";
	readonly counts: Readonly<
		Record<"ready" | "working" | "asking" | "stuck" | "waiting" | "blocked" | "done" | "removed", number>
	> | null;
	readonly index: readonly { readonly key: RolesOriginKey; readonly status: string }[];
}
/** B02 projection over an uncapped Q0 index. An accepted C0 root without the native key association is not enough. */
export function rolesOriginCounts(queue: RolesOriginQueue, target: RtpiRef, origins: readonly RtpiAccepted[]) {
	const unknown = (reason: string) => ({ state: "unknown" as const, counts: null, reason });
	const statuses = ["ready", "working", "asking", "stuck", "waiting", "blocked", "done", "removed"] as const;
	if (
		queue.schema !== "i-queue/1" ||
		queue.queueCoverage !== "complete" ||
		!queue.binding ||
		!token(queue.revision) ||
		!time(queue.observedAt) ||
		!queue.counts ||
		!ref(target, "role")
	)
		return unknown("canonical-open-index-unavailable");
	const seen = new Set<number>();
	for (const row of queue.index) {
		if (
			!key(row.key) ||
			!BINDING_FIELDS.every((k) => row.key[k] === queue.binding?.[k]) ||
			seen.has(row.key.taskId) ||
			!(statuses as readonly string[]).includes(row.status)
		)
			return unknown("canonical-index-conflict");
		seen.add(row.key.taskId);
	}
	if (
		statuses.some(
			(s) => !time(queue.counts?.[s]) || queue.counts[s] !== queue.index.filter((r) => r.status === s).length,
		)
	)
		return unknown("canonical-index-count-mismatch");
	const open = queue.index.filter((r) => r.status !== "done" && r.status !== "removed");
	let own = 0,
		byOwner = 0,
		byRole = 0;
	for (const row of open) {
		const matches = new Map(
			origins
				.filter(isRtpiAccepted)
				.map((o) => RECORDS.get(o))
				.filter(
					(r): r is RolesOriginRecord =>
						!!r &&
						equal(r.context.key, row.key) &&
						sameRef(r.context.target, target) &&
						r.context.committedAt <= queue.observedAt!,
				)
				.map((r) => [rtpiCanonical(r), r]),
		);
		if (matches.size !== 1) continue;
		const match = [...matches.values()][0];
		if (match.classification === "own") own++;
		else if (match.classification === "owner-requested") byOwner++;
		else if (match.classification === "role-requested") byRole++;
	}
	return {
		state: "known" as const,
		counts: {
			open: open.length,
			own,
			requested: byOwner + byRole,
			byOwner,
			byRole,
			unclassified: open.length - own - byOwner - byRole,
		},
		reason: "complete-open-index",
	};
}

export interface OwnWorkDeclaration {
	readonly schema: "i-own-work-policy/1";
	readonly target: RtpiRef;
	readonly owner: RtpiRef;
	readonly action: RtpiRef;
	readonly effectiveAt: number;
	readonly ownWork: "paused" | "permitted";
}
export interface NativeOwnWorkPolicy {
	readonly declaration: OwnWorkDeclaration;
	readonly approval: RtpiAccepted;
}
/** A metadata binding, not authority: the authenticated policy root must name this exact declaration revision.
 * No instruction/prose/body digest. Changing the target, state, action, owner or time changes this policy ref.
 */
export function ownWorkDeclarationRef(d: OwnWorkDeclaration): RtpiRef {
	return {
		namespace: d.target.namespace,
		kind: "policy",
		id: "own-work-display",
		revision: createHash("sha256").update(rtpiCanonical(d)).digest("hex"),
	};
}
export interface OwnWorkDisplay {
	readonly ownPolicy: {
		readonly state: "paused" | "permitted" | "not-recorded";
		readonly label: string;
		readonly policy: RtpiRef | null;
	};
	readonly queueHold: boolean | null;
	readonly budgetStop: boolean | null;
}
/** Display facts only. "Permitted" never means dispatch may run; queue hold and budget stop stay independent.
 * running is deliberately not an input. No new policy declaration/action/approval affordance is provided.
 */
export function rolesOwnWorkDisplay(
	target: RtpiRef,
	facts: { readonly queueHold: boolean | null; readonly budgetStop: boolean | null },
): OwnWorkDisplay {
	const absent = (): OwnWorkDisplay => ({
		ownPolicy: { state: "not-recorded", label: "Not recorded", policy: null },
		queueHold: facts.queueHold,
		budgetStop: facts.budgetStop,
	});
	if (!ref(target, "role")) return absent();
	const native = nativeOwnWorkPolicy(target);
	if (
		!native ||
		!closed(native, ["declaration", "approval"]) ||
		!isRtpiAccepted(native.approval) ||
		!native.approval.qualified
	)
		return absent();
	const d = native.declaration;
	if (
		!closed(d, ["schema", "target", "owner", "action", "effectiveAt", "ownWork"]) ||
		d.schema !== "i-own-work-policy/1" ||
		!sameRef(d.target, target) ||
		!ref(d.owner, "owner") ||
		!ref(d.action, "operation") ||
		!time(d.effectiveAt) ||
		(d.ownWork !== "paused" && d.ownWork !== "permitted")
	)
		return absent();
	const root = native.approval.root as Record<string, unknown>;
	const body = root.body as Record<string, unknown>;
	const context = root.context as Record<string, unknown>;
	if (
		native.approval.schema !== "rtpi/event/1" ||
		body?.fact !== "policy-approved" ||
		body.status !== "known" ||
		body.clientRole !== "owner" ||
		!sameRef(context?.recipient, target) ||
		!sameRef(context.owner, d.owner) ||
		!sameRef(context.action, d.action) ||
		!sameRef(context.policy, ownWorkDeclarationRef(d)) ||
		root.occurredAt !== d.effectiveAt
	)
		return absent();
	return {
		ownPolicy: {
			state: d.ownWork,
			label: d.ownWork === "paused" ? "Paused by owner policy" : "Permitted by owner policy",
			policy: ownWorkDeclarationRef(d),
		},
		queueHold: facts.queueHold,
		budgetStop: facts.budgetStop,
	};
}
