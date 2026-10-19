// Ops #233 (H-GUARD-STORE-PERF-1, docs/guard-store-perf.md): how long each role message spends in the guard store
// at about 1, 5 and 15 MB of guard journal. Not part of the suite (its own config); run it with
//   scripts/sealed.sh env TZ=UTC GUARD_STORE_BENCH_OUT=<file.json> \
//     npx vitest run --config tests/unit/role-message-guard-store-bench.config.ts
// GUARD_STORE_BENCH_IMPL=reference measures the old store (role-message-guard-store-reference.ts) instead.
// It replays test (a)'s sends (the 1 and 5 MB bands), then grows the canonical file with copies of its accepted
// messages to about 15 MB and times 30 more sends. Per send: wall time; the event loop's busy time (the stall:
// the server can do nothing else meanwhile) and idle time (waiting on the disk), from
// performance.eventLoopUtilization; process CPU time; store calls; file sizes; and, apart, the read and fill
// check test (a) does after each send.
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import type {
	GuardAtomicMutation,
	GuardLegacyAcceptedMessage,
	GuardOperationIdentity,
	GuardStorePort,
	GuardStoreState,
} from "../../server/role-message-guard-contract.js";
import { RoleMessageGuardHost } from "../../server/role-message-guard-host.js";
import {
	GuardFileStore,
	guardDigest,
	type GuardFileStoreOptions,
	type GuardLegacyFile,
} from "../../server/role-message-guard-store.js";
import { dir, now, send, setNow, useGuardWorld, world, type World } from "./role-message-guard-host-harness.js";
import { GuardFileStore as ReferenceStore } from "./role-message-guard-store-reference.js";
import { replayWorstWindow } from "./role-message-guard-worst-window-replay.js";

useGuardWorld();

const impl = process.env.GUARD_STORE_BENCH_IMPL === "reference" ? "reference" : "store";
const Store: { prototype: object } = impl === "reference" ? ReferenceStore : GuardFileStore;

// Inclusive time in each store method and how often it ran (sync or async methods alike).
const spent: Record<string, { calls: number; ms: number }> = {};
for (const name of ["read", "transact", "lookup", "recover", "load", "canonicalDigest", "raw", "durable"]) {
	const proto = Store.prototype as Record<string, (...args: unknown[]) => unknown>;
	const original = proto[name];
	if (typeof original !== "function") continue;
	const s = (spent[name] = { calls: 0, ms: 0 });
	proto[name] = function (this: unknown, ...args: unknown[]) {
		const t = performance.now();
		const done = () => {
			s.calls++;
			s.ms += performance.now() - t;
		};
		let out: unknown;
		try {
			out = original.apply(this, args);
		} catch (error) {
			done();
			throw error;
		}
		if (out instanceof Promise) return out.finally(done);
		done();
		return out;
	};
}
if (impl === "reference") {
	const proto = RoleMessageGuardHost.prototype as unknown as { newStore(dir: string): GuardFileStore };
	const original = proto.newStore;
	proto.newStore = function (this: unknown, folder: string) {
		const options = (original.call(this, folder) as unknown as { options: GuardFileStoreOptions }).options;
		return new ReferenceStore(options) as unknown as GuardFileStore;
	};
}

interface Row {
	n: number;
	phase: "window" | "grown";
	journal: number;
	legacy: number;
	wall: number;
	busy: number;
	idle: number;
	cpu: number;
	after: number;
	calls: Record<string, number>;
	storeMs: number;
}
const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};
const p90 = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? s[Math.floor((s.length - 1) * 0.9)] : NaN;
};
const round = (x: number) => Math.round(x * 10) / 10;
function band(rows: Row[]) {
	const pick = (f: (r: Row) => number) => ({ median: round(median(rows.map(f))), p90: round(p90(rows.map(f))) });
	return {
		sends: rows.length,
		journalMB: pick((r) => r.journal / 1e6),
		wallMs: pick((r) => r.wall),
		busyMs: pick((r) => r.busy),
		idleMs: pick((r) => r.idle),
		cpuMs: pick((r) => r.cpu),
		storeMs: pick((r) => r.storeMs),
		testAStepExtraMs: pick((r) => r.after),
		transactsPerSend: pick((r) => r.calls.transact ?? 0),
		readsPerSend: pick((r) => r.calls.read ?? 0),
	};
}

describe("H-GUARD-STORE-PERF-1 benchmark", () => {
	it("ms per send at about 1, 5 and 15 MB of guard journal", async () => {
		const startedLoad = loadavg();
		const w = await world();
		const store = () => (w.host as unknown as { store: GuardStorePort & { options: GuardFileStoreOptions } }).store;
		const stateOf = async (x: World) =>
			(await (x.host as unknown as { state_(): Promise<GuardStoreState | null> }).state_())!;
		const rows: Row[] = [];
		// GUARD_STORE_BENCH_DUMP=<dir>: copies of the two guard files at the first send past 4.9 MB and after the growth,
		// for store-only measurements on fixed inputs.
		const dumped = new Set<string>();
		const dump = (name: string) => {
			const out = process.env.GUARD_STORE_BENCH_DUMP;
			if (!out || dumped.has(name)) return;
			dumped.add(name);
			const { journalPath, legacyPath } = store().options;
			mkdirSync(join(out, name), { recursive: true });
			copyFileSync(journalPath, join(out, name, "journal.json"));
			copyFileSync(legacyPath, join(out, name, "accepted.json"));
		};
		const measure = async (n: number, phase: Row["phase"], run: () => Promise<void>) => {
			const before = Object.fromEntries(Object.entries(spent).map(([k, v]) => [k, { ...v }]));
			const elu = performance.eventLoopUtilization();
			const cpu = process.cpuUsage();
			const t = performance.now();
			await run();
			const wall = performance.now() - t;
			const loop = performance.eventLoopUtilization(elu);
			const used = process.cpuUsage(cpu);
			const calls: Record<string, number> = {};
			for (const [k, v] of Object.entries(spent)) calls[k] = v.calls - before[k].calls;
			const storeMs = ["read", "transact", "lookup", "recover"].reduce(
				(sum, k) => sum + (spent[k] ? spent[k].ms - before[k].ms : 0),
				0,
			);
			// What test (a) does after each send (not part of a send in the live app).
			const t2 = performance.now();
			w.host.fills(await stateOf(w));
			const after = performance.now() - t2;
			const { journalPath, legacyPath } = store().options;
			rows.push({
				n,
				phase,
				journal: statSync(journalPath).size,
				legacy: statSync(legacyPath).size,
				wall: round(wall),
				busy: round(loop.active),
				idle: round(loop.idle),
				cpu: round((used.user + used.system) / 1000),
				after: round(after),
				calls,
				storeMs: round(storeMs),
			});
			if (phase === "window" && statSync(journalPath).size >= 4_900_000) dump("5mb");
		};
		const t0 = performance.now();
		const sent = await replayWorstWindow(w, { each: (one, run) => measure(one.n, "window", run) });
		const windowMs = performance.now() - t0;
		expect(sent).toBe(428);

		// Grow the canonical file with copies of its accepted messages (the shape between rotations) to ~15 MB.
		const { journalPath, legacyPath } = store().options;
		// The canonical file holds only accepted business messages; the store checks each copy again, and the
		// expectation below fails if it refuses one.
		const source = (JSON.parse(readFileSync(legacyPath, "utf8")) as GuardLegacyFile)
			.messages as readonly GuardLegacyAcceptedMessage[];
		const actor: GuardOperationIdentity["actor"] = {
			role: "r1",
			sessionFile: "/bench/r1.jsonl",
			sessionId: "bench-r1",
			runtimeIncarnation: "bench-runtime",
			task: { kind: "home" },
			currentHome: true,
			identityRevision: "bench-v1",
		};
		let copies = 0;
		while (statSync(journalPath).size < 14_500_000) {
			const batch = Array.from({ length: 100 }, (_, i) => ({
				...source[(copies + i) % source.length],
				id: `rm-bench-${copies + i}`,
			}));
			copies += batch.length;
			const id: GuardOperationIdentity = {
				version: "role-message-guard/v1",
				operationId: `bench-grow-${copies}`,
				fingerprint: guardDigest({ grow: copies }),
				actor,
			};
			const r = await store().transact(id, async (current): Promise<GuardAtomicMutation> => ({
				next: { ...current },
				legacyAccepted: batch,
				result: { state: "blocked", reason: "invalid_input", request: null, requiredTier: null, accepted: false },
			}));
			expect(r.state).toBe("committed");
		}
		dump("15mb");
		const names = Array.from({ length: 9 }, (_, i) => `r${i + 1}`);
		for (let i = 0; i < 30; i++) {
			setNow(now + 120_000);
			const [from, to] = [names[i % 9], names[(i + 1) % 9]];
			await measure(sent + i + 1, "grown", async () => {
				const r = await send(
					w,
					from,
					join(dir, `${from}.jsonl`),
					to,
					{ kind: "request", text: `${from} to ${to}, grown ${i + 1}: `.padEnd(2000, "x") },
					"",
				);
				expect(r, `grown send ${i + 1}`).toMatchObject({ ok: true });
			});
		}

		const window = rows.filter((r) => r.phase === "window");
		const result = {
			impl,
			node: process.version,
			cpu: cpus()[0]?.model,
			loadavg: { start: startedLoad, end: loadavg() },
			windowSeconds: round(windowMs / 1000),
			windowTestAStepSeconds: round(window.reduce((s, r) => s + r.wall + r.after, 0) / 1000),
			copies,
			bands: {
				"1MB": band(window.filter((r) => r.journal >= 750_000 && r.journal < 1_250_000)),
				"5MB": band(window.filter((r) => r.journal >= 4_500_000 && r.journal < 5_500_000)),
				"15MB": band(rows.filter((r) => r.phase === "grown")),
				all: band(window),
			},
			totals: spent,
			rows,
		};
		if (process.env.GUARD_STORE_BENCH_OUT) writeFileSync(process.env.GUARD_STORE_BENCH_OUT, JSON.stringify(result));
		console.log(JSON.stringify({ ...result, rows: undefined }, null, 1));
	}, 7_200_000);
});
