/**
 * initiatives-page (task #84): the Initiatives tab's watchers, one per window. A window gets its page at
 * once (its own pick of initiative and how many decisions), and again, debounced, when the decisions or the
 * reader change. The page is made from the kept files, so a failure is sent as an error the tab can show
 * (it keeps what it had).
 */
import type { ServerMessage, UiDecisionsPage } from "./protocol.js";

export const INITIATIVES_DEBOUNCE_MS = 500;
export const INITIATIVES_LIMIT_DEFAULT = 200;
export const INITIATIVES_LIMIT_MAX = 2000;

interface Watcher {
	initiative?: string;
	limit: number;
	send: (msg: ServerMessage) => void;
}

export class InitiativesWatch<K> {
	private readonly watchers = new Map<K, Watcher>();
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly read: (initiative: string | undefined, limit: number) => UiDecisionsPage,
		private readonly opts: { debounceMs?: number; log?: (line: string) => void } = {},
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
