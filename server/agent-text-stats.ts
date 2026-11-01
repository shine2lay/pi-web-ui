/**
 * agent-text-stats (Ops #688 part 2, hypothesis H-COMPACT-MSG): how long the text roles write for each
 * other is, from the host's own records: role messages (role-messages.json, the newest 1,000) by kind, and
 * Board posts (role-board.json) by kind. The app's own sends (the work check's and the Initiatives page's
 * pokes, the 6 am report) are left out: no agent wrote them.
 *
 * Gives lengths and counts only, never text (rule 11). Pure: the script (scripts/agent-text-stats.mts)
 * reads the files.
 */
import { CLASS_NAMES, type CharacterCounts, ThreadFragments } from "./agent-text-classes.js";
import { type SizeSummary, sizeSummary } from "./size-summary.js";

interface Written {
	at?: unknown;
	kind?: unknown;
	text?: unknown;
	from?: unknown;
	via?: unknown;
	to?: unknown;
	id?: unknown;
	replyTo?: unknown;
	parent?: unknown;
	root?: unknown;
}

/** One record's length: when, what kind, how many characters. */
export interface TextSize {
	at: number;
	kind: string;
	chars: number;
	sender?: string;
	classes?: CharacterCounts;
	/** Disjoint provenance for repeatedInThread only; pair fallback is a heuristic, not a chain. */
	repetition?: { explicitlyLinkedChars: number; pairFallbackOnlyChars: number };
}

export interface ClassSummary {
	n: number;
	totalChars: number;
	repetition: { explicitlyLinkedChars: number; pairFallbackOnlyChars: number };
	classes: Record<keyof CharacterCounts, { chars: number; median: number | null; share: number | null }>;
}

interface WrittenSummary extends SizeSummary {
	byKind: Record<string, SizeSummary>;
	characterClasses: ClassSummary & {
		byKind: Record<string, ClassSummary>;
		bySender: Record<string, ClassSummary>;
	};
}

export interface AgentTextSummary {
	messages: WrittenSummary;
	board: WrittenSummary;
}

function sizeOf(r: Written): TextSize | null {
	if (typeof r.at !== "number" || !Number.isFinite(r.at) || typeof r.text !== "string") return null;
	return { at: r.at, kind: typeof r.kind === "string" ? r.kind : "(none)", chars: r.text.length };
}

function roleOf(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	const role = (value as { role?: unknown } | null)?.role;
	return typeof role === "string" ? role : undefined;
}

/** Classify before selecting a window: earlier retained records remain available as context.
 * Native `chain` is a depth, NOT an identity. Use root/parent/replyTo, never that number.
 * Pair fallback is bidirectional, within 24h; absent endpoints never create a shared bucket.
 * Board recipient sets form one endpoint, and owner orders are attributed to their posting role (via).
 */
function writtenSizes(records: readonly unknown[], board: boolean): TextSize[] {
	const rows = records.map((raw) => (raw ?? {}) as Written).filter((r) => sizeOf(r) && roleOf(r.from) !== "app");
	rows.sort((a, b) => (a.at as number) - (b.at as number));
	const byId = new Map(rows.filter((r) => typeof r.id === "string").map((r) => [r.id as string, r]));
	function threadOf(r: Written): string | undefined {
		const seen = new Set<Written>();
		while (!seen.has(r)) {
			seen.add(r);
			if (typeof r.root === "string" && r.root) return r.root;
			const parent = typeof r.replyTo === "string" ? r.replyTo : r.parent;
			if (typeof parent !== "string" || !parent) return typeof r.id === "string" ? r.id : undefined;
			const previous = byId.get(parent);
			if (!previous) return parent;
			r = previous;
		}
		return undefined;
	}
	const fragments = new ThreadFragments();
	return rows.map((r) => {
		const s = sizeOf(r)!;
		const sender = (board ? roleOf(r.via) : undefined) ?? roleOf(r.from);
		const recipient = Array.isArray(r.to) ? JSON.stringify([...r.to].sort()) : roleOf(r.to);
		const thread = threadOf(r);
		const scopes: { key: string; since: number }[] = [];
		if (thread) scopes.push({ key: `thread:${thread}`, since: -Infinity });
		if (sender && recipient)
			scopes.push({ key: `pair:${JSON.stringify([sender, recipient].sort())}`, since: s.at - 86_400_000 });
		const classes = fragments.counts(r.text as string, scopes);
		const explicitlyLinkedChars = fragments.counts(
			r.text as string,
			scopes.filter((scope) => scope.key.startsWith("thread:")),
		).repeatedInThread;
		const repetition = {
			explicitlyLinkedChars,
			pairFallbackOnlyChars: classes.repeatedInThread - explicitlyLinkedChars,
		};
		fragments.remember(
			r.text as string,
			s.at,
			scopes.map(({ key }) => key),
		);
		return { ...s, sender: sender ?? "(none)", classes, repetition };
	});
}

/** Role messages an agent wrote (not the app's own sends), oldest first. */
export function roleMessageSizes(records: readonly unknown[]): TextSize[] {
	return writtenSizes(records, false);
}

/** Board post text only (same denominator as #688); title and ownerWords fields are excluded. */
export function boardPostSizes(posts: readonly unknown[]): TextSize[] {
	return writtenSizes(posts, true);
}

/** The sizes in [since, until), oldest first, cut to the first `first` when given. */
export function sizesInWindow(sizes: readonly TextSize[], since: number, until: number, first?: number): TextSize[] {
	const inside = sizes.filter((s) => s.at >= since && s.at < until);
	return first === undefined ? inside : inside.slice(0, first);
}

function classSummary(sizes: readonly TextSize[]): ClassSummary {
	const totalChars = sizes.reduce((sum, s) => sum + s.chars, 0);
	const classes = Object.fromEntries(
		CLASS_NAMES.map((name) => {
			const values = sizes.map((s) => s.classes?.[name] ?? (name === "plainProse" ? s.chars : 0));
			const chars = values.reduce((sum, n) => sum + n, 0);
			return [name, { chars, median: sizeSummary(values).median, share: totalChars ? chars / totalChars : null }];
		}),
	) as ClassSummary["classes"];
	const repetition = {
		explicitlyLinkedChars: sizes.reduce((sum, s) => sum + (s.repetition?.explicitlyLinkedChars ?? 0), 0),
		pairFallbackOnlyChars: sizes.reduce((sum, s) => sum + (s.repetition?.pairFallbackOnlyChars ?? 0), 0),
	};
	return { n: sizes.length, totalChars, classes, repetition };
}

function summaryOf(sizes: readonly TextSize[]): WrittenSummary {
	const kinds = [...new Set(sizes.map((s) => s.kind))].sort();
	return {
		...sizeSummary(sizes.map((s) => s.chars)),
		characterClasses: {
			...classSummary(sizes),
			byKind: Object.fromEntries(kinds.map((k) => [k, classSummary(sizes.filter((s) => s.kind === k))])),
			bySender: Object.fromEntries(
				[...new Set(sizes.map((s) => s.sender ?? "(none)"))]
					.sort()
					.map((sender) => [sender, classSummary(sizes.filter((s) => (s.sender ?? "(none)") === sender))]),
			),
		},
		byKind: Object.fromEntries(
			kinds.map((k) => [k, sizeSummary(sizes.filter((s) => s.kind === k).map((s) => s.chars))]),
		),
	};
}

export function agentTextSummary(messages: readonly TextSize[], board: readonly TextSize[]): AgentTextSummary {
	return { messages: summaryOf(messages), board: summaryOf(board) };
}
