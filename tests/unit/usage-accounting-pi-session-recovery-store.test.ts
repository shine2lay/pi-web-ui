import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { METER_WORKER_RESOURCE_LIMITS } from "../../server/usage-accounting-meter-contract.js";
let bundle: Promise<string> | undefined;
it.each([false, true])(
	"persists one unknown gap and restart-safe skip progress with B2's checkpoint (crash=%s)",
	async (crash) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-recovery-checkpoint-")),
			file = join(dir, "synthetic.jsonl");
		const from = "2026-10-19T07:00:00.000Z";
		const entry = (id: string) =>
			JSON.stringify({
				type: "message",
				id,
				timestamp: from,
				message: {
					role: "assistant",
					provider: "p",
					model: "m",
					responseId: id,
					usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } },
				},
			}) + "\n";
		writeFileSync(
			file,
			JSON.stringify({ type: "session", version: 3, id: "synthetic", timestamp: from }) +
				"\n" +
				entry("before") +
				"x".repeat(5 * 1024 * 1024) +
				"\n" +
				entry("after"),
		);
		bundle ??= build({
			entryPoints: [fileURLToPath(new URL("./usage-accounting-pi-session-recovery-store-fixture.ts", import.meta.url))],
			bundle: true,
			platform: "node",
			target: "node22",
			format: "cjs",
			write: false,
			logLevel: "silent",
		}).then((b) => b.outputFiles![0].text);
		let worker: Worker | undefined;
		try {
			const code = await bundle;
			const result = await new Promise<Record<string, unknown>>((done, fail) => {
				worker = new Worker(code, {
					eval: true,
					workerData: { dir, file, crash, lease: new SharedArrayBuffer(4) },
					resourceLimits: { ...METER_WORKER_RESOURCE_LIMITS },
				});
				worker.once("message", done);
				worker.once("error", fail);
				worker.once("exit", (code) => {
					if (code) fail(new Error(`recovery-checkpoint-exit:${code}`));
				});
			});
			expect(result).toMatchObject({
				records: 3,
				originals: 2,
				gaps: 1,
				prices: ["0.1", "0.1"],
				gapRemainsUnknown: true,
				repeated: 0,
				repeatedEof: true,
				cursorKind: "pi1",
			});
			expect(result.iterations as number).toBeGreaterThan(10);
		} finally {
			await worker?.terminate();
			rmSync(dir, { force: true, recursive: true });
		}
	},
	30000,
);
