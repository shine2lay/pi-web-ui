/** Component A: explicit injected adapters only. Never registers a tool, ask, transport or store.
 * Native ports below are REQUIRED future host capabilities, not implementations of authentication.
 * E alone owns first-answer arbitration, requests, grants, quotas, control delivery and replay.
 */
import { createHash } from "node:crypto";
import type { Ask } from "./asks.js";
import type {
	GuardActor,
	GuardApprovalBinding,
	GuardApprovalContext,
	GuardChoice,
	GuardConsumerBinding,
	GuardCoordinator,
	GuardHostVerified,
	GuardHostVerifier,
	GuardInvocationReference,
	GuardOperationIdentity,
	GuardOwnerAnswerReference,
	GuardOwnerQuestion,
	GuardPolicyV1,
	GuardQuantity,
	GuardRequest,
	GuardResult,
	GuardRoleChoice,
	GuardScope,
	GuardStatusResult,
	GuardTime,
	GuardTransportResult,
	GuardVerification,
	GuardVerifiedSnapshot,
} from "./role-message-guard-contract.js";

export interface GuardApprovalNativePort {
	/** Fresh trusted time. Never accepts an agent/browser clock. E rechecks under its writer. */
	time(): Promise<GuardTime>;
	/** Resolve original request's destination and snapshot from native state, not caller fields.
	 * Initial -> selected current home (or native Owner route); decision -> original requester.
	 * Verify caller's current binding and request visibility/authority. Preserve original causal root.
	 */
	control(
		actor: GuardHostVerified<GuardActor>,
		request: GuardRequest,
		phase: "initial" | "decision",
	): Promise<GuardVerification<{ to: string; snapshot: GuardHostVerified<GuardVerifiedSnapshot> }>>;
	/** Durable create-or-read SAME question for request+generation; exact binding/context/choices.
	 * Neither a copied question ID nor AskHub's `from` string is an authenticated answer.
	 */
	question(request: GuardRequest, choicesDigest: string): Promise<GuardVerification<GuardOwnerQuestion>>;
	/** Lookup the live durable request bound to a native answer event. No caller-provided request. */
	ownerRequest(reference: GuardOwnerAnswerReference): Promise<GuardVerification<GuardRequest>>;
	/** Revalidate holds/time/permissions and committed control identity immediately before showing.
	 * Same-key question/wake dedup, first-answer arbitration and reconnect recovery are mandatory.
	 * Never falls back from an unauthorised Telegram plugin to another channel.
	 */
	present(
		question: GuardOwnerQuestion,
		ask: Ask,
		committedControl: Extract<GuardResult, { state: "accepted" }>,
	): Promise<GuardTransportResult>;
}

export interface GuardApprovalPorts {
	readonly binding: GuardConsumerBinding;
	readonly policy: GuardPolicyV1;
	readonly maximumContextBytes: number;
	readonly host: GuardHostVerifier;
	readonly core: GuardCoordinator;
	readonly native: GuardApprovalNativePort;
}
export type GuardAdapterFailure = {
	readonly state: "invalid" | "unavailable" | "context_needed";
	readonly reason: string;
};
export type GuardAdapterOutcome = GuardResult | GuardAdapterFailure;

/** Stable plain-data digest shared with the injected native question binding. Not authentication. */
export function approvalDigest(value: unknown): string {
	function canonical(v: unknown): string {
		if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
		if (v !== null && typeof v === "object") {
			const o = v as Record<string, unknown>;
			return `{${Object.keys(o)
				.sort()
				.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
				.join(",")}}`;
		}
		return JSON.stringify(v) ?? "null";
	}
	return createHash("sha256").update(canonical(value)).digest("hex");
}
const choices = ["deny", "one_send", "requested_quantity"] as const;
const text = (v: unknown): v is string =>
	typeof v === "string" && v.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown, minimum = 0): v is string[] => Array.isArray(v) && v.length >= minimum && v.every(text);
const quantity = (v: unknown): v is GuardQuantity => Number.isSafeInteger(v) && Number(v) >= 1 && Number(v) <= 5;
const same = (a: unknown, b: unknown) => approvalDigest(a) === approvalDigest(b);
const invalid = (reason: string): GuardAdapterFailure => ({ state: "invalid", reason });
const unavailable = (reason: string): GuardAdapterFailure => ({ state: "unavailable", reason });
function failure<T>(v: Exclude<GuardVerification<T>, { state: "verified" }>): GuardAdapterFailure {
	return v.state === "invalid" ? invalid(v.reason) : unavailable(v.reason);
}
function keys(o: Record<string, unknown>, expected: readonly string[]): boolean {
	return Object.keys(o).length === expected.length && expected.every((k) => Object.hasOwn(o, k));
}

/** Structural completeness only; declared prose does not establish truth or permission. Never clips. */
export function completeApprovalContext(value: unknown, maximumBytes: number): value is GuardApprovalContext {
	if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || !object(value)) return false;
	if (
		!keys(value, [
			"goal",
			"progressAndChanges",
			"priorDecisions",
			"whyNeeded",
			"nextStepAndOutcome",
			"outstandingQuestions",
			"optionsAndTradeoffs",
			"timeCostRisk",
			"exactCommunicationAuthority",
			"nativeFacts",
			"declaredClaims",
			"safetyScopeAndHolds",
		])
	)
		return false;
	if (
		![
			value.goal,
			value.progressAndChanges,
			value.whyNeeded,
			value.nextStepAndOutcome,
			value.timeCostRisk,
			value.exactCommunicationAuthority,
		].every(text)
	)
		return false;
	if (
		!strings(value.priorDecisions) ||
		!strings(value.outstandingQuestions, 1) ||
		!strings(value.optionsAndTradeoffs, 2) ||
		!strings(value.declaredClaims) ||
		!strings(value.safetyScopeAndHolds, 1)
	)
		return false;
	if (
		!Array.isArray(value.nativeFacts) ||
		!value.nativeFacts.every(
			(f: unknown) =>
				object(f) &&
				keys(f, ["sourceId", "sourceVersion", "sourceIncarnation", "eventId", "revision", "digest", "observedAt"]) &&
				[f.sourceId, f.sourceVersion, f.sourceIncarnation, f.eventId, f.revision, f.digest].every(text) &&
				Number.isSafeInteger(f.observedAt) &&
				Number(f.observedAt) >= 0,
		)
	)
		return false;
	return Buffer.byteLength(JSON.stringify(value), "utf8") <= maximumBytes;
}
function validScope(value: unknown, actor: GuardActor): value is GuardScope {
	return (
		object(value) &&
		keys(value, ["scopeId", "operation", "participants", "recipients", "task"]) &&
		text(value.scopeId) &&
		text(value.operation) &&
		strings(value.participants, 1) &&
		strings(value.recipients, 1) &&
		same(value.task, actor.task) &&
		value.participants.includes(actor.role)
	);
}
function trustedTime(t: GuardTime): boolean {
	return (
		t.state === "trusted" &&
		Number.isSafeInteger(t.nowMs) &&
		Number.isSafeInteger(t.lastObservedMs) &&
		t.lastObservedMs >= 0 &&
		t.nowMs >= t.lastObservedMs
	);
}
function identity(
	actor: GuardActor,
	action: string,
	key: unknown,
	invocation: GuardInvocationReference | GuardOwnerAnswerReference,
): GuardOperationIdentity {
	return {
		version: "role-message-guard/v1",
		actor,
		operationId: approvalDigest({ action, key, invocation }),
		fingerprint: approvalDigest({ action, key, actor }),
	};
}
function questionDigest(request: GuardRequest): string {
	return approvalDigest({ binding: request.binding, detail: request.context, choices });
}

/** Exact finite native Ask descriptor. No multi-select, custom prose or Auto approve route. */
export function ownerApprovalAsk(q: GuardOwnerQuestion, createdAt: number): Ask {
	const c = q.detail;
	const escape = (s: string) => s.replace(/[&<>]/gu, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]!);
	const detail = escape(
		JSON.stringify(
			{
				goal: c.goal,
				progressAndChanges: c.progressAndChanges,
				priorDecisions: c.priorDecisions,
				whyNeeded: c.whyNeeded,
				outstandingQuestions: c.outstandingQuestions,
				optionsAndTradeoffs: c.optionsAndTradeoffs,
				timeCostRisk: c.timeCostRisk,
				nextStepAndOutcome: c.nextStepAndOutcome,
				exactCommunicationAuthority: c.exactCommunicationAuthority,
				nativeFacts: c.nativeFacts,
				declaredClaims: c.declaredClaims,
				safetyScopeAndHolds: c.safetyScopeAndHolds,
				binding: q.binding,
				authorityLimit:
					"Communication only; original root and scope; finite uses; one hour maximum; no automatic business send. Holds, 20/hour, access and consent still apply. This is not action, spending, installation or hold-lift authority.",
			},
			null,
			2,
		),
	);
	return {
		id: q.questionId,
		kind: "question",
		title: "Message continuation: Owner decision",
		createdAt,
		fields: [
			{
				id: q.generation,
				text: "Allow this finite communication continuation?",
				detail,
				multi: false,
				allowText: false,
				options: [
					{ value: "deny", label: "Deny", description: "No additional business message." },
					{
						value: "one_send",
						label: "Allow one send",
						description: "One send within the exact scope and hop bound; no automatic send.",
					},
					{
						value: "requested_quantity",
						label: `Allow up to ${q.binding.quantity} sends`,
						description: `At most ${q.binding.quantity} sends through hop ${q.binding.upperHop}; no other authority.`,
					},
				],
			},
		],
	};
}

export function createGuardApprovalAdapters(ports: GuardApprovalPorts) {
	const { host, core, native, policy } = ports;
	// Refuse an incompatible consumer; all three pins are the frozen dependency, not a policy fork.
	const compatible =
		ports.binding.version === "role-message-guard/v1" &&
		ports.binding.contractCommit === "04fe491fb3afc3b42462ad782b2099c7971c7008" &&
		ports.binding.contractSha256 === "79a5a1e1a704ecfbb36a70fc1b210ee6e27575013843122cf202a84592b4c7af" &&
		ports.binding.policyDocumentSha256 === "5d8433fd0a8f9a82103009e43491182caf14b80ad2a20b874709c5b3762724a9" &&
		policy.version === "role-message-guard/v1" &&
		policy.depth.unapprovedThrough === 6 &&
		policy.depth.lowerThrough === 11 &&
		policy.depth.ownerFrom === 12 &&
		policy.grant.maximumBusinessSends === 5 &&
		policy.grant.lifetimeMs === 3600000 &&
		policy.ordinary.acceptedPerOrigin === 20 &&
		policy.ordinary.rollingWindowMs === 3600000;
	async function actorOf(ref: GuardInvocationReference) {
		if (!compatible) return unavailable("Frozen contract/policy pin mismatch");
		const result = await host.verifyInvocation(ref);
		return result.state === "verified" ? result.value : failure(result);
	}
	async function read(
		ref: GuardInvocationReference,
		requestId: string,
		generation: string,
	): Promise<GuardStatusResult | GuardAdapterFailure> {
		if (!text(requestId) || !text(generation)) return invalid("Request ID and generation required");
		const actor = await actorOf(ref);
		if ("state" in actor) return actor;
		// E must authorise visibility; copied IDs alone cannot read or decide another request.
		return core.status(actor, requestId, generation);
	}
	async function request(
		ref: GuardInvocationReference,
		input: { binding: unknown; context: unknown; quantity: unknown },
	): Promise<GuardAdapterOutcome> {
		const actor = await actorOf(ref);
		if ("state" in actor) return actor;
		if (!completeApprovalContext(input.context, ports.maximumContextBytes))
			return { state: "context_needed", reason: "Complete bounded context required; no truncation" };
		if (
			!quantity(input.quantity) ||
			!object(input.binding) ||
			!keys(input.binding, ["requestId", "generation", "scope"]) ||
			!text(input.binding.requestId) ||
			!text(input.binding.generation) ||
			!validScope(input.binding.scope, actor)
		)
			return invalid("Exact request/generation/scope and finite quantity required");
		const causal = await host.verifyCausality(actor);
		if (causal.state !== "verified") return failure(causal);
		const hop = causal.value.nextHop;
		if (
			!Number.isSafeInteger(hop) ||
			hop <= policy.depth.unapprovedThrough ||
			hop > Number.MAX_SAFE_INTEGER - input.quantity
		)
			return invalid("Approval requires a known safe business hop above six");
		const time = await native.time();
		if (!trustedTime(time) || !Number.isSafeInteger(time.nowMs + policy.request.lifetimeMs))
			return unavailable("Trusted clock required");
		const binding: GuardApprovalBinding = {
			version: policy.version,
			requestId: input.binding.requestId,
			generation: input.binding.generation,
			requester: actor,
			causal: causal.value,
			scope: input.binding.scope,
			quantity: input.quantity,
			tier: hop >= policy.depth.ownerFrom ? "owner" : "lower",
			upperHop: hop + input.quantity - 1,
		};
		const selected = await host.selectApprover(binding);
		if (selected.state !== "verified") return failure(selected);
		if (hop >= policy.depth.ownerFrom && selected.value.tier !== "owner")
			return unavailable("Lower authority cannot reach hop twelve");
		if (
			selected.value.tier === "lower" &&
			(!selected.value.home.currentHome ||
				selected.value.home.task.kind !== "home" ||
				selected.value.home.role !== selected.value.role ||
				selected.value.role === actor.role ||
				selected.value.home.sessionFile === actor.sessionFile ||
				!["coo", "existing_authorised_lead"].includes(selected.value.route) ||
				(selected.value.route === "coo" && selected.value.role !== "coo"))
		)
			return unavailable("Distinct selected current-home approver required; otherwise native Owner fallback");
		const resolved = {
			...binding,
			tier: selected.value.tier,
			upperHop:
				selected.value.tier === "lower" ? Math.min(binding.upperHop, policy.depth.lowerThrough) : binding.upperHop,
		};
		const record: GuardRequest = {
			binding: resolved,
			context: input.context,
			selectedApprover: selected.value,
			createdAt: time.nowMs,
			expiresAt: time.nowMs + policy.request.lifetimeMs,
			state: resolved.tier === "owner" ? "awaiting_owner" : "awaiting_approver",
			upwardEscalations: 0,
			initialNotificationKey: approvalDigest([resolved, "initial"]),
			decisionNotificationKey: approvalDigest([resolved, "decision"]),
			firstDecision: null,
			grantId: null,
		};
		return core.execute({
			kind: "request_record",
			actor,
			identity: identity(actor, "request", record, ref),
			request: record,
		});
	}
	async function roleDecision(
		ref: GuardInvocationReference,
		input: { requestId: string; generation: string; choice: GuardRoleChoice; reason: string },
	): Promise<GuardAdapterOutcome> {
		if (![...choices, "escalate_owner"].includes(input.choice) || !text(input.reason))
			return invalid("Finite choice and reason required");
		const found = await read(ref, input.requestId, input.generation);
		if (found.state !== "found") return unavailable("Current visible request required");
		const r = found.request;
		const actor = await actorOf(ref);
		if ("state" in actor) return actor;
		if (
			r.binding.tier !== "lower" ||
			r.selectedApprover.tier !== "lower" ||
			r.binding.upperHop > policy.depth.lowerThrough ||
			!actor.currentHome ||
			actor.task.kind !== "home" ||
			!same(actor, r.selectedApprover.home) ||
			actor.role === r.binding.requester.role
		)
			return invalid("Only the selected distinct current-home lower approver may decide");
		const time = await native.time();
		if (!trustedTime(time) || time.nowMs >= r.expiresAt) return unavailable("Request expired or clock unavailable");
		const verified = await host.verifyRoleDecision({ invocation: ref, ...input }, r.binding);
		if (verified.state !== "verified") return failure(verified);
		const d = verified.value;
		if (
			!same(d.binding, r.binding) ||
			d.choice !== input.choice ||
			d.authority.tier !== "lower" ||
			!same(d.authority.selection, r.selectedApprover)
		)
			return invalid("Verified decision binding/selected authority mismatch");
		return core.execute({ kind: "decision_record", identity: identity(actor, "role_decision", d, ref), decision: d });
	}
	/** HOST-ONLY callback, never a GuardUntrustedInput/tool. Native event reference alone is not proof. */
	async function nativeOwnerAnswer(ref: GuardOwnerAnswerReference): Promise<GuardAdapterOutcome> {
		if (!compatible) return unavailable("Frozen contract/policy pin mismatch");
		const current = await native.ownerRequest(ref);
		if (current.state !== "verified") return failure(current);
		const r = current.value;
		if (r.binding.tier !== "owner") return unavailable("Current Owner-tier request required");
		const question = await native.question(r, questionDigest(r));
		if (question.state !== "verified") return failure(question);
		const q = question.value;
		if (
			!same(q.binding, r.binding) ||
			!same(q.detail, r.context) ||
			!same(q.choices, choices) ||
			q.choicesDigest !== questionDigest(r) ||
			q.questionId !== ref.questionId ||
			q.generation !== ref.generation ||
			!completeApprovalContext(q.detail, ports.maximumContextBytes)
		)
			return invalid("Native question/binding/context/choice digest mismatch");
		const verified = await host.verifyOwnerAnswer(ref, q);
		if (verified.state !== "verified") return failure(verified);
		const d = verified.value;
		const time = await native.time();
		if (
			!trustedTime(time) ||
			time.nowMs >= r.expiresAt ||
			!Number.isSafeInteger(d.answeredAt) ||
			d.answeredAt < r.createdAt ||
			d.answeredAt > time.nowMs
		)
			return unavailable("Expired/stale answer or untrusted time");
		if (
			!same(d.binding, q.binding) ||
			!choices.includes(d.choice as GuardChoice) ||
			d.firstAnswerEventId !== ref.nativeAnswerEventId ||
			d.authority.tier !== "owner" ||
			d.authority.questionId !== q.questionId ||
			d.authority.questionGeneration !== q.generation ||
			d.authority.choicesDigest !== q.choicesDigest ||
			!text(d.authority.source.authenticatedOwnerBindingId) ||
			!["authenticated_browser", "authorised_owner_telegram"].includes(d.authority.source.kind) ||
			(d.authority.source.kind === "authorised_owner_telegram" && !text(d.authority.source.pluginId))
		)
			return invalid("Actual native authenticated Owner event required");
		return core.execute({
			kind: "decision_record",
			identity: identity(r.binding.requester, "owner_decision", d, ref),
			decision: d,
		});
	}
	/** An explicit control attempt, not a business send. Core owns dedup, 20/hour and all holds. */
	async function notify(
		ref: GuardInvocationReference,
		requestId: string,
		generation: string,
		phase: "initial" | "decision",
	): Promise<GuardAdapterOutcome | GuardTransportResult> {
		if (phase !== "initial" && phase !== "decision") return invalid("Finite control phase required");
		const found = await read(ref, requestId, generation);
		if (found.state !== "found") return unavailable("Current visible request required");
		const r = found.request;
		if (
			(phase === "initial" && !["awaiting_owner", "awaiting_approver"].includes(r.state)) ||
			(phase === "decision" && r.firstDecision === null)
		)
			return invalid("Control phase does not match current request");
		const actor = await actorOf(ref);
		if ("state" in actor) return actor;
		const control = await native.control(actor, r, phase);
		if (control.state !== "verified") return failure(control);
		if (
			!same(control.value.snapshot.actor, actor) ||
			!same(control.value.snapshot.causal, r.binding.causal) ||
			!text(control.value.to)
		)
			return invalid("Control must preserve native actor and original business causality");
		const result = await core.execute({
			kind: "control_send",
			identity: identity(actor, "control", [r.binding, phase], ref),
			snapshot: control.value.snapshot,
			requestId,
			generation,
			phase,
			to: control.value.to,
		});
		if (
			phase !== "initial" ||
			r.binding.tier !== "owner" ||
			result.state !== "accepted" ||
			!["dispatched", "handled"].includes(result.delivery)
		)
			return result;
		if (
			result.receipt.class !== "control" ||
			!same(result.receipt.causal, r.binding.causal) ||
			result.receipt.usage.ordinaryOrigin !== 1 ||
			result.receipt.usage.grantBusinessUse !== 0
		)
			return unavailable("Committed ordinary control receipt required");
		const question = await native.question(r, questionDigest(r));
		if (question.state !== "verified") return failure(question);
		const q = question.value;
		if (
			!same(q.binding, r.binding) ||
			!same(q.detail, r.context) ||
			!same(q.choices, choices) ||
			q.choicesDigest !== questionDigest(r) ||
			!text(q.questionId) ||
			!text(q.generation)
		)
			return invalid("Exact native Owner question required");
		return native.present(q, ownerApprovalAsk(q, r.createdAt), result);
	}
	return { agent: { request, status: read, roleDecision, notify }, native: { ownerAnswer: nativeOwnerAnswer } };
}
