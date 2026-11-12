import type { ReactElement } from "react";
import type { ChatState } from "../use-chat";
import type { UiSlotEntry } from "../ui-slots";
import { FooterBar } from "./FooterBar";
import { ReconnectingNote } from "./ReconnectingNote";

/**
 * The shell's band for transient status at the foot of the window (frontend #271).
 *
 * The status bar is where the shell already says how things stand, so while a lost connection is
 * being replaced "Reconnecting…" takes the place of the bar's left group — the connection and usage
 * readings it would otherwise show are stale anyway. The note used to be a floating pill at
 * `top: 52px`, which at 320/390 sat exactly on a page's title.
 *
 * The dock itself is zero-height and the note is absolute inside it, so the note is painted over the
 * bar without ever taking a page's space: it appears and goes without moving anything.
 */
export function StatusDock({
	chat,
	bottombarItems,
	onUiAction,
}: {
	readonly chat: ChatState;
	readonly bottombarItems?: readonly UiSlotEntry[];
	readonly onUiAction?: (item: UiSlotEntry, value?: string) => void;
}): ReactElement {
	return (
		<div className="app-status-dock">
			<ReconnectingNote />
			<FooterBar chat={chat} bottombarItems={bottombarItems as UiSlotEntry[] | undefined} onUiAction={onUiAction} />
		</div>
	);
}
