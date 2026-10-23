// Ops453: companion-domain/type refusal proofs. No host invocation, request payload or live data.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { describe, expect, expectTypeOf, it } from "vitest";
import type * as V1 from "../../server/role-message-guard-contract.js";
import type {
	GuardApprovalBindingAny,
	GuardApprovalBindingV2,
	GuardApproverSelectionAny,
	GuardApproverSelectionV2,
	GuardAtomicMutationAny,
	GuardGrantAny,
	GuardGrantV2,
	GuardHostVerifierAny,
	GuardOwnerQuestionV2,
	GuardRequestAny,
	GuardRequestV2,
	GuardResultAny,
	GuardStorePortAny,
	GuardStoreStateAny,
	GuardStoreStateV2,
	GuardTransactionRecordAny,
	GuardVerifiedDecisionAny,
	GuardVerifiedDecisionV2,
} from "../../server/role-message-guard-contract-v2.js";

type Assignable<A, B> = [A] extends [B] ? true : false;
type V1BindingWithTen = Omit<V1.GuardApprovalBinding, "quantity"> & { readonly quantity: 10 };
type FlatBinding = Omit<V1.GuardApprovalBinding, "version" | "quantity"> & {
	readonly version: "role-message-guard/v1" | "role-message-guard/v2";
	readonly quantity: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
};
type RecordedV2 = {
	readonly state: "recorded";
	readonly transactionId: string;
	readonly request: GuardRequestV2;
	readonly communicationAccepted: false;
};
type CommittedV2Request = {
	readonly state: "committed";
	readonly identity: V1.GuardOperationIdentity;
	readonly transactionId: string;
	readonly result: RecordedV2;
};

describe("byte-frozen V1 plus explicit whole-record V2 companion", () => {
	it("keeps the complete historical contract bytes and a type-only qualified companion", () => {
		const original = readFileSync(new URL("../../server/role-message-guard-contract.ts", import.meta.url));
		expect(original.length).toBe(24256);
		expect(createHash("sha256").update(original).digest("hex")).toBe(
			"79a5a1e1a704ecfbb36a70fc1b210ee6e27575013843122cf202a84592b4c7af",
		);
		const source = readFileSync(new URL("../../server/role-message-guard-contract-v2.ts", import.meta.url), "utf8");
		expect(source).toMatch(/import\s+type\s+\*\s+as\s+V1\s+from/);
		expect(source).not.toMatch(/export\s+(?:type\s+)?\*\s+from/);
		expect(transformSync(source, { loader: "ts", format: "esm" }).code.trim()).toBe("");
	});

	it("refuses invalid binding variables, not just excess-property literals", () => {
		expectTypeOf<V1.GuardApprovalBinding["version"]>().toEqualTypeOf<"role-message-guard/v1">();
		expectTypeOf<V1.GuardApprovalBinding["quantity"]>().toEqualTypeOf<1 | 2 | 3 | 4 | 5>();
		expectTypeOf<Assignable<V1BindingWithTen, GuardApprovalBindingAny>>().toEqualTypeOf<false>();
		expectTypeOf<Assignable<FlatBinding, GuardApprovalBindingAny>>().toEqualTypeOf<false>();
		expectTypeOf<Assignable<V1.GuardApprovalBinding, GuardApprovalBindingAny>>().toEqualTypeOf<true>();
		expectTypeOf<Assignable<GuardApprovalBindingV2, GuardApprovalBindingAny>>().toEqualTypeOf<true>();
		expectTypeOf<
			Assignable<Omit<GuardApprovalBindingV2, "quantity"> & { readonly quantity: 11 }, GuardApprovalBindingAny>
		>().toEqualTypeOf<false>();
	});

	it("keeps Owner reason, grant, question and decision revision associations", () => {
		type OldOwner = Extract<V1.GuardApproverSelection, { readonly tier: "owner" }>;
		type NewOwner = Extract<GuardApproverSelectionV2, { readonly tier: "owner" }>;
		expectTypeOf<Assignable<OldOwner, NewOwner>>().toEqualTypeOf<false>();
		expectTypeOf<Assignable<NewOwner, OldOwner>>().toEqualTypeOf<false>();
		expectTypeOf<Assignable<OldOwner | NewOwner, GuardApproverSelectionAny>>().toEqualTypeOf<true>();
		expectTypeOf<
			Assignable<Omit<V1.GuardGrant, "maximumUses"> & { readonly maximumUses: 10 }, GuardGrantAny>
		>().toEqualTypeOf<false>();
		expectTypeOf<
			Assignable<Omit<V1.GuardGrant, "binding"> & { readonly binding: GuardApprovalBindingV2 }, GuardGrantAny>
		>().toEqualTypeOf<true>();
		// V2 may request a still-small maximum; only the durable writer can distinguish
		// a newly issued V2 record from an impermissible relabelling of an old grant ID.
		expectTypeOf<Assignable<V1.GuardGrant | GuardGrantV2, GuardGrantAny>>().toEqualTypeOf<true>();
		expectTypeOf<
			Assignable<
				Omit<V1.GuardVerifiedDecision, "binding"> & { readonly binding: GuardApprovalBindingV2 },
				V1.GuardVerifiedDecision
			>
		>().toEqualTypeOf<false>();
		expectTypeOf<
			Assignable<
				Omit<GuardVerifiedDecisionV2, "binding"> & { readonly binding: V1.GuardApprovalBinding },
				GuardVerifiedDecisionV2
			>
		>().toEqualTypeOf<false>();
		expectTypeOf<
			Assignable<
				Omit<GuardOwnerQuestionV2, "binding"> & { readonly binding: V1.GuardApprovalBinding },
				GuardOwnerQuestionV2
			>
		>().toEqualTypeOf<false>();
		expectTypeOf<
			Assignable<V1.GuardVerifiedDecision | GuardVerifiedDecisionV2, GuardVerifiedDecisionAny>
		>().toEqualTypeOf<true>();
	});

	it("refuses cross-revision first answers and selection reasons in complete requests", () => {
		type OldRequestWithNewDecision = Omit<V1.GuardRequest, "firstDecision"> & {
			readonly firstDecision: GuardVerifiedDecisionV2;
		};
		type NewRequestWithOldDecision = Omit<GuardRequestV2, "firstDecision"> & {
			readonly firstDecision: V1.GuardVerifiedDecision;
		};
		type OldRequestWithNewOwner = Omit<V1.GuardRequest, "selectedApprover"> & {
			readonly selectedApprover: Extract<GuardApproverSelectionV2, { readonly tier: "owner" }>;
		};
		type FlatRequest = Omit<V1.GuardRequest, "binding" | "selectedApprover" | "firstDecision"> & {
			readonly binding: GuardApprovalBindingAny;
			readonly selectedApprover: GuardApproverSelectionAny;
			readonly firstDecision: GuardVerifiedDecisionAny | null;
		};
		expectTypeOf<Assignable<OldRequestWithNewDecision, GuardRequestAny>>().toEqualTypeOf<false>();
		expectTypeOf<Assignable<NewRequestWithOldDecision, GuardRequestAny>>().toEqualTypeOf<false>();
		expectTypeOf<Assignable<OldRequestWithNewOwner, GuardRequestAny>>().toEqualTypeOf<false>();
		expectTypeOf<Assignable<FlatRequest, GuardRequestAny>>().toEqualTypeOf<false>();
		expectTypeOf<Assignable<V1.GuardRequest | GuardRequestV2, GuardRequestAny>>().toEqualTypeOf<true>();
	});

	it("correlates nested persisted results and mutation envelopes while allowing exact mixed S2 history", () => {
		type OldStateWithNewRequests = Omit<V1.GuardStoreState, "requests"> & {
			readonly requests: readonly GuardRequestV2[];
		};
		type OldStateWithNewGrants = Omit<V1.GuardStoreState, "grants"> & { readonly grants: readonly GuardGrantV2[] };
		type OldStateWithNewResult = Omit<V1.GuardStoreState, "transactions"> & {
			readonly transactions: readonly CommittedV2Request[];
		};
		type OldEnvelopeWithNewResult = Omit<V1.GuardAtomicMutation, "result"> & { readonly result: RecordedV2 };
		type MixedS2 = Omit<GuardStoreStateV2, "requests" | "grants" | "transactions"> & {
			readonly requests: readonly (V1.GuardRequest | GuardRequestV2)[];
			readonly grants: readonly (V1.GuardGrant | GuardGrantV2)[];
			readonly transactions: readonly (V1.GuardTransactionRecord | CommittedV2Request)[];
		};
		expectTypeOf<Assignable<OldStateWithNewRequests, GuardStoreStateAny>>().toEqualTypeOf<false>();
		expectTypeOf<Assignable<OldStateWithNewGrants, GuardStoreStateAny>>().toEqualTypeOf<false>();
		expectTypeOf<Assignable<OldStateWithNewResult, GuardStoreStateAny>>().toEqualTypeOf<false>();
		expectTypeOf<Assignable<OldEnvelopeWithNewResult, GuardAtomicMutationAny>>().toEqualTypeOf<false>();
		expectTypeOf<Assignable<MixedS2, GuardStoreStateAny>>().toEqualTypeOf<true>();
		expectTypeOf<Assignable<CommittedV2Request, GuardTransactionRecordAny>>().toEqualTypeOf<true>();
		expectTypeOf<Assignable<V1.GuardStorePort, GuardStorePortAny>>().toEqualTypeOf<false>();
		expectTypeOf<Assignable<GuardStorePortAny, V1.GuardStorePort>>().toEqualTypeOf<false>();
		type Update = Parameters<GuardStorePortAny["transact"]>[1];
		expectTypeOf<Parameters<Update>[0]>().toEqualTypeOf<GuardStoreStateAny>();
		expectTypeOf<Awaited<ReturnType<Update>>>().toEqualTypeOf<GuardAtomicMutationAny>();
	});

	it("keeps verifier per-call outcomes tied to the supplied binding/question revision", () => {
		// Checked statically; never invoked (no native model/tool/request simulation).
		function proof(
			host: GuardHostVerifierAny,
			oldBinding: V1.GuardApprovalBinding,
			newBinding: GuardApprovalBindingV2,
			oldQuestion: V1.GuardOwnerQuestion,
			newQuestion: GuardOwnerQuestionV2,
			roleReference: V1.GuardRoleDecisionReference,
			ownerReference: V1.GuardOwnerAnswerReference,
		) {
			const oldSelection = host.selectApprover(oldBinding);
			const newSelection = host.selectApprover(newBinding);
			const oldDecision = host.verifyRoleDecision(roleReference, oldBinding);
			const newDecision = host.verifyRoleDecision(roleReference, newBinding);
			const oldOwner = host.verifyOwnerAnswer(ownerReference, oldQuestion);
			const newOwner = host.verifyOwnerAnswer(ownerReference, newQuestion);
			expectTypeOf<Awaited<typeof oldSelection>>().toEqualTypeOf<V1.GuardVerification<V1.GuardApproverSelection>>();
			expectTypeOf<Awaited<typeof newSelection>>().toEqualTypeOf<V1.GuardVerification<GuardApproverSelectionV2>>();
			expectTypeOf<Awaited<typeof oldDecision>>().toEqualTypeOf<V1.GuardVerification<V1.GuardVerifiedDecision>>();
			expectTypeOf<Awaited<typeof newDecision>>().toEqualTypeOf<V1.GuardVerification<GuardVerifiedDecisionV2>>();
			expectTypeOf<Awaited<typeof oldOwner>>().toEqualTypeOf<V1.GuardVerification<V1.GuardVerifiedDecision>>();
			expectTypeOf<Awaited<typeof newOwner>>().toEqualTypeOf<V1.GuardVerification<GuardVerifiedDecisionV2>>();
		}
		expect(typeof proof).toBe("function");
	});

	it("keeps policy-neutral operation and receipt ABI literal V1", () => {
		expectTypeOf<V1.GuardOperationIdentity["version"]>().toEqualTypeOf<"role-message-guard/v1">();
		expectTypeOf<V1.GuardAcceptedReceipt["version"]>().toEqualTypeOf<"role-message-guard/v1">();
		expectTypeOf<Assignable<V1.GuardResult, GuardResultAny>>().toEqualTypeOf<true>();
	});
});
