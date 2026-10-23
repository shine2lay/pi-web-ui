// Synthetic component E fixtures ONLY. Fake brands/ports below are NOT native authentication.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
	GuardActor,
	GuardApprovalBinding,
	GuardApprovalContext,
	GuardApproverSelection,
	GuardAuthority,
	GuardCommand,
	GuardConsumerBinding,
	GuardHostVerified,
	GuardIncidentIdentity,
	GuardKnownCausality,
	GuardOperationIdentity,
	GuardOutboxEntry,
	GuardPolicyV1,
	GuardQuantity,
	GuardProofReference,
	GuardProtectedEvidence,
	GuardProtectedNotice,
	GuardRequest,
	GuardRetention,
	GuardStoreState,
	GuardTime,
	GuardVerification,
	GuardVerifiedDecision,
	GuardVerifiedSnapshot,
} from "../../server/role-message-guard-contract.js";
import type {
	GuardApprovalBindingAny,
	GuardApprovalBindingV2,
	GuardApproverSelectionAny,
	GuardApproverSelectionV2,
	GuardBusinessQuantity,
	GuardCommandAny,
	GuardHostVerifierAny,
	GuardPolicy,
	GuardQuantityV2,
	GuardRequestAny,
	GuardRequestV2,
	GuardResultAny,
	GuardStoreStateAny,
	GuardVerifiedDecisionAny,
	GuardVerifiedDecisionV2,
} from "../../server/role-message-guard-contract-v2.js";
import {
	RoleMessageGuardCore,
	guardCommandFingerprint,
	guardEscalationGeneration,
	type GuardCoreOptions,
} from "../../server/role-message-guard-core.js";
import { GuardFileStore, guardDigest, type GuardFileBoundary } from "../../server/role-message-guard-store.js";
import { GUARD_POLICY_V2, guardQuantityValid } from "../../server/role-message-limits.js";

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
const binding: GuardConsumerBinding = {
	version: policy.version,
	contractCommit: "04fe491fb3afc3b42462ad782b2099c7971c7008",
	contractSha256: "79a5a1e1a704ecfbb36a70fc1b210ee6e27575013843122cf202a84592b4c7af",
	policyDocumentSha256: "5d8433fd0a8f9a82103009e43491182caf14b80ad2a20b874709c5b3762724a9",
	blockers: [
		"native_owner_authentication",
		"native_home_authority",
		"native_causal_binding",
		"native_producer_qualification",
		"atomic_legacy_publication",
		"durable_first_answer",
		"transport_wake_deduplication",
		"previous_reader_accounting",
		"bounded_retention_replay",
	],
};
const retention: GuardRetention = {
	maximumRequests: 256,
	maximumGrants: 256,
	maximumTransactions: 4096,
	maximumAuditReceipts: 8192,
	maximumOutboxEntries: 2048,
	maximumUsageEvents: 4096,
	maximumTombstones: 8192,
	maximumContextBytes: 16384,
	settledRetentionMs: 7 * 86400000,
	sourceReplayHorizonMs: "unknown",
};
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fakeVerified = <T>(value: T): GuardHostVerified<T> => value as GuardHostVerified<T>;
const verified = <T>(value: T): GuardVerification<T> => ({ state: "verified", value: fakeVerified(value) });
// Revision-only narrowing of correlated synthetic records; not native authentication or bounds validation.
const legacyRequest = (request: GuardRequestAny): request is GuardRequest => request.binding.version === policy.version;
const legacyDecision = (decision: GuardVerifiedDecisionAny): decision is GuardVerifiedDecision =>
	decision.binding.version === policy.version;
const actor = (role = "alpha", currentHome = true): GuardActor => ({
	role,
	sessionFile: `/synthetic/${role}.jsonl`,
	sessionId: `${role}-home`,
	runtimeIncarnation: "synthetic-process",
	task: { kind: "home" },
	currentHome,
	identityRevision: "synthetic-identity",
});
const causal = (hop = 1, root = "synthetic-root"): GuardKnownCausality => ({
	kind: "rooted",
	rootId: root,
	parentId: hop === 1 ? null : `synthetic-parent-${hop - 1}`,
	nextHop: hop,
	sourceRevision: "synthetic-source",
	incomingRecordId: hop === 1 ? null : `synthetic-parent-${hop - 1}`,
	incomingHash: "synthetic-hash",
});
const context: GuardApprovalContext = {
	goal: "Finish a synthetic requested task",
	progressAndChanges: "Nothing delivered",
	priorDecisions: [],
	whyNeeded: "Chain reached its boundary",
	nextStepAndOutcome: "Ask the named recipient once",
	outstandingQuestions: ["Allow finite communications?"],
	optionsAndTradeoffs: ["Deny", "One send", "Requested quantity"],
	timeCostRisk: "No spending or action consent",
	exactCommunicationAuthority: "Only this task, original root and scope",
	nativeFacts: [],
	declaredClaims: ["Agent claims are not verified facts"],
	safetyScopeAndHolds: ["Every hold still applies"],
};
const seed = (now: number): GuardStoreState => ({
	version: policy.version,
	revision: "synthetic-seed",
	mode: "enabled",
	lastTrustedTime: now,
	requests: [],
	grants: [],
	incidents: [],
	usage: [],
	transactions: [],
	outbox: [],
	audits: [],
	tombstones: [],
	overflow: { count: 0, state: "none" },
});

async function fixture(
	caps: Partial<GuardRetention> = {},
	initial?: GuardStoreStateAny,
	selectedPolicy: GuardPolicy = policy,
) {
	const currentBinding = binding;
	const dir = mkdtempSync(join(tmpdir(), "guard-core-unit-"));
	dirs.push(dir);
	let tail: Promise<unknown> = Promise.resolve();
	const withExclusive = <T>(work: () => Promise<T>): Promise<T> => {
		const run = tail.then(work, work);
		tail = run.catch(() => {});
		return run;
	};
	const f = {
		now: 2000000000,
		clockState: "trusted" as GuardTime["state"],
		nativeAvailable: true,
		decisionAvailable: true,
		lineageAvailable: true,
		statusAvailable: true,
		rollbackAllowed: true,
		hold: false,
		decisionDrift: false,
		wrongTarget: false,
		selectExplicit: false,
		calls: [] as GuardFileBoundary[],
		fail: null as GuardFileBoundary | null,
		dispatches: 0,
		wakes: 0,
		loseDispatchAck: false,
		loseWakeAck: false,
		routeBusy: false,
		proofs: new Map<string, GuardProofReference>(),
		snapshots: new Map<string, GuardVerifiedSnapshot>(),
	};
	const proof = (eventId = "synthetic-native-event"): GuardProofReference => ({
		sourceId: "synthetic-source",
		sourceVersion: "test-only-v1",
		sourceIncarnation: "test-process",
		eventId,
		revision: "synthetic-revision",
		digest: "synthetic-digest",
		observedAt: f.now,
	});
	const clock = (): GuardTime => ({ nowMs: f.now, lastObservedMs: f.now, state: f.clockState });
	const scope = {
		scopeId: "synthetic-scope",
		operation: "synthetic-question",
		participants: ["alpha", "gamma"] as [string, ...string[]],
		recipients: ["beta"] as [string, ...string[]],
		task: { kind: "home" as const },
	};
	const snapshot = (
		who = actor(),
		c = causal(),
		authority: GuardAuthority | null = null,
		incident: GuardProtectedEvidence | null = null,
	): GuardHostVerified<GuardVerifiedSnapshot> =>
		fakeVerified({
			actor: who,
			causal: c,
			authority,
			incident,
			sourceRevision: "synthetic-source",
			time: clock(),
			holds: {
				ownerPaused: f.hold,
				roleDeliveryPaused: false,
				wakesDisabled: false,
				accessDenied: false,
				scopeDenied: false,
				spendingOrConsentDenied: false,
				queueOrSessionMismatch: false,
				sourcePermissionRevoked: false,
			},
		});
	const storeOptions = {
		journalPath: join(dir, "guard-journal.json"),
		legacyPath: join(dir, "role-messages.json"),
		maximumBytes: 32 * 1024 * 1024,
		withExclusive,
		boundary: (point: GuardFileBoundary) => {
			f.calls.push(point);
			if (point === f.fail) throw new Error(`synthetic fault ${point}`);
		},
	};
	const store = new GuardFileStore(storeOptions);
	const initialState: GuardStoreStateAny =
		initial ??
		(selectedPolicy.version === policy.version ? seed(f.now) : { ...seed(f.now), version: GUARD_POLICY_V2.version });
	expect(
		(
			await store.initialize(initialState, {
				v: 1,
				paused: false,
				messages: [],
			})
		).state,
	).toBe("ready");
	function selectApprover(b: GuardApprovalBinding): Promise<GuardVerification<GuardApproverSelection>>;
	function selectApprover(b: GuardApprovalBindingV2): Promise<GuardVerification<GuardApproverSelectionV2>>;
	function selectApprover(b: GuardApprovalBindingAny): Promise<GuardVerification<GuardApproverSelectionAny>>;
	async function selectApprover(b: GuardApprovalBindingAny): Promise<GuardVerification<GuardApproverSelectionAny>> {
		if (!f.nativeAvailable) return { state: "unavailable", reason: "native selection unavailable" };
		if (b.tier === "lower")
			return verified({ tier: "lower", role: "coo", route: "coo", home: actor("coo"), proof: proof() });
		if (f.selectExplicit) return verified({ tier: "owner", reason: "explicit_escalation" });
		return b.version === policy.version
			? verified({
					tier: "owner",
					reason: b.causal.nextHop >= policy.depth.ownerFrom ? "hop_12_plus" : "no_distinct_lower_approver",
				})
			: verified({
					tier: "owner",
					reason: b.causal.nextHop >= GUARD_POLICY_V2.depth.ownerFrom ? "hop_23_plus" : "no_distinct_lower_approver",
				});
	}
	function reverifyDecision(
		d: GuardVerifiedDecision,
		r: GuardRequest,
	): Promise<GuardVerification<GuardVerifiedDecision>>;
	function reverifyDecision(
		d: GuardVerifiedDecisionV2,
		r: GuardRequestV2,
	): Promise<GuardVerification<GuardVerifiedDecisionV2>>;
	function reverifyDecision(
		...args: [GuardVerifiedDecision, GuardRequest] | [GuardVerifiedDecisionV2, GuardRequestV2]
	): Promise<GuardVerification<GuardVerifiedDecisionAny>>;
	async function reverifyDecision(
		...[d]: [GuardVerifiedDecision, GuardRequest] | [GuardVerifiedDecisionV2, GuardRequestV2]
	): Promise<GuardVerification<GuardVerifiedDecisionAny>> {
		if (!f.decisionAvailable)
			return { state: "unavailable", reason: "synthetic first answer/native source unavailable" };
		return legacyDecision(d)
			? verified(f.decisionDrift ? { ...d, reason: "Synthetic drifted native record" } : d)
			: verified(f.decisionDrift ? { ...d, reason: "Synthetic drifted native record" } : d);
	}
	const verifier: GuardHostVerifierAny = {
		verifyInvocation: async () => ({ state: "unavailable", reason: "not a real invocation adapter" }),
		verifyCausality: async () => ({ state: "unavailable", reason: "not a real ancestry adapter" }),
		selectApprover,
		verifyRoleDecision: async () => ({ state: "unavailable", reason: "not a real role decision adapter" }),
		verifyOwnerAnswer: async () => ({ state: "unavailable", reason: "not a real Owner answer adapter" }),
		verifyIncident: async () => ({ state: "unavailable", reason: "P125 native producer NOT qualified" }),
		revalidate: async (s) =>
			f.nativeAvailable
				? verified(snapshot(s.actor, s.causal, s.authority, s.incident))
				: { state: "unavailable", reason: "synthetic native boundary denies" },
	};
	const options: GuardCoreOptions = {
		binding: currentBinding,
		policy: selectedPolicy,
		retention: { ...retention, ...caps },
		store,
		verifier,
		clock: async () => clock(),
		requestSnapshot: async (a, r) => verified(snapshot(a, r.binding.causal)),
		reverifyDecision,
		verifyGrantLineage: async (_g, s) =>
			f.lineageAvailable ? verified(s) : { state: "invalid", reason: "synthetic ancestry contradicts" },
		restoreSnapshot: async (entry) => {
			const s = f.snapshots.get(entry.receipt.identity.operationId);
			return s
				? verified(snapshot(s.actor, s.causal, s.authority, s.incident))
				: { state: "unavailable", reason: "synthetic restoration unavailable" };
		},
		verifyStatusActor: async (a) =>
			f.statusAvailable ? verified(a) : { state: "unavailable", reason: "native actor not found" },
		materialize: async (i) => ({
			id: i.id,
			at: i.at,
			from: { role: i.actor.role, title: i.actor.role, chat: "synthetic home", file: i.actor.sessionFile },
			to: { role: i.to, title: i.to },
			kind: i.kind,
			text: i.text,
			chain: i.chain,
			...(i.replyTo ? { replyTo: i.replyTo } : {}),
			...(i.target ? { target: f.wrongTarget ? "/synthetic/elsewhere.jsonl" : i.target } : {}),
			state: "waiting",
			sends: 0,
			attempts: 0,
			forOwner: true,
			ownerIds: ["synthetic-owner-thread"],
			ownerChannel: "browser",
			initiative: "synthetic-initiative",
		}),
		maintenanceIdentity: (purpose, key) => ({
			version: "role-message-guard/v1",
			operationId: `${purpose}:${guardDigest(key)}`,
			fingerprint: guardDigest({ purpose, key }),
			actor: actor("synthetic-host"),
		}),
		authoriseRollback: async () => f.rollbackAllowed,
		transport: {
			dispatch: async (entry) => {
				if (!f.proofs.has(entry.receipt.dispatchKey)) {
					f.dispatches++;
					f.proofs.set(entry.receipt.dispatchKey, proof(entry.receipt.dispatchKey));
				}
				return f.loseDispatchAck
					? { state: "unknown", reason: "synthetic lost dispatch acknowledgment" }
					: { state: "confirmed", proof: f.proofs.get(entry.receipt.dispatchKey)! };
			},
			wake: async (entry) => {
				if (!f.proofs.has(entry.receipt.wakeKey)) {
					f.wakes++;
					f.proofs.set(entry.receipt.wakeKey, proof(entry.receipt.wakeKey));
				}
				return f.loseWakeAck
					? { state: "unknown", reason: "synthetic lost wake acknowledgment" }
					: { state: "confirmed", proof: f.proofs.get(entry.receipt.wakeKey)! };
			},
			query: async (entry) => {
				const p = f.proofs.get(
					entry.wakeState === "requested" || entry.wakeState === "unknown"
						? entry.receipt.wakeKey
						: entry.receipt.dispatchKey,
				);
				return p ? { state: "confirmed", proof: p } : { state: "unknown", reason: "synthetic effect not proved" };
			},
		},
	};
	const core = new RoleMessageGuardCore(options);
	function identified<T extends GuardCommandAny>(command: T): T {
		const completed = { ...command, identity: { ...command.identity, fingerprint: guardCommandFingerprint(command) } };
		if ("snapshot" in completed) f.snapshots.set(completed.identity.operationId, completed.snapshot);
		return completed;
	}
	const identity = (id: string, who = actor()): GuardOperationIdentity => ({
		operationId: id,
		fingerprint: "pending",
		actor: who,
		version: "role-message-guard/v1",
	});
	const business = (
		id: string,
		hop = 1,
		grantId: string | null = null,
		authority: GuardAuthority | null = null,
		who = actor(),
		root = "synthetic-root",
	) =>
		identified<Extract<GuardCommand, { kind: "business_send" }>>({
			kind: "business_send",
			identity: identity(id, who),
			snapshot: snapshot(who, causal(hop, root), authority),
			scope: {
				...scope,
				participants: scope.participants.includes(who.role)
					? scope.participants
					: ([...scope.participants, who.role] as [string, ...string[]]),
			},
			to: "beta",
			businessKind: "question",
			text: "Synthetic exact words",
			replyTo: null,
			grantId,
		});
	const proposal = (
		id: string,
		hop = 7,
		quantity: GuardQuantity = 1,
		tier: "lower" | "owner" = hop >= policy.depth.ownerFrom ? "owner" : "lower",
		who = actor(),
	): GuardRequest => {
		const b: GuardApprovalBinding = {
			version: policy.version,
			requestId: id,
			generation: "synthetic-generation-1",
			requester: who,
			causal: causal(hop),
			scope,
			tier,
			quantity,
			upperHop: hop + quantity - 1,
		};
		return {
			binding: b,
			context,
			selectedApprover:
				tier === "owner"
					? { tier, reason: "hop_12_plus" }
					: { tier, role: "coo", route: "coo", home: actor("coo"), proof: proof() },
			createdAt: f.now,
			expiresAt: f.now + 86400000,
			state: tier === "owner" ? "awaiting_owner" : "awaiting_approver",
			upwardEscalations: 0,
			initialNotificationKey: "untrusted-replaced",
			decisionNotificationKey: "untrusted-replaced",
			firstDecision: null,
			grantId: null,
		};
	};
	const proposalV2 = (
		id: string,
		hop = 13,
		quantity: GuardQuantityV2 = 1,
		tier: "lower" | "owner" = hop >= GUARD_POLICY_V2.depth.ownerFrom ? "owner" : "lower",
		who = actor(),
	): GuardRequestV2 => ({
		binding: {
			version: GUARD_POLICY_V2.version,
			requestId: id,
			generation: "synthetic-generation-1",
			requester: who,
			causal: causal(hop),
			scope,
			tier,
			quantity,
			upperHop: hop + quantity - 1,
		},
		context,
		selectedApprover:
			tier === "owner"
				? { tier, reason: "hop_23_plus" }
				: { tier, role: "coo", route: "coo", home: actor("coo"), proof: proof() },
		createdAt: f.now,
		expiresAt: f.now + 86400000,
		state: tier === "owner" ? "awaiting_owner" : "awaiting_approver",
		upwardEscalations: 0,
		initialNotificationKey: "untrusted-replaced",
		decisionNotificationKey: "untrusted-replaced",
		firstDecision: null,
		grantId: null,
	});
	const recordRequest = (request: GuardRequestAny, id = `request:${request.binding.requestId}`) => {
		const body = {
			kind: "request_record" as const,
			identity: identity(id, request.binding.requester),
			actor: fakeVerified(request.binding.requester),
		};
		return legacyRequest(request)
			? core.execute(identified({ ...body, request }))
			: core.execute(identified({ ...body, request }));
	};
	function decision(
		request: GuardRequest,
		choice?: GuardVerifiedDecision["choice"],
		event?: string,
	): GuardVerifiedDecision;
	function decision(
		request: GuardRequestV2,
		choice?: GuardVerifiedDecision["choice"],
		event?: string,
	): GuardVerifiedDecisionV2;
	function decision(
		request: GuardRequestAny,
		choice?: GuardVerifiedDecision["choice"],
		event?: string,
	): GuardVerifiedDecisionAny;
	function decision(
		request: GuardRequestAny,
		choice: GuardVerifiedDecision["choice"] = "requested_quantity",
		event = "synthetic-first-answer",
	): GuardVerifiedDecisionAny {
		if (request.binding.tier === "lower" && request.selectedApprover.tier !== "lower")
			throw new Error("synthetic lower decision requires a lower selection");
		const authority: GuardAuthority =
			request.binding.tier === "lower" && request.selectedApprover.tier === "lower"
				? { tier: "lower", selection: request.selectedApprover, decisionId: event, proof: proof(event) }
				: {
						tier: "owner",
						questionId: "synthetic-native-question",
						questionGeneration: request.binding.generation,
						choicesDigest: "synthetic-fixed-choices",
						decisionId: event,
						source: { kind: "authenticated_browser", authenticatedOwnerBindingId: "synthetic-browser-owner" },
						proof: proof(event),
					};
		const body = {
			choice,
			reason: "Synthetic communication-only decision",
			answeredAt: f.now,
			firstAnswerEventId: event,
			authority,
		};
		return legacyRequest(request) ? { ...body, binding: request.binding } : { ...body, binding: request.binding };
	}
	const decisionCommand = (d: GuardVerifiedDecisionAny, id = `decision:${d.firstAnswerEventId}`) => {
		const body = {
			kind: "decision_record" as const,
			identity: identity(id, d.authority.tier === "lower" ? d.authority.selection.home : d.binding.requester),
		};
		return legacyDecision(d)
			? identified({ ...body, decision: fakeVerified(d) })
			: identified({ ...body, decision: fakeVerified(d) });
	};
	const recordDecision = (d: GuardVerifiedDecisionAny, id = `decision:${d.firstAnswerEventId}`) =>
		core.execute(decisionCommand(d, id));
	const control = (id: string, request: GuardRequestAny, phase: "initial" | "decision", to: string, who = actor()) =>
		identified<Extract<GuardCommand, { kind: "control_send" }>>({
			kind: "control_send",
			identity: identity(id, who),
			snapshot: snapshot(who, request.binding.causal),
			requestId: request.binding.requestId,
			generation: request.binding.generation,
			phase,
			to,
		});
	async function grant(hop = selectedPolicy.depth.unapprovedThrough + 1, quantity: GuardBusinessQuantity = 1) {
		const id = `req-${hop}-${quantity}`;
		let request: GuardRequestAny;
		if (selectedPolicy.version === policy.version) {
			if (!guardQuantityValid(quantity, policy.version)) throw new Error("synthetic V1 quantity mismatch");
			request = proposal(id, hop, quantity);
		} else request = proposalV2(id, hop, quantity);
		const requested = await recordRequest(request);
		expect(requested.state).toBe("recorded");
		if (requested.state !== "recorded") throw new Error("synthetic request failed");
		const d = decision(requested.request);
		const approved = await recordDecision(d);
		expect(approved.state).toBe("recorded");
		if (approved.state !== "recorded") throw new Error("synthetic decision failed");
		return { id: approved.request.grantId!, authority: d.authority, request: approved.request };
	}
	const incident = (episode = "episode-1", who = actor(), destination = "beta"): GuardIncidentIdentity => ({
		producer: proof("synthetic-producer-episode"),
		nativeEpisodeId: episode,
		episodeGeneration: "synthetic-episode-generation",
		resourceId: `synthetic-resource-${episode}`,
		resourceOwnerRole: "alpha",
		origin: who,
		assignedDestinationRole: destination,
		destinationIdentityRevision: "synthetic-destination-v1",
		causal: causal(99),
		openedAt: f.now,
		expiresAt: f.now + 86400000,
	});
	const notice = (
		id: string,
		i = incident(),
		type: "initial" | "result" = "initial",
		body = "Synthetic fixed-template critical notice",
	) => {
		const evidence: GuardProtectedEvidence =
			type === "initial"
				? {
						type: "safety_action_notice",
						incident: i,
						criticalCategory: "security",
						actionId: "synthetic-action",
						actionState: "required",
						actionAuthority: null,
						receipt: proof(id),
					}
				: {
						type: "safety_action_result",
						incident: i,
						actionId: "synthetic-action",
						actionAuthority: proof("synthetic-action-authority"),
						outcome: "indeterminate",
						terminalReceipt: proof(id),
					};
		const n: GuardProtectedNotice = {
			evidence,
			templateVersion: "synthetic-template-v1",
			text: body,
			renderedBytes: Buffer.byteLength(body, "utf8"),
			grantsActionAuthority: false,
		};
		return identified<Extract<GuardCommand, { kind: "protected_send" }>>({
			kind: "protected_send",
			identity: identity(id, i.origin),
			snapshot: snapshot(i.origin, i.causal, null, evidence),
			notice: fakeVerified(n),
		});
	};
	const state = async () => {
		const read = await store.read();
		if (read.state !== "ready") throw new Error(read.reason);
		return read.value;
	};
	return {
		f,
		dir,
		core,
		store,
		storeOptions,
		options,
		identified,
		identity,
		snapshot,
		business,
		proposal,
		proposalV2,
		recordRequest,
		decision,
		decisionCommand,
		recordDecision,
		control,
		grant,
		incident,
		notice,
		state,
	};
}
function reason(result: GuardResultAny): string {
	return result.state === "blocked" ? result.reason : result.state;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function escalated(t: Fixture, id = "esc", hop = 9, quantity: 1 | 2 | 3 | 4 | 5 = 3) {
	const requested = await t.recordRequest(t.proposal(id, hop, quantity));
	if (requested.state !== "recorded") throw new Error(`synthetic lower request failed: ${reason(requested)}`);
	const lower = requested.request;
	if (!legacyRequest(lower)) throw new Error("synthetic legacy escalation request mismatch");
	const escalation = t.decision(lower, "escalate_owner", `${id}-lower-escalates`);
	const r = await t.recordDecision(escalation);
	if (r.state !== "recorded") throw new Error(`synthetic escalation failed: ${reason(r)}`);
	if (!legacyRequest(r.request)) throw new Error("synthetic legacy escalation phase mismatch");
	return { lower, escalation, phase: r.request };
}

describe("expanded V2 core: exact boundaries with unchanged V1 vectors below", () => {
	it("accepts 40 concurrent capped sends, refuses 41, deduplicates, then releases at exactly one hour", async () => {
		const t = await fixture({}, undefined, GUARD_POLICY_V2);
		const start = t.f.now;
		const results = await Promise.all(Array.from({ length: 41 }, (_, n) => t.core.execute(t.business(`v2-hour-${n}`))));
		expect(results.filter((r) => r.state === "accepted")).toHaveLength(40);
		expect(reason(results[40])).toBe("ordinary_hourly");
		expect((await t.state()).usage).toHaveLength(40);
		expect(await t.core.execute(t.business("v2-hour-0"))).toEqual(results[0]);
		expect((await t.state()).usage).toHaveLength(40);
		t.f.now = start + 3_600_000 - 1;
		expect(reason(await t.core.execute(t.business("v2-before-edge")))).toBe("ordinary_hourly");
		t.f.now++;
		expect(reason(await t.core.execute(t.business("v2-at-edge")))).toBe("accepted");
		// Counterfactual: the same 21st send is red with the old active policy.
		const old = await fixture();
		for (let n = 0; n < 20; n++) expect(reason(await old.core.execute(old.business(`old-hour-${n}`)))).toBe("accepted");
		expect(reason(await old.core.execute(old.business("old-21")))).toBe("ordinary_hourly");
	});
	it.each([
		[12, "accepted"],
		[13, "lower"],
		[22, "lower"],
		[23, "owner"],
	] as const)("hop %i resolves to %s", async (hop, required) => {
		const t = await fixture({}, undefined, GUARD_POLICY_V2);
		const result = await t.core.execute(t.business(`v2-hop-${hop}`, hop));
		if (required === "accepted") expect(result.state).toBe("accepted");
		else expect(result).toMatchObject({ state: "blocked", reason: "approval_required", requiredTier: required });
		const old = await fixture();
		expect(reason(await old.core.execute(old.business(`old-hop-${hop}`, hop)))).toBe("approval_required");
	});
	it.each([
		[13, 10, "lower", "recorded"],
		[13, 11, "lower", "invalid_input"],
		[22, 1, "lower", "recorded"],
		[22, 2, "lower", "invalid_input"],
		[23, 10, "owner", "recorded"],
		[24, 10, "owner", "invalid_input"],
		[24, 9, "owner", "recorded"],
		[32, 1, "owner", "recorded"],
		[33, 1, "owner", "invalid_input"],
	] as const)("request hop %i quantity %i tier %s is %s without clamping", async (hop, quantity, tier, result) => {
		const t = await fixture({}, undefined, GUARD_POLICY_V2);
		let request: GuardRequestV2;
		if (quantity === 11) {
			const proposed = t.proposalV2("v2-bounds", hop, 1, tier);
			// Deliberately untrusted negative input, not a well-typed V2 business quantity.
			const untrustedOverLimitInput: unknown = {
				...proposed,
				binding: { ...proposed.binding, quantity, upperHop: hop + quantity - 1 },
			};
			request = untrustedOverLimitInput as GuardRequestV2;
		} else request = t.proposalV2("v2-bounds", hop, quantity, tier);
		expect(reason(await t.recordRequest(request))).toBe(result);
	});
	it("one_send remains one, a lower grant ends at 22, and expiry/forged scope remain closed", async () => {
		const t = await fixture({}, undefined, GUARD_POLICY_V2);
		const asked = await t.recordRequest(t.proposalV2("v2-ten", 13, 10));
		if (asked.state !== "recorded") throw new Error(reason(asked));
		const d = t.decision(asked.request, "one_send");
		const decided = await t.recordDecision(d);
		if (decided.state !== "recorded") throw new Error(reason(decided));
		const g = (await t.state()).grants[0];
		expect(g).toMatchObject({
			maximumUses: 1,
			acceptedUses: 0,
			expiresAt: g.issuedAt + 3_600_000,
			binding: { version: "role-message-guard/v2", quantity: 1, upperHop: 13 },
		});
		expect(
			reason(await t.core.execute(t.business("v2-wrong-root", 13, g.id, d.authority, actor(), "other-root"))),
		).toBe("scope_mismatch");
		expect(reason(await t.core.execute(t.business("v2-one", 13, g.id, d.authority)))).toBe("accepted");
		expect(reason(await t.core.execute(t.business("v2-two", 13, g.id, d.authority)))).toBe("grant_exhausted");
		const full = await fixture({}, undefined, GUARD_POLICY_V2);
		const ten = await full.grant(13, 10);
		expect(reason(await full.core.execute(full.business("v2-upper", 22, ten.id, ten.authority)))).toBe("accepted");
		expect(reason(await full.core.execute(full.business("v2-beyond", 23, ten.id, ten.authority)))).toBe(
			"scope_mismatch",
		);
		full.f.now += 3_600_000;
		expect(reason(await full.core.execute(full.business("v2-expired", 14, ten.id, ten.authority)))).toBe(
			"grant_expired",
		);
	});
	it("V2 still refuses unknown causality, forged origin, stale approval identity and wrong scope without counting", async () => {
		const t = await fixture({}, undefined, GUARD_POLICY_V2);
		for (const hop of [0, NaN, 1.5])
			expect(reason(await t.core.execute(t.business(`v2-unknown-${hop}`, hop)))).toBe("causality_unknown");
		const c = t.business("v2-forged");
		expect(
			reason(await t.core.execute(t.identified({ ...c, identity: { ...c.identity, actor: actor("other") } }))),
		).toBe("authority_unavailable");
		const r = await t.recordRequest(t.proposalV2("v2-stale", 13, 10));
		if (r.state !== "recorded") throw new Error(reason(r));
		const d = t.decision(r.request);
		if (legacyDecision(d)) throw new Error("synthetic V2 decision mismatch");
		expect(
			reason(
				await t.core.execute(
					t.identified({
						...t.decisionCommand(d, "v2-stale-home"),
						identity: t.identity("v2-stale-home", actor("coo", false)),
					}),
				),
			),
		).toBe("authority_unavailable");
		expect(reason(await t.recordDecision({ ...d, binding: { ...d.binding, generation: "wrong-generation" } }))).toBe(
			"authority_unavailable",
		);
		expect(reason(await t.recordDecision(d))).toBe("identity_conflict");
		const approved = await t.recordDecision(d, "v2-valid-decision");
		if (approved.state !== "recorded") throw new Error(reason(approved));
		const g = { id: approved.request.grantId!, authority: d.authority };
		const scoped = t.business("v2-wrong-scope", 13, g.id, g.authority);
		expect(
			reason(
				await t.core.execute(t.identified({ ...scoped, scope: { ...scoped.scope, operation: "different work" } })),
			),
		).toBe("scope_mismatch");
		expect((await t.state()).usage).toHaveLength(0);
		expect((await t.state()).grants[0].acceptedUses).toBe(0);
	});
	it("V1 pending requests/grants and digests survive V2 admission and an inverse-policy reader unchanged", async () => {
		const old = await fixture();
		const g = await old.grant(7, 3);
		const pending = await old.recordRequest(old.proposal("old-pending", 12, 5, "owner"));
		expect(pending.state).toBe("recorded");
		const before = await old.state();
		const active = new RoleMessageGuardCore({
			...old.options,
			binding,
			policy: GUARD_POLICY_V2,
		});
		const expanded = old.proposalV2("new-ten", 13, 10, "lower");
		expect(
			reason(
				await active.execute(
					old.identified({
						kind: "request_record",
						identity: old.identity("new-ten"),
						actor: fakeVerified(expanded.binding.requester),
						request: expanded,
					}),
				),
			),
		).toBe("recorded");
		const mixed = await old.state();
		expect(mixed.version).toBe(GUARD_POLICY_V2.version);
		expect(mixed.grants).toEqual(before.grants);
		expect(mixed.requests.filter((r) => r.binding.version === policy.version)).toEqual(before.requests);
		// The compatibility reader keeps V1 active and can still consume/read precise legacy authority.
		const inverse = new RoleMessageGuardCore(old.options);
		expect(reason(await inverse.execute(old.business("old-exact-use", 7, g.id, g.authority)))).toBe("accepted");
		const exact = (await old.state()).grants.find((v) => v.id === g.id)!;
		expect({ ...exact, acceptedUses: 0, useTransactionIds: [] }).toEqual(before.grants[0]);
		expect(exact.acceptedUses).toBe(1);
		expect((await old.state()).requests.find((r) => r.binding.requestId === "old-pending")).toEqual(
			before.requests.find((r) => r.binding.requestId === "old-pending"),
		);
	});
	it("an inverse active V1 policy reads but cannot spend V2 lower authority above its restored ceiling", async () => {
		const expanded = await fixture({}, seed(2_000_000_000), GUARD_POLICY_V2);
		const g = await expanded.grant(13, 10);
		const before = await expanded.state();
		const inverse = new RoleMessageGuardCore({ ...expanded.options, policy });
		expect(reason(await inverse.execute(expanded.business("inverse-refuses-lower-13", 13, g.id, g.authority)))).toBe(
			"scope_mismatch",
		);
		const after = await expanded.state();
		expect(after.grants).toEqual(before.grants);
		expect(after.requests).toEqual(before.requests);
		expect(after.usage).toEqual(before.usage);
		expect(after.outbox).toEqual(before.outbox);
		expect(after.version).toBe(GUARD_POLICY_V2.version);
		expect(after.grants[0]).toMatchObject({ maximumUses: 10, acceptedUses: 0, authority: g.authority });
		expect(reason(await expanded.core.execute(expanded.business("v2-still-exact", 13, g.id, g.authority)))).toBe(
			"accepted",
		);
		expect((await expanded.state()).grants[0]).toMatchObject({ maximumUses: 10, acceptedUses: 1 });
	});
	it("a V1-to-V2 request publication recovers atomically at every file boundary", async () => {
		const probe = await fixture({}, seed(2_000_000_000), GUARD_POLICY_V2);
		probe.f.calls = [];
		expect(reason(await probe.recordRequest(probe.proposalV2("upgrade", 13, 10)))).toBe("recorded");
		const points = [...new Set(probe.f.calls)];
		expect(points.length).toBeGreaterThan(3);
		for (const point of points) {
			const t = await fixture({}, seed(2_000_000_000), GUARD_POLICY_V2);
			t.f.fail = point;
			await t.recordRequest(t.proposalV2("upgrade", 13, 10));
			t.f.fail = null;
			const restart = new GuardFileStore({ ...t.storeOptions, boundary: null });
			const recovered = await restart.recover();
			if (recovered.state !== "ready") {
				expect((await restart.read()).state).toBe("unknown");
				continue;
			}
			const s = recovered.value;
			expect(s.requests.length === 0 ? s.version === policy.version : s.version === GUARD_POLICY_V2.version).toBe(true);
			if (s.requests.length)
				expect(s.requests).toMatchObject([
					{ binding: { version: GUARD_POLICY_V2.version, quantity: 10, upperHop: 22 } },
				]);
			const core = new RoleMessageGuardCore({ ...t.options, store: restart });
			const replay = await core.execute(
				t.identified({
					kind: "request_record",
					identity: t.identity("request:upgrade"),
					actor: fakeVerified(actor()),
					request: t.proposalV2("upgrade", 13, 10),
				}),
			);
			expect(["recorded", "duplicate"]).toContain(replay.state);
			const after = await restart.read();
			if (after.state !== "ready") throw new Error(after.reason);
			expect(after.value.requests).toHaveLength(1);
		}
	});
	it("V2 retains fail-closed rollback_depth_6 (6/20) and holds, not a doubled rollback mode", async () => {
		const initial = { ...seed(2_000_000_000), version: GUARD_POLICY_V2.version, mode: "rollback_depth_6" as const };
		const t = await fixture({}, initial, GUARD_POLICY_V2);
		expect(reason(await t.core.execute(t.business("rollback-seven", 7)))).toBe("rollback_depth");
		for (let n = 0; n < 20; n++) expect(reason(await t.core.execute(t.business(`rollback-${n}`)))).toBe("accepted");
		expect(reason(await t.core.execute(t.business("rollback-21")))).toBe("ordinary_hourly");
		t.f.hold = true;
		expect(reason(await t.core.execute(t.business("v2-held")))).toBe("held");
	});
});

describe("E admission: frozen policy and real-host boundary requirements", () => {
	it("rejects wrong contract/policy/caps and does not construct a default runtime", async () => {
		const t = await fixture();
		expect(() => new RoleMessageGuardCore({ ...t.options, binding: { ...binding, contractCommit: "wrong" } })).toThrow(
			/pin/,
		);
		expect(
			() =>
				new RoleMessageGuardCore({
					...t.options,
					policy: { ...policy, ordinary: { ...policy.ordinary, acceptedPerOrigin: 21 as 20 } },
				}),
		).toThrow(/pin/);
		expect(
			() => new RoleMessageGuardCore({ ...t.options, retention: { ...retention, maximumRequests: Infinity } }),
		).toThrow(/finite/);
		expect(t.f.dispatches + t.f.wakes).toBe(0);
	});
	it.each([1, 6])("accepts unapproved hop %i with exact causal/legacy words", async (hop) => {
		const t = await fixture();
		const c = t.business(`hop-${hop}`, hop);
		const r = await t.core.execute(c);
		expect(r.state).toBe("accepted");
		if (r.state === "accepted") {
			expect(r.receipt.causal).toEqual(c.snapshot.causal);
			expect(r.receipt.usage.ordinaryOrigin).toBe(1);
		}
		expect(t.f.dispatches + t.f.wakes).toBe(0);
		const legacy = JSON.parse(readFileSync(t.storeOptions.legacyPath, "utf8"));
		expect(legacy.messages[0]).toMatchObject({
			chain: hop,
			text: c.text,
			forOwner: true,
			ownerIds: ["synthetic-owner-thread"],
			ownerChannel: "browser",
		});
	});
	it.each([7, 12])("blocks unapproved hop %i without replay", async (hop) => {
		const t = await fixture();
		const r = await t.core.execute(t.business(`blocked-${hop}`, hop));
		expect(reason(r)).toBe("approval_required");
		if (r.state === "blocked") expect(r.requiredTier).toBe(hop >= 12 ? "owner" : "lower");
		expect((await t.state()).usage).toHaveLength(0);
	});
	it("an erased brand/caller authority does not bypass the native verifier", async () => {
		const t = await fixture();
		t.f.nativeAvailable = false;
		expect(reason(await t.core.execute(t.business("forged-brand")))).toBe("authority_unavailable");
		expect((await t.state()).usage).toHaveLength(0);
	});
	it("rejects caller-forged identity fingerprint and origin", async () => {
		const t = await fixture();
		const c = t.business("identity");
		expect(reason(await t.core.execute({ ...c, identity: { ...c.identity, fingerprint: "agent says urgent" } }))).toBe(
			"invalid_input",
		);
		const changed = t.identified({ ...c, identity: { ...c.identity, actor: actor("other") } });
		expect(reason(await t.core.execute(changed))).toBe("authority_unavailable");
	});
	it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe causal number %s", async (hop) => {
		const t = await fixture();
		expect(reason(await t.core.execute(t.business("unsafe", hop)))).toBe("causality_unknown");
	});
	it("preserves a legacy boundary rather than fabricating its historical root", async () => {
		const t = await fixture();
		const c = t.business("legacy");
		const legacy: GuardKnownCausality = {
			kind: "legacy_boundary",
			anchorId: "synthetic-anchor",
			incomingRecordId: "old-exact-incoming",
			incomingHash: "old-word-hash",
			nextHop: 6,
			historicalRoot: "unknown",
		};
		const r = await t.core.execute(t.identified({ ...c, snapshot: t.snapshot(actor(), legacy) }));
		expect(r.state).toBe("accepted");
		if (r.state === "accepted") expect(r.receipt.causal).toEqual(legacy);
	});
	it.each([
		"ownerPaused",
		"roleDeliveryPaused",
		"wakesDisabled",
		"accessDenied",
		"scopeDenied",
		"spendingOrConsentDenied",
		"queueOrSessionMismatch",
		"sourcePermissionRevoked",
	] as const)("does not bypass native hold %s", async (key) => {
		const t = await fixture();
		t.options.verifier.revalidate = async (s) => verified({ ...s, holds: { ...s.holds, [key]: true } });
		expect(reason(await t.core.execute(t.business(key)))).toBe("held");
	});
});

describe("E grants/requests: finite quantity, first answer and scope", () => {
	it("lower grants permit five declared sends, never hop12 or a sixth use", async () => {
		const t = await fixture();
		const g = await t.grant(7, 5);
		for (let n = 0; n < 5; n++)
			expect((await t.core.execute(t.business(`use-${n}`, 7 + n, g.id, g.authority))).state).toBe("accepted");
		expect(reason(await t.core.execute(t.business("sixth", 7, g.id, g.authority)))).toBe("grant_exhausted");
		expect(reason(await t.core.execute(t.business("hop12", 12, g.id, g.authority)))).toBe("grant_exhausted");
		expect((await t.state()).grants[0].acceptedUses).toBe(5);
	});
	it("rejects a lower-tier request whose quantity reaches hop12", async () => {
		const t = await fixture();
		expect(reason(await t.recordRequest(t.proposal("cross12", 11, 2, "lower")))).toBe("invalid_input");
	});
	it("rejects lower approval at hop12 even before exhaustion", async () => {
		const t = await fixture();
		const g = await t.grant(11, 1);
		expect(reason(await t.core.execute(t.business("too-deep", 12, g.id, g.authority)))).toBe("scope_mismatch");
		expect((await t.state()).grants[0].acceptedUses).toBe(0);
	});
	it("native Owner approval is finite at and above hop12", async () => {
		const t = await fixture();
		const g = await t.grant(12, 2);
		expect((await t.core.execute(t.business("owner-use1", 12, g.id, g.authority))).state).toBe("accepted");
		expect((await t.core.execute(t.business("owner-use2", 13, g.id, g.authority))).state).toBe("accepted");
		expect(reason(await t.core.execute(t.business("owner-use3", 12, g.id, g.authority)))).toBe("grant_exhausted");
	});
	it("one-send choice narrows both hop and shared use allowance", async () => {
		const t = await fixture();
		const p = await t.recordRequest(t.proposal("one", 7, 5));
		if (p.state !== "recorded") throw new Error("fixture");
		const r = await t.recordDecision(t.decision(p.request, "one_send"));
		if (r.state !== "recorded") throw new Error("fixture");
		const g = (await t.state()).grants[0];
		expect(g.binding.upperHop).toBe(7);
		expect(g.maximumUses).toBe(1);
		expect(reason(await t.core.execute(t.business("out-of-hop", 8, g.id, g.authority)))).toBe("scope_mismatch");
	});
	it("concurrent final grant use admits at most one including another declared participant", async () => {
		const t = await fixture();
		const g = await t.grant();
		const a = t.business("last-alpha", 7, g.id, g.authority);
		const b = t.business("last-gamma", 7, g.id, g.authority, actor("gamma"));
		const results = await Promise.all([t.core.execute(a), t.core.execute(b)]);
		expect(results.filter((r) => r.state === "accepted")).toHaveLength(1);
		expect((await t.state()).grants[0].acceptedUses).toBe(1);
	});
	it("does not consume a use for scope, ancestry, recipient or task mismatch", async () => {
		const t = await fixture();
		const g = await t.grant();
		const c = t.business("scope", 7, g.id, g.authority);
		expect(
			reason(await t.core.execute(t.identified({ ...c, scope: { ...c.scope, operation: "different work" } }))),
		).toBe("scope_mismatch");
		t.f.lineageAvailable = false;
		expect(reason(await t.core.execute(t.business("bad-lineage", 7, g.id, g.authority)))).toBe("authority_unavailable");
		t.f.lineageAvailable = true;
		expect(
			reason(await t.core.execute(t.identified({ ...c, identity: t.identity("wrong-recipient"), to: "unlisted" }))),
		).toBe("invalid_input");
		expect((await t.state()).grants[0].acceptedUses).toBe(0);
	});
	it("same operation is idempotent; changed words conflict, not another use", async () => {
		const t = await fixture();
		const g = await t.grant();
		const c = t.business("same", 7, g.id, g.authority);
		const r = await t.core.execute(c);
		expect(await t.core.execute(c)).toEqual(r);
		expect(reason(await t.core.execute(t.identified({ ...c, text: "Changed words" })))).toBe("identity_conflict");
		expect((await t.state()).usage).toHaveLength(1);
	});
	it("first valid answer wins across concurrent approve/deny and replayed callbacks", async () => {
		const t = await fixture();
		const p = await t.recordRequest(t.proposal("first"));
		if (p.state !== "recorded") throw new Error("fixture");
		const approve = t.decision(p.request, "one_send", "first-approve");
		const deny = t.decision(p.request, "deny", "second-deny");
		const results = await Promise.all([t.recordDecision(approve), t.recordDecision(deny)]);
		expect(results.every((r) => r.state === "recorded")).toBe(true);
		const s = await t.state();
		expect(s.grants).toHaveLength(1);
		expect(s.requests[0].firstDecision?.firstAnswerEventId).toBe("first-approve");
		expect(s.audits.filter((a) => a.event === "decided")).toHaveLength(1);
	});
	it("requires a native decision, exact current home, distinct lower approver and complete context", async () => {
		const t = await fixture();
		expect(reason(await t.recordRequest({ ...t.proposal("thin"), context: { ...context, whyNeeded: "" } }))).toBe(
			"invalid_input",
		);
		const p = await t.recordRequest(t.proposal("auth"));
		if (p.state !== "recorded") throw new Error("fixture");
		t.f.decisionAvailable = false;
		expect(reason(await t.recordDecision(t.decision(p.request)))).toBe("authority_unavailable");
		t.f.decisionAvailable = true;
		const d = t.decision(p.request);
		const c = t.identified({
			...t.decisionCommand(d, "stale-home"),
			identity: t.identity("stale-home", actor("coo", false)),
		});
		expect(reason(await t.core.execute(c))).toBe("authority_unavailable");
	});
	it("denial issues no grant, no business replay and no communication charge", async () => {
		const t = await fixture();
		const p = await t.recordRequest(t.proposal("deny"));
		if (p.state !== "recorded") throw new Error("fixture");
		expect((await t.recordDecision(t.decision(p.request, "deny"))).state).toBe("recorded");
		const s = await t.state();
		expect(s.requests[0].state).toBe("denied");
		expect(s.grants).toHaveLength(0);
		expect(s.usage).toHaveLength(0);
	});
	it("one request per root/tier/scope/generation and twenty outstanding per origin", async () => {
		const t = await fixture();
		const p = t.proposal("once");
		expect((await t.recordRequest(p)).state).toBe("recorded");
		expect(
			reason(await t.recordRequest({ ...p, binding: { ...p.binding, requestId: "different-id-same-root" } })),
		).toBe("identity_conflict");
		for (let n = 1; n < 20; n++) {
			const next = t.proposal(`pending-${n}`);
			expect(
				(await t.recordRequest({ ...next, binding: { ...next.binding, causal: causal(7, `root-${n}`) } })).state,
			).toBe("recorded");
		}
		const next = t.proposal("pending21");
		expect(reason(await t.recordRequest({ ...next, binding: { ...next.binding, causal: causal(7, "root21") } }))).toBe(
			"request_capacity",
		);
	});
	it("request expires at24h and grant expires at60m, with no renewable retry", async () => {
		const t = await fixture();
		const g = await t.grant();
		t.f.now += 3600000;
		expect(reason(await t.core.execute(t.business("expired", 7, g.id, g.authority)))).toBe("grant_expired");
		expect((await t.state()).grants[0].acceptedUses).toBe(0);
		t.f.now += 86400000;
		expect(
			(await t.core.status(fakeVerified(actor()), g.request.binding.requestId, g.request.binding.generation)).state,
		).toBe("found");
	});
	it("status is read-only and limited to requester or selected verified current home", async () => {
		const t = await fixture();
		const g = await t.grant();
		const before = guardDigest(await t.state());
		expect(
			(await t.core.status(fakeVerified(actor()), g.request.binding.requestId, g.request.binding.generation)).state,
		).toBe("found");
		expect(
			(await t.core.status(fakeVerified(actor("unrelated")), g.request.binding.requestId, g.request.binding.generation))
				.state,
		).toBe("unavailable");
		expect(guardDigest(await t.state())).toBe(before);
	});
});

describe("owner's hourly exemptions (admission core, Ops #318)", () => {
	it.each(["temper", "ops"])("%s accepts the 21st and 40th, recording every ordinary usage event", async (id) => {
		const t = await fixture();
		for (let n = 1; n <= 40; n++) {
			const r = await t.core.execute(t.business(`exempt-${n}`, 1, null, null, actor(id)));
			expect(r.state, `send ${n}`).toBe("accepted");
			if (r.state === "accepted") expect(r.receipt.usage.ordinaryOrigin).toBe(1);
		}
		expect((await t.state()).usage.filter((u) => u.origin === id)).toHaveLength(40);
		expect(reason(await t.core.execute(t.business("hop-7", 7, null, null, actor(id))))).toBe("approval_required");
		t.f.hold = true;
		expect(reason(await t.core.execute(t.business("held", 1, null, null, actor(id))))).toBe("held");
	});

	it("qa still refuses its 21st with ordinary_hourly, until exactly one rolling hour", async () => {
		const t = await fixture();
		for (let n = 1; n <= 20; n++)
			expect((await t.core.execute(t.business(`qa-${n}`, 1, null, null, actor("qa")))).state).toBe("accepted");
		expect(reason(await t.core.execute(t.business("qa-21", 1, null, null, actor("qa"))))).toBe("ordinary_hourly");
		t.f.now += 3_600_000 - 1;
		expect(reason(await t.core.execute(t.business("qa-too-soon", 1, null, null, actor("qa"))))).toBe("ordinary_hourly");
		t.f.now++;
		expect((await t.core.execute(t.business("qa-hour", 1, null, null, actor("qa")))).state).toBe("accepted");
	});
});

describe("E one ordinary/protected writer: no urgent quota escape", () => {
	it("twenty-first protected communication is blocked by ordinary20/hour", async () => {
		const t = await fixture();
		for (let n = 0; n < 20; n++) expect((await t.core.execute(t.business(`ordinary-${n}`))).state).toBe("accepted");
		expect(reason(await t.core.execute(t.notice("urgent21")))).toBe("ordinary_hourly");
		expect((await t.state()).incidents).toHaveLength(0);
	});
	it("concurrent ordinary final-hour slot admits one; exact hour boundary opens only aged usage", async () => {
		const t = await fixture();
		for (let n = 0; n < 19; n++) await t.core.execute(t.business(`hour-${n}`));
		const r = await Promise.all([t.core.execute(t.business("slot20a")), t.core.execute(t.business("slot20b"))]);
		expect(r.filter((x) => x.state === "accepted")).toHaveLength(1);
		t.f.now += 3599999;
		expect(reason(await t.core.execute(t.business("too-soon")))).toBe("ordinary_hourly");
		t.f.now++;
		expect((await t.core.execute(t.business("exact-hour"))).state).toBe("accepted");
	});
	it("protected bypasses depth only and charges all counters in the same commit", async () => {
		const t = await fixture();
		const r = await t.core.execute(t.notice("initial"));
		expect(r.state).toBe("accepted");
		if (r.state === "accepted")
			expect(r.receipt.usage).toEqual({
				ordinaryOrigin: 1,
				grantBusinessUse: 0,
				protectedOrigin: 1,
				protectedDestination: 1,
				protectedSystem: 1,
				newIncidentOrigin: 1,
			});
		const s = await t.state();
		expect(s.incidents[0]).toMatchObject({ resultStorageReserved: true, resultDeliveryReserved: false });
		expect(t.f.wakes).toBe(0);
	});
	it("incident initial and terminal are one slot each even with different words/receipt ids", async () => {
		const t = await fixture();
		const i = t.incident();
		expect((await t.core.execute(t.notice("initial", i))).state).toBe("accepted");
		expect(reason(await t.core.execute(t.notice("reworded", i, "initial", "Other words")))).toBe("duplicate_slot");
		expect((await t.core.execute(t.notice("result", i, "result"))).state).toBe("accepted");
		expect(reason(await t.core.execute(t.notice("result-again", i, "result")))).toBe("duplicate_slot");
		expect((await t.state()).usage).toHaveLength(2);
	});
	it("atomic incident slot handles concurrency and terminal proof does not permit action authority", async () => {
		const t = await fixture();
		const i = t.incident();
		const r = await Promise.all([
			t.core.execute(t.notice("same-episode-a", i)),
			t.core.execute(t.notice("same-episode-b", i)),
		]);
		expect(r.filter((x) => x.state === "accepted")).toHaveLength(1);
		expect(reason(await t.core.execute(t.notice("result-without-initial", t.incident("unopened"), "result")))).toBe(
			"duplicate_slot",
		);
	});
	it("origin can open only two episodes per hour; each gets at most one terminal", async () => {
		const t = await fixture();
		for (let n = 0; n < 2; n++) {
			const i = t.incident(`e${n}`);
			expect((await t.core.execute(t.notice(`i${n}`, i))).state).toBe("accepted");
			expect((await t.core.execute(t.notice(`r${n}`, i, "result"))).state).toBe("accepted");
		}
		expect(reason(await t.core.execute(t.notice("third", t.incident("e3"))))).toBe("incident_origin_hourly");
	});
	it("destination protected4/hour is shared across different origins", async () => {
		const t = await fixture();
		for (let n = 0; n < 4; n++)
			expect((await t.core.execute(t.notice(`dest${n}`, t.incident(`e${n}`, actor(`origin${n}`))))).state).toBe(
				"accepted",
			);
		expect(reason(await t.core.execute(t.notice("dest5", t.incident("e5", actor("origin5")))))).toBe(
			"protected_destination_hourly",
		);
	});
	it("system protected12/hour is shared across all destinations and origins", async () => {
		const t = await fixture();
		for (let n = 0; n < 6; n++) {
			const i = t.incident(`e${n}`, actor(`o${n}`), `d${n}`);
			expect((await t.core.execute(t.notice(`system${n}i`, i))).state).toBe("accepted");
			expect((await t.core.execute(t.notice(`system${n}r`, i, "result"))).state).toBe("accepted");
		}
		expect(reason(await t.core.execute(t.notice("system13", t.incident("e13", actor("o13"), "d13"))))).toBe(
			"protected_system_hourly",
		);
	});
	it.each(["succeeded", "failed", "indeterminate"] as const)(
		"accepts native terminal outcome %s once",
		async (outcome) => {
			const t = await fixture();
			const i = t.incident();
			await t.core.execute(t.notice("initial", i));
			const c = t.notice("terminal", i, "result");
			if (c.notice.evidence.type !== "safety_action_result") throw new Error("fixture");
			const e = { ...c.notice.evidence, outcome };
			const changed = t.identified({
				...c,
				snapshot: t.snapshot(i.origin, i.causal, null, e),
				notice: fakeVerified({ ...c.notice, evidence: e }),
			});
			expect((await t.core.execute(changed)).state).toBe("accepted");
		},
	);
	it("rejects unsupported incident proof, reassignment and mismatched action without another charge", async () => {
		const t = await fixture();
		const i = t.incident();
		await t.core.execute(t.notice("initial", i));
		expect(reason(await t.core.execute(t.notice("redirect", { ...i, assignedDestinationRole: "other" })))).toBe(
			"incident_unavailable",
		);
		const c = t.notice("wrong-action", i, "result");
		if (c.notice.evidence.type !== "safety_action_result") throw new Error("fixture");
		const e = { ...c.notice.evidence, actionId: "unrelated-action" };
		expect(
			reason(
				await t.core.execute(
					t.identified({
						...c,
						snapshot: t.snapshot(i.origin, i.causal, null, e),
						notice: fakeVerified({ ...c.notice, evidence: e }),
					}),
				),
			),
		).toBe("incident_unavailable");
		expect((await t.state()).usage).toHaveLength(1);
	});
	it("uses full UTF-8 bytes including non-ASCII, never clips a fixed template", async () => {
		const t = await fixture();
		expect((await t.core.execute(t.notice("exact2048", t.incident("a"), "initial", "é".repeat(1024)))).state).toBe(
			"accepted",
		);
		expect(reason(await t.core.execute(t.notice("over2048", t.incident("b"), "initial", "é".repeat(1025))))).toBe(
			"notice_too_large",
		);
	});
	it("reserves terminal metadata before initial acceptance; no free reserved delivery", async () => {
		const t = await fixture({ maximumOutboxEntries: 1 });
		expect(reason(await t.core.execute(t.notice("capacity")))).toBe("retention_capacity");
		expect((await t.state()).usage).toHaveLength(0);
	});
});

describe("E outbox, holds, recovery, clocks, retention and rollback", () => {
	it("dispatch only after durable acceptance and a question wakes exactly once", async () => {
		const t = await fixture();
		const c = t.business("wake");
		await t.core.execute(c);
		expect(t.f.dispatches + t.f.wakes).toBe(0);
		expect((await t.core.reconcile(c.identity)).state).toBe("accepted");
		expect(t.f.dispatches).toBe(1);
		expect(t.f.wakes).toBe(1);
		await t.core.reconcile(c.identity);
		expect(t.f.dispatches).toBe(1);
		expect(t.f.wakes).toBe(1);
	});
	it("FYI dispatches but never starts a turn", async () => {
		const t = await fixture();
		const c = t.identified({ ...t.business("fyi"), businessKind: "fyi" as const });
		await t.core.execute(c);
		await t.core.reconcile(c.identity);
		expect(t.f.dispatches).toBe(1);
		expect(t.f.wakes).toBe(0);
	});
	it.each(["dispatch", "wake"] as const)(
		"lost %s acknowledgment queries original key without a resend/second wake",
		async (phase) => {
			const t = await fixture();
			const c = t.business(`lost-${phase}`);
			await t.core.execute(c);
			t.f.loseDispatchAck = phase === "dispatch";
			t.f.loseWakeAck = phase === "wake";
			await t.core.reconcile(c.identity);
			const first = { sends: t.f.dispatches, wakes: t.f.wakes };
			t.f.hold = true;
			await t.core.reconcile(c.identity);
			expect({ sends: t.f.dispatches, wakes: t.f.wakes }).toEqual(first);
			t.f.hold = false;
			await t.core.reconcile(c.identity);
			expect(t.f.dispatches).toBe(1);
			expect(t.f.wakes).toBe(1);
		},
	);
	it("missing transport proof is unknown, never an alternate retry", async () => {
		const t = await fixture();
		const c = t.business("no-proof");
		await t.core.execute(c);
		t.options.transport.dispatch = async () => ({ state: "unknown", reason: "remote state unknown" });
		await t.core.reconcile(c.identity);
		expect((await t.core.reconcile(c.identity)).state).toBe("unknown");
		expect(t.f.dispatches + t.f.wakes).toBe(0);
	});
	it("native holds suppress dispatch until released without refund or duplicate charge", async () => {
		const t = await fixture();
		const c = t.business("later-held");
		await t.core.execute(c);
		t.f.hold = true;
		await t.core.reconcile(c.identity);
		expect(t.f.dispatches + t.f.wakes).toBe(0);
		expect((await t.state()).usage).toHaveLength(1);
		t.f.hold = false;
		await t.core.reconcile(c.identity);
		expect(t.f.dispatches).toBe(1);
	});
	it.each(["rollback", "unknown"] as const)("untrusted clock %s cannot open allowance", async (state) => {
		const t = await fixture();
		t.f.clockState = state;
		expect(reason(await t.core.execute(t.business(`clock-${state}`)))).toBe("clock_untrusted");
		expect((await t.state()).usage).toHaveLength(0);
	});
	it("actual backward/future-state clock fences admission", async () => {
		const t = await fixture();
		await t.core.execute(t.business("time-before"));
		t.f.now--;
		expect(reason(await t.core.execute(t.business("time-after")))).toBe("clock_untrusted");
	});
	it("finite retention blocks rather than dropping accepted words or resetting uses", async () => {
		const t = await fixture({ maximumTransactions: 1 });
		expect((await t.core.execute(t.business("first"))).state).toBe("accepted");
		expect(reason(await t.core.execute(t.business("overcap")))).toBe("retention_capacity");
		expect((await t.state()).usage).toHaveLength(1);
		expect(JSON.parse(readFileSync(t.storeOptions.legacyPath, "utf8")).messages).toHaveLength(1);
	});
	it("#122 caps (Ops rm-efd6df89): only open requests and live grants count; settled ones never block", async () => {
		const t = await fixture({ maximumRequests: 1, maximumGrants: 1 });
		await t.grant(7, 1); // its request is settled (approved); its grant is live: 0 of 1 open, 1 of 1 live
		const second = await t.recordRequest(t.proposal("second", 8, 1));
		expect(second.state).toBe("recorded"); // counted every stored request before: 2 > 1 refused it
		const third = t.proposal("third", 9, 1);
		const elsewhere = { ...third, binding: { ...third.binding, causal: causal(9, "another-root") } };
		expect(reason(await t.recordRequest(elsewhere))).toBe("retention_capacity"); // 2 open > 1
		if (second.state !== "recorded") throw new Error("synthetic request failed");
		expect(reason(await t.recordDecision(t.decision(second.request, "requested_quantity", "second-answer")))).toBe(
			"retention_capacity",
		); // 2 live > 1
		expect((await t.state()).grants).toHaveLength(1);
	});
	it("settled pruning retains a replay tombstone and legacy words", async () => {
		const t = await fixture();
		const c = t.identified({ ...t.business("settled-old"), businessKind: "fyi" as const });
		await t.core.execute(c);
		await t.core.reconcile(c.identity);
		t.f.now += retention.settledRetentionMs + 1;
		await t.core.execute(t.business("prune-trigger"));
		expect((await t.store.lookup(c.identity)).state).toBe("unknown");
		expect((await t.state()).tombstones.some((stone) => stone.invalidThrough === "source_horizon_unknown")).toBe(true);
		expect(JSON.parse(readFileSync(t.storeOptions.legacyPath, "utf8")).messages[0].text).toBe(c.text);
	});
	it("#122 caps C (Ops rm-fc4b9788): settled entries leave after 5 h whatever is open; their tombstones end 5 h later", async () => {
		const H5 = 5 * 3600000;
		const t = await fixture({ settledRetentionMs: H5, sourceReplayHorizonMs: H5 });
		const trigger = (id: string) => t.core.execute(t.business(id, 1, null, null, actor(), `root-${id}`));
		// An open request on another root stays open the whole time and never stops the pruning.
		const opening = t.proposal("still-open", 7, 1);
		const open = await t.recordRequest({ ...opening, binding: { ...opening.binding, causal: causal(7, "open-root") } });
		expect(open.state).toBe("recorded");
		const c = t.identified({
			...t.business("settled-c", 1, null, null, actor(), "root-c"),
			businessKind: "fyi" as const,
		});
		await t.core.execute(c);
		await t.core.reconcile(c.identity);
		const g = await t.grant(7, 1); // settled request, then an expired grant
		t.f.now += H5 + 1;
		expect((await trigger("prune-1")).state).toBe("accepted");
		let s = await t.state();
		expect(s.transactions.some((x) => x.identity.operationId === c.identity.operationId)).toBe(false);
		const stone = s.tombstones.find((x) => x.kind === "operation" && x.lastTransactionId !== null);
		expect(stone?.invalidThrough).toBe(t.f.now + H5);
		expect(s.requests.some((r) => r.binding.requestId === "still-open" && r.state === "awaiting_approver")).toBe(true);
		// The approved request lives to its 24 h expiry plus 5 h; then it and its grant leave with tombstones.
		t.f.now = g.request.expiresAt + H5;
		expect((await trigger("prune-2")).state).toBe("accepted");
		s = await t.state();
		expect(s.requests.some((r) => r.binding.requestId === g.request.binding.requestId)).toBe(false);
		expect(s.grants.some((x) => x.id === g.id)).toBe(false);
		expect(s.tombstones.filter((x) => x.kind === "request" || x.kind === "grant").length).toBeGreaterThanOrEqual(2);
		const refusedEverywhere = async (label: string) => {
			const before = await t.state();
			// A decision on the pruned request, a decision on one that never was, and a send naming the pruned grant.
			expect(reason(await t.recordDecision(t.decision(g.request, "requested_quantity", `late-${label}`))), label).toBe(
				"authority_unavailable",
			);
			const ghost = t.proposal("never-recorded", 7, 1);
			expect(reason(await t.recordDecision(t.decision(ghost, "one_send", `ghost-${label}`))), label).toBe(
				"authority_unavailable",
			);
			const use = await t.core.execute(t.business(`use-${label}`, 7, g.id, g.authority));
			expect(use.state, label).not.toBe("accepted");
			expect(reason(use), label).toBe("grant_revoked");
			const after = await t.state();
			expect(after.requests.length, label).toBe(before.requests.length);
			expect(after.grants.length, label).toBe(before.grants.length);
		};
		await refusedEverywhere("tombstoned");
		// 5 h on, the tombstones themselves leave; the same uses are still refused and still create nothing.
		t.f.now += H5 + 1;
		expect((await trigger("prune-3")).state).toBe("accepted");
		s = await t.state();
		expect(s.tombstones.every((x) => x.invalidThrough === "source_horizon_unknown" || x.invalidThrough > t.f.now)).toBe(
			true,
		);
		expect(s.tombstones.some((x) => x.kind === "request" || x.kind === "grant")).toBe(false);
		await refusedEverywhere("forgotten");
		expect(
			JSON.parse(readFileSync(t.storeOptions.legacyPath, "utf8")).messages.some(
				(m: { text: string }) => m.text === c.text,
			),
		).toBe(true);
	});
	it("#122 H-ROLE-LADDER-PRUNE-1: a settled send's outbox steps leave with it after 5 h, never before", async () => {
		const H5 = 5 * 3600000;
		const t = await fixture({ settledRetentionMs: H5, sourceReplayHorizonMs: H5 });
		const trigger = (id: string) => t.core.execute(t.business(id, 1, null, null, actor(), `root-${id}`));
		const c = t.identified({
			...t.business("steps", 1, null, null, actor(), "root-steps"),
			businessKind: "fyi" as const,
		});
		const sent = await t.core.execute(c);
		if (sent.state !== "accepted") throw new Error("synthetic send failed");
		await t.core.reconcile(c.identity);
		const id = sent.receipt.transactionId;
		const namesSend = (s: GuardStoreStateAny) =>
			s.transactions.filter(
				(x) => x.state === "committed" && x.result.state === "accepted" && x.result.receipt.transactionId === id,
			);
		const steps = namesSend(await t.state()).filter((x) => x.transactionId !== id);
		expect(steps.length).toBeGreaterThanOrEqual(1); // the dispatch is its own maintenance transaction
		const stepIds = new Set(steps.map((x) => x.transactionId));
		// Under 5 h: the send and every step stay.
		t.f.now += H5 - 60_000;
		expect((await trigger("young")).state).toBe("accepted");
		expect(namesSend(await t.state()).length).toBe(steps.length + 1);
		// Past 5 h settled: the send, its steps, their audits and the outbox entry all leave.
		t.f.now += 120_000;
		expect((await trigger("old")).state).toBe("accepted");
		const s = await t.state();
		expect(namesSend(s)).toHaveLength(0);
		expect(s.audits.some((a) => a.transactionId === id || stepIds.has(a.transactionId))).toBe(false);
		expect(s.outbox.some((o) => o.receipt.transactionId === id)).toBe(false);
	});
	it("#122 caps C: settled time may not undercut the usage hour or a verified replay horizon", async () => {
		await expect(fixture({ settledRetentionMs: 3600000 - 1, sourceReplayHorizonMs: "unknown" })).rejects.toThrow(
			/usage window or verified replay horizon/,
		);
		await expect(fixture({ settledRetentionMs: 3600000, sourceReplayHorizonMs: 5 * 3600000 })).rejects.toThrow(
			/usage window or verified replay horizon/,
		);
		await expect(
			fixture({ settledRetentionMs: 5 * 3600000, sourceReplayHorizonMs: 5 * 3600000 }),
		).resolves.toBeTruthy();
	});
	it("rollback preserves accepted words/ordinary charges/audit, revokes grants, disables protection", async () => {
		const t = await fixture();
		const g = await t.grant();
		const c = t.business("accepted-before-rollback", 7, g.id, g.authority);
		await t.core.execute(c);
		const legacy = readFileSync(t.storeOptions.legacyPath, "utf8");
		const r = await t.core.rollback();
		expect(r.state).toBe("ready");
		const s = await t.state();
		expect(s.mode).toBe("rollback_depth_6");
		expect(s.grants[0].state).toBe("revoked");
		expect(s.usage).toHaveLength(1);
		expect(s.audits.some((a) => a.event === "rollback")).toBe(true);
		expect(readFileSync(t.storeOptions.legacyPath, "utf8")).toBe(legacy);
		expect(reason(await t.core.execute(t.business("rollback-hop7", 7, g.id, g.authority)))).toBe("rollback_depth");
		expect(reason(await t.core.execute(t.notice("rollback-urgent")))).toBe("rollback_depth");
	});
	it("does not expose rollback without verified maintenance authority", async () => {
		const t = await fixture();
		t.f.rollbackAllowed = false;
		expect((await t.core.rollback()).state).toBe("unavailable");
		expect((await t.state()).mode).toBe("enabled");
	});
	it("commit uncertainty holds reservation with no dispatch, grant refund or blind send retry", async () => {
		const t = await fixture();
		const g = await t.grant();
		const c = t.business("uncertain-use", 7, g.id, g.authority);
		t.f.fail = "commit:rename";
		const r = await t.core.execute(c);
		expect(r.state).toBe("unknown");
		expect(t.f.dispatches + t.f.wakes).toBe(0);
		t.f.fail = null;
		expect((await t.store.recover()).state).toBe("unknown");
		expect((await t.core.execute(t.business("alternate-use", 7, g.id, g.authority))).state).toBe("unknown");
	});
});

describe("E one explicit Owner escalation (Ops rm-1bb3c77b)", () => {
	it("a winning first escalate_owner keeps the lower decision and opens one Owner phase with the original bounds", async () => {
		const t = await fixture();
		const { lower, escalation, phase } = await escalated(t);
		expect(phase.binding).toEqual({
			...lower.binding,
			generation: guardEscalationGeneration(lower.binding),
			tier: "owner",
		});
		expect(phase.binding.generation.startsWith("owner-escalation-")).toBe(true);
		expect(phase.selectedApprover).toEqual({ tier: "owner", reason: "explicit_escalation" });
		expect(phase).toMatchObject({
			createdAt: t.f.now,
			expiresAt: lower.expiresAt,
			state: "awaiting_owner",
			upwardEscalations: 1,
			initialNotificationKey: lower.initialNotificationKey,
			decisionNotificationKey: lower.decisionNotificationKey,
			firstDecision: null,
			grantId: null,
		});
		expect(phase.context.priorDecisions).toHaveLength(1);
		expect(phase.context.priorDecisions[0]).toContain("explicitly escalated");
		expect(phase.context.priorDecisions[0]).toContain("not a grant or a final approval");
		expect({ ...phase.context, priorDecisions: [] }).toEqual(lower.context);
		const s = await t.state();
		expect(s.requests).toHaveLength(2);
		expect(s.requests[0]).toEqual({ ...lower, firstDecision: escalation, state: "revoked" });
		expect(s.requests[1]).toEqual(phase);
		expect(s.grants).toHaveLength(0);
		expect(s.usage).toHaveLength(0);
		expect(s.outbox).toHaveLength(0);
		expect(s.audits.filter((a) => a.event === "decided")).toHaveLength(1);
	});
	it("duplicate escalation returns the same phase; stale lower or old-generation answers change nothing", async () => {
		const t = await fixture();
		const { lower, escalation, phase } = await escalated(t);
		const again = await t.recordDecision(escalation, "decision:retry-same-answer");
		expect(again.state === "recorded" && again.request).toEqual(phase);
		for (const choice of ["deny", "requested_quantity"] as const) {
			const late = await t.recordDecision(t.decision(lower, choice, `late-lower-${choice}`));
			expect(late.state === "recorded" && late.request.firstDecision).toEqual(escalation);
		}
		expect(
			reason(await t.recordDecision({ ...t.decision(lower, "deny", "lower-on-owner-phase"), binding: phase.binding })),
		).toBe("authority_unavailable");
		const ownerAnswer = t.decision(phase, "requested_quantity", "owner-on-old-generation");
		if (ownerAnswer.authority.tier !== "owner") throw new Error("fixture");
		expect(reason(await t.recordDecision({ ...ownerAnswer, binding: lower.binding }))).toBe("authority_unavailable");
		expect(
			reason(
				await t.recordDecision(
					{ ...ownerAnswer, authority: { ...ownerAnswer.authority, questionGeneration: lower.binding.generation } },
					"decision:owner-old-question-generation",
				),
			),
		).toBe("authority_unavailable");
		const s = await t.state();
		expect(s.requests).toHaveLength(2);
		expect(s.requests[0].firstDecision).toEqual(escalation);
		expect(s.requests[1]).toEqual(phase);
		expect(s.grants).toHaveLength(0);
		expect(s.audits.filter((a) => a.event === "decided")).toHaveLength(1);
	});
	it("escalation-versus-denial race: exactly the first answer wins, either way round", async () => {
		for (const order of [
			["escalate_owner", "deny"],
			["deny", "escalate_owner"],
		] as const) {
			const t = await fixture();
			const p = await t.recordRequest(t.proposal("race"));
			if (p.state !== "recorded") throw new Error("fixture");
			const results = await Promise.all(
				order.map((choice) => t.recordDecision(t.decision(p.request, choice, `race-${choice}`))),
			);
			expect(results.every((r) => r.state === "recorded")).toBe(true);
			const s = await t.state();
			expect(s.requests[0].firstDecision?.choice).toBe(order[0]);
			expect(s.requests).toHaveLength(order[0] === "escalate_owner" ? 2 : 1);
			expect(s.requests[0].state).toBe(order[0] === "escalate_owner" ? "revoked" : "denied");
			expect(s.audits.filter((a) => a.event === "decided")).toHaveLength(1);
			expect(s.grants).toHaveLength(0);
		}
	});
	it("no escalation after a winning approval or denial, after expiry, by the Owner, or a second time", async () => {
		for (const first of ["requested_quantity", "deny"] as const) {
			const t = await fixture();
			const p = await t.recordRequest(t.proposal(`after-${first}`));
			if (p.state !== "recorded") throw new Error("fixture");
			expect((await t.recordDecision(t.decision(p.request, first, `${first}-wins`))).state).toBe("recorded");
			const late = await t.recordDecision(t.decision(p.request, "escalate_owner", `late-escalation-${first}`));
			expect(late.state === "recorded" && late.request.firstDecision?.choice).toBe(first);
			expect((await t.state()).requests).toHaveLength(1);
		}
		const expired = await fixture();
		const p = await expired.recordRequest(expired.proposal("expires"));
		if (p.state !== "recorded") throw new Error("fixture");
		expired.f.now = p.request.expiresAt;
		expect(reason(await expired.recordDecision(expired.decision(p.request, "escalate_owner", "too-late")))).toBe(
			"grant_expired",
		);
		expect((await expired.state()).requests).toHaveLength(1);
		const direct = await fixture();
		const o = await direct.recordRequest(direct.proposal("owner-direct", 12));
		if (o.state !== "recorded") throw new Error("fixture");
		expect(reason(await direct.recordDecision(direct.decision(o.request, "escalate_owner", "owner-escalates")))).toBe(
			"authority_unavailable",
		);
		const twice = await fixture();
		const { phase } = await escalated(twice);
		expect(reason(await twice.recordDecision(twice.decision(phase, "escalate_owner", "owner-phase-escalates")))).toBe(
			"authority_unavailable",
		);
		expect((await twice.state()).requests).toHaveLength(2);
	});
	it("only E's transition creates an Owner phase: reserved generation and explicit selection are refused", async () => {
		const t = await fixture();
		const p = t.proposal("forged-phase", 12);
		expect(
			reason(await t.recordRequest({ ...p, binding: { ...p.binding, generation: "owner-escalation-forged" } })),
		).toBe("invalid_input");
		t.f.selectExplicit = true;
		expect(reason(await t.recordRequest(t.proposal("explicit-selected", 12)))).toBe("authority_unavailable");
		expect((await t.state()).requests).toHaveLength(0);
	});
	it("the Owner's finite answer on the new phase keeps the original quantity, hop bound and expiry", async () => {
		const t = await fixture();
		const { phase } = await escalated(t, "bounded", 9, 3);
		expect((await t.recordDecision(t.decision(phase, "requested_quantity", "owner-approves"))).state).toBe("recorded");
		const g = (await t.state()).grants[0];
		expect(g.binding).toEqual({ ...phase.binding, quantity: 3, upperHop: 11 });
		expect(g.authority.tier).toBe("owner");
		expect(g.maximumUses).toBe(3);
		expect(g.expiresAt).toBe(t.f.now + 3600000);
		for (const hop of [9, 10])
			expect((await t.core.execute(t.business(`bounded-${hop}`, hop, g.id, g.authority))).state).toBe("accepted");
		expect(reason(await t.core.execute(t.business("bounded-hop12", 12, g.id, g.authority)))).toBe("scope_mismatch");
		expect((await t.core.execute(t.business("bounded-11", 11, g.id, g.authority))).state).toBe("accepted");
		expect(reason(await t.core.execute(t.business("bounded-fourth", 11, g.id, g.authority)))).toBe("grant_exhausted");
		expect((await t.state()).grants[0].acceptedUses).toBe(3);
		const late = await fixture();
		const e = await escalated(late, "late-owner");
		late.f.now = e.lower.expiresAt;
		expect(reason(await late.recordDecision(late.decision(e.phase, "one_send", "owner-too-late")))).toBe(
			"grant_expired",
		);
		expect((await late.state()).grants).toHaveLength(0);
	});
	it("no second initial or terminal agent notice across the lineage", async () => {
		const t = await fixture();
		const p = await t.recordRequest(t.proposal("notices", 9, 3));
		if (p.state !== "recorded") throw new Error("fixture");
		const lower = p.request;
		expect((await t.core.execute(t.control("initial-to-coo", lower, "initial", "coo"))).state).toBe("accepted");
		const r = await t.recordDecision(t.decision(lower, "escalate_owner", "notices-escalate"));
		if (r.state !== "recorded") throw new Error("fixture");
		const phase = r.request;
		expect(reason(await t.core.execute(t.control("second-initial", phase, "initial", "coo")))).toBe("duplicate_slot");
		expect(reason(await t.core.execute(t.control("lower-initial-again", lower, "initial", "coo")))).toBe(
			"duplicate_slot",
		);
		expect(
			reason(await t.core.execute(t.control("escalation-as-terminal", lower, "decision", "alpha", actor("coo")))),
		).toBe("authority_unavailable");
		const s = await t.state();
		expect(s.outbox).toHaveLength(1);
		expect(s.usage).toHaveLength(1);
	});
	it("one optional requester notice of the verified Owner decision: own binding, own session, own quota, deduped", async () => {
		const t = await fixture();
		const { phase } = await escalated(t, "notice");
		expect(reason(await t.core.execute(t.control("before-owner", phase, "decision", "alpha")))).toBe(
			"authority_unavailable",
		);
		expect((await t.recordDecision(t.decision(phase, "one_send", "owner-one-send"))).state).toBe("recorded");
		const sent = await t.core.execute(t.control("owner-notice", phase, "decision", "alpha"));
		if (sent.state !== "accepted") throw new Error(reason(sent));
		expect(sent.receipt.class).toBe("control");
		expect(sent.receipt.usage).toMatchObject({ ordinaryOrigin: 1, grantBusinessUse: 0, protectedOrigin: 0 });
		const s = await t.state();
		const m = s.outbox[0].message;
		expect(m).toMatchObject({
			kind: "fyi",
			from: { role: "alpha", file: actor().sessionFile },
			to: { role: "alpha" },
			target: actor().sessionFile,
		});
		expect(m.replyTo).toBeUndefined();
		expect(m.text).toContain("Requester notice of a verified Owner decision");
		expect(m.text).toContain("not Owner speech");
		expect(m.text).not.toContain("Synthetic communication-only decision");
		expect(s.usage.filter((u) => u.origin === "alpha")).toHaveLength(1);
		expect(reason(await t.core.execute(t.control("owner-notice-again", phase, "decision", "alpha")))).toBe(
			"duplicate_slot",
		);
		expect(reason(await t.core.execute(t.control("owner-initial", phase, "initial", "coo")))).toBe(
			"authority_unavailable",
		);
		expect((await t.state()).outbox).toHaveLength(1);
	});
	it("the requester notice honours its ordinary 20/hour and holds; a blocked notice leaves the decision inspectable", async () => {
		const t = await fixture();
		const { phase } = await escalated(t, "quota");
		expect((await t.recordDecision(t.decision(phase, "deny", "owner-denies"))).state).toBe("recorded");
		for (let n = 0; n < 20; n++)
			expect((await t.core.execute(t.business(`fill-${n}`, 1, null, null, actor(), "fill-root"))).state).toBe(
				"accepted",
			);
		expect(reason(await t.core.execute(t.control("over-quota", phase, "decision", "alpha")))).toBe("ordinary_hourly");
		t.f.now += 3600000;
		t.f.hold = true;
		expect(reason(await t.core.execute(t.control("while-held", phase, "decision", "alpha")))).toBe("held");
		t.f.hold = false;
		const view = await t.core.status(fakeVerified(actor()), phase.binding.requestId, phase.binding.generation);
		expect(view.state === "found" && view.request.firstDecision?.choice).toBe("deny");
		expect(view.state === "found" && view.request.state).toBe("denied");
		expect((await t.state()).outbox.filter((o) => o.message.kind === "fyi")).toHaveLength(0);
		expect((await t.core.execute(t.control("after-hold", phase, "decision", "alpha"))).state).toBe("accepted");
	});
	it("forged Owner notices are blocked without a charge", async () => {
		const t = await fixture();
		const { phase } = await escalated(t, "forged");
		expect(reason(await t.core.execute(t.control("initial-on-phase", phase, "initial", "coo")))).toBe(
			"authority_unavailable",
		);
		expect((await t.recordDecision(t.decision(phase, "requested_quantity", "owner-approves"))).state).toBe("recorded");
		const stale: GuardActor = { ...actor(), runtimeIncarnation: "synthetic-old-process" };
		for (const forged of [
			t.control("as-approver", phase, "decision", "alpha", actor("coo")),
			t.control("as-participant", phase, "decision", "alpha", actor("gamma")),
			t.control("stale-incarnation", phase, "decision", "alpha", stale),
			t.control("to-other-role", phase, "decision", "beta"),
		])
			expect(reason(await t.core.execute(forged))).toBe("authority_unavailable");
		t.f.decisionAvailable = false;
		expect(reason(await t.core.execute(t.control("unverifiable", phase, "decision", "alpha")))).toBe(
			"authority_unavailable",
		);
		t.f.decisionAvailable = true;
		t.f.decisionDrift = true;
		expect(reason(await t.core.execute(t.control("drifted", phase, "decision", "alpha")))).toBe(
			"authority_unavailable",
		);
		t.f.decisionDrift = false;
		t.f.wrongTarget = true;
		expect(reason(await t.core.execute(t.control("rerouted", phase, "decision", "alpha")))).toBe(
			"persistence_unavailable",
		);
		t.f.wrongTarget = false;
		const before = await t.state();
		expect(before.outbox).toHaveLength(0);
		expect(before.usage).toHaveLength(0);
		expect((await t.core.execute(t.control("genuine", phase, "decision", "alpha"))).state).toBe("accepted");
		expect((await t.state()).outbox).toHaveLength(1);
	});
	it("a crash at any store boundary of the transition leaves all of it, none of it, or an unknown hold", async () => {
		const probe = await fixture();
		const pp = await probe.recordRequest(probe.proposal("crash"));
		if (pp.state !== "recorded") throw new Error("fixture");
		probe.f.calls = [];
		expect((await probe.recordDecision(probe.decision(pp.request, "escalate_owner", "crash-escalates"))).state).toBe(
			"recorded",
		);
		const points = [...new Set(probe.f.calls)];
		expect(points.length).toBeGreaterThan(3);
		const outcomes = new Set<string>();
		for (const point of points) {
			const t = await fixture();
			const p = await t.recordRequest(t.proposal("crash"));
			if (p.state !== "recorded") throw new Error("fixture");
			const command = t.decisionCommand(t.decision(p.request, "escalate_owner", "crash-escalates"));
			t.f.fail = point;
			expect((await t.core.execute(command)).state).toBe("unknown");
			t.f.fail = null;
			const restart = new GuardFileStore({ ...t.storeOptions, boundary: null });
			const recovered = await restart.recover();
			const core = new RoleMessageGuardCore({ ...t.options, store: restart });
			if (recovered.state !== "ready") {
				outcomes.add("unknown");
				expect((await restart.read()).state).toBe("unknown");
				expect((await core.execute(command)).state).toBe("unknown");
				continue;
			}
			const s = recovered.value;
			const none = s.requests.length === 1 && s.requests[0].firstDecision === null;
			const all =
				s.requests.length === 2 &&
				s.requests[0].state === "revoked" &&
				equalJson(s.requests[0].firstDecision, command.decision) &&
				s.requests[1].binding.generation === guardEscalationGeneration(p.request.binding);
			expect(none !== all).toBe(true);
			outcomes.add(all ? "all" : "none");
			const replay = await core.execute(command);
			expect(replay.state).toBe("recorded");
			const after = await restart.read();
			if (after.state !== "ready") throw new Error("fixture");
			expect(after.value.requests).toHaveLength(2);
			expect(after.value.requests[0].firstDecision).toEqual(command.decision);
			expect(after.value.audits.filter((a) => a.event === "decided")).toHaveLength(1);
		}
		expect([...outcomes].sort()).toEqual(["all", "none", "unknown"]);
	});
	it("pruning removes an escalation lineage only as a whole and never revives an old generation", async () => {
		const t = await fixture();
		const { lower, escalation, phase } = await escalated(t, "prune");
		t.f.now += 3600000;
		const next = t.proposal("prune", 9, 3);
		expect(
			(
				await t.recordRequest(
					{ ...next, binding: { ...next.binding, generation: "synthetic-generation-2" } },
					"request:prune-generation-2",
				)
			).state,
		).toBe("recorded");
		t.f.now = lower.expiresAt + retention.settledRetentionMs;
		const trigger = (id: string) => t.core.execute(t.business(id, 1, null, null, actor(), "unrelated-root"));
		expect((await trigger("prune-trigger-1")).state).toBe("accepted");
		expect((await t.state()).requests).toHaveLength(3);
		t.f.now += 3600000;
		expect((await trigger("prune-trigger-2")).state).toBe("accepted");
		const s = await t.state();
		expect(s.requests).toHaveLength(0);
		for (const generation of [lower.binding.generation, phase.binding.generation, "synthetic-generation-2"])
			expect(
				s.tombstones.some(
					(x) => x.kind === "request" && x.identityDigest === guardDigest({ requestId: "prune", generation }),
				),
			).toBe(true);
		expect(reason(await t.recordDecision(escalation, "decision:after-prune"))).toBe("authority_unavailable");
		expect(reason(await t.recordRequest(t.proposal("prune", 9, 3), "request:after-prune"))).toBe(
			"authority_unavailable",
		);
	});
	it("an escalation that would exceed the context cap is blocked, never clipped, and records nothing", async () => {
		const t = await fixture({ maximumContextBytes: Buffer.byteLength(JSON.stringify(context), "utf8") + 64 });
		const p = await t.recordRequest(t.proposal("cap"));
		if (p.state !== "recorded") throw new Error(reason(p));
		expect(reason(await t.recordDecision(t.decision(p.request, "escalate_owner", "cap-escalates")))).toBe(
			"retention_capacity",
		);
		const s = await t.state();
		expect(s.requests).toHaveLength(1);
		expect(s.requests[0].firstDecision).toBeNull();
		expect(s.requests[0].context).toEqual(context);
	});
	it("status: the approver reads its escalated history, only the requester reads the Owner phase", async () => {
		const t = await fixture();
		const { lower, phase } = await escalated(t, "status");
		const approverView = await t.core.status(
			fakeVerified(actor("coo")),
			lower.binding.requestId,
			lower.binding.generation,
		);
		expect(approverView.state === "found" && approverView.request.firstDecision?.choice).toBe("escalate_owner");
		expect(approverView.state === "found" && approverView.request.state).toBe("revoked");
		const requesterView = await t.core.status(fakeVerified(actor()), phase.binding.requestId, phase.binding.generation);
		expect(requesterView.state === "found" && requesterView.request).toEqual(phase);
		expect(
			(await t.core.status(fakeVerified(actor("coo")), phase.binding.requestId, phase.binding.generation)).state,
		).toBe("unavailable");
	});
});
function equalJson(a: unknown, b: unknown): boolean {
	return guardDigest(a) === guardDigest(b);
}
