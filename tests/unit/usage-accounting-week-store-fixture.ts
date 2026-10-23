// Ops #422 (B2): the worker side of tests/unit/usage-accounting-week-store.test.ts. The test bundles this file with
// esbuild in memory (nothing is written to the checkout) and runs one named case per Worker with W0's resource
// limits, so the store runs as it will live: in a worker thread, on a real filesystem, with its real lock. Every
// record, receipt, cursor and folder here is synthetic and temporary; no chat file is read. A "crash" is a fault that
// throws at one named point (or writes only part of the bytes), then the writer is closed and a new one opened, as
// after a restart: the W1 store test's pattern.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { addUsd, factId, type UsageFact } from "../../server/usage-accounting-contract.js";
import {
	readUsageLedger,
	type LedgerNativeReceipt,
	type LedgerReadRequest,
	type LedgerReadResult,
	type LedgerSameCall,
} from "../../server/usage-accounting-ledger-source.js";
import {
	USAGE_WEEK_DIRECTORY,
	UsageWeekStore,
	UsageWeekStoreError,
	type UsageWeekCoverage,
	type UsageWeekCursors,
	type UsageWeekDisposition,
	type UsageWeekPoint,
	type UsageWeekReceipt,
	type UsageWeekRecord,
	type UsageWeekStoreOptions,
	type UsageWeekTotals,
} from "../../server/usage-accounting-week-store.js";

interface CaseData {
	caseName: string;
	dir: string;
	lease: SharedArrayBuffer;
	extra: Record<string, unknown>;
}
const data = workerData as CaseData;
const variant = String(data.extra.variant ?? "");
const W = "2026-10-19",
	NEXT = "2026-10-26";
/** Mid-week, and ten minutes after the week's end (Monday 2026-10-26 00:00 PDT = 07:00Z), when B5 seals. */
const DURING = Date.parse("2026-10-22T12:00:00.000Z"),
	AFTER = Date.parse("2026-10-26T07:10:00.000Z");
const COMPLETE: UsageWeekCoverage = { state: "complete", gaps: [] };
const PARTIAL: UsageWeekCoverage = { state: "partial", gaps: [{ code: "line-limit", count: 1 }] };
let clock = DURING;
const stores = new Set<UsageWeekStore>();

function open(o: Partial<UsageWeekStoreOptions> = {}): UsageWeekStore {
	const s = UsageWeekStore.open({ dataDir: data.dir, lease: data.lease, now: () => clock, ...o });
	stores.add(s);
	return s;
}
function close(s: UsageWeekStore): void {
	s.close();
	stores.delete(s);
}
/** A restart: the writer closes (lease and lock released), then a new one opens. */
function reopen(s: UsageWeekStore, o: Partial<UsageWeekStoreOptions> = {}): UsageWeekStore {
	close(s);
	return open(o);
}
const root = () => join(data.dir, USAGE_WEEK_DIRECTORY);
const file = (n: string) => join(root(), n);
const name = (kind: "log" | "receipts" | "checkpoint" | "sealed" | "adjust", week = W) => `week-${week}.${kind}`;
const bytes = (n: string) => readFileSync(file(n));
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const header = (week = W, kind = "log") => `{"v":"usage-week-log/1","week":"${week}","kind":"${kind}"}\n`;
/** The record's line as the store writes it: record() builds its fields in the store's fixed order. */
const line = (r: UsageWeekRecord) => `${JSON.stringify(r)}\n`;
const lines = (rs: UsageWeekRecord[]) => rs.reduce((n, r) => n + line(r).length, 0);
function codeOf(fn: () => unknown): string {
	try {
		fn();
	} catch (e) {
		if (e instanceof UsageWeekStoreError) return e.code;
		throw e;
	}
	return "no-error";
}
/** Once armed, the fault stops the store at `point`: it throws, or at a *-write point writes only `short` bytes. */
function crashAt(point: UsageWeekPoint, short?: number) {
	let armed = false;
	return {
		fault(p: UsageWeekPoint): number | void {
			if (!armed || p !== point) return;
			armed = false;
			if (short !== undefined) return short;
			throw new Error(`fixture-crash-at-${p}`);
		},
		arm() {
			armed = true;
		},
	};
}

const QUEUE = sha("fixture-queue:ops");
/** Synthetic attempt i of week W: two subjects, some amounts, token counts and rates unknown. */
function record(i: number, over: Partial<UsageWeekRecord> = {}): UsageWeekRecord {
	return {
		k: sha(`fixture-attempt:${i}`),
		d: "original",
		at: new Date(Date.parse("2026-10-20T10:00:00.000Z") + i * 1000).toISOString(),
		src: sha(`fixture-source:${i % 7}`).slice(0, 16),
		off: i * 977,
		len: 400 + (i % 7),
		sub:
			i % 2 === 0
				? {
						role: "ops",
						project: "automatic-cost-accounting",
						initiative: null,
						task: { q: QUEUE, n: 422, at: "2026-10-22T16:00:00.000Z" },
					}
				: { role: "design", project: null, initiative: "design-in-temper", task: null },
		usd: i % 5 === 4 ? null : `0.${String((i * 7919 + 13) % 1_000_000_000_000).padStart(12, "0")}`,
		tok: [1000 + i, 200 + (i % 50), 30_000, i % 3 === 0 ? null : 50],
		rate: i % 11 === 10 ? null : "anthropic-list/2026-10",
		...over,
	};
}
/** A gap: skipped bytes of a source file, amount unknown. */
const gap = (i: number) => record(i, { d: "gap", len: 5000 + i, usd: null, tok: [null, null, null, null], rate: null });
/** What the store should total: counts by disposition, amounts and tokens from the originals only. */
function totals(records: UsageWeekRecord[]): UsageWeekTotals {
	const count: Record<UsageWeekDisposition, number> = { original: 0, alias: 0, unverified: 0, unresolved: 0, gap: 0 };
	const tok: [number, number, number, number] = [0, 0, 0, 0],
		tokUnknown: [number, number, number, number] = [0, 0, 0, 0],
		known: string[] = [];
	let usdUnknown = 0;
	for (const r of records) {
		count[r.d]++;
		if (r.d !== "original") continue;
		if (r.usd === null) usdUnknown++;
		else known.push(r.usd);
		for (let i = 0; i < 4; i++) {
			const t = r.tok[i];
			if (t === null) tokUnknown[i]++;
			else tok[i] += t;
		}
	}
	return { count, usd: addUsd(known), usdUnknown, tok, tokUnknown };
}
/** #304 file cursors (pi1 token shape) for two chat files, and a W2 ledger cursor, at reading step n. */
function cursors(n: number): UsageWeekCursors {
	return {
		files: {
			[sha("fixture-source:0").slice(0, 16)]: {
				cursor: {
					ordinal: n,
					token: `pi1:${n * 400}:${n * 400 - 400}:400:${sha(`fixture-line:${n}`)}:${sha("fixture-h")}`,
				},
				size: n * 400,
				mtimeMs: 1_792_700_000_000 + n,
			},
			[sha("fixture-source:1").slice(0, 16)]: { cursor: null, size: 0, mtimeMs: 1_792_700_000_000 },
		},
		ledger: {
			kind: "file",
			stream: "fixture-ledger",
			incarnation: "fixture-ledger-incarnation",
			ordinal: n,
			byte: 100 + n * 50,
			line: n,
			headerSha256: sha("fixture-ledger-header"),
			anchor: { start: 50 + n * 50, bytes: 50, sha256: sha(`fixture-ledger-line:${n}`) },
		},
	};
}

// Receipts: the W2 test's canonical session fact (tests/unit/usage-accounting-ledger-source.test.ts), synthetic.
const LEDGER_FROM = "2026-10-19T07:00:00.000Z",
	LEDGER_AT = "2026-10-20T12:00:00.000Z",
	LEDGER_THROUGH = "2026-10-21T00:00:00.000Z";
function fact(): UsageFact {
	const identity = { producer: "pi" as const, incarnation: "transcript-session", attempt: "native-entry" };
	return {
		v: "usage-fact/1",
		id: factId(identity),
		identity,
		identityStatus: "verified",
		revision: 0,
		supersedes: null,
		occurredAt: LEDGER_AT,
		provider: "anthropic",
		model: "recorded-model",
		kind: "assistant",
		tokens: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4 },
		prices: [
			{ basis: "list-estimate", currency: "USD", amount: "0.125", status: "known", rateVersion: "pi-recorded-1" },
		],
		source: { stream: "transcript", event: "native-entry", observedAt: LEDGER_AT, coverage: "partial" },
		links: { task: null, session: "session-1", run: null },
	};
}
const witness = (responseId: string): LedgerSameCall => ({
	provider: "anthropic",
	responseId,
	canonical: fact(),
	evidenceRef: "native-response-map/1",
});
const sameCallKey = (responseId: string) => sha(JSON.stringify(["anthropic", responseId]));
/** A same-call receipt under W2's key for [provider, responseId]. */
const sameCall = (responseId: string): UsageWeekReceipt => ({
	kind: "same-call",
	k: sameCallKey(responseId),
	r: witness(responseId),
});
const native = (r: LedgerNativeReceipt): UsageWeekReceipt => ({ kind: "ledger-native", k: r.key, r });
/** W2's native receipt for a call at `at`, built as usage-accounting-ledger-source.ts builds one, with no alias. */
function nativeAt(responseId: string, at: string): UsageWeekReceipt {
	const key = sameCallKey(responseId),
		identity = {
			producer: "pi" as const,
			incarnation: `ledger-response:${sha("anthropic")}`,
			attempt: `response:${sha(responseId)}`,
		};
	return native({
		v: "usage-ledger-native/1",
		key,
		numericSha256: sha(`fixture-numbers:${responseId}`),
		fact: {
			...fact(),
			id: factId(identity),
			identity,
			identityStatus: "unresolved",
			occurredAt: at,
			source: { stream: "fixture-ledger", event: `response:${key}`, observedAt: at, coverage: "partial" },
		},
		alias: null,
	});
}
/** A same-call receipt whose session original happened at `at`. */
const sameCallAt = (responseId: string, at: string): UsageWeekReceipt => ({
	kind: "same-call",
	k: sameCallKey(responseId),
	r: { ...witness(responseId), canonical: { ...fact(), occurredAt: at, source: { ...fact().source, observedAt: at } } },
});
/**
 * Writes a receipt line straight into the week's receipts file, as damage or an older store could leave one, and
 * re-signs the checkpoint over it: only the return path's own check stands between that line and W2.
 */
function plantReceipt(x: { kind: string; k: string; r: unknown }): void {
	appendFileSync(file(name("receipts")), `{"k":"${x.k}","kind":"${x.kind}","r":${canonical(x.r)}}\n`);
	const receipts = bytes(name("receipts"));
	resign(name("checkpoint"), (c) => {
		c.receipts = {
			length: receipts.length,
			records: receipts.toString("latin1").split("\n").length - 2,
			sha256: sha(receipts),
		};
	});
}
/**
 * A synthetic private ledger of two lines (a helper call, and a chat call whose session original is known only
 * through a same-call witness, response-1) and W2's request for it.
 */
function syntheticLedger(): LedgerReadRequest {
	const directory = join(data.dir, "usage-ledger");
	mkdirSync(directory, { mode: 0o700 });
	const ledger = (changes: Record<string, unknown>) => ({
		v: "usage-ledger/1",
		at: LEDGER_AT,
		occurredAt: LEDGER_AT,
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
	});
	const rows = [
		ledger({ responseId: "response-native" }),
		ledger({ responseId: "response-1", persist: true, sessionFile: "/sealed/session.jsonl", origin: "chat" }),
	];
	writeFileSync(join(directory, "2026-10.jsonl"), rows.map((r) => `${JSON.stringify(r)}\n`).join(""), {
		mode: 0o600,
	});
	return {
		directory,
		month: "2026-10",
		from: LEDGER_FROM,
		through: LEDGER_THROUGH,
		observedAt: LEDGER_THROUGH,
		cursor: null,
		production: "enabled",
	};
}

/** A reload with every record handed over, as B3 will do: the log's and the adjustments, in file order. */
function loadAll(s: UsageWeekStore, week = W) {
	const records: UsageWeekRecord[] = [],
		adjustments: UsageWeekRecord[] = [];
	const load = s.reload(week, (r, from) => (from === "log" ? records : adjustments).push(r));
	if (load.state === "open") assert.equal(load.records, records.length);
	if (load.state === "sealed") assert.equal(load.adjustments, adjustments.length);
	return { load, records, adjustments };
}
const dropped = (load: ReturnType<UsageWeekStore["reload"]>) => {
	assert(load.state === "open" || load.state === "sealed", load.state);
	return load.dropped;
};
/** A fresh week with `count` records (and receipts) and a checkpoint over them. */
function seed(s: UsageWeekStore, count: number, receipts: UsageWeekReceipt[] = []): UsageWeekRecord[] {
	const records = Array.from({ length: count }, (_, i) => record(i));
	assert.equal(s.reload(W).state, "empty");
	assert.equal(s.append(W, records, receipts).appended, count);
	assert.equal(s.checkpoint(W, cursors(1)).log.records, count);
	return records;
}
function modes(): { root: number; files: Record<string, number> } {
	const files: Record<string, number> = {};
	for (const entry of readdirSync(root())) {
		const st = lstatSync(file(entry));
		assert(st.isFile(), entry);
		files[entry] = st.mode & 0o777;
	}
	return { root: lstatSync(root()).mode & 0o777, files };
}
function canonical(raw: unknown): string {
	if (Array.isArray(raw)) return `[${raw.map(canonical).join(",")}]`;
	if (raw !== null && typeof raw === "object")
		return `{${Object.keys(raw)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical((raw as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	return JSON.stringify(raw) ?? "null";
}
/** Rewrites a self-checked file's first line with a changed body and a matching sha256, keeping what follows. */
function resign(n: string, change: (body: Record<string, unknown>) => void): void {
	const text = bytes(n).toString("utf8"),
		nl = text.indexOf("\n");
	const body = JSON.parse(text.slice(0, nl)) as Record<string, unknown>;
	delete body.sha256;
	change(body);
	writeFileSync(file(n), `${canonical({ ...body, sha256: sha(canonical(body)) })}${text.slice(nl)}`);
}
function edit(n: string, from: string, to: string): void {
	const text = bytes(n).toString("latin1");
	assert(text.includes(from), `${n} holds ${from}`);
	writeFileSync(file(n), text.replace(from, to), "latin1");
}
/** Same-length change inside record 1's line (off 977 -> 978): the log still parses, but its sha256 changes. */
const flipRecord = () => edit(name("log"), `"off":977,`, `"off":978,`);

function largeRecord(i: number, base: number): UsageWeekRecord {
	return record(i, { at: new Date(base + i * 1000).toISOString() });
}

const cases: Record<string, () => unknown> = {
	lifecycle() {
		const s = open();
		assert.deepEqual(s.status(), { state: "ready", code: null });
		assert.deepEqual(s.reload(W), { state: "empty", week: W });
		assert.deepEqual(s.listWeeks().weeks, [], "a reload writes nothing");
		const records = [0, 1, 2, 3].map((i) => record(i));
		const appended = s.append(W, records, [sameCall("response-a")]);
		const log = bytes(name("log"));
		assert.equal(log.toString("latin1"), header() + records.map(line).join(""), "numbers, digests and ids only");
		assert.deepEqual(appended, {
			appended: 4,
			duplicates: 0,
			receipts: 1,
			receiptDuplicates: 0,
			records: 4,
			length: log.length,
		});
		const inodes = () => [lstatSync(file(name("log"))).ino, lstatSync(file(name("receipts"))).ino];
		const before = inodes();
		const cp = s.checkpoint(W, cursors(1));
		assert.deepEqual(cp.log, { length: log.length, records: 4, sha256: sha(log) });
		assert.deepEqual(cp.receipts, {
			length: bytes(name("receipts")).length,
			records: 1,
			sha256: sha(bytes(name("receipts"))),
		});
		assert.deepEqual({ files: cp.files, ledger: cp.ledger }, cursors(1));
		assert.equal(cp.adjust, null);
		assert.equal(s.append(W, [record(4)], [sameCall("response-b"), sameCall("response-a")]).receiptDuplicates, 1);
		const kept = s.checkpoint(W);
		assert.deepEqual(inodes(), before, "logs grow in place (O_APPEND), never rewritten (Architecture M3)");
		assert.deepEqual({ files: kept.files, ledger: kept.ledger }, cursors(1), "omitted cursors keep the last ones");
		assert.equal(kept.log.records, 5);
		assert.deepEqual(s.listWeeks(), {
			weeks: [{ week: W, log: true, receipts: true, checkpoint: true, sealed: false, adjust: false }],
			scratch: 0,
			quarantined: 0,
			other: 0,
		});
		const seen = modes();
		const again = reopen(s);
		assert.equal(Atomics.load(new Int32Array(data.lease), 0), 1);
		const { load, records: reloaded } = loadAll(again);
		assert(load.state === "open");
		assert.deepEqual(reloaded, [...records, record(4)]);
		assert.deepEqual(load.checkpoint, kept);
		assert.equal(load.receipts, 2);
		assert.deepEqual(load.dropped, { records: 0, receipts: 0 });
		assert.deepEqual(again.receipt(W, "same-call", sameCallKey("response-b")), witness("response-b"));
		assert.equal(again.receipt(W, "same-call", sameCallKey("response-c")), null, "proven absent");
		assert.equal(again.receipt(W, "ledger-native", sameCallKey("response-b")), null, "kinds are kept apart");
		close(again);
		assert.equal(Atomics.load(new Int32Array(data.lease), 0), 0, "close releases the lifetime lease");
		assert.equal(
			codeOf(() => again.reload(W)),
			"closed",
		);
		return seen;
	},

	ownership() {
		const writer = open();
		assert.equal(writer.status().state, "ready");
		const sameLease = open();
		const otherLease = open({ lease: new SharedArrayBuffer(4) });
		for (const waiting of [sameLease, otherLease]) {
			assert.deepEqual(waiting.status(), { state: "waiting-for-previous-writer", code: "waiting-for-previous-writer" });
			assert.equal(
				codeOf(() => waiting.reload(W)),
				"waiting-for-previous-writer",
			);
			close(waiting);
		}
		assert.equal(Atomics.load(new Int32Array(data.lease), 0), 1, "a waiting store never releases the writer's lease");
		assert.deepEqual(writer.status(), { state: "ready", code: null }, "nor its lock");
		const badLease = open({ lease: new SharedArrayBuffer(8) });
		assert.deepEqual(badLease.status(), { state: "unavailable", code: "unsafe-path" });
		close(badLease);
		seed(writer, 1);
		const next = reopen(writer);
		assert.deepEqual(next.status(), { state: "ready", code: null });
		assert.equal(next.reload(W).state, "open");
		return "ok";
	},

	/** A torn write past the checkpoint: the reload cuts everything after it, whole lines included (M4). */
	torn() {
		if (variant === "zero-fill") {
			let s = open();
			seed(s, 2);
			const committed = bytes(name("log"));
			close(s);
			appendFileSync(file(name("log")), Buffer.alloc(4096));
			s = open();
			const { load, records: reloaded } = loadAll(s);
			assert.deepEqual(bytes(name("log")), committed, "only what came after the checkpoint was cut");
			return { kept: reloaded.length, wholeLinesDropped: 0, tornBytes: dropped(load).records };
		}
		const [r0, r1, r2, r3] = [0, 1, 2, 3].map((i) => record(i)),
			half = variant === "one-and-a-half";
		const short = half ? line(r2).length + 50 : 100;
		const crash = crashAt("log-write", short);
		let s = open({ fault: crash.fault });
		assert.equal(s.reload(W).state, "empty");
		s.append(W, [r0, r1]);
		if (variant !== "no-checkpoint") s.checkpoint(W, cursors(1));
		const written = bytes(name("log")).length,
			committed = variant === "no-checkpoint" ? Buffer.from(header()) : bytes(name("log"));
		crash.arm();
		assert.equal(
			codeOf(() => s.append(W, [r2, r3])),
			"io-failure",
		);
		assert.deepEqual(s.status(), { state: "unavailable", code: "io-failure" });
		assert.equal(bytes(name("log")).length, written + short, "the torn bytes are on disk");
		s = reopen(s);
		const { load, records: reloaded } = loadAll(s);
		assert(load.state === "open");
		assert.deepEqual(reloaded, variant === "no-checkpoint" ? [] : [r0, r1]);
		assert.deepEqual(bytes(name("log")), committed, "cut back to the checkpoint and synced before any append");
		const wholeLines = variant === "no-checkpoint" ? [r0, r1] : half ? [r2] : [];
		assert.equal(dropped(load).records, written + short - committed.length);
		const again = s.append(W, [r0, r1, r2, r3]);
		assert.deepEqual([again.appended + again.duplicates, again.records], [4, 4], "the re-read appends each once");
		assert.equal(s.checkpoint(W, cursors(2)).log.records, 4);
		return {
			kept: reloaded.length,
			wholeLinesDropped: wholeLines.length,
			tornBytes: dropped(load).records - (variant === "no-checkpoint" ? lines([r0, r1]) : lines(wholeLines)),
		};
	},

	/**
	 * A crash anywhere between a batch's log append and its checkpoint: the reload keeps exactly the last checkpoint's
	 * records and receipts, and the re-read from its cursors brings the week to the same totals as a run with no crash.
	 */
	crashCheckpoint() {
		const point = variant as UsageWeekPoint,
			crash = crashAt(point);
		let s = open({ fault: crash.fault });
		seed(s, 2);
		const first = s.checkpoint(W, cursors(1));
		const batch = [record(2, { d: "unverified" }), gap(3)],
			all = [record(0), record(1), ...batch],
			receipt = sameCall("response-b");
		if (point.startsWith("checkpoint") || point === "after-checkpoint-rename") {
			assert.equal(s.append(W, batch, [receipt]).appended, 2);
			crash.arm();
			assert.equal(
				codeOf(() => s.checkpoint(W, cursors(2))),
				"io-failure",
			);
		} else {
			crash.arm();
			assert.equal(
				codeOf(() => s.append(W, batch, [receipt])),
				"io-failure",
			);
		}
		s = reopen(s);
		const { load, records: reloaded } = loadAll(s);
		assert(load.state === "open");
		const committed = point === "after-checkpoint-rename";
		assert.deepEqual(reloaded, committed ? all : all.slice(0, 2), "exactly the checkpoint's records");
		if (committed) assert.deepEqual({ files: load.checkpoint?.files, ledger: load.checkpoint?.ledger }, cursors(2));
		else assert.deepEqual(load.checkpoint, first);
		assert.equal(load.dropped.records, committed ? 0 : lines(batch), "synced or not, past the checkpoint is cut");
		assert.equal(s.receipt(W, "same-call", receipt.k) !== null, committed);
		const scratch = s.listWeeks().scratch;
		// B3 re-reads from the checkpoint's cursors: the same batch again.
		const again = s.append(W, batch, [receipt]);
		assert.deepEqual([again.appended, again.receipts], committed ? [0, 0] : [2, 1]);
		s.checkpoint(W, cursors(2));
		clock = AFTER;
		const sealed = s.seal(W, PARTIAL);
		const { rates: _rates, ...total } = sealed.total;
		assert.deepEqual(total, totals(all), "the same totals as a run with no crash: nothing lost, nothing twice");
		return { kept: reloaded.length, receiptsDropped: load.dropped.receipts > 0, scratch };
	},

	crashSeal() {
		clock = AFTER;
		const point = variant as UsageWeekPoint,
			crash = crashAt(point);
		let s = open({ fault: crash.fault });
		const records = seed(s, 5);
		crash.arm();
		assert.equal(
			codeOf(() => s.seal(W, COMPLETE)),
			"io-failure",
		);
		s = reopen(s);
		const { load, records: reloaded } = loadAll(s);
		assert.equal(load.state, point === "after-seal-rename" ? "sealed" : "open");
		if (load.state === "open") {
			assert.deepEqual(reloaded, records);
			s.seal(W, COMPLETE);
		}
		const read = s.sealedTotals(W);
		assert(read.state === "sealed");
		const { rates, ...total } = read.sealed.total;
		assert.deepEqual(total, totals(records));
		assert.equal(
			rates.reduce((n, r) => n + r.attempts, 0),
			5,
		);
		assert.equal(read.sealed.keys.count, 5);
		const scratch = s.listWeeks().scratch;
		s = reopen(s);
		const sealed = s.reload(W);
		assert(sealed.state === "sealed");
		assert.deepEqual(sealed.sealed, read.sealed);
		return { scratch };
	},

	mismatch() {
		clock = AFTER;
		let s = open();
		seed(s, 3, [sameCall("response-a")]);
		if (variant.startsWith("sealed")) s.seal(W, COMPLETE);
		close(s);
		let expected = "";
		switch (variant) {
			case "log-sha":
				flipRecord();
				expected = "log-mismatch";
				break;
			case "checkpoint-log-sha":
				resign(name("checkpoint"), (c) => {
					(c.log as { sha256: string }).sha256 = sha("fixture-another-log");
				});
				expected = "log-mismatch";
				break;
			case "log-short":
				truncateSync(file(name("log")), bytes(name("log")).length - 10);
				expected = "log-mismatch";
				break;
			case "checkpoint-sha":
				edit(name("checkpoint"), `"ordinal":1,`, `"ordinal":2,`);
				expected = "checkpoint-corrupt";
				break;
			case "log-version":
				edit(name("log"), "usage-week-log/1", "usage-week-log/2");
				expected = "store-version";
				break;
			case "log-missing":
				rmSync(file(name("log")));
				expected = "log-missing";
				break;
			case "damaged-line": {
				// A line that is not a record, with a checkpoint re-signed over it: the sha256 matches, the line doesn't.
				appendFileSync(file(name("log")), '{"fixture":"not-a-record"}\n');
				const log = bytes(name("log"));
				resign(name("checkpoint"), (c) => {
					c.log = { length: log.length, records: 4, sha256: sha(log) };
				});
				expected = "log-corrupt";
				break;
			}
			case "receipts-sha":
				edit(name("receipts"), `"responseId":"response-a"`, `"responseId":"response-b"`);
				expected = "receipts-mismatch";
				break;
			case "receipts-missing":
				rmSync(file(name("receipts")));
				expected = "receipts-missing";
				break;
			case "sealed-sha":
				edit(name("sealed"), `"attempts":3,`, `"attempts":4,`);
				expected = "sealed-corrupt";
				break;
			case "sealed-keys": {
				const text = bytes(name("sealed")).toString("latin1"),
					at = text.indexOf("\n") + 1;
				writeFileSync(file(name("sealed")), text.slice(0, at) + (text[at] === "0" ? "1" : "0") + text.slice(at + 1));
				expected = "sealed-corrupt";
				break;
			}
			// Architecture HOME F4: a sealed week's retained log keeps its length but not its header.
			case "sealed-log-version":
				edit(name("log"), "usage-week-log/1", "usage-week-log/2");
				expected = "store-version";
				break;
			case "sealed-log-week":
				edit(name("log"), `"week":"${W}"`, `"week":"2026-10-12"`);
				expected = "log-corrupt";
				break;
			default:
				throw new Error(`fixture-unknown-variant:${variant}`);
		}
		const before = new Map(readdirSync(root()).map((n) => [n, readFileSync(file(n))]));
		s = open();
		const { load, records: handed, adjustments } = loadAll(s);
		assert.deepEqual(load, { state: "unavailable", week: W, code: expected }, "unknown, never zero");
		assert.equal(handed.length + adjustments.length, 0, "an unproven week hands over nothing");
		for (const [n, b] of before) assert.deepEqual(readFileSync(file(n)), b, `${n} stays as it was`);
		for (const call of [
			() => s.append(W, [record(9)]),
			() => s.checkpoint(W, cursors(2)),
			() => s.seal(W, COMPLETE),
			() => s.adjust(W, [record(9)]),
			() => s.receipt(W, "same-call", sameCallKey("response-a")),
		])
			assert.equal(codeOf(call), "week-unavailable");
		assert.deepEqual(s.status(), { state: "ready", code: null }, "other weeks go on");
		assert.equal(s.reload(NEXT).state, "empty");
		assert.equal(s.append(NEXT, [record(0, { at: "2026-10-27T10:00:00.000Z" })]).appended, 1);
		return { load, sealedTotals: s.sealedTotals(W).state };
	},

	refusals() {
		const s = open({ limits: { appendRecords: 4, weekRecords: 6, files: 2 } });
		assert.equal(
			codeOf(() => s.append(W, [record(0)])),
			"not-loaded",
		);
		assert.equal(
			codeOf(() => s.receipt(W, "same-call", sameCallKey("response-a"))),
			"not-loaded",
		);
		for (const week of ["2026-10-20", "2026-02-30", "2026-10-19 ", "../usage", ""])
			assert.equal(
				codeOf(() => s.reload(week)),
				"invalid-week",
				week,
			);
		seed(s, 1);
		const before = bytes(name("log"));
		const bad: unknown[] = [
			record(1, { sub: { role: "ops chat says hello", project: null, initiative: null, task: null } }),
			{ ...record(1), text: "hello" },
			record(1, { usd: 0.01 as unknown as string }),
			record(1, { usd: "0.0000000000001" }),
			record(1, { tok: [-1, 0, 0, 0] }),
			record(1, { tok: [1, 2, 3] as unknown as UsageWeekRecord["tok"] }),
			record(1, { k: sha("fixture").toUpperCase() }),
			record(1, { src: sha("fixture") }),
			record(1, { at: "2026-10-20T10:00:00Z" }),
			record(1, { off: 1.5 }),
			record(1, { len: -1 }),
			record(1, { d: "maybe" as UsageWeekDisposition }),
			record(1, { d: "gap", len: 10 }),
			{ ...gap(1), len: null },
			{ ...gap(1), len: 0 },
			record(1, { rate: "list rate" }),
			record(1, { sub: { role: "r".repeat(129), project: null, initiative: null, task: null } }),
			record(1, {
				sub: { role: null, project: null, initiative: null, task: { q: QUEUE, n: 0, at: "2026-10-22T16:00:00.000Z" } },
			}),
			null,
		];
		for (const r of bad)
			assert.equal(
				codeOf(() => s.append(W, [r as UsageWeekRecord])),
				"invalid-record",
			);
		assert.equal(
			codeOf(() => s.append(W, [record(1), bad[0] as UsageWeekRecord])),
			"invalid-record",
			"all or none",
		);
		const good = sameCall("response-a");
		const badReceipts: unknown[] = [
			{ ...good, kind: "other" },
			{ ...good, k: sameCallKey("response-b") },
			{ ...good, extra: 1 },
			{ kind: "same-call", k: sameCallKey("chat says hi"), r: witness("chat says hi") },
			{ ...good, r: { ...good.r, canonical: { ...fact(), model: undefined } } },
			{ ...good, r: { ...good.r, note: "hello" } },
			{
				kind: "ledger-native",
				k: good.k,
				r: { v: "usage-ledger-native/1", key: sha("x"), numericSha256: sha("n"), fact: fact(), alias: null },
			},
			null,
		];
		for (const x of badReceipts)
			assert.equal(
				codeOf(() => s.append(W, [], [x as UsageWeekReceipt])),
				"invalid-receipt",
				JSON.stringify(x)?.slice(0, 80),
			);
		assert.equal(
			codeOf(() => s.append(W, [record(1)], [good, badReceipts[0] as UsageWeekReceipt])),
			"invalid-receipt",
			"all or none",
		);
		for (const at of ["2026-10-19T06:59:59.999Z", "2026-10-26T07:00:00.000Z"])
			assert.equal(
				codeOf(() => s.append(W, [record(1, { at })])),
				"wrong-week",
				at,
			);
		const notDigest: UsageWeekCursors = {
			files: { "NOT-A-DIGEST": { cursor: null, size: 0, mtimeMs: 0 } },
			ledger: null,
		};
		const tooMany = cursors(1);
		tooMany.files[sha("fixture-source:2").slice(0, 16)] = { cursor: null, size: 0, mtimeMs: 0 };
		const badLedger = cursors(1);
		badLedger.ledger!.line = 2;
		const badToken = cursors(1);
		Object.values(badToken.files)[0].cursor = { ordinal: 1, token: "a token with spaces" };
		for (const c of [notDigest, tooMany, badLedger, badToken])
			assert.equal(
				codeOf(() => s.checkpoint(W, c)),
				"invalid-cursors",
			);
		assert.equal(
			codeOf(() => s.seal(W, { state: "complete", gaps: [{ code: "line-limit", count: 1 }] })),
			"invalid-coverage",
		);
		assert.equal(
			codeOf(() => s.seal(W, COMPLETE)),
			"week-not-ended",
		);
		assert.equal(
			codeOf(() => s.adjust(W, [record(1)])),
			"not-sealed",
		);
		assert.equal(
			codeOf(() => s.deleteWeek(W)),
			"not-sealed",
		);
		assert.deepEqual(bytes(name("log")), before, "refusals write nothing");
		assert.equal(s.listWeeks().weeks[0].receipts, false, "no receipts file either");
		assert.deepEqual(s.status(), { state: "ready", code: null });
		assert.equal(
			codeOf(() =>
				s.append(
					W,
					[1, 2, 3, 4, 5].map((i) => record(i)),
				),
			),
			"store-capacity",
		);
		assert.equal(
			s.append(
				W,
				[1, 2, 3, 4].map((i) => record(i)),
			).records,
			5,
		);
		assert.equal(s.append(W, [record(5)]).records, 6);
		assert.equal(
			codeOf(() => s.append(W, [record(6)])),
			"store-capacity",
			"the week's record cap",
		);
		clock = AFTER;
		assert.equal(
			codeOf(() => s.seal(W, COMPLETE)),
			"checkpoint-behind",
		);
		s.checkpoint(W);
		assert.equal(s.seal(W, COMPLETE).total.count.original, 6);
		for (const call of [
			() => s.append(W, [record(9)]),
			() => s.checkpoint(W),
			() => s.seal(W, COMPLETE),
			() => s.quarantineWeek(W),
		])
			assert.equal(codeOf(call), "sealed");
		const big = open({ lease: new SharedArrayBuffer(4), limits: { weekRecords: 10_000_000 } });
		assert.deepEqual(big.status(), { state: "unavailable", code: "store-capacity" });
		close(big);
		assert.deepEqual(s.status(), { state: "ready", code: null });
		return "ok";
	},

	duplicates() {
		let s = open();
		assert.equal(s.reload(W).state, "empty");
		assert.deepEqual(s.append(W, [record(0), record(1), record(0)]), {
			appended: 2,
			duplicates: 1,
			receipts: 0,
			receiptDuplicates: 0,
			records: 2,
			length: header().length + line(record(0)).length + line(record(1)).length,
		});
		const second = s.append(W, [record(1), record(2)]);
		assert.deepEqual([second.appended, second.duplicates, second.records], [1, 1, 3]);
		s.checkpoint(W);
		s = reopen(s);
		const { load, records: reloaded } = loadAll(s);
		assert(load.state === "open");
		assert.deepEqual(reloaded, [record(0), record(1), record(2)]);
		assert.equal(s.append(W, [record(0), record(1), record(2)]).duplicates, 3);
		return "ok";
	},

	/** M6: dispositions survive a restart; unknowns keep the week partial and are never counted as zero dollars. */
	unknowns() {
		clock = AFTER;
		let s = open();
		const mixed = [
			record(0),
			record(1, { d: "alias" }),
			record(2, { d: "unverified", usd: null }),
			record(3, { d: "unresolved" }),
			gap(4),
		];
		assert.equal(s.reload(W).state, "empty");
		s.append(W, mixed);
		s.checkpoint(W, cursors(1));
		s = reopen(s);
		const { records } = loadAll(s);
		assert.deepEqual(records, mixed, "every disposition and the gap's bytes come back after a restart");
		assert.equal(
			codeOf(() => s.seal(W, COMPLETE)),
			"invalid-coverage",
			"unknowns can't be sealed as complete",
		);
		const sealed = s.seal(W, PARTIAL);
		const { rates, ...total } = sealed.total;
		assert.deepEqual(total, totals(mixed));
		assert.deepEqual(rates, [{ rate: "anthropic-list/2026-10", attempts: 1 }]);
		assert.equal(sealed.total.usd, record(0).usd, "money from the original alone");
		return sealed.total.count;
	},

	/**
	 * M5: W2's readers backed by the store across restarts. A synthetic private ledger (two lines: a helper call, and
	 * a chat call whose session original is known only through a same-call witness) is read three times, the receipts
	 * committed with each batch, the store reopened between reads.
	 */
	ledgerReceipts() {
		const request = syntheticLedger();
		let s = open();
		const first = (k: string) => s.receipt(W, "ledger-native", k);
		const sameCallReader = (provider: string, responseId: string) =>
			s.receipt(W, "same-call", sha(JSON.stringify([provider, responseId])));
		const summary = (r: LedgerReadResult) => ({
			dispositions: r.observations.map((o) => o.disposition),
			faults: r.faults.map((f) => f.code),
			receipts: r.nativeReceipts.length,
			cursor: r.cursor !== null,
		});
		const asRecords = (r: LedgerReadResult) =>
			r.observations
				.filter((o) => o.disposition !== "duplicate")
				.map((o) =>
					record(o.line, {
						k: sha(`fixture-ledger-line:${o.line}`),
						d: o.disposition === "unresolved" ? "unresolved" : o.disposition === "alias" ? "alias" : "original",
						at: o.occurredAt,
					}),
				);
		const commit = (r: LedgerReadResult, extra: UsageWeekReceipt[] = []) => {
			const a = s.append(W, asRecords(r), [...r.nativeReceipts.map(native), ...extra]);
			s.checkpoint(W, { files: {}, ledger: r.cursor });
			return { receipts: a.receipts, receiptDuplicates: a.receiptDuplicates };
		};
		// Not loaded: the reader throws, which W2 turns into index-unavailable, never a proven-absent null.
		const unloaded = summary(readUsageLedger(request, { first }, () => 0));
		assert.equal(s.reload(W).state, "empty");
		const read1 = readUsageLedger(request, { first, sameCall: sameCallReader }, () => 0);
		const committed1 = commit(read1);
		s = reopen(s);
		assert.equal(s.reload(W).state, "open");
		// The chat call's session original is now known: Ops stores the witness as B3 will, then W2 reads again.
		assert.equal(s.append(W, [], [sameCall("response-1")]).receipts, 1);
		const read2 = readUsageLedger(request, { first, sameCall: sameCallReader }, () => 0);
		const committed2 = commit(read2);
		s = reopen(s);
		assert.equal(s.reload(W).state, "open");
		const read3 = readUsageLedger(request, { first, sameCall: sameCallReader }, () => 0);
		const committed3 = commit(read3);
		// A stored receipt changes only by attaching an alias once; anything else is refused.
		const helper = read1.nativeReceipts.find((r) => r.alias === null)!;
		const attached = read2.nativeReceipts.find((r) => r.alias !== null);
		const refused = [
			native({ ...helper, numericSha256: sha("fixture-other-numbers") }),
			...(attached
				? [native({ ...attached, alias: { ...attached.alias!, evidenceRef: "native-response-map/2" } })]
				: []),
		].map((x) => codeOf(() => s.append(W, [], [x])));
		return {
			unloaded,
			read1: { ...summary(read1), committed: committed1 },
			read2: { ...summary(read2), committed: committed2 },
			read3: { ...summary(read3), committed: committed3 },
			refused,
		};
	},

	/**
	 * Architecture HOME F2: a receipt belongs to the week its call happened in, as a record does (the native fact's
	 * occurredAt, or the same-call original's). The week's first and last milliseconds are in, the ones just outside are
	 * not, for both kinds, on append and on a sealed week's adjust; a call of another week is refused; and a stored
	 * receipt from outside the week is damage on return, never an answer.
	 */
	receiptWeeks() {
		const edges = [
			"2026-10-19T06:59:59.999Z", // just before the week
			"2026-10-19T07:00:00.000Z", // its first millisecond, Monday 00:00 PDT
			"2026-10-26T06:59:59.999Z", // its last
			"2026-10-26T07:00:00.000Z", // the next week's first
		];
		const makers = { native: nativeAt, same: sameCallAt };
		let s = open();
		seed(s, 1, [sameCall("response-seed")]);
		const offer = (call: (x: UsageWeekReceipt) => unknown, tag: string) =>
			Object.fromEntries(
				Object.entries(makers).map(([kind, make]) => [
					kind,
					edges.map((at, i) => codeOf(() => call(make(`response-${tag}-${kind}-${i}`, at)))),
				]),
			);
		const append = offer((x) => s.append(W, [], [x]), "append");
		// Calls of October 20 offered to the week of October 26.
		assert.equal(s.reload(NEXT).state, "empty");
		const otherWeek = Object.entries(makers).map(([kind, make]) =>
			codeOf(() => s.append(NEXT, [], [make(`response-other-${kind}`, LEDGER_AT)])),
		);
		s.checkpoint(W, cursors(2));
		clock = AFTER;
		s.seal(W, COMPLETE);
		const adjust = offer((x) => s.adjust(W, [], [x]), "late");
		close(s);
		const planted = [nativeAt("response-planted-native", edges[0]), sameCallAt("response-planted-same", edges[3])];
		for (const x of planted) plantReceipt(x);
		const returned = planted.map((x) => {
			s = open();
			assert.equal(s.reload(W).state, "sealed");
			assert.deepEqual(s.receipt(W, "same-call", sameCallKey("response-seed")), witness("response-seed"));
			const code = codeOf(() => s.receipt(W, x.kind, x.k));
			close(s);
			return code;
		});
		return { append, otherWeek, adjust, returned };
	},

	/**
	 * Architecture HOME F3: the store keeps only receipts W2 itself takes back, checking what W2's receipt() and
	 * sameCall() check without the reader's projection. Each variant is valid to the contract and differs from a
	 * W2-written receipt in one such field: refused on append (invalid-receipt), refused by W2 itself when a reader hands
	 * it over (index-unavailable, same-call-unverified) and, planted in the file, refused on return (receipts-corrupt).
	 * The unchanged receipts pass all three.
	 */
	strictReceipts() {
		const request = syntheticLedger();
		let s = open();
		seed(s, 1, [sameCall("response-seed")]);
		close(s);
		const good = readUsageLedger(request, { first: () => null }, () => 0).nativeReceipts.find((r) => r.alias === null)!;
		const saved = (["receipts", "checkpoint"] as const).map((kind) => [kind, bytes(name(kind))] as const);
		const restore = () => {
			for (const [kind, b] of saved) writeFileSync(file(name(kind)), b);
		};
		const verdicts = (x: UsageWeekReceipt) => {
			s = open();
			assert.equal(s.reload(W).state, "open");
			const append = codeOf(() => s.append(W, [], [x]));
			close(s);
			const faults = readUsageLedger(
				request,
				x.kind === "ledger-native"
					? { first: (k) => (k === x.k ? x.r : null) }
					: { first: () => null, sameCall: (_p, id) => (id === "response-1" ? x.r : null) },
				() => 0,
			).faults.map((f) => f.code);
			const refusal = x.kind === "ledger-native" ? "index-unavailable" : "same-call-unverified";
			restore();
			plantReceipt(x);
			s = open();
			assert.equal(s.reload(W).state, "open");
			const returned = codeOf(() => s.receipt(W, x.kind, x.k));
			close(s);
			restore();
			return [append, faults.includes(refusal) ? refusal : "accepted", returned];
		};
		const membership = {
			queue: "fixture-queue",
			task: 422,
			addedAt: LEDGER_FROM,
			project: null,
			initiative: null,
			effectiveAt: LEDGER_FROM,
		};
		const nativeVariants: Record<string, (r: LedgerNativeReceipt) => LedgerNativeReceipt> = {
			none: (r) => r,
			event: (r) => ({ ...r, fact: { ...r.fact, source: { ...r.fact.source, event: "native-entry" } } }),
			producer: (r) => {
				const identity = { ...r.fact.identity, producer: "temper" as const };
				return { ...r, fact: { ...r.fact, identity, id: factId(identity) } };
			},
			revision: (r) => ({ ...r, fact: { ...r.fact, revision: 1, supersedes: 0 } }),
			task: (r) => ({ ...r, fact: { ...r.fact, links: { ...r.fact.links, task: membership } } }),
			run: (r) => ({ ...r, fact: { ...r.fact, links: { ...r.fact.links, run: "fixture-run" } } }),
			coverage: (r) => ({ ...r, fact: { ...r.fact, source: { ...r.fact.source, coverage: "complete" } } }),
		};
		const sameVariants: Record<string, (w: LedgerSameCall) => LedgerSameCall> = {
			none: (w) => w,
			unverified: (w) => ({ ...w, canonical: { ...w.canonical, identityStatus: "unresolved" } }),
			producer: (w) => {
				const identity = { ...w.canonical.identity, producer: "temper" as const };
				return { ...w, canonical: { ...w.canonical, identity, id: factId(identity) } };
			},
		};
		return {
			native: Object.fromEntries(
				Object.entries(nativeVariants).map(([n, change]) => [n, verdicts(native(change(good)))]),
			),
			same: Object.fromEntries(
				Object.entries(sameVariants).map(([n, change]) => [
					n,
					verdicts({ kind: "same-call", k: sameCallKey("response-1"), r: change(witness("response-1")) }),
				]),
			),
		};
	},

	sealAdjust() {
		clock = AFTER;
		let s = open();
		const records = seed(s, 20);
		const sealed = s.seal(W, {
			state: "partial",
			gaps: [
				{ code: "line-limit", count: 2 },
				{ code: "file-cap", count: 1 },
			],
		});
		assert.deepEqual(sealed.coverage, {
			state: "partial",
			gaps: [
				{ code: "file-cap", count: 1 },
				{ code: "line-limit", count: 2 },
			],
		});
		const { rates, ...total } = sealed.total;
		assert.deepEqual(total, totals(records));
		assert.deepEqual(rates, [
			{ rate: null, attempts: 1 },
			{ rate: "anthropic-list/2026-10", attempts: 19 },
		]);
		assert.deepEqual(
			sealed.subjects.map(({ sub, ...t }) => [sub, t]),
			[
				[record(1).sub, totals(records.filter((_, i) => i % 2 === 1))],
				[record(0).sub, totals(records.filter((_, i) => i % 2 === 0))],
			],
		);
		const keys = records
			.map((r) => r.k.slice(0, 32))
			.sort()
			.join("");
		assert.deepEqual(sealed.keys, { count: 20, bytes: 16, sha256: sha(keys) });
		assert.equal(bytes(name("sealed")).toString("latin1").split("\n")[1], keys);
		assert.deepEqual(sealed.log, { length: bytes(name("log")).length, records: 20, sha256: sha(bytes(name("log"))) });
		assert.deepEqual(s.sealedTotals(W), { state: "sealed", week: W, sealed });
		const late = [100, 101].map((i) => record(i));
		assert.deepEqual(s.adjust(W, [records[0], late[0], late[1], late[0]], [sameCall("response-late")]), {
			added: 2,
			duplicates: 2,
			receipts: 1,
			receiptDuplicates: 0,
			records: 2,
		});
		assert.deepEqual(s.adjust(W, [late[1]]), {
			added: 0,
			duplicates: 1,
			receipts: 0,
			receiptDuplicates: 0,
			records: 2,
		});
		assert.equal(
			codeOf(() => s.adjust(W, [record(102, { at: "2026-10-26T07:00:00.000Z" })])),
			"wrong-week",
		);
		s = reopen(s);
		const { load, records: logRecords, adjustments } = loadAll(s);
		assert(load.state === "sealed");
		assert.deepEqual(load.sealed, sealed);
		assert.deepEqual(adjustments, late);
		assert.equal(logRecords.length, 0, "a sealed week's log is not handed over again");
		assert.deepEqual(load.dropped, { records: 0, receipts: 0 });
		assert.equal(load.checkpoint.adjust?.records, 2);
		assert.equal(load.receipts, 1);
		assert.deepEqual(s.receipt(W, "same-call", sameCallKey("response-late")), witness("response-late"));
		assert.deepEqual(s.sealedTotals(W), { state: "sealed", week: W, sealed }, "adjustments never change sealed totals");
		return { usd: sealed.total.usd, originals: sealed.total.count.original };
	},

	/** adjust() commits with its own checkpoint: a crash before that leaves nothing; after it, everything. */
	crashAdjust() {
		clock = AFTER;
		const point = variant as UsageWeekPoint,
			late = [100, 101].map((i) => record(i));
		const crash = crashAt(point, point === "adjust-write" ? 30 : undefined);
		let s = open({ fault: crash.fault });
		seed(s, 3);
		const sealed = s.seal(W, COMPLETE);
		crash.arm();
		assert.equal(
			codeOf(() => s.adjust(W, late)),
			"io-failure",
		);
		s = reopen(s);
		const { load, adjustments } = loadAll(s);
		assert(load.state === "sealed");
		assert.deepEqual(load.sealed, sealed);
		const committed = point === "after-checkpoint-rename";
		assert.deepEqual(adjustments, committed ? late : []);
		assert.equal(load.dropped.records, committed ? 0 : point === "adjust-write" ? 30 : lines(late));
		assert.deepEqual(
			s.adjust(W, late),
			committed
				? { added: 0, duplicates: 2, receipts: 0, receiptDuplicates: 0, records: 2 }
				: { added: 2, duplicates: 0, receipts: 0, receiptDuplicates: 0, records: 2 },
		);
		s = reopen(s);
		const { load: again, adjustments: kept } = loadAll(s);
		assert(again.state === "sealed");
		assert.deepEqual(kept, late);
		assert.deepEqual(again.dropped, { records: 0, receipts: 0 });
		return { kept: adjustments.length, cut: load.dropped.records > 0 };
	},

	/**
	 * Architecture HOME F1: B3's first batch of a week can hold receipts and no records. Cut by a crash after its
	 * receipts synced, it must reload as an open week with nothing committed, never as a missing log; and B3's re-read
	 * from there must leave the same records, receipts, unknowns and cursors as a run with no crash.
	 */
	receiptOnlyCrash() {
		clock = AFTER;
		const batches: { records: UsageWeekRecord[]; receipts: UsageWeekReceipt[] }[] = [
			{ records: [], receipts: [sameCall("response-f1-a")] },
			{
				records: [record(0), record(1, { d: "unverified", usd: null }), gap(2)],
				receipts: [sameCall("response-f1-b"), nativeAt("response-f1-c", LEDGER_AT)],
			},
		];
		// B3 reads from the start: each batch appended, then checkpointed with its cursors.
		const pass = (s: UsageWeekStore) =>
			batches.forEach((b, i) => {
				s.append(W, b.records, b.receipts);
				s.checkpoint(W, cursors(i + 1));
			});
		// What a restarted reader gets: records, every receipt by key, cursors, the files and the sealed totals.
		const seen = (s: UsageWeekStore, dir: string) => {
			const { load, records } = loadAll(s);
			assert(load.state === "open");
			const receipts = batches.flatMap((b) => b.receipts.map((x) => s.receipt(W, x.kind, x.k)));
			const files = ["log", "receipts"].map((kind) =>
				sha(readFileSync(join(dir, USAGE_WEEK_DIRECTORY, `week-${W}.${kind}`))),
			);
			return {
				records,
				receipts: [load.receipts, receipts],
				cursors: { files: load.checkpoint?.files, ledger: load.checkpoint?.ledger },
				files,
				total: s.seal(W, PARTIAL).total,
			};
		};
		const crash = crashAt("after-receipts-sync");
		let s = open({ fault: crash.fault });
		assert.equal(s.reload(W).state, "empty");
		crash.arm();
		assert.equal(
			codeOf(() => s.append(W, batches[0].records, batches[0].receipts)),
			"io-failure",
		);
		s = reopen(s);
		const reload = s.reload(W);
		if (reload.state !== "open") return { reload };
		pass(s);
		s = reopen(s);
		const crashed = seen(s, data.dir);
		close(s);
		const dir = join(data.dir, "no-crash");
		mkdirSync(dir, { mode: 0o700 });
		const clean = { dataDir: dir, lease: new SharedArrayBuffer(4) };
		let c = open(clean);
		assert.equal(c.reload(W).state, "empty");
		pass(c);
		c = reopen(c, clean);
		assert.deepEqual(crashed, seen(c, dir), "the same records, receipts, unknowns and cursors as a run with no crash");
		const { dropped } = reload;
		return { reload: { ...reload, dropped: { records: dropped.records, receipts: dropped.receipts > 0 } }, same: true };
	},

	quarantine() {
		let s = open();
		seed(s, 2);
		close(s);
		flipRecord();
		const damaged = bytes(name("log"));
		s = open();
		assert.equal(
			codeOf(() => s.quarantineWeek(W)),
			"not-loaded",
		);
		assert.equal(s.reload(W).state, "unavailable");
		const { moved } = s.quarantineWeek(W);
		assert.deepEqual(moved.map((n) => n.replace(/-[a-f0-9]{16}$/, "")).sort(), [
			`${name("checkpoint")}.quarantine`,
			`${name("log")}.quarantine`,
		]);
		assert.deepEqual(bytes(moved.find((n) => n.startsWith(name("log")))!), damaged, "moved aside, never deleted");
		assert.deepEqual(s.listWeeks(), { weeks: [], scratch: 0, quarantined: 2, other: 0 });
		assert.deepEqual(s.reload(W), { state: "empty", week: W });
		assert.equal(s.append(W, [record(0)]).appended, 1, "the week can be rebuilt");
		return "ok";
	},

	unsafe() {
		const elsewhere = join(data.dir, "fixture-elsewhere");
		mkdirSync(elsewhere, { mode: 0o700 });
		const victim = join(elsewhere, "victim");
		writeFileSync(victim, "fixture-victim\n", { mode: 0o600 });
		switch (variant) {
			case "folder-link":
				symlinkSync(elsewhere, root());
				break;
			case "folder-mode":
				mkdirSync(root(), { mode: 0o700 });
				chmodSync(root(), 0o755);
				break;
			case "data-mode":
				chmodSync(data.dir, 0o777);
				break;
			default: {
				const s = open();
				seed(s, 2);
				close(s);
				if (variant === "file-link") {
					rmSync(file(name("checkpoint")));
					symlinkSync(victim, file(name("checkpoint")));
				} else if (variant === "file-mode") chmodSync(file(name("log")), 0o644);
				else if (variant === "hard-link") linkSync(file(name("log")), join(elsewhere, "second-name"));
				else throw new Error(`fixture-unknown-variant:${variant}`);
			}
		}
		const s = open();
		const reload = s.status().state === "ready" ? codeOf(() => s.reload(W)) : null;
		assert.equal(readFileSync(victim, "utf8"), "fixture-victim\n");
		assert.deepEqual(
			readdirSync(elsewhere).sort(),
			variant === "hard-link" ? ["second-name", "victim"] : ["victim"],
			"nothing is written through a link",
		);
		return { reload, status: s.status() };
	},

	deleteWeek() {
		clock = AFTER;
		const s = open();
		seed(s, 3, [sameCall("response-a")]);
		assert.equal(
			codeOf(() => s.deleteWeek(W)),
			"not-sealed",
		);
		s.seal(W, COMPLETE);
		assert.equal(s.adjust(W, [record(100)]).added, 1);
		assert.deepEqual(s.deleteWeek(W).removed, [
			name("adjust"),
			name("receipts"),
			name("checkpoint"),
			name("log"),
			name("sealed"),
		]);
		assert.deepEqual(s.listWeeks().weeks, []);
		assert.equal(
			codeOf(() => s.deleteWeek(W)),
			"not-loaded",
		);
		assert.deepEqual(s.reload(W), { state: "empty", week: W });
		return "ok";
	},

	dst() {
		clock = Date.parse("2026-10-30T12:00:00.000Z");
		const s = open();
		assert.equal(s.reload(NEXT).state, "empty");
		const inside = [
			"2026-10-26T07:00:00.000Z", // Monday 00:00 PDT, the week's first millisecond
			"2026-11-01T08:59:59.999Z", // Sunday 01:59:59.999 PDT
			"2026-11-01T09:00:00.000Z", // Sunday 01:00 PST, the second 1 am
			"2026-11-02T07:00:00.000Z", // Sunday 23:00 PST: a fixed -7 h offset would call this Monday
			"2026-11-02T07:59:59.999Z", // the week's last millisecond
		];
		assert.equal(
			s.append(
				NEXT,
				inside.map((at, i) => record(i, { at })),
			).appended,
			5,
		);
		for (const at of ["2026-10-26T06:59:59.999Z", "2026-11-02T08:00:00.000Z"])
			assert.equal(
				codeOf(() => s.append(NEXT, [record(9, { at })])),
				"wrong-week",
				at,
			);
		assert.equal(s.reload("2026-11-02").state, "empty");
		assert.equal(s.append("2026-11-02", [record(9, { at: "2026-11-02T08:00:00.000Z" })]).appended, 1);
		s.checkpoint(NEXT, cursors(1));
		clock = Date.parse("2026-11-02T07:59:59.999Z");
		assert.equal(
			codeOf(() => s.seal(NEXT, COMPLETE)),
			"week-not-ended",
			"the 169-hour week is still open",
		);
		clock = Date.parse("2026-11-02T08:00:00.000Z");
		assert.equal(s.seal(NEXT, COMPLETE).total.count.original, 5);
		return "ok";
	},

	/**
	 * B_LARGE_CASE=1, first worker: one week appended with a same-call receipt per record and checkpointed, the next
	 * appended with no checkpoint.
	 */
	largeWrite() {
		const count = Number(data.extra.count),
			s = open(),
			batch = s.limits.appendRecords;
		const fill = (week: string, base: number, receipts: boolean) => {
			let ms = 0;
			assert.equal(s.reload(week).state, "empty");
			for (let from = 0; from < count; from += batch) {
				const ids = Array.from({ length: Math.min(batch, count - from) }, (_, j) => from + j);
				const records = ids.map((i) => largeRecord(i, base));
				const started = performance.now();
				const a = s.append(week, records, receipts ? ids.map((i) => sameCall(`response-${i}`)) : []);
				ms += performance.now() - started;
				assert.equal(a.appended, records.length);
			}
			return ms;
		};
		const appendMs = fill(W, Date.parse("2026-10-20T10:00:00.000Z"), true);
		const started = performance.now();
		const cp = s.checkpoint(W, cursors(1));
		const checkpointMs = performance.now() - started;
		const appendNextMs = fill(NEXT, Date.parse("2026-10-27T10:00:00.000Z"), false);
		return {
			records: cp.log.records,
			logBytes: cp.log.length,
			receipts: cp.receipts?.records,
			receiptBytes: cp.receipts?.length,
			appendMs,
			checkpointMs,
			appendNextMs,
		};
	},

	/** B_LARGE_CASE=1, a fresh worker (a restart): reloads timed, then the seal and the sealed reads. */
	largeReload() {
		const count = Number(data.extra.count);
		let s = open();
		// What B3 will do with each record: running totals (count, tokens, USD in exact 1e-12 units), nothing kept.
		const fold = () => {
			const t = { records: 0, tok: 0, usd: 0n };
			const each = (r: UsageWeekRecord) => {
				t.records++;
				for (const n of r.tok) t.tok += n ?? 0;
				if (r.usd !== null) t.usd += BigInt(r.usd.replace(".", ""));
			};
			return { t, each };
		};
		const reloadFoldMs: number[] = [],
			reloadMs: number[] = [];
		let heapAfterReload = 0,
			foldUsd = 0n;
		for (let run = 0; run < 3; run++) {
			const { t, each } = fold();
			const started = performance.now();
			const load = s.reload(W, each);
			reloadFoldMs.push(performance.now() - started);
			assert(load.state === "open");
			assert.equal(load.records, count);
			assert.equal(load.receipts, count);
			assert.equal(t.records, count);
			assert.deepEqual(load.dropped, { records: 0, receipts: 0 });
			if (run === 0) heapAfterReload = process.memoryUsage().heapUsed;
			foldUsd = t.usd;
		}
		for (let run = 0; run < 3; run++) {
			const started = performance.now();
			const load = s.reload(W);
			reloadMs.push(performance.now() - started);
			assert(load.state === "open" && load.records === count);
		}
		let started = performance.now();
		for (let i = 0; i < 1000; i++)
			assert.notEqual(s.receipt(W, "same-call", sameCallKey(`response-${(i * 7919) % count}`)), null);
		const receiptLookupMs = (performance.now() - started) / 1000;
		started = performance.now();
		const next = s.reload(NEXT);
		const uncheckpointedReloadMs = performance.now() - started;
		assert(next.state === "open");
		assert.equal(next.records, 0, "no checkpoint: nothing committed, all cut");
		assert(next.dropped.records > 0);
		clock = AFTER;
		started = performance.now();
		const sealed = s.seal(W, COMPLETE);
		const sealMs = performance.now() - started;
		assert.equal(sealed.total.count.original, count);
		const [whole, fraction] = sealed.total.usd.split(".");
		assert.equal(BigInt(whole + (fraction ?? "").padEnd(12, "0")), foldUsd, "the seal and the reload agree to 1e-12");
		started = performance.now();
		assert.equal(s.sealedTotals(W).state, "sealed");
		const sealedTotalsMs = performance.now() - started;
		s = reopen(s);
		started = performance.now();
		assert.equal(s.reload(W).state, "sealed");
		const sealedReloadMs = performance.now() - started;
		return {
			reloadFoldMs,
			reloadMs,
			heapAfterReload,
			receiptLookupMs,
			uncheckpointedReloadMs,
			sealMs,
			sealedTotalsMs,
			sealedReloadMs,
			sealedBytes: bytes(name("sealed")).length,
			usd: sealed.total.usd,
		};
	},
};

let message: { kind: "result"; value: unknown } | { kind: "failure"; code: string };
try {
	const run = cases[data.caseName];
	assert(run, `known case ${data.caseName}`);
	message = { kind: "result", value: run() ?? "ok" };
} catch (error) {
	message = { kind: "failure", code: String((error as Error)?.stack ?? error).slice(0, 3000) };
} finally {
	for (const s of stores) s.close();
	stores.clear();
}
parentPort!.postMessage(message);
parentPort!.close();
