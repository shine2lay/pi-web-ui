/**
 * reconnect-trace (Ops #157): a record of each "Reconnecting…" episode, so its cause can be traced.
 *
 * use-chat.ts says what put the note up (noteCause, right before it refreshes the note) and when the
 * note comes and goes (bannerChanged). A finished episode waits here until a socket is open and the
 * server said it wants them (ready.connTrace.on); it then goes to the server as `conn_trace` and into
 * its connection log (server/conn-events.ts), next to the server's own socket and event-loop records.
 *
 * Kept per tab (sessionStorage) while it waits, so a reload (a new build, or the owner reloading while
 * the note shows) doesn't lose it; an episode cut short by a reload is recorded with cut: true.
 *
 * Metadata only: a fixed cause, durations, visibility/online flags, socket ids. Never chat text, URLs
 * or anything a message carried. Pure logic, no timers: times are passed in (ms, Date.now()).
 */
import type { ConnTraceReason, ConnTraceRecord } from "./types";

/** Finished episodes kept while no socket can take them (oldest dropped first). */
export const MAX_KEPT = 20;
/** The page's own timers held up this long before the note came up count as the page stalling. */
export const PAGE_STALL_WINDOW_MS = 30_000;
/** While the note shows, the saved copy is refreshed at most this often (its length if the tab goes). */
export const SAVE_EVERY_MS = 2_000;
/** sessionStorage key. */
export const STORE_KEY = "pi-web-ui-conn-trace";

const REASONS: readonly ConnTraceReason[] = [
	"close",
	"silence",
	"silence_explained",
	"probe",
	"connect_timeout",
	"doubt",
	"unknown",
];

export interface TraceCause {
	reason: ConnTraceReason;
	closeCode?: number;
	/** silence/probe: how long nothing had come, and the allowance then. */
	quietMs?: number;
	allowedMs?: number;
}

/** What the page looks like at the moment the note changes. */
export interface TraceContext {
	now: number;
	visible: boolean;
	online: boolean;
	/** When the current (or just lost) socket opened; 0 = none yet. */
	openedAt: number;
	/** When that socket last said something. */
	lastHeardAt: number;
	patience: number;
	/** The server's id for that socket (ready.connTrace.conn), when it gave one. */
	conn: string | null;
}

/** Where a tab keeps its episodes across a reload (sessionStorage in the page; a fake in tests). */
export interface TraceStore {
	load(): string | null;
	save(value: string | null): void;
}

interface Episode {
	ep: string;
	cause: TraceCause;
	startAt: number;
	sockAgeMs: number;
	sinceFrameMs: number;
	visible: boolean;
	online: boolean;
	patience: number;
	conn: string | null;
	sockets: number;
	drops: number;
	then?: ConnTraceReason;
	lastOpenAt: number;
	pageStallMs: number;
}

interface Finished {
	rec: Omit<ConnTraceRecord, "endAgoMs">;
	endAt: number;
}

interface Saved {
	v: 1;
	at: number;
	episode: Episode | null;
	done: Finished[];
}

const nonNeg = (v: number): number => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function randomEp(): string {
	const bytes = new Uint8Array(8);
	try {
		crypto.getRandomValues(bytes);
	} catch {
		for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** sessionStorage, or nothing when the browser refuses it. */
export function sessionTraceStore(): TraceStore | undefined {
	try {
		const s = window.sessionStorage;
		return {
			load: () => s.getItem(STORE_KEY),
			save: (v) => {
				try {
					if (v === null) s.removeItem(STORE_KEY);
					else s.setItem(STORE_KEY, v);
				} catch {
					/* full or refused: the episode just isn't kept across a reload */
				}
			},
		};
	} catch {
		return undefined;
	}
}

export class BannerTrace {
	/** The newest cause noted while the note was down (what puts it up). */
	private pendingCause: TraceCause | null = null;
	private episode: Episode | null = null;
	private done: Finished[] = [];
	private lastStall: { gapMs: number; at: number } | null = null;
	private savedAt = 0;
	/** Episodes dropped because too many waited (said nowhere else; for tests). */
	dropped = 0;

	constructor(
		private readonly newId: () => string = randomEp,
		private readonly store?: TraceStore,
	) {
		this.restore();
	}

	/** Something that puts the note up (or keeps it up) just happened. */
	noteCause(c: TraceCause): void {
		if (this.episode) {
			this.episode.drops++;
			this.episode.then = c.reason;
			return;
		}
		this.pendingCause = { ...c };
	}

	/** The page's own timers were held up for gapMs (frozen, throttled or busy). */
	notePageStall(gapMs: number, now: number): void {
		if (!isNum(gapMs) || gapMs <= 0) return;
		if (this.episode) this.episode.pageStallMs = Math.max(this.episode.pageStallMs, Math.round(gapMs));
		else this.lastStall = { gapMs: Math.round(gapMs), at: now };
	}

	/** A socket opened (onopen). */
	socketOpened(now: number): void {
		if (this.episode) {
			this.episode.sockets++;
			this.episode.lastOpenAt = now;
			return;
		}
		// A cause from before (a first connection that failed, before any note) is stale now.
		this.pendingCause = null;
	}

	/** The note's state, every time it is refreshed (only a change does something). */
	bannerChanged(on: boolean, ctx: TraceContext): void {
		if (on && !this.episode) {
			const cause = this.pendingCause ?? { reason: "unknown" as const };
			this.pendingCause = null;
			const stall = this.lastStall && ctx.now - this.lastStall.at <= PAGE_STALL_WINDOW_MS ? this.lastStall.gapMs : 0;
			this.lastStall = null;
			this.episode = {
				ep: this.newId(),
				cause,
				startAt: ctx.now,
				sockAgeMs: ctx.openedAt ? nonNeg(ctx.now - ctx.openedAt) : 0,
				sinceFrameMs: ctx.lastHeardAt ? nonNeg(ctx.now - ctx.lastHeardAt) : 0,
				visible: ctx.visible,
				online: ctx.online,
				patience: ctx.patience,
				conn: ctx.conn,
				sockets: 0,
				drops: 0,
				lastOpenAt: 0,
				pageStallMs: stall,
			};
			this.save(ctx.now);
			return;
		}
		if (!on && this.episode) {
			const e = this.episode;
			this.episode = null;
			this.finish(e, ctx.now, ctx.visible, false);
			this.save(ctx.now);
		}
	}

	/** While the note shows: keep the saved copy fresh (its length, should the tab go). */
	touch(now: number): void {
		if (this.episode && now - this.savedAt >= SAVE_EVERY_MS) this.save(now);
	}

	/** Is an episode going on? */
	get showing(): boolean {
		return this.episode !== null;
	}

	/** Finished episodes waiting to be sent. */
	get waiting(): number {
		return this.done.length;
	}

	/** Hand over the finished episodes (endAgoMs from now) and forget them. */
	take(now: number): ConnTraceRecord[] {
		const out = this.done.map(({ rec, endAt }) => ({ ...rec, endAgoMs: nonNeg(now - endAt) }));
		this.done = [];
		this.save(now);
		return out;
	}

	/** The server doesn't want them (switched off): forget what waits. */
	discard(now: number): void {
		this.done = [];
		this.save(now);
	}

	private finish(e: Episode, endAt: number, endVisible: boolean, cut: boolean): void {
		const rec: Omit<ConnTraceRecord, "endAgoMs"> = {
			ep: e.ep,
			reason: e.cause.reason,
			durMs: nonNeg(endAt - e.startAt),
			sockAgeMs: e.sockAgeMs,
			sinceFrameMs: e.sinceFrameMs,
			visible: e.visible,
			online: e.online,
			endVisible,
			patience: e.patience,
			sockets: e.sockets,
			drops: e.drops,
		};
		if (e.cause.closeCode !== undefined && e.cause.closeCode >= 1000 && e.cause.closeCode <= 4999)
			rec.closeCode = e.cause.closeCode;
		if (e.cause.quietMs !== undefined) rec.quietMs = nonNeg(e.cause.quietMs);
		if (e.cause.allowedMs !== undefined) rec.allowedMs = nonNeg(e.cause.allowedMs);
		if (e.then) rec.then = e.then;
		if (e.lastOpenAt) rec.catchUpMs = nonNeg(endAt - e.lastOpenAt);
		if (e.conn) rec.conn = e.conn;
		if (e.pageStallMs > 0) rec.pageStallMs = e.pageStallMs;
		if (cut) rec.cut = true;
		this.done.push({ rec, endAt });
		if (this.done.length > MAX_KEPT) {
			this.dropped += this.done.length - MAX_KEPT;
			this.done.splice(0, this.done.length - MAX_KEPT);
		}
	}

	private save(now: number): void {
		if (!this.store) return;
		this.savedAt = now;
		if (!this.episode && this.done.length === 0) {
			this.store.save(null);
			return;
		}
		const s: Saved = { v: 1, at: now, episode: this.episode, done: this.done };
		try {
			this.store.save(JSON.stringify(s));
		} catch {
			/* not kept across a reload */
		}
	}

	/** A reload: take back what this tab kept; an episode still showing then ends as cut short. */
	private restore(): void {
		if (!this.store) return;
		let s: Partial<Saved> | null = null;
		try {
			const raw = this.store.load();
			s = raw ? (JSON.parse(raw) as Partial<Saved>) : null;
		} catch {
			s = null;
		}
		if (!s || s.v !== 1 || !isNum(s.at)) return;
		if (Array.isArray(s.done))
			for (const f of s.done.slice(-MAX_KEPT))
				if (f && isNum(f.endAt) && f.rec && typeof f.rec.ep === "string" && REASONS.includes(f.rec.reason))
					this.done.push(f);
		const e = s.episode;
		if (e && typeof e.ep === "string" && isNum(e.startAt) && e.cause && REASONS.includes(e.cause.reason))
			this.finish(
				{ ...e, pageStallMs: isNum(e.pageStallMs) ? e.pageStallMs : 0 },
				Math.max(s.at, e.startAt),
				false,
				true,
			);
		this.save(s.at);
	}
}
