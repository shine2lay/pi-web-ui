/**
 * chat-open-timing (Ops #690): how long each real chat open takes, as one "chatopen" row in the
 * connection log (server/conn-events.ts: same file, daily rollover, kept 7 days).
 *
 * One tracker per socket. It sees the switch request arrive, the frames that answer it (the server's
 * preview, the chat's snapshot, switch_done / switch_failed), and the page's own report (ClientMessage
 * chat_open: from the click to the newest messages painted). It joins them into one row:
 *   server: request arrival, whether the chat was already loaded, load ms (request -> the chat's snapshot
 *           starts being built), build and serialize ms, ms to the preview, ms to the end, characters and
 *           frames sent meanwhile, how many messages the chat has and how many went out;
 *   page:   input -> request, -> first frame of the chat, -> painted, -> cached copy painted, -> done,
 *           device class, visible, cached, automated, how it ended.
 * Never in a row: message text, titles, paths, session ids (only a 12-hex hash of the session id).
 *
 * Every switch request gets a row, even when the page never reports (outcome "noreport"): a row is
 * written when the server has finished and the page's report is in, or PAGE_REPORT_WAIT_MS after the
 * one that came first, or SERVER_WAIT_MS after the request, or when the socket closes.
 *
 * Cost: while no open is in progress the per-frame hook is one boolean read. While one is, a frame costs
 * two clock reads and a few comparisons; the chat's snapshot also its message count. Frame size is the
 * serialized string's length in characters (counting bytes would mean a second pass over megabytes).
 */
import { performance } from "node:perf_hooks";
import { boundedMs, shortHash } from "./conn-events.js";
import type { ChatOpenReport, ClientMessage, ServerMessage, SwitchTarget, UiState } from "./protocol.js";

/** The page's open id: the same shape as the log's socket ids. */
export const OPEN_ID_RE = /^[a-f0-9]{8,32}$/;
/** After one side is in, how long to wait for the other before writing what there is. */
export const PAGE_REPORT_WAIT_MS = 120_000;
/** A request the server never answers is written this long after it arrived. */
export const SERVER_WAIT_MS = 600_000;
/** Opens kept in progress per socket; one more writes the oldest out as it stands (never refuses one). */
export const MAX_OPENS_IN_PROGRESS = 16;

const OUTCOMES: readonly ChatOpenReport["outcome"][] = ["done", "failed", "left", "hidden"];
const VIAS: readonly ChatOpenReport["via"][] = ["click", "key", "nav", "auto"];
const DEVICES: readonly ChatOpenReport["device"][] = ["phone", "desktop"];
const REPORT_MS_KEYS = ["startToRequestMs", "toFirstFrameMs", "toPaintMs", "toCachePaintMs", "toDoneMs"] as const;
const REPORT_KEYS = new Set<string>([
	"type",
	"open",
	"outcome",
	"via",
	"device",
	"visible",
	"cached",
	"automated",
	...REPORT_MS_KEYS,
]);

/** Epoch ms with sub-ms precision (Date.now() rounds every short span to 0 or 1). */
export const preciseNow = (): number => performance.timeOrigin + performance.now();

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** A page's report, checked field by field: anything malformed or extra and it is refused. */
export function sanitizeOpenReport(raw: unknown): ChatOpenReport | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	for (const k of Object.keys(r)) if (!REPORT_KEYS.has(k)) return null;
	if (r.type !== "chat_open" || typeof r.open !== "string" || !OPEN_ID_RE.test(r.open)) return null;
	if (!OUTCOMES.includes(r.outcome as ChatOpenReport["outcome"])) return null;
	if (!VIAS.includes(r.via as ChatOpenReport["via"])) return null;
	if (!DEVICES.includes(r.device as ChatOpenReport["device"])) return null;
	if (typeof r.visible !== "boolean" || typeof r.cached !== "boolean" || typeof r.automated !== "boolean") return null;
	const out: ChatOpenReport = {
		type: "chat_open",
		open: r.open,
		outcome: r.outcome as ChatOpenReport["outcome"],
		via: r.via as ChatOpenReport["via"],
		device: r.device as ChatOpenReport["device"],
		visible: r.visible,
		cached: r.cached,
		automated: r.automated,
	};
	for (const k of REPORT_MS_KEYS) {
		if (r[k] === undefined) continue;
		const v = boundedMs(r[k]);
		if (v === null) return null;
		out[k] = v;
	}
	return out;
}

/** The chat in a row: a hash of its session id, never the id, title or path. */
export function chatKey(sessionId: string | null | undefined): string | null {
	return shortHash("chat-open", sessionId);
}

// -- the snapshot build mark (agent-service flushSnapshot) ------------------------

let flushStartedAt: number | null = null;
let flushClearQueued = false;

/** agent-service flushSnapshot calls this first: the snapshot it builds goes out synchronously, and the
 *  frame hook below takes the mark. A flush that sends nothing leaves no mark past its own turn. */
export function noteSnapshotFlush(now: number = preciseNow()): void {
	flushStartedAt = now;
	if (flushClearQueued) return;
	flushClearQueued = true;
	queueMicrotask(() => {
		flushStartedAt = null;
		flushClearQueued = false;
	});
}

function takeSnapshotFlush(): number | null {
	const v = flushStartedAt;
	flushStartedAt = null;
	return v;
}

// -- matching frames to the request ------------------------------------------------

const slashes = (p: string): string => p.replace(/\\/g, "/");
const stripDurable = (p: string): string => (p.startsWith("durable://") ? p.slice("durable://".length) : p);

function sameTarget(a: SwitchTarget, b: SwitchTarget): boolean {
	if (a.kind === "conversation" || b.kind === "conversation")
		return a.kind === b.kind && (a as { id: string }).id === (b as { id: string }).id;
	return slashes(a.path) === slashes(b.path);
}

/** Does this snapshot show the chat the request asked for? */
function showsTarget(target: SwitchTarget, state: UiState): boolean {
	if (target.kind === "conversation") return state.conversationId === target.id;
	const want = stripDurable(slashes(target.path));
	if (state.sessionFile && stripDurable(slashes(state.sessionFile)) === want) return true;
	return !!state.sessionId && state.sessionId === want;
}

// -- the tracker -------------------------------------------------------------------

/** Where rows go (ConnEvents): it adds the time, the loop delay and the load. */
export interface ChatOpenSink {
	enabled(): boolean;
	chatOpened(row: ChatOpenRow): void;
}

/** One row as the tracker builds it (ConnEvents adds t, kind, loop and load). */
export interface ChatOpenRow extends Record<string, unknown> {
	at: number;
	conn: string;
	client: string | null;
	browser: boolean;
	open: string | null;
	target: SwitchTarget["kind"];
	chat: string | null;
	loadedBefore: boolean | null;
	ok: boolean | null;
	outcome: ChatOpenReport["outcome"] | "noreport";
	msgs: number | null;
	sentMsgs: number | null;
	reuse: boolean | null;
	snapshotChars: number | null;
	chars: number;
	frames: number;
	serverMs: number | null;
	loadMs: number | null;
	buildMs: number | null;
	serializeMs: number | null;
	previewMs: number | null;
}

interface OpenInProgress {
	key: string;
	open: string | null;
	target: SwitchTarget;
	at: number;
	loadedBefore: boolean | null;
	chars: number;
	frames: number;
	snap: {
		at: number;
		flushAt: number | null;
		serializeAt: number;
		sessionId: string | null;
		msgs: number;
		sentMsgs: number;
		reuse: boolean;
		chars: number;
	} | null;
	previewAt: number | null;
	endAt: number | null;
	ok: boolean | null;
	report: ChatOpenReport | null;
	timer: ReturnType<typeof setTimeout> | null;
}

export interface ChatOpenTrackerOptions {
	sink: ChatOpenSink;
	conn: string;
	clientId: () => string | null;
	browser: boolean;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
}

export class ChatOpenTracker {
	private readonly opts: ChatOpenTrackerOptions;
	private readonly now: () => number;
	private readonly opens = new Map<string, OpenInProgress>();
	private seq = 0;
	/** An open is in progress: the frame hook has work to do. */
	busy = false;

	constructor(opts: ChatOpenTrackerOptions) {
		this.opts = opts;
		this.now = opts.now ?? preciseNow;
	}

	/** Every message from the page, before it is dispatched (or queued until attach). */
	requested(msg: ClientMessage, loadedBefore: (path: string) => boolean | null): void {
		if (msg.type !== "switch_session" && msg.type !== "switch_conversation") return;
		const at = this.now();
		if (!this.opts.sink.enabled()) return;
		const target: SwitchTarget =
			msg.type === "switch_session" ? { kind: "session", path: msg.path } : { kind: "conversation", id: msg.id };
		if (target.kind === "session" && typeof target.path !== "string") return;
		const open = typeof msg.open === "string" && OPEN_ID_RE.test(msg.open) ? msg.open : null;
		if (open && this.opens.has(open)) return;
		const key = open ?? `#${++this.seq}`;
		if (this.opens.size >= MAX_OPENS_IN_PROGRESS) {
			const oldest = this.opens.values().next().value;
			if (oldest) this.write(oldest);
		}
		let loaded: boolean | null = true;
		if (target.kind === "session") {
			try {
				loaded = loadedBefore(target.path);
			} catch {
				loaded = null;
			}
		}
		const o: OpenInProgress = {
			key,
			open,
			target,
			at,
			loadedBefore: loaded,
			chars: 0,
			frames: 0,
			snap: null,
			previewAt: null,
			endAt: null,
			ok: null,
			report: null,
			timer: null,
		};
		this.opens.set(key, o);
		this.busy = true;
		this.wait(o, SERVER_WAIT_MS);
	}

	/** Every frame that really goes out (sendRaw), with its size and when its serializing started. */
	sent(msg: ServerMessage, chars: number, serializeStartedAt: number): void {
		const flushAt = msg.type === "snapshot" ? takeSnapshotFlush() : null;
		if (!this.busy) return;
		const t = this.now();
		for (const o of this.opens.values()) {
			if (o.endAt !== null) continue;
			o.chars += chars;
			o.frames++;
			if (msg.type === "snapshot") {
				if (!showsTarget(o.target, msg.state)) continue;
				const sentMsgs = msg.state.messages.length;
				const start = msg.state.messagesStart ?? 0;
				const msgs = msg.reuse ? msg.reuse.start + msg.reuse.count + sentMsgs : start + sentMsgs;
				const first = o.snap;
				o.snap = {
					at: first?.at ?? t,
					flushAt: first ? first.flushAt : flushAt !== null && flushAt >= o.at ? flushAt : null,
					serializeAt: first?.serializeAt ?? serializeStartedAt,
					sessionId: msg.state.sessionId ?? null,
					msgs,
					sentMsgs: (first?.sentMsgs ?? 0) + sentMsgs,
					reuse: first?.reuse ?? !!msg.reuse,
					chars: first?.chars ?? chars,
				};
			} else if (msg.type === "switch_preview") {
				if (o.previewAt === null && sameTarget(o.target, msg.target)) o.previewAt = t;
			} else if (msg.type === "switch_done" || msg.type === "switch_failed") {
				if (!sameTarget(o.target, msg.target)) continue;
				o.endAt = t;
				o.ok = msg.type === "switch_done";
				if (o.report || !o.open) this.write(o);
				else this.wait(o, PAGE_REPORT_WAIT_MS);
			}
		}
	}

	/** The page's report (ClientMessage chat_open). Malformed, unknown or repeated reports are ignored. */
	pageReport(raw: unknown): void {
		const r = sanitizeOpenReport(raw);
		if (!r) return;
		const o = this.opens.get(r.open);
		if (!o || o.report) return;
		o.report = r;
		if (o.endAt !== null) this.write(o);
		else this.wait(o, PAGE_REPORT_WAIT_MS);
	}

	/** The socket closed: write every open as it stands. */
	closed(): void {
		// write() deletes the entry; deleting the current entry while iterating a Map is safe.
		for (const o of this.opens.values()) this.write(o);
	}

	private wait(o: OpenInProgress, ms: number): void {
		const set = this.opts.setTimer ?? ((fn, d) => setTimeout(fn, d));
		const clear = this.opts.clearTimer ?? clearTimeout;
		if (o.timer) clear(o.timer);
		o.timer = set(() => {
			o.timer = null;
			this.write(o);
		}, ms);
		(o.timer as { unref?: () => void }).unref?.();
	}

	private write(o: OpenInProgress): void {
		if (!this.opens.delete(o.key)) return;
		if (o.timer) (this.opts.clearTimer ?? clearTimeout)(o.timer);
		o.timer = null;
		this.busy = this.opens.size > 0;
		// A failed open's snapshots show the chat it stayed on, not this one.
		const snap = o.ok === false ? null : o.snap;
		const r = o.report;
		const span = (from: number | null | undefined, to: number | null | undefined): number | null =>
			typeof from === "number" && typeof to === "number" ? round1(Math.max(0, to - from)) : null;
		const row: ChatOpenRow = {
			at: Math.round(o.at),
			conn: this.opts.conn,
			client: shortHash("conn-trace", this.opts.clientId()),
			browser: this.opts.browser,
			open: o.open,
			target: o.target.kind,
			chat: chatKey(snap?.sessionId),
			loadedBefore: o.loadedBefore,
			ok: o.ok,
			outcome: r?.outcome ?? "noreport",
			msgs: snap?.msgs ?? null,
			sentMsgs: snap?.sentMsgs ?? null,
			reuse: snap ? snap.reuse : null,
			snapshotChars: snap?.chars ?? null,
			chars: o.chars,
			frames: o.frames,
			serverMs: span(o.at, o.endAt),
			loadMs: span(o.at, snap ? (snap.flushAt ?? snap.serializeAt) : null),
			buildMs: span(snap?.flushAt, snap?.serializeAt),
			serializeMs: span(snap?.serializeAt, snap?.at),
			previewMs: span(o.at, o.previewAt),
		};
		if (r) {
			row.via = r.via;
			row.device = r.device;
			row.visible = r.visible;
			row.cached = r.cached;
			row.automated = r.automated;
			for (const k of REPORT_MS_KEYS) row[k] = r[k] ?? null;
		}
		try {
			this.opts.sink.chatOpened(row);
		} catch (err) {
			console.warn(`[chat-open-timing] cannot record an open: ${(err as Error).message}`);
		}
	}
}
