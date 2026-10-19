// initiatives-page, step 4's module (Ops #228): the gaps the lead hasn't covered, all activity and the
// hand-offs. Not connected yet: every initiative, and the "in no initiative" box, says so.
import type { InitiativesExactInitiative } from "../initiatives-exact-model";
import type { UiWorkPage } from "../types";
import { NOT_CONNECTED, partIds, type InitiativesPageOpen, type InitiativesPagePart } from "./types";

const NOT_CONNECTED_GAPS: Partial<InitiativesExactInitiative> = {
	gapsNote: NOT_CONNECTED + ": gaps will show here.",
	activityNote: NOT_CONNECTED + ": all activity will show here.",
	handoffsNote: NOT_CONNECTED + ": hand-offs will show here.",
};

export function gapsPart(
	page: UiWorkPage,
	_selected: string | undefined,
	_open: InitiativesPageOpen,
): InitiativesPagePart {
	return { initiatives: Object.fromEntries(partIds(page).map((id) => [id, NOT_CONNECTED_GAPS])) };
}
