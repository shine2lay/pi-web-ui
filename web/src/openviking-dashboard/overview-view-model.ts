/**
 * OpenViking Memory Dashboard — `GET /api/openviking/overview` -> status header and the five
 * context-mount rows (frontend #258 implements the #261 seam).
 */

import type { OpenVikingOverviewResponse } from "../../../server/openviking/types.js";
import { OPENVIKING_CONTEXT_SLOTS } from "../../../server/openviking/types.js";
import { formatFigure, formatLastAnswered, formatPanelAge, formatPercent, loadingValue, textValue } from "./format.js";
import {
	buildNotMeasuredPresentation,
	buildStatePresentation,
	findSlot,
	measuredSlotState,
} from "./state-presentation.js";
import { OPENVIKING_SOURCE_FIELDS, roleMemoryFolderCountText } from "./text.js";
import type { OpenVikingRenderState, OpenVikingSlotRowModel, OpenVikingStatusHeaderModel } from "./view-model-types.js";

export { buildStatePresentation } from "./state-presentation.js";
export { buildSummaryCards } from "./summary-cards.js";

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
	const fields = OPENVIKING_SOURCE_FIELDS;
	if (overview === null) {
		return {
			renderState,
			presentation: buildStatePresentation("loading", null),
			modeLabel: null,
			roleMemoryFolders: loadingValue(fields.folderCount),
			daemonBind: loadingValue(fields.daemonBind),
			daemonCheck: "checking",
			checkedAge: loadingValue(fields.checkedAt),
			lastAnswered: null,
		};
	}

	const observer = overview.observer;
	const folders =
		observer.role_memory_folder_count === null
			? formatFigure(null, fields.folderCount)
			: textValue(roleMemoryFolderCountText(observer.role_memory_folder_count), fields.folderCount);

	return {
		renderState,
		presentation: buildStatePresentation(observer.health_state, observer.stale_badge),
		modeLabel: observer.mode_label,
		roleMemoryFolders: folders,
		daemonBind: textValue(observer.daemon_bind, fields.daemonBind),
		daemonCheck: observer.health_state === "server-unreachable" ? "no-answer" : "answers",
		checkedAge:
			formatPanelAge("Checked", observer.checked_at, nowMs, fields.checkedAt) ?? loadingValue(fields.checkedAt),
		// Best-effort context for an outage only; it gates nothing and is absent in every other state.
		lastAnswered: renderState === "error" ? formatLastAnswered(observer.last_reachable_at, nowMs) : null,
	};
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
	const fields = OPENVIKING_SOURCE_FIELDS;
	const loading = overview === null || renderState === "loading";

	return OPENVIKING_CONTEXT_SLOTS.map((definition): OpenVikingSlotRowModel => {
		const found = findSlot(overview, definition.slot_id);
		// A slot nothing samples yet has no figures at all: it is read as unmeasured, never as a zero.
		const measuredState = measuredSlotState(found);
		const slot = measuredState === null ? null : found;
		const hitRateMissing = slot === null || slot.hit_rate_pct === null;
		const tokensMissing = slot === null || slot.avg_tokens === null;

		return {
			slotId: definition.slot_id,
			label: definition.label,
			uriPrefix: definition.uri_prefix,
			hitRate: loading
				? loadingValue(fields.slotHitRatePerSlot)
				: formatPercent(slot?.hit_rate_pct ?? null, fields.slotHitRatePerSlot, { notMeasured: hitRateMissing }),
			avgTokens: loading
				? loadingValue(fields.slotAvgTokens)
				: formatFigure(slot?.avg_tokens ?? null, fields.slotAvgTokens, {
						notMeasured: tokensMissing,
						suffix: "avg tok",
					}),
			presentation: loading
				? buildStatePresentation("loading", null)
				: measuredState === null
					? buildNotMeasuredPresentation()
					: buildStatePresentation(measuredState, null),
			age:
				formatPanelAge("Sampled", found?.last_sampled_at ?? null, nowMs, fields.slotSampledAt) ??
				formatFigure(null, fields.slotSampledAt, { notMeasured: true }),
			tooltipId: `openviking-slot-tip-${definition.slot_id}`,
		};
	});
}
