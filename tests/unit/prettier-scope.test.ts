import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ROOTS } from "../../scripts/prettier-scope.mjs";

/**
 * gate-prettier-changed (PATCHES.md, docs/gate-prettier-changed.md): `scripts/check.sh --fast`, the check wt land
 * runs, gives Prettier only the files a land changes (scripts/prettier-scope.mjs), or every file when Prettier's
 * settings or version may have changed. Each case makes a scratch repo the way a land's worktree has it: a base
 * commit on mine, then a work branch with the change. The script runs from this repo, so --check uses this repo's
 * own Prettier, with a copy of its .prettierrc.json.
 */

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(repo, "scripts", "prettier-scope.mjs");
// Each case runs git several times and the script once or twice; with --check also Prettier or npm. Alone that is
// well under a second, but the gate runs the unit tests beside typecheck and lint, which makes spawns 2-4x slower.
const SLOW = 30_000;
const box = mkdtempSync(join(tmpdir(), "prettier-scope-"));
afterAll(() => rmSync(box, { recursive: true, force: true }));

// This test's own git settings only, as in patches-union.test.ts.
const env = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "pi-web-ui-test",
	GIT_AUTHOR_EMAIL: "pi-web-ui-test@example.com",
	GIT_COMMITTER_NAME: "pi-web-ui-test",
	GIT_COMMITTER_EMAIL: "pi-web-ui-test@example.com",
	GIT_TERMINAL_PROMPT: "0",
};
function git(dir: string, ...args: string[]) {
	const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
	expect(r.status, `git ${args.join(" ")}: ${r.stdout}${r.stderr}`).toBe(0);
}
/** The script in `dir`: its exit code, what it printed (stdout and stderr together), and stdout's lines. */
function scope(dir: string, ...args: string[]) {
	const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, env, encoding: "utf8" });
	return { code: r.status, out: `${r.stdout}${r.stderr}`, lines: r.stdout.split("\n").filter(Boolean) };
}
/** What --check would check: "ALL: <why>", or the files. */
const list = (dir: string) => {
	const r = scope(dir);
	expect(r.code, r.out).toBe(0);
	return r.lines;
};

const FORMATTED = "export const answer = 42;\n";
const UNFORMATTED = "export const answer   =  42\n";
/** Text for a file; null deletes it. */
type Files = Record<string, string | null>;
function put(dir: string, files: Files) {
	for (const [name, text] of Object.entries(files)) {
		if (text === null) rmSync(join(dir, name));
		else {
			mkdirSync(dirname(join(dir, name)), { recursive: true });
			writeFileSync(join(dir, name), text);
		}
	}
}
/** In the base: Prettier's real settings, an ignore list, and a stand-in for the whole check (npm run format:check). */
const BASE: Files = {
	".prettierrc.json": readFileSync(join(repo, ".prettierrc.json"), "utf8"),
	".prettierignore": "server/kept-as-is.ts\n",
	".gitignore": "server/generated/\n",
	"package.json": `${JSON.stringify({ name: "scratch", private: true, scripts: { "format:check": "node -e \"console.log('the whole check ran')\"" } }, null, "\t")}\n`,
	"server/keep.ts": FORMATTED,
	"server/old.ts": FORMATTED,
	// Markdown outside format:check's folders, kept out of the docs folder: notes-check-list.test.ts takes a Markdown
	// path there in a unit test's code for one of this repo's notes, and these are scratch files.
	"README.md": "# Readme\n",
};
/** A scratch repo: BASE (and `base`) committed on mine, then branch work (an orphan with `orphan`) with `work` committed. */
function scratch(name: string, work: Files, { base = {}, orphan = false }: { base?: Files; orphan?: boolean } = {}) {
	const dir = join(box, name);
	mkdirSync(dir);
	git(dir, "init", "-q", "-b", "mine");
	put(dir, { ...BASE, ...base });
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "base");
	git(dir, "checkout", "-q", orphan ? "--orphan" : "-b", "work");
	put(dir, work);
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "--allow-empty", "-m", "work");
	return dir;
}

describe("prettier-scope: what check.sh --fast gives Prettier", () => {
	it(
		"(a) a badly formatted changed file under server/ is listed, and --check fails on it",
		() => {
			const dir = scratch("a", { "server/bad.ts": UNFORMATTED });
			expect(list(dir)).toEqual(["server/bad.ts"]);
			const r = scope(dir, "--check");
			expect(r.code, r.out).toBe(1);
			expect(r.out).toContain("[warn] server/bad.ts");
		},
		SLOW,
	);

	it(
		"(b) changed Markdown files outside format:check's folders, at the top and in a folder, are not listed",
		() => {
			const dir = scratch("b", {
				"README.md": "#   Not   formatted\n*  item\n",
				"plugins/p/notes.md": "#   Not   formatted\n*  item\n",
			});
			expect(list(dir)).toEqual([]);
		},
		SLOW,
	);

	it(
		"(c) a changed .prettierrc.json gives ALL, and --check then runs the whole check (npm run format:check)",
		() => {
			const dir = scratch("c", {
				".prettierrc.json": '{\n\t"useTabs": true,\n\t"printWidth": 100\n}\n',
				"server/bad.ts": UNFORMATTED,
			});
			const lines = list(dir);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toMatch(/^ALL: \.prettierrc\.json changed/);
			const r = scope(dir, "--check");
			expect(r.code, r.out).toBe(0);
			expect(r.out).toContain("the whole check ran");
			expect(r.out).not.toContain("server/bad.ts");
		},
		SLOW,
	);

	it(
		"(c) every other change that may change Prettier's settings gives ALL too, a deleted one included",
		() => {
			const cases: [string, Files][] = [
				[".prettierignore", { ".prettierignore": null }],
				[".gitignore", { ".gitignore": "server/generated/\nserver/other/\n" }],
				["package-lock.json", { "package-lock.json": "{}\n" }],
				["web/.prettierrc", { "web/.prettierrc": "semi: false\n" }],
				["server/prettier.config.mjs", { "server/prettier.config.mjs": "export default { semi: false };\n" }],
				["desktop/.editorconfig", { "desktop/.editorconfig": "[*]\nindent_size = 8\n" }],
				["plugins/x/package.json", { "plugins/x/package.json": '{ "prettier": { "semi": false } }\n' }],
			];
			cases.forEach(([path, work], i) => {
				const lines = list(scratch(`c-${i}`, work));
				expect(lines, path).toHaveLength(1);
				expect(lines[0], path).toMatch(new RegExp(`^ALL: ${path.replaceAll(".", "\\.")} changed`));
			});
		},
		SLOW,
	);

	it(
		"(d) a changed package.json gives ALL, and a failing whole check fails --check",
		() => {
			const failing = {
				name: "scratch",
				private: true,
				scripts: { "format:check": "node -e \"console.log('the whole check failed'); process.exit(1)\"" },
			};
			const dir = scratch("d", { "package.json": `${JSON.stringify(failing, null, "\t")}\n` });
			expect(list(dir)).toEqual([expect.stringMatching(/^ALL: package\.json changed/)]);
			const r = scope(dir, "--check");
			expect(r.code, r.out).not.toBe(0);
			expect(r.out).toContain("the whole check failed");
		},
		SLOW,
	);

	it(
		"(e) no merge-base with mine gives ALL: an unrelated history, and a repo without mine",
		() => {
			const unrelated = scratch("e", { "server/bad.ts": UNFORMATTED }, { orphan: true });
			expect(list(unrelated)).toEqual([expect.stringMatching(/^ALL: no merge-base with mine/)]);
			const noMine = join(box, "e-no-mine");
			mkdirSync(noMine);
			git(noMine, "init", "-q", "-b", "main");
			put(noMine, BASE);
			git(noMine, "add", "-A");
			git(noMine, "commit", "-qm", "base");
			expect(list(noMine)).toEqual([expect.stringMatching(/^ALL: no merge-base with mine/)]);
		},
		SLOW,
	);

	it(
		"(f) a deleted file is not listed, and a renamed one is, under its new name",
		() => {
			expect(list(scratch("f", { "server/old.ts": null }))).toEqual([]);
			expect(list(scratch("f-renamed", { "server/old.ts": null, "server/renamed.ts": FORMATTED }))).toEqual([
				"server/renamed.ts",
			]);
		},
		SLOW,
	);

	it(
		"(g) a changed file named in .prettierignore is given to Prettier, which skips it",
		() => {
			const dir = scratch("g", { "server/kept-as-is.ts": UNFORMATTED });
			expect(list(dir)).toEqual(["server/kept-as-is.ts"]);
			const r = scope(dir, "--check");
			expect(r.code, r.out).toBe(0);
			expect(r.out).not.toContain("[warn]");
		},
		SLOW,
	);

	it(
		"(h) well-formatted changed files pass",
		() => {
			const dir = scratch("h", { "server/good.ts": FORMATTED, "tests/unit/good.test.ts": FORMATTED });
			expect(list(dir)).toEqual(["server/good.ts", "tests/unit/good.test.ts"]);
			const r = scope(dir, "--check");
			expect(r.code, r.out).toBe(0);
			expect(r.out).toContain("prettier: 2 files changed since mine");
			expect(r.out).toContain("All matched files use Prettier code style!");
		},
		SLOW,
	);

	it(
		"(i) nothing in format:check's folders changed: --check says so and exits 0",
		() => {
			const r = scope(scratch("i", { "README.md": "# Readme, changed\n" }), "--check");
			expect(r.code, r.out).toBe(0);
			expect(r.lines).toEqual(["prettier: no formatted files changed"]);
		},
		SLOW,
	);

	it(
		"(j) the folders are format:check's own, a path counting the way the shell and Prettier count it",
		() => {
			const script: string = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts["format:check"];
			const words = script.trim().split(/\s+/);
			expect(words.slice(0, 2)).toEqual(["prettier", "--check"]);
			expect(ROOTS).toEqual(words.slice(2));
			const paths = [
				"tests/top.mjs",
				"tests/e2e/deep.mjs",
				"tests/top.ts",
				"tests/unit/deep/x.ts",
				"top.mjs",
				".hidden.mjs",
				"sub/a.mjs",
				"top.ts",
			];
			const more = [
				"web/a.ts",
				"web/src/b.tsx",
				"server/.hidden.ts",
				"extensions/e/c.js",
				"scripts/d.mjs",
				"bin/e.mjs",
				"desktop/f.ts",
			];
			const dir = scratch("j", Object.fromEntries([...paths, ...more].map((p) => [p, FORMATTED])));
			expect(list(dir)).toEqual(
				[
					"bin/e.mjs",
					"desktop/f.ts",
					"extensions/e/c.js",
					"scripts/d.mjs",
					"server/.hidden.ts",
					"tests/top.mjs",
					"tests/unit/deep/x.ts",
					"top.mjs",
					"web/src/b.tsx",
				].sort(),
			);
		},
		SLOW,
	);

	it(
		"(k) edits not committed yet count too: a changed tracked file and a new one, not one .gitignore leaves out",
		() => {
			const dir = scratch("k", {});
			put(dir, { "server/keep.ts": UNFORMATTED, "server/new.ts": FORMATTED, "server/generated/made.ts": UNFORMATTED });
			expect(list(dir)).toEqual(["server/keep.ts", "server/new.ts"]);
			const r = scope(dir, "--check");
			expect(r.code, r.out).toBe(1);
			expect(r.out).toContain("[warn] server/keep.ts");
			expect(r.out).not.toContain("generated");
		},
		SLOW,
	);

	it(
		"(l) a symbolic link is not listed: Prettier skips one in a folder and refuses one named to it",
		() => {
			const dir = scratch("l", {});
			symlinkSync("keep.ts", join(dir, "server", "link.ts"));
			git(dir, "add", "-A");
			git(dir, "commit", "-qm", "link");
			expect(list(dir)).toEqual([]);
			expect(scope(dir, "--check").code).toBe(0);
		},
		SLOW,
	);

	it("(m) check.sh runs it only with --fast; the full check and format:check still check every file", () => {
		const check = readFileSync(join(repo, "scripts", "check.sh"), "utf8");
		const prettierSteps = check.split("\n").filter((line) => /^\s*quick prettier /.test(line));
		expect(prettierSteps.map((line) => line.trim())).toEqual([
			'quick prettier "prettier" node scripts/prettier-scope.mjs --check',
			'quick prettier "prettier" npm run format:check',
		]);
		expect(check).toMatch(
			/if \$fast; then\n\s*quick prettier "prettier" node scripts\/prettier-scope\.mjs --check\nelse\n\s*quick prettier "prettier" npm run format:check\nfi/,
		);
	});
});
