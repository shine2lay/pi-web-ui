/** IB3 (#167). INERT, read-only initiative/outcome dimensions over Q0/M0/R0/G0 results.
 * Receipt definitions, replay, holds, message processing, origin classification and gates stay in Roles.
 * No native issuer, store, registration, controller, timer or production importer. Exact dependency pins and
 * requalification tests: tests/fixtures/initiatives-adapter-cases.json. Local display bindings are NOT authority.
 */
import { isRtpiAccepted, rtpiCanonical, type RtpiAccepted, type RtpiRef } from "./rtpi-core.js";
import {
	INITIATIVES_ENABLED,
	initiativesContractRef,
	type InitiativeCause,
	type InitiativeExecutionV1,
	type OutcomeContractV1,
} from "./initiatives-registry.js";
import type { RolesQueueInput, RolesQueueSnapshot } from "./roles-queue.js";
import type { RolesMessageResult } from "./roles-messages.js";
import type { RolesOriginKey, RolesOriginQueue, RolesOriginResult } from "./roles-origin.js";
import type { RolesGateResult } from "./roles-gates.js";
import { g0ArtifactRef } from "./roles-artifact.js";

export const INITIATIVES_ADAPTERS_ENABLED = INITIATIVES_ENABLED;
export interface InitiativesAdapterOptions {
	readonly enabled?: boolean;
}
export interface InitiativesAdapterScope {
	/** One already selected immutable IB1 publication, never a mutable mirror tail. */
	readonly execution: RtpiAccepted | null;
	readonly contracts: readonly RtpiAccepted[];
}
export interface InitiativesFactBinding {
	readonly state: "off" | "linked" | "unlinked" | "unknown";
	readonly reason: string;
	readonly capture: "known" | "unknown";
	readonly initiative: RtpiRef | null;
	readonly work: RtpiRef | null;
	readonly assignment: RtpiRef | null;
	readonly outcomeState: "linked" | "unlinked" | "unknown";
	readonly outcomes: readonly { readonly reference: RtpiRef; readonly contract: RtpiAccepted | null }[];
	/** Only IB1's typed, published #87 cause facts; absent is unknown, never 'not stalled'. */
	readonly stall: { readonly state: "known" | "unknown"; readonly causes: readonly InitiativeCause[] };
}
const equal = (a: unknown, b: unknown): boolean => rtpiCanonical(a) === rtpiCanonical(b);
const absent = (reason: string, state: InitiativesFactBinding["state"] = "unknown"): InitiativesFactBinding => ({
	state,
	reason,
	capture: "unknown",
	initiative: null,
	work: null,
	assignment: null,
	outcomeState: "unknown",
	outcomes: [],
	stall: { state: "unknown", causes: [] },
});
const off = (options: InitiativesAdapterOptions) => options.enabled !== true;
function event(v: RtpiAccepted | null | undefined): v is RtpiAccepted {
	return isRtpiAccepted(v) && v.qualified && v.schema === "rtpi/event/1";
}
function context(v: RtpiAccepted): Readonly<Record<string, unknown>> {
	return v.root.context as Readonly<Record<string, unknown>>;
}
function body(v: RtpiAccepted): Readonly<Record<string, unknown>> {
	return v.root.body as Readonly<Record<string, unknown>>;
}

/** ONLY the extra dimension: exact whole work refs -> named IB1 contribution -> exact outcome contracts.
 * No role membership, slug, title, prose, timestamps, approval or receipt status guesses a work assignment.
 * A positive source fact survives a missing/truncated display tail; callers never supply that tail here.
 */
function bind(
	receipt: RtpiAccepted | null,
	work: RtpiRef | null,
	scope: InitiativesAdapterScope,
	artifact: RtpiRef | null = null,
): InitiativesFactBinding {
	if (!event(receipt)) return absent("source-receipt-unavailable");
	if (work === null) return absent("source-work-unbound");
	const e = scope.execution;
	if (!isRtpiAccepted(e) || !e.qualified || e.schema !== "rtpi/initiative-execution/1")
		return absent("initiative-publication-unavailable");
	const execution = e.root as unknown as InitiativeExecutionV1;
	if (e.namespace !== receipt.namespace || work.namespace !== e.namespace)
		return absent("initiative-namespace-mismatch");
	const matches = execution.contributions.filter((c) => equal(c.work, work));
	if (matches.length === 0)
		return {
			...absent(
				execution.completeness.contributions === "complete" ? "work-unlinked" : "work-capture-unknown",
				execution.completeness.contributions === "complete" ? "unlinked" : "unknown",
			),
			capture: "known",
			work,
		};
	if (matches.length !== 1) return absent("initiative-work-conflict");
	const contribution = matches[0];
	if (scope.contracts.length > 64) return absent("outcome-resolution-overflow");
	const outcomes = contribution.outcomes.map((reference) => {
		const found = new Map<string, RtpiAccepted>();
		for (const c of scope.contracts) {
			if (!isRtpiAccepted(c) || !c.qualified || c.schema !== "rtpi/outcome-contract/1" || c.namespace !== e.namespace)
				continue;
			const contract = c.root as unknown as OutcomeContractV1;
			if (!equal(initiativesContractRef(contract), reference) || !equal(contract.initiative, execution.initiative))
				continue;
			// IB1 and G0 intentionally encode artifact refs differently. Convert the qualified six-field
			// IB1 key through G0's own helper; never compare their ref strings or use HEAD/ancestry.
			if (artifact !== null && !equal(g0ArtifactRef(contract.artifact, c.namespace), artifact)) continue;
			found.set(c.canonical, c);
		}
		return { reference, contract: found.size === 1 ? [...found.values()][0] : null };
	});
	const causes = execution.causes.filter((c) => equal(c.subject, work) || equal(c.subject, execution.initiative));
	return {
		state: "linked",
		reason: "explicit-published-work-binding",
		capture: "known",
		initiative: execution.initiative,
		work,
		assignment: contribution.assignment,
		outcomeState:
			outcomes.length === 0 ? "unlinked" : outcomes.every((o) => o.contract !== null) ? "linked" : "unknown",
		outcomes,
		stall: { state: causes.length > 0 ? "known" : "unknown", causes },
	};
}

/** Preserve M0's result verbatim: delivery is not inclusion/processing. Settlement alone has no message identity. */
export function initiativesMessageBinding(
	source: RolesMessageResult,
	scope: InitiativesAdapterScope,
	options: InitiativesAdapterOptions = {},
) {
	const v = source.verdict;
	const accepted = v?.status === "accepted" && event(v) && String(body(v).fact).startsWith("message-");
	return {
		source,
		binding: off(options)
			? absent("initiatives-adapters-off", "off")
			: bind(accepted ? v : null, accepted ? (context(v).action as RtpiRef | null) : null, scope),
	};
}

/** Preserve R0's classification, including unclassified. Initiative membership is never a request. */
export function initiativesOriginBinding(
	source: RolesOriginResult,
	scope: InitiativesAdapterScope,
	options: InitiativesAdapterOptions = {},
) {
	const v = source.verdict;
	const accepted = v?.status === "accepted" && event(v) && body(v).fact === "origin-classified";
	return {
		source,
		binding: off(options)
			? absent("initiatives-adapters-off", "off")
			: bind(accepted ? v : null, accepted ? (context(v).action as RtpiRef | null) : null, scope),
	};
}

/** G0 alone decides the stage/result. Its OWN producing run is the work, not a requesting task's run.
 * Association is not completion: required stages/acceptances remain IB1's initiativesOutcomeCompletion.
 */
export function initiativesArtifactBinding(
	source: RolesGateResult,
	scope: InitiativesAdapterScope,
	options: InitiativesAdapterOptions = {},
) {
	const v = source.verdict;
	const accepted =
		v?.status === "accepted" && event(v) && ["gate-observed", "artifact-confirmed"].includes(String(body(v).fact));
	return {
		source,
		binding: off(options)
			? absent("initiatives-adapters-off", "off")
			: bind(
					accepted ? v : null,
					accepted ? (context(v).run as RtpiRef | null) : null,
					scope,
					accepted ? (context(v).artifact as RtpiRef | null) : null,
				),
	};
}

/** Q0 owns the FULL canonical DTO (including held rows). Generic pass-through retains that exact type/object;
 * no duplicate QueueProjection/row/hold definitions or mirror replay. R0 supplies the native task operation.
 * The uncapped Q0 identity index is used, never the pending/recent-done display windows.
 */
export function initiativesQueueTaskBinding<T extends RolesQueueInput & RolesOriginQueue>(
	projection: T,
	key: RolesOriginKey,
	receipt: RolesQueueSnapshot,
	origin: RolesOriginResult,
	scope: InitiativesAdapterScope,
	options: InitiativesAdapterOptions = {},
) {
	const rows = projection.index.filter((row) => equal(row.key, key));
	const task = rows.length === 1 ? rows[0] : null;
	const result = (binding: InitiativesFactBinding) => ({ projection, task, receipt, origin, binding });
	if (off(options)) return result(absent("initiatives-adapters-off", "off"));
	const q = receipt.verdict;
	const o = origin.verdict;
	if (
		projection.queueCoverage !== "complete" ||
		task === null ||
		!projection.binding ||
		projection.revision === null ||
		q?.status !== "accepted" ||
		!event(q) ||
		body(q).fact !== "queue-snapshot" ||
		o?.status !== "accepted" ||
		!event(o) ||
		body(o).fact !== "origin-classified" ||
		q.namespace !== o.namespace
	)
		return result(absent("canonical-task-capture-unavailable"));
	const b = projection.binding;
	const ns = q.namespace;
	const ref = (kind: string, id: string, revision: string): RtpiRef => ({ namespace: ns, kind, id, revision });
	const queue = ref("queue", b.queueId, projection.revision);
	const session = ref("session", b.sessionId, b.branchId);
	const epoch = ref("epoch", b.sessionEpoch, String(b.homeRevision));
	const { taskId: _taskId, planRevision: _planRevision, ...binding } = key;
	if (
		!equal(binding, b) ||
		![q, o].every(
			(v) => equal(context(v).queue, queue) && equal(context(v).session, session) && equal(context(v).epoch, epoch),
		) ||
		context(o).taskId !== key.taskId ||
		context(o).planRevision !== key.planRevision
	)
		return result(absent("canonical-task-binding-mismatch"));
	return result(bind(o, context(o).action as RtpiRef | null, scope));
}
