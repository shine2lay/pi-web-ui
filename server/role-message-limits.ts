import type {
	GuardApproverSelection,
	GuardPolicyV1,
	GuardQuantity,
	GuardRequest,
	GuardVerifiedDecision,
} from "./role-message-guard-contract.js";
import type {
	GuardApprovalBindingAny,
	GuardApproverSelectionAny,
	GuardApproverSelectionV2,
	GuardBusinessQuantity,
	GuardPolicy,
	GuardPolicyV2,
	GuardPolicyVersion,
	GuardQuantityV2,
	GuardRequestAny,
	GuardRequestV2,
	GuardVerifiedDecisionAny,
	GuardVerifiedDecisionV2,
} from "./role-message-guard-contract-v2.js";

/** Historical policy. Never change these literals or reinterpret a persisted V1 binding. */
export const GUARD_POLICY_V1: GuardPolicyV1 = Object.freeze({
	version: "role-message-guard/v1",
	depth: Object.freeze({ unapprovedThrough: 6, lowerThrough: 11, ownerFrom: 12 }),
	grant: Object.freeze({ maximumBusinessSends: 5, lifetimeMs: 3600000 }),
	ordinary: Object.freeze({ acceptedPerOrigin: 20, rollingWindowMs: 3600000 }),
	request: Object.freeze({
		outstandingPerRequester: 20,
		lifetimeMs: 86400000,
		openPerRootTierScopeGeneration: 1,
		initialNotifications: 1,
		decisionNotifications: 1,
		explicitUpwardEscalations: 1,
	}),
	protected: Object.freeze({
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
	}),
	rollback: Object.freeze({ depthThrough: 6, acceptedPerOrigin: 20, preserveAccepted: true }),
});

/** Owner 2026-10-22 (67477/67481): expanded policy and value domain, not a rewrite of V1. */
export const GUARD_POLICY_V2: GuardPolicyV2 = Object.freeze({
	...GUARD_POLICY_V1,
	version: "role-message-guard/v2",
	depth: Object.freeze({ unapprovedThrough: 12, lowerThrough: 22, ownerFrom: 23 }),
	grant: Object.freeze({ maximumBusinessSends: 10, lifetimeMs: 3600000 }),
	ordinary: Object.freeze({ acceptedPerOrigin: 40, rollingWindowMs: 3600000 }),
});

/** Compatibility-reader phase: old limits stay active until its checked installation is verified. */
export const ROLE_MESSAGE_POLICY: GuardPolicy = GUARD_POLICY_V1;

export function guardPolicyFor(version: GuardPolicyV1["version"]): GuardPolicyV1;
export function guardPolicyFor(version: GuardPolicyV2["version"]): GuardPolicyV2;
export function guardPolicyFor(version: unknown): GuardPolicy | undefined;
export function guardPolicyFor(version: unknown): GuardPolicy | undefined {
	if (version === GUARD_POLICY_V1.version) return GUARD_POLICY_V1;
	if (version === GUARD_POLICY_V2.version) return GUARD_POLICY_V2;
	return undefined;
}

/** Exact field/value comparison, including unchanged capacities. No partial policy or unknown version. */
export function guardPolicyIsValid(value: unknown): value is GuardPolicy {
	if (!value || typeof value !== "object") return false;
	const expected = guardPolicyFor((value as { version?: unknown }).version);
	const same = (a: unknown, b: unknown): boolean => {
		if (a === b) return true;
		if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b))
			return false;
		const x = a as Record<string, unknown>;
		const y = b as Record<string, unknown>;
		return (
			Object.keys(x).length === Object.keys(y).length &&
			Object.keys(y).every((k) => Object.hasOwn(x, k) && same(x[k], y[k]))
		);
	};
	return !!expected && same(value, expected);
}

export function guardQuantityValid(value: unknown, version: GuardPolicyV1["version"]): value is GuardQuantity;
export function guardQuantityValid(value: unknown, version: GuardPolicyV2["version"]): value is GuardQuantityV2;
export function guardQuantityValid(value: unknown, version: GuardPolicyVersion): value is GuardBusinessQuantity;
export function guardQuantityValid(value: unknown, version: GuardPolicyVersion): value is GuardBusinessQuantity {
	const policy = guardPolicyFor(version);
	return (
		!!policy &&
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 1 &&
		value <= policy.grant.maximumBusinessSends
	);
}

/** A fixed finite band: asking from a later hop never creates a later Owner ceiling. */
export function guardRequestMaximum(policy: GuardPolicy, hop: number, tier: "lower" | "owner"): number {
	const end =
		tier === "lower" ? policy.depth.lowerThrough : policy.depth.ownerFrom + policy.grant.maximumBusinessSends - 1;
	const start = tier === "lower" ? hop : Math.max(hop, policy.depth.ownerFrom);
	return Math.max(0, Math.min(policy.grant.maximumBusinessSends, end - start + 1));
}

/** Structural domain check only, not authentication. Legacy bounds always use their recorded policy. */
export function guardBindingBoundsValid(value: unknown): value is GuardApprovalBindingAny {
	if (!value || typeof value !== "object") return false;
	const b = value as GuardApprovalBindingAny;
	const policy = guardPolicyFor(b.version);
	if (!policy || !guardQuantityValid(b.quantity, b.version) || !b.causal) return false;
	const hop = b.causal.nextHop;
	if (
		!Number.isSafeInteger(hop) ||
		hop <= policy.depth.unapprovedThrough ||
		!Number.isSafeInteger(b.upperHop) ||
		b.upperHop !== hop + b.quantity - 1
	)
		return false;
	if (b.tier === "lower") return b.upperHop <= policy.depth.lowerThrough;
	// V1's reader/core did not impose a global Owner endpoint; preserve that historical domain.
	return (
		b.tier === "owner" &&
		(b.version === GUARD_POLICY_V1.version || b.quantity <= guardRequestMaximum(policy, hop, "owner"))
	);
}

function objectRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Revision correlation only. Native authority still needs independent authentication/reverification. */
export function guardSelectionRevisionValid(
	value: unknown,
	version: GuardPolicyV1["version"],
): value is GuardApproverSelection;
export function guardSelectionRevisionValid(
	value: unknown,
	version: GuardPolicyV2["version"],
): value is GuardApproverSelectionV2;
export function guardSelectionRevisionValid(
	value: unknown,
	version: GuardPolicyVersion,
): value is GuardApproverSelectionAny;
export function guardSelectionRevisionValid(
	value: unknown,
	version: GuardPolicyVersion,
): value is GuardApproverSelectionAny {
	if (!objectRecord(value) || !guardPolicyFor(version)) return false;
	if (value.tier === "lower") return true;
	return (
		value.tier === "owner" &&
		(value.reason === "no_distinct_lower_approver" ||
			value.reason === "explicit_escalation" ||
			value.reason === (version === GUARD_POLICY_V1.version ? "hop_12_plus" : "hop_23_plus"))
	);
}

export function guardDecisionRevisionValid(
	value: unknown,
	version: GuardPolicyV1["version"],
): value is GuardVerifiedDecision;
export function guardDecisionRevisionValid(
	value: unknown,
	version: GuardPolicyV2["version"],
): value is GuardVerifiedDecisionV2;
export function guardDecisionRevisionValid(
	value: unknown,
	version?: GuardPolicyVersion,
): value is GuardVerifiedDecisionAny;
export function guardDecisionRevisionValid(
	value: unknown,
	version?: GuardPolicyVersion,
): value is GuardVerifiedDecisionAny {
	return (
		objectRecord(value) &&
		guardBindingBoundsValid(value.binding) &&
		(version === undefined || value.binding.version === version)
	);
}

/** Whole request revision, not independent version/quantity unions. */
export function guardRequestRevisionValid(value: unknown, version: GuardPolicyV1["version"]): value is GuardRequest;
export function guardRequestRevisionValid(value: unknown, version: GuardPolicyV2["version"]): value is GuardRequestV2;
export function guardRequestRevisionValid(value: unknown, version?: GuardPolicyVersion): value is GuardRequestAny;
export function guardRequestRevisionValid(value: unknown, version?: GuardPolicyVersion): value is GuardRequestAny {
	if (
		!objectRecord(value) ||
		!guardBindingBoundsValid(value.binding) ||
		(version !== undefined && value.binding.version !== version) ||
		!guardSelectionRevisionValid(value.selectedApprover, value.binding.version)
	)
		return false;
	return (
		value.firstDecision === null ||
		(guardDecisionRevisionValid(value.firstDecision) && value.firstDecision.binding.version === value.binding.version)
	);
}

/** Passive startup metadata, never a schema, prompt, request or grant dump. */
export function roleMessagePolicyMarker(policy: GuardPolicy = ROLE_MESSAGE_POLICY): string {
	return `role-message-policy version=${policy.version} hourly=${policy.ordinary.acceptedPerOrigin} free=${policy.depth.unapprovedThrough} lower=${policy.depth.lowerThrough} owner=${policy.depth.ownerFrom} grant=${policy.grant.maximumBusinessSends} exemptions=ops,temper`;
}

/** Owner 2026-10-20, dr-c6daedfa9fef: no hourly limit for temper or ops, in any chat (Ops #318). */
export const ROLE_MESSAGES_HOURLY_EXEMPT_ROLES = ["temper", "ops"] as const;
/** Check only the server-derived sender role. Usage, chain approvals and every other guard still apply. */
export function roleMessagesHourlyExempt(role: string): boolean {
	return ROLE_MESSAGES_HOURLY_EXEMPT_ROLES.some((id) => id === role);
}
