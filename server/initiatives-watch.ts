/**
 * initiatives-page (task #84): the Initiatives tab's watchers, one per window. A window gets its page at
 * once (its own pick of initiative and how many decisions), and again, debounced, when the decisions or the
 * reader change. The page is made from the kept files, so a failure is sent as an error the tab can show
 * (it keeps what it had).
 *
 * who-fill (Architecture #115): while the who-cache is being filled in the background after a start, `ready`
 * returns that fill, and a page waits for it instead of building cold on the main thread. A watcher waits
 * once, however often it is asked meanwhile, and gets one page when the fill ends; a watcher dropped or
 * replaced meanwhile gets nothing.
 */
import type { ServerMessage, UiDecisionsPage } from "./protocol.js";

export const INITIATIVES_DEBOUNCE_MS = 500;
export const INITIATIVES_LIMIT_DEFAULT = 200;
export const INITIATIVES_LIMIT_MAX = 2000;

interface Watcher {
	initiative?: string;
	limit: number;
	send: (msg: ServerMessage) => void;
	/** who-fill: when it started waiting for the fill (only while it waits). */
	waitingSince?: number;
}

export class InitiativesWatch<K> {
	private readonly watchers = new Map<K, Watcher>();
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly read: (initiative: string | undefined, limit: number) => UiDecisionsPage,
		private readonly opts: {
			debounceMs?: number;
			log?: (line: string) => void;
			/** who-fill: the background fill a page should wait for, or nothing when none is running. */
			ready?: () => Promise<unknown> | undefined;
			now?: () => number;
		} = {},
	) {}

	/** Start (or change) a window's watch and send its page now. */
	watch(key: K, pick: { initiative?: unknown; limit?: unknown }, send: (msg: ServerMessage) => void): void {
		const initiative = typeof pick.initiative === "string" ? pick.initiative.slice(0, 80) : undefined;
		const n =
			typeof pick.limit === "number" && Number.isFinite(pick.limit)
				? Math.floor(pick.limit)
				: INITIATIVES_LIMIT_DEFAULT;
		const w: Watcher = {
			...(initiative !== undefined ? { initiative } : {}),
			limit: Math.max(1, Math.min(n, INITIATIVES_LIMIT_MAX)),
			send,
		};
		this.watchers.set(key, w);
		this.sendTo(w);
	}

	drop(key: K): void {
		this.watchers.delete(key);
		if (this.watchers.size === 0 && this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	/** Something changed: every watcher gets its page again, once things settle. */
	poke(): void {
		if (this.watchers.size === 0) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			for (const w of this.watchers.values()) this.sendTo(w);
		}, this.opts.debounceMs ?? INITIATIVES_DEBOUNCE_MS);
		this.timer.unref?.();
	}

	get size(): number {
		return this.watchers.size;
	}

	private sendTo(w: Watcher): void {
		let pending: Promise<unknown> | undefined;
		try {
			pending = this.opts.ready?.();
		} catch {
			pending = undefined;
		}
		if (pending) {
			// One wait per watcher: asking again meanwhile (a poke, a reconnect's re-send) builds nothing more.
			if (w.waitingSince !== undefined) return;
			const now = this.opts.now ?? Date.now;
			w.waitingSince = now();
			const again = () => {
				// Still this window's watch? A dropped or replaced one gets nothing.
				if (!this.isCurrent(w)) {
					delete w.waitingSince;
					return;
				}
				let next: Promise<unknown> | undefined;
				try {
					next = this.opts.ready?.();
				} catch {
					next = undefined;
				}
				// A new fill started meanwhile (the records file was replaced): wait for that one too.
				if (next) {
					void next.then(again, again);
					return;
				}
				const waited = now() - (w.waitingSince ?? now());
				delete w.waitingSince;
				this.opts.log?.(`[initiatives] page waited ${Math.round(waited)} ms for the who-fill`);
				this.build(w);
			};
			void pending.then(again, again);
			return;
		}
		this.build(w);
	}

	private isCurrent(w: Watcher): boolean {
		for (const v of this.watchers.values()) if (v === w) return true;
		return false;
	}

	private build(w: Watcher): void {
		let msg: ServerMessage;
		try {
			msg = { type: "initiatives", page: this.read(w.initiative, w.limit) };
		} catch (err) {
			const error = (err as Error).message || String(err);
			this.opts.log?.(`[initiatives] couldn't make the page: ${error}`);
			msg = { type: "initiatives", error };
		}
		try {
			w.send(msg);
		} catch {
			/* a closing socket */
		}
	}
}
