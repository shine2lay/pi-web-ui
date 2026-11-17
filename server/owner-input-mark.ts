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
 * The waiting and matching are admitted-texts.ts's (shared with sent-by-mark).
 *
 * Known limit: a process running as the same OS user can write any file. The mark proves "the server
 * accepted this as owner input", the bar Security set (contract v2 §3.2 R-V2-PROV-1, D3).
 */
import { createHash } from "node:crypto";
import {
	AdmittedTexts,
	admittedTextsOnEvent,
	ENTRY_LOOKBACK,
	type MarkChat,
	type MarkSessionManager,
	userEntryIdOf,
	userMessageText,
} from "./admitted-texts.js";

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

export interface AdmittedOwnerText {
	text: string;
	channel: OwnerInputChannel;
	at: number;
}

/** One chat's owner texts admission took that pi hasn't written as a user message yet. */
export class OwnerInputsWaiting extends AdmittedTexts<AdmittedOwnerText> {}

/** Each open chat's waiting owner texts; a closed chat's go with it. */
const waitingByChat = new WeakMap<MarkChat, OwnerInputsWaiting>();

/** Admission took an owner text into this chat (agent-service noteTurnCause). */
export function noteOwnerText(chat: MarkChat, text: string, channel: OwnerInputChannel, at = Date.now()): void {
	let waiting = waitingByChat.get(chat);
	if (!waiting) waitingByChat.set(chat, (waiting = new OwnerInputsWaiting()));
	waiting.admitted({ text, channel, at });
}

/** Append the mark for `message` once pi has written it; returns the mark's entry id, or undefined. */
export function markOwnerEntry(
	sm: MarkSessionManager,
	message: unknown,
	admitted: AdmittedOwnerText,
): string | undefined {
	const entries = sm.getEntries();
	const entryId = userEntryIdOf(entries, message);
	if (!entryId) return undefined;
	const text = userMessageText(message);
	if (text === undefined || text !== admitted.text) return undefined;
	if (ownerInputMarksIn(entries.slice(-ENTRY_LOOKBACK)).has(entryId)) return undefined;
	const mark: OwnerInputMark = {
		v: 1,
		entryId,
		at: admitted.at,
		channel: admitted.channel,
		textSha256: ownerTextSha256(text),
	};
	return sm.appendCustomEntry(OWNER_INPUT_MARK, mark);
}

/** The chat's SDK event (agent-service onEvent): see admittedTextsOnEvent. Never throws. */
export function ownerInputMarkOnEvent(chat: MarkChat, event: { type: string; message?: unknown }): void {
	admittedTextsOnEvent(chat, waitingByChat.get(chat), event, markOwnerEntry, "owner-input-mark");
}
