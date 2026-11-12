/**
 * OpenViking Memory Dashboard — `GET /api/openviking/audit` -> audit rows and filters
 * (frontend #258 implements the #261 seam).
 */

import type {
	OpenVikingAuditAction,
	OpenVikingAuditEvent,
	OpenVikingAuditResponse,
	OpenVikingGuardVerdict,
} from "../../../server/openviking/types.js";
import { OPENVIKING_AUDIT_ACTIONS } from "../../../server/openviking/types.js";
import { formatDisplayUri, formatFigure, formatPanelAge } from "./format.js";
import { OPENVIKING_ISOLATION_NOTICE_TEXT, OPENVIKING_SOURCE_FIELDS } from "./text.js";
import type {
	OpenVikingAuditFiltersModel,
	OpenVikingAuditFilterSelection,
	OpenVikingAuditRowModel,
	OpenVikingFilterOption,
	OpenVikingPanelStatus,
	OpenVikingRenderState,
	OpenVikingSlice,
} from "./view-model-types.js";

/**
 * What the audit panel may say about its own call (frontend #273, #269 F2): its loading or failure is its
 * own. The audit reads JSONL on this server, so an unreachable daemon does not empty it (spec-states §4).
 */
export function buildAuditStatus(audit: OpenVikingSlice<OpenVikingAuditResponse>): OpenVikingPanelStatus {
	if (audit.status === "loading") return { kind: "loading" };
	if (audit.status === "failed") return { kind: "failed", message: audit.message };
	return { kind: "ready", unreadCount: 0 };
}

/**
 * The five contract actions (spec.md §3). A `role_memory_write` is a role writing its own memory —
 * only a session committing its own work is a commit, so the two never share a word.
 */
const ACTION_LABELS: Record<OpenVikingAuditAction, string> = {
	commit: "Session commit",
	role_memory_write: "Role memory write",
	promote_shared: "Promoted to shared",
	reject_noise: "Rejected as noise",
	sidecar_timeout: "Sidecar timeout",
};

const GUARD_LABELS: Record<OpenVikingGuardVerdict, string> = {
	allowed: "Allowed",
	rejected: "Rejected by guard",
	degraded_skip: "Skipped while degraded",
};

/** A personal (agent) URI: the row stays metadata only, whatever the payload carries. */
function isPersonalUri(event: OpenVikingAuditEvent): boolean {
	return event.uri.startsWith("viking://agent/");
}

function buildRow(event: OpenVikingAuditEvent, nowMs: number): OpenVikingAuditRowModel {
	const isolated = isPersonalUri(event);
	return {
		key: event.id,
		action: event.action,
		actionLabel: ACTION_LABELS[event.action],
		roleLabel: event.role,
		displayUri: formatDisplayUri(event.uri),
		// The server sends no summary for a personal row; the browser adds the reason, never the text.
		summaryLine: isolated ? OPENVIKING_ISOLATION_NOTICE_TEXT : event.summary_1line,
		guardVerdict: event.guard_verdict,
		guardLabel: GUARD_LABELS[event.guard_verdict],
		age:
			formatPanelAge("", event.ts, nowMs, OPENVIKING_SOURCE_FIELDS.auditEventAt) ??
			formatFigure(null, OPENVIKING_SOURCE_FIELDS.auditEventAt, { notMeasured: true }),
		isolated,
	};
}

/**
 * Audit rows in server order, filtered by the current selection only. The action badge comes from
 * `events[].action` alone; no count, rate or verdict is computed in the browser.
 */
export function buildAuditRows(
	audit: OpenVikingAuditResponse | null,
	nowMs: number,
	selection: OpenVikingAuditFilterSelection,
): readonly OpenVikingAuditRowModel[] {
	// Only this panel's own call gates its rows (frontend #273); the local log lists even while :1933 is down.
	if (audit === null) return [];
	return audit.events
		.filter((event) => selection.action === "all" || event.action === selection.action)
		.filter((event) => selection.role === "all" || event.role === selection.role)
		.map((event) => buildRow(event, nowMs));
}

function option(value: string, label: string, selected: boolean): OpenVikingFilterOption {
	return { value, label, selected };
}

/**
 * The audit stream's filter controls: one option per contract action (plus "all") and one per role
 * present in the response (plus "all"), with the current selection marked.
 */
export function buildAuditFilters(
	audit: OpenVikingAuditResponse | null,
	selection: OpenVikingAuditFilterSelection,
): OpenVikingAuditFiltersModel {
	const roles = [...new Set((audit?.events ?? []).map((event) => event.role))].sort((a, b) => a.localeCompare(b));
	return {
		actions: [
			option("all", "All actions", selection.action === "all"),
			...OPENVIKING_AUDIT_ACTIONS.map((action) => option(action, ACTION_LABELS[action], selection.action === action)),
		],
		roles: [
			option("all", "All roles", selection.role === "all"),
			...roles.map((role) => option(role, role, selection.role === role)),
		],
	};
}
