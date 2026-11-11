/**
 * OpenViking Memory Dashboard — `GET /api/openviking/overview` -> status header, 3 summary cards,
 * 5 mount-map rows (frontend #261, Task 1 seam). Task 2 (#258) implements the bodies.
 */

import type { OpenVikingOverviewResponse } from "../../../server/openviking/types.js";
import { notImplemented } from "./not-implemented.js";
import type {
	OpenVikingRenderState,
	OpenVikingSlotRowModel,
	OpenVikingStatePresentation,
	OpenVikingStatusHeaderModel,
	OpenVikingSummaryCardModel,
} from "./view-model-types.js";

/**
 * Status header: mode badge (`observer.mode_label` verbatim), "N role memory folders" (a folder
 * count, never liveness), daemon bind, check age, and — in the `error` state only — the muted
 * "Last answered …" line from `observer.last_reachable_at`.
 */
export function buildStatusHeader(
	overview: OpenVikingOverviewResponse | null,
	nowMs: number,
	renderState: OpenVikingRenderState,
): OpenVikingStatusHeaderModel {
	void overview;
	void nowMs;
	void renderState;
	return notImplemented("buildStatusHeader");
}

/**
 * The three summary cards, in order: `system-health` (30s), `context-injection` (5m),
 * `commit-governance` (15m). Each carries its own panel's `health_state` (never the screen's) and
 * at most five text fields. `observer.queue_depth` is always null -> "Unavailable", never `0`.
 * `changelog.session_commits_24h` reads "N session commits", never a bare "commits".
 */
export function buildSummaryCards(
	overview: OpenVikingOverviewResponse | null,
	nowMs: number,
	renderState: OpenVikingRenderState,
): readonly OpenVikingSummaryCardModel[] {
	void overview;
	void nowMs;
	void renderState;
	return notImplemented("buildSummaryCards");
}

/**
 * The five context-mount rows, labelled exactly as `OPENVIKING_CONTEXT_SLOTS` in
 * `server/openviking/types.ts`. A slot whose `state` is `"unmeasured-gap"`, or whose `hit_rate_pct`
 * / `avg_tokens` is null, reads the neutral "Not measured" — never a green "Hit" badge (spec G3).
 */
export function buildSlotRows(
	overview: OpenVikingOverviewResponse | null,
	nowMs: number,
	renderState: OpenVikingRenderState,
): readonly OpenVikingSlotRowModel[] {
	void overview;
	void nowMs;
	void renderState;
	return notImplemented("buildSlotRows");
}

/**
 * A panel's pill: its own `health_state` plus the glyph, `data-icon` and border that make the state
 * readable without colour. `staleBadge` is the API's own `stale_badge` string, verbatim — the
 * browser never invents an age for a sync-caused stale.
 */
export function buildStatePresentation(
	healthState: OpenVikingStatePresentation["healthState"],
	staleBadge: string | null,
): OpenVikingStatePresentation {
	void healthState;
	void staleBadge;
	return notImplemented("buildStatePresentation");
}
