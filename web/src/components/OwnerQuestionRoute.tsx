/**
 * owner-question routing (Ops #685): the line every owner card opens with, saying which way it came
 * (straight to him, through COO, or still with COO first), then COO's note and recommendation when COO
 * gave them, in the brief's label-and-words form. The pop-ups (questions, extension dialogs, tool
 * approvals), the Queue tab and the Roles page's answer dialog show it the same way (the Roles page's decision
 * cards draw the same lines from its template, web/src/roles-exact/owner-asks.ts). Nothing while the
 * ownerQuestionsViaCoo setting is off: the card is as before.
 */
import { ownerQuestionRouteOf, routeNoteLines } from "../owner-question-route";
import { OwnerCardBrief } from "./OwnerCardBrief";

export function OwnerQuestionRoute({ route }: { route: unknown }) {
	const view = ownerQuestionRouteOf(route);
	if (!view) return null;
	return (
		<div className={view.held ? "owner-question-route held" : "owner-question-route"}>
			<p className="owner-question-route-line">{view.line}</p>
			<OwnerCardBrief lines={routeNoteLines(view)} />
		</div>
	);
}
