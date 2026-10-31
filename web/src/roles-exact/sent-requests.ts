/** A department's open requests and questions to other departments: the card's "Waiting on" line and the panel's
 *  "Asked of others" line. The arrows that draw them are in arrows.ts. */
import { NR, exactAge, type ExactRoles } from "../roles-exact-model";
import type { RolePanel } from "../roles-panel-model";

/** roles-sent: a role's label on the page (its id when it isn't shown). */
export function roleName(model: ExactRoles, id: string): string {
	return model.roles.find((r) => r.row.roleId === id)?.row.roleLabel ?? id;
}
/** roles-sent: the panel's "Asked of others" line, written like "Requests in"; not recorded from an older server. */
export function exactSentText(sent: RolePanel["sent"] | undefined, now: number): string {
	if (!sent || sent.open === null) return NR;
	const n = sent.newest;
	if (sent.open === 0 || !n) return `${sent.open} open`;
	const age = n.at === null ? "" : `, ${exactAge(n.at, now)} ago`;
	return `${sent.open} open · newest to ${n.to ?? NR}${age}: ${n.text ?? NR}`;
}
/** roles-sent: the card's line saying who the role is waiting on ("Waiting on Temper", "Waiting on 2 roles"). */
export function exactWaitingOn(model: ExactRoles, id: string): string {
	const to = (model.pairs ?? []).filter((p) => p.from === id);
	if (to.length === 0) return "";
	return to.length === 1 ? `Waiting on ${roleName(model, to[0].to)}` : `Waiting on ${to.length} roles`;
}
