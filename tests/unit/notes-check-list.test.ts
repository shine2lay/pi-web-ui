import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";

// notes-check (PATCHES.md; agent-tools docs/wt-notes-check.md, Ops #235): a change that touches only notes
// (docs/**/*.md and PATCHES.md) lands after `scripts/check.sh --notes` alone. That runs the PATCHES.md check
// and only the unit test files on check.sh's notes_tests list. A test that reads a note but isn't on that list
// could let a broken note land, so this test fails when a file under tests/unit names a note in its code
// (comments don't count) and is on neither that list nor NAMES_ONLY below.

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const UNIT = join(repo, "tests", "unit");

/** Reviewed: files whose code names a note but never reads one of the repo's notes, each with why. */
const NAMES_ONLY: Record<string, string> = {
	"present-files.test.ts": "makes its own notes folder and file in a temp folder and reads only those",
	"tool-approval.test.ts": "asks the approval rules about a docs path; nothing is read",
	"work-page.test.ts": "a docs path is only a proof string in its fixtures",
	"notes-check-list.test.ts": "this guard: it names notes only to look for them",
};

/** scripts/check.sh: its notes_tests list (repo paths) and the body of its --notes branch. */
function checkSh() {
	const text = readFileSync(join(repo, "scripts", "check.sh"), "utf8");
	const list = text.match(/^notes_tests=\(\n([\s\S]*?)\n\)$/m);
	const branch = text.match(/^if \[ "\$\{1:-\}" = "--notes" \]; then\n([\s\S]*?)\nfi$/m);
	return {
		list: list
			? list[1]
					.split("\n")
					.map((l) => l.trim())
					.filter(Boolean)
			: [],
		branch: branch ? branch[1] : "",
	};
}

const READS = /\b(?:join|resolve|URL|readdirSync|readdir|readFileSync|readFile|existsSync|statSync|globSync|glob)\(/;

/** The note a file's code names (comments and types left out by esbuild), or "" when it names none. */
function namedNote(file: string): string {
	const source = readFileSync(join(UNIT, file), "utf8");
	const code = transformSync(source, {
		loader: file.endsWith("x") ? "tsx" : "ts",
		legalComments: "none",
		charset: "utf8",
	}).code;
	if (/PATCHES\\?\.md/.test(code)) return "PATCHES.md";
	const doc = code.match(/(?:^|[^\w-])(docs\/[\w./*\\-]*\.md)(?!\w)/m);
	if (doc) return doc[1];
	// A path put together from parts, such as join(repo, "docs", name).
	const call = code.split("\n").find((line) => /["'`]docs["'`]/.test(line) && READS.test(line));
	return call ? `"docs" in: ${call.trim()}` : "";
}

const files = readdirSync(UNIT, { recursive: true, encoding: "utf8" })
	.filter((f) => /\.(?:[cm]?[jt]s|tsx)$/.test(f))
	.sort();

describe("notes-check: what scripts/check.sh --notes runs", () => {
	const { list, branch } = checkSh();
	const named = new Map(files.map((f) => [f, namedNote(f)]));

	it("the --notes branch runs the PATCHES.md check and the notes_tests list, and the list isn't empty", () => {
		expect(list.length).toBeGreaterThan(0);
		expect(branch).toContain("node scripts/check-patches-md.mjs");
		expect(branch).toContain('npm test -- "${notes_tests[@]}"');
	});

	it("every unit test file that names a note in its code is on notes_tests or on NAMES_ONLY", () => {
		const onList = new Set(list);
		const missing = [...named]
			.filter(([f, note]) => note && !onList.has(`tests/unit/${f}`) && !(f in NAMES_ONLY))
			.map(([f, note]) => `tests/unit/${f} (${note})`);
		expect(
			missing,
			"These name a note in their code but are on neither list. If one reads the note, add it to notes_tests in " +
				"scripts/check.sh; if it only names it, add it to NAMES_ONLY here with why.",
		).toEqual([]);
	});

	it("each entry on either list exists and still names a note, and none is on both", () => {
		const stale: string[] = [];
		for (const entry of list) {
			const f = entry.replace(/^tests\/unit\//, "");
			if (!entry.startsWith("tests/unit/") || !/\.test\.tsx?$/.test(f) || !named.has(f))
				stale.push(`notes_tests: ${entry} is not a unit test file`);
			else if (!named.get(f)) stale.push(`notes_tests: ${entry} names no note any more; take it off`);
			if (f in NAMES_ONLY) stale.push(`${entry} is on both lists`);
		}
		for (const f of Object.keys(NAMES_ONLY)) {
			if (!named.has(f)) stale.push(`NAMES_ONLY: tests/unit/${f} doesn't exist`);
			else if (!named.get(f)) stale.push(`NAMES_ONLY: tests/unit/${f} names no note any more; take it off`);
		}
		expect(stale).toEqual([]);
	});
});
