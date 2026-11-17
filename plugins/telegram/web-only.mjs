/**
 * owner-requester (Ops #973; Shine 2026-11-16 m97662 "Web only for now"): Telegram is Shine's alone. When the
 * calling chat's work is another owner's (the host's caller context `requester`, e.g. "Wai"), telegram_send
 * sends nothing and says where it went instead; Shine's chats and unowned work (no `requester`) send as before.
 */

/** A not-sent notice result for another owner's chat, or undefined when the notice goes out as usual. */
export function webOnlyNotice(context) {
	const who = context?.requester;
	if (typeof who !== "string" || !who) return undefined;
	const routedTo = `${who} (web only)`;
	return {
		ok: false,
		error: `this work is ${who}'s and Telegram is only Shine's. Tell ${who} in this chat instead (routed_to: ${routedTo}).`,
		routed_to: routedTo,
	};
}
