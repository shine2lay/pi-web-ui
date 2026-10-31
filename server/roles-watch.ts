/**
 * roles-watch: pushes the Roles page's overview to the windows that watch it (the page gets everything, the top
 * bar only the count). It looks again on a timer and on pokes, and sends only what changed. Split out of
 * roles-overview.ts (Backend #15), which still exports these names.
 */

import type {
	ServerMessage,
	UiRoleUsageCost,
	UiRolesOverview,
	UiRolesUsageRenderAck,
	UiRolesUsageRenderTiming,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// Pushing it: to the windows that watch (the page: everything; the top bar: the count)
// ---------------------------------------------------------------------------

export interface RolesWatchOptions {
	/** How often to look again while a Roles page is open / while only top bars watch. */
	fullMs?: number;
	countMs?: number;
	/** Unchanged: a page still hears "checked at" this often. */
	heartbeatMs?: number;
	/** Several changes close together make one look. */
	debounceMs?: number;
	log?: (line: string) => void;
	/** Server clock only, injectable for timing fixtures. */
	now?: () => number;
}

/**
 * One window's watch. A full watcher's first overview may be the last one built (sent at once on watch); the window
 * counts its data as current only once a later check reaches it (pages-live, Ops #244), so the first look that
 * finishes after the watch confirms it even when nothing changed, instead of leaving it to the heartbeat.
 */
function usageGenerationFresh(cost: UiRoleUsageCost, now: number): boolean {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "America/Los_Angeles",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(now);
	const part = (key: string) => parts.find((p) => p.type === key)!.value;
	const monday = new Date(`${part("year")}-${part("month")}-${part("day")}T00:00:00.000Z`);
	monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
	return (
		cost.state === "ready" &&
		cost.weekStart === monday.toISOString().slice(0, 10) &&
		cost.evaluatedAt !== null &&
		now >= Date.parse(cost.evaluatedAt) &&
		now - Date.parse(cost.evaluatedAt) <= 60_000 &&
		cost.usage?.freshness === "fresh" &&
		cost.usage.observedAt !== null &&
		[cost.usage.coveredThrough, cost.usage.observedAt].every((t) => t === null || now - Date.parse(t) <= 60_000)
	);
}

interface RolesWatcher {
	full: boolean;
	send: (msg: ServerMessage) => void;
	/** checkedAt of the first overview this window got; null until it got one. */
	firstAt: number | null;
	/** A newer check reached it after its first overview. */
	confirmed: boolean;
	usageWatch: number;
	usageSent: Map<string, { cost: UiRoleUsageCost; pushedAt: number }>;
	usageTimings: Map<string, UiRolesUsageRenderTiming>;
}

/** The windows watching the roles, keyed by their socket: looks again on a timer and on pokes. */
export class RolesWatch<K> {
	private readonly watchers = new Map<K, RolesWatcher>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private running: Promise<void> | null = null;
	private again = false;
	private last: { overview: UiRolesOverview; json: string; checkedAt: number; heard: number } | null = null;
	private lastError: string | null = null;
	private stopped = false;
	private usageWatch = 0;
	private readonly o: Required<Omit<RolesWatchOptions, "log">> & Pick<RolesWatchOptions, "log">;

	constructor(
		private readonly read: () => Promise<UiRolesOverview>,
		opts: RolesWatchOptions = {},
	) {
		this.o = {
			fullMs: opts.fullMs ?? 3_000,
			countMs: opts.countMs ?? 10_000,
			heartbeatMs: opts.heartbeatMs ?? 30_000,
			debounceMs: opts.debounceMs ?? 300,
			log: opts.log,
			now: opts.now ?? Date.now,
		};
	}

	/** This window wants everything (full) or just the count; it gets what is known at once. */
	watch(key: K, full: boolean, send: (msg: ServerMessage) => void): void {
		const watcher: RolesWatcher = {
			full,
			send,
			firstAt: null,
			confirmed: false,
			usageWatch: ++this.usageWatch,
			usageSent: new Map(),
			usageTimings: new Map(),
		};
		this.watchers.set(key, watcher);
		const last = this.last;
		if (last) {
			const asks = last.overview.asks.length;
			if (full) this.sendOverview(watcher, last.overview, last.checkedAt);
			else send({ type: "roles", asks });
			if (full) watcher.firstAt = last.checkedAt;
		}
		this.schedule(last ? this.o.debounceMs : 0);
	}

	/** A push is NOT render proof. Pin only this socket/watch's most recently sent role generations. */
	private sendOverview(w: RolesWatcher, overview: UiRolesOverview, checkedAt: number): void {
		const pushedAt = this.o.now();
		w.usageSent.clear();
		w.usageTimings.clear();
		for (const row of overview.roles.slice(0, 64)) {
			const cost = row.usageCost;
			if (cost?.role === row.id && cost.generation && usageGenerationFresh(cost, pushedAt))
				w.usageSent.set(row.id, { cost: structuredClone(cost), pushedAt });
		}
		w.send({
			type: "roles",
			overview,
			asks: overview.asks.length,
			checkedAt,
			...(w.usageSent.size ? { usageRender: { watch: w.usageWatch, pushedAt } } : {}),
		});
	}

	/** Closed optional DOM telemetry only. Reject foreign socket/watch/role, stale or unseen generations. */
	acknowledgeUsage(key: K, raw: unknown): boolean {
		const w = this.watchers.get(key);
		if (!w?.full || !raw || typeof raw !== "object" || Array.isArray(raw)) return false;
		const ack = raw as UiRolesUsageRenderAck;
		if (
			Object.keys(raw).sort().join(",") !== "generation,role,watch" ||
			ack.watch !== w.usageWatch ||
			typeof ack.role !== "string" ||
			!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(ack.role) ||
			ack.role.length > 60 ||
			!ack.generation ||
			typeof ack.generation !== "object" ||
			Array.isArray(ack.generation) ||
			Object.keys(ack.generation).sort().join(",") !== "epoch,sequence" ||
			typeof ack.generation.epoch !== "string" ||
			ack.generation.epoch.length !== 64 ||
			!/^[a-f0-9]{64}$/.test(ack.generation.epoch) ||
			!Number.isSafeInteger(ack.generation.sequence) ||
			ack.generation.sequence < 0
		)
			return false;
		const sent = w.usageSent.get(ack.role);
		const current = this.last?.overview.roles.find((r) => r.id === ack.role)?.usageCost;
		const gen = sent?.cost.generation;
		const at = this.o.now();
		if (
			!sent ||
			!gen ||
			w.usageTimings.has(ack.role) ||
			this.lastError !== null ||
			!current ||
			!usageGenerationFresh(current, at) ||
			current.generation?.epoch !== gen.epoch ||
			current.generation.sequence !== gen.sequence ||
			gen.epoch !== ack.generation.epoch ||
			gen.sequence !== ack.generation.sequence ||
			at < sent.pushedAt ||
			at - Date.parse(sent.cost.evaluatedAt!) > 60_000
		)
			return false;
		const first = sent.cost.firstNativeObservedAt;
		const timing: UiRolesUsageRenderTiming = {
			watch: ack.watch,
			role: ack.role,
			generation: { ...gen },
			pushedAt: sent.pushedAt,
			acknowledgedAt: at,
			firstNativeObservedAt: first,
			pushToAckMs: at - sent.pushedAt,
			firstObservationToAckMs: first === null ? null : at - first,
		};
		w.usageTimings.set(ack.role, timing);
		w.send({ type: "roles", asks: this.last?.overview.asks.length ?? 0, usageRenderTiming: { ...timing } });
		return true;
	}

	/** Passive server-clock diagnostics; no mutation or coverage inference. */
	usageRenderTimings(key: K): UiRolesUsageRenderTiming[] {
		return structuredClone([...(this.watchers.get(key)?.usageTimings.values() ?? [])]);
	}

	drop(key: K): void {
		this.watchers.delete(key);
		if (!this.watchers.size && this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	/** Something changed (role messages, a chat's state): look again soon. */
	poke(): void {
		if (this.watchers.size) this.schedule(this.o.debounceMs);
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.watchers.clear();
	}

	get watching(): number {
		return this.watchers.size;
	}

	/** Windows with the Roles page itself open (not only the top bars): usage-accounting builds W5 for them. */
	get fullWatching(): number {
		let n = 0;
		for (const w of this.watchers.values()) if (w.full) n++;
		return n;
	}

	private schedule(ms: number): void {
		if (this.stopped || !this.watchers.size) return;
		if (this.running) {
			this.again = true;
			return;
		}
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.look();
		}, ms);
		this.timer.unref?.();
	}

	/**
	 * pages-fresh (Ops #245): the background refresher's round. Looks now, whether or not a window watches, and
	 * keeps the overview as the copy a new watch is answered with (with its time), sent only where it changed,
	 * like any look. While a look is under way it waits for that one instead; a copy younger than
	 * `skipYoungerMs` (a watching window's look made it) is taken as it is. Returns the overview it has, or null
	 * when the look failed.
	 */
	async refresh(skipYoungerMs = 0): Promise<UiRolesOverview | null> {
		if (this.stopped) return null;
		const last = this.last;
		if (!this.running && last && this.lastError === null && Date.now() - last.checkedAt < skipYoungerMs)
			return last.overview;
		await (this.running ?? this.look(true));
		return this.lastError === null ? (this.last?.overview ?? null) : null;
	}

	/** Looks once (tests call it directly); `always` (pages-fresh): even with no window watching. */
	look(always = false): Promise<void> {
		if (this.running) {
			this.again = true;
			return this.running;
		}
		this.running = (async () => {
			try {
				let first = true;
				do {
					this.again = false;
					await this.lookOnce(first && always);
					first = false;
				} while (this.again && !this.stopped && this.watchers.size);
			} finally {
				this.running = null;
				const full = [...this.watchers.values()].some((w) => w.full);
				this.schedule(full ? this.o.fullMs : this.o.countMs);
			}
		})();
		return this.running;
	}

	private async lookOnce(always = false): Promise<void> {
		if (!always && !this.watchers.size) return;
		let overview: UiRolesOverview;
		try {
			overview = await this.read();
		} catch (err) {
			const error = (err as Error)?.message || String(err);
			if (error !== this.lastError) this.o.log?.(`[roles] couldn't make the overview: ${error}`);
			this.lastError = error;
			const asks = this.last?.overview.asks.length ?? 0;
			for (const w of this.watchers.values())
				if (w.full) {
					w.usageSent.clear();
					w.send({ type: "roles", asks, error });
				}
			return;
		}
		this.lastError = null;
		const { at: _at, ...rest } = overview;
		const json = JSON.stringify(rest);
		const prev = this.last;
		const asks = overview.asks.length;
		const now = overview.at;
		if (prev && prev.json === json) {
			prev.checkedAt = now;
			const beat = now - prev.heard >= this.o.heartbeatMs;
			if (beat) prev.heard = now;
			for (const w of this.watchers.values()) {
				if (!w.full) continue;
				const confirms = !w.confirmed && w.firstAt !== null && now > w.firstAt;
				if (!beat && !confirms) continue;
				w.send({ type: "roles", asks, checkedAt: now });
				if (confirms) w.confirmed = true;
			}
			return;
		}
		const countChanged = !prev || prev.overview.asks.length !== asks;
		this.last = { overview, json, checkedAt: now, heard: now };
		for (const w of this.watchers.values()) {
			if (w.full) {
				this.sendOverview(w, overview, now);
				if (w.firstAt === null) w.firstAt = now;
				else if (now > w.firstAt) w.confirmed = true;
			} else if (countChanged) w.send({ type: "roles", asks });
		}
	}
}
