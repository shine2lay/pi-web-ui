/**
 * nonblocking-ask durability (Ops #1088, QA #243 D1): when a question's wake is really in its chat.
 *
 * Role delivery says ok once pi has the wake (the prompt's ack), but behind a busy turn that is only pi's in-memory
 * follow-up queue: a restart or crash then lost the owner's answer (QA rm-49dc1076). So a card stays "delivering" on
 * disk until its wake is a user message in the chat's transcript:
 * - in this process: `expectWake` before the wake is sent, `questionWakeOnEvent` on every chat event; pi writes a
 *   user message to the transcript right after its listeners see `message_end` (admitted-texts.ts), so the wait ends
 *   a microtask later;
 * - at start-up (or after a crash between that write and the card leaving the file): `wakeInTranscript` reads the
 *   transcript, so a wake already there is never sent twice.
 */
import { readFileSync } from "node:fs";
import { userMessageText } from "./admitted-texts.js";
import {
	type ChatDeliveryResult,
	type PendingQuestionsHost,
	PendingQuestionsStore,
	type QuestionWake,
} from "./pending-questions-store.js";

/** How a wake is sent into its chat (agent-service sendRoleMessage): as the owner's message, and `admitted` once it is
 *  in the transcript. */
export type WakeSend = (
	file: string,
	text: string,
	how: Pick<QuestionWake, "cause" | "ownerChannel" | "requester" | "sentBy"> & { awaitTranscript: true },
) => Promise<ChatDeliveryResult>;

/** The cards on disk in `dataDir` and their wakes' way in (nonblocking-ask, Ops #1087; AgentService sets it). */
export function questionWakeHost(dataDir: string, send: WakeSend): PendingQuestionsHost {
	return {
		store: PendingQuestionsStore.inDataDir(dataDir),
		deliver: async (wake) => {
			if (!wake.sessionFile) return { ok: false, error: "the asking chat has no transcript" };
			const { cause, ownerChannel, requester, sentBy } = wake;
			return send(wake.sessionFile, wake.text, {
				cause,
				ownerChannel,
				requester,
				...(sentBy ? { sentBy } : {}),
				awaitTranscript: true,
			});
		},
	};
}

/** A chat whose events this watches (agent-service's Conversation, a test's stand-in). */
export type WakeChat = object;

interface WakeWaiting {
	text: string;
	done: () => void;
}

const waitingByChat = new WeakMap<WakeChat, WakeWaiting[]>();

/** One wake's wait: `admitted` resolves once its user message is written; `cancel` when the send was refused. */
export interface WakeAdmission {
	admitted: Promise<void>;
	cancel(): void;
}

/** Watch this chat for the wake's user message (call before sending it: an idle chat takes it at once). */
export function expectWake(chat: WakeChat, text: string): WakeAdmission {
	const list = waitingByChat.get(chat) ?? [];
	waitingByChat.set(chat, list);
	let item!: WakeWaiting;
	const admitted = new Promise<void>((resolve) => {
		item = { text, done: resolve };
	});
	list.push(item);
	const remove = () => {
		const i = list.indexOf(item);
		if (i >= 0) list.splice(i, 1);
	};
	return { admitted, cancel: remove };
}

/** agent-service onEvent: a user message carrying a watched wake ends its wait once pi has written it. Never throws. */
export function questionWakeOnEvent(chat: WakeChat, event: { type: string; message?: unknown }): void {
	if (event.type !== "message_end") return;
	const list = waitingByChat.get(chat);
	if (!list?.length) return;
	const text = userMessageText(event.message);
	if (text === undefined) return;
	const i = list.findIndex((w) => text.includes(w.text));
	if (i < 0) return;
	const [item] = list.splice(i, 1);
	queueMicrotask(() => item!.done());
}

/** The transcript already holds this wake as a user message written at or after `since` (the card's settledAt; a
 *  cancel's words repeat across cards). A missing or unreadable transcript holds none. */
export function wakeInTranscript(sessionFile: string, text: string, since: number): boolean {
	let body: string;
	try {
		body = readFileSync(sessionFile, "utf8");
	} catch {
		return false;
	}
	const lines = body.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!;
		if (!line.includes('"user"')) continue;
		let entry: { type?: unknown; timestamp?: unknown; message?: unknown };
		try {
			entry = JSON.parse(line) as typeof entry;
		} catch {
			continue; // a torn last line (a crash mid-write) is not a message
		}
		if (entry.type !== "message") continue;
		const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
		if (!(at >= since)) continue;
		if (userMessageText(entry.message)?.includes(text)) return true;
	}
	return false;
}
