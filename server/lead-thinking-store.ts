import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isThinkingLevel, type ThinkingLevelName } from "./model-all-chats.js";

export interface LeadThinkingStore {
	version: 1;
	defaultLevel: "high" | null;
	owners: Record<string, { level: ThinkingLevelName; source: "owner"; entryId: string | null }>;
	initializations: Record<string, string | null>;
}

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
	return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

export function readLeadThinkingStore(file: string): LeadThinkingStore {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { version: 1, defaultLevel: null, owners: {}, initializations: {} };
		throw error;
	}
	const value: unknown = JSON.parse(raw);
	if (
		!record(value) ||
		!keys(value, ["version", "defaultLevel", "owners", "initializations"]) ||
		value.version !== 1 ||
		(value.defaultLevel !== null && value.defaultLevel !== "high") ||
		!record(value.owners) ||
		!record(value.initializations)
	) {
		throw new Error("Invalid lead thinking configuration");
	}
	for (const [sid, owner] of Object.entries(value.owners)) {
		if (
			!sid.trim() ||
			!record(owner) ||
			!keys(owner, ["level", "source", "entryId"]) ||
			owner.source !== "owner" ||
			!isThinkingLevel(owner.level) ||
			(owner.entryId !== null && (typeof owner.entryId !== "string" || !owner.entryId))
		) {
			throw new Error("Invalid lead thinking owner provenance");
		}
	}
	for (const [sid, entryId] of Object.entries(value.initializations)) {
		if (!sid.trim() || (entryId !== null && (typeof entryId !== "string" || !entryId)))
			throw new Error("Invalid lead thinking initialization provenance");
	}
	return value as unknown as LeadThinkingStore;
}

/** Revalidate before replacing; a corrupt existing file must never be silently repaired. */
export function writeLeadThinkingStore(file: string, store: LeadThinkingStore): void {
	readLeadThinkingStore(file);
	mkdirSync(dirname(file), { recursive: true });
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temp, file);
	} finally {
		rmSync(temp, { force: true });
	}
}
