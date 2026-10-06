/**
 * telegram-answers: a link that opens one chat, like `https://<pi>/?chat=<saved chat file>`.
 * The Telegram plugin puts one under every question, so a tap goes straight to that chat.
 *
 * At startup the `chat` parameter comes off the address bar (so a reload or a bookmark doesn't
 * keep jumping back to it), and once the page is connected the app opens that chat the usual way
 * (switch_session). The server only opens transcripts inside its sessions folder.
 */
let pending: string | null = null;
/** roles-overview: `&focus=tldr:<id>|task:<n>|question:<id>|report:<day>` with `?chat=`: the item to show. */
let pendingFocus: string | null = null;
/** roles-overview: `?view=roles` (and `#r-<role id>`): open the Roles page (at that role). */
let pendingView: { view: "roles"; role?: string } | null = null;

/** Take `?chat=` (and `&focus=`) and `?view=roles` off the address bar and remember them. Call once at startup. */
export function initChatLink(): void {
	try {
		const url = new URL(window.location.href);
		const value = url.searchParams.get("chat");
		const focus = url.searchParams.get("focus");
		const view = url.searchParams.get("view");
		if (value === null && view === null) return;
		url.searchParams.delete("chat");
		url.searchParams.delete("focus");
		if (view !== null) {
			url.searchParams.delete("view");
			if (view.trim().toLowerCase() === "roles") {
				const m = /^#r-([a-z0-9][a-z0-9-]{0,63})$/i.exec(url.hash);
				pendingView = { view: "roles", ...(m ? { role: m[1].toLowerCase() } : {}) };
				if (m) url.hash = "";
			}
		}
		window.history.replaceState(window.history.state, "", url.toString());
		if (value !== null) {
			pending = value.trim() || null;
			pendingFocus = pending && focus ? focus.trim() || null : null;
		}
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

/** roles-overview: the item the link asked for in that chat, once (raw; chat-focus.ts parseFocus checks it). */
export function takeChatFocusLink(): string | null {
	const f = pendingFocus;
	pendingFocus = null;
	return f;
}

/** roles-overview: the page a link asked for (`?view=roles`, maybe at `#r-<id>`), once. */
export function takeViewLink(): { view: "roles"; role?: string } | null {
	const v = pendingView;
	pendingView = null;
	return v;
}
