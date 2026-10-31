/**
 * Time words first written for the Roles page, now shared by the Initiatives pages and the queue status (pure
 * functions, so the unit tests cover them): a clock time, a short age and an "ago".
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** "07:05" today, "Sun 23:40" this past week, "Oct 3 23:40" before (the browser's clock). */
export function clockOf(ms: number, now: number): string {
	const d = new Date(ms);
	const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	const today = new Date(now);
	if (d.toDateString() === today.toDateString()) return hm;
	const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
	if (ms >= startOfToday - 6 * DAY_MS && ms < startOfToday + DAY_MS) {
		return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${hm}`;
	}
	return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${hm}`;
}

/** "25m", "9h", "2d" ("now" under a minute). */
export function ageOf(ms: number, now: number): string {
	const min = Math.floor(Math.max(0, now - ms) / 60_000);
	if (min < 1) return "now";
	if (min < 60) return `${min}m`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

/** "just now", "14m ago", "5h ago", "1d ago". */
export function agoOf(ms: number, now: number): string {
	const min = Math.floor(Math.max(0, now - ms) / 60_000);
	if (min < 1) return "just now";
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}
