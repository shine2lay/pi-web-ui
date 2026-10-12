/**
 * Component C: erased interfaces only. No registration, values, verifier or policy implementation.
 * All ports below are requirements for E/A/U/I, NOT existing native/SDK capabilities.
 * See docs/role-message-guard-contract.md before implementing any consumer.
 */
import type { RoleMessageRecord } from "./role-messages.js";

declare const hostVerified: unique symbol;

/** Compile-time separation only. A cast, JSON field or persisted brand authenticates nothing. */
export type GuardHostVerified<T> = Readonly<T> & { readonly [hostVerified]: true };
export type GuardVersion = "role-message-guard/v1";
export type GuardQuantity = 1 | 2 | 3 | 4 | 5;
export type GuardBusinessKind = "question" | "request" | "fyi" | "reply";
export type GuardProtectedType = "safety_action_notice" | "critical_risk_notice" | "safety_action_result";
export type GuardTier = "lower" | "owner";
export type GuardMode = "enabled" | "rollback_depth_6" | "unavailable";

/** Literals are the frozen policy, not runtime defaults. Consumers supply/check these exact values. */
export interface GuardPolicyV1 {
	readonly version: GuardVersion;
	readonly depth: { readonly unapprovedThrough: 6; readonly lowerThrough: 11; readonly ownerFrom: 12 };
	readonly grant: { readonly maximumBusinessSends: 5; readonly lifetimeMs: 3600000 };
	readonly ordinary: { readonly acceptedPerOrigin: 20; readonly rollingWindowMs: 3600000 };
	readonly request: {
		readonly outstandingPerRequester: 20;
		readonly lifetimeMs: 86400000;
		readonly openPerRootTierScopeGeneration: 1;
		readonly initialNotifications: 1;
		readonly decisionNotifications: 1;
		readonly explicitUpwardEscalations: 1;
	};
	readonly protected: {
		readonly bypass: "depth_only";
		readonly consumesOrdinaryHourly: true;
		readonly assignedDestinations: 1;
		readonly initialPerEpisode: 1;
		readonly terminalPerEpisode: 1;
		readonly newIncidentsPerOriginHour: 2;
		readonly deliveriesPerOriginHour: 4;
		readonly deliveriesPerDestinationHour: 4;
		readonly deliveriesPerSystemHour: 12;
		readonly liveIncidents: 12;
		readonly lifetimeMs: 86400000;
		readonly maximumRenderedBytes: 2048;
	};
	readonly rollback: { readonly depthThrough: 6; readonly acceptedPerOrigin: 20; readonly preserveAccepted: true };
}

/** All numbers in runtime records require finite safe-integer validation; times are trusted epoch ms. */
export type GuardTaskBinding =
	| { readonly kind: "home" }
	| { readonly kind: "task"; readonly queueId: string; readonly taskId: number; readonly generation: string }
	| { readonly kind: "other"; readonly bindingId: string };

export interface GuardActor {
	readonly role: string;
	readonly sessionFile: string;
	readonly sessionId: string;
	readonly runtimeIncarnation: string;
	readonly task: GuardTaskBinding;
	readonly currentHome: boolean;
	readonly identityRevision: string;
}

/** I supplies an actual invocation-bound lookup, never a caller-selected role/session path. */
export interface GuardInvocationReference {
	readonly invocationId: string;
	readonly toolCallId: string;
	readonly runtimeBindingId: string;
}

/** Agent fields are unknown. Neither this schema nor a typed reference establishes authority. */
export type GuardUntrustedInput =
	| {
			readonly operation: "send";
			readonly to: unknown;
			readonly kind: unknown;
			readonly text: unknown;
			readonly replyTo?: unknown;
			readonly grantId?: unknown;
			readonly scope?: unknown;
	  }
	| {
			readonly operation: "continuation_request";
			readonly binding: unknown;
			readonly context: unknown;
			readonly quantity: unknown;
	  }
	| { readonly operation: "continuation_status"; readonly requestId: unknown; readonly generation: unknown }
	| {
			readonly operation: "continuation_decision";
			readonly requestId: unknown;
			readonly generation: unknown;
			readonly choice: unknown;
			readonly reason: unknown;
	  }
	| { readonly operation: "protected_notice_reference"; readonly receiptId: unknown };

/** There is intentionally NO agent-callable Owner-answer or authoritative incident creation operation. */
export type GuardCausality =
	| {
			readonly kind: "rooted";
			readonly rootId: string;
			readonly parentId: string | null;
			readonly nextHop: number;
			readonly sourceRevision: string;
			readonly incomingRecordId: string | null;
			readonly incomingHash: string;
	  }
	| {
			readonly kind: "legacy_boundary";
			readonly anchorId: string;
			readonly incomingRecordId: string;
			readonly incomingHash: string;
			readonly nextHop: number;
			readonly historicalRoot: "unknown";
	  }
	| { readonly kind: "unknown"; readonly reason: "missing" | "ambiguous" | "pruned" | "stale" | "contradictory" };
export type GuardKnownCausality = Exclude<GuardCausality, { readonly kind: "unknown" }>;

/** Declared goal/operation is a structural scope, NOT proof that semantic claims are true. */
export interface GuardScope {
	readonly scopeId: string;
	readonly operation: string;
	readonly participants: readonly [string, ...string[]];
	readonly recipients: readonly [string, ...string[]];
	readonly task: GuardTaskBinding;
}

export interface GuardApprovalBinding {
	readonly version: GuardVersion;
	readonly requestId: string;
	readonly generation: string;
	readonly requester: GuardActor;
	readonly causal: GuardKnownCausality;
	readonly scope: GuardScope;
	readonly tier: GuardTier;
	readonly quantity: GuardQuantity;
	readonly upperHop: number;
}

export interface GuardProofReference {
	readonly sourceId: string;
	readonly sourceVersion: string;
	readonly sourceIncarnation: string;
	readonly eventId: string;
	readonly revision: string;
	readonly digest: string;
	readonly observedAt: number;
}

export type GuardApproverSelection =
	| {
			readonly tier: "lower";
			readonly role: string;
			readonly route: "coo" | "existing_authorised_lead";
			readonly home: GuardActor;
			readonly proof: GuardProofReference;
	  }
	| { readonly tier: "owner"; readonly reason: "hop_12_plus" | "no_distinct_lower_approver" | "explicit_escalation" };

export type GuardAuthority =
	| {
			readonly tier: "lower";
			readonly selection: Extract<GuardApproverSelection, { readonly tier: "lower" }>;
			readonly decisionId: string;
			readonly proof: GuardProofReference;
	  }
	| {
			readonly tier: "owner";
			readonly questionId: string;
			readonly questionGeneration: string;
			readonly choicesDigest: string;
			readonly decisionId: string;
			readonly source:
				| { readonly kind: "authenticated_browser"; readonly authenticatedOwnerBindingId: string }
				| {
						readonly kind: "authorised_owner_telegram";
						readonly pluginId: string;
						readonly authenticatedOwnerBindingId: string;
				  };
			readonly proof: GuardProofReference;
	  };

export interface GuardApprovalContext {
	readonly goal: string;
	readonly progressAndChanges: string;
	readonly priorDecisions: readonly string[];
	readonly whyNeeded: string;
	readonly nextStepAndOutcome: string;
	readonly outstandingQuestions: readonly string[];
	readonly optionsAndTradeoffs: readonly string[];
	readonly timeCostRisk: string;
	readonly exactCommunicationAuthority: string;
	readonly nativeFacts: readonly GuardProofReference[];
	readonly declaredClaims: readonly string[];
	readonly safetyScopeAndHolds: readonly string[];
}

export type GuardChoice = "deny" | "one_send" | "requested_quantity";
export type GuardRoleChoice = GuardChoice | "escalate_owner";
export interface GuardOwnerQuestion {
	readonly binding: GuardApprovalBinding;
	readonly questionId: string;
	readonly generation: string;
	readonly detail: GuardApprovalContext;
	readonly choices: readonly ["deny", "one_send", "requested_quantity"];
	readonly choicesDigest: string;
}

export interface GuardRoleDecisionReference {
	readonly invocation: GuardInvocationReference;
	readonly requestId: string;
	readonly generation: string;
	readonly choice: GuardRoleChoice;
	readonly reason: string;
}
export interface GuardOwnerAnswerReference {
	readonly nativeAnswerEventId: string;
	readonly questionId: string;
	readonly generation: string;
}
export interface GuardVerifiedDecision {
	readonly binding: GuardApprovalBinding;
	readonly choice: GuardRoleChoice;
	readonly reason: string;
	readonly authority: GuardAuthority;
	readonly answeredAt: number;
	readonly firstAnswerEventId: string;
}

export type GuardGrantState = "approved" | "denied" | "expired" | "exhausted" | "revoked" | "unknown";
export interface GuardGrant {
	readonly id: string;
	readonly binding: GuardApprovalBinding;
	readonly authority: GuardAuthority;
	readonly issuedAt: number;
	readonly expiresAt: number;
	readonly maximumUses: GuardQuantity;
	readonly acceptedUses: number;
	readonly state: GuardGrantState;
	readonly useTransactionIds: readonly string[];
}

export type GuardRequestState =
	"context_needed" | "awaiting_approver" | "awaiting_owner" | "rate_limited" | "held" | GuardGrantState;
export interface GuardRequest {
	readonly binding: GuardApprovalBinding;
	readonly context: GuardApprovalContext;
	readonly selectedApprover: GuardApproverSelection;
	readonly createdAt: number;
	readonly expiresAt: number;
	readonly state: GuardRequestState;
	readonly upwardEscalations: 0 | 1;
	readonly initialNotificationKey: string;
	readonly decisionNotificationKey: string;
	readonly firstDecision: GuardVerifiedDecision | null;
	readonly grantId: string | null;
}

export interface GuardIncidentReference {
	readonly nativeReceiptId: string;
	readonly producerId: string;
}
export interface GuardIncidentIdentity {
	readonly producer: GuardProofReference;
	readonly nativeEpisodeId: string;
	readonly episodeGeneration: string;
	readonly resourceId: string;
	readonly resourceOwnerRole: string;
	readonly origin: GuardActor;
	readonly assignedDestinationRole: string;
	readonly destinationIdentityRevision: string;
	readonly causal: GuardKnownCausality;
	readonly openedAt: number;
	readonly expiresAt: number;
}
export type GuardCriticalCategory = "security" | "data_loss" | "data_integrity" | "enforced_spend_guard";
export type GuardProtectedEvidence =
	| {
			readonly type: "critical_risk_notice";
			readonly incident: GuardIncidentIdentity;
			readonly criticalCategory: GuardCriticalCategory;
			readonly activePredicateId: string;
			readonly receipt: GuardProofReference;
	  }
	| {
			readonly type: "safety_action_notice";
			readonly incident: GuardIncidentIdentity;
			readonly criticalCategory: GuardCriticalCategory;
			readonly actionId: string;
			readonly actionState: "required" | "accepted" | "underway";
			readonly actionAuthority: GuardProofReference | null;
			readonly receipt: GuardProofReference;
	  }
	| {
			readonly type: "safety_action_result";
			readonly incident: GuardIncidentIdentity;
			readonly actionId: string;
			readonly actionAuthority: GuardProofReference;
			readonly outcome: "succeeded" | "failed" | "indeterminate";
			readonly terminalReceipt: GuardProofReference;
	  };

/** U renders the COMPLETE native fixed template; E checks UTF-8 bytes, never clips fields. */
export interface GuardProtectedNotice {
	readonly evidence: GuardProtectedEvidence;
	readonly templateVersion: string;
	readonly text: string;
	readonly renderedBytes: number;
	readonly grantsActionAuthority: false;
}
export interface GuardIncident {
	readonly identity: GuardIncidentIdentity;
	readonly state: "live" | "expired" | "unavailable" | "unknown";
	readonly initialTransactionId: string | null;
	readonly resultTransactionId: string | null;
	readonly resultStorageReserved: boolean;
	readonly resultDeliveryReserved: false;
}

export interface GuardOperationIdentity {
	readonly operationId: string;
	readonly fingerprint: string;
	readonly actor: GuardActor;
	readonly version: GuardVersion;
}
export interface GuardHolds {
	readonly ownerPaused: boolean;
	readonly roleDeliveryPaused: boolean;
	readonly wakesDisabled: boolean;
	readonly accessDenied: boolean;
	readonly scopeDenied: boolean;
	readonly spendingOrConsentDenied: boolean;
	readonly queueOrSessionMismatch: boolean;
	readonly sourcePermissionRevoked: boolean;
}
export interface GuardTime {
	readonly nowMs: number;
	readonly lastObservedMs: number;
	readonly state: "trusted" | "rollback" | "unknown";
}

/** Freshly revalidated inside the SINGLE transaction writer, and again before dispatch. */
export interface GuardVerifiedSnapshot {
	readonly actor: GuardActor;
	readonly causal: GuardKnownCausality;
	readonly holds: GuardHolds;
	readonly time: GuardTime;
	readonly authority: GuardAuthority | null;
	readonly incident: GuardProtectedEvidence | null;
	readonly sourceRevision: string;
}
export type GuardVerification<T> =
	| { readonly state: "verified"; readonly value: GuardHostVerified<T> }
	| { readonly state: "unavailable" | "invalid" | "unknown"; readonly reason: string };

/** I/A/U must implement these from real native boundaries; C supplies NO native adapter. */
export interface GuardHostVerifier {
	verifyInvocation(reference: GuardInvocationReference): Promise<GuardVerification<GuardActor>>;
	verifyCausality(actor: GuardHostVerified<GuardActor>): Promise<GuardVerification<GuardKnownCausality>>;
	selectApprover(binding: GuardApprovalBinding): Promise<GuardVerification<GuardApproverSelection>>;
	verifyRoleDecision(
		reference: GuardRoleDecisionReference,
		binding: GuardApprovalBinding,
	): Promise<GuardVerification<GuardVerifiedDecision>>;
	verifyOwnerAnswer(
		reference: GuardOwnerAnswerReference,
		question: GuardOwnerQuestion,
	): Promise<GuardVerification<GuardVerifiedDecision>>;
	verifyIncident(reference: GuardIncidentReference): Promise<GuardVerification<GuardProtectedEvidence>>;
	revalidate(
		snapshot: GuardHostVerified<GuardVerifiedSnapshot>,
		phase: "admission" | "dispatch",
	): Promise<GuardVerification<GuardVerifiedSnapshot>>;
}

/** E owns EVERY mutation, including decisions without messages. A/U cannot own parallel counters. */
export type GuardCommand =
	| {
			readonly kind: "business_send";
			readonly identity: GuardOperationIdentity;
			readonly snapshot: GuardHostVerified<GuardVerifiedSnapshot>;
			readonly scope: GuardScope;
			readonly to: string;
			readonly businessKind: GuardBusinessKind;
			readonly text: string;
			readonly replyTo: string | null;
			readonly grantId: string | null;
	  }
	| {
			readonly kind: "request_record";
			readonly identity: GuardOperationIdentity;
			readonly actor: GuardHostVerified<GuardActor>;
			readonly request: GuardRequest;
	  }
	| {
			readonly kind: "decision_record";
			readonly identity: GuardOperationIdentity;
			readonly decision: GuardHostVerified<GuardVerifiedDecision>;
	  }
	| {
			readonly kind: "control_send";
			readonly identity: GuardOperationIdentity;
			readonly snapshot: GuardHostVerified<GuardVerifiedSnapshot>;
			readonly requestId: string;
			readonly generation: string;
			readonly phase: "initial" | "decision";
			readonly to: string;
	  }
	| {
			readonly kind: "protected_send";
			readonly identity: GuardOperationIdentity;
			readonly snapshot: GuardHostVerified<GuardVerifiedSnapshot>;
			readonly notice: GuardHostVerified<GuardProtectedNotice>;
	  };

export interface GuardUsageReceipt {
	readonly ordinaryOrigin: 1;
	readonly grantBusinessUse: 0 | 1;
	readonly protectedOrigin: 0 | 1;
	readonly protectedDestination: 0 | 1;
	readonly protectedSystem: 0 | 1;
	readonly newIncidentOrigin: 0 | 1;
}
export interface GuardAcceptedReceipt {
	readonly version: GuardVersion;
	readonly identity: GuardOperationIdentity;
	readonly transactionId: string;
	readonly committedAt: number;
	readonly messageId: string;
	readonly causal: GuardKnownCausality;
	readonly class: "business" | "control" | "protected";
	readonly usage: GuardUsageReceipt;
	readonly outboxId: string;
	readonly dispatchKey: string;
	readonly wakeKey: string;
	readonly legacyMessageDigest: string;
}

/** Existing schema is the single source. Preserve all optional Owner/routing/initiative metadata too. */
export type GuardLegacyAcceptedMessage = Readonly<Omit<RoleMessageRecord, "kind">> & {
	readonly kind: GuardBusinessKind;
};

export type GuardBlockedReason =
	| "invalid_input"
	| "authority_unavailable"
	| "causality_unknown"
	| "approval_required"
	| "scope_mismatch"
	| "grant_denied"
	| "grant_expired"
	| "grant_exhausted"
	| "grant_revoked"
	| "ordinary_hourly"
	| "protected_origin_hourly"
	| "protected_destination_hourly"
	| "protected_system_hourly"
	| "incident_origin_hourly"
	| "incident_capacity"
	| "request_capacity"
	| "duplicate_slot"
	| "incident_unavailable"
	| "notice_too_large"
	| "held"
	| "clock_untrusted"
	| "retention_capacity"
	| "identity_conflict"
	| "rollback_depth"
	| "compatibility_unproved"
	| "persistence_unavailable";
export type GuardResult =
	| { readonly state: "accepted"; readonly receipt: GuardAcceptedReceipt; readonly delivery: GuardOutboxState }
	| {
			readonly state: "recorded";
			readonly transactionId: string;
			readonly request: GuardRequest;
			readonly communicationAccepted: false;
	  }
	| {
			readonly state: "blocked";
			readonly reason: GuardBlockedReason;
			readonly request: GuardRequest | null;
			readonly requiredTier: GuardTier | null;
			readonly accepted: false;
	  }
	| {
			readonly state: "unknown";
			readonly identity: GuardOperationIdentity;
			readonly transactionId: string | null;
			readonly reservation: "held";
			readonly retry: "query_same_identity_only";
			readonly reason: string;
	  };

export type GuardOutboxState = "committed" | "held" | "dispatching" | "dispatched" | "handled" | "failed" | "unknown";
export interface GuardOutboxEntry {
	readonly receipt: GuardAcceptedReceipt;
	readonly message: GuardLegacyAcceptedMessage;
	readonly state: GuardOutboxState;
	readonly wakeState: "not_requested" | "held" | "requested" | "acknowledged" | "unknown";
	readonly lastEvidence: GuardProofReference | null;
}
export type GuardTransportResult =
	| { readonly state: "confirmed"; readonly proof: GuardProofReference }
	| { readonly state: "held" | "failed" | "unknown"; readonly reason: string };
export interface GuardTransportPort {
	/** Same committed identity only. Must prove dedupe before any retry. No alternate channel. */
	dispatch(entry: GuardOutboxEntry, snapshot: GuardHostVerified<GuardVerifiedSnapshot>): Promise<GuardTransportResult>;
	/** Idle now / busy immediately after its turn; no interruption, timer or second wake. */
	wake(entry: GuardOutboxEntry, snapshot: GuardHostVerified<GuardVerifiedSnapshot>): Promise<GuardTransportResult>;
	query(entry: GuardOutboxEntry): Promise<GuardTransportResult>;
}

/** Numeric storage caps are not yet selected policy. E proposes finite values to Ops/I, never unlimited. */
export interface GuardRetention {
	readonly maximumRequests: number;
	readonly maximumGrants: number;
	readonly maximumTransactions: number;
	readonly maximumAuditReceipts: number;
	readonly maximumOutboxEntries: number;
	readonly maximumUsageEvents: number;
	readonly maximumTombstones: number;
	readonly maximumContextBytes: number;
	readonly settledRetentionMs: number;
	readonly sourceReplayHorizonMs: number | "unknown";
}
export interface GuardTombstone {
	readonly kind: "operation" | "request" | "grant" | "incident";
	readonly identityDigest: string;
	readonly invalidThrough: number | "source_horizon_unknown";
	readonly lastTransactionId: string | null;
}
export interface GuardAuditReceipt {
	readonly id: string;
	readonly transactionId: string;
	readonly subjectId: string;
	readonly event: "requested" | "decided" | "used" | "revoked" | "expired" | "rollback" | "unknown";
	readonly proof: GuardProofReference | null;
	readonly at: number;
}
export interface GuardUsageEvent {
	readonly transactionId: string;
	readonly committedAt: number;
	readonly origin: string;
	readonly destination: string;
	readonly usage: GuardUsageReceipt;
}
export interface GuardReservation {
	readonly preparedAt: number;
	readonly origin: string;
	readonly destination: string | null;
	readonly grantId: string | null;
	readonly incidentIdentityDigest: string | null;
	readonly requestGenerationKey: string | null;
	readonly usage: GuardUsageReceipt | null;
	readonly initialIncidentSlot: boolean;
	readonly terminalIncidentSlot: boolean;
}
export type GuardTransactionRecord =
	| {
			readonly state: "prepared";
			readonly identity: GuardOperationIdentity;
			readonly transactionId: string;
			readonly reservation: GuardReservation;
	  }
	| {
			readonly state: "committed";
			readonly identity: GuardOperationIdentity;
			readonly transactionId: string;
			readonly result: Exclude<GuardResult, { readonly state: "unknown" }>;
	  }
	| {
			readonly state: "unknown";
			readonly identity: GuardOperationIdentity;
			readonly transactionId: string;
			readonly reservation: GuardReservation;
			readonly reason: string;
	  };
export interface GuardStoreState {
	readonly version: GuardVersion;
	readonly revision: string;
	readonly mode: GuardMode;
	readonly lastTrustedTime: number;
	readonly requests: readonly GuardRequest[];
	readonly grants: readonly GuardGrant[];
	readonly incidents: readonly GuardIncident[];
	readonly usage: readonly GuardUsageEvent[];
	readonly transactions: readonly GuardTransactionRecord[];
	readonly outbox: readonly GuardOutboxEntry[];
	readonly audits: readonly GuardAuditReceipt[];
	readonly tombstones: readonly GuardTombstone[];
	readonly overflow: { readonly count: number; readonly state: "none" | "capacity_exhausted" | "unknown" };
}
export interface GuardAtomicMutation {
	readonly next: GuardStoreState;
	readonly legacyAccepted: readonly GuardLegacyAcceptedMessage[];
	readonly result: Exclude<GuardResult, { readonly state: "unknown" }>;
}
export type GuardCommitResult =
	| {
			readonly state: "committed";
			readonly transactionId: string;
			readonly revision: string;
			readonly result: Exclude<GuardResult, { readonly state: "unknown" }>;
	  }
	| { readonly state: "not_committed"; readonly reason: string }
	| {
			readonly state: "unknown";
			readonly transactionId: string | null;
			readonly reservation: "held";
			readonly reason: string;
	  };
export type GuardReadResult =
	| { readonly state: "ready"; readonly value: GuardStoreState }
	| { readonly state: "unavailable" | "unknown"; readonly reason: string };

export type GuardLookupResult =
	| { readonly state: "found"; readonly result: GuardResult }
	| { readonly state: "absent"; readonly authoritative: true }
	| { readonly state: "unknown" | "unavailable"; readonly reason: string };
export type GuardStatusResult =
	| { readonly state: "found"; readonly request: GuardRequest }
	| { readonly state: "absent"; readonly authoritative: true }
	| { readonly state: "unknown" | "unavailable"; readonly reason: string };

/** E owns this lock/journal/legacy-publication boundary. Existing RoleMessages.save does NOT satisfy it. */
export interface GuardStorePort {
	read(): Promise<GuardReadResult>;
	/** Callback runs under the same writer lock; publish next+legacy+result as ONE recoverable commit. */
	transact(
		identity: GuardOperationIdentity,
		update: (current: GuardStoreState) => Promise<GuardAtomicMutation>,
	): Promise<GuardCommitResult>;
	lookup(identity: GuardOperationIdentity): Promise<GuardLookupResult>;
	recover(): Promise<GuardReadResult>;
}
export interface GuardCoordinator {
	execute(command: GuardCommand): Promise<GuardResult>;
	status(actor: GuardHostVerified<GuardActor>, requestId: string, generation: string): Promise<GuardStatusResult>;
	reconcile(identity: GuardOperationIdentity): Promise<GuardResult>;
	/** Preserve words/accounting/audits; revoke grants and protection. Never restore an old snapshot. */
	rollback(): Promise<GuardReadResult>;
}

/** Required evidence, not a claim that these capabilities exist or have been qualified. */
export type GuardReadinessBlocker =
	| "native_owner_authentication"
	| "native_home_authority"
	| "native_causal_binding"
	| "native_producer_qualification"
	| "atomic_legacy_publication"
	| "durable_first_answer"
	| "transport_wake_deduplication"
	| "previous_reader_accounting"
	| "bounded_retention_replay";
export interface GuardConsumerBinding {
	readonly version: GuardVersion;
	readonly contractCommit: string;
	readonly contractSha256: string;
	readonly policyDocumentSha256: string;
	readonly blockers: readonly GuardReadinessBlocker[];
}
