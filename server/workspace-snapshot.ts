/**
 * server/workspace-snapshot.ts
 *
 * 工作区版本影子快照机制（Workspace Snapshot / Dual-State Rollback）。
 *
 * 每次用户发起新任务或运行关键操作前，为当前工作区记录轻量快照引用（Git commit SHA）。
 * 机制：
 * - 利用独立的临时 GIT_INDEX_FILE，通过 `git add -A` + `git write-tree` + `git commit-tree` 生成独立 commit；
 * - 绝不改变用户现有的 HEAD、branch 指针、工作区文件或 .git/index；
 * - 回滚时若启用 restoreWorkspace，通过 `git checkout <snapshotRef> -- .` 与 `git clean -fd` 还原物理文件。
 *
 * snapshot-index-cache (Ops #565, W1-B; after upstream 0.111.0): the temp index starts from the repo's
 * real index instead of empty, so `git add -A` re-hashes only files whose stat data changed instead of
 * every file in the repo on every prompt (the snapshot is awaited before the prompt is sent; measured
 * 0.3-1.1 s -> ~0.05-0.15 s on 1-3k-file repos). The temp index is then kept (`pi-snapshot-cache-<hash
 * of cwd>` in the git dir) and seeds the next snapshot of that folder, but only while the real index and
 * the main ignore files are unchanged (stamp: inode, size, mtime of the index, info/exclude and the
 * top-level and cwd .gitignore): a commit, git add/rm, git status refreshing the index or an edit of
 * those ignore files reseeds from the real index. On every reuse, Git rechecks standard exclusions
 * (including nested .gitignore and core.excludesFile): ignored paths held only by the cache are removed
 * before staging, while genuinely tracked-but-ignored files stay (Ops #572). This does not depend on
 * ignore stamps covering every exclusion source. The kept index saves re-hashing files
 * changed since git last refreshed the real index, and untracked files. The stamp is in memory: after a
 * restart the first snapshot of a folder seeds from the real index. Every copy of an index keeps the
 * original's mtime, and the kept one is renamed into place: git's racy-git check content-compares an
 * entry whose mtime isn't older than the index file, and a copy with a fresh mtime would let a same-size
 * edit made in the second git last hashed that file into the snapshot unseen (upstream copies plainly).
 * When the tree comes out the same as the last snapshot of that folder, its commit is reused (one
 * cat-file check instead of rev-parse HEAD + commit-tree, and no new commit object per prompt; restore
 * reads only the tree). Same whole-repo snapshot as before; a broken seed retries from an empty index,
 * the old way, and that index isn't kept. Seeding from the real index also keeps tracked files that
 * .gitignore matches in the snapshot (an empty index left them out, and a restore's read-tree --reset
 * then deleted them from the working tree). A real index with an entry whose working-tree changes git
 * add skips (assume-unchanged, skip-worktree), or one this file can't fully read (split index, SHA-256),
 * seeds nothing: that folder's snapshots start empty, the old way, so they still hold the edited file.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gitDirOf } from "./scm.js";

const exec = promisify(execFile);

/** 单次 git 快照/还原命令超时时间（毫秒）。 */
const GIT_SNAPSHOT_TIMEOUT_MS = 15_000;

/** Raw stdout (NUL-delimited filenames must not be trimmed); optional input goes over stdin, not argv. */
async function runGitRaw(cwd: string, args: string[], envExtra?: NodeJS.ProcessEnv, input?: string): Promise<string> {
	const pending = exec("git", ["-c", "core.quotepath=false", ...args], {
		cwd,
		env: envExtra ? { ...process.env, ...envExtra } : process.env,
		timeout: GIT_SNAPSHOT_TIMEOUT_MS,
		maxBuffer: 16 * 1024 * 1024,
		windowsHide: true,
	});
	if (input !== undefined) {
		// Git can fail before reading stdin (e.g. a locked index). Await its exit error, not an unhandled EPIPE.
		pending.child.stdin?.on("error", () => {});
		pending.child.stdin?.end(input);
	}
	return (await pending).stdout;
}

/** 执行单条 git 命令，返回 stdout。 */
async function runGit(cwd: string, args: string[], envExtra?: NodeJS.ProcessEnv): Promise<string> {
	return (await runGitRaw(cwd, args, envExtra)).trim();
}

/** 检查工作区是否由 Git 管理。 */
export async function isGitWorkspace(cwd: string): Promise<boolean> {
	return (await gitDirOf(cwd)) !== null;
}

/** Where a folder's shadow index is kept between snapshots (one per cwd, in that repo's git dir). */
export function snapshotCachePath(gitDir: string, cwd: string): string {
	const hash = createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 16);
	return join(gitDir, `pi-snapshot-cache-${hash}`);
}

/** Last snapshot per folder (resolved cwd): the same tree reuses its commit. */
const lastSnapshotByCwd = new Map<string, { treeSha: string; snapshotRef: string; timestamp: number }>();

/** Per folder (resolved cwd): the kept shadow index and the stamp it was made under. */
const keptIndexByCwd = new Map<string, { cachePath: string; stamp: string }>();

/** Forget the snapshot memos of one folder, or of all (tests; a restore does it for its folder). */
export function clearWorkspaceSnapshotCaches(cwd?: string): void {
	if (cwd) {
		lastSnapshotByCwd.delete(resolve(cwd));
		keptIndexByCwd.delete(resolve(cwd));
	} else {
		lastSnapshotByCwd.clear();
		keptIndexByCwd.clear();
	}
}

async function readGitPointer(path: string): Promise<string | null> {
	try {
		return (await readFile(path, "utf8")).trim() || null;
	} catch {
		return null;
	}
}

/** The files whose change makes a kept shadow index stale: the index, info/exclude (in the common git
 *  dir, for a linked worktree too), the top-level .gitignore and the cwd's. */
export async function snapshotStampPaths(gitDir: string, cwd: string): Promise<string[]> {
	const common = await readGitPointer(join(gitDir, "commondir")); // a linked worktree's: "../.."
	const commonDir = common ? resolve(gitDir, common) : gitDir;
	let topLevel: string | null = basename(gitDir) === ".git" ? dirname(gitDir) : null;
	if (!topLevel) {
		const dotGit = await readGitPointer(join(gitDir, "gitdir")); // a linked worktree's: "<top>/.git"
		if (dotGit) topLevel = dirname(resolve(gitDir, dotGit));
	}
	const paths = new Set([join(gitDir, "index"), join(commonDir, "info", "exclude"), join(resolve(cwd), ".gitignore")]);
	if (topLevel) paths.add(join(topLevel, ".gitignore"));
	return [...paths];
}

/** Inode, size and mtime of each stamp file ("-" for a missing one). */
export async function snapshotSeedStamp(gitDir: string, cwd: string): Promise<string> {
	const paths = await snapshotStampPaths(gitDir, cwd);
	const parts = await Promise.all(
		paths.map(async (p) => {
			try {
				const s = await stat(p);
				return `${s.ino}:${s.size}:${s.mtimeMs}`;
			} catch {
				return "-";
			}
		}),
	);
	return parts.join("|");
}

/** Copy an index file and give the copy the original's mtime. Git trusts an entry's stat data only when
 *  the entry's mtime is older than the index file's own (its racy-git check), so a copy with a newer
 *  mtime would let a same-size edit made in the second git hashed the file go unseen. The stat is read
 *  first: an index replaced meanwhile only gets an older mtime (more content checks, never fewer). */
export async function copyIndexFile(from: string, to: string): Promise<void> {
	const { atime, mtime } = await stat(from);
	await copyFile(from, to);
	await utimes(to, atime, mtime);
}

/** True when `git add -A` on this index might skip working-tree changes of some entry, so a snapshot
 *  seeded from it could hold an old version of a file (and a restore would then put that version back):
 *  an entry marked assume-unchanged or skip-worktree, or an index this reader can't fully see (a split
 *  index, whose other entries live in a shared file; a version other than 2-4; bytes that don't parse as
 *  SHA-1 entries, as a SHA-256 repo's). Layout: git's Documentation/gitformat-index.txt. */
export function indexSkipsWorktree(buf: Buffer): boolean {
	const HASH = 20; // SHA-1 object names and trailing checksum
	if (buf.length < 12 + HASH || buf.toString("latin1", 0, 4) !== "DIRC") return true;
	const version = buf.readUInt32BE(4);
	if (version < 2 || version > 4) return true;
	const count = buf.readUInt32BE(8);
	const end = buf.length - HASH;
	const fixed = 40 + HASH + 2; // stat data, object name, flags
	let off = 12;
	for (let i = 0; i < count; i++) {
		const start = off;
		if (off + fixed > end) return true;
		const flags = buf.readUInt16BE(off + 40 + HASH);
		off += fixed;
		if (flags & 0x8000) return true; // assume-unchanged ("assume valid")
		if (flags & 0x4000) {
			// extended flags (version 3 and up)
			if (version < 3 || off + 2 > end) return true;
			if (buf.readUInt16BE(off) & 0x4000) return true; // skip-worktree
			off += 2;
		}
		if (version === 4) {
			while (off < end && (buf[off] as number) & 0x80) off++; // the prefix-compression varint
			off++;
		}
		const nul = buf.indexOf(0, off);
		if (nul < 0 || nul >= end) return true;
		if (version === 4) {
			off = nul + 1;
			continue;
		}
		// Versions 2 and 3: the name (its length in the flags, unless 0xfff or more), then 1-8 NULs that
		// pad the entry to a multiple of 8 bytes.
		const nameLen = nul - off;
		if ((flags & 0xfff) !== Math.min(nameLen, 0xfff)) return true;
		const next = start + ((off - start + nameLen + 8) & ~7);
		if (next > end) return true;
		for (let p = nul; p < next; p++) if (buf[p] !== 0) return true;
		off = next;
	}
	while (off < end) {
		// extensions: a 4-byte signature and a 32-bit size each
		if (off + 8 > end) return true;
		if (buf.toString("latin1", off, off + 4) === "link") return true; // split index
		off += 8 + buf.readUInt32BE(off + 4);
	}
	return off !== end;
}

/** Seed the temp index: the kept shadow index (when still good), else the real index (unless git add
 *  would skip some of its entries' working-tree changes), else nothing (git starts empty, the old way). */
async function seedSnapshotIndex(
	gitDir: string,
	keptPath: string | null,
	tempIndex: string,
): Promise<"cache" | "index" | "empty"> {
	if (keptPath) {
		try {
			await copyIndexFile(keptPath, tempIndex);
			return "cache";
		} catch {
			// gone or unreadable: the real one
		}
	}
	try {
		await copyIndexFile(join(gitDir, "index"), tempIndex);
		if (!indexSkipsWorktree(await readFile(tempIndex))) return "index";
	} catch {
		// no real index yet (a fresh repo), or unreadable
	}
	await rm(tempIndex, { force: true }).catch(() => {}); // no half copy, nor one with a new mtime
	return "empty";
}

/** Keep the temp index for the next snapshot: renamed into place (atomic, so a snapshot starting at the
 *  same time in the same folder never copies half a file, and it keeps the mtime git gave it). The
 *  commit step after it doesn't read the index. Best-effort; false when it couldn't. */
async function keepSnapshotIndex(tempIndex: string, cachePath: string): Promise<boolean> {
	try {
		await rename(tempIndex, cachePath);
		return true;
	} catch {
		return false;
	}
}

async function hasCommit(cwd: string, sha: string): Promise<boolean> {
	try {
		await runGit(cwd, ["cat-file", "-e", `${sha}^{commit}`]);
		return true;
	} catch {
		return false;
	}
}

/** A cached untracked file looks tracked to `git add`, which then ignores new exclusion rules. Ask Git
 *  to evaluate its current standard exclusions, and remove only ignored paths absent from the real
 *  index. Both ls-files and update-index use cwd-relative, NUL-delimited names; :/ covers the whole
 *  repo even when cwd is a subfolder, just like add -A. All writes stay in the temporary index. */
async function removeIgnoredCacheOnlyPaths(cwd: string, gitDir: string, env: NodeJS.ProcessEnv): Promise<void> {
	const args = ["ls-files", "--cached", "--ignored", "--exclude-standard", "-z", "--", ":/"];
	const ignored = (await runGitRaw(cwd, args, env)).split("\0").filter(Boolean);
	if (!ignored.length) return;
	const tracked = new Set(
		(await runGitRaw(cwd, args, { GIT_INDEX_FILE: join(gitDir, "index") })).split("\0").filter(Boolean),
	);
	const cacheOnly = ignored.filter((path) => !tracked.has(path));
	if (cacheOnly.length) {
		await runGitRaw(cwd, ["update-index", "--force-remove", "-z", "--stdin"], env, `${cacheOnly.join("\0")}\0`);
	}
}

/** Stage the whole working tree into the temp index and write its tree. */
async function stageTree(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
	await runGit(cwd, ["add", "-A"], env);
	return runGit(cwd, ["write-tree"], env);
}

/**
 * 为当前工作区创建轻量版本快照。
 * 若当前目录不在 Git 仓库内，返回 null。
 *
 * 该操作纯粹在临时 index 文件中完成，绝不影响用户的实际 index 或 HEAD。
 */
export async function createWorkspaceSnapshot(cwd: string): Promise<string | null> {
	const gitDir = await gitDirOf(cwd);
	if (!gitDir) return null;

	const tempIndex = join(gitDir, `temp-index-snapshot-${randomUUID()}`);
	const env = { GIT_INDEX_FILE: tempIndex };
	const cachePath = snapshotCachePath(gitDir, cwd);
	const normCwd = resolve(cwd);

	try {
		// 1. 将当前工作区所有改动（含未跟踪与新增）记录到临时 index（先用上次留下的影子 index 或真实 index 打底）
		// 2. 写入 tree 对象
		// The stamp is read before staging, so a change made while this snapshot runs reseeds the next one.
		const stamp = await snapshotSeedStamp(gitDir, cwd);
		const kept = keptIndexByCwd.get(normCwd);
		const seed = await seedSnapshotIndex(gitDir, kept?.stamp === stamp ? kept.cachePath : null, tempIndex);
		let tree: string;
		let keep = true;
		try {
			if (seed === "cache") await removeIgnoredCacheOnlyPaths(cwd, gitDir, env);
			tree = await stageTree(cwd, env);
		} catch (stageErr) {
			if (seed === "empty") throw stageErr;
			// A broken seed (corrupt cache, an index git can't take): drop it and start empty, as before.
			keptIndexByCwd.delete(normCwd);
			await rm(tempIndex, { force: true }).catch(() => {});
			await rm(cachePath, { force: true }).catch(() => {});
			keep = false; // an empty-seeded index lacks tracked-but-ignored files: don't seed from it
			try {
				tree = await stageTree(cwd, env);
			} catch {
				throw stageErr;
			}
		}
		if (!tree) return null;
		if (keep && (await keepSnapshotIndex(tempIndex, cachePath))) keptIndexByCwd.set(normCwd, { cachePath, stamp });
		else keptIndexByCwd.delete(normCwd);

		// Nothing changed since this folder's last snapshot: reuse its commit (if the repo still has it:
		// a folder re-cloned in place has the same tree but not the old commit).
		const last = lastSnapshotByCwd.get(normCwd);
		if (last && last.treeSha === tree && (await hasCommit(cwd, last.snapshotRef))) return last.snapshotRef;

		// 3. 检查是否有 HEAD commit 作为 parent
		let hasHead = false;
		try {
			await runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
			hasHead = true;
		} catch {
			hasHead = false;
		}

		// 4. 创建轻量 commit 对象，不关联任何分支引用
		const commitArgs = ["commit-tree", tree];
		if (hasHead) {
			commitArgs.push("-p", "HEAD");
		}
		commitArgs.push("-m", `pi-web-ui: workspace shadow snapshot ${new Date().toISOString()}`);

		const commitHash = await runGit(cwd, commitArgs, env);
		if (!commitHash) return null;
		lastSnapshotByCwd.set(normCwd, { treeSha: tree, snapshotRef: commitHash, timestamp: Date.now() });
		return commitHash;
	} catch (err) {
		console.warn(`[workspace-snapshot] failed to create snapshot (${cwd}):`, (err as Error).message);
		return null;
	} finally {
		// 务必清理临时 index 文件
		try {
			await rm(tempIndex, { force: true });
		} catch {
			// ignore cleanup error
		}
	}
}

/**
 * 将工作区物理文件还原到指定的快照状态。
 *
 * 执行步骤：
 * 1. `git read-tree -u --reset <snapshotRef>` 将 index 与工作区重置为快照树，并删除快照之后新增的文件；
 * 2. `git clean -fd` 清理快照之后新增的未跟踪文件与空目录。
 */
export async function restoreWorkspaceSnapshot(
	cwd: string,
	snapshotRef: string,
): Promise<{ success: boolean; error?: string }> {
	const gitDir = await gitDirOf(cwd);
	if (!gitDir) {
		return { success: false, error: "Workspace is not a Git repository" };
	}

	try {
		// 验证 snapshotRef 合法性
		await runGit(cwd, ["rev-parse", "--verify", snapshotRef]);

		// 1. 将 index 和工作区彻底重置到快照树状态（自动清除快照中不存在的文件）
		await runGit(cwd, ["read-tree", "-u", "--reset", snapshotRef]);

		// 2. 清理新产生的未跟踪文件与目录
		await runGit(cwd, ["clean", "-fd"]);

		// The folder's files were just rewritten: the next snapshot starts from fresh caches.
		clearWorkspaceSnapshotCaches(cwd);
		await rm(snapshotCachePath(gitDir, cwd), { force: true }).catch(() => {});

		return { success: true };
	} catch (err) {
		const msg = (err as Error).message;
		console.error(`[workspace-snapshot] failed to restore snapshot (${cwd}, ${snapshotRef}):`, msg);
		return { success: false, error: msg };
	}
}
