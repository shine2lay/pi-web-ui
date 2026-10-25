import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { METER_WORKER_RESOURCE_LIMITS } from "../../server/usage-accounting-meter-contract.js";
import { newPassInventory, scanPassInventory } from "../../server/usage-accounting-pass-scan.js";
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});
function root(): string {
	const dir = mkdtempSync(join(tmpdir(), "usage-pass-scan-"));
	dirs.push(dir);
	return dir;
}
function file(dir: string, name: string, at = "2026-10-21T18:00:00.000Z"): void {
	const path = join(dir, name);
	writeFileSync(path, "synthetic non-JSON: no payload should ever be read\n");
	utimesSync(path, new Date(at), new Date(at));
}
let bundled: Promise<string> | undefined;
function fixture(
	root: string,
	extra: { temper?: string[]; cap?: number; stats?: number } = {},
): Promise<{
	units: number;
	maxStats: number;
	count: number;
	complete: boolean;
	cap: boolean;
	faults: string[];
	names: string[];
}> {
	bundled ??= build({
		entryPoints: [fileURLToPath(new URL("./usage-accounting-pass-scan-fixture.ts", import.meta.url))],
		bundle: true,
		platform: "node",
		target: "node22",
		format: "cjs",
		write: false,
		logLevel: "silent",
	}).then((b) => b.outputFiles![0].text);
	return bundled.then(
		(code) =>
			new Promise((done, fail) => {
				const worker = new Worker(code, {
					eval: true,
					workerData: { root, temper: extra.temper ?? [], cap: extra.cap ?? 4096, stats: extra.stats ?? 65536 },
					resourceLimits: { ...METER_WORKER_RESOURCE_LIMITS },
				});
				worker.once("message", done);
				worker.once("error", fail);
				worker.once("exit", (code) => {
					if (code) fail(new Error(`scan-fixture-exit:${code}`));
				});
			}),
	);
}
it("refuses main-thread scanning before any I/O", () => {
	expect(() =>
		scanPassInventory(newPassInventory("2026-10-19"), {
			roots: ["/never-open"],
			temperRoots: [],
			asOf: "2026-10-23T21:00:00.000Z",
		}),
	).toThrow("usage-pass-worker-required");
});
it("resumes the entire stat-only walk (including root checks) within a two-stat budget", async () => {
	const dir = root();
	mkdirSync(join(dir, "nested"));
	file(dir, "now.jsonl");
	file(join(dir, "nested"), "second.jsonl");
	file(dir, "old.jsonl", "2026-10-12T07:00:00.000Z");
	file(dir, "future.jsonl", "2026-10-26T07:00:00.000Z");
	file(dir, "ignored.txt");
	const r = await fixture(dir, { stats: 2 });
	expect(r.maxStats).toBeLessThanOrEqual(2);
	expect(r.units).toBeGreaterThan(2);
	expect(r.complete).toBe(true);
	expect(r.names).toEqual(["nested/second.jsonl", "now.jsonl"]);
	const source = readFileSync(new URL("../../server/usage-accounting-pass-scan.ts", import.meta.url), "utf8");
	expect(source).not.toMatch(/\b(readFileSync|readFile|createReadStream)\s*\(/);
	// Dir.readSync() returns directory entries; it is not fs.readSync() of a file payload.
	const fsImports = source.match(/import\s*\{([^}]+)\}\s*from ["']node:fs["']/)?.[1];
	expect(fsImports).toBeDefined();
	expect(fsImports).not.toMatch(/\breadSync\b/);
});
it("enforces a cumulative 4096-files/week cap without silent completeness", async () => {
	const dir = root();
	for (let i = 0; i < 4097; i++) file(dir, `${i}.jsonl`);
	const r = await fixture(dir);
	expect(r.count).toBe(4096);
	expect(r.cap).toBe(true);
	expect(r.complete).toBe(false);
	expect(r.faults).toContain("file-cap");
}, 30000);
it("excludes only explicit native Temper roots, not titles or worker-like filenames", async () => {
	const dir = root(),
		temper = join(dir, "native-owned");
	mkdirSync(temper);
	file(temper, "charge.jsonl");
	file(dir, "pi-worker.jsonl");
	const r = await fixture(dir, { temper: [temper] });
	expect(r.names).toEqual(["pi-worker.jsonl"]);
	expect(r.complete).toBe(true);
});
it("does not follow a symlink and does not silently call that inventory complete", async () => {
	const dir = root(),
		outside = root();
	file(outside, "outside.jsonl");
	symlinkSync(outside, join(dir, "link"));
	file(dir, "kept.jsonl");
	const r = await fixture(dir);
	expect(r.names).toEqual(["kept.jsonl"]);
	expect(r.complete).toBe(false);
	expect(r.faults).toContain("unsafe-source");
});
