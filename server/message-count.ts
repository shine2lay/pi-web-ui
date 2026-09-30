/**
 * list-freeze: a chat's message count, cheaply.
 *
 * The running-chats list showed each chat's message count with `session.getSessionStats().totalMessages`.
 * getSessionStats() walks every entry of the chat AND works out how full its context is (it rebuilds the
 * whole context projection), which takes seconds on a 30k-message chat. Every window rebuilt its list
 * each time any chat started or finished a step, and each window's rebuild set the others off again, so
 * the server froze for 10–20 s at a time and every page's 5 s watchdog dropped its socket: the chat
 * "reconnected" with no restart and no network trouble.
 *
 * This is the same number (message entries in the chat file, on every branch), counted without the
 * context work, and remembered per chat until the chat changes. Every new entry moves the chat's leaf
 * and lengthens its entry list, so while both stay the same the count does too. Shared by every window.
 */

/** The part of pi's SessionManager this needs. */
export interface CountableSessionManager {
	getLeafId(): string | null;
	getEntries(): ReadonlyArray<{ type: string }>;
}

/** The part of pi's AgentSession this needs. Sessions without a session manager (test fakes) are
 *  asked the old way. */
export interface CountableSession {
	readonly sessionManager?: CountableSessionManager;
	getSessionStats(): { totalMessages: number };
}

const counts = new WeakMap<object, { key: string; count: number }>();

/** A cheap key that changes whenever the chat gets a new entry or moves to another branch. The entry
 *  list's length is read from the manager's own array when it has one (pi keeps it in `fileEntries`),
 *  so it costs nothing; the leaf alone covers the rest. */
function changeKey(sm: CountableSessionManager): string {
	const own = (sm as unknown as { fileEntries?: unknown }).fileEntries;
	return `${sm.getLeafId() ?? ""}\u0001${Array.isArray(own) ? own.length : -1}`;
}

/** How many messages the chat has: what `getSessionStats().totalMessages` says, without its cost. */
export function messageCountOf(session: CountableSession): number {
	const sm = session.sessionManager;
	if (!sm || typeof sm.getLeafId !== "function" || typeof sm.getEntries !== "function") {
		return session.getSessionStats().totalMessages;
	}
	const key = changeKey(sm);
	const hit = counts.get(sm);
	if (hit && hit.key === key) return hit.count;
	let count = 0;
	for (const entry of sm.getEntries()) if (entry.type === "message") count++;
	counts.set(sm, { key, count });
	return count;
}
