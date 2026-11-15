/**
 * owner-input-mark (Ops #945, OpenViking v2 V-8): a lasting mark on each chat message the owner typed.
 *
 * Admission (agent-service.ts noteTurnCause) notes each text it takes whose requester is the owner: a
 * real browser page or Telegram, the same test owner-input-time.ts uses. Once pi has written that
 * text's user message to the transcript, the host appends one session custom entry
 * `pi-web-ui/owner-input` naming the entry. Custom entries never reach the model and live in the
 * session file, so the mark survives a restart, a compaction and a fold. pi-openviking's
 * verifyOwnerProvenance reads it to accept `<session-file>#<entry-id>` as the owner's own words.
 *
 * Only a text whose stored words equal the words admitted is marked: an add-on that rewrote his text
 * (an input hook's transform, a template) wrote words he didn't type. Role messages, queue texts,
 * script notices, carry-on notes and a role's answer for the owner never have the owner as requester,
 * so they are never noted. Old messages get no mark: nothing proves who typed them.
 *
 * Known limit: a process running as the same OS user can write any file. The mark proves "the server
 * accepted this as owner input", the bar Security set (contract v2 §3.2 R-V2-PROV-1, D3).
 */
import { createHash } from "node:crypto";

export const OWNER_INPUT_MARK = "pi-web-ui/owner-input";
export type OwnerInputChannel = "browser" | "telegram";

export interface OwnerInputMark {
	v: 1;
	/** The id of the user message entry it marks. */
	entryId: string;
	/** The host's time (ms) admission took the text. */
	at: number;
	channel: OwnerInputChannel;
	/** sha256 (hex) of the entry's text after Unicode NFC (userMessageText). */
	textSha256: string;
}

/** The words of a user message as stored: its string content, or its text parts joined by "\n". */
export function userMessageText(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const m = message as { role?: unknown; content?: unknown };
	if (m.role !== "user") return undefined;
	if (typeof m.content === "string") return m.content;
	if (!Array.isArray(m.content)) return undefined;
	const parts = m.content
		.filter((p): p is { type: "text"; text: string } => !!p && p.type === "text" && typeof p.text === "string")
		.map((p) => p.text);
	return parts.length ? parts.join("\n") : undefined;
}

export function ownerTextSha256(text: string): string {
	return createHash("sha256").update(text.normalize("NFC"), "utf8").digest("hex");
}

const ENTRY_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

/** A custom entry's data when it is a well-formed mark, else undefined. */
export function ownerInputMarkOf(data: unknown): OwnerInputMark | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const d = data as Record<string, unknown>;
	if (d.v !== 1 || typeof d.entryId !== "string" || !ENTRY_ID.test(d.entryId)) return undefined;
	if (typeof d.at !== "number" || !Number.isFinite(d.at) || d.at <= 0) return undefined;
	if (d.channel !== "browser" && d.channel !== "telegram") return undefined;
	if (typeof d.textSha256 !== "string" || !SHA256.test(d.textSha256)) return undefined;
	return { v: 1, entryId: d.entryId, at: d.at, channel: d.channel, textSha256: d.textSha256 };
}

/** Every mark in a transcript's entries, by the entry id it names (the first mark of an entry counts). */
export function ownerInputMarksIn(entries: readonly unknown[]): Map<string, OwnerInputMark> {
	const marks = new Map<string, OwnerInputMark>();
	for (const e of entries) {
		const entry = e as { type?: unknown; customType?: unknown; data?: unknown } | null;
		if (entry?.type !== "custom" || entry.customType !== OWNER_INPUT_MARK) continue;
		const mark = ownerInputMarkOf(entry.data);
		if (mark && !marks.has(mark.entryId)) marks.set(mark.entryId, mark);
	}
	return marks;
}

interface AdmittedOwnerText {
	text: string;
	channel: OwnerInputChannel;
	at: number;
}

/** At most this many owner texts wait for their message in one chat (a queue he filled while it ran). */
const PENDING_MAX = 32;
/** How far back from the end of the transcript the just-written user message is looked for. */
const ENTRY_LOOKBACK = 64;

/** The part of a pi session the mark needs (SessionManager). */
export interface MarkSessionManager {
	getEntries(): readonly unknown[];
	appendCustomEntry(customType: string, data?: unknown): string;
}

/** The part of a chat the mark needs (agent-service Conversation). */
export interface OwnerMarkChat {
	readonly session: {
		sessionManager: MarkSessionManager;
		getSteeringMessages?(): readonly string[];
		getFollowUpMessages?(): readonly string[];
	};
}

/** One chat's owner texts admission took that pi hasn't written as a user message yet. */
export class OwnerInputsWaiting {
	private readonly waiting: AdmittedOwnerText[] = [];

	admitted(text: string, channel: OwnerInputChannel, at: number): void {
		if (!text) return;
		this.waiting.push({ text, channel, at });
		if (this.waiting.length > PENDING_MAX) this.waiting.shift();
	}

	/** The admitted owner text this user message carries, taken off the list; undefined = not his. */
	take(message: unknown): AdmittedOwnerText | undefined {
		const text = userMessageText(message);
		if (text === undefined) return undefined;
		const i = this.waiting.findIndex((w) => w.text === text);
		return i < 0 ? undefined : this.waiting.splice(i, 1)[0];
	}

	/** The run ended: a text no longer in pi's queue never became a message (removed, cleared, refused). */
	keepOnly(stillQueued: readonly string[]): void {
		const queued = [...stillQueued];
		for (let i = this.waiting.length - 1; i >= 0; i--) {
			const at = queued.indexOf(this.waiting[i]!.text);
			if (at < 0) this.waiting.splice(i, 1);
			else queued.splice(at, 1);
		}
	}

	get size(): number {
		return this.waiting.length;
	}
}

/** Each open chat's waiting owner texts; a closed chat's go with it. */
const waitingByChat = new WeakMap<OwnerMarkChat, OwnerInputsWaiting>();

/** Admission took an owner text into this chat (agent-service noteTurnCause). */
export function noteOwnerText(chat: OwnerMarkChat, text: string, channel: OwnerInputChannel, at = Date.now()): void {
	let waiting = waitingByChat.get(chat);
	if (!waiting) waitingByChat.set(chat, (waiting = new OwnerInputsWaiting()));
	waiting.admitted(text, channel, at);
}

/** Append the mark for `message` once pi has written it; returns the mark's entry id, or undefined. */
export function markOwnerEntry(
	sm: MarkSessionManager,
	message: unknown,
	admitted: AdmittedOwnerText,
): string | undefined {
	const entries = sm.getEntries();
	let entry: { id: string; message: unknown } | undefined;
	for (let i = entries.length - 1; i >= Math.max(0, entries.length - ENTRY_LOOKBACK); i--) {
		const e = entries[i] as { type?: unknown; id?: unknown; message?: unknown };
		if (e?.type === "message" && e.message === message && typeof e.id === "string") {
			entry = { id: e.id, message: e.message };
			break;
		}
	}
	if (!entry) return undefined;
	const text = userMessageText(entry.message);
	if (text === undefined || text !== admitted.text) return undefined;
	if (ownerInputMarksIn(entries.slice(-ENTRY_LOOKBACK)).has(entry.id)) return undefined;
	const mark: OwnerInputMark = {
		v: 1,
		entryId: entry.id,
		at: admitted.at,
		channel: admitted.channel,
		textSha256: ownerTextSha256(text),
	};
	return sm.appendCustomEntry(OWNER_INPUT_MARK, mark);
}

/**
 * The chat's SDK event (agent-service onEvent). A user message that ends carries an admitted owner
 * text: pi persists it right after its listeners return (AgentSession._handleAgentEvent), so the mark
 * goes on in a microtask. A run that ends drops texts that never became a message. Never throws
 * (pi's run loop doesn't catch listener errors).
 */
export function ownerInputMarkOnEvent(chat: OwnerMarkChat, event: { type: string; message?: unknown }): void {
	const logFailure = (err: unknown) =>
		console.error(`[owner-input-mark] couldn't mark the owner's message: ${(err as Error)?.message ?? err}`);
	try {
		const waiting = waitingByChat.get(chat);
		if (!waiting?.size) return;
		if (event.type === "message_end") {
			const admitted = waiting.take(event.message);
			if (!admitted) return;
			const sm = chat.session.sessionManager;
			const message = event.message;
			queueMicrotask(() => {
				try {
					markOwnerEntry(sm, message, admitted);
				} catch (err) {
					logFailure(err);
				}
			});
		} else if (event.type === "agent_end") {
			const s = chat.session;
			waiting.keepOnly([...(s.getSteeringMessages?.() ?? []), ...(s.getFollowUpMessages?.() ?? [])]);
		}
	} catch (err) {
		logFailure(err);
	}
}
