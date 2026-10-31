/** Component A: explicit injected adapters only. Never registers a tool, ask, transport or store.
 * Native ports below are REQUIRED future host capabilities, not implementations of authentication.
 * E alone owns first-answer arbitration, requests, grants, quotas, control delivery and replay.
 */
import { createHash } from "node:crypto";
import type { Ask } from "./asks.js";
import { guardCommandFingerprint } from "./role-message-guard-core.js";
import {
	guardDecisionRevisionValid,
	guardPolicyFor,
	guardPolicyIsValid,
	guardQuantityValid,
	guardRequestMaximum,
	guardRequestRevisionValid,
	guardSelectionRevisionValid,
} from "./role-message-limits.js";
import type {
	GuardActor,
	GuardApprovalContext,
	GuardChoice,
	GuardConsumerBinding,
	GuardHostVerified,
	GuardInvocationReference,
	GuardOperationIdentity,
	GuardOwnerAnswerReference,
	GuardOwnerQuestion,
	GuardPolicyV1,
	GuardRequest,
	GuardResult,
	GuardRoleChoice,
	GuardScope,
	GuardTime,
	GuardTransportResult,
	GuardVerification,
	GuardVerifiedSnapshot,
} from "./role-message-guard-contract.js";
import type {
	GuardApprovalBindingAny,
	GuardCommandAny,
	GuardCoordinatorAny,
	GuardHostVerifierAny,
	GuardOwnerQuestionAny,
	GuardOwnerQuestionV2,
	GuardPolicy,
	GuardPolicyV2,
	GuardRequestAny,
	GuardRequestV2,
	GuardResultAny,
	GuardStatusResultAny,
} from "./role-message-guard-contract-v2.js";

export interface GuardApprovalNativePortAny {
	/** Fresh trusted time. Never accepts an agent/browser clock. E rechecks under its writer. */
	time(): Promise<GuardTime>;
	/** Resolve original request's destination and snapshot from native state, not caller fields.
	 * Initial -> selected current home (or native Owner route); decision -> original requester.
	 * Verify caller's current binding and request visibility/authority. Preserve original causal root.
	 */
	control(
		actor: GuardHostVerified<GuardActor>,
		request: GuardRequestAny,
		phase: "initial" | "decision",
	): Promise<GuardVerification<{ to: string; snapshot: GuardHostVerified<GuardVerifiedSnapshot> }>>;
	/** Durable create-or-read SAME question for request+generation; exact binding/context/choices.
	 * Neither a copied question ID nor AskHub's `from` string is an authenticated answer.
	 */
	readonly question: {
		(request: GuardRequest, choicesDigest: string): Promise<GuardVerification<GuardOwnerQuestion>>;
		(request: GuardRequestV2, choicesDigest: string): Promise<GuardVerification<GuardOwnerQuestionV2>>;
		(request: GuardRequestAny, choicesDigest: string): Promise<GuardVerification<GuardOwnerQuestionAny>>;
	};
	/** Lookup the live durable request bound to a native answer event. No caller-provided request. */
	ownerRequest(reference: GuardOwnerAnswerReference): Promise<GuardVerification<GuardRequestAny>>;
	/** Revalidate holds/time/permissions and committed control identity immediately before showing.
	 * Same-key question/wake dedup, first-answer arbitration and reconnect recovery are mandatory.
	 * Never falls back from an unauthorised Telegram plugin to another channel.
	 */
	/* #122: committedControl is null on the question-only Owner path (direct Owner tier or an escalated phase):
	 * E refuses every initial control for an Owner-tier phase, so the native question is shown with no agent
	 * message and no charge. */
	present(
		question: GuardOwnerQuestionAny,
		ask: Ask,
		committedControl: Extract<GuardResult, { state: "accepted" }> | null,
	): Promise<GuardTransportResult>;
}

interface GuardApprovalCapabilitiesAny {
	readonly binding: GuardConsumerBinding;
	readonly maximumContextBytes: number;
	/** These ports support both families on every call; V1-only ports cannot author V2 through this context. */
	readonly host: GuardHostVerifierAny;
	readonly core: GuardCoordinatorAny;
	readonly native: GuardApprovalNativePortAny;
}
/** Every capability handles both complete families; policy selection never substitutes a V1-only authoring port. */
export type GuardApprovalPortsAny =
	| (GuardApprovalCapabilitiesAny & { readonly policy: GuardPolicyV1 })
	| (GuardApprovalCapabilitiesAny & { readonly policy: GuardPolicyV2 });
export type GuardAdapterFailure = {
	readonly state: "invalid" | "unavailable" | "context_needed";
	readonly reason: string;
};
export type GuardAdapterOutcomeAny = GuardResultAny | GuardAdapterFailure;

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
/* #122 fix: E accepts a command only when identity.fingerprint === guardCommandFingerprint(command), so the
 * fingerprint is computed from the exact command body (A's earlier private digest never matched; every A command
 * was refused invalid_input by the real core). operationId stays A's replay key. */
type GuardCommandBodyAny = GuardCommandAny extends infer C
	? C extends GuardCommandAny
		? Omit<C, "identity">
		: never
	: never;
function withIdentity(
	actor: GuardActor,
	action: string,
	key: unknown,
	invocation: GuardInvocationReference | GuardOwnerAnswerReference,
	body: GuardCommandBodyAny,
): GuardCommandAny {
	const identity: GuardOperationIdentity = {
		version: "role-message-guard/v1",
		actor,
		operationId: approvalDigest({ action, key, invocation }),
		fingerprint: "",
	};
	const command: GuardCommandAny = { ...body, identity };
	return { ...command, identity: { ...identity, fingerprint: guardCommandFingerprint(command) } };
}
function questionDigest(request: GuardRequestAny): string {
	return approvalDigest({ binding: request.binding, detail: request.context, choices });
}
function legacyQuestion(question: GuardOwnerQuestionAny): question is GuardOwnerQuestion {
	return question.binding.version === "role-message-guard/v1";
}

/** Exact finite native Ask descriptor. No multi-select, custom prose or Auto approve route.
 * Current hourly copy is separate from the question's immutable revision-bound authority. */
export function ownerApprovalAsk(
	...args:
		| [GuardOwnerQuestion, number, GuardPolicyV1?, GuardPolicy["ordinary"]["acceptedPerOrigin"]?]
		| [GuardOwnerQuestionV2, number, GuardPolicyV2, GuardPolicy["ordinary"]["acceptedPerOrigin"]?]
): Ask {
	const [q, createdAt, selectedPolicy, activeHourlyLimit] = args;
	const policy = selectedPolicy ?? guardPolicyFor(q.binding.version)!;
	const hourlyLimit = activeHourlyLimit ?? policy.ordinary.acceptedPerOrigin;
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
				authorityLimit: `Communication only; original root and scope; finite uses; one hour maximum; no automatic business send. Holds, ${hourlyLimit}/hour (Ops/Temper exempt), access and consent still apply. This is not action, spending, installation or hold-lift authority.`,
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

export function createGuardApprovalAdapters(ports: GuardApprovalPortsAny) {
	const { host, core, native, policy } = ports;
	// Refuse an incompatible consumer; all three pins are the frozen dependency, not a policy fork.
	const compatible =
		ports.binding.version === "role-message-guard/v1" &&
		ports.binding.contractCommit === "04fe491fb3afc3b42462ad782b2099c7971c7008" &&
		ports.binding.contractSha256 === "79a5a1e1a704ecfbb36a70fc1b210ee6e27575013843122cf202a84592b4c7af" &&
		ports.binding.policyDocumentSha256 === "5d8433fd0a8f9a82103009e43491182caf14b80ad2a20b874709c5b3762724a9" &&
		guardPolicyIsValid(policy);
	async function actorOf(ref: GuardInvocationReference) {
		if (!compatible) return unavailable("Frozen contract/policy pin mismatch");
		const result = await host.verifyInvocation(ref);
		return result.state === "verified" ? result.value : failure(result);
	}
	async function read(
		ref: GuardInvocationReference,
		requestId: string,
		generation: string,
	): Promise<GuardStatusResultAny | GuardAdapterFailure> {
		if (!text(requestId) || !text(generation)) return invalid("Request ID and generation required");
		const actor = await actorOf(ref);
		if ("state" in actor) return actor;
		// E must authorise visibility; copied IDs alone cannot read or decide another request.
		return core.status(actor, requestId, generation);
	}
	async function request(
		ref: GuardInvocationReference,
		input: { binding: unknown; context: unknown; quantity: unknown },
	): Promise<GuardAdapterOutcomeAny> {
		const actor = await actorOf(ref);
		if ("state" in actor) return actor;
		if (!completeApprovalContext(input.context, ports.maximumContextBytes))
			return { state: "context_needed", reason: "Complete bounded context required; no truncation" };
		if (
			!guardQuantityValid(input.quantity, policy.version) ||
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
			return invalid(`Approval requires a known safe business hop above ${policy.depth.unapprovedThrough}`);
		const time = await native.time();
		if (!trustedTime(time) || !Number.isSafeInteger(time.nowMs + policy.request.lifetimeMs))
			return unavailable("Trusted clock required");
		const bound = {
			requestId: input.binding.requestId,
			generation: input.binding.generation,
			requester: actor,
			causal: causal.value,
			scope: input.binding.scope,
			tier: hop >= policy.depth.ownerFrom ? ("owner" as const) : ("lower" as const),
			upperHop: hop + input.quantity - 1,
		};
		let binding: GuardApprovalBindingAny;
		if (policy.version === "role-message-guard/v1") {
			if (!guardQuantityValid(input.quantity, policy.version)) return invalid("Finite V1 quantity required");
			binding = { ...bound, version: policy.version, quantity: input.quantity };
		} else {
			if (!guardQuantityValid(input.quantity, policy.version)) return invalid("Finite V2 quantity required");
			binding = { ...bound, version: policy.version, quantity: input.quantity };
		}
		const selected = await host.selectApprover(binding);
		if (selected.state !== "verified") return failure(selected);
		if (hop >= policy.depth.ownerFrom && selected.value.tier !== "owner")
			return unavailable(`Lower authority cannot reach hop ${policy.depth.ownerFrom}`);
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
		if (
			policy.version === "role-message-guard/v2" &&
			binding.quantity > guardRequestMaximum(policy, hop, selected.value.tier)
		)
			return invalid("Quantity must fit the remaining finite tier exactly; no clamping");
		const resolved = {
			...binding,
			tier: selected.value.tier,
			// Preserve V1 adapter replay vectors. E still refuses inconsistent legacy quantity/endpoints.
			upperHop:
				policy.version === "role-message-guard/v1" && selected.value.tier === "lower"
					? Math.min(binding.upperHop, policy.depth.lowerThrough)
					: binding.upperHop,
		};
		const initial = {
			context: input.context,
			createdAt: time.nowMs,
			expiresAt: time.nowMs + policy.request.lifetimeMs,
			state: resolved.tier === "owner" ? ("awaiting_owner" as const) : ("awaiting_approver" as const),
			upwardEscalations: 0 as const,
			initialNotificationKey: approvalDigest([resolved, "initial"]),
			decisionNotificationKey: approvalDigest([resolved, "decision"]),
			firstDecision: null,
			grantId: null,
		};
		let record: GuardRequestAny;
		if (resolved.version === "role-message-guard/v1" && guardSelectionRevisionValid(selected.value, resolved.version))
			record = { ...initial, binding: resolved, selectedApprover: selected.value };
		else if (
			resolved.version === "role-message-guard/v2" &&
			guardSelectionRevisionValid(selected.value, resolved.version)
		)
			record = { ...initial, binding: resolved, selectedApprover: selected.value };
		else return unavailable("Approver selection revision mismatch");
		const command = guardRequestRevisionValid(record, "role-message-guard/v1")
			? withIdentity(actor, "request", record, ref, { kind: "request_record", actor, request: record })
			: withIdentity(actor, "request", record, ref, { kind: "request_record", actor, request: record });
		return core.execute(command);
	}
	async function roleDecision(
		ref: GuardInvocationReference,
		input: { requestId: string; generation: string; choice: GuardRoleChoice; reason: string },
	): Promise<GuardAdapterOutcomeAny> {
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
			r.binding.upperHop > (guardPolicyFor(r.binding.version)?.depth.lowerThrough ?? 0) ||
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
		const command = guardDecisionRevisionValid(d, "role-message-guard/v1")
			? withIdentity(actor, "role_decision", d, ref, { kind: "decision_record", decision: d })
			: withIdentity(actor, "role_decision", d, ref, { kind: "decision_record", decision: d });
		return core.execute(command);
	}
	/** HOST-ONLY callback, never a GuardUntrustedInput/tool. Native event reference alone is not proof. */
	async function nativeOwnerAnswer(ref: GuardOwnerAnswerReference): Promise<GuardAdapterOutcomeAny> {
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
		const command = guardDecisionRevisionValid(d, "role-message-guard/v1")
			? withIdentity(r.binding.requester, "owner_decision", d, ref, { kind: "decision_record", decision: d })
			: withIdentity(r.binding.requester, "owner_decision", d, ref, { kind: "decision_record", decision: d });
		return core.execute(command);
	}
	/** An explicit control attempt, not a business send. Core owns dedup, selected hourly cap and all holds. */
	async function notify(
		ref: GuardInvocationReference,
		requestId: string,
		generation: string,
		phase: "initial" | "decision",
	): Promise<GuardAdapterOutcomeAny | GuardTransportResult> {
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
		// #122 question-only path: an Owner-tier phase has no initial agent message (E refuses it); the bound native
		// Owner question is shown instead, with no agent message and no charge.
		if (phase === "initial" && r.binding.tier === "owner") {
			if (!same(actor, r.binding.requester)) return invalid("Only the requester asks for its own Owner decision");
			return presentOwnerQuestion(r);
		}
		const control = await native.control(actor, r, phase);
		if (control.state !== "verified") return failure(control);
		if (
			!same(control.value.snapshot.actor, actor) ||
			!same(control.value.snapshot.causal, r.binding.causal) ||
			!text(control.value.to)
		)
			return invalid("Control must preserve native actor and original business causality");
		return core.execute(
			withIdentity(actor, "control", [r.binding, phase], ref, {
				kind: "control_send",
				snapshot: control.value.snapshot,
				requestId,
				generation,
				phase,
				to: control.value.to,
			}),
		);
	}
	/** HOST-ONLY (#122): show the one bound native Owner question for a current Owner-tier phase (direct Owner tier
	 * or E's escalated phase). No agent message, no charge; E still owns first-answer arbitration. The caller passes
	 * the request exactly as read from E's own state, never caller-supplied fields. */
	async function presentOwnerQuestion(r: GuardRequestAny): Promise<GuardAdapterOutcomeAny | GuardTransportResult> {
		if (!compatible) return unavailable("Frozen contract/policy pin mismatch");
		if (r.binding.tier !== "owner" || r.selectedApprover.tier !== "owner" || r.state !== "awaiting_owner")
			return invalid("Current awaiting Owner-tier request required");
		if (!completeApprovalContext(r.context, ports.maximumContextBytes))
			return { state: "context_needed", reason: "Complete bounded context required; no truncation" };
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
		const ask = legacyQuestion(q)
			? ownerApprovalAsk(q, r.createdAt, guardPolicyFor("role-message-guard/v1")!, policy.ordinary.acceptedPerOrigin)
			: ownerApprovalAsk(q, r.createdAt, guardPolicyFor("role-message-guard/v2")!, policy.ordinary.acceptedPerOrigin);
		return native.present(q, ask, null);
	}
	return {
		agent: { request, status: read, roleDecision, notify },
		native: { ownerAnswer: nativeOwnerAnswer, presentOwnerQuestion },
	};
}
