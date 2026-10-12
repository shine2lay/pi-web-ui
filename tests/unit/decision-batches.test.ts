// Metadata-only stage tests. No model request/response, real credential, quota API or chat fixture.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	allocated,
	BATCH_TOKEN_LIMIT,
	newTokenBudget,
	quotaBlock,
	reserveTokens,
	reservationBlock,
	settleTokens,
} from "../../server/decision-batch-budget.js";
import {
	BATCH_MODEL,
	BATCH_PROVIDER,
	DecisionBatchControl,
	parseBatchConfig,
	type BatchConfig,
} from "../../server/decision-batches.js";
import { runBoundedCall, type CallDriver, type LifecycleRow } from "../../server/decision-call-lifecycle.js";
import {
	fenceReaderSettings,
	isolateReaderExtensions,
	sessionBlock,
	type ReaderDriverInfo,
} from "../../server/decision-bounded-model.js";
import { DecisionStore } from "../../server/decision-store.js";
import { localDay, type DecisionRecord } from "../../server/decision-records.js";
const dirs: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const now = new Date("2026-10-12T02:00:00Z").getTime();
const identity = { provider: BATCH_PROVIDER, id: BATCH_MODEL, thinking: "medium" };
const config = (): BatchConfig => ({
	v: 1,
	approval: "fixed-owner-order",
	provider: BATCH_PROVIDER,
	model: BATCH_MODEL,
	thinking: "medium",
	maxRecords: 20,
	tokenLimit: 500000,
	dailyTokenCap: 6000000,
	historicTokensByDay: { [localDay(now)]: 197635 },
	historicUnknownByDay: { [localDay(now)]: 163161 },
});
const jwrite = (p: string, v: unknown) => writeFileSync(p, `${JSON.stringify(v)}\n`);
const record = (id = "dr-fixed"): DecisionRecord => ({
	v: 1,
	id,
	ref: `rm-${id}`,
	source: "message",
	from: "ops",
	to: "data",
	how: "live",
	at: now,
	seen: now,
	initiative: "team-in-temper",
});
function fixture(c = config()) {
	const dir = mkdtempSync(join(tmpdir(), "reader-batch-stage-"));
	dirs.push(dir);
	const store = new DecisionStore(dir);
	jwrite(join(dir, "settings.json"), {
		enabled: true,
		initiatives: ["team-in-temper"],
		model: "auto",
		thinking: "medium",
		batchRecords: 4,
		dailyTokenCap: 6000000,
	});
	const rows: unknown[] = [];
	const ctl = new DecisionBatchControl(store, {
		now: () => now,
		guardActive: () => true,
		log: (row) => rows.push(row),
	});
	jwrite(ctl.configFile, c);
	jwrite(ctl.guardFile, {
		provider: BATCH_PROVIDER,
		guardExpiresAt: now / 1000 + 3600,
		stopped: false,
		lastReading: { at: now / 1000, week: 10, five: 20 },
	});
	ctl.prepare([record()]);
	return { dir, store, ctl, rows, config: c };
}
function mark(f: ReturnType<typeof fixture>, id = "dr-fixed") {
	const s = f.store.readerState();
	s.read[id] = "n";
	f.store.saveReaderState(s);
}
function info(): ReaderDriverInfo {
	return {
		...identity,
		maxTokens: 128000,
		messages: 0,
		tokens: 0,
		prompts: 0,
		lifecycleIsolated: true,
		sdkRetryEnabled: false,
		providerMaxRetries: 0,
		compactionEnabled: false,
		cacheWarming: "off",
	};
}
describe("hard numeric stage", () => {
	it("reserves the maximum BEFORE usage and settles only authoritative counts", () => {
		const b = newTokenBudget();
		reserveTokens(b, 20000, 128000, now);
		expect(allocated(b)).toBe(148000);
		expect(reservationBlock(b, 1, 1, now)).toBe("unresolved call cost");
		settleTokens(b, { input: 10000, output: 14000 });
		expect(b).toEqual({ v: 1, limit: BATCH_TOKEN_LIMIT, actual: 24000, calls: 1 });
	});
	it("does not silently count missing, zero, negative or excessive usage as zero", () => {
		for (const usage of [
			{ input: 0, output: 0 },
			{ input: -1, output: 1 },
			{ input: 1, output: NaN },
			{ input: 21000, output: 1 },
			{ input: 1, output: 128001 },
		]) {
			const b = newTokenBudget();
			reserveTokens(b, 20000, 128000, now);
			expect(() => settleTokens(b, usage)).toThrow();
			expect(allocated(b)).toBe(148000);
		}
	});
	it("cannot overshoot 500k even when a request needs the full output allowance", () => {
		const b = newTokenBudget();
		expect(reservationBlock(b, 372001, 128000, now)).toBe("batch boundary");
		reserveTokens(b, 372000, 128000, now);
		expect(allocated(b)).toBe(500000);
	});
	it("quota stops are exact and stale/missing/invalid readings block", () => {
		expect(quotaBlock({ at: now, week: 59.9, five: 74.9 }, now)).toBeUndefined();
		for (const [r, expected] of [
			[undefined, "quota unavailable"],
			[{ at: now, week: 60, five: 0 }, "weekly usage stop"],
			[{ at: now, week: 0, five: 75 }, "five-hour usage stop"],
			[{ at: now - 35 * 60000 - 1, week: 0, five: 0 }, "quota stale"],
			[{ at: now + 60001, week: 0, five: 0 }, "quota stale"],
			[{ at: now, week: -1, five: 0 }, "quota invalid"],
		] as const)
			expect(quotaBlock(r, now)).toBe(expected);
	});
});
describe("app-owned capped chunks", () => {
	it("keeps prior known cost and the old timeout hold across automatic chunks", () => {
		const f = fixture();
		expect(f.ctl.preflight(identity)).toBeUndefined();
		expect(f.ctl.reserve(20000, 128000, identity)).toBeUndefined();
		f.ctl.settle({ input: 10000, output: 14000 });
		mark(f);
		f.ctl.progress();
		f.ctl.prepare([record("dr-next")]);
		expect(f.ctl.reserve(20000, 128000, identity)).toBeUndefined();
		f.ctl.settle({ input: 12000, output: 13000 });
		mark(f, "dr-next");
		f.ctl.progress();
		expect(f.ctl.status()).toMatchObject({
			recorded: 246635,
			unknown: 163161,
			allocated: 409796,
			chunks: 2,
			currentAllocated: 0,
		});
		expect(f.rows).toHaveLength(2);
	});
	it("automatically rolls only SETTLED cost to a new 500k chunk", () => {
		const f = fixture();
		expect(f.ctl.reserve(400000, 10000, identity)).toBeUndefined();
		f.ctl.settle({ input: 390000, output: 10000 });
		expect(f.ctl.reserve(100000, 100000, identity)).toBeUndefined();
		expect(f.ctl.status()).toMatchObject({ chunks: 1, currentAllocated: 200000, unknown: 363161 });
		expect(f.rows[0]).toMatchObject({ reason: "token boundary", actual: 400000, newRead: 0 });
	});
	it("refuses another paid call after a timeout, even after prepare and restart", () => {
		const f = fixture();
		f.ctl.reserve(20000, 128000, identity);
		f.ctl.pause("transport prompt_timeout", true);
		f.ctl.prepare([record("dr-next")]);
		expect(f.ctl.reserve(1, 1, identity)).toBe("transport prompt_timeout");
		const restarted = new DecisionBatchControl(f.store, { now: () => now, guardActive: () => true });
		restarted.prepare([record()]);
		expect(restarted.reserve(1, 1, identity)).toBe("transport prompt_timeout");
		expect(restarted.status().unknown).toBe(311161);
	});
	it("does not silently continue when the semantic reader gives up on a record", () => {
		const f = fixture();
		f.ctl.reserve(20000, 128000, identity);
		f.ctl.settle({ input: 10000, output: 14000 });
		const s = f.store.readerState();
		s.read["dr-fixed"] = "x";
		f.store.saveReaderState(s);
		f.ctl.progress();
		expect(f.ctl.reserve(1, 1, identity)).toBe("reader gave up on a record");
	});
	it("does not reset a pending budget even without an explicit pause", () => {
		const f = fixture();
		f.ctl.reserve(20000, 128000, identity);
		f.ctl.prepare([record()]);
		expect(f.ctl.reserve(1, 1, identity)).toBe("unresolved call cost");
	});
	it("the 6M daily bound includes historic known AND unknown usage", () => {
		const c = config();
		c.historicTokensByDay[localDay(now)] = 5800000;
		const f = fixture(c);
		expect(f.ctl.reserve(20000, 128000, identity)).toBe("daily token boundary");
		expect(f.ctl.status().currentAllocated).toBe(0);
	});
	it("free duplicate marks do not expand the selected unique-record limit", () => {
		const f = fixture();
		const many = Array.from({ length: 20 }, (_, n) => record(`dr-${n}`));
		f.ctl.prepare(many); // previous group has not been consumed
		expect(f.ctl.reserve(1, 1, identity)).toBe("unfinished prior record batch");
	});
	it("blocks 21 records and foreign-initiative records before a call", () => {
		const f = fixture();
		f.ctl.prepare(Array.from({ length: 21 }, (_, n) => record(`dr-${n}`)));
		expect(f.ctl.reserve(1, 1, identity)).toBe("record batch exceeds its boundary");
		f.ctl.prepare([{ ...record("dr-foreign"), initiative: "unrelated", text: "fixed clean fixture" }]);
		expect(f.ctl.reserve(1, 1, identity)).toBe("record outside Team in Temper");
	});
	it("pins provider, model and thinking to the same identity as the guard", () => {
		for (const changed of [{ provider: "anthropic-3" }, { id: "stronger-model" }, { thinking: "high" }]) {
			const f = fixture();
			expect(f.ctl.reserve(1, 1, { ...identity, ...changed })).toBe("reader identity mismatch");
		}
	});
	it("does not invent permission when the config is missing or changed", () => {
		const f = fixture();
		rmSync(f.ctl.configFile);
		expect(f.ctl.reserve(1, 1, identity)).toBe("batch configuration unavailable or changed");
		jwrite(f.ctl.configFile, { ...f.config, approval: "changed" });
		expect(f.ctl.reserve(1, 1, identity)).toBe("batch configuration unavailable or changed");
		expect(parseBatchConfig({ ...config(), tokenLimit: 1000000 })).toBeUndefined();
	});
	it("never rewrites canonical decisions/settings/read marks while reserving tokens", () => {
		const f = fixture();
		const paths = [join(f.dir, "settings.json"), join(f.dir, "decisions.json"), join(f.dir, "reader-state.json")];
		jwrite(paths[1], { v: 1, next: 1, decisions: [] });
		f.store.saveReaderState(f.store.readerState());
		const before = paths.map((p) => readFileSync(p, "utf8"));
		f.ctl.reserve(20000, 128000, identity);
		f.ctl.settle({ input: 10000, output: 14000 });
		expect(paths.map((p) => readFileSync(p, "utf8"))).toEqual(before);
	});
	it("corrupt history accounting is unavailable, never zeroed or reset", () => {
		const f = fixture();
		const l = JSON.parse(readFileSync(f.ctl.ledgerFile, "utf8"));
		l.historicUnknownByDay = {};
		jwrite(f.ctl.ledgerFile, l);
		const restarted = new DecisionBatchControl(f.store, { now: () => now, guardActive: () => true });
		restarted.prepare([record()]);
		expect(restarted.reserve(1, 1, identity)).toBe("batch configuration unavailable or changed");
		expect(restarted.status().unknown).toBeNull();
	});
	it.each([60, 90])("weekly use %s blocks before reservation", (week) => {
		const f = fixture();
		jwrite(f.ctl.guardFile, {
			provider: BATCH_PROVIDER,
			guardExpiresAt: now / 1000 + 3600,
			stopped: false,
			lastReading: { at: now / 1000, week, five: 0 },
		});
		expect(f.ctl.reserve(1, 1, identity)).toBe("weekly usage stop");
		expect(f.ctl.status().currentAllocated).toBe(0);
	});
	it("dead, stale, expired, mismatched and stopped guards cannot authorise a call", () => {
		for (const change of [
			{ provider: "anthropic-3" },
			{ stopped: true },
			{ guardExpiresAt: now / 1000 - 1 },
			{ lastReading: { at: now / 1000 - 3600, week: 0, five: 0 } },
		]) {
			const f = fixture();
			const g = JSON.parse(readFileSync(f.ctl.guardFile, "utf8"));
			jwrite(f.ctl.guardFile, { ...g, ...change });
			expect(f.ctl.reserve(1, 1, identity)).toBeDefined();
		}
		const f = fixture();
		const dead = new DecisionBatchControl(f.store, { now: () => now, guardActive: () => false });
		dead.prepare([record()]);
		expect(dead.reserve(1, 1, identity)).toBe("usage guard inactive or stopped");
	});
});
describe("live app wiring", () => {
	it("the app uses the hard model fence and existing hooks, not a second store writer", () => {
		const source = readFileSync(
			process.env.DECISION_BATCH_APP_SOURCE ?? new URL("../../server/agent-service.ts", import.meta.url),
			"utf8",
		);
		expect(source.includes("model: boundedDecisionModel(")).toBe(true);
		expect(source.includes("onBatch: (records) => control.prepare(records)")).toBe(true);
		expect(/onChange:\s*\(\)\s*=>\s*\{\s*control\.progress\(\);\s*this\.onDecisionsChanged\?\.\(\);/.test(source)).toBe(
			true,
		);
	});
});
describe("native-session fences", () => {
	it("detects all extras and any hidden setup usage", () => {
		expect(sessionBlock(info())).toBeUndefined();
		for (const changed of [
			{ sdkRetryEnabled: true },
			{ providerMaxRetries: 2 },
			{ compactionEnabled: true },
			{ cacheWarming: "smart" },
			{ lifecycleIsolated: false },
			{ tokens: 1 },
			{ messages: 1 },
			{ prompts: 1 },
			{ provider: "default-provider" },
			{ maxTokens: 0 },
		])
			expect(sessionBlock({ ...info(), ...changed })).toBeDefined();
	});
	it("fences BOTH merged overrides and the global-only warming getter without persistence", () => {
		let overrides: unknown;
		const s = {
			applyOverrides: (o: unknown) => {
				overrides = o;
			},
			getCacheWarmingMode: () => "smart",
		} as unknown as Parameters<typeof fenceReaderSettings>[0];
		fenceReaderSettings(s);
		expect(s.getCacheWarmingMode()).toBe("off");
		expect(overrides).toEqual({
			retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
			compaction: { enabled: false },
			cacheWarming: "off",
		});
	});
	it("clones only provider hooks, keeps auth and rejects unknown descriptors", () => {
		const multi = {
			path: "/fixed/pi-multi-pass/extensions/multi-sub.ts",
			handlers: new Map<string, unknown>([
				["session_start", () => {}],
				["before_provider_headers", () => {}],
				["agent_end", () => {}],
			]),
		};
		const auth = { path: "/fixed/pi-anthropic-auth/index.ts", handlers: new Map<string, unknown>() };
		const isolated = isolateReaderExtensions({ extensions: [multi, auth] });
		expect([...isolated.extensions[0].handlers.keys()]).toEqual(["before_provider_headers"]);
		expect(multi.handlers.size).toBe(3);
		expect(() => isolateReaderExtensions({ extensions: [auth] })).toThrow();
		expect(() => isolateReaderExtensions({ extensions: [{ ...auth, path: "/fixed/unexpected.ts" }, multi] })).toThrow();
	});
});
describe("single-call lifecycle stage", () => {
	function driver() {
		let prompts = 0,
			aborts = 0,
			disposals = 0;
		let refused: (() => void) | undefined;
		const d: CallDriver = {
			identity: () => identity,
			subscribe: (cb) => {
				refused = cb;
				return () => {};
			},
			prompt: async () => {
				prompts++;
			},
			abort: async () => {
				aborts++;
			},
			dispose: () => {
				disposals++;
			},
		};
		return { d, stats: () => ({ prompts, aborts, disposals }), refuse: () => refused?.() };
	}
	it("a block never prompts; settled calls prompt exactly once and dispose", async () => {
		for (const block of ["guard-stop", undefined]) {
			const f = driver();
			const phases: LifecycleRow[] = [];
			const r = await runBoundedCall({
				open: async () => f.d,
				beforePrompt: () => block,
				timeoutMs: 100,
				trace: (row) => phases.push(row),
			});
			expect(r.status).toBe(block ? "blocked" : "settled");
			expect(f.stats()).toEqual({ prompts: block ? 0 : 1, aborts: 0, disposals: 1 });
			expect(phases.every((p) => Object.keys(p).every((k) => ["phase", "at", "elapsedMs", "block"].includes(k)))).toBe(
				true,
			);
		}
	});
	it("guard and prompt rejections dispose once without an extra prompt", async () => {
		for (const stage of ["guard", "prompt"]) {
			const f = driver();
			let calls = 0;
			f.d.prompt = async () => {
				calls++;
				throw new Error("fixed prompt failure");
			};
			const result = await runBoundedCall({
				open: async () => f.d,
				beforePrompt: () => {
					if (stage === "guard") throw new Error("fixed guard failure");
					return undefined;
				},
				timeoutMs: 100,
				trace: () => {},
			});
			expect(result.status).toBe(stage === "guard" ? "guard_rejected" : "prompt_rejected");
			expect(calls).toBe(stage === "guard" ? 0 : 1);
			expect(f.stats().disposals).toBe(1);
		}
	});
	it("setup timeout does not prompt; a late driver is disposed", async () => {
		vi.useFakeTimers();
		const f = driver();
		let open!: (v: CallDriver) => void;
		const r = runBoundedCall({
			open: () =>
				new Promise((resolve) => {
					open = resolve;
				}),
			beforePrompt: () => undefined,
			timeoutMs: 100,
			trace: () => {},
		});
		await vi.advanceTimersByTimeAsync(100);
		expect((await r).status).toBe("setup_timeout");
		open(f.d);
		await Promise.resolve();
		await Promise.resolve();
		expect(f.stats()).toEqual({ prompts: 0, aborts: 0, disposals: 1 });
	});
	it("prompt stall aborts and disposes without a second prompt", async () => {
		vi.useFakeTimers();
		const f = driver();
		f.d.prompt = () => new Promise(() => {});
		const r = runBoundedCall({ open: async () => f.d, beforePrompt: () => undefined, timeoutMs: 100, trace: () => {} });
		await vi.advanceTimersByTimeAsync(100);
		expect((await r).status).toBe("prompt_timeout");
		expect(f.stats().aborts).toBe(1);
		expect(f.stats().disposals).toBe(1);
	});
	it("quota refusal aborts immediately; subscriptions and opening failures are closed", async () => {
		const f = driver();
		f.d.prompt = async () => {
			f.refuse();
		};
		expect(
			(await runBoundedCall({ open: async () => f.d, beforePrompt: () => undefined, timeoutMs: 100, trace: () => {} }))
				.status,
		).toBe("refused");
		expect(f.stats().aborts).toBe(1);
		const g = driver();
		g.d.subscribe = () => {
			throw new Error("fixed observer failure");
		};
		expect(
			(await runBoundedCall({ open: async () => g.d, beforePrompt: () => undefined, timeoutMs: 100, trace: () => {} }))
				.status,
		).toBe("observe_rejected");
		expect(g.stats().prompts).toBe(0);
		expect(
			(
				await runBoundedCall({
					open: async () => {
						throw new Error("fixed open failure");
					},
					beforePrompt: () => undefined,
					timeoutMs: 100,
					trace: () => {},
				})
			).status,
		).toBe("open_rejected");
	});
});
