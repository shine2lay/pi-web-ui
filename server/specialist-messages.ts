/**
 * department-specialists (Ops #1097, Rule 18 Task 1 seam; Architecture #591 §4.2, R-SPEC-MSG-1, R-SPEC-MSG-2,
 * R-SPEC-PRIV-1): role messages from a specialist's task chat.
 *
 * - The server stamps `from.specialist` on the record from its own binding of the sending chat
 *   (`RoleMessageSender.specialist`, set from specialist-entry.ts), never from tool arguments.
 * - The recipient's chat shows today's header unchanged ("<dept> · Queue #N"); `from.specialist` is shown only in the
 *   sending department's own views and the owner's message list (`fromSpecialist` on the owner's row).
 * - A `to` that is not one of the roles (`<dept>/<slug>` included) is refused with one fixed text, the same whether or
 *   not such a specialist exists.
 *
 * role-messages.ts is over the size cap: it imports these and does not grow. Task 1 leaves the functions unbuilt
 * (they throw E_NOT_BUILT); Ops #1097 Task 2 builds and wires them. Shared cases: C-MSG-*.
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

function notBuilt(name: string): never {
	throw new Error(`E_NOT_BUILT: ${name} (department specialists, Ops #1097 Task 2)`);
}

/** The refusal text message_role returns for any `to` that is not a role: starts `E_NO_ROUTE: no such role` and
 *  never names or depends on the requested target. */
export function noRouteError(_roleIds: readonly string[]): string {
	return notBuilt("noRouteError");
}

/** The `from` stamp for a record: `{ specialist }` from the server's binding only, else `{}`. */
export function specialistStamp(_sender: SpecialistSender): SpecialistFrom {
	return notBuilt("specialistStamp");
}

/** The specialist a viewer may see on a record: the owner and the sending department only. */
export function specialistShownTo(
	_record: { from: { role: string } & SpecialistFrom },
	_viewer: MessageViewer,
): string | undefined {
	return notBuilt("specialistShownTo");
}
