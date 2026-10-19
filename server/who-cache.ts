/**
 * who-cache (Architecture #99, H-INIT-WHO-CACHE): who decided (decision-who's whoOf), kept between
 * Initiatives page builds.
 *
 * Every page build works out who decided for every source of every decision, whichever initiative is shown.
 * On Oct 18's store (3,991 decisions) that took 4.4-5.2 s offline and 7.5-9.5 s live, with the server blocked
 * meanwhile, once per watcher on every page open, reconnect and decision change. A freeze dropped the other
 * tabs' sockets, and each reconnect built the page again (11 freezes of 7-10 s in under 2 minutes).
 *
 * whoOf's answer depends only on its arguments: the record, the plan's version before it (was) and the
 * source's quotes, claimsOwner, part and by. A kept record never changes while records.jsonl only grows:
 * append() refuses a second (source, ref), list() keeps the first line of each, and a record's id is a hash
 * of its source and ref. So a record's id stands for its content, and the answer can be kept under the two
 * ids and the source's four fields. The cache's owner (AgentService.keptRecords) tells it about every new
 * read of the file (sawFile), and it starts over when the file was replaced or shrank.
 *
 * Without a cache the page is built as before. The decision reader, the decision_log tool, the feed check
 * and the progress feed call whoOf themselves and don't use one.
 */
import type { DecisionRecord } from "./decision-records.js";
import { type Who, type WhoSource, whoOf } from "./decision-who.js";

/** What of a source whoOf reads (decision-store's DecisionSourceRef has all four). */
export type WhoPoint = Pick<WhoSource, "quotes" | "claimsOwner" | "part" | "by">;

/**
 * The cache key: the record's id, the was record's id and the source's by, part, claimsOwner and quotes, as one
 * JSON array. JSON writes every `"` inside a text as `\"`, so the `","` between fields never occurs inside one,
 * and no field's text can run into the next (["a\",\"b"] isn't ["a","b"]). A missing record is "-" (a kept
 * record's id is "dr-" and 12 hex digits).
 */
export function whoKey(rec: DecisionRecord | undefined, src: WhoPoint, was?: DecisionRecord): string {
	return JSON.stringify([
		rec?.id ?? "-",
		was?.id ?? "-",
		src.by ?? null,
		src.part ?? null,
		src.claimsOwner ?? null,
		src.quotes ?? null,
	]);
}

/** A copy the caller owns: its arrays are its own, so no caller can change a kept answer. */
function copyOf(w: Who): Who {
	return { ...w, flags: [...w.flags], places: [...w.places] };
}

interface Entry {
	who: Who;
	/** The last build that used it. */
	used: number;
}

export class WhoCache {
	private readonly entries = new Map<string, Entry>();
	private build = 0;
	private computed = 0;
	private file: { ino: number; size: number } | undefined;
	private cleared = 0;

	/** Who decided: whoOf(rec, { ...src, was }), worked out once per record, was record and source fields. */
	get(rec: DecisionRecord | undefined, src: WhoPoint, was?: DecisionRecord): Who {
		const key = whoKey(rec, src, was);
		let e = this.entries.get(key);
		if (e) e.used = this.build;
		else {
			const who = whoOf(rec, { quotes: src.quotes, claimsOwner: src.claimsOwner, part: src.part, by: src.by, was });
			this.computed++;
			e = { who, used: this.build };
			this.entries.set(key, e);
		}
		return copyOf(e.who);
	}

	/** A page build starts: the answers neither of the last two builds used are dropped. */
	newBuild(): void {
		this.build++;
		for (const [key, e] of this.entries) if (e.used < this.build - 2) this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
		this.cleared++;
	}

	/** Times the answers were dropped (clear): a background fill (who-fill.ts) that sees it change stops. */
	get epoch(): number {
		return this.cleared;
	}

	/**
	 * The records file was read again (its inode and size; size 0 and inode -1 when there is none). A replaced
	 * file (another inode) or one that shrank was rewritten, and a record kept before may read differently now:
	 * everything is dropped. A file that only grew keeps every answer. True when it dropped them.
	 */
	sawFile(ino: number, size: number): boolean {
		const rewritten = this.file !== undefined && (this.file.ino !== ino || size < this.file.size);
		if (rewritten) this.clear();
		this.file = { ino, size };
		return rewritten;
	}

	/** Answers kept. */
	get size(): number {
		return this.entries.size;
	}

	/** whoOf calls made so far (answers that weren't kept yet). */
	get misses(): number {
		return this.computed;
	}
}
