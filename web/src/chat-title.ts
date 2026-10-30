/**
 * chat-title (fork patch, PATCHES.md): the name at the top of the middle pane, so you can tell which
 * chat you're in without looking at the left bar. Pure rules, no React: App hands it the chat's state.
 *
 * It is the left bar's own name for the chat on screen, never a new naming rule:
 *  - the open chat: its row's title in the running list (`conversations`), which is what the left
 *    bar's current row shows; a rename shows the moment the list carries the new title;
 *  - while another chat opens with its cached messages on screen (switch-cache / chat-open-speed):
 *    that chat's name, the one the left bar's highlighted row shows (switchTargetTitle's rules, whole
 *    instead of the overlay's 60 characters). Without cached messages the overlay covers the pane and
 *    the chat you're in is still the old one (a hidden overlay keeps you in it too), so its title stays;
 *  - an open chat not in the running list yet: the same fallbacks by its file (History's name, its
 *    first message, a live row with that file), but never the file's own name;
 *  - nothing to name (a blank new chat, New chat starting, no snapshot yet): null, and no title.
 */
import { DISPLAY_PREVIEW_SCALARS } from "../../server/display-preview.js";
import { leftBarCurrentRowId, type StartupAttempt } from "./first-send";
import { switchTargetTitle } from "./switch-pending";
import type { SwitchTarget } from "./types";

/** The parts of the chat's state (useChat) the title is chosen from, under their own names. */
export interface ChatOnScreen {
	/** The chat the page is in (chat.activeConversationId). */
	activeConversationId: string;
	/** Its start-up (chat.startup): while New chat starts, the left bar has no current row. */
	startup: Pick<StartupAttempt, "via" | "phase">;
	/** The open chat's snapshot (chat.state): its transcript, for a chat not (yet) in the running list. */
	state: { sessionFile?: string | null } | null;
	/** The cached messages of a chat being opened, when they are what the middle pane shows (chat.preview). */
	preview: object | null;
	/** The chat being switched to (chat.pendingSwitch). */
	pendingSwitch: { target: SwitchTarget } | null;
	/** The running list (chat.conversations): the left bar's rows. */
	conversations: readonly { id: string; title: string; sessionPath?: string }[];
	/** History (chat.sessions). */
	sessions: readonly { path: string; name?: string; firstMessage?: string }[];
}

/** Words or nothing: blank words are no title. */
function words(title: string | undefined): string | null {
	return title !== undefined && title.trim() !== "" ? title : null;
}

/** A chat's name by switchTargetTitle's rules, whole; "" stands in for its last resort, the file's name. */
function nameOf(target: SwitchTarget, chat: ChatOnScreen): string | null {
	return words(switchTargetTitle(target, chat.sessions, chat.conversations, "", DISPLAY_PREVIEW_SCALARS));
}

/** The title of the chat the middle pane shows, or null when it has none to show. */
export function chatTitleOnScreen(chat: ChatOnScreen): string | null {
	if (chat.preview && chat.pendingSwitch) return nameOf(chat.pendingSwitch.target, chat);
	const current = leftBarCurrentRowId(chat.startup, chat.activeConversationId);
	if (!current) return null;
	const row = chat.conversations.find((c) => c.id === current);
	if (row) return words(row.title);
	const file = chat.state?.sessionFile;
	return file ? nameOf({ kind: "session", path: file }, chat) : null;
}
