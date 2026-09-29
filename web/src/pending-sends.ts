/**
 * optimistic-send: the messages this window has sent that the server hasn't confirmed yet.
 *
 * Pressing Send draws the message at once, faded with "Sending…", instead of waiting for the
 * server's copy (pi runs every add-on's "before the AI starts" step first, which can take
 * seconds). The server answers each send with one `prompt_ack` (see server/prompt-ack.ts):
 *
 *  - ok: the message is in the chat (or in its waiting queue). Its snapshot went out first, so
 *    the faded copy usually goes in the same step that draws the server's copy (see
 *    `reconcilePending`: a copy is dropped as soon as a snapshot shows the message).
 *  - not ok: the message did not reach the chat. It stays, marked "Not sent", with Retry and ×.
 *
 * After a reconnect or a reload the window asks the server about the sends it still shows as
 * "Sending" (`prompt_status`), and a snapshot that shows the message drops the copy either way.
 *
 * Pure functions only (unit-tested in tests/unit/pending-sends.test.ts); use-chat.ts keeps the
 * list and MessageList.tsx draws it.
 */
import type { PromptAttachment, UiMessage, UiState } from "./types";
import { randomUuid } from "./uuid";

/** The id a window gives a message it sends (`prompt.id`). */
export function newPromptId(): string {
	return `p-${randomUuid()}`;
}

export interface PendingSend {
	/** The id sent with the prompt; the server's `prompt_ack` carries it back. */
	id: string;
	/** The chat it was sent to (the one the window showed). */
	conversationId: string;
	/** That chat's pi session. Chat ids are numbered afresh when the server restarts; the session
	 *  stays the same, so after a restart the copy still goes with the right chat. */
	sessionId?: string;
	/** Exactly the text that was sent (may be empty when only pictures or files were sent). */
	text: string;
	/** What was sent along with it (kept for Retry and for ×, which puts it back). */
	attachments?: PromptAttachment[];
	/** The `queue` flag it was sent with (queued until the whole run ends, instead of steering). */
	queue: boolean;
	createdAt: number;
	status: "sending" | "failed";
	/** Why it failed (English, from the server). */
	reason?: string;
	/** The last message of the chat when it was sent: its copy is a user message AFTER this one. */
	anchorId?: string;
	/** User messages with the same text that were already there (used when the anchor is gone). */
	sameTextBefore: string[];
	/** How many times the same text was already waiting in the chat's queue. */
	queueBase: number;
	/** The AI was working when it was sent, so it joins the queue. Otherwise it starts the next run. */
	whileWorking?: boolean;
	/** The server confirmed it with a snapshot this window hasn't got yet (that one was dropped under
	 *  backpressure): the copy stays until a snapshot at least this new has arrived. */
	confirmedRev?: number;
	/** The connection dropped (or the page reloaded) before the answer: ask the server again. */
	needsCheck?: boolean;
}

/** What `prompt_ack` brings (see server/protocol.ts). */
export interface PromptAckInfo {
	id: string;
	conversationId: string;
	ok: boolean;
	reason?: string;
	rev?: number;
}

/** Is this entry for the chat `state` shows? By its pi session when both know it (the same after a
 *  server restart, which numbers chats afresh), else by the chat id. */
export function sameChat(
	p: Pick<PendingSend, "conversationId" | "sessionId">,
	state: { conversationId: string; sessionId?: string },
): boolean {
	if (p.sessionId && state.sessionId) return p.sessionId === state.sessionId;
	// chat-open-speed: a message written into a chat that was still opening has no chat id yet
	// (only its session), so an empty id must never stand for "the same chat".
	return !!p.conversationId && p.conversationId === state.conversationId;
}

/** A text is a slash command (runs a command instead of chatting): it gets no faded copy. */
export function isSlashText(text: string): boolean {
	return text.trimStart().startsWith("/");
}

/** The form texts are compared in (the server keeps what was sent; this only evens out line ends). */
export function normalizeSentText(text: string): string {
	return text.replace(/\r\n?/g, "\n").trim();
}

/** The marker the server puts after a text block it cut short (server/serialize.ts). */
const TRUNCATED_SUFFIX = "\n\n… [truncated]";

/** Does this chat message show the given (normalized) text as a user message? */
export function userMessageShows(m: UiMessage, text: string): boolean {
	if (m.role !== "user") return false;
	const blocks = m.content.filter(
		(b): b is Extract<UiMessage["content"][number], { type: "text" }> => b.type === "text",
	);
	if (blocks.length === 0) return text === "";
	if (blocks.some((b) => b.truncated)) {
		const shown = blocks.map((b) =>
			b.truncated && b.text.endsWith(TRUNCATED_SUFFIX) ? b.text.slice(0, -TRUNCATED_SUFFIX.length) : b.text,
		);
		const head = normalizeSentText(shown.join(""));
		return head.length > 0 && text.startsWith(head);
	}
	const shown = normalizeSentText(blocks.map((b) => b.text).join(""));
	if (shown === text || normalizeSentText(blocks.map((b) => b.text).join("\n")) === text) return true;
	// pi adds a note after the text when it resized a picture ("\n\n[...]"), and a message of only
	// pictures then has only that note.
	return m.content.some((b) => b.type === "image") && (text === "" || shown.startsWith(`${text}\n\n`));
}

function queueCount(state: UiState, text: string): number {
	let n = 0;
	for (const q of [...(state.queue?.steering ?? []), ...(state.queue?.followUp ?? [])]) {
		if (normalizeSentText(q) === text) n++;
	}
	return n;
}

/** A new "Sending" entry for a message sent to the chat `state` shows. */
export function newPendingSend(args: {
	id: string;
	text: string;
	attachments?: PromptAttachment[];
	queue?: boolean;
	state: UiState;
	now: number;
}): PendingSend {
	const { id, text, attachments, queue, state, now } = args;
	return {
		id,
		conversationId: state.conversationId,
		...(state.sessionId ? { sessionId: state.sessionId } : {}),
		text,
		...(attachments && attachments.length > 0 ? { attachments } : {}),
		queue: !!queue,
		createdAt: now,
		status: "sending",
		...baseline(state, text),
	};
}

/** Where the chat stands right now, for telling this send's copy apart from earlier ones. */
function baseline(
	state: UiState,
	text: string,
): Pick<PendingSend, "anchorId" | "sameTextBefore" | "queueBase" | "whileWorking"> {
	const norm = normalizeSentText(text);
	const last = state.messages[state.messages.length - 1];
	return {
		...(last ? { anchorId: last.id } : {}),
		sameTextBefore: state.messages.filter((m) => userMessageShows(m, norm)).map((m) => m.id),
		queueBase: queueCount(state, norm),
		whileWorking: !!state.isStreaming,
	};
}

/**
 * Is the run `state` reports the one a message from this window is starting? pi marks the chat as
 * running a moment before that message is in (the add-ons' "before the AI starts" step is over, the
 * run's first events are out). Until the message arrives the list keeps drawing the chat as it was,
 * the faded copy at the end with "working" after it, so nothing moves when the server's copy takes
 * its place. True when a copy still on its way was sent while the AI wasn't working, and the chat
 * has no new user message or answer since (then another message started this run).
 */
export function runStartingFor(list: readonly PendingSend[], state: UiState): boolean {
	if (!state.isStreaming || state.streamingMessage) return false;
	return list.some((p) => {
		if (p.status !== "sending" || p.whileWorking !== false || !sameChat(p, state)) return false;
		const anchorIndex = p.anchorId === undefined ? -1 : state.messages.findIndex((m) => m.id === p.anchorId);
		if (p.anchorId !== undefined && anchorIndex < 0) return false;
		for (let i = anchorIndex + 1; i < state.messages.length; i++) {
			const role = state.messages[i].role;
			if (role === "user" || role === "assistant") return false;
		}
		return true;
	});
}

/**
 * The ids of the entries whose server copy `state` already shows: a user message with the same text
 * after the chat's end at the time of sending, or the text waiting in the queue once more than
 * before. Entries are matched in the order they were sent and each copy is claimed once, so two
 * sends of the same text need two copies.
 */
export function seenPendingIds(list: readonly PendingSend[], state: UiState): Set<string> {
	const seen = new Set<string>();
	const mine = list.filter((p) => sameChat(p, state));
	if (mine.length === 0) return seen;
	const claimedMsgs = new Set<string>();
	const claimedQueue = new Map<string, number>();
	const ordered = [...mine].sort((a, b) => a.createdAt - b.createdAt);
	for (const p of ordered) {
		const norm = normalizeSentText(p.text);
		const anchorIndex = p.anchorId === undefined ? -1 : state.messages.findIndex((m) => m.id === p.anchorId);
		const anchorGone = p.anchorId !== undefined && anchorIndex < 0;
		let found = false;
		for (let i = anchorGone ? 0 : anchorIndex + 1; i < state.messages.length; i++) {
			const m = state.messages[i];
			if (claimedMsgs.has(m.id) || !userMessageShows(m, norm)) continue;
			if (anchorGone && p.sameTextBefore.includes(m.id)) continue;
			claimedMsgs.add(m.id);
			found = true;
			break;
		}
		if (!found) {
			const claimed = claimedQueue.get(norm) ?? 0;
			if (queueCount(state, norm) - p.queueBase - claimed > 0) {
				claimedQueue.set(norm, claimed + 1);
				found = true;
			}
		}
		if (found) seen.add(p.id);
	}
	return seen;
}

/**
 * The ids of the entries whose pictures and files the chat already shows. The server adds a send's
 * attachments as their own cards (custom "file" messages) right away, before the add-ons' steps,
 * and the text only after them; from then on the faded copy leaves the attachments to those cards
 * instead of showing them twice. Cards after the chat's end at the time of sending are claimed in
 * sending order, as many per entry as it has attachments.
 */
export function attachmentsLandedIds(list: readonly PendingSend[], state: UiState): Set<string> {
	const landed = new Set<string>();
	const mine = list
		.filter((p) => sameChat(p, state) && p.status === "sending" && (p.attachments?.length ?? 0) > 0)
		.sort((a, b) => a.createdAt - b.createdAt);
	if (mine.length === 0) return landed;
	const claimed = new Set<string>();
	for (const p of mine) {
		const anchorIndex = p.anchorId === undefined ? -1 : state.messages.findIndex((m) => m.id === p.anchorId);
		// The anchor is gone (the chat was compacted): can't tell this send's cards from older ones.
		if (p.anchorId !== undefined && anchorIndex < 0) continue;
		let taken = 0;
		const want = p.attachments?.length ?? 0;
		for (let i = anchorIndex + 1; i < state.messages.length && taken < want; i++) {
			const m = state.messages[i];
			if (m.role !== "custom" || m.customType !== "file" || claimed.has(m.id)) continue;
			claimed.add(m.id);
			taken++;
		}
		if (taken > 0) landed.add(p.id);
	}
	return landed;
}

/**
 * A snapshot (full or delta) arrived: drop the copies it makes unnecessary. A copy goes when the
 * snapshot shows its message (also a "Not sent" one: it got there after all), and a confirmed copy
 * goes once the window's state is at least as new as the snapshot the server confirmed it with.
 * Returns the same array when nothing changes.
 */
export function reconcilePending(list: readonly PendingSend[], state: UiState | null): readonly PendingSend[] {
	if (list.length === 0 || !state) return list;
	const seen = seenPendingIds(list, state);
	const next = list.filter((p) => {
		if (seen.has(p.id)) return false;
		if (p.confirmedRev !== undefined && (!sameChat(p, state) || state.rev >= p.confirmedRev)) return false;
		return true;
	});
	return next.length === list.length ? list : next;
}

/** The server answered a send. Unknown ids (already dropped, or another window's) change nothing. */
export function applyPromptAck(
	list: readonly PendingSend[],
	ack: PromptAckInfo,
	state: UiState | null,
): readonly PendingSend[] {
	const i = list.findIndex((p) => p.id === ack.id);
	if (i < 0) return list;
	const p = list[i];
	if (ack.ok) {
		// The snapshot that shows it went out first. If this window hasn't got that one yet (dropped
		// under backpressure; a resync brings a newer one), keep the copy until it has.
		const behind =
			ack.rev !== undefined && !!state && state.conversationId === ack.conversationId && state.rev < ack.rev;
		if (behind)
			return replaceAt(list, i, {
				...p,
				status: "sending",
				reason: undefined,
				needsCheck: undefined,
				confirmedRev: ack.rev,
			});
		return list.filter((_, j) => j !== i);
	}
	// A late refusal can't undo a send the server already confirmed.
	if (p.confirmedRev !== undefined) return list;
	return replaceAt(list, i, {
		...p,
		status: "failed",
		reason: ack.reason || undefined,
		needsCheck: undefined,
	});
}

/** Retry: the same id goes out again (the server never adds it twice), measured from the chat as it is now. */
export function retryPending(list: readonly PendingSend[], id: string, state: UiState | null): readonly PendingSend[] {
	const i = list.findIndex((p) => p.id === id);
	if (i < 0) return list;
	const p = list[i];
	// Same chat (maybe under a new id after a server restart): take its id and where it stands now.
	const rebased =
		state && sameChat(p, state) ? { conversationId: state.conversationId, ...baseline(state, p.text) } : {};
	return replaceAt(list, i, {
		...p,
		...rebased,
		status: "sending",
		reason: undefined,
		needsCheck: undefined,
		confirmedRev: undefined,
	});
}

/** Marks an entry as not sent, e.g. when its message could not go out because the connection was down. */
export function failPending(list: readonly PendingSend[], id: string, reason: string): readonly PendingSend[] {
	const i = list.findIndex((p) => p.id === id);
	if (i < 0) return list;
	return replaceAt(list, i, { ...list[i], status: "failed", reason, needsCheck: undefined });
}

export function removePending(list: readonly PendingSend[], id: string): readonly PendingSend[] {
	const next = list.filter((p) => p.id !== id);
	return next.length === list.length ? list : next;
}

/**
 * A new connection is up: the copies the server already confirmed go (the fresh snapshot shows
 * them), and the ones still "Sending" are asked about again (`idsToCheck`).
 */
export function onReconnect(list: readonly PendingSend[]): readonly PendingSend[] {
	if (list.length === 0) return list;
	return list
		.filter((p) => p.confirmedRev === undefined)
		.map((p) => (p.status === "sending" && !p.needsCheck ? { ...p, needsCheck: true } : p));
}

/** The ids to ask the server about (`prompt_status`). */
export function idsToCheck(list: readonly PendingSend[]): string[] {
	return list.filter((p) => p.status === "sending" && p.needsCheck).map((p) => p.id);
}

/** The copies to draw for the chat that is shown, oldest first. */
export function pendingFor(
	list: readonly PendingSend[],
	shown: { conversationId: string; sessionId?: string } | null | undefined,
): PendingSend[] {
	// chat-open-speed: a chat that is still opening is known by its session alone (no chat id yet).
	if (!shown?.conversationId && !shown?.sessionId) return [];
	return list.filter((p) => sameChat(p, shown)).sort((a, b) => a.createdAt - b.createdAt);
}

function replaceAt(list: readonly PendingSend[], i: number, p: PendingSend): readonly PendingSend[] {
	const next = list.slice();
	next[i] = p;
	return next;
}

// ---------------------------------------------------------------------------
// Keeping the list across a reload (sessionStorage, this tab only)
// ---------------------------------------------------------------------------

export const PENDING_STORAGE_KEY = "pi-web-pending-sends";
/** Past this size the pictures and files are left out of what is kept (the text always stays). */
const MAX_STORED_CHARS = 1_500_000;

/** The list as it is kept for a reload. Pictures and files are left out when they are too big. */
export function serializePending(list: readonly PendingSend[]): string {
	const keep = list.filter((p) => p.confirmedRev === undefined);
	const full = JSON.stringify(keep);
	if (full.length <= MAX_STORED_CHARS) return full;
	return JSON.stringify(
		keep.map((p) => ({ ...p, attachments: p.attachments?.filter((a) => !a.imageData && !a.fileData) })),
	);
}

/** The kept list after a reload: every copy still "Sending" is asked about again. */
export function parsePending(raw: string | null | undefined): PendingSend[] {
	if (!raw) return [];
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(data)) return [];
	const out: PendingSend[] = [];
	for (const item of data) {
		if (!item || typeof item !== "object") continue;
		const p = item as Partial<PendingSend>;
		if (typeof p.id !== "string" || typeof p.conversationId !== "string" || typeof p.text !== "string") continue;
		if (p.confirmedRev !== undefined) continue;
		out.push({
			id: p.id,
			conversationId: p.conversationId,
			...(typeof p.sessionId === "string" && p.sessionId ? { sessionId: p.sessionId } : {}),
			text: p.text,
			...(Array.isArray(p.attachments) && p.attachments.length > 0 ? { attachments: p.attachments } : {}),
			queue: !!p.queue,
			createdAt: typeof p.createdAt === "number" ? p.createdAt : 0,
			status: p.status === "failed" ? "failed" : "sending",
			...(typeof p.reason === "string" ? { reason: p.reason } : {}),
			...(typeof p.anchorId === "string" ? { anchorId: p.anchorId } : {}),
			sameTextBefore: Array.isArray(p.sameTextBefore)
				? p.sameTextBefore.filter((x): x is string => typeof x === "string")
				: [],
			queueBase: typeof p.queueBase === "number" ? p.queueBase : 0,
			...(typeof p.whileWorking === "boolean" ? { whileWorking: p.whileWorking } : {}),
			...(p.status === "failed" ? {} : { needsCheck: true }),
		});
	}
	return out;
}
