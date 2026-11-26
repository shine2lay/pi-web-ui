// role-message-hourly-limit.ts: the ordinary hourly limit a sender has right now (Ops #1103, Shine via COO
// rm-3b189c22). Server-only: role-message-limits.ts stays free of node:fs because the web bundle imports it.
//
// A per-role, time-boxed override lives in the data dir, mode 0600:
//   { "v": 1, "overrides": { "<role>": { "acceptedPerOrigin": 1..500, "expiresAt": <epoch ms>, "reason": "..." } } }
// It is read on every check, so writing or deleting it takes effect on the next send, without a restart, and at or
// after `expiresAt` the policy's own limit is back by itself. Missing, malformed, out-of-range or group/other-readable
// files are ignored. The exempt roles (ops, temper) stay exempt; the frozen rollback mode keeps its own cap.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { GuardMode } from "./role-message-guard-contract.js";
import type { GuardPolicy } from "./role-message-guard-contract-v2.js";
import { ROLE_MESSAGE_POLICY, roleMessagesHourlyExempt } from "./role-message-limits.js";

export const ROLE_MESSAGE_HOURLY_OVERRIDES_FILE = "role-message-hourly-overrides.json";
const HOURLY_OVERRIDE_MAX = 500;

/** The data dir's override file, resolved like server/index.ts's data dir (a sealed run's is its temp one). */
export function roleMessageHourlyOverridesFile(env: NodeJS.ProcessEnv = process.env): string {
	return join(resolve(env.PI_WEB_DATA_DIR ?? join(homedir(), ".pi-web")), ROLE_MESSAGE_HOURLY_OVERRIDES_FILE);
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hourlyOverride(role: string, nowMs: number, file: string | null): number | null {
	if (!file) return null;
	try {
		// Owner-only file: one that others may read or write is ignored, never trusted.
		if ((statSync(file).mode & 0o077) !== 0) return null;
		const doc: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!record(doc) || doc.v !== 1 || !record(doc.overrides)) return null;
		const entry = Object.hasOwn(doc.overrides, role) ? doc.overrides[role] : undefined;
		if (!record(entry)) return null;
		const { acceptedPerOrigin: n, expiresAt } = entry;
		if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > HOURLY_OVERRIDE_MAX) return null;
		return typeof expiresAt === "number" && nowMs < expiresAt ? n : null;
	} catch {
		return null; // missing or unreadable: the policy's own limit
	}
}

/** The sender's ordinary hourly limit now: null for the exempt roles; an unexpired override; else the policy's. */
export function roleMessagesHourlyLimitFor(
	role: string,
	policy: GuardPolicy = ROLE_MESSAGE_POLICY,
	nowMs = Date.now(),
	overrideFile: string | null = roleMessageHourlyOverridesFile(),
): number | null {
	if (roleMessagesHourlyExempt(role)) return null;
	return hourlyOverride(role, nowMs, overrideFile) ?? policy.ordinary.acceptedPerOrigin;
}

/** The approval core's cap: Infinity when exempt; the frozen rollback_depth_6 mode keeps its own cap (20). */
export function roleMessagesHourlyCapFor(
	role: string,
	policy: GuardPolicy,
	nowMs: number,
	mode: GuardMode,
	overrideFile?: string | null,
): number {
	const limit = roleMessagesHourlyLimitFor(role, policy, nowMs, overrideFile);
	return limit === null ? Infinity : mode === "rollback_depth_6" ? policy.rollback.acceptedPerOrigin : limit;
}

/** The refusal text once `role` has used its hourly limit, else null: one text for the native and host checks. */
export function roleMessagesHourlyRefusal(
	role: string,
	lastHour: number,
	policy: GuardPolicy = ROLE_MESSAGE_POLICY,
	nowMs = Date.now(),
): string | null {
	const limit = roleMessagesHourlyLimitFor(role, policy, nowMs);
	return limit !== null && lastHour >= limit
		? `Not sent: ${role} has sent ${lastHour} role messages in the last hour (the limit is ${limit}). Ask the owner before sending more.`
		: null;
}
