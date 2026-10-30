// Ops #643 (H-USAGE-CPU-CLOCK-1): one Worker runs the same usage-accounting work twice, side by side: once quiet,
// once on a busy machine, simulated. Synthetic data only (never a real chat file or the live store).
//
// Simulated contention: the contended run's performance.now() is the thread's own CPU time with waits added, as if a
// busy machine gave the thread a 1/`dilation` share of a core in turns: it runs TURN_MS of CPU, then waits
// (dilation - 1) * TURN_MS for a core. A scheduler hands out cores in turns like this, which is why a single step can
// see a wait longer than the 100 ms unit guard. Each run keeps its own clock, so the quiet run is never charged for
// the contended one's time, nor the other way round. Only readers of performance.now() see it: the pass's default
// work clock and the W1 index's slice clock before #643. Their CPU work, Date.now(), timers and the real file reads
// are the same in both runs.
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import {
	closePassState,
	openPassState,
	runPass,
	type PassResult,
	type PassState,
} from "../../server/usage-accounting-pass.js";
import { METER_LIMITS } from "../../server/usage-accounting-meter-contract.js";
import { UsageAccountingStore } from "../../server/usage-accounting-store.js";

const { name, dir, dilation } = workerData as { name: string; dir: string; dilation: number };
const realNow = performance.now.bind(performance);
const cpuNow = () => {
	const { user, system } = process.threadCpuUsage();
	return (user + system) / 1000;
};
const TURN_MS = 10;
/** A run's own performance.now(), counted over its own turns only: wall-clock when quiet (factor 1); when contended,
 *  its CPU time plus a wait of (factor - 1) * TURN_MS after every TURN_MS of CPU. */
function runClock(factor: number) {
	const origin = realNow();
	const own = factor === 1 ? realNow : cpuNow;
	const wall = (spent: number) => spent + (factor - 1) * TURN_MS * Math.floor(spent / TURN_MS);
	let spent = 0,
		at = 0;
	return {
		enter() {
			at = own();
			performance.now = () => origin + wall(spent + own() - at);
		},
		leave() {
			spent += own() - at;
			performance.now = realNow;
		},
	};
}
async function within<T>(clock: ReturnType<typeof runClock>, fn: () => Promise<T>): Promise<T> {
	clock.enter();
	try {
		return await fn();
	} finally {
		clock.leave();
	}
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const errorCode = (e: unknown) => {
	const code = (e as { code?: unknown })?.code;
	return typeof code === "string" ? code : e instanceof Error ? e.message : String(e);
};

/** W1's numeric index: 4,096 entries in pages of 128, a dense append, scattered updates and read-backs. */
async function store() {
	const PAGE = { maxBytes: METER_LIMITS.pageBytes, maxRows: METER_LIMITS.pageRows };
	const count = 4096;
	const keys = Array.from({ length: count }, (_, i) => `r:cpu-clock-${sha(`fixed-key-${i}`)}`).sort();
	const entry = (i: number, identity: string) => ({
		key: keys[i]!,
		value: { kind: "node" as const, identity, component: "fixture-cpu-clock" },
	});
	const steps: ((s: UsageAccountingStore) => Promise<unknown>)[] = [];
	for (let at = 0; at < count; at += 128)
		steps.push((s) =>
			s.index.write(
				Array.from({ length: 128 }, (_, i) => entry(at + i, `seed-${at + i}`)),
				PAGE,
			),
		);
	for (let page = 0; page < 16; page++)
		steps.push((s) =>
			s.index.write(
				Array.from({ length: 128 }, (_, i) => {
					const ordinal = page * 128 + i;
					return entry((ordinal * 4051) % count, `updated-${page}-${i}`);
				}),
				PAGE,
			),
		);
	for (let at = 0; at < count; at += 128) steps.push((s) => s.index.get(keys.slice(at, at + 128), PAGE));
	const run = async (label: string, factor: number) => {
		const data = join(dir, label);
		mkdirSync(data, { recursive: true, mode: 0o700 });
		const clock = runClock(factor);
		const s = await within(clock, async () => {
			const s = await UsageAccountingStore.open({ dataDir: data, lease: new SharedArrayBuffer(4) });
			await s.head(METER_LIMITS);
			await s.index.reset();
			return s;
		});
		return { label, s, clock, error: null as string | null, gets: [] as string[] };
	};
	const quiet = await run("store-quiet", 1);
	const contended = await run("store-contended", dilation);
	for (const step of steps)
		for (const r of [quiet, contended]) {
			if (r.error) continue;
			try {
				const out = await within(r.clock, () => step(r.s));
				if (Array.isArray(out)) r.gets.push(sha(JSON.stringify([...out].sort((a, b) => (a.key < b.key ? -1 : 1)))));
			} catch (e) {
				r.error = errorCode(e);
			}
		}
	const summary = async (r: typeof quiet) => {
		const m = r.s.metrics().index;
		await r.s.close();
		const { finalYields, flushQuantumYields, otherQuantumYields, clockYields } = m.work;
		return {
			error: r.error,
			steps: r.gets.length,
			entries: m.entries,
			gets: sha(r.gets.join("\n")),
			yields: { finalYields, flushQuantumYields, otherQuantumYields, clockYields },
			total: finalYields + flushQuantumYields + otherQuantumYields + clockYields,
			maxWorkMs: m.maxWorkMs,
			maxWorkNodes: m.maxWorkNodes,
		};
	};
	return { steps: steps.length, quiet: await summary(quiet), contended: await summary(contended) };
}

/** Design B's pass: 8 synthetic chats of 1,000 calls each, read to the end in passes of 50 ms of work. */
async function pass() {
	const AS_OF = "2026-10-20T12:00:00.000Z";
	const sessions = join(dir, "sessions");
	mkdirSync(join(sessions, "cwd"), { recursive: true, mode: 0o700 });
	for (let f = 0; f < 8; f++) {
		const lines = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: `cpu-clock-${f}`,
				timestamp: "2026-10-20T10:00:00.000Z",
				cwd: "/synthetic-only",
			}),
		];
		for (let i = 0; i < 1000; i++) {
			const at = new Date(Date.parse("2026-10-20T10:00:01.000Z") + i * 1000).toISOString();
			const id = `f${f}-call-${i}`;
			lines.push(
				JSON.stringify({
					type: "message",
					id,
					parentId: null,
					timestamp: at,
					message: {
						role: "assistant",
						timestamp: at,
						provider: "fixture-provider",
						model: "fixture-model",
						responseId: `response-${id}`,
						usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0.01 } },
						content: [],
					},
				}),
			);
		}
		const file = join(sessions, "cwd", `chat-${f}.jsonl`);
		writeFileSync(file, `${lines.join("\n")}\n`);
		const t = new Date("2026-10-20T11:00:00.000Z");
		utimesSync(file, t, t);
	}
	const budget = { bytes: 64 * 1024 * 1024, workMs: 50 };
	const run = (label: string, factor: number) => {
		const data = join(dir, label);
		mkdirSync(data, { recursive: true, mode: 0o700 });
		const clock = runClock(factor);
		clock.enter();
		// No clock option: the pass's own default work clock is the thing under test.
		const s: PassState = openPassState({
			dataDir: data,
			lease: new SharedArrayBuffer(4),
			epoch: "a".repeat(64),
			sessionRoots: [sessions],
			temperRoots: [],
			ledgerDirectory: null,
			production: "disabled",
			now: () => Date.parse(AS_OF),
		});
		clock.leave();
		return { label, s, clock, passes: [] as PassResult["stats"][], statuses: [] as string[], done: false };
	};
	const quiet = run("pass-quiet", 1);
	const contended = run("pass-contended", dilation);
	// Same ambient conditions for both: one pass each in turn. The contended run may take at most four times the
	// passes the quiet one took (plus 20); a pass clock that ends slices early runs into that cap.
	for (let i = 0; i < 2000; i++) {
		for (const r of [quiet, contended]) {
			if (r.done) continue;
			const p = await within(r.clock, () => runPass(r.s, budget));
			r.passes.push(p.stats);
			r.statuses.push(p.status);
			if (p.status !== "catching-up") r.done = true;
		}
		if (quiet.done && (contended.done || contended.passes.length >= 4 * quiet.passes.length + 20)) break;
	}
	const rows = (s: PassState) => {
		const out: string[] = [];
		let cursor: Parameters<PassState["store"]["observations"]>[1] = null;
		do {
			const page = s.store.observations(s.cur!.week, cursor, 4096);
			for (const o of page.observations) out.push(JSON.stringify(o));
			cursor = page.next;
		} while (cursor !== null);
		return out.sort();
	};
	const summary = (r: typeof quiet) => {
		const all = rows(r.s);
		closePassState(r.s);
		// Work per slice: the bytes and reads of each pass its budget ended (the last pass ends on the data instead).
		const budgetEnded = r.done ? r.passes.slice(0, -1) : r.passes;
		const median = (xs: number[]) => {
			const s = [...xs].sort((a, b) => a - b);
			return s.length ? s[Math.floor(s.length / 2)]! : 0;
		};
		return {
			passes: r.passes.length,
			done: r.done,
			final: r.statuses[r.statuses.length - 1] ?? null,
			bytesRead: r.passes.reduce((n, p) => n + p.bytesRead, 0),
			medianBytesPerPass: median(budgetEnded.map((p) => p.bytesRead)),
			medianReadsPerPass: median(budgetEnded.map((p) => p.reads)),
			medianWorkMs: median(budgetEnded.map((p) => p.workMs)),
			rows: all.length,
			digest: sha(all.join("\n")),
		};
	};
	return { quiet: summary(quiet), contended: summary(contended) };
}

const cases: Record<string, () => Promise<unknown>> = { store, pass };
cases[name]!()
	.then((result) => parentPort!.postMessage({ ok: true, result }))
	.catch((e) => parentPort!.postMessage({ ok: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) }));
