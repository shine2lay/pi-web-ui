// Ops #423 B3: design B's bounded pass. Each case runs in a Worker with METER_WORKER_RESOURCE_LIMITS (B2's store
// refuses the main thread), on synthetic copies of the W0 and #304 fixtures only.
import {
	mkdtempSync,
	mkdirSync,
	copyFileSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { METER_WORKER_RESOURCE_LIMITS } from "../../server/usage-accounting-meter-contract.js";
import { PASS_LIMITS } from "../../server/usage-accounting-pass.js";
import { PASS_SCAN_LIMITS } from "../../server/usage-accounting-pass-scan.js";
import { startUsagePassWorker } from "../../server/usage-accounting-pass-host.js";

const fixtures = fileURLToPath(new URL("../fixtures", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "usage-pass-"));
	dirs.push(dir);
	return dir;
}
const bundles = new Map<string, Promise<string>>();
function bundle(entry: string): Promise<string> {
	let b = bundles.get(entry);
	if (!b) {
		b = build({
			entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
			bundle: true,
			platform: "node",
			target: "node22",
			format: "cjs",
			write: false,
			logLevel: "silent",
		}).then((r) => r.outputFiles![0].text);
		bundles.set(entry, b);
	}
	return b;
}
// biome-ignore lint/suspicious/noExplicitAny: fixture results are JSON shaped per case
async function run(name: string): Promise<any> {
	const code = await bundle("./usage-accounting-pass-fixture.ts");
	const dir = temp();
	return new Promise((resolve, reject) => {
		const worker = new Worker(code, {
			eval: true,
			workerData: { name, dir, fixtures },
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
const last = <T>(xs: T[]): T => xs[xs.length - 1]!;

describe("usage accounting pass (Ops #423 B3)", { timeout: 120_000 }, () => {
	it("gives W0's totals on its known cases, through the week store and W5", async () => {
		const steps = await run("w0");
		expect(steps).toHaveLength(4);
		for (const step of steps) {
			expect(step.viaB).toEqual(step.viaW0);
			expect(step.w5.state).toBe("ready");
			expect(step.w5.list).toEqual({
				grossObservations: step.viaW0.grossKnownListUsd,
				deduplicatedRecorded: step.viaW0.dedupKnownListUsd,
			});
		}
		expect(steps.map((s: { records: number }) => s.records)).toEqual([3, 5, 6, 8]);
		expect(last<{ viaB: { grossKnownListUsd: string; dedupKnownListUsd: string } }>(steps).viaB).toMatchObject({
			grossKnownListUsd: "0.390000000001",
			dedupKnownListUsd: "0.270000000001",
		});
	});

	it("gives the #304 reader's totals, reads only appended bytes, excludes Temper roots", async () => {
		const r = await run("sessions");
		expect(last<{ status: string; completed: boolean }>(r.passes)).toMatchObject({ status: "fresh", completed: true });
		expect(r.steady).toMatchObject({ status: "fresh", bytesRead: 0, files: 0, reads: 0 });
		expect(r.appended).toMatchObject({ status: "fresh", files: 1, reads: 1 });
		expect(r.files).toEqual(["cwd/delegate.jsonl", "cwd/fork.jsonl", "cwd/plain.jsonl", "cwd/resume-copy.jsonl"]);
		expect(r.direct).toEqual({ gross: "0.91", dedup: "0.69" });
		expect(r.debug.grouped).toEqual({ gross: "0.91", dedup: "0.69", faults: [] });
		expect(r.w5).toMatchObject({
			state: "ready",
			list: { grossObservations: "0.91", deduplicatedRecorded: "0.69" },
			coverage: "complete",
			unresolved: 0,
			faults: [],
		});
		// A new state replays the hash-checked week (checkpoint + log) and adds nothing twice.
		expect(r.after.totals).toMatchObject({ gross: "0.91", dedup: "0.69" });
	});

	it("does not re-read a file's history: steady passes read 0 bytes, an append reads its line plus rechecks", async () => {
		const r = await run("history");
		expect(r.fileBytes).toBeGreaterThan(1_000_000);
		expect(last<{ status: string }>(r.first).status).toBe("fresh");
		expect(r.steady).toMatchObject({ bytesRead: 0, files: 0, reads: 0 });
		expect(r.appended).toMatchObject({ status: "fresh", files: 1, reads: 1 });
		expect(r.appended.bytesRead).toBeLessThan(16 * 1024);
		expect(r.appended.bytesRead).toBeGreaterThanOrEqual(r.lineBytes);
		expect(r.after).toMatchObject({ bytesRead: 0, files: 0 });
		expect(r.totals).toMatchObject({ gross: "3.5", dedup: "3.5", facts: 3001 });
		// Bounded by work, not by wall-clock time (Architecture #278 S1; timing is the large case's): the budget bounds
		// every pass's bytes, even a cold catch-up (one #304 read may finish past it), and across the catch-up the file
		// is read once, plus at most 64 KiB of anchor re-checks per read.
		for (const p of r.first) expect(p.bytesRead).toBeLessThanOrEqual(PASS_LIMITS.bytes + PASS_LIMITS.readWorstBytes);
		const sum = (k: "bytesRead" | "reads") => r.first.reduce((n: number, p: Record<string, number>) => n + p[k], 0);
		expect(sum("bytesRead")).toBeGreaterThanOrEqual(r.fileBytes);
		expect(sum("bytesRead")).toBeLessThanOrEqual(r.fileBytes + sum("reads") * 65_536);
	});

	it("survives cursor faults without charging anything twice", async () => {
		const r = await run("cursors");
		expect(r.truncated.faults).toEqual({ "truncated-source": 1 });
		expect(r.truncated.status).toBe("partial");
		expect(r.afterTruncate).toEqual(r.base);
		expect(r.afterRestore).toEqual(r.base);
		expect(r.rewritten.faults).toEqual({ "cursor-conflict": 1 });
		// Another header id is another session's observation (gross), never another recorded charge (dedup).
		expect(r.afterRewrite.dedup).toBe(r.base.dedup);
		expect(r.clean).toMatchObject({ status: "fresh", bytesRead: 0 });
	});

	it("holds the files-a-week cap and says the inventory is partial", async () => {
		expect(PASS_SCAN_LIMITS.files).toBe(4096);
		const r = await run("cap");
		expect(r.tracked).toBe(2);
		expect(last<{ status: string; faults: Record<string, number> }>(r.passes)).toMatchObject({
			status: "partial",
			faults: { "inventory-partial": 1 },
		});
	});

	it("splits work across passes by budget and reaches the same totals", async () => {
		const r = await run("budget");
		expect(r.tiny[0]).toMatchObject({ status: "catching-up", completed: false, bytesRead: 0 });
		expect(r.split.length).toBeGreaterThan(1);
		for (const p of r.split.slice(0, -1)) expect(p).toMatchObject({ status: "catching-up", completed: false });
		expect(last<{ status: string }>(r.split)).toMatchObject({ status: "fresh", completed: true });
		expect({ gross: r.totals.gross, dedup: r.totals.dedup }).toEqual(r.direct);
	});

	it("rolls over at Monday 00:00 Pacific with a 10 minute grace, then keeps late rows out", async () => {
		const r = await run("rollover");
		expect(r.sunday).toMatchObject({ status: "fresh", records: 1 });
		expect(r.mondayWeek).toBe("2026-10-26");
		expect(r.monday).toMatchObject({ status: "fresh", records: 1, history: 0 });
		// After the grace the last week takes no rows: the late one is history and the pass says so.
		expect(r.late).toMatchObject({ status: "partial", history: 1, records: 1 });
		expect(r.current).toMatchObject({ gross: "0.1", facts: 1 });
		expect(r.records).toEqual({ prev: 2, cur: 1, prevWeek: "2026-10-19" });
		// R-MEM: through the grace last week stays loaded; after it, its fold is dropped and the reopened store no longer
		// holds it (the store keeps every week it loaded until close); a restart past the grace keeps only its checkpoint.
		expect(r.duringGrace).toEqual({ store: "loaded", released: false, fold: 2 });
		expect(r.afterGrace).toEqual({ store: "not-loaded", released: true, fold: 0 });
		expect(r.restart).toEqual({ released: true, fold: 0, checkpoint: true });
	});

	it("builds W5 from the committed observations and fails closed when they change", async () => {
		const r = await run("tamper");
		expect(r).toMatchObject({
			first: "fresh",
			at: true,
			broken: true,
			next: "unavailable",
			stale: "usage-pass-stale-input",
		});
		expect(r.clean).toBeGreaterThan(0);
		expect(["observations-mismatch", "observations-corrupt"]).toContain(r.error);
		expect(r.w5.state).toBe("unavailable");
		expect(r.w5.faults).toContain("index-unavailable");
	});

	it("never overlaps passes under a forced slow pass", async () => {
		const r = await run("overlap");
		expect(r).toEqual({ during: "busy", sequenceDuring: 1, first: "fresh", second: "fresh", sequence: 2 });
	});

	it("reads the ledger tail once, answers first/sameCall from the week store, keeps a steady pass at 0 bytes", async () => {
		const r = await run("ledger");
		expect(r.first).toMatchObject({ gross: "0.495", dedup: "0.495", facts: 4 });
		expect(r.steady).toMatchObject({ bytesRead: 0, ledgerBytes: 0, records: 4 });
		// No producer proof in the fixture: coverage stays unproven, never "fresh".
		expect(r.steady.status).toBe("partial");
		expect(r.afterRepeat).toEqual(r.first);
		expect(r.afterReopen).toEqual(r.first);
		expect(r.receipts.weeks).toEqual([
			expect.objectContaining({ week: "2026-10-19", receipts: true, checkpoint: true, sealed: false }),
		]);
		// Architecture #278 M2: the same response with other numbers in a later read, and again after a reopen, meets
		// its stored receipt: a conflict gap, nothing charged twice, the week stays available.
		for (const step of [r.changed, r.changedAfterReopen]) {
			expect(step.broken).toBe(false);
			expect(step.completed).toBe(true);
			expect(step.faults["event-conflict"]).toBeGreaterThan(0);
		}
		expect(r.afterChanged).toEqual(r.first);
		expect(r.afterChangedReopen).toEqual(r.first);
		expect(r.w5).not.toBe("unavailable");
	});

	it("meets its own staged first receipt when a repeat comes in a later ledger read of the same pass", async () => {
		// Architecture #277 MF1 / T3a: 140 rows apart, the two lines come in two W2 calls of one pass.
		const r = await run("ledgerSplit");
		for (const layout of ["split", "together"]) {
			const x = r[layout];
			expect(x.state.broken).toBe(false);
			expect(last<{ status: string; completed: boolean }>(x.passes)).toMatchObject({ completed: true });
			expect(last<{ status: string }>(x.passes).status).not.toBe("unavailable");
			expect(x.totals).toEqual({ gross: "0.265", dedup: "0.265", facts: 141, aliases: 0 });
			expect(x.after).toEqual(x.totals);
		}
	});

	it("records an unfinished line over 4 MiB once, then reads nothing until the file grows", async () => {
		// Architecture #277 MF2 / T3b and #278 M1/M3.
		const r = await run("oversized");
		const first = last<{ completed: boolean; bytesRead: number; ledgerBytes: number }>(r.first);
		expect(first.completed).toBe(true);
		// The other file and the ledger are read in the same pass, not starved by the long line.
		expect(first.ledgerBytes).toBeGreaterThan(0);
		expect(r.firstTotals).toMatchObject({ gross: "0.345", facts: 4 });
		expect(r.afterFirst).toEqual({ big: { state: "waiting", growth: true }, unknown: { sessions: 1, ledger: 0 } });
		// Idle: nothing re-read, and the gap still shows: partial, complete-through not moved.
		expect(r.idle).toMatchObject({ bytesRead: 0, reads: 0, completed: true, big: { state: "waiting", growth: true } });
		expect(r.idle.sessions).toEqual({ status: "partial", through: r.weekStart });
		// The line ends and a call follows: the call counts once and the gap stays one.
		expect(r.finished).toMatchObject({ completed: true, files: 1 });
		expect(r.finished.bytesRead).toBeLessThan(r.tailBytes);
		expect(r.finishedTotals).toMatchObject({ gross: "0.845", dedup: "0.845", facts: 5 });
		for (const step of [r.later, r.reopened]) {
			expect(step.sessions).toEqual({ status: "partial", through: r.weekStart });
			expect(step.unknown).toEqual({ sessions: 1, ledger: 0 });
		}
		expect(r.later).toMatchObject({ bytesRead: 0, reads: 0 });
		expect(r.reopenedTotals).toEqual(r.finishedTotals);
	});

	it("gives the same totals whichever copy, child or parent, it reads first, and after a restart", async () => {
		// Architecture #277 T2 (M8).
		const r = await run("order");
		expect(r.descending.order).toEqual([...r.ascending.order].reverse());
		for (const way of ["ascending", "descending"]) {
			expect(r[way].status).toBe("fresh");
			expect({ gross: r[way].totals.gross, dedup: r[way].totals.dedup }).toEqual(r.direct);
			expect(r[way].after).toEqual(r[way].totals);
		}
		expect(r.descending.totals).toEqual(r.ascending.totals);
	});

	it("splits ledger calls at Monday 00:00 Pacific and never makes a late row a first", async () => {
		// Architecture #277 T1 (M10).
		const r = await run("ledgerRollover");
		expect(r.before).toMatchObject({ week: "2026-10-19", records: 1 });
		// In the grace: Sunday's call stays last week's, its repeat is a duplicate there, Monday's call is this week's.
		expect(r.grace).toMatchObject({
			week: "2026-10-26",
			cur: 1,
			prev: 1,
			broken: false,
			unknown: { cur: { sessions: 0, ledger: 0 }, prev: { sessions: 0, ledger: 0 } },
		});
		expect(r.graceTotals).toMatchObject({ gross: "0.25", dedup: "0.25", facts: 1 });
		// Past the grace a late Sunday row is history: counted as such, never charged, never a first.
		expect(r.late).toMatchObject({ history: 1, cur: 1, broken: false, completed: true });
		expect(r.lateTotals).toEqual(r.graceTotals);
		expect(r.stored).toEqual({ prev: 1, cur: 1 });
	});

	it("refuses a session root at or inside a Temper root instead of scanning it to zero", async () => {
		// Architecture #277 S2.
		expect(await run("scanRefusal")).toEqual({
			inside: "usage-pass-inventory-input",
			same: "usage-pass-inventory-input",
			parent: "scanned",
		});
	});

	it("refuses a wrong root when the state opens, by name, before the store writes anything (#281 N1, N5)", async () => {
		const refused = { code: "usage-pass-inventory-input", message: "usage-pass-inventory-input", written: [] };
		expect(await run("rootRefusal")).toEqual({
			missing: refused,
			notDirectory: refused,
			relative: refused,
			temperMissing: refused,
			temperRelative: refused,
			sessionsThroughLink: refused,
			insideTemperLink: refused,
			fine: "opened",
		});
	});

	it("excludes a Temper root given through a symlink, so nothing is counted twice (#281 N5)", async () => {
		const r = await run("temperLink");
		expect(r.last).toMatchObject({ status: "fresh", completed: true });
		expect(r.files).toEqual(["cwd/delegate.jsonl", "cwd/fork.jsonl", "cwd/plain.jsonl", "cwd/resume-copy.jsonl"]);
		// The #304 reader's totals over the four chat files alone (the `sessions` case's 0.91 includes its appended call).
		expect(r.direct).toEqual({ gross: "0.41", dedup: "0.19" });
		expect(r.totals).toMatchObject(r.direct);
		expect(r.w5).toMatchObject({
			state: "ready",
			list: { grossObservations: "0.41", deduplicatedRecorded: "0.19" },
			coverage: "complete",
		});
	});

	it("stops a Worker started with a wrong root at once, by name: no pass, nothing written (#281 N1)", async () => {
		const code = await bundle("../../server/usage-accounting-pass-worker.ts");
		const dir = temp();
		mkdirSync(join(dir, "data"), { mode: 0o700 });
		const worker = new Worker(code, {
			eval: true,
			resourceLimits: { ...METER_WORKER_RESOURCE_LIMITS },
			workerData: {
				usagePass: {
					dataDir: join(dir, "data"),
					lease: new SharedArrayBuffer(4),
					epoch: "d".repeat(64),
					sessionRoots: [join(dir, "missing")],
					temperRoots: [],
					ledgerDirectory: null,
					production: "disabled",
					subjects: [{ subject: { kind: "role", role: "design" }, policy: null }],
				},
			},
		});
		try {
			const first = await new Promise<unknown>((done) => {
				worker.once("error", (e) => done({ error: (e as { code?: unknown }).code }));
				worker.once("message", (m: { kind?: string }) => done({ message: m.kind }));
				worker.postMessage({ kind: "tick" });
			});
			expect(first).toEqual({ error: "usage-pass-inventory-input" });
			expect(readdirSync(join(dir, "data"))).toEqual([]);
		} finally {
			await worker.terminate();
		}
	});

	it("has the Worker drop a tick that arrives while its pass runs, even without the host's guard", async () => {
		// Architecture #278 S2: the Worker's own single-flight guard, reached directly (two ticks, no host).
		const code = await bundle("../../server/usage-accounting-pass-worker.ts");
		const dir = temp();
		mkdirSync(join(dir, "sessions", "cwd"), { recursive: true, mode: 0o700 });
		mkdirSync(join(dir, "data"), { mode: 0o700 });
		// A chat file to read: the pass then waits on file I/O, and the second tick arrives while it runs.
		const file = join(dir, "sessions", "cwd", "plain.jsonl");
		copyFileSync(join(fixtures, "usage-accounting-pi-sessions", "plain.jsonl"), file);
		const at = new Date();
		utimesSync(file, at, at);
		const worker = new Worker(code, {
			eval: true,
			resourceLimits: { ...METER_WORKER_RESOURCE_LIMITS },
			workerData: {
				usagePass: {
					dataDir: join(dir, "data"),
					lease: new SharedArrayBuffer(4),
					epoch: "c".repeat(64),
					sessionRoots: [join(dir, "sessions")],
					temperRoots: [],
					ledgerDirectory: null,
					production: "disabled",
					subjects: [{ subject: { kind: "role", role: "design" }, policy: null }],
				},
			},
		});
		const kinds: string[] = [];
		try {
			await new Promise<void>((done, fail) => {
				worker.on("message", (m: { kind: string }) => {
					kinds.push(m.kind);
					if (m.kind === "pass") done();
				});
				worker.once("error", fail);
				worker.postMessage({ kind: "tick" });
				worker.postMessage({ kind: "tick" });
			});
			expect(kinds).toEqual(["dropped", "pass"]);
		} finally {
			await worker.terminate();
		}
	});

	it("reports a worker exit it did not ask for as lost, exit code 0 included, and stops ticking", async () => {
		// Architecture #277 S4.
		const messages: unknown[] = [];
		const host = startUsagePassWorker(
			"process.exit(0)",
			{} as Parameters<typeof startUsagePassWorker>[1],
			(m) => messages.push(m),
			{ eval: true },
		);
		await new Promise((done) => host.worker.once("exit", done));
		expect(messages).toEqual([{ kind: "worker-unavailable" }]);
		expect(host.tick()).toBe(false);
		await host.close();
		expect(messages).toHaveLength(1);
	});

	it("runs in a Worker with METER_WORKER_RESOURCE_LIMITS and drops a tick while one is outstanding", async () => {
		const code = await bundle("../../server/usage-accounting-pass-worker.ts");
		const dir = temp();
		const sessions = join(dir, "sessions", "cwd");
		mkdirSync(sessions, { recursive: true, mode: 0o700 });
		mkdirSync(join(dir, "data"), { mode: 0o700 });
		const file = join(sessions, "plain.jsonl");
		copyFileSync(join(fixtures, "usage-accounting-pi-sessions", "plain.jsonl"), file);
		const at = new Date();
		utimesSync(file, at, at);
		const messages: { kind: string; status?: string; snapshot?: unknown }[] = [];
		let got!: () => void;
		const pass = new Promise<void>((r) => (got = r));
		const host = startUsagePassWorker(
			code,
			{
				dataDir: join(dir, "data"),
				lease: new SharedArrayBuffer(4),
				epoch: "b".repeat(64),
				sessionRoots: [join(dir, "sessions")],
				temperRoots: [],
				ledgerDirectory: null,
				production: "disabled",
				subjects: [{ subject: { kind: "role", role: "design" }, policy: null }],
			},
			(m) => {
				messages.push(m as (typeof messages)[number]);
				if ((m as { kind?: string }).kind === "pass") got();
			},
			{ eval: true },
		);
		try {
			expect(host.worker.resourceLimits).toMatchObject(METER_WORKER_RESOURCE_LIMITS);
			expect(host.tick()).toBe(true);
			expect(host.tick()).toBe(false);
			await pass;
			const p = messages.find((m) => m.kind === "pass")!;
			expect(["fresh", "partial", "catching-up"]).toContain(p.status);
			expect(p.snapshot).not.toBeNull();
			expect(host.tick()).toBe(true);
		} finally {
			await host.close();
		}
		// A close it asked for is not a lost worker.
		expect(messages.some((m) => m.kind === "worker-unavailable")).toBe(false);
	});

	// Not part of the gate (minutes, about 0.5 GB): B_PASS_LARGE_CASE=1 times synthetic E1 (125k) and E2 (250k) weeks.
	// It writes the R-steady, R-W5 and R-MEM numbers recorded in docs/usage-accounting-pass.md as JSON to the file named
	// by B_PASS_LARGE_OUT (the gate's vitest config silences console output: Architecture #278 M5) and holds H-B3's bars.
	it.runIf(process.env.B_PASS_LARGE_CASE === "1")(
		"measures E1 and E2: steady pass, W5 build (R-W5) and heap (R-MEM)",
		{ timeout: 1_800_000 },
		async () => {
			// Architecture #282 S2: the machine the figures came from, since H-B3's bars hold on a quiet machine (C1): its
			// cores, the CPUs this process may use, and the 1, 5 and 15 minute load averages at the start and after each week.
			let cpusAllowedList: string | null = null;
			try {
				cpusAllowedList = /^Cpus_allowed_list:\s*(\S+)/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1] ?? null;
			} catch {
				/* not Linux: left null */
			}
			const load: Record<string, number[]> = { start: loadavg() };
			const out: Record<string, unknown> = {
				at: new Date().toISOString(),
				machine: { cores: cpus().length, cpusAllowedList, load },
			};
			const save = () => {
				if (process.env.B_PASS_LARGE_OUT)
					writeFileSync(process.env.B_PASS_LARGE_OUT, `${JSON.stringify(out, null, 1)}\n`, { mode: 0o600 });
			};
			// Architecture #282 S1: both weeks run and are saved before any bar is checked, so a missed E1 bar can't hide E2.
			// biome-ignore lint/suspicious/noExplicitAny: fixture results are JSON shaped per case
			const results: [string, any][] = [];
			for (const name of ["e1", "e2"]) {
				const r = await run(name);
				out[name] = { ...r, w5: { ...r.w5, runs: r.w5.runs.map(Math.round) } };
				load[name] = loadavg();
				save();
				results.push([name, r]);
			}
			for (const [name, r] of results) {
				expect.soft(r.unknown).toEqual({ sessions: 0, ledger: 0 });
				expect.soft(r.idle).toMatchObject({ bytesRead: 0, statuses: ["fresh"] });
				expect.soft(r.steady.statuses).toEqual(["fresh"]);
				expect.soft(r.w5.state).toBe("ready");
				// H-B3's bars: a steady pass within 1 s; W5 at 125k (E1) within 25 s. E2's W5 has no bar (an open point).
				expect.soft(r.steady.maxWorkMs).toBeLessThanOrEqual(1000);
				if (name === "e1") expect.soft(r.w5.snapshotMs).toBeLessThanOrEqual(25_000);
			}
		},
	);
});
