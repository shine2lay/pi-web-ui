/**
 * OpenViking Memory Dashboard — pure display formatting (frontend #258 implements the #261 seam).
 *
 * Formatting only (spec.md `A07`): a timestamp becomes "18m ago", a number becomes text with its
 * source field. No sums, averages, percentages or health verdicts are computed here.
 */

import {
	OPENVIKING_LOADING_TEXT,
	OPENVIKING_NO_CONTACT_TEXT,
	OPENVIKING_NOT_MEASURED_TEXT,
	OPENVIKING_SOURCE_FIELDS,
	OPENVIKING_UNREACHABLE_TEXT,
} from "./text.js";
import type { OpenVikingDisplayValue, OpenVikingLastAnsweredLine } from "./view-model-types.js";

/** Wording the server already decided (a mode label, a bind address): painted as-is, with its field. */
export function textValue(text: string, sourceField: string, ariaLabel?: string): OpenVikingDisplayValue {
	return ariaLabel === undefined
		? { text, sourceField, unreachable: false, notMeasured: false }
		: { text, sourceField, unreachable: false, notMeasured: false, ariaLabel };
}

/** Before the first answer: no number is known yet, so nothing is painted that could read as one. */
export function loadingValue(sourceField: string): OpenVikingDisplayValue {
	return { text: OPENVIKING_LOADING_TEXT, sourceField, unreachable: false, notMeasured: false };
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * "4s" / "18m" / "3h" / "2d" — the age of `iso` at `nowMs`.
 *
 * Under 60s it reads in seconds (never "0m"); above 60m in hours, above 24h in days, so a long
 * outage never reads "4320m" (design #286 lead extension). Returns null for a null timestamp:
 * a missing timestamp has no age and must never be painted as `0` or "just now".
 */
export function formatAge(iso: string | null, nowMs: number): string | null {
	if (iso === null) return null;
	const parsed = Date.parse(iso);
	if (Number.isNaN(parsed)) return null;
	// A clock skew that puts the stamp in the future reads as "0s", never as a negative age.
	const elapsed = Math.max(0, nowMs - parsed);
	if (elapsed < MINUTE_MS) return `${Math.floor(elapsed / SECOND_MS)}s`;
	if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
	if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
	return `${Math.floor(elapsed / DAY_MS)}d`;
}

/**
 * The muted line under the honest check line in the `error` state only:
 * "Last answered 18m ago" from `observer.last_reachable_at`, or
 * "No successful contact since the dashboard server started" when it is null (`isDuration: false`).
 */
export function formatLastAnswered(lastReachableAt: string | null, nowMs: number): OpenVikingLastAnsweredLine {
	const age = formatAge(lastReachableAt, nowMs);
	if (age === null) {
		return {
			text: OPENVIKING_NO_CONTACT_TEXT,
			isDuration: false,
			sourceField: OPENVIKING_SOURCE_FIELDS.lastReachableAt,
		};
	}
	return {
		text: `Last answered ${age} ago`,
		isDuration: true,
		sourceField: OPENVIKING_SOURCE_FIELDS.lastReachableAt,
	};
}

/** Thousands separators so "1820 avg tok" reads as "1,820 avg tok" (design.md §Summary Cards). */
function groupDigits(value: number): string {
	return value.toLocaleString("en-US");
}

/**
 * A counted figure with its source field, e.g. `formatFigure(48, "metrics.turns_sampled_24h",
 * { suffix: "turns" })` -> "48 turns". `null` renders "— (Unreachable)" with `unreachable: true`
 * (never `0`, never "Healthy"); `notMeasured` renders "Not measured" instead (spec G3).
 */
export function formatFigure(
	value: number | null,
	sourceField: string,
	options?: { readonly suffix?: string; readonly notMeasured?: boolean; readonly notMeasuredSuffix?: string },
): OpenVikingDisplayValue {
	if (options?.notMeasured === true) {
		// The suffix names what is not measured, so the row is never a bare "Not measured".
		const unmeasured =
			options.notMeasuredSuffix === undefined
				? OPENVIKING_NOT_MEASURED_TEXT
				: `${OPENVIKING_NOT_MEASURED_TEXT} ${options.notMeasuredSuffix}`;
		return { text: unmeasured, sourceField, unreachable: false, notMeasured: true };
	}
	if (value === null) {
		return { text: OPENVIKING_UNREACHABLE_TEXT, sourceField, unreachable: true, notMeasured: false };
	}
	const suffix = options?.suffix;
	const text = suffix === undefined ? groupDigits(value) : `${groupDigits(value)} ${suffix}`;
	return { text, sourceField, unreachable: false, notMeasured: false };
}

/**
 * A percentage the server already computed: "94.2%". `null` renders "— (Unreachable)";
 * an unmeasured slot renders "Not measured". The browser never derives a rate itself (`A07`).
 */
export function formatPercent(
	value: number | null,
	sourceField: string,
	options?: { readonly notMeasured?: boolean; readonly suffix?: string },
): OpenVikingDisplayValue {
	if (options?.notMeasured === true) {
		return { text: OPENVIKING_NOT_MEASURED_TEXT, sourceField, unreachable: false, notMeasured: true };
	}
	if (value === null) {
		return { text: OPENVIKING_UNREACHABLE_TEXT, sourceField, unreachable: true, notMeasured: false };
	}
	// One decimal, and no trailing ".0": the server owns the arithmetic, this only spells it.
	const rounded = Math.round(value * 10) / 10;
	// The suffix names what the number measures; a bare "98.6%" in a card list says nothing.
	const text = options?.suffix === undefined ? `${rounded}%` : `${rounded}% ${options.suffix}`;
	return { text, sourceField, unreachable: false, notMeasured: false };
}

/** A storage address that must never reach a row: a 64-char content hash. */
const CONTENT_HASH_RE = /\b[0-9a-f]{64}\b/gi;

/** A row's visible URI: the logical `viking://…` form, never a 64-char hash or an AGFS storage path. */
export function formatDisplayUri(uri: string): string {
	// A logical URI is already safe to paint and is shown exactly as the server sent it.
	if (uri.startsWith("viking://") && !/[0-9a-f]{64}/i.test(uri)) return uri;
	const withoutHashes = uri.replace(CONTENT_HASH_RE, "").replace(/\/{2,}(?!\/)/g, "/");
	const logical = withoutHashes.match(/viking:\/\/\S*/);
	if (logical !== null) return logical[0].replace(/\/+$/, "");
	// Not a logical URI: keep the last two path parts so no absolute filesystem path is painted.
	const parts = withoutHashes.split("/").filter((part) => part.length > 0);
	return parts.slice(-2).join("/");
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
	const age = formatAge(iso, nowMs);
	if (age === null) return null;
	// An empty label gives the bare "5m ago" a compact row needs, with no leading space.
	return { text: `${label} ${age} ago`.trim(), sourceField, unreachable: false, notMeasured: false };
}
