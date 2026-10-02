/**
 * identity-notebook-tab: sends an identity's notebook to the windows whose Notebook tab shows it.
 *
 * A window sends `identity_notebook_watch {id}`; it gets the notebook at once, then again whenever the
 * file's text changes, whoever changed it: a chat's notebook tool (pi-identity), the owner's save, the
 * weekly tidy-up, a hand edit. One watch per window (a new one replaces it; null or a closed socket
 * ends it).
 *
 * Changes are found by polling, and only while some window watches: a cheap stat each second (inode,
 * size, mtime, ctime), and a read + hash only when the stat changed. fs.watch isn't used: pi-identity
 * and the Settings page replace the file by rename (a new inode on every save), which a watcher on
 * the file loses, and a watcher on the folder is noisy across platforms. A window is sent the notebook
 * only when its hash differs from the one it last got, so a touch without a change sends nothing.
 *
 * identity-notes: the push also carries the role's notes index and what rules + index take (pi-identity's
 * two layers), so the stat signature covers the notes folder's files and the role's limits too, and a
 * window's "hash" is the whole push's (a note recorded by a chat updates the tab like a notebook edit).
 */

import { statSync } from "node:fs";
import { type IdentityDef, identityFilePath, readIdentityFile, textHash } from "./identities.js";
import { loadSettings, type Settings } from "./identity-config.js";
import { memorySignature, roleMemory } from "./identity-memory.js";
import type { ServerMessage } from "./protocol.js";

export type NotebookPush = Extract<ServerMessage, { type: "identity_notebook" }>;

interface Watcher {
	id: string;
	send: (msg: NotebookPush) => void;
	/** The hash of the push this window last got (null: none yet, or an error). */
	hash: string | null;
}

/** A push's hash: the notebook's and the notes' together (null: an error, always sent). */
const pushHash = (msg: NotebookPush): string | null => (msg.error !== undefined ? null : textHash(JSON.stringify(msg)));

export interface NotebookWatchOptions {
	/** The identities as they are now (the cached registry). */
	identities: () => IdentityDef[];
	/** identity-notes: the shared settings (the cached registry's; default: read them). */
	settings?: () => Settings;
	/** How often to look while someone watches (default 1 s). */
	intervalMs?: number;
}

export class NotebookWatch<K = unknown> {
	private readonly watchers = new Map<K, Watcher>();
	/** id -> the file's stat signature when it was last read. */
	private readonly seen = new Map<string, string>();
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly opts: NotebookWatchOptions) {}

	/** `key` (a window) shows identity `id`'s notebook from now on; null = it stopped. */
	watch(key: K, id: string | null, send: (msg: NotebookPush) => void): void {
		if (id === null) {
			this.drop(key);
			return;
		}
		const w: Watcher = { id, send, hash: null };
		this.watchers.set(key, w);
		// `seen` is left alone: other windows may watch this id and be behind; the next look compares
		// each window's hash, so this one isn't sent the same text twice.
		this.deliver(w, this.read(id));
		this.startTimer();
	}

	/** The window closed (or its tab did). */
	drop(key: K): void {
		this.watchers.delete(key);
		if (this.watchers.size === 0) {
			this.stopTimer();
			this.seen.clear();
		}
	}

	/** How many windows watch (tests). */
	get size(): number {
		return this.watchers.size;
	}

	/** Look now (the timer, or right after a save): send each watched notebook that changed to the
	 *  windows whose copy is behind. Never throws. */
	check(): void {
		try {
			const ids = new Set<string>();
			for (const w of this.watchers.values()) ids.add(w.id);
			for (const id of [...this.seen.keys()]) if (!ids.has(id)) this.seen.delete(id);
			for (const id of ids) {
				const sig = this.signature(id);
				if (this.seen.get(id) === sig) continue;
				this.seen.set(id, sig);
				const msg = this.read(id);
				const hash = pushHash(msg);
				for (const w of this.watchers.values()) {
					if (w.id === id && (hash === null || w.hash !== hash)) this.deliver(w, msg);
				}
			}
		} catch {
			/* a look that fails is retried at the next tick */
		}
	}

	/** Stop looking (server shutdown, tests). */
	close(): void {
		this.watchers.clear();
		this.seen.clear();
		this.stopTimer();
	}

	private settings(): Settings {
		return this.opts.settings ? this.opts.settings() : loadSettings();
	}

	private read(id: string): NotebookPush {
		const identities = this.opts.identities();
		const settings = this.settings();
		const r = readIdentityFile(identities, id, "notebook", settings);
		if (!r.ok) return { type: "identity_notebook", id, error: r.error };
		const def = identities.find((d) => d.id === id);
		let memory: NotebookPush["memory"];
		try {
			memory = def ? roleMemory(def, settings, r.text) : undefined;
		} catch {
			memory = undefined; // the notes couldn't be read: the rules still show
		}
		return {
			type: "identity_notebook",
			id,
			text: r.text,
			hash: r.hash,
			size: r.size,
			...(r.cap !== undefined ? { cap: r.cap } : {}),
			...(memory ? { memory } : {}),
		};
	}

	private signature(id: string): string {
		const def = this.opts.identities().find((d) => d.id === id);
		if (!def) return "unknown";
		let notes = "";
		try {
			notes = memorySignature(def, this.settings());
		} catch {
			notes = "notes unreadable";
		}
		try {
			const s = statSync(identityFilePath(def, "notebook"));
			return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}#${notes}`;
		} catch (err) {
			return `${(err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable"}#${notes}`;
		}
	}

	private deliver(w: Watcher, msg: NotebookPush): void {
		w.hash = pushHash(msg);
		try {
			w.send(msg);
		} catch {
			/* a dead window is dropped when its socket closes */
		}
	}

	private startTimer(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.check(), this.opts.intervalMs ?? 1_000);
		this.timer.unref?.();
	}

	private stopTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}
