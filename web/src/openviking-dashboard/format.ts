/**
 * OpenViking Memory Dashboard — pure display formatting (frontend #261, Task 1 seam).
 *
 * Formatting only (spec.md `A07`): a timestamp becomes "18m ago", a number becomes text with its
 * source field. No sums, averages, percentages or health verdicts are computed here.
 *
 * Task 2 (#258) implements these; the signatures are the contract.
 */

import { notImplemented } from "./not-implemented.js";
import type { OpenVikingDisplayValue, OpenVikingLastAnsweredLine } from "./view-model-types.js";

/**
 * "4s" / "18m" / "3h" / "2d" — the age of `iso` at `nowMs`.
 *
 * Under 60s it reads in seconds (never "0m"); above 60m in hours, above 24h in days, so a long
 * outage never reads "4320m" (design #286 lead extension). Returns null for a null timestamp:
 * a missing timestamp has no age and must never be painted as `0` or "just now".
 */
export function formatAge(iso: string | null, nowMs: number): string | null {
	void iso;
	void nowMs;
	return notImplemented("formatAge");
}

/**
 * The muted line under the honest check line in the `error` state only:
 * "Last answered 18m ago" from `observer.last_reachable_at`, or
 * "No successful contact since the dashboard server started" when it is null (`isDuration: false`).
 */
export function formatLastAnswered(lastReachableAt: string | null, nowMs: number): OpenVikingLastAnsweredLine {
	void lastReachableAt;
	void nowMs;
	return notImplemented("formatLastAnswered");
}

/**
 * A counted figure with its source field, e.g. `formatFigure(48, "metrics.turns_sampled_24h",
 * { suffix: "turns" })` -> "48 turns". `null` renders "— (Unreachable)" with `unreachable: true`
 * (never `0`, never "Healthy"); `notMeasured` renders "Not measured" instead (spec G3).
 */
export function formatFigure(
	value: number | null,
	sourceField: string,
	options?: { readonly suffix?: string; readonly notMeasured?: boolean },
): OpenVikingDisplayValue {
	void value;
	void sourceField;
	void options;
	return notImplemented("formatFigure");
}

/**
 * A percentage the server already computed: "94.2%". `null` renders "— (Unreachable)";
 * an unmeasured slot renders "Not measured". The browser never derives a rate itself (`A07`).
 */
export function formatPercent(
	value: number | null,
	sourceField: string,
	options?: { readonly notMeasured?: boolean },
): OpenVikingDisplayValue {
	void value;
	void sourceField;
	void options;
	return notImplemented("formatPercent");
}

/** A row's visible URI: the logical `viking://…` form, never a 64-char hash or an AGFS storage path. */
export function formatDisplayUri(uri: string): string {
	void uri;
	return notImplemented("formatDisplayUri");
}

/**
 * "Checked 4s ago" / "Updated 18m ago" for a panel's own timestamp field.
 * Returns null when there is no timestamp: a panel with nothing to date shows no age line rather
 * than a `0`, a dash or an invented duration.
 */
export function formatPanelAge(
	label: string,
	iso: string | null,
	nowMs: number,
	sourceField: string,
): OpenVikingDisplayValue | null {
	void label;
	void iso;
	void nowMs;
	void sourceField;
	return notImplemented("formatPanelAge");
}
