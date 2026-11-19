/**
 * hashline-merge.ts — Syntactic block span resolution, per-file LRU snapshots, and 3-way line merge recovery.
 */

import { computeFileHash, normalizeLineEndings, type Hunk } from "./hashline-parser.js";

/**
 * Heuristic syntactic block boundary resolver starting at `startLine` (1-indexed).
 * Supports Markdown headings, indentation-delimited blocks (Python/YAML/Makefile),
 * and brace/bracket/paren nesting (JS/TS/Rust/Go/C/C++/Java/PHP).
 */
export function resolveBlockSpan(
	lines: readonly string[],
	startLine: number,
	filePath = "",
): { start: number; end: number } {
	const n = lines.length;
	const sIdx = Math.max(0, Math.min(n - 1, startLine - 1));
	const startContent = lines[sIdx] ?? "";
	const trimmedStart = startContent.trim();

	const isMd = /\.(md|markdown|mdx)$/i.test(filePath);
	const mdHeaderMatch = trimmedStart.match(/^(#{1,6})\s+/);
	if (isMd && mdHeaderMatch) {
		const level = mdHeaderMatch[1].length;
		let endIdx = sIdx;
		for (let i = sIdx + 1; i < n; i++) {
			const line = lines[i].trim();
			const m = line.match(/^(#{1,6})\s+/);
			if (m && m[1].length <= level) break;
			endIdx = i;
		}
		return { start: sIdx + 1, end: endIdx + 1 };
	}

	const isIndentLang = /\.(py|yaml|yml|makefile|dockerfile)$/i.test(filePath) || !startContent.includes("{");
	if (isIndentLang && (trimmedStart.endsWith(":") || !trimmedStart.includes("{"))) {
		const baseIndent = startContent.match(/^[ \t]*/)?.[0].length ?? 0;
		let endIdx = sIdx;
		for (let i = sIdx + 1; i < n; i++) {
			const line = lines[i];
			if (line.trim().length === 0) continue;
			const curIndent = line.match(/^[ \t]*/)?.[0].length ?? 0;
			if (curIndent <= baseIndent) break;
			endIdx = i;
		}
		return { start: sIdx + 1, end: endIdx + 1 };
	}

	let braceDepth = 0;
	let parenDepth = 0;
	let bracketDepth = 0;
	let seenOpen = false;
	let endIdx = sIdx;

	for (let i = sIdx; i < n; i++) {
		const line = lines[i];
		let inString: string | null = null;
		let escaped = false;

		for (let j = 0; j < line.length; j++) {
			const char = line[j];
			const next = line[j + 1];

			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (inString) {
				if (char === inString) inString = null;
				continue;
			}
			if (char === '"' || char === "'" || char === "`") {
				inString = char;
				continue;
			}
			if (char === "/" && next === "/") break;

			if (char === "{") {
				braceDepth++;
				seenOpen = true;
			} else if (char === "}") {
				braceDepth--;
			} else if (char === "(") {
				parenDepth++;
			} else if (char === ")") {
				parenDepth--;
			} else if (char === "[") {
				bracketDepth++;
			} else if (char === "]") {
				bracketDepth--;
			}
		}

		endIdx = i;
		if (seenOpen && braceDepth <= 0 && parenDepth <= 0 && bracketDepth <= 0) {
			break;
		}
	}

	return { start: sIdx + 1, end: endIdx + 1 };
}

export class HashlineSnapshotStore {
	/** Maximum snapshots retained per file (LRU) across a session. */
	private static readonly MAX_PER_FILE = 200;

	private snapshots = new Map<string, Map<string, string>>();

	record(filePath: string, text: string): string {
		const hash = computeFileHash(text);
		let fileMap = this.snapshots.get(filePath);
		if (!fileMap) {
			fileMap = new Map();
			this.snapshots.set(filePath, fileMap);
		}
		fileMap.delete(hash);
		fileMap.set(hash, text);
		while (fileMap.size > HashlineSnapshotStore.MAX_PER_FILE) {
			const oldest = fileMap.keys().next().value;
			if (oldest === undefined) break;
			fileMap.delete(oldest);
		}
		return hash;
	}

	get(filePath: string, hash: string): string | undefined {
		const fileMap = this.snapshots.get(filePath);
		if (!fileMap) return undefined;
		const key = hash.toUpperCase();
		const hit = fileMap.get(key);
		if (hit !== undefined) {
			fileMap.delete(key);
			fileMap.set(key, hit);
		}
		return hit;
	}
}

/** Global session-scoped snapshot singleton. */
export const globalSnapshotStore = new HashlineSnapshotStore();

/**
 * Heuristic 3-way line merge:
 * If external disk changes did not intrude into `hunks`' anchor neighborhoods,
 * remap anchor line numbers onto `currentText`.
 */
export function tryRecoverEdits(
	baseText: string,
	currentText: string,
	hunks: Hunk[],
	_filePath: string,
): { success: boolean; remappedHunks?: Hunk[]; reason?: string } {
	const baseLines = normalizeLineEndings(baseText).split("\n");
	const curLines = normalizeLineEndings(currentText).split("\n");

	if (baseText === currentText) return { success: true, remappedHunks: hunks };

	let firstDiff = -1;
	for (let i = 0; i < Math.max(baseLines.length, curLines.length); i++) {
		if (baseLines[i] !== curLines[i]) {
			firstDiff = i + 1;
			break;
		}
	}

	if (firstDiff === -1) return { success: true, remappedHunks: hunks };

	const delta = curLines.length - baseLines.length;
	const remapped: Hunk[] = [];

	for (const hunk of hunks) {
		const start = hunk.lineStart ?? 1;
		const end = hunk.lineEnd ?? start;

		if (start < firstDiff && end < firstDiff) {
			remapped.push({ ...hunk });
		} else {
			const shiftedStart = Math.max(1, start + delta);
			const shiftedEnd = Math.max(1, end + delta);

			const baseSnippet = baseLines.slice(Math.max(0, start - 2), Math.min(baseLines.length, end + 1)).join("\n");
			const curSnippet = curLines
				.slice(Math.max(0, shiftedStart - 2), Math.min(curLines.length, shiftedEnd + 1))
				.join("\n");

			if (baseSnippet.trim() === curSnippet.trim() || delta === 0) {
				remapped.push({
					...hunk,
					lineStart: shiftedStart,
					lineEnd: hunk.lineEnd !== undefined ? shiftedEnd : undefined,
				});
			} else {
				return {
					success: false,
					reason: `The target file was changed externally near line ${firstDiff}; the patch anchor (line ${start}) conflicts`,
				};
			}
		}
	}

	return { success: true, remappedHunks: remapped };
}
