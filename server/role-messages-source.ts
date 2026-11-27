import { readFileSync } from "node:fs";
import type { RoleMessageRecord } from "./role-messages.js";
import { roleMessagesHourlyExempt } from "./role-message-limits.js";

/** Closed history target; waiting messages and open obligations are never dropped. */
export const ROLE_MESSAGES_KEEP = 1000;
const HOUR_MS = 60 * 60 * 1000;
/** role-reports: how many days back a report may be asked for (the day must be over). */
export const ROLE_REPORT_MAX_AGE_DAYS = 7;
/** role-reports: report records younger than this are never dropped (they are the once-per-day proof). */
const REPORT_KEEP_MS = (ROLE_REPORT_MAX_AGE_DAYS + 2) * 24 * HOUR_MS;

export interface RoleMessagesSource {
	v: 1;
	paused: boolean;
	resumedAt?: number;
	messages: RoleMessageRecord[];
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function natural(value: unknown): boolean {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}
function strings(value: unknown, keys: string[]): boolean {
	return object(value) && keys.every((key) => typeof value[key] === "string");
}
function invalid(): never {
	throw new Error("E_RPI_UNKNOWN: role messages source schema");
}

/** Canonical disk boundary: validate every row, never silently filter or window the source. */
export function parseRoleMessagesSource(raw: string): RoleMessagesSource {
	const data: unknown = JSON.parse(raw);
	if (
		!object(data) ||
		data.v !== 1 ||
		typeof data.paused !== "boolean" ||
		!Array.isArray(data.messages) ||
		(data.resumedAt !== undefined && !natural(data.resumedAt))
	)
		invalid();
	const ids = new Set<string>();
	for (const row of data.messages) {
		if (
			!object(row) ||
			typeof row.id !== "string" ||
			!row.id ||
			ids.has(row.id) ||
			!natural(row.at) ||
			!strings(row.from, ["role", "title", "chat", "file"]) ||
			!strings(row.to, ["role", "title"]) ||
			typeof row.text !== "string" ||
			typeof row.kind !== "string" ||
			!["question", "request", "reply", "fyi", "report"].includes(row.kind) ||
			typeof row.state !== "string" ||
			!["waiting", "delivered", "replied", "failed"].includes(row.state) ||
			!natural(row.chain) ||
			!natural(row.sends) ||
			!natural(row.attempts)
		)
			invalid();
		for (const key of [
			"replyTo",
			"replyId",
			"target",
			"targetChat",
			"hash",
			"error",
			"initiative",
			"root",
			"parent",
			"requester",
		]) {
			if (row[key] !== undefined && typeof row[key] !== "string") invalid();
		}
		for (const key of ["scanFrom", "nextTryAt", "deliveredAt"]) {
			if (row[key] !== undefined && !natural(row[key])) invalid();
		}
		if (row.forOwner !== undefined && typeof row.forOwner !== "boolean") invalid();
		for (const key of ["tags", "ownerIds"]) {
			const value = row[key];
			if (value !== undefined && (!Array.isArray(value) || !value.every((v) => typeof v === "string"))) invalid();
		}
		if (
			row.guard !== undefined &&
			(!strings(row.guard, ["requestId", "generation"]) ||
				!object(row.guard) ||
				!["initial", "decision"].includes(String(row.guard.phase)))
		)
			invalid();
		for (const key of ["report", "stall", "ci", "script"]) {
			if (row[key] !== undefined && !object(row[key])) invalid();
		}
		if (object(row.script) && (typeof row.script.kind !== "string" || !["fyi", "request"].includes(row.script.kind)))
			invalid();
		ids.add(row.id);
	}
	return data as unknown as RoleMessagesSource;
}

/** Missing/unreadable files, invalid JSON and invalid rows throw; none means an empty inbox. */
export function readRoleMessagesSource(file: string): RoleMessageRecord[] {
	return parseRoleMessagesSource(readFileSync(file, "utf8")).messages;
}

/** Pin obligations and their actual accepted reply, not all historical rows. */
export function roleMessageRetentionPins(
	records: readonly RoleMessageRecord[],
	sourcePins: ReadonlySet<string> = new Set(),
): Set<string> {
	const pins = new Set(sourcePins);
	const byId = new Map(records.map((row) => [row.id, row]));
	for (const row of records) {
		if (
			row.state === "waiting" ||
			((row.kind === "question" || row.kind === "request") && row.state !== "failed" && !row.replyId)
		)
			pins.add(row.id);
	}
	for (const original of records) {
		const reply = original.replyId ? byId.get(original.replyId) : undefined;
		if (
			reply?.kind === "reply" &&
			reply.replyTo === original.id &&
			reply.from.role === original.to.role &&
			reply.to.role === original.from.role &&
			(pins.has(original.id) || pins.has(reply.id))
		) {
			pins.add(original.id);
			pins.add(reply.id);
		}
	}
	return pins;
}

/** Calculate pruning in source order, preserving obligations and their accepted replies. */
export function pruneRoleMessages(
	keep: RoleMessageRecord[],
	now: number,
	sourcePins: () => ReadonlySet<string> | undefined,
	log: (message: string) => void,
): { retained: RoleMessageRecord[]; dropped: RoleMessageRecord[] } {
	const extra = keep.length - ROLE_MESSAGES_KEEP;
	let considered = 0;
	let pins: ReadonlySet<string>;
	try {
		pins = roleMessageRetentionPins(keep, sourcePins());
	} catch {
		// Unknown projection cannot authorize irreversible deletion. Retry on the next save.
		pins = new Set(keep.map((m) => m.id));
		log("retention unknown; skipped pruning");
	}
	const retained = keep.filter((m) => {
		// role-reports: a recent report request stays: it is the proof that the day was asked for.
		const proof = m.kind === "report" && now - m.at < REPORT_KEEP_MS;
		if (considered < extra && !pins.has(m.id) && !proof) {
			considered++;
			// Ops #318: unlimited traffic must not evict capped roles' unexpired hourly proof.
			// At most capped roles × active hourly cap extra rows; exempt history rotates as before.
			if (m.kind !== "report" && !roleMessagesHourlyExempt(m.from.role) && now - m.at < HOUR_MS) return true;
			return false;
		}
		return true;
	});
	// Never leave a retained original without the actual accepted reply used by semantic projection.
	const paired = roleMessageRetentionPins(keep, new Set(retained.map((m) => m.id)));
	return { retained: keep.filter((m) => paired.has(m.id)), dropped: keep.filter((m) => !paired.has(m.id)) };
}

/** Preserve chain facts before the rotating store drops finished records. */
export function roleMessageDroppedFacts(dropped: RoleMessageRecord[], at: number) {
	return dropped.map((m) => ({
		id: m.id,
		chain: m.chain,
		...(m.hash ? { hash: m.hash } : {}),
		...(m.target ? { target: m.target } : {}),
		...(m.root ? { root: m.root } : {}),
		...(m.parent ? { parent: m.parent } : {}),
		...(m.guard ? { guard: m.guard } : {}),
		...(m.tags?.length ? { tags: [...m.tags] } : {}),
		state: m.state, // #379: how it ended (the ladder settles a delivery it never saw confirmed from this)
		at,
	}));
}
