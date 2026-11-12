import { useSyncExternalStore } from "react";
import { reconnectingNote, subscribeReconnectingNote } from "../conn-health";
import { useT } from "../i18n";

/**
 * mobile-fixes: a small "Reconnecting…" note while a lost connection is being replaced and the chat
 * catches up (use-chat.ts decides when; conn-health.ts holds the flag). #271: App.tsx docks it over the
 * status bar's left group, so it never covers a page.
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
