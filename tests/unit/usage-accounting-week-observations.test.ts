// Ops #500 (docs/usage-accounting-week-store.md, "All observations"): the week store keeps every typed observation B3
// actually has (verified and unresolved facts, with or without a responseId, revisions, aliases, allocations, roots,
// policies, memberships, run snapshots, source coverage and W5's role witnesses) in a closed observations log that
// the week's checkpoint commits together with its numeric records and cursors, and replays it in bounded, hash-checked
// pages. Tested stage by stage on fixed synthetic cases (rule 16). Hypothesis H-B2-OBS: literal rows replay exactly as
// appended, gaps stay gaps, and no crash, damage or B2-written week yields a complete replay or a cursor past what was
// committed; it is wrong if a replayed row differs from the appended one, an id, provider, model, kind, responseId or
// payer appears that was not given, a numeric-only week reads as complete, or a cap is exceeded. Each case runs the
// real store in a Worker with W0's resource limits on a temporary folder
// (tests/unit/usage-accounting-week-observations-fixture.ts); nothing is mocked but the clock and the named crash
// points, and no chat file is read.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { METER_WORKER_RESOURCE_LIMITS } from "../../server/usage-accounting-meter-contract.js";

const roots: string[] = [];
const workers = new Set<Worker>();
afterEach(async () => {
	await Promise.all([...workers].map((worker) => worker.terminate()));
	workers.clear();
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixtureDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "usage-week-observations-"));
	roots.push(dir);
	return dir;
}

// The esbuild Worker pattern of B2's own test; the bundle stays in memory, nothing is written to the checkout.
let bundle: Promise<string> | undefined;
function bundledWorker(): Promise<string> {
	return (bundle ??= (async () => {
		const compiled = await build({
			entryPoints: [fileURLToPath(new URL("./usage-accounting-week-observations-fixture.ts", import.meta.url))],
			bundle: true,
			platform: "node",
			target: "node22",
			format: "cjs",
			write: false,
			logLevel: "silent",
		});
		if (compiled.outputFiles?.length !== 1) throw new Error("usage-week-observations-fixture-bundle");
		return compiled.outputFiles[0].text;
	})());
}
async function runCase(caseName: string, extra: Record<string, unknown> = {}): Promise<unknown> {
	const worker = new Worker(await bundledWorker(), {
		eval: true,
		resourceLimits: { ...METER_WORKER_RESOURCE_LIMITS },
		workerData: { caseName, dir: fixtureDir(), lease: new SharedArrayBuffer(4), extra },
	});
	workers.add(worker);
	return new Promise<unknown>((done, fail) => {
		let settled = false;
		worker.once("error", fail);
		worker.once("message", (message) => {
			settled = true;
			if (message?.kind === "result") done(message.value);
			else fail(new Error(String(message?.code ?? "usage-week-observations-fixture-message")));
		});
		worker.once("exit", (code) => {
			if (!settled) fail(new Error(`usage-week-observations-fixture-exit:${code}`));
		});
	});
}

describe("usage-accounting week observations: literal rows replay exactly", () => {
	it("replays each literal row as appended, in pages, and writes no row for the unverified attempt or the gap", async () => {
		// The fixture builds each line itself and checks the store wrote exactly those bytes; this pins them, with the
		// verified fact that has no responseId (its attempt is its entry id, its price unpriced) written out in full.
		expect(await runCase("literalReplay")).toEqual({
			sha256: "eef651c91ec16c4bc5f286272dfdf548953f3565155121c6965b0c0683a6acd2",
			bytes: 8542,
			line:
				'{"k":"c59c0a7d980264e5dd39c865312ad0c175bddc40889ee69cf8eca8fa25e655c4","o":"fact","p":"open","rk":"f867ca1d5b63b84222b573e4cfbbbac027a84fb5bcffbe5900b0c3620c59a5b7",' +
				'"r":{"id":"[\\"usage-fact/1\\",\\"pi\\",\\"session-7f3a\\",\\"entry-0002\\"]","identity":{"attempt":"entry-0002","incarnation":"session-7f3a","producer":"pi"},' +
				'"identityStatus":"verified","kind":"compaction","links":{"run":null,"session":"session-7f3a","task":null},' +
				'"model":"claude-opus-4-5","occurredAt":"2026-10-20T15:09:00.000Z",' +
				'"prices":[{"amount":null,"basis":"list-estimate","currency":"USD","rateVersion":null,"status":"unpriced"}],' +
				'"provider":"anthropic","revision":0,' +
				'"source":{"coverage":"complete","event":"entry-0002","observedAt":"2026-10-20T15:09:01.000Z","stream":"pi-session:7f3a"},' +
				'"supersedes":null,"tokens":{"cacheRead":null,"cacheWrite":null,"input":9000,"output":1500},"v":"usage-fact/1"}}\n',
		});
	});
	it("shows the gap it closes: B2's records and receipts alone give back only the receipt's fact", async () => {
		// Also run on B2's code (6dc6a396), where it gives the same: the rows below have no other way back.
		expect(await runCase("numericOnly")).toEqual({
			records: 7,
			recovered: ["f1"],
			missing: ["w1", "f2", "w2", "f3", "a2", "f4", "l4", "m", "root", "f5", "a1", "snap", "policy", "cov", "f5r1"],
		});
	});
	it("leaves the bytes of B2's log and receipts as B2 wrote them; only the checkpoint's version changes", async () => {
		expect(await runCase("legacySource")).toEqual({
			log: true,
			receipts: true,
			checkpoint: false,
			version: "usage-week-checkpoint/2",
			observations: null,
		});
	});
	it("keeps a re-read fact once, with its first read's time, and a revision, other content and a conflicting witness beside it", async () => {
		expect(await runCase("dedupe")).toEqual({
			rows: 7,
			records: 7,
			sameRevision: { appended: 0, duplicates: 0, observations: 1, observationDuplicates: 0, unobserved: 0 },
		});
	});
	it("counts originals committed without their fact, and never upgrades coverage afterwards", async () => {
		expect(await runCase("partialCoverage")).toEqual({
			committed: { state: "partial", observations: 2, unobserved: 3, dropped: 0 },
			dropped: 1160,
		});
	});
});

describe("usage-accounting week observations: refusals write nothing", () => {
	it("refuses unknown kinds, invented fields, dangling bindings, other weeks and lowered caps, all or none", async () => {
		const refused = "invalid-observation";
		expect(await runCase("refusals")).toEqual({
			"unknown-kind": refused,
			"extra-key": refused,
			"no-rk": refused,
			"rk-not-hex": refused,
			"rk-unknown": refused,
			"fact-id-mismatch": refused,
			"fact-responseId-added": refused,
			"fact-payer-added": refused,
			"fact-status-invented": refused,
			"fact-revision-chain": refused,
			"fact-price-guessed": refused,
			"role-uppercase": refused,
			"role-not-reference": refused,
			"role-producer": refused,
			"role-extra-key": refused,
			"role-evidence-missing": refused,
			"allocation-payer-without-root": refused,
			"allocation-native-without-root": refused,
			"not-ascii": refused,
			"fact-before-week": "wrong-week",
			"fact-at-week-end": "wrong-week",
			"all-or-none": refused,
			"not-an-array": "store-capacity",
			"not-loaded": "not-loaded",
			"coverage-not-loaded": "not-loaded",
			"invalid-week": "invalid-week",
			"cap-line": refused,
			"cap-count": "store-capacity",
			"cap-bytes": "store-capacity",
			"cap-week": "store-capacity",
		});
	});
});

// Each crash: the week reloads exactly as committed before the step (or after it, once the step's checkpoint is in
// place), with every uncommitted byte cut and nothing replayed from it; the step done again then ends byte for byte as
// a run without the crash. "name@n" is the n-th time (from 0) a point is reached in the step; ":short" a short write;
// a third part crashes the first reload's cut too. Steps: open (a week with a committed batch), first (a new week),
// only (observations alone), adjust (a sealed week's late batch) and bare (a sealed week that had no observations log).
const CRASHES: [string, boolean][] = [
	["open/log-write", false],
	["open/log-write:short", false],
	["open/log-sync", false],
	["open/after-log-sync", false],
	["open/header-write", false],
	["open/header-write:short", false],
	["open/header-sync", false],
	["open/header-rename", false],
	["open/after-header-rename", false],
	["open/receipts-write", false],
	["open/receipts-write:short", false],
	["open/after-receipts-sync", false],
	["open/observations-write", false],
	["open/observations-write:short", false],
	["open/observations-sync", false],
	["open/after-observations-sync", false],
	["open/after-observations-sync/truncate", false],
	["open/after-observations-sync/truncate@1", false],
	["open/checkpoint-write", false],
	["open/checkpoint-write:short", false],
	["open/checkpoint-sync", false],
	["open/checkpoint-rename", false],
	["open/checkpoint-rename/truncate@2", false],
	["open/after-checkpoint-rename", true],
	["first/header-write", false],
	["first/after-header-rename", false],
	["first/after-log-sync", false],
	["first/header-write@1", false],
	["first/after-header-rename@1", false],
	["first/after-receipts-sync", false],
	["first/header-write@2", false],
	["first/header-write@2:short", false],
	["first/header-sync@2", false],
	["first/header-rename@2", false],
	["first/after-header-rename@2", false],
	["first/observations-write", false],
	["first/observations-write:short", false],
	["first/after-observations-sync", false],
	["first/checkpoint-rename", false],
	["first/after-checkpoint-rename", true],
	["only/after-header-rename", false],
	["only/header-write@1", false],
	["only/after-header-rename@1", false],
	["only/observations-write:short", false],
	["only/after-observations-sync", false],
	["only/checkpoint-rename", false],
	["only/after-checkpoint-rename", true],
	["adjust/after-header-rename", false],
	["adjust/adjust-write:short", false],
	["adjust/after-adjust-sync", false],
	["adjust/observations-write", false],
	["adjust/observations-write:short", false],
	["adjust/observations-sync", false],
	["adjust/after-observations-sync", false],
	["adjust/after-observations-sync/truncate", false],
	["adjust/checkpoint-write", false],
	["adjust/checkpoint-rename", false],
	["adjust/after-checkpoint-rename", true],
	["bare/after-header-rename", false],
	["bare/header-write@1", false],
	["bare/after-header-rename@1", false],
	["bare/observations-write:short", false],
	["bare/after-observations-sync", false],
	["bare/checkpoint-rename", false],
	["bare/after-checkpoint-rename", true],
];

describe("usage-accounting week observations: every crash point keeps exactly the committed prefix", () => {
	it.each(CRASHES)("%s", async (variant, committed) => {
		const got = (await runCase("crash", { variant })) as { code: string; committed: boolean };
		expect({ code: got.code, committed: got.committed }).toEqual({ code: "io-failure", committed });
	});
	it("commits a header-only log after a torn first write, and replays it as nothing, hash-checked", async () => {
		expect(await runCase("emptyCommit")).toEqual({ code: "io-failure" });
	});
});

describe("usage-accounting week observations: damage gives unavailable or a refused replay, never fewer rows", () => {
	it.each([
		["missing", { load: "observations-missing", after: "week-unavailable" }],
		["flip", { load: "observations-mismatch", after: "week-unavailable" }],
		["truncated", { load: "observations-mismatch", after: "week-unavailable" }],
		["empty", { load: "observations-corrupt", after: "week-unavailable" }],
		["header-version", { load: "store-version", after: "week-unavailable" }],
		["header-week", { load: "observations-corrupt", after: "week-unavailable" }],
		["header-family", { load: "observations-corrupt", after: "week-unavailable" }],
		["count", { load: "observations-mismatch", after: "week-unavailable" }],
		["sha", { load: "observations-mismatch", after: "week-unavailable" }],
		["length", { load: "observations-mismatch", after: "week-unavailable" }],
		["unobserved-high", { load: "checkpoint-corrupt", after: "week-unavailable" }],
		["unobserved-negative", { load: "checkpoint-corrupt", after: "week-unavailable" }],
		["no-observations-key", { load: "checkpoint-corrupt", after: "week-unavailable" }],
		["checkpoint-v3", { load: "store-version", after: "week-unavailable" }],
		["v1-with-observations", { load: "checkpoint-corrupt", after: "week-unavailable" }],
		["extra-key", { load: "checkpoint-corrupt", after: "week-unavailable" }],
		["duplicate-line", { load: "observations-corrupt", after: "week-unavailable" }],
		["reordered", { load: "open", replay: "observations-corrupt", after: "week-unavailable" }],
		["wrong-key", { load: "open", replay: "observations-corrupt", after: "week-unavailable" }],
		["bad-row", { load: "open", replay: "observations-corrupt", after: "week-unavailable" }],
		["bad-phase", { load: "open", replay: "observations-corrupt", after: "week-unavailable" }],
		["torn-tail", { load: "open", replay: "no-error", after: "no-error", rows: 15, dropped: 8, cut: true }],
		["uncommitted-line", { load: "open", replay: "no-error", after: "no-error", rows: 15, dropped: 1054, cut: true }],
		["symlink", { reload: "unsafe-path", store: { state: "unavailable", code: "unsafe-path" } }],
		["mode", { reload: "permission-denied", store: { state: "unavailable", code: "permission-denied" } }],
	])("%s", async (variant, result) => {
		expect(await runCase("integrity", { variant })).toEqual(result);
	});
	it.each([["append"], ["replace"]])("a file changed between two pages (%s) refuses the stream", async (variant) => {
		expect(await runCase("betweenPages", { variant })).toEqual({
			next: "observations-mismatch",
			after: "week-unavailable",
		});
	});
	it("a file rewritten in place between two pages (two later lines swapped) fails the stream at its last page", async () => {
		expect(await runCase("betweenPages", { variant: "rewrite" })).toEqual({
			// 15 committed rows in pages of 4: the first page before the rewrite, two served after it, the last (3) refused.
			served: 2,
			left: 3,
			last: "observations-mismatch",
			after: "week-unavailable",
		});
	});
});

describe("usage-accounting week observations: a replay stream", () => {
	it("goes on only from its own last page, unchanged by appends, and ends at a reload or a newer stream", async () => {
		const refused = "invalid-replay";
		expect(await runCase("replayCursor")).toEqual({
			refused: {
				tag: refused,
				offset: refused,
				ordinal: refused,
				extra: refused,
				partial: refused,
				rows0: refused,
				rowsAboveCap: refused,
				rowsFraction: refused,
			},
			ended: refused,
			superseded: refused,
			notLoaded: "not-loaded",
			restarted: refused,
			pages: 28,
		});
	});
});

describe("usage-accounting week observations: a week B2 wrote stays legacy", () => {
	it("reads, seals and totals B2's own bytes, and refuses its replay and writes instead of claiming coverage", async () => {
		const refused = "legacy-week";
		expect(await runCase("legacy")).toEqual({
			coverage: { state: "legacy", observations: 0, unobserved: null, dropped: 0 },
			refused: {
				replay: refused,
				append: refused,
				appendObserved: refused,
				checkpoint: refused,
				checkpointCursors: refused,
			},
			stray: { state: "legacy", observations: 0, unobserved: null, dropped: 276 },
			sealedCoverage: { state: "legacy", observations: 0, unobserved: null, dropped: 0 },
			sealedReplay: refused,
			adjust: refused,
			adjustNumbers: refused,
			// The stray log, cut to its header, stays; its week reads as legacy all the same.
			listing: {
				weeks: [
					{
						week: "2026-10-19",
						log: true,
						receipts: true,
						checkpoint: true,
						sealed: true,
						adjust: false,
						observations: true,
					},
				],
				scratch: 0,
				quarantined: 0,
				other: 0,
			},
		});
	});
});

describe("usage-accounting week observations: listing, seal and late observations", () => {
	it("lists the observations log only where it exists, and moves it aside with the week", async () => {
		const entry = { week: "2026-10-19", log: true, receipts: false, checkpoint: true, sealed: false, adjust: false };
		expect(await runCase("listing")).toEqual({
			without: { weeks: [entry], scratch: 0, quarantined: 0, other: 0 },
			withObservations: { weeks: [{ ...entry, observations: true }], scratch: 0, quarantined: 0, other: 0 },
			moved: [
				"week-2026-10-19.checkpoint.quarantine-<tag>",
				"week-2026-10-19.log.quarantine-<tag>",
				"week-2026-10-19.observations.quarantine-<tag>",
			],
			after: { weeks: [], scratch: 0, quarantined: 3, other: 0 },
			reload: { state: "empty", week: "2026-10-19" },
		});
	});
	it("seals only what a checkpoint committed, then keeps late observations, committed by adjust", async () => {
		expect(await runCase("seal")).toEqual({
			behind: "checkpoint-behind",
			unknownRk: "invalid-observation",
			removed: [
				"week-2026-10-19.adjust",
				"week-2026-10-19.receipts",
				"week-2026-10-19.observations",
				"week-2026-10-19.checkpoint",
				"week-2026-10-19.log",
				"week-2026-10-19.sealed",
			],
		});
	});
});

// B_OBS_LARGE_CASE=1 (opt-in, minutes of disk work): the E1 and E2 weeks of Ops #420's plan (125,231 and 250,462 pi
// attempts), each with its numeric record and its fact, a role witness every 10th and an allocation every 50th, then a
// reload and a whole paged replay, as after a restart. The numbers go to the doc; there is no speed bar to pass here.
describe.skipIf(process.env.B_OBS_LARGE_CASE !== "1")("usage-accounting week observations: E1 and E2", () => {
	it.each([
		["E1", 125_231],
		["E2", 250_462],
	])(
		"%s: appends, reloads and replays every observation within the store's caps",
		async (name, attempts) => {
			const measure = (await runCase("large", { attempts })) as Record<string, unknown>;
			process.stdout.write(
				`B2-WEEK-OBSERVATIONS-MEASURE ${JSON.stringify({ name, ...measure, worker: METER_WORKER_RESOURCE_LIMITS })}\n`,
			);
			expect(measure.attempts).toBe(attempts);
		},
		15 * 60_000,
	);
});
