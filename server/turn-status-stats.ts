/**
 * turn-status-stats (Ops #688, hypothesis H-STATUS-LINE): the turns of a transcript that another role
 * started, and whether each one's only text is valid status lines (server/turn-status.ts statusLinesOf).
 * Which turns another role started is quiet-turns' call (planQuietRuns, starterOf): the turns the page
 * folds with every switch off, i.e. begun and joined only by role messages, the Initiatives page's and the
 * work check's pokes, and Board orders. A reply answering a question asked for the owner, the 6 am report,
 * the owner's own messages, queue cards and scheduled wake-ups make a turn the owner's.
 *
 * Gives lengths and counts only: a turn's text is read to check it and never kept (rule 11). Pure: the
 * script (scripts/turn-status-stats.mts) reads the files.
 */
import { type QuietMsg, planQuietRuns, quietMsgOfAgent, quietUnder } from "./quiet-turns.js";
import { type SizeSummary, sizeSummary } from "./size-summary.js";
import { statusLinesOf } from "./turn-status.js";

/** One turn another role started: when, in whose chat, by which model, and its text's measure. */
export interface RoleTurn {
	/** When the message that began it arrived (ms). */
	at: number;
	/** The chat's role (its last identity entry before the turn), or null. */
	role: string | null;
	/** The model of its last answer, or null. */
	model: string | null;
	/** Characters of assistant text in the whole turn (narration between tool calls included). */
	textChars: number;
	/** Its only text is valid status lines. */
	statusOnly: boolean;
}

interface Entry {
	type?: unknown;
	timestamp?: unknown;
	customType?: unknown;
	data?: { id?: unknown };
	message?: { role?: unknown; content?: unknown; model?: unknown };
}

function textOf(message: Entry["message"]): string {
	if (!message || !Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const b of message.content as { type?: unknown; text?: unknown }[]) {
		if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("\n");
}

/** The role-started turns in one transcript's entries (a pi session file's JSON lines, in file order). Turns
 *  still running, failed or stopped are left out: they have no final text yet. */
export function roleTurnsOf(entries: readonly unknown[]): RoleTurn[] {
	const msgs: QuietMsg[] = [];
	const at: number[] = [];
	const role: (string | null)[] = [];
	const model: (string | null)[] = [];
	const text: string[] = [];
	let identity: string | null = null;
	for (const raw of entries) {
		const e = (raw ?? {}) as Entry;
		if (e.type === "custom" && e.customType === "identity") {
			identity = typeof e.data?.id === "string" ? e.data.id : null;
			continue;
		}
		let m: QuietMsg;
		if (e.type === "message") m = quietMsgOfAgent(e.message);
		else if (e.type === "custom_message") m = { role: "custom" };
		else continue;
		msgs.push(m);
		at.push(typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN);
		role.push(identity);
		const assistant = m.role === "assistant";
		model.push(assistant && typeof e.message?.model === "string" ? e.message.model : null);
		text.push(assistant ? textOf(e.message) : "");
	}
	const turns: RoleTurn[] = [];
	for (const run of planQuietRuns(msgs)) {
		if (run.row < 0 || run.running || run.ended || !quietUnder(run)) continue;
		const own: string[] = [];
		let last: string | null = null;
		for (let i = run.start; i <= run.last; i++) {
			if (msgs[i]!.role !== "assistant") continue;
			if (text[i]) own.push(text[i]!);
			last = model[i] ?? last;
		}
		const all = own.join("\n");
		turns.push({
			at: at[run.row]!,
			role: role[run.row]!,
			model: last,
			textChars: all.trim().length,
			statusOnly: statusLinesOf(all) !== null,
		});
	}
	return turns;
}

export interface TurnGroup {
	turns: number;
	statusOnly: number;
	/** Percent of turns whose only text is valid status lines, one decimal; null without turns. */
	statusOnlyShare: number | null;
	textChars: SizeSummary;
}

export interface TurnStatusSummary extends TurnGroup {
	byRole: Record<string, TurnGroup>;
	byModel: Record<string, TurnGroup>;
}

function groupOf(turns: readonly RoleTurn[]): TurnGroup {
	const statusOnly = turns.filter((t) => t.statusOnly).length;
	return {
		turns: turns.length,
		statusOnly,
		statusOnlyShare: turns.length ? Math.round((statusOnly / turns.length) * 1000) / 10 : null,
		textChars: sizeSummary(turns.map((t) => t.textChars)),
	};
}

function splitBy(turns: readonly RoleTurn[], key: (t: RoleTurn) => string): Record<string, TurnGroup> {
	const by = new Map<string, RoleTurn[]>();
	for (const t of turns) by.set(key(t), [...(by.get(key(t)) ?? []), t]);
	return Object.fromEntries([...by].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, groupOf(v)]));
}

/** The turns that began in [since, until), oldest first, cut to the first `first` when given. */
export function turnsInWindow(turns: readonly RoleTurn[], since: number, until: number, first?: number): RoleTurn[] {
	const inside = turns.filter((t) => t.at >= since && t.at < until).sort((a, b) => a.at - b.at);
	return first === undefined ? inside : inside.slice(0, first);
}

export function turnStatusSummary(turns: readonly RoleTurn[]): TurnStatusSummary {
	return {
		...groupOf(turns),
		byRole: splitBy(turns, (t) => t.role ?? "(no role)"),
		byModel: splitBy(turns, (t) => t.model ?? "(no model)"),
	};
}
