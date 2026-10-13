import { pins } from "./pins.mjs";

// This is a declarative golden corpus, not an admission algorithm. All quantities/outcomes
// below were chosen from the pinned Owner policy. Helpers only copy literal observations.
export const zeroEffects = Object.freeze({
	legacyAppends: 0, ordinaryUses: 0, grantUses: 0,
	protectedOriginUses: 0, protectedDestinationUses: 0, protectedSystemUses: 0, newIncidentUses: 0,
	dispatches: 0, wakes: 0, actionStarts: 0, queueStarts: 0, questionClears: 0,
	readerResumes: 0, judgeResumes: 0, scopeExpansions: 0, holdChanges: 0,
	fallbacks: 0, interruptions: 0, batchingTimers: 0, prunedActive: 0, bodyCaptures: 0,
});
const expect = (state, facts = {}, effects = {}) => ({ state, ...facts, effects: { ...zeroEffects, ...effects } });
const blocked = (reason, facts = {}) => expect("blocked", { reason, ...facts });
const recorded = (requestState, facts = {}) => expect("recorded", { requestState, ...facts });
const business = (uses = 0, facts = {}) => expect("accepted", { class: "business", ...facts },
	{ legacyAppends: 1, ordinaryUses: 1, grantUses: uses });
const control = (facts = {}) => expect("accepted", { class: "control", ...facts }, { legacyAppends: 1, ordinaryUses: 1 });
const protectedSend = (newIncidentUses = 1, facts = {}) => expect("accepted", { class: "protected", ...facts }, {
	legacyAppends: 1, ordinaryUses: 1, protectedOriginUses: 1,
	protectedDestinationUses: 1, protectedSystemUses: 1, newIncidentUses,
});
const base = {
	clock: { nowMs: 1800000000000, lastObservedMs: 1800000000000, state: "trusted" },
	actor: { role: "role-a", session: "$sandbox/a.jsonl", task: "home", currentHome: true },
	causal: { rootId: "root-A", parentId: "parent-A", nextHop: 7, source: "native_incoming" },
	scope: { id: "scope-A", operation: "sealed_continuation", participants: ["role-a", "role-b"], recipients: ["role-b"] },
	ordinaryCount: 0, grant: null, operationId: "operation-A", destination: "role-b",
	businessKind: "fyi", sourceRevision: "source-1", dispatchBarrier: "explicit_step_only",
	retention: "finite_registered_configuration", transport: "sealed_recording_only",
};
const list = [];
function add(id, needs, setup, expected, command = { op: "send" }, area = "ordinary") {
	list.push({ id, needs, area, input: { ...structuredClone(base), ...setup }, steps: [{ command, expected }] });
}
function sequence(id, needs, setup, steps, area = "ordinary") {
	list.push({ id, needs, area, input: { ...structuredClone(base), ...setup }, steps });
}
const lower = { tier: "lower", quantity: 5, upperHop: 11, uses: 0, ageMs: 0, state: "approved", source: "selected_current_coo_home" };
const owner = { tier: "owner", quantity: 5, upperHop: 16, uses: 0, ageMs: 0, state: "approved", source: "authenticated_browser_answer" };
const incident = { producer: "registered_native", episode: "episode-A", generation: "episode-1", assignedRole: "role-b",
	origin: "role-a", resource: "resource-A", ageMs: 0, source: "verified_immutable_record", category: "security", type: "critical_risk_notice" };

for (const hop of [1, 6]) add(`ordinary-hop-${hop}`, ["P01", "P05"], { causal: { ...base.causal, nextHop: hop } }, business());
for (const hop of [7, 11]) add(`no-grant-hop-${hop}`, ["P01", "R01"], { causal: { ...base.causal, nextHop: hop } }, blocked("approval_required", { requiredTier: "lower" }));
for (const hop of [12, 17]) add(`owner-required-hop-${hop}`, ["P01"], { causal: { ...base.causal, nextHop: hop } }, blocked("approval_required", { requiredTier: "owner" }));
for (const hop of [7, 11]) add(`lower-hop-${hop}`, ["P01", "P02"], { causal: { ...base.causal, nextHop: hop }, grant: lower }, business(1, { preservedHop: hop }));
add("lower-cannot-hop12", ["P01", "P02"], { causal: { ...base.causal, nextHop: 12 }, grant: lower }, blocked("approval_required", { requiredTier: "owner" }));
for (const hop of [12, 16]) add(`owner-hop-${hop}`, ["P01", "P02", "A04"], { causal: { ...base.causal, nextHop: hop }, grant: owner }, business(1, { preservedHop: hop }));
add("owner-upperhop17", ["P02"], { causal: { ...base.causal, nextHop: 17 }, grant: owner }, blocked("approval_required", { requiredTier: "owner" }));
add("owner-allowed-before12", ["P01"], { grant: { ...owner, upperHop: 11 } }, business(1));
add("lower-at11-offers-one", ["P02", "R05"], { causal: { ...base.causal, nextHop: 11 } }, recorded("awaiting_approver", { offeredQuantities: [1], upperHop: 11 }), { op: "complete_request", quantity: 1 });
add("lower-at11-rejects-five", ["P02"], { causal: { ...base.causal, nextHop: 11 } }, blocked("invalid_input"), { op: "complete_request", quantity: 5 });
for (const quantity of [0, 6, -1, 1.5, "5", "unlimited"]) add(`invalid-quantity-${String(quantity).replace(".", "_")}`, ["P02", "P05"], {}, blocked("invalid_input"), { op: "complete_request", quantity });
sequence("five-shared-same-hop-fanout", ["P02", "D02"], { grant: lower, scope: { ...base.scope, recipients: ["role-b", "role-c"] } }, [
	{ command: { op: "send", operation: "use-1", to: "role-b" }, expected: business(1, { remainingUses: 4, preservedHop: 7 }) },
	{ command: { op: "send", operation: "use-2", to: "role-c", actor: "role-b" }, expected: business(1, { remainingUses: 3, preservedHop: 7 }) },
	{ command: { op: "send", operation: "use-3", to: "role-b" }, expected: business(1, { remainingUses: 2, preservedHop: 7 }) },
	{ command: { op: "send", operation: "use-4", to: "role-c" }, expected: business(1, { remainingUses: 1, preservedHop: 7 }) },
	{ command: { op: "send", operation: "use-5", to: "role-b" }, expected: business(1, { remainingUses: 0, preservedHop: 7 }) },
	{ command: { op: "send", operation: "use-6", to: "role-c" }, expected: blocked("grant_exhausted") },
]);
for (const [label, delta, reason] of [
	["denied", { state: "denied" }, "grant_denied"], ["exhausted", { uses: 5, state: "exhausted" }, "grant_exhausted"],
	["revoked", { state: "revoked" }, "grant_revoked"], ["expired", { ageMs: 3600000 }, "grant_expired"],
	["wrong-version", { version: "role-message-guard/v0" }, "scope_mismatch"],
	["wrong-generation", { generation: "old-generation" }, "scope_mismatch"],
	["wrong-root", { root: "root-B" }, "scope_mismatch"], ["wrong-parent", { parent: "parent-B" }, "scope_mismatch"],
	["wrong-hop", { expectedHop: 6 }, "scope_mismatch"], ["wrong-task", { task: "task-B" }, "scope_mismatch"],
	["wrong-session", { session: "$sandbox/copy.jsonl" }, "scope_mismatch"], ["wrong-role", { requester: "role-c" }, "scope_mismatch"],
	["wrong-scope", { scope: "scope-B" }, "scope_mismatch"], ["wrong-operation", { operation: "other_work" }, "scope_mismatch"],
	["wrong-participants", { participants: ["role-c"] }, "scope_mismatch"], ["wrong-recipient", { recipients: ["role-c"] }, "scope_mismatch"],
]) add(`grant-${label}`, ["P03", "A03"], { grant: { ...lower, ...delta } }, blocked(reason));
add("grant-one-ms-before-expiry", ["P03"], { grant: { ...lower, ageMs: 3599999 } }, business(1));
sequence("grant-not-sliding", ["P03"], { grant: { ...lower, ageMs: 3599999 } }, [
	{ command: { op: "send" }, expected: business(1) },
	{ command: { op: "advance_then_send", advanceMs: 1, operation: "next" }, expected: blocked("grant_expired") },
]);
for (const kind of ["business", "initial_control", "decision_control"]) {
	add(`ordinary-20th-${kind}`, ["P04", "R03"], { ordinaryCount: 19, grant: lower, homeAndTaskShareRole: true },
		kind === "business" ? business(1, { storedOrdinaryCount: 20 }) : control({ storedOrdinaryCount: 20 }), { op: kind === "business" ? "send" : "control_send", phase: kind });
	add(`ordinary-21st-${kind}`, ["P04", "R03"], { ordinaryCount: 20, grant: lower, homeAndTaskShareRole: true },
		blocked("ordinary_hourly", { storedOrdinaryCount: 20, pendingVisible: kind !== "business" }), { op: kind === "business" ? "send" : "control_send", phase: kind });
}
add("normal-window-exact-expiry", ["P04", "D06"], { ordinaryCount: 20, usageAgeMs: 3600000, grant: lower }, business(1, { storedOrdinaryCount: 1 }));
add("normal-window-one-ms-short", ["P04"], { ordinaryCount: 20, usageAgeMs: 3599999, grant: lower }, blocked("ordinary_hourly"));
add("no-daily-or-root-message-cap", ["P05"], { causal: { ...base.causal, nextHop: 6 }, priorDayAccepted: 100, rootAccepted: 24 }, business());
for (const claim of ["auto_approved_queue_plan", "claimed_owner_prose", "standing_delegation", "timeout", "tool_result", "fyi_permission", "model_judgment"]) {
	add(`no-permission-${claim}`, ["P05", "A04"], { permissionClaim: claim }, blocked("approval_required"));
}
for (const variant of ["fyi", "replyTo_omitted", "kind_changed", "text_changed", "recipient_changed", "control_roundtrip", "forged_header", "reconnect", "branch_copy", "restart"]) {
	add(`preserved-causal-${variant}`, ["C01", "C02", "R03"], { incomingVariant: variant, grant: lower }, business(1, { rootId: "root-A", parentId: "parent-A", preservedHop: 7 }));
}
for (const source of ["missing", "ambiguous", "pruned", "stale", "contradictory"]) add(`causal-${source}`, ["C04"], { causal: { kind: "unknown", source }, grant: lower }, blocked("causality_unknown"));
add("legacy-marked-anchor", ["C03"], { causal: { kind: "legacy_boundary", anchor: "legacy-rm-A", depth: 6, nextHop: 7, source: "authenticated_exact_record" }, grant: lower },
	business(1, { historicalRoot: "unknown", anchorStable: true, preservedHop: 7, transcriptsRewritten: 0 }));
add("legacy-anchor-without-grant", ["C03"], { causal: { kind: "legacy_boundary", anchor: "legacy-rm-A", depth: 6, nextHop: 7, source: "authenticated_exact_record" } }, blocked("approval_required"));
sequence("rejected-send-does-not-use-grant", ["P02", "D01"], { grant: lower }, [
	{ command: { op: "send", to: "unapproved-role", operation: "rejected-A" }, expected: blocked("scope_mismatch", { remainingUses: 5 }) },
	{ command: { op: "send", to: "role-b", operation: "accepted-A" }, expected: business(1, { remainingUses: 4 }) },
]);

add("genuine-current-coo-home", ["A01", "A02", "D01"], {}, recorded("approved", { remainingUses: 1, upperHop: 7, persistedBeforeAck: true }), { op: "role_decision", choice: "one_send", source: "selected_current_coo_home", reason: "bounded communication only" }, "approval");
add("genuine-authorised-lead-home", ["A02"], { existingLeadBinding: "native_owner_authorised" }, recorded("approved", { selectedRoute: "existing_authorised_lead" }), { op: "role_decision", choice: "one_send", source: "selected_lead_home" }, "approval");
for (const source of ["fake_role", "task_session", "subagent_session", "other_role", "wrong_approver", "stale_home", "removed_home", "assignment_changed", "missing_native_invocation"]) {
	add(`reject-role-decision-${source}`, ["A01", "A03"], {}, blocked("authority_unavailable"), { op: "role_decision", choice: "one_send", source }, "approval");
}
for (const leadClaim of ["task_text", "title", "caller_field", "initiative_tag", "tracking_proposal"]) add(`coo-not-inferred-lead-${leadClaim}`, ["A02"], { leadClaim }, recorded("awaiting_approver", { selectedRole: "coo", selectedRoute: "coo" }), { op: "complete_request", quantity: 1 }, "approval");
add("coo-self-request-owner", ["A02"], { actor: { ...base.actor, role: "coo" } }, recorded("awaiting_owner", { selectedTier: "owner" }), { op: "complete_request", quantity: 1 }, "approval");
for (const source of ["authenticated_browser", "authorised_owner_telegram"]) add(`genuine-owner-${source}`, ["A04", "P04", "D01"], { causal: { ...base.causal, nextHop: 12 } },
	recorded("approved", { remainingUses: 5, upperHop: 16, persistedBeforeAck: true, ownerVisibility: true, sourceChannel: source }), { op: "owner_answer", choice: "requested_quantity", source }, "approval");
for (const source of ["from_browser_string", "forOwner_flag", "ownerChannel_flag", "copied_decision_id", "coo_statement", "auto_approve", "recovered_transcript", "model_parameter", "unauthorised_telegram_plugin", "unauthenticated_browser", "wrong_question", "wrong_generation", "wrong_choices_digest", "arbitrary_typed_prose"]) {
	add(`reject-owner-${source}`, ["A04", "P05"], { causal: { ...base.causal, nextHop: 12 } }, blocked("authority_unavailable"), { op: "owner_answer", choice: "requested_quantity", source }, "approval");
}
for (const mode of ["browser_then_telegram", "telegram_then_browser", "browser_reconnect", "simultaneous_browser_telegram", "simultaneous_lower_decisions", "restart_after_first_answer"]) {
	add(`first-answer-${mode}`, ["A05", "D02", "D03"], {}, recorded("denied", { firstAnswer: "deny", effectiveDecisions: 1, subsequentAnswerChangedDecision: false, durableDecision: true }),
		{ op: "answer_sequence", mode, first: "deny", later: "requested_quantity" }, "approval");
}
for (const route of ["unsupported_engine", "unguarded_tool_alias", "caller_owner_operation"]) add(`unsupported-caller-${route}`, ["A06", "I01"], { callerRoute: route }, blocked("authority_unavailable"), { op: "caller_probe" }, "approval");

sequence("approval-no-business-replay", ["R01", "R03"], {}, [
	{ command: { op: "send" }, expected: blocked("approval_required") },
	{ command: { op: "complete_request", quantity: 1 }, expected: recorded("awaiting_approver") },
	{ command: { op: "role_decision", source: "selected_current_coo_home", choice: "one_send" }, expected: recorded("approved", { autoReplayed: false }) },
	{ command: { op: "fresh_explicit_send", operation: "fresh-A" }, expected: business(1, { rootId: "root-A", preservedHop: 7 }) },
	{ command: { op: "fresh_explicit_send", operation: "fresh-B" }, expected: blocked("grant_exhausted") },
], "approval");
for (const depth of [6, 11]) add(`control-path-depth-${depth}`, ["R03", "C01"], { causal: { ...base.causal, nextHop: depth + 1 } }, control({ businessRootUnchanged: true, recursiveApprovals: 0 }), { op: "control_send", phase: "initial" }, "approval");
add("control-arbitrary-work-rejected", ["R03"], {}, blocked("invalid_input"), { op: "control_send", arbitraryWorkBody: true }, "approval");
add("request-context-incomplete", ["R05", "R06"], {}, recorded("context_needed", { notificationCount: 0 }), { op: "complete_request", context: "empty" }, "approval");
add("full-lower-context", ["R05"], {}, recorded("awaiting_approver", { nativeFactsDistinctFromClaims: true, contextComplete: true, genericContinue: false }), { op: "complete_request", context: "all_required_fields", quantity: 5 }, "approval");
add("full-owner-detail-choices", ["R05", "A04"], { causal: { ...base.causal, nextHop: 12 } }, recorded("awaiting_owner", { detailComplete: true, choices: ["deny", "one_send", "requested_quantity"], requestedQuantity: 5, grantsWorkOrSpend: false, clippedFields: 0 }), { op: "complete_request", context: "all_required_fields", quantity: 5 }, "approval");
add("request-20th-outstanding", ["R02"], { outstandingRequests: 19 }, recorded("awaiting_approver", { outstandingRequests: 20 }), { op: "complete_request", quantity: 1 }, "approval");
add("request-21st-outstanding", ["R02"], { outstandingRequests: 20 }, blocked("request_capacity", { outstandingRequests: 20 }), { op: "complete_request", quantity: 1 }, "approval");
add("request-generation-dedup", ["R02"], { sameOpenGeneration: true }, recorded("awaiting_approver", { sameRequestIdentity: true, newRequests: 0 }), { op: "complete_request", quantity: 1 }, "approval");
add("request-expiry-not-authority", ["P05", "R04"], { requestAgeMs: 86400000 }, recorded("expired", { grantsIssued: 0, escalations: 0 }), { op: "status" }, "approval");
sequence("control-notification-dedup", ["R02", "R03", "W02"], {}, [
	{ command: { op: "control_send", phase: "initial" }, expected: control() },
	{ command: { op: "control_send", phase: "initial" }, expected: expect("accepted", { class: "control", sameIdentity: true }) },
	{ command: { op: "control_send", phase: "decision" }, expected: control() },
	{ command: { op: "control_send", phase: "decision" }, expected: expect("accepted", { class: "control", sameIdentity: true }) },
], "approval");
add("rate-limited-control-once-after-expiry", ["R03", "P04"], { pendingControl: true, ordinaryCount: 20, usageAgeMs: 3600000 }, control({ newRequests: 0, sameControlIdentity: true, businessReplayed: false }), { op: "dispatch_pending_control" }, "approval");
add("explicit-owner-escalation-once", ["R04"], {}, recorded("awaiting_owner", { upwardEscalations: 1 }), { op: "role_decision", source: "selected_current_coo_home", choice: "escalate_owner" }, "approval");
add("second-escalation-no-loop", ["R04"], { upwardEscalations: 1 }, blocked("duplicate_slot", { upwardEscalations: 1 }), { op: "role_decision", choice: "escalate_owner" }, "approval");
add("no-timer-escalation", ["R04", "P05"], { requestAgeMs: 60000 }, recorded("awaiting_approver", { upwardEscalations: 0 }), { op: "advance_and_status", advanceMs: 60000 }, "approval");
add("new-generation-only-explicit", ["R04"], { priorGeneration: "generation-A" }, recorded("awaiting_approver", { generation: "generation-B", automaticGenerations: 0 }), { op: "complete_request", explicitGeneration: "generation-B", quantity: 1 }, "approval");
for (const state of ["context_needed", "awaiting_approver", "awaiting_owner", "rate_limited", "held", "approved", "denied", "expired", "exhausted", "revoked", "unknown"]) add(`status-${state}`, ["R06"], { seededRequestState: state }, expect("observed", { displayedState: state, leadPendingShownAsOwner: false }), { op: "inspect_status_ui" }, "ui");

for (const type of ["safety_action_notice", "critical_risk_notice", "safety_action_result"]) {
	for (const hop of [6, 11, 12, 17]) add(`protected-${type}-hop${hop}`, ["U01", "U02", "U11", "W03"], {
		causal: { ...base.causal, nextHop: hop }, incident: { ...incident, type }, initialAlreadyAccepted: type === "safety_action_result",
	}, protectedSend(type === "safety_action_result" ? 0 : 1, { rootId: "root-A", parentId: "parent-A", preservedHop: hop, grantsActionAuthority: false }), { op: "protected_send" }, "protected");
	add(`protected-${type}-ordinary21`, ["U02", "U07"], { ordinaryCount: 20, incident: { ...incident, type }, initialAlreadyAccepted: type === "safety_action_result" }, blocked("ordinary_hourly"), { op: "protected_send" }, "protected");
	add(`protected-${type}-ordinary20`, ["U02"], { ordinaryCount: 19, incident: { ...incident, type }, initialAlreadyAccepted: type === "safety_action_result" }, protectedSend(type === "safety_action_result" ? 0 : 1, { storedOrdinaryCount: 20 }), { op: "protected_send" }, "protected");
	add(`protected-${type}-normal-expiry`, ["U02", "D06"], { ordinaryCount: 20, usageAgeMs: 3600000, incident: { ...incident, type }, initialAlreadyAccepted: type === "safety_action_result" }, protectedSend(type === "safety_action_result" ? 0 : 1), { op: "protected_send" }, "protected");
}
add("ordinary-response-no-inherited-protection", ["U01", "C01"], { incomingProtected: true, causal: { ...base.causal, nextHop: 12 } }, blocked("approval_required", { requiredTier: "owner" }));
for (const type of ["fyi", "status", "new_work", "continuation_control"]) add(`no-urgency-inheritance-${type}`, ["U01", "U09"], { suppliedUrgentFlag: true, businessKind: type }, blocked("incident_unavailable"), { op: "protected_send" }, "protected");
for (const category of ["security", "data_loss", "data_integrity", "enforced_spend_guard"]) add(`native-category-${category}`, ["U08", "U12"], { incident: { ...incident, category } }, protectedSend(), { op: "protected_send" }, "protected");
for (const actionState of ["required", "accepted", "underway"]) add(`safety-information-${actionState}`, ["U11", "W03"], { incident: { ...incident, type: "safety_action_notice", actionState } }, protectedSend(1, { actionCompleted: false, grantsActionAuthority: false }), { op: "protected_send" }, "protected");
for (const outcome of ["succeeded", "failed", "indeterminate"]) add(`terminal-result-${outcome}`, ["U03", "U11", "W05"], { incident: { ...incident, type: "safety_action_result", outcome }, initialAlreadyAccepted: true }, protectedSend(0, { outcome, permitsRetry: false, userAcknowledged: false }), { op: "protected_send" }, "protected");
for (const flaw of ["agent_minted", "client_receipt", "same_caller_hmac", "shell_success", "tool_call_id_only", "copied_owner_decision", "generic_human_cancel", "ordinary_failure", "prediction", "mutable_log", "prose_severity", "missing_producer", "unsupported_producer", "unsupported_category", "stale_source", "dead_source", "missing_hash", "hash_mismatch", "incarnation_mismatch", "generation_mismatch", "reordered_source", "contradictory_source", "permission_revoked", "caller_selected_recipient", "resource_owner_changed", "wrong_action", "unauthorised_action", "unverifiable_terminal", "indeterminate_claimed_success"]) {
	add(`ineligible-protected-${flaw}`, ["U08", "U09", "U10", "U12"], { incident: { ...incident, flaw } }, blocked("incident_unavailable"), { op: "protected_send" }, "protected");
}
for (const relabel of ["risk_to_safety", "second_initial", "changed_text", "fresh_ticket", "changed_role", "different_tool", "replacement_process", "second_terminal"]) add(`episode-no-reset-${relabel}`, ["U03", "U05"], { incident, relabel, usedSlot: relabel === "second_terminal" ? "terminal" : "initial" }, blocked("duplicate_slot"), { op: "protected_send" }, "protected");
add("incident-at24h-expired", ["U05"], { incident: { ...incident, ageMs: 86400000 } }, blocked("incident_unavailable"), { op: "protected_send" }, "protected");
add("incident-expired-tombstone-not-fresh", ["U05", "D05"], { incident, tombstone: "expired_episode_A", relabel: "new_ticket_after_expiry" }, blocked("duplicate_slot"), { op: "protected_send" }, "protected");
for (const [cap, below, at, reason] of [
	["newIncidentsOrigin", 1, 2, "incident_origin_hourly"], ["protectedOrigin", 3, 4, "protected_origin_hourly"],
	["protectedDestination", 3, 4, "protected_destination_hourly"], ["protectedSystem", 11, 12, "protected_system_hourly"],
	["liveIncidents", 11, 12, "incident_capacity"],
]) {
	add(`protected-boundary-${cap}-last`, ["U04"], { incident, capacity: { [cap]: below } }, protectedSend(), { op: "protected_send" }, "protected");
	add(`protected-boundary-${cap}-excess`, ["U04"], { incident, capacity: { [cap]: at } }, blocked(reason, { boundedOverflow: true }), { op: "protected_send" }, "protected");
}
for (const [cap, count, reason] of [["newIncidentsOrigin", 2, "incident_origin_hourly"], ["protectedOrigin", 4, "protected_origin_hourly"], ["protectedDestination", 4, "protected_destination_hourly"], ["protectedSystem", 12, "protected_system_hourly"]]) {
	add(`protected-window-${cap}-one-ms-short`, ["U04", "D06"], { incident, capacity: { [cap]: count }, capacityAgeMs: 3599999 }, blocked(reason), { op: "protected_send" }, "protected");
	add(`protected-window-${cap}-exact-expiry`, ["U04", "D06"], { incident, capacity: { [cap]: count }, capacityAgeMs: 3600000 }, protectedSend(), { op: "protected_send" }, "protected");
}
add("pending-incidents-count-live", ["U04"], { incident, capacity: { liveIncidents: 12 }, liveIncludesPending: true }, blocked("incident_capacity"), { op: "protected_send" }, "protected");
add("terminal-one-ms-before-incident-expiry", ["U03", "U05"], { incident: { ...incident, type: "safety_action_result", ageMs: 86399999 }, initialAlreadyAccepted: true }, protectedSend(0, { episodeExpiryNotExtended: true }), { op: "protected_send" }, "protected");
for (const boundary of ["ordinary", "protectedOrigin", "protectedDestination", "protectedSystem"]) add(`late-result-no-credit-${boundary}`, ["U07"], { incident: { ...incident, type: "safety_action_result" }, resultStorageReserved: true, initialAlreadyAccepted: true, exhaustedCurrentCapacity: boundary },
	blocked({ ordinary: "ordinary_hourly", protectedOrigin: "protected_origin_hourly", protectedDestination: "protected_destination_hourly", protectedSystem: "protected_system_hourly" }[boundary], { resultStorageStillReserved: true, resultDeliveryCredit: false }), { op: "protected_send" }, "protected");
add("complete-template-2048-bytes", ["U06"], { incident, renderedFixture: "fixed_native_utf8_exact_2048" }, protectedSend(1, { renderedBytes: 2048, clippedFields: 0, fixedTemplate: true }), { op: "protected_send" }, "protected");
for (const body of ["fixed_native_utf8_2049", "multibyte_1025_chars_2050_bytes", "caller_body", "attachment", "executable_instruction", "broadcast_list", "clipped_scope", "clipped_unknown", "clipped_authority"]) add(`bad-template-${body}`, ["U06"], { incident, renderedFixture: body }, blocked(body.includes("2049") || body.includes("2050") ? "notice_too_large" : "invalid_input"), { op: "protected_send" }, "protected");

for (const path of ["business", "control", "protected"]) {
	for (const hold of ["ownerPaused", "roleDeliveryPaused", "wakesDisabled", "accessDenied", "scopeDenied", "spendingOrConsentDenied", "queueOrSessionMismatch", "sourcePermissionRevoked"]) {
		add(`hold-${path}-${hold}`, ["W01", "W03"], { grant: lower, incident, holds: { [hold]: true } }, blocked("held", { visibleReadOnly: true }), { op: path === "protected" ? "protected_send" : path === "control" ? "control_send" : "send" }, path === "protected" ? "protected" : "ordinary");
	}
}
for (const hold of ["ownerPaused", "roleDeliveryPaused", "wakesDisabled", "accessDenied", "spendingOrConsentDenied", "queueOrSessionMismatch", "sourcePermissionRevoked"]) add(`dispatch-revalidate-${hold}`, ["W01", "U10"], { previouslyCommitted: true, incident, holdsAtDispatch: { [hold]: true } }, expect("held", { originalAcceptancePreserved: true }), { op: "dispatch" }, "delivery");
for (const change of ["stale_source", "incarnation_mismatch", "ownership_changed", "permission_revoked"]) add(`dispatch-source-${change}`, ["U10", "W05"], { previouslyCommitted: true, incident, dispatchSourceChange: change }, expect("held", { originalAcceptancePreserved: true, alternateRecipient: false }), { op: "dispatch" }, "delivery");
add("idle-native-dispatch-wake", ["W02", "W03", "W05"], { previouslyCommitted: true, businessKind: "request" }, expect("dispatched", { handled: false, userAcknowledged: false, artificialDelayMs: 0 }, { dispatches: 1, wakes: 1 }), { op: "dispatch" }, "delivery");
sequence("busy-delivery-after-turn-no-batching", ["W02", "W04"], { previouslyCommitted: true, businessKind: "request", targetBusy: true }, [
	{ command: { op: "dispatch" }, expected: expect("held", { afterCurrentTurn: true }) },
	{ command: { op: "finish_current_turn_and_dispatch" }, expected: expect("dispatched", { artificialDelayMs: 0 }, { dispatches: 1, wakes: 1 }) },
	{ command: { op: "reconnect_and_dispatch_same_receipt" }, expected: expect("dispatched", { sameDispatchKey: true, sameWakeKey: true }) },
], "delivery");
add("unknown-dispatch-no-blind-retry", ["D03", "W05"], { previouslyCommitted: true, transportOutcome: "unknown" }, expect("unknown", { reservation: "held", retry: "query_same_identity_only", accountingRetained: true }, { dispatches: 1 }), { op: "dispatch" }, "delivery");
add("failed-delivery-keeps-accounting", ["W05"], { previouslyCommitted: true, transportOutcome: "failed" }, expect("failed", { accountingRetained: true, actionCompleted: false }, { dispatches: 1 }), { op: "dispatch" }, "delivery");
add("fyi-native-note-without-turn", ["W02", "I03"], { previouslyCommitted: true, businessKind: "fyi" }, expect("dispatched", { noteOnly: true, handled: false }, { dispatches: 1 }), { op: "dispatch" }, "delivery");
add("completion-no-new-relay", ["W04"], { completionAlreadyNative: true }, expect("observed", { guardRelays: 0, completionDelayAddedMs: 0, nativeCompletionCount: 1 }), { op: "native_completion" }, "delivery");
add("old-rejected-notices-never-selected", ["W04"], { oldRejected: ["synthetic-FE32", "synthetic-H7", "synthetic-other"] }, expect("observed", { selectedOldRejected: 0 }), { op: "scan_pending_and_recover" }, "delivery");

add("concurrent-last-grant-use", ["D01", "D02", "P02"], { grant: { ...lower, uses: 4 } }, expect("observed", { winners: 1, losers: 1, loserReason: "grant_exhausted", remainingUses: 0 }, { legacyAppends: 1, ordinaryUses: 1, grantUses: 1 }), { op: "concurrent_send", contenders: 2 }, "durability");
for (const cap of ["ordinary", "protectedOrigin", "protectedDestination", "protectedSystem", "newIncidentsOrigin", "liveIncidents", "initialSlot", "terminalSlot"]) add(`concurrent-final-${cap}`, ["D02", "U03", "U04"], { incident: { ...incident, type: cap === "terminalSlot" ? "safety_action_result" : "critical_risk_notice" }, initialAlreadyAccepted: cap === "terminalSlot", boundaryOnlyOneRemaining: cap }, expect("observed", { winners: 1, losers: 1, distinctAcceptedIdentities: 1 }, { legacyAppends: 1, ordinaryUses: 1, protectedOriginUses: 1, protectedDestinationUses: 1, protectedSystemUses: 1, newIncidentUses: cap === "terminalSlot" ? 0 : 1 }), { op: "concurrent_protected_send", contenders: 2 }, "protected");
sequence("duplicate-tool-operation-id", ["D02", "P02"], { grant: lower }, [
	{ command: { op: "send" }, expected: business(1) },
	{ command: { op: "send" }, expected: expect("accepted", { class: "business", originalResultIdentity: true }) },
	{ command: { op: "send", changedFingerprint: true }, expected: blocked("identity_conflict") },
], "durability");
for (const failure of ["disk_full", "write", "rename", "flush"]) add(`persistence-failure-${failure}`, ["D01", "D04"], { grant: lower, failBeforeDurableCommit: failure }, blocked("persistence_unavailable", { successAcknowledged: false, uncommittedDispatches: 0 }), { op: "send" }, "durability");
for (const boundary of ["after_prepare", "commit_outcome_uncertain", "legacy_publication_uncertain", "outbox_publication_uncertain", "dispatch_outcome_uncertain", "wake_outcome_uncertain"]) add(`crash-unknown-${boundary}`, ["D03", "D04", "W05"], { grant: lower, crashBoundary: boundary }, expect("unknown", { reservation: "held", retry: "query_same_identity_only", syntheticRefunds: 0, blindResends: 0, speculativeGrants: 0 }), { op: "crash_recover_probe" }, "durability");
add("crash-reconciled-before_prepare", ["D01", "D03", "D04"], { grant: lower, crashBoundary: "before_prepare", recoveryProbeOnly: true }, expect("observed", { committedAcceptances: 0, heldReservations: 0, sameIdentityOnly: true, deterministicRecovery: true, syntheticRefunds: 0, duplicatedAcceptances: 0, duplicatedDispatches: 0, duplicatedWakes: 0 }), { op: "crash_recover_probe" }, "durability");
for (const boundary of ["after_commit_before_ack", "after_confirmed_dispatch", "after_confirmed_wake"]) add(`crash-reconciled-${boundary}`, ["D01", "D03", "D04"], { grant: lower, crashBoundary: boundary, recoveryProbeOnly: true }, expect("observed", { committedAcceptances: 1, retainedOrdinaryUses: 1, retainedGrantUses: 1, acceptedWordsPreserved: true, sameIdentityOnly: true, deterministicRecovery: true, syntheticRefunds: 0, duplicatedAcceptances: 0, duplicatedDispatches: 0, duplicatedWakes: 0, auditsPreserved: true }), { op: "crash_recover_probe" }, "durability");
add("crash-reconciled-after_decision_before_notification", ["A05", "D01", "D03"], { crashBoundary: "after_decision_before_notification", recoveryProbeOnly: true }, expect("observed", { effectiveDecisions: 1, durableDecision: true, firstAnswer: "one_send", remainingUses: 1, sameIdentityOnly: true, acceptedBusiness: 0, newNotifications: 0, businessReplayed: false, auditsPreserved: true }), { op: "crash_recover_probe" }, "durability");
for (const flaw of ["corrupt_journal", "reordered_replay", "missing_commit", "audit_only", "pruned_authority", "unknown_lookup", "unavailable_lookup"]) add(`recovery-${flaw}`, ["D04", "D05"], { recoveryFlaw: flaw }, expect("unknown", { continuationUnavailable: true, syntheticRefunds: 0, speculativeGrants: 0, reservation: "held" }), { op: "recover" }, "durability");
for (const clockState of ["rollback", "unknown"]) add(`clock-${clockState}`, ["D06"], { grant: lower, clock: { ...base.clock, state: clockState, nowMs: base.clock.nowMs - 1 } }, blocked("clock_untrusted", { quotaRefilled: false }), { op: "send" }, "durability");
for (const pool of ["requests", "grants", "transactions", "audits", "outbox", "usage", "tombstones", "contextBytes"]) add(`retention-finite-${pool}`, ["D05"], { selectedRetentionPoolAtMaximum: pool }, blocked("retention_capacity", { finiteSafeIntegerCaps: true, boundedOverflow: true }), { op: "attempt_growth" }, "durability");
add("retention-live-inflight-not-pruned", ["D05"], { liveGrant: true, inflightUnknown: true, sourceHorizon: "unknown" }, expect("observed", { expiredUnknownIdsInvalid: true, authoritativeSourceInvented: false, fullTranscriptsCaptured: 0 }), { op: "prune_and_replay" }, "durability");

add("actual-old-reader-postchange-preservation", ["L01", "I03"], { postchangeIncludes: ["ordinary", "control", "protected", "hop_12", "owner_browser", "owner_telegram"] }, expect("observed", { wordsIdsStatesMetadataPreserved: true, ordinaryAccountingSafe: true, grantsRetainedOutsideLegacyWriter: true, actualPreviousReader: pins.previousCommit }), { op: "candidate_old_reader_roundtrip" }, "rollback");
add("unsafe-old-reader-blocks-readiness", ["L01", "L03"], { candidateCompatibility: "unproved" }, blocked("compatibility_unproved", { deploymentAllowed: false }), { op: "readiness" }, "rollback");
for (const path of ["business", "protected"]) add(`rollback-hard6-${path}`, ["L02"], { grant: lower, incident, mode: "rollback_depth_6" }, blocked("rollback_depth"), { op: path === "protected" ? "protected_send" : "send" }, "rollback");
add("rollback-retains20hour", ["L02"], { causal: { ...base.causal, nextHop: 6 }, mode: "rollback_depth_6", ordinaryCount: 20 }, blocked("ordinary_hourly"), { op: "send" }, "rollback");
add("rollback-keeps-newer-words-counts-audits", ["L02"], { currentRecordsNewerThanSnapshot: true }, expect("observed", { wordsPreserved: true, acceptedIdsPreserved: true, usagePreserved: true, auditsPreserved: true, provenancePreserved: true, oldSnapshotRestored: false, grantsRevoked: true, protectionDisabled: true }), { op: "rollback" }, "rollback");
add("reinstall-no-grant-resurrection", ["L03"], { rolledBackOrExpiredGrants: true }, expect("observed", { grantsResurrected: 0, newDecisionsRequired: true, protectionRecreated: false }), { op: "reinstall_same_state" }, "rollback");
for (const original of ["synthetic-FE32-containment-terminal", "synthetic-H7-task-id-terminal"]) sequence(`counterfactual-new-${original}`, ["L04", "R01"], { original }, [
	{ command: { op: "send" }, expected: blocked("approval_required") },
	{ command: { op: "proper_explicit_grant", source: "selected_current_coo_home", choice: "one_send" }, expected: recorded("approved") },
	{ command: { op: "fresh_explicit_send", operation: "synthetic-terminal-new" }, expected: business(1) },
	{ command: { op: "fresh_explicit_send", operation: "synthetic-terminal-second" }, expected: blocked("grant_exhausted") },
], "counterfactual");
for (const view of ["desktop", "phone", "keyboard_focus", "accessibility", "browser_telegram_separation", "owner_retraction_refresh"]) add(`native-ui-${view}`, ["I02", "R05", "A04"], { sealedView: view }, expect("observed", { nativeQuestionAdapter: true, fullDetail: true, ownerVisibilityPreserved: true, channelSeparationPreserved: true, focusValid: true, accessibilityViolations: 0, extraRoleCharges: 0 }), { op: "native_ui_probe" }, "ui");
for (const regression of ["ordinary_delivery", "fyi_no_turn", "reports", "quiet_turns", "owner_visibility", "owner_transport", "queue_holds"]) add(`native-regression-${regression}`, ["I03"], { regression }, expect("observed", { priorBehaviorPreserved: true, noNewRelay: true }), { op: "sealed_native_regression" }, "regression");
for (const capability of ["native_owner_authentication", "native_home_authority", "native_causal_binding", "native_producer_qualification", "atomic_legacy_publication", "durable_first_answer", "transport_wake_deduplication", "previous_reader_accounting", "bounded_retention_replay"]) add(`readiness-missing-${capability}`, ["I01", "U12"], { missingNativeCapability: capability }, expect("observed", { finalQualification: false, explicitBlocker: capability, fixtureHookAcceptedAsProof: false }), { op: "readiness" }, "readiness");
add("release-fullgate-hooks-reviews-receipts", ["I04"], { proofOnly: true }, expect("observed", { ordinaryFullGatePassed: true, hooksPassed: true, architectureIndependentReview: true, securityIndependentReview: true, exactCombinedCandidate: true }), { op: "verify_bound_release_receipts" }, "release_evidence");
add("release-installed-undo-look-receipts", ["I05", "L01"], { proofOnly: true }, expect("observed", { soleDeliveryTask: 122, installedSourceMatches: true, normalHealthPassed: true, actualRollbackProof: true, applicableLookOnlyPassed: true, extraProbes: 0, holdsLifted: 0 }), { op: "verify_bound_install_receipts" }, "release_evidence");

function freeze(value) {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
export const cases = freeze(list);
