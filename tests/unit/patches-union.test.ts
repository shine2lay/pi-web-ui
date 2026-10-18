import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * patches-union (PATCHES.md, docs/patches-union.md): two changes each add an entry under PATCHES.md's title.
 * In a scratch repo with this repo's own .gitattributes, one branch is rebased onto the other, as wt land
 * does. Both entries end with the same Undo line: the case Git's plain union merge garbles.
 */

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The driver, word for word as docs/patches-union.md says to set it (the second case checks the doc). */
const DRIVER = "git merge-file --union --diff3 -q %A %O %B";
const box = mkdtempSync(join(tmpdir(), "patches-union-"));
afterAll(() => rmSync(box, { recursive: true, force: true }));

// This test's own git settings only: a conflict style in a global or system config would change merges.
const env = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "pi-web-ui-test",
	GIT_AUTHOR_EMAIL: "pi-web-ui-test@example.com",
	GIT_COMMITTER_NAME: "pi-web-ui-test",
	GIT_COMMITTER_EMAIL: "pi-web-ui-test@example.com",
	GIT_EDITOR: "true",
	GIT_TERMINAL_PROMPT: "0",
};
function git(dir: string, ...args: string[]) {
	const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
function ok(dir: string, ...args: string[]) {
	const r = git(dir, ...args);
	expect(r.code, `git ${args.join(" ")}: ${r.out}`).toBe(0);
	return r.out;
}

const TITLE = "# PATCHES.md\n\nFork of upstream, plus the patches below.\n\n";
const UNDO = "- Undo: `pi-web-deploy rollback`, or revert this commit and deploy.\n";
const OLD = `## old-entry: an older patch\n\n- \`local\`.\n${UNDO}`;
const A = `## a-entry: the first new patch\n\n- \`local\` (Ops #1).\n- Checks: tests/unit/a.test.ts, then the landing gate.\n${UNDO}\n`;
const B = `## b-entry: the second new patch\n\n- \`local\` (Ops #2).\n- It does two things.\n- Checks: tests/unit/b.test.ts, then the landing gate.\n${UNDO}\n`;

/** Base commit on mine, then branch a adds entry A and branch b adds entry B, each under the title; on b. */
function scratch(name: string, { attributes, driver }: { attributes: boolean; driver: boolean }): string {
	const dir = join(box, name);
	const patches = join(dir, "PATCHES.md");
	mkdirSync(dir);
	ok(dir, "init", "-q", "-b", "mine");
	if (driver) {
		ok(dir, "config", "merge.patches-union.name", "PATCHES.md whole-entry union");
		ok(dir, "config", "merge.patches-union.driver", DRIVER);
	}
	if (attributes) writeFileSync(join(dir, ".gitattributes"), readFileSync(join(repo, ".gitattributes")));
	writeFileSync(patches, TITLE + OLD);
	ok(dir, "add", "-A");
	ok(dir, "commit", "-qm", "base");
	ok(dir, "checkout", "-qb", "a");
	writeFileSync(patches, TITLE + A + OLD);
	ok(dir, "commit", "-qam", "a");
	ok(dir, "checkout", "-q", "mine");
	ok(dir, "checkout", "-qb", "b");
	writeFileSync(patches, TITLE + B + OLD);
	ok(dir, "commit", "-qam", "b");
	return dir;
}

/** Rebases b onto a. A conflict must be on PATCHES.md; the rebase is then aborted and b is left as it was. */
function rebase(dir: string): "clean" | "conflict" {
	if (git(dir, "rebase", "a").code === 0) return "clean";
	expect(ok(dir, "diff", "--name-only", "--diff-filter=U").trim()).toBe("PATCHES.md");
	ok(dir, "rebase", "--abort");
	expect(readFileSync(join(dir, "PATCHES.md"), "utf8")).toBe(TITLE + B + OLD);
	return "conflict";
}

describe("patches-union: two entries added under PATCHES.md's title at once", () => {
	it("conflict without the attribute", () => {
		const dir = scratch("no-attribute", { attributes: false, driver: true });
		expect(rebase(dir)).toBe("conflict");
	});

	it("both entries whole with the attribute and the driver, Undo lines included", () => {
		expect(readFileSync(join(repo, ".gitattributes"), "utf8")).toMatch(/^PATCHES\.md merge=patches-union$/m);
		expect(readFileSync(join(repo, "docs", "patches-union.md"), "utf8")).toContain(
			`git config merge.patches-union.driver "${DRIVER}"`,
		);
		const dir = scratch("driver", { attributes: true, driver: true });
		// wt land's early conflict check (git merge-tree) sees no conflict either.
		ok(dir, "merge-tree", "--write-tree", "--name-only", "--no-messages", "a", "b");
		expect(rebase(dir)).toBe("clean");
		// Whole: the entry already on the base first, then the rebased one, each with its own Undo line.
		expect(readFileSync(join(dir, "PATCHES.md"), "utf8")).toBe(TITLE + A + B + OLD);
		const guard = spawnSync(process.execPath, [join(repo, "scripts", "check-patches-md.mjs"), join(dir, "PATCHES.md")]);
		expect(guard.status).toBe(0);
	});

	it("a normal conflict, never a garbled merge, where the driver isn't set", () => {
		const dir = scratch("attribute-only", { attributes: true, driver: false });
		expect(rebase(dir)).toBe("conflict");
	});
});
