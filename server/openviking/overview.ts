/**
 * OpenViking Memory Dashboard — `GET /api/openviking/overview`: every sum, average, percentage and
 * health verdict the page shows is computed here (the browser only formats, spec A07).
 */
import { auditActionOf, buildLiveActivity } from "./activity.js";
import type { OpenVikingDaemonHttp } from "./daemon-http.js";
import { readObserverSnapshot, type OpenVikingObserverSnapshot } from "./observer.js";
import {
	readChangelogRecords,
	readMetricsRecords,
	readMigrationState,
	readResourceSyncState,
	readRolloutState,
	readSeenRoleMessages,
	type OpenVikingChangelogRecord,
	type OpenVikingMetricsRecord,
	type OpenVikingRolloutState,
	type OpenVikingStatePaths,
} from "./state-files.js";
import {
	OPENVIKING_CONTEXT_SLOTS,
	OPENVIKING_ROLES,
	OVERVIEW_CHANGELOG_CADENCE_MS,
	OVERVIEW_METRICS_CADENCE_MS,
	WINDOW_24H_MS,
	type OpenVikingAuxiliaryState,
	type OpenVikingChangelogSummary,
	type OpenVikingHealthState,
	type OpenVikingMetricsSummary,
	type OpenVikingObserverSummary,
	type OpenVikingOverviewResponse,
	type OpenVikingScreenState,
	type OpenVikingSlotSummary,
} from "./types.js";

const round1 = (v: number) => Math.round(v * 10) / 10;
const isoOrNull = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const latestMs = (rows: readonly { tsMs: number }[]) => rows.reduce((m, r) => Math.max(m, r.tsMs), -Infinity);

/** Zero events in the window -> zero-activity; newest older than the cadence -> stale. */
export function panelHealth<B extends string>(
	eventsInWindow: number,
	lastMs: number,
	nowMs: number,
	cadenceMs: number,
	badge: B,
): { health_state: OpenVikingHealthState; stale_badge: B | null } {
	if (eventsInWindow === 0) return { health_state: "zero-activity", stale_badge: null };
	if (!Number.isFinite(lastMs) || nowMs - lastMs > cadenceMs) return { health_state: "stale", stale_badge: badge };
	return { health_state: "healthy", stale_badge: null };
}

export function summarizeMetrics(records: readonly OpenVikingMetricsRecord[], nowMs: number): OpenVikingMetricsSummary {
	const recent = records.filter((r) => nowMs - r.tsMs <= WINDOW_24H_MS);
	const injections = recent.flatMap((r) => (r.injection ? [r.injection] : []));
	const hits = injections.map((i) => i.l0HitCount).filter((v): v is number => v !== null);
	const tokens = injections.map((i) => i.injectedTokensEst).filter((v): v is number => v !== null);
	const last = latestMs(records);
	return {
		slot_hit_rate_pct: hits.length ? round1((100 * hits.filter((h) => h > 0).length) / hits.length) : null,
		avg_injected_tokens: tokens.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) : null,
		turns_sampled_24h: injections.length,
		mode1_lead_l0_injections_24h: injections.filter((i) => i.mode === "lead").length,
		mode2_worker_turn1_prefetches_24h: injections.filter((i) => i.mode === "worker").length,
		lead_200k_commits_24h: recent.filter((r) => r.event === "lead_200k_commit").length,
		rm_dedup_skipped_24h: recent.reduce((n, r) => n + (r.dedupSkippedCount ?? 0), 0),
		last_recorded_at: isoOrNull(last),
		...panelHealth(recent.length, last, nowMs, OVERVIEW_METRICS_CADENCE_MS, "> 5m" as const),
	};
}

/** A slot `skipped` (no project slug) or `unavailable` (server error) made no lookup, so it is not a miss (#809). */
const NOT_LOOKED_UP = new Set(["skipped", "unavailable"]);

/** G3: per-slot figures exist only once injection lines carry `slots[]`; until then `unmeasured-gap`. */
export function summarizeSlots(records: readonly OpenVikingMetricsRecord[], nowMs: number): OpenVikingSlotSummary[] {
	const recent = records.filter((r) => nowMs - r.tsMs <= WINDOW_24H_MS && r.injection?.slots);
	return OPENVIKING_CONTEXT_SLOTS.map((def) => {
		const samples = recent.flatMap((r) =>
			(r.injection?.slots ?? []).filter((s) => s.slot === def.slot_id).map((s) => ({ ...s, tsMs: r.tsMs })),
		);
		const base = { slot_id: def.slot_id, label: def.label, uri_prefix: def.uri_prefix };
		if (samples.length === 0) {
			return { ...base, hit_rate_pct: null, avg_tokens: null, state: "unmeasured-gap", last_sampled_at: null };
		}
		const lookedUp = samples.filter((s) => s.state === null || !NOT_LOOKED_UP.has(s.state));
		const hits = lookedUp.filter((s) => s.state === "hit" || (s.l0HitCount ?? 0) > 0).length;
		const tokens = lookedUp.map((s) => s.injectedTokensEst).filter((v): v is number => v !== null);
		const last = latestMs(samples);
		const health = panelHealth(hits, last, nowMs, OVERVIEW_METRICS_CADENCE_MS, "> 5m");
		return {
			...base,
			hit_rate_pct: lookedUp.length ? round1((100 * hits) / lookedUp.length) : null,
			avg_tokens: tokens.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) : null,
			state: health.health_state,
			last_sampled_at: isoOrNull(last),
		};
	});
}

export function summarizeChangelog(
	records: readonly OpenVikingChangelogRecord[],
	nowMs: number,
): OpenVikingChangelogSummary {
	const recent = records.filter((r) => nowMs - r.tsMs <= WINDOW_24H_MS && r.action !== null);
	const actions = recent.map(auditActionOf);
	const last = latestMs(records.filter((r) => r.action !== null));
	return {
		commits_24h: actions.filter((a) => a === "commit").length,
		promotions_24h: actions.filter((a) => a === "promote_shared").length,
		rejected_24h: actions.filter((a) => a === "reject_noise").length,
		last_event_at: isoOrNull(last),
		...panelHealth(recent.length, last, nowMs, OVERVIEW_CHANGELOG_CADENCE_MS, "> 15m" as const),
	};
}

/** Degraded: wt land syncs waiting, roles on the local fallback, or fewer than all roles live. */
function isDegraded(snapshot: OpenVikingObserverSnapshot, rollout: OpenVikingRolloutState, totalRoles: number) {
	return (
		rollout.pending_wt_land_syncs.length > 0 ||
		rollout.fallback_roles.length > 0 ||
		(snapshot.roles_online_count !== null && snapshot.roles_online_count < totalRoles)
	);
}

const HEALTH_BY_SCREEN: Record<OpenVikingScreenState, OpenVikingHealthState> = {
	live: "healthy",
	stale: "stale",
	empty: "zero-activity",
	error: "server-unreachable",
};

function screenStateOf(
	snapshot: OpenVikingObserverSnapshot,
	degraded: boolean,
	metrics: OpenVikingMetricsSummary,
	changelog: OpenVikingChangelogSummary,
): OpenVikingScreenState {
	if (!snapshot.reachable) return "error";
	if (degraded) return "stale";
	const panels = [metrics.health_state, changelog.health_state];
	if (panels.every((h) => h === "zero-activity")) return "empty";
	return panels.includes("stale") ? "stale" : "live";
}

export async function buildOverview(
	http: OpenVikingDaemonHttp,
	paths: OpenVikingStatePaths,
	nowMs: number,
	daemonBind: string,
): Promise<OpenVikingOverviewResponse> {
	const [snapshot, metricsRecords, changelogRecords, rollout, resourceSync, migration, seen] = await Promise.all([
		readObserverSnapshot(http),
		readMetricsRecords(paths),
		readChangelogRecords(paths),
		readRolloutState(paths),
		readResourceSyncState(paths),
		readMigrationState(paths),
		readSeenRoleMessages(paths),
	]);
	const metrics = summarizeMetrics(metricsRecords, nowMs);
	const changelog = summarizeChangelog(changelogRecords, nowMs);
	const totalRoles = OPENVIKING_ROLES.length;
	const degraded = isDegraded(snapshot, rollout, totalRoles);
	const screen_state = screenStateOf(snapshot, degraded, metrics, changelog);
	const lastInjection = latestMs(metricsRecords.filter((r) => r.injection));
	const lastCommit = latestMs(changelogRecords.filter((r) => auditActionOf(r) === "commit"));

	const observer: OpenVikingObserverSummary = {
		mode_label: !snapshot.reachable ? "Offline" : degraded ? "Degraded Local Fallback" : "Active (15/15 Roles Live)",
		roles_online_count: snapshot.roles_online_count,
		roles_total_count: totalRoles,
		daemon_bind: daemonBind,
		queue_depth: snapshot.queue_depth,
		checked_at: new Date(nowMs).toISOString(),
		health_state: !snapshot.reachable ? "server-unreachable" : degraded ? "stale" : "healthy",
		stale_badge: null,
		last_injection_at: isoOrNull(lastInjection),
		last_commit_at: isoOrNull(lastCommit),
		retrieval_latency_avg_ms: snapshot.retrieval_latency_avg_ms,
		retrieval_hit_rate_pct: snapshot.retrieval_hit_rate_pct,
		store_counts: snapshot.store_counts,
	};
	const pendingSyncs = rollout.pending_wt_land_syncs.length;
	const auxiliary: OpenVikingAuxiliaryState = {
		rollout,
		resource_sync: {
			synced_at: resourceSync.synced_at,
			repos_synced: resourceSync.repos_synced,
			pending_syncs_count: pendingSyncs,
			status: !resourceSync.present ? "missing" : pendingSyncs > 0 || resourceSync.status !== "ok" ? "pending" : "ok",
		},
		migration: {
			verified_at: migration?.verified_at ?? null,
			checked_at: migration?.verified_at ?? null,
			status: migration?.status ?? null,
			roles_passed: migration?.roles_passed ?? null,
			total_roles: migration?.total_roles ?? null,
			repos_passed: migration?.repos_passed ?? null,
			total_repos: migration?.total_repos ?? null,
			total_checked: migration?.total_checked ?? null,
		},
		dedup: { seen_count: seen?.seen_count ?? null, updated_at: seen?.updated_at ?? null },
	};
	return {
		screen_state,
		health_state: HEALTH_BY_SCREEN[screen_state],
		observer,
		metrics,
		changelog,
		slots: summarizeSlots(metricsRecords, nowMs),
		auxiliary,
		live_activity: buildLiveActivity(changelogRecords, metricsRecords),
	};
}
