#!/usr/bin/env node
/**
 * prettier-scope.mjs: the files the landing check's Prettier step has to look at (Ops #399, PATCHES.md
 * "gate-prettier-changed", docs/gate-prettier-changed.md).
 *
 * `npm run format:check` reads all of the ~1,260 files in its folders, one after another (about 3 minutes in a
 * land's check), while a land changes a handful. A file nothing changed is byte-identical to the base on mine,
 * where it passed the whole check when it landed. So `scripts/check.sh --fast` (what wt land runs) gives Prettier:
 *   - the files changed since the merge-base of HEAD and mine: the commits, plus edits and new files not committed
 *     yet (a land's worktree has none; a run by hand may), never a deleted one;
 *   - only those in format:check's own folders and globs (ROOTS), and only regular files (Prettier skips a
 *     symbolic link in a folder and refuses one named to it);
 * the same Prettier with the same settings, which still leaves out what .prettierignore and .gitignore name.
 * It checks every file, with `npm run format:check` itself, when there is no merge-base with mine, or when a
 * change may have changed Prettier's settings or version (SETTINGS_ANYWHERE, SETTINGS_AT_TOP).
 * The changed paths come from scripts/changed-files.mjs, which the unit-test selection shares (Ops #693).
 *
 * Usage:
 *   node scripts/prettier-scope.mjs           what --check would check: "ALL: <why>", or the files, one per line
 *   node scripts/prettier-scope.mjs --check   check them with this repo's own Prettier (exit 0 when they pass)
 * A whole check at any time: npm run format:check, or scripts/check.sh without --fast.
 */
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { changedFiles, gitTop, mergeBase } from "./changed-files.mjs";
import { isMainModule } from "./is-main-module.mjs";

/** The branch work lands on (agent-tools wt.yaml): what is on it passed the check. */
const BASE_BRANCH = "mine";

/**
 * package.json's format:check folders and globs, word for word (tests/unit/prettier-scope.test.ts keeps them equal).
 * "dir/" is everything under it, dotfiles too, as Prettier walks a folder; a "*" is the shell's, which expands it
 * before Prettier starts: no "/", and no "." at the start of a name.
 */
export const ROOTS = [
	"server/",
	"web/src/",
	"extensions/",
	"scripts/",
	"bin/",
	"desktop/",
	"tests/*.mjs",
	"tests/unit/",
	"*.mjs",
];

/** Any change, a deletion too, to one of these names in any folder may change Prettier's settings or version:
 * its own settings files, .editorconfig (which the CLI reads), and package.json or package.yaml (a "prettier" key;
 * at the top also the Prettier version it asks for). */
const SETTINGS_ANYWHERE = /^(?:\.prettierrc(?:\..+)?|prettier\.config\..+|\.editorconfig|package\.json|package\.yaml)$/;
/** The same, read only at the top: the ignore files Prettier reads from where it runs, and the lock pinning its version. */
const SETTINGS_AT_TOP = new Set([".prettierignore", ".gitignore", "package-lock.json"]);

const inRoots = ROOTS.map((root) => {
	if (root.endsWith("/")) return (path) => path.startsWith(root);
	let source = "^";
	root.split("*").forEach((part, i, parts) => {
		source += part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
		if (i < parts.length - 1) source += source === "^" || source.endsWith("/") ? "(?!\\.)[^/]*" : "[^/]*";
	});
	const glob = new RegExp(`${source}$`);
	return (path) => glob.test(path);
});

/**
 * What the Prettier step has to check in the git checkout around `cwd`:
 * { all: why } for every file, or { root, base, files } (paths from the top, sorted; maybe none).
 */
export function prettierScope(cwd = process.cwd()) {
	const top = gitTop(cwd);
	if (top.error !== undefined) return { all: `not in a git checkout (${top.error || "git rev-parse failed"})` };
	const { root } = top;
	const found = mergeBase(root, "HEAD", BASE_BRANCH);
	if (found.error !== undefined)
		return { all: `no merge-base with ${BASE_BRANCH}${found.error ? ` (${found.error})` : ""}` };
	const { base } = found;
	// Against the base: the commits since, and what isn't committed yet. A rename counts as a deletion and an addition.
	const changes = changedFiles(root, base);
	if (changes.error !== undefined) return { all: `git couldn't list the changes (${changes.error})` };
	for (const { path } of changes.files) {
		if (SETTINGS_AT_TOP.has(path) || SETTINGS_ANYWHERE.test(basename(path))) {
			return { all: `${path} changed (it may change Prettier's settings or version)` };
		}
	}
	const files = changes.files
		.filter(
			({ path, deleted }) => !deleted && inRoots.some((matches) => matches(path)) && isRegularFile(join(root, path)),
		)
		.map(({ path }) => path)
		.sort();
	return { root, base, files };
}

function isRegularFile(path) {
	try {
		return lstatSync(path).isFile();
	} catch {
		return false;
	}
}

/** --check: Prettier on the scope; the exit code is Prettier's (or npm's for the whole check). */
function check(scope) {
	if (scope.all) {
		console.log(`prettier: every file, ${scope.all}: npm run format:check`);
		return run("npm", ["run", "format:check"], scope.root ?? process.cwd());
	}
	if (!scope.files.length) {
		console.log("prettier: no formatted files changed");
		return 0;
	}
	const { files } = scope;
	const named = files.length > 20 ? `${files.slice(0, 20).join(", ")} and ${files.length - 20} more` : files.join(", ");
	const count = files.length === 1 ? "1 file" : `${files.length} files`;
	console.log(
		`prettier: ${count} changed since ${BASE_BRANCH} (merge-base ${scope.base.slice(0, 8)}) in format:check's folders, ` +
			`given to Prettier, which skips any it ignores or has no parser for: ${named}`,
	);
	// This repo's own Prettier, the one `npm run format:check` runs (node_modules/.bin/prettier); never a download.
	let prettier;
	try {
		prettier = createRequire(import.meta.url).resolve("prettier/bin/prettier.cjs");
	} catch (err) {
		console.error(
			`prettier-scope: this repo's Prettier isn't installed (${err.message.split("\n")[0]}); run npm ci first.`,
		);
		return 2;
	}
	return run(process.execPath, [prettier, "--check", "--ignore-unknown", "--", ...files], scope.root);
}

function run(command, args, cwd) {
	const r = spawnSync(command, args, { cwd, stdio: "inherit" });
	if (r.error) {
		console.error(`prettier-scope: couldn't run ${command}: ${r.error.message}`);
		return 2;
	}
	return r.status ?? 1;
}

if (isMainModule(import.meta.url)) {
	const args = process.argv.slice(2);
	if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
		console.error("usage: node scripts/prettier-scope.mjs [--check]");
		process.exit(2);
	}
	const scope = prettierScope();
	if (args[0] === "--check") process.exit(check(scope));
	if (scope.all) console.log(`ALL: ${scope.all}`);
	else for (const file of scope.files) console.log(file);
}
