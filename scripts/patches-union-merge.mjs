#!/usr/bin/env node
/**
 * patches-union-merge.mjs: the patches-union merge driver, how Git merges PATCHES.md (.gitattributes,
 * docs/patches-union.md). Git runs it as `node <main folder>/scripts/patches-union-merge.mjs %A %O %B`.
 *
 * 1. Git's own union merge in diff3 mode, `git merge-file --union --diff3 -q <current> <base> <other>`: where both
 *    sides added an entry at the same place it keeps both, each whole, the current side's first.
 * 2. A blank line before every "## " heading that doesn't have one, nothing else. When the first of two entries
 *    added at the end of the file ends without a blank line, step 1 puts the second one's heading straight after
 *    its last line (Ops #715: owner-card-brief, then role-task-labels). Every entry's own lines stay as they are.
 *
 * The heading rule is scripts/check-patches-md.mjs's: what this driver writes passes that check's blank-line rule,
 * and the check still fails a glued heading in anything else (a hand edit, Git's plain union).
 * Exit 0 with the result in <current>; when step 1 fails, its exit status, and <current> is left as Git's.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [current, base, other] = process.argv.slice(2);
if (process.argv.length !== 5) {
	console.error("Usage: node scripts/patches-union-merge.mjs <current> <base> <other>   (Git's %A %O %B)");
	process.exit(2);
}

const union = spawnSync("git", ["merge-file", "--union", "--diff3", "-q", current, base, other], { stdio: "inherit" });
if (union.error) {
	console.error(`patches-union-merge: couldn't run git merge-file: ${union.error.message}`);
	process.exit(2);
}
if (union.status !== 0) process.exit(union.status ?? 2);

const lines = readFileSync(current, "utf8").split("\n");
const separated = [];
lines.forEach((line, i) => {
	if (i > 0 && line.startsWith("## ") && lines[i - 1].trim() !== "") separated.push("");
	separated.push(line);
});
if (separated.length !== lines.length) writeFileSync(current, separated.join("\n"));
