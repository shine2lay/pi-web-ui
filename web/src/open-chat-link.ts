/**
 * telegram-answers: a link that opens one chat, like `https://<pi>/?chat=<saved chat file>`.
 * The Telegram plugin puts one under every question, so a tap goes straight to that chat.
 *
 * At startup the `chat` parameter comes off the address bar (so a reload or a bookmark doesn't
 * keep jumping back to it), and once the page is connected the app opens that chat the usual way
 * (switch_session). The server only opens transcripts inside its sessions folder.
 */
let pending: string | null = null;

/** Take `?chat=` off the address bar and remember it. Call once at startup. */
export function initChatLink(): void {
	try {
		const url = new URL(window.location.href);
		const value = url.searchParams.get("chat");
		if (value === null) return;
		url.searchParams.delete("chat");
		window.history.replaceState(window.history.state, "", url.toString());
		pending = value.trim() || null;
	} catch {
		/* ignore */
	}
}

/** The chat a link asked to open, once (null after that, or when there was none). */
export function takeChatLink(): string | null {
	const p = pending;
	pending = null;
	return p;
}
