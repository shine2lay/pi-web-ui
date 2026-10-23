// Synthetic native ports and an E spy ONLY. These tests cannot qualify real host authentication.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
	approvalDigest,
	completeApprovalContext,
	createGuardApprovalAdapters,
	ownerApprovalAsk,
	type GuardApprovalNativePortAny,
	type GuardApprovalPortsAny,
} from "../../server/role-message-guard-approvals.js";
import type {
	GuardActor,
	GuardApprovalBinding,
	GuardApprovalContext,
	GuardApproverSelection,
	GuardHostVerified,
	GuardInvocationReference,
	GuardOwnerAnswerReference,
	GuardOwnerQuestion,
	GuardPolicyV1,
	GuardRequest,
	GuardRoleDecisionReference,
	GuardVerification,
	GuardVerifiedDecision,
	GuardVerifiedSnapshot,
} from "../../server/role-message-guard-contract.js";
import type {
	GuardApprovalBindingAny,
	GuardApprovalBindingV2,
	GuardApproverSelectionAny,
	GuardApproverSelectionV2,
	GuardCommandAny,
	GuardHostVerifierAny,
	GuardOwnerQuestionAny,
	GuardOwnerQuestionV2,
	GuardPolicy,
	GuardRequestAny,
	GuardRequestV2,
	GuardResultAny,
	GuardVerifiedDecisionAny,
	GuardVerifiedDecisionV2,
} from "../../server/role-message-guard-contract-v2.js";
import { checkAnswers } from "../../server/asks.js";
import { guardCommandFingerprint } from "../../server/role-message-guard-core.js";
import { GUARD_POLICY_V2 } from "../../server/role-message-limits.js";
const policy: GuardPolicyV1 = {
	version: "role-message-guard/v1",
	depth: { unapprovedThrough: 6, lowerThrough: 11, ownerFrom: 12 },
	grant: { maximumBusinessSends: 5, lifetimeMs: 3600000 },
	ordinary: { acceptedPerOrigin: 20, rollingWindowMs: 3600000 },
	request: {
		outstandingPerRequester: 20,
		lifetimeMs: 86400000,
		openPerRootTierScopeGeneration: 1,
		initialNotifications: 1,
		decisionNotifications: 1,
		explicitUpwardEscalations: 1,
	},
	protected: {
		bypass: "depth_only",
		consumesOrdinaryHourly: true,
		assignedDestinations: 1,
		initialPerEpisode: 1,
		terminalPerEpisode: 1,
		newIncidentsPerOriginHour: 2,
		deliveriesPerOriginHour: 4,
		deliveriesPerDestinationHour: 4,
		deliveriesPerSystemHour: 12,
		liveIncidents: 12,
		lifetimeMs: 86400000,
		maximumRenderedBytes: 2048,
	},
	rollback: { depthThrough: 6, acceptedPerOrigin: 20, preserveAccepted: true },
};
// A test cast is NOT authentication; only these fake ports may mint it in the tests.
const verified = <T>(value: T): GuardVerification<T> => ({ state: "verified", value: value as GuardHostVerified<T> });
const proof = {
	sourceId: "fake-native",
	sourceVersion: "case-v1",
	sourceIncarnation: "fake-1",
	eventId: "proof-1",
	revision: "1",
	digest: "synthetic-digest",
	observedAt: 1000,
};
const requester: GuardActor = {
	role: "ops",
	sessionFile: "/synthetic/task.jsonl",
	sessionId: "task-127",
	runtimeIncarnation: "fake-1",
	task: { kind: "task", queueId: "ops", taskId: 127, generation: "task-g1" },
	currentHome: false,
	identityRevision: "role-r1",
};
const approver: GuardActor = {
	...requester,
	role: "coo",
	sessionFile: "/synthetic/coo-home.jsonl",
	sessionId: "coo-home",
	task: { kind: "home" },
	currentHome: true,
};
const context: GuardApprovalContext = {
	goal: "Synthetic goal",
	progressAndChanges: "Prepared inert additions",
	priorDecisions: ["Only communication requested"],
	whyNeeded: "Reached finite hop boundary",
	nextStepAndOutcome: "Ask the named peer for one review",
	outstandingQuestions: ["Continue communication?"],
	optionsAndTradeoffs: [
		"Deny: stop messaging, zero additional cost",
		"One: one scoped message; limited time/risk",
		"Requested: finite review round, unchanged holds",
	],
	timeCostRisk: "Five minutes; no authorised spend; synthetic risk",
	exactCommunicationAuthority: "Only this scope, participants and finite hop bound",
	nativeFacts: [proof],
	declaredClaims: ["Requester says review is needed"],
	safetyScopeAndHolds: ["Installation, action and spending remain prohibited"],
};
const invocation: GuardInvocationReference = {
	invocationId: "call-1",
	toolCallId: "tool-1",
	runtimeBindingId: "task-runtime",
};
const lowerInvocation: GuardInvocationReference = {
	...invocation,
	invocationId: "lower-1",
	runtimeBindingId: "coo-runtime",
};
// Revision-only narrowing of already correlated synthetic records, never native authentication.
const legacyRequest = (request: GuardRequestAny): request is GuardRequest => request.binding.version === policy.version;
const legacyDecision = (decision: GuardVerifiedDecisionAny): decision is GuardVerifiedDecision =>
	decision.binding.version === policy.version;
function fixture(hop = 7, selectedPolicy: GuardPolicy = policy) {
	let now = 1000;
	let stored: GuardRequestAny | null = null;
	let first: GuardVerifiedDecisionAny | null = null;
	const commands: GuardCommandAny[] = [];
	const lower: Extract<GuardApproverSelection, { tier: "lower" }> = {
		tier: "lower",
		role: "coo",
		route: "coo",
		home: approver,
		proof,
	};
	const causal = {
		kind: "rooted" as const,
		rootId: "business-root",
		parentId: "original-incoming",
		nextHop: hop,
		sourceRevision: "source-1",
		incomingRecordId: "incoming-1",
		incomingHash: "incoming-hash",
	};
	const holds = {
		ownerPaused: false,
		roleDeliveryPaused: false,
		wakesDisabled: false,
		accessDenied: false,
		scopeDenied: false,
		spendingOrConsentDenied: false,
		queueOrSessionMismatch: false,
		sourcePermissionRevoked: false,
	};
	const blocked = (reason: "duplicate_slot" | "ordinary_hourly" | "held"): GuardResultAny => {
		const body = { state: "blocked", reason, requiredTier: null, accepted: false } as const;
		if (!stored) return { ...body, request: null };
		return legacyRequest(stored) ? { ...body, request: stored } : { ...body, request: stored };
	};
	function selectApprover(b: GuardApprovalBinding): Promise<GuardVerification<GuardApproverSelection>>;
	function selectApprover(b: GuardApprovalBindingV2): Promise<GuardVerification<GuardApproverSelectionV2>>;
	function selectApprover(b: GuardApprovalBindingAny): Promise<GuardVerification<GuardApproverSelectionAny>>;
	async function selectApprover(b: GuardApprovalBindingAny): Promise<GuardVerification<GuardApproverSelectionAny>> {
		if (b.version === policy.version)
			return verified(hop >= policy.depth.ownerFrom ? { tier: "owner", reason: "hop_12_plus" } : lower);
		return verified(hop >= GUARD_POLICY_V2.depth.ownerFrom ? { tier: "owner", reason: "hop_23_plus" } : lower);
	}
	function verifyRoleDecision(
		ref: GuardRoleDecisionReference,
		b: GuardApprovalBinding,
	): Promise<GuardVerification<GuardVerifiedDecision>>;
	function verifyRoleDecision(
		ref: GuardRoleDecisionReference,
		b: GuardApprovalBindingV2,
	): Promise<GuardVerification<GuardVerifiedDecisionV2>>;
	function verifyRoleDecision(
		ref: GuardRoleDecisionReference,
		b: GuardApprovalBindingAny,
	): Promise<GuardVerification<GuardVerifiedDecisionAny>>;
	async function verifyRoleDecision(
		ref: GuardRoleDecisionReference,
		b: GuardApprovalBindingAny,
	): Promise<GuardVerification<GuardVerifiedDecisionAny>> {
		const body = {
			choice: ref.choice,
			reason: ref.reason,
			authority: { tier: "lower" as const, selection: lower, decisionId: "lower-decision", proof },
			answeredAt: now,
			firstAnswerEventId: "lower-event",
		};
		return b.version === policy.version ? verified({ ...body, binding: b }) : verified({ ...body, binding: b });
	}
	function verifyOwnerAnswer(
		ref: GuardOwnerAnswerReference,
		q: GuardOwnerQuestion,
	): Promise<GuardVerification<GuardVerifiedDecision>>;
	function verifyOwnerAnswer(
		ref: GuardOwnerAnswerReference,
		q: GuardOwnerQuestionV2,
	): Promise<GuardVerification<GuardVerifiedDecisionV2>>;
	function verifyOwnerAnswer(
		ref: GuardOwnerAnswerReference,
		q: GuardOwnerQuestionAny,
	): Promise<GuardVerification<GuardVerifiedDecisionAny>>;
	async function verifyOwnerAnswer(
		ref: GuardOwnerAnswerReference,
		q: GuardOwnerQuestionAny,
	): Promise<GuardVerification<GuardVerifiedDecisionAny>> {
		if (!ref.nativeAnswerEventId.startsWith("native-"))
			return { state: "invalid", reason: "No authenticated native event" };
		const body = {
			choice: "requested_quantity" as const,
			reason: "Native synthetic selected answer",
			authority: {
				tier: "owner" as const,
				questionId: q.questionId,
				questionGeneration: q.generation,
				choicesDigest: q.choicesDigest,
				decisionId: "owner-decision",
				source: { kind: "authenticated_browser" as const, authenticatedOwnerBindingId: "fake-owner-principal" },
				proof,
			},
			answeredAt: now,
			firstAnswerEventId: ref.nativeAnswerEventId,
		};
		const b = q.binding;
		return b.version === policy.version ? verified({ ...body, binding: b }) : verified({ ...body, binding: b });
	}
	function question(r: GuardRequest, choicesDigest: string): Promise<GuardVerification<GuardOwnerQuestion>>;
	function question(r: GuardRequestV2, choicesDigest: string): Promise<GuardVerification<GuardOwnerQuestionV2>>;
	function question(r: GuardRequestAny, choicesDigest: string): Promise<GuardVerification<GuardOwnerQuestionAny>>;
	async function question(
		r: GuardRequestAny,
		choicesDigest: string,
	): Promise<GuardVerification<GuardOwnerQuestionAny>> {
		const body = {
			questionId: "native-q1",
			generation: "native-q-g1",
			detail: r.context,
			choices: ["deny", "one_send", "requested_quantity"] as const,
			choicesDigest,
		};
		const b = r.binding;
		return b.version === policy.version ? verified({ ...body, binding: b }) : verified({ ...body, binding: b });
	}
	const host: GuardHostVerifierAny = {
		verifyInvocation: vi.fn(async (ref: GuardInvocationReference) =>
			ref.runtimeBindingId === "task-runtime"
				? verified(requester)
				: ref.runtimeBindingId === "coo-runtime"
					? verified(approver)
					: { state: "invalid" as const, reason: "Not an invocation-bound current identity" },
		),
		verifyCausality: vi.fn(async () => verified(causal)),
		selectApprover,
		verifyRoleDecision,
		verifyOwnerAnswer,
		verifyIncident: vi.fn(async () => ({ state: "unavailable" as const, reason: "Not A" })),
		revalidate: vi.fn(async (snapshot: GuardHostVerified<GuardVerifiedSnapshot>) =>
			verified<GuardVerifiedSnapshot>(snapshot),
		),
	};
	// Keep exact port overloads and explicit implementations for cases that wrap the original spy.
	vi.spyOn(host, "selectApprover").mockImplementation(selectApprover);
	vi.spyOn(host, "verifyRoleDecision").mockImplementation(verifyRoleDecision);
	vi.spyOn(host, "verifyOwnerAnswer").mockImplementation(verifyOwnerAnswer);
	const capabilities: Omit<GuardApprovalPortsAny, "policy"> = {
		binding: {
			version: "role-message-guard/v1",
			contractCommit: "04fe491fb3afc3b42462ad782b2099c7971c7008",
			contractSha256: "79a5a1e1a704ecfbb36a70fc1b210ee6e27575013843122cf202a84592b4c7af",
			policyDocumentSha256: "5d8433fd0a8f9a82103009e43491182caf14b80ad2a20b874709c5b3762724a9",
			blockers: ["native_owner_authentication", "durable_first_answer"],
		},
		maximumContextBytes: 16384,
		host,
		core: {
			execute: vi.fn(async (command: GuardCommandAny): Promise<GuardResultAny> => {
				commands.push(command);
				if (command.kind === "request_record") {
					const recorded = structuredClone(command.request);
					stored = recorded;
					const body = { state: "recorded", transactionId: "request-tx", communicationAccepted: false } as const;
					return legacyRequest(recorded) ? { ...body, request: recorded } : { ...body, request: recorded };
				}
				if (command.kind === "decision_record" && stored) {
					if (first) return blocked("duplicate_slot");
					const decision = command.decision;
					const state =
						decision.choice === "deny"
							? "denied"
							: decision.choice === "escalate_owner"
								? "awaiting_owner"
								: "approved";
					const body = { state: "recorded", transactionId: "decision-tx", communicationAccepted: false } as const;
					if (legacyRequest(stored) && legacyDecision(decision)) {
						first = decision;
						stored = { ...stored, state, firstDecision: decision };
						return { ...body, request: stored };
					}
					if (!legacyRequest(stored) && !legacyDecision(decision)) {
						first = decision;
						stored = { ...stored, state, firstDecision: decision };
						return { ...body, request: stored };
					}
					throw new Error("synthetic decision/request revision mismatch");
				}
				if (command.kind === "control_send")
					return {
						state: "accepted",
						delivery: "dispatched",
						receipt: {
							version: "role-message-guard/v1",
							identity: command.identity,
							transactionId: "control-tx",
							committedAt: now,
							messageId: "control-message",
							causal,
							class: "control",
							usage: {
								ordinaryOrigin: 1,
								grantBusinessUse: 0,
								protectedOrigin: 0,
								protectedDestination: 0,
								protectedSystem: 0,
								newIncidentOrigin: 0,
							},
							outboxId: "fake-outbox",
							dispatchKey: "same-dispatch",
							wakeKey: "same-wake",
							legacyMessageDigest: "fake-message-digest",
						},
					};
				throw new Error("Unexpected business/protected mutation in component A");
			}),
			status: vi.fn(async (_actor: GuardHostVerified<GuardActor>, id: string, generation: string) => {
				if (!stored || stored.binding.requestId !== id || stored.binding.generation !== generation)
					return { state: "absent" as const, authoritative: true as const };
				return legacyRequest(stored)
					? { state: "found" as const, request: stored }
					: { state: "found" as const, request: stored };
			}),
			reconcile: vi.fn(async () => blocked("held")),
			rollback: vi.fn(async () => ({ state: "unavailable" as const, reason: "Not A" })),
		},
		native: {
			time: vi.fn(async () => ({ state: "trusted" as const, nowMs: now, lastObservedMs: 1000 })),
			control: vi.fn(
				async (actor: GuardHostVerified<GuardActor>, r: GuardRequestAny, phase: "initial" | "decision") => {
					const snapshot: GuardVerifiedSnapshot = {
						actor,
						causal: r.binding.causal,
						holds,
						time: { state: "trusted", nowMs: now, lastObservedMs: 1000 },
						authority: null,
						incident: null,
						sourceRevision: "source-1",
					};
					const checked = verified<GuardVerifiedSnapshot>(snapshot);
					if (checked.state !== "verified") throw new Error("synthetic snapshot constructor did not verify");
					return verified({
						to:
							phase === "decision"
								? r.binding.requester.role
								: r.selectedApprover.tier === "lower"
									? r.selectedApprover.role
									: "coo",
						snapshot: checked.value,
					});
				},
			),
			question,
			ownerRequest: vi.fn(async () =>
				stored ? verified(stored) : { state: "unavailable" as const, reason: "No live request bound to native event" },
			),
			present: vi.fn(async () => ({ state: "confirmed" as const, proof })),
		},
	};
	const ports: GuardApprovalPortsAny =
		selectedPolicy.version === policy.version
			? { ...capabilities, policy: selectedPolicy }
			: { ...capabilities, policy: selectedPolicy };
	const native: GuardApprovalNativePortAny = ports.native;
	vi.spyOn(native, "question");
	const adapter = createGuardApprovalAdapters(ports);
	const input = {
		binding: {
			requestId: "request-1",
			generation: "request-g1",
			scope: {
				scopeId: "scope-1",
				operation: "bounded-review",
				participants: ["ops", "qa"],
				recipients: ["qa"],
				task: requester.task,
			},
		},
		context,
		quantity: 5,
	};
	const answer: GuardOwnerAnswerReference = {
		nativeAnswerEventId: "native-event-1",
		questionId: "native-q1",
		generation: "native-q-g1",
	};
	return {
		ports,
		adapter,
		input,
		answer,
		commands,
		lower,
		blocked,
		request: () => stored!,
		setRequest: (r: GuardRequestAny) => {
			stored = r;
		},
		setNow: (v: number) => {
			now = v;
		},
		create: () => adapter.agent.request(invocation, input),
		decide: (
			choice: "deny" | "one_send" | "requested_quantity" | "escalate_owner" = "requested_quantity",
			ref = lowerInvocation,
		) =>
			adapter.agent.roleDecision(ref, {
				requestId: "request-1",
				generation: "request-g1",
				choice,
				reason: "Synthetic explicit finite decision",
			}),
	};
}

describe("expanded approval adapters: new quantities are exact, old vectors remain below", () => {
	it.each([
		[13, 10, "recorded"],
		[13, 11, "invalid"],
		[22, 1, "recorded"],
		[22, 2, "invalid"],
		[23, 10, "recorded"],
		[24, 10, "invalid"],
		[24, 9, "recorded"],
		[33, 1, "invalid"],
	] as const)("hop %i / quantity %i is %s", async (hop, quantity, state) => {
		const f = fixture(hop, GUARD_POLICY_V2);
		const result = await f.adapter.agent.request(invocation, { ...f.input, quantity });
		expect(result.state).toBe(state);
		if (state === "recorded")
			expect(f.request().binding).toMatchObject({
				version: GUARD_POLICY_V2.version,
				quantity,
				upperHop: hop + quantity - 1,
				tier: hop >= 23 ? "owner" : "lower",
			});
		else expect(f.commands).toHaveLength(0);
	});
	it("a lower selection at 23, self approval and stale/wrong-scope native identity stay unavailable", async () => {
		const owner = fixture(23, GUARD_POLICY_V2);
		vi.mocked(owner.ports.host.selectApprover).mockResolvedValue(verified(owner.lower));
		expect((await owner.adapter.agent.request(invocation, { ...owner.input, quantity: 10 })).state).toBe("unavailable");
		const self = fixture(13, GUARD_POLICY_V2);
		vi.mocked(self.ports.host.selectApprover).mockResolvedValue(
			verified({ ...self.lower, role: requester.role, home: { ...approver, role: requester.role } }),
		);
		expect((await self.adapter.agent.request(invocation, { ...self.input, quantity: 10 })).state).toBe("unavailable");
		const stale = fixture(13, GUARD_POLICY_V2);
		vi.mocked(stale.ports.host.verifyInvocation).mockResolvedValue({
			state: "invalid",
			reason: "synthetic stale incarnation",
		});
		expect((await stale.adapter.agent.request(invocation, { ...stale.input, quantity: 10 })).state).toBe("invalid");
		expect(stale.commands).toHaveLength(0);
	});
});

describe("A frozen input and native boundaries", () => {
	it("constructing/importing has no registration, port calls or grant store", () => {
		const f = fixture();
		expect(f.commands).toEqual([]);
		expect(f.ports.native.present).not.toHaveBeenCalled();
		expect(f.adapter.agent).not.toHaveProperty("ownerAnswer");
		const source = readFileSync(new URL("../../server/role-message-guard-approvals.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(/new (Map|Set)|askHub\.add|setInterval|business_send["']/u);
	});
	it("structural digest stable under object key order, not authentication", () => {
		expect(approvalDigest({ b: 2, a: 1 })).toBe(approvalDigest({ a: 1, b: 2 }));
	});
	it.each([0, 6, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
		"invalid or unneeded hop %s fails closed",
		async (hop) => {
			const f = fixture(hop);
			expect((await f.create()).state).toBe("invalid");
			expect(f.commands).toEqual([]);
		},
	);
	it.each([0, 6, 1.5, NaN, Infinity, "5", null])("non-finite quantity %s is not a grant", async (v) => {
		const f = fixture();
		expect((await f.adapter.agent.request(invocation, { ...f.input, quantity: v })).state).toBe("invalid");
		expect(f.commands).toEqual([]);
	});
	it.each(Object.keys(context))("missing complete context field %s cannot be clipped/accepted", async (field) => {
		const f = fixture();
		const partial = { ...context } as Record<string, unknown>;
		delete partial[field];
		expect((await f.adapter.agent.request(invocation, { ...f.input, context: partial })).state).toBe("context_needed");
		expect(f.commands).toEqual([]);
	});
	it("full UTF-8 bound rejects oversized context without truncating", () => {
		expect(completeApprovalContext(context, 16384)).toBe(true);
		expect(completeApprovalContext({ ...context, goal: "界".repeat(6000) }, 16384)).toBe(false);
		expect(completeApprovalContext(context, Infinity)).toBe(false);
		expect(completeApprovalContext({ ...context, nativeFacts: [{ ...proof, observedAt: NaN }] }, 16384)).toBe(false);
	});
	it.each(["actor", "currentHome", "tier", "owner", "Auto approve"])(
		"caller authority field %s is rejected",
		async (field) => {
			const f = fixture();
			expect(
				(await f.adapter.agent.request(invocation, { ...f.input, binding: { ...f.input.binding, [field]: true } }))
					.state,
			).toBe("invalid");
		},
	);
	it("copied invocation/session ID is not identity", async () => {
		const f = fixture();
		expect((await f.adapter.agent.request({ ...invocation, runtimeBindingId: "copied-coo-home" }, f.input)).state).toBe(
			"invalid",
		);
	});
	it("task cannot claim its home or change business scope task", async () => {
		const f = fixture();
		expect(
			(
				await f.adapter.agent.request(invocation, {
					...f.input,
					binding: { ...f.input.binding, scope: { ...f.input.binding.scope, task: { kind: "home" } } },
				})
			).state,
		).toBe("invalid");
	});
	it("unknown causal binding and clock are unavailable", async () => {
		const f = fixture();
		vi.mocked(f.ports.host.verifyCausality).mockResolvedValue({ state: "unknown", reason: "ambiguous" });
		expect((await f.create()).state).toBe("unavailable");
		expect(f.commands).toEqual([]);
	});
	it("clock rollback does not open a request", async () => {
		const f = fixture();
		f.setNow(999);
		expect((await f.create()).state).toBe("unavailable");
		expect(f.commands).toEqual([]);
	});
	it("contract pin mismatch blocks before native calls", async () => {
		const f = fixture();
		const adapter = createGuardApprovalAdapters({
			...f.ports,
			binding: { ...f.ports.binding, contractSha256: "copied" },
		});
		expect((await adapter.agent.request(invocation, f.input)).state).toBe("unavailable");
		expect(f.ports.host.verifyInvocation).not.toHaveBeenCalled();
	});
});
describe("lower authority, current home and bounded fallback", () => {
	it.each([7, 8, 9, 10, 11])("COO accepts hop %s only through 11", async (hop) => {
		const f = fixture(hop);
		expect((await f.create()).state).toBe("recorded");
		expect(f.request().binding.upperHop).toBe(11);
		expect((await f.decide()).state).toBe("recorded");
		expect(f.commands.map((c) => c.kind)).toEqual(["request_record", "decision_record"]);
	});
	it("existing authorised lead works only when native-selected", async () => {
		const f = fixture();
		const lead = { ...approver, role: "qa", sessionId: "qa-home", sessionFile: "/synthetic/qa-home" };
		const selected = {
			...f.lower,
			tier: "lower" as const,
			role: "qa",
			route: "existing_authorised_lead" as const,
			home: lead,
		};
		vi.mocked(f.ports.host.selectApprover).mockResolvedValue(verified(selected));
		expect((await f.create()).state).toBe("recorded");
		expect(f.request().selectedApprover).toEqual(selected);
	});
	it.each(["deny", "one_send", "requested_quantity", "escalate_owner"] as const)(
		"finite lower choice %s records with no automatic send",
		async (choice) => {
			const f = fixture();
			await f.create();
			expect((await f.decide(choice)).state).toBe("recorded");
			expect(f.commands).toHaveLength(2);
			expect(f.ports.native.present).not.toHaveBeenCalled();
		},
	);
	it.each([12, 13, 16])("hop %s requires Owner before any lower decision", async (hop) => {
		const f = fixture(hop);
		await f.create();
		expect(f.request().binding.tier).toBe("owner");
		expect((await f.decide()).state).toBe("invalid");
		expect(f.commands).toHaveLength(1);
	});
	it("host cannot select lower at 12", async () => {
		const f = fixture(12);
		vi.mocked(f.ports.host.selectApprover).mockResolvedValue(verified(f.lower));
		expect((await f.create()).state).toBe("unavailable");
		expect(f.commands).toEqual([]);
	});
	it("no distinct lower approver uses explicit native Owner fallback", async () => {
		const f = fixture();
		vi.mocked(f.ports.host.selectApprover).mockResolvedValue(
			verified({ tier: "owner", reason: "no_distinct_lower_approver" }),
		);
		await f.create();
		expect(f.request().state).toBe("awaiting_owner");
		expect(f.request().binding.upperHop).toBe(11);
	});
	it.each(["self", "task", "old-home"])("invalid selected %s cannot grant lower authority", async (kind) => {
		const f = fixture();
		const home =
			kind === "self"
				? { ...approver, role: "ops" }
				: kind === "task"
					? { ...approver, task: requester.task }
					: { ...approver, currentHome: false };
		vi.mocked(f.ports.host.selectApprover).mockResolvedValue(
			verified({ ...f.lower, tier: "lower", home, role: home.role }),
		);
		expect((await f.create()).state).toBe("unavailable");
	});
	it("requester cannot decide its own request", async () => {
		const f = fixture();
		await f.create();
		expect((await f.decide("one_send", invocation)).state).toBe("invalid");
	});
	it("home replacement and wrong verified authority are rejected", async () => {
		const f = fixture();
		await f.create();
		vi.mocked(f.ports.host.verifyInvocation).mockResolvedValue(
			verified({ ...approver, identityRevision: "replacement-home" }),
		);
		expect((await f.decide()).state).toBe("invalid");
	});
	it("expired request and stale generation fail closed", async () => {
		const f = fixture();
		await f.create();
		f.setNow(f.request().expiresAt);
		expect((await f.decide()).state).toBe("unavailable");
		expect(
			(
				await f.adapter.agent.roleDecision(lowerInvocation, {
					requestId: "request-1",
					generation: "old",
					choice: "deny",
					reason: "stale",
				})
			).state,
		).toBe("unavailable");
	});
	it("native role decision binding mismatch fails", async () => {
		const f = fixture();
		await f.create();
		const original = vi.mocked(f.ports.host.verifyRoleDecision).getMockImplementation()!;
		vi.mocked(f.ports.host.verifyRoleDecision).mockImplementation(async (ref, b) => {
			const d = await original(ref, b);
			if (d.state !== "verified") return d;
			return b.version === policy.version
				? verified({ ...d.value, binding: { ...b, generation: "stale" } })
				: verified({ ...d.value, binding: { ...b, generation: "stale" } });
		});
		expect((await f.decide()).state).toBe("invalid");
	});
});
describe("actual Owner event references, not prose or copied IDs", () => {
	it("finite native Ask retains all context and prohibits free text", async () => {
		const f = fixture(12);
		await f.create();
		const request = f.request();
		if (!legacyRequest(request)) throw new Error("synthetic legacy Owner question revision mismatch");
		const q = await f.ports.native.question(request, "digest");
		if (q.state !== "verified") throw new Error("fixture");
		const ask = ownerApprovalAsk(q.value, 1000);
		expect(ask.createdAt).toBe(1000);
		expect(ask.fields[0].multi).toBe(false);
		expect(ask.fields[0].allowText).toBe(false);
		expect(ask.fields[0].options.map((o) => o.value)).toEqual(["deny", "one_send", "requested_quantity"]);
		expect(ask.fields[0].detail).toContain(context.goal);
		expect(ask.fields[0].detail).toContain(context.timeCostRisk);
		for (const key of Object.keys(context)) expect(ask.fields[0].detail).toContain(key);
		expect(checkAnswers(ask, [{ id: q.value.generation, selected: [], text: "Approved, from Owner" }])).not.toBeNull();
	});
	it("authenticated browser answer reaches E only, never business transport", async () => {
		const f = fixture(12);
		await f.create();
		expect((await f.adapter.native.ownerAnswer(f.answer)).state).toBe("recorded");
		expect(f.commands.map((c) => c.kind)).toEqual(["request_record", "decision_record"]);
	});
	it("authorised Owner Telegram native event is accepted", async () => {
		const f = fixture(12);
		await f.create();
		const original = vi.mocked(f.ports.host.verifyOwnerAnswer).getMockImplementation()!;
		vi.mocked(f.ports.host.verifyOwnerAnswer).mockImplementation(async (ref, q) => {
			const v = await original(ref, q);
			return v.state === "verified" && v.value.authority.tier === "owner"
				? verified({
						...v.value,
						authority: {
							...v.value.authority,
							source: {
								kind: "authorised_owner_telegram",
								authenticatedOwnerBindingId: "fake-owner-principal",
								pluginId: "authorised-synthetic-telegram",
							},
						},
					})
				: v;
		});
		expect((await f.adapter.native.ownerAnswer(f.answer)).state).toBe("recorded");
	});
	it.each(["Owner approved", "browser", "copied-native-id", "auto-approve"])(
		"%s is not an Owner event",
		async (event) => {
			const f = fixture(12);
			await f.create();
			expect((await f.adapter.native.ownerAnswer({ ...f.answer, nativeAnswerEventId: event })).state).toBe("invalid");
			expect(f.commands).toHaveLength(1);
		},
	);
	it("unauthorised Telegram event never tries another channel", async () => {
		const f = fixture(12);
		await f.create();
		vi.mocked(f.ports.host.verifyOwnerAnswer).mockResolvedValue({
			state: "unavailable",
			reason: "Telegram permission revoked",
		});
		expect((await f.adapter.native.ownerAnswer(f.answer)).state).toBe("unavailable");
		expect(f.ports.native.present).not.toHaveBeenCalled();
	});
	it.each(["questionId", "generation"] as const)("copied/wrong %s fails before answer verifier", async (key) => {
		const f = fixture(12);
		await f.create();
		expect((await f.adapter.native.ownerAnswer({ ...f.answer, [key]: "wrong" })).state).toBe("invalid");
		expect(f.ports.host.verifyOwnerAnswer).not.toHaveBeenCalled();
	});
	it.each(["context", "choices", "scope", "digest"])("altered native question %s is rejected", async (kind) => {
		const f = fixture(12);
		await f.create();
		vi.mocked(f.ports.native.question).mockImplementation(async (r, digest) => {
			const untrustedQuestionChoices = (
				kind === "choices" ? ["requested_quantity", "one_send", "deny"] : ["deny", "one_send", "requested_quantity"]
			) as GuardOwnerQuestion["choices"];
			const body = {
				questionId: "native-q1",
				generation: "native-q-g1",
				detail: kind === "context" ? { ...r.context, goal: "replacement" } : r.context,
				choices: untrustedQuestionChoices,
				choicesDigest: kind === "digest" ? "wrong" : digest,
			};
			const b = r.binding;
			return b.version === policy.version
				? verified({ ...body, binding: kind === "scope" ? { ...b, scope: { ...b.scope, scopeId: "different" } } : b })
				: verified({ ...body, binding: kind === "scope" ? { ...b, scope: { ...b.scope, scopeId: "different" } } : b });
		});
		expect((await f.adapter.native.ownerAnswer(f.answer)).state).toBe("invalid");
	});
	it("request expiry holds native answer", async () => {
		const f = fixture(12);
		await f.create();
		f.setNow(f.request().expiresAt);
		expect((await f.adapter.native.ownerAnswer(f.answer)).state).toBe("unavailable");
		expect(f.commands).toHaveLength(1);
	});
	it("first native answer wins; conflicting second answer is arbitrated only by E", async () => {
		const f = fixture(12);
		await f.create();
		const [a, b] = await Promise.all([
			f.adapter.native.ownerAnswer(f.answer),
			f.adapter.native.ownerAnswer({ ...f.answer, nativeAnswerEventId: "native-event-2" }),
		]);
		expect([a.state, b.state].sort()).toEqual(["blocked", "recorded"]);
		expect(f.request().firstDecision?.firstAnswerEventId).toBe("native-event-1");
	});
	it("reconnected same event preserves deterministic mutation identity", async () => {
		const f = fixture(12);
		await f.create();
		await f.adapter.native.ownerAnswer(f.answer);
		await f.adapter.native.ownerAnswer(f.answer);
		const decisions = f.commands.filter((c) => c.kind === "decision_record");
		expect(decisions[0].identity).toEqual(decisions[1].identity);
	});
});
describe("bounded controls use original root, E and ordinary allowance", () => {
	// #122: E refuses every initial control for an Owner-tier phase, so the Owner question is question-only:
	// shown natively with no agent message (no control_send) and no charge.
	it("initial Owner phase is question-only: native question, no control_send, no charge", async () => {
		const f = fixture(12);
		await f.create();
		const before = f.commands.length;
		expect((await f.adapter.agent.notify(invocation, "request-1", "request-g1", "initial")).state).toBe("confirmed");
		expect(f.commands).toHaveLength(before);
		expect(f.ports.native.control).not.toHaveBeenCalled();
		expect(f.ports.native.present).toHaveBeenCalledOnce();
		expect(vi.mocked(f.ports.native.present).mock.calls[0]?.[2]).toBeNull();
	});
	it("only the requester asks for its own Owner question", async () => {
		const f = fixture(12);
		await f.create();
		expect((await f.adapter.agent.notify(lowerInvocation, "request-1", "request-g1", "initial")).state).toBe("invalid");
		expect(f.ports.native.present).not.toHaveBeenCalled();
	});
	it("every A command carries E's exact command fingerprint", async () => {
		const f = fixture();
		await f.create();
		await f.adapter.agent.notify(invocation, "request-1", "request-g1", "initial");
		await f.decide("deny");
		expect(f.commands.length).toBeGreaterThanOrEqual(3);
		for (const c of f.commands) expect(c.identity.fingerprint).toBe(guardCommandFingerprint(c));
	});
	it("lower control never creates an Owner ask", async () => {
		const f = fixture();
		await f.create();
		expect((await f.adapter.agent.notify(invocation, "request-1", "request-g1", "initial")).state).toBe("accepted");
		expect(f.ports.native.present).not.toHaveBeenCalled();
	});
	it.each(["ordinary_hourly", "held", "duplicate_slot"] as const)(
		"%s prevents native question delivery and any automatic retry",
		async (reason) => {
			const f = fixture();
			await f.create();
			vi.mocked(f.ports.core.execute).mockResolvedValue(f.blocked(reason));
			expect((await f.adapter.agent.notify(invocation, "request-1", "request-g1", "initial")).state).toBe("blocked");
			expect(f.ports.native.present).not.toHaveBeenCalled();
			expect(f.ports.native.question).not.toHaveBeenCalled();
		},
	);
	it("unknown core result never triggers another channel", async () => {
		const f = fixture();
		await f.create();
		vi.mocked(f.ports.core.execute).mockResolvedValue({
			state: "unknown",
			identity: { actor: requester, version: policy.version, operationId: "same", fingerprint: "same" },
			transactionId: "tx",
			reservation: "held",
			retry: "query_same_identity_only",
			reason: "unknown persistence",
		});
		expect((await f.adapter.agent.notify(invocation, "request-1", "request-g1", "initial")).state).toBe("unknown");
		expect(f.ports.native.present).not.toHaveBeenCalled();
	});
	it("control cannot rebase business root", async () => {
		const f = fixture();
		await f.create();
		const control = vi.mocked(f.ports.native.control).getMockImplementation()!;
		vi.mocked(f.ports.native.control).mockImplementation(async (...args) => {
			const c = await control(...args);
			return c.state === "verified"
				? verified({
						...c.value,
						snapshot: {
							...c.value.snapshot,
							causal: { ...f.request().binding.causal, nextHop: 1 },
						} as GuardHostVerified<GuardVerifiedSnapshot>,
					})
				: c;
		});
		expect((await f.adapter.agent.notify(invocation, "request-1", "request-g1", "initial")).state).toBe("invalid");
		expect(f.commands).toHaveLength(1);
	});
	it("decision notice requires an actual recorded decision", async () => {
		const f = fixture();
		await f.create();
		expect((await f.adapter.agent.notify(lowerInvocation, "request-1", "request-g1", "decision")).state).toBe(
			"invalid",
		);
		await f.decide("deny");
		const result = await f.adapter.agent.notify(lowerInvocation, "request-1", "request-g1", "decision");
		expect(result.state).toBe("accepted");
		expect(f.commands.at(-1)).toMatchObject({ kind: "control_send", to: "ops", phase: "decision" });
	});
});
