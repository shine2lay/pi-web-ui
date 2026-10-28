/**
 * canonical-readers (Ops #621): pi-queue's own readers, which pi-queue puts on globalThis when it loads (pi-queue
 * readers.ts, Ops #620).
 *
 * pi-queue runs inside this server: every chat with the extension loads a copy of it, and the copy loaded last
 * publishes its readers (after `wt land` and a restart, the newest code). Once one chat has loaded it, the Queue panel
 * and the Roles page fold queues and the work registry with pi-queue's own code, so they show what pi-queue itself
 * will do, and a change to pi-queue's records (a new change type, the work log's compaction) reaches them without a
 * copy here. Until then (a server with no chat open yet) and in unit tests without pi-queue, this repo's own readers
 * do it: task-queue.ts's apply (a mirror of pi-queue's applyOp) and work-records.ts's workRecordsFrom.
 *
 * pi-queue publishes the same object under Symbol.for("pi-queue.readers") and Symbol.for("pi-queue.readers.v1"). The
 * versioned key is the one read here: a change to the object's shape comes under a new key and version (".v2"), so
 * this file never gets a shape it doesn't know. Anything else in the slot reads as no readers.
 */

/** The key pi-queue publishes its version-1 readers under (pi-queue readers.ts: READERS_V1_KEY). */
export const PI_QUEUE_READERS_KEY = Symbol.for("pi-queue.readers.v1");

/** A session entry as pi-queue's replay reads it. */
export interface PiQueueEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/** What this server uses of pi-queue's readers (pi-queue's QueueReaders, version 1). */
export interface PiQueueReaders {
	readonly version: 1;
	/** A queue's state from session entries in branch order (pi-queue's replay; its QueueState). */
	replay(entries: Iterable<PiQueueEntry>, queueId?: string): unknown;
	/** The work registry from `<dir>/events.jsonl` (pi-queue's readWork; its WorkState). Throws when the log can't be used. */
	readWork(dir: string): unknown;
}

/** pi-queue's readers, once a pi-queue with version-1 readers has loaded in this process; else undefined. */
export function piQueueReaders(): PiQueueReaders | undefined {
	const slot = (globalThis as Record<symbol, unknown>)[PI_QUEUE_READERS_KEY];
	if (!slot || typeof slot !== "object") return undefined;
	const r = slot as Partial<PiQueueReaders>;
	if (r.version !== 1 || typeof r.replay !== "function" || typeof r.readWork !== "function") return undefined;
	return r as PiQueueReaders;
}
