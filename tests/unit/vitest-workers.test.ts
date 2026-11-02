import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CliOptions } from "vitest/node";
import { localVitestWorkers } from "../../scripts/vitest-workers.mjs";
import { HANG_GUARD_MS } from "./load-independent.js";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const invalid = [
	"",
	"0",
	"11",
	"100",
	"01",
	"010",
	"+1",
	"-1",
	"1.0",
	"1e0",
	"10%",
	"NaN",
	"Infinity",
	" ",
	" 1",
	"1 ",
	"\t1",
	"1\n",
	"\n1",
	"10\n",
	"١",
	"１０",
	"1; echo private",
	"$(echo private)",
];

describe("local Vitest worker selection", () => {
	it("defaults to ten only when CI and the override are absent", () => {
		expect(localVitestWorkers({})).toBe(10);
		for (const CI of ["", "0", "false", "1", "true"]) {
			expect(localVitestWorkers({ CI })).toBeUndefined();
		}
	});

	it.each(Array.from({ length: 10 }, (_, i) => String(i + 1)))("accepts canonical %s even in CI", (workers) => {
		for (const env of [{}, { CI: "true" }]) {
			expect(localVitestWorkers({ ...env, VITEST_MAX_WORKERS: workers })).toBe(Number(workers));
		}
	});

	it.each(invalid)("rejects malformed value %# with a redacted error", (value) => {
		for (const env of [{}, { CI: "true" }]) {
			expect(() => localVitestWorkers({ ...env, VITEST_MAX_WORKERS: value })).toThrow(
				/^VITEST_MAX_WORKERS must be a canonical integer from 1 to 10$/,
			);
		}
	});
});

/** Resolve configs only: no test collection, server, model, installed queue or user state. */
function resolve(env: NodeJS.ProcessEnv, options: CliOptions = {}) {
	const clean = { ...process.env };
	delete clean.CI;
	for (const key of Object.keys(clean)) if (key.startsWith("VITEST_")) delete clean[key];
	const code = `
		import { createVitest } from "vitest/node";
		const ctx = await createVitest({ watch: false, root: process.cwd(), ...${JSON.stringify(options)} });
		try {
			console.log(JSON.stringify({ maxWorkers: ctx.config.maxWorkers ?? null,
				fileParallelism: ctx.config.fileParallelism, isolate: ctx.config.isolate }));
		} finally { await ctx.close(); }
	`;
	return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
		cwd: repo,
		env: { ...clean, ...env },
		encoding: "utf8",
		timeout: HANG_GUARD_MS,
	});
}

function resolved(env: NodeJS.ProcessEnv, options: CliOptions = {}) {
	const r = resolve(env, options);
	expect(r.error).toBeUndefined();
	expect(r.status, r.stderr).toBe(0);
	return JSON.parse(r.stdout.trim().split("\n").pop() ?? "");
}

describe("installed Vitest configuration", () => {
	it("both npm aliases use the normal config, which selects exactly ten locally", () => {
		const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
		expect(pkg.scripts.test).toBe("vitest run");
		expect(pkg.scripts["test:unit"]).toBe("vitest run");
		expect(resolved({})).toEqual({ maxWorkers: 10, isolate: true });
	});

	it.each(["", "0", "false", "1", "true"])("CI=%s keeps the baseline with no worker setting", (CI) => {
		const baseline = resolved({ CI }, { config: false });
		expect(baseline.maxWorkers).toBeNull();
		expect(resolved({ CI })).toEqual(baseline);
	});

	it.each(["1", "2", "10"])("explicit %s wins locally and in CI", (workers) => {
		for (const env of [{}, { CI: "true" }]) {
			expect(resolved({ ...env, VITEST_MAX_WORKERS: workers }).maxWorkers).toBe(Number(workers));
		}
	});

	it("keeps the existing CLI option and environment precedence", () => {
		expect(resolved({}, { maxWorkers: 2 }).maxWorkers).toBe(2);
		for (const env of [{ VITEST_MAX_WORKERS: "1" }, { CI: "true", VITEST_MAX_WORKERS: "1" }]) {
			const baseline = resolved(env, { config: false, maxWorkers: 2 });
			expect(baseline.maxWorkers).toBe(1);
			expect(resolved(env, { maxWorkers: 2 })).toEqual(baseline);
		}
	});

	it.each(["", "11", "2extra", "10\n"])("rejects malformed environment before Vitest's parseInt: %#", (value) => {
		const r = resolve({ VITEST_MAX_WORKERS: value });
		expect(r.error).toBeUndefined();
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain("VITEST_MAX_WORKERS must be a canonical integer from 1 to 10");
	});

	it("does not impose the normal default on the independent serial coupled proof", () => {
		const source = mkdtempSync(join(tmpdir(), "worker-config-queue-"));
		try {
			// Only the source-path validator reads these; no queue code or SDK session is executed.
			writeFileSync(join(source, ".git"), "gitdir: unused-config-fixture\n");
			writeFileSync(join(source, "package.json"), JSON.stringify({ name: "pi-work-management" }));
			const coupled = resolved({ PI_QUEUE_NATIVE_SOURCE: source }, { config: "vitest.question-coupled.config.ts" });
			expect(coupled).toEqual({ maxWorkers: 1, fileParallelism: false, isolate: true });
		} finally {
			rmSync(source, { recursive: true, force: true });
		}
	});
});
