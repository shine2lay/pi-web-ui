import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { pins } from "./pins.mjs";
import { cases, zeroEffects } from "./cases.mjs";
import { requirements } from "./requirements.mjs";

export const directory = dirname(fileURLToPath(import.meta.url));
export const repository = resolve(directory, "../..");
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code) => { throw new Error(code); }; // Never interpolate candidate errors or bodies.
export function requireSealed() {
	if (process.env.PI_SEALED !== "1" || process.env.PI_SEALED_FENCE !== "enforce" || !process.env.PI_SEALED_ROOT) fail("V_SEAL_REQUIRED");
	const root = realpathSync(process.env.PI_SEALED_ROOT);
	for (const name of ["HOME", "TMPDIR", "PI_WEB_DATA_DIR", "PI_CODING_AGENT_DIR"]) {
		if (!process.env[name] || !realpathSync(process.env[name]).startsWith(`${root}/`)) fail("V_SEAL_PATH_INVALID");
	}
}
export function git(args) {
	return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
}
export function verifyPins(parentDirectory) {
	if (sha256(readFileSync(resolve(repository, pins.contractPath))) !== pins.contractSha256) fail("V_CONTRACT_PIN_MISMATCH");
	if (git(["rev-parse", `${pins.contractCommit}^{tree}`]).trim() !== pins.contractTree) fail("V_CONTRACT_TREE_MISMATCH");
	if (sha256(git(["show", `${pins.contractCommit}:${pins.contractPath}`])) !== pins.contractSha256) fail("V_CONTRACT_COMMIT_MISMATCH");
	if (git(["rev-parse", `${pins.previousCommit}:${pins.previousReaderPath}`]).trim() !== pins.previousReaderBlob) fail("V_PREVIOUS_BLOB_MISMATCH");
	if (sha256(git(["show", `${pins.previousCommit}:${pins.previousReaderPath}`])) !== pins.previousReaderSha256) fail("V_PREVIOUS_SOURCE_MISMATCH");
	if (parentDirectory) {
		for (const [path, hash] of Object.entries(pins.parents)) {
			const text = readFileSync(resolve(parentDirectory, path), "utf8");
			if (sha256(text) !== hash) fail("V_PARENT_PIN_MISMATCH");
			for (const requirement of requirements.filter((item) => item.parent === path)) {
				if (!text.includes(`## ${requirement.section}\n`)) fail("V_PARENT_ANCHOR_MISSING");
			}
		}
	}
	return { state: "PASS", version: pins.version, parentsVerified: !!parentDirectory };
}
// Hash both assertions and the bytes of every owned executable/document. No result is
// bound to only scenario ids. #122 must preserve these hashes or obtain a new V review.
export function corpusBinding() {
	const files = ["pins.mjs", "requirements.mjs", "cases.mjs", "harness.mjs", "previous-reader.mjs", "local.test.mjs", "run.mjs", "README.md"];
	const hashes = Object.fromEntries(files.map((name) => [name, sha256(readFileSync(resolve(directory, name)))]));
	return { version: pins.version, contractCommit: pins.contractCommit, contractSha256: pins.contractSha256,
		policyDocumentSha256: pins.parents["PLAN-v2.md"], caseSha256: sha256(JSON.stringify(cases)),
		requirementSha256: sha256(JSON.stringify(requirements)), files: hashes, harnessSha256: sha256(JSON.stringify(hashes)) };
}
export function validateCorpus() {
	const ids = new Set();
	const required = new Set(requirements.map((item) => item.id));
	if (required.size !== requirements.length) fail("V_DUPLICATE_REQUIREMENT");
	const covered = new Set();
	for (const scenario of cases) {
		if (!/^[a-zA-Z0-9_-]+$/.test(scenario.id) || ids.has(scenario.id)) fail("V_INVALID_CASE_ID");
		ids.add(scenario.id);
		if (!scenario.needs.length || !scenario.steps.length) fail("V_EMPTY_CASE");
		for (const id of scenario.needs) {
			if (!required.has(id)) fail("V_UNKNOWN_REQUIREMENT");
			covered.add(id);
		}
		for (const step of scenario.steps) {
			if (!step.command?.op || !step.expected?.state || !step.expected.effects) fail("V_MISSING_OBSERVATION");
			if (!isDeepStrictEqual(Object.keys(step.expected.effects), Object.keys(zeroEffects))) fail("V_EFFECT_COVERAGE_INCOMPLETE");
			for (const count of Object.values(step.expected.effects)) if (!Number.isSafeInteger(count) || count < 0) fail("V_BAD_EFFECT_COUNT");
			for (const key of ["actionStarts", "queueStarts", "questionClears", "readerResumes", "judgeResumes", "scopeExpansions", "holdChanges", "fallbacks", "interruptions", "batchingTimers", "prunedActive", "bodyCaptures"]) {
				if (step.expected.effects[key] !== 0) fail("V_FORBIDDEN_EFFECT_EXPECTED");
			}
		}
	}
	if (covered.size !== required.size) fail("V_UNCOVERED_REQUIREMENT");
	if (!cases.some((c) => c.steps.some((s) => s.expected.state === "accepted")) || !cases.some((c) => c.steps.some((s) => s.expected.state === "blocked"))) fail("V_VACUOUS_CORPUS");
	return { cases: cases.length, assertions: cases.reduce((n, c) => n + c.steps.length, 0), requirements: required.size };
}
function missingPaths(expected, actual, path = "") {
	const missing = [];
	for (const [key, value] of Object.entries(expected)) {
		const next = path ? `${path}.${key}` : key;
		if (value && typeof value === "object" && !Array.isArray(value)) {
			if (!actual?.[key] || typeof actual[key] !== "object" || Array.isArray(actual[key])) missing.push(next);
			else missing.push(...missingPaths(value, actual[key], next));
		} else if (!isDeepStrictEqual(value, actual?.[key])) missing.push(next);
	}
	return missing;
}
// Actual output values are intentionally never returned, printed, diffed or serialized.
// The comparator returns only assertion paths chosen by this corpus.
export function compare(expected, actual) {
	const paths = missingPaths(expected, actual);
	if (!actual?.effects || !isDeepStrictEqual(Object.keys(actual.effects).sort(), Object.keys(zeroEffects).sort())) paths.push("effects.shape");
	return { pass: paths.length === 0, mismatches: [...new Set(paths)] };
}
export function traceability(resultRows = []) {
	return requirements.map((requirement) => ({ ...requirement,
		cases: cases.filter((item) => item.needs.includes(requirement.id)).map((item) => ({ id: item.id,
			state: resultRows.find((row) => row.id === item.id)?.state ?? "NOT RUN" })),
	}));
}
function bindingMatches(binding, wanted) {
	return binding?.version === wanted.version && binding.contractCommit === wanted.contractCommit &&
		binding.contractSha256 === wanted.contractSha256 && binding.policyDocumentSha256 === wanted.policyDocumentSha256 &&
		binding.harnessSha256 === wanted.harnessSha256 && binding.caseSha256 === wanted.caseSha256 &&
		binding.requirementSha256 === wanted.requirementSha256;
}
// No mock policy, callback returning "ok", or golden-result adapter is supplied here.
// #122 owns this native binding; a declaration alone is NOT independent native proof.
export async function runAcceptance(adapter = null) {
	requireSealed();
	const counts = validateCorpus();
	const binding = corpusBinding();
	const results = [];
	const valid = adapter && bindingMatches(adapter.binding, binding) && adapter.mode === "sealed_registered_native" &&
		/^[a-f0-9]{40}$/.test(adapter.candidateCommit ?? "") && typeof adapter.open === "function" &&
		typeof adapter.supports === "function" && typeof adapter.evidenceFor === "function";
	for (const scenario of cases) {
		if (!valid) {
			results.push({ id: scenario.id, state: "NOT RUN", reason: adapter ? "native_binding_invalid" : "registered_native_adapter_missing" });
			continue;
		}
		let session;
		try {
			// Evidence references must be native-bound and hashed; missing producer proof
			// leaves protected cases NOT RUN, never a synthetic supported capability.
			const evidence = await adapter.evidenceFor(scenario.area);
			if (!await adapter.supports(scenario.id) || !evidence || evidence.registered !== true ||
				evidence.fixtureOnly !== false || !/^[a-f0-9]{64}$/.test(evidence.sha256 ?? "")) {
				results.push({ id: scenario.id, state: "NOT RUN", reason: "native_capability_or_evidence_missing" });
				continue;
			}
			// Only input goes to the adapter. Expected answers and the needs matrix stay here.
			session = await adapter.open(structuredClone(scenario.input), scenario.id);
			if (!session || typeof session.act !== "function" || typeof session.observe !== "function" || typeof session.close !== "function") fail("V_NATIVE_SESSION_INVALID");
			const steps = [];
			for (const [index, step] of scenario.steps.entries()) {
				await session.act(structuredClone(step.command));
				const observed = await session.observe();
				const match = compare(step.expected, observed?.facts);
				if (!observed?.evidence || observed.evidence.nativePath !== true || observed.evidence.sourceCommit !== adapter.candidateCommit ||
					!/^[a-f0-9]{64}$/.test(observed.evidence.sha256 ?? "")) match.mismatches.push("native_observation_evidence");
				steps.push({ index, state: match.mismatches.length ? "FAIL" : "PASS", mismatches: match.mismatches });
				if (match.mismatches.length) break; // No retry loop or broadened assertion.
			}
			results.push({ id: scenario.id, state: steps.length === scenario.steps.length && steps.every((s) => s.state === "PASS") ? "PASS" : "FAIL", steps, evidenceSha256: evidence.sha256 });
		} catch {
			results.push({ id: scenario.id, state: "FAIL", reason: "adapter_error_redacted" });
		} finally {
			if (session) {
				try { await session.close(); } catch {
					const row = results.at(-1);
					row.state = "FAIL";
					row.reason = "adapter_cleanup_failed_redacted";
				}
			}
		}
	}
	const passed = results.filter((row) => row.state === "PASS").length;
	const failed = results.filter((row) => row.state === "FAIL").length;
	const notRun = results.filter((row) => row.state === "NOT RUN").length;
	return { kind: "V-independent-acceptance", ...counts, binding, candidateCommit: valid ? adapter.candidateCommit : null,
		state: failed ? "FAIL" : notRun ? "NOT RUN" : "PASS", qualified: false,
		passed, failed, notRun, results, traceability: traceability(results),
		limits: ["Authoring is not candidate acceptance", "Adapter attestation is not native proof", "#122 alone owns combined qualification and installation"] };
}
