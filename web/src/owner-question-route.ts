/**
 * owner-question routing (Ops #685): which way an owner ask came, as a card shows it first (before #682's
 * brief): one line ("You were chatting here …", "Came through COO", "With COO first. You can answer here."),
 * then COO's note and recommendation when COO gave them. The server builds it from the ask's route
 * (server/owner-question-surfaces.ts); the page takes the line only plain, and leaves out a note or a
 * recommendation that isn't. No route (the setting off) shows nothing, as before.
 */
import type { UiOwnerCardBriefLine, UiOwnerQuestionRoute } from "./types";
import { object, UNSAFE } from "./roles-useful-model";

const ROUTE_LINE_MAX = 600;
const ROUTE_TEXT_MAX = 2_000;

function plainText(part: unknown, max: number): string | null {
	// As briefLines reads a brief: tab, CR and LF as a space; any other unsafe character rejects it.
	const text = typeof part === "string" ? part.replace(/[\t\n\r]+/g, " ").trim() : "";
	return text && text.length <= max && !UNSAFE.test(text) ? text : null;
}

/**
 * The id a card (a pop-up, a question, a permission prompt) sounds and notifies under, once per id, or null
 * while it is held for COO first: its own chat's page shows it quietly, and it sounds once it is let through.
 * A card with no route (the setting off) sounds as before.
 */
export function cueIdOf<Id>(card: { id: Id; route?: unknown } | null | undefined): Id | null {
	if (!card) return null;
	return object(card.route)?.held === true ? null : card.id;
}

/** COO's note and recommendation, when COO gave them, as lines in the brief's label-and-words form. */
export function routeNoteLines(view: UiOwnerQuestionRoute): UiOwnerCardBriefLine[] {
	return [
		...(view.note ? [{ label: "COO", text: view.note }] : []),
		...(view.recommendation ? [{ label: "COO recommends", text: view.recommendation }] : []),
	];
}

/** A card's route lines, plain, or none at all when its line isn't. */
export function ownerQuestionRouteOf(value: unknown): UiOwnerQuestionRoute | undefined {
	const fields = object(value);
	const line = plainText(fields?.line, ROUTE_LINE_MAX);
	if (!fields || !line) return undefined;
	const note = plainText(fields.note, ROUTE_TEXT_MAX);
	const recommendation = plainText(fields.recommendation, ROUTE_TEXT_MAX);
	return {
		line,
		...(note ? { note } : {}),
		...(recommendation ? { recommendation } : {}),
		...(fields.held === true ? { held: true as const } : {}),
	};
}
