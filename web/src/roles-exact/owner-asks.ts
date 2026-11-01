/** An ask waiting on the owner, with its Answer and Open chat buttons: in the You panel's list and in a department
 *  panel's Decisions. Which way it can be answered comes from roles-answer-actions. */
import { exactAge, type ExactRoles } from "../roles-exact-model";
import { ownerQuestionRouteOf, routeNoteLines } from "../owner-question-route";
import { questionAction, resolveQuestionAction, QUESTION_ACTION_REASONS } from "../roles-answer-actions";
import type { SurfaceValues } from "../roles-u0/types";
import type { NeedsYouItem } from "../roles-useful-model";
import type { ExactViewState } from "./view-state";

export function askValues(item: NeedsYouItem, model: ExactRoles, view: ExactViewState): SurfaceValues {
	const { actions } = view;
	const action = questionAction(model.needs, item, actions.dialogs?.(), !!actions.answer);
	const route = ownerQuestionRouteOf(item.route);
	const routeLines = route ? routeNoteLines(route) : [];
	const canAnswer = action.kind !== "unavailable";
	const choices: SurfaceValues[] = [];
	if (canAnswer)
		choices.push({
			label: action.kind === "chat" ? "Answer in chat" : "Answer",
			bg: "#ECEDEE",
			fg: "#0E0F11",
			bd: "#ECEDEE",
			op: "1",
			hasHint: false,
			pick: (source: Event | Element) => {
				if (view.disposed()) return;
				const latest = resolveQuestionAction(view.read().needs, item, actions.dialogs?.() ?? [], action.kind);
				if (!latest) return;
				if (latest.action.kind === "chat") actions.open(latest.action.target);
				else {
					const from = "currentTarget" in source ? source.currentTarget : source;
					if (from && "focus" in from) actions.answer?.(latest.item, from as HTMLElement);
				}
			},
		});
	if (item.link)
		choices.push({
			label: "Open chat",
			bg: canAnswer ? "transparent" : "#ECEDEE",
			fg: canAnswer ? "#ECEDEE" : "#0E0F11",
			bd: canAnswer ? "#3A3F46" : "#ECEDEE",
			op: "1",
			hasHint: false,
			pick: () => {
				if (!view.disposed() && item.link) actions.open(item.link);
			},
		});
	return {
		kind: canAnswer ? "Needs your answer" : "Open item",
		kindFg: "#F0B95A",
		kindBg: "#2A2416",
		role: item.roleLabel ?? "Unknown role",
		age: exactAge(item.since, model.now),
		// owner-question routing (Ops #685): which way it came, first, then COO's words; none with the setting off.
		hasRoute: !!route,
		routeLine: route?.line ?? "",
		hasRouteLines: routeLines.length > 0,
		routeLines: routeLines.map((line) => ({ label: line.label, text: line.text })),
		// owner-card-brief (Ops #682): a queue card opens with its plain brief, before its question.
		hasBrief: !!item.brief?.length,
		brief: (item.brief ?? []).map((line) => ({ label: line.label, text: line.text })),
		title: item.text ?? "Open the original item to read it",
		context:
			action.kind === "inline"
				? "Open the full prompt and answer here."
				: action.kind === "chat"
					? "Open the exact item in its original chat. Navigation sends no answer."
					: QUESTION_ACTION_REASONS[action.reason],
		isOpen: choices.length > 0,
		isResolved: false,
		choices,
	};
}
