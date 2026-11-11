import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { OwnerTelegramNotice, OwnerTelegramResult } from "./owner-telegram.js";
import { makeChain, type QueueChatStart, waitUntil } from "./queue-host.js";
import {
	QUEUE_CLOSE_DEADLINE_MS,
	type QueueChatActivity,
	type QueueLaneKind,
	type QueueLaneTuning,
	type QueueMemoryUsage,
	UNASSIGNED_QUEUE_ROLE,
} from "./queue-lane-watchdog.js";
import { isQueueTaskChatEntries, isQueueTaskChatFile, TASK_QUEUE_ENTRY_TYPE } from "./task-queue.js";
import { chatOf } from "./task-queue-fields.js";

export type QueueLaneChain = <T>(fn: () => Promise<T>) => Promise<T>;

// ---------------------------------------------------------------------------
// Per-role lane keys and pseudo clients (Q-ISO-1, Q-ISO-1a; Architecture #516, Ops #812 seam)
// ---------------------------------------------------------------------------

/** Q-ISO-1a: the queue's pseudo clients' base ids (agent-service.ts:2654-2655 keeps its own copy until Ops #813). */
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
	queueChatOfTaskFile?(file: string): Promise<string | undefined> | string | undefined;
}

/** Q-ISO-1: what a lane operation knows about whose it is. */
export interface QueueLaneRoleSource {
	roleId?: string;
	entries?: readonly { customType: string; data: unknown }[];
	file?: string;
}

function usableRole(role: string | undefined): string | undefined {
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
	const ask = async (fn: () => Promise<string | undefined> | string | undefined) => {
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

export interface QueueCloseHostContext {
	clients: Map<string, QueueCloseClientView>;
	stateStore: { removeRecent(path: string): void };
	queueSessionFor(file: string): QueueCloseSessionView | null;
	queueCloseChain?: QueueLaneChain;
	queueCloseDeadlineMs?: number;
}

/**
 * Wait (up to `queueCloseDeadlineMs`, default 15 minutes) for a finished task's chat to go idle,
 * then release it on the dedicated `queueCloseChain` (separate from `queueTasksChain` so closing
 * a finished chat never blocks opening a new task chat). If the chat is still streaming or compacting
 * at the deadline, log loudly naming the chat and leave it open (never disposing a chat mid-turn).
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
	const settled = await waitUntil(
		() => {
			const session = host.queueSessionFor(file);
			return !session || (!session.isStreaming && !session.isCompacting);
		},
		deadlineMs,
		500,
	);
	if (!settled) {
		const busy = host.queueSessionFor(file);
		const name = busy?.sessionManager?.getSessionName?.()?.trim() || basename(file);
		console.warn(
			`[queue-lanes] finished task chat "${name}" (${file}) is still busy after ${deadlineMs}ms; leaving it open so its turn is not cut off`,
		);
		return false;
	}
	const open = host.queueSessionFor(file);
	const taskChat = open ? isQueueTaskChatEntries(open.sessionManager.getEntries()) : await isQueueTaskChatFile(file);
	const closeChain = (host.queueCloseChain ??= makeChain());
	return closeChain(async () => {
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

// ---------------------------------------------------------------------------
// Lane entry points (Q-LANE-1). Ops #812 seam: these carry today's behaviour unchanged (the three process-wide
// chains of agent-service.ts:20543-20545 and the two shared pseudo clients) and are not wired yet; Q-ASSERT-1..6
// fail against them. Ops #813 makes them per role with the open ceiling, the watchdog and the alarm, and moves
// agent-service.ts's inline startChat / questions.prepare / queueRunCommand onto them.
// ---------------------------------------------------------------------------

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

/** The queue host as the lanes see it (AgentService). */
export interface QueueLaneHostContext extends QueueCloseHostContext {
	queueSessionFor(file: string): QueueLaneSessionView | null;
	/** Attach the pseudo client `clientId`, run `fn` through it, detach (AgentService.withQueueClient). */
	withQueueClient<T>(clientId: string, fn: (cs: QueueLaneClient) => Promise<T>): Promise<T>;
	/** Q-ISO-1: how a lane operation's role is found; missing: every operation is "__unassigned__". */
	queueLaneRoles?: QueueLaneRoleLookup;
	/** Q-WATCHDOG-1 / Q-ISO-3 / Q-ALARM-1 limits (tests shorten them). */
	queueLaneTuning?: QueueLaneTuning;
	/** Q-WATCHDOG-2/3: whether the chat with this transcript is still at work. */
	queueChatActivity?(file: string): QueueChatActivity | null;
	/** Q-ALARM-2: send the owner's alarm (owner-telegram.ts sendOwnerTelegram with the telegram_send tool). */
	sendQueueAlarm?(notice: OwnerTelegramNotice): Promise<OwnerTelegramResult>;
	/** Q-HEAP-2: read-only telemetry (default process.memoryUsage). */
	queueMemoryUsage?(): QueueMemoryUsage;
	queueTasksChain?: QueueLaneChain;
	queueHomeChain?: QueueLaneChain;
}

/** Q-ISO-1: the role a lane operation belongs to. */
export function queueLaneRoleOf(host: QueueLaneHostContext, src: QueueLaneRoleSource): Promise<string> {
	return resolveQueueLaneRoleKey(src, host.queueLaneRoles);
}

/**
 * Q-LANE-1: the lane a role's operation of this kind runs on. Seam (Ops #812): still the process-wide chain of
 * that kind whatever the role, as agent-service.ts has it; Ops #813 returns the role's own lane.
 */
export function queueRoleLane(host: QueueLaneHostContext, roleKey: string, lane: QueueLaneKind): QueueLaneChain {
	checkedRoleKey(roleKey);
	if (lane === "open") return (host.queueTasksChain ??= makeChain());
	if (lane === "close") return (host.queueCloseChain ??= makeChain());
	return (host.queueHomeChain ??= makeChain());
}

/** Q-LANE-1 lanes.open: pi-queue's startChat (agent-service.ts:20652-20657 today). */
export async function runQueueStartChat(
	host: QueueLaneHostContext,
	o: QueueChatStart,
): Promise<{ sessionFile: string; conversationId?: string }> {
	const role = await queueLaneRoleOf(host, { entries: o.entries });
	const opened = await queueRoleLane(
		host,
		role,
		"open",
	)(() => host.withQueueClient(QUEUE_TASKS_CLIENT_ID, (cs) => cs.openTaskChat(o)));
	await opened.started;
	return { sessionFile: opened.sessionFile, conversationId: opened.conversationId };
}

/** Q-LANE-1 lanes.home: run a "/queue ..." line in a chat, opening it if it isn't (agent-service.ts:20796-20811). */
export async function runQueueCommand(host: QueueLaneHostContext, file: string, line: string): Promise<boolean> {
	const run = async (session: QueueLaneSessionView | null): Promise<boolean> => {
		// No /queue command (pi-queue isn't loaded there): prompt() would send the line to the model.
		if (!session?.extensionRunner?.getCommand?.("queue") || !session.prompt) return false;
		await session.prompt(line);
		return true;
	};
	const open = host.queueSessionFor(file);
	if (open) return run(open);
	if (!existsSync(file)) return false;
	const role = await queueLaneRoleOf(host, { file });
	return queueRoleLane(
		host,
		role,
		"home",
	)(() =>
		host.withQueueClient(QUEUE_HOME_CLIENT_ID, async (cs) =>
			run(host.queueSessionFor(file) ?? (await cs.openChatForQueue(file))),
		),
	);
}

/** Q-LANE-1 lanes.home: open a question's chat if it isn't open (questions.prepare, agent-service.ts:20611-20620). */
export async function runQueueHomePrepare(host: QueueLaneHostContext, file: string): Promise<void> {
	if (host.queueSessionFor(file)) return;
	const role = await queueLaneRoleOf(host, { file });
	await queueRoleLane(
		host,
		role,
		"home",
	)(() =>
		host.withQueueClient(QUEUE_HOME_CLIENT_ID, async (cs) => {
			if (!host.queueSessionFor(file) && !(await cs.openChatForQueue(file)))
				throw new Error("question session could not be opened");
		}),
	);
}
