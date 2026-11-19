/**
 * hashline-engine.ts — Atomic two-phase Hashline patch executor.
 *
 * Phase 1 validates syntax, path bounds, hashes/3-way recovery, line bounds,
 * block spans, overlap invariants, and named `@register` availability in memory.
 * Phase 2 writes/deletes files on disk only when every section passes Phase 1.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	checkHunkLineBounds,
	computeFileHash,
	formatHashlineHeader,
	formatNumberedLines,
	HL_HASH_LENGTH,
	isRegisterDefinedLater,
	normalizeLineEndings,
	parseHashlinePatch,
	type Hunk,
	type HunkOpKind,
	type PatchParseError,
	type PatchParseResult,
	type PatchSection,
} from "./hashline-parser.js";
import { globalSnapshotStore, HashlineSnapshotStore, resolveBlockSpan, tryRecoverEdits } from "./hashline-merge.js";
import { checkPatchPathBounds, resolvePatchPath } from "./patch-worktree-bounds.js";

export {
	computeFileHash,
	formatHashlineHeader,
	formatNumberedLines,
	globalSnapshotStore,
	HashlineSnapshotStore,
	HL_HASH_LENGTH,
	normalizeLineEndings,
	parseHashlinePatch,
	resolveBlockSpan,
	tryRecoverEdits,
	type Hunk,
	type HunkOpKind,
	type PatchParseError,
	type PatchParseResult,
	type PatchSection,
};

export interface ApplySectionResult {
	filePath: string;
	op: "updated" | "deleted" | "moved";
	oldHash?: string;
	newHash?: string;
	linesChanged: number;
	newPath?: string;
	recovered?: boolean;
}

export interface PatchApplyReport {
	ok: boolean;
	summary: string;
	results: ApplySectionResult[];
	error?: string;
}

/**
 * Apply a Hashline patch atomically across one or more files.
 */
export function applyHashlinePatch(
	patchText: string,
	options: {
		cwd?: string;
		allowLinkedWorktrees?: boolean;
		homeDir?: string;
		readFile?: (relPath: string) => string | null;
		writeFile?: (relPath: string, content: string) => void;
		deleteFile?: (relPath: string) => void;
		snapshotStore?: HashlineSnapshotStore;
	} = {},
): PatchApplyReport {
	const cwd = options.cwd ?? process.cwd();
	const allowLinkedWorktrees = Boolean(options.allowLinkedWorktrees);
	const homeDir = options.homeDir;
	const store = options.snapshotStore ?? globalSnapshotStore;

	const defaultRead = (p: string) => {
		const full = resolvePatchPath(cwd, p, homeDir);
		if (!existsSync(full)) return null;
		return readFileSync(full, "utf8");
	};

	const defaultWrite = (p: string, content: string) => {
		const full = resolvePatchPath(cwd, p, homeDir);
		const dir = dirname(full);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(full, content, "utf8");
	};

	const defaultDelete = (p: string) => {
		const full = resolvePatchPath(cwd, p, homeDir);
		if (existsSync(full)) {
			unlinkSync(full);
		}
	};

	const read = options.readFile ?? defaultRead;
	const write = options.writeFile ?? defaultWrite;
	const remove = options.deleteFile ?? defaultDelete;

	const parsed = parseHashlinePatch(patchText);
	if (parsed.errors.length > 0) {
		const bulletLines = parsed.errors.map((e) => `• ${e.message}`).join("\n");
		return {
			ok: false,
			summary: `Patch syntax error (0 files written):\n${bulletLines}`,
			results: [],
			error: parsed.errors[0].message,
		};
	}

	const sections = parsed.sections;
	if (sections.length === 0) {
		return {
			ok: false,
			summary: "Could not parse any valid [path#TAG] patch section from the input",
			results: [],
			error: "No valid patch sections",
		};
	}

	const clipboard = new Map<string, string[]>();
	const plannedWrites = new Map<string, string>();
	const plannedDeletes = new Set<string>();
	const results: ApplySectionResult[] = [];

	// ===== Phase 1: Validate all sections and compute target contents in memory =====
	for (let secIdx = 0; secIdx < sections.length; secIdx++) {
		const sec = sections[secIdx];
		if (sec.hunks.length === 0) {
			return {
				ok: false,
				summary: `Empty patch section [${sec.filePath}]: section contains 0 operations (0 files written).`,
				results: [],
				error: `Empty patch section: ${sec.filePath}`,
			};
		}

		const srcBounds = checkPatchPathBounds(sec.filePath, { cwd, allowLinkedWorktrees, homeDir });
		if (!srcBounds.ok) {
			return {
				ok: false,
				summary: `Path out of bounds: files outside the workspace cannot be changed: ${sec.filePath}`,
				results: [],
				error: `Path traversal denied: ${sec.filePath}`,
			};
		}

		const currentText = plannedWrites.get(sec.filePath) ?? read(sec.filePath);
		if (currentText === null) {
			return {
				ok: false,
				summary: `File does not exist: ${sec.filePath} (hashline only changes existing files; use the write tool to create new files)`,
				results: [],
				error: `File not found: ${sec.filePath}`,
			};
		}

		const isCrlf = currentText.includes("\r\n");
		const eol = isCrlf ? "\r\n" : "\n";
		const liveHash = computeFileHash(currentText);
		const workingText = currentText;
		let isRecovered = false;
		let sectionHunks = sec.hunks.map((h) => ({ ...h, bodyLines: [...h.bodyLines] }));

		const absFilePath = srcBounds.resolvedPath;
		if (sec.expectedHash && sec.expectedHash !== liveHash) {
			const snapshot = store.get(absFilePath, sec.expectedHash) ?? store.get(sec.filePath, sec.expectedHash);
			if (snapshot) {
				const recovery = tryRecoverEdits(snapshot, currentText, sectionHunks, sec.filePath);
				if (recovery.success && recovery.remappedHunks) {
					sectionHunks = recovery.remappedHunks;
					isRecovered = true;
				} else {
					return {
						ok: false,
						summary: `File content changed and the three-way merge failed: ${sec.filePath} (expected hash #${sec.expectedHash}, actual hash #${liveHash}; ${recovery.reason ?? "conflict"})\nRead the file again with the read tool, then resubmit the patch.`,
						results: [],
						error: `Hash mismatch and recovery failed on ${sec.filePath}`,
					};
				}
			} else {
				return {
					ok: false,
					summary: `File content does not match the anchor: ${sec.filePath} (expected hash #${sec.expectedHash}, actual hash #${liveHash})\nRead the file again with the read tool to get the latest line numbers and #TAG.`,
					results: [],
					error: `Hash mismatch on ${sec.filePath} (#${sec.expectedHash} vs #${liveHash})`,
				};
			}
		}

		const isEmptyFile = workingText.length === 0;
		const hasTrailingNewline = workingText.endsWith("\n");
		const lines = isEmptyFile ? [] : normalizeLineEndings(workingText).split("\n");
		if (!isEmptyFile && hasTrailingNewline && lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
		}

		let isDeleted = false;
		let moveDest: string | undefined = undefined;

		for (let hIdx = 0; hIdx < sectionHunks.length; hIdx++) {
			const h = sectionHunks[hIdx];
			if (h.kind === "remove_file") {
				isDeleted = true;
				break;
			}
			if (h.kind === "move_file") {
				if (!h.targetPath) continue;
				const destBounds = checkPatchPathBounds(h.targetPath, { cwd, allowLinkedWorktrees, homeDir });
				if (!destBounds.ok || destBounds.rootDir !== srcBounds.rootDir) {
					return {
						ok: false,
						summary: `Path out of bounds: files cannot be moved outside the workspace: ${h.targetPath}`,
						results: [],
						error: `Path traversal denied on move target: ${h.targetPath}`,
					};
				}
				moveDest = h.targetPath;
				continue;
			}

			const boundsErr = checkHunkLineBounds(h, lines.length, sec.filePath);
			if (boundsErr) {
				return { ok: false, summary: boundsErr.summary, results: [], error: boundsErr.error };
			}

			if (h.kind === "put_block" || h.kind === "cut_block" || h.kind === "paste_over_block") {
				const span = resolveBlockSpan(lines, h.lineStart ?? 1, sec.filePath);
				h.lineStart = span.start;
				h.lineEnd = span.end;
			} else if (h.kind === "insert_after_block") {
				const span = resolveBlockSpan(lines, h.lineStart ?? 1, sec.filePath);
				h.lineStart = span.end;
				h.kind = "insert_after";
			}

			if (h.kind === "cut_range" || h.kind === "cut_block") {
				const start = Math.max(1, h.lineStart ?? 1);
				const end = Math.min(lines.length, h.lineEnd ?? start);
				const captured = lines.slice(start - 1, end);
				if (h.registerName) {
					clipboard.set(h.registerName, captured);
				}
			} else if (h.registerName && !clipboard.has(h.registerName)) {
				if (isRegisterDefinedLater(sections, secIdx, hIdx, h.registerName)) {
					return {
						ok: false,
						summary: `Register @${h.registerName} in [${sec.filePath}] is used before it is populated (0 files written). Put the CUT ... @${h.registerName} section/hunk before PUT ... @${h.registerName}.`,
						results: [],
						error: `Out-of-order register @${h.registerName} in ${sec.filePath}`,
					};
				}
				const available = [...clipboard.keys()].map((k) => `@${k}`);
				const hint = available.length > 0 ? ` (defined registers: ${available.join(", ")})` : " (no registers defined)";
				return {
					ok: false,
					summary: `Unknown register @${h.registerName} in [${sec.filePath}]: no prior CUT ... @${h.registerName} defined it${hint} (0 files written).`,
					results: [],
					error: `Unknown register @${h.registerName} in ${sec.filePath}`,
				};
			}
		}

		if (isDeleted) {
			plannedDeletes.add(sec.filePath);
			results.push({
				filePath: sec.filePath,
				op: "deleted",
				oldHash: liveHash,
				linesChanged: lines.length,
			});
			continue;
		}

		const origLineCount = lines.length;
		const replacementSpans: Array<{ start: number; end: number }> = [];
		for (const h of sectionHunks) {
			let s: number;
			let e: number;
			if (h.kind === "insert_before" || h.kind === "insert_after") {
				s = h.lineStart === -1 ? origLineCount : (h.lineStart ?? 1);
				e = s;
			} else if (
				h.kind === "put_range" ||
				h.kind === "put_block" ||
				h.kind === "cut_range" ||
				h.kind === "cut_block" ||
				h.kind === "paste_over_range" ||
				h.kind === "paste_over_block"
			) {
				s = h.lineStart === -1 ? origLineCount : (h.lineStart ?? 1);
				e = h.lineEnd === -1 ? origLineCount : (h.lineEnd ?? s);
			} else {
				continue;
			}
			for (const prev of replacementSpans) {
				if (!(e < prev.start || s > prev.end)) {
					return {
						ok: false,
						summary: `Patch section has overlapping line ranges: ${sec.filePath} (lines ${s}-${e} overlap lines ${prev.start}-${prev.end}). Merge them into one continuous edit.`,
						results: [],
						error: `Overlapping hunks in ${sec.filePath} (${s}-${e} overlaps with ${prev.start}-${prev.end})`,
					};
				}
			}
			replacementSpans.push({ start: s, end: e });
		}

		const sortedHunks = sectionHunks
			.filter((h) => h.kind !== "remove_file" && h.kind !== "move_file")
			.sort((a, b) => {
				const lineA = a.lineStart === -1 ? origLineCount : (a.lineStart ?? 0);
				const lineB = b.lineStart === -1 ? origLineCount : (b.lineStart ?? 0);
				return lineB - lineA;
			});

		let linesChangedCount = 0;

		for (const h of sortedHunks) {
			let contentToInsert: string[] = [];

			if (h.kind === "cut_range" || h.kind === "cut_block") {
				contentToInsert = [];
			} else if (h.registerName) {
				contentToInsert = clipboard.get(h.registerName)!;
			} else {
				contentToInsert = h.bodyLines;
			}

			const start = h.lineStart === -1 ? origLineCount : (h.lineStart ?? 1);

			if (h.kind === "insert_before") {
				const idx = Math.max(0, Math.min(lines.length, start - 1));
				lines.splice(idx, 0, ...contentToInsert);
				linesChangedCount += contentToInsert.length;
			} else if (h.kind === "insert_after") {
				const idx = Math.max(0, Math.min(lines.length, start));
				lines.splice(idx, 0, ...contentToInsert);
				linesChangedCount += contentToInsert.length;
			} else if (
				h.kind === "put_range" ||
				h.kind === "put_block" ||
				h.kind === "cut_range" ||
				h.kind === "cut_block" ||
				h.kind === "paste_over_range" ||
				h.kind === "paste_over_block"
			) {
				const s = Math.max(1, start);
				const resolvedEnd = h.lineEnd === -1 ? origLineCount : (h.lineEnd ?? s);
				const e = Math.min(lines.length, resolvedEnd);
				const count = Math.max(0, e - s + 1);
				lines.splice(s - 1, count, ...contentToInsert);
				linesChangedCount += Math.max(count, contentToInsert.length);
			}
		}

		const emitTrailingNewline = hasTrailingNewline || (isEmptyFile && lines.length > 0);
		const newContent = lines.length === 0 ? "" : lines.join(eol) + (emitTrailingNewline ? eol : "");
		if (moveDest) {
			plannedDeletes.add(sec.filePath);
			plannedWrites.set(moveDest, newContent);
			results.push({
				filePath: sec.filePath,
				op: "moved",
				oldHash: liveHash,
				newHash: computeFileHash(newContent),
				linesChanged: linesChangedCount,
				newPath: moveDest,
				recovered: isRecovered,
			});
		} else {
			plannedWrites.set(sec.filePath, newContent);
			results.push({
				filePath: sec.filePath,
				op: "updated",
				oldHash: liveHash,
				newHash: computeFileHash(newContent),
				linesChanged: linesChangedCount,
				recovered: isRecovered,
			});
		}
	}

	// ===== Phase 2: Commit all planned writes first, then deletes =====
	for (const [p, content] of plannedWrites.entries()) {
		write(p, content);
		store.record(resolvePatchPath(cwd, p, homeDir), content);
	}
	for (const p of plannedDeletes) {
		if (!plannedWrites.has(p)) {
			remove(p);
		}
	}

	const summaryParts = results.map((r) => {
		if (r.op === "deleted") return `Deleted ${r.filePath}`;
		if (r.op === "moved") return `Moved ${r.filePath} -> ${r.newPath} (new hash #${r.newHash})`;
		return `Changed ${r.filePath} (${r.linesChanged} lines changed, new hash #${r.newHash}${r.recovered ? ", three-way self-healed" : ""})`;
	});

	return {
		ok: true,
		summary: `Patch applied:\n${summaryParts.map((s) => "• " + s).join("\n")}`,
		results,
	};
}
