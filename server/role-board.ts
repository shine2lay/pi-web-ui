// ---------------------------------------------------------------------------
// role-board.ts — the roles' shared board: one post for news or the owner's orders (task #76)
// ---------------------------------------------------------------------------
// The owner, 2026-10-06 (Telegram, via COO rm-ef861b36): "Lets create a message board that everyone can
// check, instead of poking the same message to all roles that needs to read it. Have one place where
// the roles can read it. Unless its a direct requests. Those should go directly."
// His routing rule (rm-c4989975): "If the role has something waiting then the message should go
// directly to them. Because something needs to poke it to wake its session otherwise general info
// should be put in the message board".
//
// A post is news or an order, to all roles or to some. Posting wakes nobody by itself:
// - news never pokes anyone: each listed role sees it at its next turn, in its home chat (in all its
//   chats when it has none);
// - an order goes directly to each listed role that has something waiting (a turn running, an open task
//   in its queue, or a request or question to it not yet answered): one steer into each of its mid-turn
//   chats, plus one "[Board order …]" turn in its home chat when it has an open task or an unanswered
//   request and that chat isn't mid-turn (sent like a role request: the chat is opened in the background,
//   busy means try again later, exactly once). Every other listed role sees it at its next turn, in every
//   one of its chats.
// What a chat sees at the start of a turn is one "[Board]" note: a shown custom message (customType
// "board") saved in its transcript; the system prompt is left alone, so the prompt cache stays. The
// note's details carry the chat's "seen up to" mark, so the mark survives reloads. Orders are shown in
// full, news cut at about 600 characters. An order the chat got directly counts as seen there; a post
// closed after the chat saw it is shown there once as ended. A chat's first turn (no mark yet) sees only
// open orders, plus, in a home chat, news from the last 3 days.
//
// Roles mark an order done with board ack (once per role; a second ack replaces the note); nothing is
// sent to the poster: the poster, COO (roles_overview) and the Board view see who is done. The author or
// the owner closes a post.
//
// Store: <dataDir>/role-board.json, written atomically (temp file + rename), like role-messages.json.
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { checkInitiative } from "./decision-records.js";
import { samePath, type IdentityDef } from "./identities.js";
import type {
	UiBoard,
	UiBoardPost,
	UiBoardPostKind,
	UiBoardSentHow,
	UiRoleBoardOrder,
	UiRoleOverview,
} from "./protocol.js";
import { eachLineWith, firstTextOf } from "./role-messages.js";

/** The custom message type of a chat's turn-start note (and its mark in details). */
export const BOARD_CUSTOM_TYPE = "board";
/** How a chat's turn-start note starts. */
export const BOARD_NOTE_PREFIX = "[Board]";
/** How an order sent directly (a steer or a turn) starts: "[Board order bp-… from …]". */
export const BOARD_ORDER_PREFIX = "[Board order ";
export const BOARD_POST_KINDS: readonly UiBoardPostKind[] = ["order", "news"];
export const BOARD_TITLE_MAX = 100;
export const BOARD_TEXT_MAX = 2000;
/** The owner's words (and where they came from) on a post a role made for him. */
export const BOARD_OWNER_WORDS_MAX = 1000;
/** An ack's or a close's note. */
export const BOARD_NOTE_MAX = 500;
/** Posts a role may make in an hour (the owner has no cap). */
export const BOARD_POSTS_PER_HOUR = 10;
/** Posts kept in the store (the oldest closed ones go first). */
export const BOARD_KEEP = 1000;
/** Posts the page gets (newest first, closed ones too). */
export const BOARD_VIEW = 200;
/** News in a turn-start note is cut at about this many characters ("board read <id>" for the rest). */
export const BOARD_NEWS_CUT = 600;
/** A chat's first turn sees news from this many days back (home chats only). */
export const BOARD_FIRST_NEWS_DAYS = 3;
/** Posts one turn-start note shows at most (the rest: board read). */
export const BOARD_NOTE_POSTS_MAX = 20;
/** A direct turn not delivered by then is given up (the role still sees the order at its next turn). */
const GIVE_UP_MS = 24 * 3600_000;
/** A send that got in but never landed is sent again once the chat has been idle this long. */
const SETTLE_MS = 30_000;
/** Sends that got in before giving up. */
const MAX_SENDS = 3;
const TICK_MS = 3000;
const ID_RE = /^bp-[0-9a-f]{8}$/;

/** A post as stored: the page's shape plus its place in the board's order and the direct turns still to
 *  deliver. */
export interface BoardPostRecord extends UiBoardPost {
	/** 1, 2, 3, … in posting order (a chat's mark says which it has seen). */
	seq: number;
	/** Orders: direct turns still to deliver, by role. */
	pending?: Record<string, BoardPending>;
}

/** An order's direct turn in a role's home chat, still to deliver. */
export interface BoardPending {
	file: string;
	since: number;
	/** The transcript's size before the first send: the order's line is looked for after it. */
	scanFrom: number;
	sends: number;
	attempts: number;
	nextTryAt?: number;
	error?: string;
}

interface BoardFile {
	v: 1;
	/** Random per store: a chat's mark from another store (the file was lost) counts as none. */
	epoch: string;
	seq: number;
	posts: BoardPostRecord[];
}

/** A chat's "seen up to" mark: the details of its newest "[Board]" note. */
export interface BoardMark {
	v: 1;
	epoch: string;
	/** Every post up to this seq has been through this chat (shown, or not for it). */
	upTo: number;
	/** Posts it saw that were open then (an ended one is shown once, then dropped). */
	open: string[];
}

/** What a "[Board]" note's details hold: the mark, and what this note showed. */
export interface BoardNoteDetails extends BoardMark {
	ids: string[];
	ended?: string[];
}

/** The chat a turn-start note is for. */
export interface BoardChat {
	role: string;
	/** Its role's home chat, or any chat of a role that has none (news shows only there). */
	isHome: boolean;
	/** Its newest note's mark (none: its first turn on the board). */
	mark?: BoardMark;
	/** Orders it got directly since that note ("[Board order …]" steers and turns, this turn's prompt too). */
	got: readonly string[];
}

export interface BoardNote {
	text: string;
	details: BoardNoteDetails;
	fresh: BoardPostRecord[];
	ended: BoardPostRecord[];
}

/** A role's state when an order is posted: what decides whether it goes to the role directly. */
export interface BoardRoleState {
	role: string;
	/** Its chats mid-turn in this server (session files), that a steer can reach. */
	midTurn: string[];
	/** Its home chat (session file). */
	home?: string;
	/** Its home chat is one of the mid-turn ones. */
	homeMidTurn: boolean;
	/** Tasks in its queue that are not done or removed (ready, working, asking, stuck, waiting, blocked,
	 *  or held by the owner's pause). */
	openTasks: number;
	/** Requests and questions to it with no reply yet. */
	openRequests: number;
}

/** Where an order goes for one role. */
export interface BoardRoute {
	/** It has something waiting. */
	waiting: boolean;
	/** One steer into each of these mid-turn chats. */
	steer: string[];
	/** One direct turn in this chat (its home chat). */
	turn?: string;
	/** What is waiting, in words. */
	why: string[];
}

export interface BoardHost {
	roles(): IdentityDef[];
	/** The listed roles' state now (one read for all of them). */
	roleStates(roles: string[]): Promise<Map<string, BoardRoleState>>;
	/** Steer this text into the chat's running turn; false when it isn't running (nothing sent). */
	steer(file: string, text: string): Promise<boolean>;
	chatState(file: string): "working" | "idle" | "closed";
	/** Send this text as a message that starts a turn (the role-request path). */
	deliver(file: string, text: string): Promise<{ ok: true } | { ok: false; busy?: boolean; error: string }>;
	changed?(): void;
	/** decision-records: a post was just made. */
	posted?(post: UiBoardPost): void;
	log?(line: string): void;
}

/** Who posts, closes or acks: the owner (the Board view) or a role chat (the board tool). */
export type BoardActor = { owner: true } | { role: string };

export interface BoardPostInput {
	kind?: unknown;
	to?: unknown;
	title?: unknown;
	text?: unknown;
	ownerWords?: unknown;
	/** decision-records: optional initiative id (lowercase letters, digits, dashes; at most 60). */
	initiative?: unknown;
}

export type BoardPostResult =
	| {
			ok: true;
			post: UiBoardPost;
			/** Orders: the roles it reached directly (steer: into a running turn; turn: one in its home chat). */
			direct: { role: string; how: UiBoardSentHow[]; why: string[] }[];
			/** The listed roles that see it at their next turn. */
			later: string[];
	  }
	| { ok: false; error: string };

export type BoardChangeResult = { ok: true; post: UiBoardPost; replaced?: boolean } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Who wrote a post: the role that posted it (also when it relayed the owner's words), or "owner". */
export function postAuthor(p: Pick<UiBoardPost, "from" | "via">): string {
	return p.via ?? p.from;
}

/** The roles a post is for (its author left out). */
export function audienceOf(p: Pick<UiBoardPost, "to" | "from" | "via">, roleIds: readonly string[]): string[] {
	const author = postAuthor(p);
	const listed = p.to === "all" ? roleIds : p.to;
	return [...new Set(listed)].filter((r) => r !== author);
}

/** Whether the post is for this role (its author doesn't get its own post). */
export function postIsFor(p: Pick<UiBoardPost, "to" | "from" | "via">, role: string): boolean {
	if (postAuthor(p) === role) return false;
	return p.to === "all" || p.to.includes(role);
}

/** Whether a chat of this role shows the post: orders in every chat, news only in a home chat. */
export function postShownIn(
	p: Pick<UiBoardPost, "to" | "from" | "via" | "kind">,
	role: string,
	isHome: boolean,
): boolean {
	return postIsFor(p, role) && (p.kind === "order" || isHome);
}

/** Where an order goes for a role with this state (the owner's rule: directly only when something waits). */
export function routeOrder(s: BoardRoleState): BoardRoute {
	const why: string[] = [];
	if (s.midTurn.length) why.push(s.midTurn.length === 1 ? "a turn running" : `${s.midTurn.length} turns running`);
	if (s.openTasks > 0)
		why.push(s.openTasks === 1 ? "an open task in its queue" : `${s.openTasks} open tasks in its queue`);
	if (s.openRequests > 0) {
		why.push(
			s.openRequests === 1 ? "a request to it not yet answered" : `${s.openRequests} requests to it not yet answered`,
		);
	}
	const turn = (s.openTasks > 0 || s.openRequests > 0) && s.home && !s.homeMidTurn ? s.home : undefined;
	return { waiting: why.length > 0, steer: [...new Set(s.midTurn)], ...(turn ? { turn } : {}), why };
}

/** A role's state when an order is posted, from the Roles page's data for it (its queue: every task not
 *  done or removed, held ones too; requests and questions to it not yet answered) and its chats whose turn
 *  runs in this server. */
export function boardRoleStateOf(
	role: string,
	overview: Pick<UiRoleOverview, "queue" | "requests"> | undefined,
	home: string | undefined,
	midTurn: readonly string[],
): BoardRoleState {
	const running = midTurn.filter((f, i) => midTurn.findIndex((g) => samePath(f, g)) === i);
	return {
		role,
		midTurn: running,
		...(home ? { home } : {}),
		homeMidTurn: !!home && running.some((f) => samePath(f, home)),
		openTasks: (overview?.queue?.counts.active ?? 0) + (overview?.queue?.counts.queued ?? 0),
		openRequests: overview?.requests.open ?? 0,
	};
}

/** "2026-10-06 15:10 PDT" (the server's zone, or tz). */
export function boardTime(ms: number, tz?: string): string {
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			...(tz ? { timeZone: tz } : {}),
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
			timeZoneName: "short",
		}).formatToParts(new Date(ms));
		const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
		return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`.trim();
	} catch {
		return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
	}
}

function kindWord(kind: UiBoardPostKind): string {
	return kind === "order" ? "Order" : "News";
}

function fromWords(p: Pick<UiBoardPost, "from" | "via">): string {
	return p.via ? `${p.from} (via ${p.via})` : p.from;
}

function toWords(p: Pick<UiBoardPost, "to">): string {
	return p.to === "all" ? "all roles" : p.to.join(", ");
}

/** The ack line an order ends with. */
export function ackLine(id: string): string {
	return `When you have acted on it: board ack ${id} "<what you did>"`;
}

/** News cut at about `max` characters, at a word break. */
export function cutText(text: string, max = BOARD_NEWS_CUT): { text: string; cut: boolean } {
	if (text.length <= max) return { text, cut: false };
	const room = text.slice(0, max);
	const at = room.search(/\s\S*$/);
	return { text: `${(at > max * 0.6 ? room.slice(0, at) : room).trimEnd()} …`, cut: true };
}

/** One post as a turn-start note shows it. */
function noteBlock(p: BoardPostRecord, tz?: string): string {
	const lines = [`${kindWord(p.kind)} ${p.id} · from ${fromWords(p)} · ${boardTime(p.at, tz)} · to ${toWords(p)}`];
	lines.push(`**${p.title}**`);
	if (p.kind === "order") {
		lines.push(p.text);
		if (p.ownerWords) lines.push(`Owner's words: ${p.ownerWords}`);
		lines.push(ackLine(p.id));
	} else {
		const { text, cut } = cutText(p.text);
		lines.push(cut ? `${text} (the rest: board read ${p.id})` : text);
		if (p.ownerWords) lines.push(`Owner's words: ${p.ownerWords}`);
	}
	return lines.join("\n");
}

function endedLine(p: BoardPostRecord, tz?: string): string {
	const c = p.closed;
	const when = c ? ` ${boardTime(c.at, tz)}` : "";
	const note = c?.note ? `: ${c.note}` : "";
	return `Ended: ${kindWord(p.kind).toLowerCase()} ${p.id} "${p.title}", closed by ${c?.by ?? "?"}${when}${note}`;
}

/** The text of an order sent directly (a steer into a running turn, or a turn in a home chat). */
export function boardOrderText(p: UiBoardPost, tz?: string): string {
	const header = `${BOARD_ORDER_PREFIX}${p.id} from ${fromWords(p)} · ${boardTime(p.at, tz)}]`;
	const parts = [header, `**${p.title}**`, p.text];
	if (p.ownerWords) parts.push(`Owner's words: ${p.ownerWords}`);
	parts.push(
		"(The owner's order on the roles' board, sent to you directly because you have something waiting. It asks for no reply.)\n" +
			ackLine(p.id),
	);
	return parts.join("\n\n");
}

/** The id of an order a user message got directly ("[Board order bp-… "), if it is one. */
export function boardOrderIdOf(text: string | undefined): string | undefined {
	if (!text?.startsWith(BOARD_ORDER_PREFIX)) return undefined;
	const id = text.slice(BOARD_ORDER_PREFIX.length).split(/\s/, 1)[0];
	return ID_RE.test(id) ? id : undefined;
}

/** A "[Board]" note's mark, if these details are one. */
export function boardMarkOf(details: unknown): BoardMark | undefined {
	const d = details as Partial<BoardMark> | undefined;
	if (!d || d.v !== 1 || typeof d.epoch !== "string" || typeof d.upTo !== "number" || !Array.isArray(d.open)) {
		return undefined;
	}
	return { v: 1, epoch: d.epoch, upTo: d.upTo, open: d.open.filter((x): x is string => typeof x === "string") };
}

/** What a chat's transcript says about the board: its newest note's mark and the orders it got directly
 *  since. `entries` in transcript order (a branch); read from the newest back to that note. */
export function boardChatState(
	entries: readonly { type?: string; customType?: string; details?: unknown; message?: unknown }[],
): { mark?: BoardMark; got: string[] } {
	const got: string[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "custom_message" && e.customType === BOARD_CUSTOM_TYPE) {
			const mark = boardMarkOf(e.details);
			if (mark) return { mark, got };
			continue;
		}
		if (e.type !== "message") continue;
		const m = e.message as { role?: unknown; content?: unknown } | undefined;
		if (m?.role !== "user") continue;
		const id = boardOrderIdOf(firstTextOf(m.content));
		if (id && !got.includes(id)) got.push(id);
	}
	return { got };
}

/** The turn-start note for a chat (undefined: nothing new for it). Pure: reads are marked by the caller. */
export function boardNote(
	store: { epoch: string; seq: number; posts: readonly BoardPostRecord[] },
	chat: BoardChat,
	now: number,
	tz?: string,
): BoardNote | undefined {
	const byId = new Map(store.posts.map((p) => [p.id, p]));
	const mark = chat.mark && chat.mark.epoch === store.epoch ? chat.mark : undefined;
	const got = new Set(chat.got.filter((id) => byId.has(id)));
	// Ended: posts this chat saw (or got directly) that are closed now.
	const seen = new Set([...(mark?.open ?? []), ...got]);
	const ended: BoardPostRecord[] = [];
	for (const id of seen) {
		const p = byId.get(id);
		if (p?.closed) ended.push(p);
	}
	// New: open posts for this chat it hasn't seen.
	const newsFrom = now - BOARD_FIRST_NEWS_DAYS * 24 * 3600_000;
	const fresh = store.posts
		.filter((p) => {
			if (p.closed || got.has(p.id) || !postShownIn(p, chat.role, chat.isHome)) return false;
			if (mark) return p.seq > mark.upTo && !mark.open.includes(p.id);
			return p.kind === "order" || p.at >= newsFrom;
		})
		.sort((a, b) => (a.kind === b.kind ? a.seq - b.seq : a.kind === "order" ? -1 : 1));
	if (!fresh.length && !ended.length) return undefined;
	const shown = fresh.slice(0, BOARD_NOTE_POSTS_MAX);
	const more = fresh.length - shown.length;
	const endedIds = new Set(ended.map((p) => p.id));
	const open = [...new Set([...seen, ...fresh.map((p) => p.id)])].filter((id) => byId.has(id) && !endedIds.has(id));
	const n = shown.length;
	const head = n
		? `${BOARD_NOTE_PREFIX} ${n} new post${n === 1 ? "" : "s"}${ended.length ? `, ${ended.length} ended` : ""}`
		: `${BOARD_NOTE_PREFIX} ${ended.length} post${ended.length === 1 ? "" : "s"} ended`;
	const blocks = [head, ...shown.map((p) => noteBlock(p, tz))];
	if (more > 0) blocks.push(`… and ${more} more: board read`);
	if (ended.length) blocks.push(ended.map((p) => endedLine(p, tz)).join("\n"));
	return {
		text: blocks.join("\n\n"),
		details: {
			v: 1,
			epoch: store.epoch,
			upTo: store.seq,
			open,
			ids: shown.map((p) => p.id),
			...(ended.length ? { ended: ended.map((p) => p.id) } : {}),
		},
		fresh: shown,
		ended,
	};
}

/** The page's (and roles_overview's) shape of a post. */
export function uiBoardPost(p: BoardPostRecord): UiBoardPost {
	const { seq: _seq, pending: _pending, ...rest } = p;
	return structuredClone(rest);
}

/** Open orders for a role that it hasn't marked done, oldest first. */
export function openOrdersFor(posts: readonly UiBoardPost[], role: string): UiRoleBoardOrder[] {
	return posts
		.filter((p) => p.kind === "order" && !p.closed && postIsFor(p, role) && !p.done?.[role])
		.sort((a, b) => a.at - b.at)
		.map((p) => ({ id: p.id, title: p.title, at: p.at, from: p.from, ...(p.via ? { via: p.via } : {}) }));
}

function str(v: unknown): string {
	return typeof v === "string" ? v.trim() : "";
}

/** Whether a user message (or a board note) shows this post after `from` in the transcript: "turn" = the
 *  order's own line ("[Board order <id> "), "note" = a "[Board]" note that listed it. */
export async function transcriptSawPost(file: string, from: number, id: string): Promise<"turn" | "note" | undefined> {
	let found: "turn" | "note" | undefined;
	await eachLineWith(file, from, id, (entry) => {
		const e = entry as {
			type?: unknown;
			customType?: unknown;
			details?: { ids?: unknown };
			message?: { role?: unknown; content?: unknown };
		};
		if (e?.type === "message" && e.message?.role === "user") {
			if (boardOrderIdOf(firstTextOf(e.message.content)) === id) found = "turn";
		} else if (e?.type === "custom_message" && e.customType === BOARD_CUSTOM_TYPE) {
			if (Array.isArray(e.details?.ids) && e.details.ids.includes(id)) found = "note";
		}
		return found !== undefined;
	});
	return found;
}

function sizeOf(file: string): number {
	try {
		return statSync(file).size;
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------------------
// The store and its delivery loop
// ---------------------------------------------------------------------------

export class RoleBoard {
	private data: BoardFile;
	private timer: ReturnType<typeof setInterval> | undefined;
	private kickTimer: ReturnType<typeof setTimeout> | undefined;
	private notifyTimer: ReturnType<typeof setTimeout> | undefined;
	private running: Promise<void> | undefined;
	private again = false;
	/** Direct turns sent and not yet seen landing: `${id}:${role}` -> since when the chat is idle. */
	private inFlight = new Map<string, { idleSince?: number }>();

	constructor(
		private readonly file: string,
		private readonly host: BoardHost,
		private readonly now: () => number = Date.now,
	) {
		this.data = this.load();
	}

	private log(line: string): void {
		try {
			this.host.log?.(`[board] ${line}`);
		} catch {
			// logging never breaks the board
		}
	}

	private load(): BoardFile {
		const fresh = (): BoardFile => ({ v: 1, epoch: randomBytes(4).toString("hex"), seq: 0, posts: [] });
		if (!existsSync(this.file)) return fresh();
		try {
			const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<BoardFile>;
			if (raw.v !== 1 || typeof raw.epoch !== "string" || !Array.isArray(raw.posts))
				throw new Error("not a board file");
			const posts = raw.posts.filter(
				(p): p is BoardPostRecord =>
					!!p && typeof p.id === "string" && typeof p.seq === "number" && (p.kind === "order" || p.kind === "news"),
			);
			const seq = Math.max(typeof raw.seq === "number" ? raw.seq : 0, ...posts.map((p) => p.seq), 0);
			return { v: 1, epoch: raw.epoch, seq, posts };
		} catch (err) {
			const aside = `${this.file}.bad-${this.now()}`;
			try {
				renameSync(this.file, aside);
			} catch {
				// keep going with an empty board
			}
			this.log(`couldn't read ${this.file} (${(err as Error).message}); moved it to ${aside}`);
			return fresh();
		}
	}

	private save(): void {
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			const tmp = `${this.file}.${process.pid}.tmp`;
			writeFileSync(tmp, `${JSON.stringify(this.data, null, "\t")}\n`);
			renameSync(tmp, this.file);
		} catch (err) {
			this.log(`couldn't save: ${(err as Error).message}`);
		}
		this.notify();
	}

	private notify(): void {
		if (this.notifyTimer) return;
		this.notifyTimer = setTimeout(() => {
			this.notifyTimer = undefined;
			try {
				this.host.changed?.();
			} catch {
				// the page catches up on its next read
			}
		}, 300);
		this.notifyTimer.unref?.();
	}

	private roleIds(): string[] {
		return this.host.roles().map((r) => r.id);
	}

	/** Nothing on the board (a turn needs no work). */
	get empty(): boolean {
		return this.data.posts.length === 0;
	}

	get epoch(): string {
		return this.data.epoch;
	}

	byId(id: string): BoardPostRecord | undefined {
		return this.data.posts.find((p) => p.id === id);
	}

	/** The page's part of the Roles snapshot. */
	view(): UiBoard {
		return { posts: this.data.posts.slice(-BOARD_VIEW).reverse().map(uiBoardPost) };
	}

	/** Open orders for a role that it hasn't marked done, oldest first (its panel, roles_overview). */
	openOrdersOf(role: string): UiRoleBoardOrder[] {
		return openOrdersFor(this.data.posts, role);
	}

	/** Posts for a role (board read without an id): open ones, newest first. */
	openFor(role: string): BoardPostRecord[] {
		return this.data.posts.filter((p) => !p.closed && postIsFor(p, role)).reverse();
	}

	/** The roles a post is for. */
	audience(p: UiBoardPost): string[] {
		return audienceOf(p, this.roleIds());
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick(), TICK_MS);
		this.timer.unref?.();
		this.kick();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		if (this.kickTimer) clearTimeout(this.kickTimer);
		this.kickTimer = undefined;
		if (this.notifyTimer) clearTimeout(this.notifyTimer);
		this.notifyTimer = undefined;
	}

	kick(): void {
		if (this.kickTimer) return;
		this.kickTimer = setTimeout(() => {
			this.kickTimer = undefined;
			void this.tick();
		}, 0);
		this.kickTimer.unref?.();
	}

	/** Mark that a role saw these posts (the first time counts). */
	markRead(role: string, ids: readonly string[]): void {
		const at = this.now();
		let changed = false;
		for (const id of ids) {
			const p = this.byId(id);
			if (!p || !postIsFor(p, role) || p.reads?.[role]) continue;
			p.reads = { ...p.reads, [role]: at };
			changed = true;
		}
		if (changed) this.save();
	}

	/** The turn-start note for a chat (and its role's reads marked); undefined: nothing new for it. */
	turnNote(chat: BoardChat): BoardNote | undefined {
		if (this.empty) return undefined;
		const note = boardNote(this.data, chat, this.now());
		const read = [...(note?.fresh ?? []).map((p) => p.id), ...chat.got];
		if (read.length) this.markRead(chat.role, read);
		return note;
	}

	/** Post news or an order. An order goes directly to the listed roles that have something waiting. */
	async post(actor: BoardActor, input: BoardPostInput): Promise<BoardPostResult> {
		const now = this.now();
		const kind = str(input.kind) as UiBoardPostKind;
		if (!BOARD_POST_KINDS.includes(kind)) return { ok: false, error: 'kind must be "order" or "news"' };
		const title = str(input.title);
		if (!title) return { ok: false, error: "a title is needed" };
		if (title.length > BOARD_TITLE_MAX) return { ok: false, error: `the title is over ${BOARD_TITLE_MAX} characters` };
		const text = str(input.text);
		if (!text) return { ok: false, error: "a text is needed" };
		if (text.length > BOARD_TEXT_MAX) return { ok: false, error: `the text is over ${BOARD_TEXT_MAX} characters` };
		const ownerWords = str(input.ownerWords);
		if (ownerWords.length > BOARD_OWNER_WORDS_MAX) {
			return { ok: false, error: `ownerWords is over ${BOARD_OWNER_WORDS_MAX} characters` };
		}
		const initiativeCheck = checkInitiative(input.initiative);
		if (!initiativeCheck.ok) return { ok: false, error: initiativeCheck.error };
		const initiative = initiativeCheck.value;
		const roleIds = this.roleIds();
		let to: "all" | string[];
		const rawTo = input.to;
		if (rawTo === "all" || (Array.isArray(rawTo) && rawTo.length === 1 && rawTo[0] === "all")) to = "all";
		else if (Array.isArray(rawTo) && rawTo.length) {
			const ids = [...new Set(rawTo.map((r) => str(r)).filter(Boolean))];
			const unknown = ids.filter((r) => !roleIds.includes(r));
			if (unknown.length) {
				return { ok: false, error: `no role ${unknown.join(", ")} (roles: ${roleIds.join(", ") || "none"})` };
			}
			to = ids;
		} else return { ok: false, error: 'to must be "all" or a list of role ids' };

		let from: string;
		let via: string | undefined;
		if ("owner" in actor) from = "owner";
		else {
			const role = actor.role;
			if (kind === "order" && !ownerWords) {
				return {
					ok: false,
					error:
						"an order is only the owner's: put his words and where they came from in ownerWords (general info goes as news)",
				};
			}
			const hourAgo = now - 3600_000;
			const lastHour = this.data.posts.filter((p) => postAuthor(p) === role && p.at > hourAgo).length;
			if (lastHour >= BOARD_POSTS_PER_HOUR) {
				return {
					ok: false,
					error: `${role} has posted ${lastHour} times in the last hour (the cap is ${BOARD_POSTS_PER_HOUR})`,
				};
			}
			if (ownerWords) {
				from = "owner";
				via = role;
			} else from = role;
		}
		const draft = { from, ...(via ? { via } : {}), to };
		if (!audienceOf(draft, roleIds).length)
			return { ok: false, error: "nobody to post it to (only its author is listed)" };

		let id: string;
		do id = `bp-${randomBytes(4).toString("hex")}`;
		while (this.byId(id));
		const post: BoardPostRecord = {
			id,
			seq: ++this.data.seq,
			at: now,
			from,
			...(via ? { via } : {}),
			kind,
			to,
			title,
			text,
			...(ownerWords ? { ownerWords } : {}),
			...(initiative ? { initiative } : {}),
		};
		this.data.posts.push(post);
		this.prune();
		this.save();
		this.log(`${post.id} ${kind} from ${fromWords(post)} to ${toWords(post)}: "${title}"`);
		try {
			this.host.posted?.(uiBoardPost(post));
		} catch (err) {
			this.log(`${post.id}: couldn't keep its decision record (${(err as Error).message})`);
		}

		const direct: { role: string; how: UiBoardSentHow[]; why: string[] }[] = [];
		const later: string[] = [];
		const audience = audienceOf(post, roleIds);
		if (kind === "news") return { ok: true, post: uiBoardPost(post), direct, later: audience };

		// The owner's rule: an order goes directly only to the roles that have something waiting.
		let states: Map<string, BoardRoleState>;
		try {
			states = await this.host.roleStates(audience);
		} catch (err) {
			this.log(
				`${post.id}: couldn't read the roles' state (${(err as Error).message}); all read it at their next turn`,
			);
			states = new Map();
		}
		const text1 = boardOrderText(post);
		for (const role of audience) {
			const s = states.get(role);
			const route = s ? routeOrder(s) : undefined;
			if (!route?.waiting) {
				later.push(role);
				continue;
			}
			const how: UiBoardSentHow[] = [];
			let steered = 0;
			for (const file of route.steer) {
				try {
					if (await this.host.steer(file, text1)) steered++;
				} catch (err) {
					this.log(`${post.id}: steer into ${file} failed: ${(err as Error).message}`);
				}
			}
			if (steered) {
				how.push("steer");
				post.sent = { ...post.sent, [role]: { at: this.now(), how: "steer" } };
				post.reads = { ...post.reads, [role]: post.reads?.[role] ?? this.now() };
			}
			if (route.turn) {
				how.push("turn");
				post.pending = {
					...post.pending,
					[role]: { file: route.turn, since: this.now(), scanFrom: sizeOf(route.turn), sends: 0, attempts: 0 },
				};
			}
			if (how.length) direct.push({ role, how, why: route.why });
			else later.push(role);
		}
		this.save();
		if (post.pending) this.kick();
		return { ok: true, post: uiBoardPost(post), direct, later };
	}

	/** A role marks an order done, with what it did (a second ack replaces the note). */
	ack(role: string, id: unknown, note: unknown): BoardChangeResult {
		const p = this.byId(str(id));
		if (!p) return { ok: false, error: `no post ${str(id) || "(no id)"} on the board` };
		if (p.kind !== "order") return { ok: false, error: `${p.id} is news: only orders are acked` };
		if (!postIsFor(p, role)) return { ok: false, error: `${p.id} isn't for ${role}` };
		const text = str(note);
		if (!text) return { ok: false, error: "say what you did (note)" };
		if (text.length > BOARD_NOTE_MAX) return { ok: false, error: `the note is over ${BOARD_NOTE_MAX} characters` };
		const replaced = !!p.done?.[role];
		const at = this.now();
		p.done = { ...p.done, [role]: { at, note: text } };
		p.reads = { ...p.reads, [role]: p.reads?.[role] ?? at };
		this.save();
		this.log(`${p.id} done by ${role}${replaced ? " (note replaced)" : ""}`);
		return { ok: true, post: uiBoardPost(p), ...(replaced ? { replaced } : {}) };
	}

	/** The author or the owner closes a post. Its direct turns not yet delivered are dropped. */
	close(actor: BoardActor, id: unknown, note: unknown): BoardChangeResult {
		const p = this.byId(str(id));
		if (!p) return { ok: false, error: `no post ${str(id) || "(no id)"} on the board` };
		const by = "owner" in actor ? "owner" : actor.role;
		if (by !== "owner" && postAuthor(p) !== by) {
			return { ok: false, error: `only its author (${postAuthor(p)}) or the owner closes ${p.id}` };
		}
		if (p.closed) return { ok: false, error: `${p.id} is already closed` };
		const text = str(note);
		if (text.length > BOARD_NOTE_MAX) return { ok: false, error: `the note is over ${BOARD_NOTE_MAX} characters` };
		p.closed = { at: this.now(), by, ...(text ? { note: text } : {}) };
		if (p.pending) {
			for (const role of Object.keys(p.pending)) this.inFlight.delete(`${p.id}:${role}`);
			delete p.pending;
		}
		this.save();
		this.log(`${p.id} closed by ${by}${text ? `: ${text}` : ""}`);
		return { ok: true, post: uiBoardPost(p) };
	}

	/** Drop the oldest closed posts past BOARD_KEEP (then the oldest of any). */
	private prune(): void {
		const over = this.data.posts.length - BOARD_KEEP;
		if (over <= 0) return;
		const closed = this.data.posts.filter((p) => p.closed).slice(0, over);
		const drop = new Set(closed.map((p) => p.id));
		for (const p of this.data.posts) {
			if (drop.size >= over) break;
			drop.add(p.id);
		}
		this.data.posts = this.data.posts.filter((p) => !drop.has(p.id));
	}

	/** One pass over the direct turns still to deliver. */
	tick(): Promise<void> {
		if (this.running) {
			this.again = true;
			return this.running;
		}
		this.running = (async () => {
			// Never finish before `running` is set (a synchronous pass would clear it first).
			await Promise.resolve();
			do {
				this.again = false;
				// A copy: posts may be added or trimmed while a step awaits.
				for (const p of this.data.posts.slice()) {
					if (!p.pending) continue;
					for (const role of Object.keys(p.pending)) {
						try {
							await this.step(p, role);
						} catch (err) {
							this.log(`${p.id} to ${role}: ${(err as Error).message}`);
						}
					}
				}
			} while (this.again);
		})().finally(() => {
			this.running = undefined;
		});
		return this.running;
	}

	private done(p: BoardPostRecord, role: string): void {
		if (p.pending) {
			delete p.pending[role];
			if (!Object.keys(p.pending).length) delete p.pending;
		}
		this.inFlight.delete(`${p.id}:${role}`);
		this.save();
	}

	/** One direct turn: exactly once (the transcript is the proof), only while the chat isn't working. */
	private async step(p: BoardPostRecord, role: string): Promise<void> {
		const d = p.pending?.[role];
		if (!d) return;
		const now = this.now();
		const key = `${p.id}:${role}`;
		if (p.closed) return this.done(p, role);
		if (now - d.since > GIVE_UP_MS) {
			this.log(`${p.id}: gave up the turn in ${role}'s home chat after 24 h (${d.error ?? "never free"})`);
			return this.done(p, role);
		}
		const saw = await transcriptSawPost(d.file, d.scanFrom, p.id);
		if (saw === "turn") {
			p.sent = { ...p.sent, [role]: { at: now, how: "turn" } };
			p.reads = { ...p.reads, [role]: p.reads?.[role] ?? now };
			this.log(`${p.id}: turn delivered to ${role}'s home chat`);
			return this.done(p, role);
		}
		if (saw === "note") {
			// Its home chat had a turn of its own meanwhile and saw the order there.
			this.log(`${p.id}: ${role}'s home chat saw it at a turn of its own; no turn needed`);
			return this.done(p, role);
		}
		if (d.nextTryAt && now < d.nextTryAt) return;
		const state = this.host.chatState(d.file);
		const flight = this.inFlight.get(key);
		if (flight) {
			if (state === "working") {
				flight.idleSince = undefined;
				return;
			}
			flight.idleSince ??= now;
			if (now - flight.idleSince < SETTLE_MS) return;
			this.inFlight.delete(key);
			if (d.sends >= MAX_SENDS) {
				this.log(`${p.id}: the turn in ${role}'s home chat never landed after ${d.sends} sends; given up`);
				return this.done(p, role);
			}
		}
		if (state === "working") return;
		const res = await this.host.deliver(d.file, boardOrderText(p));
		if (res.ok) {
			d.sends++;
			d.error = undefined;
			this.inFlight.set(key, {});
			this.save();
			this.again = true;
			return;
		}
		if (res.busy) return;
		d.attempts++;
		d.error = res.error;
		d.nextTryAt = now + Math.min(5 * 60_000, 15_000 * 2 ** (d.attempts - 1));
		this.save();
	}
}
