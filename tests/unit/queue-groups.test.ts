import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { ClientStateStore } from "../../server/client-state.js";
import type { ConversationSummary, ServerMessage, SessionSummary, UiTaskQueue } from "../../server/protocol.js";
import {
	applyQueueHomes,
	type LoadedQueue,
	QUEUE_HOMES_MAX,
	queueHomesFrom,
	queueLinksSig,
} from "../../server/queue-groups.js";

/**
 * queue-grouping: an open queued task's own chat sits under the queue chat it came from (its home chat) in
 * the chat list. The links come from the queue state the server already keeps per open chat (the Queue
 * tab's, taskQueueOfConv's cache); building the list only looks them up.
 *
 * No model, no port: the production emitConversations / recentHistoryRows / refreshQueueHomes /
 * taskQueueOfConv run on stand-in windows over the server's own chat table, with a real ClientStateStore
 * (a temporary client-state.json). Every file the code under test opens is recorded (node:fs wrapped),
 * to show the list is built without reading a chat's file.
 */

const fsSpy = vi.hoisted(() => ({ on: false, touched: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const names = [
		"readFileSync",
		"statSync",
		"lstatSync",
		"existsSync",
		"openSync",
		"readSync",
		"readdirSync",
		"createReadStream",
		"readFile",
		"stat",
		"open",
	] as const;
	const wrapped: Record<string, unknown> = {};
	for (const name of names) {
		const fn = real[name] as (...args: unknown[]) => unknown;
		wrapped[name] = (...args: unknown[]) => {
			if (fsSpy.on) fsSpy.touched.push(`${name} ${String(args[0])}`);
			return fn(...args);
		};
	}
	return { ...real, ...wrapped, default: { ...real, ...wrapped } };
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs/promises")>();
	const wrapped: Record<string, unknown> = {};
	for (const name of ["readFile", "open", "stat", "readdir"] as const) {
		const fn = real[name] as (...args: unknown[]) => unknown;
		wrapped[name] = (...args: unknown[]) => {
			if (fsSpy.on) fsSpy.touched.push(`${name} ${String(args[0])}`);
			return fn(...args);
		};
	}
	return { ...real, ...wrapped, default: { ...real, ...wrapped } };
});

const CWD = "/work/project";
const HOME = "/sessions/2026-10-01T00-00-00-000Z_home.jsonl";
const HOME2 = "/sessions/2026-10-01T00-00-01-000Z_rollcall.jsonl";
const TASK = "/sessions/2026-10-01T00-00-02-000Z_task-34.jsonl";
const TASK2 = "/sessions/2026-10-01T00-00-03-000Z_task-35.jsonl";
const USER = "/sessions/2026-10-01T00-00-04-000Z_user.jsonl";

const plan = (title: string) => ({
	title,
	goal: "-",
	doneWhen: "-",
	decided: "-",
	steps: "-",
	verify: "-",
	mustNot: "-",
});
type Status = UiTaskQueue["tasks"][number]["status"];
/** A queue chat's queue: its tasks, each with the chat it runs in. */
const homeQueue = (...tasks: Array<[id: number, status: Status, chat?: string]>): UiTaskQueue => ({
	running: true,
	available: true,
	tasks: tasks.map(([id, status, chat]) => ({
		id,
		status,
		plan: plan(`Task ${id}`),
		addedAt: id,
		...(chat ? { chat: { file: chat, title: `Queue #${id}` } } : {}),
	})),
});
/** A task's own chat's queue: its one task, and the queue it came from. */
const taskQueue = (from: string, status: Status = "working", id = 34): UiTaskQueue => ({
	running: status !== "done",
	available: true,
	from: { file: from, title: "tooling" },
	tasks: [{ id, status, plan: plan(`Task ${id}`), addedAt: 1 }],
});

describe("queueHomesFrom: the links, from the open chats' cached queues", () => {
	const none: ReadonlyMap<string, string> = new Map();

	it("a task's own chat names its queue chat; a closed task has no link", () => {
		const loaded: LoadedQueue[] = [{ file: TASK, queue: taskQueue(HOME) }];
		expect([...queueHomesFrom(loaded, none)]).toEqual([[TASK, HOME]]);
		for (const status of ["ready", "working", "stuck", "waiting"] as const) {
			expect(queueHomesFrom([{ file: TASK, queue: taskQueue(HOME, status) }], none).get(TASK)).toBe(HOME);
		}
		const known = new Map([[TASK, HOME]]);
		expect(queueHomesFrom([{ file: TASK, queue: taskQueue(HOME, "done") }], known).size).toBe(0);
	});

	it("a queue chat lists its open tasks' chats; the ones it no longer lists open go", () => {
		const open = homeQueue([33, "done", TASK2], [34, "working", TASK], [35, "ready"]);
		const links = queueHomesFrom([{ file: HOME, queue: open }], new Map([[TASK2, HOME]]));
		expect([...links]).toEqual([[TASK, HOME]]);
		// Task 34 removed from the queue: no longer listed at all.
		expect(queueHomesFrom([{ file: HOME, queue: homeQueue([33, "done", TASK2]) }], links).size).toBe(0);
		// Another queue's links aren't touched.
		const other = new Map([[TASK2, HOME2]]);
		expect(queueHomesFrom([{ file: HOME, queue: homeQueue() }], other)).toBe(other);
	});

	it("the task's own chat has the last word on its task", () => {
		// The queue chat hasn't heard of the chat yet (pi-queue writes the chat's first entry first).
		const early: LoadedQueue[] = [
			{ file: HOME, queue: homeQueue([34, "working"]) },
			{ file: TASK, queue: taskQueue(HOME) },
		];
		expect(queueHomesFrom(early, new Map()).get(TASK)).toBe(HOME);
		// The task chat says done before the queue chat has caught up.
		const late: LoadedQueue[] = [
			{ file: HOME, queue: homeQueue([34, "working", TASK]) },
			{ file: TASK, queue: taskQueue(HOME, "done") },
		];
		expect(queueHomesFrom(late, new Map()).size).toBe(0);
	});

	it("a chat whose queue isn't worked out yet, or that has none, changes nothing; unchanged = the same map", () => {
		const known = new Map([[TASK, HOME]]);
		expect(queueHomesFrom([{ file: TASK, queue: undefined }], known)).toBe(known);
		expect(queueHomesFrom([{ file: USER, queue: homeQueue() }], known)).toBe(known);
		expect(queueHomesFrom([{ file: TASK, queue: taskQueue(HOME) }], known)).toBe(known);
		// A chat can't be its own home.
		expect(queueHomesFrom([{ file: HOME, queue: taskQueue(HOME) }], new Map()).size).toBe(0);
	});

	it(`keeps at most ${QUEUE_HOMES_MAX} links, the oldest go first`, () => {
		const known = new Map(
			Array.from({ length: QUEUE_HOMES_MAX }, (_, i) => [`/s/t${i}.jsonl`, HOME] as [string, string]),
		);
		const next = queueHomesFrom([{ file: TASK, queue: taskQueue(HOME2) }], known);
		expect(next.size).toBe(QUEUE_HOMES_MAX);
		expect(next.has("/s/t0.jsonl")).toBe(false);
		expect(next.get(TASK)).toBe(HOME2);
	});

	it("queueLinksSig changes only with what the queue says about the links", () => {
		const a = homeQueue([34, "working", TASK]);
		expect(queueLinksSig(a)).toBe(queueLinksSig({ ...a, running: false }));
		expect(queueLinksSig(a)).not.toBe(queueLinksSig(homeQueue([34, "done", TASK])));
		expect(queueLinksSig(taskQueue(HOME))).not.toBe(queueLinksSig(taskQueue(HOME, "done")));
		expect(queueLinksSig(taskQueue(HOME, "working"))).toBe(queueLinksSig(taskQueue(HOME, "stuck")));
		expect(queueLinksSig(undefined)).toBe("");
	});
});

describe("applyQueueHomes: rows only", () => {
	const row = (id: string, sessionPath?: string, extra: Partial<ConversationSummary> = {}): ConversationSummary => ({
		id,
		title: id,
		cwd: CWD,
		messageCount: 1,
		isStreaming: false,
		isSubagent: false,
		...(sessionPath ? { sessionPath } : {}),
		...extra,
	});

	it("a task row gets the id of its queue chat's row; a home that isn't listed leaves it a normal row", () => {
		const rows = [row("c1", HOME), row("c2", TASK), row(`recent:${TASK2}`, TASK2), row("c3", USER)];
		applyQueueHomes(
			rows,
			new Map([
				[TASK, HOME],
				[TASK2, HOME2],
			]),
		);
		expect(rows.map((r) => r.queueHomeId)).toEqual([undefined, "c1", undefined, undefined]);
	});

	it("subagents and rows without a transcript are left alone", () => {
		const rows = [row("c1", HOME), row("k", TASK, { isSubagent: true, parentId: "c1" }), row("mem")];
		applyQueueHomes(rows, new Map([[TASK, HOME]]));
		expect(rows.map((r) => r.queueHomeId)).toEqual([undefined, undefined, undefined]);
	});
});

// ── The server's own list, on stand-in windows ─────────────────────────────────────────────────────────

interface FakeConv {
	id: string;
	title: string;
	cwd: string;
	listed: boolean;
	promptedSinceActive: boolean;
	isSubagent?: boolean;
	parentId?: string;
	createdAt?: number;
	taskQueueCache?: { key: string; sig: string; queue: UiTaskQueue };
	session: {
		sessionFile: string | undefined;
		isStreaming: boolean;
		isCompacting: boolean;
		getSessionStats(): { totalMessages: number };
		sessionManager: {
			getEntries(): unknown[];
			getBranch(): unknown[];
			getLeafId(): string | null;
			getSessionId(): string;
		};
		extensionRunner?: { getCommand(name: string): unknown };
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
	emit(msg: ServerMessage): void;
	shownInRunningList(conv: FakeConv): boolean;
	recentHistoryRows(live: Set<string>, waiting: Set<string>): ConversationSummary[];
	subagentRunOutcome(): Record<string, unknown>;
	getPendingQuestionForConv(): undefined;
	tldrOf(): [];
	identityOf(): undefined;
}

type Proto = {
	emitConversations(this: Win): void;
	shownInRunningList(this: Win, conv: FakeConv): boolean;
	recentHistoryRows(this: Win, live: Set<string>, waiting: Set<string>): ConversationSummary[];
};
const proto = ClientSession.prototype as unknown as Proto;
/** The server-wide state this patch keeps on ClientSession (private statics). */
const statics = ClientSession as unknown as {
	sharedConvs: Map<string, FakeConv>;
	queueHomes: ReadonlyMap<string, string> | null;
	queueHomesStore: ClientStateStore | null;
	queueHomesTimer: ReturnType<typeof setTimeout> | null;
	refreshQueueHomes(): void;
	taskQueueOfConv(conv: FakeConv): UiTaskQueue;
};

let dir = "";
let store: ClientStateStore;
let walks = 0;

function conv(id: string, file: string | undefined, queue?: UiTaskQueue, extra: Partial<FakeConv> = {}): FakeConv {
	const c: FakeConv = {
		id,
		title: `chat ${id}`,
		cwd: CWD,
		listed: true,
		promptedSinceActive: false,
		...(queue ? { taskQueueCache: { key: `cached ${id}`, sig: JSON.stringify(queue), queue } } : {}),
		session: {
			sessionFile: file,
			isStreaming: false,
			isCompacting: false,
			getSessionStats: () => {
				throw new Error("getSessionStats() must not be called");
			},
			sessionManager: {
				getEntries: () => [],
				getBranch: () => {
					walks++;
					return [];
				},
				getLeafId: () => null,
				getSessionId: () => id,
			},
		},
		dialogs: { current: null },
		...extra,
	};
	statics.sharedConvs.set(id, c);
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

/** A browser window over the server's chat table; `history`: what it last read from disk (Recent chats). */
function win(activeId: string, history: string[] = []): Win {
	return {
		clientId: "browser",
		cwd: CWD,
		activeId,
		convs: statics.sharedConvs,
		stateStore: store,
		recentSessions: history.map((p, i) => summary(p, 1_000_000 - i)),
		emitted: [],
		disposed: false,
		emit(msg) {
			this.emitted.push(msg);
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
	};
}

/** The chat list a window shows now. */
function rows(w: Win): ConversationSummary[] {
	proto.emitConversations.call(w);
	const last = [...w.emitted].reverse().find((m) => m.type === "conversations");
	expect(last).toBeTruthy();
	return (last as Extract<ServerMessage, { type: "conversations" }>).conversations;
}
const rowFor = (list: ConversationSummary[], file: string) => list.find((r) => r.sessionPath === file);
/** The row id a task chat's row hangs under (undefined: a normal row). */
const homeIdOf = (list: ConversationSummary[], file: string) => rowFor(list, file)?.queueHomeId;

/** A server restart, as far as this patch is concerned: the links are read from the client state again. */
function restart(): void {
	statics.queueHomes = null;
	store = new ClientStateStore(join(dir, "client-state.json"));
	statics.queueHomesStore = store;
	statics.sharedConvs.clear();
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-web-queue-groups."));
	store = new ClientStateStore(join(dir, "client-state.json"));
	statics.sharedConvs.clear();
	statics.queueHomes = null;
	statics.queueHomesStore = store;
	walks = 0;
	fsSpy.on = false;
	fsSpy.touched = [];
});

afterEach(() => {
	if (statics.queueHomesTimer) clearTimeout(statics.queueHomesTimer);
	statics.queueHomesTimer = null;
	statics.sharedConvs.clear();
	statics.queueHomes = null;
	statics.queueHomesStore = null;
	vi.useRealTimers();
	rmSync(dir, { recursive: true, force: true });
});

describe("queue-grouping: the server's chat list", () => {
	it("from the task chat's side: an open task's chat hangs under the queue chat it came from", () => {
		const home = conv("c1", HOME, homeQueue([34, "working"]));
		conv("c2", TASK, taskQueue(HOME));
		conv("c3", USER);
		statics.refreshQueueHomes();
		const list = rows(win("c3"));
		expect(homeIdOf(list, TASK)).toBe(home.id);
		expect(homeIdOf(list, HOME)).toBeUndefined();
		expect(homeIdOf(list, USER)).toBeUndefined();
		// Kept for later (restarts): the server's client state.
		expect(store.getQueueHomes()).toEqual({ [TASK]: HOME });
	});

	it("from the queue chat's side: a task chat that is only a Recent chats row hangs under it too", () => {
		const home = conv("c1", HOME, homeQueue([34, "waiting", TASK], [35, "stuck", TASK2]));
		statics.refreshQueueHomes();
		const list = rows(win("c1", [TASK, TASK2, USER]));
		expect(rowFor(list, TASK)?.live).toBe(false);
		expect(homeIdOf(list, TASK)).toBe(home.id);
		expect(homeIdOf(list, TASK2)).toBe(home.id);
		expect(homeIdOf(list, USER)).toBeUndefined();
	});

	it("a queue chat that is only a Recent chats row still gathers its open tasks' chats", () => {
		conv("c2", TASK, taskQueue(HOME));
		statics.refreshQueueHomes();
		const list = rows(win("c2", [HOME]));
		expect(homeIdOf(list, TASK)).toBe(`recent:${HOME}`);
		expect(rowFor(list, HOME)?.id).toBe(`recent:${HOME}`);
	});

	it("a task chat whose queue chat isn't in the list stays a normal row", () => {
		conv("c2", TASK, taskQueue(HOME));
		statics.refreshQueueHomes();
		const list = rows(win("c2"));
		expect(rowFor(list, TASK)).toBeTruthy();
		expect(homeIdOf(list, TASK)).toBeUndefined();
	});

	it("a finished or removed task's link goes", () => {
		const task = conv("c2", TASK, taskQueue(HOME));
		const home = conv("c1", HOME, homeQueue([34, "working", TASK], [35, "working", TASK2]));
		statics.refreshQueueHomes();
		expect(homeIdOf(rows(win("c1", [TASK2])), TASK2)).toBe("c1");
		// Task 34 says it's done; task 35 was taken out of the queue.
		const done = taskQueue(HOME, "done");
		task.taskQueueCache = { key: "k2", sig: JSON.stringify(done), queue: done };
		const after = homeQueue([34, "done", TASK]);
		home.taskQueueCache = { key: "k3", sig: JSON.stringify(after), queue: after };
		statics.refreshQueueHomes();
		const list = rows(win("c1", [TASK2]));
		expect(homeIdOf(list, TASK)).toBeUndefined();
		expect(homeIdOf(list, TASK2)).toBeUndefined();
		expect(store.getQueueHomes()).toEqual({});
	});

	it("subagents keep their parent link and get no queue link", () => {
		conv("c1", HOME, homeQueue([34, "working", TASK]));
		conv("c2", TASK, taskQueue(HOME));
		conv("k1", undefined, undefined, { isSubagent: true, parentId: "c2" });
		statics.refreshQueueHomes();
		const list = rows(win("c1"));
		const kid = list.find((r) => r.id === "k1");
		expect(kid?.parentId).toBe("c2");
		expect(kid?.queueHomeId).toBeUndefined();
		expect(homeIdOf(list, TASK)).toBe("c1");
	});

	it("the links survive a restart: chats that are only Recent chats rows stay grouped", () => {
		conv("c1", HOME, homeQueue([34, "working", TASK]));
		conv("c2", TASK, taskQueue(HOME));
		statics.refreshQueueHomes();
		restart();
		conv("c9", USER);
		const list = rows(win("c9", [TASK, HOME]));
		expect(homeIdOf(list, TASK)).toBe(`recent:${HOME}`);
	});

	it("building the list reads no chat file and walks no chat's history", () => {
		conv("c1", HOME, homeQueue([34, "working", TASK], [35, "waiting", TASK2]));
		conv("c2", TASK, taskQueue(HOME));
		conv("c3", USER);
		statics.refreshQueueHomes();
		expect(walks).toBe(0);
		const w = win("c3", [TASK2, HOME2]);
		rows(w); // warm (message counts and the like are worked out once per change)
		fsSpy.touched = [];
		fsSpy.on = true;
		const list = rows(w);
		rows(w);
		fsSpy.on = false;
		expect(homeIdOf(list, TASK)).toBe("c1");
		expect(homeIdOf(list, TASK2)).toBe("c1");
		const chatFiles = [HOME, HOME2, TASK, TASK2, USER];
		expect(fsSpy.touched.filter((t) => chatFiles.some((f) => t.includes(f)))).toEqual([]);
		expect(fsSpy.touched.filter((t) => t.includes("/sessions/"))).toEqual([]);
		expect(walks).toBe(0);
		// The spy does see the server's reads: a restarted server reads the kept links from its client state.
		fsSpy.on = true;
		restart();
		conv("c3", USER);
		expect(homeIdOf(rows(win("c3", [TASK, HOME])), TASK)).toBe(`recent:${HOME}`);
		fsSpy.on = false;
		expect(fsSpy.touched.some((t) => t.startsWith("readFileSync") && t.endsWith("client-state.json"))).toBe(true);
	});

	it("taskQueueOfConv's cache feeds the links: a chat's queue worked out anew brings its link in", () => {
		vi.useFakeTimers();
		const assigned = {
			type: "custom",
			customType: "queue",
			id: "q1",
			parentId: null,
			timestamp: "2026-10-01T00:00:00.500Z",
			data: { v: 1, ts: 1, op: "assigned", id: 34, plan: plan("Task 34"), touches: ["a repo"], from: { file: HOME } },
		};
		conv("c1", HOME);
		const task = conv("c2", TASK);
		task.session.sessionManager.getBranch = () => [assigned];
		task.session.sessionManager.getLeafId = () => "q1";
		expect(statics.taskQueueOfConv(task).from?.file).toBe(HOME);
		// Not yet: the links are worked out a moment later, once for a burst of changes.
		expect(homeIdOf(rows(win("c1")), TASK)).toBeUndefined();
		vi.advanceTimersByTime(60);
		expect(homeIdOf(rows(win("c1")), TASK)).toBe("c1");
		// The same queue again (cached): no new look.
		expect(statics.queueHomesTimer).toBeNull();
		statics.taskQueueOfConv(task);
		expect(statics.queueHomesTimer).toBeNull();
	});
});
