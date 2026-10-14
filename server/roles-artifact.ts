/** G0/1 (#143), candidate4. Closed content-free consumer metadata; pure, no I/O.
 * RTPI wire/schema unchanged. Exact identities are not authentication (C01).
 */
import { rtpiCanonical, rtpiSha256, type RtpiArtifactKey, type RtpiNamespace, type RtpiRef } from "./rtpi-core.js";

export type RolesArtifactKind = "pi-web-ui" | "agent-tools";
export type RolesLifecycleStage = "built" | "checked" | "installed" | "live";
export interface RolesArtifactIdentity {
	readonly kind: RolesArtifactKind;
	readonly artifact: RtpiArtifactKey;
	readonly contract: RtpiRef;
}
/** ONE canonical native run record, never requesting-task arguments. */
export interface RolesProducerContext {
	readonly queue: RtpiRef | null;
	readonly taskId: number | null;
	readonly planRevision: number | null;
	readonly run: RtpiRef;
	readonly attempt: RtpiRef;
}
/** Confirmation subject only: non-null task and its OWN native run/attempt. */
export interface RolesGateBinding extends RolesArtifactIdentity {
	readonly queue: RtpiRef;
	readonly taskId: number;
	readonly planRevision: number;
	readonly run: RtpiRef;
	readonly attempt: RtpiRef;
}
export interface RolesGateStamp {
	readonly stage: RolesLifecycleStage;
	readonly receipt: RtpiRef;
	readonly producer: RolesProducerContext;
}
export interface RolesConfirmationSnapshot {
	readonly binding: RolesGateBinding;
	readonly taskReceipt: RtpiRef;
	readonly gates: readonly RolesGateStamp[];
	readonly installReceipt: RtpiRef;
	readonly projection: RtpiRef;
	readonly coverage: RtpiRef;
	readonly policy: RtpiRef;
}
export const G0_STAGES = Object.freeze(["built", "checked", "installed", "live"] as const);
export const G0_PROFILES = Object.freeze({
	"pi-web-ui": Object.freeze({
		built: "web-assets",
		checked: "web-independent-gate",
		installed: "web-active-install",
		live: "web-current-client",
	}),
	"agent-tools": Object.freeze({
		built: "tools-snapshot",
		checked: "tools-existing-tests",
		installed: "tools-executable-snapshot",
		live: "tools-effective-executable",
	}),
});
export const G0_REQUIRED = Object.freeze([
	Object.freeze({ stage: "built", applicable: true, independent: false, dependsOn: Object.freeze([]) }),
	Object.freeze({ stage: "checked", applicable: true, independent: true, dependsOn: Object.freeze(["built"]) }),
	Object.freeze({ stage: "installed", applicable: true, independent: false, dependsOn: Object.freeze(["checked"]) }),
	Object.freeze({ stage: "live", applicable: true, independent: false, dependsOn: Object.freeze(["installed"]) }),
	Object.freeze({ stage: "owner-confirmed", applicable: true, independent: false, dependsOn: Object.freeze(["live"]) }),
]);
export const G0_UNMET = Object.freeze([
	"P3:environment-epoch-profile-missing",
	"P4:exact-assets-check-profile-missing",
	"P5:effective-live-measurement-missing",
	"T02:atomic-outbox-and-confirmation-commit-missing",
	"T03:secure-owner-action-missing",
	"T05:issuer-registry-missing",
]);
export const G0_CONFIRM_MEANING =
	"Records your own observation of this live artifact locally; not approval, consent, verified proof or a human-observer receipt.";
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Full-string R07: '$' alone also matches before a final LF. Never trim/normalize. */
const exact = (re: RegExp, s: unknown): s is string => typeof s === "string" && re.exec(s)?.[0] === s;
export const g0Token = (s: unknown): s is string => exact(ID, s);
export const g0Positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
export function g0Closed(x: unknown, keys: readonly string[]): x is Record<string, unknown> {
	return (
		x !== null &&
		typeof x === "object" &&
		!Array.isArray(x) &&
		(Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null) &&
		Object.keys(x).length === keys.length &&
		keys.every((k) => Object.hasOwn(x, k))
	);
}
export function g0ArtifactProblem(a: unknown): string | null {
	if (!g0Closed(a, ["gitHead", "assetsSha256", "version", "manifestRevision", "targetEnvironment", "environmentEpoch"]))
		return "artifact-key-invalid";
	if (!g0Token(a.version)) return "artifact-version-unsupported";
	if (
		!exact(/^[0-9a-f]{40}$/, a.gitHead) ||
		!exact(/^[0-9a-f]{64}$/, a.assetsSha256) ||
		!g0Positive(a.manifestRevision)
	)
		return "artifact-key-invalid";
	if (!g0Token(a.targetEnvironment)) return "artifact-target-unsupported";
	if (!g0Token(a.environmentEpoch)) return "artifact-epoch-unsupported";
	return null;
}
export function g0ArtifactKey(a: unknown): a is RtpiArtifactKey {
	return g0ArtifactProblem(a) === null;
}
export function g0Ref(r: unknown, kind: string, ns: RtpiNamespace): r is RtpiRef {
	return (
		g0Closed(r, ["namespace", "kind", "id", "revision"]) &&
		r.namespace === ns &&
		r.kind === kind &&
		g0Token(r.id) &&
		g0Token(r.revision)
	);
}
export function g0Identity(b: unknown): b is RolesArtifactIdentity {
	if (!g0Closed(b, ["kind", "artifact", "contract"])) return false;
	const ns = (b.contract as RtpiRef | null)?.namespace;
	return (
		(b.kind === "pi-web-ui" || b.kind === "agent-tools") &&
		g0ArtifactKey(b.artifact) &&
		(ns === "rtpi-native" || ns === "rtpi-fixture") &&
		g0Ref(b.contract, "contract", ns)
	);
}
export function g0Producer(p: unknown, ns: RtpiNamespace): p is RolesProducerContext {
	if (!g0Closed(p, ["queue", "taskId", "planRevision", "run", "attempt"])) return false;
	const task = g0Ref(p.queue, "queue", ns) && g0Positive(p.taskId) && g0Positive(p.planRevision);
	const job = p.queue === null && p.taskId === null && p.planRevision === null;
	return (task || job) && g0Ref(p.run, "run", ns) && g0Ref(p.attempt, "attempt", ns);
}
export function g0ProducerOf(b: RolesGateBinding): RolesProducerContext {
	return { queue: b.queue, taskId: b.taskId, planRevision: b.planRevision, run: b.run, attempt: b.attempt };
}
export function g0IdentityOf(b: RolesArtifactIdentity): RolesArtifactIdentity {
	return { kind: b.kind, artifact: b.artifact, contract: b.contract };
}
export function g0Binding(b: unknown): b is RolesGateBinding {
	if (!g0Closed(b, ["kind", "artifact", "contract", "queue", "taskId", "planRevision", "run", "attempt"])) return false;
	const v = b as unknown as RolesGateBinding;
	return g0Identity(g0IdentityOf(v)) && g0Producer(g0ProducerOf(v), v.contract.namespace) && v.queue !== null;
}
export function g0ConfirmationSnapshot(v: unknown): v is RolesConfirmationSnapshot {
	if (
		!g0Closed(v, ["binding", "taskReceipt", "gates", "installReceipt", "projection", "coverage", "policy"]) ||
		!g0Binding(v.binding)
	)
		return false;
	const ns = v.binding.contract.namespace;
	if (
		!g0Ref(v.taskReceipt, "receipt", ns) ||
		!g0Ref(v.installReceipt, "receipt", ns) ||
		!g0Ref(v.projection, "projection", ns) ||
		!g0Ref(v.coverage, "coverage", ns) ||
		!g0Ref(v.policy, "policy", ns) ||
		!Array.isArray(v.gates) ||
		v.gates.length !== 4
	)
		return false;
	return v.gates.every(
		(g, i) =>
			g0Closed(g, ["stage", "receipt", "producer"]) &&
			g.stage === G0_STAGES[i] &&
			g0Ref(g.receipt, "receipt", ns) &&
			g0Producer(g.producer, ns),
	);
}
export function g0Equal(a: unknown, b: unknown): boolean {
	return rtpiCanonical(a) === rtpiCanonical(b);
}
export function g0Freeze<T>(x: T): T {
	if (x !== null && typeof x === "object") {
		for (const v of Object.values(x)) g0Freeze(v);
		Object.freeze(x);
	}
	return x;
}
export function g0Copy<T>(x: T): T {
	return g0Freeze(JSON.parse(rtpiCanonical(x)) as T);
}
/** Whole six-field key, not gitHead/ancestry or JSON insertion order. */
export function g0ArtifactRef(key: RtpiArtifactKey, namespace: RtpiNamespace): RtpiRef {
	const problem = g0ArtifactProblem(key);
	if (problem !== null) throw new Error(problem);
	return Object.freeze({
		namespace,
		kind: "artifact",
		id: "ak-" + rtpiSha256("rtpi/artifact-key/1\u0000" + rtpiCanonical(key)),
		revision: String(key.manifestRevision),
	});
}
export function g0Issuer(
	kind: RolesArtifactKind,
	namespace: RtpiNamespace,
	stage?: RolesLifecycleStage | "owner-confirmed",
): RtpiRef {
	const id =
		stage === "owner-confirmed"
			? "roles.owner-client.confirmation"
			: "roles." + kind + (stage === "checked" ? ".check" : ".lifecycle");
	return Object.freeze({ namespace, kind: "issuer", id, revision: "g0-1" });
}
