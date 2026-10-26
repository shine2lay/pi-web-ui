/**
 * message-window.ts — per-connection history window (server-message-window).
 *
 * Port of upstream pi-web-ui 0.111.0 `dist/server/message-window.js` (Ops #565, W1-B of the
 * pi-durable cutover). Built here, wired later: Wave 2 (Ops #570) puts a tap in front of each
 * socket's send in index.ts and routes `load_earlier_messages` to it. Nothing imports it yet.
 *
 * What it does: a full `snapshot` keeps only the newest `windowSize` messages (300), and fewer
 * when they add up to more than `charBudget` characters (1.5 million; one screenshot tool result
 * can weigh more than a hundred plain messages, so counting messages alone isn't enough). The
 * tap keeps the conversation's whole list (references the engine already built, so only pointer
 * cost) for the last few conversations (4, LRU) and serves older pages on request.
 *
 * Indices are absolute. This fork's engine already sends a window of its own
 * (chat-window-pagination: `state.messagesStart` = where `messages[0]` sits in the whole chat), so
 * the tap treats `messagesStart` as the base of what it got and reports every index in whole-chat
 * terms: `messagesStart`/`historyStart`/`historyWindow.earliestIndex` = first message the client
 * holds, `historyTotal` = whole chat length. A page the tap can't serve (older than the engine's
 * window) returns false, so the caller can fall back to the engine's `load_older`.
 *
 * A switch-cache snapshot (`reuse`: `messages` is only a tail the client splices onto its cache)
 * passes through untouched and drops the tap's copy of that conversation, so the deltas after it
 * pass through untouched too; the next full snapshot starts a fresh window.
 *
 * One change from upstream: a later full snapshot of the same conversation keeps the character
 * budget too (upstream re-grew a budget-cut window to the full 300 messages there, resending the
 * very screenshots the budget had cut). The start still never moves forward.
 */

/** Newest messages a full snapshot keeps (upstream DEFAULT_HISTORY_WINDOW). */
export const DEFAULT_HISTORY_WINDOW = 300;
/** Character budget of a full snapshot's window (≈ 3 MB of JSON). Counted from the newest message
 *  back by adding each text field's `.length` only (O(blocks), nothing is expanded). */
export const DEFAULT_HISTORY_CHARS = 1_500_000;
/** Messages per "load earlier" page. */
export const DEFAULT_HISTORY_PAGE = 30;
/** Most messages one page request may pull (a bad count can't drag thousands down at once). */
export const MAX_HISTORY_PAGE = 2000;
/** Conversations whose whole list the tap keeps (LRU). */
export const MAX_CACHED_CONVERSATIONS = 4;

export interface MessageWindowConfig {
	/** Newest messages kept; 0 = windowing off (everything passes through untouched). */
	windowSize: number;
	/** Character budget of the first window; 0 = count only. */
	charBudget: number;
	/** Default page size of a "load earlier" request. */
	pageSize: number;
}

export const OFF_CONFIG: Readonly<MessageWindowConfig> = Object.freeze({
	windowSize: 0,
	charBudget: 0,
	pageSize: DEFAULT_HISTORY_PAGE,
});

export const DEFAULT_CONFIG: Readonly<MessageWindowConfig> = Object.freeze({
	windowSize: DEFAULT_HISTORY_WINDOW,
	charBudget: DEFAULT_HISTORY_CHARS,
	pageSize: DEFAULT_HISTORY_PAGE,
});

/** Window settings from the environment: `PI_WEB_HISTORY_WINDOW` = message count; 0/off/false/no = off;
 *  empty or not a positive number = the defaults. */
export function readMessageWindowConfig(env: Record<string, string | undefined> = process.env): MessageWindowConfig {
	const raw = (env.PI_WEB_HISTORY_WINDOW ?? "").trim().toLowerCase();
	if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return { ...OFF_CONFIG };
	if (raw === "") return { ...DEFAULT_CONFIG };
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return { ...DEFAULT_CONFIG };
	return { ...DEFAULT_CONFIG, windowSize: Math.floor(n) };
}

/**
 * Count-only window start for a later full snapshot (pure; upstream's rule, kept for callers that
 * don't budget characters). `prevStart` is the start sent last time (-1 for a new conversation). The
 * start never moves forward: the client may have paged back already, and a full snapshot that pushed
 * the start forward would take away history it has shown. When the list got shorter (a compaction
 * rewrite) the tail window wins.
 */
export function computeWindowStart(prevStart: number, total: number, windowSize: number): number {
	if (windowSize <= 0) return 0;
	const tail = Math.max(0, total - windowSize);
	if (prevStart < 0) return tail;
	return Math.min(prevStart, tail);
}

const CHAR_FIELDS = ["text", "thinking", "argumentsText", "output", "command", "dataUrl", "summary"] as const;

/** A message's size estimate: the `.length` of each text field of its content blocks, plus its summary.
 *  dataUrl counts: whole-page screenshots are the heavy part of a long chat (3.4 MB of one 4 MB transcript). */
export function estimateMessageChars(m: unknown): number {
	if (!m || typeof m !== "object") return 0;
	let n = 0;
	const content = (m as { content?: unknown }).content;
	if (Array.isArray(content)) {
		for (const b of content) {
			if (!b || typeof b !== "object") continue;
			for (const k of CHAR_FIELDS) {
				const v = (b as Record<string, unknown>)[k];
				if (typeof v === "string") n += v.length;
			}
		}
	}
	const summary = (m as { summary?: unknown }).summary;
	if (typeof summary === "string") n += summary.length;
	return n;
}

/**
 * First window start: the stricter of the count limit and the character budget, always keeping at
 * least the newest message. 0 when windowing is off.
 */
export function pickWindowStart(messages: readonly unknown[], cfg: MessageWindowConfig): number {
	const total = messages.length;
	if (cfg.windowSize <= 0) return 0;
	const byCount = Math.max(0, total - cfg.windowSize);
	if (cfg.charBudget <= 0) return byCount;
	let chars = 0;
	for (let i = total - 1; i >= byCount; i--) {
		chars += estimateMessageChars(messages[i]);
		if (chars > cfg.charBudget) return Math.min(total - 1, i + 1);
	}
	return byCount;
}

/** What the client holds of the whole chat: whether older messages exist, how many, and where its
 *  first message sits (all whole-chat indices). */
export interface HistoryWindow {
	hasEarlier: boolean;
	hiddenCount: number;
	earliestIndex: number;
}

export function historyWindowAt(earliestIndex: number): HistoryWindow {
	const i = Math.max(0, Math.floor(earliestIndex));
	return { hasEarlier: i > 0, hiddenCount: i, earliestIndex: i };
}

/**
 * The page just before `beforeIndex` (pure): [max(0, beforeIndex - limit), beforeIndex) of `full`,
 * exactly, with `start` its first index. limit is clamped to 1..MAX_HISTORY_PAGE (Infinity = everything
 * before beforeIndex, upstream's `all`); beforeIndex to 0..full.length.
 */
export function readEarlierSlice<T>(
	full: readonly T[],
	beforeIndex: number,
	limit: number = DEFAULT_HISTORY_PAGE,
): { start: number; messages: T[] } {
	const before = Math.min(full.length, Math.max(0, Math.floor(Number.isFinite(beforeIndex) ? beforeIndex : 0)));
	const start = limit === Infinity ? 0 : Math.max(0, before - clampPage(limit));
	return { start, messages: full.slice(start, before) };
}

function clampPage(n: unknown): number {
	const v = Math.floor(Number(n));
	if (!Number.isFinite(v) || v < 1) return 1;
	return Math.min(MAX_HISTORY_PAGE, v);
}

/** The reply a page request gets (upstream's earlier_messages, plus historyWindow). */
export interface EarlierMessagesReply<M = unknown> {
	type: "earlier_messages";
	conversationId: string;
	messages: M[];
	historyStart: number;
	historyTotal: number;
	historyWindow: HistoryWindow;
}

interface WindowEntry {
	/** The messages the tap got for this conversation, the engine's window (from `base`) and every delta after it. */
	full: unknown[];
	/** Whole-chat index of full[0] (the engine's own window start; 0 when it sent everything). */
	base: number;
	/** Whole-chat index of the first message the client holds; -1 before the first snapshot. */
	start: number;
}

type AnyMessage = { type: string; [k: string]: unknown };

/**
 * One per socket (one per browser tab): `accept()` sits in front of send, `loadEarlier()` /
 * `loadEarlierBefore()` are called by the socket's request dispatch.
 */
export class MessageWindowTap<M extends { type: string } = AnyMessage> {
	private readonly convs = new Map<string, WindowEntry>();
	/** Conversation of the latest snapshot: a page request without an id is served for it (old clients). */
	private lastConversationId = "";

	constructor(
		private readonly send: (msg: M) => void,
		private readonly cfg: MessageWindowConfig = DEFAULT_CONFIG,
	) {}

	get enabled(): boolean {
		return this.cfg.windowSize > 0;
	}

	/** Conversations whose list the tap keeps (tests, diagnostics). */
	get cachedConversations(): string[] {
		return [...this.convs.keys()];
	}

	/** Engine message in: windows full snapshots, annotates deltas, passes everything else through. */
	accept(msg: M): void {
		if (!this.enabled) {
			this.send(msg);
			return;
		}
		const m = msg as unknown as AnyMessage;
		if (m.type === "snapshot") return this.acceptSnapshot(msg, m);
		if (m.type === "snapshot_delta") return this.acceptDelta(msg, m);
		if (m.type === "older_messages") this.noteOlder(m);
		this.send(msg);
	}

	private acceptSnapshot(msg: M, m: AnyMessage): void {
		const state = m.state as Record<string, unknown> | undefined;
		const convId = typeof state?.conversationId === "string" ? state.conversationId : "";
		const full = state && Array.isArray(state.messages) ? (state.messages as unknown[]) : undefined;
		if (!state || !convId || !full) {
			this.send(msg);
			return;
		}
		if (m.reuse !== undefined && m.reuse !== null) {
			// switch-cache: `messages` is only the tail of what the client has cached; nothing to window.
			this.convs.delete(convId);
			this.lastConversationId = convId;
			this.send(msg);
			return;
		}
		const base = nonNegativeInt(state.messagesStart);
		const entry = this.entry(convId);
		// Count + character budget every time; a later snapshot never moves the start forward.
		const tail = base + pickWindowStart(full, this.cfg);
		const start = entry.start < 0 ? tail : Math.max(base, Math.min(entry.start, tail));
		entry.full = full;
		entry.base = base;
		entry.start = start;
		this.lastConversationId = convId;
		const local = start - base;
		this.send({
			...m,
			state: {
				...state,
				messages: local > 0 ? full.slice(local) : full,
				messagesStart: start,
				historyStart: start,
				historyTotal: base + full.length,
				historyWindow: historyWindowAt(start),
			},
		} as unknown as M);
	}

	private acceptDelta(msg: M, m: AnyMessage): void {
		const convId = typeof m.conversationId === "string" ? m.conversationId : "";
		const entry = convId ? this.convs.get(convId) : undefined;
		if (!entry) {
			// No baseline seen (a delta first after a reconnect): pass through; the client heals from the rev gap.
			this.send(msg);
			return;
		}
		if (Array.isArray(m.appended) && m.appended.length > 0) entry.full = entry.full.concat(m.appended);
		this.lastConversationId = convId;
		const state = (m.state as Record<string, unknown> | undefined) ?? {};
		this.send({
			...m,
			state: {
				...state,
				...(state.messagesStart !== undefined ? { messagesStart: entry.start } : {}),
				historyStart: entry.start,
				historyTotal: entry.base + entry.full.length,
				historyWindow: historyWindowAt(entry.start),
			},
		} as unknown as M);
	}

	/** The engine served an older page itself (load_older): the client's window now starts there. */
	private noteOlder(m: AnyMessage): void {
		const convId = typeof m.conversationId === "string" ? m.conversationId : "";
		const entry = convId ? this.convs.get(convId) : undefined;
		if (!entry || typeof m.start !== "number" || !Number.isFinite(m.start)) return;
		entry.start = Math.max(0, Math.min(entry.start, Math.floor(m.start)));
	}

	/**
	 * Upstream's page request: move the window start back `count` messages (`all` = to the very first).
	 * Without a conversationId it serves the latest snapshot's conversation (old clients); with one, only
	 * that conversation (another tab or a background stream may have moved lastConversationId). Returns
	 * false when the tap has nothing for it (unknown conversation, or older than the engine's window).
	 */
	loadEarlier(count?: number, all?: boolean, conversationId?: string): boolean {
		const convId = conversationId || this.lastConversationId;
		const entry = convId ? this.convs.get(convId) : undefined;
		if (!entry || !convId) return false;
		return this.serve(convId, entry, entry.start, all ? Infinity : (count ?? this.cfg.pageSize));
	}

	/**
	 * Exact page request (`load_earlier_messages` with beforeIndex/limit): the `limit` messages just
	 * before whole-chat index `beforeIndex`, which is normally the client's earliestIndex.
	 */
	loadEarlierBefore(beforeIndex: number, limit?: number, conversationId?: string): boolean {
		const convId = conversationId || this.lastConversationId;
		const entry = convId ? this.convs.get(convId) : undefined;
		if (!entry || !convId) return false;
		const before = Math.max(0, Math.floor(Number.isFinite(beforeIndex) ? beforeIndex : entry.start));
		return this.serve(convId, entry, before, limit ?? this.cfg.pageSize);
	}

	/** One request object from the socket: { beforeIndex, limit } (exact page) or { count, all } (upstream). */
	handleRequest(req: {
		beforeIndex?: number;
		limit?: number;
		count?: number;
		all?: boolean;
		conversationId?: string;
	}): boolean {
		if (typeof req.beforeIndex === "number")
			return this.loadEarlierBefore(req.beforeIndex, req.limit, req.conversationId);
		return this.loadEarlier(req.count ?? req.limit, req.all, req.conversationId);
	}

	/** Sends the page of `limit` messages (Infinity = all the tap has) before whole-chat index `before`. */
	private serve(convId: string, entry: WindowEntry, before: number, limit: number): boolean {
		const total = entry.base + entry.full.length;
		const localBefore = before - entry.base;
		if (localBefore < 0 || before > total) return false;
		if (localBefore === 0 && entry.base > 0) return false; // older than the engine's window: the engine serves it
		const slice = readEarlierSlice(entry.full, localBefore, limit);
		const start = entry.base + slice.start;
		entry.start = Math.min(entry.start, start);
		this.touch(convId, entry);
		const reply: EarlierMessagesReply = {
			type: "earlier_messages",
			conversationId: convId,
			messages: slice.messages,
			historyStart: start,
			historyTotal: total,
			historyWindow: historyWindowAt(start),
		};
		this.send(reply as unknown as M);
		return true;
	}

	/** Get (or make) a conversation's entry, most recent last; the least recently used goes past the cap. */
	private entry(convId: string): WindowEntry {
		const hit = this.convs.get(convId);
		if (hit) {
			this.touch(convId, hit);
			return hit;
		}
		const created: WindowEntry = { full: [], base: 0, start: -1 };
		this.convs.set(convId, created);
		while (this.convs.size > MAX_CACHED_CONVERSATIONS) {
			const oldest = this.convs.keys().next();
			if (oldest.done) break;
			this.convs.delete(oldest.value);
		}
		return created;
	}

	private touch(convId: string, entry: WindowEntry): void {
		this.convs.delete(convId);
		this.convs.set(convId, entry);
	}
}

function nonNegativeInt(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}
