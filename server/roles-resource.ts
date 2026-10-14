/** I-RESOURCE/1 -> C0, L0 (#142). INERT: no production importer, routes, hooks, stores or timers.
 * Only opaque metadata refs; never private resource contents, content digests or profile values.
 * Uses pi-identity/resource-metadata.ts's structural seam without a deployment-path dependency.
 * Parsed DTOs and even generic C0 accepted roots are not this adapter's native admission.
 */
import {
	isRtpiAccepted,
	rtpiCanonical,
	rtpiValidate,
	type RtpiAccepted,
	type RtpiQualification,
	type RtpiRef,
	type RtpiVerdict,
} from "./rtpi-core.js";
import {
	nativeResourceCapability,
	nativeResourceCurrent,
	nativeResourceInput,
	nativeResourceOwnerOfSession,
} from "./roles-resource-native.js";
import type { RolesQueueEnvelope } from "./roles-queue.js";

export type ResourceCategory = "about" | "rules" | "skills" | "tools" | "runtime";
export type ResourceSelection = "requested" | "launch" | "current-selected" | "not-applicable";
export interface ResourceScope {
	readonly target: RtpiRef;
	readonly session: RtpiRef;
	readonly epoch: RtpiRef;
}
export interface ResourceRecord {
	readonly schema: "i-resource/1";
	readonly binding: ResourceScope & { readonly operation: RtpiRef };
	readonly kind: "incorporation" | "save" | "selection";
	readonly category: ResourceCategory;
	readonly revision: RtpiRef;
	readonly integrity: RtpiRef;
	readonly outcome: "prepared" | "failed" | "incorporated" | "saved" | "selected";
	readonly selection: ResourceSelection;
	readonly occurredAt: number;
	readonly actor: RtpiRef | null;
}
/** Supplied only by the sealed native module, not an extension/tool/client DTO or caller option. */
export interface NativeResourceInput {
	/** Canonical host tuple, read independently of the transport DTO. */
	readonly binding: ResourceRecord["binding"];
	readonly record: ResourceRecord;
	readonly envelope: RolesQueueEnvelope;
	readonly qualification: RtpiQualification;
	readonly successfulIncorporation: boolean;
	readonly authenticatedSaveActor: RtpiRef | null;
}
export interface NativeResourceCurrent {
	readonly schema: "i-resource-current/1";
	readonly scope: ResourceScope;
	readonly category: ResourceCategory;
	readonly revision: RtpiRef;
	readonly integrity: RtpiRef;
	readonly observedAt: number;
	readonly success: boolean;
}
export interface ResourceResult {
	readonly state: "accepted" | "rejected" | "unknown" | "unavailable";
	readonly reason: string;
	readonly verdict: RtpiVerdict | null;
}
const CATEGORIES: readonly ResourceCategory[] = ["about", "rules", "skills", "tools", "runtime"];
const closed = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
	v !== null &&
	typeof v === "object" &&
	!Array.isArray(v) &&
	Object.keys(v).length === keys.length &&
	keys.every((k) => Object.hasOwn(v, k));
const token = (v: unknown): v is string =>
	typeof v === "string" &&
	v.length > 0 &&
	v.length <= 128 &&
	!/[^A-Za-z0-9_.:-]/.test(v) &&
	!/^[0-9a-fA-F]{64}$/.test(v);
const time = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const uuid = (v: unknown): v is string =>
	typeof v === "string" &&
	v.length === 36 &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
function ref(v: unknown, kind: string): v is RtpiRef {
	return (
		closed(v, ["namespace", "kind", "id", "revision"]) &&
		(v.namespace === "rtpi-native" || v.namespace === "rtpi-fixture") &&
		v.kind === kind &&
		token(v.id) &&
		token(v.revision) &&
		((kind !== "resource" && kind !== "attestation") || (uuid(v.id) && uuid(v.revision)))
	);
}
const sameRef = (a: RtpiRef | null, b: RtpiRef | null): boolean =>
	a !== null && b !== null && rtpiCanonical(a) === rtpiCanonical(b);
const sameScope = (a: ResourceScope, b: ResourceScope): boolean =>
	sameRef(a.target, b.target) && sameRef(a.session, b.session) && sameRef(a.epoch, b.epoch);
function scope(v: unknown): v is ResourceScope {
	return (
		closed(v, ["target", "session", "epoch"]) &&
		ref(v.target, "role") &&
		ref(v.session, "session") &&
		ref(v.epoch, "epoch") &&
		v.target.namespace === v.session.namespace &&
		v.target.namespace === v.epoch.namespace
	);
}
function recordValid(v: ResourceRecord): boolean {
	if (
		!closed(v, [
			"schema",
			"binding",
			"kind",
			"category",
			"revision",
			"integrity",
			"outcome",
			"selection",
			"occurredAt",
			"actor",
		]) ||
		v.schema !== "i-resource/1" ||
		!closed(v.binding, ["target", "session", "epoch", "operation"]) ||
		!scope({ target: v.binding.target, session: v.binding.session, epoch: v.binding.epoch }) ||
		!ref(v.binding.operation, "operation") ||
		!ref(v.revision, "resource") ||
		!ref(v.integrity, "attestation") ||
		!CATEGORIES.includes(v.category) ||
		!time(v.occurredAt) ||
		(v.actor !== null && !ref(v.actor, "role") && !ref(v.actor, "owner"))
	)
		return false;
	const ns = v.binding.target.namespace;
	if (
		![v.binding.operation, v.revision, v.integrity, ...(v.actor === null ? [] : [v.actor])].every(
			(r) => r.namespace === ns,
		)
	)
		return false;
	if (v.kind === "incorporation")
		return (
			v.category !== "runtime" &&
			v.actor === null &&
			v.selection === "not-applicable" &&
			["prepared", "failed", "incorporated"].includes(v.outcome)
		);
	if (v.kind === "save")
		return (
			v.selection === "not-applicable" &&
			["failed", "saved"].includes(v.outcome) &&
			(v.outcome !== "failed" || v.actor === null)
		);
	return (
		v.kind === "selection" &&
		v.category === "runtime" &&
		v.actor === null &&
		["requested", "launch", "current-selected"].includes(v.selection) &&
		["failed", "selected"].includes(v.outcome)
	);
}
/** Association is process-local and cannot be reconstructed from caller JSON. C01: display only, not an ACL. */
const RECORDS = new WeakMap<RtpiAccepted, ResourceRecord>();
const result = (state: ResourceResult["state"], reason: string): ResourceResult => ({ state, reason, verdict: null });

/** No parameters: native capability, input, incorporation signal and owner identity cannot be caller-selected. */
export function rolesNativeResourceRoot(): ResourceResult {
	let n: NativeResourceInput | null;
	try {
		n = nativeResourceInput();
	} catch {
		return result("unknown", "resource-metadata-read-failed");
	}
	if (n === null) return result("unavailable", "native-resource-admission-unavailable");
	if (
		!closed(n, [
			"binding",
			"record",
			"envelope",
			"qualification",
			"successfulIncorporation",
			"authenticatedSaveActor",
		]) ||
		!recordValid(n.record) ||
		!closed(n.binding, ["target", "session", "epoch", "operation"]) ||
		!scope({ target: n.binding.target, session: n.binding.session, epoch: n.binding.epoch }) ||
		!ref(n.binding.operation, "operation") ||
		!sameScope(n.binding, n.record.binding) ||
		!sameRef(n.binding.operation, n.record.binding.operation) ||
		typeof n.successfulIncorporation !== "boolean" ||
		(n.record.kind !== "incorporation" && n.successfulIncorporation) ||
		!n.envelope ||
		typeof n.envelope !== "object" ||
		!n.qualification ||
		typeof n.qualification !== "object" ||
		(n.authenticatedSaveActor !== null &&
			!ref(n.authenticatedSaveActor, "owner") &&
			!ref(n.authenticatedSaveActor, "role")) ||
		n.envelope.occurredAt !== n.record.occurredAt
	)
		return result("rejected", "resource-metadata-invalid");
	const r = n.record,
		b = r.binding;
	let capability: ReturnType<typeof nativeResourceCapability>;
	try {
		capability = nativeResourceCapability();
	} catch {
		return result("unknown", "resource-metadata-read-failed");
	}
	const success = ["incorporated", "saved", "selected"].includes(r.outcome);
	if (r.kind === "incorporation" && success && n.successfulIncorporation !== true)
		return result("unknown", "prepared-not-incorporated");
	if (r.kind === "save" && success) {
		if (r.actor === null || !sameRef(r.actor, n.authenticatedSaveActor))
			return result("unknown", "save-actor-not-authenticated");
		if (r.actor.kind === "owner") {
			let owner: RtpiRef | null;
			try {
				owner = nativeResourceOwnerOfSession(b.session);
			} catch {
				return result("unknown", "resource-metadata-read-failed");
			}
			if (
				!capability?.seams.ownerPrincipal ||
				n.qualification.ownerPrincipalAdmitted !== true ||
				!sameRef(r.actor, owner)
			)
				return result("unknown", "owner-principal-not-admitted");
		}
	}
	const root = {
		schema: "rtpi/event/1",
		...n.envelope,
		context: {
			queue: null,
			taskId: null,
			planRevision: null,
			session: b.session,
			epoch: b.epoch,
			turn: null,
			run: null,
			attempt: null,
			recipient: b.target,
			channel: "unknown",
			action: b.operation,
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
			fact:
				r.kind === "incorporation" ? "resource-incorporated" : r.kind === "save" ? "config-saved" : "profile-selected",
			status: success ? "known" : "unknown",
			category: r.category,
			revision: r.revision,
			selection: r.selection,
			success: r.outcome === "prepared" ? null : success,
			// Integrity/actor stay in the scoped native-associated sidecar, not C0 generic evidence.
			refs: [],
		},
	};
	const verdict = rtpiValidate(root, capability, {
		...n.qualification,
		resourceIncorporated: r.kind === "incorporation" && success && n.successfulIncorporation,
	});
	if (verdict.status === "accepted") RECORDS.set(verdict, structuredClone(r));
	return {
		state: verdict.status,
		reason: verdict.status === "accepted" ? "admitted-resource-metadata" : verdict.reason,
		verdict,
	};
}
export interface ResourceValue {
	readonly label: "Recorded" | "Not recorded";
	readonly at: number | null;
	readonly revision: RtpiRef | null;
	readonly integrity: RtpiRef | null;
	readonly actor: RtpiRef | null;
}
const missing = (): ResourceValue => ({
	label: "Not recorded",
	at: null,
	revision: null,
	integrity: null,
	actor: null,
});
function view(r: ResourceRecord | null): ResourceValue {
	return r && ["incorporated", "saved", "selected"].includes(r.outcome)
		? {
				label: "Recorded",
				at: r.occurredAt,
				revision: structuredClone(r.revision),
				integrity: structuredClone(r.integrity),
				actor: r.actor ? structuredClone(r.actor) : null,
			}
		: missing();
}
function saved(r: ResourceRecord | null) {
	const { at, ...value } = view(r);
	return { ...value, editedAt: at };
}
/** Failure/ambiguous commits supersede the previous result; a stale success is never quietly substituted. */
function latest(
	records: readonly ResourceRecord[],
	kind: ResourceRecord["kind"],
	category: ResourceCategory,
	selection: ResourceSelection,
): ResourceRecord | null {
	const rows = records.filter((r) => r.kind === kind && r.category === category && r.selection === selection);
	if (rows.length === 0) return null;
	const operations = new Map<string, string>();
	for (const r of rows) {
		const op = rtpiCanonical(r.binding.operation),
			bytes = rtpiCanonical(r);
		if (operations.has(op) && operations.get(op) !== bytes) return null;
		operations.set(op, bytes);
	}
	const at = Math.max(...rows.map((r) => r.occurredAt)),
		newest = rows.filter((r) => r.occurredAt === at);
	return newest.every((r) => rtpiCanonical(r) === rtpiCanonical(newest[0])) ? newest[0] : null;
}
function current(s: ResourceScope, category: ResourceCategory, loaded: ResourceValue) {
	const unknown = { label: "Not recorded" as const, observedAt: null as number | null };
	if (loaded.at === null || loaded.revision === null) return unknown;
	let c: NativeResourceCurrent | null;
	try {
		c = nativeResourceCurrent(s, category);
	} catch {
		return unknown;
	}
	if (
		!c ||
		!closed(c, ["schema", "scope", "category", "revision", "integrity", "observedAt", "success"]) ||
		c.schema !== "i-resource-current/1" ||
		!scope(c.scope) ||
		!sameScope(c.scope, s) ||
		c.category !== category ||
		c.success !== true ||
		!time(c.observedAt) ||
		c.observedAt < loaded.at ||
		!ref(c.revision, "resource") ||
		!ref(c.integrity, "attestation") ||
		c.revision.namespace !== s.target.namespace ||
		c.integrity.namespace !== s.target.namespace
	)
		return unknown;
	return {
		label: sameRef(c.revision, loaded.revision) ? ("Unchanged" as const) : ("Changed since load" as const),
		observedAt: c.observedAt,
	};
}
/** Additive projection: J0 can merge this metadata sidecar without altering existing About/rules/focus access.
 * Does not read files or current profile values. Requested/launch/current-selected are independent opaque refs;
 * even a known launch selection is NOT evidence that that model ran. Missing facts have exactly Not recorded.
 */
export function rolesResourceProjection(s: ResourceScope, receipts: readonly RtpiAccepted[]) {
	const rows: ResourceRecord[] = [];
	if (scope(s))
		for (const receipt of receipts) {
			if (!isRtpiAccepted(receipt)) continue;
			const r = RECORDS.get(receipt);
			if (r && sameScope(r.binding, s)) rows.push(r);
		}
	const resources = CATEGORIES.filter((c) => c !== "runtime").map((category) => {
		const loaded = view(latest(rows, "incorporation", category, "not-applicable"));
		return {
			category,
			loaded,
			changed: current(s, category, loaded),
			saved: saved(latest(rows, "save", category, "not-applicable")),
		};
	});
	return {
		schema: "i-resource-view/1" as const,
		resources,
		runtime: {
			requested: view(latest(rows, "selection", "runtime", "requested")),
			launch: view(latest(rows, "selection", "runtime", "launch")),
			currentSelected: view(latest(rows, "selection", "runtime", "current-selected")),
			saved: saved(latest(rows, "save", "runtime", "not-applicable")),
			executedModel: "Not recorded" as const,
		},
	};
}
