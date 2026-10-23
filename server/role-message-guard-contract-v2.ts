/**
 * Type-only opt-in companion to the byte-frozen V1 contract, not an active policy.
 * Only policy, approval-record and store-container revisions change here. Operation,
 * receipt, authority, transport, usage and incident schemas remain the V1 protocol.
 */
import type * as V1 from "./role-message-guard-contract.js";

export type GuardPolicyVersion = V1.GuardVersion | "role-message-guard/v2";
export type GuardQuantityV2 = V1.GuardQuantity | 6 | 7 | 8 | 9 | 10;
export type GuardBusinessQuantity = V1.GuardQuantity | GuardQuantityV2;

export type GuardPolicyV2 = Omit<V1.GuardPolicyV1, "version" | "depth" | "grant" | "ordinary"> & {
	readonly version: "role-message-guard/v2";
	readonly depth: { readonly unapprovedThrough: 12; readonly lowerThrough: 22; readonly ownerFrom: 23 };
	readonly grant: Omit<V1.GuardPolicyV1["grant"], "maximumBusinessSends"> & {
		readonly maximumBusinessSends: 10;
	};
	readonly ordinary: Omit<V1.GuardPolicyV1["ordinary"], "acceptedPerOrigin"> & {
		readonly acceptedPerOrigin: 40;
	};
};
export type GuardPolicy = V1.GuardPolicyV1 | GuardPolicyV2;

export type GuardApprovalBindingV2 = Omit<V1.GuardApprovalBinding, "version" | "quantity"> & {
	readonly version: "role-message-guard/v2";
	readonly quantity: GuardQuantityV2;
};
export type GuardApprovalBindingAny = V1.GuardApprovalBinding | GuardApprovalBindingV2;

export type GuardApproverSelectionV2 =
	| Extract<V1.GuardApproverSelection, { readonly tier: "lower" }>
	| (Omit<Extract<V1.GuardApproverSelection, { readonly tier: "owner" }>, "reason"> & {
			readonly reason:
				| Exclude<Extract<V1.GuardApproverSelection, { readonly tier: "owner" }>["reason"], "hop_12_plus">
				| "hop_23_plus";
	  });
export type GuardApproverSelectionAny = V1.GuardApproverSelection | GuardApproverSelectionV2;

export type GuardOwnerQuestionV2 = Omit<V1.GuardOwnerQuestion, "binding"> & {
	readonly binding: GuardApprovalBindingV2;
};
export type GuardOwnerQuestionAny = V1.GuardOwnerQuestion | GuardOwnerQuestionV2;

export type GuardVerifiedDecisionV2 = Omit<V1.GuardVerifiedDecision, "binding"> & {
	readonly binding: GuardApprovalBindingV2;
};
export type GuardVerifiedDecisionAny = V1.GuardVerifiedDecision | GuardVerifiedDecisionV2;

export type GuardGrantV2 = Omit<V1.GuardGrant, "binding" | "maximumUses"> & {
	readonly binding: GuardApprovalBindingV2;
	readonly maximumUses: GuardQuantityV2;
};
export type GuardGrantAny = V1.GuardGrant | GuardGrantV2;

export type GuardRequestV2 = Omit<V1.GuardRequest, "binding" | "selectedApprover" | "firstDecision"> & {
	readonly binding: GuardApprovalBindingV2;
	readonly selectedApprover: GuardApproverSelectionV2;
	readonly firstDecision: GuardVerifiedDecisionV2 | null;
};
export type GuardRequestAny = V1.GuardRequest | GuardRequestV2;

/**
 * Select whole record families; independent unions of their fields would lose correlation.
 * Revision membership does not establish binding equality or numeric bounds between fields.
 * Whole-record validation must establish those invariants; a nested binding.version check
 * alone need not narrow an enclosing record union.
 */
export type GuardPolicyFor<V extends GuardPolicyVersion> = V extends V1.GuardVersion ? V1.GuardPolicyV1 : GuardPolicyV2;
export type GuardQuantityFor<V extends GuardPolicyVersion> = V extends V1.GuardVersion
	? V1.GuardQuantity
	: GuardQuantityV2;
export type GuardApprovalBindingFor<V extends GuardPolicyVersion> = V extends V1.GuardVersion
	? V1.GuardApprovalBinding
	: GuardApprovalBindingV2;
export type GuardApproverSelectionFor<V extends GuardPolicyVersion> = V extends V1.GuardVersion
	? V1.GuardApproverSelection
	: GuardApproverSelectionV2;
export type GuardOwnerQuestionFor<V extends GuardPolicyVersion> = V extends V1.GuardVersion
	? V1.GuardOwnerQuestion
	: GuardOwnerQuestionV2;
export type GuardVerifiedDecisionFor<V extends GuardPolicyVersion> = V extends V1.GuardVersion
	? V1.GuardVerifiedDecision
	: GuardVerifiedDecisionV2;
export type GuardGrantFor<V extends GuardPolicyVersion> = V extends V1.GuardVersion ? V1.GuardGrant : GuardGrantV2;
export type GuardRequestFor<V extends GuardPolicyVersion> = V extends V1.GuardVersion
	? V1.GuardRequest
	: GuardRequestV2;

/** Preserve every original command arm and replace only the affected, extracted records. */
export type GuardCommandAny =
	| V1.GuardCommand
	| (Omit<Extract<V1.GuardCommand, { readonly kind: "request_record" }>, "request"> & {
			readonly request: GuardRequestV2;
	  })
	| (Omit<Extract<V1.GuardCommand, { readonly kind: "decision_record" }>, "decision"> & {
			readonly decision: V1.GuardHostVerified<GuardVerifiedDecisionV2>;
	  });

export type GuardResultAny =
	| V1.GuardResult
	| (Omit<Extract<V1.GuardResult, { readonly state: "recorded" }>, "request"> & {
			readonly request: GuardRequestV2;
	  })
	| (Omit<Extract<V1.GuardResult, { readonly state: "blocked" }>, "request"> & {
			readonly request: GuardRequestV2 | null;
	  });

type GuardCommittedResultAny = Exclude<GuardResultAny, { readonly state: "unknown" }>;

export type GuardTransactionRecordAny =
	| V1.GuardTransactionRecord
	| (Omit<Extract<V1.GuardTransactionRecord, { readonly state: "committed" }>, "result"> & {
			readonly result: GuardCommittedResultAny;
	  });

/** S2 may retain exact V1 records. The original S1 envelope still contains V1 records only. */
export type GuardStoreStateV2 = Omit<V1.GuardStoreState, "version" | "requests" | "grants" | "transactions"> & {
	readonly version: "role-message-guard/v2";
	readonly requests: readonly GuardRequestAny[];
	readonly grants: readonly GuardGrantAny[];
	readonly transactions: readonly GuardTransactionRecordAny[];
};
export type GuardStoreStateAny = V1.GuardStoreState | GuardStoreStateV2;

/** A V2 result cannot be committed inside a V1 next-state envelope. */
export type GuardAtomicMutationAny =
	| V1.GuardAtomicMutation
	| (Omit<V1.GuardAtomicMutation, "next" | "result"> & {
			readonly next: GuardStoreStateV2;
			readonly result: GuardCommittedResultAny;
	  });

export type GuardCommitResultAny =
	| V1.GuardCommitResult
	| (Omit<Extract<V1.GuardCommitResult, { readonly state: "committed" }>, "result"> & {
			readonly result: GuardCommittedResultAny;
	  });

export type GuardReadResultAny =
	| V1.GuardReadResult
	| (Omit<Extract<V1.GuardReadResult, { readonly state: "ready" }>, "value"> & {
			readonly value: GuardStoreStateV2;
	  });

export type GuardLookupResultAny =
	| V1.GuardLookupResult
	| (Omit<Extract<V1.GuardLookupResult, { readonly state: "found" }>, "result"> & {
			readonly result: GuardResultAny;
	  });

export type GuardStatusResultAny =
	| V1.GuardStatusResult
	| (Omit<Extract<V1.GuardStatusResult, { readonly state: "found" }>, "request"> & {
			readonly request: GuardRequestV2;
	  });

/**
 * An explicit opt-in port, not a widened export of the frozen store interface.
 * The writer must also validate monotonic container revisions: S2 must never become S1.
 */
export type GuardStorePortAny = Omit<V1.GuardStorePort, "read" | "transact" | "lookup" | "recover"> & {
	readonly read: () => Promise<GuardReadResultAny>;
	readonly transact: (
		identity: V1.GuardOperationIdentity,
		update: (current: GuardStoreStateAny) => Promise<GuardAtomicMutationAny>,
	) => Promise<GuardCommitResultAny>;
	readonly lookup: (identity: V1.GuardOperationIdentity) => Promise<GuardLookupResultAny>;
	readonly recover: () => Promise<GuardReadResultAny>;
};

export type GuardCoordinatorAny = Omit<V1.GuardCoordinator, "execute" | "status" | "reconcile" | "rollback"> & {
	readonly execute: (command: GuardCommandAny) => Promise<GuardResultAny>;
	readonly status: (
		actor: V1.GuardHostVerified<V1.GuardActor>,
		requestId: string,
		generation: string,
	) => Promise<GuardStatusResultAny>;
	readonly reconcile: (identity: V1.GuardOperationIdentity) => Promise<GuardResultAny>;
	readonly rollback: () => Promise<GuardReadResultAny>;
};

/**
 * Function-valued overloads preserve each call's revision and avoid method bivariance
 * on the changed inputs. The union overload is only for a caller holding a union.
 * Unchanged verification, authority and transport schemas remain qualified V1 types.
 */
export type GuardHostVerifierAny = Omit<
	V1.GuardHostVerifier,
	"selectApprover" | "verifyRoleDecision" | "verifyOwnerAnswer"
> & {
	readonly selectApprover: {
		(binding: V1.GuardApprovalBinding): Promise<V1.GuardVerification<V1.GuardApproverSelection>>;
		(binding: GuardApprovalBindingV2): Promise<V1.GuardVerification<GuardApproverSelectionV2>>;
		(binding: GuardApprovalBindingAny): Promise<V1.GuardVerification<GuardApproverSelectionAny>>;
	};
	readonly verifyRoleDecision: {
		(
			reference: V1.GuardRoleDecisionReference,
			binding: V1.GuardApprovalBinding,
		): Promise<V1.GuardVerification<V1.GuardVerifiedDecision>>;
		(
			reference: V1.GuardRoleDecisionReference,
			binding: GuardApprovalBindingV2,
		): Promise<V1.GuardVerification<GuardVerifiedDecisionV2>>;
		(
			reference: V1.GuardRoleDecisionReference,
			binding: GuardApprovalBindingAny,
		): Promise<V1.GuardVerification<GuardVerifiedDecisionAny>>;
	};
	readonly verifyOwnerAnswer: {
		(
			reference: V1.GuardOwnerAnswerReference,
			question: V1.GuardOwnerQuestion,
		): Promise<V1.GuardVerification<V1.GuardVerifiedDecision>>;
		(
			reference: V1.GuardOwnerAnswerReference,
			question: GuardOwnerQuestionV2,
		): Promise<V1.GuardVerification<GuardVerifiedDecisionV2>>;
		(
			reference: V1.GuardOwnerAnswerReference,
			question: GuardOwnerQuestionAny,
		): Promise<V1.GuardVerification<GuardVerifiedDecisionAny>>;
	};
};
