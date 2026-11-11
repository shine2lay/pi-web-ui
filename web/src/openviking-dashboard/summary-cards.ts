/**
 * OpenViking Memory Dashboard — the three Tier-1 summary cards (frontend #258).
 *
 * Each card carries its own panel's `health_state`, never the screen's: while `:1933` is down the
 * two local-log cards keep their counts and their own staleness, and only the daemon card reads
 * "Server Unreachable" (design.md §Per-card pills). At most five text fields per card.
 */

import type { OpenVikingOverviewResponse } from "../../../server/openviking/types.js";
import { formatFigure, formatPanelAge, formatPercent, loadingValue, textValue } from "./format.js";
import { buildStatePresentation } from "./state-presentation.js";
import {
	guardRejectionsText,
	OPENVIKING_CARD_TEXT,
	OPENVIKING_LOCAL_AUDIT_SOURCE_TEXT,
	OPENVIKING_LOCAL_METRICS_SOURCE_TEXT,
	OPENVIKING_QUEUE_DEPTH_TEXT,
	OPENVIKING_SOURCE_FIELDS,
	OPENVIKING_ZERO_ACTIVITY_TEXT,
	sessionCommitsText,
	sharedPromotionsText,
} from "./text.js";
import type {
	OpenVikingDisplayValue,
	OpenVikingRenderState,
	OpenVikingSummaryCardId,
	OpenVikingSummaryCardModel,
} from "./view-model-types.js";

const CARD_ORDER: readonly OpenVikingSummaryCardId[] = ["system-health", "context-injection", "commit-governance"];

const F = OPENVIKING_SOURCE_FIELDS;

function loadingCards(): readonly OpenVikingSummaryCardModel[] {
	return CARD_ORDER.map((cardId) => ({
		cardId,
		title: OPENVIKING_CARD_TEXT[cardId].title,
		presentation: buildStatePresentation("loading", null),
		panelUpdatedAt: null,
		age: null,
		sourceNote: null,
		fields: [loadingValue(cardId === "system-health" ? F.checkedAt : F.metricsRecordedAt)],
	}));
}

function healthCard(overview: OpenVikingOverviewResponse, nowMs: number): OpenVikingSummaryCardModel {
	const observer = overview.observer;
	const store = observer.store_counts;
	const fields: OpenVikingDisplayValue[] = [
		textValue(observer.daemon_bind, F.daemonBind),
		// R-QUEUE-DEPTH-1: null in v1. "Unavailable" is the truth; a 0 would read as an idle queue.
		textValue(`Queue depth: ${OPENVIKING_QUEUE_DEPTH_TEXT}`, F.queueDepth),
		formatPercent(observer.retrieval_hit_rate_pct, F.retrievalHitRate, { suffix: "retrieval hit rate" }),
		formatFigure(store.layer1_shared.total_count, F.layer1Total, { suffix: "shared items" }),
		formatFigure(store.layer2_personal.total_count, F.layer2Total, { suffix: "personal items" }),
	];
	return {
		cardId: "system-health",
		title: OPENVIKING_CARD_TEXT["system-health"].title,
		presentation: buildStatePresentation(observer.health_state, observer.stale_badge),
		panelUpdatedAt: observer.checked_at,
		age: formatPanelAge("Checked", observer.checked_at, nowMs, F.checkedAt),
		// The daemon card has no local fallback: when `:1933` is down its figures are simply absent.
		sourceNote: null,
		fields,
	};
}

function injectionCard(
	overview: OpenVikingOverviewResponse,
	nowMs: number,
	offline: boolean,
): OpenVikingSummaryCardModel {
	const metrics = overview.metrics;
	const fields: OpenVikingDisplayValue[] = [
		formatPercent(metrics.slot_hit_rate_pct, F.slotHitRate, { suffix: "slot hit rate" }),
		formatFigure(metrics.avg_injected_tokens, F.avgInjectedTokens, { suffix: "avg tok" }),
		formatFigure(metrics.turns_sampled_24h, F.turnsSampled, { suffix: "turns sampled (24h)" }),
		formatFigure(metrics.mode1_lead_l0_injections_24h, F.mode1Injections, { suffix: "lead L0 injections" }),
		// spec G3: nothing samples a single slot yet, so the per-slot row stays neutral.
		formatFigure(null, F.slotHitRatePerSlot, { notMeasured: true, notMeasuredSuffix: "per slot" }),
	];
	return {
		cardId: "context-injection",
		title: OPENVIKING_CARD_TEXT["context-injection"].title,
		presentation: buildStatePresentation(metrics.health_state, metrics.stale_badge),
		panelUpdatedAt: metrics.last_recorded_at,
		age: formatPanelAge("Last turn", metrics.last_recorded_at, nowMs, F.metricsRecordedAt),
		sourceNote: offline ? OPENVIKING_LOCAL_METRICS_SOURCE_TEXT : null,
		fields,
	};
}

function governanceCard(
	overview: OpenVikingOverviewResponse,
	nowMs: number,
	offline: boolean,
): OpenVikingSummaryCardModel {
	const changelog = overview.changelog;
	const fields: OpenVikingDisplayValue[] = [
		// "N session commits": a session committing its own work, never a bare "commits".
		textValue(sessionCommitsText(changelog.session_commits_24h), F.sessionCommits),
		textValue(sharedPromotionsText(changelog.promotions_24h), F.promotions),
		textValue(guardRejectionsText(changelog.rejected_24h), F.rejected),
	];
	if (changelog.health_state === "zero-activity") {
		fields.push(textValue(OPENVIKING_ZERO_ACTIVITY_TEXT, F.changelogEventAt));
	}
	return {
		cardId: "commit-governance",
		title: OPENVIKING_CARD_TEXT["commit-governance"].title,
		presentation: buildStatePresentation(changelog.health_state, changelog.stale_badge),
		panelUpdatedAt: changelog.last_event_at,
		age: formatPanelAge("Updated", changelog.last_event_at, nowMs, F.changelogEventAt),
		sourceNote: offline ? OPENVIKING_LOCAL_AUDIT_SOURCE_TEXT : null,
		fields,
	};
}

/**
 * The three summary cards, in order: `system-health` (30s), `context-injection` (5m),
 * `commit-governance` (15m).
 */
export function buildSummaryCards(
	overview: OpenVikingOverviewResponse | null,
	nowMs: number,
	renderState: OpenVikingRenderState,
): readonly OpenVikingSummaryCardModel[] {
	if (overview === null || renderState === "loading") return loadingCards();
	const offline = overview.observer.health_state === "server-unreachable";
	return [
		healthCard(overview, nowMs),
		injectionCard(overview, nowMs, offline),
		governanceCard(overview, nowMs, offline),
	];
}
