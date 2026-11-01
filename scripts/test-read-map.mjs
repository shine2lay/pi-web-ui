#!/usr/bin/env node
/**
 * test-read-map.mjs: runs every unit test file once with the file-read recorder on, and writes the read map of the
 * checkout's commit: which repo files each test file read, listed, copied, ran or loaded (Ops #693,
 * docs/gate-selected-tests.md). scripts/select-tests.mjs uses it to pick the tests a change can affect.
 *
 *   node scripts/test-read-map.mjs     # in a clean checkout; through `wt slot --` beside other test runs
 *
 * The run is sealed like the check's (scripts/sealed.sh), with tests/lib/record-file-reads.ts recording into a
 * temp folder; the map goes to scripts/test-read-map-store.mjs's folder as <commit>.json (mode 0600, paths only).
 * A test file that failed, or whose run ended before its afterAll, is listed as incomplete: what it read may be
 * cut short, so the selector always runs it. Exit: the unit run's own exit code once the map is written (so a
 * failing suite still shows), 2 when no map was written.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { commitOf, filesAt, gitTop } from "./changed-files.mjs";
import { isMainModule } from "./is-main-module.mjs";
import { MAP_VERSION, mapFolder, writeMap } from "./test-read-map-store.mjs";
import { isUnitTestFile } from "./unit-test-files.mjs";

const KIND_LISTS = { r: "reads", d: "dirs", t: "trees", m: "modules" };

/** Merges the recorder's lines in `rawDir` into { tests: { test: { reads, dirs, trees, modules } }, done: Set }. */
export function mergeRecords(rawDir) {
	const sets = new Map();
	const done = new Set();
	for (const name of readdirSync(rawDir)) {
		if (!name.endsWith(".jsonl")) continue;
		for (const line of readFileSync(join(rawDir, name), "utf8").split("\n")) {
			if (line === "") continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue; // a line cut short by a killed process
			}
			const [test, kind, path] = record;
			if (kind === "c") {
				done.add(test);
				continue;
			}
			const list = KIND_LISTS[kind];
			if (list === undefined || typeof test !== "string" || typeof path !== "string") continue;
			let entry = sets.get(test);
			if (entry === undefined)
				sets.set(test, (entry = { reads: new Set(), dirs: new Set(), trees: new Set(), modules: new Set() }));
			entry[list].add(path);
		}
	}
	const tests = {};
	for (const [test, entry] of sets) {
		tests[test] = Object.fromEntries(Object.entries(entry).map(([list, set]) => [list, [...set].sort()]));
	}
	return { tests, done };
}

/** The test files vitest's JSON report says failed, from the top of the checkout at `root`. */
export function failedTestFiles(root, reportFile) {
	const report = JSON.parse(readFileSync(reportFile, "utf8"));
	return (report.testResults ?? []).filter((r) => r.status !== "passed").map((r) => relative(root, r.name));
}

/** Builds the map of `commit` from the merged records, the commit's test files and the failed ones. */
export function buildMap({ commit, testFiles, merged, failed, exitCode, seconds }) {
	const tests = {};
	const incomplete = [];
	const failedSet = new Set(failed);
	for (const test of testFiles) {
		tests[test] = merged.tests[test] ?? { reads: [], dirs: [], trees: [], modules: [] };
		if (failedSet.has(test) || !merged.done.has(test)) incomplete.push(test);
	}
	return {
		v: MAP_VERSION,
		commit,
		createdAt: new Date().toISOString(),
		tests,
		incomplete,
		run: { exitCode, seconds, failed: [...failedSet].sort() },
	};
}

function main() {
	const top = gitTop();
	if (top.error !== undefined) {
		console.error(`test-read-map: not in a git checkout (${top.error})`);
		return 2;
	}
	const { root } = top;
	const head = commitOf(root, "HEAD");
	if (head.error !== undefined) {
		console.error(`test-read-map: no HEAD commit (${head.error})`);
		return 2;
	}
	const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
	if (status.status !== 0 || status.stdout.trim() !== "") {
		console.error("test-read-map: the checkout has changes not in a commit; the map must match its commit exactly");
		return 2;
	}
	const listed = filesAt(root, head.sha);
	if (listed.error !== undefined) {
		console.error(`test-read-map: can't list ${head.sha} (${listed.error})`);
		return 2;
	}
	const testFiles = listed.files.filter(isUnitTestFile);
	const rawDir = mkdtempSync(join(tmpdir(), "pi-test-read-map-"));
	try {
		const reportFile = join(rawDir, "report.json");
		const started = Date.now();
		console.log(
			`test-read-map: running ${testFiles.length} unit test files of ${head.sha.slice(0, 7)} with the recorder`,
		);
		const run = spawnSync(
			"scripts/sealed.sh",
			[
				"env",
				`PI_TEST_READ_MAP=${rawDir}`,
				`PI_TEST_READ_MAP_ROOT=${root}`,
				"npm",
				"test",
				"--",
				"--reporter=default",
				"--reporter=json",
				`--outputFile.json=${reportFile}`,
			],
			{ cwd: root, stdio: "inherit", env: { ...process.env, TZ: "UTC" } },
		);
		const seconds = Math.round((Date.now() - started) / 1000);
		const exitCode = run.status ?? 1;
		let failed;
		try {
			failed = failedTestFiles(root, reportFile);
		} catch (error) {
			console.error(`test-read-map: no unit run report (${error.message}); no map written`);
			return 2;
		}
		const merged = mergeRecords(rawDir);
		const map = buildMap({ commit: head.sha, testFiles, merged, failed, exitCode, seconds });
		const file = writeMap(mapFolder(), map);
		const entries = Object.values(map.tests);
		const byPath = entries.filter((e) => e.reads.length + e.dirs.length + e.trees.length > 0).length;
		const notInRepo = Object.keys(merged.tests).filter((t) => !(t in map.tests)).length;
		console.log(
			`test-read-map: ${testFiles.length} test files; ${byPath} read, list or copy a repo file by path; ` +
				`${map.incomplete.length} incomplete (${failed.length} failed); records for ${notInRepo} other names ignored; ` +
				`unit run exit ${exitCode}, ${seconds} s; map written to ${file}`,
		);
		return exitCode;
	} finally {
		rmSync(rawDir, { recursive: true, force: true });
	}
}

if (isMainModule(import.meta.url)) process.exit(main());
