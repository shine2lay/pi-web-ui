import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	UsageAccountingCollector,
	COLLECTOR_LIMITS,
	type CollectorIO,
	type SourceBatch,
	type SourceInventory,
} from "../../server/usage-accounting-collector.js";
import {
	factId,
	observeUsage,
	parseAccountingInput,
	quoteListUsd,
	type AccountingInput,
	type UsageFact,
} from "../../server/usage-accounting-contract.js";
import {
	LEDGER_SOURCE_LIMITS,
	ledgerMeterFaultCounts,
	ledgerUtcMonths,
	readUsageLedger,
	type LedgerCursor,
	type LedgerNativeReceipt,
	type LedgerReadRequest,
	type LedgerReadResult,
	type LedgerSameCall,
	type LedgerSourceBatch,
} from "../../server/usage-accounting-ledger-source.js";
import { mapUsageMembership, projectMembershipConversation } from "../../server/usage-accounting-membership.js";
import type { MeterNativeCursor } from "../../server/usage-accounting-meter-contract.js";
import { PiSessionUsageReader } from "../../server/usage-accounting-pi-sessions.js";

const FROM = "2026-10-19T07:00:00.000Z",
	AT = "2026-10-20T12:00:00.000Z",
	THROUGH = "2026-10-21T00:00:00.000Z";
const dirs: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "ledger-source-"));
	dirs.push(root);
	const directory = join(root, "usage-ledger");
	mkdirSync(directory, { mode: 0o700 });
	return { root, directory, file: join(directory, "2026-10.jsonl") };
}
function record(changes: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		v: "usage-ledger/1",
		at: AT,
		occurredAt: AT,
		kind: "assistant",
		provider: "anthropic",
		model: "recorded-model",
		modelSource: "response",
		responseId: "response-1",
		stopReason: "stop",
		input: 10,
		output: 2,
		cacheRead: 3,
		cacheWrite: 4,
		totalTokens: 19,
		costTotal: 0.125,
		conversationId: "helper-1",
		sessionId: "session-1",
		sessionFile: null,
		persist: false,
		origin: "helper",
		parentConversationId: "parent-1",
		...changes,
	};
}
function write(file: string, records: unknown[]) {
	writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""), { mode: 0o600 });
}
function request(directory: string, changes: Partial<LedgerReadRequest> = {}): LedgerReadRequest {
	return {
		directory,
		month: "2026-10",
		from: FROM,
		through: THROUGH,
		observedAt: THROUGH,
		cursor: null,
		production: "enabled",
		...changes,
	};
}
function read(
	directory: string,
	changes: Partial<LedgerReadRequest> = {},
	index = new Map<string, LedgerNativeReceipt>(),
) {
	return readUsageLedger(request(directory, changes), { first: (key) => index.get(key) ?? null }, () => 0);
}
function codes(result: LedgerReadResult) {
	return result.faults.map((f) => f.code);
}
function commitIndex(result: LedgerReadResult, index = new Map<string, LedgerNativeReceipt>()) {
	for (const entry of result.nativeReceipts) index.set(entry.key, structuredClone(entry));
	return index;
}
function input(result: LedgerReadResult): AccountingInput {
	return {
		v: 1,
		...result.batch!.rows,
		coverage: [{ stream: result.source!.stream, from: FROM, through: THROUGH, observedAt: THROUGH, status: "partial" }],
		requiredStreams: [result.source!.stream],
	};
}
function subtotal(result: LedgerReadResult) {
	return observeUsage(input(result), { asOf: THROUGH, staleAfterMs: 60000, window: { from: FROM, through: THROUGH } });
}
function canonical(overrides: Partial<UsageFact> = {}): UsageFact {
	const identity = { producer: "pi" as const, incarnation: "transcript-session", attempt: "native-entry" };
	return {
		v: "usage-fact/1",
		id: factId(identity),
		identity,
		identityStatus: "verified",
		revision: 0,
		supersedes: null,
		occurredAt: AT,
		provider: "anthropic",
		model: "recorded-model",
		kind: "assistant",
		tokens: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4 },
		prices: [
			{ basis: "list-estimate", currency: "USD", amount: "0.125", status: "known", rateVersion: "pi-recorded-1" },
		],
		source: { stream: "transcript", event: "native-entry", observedAt: AT, coverage: "partial" },
		links: { task: null, session: "session-1", run: null },
		...overrides,
	};
}
function memoryIO() {
	const segments: string[] = [];
	let checkpoint: string | null = null;
	let fail = false;
	const io: CollectorIO = {
		read: async () => ({ segments: [...segments], checkpoint }),
		append: async (segment, expectedBytes, line) => {
			if (fail) throw new Error("synthetic-private-exception");
			expect(Buffer.byteLength(segments[segment - 1] ?? "")).toBe(expectedBytes);
			segments[segment - 1] = (segments[segment - 1] ?? "") + line;
		},
		sync: async () => {},
		checkpoint: async (text) => {
			checkpoint = text;
		},
	};
	return {
		io,
		fail: (v: boolean) => {
			fail = v;
		},
		segments,
	};
}
function inventory(result: LedgerReadResult): SourceInventory {
	return {
		v: "usage-inventory/1",
		evidenceRef: "fixture-native-inventory",
		observedAt: THROUGH,
		complete: false,
		sources: [result.source!],
	};
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("H-WIRE-2 numeric projection and conservative evidence", () => {
	it("keeps a fileless helper native attempt, recorded positive estimate and parent metadata, without funding", () => {
		const f = fixture();
		write(f.file, [record()]);
		const r = read(f.directory);
		expect(r.status).toBe("partial");
		expect(r.endOfFile).toBe(true);
		expect(r.batch?.status).toBe("partial");
		expect(r.batch?.rows.facts).toHaveLength(1);
		expect(r.batch?.rows.facts[0]).toMatchObject({
			identityStatus: "verified",
			tokens: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4 },
			prices: [{ amount: "0.125", rateVersion: "pi-recorded-1" }],
			source: { observedAt: AT, coverage: "partial" },
			links: { task: null, session: "session-1", run: null },
		});
		expect(r.observations[0]).toMatchObject({
			disposition: "original",
			tokens: { total: 19 },
			recordedPrice: { amount: "0.125", exactTokenQuote: false },
		});
		expect(r.conversations).toEqual([projectMembershipConversation(record())]);
		expect(codes(r)).toEqual(["production-unprovable", "skipped-writes-unobservable", "fileless-helper-membership"]);
		expect(r.batch?.rows).toMatchObject({ allocations: [], roots: [], policies: [], memberships: [], snapshots: [] });
		expect(parseAccountingInput(input(r)).ok).toBe(true);
		expect(subtotal(r)).toMatchObject({ dedupKnownListUsd: "0.125", usageCoverage: "partial" });
	});
	it("does not add persistent transcript overlap without a supported same-call witness", () => {
		const f = fixture();
		write(f.file, [record({ persist: true, sessionFile: "/sealed/session.jsonl", origin: "chat" })]);
		const r = read(f.directory);
		expect(r.batch!.rows.facts[0].identityStatus).toBe("unresolved");
		expect(codes(r)).toContain("overlap-unresolved");
		expect(subtotal(r)).toMatchObject({ dedupKnownListUsd: "0", unresolvedIdentities: 1 });
	});
	it.each(["stop", "error", "aborted"])(
		"retains only reported numeric evidence for finalized %s usage",
		(stopReason) => {
			const f = fixture();
			write(f.file, [record({ stopReason })]);
			expect(read(f.directory).batch?.rows.facts[0].prices[0].amount).toBe("0.125");
		},
	);
	it("leaves app calls unassigned, even with a parent and a native response", () => {
		const f = fixture();
		write(f.file, [record({ origin: "app", app: "goal-reviewer", parentConversationId: "real-parent" })]);
		const r = read(f.directory);
		expect(r.batch!.rows.facts[0].identityStatus).toBe("verified");
		expect(r.batch!.rows.facts[0].links.task).toBeNull();
		expect(r.conversations[0]).toMatchObject({ origin: "app", parentConversationId: "real-parent" });
		const mapped = mapUsageMembership(
			{
				sessions: [],
				registry: { status: "complete", bytesRead: 0, records: [] },
				conversations: { status: "partial", bytesRead: r.bytesRead, records: r.conversations },
				delegates: { status: "complete", bytesRead: 0, records: [] },
			},
			() => 0,
		);
		expect(mapped.memberships).toEqual([]);
		expect(mapped.parentHistory).toEqual([]);
	});
	it.each(["cache_warm", "compaction", "branch_summary"])(
		"does not turn %s aggregates into leaf charges even when an ID is planted",
		(kind) => {
			const f = fixture();
			write(f.file, [record({ kind, modelSource: "requested" })]);
			const r = read(f.directory);
			expect(r.batch!.rows.facts).toEqual([]);
			expect(r.nativeReceipts).toEqual([]);
			expect(r.observations[0].disposition).toBe("aggregate");
			expect(codes(r)).toEqual([
				"production-unprovable",
				"skipped-writes-unobservable",
				"actual-model-unknown",
				"fileless-helper-membership",
				"aggregate-not-attempt",
			]);
			expect(r.counters.aggregateRecords).toBe(1);
		},
	);
	it("never makes null response IDs into byte-offset charges, including repeated observations", () => {
		const f = fixture();
		write(f.file, [record({ responseId: null }), record({ responseId: null })]);
		const r = read(f.directory);
		expect(r.batch!.rows.facts).toEqual([]);
		expect(r.nativeReceipts).toEqual([]);
		expect(r.observations.map((o) => o.factId)).toEqual([null, null]);
		expect(r.counters.missingResponseIdentity).toBe(2);
		expect(codes(r)).toContain("response-identity-missing");
	});
	it("does not promote a requested/current model or positive price into actual-model evidence", () => {
		const f = fixture();
		write(f.file, [record({ modelSource: "requested" })]);
		const r = read(f.directory),
			fact = r.batch!.rows.facts[0];
		expect(fact).toMatchObject({
			provider: "unknown",
			model: "unknown",
			identityStatus: "unresolved",
			prices: [{ status: "unknown-model", amount: null, rateVersion: null }],
		});
		expect(r.observations[0].recordedPrice.amount).toBe("0.125");
		expect(r.counters.unknownActualModel).toBe(1);
		expect(subtotal(r).dedupKnownListUsd).toBe("0");
	});
	it.each([{ model: "unknown" }, { model: null }, { provider: "unknown" }, { provider: null }])(
		"retains unknown/null actual-model labels as uncertainty: %j",
		(labels) => {
			const f = fixture();
			write(f.file, [record(labels)]);
			const r = read(f.directory);
			expect(codes(r)).toContain("actual-model-unknown");
			expect(r.batch!.rows.facts[0]?.prices[0].amount ?? null).toBeNull();
			expect(r.counters.unknownActualModel).toBe(1);
		},
	);
	it.each(["input", "output", "cacheRead", "cacheWrite"] as const)(
		"treats the %s zero as missing presence, never exact/free",
		(key) => {
			const f = fixture();
			write(f.file, [record({ [key]: 0, totalTokens: 19 - Number(record()[key]) })]);
			const r = read(f.directory),
				fact = r.batch!.rows.facts[0];
			expect(fact.tokens[key]).toBeNull();
			expect(r.observations[0].tokens.total).toBeNull();
			expect(codes(r)).toContain("legacy-token-presence");
			expect(r.counters.legacyTokenPresence).toBe(1);
			expect(r.counters.totalUnknown).toBe(1);
			expect(fact.prices[0].amount).toBe("0.125");
			expect(quoteListUsd(fact.tokens, { input: "1", output: "1", cacheRead: "1", cacheWrite: "1" })).toBeNull();
		},
	);
	it("treats all-zero Pi classes/total/cost and mismatched totals as unknown", () => {
		const f = fixture();
		write(f.file, [
			record({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 }),
			record({ responseId: "response-2", totalTokens: 1 }),
		]);
		const r = read(f.directory);
		expect(r.observations.map((o) => o.tokens.total)).toEqual([null, null]);
		expect(r.batch!.rows.facts[0].prices[0]).toMatchObject({ status: "unpriced", amount: null });
		expect(r.counters).toMatchObject({
			zeroInput: 1,
			zeroOutput: 1,
			zeroCacheRead: 1,
			zeroCacheWrite: 1,
			legacyTokenPresence: 1,
			totalUnknown: 2,
		});
	});
	it.each([null, 1e-20, 1e18])(
		"keeps absent/unrepresentable cost %s unknown, not an exact zero or current-rate quote",
		(costTotal) => {
			const f = fixture();
			write(f.file, [record({ costTotal })]);
			expect(read(f.directory).batch!.rows.facts[0].prices[0].amount).toBeNull();
		},
	);
	it("rounds recorded positive decimals explicitly, not through floating arithmetic", () => {
		const f = fixture();
		write(f.file, [record({ costTotal: 0.1234567890125 }), record({ responseId: "r2", costTotal: 0.1234567890135 })]);
		const r = read(f.directory);
		expect(r.batch!.rows.facts.map((v) => v.prices[0].amount)).toEqual(["0.123456789012", "0.123456789014"]);
		expect(r.counters.roundedAmounts).toBe(2);
	});
});

describe("native identity, durable first observations and transcript aliases", () => {
	it("preserves the first observation across duplicates, crash/replay, new readers and UTC month rollover", () => {
		const f = fixture();
		const one = record();
		write(f.file, [
			one,
			{ ...one, at: "2026-10-20T12:01:00.000Z", conversationId: "copied-helper", sessionId: "copied-session" },
		]);
		const first = read(f.directory),
			replay = read(f.directory);
		expect(replay).toEqual(first);
		expect(first.batch!.rows.facts).toHaveLength(1);
		expect(first.observations.map((v) => v.disposition)).toEqual(["original", "duplicate"]);
		const index = commitIndex(first);
		appendFileSync(f.file, JSON.stringify({ ...one, at: "2026-10-20T12:02:00.000Z" }) + "\n");
		const resumed = read(f.directory, { cursor: first.cursor }, index);
		expect(resumed.batch!.rows.facts).toEqual([]);
		expect(resumed.nativeReceipts).toEqual([]);
		expect(index.values().next().value!.fact.source.observedAt).toBe(AT);
		write(join(f.directory, "2026-11.jsonl"), [{ ...one, at: "2026-11-01T00:01:00.000Z" }]);
		const november = read(f.directory, { month: "2026-11", observedAt: "2026-11-01T00:02:00.000Z" }, index);
		expect(november.batch!.rows.facts).toEqual([]);
		expect(november.observations[0].disposition).toBe("duplicate");
		expect(november.cursor!.incarnation).not.toBe(first.cursor!.incarnation);
	});
	it("does not change the durable first receipt or emit a second charge on conflicting response evidence", () => {
		const f = fixture();
		write(f.file, [record()]);
		const first = read(f.directory),
			index = commitIndex(first),
			kept = structuredClone([...index.values()]);
		appendFileSync(f.file, JSON.stringify(record({ at: "2026-10-20T12:01:00.000Z", output: 100 })) + "\n");
		const r = read(f.directory, { cursor: first.cursor }, index);
		expect(r.batch!.rows.facts).toEqual([]);
		expect(r.nativeReceipts).toEqual([]);
		expect(r.observations[0].disposition).toBe("conflict");
		expect(codes(r)).toContain("native-response-conflict");
		expect([...index.values()]).toEqual(kept);
	});
	it("requires a recovered first-response lookup, and never advances over an unavailable/failed index", () => {
		const f = fixture();
		write(f.file, [record()]);
		for (const first of [
			undefined,
			() => undefined,
			() => {
				throw new Error("synthetic-private-index-error");
			},
			() => ({ v: "bad" }),
		]) {
			const r = readUsageLedger(request(f.directory), { first }, () => 0);
			expect(codes(r)).toContain("index-unavailable");
			expect(r.cursor).toBeNull();
			expect(r.batch).toBeNull();
			expect(r.nativeReceipts).toEqual([]);
		}
	});
	it("uses only an injected native same-call map for aliasing and never discovers by timestamp/amount", () => {
		const f = fixture();
		write(f.file, [record({ persist: true, sessionFile: "/sealed/session.jsonl", origin: "chat" })]);
		const c = canonical();
		const witness: LedgerSameCall = {
			provider: "anthropic",
			responseId: "response-1",
			canonical: c,
			evidenceRef: "native-response-map/1",
		};
		const r = readUsageLedger(request(f.directory), { first: () => null, sameCall: () => witness }, () => 0);
		expect(r.batch!.rows.aliases).toEqual([
			{
				aliasFactId: r.batch!.rows.facts[0].id,
				canonicalFactId: c.id,
				provenance: "native-call-map/1",
				evidenceRef: "native-response-map/1",
			},
		]);
		expect(r.batch!.rows.facts[0].identityStatus).toBe("verified");
		expect(r.observations[0].disposition).toBe("alias");
		const merged = input(r);
		merged.facts.unshift(c);
		merged.requiredStreams.push(c.source.stream);
		expect(
			observeUsage(merged, { asOf: THROUGH, staleAfterMs: 60000, window: { from: FROM, through: THROUGH } })
				.dedupKnownListUsd,
		).toBe("0.125");
	});
	it.each(["id", "model", "time", "tokens", "price", "throw", "extra"])(
		"refuses an unsupported/inconsistent %s same-call witness",
		(mode) => {
			const f = fixture();
			write(f.file, [record({ persist: true, sessionFile: "/sealed/session.jsonl" })]);
			const witness = {
				provider: "anthropic",
				responseId: mode === "id" ? "other-response" : "response-1",
				canonical: canonical(
					mode === "model"
						? { model: "different" }
						: mode === "time"
							? { occurredAt: FROM }
							: mode === "tokens"
								? { tokens: { input: 11, output: 2, cacheRead: 3, cacheWrite: 4 } }
								: mode === "price"
									? {
											prices: [
												{
													basis: "list-estimate",
													currency: "USD",
													amount: "1",
													status: "known",
													rateVersion: "pi-recorded-1",
												},
											],
										}
									: {},
				),
				evidenceRef: "native-map",
				...(mode === "extra" ? { details: "synthetic-private-evidence" } : {}),
			};
			const r = readUsageLedger(
				request(f.directory),
				{
					first: () => null,
					sameCall: () => {
						if (mode === "throw") throw new Error("synthetic-private-exception");
						return witness;
					},
				},
				() => 0,
			);
			expect(r.batch!.rows.aliases).toEqual([]);
			expect(r.batch!.rows.facts[0].identityStatus).toBe("unresolved");
			expect(codes(r)).toContain("same-call-unverified");
		},
	);
	it("does not turn a rejected same-call witness into a second additive fileless charge", () => {
		const f = fixture();
		write(f.file, [record()]);
		const r = readUsageLedger(
			request(f.directory),
			{ first: () => null, sameCall: () => ({ provider: "wrong-provider" }) },
			() => 0,
		);
		expect(codes(r)).toContain("same-call-unverified");
		expect(r.batch!.rows.facts[0].identityStatus).toBe("unresolved");
		expect(subtotal(r).dedupKnownListUsd).toBe("0");
	});
	it("reconciles a later supported alias without changing the first native observation", () => {
		const f = fixture();
		write(f.file, [record({ persist: true, sessionFile: "/sealed/session.jsonl" })]);
		const first = read(f.directory),
			index = commitIndex(first),
			original = structuredClone(first.nativeReceipts[0].fact);
		appendFileSync(
			f.file,
			JSON.stringify(record({ at: "2026-10-20T12:01:00.000Z", persist: true, sessionFile: "/sealed/session.jsonl" })) +
				"\n",
		);
		const c = canonical();
		const later = readUsageLedger(
			request(f.directory, { cursor: first.cursor }),
			{
				first: (key) => index.get(key) ?? null,
				sameCall: (provider, responseId) => ({ provider, responseId, canonical: c, evidenceRef: "late-native-map" }),
			},
			() => 0,
		);
		expect(later.batch!.rows.facts).toEqual([]);
		expect(later.batch!.rows.aliases).toHaveLength(1);
		expect(later.nativeReceipts[0].fact).toEqual(original);
		expect(later.nativeReceipts[0].alias?.canonicalFactId).toBe(c.id);
	});
	it("deduplicates a real #304 synthetic response witness without importing a transcript into the adapter", async () => {
		const f = fixture(),
			session = join(f.root, "session.jsonl");
		write(session, [
			{ type: "session", version: 3, id: "transcript-session", timestamp: FROM },
			{
				type: "message",
				id: "native-entry",
				timestamp: AT,
				message: {
					role: "assistant",
					timestamp: AT,
					provider: "anthropic",
					model: "recorded-model",
					responseId: "response-1",
					usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 19, cost: { total: 0.125 } },
				},
			},
		]);
		const transcript = await new PiSessionUsageReader().read({
			file: session,
			producer: "pi",
			from: FROM,
			through: THROUGH,
			observedAt: THROUGH,
		});
		const c = transcript.batch!.rows.facts[0];
		expect(c.identityStatus).toBe("verified");
		write(f.file, [record({ origin: "chat", persist: true, sessionFile: session })]);
		const ledger = readUsageLedger(
			request(f.directory),
			{
				first: () => null,
				sameCall: (provider, responseId) => ({
					provider,
					responseId,
					canonical: c,
					evidenceRef: "fixture-native-response-map",
				}),
			},
			() => 0,
		);
		const combined = input(ledger);
		combined.facts.unshift(c);
		combined.requiredStreams.push(c.source.stream);
		expect(
			observeUsage(combined, { asOf: THROUGH, staleAfterMs: 60000, window: { from: FROM, through: THROUGH } }),
		).toMatchObject({ dedupKnownListUsd: "0.125", unresolvedIdentities: 0 });
	});
});

describe("bounded anchored monthly cursors, private files and privacy", () => {
	it("returns W0-assignable closed batches/cursors and keeps all immutable bounds", () => {
		const f = fixture();
		write(f.file, [record()]);
		const r = read(f.directory);
		const batch: SourceBatch = r.batch! as LedgerSourceBatch;
		const cursor: MeterNativeCursor = r.cursor!;
		expect(Object.keys(batch).sort()).toEqual(
			[
				"adapterRef",
				"from",
				"fromCursor",
				"incarnation",
				"observedAt",
				"reason",
				"rows",
				"status",
				"stream",
				"through",
				"toCursor",
				"v",
			].sort(),
		);
		expect(cursor.kind).toBe("file");
		expect(batch.toCursor.token.length).toBeLessThanOrEqual(256);
		expect(r.bytesRead).toBeLessThanOrEqual(262144);
		expect(LEDGER_SOURCE_LIMITS.batchBytes).toBe(COLLECTOR_LIMITS.batchBytes);
		expect(LEDGER_SOURCE_LIMITS.batchRows).toBe(COLLECTOR_LIMITS.batchRows);
		expect(LEDGER_SOURCE_LIMITS.workMs).toBe(100);
	});
	it("commits no speculative native state on collector append failure; replay stays exact", async () => {
		const f = fixture();
		write(f.file, [record()]);
		const r = read(f.directory),
			mem = memoryIO();
		const collector = await UsageAccountingCollector.open({
			inventory: inventory(r),
			verifier: { inventory: () => true, batch: () => true },
			io: mem.io,
			clock: () => 0,
		});
		mem.fail(true);
		expect((await collector.collect(r.source!.stream, JSON.stringify(r.batch), THROUGH)).status).toBe("unavailable");
		expect(read(f.directory)).toEqual(r);
		expect(mem.segments).toEqual([]);
	});
	it("passes unchanged #300 acceptance, duplicate replay and durable reopen without counting twice", async () => {
		const f = fixture();
		write(f.file, [record()]);
		const r = read(f.directory),
			mem = memoryIO(),
			inv = inventory(r),
			verifier = { inventory: () => true, batch: () => true };
		const c = await UsageAccountingCollector.open({ inventory: inv, verifier, io: mem.io, clock: () => 0 });
		expect(await c.collect(r.source!.stream, JSON.stringify(r.batch), THROUGH)).toMatchObject({
			status: "committed",
			cursor: r.batch!.toCursor,
		});
		expect((await c.collect(r.source!.stream, JSON.stringify(r.batch), THROUGH)).status).toBe("duplicate");
		await c.checkpoint();
		const reopened = await UsageAccountingCollector.open({ inventory: inv, verifier, io: mem.io, clock: () => 0 });
		expect(reopened.input(THROUGH)!.facts).toHaveLength(1);
		expect(reopened.input(THROUGH)!.facts[0].prices[0].amount).toBe("0.125");
		const index = commitIndex(r);
		expect(read(f.directory, { cursor: r.cursor }, index)).toMatchObject({
			batch: null,
			cursor: r.cursor,
			endOfFile: true,
		});
	});
	it("anchors only complete lines, retains a torn suffix, and resumes exactly after append", () => {
		const f = fixture();
		write(f.file, [record()]);
		const one = readFileSync(f.file),
			second = JSON.stringify(record({ responseId: "response-2" }));
		appendFileSync(f.file, second.slice(0, 80));
		const first = read(f.directory);
		expect(codes(first)).toContain("partial-last-line");
		expect(first.cursor!.byte).toBe(one.length);
		expect(first.batch!.rows.facts).toHaveLength(1);
		appendFileSync(f.file, second.slice(80) + "\n");
		const r = read(f.directory, { cursor: first.cursor }, commitIndex(first));
		expect(r.batch!.rows.facts).toHaveLength(1);
		expect(r.cursor!.line).toBe(2);
		expect(r.endOfFile).toBe(true);
	});
	it("rejects changed anchors, truncation, replacement and cross-month cursor reuse without reset", () => {
		const f = fixture();
		write(f.file, [record(), record({ responseId: "r2" })]);
		const r = read(f.directory),
			oldCursor = r.cursor;
		const original = readFileSync(f.file, "utf8");
		writeFileSync(f.file, original.replace('"r2"', '"r3"'));
		const changed = read(f.directory, { cursor: oldCursor });
		expect(changed.batch).toBeNull();
		expect(changed.cursor).toEqual(oldCursor);
		expect(codes(changed)).toContain("cursor-changed");
		truncateSync(f.file, 10);
		expect(codes(read(f.directory, { cursor: oldCursor }))).toContain("source-truncated");
		renameSync(f.file, `${f.file}.kept`);
		write(f.file, [record(), record({ responseId: "r2" })]);
		expect(codes(read(f.directory, { cursor: oldCursor }))).toContain("cursor-changed");
		write(join(f.directory, "2026-11.jsonl"), [record({ at: "2026-11-01T00:00:00.000Z" })]);
		expect(
			codes(read(f.directory, { month: "2026-11", cursor: oldCursor, observedAt: "2026-11-01T00:01:00.000Z" })),
		).toContain("cursor-changed");
	});
	it("does not accept an emptied file as ordinary EOF when there is a saved cursor", () => {
		const f = fixture();
		write(f.file, [record()]);
		const first = read(f.directory);
		truncateSync(f.file, 0);
		const r = read(f.directory, { cursor: first.cursor });
		expect(r).toMatchObject({ batch: null, cursor: first.cursor, endOfFile: false });
		expect(codes(r)).toContain("source-truncated");
	});
	it("rechecks pinned files and both anchors even when a torn prefix or read limit stops parsing", () => {
		for (const suffix of ["torn", "bounded"] as const) {
			const f = fixture();
			write(
				f.file,
				suffix === "torn"
					? [record()]
					: Array.from({ length: 70 }, (_, n) => record({ responseId: `r${n}`, ignored: "x".repeat(4000) })),
			);
			if (suffix === "torn") appendFileSync(f.file, "unfinished");
			let mutated = false;
			const r = readUsageLedger(
				request(f.directory),
				{
					first: () => {
						if (!mutated) {
							mutated = true;
							const text = readFileSync(f.file, "utf8");
							writeFileSync(f.file, text.replace("0.125", "0.250"));
						}
						return null;
					},
				},
				() => 0,
			);
			expect(r.batch).toBeNull();
			expect(r.cursor).toBeNull();
			expect(r.nativeReceipts).toEqual([]);
			expect(codes(r)).toContain("cursor-changed");
			expect(r.bytesRead).toBeLessThanOrEqual(262144);
		}
	});
	it("rejects mid-read replacement and directory permission loss before emitting any proposals", () => {
		for (const mutation of ["replace", "permissions"] as const) {
			const f = fixture();
			write(f.file, [record()]);
			const r = readUsageLedger(
				request(f.directory),
				{
					first: () => {
						if (mutation === "replace") {
							renameSync(f.file, `${f.file}.kept`);
							write(f.file, [record()]);
						} else chmodSync(f.directory, 0o755);
						return null;
					},
				},
				() => 0,
			);
			expect(r.batch).toBeNull();
			expect(r.cursor).toBeNull();
			expect(codes(r)).toContain("source-changed");
		}
	});
	it("refuses malformed cursor geometry and retains the prior cursor on disabled/unproved production", () => {
		const f = fixture();
		write(f.file, [record()]);
		const r = read(f.directory),
			c = r.cursor!;
		for (const bad of [
			{ ...c, line: c.line + 1 },
			{ ...c, anchor: { ...c.anchor, start: c.byte } },
			{ ...c, extra: true },
		])
			expect(codes(read(f.directory, { cursor: bad as LedgerCursor }))).toContain("cursor-invalid");
		for (const production of ["disabled", "unknown"] as const) {
			const off = read(f.directory, { cursor: c, production });
			expect(off).toMatchObject({ cursor: c, batch: null, bytesRead: 0, status: "partial" });
			expect(codes(off)).toContain(production === "disabled" ? "producer-disabled" : "producer-state-unknown");
		}
	});
	it("uses UTC observation-month targets only and never automatically opens the next month", () => {
		expect(ledgerUtcMonths("2026-12-31T23:00:00.000Z", "2027-01-01T01:00:00.000Z")).toEqual(["2026-12", "2027-01"]);
		expect(ledgerUtcMonths(FROM, THROUGH)).toEqual(["2026-10"]);
		expect(() => ledgerUtcMonths(FROM, "2027-01-01T00:00:00.000Z")).toThrow("ledger-window");
		const f = fixture();
		write(f.file, [record({ at: "2026-11-01T00:00:00.000Z" })]);
		expect(codes(read(f.directory))).toContain("month-mismatch");
	});
	it("stops before occurrence-window/future rows without advancing them", () => {
		const f = fixture();
		write(f.file, [record(), record({ responseId: "r2", occurredAt: "2026-10-18T00:00:00.000Z" })]);
		const r = read(f.directory);
		expect(r.cursor!.line).toBe(1);
		expect(codes(r)).toContain("window-mismatch");
		write(f.file, [record({ at: "2026-10-22T00:00:00.000Z" })]);
		const future = read(f.directory);
		expect(future.cursor).toBeNull();
		expect(codes(future)).toContain("future-observation");
	});
	it("handles empty/missing/permission/unsafe files with fixed faults, never optimistic coverage", () => {
		const f = fixture();
		expect(codes(read(f.directory))).toContain("source-unreadable");
		write(f.file, []);
		expect(read(f.directory)).toMatchObject({ batch: null, endOfFile: true, status: "partial" });
		write(f.file, [record()]);
		chmodSync(f.file, 0o000);
		expect(codes(read(f.directory))).toContain("source-unreadable");
		chmodSync(f.file, 0o600);
		chmodSync(f.directory, 0o755);
		expect(codes(read(f.directory))).toContain("source-unsafe");
		chmodSync(f.directory, 0o700);
		linkSync(f.file, `${f.file}.linked`);
		expect(codes(read(f.directory))).toContain("source-unsafe");
		rmSync(`${f.file}.linked`);
		renameSync(f.file, `${f.file}.kept`);
		symlinkSync(`${f.file}.kept`, f.file);
		expect(codes(read(f.directory))).toContain("source-unreadable");
	});
	it("rejects a symlink directory and explicit path traversal instead of discovering private sources", () => {
		const f = fixture(),
			other = join(f.root, "other");
		mkdirSync(other);
		const directory = join(other, "usage-ledger");
		symlinkSync(f.directory, directory);
		expect(codes(read(directory))).toContain("source-unsafe");
		expect(() => read(f.directory, { month: "../2026-10" })).toThrow("ledger-request");
		expect(() => read("relative/usage-ledger")).toThrow("ledger-request");
	});
	it("bounds records/bytes/work and retains only complete-prefix cursors", () => {
		const f = fixture();
		write(
			f.file,
			Array.from({ length: 260 }, (_, n) => record({ responseId: `r${n}` })),
		);
		const r = read(f.directory);
		expect(r.bytesRead).toBeLessThanOrEqual(262144);
		expect(r.counters.records).toBe(128);
		expect(r.cursor!.line).toBe(128);
		expect(codes(r)).toContain("record-limit");
		write(
			f.file,
			Array.from({ length: 70 }, (_, n) => record({ responseId: `r${n}`, ignored: "x".repeat(4000) })),
		);
		const bounded = read(f.directory);
		expect(bounded.bytesRead).toBeLessThanOrEqual(262144);
		expect(codes(bounded)).toContain("read-limit");
		expect(bounded.batch!.rows.facts.length).toBeGreaterThan(1);
		expect(bounded.cursor!.byte).toBeLessThan(readFileSync(f.file).length);
		let tick = -50;
		const work = readUsageLedger(request(f.directory), { first: () => null }, () => (tick += 50));
		expect(codes(work)).toContain("work-limit");
		expect(work.cursor?.line ?? 0).toBeLessThanOrEqual(1);
	});
	it("rejects overlong, invalid UTF-8/JSON and invalid numeric records with bounded fixed faults", () => {
		const f = fixture();
		writeFileSync(f.file, "x".repeat(17000) + "\n", { mode: 0o600 });
		const long = read(f.directory);
		expect(codes(long)).toContain("line-limit");
		expect(long.cursor).toBeNull();
		writeFileSync(f.file, Buffer.from([0xff, 0x0a]));
		const utf = read(f.directory);
		expect(codes(utf)).toContain("invalid-json");
		expect(utf.batch!.rows.facts).toEqual([]);
		write(f.file, [record({ input: 1.5 }), record({ output: -1 }), record({ responseId: {} })]);
		const invalid = read(f.directory);
		expect(invalid.faults.filter((v) => v.code === "invalid-record")).toHaveLength(3);
		expect(invalid.batch!.rows.facts).toEqual([]);
	});
	it("maps faults into W0's closed code/source buckets, not affected-row tallies", () => {
		const f = fixture();
		write(f.file, [record({ input: 0 }), record({ responseId: null, modelSource: "requested" })]);
		const r = read(f.directory),
			faults = ledgerMeterFaultCounts(r.faults);
		expect(faults).toEqual([
			{ code: "invalid-subject-binding", count: 1 },
			{ code: "source-coverage", count: 1 },
			{ code: "unpriced", count: 1 },
			{ code: "unresolved-identity", count: 1 },
		]);
		expect(ledgerMeterFaultCounts([...r.faults, ...r.faults])).toEqual(faults);
		expect(r.counters.records).toBe(2);
	});
	it("projects planted content/extra fields out before output/indexing, preserving only byte anchors", () => {
		const f = fixture(),
			marker = "synthetic-private-payload-must-not-escape";
		write(f.file, [
			record({ content: marker, prompt: marker, toolResult: { marker }, details: marker, error: marker, app: marker }),
		]);
		const r = read(f.directory);
		expect(JSON.stringify(r)).not.toContain(marker);
		expect(r.batch!.rows.facts).toHaveLength(1);
		expect(Object.keys(r.conversations[0]).sort()).toEqual(
			[
				"v",
				"conversationId",
				"sessionId",
				"sessionFile",
				"persist",
				"origin",
				"parentConversationId",
				"at",
				"occurredAt",
			].sort(),
		);
		expect(Object.values(r.counters).every((n) => Number.isSafeInteger(n) && n >= 0)).toBe(true);
		const anchor = r.cursor!.anchor,
			bytes = readFileSync(f.file).subarray(anchor.start, anchor.start + anchor.bytes);
		expect(anchor.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
	});
});
