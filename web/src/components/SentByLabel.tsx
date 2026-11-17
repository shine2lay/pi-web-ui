import type { UiMessage } from "../types";

/** sent-by (Ops #972): who typed a message (from the Tailscale login), shown next to its role. */
export function SentByLabel({ sentBy }: { sentBy: UiMessage["sentBy"] }) {
	if (!sentBy) return null;
	return (
		<span className="msg-sent-by" title={sentBy.login}>
			{sentBy.name}
		</span>
	);
}
