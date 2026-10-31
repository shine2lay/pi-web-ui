/**
 * agent-text-stats (Ops #688 part 2, hypothesis H-COMPACT-MSG): how long the text roles write for each
 * other is, from the host's own records: role messages (role-messages.json, the newest 1,000) by kind, and
 * Board posts (role-board.json) by kind. The app's own sends (the work check's and the Initiatives page's
 * pokes, the 6 am report) are left out: no agent wrote them.
 *
 * Gives lengths and counts only, never text (rule 11). Pure: the script (scripts/agent-text-stats.mts)
 * reads the files.
 */
import { type SizeSummary, sizeSummary } from "./size-summary.js";

interface Written {
	at?: unknown;
	kind?: unknown;
	text?: unknown;
	from?: unknown;
}

/** One record's length: when, what kind, how many characters. */
export interface TextSize {
	at: number;
	kind: string;
	chars: number;
}

export interface AgentTextSummary {
	messages: SizeSummary & { byKind: Record<string, SizeSummary> };
	board: SizeSummary & { byKind: Record<string, SizeSummary> };
}

function sizeOf(r: Written): TextSize | null {
	if (typeof r.at !== "number" || typeof r.text !== "string") return null;
	return { at: r.at, kind: typeof r.kind === "string" ? r.kind : "(none)", chars: r.text.length };
}

/** Role messages an agent wrote (not the app's own sends), oldest first. */
export function roleMessageSizes(records: readonly unknown[]): TextSize[] {
	const out: TextSize[] = [];
	for (const raw of records) {
		const r = (raw ?? {}) as Written;
		const sender = (r.from ?? {}) as { role?: unknown };
		if (sender.role === "app") continue;
		const s = sizeOf(r);
		if (s) out.push(s);
	}
	return out.sort((a, b) => a.at - b.at);
}

/** Board posts, oldest first. */
export function boardPostSizes(posts: readonly unknown[]): TextSize[] {
	const out: TextSize[] = [];
	for (const raw of posts) {
		const s = sizeOf((raw ?? {}) as Written);
		if (s) out.push(s);
	}
	return out.sort((a, b) => a.at - b.at);
}

/** The sizes in [since, until), oldest first, cut to the first `first` when given. */
export function sizesInWindow(sizes: readonly TextSize[], since: number, until: number, first?: number): TextSize[] {
	const inside = sizes.filter((s) => s.at >= since && s.at < until);
	return first === undefined ? inside : inside.slice(0, first);
}

function summaryOf(sizes: readonly TextSize[]): SizeSummary & { byKind: Record<string, SizeSummary> } {
	const kinds = [...new Set(sizes.map((s) => s.kind))].sort();
	return {
		...sizeSummary(sizes.map((s) => s.chars)),
		byKind: Object.fromEntries(
			kinds.map((k) => [k, sizeSummary(sizes.filter((s) => s.kind === k).map((s) => s.chars))]),
		),
	};
}

export function agentTextSummary(messages: readonly TextSize[], board: readonly TextSize[]): AgentTextSummary {
	return { messages: summaryOf(messages), board: summaryOf(board) };
}
