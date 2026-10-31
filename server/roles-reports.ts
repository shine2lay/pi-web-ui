/**
 * roles-reports: the 6 am report job as the Roles page reads it: its runs (role-reports runs.json), its schedule
 * (the scheduler's job) and a report's text split under its headings and cut to the page's limit. Split out of
 * roles-overview.ts (Backend #15), which still exports these names.
 */

import type { UiRoleReport } from "./protocol.js";
import { ROLE_REPORT_HEADINGS, ROLE_REPORT_HEADINGS_BEFORE } from "./role-messages.js";

/** A report longer than this is cut (the rest is in the chat). */
export const ROLES_REPORT_MAX = 12_000;
/** The 6 am report job's days are Pacific days (role-reports.mjs TZ). */
export const REPORT_TZ = "America/Los_Angeles";

// ---------------------------------------------------------------------------
// The 6 am report job: its runs and its schedule
// ---------------------------------------------------------------------------

/** One run of role-reports (runs.json), as far as the page needs it. */
export interface ReportRun {
	date: string;
	at: number;
	active: string[];
	inactive: string[];
	skipped: string[];
	sent: Record<string, { id?: string; error?: string }>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** runs.json -> its runs, oldest first (a wrong file: none). */
export function reportRunsOf(raw: unknown): ReportRun[] {
	const runs = (raw as { runs?: unknown } | null)?.runs;
	if (!Array.isArray(runs)) return [];
	const out: ReportRun[] = [];
	for (const r of runs) {
		if (!r || typeof r !== "object") continue;
		const o = r as Record<string, unknown>;
		if (typeof o.date !== "string" || !DATE_RE.test(o.date) || typeof o.at !== "number") continue;
		const names = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
		const sent: ReportRun["sent"] = {};
		if (o.sent && typeof o.sent === "object") {
			for (const [role, v] of Object.entries(o.sent as Record<string, unknown>)) {
				const s = (v ?? {}) as { id?: unknown; error?: unknown };
				sent[role] = {
					...(typeof s.id === "string" && s.id ? { id: s.id } : {}),
					...(typeof s.error === "string" ? { error: s.error } : {}),
				};
			}
		}
		out.push({
			date: o.date,
			at: o.at,
			active: o.active && typeof o.active === "object" && !Array.isArray(o.active) ? Object.keys(o.active) : [],
			inactive: names(o.inactive),
			skipped: o.skipped && typeof o.skipped === "object" && !Array.isArray(o.skipped) ? Object.keys(o.skipped) : [],
			sent,
		});
	}
	return out.sort((a, b) => a.at - b.at);
}

/** jobs.json -> the 6 am report job (enabled), or null. */
export function reportJobOf(raw: unknown): { nextRunAt?: number } | null {
	const jobs = (raw as { jobs?: unknown } | null)?.jobs;
	if (!Array.isArray(jobs)) return null;
	for (const j of jobs) {
		const o = (j ?? {}) as { target?: unknown; enabled?: unknown; nextRunAt?: unknown };
		if (typeof o.target !== "string" || !/(^|\s)role-reports run(\s|$)/.test(o.target) || o.enabled === false) continue;
		return typeof o.nextRunAt === "number" && o.nextRunAt > 0 ? { nextRunAt: o.nextRunAt } : {};
	}
	return null;
}

/** The headings a report is split by: today's four, then the ones asked for before 2026-10-06 (a report
 *  stays on the Roles page for days, so one written under the old headings still shows in parts). */
const REPORT_HEADINGS_READ: readonly string[] = [
	...new Set<string>([...ROLE_REPORT_HEADINGS, ...ROLE_REPORT_HEADINGS_BEFORE]),
];

/** A report's text under its four headings (heading names without "## "), or null when it has none. */
export function reportSections(text: string): { heading: string; text: string }[] | null {
	const wanted = REPORT_HEADINGS_READ.map((h) => h.toLowerCase());
	const out: { heading: string; lines: string[] }[] = [];
	let cur: { heading: string; lines: string[] } | null = null;
	for (const line of text.split(/\r?\n/)) {
		const i = wanted.indexOf(line.trim().toLowerCase());
		if (i >= 0) {
			const heading = REPORT_HEADINGS_READ[i].slice(3);
			cur = out.find((s) => s.heading === heading) ?? null;
			if (!cur) {
				cur = { heading, lines: [] };
				out.push(cur);
			}
			continue;
		}
		cur?.lines.push(line);
	}
	if (!out.length) return null;
	return out.map((s) => ({ heading: s.heading, text: s.lines.join("\n").trim() }));
}

/** A report cut to `max` characters in all (the cut part ends with "…"). */
export function cutReport(
	sections: { heading: string; text: string }[] | null,
	text: string,
	max: number,
): Pick<UiRoleReport, "sections" | "text" | "cut"> {
	if (!sections) return text.length > max ? { text: `${text.slice(0, max)}…`, cut: true } : { text };
	let left = max;
	let cut = false;
	const out: { heading: string; text: string }[] = [];
	for (const s of sections) {
		if (left <= 0) {
			cut = true;
			break;
		}
		if (s.text.length > left) {
			out.push({ heading: s.heading, text: `${s.text.slice(0, left)}…` });
			cut = true;
			left = 0;
			continue;
		}
		out.push(s);
		left -= s.text.length;
	}
	return { sections: out, ...(cut ? { cut: true } : {}) };
}
