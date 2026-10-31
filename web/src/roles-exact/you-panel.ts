/** The You pill in the middle of the ring and the panel it grows into: the asks waiting on the owner, his messages
 *  to roles and how far each got, and the week's own-work spending. Also the words the pill's contact-channel chip
 *  and a department panel's list of his messages use. */
import { NR, exactClock, type ExactRoles } from "../roles-exact-model";
import type { SurfaceValues } from "../roles-u0/types";
import { askValues } from "./owner-asks";
import { contactValues } from "./owner-contacts";
import { spendColor, spendWidth } from "./spending";
import type { ExactViewState } from "./view-state";

const MISSING = "Not connected yet";

export function youPanelValues(model: ExactRoles, view: ExactViewState): SurfaceValues {
	const { hover } = view;
	const needs = model.needs;
	const youText =
		needs.tell === "can-tell"
			? `${needs.total} waiting on you`
			: needs.total > 0
				? `${needs.total} received asks · current total unknown`
				: "Current asks unknown";
	const inbox: SurfaceValues[] = needs.items.map((item) => askValues(item, model, view));
	if (needs.more > 0)
		inbox.push({
			kind: "More items",
			kindFg: "#F0B95A",
			kindBg: "#2A2416",
			role: "",
			age: "time unknown",
			title: `${needs.more} more reported asks are not shown here`,
			context: "Open the relevant role’s chat to read them.",
			isOpen: false,
			isResolved: false,
			choices: [],
		});
	const spending = model.roles.filter((r) => r.spend.reported);
	const budgetRole = spending.length === 1 ? spending[0] : null;
	const budget = budgetRole?.spend;
	return {
		channelShown: false,
		contactChannelTitle: MISSING,
		contactChannelText: MISSING,
		youText,
		youBd: hover === "you" ? "#F0B95A" : "#6B5426",
		youOp: hover && hover !== "you" ? "0.38" : "1",
		youHoverOn: (e: Event | Element) => view.spotlight("you", e),
		youExpand: (e: Event | Element) => view.openYou(e),
		inbox,
		inboxEmpty: inbox.length === 0,
		emptyInboxText:
			needs.tell === "can-tell" && needs.total === 0
				? `No owner asks reported at ${exactClock(needs.asOf)}.`
				: "Current owner asks could not be confirmed.",
		qs: (model.contacts ?? []).slice(0, 12).map((c) => contactValues(c, model, view)),
		qsEmpty: !model.contacts?.length,
		emptyContactsText:
			model.contacts === null
				? "Contact and reply tracking are not connected yet."
				: "No messages from you to a role in the last 90 days.",
		contactsHeading: "Your messages",
		roleContactsHeading: "Your messages to",
		spendPeriodText: "Manual own-work reference this week",
		spendRoleText:
			budgetRole?.row.roleLabel ??
			(spending.length ? `${spending.length} departments · see each role` : "No current tally available"),
		spendAmountText: budget?.amount ?? NR,
		spendBudgetText: budget ? `of ${budget.budget}` : "",
		spendAria: budget
			? `${budgetRole?.row.roleLabel} manual own-work reference: ${budget.amount} of ${budget.budget}`
			: "No spending total inferred",
		spendBarWidth: spendWidth(budget?.ratio ?? null),
		spendBarColor: budget ? spendColor(budget, model.lastReceived) : "transparent",
		spendNoteText: budget
			? `${model.lastReceived ? "Last received data. " : ""}Manual tally — stale/unverified reference only. ${budget.note}`
			: "No total is inferred. Missing spending data does not mean $0. Manual reference only.",
	};
}
