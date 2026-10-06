/**
 * roles-overview: open a chat at one item. The Roles page (and a link with `?chat=<file>&focus=...`)
 * asks for an item of a chat: a TL;DR line, a queued task, a question or a 6 am report. Once that
 * chat is the open one, the right panel shows the line or the task (its tab selected, scrolled to,
 * marked for a moment); a report scrolls the chat to the answer.
 *
 * A module-level store like roles-state.ts. A request is forgotten after FOCUS_MS, so a chat that
 * never opens doesn't keep a stale focus around.
 */
import { useSyncExternalStore } from "react";

export type ChatFocusKind = "tldr" | "task" | "question" | "report";

export interface ChatFocus {
	/** The chat's transcript (absolute path). */
	file: string;
	kind: ChatFocusKind;
	/** tldr: the line id; task: its number; question: the ask id; report: its day (YYYY-MM-DD). */
	id: string;
	/** report: the answer's message time in its chat (the chat scrolls to it). */
	timestamp?: number;
	/** Grows with every request (the same item twice still counts twice). */
	seq: number;
	/** When it was asked (ms). */
	at: number;
}

export const FOCUS_MS = 20_000;
/** How long the item asked for stays marked in its tab. */
export const FOCUS_FLASH_MS = 2_500;

let focus: ChatFocus | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
	for (const l of listeners) l();
}

/** "tldr:<id>", "task:<n>", "question:<id>" or "report:<YYYY-MM-DD>" -> its parts; null when it isn't one. */
export function parseFocus(raw: string | null | undefined): { kind: ChatFocusKind; id: string } | null {
	if (typeof raw !== "string") return null;
	const m = /^(tldr|task|question|report):([A-Za-z0-9._-]{1,80})$/.exec(raw.trim());
	if (!m) return null;
	const kind = m[1] as ChatFocusKind;
	if (kind === "task" && !/^\d{1,9}$/.test(m[2])) return null;
	if (kind === "report" && !/^\d{4}-\d{2}-\d{2}$/.test(m[2])) return null;
	return { kind, id: m[2] };
}

/** Ask for an item of a chat (the caller opens the chat). */
export function requestChatFocus(f: { file: string; kind: ChatFocusKind; id: string; timestamp?: number }): ChatFocus {
	seq++;
	focus = { ...f, seq, at: Date.now() };
	if (timer) clearTimeout(timer);
	const mine = seq;
	timer = setTimeout(() => clearChatFocus(mine), FOCUS_MS);
	notify();
	return focus;
}

/** Done with request `which` (or with any, when not given). */
export function clearChatFocus(which?: number): void {
	if (!focus || (which !== undefined && focus.seq !== which)) return;
	focus = null;
	if (timer) clearTimeout(timer);
	timer = null;
	notify();
}

function subscribe(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

function snapshot(): ChatFocus | null {
	return focus;
}

/** The item asked for (null: none). */
export function useChatFocus(): ChatFocus | null {
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}
