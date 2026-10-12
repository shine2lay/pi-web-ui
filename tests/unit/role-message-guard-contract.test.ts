// Component C law examples. NO production guard/store/transport, native authentication or real data.
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { RoleMessageRecord } from "../../server/role-messages.js";
import type {
	GuardActor,
	GuardApprovalBinding,
	GuardAuthority,
	GuardCommand,
	GuardCommitResult,
	GuardHostVerified,
	GuardLegacyAcceptedMessage,
	GuardLookupResult,
	GuardOperationIdentity,
	GuardOutboxState,
	GuardPolicyV1,
	GuardProtectedNotice,
	GuardQuantity,
	GuardResult,
	GuardStatusResult,
	GuardUntrustedInput,
} from "../../server/role-message-guard-contract.js";

const contractUrl = new URL("../../server/role-message-guard-contract.ts", import.meta.url);
const documentUrl = new URL("../../docs/role-message-guard-contract.md", import.meta.url);
const source = readFileSync(contractUrl, "utf8");
const document = readFileSync(documentUrl, "utf8");
const policy = {
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
} as const satisfies GuardPolicyV1;

const actor: GuardActor = {
	role: "example-requester",
	sessionFile: "/synthetic/home.jsonl",
	sessionId: "synthetic-home",
	runtimeIncarnation: "synthetic-incarnation",
	task: { kind: "home" },
	currentHome: true,
	identityRevision: "synthetic-identity-1",
};
const binding: GuardApprovalBinding = {
	version: policy.version,
	requestId: "synthetic-request",
	generation: "generation-1",
	requester: actor,
	causal: {
		kind: "legacy_boundary",
		anchorId: "boundary-exact-incoming",
		incomingRecordId: "legacy-incoming",
		incomingHash: "synthetic-content-hash",
		nextHop: 7,
		historicalRoot: "unknown",
	},
	scope: {
		scopeId: "synthetic-scope",
		operation: "continue-bounded-work",
		participants: ["example-requester"],
		recipients: ["example-peer"],
		task: actor.task,
	},
	tier: "lower",
	quantity: 5,
	upperHop: 11,
};

/** Test-local law oracle only; V MUST NOT use it to grade E's runtime implementation. */
interface LawInput {
	depth?: number;
	messageClass?: "business" | "control" | "protected";
	ordinary?: number;
	authority?: "none" | "lower" | "owner";
	grantVerified?: boolean;
	grantUses?: number;
	grantMaximum?: number;
	grantUpper?: number;
	grantAge?: number;
	grantState?: "approved" | "denied" | "revoked" | "unknown";
	scopeMatches?: boolean;
	clockTrusted?: boolean;
	causalityKnown?: boolean;
	held?: boolean;
	rollback?: boolean;
	replay?: "none" | "accepted" | "unknown" | "identity_conflict";
	controlIdentityMatches?: boolean;
	producerQualified?: boolean;
	incidentCurrent?: boolean;
	destinationAssigned?: boolean;
	noticeBytes?: number;
	protectedOrigin?: number;
	protectedDestination?: number;
	protectedSystem?: number;
	newIncidentsOrigin?: number;
	liveIncidents?: number;
	newIncident?: boolean;
	slotAvailable?: boolean;
	actionAuthorised?: boolean;
	requiresActionAuthority?: boolean;
}
function lawExample(input: LawInput): string {
	if (input.replay === "identity_conflict") return "identity_conflict";
	if (input.replay === "accepted") return "same_receipt_no_new_charge";
	if (input.replay === "unknown") return "unknown_hold_query_same_identity";
	if (input.held) return "held";
	if (input.clockTrusted === false) return "clock_untrusted";
	if (input.causalityKnown === false) return "causality_unknown";
	const depth = input.depth ?? 7;
	if (!Number.isSafeInteger(depth) || depth < 1) return "invalid_input";
	if (input.rollback && depth > policy.rollback.depthThrough) return "rollback_depth";
	if ((input.ordinary ?? 0) >= policy.ordinary.acceptedPerOrigin) return "ordinary_hourly";
	if (input.messageClass === "control") {
		return input.controlIdentityMatches === false ? "identity_conflict" : "accepted_control_no_grant_use";
	}
	if (input.messageClass === "protected") {
		if (input.rollback || input.producerQualified === false) return "incident_unavailable";
		if (input.incidentCurrent === false) return "incident_unavailable";
		if (input.destinationAssigned === false) return "scope_mismatch";
		if (input.requiresActionAuthority && !input.actionAuthorised) return "authority_unavailable";
		if ((input.noticeBytes ?? 0) > policy.protected.maximumRenderedBytes) return "notice_too_large";
		if ((input.protectedOrigin ?? 0) >= policy.protected.deliveriesPerOriginHour) return "protected_origin_hourly";
		if ((input.protectedDestination ?? 0) >= policy.protected.deliveriesPerDestinationHour)
			return "protected_destination_hourly";
		if ((input.protectedSystem ?? 0) >= policy.protected.deliveriesPerSystemHour) return "protected_system_hourly";
		if (input.newIncident && (input.newIncidentsOrigin ?? 0) >= policy.protected.newIncidentsPerOriginHour)
			return "incident_origin_hourly";
		if (input.newIncident && (input.liveIncidents ?? 0) >= policy.protected.liveIncidents) return "incident_capacity";
		if (input.slotAvailable === false) return "duplicate_slot";
		return "accepted_protected_no_grant_use";
	}
	if (depth <= policy.depth.unapprovedThrough) return "accepted_business_no_grant_use";
	if (input.authority !== "owner" && (input.authority !== "lower" || depth >= policy.depth.ownerFrom)) {
		return depth >= policy.depth.ownerFrom ? "owner_required" : "lower_required";
	}
	if (!input.grantVerified) return "authority_unavailable";
	if (input.grantState && input.grantState !== "approved") return `grant_${input.grantState}`;
	if (input.scopeMatches === false) return "scope_mismatch";
	if ((input.grantAge ?? 0) >= policy.grant.lifetimeMs) return "grant_expired";
	if ((input.grantUses ?? 0) >= (input.grantMaximum ?? 1)) return "grant_exhausted";
	if (depth > (input.grantUpper ?? 11)) return "scope_mismatch";
	return "accepted_business_one_grant_use";
}

const cases: Array<[string, LawInput, string]> = [
	["L1 hop 6 ordinary", { depth: 6 }, "accepted_business_no_grant_use"],
	["L1 hop 7 refuses no approval", { depth: 7 }, "lower_required"],
	["L1 hop 7 selected lower", { authority: "lower", grantVerified: true }, "accepted_business_one_grant_use"],
	["L1 hop 11 lower", { depth: 11, authority: "lower", grantVerified: true }, "accepted_business_one_grant_use"],
	["L1 hop 12 lower refuses", { depth: 12, authority: "lower", grantVerified: true }, "owner_required"],
	[
		"L1 hop 12 Owner",
		{ depth: 12, authority: "owner", grantVerified: true, grantUpper: 16 },
		"accepted_business_one_grant_use",
	],
	[
		"L1 no new hard stop at 24",
		{ depth: 24, authority: "owner", grantVerified: true, grantUpper: 28 },
		"accepted_business_one_grant_use",
	],
	["L1 forged brand cannot verify", { authority: "lower" }, "authority_unavailable"],
	[
		"L1 final shared use",
		{ authority: "lower", grantVerified: true, grantMaximum: 5, grantUses: 4 },
		"accepted_business_one_grant_use",
	],
	[
		"L1 sixth use same depth",
		{ authority: "lower", grantVerified: true, grantMaximum: 5, grantUses: 5 },
		"grant_exhausted",
	],
	["L1 denied", { authority: "lower", grantVerified: true, grantState: "denied" }, "grant_denied"],
	["L1 revoked", { authority: "lower", grantVerified: true, grantState: "revoked" }, "grant_revoked"],
	["L1 unknown is not approved", { authority: "lower", grantVerified: true, grantState: "unknown" }, "grant_unknown"],
	["L1 expiry boundary", { authority: "lower", grantVerified: true, grantAge: 3600000 }, "grant_expired"],
	[
		"L1 just before expiry",
		{ authority: "lower", grantVerified: true, grantAge: 3599999 },
		"accepted_business_one_grant_use",
	],
	[
		"L2 participant/recipient/task changed",
		{ authority: "lower", grantVerified: true, scopeMatches: false },
		"scope_mismatch",
	],
	["L2 unknown incoming never hop 1", { depth: 1, causalityKnown: false }, "causality_unknown"],
	["L2 invalid depth zero", { depth: 0 }, "invalid_input"],
	["L2 invalid NaN", { depth: Number.NaN }, "invalid_input"],
	["L4 control at 12 preserves root", { depth: 12, messageClass: "control" }, "accepted_control_no_grant_use"],
	[
		"L4 control cannot change original identity",
		{ messageClass: "control", controlIdentityMatches: false },
		"identity_conflict",
	],
	["L5 ordinary twentieth", { depth: 6, ordinary: 19 }, "accepted_business_no_grant_use"],
	["L5 ordinary twenty-first", { depth: 6, ordinary: 20 }, "ordinary_hourly"],
	["L5 control twenty-first", { messageClass: "control", ordinary: 20 }, "ordinary_hourly"],
	["L5 urgent twenty-first NOT exempt", { messageClass: "protected", depth: 12, ordinary: 20 }, "ordinary_hourly"],
	["L5 clock rollback", { clockTrusted: false }, "clock_untrusted"],
	[
		"L6 protected hop 12 depth-only",
		{ messageClass: "protected", depth: 12, ordinary: 19 },
		"accepted_protected_no_grant_use",
	],
	["L6 ordinary reply not protected", { messageClass: "business", depth: 12 }, "owner_required"],
	["L6 unqualified source", { messageClass: "protected", producerQualified: false }, "incident_unavailable"],
	[
		"L6 stale/expired/contradictory episode",
		{ messageClass: "protected", incidentCurrent: false },
		"incident_unavailable",
	],
	["L6 reassigned destination", { messageClass: "protected", destinationAssigned: false }, "scope_mismatch"],
	[
		"L6 risk/action-required grants no action authority",
		{ messageClass: "protected", actionAuthorised: false },
		"accepted_protected_no_grant_use",
	],
	[
		"L6 result needs authorised action",
		{ messageClass: "protected", requiresActionAuthority: true },
		"authority_unavailable",
	],
	[
		"L6 authorised terminal result",
		{ messageClass: "protected", requiresActionAuthority: true, actionAuthorised: true },
		"accepted_protected_no_grant_use",
	],
	["L6 initial types share slot", { messageClass: "protected", slotAvailable: false }, "duplicate_slot"],
	[
		"L6 native template exactly 2048",
		{ messageClass: "protected", noticeBytes: 2048 },
		"accepted_protected_no_grant_use",
	],
	["L6 overlong template not clipped", { messageClass: "protected", noticeBytes: 2049 }, "notice_too_large"],
	["L6 origin fourth", { messageClass: "protected", protectedOrigin: 3 }, "accepted_protected_no_grant_use"],
	["L6 origin fifth", { messageClass: "protected", protectedOrigin: 4 }, "protected_origin_hourly"],
	["L6 destination fourth", { messageClass: "protected", protectedDestination: 3 }, "accepted_protected_no_grant_use"],
	["L6 destination fifth", { messageClass: "protected", protectedDestination: 4 }, "protected_destination_hourly"],
	["L6 system twelfth", { messageClass: "protected", protectedSystem: 11 }, "accepted_protected_no_grant_use"],
	["L6 system thirteenth", { messageClass: "protected", protectedSystem: 12 }, "protected_system_hourly"],
	[
		"L6 second new incident",
		{ messageClass: "protected", newIncident: true, newIncidentsOrigin: 1 },
		"accepted_protected_no_grant_use",
	],
	[
		"L6 third new incident",
		{ messageClass: "protected", newIncident: true, newIncidentsOrigin: 2 },
		"incident_origin_hourly",
	],
	[
		"L6 twelfth live incident",
		{ messageClass: "protected", newIncident: true, liveIncidents: 11 },
		"accepted_protected_no_grant_use",
	],
	[
		"L6 thirteenth live incident",
		{ messageClass: "protected", newIncident: true, liveIncidents: 12 },
		"incident_capacity",
	],
	[
		"L6 existing result storage not delivery reservation",
		{ messageClass: "protected", liveIncidents: 12, protectedOrigin: 4 },
		"protected_origin_hourly",
	],
	["L7 replay no double charge despite full quota", { replay: "accepted", ordinary: 20 }, "same_receipt_no_new_charge"],
	["L7 uncertain commit no refund/resend", { replay: "unknown" }, "unknown_hold_query_same_identity"],
	["L7 changed payload same key", { replay: "identity_conflict" }, "identity_conflict"],
	["L8 ordinary held", { depth: 6, held: true }, "held"],
	["L8 protected cannot lift hold", { messageClass: "protected", held: true }, "held"],
	["L8 control cannot wake held", { messageClass: "control", held: true }, "held"],
	["L8 rollback old hop 6", { depth: 6, rollback: true }, "accepted_business_no_grant_use"],
	["L8 rollback grant not revived", { rollback: true, authority: "owner", grantVerified: true }, "rollback_depth"],
	["L8 rollback protection disabled", { depth: 6, rollback: true, messageClass: "protected" }, "incident_unavailable"],
];

function finiteQuantity(value: number, depth: number, tier: "lower" | "owner"): boolean {
	return (
		Number.isSafeInteger(depth) &&
		depth >= 1 &&
		Number.isSafeInteger(value) &&
		value >= 1 &&
		value <= 5 &&
		(tier === "owner" || depth + value - 1 <= 11)
	);
}
function inWindow(at: number, now: number): boolean | "clock_untrusted" {
	if (!Number.isSafeInteger(at) || !Number.isSafeInteger(now) || at < 0 || at > now) return "clock_untrusted";
	return now - at < policy.ordinary.rollingWindowMs;
}
interface AuthorityCase {
	tier: "lower" | "owner";
	actualSourceVerified: boolean;
	bindingMatches: boolean;
	currentSelectedHome?: boolean;
	selfApproval?: boolean;
	firstAnswer?: boolean;
}
function authorityExample(value: AuthorityCase): boolean {
	if (!value.actualSourceVerified || !value.bindingMatches || value.firstAnswer === false) return false;
	return value.tier === "owner" || (value.currentSelectedHome === true && value.selfApproval !== true);
}
function requestExample(outstanding: number, age: number, contextComplete: boolean, duplicate: boolean): string {
	if (!Number.isSafeInteger(outstanding) || outstanding < 0 || !Number.isSafeInteger(age) || age < 0)
		return "invalid_input";
	if (duplicate) return "same_request_no_new_notification";
	if (!contextComplete) return "context_needed";
	if (age >= policy.request.lifetimeMs) return "expired";
	return outstanding >= policy.request.outstandingPerRequester ? "request_capacity" : "awaiting_approver";
}

function controlKey(value: GuardApprovalBinding, phase: "initial" | "decision"): string {
	return JSON.stringify([
		value.version,
		value.requestId,
		value.generation,
		value.requester,
		value.causal,
		value.scope,
		value.tier,
		value.quantity,
		value.upperHop,
		phase,
	]);
}

describe("message guard C — erased contract and shape laws", () => {
	it("emits no imports, expressions, initialization or exported values", () => {
		const emitted = transformSync(source, {
			loader: "ts",
			target: "es2022",
			format: "esm",
			tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
		}).code;
		expect(emitted.trim()).toMatch(/^(?:export\s*\{\s*\}\s*;?)?$/);
	});

	it("matches every exact frozen policy literal and no additional override", () => {
		// Exact equality (not only assignability) prevents optional fields and widened numeric policy.
		// The ordinary tsc tests gate enforces this; Vitest transpilation alone is NOT type proof.
		expectTypeOf<typeof policy>().toEqualTypeOf<GuardPolicyV1>();
		expect(policy.protected.bypass).toBe("depth_only");
	});

	it("pins all four parent documents and states the native blockers", () => {
		for (const hash of [
			"5d8433fd0a8f9a82103009e43491182caf14b80ad2a20b874709c5b3762724a9",
			"c8b8d6c109dcc7ed32187796b9785676dadea749085ce9819ba086194354e259",
			"ae4b1bbae8006f30085d006f40130b3aa445ba15b921021c7276349fcd8c3c0c",
			"47689efd821d201b46d6ba22d158b6e5adfac4e8d015cc6956371045ce98a86c",
		])
			expect(document).toContain(hash);
		for (const phrase of [
			"Branding is not",
			"durable first answer",
			"atomic legacy",
			"previous-reader accounting",
			"NOT tests of future runtime",
			"twenty-first is blocked",
			"DEPTH ONLY",
		])
			expect(document).toContain(phrase);
	});

	it("rejects forged verified facts, nonfinite choices and an agent Owner-answer path at type-check", () => {
		expectTypeOf<GuardActor>().not.toMatchTypeOf<GuardHostVerified<GuardActor>>();
		expectTypeOf<GuardQuantity>().toEqualTypeOf<1 | 2 | 3 | 4 | 5>();
		expectTypeOf<Extract<GuardUntrustedInput, { operation: "owner_answer" }>>().toEqualTypeOf<never>();
		// These negative fixtures are checked by the ordinary tsc tests gate, not Vitest transpilation.
		// @ts-expect-error No exported brand or structural minting authority.
		const forged: GuardHostVerified<GuardActor> = actor;
		// @ts-expect-error Unlimited or sixth-send approval is not in the contract.
		const excessive: GuardQuantity = 6;
		// @ts-expect-error Agents cannot inject an Owner response.
		const invented: GuardUntrustedInput = { operation: "owner_answer" };
		void [forged, excessive, invented];
	});

	it("separates unknown persistence, authoritative absence, accepted and handled/wake states", () => {
		expectTypeOf<Extract<GuardCommitResult, { state: "unknown" }>["reservation"]>().toEqualTypeOf<"held">();
		expectTypeOf<Extract<GuardResult, { state: "unknown" }>["retry"]>().toEqualTypeOf<"query_same_identity_only">();
		expectTypeOf<Extract<GuardResult, { state: "blocked" }>["accepted"]>().toEqualTypeOf<false>();
		expectTypeOf<Extract<GuardLookupResult, { state: "absent" }>["authoritative"]>().toEqualTypeOf<true>();
		expectTypeOf<Extract<GuardStatusResult, { state: "absent" }>["authoritative"]>().toEqualTypeOf<true>();
		expectTypeOf<GuardOutboxState>().toEqualTypeOf<
			"committed" | "held" | "dispatching" | "dispatched" | "handled" | "failed" | "unknown"
		>();
		expectTypeOf<GuardProtectedNotice["grantsActionAuthority"]>().toEqualTypeOf<false>();
		expectTypeOf<Extract<GuardCommand, { kind: "control_send" }>>().not.toMatchTypeOf<{ text: string }>();
		expectTypeOf<Extract<GuardAuthority, { tier: "owner" }>["source"]["kind"]>().toEqualTypeOf<
			"authenticated_browser" | "authorised_owner_telegram"
		>();
	});

	it("preserves the original legacy incoming anchor across approval control phases", () => {
		const initial = controlKey(binding, "initial");
		const decision = controlKey(binding, "decision");
		expect(initial).not.toBe(decision);
		expect(initial).toContain("legacy-incoming");
		expect(decision).toContain("boundary-exact-incoming");
		expect(controlKey(binding, "decision")).toBe(decision);
		for (const changed of [
			{ ...binding, generation: "generation-2" },
			{ ...binding, scope: { ...binding.scope, operation: "different-operation" } },
			{ ...binding, requester: { ...actor, runtimeIncarnation: "new-incarnation" } },
			{ ...binding, causal: { ...binding.causal, nextHop: 1 } },
		])
			expect(controlKey(changed, "decision")).not.toBe(decision);
		expect(binding.causal.kind).toBe("legacy_boundary");
		if (binding.causal.kind === "legacy_boundary") expect(binding.causal.historicalRoot).toBe("unknown");
	});

	it("old-reader shape carries new words above six and preserves original ordinary accounting", () => {
		const accepted: GuardLegacyAcceptedMessage = {
			id: "synthetic-accepted-12",
			at: 100000,
			from: { role: actor.role, title: "Example", chat: "home chat", file: actor.sessionFile },
			to: { role: "example-peer", title: "Peer" },
			kind: "fyi",
			chain: 12,
			text: "Synthetic fixed native notice",
			state: "waiting",
			sends: 0,
			attempts: 0,
			forOwner: true,
			ownerIds: ["synthetic-owner-message"],
			initiative: "synthetic-initiative",
		};
		expectTypeOf<GuardLegacyAcceptedMessage>().toMatchTypeOf<RoleMessageRecord>();
		const previousReaderShape: RoleMessageRecord = JSON.parse(JSON.stringify(accepted));
		expect(previousReaderShape).toEqual(accepted);
		expect(previousReaderShape.chain).toBe(12);
		expect(previousReaderShape.kind).not.toBe("report");
		expect(inWindow(previousReaderShape.at, previousReaderShape.at + 3599999)).toBe(true);
		expect(inWindow(previousReaderShape.at, previousReaderShape.at + 3600000)).toBe(false);
		// Shape proof only. Actual old loader/crash/rollback proof remains E/V/I's blocker.
	});

	it("operation identity is separate from mutable delivery state", () => {
		const identity: GuardOperationIdentity = {
			operationId: "synthetic-operation",
			fingerprint: "exact-input-digest",
			actor,
			version: policy.version,
		};
		expect(JSON.parse(JSON.stringify(identity))).toEqual(identity);
		expect(identity).not.toHaveProperty("delivery");
	});
});

describe("message guard C — fixed positive/negative law examples (not runtime acceptance)", () => {
	it.each(cases)("%s", (_name, input, wanted) => expect(lawExample(input)).toBe(wanted));

	it.each([
		[7, 5, "lower", true],
		[11, 1, "lower", true],
		[11, 2, "lower", false],
		[12, 1, "lower", false],
		[12, 5, "owner", true],
		[7, 0, "owner", false],
		[7, 6, "owner", false],
		[7, 1.5, "owner", false],
		[7, Number.POSITIVE_INFINITY, "owner", false],
		[0, 1, "owner", false],
		[Number.NaN, 1, "owner", false],
	] as const)("L1 quantity at hop %i, n=%s, tier=%s", (depth, quantity, tier, valid) => {
		expect(finiteQuantity(quantity, depth, tier)).toBe(valid);
	});

	it.each([
		[100000, 100000, true],
		[100000, 3699999, true],
		[100000, 3700000, false],
		[100001, 100000, "clock_untrusted"],
		[Number.NaN, 100000, "clock_untrusted"],
	] as const)("L5 rolling event at %i now %i", (at, now, counted) => expect(inWindow(at, now)).toBe(counted));

	it.each([
		[
			"selected current lower home",
			{ tier: "lower", actualSourceVerified: true, bindingMatches: true, currentSelectedHome: true },
			true,
		],
		[
			"task/subagent/old home is not current",
			{ tier: "lower", actualSourceVerified: true, bindingMatches: true, currentSelectedHome: false },
			false,
		],
		[
			"COO cannot self-grant",
			{
				tier: "lower",
				actualSourceVerified: true,
				bindingMatches: true,
				currentSelectedHome: true,
				selfApproval: true,
			},
			false,
		],
		[
			"source string/cast not actual Owner",
			{ tier: "owner", actualSourceVerified: false, bindingMatches: true },
			false,
		],
		["exact native Owner answer", { tier: "owner", actualSourceVerified: true, bindingMatches: true }, true],
		[
			"question/generation/choices mismatch",
			{ tier: "owner", actualSourceVerified: true, bindingMatches: false },
			false,
		],
		[
			"later conflicting transport answer",
			{ tier: "owner", actualSourceVerified: true, bindingMatches: true, firstAnswer: false },
			false,
		],
	] satisfies Array<[string, AuthorityCase, boolean]>)("L3 authority %s", (_name, value, approved) => {
		expect(authorityExample(value)).toBe(approved);
	});

	it.each([
		[19, 0, true, false, "awaiting_approver"],
		[20, 0, true, false, "request_capacity"],
		[19, 86399999, true, false, "awaiting_approver"],
		[19, 86400000, true, false, "expired"],
		[0, 0, false, false, "context_needed"],
		[20, 0, true, true, "same_request_no_new_notification"],
		[-1, 0, true, false, "invalid_input"],
		[0, -1, true, false, "invalid_input"],
	] as const)(
		"L4 bounded request outstanding=%i age=%i complete=%s duplicate=%s",
		(count, age, complete, duplicate, state) => {
			expect(requestExample(count, age, complete, duplicate)).toBe(state);
		},
	);

	it("L6 byte bounds are UTF-8, not character-count truncation", () => {
		expect(Buffer.byteLength("界".repeat(682), "utf8")).toBe(2046);
		expect(Buffer.byteLength("界".repeat(683), "utf8")).toBe(2049);
	});
});
