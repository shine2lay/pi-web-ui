/**
 * reconnect-trace: why the "Reconnecting…" note shows (Ops queue #157).
 *
 * The page decides on its own when to show the note (web/src/conn-health.ts: no frames for 5 s, no
 * answer after coming back, a closed socket). Nothing recorded why. This keeps a metadata-only log,
 * <dataDir>/conn-events.jsonl, with:
 *   - loop:   every 10 s, the server's event-loop delay (p99 and max, perf_hooks), the process's CPU
 *             time, passive GC pause totals (PerformanceObserver "gc"; no inspector, no forced GC),
 *             load, heap and RSS: a stall with high CPU and long GC, high CPU and little GC, or low
 *             CPU (blocking I/O, a starved machine) point to different causes;
 *   - open:   a page's socket said hello (socket id, hashed client id);
 *   - close:  a socket closed (close code, how long it lived; never the close-reason text);
 *   - banner: a page's own record of one note episode (web/src/conn-trace.ts), placed on the server's
 *             clock, with the worst event-loop delay the server measured meanwhile;
 *   - notice: whether the owner was told (one Telegram line at most every 10 minutes, later ones summed).
 * Never: chat text, prompts, tool results, credentials, cookies, URLs, IPs, user agents or bodies.
 *
 * <dataDir>/conn-trace.json: {"enabled": false} is master-off. {"enabled": true,"notices": false}
 * keeps capture but stays silent. Notices require explicit true; missing notices is silent. A mute or
 * changed opt-in discards queued notices, never replaying muted backlog (Ops #157, rm-2917f21e).
 * Files roll over each UTC day to conn-events-YYYY-MM-DD.jsonl and are kept 7 days.
 */
import { createHash, randomBytes } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, PerformanceObserver, performance, type ELDHistogram } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import type { ConnTraceReason, ConnTraceRecord } from "./protocol.js";

export const CONFIG_FILE = "conn-trace.json";
export const LOG_FILE = "conn-events.jsonl";
export const STATE_FILE = "conn-notify-state.json";
export const LOOP_SAMPLE_MS = 10_000;
export const KEEP_DAYS = 7;
/** At most one owner notice per this long; what happens meanwhile is summed up in the next. */
export const NOTICE_GAP_MS = 10 * 60_000;
/** Loop samples kept in memory to place an episode (2 h). */
const RING_SAMPLES = 720;
/** A day's file stops taking loop/socket lines past this (episodes and notices still go in). */
const DAY_CAP_BYTES = 32 * 1024 * 1024;
/** Re-read the switch at most this often. */
const CONFIG_TTL_MS = 3_000;
/** Records one message may carry, and one socket may send in its life. */
export const MAX_RECORDS_PER_MESSAGE = 20;
export const MAX_RECORDS_PER_SOCKET = 50;
/** Longest episode/duration taken (a day); anything bigger is clamped. */
const MAX_MS = 86_400_000;
/** A notice waits this long for the transport, then counts as not sent. */
const DELIVER_TIMEOUT_MS = 30_000;
/** GC pauses at least this long are kept one by one (2 h at most) to place against an episode. */
const LONG_GC_MS = 50;
const LONG_GC_KEEP = 500;
/** The stall watcher: a timer this often; a gap at least STALL_MIN_MS over it is a main-thread stall,
 *  written as its own line at once, and the last 500 kept to place against an episode. */
export const STALL_TICK_MS = 250;
export const STALL_MIN_MS = 1_000;
const STALL_KEEP = 500;

export const REASONS: readonly ConnTraceReason[] = [
	"close",
	"silence",
	"silence_explained",
	"probe",
	"connect_timeout",
	"doubt",
	"unknown",
];

/** What a notice transport (the Telegram plugin, host.connNotices) gets: fixed fields only. */
export interface ConnNotice {
	/** "cn-" + hex: dedupe across restarts. */
	id: string;
	/** "event": one episode (plus a sum of the ones held back before it); "summary": only held-back ones. */
	kind: "event" | "summary";
	/** event: when the note came up (server clock, ms); summary: when the first held-back one did. */
	at: number;
	/** event: how long it showed. */
	durMs: number;
	reason: ConnTraceReason;
	closeCode: number | null;
	/** Worst server event-loop delay measured while it showed (ms); null when not measured. */
	maxLoopMs: number | null;
	/** The page was hidden when the note came up (the owner didn't see it). */
	hidden: boolean;
	/** Episodes held back by the 10-minute limit, summed up. */
	more: { count: number; totalMs: number; worstLoopMs: number | null; since: number } | null;
	/** The server process started while the note showed (an install or a crash restarted it). */
	restart: boolean;
}

export type ConnNoticeDeliver = (n: ConnNotice, permitted?: () => boolean) => Promise<boolean>;

/** Hub the plugin host hangs notice transports on (server/plugins.ts host.connNotices). */
export function createConnNoticeHub() {
	const handlers = new Set<(n: ConnNotice) => unknown>();
	return {
		on(handler: (n: ConnNotice) => unknown): () => void {
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
		get size(): number {
			return handlers.size;
		},
		/** True once one transport says it sent it. No transport, or all refuse/fail: false. */
		async deliver(n: ConnNotice, permitted: () => boolean = () => true): Promise<boolean> {
			for (const h of [...handlers]) {
				// A slow/refused transport must not submit to another after notice permission changed.
				if (!permitted()) return false;
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					const r = await Promise.race([
						Promise.resolve(h({ ...n, more: n.more ? { ...n.more } : null })),
						new Promise((res) => {
							timer = setTimeout(() => res(false), DELIVER_TIMEOUT_MS);
							timer.unref?.();
						}),
					]);
					if (r === true) return true;
				} catch {
					/* the next one, or not sent */
				} finally {
					if (timer) clearTimeout(timer);
				}
			}
			return false;
		},
	};
}
export const connNoticeHub = createConnNoticeHub();

const EP_RE = /^[a-z0-9]{8,32}$/;
const CONN_RE = /^[a-f0-9]{8,32}$/;
const RECORD_KEYS = new Set([
	"ep",
	"reason",
	"closeCode",
	"quietMs",
	"allowedMs",
	"durMs",
	"endAgoMs",
	"sockAgeMs",
	"sinceFrameMs",
	"visible",
	"online",
	"endVisible",
	"patience",
	"sockets",
	"drops",
	"then",
	"catchUpMs",
	"conn",
	"pageStallMs",
	"cut",
	"view",
	"shownMs",
]);
/** pages-live (Ops #244): the views a record may name. */
const VIEWS: readonly NonNullable<ConnTraceRecord["view"]>[] = ["roles", "initiatives", "chat", "other"];

const ms = (v: unknown): number | null =>
	typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), MAX_MS) : null;
const count = (v: unknown, max: number): number | null =>
	typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : null;

/** A page's record, checked field by field: anything malformed or extra and the record is refused. */
export function sanitizeRecord(raw: unknown): ConnTraceRecord | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	for (const k of Object.keys(r)) if (!RECORD_KEYS.has(k)) return null;
	if (typeof r.ep !== "string" || !EP_RE.test(r.ep)) return null;
	if (typeof r.reason !== "string" || !REASONS.includes(r.reason as ConnTraceReason)) return null;
	const durMs = ms(r.durMs);
	const endAgoMs = ms(r.endAgoMs);
	const sockAgeMs = ms(r.sockAgeMs);
	const sinceFrameMs = ms(r.sinceFrameMs);
	const patience = count(r.patience, 64);
	const sockets = count(r.sockets, 10_000);
	const drops = count(r.drops, 10_000);
	if (durMs === null || endAgoMs === null || sockAgeMs === null || sinceFrameMs === null) return null;
	if (patience === null || sockets === null || drops === null) return null;
	if (typeof r.visible !== "boolean" || typeof r.online !== "boolean" || typeof r.endVisible !== "boolean") return null;
	const out: ConnTraceRecord = {
		ep: r.ep,
		reason: r.reason as ConnTraceReason,
		durMs,
		endAgoMs,
		sockAgeMs,
		sinceFrameMs,
		visible: r.visible,
		online: r.online,
		endVisible: r.endVisible,
		patience,
		sockets,
		drops,
	};
	if (r.closeCode !== undefined) {
		const c = count(r.closeCode, 4999);
		if (c === null || c < 1000) return null;
		out.closeCode = c;
	}
	if (r.cut !== undefined) {
		if (typeof r.cut !== "boolean") return null;
		if (r.cut) out.cut = true;
	}
	if (r.view !== undefined) {
		if (typeof r.view !== "string" || !VIEWS.includes(r.view as NonNullable<ConnTraceRecord["view"]>)) return null;
		out.view = r.view as NonNullable<ConnTraceRecord["view"]>;
	}
	for (const k of ["quietMs", "allowedMs", "catchUpMs", "pageStallMs", "shownMs"] as const) {
		if (r[k] === undefined) continue;
		const v = ms(r[k]);
		if (v === null) return null;
		out[k] = v;
	}
	if (r.then !== undefined) {
		if (typeof r.then !== "string" || !REASONS.includes(r.then as ConnTraceReason)) return null;
		out.then = r.then as ConnTraceReason;
	}
	if (r.conn !== undefined) {
		if (typeof r.conn !== "string" || !CONN_RE.test(r.conn)) return null;
		out.conn = r.conn;
	}
	return out;
}

/** Client ids are random per browser; still, only a short hash goes in the log. */
export function hashClient(clientId: string | null | undefined): string | null {
	if (!clientId) return null;
	return createHash("sha256").update(`conn-trace:${clientId}`).digest("hex").slice(0, 12);
}

const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10);
const round1 = (v: number): number => Math.round(v * 10) / 10;

interface LoopSample {
	/** End of the sample window (server clock). */
	t: number;
	windowMs: number;
	p99: number;
	max: number;
}

interface Pending {
	count: number;
	totalMs: number;
	worstLoopMs: number | null;
	since: number;
	reasons: Partial<Record<ConnTraceReason, number>>;
}

interface NotifyState {
	/** A config incarnation and its opt-in start: old/delayed episodes cannot cross a mute/re-enable.
	 * A missing legacy fence drops legacy backlog, even if the current file explicitly opts in. */
	noticePolicy: { key: string; since: number | null };
	/** When a notice last went out, or was last tried. */
	lastSentAt: number;
	sentIds: string[];
	pending: Pending | null;
	/** A notice handed to the transport and not yet answered: after a restart it is tried again with
	 *  the same id (the transport skips an id it already sent). */
	inflight: ConnNotice | null;
	/** Episode ids already taken (a page's record is placed and counted once, across restarts too). */
	eps: string[];
}

function mergePending(a: Pending, b: Pending | null): Pending {
	if (!b) return a;
	const out: Pending = {
		count: a.count + b.count,
		totalMs: a.totalMs + b.totalMs,
		worstLoopMs:
			a.worstLoopMs === null && b.worstLoopMs === null ? null : Math.max(a.worstLoopMs ?? 0, b.worstLoopMs ?? 0),
		since: Math.min(a.since, b.since),
		reasons: { ...a.reasons },
	};
	for (const [k, v] of Object.entries(b.reasons) as [ConnTraceReason, number][])
		out.reasons[k] = (out.reasons[k] ?? 0) + v;
	return out;
}

export interface ConnEventsOptions {
	dataDir: string;
	now?: () => number;
	/** Where notices go (default: the plugin hub). */
	deliver?: ConnNoticeDeliver;
	/** Start the event-loop monitor and the 10 s sampler (off in unit tests that drive sample()). */
	sampler?: boolean;
	sampleMs?: number;
	noticeGapMs?: number;
	/** Watch GC pauses passively while sampling (default true). */
	gc?: boolean;
	/** Watch for main-thread stalls with a 250 ms timer while sampling (default true). */
	stallWatch?: boolean;
	/** When this server process started (default: now). */
	startedAt?: number;
	/** Test hook: the histogram source (default perf_hooks.monitorEventLoopDelay). */
	histogram?: () => Pick<ELDHistogram, "enable" | "disable" | "reset" | "percentile" | "max" | "count">;
}

export class ConnEvents {
	private readonly dataDir: string;
	private readonly now: () => number;
	private readonly deliver: ConnNoticeDeliver;
	private readonly sampleMs: number;
	private readonly gapMs: number;
	private readonly makeHistogram: NonNullable<ConnEventsOptions["histogram"]>;
	private hist: ReturnType<NonNullable<ConnEventsOptions["histogram"]>> | null = null;
	private histSince = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private ring: LoopSample[] = [];
	private cfg = { at: -Infinity, key: "", on: true, notices: false };
	/** In-memory fence for an async send: changing permission invalidates its completion/retry. */
	private noticeEpoch = 0;
	private day = "";
	private dayBytes = 0;
	private state: NotifyState;
	/** When this server process started (an episode that began earlier spans a restart). */
	private readonly startedAt: number;
	private sending = false;
	private gcObs: PerformanceObserver | null = null;
	/** GC pauses delivered since the last sample. */
	private gcWin = { n: 0, ms: 0, max: 0 };
	/** Long GC pauses: start (epoch ms) and length. */
	private longGc: { t: number; ms: number }[] = [];
	private cpuPrev: NodeJS.CpuUsage | null = null;
	private readonly watchGc: boolean;
	private readonly watchStalls: boolean;
	private stallTimer: ReturnType<typeof setInterval> | null = null;
	/** The watcher's last tick (0: none yet). */
	private stallLast = 0;
	/** The worst stall seen since the last sample. */
	private stallWin = 0;
	/** Stalls: start (server clock) and length. */
	private stalls: { t: number; ms: number }[] = [];

	constructor(opts: ConnEventsOptions) {
		this.dataDir = opts.dataDir;
		this.now = opts.now ?? Date.now;
		this.deliver = opts.deliver ?? ((n, permitted) => connNoticeHub.deliver(n, permitted));
		this.sampleMs = opts.sampleMs ?? LOOP_SAMPLE_MS;
		this.gapMs = opts.noticeGapMs ?? NOTICE_GAP_MS;
		this.makeHistogram = opts.histogram ?? (() => monitorEventLoopDelay({ resolution: 20 }));
		this.watchGc = opts.gc ?? true;
		this.watchStalls = opts.stallWatch ?? true;
		this.startedAt = opts.startedAt ?? this.now();
		this.state = this.loadState();
		this.switches(); // establish a fence and discard muted/legacy backlog before resume or timers
		if (opts.sampler) this.startSampler();
	}

	// -- the switch -----------------------------------------------------------

	/** Capture is on unless explicitly master-off; an unreadable/invalid config fails closed. */
	enabled(): boolean {
		return this.switches().on;
	}

	/** Notices are silent by default. Recheck before every submission/enqueue/retry, not just at
	 * the capture cache boundary: revoking notice permission must not wait behind that cache. */
	noticesEnabled(): boolean {
		const cfg = this.switches(true);
		return cfg.on && cfg.notices;
	}

	private switches(force = false): typeof this.cfg {
		const t = this.now();
		if (!force && t - this.cfg.at < CONFIG_TTL_MS) return this.cfg;
		const file = join(this.dataDir, CONFIG_FILE);
		let key = "absent";
		let on = true;
		let notices = false;
		try {
			const st = statSync(file);
			if (!st.isFile()) throw new Error("invalid switch");
			// ctime catches permission changes and off/on rewrites even with a restored mtime.
			key = `${st.ino}:${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
			if (key === this.cfg.key) {
				on = this.cfg.on;
				notices = this.cfg.notices;
			} else {
				const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid switch");
				const c = raw as { enabled?: unknown; notices?: unknown };
				if (c.enabled !== undefined && typeof c.enabled !== "boolean") throw new Error("invalid switch");
				on = c.enabled !== false;
				notices = c.notices === true;
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				key = "unreadable";
				on = false;
			}
			notices = false;
		}
		this.cfg = { at: t, key, on, notices };
		const active = on && notices;
		const p = this.state.noticePolicy;
		if (p.key !== key || active !== (p.since !== null)) {
			this.noticeEpoch++;
			this.state.noticePolicy = { key, since: active ? t : null };
			this.state.pending = null;
			this.state.inflight = null;
			if (this.flushTimer) clearTimeout(this.flushTimer);
			this.flushTimer = null;
			this.saveState();
		}
		return this.cfg;
	}

	private noticeAllowed(at: number, epoch?: number): boolean {
		if (!this.noticesEnabled()) return false;
		const since = this.state.noticePolicy.since;
		return (epoch === undefined || epoch === this.noticeEpoch) && since !== null && at >= since;
	}

	// -- event-loop sampling ----------------------------------------------------

	startSampler(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.sample(), this.sampleMs);
		this.timer.unref?.();
		if (this.watchStalls) {
			this.stallLast = 0;
			this.stallTimer = setInterval(() => this.watchTick(), STALL_TICK_MS);
			this.stallTimer.unref?.();
		}
		this.sample();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		if (this.stallTimer) clearInterval(this.stallTimer);
		this.stallTimer = null;
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = null;
		this.stopMeasuring();
	}

	private stopMeasuring(): void {
		this.hist?.disable();
		this.hist = null;
		this.gcObs?.disconnect();
		this.gcObs = null;
		this.cpuPrev = null;
	}

	/** One GC pause (start on the epoch clock, length): counted in the window, kept if long. */
	noteGc(startEpochMs: number, durationMs: number): void {
		if (!Number.isFinite(durationMs) || durationMs < 0) return;
		this.gcWin.n++;
		this.gcWin.ms += durationMs;
		this.gcWin.max = Math.max(this.gcWin.max, durationMs);
		if (durationMs >= LONG_GC_MS) {
			this.longGc.push({ t: Math.round(startEpochMs), ms: round1(durationMs) });
			if (this.longGc.length > LONG_GC_KEEP) this.longGc.splice(0, this.longGc.length - LONG_GC_KEEP);
		}
	}

	private startGcWatch(): void {
		if (!this.watchGc || this.gcObs) return;
		try {
			const obs = new PerformanceObserver((list) => {
				for (const e of list.getEntries()) this.noteGc(performance.timeOrigin + e.startTime, e.duration);
			});
			obs.observe({ entryTypes: ["gc"] });
			this.gcObs = obs;
		} catch {
			this.gcObs = null;
		}
	}

	/**
	 * One stall-watcher tick: a gap well over the tick is a main-thread stall. The histogram alone
	 * misses a stall that spans a sample: after it, Node can run sample() before the histogram's own
	 * timer, and reset() then throws the stall's delta away (Ops #157, H-RECONNECT-STALL; 21:49 a
	 * stall of 20 s or more read 0.5 s). The watcher resets nothing, so it measures each stall whole
	 * (to within one tick) whichever timer runs first.
	 */
	watchTick(): void {
		const t = this.now();
		const last = this.stallLast;
		this.stallLast = t;
		if (!last || !this.enabled()) return;
		const stall = t - last - STALL_TICK_MS;
		if (stall >= STALL_MIN_MS) this.noteStall(t - stall, stall);
	}

	/** One main-thread stall (start on the server clock, length): written at once and kept. */
	noteStall(start: number, stallMs: number): void {
		if (!Number.isFinite(start) || !Number.isFinite(stallMs) || stallMs < 0) return;
		const from = Math.round(start);
		const len = Math.round(stallMs);
		this.stallWin = Math.max(this.stallWin, len);
		this.stalls.push({ t: from, ms: len });
		if (this.stalls.length > STALL_KEEP) this.stalls.splice(0, this.stalls.length - STALL_KEEP);
		this.write({ t: from + len, kind: "stall", ms: len, from });
	}

	/** Close one sample window: write it and keep it for placing episodes. */
	sample(): void {
		const t = this.now();
		if (!this.enabled()) {
			this.stopMeasuring();
			return;
		}
		if (!this.hist) {
			this.hist = this.makeHistogram();
			this.hist.enable();
			this.histSince = t;
			this.startGcWatch();
			this.gcWin = { n: 0, ms: 0, max: 0 };
			this.stallWin = 0;
			this.cpuPrev = process.cpuUsage();
			return;
		}
		const h = this.hist;
		const s: LoopSample = {
			t,
			windowMs: t - this.histSince,
			p99: h.count ? round1(h.percentile(99) / 1e6) : 0,
			max: h.count ? round1(h.max / 1e6) : 0,
		};
		h.reset();
		this.histSince = t;
		let cpuMs: number | null = null;
		try {
			const d = process.cpuUsage(this.cpuPrev ?? undefined);
			cpuMs = Math.round((d.user + d.system) / 1000);
			this.cpuPrev = process.cpuUsage();
		} catch {
			cpuMs = null;
		}
		const gc = this.gcWin;
		this.gcWin = { n: 0, ms: 0, max: 0 };
		const stallMaxMs = this.stallWin;
		this.stallWin = 0;
		this.ring.push(s);
		if (this.ring.length > RING_SAMPLES) this.ring.splice(0, this.ring.length - RING_SAMPLES);
		let heapMb = 0;
		let rssMb = 0;
		try {
			heapMb = Math.round(getHeapStatistics().used_heap_size / 1048576);
			rssMb = Math.round(process.memoryUsage.rss() / 1048576);
		} catch {
			/* not measured */
		}
		this.write({
			t,
			kind: "loop",
			windowMs: s.windowMs,
			p99Ms: s.p99,
			maxMs: s.max,
			stallMaxMs,
			cpuMs,
			gcN: gc.n,
			gcMs: round1(gc.ms),
			gcMaxMs: round1(gc.max),
			load1: round1(loadavg()[0] ?? 0),
			heapMb,
			rssMb,
		});
	}

	/** Worst loop delay measured over [from, to] (server clock), including the open window: the worst of
	 *  the histogram's samples and the watcher's stalls that overlap it (stallMaxMs: the stalls alone). */
	worstLoop(
		from: number,
		to: number,
	): { maxMs: number | null; p99Ms: number | null; samples: number; stallMaxMs: number | null } {
		let max: number | null = null;
		let p99: number | null = null;
		let n = 0;
		for (const s of this.ring) {
			if (s.t < from || s.t - s.windowMs > to) continue;
			n++;
			max = Math.max(max ?? 0, s.max);
			p99 = Math.max(p99 ?? 0, s.p99);
		}
		const h = this.hist;
		if (h && h.count && this.histSince <= to) {
			n++;
			max = Math.max(max ?? 0, round1(h.max / 1e6));
			p99 = Math.max(p99 ?? 0, round1(h.percentile(99) / 1e6));
		}
		let stallMax: number | null = null;
		for (const s of this.stalls) {
			if (s.t > to || s.t + s.ms < from) continue;
			stallMax = Math.max(stallMax ?? 0, s.ms);
		}
		if (stallMax !== null) max = Math.max(max ?? 0, stallMax);
		return { maxMs: max, p99Ms: p99, samples: n, stallMaxMs: stallMax };
	}

	/** Long GC pauses that overlap [from, to]: how many, their sum and the longest. */
	longGcIn(from: number, to: number): { n: number; ms: number; maxMs: number } {
		let n = 0;
		let total = 0;
		let max = 0;
		for (const g of this.longGc) {
			if (g.t > to || g.t + g.ms < from) continue;
			n++;
			total += g.ms;
			max = Math.max(max, g.ms);
		}
		return { n, ms: round1(total), maxMs: max };
	}

	// -- sockets ----------------------------------------------------------------

	/** A new socket's id (sent to the page in ready.connTrace). */
	newConnId(): string {
		return randomBytes(6).toString("hex");
	}

	opened(conn: string, clientId: string | null, browser: boolean, ageMs: number): void {
		if (!this.enabled()) return;
		this.write({ t: this.now(), kind: "open", conn, client: hashClient(clientId), browser, helloMs: ms(ageMs) });
	}

	closed(conn: string, clientId: string | null, browser: boolean, code: unknown, livedMs: number): void {
		if (!this.enabled()) return;
		const c = typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 4999 ? code : null;
		this.write({
			t: this.now(),
			kind: "close",
			conn,
			client: hashClient(clientId),
			browser,
			code: c,
			livedMs: ms(livedMs),
		});
	}

	// -- episodes from pages ------------------------------------------------------

	/** A page's records (ClientMessage conn_trace). Returns how many were taken. */
	banner(records: unknown, from: { conn: string; clientId: string | null }): number {
		if (!this.enabled() || !Array.isArray(records)) return 0;
		// A stall that just ended may not have had its watcher tick yet: take it now.
		if (this.stallTimer) this.watchTick();
		let taken = 0;
		for (const raw of records.slice(0, MAX_RECORDS_PER_MESSAGE)) {
			const r = sanitizeRecord(raw);
			if (!r || this.state.eps.includes(r.ep)) continue;
			this.state.eps = [...this.state.eps, r.ep].slice(-500);
			taken++;
			const t = this.now();
			const end = t - r.endAgoMs;
			const start = end - r.durMs;
			// The stall that held frames back started before the note came up (sinceFrameMs earlier).
			const winFrom = start - r.sinceFrameMs - 1_000;
			const loop = this.worstLoop(winFrom, end + 1_000);
			const gc = this.longGcIn(winFrom, end + 1_000);
			const restart = start < this.startedAt;
			this.write({
				t,
				kind: "banner",
				via: from.conn,
				client: hashClient(from.clientId),
				...r,
				srvStart: start,
				srvEnd: end,
				srvRestart: restart,
				loopMaxMs: loop.maxMs,
				loopP99Ms: loop.p99Ms,
				loopSamples: loop.samples,
				stallMaxMs: loop.stallMaxMs,
				longGcN: gc.n,
				longGcMs: gc.ms,
				longGcMaxMs: gc.maxMs,
			});
			this.noteEpisode({
				at: start,
				durMs: r.durMs,
				reason: r.reason,
				closeCode: r.closeCode ?? null,
				maxLoopMs: loop.maxMs,
				hidden: !r.visible && !r.endVisible,
				restart,
			});
		}
		if (taken) this.saveState();
		return taken;
	}

	// -- owner notices --------------------------------------------------------------

	private noteEpisode(e: Omit<ConnNotice, "id" | "kind" | "more">): void {
		if (!this.noticeAllowed(e.at)) return;
		const t = this.now();
		if (!this.sending && t - this.state.lastSentAt >= this.gapMs) {
			// The held-back sum travels with it (and comes back if it doesn't go).
			const more = this.state.pending;
			this.state.pending = null;
			void this.send({ id: this.noticeId(), kind: "event", ...e, more: more ? this.moreOf(more) : null }, more);
			return;
		}
		this.hold(e);
		this.scheduleFlush();
	}

	private hold(e: Pick<ConnNotice, "at" | "durMs" | "reason" | "maxLoopMs">): void {
		if (!this.noticeAllowed(e.at)) return;
		const p = this.state.pending ?? { count: 0, totalMs: 0, worstLoopMs: null, since: e.at, reasons: {} };
		p.count++;
		p.totalMs = Math.min(p.totalMs + e.durMs, MAX_MS * 7);
		if (e.maxLoopMs !== null) p.worstLoopMs = Math.max(p.worstLoopMs ?? 0, e.maxLoopMs);
		p.since = Math.min(p.since, e.at);
		p.reasons[e.reason] = (p.reasons[e.reason] ?? 0) + 1;
		this.state.pending = p;
		this.saveState();
	}

	private moreOf(p: Pending): NonNullable<ConnNotice["more"]> {
		return { count: p.count, totalMs: p.totalMs, worstLoopMs: p.worstLoopMs, since: p.since };
	}

	private scheduleFlush(): void {
		if (!this.noticesEnabled() || this.flushTimer || !this.state.pending) return;
		const wait = Math.max(1_000, this.state.lastSentAt + this.gapMs - this.now());
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			void this.flush();
		}, wait);
		this.flushTimer.unref?.();
	}

	/** Held-back episodes, once the gap is over: one summary line. */
	async flush(): Promise<void> {
		if (!this.noticesEnabled() || this.sending) return;
		const p = this.state.pending;
		if (!p) return;
		if (!this.noticeAllowed(p.since)) {
			this.state.pending = null;
			this.saveState();
			return;
		}
		if (this.now() - this.state.lastSentAt < this.gapMs) {
			this.scheduleFlush();
			return;
		}
		const top = (Object.entries(p.reasons) as [ConnTraceReason, number][]).sort((a, b) => b[1] - a[1])[0];
		this.state.pending = null;
		await this.send(
			{
				id: this.noticeId(),
				kind: "summary",
				at: p.since,
				durMs: p.totalMs,
				reason: top?.[0] ?? "unknown",
				closeCode: null,
				maxLoopMs: p.worstLoopMs,
				hidden: false,
				more: this.moreOf(p),
				restart: false,
			},
			p,
		);
	}

	/** Hand one notice to the transport. `carried`: the held-back sum it carries, put back if it doesn't go. */
	private async send(n: ConnNotice, carried: Pending | null): Promise<void> {
		if (!this.noticeAllowed(n.at) || (n.more && !this.noticeAllowed(n.more.since))) {
			this.saveState();
			return;
		}
		const epoch = this.noticeEpoch;
		const permitted = () => this.noticeAllowed(n.at, epoch);
		this.sending = true;
		this.state.inflight = n;
		this.saveState();
		let sent = false;
		try {
			sent = await this.deliver(n, permitted);
		} catch {
			sent = false;
		}
		const current = permitted(); // may clear old backlog; a late completion cannot put it back
		this.sending = false;
		if (this.state.inflight?.id === n.id) this.state.inflight = null;
		const t = this.now();
		if (sent) {
			this.state.lastSentAt = t;
			this.state.sentIds = [...this.state.sentIds, n.id].slice(-100);
		} else if (current) {
			// Not told: fold it (and what it carried) back into the sum. lastSentAt is the last try, so
			// the next one waits a full gap and a missing or broken transport isn't hammered.
			if (carried) this.state.pending = mergePending(carried, this.state.pending);
			if (n.kind === "event") this.hold(n);
			this.state.lastSentAt = t;
		}
		this.saveState();
		this.write({
			t,
			kind: "notice",
			id: n.id,
			notice: n.kind,
			sent,
			muted: !current,
			held: n.more?.count ?? 0,
		});
		this.scheduleFlush();
	}

	/** A notice's held-back sum, as pending (a notice resent after a restart carries it). */
	private pendingOf(n: ConnNotice): Pending {
		const m = n.more ?? { count: 0, totalMs: 0, worstLoopMs: null, since: n.at };
		return {
			count: m.count,
			totalMs: m.totalMs,
			worstLoopMs: m.worstLoopMs,
			since: m.since,
			reasons: { [n.reason]: m.count },
		};
	}

	private noticeId(): string {
		return `cn-${randomBytes(8).toString("hex")}`;
	}

	private loadState(): NotifyState {
		try {
			const s = JSON.parse(readFileSync(join(this.dataDir, STATE_FILE), "utf8")) as Partial<NotifyState>;
			const inflight =
				s.inflight && typeof s.inflight === "object" && typeof s.inflight.id === "string" ? s.inflight : null;
			const p = s.noticePolicy;
			return {
				noticePolicy:
					p && typeof p.key === "string" && (p.since === null || (Number.isFinite(p.since) && p.since >= 0))
						? p
						: { key: "", since: null },
				lastSentAt: typeof s.lastSentAt === "number" && Number.isFinite(s.lastSentAt) ? s.lastSentAt : 0,
				sentIds: Array.isArray(s.sentIds) ? s.sentIds.filter((x) => typeof x === "string").slice(-100) : [],
				pending: s.pending && typeof s.pending === "object" ? s.pending : null,
				inflight,
				eps: Array.isArray(s.eps) ? s.eps.filter((x) => typeof x === "string").slice(-500) : [],
			};
		} catch {
			return {
				noticePolicy: { key: "", since: null },
				lastSentAt: 0,
				sentIds: [],
				pending: null,
				inflight: null,
				eps: [],
			};
		}
	}

	private saveState(): void {
		try {
			writeFileSync(join(this.dataDir, STATE_FILE), JSON.stringify(this.state));
		} catch {
			/* best effort */
		}
	}

	/** After a restart: a notice cut off mid-send is tried again with its own id (the transport skips
	 *  it if it went), and held-back episodes still get their summary. */
	resume(): void {
		if (!this.noticesEnabled()) return;
		const n = this.state.inflight;
		if (n && !this.sending) {
			this.state.inflight = null;
			if (!this.noticeAllowed(n.at) || (n.more && !this.noticeAllowed(n.more.since))) {
				this.saveState();
				return;
			}
			void this.send(n, n.more ? this.pendingOf(n) : null);
			return;
		}
		if (this.state.pending) this.scheduleFlush();
	}

	// -- the log file -------------------------------------------------------------

	private write(rec: Record<string, unknown>): void {
		const t = typeof rec.t === "number" ? rec.t : this.now();
		const file = join(this.dataDir, LOG_FILE);
		try {
			this.rollOver(t, file);
			const line = `${JSON.stringify(rec)}\n`;
			const essential = rec.kind === "banner" || rec.kind === "notice";
			if (!essential && this.dayBytes + line.length > DAY_CAP_BYTES) return;
			appendFileSync(file, line);
			this.dayBytes += line.length;
		} catch (err) {
			console.warn(`[conn-trace] cannot write ${LOG_FILE}: ${(err as Error).message}`);
		}
	}

	private rollOver(t: number, file: string): void {
		const today = utcDay(t);
		if (this.day === today) return;
		let size = 0;
		let fileDay = "";
		try {
			const st = statSync(file);
			size = st.size;
			fileDay = utcDay(st.mtimeMs);
		} catch {
			mkdirSync(this.dataDir, { recursive: true });
		}
		if (fileDay && fileDay !== today) {
			try {
				renameSync(file, join(this.dataDir, `conn-events-${fileDay}.jsonl`));
			} catch {
				/* next time */
			}
			size = 0;
		}
		this.day = today;
		this.dayBytes = size;
		const oldest = utcDay(t - KEEP_DAYS * 86_400_000);
		try {
			for (const f of readdirSync(this.dataDir)) {
				const m = /^conn-events-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
				if (m && m[1] < oldest) unlinkSync(join(this.dataDir, f));
			}
		} catch {
			/* best effort */
		}
	}
}
