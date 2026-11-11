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

/** A drawer tier whose deep read is still in flight: never "Not stored" before the answer is in (#259). */
export const OPENVIKING_LOADING_CONTENT_TEXT = "Loading…";

/** A tier the daemon really has no text for: said only after the content read answered (#259). */
export const OPENVIKING_TIER_EMPTY_TEXT = "Not stored for this entry";

/** The content read failed (not 403): the drawer says so instead of claiming the tier is empty (#259). */
export const OPENVIKING_TIER_READ_FAILED_TEXT = "Could not be read just now";

/**
 * How much of an `L2` body is painted at once. The largest live entry is ~966,000 characters
 * (`viking://resources/pi-web-ui/PATCHES.md`); a single `<pre>` that long stalls the drawer, so the
 * read is clamped and the drawer says exactly how much of it is on screen (#259).
 */
export const OPENVIKING_TIER_BODY_LIMIT = 20_000;

export function openVikingClampNote(shown: number, total: number): string {
	return `\n\n… showing the first ${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} characters.`;
}

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
	return `${groupCount(count)} session commits`;
}

/** Thousands separators, so a four-figure count reads as one number next to the cards' other figures. */
function groupCount(count: number): string {
	return count.toLocaleString("en-US");
}

/** `changelog.promotions_24h`: a promotion into the shared layer, never a `wt land` sync. */
export function sharedPromotionsText(count: number): string {
	return `${groupCount(count)} shared promotions`;
}

/** `changelog.rejected_24h`: writes the guard turned away in the window. */
export function guardRejectionsText(count: number): string {
	return `${groupCount(count)} guard rejections (24h)`;
}

/** The three Tier-1 cards: title, the caption that says when the data is used, and the cadence. */
export const OPENVIKING_CARD_TEXT = {
	"system-health": {
		title: "System & Daemon Health",
		caption: "Shown at chat start (L0)",
		cadence: "30s cadence",
	},
	"context-injection": {
		title: "Context & Token Injection",
		caption: "Added on a worker's first turn",
		cadence: "5m cadence",
	},
	"commit-governance": {
		title: "Commit & Guard Governance",
		caption: "Commit Guard",
		cadence: "15m cadence",
	},
} as const;

/** The three workspace tabs (design.md Tier 1). `data-tab` values are part of the DOM contract. */
export const OPENVIKING_TABS = [
	{ tab: "mount-map", label: "Live Activity", panelTitle: "Context Mount Map" },
	{ tab: "namespace-explorer", label: "Memory Explorer", panelTitle: "Memory Explorer" },
	{ tab: "commit-audit", label: "Guardrail & Changelog Audit", panelTitle: "Commit & Guardrail Audit" },
] as const;

export type OpenVikingTabId = (typeof OPENVIKING_TABS)[number]["tab"];

/** Tier-2 progressive disclosure: the `(?)` contract badges and what each one explains. */
export const OPENVIKING_CONTRACT_TOOLTIPS = [
	{
		id: "mode-1-l0",
		label: "Mode 1 L0",
		body: "Mode 1: at chat start the lead is given the L0 abstract of each matching memory — a one-line summary, never the full document.",
	},
	{
		id: "mode-2-turn-1",
		label: "Mode 2 Turn-1",
		body: "Mode 2: a worker's first turn is prefetched from the five context slots below, so its opening answer already carries the project's memory.",
	},
	{
		id: "write-guard",
		label: "Write Guard",
		body: "R-PREF-WRITE-GUARD-1: a worker may not write a role preference. The guard turns the write away and records it in the audit stream below.",
	},
	{
		id: "wt-land-sync",
		label: "wt land Sync",
		body: "Shared resources are refreshed when a change lands. A sync still waiting marks its panel stale with 'pending sync' rather than an age.",
	},
	{
		id: "granularity",
		label: "L0 / L1 / L2 Granularity",
		body: "L0 is the one-line abstract, L1 the overview, L2 the full document. Open any row to read all three in the drawer.",
	},
] as const;

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
	retrievalHitRate: "observer.retrieval_hit_rate_pct",
	retrievalLatency: "observer.retrieval_latency_avg_ms",
	layer1Total: "observer.store_counts.layer1_shared.total_count",
	layer2Total: "observer.store_counts.layer2_personal.total_count",
	mode1Injections: "metrics.mode1_lead_l0_injections_24h",
	mode2Prefetches: "metrics.mode2_worker_turn1_prefetches_24h",
	leadCommits: "metrics.lead_200k_commits_24h",
	dedupSkipped: "metrics.rm_dedup_skipped_24h",
	pendingWtLandSyncs: "auxiliary.rollout.pending_wt_land_syncs",
	liveActivity: "live_activity[].ts",
	entriesPanelUpdatedAt: "entries.panel_updated_at",
	auditPanelUpdatedAt: "audit.panel_updated_at",
} as const;

export type OpenVikingSourceFieldName = (typeof OPENVIKING_SOURCE_FIELDS)[keyof typeof OPENVIKING_SOURCE_FIELDS];
