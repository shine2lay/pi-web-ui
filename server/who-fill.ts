/**
 * who-fill (Architecture #115, H-INIT-WHO-FILL): fill the who-cache in the background after each start.
 *
 * The who-cache (who-cache.ts, #99) lives in memory only, so after every restart the first Initiatives page
 * build worked out who decided for every source of every decision on the main thread: 7.5-9.5 s live with
 * every chat frozen (9.5 s at 11:40:00 on Oct 19). Restarts are frequent with continuous deploys.
 *
 * The fill walks the decisions a page build walks, and every source of each (the decision's, then each
 * change's), through the same sourceView that decisionView and changeView call, with the same record and was
 * record and the same cache, so the cache gets exactly the keys a build asks for; the views are thrown away.
 * It goes source by source, not decision by decision, because one decision can cite 81 sources and take
 * up to about 200 ms on its own. It works in slices: a slice stops once about sliceMs of work is done and the next
 * one waits for setImmediate, so other work (sockets, chats) runs between them. A fill whose cache was cleared meanwhile (the records file was replaced or shrank)
 * stops at the next slice; its owner starts a new one.
 */
import type { DecisionRecord } from "./decision-records.js";
import type { DecisionEntry, DecisionSourceRef } from "./decision-store.js";
import { sourceView } from "./decision-view.js";
import type { WhoCache } from "./who-cache.js";

export const WHO_FILL_SLICE_MS = 25;

export interface WhoFillStats {
	/** Decisions walked. */
	decisions: number;
	/** Their sources and their changes' sources. */
	sources: number;
	/** Answers kept in the cache afterwards. */
	answers: number;
	/** whoOf calls the fill made (answers that weren't kept yet). */
	computed: number;
	slices: number;
	/** The longest slice's work, in ms. */
	longestMs: number;
	/** From the start to the end, waits between slices included, in ms. */
	totalMs: number;
}

export interface WhoFillOptions {
	/** A slice stops once this much work is done (default WHO_FILL_SLICE_MS). */
	sliceMs?: number;
	now?: () => number;
	/** Waits between slices (default: setImmediate). */
	yieldNow?: () => Promise<void>;
}

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Fill cache with who decided for every source of decisions (the list a page build walks), as a page build
 * would. Resolves with the numbers, or null when the cache was cleared before the fill ended (it stopped).
 */
export async function fillWhoCache(
	decisions: readonly DecisionEntry[],
	recs: Map<string, DecisionRecord>,
	cache: WhoCache,
	opts: WhoFillOptions = {},
): Promise<WhoFillStats | null> {
	const now = opts.now ?? (() => performance.now());
	const yieldNow = opts.yieldNow ?? nextTick;
	const sliceMs = opts.sliceMs ?? WHO_FILL_SLICE_MS;
	const start = now();
	const epoch = cache.epoch;
	const missesBefore = cache.misses;
	// A fill counts as a build, so what it keeps is what the next build uses (newBuild keeps two builds' answers).
	cache.newBuild();
	// decisionView's sources, then changeView's for each change, in the page's order.
	const sources: DecisionSourceRef[] = [];
	for (const d of decisions) {
		for (const s of d.sources) sources.push(s);
		for (const c of d.changes) for (const s of c.sources) sources.push(s);
	}
	let i = 0;
	let slices = 0;
	let longestMs = 0;
	while (i < sources.length) {
		if (cache.epoch !== epoch) return null;
		const s = now();
		do {
			const src = sources[i++];
			if (src)
				sourceView(src, src.record ? recs.get(src.record) : undefined, src.was ? recs.get(src.was) : undefined, cache);
		} while (i < sources.length && now() - s < sliceMs);
		const ms = now() - s;
		slices++;
		if (ms > longestMs) longestMs = ms;
		if (i < sources.length) await yieldNow();
	}
	return {
		decisions: decisions.length,
		sources: sources.length,
		answers: cache.size,
		computed: cache.misses - missesBefore,
		slices,
		longestMs,
		totalMs: now() - start,
	};
}

/** What a fill walks: the decisions a page build walks and the kept records by id. */
export interface WhoFillSource {
	decisions: readonly DecisionEntry[];
	recs: Map<string, DecisionRecord>;
}

/**
 * One fill at a time for one cache (AgentService keeps one). start() while a fill runs asks for another after
 * it: the records file was replaced or shrank meanwhile. pending() is the fill running now, which an
 * Initiatives page waits for (initiatives-watch.ts's ready). A failed fill is logged and leaves the cache as
 * it is: pages build as before, working out what isn't kept.
 */
export class WhoFiller {
	private run: Promise<void> | null = null;
	private again = false;

	constructor(
		private readonly cache: WhoCache,
		/** Read when the fill starts (after a setImmediate, so the caller's own work ends first). */
		private readonly source: () => WhoFillSource,
		private readonly opts: WhoFillOptions & {
			log?: (line: string) => void;
			/** Every fill's end: its numbers, null when it stopped, or the error. */
			onEnd?: (stats: WhoFillStats | null, err?: unknown) => void;
		} = {},
	) {}

	start(): void {
		if (this.run) {
			this.again = true;
			return;
		}
		this.again = false;
		const log = this.opts.log ?? ((line: string) => console.log(line));
		const run = (async () => {
			await nextTick();
			const { decisions, recs } = this.source();
			// Reading the source may have seen the file change and asked for a fill: this one covers it.
			this.again = false;
			const stats = await fillWhoCache(decisions, recs, this.cache, this.opts);
			if (stats)
				log(
					`[who-fill] decisions=${stats.decisions} sources=${stats.sources} answers=${stats.answers} computed=${stats.computed} slices=${stats.slices} longest_ms=${Math.round(stats.longestMs)} total_ms=${Math.round(stats.totalMs)}`,
				);
			else log("[who-fill] stopped: the records file changed meanwhile");
			this.opts.onEnd?.(stats);
		})()
			.catch((err: unknown) => {
				log(`[who-fill] failed: ${err instanceof Error ? err.message : String(err)}`);
				this.opts.onEnd?.(null, err);
			})
			.finally(() => {
				this.run = null;
				if (this.again) this.start();
			});
		this.run = run;
	}

	/** The fill running now, or nothing. It never rejects. */
	pending(): Promise<void> | undefined {
		return this.run ?? undefined;
	}
}
