/**
 * OpenViking Memory Dashboard — shared TypeScript contract and constants.
 *
 * Grounded in:
 * - .temper/features/openviking-dashboard/brief.md (Product #65)
 * - .temper/features/openviking-dashboard/design.md (Design #263)
 * - .temper/features/openviking-dashboard/spec.md (Architecture #515)
 * - /home/shinelay/architecture-dept/conventions/openviking-contract.md
 */
import type {
	OPENVIKING_OWNER_AUDIT_ACTIONS,
	OpenVikingExplorerOptions,
	OpenVikingOwnerAuditFields,
} from "./explorer-types.js";

export const DEFAULT_OPENVIKING_DAEMON_URL = "http://127.0.0.1:1933";
export const DEFAULT_OPENVIKING_TIMEOUT_MS = 2_000;

export const OPENVIKING_ACCOUNT_HEADER = "X-OpenViking-Account";
export const OPENVIKING_USER_HEADER = "X-OpenViking-User";
export const OPENVIKING_AGENT_HEADER = "X-OpenViking-Agent";
export const DEFAULT_OPENVIKING_ACCOUNT = "default";
export const DEFAULT_OPENVIKING_SHARED_USER = "default";

export const ISOLATED_AGENT_MEMORY_ABSTRACT = "[Isolated per-role memory — metadata only (R-ISOLATION-1)]";

export const OVERVIEW_METRICS_CADENCE_MS = 5 * 60_000;
export const OVERVIEW_CHANGELOG_CADENCE_MS = 15 * 60_000;
export const AUDIT_CADENCE_MS = 15 * 60_000;
export const WINDOW_24H_MS = 24 * 60 * 60 * 1_000;

/**
 * The stale reason of a reading that is inside its cadence while a `wt land` sync waits (ruling rm-b5272a3e,
 * spec-states.md §4). Only `audit` reads it; metrics and changelog freshness stay age-only.
 */
export const OPENVIKING_PENDING_SYNC_BADGE = "pending sync" as const;
export type OpenVikingPendingSyncBadge = typeof OPENVIKING_PENDING_SYNC_BADGE;

export const OPENVIKING_ROLES = [
	"architecture",
	"backend",
	"coo",
	"data",
	"design",
	"docs",
	"frontend",
	"marketing",
	"ops",
	"product",
	"qa",
	"rollcall",
	"security",
	"systems",
	"temper",
] as const;

export type OpenVikingRoleId = (typeof OPENVIKING_ROLES)[number];

export type OpenVikingScreenState = "live" | "stale" | "empty" | "error";
export type OpenVikingHealthState = "healthy" | "stale" | "zero-activity" | "server-unreachable";

export type OpenVikingEntryScope = "resources" | "user" | "agent";
export type OpenVikingMemoryLayer = "layer1_shared" | "layer2_personal";

/** Spec c5c47e6 §3 `events[].action`, decided by URI namespace + `source`, never the verb (R-CHANGELOG-1d). */
export const OPENVIKING_AUDIT_ACTIONS = [
	"commit",
	"role_memory_write",
	"promote_shared",
	"reject_noise",
	"sidecar_timeout",
] as const;

export type OpenVikingAuditAction = (typeof OPENVIKING_AUDIT_ACTIONS)[number];

export type OpenVikingGuardVerdict = "allowed" | "rejected" | "degraded_skip";

export interface RewrittenVikingUri {
	canonicalUri: string;
	logicalUri: string;
	scope: OpenVikingEntryScope;
	layer: OpenVikingMemoryLayer;
	role: string | null;
	headers: Record<string, string>;
}

/** What the Memory Explorer's health line reads of the daemon and the state files (spec-explorer-build.md). */
export interface OpenVikingObserverSummary {
	/** Request time. Never the age of the daemon's last contact: that is `last_reachable_at`. */
	checked_at: string;
	/**
	 * Spec 895b0cb1 (rm-5bbe0bcc): ISO time of the last `/health` that answered ok, seen by this server process
	 * (in memory). Held while `:1933` is down; null only before the first ok since start, never a duration or 0.
	 * Best-effort: it never feeds `screen_state`, `health_state`, a degraded verdict or an alarm.
	 */
	last_reachable_at: string | null;
	/** Newest session commit (spec "Session Commits", rm-9724bae9); null when none was ever written. */
	last_commit_at: string | null;
}

export interface OpenVikingPendingWtLandSync {
	project: string;
	repoRoot: string;
	changedPaths: string[];
	failedAt: string;
	error: string;
}

/** `GET /api/openviking/overview`: `health_state` and the three `observer` times are what the explorer reads. */
export interface OpenVikingOverviewResponse {
	screen_state: OpenVikingScreenState;
	health_state: OpenVikingHealthState;
	observer: OpenVikingObserverSummary;
}

export interface OpenVikingAuditQuery {
	limit?: unknown;
	action?: unknown;
	role?: unknown;
	/** `"true"`: only the owner's own changes (G7 "Changes you made"), before `limit`. */
	owner_only?: unknown;
}

/** `events[].action`: the contract's five, plus the owner's own edits and deletes (G7; `owner_undo` is no event). */
export type OpenVikingAuditEventAction = OpenVikingAuditAction | (typeof OPENVIKING_OWNER_AUDIT_ACTIONS)[number];

/** `operation_id`, `outcome`, `undone` (OpenVikingOwnerAuditFields) are null on every non-owner event. */
export interface OpenVikingAuditEvent extends OpenVikingOwnerAuditFields {
	id: string;
	action: OpenVikingAuditEventAction;
	raw_action: string;
	source: string;
	role: string;
	task_id: string | number | null;
	uri: string;
	l0_abstract: string;
	summary_1line: string;
	guard_verdict: OpenVikingGuardVerdict;
	ts: string;
}

export interface OpenVikingAuditResponse {
	panel_updated_at: string;
	health_state: OpenVikingHealthState;
	/** The true reason (ruling rm-b5272a3e): the age when past the `15m` cadence, else a waiting sync, else null. */
	stale_badge: "> 15m" | OpenVikingPendingSyncBadge | null;
	events: OpenVikingAuditEvent[];
}

export interface OpenVikingDashboardOptions {
	daemonUrl?: string;
	stateDir?: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
	now?: () => number;
	/** Memory Explorer routes' dependencies (explorer-types.ts): owner gate, clock, shutdown hook. */
	explorer?: OpenVikingExplorerOptions;
}

export interface OpenVikingHttpErrorBody {
	error: {
		code: string;
		message: string;
		details?: Record<string, unknown>;
	};
}

export class OpenVikingDashboardError extends Error {
	constructor(
		message: string,
		readonly statusCode = 400,
		readonly code = "INVALID_ARGUMENT",
		readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "OpenVikingDashboardError";
	}
}
