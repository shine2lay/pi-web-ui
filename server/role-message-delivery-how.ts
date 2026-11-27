import { needsOwnTurn, roleMessageIdOf, type RoleMessages } from "./role-messages.js";
import { roleRequesterInputOf } from "./queue-requester.js";

/** Existing owner/CI/script turn causality, kept separate from inbox admission. */
export function roleMessageDeliveryHow(messages: RoleMessages, file: string, text: string) {
	const owner = messages.ownerContextFor(file, text);
	const cause = messages.causalityOf(file, text);
	const record = cause.kind === "record" && cause.exactTarget ? messages.byId(cause.record.id) : undefined;
	const requester = record ? roleRequesterInputOf(record) : undefined;
	const id = roleMessageIdOf(text);
	return {
		cause: id && messages.byId(id)?.kind === "report" ? ("other" as const) : ("role" as const),
		// A CI alert or script request starts its own turn, never joins a running one.
		...(record && needsOwnTurn(record) ? { requireIdle: true } : {}),
		...(owner ? { forOwner: owner } : {}),
		...(requester ? { requester } : {}),
	};
}
