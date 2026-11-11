/**
 * OpenViking Memory Dashboard — one state, one set of visuals (frontend #258).
 *
 * design.md §Screen States: every state carries a glyph and a `data-icon` as well as a colour, so
 * the state is readable without colour. The stale badge is the API's own `stale_badge` string,
 * verbatim: the browser never invents an age (ruling rm-b5272a3e).
 */

import { OPENVIKING_LOADING_TEXT } from "./text.js";
import type { OpenVikingStatePresentation } from "./view-model-types.js";

interface StateVisuals {
	readonly label: string;
	readonly glyph: string | null;
	readonly dataIcon: string | null;
	readonly border: OpenVikingStatePresentation["border"];
}

const STATE_VISUALS: Record<OpenVikingStatePresentation["healthState"], StateVisuals> = {
	healthy: { label: "Healthy", glyph: "●", dataIcon: "circle-check", border: "solid" },
	stale: { label: "Stale", glyph: "◐", dataIcon: "clock-stale", border: "dashed" },
	"zero-activity": { label: "Zero Activity", glyph: "◌", dataIcon: "circle-empty", border: "dotted" },
	"server-unreachable": { label: "Server Unreachable", glyph: "✕", dataIcon: "octagon-x", border: "double" },
	loading: { label: OPENVIKING_LOADING_TEXT, glyph: null, dataIcon: null, border: "none" },
};

/** The neutral pill for a figure nothing measures yet (spec G3): never a healthy "Hit" badge. */
export const NOT_MEASURED_VISUALS: StateVisuals = {
	label: "Not measured",
	glyph: "○",
	dataIcon: "circle-dotted",
	border: "dotted",
};

/**
 * A panel's pill: its own `health_state` plus the glyph, `data-icon` and border that make the state
 * readable without colour. `staleBadge` is the API's own `stale_badge` string, verbatim.
 */
export function buildStatePresentation(
	healthState: OpenVikingStatePresentation["healthState"],
	staleBadge: string | null,
): OpenVikingStatePresentation {
	const visuals = STATE_VISUALS[healthState];
	// The badge is appended, never parsed: "Stale (pending sync)" must not read as an age.
	const label = healthState === "stale" && staleBadge !== null ? `${visuals.label} (${staleBadge})` : visuals.label;
	return {
		healthState,
		label,
		glyph: visuals.glyph,
		dataIcon: visuals.dataIcon,
		border: visuals.border,
		staleBadge,
	};
}

/** A slot row's pill while nothing samples it: neutral wording, its own glyph, no health claim. */
export function buildNotMeasuredPresentation(): OpenVikingStatePresentation {
	return {
		healthState: "zero-activity",
		label: NOT_MEASURED_VISUALS.label,
		glyph: NOT_MEASURED_VISUALS.glyph,
		dataIcon: NOT_MEASURED_VISUALS.dataIcon,
		border: NOT_MEASURED_VISUALS.border,
		staleBadge: null,
	};
}
