/**
 * size-summary (Ops #688): how many values, their mean, median and 90th percentile (nearest rank), for the
 * read-only stats scripts that measure text lengths (scripts/turn-status-stats.mts, agent-text-stats.mts).
 * The mean tracks the total (what output tokens cost); the median and p90 the typical and the long item.
 */
export interface SizeSummary {
	n: number;
	/** null when there are no values; the mean to one decimal. */
	mean: number | null;
	median: number | null;
	p90: number | null;
}

/** Nearest-rank percentile of sorted values: the smallest value with at least `p` of them at or below it. */
function rank(sorted: readonly number[], p: number): number {
	return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

export function sizeSummary(values: readonly number[]): SizeSummary {
	if (values.length === 0) return { n: 0, mean: null, median: null, p90: null };
	const sorted = [...values].sort((a, b) => a - b);
	const mean = Math.round((sorted.reduce((a, b) => a + b, 0) / sorted.length) * 10) / 10;
	return { n: sorted.length, mean, median: rank(sorted, 0.5), p90: rank(sorted, 0.9) };
}

/** The change from `before` to `after` in percent, one decimal (negative = fell); null without both. */
export function percentChange(before: number | null, after: number | null): number | null {
	if (before === null || after === null || before === 0) return null;
	return Math.round(((after - before) / before) * 1000) / 10;
}
