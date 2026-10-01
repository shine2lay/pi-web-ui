import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentService, ClientSession } from "../../server/agent-service.js";
import { ClientStateStore } from "../../server/client-state.js";
import type { ConversationSummary, ServerMessage, SessionSummary } from "../../server/protocol.js";
import { isQueueTaskChatEntries, isQueueTaskChatFile, taskChatHeadEntry } from "../../server/task-queue.js";

/**
 * queue-done-hidden: when a queued task is done (or removed), pi-queue calls the host's closeChat, and
 * the task's own chat leaves the whole chat list: the running list (queue-lanes) and Recent chats too,
 * with the same tombstone as the ✕ on its row. Nothing is deleted: History lists the transcript, the
 * Queue tab and the TL;DR link open it, and opening it puts it back in Recent chats.
 *
 * No model, no port: the production queueCloseChat / releaseQueueChat / emitConversations /
 * markRecentSeen / pushSessions run on stand-in windows that share one conversation table and one
 * real ClientStateStore (a temporary client-state.json), with transcripts in a temporary folder.
 */

type Proto = {
	emitConversations(this: Win): void;
	shownInRunningList(this: Win, conv: FakeConv): boolean;
	recentHistoryRows(this: Win, live: Set<string>, waiting: Set<string>): ConversationSummary[];
	releaseQueueChat(this: Win, file: string): boolean;
	markRecentSeen(this: Win, conv: FakeConv | undefined): void;
	pushSessions(this: Win): Promise<void>;
};
const proto = ClientSession.prototype as unknown as Proto;
const queueCloseChat = (
	AgentService.prototype as unknown as { queueCloseChat(this: unknown, file: string): Promise<boolean> }
).queueCloseChat;

const CWD = "/work/project";
/** The queue's pseudo clients (agent-service.ts QUEUE_TASKS_CLIENT_ID / QUEUE_HOME_CLIENT_ID). */
const QUEUE_TASKS = "carry-on:queue";
const QUEUE_HOME = "carry-on:queue-home";

interface FakeConv {
	id: string;
	title: string;
	cwd: string;
	listed: boolean;
	promptedSinceActive: boolean;
	session: {
		sessionFile: string;
		isStreaming: boolean;
		isCompacting: boolean;
		getSessionStats(): { totalMessages: number };
		sessionManager: { getEntries(): unknown[] };
	};
	dialogs: { current: null };
}

interface Win {
	clientId: string;
	cwd: string;
	activeId: string;
	convs: Map<string, FakeConv>;
	stateStore: ClientStateStore;
	recentSessions: SessionSummary[];
	emitted: ServerMessage[];
	disposed: boolean;
	sessionsRequested: boolean;
	sessionsPushGen: number;
	history: string[];
	emit(msg: ServerMessage): void;
	emitConversations(): void;
	shownInRunningList(conv: FakeConv): boolean;
	recentHistoryRows(live: Set<string>, waiting: Set<string>): ConversationSummary[];
	subagentRunOutcome(): Record<string, unknown>;
	getPendingQuestionForConv(): undefined;
	tldrOf(): [];
	identityOf(): undefined;
	conversationIdBySessionFile(file: string): string | null;
	viewedElsewhere(convId: string): boolean;
	removeConversation(id: string): void;
	releaseQueueChat(file: string): boolean;
	loadSessionInfos(): Promise<
		Array<{ path: string; firstMessage: string; messageCount: number; modified: Date; cwd: string }>
	>;
	attachIdentities(): Promise<void>;
}

let dir = "";
let store: ClientStateStore;
let convs: Map<string, FakeConv>;
let wins: Win[];

const at = (name: string) => join(dir, name);
const jsonl = (entries: object[]) => `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
const header = { type: "session", version: 3, id: "s", timestamp: "2026-10-01T00:00:00.000Z", cwd: CWD };
const message = (text: string) => ({
	type: "message",
	id: "m1",
	parentId: "q1",
	timestamp: "2026-10-01T00:00:01.000Z",
	message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
});
const queueEntry = (data: Record<string, unknown>) => ({
	type: "custom",
	customType: "queue",
	id: "q1",
	parentId: null,
	timestamp: "2026-10-01T00:00:00.500Z",
	data: { v: 1, ts: 1, ...data },
});
const plan = (title: string, goal = "Make the list tidy") => ({
	title,
	goal,
	doneWhen: "it is",
	decided: "-",
	steps: "-",
	verify: "-",
	mustNot: "-",
});
const assigned = (id: number, from: unknown = { file: "/sessions/home.jsonl", title: "tooling" }, goal?: string) =>
	queueEntry({ op: "assigned", id, plan: plan(`Task ${id}`, goal), touches: ["a repo"], from });

/** A queued task's own chat, as pi-queue starts it: its task entry, then its first message. */
const taskChatEntries = (id: number) => [
	header,
	{
		type: "model_change",
		id: "c1",
		parentId: null,
		timestamp: "2026-10-01T00:00:00.100Z",
		provider: "anthropic",
		modelId: "m",
	},
	{
		type: "custom",
		customType: "identity",
		id: "i1",
		parentId: "c1",
		timestamp: "2026-10-01T00:00:00.200Z",
		data: { id: "ops" },
	},
	assigned(id),
	message(`work on task ${id}`),
];
/** A chat the user started. */
const userChatEntries = () => [header, message("hello")];

function write(name: string, entries: object[]): string {
	const file = at(name);
	writeFileSync(file, jsonl(entries));
	return file;
}

function conv(
	id: string,
	file: string,
	entries: object[],
	opts: { listed?: boolean; streaming?: boolean } = {},
): FakeConv {
	const c: FakeConv = {
		id,
		title: `chat ${id}`,
		cwd: CWD,
		listed: opts.listed ?? true,
		promptedSinceActive: false,
		session: {
			sessionFile: file,
			isStreaming: opts.streaming ?? false,
			isCompacting: false,
			getSessionStats: () => ({ totalMessages: 4 }),
			sessionManager: { getEntries: () => entries.filter((e) => (e as { type: string }).type !== "session") },
		},
		dialogs: { current: null },
	};
	convs.set(id, c);
	return c;
}

const summary = (path: string, modified: number): SessionSummary => ({
	path,
	firstMessage: `history ${path}`,
	messageCount: 2,
	modified,
	source: "web",
	cwd: CWD,
});

/** A browser window (or one of the queue's pseudo clients): one ClientSession over the shared table. */
function win(clientId: string, activeId: string, history: string[] = []): Win {
	const w: Win = {
		clientId,
		cwd: CWD,
		activeId,
		convs,
		stateStore: store,
		// What it last read from disk (History), newest first: also where Recent chats come from.
		recentSessions: history.map((p, i) => summary(p, 1_000_000 - i)),
		emitted: [],
		disposed: false,
		sessionsRequested: true,
		sessionsPushGen: 0,
		history,
		emit(msg) {
			this.emitted.push(msg);
		},
		emitConversations() {
			proto.emitConversations.call(this);
		},
		shownInRunningList(c) {
			return proto.shownInRunningList.call(this, c);
		},
		recentHistoryRows(live, waiting) {
			return proto.recentHistoryRows.call(this, live, waiting);
		},
		subagentRunOutcome: () => ({}),
		getPendingQuestionForConv: () => undefined,
		tldrOf: () => [],
		identityOf: () => undefined,
		conversationIdBySessionFile(file) {
			for (const c of convs.values()) if (c.session.sessionFile === file) return c.id;
			return null;
		},
		viewedElsewhere(convId) {
			return wins.some((o) => o !== this && o.activeId === convId);
		},
		removeConversation(id) {
			if (id === this.activeId || this.viewedElsewhere(id)) throw new Error("removed a chat someone is looking at");
			convs.delete(id);
		},
		releaseQueueChat(file) {
			return proto.releaseQueueChat.call(this, file);
		},
		async loadSessionInfos() {
			return this.history.map((path, i) => ({
				path,
				firstMessage: "-",
				messageCount: 2,
				modified: new Date(1_000_000 - i),
				cwd: CWD,
			}));
		},
		async attachIdentities() {},
	};
	wins.push(w);
	return w;
}

/** The queue host as AgentService has it: its windows and the shared client state. */
function host() {
	return {
		clients: new Map(wins.map((w) => [w.clientId, w])),
		stateStore: store,
		queueSessionFor(file: string) {
			for (const c of convs.values()) if (c.session.sessionFile === file) return c.session;
			return null;
		},
		queueTasksChain<T>(fn: () => Promise<T>): Promise<T> {
			return fn();
		},
	};
}
const closeChat = (file: string) => queueCloseChat.call(host(), file);

/** The chat list a window shows now (running chats + Recent chats). */
function rows(w: Win): ConversationSummary[] {
	proto.emitConversations.call(w);
	const last = [...w.emitted].reverse().find((m) => m.type === "conversations");
	expect(last).toBeTruthy();
	return (last as Extract<ServerMessage, { type: "conversations" }>).conversations;
}
const rowFor = (w: Win, file: string) => rows(w).find((r) => r.sessionPath === file);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-web-queue-done-hidden."));
	store = new ClientStateStore(join(dir, "client-state.json"));
	convs = new Map();
	wins = [];
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe("queue-done-hidden: which chats are a queued task's own", () => {
	it("a task's chat starts with pi-queue's assigned entry; the user's chats and queue chats don't", async () => {
		const task = taskChatEntries(7);
		expect(isQueueTaskChatEntries(task)).toBe(true);
		expect(await isQueueTaskChatFile(write("task.jsonl", task))).toBe(true);
		// A chat the user started, even one that later got such an entry: its first message came first.
		const user = [...userChatEntries(), assigned(8)];
		expect(isQueueTaskChatEntries(user)).toBe(false);
		expect(await isQueueTaskChatFile(write("user.jsonl", user))).toBe(false);
		// A queue's chat (it holds the queue, it isn't a task's chat).
		const home = [
			header,
			queueEntry({ op: "add", id: 1, plan: plan("Task 1") }),
			queueEntry({ op: "run" }),
			message("go"),
		];
		expect(isQueueTaskChatEntries(home)).toBe(false);
		expect(await isQueueTaskChatFile(write("home.jsonl", home))).toBe(false);
		// An assigned entry without the queue it came from doesn't count.
		const orphan = [header, assigned(9, null), message("?")];
		expect(isQueueTaskChatEntries(orphan)).toBe(false);
		expect(await isQueueTaskChatFile(write("orphan.jsonl", orphan))).toBe(false);
		// Nothing to read.
		expect(isQueueTaskChatEntries([])).toBe(false);
		expect(await isQueueTaskChatFile(at("missing.jsonl"))).toBe(false);
		expect(await isQueueTaskChatFile(write("empty.jsonl", []))).toBe(false);
		expect(taskChatHeadEntry("not an entry")).toBeUndefined();
		expect(taskChatHeadEntry(header)).toBeUndefined();
	});

	it("reads only the start of a transcript, wide characters and all", async () => {
		// A long plan full of 3-byte characters: its line spans several reads, cut mid-character.
		const goal = "\u2026\u754c".repeat(40_000);
		const file = write("long.jsonl", [header, assigned(3, undefined, goal), message("go")]);
		expect(await isQueueTaskChatFile(file)).toBe(true);
		// Past the limit it can't tell, so it says no.
		expect(await isQueueTaskChatFile(file, 4096)).toBe(false);
		// A task's chat whose last line has no line break yet.
		const noBreak = at("no-break.jsonl");
		writeFileSync(noBreak, `${JSON.stringify(header)}\n${JSON.stringify(assigned(4))}`);
		expect(await isQueueTaskChatFile(noBreak)).toBe(true);
	});
});

describe("queue-done-hidden: a finished task's chat leaves the chat list", () => {
	it("leaves Running and Recent chats on every window; the transcript stays and History lists it", async () => {
		const taskFile = write("task.jsonl", taskChatEntries(7));
		const userFile = write("user.jsonl", userChatEntries());
		const homeFile = write("home.jsonl", userChatEntries());
		const before = readFileSync(taskFile, "utf8");
		conv("home", homeFile, userChatEntries());
		conv("task", taskFile, taskChatEntries(7));
		const history = [taskFile, userFile, homeFile];
		const desk = win("desk", "home", history);
		const phone = win("phone", "user-chat", history);
		expect(rowFor(desk, taskFile)?.live).toBe(true);
		expect(rowFor(phone, taskFile)?.live).toBe(true);

		expect(await closeChat(taskFile)).toBe(true);

		expect(convs.has("task")).toBe(false);
		for (const w of [desk, phone]) {
			expect(rowFor(w, taskFile)).toBeUndefined();
			expect(rowFor(w, userFile)?.live).toBe(false); // other saved chats stay in Recent chats
		}
		expect(store.getRecentRemoved()).toContain(taskFile);
		// Nothing deleted or changed: the transcript is as it was, and History still lists it.
		expect(readFileSync(taskFile, "utf8")).toBe(before);
		desk.emitted = [];
		await proto.pushSessions.call(desk);
		const historyList = desk.emitted.find((m) => m.type === "sessions") as Extract<ServerMessage, { type: "sessions" }>;
		expect(historyList.sessions.map((s) => s.path)).toContain(taskFile);
		expect(rowFor(desk, taskFile)).toBeUndefined();
	});

	it("a window looking at it keeps it until it moves on, then it's gone", async () => {
		const taskFile = write("task.jsonl", taskChatEntries(7));
		const homeFile = write("home.jsonl", userChatEntries());
		conv("home", homeFile, userChatEntries());
		const task = conv("task", taskFile, taskChatEntries(7));
		task.promptedSinceActive = true;
		const history = [taskFile, homeFile];
		const desk = win("desk", "task", history); // looking at it
		const phone = win("phone", "home", history);

		expect(await closeChat(taskFile)).toBe(true);

		// Still there for the window looking at it (its open chat), gone everywhere else.
		expect(convs.has("task")).toBe(true);
		expect(rowFor(desk, taskFile)?.live).toBe(true);
		expect(rowFor(phone, taskFile)).toBeUndefined();
		// Nothing keeps it once that window moves on (displaceActive lets it go)...
		expect(task.listed).toBe(false);
		expect(task.promptedSinceActive).toBe(false);
		desk.activeId = "home";
		desk.removeConversation("task");
		// ...and then it's gone from that window too, Recent chats included.
		expect(rowFor(desk, taskFile)).toBeUndefined();
		expect(rowFor(phone, taskFile)).toBeUndefined();
	});

	it("chats of open tasks and the user's own chats stay in the list", async () => {
		const doneFile = write("done.jsonl", taskChatEntries(7));
		const openFile = write("open.jsonl", taskChatEntries(8));
		const userFile = write("user.jsonl", userChatEntries());
		conv("done", doneFile, taskChatEntries(7));
		conv("open", openFile, taskChatEntries(8));
		conv("user", userFile, userChatEntries());
		const history = [doneFile, openFile, userFile];
		const desk = win("desk", "elsewhere", history);
		const phone = win("phone", "elsewhere-too", history);

		expect(await closeChat(doneFile)).toBe(true);
		for (const w of [desk, phone]) {
			expect(rowFor(w, doneFile)).toBeUndefined();
			expect(rowFor(w, openFile)?.live).toBe(true); // a task still being worked on: untouched
			expect(rowFor(w, userFile)?.live).toBe(true);
		}
		// Asked to close a chat that isn't a task's own: it leaves the running list (as before), but
		// it is never taken out of Recent chats.
		expect(await closeChat(userFile)).toBe(true);
		expect(store.getRecentRemoved()).not.toContain(userFile);
		for (const w of [desk, phone]) expect(rowFor(w, userFile)?.live).toBe(false);
	});

	it("opening it puts it back in Recent chats; the queue opening it doesn't", async () => {
		const taskFile = write("task.jsonl", taskChatEntries(7));
		const entries = taskChatEntries(7);
		const task = conv("task", taskFile, entries);
		const desk = win("desk", "elsewhere", [taskFile]);
		expect(await closeChat(taskFile)).toBe(true);
		expect(rowFor(desk, taskFile)).toBeUndefined();
		// The queue's own clients open chats to run its commands: that isn't the user looking.
		for (const id of [QUEUE_TASKS, QUEUE_HOME]) proto.markRecentSeen.call(win(id, "task"), task);
		expect(store.getRecentRemoved()).toContain(taskFile);
		expect(rowFor(desk, taskFile)).toBeUndefined();
		// The user opens it (from History, the Queue tab or a TL;DR link): back in Recent chats.
		proto.markRecentSeen.call(desk, task);
		expect(store.getRecentRemoved()).not.toContain(taskFile);
		expect(rowFor(desk, taskFile)?.live).toBe(false);
	});

	it("a task's chat that isn't open any more still leaves Recent chats, and every window's list goes out again", async () => {
		const taskFile = write("task.jsonl", taskChatEntries(7));
		const userFile = write("user.jsonl", userChatEntries());
		const desk = win("desk", "elsewhere", [taskFile, userFile]);
		expect(rowFor(desk, taskFile)?.live).toBe(false);
		// (The real one pushes every live window's list; there are none here.)
		const pushAll = vi.spyOn(ClientSession, "recentChangedForAll").mockImplementation(() => {});

		expect(await closeChat(taskFile)).toBe(true);
		expect(pushAll).toHaveBeenCalledTimes(1);
		expect(store.getRecentRemoved()).toContain(taskFile);
		expect(rowFor(desk, taskFile)).toBeUndefined();
		// The user's own chat, or no transcript at all: nothing to do.
		expect(await closeChat(userFile)).toBe(false);
		expect(await closeChat(at("missing.jsonl"))).toBe(false);
		expect(pushAll).toHaveBeenCalledTimes(1);
		expect(store.getRecentRemoved()).toEqual([taskFile]);
		expect(rowFor(desk, userFile)?.live).toBe(false);
	});

	it("many finished task chats don't leave Recent chats short of rows", async () => {
		vi.stubEnv("PI_WEB_UI_RECENT_LIMIT", "15");
		// The newest 60 transcripts are finished task chats, then 20 of the user's own.
		const tasks = Array.from({ length: 60 }, (_, i) => at(`task-${i}.jsonl`));
		const users = Array.from({ length: 20 }, (_, i) => at(`user-${i}.jsonl`));
		for (const file of tasks) store.removeRecent(file);
		const desk = win("desk", "elsewhere", [...tasks, ...users]);
		await proto.pushSessions.call(desk);
		const recent = rows(desk).filter((r) => r.live === false);
		expect(recent.map((r) => r.sessionPath)).toEqual(users.slice(0, 15));
	});

	it("waits for the chat's run to end first", async () => {
		const taskFile = write("task.jsonl", taskChatEntries(7));
		const task = conv("task", taskFile, taskChatEntries(7), { streaming: true });
		const desk = win("desk", "elsewhere", [taskFile]);
		const closing = closeChat(taskFile);
		await new Promise((r) => setTimeout(r, 100));
		expect(store.getRecentRemoved()).toEqual([]);
		expect(rowFor(desk, taskFile)?.live).toBe(true);
		task.session.isStreaming = false;
		expect(await closing).toBe(true);
		expect(convs.has("task")).toBe(false);
		expect(rowFor(desk, taskFile)).toBeUndefined();
	});
});
