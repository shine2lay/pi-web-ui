// Ops #453: pure policy/schema checks, never a model request or live send.
import { describe, expect, expectTypeOf, it } from "vitest";
import type { GuardPolicyV1, GuardQuantity } from "../../server/role-message-guard-contract.js";
import type { GuardPolicyV2, GuardQuantityV2 } from "../../server/role-message-guard-contract-v2.js";
import {
	GUARD_POLICY_V1,
	GUARD_POLICY_V2,
	ROLE_MESSAGE_POLICY,
	guardBindingBoundsValid,
	guardPolicyIsValid,
	guardQuantityValid,
	guardRequestMaximum,
	roleMessagePolicyMarker,
	roleMessagesHourlyExempt,
} from "../../server/role-message-limits.js";
import { makeMessageRoleTool } from "../../server/role-message-tool.js";
import { ROLE_MESSAGE_CHAIN_MAX, ROLE_MESSAGES_PER_HOUR } from "../../server/role-messages.js";

const binding = (version: string, hop: number, quantity: number, tier: "lower" | "owner") => ({
	version,
	causal: { nextHop: hop },
	quantity,
	upperHop: hop + quantity - 1,
	tier,
});

describe("versioned active policy and strictly preserved legacy domains", () => {
	it("activates the expanded default only after the compatible reader, not merely its explicit test policy", () => {
		expect(ROLE_MESSAGE_POLICY).toBe(GUARD_POLICY_V2);
		expect(ROLE_MESSAGES_PER_HOUR).toBe(40);
		expect(ROLE_MESSAGE_CHAIN_MAX).toBe(12);
		expect(roleMessagePolicyMarker()).toBe(
			"role-message-policy version=role-message-guard/v2 hourly=40 free=12 lower=22 owner=23 grant=10 exemptions=ops,temper",
		);
		expect(roleMessagePolicyMarker(GUARD_POLICY_V1)).not.toBe(roleMessagePolicyMarker());
	});
	it("keeps frozen V1 and explicit V2 literals, without doubling unrelated capacities", () => {
		expectTypeOf<GuardQuantity>().toEqualTypeOf<1 | 2 | 3 | 4 | 5>();
		expectTypeOf<GuardQuantityV2>().toEqualTypeOf<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10>();
		expectTypeOf<GuardPolicyV1["ordinary"]["acceptedPerOrigin"]>().toEqualTypeOf<20>();
		expectTypeOf<GuardPolicyV2["ordinary"]["acceptedPerOrigin"]>().toEqualTypeOf<40>();
		expect(GUARD_POLICY_V1.depth).toEqual({ unapprovedThrough: 6, lowerThrough: 11, ownerFrom: 12 });
		expect(GUARD_POLICY_V2.depth).toEqual({ unapprovedThrough: 12, lowerThrough: 22, ownerFrom: 23 });
		expect(GUARD_POLICY_V2.grant).toEqual({ maximumBusinessSends: 10, lifetimeMs: 3_600_000 });
		expect(GUARD_POLICY_V2.ordinary).toEqual({ acceptedPerOrigin: 40, rollingWindowMs: 3_600_000 });
		for (const key of ["request", "protected", "rollback"] as const)
			expect(GUARD_POLICY_V2[key]).toEqual(GUARD_POLICY_V1[key]);
		expect(GUARD_POLICY_V2.rollback).toEqual({ depthThrough: 6, acceptedPerOrigin: 20, preserveAccepted: true });
		expect(GUARD_POLICY_V2.request.outstandingPerRequester).toBe(20);
		expect(GUARD_POLICY_V2.protected.deliveriesPerSystemHour).toBe(12);
		expect(Object.isFrozen(GUARD_POLICY_V1)).toBe(true);
		expect(Object.isFrozen(GUARD_POLICY_V2.depth)).toBe(true);
		expect(guardPolicyIsValid(GUARD_POLICY_V1)).toBe(true);
		expect(guardPolicyIsValid(GUARD_POLICY_V2)).toBe(true);
		expect(guardPolicyIsValid({ ...GUARD_POLICY_V2, ordinary: GUARD_POLICY_V1.ordinary })).toBe(false);
		expect(guardPolicyIsValid({ ...GUARD_POLICY_V2, extra: true })).toBe(false);
	});
	it("unknown domains and V1 quantities above five fail closed, not a reinterpretation", () => {
		for (const q of [0, 11, 1.5, NaN, Infinity, "10", null])
			expect(guardQuantityValid(q, GUARD_POLICY_V2.version)).toBe(false);
		expect(guardQuantityValid(6, GUARD_POLICY_V1.version)).toBe(false);
		expect(guardQuantityValid(10, GUARD_POLICY_V2.version)).toBe(true);
		expect(guardBindingBoundsValid(binding(GUARD_POLICY_V1.version, 7, 5, "lower"))).toBe(true);
		expect(guardBindingBoundsValid(binding(GUARD_POLICY_V1.version, 7, 6, "lower"))).toBe(false);
		expect(guardBindingBoundsValid(binding(GUARD_POLICY_V1.version, 11, 2, "lower"))).toBe(false);
		expect(guardBindingBoundsValid(binding("role-message-guard/v999", 13, 10, "lower"))).toBe(false);
		expect(guardBindingBoundsValid(binding(GUARD_POLICY_V2.version, 13, 10, "lower"))).toBe(true);
		expect(guardBindingBoundsValid(binding(GUARD_POLICY_V2.version, 23, 10, "owner"))).toBe(true);
		expect(guardBindingBoundsValid(binding(GUARD_POLICY_V2.version, 24, 10, "owner"))).toBe(false);
		expect(guardBindingBoundsValid({ ...binding(GUARD_POLICY_V2.version, 13, 10, "lower"), upperHop: 20 })).toBe(false);
		// Existing genuine legacy Owner domain was not globally endpoint-limited by E.
		expect(guardBindingBoundsValid(binding(GUARD_POLICY_V1.version, 30, 5, "owner"))).toBe(true);
	});
	it("remaining capacity is exact and the Owner endpoint never moves beyond32", () => {
		expect(guardRequestMaximum(GUARD_POLICY_V2, 13, "lower")).toBe(10);
		expect(guardRequestMaximum(GUARD_POLICY_V2, 22, "lower")).toBe(1);
		expect(guardRequestMaximum(GUARD_POLICY_V2, 23, "owner")).toBe(10);
		expect(guardRequestMaximum(GUARD_POLICY_V2, 24, "owner")).toBe(9);
		expect(guardRequestMaximum(GUARD_POLICY_V2, 32, "owner")).toBe(1);
		expect(guardRequestMaximum(GUARD_POLICY_V2, 33, "owner")).toBe(0);
		expect(["ops", "temper", "qa", "OPS"].map(roleMessagesHourlyExempt)).toEqual([true, true, false, false]);
	});
	it("generated help, numeric quantity schema, fallback and passive marker share the selected policy", () => {
		const tool = makeMessageRoleTool({ sender: () => "synthetic role absent", service: () => undefined });
		const p = ROLE_MESSAGE_POLICY;
		expect(tool.description).toContain(`${p.ordinary.acceptedPerOrigin} messages per rolling hour`);
		expect(tool.description).toContain(`1 to ${p.depth.unapprovedThrough}`);
		expect(tool.description).toContain(`${p.depth.unapprovedThrough + 1} to ${p.depth.lowerThrough}`);
		expect(tool.description).toContain(`${p.depth.ownerFrom} or more`);
		const schema = tool.parameters as unknown as {
			properties: { approval: { properties: { quantity: { type: string; minimum: number; maximum: number } } } };
		};
		expect(schema.properties.approval.properties.quantity).toMatchObject({
			type: "integer",
			minimum: 1,
			maximum: p.grant.maximumBusinessSends,
		});
		expect(roleMessagePolicyMarker(GUARD_POLICY_V2)).toBe(
			"role-message-policy version=role-message-guard/v2 hourly=40 free=12 lower=22 owner=23 grant=10 exemptions=ops,temper",
		);
	});
});
