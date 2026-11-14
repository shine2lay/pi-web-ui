/**
 * OpenViking Memory Dashboard — the one mapping from state-file lines to audit actions,
 * guard verdicts and activity rows, with R-ISOLATION-1 redaction of personal summaries.
 */
import type { OpenVikingChangelogRecord, OpenVikingMetricsRecord } from "./state-files.js";
import type { OpenVikingOwnerAuditFields } from "./explorer-types.js";
import {
	ISOLATED_AGENT_MEMORY_ABSTRACT,
	type OpenVikingAuditEvent,
	type OpenVikingAuditEventAction,
	type OpenVikingGuardVerdict,
	type OpenVikingLiveActivityItem,
} from "./types.js";
import { isSharedUri } from "./uri.js";

/**
 * Contract R-CHANGELOG-1d (#523): what kind of write a row is, by URI namespace + `source`, never the verb.
 * "commit" is exactly the one session-commit classifier (`sessionCommit`, state-files.ts), so the audit's commits
 * in 24h are `changelog.session_commits_24h`. Any other add/update/delete is a shared promotion (`viking://resources/`,
 * `viking://user/default/`) or else a role memory write (`viking://user/<role>/`, alias `viking://agent/`: live
 * `migration`, `lead_direct`); a URI that cannot be classified fails closed as personal. Preference rows keep their
 * verdicts; the agent-tools sync rows fold as the contract states. R-CHANGELOG-1e: the owner's own lines
 * (`source: owner_explorer`, any URI) are `owner_edit` / `owner_delete` events, never a commit, promotion or
 * rejection; `owner_undo` lines are no event (they only mark the operation they undo).
 */
export function auditActionOf(r: OpenVikingChangelogRecord): OpenVikingAuditEventAction | null {
	if (r.sessionCommit) return "commit";
	switch (r.action) {
		case null:
		case "owner_undo":
			return null;
		case "owner_edit":
		case "owner_delete":
			return r.action;
		case "reject_preference_candidate":
			return "reject_noise";
		case "promote_preference_candidate":
		case "sync_resource":
			return "promote_shared";
		case "sync_failed":
			return "sidecar_timeout";
		case "add":
		case "update":
		case "delete":
			return isSharedUri(r.uri, r.role) ? "promote_shared" : "role_memory_write";
	}
}

export function guardVerdictOf(action: OpenVikingAuditEventAction): OpenVikingGuardVerdict {
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

const NOT_OWNER: OpenVikingOwnerAuditFields = { operation_id: null, outcome: null, undone: null };

/** G7: per operation id, the line of its last `owner_undo` that applied. */
function appliedUndoLines(changelog: readonly OpenVikingChangelogRecord[]): Map<string, number> {
	const lines = new Map<string, number>();
	for (const r of changelog) {
		if (r.action !== "owner_undo" || r.owner?.outcome !== "applied" || r.owner.operationId === null) continue;
		lines.set(r.owner.operationId, Math.max(r.line, lines.get(r.owner.operationId) ?? -1));
	}
	return lines;
}

/** `undone` is derived, never stored: a later `owner_undo` of the same operation that applied. */
function ownerFieldsOf(r: OpenVikingChangelogRecord, undoLines: Map<string, number>): OpenVikingOwnerAuditFields {
	if (r.owner === null) return NOT_OWNER;
	const { operationId, outcome } = r.owner;
	const undoLine = operationId === null ? undefined : undoLines.get(operationId);
	return { operation_id: operationId, outcome, undone: undoLine !== undefined && undoLine > r.line };
}

export function buildAuditEvents(
	changelog: readonly OpenVikingChangelogRecord[],
	metrics: readonly OpenVikingMetricsRecord[],
): OpenVikingAuditEvent[] {
	const rows: Timed<OpenVikingAuditEvent>[] = [];
	const undoLines = appliedUndoLines(changelog);
	for (const r of changelog) {
		const action = auditActionOf(r);
		if (!action) continue;
		const summary = visibleSummary(r.uri, r.role, r.summary);
		rows.push({
			tsMs: r.tsMs,
			order: r.line,
			item: {
				...ownerFieldsOf(r, undoLines),
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
				...NOT_OWNER,
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
