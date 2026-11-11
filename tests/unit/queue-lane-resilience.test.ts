import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, type MockInstance, vi } from "vitest";
import type { OwnerTelegramNotice } from "../../server/owner-telegram.js";
import {
	type QueueLaneClient,
	type QueueLaneHostContext,
	type QueueLaneSessionView,
	type QueueOpenedTaskChat,
	queueRoleLane,
	runQueueCloseChat,
	runQueueCommand,
	runQueueStartChat,
} from "../../server/queue-chat-lane.js";
import type { QueueChatStart } from "../../server/queue-host.js";
import {
	type QueueChatActivity,
	QueueLaneWatchdogError,
	type QueueLaneTuning,
	QUEUE_WATCHDOG_LOG_PREFIX,
} from "../../server/queue-lane-watchdog.js";

/**
 * queue-resilience (Architecture #516, ~/architecture-dept/conventions/queue-resilience.md section 2.6):
 * Q-ASSERT-1..6, written failing-first by Ops #812 against the seam's lane entry points, which still carry the
 * base behaviour (three process-wide chains, two shared pseudo clients, no watchdog, no alarm). Ops #813 makes
 * them pass and may not delete or weaken them (Rule 18).
 *
 * On 2026-11-10 21:17-21:47 PST one role's stuck task chat held the global queueTasksChain and no task chat
 * opened for any of the 15 roles for 30 minutes, with no alarm. No model, no port: the lane entry points run on
 * a stand-in host whose pseudo clients open chats as each test says.
 */

/** agent-service.ts at the base commit d552c1c9 (Q-MOD-1: must not grow). Update only when rebasing onto a newer base. */
const AGENT_SERVICE_BASE_LINES = 21985;
const WT_SIZE_LIMIT = 500;

let dir = "";
const at = (name: string) => join(dir, name);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = <T>() => new Promise<T>(() => {});

function gate() {
	let open!: () => void;
	const promise = new Promise<void>((r) => {
		open = r;
	});
	return { promise, open };
}

interface Tracked<T> {
	state: "pending" | "fulfilled" | "rejected";
	value?: T;
	error?: unknown;
	startedAt: number;
	settledAt?: number;
}
function track<T>(p: Promise<T>): Tracked<T> {
	const t: Tracked<T> = { state: "pending", startedAt: Date.now() };
	p.then(
		(value) => Object.assign(t, { state: "fulfilled", value, settledAt: Date.now() }),
		(error) => Object.assign(t, { state: "rejected", error, settledAt: Date.now() }),
	);
	return t;
}
async function until(done: () => boolean, ms: number): Promise<void> {
	const end = Date.now() + ms;
	while (!done() && Date.now() < end) await sleep(2);
}
const took = (t: Tracked<unknown>) =>
	t.settledAt === undefined ? Number.POSITIVE_INFINITY : t.settledAt - t.startedAt;

/** Physical lines, as wc -l counts them. */
function lineCount(rel: string): number {
	const text = readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

const ROLES = ["architecture", "ops", "design", "product", "backend", "qa", "security"] as const;
type Role = (typeof ROLES)[number];
const homeOf = (role: Role) => at(`home-${role}.jsonl`);

const assignedEntry = (role: Role, id: number) => ({
	customType: "queue",
	data: { v: 1, op: "assigned", id, from: { file: homeOf(role), title: role }, ts: 1 },
});
const startOf = (role: Role, id: number): QueueChatStart => ({
	cwd: "/work/project",
	name: `Task ${id}`,
	prompt: `work on task ${id}`,
	entries: [assignedEntry(role, id)],
	onPrepared: () => true,
});

interface Entered {
	clientId: string;
	role: string;
	taskId: number;
	at: number;
}

interface FakeChat {
	role: Role;
	activity: QueueChatActivity;
	view: QueueLaneSessionView;
	dispose: Mock<() => void>;
}

/** The queue host as AgentService has it, with stand-in pseudo clients and one browser window. */
function makeHost(opts: { tuning?: QueueLaneTuning; closeDeadlineMs?: number; heapMB?: number; rssMB?: number } = {}) {
	const entered: Entered[] = [];
	const homeClients: string[] = [];
	const alarms: Array<OwnerTelegramNotice & { at: number }> = [];
	const chats = new Map<string, FakeChat>();
	const removeConversation = vi.fn((_file: string) => {});
	/** How a task's chat opens: by "<role>#<id>"; default: at once, its first turn under way. */
	const opens = new Map<string, (o: QueueChatStart) => Promise<QueueOpenedTaskChat>>();
	const releaseQueueChat = vi.fn((file: string) => {
		const c = chats.get(file);
		if (!c) return false;
		removeConversation(file);
		c.dispose();
		chats.delete(file);
		return true;
	});
	const roleOfStart = (o: QueueChatStart) => {
		const from = (o.entries[0]?.data as { from?: { file?: string } }).from?.file;
		return ROLES.find((r) => homeOf(r) === from) ?? "?";
	};
	const client = (clientId: string): QueueLaneClient => ({
		async openTaskChat(o) {
			const role = roleOfStart(o);
			const taskId = (o.entries[0]?.data as { id: number }).id;
			entered.push({ clientId, role, taskId, at: Date.now() });
			const how = opens.get(`${role}#${taskId}`);
			if (how) return how(o);
			if (o.launch) o.onPrepared?.(o.launch);
			return {
				sessionFile: at(`${role}-task-${taskId}.jsonl`),
				conversationId: `c${taskId}`,
				started: Promise.resolve(),
			};
		},
		async openChatForQueue(file) {
			homeClients.push(clientId);
			return {
				sessionManager: { getEntries: () => [] },
				extensionRunner: { getCommand: () => ({}) },
				prompt: async () => {},
			};
		},
	});
	const host: QueueLaneHostContext = {
		clients: new Map([["desk", { releaseQueueChat }]]),
		stateStore: { removeRecent: () => {} },
		queueSessionFor: (file) => chats.get(file)?.view ?? null,
		withQueueClient: (clientId, fn) => fn(client(clientId)),
		queueLaneRoles: {
			roleOfHomeChat: (file) => ROLES.find((r) => homeOf(r) === file),
			roleOfOpenChat: (file) => chats.get(file)?.role,
		},
		...(opts.tuning ? { queueLaneTuning: opts.tuning } : {}),
		...(opts.closeDeadlineMs ? { queueCloseDeadlineMs: opts.closeDeadlineMs } : {}),
		queueChatActivity: (file) => chats.get(file)?.activity ?? null,
		sendQueueAlarm: async (notice) => {
			alarms.push({ ...notice, at: Date.now() });
			return { ok: true, messageIds: [alarms.length] };
		},
		queueMemoryUsage: () => ({ heapUsed: (opts.heapMB ?? 512) * 1024 * 1024, rss: (opts.rssMB ?? 900) * 1024 * 1024 }),
	};
	/** A task chat that is open in a window (its transcript written to disk). */
	const addChat = (role: Role, file: string, activity: QueueChatActivity) => {
		const entries = [
			{ type: "custom", ...assignedEntry(role, 1) },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
		];
		writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
		const chat: FakeChat = {
			role,
			activity,
			dispose: vi.fn<() => void>(),
			view: {
				get isStreaming() {
					return activity.isStreaming === true;
				},
				get isCompacting() {
					return activity.isCompacting === true;
				},
				sessionManager: { getEntries: () => entries },
			},
		};
		chats.set(file, chat);
		return chat;
	};
	return { host, entered, homeClients, alarms, chats, opens, addChat, releaseQueueChat, removeConversation };
}

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-web-queue-lanes."));
	for (const r of ROLES) writeFileSync(homeOf(r), "");
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

describe("queue-resilience: one role's stuck lane never stops the others (Architecture #516)", () => {
	// Q-ASSERT-1 (Q-ISO-1, Q-ISO-1a, Q-LANE-1)
	it("Q-ASSERT-1: a role blocked inside openTaskChat doesn't hold up another role's startChat", async () => {
		const h = makeHost();
		const stuck = gate();
		// architecture's task chat hangs before onPrepared (the 2026-11-10 arch #510 stall).
		h.opens.set("architecture#1", async () => {
			await stuck.promise;
			return { sessionFile: at("a1.jsonl"), conversationId: "a1", started: Promise.resolve() };
		});
		try {
			const arch = track(runQueueStartChat(h.host, startOf("architecture", 1)));
			await sleep(10);
			const ops = track(runQueueStartChat(h.host, startOf("ops", 2)));
			await until(() => ops.state !== "pending", 100);
			expect({
				opsState: ops.state,
				opsUnder100ms: took(ops) < 100,
				opsClient: h.entered.find((e) => e.taskId === 2)?.clientId,
				archState: arch.state,
				archClient: h.entered.find((e) => e.taskId === 1)?.clientId,
			}).toEqual({
				opsState: "fulfilled",
				opsUnder100ms: true,
				opsClient: "carry-on:queue:ops",
				archState: "pending",
				archClient: "carry-on:queue:architecture",
			});
		} finally {
			stuck.open();
		}
	});

	// Q-ASSERT-2 (Q-ISO-1, Q-LANE-1)
	it("Q-ASSERT-2: a role holding its close and home lanes doesn't hold up another role's close or /queue command", async () => {
		const h = makeHost();
		const hold = gate();
		void queueRoleLane(h.host, "architecture", "close")(() => hold.promise);
		void queueRoleLane(h.host, "architecture", "home")(() => hold.promise);
		const opsTask = at("ops-done-task.jsonl");
		h.addChat("ops", opsTask, { isStreaming: false });
		try {
			const close = track(runQueueCloseChat(h.host, opsTask, () => {}));
			const command = track(runQueueCommand(h.host, homeOf("ops"), "/queue ping"));
			await until(() => close.state !== "pending" && command.state !== "pending", 100);
			expect({
				closeState: close.state,
				closed: close.value,
				closeUnder100ms: took(close) < 100,
				commandState: command.state,
				ran: command.value,
				commandUnder100ms: took(command) < 100,
				homeClient: h.homeClients[0],
			}).toEqual({
				closeState: "fulfilled",
				closed: true,
				closeUnder100ms: true,
				commandState: "fulfilled",
				ran: true,
				commandUnder100ms: true,
				homeClient: "carry-on:queue-home:ops",
			});
		} finally {
			hold.open();
		}
	});

	// Q-ASSERT-3 (Q-ISO-2, Q-ISO-3)
	it("Q-ASSERT-3: past the open ceiling roles wait in FIFO order and are never dropped", async () => {
		const h = makeHost({ tuning: { maxConcurrentOpens: 4 } });
		const blockers: Role[] = ["architecture", "design", "product", "backend"];
		const gates = new Map(blockers.map((r) => [r, gate()]));
		for (const [i, r] of blockers.entries())
			h.opens.set(`${r}#${i + 1}`, async () => {
				await gates.get(r)?.promise;
				return { sessionFile: at(`${r}.jsonl`), conversationId: r, started: Promise.resolve() };
			});
		// #813: qa keeps the place it is given until its gate opens, so only FIFO order (not a quick qa open
		// handing the place straight on, as Q-LANE-1 says it must) can keep security waiting.
		gates.set("qa", gate());
		h.opens.set("qa#5", async () => {
			await gates.get("qa")?.promise;
			return { sessionFile: at("qa.jsonl"), conversationId: "qa", started: Promise.resolve() };
		});
		try {
			const blocked = blockers.map((r, i) => track(runQueueStartChat(h.host, startOf(r, i + 1))));
			await sleep(20);
			const qa = track(runQueueStartChat(h.host, startOf("qa", 5)));
			await sleep(5);
			const security = track(runQueueStartChat(h.host, startOf("security", 6)));
			await sleep(30);
			const activeOpens = h.entered.length;
			const queuedBefore = {
				qa: qa.state,
				security: security.state,
				qaEntered: h.entered.some((e) => e.role === "qa"),
			};
			gates.get("design")?.open();
			await until(() => h.entered.some((e) => e.role === "qa"), 50);
			const qaEnteredAfterOne = h.entered.some((e) => e.role === "qa");
			const securityEnteredAfterOne = h.entered.some((e) => e.role === "security");
			for (const g of gates.values()) g.open();
			await until(() => [...blocked, qa, security].every((t) => t.state !== "pending"), 200);
			expect({
				activeOpens,
				enteredFirst: h.entered
					.slice(0, 4)
					.map((e) => e.role)
					.sort(),
				queuedBefore,
				qaEnteredAfterOne,
				securityEnteredAfterOne,
				allStarted: [...blocked, qa, security].map((t) => t.state),
			}).toEqual({
				activeOpens: 4,
				enteredFirst: [...blockers].sort(),
				queuedBefore: { qa: "pending", security: "pending", qaEntered: false },
				qaEnteredAfterOne: true,
				securityEnteredAfterOne: false,
				allStarted: Array(6).fill("fulfilled"),
			});
		} finally {
			for (const g of gates.values()) g.open();
		}
	});

	// Q-ASSERT-4 (Q-WATCHDOG-1, Q-WATCHDOG-2)
	it("Q-ASSERT-4: the watchdog frees a stalled lane, logs it and rotates the role's pseudo client", async () => {
		const h = makeHost({ tuning: { laneDeadlineMs: 50 } });
		h.opens.set("architecture#1", () => never());
		const first = track(runQueueStartChat(h.host, startOf("architecture", 1)));
		await sleep(5);
		const second = track(runQueueStartChat(h.host, startOf("architecture", 2)));
		await until(() => first.state !== "pending" && second.state !== "pending", 400);
		const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith(QUEUE_WATCHDOG_LOG_PREFIX));
		const logged = line ? JSON.parse(line.slice(QUEUE_WATCHDOG_LOG_PREFIX.length)) : null;
		const err = first.error as { code?: string } | undefined;
		expect({
			firstState: first.state,
			firstIsWatchdogError: first.error instanceof QueueLaneWatchdogError,
			firstCode: err?.code,
			firstAfterDeadline: took(first) >= 50,
			logged: logged && { role: logged.role, lane: logged.lane, action: logged.action },
			secondState: second.state,
			firstClient: h.entered.find((e) => e.taskId === 1)?.clientId,
			secondClient: h.entered.find((e) => e.taskId === 2)?.clientId,
		}).toEqual({
			firstState: "rejected",
			firstIsWatchdogError: true,
			firstCode: "QUEUE_LANE_STALL_TIMEOUT",
			firstAfterDeadline: true,
			logged: { role: "architecture", lane: "open", action: "lane_freed" },
			secondState: "fulfilled",
			firstClient: "carry-on:queue:architecture",
			secondClient: "carry-on:queue:architecture:g1",
		});
	});

	// Q-ASSERT-5 (Q-ALARM-1, Q-ALARM-2, Q-HEAP-2)
	it("Q-ASSERT-5: the owner is alarmed through telegram_send, once per role and lane within the cooldown", async () => {
		const h = makeHost({
			tuning: { laneDeadlineMs: 50, startTurnDeadlineMs: 50, alarmCooldownMs: 60_000 },
			heapMB: 3686,
			rssMB: 4608,
		});
		h.opens.set("architecture#1", () => never());
		h.opens.set("architecture#2", () => never());
		// ops: Phase B, its first turn never starts (and the chat isn't working).
		h.opens.set("ops#3", async () => ({ sessionFile: at("ops-3.jsonl"), conversationId: "o3", started: never() }));
		const t0 = Date.now();
		const a1 = track(runQueueStartChat(h.host, startOf("architecture", 1)));
		const a2 = track(runQueueStartChat(h.host, startOf("architecture", 2)));
		const o3 = track(runQueueStartChat(h.host, startOf("ops", 3)));
		await until(() => [a1, a2, o3].every((t) => t.state !== "pending"), 400);
		await sleep(20);
		const arch = h.alarms.filter((a) => a.from === "architecture");
		const ops = h.alarms.filter((a) => a.from === "ops");
		const text = arch[0]?.text ?? "";
		expect({
			stalls: [a1, a2, o3].map((t) => t.state),
			archAlarms: arch.length,
			archWithin50msOfExpiry: arch[0] ? arch[0].at - (t0 + 50) < 50 : false,
			archLinkLabel: arch[0]?.linkLabel,
			text: {
				role: text.includes("Queue stall in architecture"),
				lane: text.includes(": open ("),
				seconds: /made no progress for \d+(\.\d)?s \(limit \d+(\.\d)?s\)/.test(text),
				keepsChats: text.includes("without closing active chats"),
				heap: text.includes("heap 3686MB, rss 4608MB"),
				action: text.includes("pi-web-deploy restart"),
			},
			opsAlarms: ops.length,
			opsLinkLabel: ops[0]?.linkLabel,
		}).toEqual({
			stalls: ["rejected", "rejected", "rejected"],
			archAlarms: 1,
			archWithin50msOfExpiry: true,
			archLinkLabel: "Open Queue",
			text: { role: true, lane: true, seconds: true, keepsChats: true, heap: true, action: true },
			opsAlarms: 1,
			opsLinkLabel: "Open Queue",
		});
	});

	// Q-ASSERT-6 (Q-WATCHDOG-3, Ops #771; Q-MOD-1 WT-SIZE-500)
	it.each([
		["isStreaming", { isStreaming: true }],
		["sendsInFlight", { sendsInFlight: 1 }],
	] as const)(
		"Q-ASSERT-6: a working chat (%s) is never closed or disposed when every deadline expires",
		async (_, activity) => {
			const h = makeHost({ tuning: { laneDeadlineMs: 50, startTurnDeadlineMs: 50 }, closeDeadlineMs: 80 });
			const conv1 = at("architecture-task-1.jsonl");
			const chat1 = h.addChat("architecture", conv1, { ...activity });
			// Its first turn never reports started (Phase B), yet the chat is at work.
			h.opens.set("architecture#1", async () => ({ sessionFile: conv1, conversationId: "conv1", started: never() }));
			const first = track(runQueueStartChat(h.host, startOf("architecture", 1)));
			const close = track(runQueueCloseChat(h.host, conv1, () => {}));
			await sleep(5);
			const second = track(runQueueStartChat(h.host, startOf("architecture", 2)));
			await until(() => [first, close, second].every((t) => t.state !== "pending"), 2_000);
			const touched = (calls: unknown[][]) => calls.filter((c) => c[0] === conv1).length;
			expect({
				firstState: first.state,
				firstFile: (first.value as { sessionFile?: string } | undefined)?.sessionFile,
				closed: close.value,
				conv2Opened: second.state,
				releaseQueueChat: touched(h.releaseQueueChat.mock.calls),
				removeConversation: touched(h.removeConversation.mock.calls),
				dispose: chat1.dispose.mock.calls.length,
				stillOpen: h.chats.has(conv1),
				sizes: {
					queueChatLane: lineCount("server/queue-chat-lane.ts") <= WT_SIZE_LIMIT,
					queueLaneWatchdog: lineCount("server/queue-lane-watchdog.ts") <= WT_SIZE_LIMIT,
					agentServiceNotGrown: lineCount("server/agent-service.ts") <= AGENT_SERVICE_BASE_LINES,
				},
			}).toEqual({
				firstState: "fulfilled",
				firstFile: conv1,
				closed: false,
				conv2Opened: "fulfilled",
				releaseQueueChat: 0,
				removeConversation: 0,
				dispose: 0,
				stillOpen: true,
				sizes: { queueChatLane: true, queueLaneWatchdog: true, agentServiceNotGrown: true },
			});
		},
	);
});
