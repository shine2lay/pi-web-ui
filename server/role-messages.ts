// ---------------------------------------------------------------------------
// role-messages.ts — role chats message each other (the message_role tool): store and delivery
// ---------------------------------------------------------------------------
// A role chat (one with a pi-identity identity) sends a question, a request, an FYI or a reply to
// another role. The server stamps who sent it (the sending chat's role, and which chat: its home chat,
// "Queue #N" or a chat by title) — never the model's own words — and keeps every message in a durable
// store, <dataDir>/role-messages.json.
//
// Delivery goes to the receiving role's home chat (identity.json homeChat: a session file, stable
// across reloads, unlike conversation ids). A reply goes back to the exact chat that asked (it may be a
// queued task's chat); when that chat is gone or its task is finished, to the asking role's home chat.
//
// The message arrives as a user message whose first line is the server-built header
// "[Role message rm-… from <role> (<title>), sent from its <chat> · <kind>]", then the text, then one
// hint line. It goes in through the same path as a typed message (so the chat's add-ons run: its role
// section, memory, persona), marked as coming from an extension (pi-queue doesn't take it for the
// owner's answer), queued behind any running turn (follow-up, never steer), and only once the chat
// isn't working. A closed chat is opened in the background for it. The page shows such a message as
// a labelled card when the store confirms it (same id, same chat, same text): a body that claims
// another sender changes nothing.
//
// Exactly once: before the first send the target chat's transcript size is noted; the message counts
// as delivered once its header line is in the transcript after that point. A send that got in but
// never landed (the run was stopped while it waited) is sent again after the chat has been idle a
// while; a restart forgets nothing (the store is on disk, the transcript is the proof).
//
// Caps: 20 messages an hour per sending role; a chain limit of 6 (a message sent while handling a
// role message is one deeper than it). The owner can pause delivery (Settings → Identities): messages
// are held, not dropped.
// ---------------------------------------------------------------------------

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { samePath, type IdentityDef } from "./identities.js";
import type { UiRoleMessage, UiRoleMessageKind, UiRoleMessageRow, UiRoleMessageState } from "./protocol.js";
import { TASK_QUEUE_ENTRY_TYPE, taskQueueFromEntries, type TaskQueueEntryLike } from "./task-queue.js";

export const ROLE_MESSAGE_KINDS: readonly UiRoleMessageKind[] = ["question", "request", "fyi", "reply"];
/** Messages a sending role may send in an hour. */
export const ROLE_MESSAGES_PER_HOUR = 20;
/** The deepest a chain of messages may go (a message sent while handling one is one deeper). */
export const ROLE_MESSAGE_CHAIN_MAX = 6;
/** The longest text a message may carry. */
export const ROLE_MESSAGE_TEXT_MAX = 4000;
/** Messages the store keeps (waiting ones are never dropped). */
export const ROLE_MESSAGES_KEEP = 1000;
/** Rows Settings → Identities shows. */
export const ROLE_MESSAGES_LIST = 100;

const HOUR_MS = 60 * 60 * 1000;
/** How often waiting messages are looked at. */
const TICK_MS = 3000;
/** A send that got in but hasn't landed counts as lost once its chat has been idle this long. */
const SETTLE_MS = 30_000;
/** Sends that got in but never landed, before the message counts as failed. */
const MAX_SENDS = 5;
/** A message not delivered within a day fails. */
const GIVE_UP_MS = 24 * HOUR_MS;
const FILE_VERSION = 1;

const HEADER_RE = /^\[Role message (rm-[0-9a-f]{8}) /;

export type RoleMessageKind = UiRoleMessageKind;
export type RoleMessageState = UiRoleMessageState;

export interface RoleMessageRecord {
	id: string;
	/** When it was sent. */
	at: number;
	/** Stamped by the server: the sending chat's role, the role's title, which chat ("home chat",
	 *  "Queue #N", or chat "<title>") and its transcript. */
	from: { role: string; title: string; chat: string; file: string };
	to: { role: string; title: string };
	kind: RoleMessageKind;
	/** kind reply: the message it answers. */
	replyTo?: string;
	/** 1 = sent on the sender's own; n + 1 = sent while handling a message of depth n. */
	chain: number;
	/** The text as the sender wrote it. */
	text: string;
	state: RoleMessageState;
	/** The chat it goes to (fixed before the first send; routed again only if that transcript is gone). */
	target?: string;
	/** That chat, in words ("home chat", "Queue #N", chat "<title>"). */
	targetChat?: string;
	/** The target transcript's size before the first send: the header is looked for after it. */
	scanFrom?: number;
	/** sha1 of the delivered text (the page's card is shown only for exactly this text). */
	hash?: string;
	/** Sends that got in. */
	sends: number;
	/** Sends that failed (the chat couldn't be opened, the server was restarting, …). */
	attempts: number;
	nextTryAt?: number;
	deliveredAt?: number;
	/** The reply that answered it. */
	replyId?: string;
	error?: string;
}

interface StoreFile {
	v: number;
	paused: boolean;
	/** When the owner last resumed delivery: held messages get a fresh day from then. */
	resumedAt?: number;
	messages: RoleMessageRecord[];
}

/** What the server does for the delivery (AgentService). */
export interface RoleMessageHost {
	/** The roles now (pi-identity's identity list). */
	roles(): IdentityDef[];
	/** Whether the chat with this transcript is working (a turn runs, a message is on its way). */
	chatState(file: string): "working" | "idle" | "closed";
	/** Send the text into the chat as a queued user message (opening it if it is closed). busy = it
	 *  started working meanwhile: try later, not a failed attempt. */
	deliver(file: string, text: string): Promise<{ ok: true } | { ok: false; busy?: boolean; error: string }>;
	/** The store changed (the page's list). */
	changed?(): void;
	log?(line: string): void;
}

/** The sending chat, as the server knows it. */
export interface RoleMessageSender {
	role: string;
	title: string;
	/** Its transcript. */
	file: string;
	/** "home chat", "Queue #N" or chat "<title>". */
	chat: string;
	/** The depth of the role message this chat is handling now (0 = none). */
	handling: number;
}

export interface RoleMessageSendInput {
	to?: unknown;
	kind?: unknown;
	text?: unknown;
	replyTo?: unknown;
}

export type RoleMessageSendResult =
	{ ok: true; record: RoleMessageRecord; paused: boolean; targetChat: string } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function sha1(text: string): string {
	return createHash("sha1").update(text, "utf8").digest("hex");
}

/** One line, no brackets that would end the header early. */
function oneLine(s: string, max = 80): string {
	const t = String(s ?? "")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[[\]]/g, "")
		.trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Which chat: a queued task's chat ("Queue #N"), the role's home chat, or a chat by its title. */
export function chatLabel(o: { taskId?: number; isHome: boolean; title?: string }): string {
	if (o.taskId !== undefined) return `Queue #${o.taskId}`;
	if (o.isHome) return "home chat";
	const t = oneLine(o.title ?? "", 60).replace(/"/g, "'");
	return t ? `chat "${t}"` : "a chat";
}

type HeaderParts = Pick<RoleMessageRecord, "id" | "from" | "kind" | "replyTo">;

export function roleMessageHeader(r: HeaderParts): string {
	const what = r.kind === "reply" && r.replyTo ? `reply to ${r.replyTo}` : r.kind;
	return `[Role message ${r.id} from ${r.from.role} (${oneLine(r.from.title)}), sent from its ${r.from.chat} · ${what}]`;
}

export function roleMessageHint(r: HeaderParts): string {
	const reply = `message_role with to "${r.from.role}", kind "reply", replyTo "${r.id}"`;
	switch (r.kind) {
		case "fyi":
			return "(An FYI from another role: no reply needed.)";
		case "reply":
			return `(The answer to your message ${r.replyTo ?? ""}: no need to answer it.)`;
		case "question":
			return `(Answer it once, with ${reply}.)`;
		default:
			return `(A request: do it if it is small and in your area, else queue it as a task; then reply once, with ${reply}: done, queued as #N, not your area (and whose it is), or needs the owner.)`;
	}
}

/** The text that goes into the receiving chat. */
export function roleMessageText(r: HeaderParts & { text: string }): string {
	return `${roleMessageHeader(r)}\n\n${r.text}\n\n${roleMessageHint(r)}`;
}

/** The role message id a user message's text starts with (any text: verify it with the store). */
export function roleMessageIdOf(text: string): string | undefined {
	return HEADER_RE.exec(text)?.[1];
}

export function newRoleMessageId(taken: (id: string) => boolean): string {
	for (;;) {
		const id = `rm-${randomBytes(4).toString("hex")}`;
		if (!taken(id)) return id;
	}
}

function backoffMs(attempts: number): number {
	return Math.min(5 * 60_000, 15_000 * 2 ** Math.max(0, attempts - 1));
}

function firstLine(text: string, max = 120): string {
	const line =
		text
			.split("\n")
			.map((l) => l.trim())
			.find(Boolean) ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// ---------------------------------------------------------------------------
// Transcripts on disk
// ---------------------------------------------------------------------------

/** Each line of the transcript (from byte `from`) that holds `needle`, parsed; streamed. */
async function eachLineWith(
	file: string,
	from: number,
	needle: string,
	fn: (entry: unknown) => boolean,
): Promise<void> {
	let fh: FileHandle | undefined;
	try {
		fh = await open(file, "r");
		const decoder = new StringDecoder("utf8");
		const chunk = Buffer.alloc(256 * 1024);
		let carry = "";
		const take = (line: string): boolean => {
			if (!line.includes(needle)) return false;
			try {
				return fn(JSON.parse(line));
			} catch {
				return false;
			}
		};
		for (let pos = Math.max(0, from); ;) {
			const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
			if (!bytesRead) {
				take(carry + decoder.end());
				return;
			}
			pos += bytesRead;
			const lines = (carry + decoder.write(chunk.subarray(0, bytesRead))).split("\n");
			carry = lines.pop() ?? "";
			for (const line of lines) if (take(line)) return;
		}
	} catch {
		// unreadable: nothing found
	} finally {
		await fh?.close().catch(() => {});
	}
}

function userTextOf(entry: unknown): string | undefined {
	const e = entry as { type?: unknown; message?: { role?: unknown; content?: unknown } };
	if (e?.type !== "message" || e.message?.role !== "user") return undefined;
	const c = e.message.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return undefined;
	const first = c.find((b) => (b as { type?: unknown })?.type === "text") as { text?: unknown } | undefined;
	return typeof first?.text === "string" ? first.text : undefined;
}

/** Whether a user message starting with this message's header is in the transcript after `from`. */
export async function transcriptHasRoleMessage(file: string, from: number, id: string): Promise<boolean> {
	const needle = `[Role message ${id} `;
	let found = false;
	await eachLineWith(file, from, needle, (entry) => {
		found = userTextOf(entry)?.startsWith(needle) === true;
		return found;
	});
	return found;
}

/** pi-queue's entries in a transcript (file order). */
export async function queueEntriesOf(file: string): Promise<TaskQueueEntryLike[]> {
	const out: TaskQueueEntryLike[] = [];
	await eachLineWith(file, 0, `"${TASK_QUEUE_ENTRY_TYPE}"`, (entry) => {
		const e = entry as TaskQueueEntryLike;
		if (e?.type === "custom" && e.customType === TASK_QUEUE_ENTRY_TYPE) out.push(e);
		return false;
	});
	return out;
}

/** The task a queued task's chat works on (from its own entries); undefined = not a task's chat. */
export function ownTaskOf(
	entries: Iterable<TaskQueueEntryLike>,
): { id?: number; done: boolean; queueChat?: string } | undefined {
	const q = taskQueueFromEntries(entries, true, Number.POSITIVE_INFINITY);
	if (!q.from) return undefined;
	const own = q.tasks[0];
	return { id: own?.id, done: !own || own.status === "done", queueChat: q.from.file };
}

/** A queued task's chat whose task is done or removed (here or in its queue). Other chats: false. */
export async function taskChatFinished(file: string): Promise<boolean> {
	const own = ownTaskOf(await queueEntriesOf(file));
	if (!own) return false;
	if (own.done || own.id === undefined) return true;
	if (!own.queueChat || !existsSync(own.queueChat)) return false;
	const q = taskQueueFromEntries(await queueEntriesOf(own.queueChat), true, Number.POSITIVE_INFINITY);
	const t = q.tasks.find((x) => x.id === own.id);
	return !t || t.status === "done";
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class RoleMessages {
	private data: StoreFile = { v: FILE_VERSION, paused: false, messages: [] };
	private readonly inFlight = new Map<string, { idleSince?: number }>();
	private timer: ReturnType<typeof setInterval> | null = null;
	/** The look at the waiting messages that is going on now. */
	private running: Promise<void> | null = null;
	private again = false;
	private stopped = false;
	private changeTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly file: string,
		private readonly host: RoleMessageHost,
		private readonly now: () => number = Date.now,
	) {
		this.load();
	}

	private log(line: string): void {
		try {
			(this.host.log ?? ((l: string) => console.log(l)))(`[role-messages] ${line}`);
		} catch {
			// logging never breaks delivery
		}
	}

	private load(): void {
		let raw: string;
		try {
			raw = readFileSync(this.file, "utf8");
		} catch {
			return; // none yet
		}
		try {
			const parsed = JSON.parse(raw) as Partial<StoreFile>;
			this.data = {
				v: FILE_VERSION,
				paused: parsed.paused === true,
				...(typeof parsed.resumedAt === "number" ? { resumedAt: parsed.resumedAt } : {}),
				messages: Array.isArray(parsed.messages) ? parsed.messages.filter((m) => m && typeof m.id === "string") : [],
			};
		} catch (err) {
			// Kept aside, not dropped: the owner can still read it.
			const aside = `${this.file}.bad-${this.now()}`;
			try {
				renameSync(this.file, aside);
			} catch {
				// leave it
			}
			this.log(`couldn't read the store (${(err as Error).message}); kept it as ${aside}`);
		}
	}

	private save(): void {
		const keep = this.data.messages;
		if (keep.length > ROLE_MESSAGES_KEEP) {
			const extra = keep.length - ROLE_MESSAGES_KEEP;
			let dropped = 0;
			this.data.messages = keep.filter((m) => {
				if (dropped < extra && m.state !== "waiting") {
					dropped++;
					return false;
				}
				return true;
			});
		}
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			const tmp = `${this.file}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(this.data));
			renameSync(tmp, this.file);
		} catch (err) {
			this.log(`couldn't save the store: ${(err as Error).message}`);
		}
		this.notify();
	}

	private notify(): void {
		if (!this.host.changed || this.changeTimer) return;
		this.changeTimer = setTimeout(() => {
			this.changeTimer = null;
			try {
				this.host.changed?.();
			} catch {
				// the page's list only
			}
		}, 300);
		this.changeTimer.unref?.();
	}

	byId(id: string): RoleMessageRecord | undefined {
		return this.data.messages.find((m) => m.id === id);
	}

	get paused(): boolean {
		return this.data.paused;
	}

	setPaused(paused: boolean): void {
		if (this.data.paused === paused) return;
		this.data.paused = paused;
		if (!paused) this.data.resumedAt = this.now();
		this.save();
		this.log(paused ? "paused by the owner" : "resumed by the owner");
		if (!paused) this.kick();
	}

	start(): void {
		if (this.timer || this.stopped) return;
		this.timer = setInterval(() => void this.tick(), TICK_MS);
		this.timer.unref?.();
		this.kick();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		if (this.changeTimer) clearTimeout(this.changeTimer);
		this.changeTimer = null;
	}

	kick(): void {
		setTimeout(() => void this.tick(), 0).unref?.();
	}

	/** The depth of the role message a chat is handling, from its last user message (0 = none). */
	handlingDepth(sessionFile: string | undefined, lastUserText: string | undefined): number {
		const r = this.verified(sessionFile, lastUserText ?? "");
		return r ? r.chain : 0;
	}

	/** The record a user message in this chat is, when the store confirms it (same chat, same text). */
	private verified(sessionFile: string | undefined, text: string): RoleMessageRecord | undefined {
		const id = roleMessageIdOf(text);
		if (!id || !sessionFile) return undefined;
		const r = this.byId(id);
		if (!r?.hash || !r.target || !samePath(r.target, sessionFile)) return undefined;
		return sha1(text) === r.hash ? r : undefined;
	}

	/** The page's card for a user message, when it is a role message the store confirms. */
	stampFor(sessionFile: string | undefined, text: string): UiRoleMessage | undefined {
		const r = this.verified(sessionFile, text);
		if (!r) return undefined;
		return {
			id: r.id,
			from: r.from.role,
			fromTitle: r.from.title,
			fromChat: r.from.chat,
			kind: r.kind,
			...(r.replyTo ? { replyTo: r.replyTo } : {}),
			text: r.text,
		};
	}

	/** The last `n` messages, newest first, for Settings → Identities. */
	rows(n = ROLE_MESSAGES_LIST): UiRoleMessageRow[] {
		return this.data.messages
			.slice(-n)
			.reverse()
			.map((m) => ({
				id: m.id,
				at: m.at,
				from: m.from.role,
				fromChat: m.from.chat,
				to: m.to.role,
				...(m.targetChat ? { toChat: m.targetChat } : {}),
				kind: m.kind,
				...(m.replyTo ? { replyTo: m.replyTo } : {}),
				state: m.state === "waiting" && this.data.paused ? "held" : m.state,
				firstLine: firstLine(m.text),
				chain: m.chain,
				...(m.deliveredAt ? { deliveredAt: m.deliveredAt } : {}),
				...(m.error && m.state !== "delivered" && m.state !== "replied" ? { error: m.error } : {}),
			}));
	}

	/** A message_role call that was refused, in the server log (who, to whom, what kind, why; not the text). */
	noteRefused(sender: RoleMessageSender | undefined, to: unknown, kind: unknown, why: string): void {
		const who = sender ? `${sender.role} (${sender.chat})` : "a chat";
		const short = (v: unknown) => String(v ?? "?").slice(0, 40);
		this.log(`refused ${who} -> ${short(to)} · ${short(kind)}: ${why.slice(0, 200)}`);
	}

	/** message_role: check and store a message (the sender is the server's, never the model's). */
	send(sender: RoleMessageSender, input: RoleMessageSendInput): RoleMessageSendResult {
		const kind = typeof input.kind === "string" ? (input.kind.trim().toLowerCase() as RoleMessageKind) : undefined;
		if (!kind || !ROLE_MESSAGE_KINDS.includes(kind)) {
			return { ok: false, error: `kind must be one of: ${ROLE_MESSAGE_KINDS.join(", ")}.` };
		}
		const text = typeof input.text === "string" ? input.text.trim() : "";
		if (!text) return { ok: false, error: "text is empty: say what you need, self-contained (paths, ids)." };
		if (text.length > ROLE_MESSAGE_TEXT_MAX) {
			return {
				ok: false,
				error: `text is ${text.length} characters; the most is ${ROLE_MESSAGE_TEXT_MAX}. Shorten it (point to a file for details).`,
			};
		}
		const roles = this.host.roles();
		const toId = typeof input.to === "string" ? input.to.trim().toLowerCase() : "";
		const to = roles.find((r) => r.id === toId);
		if (!to) {
			const ids = roles.map((r) => r.id).join(", ");
			return { ok: false, error: `There's no role "${toId || String(input.to ?? "")}". Roles: ${ids || "none"}.` };
		}
		const replyTo = typeof input.replyTo === "string" ? input.replyTo.trim() : "";
		let original: RoleMessageRecord | undefined;
		if (kind === "reply") {
			if (!replyTo) return { ok: false, error: "kind reply needs replyTo: the id of the message you answer (rm-…)." };
			original = this.byId(replyTo);
			if (!original) return { ok: false, error: `There's no message ${replyTo} to reply to.` };
			if (original.kind !== "question" && original.kind !== "request") {
				return {
					ok: false,
					error: `${replyTo} is ${original.kind === "fyi" ? "an FYI" : "a reply"}: it needs no reply.`,
				};
			}
			if (original.to.role !== sender.role) {
				return { ok: false, error: `${replyTo} was sent to ${original.to.role}, not to you (${sender.role}).` };
			}
			if (original.from.role !== to.id) {
				return {
					ok: false,
					error: `${replyTo} came from ${original.from.role}: send the reply to "${original.from.role}".`,
				};
			}
			if (original.replyId) {
				return {
					ok: false,
					error: `You already replied to ${replyTo} (${original.replyId}). For news since, send an fyi.`,
				};
			}
		} else {
			if (replyTo) return { ok: false, error: `replyTo is only for kind "reply".` };
			if (!to.homeChat) {
				return {
					ok: false,
					error: `${to.id} has no home chat yet, so it can't get messages. Ask the owner to give it one.`,
				};
			}
			if (samePath(to.homeChat, sender.file)) {
				return { ok: false, error: `This chat is ${to.id}'s home chat: that's you.` };
			}
		}
		const chain = sender.handling > 0 ? sender.handling + 1 : 1;
		if (chain > ROLE_MESSAGE_CHAIN_MAX) {
			return {
				ok: false,
				error: `Not sent: this would be message ${chain} in one chain of role messages (the limit is ${ROLE_MESSAGE_CHAIN_MAX}). Stop the back-and-forth and ask the owner how to go on.`,
			};
		}
		const now = this.now();
		const lastHour = this.data.messages.filter((m) => m.from.role === sender.role && now - m.at < HOUR_MS).length;
		if (lastHour >= ROLE_MESSAGES_PER_HOUR) {
			return {
				ok: false,
				error: `Not sent: ${sender.role} has sent ${lastHour} role messages in the last hour (the limit is ${ROLE_MESSAGES_PER_HOUR}). Ask the owner before sending more.`,
			};
		}
		const record: RoleMessageRecord = {
			id: newRoleMessageId((id) => !!this.byId(id)),
			at: now,
			from: { role: sender.role, title: sender.title, chat: sender.chat, file: sender.file },
			to: { role: to.id, title: to.title },
			kind,
			...(kind === "reply" ? { replyTo } : {}),
			chain,
			text,
			state: "waiting",
			sends: 0,
			attempts: 0,
		};
		this.data.messages.push(record);
		if (original) {
			original.replyId = record.id;
			// A delivered message is answered now; one not yet seen in its chat becomes "replied" once it is
			// (step), so it is still delivered and gets its time.
			if (original.state === "delivered") original.state = "replied";
		}
		this.save();
		this.log(
			`${record.id} ${sender.role} (${sender.chat}) -> ${to.id} · ${kind}${replyTo ? ` to ${replyTo}` : ""}, chain ${chain}`,
		);
		this.kick();
		const targetChat =
			kind === "reply" && original
				? `the chat that asked (${original.from.chat}), else its home chat`
				: "its home chat";
		return { ok: true, record, paused: this.data.paused, targetChat };
	}

	/** Look at every waiting message once, one at a time. A call while that goes on makes it look once
	 *  more after it, and resolves when it is all done. */
	tick(): Promise<void> {
		if (this.running) {
			this.again = true;
			return this.running;
		}
		this.running = (async () => {
			// Never finish before `running` is set: with nothing to wait on (paused, nothing waiting) the body
			// would run to its end at once, clear `running` first, and leave it set for good (no more ticks).
			await Promise.resolve();
			try {
				do {
					this.again = false;
					if (this.data.paused || this.stopped) break;
					for (const r of this.data.messages.filter((m) => m.state === "waiting")) {
						if (this.data.paused || this.stopped) break;
						try {
							await this.step(r);
						} catch (err) {
							this.log(`${r.id}: ${(err as Error).message}`);
						}
					}
				} while (this.again && !this.stopped);
			} finally {
				this.running = null;
			}
		})();
		return this.running;
	}

	private fail(r: RoleMessageRecord, error: string): void {
		r.state = "failed";
		r.error = error;
		this.inFlight.delete(r.id);
		this.save();
		this.log(`${r.id} failed: ${error}`);
	}

	/** Where a message goes: the reply's asking chat (if still there and not a finished task's), else
	 *  the receiving role's home chat. */
	private async route(r: RoleMessageRecord): Promise<{ file: string; label: string } | { error: string }> {
		if (r.kind === "reply" && r.replyTo) {
			const asked = this.byId(r.replyTo)?.from;
			if (asked?.file && existsSync(asked.file) && !(await taskChatFinished(asked.file))) {
				return { file: asked.file, label: asked.chat };
			}
		}
		const role = this.host.roles().find((x) => x.id === r.to.role);
		if (!role) return { error: `the role ${r.to.role} is gone` };
		if (!role.homeChat) return { error: `${r.to.role} has no home chat` };
		if (!existsSync(role.homeChat)) return { error: `${r.to.role}'s home chat transcript is missing` };
		return { file: role.homeChat, label: "home chat" };
	}

	private async step(r: RoleMessageRecord): Promise<void> {
		const now = this.now();
		// Held while paused doesn't count: a held message gets a fresh day from the resume.
		if (now - Math.max(r.at, this.data.resumedAt ?? 0) > GIVE_UP_MS) {
			this.fail(r, r.error ? `not delivered within a day (last error: ${r.error})` : "not delivered within a day");
			return;
		}
		if (r.nextTryAt && now < r.nextTryAt) return;
		const text = roleMessageText(r);
		if (!r.target || !existsSync(r.target)) {
			const route = await this.route(r);
			if ("error" in route) {
				this.fail(r, route.error);
				return;
			}
			let size = 0;
			try {
				size = statSync(route.file).size;
			} catch {
				size = 0;
			}
			r.target = route.file;
			r.targetChat = route.label;
			r.scanFrom = size;
			r.hash = sha1(text);
			this.inFlight.delete(r.id);
			this.save();
		}
		const target = r.target;
		if (await transcriptHasRoleMessage(target, r.scanFrom ?? 0, r.id)) {
			// Answered while on its way (the chat took it and replied before this look): "replied".
			r.state = r.replyId ? "replied" : "delivered";
			r.deliveredAt = now;
			delete r.nextTryAt;
			this.inFlight.delete(r.id);
			this.save();
			this.log(`${r.id} delivered to ${r.to.role} (${r.targetChat ?? "?"})`);
			return;
		}
		const state = this.host.chatState(target);
		const flight = this.inFlight.get(r.id);
		if (flight) {
			// It got in: it lands when the chat takes it (after its running turn).
			if (state === "working") {
				delete flight.idleSince;
				return;
			}
			flight.idleSince ??= now;
			if (now - flight.idleSince < SETTLE_MS) return;
			this.inFlight.delete(r.id); // the chat went idle without it: send it again
			this.log(`${r.id} got in but never landed; sending again`);
		}
		if (state === "working") return; // after its turn
		if (r.sends >= MAX_SENDS) {
			this.fail(r, `sent ${r.sends} times but it never landed in the chat`);
			return;
		}
		const res = await this.host.deliver(target, text);
		if (res.ok) {
			r.sends++;
			delete r.error;
			delete r.nextTryAt;
			this.inFlight.set(r.id, {});
			this.save();
			this.again = true; // look for it soon
			return;
		}
		if (res.busy) return;
		r.attempts++;
		r.error = res.error;
		r.nextTryAt = now + backoffMs(r.attempts);
		this.save();
		this.log(`${r.id} not delivered yet (${res.error}); next try in ${Math.round(backoffMs(r.attempts) / 1000)}s`);
	}
}
