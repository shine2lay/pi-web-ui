/**
 * attach 完成前暂存客户端命令的队列 —— 独立成模块是为了可单测
 * （`server/index.ts` 起 WS + SDK，不适合在单测里 import）。
 *
 * 背景：hello 先回 ready（issue #295）后，attach/插件链就绪前收到的命令一律进
 * pending 队列等重放；attach 挂死（坏挂载/家目录扫描数十秒）或失败保活时队列
 * 原先无上限——失控/恶意连接可在此期间灌消息把内存顶爆。加上限后超限丢最旧并
 * 计数（做法对齐 ws-unknown-types 的「上限 + 溢出计数 + 节流 warn」先例）。
 *
 * Legacy PendingCommandQueue keeps that behavior for unwired callers. New integrations
 * must use RecoverablePendingCommandQueue and handle rejection/abandonment explicitly:
 * docs/durable-pending-command-preservation.md. Neither queue is durable storage or an ack.
 */

import type { ClientMessage } from "./protocol.js";

/** 队列上限：正常前端在 attach 窗口内只发 get_state 等零星几条，256 绰绰有余。 */
export const MAX_PENDING_WS_MESSAGES = 256;

/** 同一进程两次超限告警的最小间隔（防刷屏，对齐 ws-unknown-types 的节流思路）。 */
export const PENDING_DROP_WARN_INTERVAL_MS = 60_000;

let lastWarnAt = 0;

function warnPendingQueue(line: string, log: (line: string) => void): void {
	const now = Date.now();
	if (now - lastWarnAt < PENDING_DROP_WARN_INTERVAL_MS) return;
	lastWarnAt = now;
	log(line);
}

/** 超限丢弃的节流告警：`PENDING_DROP_WARN_INTERVAL_MS` 内最多一条。log 注入便于单测。 */
export function warnPendingDrop(totalDropped: number, log: (line: string) => void): void {
	warnPendingQueue(
		`[ws] attach not finished, the command queue is over its limit and dropped the oldest (${totalDropped} in total)`,
		log,
	);
}

/** 单测隔离用。 */
export function resetPendingDropWarn(): void {
	lastWarnAt = 0;
}

/** Legacy only: 超限丢最旧，clear 静默丢弃。Not a preservation API; host integration is separate. */
export class PendingCommandQueue {
	private items: ClientMessage[] = [];
	private droppedTotal = 0;

	constructor(readonly cap: number = MAX_PENDING_WS_MESSAGES) {}

	push(msg: ClientMessage): void {
		if (this.items.length >= this.cap) {
			this.items.shift();
			this.droppedTotal++;
			warnPendingDrop(this.droppedTotal, (line) => console.warn(line));
		}
		this.items.push(msg);
	}

	/** 取走全部并清空（attach 完成后的重放）。 */
	drain(): ClientMessage[] {
		const out = this.items;
		this.items = [];
		return out;
	}

	/** attach 失败保活 / 连接关闭时清空（用户修好后重发的 get_state 会重新入队）。 */
	clear(): void {
		this.items = [];
	}

	/** 累计丢弃条数（排障用）。 */
	get dropped(): number {
		return this.droppedTotal;
	}

	get size(): number {
		return this.items.length;
	}
}

export type PendingCommandAbandonReason = "attach-failed" | "socket-closed";
export type PendingCommandRejectionReason = "capacity" | PendingCommandAbandonReason;

/** Always unprocessed: admission/cleanup is not a handler result or a server receipt. */
export interface PendingCommandAbandonment {
	readonly status: "unprocessed";
	readonly reason: PendingCommandAbandonReason;
	readonly commands: readonly ClientMessage[];
}

/** Refusal cannot be ignored like a false return from push(). Never log command. */
export class PendingCommandRejectedError extends Error {
	readonly status = "unprocessed";
	readonly retryable = true;
	readonly #command: ClientMessage;

	constructor(
		command: ClientMessage,
		readonly reason: PendingCommandRejectionReason,
	) {
		super(`Pending command not processed: ${reason}`);
		this.name = "PendingCommandRejectedError";
		// Private storage keeps payload out of ordinary error serialization/logging.
		this.#command = command;
	}

	get command(): ClientMessage {
		return this.#command;
	}
}

/**
 * Additive, bounded reject-new queue. Host MUST handle the typed refusal, consume
 * abandon()'s unprocessed set, and retain ownership of drain() until real dispatch.
 * No clear(), execution, replay, persistence, deduplication or acknowledgement.
 */
export class RecoverablePendingCommandQueue {
	private items: ClientMessage[] = [];
	private rejectedTotal = 0;
	private abandoned: PendingCommandAbandonReason | null = null;

	constructor(readonly cap: number = MAX_PENDING_WS_MESSAGES) {
		if (!Number.isInteger(cap) || cap < 1 || cap > MAX_PENDING_WS_MESSAGES) {
			throw new RangeError(`Pending command capacity must be an integer from 1 to ${MAX_PENDING_WS_MESSAGES}`);
		}
	}

	/** A normal return means buffered only. A refused command remains caller-owned. */
	push(command: ClientMessage): void {
		const reason = this.abandoned ?? (this.items.length >= this.cap ? "capacity" : null);
		if (reason) {
			this.rejectedTotal++;
			if (reason === "capacity") {
				try {
					warnPendingQueue(
						`[ws] attach not finished, the command queue is at capacity and refused a new command (${this.rejectedTotal} in total)`,
						(line) => console.warn(line),
					);
				} catch {
					// A broken logger must not hide the recoverable refusal or its exact command.
				}
			}
			throw new PendingCommandRejectedError(command, reason);
		}
		this.items.push(command);
	}

	/** Transfer, NOT processing. The caller owns dispatch and any undispatched suffix. */
	drain(): ClientMessage[] {
		const out = this.items;
		this.items = [];
		return out;
	}

	/** Terminal admission fence; transfer all remaining work once, even on a closed socket. */
	abandon(reason: PendingCommandAbandonReason): PendingCommandAbandonment {
		if (reason !== "attach-failed" && reason !== "socket-closed") {
			throw new TypeError("Pending command abandonment must be attach-failed or socket-closed");
		}
		this.abandoned ??= reason;
		return Object.freeze({
			status: "unprocessed",
			reason: this.abandoned,
			commands: Object.freeze(this.drain()),
		});
	}

	get rejected(): number {
		return this.rejectedTotal;
	}

	get size(): number {
		return this.items.length;
	}
}
