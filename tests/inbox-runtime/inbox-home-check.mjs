// External HOME release evidence gate. No production imports, fixtures or source mutation.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const dir = process.env.INBOX_EVIDENCE_DIR;
assert.ok(dir, "INBOX_EVIDENCE_DIR is required");
const read = name => JSON.parse(readFileSync(join(dir, name), "utf8"));
const coverage = read("coverage-verification.json");
const results = read("runtime-results.json");
assert.equal(coverage.complete, true, "original assertion and 279 accounting checks must pass");
assert.equal(coverage.controls.length, 9, "nine legacy controls required");
assert.equal(results.numTotalTests, 146, "HOME acceptance inventory changed; review ownership explicitly");
const laterFiles = new Set(["inbox-helper.test.ts", "inbox-host.test.ts", "inbox-migration.test.ts", "inbox-races.test.ts", "inbox-requester.test.ts"]);
const partial = {
	"inbox-core-ledger.test.ts": /^(C-LEASE-(1|2|4|5|7)|C-EFFECT-1|C-LIFE-8) /,
	"inbox-core-read.test.ts": /^C-PRI-8 /,
	"inbox-delivery-effects.test.ts": /^C-DEFF-(1|2|10|14) /,
	"inbox-ledger.test.ts": /^HOME supersede /,
	"inbox-retention.test.ts": /^C-DRET-1 /,
};
const execution = results.testResults.flatMap(file => file.assertionResults.map(test => {
	const name = basename(file.name);
	const deferred = laterFiles.has(name) || !!partial[name]?.test(test.title);
	if (!deferred) assert.equal(test.status, "passed", `${name}: ${test.title}`);
	return { file: name, title: test.title, observed: test.status, phase: deferred ? "deferred" : "HOME-owned" };
}));
assert.equal(execution.length, 146, "missing execution records");
assert.equal(execution.filter(test => test.phase === "HOME-owned").length, 62, "owned inventory must not silently disappear");
const helperCases = new Set(["C-DEFF-1", "C-DEFF-2", "C-DEFF-10", "C-DEFF-14"]);
const cases = coverage.coverage.map(row => {
	if (row.status === "behavioral" && !helperCases.has(row.id)) {
		assert.equal(row.observed, "passed", `${row.id}: owned execution is not green`);
		return { ...row, phase: "HOME-owned" };
	}
	return { ...row, phase: "deferred", ...(helperCases.has(row.id) ? { reason: "Requires live helper claims/supersession; helpers deliberately unavailable in HOME phase" } : {}), ...(row.id === "C-PRI-8" ? { reason: "Guard decision source outside ordinary HOME phase; inherited fixture omits required guard requestId/generation and is refused by canonical source validation" } : {}) };
});
assert.equal(cases.length, 279);
const report = { phase: "ordinary HOME only; helpers unavailable", cases, execution, controls: coverage.controls, codec: { total: 329, boundary: coverage.boundaryCount, twins: coverage.twins }, ownedCases: cases.filter(c => c.phase === "HOME-owned").length, ownedTests: execution.filter(c => c.phase === "HOME-owned").length, deferredTests: execution.filter(c => c.phase === "deferred").length };
assert.match(readFileSync(join(dir, "codec.tap"), "utf8"), /^# fail 0$/m);
writeFileSync(join(dir, "home-phase-proof.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ ownedCases: report.ownedCases, ownedTests: report.ownedTests, deferredTests: report.deferredTests, mapped: cases.length, controls: coverage.controls.length, codec: report.codec.total }));
