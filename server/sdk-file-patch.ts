/**
 * Shared startup file-patch helper for installed node_modules packages.
 *
 * Used by server/patch-remote-catalog.ts, server/patch-node-pty.ts,
 * server/patch-lazy-boundary-context.ts, and subsequent startup SDK patches so
 * the read / single-occurrence match / all-or-nothing rewrite / idempotency /
 * startup guard logic lives in one module.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SourceReplacement {
	old: string;
	new: string;
}

export type SourcePatchResult =
	/** Every replacement matched once (or was already applied) and at least one was rewritten. */
	| { status: "patched"; source: string }
	/** Every replacement is in place already. */
	| { status: "already"; source: string }
	/** The source no longer matches: `missing` lists the fragments not found (or duplicated). */
	| { status: "mismatch"; source: string; missing: string[] };

export type FilePatchStatus = SourcePatchResult["status"] | "missing";

export interface SdkFileTarget {
	name: string;
	file: string | null | undefined;
	replacements: ReadonlyArray<SourceReplacement>;
}

export interface PatchBatchResult {
	status: FilePatchStatus;
	files: Record<string, FilePatchStatus>;
}

export interface ApplySdkFilePatchesOptions {
	tag: string;
	warn?: ((msg: string) => void) | null;
	log?: ((msg: string) => void) | null;
}

/**
 * Rewrites `source` with all `replacements` (pure; no file access).
 * All-or-nothing: if any replacement is neither already applied nor matched
 * exactly once, returns `{ status: "mismatch", source, missing }` with the
 * original `source` unchanged.
 */
export function patchSource(source: string, replacements: ReadonlyArray<SourceReplacement>): SourcePatchResult {
	let next = source;
	const missing: string[] = [];
	for (const r of replacements) {
		if (next.includes(r.new) && !next.includes(r.old)) continue;
		const at = next.indexOf(r.old);
		if (at < 0 || next.indexOf(r.old, at + 1) >= 0) {
			missing.push(r.old);
			continue;
		}
		next = next.replace(r.old, r.new);
	}
	if (missing.length > 0) return { status: "mismatch", source, missing };
	return { status: next === source ? "already" : "patched", source: next };
}

/**
 * Patches one file on disk idempotently. Returns `"missing"` when `file` is
 * null or does not exist, `"mismatch"` when any replacement fragment fails to
 * match uniquely (leaving the file untouched), `"already"` when already patched,
 * or `"patched"` when rewritten.
 */
export function patchFile(
	file: string | null | undefined,
	replacements: ReadonlyArray<SourceReplacement>,
): FilePatchStatus {
	if (!file || !existsSync(file)) return "missing";
	const result = patchSource(readFileSync(file, "utf8"), replacements);
	if (result.status === "patched") writeFileSync(file, result.source, "utf8");
	return result.status;
}

/**
 * Resolves a path inside the installed `@earendil-works/pi-coding-agent` `dist/`
 * directory (following `import.meta.resolve("@earendil-works/pi-coding-agent")` -> `dist/index.js`),
 * or returns `null` if the package cannot be resolved.
 */
export function resolvePiSdkFile(...segments: string[]): string | null {
	try {
		const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		return join(dirname(entry), ...segments);
	} catch {
		return null;
	}
}

/**
 * Applies one or more guarded file patches and aggregates their statuses.
 * Never throws: file errors or mismatches are logged via `options.warn` and
 * reported in the returned `PatchBatchResult`.
 */
export function applySdkFilePatches(
	targets: ReadonlyArray<SdkFileTarget>,
	options: ApplySdkFilePatchesOptions,
): PatchBatchResult {
	const warn = options.warn === undefined ? (msg: string) => console.warn(msg) : options.warn;
	const files: Record<string, FilePatchStatus> = {};

	for (const target of targets) {
		try {
			const status = patchFile(target.file, target.replacements);
			files[target.name] = status;
			if (status === "missing") {
				warn?.(`[${options.tag}] ${target.name} was not found at ${target.file ?? "(unresolved)"} — patch skipped`);
			} else if (status === "mismatch") {
				warn?.(`[${options.tag}] ${target.name} no longer matches expected SDK source — patch skipped`);
			}
		} catch (err) {
			files[target.name] = "mismatch";
			warn?.(`[${options.tag}] Failed to patch ${target.name}: ${(err as Error).message}`);
		}
	}

	const statuses = Object.values(files);
	const status: FilePatchStatus = statuses.includes("missing")
		? "missing"
		: statuses.includes("mismatch")
			? "mismatch"
			: statuses.includes("patched")
				? "patched"
				: "already";

	if (status === "patched" || status === "already") {
		options.log?.(`[${options.tag}] applied (${status})`);
	}

	return { status, files };
}
