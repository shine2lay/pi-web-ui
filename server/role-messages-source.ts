import { readFileSync } from "node:fs";
import type { RoleMessageRecord } from "./role-messages.js";

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
	return object(value) && keys.every(key => typeof value[key] === "string");
}
function invalid(): never { throw new Error("E_RPI_UNKNOWN: role messages source schema"); }

/** Canonical disk boundary: validate every row, never silently filter or window the source. */
export function parseRoleMessagesSource(raw: string): RoleMessagesSource {
	const data: unknown = JSON.parse(raw);
	if (!object(data) || data.v !== 1 || typeof data.paused !== "boolean" || !Array.isArray(data.messages)
		|| (data.resumedAt !== undefined && !natural(data.resumedAt))) invalid();
	const ids = new Set<string>();
	for (const row of data.messages) {
		if (!object(row) || typeof row.id !== "string" || !row.id || ids.has(row.id)
			|| !natural(row.at) || !strings(row.from, ["role", "title", "chat", "file"])
			|| !strings(row.to, ["role", "title"]) || typeof row.text !== "string"
			|| !["question", "request", "reply", "fyi", "report"].includes(String(row.kind))
			|| !["waiting", "delivered", "replied", "failed"].includes(String(row.state))
			|| !natural(row.chain) || (row.chain as number) < 1 || !natural(row.sends) || !natural(row.attempts)) invalid();
		for (const key of ["replyTo", "replyId", "target", "targetChat", "hash", "error", "initiative", "root", "parent", "requester"]) {
			if (row[key] !== undefined && typeof row[key] !== "string") invalid();
		}
		for (const key of ["scanFrom", "nextTryAt", "deliveredAt"]) {
			if (row[key] !== undefined && !natural(row[key])) invalid();
		}
		if (row.forOwner !== undefined && typeof row.forOwner !== "boolean") invalid();
		for (const key of ["tags", "ownerIds"]) {
			const value = row[key];
			if (value !== undefined && (!Array.isArray(value) || !value.every(v => typeof v === "string"))) invalid();
		}
		if (row.guard !== undefined && (!strings(row.guard, ["requestId", "generation"])
			|| !object(row.guard) || !["initial", "decision"].includes(String(row.guard.phase)))) invalid();
		for (const key of ["report", "stall", "ci", "script"]) {
			if (row[key] !== undefined && !object(row[key])) invalid();
		}
		if (object(row.script) && (!["fyi", "request"].includes(String(row.script.kind))
			|| !strings(row.script, ["sender", "title"]))) invalid();
		ids.add(row.id);
	}
	return data as unknown as RoleMessagesSource;
}

/** Missing/unreadable files, invalid JSON and invalid rows throw; none means an empty inbox. */
export function readRoleMessagesSource(file: string): RoleMessageRecord[] {
	return parseRoleMessagesSource(readFileSync(file, "utf8")).messages;
}

/** Pin obligations and their actual accepted reply, not all historical rows. */
export function roleMessageRetentionPins(records: readonly RoleMessageRecord[], sourcePins: ReadonlySet<string> = new Set()): Set<string> {
	const pins = new Set(sourcePins);
	const byId = new Map(records.map(row => [row.id, row]));
	for (const row of records) {
		if (row.state === "waiting" || ((row.kind === "question" || row.kind === "request") && row.state !== "failed" && !row.replyId)) pins.add(row.id);
	}
	for (const original of records) {
		const reply = original.replyId ? byId.get(original.replyId) : undefined;
		if (reply?.kind === "reply" && reply.replyTo === original.id && reply.from.role === original.to.role && reply.to.role === original.from.role
			&& (pins.has(original.id) || pins.has(reply.id))) {
			pins.add(original.id);
			pins.add(reply.id);
		}
	}
	return pins;
}
