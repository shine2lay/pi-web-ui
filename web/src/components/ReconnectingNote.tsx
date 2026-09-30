import { useSyncExternalStore } from "react";
import { reconnectingNote, subscribeReconnectingNote } from "../conn-health";
import { useT } from "../i18n";

/**
 * mobile-fixes: a small "Reconnecting…" note at the top of the page while a lost connection is being
 * replaced and the chat catches up (use-chat.ts decides when; conn-health.ts holds the flag).
 */
export function ReconnectingNote() {
	const on = useSyncExternalStore(subscribeReconnectingNote, reconnectingNote);
	const t = useT();
	if (!on) return null;
	return (
		<div className="reconnecting-note" role="status" aria-live="polite">
			<span className="reconnecting-note-spin" aria-hidden="true" />
			<span>{t("reconnecting")}</span>
		</div>
	);
}
