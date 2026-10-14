/** G0 candidate4 (#143). INERT exact-artifact consumer: no production importer, I/O,
 * registry, constructor of a native capability, writer, dispatch or permissions.
 * C01: forgeable LOCAL DISPLAY only. Canonical task.done and sealed C0 stay separate.
 */
import {
	isRtpiAccepted,
	rtpiCanonical,
	rtpiStructural,
	rtpiValidate,
	type RtpiAccepted,
	type RtpiGateCoverage,
	type RtpiGateStageState,
	type RtpiRef,
	type RtpiVerdict,
} from "./rtpi-core.js";
import {
	G0_PROFILES,
	G0_REQUIRED,
	G0_STAGES,
	g0ArtifactProblem,
	g0ArtifactRef,
	g0Binding,
	g0Closed,
	g0Copy,
	g0Equal,
	g0Identity,
	g0IdentityOf,
	g0Issuer,
	g0Positive,
	g0Producer,
	g0ProducerOf,
	g0Ref,
	g0Token,
	type RolesArtifactIdentity,
	type RolesConfirmationSnapshot,
	type RolesLifecycleStage,
	type RolesProducerContext,
} from "./roles-artifact.js";
import { isOwnerActionReceipt, type OwnerActionReceipt } from "./roles-owner-challenge.js";
import {
	nativeGateCapability,
	nativeGateConfirmationSource,
	nativeGateObservation,
	nativeGateState,
	type NativeGateIndex,
	type NativeGateIndexEntry,
	type NativeGateOperation,
	type NativeGateReceipt,
	type NativeGateState,
} from "./roles-gates-native.js";
import { nativeContactCapability } from "./roles-owner-native.js";

export interface RolesGateOptions {
	readonly enabled?: boolean;
}
export interface RolesGateResult {
	readonly state: "off" | "validated" | "unknown" | "unavailable" | "rejected";
	readonly reason: string;
	readonly native: boolean;
	readonly verdict: RtpiVerdict | null;
}
interface Meta {
	readonly identity: RolesArtifactIdentity;
	readonly stage: RolesLifecycleStage | "contract" | "owner-confirmed";
	readonly entry: NativeGateIndexEntry | null;
	readonly snapshot: RolesConfirmationSnapshot | null;
}
const MINTED = new WeakMap<object, Meta>();
const NONE = Object.freeze({});
const OFF: RolesGateResult = Object.freeze({ state: "off", reason: "gate-adapter-off", native: false, verdict: null });
const refusal = (reason: string, state: "unknown" | "unavailable" | "rejected" = "rejected"): RolesGateResult =>
	Object.freeze({ state, reason, native: false, verdict: null });
const nonnegative = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const ownProducer = (c: Record<string, unknown>): RolesProducerContext => ({
	queue: c.queue as RtpiRef | null,
	taskId: c.taskId as number | null,
	planRevision: c.planRevision as number | null,
	run: c.run as RtpiRef,
	attempt: c.attempt as RtpiRef,
});
const eventRef = (v: RtpiAccepted): RtpiRef => ({
	namespace: v.namespace,
	kind: "receipt",
	id: v.root.eventId as string,
	revision: String(v.root.revision),
});
/** G0 enforces R07 whole strings itself; does not edit the sealed C0 oracle/schema. */
function fullReferences(r: Record<string, unknown>, ns: RtpiRef["namespace"]): boolean {
	const refs: unknown[] = [r.source, r.issuer, r.subject];
	if (r.schema === "rtpi/event/1") {
		if (!g0Token(r.eventId) || !g0Token(r.incarnation)) return false;
		refs.push(r.lineage);
		const c = r.context as Record<string, unknown>;
		for (const name of [
			"queue",
			"session",
			"epoch",
			"run",
			"attempt",
			"recipient",
			"action",
			"artifact",
			"owner",
			"client",
			"window",
			"projection",
			"coverage",
			"policy",
			"challenge",
		])
			if (c[name] !== null) refs.push(c[name]);
		const body = r.body as Record<string, unknown>;
		if (Array.isArray(body.refs)) refs.push(...body.refs);
		if (body.contract !== undefined) refs.push(body.contract);
		if (body.receipt !== undefined) refs.push(body.receipt);
	} else refs.push(r.acceptedBy);
	return refs.every(
		(v) =>
			g0Closed(v, ["namespace", "kind", "id", "revision"]) &&
			v.namespace === ns &&
			g0Token(v.kind) &&
			g0Token(v.id) &&
			g0Token(v.revision),
	);
}

function contractProblem(s: NativeGateState): string | null {
	if (
		!g0Closed(s, [
			"binding",
			"contract",
			"qualification",
			"index",
			"currentTask",
			"taskLink",
			"latestInstall",
			"projection",
			"coverage",
			"policy",
		])
	)
		return "gate-state-closed-schema";
	if (!s.binding) return "gate-binding-invalid";
	const keyProblem = g0ArtifactProblem(s.binding.artifact);
	if (keyProblem !== null) return keyProblem;
	if (!g0Identity(s.binding)) return "kind-or-contract-binding-invalid";
	const b = s.binding;
	const structural = rtpiStructural(s.contract);
	if (structural.status !== "accepted" || structural.schema !== "rtpi/gate-contract/1")
		return "required-contract-invalid";
	const r = structural.root;
	if (!fullReferences(r, b.contract.namespace)) return "canonical-reference-invalid";
	if (r.domain !== "roles") return "roles-contract-only";
	if (!g0Equal(r.acceptedBy, g0Issuer(b.kind, b.contract.namespace)) || !g0Equal(r.issuer, r.acceptedBy))
		return "kind-specific-issuer-required";
	if (r.objectId !== b.contract.id || String(r.revision) !== b.contract.revision) return "contract-revision-mismatch";
	if (!g0Equal(r.artifact, b.artifact)) return "contract-artifact-mismatch";
	if (!Array.isArray(r.required) || !g0Equal(r.required, G0_REQUIRED)) return "kind-specific-required-set";
	return null;
}
function source(options: RolesGateOptions): NativeGateState | RolesGateResult {
	if (options.enabled !== true) return OFF;
	const s = nativeGateState();
	if (s === null) return refusal("native-outbox-issuer-missing", "unavailable");
	const problem = contractProblem(s);
	return problem === null ? s : refusal(problem);
}
function mint(
	root: unknown,
	s: NativeGateState,
	stage: Meta["stage"],
	receipt?: NativeGateReceipt,
	installReceipt: RtpiRef | null = null,
	snapshot: RolesConfirmationSnapshot | null = null,
): RolesGateResult {
	const owner = stage === "owner-confirmed";
	const q = receipt?.qualification ?? s.qualification;
	const structural = rtpiStructural(root);
	if (structural.status !== "accepted" || !fullReferences(structural.root, s.binding.contract.namespace))
		return refusal("canonical-reference-invalid");
	const cap = owner ? nativeContactCapability() : nativeGateCapability(stage === "contract" ? undefined : stage);
	const verdict = rtpiValidate(root, cap, {
		...q,
		rolesGateIssuer: g0Issuer(s.binding.kind, s.binding.contract.namespace),
		...(owner ? { ownerPrincipalAdmitted: true } : {}),
	});
	if (verdict.status !== "accepted")
		return Object.freeze({ state: verdict.status, reason: verdict.reason, native: false, verdict });
	const r = verdict.root;
	const entry: NativeGateIndexEntry | null =
		stage === "contract"
			? null
			: {
					kind: s.binding.kind,
					artifact: g0ArtifactRef(s.binding.artifact, verdict.namespace),
					contract: s.binding.contract,
					targetEnvironment: s.binding.artifact.targetEnvironment,
					stage,
					reference: eventRef(verdict),
					source: r.source as unknown as RtpiRef,
					issuer: r.issuer as unknown as RtpiRef,
					lineage: r.lineage as unknown as RtpiRef,
					incarnation: r.incarnation as string,
					sequence: r.sequence as number,
					revision: r.revision as number,
					digest: verdict.digest,
					producer: ownProducer(r.context as Record<string, unknown>),
					installReceipt,
				};
	MINTED.set(verdict, g0Copy({ identity: s.binding, stage, entry, snapshot }));
	return Object.freeze({
		state: "validated",
		reason: verdict.namespace === "rtpi-fixture" ? "synthetic-only" : "native-receipt",
		native: verdict.namespace === "rtpi-native",
		verdict,
	});
}
export function rolesRequiredGateContract(options: RolesGateOptions = {}): RolesGateResult {
	const s = source(options);
	return "state" in s ? s : mint(s.contract, s, "contract");
}
/** Own context is compared to ONE canonical native run record, never copied from a requested binding. */
function receiptProblem(
	receipt: NativeGateReceipt,
	identity: RolesArtifactIdentity,
	stage: RolesLifecycleStage,
): string | null {
	if (!g0Closed(receipt, ["root", "reference", "producer", "qualification"])) return "canonical-receipt-closed-schema";
	const ns = identity.contract.namespace;
	if (!g0Producer(receipt.producer, ns) || !g0Ref(receipt.reference, "receipt", ns))
		return "canonical-producer-invalid";
	const v = rtpiStructural(receipt.root);
	if (v.status !== "accepted" || v.schema !== "rtpi/event/1") return "canonical-gate-root-invalid";
	const r = v.root;
	if (!fullReferences(r, ns)) return "canonical-reference-invalid";
	const b = r.body as Record<string, unknown>;
	if (b.fact !== "gate-observed" || b.stage !== stage) return "canonical-gate-stage-mismatch";
	if (!g0Equal(r.issuer, g0Issuer(identity.kind, ns, stage))) return "fixed-stage-issuer-required";
	if (!g0Equal(eventRef(v), receipt.reference)) return "canonical-receipt-reference-mismatch";
	if (
		!g0Equal(b.contract, identity.contract) ||
		!g0Equal((r.context as Record<string, unknown>).artifact, g0ArtifactRef(identity.artifact, ns))
	)
		return "canonical-artifact-contract-mismatch";
	if (!g0Equal(ownProducer(r.context as Record<string, unknown>), receipt.producer))
		return "borrowed-native-producer-context";
	if (!g0Equal(receipt.qualification.currentArtifact, g0ArtifactRef(identity.artifact, ns)))
		return "canonical-source-artifact-mismatch";
	return null;
}
function operation(op: NativeGateOperation, s: NativeGateState, stage: RolesLifecycleStage): RolesGateResult {
	if (!g0Closed(op, ["measurement", "receipt"])) return refusal("canonical-operation-closed-schema");
	const m = op.measurement;
	if (
		!g0Closed(m, [
			"schema",
			"identity",
			"producer",
			"stage",
			"result",
			"profile",
			"mode",
			"observedArtifact",
			"installReceipt",
		]) ||
		m.schema !== "roles/g0-observation/1"
	)
		return refusal("gate-measurement-closed-schema");
	if (!g0Identity(m.identity) || !g0Equal(m.identity, s.binding)) return refusal("measured-artifact-contract-mismatch");
	if (m.stage !== stage || m.profile !== G0_PROFILES[s.binding.kind][stage])
		return refusal("kind-specific-profile-required");
	if (m.mode !== "measurement") return refusal("not-a-measurement");
	if (!g0Equal(m.observedArtifact, s.binding.artifact)) return refusal("measured-artifact-mismatch");
	if (!["pass", "fail", "unknown", "not-applicable"].includes(m.result as string))
		return refusal("measurement-result-invalid");
	const problem = receiptProblem(op.receipt, s.binding, stage);
	if (problem !== null) return refusal(problem);
	if (!g0Producer(m.producer, s.binding.contract.namespace) || !g0Equal(m.producer, op.receipt.producer))
		return refusal("borrowed-native-producer-context");
	const structural = rtpiStructural(op.receipt.root);
	if (structural.status !== "accepted") return refusal("canonical-gate-root-invalid");
	const body = structural.root.body as Record<string, unknown>;
	if (body.result !== m.result) return refusal("canonical-result-mismatch");
	if (stage === "live") {
		if (!g0Ref(m.installReceipt, "receipt", s.binding.contract.namespace) || !g0Equal(body.refs, [m.installReceipt]))
			return refusal("live-install-receipt-required");
	} else if (m.installReceipt !== null || !g0Equal(body.refs, [])) return refusal("unexpected-install-receipt");
	// No producer independence boolean. Fixed checked issuer + exact tested bytes/profile
	// + its OWN qualified canonical check operation are all required.
	return mint(op.receipt.root, s, stage, op.receipt, m.installReceipt as RtpiRef | null);
}
function lifecycle(stage: RolesLifecycleStage, options: RolesGateOptions): RolesGateResult {
	const s = source(options);
	if ("state" in s) return s;
	const op = nativeGateObservation(stage);
	return op === null ? refusal("gate-measurement-missing", "unknown") : operation(op, s, stage);
}
export const rolesArtifactLifecycle = Object.freeze({
	built: (options: RolesGateOptions = {}) => lifecycle("built", options),
	checked: (options: RolesGateOptions = {}) => lifecycle("checked", options),
	installed: (options: RolesGateOptions = {}) => lifecycle("installed", options),
	live: (options: RolesGateOptions = {}) => lifecycle("live", options),
});

const INDEX_ENTRY_KEYS = [
	"kind",
	"artifact",
	"contract",
	"targetEnvironment",
	"stage",
	"reference",
	"source",
	"issuer",
	"lineage",
	"incarnation",
	"sequence",
	"revision",
	"digest",
	"producer",
	"installReceipt",
] as const;
function indexEntrySchema(
	e: unknown,
	kind: RolesArtifactIdentity["kind"],
	ns: RtpiRef["namespace"],
): e is NativeGateIndexEntry {
	return (
		g0Closed(e, INDEX_ENTRY_KEYS) &&
		e.kind === kind &&
		g0Token(e.targetEnvironment) &&
		typeof e.stage === "string" &&
		[...G0_STAGES, "owner-confirmed"].includes(e.stage) &&
		g0Ref(e.artifact, "artifact", ns) &&
		g0Ref(e.contract, "contract", ns) &&
		g0Ref(e.reference, "receipt", ns) &&
		g0Ref(e.source, "source", ns) &&
		g0Ref(e.issuer, "issuer", ns) &&
		g0Ref(e.lineage, "lineage", ns) &&
		g0Token(e.incarnation) &&
		g0Positive(e.sequence) &&
		g0Positive(e.revision) &&
		typeof e.digest === "string" &&
		/^[0-9a-f]{64}$/.exec(e.digest)?.[0] === e.digest &&
		g0Producer(e.producer, ns)
	);
}
function indexProblem(s: NativeGateState): string | null {
	const i = s.index;
	if (
		!g0Closed(i, ["complete", "streams", "entries"]) ||
		i.complete !== true ||
		!Array.isArray(i.streams) ||
		!Array.isArray(i.entries)
	)
		return "gate-index-incomplete";
	if (i.streams.length < 2 || i.streams.length > 3 || i.entries.length > 200) return "gate-index-overflow";
	const ns = s.binding.contract.namespace;
	const issuers = new Set<string>();
	for (const st of i.streams) {
		if (
			!g0Closed(st, ["source", "issuer", "lineage", "incarnation", "sequence", "revision"]) ||
			!g0Ref(st.source, "source", ns) ||
			!g0Ref(st.issuer, "issuer", ns) ||
			!g0Ref(st.lineage, "lineage", ns) ||
			!g0Token(st.incarnation) ||
			!nonnegative(st.sequence) ||
			!nonnegative(st.revision)
		)
			return "gate-index-invalid";
		if (
			![
				g0Issuer(s.binding.kind, ns),
				g0Issuer(s.binding.kind, ns, "checked"),
				g0Issuer(s.binding.kind, ns, "owner-confirmed"),
			].some((r) => g0Equal(st.issuer, r))
		)
			return "gate-index-issuer-mismatch";
		const key = rtpiCanonical(st.issuer);
		if (issuers.has(key)) return "gate-index-conflict"; // never order different lineages/sources by clock
		issuers.add(key);
	}
	if (
		![g0Issuer(s.binding.kind, ns), g0Issuer(s.binding.kind, ns, "checked")].every((r) => issuers.has(rtpiCanonical(r)))
	)
		return "gate-index-incomplete";
	const positions = new Map<string, string>();
	const revisions = new Map<string, string>();
	for (const e of i.entries) {
		if (!indexEntrySchema(e, s.binding.kind, ns)) return "gate-index-invalid";
		if (!g0Equal(e.issuer, g0Issuer(s.binding.kind, ns, e.stage))) return "gate-index-issuer-mismatch";
		if (e.stage === "live" ? !g0Ref(e.installReceipt, "receipt", ns) : e.installReceipt !== null)
			return "gate-index-invalid";
		if (!active(i, e)) continue; // retired lineage is history, never ranked by timestamps
		const st = i.streams.find((v) => g0Equal(v.issuer, e.issuer));
		if (!st || e.sequence > st.sequence || e.revision > st.revision) return "gate-index-incomplete";
		const streamKey = rtpiCanonical([e.source, e.issuer, e.lineage, e.incarnation]);
		const bytes = rtpiCanonical(e);
		for (const [map, key] of [
			[positions, streamKey + ":s:" + e.sequence],
			[revisions, streamKey + ":r:" + e.revision],
		] as const) {
			const prior = map.get(key);
			if (prior !== undefined && prior !== bytes) return "gate-index-conflict";
			map.set(key, bytes);
		}
	}
	if (Buffer.byteLength(rtpiCanonical(i), "utf8") > 131072) return "gate-index-overflow";
	return null;
}
function active(i: NativeGateIndex, e: NativeGateIndexEntry): boolean {
	return i.streams.some(
		(s) =>
			g0Equal(s.source, e.source) &&
			g0Equal(s.issuer, e.issuer) &&
			g0Equal(s.lineage, e.lineage) &&
			s.incarnation === e.incarnation,
	);
}
function latest(i: NativeGateIndex, predicate: (e: NativeGateIndexEntry) => boolean): NativeGateIndexEntry | null {
	let out: NativeGateIndexEntry | null = null;
	for (const e of i.entries) if (active(i, e) && predicate(e) && (out === null || e.sequence > out.sequence)) out = e;
	return out;
}
function sameEntry(v: RtpiAccepted, e: NativeGateIndexEntry): boolean {
	const m = MINTED.get(v);
	return isRtpiAccepted(v) && v.qualified && m?.entry !== null && m?.entry !== undefined && g0Equal(m.entry, e);
}
function taskLink(
	s: NativeGateState,
): { binding: import("./roles-artifact.js").RolesGateBinding; reference: RtpiRef } | null {
	const l = s.taskLink;
	const ns = s.binding.contract.namespace;
	if (
		s.currentTask === null ||
		!g0Producer(s.currentTask, ns) ||
		s.currentTask.queue === null ||
		!g0Closed(l, ["binding", "resolutions", "receipt"]) ||
		!g0Binding(l.binding) ||
		!g0Equal(g0ProducerOf(l.binding), s.currentTask) ||
		!g0Equal(g0IdentityOf(l.binding), s.binding)
	)
		return null;
	if (
		!Array.isArray(l.resolutions) ||
		l.resolutions.length === 0 ||
		l.resolutions.length > 16 ||
		!l.resolutions.every(g0Identity)
	)
		return null;
	const v = rtpiStructural(l.receipt?.root);
	if (v.status !== "accepted" || v.schema !== "rtpi/event/1") return null;
	const body = v.root.body as Record<string, unknown>;
	if (body.fact !== "gate-observed" || !G0_STAGES.includes(body.stage as RolesLifecycleStage)) return null;
	const matches = l.resolutions.filter(
		(b) =>
			g0Equal((v.root.context as Record<string, unknown>).artifact, g0ArtifactRef(b.artifact, b.contract.namespace)) &&
			g0Equal(body.contract, b.contract) &&
			b.kind === s.binding.kind,
	);
	if (matches.length !== 1 || !g0Equal(matches[0], s.binding)) return null; // FULL key, never HEAD selection
	const stage = body.stage as RolesLifecycleStage;
	if (receiptProblem(l.receipt, s.binding, stage) !== null || !g0Equal(l.receipt.producer, s.currentTask)) return null;
	const qualified = rtpiValidate(l.receipt.root, nativeGateCapability(stage), l.receipt.qualification);
	if (qualified.status !== "accepted" || !qualified.qualified || s.index === null) return null;
	const e = s.index.entries.find(
		(e) =>
			active(s.index as NativeGateIndex, e) &&
			g0Equal(e.reference, l.receipt.reference) &&
			e.digest === qualified.digest,
	);
	if (
		!e ||
		e.stage !== stage ||
		e.sequence !== qualified.root.sequence ||
		e.revision !== qualified.root.revision ||
		e.incarnation !== qualified.root.incarnation ||
		!g0Equal(e.source, qualified.root.source) ||
		!g0Equal(e.issuer, qualified.root.issuer) ||
		!g0Equal(e.lineage, qualified.root.lineage) ||
		!g0Equal(e.producer, s.currentTask) ||
		!g0Equal(e.artifact, g0ArtifactRef(s.binding.artifact, ns)) ||
		!g0Equal(e.contract, s.binding.contract) ||
		e.targetEnvironment !== s.binding.artifact.targetEnvironment
	)
		return null;
	return { binding: l.binding, reference: l.receipt.reference };
}
interface Selection {
	readonly stages: Record<string, RtpiGateStageState>;
	readonly roots: Partial<Record<RolesLifecycleStage, RtpiAccepted>>;
	readonly install: RtpiAccepted | null;
	readonly snapshot: RolesConfirmationSnapshot | null;
}
function select(s: NativeGateState, contract: RtpiAccepted, observations: readonly RtpiAccepted[]): Selection | string {
	const problem = indexProblem(s);
	if (problem !== null) return problem;
	const index = s.index as NativeGateIndex;
	const cm = MINTED.get(contract);
	if (
		!isRtpiAccepted(contract) ||
		!contract.qualified ||
		cm?.stage !== "contract" ||
		!g0Equal(cm.identity, s.binding) ||
		!g0Equal(contract.root, s.contract)
	)
		return "current-qualified-contract-missing";
	if (observations.length > 200) return "gate-index-overflow";
	const link = taskLink(s);
	if (s.currentTask !== null && link === null) return "native-exact-task-link-unavailable";
	const roots: Selection["roots"] = {};
	const stages: Selection["stages"] = {};
	const ns = s.binding.contract.namespace;
	for (const stage of G0_STAGES) {
		const e = latest(
			index,
			(e) =>
				e.stage === stage &&
				g0Equal(e.artifact, g0ArtifactRef(s.binding.artifact, ns)) &&
				g0Equal(e.contract, s.binding.contract),
		);
		const root = e === null ? undefined : observations.find((v) => sameEntry(v, e));
		if (root !== undefined) {
			roots[stage] = root;
			const result = (root.root.body as Record<string, unknown>).result;
			stages[stage] = result === "not-applicable" ? "missing" : (result as RtpiGateStageState);
		} else stages[stage] = e === null ? "missing" : "unknown";
	}
	let install: RtpiAccepted | null = null;
	const pointer = s.latestInstall;
	const latestInstall = latest(
		index,
		(e) =>
			e.stage === "installed" &&
			e.kind === s.binding.kind &&
			e.targetEnvironment === s.binding.artifact.targetEnvironment,
	);
	if (
		g0Closed(pointer, ["identity", "operation", "operationReceipt"]) &&
		g0Identity(pointer.identity) &&
		pointer.identity.kind === s.binding.kind &&
		pointer.identity.artifact.targetEnvironment === s.binding.artifact.targetEnvironment &&
		["install", "rollback"].includes(pointer.operation)
	) {
		const out = operation(pointer.operationReceipt, { ...s, binding: pointer.identity }, "installed");
		if (
			out.verdict?.status === "accepted" &&
			latestInstall !== null &&
			sameEntry(out.verdict, latestInstall) &&
			(out.verdict.root.body as Record<string, unknown>).result === "pass"
		)
			install = out.verdict;
	}
	if (install === null || roots.installed === undefined || !g0Equal(eventRef(roots.installed), eventRef(install)))
		stages.installed = "unknown";
	const live = roots.live === undefined ? undefined : MINTED.get(roots.live)?.entry;
	if (install === null || live === undefined || !g0Equal(live?.installReceipt, eventRef(install)))
		stages.live = "unknown";
	let snapshot: RolesConfirmationSnapshot | null = null;
	if (
		link !== null &&
		install !== null &&
		G0_STAGES.every((stage) => stages[stage] === "pass") &&
		g0Ref(s.projection, "projection", ns) &&
		g0Ref(s.coverage, "coverage", ns) &&
		g0Ref(s.policy, "policy", ns)
	) {
		snapshot = g0Copy({
			binding: link.binding,
			taskReceipt: link.reference,
			gates: G0_STAGES.map((stage) => {
				const v = roots[stage] as RtpiAccepted;
				return { stage, receipt: eventRef(v), producer: (MINTED.get(v)?.entry as NativeGateIndexEntry).producer };
			}),
			installReceipt: eventRef(install),
			projection: s.projection,
			coverage: s.coverage,
			policy: s.policy,
		});
	}
	return { stages, roots, install, snapshot };
}
/** Challenge engine calls this at issue AND answer. No caller pass flags/roots; all four
 * native canonical operations, current link/index/target install are re-derived here. */
export function rolesCurrentConfirmationSnapshot(): RolesConfirmationSnapshot | null {
	const s = source({ enabled: true });
	if ("state" in s) return null;
	const c = rolesRequiredGateContract({ enabled: true });
	if (c.verdict?.status !== "accepted") return null;
	const observations: RtpiAccepted[] = [];
	for (const stage of G0_STAGES) {
		const v = lifecycle(stage, { enabled: true }).verdict;
		if (v?.status !== "accepted") return null;
		observations.push(v);
	}
	const selected = select(s, c.verdict, observations);
	return typeof selected === "string" ? null : selected.snapshot;
}

/** Only O0's process-minted explicit confirm plus its already committed OWN canonical
 * owner-action source. Challenge consumption/commit atomicity is absent in production. */
export function rolesArtifactConfirmation(
	receipt: OwnerActionReceipt,
	receiptRef: RtpiRef,
	options: RolesGateOptions = {},
): RolesGateResult {
	const s = source(options);
	if ("state" in s) return s;
	if (!isOwnerActionReceipt(receipt) || receipt.action !== "confirm")
		return refusal("explicit-handler-confirm-required");
	const snapshot = rolesCurrentConfirmationSnapshot();
	if (
		snapshot === null ||
		!g0Binding(receipt.gateBinding) ||
		!g0Equal(receipt.gateBinding, snapshot.binding) ||
		!g0Equal(receipt.gateSnapshot, snapshot)
	)
		return refusal("confirm-current-passing-roots-required", "unknown");
	if (!g0Ref(receiptRef, "receipt", s.binding.contract.namespace)) return refusal("confirmation-receipt-ref-invalid");
	const committed = nativeGateConfirmationSource();
	if (committed === null) return refusal("client-native-confirmation-source-missing", "unavailable");
	if (
		!g0Closed(committed, ["envelope", "qualification", "root"]) ||
		!g0Equal(committed.envelope.issuer, g0Issuer(s.binding.kind, s.binding.contract.namespace, "owner-confirmed"))
	)
		return refusal("client-native-confirmation-issuer-required");
	const context = {
		queue: snapshot.binding.queue,
		taskId: snapshot.binding.taskId,
		planRevision: snapshot.binding.planRevision,
		session: receipt.session,
		epoch: null,
		turn: null,
		run: snapshot.binding.run,
		attempt: snapshot.binding.attempt,
		recipient: null,
		channel: "browser",
		action: { ...receipt.challenge, kind: "operation", id: "confirm:" + receipt.challenge.id },
		artifact: receipt.artifact,
		owner: receipt.principal,
		client: receipt.client,
		window: receipt.window,
		projection: receipt.projection,
		coverage: receipt.coverage,
		policy: receipt.policy,
		challenge: receipt.challenge,
	};
	const root = {
		schema: "rtpi/event/1",
		...committed.envelope,
		context,
		body: {
			fact: "artifact-confirmed",
			status: "known",
			receipt: receiptRef,
			clientRole: "owner",
			issuedAt: receipt.issuedAt,
			expiresAt: receipt.expiresAt,
			serverNow: receipt.serverNow,
			mode: "new",
			refs: snapshot.gates.map((g) => g.receipt),
		},
	};
	const structural = rtpiStructural(committed.root);
	if (structural.status !== "accepted" || !g0Equal(structural.root, root))
		return refusal("client-native-atomic-confirmation-root-mismatch");
	if (
		!g0Equal(receipt.artifact, g0ArtifactRef(s.binding.artifact, s.binding.contract.namespace)) ||
		!g0Equal(receipt.projection, snapshot.projection) ||
		!g0Equal(receipt.coverage, snapshot.coverage) ||
		!g0Equal(receipt.policy, snapshot.policy)
	)
		return refusal("confirm-current-projection-mismatch");
	return mint(
		committed.root,
		{ ...s, qualification: committed.qualification },
		"owner-confirmed",
		undefined,
		null,
		snapshot,
	);
}
export interface RolesLifecycleCoverage extends RtpiGateCoverage {
	readonly nativeLifecycle: boolean;
	readonly ownerConfirmed: boolean;
	readonly synthetic: boolean;
	readonly scope: "artifact" | "task";
	readonly liveMeasuredAt: number | null;
	readonly history: readonly {
		readonly stage: string;
		readonly receipt: RtpiRef;
		readonly retiredBy: RtpiRef | null;
		readonly observedAt: number | null;
	}[];
}
export function rolesArtifactCoverage(
	contract: RtpiAccepted | null,
	observations: readonly RtpiAccepted[],
	confirmations: readonly RtpiAccepted[],
): RolesLifecycleCoverage {
	const unknown = (reason: string): RolesLifecycleCoverage => ({
		state: "unknown",
		stages: NONE,
		reason,
		nativeLifecycle: false,
		ownerConfirmed: false,
		synthetic: false,
		scope: "task",
		liveMeasuredAt: null,
		history: [],
	});
	const s = nativeGateState();
	if (s === null) return unknown("native-outbox-issuer-missing");
	const problem = contractProblem(s);
	if (problem !== null) return unknown(problem);
	if (!isRtpiAccepted(contract)) return unknown("current-qualified-contract-missing");
	if (observations.length + confirmations.length > 200) return unknown("gate-index-overflow");
	const selected = select(s, contract, observations);
	if (typeof selected === "string") return unknown(selected);
	const stages: Record<string, RtpiGateStageState> = { ...selected.stages, "owner-confirmed": "missing" };
	const index = s.index as NativeGateIndex;
	const current = selected.snapshot;
	const latestConfirm =
		current === null
			? null
			: latest(
					index,
					(e) =>
						e.stage === "owner-confirmed" &&
						g0Equal(e.artifact, g0ArtifactRef(s.binding.artifact, s.binding.contract.namespace)) &&
						g0Equal(e.contract, s.binding.contract) &&
						g0Equal(e.producer, g0ProducerOf(current.binding)),
				);
	const confirmation =
		latestConfirm === null
			? undefined
			: confirmations.find((v) => sameEntry(v, latestConfirm) && g0Equal(MINTED.get(v)?.snapshot, current));
	if (confirmation !== undefined) stages["owner-confirmed"] = "pass";
	else if (latestConfirm !== null) stages["owner-confirmed"] = "unknown";
	const history: RolesLifecycleCoverage["history"][number][] = [];
	for (const v of [...observations, ...confirmations]) {
		const m = MINTED.get(v);
		if (
			!isRtpiAccepted(v) ||
			!m?.entry ||
			!g0Equal(m.identity, s.binding) ||
			!["installed", "live", "owner-confirmed"].includes(m.stage)
		)
			continue;
		const chosen = m.stage === "owner-confirmed" ? confirmation : selected.roots[m.stage as RolesLifecycleStage];
		if (v === chosen && stages[m.stage] === "pass") continue;
		history.push({
			stage: m.stage,
			receipt: m.entry.reference,
			retiredBy: selected.install === null ? null : eventRef(selected.install),
			observedAt: selected.install === null ? null : (selected.install.root.occurredAt as number),
		});
	}
	const values = Object.values(stages);
	const state = values.includes("fail")
		? "failed"
		: values.includes("unknown")
			? "unknown"
			: values.every((v) => v === "pass")
				? "complete"
				: "incomplete";
	const native = contract.namespace === "rtpi-native";
	return g0Copy({
		state,
		stages,
		reason: state === "complete" ? "exact-current-artifact-complete" : "current-required-gates-not-passing",
		nativeLifecycle: native && state === "complete",
		ownerConfirmed: native && stages["owner-confirmed"] === "pass",
		synthetic: !native,
		scope: s.currentTask === null ? "artifact" : "task",
		liveMeasuredAt:
			stages.live === "pass" && selected.roots.live ? (selected.roots.live.root.occurredAt as number) : null,
		history,
	});
}
