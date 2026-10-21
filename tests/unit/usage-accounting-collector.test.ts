import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readFile,
	readFileSync,
	readSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { setImmediate as fixtureYield } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import * as ts from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
	COLLECTOR_LIMITS,
	UsageAccountingCollector,
	type CollectorCheckpoint,
	type CollectorIO,
	type CollectorVerifier,
	type CollectorIndexEntry,
	type CollectorIndexPage,
	type CollectorIndexValue,
	type CollectorNumericIndex,
	type JournalPosition,
	type PagedCollectorIO,
	type PagedUsageAccountingCollector,
	type NumericRows,
	type SourceBatch,
	type SourceInventory,
} from "../../server/usage-accounting-collector.js";
import {
	accountUsage,
	factId,
	pacificWeekStart,
	parseAccountingInput,
	type AccountingInput,
	type AccountingReport,
	type UsageFact,
} from "../../server/usage-accounting-contract.js";

import {
	METER_LIMITS,
	METER_WORKER_RESOURCE_LIMITS,
	parseMeterWorkerMessage,
} from "../../server/usage-accounting-meter-contract.js";

const fixed = JSON.parse(
	readFileSync(new URL("../fixtures/usage-accounting-collector/expected.json", import.meta.url), "utf8"),
) as {
	asOf: string;
	weekFrom: string;
	mainWarmDelegate: string;
	retryCompaction: string;
	overlapGross: string;
	correctedGross: string;
	correctedDedup: string;
	crashMainWarm: string;
	provider: string;
	invoice: string;
	pacific: [string, string, string][];
};
const AS_OF = fixed.asOf;
const OPTIONS = { policyRef: "fixture:design-policy", asOf: AS_OF, staleAfterMs: 3_600_000 };
const roots: string[] = [];
const ROWS = ["facts", "allocations", "aliases", "roots", "policies", "memberships", "snapshots"] as const;
const STAGES = [
	"before-append",
	"after-append",
	"before-journal-sync",
	"after-journal-sync",
	"before-checkpoint",
	"before-checkpoint-sync",
	"after-checkpoint-sync",
	"before-checkpoint-rename",
	"after-checkpoint-rename",
	"after-checkpoint-dir-sync",
] as const;
afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Test-only filesystem adapter. Every path is inside a unique mkdtemp directory; never exported to production. */
class FixtureIO implements CollectorIO {
	readonly dir: string;
	hit: string | null = null;
	trace: string[] = [];
	checkCommit: (() => void) | null = null;
	constructor() {
		this.dir = mkdtempSync(join(tmpdir(), "usage-accounting-collector-"));
		roots.push(this.dir);
	}
	path(n: number): string {
		return join(this.dir, `journal-${String(n).padStart(6, "0")}.numeric`);
	}
	stage(name: string): void {
		this.trace.push(name);
		if (this.hit === name) throw new Error("fixture-crash");
	}
	async read(limits: typeof COLLECTOR_LIMITS): Promise<{ segments: string[]; checkpoint: string | null }> {
		const names = readdirSync(this.dir)
			.filter((n) => /^journal-\d{6}\.numeric$/.test(n))
			.sort();
		if (names.length > limits.segments) throw new Error("fixture-cap");
		let total = 0;
		const segments = names.map((name, i) => {
			if (name !== `journal-${String(i + 1).padStart(6, "0")}.numeric`) throw new Error("fixture-segment-gap");
			const file = join(this.dir, name);
			const stat = lstatSync(file);
			total += stat.size;
			if (!stat.isFile() || stat.nlink !== 1 || stat.size > limits.segmentBytes || total > limits.journalBytes)
				throw new Error("fixture-cap");
			return readFileSync(file, "utf8");
		});
		const cp = join(this.dir, "checkpoint.numeric");
		if (existsSync(cp) && lstatSync(cp).size > limits.checkpointBytes) throw new Error("fixture-checkpoint-cap");
		return { segments, checkpoint: existsSync(cp) ? readFileSync(cp, "utf8") : null };
	}
	async append(segment: number, expectedBytes: number, line: string): Promise<void> {
		this.stage("before-append");
		const file = this.path(segment);
		if ((existsSync(file) ? lstatSync(file).size : 0) !== expectedBytes) throw new Error("fixture-cas");
		const fd = openSync(file, existsSync(file) ? "a" : "wx", 0o600);
		try {
			if (this.hit === "torn-append") {
				writeFileSync(fd, line.slice(0, Math.floor(line.length / 2)));
				fsyncSync(fd);
				this.stage("torn-append");
			}
			writeFileSync(fd, line);
		} finally {
			closeSync(fd);
		}
		this.stage("after-append");
	}
	async sync(segment: number): Promise<void> {
		this.stage("before-journal-sync");
		const fd = openSync(this.path(segment), "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		this.syncDir();
		this.stage("after-journal-sync");
	}
	private syncDir(): void {
		const fd = openSync(this.dir, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}
	async checkpoint(text: string): Promise<void> {
		this.stage("before-checkpoint");
		this.checkCommit?.();
		const next = join(this.dir, "checkpoint.next");
		const fd = openSync(next, "w", 0o600);
		try {
			writeFileSync(fd, text);
			this.stage("before-checkpoint-sync");
			fsyncSync(fd);
			this.stage("after-checkpoint-sync");
		} finally {
			closeSync(fd);
		}
		this.stage("before-checkpoint-rename");
		renameSync(next, join(this.dir, "checkpoint.numeric"));
		this.stage("after-checkpoint-rename");
		this.syncDir();
		this.stage("after-checkpoint-dir-sync");
	}
	journal(): string {
		return readdirSync(this.dir)
			.filter((n) => n.endsWith(".numeric") && n.startsWith("journal-"))
			.sort()
			.map((n) => readFileSync(join(this.dir, n), "utf8"))
			.join("");
	}
}
function ledger(): AccountingInput {
	// Reuse #293's completely synthetic closed fixture, never a real chat/role/provider source.
	const raw: unknown = JSON.parse(
		readFileSync(new URL("../fixtures/usage-accounting/ledger.json", import.meta.url), "utf8"),
	);
	const parsed = parseAccountingInput(raw);
	if (!parsed.ok) throw new Error(parsed.code);
	return parsed.value;
}
function inventory(): SourceInventory {
	return {
		v: "usage-inventory/1",
		evidenceRef: "fixture-only:native-inventory",
		observedAt: AS_OF,
		complete: true,
		sources: [
			{
				stream: "fixture-stream",
				incarnation: "fixture-feed-1",
				adapterRef: "fixture-only:adapter",
				producer: "pi",
				occurrenceStreams: ["fixture-stream"],
				retainedFrom: "2026-01-01T00:00:00.000Z",
				grants: [...ROWS],
			},
		],
	};
}
const VERIFIED: CollectorVerifier = {
	inventory: (value) => value.evidenceRef === "fixture-only:native-inventory",
	batch: (b) =>
		b.rows.roots.every((r) => r.evidenceRef.startsWith("fixture-only:")) &&
		b.rows.aliases.every((a) => a.evidenceRef.startsWith("fixture-only:")),
};
function batch(input: NumericRows = ledger(), ordinal = 1, stream = "fixture-stream"): SourceBatch {
	const rows = Object.fromEntries(ROWS.map((key) => [key, structuredClone(input[key])])) as unknown as NumericRows;
	return {
		v: "usage-source-batch/1",
		stream,
		incarnation: "fixture-feed-1",
		adapterRef: "fixture-only:adapter",
		fromCursor: ordinal === 1 ? null : { ordinal: ordinal - 1, token: `fixture:cursor:${ordinal - 1}` },
		toCursor: { ordinal, token: `fixture:cursor:${ordinal}` },
		from: fixed.weekFrom,
		through: AS_OF,
		observedAt: AS_OF,
		status: "complete",
		reason: "none",
		rows,
	};
}
function noRows(): NumericRows {
	return { facts: [], allocations: [], aliases: [], roots: [], policies: [], memberships: [], snapshots: [] };
}
async function open(
	io = new FixtureIO(),
	inv: unknown = inventory(),
	verifier: CollectorVerifier | null = VERIFIED,
	clock = () => 0,
): Promise<UsageAccountingCollector> {
	return UsageAccountingCollector.open({ inventory: inv, verifier, io, clock });
}
async function collect(c: UsageAccountingCollector, b: SourceBatch, at = AS_OF) {
	return c.collect(b.stream, JSON.stringify(b), at);
}
function report(c: UsageAccountingCollector, options = OPTIONS): AccountingReport {
	const r = c.report(options);
	if (!r) throw new Error("fixture-report-unavailable");
	return r;
}
function add(
	input: AccountingInput,
	attempt: string,
	amount: string,
	kind: UsageFact["kind"] = "assistant",
): UsageFact {
	const f = structuredClone(input.facts[0]);
	f.identity.attempt = attempt;
	f.id = factId(f.identity);
	f.kind = kind;
	f.source.event = `event:${attempt}`;
	f.prices[0].amount = amount;
	input.facts.push(f);
	input.allocations.push({ ...input.allocations[0], factId: f.id });
	return f;
}
function partial(r: AccountingReport, code?: string): void {
	expect(r.coverage).toBe("partial");
	expect(r.remainingUsd).toBeNull();
	if (code) expect(r.faults.some((f) => f.code === code)).toBe(true);
}

describe("usage collector numeric boundary and native provenance", () => {
	it("has no I/O or authority without BOTH explicit approved native metadata and injected I/O", async () => {
		const io = new FixtureIO();
		for (const inv of [null, { ...inventory(), evidenceRef: "unapproved" }, { ...inventory(), payload: {} }]) {
			const c = await open(io, inv);
			expect(c.input(AS_OF)).toBeNull();
			expect((await collect(c, batch())).status).toBe("unavailable");
		}
		const c = await open(io, inventory(), null);
		expect(c.report(OPTIONS)).toBeNull();
		expect(readdirSync(io.dir)).toEqual([]);
		const noIO = await UsageAccountingCollector.open({ inventory: inventory(), verifier: VERIFIED, io: null });
		expect((await collect(noIO, batch())).status).toBe("unavailable");
	});
	it("preserves decimal spelling in durable facts and exact money in reports; two reads are identical", async () => {
		const io = new FixtureIO();
		const c = await open(io);
		const b = batch();
		expect((await collect(c, b)).status).toBe("committed");
		const before = io.journal();
		const first = report(c);
		expect(first).toEqual(accountUsage(ledger(), OPTIONS));
		expect(first.dedupKnownListUsd).toBe("0.1");
		expect((await collect(c, b)).status).toBe("duplicate");
		expect(io.journal()).toBe(before);
		expect(report(c)).toEqual(first);
		expect(c.input(AS_OF)!.facts[0].prices[0].amount).toBe("0.10");
		expect(report(await open(io))).toEqual(first);
	});
	it("array and object key permutations replay without extra durable rows", async () => {
		const input = ledger();
		add(input, "warm", "0.02", "cache-warm");
		add(input, "delegate", "0.03", "delegate");
		const b = batch(input);
		const c = await open();
		await collect(c, b);
		const expected = report(c);
		for (let n = 0; n < 3; n++) {
			for (const key of ROWS) b.rows[key].reverse();
			b.rows.facts.push(structuredClone(b.rows.facts[0]));
			const reordered = Object.fromEntries(Object.entries(b).reverse());
			expect((await c.collect(b.stream, JSON.stringify(reordered), AS_OF)).status).toBe("duplicate");
			expect(report(c)).toEqual(expected);
		}
		expect(c.input(AS_OF)!.facts).toHaveLength(3);
		expect(expected.dedupKnownListUsd).toBe(fixed.mainWarmDelegate);
	});
	it.each([
		["extra field", (b: SourceBatch) => ({ ...b, disallowed: "fixture-disallowed-value" })],
		[
			"numeric money",
			(b: SourceBatch) => {
				(b.rows.facts[0].prices[0] as unknown as { amount: number }).amount = 0.1;
				return b;
			},
		],
		[
			"exponent money",
			(b: SourceBatch) => {
				b.rows.facts[0].prices[0].amount = "1e-1";
				return b;
			},
		],
		[
			"unknown rate",
			(b: SourceBatch) => {
				b.rows.facts[0].prices[0].rateVersion = null;
				return b;
			},
		],
		[
			"unpriced zero",
			(b: SourceBatch) => {
				b.rows.facts[0].prices[0].status = "unpriced";
				b.rows.facts[0].prices[0].amount = "0";
				return b;
			},
		],
		[
			"unsupported basis",
			(b: SourceBatch) => {
				(b.rows.facts[0].prices[0] as unknown as { basis: string }).basis = "unknown-basis";
				return b;
			},
		],
		[
			"fractional tokens",
			(b: SourceBatch) => {
				b.rows.facts[0].tokens.input = 0.5;
				return b;
			},
		],
		[
			"unsafe tokens",
			(b: SourceBatch) => {
				b.rows.facts[0].tokens.input = Number.MAX_SAFE_INTEGER + 1;
				return b;
			},
		],
		["invalid time", (b: SourceBatch) => ({ ...b, observedAt: "2026-02-30T12:00:00.000Z" })],
		[
			"closed source cursor",
			(b: SourceBatch) => ({ ...b, toCursor: { ...b.toCursor, path: "fixture-disallowed-value" } }),
		],
		[
			"too many rows",
			(b: SourceBatch) => {
				b.rows.facts = Array.from({ length: COLLECTOR_LIMITS.batchRows + 1 }, () => b.rows.facts[0]);
				return b;
			},
		],
		["too long window", (b: SourceBatch) => ({ ...b, from: "2026-01-01T00:00:00.000Z" })],
	] as const)("rejects %s, retains only a bounded fault, and does not seek past it", async (_name, change) => {
		const io = new FixtureIO();
		const c = await open(io);
		await collect(c, batch());
		const bad = change(batch(ledger(), 2));
		const result = await c.collect("fixture-stream", JSON.stringify(bad), AS_OF);
		expect(result.status).toBe("rejected");
		expect(result.cursor?.ordinal).toBe(1);
		expect(c.input(AS_OF)!.facts).toHaveLength(1);
		expect(io.journal()).not.toContain("fixture-disallowed-value");
		partial(report(c));
	});
	it("caps bytes BEFORE parsing and bounds work without timers", async () => {
		const io = new FixtureIO();
		const c = await open(io);
		await collect(c, batch());
		expect((await c.collect("fixture-stream", "x".repeat(COLLECTOR_LIMITS.batchBytes + 1), AS_OF)).code).toBe(
			"batch-limit",
		);
		let time = 0;
		const slow = await open(io, inventory(), VERIFIED, () => {
			time += 101;
			return time;
		});
		expect((await collect(slow, batch(noRows(), 2))).code).toBe("collector-off");
		const timed = await open(new FixtureIO(), inventory(), VERIFIED, () => {
			time += 101;
			return time;
		});
		expect((await collect(timed, batch())).code).toBe("time-limit");
		expect(timed.checkpoint().cursors).toEqual([]);
	});
	it.each(["incarnation", "adapterRef", "stream"] as const)(
		"rejects a mismatched feed %s instead of minting source identity",
		async (key) => {
			const c = await open();
			await collect(c, batch());
			const b = batch(noRows(), 2);
			b[key] = "fixture-other";
			const result = await c.collect("fixture-stream", JSON.stringify(b), AS_OF);
			expect(result).toMatchObject({ status: "rejected", code: "provenance-mismatch", cursor: { ordinal: 1 } });
		},
	);
	it("an invalid receipt time leaves a durable untimed fault instead of a reassuring earlier balance", async () => {
		const io = new FixtureIO();
		const c = await open(io);
		await collect(c, batch());
		expect((await collect(c, batch(noRows(), 2), "not-a-time")).code).toBe("invalid-batch");
		expect(c.checkpoint().cursors[0].cursor.ordinal).toBe(1);
		partial(report(c), "collector:invalid-batch");
		partial(report(await open(io)), "collector:invalid-batch");
	});
	it("native verification and record-type grants cannot be bypassed by a provenance label", async () => {
		const inv = inventory();
		inv.sources[0].grants = ["facts"];
		const denied = await open(new FixtureIO(), inv);
		expect((await collect(denied, batch())).code).toBe("native-unverified");
		const b = batch();
		b.rows.roots[0].evidenceRef = "R0:not-installed";
		const c = await open();
		expect((await collect(c, b)).code).toBe("native-unverified");
		expect(c.input(AS_OF)!.roots).toEqual([]);
	});
	it("missing root stays empty/unknown; membership and initiative are never budget eligibility", async () => {
		const input = ledger();
		input.roots = [];
		input.allocations = [];
		const c = await open();
		await collect(c, batch(input));
		expect(c.input(AS_OF)!.roots).toEqual([]);
		expect(report(c)).toMatchObject({
			unallocatedFacts: 1,
			unallocatedKnownListUsd: "0.1",
			verifiedOwnLowerBoundUsd: "0",
		});
		partial(report(c), "unknown-allocation");
	});
});

describe("append, correction, actual attempts and explicit aliases", () => {
	it("retains fork/retry/warming/compaction/delegate attempts and revises, never adds a summary charge", async () => {
		const input = ledger();
		add(input, "warm", "0.02", "cache-warm");
		add(input, "delegate", "0.03", "delegate");
		input.facts.push(structuredClone(input.facts[0]));
		const c = await open();
		await collect(c, batch(input));
		expect(report(c).dedupKnownListUsd).toBe(fixed.mainWarmDelegate);
		const next = ledger();
		next.facts = [];
		next.allocations = [];
		const retry = add(nextWithBase(), "retry", "0.10");
		const compact = add(nextWithBase(), "compact", "0.000000000001", "compaction");
		next.facts.push(retry, compact);
		next.allocations.push(...next.facts.map((f) => ({ ...ledger().allocations[0], factId: f.id })));
		await collect(c, batch(next, 2));
		expect(report(c).dedupKnownListUsd).toBe(fixed.retryCompaction);
		expect(c.input(AS_OF)!.facts).toHaveLength(5);
		const snapshot = batch(noRows(), 3);
		snapshot.rows.snapshots.push({
			producer: "pi",
			incarnation: "fixture-instance",
			run: "fixture-run",
			observedAt: AS_OF,
			state: "ended",
			price: { ...input.facts[0].prices[0], amount: fixed.retryCompaction },
			coveredFactIds: c.input(AS_OF)!.facts.map((f) => f.id),
			coverage: "complete",
		});
		await collect(c, snapshot);
		await collect(c, snapshot);
		expect(report(c)).toMatchObject({ dedupKnownListUsd: fixed.retryCompaction, faults: [] });
	});
	it("explicit Pi/Temper alias deduplicates one occurrence, corrections keep prior revision and separate bases", async () => {
		const input = ledger();
		add(input, "warm", "0.02", "cache-warm");
		add(input, "delegate", "0.03", "delegate");
		add(input, "retry", "0.10");
		add(input, "compact", "0.000000000001", "compaction");
		const inv = inventory();
		inv.sources.push({
			...inv.sources[0],
			stream: "fixture-temper",
			producer: "temper",
			occurrenceStreams: ["fixture-temper"],
		});
		const io = new FixtureIO();
		const c = await open(io, inv);
		await collect(c, batch(input));
		const box = batch(noRows(), 1, "fixture-temper");
		const alias = structuredClone(input.facts[0]);
		alias.identity.producer = "temper";
		alias.id = factId(alias.identity);
		alias.source.stream = box.stream;
		box.rows.facts.push(alias);
		box.rows.allocations.push({ ...input.allocations[0], factId: alias.id });
		box.rows.aliases.push({
			aliasFactId: alias.id,
			canonicalFactId: input.facts[0].id,
			provenance: "native-call-map/1",
			evidenceRef: "fixture-only:pi-temper-call",
		});
		await collect(c, box);
		expect(report(c)).toMatchObject({
			grossKnownListUsd: fixed.overlapGross,
			dedupKnownListUsd: fixed.retryCompaction,
			faults: [],
		});
		const correction = batch(noRows(), 2);
		const revised = structuredClone(input.facts[0]);
		revised.revision = 1;
		revised.supersedes = 0;
		revised.source.observedAt = "2026-10-20T11:00:00.000Z";
		revised.prices[0].amount = "0.12";
		revised.prices.push(
			{ basis: "provider-reported", currency: "USD", amount: fixed.provider, status: "known", rateVersion: null },
			{ basis: "invoice", currency: "USD", amount: fixed.invoice, status: "known", rateVersion: null },
		);
		correction.rows.facts.push(revised);
		// A mismatched alias price must NOT choose the cheaper observation; correct both native observations together.
		const revisedAlias = structuredClone(alias);
		revisedAlias.revision = 1;
		revisedAlias.supersedes = 0;
		revisedAlias.source.observedAt = revised.source.observedAt;
		revisedAlias.prices[0].amount = "0.12";
		// Separate stream commits are quarantined until the complementary revision arrives, then promoted.
		expect((await collect(c, correction)).code).toBe("alias-conflict");
		const boxCorrection = batch(noRows(), 2, box.stream);
		boxCorrection.rows.facts.push(revisedAlias);
		await collect(c, boxCorrection);
		expect((await collect(c, correction)).status).toBe("committed");
		const r = report(c);
		expect(r).toMatchObject({ grossKnownListUsd: fixed.correctedGross, dedupKnownListUsd: fixed.correctedDedup });
		expect(r.otherBases.map((b) => b.knownUsd)).toEqual([fixed.provider, fixed.invoice]);
		expect(c.input(AS_OF)!.facts.filter((f) => f.id === revised.id)).toHaveLength(2);
		expect(report(await open(io, inv))).toEqual(r);
	});
	it.each(["separate", "merged", "wait"])(
		"ACP %s report retains original stamps instead of charging reported totals again",
		async (mode) => {
			const input = ledger();
			const f = add(input, "delegate", "0.03", "delegate");
			const c = await open();
			const b = batch(input);
			await collect(c, b);
			if (mode === "separate") {
				const replay = batch(input, 2);
				await collect(c, replay);
			} else if (mode === "merged") {
				b.rows.facts.push(structuredClone(f));
				await collect(c, b);
			} else {
				await collect(c, b);
				await collect(c, b);
			}
			expect(report(c).dedupKnownListUsd).toBe("0.13");
			expect(c.input(AS_OF)!.facts).toHaveLength(2);
		},
	);
	it("fork feed observations preserve original identity/evidence, while its feed incarnation and cursor stay independent", async () => {
		const inv = inventory();
		inv.sources.push({ ...inv.sources[0], stream: "fixture-fork-feed", incarnation: "fixture-fork-feed-2" });
		const io = new FixtureIO();
		const c = await open(io, inv);
		await collect(c, batch());
		const fork = batch(ledger(), 1, "fixture-fork-feed");
		fork.incarnation = "fixture-fork-feed-2";
		expect((await collect(c, fork)).status).toBe("committed");
		expect(c.input(AS_OF)!.facts).toHaveLength(1);
		expect(c.checkpoint().cursors.map((entry) => entry.incarnation)).toEqual(["fixture-fork-feed-2", "fixture-feed-1"]);
		expect(report(c)).toMatchObject({ grossKnownListUsd: "0.1", dedupKnownListUsd: "0.1", faults: [] });
		expect(report(await open(io, inv))).toEqual(report(c));
	});
	it("ACP numeric attempts require their own native source stamps, and report/wait views add no charge", async () => {
		const inv = inventory();
		inv.sources[0].producer = "acp";
		const input = ledger();
		const f = input.facts[0];
		f.identity.producer = "acp";
		f.id = factId(f.identity);
		input.allocations[0].factId = f.id;
		f.kind = "delegate";
		const c = await open(new FixtureIO(), inv);
		await collect(c, batch(input));
		await collect(c, batch(input, 2));
		expect(report(c)).toMatchObject({ dedupKnownListUsd: "0.1", faults: [] });
		expect(c.input(AS_OF)!.facts).toHaveLength(1);
	});
	it("native same-call mapping is required even for identical time/model/dollars", async () => {
		const input = ledger();
		add(input, "not-an-alias", "0.10");
		const c = await open();
		await collect(c, batch(input));
		expect(report(c).dedupKnownListUsd).toBe("0.2");
	});
	it("out-of-order correction is durable quarantine, not a lost revision or an advanced cursor", async () => {
		const io = new FixtureIO();
		let c = await open(io);
		const first = batch();
		const correction = batch(noRows(), 2);
		correction.rows.policies = structuredClone(first.rows.policies);
		correction.rows.roots = structuredClone(first.rows.roots);
		correction.rows.memberships = structuredClone(first.rows.memberships);
		const f = structuredClone(first.rows.facts[0]);
		f.revision = 1;
		f.supersedes = 0;
		f.prices[0].amount = "0.12";
		correction.rows.facts.push(f);
		expect((await collect(c, correction)).code).toBe("cursor-gap");
		expect(c.checkpoint().cursors).toEqual([]);
		partial(report(c), "revision-conflict");
		c = await open(io);
		await collect(c, first);
		expect((await collect(c, correction)).status).toBe("committed");
		expect(report(c)).toMatchObject({ dedupKnownListUsd: "0.12", faults: [] });
		expect(c.input(AS_OF)!.facts).toHaveLength(2);
	});
	it.each([
		"revision-gap",
		"revision-conflict",
		"rewritten-occurrence",
		"event-conflict",
		"alias-conflict",
		"snapshot-conflict",
	] as const)("quarantines %s with numeric evidence but no cursor advance", async (kind) => {
		const c = await open();
		const first = batch();
		await collect(c, first);
		const b = batch(noRows(), 2);
		const f = structuredClone(first.rows.facts[0]);
		if (kind === "revision-gap") {
			f.revision = 2;
			f.supersedes = 1;
			b.rows.facts.push(f);
		}
		if (kind === "revision-conflict") {
			f.prices[0].amount = "0.01";
			b.rows.facts.push(f);
		}
		if (kind === "rewritten-occurrence") {
			f.revision = 1;
			f.supersedes = 0;
			f.occurredAt = "2026-10-20T09:59:00.000Z";
			b.rows.facts.push(f);
		}
		if (kind === "event-conflict") {
			f.identity.attempt = "different-attempt";
			f.id = factId(f.identity);
			b.rows.facts.push(f);
		}
		if (kind === "alias-conflict")
			b.rows.aliases.push({
				aliasFactId: f.id,
				canonicalFactId: factId({ ...f.identity, attempt: "missing" }),
				provenance: "native-call-map/1",
				evidenceRef: "fixture-only:alias",
			});
		if (kind === "snapshot-conflict") {
			const s = {
				producer: "pi" as const,
				incarnation: "fixture-instance",
				run: "fixture-run",
				observedAt: AS_OF,
				state: "ended" as const,
				price: { ...f.prices[0] },
				coveredFactIds: [f.id],
				coverage: "complete" as const,
			};
			b.rows.snapshots.push(s, { ...s, price: { ...s.price, amount: "0.2" } });
		}
		const result = await collect(c, b);
		expect(result).toMatchObject({ status: "quarantined", code: kind, cursor: { ordinal: 1 } });
		partial(report(c), `collector:${kind}`);
	});
	it("a correction cannot backdate its observation behind the preceding revision", async () => {
		const c = await open();
		await collect(c, batch());
		const b = batch(noRows(), 2);
		const f = structuredClone(ledger().facts[0]);
		f.revision = 1;
		f.supersedes = 0;
		f.source.observedAt = "2026-10-20T11:00:00.000Z";
		b.rows.facts.push(f);
		await collect(c, b);
		const next = batch(noRows(), 3);
		f.revision = 2;
		f.supersedes = 1;
		f.source.observedAt = "2026-10-20T10:30:00.000Z";
		next.rows.facts.push(f);
		expect((await collect(c, next)).code).toBe("rewritten-occurrence");
		expect(c.checkpoint().cursors[0].cursor.ordinal).toBe(2);
		partial(report(c), "collector:rewritten-occurrence");
	});
	it("cursor reuse with different rows/token conflicts; duplicate earlier batch cannot regress a later cursor", async () => {
		const c = await open();
		const b = batch();
		await collect(c, b);
		await collect(c, batch(noRows(), 2));
		expect((await collect(c, b)).cursor?.ordinal).toBe(2);
		const bad = structuredClone(b);
		bad.toCursor.token = "fixture:other-token";
		expect((await collect(c, bad)).code).toBe("cursor-conflict");
		partial(report(c), "collector:cursor-conflict");
	});
	it("serializes independent calls and returns defensive copies", async () => {
		const c = await open();
		const values = await Promise.all([collect(c, batch()), collect(c, batch(noRows(), 2))]);
		expect(values.map((v) => v.status)).toEqual(["committed", "committed"]);
		const cp = c.checkpoint();
		cp.cursors[0].cursor.ordinal = 999;
		const input = c.input(AS_OF)!;
		input.facts[0].prices[0].amount = "999";
		expect(c.checkpoint().cursors[0].cursor.ordinal).toBe(2);
		expect(report(c).dedupKnownListUsd).toBe("0.1");
	});
});
function nextWithBase(): AccountingInput {
	return ledger();
}

describe("commit-before-cursor and restart recovery (temporary files only)", () => {
	it("syncs facts/history before checkpoint, and checkpoints only the committed source cursor", async () => {
		const io = new FixtureIO();
		const c = await open(io);
		io.checkCommit = () => {
			expect(io.trace.lastIndexOf("after-journal-sync")).toBeGreaterThan(io.trace.lastIndexOf("after-append"));
			const frames = io
				.journal()
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(frames.at(-1).batch.rows.facts[0].prices[0].amount).toBe("0.10");
			expect(c.checkpoint().cursors[0].cursor.ordinal).toBe(1);
		};
		await collect(c, batch());
		const cp = JSON.parse(readFileSync(join(io.dir, "checkpoint.numeric"), "utf8")) as CollectorCheckpoint;
		expect(cp).toEqual(c.checkpoint());
	});
	it.each(STAGES)("crash at %s preserves the exact report after reread, without double charging", async (stage) => {
		const io = new FixtureIO();
		let c = await open(io);
		const first = batch();
		await collect(c, first);
		const input = ledger();
		const warm = add(input, "warm", "0.02", "cache-warm");
		const next = batch(noRows(), 2);
		next.rows.facts = [warm];
		next.rows.allocations = [input.allocations[1]];
		const expected = accountUsage(input, OPTIONS);
		io.hit = stage;
		expect((await collect(c, next)).status).toBe("unavailable");
		io.hit = null;
		c = await open(io);
		await collect(c, next);
		await collect(c, next);
		await collect(c, first);
		expect(report(c)).toEqual(expected);
		expect(report(c).dedupKnownListUsd).toBe(fixed.crashMainWarm);
		expect(c.input(AS_OF)!.facts).toHaveLength(2);
		expect(c.checkpoint().cursors[0].cursor.ordinal).toBe(2);
		expect(report(await open(io))).toEqual(expected);
	});
	it("preserves a torn tail, rotates append-only, rereads missing facts and keeps the coverage gap explicit", async () => {
		const io = new FixtureIO();
		let c = await open(io);
		await collect(c, batch());
		const input = ledger();
		const warm = add(input, "warm", "0.02", "cache-warm");
		const next = batch(noRows(), 2);
		next.rows.facts = [warm];
		next.rows.allocations = [input.allocations[1]];
		io.hit = "torn-append";
		await collect(c, next);
		io.hit = null;
		const damaged = readFileSync(io.path(1), "utf8");
		c = await open(io);
		expect(c.checkpoint().cursors[0].cursor.ordinal).toBe(1);
		partial(report(c), "collector:journal-tail");
		await collect(c, next);
		await collect(c, next);
		expect(readFileSync(io.path(1), "utf8")).toBe(damaged);
		expect(existsSync(io.path(2))).toBe(true);
		expect(report(c).dedupKnownListUsd).toBe(fixed.crashMainWarm);
		expect(c.input(AS_OF)!.facts).toHaveLength(2);
		partial(report(c), "collector:journal-tail");
		expect(report(await open(io))).toEqual(report(c));
	});
	it.each(["partial", "ahead", "wrong-cursor"])(
		"%s checkpoint is never authority to skip durable history",
		async (kind) => {
			const io = new FixtureIO();
			let c = await open(io);
			await collect(c, batch());
			const cp = c.checkpoint();
			if (kind === "ahead") cp.sequence = 9;
			if (kind === "wrong-cursor") cp.cursors[0].cursor.ordinal = 99;
			writeFileSync(join(io.dir, "checkpoint.numeric"), kind === "partial" ? '{"v":' : JSON.stringify(cp));
			c = await open(io);
			expect(c.checkpoint().cursors[0].cursor.ordinal).toBe(1);
			expect(report(c).dedupKnownListUsd).toBe("0.1");
			partial(report(c), "collector:checkpoint-corrupt");
			await collect(c, batch(noRows(), 2));
			partial(report(await open(io)), "collector:checkpoint-corrupt");
		},
	);
	it("a corrupt complete frame stops collection, retains provable prefix dollars and exposes no advanced cursor", async () => {
		const io = new FixtureIO();
		let c = await open(io);
		await collect(c, batch());
		writeFileSync(io.path(1), "not-numeric-json\n", { flag: "a" });
		c = await open(io);
		expect(c.checkpoint().cursors).toEqual([]);
		expect(report(c).dedupKnownListUsd).toBe("0.1");
		partial(report(c), "collector:journal-corrupt");
		expect((await collect(c, batch(noRows(), 2))).status).toBe("unavailable");
	});
});

describe("coverage, event-time binding, staleness and inert scheduling", () => {
	it.each(["unpriced", "unknown-model", "basis-unproven"] as const)(
		"%s stays null-priced, never repriced at a current/default rate",
		async (status) => {
			const input = ledger();
			input.facts[0].prices[0] = { ...input.facts[0].prices[0], amount: null, status, rateVersion: null };
			const c = await open();
			await collect(c, batch(input));
			expect(report(c)).toMatchObject({ unpricedFacts: 1, dedupKnownListUsd: "0" });
			partial(report(c));
		},
	);
	it("collects known initiative usage even when no policy owns it; bases are not added together", async () => {
		const input = ledger();
		input.roots = [];
		input.allocations = [];
		input.facts[0].prices.push(
			{ basis: "provider-reported", currency: "USD", amount: fixed.provider, status: "known", rateVersion: null },
			{ basis: "invoice", currency: "USD", amount: fixed.invoice, status: "known", rateVersion: null },
		);
		const c = await open();
		await collect(c, batch(input));
		expect(report(c)).toMatchObject({ dedupKnownListUsd: "0.1", unallocatedKnownListUsd: "0.1" });
		expect(report(c).otherBases.map((b) => b.knownUsd)).toEqual([fixed.provider, fixed.invoice]);
		expect(c.input(AS_OF)!.facts[0].links.task!.initiative).toBe("fixture-initiative");
	});
	it.each(["unsupported", "lost", "inventory-partial", "retention-gap"])(
		"%s feed cannot be an empty complete week",
		async (kind) => {
			const inv = inventory();
			if (kind === "inventory-partial") inv.complete = false;
			if (kind === "retention-gap") inv.sources[0].retainedFrom = "2026-10-20T00:00:00.000Z";
			if (kind === "unsupported" || kind === "lost")
				inv.sources.push({
					...inv.sources[0],
					stream: "fixture-required-missing",
					producer: "temper",
					adapterRef: kind === "unsupported" ? null : "fixture-only:adapter",
				});
			const c = await open(new FixtureIO(), inv);
			await collect(c, batch());
			expect(report(c).dedupKnownListUsd).toBe("0.1");
			partial(report(c));
			if (kind === "retention-gap") expect(c.checkpoint().cursors).toEqual([]);
		},
	);
	it.each(["partial", "unknown", "unavailable"] as const)(
		"%s native coverage remains a gap despite earlier complete observations",
		async (status) => {
			const c = await open();
			await collect(c, batch());
			const b = batch(noRows(), 2);
			b.status = status;
			b.reason = "reported-gap";
			b.observedAt = "2026-10-20T12:01:00.000Z";
			b.through = b.observedAt;
			await collect(c, b, b.observedAt);
			partial(report(c, { ...OPTIONS, asOf: b.observedAt }));
		},
	);
	it("truncated source batch persists only qualified numeric evidence, never advances its cursor", async () => {
		const c = await open();
		await collect(c, batch());
		const b = batch(noRows(), 2);
		b.status = "partial";
		b.reason = "truncated";
		expect((await collect(c, b)).code).toBe("truncated-source");
		expect(c.checkpoint().cursors[0].cursor.ordinal).toBe(1);
		partial(report(c), "collector:truncated-source");
	});
	it("a snapshot mismatch is a fault, never a new charge or a replacement for attempt leaves", async () => {
		const input = ledger();
		const c = await open();
		await collect(c, batch(input));
		const b = batch(noRows(), 2);
		b.rows.snapshots.push({
			producer: "pi",
			incarnation: "fixture-instance",
			run: "fixture-run",
			observedAt: AS_OF,
			state: "ended",
			price: { ...input.facts[0].prices[0], amount: "999" },
			coveredFactIds: [input.facts[0].id],
			coverage: "complete",
		});
		await collect(c, b);
		expect(report(c).dedupKnownListUsd).toBe("0.1");
		expect(c.input(AS_OF)!.facts).toHaveLength(1);
		partial(report(c), "snapshot-mismatch");
	});
	it("stale as-of and an uncovered watermark expose UNKNOWN, not a reassuring balance", async () => {
		const c = await open();
		await collect(c, batch());
		const late = report(c, { ...OPTIONS, asOf: "2026-10-20T14:00:00.000Z" });
		expect(late.freshness).toBe("stale");
		partial(late, "source-coverage");
	});
	it.each(["child-addedAt", "foreign-queue", "latest-parent"])(
		"%s is quarantined without losing gross known usage",
		async (kind) => {
			const input = ledger();
			const task = input.facts[0].links.task!;
			if (kind === "child-addedAt") {
				task.addedAt = "2026-10-20T09:00:00.000Z";
				task.effectiveAt = task.addedAt;
			}
			if (kind === "foreign-queue") task.queue = "foreign-queue";
			if (kind === "latest-parent") task.initiative = "new-parent-not-effective-yet";
			const c = await open();
			expect((await collect(c, batch(input))).code).toBe("binding-mismatch");
			expect(report(c).grossKnownListUsd).toBe("0.1");
			partial(report(c), "task-binding-mismatch");
			expect(c.checkpoint().cursors).toEqual([]);
		},
	);
	it("immutable original birth and reparent history bind each call at occurrence", async () => {
		const input = ledger();
		const later = add(input, "after-reparent", "0.02");
		later.occurredAt = "2026-10-20T11:00:00.000Z";
		later.source.observedAt = "2026-10-20T11:01:00.000Z";
		input.allocations[1].recordedAt = later.source.observedAt;
		const membership = {
			...input.memberships[0],
			effectiveAt: "2026-10-20T10:30:00.000Z",
			project: "next-project",
			initiative: "next-initiative",
		};
		input.memberships.push(membership);
		later.links.task = structuredClone(membership);
		const c = await open();
		expect((await collect(c, batch(input))).status).toBe("committed");
		expect(report(c)).toMatchObject({ dedupKnownListUsd: "0.12", faults: [] });
		expect(c.input(AS_OF)!.memberships).toHaveLength(2);
	});
	it.each(fixed.pacific)(
		"Pacific occurrence rollover/DST %s, not observation or task-add time",
		async (at, week, start) => {
			const input = ledger();
			const f = input.facts[0];
			f.occurredAt = at;
			f.source.observedAt = at;
			f.links.task!.addedAt = "2026-01-01T00:00:00.000Z";
			f.links.task!.effectiveAt = f.links.task!.addedAt;
			input.memberships = [structuredClone(f.links.task!)];
			input.allocations[0].recordedAt = at;
			input.roots[0].occurredAt = "2026-01-01T00:00:00.000Z";
			input.policies[0].effectiveAt = input.roots[0].occurredAt;
			const b = batch(input);
			b.from = start;
			b.through = at;
			b.observedAt = at;
			const c = await open();
			await collect(c, b, at);
			expect(report(c, { ...OPTIONS, asOf: at })).toMatchObject({
				weekStart: week,
				dedupKnownListUsd: "0.1",
				faults: [],
			});
			expect(pacificWeekStart(at)).toBe(week);
		},
	);
	it("current-week-first hints and bounded low-priority backfill do not start any I/O or source read", async () => {
		const io = new FixtureIO();
		const c = await open(io);
		const hints = c.requests(AS_OF, "2026-09-01T00:00:00.000Z");
		expect(hints.map((h) => h.priority)).toEqual(["current-week", "historical-low"]);
		expect(hints[0]).toMatchObject({ from: fixed.weekFrom, through: AS_OF, maxRows: COLLECTOR_LIMITS.batchRows });
		expect(Date.parse(hints[1].through) - Date.parse(hints[1].from)).toBe(COLLECTOR_LIMITS.spanMs);
		expect(io.trace).toEqual([]);
		expect(readdirSync(io.dir)).toEqual([]);
	});
	it("historical backfill retains old dollars/history without replacing current-week coverage", async () => {
		const c = await open();
		await collect(c, batch());
		const input = ledger();
		const previous = add(input, "previous-week", "0.3");
		previous.occurredAt = "2026-10-18T10:00:00.000Z";
		previous.source.observedAt = "2026-10-18T10:01:00.000Z";
		const b = batch(noRows(), 2);
		b.from = "2026-10-12T07:00:00.000Z";
		b.through = "2026-10-19T06:59:59.999Z";
		b.rows.facts.push(previous);
		b.rows.allocations.push({ ...input.allocations[1], recordedAt: previous.source.observedAt });
		b.rows.roots.push({ ...input.roots[0], ref: "fixture-only:older-root", occurredAt: "2026-10-17T09:00:00.000Z" });
		b.rows.allocations[0].rootRef = "fixture-only:older-root";
		expect((await collect(c, b)).status).toBe("committed");
		expect(c.input(AS_OF)!.facts).toHaveLength(2);
		expect(report(c)).toMatchObject({ dedupKnownListUsd: "0.1", faults: [] });
	});
	it("has no production importer, source/file adapter, timer, network, model or service hook", () => {
		const source = readFileSync(new URL("../../server/usage-accounting-collector.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(
			/from ["'](?:node:fs|node:child_process|node:http|.*agent-service|.*usage-accounting-capture)/,
		);
		expect(source).not.toMatch(/\b(?:fetch|setTimeout|setInterval|createServer|process\.env)\s*\(/);
		// Only the blanket importer ban is replaced below. Numeric/privacy and inert-source assertions stay frozen.
	});
});

// W0 hypothesis (fixture-only): a bounded derived SQLite index and readSync pages should preserve
// the frozen oracle without retaining the week in JS. Exact money/cursors, fail-closed recovery,
// worker resource/latency limits and positive import mutations below are the falsifiers.
// BEGIN W0 SHARED FIXTURE -- extracted verbatim into the isolated benchmark, not production code.
const PAGED_KEYS = ["facts", "allocations", "aliases", "roots", "policies", "memberships", "snapshots"] as const;
const FIXTURE_PAGE: { maxRows: number; maxBytes: number } = {
	maxRows: METER_LIMITS.pageRows,
	maxBytes: METER_LIMITS.pageBytes,
};
function fixtureCheck(ok: unknown, code: string): asserts ok {
	if (!ok) throw new Error(`fixture:${code}`);
}
function pagedEmpty(): NumericRows {
	return { facts: [], allocations: [], aliases: [], roots: [], policies: [], memberships: [], snapshots: [] };
}
function pagedCount(rows: NumericRows): number {
	return PAGED_KEYS.reduce((count, key) => count + rows[key].length, 0);
}
function fixtureUnits(amount: string): bigint {
	fixtureCheck(/^(0|[1-9]\d*)(?:\.\d{1,12})?$/.test(amount), "decimal");
	const [whole, fraction = ""] = amount.split(".");
	return BigInt(whole) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, "0"));
}
function fixtureUsd(units: bigint): string {
	const whole = units / 1_000_000_000_000n;
	const fraction = String(units % 1_000_000_000_000n)
		.padStart(12, "0")
		.replace(/0+$/, "");
	return fraction ? `${whole}.${fraction}` : String(whole);
}
/** Numeric derived cache only. No native source cursor authority and no all-history JS Map/array.
 * BINARY primary-key ranges, a fixed <=8MiB SQLite cache, no mmap, and no derived-cache fsync. */
class PagedFixtureIndex implements CollectorNumericIndex {
	private db: DatabaseSync;
	private lookup: StatementSync;
	private range: StatementSync;
	private put: StatementSync;
	private remove: StatementSync;
	entries = 0;
	bytes = 0;
	entryCap: number = METER_LIMITS.indexEntries;
	byteCap: number = METER_LIMITS.indexBytes;
	fail: "reset" | "get" | "scan" | "write" | "reserve" | null = null;
	partialWrite = false;
	closed = false;
	stats = {
		resets: 0,
		reserves: 0,
		negative: 0,
		maxGetRows: 0,
		maxGetBytes: 0,
		maxScanRows: 0,
		maxScanBytes: 0,
		maxWriteRows: 0,
		maxWriteBytes: 0,
	};
	constructor(dir: string) {
		this.db = new DatabaseSync(join(dir, "derived-fixture.sqlite"));
		this.db.exec(
			"PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE;",
		);
		fixtureCheck(Number(this.db.prepare("PRAGMA cache_size").get()?.cache_size) === -8192, "sqlite-cache-bound");
		this.db.exec(
			"CREATE TABLE IF NOT EXISTS numeric (key TEXT PRIMARY KEY COLLATE BINARY, value TEXT NOT NULL, bytes INTEGER NOT NULL) WITHOUT ROWID",
		);
		this.lookup = this.db.prepare("SELECT value, bytes FROM numeric WHERE key = ? COLLATE BINARY");
		this.range = this.db.prepare(
			"SELECT key, value FROM numeric WHERE key >= ? COLLATE BINARY AND key < ? COLLATE BINARY AND key > ? COLLATE BINARY ORDER BY key COLLATE BINARY LIMIT ?",
		);
		this.put = this.db.prepare(
			"INSERT INTO numeric (key, value, bytes) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, bytes=excluded.bytes",
		);
		this.remove = this.db.prepare("DELETE FROM numeric WHERE key = ? COLLATE BINARY");
		// Derived cache only: one spillable transaction avoids a disk autocommit for each numeric key.
		// SQLite's bounded page cache may spill; durability is exclusively the synced journal/checkpoint.
		this.db.exec("BEGIN");
	}
	private check(operation: NonNullable<PagedFixtureIndex["fail"]>): void {
		if (this.fail === operation) throw new Error(`fixture-index-${operation}`);
	}
	private bounds(limits: typeof FIXTURE_PAGE): void {
		fixtureCheck(
			limits.maxRows > 0 &&
				limits.maxRows <= METER_LIMITS.pageRows &&
				limits.maxBytes > 0 &&
				limits.maxBytes <= METER_LIMITS.pageBytes,
			"index-request-bound",
		);
	}
	async reset(): Promise<void> {
		this.check("reset");
		this.db.exec("DELETE FROM numeric");
		this.entries = this.bytes = 0;
		this.stats.resets++;
	}
	async reserve(newEntries: number, newBytes: number): Promise<boolean> {
		this.check("reserve");
		fixtureCheck(
			Number.isSafeInteger(newEntries) && newEntries >= 0 && Number.isSafeInteger(newBytes) && newBytes >= 0,
			"reserve-numeric",
		);
		this.stats.reserves++;
		return this.entries + newEntries <= this.entryCap - 2 && this.bytes + newBytes <= this.byteCap - 1024;
	}
	async get(keys: string[], limits: typeof FIXTURE_PAGE): Promise<CollectorIndexEntry[]> {
		this.check("get");
		this.bounds(limits);
		fixtureCheck(keys.length <= limits.maxRows, "get-request-rows");
		const entries: CollectorIndexEntry[] = [];
		let size = 2;
		for (const key of keys) {
			const found = this.lookup.get(key);
			if (!found) {
				this.stats.negative++;
				continue;
			}
			const entry = { key, value: JSON.parse(String(found.value)) as CollectorIndexValue };
			size += Buffer.byteLength(JSON.stringify(entry)) + 1;
			fixtureCheck(size <= limits.maxBytes, "get-bytes");
			entries.push(entry);
		}
		this.stats.maxGetRows = Math.max(this.stats.maxGetRows, entries.length);
		this.stats.maxGetBytes = Math.max(this.stats.maxGetBytes, size);
		return entries;
	}
	async scan(prefix: string, after: string | null, limits: typeof FIXTURE_PAGE): Promise<CollectorIndexPage> {
		this.check("scan");
		this.bounds(limits);
		const entries: CollectorIndexEntry[] = [];
		let size = 64,
			more = false;
		// Keys in this closed numeric seam are ASCII. The upper bound is exclusive; ordering is NOT localeCompare.
		for (const raw of this.range.iterate(prefix, `${prefix}\uffff`, after ?? "", limits.maxRows + 1)) {
			const entry = { key: String(raw.key), value: JSON.parse(String(raw.value)) as CollectorIndexValue };
			const n = Buffer.byteLength(JSON.stringify(entry)) + 1;
			if (entries.length === limits.maxRows || size + n > limits.maxBytes - Buffer.byteLength(entry.key)) {
				more = true;
				break;
			}
			entries.push(entry);
			size += n;
		}
		fixtureCheck(!more || entries.length > 0, "scan-single-entry-bound");
		const page = { entries, after: more ? entries[entries.length - 1].key : null };
		const bytes = Buffer.byteLength(JSON.stringify(page));
		fixtureCheck(bytes <= limits.maxBytes, "scan-bytes");
		this.stats.maxScanRows = Math.max(this.stats.maxScanRows, entries.length);
		this.stats.maxScanBytes = Math.max(this.stats.maxScanBytes, bytes);
		return page;
	}
	async write(
		entries: { key: string; value: CollectorIndexValue | null }[],
		limits: typeof FIXTURE_PAGE,
	): Promise<void> {
		this.check("write");
		this.bounds(limits);
		const bytes = Buffer.byteLength(JSON.stringify(entries));
		fixtureCheck(entries.length <= limits.maxRows && bytes <= limits.maxBytes, "write-bound");
		this.stats.maxWriteRows = Math.max(this.stats.maxWriteRows, entries.length);
		this.stats.maxWriteBytes = Math.max(this.stats.maxWriteBytes, bytes);
		for (const entry of entries) {
			const prior = this.lookup.get(entry.key);
			const text = entry.value === null ? null : JSON.stringify(entry.value);
			const size = text === null ? 0 : Buffer.byteLength(entry.key) + Buffer.byteLength(text);
			const count = this.entries - (prior ? 1 : 0) + (text === null ? 0 : 1);
			const total = this.bytes - Number(prior?.bytes ?? 0) + size;
			fixtureCheck(count <= this.entryCap && total <= this.byteCap, "index-hard-cap");
			if (text === null) this.remove.run(entry.key);
			else this.put.run(entry.key, text, size);
			this.entries = count;
			this.bytes = total;
			if (this.partialWrite) {
				this.partialWrite = false;
				throw new Error("fixture-index-partial-write");
			}
		}
	}
	close(): void {
		if (!this.closed) {
			try {
				this.db.exec("COMMIT");
			} finally {
				this.db.close();
				this.closed = true;
			}
		}
	}
}
/** Private, synthetic numeric files only. Journals are never readFile'd by this paged adapter. */
class PagedFixtureIO implements PagedCollectorIO {
	readonly v = "usage-collector-paged-io/1" as const;
	readonly index: PagedFixtureIndex;
	hit: string | null = null;
	trace: string[] = [];
	checkCommit: (() => void) | null = null;
	stats = { heads: 0, reads: 0, readBytes: 0, maxReadBytes: 0, appends: 0, maxAppendBytes: 0, yields: 0 };
	constructor(readonly dir: string) {
		this.index = new PagedFixtureIndex(dir);
	}
	path(segment: number): string {
		return join(this.dir, `journal-${String(segment).padStart(6, "0")}.numeric`);
	}
	stage(name: string): void {
		if (this.trace.length === 64) this.trace.shift();
		this.trace.push(name);
		if (this.hit === name) throw new Error("fixture-crash");
	}
	async head(limits: typeof METER_LIMITS): Promise<{ sizes: number[]; checkpoint: string | null }> {
		this.stage("head");
		this.stats.heads++;
		const names = readdirSync(this.dir)
			.filter((name) => /^journal-\d{6}\.numeric$/.test(name))
			.sort();
		fixtureCheck(names.length <= limits.segments, "segments");
		let total = 0;
		const sizes = names.map((name, i) => {
			fixtureCheck(name === `journal-${String(i + 1).padStart(6, "0")}.numeric`, "segment-gap");
			const stat = lstatSync(join(this.dir, name));
			total += stat.size;
			fixtureCheck(
				stat.isFile() && stat.nlink === 1 && stat.size <= limits.segmentBytes && total <= limits.journalBytes,
				"head-bound",
			);
			return stat.size;
		});
		const cp = join(this.dir, "checkpoint.numeric");
		fixtureCheck(!existsSync(cp) || lstatSync(cp).size <= limits.checkpointBytes, "checkpoint-bound");
		return { sizes, checkpoint: existsSync(cp) ? readFileSync(cp, "utf8") : null };
	}
	async readPage(position: JournalPosition, maxBytes: number): Promise<Uint8Array> {
		this.stage("read-page");
		fixtureCheck(
			Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= METER_LIMITS.pageBytes,
			"read-page-bound",
		);
		const fd = openSync(this.path(position.segment), "r");
		try {
			const page = Buffer.allocUnsafe(maxBytes);
			const length = readSync(fd, page, 0, maxBytes, position.offset);
			this.stats.reads++;
			this.stats.readBytes += length;
			this.stats.maxReadBytes = Math.max(this.stats.maxReadBytes, maxBytes);
			return page.subarray(0, this.hit === "short-page" ? Math.max(0, length - 1) : length);
		} finally {
			closeSync(fd);
		}
	}
	async append(segment: number, expectedBytes: number, line: string): Promise<void> {
		this.stage("before-append");
		const file = this.path(segment),
			length = Buffer.byteLength(line);
		fixtureCheck(
			length <= METER_LIMITS.pageBytes + 1024 && expectedBytes + length <= METER_LIMITS.segmentBytes,
			"append-bound",
		);
		fixtureCheck((existsSync(file) ? lstatSync(file).size : 0) === expectedBytes, "append-cas");
		const fd = openSync(file, existsSync(file) ? "a" : "wx", 0o600);
		try {
			if (this.hit === "torn-append") {
				writeFileSync(fd, line.slice(0, Math.floor(line.length / 2)));
				fsyncSync(fd);
				this.stage("torn-append");
			}
			writeFileSync(fd, line);
		} finally {
			closeSync(fd);
		}
		this.stats.appends++;
		this.stats.maxAppendBytes = Math.max(this.stats.maxAppendBytes, length);
		this.stage("after-append");
	}
	private syncDir(): void {
		const fd = openSync(this.dir, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}
	async sync(segment: number): Promise<void> {
		this.stage("before-journal-sync");
		const fd = openSync(this.path(segment), "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		this.syncDir();
		this.stage("after-journal-sync");
	}
	async checkpoint(text: string): Promise<void> {
		this.stage("before-checkpoint");
		this.checkCommit?.();
		fixtureCheck(Buffer.byteLength(text) <= METER_LIMITS.checkpointBytes, "checkpoint-bytes");
		const next = join(this.dir, "checkpoint.next"),
			fd = openSync(next, "w", 0o600);
		try {
			writeFileSync(fd, text);
			this.stage("before-checkpoint-sync");
			fsyncSync(fd);
			this.stage("after-checkpoint-sync");
		} finally {
			closeSync(fd);
		}
		this.stage("before-checkpoint-rename");
		renameSync(next, join(this.dir, "checkpoint.numeric"));
		this.stage("after-checkpoint-rename");
		this.syncDir();
		this.stage("after-checkpoint-dir-sync");
	}
	async yield(): Promise<void> {
		this.stats.yields++;
		await fixtureYield();
	}
	close(): void {
		this.index.close();
	}
}
// END W0 SHARED FIXTURE

const pagedFixtures: PagedFixtureIO[] = [];
const fixtureWorkers = new Set<Worker>();
afterEach(async () => {
	for (const worker of fixtureWorkers) await worker.terminate();
	fixtureWorkers.clear();
	for (const io of pagedFixtures.splice(0)) {
		io.close();
		rmSync(io.dir, { recursive: true, force: true });
	}
});
function pagedIO(): PagedFixtureIO {
	const io = new PagedFixtureIO(mkdtempSync(join(tmpdir(), "usage-accounting-paged-")));
	pagedFixtures.push(io);
	return io;
}
function openPaged(io: PagedFixtureIO, inv: unknown = inventory(), verifier: CollectorVerifier | null = VERIFIED) {
	return UsageAccountingCollector.openPaged({ io, inventory: inv, verifier, clock: () => 0 });
}
function collectPaged(c: PagedUsageAccountingCollector, b: SourceBatch, at = AS_OF) {
	return c.collect(b.stream, JSON.stringify(b), at);
}
/** Small frozen cases ONLY. Large-week measurement below folds pages directly into BigInt scalars. */
async function pagedInput(c: PagedUsageAccountingCollector, asOf = AS_OF, window: "all" | "current-week" = "all") {
	const evidence = await c.evidence(asOf);
	const input: AccountingInput = { v: 1, ...noRows(), requiredStreams: evidence.requiredStreams, coverage: [] };
	for await (const page of c.evidencePages(asOf, window)) {
		expect(page.evidence).toEqual(evidence);
		expect(pagedCount(page.rows) + page.coverage.length).toBeLessThanOrEqual(METER_LIMITS.pageRows);
		expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(METER_LIMITS.pageBytes);
		for (const key of ROWS) (input[key] as unknown[]).push(...page.rows[key]);
		input.coverage.push(...page.coverage);
		expect(pagedCount(input)).toBeLessThanOrEqual(10_000);
	}
	return { evidence, input };
}
async function pagedReport(c: PagedUsageAccountingCollector, options = OPTIONS): Promise<AccountingReport> {
	const { evidence, input } = await pagedInput(c, options.asOf);
	const r = accountUsage(input, options);
	const unique = new Map([...r.faults, ...evidence.faults].map((f) => [JSON.stringify(f), f]));
	r.faults = [...unique.values()].sort((a, b) => a.code.localeCompare(b.code) || a.ref.localeCompare(b.ref));
	if (evidence.storage !== "healthy" || evidence.faults.length) {
		r.coverage = "partial";
		r.remainingUsd = null;
	}
	return r;
}
function smallJournal(io: PagedFixtureIO): string {
	// Explicitly unavailable to the 100k harness; reject accidental use with a large store.
	const names = readdirSync(io.dir)
		.filter((name) => /^journal-\d{6}\.numeric$/.test(name))
		.sort();
	const bytes = names.reduce((n, name) => n + lstatSync(join(io.dir, name)).size, 0);
	fixtureCheck(bytes <= METER_LIMITS.pageBytes, "small-journal-only");
	return names.map((name) => readFileSync(join(io.dir, name), "utf8")).join("");
}
async function twins(inv = inventory()) {
	const io = pagedIO(),
		paged = await openPaged(io, inv),
		legacy = await open(new FixtureIO(), inv);
	return {
		io,
		paged,
		legacy,
		async feed(b: SourceBatch, at = AS_OF) {
			const expected = await collect(legacy, b, at),
				actual = await collectPaged(paged, b, at);
			expect(actual).toEqual(expected);
			expect(paged.checkpoint()).toEqual(legacy.checkpoint());
			expect(await pagedReport(paged)).toEqual(report(legacy));
			return actual;
		},
	};
}

describe("paged collector frozen numeric oracle and fault-bearing exports", () => {
	it("matches the fixed legacy ledger exactly, preserves decimals, and never regresses a duplicate cursor", async () => {
		const t = await twins();
		const first = batch();
		expect((await t.feed(first)).status).toBe("committed");
		expect(await pagedReport(t.paged)).toEqual(accountUsage(ledger(), OPTIONS));
		expect((await pagedInput(t.paged)).input.facts[0].prices[0].amount).toBe("0.10");
		await t.feed(batch(noRows(), 2));
		const before = smallJournal(t.io),
			sequence = t.paged.checkpoint().sequence;
		expect((await t.feed(first)).cursor?.ordinal).toBe(2);
		expect(t.paged.checkpoint().sequence).toBe(sequence);
		expect(smallJournal(t.io)).toBe(before);
		const conflict = structuredClone(first);
		conflict.toCursor.token = "fixture:cursor:conflict";
		expect((await t.feed(conflict)).code).toBe("cursor-conflict");
		partial(await pagedReport(t.paged), "collector:cursor-conflict");
		expect(await pagedReport(await openPaged(t.io))).toEqual(await pagedReport(t.paged));
	});
	it("retains actual warm/delegate/retry/compaction leaves and frozen exact bases across alias correction repair", async () => {
		const input = ledger();
		add(input, "warm", "0.02", "cache-warm");
		add(input, "delegate", "0.03", "delegate");
		add(input, "retry", "0.10");
		add(input, "compact", "0.000000000001", "compaction");
		const inv = inventory();
		inv.sources.push({
			...inv.sources[0],
			stream: "fixture-temper",
			producer: "temper",
			occurrenceStreams: ["fixture-temper"],
		});
		const t = await twins(inv);
		await t.feed(batch(input));
		const alias = structuredClone(input.facts[0]);
		alias.identity.producer = "temper";
		alias.id = factId(alias.identity);
		alias.source.stream = "fixture-temper";
		const box = batch(noRows(), 1, "fixture-temper");
		box.rows.facts.push(alias);
		box.rows.allocations.push({ ...input.allocations[0], factId: alias.id });
		box.rows.aliases.push({
			aliasFactId: alias.id,
			canonicalFactId: input.facts[0].id,
			provenance: "native-call-map/1",
			evidenceRef: "fixture-only:pi-temper-call",
		});
		await t.feed(box);
		expect(await pagedReport(t.paged)).toMatchObject({
			grossKnownListUsd: fixed.overlapGross,
			dedupKnownListUsd: fixed.retryCompaction,
			faults: [],
		});
		const correction = batch(noRows(), 2),
			revised = structuredClone(input.facts[0]);
		revised.revision = 1;
		revised.supersedes = 0;
		revised.source.observedAt = "2026-10-20T11:00:00.000Z";
		revised.prices[0].amount = "0.12";
		revised.prices.push(
			{ basis: "provider-reported", currency: "USD", amount: fixed.provider, status: "known", rateVersion: null },
			{ basis: "invoice", currency: "USD", amount: fixed.invoice, status: "known", rateVersion: null },
		);
		correction.rows.facts.push(revised);
		expect((await t.feed(correction)).code).toBe("alias-conflict");
		const repaired = batch(noRows(), 2, "fixture-temper"),
			revisedAlias = structuredClone(alias);
		revisedAlias.revision = 1;
		revisedAlias.supersedes = 0;
		revisedAlias.source.observedAt = revised.source.observedAt;
		revisedAlias.prices[0].amount = "0.12";
		repaired.rows.facts.push(revisedAlias);
		await t.feed(repaired);
		expect((await t.feed(correction)).status).toBe("committed");
		const r = await pagedReport(t.paged);
		expect(r).toMatchObject({
			grossKnownListUsd: fixed.correctedGross,
			dedupKnownListUsd: fixed.correctedDedup,
			faults: [],
		});
		expect(r.otherBases.map((b) => b.knownUsd)).toEqual([fixed.provider, fixed.invoice]);
		expect((await pagedInput(t.paged)).input.facts.filter((f) => f.id === revised.id)).toHaveLength(2);
		expect(await pagedReport(await openPaged(t.io, inv))).toEqual(r);
	});
	it("keeps out-of-order correction quarantine through reopen, then repairs it without losing either revision", async () => {
		const t = await twins(),
			first = batch(),
			correction = batch(noRows(), 2);
		for (const key of ["policies", "roots", "memberships"] as const)
			(correction.rows[key] as unknown[]).push(...structuredClone(first.rows[key]));
		const f = structuredClone(first.rows.facts[0]);
		f.revision = 1;
		f.supersedes = 0;
		f.prices[0].amount = "0.12";
		correction.rows.facts.push(f);
		expect((await t.feed(correction)).code).toBe("cursor-gap");
		const c = await openPaged(t.io);
		expect(c.checkpoint().cursors).toEqual([]);
		partial(await pagedReport(c), "revision-conflict");
		await collectPaged(c, first);
		expect((await collectPaged(c, correction)).status).toBe("committed");
		expect(await pagedReport(c)).toMatchObject({ dedupKnownListUsd: "0.12", faults: [] });
		expect((await pagedInput(c)).input.facts).toHaveLength(2);
	});
	it.each(["child-addedAt", "foreign-queue", "latest-parent"])(
		"preserves gross dollars and UNKNOWN on %s binding mismatch",
		async (kind) => {
			const t = await twins(),
				input = ledger(),
				task = input.facts[0].links.task!;
			if (kind === "child-addedAt") task.effectiveAt = task.addedAt = "2026-10-20T09:00:00.000Z";
			if (kind === "foreign-queue") task.queue = "foreign-queue";
			if (kind === "latest-parent") task.initiative = "not-effective-yet";
			expect((await t.feed(batch(input))).code).toBe("binding-mismatch");
			expect((await pagedReport(t.paged)).grossKnownListUsd).toBe("0.1");
			partial(await pagedReport(t.paged), "task-binding-mismatch");
			expect(t.paged.checkpoint().cursors).toEqual([]);
		},
	);
	it("selects the global earliest consistency witness, including an unrelated quarantined cold component", async () => {
		const inv = inventory();
		inv.sources.push({ ...inv.sources[0], stream: "fixture-other", occurrenceStreams: ["fixture-other"] });
		const t = await twins(inv);
		await t.feed(batch());
		const broken = batch(noRows(), 2),
			cold = structuredClone(ledger().facts[0]);
		broken.from = "2026-10-18T00:00:00.000Z";
		cold.identity.attempt = "cold-revision-gap";
		cold.id = factId(cold.identity);
		cold.source.event = "event:cold-gap";
		cold.links.task = null;
		cold.revision = 1;
		cold.supersedes = 0;
		cold.occurredAt = "2026-10-18T10:00:00.000Z";
		broken.rows.facts.push(cold);
		expect((await t.feed(broken)).code).toBe("revision-gap");
		const different = batch(noRows(), 1, "fixture-other");
		const badBinding = add(ledger(), "separate-binding", "0.02");
		badBinding.links.task!.initiative = "wrong-event-parent";
		badBinding.source.stream = different.stream;
		different.rows.facts.push(badBinding);
		// An independent native stream must still see the older unrelated consistency witness.
		const expected = await collect(t.legacy, different),
			actual = await collectPaged(t.paged, different);
		expect(actual).toEqual(expected);
		expect(actual.code).toBe("revision-gap");
		expect(t.paged.checkpoint()).toEqual(t.legacy.checkpoint());
		expect(t.paged.checkpoint().cursors[0].cursor.ordinal).toBe(1);
		const r = await pagedReport(t.paged),
			frozen = report(t.legacy);
		expect({ ...r, faults: [] }).toEqual({ ...frozen, faults: [] }); // Only multi-source diagnostic refs intentionally collapse in the new header.
		partial(r, "collector:revision-gap");
		const evidence = await t.paged.evidence(AS_OF);
		expect(evidence.faultCounts).toContainEqual({ code: "revision-gap", count: 2 });
		expect(evidence.faults.filter((f) => f.code === "collector:revision-gap")).toEqual([
			{ code: "collector:revision-gap", ref: "collector" },
		]);
	});
	it("resolves cold history and prior revisions after reset without leaking old-week dollars into current coverage", async () => {
		const t = await twins();
		await t.feed(batch());
		const old = batch(noRows(), 2),
			f = add(ledger(), "previous-week", "0.3");
		f.occurredAt = "2026-10-18T10:00:00.000Z";
		f.source.observedAt = "2026-10-18T10:01:00.000Z";
		f.links.task = null;
		old.from = "2026-10-12T07:00:00.000Z";
		old.through = "2026-10-19T06:59:59.999Z";
		old.rows.facts.push(f);
		await t.feed(old);
		const resets = t.io.index.stats.resets,
			c = await openPaged(t.io);
		expect(t.io.index.stats.resets).toBe(resets + 1);
		const correction = batch(noRows(), 3);
		correction.from = old.from;
		correction.through = old.through;
		const revised = structuredClone(f);
		revised.revision = 1;
		revised.supersedes = 0;
		revised.source.observedAt = AS_OF;
		revised.prices[0].amount = "0.31";
		correction.rows.facts.push(revised);
		expect((await collectPaged(c, correction)).status).toBe("committed");
		await collect(t.legacy, correction);
		expect(await pagedReport(c)).toEqual(report(t.legacy));
		expect((await pagedInput(c)).input.facts).toHaveLength(3);
		expect((await pagedInput(c, AS_OF, "current-week")).input.facts).toHaveLength(1);
		expect(await pagedReport(await openPaged(t.io))).toEqual(await pagedReport(c));
	});
	it("fault-bearing pages and headers are defensive and reject a mixed generation", async () => {
		const io = pagedIO(),
			c = await openPaged(io);
		await collectPaged(c, batch());
		const e = await c.evidence(AS_OF);
		e.requiredStreams.length = 0;
		e.faults.push({ code: "fixture-tamper", ref: "fixture" });
		const pages = c.evidencePages(AS_OF);
		const first = await pages.next();
		fixtureCheck(!first.done, "first-evidence-page");
		first.value.rows.facts[0].prices[0].amount = "999";
		await collectPaged(c, batch(noRows(), 2));
		await expect(pages.next()).rejects.toThrow();
		expect(await pagedReport(c)).toMatchObject({ dedupKnownListUsd: "0.1", faults: [] });
		expect((await c.evidence(AS_OF)).requiredStreams).toEqual(["fixture-stream"]);
	});
	it.each(["missing-inventory", "unverified", "missing-io"])(
		"%s cannot expose a healthy empty page or start IO",
		async (kind) => {
			const io = pagedIO();
			const c = await UsageAccountingCollector.openPaged({
				inventory: kind === "missing-inventory" ? null : inventory(),
				verifier: kind === "unverified" ? null : VERIFIED,
				io: kind === "missing-io" ? null : io,
			});
			expect((await collectPaged(c, batch())).status).toBe("unavailable");
			expect((await c.evidence(AS_OF)).storage).toBe("unavailable");
			expect((await c.evidence(AS_OF)).faults.map((f) => f.code)).toContain("collector:collector-off");
			expect(io.stats.heads).toBe(0);
			expect(io.stats.appends).toBe(0);
			const iterator = c.evidencePages(AS_OF);
			const page = await iterator.next();
			fixtureCheck(!page.done, "unavailable-page");
			expect(pagedCount(page.value.rows)).toBe(0);
			await iterator.return(undefined);
		},
	);
	it.each(["invalid-batch", "batch-limit", "native-unverified", "truncated-source"])(
		"%s cannot retain rejected metadata, advance a cursor, or omit its fault header",
		async (code) => {
			const io = pagedIO(),
				c = await openPaged(io);
			await collectPaged(c, batch());
			const b = batch(noRows(), 2);
			let text: string;
			if (code === "native-unverified") {
				b.rows.roots.push({ ...ledger().roots[0], evidenceRef: "unapproved:fixture-only" });
				text = JSON.stringify(b);
			} else if (code === "truncated-source") {
				b.status = "partial";
				b.reason = "truncated";
				text = JSON.stringify(b);
			} else if (code === "batch-limit")
				text = "fixture-rejected-secret".repeat(
					Math.ceil((METER_LIMITS.pageBytes + 1) / "fixture-rejected-secret".length),
				);
			else text = JSON.stringify({ ...b, forbidden: "fixture-rejected-secret" });
			expect((await c.collect(b.stream, text, AS_OF)).code).toBe(code);
			expect(c.checkpoint().cursors[0].cursor.ordinal).toBe(1);
			expect(smallJournal(io)).not.toContain("fixture-rejected-secret");
			partial(await pagedReport(c), `collector:${code}`);
			expect(await pagedReport(await openPaged(io))).toEqual(await pagedReport(c));
		},
	);
});

describe("paged collector ordered durable prefixes, capacity and IO/index failures", () => {
	it("syncs journal before index-backed checkpoint and rebuilds even an apparently populated index", async () => {
		const io = pagedIO(),
			c = await openPaged(io);
		io.checkCommit = () => {
			expect(io.trace.lastIndexOf("after-journal-sync")).toBeGreaterThan(io.trace.lastIndexOf("after-append"));
			expect(c.checkpoint().cursors[0].cursor.ordinal).toBe(1);
			expect(JSON.parse(smallJournal(io).trim()).batch.rows.facts[0].prices[0].amount).toBe("0.10");
		};
		await collectPaged(c, batch());
		io.checkCommit = null;
		await io.index.write(
			[{ key: "f:fixture-ghost", value: { kind: "fault", code: "journal-corrupt", stream: null, at: AS_OF } }],
			FIXTURE_PAGE,
		);
		const reopened = await openPaged(io);
		expect(await pagedReport(reopened)).toEqual(accountUsage(ledger(), OPTIONS));
		expect(await io.index.get(["f:fixture-ghost"], FIXTURE_PAGE)).toEqual([]);
	});
	it.each(STAGES)(
		"crash at %s replays the exact durable prefix without double charging or skipping a cursor",
		async (stage) => {
			const io = pagedIO();
			let c = await openPaged(io);
			const first = batch();
			await collectPaged(c, first);
			const input = ledger(),
				warm = add(input, "warm", "0.02", "cache-warm"),
				next = batch(noRows(), 2);
			next.rows.facts.push(warm);
			next.rows.allocations.push(input.allocations[1]);
			io.hit = stage;
			expect((await collectPaged(c, next)).status).toBe("unavailable");
			io.hit = null;
			c = await openPaged(io);
			await collectPaged(c, next);
			await collectPaged(c, next);
			await collectPaged(c, first);
			expect(await pagedReport(c)).toEqual(accountUsage(input, OPTIONS));
			expect((await pagedReport(c)).dedupKnownListUsd).toBe(fixed.crashMainWarm);
			expect((await pagedInput(c)).input.facts).toHaveLength(2);
			expect(c.checkpoint().cursors[0].cursor.ordinal).toBe(2);
			expect(await pagedReport(await openPaged(io))).toEqual(await pagedReport(c));
		},
	);
	it("keeps torn bytes untouched, rotates append-only, and retains the fault after repaired ingestion and reopen", async () => {
		const io = pagedIO();
		let c = await openPaged(io);
		await collectPaged(c, batch());
		const input = ledger(),
			warm = add(input, "warm", "0.02", "cache-warm"),
			next = batch(noRows(), 2);
		next.rows.facts.push(warm);
		next.rows.allocations.push(input.allocations[1]);
		io.hit = "torn-append";
		await collectPaged(c, next);
		io.hit = null;
		const torn = readFileSync(io.path(1), "utf8");
		c = await openPaged(io);
		expect(c.checkpoint().cursors[0].cursor.ordinal).toBe(1);
		partial(await pagedReport(c), "collector:journal-tail");
		await collectPaged(c, next);
		await collectPaged(c, next);
		expect(readFileSync(io.path(1), "utf8")).toBe(torn);
		expect(existsSync(io.path(2))).toBe(true);
		expect((await pagedReport(c)).dedupKnownListUsd).toBe(fixed.crashMainWarm);
		partial(await pagedReport(c), "collector:journal-tail");
		expect(await pagedReport(await openPaged(io))).toEqual(await pagedReport(c));
	});
	it.each(["partial", "ahead", "wrong-offset", "wrong-digest"])(
		"%s checkpoint is not authority to skip journal replay",
		async (kind) => {
			const io = pagedIO(),
				c = await openPaged(io);
			await collectPaged(c, batch());
			const path = join(io.dir, "checkpoint.numeric"),
				cp = JSON.parse(readFileSync(path, "utf8"));
			if (kind === "ahead") cp.sequence += 9;
			if (kind === "wrong-offset") cp.end.offset += 1;
			if (kind === "wrong-digest") cp.sha256 = "a".repeat(64);
			writeFileSync(path, kind === "partial" ? '{"v":' : JSON.stringify(cp));
			const reopened = await openPaged(io);
			expect(reopened.checkpoint().cursors[0].cursor.ordinal).toBe(1);
			expect((await pagedReport(reopened)).dedupKnownListUsd).toBe("0.1");
			partial(await pagedReport(reopened), "collector:checkpoint-corrupt");
			await collectPaged(reopened, batch(noRows(), 2));
			partial(await pagedReport(await openPaged(io)), "collector:checkpoint-corrupt");
		},
	);
	it("corrupt complete frames retain only provable prefix dollars and expose no authoritative cursor", async () => {
		const io = pagedIO(),
			c = await openPaged(io);
		await collectPaged(c, batch());
		writeFileSync(io.path(1), "not-numeric-json\n", { flag: "a" });
		const before = smallJournal(io),
			reopened = await openPaged(io);
		expect(reopened.checkpoint().cursors).toEqual([]);
		expect((await pagedReport(reopened)).dedupKnownListUsd).toBe("0.1");
		partial(await pagedReport(reopened), "collector:journal-corrupt");
		expect((await collectPaged(reopened, batch(noRows(), 2))).status).toBe("unavailable");
		expect(smallJournal(io)).toBe(before);
	});
	it.each(["entries", "bytes"])(
		"a failed %s reservation writes one durable capacity fence, preserves the cursor and cannot reopen healthy",
		async (kind) => {
			const io = pagedIO(),
				c = await openPaged(io);
			await collectPaged(c, batch());
			if (kind === "entries") io.index.entryCap = io.index.entries + 2;
			else io.index.byteCap = io.index.bytes + 1024;
			const next = batch(noRows(), 2);
			expect(await collectPaged(c, next)).toMatchObject({
				status: "rejected",
				code: "store-capacity",
				cursor: { ordinal: 1 },
			});
			const sealed = smallJournal(io),
				sequence = c.checkpoint().sequence;
			expect(JSON.parse(sealed.trim().split("\n").at(-1)!).code).toBe("store-capacity");
			expect((await collectPaged(c, next)).status).toBe("unavailable");
			expect(smallJournal(io)).toBe(sealed);
			expect(c.checkpoint().sequence).toBe(sequence);
			partial(await pagedReport(c), "collector:store-capacity");
			io.index.entryCap = METER_LIMITS.indexEntries;
			io.index.byteCap = METER_LIMITS.indexBytes;
			const reopened = await openPaged(io);
			expect((await collectPaged(reopened, next)).code).toBe("store-capacity");
			expect(reopened.checkpoint().cursors[0].cursor.ordinal).toBe(1);
			expect((await pagedReport(reopened)).dedupKnownListUsd).toBe("0.1");
			partial(await pagedReport(reopened), "collector:store-capacity");
			expect(smallJournal(io)).toBe(sealed);
		},
	);
	it("dependency working-set exhaustion fences durably instead of truncating cold rows or asserting complete usage", async () => {
		const io = pagedIO(),
			c = await openPaged(io);
		await collectPaged(c, batch());
		const template = ledger().facts[0];
		let committed = 1,
			ordinal = 1,
			sealed = false;
		// Same 5,120 candidates, using the already approved full 256-row page.
		for (let page = 0; page < 20; page++) {
			const next = batch(noRows(), ordinal + 1);
			for (let row = 0; row < 256; row++) {
				const f = structuredClone(template);
				f.identity.attempt = `dependency-${page}-${row}`;
				f.id = factId(f.identity);
				f.source.event = f.identity.attempt;
				f.prices[0].amount = "0.000000000001";
				next.rows.facts.push(f);
			}
			const result = await collectPaged(c, next);
			if (result.code === "store-capacity") {
				expect(result.status).toBe("rejected");
				expect(result.cursor?.ordinal).toBe(ordinal);
				sealed = true;
				break;
			}
			expect(result.status).toBe("committed");
			committed += 256;
			ordinal++;
		}
		expect(sealed).toBe(true);
		expect(committed).toBeLessThanOrEqual(METER_LIMITS.lookupRows);
		const exported = await pagedInput(c);
		expect(exported.input.facts).toHaveLength(committed);
		expect((await pagedReport(c)).dedupKnownListUsd).toBe(fixtureUsd(fixtureUnits("0.1") + BigInt(committed - 1)));
		partial(await pagedReport(c), "collector:store-capacity");
		const reopened = await openPaged(io);
		expect((await pagedInput(reopened)).input.facts).toHaveLength(committed);
		expect(reopened.checkpoint().cursors[0].cursor.ordinal).toBe(ordinal);
		expect((await collectPaged(reopened, batch(noRows(), ordinal + 1))).code).toBe("store-capacity");
		partial(await pagedReport(reopened), "collector:store-capacity");
	}, 30_000);
	it("an escaped oversized snapshot receipt is capacity-fenced BEFORE append and remains replayable", async () => {
		const io = pagedIO(),
			c = await openPaged(io);
		await collectPaged(c, batch());
		const next = batch(noRows(), 2);
		next.rows.snapshots.push({
			producer: "pi",
			incarnation: "fixture-instance",
			run: "fixture-huge-snapshot",
			observedAt: AS_OF,
			state: "ended",
			price: ledger().facts[0].prices[0],
			coverage: "complete",
			coveredFactIds: Array.from({ length: 4500 }, (_, i) =>
				factId({ producer: "pi", incarnation: "i", attempt: `a${i}` }),
			),
		});
		const text = JSON.stringify(next);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(METER_LIMITS.pageBytes);
		expect(Buffer.byteLength(JSON.stringify(next.rows.snapshots[0]))).toBeLessThan(
			METER_LIMITS.pageBytes - 32 * 1024 - Buffer.byteLength(JSON.stringify(["fixture-stream"])),
		);
		// The receipt nests the source batch JSON as a string; its escaped encoding is the dangerous envelope.
		expect(
			Buffer.byteLength(
				JSON.stringify({ key: "b:fixture", value: { kind: "receipt", batch: text, code: null, sequence: 2 } }),
			),
		).toBeGreaterThan(METER_LIMITS.pageBytes);
		const appends = io.stats.appends;
		expect(await c.collect(next.stream, text, AS_OF)).toMatchObject({
			status: "rejected",
			code: "store-capacity",
			cursor: { ordinal: 1 },
		});
		expect(io.stats.appends).toBe(appends + 1);
		const frames = smallJournal(io)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(frames.map((frame) => frame.kind)).toEqual(["batch", "fault"]);
		expect(frames[1].code).toBe("store-capacity");
		const reopened = await openPaged(io);
		expect(reopened.checkpoint().cursors[0].cursor.ordinal).toBe(1);
		expect((await pagedInput(reopened)).input.snapshots).toEqual([]);
		expect((await pagedReport(reopened)).dedupKnownListUsd).toBe("0.1");
		partial(await pagedReport(reopened), "collector:store-capacity");
	});
	it("an oversized witness returned by a faulty index cannot be trusted, journalled or advance a cursor", async () => {
		const io = pagedIO(),
			c = await openPaged(io);
		await collectPaged(c, batch());
		const scan = io.index.scan.bind(io.index),
			component = "a".repeat(64);
		const entry: CollectorIndexEntry = {
			key: `w:${component}`,
			value: {
				kind: "witness",
				component,
				witness: { code: "revision-gap", phase: 1, order: "x".repeat(METER_LIMITS.pageBytes), sub: 0 },
			},
		};
		io.index.scan = async (prefix, after, limits) =>
			prefix === "w:" ? { entries: [entry], after: null } : scan(prefix, after, limits);
		const result = await collectPaged(c, batch(noRows(), 2));
		expect(result).toMatchObject({ status: "rejected", code: "index-unavailable", cursor: { ordinal: 1 } });
		expect(c.checkpoint().cursors).toEqual([]);
		io.index.scan = scan;
		expect(smallJournal(io)).not.toContain("x".repeat(1024));
		const reopened = await openPaged(io);
		expect(reopened.checkpoint().cursors[0].cursor.ordinal).toBe(1);
		partial(await pagedReport(reopened), "collector:index-unavailable");
	});
	it.each(["journal-tail", "checkpoint-corrupt"])(
		"%s pending-fault reserve failure uses the final durable fence instead of an unreplayable append",
		async (kind) => {
			const io = pagedIO(),
				c = await openPaged(io);
			await collectPaged(c, batch());
			if (kind === "journal-tail") writeFileSync(io.path(1), "{", { flag: "a" });
			else writeFileSync(join(io.dir, "checkpoint.numeric"), '{"v":');
			const reopened = await openPaged(io),
				before = smallJournal(io),
				appends = io.stats.appends;
			io.index.entryCap = io.index.entries + 2; // reserve returns false, but the final fault's physical capacity remains.
			expect(await collectPaged(reopened, batch(noRows(), 2))).toMatchObject({
				status: "rejected",
				code: "store-capacity",
				cursor: { ordinal: 1 },
			});
			expect(io.stats.appends).toBe(appends + 1);
			expect(smallJournal(io).startsWith(before)).toBe(true);
			partial(await pagedReport(reopened), "collector:store-capacity");
			partial(await pagedReport(reopened), `collector:${kind}`);
			io.index.entryCap = METER_LIMITS.indexEntries;
			const recovered = await openPaged(io);
			expect(recovered.checkpoint().cursors[0].cursor.ordinal).toBe(1);
			expect((await collectPaged(recovered, batch(noRows(), 2))).code).toBe("store-capacity");
			expect((await pagedReport(recovered)).dedupKnownListUsd).toBe("0.1");
			partial(await pagedReport(recovered), "collector:store-capacity");
		},
	);
	it.each(["get", "scan", "reserve", "write", "partial-write"])(
		"%s index failure cannot publish optimistic health or an uncommitted cursor",
		async (failure) => {
			const io = pagedIO(),
				c = await openPaged(io);
			await collectPaged(c, batch());
			if (failure === "partial-write") io.index.partialWrite = true;
			else io.index.fail = failure as "get" | "scan" | "reserve" | "write";
			const next = batch(noRows(), 2),
				result = await collectPaged(c, next);
			expect(result.status).not.toBe("committed");
			expect(c.checkpoint().cursors).toEqual([]);
			expect((await c.evidence(AS_OF)).storage).toBe("unavailable");
			io.index.fail = null;
			io.index.partialWrite = false;
			const reopened = await openPaged(io);
			if (failure === "write" || failure === "partial-write") {
				// Journal sync won; a half-updated derived cache is discarded and the committed frame is replayed.
				expect(reopened.checkpoint().cursors[0].cursor.ordinal).toBe(2);
				expect((await collectPaged(reopened, next)).status).toBe("duplicate");
			} else {
				expect(reopened.checkpoint().cursors[0].cursor.ordinal).toBe(1);
				if (failure === "reserve") expect(await pagedReport(reopened)).toEqual(accountUsage(ledger(), OPTIONS));
				else partial(await pagedReport(reopened), "collector:index-unavailable");
			}
		},
	);
	it.each(["head", "read-page", "short-page", "reset"])(
		"%s recovery failure exposes unavailable state rather than an empty complete week",
		async (failure) => {
			const io = pagedIO(),
				c = await openPaged(io);
			await collectPaged(c, batch());
			if (failure === "reset") io.index.fail = "reset";
			else io.hit = failure;
			const reopened = await openPaged(io);
			expect(reopened.checkpoint().cursors).toEqual([]);
			expect((await reopened.evidence(AS_OF)).storage).toBe("unavailable");
			expect((await collectPaged(reopened, batch(noRows(), 2))).status).toBe("unavailable");
			io.hit = null;
			io.index.fail = null;
			expect(await pagedReport(await openPaged(io))).toEqual(accountUsage(ledger(), OPTIONS));
		},
	);
	it("SQLite scan uses binary order and bounded continuations, including absent-key lookups", async () => {
		const io = pagedIO(),
			keys = ["r:Z", "r:a", "r:0", "r:A", "r:_", "r:z", "r:-"];
		await io.index.reset();
		await io.index.write(
			keys.map((key) => ({
				key,
				value: { kind: "fault" as const, code: "journal-tail" as const, stream: null, at: AS_OF },
			})),
			FIXTURE_PAGE,
		);
		const found: string[] = [];
		let after: string | null = null;
		do {
			const page = await io.index.scan("r:", after, { maxRows: 2, maxBytes: 1024 });
			found.push(...page.entries.map((e) => e.key));
			after = page.after;
		} while (after !== null);
		expect(found).toEqual([...keys].sort());
		expect(await io.index.get(["r:absent"], FIXTURE_PAGE)).toEqual([]);
		expect(io.index.stats.maxScanRows).toBe(2);
		expect(io.index.stats.negative).toBe(1);
	});
});

// BEGIN W0 WORKER MEASUREMENT -- synthetic files and scalar results only, no live sources/root authority.
async function isolatedPagedMeasurement(dir: string, asOf: string, from: string) {
	const io = new PagedFixtureIO(dir);
	const started = performance.now();
	let peakHeap = 0,
		peakRss = 0;
	const sample = () => {
		const m = process.memoryUsage();
		peakHeap = Math.max(peakHeap, m.heapUsed);
		peakRss = Math.max(peakRss, m.rss);
	};
	const memorySampler = setInterval(sample, 20);
	sample();
	try {
		const sourceCount = 65,
			attemptCount = 100_000;
		const inv: SourceInventory = {
			v: "usage-inventory/1",
			evidenceRef: "fixture-only:benchmark-inventory",
			observedAt: asOf,
			complete: true,
			sources: Array.from({ length: sourceCount }, (_, i) => ({
				stream: `fixture-native-${i}`,
				incarnation: "fixture-native-incarnation",
				adapterRef: "fixture-only:benchmark-adapter",
				producer: "pi" as const,
				occurrenceStreams: [`fixture-native-${i}`],
				retainedFrom: from,
				grants: ["facts" as const],
			})),
		};
		// A closed synthetic witness only. Deliberately grants NO root/allocation/alias authority.
		const verifier: CollectorVerifier = {
			inventory: (value) => value.evidenceRef === "fixture-only:benchmark-inventory",
			batch: (b) =>
				b.adapterRef === "fixture-only:benchmark-adapter" &&
				PAGED_KEYS.every((key) => key === "facts" || b.rows[key].length === 0),
		};
		const amount = (i: number) => (i % 3 === 0 ? "0.10" : i % 3 === 1 ? "0.000000000001" : "0.03");
		const fact = (i: number, source: number): UsageFact => {
			const identity = {
				producer: "pi" as const,
				incarnation: "fixture-native-incarnation",
				attempt: `fixture-attempt-${i}`,
			};
			return {
				v: "usage-fact/1",
				id: factId(identity),
				revision: 0,
				supersedes: null,
				identity,
				identityStatus: "verified",
				occurredAt: "2026-10-20T10:00:00.000Z",
				provider: "fixture-provider",
				model: "fixture-model",
				kind: "assistant",
				tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
				prices: [
					{
						basis: "list-estimate",
						currency: "USD",
						amount: amount(i),
						status: "known",
						rateVersion: "fixture-rates/1",
					},
				],
				source: {
					stream: inv.sources[source].stream,
					event: `fixture-event-${i}`,
					observedAt: asOf,
					coverage: "complete",
				},
				links: { task: null, session: null, run: null },
			};
		};
		const ordinals = Array<number>(sourceCount).fill(0); // <=65 cursors, never 100k facts.
		const cursor = (source: number, ordinal: number) => ({
			ordinal,
			token: `fixture-only:opaque-${source}-${ordinal * 17 + 11}`,
		});
		const envelope = (source: number, rows: NumericRows, ordinal: number): SourceBatch => ({
			v: "usage-source-batch/1",
			stream: inv.sources[source].stream,
			incarnation: inv.sources[source].incarnation,
			adapterRef: "fixture-only:benchmark-adapter",
			fromCursor: ordinal === 1 ? null : cursor(source, ordinal - 1),
			toCursor: cursor(source, ordinal),
			from,
			through: asOf,
			observedAt: asOf,
			status: "complete",
			reason: "none",
			rows,
		});
		let generated = 0,
			expected = 0n,
			maxBatchRows = 0,
			maxBatchBytes = 0;
		// Generate source files a page at a time, then discard each page. No 100k array or journal string exists.
		for (let source = 0; source < sourceCount; source++) {
			const fd = openSync(join(dir, `native-${source}.synthetic`), "wx", 0o600);
			try {
				let rows = pagedEmpty();
				const flush = () => {
					if (!rows.facts.length) return;
					const b = envelope(source, rows, ++ordinals[source]),
						text = JSON.stringify(b);
					maxBatchRows = Math.max(maxBatchRows, pagedCount(rows));
					maxBatchBytes = Math.max(maxBatchBytes, Buffer.byteLength(text));
					fixtureCheck(
						pagedCount(rows) <= METER_LIMITS.pageRows && Buffer.byteLength(text) <= METER_LIMITS.pageBytes,
						"native-batch-bound",
					);
					writeFileSync(fd, text + "\n");
					rows = pagedEmpty();
				};
				for (let i = source; i < attemptCount; i += sourceCount) {
					rows.facts.push(fact(i, source));
					expected += fixtureUnits(amount(i));
					generated++;
					if (rows.facts.length === 128) {
						flush();
						await fixtureYield();
					}
				}
				flush();
			} finally {
				closeSync(fd);
			}
		}
		fixtureCheck(generated === attemptCount, "generated-count");
		async function* nativePages(source: number): AsyncGenerator<string> {
			const fd = openSync(join(dir, `native-${source}.synthetic`), "r"),
				page = Buffer.allocUnsafe(METER_LIMITS.pageBytes);
			let offset = 0,
				carry = Buffer.alloc(0);
			try {
				while (true) {
					const count = readSync(fd, page, 0, page.length, offset);
					if (!count) break;
					offset += count;
					const input = Buffer.concat([carry, page.subarray(0, count)]);
					let start = 0,
						end: number;
					while ((end = input.indexOf(10, start)) >= 0) {
						fixtureCheck(end - start <= METER_LIMITS.pageBytes, "native-line-bound");
						yield input.subarray(start, end).toString("utf8");
						start = end + 1;
					}
					carry = Buffer.from(input.subarray(start));
					fixtureCheck(carry.length <= METER_LIMITS.pageBytes, "native-carry-bound");
					await fixtureYield();
				}
				fixtureCheck(carry.length === 0, "native-complete-line");
			} finally {
				closeSync(fd);
			}
		}
		const ingestStart = performance.now();
		let c = await UsageAccountingCollector.openPaged({ inventory: inv, verifier, io });
		for (let source = 0; source < sourceCount; source++)
			for await (const text of nativePages(source)) {
				const result = await c.collect(inv.sources[source].stream, text, asOf);
				fixtureCheck(
					result.status === "committed",
					`ingestion-committed:${source}:${result.status}:${result.code}:${result.sequence}`,
				);
			}
		const initialIngestionMs = performance.now() - ingestStart,
			initial = c.metrics();
		sample();
		fixtureCheck(initial.journalBytes > 16 * 1024 * 1024, "journal-over-16-mib");
		fixtureCheck(c.checkpoint().cursors.length === sourceCount, "all-native-cursors");
		const foldCurrent = async (collector: PagedUsageAccountingCollector) => {
			let facts = 0,
				total = 0n,
				pages = 0,
				maxRows = 0,
				maxBytes = 0;
			for await (const page of collector.evidencePages(asOf, "current-week")) {
				const rows = pagedCount(page.rows) + page.coverage.length,
					bytes = Buffer.byteLength(JSON.stringify(page));
				fixtureCheck(
					page.evidence.storage === "healthy" &&
						page.evidence.faults.length === 0 &&
						page.evidence.requiredStreams.length === sourceCount,
					"publication-health",
				);
				fixtureCheck(rows <= METER_LIMITS.pageRows && bytes <= METER_LIMITS.pageBytes, "publication-page-bound");
				maxRows = Math.max(maxRows, rows);
				maxBytes = Math.max(maxBytes, bytes);
				pages++;
				for (const f of page.rows.facts) {
					fixtureCheck(f.revision === 0, "fixture-no-revision");
					total += fixtureUnits(f.prices[0].amount!);
					facts++;
				}
			}
			return { facts, total: fixtureUsd(total), pages, maxRows, maxBytes };
		};
		const replayStart = performance.now();
		c = await UsageAccountingCollector.openPaged({ inventory: inv, verifier, io });
		const replayed = await foldCurrent(c),
			replayMs = performance.now() - replayStart,
			replay = c.metrics();
		sample();
		fixtureCheck(replayed.facts === attemptCount && replayed.total === fixtureUsd(expected), "replay-exact-total");
		fixtureCheck(c.checkpoint().cursors.length === sourceCount, "replayed-cursors");
		const updateStart = performance.now(),
			updateRows = pagedEmpty();
		updateRows.facts.push(fact(attemptCount, 0));
		const update = envelope(0, updateRows, ordinals[0] + 1),
			updateText = JSON.stringify(update);
		fixtureCheck((await c.collect(update.stream, updateText, asOf)).status === "committed", "update-committed");
		const published = await foldCurrent(c),
			currentWeekUpdatePublicationMs = performance.now() - updateStart,
			updated = c.metrics();
		sample();
		fixtureCheck(
			published.facts === attemptCount + 1 &&
				published.total === fixtureUsd(expected + fixtureUnits(amount(attemptCount))),
			"update-exact-total",
		);
		const durableSequence = c.checkpoint().sequence;
		fixtureCheck(
			(await c.collect(update.stream, updateText, asOf)).status === "duplicate" &&
				c.checkpoint().sequence === durableSequence,
			"update-idempotent",
		);
		return {
			attempts: attemptCount,
			rows: replayed.facts,
			nativeSources: sourceCount,
			initialIngestionMs,
			replayMs,
			currentWeekUpdatePublicationMs,
			totalFixtureMs: performance.now() - started,
			exactUsd: replayed.total,
			publishedUsd: published.total,
			initial,
			replay,
			updated,
			peakHeap,
			peakRss,
			maxBatchRows,
			maxBatchBytes,
			publication: published,
			io: io.stats,
			index: io.index.stats,
			indexEntries: io.index.entries,
			indexBytes: io.index.bytes,
			sqliteCacheBytes: 8 * 1024 * 1024,
		};
	} finally {
		clearInterval(memorySampler);
		io.close();
	}
}
// END W0 WORKER MEASUREMENT

type FixtureMeasurement = Awaited<ReturnType<typeof isolatedPagedMeasurement>>;
class CallbackLatency {
	private bins = new Uint32Array(10_002); // 0.1ms buckets through 1000ms plus one overflow bucket.
	count = 0;
	maxMs = 0;
	add(ms: number): void {
		this.count++;
		this.maxMs = Math.max(this.maxMs, ms);
		this.bins[Math.min(this.bins.length - 1, Math.ceil(ms * 10))]++;
	}
	summary(): { count: number; p95Ms: number; maxMs: number } {
		const target = Math.ceil(this.count * 0.95);
		let n = 0,
			bucket = 0;
		for (; bucket < this.bins.length; bucket++) {
			n += this.bins[bucket];
			if (n >= target) break;
		}
		return { count: this.count, p95Ms: bucket / 10, maxMs: this.maxMs };
	}
}
function parentFsProbe(): Promise<number> {
	const at = performance.now();
	return new Promise((done, fail) =>
		readFile(new URL("../fixtures/usage-accounting/ledger.json", import.meta.url), (error) =>
			error ? fail(error) : done(performance.now() - at),
		),
	);
}
async function measurementWorker(dir: string): Promise<Worker> {
	const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
	const section = (name: string) => {
		const begin = `// BEGIN W0 ${name}`,
			end = `// END W0 ${name}`,
			at = self.indexOf(begin);
		fixtureCheck(at >= 0 && self.indexOf(end, at) > at, "owned-worker-section");
		return self.slice(self.indexOf("\n", at) + 1, self.indexOf(end, at));
	};
	const compiled = await build({
		stdin: {
			contents: `
			import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
			import { join } from 'node:path'; import { DatabaseSync } from 'node:sqlite';
			import { setImmediate as fixtureYield } from 'node:timers/promises'; import { parentPort, workerData } from 'node:worker_threads';
			import { UsageAccountingCollector } from ${JSON.stringify(fileURLToPath(new URL("../../server/usage-accounting-collector.ts", import.meta.url)))};
			import { factId } from ${JSON.stringify(fileURLToPath(new URL("../../server/usage-accounting-contract.ts", import.meta.url)))};
			import { METER_LIMITS } from ${JSON.stringify(fileURLToPath(new URL("../../server/usage-accounting-meter-contract.ts", import.meta.url)))};
			${section("SHARED FIXTURE")}
			${section("WORKER MEASUREMENT")}
			isolatedPagedMeasurement(workerData.dir, workerData.asOf, workerData.from).then(
				value => parentPort.postMessage({kind:'measurement', value}),
				error => { parentPort.postMessage({kind:'failure', code: String(error?.message ?? 'fixture-worker-failed').slice(0, 240)}); process.exitCode = 1; }
			);`,
			loader: "ts",
			resolveDir: dirname(fileURLToPath(import.meta.url)),
			sourcefile: "w0-owned-fixture.ts",
		},
		bundle: true,
		platform: "node",
		target: "node22",
		format: "cjs",
		write: false,
		logLevel: "silent",
	});
	fixtureCheck(compiled.outputFiles?.length === 1, "worker-bundle");
	const worker = new Worker(compiled.outputFiles[0].text, {
		eval: true,
		resourceLimits: { ...METER_WORKER_RESOURCE_LIMITS },
		workerData: { dir, asOf: AS_OF, from: fixed.weekFrom },
	});
	fixtureWorkers.add(worker);
	return worker;
}

describe("W0 isolated worker resource and shared-pool callback envelope", () => {
	it("ingests/replays 100000 current-week attempts across 65 synthetic sources then independently updates/publishes within finite budgets", async () => {
		for (const value of Object.values(METER_WORKER_RESOURCE_LIMITS)) {
			expect(Number.isFinite(value)).toBe(true);
			expect(value).toBeGreaterThan(0);
		}
		const baseline = new CallbackLatency();
		for (let i = 0; i < 128; i++) baseline.add(await parentFsProbe());
		const dir = mkdtempSync(join(tmpdir(), "usage-accounting-worker-")),
			load = new CallbackLatency();
		let finished = false,
			stopSampling = false;
		const worker = await measurementWorker(dir).catch((error) => {
			rmSync(dir, { recursive: true, force: true });
			throw error;
		});
		const actualResourceLimits = { ...worker.resourceLimits };
		try {
			expect(actualResourceLimits).toMatchObject(METER_WORKER_RESOURCE_LIMITS);
			const result = new Promise<FixtureMeasurement>((done, fail) => {
				worker.once("error", fail);
				worker.on("message", (message) =>
					message?.kind === "measurement"
						? done(message.value as FixtureMeasurement)
						: fail(new Error(String(message?.code ?? "fixture-worker-message"))),
				);
				worker.once("exit", (code) => {
					if (!finished) fail(new Error(`fixture-worker-exit:${code}`));
				});
			});
			const sampling = (async () => {
				while (!stopSampling) load.add(await parentFsProbe());
			})();
			let measured: FixtureMeasurement;
			try {
				measured = await result;
				finished = true;
			} finally {
				stopSampling = true;
				await sampling;
			}
			const base = baseline.summary(),
				loaded = load.summary();
			const envelope = { p95Ms: Math.max(100, base.p95Ms * 10), maxMs: 1000 };
			// vitest's silent/onConsoleLog suppresses console.log; this is a concise scalar receipt, never payload/journal.
			process.stdout.write(
				`W0-MEASURE ${JSON.stringify({ ...measured, parentFs: { baseline: base, load: loaded, envelope }, resourceLimits: actualResourceLimits })}\n`,
			);
			expect(measured.attempts).toBe(100_000);
			expect(measured.rows).toBe(100_000);
			expect(measured.rows).toBeGreaterThan(10_000);
			expect(measured.nativeSources).toBeGreaterThan(64);
			expect(measured.initial.journalBytes).toBeGreaterThan(16 * 1024 * 1024);
			expect(measured.exactUsd).toBe("4333.390000033333");
			expect(measured.publication.facts).toBe(100_001);
			expect(measured.publishedUsd).toBe("4333.390000033334");
			// W0's 30-second bar is warm update + publication, not initial/cold recovery.
			// Cold phases remain measured under a separate 240-second full-suite harness deadline.
			for (const ms of [measured.initialIngestionMs, measured.replayMs]) {
				expect(Number.isFinite(ms) && ms >= 0).toBe(true);
			}
			expect(measured.currentWeekUpdatePublicationMs).toBeGreaterThanOrEqual(0);
			expect(measured.currentWeekUpdatePublicationMs).toBeLessThan(30_000);
			expect(measured.totalFixtureMs).toBeLessThan(240_000);
			for (const metrics of [measured.initial, measured.replay, measured.updated]) {
				expect(metrics.yields).toBeGreaterThan(0);
				expect(metrics.maxActiveMs).toBeLessThanOrEqual(METER_LIMITS.unitWorkMs);
			}
			expect(measured.maxBatchRows).toBeLessThanOrEqual(256);
			expect(measured.maxBatchBytes).toBeLessThanOrEqual(256 * 1024);
			expect(measured.publication.maxRows).toBeLessThanOrEqual(256);
			expect(measured.publication.maxBytes).toBeLessThanOrEqual(256 * 1024);
			expect(measured.publication.pages).toBeGreaterThan(390);
			expect(measured.io.reads).toBeGreaterThan(64);
			expect(measured.io.maxReadBytes).toBeLessThanOrEqual(256 * 1024);
			for (const key of ["maxGetRows", "maxScanRows", "maxWriteRows"] as const)
				expect(measured.index[key]).toBeLessThanOrEqual(256);
			for (const key of ["maxGetBytes", "maxScanBytes", "maxWriteBytes"] as const)
				expect(measured.index[key]).toBeLessThanOrEqual(256 * 1024);
			expect(measured.indexEntries).toBeLessThanOrEqual(METER_LIMITS.indexEntries);
			expect(measured.indexBytes).toBeLessThanOrEqual(METER_LIMITS.indexBytes);
			expect(measured.sqliteCacheBytes).toBeLessThanOrEqual(METER_LIMITS.indexCacheBytes);
			expect(measured.peakHeap).toBeGreaterThan(0);
			expect(measured.peakHeap).toBeLessThanOrEqual(METER_LIMITS.acceptedHeapBytes);
			expect(measured.peakRss).toBeGreaterThan(0);
			expect(measured.peakRss).toBeLessThanOrEqual(METER_LIMITS.acceptedProcessRssBytes);
			expect(loaded.count).toBeGreaterThan(128);
			expect(loaded.p95Ms).toBeLessThanOrEqual(envelope.p95Ms);
			expect(loaded.maxMs).toBeLessThanOrEqual(envelope.maxMs);
		} finally {
			await worker.terminate();
			fixtureWorkers.delete(worker);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 240_000);
	it("a resource-limited worker dies into a handled error while the parent filesystem callbacks remain healthy", async () => {
		const limits = { ...METER_WORKER_RESOURCE_LIMITS, maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 };
		const worker = new Worker("const retained=[]; for(;;) retained.push(Array.from({length:32768},(_,i)=>i));", {
			eval: true,
			resourceLimits: limits,
		});
		fixtureWorkers.add(worker);
		let error: (Error & { code?: string }) | null = null,
			ended = false;
		const latency = new CallbackLatency();
		try {
			const exit = new Promise<number>((done) => {
				worker.on("error", (value) => {
					if (value instanceof Error) error = value;
				});
				worker.once("exit", (code) => {
					ended = true;
					done(code);
				});
			});
			while (!ended) latency.add(await parentFsProbe());
			expect(await exit).not.toBe(0);
			expect((error as (Error & { code?: string }) | null)?.code).toBe("ERR_WORKER_OUT_OF_MEMORY");
			// W6 owns actual lifecycle wiring; the closed host seam cannot turn this loss into ready/zero.
			const health = {
				v: "usage-meter-health/1",
				epoch: "f".repeat(64),
				at: AS_OF,
				state: "unavailable",
				code: "worker-unavailable",
			};
			expect(parseMeterWorkerMessage(JSON.stringify(health))).toEqual(health);
			expect(parseMeterWorkerMessage(JSON.stringify({ ...health, state: "ready" }))).toBeNull();
			const after = await parentFsProbe();
			expect(after).toBeLessThanOrEqual(1000);
			expect(latency.summary().maxMs).toBeLessThanOrEqual(1000);
			process.stdout.write(
				`W0-MEASURE ${JSON.stringify({ kind: "resource-limit-exit", code: (error as (Error & { code?: string }) | null)?.code, parentFs: latency.summary(), afterMs: after, resourceLimits: limits })}\n`,
			);
		} finally {
			await worker.terminate();
			fixtureWorkers.delete(worker);
		}
	}, 15_000);
});

// Exact reviewed importers are runtime/worker modules, not a directory/basename exception.
// Every dependency is traversed, INCLUDING erased `import type` / `export type` / typeof import.
// All mutations are virtual; this guard never rewrites a production source.
describe("paged collector exact importer allowlist and positive main-thread import graph", () => {
	const project = fileURLToPath(new URL("../../", import.meta.url)),
		server = join(project, "server");
	const collector = join(server, "usage-accounting-collector.ts");
	const allowed = ["usage-accounting-store.ts", "usage-accounting-worker.ts", "usage-accounting-snapshot.ts"];
	const roots = ["index.ts", "roles-overview.ts", "protocol.ts", "usage-accounting-meter-cache.ts"];
	const engines = [
		"usage-accounting-collector.ts",
		"usage-accounting-pi-sessions.ts",
		"usage-accounting-membership.ts",
		"usage-accounting-roles.ts",
		"usage-accounting-funding.ts",
		"usage-accounting-store.ts",
		"usage-accounting-ledger-source.ts",
		"usage-accounting-pi-source.ts",
		"usage-accounting-temper-source.ts",
		"usage-accounting-snapshot.ts",
	];
	const forbidden = new Set(engines.map((file) => join(server, file)));
	type ImportHost = { fileExists(file: string): boolean; readFile(file: string): string | undefined };
	type ImportOptions = { paths?: Record<string, string[]>; baseUrl?: string };
	const config = JSON.parse(readFileSync(join(project, "tsconfig.server.json"), "utf8")) as {
		extends?: unknown;
		compilerOptions: ImportOptions;
	};
	if (config.extends) throw new Error("collector import guard must resolve extended server config before accepting it");
	const options = config.compilerOptions;
	const disk: ImportHost = {
		fileExists: existsSync,
		readFile: (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
	};
	const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];
	function serverFiles(dir = server): string[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const path = join(dir, entry.name);
			return entry.isDirectory() ? serverFiles(path) : extensions.includes(extname(path)) ? [path] : [];
		});
	}
	const syntaxDir = join(project, ".collector-import-guard-memory");
	const syntaxFs = createVirtualFileSystem({});
	const parser = new API({ cwd: project, fs: { ...syntaxFs, readFile: (file) => syntaxFs.readFile!(file) ?? null } });
	let parserProject: string | undefined;
	let syntaxBatch = 0;
	afterAll(() => parser.close());
	type Reference = { specifier: string; typeOnly: boolean };
	const referenceCache = new Map<string, Reference[]>();
	function referenceKey(file: string, text: string): string {
		return `${[".tsx", ".jsx"].includes(extname(file)) ? ".tsx" : ".ts"}\0${text}`;
	}
	function cacheReferences(files: string[], host: Pick<ImportHost, "readFile">): void {
		const pending = new Map<string, { file: string; text: string }>();
		for (const file of files) {
			const text = host.readFile(file);
			if (text === undefined) throw new Error(`missing graph module: ${file}`);
			const key = referenceKey(file, text);
			if (!referenceCache.has(key)) pending.set(key, { file, text });
		}
		if (!pending.size) return;
		// Immutable file AND project identities avoid TS 7 retaining the first AST at a reused path.
		// Batch a real-tree scan into one snapshot instead of rebuilding a project for every module.
		const syntaxConfig = join(syntaxDir, String(syntaxBatch++), "tsconfig.json");
		const inputs = [...pending].map(([key, { file, text }], index) => {
			const input = join(dirname(syntaxConfig), `${index}${[".tsx", ".jsx"].includes(extname(file)) ? ".tsx" : ".ts"}`);
			syntaxFs.writeFile!(input, text);
			return { key, file, text, input };
		});
		syntaxFs.writeFile!(
			syntaxConfig,
			JSON.stringify({
				compilerOptions: { noResolve: true, noLib: true, types: [], noEmit: true, jsx: "preserve" },
				files: inputs.map(({ input }) => input),
			}),
		);
		const snapshot = parser.updateSnapshot({
			openProjects: [syntaxConfig],
			...(parserProject ? { closeProjects: [parserProject] } : {}),
		});
		parserProject = syntaxConfig;
		try {
			const program = snapshot.getProject(syntaxConfig)?.program;
			if (!program) throw new Error(`missing virtual project: ${syntaxConfig}`);
			for (const { key, file, text, input } of inputs) {
				const source = program.getSourceFile(input);
				if (!source) throw new Error(`missing virtual AST: ${file}`);
				if (source.text !== text) throw new Error(`stale virtual AST: ${file}`);
				referenceCache.set(key, readReferences(source));
			}
		} finally {
			snapshot.dispose();
		}
	}
	function references(file: string, text: string): Reference[] {
		const key = referenceKey(file, text);
		if (!referenceCache.has(key)) cacheReferences([file], { readFile: () => text });
		return referenceCache.get(key)!;
	}
	function readReferences(source: ts.SourceFile): Reference[] {
		const refs: Reference[] = [];
		function visit(node: ts.Node): void {
			let specifier: ts.Node | undefined,
				typeOnly = false;
			if (ts.isImportDeclaration(node)) {
				specifier = node.moduleSpecifier;
				typeOnly = node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
			} else if (ts.isExportDeclaration(node)) {
				specifier = node.moduleSpecifier;
				typeOnly = node.isTypeOnly;
			} else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
				specifier = node.moduleReference.expression;
				typeOnly = node.isTypeOnly;
			} else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
				specifier = node.argument.literal;
				typeOnly = true;
			} else if (
				ts.isCallExpression(node) &&
				(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
					(ts.isIdentifier(node.expression) && node.expression.text === "require") ||
					(ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "require"))
			)
				specifier = node.arguments[0];
			if (specifier && ts.isStringLiteralLikeNode(specifier)) refs.push({ specifier: specifier.text, typeOnly });
			node.forEachChild(visit);
		}
		visit(source);
		return refs;
	}
	function target(file: string, specifier: string, host: ImportHost, compilerOptions = options): string | null {
		const base = resolve(project, compilerOptions.baseUrl ?? ".");
		let candidates: string[] | undefined;
		if (specifier.startsWith(".") || isAbsolute(specifier)) candidates = [resolve(dirname(file), specifier)];
		else {
			const aliases = Object.entries(compilerOptions.paths ?? {}).sort(
				([a], [b]) => Number(b === specifier) - Number(a === specifier) || b.indexOf("*") - a.indexOf("*"),
			);
			for (const [alias, paths] of aliases) {
				const star = alias.indexOf("*");
				const matches =
					star < 0
						? alias === specifier
						: specifier.startsWith(alias.slice(0, star)) && specifier.endsWith(alias.slice(star + 1));
				if (!matches) continue;
				const match = star < 0 ? "" : specifier.slice(star, specifier.length - alias.length + star + 1);
				candidates = paths.map((path) => resolve(base, path.replace("*", match)));
				break;
			}
		}
		if (!candidates) {
			if (specifier.startsWith("#")) throw new Error(`unresolved package alias: ${specifier}`);
			return null;
		}
		for (const candidate of candidates) {
			const extension = extname(candidate),
				stem = candidate.slice(0, candidate.length - extension.length);
			const replacements =
				extension === ".js"
					? [stem + ".ts", stem + ".tsx"]
					: extension === ".mjs"
						? [stem + ".mts"]
						: extension === ".cjs"
							? [stem + ".cts"]
							: [];
			const paths = extension
				? [...replacements, candidate]
				: [
						...extensions.map((suffix) => candidate + suffix),
						...extensions.map((suffix) => join(candidate, "index" + suffix)),
					];
			const found = paths.find((path) => host.fileExists(path));
			if (found) return found;
		}
		throw new Error(`unresolved local import: ${relative(project, file)} -> ${specifier}`);
	}
	function unreviewed(files: string[], host: ImportHost, compilerOptions = options): string[] {
		cacheReferences(files, host);
		return files
			.filter(
				(file) =>
					file !== collector &&
					references(file, host.readFile(file)!).some(
						(ref) => target(file, ref.specifier, host, compilerOptions) === collector,
					),
			)
			.filter((file) => !allowed.some((name) => file === join(server, name)))
			.map((file) => relative(server, file))
			.sort();
	}
	function enginePaths(host: ImportHost, entrypoints: string[], compilerOptions = options): string[][] {
		const paths: string[][] = [],
			parsed = new Map<string, Reference[]>();
		for (const root of entrypoints) {
			const seen = new Set<string>();
			function visit(file: string, path: string[]): void {
				if (seen.has(file)) return;
				seen.add(file);
				let refs = parsed.get(file);
				if (!refs) {
					const text = host.readFile(file);
					if (text === undefined) throw new Error(`missing graph module: ${file}`);
					refs = references(file, text);
					parsed.set(file, refs);
				}
				for (const ref of refs) {
					const dependency = target(file, ref.specifier, host, compilerOptions);
					if (!dependency) continue;
					const next = [...path, relative(server, dependency)];
					if (forbidden.has(dependency)) paths.push(next);
					else visit(dependency, next); // Never skip ref.typeOnly: erased types are forbidden engine edges too.
				}
			}
			visit(join(server, root), [root]);
		}
		return paths;
	}
	function cacheImports(host: ImportHost): Reference[] {
		const file = join(server, "usage-accounting-meter-cache.ts");
		return references(file, host.readFile(file)!).filter(
			(ref) =>
				!ref.typeOnly || target(file, ref.specifier, host) !== join(server, "usage-accounting-meter-contract.ts"),
		);
	}
	function memoryHost(modules: Record<string, string>): ImportHost {
		const files = new Map(Object.entries(modules).map(([name, text]) => [join(server, name), text]));
		return { fileExists: (file) => files.has(resolve(file)), readFile: (file) => files.get(resolve(file)) };
	}
	const forms = [
		(specifier: string) => `import { value } from '${specifier}';`,
		(specifier: string) => `import '${specifier}';`,
		(specifier: string) => `export { value } from '${specifier}';`,
		(specifier: string) => `export * from '${specifier}';`,
		(specifier: string) => `void import('${specifier}');`,
		(specifier: string) => `void import(\`${specifier}\`);`,
		(specifier: string) => `void require('${specifier}');`,
		(specifier: string) => `void module.require('${specifier}');`,
		(specifier: string) => `import value = require('${specifier}');`,
		(specifier: string) => `import type { Value } from '${specifier}';`,
		(specifier: string) => `export type { Value } from '${specifier}';`,
		(specifier: string) => `export type * from '${specifier}';`,
		(specifier: string) => `type Value = import('${specifier}').Value;`,
		(specifier: string) => `type Value = typeof import('${specifier}');`,
		(specifier: string) => `import { type Value } from '${specifier}';`,
		(specifier: string) => `export { type Value } from '${specifier}';`,
	];
	it("keeps successive virtual texts and empty sources distinct, including cache hits", () => {
		for (const name of ["fresh-control.ts", "fresh-control.tsx"]) {
			const file = join(server, name);
			const first = "import './fresh-runtime-control.js';";
			const second = "export type { Value } from './fresh-type-control.js';";
			expect(references(file, first)).toEqual([{ specifier: "./fresh-runtime-control.js", typeOnly: false }]);
			expect(references(file, second)).toEqual([{ specifier: "./fresh-type-control.js", typeOnly: true }]);
			expect(references(file, "")).toEqual([]);
			expect(references(file, first)).toEqual([{ specifier: "./fresh-runtime-control.js", typeOnly: false }]);
		}
	});
	// Native whole-tree setup crossed 5 s in the full gate; runtime and mutation deadlines stay fixed.
	it("admits only the exact W1 store, W5 worker-only builder and W6 worker collector importers in the real server tree", () => {
		const files = serverFiles();
		expect(files).toContain(collector);
		expect(unreviewed(files, disk)).toEqual([]);
	}, 15_000);
	it("accepts reviewed edges but rejects nested lookalikes, main cache and all alternate direct import forms", () => {
		for (const form of forms) {
			const modules: Record<string, string> = { "usage-accounting-collector.ts": "export const value = 1;" };
			for (const name of allowed) modules[name] = form("./usage-accounting-collector.js");
			modules["unreviewed.ts"] = form("./usage-accounting-collector.js");
			modules["usage-accounting-meter-cache.ts"] = form("./usage-accounting-collector.js");
			modules["nested/usage-accounting-worker.ts"] = form("../usage-accounting-collector.js");
			expect(
				unreviewed(
					Object.keys(modules).map((name) => join(server, name)),
					memoryHost(modules),
				),
			).toEqual(["nested/usage-accounting-worker.ts", "unreviewed.ts", "usage-accounting-meter-cache.ts"]);
		}
	});
	it("checks each real main-thread root and treats only an undelivered cache as explicitly empty", () => {
		const cache = join(server, "usage-accounting-meter-cache.ts"),
			present = disk.fileExists(cache);
		for (const root of roots.slice(0, 3)) expect(disk.fileExists(join(server, root)), root).toBe(true);
		const host: ImportHost = {
			fileExists: (file) => resolve(file) === cache || disk.fileExists(file),
			readFile: (file) => (!present && resolve(file) === cache ? "" : disk.readFile(file)),
		};
		cacheReferences(serverFiles(), host); // Also batch real sources when this test runs in isolation.
		expect(enginePaths(host, roots)).toEqual([]);
		expect(cacheImports(host)).toEqual([]);
	});
	it.each(roots)("rejects direct and transitive engine mutations (including type-only links) from %s", (root) => {
		for (const engine of engines)
			for (const form of forms) {
				const specifier = `./${engine.replace(/\.ts$/, ".js")}`;
				expect(
					enginePaths(memoryHost({ [root]: form(specifier), [engine]: "export const value = 1;" }), [root]),
				).toEqual([[root, engine]]);
				expect(
					enginePaths(
						memoryHost({
							[root]: form("./innocent-helper.js"),
							"innocent-helper.ts": form(specifier),
							[engine]: "export const value = 1;",
						}),
						[root],
					),
				).toEqual([[root, "innocent-helper.ts", engine]]);
			}
	});
	it("follows binary module resolution, directory indexes, absolute paths and configured aliases rather than regex text", () => {
		const host = memoryHost({
			"index.ts": "export * from './bridge';",
			"bridge/index.ts": "export type * from '@meter/usage-accounting-snapshot.js';",
			"usage-accounting-snapshot.ts": "export const value = 1;",
		});
		expect(enginePaths(host, ["index.ts"], { ...options, paths: { "@meter/*": [join(server, "*")] } })).toEqual([
			["index.ts", "bridge/index.ts", "usage-accounting-snapshot.ts"],
		]);
		const absolute = memoryHost({
			"index.ts": `import type { Value } from ${JSON.stringify(collector)};`,
			"usage-accounting-collector.ts": "export interface Value {}",
		});
		expect(enginePaths(absolute, ["index.ts"])).toEqual([["index.ts", "usage-accounting-collector.ts"]]);
		expect(() => enginePaths(memoryHost({ "index.ts": "import './missing-helper.js';" }), ["index.ts"])).toThrow(
			"unresolved local import",
		);
	});
	it("permits safe type-only DTO/cache graphs and harmless cycles without matching comments or string decoys", () => {
		const host = memoryHost({
			"index.ts": "export * from './roles-overview.js';",
			"roles-overview.ts": "export * from './usage-accounting-meter-cache.js'; import './safe-helper.js';",
			"protocol.ts": "import type { Snapshot } from './usage-accounting-meter-contract.js';",
			"usage-accounting-meter-cache.ts": "import type { Snapshot } from './usage-accounting-meter-contract.js';",
			"usage-accounting-meter-contract.ts": "export interface Snapshot {}",
			"safe-helper.ts":
				"import './roles-overview.js'; // import './usage-accounting-collector.js'\nconst decoy = \"require('./usage-accounting-snapshot.js')\";",
		});
		expect(enginePaths(host, roots)).toEqual([]);
		expect(cacheImports(host)).toEqual([]);
	});
	it("allowing worker/store/builder edges never blesses their transitive use by a main-thread root", () => {
		const modules: Record<string, string> = { "usage-accounting-collector.ts": "export const value = 1;" };
		for (const name of allowed) modules[name] = "import './usage-accounting-collector.js';";
		for (const root of roots) modules[root] = "";
		const host = memoryHost(modules);
		expect(
			unreviewed(
				Object.keys(modules).map((name) => join(server, name)),
				host,
			),
		).toEqual([]);
		expect(enginePaths(host, roots)).toEqual([]);
		for (const root of roots)
			expect(
				enginePaths(memoryHost({ ...modules, [root]: "export type * from './usage-accounting-worker.js';" }), [root]),
			).toContainEqual([root, "usage-accounting-worker.ts", "usage-accounting-collector.ts"]);
	});
	it("the tiny cache cannot import a runtime DTO, erased accounting engine, or unrelated helper", () => {
		for (const statement of [
			"import { Snapshot } from './usage-accounting-meter-contract.js';",
			"import { type Snapshot } from './usage-accounting-meter-contract.js';",
			"export * from './safe-helper.js';",
			"import type { Snapshot } from './usage-accounting-snapshot.js';",
		]) {
			const host = memoryHost({
				"usage-accounting-meter-cache.ts": statement,
				"usage-accounting-meter-contract.ts": "export interface Snapshot {}",
				"usage-accounting-snapshot.ts": "export interface Snapshot {}",
				"safe-helper.ts": "export const value = 1;",
			});
			expect(cacheImports(host)).toHaveLength(1);
		}
	});
});
