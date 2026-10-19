// initiatives-page, step 2's module (Ops #226): an initiative's goal, when it started and its done-when
// items. Not connected yet: every initiative, and the "in no initiative" box, says so.
import type { InitiativesExactInitiative } from "../initiatives-exact-model";
import type { UiWorkPage } from "../types";
import { NOT_CONNECTED, partIds, type InitiativesPageOpen, type InitiativesPagePart } from "./types";

const NOT_CONNECTED_PLAN: Partial<InitiativesExactInitiative> = {
	goal: NOT_CONNECTED,
	started: NOT_CONNECTED,
	outcomesNote: NOT_CONNECTED + ": the done-when items will show here.",
};

export function planPart(
	page: UiWorkPage,
	_selected: string | undefined,
	_open: InitiativesPageOpen,
): InitiativesPagePart {
	return { initiatives: Object.fromEntries(partIds(page).map((id) => [id, NOT_CONNECTED_PLAN])) };
}
