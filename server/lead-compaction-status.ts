import type { LeadState, Status } from "./lead-compaction-contract.js";

const states = new Set<LeadState>([
	"checking",
	"archiving",
	"partial",
	"waiting_busy",
	"ready",
	"applied",
	"blocked",
	"protected_floor",
]);
const numericFields = [
	"cursor",
	"total",
	"measurementRevision",
	"beforeEstimate",
	"afterEstimate",
	"protectedFloorEstimate",
] as const;
const textFields = [
	"planId",
	"planHash",
	"lastAttempt",
	"errorCode",
	"at",
	"nativeEntryId",
	"nextRetryReason",
] as const;

/** Diagnostics projection, not a journal or authority. Never spread executor objects/errors. */
export function projectLeadStatus(value: Status, home: { sessionId: string; role: string }): Status {
	if (value.sessionId !== home.sessionId || !states.has(value.state)) throw new Error("E_LEAD_STATUS");
	const result: Record<string, unknown> = { state: value.state, sessionId: home.sessionId, role: home.role };
	for (const key of numericFields) {
		const n = value[key];
		if (n !== undefined) {
			if (!Number.isSafeInteger(n) || n < 0) throw new Error("E_LEAD_STATUS");
			result[key] = n;
		}
	}
	for (const key of textFields) {
		const text = value[key];
		if (text !== undefined) {
			// Machine identifiers/codes only; messages and exception text are never diagnostics.
			if (typeof text !== "string" || !/^[\w.:/@+-]{1,256}$/.test(text)) throw new Error("E_LEAD_STATUS");
			result[key] = text;
		}
	}
	if (value.measurementSource !== undefined) {
		if (value.measurementSource !== "native-usage" && value.measurementSource !== "current-projection") {
			throw new Error("E_LEAD_STATUS");
		}
		result.measurementSource = value.measurementSource;
	}
	if (value.cursor !== undefined && value.total !== undefined && value.cursor > value.total) {
		throw new Error("E_LEAD_STATUS");
	}
	if (value.state === "applied" && !value.nativeEntryId) throw new Error("E_LEAD_STATUS");
	return Object.freeze(result) as unknown as Status;
}
