/** What the parts of the Roles view (the page's status, a department's card and panel, the You pill and panel, an
 *  owner ask, the owner's messages) read from the view while it builds their values, what their buttons check when
 *  they are used later, and the view's own handlers they wire to those buttons. The view (roles-exact-view.ts) keeps
 *  the state; the parts never change it themselves. */
import type { ExactRoles } from "../roles-exact-model";
import type { ExactViewActions } from "./host";

export interface ExactViewState {
	/** The host's actions: open a chat or a role's About page, answer an ask, reload. */
	actions: ExactViewActions;
	/** The latest model, for a button used after the values were made. */
	read(): ExactRoles;
	/** True once the view is disposed; its buttons then do nothing. */
	disposed(): boolean;
	/** The card under the pointer or keyboard focus ("you" for the You pill), or none. */
	hover: string | null;
	/** The open tab of a department's panel. */
	tab: "work" | "config";
	/** owner-contacts: the message whose reply is open. */
	openContact: string | null;
	/** Opens a message's reply, or closes it when it is the open one. */
	toggleContact(id: string): void;
	/** Puts the hover spotlight on a card, or on the You pill ("you"). */
	spotlight(id: string, source: Event | Element): void;
	/** Opens a department's panel from its card or an arrow's label. */
	openRole(id: string, source: Event | Element): void;
	/** Opens the You panel from the pill. */
	openYou(source: Event | Element): void;
}
