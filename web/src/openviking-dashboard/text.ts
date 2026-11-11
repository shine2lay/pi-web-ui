/**
 * OpenViking Memory Dashboard — the one place display wording and `data-source-field` names live
 * (Rule 23: a single canonical owner). Task 2 (#258) renders these; it never re-spells them inline.
 *
 * Wording authority: `.temper/features/openviking-dashboard/design.md` (§Screen States) and
 * `.temper/features/openviking-dashboard/spec.md` + `spec-states.md` (behaviour, field names).
 */

/** A `:1933`-sourced figure that is null because the daemon could not be reached (design.md §Screen States). */
export const OPENVIKING_UNREACHABLE_TEXT = "— (Unreachable)";

/** `slots[].state === "unmeasured-gap"` or null `hit_rate_pct` / `avg_tokens` (spec G3): never a "Hit" badge. */
export const OPENVIKING_NOT_MEASURED_TEXT = "Not measured";

/** `observer.queue_depth` is always null in v1 (spec G1, R-QUEUE-DEPTH-1): never `0`, never scraped. */
export const OPENVIKING_QUEUE_DEPTH_TEXT = "Unavailable";

/** `observer.last_reachable_at === null`: never a duration, `0`, "just now" or a recent-looking dash. */
export const OPENVIKING_NO_CONTACT_TEXT = "No successful contact since the dashboard server started";

/** Online with nothing in the window (design.md `empty`): never "Healthy", "Stale" or "Server Unreachable". */
export const OPENVIKING_ZERO_ACTIVITY_TEXT = "0 events in window (server online)";

/** Cards/tabs fed by local JSONL keep their count and age while `:1933` is down (design.md `error`). */
export const OPENVIKING_LOCAL_AUDIT_SOURCE_TEXT = "from local audit log";
export const OPENVIKING_LOCAL_METRICS_SOURCE_TEXT = "from local metrics log";

/** Reader drawer L1/L2 while `:1933` is unreachable: `/api/v1/content/*` cannot be read (design.md `error`). */
export const OPENVIKING_OFFLINE_CONTENT_TEXT = "Unavailable while offline";

/** 403 `ISOLATED_ROLE_MEMORY` on a personal (agent) URI: metadata only, never another role's memory text. */
export const OPENVIKING_ISOLATION_NOTICE_TEXT = "Isolated per-role memory — metadata only (R-ISOLATION-1)";

/** Pill text while the first fetch is in flight (design.md `loading`): no status glyph, no faked `0`. */
export const OPENVIKING_LOADING_TEXT = "Loading…";

/**
 * The two memory layers are always spelled out: `L0`/`L1`/`L2` name content levels only
 * (VERIFICATION.md M5.4 — the prototype's "L1 Shared + L2 Role" collision must never reach production).
 */
export const OPENVIKING_LAYER_LABELS = {
	layer1_shared: "Layer 1 Shared",
	layer2_personal: "Layer 2 Personal",
} as const;

/** `observer.role_memory_folder_count` is a folder count, never liveness ("Roles Live"/"online" are banned). */
export function roleMemoryFolderCountText(count: number): string {
	return `${count} role memory folders`;
}

/** `changelog.session_commits_24h`: panel wording is "N session commits", never a bare "commits". */
export function sessionCommitsText(count: number): string {
	return `${count} session commits`;
}

/** `data-source-field` values painted next to every figure and age (design.md §Endpoint Shapes). */
export const OPENVIKING_SOURCE_FIELDS = {
	modeLabel: "observer.mode_label",
	folderCount: "observer.role_memory_folder_count",
	daemonBind: "observer.daemon_bind",
	queueDepth: "observer.queue_depth",
	checkedAt: "observer.checked_at",
	lastReachableAt: "observer.last_reachable_at",
	slotHitRate: "metrics.slot_hit_rate_pct",
	avgInjectedTokens: "metrics.avg_injected_tokens",
	turnsSampled: "metrics.turns_sampled_24h",
	metricsRecordedAt: "metrics.last_recorded_at",
	sessionCommits: "changelog.session_commits_24h",
	promotions: "changelog.promotions_24h",
	rejected: "changelog.rejected_24h",
	changelogEventAt: "changelog.last_event_at",
	slotHitRatePerSlot: "slots[].hit_rate_pct",
	slotAvgTokens: "slots[].avg_tokens",
	slotSampledAt: "slots[].last_sampled_at",
	entryUpdatedAt: "entries[].updated_at",
	auditEventAt: "events[].ts",
} as const;

export type OpenVikingSourceFieldName = (typeof OPENVIKING_SOURCE_FIELDS)[keyof typeof OPENVIKING_SOURCE_FIELDS];
