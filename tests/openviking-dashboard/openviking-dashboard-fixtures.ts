/**
 * Fixtures for the OpenViking Memory Dashboard acceptance tests (frontend #261, Task 1).
 *
 * Rule 29: fixtures live in tests only. Production code never embeds a payload and never branches
 * on one — it fetches `/api/openviking/{overview,entries,audit}`.
 *
 * Shapes come from `server/openviking/types.ts`; nothing here redeclares the contract.
 */

import {
	ISOLATED_AGENT_MEMORY_ABSTRACT,
	OPENVIKING_CONTEXT_SLOTS,
	type OpenVikingAuditEvent,
	type OpenVikingAuditResponse,
	type OpenVikingAuxiliaryState,
	type OpenVikingChangelogSummary,
	type OpenVikingEntriesResponse,
	type OpenVikingExplorerEntry,
	type OpenVikingMetricsSummary,
	type OpenVikingObserverSummary,
	type OpenVikingOverviewResponse,
	type OpenVikingSlotSummary,
	type OpenVikingStoreCounts,
} from "../../server/openviking/types.js";

export const NOW_ISO = "2026-11-12T12:00:00.000Z";
export const NOW_MS = Date.parse(NOW_ISO);

export const secondsAgo = (s: number): string => new Date(NOW_MS - s * 1_000).toISOString();
export const minutesAgo = (m: number): string => new Date(NOW_MS - m * 60_000).toISOString();
export const hoursAgo = (h: number): string => new Date(NOW_MS - h * 3_600_000).toISOString();
export const daysAgo = (d: number): string => new Date(NOW_MS - d * 86_400_000).toISOString();

/** A 64-char hash and an on-disk path: neither may ever be painted in a list row. */
export const FIXTURE_BLOB_HASH = "9f2c4b7d1a6e8035cfa41d9b72e5c08a3d6417fb0925ae83c1d470f6b28a59e4";
export const FIXTURE_STORAGE_PATH = `/home/shinelay/.pi/openviking/blobs/${FIXTURE_BLOB_HASH}`;

const storeCounts = (present: boolean): OpenVikingStoreCounts => ({
	layer1_shared: {
		repo_trees_count: present ? 6 : null,
		craft_preference_domains_count: present ? 8 : null,
		entities_count: present ? 23 : null,
		events_count: present ? 11 : null,
		total_count: present ? 48 : null,
	},
	layer2_personal: {
		roles_count: present ? 15 : null,
		preferences_count: present ? 15 : null,
		cases_count: present ? 62 : null,
		experiences_count: present ? 19 : null,
		total_count: present ? 96 : null,
	},
});

const auxiliary = (pendingSyncs = 0): OpenVikingAuxiliaryState => ({
	rollout: {
		stage: null,
		phase: null,
		notebook_retired: null,
		cutover_ts: null,
		updated_at: minutesAgo(12),
		fallback_roles: [],
		pending_wt_land_syncs: Array.from({ length: pendingSyncs }, (_unused, i) => ({
			project: `repo-${i + 1}`,
			repoRoot: `/home/shinelay/projects/repo-${i + 1}`,
			changedPaths: [".temper/core/map.md"],
			failedAt: minutesAgo(9),
			error: "sync deferred",
		})),
	},
	resource_sync: {
		synced_at: minutesAgo(21),
		repos_synced: 6,
		pending_syncs_count: pendingSyncs,
		status: pendingSyncs > 0 ? "pending" : "ok",
	},
	migration: {
		verified_at: null,
		checked_at: hoursAgo(9),
		status: "pass",
		roles_passed: 15,
		total_roles: 15,
		repos_passed: 6,
		total_repos: 6,
		total_checked: 21,
	},
	dedup: { seen_count: 134, updated_at: minutesAgo(7) },
});

/** Live reality today (spec G3): the daemon logs turn totals, not per-slot telemetry. */
const unmeasuredSlots = (): OpenVikingSlotSummary[] =>
	OPENVIKING_CONTEXT_SLOTS.map((slot) => ({
		slot_id: slot.slot_id,
		label: slot.label,
		uri_prefix: slot.uri_prefix,
		hit_rate_pct: null,
		avg_tokens: null,
		state: "unmeasured-gap" as const,
		last_sampled_at: null,
	}));

const liveObserver = (): OpenVikingObserverSummary => ({
	mode_label: "Active",
	role_memory_folder_count: 15,
	roles_total_count: 15,
	daemon_bind: "127.0.0.1:1933",
	queue_depth: null,
	checked_at: secondsAgo(4),
	last_reachable_at: secondsAgo(4),
	health_state: "healthy",
	stale_badge: null,
	last_injection_at: minutesAgo(2),
	last_commit_at: minutesAgo(8),
	retrieval_latency_avg_ms: 42,
	retrieval_hit_rate_pct: 94.2,
	store_counts: storeCounts(true),
});

const liveMetrics = (): OpenVikingMetricsSummary => ({
	slot_hit_rate_pct: 94.2,
	avg_injected_tokens: 1_820,
	turns_sampled_24h: 48,
	mode1_lead_l0_injections_24h: 31,
	mode2_worker_turn1_prefetches_24h: 17,
	lead_200k_commits_24h: 3,
	rm_dedup_skipped_24h: 5,
	last_recorded_at: minutesAgo(3),
	health_state: "healthy",
	stale_badge: null,
});

const liveChangelog = (): OpenVikingChangelogSummary => ({
	session_commits_24h: 18,
	promotions_24h: 4,
	rejected_24h: 2,
	last_event_at: minutesAgo(5),
	health_state: "healthy",
	stale_badge: null,
});

export function liveOverview(): OpenVikingOverviewResponse {
	return {
		screen_state: "live",
		health_state: "healthy",
		observer: liveObserver(),
		metrics: liveMetrics(),
		changelog: liveChangelog(),
		slots: unmeasuredSlots(),
		auxiliary: auxiliary(),
		live_activity: [
			{
				id: "la-1",
				ts: minutesAgo(2),
				role: "frontend",
				task_id: 261,
				action: "l0_injection",
				count_value: 1_820,
				count_unit: "tokens",
				status: "ok",
				summary_1line: "Folded L0 card injected for the frontend lead turn",
			},
		],
	};
}

/** `/health` ok but past cadence (spec-states.md §4 `stale`). */
export function staleOverview(): OpenVikingOverviewResponse {
	const base = liveOverview();
	return {
		...base,
		screen_state: "stale",
		health_state: "stale",
		observer: {
			...base.observer,
			mode_label: "Degraded Local Fallback",
			checked_at: minutesAgo(19),
			last_reachable_at: minutesAgo(19),
			health_state: "stale",
			stale_badge: "> 30s",
		},
		metrics: { ...base.metrics, last_recorded_at: minutesAgo(21), health_state: "stale", stale_badge: "> 5m" },
		changelog: { ...base.changelog, last_event_at: minutesAgo(42), health_state: "stale", stale_badge: "> 15m" },
		auxiliary: auxiliary(2),
	};
}

/** Online, nothing in the 24h window (spec-states.md §4 `empty`). */
export function emptyOverview(): OpenVikingOverviewResponse {
	const base = liveOverview();
	return {
		...base,
		screen_state: "empty",
		health_state: "zero-activity",
		observer: { ...base.observer, health_state: "zero-activity" },
		changelog: {
			session_commits_24h: 0,
			promotions_24h: 0,
			rejected_24h: 0,
			last_event_at: null,
			health_state: "zero-activity",
			stale_badge: null,
		},
		live_activity: [],
	};
}

/**
 * `:1933` unreachable (spec-states.md §4 `error`): daemon figures are null; the JSONL-fed panels
 * keep their counts and ages. `lastReachableAt` is the one knob the A38/A39 tests flip.
 */
export function offlineOverview(lastReachableAt: string | null = minutesAgo(18)): OpenVikingOverviewResponse {
	const base = liveOverview();
	return {
		...base,
		screen_state: "error",
		health_state: "server-unreachable",
		observer: {
			...base.observer,
			mode_label: "Offline",
			role_memory_folder_count: null,
			checked_at: secondsAgo(4),
			last_reachable_at: lastReachableAt,
			health_state: "server-unreachable",
			stale_badge: null,
			last_injection_at: null,
			last_commit_at: null,
			retrieval_latency_avg_ms: null,
			retrieval_hit_rate_pct: null,
			store_counts: storeCounts(false),
		},
		metrics: { ...base.metrics, last_recorded_at: minutesAgo(18), health_state: "stale", stale_badge: "> 5m" },
		changelog: { ...base.changelog, last_event_at: minutesAgo(23), health_state: "stale", stale_badge: "> 15m" },
	};
}

const entry = (
	over: Partial<OpenVikingExplorerEntry> & Pick<OpenVikingExplorerEntry, "uri">,
): OpenVikingExplorerEntry => ({
	canonical_uri: over.uri,
	title: "Untitled",
	category: "resource",
	scope: "resources",
	layer: "layer1_shared",
	role: null,
	layers: ["L0", "L1", "L2"],
	l0_abstract: "One-line abstract.",
	l1_overview: "Overview body.",
	l2_content: "Full content body.",
	updated_at: minutesAgo(45),
	provenance: {
		action: "resource_sync",
		source: "wt_land",
		role: "systems",
		task_id: 812,
		guard_verdict: "allowed",
		updated_at: minutesAgo(45),
	},
	...over,
});

export const ISOLATED_ROLE_SECRET = "Design's private note that must never reach another role's screen";

/**
 * A personal (agent) row that still carries content, as a buggy or future upstream could send it.
 * The dashboard must keep it off the screen anyway: isolation is enforced in the view too, not only
 * in the server (`R-ISOLATION-1`).
 */
export function leakyAgentEntry(): OpenVikingExplorerEntry {
	return entry({
		uri: "viking://agent/memories/cases/leaky.md",
		title: "Design case leaky",
		category: "case",
		scope: "agent",
		layer: "layer2_personal",
		role: "design",
		layers: ["L0", "L1", "L2"],
		l0_abstract: ISOLATED_AGENT_MEMORY_ABSTRACT,
		l1_overview: ISOLATED_ROLE_SECRET,
		l2_content: ISOLATED_ROLE_SECRET,
		updated_at: minutesAgo(33),
	});
}

export function entriesResponse(): OpenVikingEntriesResponse {
	return {
		panel_updated_at: minutesAgo(3),
		health_state: "healthy",
		stale_badge: null,
		entries: [
			entry({
				uri: "viking://resources/rollcall/core/map.md",
				canonical_uri: FIXTURE_STORAGE_PATH,
				title: "RollCall repo map",
				category: "resource",
				updated_at: minutesAgo(45),
			}),
			entry({
				uri: "viking://resources/rollcall/features/roll-ladder/spec.md",
				title: "Roll ladder spec",
				category: "spec",
				updated_at: hoursAgo(5),
			}),
			entry({
				uri: "viking://resources/pi-web-ui/core/map.md",
				title: "pi-web-ui repo map",
				category: "resource",
				updated_at: minutesAgo(52),
			}),
			entry({
				uri: "viking://user/default/memories/preferences/frontend_code.md",
				title: "Frontend code preferences",
				category: "preference",
				scope: "user",
				updated_at: daysAgo(2),
			}),
			entry({
				uri: "viking://agent/memories/cases/n126.md",
				title: "Design case n126",
				category: "case",
				scope: "agent",
				layer: "layer2_personal",
				role: "design",
				layers: ["L0"],
				l0_abstract: ISOLATED_AGENT_MEMORY_ABSTRACT,
				l1_overview: null,
				l2_content: null,
				updated_at: minutesAgo(90),
			}),
			entry({
				uri: "viking://agent/memories/instructions/preferences.md",
				title: "Ops role preferences",
				category: "preference",
				scope: "agent",
				layer: "layer2_personal",
				role: "ops",
				layers: ["L0"],
				l0_abstract: ISOLATED_AGENT_MEMORY_ABSTRACT,
				l1_overview: null,
				l2_content: null,
				updated_at: hoursAgo(7),
			}),
		],
	};
}

const auditEvent = (
	over: Partial<OpenVikingAuditEvent> & Pick<OpenVikingAuditEvent, "id" | "action">,
): OpenVikingAuditEvent => ({
	raw_action: "add",
	source: "queue_done",
	role: "frontend",
	task_id: 261,
	uri: "viking://session/2026-11-12-frontend-261",
	l0_abstract: "Session committed its own work.",
	summary_1line: "Session commit recorded by the commit guard",
	guard_verdict: "allowed",
	ts: minutesAgo(5),
	...over,
});

export function auditResponse(): OpenVikingAuditResponse {
	return {
		panel_updated_at: minutesAgo(4),
		health_state: "healthy",
		stale_badge: null,
		events: [
			auditEvent({ id: "ev-1", action: "commit" }),
			auditEvent({
				id: "ev-2",
				action: "role_memory_write",
				raw_action: "update",
				source: "lead_direct",
				role: "design",
				uri: "viking://agent/memories/cases/n126.md",
				l0_abstract: ISOLATED_AGENT_MEMORY_ABSTRACT,
				summary_1line: "",
				ts: minutesAgo(12),
			}),
			auditEvent({
				id: "ev-3",
				action: "promote_shared",
				raw_action: "resource_sync",
				source: "wt_land",
				role: "systems",
				uri: "viking://resources/pi-web-ui/core/map.md",
				summary_1line: "Repo resource promoted to the shared layer",
				ts: minutesAgo(26),
			}),
			auditEvent({
				id: "ev-4",
				action: "reject_noise",
				raw_action: "preference_write_blocked",
				source: "commit_guard",
				role: "backend",
				uri: "viking://user/default/memories/preferences/backend_code.md",
				summary_1line: "Worker preference write blocked by the commit guard",
				guard_verdict: "rejected",
				ts: minutesAgo(38),
			}),
			auditEvent({
				id: "ev-5",
				action: "sidecar_timeout",
				raw_action: "sidecar_timeout",
				source: "sidecar",
				role: "qa",
				uri: "viking://session/2026-11-12-qa-404",
				summary_1line: "Sidecar did not answer within the budget",
				guard_verdict: "degraded_skip",
				ts: hoursAgo(3),
			}),
		],
	};
}
