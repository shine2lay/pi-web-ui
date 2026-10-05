/**
 * about-drafts: a line diff of two texts, for the "What changes" view of a role draft in Settings ->
 * Identities (the role's about page now against the one its draft suggests). Shown in the app's diff
 * look (the source-control panel's .scm-diff-pre / .scm-diff-line classes).
 *
 * About pages are small (a few thousand characters), so a plain longest-common-subsequence table is
 * quick enough. The common head and tail are trimmed first; past LIMIT table cells the rest is shown as
 * all removed, then all added (still right, just not the shortest).
 */

export interface DiffLine {
	kind: "same" | "add" | "del";
	text: string;
}

/** A row of the folded diff: a line, or a run of unchanged lines left out. */
export type DiffRow = DiffLine | { kind: "skip"; count: number };

const LIMIT = 4_000_000;

/** A text's lines (one final newline doesn't make an empty last line). */
const linesOf = (text: string): string[] =>
	text === "" ? [] : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");

const line =
	(kind: DiffLine["kind"]) =>
	(text: string): DiffLine => ({ kind, text });

/** Every line of `before` and `after`, each marked same, del (only in before) or add (only in after). */
export function lineDiff(before: string, after: string): DiffLine[] {
	const a = linesOf(before);
	const b = linesOf(after);
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	const n = midA.length;
	const m = midB.length;
	const mid: DiffLine[] = [];
	if (n * m > LIMIT) {
		mid.push(...midA.map(line("del")), ...midB.map(line("add")));
	} else {
		// t[i][j] = the longest common run of lines from midA[i..] and midB[j..]
		const w = m + 1;
		const t = new Uint32Array((n + 1) * w);
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				t[i * w + j] =
					midA[i] === midB[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
			}
		}
		let i = 0;
		let j = 0;
		while (i < n && j < m) {
			if (midA[i] === midB[j]) {
				mid.push({ kind: "same", text: midA[i] });
				i++;
				j++;
			} else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) {
				mid.push({ kind: "del", text: midA[i++] });
			} else {
				mid.push({ kind: "add", text: midB[j++] });
			}
		}
		while (i < n) mid.push({ kind: "del", text: midA[i++] });
		while (j < m) mid.push({ kind: "add", text: midB[j++] });
	}
	return [...a.slice(0, start).map(line("same")), ...mid, ...a.slice(endA).map(line("same"))];
}

/** How many lines a diff adds and removes. */
export function diffCounts(lines: DiffLine[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const l of lines) {
		if (l.kind === "add") added++;
		else if (l.kind === "del") removed++;
	}
	return { added, removed };
}

/** The diff with long unchanged runs folded away: `context` unchanged lines stay on each side of a change. */
export function foldDiff(lines: DiffLine[], context = 3): DiffRow[] {
	const keep = new Array<boolean>(lines.length).fill(false);
	lines.forEach((l, i) => {
		if (l.kind === "same") return;
		for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
	});
	const out: DiffRow[] = [];
	let skipped = 0;
	lines.forEach((l, i) => {
		if (!keep[i]) {
			skipped++;
			return;
		}
		if (skipped) out.push({ kind: "skip", count: skipped });
		skipped = 0;
		out.push(l);
	});
	if (skipped) out.push({ kind: "skip", count: skipped });
	return out;
}
