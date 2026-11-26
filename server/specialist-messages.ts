/**
 * department-specialists (Ops #1097 seam, Ops #1101 build; Architecture #591 §4.2, R-SPEC-MSG-1, R-SPEC-MSG-2,
 * R-SPEC-PRIV-1): role messages from a specialist's task chat.
 *
 * - The server stamps `from.specialist` on the record from its own binding of the sending chat
 *   (`RoleMessageSender.specialist`, set from specialist-entry.ts `withSpecialist`), never from tool arguments.
 * - The recipient's chat shows today's header unchanged ("<dept> · Queue #N"); `from.specialist` is shown only in the
 *   sending department's own views and the owner's message list (`fromSpecialist` on the owner's row).
 * - A `to` that is not one of the roles (`<dept>/<slug>` included) is refused with one fixed text, the same whether or
 *   not such a specialist exists.
 *
 * role-messages.ts is over the size cap: it imports these and does not grow. Shared cases: C-MSG-*.
 */

/** What the server knows about the sending chat beyond its department (added to RoleMessageSender). */
export interface SpecialistSender {
	/** The specialist slug the chat is bound to (specialist-entry.ts), absent for every other chat. */
	specialist?: string;
}

/** What a record's `from` and the owner's list row gain. */
export interface SpecialistFrom {
	specialist?: string;
}
export interface SpecialistRow {
	fromSpecialist?: string;
}

/** Who is looking: the owner (his message list), or a role's own views. */
export type MessageViewer = { kind: "owner" } | { kind: "role"; role: string };

/** R-SPEC-PRIV-1: the unknown-recipient refusal, fixed (case C-MSG-2/3 payload). */
export const NO_ROUTE = { code: "E_NO_ROUTE", message: "no such role" } as const;

/** The refusal text message_role returns for any `to` that is not a role: starts `E_NO_ROUTE: no such role` and
 *  never names or depends on the requested target (only on the role list, the same for every target). */
export function noRouteError(roleIds: readonly string[]): string {
	return `${NO_ROUTE.code}: ${NO_ROUTE.message}. Roles: ${roleIds.join(", ") || "none"}.`;
}

/** The `from` stamp for a record: `{ specialist }` from the server's binding only, else `{}` (no key). */
export function specialistStamp(sender: SpecialistSender): SpecialistFrom {
	return typeof sender.specialist === "string" && sender.specialist ? { specialist: sender.specialist } : {};
}

/** The owner's list row's part: `{ fromSpecialist }` for a stamped record, else `{}` (no key). */
export function specialistRowOf(from: SpecialistFrom): SpecialistRow {
	return from.specialist ? { fromSpecialist: from.specialist } : {};
}

/** The specialist a viewer may see on a record: the owner and the sending department only. */
export function specialistShownTo(
	record: { from: { role: string } & SpecialistFrom },
	viewer: MessageViewer,
): string | undefined {
	const slug = record.from.specialist;
	if (!slug) return undefined;
	return viewer.kind === "owner" || viewer.role === record.from.role ? slug : undefined;
}
