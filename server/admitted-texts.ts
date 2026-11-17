/**
 * admitted-texts: texts admission took into a chat, waiting for the user message pi writes for them,
 * so a lasting session custom entry can name that message's entry. Shared by owner-input-mark (Ops #945)
 * and sent-by-mark (Ops #972).
 *
 * pi persists a user message right after its listeners see `message_end`
 * (AgentSession._handleAgentEvent), so the entry is written in a microtask. A run's end drops texts no
 * longer in pi's queue (removed, cleared, refused). A text matches a message only when the stored words
 * equal the admitted words: an add-on that rewrote them wrote words nobody typed.
 */

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

/** At most this many texts wait for their message in one chat (a queue filled while it ran). */
const PENDING_MAX = 32;
/** How far back from the end of the transcript the just-written user message is looked for. */
export const ENTRY_LOOKBACK = 64;

/** One chat's admitted texts that pi hasn't written as a user message yet. */
export class AdmittedTexts<T extends { text: string }> {
	private readonly waiting: T[] = [];

	admitted(item: T): void {
		if (!item.text) return;
		this.waiting.push(item);
		if (this.waiting.length > PENDING_MAX) this.waiting.shift();
	}

	/** The admitted text this user message carries, taken off the list; undefined = none. */
	take(message: unknown): T | undefined {
		const text = userMessageText(message);
		if (text === undefined) return undefined;
		const i = this.waiting.findIndex((w) => w.text === text);
		return i < 0 ? undefined : this.waiting.splice(i, 1)[0];
	}

	/** The run ended: a text no longer in pi's queue never became a message. */
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

/** The part of a pi session a mark needs (SessionManager). */
export interface MarkSessionManager {
	getEntries(): readonly unknown[];
	appendCustomEntry(customType: string, data?: unknown): string;
}

/** The part of a chat a mark needs (agent-service Conversation). */
export interface MarkChat {
	readonly session: {
		sessionManager: MarkSessionManager;
		getSteeringMessages?(): readonly string[];
		getFollowUpMessages?(): readonly string[];
	};
}

/** The id of the entry pi wrote for exactly this message object (looked for near the end). */
export function userEntryIdOf(entries: readonly unknown[], message: unknown): string | undefined {
	for (let i = entries.length - 1; i >= Math.max(0, entries.length - ENTRY_LOOKBACK); i--) {
		const e = entries[i] as { type?: unknown; id?: unknown; message?: unknown };
		if (e?.type === "message" && e.message === message && typeof e.id === "string") return e.id;
	}
	return undefined;
}

/**
 * Drive one chat's waiting texts from its SDK events: a user message that ends carrying one gets
 * `write` in a microtask (after pi persisted it); a run that ends drops texts that never became a
 * message. Never throws (pi's run loop doesn't catch listener errors).
 */
export function admittedTextsOnEvent<T extends { text: string }>(
	chat: MarkChat,
	waiting: AdmittedTexts<T> | undefined,
	event: { type: string; message?: unknown },
	write: (sm: MarkSessionManager, message: unknown, item: T) => void,
	tag: string,
): void {
	const logFailure = (err: unknown) =>
		console.error(`[${tag}] couldn't mark the message: ${(err as Error)?.message ?? err}`);
	try {
		if (!waiting?.size) return;
		if (event.type === "message_end") {
			const item = waiting.take(event.message);
			if (!item) return;
			const sm = chat.session.sessionManager;
			const message = event.message;
			queueMicrotask(() => {
				try {
					write(sm, message, item);
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
