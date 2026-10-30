// Ops #643 (H-USAGE-CPU-CLOCK-1, docs/gate-time.md "Found on the way"): usage accounting's two work budgets count the
// work its code did, not the time that passed. Before #643 the W1 index's slice (server/usage-accounting-store.ts)
// and the pass's PASS_LIMITS.workMs (server/usage-accounting-pass.ts) read performance.now(): on a busy machine the
// wall clock runs on while the thread gets little CPU, so a slice ended having done a fraction of its work (and the
// index refused a healthy unit with store-capacity). Each case runs the same work quiet and under simulated
// contention (tests/unit/usage-accounting-cpu-clock-fixture.ts: the thread gets a twentieth of a core, in turns) in one
// Worker, alternating, and checks the work per slice and the end state are the same within TOLERANCE.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { HANG_GUARD_MS } from "./load-independent.js";
import { METER_LIMITS, METER_WORKER_RESOURCE_LIMITS } from "../../server/usage-accounting-meter-contract.js";

/** Contention simulated: the thread gets 1/DILATION of a core, in turns of 10 ms of CPU and 190 ms of waiting. */
const DILATION = 20;
/** Work per slice, contended over quiet, may differ by this factor either way: the same thread does both runs in
 *  turns, but it may move between this machine's little and big cores (1024/718 = 1.43 in speed) and a GC pause lands
 *  in one run or the other. Before #643 the contended run did about 1/DILATION of the quiet run's work per slice. */
const TOLERANCE = 1.5;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});
let code: Promise<string> | null = null;
// biome-ignore lint/suspicious/noExplicitAny: fixture results are JSON shaped per case
async function run(name: "store" | "pass"): Promise<any> {
	code ??= build({
		entryPoints: [fileURLToPath(new URL("./usage-accounting-cpu-clock-fixture.ts", import.meta.url))],
		bundle: true,
		platform: "node",
		target: "node22",
		format: "cjs",
		write: false,
		logLevel: "silent",
	}).then((r) => r.outputFiles![0]!.text);
	const dir = mkdtempSync(join(tmpdir(), "usage-cpu-clock-"));
	dirs.push(dir);
	const text = await code;
	return new Promise((resolve, reject) => {
		const worker = new Worker(text, {
			eval: true,
			workerData: { name, dir, dilation: DILATION },
			resourceLimits: { ...METER_WORKER_RESOURCE_LIMITS },
		});
		worker.once("message", (m: { ok: boolean; result?: unknown; error?: string }) => {
			void worker.terminate();
			if (m.ok) resolve(m.result);
			else reject(new Error(m.error));
		});
		worker.once("error", reject);
	});
}
const within = (contended: number, quiet: number) => {
	expect(contended).toBeLessThanOrEqual(quiet * TOLERANCE);
	expect(contended).toBeGreaterThanOrEqual(quiet / TOLERANCE);
};

describe("usage accounting work budgets count CPU work, not wall-clock (Ops #643)", { timeout: HANG_GUARD_MS }, () => {
	it("W1 index: a busy machine neither refuses a healthy unit nor slices it finer", async () => {
		const r = await run("store");
		process.stdout.write(`usage-cpu-clock store ${JSON.stringify(r)}\n`);
		// Before #643 the contended run failed a healthy write with store-capacity (its 100 ms unit guard read
		// wall-clock), or yielded on the clock long before a 256-node quantum.
		expect(r.contended.error).toBeNull();
		expect(r.quiet.error).toBeNull();
		expect(r.contended.steps).toBe(r.quiet.steps);
		expect(r.contended.entries).toBe(4096);
		expect(r.contended.gets).toBe(r.quiet.gets);
		within(r.contended.total, r.quiet.total);
		expect(r.contended.maxWorkMs).toBeLessThanOrEqual(METER_LIMITS.unitWorkMs);
	});
	it("pass: a busy machine does the same work per pass and reaches the same week", async () => {
		const r = await run("pass");
		process.stdout.write(`usage-cpu-clock pass ${JSON.stringify(r)}\n`);
		expect(r.quiet.done).toBe(true);
		// Before #643 each contended pass read about 1/20 of the quiet one, so it ran into its cap of 4x the passes.
		expect(r.contended.done).toBe(true);
		expect(r.contended.final).toBe(r.quiet.final);
		expect(r.contended.rows).toBe(r.quiet.rows);
		expect(r.contended.digest).toBe(r.quiet.digest);
		within(r.contended.passes, r.quiet.passes);
		within(r.contended.medianBytesPerPass, r.quiet.medianBytesPerPass);
	});
});
