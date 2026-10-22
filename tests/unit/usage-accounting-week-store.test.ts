// Ops #422 (B2, docs/usage-accounting-week-store.md): the per-week usage store of design B, tested stage by stage on
// fixed synthetic cases (rule 16). Hypothesis H-B2: a reload reads one week's records only, so it takes at most 1 s
// at 250,000 records (B_LARGE_CASE=1 measures it); it is wrong if a reload takes longer, or if a crash point loses a
// committed record (Architecture M4: checkpoint is the commit point). Each case runs the real store in a Worker with W0's resource limits on a temporary folder
// (tests/unit/usage-accounting-week-store-fixture.ts); nothing is mocked but the clock and the named crash points, and
// no chat file is read.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { METER_WORKER_RESOURCE_LIMITS } from "../../server/usage-accounting-meter-contract.js";
import {
	USAGE_WEEK_DIRECTORY,
	UsageWeekStore,
	UsageWeekStoreError,
	usageWeekBounds,
	usageWeekOf,
} from "../../server/usage-accounting-week-store.js";

const roots: string[] = [];
const workers = new Set<Worker>();
afterEach(async () => {
	await Promise.all([...workers].map((worker) => worker.terminate()));
	workers.clear();
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixtureDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "usage-week-store-"));
	roots.push(dir);
	return dir;
}

// The esbuild Worker pattern of the W0 and W1 tests; the bundle stays in memory, nothing is written to the checkout.
let bundle: Promise<string> | undefined;
function bundledWorker(): Promise<string> {
	return (bundle ??= (async () => {
		const compiled = await build({
			entryPoints: [fileURLToPath(new URL("./usage-accounting-week-store-fixture.ts", import.meta.url))],
			bundle: true,
			platform: "node",
			target: "node22",
			format: "cjs",
			write: false,
			logLevel: "silent",
		});
		if (compiled.outputFiles?.length !== 1) throw new Error("usage-week-fixture-bundle");
		return compiled.outputFiles[0].text;
	})());
}
async function runCase(
	caseName: string,
	extra: Record<string, unknown> = {},
	dir = fixtureDir(),
	lease = new SharedArrayBuffer(4),
): Promise<unknown> {
	const worker = new Worker(await bundledWorker(), {
		eval: true,
		resourceLimits: { ...METER_WORKER_RESOURCE_LIMITS },
		workerData: { caseName, dir, lease, extra },
	});
	workers.add(worker);
	return new Promise<unknown>((done, fail) => {
		let settled = false;
		worker.once("error", fail);
		worker.once("message", (message) => {
			settled = true;
			if (message?.kind === "result") done(message.value);
			else fail(new Error(String(message?.code ?? "usage-week-fixture-message")));
		});
		worker.once("exit", (code) => {
			if (!settled) fail(new Error(`usage-week-fixture-exit:${code}`));
		});
	});
}
const unavailable = (code: string) => ({ state: "unavailable", week: "2026-10-19", code });

describe("usage-accounting week store: ownership, files and modes", () => {
	it("refuses a main-thread open without creating its folder or taking the lease", () => {
		const dir = fixtureDir(),
			lease = new SharedArrayBuffer(4);
		const s = UsageWeekStore.open({ dataDir: dir, lease });
		try {
			expect(s.status()).toEqual({ state: "unavailable", code: "worker-required" });
			expect(existsSync(join(dir, USAGE_WEEK_DIRECTORY))).toBe(false);
			expect(Atomics.load(new Int32Array(lease), 0)).toBe(0);
		} finally {
			s.close();
		}
	});
	it("appends, certifies and reloads a week in a 0700 folder of 0600 files (checked by stat)", async () => {
		expect(await runCase("lifecycle")).toEqual({
			root: 0o700,
			files: {
				lock: 0o600,
				"week-2026-10-19.checkpoint": 0o600,
				"week-2026-10-19.log": 0o600,
				"week-2026-10-19.receipts": 0o600,
			},
		});
	});
	it("lets one writer in, and a second waits without touching the first one's lease or lock", async () => {
		expect(await runCase("ownership")).toBe("ok");
	});
	it.each([
		["folder-link", null, "unsafe-path"],
		["folder-mode", null, "permission-denied"],
		["data-mode", null, "permission-denied"],
		["file-link", "unsafe-path", "unsafe-path"],
		["file-mode", "permission-denied", "permission-denied"],
		["hard-link", "unsafe-path", "unsafe-path"],
	])("refuses a %s, stops the whole store and writes nothing through it", async (variant, reload, code) => {
		expect(await runCase("unsafe", { variant })).toEqual({ reload, status: { state: "unavailable", code } });
	});
	it("refuses bad records, cursors and calls with nothing written, and keeps the week's caps", async () => {
		expect(await runCase("refusals")).toBe("ok");
	});
	it("skips a key it already holds, so a re-read after a crash appends nothing twice", async () => {
		expect(await runCase("duplicates")).toBe("ok");
	});
});

describe("usage-accounting week store: every crash point keeps the committed records", () => {
	it.each([
		["partial", { kept: 2, wholeLinesDropped: 0, tornBytes: 100 }],
		["one-and-a-half", { kept: 2, wholeLinesDropped: 1, tornBytes: 50 }],
		["no-checkpoint", { kept: 0, wholeLinesDropped: 2, tornBytes: 100 }],
		["zero-fill", { kept: 2, wholeLinesDropped: 0, tornBytes: 4096 }],
	])("cuts back to the checkpoint, then re-reads each record once (%s)", async (variant, result) => {
		expect(await runCase("torn", { variant })).toEqual(result);
	});
	it.each([
		["after-log-sync", 2, false, 0],
		["receipts-write", 2, false, 0],
		["receipts-sync", 2, true, 0],
		["after-receipts-sync", 2, true, 0],
		["checkpoint-write", 2, true, 1],
		["checkpoint-sync", 2, true, 1],
		["checkpoint-rename", 2, true, 1],
		["after-checkpoint-rename", 4, false, 0],
	])("re-read after %s equals the no-crash totals (unknowns too)", async (variant, kept, receiptsDropped, scratch) => {
		expect(await runCase("crashCheckpoint", { variant })).toEqual({ kept, receiptsDropped, scratch });
	});
	it.each([
		["seal-write", 1],
		["seal-sync", 1],
		["seal-rename", 1],
		["after-seal-rename", 0],
	])("seals exactly once across a crash at %s", async (variant, scratch) => {
		expect(await runCase("crashSeal", { variant })).toEqual({ scratch });
	});
	it.each([
		["adjust-write", 0, true],
		["after-adjust-sync", 0, true],
		["checkpoint-rename", 0, true],
		["after-checkpoint-rename", 2, false],
	])("commits all or none of a sealed week's adjustments across %s", async (variant, kept, cut) => {
		expect(await runCase("crashAdjust", { variant })).toEqual({ kept, cut });
	});
});

describe("usage-accounting week store: damage gives unavailable, never zero", () => {
	it.each([
		["log-sha", "log-mismatch", "none"],
		["checkpoint-log-sha", "log-mismatch", "none"],
		["log-short", "log-mismatch", "none"],
		["checkpoint-sha", "checkpoint-corrupt", "none"],
		["log-version", "store-version", "none"],
		["log-missing", "log-missing", "none"],
		["damaged-line", "log-corrupt", "none"],
		["receipts-sha", "receipts-mismatch", "none"],
		["receipts-missing", "receipts-missing", "none"],
		["sealed-sha", "sealed-corrupt", "unavailable"],
		["sealed-keys", "sealed-corrupt", "sealed"],
	])("a %s makes the week unavailable, leaves its bytes and refuses writes", async (variant, code, sealedTotals) => {
		expect(await runCase("mismatch", { variant })).toEqual({ load: unavailable(code), sealedTotals });
	});
	it("moves a damaged week aside, never deleting it, so the week can be rebuilt", async () => {
		expect(await runCase("quarantine")).toBe("ok");
	});
});

describe("usage-accounting week store: W2 receipts and unknown dispositions survive restart", () => {
	it("keeps unverified, unresolved and skipped-byte records partial; counts originals alone", async () => {
		expect(await runCase("unknowns")).toEqual({ original: 1, alias: 1, unverified: 1, unresolved: 1, gap: 1 });
	});
	it("rebuilds W2 first/sameCall readers, including the later alias attachment", async () => {
		expect(await runCase("ledgerReceipts")).toEqual({
			unloaded: {
				dispositions: [],
				faults: ["production-unprovable", "skipped-writes-unobservable", "index-unavailable"],
				receipts: 0,
				cursor: false,
			},
			read1: {
				dispositions: ["original", "unresolved"],
				faults: [
					"production-unprovable",
					"skipped-writes-unobservable",
					"fileless-helper-membership",
					"overlap-unresolved",
				],
				receipts: 2,
				cursor: true,
				committed: { receipts: 2, receiptDuplicates: 0 },
			},
			read2: {
				dispositions: ["duplicate", "alias"],
				faults: ["production-unprovable", "skipped-writes-unobservable", "fileless-helper-membership"],
				receipts: 1,
				cursor: true,
				committed: { receipts: 1, receiptDuplicates: 0 },
			},
			read3: {
				dispositions: ["duplicate", "alias"],
				faults: ["production-unprovable", "skipped-writes-unobservable", "fileless-helper-membership"],
				receipts: 0,
				cursor: true,
				committed: { receipts: 0, receiptDuplicates: 0 },
			},
			refused: ["invalid-receipt", "invalid-receipt"],
		});
	});
});

describe("usage-accounting week store: seal, adjust and delete", () => {
	it("seals exact totals by subject and rate with the key digests; adjustments never change them", async () => {
		expect(await runCase("sealAdjust")).toEqual({ usd: "0.000001140544", originals: 20 });
	});
	it("deletes only a sealed, ended week, and no production code calls deleteWeek", async () => {
		expect(await runCase("deleteWeek")).toBe("ok");
		const repo = fileURLToPath(new URL("../../", import.meta.url));
		const callers: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (!["node_modules", "dist", ".git"].includes(entry.name)) walk(path);
				} else if (/\.(?:[cm]?[jt]s|tsx)$/.test(entry.name)) {
					if (/\.deleteWeek\s*\(|\[\s*["'`]deleteWeek["'`]\s*\]/.test(readFileSync(path, "utf8")))
						callers.push(relative(repo, path));
				}
			}
		};
		for (const top of ["server", "web", "bin", "scripts", "plugins", "plugin-sdk", "extensions"])
			if (existsSync(join(repo, top))) walk(join(repo, top));
		expect(callers).toEqual([]);
	});
});

describe("usage-accounting week store: Pacific weeks across the DST end on 2026-11-01", () => {
	it.each([
		["2026-10-26T06:59:59.999Z", "2026-10-19"],
		["2026-10-26T07:00:00.000Z", "2026-10-26"],
		["2026-11-01T08:59:59.999Z", "2026-10-26"],
		["2026-11-01T09:00:00.000Z", "2026-10-26"],
		["2026-11-02T07:00:00.000Z", "2026-10-26"],
		["2026-11-02T07:59:59.999Z", "2026-10-26"],
		["2026-11-02T08:00:00.000Z", "2026-11-02"],
	])("counts %s in the week of %s", (at, week) => {
		expect(usageWeekOf(at)).toBe(week);
	});
	it("gives the weeks around the change 168, 169 and 168 hours (and 167 at the spring change)", () => {
		expect(usageWeekBounds("2026-10-19")).toEqual({
			start: "2026-10-19T07:00:00.000Z",
			end: "2026-10-26T07:00:00.000Z",
		});
		expect(usageWeekBounds("2026-10-26")).toEqual({
			start: "2026-10-26T07:00:00.000Z",
			end: "2026-11-02T08:00:00.000Z",
		});
		expect(usageWeekBounds("2026-11-02")).toEqual({
			start: "2026-11-02T08:00:00.000Z",
			end: "2026-11-09T08:00:00.000Z",
		});
		const hours = ["2026-10-19", "2026-10-26", "2026-11-02", "2027-03-08"].map((week) => {
			const { start, end } = usageWeekBounds(week);
			return (Date.parse(end) - Date.parse(start)) / 3_600_000;
		});
		expect(hours).toEqual([168, 169, 168, 167]);
	});
	it.each(["2026-10-20", "2026-02-30", "2026-10-19T00:00", "", "../2026-10-19"])("refuses %j as a week", (week) => {
		expect(() => usageWeekBounds(week)).toThrow(UsageWeekStoreError);
	});
	it("files a week's records by its own bounds and seals it only after its 169th hour", async () => {
		expect(await runCase("dst")).toBe("ok");
	});
});

// B_LARGE_CASE=1 (opt-in, minutes of disk work): 250,000 synthetic records, as in W1's W1_LARGE_CASE. The first worker
// appends one week with a receipt per record and checkpoints it, then appends the next week with no checkpoint;
// a second worker, as after a restart, reloads both and seals the first. The numbers go to the doc.
describe.skipIf(process.env.B_LARGE_CASE !== "1")("usage-accounting week store: 250,000 records (H-B2)", () => {
	it(
		"appends, reloads and seals one week; reports H-B2 hit or miss without hiding a timing miss",
		async () => {
			const count = 250_000,
				dir = fixtureDir(),
				lease = new SharedArrayBuffer(4);
			const write = (await runCase("largeWrite", { count }, dir, lease)) as Record<string, number>;
			const load = (await runCase("largeReload", { count }, dir, lease)) as Record<string, unknown>;
			// H-B2 remains 1 s, including a B3-like fold. A miss is a measured hypothesis result, not hidden by
			// removing receipts, reporting a later/warm run, or counting only the proof. Correctness is asserted
			// inside the worker cases; the benchmark reports its timing verdict even on a busy machine.
			const firstReloadMs = (load.reloadFoldMs as number[])[0];
			const measure = {
				count,
				...write,
				...load,
				hB2: firstReloadMs <= 1000 ? "hit" : "miss",
				targetMs: 1000,
				worker: METER_WORKER_RESOURCE_LIMITS,
			};
			process.stdout.write(`B2-WEEK-STORE-MEASURE ${JSON.stringify(measure)}\n`);
			expect(write.records).toBe(count);
			expect(write.receipts).toBe(count);
			expect(Number.isFinite(firstReloadMs) && firstReloadMs > 0).toBe(true);
		},
		15 * 60_000,
	);
});
