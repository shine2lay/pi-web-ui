import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	COLLECTOR_LIMITS,
	UsageAccountingCollector,
	type CollectorCheckpoint,
	type CollectorIO,
	type CollectorVerifier,
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
		const dir = new URL("../../server/", import.meta.url);
		for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "usage-accounting-collector.ts")) {
			expect(readFileSync(new URL(file, dir), "utf8"), file).not.toMatch(
				/(?:from\s*|import\s*\()["']\.\/usage-accounting-collector(?:\.js)?["']/,
			);
		}
	});
});
