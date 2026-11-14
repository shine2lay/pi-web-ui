/**
 * OpenViking memory — `GET /api/openviking/overview`: the Memory Explorer's health line. Every verdict is computed
 * here (the browser only formats, spec A07); the answer carries only what the explorer reads (spec-explorer-build.md).
 */
import type { OpenVikingDaemonHttp } from "./daemon-http.js";
import {
	isMemoryWrite,
	readChangelogRecords,
	readMetricsRecords,
	readRolloutState,
	type OpenVikingChangelogRecord,
	type OpenVikingMetricsRecord,
	type OpenVikingRolloutState,
	type OpenVikingStatePaths,
} from "./state-files.js";
import {
	OPENVIKING_PENDING_SYNC_BADGE,
	OVERVIEW_CHANGELOG_CADENCE_MS,
	OVERVIEW_METRICS_CADENCE_MS,
	OpenVikingDashboardError,
	WINDOW_24H_MS,
	type OpenVikingHealthState,
	type OpenVikingOverviewResponse,
	type OpenVikingScreenState,
} from "./types.js";
import { resolveRequestHeaders } from "./uri.js";

const isoOrNull = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const latestMs = (rows: readonly { tsMs: number }[]) => rows.reduce((m, r) => Math.max(m, r.tsMs), -Infinity);

/**
 * The one rule every reading's `(health_state, stale_badge)` comes from (spec-states.md §4, ruling rm-b5272a3e).
 *
 * No data in the window -> zero-activity. Newest data past the cadence -> stale, badged with the age; **the age
 * wins** over a waiting sync. Inside the cadence while a `wt land` sync waits -> stale, badged `sync.badge`
 * (`"pending sync"`) and **never an age**, so a badge never names a cause the reading does not have (#138 row 32).
 */
export function panelHealth<B extends string, S extends string = never>(
	dataCount: number,
	lastMs: number,
	nowMs: number,
	cadenceMs: number,
	ageBadge: B,
	sync?: { pending: number; badge: S },
): { health_state: OpenVikingHealthState; stale_badge: B | S | null } {
	if (dataCount === 0) return { health_state: "zero-activity", stale_badge: null };
	if (!Number.isFinite(lastMs) || nowMs - lastMs > cadenceMs) return { health_state: "stale", stale_badge: ageBadge };
	if (sync && sync.pending > 0) return { health_state: "stale", stale_badge: sync.badge };
	return { health_state: "healthy", stale_badge: null };
}

/** The sync half of that rule, read from `rollout-state.json` in one place. */
export const pendingSyncCause = (rollout: OpenVikingRolloutState) => ({
	pending: rollout.pending_wt_land_syncs.length,
	badge: OPENVIKING_PENDING_SYNC_BADGE,
});

/**
 * How fresh the injection samples are. #828: a line whose `session_id` is not a pi session uuid is not a live
 * sample — it is evidence of a bad write — so freshness is read off pi sessions only.
 */
function metricsHealth(records: readonly OpenVikingMetricsRecord[], nowMs: number): OpenVikingHealthState {
	const pi = records.filter((r) => r.piSession);
	const recent = pi.filter((r) => nowMs - r.tsMs <= WINDOW_24H_MS);
	return panelHealth(recent.length, latestMs(pi), nowMs, OVERVIEW_METRICS_CADENCE_MS, "> 5m").health_state;
}

/** How fresh the memory writes are. */
function changelogHealth(records: readonly OpenVikingChangelogRecord[], nowMs: number): OpenVikingHealthState {
	const writes = records.filter(isMemoryWrite);
	const recent = writes.filter((r) => nowMs - r.tsMs <= WINDOW_24H_MS);
	return panelHealth(recent.length, latestMs(writes), nowMs, OVERVIEW_CHANGELOG_CADENCE_MS, "> 15m").health_state;
}

/** Degraded: wt land syncs waiting or roles on the local fallback. */
const isDegraded = (rollout: OpenVikingRolloutState) =>
	rollout.pending_wt_land_syncs.length > 0 || rollout.fallback_roles.length > 0;

const HEALTH_BY_SCREEN: Record<OpenVikingScreenState, OpenVikingHealthState> = {
	live: "healthy",
	stale: "stale",
	empty: "zero-activity",
	error: "server-unreachable",
};

function screenStateOf(
	reachable: boolean,
	degraded: boolean,
	readings: OpenVikingHealthState[],
): OpenVikingScreenState {
	if (!reachable) return "error";
	if (degraded) return "stale";
	if (readings.every((h) => h === "zero-activity")) return "empty";
	return readings.includes("stale") ? "stale" : "live";
}

/**
 * The #144 fingerprint, made impossible: an answer that calls `:1933` unreachable while its own
 * `last_reachable_at` is later than its `checked_at` means `/health` answered ok inside this very request.
 * Reachability is `/health`'s alone (§4), so the pair cannot be built; if it ever is again, the request fails
 * loudly instead of showing the page a false "down".
 */
function assertUnreachableIsConsistent(overview: OpenVikingOverviewResponse): void {
	const { checked_at, last_reachable_at } = overview.observer;
	if (overview.health_state !== "server-unreachable" || last_reachable_at === null) return;
	if (Date.parse(last_reachable_at) <= Date.parse(checked_at)) return;
	throw new OpenVikingDashboardError(
		`OpenViking overview calls the daemon unreachable, but /health answered ok at ${last_reachable_at}, ` +
			`after this request's checked_at ${checked_at}`,
		500,
		"UNREACHABLE_CLAIM_INCONSISTENT",
		{ last_reachable_at, checked_at },
	);
}

export async function buildOverview(
	http: OpenVikingDaemonHttp,
	paths: OpenVikingStatePaths,
	nowMs: number,
): Promise<OpenVikingOverviewResponse> {
	// The one reachability verdict: `/health`. No other read may turn the answer unreachable (§4, #147).
	const [reachable, metricsRecords, changelogRecords, rollout] = await Promise.all([
		http.isHealthy(resolveRequestHeaders("user")),
		readMetricsRecords(paths),
		readChangelogRecords(paths),
		readRolloutState(paths),
	]);
	const readings = [metricsHealth(metricsRecords, nowMs), changelogHealth(changelogRecords, nowMs)];
	const screen_state = screenStateOf(reachable, isDegraded(rollout), readings);
	const overview: OpenVikingOverviewResponse = {
		screen_state,
		health_state: HEALTH_BY_SCREEN[screen_state],
		observer: {
			checked_at: new Date(nowMs).toISOString(),
			last_commit_at: isoOrNull(latestMs(changelogRecords.filter((r) => r.sessionCommit))),
			// Read after this request's /health; display only, nothing above derives from it (spec 895b0cb1).
			last_reachable_at: http.lastReachableAt,
		},
	};
	assertUnreachableIsConsistent(overview);
	return overview;
}
