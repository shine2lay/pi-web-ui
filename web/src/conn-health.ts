/**
 * A quiet OPEN socket may mean a busy server, not a broken connection. Probe after 10 s,
 * show a calm waiting note after another 2.5 s, and periodically re-ping without replacing
 * it. Only 30 s without proof of life permits replacement. A real close still reconnects
 * immediately. Waking a tab probes an OPEN socket immediately and retries any other state.
 * Large-frame allowances and adaptive patience keep slow links from looping reconnects.
 */

/** Silence before the first probe (the server normally speaks every 2 s). */
export const QUIET_MS = 10_000;
/** Retry the same probe; do not restart its failure clock. */
export const REPING_MS = 5_000;
/** Minimum sustained failure before an OPEN socket may be replaced. */
export const DEAD_AFTER_MS = 30_000;
/** The slowest link still waited for when a big message is on its way, in characters (before the
 *  link's compression) per second: 25k chars/s is about 50 kbit/s on the wire for chat JSON. */
export const MIN_CHARS_PER_SEC = 25_000;
/** Show the waiting note after this much probe time AND at least 12.5 s total silence. */
export const NOTE_AFTER_MS = 2_500;
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
	private probe: { id: number; at: number; sentAt: number; failureSince: number; wake: boolean } | null = null;
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
		// Ordinary traffic proves a quiet probe alive. After wake, buffered traffic is not
		// proof: only the answer to our fresh ping clears that probe.
		if (!this.probe?.wake) this.probe = null;
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

	/** Wake probes go out now, but get the same 30 s failure window as quiet probes.
	 * Actual page sleep starts a fresh probe: elapsed background time proves nothing.
	 * Repeated network hints without sleep do not restart the failure clock. */
	cameBack(now: number, resumed = false): number {
		if (!this.probe || resumed) {
			this.probe = { id: this.nextProbeId++, at: now, sentAt: now, failureSince: now, wake: true };
		} else {
			this.probe.sentAt = now;
			this.probe.wake = true;
		}
		return this.probe.id;
	}

	/** The watchdog calls this before verdict(): first ping after QUIET_MS, then periodic retries. */
	pingDue(now: number): number | null {
		if (!this.probe) {
			if (now - this.heardAt < this.allowedQuietMs()) return null;
			this.probe = {
				id: this.nextProbeId++,
				at: this.heardAt + this.allowedQuietMs(),
				sentAt: now,
				failureSince: this.heardAt,
				wake: false,
			};
			return this.probe.id;
		}
		if (now - this.probe.sentAt < REPING_MS) return null;
		this.probe.sentAt = now;
		return this.probe.id;
	}

	get waking(): boolean {
		return this.probe?.wake ?? false;
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
		const failureSince = this.probe?.failureSince ?? this.heardAt;
		const bigAllowance = this.big ? Math.ceil((this.big.chars / MIN_CHARS_PER_SEC) * 1000) : 0;
		if (now - failureSince > DEAD_AFTER_MS * this.patience + bigAllowance) return "dead";
		const probeAt = this.probe?.at ?? this.heardAt + this.allowedQuietMs();
		// Both clocks matter: a wake during a short server freeze must not flash a banner.
		const silenceSince = this.probe?.wake ? this.probe.failureSince : this.heardAt;
		return now - probeAt > NOTE_AFTER_MS && now - silenceSince > QUIET_MS + NOTE_AFTER_MS ? "doubt" : "ok";
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

/** pages-live (Ops #244): the connection is in trouble, but Roles or Initiatives is shown and the note is held
 *  back for up to LIVE_GRACE_MS while that page's own data comes back. The footer then says "Updating…" instead
 *  of "Reconnecting…". Same listeners as the note. */
let graceOn = false;

export function setLiveGrace(on: boolean): void {
	if (graceOn === on) return;
	graceOn = on;
	for (const l of listeners) l();
}

export function liveGrace(): boolean {
	return graceOn;
}

export function subscribeReconnectingNote(l: () => void): () => void {
	listeners.add(l);
	return () => listeners.delete(l);
}
