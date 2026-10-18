import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * scripts/check-patches-md.mjs (patches-union, docs/patches-union.md): the check scripts/check.sh runs on
 * PATCHES.md, which merges by union. It fails on the two signs of a bad union merge and names the heading.
 */

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(repo, "scripts", "check-patches-md.mjs");
const box = mkdtempSync(join(tmpdir(), "check-patches-md-"));
afterAll(() => rmSync(box, { recursive: true, force: true }));

let n = 0;
/** Runs the check on `text` (written to a temp file), or on the repo's own PATCHES.md. */
function check(text?: string) {
	const args = [SCRIPT];
	if (text !== undefined) {
		const file = join(box, `PATCHES-${++n}.md`);
		writeFileSync(file, text);
		args.push(file);
	}
	const r = spawnSync(process.execPath, args, { encoding: "utf8" });
	return { code: r.status, err: r.stderr };
}

const TITLE = "# PATCHES.md\n\nIntro.\n\n";
const entry = (name: string) => `## ${name}: what it does\n\n- \`local\`.\n- Undo: revert this commit.\n\n`;

describe("check-patches-md", () => {
	it("passes the repo's own PATCHES.md", () => {
		const r = check();
		expect(r.err).toBe("");
		expect(r.code).toBe(0);
	});

	it("fails on a heading that appears twice, naming it and its lines", () => {
		const r = check(TITLE + entry("a") + entry("b") + entry("a"));
		expect(r.code).toBe(1);
		expect(r.err).toContain('has the same "## " heading more than once');
		expect(r.err).toContain("## a: what it does  (lines 5, 15)");
		expect(r.err).not.toContain("## b: what it does");
	});

	it("fails on a heading with no blank line before it, naming it", () => {
		// What Git's plain union merge makes of two new entries: the second heading follows straight on.
		const r = check(`${TITLE}## a: what it does\n\n- \`local\`.\n${entry("b")}`);
		expect(r.code).toBe(1);
		expect(r.err).toContain('has a "## " heading with no blank line before it');
		expect(r.err).toContain("line 8: ## b: what it does");
		expect(r.err).not.toContain("more than once");
	});
});
