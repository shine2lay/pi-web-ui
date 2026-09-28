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
 *  - closeChat(sessionFile) takes a finished chat out of the running list once it is idle. It stays
 *    in the history.
 *
 * This file is the glue: it checks what the extension hands in and serializes the work. The chats
 * themselves are opened by AgentService / ClientSession (agent-service.ts).
 */

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
}

export interface QueueHostImpl {
	startChat(opts: QueueChatStart): Promise<{ sessionFile: string; conversationId?: string }>;
	runCommand(sessionFile: string, line: string): Promise<boolean>;
	closeChat(sessionFile: string): Promise<boolean>;
}

/** The object pi-queue sees. */
export interface QueueHost extends QueueHostImpl {
	v: 1;
}

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const PROMPT_MAX = 200_000;
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
	return out;
}

/** A command the host runs for pi-queue: one "/queue …" line, nothing else. */
export function isQueueCommand(line: unknown): line is string {
	return typeof line === "string" && line.length <= 4000 && /^\/queue(?: |$)/.test(line) && !/[\r\n]/.test(line);
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
	});
	g[QUEUE_HOST_KEY] = host;
	return () => {
		if (g[QUEUE_HOST_KEY] === host) delete g[QUEUE_HOST_KEY];
	};
}
