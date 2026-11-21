/**
 * sent-by (Ops #972): who typed each web message, kept on the message and shown to the model.
 *
 * Admission notes each typed web text whose request carried a Tailscale identity (sent-by.ts,
 * agent-service noteTurnCause). When pi delivers that text as a user message (`message_start`, before
 * pi writes it to the transcript), the message gets `sentBy: {login, name, owner}`, so the session
 * file keeps it. Then, by code and the same way every time (owner 2026-11-16: "append it
 * deterministically"):
 * - the model sees the message starting with one line `[From: <name>]` (withSenderLines, run on pi's
 *   `context` event before every model call, so it holds after restarts too);
 * - the page's message header shows `<name>` in place of "You" (serialize.ts copies `sentBy` onto the
 *   UiMessage; web/src/message-role-label.ts, Ops #1052).
 * The words pi stores and its input hooks, queue and owner-question answers see stay exactly as typed.
 * No Tailscale identity = no `sentBy`, no line, no label: as before. A slash command gets nothing.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AdmittedTexts } from "./admitted-texts.js";
import { type SentBy, sentByName } from "./sent-by.js";

export type { SentBy };

interface AdmittedSentBy {
	text: string;
	sentBy: SentBy;
}

/** A chat as this needs it (agent-service Conversation). */
export interface SentByChat {
	readonly session: {
		getSteeringMessages?(): readonly string[];
		getFollowUpMessages?(): readonly string[];
	};
}

const waitingByChat = new WeakMap<SentByChat, AdmittedTexts<AdmittedSentBy>>();

const isCommand = (text: string) => text.trimStart().startsWith("/");

/** Admission handed pi a text with a sender in this chat (agent-service noteTurnCause). */
export function noteSentByText(chat: SentByChat, text: string, sentBy: SentBy | undefined): void {
	if (!sentBy || isCommand(text)) return;
	let waiting = waitingByChat.get(chat);
	if (!waiting) waitingByChat.set(chat, (waiting = new AdmittedTexts<AdmittedSentBy>()));
	waiting.admitted({ text, sentBy });
}

/** A message's sender when it carries a well-formed one, else undefined. */
export function sentByOf(message: unknown): SentBy | undefined {
	if (!message || typeof message !== "object") return undefined;
	const m = message as { role?: unknown; sentBy?: unknown };
	if (m.role !== "user" || !m.sentBy || typeof m.sentBy !== "object") return undefined;
	const s = m.sentBy as Record<string, unknown>;
	if (typeof s.login !== "string" || typeof s.name !== "string") return undefined;
	const name = sentByName(s.name);
	if (!s.login || !name) return undefined;
	return { login: s.login, name, owner: s.owner === true };
}

/**
 * The chat's SDK event (agent-service onEvent): a user message that starts carrying a noted text gets
 * its `sentBy`, and `tagged` drops a display copy of it built before. A run's end drops texts no longer
 * in pi's queue. Never throws (pi's run loop doesn't catch listener errors).
 */
export function sentByOnEvent(
	chat: SentByChat,
	event: { type: string; message?: unknown },
	tagged: (message: object) => void,
): void {
	try {
		const waiting = waitingByChat.get(chat);
		if (!waiting?.size) return;
		if (event.type === "message_start") {
			const item = waiting.take(event.message);
			if (!item) return;
			const { login, name, owner } = item.sentBy;
			(event.message as { sentBy?: SentBy }).sentBy = { login, name, owner };
			tagged(event.message as object);
			return;
		}
		if (event.type === "agent_end") {
			const s = chat.session;
			waiting.keepOnly([...(s.getSteeringMessages?.() ?? []), ...(s.getFollowUpMessages?.() ?? [])]);
		}
	} catch (err) {
		console.error(`[sent-by] couldn't tag the message: ${(err as Error)?.message ?? err}`);
	}
}

/** The line the model sees first in a message `name` sent. */
export function senderLine(name: string): string {
	return `[From: ${sentByName(name)}]`;
}

/**
 * pi's `context` event: each user message with a sender starts with its line, and loses the `sentBy`
 * field (only the line reaches the model). Returns undefined when no message has a sender.
 */
export function withSenderLines<T>(messages: readonly T[]): T[] | undefined {
	let changed = false;
	const out = messages.map((message) => {
		const who = sentByOf(message);
		if (!who) return message;
		changed = true;
		const { sentBy: _drop, ...rest } = message as T & { sentBy?: unknown; content?: unknown };
		const line = senderLine(who.name);
		const content = rest.content;
		if (typeof content === "string") return { ...rest, content: content ? `${line}\n${content}` : line } as T;
		if (!Array.isArray(content)) return { ...rest, content: [{ type: "text", text: line }] } as T;
		const first = content[0] as { type?: unknown; text?: unknown } | undefined;
		const parts =
			first?.type === "text" && typeof first.text === "string"
				? [{ ...first, text: first.text ? `${line}\n${first.text}` : line }, ...content.slice(1)]
				: [{ type: "text", text: line }, ...content];
		return { ...rest, content: parts } as T;
	});
	return changed ? out : undefined;
}

/** The hidden extension (agent-service extensionFactories) that shows the model the sender lines. */
export function sentByExtension(pi: ExtensionAPI): void {
	pi.on("context", (event) => {
		const messages = withSenderLines(event.messages);
		return messages ? { messages } : undefined;
	});
}
