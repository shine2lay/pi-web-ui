import { realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { repository, requireSealed, runAcceptance, verifyPins } from "./harness.mjs";

// Opt-in runner. Never discovered by Vitest's tests/unit/**/*.test.ts or root smoke scripts.
// Without #122's bound actual native adapter this exits 2, not a skipped-green test.
try {
	requireSealed();
	const { values } = parseArgs({ options: {
		adapter: { type: "string" }, parents: { type: "string" }, out: { type: "string" }, plan: { type: "boolean" },
	} });
	if (values.plan && values.adapter) throw new Error("V_PLAN_CANNOT_EXECUTE_ADAPTER");
	verifyPins(values.parents);
	let adapter = null;
	if (values.adapter) {
		const file = realpathSync(resolve(values.adapter));
		if (!file.startsWith(`${realpathSync(repository)}/tests/`)) throw new Error("V_ADAPTER_MUST_BE_REPOSITORY_TEST_BINDING");
		adapter = (await import(pathToFileURL(file).href)).default;
	}
	const report = await runAcceptance(adapter);
	if (values.out) {
		const file = resolve(values.out);
		const evidenceRoot = "/home/shinelay/company-lab/shared/role-message-approval-plan-2026-10-12/split/";
		if (!file.endsWith(".json") || !(file.startsWith(evidenceRoot) || file.startsWith(`${process.env.PI_SEALED_ROOT}/`))) throw new Error("V_REPORT_PATH_INVALID");
		const parent = realpathSync(dirname(file));
		if (!(parent.startsWith(evidenceRoot) || parent.startsWith(`${realpathSync(process.env.PI_SEALED_ROOT)}/`))) throw new Error("V_REPORT_PATH_ESCAPE");
		writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 }); // No overwriting prior receipts.
		console.log(JSON.stringify({ state: report.state, cases: report.cases, passed: report.passed, failed: report.failed, notRun: report.notRun, qualified: false }));
	} else console.log(JSON.stringify(report, null, 2));
	process.exitCode = report.state === "PASS" ? 0 : report.state === "FAIL" ? 1 : 2;
} catch {
	console.error("V_RUNNER_FAILED_REDACTED"); // Adapter errors may contain payloads. Never render them.
	process.exitCode = 1;
}
