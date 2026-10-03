/**
 * queue-lanes: what pi-web-ui offers the pi-queue extension for running queued tasks in chats of
 * their own. pi-queue finds it on globalThis under Symbol.for("pi-web-ui.queue-host"); the
 * command-line pi has none, and there every task runs in the queue's chat as before.
 *
 * Version 1:
 *  - startChat({cwd, name, prompt, entries, model?, thinking?}) opens a new chat in `cwd`, names it,
 *    adds the custom `entries` (the task it works on), sets the model and thinking level, sends it
 *    `prompt`, and resolves with {sessionFile, conversationId} once its run has started. It rejects
 *    with the reason otherwise.
 *  - runCommand(sessionFile, line) runs a "/queue …" command in the chat with that transcript,
 *    opening the chat if it isn't open. false = it couldn't.
 *  - closeChat(sessionFile) lets go of the chat of a task that's done or removed once it is idle: it
 *    leaves the running list and, being a queued task's own chat, Recent chats too (queue-done-hidden).
 *    Its transcript stays: History lists it and opening it brings it back.
 *  - chatState(sessionFile) (stall-watch) says whether the chat with that transcript is working now:
 *    {state: "working"} while a turn runs (or a restart's carry-on is about to start one), "idle" when
 *    it is open with no turn running, "closed" when it isn't loaded; `lastActiveAt` is when it last did
 *    something (its transcript's last write, ms), when that can be read.
 *  - wakeChat(sessionFile, note) (stall-watch) opens the chat if it isn't open and sends it `note` as a
 *    user message, the way carry-on does. It refuses (false) while a turn runs there, and for a chat the
 *    carry-on left alone at this start (cut off too often without finishing a turn) until it does
 *    something again (wakeRefusal).
 *  pi-queue checks for chatState and wakeChat before it uses them: an older pi-web-ui has no watchdog.
 *
 * This file is the glue: it checks what the extension hands in and serializes the work. The chats
 * themselves are opened by AgentService / ClientSession (agent-service.ts).
 */

import { consumeOwnerSetting } from "./queue-owner.js";
import { checkPatch, normLaunch, QueueLaunchRefused } from "./queue-profile.js";
import type { ChatSpeed, UiTaskLaunch } from "./protocol.js";

export const QUEUE_HOST_KEY = Symbol.for("pi-web-ui.queue-host");

/** What startChat gets, checked. */
export interface QueueChatStart {
	cwd: string;
	name: string;
	prompt: string;
	entries: { customType: string; data: unknown }[];
	/** "provider/id" */
	model?: string;
	thinking?: string;
	speed?: ChatSpeed;
	launch?: UiTaskLaunch;
	/** Queue extension commits the completed snapshot synchronously; false cancels a stale launch. */
	onPrepared?: (launch: UiTaskLaunch) => boolean;
}

/** Whether a chat is working now (see chatState). */
export type ChatStateName = "working" | "idle" | "closed";

export interface ChatState {
	state: ChatStateName;
	/** When it last did something: its transcript's last write (ms). Missing when that can't be read. */
	lastActiveAt?: number;
}

export interface QueueHostImpl {
	startChat(opts: QueueChatStart): Promise<{ sessionFile: string; conversationId?: string }>;
	runCommand(sessionFile: string, line: string): Promise<boolean>;
	closeChat(sessionFile: string): Promise<boolean>;
	chatState(sessionFile: string): Promise<ChatState>;
	wakeChat(sessionFile: string, note: string): Promise<boolean>;
	/** Preview from the exact loaded source session; never creates a chat/request or edits settings. */
	previewLaunch?(profile: UiTaskLaunch, cwd: string, sourceSessionId: string): Promise<UiTaskLaunch>;
}

/** The object pi-queue sees. */
export interface QueueHost extends QueueHostImpl {
	v: 1;
	profiles: 1;
	consumeOwnerSetting: typeof consumeOwnerSetting;
}

/** Approval previews may only consult already-loaded sources, never create a task client. */
export async function previewExistingQueueLaunch(
	profile: UiTaskLaunch,
	cwd: string,
	sourceSessionId: string,
	clients: Iterable<{
		previewQueueLaunch(profile: UiTaskLaunch, cwd: string, sourceSessionId: string): Promise<UiTaskLaunch | undefined>;
	}>,
): Promise<UiTaskLaunch> {
	for (const client of clients) {
		const preview = await client.previewQueueLaunch(profile, cwd, sourceSessionId);
		if (preview) return preview;
	}
	throw new QueueLaunchRefused("Queue preview session is no longer loaded");
}

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const PROMPT_MAX = 200_000;
/** A wake-up note is a few lines. */
export const WAKE_NOTE_MAX = 4000;
const CHAT_STATES: ReadonlySet<string> = new Set(["working", "idle", "closed"]);
const NAME_MAX = 200;
const ENTRIES_MAX = 20;

/** startChat's options as the extension handed them in: cleaned, or the reason they can't be used. */
export function parseQueueChatStart(raw: unknown): QueueChatStart | string {
	if (!raw || typeof raw !== "object") return "no options";
	const o = raw as Record<string, unknown>;
	const cwd = typeof o.cwd === "string" ? o.cwd.trim() : "";
	if (!cwd.startsWith("/")) return "cwd must be an absolute folder";
	const name = typeof o.name === "string" ? o.name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) : "";
	if (!name) return "the chat needs a name";
	const prompt = typeof o.prompt === "string" ? o.prompt : "";
	if (!prompt.trim()) return "the chat needs a first message";
	if (prompt.length > PROMPT_MAX) return "the first message is too long";
	if (o.entries !== undefined && !Array.isArray(o.entries)) return "entries must be a list";
	const entries: QueueChatStart["entries"] = [];
	for (const e of (o.entries as unknown[] | undefined) ?? []) {
		const r = (e ?? {}) as Record<string, unknown>;
		if (typeof r.customType !== "string" || !r.customType.trim()) return "every entry needs a customType";
		entries.push({ customType: r.customType, data: r.data });
	}
	if (entries.length > ENTRIES_MAX) return "too many entries";
	const out: QueueChatStart = { cwd, name, prompt, entries };
	if (typeof o.model === "string" && /^[^/\s]+\/\S+$/.test(o.model)) out.model = o.model;
	if (typeof o.thinking === "string" && THINKING.has(o.thinking)) out.thinking = o.thinking;
	if (o.launch !== undefined) {
		const launch = normLaunch(o.launch);
		const checked = checkPatch(o.launch);
		if (!launch || checked.problems.length) return "invalid launch profile";
		for (const f of ["model", "thinking", "speed"] as const) {
			if (launch.from[f] !== "app" && launch[f] === undefined) return `missing launch ${f}`;
		}
		out.launch = launch;
	}
	if (o.speed !== undefined) {
		if (o.speed !== "standard" && o.speed !== "fast" && o.speed !== "ultrafast") return "invalid speed";
		out.speed = o.speed;
	}
	if (o.onPrepared !== undefined) {
		if (typeof o.onPrepared !== "function") return "invalid launch callback";
		out.onPrepared = o.onPrepared as QueueChatStart["onPrepared"];
	}
	return out;
}

/** A command the host runs for pi-queue: one "/queue …" line, nothing else. */
export function isQueueCommand(line: unknown): line is string {
	return typeof line === "string" && line.length <= 4000 && /^\/queue(?: |$)/.test(line) && !/[\r\n]/.test(line);
}

/** A note wakeChat sends: some text, not too long. */
export function isWakeNote(note: unknown): note is string {
	return typeof note === "string" && note.trim().length > 0 && note.length <= WAKE_NOTE_MAX;
}

/**
 * A chat's state from what the server knows: `busy` is undefined when it isn't open, true while a turn
 * or a compaction runs there or a message is on its way; `listed` is its running-list entry, if any (its
 * turn hasn't ended: an automatic retry between attempts, or a restart's carry-on about to start one).
 */
export function chatStateFrom(busy: boolean | undefined, listed: { awaiting?: boolean } | undefined): ChatStateName {
	if (busy === true || listed?.awaiting) return "working";
	if (busy === false) return listed ? "working" : "idle";
	return "closed";
}

/**
 * Why wakeChat won't wake a chat that looks like this, or undefined when it may: never one that is
 * working, and never one the carry-on left alone at this start (`leftAloneAt`: when; cut off by too many
 * crashes or planned restarts without finishing a turn), unless it has done something since. Waking it
 * would undo the carry-on's guard; the queue then asks the owner instead.
 */
export function wakeRefusal(look: ChatState, leftAloneAt?: number): string | undefined {
	if (look.state === "working") return "the chat is working";
	if (leftAloneAt !== undefined && (look.lastActiveAt ?? 0) <= leftAloneAt)
		return "the carry-on left it alone at this start (cut off too often without finishing a turn)";
	return undefined;
}

/** What chatState hands back, checked: a known state, and a time only when it is one. */
export function cleanChatState(raw: unknown): ChatState {
	const r = (raw ?? {}) as Record<string, unknown>;
	const state = typeof r.state === "string" && CHAT_STATES.has(r.state) ? (r.state as ChatStateName) : "closed";
	const at = r.lastActiveAt;
	return typeof at === "number" && Number.isFinite(at) && at > 0 ? { state, lastActiveAt: Math.round(at) } : { state };
}

/** Runs async jobs one at a time, in the order they were handed in. A failing job doesn't stop the next. */
export function makeChain(): <T>(job: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(job: () => Promise<T>): Promise<T> => {
		const run = tail.then(job);
		tail = run.catch(() => {});
		return run;
	};
}

/** Polls `done` every `stepMs` until it's true (true) or `ms` passed (false). */
export async function waitUntil(done: () => boolean, ms: number, stepMs = 100): Promise<boolean> {
	const deadline = Date.now() + ms;
	for (;;) {
		try {
			if (done()) return true;
		} catch {
			// the thing being watched is being replaced: look again
		}
		if (Date.now() >= deadline) return false;
		await new Promise((r) => setTimeout(r, stepMs));
	}
}

const asError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)));

/**
 * Put the host where pi-queue looks for it. Returns the way to take it back down (it only removes
 * its own host, not one installed after it).
 */
export function installQueueHost(impl: QueueHostImpl): () => void {
	const g = globalThis as Record<symbol, unknown>;
	const host: QueueHost = Object.freeze({
		v: 1 as const,
		profiles: 1 as const,
		consumeOwnerSetting,
		...(impl.previewLaunch ? { previewLaunch: impl.previewLaunch } : {}),
		startChat: (raw: QueueChatStart) => {
			const opts = parseQueueChatStart(raw);
			if (typeof opts === "string") return Promise.reject(new Error(opts));
			try {
				return impl.startChat(opts);
			} catch (err) {
				return Promise.reject(asError(err));
			}
		},
		runCommand: (sessionFile: string, line: string) => {
			if (typeof sessionFile !== "string" || !sessionFile.trim() || !isQueueCommand(line))
				return Promise.resolve(false);
			try {
				return impl.runCommand(sessionFile, line).catch(() => false);
			} catch {
				return Promise.resolve(false);
			}
		},
		closeChat: (sessionFile: string) => {
			if (typeof sessionFile !== "string" || !sessionFile.trim()) return Promise.resolve(false);
			try {
				return impl.closeChat(sessionFile).catch(() => false);
			} catch {
				return Promise.resolve(false);
			}
		},
		chatState: (sessionFile: string) => {
			if (typeof sessionFile !== "string" || !sessionFile.trim()) return Promise.reject(new Error("no chat given"));
			try {
				return impl.chatState(sessionFile).then(cleanChatState);
			} catch (err) {
				return Promise.reject(asError(err));
			}
		},
		wakeChat: (sessionFile: string, note: string) => {
			if (typeof sessionFile !== "string" || !sessionFile.trim() || !isWakeNote(note)) return Promise.resolve(false);
			try {
				return impl.wakeChat(sessionFile, note).catch(() => false);
			} catch {
				return Promise.resolve(false);
			}
		},
	});
	g[QUEUE_HOST_KEY] = host;
	return () => {
		if (g[QUEUE_HOST_KEY] === host) delete g[QUEUE_HOST_KEY];
	};
}
