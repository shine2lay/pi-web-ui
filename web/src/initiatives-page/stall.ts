// stall-wake (Ops #284, docs/stall-watch.md "On the Initiatives page"): the stall check's line in the slots the
// page already has: a project's row note (and its item in the "in no initiative" box), and an initiative's card
// note. "No open task since 06:00 · Ops asked 08:10", "Nothing recorded since Oct 19 08:00", or a lead's
// recorded wait "Waits until Oct 24 09:00: <why>". Nothing else on the page changes.
import { roleName } from "../initiatives-view-model";
import { clockOf } from "../roles-view-model";
import type { UiWorkPage, UiWorkPageRecord } from "../types";
import type { InitiativesPagePart } from "./types";

const askedName = (role: string) => (role === "owner" ? "Owner (through COO)" : roleName(role));

/** The record's stall or wait line, or undefined. A stall wins: the check only flags items with no active wait. */
export function stallLine(r: Pick<UiWorkPageRecord, "stall" | "wait" | "status">, now: number): string | undefined {
	if (r.status !== "active") return undefined;
	const s = r.stall;
	if (s) {
		const head = `${s.rule === "empty" ? "No open task" : "Nothing recorded"} since ${clockOf(s.since, now)}`;
		return [head, ...s.asked.map((a) => `${askedName(a.role)} asked ${clockOf(a.at, now)}`)].join(" \u00b7 ");
	}
	const w = r.wait;
	if (w && now < w.until) return `Waits until ${clockOf(w.until, now)}: ${w.why}`;
	return undefined;
}

/** The lines as a page section: project rows and initiative cards. The "in no initiative" box's items keep their
 *  own note and get the line after it (model.ts). */
export function stallPart(page: UiWorkPage, now: number): InitiativesPagePart {
	const projects: Record<string, { note: string }> = {};
	const initiatives: Record<string, { statusNote: string }> = {};
	for (const p of page.projects) {
		const line = stallLine(p, now);
		if (line) projects[p.id] = { note: line };
	}
	for (const i of page.initiatives) {
		const line = stallLine(i, now);
		if (line) initiatives[i.id] = { statusNote: line };
	}
	return { projects, initiatives };
}
