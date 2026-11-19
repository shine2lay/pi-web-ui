/**
 * patch-worktree-bounds.ts — Canonical path boundary validator for the Hashline patch tool.
 *
 * Allows paths whose canonical real location stays strictly inside EITHER:
 * 1. canonicalize(cwd) — the chat's workspace folder (blocking symlink escapes out of cwd), OR
 * 2. when allowLinkedWorktrees is true, canonicalize(worktreeRoot) of a genuine linked git worktree
 *    strictly under canonicalize(homeDir) with valid `.git` file + `commondir` + `gitdir` back-pointer.
 */

import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_GITFILE_BYTES = 4096;
const MAX_SYMLINK_HOPS = 40;

export interface PatchBoundsOptions {
	cwd: string;
	allowLinkedWorktrees?: boolean;
	homeDir?: string;
}

export type PatchBoundsResult =
	{ ok: true; resolvedPath: string; rootDir: string; kind: "cwd" | "worktree" } | { ok: false; resolvedPath: string };

const safeLstat = (p: string) => {
	try {
		return lstatSync(p);
	} catch {
		return null;
	}
};

const safeRealpath = (p: string) => {
	try {
		return realpathSync(p);
	} catch {
		return null;
	}
};

const readSmallRegularFile = (p: string): string | null => {
	const st = safeLstat(p);
	if (!st || !st.isFile() || st.size > MAX_GITFILE_BYTES) return null;
	try {
		return readFileSync(p, "utf8");
	} catch {
		return null;
	}
};

export function resolvePatchPath(cwd: string, rawPath: string, homeDir: string = homedir()): string {
	const expanded =
		rawPath === "~"
			? homeDir
			: rawPath.startsWith("~/") || rawPath.startsWith("~\\")
				? join(homeDir, rawPath.slice(2))
				: rawPath;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

const isStrictlyInside = (childPath: string, rootDir: string): boolean =>
	childPath !== rootDir && childPath.startsWith(rootDir.endsWith(sep) ? rootDir : rootDir + sep);

/** Resolves symlinks across existing ancestors and dangling symlinks (e.g. MV targets). */
export function canonicalizePatchPath(absPath: string): string | null {
	let target = resolve(absPath);
	for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop++) {
		const direct = safeRealpath(target);
		if (direct) return direct;
		const missingTail: string[] = [];
		let cur = target;
		let followed = false;
		while (true) {
			const st = safeLstat(cur);
			if (!st) {
				const parent = dirname(cur);
				if (parent === cur) return missingTail.length > 0 ? resolve(cur, ...[...missingTail].reverse()) : cur;
				missingTail.push(basename(cur));
				cur = parent;
				continue;
			}
			if (st.isSymbolicLink()) {
				try {
					const nextBase = resolve(dirname(cur), readlinkSync(cur));
					target = missingTail.length > 0 ? resolve(nextBase, ...[...missingTail].reverse()) : nextBase;
					followed = true;
					break;
				} catch {
					return null;
				}
			}
			const realBase = safeRealpath(cur);
			return realBase ? (missingTail.length > 0 ? resolve(realBase, ...[...missingTail].reverse()) : realBase) : null;
		}
		if (!followed) return null;
	}
	return null;
}

export function isValidLinkedGitWorktree(worktreeRoot: string): boolean {
	try {
		const rootStat = safeLstat(worktreeRoot);
		if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
		const dotGitPath = join(worktreeRoot, ".git");
		const firstLine = (readSmallRegularFile(dotGitPath) ?? "").split(/\r?\n/, 1)[0] ?? "";
		if (!firstLine.startsWith("gitdir:")) return false;
		const rawGitDir = firstLine.slice("gitdir:".length).trim();
		if (!rawGitDir) return false;
		const gitDir = resolve(worktreeRoot, rawGitDir);
		if (!statSync(gitDir).isDirectory()) return false;
		const rawCommon = (readSmallRegularFile(join(gitDir, "commondir")) ?? "").trim();
		const rawBack = (readSmallRegularFile(join(gitDir, "gitdir")) ?? "").trim();
		if (!rawCommon || !rawBack) return false;
		const commonDir = resolve(gitDir, rawCommon);
		if (!statSync(commonDir).isDirectory() || realpathSync(gitDir) === realpathSync(commonDir)) return false;
		return realpathSync(resolve(gitDir, rawBack)) === realpathSync(dotGitPath);
	} catch {
		return false;
	}
}

function findEnclosingLinkedWorktree(resolvedTarget: string, realTarget: string, homeDir: string): string | null {
	const absHome = resolve(homeDir);
	const realHome = canonicalizePatchPath(absHome);
	if (!realHome || !isStrictlyInside(realTarget, realHome)) return null;
	const relFromHome = isStrictlyInside(resolvedTarget, absHome)
		? relative(absHome, resolvedTarget)
		: isStrictlyInside(resolvedTarget, realHome)
			? relative(realHome, resolvedTarget)
			: "";
	if (!relFromHome) return null;

	let cur = realHome;
	for (const seg of dirname(relFromHome)
		.split(sep)
		.filter((s) => s.length > 0 && s !== ".")) {
		cur = join(cur, seg);
		const curStat = safeLstat(cur);
		if (!curStat || curStat.isSymbolicLink() || !curStat.isDirectory()) return null;
		const dotGitStat = safeLstat(join(cur, ".git"));
		if (!dotGitStat) continue;
		if (!dotGitStat.isFile() || !isValidLinkedGitWorktree(cur)) return null;
		const realWtRoot = canonicalizePatchPath(cur);
		if (!realWtRoot || !isStrictlyInside(realWtRoot, realHome) || !isStrictlyInside(realTarget, realWtRoot)) {
			return null;
		}
		const relInsideWt = relative(realWtRoot, realTarget);
		return !relInsideWt || relInsideWt === ".git" || relInsideWt.startsWith(`.git${sep}`) ? null : realWtRoot;
	}
	return null;
}

export function checkPatchPathBounds(rawPath: string, options: PatchBoundsOptions): PatchBoundsResult {
	const homeDir = options.homeDir ?? homedir();
	const resolvedPath = resolvePatchPath(options.cwd, rawPath, homeDir);
	const realTarget = canonicalizePatchPath(resolvedPath);
	if (!realTarget) return { ok: false, resolvedPath };
	const realCwd = canonicalizePatchPath(options.cwd);
	if (realCwd && isStrictlyInside(realTarget, realCwd)) {
		return { ok: true, resolvedPath, rootDir: realCwd, kind: "cwd" };
	}
	if (options.allowLinkedWorktrees) {
		const wtRoot = findEnclosingLinkedWorktree(resolvedPath, realTarget, homeDir);
		if (wtRoot) return { ok: true, resolvedPath, rootDir: wtRoot, kind: "worktree" };
	}
	return { ok: false, resolvedPath };
}
