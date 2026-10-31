/**
 * roles-message-approvals: the approval step for long role-message chains (ladder-alarm) as the Roles page shows
 * it: on, or off with its reason and since when. It only reads the step's own state, as the host hands it over.
 * Split out of roles-overview.ts (Backend #15), which still exports these names.
 */

import type { UiMessageApprovals } from "./protocol.js";

// ---------------------------------------------------------------------------
// ladder-alarm: the approval step for long role-message chains
// ---------------------------------------------------------------------------

/** The approval step's own state (RoleMessageGuardHost.state) plus when this server started, as the host
 *  hands it over. Only read, never changed. */
export interface RolesApprovalsState {
	status: string;
	reason?: string;
	since?: number;
}

const APPROVALS_REASON_MAX = 300;

/** What the Roles page gets: "ready" -> on; "degraded" -> off, with its reason (one line, clipped) and the
 *  server's start; "starting", anything else or nothing -> nothing, so nothing shows. */
export function approvalsOf(state: RolesApprovalsState | null | undefined): UiMessageApprovals | undefined {
	if (!state || typeof state !== "object") return undefined;
	if (state.status === "ready") return { on: true };
	if (state.status !== "degraded") return undefined;
	let reason = typeof state.reason === "string" ? state.reason.replace(/\s+/g, " ").trim() : "";
	if (reason.length > APPROVALS_REASON_MAX) reason = `${reason.slice(0, APPROVALS_REASON_MAX - 1)}\u2026`;
	const since = state.since;
	const sinceOk = typeof since === "number" && Number.isSafeInteger(since) && since > 0;
	return { on: false, ...(reason ? { reason } : {}), ...(sinceOk ? { since } : {}) };
}
