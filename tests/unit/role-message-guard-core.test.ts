// Synthetic component E fixtures ONLY. Fake brands/ports below are NOT native authentication.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
	GuardActor,
	GuardApprovalBinding,
	GuardApprovalContext,
	GuardAuthority,
	GuardCommand,
	GuardConsumerBinding,
	GuardHostVerified,
	GuardHostVerifier,
	GuardIncidentIdentity,
	GuardKnownCausality,
	GuardOperationIdentity,
	GuardOutboxEntry,
	GuardPolicyV1,
	GuardProofReference,
	GuardProtectedEvidence,
	GuardProtectedNotice,
	GuardRequest,
	GuardResult,
	GuardRetention,
	GuardStoreState,
	GuardTime,
	GuardVerification,
	GuardVerifiedDecision,
	GuardVerifiedSnapshot,
} from "../../server/role-message-guard-contract.js";
import {
	RoleMessageGuardCore,
	guardCommandFingerprint,
	type GuardCoreOptions,
} from "../../server/role-message-guard-core.js";
import { GuardFileStore, guardDigest, type GuardFileBoundary } from "../../server/role-message-guard-store.js";

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

async function fixture(caps: Partial<GuardRetention> = {}, initial?: GuardStoreState) {
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
			if (point === f.fail) throw new Error(`synthetic fault ${point}`);
		},
	};
	const store = new GuardFileStore(storeOptions);
	expect((await store.initialize(initial ?? seed(f.now), { v: 1, paused: false, messages: [] })).state).toBe("ready");
	const verifier: GuardHostVerifier = {
		verifyInvocation: async () => ({ state: "unavailable", reason: "not a real invocation adapter" }),
		verifyCausality: async () => ({ state: "unavailable", reason: "not a real ancestry adapter" }),
		selectApprover: async (b) =>
			f.nativeAvailable
				? verified(
						b.tier === "owner"
							? {
									tier: "owner" as const,
									reason: b.causal.nextHop >= 12 ? ("hop_12_plus" as const) : ("no_distinct_lower_approver" as const),
								}
							: { tier: "lower" as const, role: "coo", route: "coo" as const, home: actor("coo"), proof: proof() },
					)
				: { state: "unavailable", reason: "native selection unavailable" },
		verifyRoleDecision: async () => ({ state: "unavailable", reason: "not a real role decision adapter" }),
		verifyOwnerAnswer: async () => ({ state: "unavailable", reason: "not a real Owner answer adapter" }),
		verifyIncident: async () => ({ state: "unavailable", reason: "P125 native producer NOT qualified" }),
		revalidate: async (s) =>
			f.nativeAvailable
				? verified(snapshot(s.actor, s.causal, s.authority, s.incident))
				: { state: "unavailable", reason: "synthetic native boundary denies" },
	};
	const options: GuardCoreOptions = {
		binding,
		policy,
		retention: { ...retention, ...caps },
		store,
		verifier,
		clock: async () => clock(),
		requestSnapshot: async (a, r) => verified(snapshot(a, r.binding.causal)),
		reverifyDecision: async (d) =>
			f.decisionAvailable
				? verified(d)
				: { state: "unavailable", reason: "synthetic first answer/native source unavailable" },
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
			state: "waiting",
			sends: 0,
			attempts: 0,
			forOwner: true,
			ownerIds: ["synthetic-owner-thread"],
			ownerChannel: "browser",
			initiative: "synthetic-initiative",
		}),
		maintenanceIdentity: (purpose, key) => ({
			version: policy.version,
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
	function identified<T extends GuardCommand>(command: T): T {
		const completed = { ...command, identity: { ...command.identity, fingerprint: guardCommandFingerprint(command) } };
		if ("snapshot" in completed) f.snapshots.set(completed.identity.operationId, completed.snapshot);
		return completed;
	}
	const identity = (id: string, who = actor()): GuardOperationIdentity => ({
		operationId: id,
		fingerprint: "pending",
		actor: who,
		version: policy.version,
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
		quantity: 1 | 2 | 3 | 4 | 5 = 1,
		tier: "lower" | "owner" = hop >= 12 ? "owner" : "lower",
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
	const recordRequest = (request: GuardRequest, id = `request:${request.binding.requestId}`) =>
		core.execute(
			identified({
				kind: "request_record",
				identity: identity(id, request.binding.requester),
				actor: fakeVerified(request.binding.requester),
				request,
			}),
		);
	const decision = (
		request: GuardRequest,
		choice: GuardVerifiedDecision["choice"] = "requested_quantity",
		event = "synthetic-first-answer",
	): GuardVerifiedDecision => ({
		binding: request.binding,
		choice,
		reason: "Synthetic communication-only decision",
		answeredAt: f.now,
		firstAnswerEventId: event,
		authority:
			request.binding.tier === "lower"
				? {
						tier: "lower",
						selection: request.selectedApprover as Extract<GuardRequest["selectedApprover"], { tier: "lower" }>,
						decisionId: event,
						proof: proof(event),
					}
				: {
						tier: "owner",
						questionId: "synthetic-native-question",
						questionGeneration: request.binding.generation,
						choicesDigest: "synthetic-fixed-choices",
						decisionId: event,
						source: { kind: "authenticated_browser", authenticatedOwnerBindingId: "synthetic-browser-owner" },
						proof: proof(event),
					},
	});
	const recordDecision = (d: GuardVerifiedDecision, id = `decision:${d.firstAnswerEventId}`) =>
		core.execute(
			identified({
				kind: "decision_record",
				identity: identity(id, d.authority.tier === "lower" ? d.authority.selection.home : d.binding.requester),
				decision: fakeVerified(d),
			}),
		);
	async function grant(hop = 7, quantity: 1 | 2 | 3 | 4 | 5 = 1) {
		const requested = await recordRequest(proposal(`req-${hop}-${quantity}`, hop, quantity));
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
		recordRequest,
		decision,
		recordDecision,
		grant,
		incident,
		notice,
		state,
	};
}
function reason(result: GuardResult): string {
	return result.state === "blocked" ? result.reason : result.state;
}

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
		const c = t.identified<Extract<GuardCommand, { kind: "decision_record" }>>({
			kind: "decision_record",
			identity: t.identity("stale-home", actor("coo", false)),
			decision: fakeVerified(d),
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
