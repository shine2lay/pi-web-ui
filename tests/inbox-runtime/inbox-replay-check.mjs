// External acceptance evidence checker; never imported by production or default tests.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseline = "e3d7aaf4a3303dd22f26a4a062f8b118df0d588d";
const baseParent = "a4ea82744d35fa2b49b7d3728c31122ea0003a19";
const evidence = process.env.INBOX_EVIDENCE_DIR || "/home/shinelay/ops-checks/priority-inbox-1132";
const contract = "/home/shinelay/architecture-dept/tests/role-priority-inbox";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", ["-C", root, ...args]);
const inputs = [
	["core", "role-priority-inbox.cases.json", 90, "a93ee55478be95282bca124e31400e419035fe016e497995b828585e2242d7b1"],
	["delivery", "delivery/delivery.cases.json", 69, "1aabea2f3198645e613beb47d66053e3085640a15003e71a62c28df037bdd059"],
	["helper", "helpers/helper.cases.json", 120, "aabc75c5342fe85d6a3efefebb0ebd3546b9ed54ca78c95b3e6e5eec66fab81b"],
];
const failures = [];
const deferred = [];
const originalHashes = {};
const newHashes = {};
const coverage = [];
function check(fn) {
	try {
		fn();
	} catch (error) {
		failures.push(error.message);
	}
}
const originalFiles = git("diff", "--name-only", baseParent, baseline, "--", "tests/")
	.toString()
	.trim()
	.split("\n")
	.filter(Boolean);
for (const file of originalFiles)
	check(() => {
		const expected = sha(git("show", `${baseline}:${file}`));
		originalHashes[file] = expected;
		assert.equal(sha(readFileSync(resolve(root, file))), expected, `Frozen artifact changed: ${file}`);
	});
const resultsPath = resolve(evidence, "runtime-results.json");
const execution = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")) : null;
const executed =
	execution?.testResults?.flatMap((file) =>
		(file.assertionResults || []).map((test) => ({
			file: relative(root, file.name),
			title: test.title,
			fullName: test.fullName,
			status: test.status,
		})),
	) || [];
for (const [name, source, count, digest] of inputs)
	check(() => {
		const bytes = readFileSync(resolve(contract, source));
		assert.equal(sha(bytes), digest, `${name} input pin`);
		const cases = JSON.parse(bytes).cases;
		assert.equal(cases.length, count);
		const mapFile = `tests/inbox-runtime/inbox-${name}-map.json`;
		const map = JSON.parse(readFileSync(resolve(root, mapFile), "utf8"));
		assert.ok(Array.isArray(map), `${name} map must be an array`);
		assert.deepEqual(map.map((row) => row.id).sort(), cases.map((row) => row.id).sort(), `${name} exact IDs`);
		assert.equal(new Set(map.map((row) => row.id)).size, count, `${name} duplicate IDs`);
		for (const row of map) {
			// Helpers are a later increment under the lead's Rule42 ruling.
			if (name === "helper" && row.status === "behavioral") {
				row.status = "uncovered";
				row.reason = "Deferred helper increment; draft adapters are not verified coverage";
			}
			const item = { corpus: name, ...row };
			coverage.push(item);
			check(() => {
				assert.ok(["behavioral", "external", "uncovered"].includes(row.status), `${row.id}: status`);
				assert.ok(typeof row.owner === "string" && row.owner.length, `${row.id}: owner`);
				assert.ok(typeof row.boundary === "string" && row.boundary.length, `${row.id}: boundary`);
				if (row.status !== "behavioral") {
					assert.ok(row.reason, `${row.id}: missing gap reason`);
					deferred.push(`${row.id}: ${row.status}: ${row.reason}`);
					return;
				}
				assert.ok(row.file?.startsWith("tests/") && !row.file.includes(".."), `${row.id}: test path`);
				assert.ok(typeof row.title === "string" && row.title.length, `${row.id}: title`);
				newHashes[row.file] = sha(readFileSync(resolve(root, row.file)));
				const matches = executed.filter(
					(test) => test.file === row.file && (test.title === row.title || test.fullName === row.title),
				);
				assert.equal(matches.length, 1, `${row.id}: requires exactly one executed mapped assertion`);
				assert.ok(["passed", "failed"].includes(matches[0].status), `${row.id}: skipped/pending is not replay`);
				item.observed = matches[0].status;
			});
		}
	});
// #607 is covered by the untouched codec test's individual TAP subtests, not inventory.
const codecPath = resolve(evidence, "codec.tap");
let boundaryCount = 0;
let twins = 0;
check(() => {
	const tap = readFileSync(codecPath, "utf8");
	boundaryCount = (tap.match(/^# Subtest: .+\/\d+ strict boundary$/gm) || []).length;
	twins = (tap.match(/^# Subtest: .+\/valid-twin$/gm) || []).length;
	assert.equal(boundaryCount, 232, "#607 executed vectors");
	assert.equal(twins, 47, "#607 executed valid twins");
	assert.match(tap, /^# tests 329$/m, "codec completed count");
});
const migration = executed.filter((test) => test.file === "tests/inbox-runtime/inbox-migration.test.ts");
check(() => {
	assert.equal(migration.length, 12, "RET4 executed tests");
	assert.ok(
		migration.every((test) => ["passed", "failed"].includes(test.status)),
		"RET4 skipped tests",
	);
});
const controls = executed.filter((test) => /legacy|GREEN/.test(test.title));
check(() => {
	assert.ok(controls.length > 0, "No legacy controls executed");
	assert.ok(
		controls.every((test) => test.status === "passed"),
		"Legacy controls not all GREEN",
	);
});
check(() => {
	for (const title of [
		"HOME ordinary request accepts one real reply and rejects a second",
		"C-PRI-14 HOME reader uses verified existing task priority",
		"C-DP3-1 legacy passive alone does not start a turn",
		"C-DP3-2 real boundary limits passive packet to twenty and retains overflow",
		"U12 real boundary reattaches an unlanded packet after interrupted preparation",
	])
		assert.ok(
			executed.some((t) => t.title === title && ["passed", "failed"].includes(t.status)),
			`Missing phase assertion: ${title}`,
		);
});
const report = {
	phase: "HOME first increment; full279 explicitly not claimed",
	deferred,
	baseline,
	head: git("rev-parse", "HEAD").toString().trim(),
	complete: failures.length === 0,
	coverage,
	boundaryCount,
	twins,
	migration,
	controls,
	originalHashes,
	newHashes,
	failures,
};
mkdirSync(evidence, { recursive: true });
// Evidence never contains fixture payloads or model inputs, only IDs/counts/digests.
writeFileSync(resolve(evidence, "coverage-verification.json"), JSON.stringify(report, null, 2) + "\n");
writeFileSync(
	resolve(evidence, "assertions.sha256"),
	Object.entries({ ...originalHashes, ...newHashes })
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([file, digest]) => `${digest}  ${file}`)
		.join("\n") + "\n",
);
console.log(
	JSON.stringify({
		complete: report.complete,
		mapped: coverage.length,
		boundaryCount,
		twins,
		ret4: migration.length,
		controls: controls.length,
		failures: failures.length,
	}),
);
process.exitCode = report.complete ? 0 : 1;
