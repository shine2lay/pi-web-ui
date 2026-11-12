/**
 * OpenViking Memory Dashboard — shared TypeScript contract and constants.
 *
 * Grounded in:
 * - .temper/features/openviking-dashboard/brief.md (Product #65)
 * - .temper/features/openviking-dashboard/design.md (Design #263)
 * - .temper/features/openviking-dashboard/spec.md (Architecture #515)
 * - /home/shinelay/architecture-dept/conventions/openviking-contract.md
 */

export const DEFAULT_OPENVIKING_DAEMON_URL = "http://127.0.0.1:1933";
export const DEFAULT_OPENVIKING_DAEMON_BIND = "127.0.0.1:1933";
export const DEFAULT_OPENVIKING_TIMEOUT_MS = 2_000;
export const DEFAULT_OPENVIKING_STATE_DIR = "/home/shinelay/.pi/openviking";

export const OPENVIKING_ACCOUNT_HEADER = "X-OpenViking-Account";
export const OPENVIKING_USER_HEADER = "X-OpenViking-User";
export const OPENVIKING_AGENT_HEADER = "X-OpenViking-Agent";
export const DEFAULT_OPENVIKING_ACCOUNT = "default";
export const DEFAULT_OPENVIKING_SHARED_USER = "default";

export const ISOLATED_AGENT_MEMORY_ABSTRACT = "[Isolated per-role memory — metadata only (R-ISOLATION-1)]";

export const OVERVIEW_OBSERVER_CADENCE_MS = 30_000;
export const OVERVIEW_METRICS_CADENCE_MS = 5 * 60_000;
export const OVERVIEW_CHANGELOG_CADENCE_MS = 15 * 60_000;
export const ENTRIES_CADENCE_MS = 15 * 60_000;
export const AUDIT_CADENCE_MS = 15 * 60_000;
export const WINDOW_24H_MS = 24 * 60 * 60 * 1_000;

/**
 * The store-count walk over `fs/ls` (~83 GETs) is read again at the observer cadence; in between, an overview
 * answers it from this process's memory (Backend #147). Nothing older than the serve age is answered with: past
 * it the counts are `null` (unmeasured), never an earlier figure shown as the current one.
 */
export const MEMORY_TREE_CADENCE_MS = OVERVIEW_OBSERVER_CADENCE_MS;
export const MEMORY_TREE_MAX_SERVE_AGE_MS = 4 * OVERVIEW_OBSERVER_CADENCE_MS;

/**
 * The stale reason of a panel that is inside its cadence while a `wt land` sync waits (ruling rm-b5272a3e,
 * spec-states.md §4). Only `observer`, `entries` and `audit` can read it; metrics and changelog stay age-only.
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

export const OPENVIKING_SHARED_REPOS = [
	"rollcall",
	"pi-web-ui",
	"pi-queue",
	"pi-worktree",
	"temper-ai",
	"architecture-conventions",
] as const;

export const OPENVIKING_CRAFT_PREFERENCE_DOMAINS = [
	"frontend_code.md",
	"backend_code.md",
	"test_writing.md",
	"ui_ux_design.md",
	"architecture_contracts.md",
	"product_briefs.md",
	"ops_tooling.md",
	"rollcall_trading.md",
] as const;

export const OPENVIKING_AGENT_CATEGORIES = [
	"preferences",
	"entities",
	"events",
	"cases",
	"patterns",
	"tools",
	"skills",
	"trajectories",
	"experiences",
	"instructions",
] as const;

export type OpenVikingAgentCategory = (typeof OPENVIKING_AGENT_CATEGORIES)[number];

export type OpenVikingScreenState = "live" | "stale" | "empty" | "error";
export type OpenVikingHealthState = "healthy" | "stale" | "zero-activity" | "server-unreachable";
/** Spec 2677060e: plain "Active"; nothing measures role liveness in v1, so no label states it. */
export type OpenVikingModeLabel = "Active" | "Degraded Local Fallback" | "Offline";

export type OpenVikingEntryScope = "resources" | "user" | "agent";
export type OpenVikingEntriesFilterScope = "all" | OpenVikingEntryScope;
export type OpenVikingMemoryLayer = "layer1_shared" | "layer2_personal";
export type OpenVikingDisclosureTier = "L0" | "L1" | "L2";
export type OpenVikingSlotState = OpenVikingHealthState | "unmeasured-gap";

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

export interface OpenVikingContextSlotDefinition {
	readonly slot_id: 1 | 2 | 3 | 4 | 5;
	readonly label: string;
	readonly uri_prefix: string;
}

export const OPENVIKING_CONTEXT_SLOTS: readonly OpenVikingContextSlotDefinition[] = [
	{
		slot_id: 1,
		label: "Slot 1 Project L1 Overview",
		uri_prefix: "viking://resources/<project>/.overview.md",
	},
	{
		slot_id: 2,
		label: "Slot 2 Shared Entity Status",
		uri_prefix: "viking://user/default/memories/entities/",
	},
	{
		slot_id: 3,
		label: "Slot 3 Top Matching Spec",
		uri_prefix: "viking://resources/<project>/features/",
	},
	{
		slot_id: 4,
		label: "Slot 4 Personal Role Memories",
		uri_prefix: "viking://agent/memories/",
	},
	{
		slot_id: 5,
		label: "Slot 5 Sibling Project Docs",
		uri_prefix: "viking://resources/<project>/",
	},
] as const;

export interface RewrittenVikingUri {
	canonicalUri: string;
	logicalUri: string;
	scope: OpenVikingEntryScope;
	layer: OpenVikingMemoryLayer;
	role: string | null;
	headers: Record<string, string>;
}

export interface OpenVikingStoreCounts {
	layer1_shared: {
		repo_trees_count: number | null;
		craft_preference_domains_count: number | null;
		entities_count: number | null;
		events_count: number | null;
		total_count: number | null;
	};
	layer2_personal: {
		roles_count: number | null;
		preferences_count: number | null;
		cases_count: number | null;
		experiences_count: number | null;
		total_count: number | null;
	};
}

export interface OpenVikingObserverSummary {
	mode_label: OpenVikingModeLabel;
	/**
	 * Spec 2677060e: canonical `viking://user/<role>/memories` folders found (0..15), null when `:1933` is down.
	 * Not liveness: it never feeds `screen_state`, `mode_label` or a degraded verdict.
	 */
	role_memory_folder_count: number | null;
	roles_total_count: number;
	daemon_bind: string;
	/** R-QUEUE-DEPTH-1 (spec G1): unavailable in v1, never scraped, never 0. */
	queue_depth: null;
	/** Request time. Never the age of the daemon's last contact: that is `last_reachable_at`. */
	checked_at: string;
	/**
	 * Spec 895b0cb1 (rm-5bbe0bcc): ISO time of the last `/health` that answered ok, seen by this server process
	 * (in memory). Held while `:1933` is down; null only before the first ok since start, never a duration or 0.
	 * Best-effort: it never feeds `screen_state`, `mode_label`, `health_state`, a degraded verdict or an alarm.
	 */
	last_reachable_at: string | null;
	health_state: OpenVikingHealthState;
	/** The true reason (ruling rm-b5272a3e): the age when past the `30s` cadence, else a waiting sync, else null. */
	stale_badge: "> 30s" | OpenVikingPendingSyncBadge | null;
	last_injection_at: string | null;
	last_commit_at: string | null;
	retrieval_latency_avg_ms: number | null;
	retrieval_hit_rate_pct: number | null;
	store_counts: OpenVikingStoreCounts;
}

export interface OpenVikingMetricsSummary {
	slot_hit_rate_pct: number | null;
	avg_injected_tokens: number | null;
	turns_sampled_24h: number;
	mode1_lead_l0_injections_24h: number;
	mode2_worker_turn1_prefetches_24h: number;
	lead_200k_commits_24h: number;
	rm_dedup_skipped_24h: number;
	last_recorded_at: string | null;
	health_state: OpenVikingHealthState;
	stale_badge: "> 5m" | null;
}

export interface OpenVikingChangelogSummary {
	/** Spec "Session Commits" (rm-9724bae9): a session committing its own work (queue_done + 200K lead) only. */
	session_commits_24h: number;
	promotions_24h: number;
	rejected_24h: number;
	last_event_at: string | null;
	health_state: OpenVikingHealthState;
	stale_badge: "> 15m" | null;
}

export interface OpenVikingSlotSummary {
	slot_id: 1 | 2 | 3 | 4 | 5;
	label: string;
	uri_prefix: string;
	hit_rate_pct: number | null;
	avg_tokens: number | null;
	state: OpenVikingSlotState;
	last_sampled_at: string | null;
}

export interface OpenVikingPendingWtLandSync {
	project: string;
	repoRoot: string;
	changedPaths: string[];
	failedAt: string;
	error: string;
}

export interface OpenVikingAuxiliaryState {
	rollout: {
		stage: string | null;
		notebook_retired: boolean | null;
		cutover_ts: string | null;
		updated_at: string | null;
		fallback_roles: string[];
		pending_wt_land_syncs: OpenVikingPendingWtLandSync[];
	};
	resource_sync: {
		/** Always `null`: nothing anywhere writes a resource-sync time (spec `2500874d` G5, Backend #153). */
		synced_at: string | null;
		/** Always `null`: nothing anywhere writes a synced-repo count (spec `2500874d` G5, Backend #153). */
		repos_synced: number | null;
		/**
		 * `rollout-state.json`'s `pending_wt_land_syncs.length`, or `null` while that file is absent or
		 * unreadable — never `0` for a file nobody read, because `0` means "looked and none pending".
		 */
		pending_syncs_count: number | null;
		status: "ok" | "pending" | "missing";
	};
	migration: {
		verified_at: string | null;
		checked_at: string | null;
		status: string | null;
		roles_passed: number | null;
		total_roles: number | null;
		repos_passed: number | null;
		total_repos: number | null;
		total_checked: number | null;
	};
	dedup: {
		seen_count: number | null;
		updated_at: string | null;
	};
}

export interface OpenVikingLiveActivityItem {
	id: string;
	ts: string;
	role: string;
	task_id: string | number | null;
	action: string;
	count_value: number | null;
	count_unit: "tokens" | "items" | null;
	status: "ok" | "degraded" | "rejected";
	summary_1line: string;
}

export interface OpenVikingOverviewResponse {
	screen_state: OpenVikingScreenState;
	health_state: OpenVikingHealthState;
	observer: OpenVikingObserverSummary;
	metrics: OpenVikingMetricsSummary;
	changelog: OpenVikingChangelogSummary;
	slots: OpenVikingSlotSummary[];
	auxiliary: OpenVikingAuxiliaryState;
	live_activity: OpenVikingLiveActivityItem[];
}

export interface OpenVikingEntryProvenance {
	action: string | null;
	source: string | null;
	role: string | null;
	task_id: string | number | null;
	guard_verdict: OpenVikingGuardVerdict | null;
	updated_at: string | null;
}

export interface OpenVikingExplorerEntry {
	uri: string;
	canonical_uri: string;
	title: string;
	category: string;
	scope: OpenVikingEntryScope;
	layer: OpenVikingMemoryLayer;
	role: string | null;
	layers: OpenVikingDisclosureTier[];
	l0_abstract: string | null;
	l1_overview: string | null;
	l2_content: string | null;
	updated_at: string | null;
	provenance: OpenVikingEntryProvenance | null;
}

export interface OpenVikingEntriesQuery {
	scope?: unknown;
	role?: unknown;
	uri?: unknown;
	tier?: unknown;
	include_content?: unknown;
}

export interface OpenVikingEntriesResponse {
	panel_updated_at: string;
	health_state: OpenVikingHealthState;
	/** The true reason (ruling rm-b5272a3e): a sync-caused stale reads `"pending sync"`, never an age. */
	stale_badge: "> 15m" | OpenVikingPendingSyncBadge | null;
	/**
	 * Spec `2500874d` §3a, on every answer: `true` exactly when `unread_count > 0` — this list is short, rows
	 * the daemon would not list are missing from it, and the UI may not present it as the whole store. A row
	 * that shipped with a null field does not make a list short.
	 */
	entries_partial: boolean;
	/**
	 * Spec `2500874d` §3a, on every answer: how many read units did not answer. A read unit is one
	 * all-or-nothing listing read — the `resources` root, the shared memories walk, one per role tree in scope
	 * (`scope=all` without `role`: `2 + 15 = 17`, every one of them when `/health` is down). A root answered
	 * `NOT_FOUND` is absent, not unread; a failed read inside a row that shipped is not a unit; `?uri=` is not a
	 * listing, so it is `0`.
	 */
	unread_count: number;
	entries: OpenVikingExplorerEntry[];
}

export interface OpenVikingAuditQuery {
	limit?: unknown;
	action?: unknown;
	role?: unknown;
}

export interface OpenVikingAuditEvent {
	id: string;
	action: OpenVikingAuditAction;
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

export interface OpenVikingContentTierResult {
	uri: string;
	canonical_uri: string;
	tier: OpenVikingDisclosureTier;
	content: string;
}

export interface OpenVikingDashboardOptions {
	daemonUrl?: string;
	daemonBind?: string;
	stateDir?: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
	now?: () => number;
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

export class OpenVikingNotImplementedError extends OpenVikingDashboardError {
	constructor(operation: string) {
		super(
			`OpenViking dashboard seam operation "${operation}" is not implemented yet (Task 2 #132).`,
			501,
			"NOT_IMPLEMENTED",
			{ operation },
		);
		this.name = "OpenVikingNotImplementedError";
	}
}
