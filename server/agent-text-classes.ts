/** Count-only lexical accounting. Precedence is CLASS_NAMES order, not a claim of removability.
 * A character means one UTF-16 code unit, matching the existing message-length measure.
 * Text and matching fragments stay inside this module and are never returned.
 */
export const CLASS_NAMES = [
	"hashesAndIds",
	"pathsAndUrls",
	"codeAndMarkup",
	"quotes",
	"repeatedInThread",
	"plainProse",
] as const;
export type CharacterClass = (typeof CLASS_NAMES)[number];
export type CharacterCounts = Record<CharacterClass, number>;

export function emptyCharacterCounts(): CharacterCounts {
	return Object.fromEntries(CLASS_NAMES.map((name) => [name, 0])) as CharacterCounts;
}

const PATTERNS: readonly (readonly RegExp[])[] = [
	[/\b(?:rm|bp|dr|cr)-[0-9a-f]+\b/g, /#\d+\b/g, /\b(?:[nd]\d+|[kl][0-9a-f]{8,9})\b/g, /\b[0-9a-f]{7,64}\b/g],
	[/https?:\/\/[^\s<>"`]+/g, /(?:\/home\/|~\/)[^\s<>"`]+/g, /\b[\w.-]+\/[\w./-]+/g],
	[/```[^]*?```|~~~[^]*?~~~/g, /`+[^`\n]+`+/g, /^[ \t]*(?:#{1,6}(?=\s)|[-+*](?=\s)|\d+[.)](?=\s))/gm, /[{}\[\]|=:]/g],
	[/^>[^\n]*/gm, /"[^"\n]{10,}"/g],
];

/** Already-seen fragments, scoped by an actual chain or sender/recipient pair. */
export class ThreadFragments {
	private scopes = new Map<string, { lines: Map<string, number>; grams: Map<string, number> }>();

	/** Call before remember(): a message never matches itself, even when it repeats a line. */
	counts(text: string, scopes: readonly { key: string; since: number }[]): CharacterCounts {
		const labels = new Uint8Array(text.length);
		labels.fill(5);
		const mark = (start: number, length: number, cls: number) => {
			for (let i = start; i < start + length; i++) if (labels[i] === 5) labels[i] = cls;
		};
		for (const [cls, patterns] of PATTERNS.entries()) {
			for (const pattern of patterns) {
				for (const match of text.matchAll(pattern)) mark(match.index, match[0].length, cls);
			}
		}
		const histories = scopes.flatMap(({ key, since }) => {
			const history = this.scopes.get(key);
			return history ? [{ history, since }] : [];
		});
		let offset = 0;
		for (const line of text.split("\n")) {
			if (
				line.trim() &&
				histories.some(({ history, since }) => history.lines.has(line) && history.lines.get(line)! >= since)
			) {
				mark(offset, line.length, 4);
			}
			offset += line.length + 1;
		}
		// Union all matching 40-code-unit windows: overlapping windows extend longer exact substrings.
		// Each window must have appeared within one earlier message (never across message boundaries).
		for (let i = 0; i + 40 <= text.length; i++) {
			const gram = text.slice(i, i + 40);
			if (histories.some(({ history, since }) => history.grams.has(gram) && history.grams.get(gram)! >= since))
				mark(i, 40, 4);
		}
		const counts = emptyCharacterCounts();
		for (const label of labels) counts[CLASS_NAMES[label]!]++;
		return counts;
	}

	remember(text: string, at: number, keys: readonly string[]): void {
		for (const key of new Set(keys)) {
			let history = this.scopes.get(key);
			if (!history) {
				history = { lines: new Map(), grams: new Map() };
				this.scopes.set(key, history);
			}
			for (const line of text.split("\n")) if (line.trim()) history.lines.set(line, at);
			for (let i = 0; i + 40 <= text.length; i++) history.grams.set(text.slice(i, i + 40), at);
		}
	}
}

export function characterCounts(text: string): CharacterCounts {
	return new ThreadFragments().counts(text, []);
}
