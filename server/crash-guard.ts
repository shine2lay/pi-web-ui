/**
 * crash-guard 补丁：一个窗口出的错，不能拖垮整个服务。
 *
 * 2026-09-25 17:15 和 2026-09-26 09:11 两次整站崩溃是同一条栈：窗口 A 刷新后没了 socket，
 * 它正看着的那条对话被另一个窗口关掉了（没 socket 的窗口不算「有人在看」，见
 * ClientSession.viewedElsewhere）。A 之前发出、还没结束的那句话一结束，prompt() →
 * flushSnapshot() → currentMessages() → `get conv()` 就抛 "no active conversation"；
 * WebSocket 分发器用 `void cs.prompt(...)` 发起它，于是成了未处理的 promise 拒绝，Node 直接
 * 退出，systemd 重启服务，所有对话正在跑的回合全部中断。
 *
 * One window's failed request must never take the whole server down. Three levels:
 * 1. Root cause (agent-service.ts): when a chat closes, windows still pointing at it move to an
 *    open chat (planForLostActive); snapshots, SDK events and the end of a send no longer throw on
 *    a missing active chat.
 * 2. Dispatcher (index.ts): guardCalls wraps every ClientSession call made while handling one
 *    window message. A failure is logged with its stack and shown to that window as an error
 *    notice; it no longer escapes.
 * 3. Last resort (index.ts): a process-level unhandledRejection handler logs with the stack and the
 *    server keeps running. A synchronous uncaughtException keeps Node's default (exit): the process
 *    may really be broken then.
 */
import { type AdoptCandidate, pickAdoptTarget } from "./attach-adopt.js";

/** An error as one log block: the stack when there is one (it already starts with the message). */
export function describeError(err: unknown): string {
	if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
	if (typeof err === "string") return err;
	try {
		return JSON.stringify(err) ?? String(err);
	} catch {
		return String(err);
	}
}

/** The short message for a notice (no stack). */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : typeof err === "string" ? err : describeError(err);
}

/** Where a call failed (e.g. `prompt → prompt`) and what it threw. */
export type HandlerErrorReport = (where: string, err: unknown) => void;

/**
 * Wrap `target` so every method call through the wrapper reports its failure instead of letting it
 * escape (level 2). Used on the dispatcher's ClientSession while it handles ONE window message:
 * - a returned promise gets a `.catch` that reports the rejection. The SAME promise is returned,
 *   so a caller that awaits it still sees the error; a `void` caller no longer leaves it unhandled.
 * - a synchronous throw is reported and the call returns `undefined`.
 * Methods run with the real object as `this` (never the proxy), so private state works as before.
 * Plain property reads pass straight through; a throwing getter still throws (the dispatcher's own
 * try/catch reports that one).
 */
export function guardCalls<T extends object>(target: T, where: string, report: HandlerErrorReport): T {
	return new Proxy(target, {
		get(obj, prop) {
			const value: unknown = Reflect.get(obj, prop, obj);
			if (typeof value !== "function") return value;
			const name = `${where} → ${String(prop)}`;
			return (...args: unknown[]): unknown => {
				let result: unknown;
				try {
					result = (value as (...a: unknown[]) => unknown).apply(obj, args);
				} catch (err) {
					report(name, err);
					return undefined;
				}
				if (result instanceof Promise) {
					result.catch((err: unknown) => report(name, err));
				}
				return result;
			};
		},
	});
}

/** What to do with a window whose active chat is no longer open (level 1). */
export type LostActivePlan =
	/** The active chat is open: nothing to do. */
	| { kind: "keep" }
	/** Point the window at this open chat. */
	| { kind: "move"; to: string }
	/** Nothing to move to and someone is looking: open a new blank chat. */
	| { kind: "new_chat" }
	/** Nothing to move to and nobody is looking (no socket): wait for the window to reconnect. */
	| { kind: "wait" };

/**
 * Where a window goes when its active chat was closed under it. In order: the chat the caller
 * prefers (the one a finishing send went to), else the project's most recently active open chat
 * (same rule as a reload, pickAdoptTarget: never a subagent chat), else a new chat if the window
 * has a socket, else wait until it reconnects. Pure, so the order is unit-tested.
 */
export function planForLostActive(input: {
	/** Is the window's active chat still in the shared table? */
	activeOpen: boolean;
	/** The chat to prefer, if it is still open. */
	preferId?: string;
	/** The window's project directory. */
	cwd: string;
	/** Every open chat in the shared table. */
	open: Iterable<AdoptCandidate>;
	/** Does the window have a live socket (is anyone looking)? */
	hasSocket: boolean;
}): LostActivePlan {
	if (input.activeOpen) return { kind: "keep" };
	const open = [...input.open];
	if (input.preferId !== undefined && open.some((c) => c.id === input.preferId)) {
		return { kind: "move", to: input.preferId };
	}
	const adopt = pickAdoptTarget(input.cwd, open);
	if (adopt) return { kind: "move", to: adopt };
	return input.hasSocket ? { kind: "new_chat" } : { kind: "wait" };
}

/** Level 3: the log line for a promise rejection nobody handled. */
export function logUnhandledRejection(reason: unknown, log: (line: string) => void = console.error): void {
	log(`[crash-guard] unhandled promise rejection; the server keeps running:\n${describeError(reason)}`);
}

let processGuardsInstalled = false;

/**
 * Level 3: keep the server up when a promise rejection goes unhandled (Node's default exits the
 * process, which ends every chat's running turn). Logs it with the stack. Deliberately NOT
 * `uncaughtException`: after a synchronous throw nobody caught, the process may really be broken,
 * so that keeps Node's default. Installs once per process; returns false when already installed.
 */
export function installProcessGuards(proc: Pick<NodeJS.Process, "on"> = process): boolean {
	if (processGuardsInstalled) return false;
	processGuardsInstalled = true;
	proc.on("unhandledRejection", (reason: unknown) => logUnhandledRejection(reason));
	return true;
}
