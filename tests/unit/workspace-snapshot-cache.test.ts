// snapshot-index-cache (Ops #565, W1-B): the workspace snapshot seeds its temp index from the kept
// shadow index or the real index instead of an empty one. These tests hold it to the snapshot a fresh,
// empty index gives for cache-only files (git hashes every file then), including nested/global
// exclusions (Ops #572), while preserving genuinely tracked-but-ignored files, git's racy-git rule
// (index copies keep their mtime), and the old way when a seed breaks.
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearWorkspaceSnapshotCaches,
	copyIndexFile,
	createWorkspaceSnapshot,
	indexSkipsWorktree,
	restoreWorkspaceSnapshot,
	snapshotCachePath,
	snapshotSeedStamp,
	snapshotStampPaths,
} from "../../server/workspace-snapshot.js";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initRepo(dir: string): void {
	git(dir, "init", "-q");
	git(dir, "config", "user.name", "test");
	git(dir, "config", "user.email", "test@test.com");
	git(dir, "config", "commit.gpgsign", "false");
}

let truthN = 0;
/** The ground truth: `git add -A` on an empty index hashes every file that isn't ignored. (It leaves out
 *  tracked files that .gitignore matches; the tests comparing with it have none.) */
function groundTruthTree(dir: string): string {
	const gitDir = git(dir, "rev-parse", "--absolute-git-dir");
	const tmp = join(gitDir, `test-truth-index-${truthN++}`);
	const env = { ...process.env, GIT_INDEX_FILE: tmp };
	try {
		execFileSync("git", ["add", "-A"], { cwd: dir, env, stdio: "ignore" });
		return execFileSync("git", ["write-tree"], { cwd: dir, env, encoding: "utf8" }).trim();
	} finally {
		rmSync(tmp, { force: true });
	}
}

function treeOf(dir: string, ref: string): string {
	return git(dir, "rev-parse", `${ref}^{tree}`);
}

function filesIn(dir: string, ref: string): string[] {
	return execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", ref], { cwd: dir, encoding: "utf8" })
		.split("\0")
		.filter(Boolean)
		.sort();
}

/** The paths an index file holds. */
function indexPaths(dir: string, indexFile: string): string[] {
	const env = { ...process.env, GIT_INDEX_FILE: indexFile };
	return execFileSync("git", ["ls-files", "-z"], { cwd: dir, env, encoding: "utf8" })
		.split("\0")
		.filter(Boolean)
		.sort();
}

function indexIdentity(path: string): unknown[] {
	const s = statSync(path);
	return [readFileSync(path), s.ino, s.size, s.mtimeMs];
}

/** Rewrite a file in place (same inode) and pin its mtime. */
function writePinned(path: string, content: string, mtimeSec: number): void {
	writeFileSync(path, content);
	utimesSync(path, mtimeSec, mtimeSec);
}

describe("workspace snapshot: kept shadow index (snapshot-index-cache)", () => {
	let dir: string;
	let gitDir: string;

	beforeEach(() => {
		clearWorkspaceSnapshotCaches();
		dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-test-snapcache-")));
		initRepo(dir);
		writeFileSync(join(dir, "a.txt"), "a v1\n");
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "b.ts"), "export const b = 1;\n");
		writeFileSync(join(dir, ".gitignore"), "*.log\n");
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", "initial");
		gitDir = git(dir, "rev-parse", "--absolute-git-dir");
	});

	afterEach(() => {
		clearWorkspaceSnapshotCaches();
		rmSync(dir, { recursive: true, force: true });
	});

	it("keeps the shadow index in the git dir, leaves the real index alone and snapshots the working tree", async () => {
		writeFileSync(join(dir, "a.txt"), "a v2\n");
		const realIndexBefore = readFileSync(join(gitDir, "index"));
		const snap = await createWorkspaceSnapshot(dir);
		expect(snap).toBeTruthy();
		expect(existsSync(snapshotCachePath(gitDir, dir))).toBe(true);
		expect(treeOf(dir, snap!)).toBe(groundTruthTree(dir));
		expect(git(dir, "show", `${snap}:a.txt`)).toBe("a v2");
		expect(readFileSync(join(gitDir, "index")).equals(realIndexBefore)).toBe(true);
		// No temp index is left behind.
		expect(readdirSync(gitDir).filter((n) => n.startsWith("temp-index-snapshot-"))).toEqual([]);
	}, 30_000);

	it("reuses the last commit while nothing changed, and makes a new one after a change", async () => {
		const first = await createWorkspaceSnapshot(dir);
		const again = await createWorkspaceSnapshot(dir);
		expect(again).toBe(first);

		writeFileSync(join(dir, "a.txt"), "a v2\n");
		const changed = await createWorkspaceSnapshot(dir);
		expect(changed).not.toBe(first);
		expect(git(dir, "show", `${changed}:a.txt`)).toBe("a v2");
		expect(git(dir, "rev-parse", `${changed}^`)).toBe(git(dir, "rev-parse", "HEAD"));

		// Back to the first content: a tree seen before, but not the last one -> a new commit of that tree.
		writeFileSync(join(dir, "a.txt"), "a v1\n");
		const back = await createWorkspaceSnapshot(dir);
		expect(back).not.toBe(changed);
		expect(treeOf(dir, back!)).toBe(treeOf(dir, first!));
	}, 30_000);

	it("makes a new commit when the reused one is gone (pruned)", async () => {
		const first = await createWorkspaceSnapshot(dir);
		git(dir, "reflog", "expire", "--expire=now", "--all");
		git(dir, "gc", "-q", "--prune=now");
		expect(() => git(dir, "cat-file", "-e", `${first}^{commit}`)).toThrow();

		const next = await createWorkspaceSnapshot(dir);
		expect(next).toBeTruthy();
		expect(next).not.toBe(first);
		expect(() => git(dir, "cat-file", "-e", `${next}^{commit}`)).not.toThrow();
		expect(treeOf(dir, next!)).toBe(git(dir, "rev-parse", "HEAD^{tree}"));
	}, 30_000);

	it("gives the ground-truth tree through edits, new files, deletes, commits, untracking and ignoring", async () => {
		const cache = snapshotCachePath(gitDir, dir);
		const steps: Array<[string, () => void, (() => void)?]> = [
			["edit a tracked file", () => writeFileSync(join(dir, "a.txt"), "a v2\n")],
			[
				"add untracked files",
				() => {
					writeFileSync(join(dir, "new.txt"), "new\n");
					mkdirSync(join(dir, "fresh"));
					writeFileSync(join(dir, "fresh", "c.md"), "# c\n");
				},
			],
			["delete a tracked file", () => rmSync(join(dir, "src", "b.ts"))],
			["write an ignored file", () => writeFileSync(join(dir, "debug.log"), "noise\n")],
			[
				"commit everything",
				() => {
					git(dir, "add", "-A");
					git(dir, "commit", "-q", "-m", "step");
				},
			],
			["edit right after the commit", () => writeFileSync(join(dir, "new.txt"), "new v2\n")],
			[
				"untrack a file and ignore it (git rm --cached + .gitignore)",
				() => {
					git(dir, "rm", "-q", "--cached", "new.txt");
					writeFileSync(join(dir, ".gitignore"), "*.log\nnew.txt\n");
				},
			],
			[
				"add an untracked file",
				() => writeFileSync(join(dir, "scratch.txt"), "scratch\n"),
				() => expect(indexPaths(dir, cache)).toContain("scratch.txt"), // the kept index holds it now
			],
			[
				"ignore that untracked file by editing .gitignore only (the real index stays the same)",
				() => writeFileSync(join(dir, ".gitignore"), "*.log\nnew.txt\nscratch.txt\n"),
				() => expect(indexPaths(dir, cache)).not.toContain("scratch.txt"), // reseeded from the real index
			],
			[
				"stage an edit (git add) and edit again",
				() => {
					writeFileSync(join(dir, "a.txt"), "a v3\n");
					git(dir, "add", "a.txt");
					writeFileSync(join(dir, "a.txt"), "a v4\n");
				},
			],
			["refresh the index (git status)", () => void git(dir, "status", "--porcelain")],
		];
		await createWorkspaceSnapshot(dir); // warm the kept index
		for (const [what, step, check] of steps) {
			step();
			const snap = await createWorkspaceSnapshot(dir);
			expect(snap, what).toBeTruthy();
			expect(treeOf(dir, snap!), what).toBe(groundTruthTree(dir));
			check?.();
		}
		const last = await createWorkspaceSnapshot(dir);
		expect(filesIn(dir, last!)).toEqual([".gitignore", "a.txt", "fresh/c.md"]);
		expect(git(dir, "show", `${last}:a.txt`)).toBe("a v4");
	}, 60_000);

	it.each(["new", "edited"])(
		"rechecks a %s nested ignore for cache-only paths, never genuine tracked paths",
		async (mode) => {
			mkdirSync(join(dir, "sub"));
			const ignore = join(dir, "sub", ".gitignore");
			if (mode === "edited") writeFileSync(ignore, "# no exclusions yet\n");
			writeFileSync(join(dir, "sub", "tracked.txt"), "tracked before\n");
			git(dir, "add", "sub/tracked.txt");
			git(dir, "commit", "-q", "-m", "tracked control");
			writeFileSync(join(dir, "sub", "scratch.txt"), "scratch before\n");
			writeFileSync(join(dir, "sub", "visible.txt"), "visible\n");
			const basePaths = [".gitignore", "a.txt", "src/b.ts", "sub/tracked.txt", "sub/visible.txt"];
			const first = await createWorkspaceSnapshot(dir);
			expect(filesIn(dir, first!)).toEqual(
				[...basePaths, "sub/scratch.txt", ...(mode === "edited" ? ["sub/.gitignore"] : [])].sort(),
			);
			const indexBefore = indexIdentity(join(gitDir, "index"));
			const headBefore = git(dir, "rev-parse", "HEAD");
			const stamp = await snapshotSeedStamp(gitDir, dir);

			writeFileSync(ignore, "*.txt\n!visible.txt\n");
			writeFileSync(join(dir, "sub", "scratch.txt"), "scratch after ignore\n");
			writeFileSync(join(dir, "sub", "tracked.txt"), "tracked after ignore\n");
			expect(await snapshotSeedStamp(gitDir, dir)).toBe(stamp); // the old stamp cannot see this change
			const snap = await createWorkspaceSnapshot(dir);
			expect(filesIn(dir, snap!)).toEqual([...basePaths, "sub/.gitignore"].sort());
			expect(indexPaths(dir, snapshotCachePath(gitDir, dir))).not.toContain("sub/scratch.txt");
			expect(git(dir, "show", `${snap}:sub/tracked.txt`)).toBe("tracked after ignore");
			expect(filesIn(dir, groundTruthTree(dir))).toEqual(
				[".gitignore", "a.txt", "src/b.ts", "sub/.gitignore", "sub/visible.txt"].sort(),
			);

			writeFileSync(join(dir, "sub", "scratch.txt"), "ignored edit must not create a new tree\n");
			expect(await createWorkspaceSnapshot(dir)).toBe(snap);
			rmSync(ignore);
			const unignored = await createWorkspaceSnapshot(dir);
			expect(filesIn(dir, unignored!)).toEqual([...basePaths, "sub/scratch.txt"].sort());
			expect(git(dir, "show", `${unignored}:sub/scratch.txt`)).toBe("ignored edit must not create a new tree");
			expect(indexIdentity(join(gitDir, "index"))).toEqual(indexBefore);
			expect(git(dir, "rev-parse", "HEAD")).toBe(headBefore);
		},
		30_000,
	);

	it.each(["new", "edited", "reselected"])(
		"rechecks a %s global exclude source without losing tracked controls",
		async (mode) => {
			mkdirSync(join(dir, "sub"));
			writeFileSync(join(dir, "sub", "tracked.txt"), "tracked before\n");
			git(dir, "add", "sub/tracked.txt");
			git(dir, "commit", "-q", "-m", "tracked control");
			const excludes = join(gitDir, "test-global-excludes");
			if (mode === "edited") writeFileSync(excludes, "# no exclusions yet\n");
			git(dir, "config", "core.excludesFile", mode === "reselected" ? `${excludes}-old` : excludes);
			writeFileSync(join(dir, "sub", "scratch.txt"), "scratch before\n");
			writeFileSync(join(dir, "sub", "visible.txt"), "visible\n");
			const basePaths = [".gitignore", "a.txt", "src/b.ts", "sub/tracked.txt", "sub/visible.txt"];
			const first = await createWorkspaceSnapshot(dir);
			expect(filesIn(dir, first!)).toEqual([...basePaths, "sub/scratch.txt"].sort());
			const indexBefore = indexIdentity(join(gitDir, "index"));
			const headBefore = git(dir, "rev-parse", "HEAD");
			const stamp = await snapshotSeedStamp(gitDir, dir);

			writeFileSync(excludes, "sub/*.txt\n!sub/visible.txt\n");
			if (mode === "reselected") git(dir, "config", "core.excludesFile", excludes);
			writeFileSync(join(dir, "sub", "scratch.txt"), "scratch after exclude\n");
			writeFileSync(join(dir, "sub", "tracked.txt"), "tracked after exclude\n");
			expect(await snapshotSeedStamp(gitDir, dir)).toBe(stamp);
			const snap = await createWorkspaceSnapshot(dir);
			expect(filesIn(dir, snap!)).toEqual(basePaths);
			expect(indexPaths(dir, snapshotCachePath(gitDir, dir))).not.toContain("sub/scratch.txt");
			expect(git(dir, "show", `${snap}:sub/tracked.txt`)).toBe("tracked after exclude");
			expect(filesIn(dir, groundTruthTree(dir))).toEqual([".gitignore", "a.txt", "src/b.ts", "sub/visible.txt"]);

			writeFileSync(join(dir, "sub", "scratch.txt"), "ignored edit must not create a new tree\n");
			expect(await createWorkspaceSnapshot(dir)).toBe(snap);
			rmSync(excludes);
			const unignored = await createWorkspaceSnapshot(dir);
			expect(filesIn(dir, unignored!)).toEqual([...basePaths, "sub/scratch.txt"].sort());
			expect(git(dir, "show", `${unignored}:sub/scratch.txt`)).toBe("ignored edit must not create a new tree");
			expect(indexIdentity(join(gitDir, "index"))).toEqual(indexBefore);
			expect(git(dir, "rev-parse", "HEAD")).toBe(headBefore);
		},
		30_000,
	);

	it("rechecks exclusions across the whole repo from a nested cwd, with literal NUL-delimited names", async () => {
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "sub", "tracked.txt"), "tracked before\n");
		git(dir, "add", "sub/tracked.txt");
		git(dir, "commit", "-q", "-m", "tracked control");
		writeFileSync(join(dir, "sub", "scratch.txt"), "scratch\n");
		writeFileSync(join(dir, "sub", "visible.txt"), "visible\n");
		const names = [" leading name.cache", "literal[1]*.cache", "line\nbreak.cache"];
		for (const name of names) writeFileSync(join(dir, name), "cache only\n");
		const excludes = join(gitDir, "test-global-excludes");
		git(dir, "config", "core.excludesFile", excludes);
		const cwd = join(dir, "src");
		const first = await createWorkspaceSnapshot(cwd);
		expect(filesIn(dir, first!)).toEqual(
			[".gitignore", "a.txt", "src/b.ts", "sub/scratch.txt", "sub/tracked.txt", "sub/visible.txt", ...names].sort(),
		);
		const indexBefore = indexIdentity(join(gitDir, "index"));
		const stamp = await snapshotSeedStamp(gitDir, cwd);

		writeFileSync(join(dir, "sub", ".gitignore"), "*.txt\n!visible.txt\n");
		writeFileSync(excludes, "*.cache\n");
		for (const name of names) writeFileSync(join(dir, name), "now ignored\n");
		writeFileSync(join(dir, "sub", "scratch.txt"), "now ignored\n");
		writeFileSync(join(dir, "sub", "tracked.txt"), "tracked after ignore\n");
		expect(await snapshotSeedStamp(gitDir, cwd)).toBe(stamp);
		const snap = await createWorkspaceSnapshot(cwd);
		expect(filesIn(dir, snap!)).toEqual([
			".gitignore",
			"a.txt",
			"src/b.ts",
			"sub/.gitignore",
			"sub/tracked.txt",
			"sub/visible.txt",
		]);
		expect(indexPaths(dir, snapshotCachePath(gitDir, cwd))).toEqual(filesIn(dir, snap!));
		expect(git(dir, "show", `${snap}:sub/tracked.txt`)).toBe("tracked after ignore");
		expect(indexIdentity(join(gitDir, "index"))).toEqual(indexBefore);
	}, 30_000);

	it("sees a same-size edit made in the second git last hashed the file (seed from the real index)", async () => {
		// The real index holds a.txt hashed with mtime M, and the index file itself has mtime M: git must
		// compare that entry's content (racy git). A copy with a fresh mtime would make git trust the stat.
		git(dir, "config", "core.trustctime", "false"); // so the test can pin all the stat data git compares
		const m = Math.floor(Date.now() / 1000) - 3600;
		writePinned(join(dir, "a.txt"), "racy X\n", m);
		git(dir, "add", "a.txt");
		utimesSync(join(gitDir, "index"), m, m);
		writePinned(join(dir, "a.txt"), "racy Y\n", m); // same size, same inode, same mtime

		const snap = await createWorkspaceSnapshot(dir);
		expect(git(dir, "show", `${snap}:a.txt`)).toBe("racy Y");
		expect(treeOf(dir, snap!)).toBe(groundTruthTree(dir));
	}, 30_000);

	it("sees a same-size edit made in the second git last hashed the file (seed from the kept index)", async () => {
		git(dir, "config", "core.trustctime", "false");
		const m = Math.floor(Date.now() / 1000) - 3600;
		writePinned(join(dir, "a.txt"), "kept X\n", m);
		await createWorkspaceSnapshot(dir); // the kept index now holds a.txt hashed with mtime M
		const cache = snapshotCachePath(gitDir, dir);
		utimesSync(cache, m, m); // as if git had written it in that same second
		writePinned(join(dir, "a.txt"), "kept Y\n", m);

		const snap = await createWorkspaceSnapshot(dir);
		expect(git(dir, "show", `${snap}:a.txt`)).toBe("kept Y");
		expect(treeOf(dir, snap!)).toBe(groundTruthTree(dir));
	}, 30_000);

	it("copies an index file with its mtime, never a newer one", async () => {
		const m = Math.floor(Date.now() / 1000) - 7200;
		utimesSync(join(gitDir, "index"), m, m);
		const to = join(gitDir, "test-copy-index");
		await copyIndexFile(join(gitDir, "index"), to);
		expect(statSync(to).mtimeMs).toBe(m * 1000);
		expect(readFileSync(to).equals(readFileSync(join(gitDir, "index")))).toBe(true);
	}, 30_000);

	it("keeps a tracked file that .gitignore matches, so a restore no longer deletes it", async () => {
		writeFileSync(join(dir, "kept.log"), "tracked on purpose\n");
		git(dir, "add", "-f", "kept.log");
		git(dir, "commit", "-q", "-m", "track a log");

		const snap = await createWorkspaceSnapshot(dir);
		expect(filesIn(dir, snap!)).toContain("kept.log");
		// The old empty seed left it out of the snapshot ...
		expect(git(dir, "ls-tree", "-r", "--name-only", groundTruthTree(dir))).not.toContain("kept.log");

		writeFileSync(join(dir, "a.txt"), "a changed after the snapshot\n");
		const res = await restoreWorkspaceSnapshot(dir, snap!);
		expect(res.success).toBe(true);
		// ... and the restore's read-tree --reset then deleted it from the working tree.
		expect(readFileSync(join(dir, "kept.log"), "utf8")).toBe("tracked on purpose\n");
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("a v1\n");
	}, 30_000);

	it("falls back to an empty index, the old way, when the kept index is broken, and doesn't keep that one", async () => {
		await createWorkspaceSnapshot(dir);
		const cache = snapshotCachePath(gitDir, dir);
		writeFileSync(cache, "not an index\n");
		writeFileSync(join(dir, "a.txt"), "a v2\n");

		const snap = await createWorkspaceSnapshot(dir);
		expect(snap).toBeTruthy();
		expect(treeOf(dir, snap!)).toBe(groundTruthTree(dir));
		expect(existsSync(cache)).toBe(false);

		// The next one seeds from the real index again and keeps its index.
		writeFileSync(join(dir, "a.txt"), "a v3\n");
		const next = await createWorkspaceSnapshot(dir);
		expect(treeOf(dir, next!)).toBe(groundTruthTree(dir));
		expect(existsSync(cache)).toBe(true);
	}, 30_000);

	it("doesn't use a kept index from before a restart (the stamp lives in memory)", async () => {
		await createWorkspaceSnapshot(dir);
		const cache = snapshotCachePath(gitDir, dir);
		writeFileSync(cache, "left by an earlier server\n");
		clearWorkspaceSnapshotCaches(); // what a restart leaves

		writeFileSync(join(dir, "a.txt"), "a v2\n");
		const snap = await createWorkspaceSnapshot(dir);
		expect(treeOf(dir, snap!)).toBe(groundTruthTree(dir));
		expect(readFileSync(cache).subarray(0, 4).toString()).toBe("DIRC"); // replaced by a real index
	}, 30_000);

	it("takes two snapshots of one folder at once", async () => {
		await createWorkspaceSnapshot(dir);
		writeFileSync(join(dir, "a.txt"), "a v2\n");
		writeFileSync(join(dir, "both.txt"), "both\n");
		const [one, two] = await Promise.all([createWorkspaceSnapshot(dir), createWorkspaceSnapshot(dir)]);
		const want = groundTruthTree(dir);
		expect(treeOf(dir, one!)).toBe(want);
		expect(treeOf(dir, two!)).toBe(want);
		const third = await createWorkspaceSnapshot(dir);
		expect(treeOf(dir, third!)).toBe(want);
		expect(readFileSync(snapshotCachePath(gitDir, dir)).subarray(0, 4).toString()).toBe("DIRC");
	}, 30_000);

	it("forgets the kept index after a restore", async () => {
		const snap = await createWorkspaceSnapshot(dir);
		writeFileSync(join(dir, "a.txt"), "a v2\n");
		await createWorkspaceSnapshot(dir);
		expect(existsSync(snapshotCachePath(gitDir, dir))).toBe(true);

		expect((await restoreWorkspaceSnapshot(dir, snap!)).success).toBe(true);
		expect(existsSync(snapshotCachePath(gitDir, dir))).toBe(false);
		const after = await createWorkspaceSnapshot(dir);
		expect(treeOf(dir, after!)).toBe(treeOf(dir, snap!));
	}, 30_000);

	it("stamps the index, the common info/exclude and both .gitignore files, in a subfolder and a linked worktree", async () => {
		const sub = join(dir, "src");
		expect(await snapshotStampPaths(gitDir, sub)).toEqual(
			expect.arrayContaining([
				join(gitDir, "index"),
				join(gitDir, "info", "exclude"),
				join(sub, ".gitignore"),
				join(dir, ".gitignore"),
			]),
		);

		const wt = `${dir}-wt`;
		try {
			git(dir, "worktree", "add", "-q", wt);
			const wtGitDir = git(wt, "rev-parse", "--absolute-git-dir");
			expect(wtGitDir).not.toBe(gitDir);
			const paths = await snapshotStampPaths(wtGitDir, join(wt, "src"));
			expect(paths).toEqual(
				expect.arrayContaining([
					join(wtGitDir, "index"),
					join(gitDir, "info", "exclude"),
					join(wt, "src", ".gitignore"),
					join(wt, ".gitignore"),
				]),
			);

			// And a snapshot there seeds from the worktree's own index.
			writeFileSync(join(wt, "a.txt"), "a in the worktree\n");
			const snap = await createWorkspaceSnapshot(wt);
			expect(treeOf(wt, snap!)).toBe(groundTruthTree(wt));
			expect(existsSync(snapshotCachePath(wtGitDir, wt))).toBe(true);
		} finally {
			clearWorkspaceSnapshotCaches(wt);
			rmSync(wt, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("workspace snapshot: no seed whose entries git add would skip", () => {
	let dir: string;
	let gitDir: string;

	beforeEach(() => {
		clearWorkspaceSnapshotCaches();
		dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-test-snapseed-")));
		initRepo(dir);
		writeFileSync(join(dir, "a.txt"), "a v1\n");
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "b.ts"), "export const b = 1;\n");
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", "initial");
		gitDir = git(dir, "rev-parse", "--absolute-git-dir");
	});

	afterEach(() => {
		clearWorkspaceSnapshotCaches();
		rmSync(dir, { recursive: true, force: true });
	});

	const realIndex = (): Buffer => readFileSync(join(gitDir, "index"));
	const indexVersion = (): number => realIndex().readUInt32BE(4);

	it("snapshots the edit of a file the real index marks assume-unchanged", async () => {
		git(dir, "update-index", "--assume-unchanged", "a.txt");
		writeFileSync(join(dir, "a.txt"), "a edited under assume-unchanged\n");
		expect(git(dir, "status", "--porcelain")).toBe(""); // git itself no longer looks at it

		const snap = await createWorkspaceSnapshot(dir);
		expect(git(dir, "show", `${snap}:a.txt`)).toBe("a edited under assume-unchanged");
		expect(treeOf(dir, snap!)).toBe(groundTruthTree(dir));
		// And again, from whatever index that snapshot kept.
		writeFileSync(join(dir, "a.txt"), "a edited again\n");
		const next = await createWorkspaceSnapshot(dir);
		expect(git(dir, "show", `${next}:a.txt`)).toBe("a edited again");
	}, 30_000);

	it("snapshots the edit of a file the real index marks skip-worktree", async () => {
		git(dir, "update-index", "--skip-worktree", "src/b.ts");
		writeFileSync(join(dir, "src", "b.ts"), "export const b = 2;\n");
		expect(git(dir, "status", "--porcelain")).toBe("");

		const snap = await createWorkspaceSnapshot(dir);
		expect(git(dir, "show", `${snap}:src/b.ts`)).toBe("export const b = 2;");
		expect(treeOf(dir, snap!)).toBe(groundTruthTree(dir));
	}, 30_000);

	it("still seeds from a real index with an intent-to-add entry (git add -N)", async () => {
		writeFileSync(join(dir, "kept.log"), "tracked though ignored\n");
		git(dir, "add", "-f", "kept.log");
		git(dir, "commit", "-q", "-m", "track a log");
		writeFileSync(join(dir, ".gitignore"), "*.log\n");
		writeFileSync(join(dir, "new.txt"), "new, intent to add\n");
		git(dir, "add", "-N", "new.txt");
		expect(indexVersion()).toBe(3); // the intent-to-add flag is an extended flag

		const snap = await createWorkspaceSnapshot(dir);
		expect(git(dir, "show", `${snap}:new.txt`)).toBe("new, intent to add");
		// kept.log is only there when the snapshot was seeded from the real index.
		expect(filesIn(dir, snap!)).toEqual([".gitignore", "a.txt", "kept.log", "new.txt", "src/b.ts"]);
	}, 30_000);

	it("reads index versions 2, 3 and 4 and finds assume-unchanged and skip-worktree entries in each", () => {
		const check = (version: number) => {
			git(dir, "update-index", "--index-version", String(version));
			expect(indexVersion()).toBe(version);
			expect(indexSkipsWorktree(realIndex()), `v${version} clean`).toBe(false);
			git(dir, "update-index", "--assume-unchanged", "a.txt");
			expect(indexSkipsWorktree(realIndex()), `v${version} assume-unchanged`).toBe(true);
			git(dir, "update-index", "--no-assume-unchanged", "a.txt");
			expect(indexSkipsWorktree(realIndex()), `v${version} cleared`).toBe(false);
		};
		check(2);
		check(4);

		git(dir, "update-index", "--index-version", "2");
		git(dir, "update-index", "--skip-worktree", "src/b.ts"); // extended flag: git writes version 3
		expect(indexVersion()).toBe(3);
		expect(indexSkipsWorktree(realIndex())).toBe(true);
		git(dir, "update-index", "--no-skip-worktree", "src/b.ts");
		expect(indexSkipsWorktree(realIndex())).toBe(false);
		git(dir, "update-index", "--index-version", "4");
		git(dir, "update-index", "--skip-worktree", "src/b.ts");
		expect(indexVersion()).toBe(4);
		expect(indexSkipsWorktree(realIndex())).toBe(true);
		git(dir, "update-index", "--no-skip-worktree", "src/b.ts");

		// Many entries, long and short names, a tree extension: still read to the end.
		for (let i = 0; i < 40; i++) writeFileSync(join(dir, "src", `file-${"x".repeat(i)}.txt`), `${i}\n`);
		git(dir, "add", "-A");
		git(dir, "write-tree");
		for (const version of [2, 3, 4]) {
			git(dir, "update-index", "--index-version", String(version));
			expect(indexSkipsWorktree(realIndex()), `v${version}, 43 entries`).toBe(false);
		}
		git(dir, "update-index", "--assume-unchanged", "src/file-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.txt");
		expect(indexSkipsWorktree(realIndex()), "the last entry marked").toBe(true);
	});

	it("counts an index it can't fully read as one to skip: split, SHA-256, cut short or not an index", async () => {
		git(dir, "update-index", "--split-index");
		expect(indexSkipsWorktree(realIndex())).toBe(true);
		git(dir, "update-index", "--no-split-index");
		expect(indexSkipsWorktree(realIndex())).toBe(false);

		const whole = realIndex();
		for (const cut of [0, 11, 12, 40, whole.length - 21, whole.length - 1]) {
			expect(indexSkipsWorktree(whole.subarray(0, cut)), `cut at ${cut}`).toBe(true);
		}
		const v5 = Buffer.from(whole);
		v5.writeUInt32BE(5, 4);
		expect(indexSkipsWorktree(v5)).toBe(true);
		expect(indexSkipsWorktree(Buffer.from("not an index at all, just some bytes here"))).toBe(true);

		const sha256 = `${dir}-sha256`;
		try {
			mkdirSync(sha256);
			git(sha256, "init", "-q", "--object-format=sha256");
			git(sha256, "config", "user.name", "test");
			git(sha256, "config", "user.email", "test@test.com");
			git(sha256, "config", "commit.gpgsign", "false");
			writeFileSync(join(sha256, "a.txt"), "a\n");
			git(sha256, "add", "-A");
			git(sha256, "commit", "-q", "-m", "initial");
			expect(indexSkipsWorktree(readFileSync(join(sha256, ".git", "index")))).toBe(true);
			writeFileSync(join(sha256, "a.txt"), "a v2\n");
			const snap = await createWorkspaceSnapshot(sha256);
			expect(git(sha256, "show", `${snap}:a.txt`)).toBe("a v2");
			expect(treeOf(sha256, snap!)).toBe(groundTruthTree(sha256));
		} finally {
			clearWorkspaceSnapshotCaches(sha256);
			rmSync(sha256, { recursive: true, force: true });
		}
	}, 30_000);
});
