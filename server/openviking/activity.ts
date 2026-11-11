/**
 * OpenViking Memory Dashboard — the one mapping from state-file lines to audit actions,
 * guard verdicts and activity rows, with R-ISOLATION-1 redaction of personal summaries.
 */
import type { OpenVikingChangelogRecord, OpenVikingMetricsRecord } from "./state-files.js";
import {
	ISOLATED_AGENT_MEMORY_ABSTRACT,
	type OpenVikingAuditAction,
	type OpenVikingAuditEvent,
	type OpenVikingGuardVerdict,
	type OpenVikingLiveActivityItem,
} from "./types.js";
import { isSharedUri } from "./uri.js";

/** Spec G4's live names map straight to an audit action, whatever the URI. */
const LEGACY_AUDIT_ACTIONS: Record<string, OpenVikingAuditAction> = {
	session_commit: "commit",
	preference_write: "promote_shared",
	resource_sync: "promote_shared",
	preference_write_blocked: "reject_noise",
};

/** add/update/delete: a write to a shared URI is a promotion; anything personal is a commit. */
export function auditActionOf(r: OpenVikingChangelogRecord): OpenVikingAuditAction | null {
	const legacy = LEGACY_AUDIT_ACTIONS[r.rawAction];
	if (legacy) return legacy;
	switch (r.action) {
		case null:
			return null;
		case "reject_preference_candidate":
			return "reject_noise";
		case "promote_preference_candidate":
			return "promote_shared";
		case "sync_failed":
			return "sidecar_timeout";
		default:
			return isSharedUri(r.uri, r.role) ? "promote_shared" : "commit";
	}
}

export function guardVerdictOf(action: OpenVikingAuditAction): OpenVikingGuardVerdict {
	if (action === "reject_noise") return "rejected";
	if (action === "sidecar_timeout") return "degraded_skip";
	return "allowed";
}

export function oneLine(text: string, max = 200): string {
	const first =
		text
			.split("\n")
			.find((l) => l.trim() !== "")
			?.trim() ?? "";
	return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** R-ISOLATION-1: a summary is shown only for a Layer 1 shared URI (fail closed). */
function visibleSummary(uri: string, role: string | null, summary: string): string {
	return isSharedUri(uri, role) ? oneLine(summary) : ISOLATED_AGENT_MEMORY_ABSTRACT;
}

/** A 200K lead commit that fell back to local compression: the sidecar did not take it. */
const isDegradedCommit = (m: OpenVikingMetricsRecord) => m.event === "lead_200k_commit" && m.degradedFallback;
const DEGRADED_COMMIT_SUMMARY = "200K lead commit fell back to local compression (OpenViking unavailable)";

interface Timed<T> {
	tsMs: number;
	order: number;
	item: T;
}

function newestFirst<T>(rows: Timed<T>[], limit: number): T[] {
	return rows
		.sort((a, b) => b.tsMs - a.tsMs || b.order - a.order)
		.slice(0, limit)
		.map((r) => r.item);
}

export function buildAuditEvents(
	changelog: readonly OpenVikingChangelogRecord[],
	metrics: readonly OpenVikingMetricsRecord[],
): OpenVikingAuditEvent[] {
	const rows: Timed<OpenVikingAuditEvent>[] = [];
	for (const r of changelog) {
		const action = auditActionOf(r);
		if (!action) continue;
		const summary = visibleSummary(r.uri, r.role, r.summary);
		rows.push({
			tsMs: r.tsMs,
			order: r.line,
			item: {
				id: `changelog:${r.line}`,
				action,
				raw_action: r.rawAction,
				source: r.source,
				role: r.role ?? "unknown",
				task_id: r.taskId,
				uri: r.uri,
				l0_abstract: summary,
				summary_1line: summary,
				guard_verdict: guardVerdictOf(action),
				ts: r.ts,
			},
		});
	}
	for (const m of metrics.filter(isDegradedCommit)) {
		rows.push({
			tsMs: m.tsMs,
			order: m.line,
			item: {
				id: `metrics:${m.line}`,
				action: "sidecar_timeout",
				raw_action: m.event,
				source: "metrics",
				role: m.role ?? "unknown",
				task_id: m.taskId,
				uri: "",
				l0_abstract: DEGRADED_COMMIT_SUMMARY,
				summary_1line: DEGRADED_COMMIT_SUMMARY,
				guard_verdict: "degraded_skip",
				ts: m.ts,
			},
		});
	}
	return newestFirst(rows, rows.length);
}

function injectionSummary(m: OpenVikingMetricsRecord): string {
	const inj = m.injection;
	const mode =
		inj?.mode === "lead" ? "Lead L0 injection" : inj?.mode === "worker" ? "Worker Turn-1 prefetch" : "Injection";
	const count = (v: number | null | undefined) => (v === null || v === undefined ? "unmeasured" : String(v));
	return `${mode}: ${count(inj?.l0HitCount)} L0 hits, ${count(inj?.l1ExpandedCount)} L1 expansions`;
}

export function buildLiveActivity(
	changelog: readonly OpenVikingChangelogRecord[],
	metrics: readonly OpenVikingMetricsRecord[],
	limit = 25,
): OpenVikingLiveActivityItem[] {
	const rows: Timed<OpenVikingLiveActivityItem>[] = [];
	for (const r of changelog) {
		const action = auditActionOf(r);
		if (!action) continue;
		const status = action === "reject_noise" ? "rejected" : action === "sidecar_timeout" ? "degraded" : "ok";
		rows.push({
			tsMs: r.tsMs,
			order: r.line,
			item: {
				id: `changelog:${r.line}`,
				ts: r.ts,
				role: r.role ?? "unknown",
				task_id: r.taskId,
				action: r.rawAction,
				count_value: null,
				count_unit: null,
				status,
				summary_1line: visibleSummary(r.uri, r.role, r.summary),
			},
		});
	}
	for (const m of metrics) {
		if (!m.injection && !isDegradedCommit(m)) continue;
		const tokens = m.injection ? m.injection.injectedTokensEst : m.evictedTokens;
		const unavailable = m.injection?.slots?.some((s) => s.state === "unavailable") ?? false;
		rows.push({
			tsMs: m.tsMs,
			order: m.line,
			item: {
				id: `metrics:${m.line}`,
				ts: m.ts,
				role: m.role ?? "unknown",
				task_id: m.taskId,
				action: m.event,
				count_value: tokens,
				count_unit: tokens === null ? null : "tokens",
				status: m.injection && !unavailable ? "ok" : "degraded",
				summary_1line: m.injection ? injectionSummary(m) : DEGRADED_COMMIT_SUMMARY,
			},
		});
	}
	return newestFirst(rows, limit);
}
