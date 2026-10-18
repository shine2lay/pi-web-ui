/** roles-config-history (Ops #209): the Config tab's list of a role's recorded settings changes.
 *  Only values exactly as the server sends them are shown; anything else reads as not recorded. Who changed a
 *  setting isn't recorded, and nothing here guesses it. */
import { CLOCK_SKEW_MS, object, time } from "./roles-useful-model";

/** The settings the recorder compares (server/roles-config-history.ts ROLE_CONFIG_FIELDS), as the tab names them. */
export const CONFIG_LABELS: Readonly<Record<string, string>> = {
	title: "Title",
	focus: "Focus",
	workMode: "Work mode",
	goals: "Goals",
	homeChat: "Home chat",
	lanesAtOnce: "Lanes at once",
	autoApprove: "Auto approve",
	autoStart: "Auto start",
	queueModel: "Queue default model",
	queueThinking: "Queue default thinking",
	queueSpeed: "Queue default speed",
	queuePaused: "Queue paused",
	model: "Home chat model",
};

const VALUE_MAX = 200;
const SHOWN = 20;

export interface ExactConfigChange {
	at: number;
	label: string;
	from: string;
	to: string;
}
/** null: the server sent none (not recorded yet, or an older server). */
export interface ExactConfigHistory {
	since: number;
	changes: ExactConfigChange[];
}

function value(v: unknown): string | null {
	return typeof v === "string" && v.length <= VALUE_MAX ? v : null;
}

export function projectConfigHistory(raw: unknown, now: number): ExactConfigHistory | null {
	const input = object(raw);
	const since = time(input?.since);
	if (!input || since === null || !Number.isSafeInteger(since) || since <= 0 || since > now + CLOCK_SKEW_MS)
		return null;
	const changes: ExactConfigChange[] = [];
	for (const item of Array.isArray(input.changes) ? input.changes.slice(0, SHOWN) : []) {
		const c = object(item);
		const at = time(c?.at);
		const field = typeof c?.field === "string" ? c.field : "";
		const label = Object.prototype.hasOwnProperty.call(CONFIG_LABELS, field) ? CONFIG_LABELS[field] : null;
		const from = value(c?.from);
		const to = value(c?.to);
		if (at === null || !Number.isSafeInteger(at) || at <= 0 || at > now + CLOCK_SKEW_MS) continue;
		if (label === null || from === null || to === null) continue;
		changes.push({ at, label, from, to });
	}
	changes.sort((a, b) => b.at - a.at);
	return { since, changes };
}

export const CONFIG_NOT_RECORDED = "Settings history is not recorded yet.";
export const CONFIG_WHO = "Who changed it isn't recorded.";

/** The Config tab's rows: "<time> · <setting>: <old> → <new>", newest first, then the who note; with no change,
 *  "No changes recorded since <start date>". `when` formats a change's time as the page does. */
export function configHistoryActs(
	history: ExactConfigHistory | null,
	when: (at: number) => string,
): { at: string; text: string }[] {
	if (!history) return [{ at: "", text: CONFIG_NOT_RECORDED }];
	if (!history.changes.length) {
		const day = new Date(history.since).toLocaleDateString("en-US", { month: "short", day: "numeric" });
		return [{ at: "", text: `No changes recorded since ${day}.` }];
	}
	return [
		...history.changes.map((c) => ({ at: when(c.at), text: `${c.label}: ${c.from} → ${c.to}` })),
		{ at: "", text: CONFIG_WHO },
	];
}
