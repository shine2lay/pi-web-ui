/**
 * Prints the smoke-files hash of this repo, by test-check's rule (agent-tools docs/test-check-ids-3.md
 * and test-check-ids-3-records.md, TEST-SMOKE-PROOF): the test files holding an @flow:<id> tag, sorted by
 * repo-relative path, each as "<path>\n<sha256 hex of its bytes>\n", then the sha256 hex of that text.
 * proof.json's smoke_files_sha256 must equal it (test-check checks that); when a smoke file changes, redo
 * the planted breaks (PROOF.md) and record the new hash.   Usage: node tests/release-smoke/proof-hash.mjs
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"vendor",
	"dist",
	"build",
	"coverage",
	".venv",
	"venv",
	"__pycache__",
	"target",
	"fixtures",
	"__fixtures__",
	"testdata",
]);
const TEST_NAME =
	/(\.(test|spec)\.(js|mjs|cjs|jsx|ts|mts|cts|tsx)|-test\.(js|mjs|cjs|jsx|ts|mts|cts|tsx)|^test_.*\.py|_test\.py|_test\.go|\.bats)$/;
const FLOW_TAG = /@flow:[A-Za-z0-9_-]+/;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function* walk(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) yield* walk(full);
		else if (entry.isFile() && TEST_NAME.test(entry.name)) yield full;
	}
}

const files = [];
for (const full of walk(ROOT))
	if (FLOW_TAG.test(readFileSync(full, "utf8"))) files.push(relative(ROOT, full).split(sep).join("/"));
files.sort();
for (const rel of files) console.error(`smoke file: ${rel}`);
console.log(sha256(files.map((rel) => `${rel}\n${sha256(readFileSync(join(ROOT, rel)))}\n`).join("")));
