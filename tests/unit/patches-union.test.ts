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
 * Then the real end-of-file entries of Nov 1 (Ops #715): one ends without a blank line, so Git's union
 * alone glued the next entry's heading to it.
 */

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The driver setting, word for word as docs/patches-union.md says to set it, run in the repo's main folder. */
const DRIVER_SETTING = "node $PWD/scripts/patches-union-merge.mjs %A %O %B";
/** That setting run in this checkout: its own scripts/patches-union-merge.mjs. */
const DRIVER = DRIVER_SETTING.replace("$PWD", repo);
/** The driver before Ops #715: Git's union in diff3 mode alone. */
const UNION_ONLY_DRIVER = "git merge-file --union --diff3 -q %A %O %B";
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

/** A scratch repo on mine, with the driver set (`driver`: its command) or not. */
function init(name: string, driver: string | null): string {
	const dir = join(box, name);
	mkdirSync(dir);
	ok(dir, "init", "-q", "-b", "mine");
	if (driver) {
		ok(dir, "config", "merge.patches-union.name", "PATCHES.md whole-entry union");
		ok(dir, "config", "merge.patches-union.driver", driver);
	}
	return dir;
}

/** Exit status and error output of scripts/check-patches-md.mjs (the landing check's PATCHES.md step) on a file. */
function checkPatchesMd(file: string) {
	const r = spawnSync(process.execPath, [join(repo, "scripts", "check-patches-md.mjs"), file], { encoding: "utf8" });
	return { status: r.status, err: r.stderr };
}

/** Base commit on mine, then branch a adds entry A and branch b adds entry B, each under the title; on b. */
function scratch(name: string, { attributes, driver }: { attributes: boolean; driver: boolean }): string {
	const dir = init(name, driver ? DRIVER : null);
	const patches = join(dir, "PATCHES.md");
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
			`git config merge.patches-union.driver "${DRIVER_SETTING}"`,
		);
		const dir = scratch("driver", { attributes: true, driver: true });
		// wt land's early conflict check (git merge-tree) sees no conflict either.
		ok(dir, "merge-tree", "--write-tree", "--name-only", "--no-messages", "a", "b");
		expect(rebase(dir)).toBe("clean");
		// Whole: the entry already on the base first, then the rebased one, each with its own Undo line.
		expect(readFileSync(join(dir, "PATCHES.md"), "utf8")).toBe(TITLE + A + B + OLD);
		expect(checkPatchesMd(join(dir, "PATCHES.md")).status).toBe(0);
	});

	it("a normal conflict, never a garbled merge, where the driver isn't set", () => {
		const dir = scratch("attribute-only", { attributes: true, driver: false });
		expect(rebase(dir)).toBe("conflict");
	});
});

/**
 * Nov 1's real entries, byte for byte (tests/fixtures/patches-union/): the base's last entry (queue-replay-incremental,
 * on 55f2d565) and the entries four lands added after it at the end of PATCHES.md: board-read-marks (Ops #710, landed
 * first, bf6b9b0a), owner-card-brief (Ops #682, land 290-86c563), role-task-labels (Ops #712, land 292-1df683) and
 * queue-replay-shared-frozen (Ops #713, land 295-e244b4). owner-card-brief's addition starts with a blank line and
 * ends without one; the others start with their heading and end with a blank line. Only the file's end matters to
 * these merges: on the whole files they come out with the same end, byte for byte.
 */
const fixture = (name: string) => readFileSync(join(repo, "tests", "fixtures", "patches-union", `${name}.md`), "utf8");
const BASE = fixture("base");
const BOARD_READ_MARKS = fixture("board-read-marks");
const OWNER_CARD_BRIEF = fixture("owner-card-brief");
const LATER = {
	"role-task-labels": fixture("role-task-labels"),
	"queue-replay-shared-frozen": fixture("queue-replay-shared-frozen"),
};

/**
 * As the lands went: each branch adds its entry at the end of the same base; board-read-marks lands on mine, then
 * owner-card-brief is rebased onto mine (land 290), then `later` is rebased onto that (land 292 or 295).
 * Returns PATCHES.md after the last rebase.
 */
function replayEndOfFile(name: string, driver: string, later: keyof typeof LATER): string {
	const dir = init(name, driver);
	const patches = join(dir, "PATCHES.md");
	writeFileSync(join(dir, ".gitattributes"), readFileSync(join(repo, ".gitattributes")));
	writeFileSync(patches, BASE);
	ok(dir, "add", "-A");
	ok(dir, "commit", "-qm", "base");
	for (const [branch, entry] of [
		["owner-card-brief", OWNER_CARD_BRIEF],
		[later, LATER[later]],
	]) {
		ok(dir, "checkout", "-qb", branch, "mine");
		writeFileSync(patches, BASE + entry);
		ok(dir, "commit", "-qam", branch);
	}
	ok(dir, "checkout", "-q", "mine");
	writeFileSync(patches, BASE + BOARD_READ_MARKS);
	ok(dir, "commit", "-qam", "board-read-marks");
	ok(dir, "rebase", "-q", "mine", "owner-card-brief");
	expect(readFileSync(patches, "utf8")).toBe(BASE + BOARD_READ_MARKS + OWNER_CARD_BRIEF);
	// wt land's early conflict check (git merge-tree) sees no conflict.
	ok(dir, "merge-tree", "--write-tree", "--name-only", "--no-messages", "owner-card-brief", later);
	ok(dir, "rebase", "-q", "owner-card-brief", later);
	return readFileSync(patches, "utf8");
}

describe("patches-union: Nov 1's real entries added at the end of PATCHES.md (Ops #715)", () => {
	for (const later of Object.keys(LATER) as (keyof typeof LATER)[]) {
		it(`owner-card-brief then ${later}: every entry whole, each heading after a blank line`, () => {
			const merged = replayEndOfFile(`eof-${later}`, DRIVER, later);
			// Every entry's bytes unchanged and in landing order; the one line added is the blank line before the heading.
			expect(merged).toBe(BASE + BOARD_READ_MARKS + OWNER_CARD_BRIEF + "\n" + LATER[later]);
			writeFileSync(join(box, `eof-${later}.md`), merged);
			expect(checkPatchesMd(join(box, `eof-${later}.md`)).status).toBe(0);
		});

		it(`owner-card-brief then ${later}: Git's union alone glues the heading on, and the check fails`, () => {
			const merged = replayEndOfFile(`eof-union-only-${later}`, UNION_ONLY_DRIVER, later);
			expect(merged).toBe(BASE + BOARD_READ_MARKS + OWNER_CARD_BRIEF + LATER[later]);
			writeFileSync(join(box, `eof-union-only-${later}.md`), merged);
			const check = checkPatchesMd(join(box, `eof-union-only-${later}.md`));
			expect(check.status).toBe(1);
			expect(check.err).toContain(`## ${later}:`);
		});
	}
});
