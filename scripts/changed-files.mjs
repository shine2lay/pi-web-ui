/**
 * changed-files.mjs: the paths that changed between a base commit and a head, in a git checkout (Ops #693).
 * Shared by the land check's two "only what changed" steps: scripts/prettier-scope.mjs (docs/gate-prettier-changed.md)
 * and scripts/select-tests.mjs (docs/gate-selected-tests.md).
 *
 * One job: list the paths. Each changed path appears once, as { path, status, deleted }, with `status` git's letter
 * (A added, M modified, D deleted, T type changed, ...). A rename is its old path (deleted) and its new path (added):
 * git runs with --no-renames, so a reader never has to know about renames to see that a path went away.
 *
 * Every function returns its result or { error } with git's own message (maybe empty), never throws for git's sake.
 */
import { spawnSync } from "node:child_process";

function git(cwd, ...args) {
	const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	return { code: r.status ?? 1, out: r.stdout ?? "", err: (r.stderr ?? "").trim() };
}

/** The top folder of the git checkout around `cwd`: { root } or { error }. */
export function gitTop(cwd = process.cwd()) {
	const top = git(cwd, "rev-parse", "--show-toplevel");
	if (top.code !== 0) return { error: top.err };
	return { root: top.out.trim() };
}

/** The full commit id `rev` names in the checkout at `root`: { sha } or { error }. */
export function commitOf(root, rev) {
	const r = git(root, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`);
	if (r.code !== 0) return { error: r.err || `${rev} is not a commit here` };
	return { sha: r.out.trim() };
}

/** The merge-base of `a` and `b`: { base } or { error } (none in common, or a name git doesn't know). */
export function mergeBase(root, a, b) {
	const r = git(root, "merge-base", a, b);
	if (r.code !== 0) return { error: r.err };
	return { base: r.out.trim() };
}

/** The paths commit `rev` holds, from the top of the checkout: { files } or { error }. */
export function filesAt(root, rev) {
	const r = git(root, "ls-tree", "-r", "--name-only", "-z", rev);
	if (r.code !== 0) return { error: r.err };
	return { files: r.out.split("\0").filter(Boolean) };
}

/** Whether commit `ancestor` is `descendant` or one of its ancestors. */
export function isAncestor(root, ancestor, descendant) {
	return git(root, "merge-base", "--is-ancestor", ancestor, descendant).code === 0;
}

/**
 * What changed from `base` to `head` in the checkout at `root`: { files: [{ path, status, deleted }] } or { error }.
 * `head` a commit: the commits between them. `head` left out: the working tree as it is, so the commits since `base`
 * plus edits and new files not committed yet (untracked ones that .gitignore doesn't name); a path deleted from
 * git's index but still in the folder counts as there.
 */
export function changedFiles(root, base, head) {
	const range = head === undefined ? [base] : [base, head];
	const diff = git(root, "diff", "--name-status", "--no-renames", "--no-color", "-z", ...range, "--");
	if (diff.code !== 0) return { error: diff.err };
	const changed = new Map(); // path -> git's status letter
	const words = diff.out.split("\0");
	for (let i = 0; i + 1 < words.length; i += 2) changed.set(words[i + 1], words[i].charAt(0));
	if (head === undefined) {
		const untracked = git(root, "ls-files", "--others", "--exclude-standard", "-z");
		if (untracked.code !== 0) return { error: untracked.err };
		for (const path of untracked.out.split("\0").filter(Boolean)) changed.set(path, "A");
	}
	return { files: [...changed].map(([path, status]) => ({ path, status, deleted: status === "D" })) };
}
