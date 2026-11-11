// ---------------------------------------------------------------------------
// queue-chat-lane.ts — the queue's per-role lanes, pseudo clients and open ceiling (Architecture #516)
// ---------------------------------------------------------------------------
// Contract: ~/architecture-dept/conventions/queue-resilience.md. Every role (department) has its own three lanes
// (Q-ISO-1, Q-LANE-1): `open` (opening a queued task's chat), `close` (closing a finished task's chat) and `home`
// (opening a queue chat for a question or a "/queue ..." line). One operation runs on a lane at a time; at most
// MAX_CONCURRENT_ROLE_OPENS roles open task chats at once, the rest wait in FIFO order (Q-ISO-3). Each lane
// operation runs under queue-lane-watchdog.ts's deadlines: a stalled one gets its lane (and ceiling place) taken
// back and the owner paged, without any chat being closed (Q-WATCHDOG-1..3, Q-ALARM-1/2).
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { type QueueChatStart, waitUntil } from "./queue-host.js";
import {
	QUEUE_CLOSE_DEADLINE_MS,
	type QueueChatActivity,
	type QueueLaneKind,
	type QueueLanePhase,
	type QueueLaneWatch,
	QueueLaneWatchdog,
	type QueueWatchdogHost,
	queueChatIsWorking,
	queueTurnUnderWay,
	UNASSIGNED_QUEUE_ROLE,
} from "./queue-lane-watchdog.js";
import { isQueueTaskChatEntries, isQueueTaskChatFile, TASK_QUEUE_ENTRY_TYPE } from "./task-queue.js";
import { chatOf } from "./task-queue-fields.js";

export type QueueLaneChain = <T>(fn: () => Promise<T>) => Promise<T>;

// ---------------------------------------------------------------------------
// Per-role lane keys and pseudo clients (Q-ISO-1, Q-ISO-1a)
// ---------------------------------------------------------------------------

/** Q-ISO-1a: the queue's pseudo clients' base ids (getProjectModel keeps reading QUEUE_TASKS_CLIENT_ID's). */
export const QUEUE_TASKS_CLIENT_ID = "carry-on:queue";
export const QUEUE_HOME_CLIENT_ID = "carry-on:queue-home";

const ROLE_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const PSEUDO_CLIENT = /^carry-on:queue(?:-home)?(?::[A-Za-z0-9_][A-Za-z0-9_.-]*(?::g[1-9][0-9]*)?)?$/;

function checkedRoleKey(roleKey: string): string {
	if (!ROLE_KEY.test(roleKey)) throw new Error(`not a queue lane role key: ${JSON.stringify(roleKey)}`);
	return roleKey;
}

function pseudoClientId(base: string, roleKey: string, gen: number): string {
	if (!Number.isInteger(gen) || gen < 0) throw new Error(`not a pseudo-client generation: ${gen}`);
	return `${base}:${checkedRoleKey(roleKey)}${gen > 0 ? `:g${gen}` : ""}`;
}

/** Q-ISO-1a: a role's task-opening pseudo client; `gen` > 0 after the watchdog rotated it (Q-WATCHDOG-2). */
export function queueTasksClientIdFor(roleKey: string, gen = 0): string {
	return pseudoClientId(QUEUE_TASKS_CLIENT_ID, roleKey, gen);
}

/** Q-ISO-1a: a role's home-chat pseudo client (questions.prepare, queueRunCommand). */
export function queueHomeClientIdFor(roleKey: string, gen = 0): string {
	return pseudoClientId(QUEUE_HOME_CLIENT_ID, roleKey, gen);
}

/** Q-ISO-1a: whether a client id is one of the queue's pseudo clients (global, per role, or rotated). */
export function isQueuePseudoClientId(id: string): boolean {
	return PSEUDO_CLIENT.test(id);
}

/** Q-LANE-1: the key of one role's lane of one kind (at most one operation runs on it at a time, Q-ISO-3). */
export function queueLaneKey(roleKey: string, lane: QueueLaneKind): string {
	return `${checkedRoleKey(roleKey)}/${lane}`;
}

/** Q-ISO-1: where a role is looked up (agent-service: identityRegistry + homeChatOf, open conversations). */
export interface QueueLaneRoleLookup {
	/** The role whose home chat (queue chat) this transcript is (homeChatOf). */
	roleOfHomeChat(file: string): string | undefined;
	/** The role of an open chat: its task queue's home chat's role, else its identity. */
	roleOfOpenChat?(file: string): string | undefined;
	/** A task chat's queue chat, from its persisted pi-queue `assigned` entry's `from.file`. */
	queueChatOfTaskFile?(file: string): Promise<string | null | undefined> | string | null | undefined;
}

/** Q-ISO-1: what a lane operation knows about whose it is. */
export interface QueueLaneRoleSource {
	roleId?: string;
	entries?: readonly { customType: string; data: unknown }[];
	file?: string;
}

function usableRole(role: string | null | undefined): string | undefined {
	const r = role?.trim();
	return r && ROLE_KEY.test(r) ? r : undefined;
}

/** The pi-queue `assigned` entry among a task chat's start entries (starting.ts). */
function assignedOf(entries: QueueLaneRoleSource["entries"]): Record<string, unknown> | undefined {
	for (const e of entries ?? []) {
		if (e?.customType !== TASK_QUEUE_ENTRY_TYPE) continue;
		const data = (e.data ?? {}) as Record<string, unknown>;
		if (data.op === "assigned") return data;
	}
	return undefined;
}

/** The queued task's number from its start entries, or null. */
export function queueTaskIdOf(entries: QueueLaneRoleSource["entries"]): number | null {
	const id = assignedOf(entries)?.id;
	return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Q-ISO-1 resolveQueueLaneRoleKey: (1) an explicit roleId; (2) the start entries' queue chat (`from.file`) ->
 * its role; (3) the file: a home chat's role, else the open chat's role, else its persisted queue chat's role;
 * (4) "__unassigned__". Lookups that throw count as no answer.
 */
export async function resolveQueueLaneRoleKey(
	src: QueueLaneRoleSource,
	lookup: QueueLaneRoleLookup | undefined,
): Promise<string> {
	const explicit = usableRole(src.roleId);
	if (explicit) return explicit;
	if (!lookup) return UNASSIGNED_QUEUE_ROLE;
	const ask = async <T>(fn: () => Promise<T> | T): Promise<T | undefined> => {
		try {
			return await fn();
		} catch {
			return undefined;
		}
	};
	const queueChat = chatOf(assignedOf(src.entries)?.from)?.file;
	const fromEntries = queueChat ? usableRole(await ask(() => lookup.roleOfHomeChat(queueChat))) : undefined;
	if (fromEntries) return fromEntries;
	const file = src.file;
	if (!file) return UNASSIGNED_QUEUE_ROLE;
	const home = usableRole(await ask(() => lookup.roleOfHomeChat(file)));
	if (home) return home;
	const open = usableRole(await ask(() => lookup.roleOfOpenChat?.(file)));
	if (open) return open;
	const persisted = await ask(() => lookup.queueChatOfTaskFile?.(file));
	return (persisted && usableRole(await ask(() => lookup.roleOfHomeChat(persisted)))) || UNASSIGNED_QUEUE_ROLE;
}

// ---------------------------------------------------------------------------
// The host as the lanes see it (AgentService; tests give their own)
// ---------------------------------------------------------------------------

export interface QueueCloseSessionView {
	isStreaming?: boolean;
	isCompacting?: boolean;
	sessionManager: {
		getEntries(): unknown[];
		getSessionName?(): string | undefined;
	};
}

export interface QueueCloseClientView {
	releaseQueueChat(file: string): boolean;
}

export interface QueueCloseHostContext extends QueueWatchdogHost {
	clients: Map<string, QueueCloseClientView>;
	stateStore: { removeRecent(path: string): void };
	queueSessionFor(file: string): QueueCloseSessionView | null;
	/** Q-WATCHDOG-1: how long closing waits for a finished task's chat to go idle (default 15 minutes). */
	queueCloseDeadlineMs?: number;
	/** Q-ISO-1: how a lane operation's role is found; missing: every operation is "__unassigned__". */
	queueLaneRoles?: QueueLaneRoleLookup;
	/** Q-WATCHDOG-2/3: what the open chat with this transcript is doing (null: it isn't open). */
	queueChatActivity?(file: string): QueueChatActivity | null;
}

/** An open chat as the home lane runs a "/queue ..." line in it. */
export interface QueueLaneSessionView extends QueueCloseSessionView {
	extensionRunner?: { getCommand?(name: string): unknown } | undefined;
	prompt?(line: string): Promise<unknown>;
}

/** openTaskChat's answer: `started` settles once pi took (or refused) the first prompt (task-chat-start.ts). */
export interface QueueOpenedTaskChat {
	sessionFile: string;
	conversationId: string;
	started: Promise<void>;
}

/** The part of a pseudo client's ClientSession the lanes use. */
export interface QueueLaneClient {
	openTaskChat(o: QueueChatStart): Promise<QueueOpenedTaskChat>;
	openChatForQueue(file: string): Promise<QueueLaneSessionView | null>;
}

/** The queue host as the open and home lanes see it (AgentService). */
export interface QueueLaneHostContext extends QueueCloseHostContext {
	queueSessionFor(file: string): QueueLaneSessionView | null;
	/** Attach the pseudo client `clientId` with a fresh sink, run `fn` through it, detach (withQueueClient). */
	withQueueClient<T>(clientId: string, fn: (cs: QueueLaneClient) => Promise<T>): Promise<T>;
}

/** Q-ISO-1: the role a lane operation belongs to. */
export function queueLaneRoleOf(host: QueueCloseHostContext, src: QueueLaneRoleSource): Promise<string> {
	return resolveQueueLaneRoleKey(src, host.queueLaneRoles);
}

// ---------------------------------------------------------------------------
// One host's lanes and the open ceiling (Q-LANE-1, Q-ISO-3)
// ---------------------------------------------------------------------------

/** One host's lanes: the tail of each (role, lane), its pseudo client's generation, the open ceiling, the watchdog. */
interface QueueLanes {
	tails: Map<string, Promise<void>>;
	gens: Map<string, number>;
	opens: { active: number; waiting: Array<() => void> };
	watchdog: QueueLaneWatchdog;
}

const lanesByHost = new WeakMap<object, QueueLanes>();

function lanesOf(host: QueueCloseHostContext): QueueLanes {
	let lanes = lanesByHost.get(host);
	if (!lanes) {
		const opens = { active: 0, waiting: [] };
		lanes = { tails: new Map(), gens: new Map(), opens, watchdog: new QueueLaneWatchdog(host) };
		lanesByHost.set(host, lanes);
	}
	return lanes;
}

/** Wait for the lane `key`; the answer frees it (the first call; the watchdog's and the operation's may race). */
async function enterLane(lanes: QueueLanes, key: string): Promise<() => void> {
	const before = lanes.tails.get(key) ?? Promise.resolve();
	let free!: () => void;
	const mine = new Promise<void>((r) => {
		free = r;
	});
	const tail = before.then(() => mine);
	lanes.tails.set(key, tail);
	void tail.then(() => {
		if (lanes.tails.get(key) === tail) lanes.tails.delete(key);
	});
	await before;
	return free;
}

/** Q-ISO-3: a place under the open ceiling; `admitted` settles once it is this operation's turn (FIFO, never dropped). */
function joinOpenCeiling(lanes: QueueLanes, max: number): { admitted: Promise<void>; free: () => void } {
	const opens = lanes.opens;
	let inside = false;
	let admit!: () => void;
	const admitted = new Promise<void>((r) => {
		admit = () => {
			inside = true;
			r();
		};
	});
	if (opens.active < max) {
		opens.active++;
		admit();
	} else opens.waiting.push(admit);
	const free = () => {
		if (!inside) return;
		inside = false;
		const next = opens.waiting.shift();
		if (next) next();
		else opens.active--;
	};
	return { admitted, free };
}

/** Q-WATCHDOG-2: the role's next operation on this lane uses a new pseudo client; then the lane is freed. */
function rotateAndFree(lanes: QueueLanes, key: string, gen: number, free: () => void): void {
	if ((lanes.gens.get(key) ?? 0) === gen) lanes.gens.set(key, gen + 1);
	free();
}

/** Q-LANE-1: run `fn` on a role's lane of this kind, no watchdog (the lane entry points below add it). */
export function queueRoleLane(host: QueueCloseHostContext, roleKey: string, lane: QueueLaneKind): QueueLaneChain {
	const key = queueLaneKey(roleKey, lane);
	return async (fn) => {
		const leave = await enterLane(lanesOf(host), key);
		try {
			return await fn();
		} finally {
			leave();
		}
	};
}

/** Q-LANE-1 + Q-WATCHDOG-1/2: `work` on a role's close or home lane under the Phase A deadline. */
async function onRoleLane<T>(
	host: QueueCloseHostContext,
	role: string,
	lane: "close" | "home",
	phase: QueueLanePhase,
	sessionFile: string,
	work: (gen: number, watch: QueueLaneWatch) => Promise<T>,
): Promise<T> {
	const lanes = lanesOf(host);
	const { watchdog } = lanes;
	const key = queueLaneKey(role, lane);
	const leave = await enterLane(lanes, key);
	const gen = lanes.gens.get(key) ?? 0;
	const watch = watchdog.watch({ role, lane, phase, deadlineMs: watchdog.tuning.laneDeadlineMs, sessionFile });
	try {
		return await watchdog.guard(watch, work(gen, watch), () => rotateAndFree(lanes, key, gen, leave));
	} finally {
		watch.stop();
		leave();
	}
}

// ---------------------------------------------------------------------------
// Lane entry points (Q-LANE-1), called by agent-service.ts's queue host
// ---------------------------------------------------------------------------

/**
 * Q-LANE-1 lanes.open: pi-queue's startChat. The role's open lane and a place under the ceiling are held only while
 * the chat opens and its first prompt goes out (Phase A); waiting for pi to take that prompt (Phase B) runs outside
 * them (Ops #629). A Phase A stall frees both and rotates the pseudo client; a Phase B stall answers with the chat
 * when its first turn is under way, else rejects (Q-WATCHDOG-2).
 */
export async function runQueueStartChat(
	host: QueueLaneHostContext,
	o: QueueChatStart,
): Promise<{ sessionFile: string; conversationId?: string }> {
	const role = await queueLaneRoleOf(host, { entries: o.entries });
	const taskId = queueTaskIdOf(o.entries);
	const lanes = lanesOf(host);
	const { watchdog } = lanes;
	const tuning = watchdog.tuning;
	const key = queueLaneKey(role, "open");
	const leave = await enterLane(lanes, key);
	const place = joinOpenCeiling(lanes, tuning.maxConcurrentOpens);
	// Q-ALARM-1: a long wait for a place pages the owner; the role keeps its place (Q-ISO-3: never dropped).
	const deadlineMs = tuning.ceilingWaitDeadlineMs;
	const queued = watchdog.watch({ role, lane: "open", phase: "queued_ceiling", deadlineMs, taskId });
	void queued.expired.then((stall) => watchdog.report(stall));
	await place.admitted;
	queued.stop();
	const gen = lanes.gens.get(key) ?? 0;
	const free = () => {
		place.free();
		leave();
	};
	const watch = watchdog.watch({
		role,
		lane: "open",
		phase: "attaching_client",
		deadlineMs: tuning.laneDeadlineMs,
		taskId,
	});
	const start: QueueChatStart = {
		...o,
		onPrepared: (launch) => {
			watch.progress("starting_prompt");
			return o.onPrepared ? o.onPrepared(launch) : true;
		},
	};
	let opened: QueueOpenedTaskChat;
	try {
		opened = await watchdog.guard(
			watch,
			host.withQueueClient(queueTasksClientIdFor(role, gen), async (cs) => {
				watch.progress("creating_runtime");
				return cs.openTaskChat(start);
			}),
			() => rotateAndFree(lanes, key, gen, free),
		);
	} finally {
		free();
	}
	const answer = { sessionFile: opened.sessionFile, conversationId: opened.conversationId };
	const turn = watchdog.watch({
		role,
		lane: "open",
		phase: "awaiting_turn_start",
		deadlineMs: tuning.startTurnDeadlineMs,
		taskId,
		...answer,
	});
	return watchdog.guard(
		turn,
		opened.started.then(() => answer),
		() => {},
		() => (queueTurnUnderWay(host.queueChatActivity?.(opened.sessionFile)) ? answer : undefined),
	);
}

/** Q-LANE-1 lanes.home: run a "/queue ..." line in a chat, opening it if it isn't (an open one takes no lane). */
export async function runQueueCommand(host: QueueLaneHostContext, file: string, line: string): Promise<boolean> {
	const run = async (session: QueueLaneSessionView | null, watch?: QueueLaneWatch): Promise<boolean> => {
		// No /queue command (pi-queue isn't loaded there): prompt() would send the line to the model.
		if (!session?.extensionRunner?.getCommand?.("queue") || !session.prompt) return false;
		watch?.progress("running_home_action");
		await session.prompt(line);
		return true;
	};
	const open = host.queueSessionFor(file);
	if (open) return run(open);
	if (!existsSync(file)) return false;
	const role = await queueLaneRoleOf(host, { file });
	return onRoleLane(host, role, "home", "switching_home_session", file, (gen, watch) =>
		host.withQueueClient(queueHomeClientIdFor(role, gen), async (cs) =>
			run(host.queueSessionFor(file) ?? (await cs.openChatForQueue(file)), watch),
		),
	);
}

/** Q-LANE-1 lanes.home: open a question's chat if it isn't open (questions.prepare). */
export async function runQueueHomePrepare(host: QueueLaneHostContext, file: string): Promise<void> {
	if (host.queueSessionFor(file)) return;
	const role = await queueLaneRoleOf(host, { file });
	await onRoleLane(host, role, "home", "switching_home_session", file, (gen) =>
		host.withQueueClient(queueHomeClientIdFor(role, gen), async (cs) => {
			if (!host.queueSessionFor(file) && !(await cs.openChatForQueue(file)))
				throw new Error("question session could not be opened");
		}),
	);
}

/**
 * Q-LANE-1 lanes.close: wait (up to `queueCloseDeadlineMs`, default 15 minutes, outside any lane) for a finished
 * task's chat to stop working, then release it on its role's close lane (separate from opening, so closing a
 * finished chat never blocks a new task chat). Still working at the deadline: log loudly naming the chat and
 * leave it open (Ops #771). Q-WATCHDOG-3: a working chat is never released, removed or disposed.
 */
export async function runQueueCloseChat(
	host: QueueCloseHostContext,
	file: string,
	onRecentChanged: () => void,
): Promise<boolean> {
	const deadlineMs =
		typeof host.queueCloseDeadlineMs === "number" &&
		Number.isFinite(host.queueCloseDeadlineMs) &&
		host.queueCloseDeadlineMs > 0
			? host.queueCloseDeadlineMs
			: QUEUE_CLOSE_DEADLINE_MS;
	const working = () => {
		const session = host.queueSessionFor(file);
		if (session?.isStreaming || session?.isCompacting) return true;
		return !!session && queueChatIsWorking(host.queueChatActivity?.(file));
	};
	const busyName = () => host.queueSessionFor(file)?.sessionManager?.getSessionName?.()?.trim() || basename(file);
	if (!(await waitUntil(() => !working(), deadlineMs, 500))) {
		console.warn(
			`[queue-lanes] finished task chat "${busyName()}" (${file}) is still busy after ${deadlineMs}ms; leaving it open so its turn is not cut off`,
		);
		return false;
	}
	const open = host.queueSessionFor(file);
	const taskChat = open ? isQueueTaskChatEntries(open.sessionManager.getEntries()) : await isQueueTaskChatFile(file);
	const role = await queueLaneRoleOf(host, { file });
	return onRoleLane(host, role, "close", "releasing_chat", file, async () => {
		// It may have started working again while this waited for its role's close lane.
		if (working()) {
			console.warn(`[queue-lanes] finished task chat "${busyName()}" (${file}) is busy again; leaving it open`);
			return false;
		}
		if (taskChat) host.stateStore.removeRecent(resolve(file));
		for (const cs of host.clients.values()) {
			try {
				if (cs.releaseQueueChat(file)) return true;
			} catch {
				// try the next client
			}
		}
		if (taskChat) onRecentChanged();
		return taskChat;
	});
}
