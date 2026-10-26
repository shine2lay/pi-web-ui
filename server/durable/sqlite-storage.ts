import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export { openNodeSqliteStorage };
/** Same retention as pi-durable's incremental context and document caches. */
export const DURABLE_IDLE_RETENTION_MS = 10 * 60 * 1000;

export function durableDatabasePath(dataDir: string, cwd: string): string {
	const slug = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 12);
	return join(dataDir, "durable", `session-${slug}.sqlite`);
}

/** Deliberately no silent MemoryStorage fallback: a durable chat must survive restart. */
export async function openDurableStorage(dataDir: string, cwd: string) {
	const path = durableDatabasePath(dataDir, cwd);
	await mkdir(join(dataDir, "durable"), { recursive: true, mode: 0o700 });
	const storage = await openNodeSqliteStorage(path);
	return { storage, path, isMemory: false as const };
}

/** Idle projections only; active runs are pinned, and SQLite remains the source of truth. */
export class IdleSessionCache<T> {
	private readonly values = new Map<string, { value: T; touched: number; pins: number }>();
	constructor(
		private readonly now = Date.now,
		readonly retentionMs = DURABLE_IDLE_RETENTION_MS,
	) {}
	get size(): number {
		return this.values.size;
	}
	get(key: string): T | undefined {
		const entry = this.values.get(key);
		if (entry) entry.touched = this.now();
		return entry?.value;
	}
	set(key: string, value: T): void {
		this.values.set(key, { value, touched: this.now(), pins: 0 });
	}
	pin(key: string): () => void {
		const entry = this.values.get(key);
		if (!entry) throw new Error(`No durable session projection: ${key}`);
		entry.pins++;
		return () => {
			entry.pins--;
			entry.touched = this.now();
		};
	}
	evict(protectedIds: ReadonlySet<string> = new Set()): string[] {
		const evicted: string[] = [];
		for (const [key, entry] of this.values) {
			if (!protectedIds.has(key) && entry.pins === 0 && this.now() - entry.touched >= this.retentionMs) {
				this.values.delete(key);
				evicted.push(key);
			}
		}
		return evicted;
	}
	clear(): void {
		this.values.clear();
	}
}
