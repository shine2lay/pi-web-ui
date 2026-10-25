// B4 (Ops #322): design B's main-thread host. The 30 s step, the 300 s dead man's switch, the native receipt, the
// W5 cadence, the role witness across the Worker boundary, and the Roles view reading all of it. Synthetic only: no
// live chats, no model call, temporary folders removed after each test.
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { RolesWatch, roleUsageCost, type RolesOverviewHost } from "../../server/roles-overview.js";
import {
	checkSessionRoots,
	startUsageAccounting,
	usageLedgerProduction,
	type UsageAccounting,
	type UsageAccountingOptions,
	type UsageRoleWitness,
} from "../../server/usage-accounting-host.js";
import type { UsageMeterSnapshot } from "../../server/usage-accounting-meter-contract.js";
import { startUsagePassWorker, type UsagePassHost } from "../../server/usage-accounting-pass-host.js";
import { readWitness } from "../../server/usage-accounting-pass-worker.js";

const fixtures = fileURLToPath(new URL("../fixtures", import.meta.url));
const dirs: string[] = [];
const temp = () => {
	const d = mkdtempSync(join(tmpdir(), "usage-host-"));
	dirs.push(d);
	return d;
};
const running: UsageAccounting[] = [];
afterEach(async () => {
	for (const a of running.splice(0)) await a.stop();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const bundles = new Map<string, Promise<string>>();
const bundle = (entry: string) => {
	if (!bundles.has(entry))
		bundles.set(
			entry,
			build({
				entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
				bundle: true,
				platform: "node",
				target: "node22",
				format: "cjs",
				write: false,
				logLevel: "silent",
			}).then((r) => r.outputFiles[0].text),
		);
	return bundles.get(entry)!;
};

const T0 = Date.parse("2026-10-20T19:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
/** A valid W5 snapshot for role ops (shape as tests/unit/usage-accounting-roles-wiring.test.ts). */
function snapshot(epoch: string, sequence: number, at: number): UsageMeterSnapshot {
	const t = iso(at);
	return {
		v: "usage-meter-snapshot/1",
		reportingOnly: true,
		generation: { epoch, sequence },
		evaluatedAt: t,
		weekStart: "2026-10-19",
		state: "ready",
		storage: "healthy",
		inventory: "complete",
		oldestCoveredThrough: t,
		oldestObservedAt: t,
		sources: [
			{
				index: 0,
				kind: "pi",
				required: true,
				enabled: true,
				state: "complete",
				complete_through: t,
				observedAt: t,
				lastProgressAt: t,
				stalled: false,
				alarm: null,
			},
		],
		subjects: [
			{
				subject: { kind: "role", role: "ops" },
				window: { from: "2026-10-19T07:00:00.000Z", through: t },
				usageCoverage: "complete",
				fundingCoverage: "not-evaluated",
				freshness: "fresh",
				coveredThrough: t,
				observedAt: t,
				list: { grossObservations: "1.5", deduplicatedRecorded: "1.5" },
				otherBases: [],
				counts: { unpriced: 0, unresolvedIdentities: 0 },
				funding: null,
				faults: [],
			},
		],
		faults: [],
	};
}
const pass = (over: Record<string, unknown> = {}) => ({
	kind: "pass",
	status: "fresh",
	sequence: 1,
	asOf: iso(T0),
	snapshot: null,
	w5Ms: 5,
	workMs: 3,
	bytesRead: 0,
	ledgerBytes: 0,
	backlogFiles: 0,
	code: null,
	...over,
});

/** A host around a stand-in Worker: ticks are recorded, passes are delivered by hand (or never: skipped passes). */
function harness(
	over: Partial<UsageAccountingOptions> = {},
	first: UsageRoleWitness | Error = { roles: ["ops"], sessions: [["s-1", "ops"]] },
) {
	const dir = temp();
	mkdirSync(join(dir, "sessions"));
	let clock = T0;
	const ticks: Record<string, unknown>[] = [];
	const logs: string[] = [];
	let deliver!: (m: unknown) => void;
	let tickResult = true;
	let closed = 0;
	const start = ((_entry, _data, onMessage) => {
		deliver = onMessage;
		return {
			tick: (payload?: Record<string, unknown>) => {
				if (!tickResult) return false;
				ticks.push(payload ?? {});
				return true;
			},
			close: async () => {
				closed++;
			},
			worker: {} as UsagePassHost["worker"],
		};
	}) as typeof startUsagePassWorker;
	let wanted = false;
	let witness = first;
	let published = 0;
	const accounting = startUsageAccounting({
		dataDir: join(dir, "data"),
		sessionRoots: [join(dir, "sessions")],
		temperRoots: [],
		ledgerDirectory: null,
		production: "disabled",
		witness: async () => {
			if (witness instanceof Error) throw witness;
			return witness;
		},
		wanted: () => wanted,
		onPublish: () => published++,
		log: (line) => logs.push(line),
		now: () => clock,
		intervalMs: 3_600_000,
		summaryMs: 3_600_000,
		start,
		...over,
	});
	running.push(accounting);
	const roles = (at = clock) =>
		roleUsageCost(
			{
				usageMeterCache: () => accounting.cache(),
				usageMeterFirstObservedAt: (g: { epoch: string; sequence: number }) => accounting.firstObservedAt(g),
			} as unknown as RolesOverviewHost,
			"ops",
			at,
		);
	return {
		accounting,
		ticks,
		logs,
		roles,
		deliver: (m: unknown) => deliver(m),
		advance: (ms: number) => (clock += ms),
		get clock() {
			return clock;
		},
		setWanted: (v: boolean) => (wanted = v),
		setWitness: (v: UsageRoleWitness | Error) => (witness = v),
		setTickResult: (v: boolean) => (tickResult = v),
		get published() {
			return published;
		},
		get closed() {
			return closed;
		},
	};
}
const settle = () => new Promise((r) => setImmediate(r));

describe("usage-accounting host (B4)", () => {
	it("raises the 300 s alarm when passes stop arriving, shows it on the Roles view, and clears it on the next publish", async () => {
		const h = harness();
		await settle();
		const { epoch } = h.accounting;
		h.deliver(pass({ sequence: 1, snapshot: snapshot(epoch, 1, T0) }));
		expect(h.roles().state).toBe("ready");
		// The passes stop: ticks go out, nothing comes back.
		h.advance(61_000);
		await h.accounting.step();
		// After 60 s the cache marks it stale by itself; the alarm is not up yet.
		expect(h.roles()).toMatchObject({ state: "stale", faults: [{ code: "worker-stale", count: 1 }] });
		expect(h.logs.some((l) => l.includes("ALARM"))).toBe(false);
		h.advance(238_999);
		await h.accounting.step();
		expect(h.roles().state).toBe("stale");
		h.advance(1);
		await h.accounting.step();
		// 300 s without a finished pass: the dead man's switch, visible on the Roles view.
		expect(h.roles()).toMatchObject({ state: "unavailable", faults: [{ code: "worker-unavailable", count: 1 }] });
		expect(h.logs.filter((l) => l.includes("ALARM: no pass has finished for 300 s"))).toHaveLength(1);
		await h.accounting.step();
		expect(h.logs.filter((l) => l.includes("ALARM"))).toHaveLength(1);
		// While alarmed every tick asks for a W5 build, so the next pass can publish.
		expect(h.ticks.at(-1)).toMatchObject({ build: true });
		h.advance(30_000);
		h.deliver(pass({ sequence: 2, asOf: iso(h.clock), snapshot: snapshot(epoch, 2, h.clock) }));
		expect(h.roles(h.clock).state).toBe("ready");
		expect(h.logs.some((l) => l.includes("alarm cleared"))).toBe(true);
		// The publish cleared both the alarm and the health note (Architecture K9): with no Roles window open, the next
		// tick asks for no W5 build.
		await h.accounting.step();
		expect(h.ticks.at(-1)).toEqual({ build: false });
		// A second silence raises the alarm again, in the log and on the Roles view.
		h.advance(300_000);
		await h.accounting.step();
		expect(h.logs.filter((l) => l.includes("ALARM: no pass has finished for 300 s"))).toHaveLength(2);
		expect(h.roles(h.clock)).toMatchObject({
			state: "unavailable",
			faults: [{ code: "worker-unavailable", count: 1 }],
		});
	});

	it("raises the alarm with no snapshot ever published, and when the Worker never answers its first tick", async () => {
		const h = harness();
		await settle();
		expect(h.ticks).toHaveLength(1);
		h.advance(300_000);
		await h.accounting.step();
		expect(h.logs.some((l) => l.includes("ALARM"))).toBe(true);
		expect(h.accounting.cache()?.get(iso(h.clock))).toBeNull();
	});

	it("keeps the native receipt: the pass time that first saw new bytes, pinned to the generation that published them", async () => {
		const h = harness();
		await settle();
		const { epoch } = h.accounting;
		h.deliver(pass({ sequence: 1, snapshot: snapshot(epoch, 1, T0) }));
		expect(h.accounting.firstObservedAt({ epoch, sequence: 1 })).toBeNull();
		// New bytes seen by a pass that did not build W5 (no Roles window); published by a later pass.
		const seen = T0 + 30_000;
		h.advance(30_000);
		h.deliver(pass({ sequence: 2, asOf: iso(seen), ledgerBytes: 420 }));
		h.advance(30_000);
		h.deliver(pass({ sequence: 3, asOf: iso(h.clock), bytesRead: 10, snapshot: snapshot(epoch, 3, h.clock) }));
		expect(h.accounting.firstObservedAt({ epoch, sequence: 3 })).toBe(seen);
		expect(h.roles(h.clock).firstNativeObservedAt).toBe(seen);
		// Another epoch or generation: unknown, never borrowed.
		expect(h.accounting.firstObservedAt({ epoch: "f".repeat(64), sequence: 3 })).toBeNull();
		expect(h.accounting.firstObservedAt({ epoch, sequence: 2 })).toBeNull();
		h.advance(30_000);
		h.deliver(pass({ sequence: 4, asOf: iso(h.clock), snapshot: snapshot(epoch, 4, h.clock) }));
		expect(h.accounting.firstObservedAt({ epoch, sequence: 4 })).toBeNull();
		expect(h.published).toBe(3);
	});

	it("builds W5 for the first pass, while a Roles window is open, and not otherwise; sends the witness only when it changed", async () => {
		const h = harness();
		await settle();
		expect(h.ticks[0]).toEqual({ build: true, witness: { roles: ["ops"], sessions: [["s-1", "ops"]] } });
		h.deliver(pass({ sequence: 1, snapshot: snapshot(h.accounting.epoch, 1, T0) }));
		await h.accounting.step();
		expect(h.ticks[1]).toEqual({ build: false });
		h.setWanted(true);
		h.setWitness({
			roles: ["ops"],
			sessions: [
				["s-1", "ops"],
				["s-2", "ops"],
			],
		});
		h.deliver(pass({ sequence: 2 }));
		await h.accounting.step();
		expect(h.ticks[2]).toEqual({
			build: true,
			witness: {
				roles: ["ops"],
				sessions: [
					["s-1", "ops"],
					["s-2", "ops"],
				],
			},
		});
		// A refused tick (one outstanding) keeps the new witness for the next tick that goes out.
		h.setWitness({ roles: ["ops", "qa"], sessions: [] });
		h.setTickResult(false);
		await h.accounting.step();
		h.setTickResult(true);
		await h.accounting.step();
		expect(h.ticks[3]).toEqual({ build: true, witness: { roles: ["ops", "qa"], sessions: [] } });
	});

	it("never starts the week without a witness: no tick until one is read, then the last good one stays", async () => {
		const h = harness({}, new Error("no registry"));
		await settle();
		expect(h.ticks).toHaveLength(0);
		await h.accounting.step();
		expect(h.ticks).toHaveLength(0);
		expect(h.logs.filter((l) => l.includes("role witness unreadable"))).toHaveLength(1);
		h.setWitness({ roles: ["ops"], sessions: [] });
		await h.accounting.step();
		expect(h.ticks).toEqual([{ build: true, witness: { roles: ["ops"], sessions: [] } }]);
		h.deliver(pass({ sequence: 1 }));
		h.setWitness(new Error("gone again"));
		await h.accounting.step();
		expect(h.ticks[1]).toEqual({ build: true });
	});

	it("shows a refused pass and a lost Worker on the Roles view, with the Worker's code in the log and no restart", async () => {
		const h = harness();
		await settle();
		const { epoch } = h.accounting;
		h.deliver(pass({ sequence: 1, snapshot: snapshot(epoch, 1, T0) }));
		h.advance(1_000);
		h.deliver(pass({ sequence: 1, status: "unavailable", code: "waiting-for-previous-writer" }));
		expect(h.roles(h.clock)).toMatchObject({
			state: "waiting-for-previous-writer",
			faults: [{ code: "waiting-for-previous-writer" }],
		});
		h.advance(1_000);
		h.deliver({ kind: "worker-unavailable", code: "usage-pass-inventory-input" });
		expect(h.roles(h.clock)).toMatchObject({ state: "unavailable", faults: [{ code: "worker-unavailable" }] });
		expect(h.logs.some((l) => l.includes("pass worker lost (usage-pass-inventory-input)"))).toBe(true);
		const before = h.ticks.length;
		await h.accounting.step();
		expect(h.ticks).toHaveLength(before);
		await h.accounting.stop();
		await h.accounting.stop();
		expect(h.closed).toBe(1);
	});

	it("refuses session roots the Worker would refuse, before any Worker starts", () => {
		const dir = temp();
		mkdirSync(join(dir, "real"));
		symlinkSync(join(dir, "real"), join(dir, "link"));
		writeFileSync(join(dir, "file"), "");
		expect(checkSessionRoots([])).toBe("no session root");
		expect(checkSessionRoots(["relative/sessions"])).toMatch(/not absolute/);
		expect(checkSessionRoots([join(dir, "missing")])).toMatch(/missing/);
		expect(checkSessionRoots([join(dir, "file")])).toMatch(/not a directory/);
		expect(checkSessionRoots([join(dir, "link")])).toMatch(/real path/);
		expect(checkSessionRoots([`${join(dir, "real")}/`])).toMatch(/real path/);
		expect(checkSessionRoots([join(dir, "real")])).toBeNull();
		let started = false;
		expect(() =>
			startUsageAccounting({
				dataDir: join(dir, "data"),
				sessionRoots: [join(dir, "link")],
				temperRoots: [],
				ledgerDirectory: null,
				production: "disabled",
				witness: async () => ({ roles: [], sessions: [] }),
				wanted: () => false,
				start: (() => {
					started = true;
					throw new Error("must not start");
				}) as typeof startUsagePassWorker,
			}),
		).toThrow(/real path/);
		expect(started).toBe(false);
	});

	it("reads the ledger writer's switch the way the writer does", () => {
		const dir = temp();
		expect(usageLedgerProduction(dir)).toBe("enabled");
		writeFileSync(join(dir, "usage-ledger.json"), JSON.stringify({ enabled: false }));
		expect(usageLedgerProduction(dir)).toBe("disabled");
		writeFileSync(join(dir, "usage-ledger.json"), JSON.stringify({ enabled: true }));
		expect(usageLedgerProduction(dir)).toBe("enabled");
		writeFileSync(join(dir, "usage-ledger.json"), "{");
		expect(usageLedgerProduction(dir)).toBe("unknown");
	});

	it("checks the witness in the Worker: anything off keeps the previous one", () => {
		expect(readWitness({ roles: ["ops"], sessions: [["s-1", "ops"]] })?.sessions.get("s-1")).toBe("ops");
		expect(readWitness({ roles: ["Ops"], sessions: [] })).toBeNull();
		expect(readWitness({ roles: ["ops", "ops"], sessions: [] })).toBeNull();
		expect(readWitness({ roles: ["ops"], sessions: [["s-1", "qa"]] })).toBeNull();
		expect(
			readWitness({
				roles: ["ops", "qa"],
				sessions: [
					["s-1", "ops"],
					["s-1", "qa"],
				],
			}),
		).toBeNull();
		expect(readWitness({ roles: ["ops"], sessions: [["bad id/..", "ops"]] })).toBeNull();
		expect(readWitness({ roles: Array.from({ length: 257 }, (_, i) => `r${i}`), sessions: [] })).toBeNull();
		expect(readWitness(null)).toBeNull();
	});

	it("passes the Worker's error code on when it is lost (Architecture #289 note 2)", async () => {
		const messages: unknown[] = [];
		const host = startUsagePassWorker(
			'const e = new Error("refused"); e.code = "usage-pass-inventory-input"; throw e;',
			{},
			(m) => messages.push(m),
			{ eval: true },
		);
		await new Promise((done) => host.worker.once("exit", done));
		expect(messages).toEqual([{ kind: "worker-unavailable", code: "usage-pass-inventory-input" }]);
		await host.close();
	});

	it("counts only full Roles windows as wanting W5", () => {
		const watch = new RolesWatch<string>(async () => ({}) as never, { fullMs: 3_600_000, countMs: 3_600_000 });
		watch.watch("a", false, () => {});
		expect(watch.fullWatching).toBe(0);
		watch.watch("b", true, () => {});
		expect(watch.fullWatching).toBe(1);
		watch.drop("b");
		expect(watch.fullWatching).toBe(0);
		watch.stop();
	});

	it("runs the real Worker: each chat's facts reach its role through the witness, and stay unknown without it", async () => {
		const code = await bundle("../../server/usage-accounting-pass-worker.ts");
		// The fixture's calls, moved to a few minutes ago so they fall in the current week.
		const base = Date.now() - 5 * 60_000;
		const text = readFileSync(join(fixtures, "usage-accounting-pi-sessions", "plain.jsonl"), "utf8").replace(
			/2026-10-19T08:(\d\d):(\d\d)\.000Z/g,
			(_, m: string, s: string) => iso(base + (Number(m) * 60 + Number(s)) * 1000),
		);
		const run = async (witness: UsageRoleWitness) => {
			const dir = temp();
			mkdirSync(join(dir, "sessions", "cwd"), { recursive: true, mode: 0o700 });
			mkdirSync(join(dir, "data"), { mode: 0o700 });
			const file = join(dir, "sessions", "cwd", "plain.jsonl");
			writeFileSync(file, text);
			const at = new Date();
			utimesSync(file, at, at);
			let published!: () => void;
			const done = new Promise<void>((r) => (published = r));
			const accounting = startUsageAccounting({
				dataDir: join(dir, "data"),
				sessionRoots: [join(dir, "sessions")],
				temperRoots: [],
				ledgerDirectory: null,
				production: "disabled",
				witness: async () => witness,
				wanted: () => true,
				onPublish: () => published(),
				log: () => {},
				intervalMs: 3_600_000,
				summaryMs: 3_600_000,
				entry: code,
				eval: true,
			});
			running.push(accounting);
			await done;
			const snap = accounting.cache()?.get(new Date().toISOString());
			await accounting.stop();
			return snap!;
		};
		const roles = ["design", "ops"];
		const witnessed = await run({ roles, sessions: [["session-plain", "design"]] });
		const design = witnessed.subjects.find((s) => s.subject.kind === "role" && s.subject.role === "design")!;
		const ops = witnessed.subjects.find((s) => s.subject.kind === "role" && s.subject.role === "ops")!;
		expect(Number(design.list?.grossObservations)).toBeGreaterThan(0);
		expect(design.faults.map((f) => f.code)).not.toContain("invalid-subject-binding");
		expect(ops.list?.grossObservations).toMatch(/^0(\.0+)?$/);
		const unwitnessed = await run({ roles, sessions: [] });
		const blind = unwitnessed.subjects.find((s) => s.subject.kind === "role" && s.subject.role === "design")!;
		expect(blind.faults.map((f) => f.code)).toContain("invalid-subject-binding");
		expect(blind.list?.grossObservations).toMatch(/^0(\.0+)?$/);
	}, 60_000);

	it("keeps each fact's first-staged role when a later witness names another role (Architecture K4)", async () => {
		const code = await bundle("../../server/usage-accounting-pass-worker.ts");
		const base = Date.now() - 5 * 60_000;
		const text = readFileSync(join(fixtures, "usage-accounting-pi-sessions", "plain.jsonl"), "utf8").replace(
			/2026-10-19T08:(\d\d):(\d\d)\.000Z/g,
			(_, m: string, s: string) => iso(base + (Number(m) * 60 + Number(s)) * 1000),
		);
		const dir = temp();
		mkdirSync(join(dir, "sessions", "cwd"), { recursive: true, mode: 0o700 });
		mkdirSync(join(dir, "data"), { mode: 0o700 });
		const file = join(dir, "sessions", "cwd", "plain.jsonl");
		writeFileSync(file, text);
		const at = new Date();
		utimesSync(file, at, at);
		let witness: UsageRoleWitness = { roles: ["design", "ops"], sessions: [["session-plain", "design"]] };
		const waiting: (() => void)[] = [];
		const published = () => new Promise<void>((r) => waiting.push(r));
		const first = published();
		const accounting = startUsageAccounting({
			dataDir: join(dir, "data"),
			sessionRoots: [join(dir, "sessions")],
			temperRoots: [],
			ledgerDirectory: null,
			production: "disabled",
			witness: async () => witness,
			wanted: () => true,
			onPublish: () => {
				for (const r of waiting.splice(0)) r();
			},
			log: () => {},
			intervalMs: 3_600_000,
			summaryMs: 3_600_000,
			entry: code,
			eval: true,
		});
		running.push(accounting);
		const gross = (snap: UsageMeterSnapshot | null | undefined, role: string) =>
			snap?.subjects.find((s) => s.subject.kind === "role" && s.subject.role === role)?.list?.grossObservations;
		await first;
		const before = accounting.cache()?.get(new Date().toISOString());
		expect(Number(gross(before, "design"))).toBeGreaterThan(0);
		// The witness now names ops for the same chat. The next pass reads nothing new and builds W5 again.
		witness = { roles: ["design", "ops"], sessions: [["session-plain", "ops"]] };
		const second = published();
		await accounting.step();
		await second;
		const after = accounting.cache()?.get(new Date().toISOString());
		expect(after?.generation.sequence).toBeGreaterThan(before?.generation.sequence ?? Infinity);
		expect(gross(after, "design")).toBe(gross(before, "design"));
		expect(gross(after, "ops")).toMatch(/^0(\.0+)?$/);
	}, 60_000);

	it("index.ts runs B4 as reviewed: wanted follows full Roles windows, a 0700 folder, a stop at shutdown bounded by 3 s", async () => {
		const real = readFileSync(join(project, "server", "index.ts"), "utf8");
		const base = await indexB4(real);
		expect(base).toEqual({
			wanted: [false, true, false],
			folder: { mode: 0o700, private: true },
			stop: 1,
			race: { delay: 3000, waited: true, gaveUp: true },
		});
		// Controls (Architecture K6c, K12a, K13a, K13b): each reviewed mutation changes its own property and no other,
		// and the reviewed text kept in a comment does not count.
		const mutate = (from: string, to: string) => {
			expect(real.split(from)).toHaveLength(2);
			return real.replace(from, to);
		};
		const controls = [
			[
				"wanted",
				mutate(
					"wanted: () => rolesWatch.fullWatching > 0,",
					"wanted: () => false, // wanted: () => rolesWatch.fullWatching > 0,",
				),
			],
			[
				"folder",
				mutate(
					"mkdirSync(dataDir, { recursive: true, mode: 0o700 });",
					"mkdirSync(dataDir, { recursive: true, mode: 0o755 }); // mode: 0o700",
				),
			],
			[
				"stop",
				mutate(
					"const usageStopped = usageAccounting?.stop().catch(() => {});",
					"const usageStopped = Promise.resolve(); // usageAccounting?.stop().catch(() => {});",
				),
			],
			[
				"race",
				mutate(
					"if (usageStopped) await Promise.race([usageStopped, new Promise((done) => setTimeout(done, 3000).unref())]);",
					"if (usageStopped) await usageStopped; // Promise.race([usageStopped, setTimeout(done, 3000)])",
				),
			],
		] as const;
		for (const [name, source] of controls) {
			const got = await indexB4(source);
			for (const key of ["wanted", "folder", "stop", "race"] as const)
				if (key === name) expect(got[key], name).not.toEqual(base[key]);
				else expect(got[key], `${name} leaves ${key}`).toEqual(base[key]);
		}
	});
});

const project = fileURLToPath(new URL("../..", import.meta.url));

/**
 * B4's block in server/index.ts, run for real with stand-ins (Architecture's T3): startUsageMeter and shutdown's two
 * usage lines, taken from the source with comments stripped by esbuild, so text in a comment never counts. index.ts
 * itself is never imported or started (the roles-wiring tests run its roles_watch case the same way).
 */
async function indexB4(source: string) {
	const slice = (head: string) => {
		const i = source.indexOf(head);
		const j = i < 0 ? -1 : source.indexOf("\n}\n", i);
		if (j < 0) throw new Error(`server/index.ts has no ${head}`);
		return source.slice(i, j + 2);
	};
	const js = async (ts: string) => (await transform(ts, { loader: "ts", format: "esm", target: "esnext" })).code;
	// startUsageMeter: a real data folder; the options it gives startUsageAccounting are kept.
	const root = temp();
	const modes: unknown[] = [];
	const watch = { fullWatching: 0, poke() {} };
	const got: { options?: UsageAccountingOptions } = {};
	new Function(
		"service",
		"rolesWatch",
		"DATA_DIR",
		"startUsageAccounting",
		"usageLedgerProduction",
		"usageRoleWitness",
		"getAgentDir",
		"join",
		"resolve",
		"existsSync",
		"mkdirSync",
		"console",
		"process",
		`let usageAccounting = null;\n${await js(slice("function startUsageMeter(): void {"))}\nstartUsageMeter();`,
	)(
		{ usageAccounting: null, readRolesOverview() {} },
		watch,
		root,
		(options: UsageAccountingOptions) => {
			got.options = options;
			return { stop: async () => {} };
		},
		() => "enabled",
		async () => ({ roles: [], sessions: [] }),
		() => root,
		join,
		resolve,
		existsSync,
		(path: string, options: { mode?: number }) => {
			modes.push(options?.mode);
			return mkdirSync(path, options);
		},
		{ log() {}, error() {} },
		{ env: {} },
	);
	const wanted: (boolean | null)[] = [];
	for (const n of [0, 1, 0]) {
		watch.fullWatching = n;
		wanted.push(got.options ? got.options.wanted() : null);
	}
	const folder = got.options?.dataDir;
	// shutdown: its stop line run against a host whose stop never settles, and its bounded wait run on such a stop.
	const down = await js(slice("async function shutdown("));
	const at = down.indexOf("const usageStopped = ");
	const stopLine = at < 0 ? "" : down.slice(at, down.indexOf(";\n", at) + 1);
	const waitLine = down.split("\n").find((l) => l.includes("usageStopped") && l.includes("await")) ?? "";
	let stops = 0;
	new Function("usageAccounting", stopLine)({
		stop: () => {
			stops++;
			return new Promise(() => {});
		},
	});
	const delays: number[] = [];
	const timers: (() => void)[] = [];
	let settled = false;
	const waiting = new Function("usageStopped", "setTimeout", `return (async () => {\n${waitLine}\n})();`)(
		new Promise(() => {}),
		(done: () => void, ms: number) => {
			delays.push(ms);
			timers.push(done);
			return { unref: () => undefined };
		},
	) as Promise<void>;
	void waiting.then(() => (settled = true));
	await new Promise((r) => setImmediate(r));
	const waited = !settled;
	for (const done of timers.splice(0)) done();
	await new Promise((r) => setImmediate(r));
	return {
		wanted,
		folder: {
			mode: modes.length === 1 ? modes[0] : modes,
			private: !!folder && existsSync(folder) && (statSync(folder).mode & 0o077) === 0,
		},
		stop: stops,
		race: { delay: delays.length === 1 ? delays[0] : delays, waited, gaveUp: settled },
	};
}
