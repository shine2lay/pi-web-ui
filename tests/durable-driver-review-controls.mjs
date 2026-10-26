// Run the THREE regression predicates against actual 7ec462dc source, in a disposable source fixture.
// No checkout changes, provider requests, real session reads or child payload/log dumps.
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const cwd = process.cwd();
const root = mkdtempSync(join(tmpdir(), "durable-review-old-source-"));
const baseline = "7ec462dc";
try {
	cpSync(join(cwd, "server"), join(root, "server"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
	symlinkSync(join(cwd, "node_modules"), join(root, "node_modules"), "dir");
	for (const file of ["addon-bridges", "durable-driver", "session-state", "workspace-sessions"]) {
		writeFileSync(
			join(root, "server", "durable", `${file}.ts`),
			execFileSync("git", ["show", `${baseline}:server/durable/${file}.ts`], { cwd }),
		);
	}
	const report = join(root, "result.json");
	const run = spawnSync(
		process.execPath,
		[
			resolve("node_modules/vitest/vitest.mjs"),
			"run",
			"--config",
			"tests/durable-driver-review.config.ts",
			"tests/durable-driver-review.test.ts",
			"--maxWorkers=1",
			"--reporter=json",
			`--outputFile=${report}`,
			"--testNamePattern=loads the real import-only export shape|executes native registrations|mapped forks retain distinct host identities",
		],
		{ cwd, env: { ...process.env, DURABLE_REVIEW_SOURCE_ROOT: root }, encoding: "utf8" },
	);
	if (run.error) throw run.error;
	const result = JSON.parse(readFileSync(report, "utf8"));
	const assertions = result.testResults.flatMap((suite) => suite.assertionResults);
	const failed = assertions.filter((test) => test.status === "failed");
	const markers = ["import-only export", "native callable loadout", "mapped fork UUID"];
	const intended = markers.every((marker) =>
		failed.some((test) => test.failureMessages.some((message) => message.includes(`native-control: ${marker}`))),
	);
	if (
		run.status !== 1 ||
		failed.length !== 3 ||
		result.numPassedTests !== 0 ||
		result.numFailedTests !== 3 ||
		!intended
	)
		throw new Error(
			`Old-code control invalid: status=${run.status}, failed=${failed.length}, passed=${result.numPassedTests}, intended=${intended}`,
		);
	console.log(`Old-code controls: ${failed.length}/3 intended regression failures on ${baseline}.`);
	for (const test of failed) console.log(`  CONFIRMED: ${test.title}`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
