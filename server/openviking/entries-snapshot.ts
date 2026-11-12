/**
 * OpenViking Memory Dashboard — the Memory list, built in the background and held in this server process
 * (Backend #155, architecture ruling rm-8e4a1631).
 *
 * One full listing is ~1860 `:1933` reads (median 21 s, p90 61 s live), so `GET /api/openviking/entries` never
 * reads it per request: one build runs at server start and once per `15m` cadence (spec.md:23, :51-52), never
 * two at once, and a request answers from the latest finished build. A request that comes before the first
 * build has finished joins that build instead of starting another.
 *
 * A build that failed keeps the last good snapshot (the #149 rule, as `memory-tree-cache.ts`): a failed build
 * (`null`: `/health` refused at build time) never replaces anything, and a partial build never replaces a
 * complete one — the complete one keeps answering, and its age shows as `"> 15m"` once past the cadence.
 * A build in flight reports when it started (`rebuildStartedAtMs()`), so a young rebuild can hide the age badge
 * (R-SNAPSHOT-STALE-1, architecture rm-3a23be76, QA #136 F5).
 */
import type { OpenVikingExplorerEntry } from "./types.js";

/** One finished listing of every scope and every role: what the slices of a request are cut from. */
export interface OpenVikingEntriesBuild {
	entries: readonly OpenVikingExplorerEntry[];
	/** The read units (spec §3a) this build could not read: `resources`, `user`, `agent:<role>`. */
	unread_units: ReadonlySet<string>;
	/** Epoch ms the build finished: the listing's `panel_updated_at`. */
	finished_at_ms: number;
}

/** Builds one listing; `null` when the build failed and must not replace what is held. */
export type OpenVikingEntriesBuilder = () => Promise<OpenVikingEntriesBuild | null>;

/** The #149 rule: a complete build always wins; a partial one only over nothing or another partial one. */
const replaces = (held: OpenVikingEntriesBuild | null, next: OpenVikingEntriesBuild): boolean =>
	held === null || next.unread_units.size === 0 || held.unread_units.size > 0;

export class OpenVikingEntriesSnapshot {
	private held: OpenVikingEntriesBuild | null = null;
	private inFlight: Promise<OpenVikingEntriesBuild | null> | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;

	private inFlightStartedAtMs: number | null = null;

	constructor(
		private readonly build: OpenVikingEntriesBuilder,
		private readonly now: () => number = Date.now,
	) {}

	/** The latest snapshot; with none held yet, the build in flight (or one started now) is awaited. */
	async read(): Promise<OpenVikingEntriesBuild | null> {
		return this.held ?? this.refresh();
	}

	/** The one build in flight: a caller that asks while it runs joins it. Resolves to what is held after it. */
	refresh(): Promise<OpenVikingEntriesBuild | null> {
		if (this.inFlight) return this.inFlight;
		this.inFlightStartedAtMs = this.now();
		const run = this.build()
			.then((next) => {
				if (next && replaces(this.held, next)) this.held = next;
				return this.held;
			})
			.finally(() => {
				this.inFlight = null;
				this.inFlightStartedAtMs = null;
			});
		this.inFlight = run;
		return run;
	}

	/** Epoch ms the build now in flight started; `null` with none running. */
	rebuildStartedAtMs(): number | null {
		return this.inFlightStartedAtMs;
	}

	/** Server start: one build now, then one per cadence; a tick while a build runs joins it (never overlaps). */
	start(cadenceMs: number): void {
		if (this.timer) return;
		const tick = () => {
			this.refresh().catch((err: unknown) => console.error("[openviking] entries snapshot build failed:", err));
		};
		tick();
		this.timer = setInterval(tick, cadenceMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}
