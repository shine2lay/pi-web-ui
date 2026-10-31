/**
 * roles-json-file: a small JSON file the Roles page reads (the 6 am report job's runs, the scheduler's jobs), read
 * again only when it changed and never past its cap. Split out of roles-overview.ts (Backend #15), which still
 * exports both names.
 */

import { open, type FileHandle } from "node:fs/promises";
import { readUpTo, STATE_READ_FLAGS } from "./state-file-read.js";

/** The most a small JSON file (the report runs, the scheduler's jobs) may hold before it reads as empty. */
export const JSON_FILE_MAX = 8 << 20;

/** A small JSON file read again only when it changed. Read as the registry's log is (state-file-read.ts): a
 *  FIFO, device or folder in its place, or one bigger than 8 MiB (also when it grows while read), reads as
 *  empty at once. */
export class JsonFile<T> {
	private seen: { mtimeMs: number; size: number; value: T } | null = null;
	constructor(
		private readonly path: () => string,
		private readonly parse: (raw: unknown) => T,
		private readonly empty: T,
	) {}
	async get(): Promise<T> {
		let fh: FileHandle;
		try {
			fh = await open(this.path(), STATE_READ_FLAGS);
		} catch {
			this.seen = null;
			return this.empty;
		}
		try {
			const st = await fh.stat();
			if (!st.isFile() || st.size > JSON_FILE_MAX) {
				this.seen = null;
				return this.empty;
			}
			if (this.seen && this.seen.mtimeMs === st.mtimeMs && this.seen.size === st.size) return this.seen.value;
			const bytes = await readUpTo(fh, JSON_FILE_MAX, 1 << 20);
			if (bytes === null) {
				this.seen = null;
				return this.empty;
			}
			const value = this.parse(JSON.parse(bytes.toString("utf8")));
			this.seen = { mtimeMs: st.mtimeMs, size: st.size, value };
			return value;
		} catch {
			this.seen = null;
			return this.empty;
		} finally {
			await fh.close().catch(() => undefined);
		}
	}
}
