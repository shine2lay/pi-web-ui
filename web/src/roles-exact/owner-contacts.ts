/** owner-contacts: the owner's messages to a role and how far each got, with its reply when there is one: in the You
 *  panel's "Your messages" and in a department panel's list of his messages to it. */
import { NR, exactWhen, type ExactContact, type ExactRoles } from "../roles-exact-model";
import type { SurfaceValues } from "../roles-u0/types";
import type { ExactViewState } from "./view-state";

/** owner-contacts (Roles D3): how far one of his messages got, in fixed words. A stage without a record
 *  is "not recorded", never "didn't happen"; "failed" only with a failure record. */
function contactStatus(c: ExactContact, now: number): { text: string; fg: string } {
	if (c.outcome === "error") return { text: "The turn that took it failed. Open the chat to see why.", fg: "#FF8A80" };
	if (c.outcome === "noText") return { text: "It finished without writing a reply.", fg: "#F0B95A" };
	if (c.outcome === "text") {
		if (c.channel === "browser") return { text: "Replied in the chat.", fg: "#9FD8B8" };
		if (c.sentAt !== null) return { text: "Replied and sent to your Telegram.", fg: "#9FD8B8" };
		if (c.sendFailedAt !== null) return { text: "Replied, but sending it to your Telegram failed.", fg: "#FF8A80" };
		return { text: "Replied. Sending it to your Telegram is not recorded.", fg: "#F0B95A" };
	}
	if (now - c.askedAt > 6 * 60 * 60_000) return { text: "No later stage recorded.", fg: "#A9AEB6" };
	if (c.takenAt !== null) return { text: "In its chat: working on it.", fg: "#7DB8FF" };
	return { text: "Waiting for its chat to take it.", fg: "#F0B95A" };
}
function contactSteps(c: ExactContact, now: number) {
	const step = (label: string, sub: string, state: "done" | "fail" | "none") => ({
		label,
		sub,
		fg: state === "fail" ? "#FF8A80" : state === "done" ? "#ECEDEE" : "#A9AEB6",
		bar: state === "fail" ? "#FF8A80" : state === "done" ? "#9FD8B8" : "#2A2E34",
	});
	const at = (t: number | null) => (t === null ? NR : exactWhen(t, now));
	const replied = c.outcome === "text";
	return [
		step("Asked", `${exactWhen(c.askedAt, now)} · ${c.channel === "telegram" ? "Telegram" : "browser"}`, "done"),
		step("In its chat", at(c.takenAt), c.takenAt !== null ? "done" : "none"),
		step(
			c.outcome === "error" ? "Failed" : c.outcome === "noText" ? "No reply text" : "Replied",
			at(c.settledAt),
			c.outcome === "error" ? "fail" : c.outcome ? "done" : "none",
		),
		c.channel === "telegram"
			? step(
					"Sent to Telegram",
					c.sentAt !== null ? at(c.sentAt) : c.sendFailedAt !== null ? `failed ${at(c.sendFailedAt)}` : NR,
					c.sentAt !== null ? "done" : c.sendFailedAt !== null ? "fail" : "none",
				)
			: step("Reply in the chat", replied ? "no delivery check" : NR, replied ? "done" : "none"),
	];
}
export function contactValues(c: ExactContact, model: ExactRoles, view: ExactViewState): SurfaceValues {
	const status = contactStatus(c, model.now);
	const open = view.openContact === c.id;
	const canRead = c.reply !== null;
	return {
		to: model.roles.find((r) => r.row.roleId === c.role)?.row.roleLabel ?? c.role,
		askedAt: exactWhen(c.askedAt, model.now),
		text: c.text ?? "Message text not recorded",
		status: status.text,
		statusFg: status.fg,
		steps: contactSteps(c, model.now),
		canRead,
		canReadElsewhere: false,
		readLabel: open ? "Hide reply" : "Read reply",
		expanded: String(open && canRead),
		isOpen: open && canRead,
		answer: c.reply ?? "",
		repliedAt: exactWhen(c.settledAt, model.now),
		toggle: () => view.toggleContact(c.id),
	};
}
