#!/usr/bin/env node
/**
 * check-patches-md.mjs: catches a bad union merge of PATCHES.md.
 *
 * PATCHES.md merges by union with whole entries (.gitattributes, docs/patches-union.md): when two
 * changes each add an entry under its title, Git keeps both entries instead of stopping on a conflict.
 * Two signs that a merge went wrong fail here, naming the heading, instead of passing silently:
 *   - the same "## " heading twice (say, two versions of one patch's entry, both kept);
 *   - a "## " heading with no blank line before it. Git's plain union merge leaves this every time it
 *     splits two new entries, writing the lines they share (the closing blank line, a common Undo line)
 *     only once, after both: the second heading then follows straight on from the first entry.
 *
 * Usage: node scripts/check-patches-md.mjs [file]   (default: PATCHES.md at the repo root)
 * scripts/check.sh runs it in both modes, so wt land's checks do too.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const name = process.argv[2] ?? "PATCHES.md";
const lines = readFileSync(process.argv[2] ?? join(root, "PATCHES.md"), "utf8").split("\n");

/** heading text -> the line numbers it is on */
const where = new Map();
/** headings with no blank line before them: "line N: heading" */
const glued = [];
lines.forEach((text, i) => {
	if (!text.startsWith("## ")) return;
	const heading = text.trimEnd();
	where.set(heading, [...(where.get(heading) ?? []), i + 1]);
	if (i > 0 && lines[i - 1].trim() !== "") glued.push(`line ${i + 1}: ${heading}`);
});
const twice = [...where].filter(([, at]) => at.length > 1);

if (twice.length) {
	console.error(`✗ ${name} has the same "## " heading more than once (a merge kept an entry twice?):`);
	for (const [heading, at] of twice) console.error(`  ${heading}  (lines ${at.join(", ")})`);
	console.error("  Keep one copy of each entry (merge the two if they differ).");
}
if (glued.length) {
	console.error(`✗ ${name} has a "## " heading with no blank line before it (a merge split two entries?):`);
	for (const at of glued) console.error(`  ${at}`);
	console.error("  Check that the entry above it is whole (a shared line such as its Undo line may have moved),");
	console.error("  then put a blank line before the heading.");
}
if (twice.length || glued.length) process.exit(1);
console.log(`✓ ${name}: ${where.size} entries, no heading twice, each after a blank line`);
