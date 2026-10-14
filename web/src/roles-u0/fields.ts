// I-VISUAL's exhaustive rows, not new producers or a change to RTPI/1.
// PROGRAM C06 (zero pixels) is NOT this matrix's C06 (native navigation).
import type { RtpiRef } from "../../../server/rtpi-core.js";

export const FIELD_ROWS = [
	["A01", "Registry", "recorded"],
	["A02", "Snapshot checked", "recorded"],
	["A03", "Refresh cadence", "recorded"],
	["A04", "Home binding", "recorded"],
	["A05", "Operational state", "recorded"],
	["A06", "Lane states", "recorded"],
	["A07", "Lane occupancy", "recorded"],
	["A08", "Waiting on you", "recorded"],
	["A09", "Own-work policy", "recorded"],
	["A10", "Contact channel", "recorded"],
	["A11", "Directed messages", "recorded"],
	["A12", "Owner directions", "recorded"],
	["A13", "Message task binding", "recorded"],
	["A14", "Sending attempt", "recorded"],
	["A15", "Permitted message metadata", "recorded"],
	["A16", "Legend and pan", "recorded"],
	["B01", "Role selection", "recorded"],
	["B02", "Origins", "recorded"],
	["B03", "Role-reported activity", "recorded"],
	["B04", "Your contacts", "recorded"],
	["B05", "Contact receipts", "recorded"],
	["B06", "Reply and task binding", "recorded"],
	["B07", "Morning report", "recorded"],
	["B08", "Current tasks", "recorded"],
	["B09", "Progress and next action", "reported"],
	["B10", "Built", "recorded"],
	["B11", "Checked", "recorded"],
	["B12", "Installed", "recorded"],
	["B13", "Live", "recorded"],
	["B14", "Owner-confirmed", "recorded"],
	["B15", "Queue status totals", "recorded"],
	["B16", "Task requester", "recorded"],
	["B17", "Dependency", "recorded"],
	["B18", "Own initiatives", "recorded"],
	["B19", "Requests by direction", "recorded"],
	["B20", "Individual spend", "reported"],
	["C01", "Recent progress", "recorded"],
	["C02", "Config save actor", "recorded"],
	["C03", "About", "recorded"],
	["C04", "Resources incorporated", "recorded"],
	["C05", "Requested, launch and selected profiles", "reported"],
	["C06", "Native navigation", "recorded"],
	["C07", "Board, report, spend and About", "recorded"],
	["D01", "Pending action", "recorded"],
	["D02", "Permitted explanation", "recorded"],
	["D03", "Native action binding", "recorded"],
	["D04", "Current native options", "recorded"],
	["D05", "Contact provenance", "recorded"],
	["D06", "Saved, rendered and opened", "recorded"],
	["D07", "Task-only reply trace", "recorded"],
	["D08", "Reply coverage", "recorded"],
	["D09", "Own-work publication", "reported"],
	["D10", "Requested publication (no aggregate)", "reported"],
	["E01", "Desktop", "recorded"],
	["E02", "Phone and pan", "recorded"],
	["E03", "Disconnected last-known", "recorded"],
	["E04", "Per-domain stale", "recorded"],
	["E05", "Loading", "recorded"],
	["E06", "Inbox completeness", "recorded"],
	["E07", "Working operational chip", "recorded"],
	["E08", "Legend and details", "recorded"],
	["E09", "Owner inbox", "recorded"],
	["E10", "Config, report and routes", "recorded"],
	["E11", "Peer tooltip", "recorded"],
] as const;
export type FieldId = (typeof FIELD_ROWS)[number][0];
export type PlainValue = string | number | boolean | readonly PlainValue[] | { readonly [key: string]: PlainValue };
export type NativeField =
	| { readonly state: "not-recorded" | "not-reported" | "unknown" | "unavailable"; readonly reason?: string }
	| {
			readonly state: "known" | "last-known";
			readonly value: PlainValue;
			readonly source: RtpiRef;
			readonly asOf: string;
	  };
export type NativeFields = Readonly<Record<FieldId, NativeField>>;
export function missingFields(): NativeFields {
	return Object.freeze(
		Object.fromEntries(
			FIELD_ROWS.map(([id, , word]) => [
				id,
				Object.freeze({ state: word === "reported" ? "not-reported" : "not-recorded" }),
			]),
		) as Record<FieldId, NativeField>,
	);
}
export function fieldDisplay(field: NativeField): string {
	if (field.state === "known" || field.state === "last-known") {
		const value = typeof field.value === "object" ? "Recorded metadata" : String(field.value);
		return field.state === "last-known" ? "Last known: " + value : value;
	}
	return (
		{
			"not-recorded": "Not recorded",
			"not-reported": "Not reported",
			unknown: "Unknown",
			unavailable: "Unavailable",
		} as const
	)[field.state];
}

// This is an internal display read-model, NOT an RTPI producer/event schema.
// J0 must derive it in the authorized server projection from qualified C0
// records; the browser cannot authenticate a producer or strengthen evidence.
export interface NativeReadModel {
	readonly schema: "roles-u0/read-model/1";
	readonly namespace: "rtpi-native";
	readonly fields: NativeFields;
}
export function assertNativeFields(input: NativeReadModel): NativeFields {
	if (input.schema !== "roles-u0/read-model/1" || input.namespace !== "rtpi-native")
		throw new Error("U0 fixture or unsupported read-model");
	if (Object.keys(input).sort().join() !== "fields,namespace,schema") throw new Error("U0 unsupported read-model keys");
	const expected = FIELD_ROWS.map((x) => x[0])
		.sort()
		.join();
	if (Object.keys(input.fields).sort().join() !== expected) throw new Error("U0 field coverage");
	for (const field of Object.values(input.fields)) {
		if (field.state === "known" || field.state === "last-known") {
			if (field.source.namespace !== "rtpi-native") throw new Error("U0 fixture source cannot enter native projection");
			if (Object.keys(field).sort().join() !== "asOf,source,state,value") throw new Error("U0 field keys");
			if (Object.keys(field.source).sort().join() !== "id,kind,namespace,revision") throw new Error("U0 source keys");
			for (const value of [field.source.id, field.source.kind, field.source.revision])
				if (!/^[\x21-\x7e]{1,128}$/.test(value)) throw new Error("U0 source reference");
			if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(field.asOf) || !Number.isFinite(Date.parse(field.asOf)))
				throw new Error("U0 as-of");
			checkValue(field.value);
		} else {
			if (!["not-recorded", "not-reported", "unknown", "unavailable"].includes(field.state))
				throw new Error("U0 field state");
			if (Object.keys(field).some((k) => k !== "state" && k !== "reason")) throw new Error("U0 missing field keys");
			const reason = (field as { reason?: unknown }).reason;
			if (reason !== undefined && (typeof reason !== "string" || reason.length > 256))
				throw new Error("U0 missing reason");
		}
	}
	return input.fields;
}
function checkValue(value: PlainValue, depth = 0): void {
	if (depth > 8) throw new Error("U0 value depth");
	if (typeof value === "string") {
		if (value.length > 12000) throw new Error("U0 value length");
		return;
	}
	if (typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("U0 finite value");
		return;
	}
	if (
		!value ||
		typeof value !== "object" ||
		Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype)
	)
		throw new Error("U0 plain display value");
	const entries = Object.entries(value);
	if (entries.length > 200) throw new Error("U0 value cap");
	for (const [key, item] of entries) {
		if (["__proto__", "constructor", "prototype", "fixture", "scenario", "simulate"].includes(key))
			throw new Error("U0 forbidden display key");
		checkValue(item, depth + 1);
	}
}
