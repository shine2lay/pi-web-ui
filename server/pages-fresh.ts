/**
 * pages-fresh (Ops #245, H-PAGES-FRESH-1 in docs/pages-fresh.md): the Roles and Initiatives pages' data kept
 * ready in the background, so opening either page is answered at once from what the server already has.
 *
 * One refresher for both, every PAGES_FRESH_MS while the server runs, whether or not a page is open. Its
 * round (given by index.ts) makes the Roles overview (RolesWatch.refresh: kept as the copy a new Roles watch
 * is answered with, with its time) and then the work page from that same overview (WorkPageWatch.refresh:
 * kept the same way); each is sent only where it changed. A round still running when the next one is due
 * isn't doubled: that tick is skipped. The first round waits one interval after the start, so it never adds
 * to the start's own work.
 *
 * Main thread, by the plan's slice rule: both builds' longest blocking slice measured 23 and 25 ms (under
 * 50 ms; docs/pages-fresh.md). The Initiatives decisions page (initiatives-watch.ts) isn't refreshed here:
 * its build is one 80-144 ms slice, so it stays built when a window asks, as before.
 *
 * Its cost is measured, not guessed: each round's wall time and the process's CPU time during it are summed
 * and said in the log once every PAGES_FRESH_REPORT_MS. The CPU figure is an upper bound: other work the
 * server does while a round waits for its files is counted too.
 */

/** How often the refresher makes both pages' data. */
export const PAGES_FRESH_MS = 15_000;
/** A part a watching window's own look made more recently than this is taken as it is. */
export const PAGES_FRESH_SKIP_MS = 5_000;
/** How often the refresher's cost is said in the log. */
export const PAGES_FRESH_REPORT_MS = 10 * 60_000;

export interface PagesFreshStats {
	/** Rounds finished (failed ones included) since the last report. */
	rounds: number;
	/** Ticks skipped because the round before was still running. */
	skipped: number;
	failed: number;
	/** Summed wall time of the rounds, and the longest one (ms). */
	wallMs: number;
	maxWallMs: number;
	/** Summed process CPU time during the rounds (ms; an upper bound of the refresher's own). */
	cpuMs: number;
	/** When this count began (this clock, ms). */
	since: number;
}

export interface PagesRefresherOptions {
	everyMs?: number;
	reportMs?: number;
	log?: (line: string) => void;
	/** This server's clock (tests). */
	now?: () => number;
	/** The process's CPU time so far, in ms (tests). */
	cpuMs?: () => number;
}

const processCpuMs = (): number => {
	const u = process.cpuUsage();
	return (u.user + u.system) / 1000;
};

export class PagesRefresher {
	private timer: ReturnType<typeof setInterval> | null = null;
	private running: Promise<void> | null = null;
	private lastError: string | null = null;
	private stats: PagesFreshStats;
	private readonly everyMs: number;
	private readonly reportMs: number;
	private readonly now: () => number;
	private readonly cpuMs: () => number;

	constructor(
		private readonly round: () => Promise<void>,
		private readonly opts: PagesRefresherOptions = {},
	) {
		this.everyMs = opts.everyMs ?? PAGES_FRESH_MS;
		this.reportMs = opts.reportMs ?? PAGES_FRESH_REPORT_MS;
		this.now = opts.now ?? Date.now;
		this.cpuMs = opts.cpuMs ?? processCpuMs;
		this.stats = this.fresh();
	}

	/** Every everyMs from now on, the first one interval from now. */
	start(): void {
		if (this.timer) return;
		this.stats = this.fresh();
		this.timer = setInterval(() => void this.tick(), this.everyMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	get started(): boolean {
		return this.timer !== null;
	}

	/** One round now, unless the one before is still running: then this tick is skipped (null). */
	tick(): Promise<void> | null {
		if (this.running) {
			this.stats.skipped++;
			return null;
		}
		const t0 = this.now();
		const c0 = this.cpuMs();
		this.running = (async () => {
			try {
				await this.round();
				this.lastError = null;
			} catch (err) {
				this.stats.failed++;
				const error = (err as Error)?.message || String(err);
				// Said once, not every round.
				if (error !== this.lastError) this.opts.log?.(`[pages-fresh] a round failed: ${error}`);
				this.lastError = error;
			} finally {
				const wall = Math.max(0, this.now() - t0);
				this.stats.rounds++;
				this.stats.wallMs += wall;
				this.stats.maxWallMs = Math.max(this.stats.maxWallMs, wall);
				this.stats.cpuMs += Math.max(0, this.cpuMs() - c0);
				this.running = null;
				this.report();
			}
		})();
		return this.running;
	}

	/** The count since the last report (tests, and the report). */
	snapshot(): PagesFreshStats {
		return { ...this.stats };
	}

	/** Says the cost once every reportMs: rounds, skips, failures, wall mean and max, CPU as % of one core. */
	private report(): void {
		const now = this.now();
		const span = now - this.stats.since;
		if (span < this.reportMs) return;
		const s = this.stats;
		const cpuPct = span > 0 ? (100 * s.cpuMs) / span : 0;
		const mean = s.rounds ? s.wallMs / s.rounds : 0;
		this.opts.log?.(
			`[pages-fresh] ${s.rounds} rounds in ${Math.round(span / 1000)} s (${s.skipped} skipped, ${s.failed} failed): ` +
				`wall mean ${Math.round(mean)} ms, max ${Math.round(s.maxWallMs)} ms; CPU at most ${cpuPct.toFixed(2)}% of one core`,
		);
		this.stats = this.fresh();
	}

	private fresh(): PagesFreshStats {
		return { rounds: 0, skipped: 0, failed: 0, wallMs: 0, maxWallMs: 0, cpuMs: 0, since: this.now() };
	}
}
