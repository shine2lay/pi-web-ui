/**
 * The label in a message's header: who or what the message is from.
 * sent-by (Ops #972, #1052): a user message with a recorded sender (`sentBy`, from the Tailscale login)
 * names that person instead of "You", the same for every viewer (Shine 2026-11-20: "instead of "You" it
 * shows the sender correctly"). No recorded sender (older messages, local access, slash commands,
 * code-added cards, unsent bubbles) keeps "You".
 */
import type { Translate } from "./i18n";
import type { UiMessage } from "./types";

type LabelledMessage = Pick<UiMessage, "role" | "sentBy">;

export function roleLabel(role: string, t: Translate): string {
	switch (role) {
		case "user":
			return t("role.user");
		case "assistant":
			return t("role.assistant");
		case "toolResult":
			return t("role.tool");
		case "bashExecution":
			return t("role.bash");
		case "branchSummary":
			return t("role.branch");
		case "compactionSummary":
			return t("role.compaction");
		default:
			return role;
	}
}

/** The recorded sender of a user message, if any (its login is the label's tooltip). */
export function messageSender(message: LabelledMessage): UiMessage["sentBy"] {
	return message.role === "user" ? message.sentBy : undefined;
}

export function messageRoleLabel(message: LabelledMessage, t: Translate): string {
	return messageSender(message)?.name ?? roleLabel(message.role, t);
}
