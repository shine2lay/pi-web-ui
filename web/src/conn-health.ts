/**
 * mobile-fixes: telling a dead chat connection from a slow one, quickly.
 *
 * A phone's connection dies quietly: the screen goes off, the tab gets frozen, the phone moves between
 * Wi-Fi and mobile data. The socket then just says nothing, and the browser may take minutes to notice.
 * The chat used to freeze until a refresh (the old check waited 30 s of silence, then for the dead
 * socket to close, then up to 10 s more).
 *
 * The server says something every 2 s (heartbeat), so:
 * - a socket that stays quiet for QUIET_MS is dead;
 * - when the page comes back (visible again, unfrozen, back from the page cache) or the network returns
 *   or changes, the page asks the server ("ping" with a number); if the answer to THAT ping doesn't come
 *   within BACK_PROBE_MS, the socket is dead. (Other messages don't count then: after a freeze the
 *   browser hands over what it received before the connection died, which proves nothing.)
 * A dead socket is dropped on the spot and a new one opens at once (use-chat.ts).
 *
 * Slow links: one big message (a whole long chat) can take many seconds to come through, and nothing
 * else arrives meanwhile. The server announces every big message first (`frame_hint` with its size), and
 * the allowed silence grows with that size. And each socket dropped for a silence nothing explained makes
 * the next one more
 * patient (twice, up to 8×), and every STEADY_MS of a working socket takes one step back, so a
 * link that is only slow can never loop reconnecting. A socket that fails to answer after the page
 * came back doesn't count: that one was almost certainly dead.
 */

/** Silence that means the socket is dead (the server's heartbeat comes every 2 s). */
export const QUIET_MS = 5_000;
/** After coming back: the answer to the ping must arrive within this. */
export const BACK_PROBE_MS = 2_500;
/** The slowest link still waited for when a big message is on its way, in characters (before the
 *  link's compression) per second: 25k chars/s is about 50 kbit/s on the wire for chat JSON. */
export const MIN_CHARS_PER_SEC = 25_000;
/** After coming back while a big message was on its way: wait at most this long for the answer. */
export const BIG_BACK_MS = 15_000;
/** Show the "Reconnecting…" note once the answer after coming back is this late. */
export const NOTE_AFTER_MS = 1_000;
/** Each stretch this long of a socket working normally takes back one step of extra patience (a socket
 *  that died was dead, not slow: the next one soon gets the usual patience again). */
export const STEADY_MS = 15_000;
/** At most this many doublings of patience. */
const MAX_STRIKES = 3;

export type Verdict = "ok" | "doubt" | "dead";

/** The health record of the chat connection. Times are ms (Date.now()); pure logic, no timers. */
export class ConnHealth {
	private heardAt = 0;
	private big: { chars: number; since: number } | null = null;
	private probe: { id: number; at: number } | null = null;
	private nextProbeId = 1;
	/** Sockets dropped for an unexplained silence, recently (each makes the next one more patient). */
	private strikes = 0;
	/** Since when the connection has been working without a new strike. */
	private calmSince = 0;
	/** The longest silence since then that no big message explained. */
	private worstGap = 0;
	/** When the current socket opened. */
	openedAt = 0;

	/** A new socket just opened. */
	opened(now: number): void {
		this.openedAt = now;
		this.calmSince = now;
		this.worstGap = 0;
		this.heardAt = now;
		this.big = null;
		this.probe = null;
	}

	/** Something arrived. `hintChars`: it was the announcement of a big message of that size. */
	heard(now: number, hintChars?: number): void {
		if (!this.big) this.worstGap = Math.max(this.worstGap, now - this.heardAt);
		this.heardAt = now;
		this.big = hintChars && hintChars > 0 ? { chars: hintChars, since: now } : null;
		if (this.strikes && now - this.calmSince > STEADY_MS) {
			// One step back only when the link kept well within the smaller patience meanwhile (a link
			// that needs the patience keeps it, instead of losing it and dropping a socket again).
			if (this.worstGap < 0.75 * QUIET_MS * 2 ** (this.strikes - 1)) this.strikes--;
			this.calmSince = now;
			this.worstGap = 0;
		}
	}

	/** The answer to ping `id` arrived: the socket is alive. */
	answered(id: number | undefined): void {
		if (this.probe && this.probe.id === id) this.probe = null;
	}

	/**
	 * The page came back, the network changed, or the page's own timers were held up: the socket must
	 * prove it is alive. Returns the number of the ping to send, or null when one is already waiting
	 * (its clock restarts: time the page wasn't running doesn't count).
	 */
	cameBack(now: number): number | null {
		if (this.probe) {
			this.probe.at = now;
			return null;
		}
		this.probe = { id: this.nextProbeId++, at: now };
		return this.probe.id;
	}

	/** Is the socket being asked to prove it is alive? */
	get checking(): boolean {
		return this.probe !== null;
	}

	/** When the socket last said something. */
	get lastHeardAt(): number {
		return this.heardAt;
	}

	/** The socket was dropped for a silence nothing explained (maybe just a very slow link): the next
	 *  one gets more patience. */
	droppedForSilence(): void {
		this.strikes = Math.min(this.strikes + 1, MAX_STRIKES);
	}

	/** How many times its usual patience a socket gets now (1, 2, 4 or 8). */
	get patience(): number {
		return 2 ** this.strikes;
	}

	/** How long the socket may stay quiet right now. */
	allowedQuietMs(): number {
		return QUIET_MS * this.patience + (this.big ? Math.ceil((this.big.chars / MIN_CHARS_PER_SEC) * 1000) : 0);
	}

	verdict(now: number): Verdict {
		if (this.probe) {
			const waited = now - this.probe.at;
			// A big message announced before the answer holds the answer up until it is through.
			const bigLeft = this.big ? this.heardAt + this.allowedQuietMs() - this.probe.at : 0;
			const limit = Math.max(BACK_PROBE_MS * this.patience, Math.min(BIG_BACK_MS, bigLeft));
			if (waited > limit) return "dead";
			return waited > NOTE_AFTER_MS ? "doubt" : "ok";
		}
		return now - this.heardAt > this.allowedQuietMs() ? "dead" : "ok";
	}
}

// -- The "Reconnecting…" note ---------------------------------------------------
// A tiny store (the note sits outside the chat state, so the reducer and its tests stay as they are).

let noteOn = false;
const listeners = new Set<() => void>();

export function setReconnectingNote(on: boolean): void {
	if (noteOn === on) return;
	noteOn = on;
	for (const l of listeners) l();
}

export function reconnectingNote(): boolean {
	return noteOn;
}

export function subscribeReconnectingNote(l: () => void): () => void {
	listeners.add(l);
	return () => listeners.delete(l);
}
