/** Component E — inert, single admission writer. Constructors have no effects or runtime defaults.
 * C's brands are erased: native authority, restored evidence, current homes and ancestry MUST be
 * reverified by the supplied host inside the writer. Admission never dispatches or starts a turn.
 */
import type {
	GuardAcceptedReceipt,
	GuardActor,
	GuardApprovalBinding,
	GuardApprovalContext,
	GuardAtomicMutation,
	GuardAuditReceipt,
	GuardBlockedReason,
	GuardCommand,
	GuardConsumerBinding,
	GuardCoordinator,
	GuardGrant,
	GuardHostVerified,
	GuardHostVerifier,
	GuardIncident,
	GuardIncidentIdentity,
	GuardKnownCausality,
	GuardLegacyAcceptedMessage,
	GuardOperationIdentity,
	GuardOutboxEntry,
	GuardPolicyV1,
	GuardProofReference,
	GuardReadResult,
	GuardRequest,
	GuardResult,
	GuardRetention,
	GuardScope,
	GuardStatusResult,
	GuardStorePort,
	GuardStoreState,
	GuardTime,
	GuardTransportPort,
	GuardUsageReceipt,
	GuardVerification,
	GuardVerifiedDecision,
	GuardVerifiedSnapshot,
} from "./role-message-guard-contract.js";
import { guardDigest, guardOperationKey, guardStateIsValid, guardTransactionId } from "./role-message-guard-store.js";

const policyV1: GuardPolicyV1 = {
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
const contractCommit = "04fe491fb3afc3b42462ad782b2099c7971c7008";
const contractSha256 = "79a5a1e1a704ecfbb36a70fc1b210ee6e27575013843122cf202a84592b4c7af";
const policyDocumentSha256 = "5d8433fd0a8f9a82103009e43491182caf14b80ad2a20b874709c5b3762724a9";
const version = "role-message-guard/v1" as const;
/** Generations with this prefix belong to E's one explicit lower-to-Owner transition; request_record may not use them. */
export const guardEscalationGenerationPrefix = "owner-escalation-";
/** Deterministic Owner-phase generation for a lower phase's winning escalate_owner (one per lower binding). */
export function guardEscalationGeneration(lower: GuardApprovalBinding): string {
	return `${guardEscalationGenerationPrefix}${guardDigest({ version, transition: "explicit_escalation", lower })}`;
}
type FinalResult = Exclude<GuardResult, { readonly state: "unknown" }>;
interface MutableState extends Omit<
	GuardStoreState,
	"requests" | "grants" | "incidents" | "usage" | "transactions" | "outbox" | "audits" | "tombstones"
> {
	requests: GuardRequest[];
	grants: GuardGrant[];
	incidents: GuardIncident[];
	usage: GuardStoreState["usage"][number][];
	transactions: GuardStoreState["transactions"][number][];
	outbox: GuardOutboxEntry[];
	audits: GuardAuditReceipt[];
	tombstones: GuardStoreState["tombstones"][number][];
}
export interface GuardMessageIntent {
	readonly id: string;
	readonly at: number;
	readonly actor: GuardActor;
	readonly to: string;
	readonly kind: GuardLegacyAcceptedMessage["kind"];
	readonly text: string;
	readonly chain: number;
	readonly replyTo: string | null;
	/** Exact legacy delivery target (bound requesting session) E requires, or null for the host's existing routing. */
	readonly target: string | null;
}
export interface GuardCoreOptions {
	readonly binding: GuardConsumerBinding;
	readonly policy: GuardPolicyV1;
	readonly retention: GuardRetention;
	readonly store: GuardStorePort;
	readonly verifier: GuardHostVerifier;
	readonly transport: GuardTransportPort;
	/** Trusted host time; E rejects untrusted, backwards or pre-state time under its writer. */
	readonly clock: () => Promise<GuardTime>;
	/*
	 * Required construction ports (Ops rm-1bb3c77b item 1). E supplies no default, never treats a cast or a
	 * successful type check as authentication, and does no hidden live lookup. Every port answers with C's
	 * GuardVerification: anything but "verified" blocks, and E compares each verified value exactly with what it
	 * already holds (a mismatch blocks too). E calls them under its single writer and, where noted, again before
	 * dispatch. A host that cannot verify natively answers "unavailable".
	 */
	/** Native snapshot of the requester for a recorded request (actor, original causality, holds, time). */
	readonly requestSnapshot: (
		actor: GuardHostVerified<GuardActor>,
		request: GuardRequest,
	) => Promise<GuardVerification<GuardVerifiedSnapshot>>;
	/**
	 * Rehydrates a decision (a fresh command, or one restored from E's own state) through its native first-answer
	 * event and source, and returns it exactly as natively recorded. Matching fields alone are not proof.
	 */
	readonly reverifyDecision: (
		decision: GuardVerifiedDecision,
		request: GuardRequest,
	) => Promise<GuardVerification<GuardVerifiedDecision>>;
	/** Native ancestry/scope/recipient check of one grant use; called under the writer before any use is counted. */
	readonly verifyGrantLineage: (
		grant: GuardGrant,
		snapshot: GuardHostVerified<GuardVerifiedSnapshot>,
		scope: GuardScope,
		to: string,
	) => Promise<GuardVerification<GuardVerifiedSnapshot>>;
	/** Rehydrates an accepted entry's native snapshot after a restart; E revalidates it again before dispatch/wake. */
	readonly restoreSnapshot: (entry: GuardOutboxEntry) => Promise<GuardVerification<GuardVerifiedSnapshot>>;
	/** Native current identity of a status reader (requester or selected current-home approver). */
	readonly verifyStatusActor: (actor: GuardHostVerified<GuardActor>) => Promise<GuardVerification<GuardActor>>;
	/**
	 * Deterministically builds the legacy record for an intent E already admitted: stamps/preserves native routing,
	 * Owner and initiative metadata, with no send/wake/save effects. It never chooses authority, grants, quantities
	 * or remaining uses; E checks id/time/actor/recipient/kind/words/chain/reply/target and blocks on any mismatch.
	 */
	readonly materialize: (intent: GuardMessageIntent) => Promise<GuardLegacyAcceptedMessage>;
	/** Deterministic host identity for E's own outbox/rollback maintenance commits. */
	readonly maintenanceIdentity: (purpose: "rollback" | "outbox", key: string) => GuardOperationIdentity;
	/** Native Owner authorisation for rollback to depth-only; false blocks. */
	readonly authoriseRollback: () => Promise<boolean>;
}
function num(n: unknown): n is number {
	return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}
function text(s: unknown): s is string {
	return typeof s === "string" && s.length > 0 && Buffer.byteLength(s, "utf8") <= 1024;
}
function add(a: number, b: number): number {
	const value = a + b;
	if (!num(value)) throw new Error("unsafe time/hop arithmetic");
	return value;
}
function equal(a: unknown, b: unknown): boolean {
	return guardDigest(a) === guardDigest(b);
}
function blocked(
	reason: GuardBlockedReason,
	request: GuardRequest | null = null,
	requiredTier: "lower" | "owner" | null = null,
): FinalResult {
	return { state: "blocked", reason, request, requiredTier, accepted: false };
}
function actorValid(a: GuardActor): boolean {
	return (
		!!a &&
		text(a.role) &&
		text(a.sessionFile) &&
		text(a.sessionId) &&
		text(a.runtimeIncarnation) &&
		text(a.identityRevision) &&
		typeof a.currentHome === "boolean" &&
		taskValid(a.task)
	);
}
function taskValid(t: GuardActor["task"]): boolean {
	return (
		!!t &&
		(t.kind === "home" ||
			(t.kind === "task" && text(t.queueId) && num(t.taskId) && text(t.generation)) ||
			(t.kind === "other" && text(t.bindingId)))
	);
}
function causalValid(c: GuardKnownCausality): boolean {
	return (
		!!c &&
		num(c.nextHop) &&
		c.nextHop >= 1 &&
		text(c.incomingHash) &&
		(c.kind === "rooted"
			? text(c.rootId) &&
				text(c.sourceRevision) &&
				(c.parentId === null || text(c.parentId)) &&
				(c.incomingRecordId === null || text(c.incomingRecordId))
			: c.kind === "legacy_boundary" && text(c.anchorId) && text(c.incomingRecordId) && c.historicalRoot === "unknown")
	);
}
function rootKey(c: GuardKnownCausality): string {
	return guardDigest(
		c.kind === "rooted"
			? { kind: c.kind, rootId: c.rootId }
			: {
					kind: c.kind,
					anchorId: c.anchorId,
					incomingRecordId: c.incomingRecordId,
					incomingHash: c.incomingHash,
					historicalRoot: c.historicalRoot,
				},
	);
}
function scopeValid(s: GuardScope): boolean {
	return (
		!!s &&
		text(s.scopeId) &&
		text(s.operation) &&
		taskValid(s.task) &&
		Array.isArray(s.participants) &&
		s.participants.length >= 1 &&
		s.participants.length <= 32 &&
		s.participants.every(text) &&
		new Set(s.participants).size === s.participants.length &&
		Array.isArray(s.recipients) &&
		s.recipients.length >= 1 &&
		s.recipients.length <= 32 &&
		s.recipients.every(text) &&
		new Set(s.recipients).size === s.recipients.length
	);
}
function proofValid(p: GuardProofReference, now: number): boolean {
	return (
		!!p &&
		[p.sourceId, p.sourceVersion, p.sourceIncarnation, p.eventId, p.revision, p.digest].every(text) &&
		num(p.observedAt) &&
		p.observedAt <= now
	);
}
function contextValid(c: GuardApprovalContext, maximumBytes: number, now: number): boolean {
	return (
		!!c &&
		[
			c.goal,
			c.progressAndChanges,
			c.whyNeeded,
			c.nextStepAndOutcome,
			c.timeCostRisk,
			c.exactCommunicationAuthority,
		].every((s) => typeof s === "string" && s.trim().length > 0) &&
		[c.priorDecisions, c.outstandingQuestions, c.optionsAndTradeoffs, c.declaredClaims, c.safetyScopeAndHolds].every(
			(a) => Array.isArray(a) && a.every((s) => typeof s === "string"),
		) &&
		c.outstandingQuestions.length > 0 &&
		c.optionsAndTradeoffs.length > 0 &&
		Array.isArray(c.nativeFacts) &&
		c.nativeFacts.every((p) => proofValid(p, now)) &&
		Buffer.byteLength(JSON.stringify(c), "utf8") <= maximumBytes
	);
}
function openRequest(r: GuardRequest): boolean {
	return ["context_needed", "awaiting_approver", "awaiting_owner", "rate_limited", "held"].includes(r.state);
}
/** The Owner-phase binding E derives from a lower phase; only quantity bounds, root, scope and requester carry over. */
function escalatedBinding(lower: GuardApprovalBinding): GuardApprovalBinding {
	return { ...lower, generation: guardEscalationGeneration(lower), tier: "owner" };
}
/** True only for the single Owner phase E's escalation transition creates from this lower phase. */
function escalatedPhaseOf(candidate: GuardRequest, lower: GuardRequest): boolean {
	return (
		equal(candidate.binding, escalatedBinding(lower.binding)) &&
		candidate.selectedApprover.tier === "owner" &&
		candidate.selectedApprover.reason === "explicit_escalation" &&
		candidate.upwardEscalations === 1 &&
		candidate.expiresAt === lower.expiresAt &&
		candidate.initialNotificationKey === lower.initialNotificationKey &&
		candidate.decisionNotificationKey === lower.decisionNotificationKey
	);
}
function incidentKey(i: GuardIncidentIdentity): string {
	// Wording, receipt id, process incarnation, origin and destination cannot mint another episode slot.
	return guardDigest({
		producerId: i.producer.sourceId,
		episodeId: i.nativeEpisodeId,
		generation: i.episodeGeneration,
		resourceId: i.resourceId,
	});
}
/** Stable semantic fingerprint; refreshable holds/time are NOT a second operation or approval. */
export function guardCommandFingerprint(command: GuardCommand): string {
	const { identity: _identity, ...body } = command;
	if ("snapshot" in body) {
		const { snapshot, ...intent } = body;
		return guardDigest({ ...intent, actor: snapshot.actor, causal: snapshot.causal });
	}
	return guardDigest(body);
}
function mutable(s: GuardStoreState): MutableState {
	return {
		...s,
		requests: [...s.requests],
		grants: [...s.grants],
		incidents: [...s.incidents],
		usage: [...s.usage],
		transactions: [...s.transactions],
		outbox: [...s.outbox],
		audits: [...s.audits],
		tombstones: [...s.tombstones],
	};
}

export class RoleMessageGuardCore implements GuardCoordinator {
	private readonly options: GuardCoreOptions;
	constructor(options: GuardCoreOptions) {
		if (
			!equal(options.policy, policyV1) ||
			options.binding.version !== version ||
			options.binding.contractCommit !== contractCommit ||
			options.binding.contractSha256 !== contractSha256 ||
			options.binding.policyDocumentSha256 !== policyDocumentSha256
		)
			throw new Error("exact frozen contract/policy pin required");
		const r = options.retention;
		if (!Object.entries(r).every(([k, v]) => (k === "sourceReplayHorizonMs" && v === "unknown") || (num(v) && v >= 1)))
			throw new Error("explicit finite retention caps required");
		if (
			r.settledRetentionMs < policyV1.request.lifetimeMs ||
			(r.sourceReplayHorizonMs !== "unknown" && r.settledRetentionMs < r.sourceReplayHorizonMs)
		)
			throw new Error("retention cannot precede request or verified replay horizon");
		for (const key of [
			"clock",
			"requestSnapshot",
			"reverifyDecision",
			"verifyGrantLineage",
			"restoreSnapshot",
			"verifyStatusActor",
			"materialize",
			"maintenanceIdentity",
			"authoriseRollback",
		] as const)
			if (typeof options[key] !== "function") throw new Error(`required injected host boundary: ${key}`);
		this.options = {
			...options,
			retention: structuredClone(r),
			policy: structuredClone(options.policy),
			binding: structuredClone(options.binding),
		};
	}
	private clockOK(time: GuardTime, state: GuardStoreState): boolean {
		return (
			time.state === "trusted" &&
			num(time.nowMs) &&
			num(time.lastObservedMs) &&
			time.nowMs >= time.lastObservedMs &&
			time.nowMs >= state.lastTrustedTime &&
			state.usage.every((u) => u.committedAt <= time.nowMs) &&
			state.requests.every((r) => r.createdAt <= time.nowMs) &&
			state.grants.every((g) => g.issuedAt <= time.nowMs) &&
			state.audits.every((a) => a.at <= time.nowMs)
		);
	}
	private snapshotOK(
		snapshot: GuardVerifiedSnapshot,
		state: GuardStoreState,
		identity: GuardOperationIdentity,
	): GuardBlockedReason | null {
		if (!actorValid(snapshot.actor) || !equal(snapshot.actor, identity.actor)) return "authority_unavailable";
		if (!causalValid(snapshot.causal)) return "causality_unknown";
		if (!this.clockOK(snapshot.time, state)) return "clock_untrusted";
		const requiredHolds = [
			"ownerPaused",
			"roleDeliveryPaused",
			"wakesDisabled",
			"accessDenied",
			"scopeDenied",
			"spendingOrConsentDenied",
			"queueOrSessionMismatch",
			"sourcePermissionRevoked",
		] as const;
		if (
			!snapshot.holds ||
			requiredHolds.some((key) => snapshot.holds[key] !== false) ||
			Object.values(snapshot.holds).some((value) => value !== false)
		)
			return "held";
		return null;
	}
	private prune(state: MutableState, now: number): void {
		// No pruning ever clears unknown reservations, unknown source horizons or legacy accepted words.
		if (state.transactions.some((t) => t.state !== "committed")) return;
		const terminal = new Set(
			state.outbox
				.filter(
					(o) =>
						o.state === "handled" || (o.state === "dispatched" && o.message.kind === "fyi") || o.state === "failed",
				)
				.filter(
					(o) =>
						now -
							Math.max(
								o.receipt.committedAt,
								o.lastEvidence?.observedAt ?? 0,
								...state.audits.filter((a) => a.subjectId === `outbox:${o.receipt.outboxId}`).map((a) => a.at),
							) >=
						this.options.retention.settledRetentionMs,
				)
				.map((o) => o.receipt.transactionId),
		);
		const old = state.transactions.filter(
			(t) =>
				t.state === "committed" &&
				(t.result.state !== "accepted" || terminal.has(t.transactionId)) &&
				now - (state.audits.find((a) => a.transactionId === t.transactionId)?.at ?? now) >=
					this.options.retention.settledRetentionMs,
		);
		for (const t of old)
			if (
				!state.tombstones.some(
					(stone) => stone.kind === "operation" && stone.identityDigest === guardOperationKey(t.identity),
				)
			)
				state.tombstones.push({
					kind: "operation",
					identityDigest: guardOperationKey(t.identity),
					invalidThrough: "source_horizon_unknown",
					lastTransactionId: t.transactionId,
				});
		const pruned = new Set(old.map((t) => t.transactionId));
		state.transactions = state.transactions.filter((t) => !pruned.has(t.transactionId));
		state.outbox = state.outbox.filter((o) => !terminal.has(o.receipt.transactionId));
		// Keep all decision/action binding audit receipts while their request/incident survives.
		state.audits = state.audits.filter(
			(a) => !pruned.has(a.transactionId) || a.event === "decided" || a.subjectId.startsWith("incident-action:"),
		);
		state.usage = state.usage.filter((u) => now - u.committedAt < policyV1.ordinary.rollingWindowMs);
		state.grants = state.grants.map((g) =>
			g.state === "approved" && now >= g.expiresAt ? { ...g, state: "expired" } : g,
		);
		state.requests = state.requests.map((r) => (openRequest(r) && now >= r.expiresAt ? { ...r, state: "expired" } : r));
		state.incidents = state.incidents.map((i) =>
			i.state === "live" && now >= i.identity.expiresAt ? { ...i, state: "expired", resultStorageReserved: false } : i,
		);
		const settledAge = this.options.retention.settledRetentionMs;
		const pendingRoot = (causal: GuardKnownCausality) =>
			state.outbox.some(
				(o) =>
					rootKey(o.receipt.causal) === rootKey(causal) &&
					!terminal.has(o.receipt.transactionId) &&
					o.state !== "handled" &&
					!(o.state === "dispatched" && o.message.kind === "fyi"),
			);
		const removable = (r: GuardRequest) =>
			!openRequest(r) && now - r.expiresAt >= settledAge && !pendingRoot(r.binding.causal);
		// An escalation lineage (lower phase + Owner phase share requestId) leaves only as a whole, so the preserved
		// lower decision can never be dropped while its Owner phase, grant or audits could still be reused.
		const removedRequests = state.requests.filter(
			(r) =>
				removable(r) &&
				state.requests.every((other) => other.binding.requestId !== r.binding.requestId || removable(other)),
		);
		for (const r of removedRequests)
			state.tombstones.push({
				kind: "request",
				identityDigest: guardDigest({ requestId: r.binding.requestId, generation: r.binding.generation }),
				invalidThrough: "source_horizon_unknown",
				lastTransactionId: null,
			});
		state.requests = state.requests.filter((r) => !removedRequests.includes(r));
		const removedGrants = state.grants.filter(
			(g) =>
				g.state !== "approved" &&
				now - g.expiresAt >= settledAge &&
				!state.requests.some((r) => r.grantId === g.id) &&
				!pendingRoot(g.binding.causal),
		);
		for (const g of removedGrants)
			state.tombstones.push({
				kind: "grant",
				identityDigest: guardDigest(g.id),
				invalidThrough: "source_horizon_unknown",
				lastTransactionId: g.useTransactionIds.at(-1) ?? null,
			});
		state.grants = state.grants.filter((g) => !removedGrants.includes(g));
		const removedIncidents = state.incidents.filter(
			(i) => i.state === "expired" && now - i.identity.expiresAt >= settledAge && !pendingRoot(i.identity.causal),
		);
		for (const i of removedIncidents)
			state.tombstones.push({
				kind: "incident",
				identityDigest: incidentKey(i.identity),
				invalidThrough: "source_horizon_unknown",
				lastTransactionId: i.resultTransactionId ?? i.initialTransactionId,
			});
		state.incidents = state.incidents.filter((i) => !removedIncidents.includes(i));
		state.audits = state.audits.filter(
			(a) =>
				!removedRequests.some((r) => a.subjectId === r.binding.requestId) &&
				!removedIncidents.some(
					(i) =>
						a.subjectId === `incident:${incidentKey(i.identity)}` ||
						a.subjectId.startsWith(`incident-action:${incidentKey(i.identity)}:`),
				),
		);
	}
	private fits(state: GuardStoreState): boolean {
		const r = this.options.retention;
		const reserved = state.incidents.filter(
			(i) => i.state === "live" && i.resultStorageReserved && !i.resultTransactionId,
		).length;
		return (
			state.requests.length <= r.maximumRequests &&
			state.grants.length <= r.maximumGrants &&
			state.transactions.length + reserved <= r.maximumTransactions &&
			state.audits.length + reserved <= r.maximumAuditReceipts &&
			state.outbox.length + reserved <= r.maximumOutboxEntries &&
			state.usage.length + reserved <= r.maximumUsageEvents &&
			state.tombstones.length <= r.maximumTombstones
		);
	}
	private audit(
		state: MutableState,
		identity: GuardOperationIdentity,
		event: GuardAuditReceipt["event"],
		subjectId: string,
		now: number,
		proof: GuardProofReference | null = null,
	): void {
		state.audits.push({
			id: `audit-${guardDigest({ identity, event, subjectId })}`,
			transactionId: guardTransactionId(identity),
			subjectId,
			event,
			proof,
			at: now,
		});
	}
	private finish(
		state: MutableState,
		identity: GuardOperationIdentity,
		result: FinalResult,
		legacyAccepted: readonly GuardLegacyAcceptedMessage[],
		now: number,
	): GuardAtomicMutation {
		if (!state.audits.some((a) => a.transactionId === guardTransactionId(identity)))
			this.audit(state, identity, "used", `operation:${result.state}`, now);
		state.transactions.push({ state: "committed", identity, transactionId: guardTransactionId(identity), result });
		state = {
			...state,
			revision: `revision-${guardDigest({ previous: state.revision, identity })}`,
			lastTrustedTime: now,
		};
		if (!this.fits(state)) throw new Error("retention_capacity");
		return { next: state, legacyAccepted, result };
	}
	private commitResult(
		identity: GuardOperationIdentity,
		result: Awaited<ReturnType<GuardStorePort["transact"]>>,
	): GuardResult {
		if (result.state === "committed") return result.result;
		if (result.state === "unknown")
			return {
				state: "unknown",
				identity,
				transactionId: result.transactionId,
				reservation: "held",
				retry: "query_same_identity_only",
				reason: result.reason,
			};
		return blocked(result.reason === "retention_capacity" ? "retention_capacity" : "persistence_unavailable");
	}
	async execute(command: GuardCommand): Promise<GuardResult> {
		try {
			if (
				!command ||
				command.identity.version !== version ||
				!text(command.identity.operationId) ||
				!actorValid(command.identity.actor) ||
				command.identity.fingerprint !== guardCommandFingerprint(command)
			)
				return blocked("invalid_input");
			const result = await this.options.store.transact(command.identity, async (current) => {
				if (!guardStateIsValid(current) || current.mode === "unavailable") throw new Error("persistence_unavailable");
				if (current.transactions.some((t) => t.state !== "committed")) throw new Error("unsettled reservations");
				const clock = await this.options.clock();
				if (!this.clockOK(clock, current))
					return this.finish(
						mutable(current),
						command.identity,
						blocked("clock_untrusted"),
						[],
						current.lastTrustedTime,
					);
				const state = mutable(current);
				this.prune(state, clock.nowMs);
				const now = clock.nowMs;
				let outcome: FinalResult;
				let legacy: readonly GuardLegacyAcceptedMessage[] = [];
				if (command.kind === "request_record") outcome = await this.recordRequest(state, command, now);
				else if (command.kind === "decision_record") outcome = await this.recordDecision(state, command, now);
				else {
					const fresh = await this.options.verifier.revalidate(command.snapshot, "admission");
					if (fresh.state !== "verified") outcome = blocked("authority_unavailable");
					else {
						const fault = this.snapshotOK(fresh.value, state, command.identity);
						if (fault || fresh.value.time.nowMs < now || !equal(fresh.value.causal, command.snapshot.causal))
							outcome = blocked(fault ?? "clock_untrusted");
						else if (
							state.usage.filter(
								(u) =>
									u.origin === command.identity.actor.role && now - u.committedAt < policyV1.ordinary.rollingWindowMs,
							).length >= policyV1.ordinary.acceptedPerOrigin
						)
							outcome = blocked("ordinary_hourly");
						else {
							const admission =
								command.kind === "business_send"
									? await this.business(state, command, fresh.value, now)
									: command.kind === "control_send"
										? await this.control(state, command, fresh.value, now)
										: await this.protected(state, command, fresh.value, now);
							outcome = admission.result;
							legacy = admission.legacyAccepted;
						}
					}
				}
				return this.finish(state, command.identity, outcome, legacy, now);
			});
			return this.commitResult(command.identity, result);
		} catch {
			return blocked("persistence_unavailable");
		}
	}
	private async recordRequest(
		state: MutableState,
		command: Extract<GuardCommand, { kind: "request_record" }>,
		now: number,
	): Promise<FinalResult> {
		const input = command.request;
		if (state.mode !== "enabled") return blocked("rollback_depth");
		const b = input.binding;
		if (
			!actorValid(command.actor) ||
			!equal(command.actor, command.identity.actor) ||
			!equal(b.requester, command.actor) ||
			b.version !== version ||
			!text(b.requestId) ||
			!text(b.generation) ||
			b.generation.startsWith(guardEscalationGenerationPrefix) ||
			!scopeValid(b.scope) ||
			!causalValid(b.causal) ||
			!b.scope.participants.includes(command.actor.role) ||
			!equal(b.scope.task, command.actor.task) ||
			!num(b.quantity) ||
			b.quantity < 1 ||
			b.quantity > 5 ||
			!num(b.upperHop) ||
			b.upperHop !== add(b.causal.nextHop, b.quantity - 1) ||
			b.causal.nextHop <= 6 ||
			(b.tier === "lower" && b.upperHop >= 12) ||
			!["lower", "owner"].includes(b.tier) ||
			input.firstDecision !== null ||
			input.grantId !== null ||
			input.upwardEscalations !== 0
		)
			return blocked("invalid_input");
		if (!contextValid(input.context, this.options.retention.maximumContextBytes, now)) return blocked("invalid_input");
		if (
			state.tombstones.some(
				(t) =>
					t.kind === "request" &&
					t.identityDigest === guardDigest({ requestId: b.requestId, generation: b.generation }),
			)
		)
			return blocked("authority_unavailable");
		const existing = state.requests.find(
			(r) =>
				(r.binding.requestId === b.requestId && r.binding.generation === b.generation) ||
				(rootKey(r.binding.causal) === rootKey(b.causal) &&
					r.binding.tier === b.tier &&
					equal(r.binding.scope, b.scope) &&
					r.binding.generation === b.generation &&
					openRequest(r)),
		);
		if (existing)
			return equal(existing.binding, b) && equal(existing.context, input.context)
				? {
						state: "recorded",
						transactionId: guardTransactionId(command.identity),
						request: existing,
						communicationAccepted: false,
					}
				: blocked("identity_conflict");
		if (
			state.requests.filter(
				(r) => r.binding.requester.role === command.actor.role && openRequest(r) && r.expiresAt > now,
			).length >= 20
		)
			return blocked("request_capacity");
		const snapshot = await this.options.requestSnapshot(command.actor, input);
		if (snapshot.state !== "verified") return blocked("authority_unavailable");
		const revalidated = await this.options.verifier.revalidate(snapshot.value, "admission");
		if (
			revalidated.state !== "verified" ||
			!equal(revalidated.value.actor, command.actor) ||
			!equal(revalidated.value.causal, b.causal) ||
			!this.clockOK(revalidated.value.time, state) ||
			revalidated.value.time.nowMs < now
		)
			return blocked("authority_unavailable");
		const selected = await this.options.verifier.selectApprover(b);
		if (
			selected.state !== "verified" ||
			selected.value.tier !== b.tier ||
			(selected.value.tier === "owner" && selected.value.reason === "explicit_escalation")
		)
			return blocked("authority_unavailable");
		if (
			selected.value.tier === "lower" &&
			(selected.value.role === command.actor.role ||
				selected.value.role !== selected.value.home.role ||
				!selected.value.home.currentHome ||
				!actorValid(selected.value.home) ||
				!proofValid(selected.value.proof, now) ||
				!["coo", "existing_authorised_lead"].includes(selected.value.route))
		)
			return blocked("authority_unavailable");
		const held = Object.values(revalidated.value.holds).some((v) => v !== false);
		const request: GuardRequest = {
			...input,
			selectedApprover: selected.value,
			createdAt: now,
			expiresAt: add(now, 86400000),
			state: held ? "held" : b.tier === "owner" ? "awaiting_owner" : "awaiting_approver",
			initialNotificationKey: `control-initial-${guardDigest(b)}`,
			decisionNotificationKey: `control-decision-${guardDigest(b)}`,
			firstDecision: null,
			grantId: null,
			upwardEscalations: 0,
		};
		state.requests.push(request);
		this.audit(state, command.identity, "requested", b.requestId, now);
		return {
			state: "recorded",
			transactionId: guardTransactionId(command.identity),
			request,
			communicationAccepted: false,
		};
	}
	private async recordDecision(
		state: MutableState,
		command: Extract<GuardCommand, { kind: "decision_record" }>,
		now: number,
	): Promise<FinalResult> {
		const input = command.decision;
		const index = state.requests.findIndex((r) => equal(r.binding, input.binding));
		if (index < 0) return blocked("authority_unavailable");
		const request = state.requests[index];
		if (state.mode !== "enabled") return blocked("grant_revoked", request);
		const fresh = await this.options.reverifyDecision(input, request);
		if (
			fresh.state !== "verified" ||
			!equal(fresh.value, input) ||
			input.authority.tier !== request.binding.tier ||
			!num(input.answeredAt) ||
			input.answeredAt < request.createdAt ||
			input.answeredAt > now ||
			!proofValid(input.authority.proof, now) ||
			!text(input.firstAnswerEventId) ||
			!text(input.authority.decisionId)
		)
			return blocked("authority_unavailable", request);
		if (
			input.authority.tier === "lower" &&
			(request.selectedApprover.tier !== "lower" ||
				!equal(input.authority.selection, request.selectedApprover) ||
				!equal(command.identity.actor, request.selectedApprover.home) ||
				!command.identity.actor.currentHome ||
				command.identity.actor.role === request.binding.requester.role)
		)
			return blocked("authority_unavailable", request);
		if (
			input.authority.tier === "owner" &&
			(!equal(command.identity.actor, request.binding.requester) ||
				!text(input.authority.questionId) ||
				input.authority.questionGeneration !== request.binding.generation ||
				!text(input.authority.choicesDigest) ||
				!text(input.authority.source.authenticatedOwnerBindingId) ||
				!["authenticated_browser", "authorised_owner_telegram"].includes(input.authority.source.kind))
		)
			return blocked("authority_unavailable", request);
		const recorded = (r: GuardRequest): FinalResult => ({
			state: "recorded",
			transactionId: guardTransactionId(command.identity),
			request: r,
			communicationAccepted: false,
		});
		if (request.firstDecision) {
			// First answer wins. A replay of the winning escalation returns the same Owner phase; any other later
			// lower answer is stale: it changes nothing and can never answer the Owner phase (other binding).
			if (request.firstDecision.choice === "escalate_owner" && equal(request.firstDecision, input)) {
				const phase = state.requests.find((r) => escalatedPhaseOf(r, request));
				return phase ? recorded(phase) : blocked("authority_unavailable", request); // unprovable lineage: fail closed
			}
			return recorded(request);
		}
		if (!openRequest(request) || now >= request.expiresAt) return blocked("grant_expired", request);
		if (input.choice === "escalate_owner") return this.escalate(state, command, index, now);
		if (!["deny", "one_send", "requested_quantity"].includes(input.choice)) return blocked("invalid_input", request);
		let updated: GuardRequest;
		if (input.choice === "deny") updated = { ...request, firstDecision: input, state: "denied" };
		else {
			const quantity = input.choice === "one_send" ? 1 : request.binding.quantity;
			const upperHop = add(request.binding.causal.nextHop, quantity - 1);
			if (input.authority.tier === "lower" && upperHop >= 12) return blocked("authority_unavailable", request);
			const grant: GuardGrant = {
				id: `grant-${guardDigest({ binding: request.binding, event: input.firstAnswerEventId })}`,
				binding: { ...request.binding, quantity, upperHop },
				authority: input.authority,
				issuedAt: now,
				expiresAt: add(now, 3600000),
				maximumUses: quantity,
				acceptedUses: 0,
				state: "approved",
				useTransactionIds: [],
			};
			state.grants.push(grant);
			updated = { ...request, firstDecision: input, state: "approved", grantId: grant.id };
		}
		state.requests[index] = updated;
		this.audit(state, command.identity, "decided", request.binding.requestId, now, input.authority.proof);
		return recorded(updated);
	}
	/**
	 * Ops rm-1bb3c77b: ONE explicit Owner escalation, only as the selected lower approver's winning first decision.
	 * One transaction keeps the lower phase with its complete first decision and binding (closed, never reset) and
	 * adds the Owner phase: deterministic new generation, same root/requester/scope/bounds/expiry/notification keys,
	 * no grant, no refund, no fresh TTL, no second initial or terminal notice. Owner context is never clipped.
	 */
	private escalate(
		state: MutableState,
		command: Extract<GuardCommand, { kind: "decision_record" }>,
		index: number,
		now: number,
	): FinalResult {
		const input = command.decision;
		const request = state.requests[index];
		const lower = request.selectedApprover;
		if (
			input.authority.tier !== "lower" ||
			request.binding.tier !== "lower" ||
			lower.tier !== "lower" ||
			request.upwardEscalations !== 0 ||
			request.firstDecision !== null
		)
			return blocked("authority_unavailable", request);
		const binding = escalatedBinding(request.binding);
		if (
			state.requests.some(
				(r) => r.binding.requestId === binding.requestId && r.binding.generation === binding.generation,
			) ||
			state.tombstones.some(
				(t) =>
					t.kind === "request" &&
					t.identityDigest === guardDigest({ requestId: binding.requestId, generation: binding.generation }),
			)
		)
			return blocked("identity_conflict", request);
		const context: GuardApprovalContext = {
			...request.context,
			priorDecisions: [
				...request.context.priorDecisions,
				`Lower approver ${lower.role} (${lower.route}) explicitly escalated request ${binding.requestId} ` +
					`generation ${request.binding.generation} to the Owner at ${input.answeredAt}. Its recorded reason: ` +
					`${JSON.stringify(input.reason)}. The escalation is not a grant or a final approval.`,
			],
		};
		if (!contextValid(context, this.options.retention.maximumContextBytes, now))
			return blocked(
				Buffer.byteLength(JSON.stringify(context), "utf8") > this.options.retention.maximumContextBytes
					? "retention_capacity"
					: "authority_unavailable",
				request,
			);
		const phase: GuardRequest = {
			binding,
			context,
			selectedApprover: { tier: "owner", reason: "explicit_escalation" },
			createdAt: now,
			expiresAt: request.expiresAt,
			state: request.state === "held" ? "held" : "awaiting_owner",
			upwardEscalations: 1,
			initialNotificationKey: request.initialNotificationKey,
			decisionNotificationKey: request.decisionNotificationKey,
			firstDecision: null,
			grantId: null,
		};
		// Preserve first: the lower phase keeps its complete winning decision and binding, closed to every later use.
		state.requests[index] = { ...request, firstDecision: input, state: "revoked" };
		state.requests.push(phase);
		this.audit(state, command.identity, "decided", request.binding.requestId, now, input.authority.proof);
		return {
			state: "recorded",
			transactionId: guardTransactionId(command.identity),
			request: phase,
			communicationAccepted: false,
		};
	}
	private async accepted(
		state: MutableState,
		command: GuardCommand,
		snapshot: GuardHostVerified<GuardVerifiedSnapshot>,
		now: number,
		className: GuardAcceptedReceipt["class"],
		to: string,
		kind: GuardLegacyAcceptedMessage["kind"],
		body: string,
		replyTo: string | null,
		usage: GuardUsageReceipt,
		messageId?: string,
		target: string | null = null,
	): Promise<{ result: FinalResult; legacyAccepted: readonly GuardLegacyAcceptedMessage[] }> {
		const transactionId = guardTransactionId(command.identity);
		const id = messageId ?? `rm-${guardDigest(command.identity).slice(0, 8)}`;
		if (state.outbox.some((o) => o.message.id === id))
			return { result: blocked("identity_conflict"), legacyAccepted: [] };
		const message = await this.options.materialize({
			id,
			at: now,
			actor: snapshot.actor,
			to,
			kind,
			text: body,
			chain: snapshot.causal.nextHop,
			replyTo,
			target,
		});
		if (
			(target !== null && message.target !== target) ||
			message.id !== id ||
			message.at !== now ||
			message.from.role !== snapshot.actor.role ||
			message.from.file !== snapshot.actor.sessionFile ||
			message.to.role !== to ||
			message.kind !== kind ||
			message.text !== body ||
			message.chain !== snapshot.causal.nextHop ||
			(message.replyTo ?? null) !== replyTo ||
			message.state !== "waiting" ||
			message.sends !== 0 ||
			message.attempts !== 0 ||
			Buffer.byteLength(JSON.stringify(message), "utf8") >
				this.options.retention.maximumContextBytes + Buffer.byteLength(body, "utf8")
		)
			throw new Error("native legacy materialization mismatch");
		const receipt: GuardAcceptedReceipt = {
			version,
			identity: command.identity,
			transactionId,
			committedAt: now,
			messageId: id,
			causal: snapshot.causal,
			class: className,
			usage,
			outboxId: `outbox-${transactionId}`,
			dispatchKey: `dispatch-${transactionId}`,
			wakeKey: `wake-${transactionId}`,
			legacyMessageDigest: guardDigest(message),
		};
		state.usage.push({ transactionId, committedAt: now, origin: snapshot.actor.role, destination: to, usage });
		state.outbox.push({ receipt, message, state: "committed", wakeState: "not_requested", lastEvidence: null });
		return { result: { state: "accepted", receipt, delivery: "committed" }, legacyAccepted: [message] };
	}
	private async business(
		state: MutableState,
		command: Extract<GuardCommand, { kind: "business_send" }>,
		snapshot: GuardHostVerified<GuardVerifiedSnapshot>,
		now: number,
	): Promise<{ result: FinalResult; legacyAccepted: readonly GuardLegacyAcceptedMessage[] }> {
		const deny = (reason: GuardBlockedReason) => ({ result: blocked(reason), legacyAccepted: [] });
		if (
			!scopeValid(command.scope) ||
			!command.scope.participants.includes(snapshot.actor.role) ||
			!command.scope.recipients.includes(command.to) ||
			!equal(command.scope.task, snapshot.actor.task) ||
			!["question", "request", "fyi", "reply"].includes(command.businessKind) ||
			typeof command.text !== "string" ||
			!command.text.trim() ||
			command.text.length > 4000 ||
			(command.replyTo !== null && !text(command.replyTo))
		)
			return deny("invalid_input");
		const hop = snapshot.causal.nextHop;
		if (state.mode === "rollback_depth_6" && hop > 6) return deny("rollback_depth");
		let grantIndex = -1;
		if (hop > 6 || command.grantId !== null) {
			if (command.grantId === null)
				return { result: blocked("approval_required", null, hop >= 12 ? "owner" : "lower"), legacyAccepted: [] };
			grantIndex = state.grants.findIndex((g) => g.id === command.grantId);
			if (grantIndex < 0) return deny("grant_revoked");
			const grant = state.grants[grantIndex];
			if (grant.state === "denied") return deny("grant_denied");
			if (grant.state === "revoked") return deny("grant_revoked");
			if (grant.state === "unknown") return deny("authority_unavailable");
			if (now >= grant.expiresAt || grant.state === "expired") return deny("grant_expired");
			if (grant.acceptedUses >= grant.maximumUses || grant.state === "exhausted") return deny("grant_exhausted");
			if (
				grant.state !== "approved" ||
				hop < grant.binding.causal.nextHop ||
				hop > grant.binding.upperHop ||
				(hop >= 12 && grant.authority.tier !== "owner") ||
				!equal(command.scope, grant.binding.scope) ||
				rootKey(snapshot.causal) !== rootKey(grant.binding.causal) ||
				!equal(snapshot.authority, grant.authority)
			)
				return deny("scope_mismatch");
			const lineage = await this.options.verifyGrantLineage(grant, snapshot, command.scope, command.to);
			if (lineage.state !== "verified" || !equal(lineage.value, snapshot)) return deny("authority_unavailable");
		}
		const result = await this.accepted(
			state,
			command,
			snapshot,
			now,
			"business",
			command.to,
			command.businessKind,
			command.text,
			command.replyTo,
			{
				ordinaryOrigin: 1,
				grantBusinessUse: grantIndex >= 0 ? 1 : 0,
				protectedOrigin: 0,
				protectedDestination: 0,
				protectedSystem: 0,
				newIncidentOrigin: 0,
			},
		);
		if (result.result.state === "accepted" && grantIndex >= 0) {
			const grant = state.grants[grantIndex];
			const uses = grant.acceptedUses + 1;
			state.grants[grantIndex] = {
				...grant,
				acceptedUses: uses,
				state: uses === grant.maximumUses ? "exhausted" : "approved",
				useTransactionIds: [...grant.useTransactionIds, result.result.receipt.transactionId],
			};
			state.requests = state.requests.map((r) =>
				r.grantId === grant.id ? { ...r, state: uses === grant.maximumUses ? "exhausted" : "approved" } : r,
			);
			this.audit(state, command.identity, "used", grant.id, now, grant.authority.proof);
		}
		return result;
	}
	private async control(
		state: MutableState,
		command: Extract<GuardCommand, { kind: "control_send" }>,
		snapshot: GuardHostVerified<GuardVerifiedSnapshot>,
		now: number,
	): Promise<{ result: FinalResult; legacyAccepted: readonly GuardLegacyAcceptedMessage[] }> {
		const deny = (reason: GuardBlockedReason) => ({ result: blocked(reason), legacyAccepted: [] });
		if (state.mode !== "enabled") return deny("rollback_depth");
		const request = state.requests.find(
			(r) => r.binding.requestId === command.requestId && r.binding.generation === command.generation,
		);
		if (!request || now >= request.expiresAt || !equal(snapshot.causal, request.binding.causal))
			return deny("authority_unavailable");
		const key = command.phase === "initial" ? request.initialNotificationKey : request.decisionNotificationKey;
		if (state.outbox.some((o) => o.message.id === `rm-${guardDigest(key).slice(0, 8)}`)) return deny("duplicate_slot");
		const initial = command.phase === "initial";
		const decided = request.firstDecision;
		const usage: GuardUsageReceipt = {
			ordinaryOrigin: 1,
			grantBusinessUse: 0,
			protectedOrigin: 0,
			protectedDestination: 0,
			protectedSystem: 0,
			newIncidentOrigin: 0,
		};
		if (request.selectedApprover.tier !== "lower") {
			// The Owner question is native A UI, never an agent message: no initial control for an Owner phase. Only the
			// OPTIONAL requester notice of a recorded, verified Owner decision, under the exact original requester binding,
			// to that requester's own bound session, charged to its ordinary quota and deduped on the lineage's one key.
			if (
				initial ||
				!decided ||
				decided.authority.tier !== "owner" ||
				!["deny", "one_send", "requested_quantity"].includes(decided.choice) ||
				!equal(decided.binding, request.binding) ||
				!equal(snapshot.actor, request.binding.requester) ||
				command.to !== request.binding.requester.role
			)
				return deny("authority_unavailable");
			// The stored Owner decision is rehydrated natively under the writer; a restored copy is not proof.
			const fresh = await this.options.reverifyDecision(decided, request);
			if (fresh.state !== "verified" || !equal(fresh.value, decided)) return deny("authority_unavailable");
			const notice =
				`Requester notice of a verified Owner decision. Sent under the requester's own binding; it is not Owner speech.\n` +
				`Continuation request ${request.binding.requestId}/${request.binding.generation}: the recorded Owner decision is ${decided.choice}. ` +
				`The decision and its reason stay inspectable through status.\n` +
				`No business communication was sent. Business retry must use the recorded finite grant and original scope; nothing is replayed automatically.`;
			if (Buffer.byteLength(notice, "utf8") > this.options.retention.maximumContextBytes)
				return deny("retention_capacity");
			return this.accepted(
				state,
				command,
				snapshot,
				now,
				"control",
				command.to,
				"fyi",
				notice,
				null,
				usage,
				`rm-${guardDigest(key).slice(0, 8)}`,
				request.binding.requester.sessionFile,
			);
		}
		if (
			initial
				? !equal(snapshot.actor, request.binding.requester) ||
					command.to !== request.selectedApprover.role ||
					!openRequest(request)
				: !decided ||
					decided.choice === "escalate_owner" || // an escalation is not terminal: the lineage's one notice stays unused
					!equal(snapshot.actor, request.selectedApprover.home) ||
					command.to !== request.binding.requester.role
		)
			return deny("authority_unavailable");
		if (decided && !initial) {
			// Every decision notice rehydrates its stored decision natively under the writer first.
			const fresh = await this.options.reverifyDecision(decided, request);
			if (fresh.state !== "verified" || !equal(fresh.value, decided)) return deny("authority_unavailable");
		}
		const body = initial
			? `Continuation approval request ${request.binding.requestId}/${request.binding.generation}\n${JSON.stringify({ binding: request.binding, detail: request.context })}`
			: `Continuation decision ${request.binding.requestId}/${request.binding.generation}: ${request.firstDecision!.choice}. ${request.firstDecision!.reason}\nNo business communication was sent. Business retry must use the recorded finite grant and original scope.`;
		if (Buffer.byteLength(body, "utf8") > this.options.retention.maximumContextBytes) return deny("retention_capacity");
		return this.accepted(
			state,
			command,
			snapshot,
			now,
			"control",
			command.to,
			initial ? "question" : "reply",
			body,
			initial ? null : `rm-${guardDigest(request.initialNotificationKey).slice(0, 8)}`,
			usage,
			`rm-${guardDigest(key).slice(0, 8)}`,
		);
	}
	private async protected(
		state: MutableState,
		command: Extract<GuardCommand, { kind: "protected_send" }>,
		snapshot: GuardHostVerified<GuardVerifiedSnapshot>,
		now: number,
	): Promise<{ result: FinalResult; legacyAccepted: readonly GuardLegacyAcceptedMessage[] }> {
		const deny = (reason: GuardBlockedReason) => ({ result: blocked(reason), legacyAccepted: [] });
		if (state.mode !== "enabled") return deny("rollback_depth");
		const notice = command.notice;
		const e = notice.evidence;
		const i = e.incident;
		if (
			!equal(snapshot.incident, e) ||
			!equal(snapshot.actor, i.origin) ||
			!equal(snapshot.causal, i.causal) ||
			!causalValid(i.causal) ||
			!proofValid(i.producer, now) ||
			!text(i.nativeEpisodeId) ||
			!text(i.episodeGeneration) ||
			!text(i.resourceId) ||
			!text(i.resourceOwnerRole) ||
			!text(i.assignedDestinationRole) ||
			!text(i.destinationIdentityRevision) ||
			!num(i.openedAt) ||
			!num(i.expiresAt) ||
			i.openedAt > now ||
			i.expiresAt !== add(i.openedAt, 86400000) ||
			now >= i.expiresAt
		)
			return deny("incident_unavailable");
		if (
			!text(notice.templateVersion) ||
			notice.grantsActionAuthority !== false ||
			typeof notice.text !== "string" ||
			!notice.text.trim() ||
			!num(notice.renderedBytes) ||
			notice.renderedBytes !== Buffer.byteLength(notice.text, "utf8")
		)
			return deny("invalid_input");
		if (notice.renderedBytes > 2048) return deny("notice_too_large");
		if (e.type === "safety_action_notice") {
			if (
				!["security", "data_loss", "data_integrity", "enforced_spend_guard"].includes(e.criticalCategory) ||
				!text(e.actionId) ||
				!["required", "accepted", "underway"].includes(e.actionState) ||
				(e.actionState === "required"
					? e.actionAuthority !== null
					: !e.actionAuthority || !proofValid(e.actionAuthority, now))
			)
				return deny("incident_unavailable");
		} else if (e.type === "critical_risk_notice") {
			if (
				!["security", "data_loss", "data_integrity", "enforced_spend_guard"].includes(e.criticalCategory) ||
				!text(e.activePredicateId)
			)
				return deny("incident_unavailable");
		} else if (e.type === "safety_action_result") {
			if (
				!text(e.actionId) ||
				!proofValid(e.actionAuthority, now) ||
				!proofValid(e.terminalReceipt, now) ||
				!["succeeded", "failed", "indeterminate"].includes(e.outcome)
			)
				return deny("incident_unavailable");
		} else return deny("incident_unavailable");
		if (e.type !== "safety_action_result" && !proofValid(e.receipt, now)) return deny("incident_unavailable");
		const key = incidentKey(i);
		const index = state.incidents.findIndex((incident) => incidentKey(incident.identity) === key);
		if (state.tombstones.some((t) => t.kind === "incident" && t.identityDigest === key))
			return deny("incident_unavailable");
		const previous = index >= 0 ? state.incidents[index] : null;
		if (previous && (!equal(previous.identity, i) || previous.state !== "live")) return deny("incident_unavailable");
		const terminal = e.type === "safety_action_result";
		if (
			terminal
				? !previous || !previous.initialTransactionId || previous.resultTransactionId !== null
				: previous?.initialTransactionId !== null && previous !== null
		)
			return deny("duplicate_slot");
		if (
			terminal &&
			e.type === "safety_action_result" &&
			state.audits.some(
				(a) =>
					a.subjectId.startsWith(`incident-action:${key}:`) &&
					a.subjectId !== `incident-action:${key}:${guardDigest(e.actionId)}`,
			)
		)
			return deny("incident_unavailable");
		const window = state.usage.filter((u) => now - u.committedAt < 3600000);
		if (
			!previous &&
			window.filter((u) => u.origin === snapshot.actor.role && u.usage.newIncidentOrigin === 1).length >= 2
		)
			return deny("incident_origin_hourly");
		if (
			!previous &&
			state.incidents.filter((incident) => incident.state === "live" && incident.identity.expiresAt > now).length >= 12
		)
			return deny("incident_capacity");
		if (window.filter((u) => u.origin === snapshot.actor.role && u.usage.protectedOrigin === 1).length >= 4)
			return deny("protected_origin_hourly");
		if (
			window.filter((u) => u.destination === i.assignedDestinationRole && u.usage.protectedDestination === 1).length >=
			4
		)
			return deny("protected_destination_hourly");
		if (window.filter((u) => u.usage.protectedSystem === 1).length >= 12) return deny("protected_system_hourly");
		const result = await this.accepted(
			state,
			command,
			snapshot,
			now,
			"protected",
			i.assignedDestinationRole,
			"fyi",
			notice.text,
			null,
			{
				ordinaryOrigin: 1,
				grantBusinessUse: 0,
				protectedOrigin: 1,
				protectedDestination: 1,
				protectedSystem: 1,
				newIncidentOrigin: previous ? 0 : 1,
			},
		);
		if (result.result.state === "accepted") {
			const incident: GuardIncident = {
				identity: i,
				state: "live",
				initialTransactionId: terminal ? previous!.initialTransactionId : result.result.receipt.transactionId,
				resultTransactionId: terminal ? result.result.receipt.transactionId : null,
				resultStorageReserved: !terminal,
				resultDeliveryReserved: false,
			};
			if (index < 0) state.incidents.push(incident);
			else state.incidents[index] = incident;
			const proof = e.type === "safety_action_result" ? e.terminalReceipt : e.receipt;
			this.audit(
				state,
				command.identity,
				"used",
				e.type === "critical_risk_notice" ? `incident:${key}` : `incident-action:${key}:${guardDigest(e.actionId)}`,
				now,
				proof,
			);
		}
		return result;
	}
	async status(
		actor: GuardHostVerified<GuardActor>,
		requestId: string,
		generation: string,
	): Promise<GuardStatusResult> {
		try {
			const verified = await this.options.verifyStatusActor(actor);
			if (verified.state !== "verified" || !equal(verified.value, actor))
				return { state: "unavailable", reason: "native actor unavailable" };
			const state = await this.options.store.read();
			if (state.state !== "ready") return state;
			const request = state.value.requests.find(
				(r) => r.binding.requestId === requestId && r.binding.generation === generation,
			);
			if (!request)
				return state.value.tombstones.some(
					(t) => t.kind === "request" && t.identityDigest === guardDigest({ requestId, generation }),
				)
					? { state: "unknown", reason: "request pruned; not authoritatively absent" }
					: { state: "absent", authoritative: true };
			if (
				!equal(actor, request.binding.requester) &&
				!(request.selectedApprover.tier === "lower" && equal(actor, request.selectedApprover.home) && actor.currentHome)
			)
				return { state: "unavailable", reason: "request scoped to requester and selected current home" };
			const time = await this.options.clock();
			if (!this.clockOK(time, state.value)) return { state: "unknown", reason: "status clock unavailable" };
			const grant = state.value.grants.find((g) => g.id === request.grantId);
			const visible =
				time.nowMs >= request.expiresAt && openRequest(request)
					? { ...request, state: "expired" as const }
					: grant?.state === "approved" && time.nowMs >= grant.expiresAt
						? { ...request, state: "expired" as const }
						: request;
			return { state: "found", request: visible };
		} catch {
			return { state: "unknown", reason: "status unavailable" };
		}
	}
	private async updateOutbox(entry: GuardOutboxEntry, next: GuardOutboxEntry, now: number): Promise<GuardResult> {
		if (
			(next.state === "dispatched" || next.state === "handled") &&
			next.message.state === "waiting" &&
			next.lastEvidence
		) {
			const message: GuardLegacyAcceptedMessage = {
				...next.message,
				state: "delivered",
				deliveredAt: now,
				sends: next.message.sends + 1,
			};
			next = { ...next, message, receipt: { ...next.receipt, legacyMessageDigest: guardDigest(message) } };
		}
		const identity = this.options.maintenanceIdentity("outbox", `${entry.receipt.outboxId}:${guardDigest(next)}`);
		const result = await this.options.store.transact(identity, async (current) => {
			if (!this.clockOK({ nowMs: now, lastObservedMs: now, state: "trusted" }, current))
				throw new Error("clock_untrusted");
			const state = mutable(current);
			const index = state.outbox.findIndex((o) => o.receipt.outboxId === entry.receipt.outboxId);
			if (index < 0 || !equal(state.outbox[index], entry)) throw new Error("outbox changed under reconciliation");
			state.outbox[index] = next;
			this.audit(state, identity, "used", `outbox:${entry.receipt.outboxId}`, now, next.lastEvidence);
			// Durable delivery state is reflected in the original operation's idempotent result too.
			state.transactions = state.transactions.map((t) =>
				t.state === "committed" &&
				t.identity.operationId === entry.receipt.identity.operationId &&
				t.result.state === "accepted"
					? { ...t, result: { ...t.result, receipt: next.receipt, delivery: next.state } }
					: t,
			);
			return this.finish(state, identity, { state: "accepted", receipt: next.receipt, delivery: next.state }, [], now);
		});
		return this.commitResult(entry.receipt.identity, result);
	}
	async reconcile(identity: GuardOperationIdentity): Promise<GuardResult> {
		try {
			let found = await this.options.store.lookup(identity);
			if (found.state !== "found")
				return {
					state: "unknown",
					identity,
					transactionId: null,
					reservation: "held",
					retry: "query_same_identity_only",
					reason: found.state === "absent" ? "no committed acceptance" : found.reason,
				};
			if (found.result.state !== "accepted") return found.result;
			const acceptedTransactionId = found.result.receipt.transactionId;
			for (let stage = 0; stage < 4; stage++) {
				const read = await this.options.store.read();
				if (read.state !== "ready")
					return {
						state: "unknown",
						identity,
						transactionId: acceptedTransactionId,
						reservation: "held",
						retry: "query_same_identity_only",
						reason: read.reason,
					};
				const entry = read.value.outbox.find((o) => equal(o.receipt.identity, identity));
				if (!entry)
					return {
						state: "unknown",
						identity,
						transactionId: acceptedTransactionId,
						reservation: "held",
						retry: "query_same_identity_only",
						reason: "outbox unavailable; no replay",
					};
				if (
					entry.state === "handled" ||
					entry.state === "failed" ||
					(entry.state === "dispatched" && entry.message.kind === "fyi")
				)
					return { state: "accepted", receipt: entry.receipt, delivery: entry.state };
				const restored = await this.options.restoreSnapshot(entry);
				const fresh =
					restored.state === "verified" ? await this.options.verifier.revalidate(restored.value, "dispatch") : restored;
				const time = await this.options.clock();
				if (!this.clockOK(time, read.value)) return blocked("clock_untrusted");
				if (
					fresh.state !== "verified" ||
					!equal(fresh.value.actor, identity.actor) ||
					!equal(fresh.value.causal, entry.receipt.causal) ||
					this.snapshotOK(fresh.value, read.value, identity)
				) {
					// A hold must not erase an attempted dispatch/wake and permit a later resend.
					if (
						entry.state === "dispatching" ||
						entry.state === "unknown" ||
						entry.wakeState === "requested" ||
						entry.wakeState === "unknown"
					)
						return { state: "accepted", receipt: entry.receipt, delivery: entry.state };
					return this.updateOutbox(
						entry,
						entry.state === "dispatched" ? { ...entry, wakeState: "held" } : { ...entry, state: "held" },
						time.nowMs,
					);
				}
				const waking = entry.state === "dispatched";
				// A recorded attempt after a crash queries only. Even a 'failed' query is not permission to resend.
				if (
					entry.state === "dispatching" ||
					entry.state === "unknown" ||
					entry.wakeState === "requested" ||
					entry.wakeState === "unknown"
				) {
					const queried = await this.options.transport.query(entry);
					const wakeAttempt = entry.wakeState === "requested" || entry.wakeState === "unknown";
					if (
						queried.state !== "confirmed" ||
						!proofValid(queried.proof, time.nowMs) ||
						queried.proof.eventId !== (wakeAttempt ? entry.receipt.wakeKey : entry.receipt.dispatchKey)
					)
						return {
							state: "unknown",
							identity,
							transactionId: entry.receipt.transactionId,
							reservation: "held",
							retry: "query_same_identity_only",
							reason: "same-identity transport confirmation unavailable",
						};
					const updated = {
						...entry,
						state: wakeAttempt ? ("handled" as const) : ("dispatched" as const),
						wakeState: wakeAttempt ? ("acknowledged" as const) : entry.wakeState,
						lastEvidence: queried.proof,
					};
					const committed = await this.updateOutbox(entry, updated, time.nowMs);
					if (committed.state !== "accepted") return committed;
					continue;
				}
				if (read.value.mode === "rollback_depth_6" && entry.receipt.class !== "business")
					return this.updateOutbox(entry, { ...entry, state: "held" }, time.nowMs);
				const attempted: GuardOutboxEntry = waking
					? { ...entry, wakeState: "requested" }
					: { ...entry, state: "dispatching" };
				const prepare = await this.updateOutbox(entry, attempted, time.nowMs);
				if (prepare.state !== "accepted") return prepare;
				// Native transport must revalidate holds/current route at its own indivisible effect boundary.
				const delivered = await (
					waking
						? this.options.transport.wake(attempted, fresh.value)
						: this.options.transport.dispatch(attempted, fresh.value)
				).catch(() => ({ state: "unknown" as const, reason: "transport threw after attempt" }));
				const expectedKey = waking ? entry.receipt.wakeKey : entry.receipt.dispatchKey;
				const confirmed =
					delivered.state === "confirmed" &&
					proofValid(delivered.proof, time.nowMs) &&
					delivered.proof.eventId === expectedKey;
				const settled: GuardOutboxEntry = {
					...attempted,
					state: confirmed ? (waking ? "handled" : "dispatched") : "unknown",
					wakeState: waking ? (confirmed ? "acknowledged" : "unknown") : attempted.wakeState,
					lastEvidence: confirmed && delivered.state === "confirmed" ? delivered.proof : attempted.lastEvidence,
				};
				const committed = await this.updateOutbox(attempted, settled, time.nowMs);
				if (committed.state !== "accepted" || !confirmed) return committed;
				found = { state: "found", result: { state: "accepted", receipt: entry.receipt, delivery: settled.state } };
			}
			return found.result;
		} catch {
			return {
				state: "unknown",
				identity,
				transactionId: null,
				reservation: "held",
				retry: "query_same_identity_only",
				reason: "reconciliation unavailable; no alternate retry",
			};
		}
	}
	async rollback(): Promise<GuardReadResult> {
		try {
			if (!(await this.options.authoriseRollback()))
				return { state: "unavailable", reason: "native maintenance authority required" };
			const read = await this.options.store.read();
			if (read.state !== "ready") return read;
			const identity = this.options.maintenanceIdentity("rollback", read.value.revision);
			const result = await this.options.store.transact(identity, async (current) => {
				const time = await this.options.clock();
				if (!this.clockOK(time, current)) throw new Error("clock_untrusted");
				const state = mutable({ ...current, mode: "rollback_depth_6" });
				state.grants = state.grants.map((g) => ({ ...g, state: "revoked" }));
				state.requests = state.requests.map((r) => ({ ...r, state: "revoked" }));
				this.audit(state, identity, "rollback", version, time.nowMs);
				return this.finish(state, identity, blocked("rollback_depth"), [], time.nowMs);
			});
			return result.state === "committed" ? this.options.store.read() : { state: "unknown", reason: result.reason };
		} catch {
			return { state: "unknown", reason: "rollback unavailable; no snapshot reset" };
		}
	}
}
