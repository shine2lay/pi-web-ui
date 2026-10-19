// initiatives-page, step 3's module (Ops #227): open tasks under their projects, what's waiting on the
// owner, the ON YOU bar, and each initiative's and project's live status (statusOf) for the chips and the
// filter counts. Not connected yet: it says so everywhere, and never that nothing is waiting on him.
import type { InitiativesExactStatus } from "../initiatives-exact-model";
import type { UiWorkPage } from "../types";
import { NOT_CONNECTED, type InitiativesPageOpen, type InitiativesPagePart } from "./types";

export function tasksPart(
	page: UiWorkPage,
	_selected: string | undefined,
	_open: InitiativesPageOpen,
): InitiativesPagePart {
	return {
		projects: Object.fromEntries(page.projects.map((p) => [p.id, { note: "Tasks: " + NOT_CONNECTED.toLowerCase() }])),
		page: {
			summary: NOT_CONNECTED + ": what's waiting on you will show here.",
			filtersNote: NOT_CONNECTED + ": this filter needs the tasks, which aren't connected yet.",
		},
	};
}

/** An initiative's or project's live status from its tasks; nothing until tasks are connected, so the
 *  chip shows the registry's status in grey. */
export function statusOf(_page: UiWorkPage, _id: string): InitiativesExactStatus | undefined {
	return undefined;
}
