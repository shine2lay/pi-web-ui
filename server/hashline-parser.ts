/**
 * hashline-parser.ts — Content hashing, strict Hashline patch parser, and pure hunk validation helpers.
 */

import { createHash } from "node:crypto";

export const HL_HASH_LENGTH = 4;

/** Normalize CRLF/CR line endings to LF for cross-platform hash consistency. */
export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Compute uppercase 4-hex content hash (ignoring trailing horizontal whitespace per line). */
export function computeFileHash(text: string): string {
	const normalized = normalizeLineEndings(text).replace(/[ \t]+(?=\n|$)/g, "");
	const hash = createHash("sha256").update(normalized, "utf8").digest("hex");
	return hash.slice(0, HL_HASH_LENGTH).toUpperCase();
}

/** Format a file section header with content hash: `[src/app.ts#A1B2]`. */
export function formatHashlineHeader(filePath: string, hash: string): string {
	return `[${filePath}#${hash}]`;
}

/** Render 1-indexed numbered lines (`1:line1\n2:line2`). */
export function formatNumberedLines(text: string, startLine = 1): string {
	const lines = normalizeLineEndings(text).split("\n");
	return lines.map((l, i) => `${startLine + i}:${l}`).join("\n");
}

export type HunkOpKind =
	| "put_range"
	| "put_block"
	| "insert_before"
	| "insert_after"
	| "insert_after_block"
	| "cut_range"
	| "cut_block"
	| "paste_at"
	| "paste_over_range"
	| "paste_over_block"
	| "remove_file"
	| "move_file";

export interface Hunk {
	kind: HunkOpKind;
	lineStart?: number;
	lineEnd?: number;
	registerName?: string;
	targetPath?: string;
	bodyLines: string[];
}

export interface PatchSection {
	filePath: string;
	expectedHash?: string;
	hunks: Hunk[];
}

export interface PatchParseError {
	line: number;
	text: string;
	section?: string;
	message: string;
}

export interface PatchParseResult {
	sections: PatchSection[];
	errors: PatchParseError[];
}

function validatePutAnchor(
	prefix: string | undefined,
	anchorStr: string,
	rangeEndStr: string | undefined,
	isBlock: boolean,
): { ok: true; start: number; end?: number } | { ok: false; reason: string } {
	const hasRange = rangeEndStr !== undefined;
	if (anchorStr === "$") {
		if (hasRange || isBlock) {
			return { ok: false, reason: "'$' end-of-file anchor cannot be combined with '.=M' or '*'" };
		}
		return { ok: true, start: -1, end: undefined };
	}
	if (prefix && hasRange) {
		return { ok: false, reason: `'${prefix}' insert anchor cannot be combined with '.=M' line range` };
	}
	if (prefix === "<" && isBlock) {
		return { ok: false, reason: "'<' insert-before anchor cannot be combined with '*'" };
	}
	const start = parseInt(anchorStr, 10);
	if (start < 1) {
		return { ok: false, reason: `line numbers are 1-indexed (got ${start})` };
	}
	if (hasRange) {
		const end = parseInt(rangeEndStr, 10);
		if (end < start) {
			return { ok: false, reason: `range end line ${end} is smaller than start line ${start}` };
		}
		return { ok: true, start, end };
	}
	return { ok: true, start, end: prefix || isBlock ? undefined : start };
}

/** Check whether `@reg` is populated by a `CUT ... @reg` later in the same patch. */
export function isRegisterDefinedLater(
	sections: readonly PatchSection[],
	secIdx: number,
	hunkIdx: number,
	reg: string,
): boolean {
	for (let s = secIdx; s < sections.length; s++) {
		const hunks = sections[s].hunks;
		const startH = s === secIdx ? hunkIdx + 1 : 0;
		for (let j = startH; j < hunks.length; j++) {
			const h = hunks[j];
			if ((h.kind === "cut_range" || h.kind === "cut_block") && h.registerName === reg) {
				return true;
			}
		}
	}
	return false;
}

/** Validate 1-indexed hunk anchor bounds against `lineCount` before block expansion. */
export function checkHunkLineBounds(
	h: Hunk,
	lineCount: number,
	filePath: string,
): { summary: string; error: string } | null {
	if (h.kind === "remove_file" || h.kind === "move_file") return null;

	const isCut = h.kind === "cut_range" || h.kind === "cut_block";
	const isBlock =
		h.kind === "put_block" ||
		h.kind === "cut_block" ||
		h.kind === "paste_over_block" ||
		h.kind === "insert_after_block";

	if (lineCount === 0) {
		if (isCut || isBlock) {
			return {
				summary: `Line out of range: ${filePath} is empty (0 lines); cannot apply ${isCut ? "CUT" : "block '*'"} operation.`,
				error: `Line out of bounds on empty file: ${filePath}`,
			};
		}
		if (h.lineStart !== -1 && typeof h.lineStart === "number") {
			if (h.lineStart !== 1 || (h.lineEnd !== undefined && h.lineEnd !== 1)) {
				return {
					summary: `Line out of range: ${filePath} line ${h.lineStart} (the file has 0 lines).`,
					error: `Line out of bounds: line ${h.lineStart} in ${filePath} (0 lines total)`,
				};
			}
		}
		return null;
	}

	if (h.lineStart !== -1 && typeof h.lineStart === "number") {
		if (h.lineStart < 1 || h.lineStart > lineCount) {
			return {
				summary: `Line out of range: ${filePath} line ${h.lineStart} (the file has only ${lineCount} lines). Check the line numbers again with the read tool.`,
				error: `Line out of bounds: line ${h.lineStart} in ${filePath} (${lineCount} lines total)`,
			};
		}
		if (h.lineEnd !== undefined && h.lineEnd > lineCount) {
			return {
				summary: `Line out of range: ${filePath} end line ${h.lineEnd} is past the end of the file (${lineCount} lines).`,
				error: `Line out of bounds: end line ${h.lineEnd} in ${filePath} (${lineCount} lines total)`,
			};
		}
	}
	return null;
}

/**
 * Strictly parse Hashline patch text into sections and explicit syntax errors.
 * Fails closed on unrecognized directives, malformed headers, orphan '+' lines,
 * empty colon-headed `PUT ...:` blocks, and empty `[path]` sections.
 */
export function parseHashlinePatch(patchText: string): PatchParseResult {
	const lines = normalizeLineEndings(patchText).split("\n");
	const sections: PatchSection[] = [];
	const errors: PatchParseError[] = [];

	let currentSection: PatchSection | null = null;
	let currentSectionHeaderLine = 0;
	let currentSectionHadError = false;

	let currentHunk: Hunk | null = null;
	let currentHunkHeaderLine = 0;
	let currentHunkHeaderText = "";

	const recordError = (line: number, text: string, message: string, section?: string) => {
		errors.push({ line, text, section, message });
		if (currentSection) {
			currentSectionHadError = true;
		}
	};

	const flushHunk = () => {
		if (!currentHunk || !currentSection) return;
		if (currentHunk.bodyLines.length === 0) {
			recordError(
				currentHunkHeaderLine,
				currentHunkHeaderText,
				`PUT block '${currentHunkHeaderText}' at line ${currentHunkHeaderLine} in [${currentSection.filePath}] has no '+' body lines (use CUT to delete lines, or '+' alone for a blank line)`,
				currentSection.filePath,
			);
		} else {
			currentSection.hunks.push(currentHunk);
		}
		currentHunk = null;
	};

	const flushSection = () => {
		flushHunk();
		if (!currentSection) return;
		if (currentSection.hunks.length === 0 && !currentSectionHadError) {
			recordError(
				currentSectionHeaderLine,
				`[${currentSection.filePath}]`,
				`Empty patch section [${currentSection.filePath}] at line ${currentSectionHeaderLine}: expected at least one PUT, CUT, REM, or MV directive`,
				currentSection.filePath,
			);
		}
		sections.push(currentSection);
		currentSection = null;
		currentSectionHadError = false;
	};

	for (let i = 0; i < lines.length; i++) {
		const lineNo = i + 1;
		const rawLine = lines[i];
		const trimmed = rawLine.trim();

		if (rawLine.startsWith("+")) {
			if (currentHunk) {
				currentHunk.bodyLines.push(rawLine.slice(1));
			} else {
				const where = currentSection ? ` in [${currentSection.filePath}]` : "";
				recordError(
					lineNo,
					rawLine,
					`Orphan '+' body line at line ${lineNo}${where}: '+' lines are only valid directly under a colon-headed 'PUT ...:' directive (blank lines inside a PUT block must also start with '+')`,
					currentSection?.filePath,
				);
			}
			continue;
		}

		if (trimmed.length === 0) {
			flushHunk();
			continue;
		}

		const secMatch = rawLine.match(/^\s*\[([^#\]]+)(?:#([0-9a-fA-F]{4}))?\]\s*$/);
		if (secMatch) {
			const secPath = secMatch[1].trim();
			if (secPath.length === 0) {
				flushSection();
				recordError(lineNo, rawLine, `Empty section path at line ${lineNo}: '${trimmed}'`);
				continue;
			}
			flushSection();
			currentSection = {
				filePath: secPath,
				expectedHash: secMatch[2] ? secMatch[2].toUpperCase() : undefined,
				hunks: [],
			};
			currentSectionHeaderLine = lineNo;
			currentSectionHadError = false;
			continue;
		}

		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			flushSection();
			recordError(
				lineNo,
				rawLine,
				`Malformed section header at line ${lineNo}: '${trimmed}' (expected [path] or [path#4HEX])`,
			);
			continue;
		}

		if (!currentSection) {
			recordError(lineNo, rawLine, `Unexpected line at line ${lineNo} before any [path] section header: '${trimmed}'`);
			continue;
		}

		if (/^REM$/i.test(trimmed)) {
			flushHunk();
			currentSection.hunks.push({ kind: "remove_file", bodyLines: [] });
			continue;
		}
		if (/^REM\b/i.test(trimmed)) {
			flushHunk();
			recordError(
				lineNo,
				rawLine,
				`Malformed REM directive at line ${lineNo} in [${currentSection.filePath}]: '${trimmed}' (REM takes no arguments)`,
				currentSection.filePath,
			);
			continue;
		}

		const mvMatch = trimmed.match(/^MV\s+(\S+)$/i);
		if (mvMatch) {
			flushHunk();
			currentSection.hunks.push({ kind: "move_file", targetPath: mvMatch[1], bodyLines: [] });
			continue;
		}
		if (/^MV\b/i.test(trimmed)) {
			flushHunk();
			recordError(
				lineNo,
				rawLine,
				`Malformed MV directive at line ${lineNo} in [${currentSection.filePath}]: '${trimmed}' (expected 'MV <dest/path>')`,
				currentSection.filePath,
			);
			continue;
		}

		const cutMatch = trimmed.match(/^CUT\s+(\d+)(?:\.=(\d+)|(\*))\s*(?:@([a-zA-Z0-9_-]+))?$/);
		if (cutMatch) {
			flushHunk();
			const start = parseInt(cutMatch[1], 10);
			const isBlock = Boolean(cutMatch[3]);
			const end = cutMatch[2] !== undefined ? parseInt(cutMatch[2], 10) : start;
			const reg = cutMatch[4];
			if (start < 1 || (!isBlock && end < start)) {
				recordError(
					lineNo,
					rawLine,
					`Invalid line range in CUT directive at line ${lineNo} in [${currentSection.filePath}]: '${trimmed}'`,
					currentSection.filePath,
				);
				continue;
			}
			currentSection.hunks.push({
				kind: isBlock ? "cut_block" : "cut_range",
				lineStart: start,
				lineEnd: isBlock ? undefined : end,
				registerName: reg,
				bodyLines: [],
			});
			continue;
		}
		if (/^CUT\b/i.test(trimmed)) {
			flushHunk();
			recordError(
				lineNo,
				rawLine,
				`Malformed CUT directive at line ${lineNo} in [${currentSection.filePath}]: '${trimmed}' (expected 'CUT N.=M [@reg]' or 'CUT N* [@reg]')`,
				currentSection.filePath,
			);
			continue;
		}

		const pasteMatch = trimmed.match(/^PUT\s+(<|>)?(\d+|\$)(?:\.=(\d+)|(\*))?\s+@([a-zA-Z0-9_-]+)$/);
		if (pasteMatch) {
			flushHunk();
			const prefix = pasteMatch[1];
			const anchorStr = pasteMatch[2];
			const isBlock = Boolean(pasteMatch[4]);
			const reg = pasteMatch[5];
			const validated = validatePutAnchor(prefix, anchorStr, pasteMatch[3], isBlock);
			if (!validated.ok) {
				recordError(
					lineNo,
					rawLine,
					`Invalid PUT @register directive at line ${lineNo} in [${currentSection.filePath}]: '${trimmed}' (${validated.reason})`,
					currentSection.filePath,
				);
				continue;
			}
			let kind: HunkOpKind;
			if (prefix === "<") {
				kind = "insert_before";
			} else if (prefix === ">") {
				kind = isBlock ? "insert_after_block" : "insert_after";
			} else if (isBlock) {
				kind = "paste_over_block";
			} else {
				kind = "paste_over_range";
			}
			currentSection.hunks.push({
				kind,
				lineStart: validated.start,
				lineEnd: validated.end,
				registerName: reg,
				bodyLines: [],
			});
			continue;
		}

		const putHeaderMatch = trimmed.match(/^PUT\s+(<|>)?(\d+|\$)(?:\.=(\d+)|(\*))?:$/);
		if (putHeaderMatch) {
			flushHunk();
			const prefix = putHeaderMatch[1];
			const anchorStr = putHeaderMatch[2];
			const isBlock = Boolean(putHeaderMatch[4]);
			const validated = validatePutAnchor(prefix, anchorStr, putHeaderMatch[3], isBlock);
			if (!validated.ok) {
				recordError(
					lineNo,
					rawLine,
					`Invalid PUT directive at line ${lineNo} in [${currentSection.filePath}]: '${trimmed}' (${validated.reason})`,
					currentSection.filePath,
				);
				continue;
			}
			let kind: HunkOpKind;
			if (prefix === "<") {
				kind = "insert_before";
			} else if (prefix === ">") {
				kind = isBlock ? "insert_after_block" : "insert_after";
			} else if (isBlock) {
				kind = "put_block";
			} else {
				kind = "put_range";
			}
			currentHunk = {
				kind,
				lineStart: validated.start,
				lineEnd: validated.end,
				bodyLines: [],
			};
			currentHunkHeaderLine = lineNo;
			currentHunkHeaderText = trimmed;
			continue;
		}

		flushHunk();
		const putHint = /^PUT\b/i.test(trimmed)
			? trimmed.includes("@") && trimmed.endsWith(":")
				? " (register paste 'PUT ... @reg' must not end with ':')"
				: " (expected 'PUT <anchor>:' followed by '+' lines, or 'PUT <anchor> @register')"
			: " (expected [path#TAG], PUT, CUT, REM, or MV)";
		recordError(
			lineNo,
			rawLine,
			`Malformed or unrecognized directive at line ${lineNo} in [${currentSection.filePath}]: '${trimmed}'${putHint}`,
			currentSection.filePath,
		);
	}

	flushSection();
	return { sections, errors };
}
