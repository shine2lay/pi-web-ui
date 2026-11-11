// ---------------------------------------------------------------------------
// queue-lane-watchdog.ts — the queue lanes' stall watchdog and owner alarm (Architecture #516)
// ---------------------------------------------------------------------------
// Contract: ~/architecture-dept/conventions/queue-resilience.md. On 2026-11-10 one role's stuck task chat
// held the queue's single global lane and no task chat opened for any of the 15 roles for 30 minutes, with
// no alarm. queue-chat-lane.ts gives every role its own open/close/home lanes (Q-ISO-1, Q-LANE-1); this
// module holds what watches them:
// - the deadlines (Q-WATCHDOG-1) and the error a timed-out lane operation rejects with (Q-WATCHDOG-2);
// - the log line and the owner's Telegram alarm built from one stall record (Q-WATCHDOG-2, Q-ALARM-2);
// - heap/RSS sampling, as read-only telemetry that never gates or pauses a lane (Q-HEAP-1/2);
// - whether a chat is still working, so nothing here ever closes or disposes a working chat (Q-WATCHDOG-3);
// - QueueLaneWatchdog: one host's no-progress timers, the race that frees a stalled operation's lane, the log
//   line and the owner's alarm with its per-(role, lane) cooldown (Q-WATCHDOG-1/2, Q-ALARM-1).
// What it frees (the lane lock, the ceiling slot, the pseudo client's generation) is queue-chat-lane.ts's: the
// caller hands it in as `free`. Nothing here closes, releases or disposes a chat.
// ---------------------------------------------------------------------------

import type { OwnerTelegramNotice, OwnerTelegramResult } from "./owner-telegram.js";
import { hasActiveSubagentRun, hasPendingWaitSubscription } from "./wait-subscription-scan.js";

/** Q-WATCHDOG-1: Phase A (opening a task chat, or one close/home operation) without progress. */
export const QUEUE_LANE_DEADLINE_MS = 60_000;
/** Q-WATCHDOG-1: Phase B, a task chat's first turn (`opened.started`) without progress. */
export const QUEUE_START_TURN_DEADLINE_MS = 120_000;
/** Q-WATCHDOG-1: a role waiting for a slot under the open ceiling (Q-ISO-3). */
export const QUEUE_CEILING_WAIT_DEADLINE_MS = 120_000;
/**
 * Q-WATCHDOG-1 / Ops #807: how long closing a finished task chat waits for it to go idle before leaving it
 * open. Must stay above Ops #771's 10-minute settle window so post-`queue_done` replies finish undisturbed.
 */
export const QUEUE_CLOSE_DEADLINE_MS = 15 * 60_000;
/** Q-ISO-3: open lanes running at once across roles; more wait in FIFO order, never dropped. */
export const MAX_CONCURRENT_ROLE_OPENS = 4;
/** Q-ALARM-1: one alarm per (role, lane) per this window after a send that went (or may have gone) out. */
export const ALARM_COOLDOWN_MS = 300_000;
/** Q-HEAP-2: the heap size (MB) from which the alarm text names heap and RSS. */
export const QUEUE_ALARM_HEAP_MB = 3072;
/** Q-ISO-1: the role key of a lane operation no department could be found for. */
export const UNASSIGNED_QUEUE_ROLE = "__unassigned__";
/** Q-ALARM-2: who an unassigned role's alarm comes from. */
export const QUEUE_ALARM_FALLBACK_FROM = "ops";
/** Q-ALARM-2: the alarm link's label. */
export const QUEUE_ALARM_LINK_LABEL = "Open Queue";
/** Q-WATCHDOG-2: the code of a lane operation the watchdog gave up on. */
export const QUEUE_LANE_STALL_TIMEOUT = "QUEUE_LANE_STALL_TIMEOUT";
/** Q-WATCHDOG-2: the prefix of the watchdog's log line. */
export const QUEUE_WATCHDOG_LOG_PREFIX = "[queue-watchdog] lane stall freed:";

/** Q-LANE-1: the three lanes each role has. */
export type QueueLaneKind = "open" | "close" | "home";
export const QUEUE_LANE_KINDS: readonly QueueLaneKind[] = ["open", "close", "home"];

/** Q-WATCHDOG-1: the open lane's phases; Phase A ends with "starting_prompt", Phase B is "awaiting_turn_start". */
export type QueueOpenPhase =
	| "queued_ceiling"
	| "attaching_client"
	| "creating_runtime"
	| "binding_session"
	| "preparing_launch"
	| "starting_prompt"
	| "awaiting_turn_start";
export type QueueClosePhase = "waiting_settle" | "releasing_chat";
export type QueueHomePhase = "switching_home_session" | "running_home_action";
export type QueueLanePhase = QueueOpenPhase | QueueClosePhase | QueueHomePhase;

/** The tunable limits (tests shorten them); anything missing or not a positive number takes its default. */
export interface QueueLaneTuning {
	laneDeadlineMs?: number;
	startTurnDeadlineMs?: number;
	ceilingWaitDeadlineMs?: number;
	maxConcurrentOpens?: number;
	alarmCooldownMs?: number;
}

export type ResolvedQueueLaneTuning = Required<QueueLaneTuning>;

const positive = (v: unknown, fallback: number) =>
	typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;

/** The limits to use: the given ones where they are positive numbers, the contract's defaults otherwise. */
export function resolveQueueLaneTuning(t: QueueLaneTuning | undefined): ResolvedQueueLaneTuning {
	return {
		laneDeadlineMs: positive(t?.laneDeadlineMs, QUEUE_LANE_DEADLINE_MS),
		startTurnDeadlineMs: positive(t?.startTurnDeadlineMs, QUEUE_START_TURN_DEADLINE_MS),
		ceilingWaitDeadlineMs: positive(t?.ceilingWaitDeadlineMs, QUEUE_CEILING_WAIT_DEADLINE_MS),
		maxConcurrentOpens: Math.floor(positive(t?.maxConcurrentOpens, MAX_CONCURRENT_ROLE_OPENS)) || 1,
		alarmCooldownMs: positive(t?.alarmCooldownMs, ALARM_COOLDOWN_MS),
	};
}

/** Q-WATCHDOG-2: one lane operation the watchdog gave up on: what is logged and what the alarm says. */
export interface QueueLaneStall {
	role: string;
	lane: QueueLaneKind;
	phase: QueueLanePhase;
	elapsedMs: number;
	deadlineMs: number;
	taskId: number | null;
	sessionFile: string | null;
	conversationId: string | null;
	heapUsedMB: number;
	rssMB: number;
}

/** Q-WATCHDOG-2: what a lane operation rejects with when the watchdog frees its lane. */
export class QueueLaneWatchdogError extends Error {
	readonly code = QUEUE_LANE_STALL_TIMEOUT;
	readonly stall: QueueLaneStall;
	constructor(stall: QueueLaneStall) {
		super(
			`queue lane stall: ${stall.role}'s ${stall.lane} lane made no progress in ${stall.phase} for ${stall.elapsedMs}ms (limit ${stall.deadlineMs}ms)`,
		);
		this.name = "QueueLaneWatchdogError";
		this.stall = stall;
	}
}

export function isQueueLaneWatchdogError(err: unknown): err is QueueLaneWatchdogError {
	return err instanceof QueueLaneWatchdogError || (err as { code?: unknown } | null)?.code === QUEUE_LANE_STALL_TIMEOUT;
}

/** The part of process.memoryUsage() the telemetry reads. */
export interface QueueMemoryUsage {
	heapUsed: number;
	rss: number;
}

const MB = 1024 * 1024;

/** Q-HEAP-2: heap and RSS in whole MB, read only (never a reason to pause or refuse anything, Q-HEAP-1). */
export function sampleQueueHeap(mem: QueueMemoryUsage = process.memoryUsage()): { heapUsedMB: number; rssMB: number } {
	return { heapUsedMB: Math.round(mem.heapUsed / MB), rssMB: Math.round(mem.rss / MB) };
}

/** Q-WATCHDOG-2: the console.warn line for a freed lane (keys in the contract's order). */
export function queueLaneStallLogLine(stall: QueueLaneStall): string {
	const record = {
		role: stall.role,
		lane: stall.lane,
		phase: stall.phase,
		elapsedMs: stall.elapsedMs,
		deadlineMs: stall.deadlineMs,
		taskId: stall.taskId,
		sessionFile: stall.sessionFile,
		conversationId: stall.conversationId,
		heapUsedMB: stall.heapUsedMB,
		rssMB: stall.rssMB,
		action: "lane_freed",
	};
	return `${QUEUE_WATCHDOG_LOG_PREFIX} ${JSON.stringify(record)}`;
}

/** Seconds for the alarm text: one decimal under 10 s (short test deadlines stay readable), whole above. */
export function queueAlarmSeconds(ms: number): string {
	const s = Math.max(0, ms) / 1000;
	return s < 10 ? String(Math.round(s * 10) / 10) : String(Math.round(s));
}

/** Q-ALARM-2: the owner's telegram_send message for a stall (Rule 26; never a question dialog). */
export function queueLaneStallAlarm(stall: QueueLaneStall): OwnerTelegramNotice {
	const role = stall.role;
	const taskSuffix = stall.taskId === null ? "" : `, task #${stall.taskId}`;
	const heapSuffix =
		stall.heapUsedMB >= QUEUE_ALARM_HEAP_MB ? ` (heap ${stall.heapUsedMB}MB, rss ${stall.rssMB}MB)` : "";
	const text =
		`Queue stall in ${role}: ${stall.lane} (${stall.phase}${taskSuffix}) made no progress for ` +
		`${queueAlarmSeconds(stall.elapsedMs)}s (limit ${queueAlarmSeconds(stall.deadlineMs)}s). ` +
		`Automatic recovery: freed ${role}'s ${stall.lane} lane without closing active chats.${heapSuffix} ` +
		"Action: check the chat in pi-web-ui, or run pi-web-deploy restart if turns are not advancing.";
	return {
		text,
		from: role === UNASSIGNED_QUEUE_ROLE ? QUEUE_ALARM_FALLBACK_FROM : role,
		url: stall.sessionFile ? `/?chat=${encodeURIComponent(stall.sessionFile)}` : "/",
		linkLabel: QUEUE_ALARM_LINK_LABEL,
	};
}

/** Q-WATCHDOG-3: what says a chat is still at work (missing fields count as not). */
export interface QueueChatActivity {
	isStreaming?: boolean;
	isCompacting?: boolean;
	sendsInFlight?: number;
	blockingTerminals?: number;
	hasActiveSubagentRun?: boolean;
	hasPendingWaitSubscription?: boolean;
}

/** Q-WATCHDOG-3: whether a chat must not be closed, released or disposed now. */
export function queueChatIsWorking(a: QueueChatActivity | null | undefined): boolean {
	if (!a) return false;
	return (
		a.isStreaming === true ||
		a.isCompacting === true ||
		(a.sendsInFlight ?? 0) > 0 ||
		(a.blockingTerminals ?? 0) > 0 ||
		a.hasActiveSubagentRun === true ||
		a.hasPendingWaitSubscription === true
	);
}

/** Q-WATCHDOG-3: what an open chat is doing, from its session, its sends on their way and its blocking terminals. */
export function queueChatActivityOf(
	session: { isStreaming: boolean; isCompacting: boolean; sessionFile: string | undefined },
	sendsInFlight: number | undefined,
	blockingTerminals: number,
): QueueChatActivity {
	const sessionId = session.sessionFile;
	return {
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		sendsInFlight: sendsInFlight ?? 0,
		blockingTerminals,
		// pi-subagents' runs and wait subscriptions on disk (read as displaceActive reads them).
		hasActiveSubagentRun: !!sessionId && hasActiveSubagentRun({ sessionId }),
		hasPendingWaitSubscription: !!sessionId && hasPendingWaitSubscription({ sessionId }),
	};
}

/** Q-WATCHDOG-2 Phase B: a task chat whose first turn runs, or whose first message is on its way. */
export function queueTurnUnderWay(a: QueueChatActivity | null | undefined): boolean {
	return a?.isStreaming === true || (a?.sendsInFlight ?? 0) > 0;
}

/** What the watchdog reads from its host (AgentService; tests give their own). */
export interface QueueWatchdogHost {
	/** Q-WATCHDOG-1 / Q-ISO-3 / Q-ALARM-1 limits (tests shorten them). */
	queueLaneTuning?: QueueLaneTuning;
	/** Q-ALARM-2: send the owner's alarm (owner-telegram.ts sendOwnerTelegram with the telegram_send tool). */
	sendQueueAlarm?(notice: OwnerTelegramNotice): Promise<OwnerTelegramResult>;
	/** Q-HEAP-2: read-only telemetry (default process.memoryUsage). */
	queueMemoryUsage?(): QueueMemoryUsage;
}

/** Where one lane operation is: what a stall record says about it besides the times. */
export interface QueueLaneWatchStart {
	role: string;
	lane: QueueLaneKind;
	phase: QueueLanePhase;
	deadlineMs: number;
	taskId?: number | null;
	sessionFile?: string | null;
	conversationId?: string | null;
}

/** Q-WATCHDOG-1: one lane operation's no-progress deadline. */
export interface QueueLaneWatch {
	/** Progress: the operation entered `phase`; the deadline starts again. */
	progress(phase: QueueLanePhase): void;
	/** The operation ended: no expiry any more. */
	stop(): void;
	/** Settles with the stall record once the deadline passed without progress; never once stopped. */
	readonly expired: Promise<QueueLaneStall>;
}

/**
 * One host's watchdog: no-progress timers for its lane operations, and the owner's alarm with its cooldown per
 * (role, lane) (Q-ALARM-1). Heap and RSS are only read for the record (Q-HEAP-1/2).
 */
export class QueueLaneWatchdog {
	/** When each (role, lane) last paged the owner (a send under way counts). */
	private readonly pagedAt = new Map<string, number>();

	constructor(private readonly host: QueueWatchdogHost) {}

	get tuning(): ResolvedQueueLaneTuning {
		return resolveQueueLaneTuning(this.host.queueLaneTuning);
	}

	/** Start the deadline of one lane operation in its first phase. */
	watch(start: QueueLaneWatchStart): QueueLaneWatch {
		let phase = start.phase;
		let since = Date.now();
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let fire!: (stall: QueueLaneStall) => void;
		const expired = new Promise<QueueLaneStall>((resolve) => {
			fire = resolve;
		});
		const arm = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				if (stopped) return;
				stopped = true;
				fire({
					role: start.role,
					lane: start.lane,
					phase,
					elapsedMs: Date.now() - since,
					deadlineMs: start.deadlineMs,
					taskId: start.taskId ?? null,
					sessionFile: start.sessionFile ?? null,
					conversationId: start.conversationId ?? null,
					...sampleQueueHeap(this.host.queueMemoryUsage?.()),
				});
			}, start.deadlineMs);
			timer.unref?.();
		};
		arm();
		return {
			progress(next) {
				if (stopped) return;
				phase = next;
				since = Date.now();
				arm();
			},
			stop() {
				stopped = true;
				if (timer) clearTimeout(timer);
			},
			expired,
		};
	}

	/**
	 * Q-WATCHDOG-2: `work` under `watch`. On expiry: `free` (only the lane lock, the ceiling slot and the pseudo
	 * client's generation; never a chat, Q-WATCHDOG-3), log and page (report), then settle with `fallback`'s answer
	 * when it has one (Phase B: the first turn is under way), else reject with QueueLaneWatchdogError.
	 */
	async guard<T>(
		watch: QueueLaneWatch,
		work: Promise<T>,
		free: () => void,
		fallback?: (stall: QueueLaneStall) => T | undefined,
	): Promise<T> {
		const stalled = watch.expired.then((stall): T => {
			free();
			this.report(stall);
			const answer = fallback?.(stall);
			if (answer !== undefined) return answer;
			throw new QueueLaneWatchdogError(stall);
		});
		try {
			return await Promise.race([work, stalled]);
		} finally {
			watch.stop();
		}
	}

	/** Q-WATCHDOG-2 + Q-ALARM-1: log the stall and page the owner, unless this (role, lane) paged within the cooldown. */
	report(stall: QueueLaneStall): void {
		console.warn(queueLaneStallLogLine(stall));
		const send = this.host.sendQueueAlarm;
		if (!send) return;
		const key = `${stall.role}/${stall.lane}`;
		const now = Date.now();
		const last = this.pagedAt.get(key);
		if (last !== undefined && now - last < this.tuning.alarmCooldownMs) return;
		this.pagedAt.set(key, now);
		// A send that surely didn't go out doesn't start the cooldown: the next stall pages again.
		const notSent = (why: string) => {
			if (this.pagedAt.get(key) === now) this.pagedAt.delete(key);
			console.warn(`[queue-watchdog] owner alarm for ${key} not sent: ${why}`);
		};
		let sending: Promise<OwnerTelegramResult>;
		try {
			sending = send.call(this.host, queueLaneStallAlarm(stall));
		} catch (err) {
			notSent(err instanceof Error ? err.message : String(err));
			return;
		}
		sending.then(
			(r) => {
				if (!r.ok && !r.maybeSent) notSent(r.error);
			},
			(err: unknown) => notSent(err instanceof Error ? err.message : String(err)),
		);
	}
}
