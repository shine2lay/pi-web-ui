import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { cases } from "./cases.mjs";
import { requirements } from "./requirements.mjs";
import { compare, corpusBinding, git, requireSealed, runAcceptance, validateCorpus, verifyPins } from "./harness.mjs";
import { runPreviousReaderCases } from "./previous-reader.mjs";

requireSealed();
const ok = (condition, code) => assert.equal(Boolean(condition), true, code); // No payload diffs.
let cleanControls = 0;
let brokenControls = 0;
let priorReaderResult = null;
function paths(value, prefix = []) {
	return Object.entries(value).flatMap(([key, child]) => child && typeof child === "object" && !Array.isArray(child)
		? paths(child, [...prefix, key]) : [[...prefix, key]]);
}
function change(value) {
	if (typeof value === "number") return value + 1;
	if (typeof value === "boolean") return !value;
	if (Array.isArray(value)) return [...value, "broken-control"];
	return "broken-control";
}

test("V seal, frozen contract and actual previous-source pins", () => {
	ok(verifyPins().state === "PASS", "V_PINS_FAILED");
});
test("V ownership: final tracked and untracked diff stays inside assigned directory", () => {
	const paths = [...git(["diff", "--name-only", "HEAD"]).split("\n"), ...git(["ls-files", "--others", "--exclude-standard"]).split("\n")].filter(Boolean);
	ok(paths.every((path) => path.startsWith("tests/role-message-guard-acceptance/") && !path.includes("../")), "V_OUTSIDE_OWNERSHIP");
	ok(!paths.includes("harness.mjs"), "V_ROOT_HARNESS_REMAINED");
});
test("V corpus has complete explicit coverage and mixed positive/negative outcomes", () => {
	const count = validateCorpus();
	ok(count.cases > 200 && count.requirements === requirements.length && count.assertions >= count.cases, "V_CORPUS_INCOMPLETE");
	ok(Object.isFrozen(cases) && Object.isFrozen(cases[0].steps[0].expected), "V_GOLDEN_NOT_FROZEN");
});
for (const scenario of cases) {
	test(`V comparator known clean/broken metadata: ${scenario.id}`, () => {
		for (const step of scenario.steps) {
			// These are comparator self-controls ONLY, not fabricated native candidate passes.
			const clean = structuredClone(step.expected);
			ok(compare(step.expected, clean).pass, "V_COMPARATOR_REJECTS_CLEAN_CONTROL");
			cleanControls++;
			for (const path of paths(step.expected)) {
				const broken = structuredClone(clean);
				const key = path.at(-1);
				const parent = path.slice(0, -1).reduce((node, part) => node[part], broken);
				parent[key] = change(parent[key]);
				ok(!compare(step.expected, broken).pass, "V_COMPARATOR_ACCEPTS_MUTANT_CONTROL");
				brokenControls++;
				delete parent[key];
				ok(!compare(step.expected, broken).pass, "V_COMPARATOR_ACCEPTS_MISSING_OBSERVATION");
				brokenControls++;
			}
		}
	});
}
test("V all-reject/all-accept/empty/extra-effects controls are not vacuous success", () => {
	const positive = cases.find((c) => c.steps[0].expected.state === "accepted").steps[0].expected;
	const negative = cases.find((c) => c.steps[0].expected.state === "blocked").steps[0].expected;
	ok(!compare(positive, { ...structuredClone(positive), state: "blocked" }).pass, "V_ALL_REJECT_PASSES");
	ok(!compare(negative, { ...structuredClone(negative), state: "accepted" }).pass, "V_ALL_ACCEPT_PASSES");
	ok(!compare(positive, {}).pass, "V_EMPTY_OUTPUT_PASSES");
	const extra = structuredClone(positive);
	extra.effects.unmeasuredSideEffect = 1;
	ok(!compare(positive, extra).pass, "V_EXTRA_EFFECT_PASSES");
});
test("V unbound and invalid native adapters are NOT RUN, never skipped-green", async () => {
	for (const adapter of [null, { mode: "fixture_only", open: () => { throw new Error("must-not-call"); } }]) {
		const report = await runAcceptance(adapter);
		ok(report.state === "NOT RUN" && report.passed === 0 && report.failed === 0 && report.notRun === cases.length && report.qualified === false, "V_MISSING_ADAPTER_GREEN");
		ok(report.results.every((row) => row.state === "NOT RUN") && report.traceability.every((row) => row.cases.length > 0), "V_MISSING_ADAPTER_INCOMPLETE");
	}
});
test("V actual pinned previous reader: compatibility controls, hazards, both seventh-hop refusals", async () => {
	const result = await runPreviousReaderCases();
	priorReaderResult = result;
	ok(result.state === "PASS" && result.candidateCompatibility === "NOT RUN", "V_OLD_READER_FAILED");
	ok(result.results.filter((row) => row.hazard).length === 2, "V_BASELINE_HAZARDS_MISSING");
	ok(result.results.filter((row) => row.id.startsWith("old-counterfactual-")).length === 2, "V_COUNTERFACTUALS_MISSING");
	ok(Object.keys(result.closure).includes("server/role-messages.ts"), "V_OLD_CLOSURE_MISSING");
});
test("V comparator counts (NOT native acceptance)", () => {
	ok(cleanControls > 200 && brokenControls > cleanControls * 20, "V_TOO_FEW_CONTROLS");
	const counts = validateCorpus();
	ok(cleanControls === counts.assertions && priorReaderResult?.state === "PASS", "V_LOCAL_STAGE_INCOMPLETE");
	const summary = { kind: "comparator-self-controls-only", cleanControls, brokenControls, nativeAcceptance: "NOT RUN" };
	if (process.env.V_ACCEPTANCE_LOCAL_REPORT) {
		const file = resolve(process.env.V_ACCEPTANCE_LOCAL_REPORT);
		const allowed = "/home/shinelay/company-lab/shared/role-message-approval-plan-2026-10-12/split/acceptance/";
		ok(file.startsWith(allowed) && file.endsWith(".json") && `${realpathSync(dirname(file))}/`.startsWith(allowed), "V_LOCAL_REPORT_PATH_INVALID");
		writeFileSync(file, `${JSON.stringify({ state: "PASS", qualified: false, ...counts, ...summary, binding: corpusBinding(), previousReader: priorReaderResult }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	}
	console.log(JSON.stringify(summary));
});
