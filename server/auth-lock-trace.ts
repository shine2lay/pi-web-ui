/**
 * auth-lock-trace: names whatever holds pi's sign-in lock for a minute or more.
 *
 * pi keeps every account's sign-in in ~/.pi/agent/auth.json behind one proper-lockfile lock
 * (the auth.json.lock dir). A token refresh that finds it held retries for 30 s and then fails
 * with "Lock file is already being held". On 2026-10-13 something in this process held it from
 * about 02:04 until the 08:06 restart (Ops task #134): every chat that needed a refresh failed.
 * Every code path we could find lets go within 30 s, so the holder is still unknown.
 *
 * This module only watches. It wraps lock/lockSync of the proper-lockfile copy the loaded SDK
 * uses (auth-storage.js calls them as `lockfile.lock(...)`, so the wrapper is looked up at call
 * time). When a lock on a file named auth.json is still held 60 s after it was taken, it writes
 * ONE line, "[auth-lock] held 60s+ by <stack>", the stack being where the lock was taken. It
 * never changes locking, timeouts, retries or lock stealing: the original functions get the same
 * arguments and their results and errors are passed back untouched, and every error inside the
 * trace itself is caught. Token-, key- and account-shaped strings are scrubbed from the line.
 *
 * A hold ends when its release function is called (proper-lockfile then stops touching the lock
 * dir, so it goes stale within 30 s even if removing it fails). A lock that proper-lockfile
 * reports as compromised still counts as held until its holder releases it: the line then names
 * a locked section that ran for over a minute.
 *
 * Drop it once the holder is found and fixed, or after 30 days with no repeat (PATCHES.md
 * "auth-lock-trace"). tests/unit/auth-lock-trace.test.ts is the canary: it fails when the
 * installed SDK stops locking auth.json through this proper-lockfile copy.
 */
import { createRequire } from "node:module";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

/** How long a hold may last before it is logged. */
export const AUTH_LOCK_HOLD_LOG_MS = 60_000;
/** How many stack frames are captured where a lock is taken. */
const STACK_FRAMES = 40;
/** The logged line is cut here. */
const MAX_LINE_CHARS = 8_000;

type Release = (...args: unknown[]) => unknown;

/** The part of proper-lockfile's API that the trace wraps. */
export interface LockfileApi {
	lock: (file: string, ...rest: unknown[]) => Promise<Release>;
	lockSync: (file: string, ...rest: unknown[]) => Release;
}

export interface AuthLockTraceOptions {
	/** Defaults to AUTH_LOCK_HOLD_LOG_MS. */
	thresholdMs?: number;
	/** Defaults to console.warn. */
	log?: (line: string) => void;
}

export interface AuthLockTrace {
	/** Holds on auth.json taken through the traced module and not released yet. */
	active(): number;
}

interface Hold {
	/** Captured where the lock was taken; its stack is read only when a line is written. */
	where: Error;
	timer?: ReturnType<typeof setTimeout>;
}

const traces = new WeakMap<object, AuthLockTrace>();

/** True for a lock on a file named auth.json (pi's sign-in store). */
function isAuthFile(file: unknown): boolean {
	return typeof file === "string" && basename(file) === "auth.json";
}

function captureWhere(): Error {
	const limit = Error.stackTraceLimit;
	try {
		Error.stackTraceLimit = STACK_FRAMES;
		return new Error("auth-lock");
	} finally {
		Error.stackTraceLimit = limit;
	}
}

/** Turns a mixed-case, digit-bearing run of 32+ token characters (a secret's shape) into a mark. */
function scrubLongRun(run: string): string {
	return /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run) ? "[scrubbed]" : run;
}

/** Removes token-, key- and account-shaped strings from a line. */
export function scrubAuthLockLine(line: string): string {
	return line
		.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "[scrubbed]") // API keys and OAuth tokens (sk-ant-…)
		.replace(/\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+){1,2}/g, "[scrubbed]") // JWTs
		.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[scrubbed]") // e-mail addresses
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[scrubbed]") // account ids
		.replace(/[A-Za-z0-9_-]{32,}/g, scrubLongRun);
}

/** "[auth-lock] held 60s+ by <frame> <- <frame> …", one line, from where the lock was taken. */
export function formatAuthLockLine(stack: string | undefined, thresholdMs: number): string {
	const frames = (stack ?? "")
		.split("\n")
		.slice(1)
		.map((frame) =>
			frame
				.trim()
				.replace(/^at /, "")
				.replace(/file:\/\//g, ""),
		)
		.filter((frame) => frame && !/auth-lock-trace\.[cm]?[jt]s/.test(frame));
	const held = thresholdMs >= 1000 ? `${Math.round(thresholdMs / 1000)}s+` : `${thresholdMs}ms+`;
	const line = scrubAuthLockLine(`[auth-lock] held ${held} by ${frames.join(" <- ") || "(no stack)"}`);
	return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

/**
 * Wraps lock/lockSync on `lockfile` (once per module object). Returns the trace, or null when
 * the module doesn't look like proper-lockfile.
 */
export function installAuthLockTrace(lockfile: LockfileApi, options: AuthLockTraceOptions = {}): AuthLockTrace | null {
	const existing = traces.get(lockfile);
	if (existing) return existing;
	const originalLock = lockfile.lock;
	const originalLockSync = lockfile.lockSync;
	if (typeof originalLock !== "function" || typeof originalLockSync !== "function") return null;
	const thresholdMs = options.thresholdMs ?? AUTH_LOCK_HOLD_LOG_MS;
	const log = options.log ?? ((line: string) => console.warn(line));
	const active = new Set<Hold>();

	const begin = (file: unknown): Hold | undefined => {
		try {
			return isAuthFile(file) ? { where: captureWhere() } : undefined;
		} catch {
			return undefined;
		}
	};
	const report = (hold: Hold): void => {
		try {
			if (active.has(hold)) log(formatAuthLockLine(hold.where.stack, thresholdMs));
		} catch {
			// the trace must never reach the lock path
		}
	};
	const end = (hold: Hold): void => {
		try {
			if (hold.timer) clearTimeout(hold.timer);
			active.delete(hold);
		} catch {
			// the trace must never reach the lock path
		}
	};
	/** Starts the clock on a granted lock and returns its release, which ends the hold first. */
	const watch = (hold: Hold, release: Release): Release => {
		try {
			hold.timer = setTimeout(() => report(hold), thresholdMs);
			hold.timer.unref?.();
			active.add(hold);
		} catch {
			return release;
		}
		if (typeof release !== "function") return release;
		return function tracedRelease(this: unknown, ...args: unknown[]): unknown {
			end(hold);
			return release.apply(this, args);
		};
	};

	lockfile.lock = function tracedLock(this: unknown, file: string, ...rest: unknown[]): Promise<Release> {
		const hold = begin(file);
		const pending = originalLock.call(this, file, ...rest);
		if (!hold) return pending;
		return pending.then((release) => watch(hold, release));
	};
	lockfile.lockSync = function tracedLockSync(this: unknown, file: string, ...rest: unknown[]): Release {
		const hold = begin(file);
		const release = originalLockSync.call(this, file, ...rest);
		return hold ? watch(hold, release) : release;
	};

	const trace: AuthLockTrace = { active: () => active.size };
	traces.set(lockfile, trace);
	return trace;
}

/** The proper-lockfile module the loaded pi SDK imports (auth-storage.js), or null. */
export function sdkLockfileModule(): LockfileApi | null {
	try {
		// import.meta.resolve follows the SDK copy the server really loads (resolve-global-sdk.ts).
		const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		return createRequire(entry)("proper-lockfile") as LockfileApi;
	} catch {
		return null;
	}
}

function installOnSdk(): AuthLockTrace | null {
	try {
		const lockfile = sdkLockfileModule();
		const trace = lockfile ? installAuthLockTrace(lockfile) : null;
		if (!trace) console.warn("[auth-lock] trace not installed: pi's proper-lockfile was not found");
		return trace;
	} catch (err) {
		console.warn(`[auth-lock] trace not installed: ${(err as Error).message}`);
		return null;
	}
}

/** The trace on the SDK's sign-in lock, installed when this module is first imported. */
export const sdkAuthLockTrace: AuthLockTrace | null = installOnSdk();
