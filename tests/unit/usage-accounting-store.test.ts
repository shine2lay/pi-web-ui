import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { METER_LIMITS, METER_WORKER_RESOURCE_LIMITS } from "../../server/usage-accounting-meter-contract.js";
import type { UsageStorePoint } from "../../server/usage-accounting-store.js";

// H-WIRE-1: append/checkpoint/index/native failures must not invent a durable cursor or hide damaged evidence.
// Hypothesis: exercising the real worker-private store, rather than a replacement I/O adapter, will expose
// optimistic prefix publication, unsafe path opens and corrupt negative lookups. A clean/replayed exact prefix,
// unchanged evidence bytes and the unchanged W0 resource limits are the success criteria; any contrary result
// falsifies the hypothesis. All sources, tokens and disk contents below are synthetic and temporary.
const roots: string[] = [];
const workers = new Set<Worker>();
afterEach(async () => {
	await Promise.all([...workers].map((worker) => worker.terminate()));
	workers.clear();
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixtureDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "usage-accounting-store-"));
	roots.push(dir);
	return dir;
}

// The esbuild Worker pattern is the W0 collector harness's pattern. No fixture file or bundle is written to
// the checkout. In particular, the production index, lock helper and filesystem operations are NOT mocked.
const workerFixture = String.raw`
import assert from "node:assert/strict";
import {
	chmodSync, closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync,
	mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { setImmediate as pause } from "node:timers/promises";
import { parentPort, workerData } from "node:worker_threads";
import { UsageAccountingStore } from "__STORE__";
import { UsageAccountingCollector } from "__COLLECTOR__";
import { factId } from "__CONTRACT__";
import { METER_LIMITS } from "__METER__";

const AT = "2026-10-20T12:00:00.000Z", FROM = "2026-10-19T07:00:00.000Z";
const PAGE = { maxBytes: METER_LIMITS.pageBytes, maxRows: METER_LIMITS.pageRows };
const ZERO = "0".repeat(64), dir = workerData.dir;
const stores = new Set<UsageAccountingStore>();
const canonical = (raw: any): string => Array.isArray(raw) ? "[" + raw.map(canonical).join(",") + "]"
	: raw !== null && typeof raw === "object" ? "{" + Object.keys(raw).sort().map(k => JSON.stringify(k) + ":" + canonical(raw[k])).join(",") + "}"
	: JSON.stringify(raw);
const bytes = (s: string) => Buffer.byteLength(s);
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const root = (data = dir) => join(data, "usage-accounting");
const path = (name: string, data = dir) => join(root(data), name);
const journalName = (n: number) => "journal-" + String(n).padStart(6, "0") + ".numeric";
const read = (name: string, data = dir) => readFileSync(path(name, data));
function put(name: string, contents: string | Uint8Array, data = dir) {
	writeFileSync(path(name, data), contents, { mode: 0o600 });
}
function empty() { return { facts: [], allocations: [], aliases: [], roots: [], policies: [], memberships: [], snapshots: [] }; }
function inventory(count = 1) {
	return { v: "usage-inventory/1", evidenceRef: "fixture-only:store-inventory", observedAt: AT, complete: true,
		sources: Array.from({ length: count }, (_, i) => ({ stream: "fixture-native-" + i,
			incarnation: "fixture-native-incarnation", adapterRef: "fixture-only:store-adapter", producer: "pi",
			occurrenceStreams: ["fixture-native-" + i], retainedFrom: FROM, grants: ["facts"] })) };
}
const verifier = {
	inventory: (v: any) => v.evidenceRef === "fixture-only:store-inventory",
	batch: (b: any) => b.adapterRef === "fixture-only:store-adapter" && Object.keys(empty()).every(k => k === "facts" || b.rows[k].length === 0),
};
function amount(i: number) { return i % 3 === 0 ? "0.10" : i % 3 === 1 ? "0.000000000001" : "0.03"; }
function fact(i: number, source = 0) {
	const identity = { producer: "pi", incarnation: "fixture-native-incarnation", attempt: "fixture-attempt-" + i };
	return { v: "usage-fact/1", id: factId(identity), revision: 0, supersedes: null, identity, identityStatus: "verified",
		occurredAt: "2026-10-20T10:00:00.000Z", provider: "fixture-provider", model: "fixture-model", kind: "assistant",
		tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
		prices: [{ basis: "list-estimate", currency: "USD", amount: amount(i), status: "known", rateVersion: "fixture-rates/1" }],
		source: { stream: "fixture-native-" + source, event: "fixture-event-" + i, observedAt: AT, coverage: "complete" },
		links: { task: null, session: null, run: null } };
}
function batch(ordinal = 1, facts = [fact(ordinal - 1)], source = 0) {
	const cursor = (n: number) => ({ ordinal: n, token: "fixture-only:opaque-" + source + "-" + (n * 17 + 11) });
	return { v: "usage-source-batch/1", stream: "fixture-native-" + source, incarnation: "fixture-native-incarnation",
		adapterRef: "fixture-only:store-adapter", fromCursor: ordinal === 1 ? null : cursor(ordinal - 1), toCursor: cursor(ordinal),
		from: FROM, through: AT, observedAt: AT, status: "complete", reason: "none", rows: { ...empty(), facts } };
}
async function open(options: any = {}, data = dir, lease: SharedArrayBuffer = workerData.lease) {
	const s = await UsageAccountingStore.open({ dataDir: data, lease, ...options }); stores.add(s); return s;
}
async function close(s: UsageAccountingStore) { await s.close(); stores.delete(s); }
function ready(s: UsageAccountingStore) { const status = s.status(); assert.equal(status.state, "ready"); assert.equal(status.code, null); assertFixed(status); }
async function collector(s: UsageAccountingStore, inv = inventory()) {
	return UsageAccountingCollector.openPaged({ io: s, inventory: inv, verifier, clock: () => performance.now() });
}
async function collect(c: any, b: any) { return c.collect(b.stream, JSON.stringify(b), AT); }
function anchor(data = dir) { return JSON.parse(read("checkpoint.numeric", data).toString("utf8")); }
function journal(data = dir) {
	return readdirSync(root(data)).filter(n => /^journal-\d{6}\.numeric$/.test(n)).sort().map(n => read(n, data));
}
function initial() { return { v: "usage-paged-checkpoint/1", sequence: 0, end: { segment: 1, offset: 0 }, sha256: ZERO }; }
function line(sequence: number, code = "source-unavailable") {
	return canonical({ v: "usage-journal/1", sequence, at: AT, kind: "fault", stream: null, code }) + "\n";
}
function next(prefix: any, text: string, segment = prefix.end.segment, offset = prefix.end.offset) {
	return { v: "usage-paged-checkpoint/1", sequence: prefix.sequence + 1,
		end: { segment, offset: offset + bytes(text) }, sha256: sha(prefix.sha256 + text) };
}
async function initialized(options: any = {}, data = dir) {
	const s = await open(options, data); ready(s); await s.head(METER_LIMITS); await s.index.reset(); return s;
}
async function committed(s: UsageAccountingStore, prefix = initial()) {
	const text = line(prefix.sequence + 1), p = next(prefix, text);
	await s.append(p.end.segment, prefix.end.offset, text); await s.sync(p.end.segment);
	await s.checkpoint(canonical(p) + "\n"); return p;
}
async function seed(data = dir) {
	const s = await open({}, data); ready(s); const c = await collector(s);
	assert.equal((await collect(c, batch())).status, "committed");
	const cp = s.committedPrefix(); assert(cp); assert.deepEqual(cp, anchor(data));
	const native = await s.commitNative(nativeCursors(), cp);
	return { s, c, cp, native };
}
function nativeCursors() {
	return [
		{ kind: "feed", stream: "fixture-native-0", readerEpoch: "fixture-epoch-A", token: "opaque:NOT-an-ordinal/0091+=", state: "committed" },
		{ kind: "feed", stream: "fixture-quarantined", readerEpoch: "fixture-epoch-B", token: "opaque:409/keep-byte-for-byte", state: "quarantined" },
		{ kind: "file", stream: "fixture-file", incarnation: "fixture-file-incarnation", ordinal: 17, byte: 101, line: 3,
			headerSha256: "a".repeat(64), anchor: { start: 91, bytes: 10, sha256: "b".repeat(64) } },
	];
}
async function fold(c: any, requireHealthy = true) {
	let facts = 0, units = 0n, pages = 0, maxRows = 0, maxBytes = 0;
	for await (const page of c.evidencePages(AT, "current-week")) {
		if (requireHealthy) { assert.equal(page.evidence.storage, "healthy"); assert.deepEqual(page.evidence.faults, []); }
		else assert(["healthy", "partial"].includes(page.evidence.storage));
		const n = Object.values(page.rows).reduce((count: number, rows: any) => count + rows.length, 0) + page.coverage.length;
		const length = bytes(JSON.stringify(page)); assert(n <= PAGE.maxRows); assert(length <= PAGE.maxBytes);
		maxRows = Math.max(maxRows, n); maxBytes = Math.max(maxBytes, length); pages++;
		for (const f of page.rows.facts) {
			const [whole, decimal = ""] = f.prices[0].amount.split(".");
			units += BigInt(whole) * 1_000_000_000_000n + BigInt(decimal.padEnd(12, "0")); facts++;
		}
	}
	return { facts, units: units.toString(), pages, maxRows, maxBytes };
}
function assertFixed(status: any) {
	assert(["ready", "waiting-for-previous-writer", "unavailable", "closed"].includes(status.state));
	assert(status.code === null || /^[a-z]+(?:-[a-z]+)*$/.test(status.code));
	assert(Object.keys(status).sort().join() === "alarms,code,state");
	for (const alarm of status.alarms) { assert.equal(alarm.count, 1); assert(/^[a-z]+(?:-[a-z]+)*$/.test(alarm.code)); }
}
function alarm(s: UsageAccountingStore, code: string) { assert(s.status().alarms.some(a => a.code === code), code); }
async function rejects(promise: Promise<unknown>, code?: string) {
	await assert.rejects(promise, (e: any) => typeof e.code === "string" && (code === undefined || e.code === code));
}
function snapshot(data = dir) {
	return readdirSync(root(data)).sort().filter(n => n !== "lock" && !n.startsWith("index.")).map(name => {
		const st = lstatSync(path(name, data));
		return { name, mode: st.mode & 0o777, ino: st.ino, bytes: st.isFile() ? read(name, data).toString("hex") : null };
	});
}
function child(name: string) { const d = join(dir, name); mkdirSync(d, { mode: 0o700 }); return d; }
const cases: Record<string, () => Promise<unknown>> = {};
cases.lifecycle = async () => {
	const s = await open(); ready(s); assert.deepEqual(s.status().alarms, []);
	assert.equal(s.v, "usage-collector-paged-io/1"); assert.equal(Atomics.load(new Int32Array(workerData.lease), 0), 1);
	assert.equal(lstatSync(root()).mode & 0o777, 0o700);
	const header = JSON.parse(read("header.numeric").toString("utf8"));
	assert.deepEqual(Object.keys(header).sort(), ["generation", "major", "minor", "v"]);
	assert.equal(header.v, "usage-accounting-store"); assert.equal(header.major, 1); assert.equal(header.minor, 0);
	assert.match(header.generation, /^[a-f0-9]{64}$/);
	assert.deepEqual(await s.head(METER_LIMITS), { sizes: [], checkpoint: null });
	await s.index.reset(); await committed(s);
	for (const name of readdirSync(root())) { const st = lstatSync(path(name)); assert(st.isFile()); assert.equal(st.nlink, 1); assert.equal(st.mode & 0o777, 0o600); }
	await close(s); assert.equal(Atomics.load(new Int32Array(workerData.lease), 0), 0);
	assert.deepEqual(s.status().state, "closed"); assert.equal(s.status().code, "closed");
	await rejects(s.head(METER_LIMITS), "closed"); await s.close();
	const reopened = await open(); ready(reopened);
	assert.deepEqual(JSON.parse(read("header.numeric").toString("utf8")), header);
};
cases.invalidLease = async () => {
	for (const lease of [new SharedArrayBuffer(0), new SharedArrayBuffer(8), new ArrayBuffer(4)]) {
		const s = await open({ lease }); assert.equal(s.status().state, "unavailable"); assert.equal(s.status().code, "unsafe-path");
		assertFixed(s.status()); await close(s);
	}
	assert(!existsSync(root()));
};
cases.integration = async () => {
	let { s, c, native } = await seed();
	const first = batch(), before = journal(), prefix = anchor(), originalNative = read("native.numeric");
	const firstEvidence = await fold(c);
	assert.equal(firstEvidence.facts, 1); assert.equal(firstEvidence.units, "100000000000"); assert.equal(firstEvidence.pages, 2);
	const sequence = c.checkpoint().sequence;
	assert.equal((await collect(c, first)).status, "duplicate"); assert.equal(c.checkpoint().sequence, sequence);
	assert.deepEqual(journal(), before); assert.deepEqual((await s.nativeCheckpoint()).checkpoint?.cursors, nativeCursors());
	const logical = c.checkpoint(); await close(s);
	s = await open(); ready(s);
	// A derived index reset and metadata read are not proof: unread journal bytes forbid a usable seek cursor.
	await s.head(METER_LIMITS); await s.index.reset();
	const early = await s.nativeCheckpoint(); assert.equal(early.state, "unavailable");
	assert.deepEqual(early.checkpoint?.cursors, native.cursors); await close(s);
	s = await open(); c = await collector(s); assert.deepEqual(c.checkpoint(), logical); assert.deepEqual(journal(), before);
	const available = await s.nativeCheckpoint(); assert.equal(available.state, "available");
	assert.equal(available.checkpoint?.sequence, prefix.sequence);
	assert.deepEqual(available.checkpoint?.cursors, native.cursors);
	assert.equal(available.checkpoint?.generation, native.generation);
	assert.deepEqual(available.checkpoint?.journal, native.journal);
	assert.notEqual(available.checkpoint?.index.generation, native.index.generation);
	assert.equal(available.checkpoint?.index.sha256, native.index.sha256);
	assert.equal((await fold(c)).facts, 1);
	assert.equal((await collect(c, first)).status, "duplicate"); assert.deepEqual(journal(), before);
	assert(originalNative.length > 0);
};
cases.checkpointGuard = async () => {
	const s = await initialized(), text = line(1), p = next(initial(), text);
	await s.append(1, 0, text);
	if (workerData.extra.variant === "unsynced") {
		await rejects(s.checkpoint(canonical(p) + "\n"), "checkpoint-corrupt");
	} else {
		await s.sync(1);
		const bad = structuredClone(p);
		switch (workerData.extra.variant) {
			case "sequence": bad.sequence++; break;
			case "offset": bad.end.offset++; break;
			case "segment": bad.end.segment++; break;
			case "digest": bad.sha256 = "f".repeat(64); break;
			case "field": bad.cursor = "fixture:must-not-be-a-W0-field"; break;
		}
		await rejects(s.checkpoint(canonical(bad) + "\n"), "checkpoint-corrupt");
	}
	assert(!existsSync(path("checkpoint.numeric"))); assert.equal(read(journalName(1)).toString("utf8"), text);
};
cases.pagedReads = async () => {
	const s = await initialized(); let prefix = initial(); const texts: string[] = [];
	for (let i = 1; i <= 3; i++) { texts.push(line(i)); prefix = await committed(s, prefix); }
	const original = journal(); await close(s);
	const r = await open(); ready(r);
	assert.deepEqual((await r.head(METER_LIMITS)).sizes, [bytes(texts.join(""))]);
	await r.index.reset(); const parts: Buffer[] = []; let offset = 0;
	while (offset < bytes(texts.join(""))) {
		const part = await r.readPage({ segment: 1, offset }, 7); assert(part.byteLength > 0 && part.byteLength <= 7);
		parts.push(Buffer.from(part)); offset += part.byteLength;
	}
	assert.equal(Buffer.concat(parts).toString("utf8"), texts.join(""));
	await r.sync(1); await r.checkpoint(canonical(prefix) + "\n"); assert.deepEqual(journal(), original);
	assert(r.metrics().maxReadBytes <= METER_LIMITS.pageBytes); assert(r.metrics().maxStagingBytes <= METER_LIMITS.stagingBytes);
};
cases.recoveryBarrier = async () => {
	let { s, cp } = await seed(); await close(s); put(journalName(2), line(2));
	const before = journal(); s = await open(); ready(s); const image = await s.head(METER_LIMITS); await s.index.reset();
	assert.equal(image.sizes.length, 2); assert.equal(s.committedPrefix(), null);
	const variant = workerData.extra.variant;
	if (variant !== "unread") {
		await s.readPage({ segment: 1, offset: 0 }, PAGE.maxBytes);
		if (variant !== "partial") await s.readPage({ segment: 2, offset: 0 }, PAGE.maxBytes);
		if (variant === "partial" || variant === "one-sync") await s.sync(1);
	}
	assert.equal((await s.nativeCheckpoint()).state, "unavailable");
	await rejects(s.append(2, image.sizes[1], line(cp.sequence + 2)), "journal-corrupt");
	assert.deepEqual(journal(), before); assert.deepEqual(anchor(), cp);
	await close(s); const recovered = await open(); const c = await collector(recovered);
	assert.equal(c.checkpoint().cursors[0].cursor.ordinal, 1); assert.equal(c.checkpoint().sequence, 2); assert.deepEqual(journal(), before);
};
cases.emptyTrailingSegment = async () => {
	let { s, cp } = await seed(); await close(s); put(journalName(2), ""); const original = journal();
	s = await open(); const c = await collector(s); assert.equal(c.checkpoint().sequence, cp.sequence);
	assert.equal(c.checkpoint().cursors[0].cursor.ordinal, 1); assert.deepEqual(journal(), original);
	assert.equal((await collect(c, batch(2))).status, "committed");
	assert.deepEqual(read(journalName(1)), original[0]); assert(read(journalName(2)).length > 0);
	const published = s.committedPrefix(); assert(published); assert.equal(published.end.segment, 2);
	await close(s); s = await open(); const replay = await collector(s);
	assert.equal((await collect(replay, batch(2))).status, "duplicate"); assert.equal((await fold(replay, false)).facts, 2);
};
cases.badRead = async () => {
	let { s } = await seed(); await close(s); s = await open(); await s.head(METER_LIMITS);
	const variant = workerData.extra.variant;
	await rejects(s.readPage({ segment: variant === "segment" ? 2 : 1, offset: variant === "offset" ? 1 : 0 }, variant === "bound" ? METER_LIMITS.pageBytes + 1 : 16), variant === "bound" ? "store-capacity" : "journal-corrupt");
};
cases.appendCas = async () => {
	const s = await initialized(), prefix = await committed(s), original = read(journalName(1));
	put(journalName(1), Buffer.concat([original, Buffer.from("fixture-external-tail")]));
	const evidence = read(journalName(1));
	await rejects(s.append(1, prefix.end.offset, line(2)), "journal-corrupt");
	assert.deepEqual(read(journalName(1)), evidence); assert.deepEqual(anchor(), prefix);
};
cases.fault = async () => {
	let armed = false, hits = 0;
	const point = workerData.extra.point, short = workerData.extra.short === true;
	let s = await open({ fault: (at: string) => {
		if (!armed || at !== point) return; hits++;
		if (short) return 11;
		throw new Error("fixture-only:injected-fault");
	} }); ready(s);
	let c = await collector(s); assert.equal((await collect(c, batch())).status, "committed");
	const cp = anchor(), native = await s.commitNative(nativeCursors(), cp), nativeBytes = read("native.numeric"), first = read(journalName(1));
	armed = true;
	if (point === "native-write") {
		const changed = nativeCursors(); changed[0].token = "fixture-new-token-never-committed";
		await rejects(s.commitNative(changed, cp), "io-failure");
		assert.deepEqual(read("native.numeric"), nativeBytes); assert.deepEqual(anchor(), cp);
	} else {
		const result = await collect(c, batch(2)); assert.equal(result.status, "unavailable");
		assert.equal(hits, 1); assertFixed(s.status());
		const visible = anchor();
		// Rename may have happened, but every visible checkpoint must still name complete existing journal bytes.
		assert(visible.sequence >= cp.sequence && visible.sequence <= cp.sequence + 1);
		const full = read(journalName(1)).toString("utf8").split("\n").slice(0, -1);
		assert(visible.sequence <= full.length);
		let digest = ZERO; for (const text of full.slice(0, visible.sequence)) digest = sha(digest + text + "\n");
		assert.equal(visible.sha256, digest);
	}
	assert.equal(hits, 1);
	if (point.startsWith("checkpoint-") || point === "after-checkpoint-rename")
		assert.equal(read("checkpoint.previous.numeric").toString("utf8"), canonical(cp) + "\n");
	if (point === "native-write") assert.deepEqual(read("native.previous.numeric"), nativeBytes);
	const damaged = journal(); assert(read(journalName(1)).subarray(0, first.length).equals(first));
	await close(s); // Release the real lifetime lock; never clear an uncertain shared lease in a crash fixture.
	s = await open(); ready(s); c = await collector(s);
	assert.deepEqual(journal(), damaged);
	const physicalComplete = Buffer.concat(damaged).toString("utf8").split("\n").slice(0, -1).length;
	assert(c.checkpoint().sequence <= physicalComplete);
	const cursor = c.checkpoint().cursors[0]?.cursor;
	assert(!cursor || cursor.ordinal <= (point === "native-write" || short && point === "journal-write" ? 1 : 2));
	const retained = await s.nativeCheckpoint();
	if (retained.state === "available") {
		assert.equal(retained.checkpoint?.sequence, c.checkpoint().sequence);
		assert.deepEqual(retained.checkpoint?.cursors, native.cursors);
	} else if (retained.checkpoint !== null) assert(retained.checkpoint.sequence <= physicalComplete);
	// Retry/replay must be exactly once even if append reached the disk but the commit reply was lost.
	const retried = await collect(c, batch(2)); assert(["committed", "duplicate"].includes(retried.status));
	const stable = journal(); assert.equal((await collect(c, batch(2))).status, "duplicate"); assert.deepEqual(journal(), stable);
	const published = await fold(c).catch(async () => {
		const evidence = await c.evidence(AT); assert.equal(evidence.storage, "partial");
		let count = 0; for await (const page of c.evidencePages(AT, "all")) count += page.rows.facts.length;
		return { facts: count };
	});
	assert.equal(published.facts, 2);
	await close(s); s = await open(); c = await collector(s);
	assert.equal(c.checkpoint().cursors[0].cursor.ordinal, 2);
	assert.deepEqual(journal(), stable); assert.equal((await collect(c, batch(2))).status, "duplicate");
};
cases.reopenFault = async () => {
	const seeded = await seed(); await close(seeded.s); const before = snapshot(); let hits = 0;
	const s = await open({ fault: (point: string) => { if (point === "reopen") { hits++; throw new Error("fixture-reopen"); } } });
	assert.equal(hits, 1); assert.equal(s.status().state, "unavailable"); assert.equal(s.status().code, "io-failure");
	assert.deepEqual(snapshot(), before); await close(s);
	const recovered = await open(); ready(recovered); const c = await collector(recovered);
	assert.equal((await collect(c, batch())).status, "duplicate"); assert.equal((await fold(c)).facts, 1);
};
cases.nativeGuard = async () => {
	const { s, c, cp } = await seed(), original = read("native.numeric");
	if (workerData.extra.variant === "ahead") {
		const forged = structuredClone(cp); forged.sequence++;
		await rejects(s.commitNative(nativeCursors(), forged), "native-unavailable");
		assert.deepEqual(read("native.numeric"), original);
	} else {
		assert.equal((await collect(c, batch(2))).status, "committed");
		const retained = await s.nativeCheckpoint(); assert.equal(retained.state, "unavailable");
		assert.equal(retained.checkpoint?.sequence, cp.sequence);
		assert.deepEqual(retained.checkpoint?.cursors, nativeCursors()); assert.deepEqual(read("native.numeric"), original);
		const prefix = s.committedPrefix(); assert(prefix);
		const published = await s.commitNative(nativeCursors(), prefix); assert.equal(published.sequence, cp.sequence + 1);
		assert.equal((await s.nativeCheckpoint()).state, "available");
	}
};
cases.largeNative = async () => {
	let { s, cp } = await seed();
	const cursors = Array.from({ length: METER_LIMITS.sources }, (_, i) => ({ kind: "feed", stream: "fixture-native-paged-" + i,
		readerEpoch: "e".repeat(64), token: String(i).padStart(4, "0") + "t".repeat(196), state: i % 2 ? "quarantined" : "committed" }));
	await s.commitNative(cursors, cp); const sidecar = read("native.numeric");
	assert(sidecar.length > PAGE.maxBytes && sidecar.length <= METER_LIMITS.checkpointBytes);
	const before = journal(); await close(s); s = await open(); await collector(s);
	const restored = await s.nativeCheckpoint(); assert.equal(restored.state, "available"); assert.deepEqual(restored.checkpoint?.cursors, cursors);
	assert.equal(restored.checkpoint?.sequence, cp.sequence); assert.deepEqual(journal(), before);
	assert(s.metrics().maxReadBytes <= PAGE.maxBytes); assert(s.metrics().maxStagingBytes <= METER_LIMITS.stagingBytes);
};
cases.corruptNative = async () => {
	let { s, cp, native } = await seed(); await close(s);
	let text: string;
	switch (workerData.extra.variant) {
		case "checksum": { const raw = JSON.parse(read("native.numeric").toString("utf8")); raw.checkpoint.cursors[0].token = "fixture-forged-token"; text = canonical(raw) + "\n"; break; }
		case "generation": native.generation = "f".repeat(64); text = canonical({ v: "usage-store-native/1", checkpoint: native, sha256: sha(canonical(native)) }) + "\n"; break;
		case "ahead": native.sequence++; native.index.sequence++; text = canonical({ v: "usage-store-native/1", checkpoint: native, sha256: sha(canonical(native)) }) + "\n"; break;
		case "index": native.index.sha256 = "d".repeat(64); text = canonical({ v: "usage-store-native/1", checkpoint: native, sha256: sha(canonical(native)) }) + "\n"; break;
		default: text = "{fixture-torn-native";
	}
	put("native.numeric", text); const before = read("native.numeric"), originalJournal = journal();
	s = await open(); const c = await collector(s); const result = await s.nativeCheckpoint();
	assert.equal(result.state, "unavailable"); alarm(s, "native-unavailable");
	assert.equal((await s.nativeCheckpoint()).state, "unavailable"); assertFixed(s.status());
	assert.equal(c.checkpoint().sequence, cp.sequence); assert.deepEqual(journal(), originalJournal); assert.deepEqual(read("native.numeric"), before);
	assert.equal((await collect(c, batch(2))).status, "committed");
	const prefix = s.committedPrefix(); assert(prefix); await s.commitNative(nativeCursors(), prefix);
	const saved = readdirSync(root()).filter(n => /^evidence-native-[a-f0-9]{64}\.numeric$/.test(n));
	assert.equal(saved.length, 1); assert.deepEqual(read(saved[0]), before);
};
cases.untrustedNativeWrite = async () => {
	let { s } = await seed(); assert.equal((await s.nativeCheckpoint()).state, "available");
	const validPrevious = read("native.previous.numeric"), envelope = JSON.parse(validPrevious.toString("utf8"));
	assert.equal(envelope.sha256, sha(canonical(envelope.checkpoint))); assert.deepEqual(envelope.checkpoint.cursors, nativeCursors());
	await close(s); const corrupt = Buffer.from("{fixture-corrupt-native-primary"); put("native.numeric", corrupt);
	let armed = false, hits = 0;
	s = await open({ fault: (point: string) => {
		if (!armed || point !== "native-write") return; hits++;
		if (workerData.extra.variant === "short") return 13;
		throw new Error("fixture-untrusted-native-write-failure");
	} }); const c = await collector(s); assert.equal((await s.nativeCheckpoint()).state, "unavailable");
	assert.deepEqual(read("native.previous.numeric"), validPrevious); assert.deepEqual(read("native.numeric"), corrupt);
	assert.equal((await collect(c, batch(2))).status, "committed");
	const prefix = s.committedPrefix(); assert(prefix); const retained = journal(), checkpoint = read("checkpoint.numeric");
	const changed = nativeCursors(); changed[0].token = "fixture-new-native-not-acknowledged"; armed = true;
	await rejects(s.commitNative(changed, prefix), "io-failure"); assert.equal(hits, 1);
	const evidence = "evidence-native-" + sha(corrupt) + ".numeric";
	assert.deepEqual(read(evidence), corrupt); assert.deepEqual(read("native.previous.numeric"), validPrevious);
	assert.equal(lstatSync(path("native.previous.numeric")).mode & 0o777, 0o600); assert.equal(lstatSync(path("native.previous.numeric")).nlink, 1);
	assert.deepEqual(read("native.numeric"), corrupt); assert.deepEqual(read("checkpoint.numeric"), checkpoint); assert.deepEqual(journal(), retained);
	await close(s); s = await open(); const replay = await collector(s);
	assert.equal((await s.nativeCheckpoint()).state, "unavailable"); // A valid previous cache is never an automatic restore.
	assert.deepEqual(read("native.previous.numeric"), validPrevious); assert.deepEqual(read("native.numeric"), corrupt); assert.deepEqual(read(evidence), corrupt);
	assert.equal((await collect(replay, batch(2))).status, "duplicate"); assert.deepEqual(journal(), retained); assert.equal((await fold(replay)).facts, 2);
};
cases.corruptCheckpoint = async () => {
	let { s, cp } = await seed(); await close(s);
	const bad = workerData.extra.variant === "parse" ? "{fixture-torn-checkpoint"
		: canonical({ ...cp, ...(workerData.extra.variant === "ahead" ? { sequence: cp.sequence + 100 } : { sha256: "f".repeat(64) }) }) + "\n";
	put("checkpoint.numeric", bad); const original = journal();
	s = await open(); const c = await collector(s), evidence = await c.evidence(AT);
	assert(evidence.faults.some(f => f.code === "collector:checkpoint-corrupt")); assert.notEqual(evidence.storage, "healthy");
	assert.equal(c.checkpoint().sequence, cp.sequence); assert.deepEqual(journal(), original); assert.equal(read("checkpoint.numeric").toString("utf8"), bad);
	assert.equal((await s.nativeCheckpoint()).state, "unavailable");
	assert.equal((await collect(c, batch(2))).status, "committed");
	const saved = readdirSync(root()).filter(n => /^evidence-checkpoint-[a-f0-9]{64}\.numeric$/.test(n));
	assert.equal(saved.length, 1); assert.equal(read(saved[0]).toString("utf8"), bad);
	assert(read(journalName(1)).subarray(0, original[0].length).equals(original[0]));
};
cases.unanchored = async () => {
	let { s, cp } = await seed(); await s.checkpoint(canonical(cp) + "\n"); await s.nativeCheckpoint(); await close(s);
	const native = read("native.numeric");
	if (workerData.extra.variant === "missing-checkpoint") rmSync(path("checkpoint.numeric"));
	else put(journalName(1), Buffer.concat([read(journalName(1)), Buffer.from(line(2))]));
	const retained = journal(), checkpoint = existsSync(path("checkpoint.numeric")) ? read("checkpoint.numeric") : null;
	s = await open(); const c = await collector(s), evidence = await c.evidence(AT);
	assert.equal(evidence.storage, "partial"); assert(evidence.faults.some(f => f.code === "collector:checkpoint-corrupt"));
	assert.equal(c.checkpoint().cursors[0].cursor.ordinal, 1); assert.equal(s.committedPrefix(), null); alarm(s, "checkpoint-corrupt");
	assert.equal((await s.nativeCheckpoint()).state, "unavailable"); assert.deepEqual(read("native.numeric"), native);
	assert.equal((await collect(c, batch())).status, "duplicate"); assert.deepEqual(journal(), retained);
	assert.equal(s.committedPrefix(), null); assert.equal((await s.nativeCheckpoint()).state, "unavailable");
	if (checkpoint === null) assert(!existsSync(path("checkpoint.numeric"))); else assert.deepEqual(read("checkpoint.numeric"), checkpoint);
	const sequence = c.checkpoint().sequence; assert.equal((await collect(c, batch(2))).status, "committed");
	assert.equal(c.checkpoint().sequence, sequence + 2); assert.equal(c.checkpoint().cursors[0].cursor.ordinal, 2);
	assert(read(journalName(1)).subarray(0, retained[0].length).equals(retained[0]));
	const published = s.committedPrefix(); assert(published); assert(published.sequence > cp.sequence);
	const updated = nativeCursors(); updated[0].token = "fixture-clean-durable-publication";
	await s.commitNative(updated, published); assert.equal((await s.nativeCheckpoint()).state, "available");
	const preserved = readdirSync(root()).filter(n => /^evidence-native-[a-f0-9]{64}\.numeric$/.test(n));
	assert.equal(preserved.length, 1); assert.deepEqual(read(preserved[0]), native);
	const stable = journal(); await close(s); s = await open(); const replay = await collector(s);
	assert.equal((await collect(replay, batch(2))).status, "duplicate"); assert.deepEqual(journal(), stable);
	assert.equal((await fold(replay, false)).facts, 2);
};
cases.journalCorruption = async () => {
	let { s } = await seed(); await close(s); const first = read(journalName(1));
	const variant = workerData.extra.variant;
	if (variant === "tail") put(journalName(1), Buffer.concat([first, Buffer.from('{"fixture-torn":')]));
	else if (variant === "utf8") put(journalName(1), Buffer.concat([first, Buffer.from([0xff, 10])]));
	else if (variant === "duplicate") put(journalName(1), Buffer.concat([first, first]));
	else if (variant === "sequence-gap") put(journalName(1), Buffer.concat([first, Buffer.from(line(3))]));
	else if (variant === "noncanonical") put(journalName(1), Buffer.concat([first, Buffer.from(" " + line(2))]));
	else if (variant === "missing") renameSync(path(journalName(1)), path(journalName(2)));
	else if (variant === "reordered") { put(journalName(1), line(2)); put(journalName(2), first); }
	else put(journalName(1), Buffer.concat([first, Buffer.from("{fixture-invalid-json}\n")]));
	const damaged = journal(); s = await open(); const c = await collector(s), evidence = await c.evidence(AT);
	assert.notEqual(evidence.storage, "healthy"); assert(evidence.faults.some(f => /journal-(?:corrupt|tail)/.test(f.code)));
	assert.deepEqual(journal(), damaged);
	const native = await s.nativeCheckpoint().catch(() => ({ state: "unavailable", checkpoint: null })); assert.equal(native.state, "unavailable");
	if (variant === "tail") {
		assert.equal(c.checkpoint().cursors[0]?.cursor.ordinal, 1);
		const result = await collect(c, batch(2)); assert.equal(result.status, "committed");
		assert(read(journalName(1)).equals(damaged[0])); assert(existsSync(path(journalName(2))));
		await close(s); s = await open(); const replay = await collector(s);
		assert.equal((await collect(replay, batch(2))).status, "duplicate"); assert.equal(replay.checkpoint().cursors[0].cursor.ordinal, 2);
	} else {
		assert.deepEqual(c.checkpoint().cursors, []);
		assert.equal((await collect(c, batch(2))).status, "unavailable"); assert.deepEqual(journal(), damaged);
	}
};
cases.indexOrder = async () => {
	const s = await initialized(), keys = ["r:Z", "r:a", "r:0", "r:A", "r:_", "r:z", "r:-", "r:aa", "r:", "other:r:", "r0:exclude"];
	const entry = (key: string) => ({ key, value: { kind: "node", identity: key, component: "fixture-component" } });
	assert.equal(await s.index.reserve(keys.length, 8192), true); await s.index.write(keys.map(entry), PAGE);
	const found: string[] = []; let after: string | null = null;
	do {
		const page = await s.index.scan("r:", after, { maxRows: 2, maxBytes: 1024 });
		assert(page.entries.length <= 2); assert(bytes(JSON.stringify(page)) <= 1024);
		for (const e of page.entries) { assert(e.key.startsWith("r:")); assert(after === null || e.key > after); found.push(e.key); }
		assert(page.after === null || page.after === page.entries.at(-1)?.key); after = page.after;
	} while (after !== null);
	assert.deepEqual(found, keys.filter(k => k.startsWith("r:")).sort()); assert.equal(new Set(found).size, found.length);
	const absentAfter = await s.index.scan("r:", "r:AA", PAGE);
	assert.deepEqual(absentAfter.entries.map(e => e.key), found.filter(k => k > "r:AA"));
	assert.deepEqual(await s.index.scan("nonexistent:", null, PAGE), { entries: [], after: null });
	assert.deepEqual(await s.index.scan("r:", "r:z", PAGE), { entries: [], after: null });
	assert.deepEqual(await s.index.get(["r:absent"], PAGE), []);
	const got = await s.index.get(["r:a", "r:absent", "r:Z"], PAGE);
	assert.deepEqual(got.sort((a, b) => a.key < b.key ? -1 : 1), [entry("r:Z"), entry("r:a")]);
	await s.index.write([{ key: "r:a", value: null }, { key: "r:Z", value: { kind: "node", identity: "fixture-updated", component: "fixture-component" } }], PAGE);
	assert.deepEqual(await s.index.get(["r:a"], PAGE), []);
	assert.equal((await s.index.get(["r:Z"], PAGE))[0].value.identity, "fixture-updated");
	const unsafe = "r:../../fixture-not-a-filename";
	await s.index.write([entry(unsafe)], PAGE); assert.equal((await s.index.get([unsafe], PAGE))[0].key, unsafe);
	assert.deepEqual(readdirSync(dir), ["usage-accounting"]);
	const before = journal(); await s.index.reset(); assert.deepEqual(await s.index.get(["r:Z"], PAGE), []); assert.deepEqual(journal(), before);
};
cases.coalescedFlush = async () => {
	let writes = 0;
	const s = await initialized({ fault(point: string) { if (point === "index-write") writes++; } });
	const before = journal(), entries = Array.from({ length: PAGE.maxRows }, (_, i) => ({ key: "r:coalesced-" + String(i).padStart(5, "0"),
		value: { kind: "node", identity: "fixture-coalesced-" + i, component: "fixture-component" } }));
	writes = 0; assert(await s.index.reserve(entries.length, PAGE.maxBytes)); await s.index.write(entries, PAGE);
	assert.equal(s.metrics().index.payloadWrites, 1, "one checked payload append per bounded write page");
	assert(s.metrics().index.maxPayloadBytes <= PAGE.maxBytes);
	const nodeAndHeaderWrites = writes - s.metrics().index.payloadWrites;
	assert(nodeAndHeaderWrites > 0 && nodeAndHeaderWrites < 32, "contiguous dirty slots must be coalesced, not written one node at a time");
	assert.deepEqual((await s.index.get(entries.map(e => e.key), PAGE)).sort((a, b) => a.key < b.key ? -1 : 1), entries);
	assert(s.metrics().index.maxWorkNodes > 0 && s.metrics().index.maxWorkNodes <= 256);
	assert(s.metrics().index.maxCacheBytes <= METER_LIMITS.indexCacheBytes); assert.deepEqual(journal(), before);
};
cases.trimmedFlush = async () => {
	const s = await initialized(), idx = s.index as any, node = 192, header = 96;
	const entry = (key: string, identity = key) => ({ key, value: { kind: "node", identity, component: "fixture-trim" } });
	const seeded = Array.from({ length: 256 }, (_, i) => entry("r:trim-a-" + String(i).padStart(5, "0")));
	await s.index.write(seeded, PAGE);
	const originalWrite = s.write.bind(s), originalRead = s.read.bind(s);
	let armed = false, complete = 0, gapped = 0;
	let writes: { offset: number; length: number; allDirty: boolean }[] = [], reads: { offset: number; length: number }[] = [];
	s.read = (fd: number, offset: number, length: number) => {
		if (armed && fd === idx.nodes && offset >= header) reads.push({ offset, length });
		return originalRead(fd, offset, length);
	};
	s.write = (fd: number, data: Buffer, offset: number, point: any) => {
		if (armed && fd === idx.nodes) {
			const first = (offset - header) / node + 1, bucket = Math.floor((first - 1) / 64);
			const wanted = [...idx.dirty as Set<number>].filter(id => Math.floor((id - 1) / 64) === bucket).sort((a, b) => a - b);
			assert(wanted.length > 0); assert.equal(first, wanted[0]);
			assert.equal(data.length, (wanted[wanted.length - 1] - wanted[0] + 1) * node);
			const old = read("index.nodes"), allDirty = data.length / node === wanted.length;
			for (let i = 0; i < data.length / node; i++) if (!wanted.includes(first + i))
				assert.deepEqual(data.subarray(i * node, (i + 1) * node), old.subarray(offset + i * node, offset + (i + 1) * node));
			writes.push({ offset, length: data.length, allDirty }); if (allDirty) complete++; else gapped++;
		}
		return originalWrite(fd, data, offset, point);
	};
	const updates = [entry(seeded[255].key, "fixture-updated")];
	const appended = Array.from({ length: 128 }, (_, i) => entry("r:trim-z-" + String(i).padStart(5, "0")));
	for (const entries of [updates, appended]) {
		const before = read("index.nodes"); writes = []; reads = []; armed = true;
		await s.index.write(entries, PAGE); armed = false; assert(writes.length > 0);
		for (const write of writes) {
			const matching = reads.filter(r => r.offset === write.offset);
			if (write.allDirty) assert.equal(matching.length, 0, "fully dirty span must not retain-read");
			else assert.equal(matching.filter(r => r.length === Math.min(write.length, Math.max(0, before.length - write.offset))).length, 1);
		}
		const after = read("index.nodes"); let at = 0;
		for (const write of writes) {
			assert.deepEqual(after.subarray(at, Math.min(write.offset, before.length)), before.subarray(at, Math.min(write.offset, before.length)));
			at = write.offset + write.length;
		}
		assert.deepEqual(after.subarray(at, before.length), before.subarray(at));
	}
	assert(complete > 0 && gapped > 0); seeded[255] = updates[0];
	const expected = [...seeded, ...appended], found: any[] = []; let after: string | null = null;
	do { const page = await s.index.scan("r:trim-", after, PAGE); found.push(...page.entries); after = page.after; } while (after !== null);
	assert.deepEqual(found, expected);
	const m = s.metrics().index; assert.equal(m.work.writtenSlots, m.work.trimmedSlots);
	assert.equal(m.work.retainedReadBytes, m.work.trimmedRetainedBytes); assert(m.maxWorkNodes <= 256);
};
cases.indexProfile = async () => {
	const s = await initialized(), count = 8192;
	const keys = Array.from({ length: count }, (_, i) => "r:profile-" + sha("fixed-key-" + i)).sort();
	const entry = (i: number, identity: string) => ({ key: keys[i], value: { kind: "node", identity, component: "fixture-profile" } });
	const snapshots: any[] = [];
	const measure = async (stage: string, work: () => Promise<void>) => {
		const before = s.metrics().index.work, started = performance.now(); await work();
		const after = s.metrics().index.work, counters: Record<string, unknown> = {};
		for (const key of Object.keys(after)) counters[key] = key === "density" ? after.density.map((n: number, i: number) => n - before.density[i])
			: after[key] - before[key];
		snapshots.push({ stage, elapsedMs: performance.now() - started, work: counters });
	};
	await measure("dense-append", async () => {
		for (let at = 0; at < count; at += 128) await s.index.write(Array.from({ length: 128 }, (_, i) => entry(at + i, "seed-" + (at + i))), PAGE);
	});
	await measure("scattered-updates", async () => {
		for (let page = 0; page < 32; page++) await s.index.write(Array.from({ length: 128 }, (_, i) => {
			const ordinal = page * 128 + i; return entry(ordinal * 4051 % count, "updated-" + page + "-" + i);
		}), PAGE);
	});
	await measure("read-only", async () => {
		for (let at = 0; at < count; at += 128) assert.equal((await s.index.get(keys.slice(at, at + 128), PAGE)).length, 128);
	});
	const m = s.metrics().index;
	assert.equal(m.entries, count); assert(m.work.cacheMisses > 0); assert(m.maxCacheBytes <= METER_LIMITS.indexCacheBytes);
	assert(m.maxWorkMs <= METER_LIMITS.unitWorkMs && m.maxWorkNodes <= 256);
	assert.equal(snapshots[2].work.flushGroups, 0); assert.equal(snapshots[2].work.dirtyEvictions, 0);
	// Snapshot before verification. 91 is the multiplicative inverse of 4051 modulo 8192.
	for (let at = 0; at < count; at += 128) {
		const expected = Array.from({ length: 128 }, (_, j) => {
			const i = at + j, ordinal = i * 91 % count;
			return entry(i, ordinal < 4096 ? "updated-" + Math.floor(ordinal / 128) + "-" + (ordinal % 128) : "seed-" + i);
		});
		assert.deepEqual((await s.index.get(keys.slice(at, at + 128), PAGE)).sort((a, b) => a.key < b.key ? -1 : 1), expected);
	}
	return { snapshots, maxCacheBytes: m.maxCacheBytes, maxWorkMs: m.maxWorkMs, maxWorkNodes: m.maxWorkNodes };
};
cases.payloadPage = async () => {
	const variant = workerData.extra.variant;
	let armed = false;
	const s = await initialized({ limits: variant === "order" || variant === "transient" ? { indexEntries: 2 }
		: variant === "near-bytes" || variant === "bytes" ? { indexBytes: 800 } : {},
		fault(point: string) {
			if (armed && point === "index-write") {
				if (variant === "short") return 0;
				if (variant === "ownership") renameSync(path("lock"), path("lock.fixture-displaced"));
			}
		} });
	const entry = (key: string, identity = "fixture") => ({ key, value: { kind: "node", identity, component: "fixture" } });
	await s.index.write([entry("r:A")], PAGE);
	if (variant === "order" || variant === "transient") await s.index.write([entry("r:B")], PAGE);
	const prefix = await committed(s), beforeJournal = journal(), beforeCheckpoint = read("checkpoint.numeric"),
		beforeValues = read("index.values"), beforeNodes = read("index.nodes"), writes = s.metrics().index.payloadWrites;
	if (variant === "order") {
		const entries = [entry("r:A", "é-🚀-first"), { key: "r:A", value: null }, entry("r:A", "é-🚀-last"),
			{ key: "r:B", value: null }, entry("r:C", "last-C")];
		await s.index.write(entries, PAGE);
		assert.equal(s.metrics().index.payloadWrites, writes + 1);
		assert.deepEqual((await s.index.get(["r:A", "r:B", "r:C"], PAGE)).sort((a, b) => a.key < b.key ? -1 : 1),
			[entry("r:A", "é-🚀-last"), entry("r:C", "last-C")]);
		assert.equal(read("index.values").subarray(beforeValues.length).toString("utf8"),
			entries.filter(e => e.value !== null).map(canonical).join(""));
		const length = read("index.values").length;
		await s.index.write([{ key: "r:A", value: null }, { key: "r:C", value: null }], PAGE);
		assert.equal(s.metrics().index.payloadWrites, writes + 1); assert.equal(read("index.values").length, length);
		assert.deepEqual(await s.index.get(["r:A", "r:C"], PAGE), []);
	} else if (variant === "near-bytes") {
		await s.index.write([entry("r:A", "é")], PAGE);
		assert.equal(s.metrics().index.payloadWrites, writes + 1);
		assert.deepEqual(await s.index.get(["r:A"], PAGE), [entry("r:A", "é")]);
		assert(s.metrics().index.allocatedBytes <= 800);
	} else {
		armed = variant === "short" || variant === "ownership";
		const entries = variant === "transient" ? [entry("r:C"), { key: "r:A", value: null }]
			: [entry("r:A", variant === "bytes" ? "fixture".repeat(150) : "changed")];
		await rejects(s.index.write(entries, PAGE), variant === "ownership" ? "writer-lost"
			: variant === "short" ? "io-failure" : "store-capacity");
		assert.equal(s.status().state, "unavailable"); assert.equal(s.metrics().index.payloadWrites, writes);
		assert.deepEqual(read("index.values"), beforeValues); assert.deepEqual(read("index.nodes"), beforeNodes);
	}
	assert.deepEqual(s.committedPrefix(), prefix); assert.deepEqual(journal(), beforeJournal);
	assert.deepEqual(read("checkpoint.numeric"), beforeCheckpoint);
};
cases.indexLowerBound = async () => {
	const s = await initialized(), keys = ["", "9", "9a", "9zz", "9zzzz0", ":", "a", "aa", "aaa", "aaz", "ab", "aba", "abz", "b", "z"];
	await s.index.write(keys.slice().reverse().map(key => ({ key, value: { kind: "node", identity: key, component: "fixture-skipped-bit" } })), PAGE);
	for (const prefix of ["", "9", "aa", "ab", "absent"]) for (const start of [null, "", "9zzzz", "a", "aa", "aa0", "ab", "abx", "z"]) {
		const found: string[] = []; let after = start;
		do {
			const page = await s.index.scan(prefix, after, { maxRows: 1, maxBytes: 512 });
			assert(page.entries.length <= 1); assert(bytes(JSON.stringify(page)) <= 512);
			for (const e of page.entries) { assert(e.key.startsWith(prefix)); assert(after === null || e.key > after); found.push(e.key); }
			assert(page.after === null || (page.entries.length === 1 && page.after === page.entries[0].key)); after = page.after;
		} while (after !== null);
		assert.deepEqual(found, keys.filter(k => k.startsWith(prefix) && (start === null || k > start)).sort(), canonical({ prefix, start }));
	}
};
cases.indexBounds = async () => {
	const s = await initialized(), variant = workerData.extra.variant;
	if (variant === "get") await rejects(s.index.get(Array.from({ length: PAGE.maxRows + 1 }, (_, i) => "fixture:" + i), PAGE));
	else if (variant === "scan") await rejects(s.index.scan("r:", null, { maxRows: PAGE.maxRows + 1, maxBytes: PAGE.maxBytes }));
	else if (variant === "write") await rejects(s.index.write(Array.from({ length: PAGE.maxRows + 1 }, (_, i) => ({ key: "fixture:" + i, value: { kind: "node", identity: "fixture", component: "fixture" } })), PAGE));
	else if (variant === "bytes") await rejects(s.index.write([{ key: "fixture:large", value: { kind: "node", identity: "x".repeat(PAGE.maxBytes), component: "fixture" } }], PAGE));
	else await rejects(s.index.scan("r:", null, { maxRows: 0, maxBytes: PAGE.maxBytes }));
	assert.equal(journal().length, 0);
};
cases.indexCorruption = async () => {
	const s = await initialized(), prefix = await committed(s);
	await s.index.write(["r:a", "r:m", "r:z"].map(key => ({ key, value: { kind: "node", identity: key, component: "fixture-component" } })), PAGE);
	await s.checkpoint(canonical(prefix) + "\n");
	// Warm both a hit and a negative path first: a cached clean answer is not permission to mask disk damage.
	assert.equal((await s.index.get(["r:m"], PAGE)).length, 1); assert.deepEqual(await s.index.get(["r:absent"], PAGE), []);
	const before = journal(), name = workerData.extra.file, contents = read(name);
	assert(contents.length > 0);
	if (workerData.extra.kind === "truncate") put(name, contents.subarray(0, Math.floor(contents.length / 2)));
	else {
		const changed = Buffer.from(contents), start = workerData.extra.kind === "payload" ? 96 : 0;
		for (let at = start; at < changed.length; at++) changed[at] ^= 0xff;
		put(name, changed);
	}
	const operation = workerData.extra.lookup === "scan" ? s.index.scan("r:", "r:m", PAGE)
		: s.index.get([workerData.extra.lookup === "hit" ? "r:m" : "r:absent"], PAGE);
	await rejects(operation, "index-unavailable"); assert.deepEqual(journal(), before);
	await close(s); const reopened = await open(); const c = await collector(reopened);
	// The derived cache may be rebuilt, but the numeric journal is never discarded as an index repair.
	assert.deepEqual(journal(), before); assert.equal(c.checkpoint().sequence, prefix.sequence);
};
cases.capacity = async () => {
	const variant = workerData.extra.variant;
	if (variant === "options") {
		for (const limits of [{ indexEntries: 0 }, { indexBytes: Infinity }, { metadataBytes: 1.5 }, { journalBytes: METER_LIMITS.journalBytes + 1 }, { segments: METER_LIMITS.segments + 1 }])
			await rejects(UsageAccountingStore.open({ dataDir: dir, lease: workerData.lease, limits }), "store-capacity");
		assert(!existsSync(root())); return;
	}
	if (variant === "metadata") {
		const s = await open({ limits: { metadataBytes: 1 } }); assert.equal(s.status().state, "unavailable");
		assert.equal(s.status().code, "store-capacity"); assertFixed(s.status());
		assert(!existsSync(path("header.numeric"))); assert.equal(journal().length, 0); return;
	}
	if (variant === "native") {
		const s = await open({ limits: { metadataBytes: 512 } }); ready(s); const c = await collector(s);
		assert.equal((await collect(c, batch())).status, "committed");
		const p = s.committedPrefix(); assert(p); const before = journal(), checkpoint = read("checkpoint.numeric");
		await rejects(s.commitNative(nativeCursors(), p), "store-capacity");
		assert.deepEqual(journal(), before); assert.deepEqual(read("checkpoint.numeric"), checkpoint); assert(!existsSync(path("native.numeric"))); return;
	}
	if (variant === "oversized-segment") {
		const s = await initialized(); await close(s); const fd = openSync(path(journalName(1)), "wx", 0o600);
		try { ftruncateSync(fd, METER_LIMITS.segmentBytes + 1); fsyncSync(fd); } finally { closeSync(fd); }
		const r = await open(); await rejects(r.head(METER_LIMITS), "store-capacity");
		assert.equal(lstatSync(path(journalName(1))).size, METER_LIMITS.segmentBytes + 1); assert(r.metrics().maxReadBytes <= 1024); return;
	}
	if (variant === "index") {
		const s = await initialized({ limits: { indexEntries: 4 } });
		assert.equal(await s.index.reserve(3, 128), false); assert.equal(await s.index.reserve(2, 128), true);
		await s.index.write(["r:a", "r:b"].map(key => ({ key, value: { kind: "node", identity: key, component: "fixture" } })), PAGE);
		assert.equal(await s.index.reserve(1, 128), false); assert.equal(await s.index.reserve(METER_LIMITS.indexEntries + 1, 128), false);
		assert.equal(await s.index.reserve(1, METER_LIMITS.indexBytes + 1), false); assert.equal(journal().length, 0); return;
	}
	if (variant === "queue") {
		const s = await initialized(), result = await Promise.allSettled([s.index.scan("r:", null, PAGE), s.index.scan("r:", null, PAGE), s.index.scan("r:", null, PAGE)]);
		assert(result.some(r => r.status === "rejected" && r.reason.code === "store-capacity")); assert(s.metrics().maxOutstanding <= 2); return;
	}
	const length = bytes(line(1)), s = await initialized({ limits: variant === "segments" ? { segments: 1 } : { journalBytes: length + 1 } });
	const p = await committed(s), before = journal();
	await rejects(s.append(variant === "segments" ? 2 : 1, variant === "segments" ? 0 : p.end.offset, line(2)), "store-capacity");
	assert.deepEqual(journal(), before); assert.deepEqual(anchor(), p); assert(!existsSync(path(journalName(2))));
};
cases.aggregateMetadata = async () => {
	const total = () => readdirSync(root()).filter(n => !/^journal-\d{6}\.numeric$/.test(n) && !n.startsWith("index.") && lstatSync(path(n)).isFile())
		.reduce((n, name) => n + lstatSync(path(name)).size, 0);
	let { s, cp } = await seed(); await s.checkpoint(canonical(cp) + "\n"); await s.commitNative(nativeCursors(), cp);
	const nativeBytes = read("native.numeric").length;
	const limit = total() + 2 * nativeBytes + 256; await close(s);
	s = await open({ limits: { metadataBytes: limit } }); const c = await collector(s);
	assert.equal((await collect(c, batch())).status, "duplicate");
	const rebound = await s.nativeCheckpoint(); assert.equal(rebound.state, "available");
	for (let i = 0; i < 4; i++) {
		await s.checkpoint(canonical(cp) + "\n"); await s.commitNative(nativeCursors(), cp);
		assert.equal(s.metrics().metadataBytes, total()); assert(total() <= limit);
	}
	const candidate = structuredClone(rebound.checkpoint); assert(candidate);
	candidate.cursors = []; let envelopeBytes = 0;
	while (envelopeBytes <= nativeBytes * 2) {
		candidate.cursors.push({ kind: "feed", stream: "fixture-growing-native-" + candidate.cursors.length,
			readerEpoch: "fixture-epoch", token: "fixture-token-" + "t".repeat(64), state: "committed" });
		envelopeBytes = bytes(canonical({ v: "usage-store-native/1", checkpoint: candidate, sha256: sha(canonical(candidate)) }) + "\n");
	}
	assert(envelopeBytes < limit); assert(total() + envelopeBytes + read("native.numeric").length > limit);
	const before = journal(), checkpoint = read("checkpoint.numeric"), native = read("native.numeric");
	await rejects(s.commitNative(candidate.cursors, cp), "store-capacity");
	assert.deepEqual(journal(), before); assert.deepEqual(read("checkpoint.numeric"), checkpoint); assert.deepEqual(read("native.numeric"), native);
	assert.equal(s.metrics().metadataBytes, total()); assert(total() <= limit);
};
cases.paths = async () => {
	const kind = workerData.extra.kind;
	for (const name of ["header.numeric", "lock", journalName(1), "checkpoint.numeric", "native.numeric", "checkpoint.previous.numeric", "native.previous.numeric", "index.nodes", "index.values"]) {
		const data = child(kind + "-" + name), victim = join(data, "fixture-victim.numeric");
		let { s } = await seed(data); await close(s);
		writeFileSync(victim, "fixture-victim-unchanged\n", { mode: 0o600 }); const before = readFileSync(victim), stat = lstatSync(victim);
		rmSync(path(name, data), { force: true });
		if (kind === "symlink") symlinkSync(victim, path(name, data)); else linkSync(victim, path(name, data));
		s = await open({}, data);
		if (s.status().state === "ready") {
			await rejects(s.head(METER_LIMITS), "unsafe-path");
		} else assert.equal(s.status().state, "unavailable");
		assertFixed(s.status()); assert.equal(s.status().code, "unsafe-path");
		assert.deepEqual(readFileSync(victim), before); assert.equal(lstatSync(victim).ino, stat.ino);
		assert.equal(lstatSync(victim).mode & 0o777, 0o600); await close(s);
		assert.deepEqual(readFileSync(victim), before);
		assert(kind === "symlink" ? lstatSync(path(name, data)).isSymbolicLink() : lstatSync(path(name, data)).nlink === 2);
	}
};
cases.directoryPaths = async () => {
	const variant = workerData.extra.variant, real = child("fixture-real"), alias = join(dir, "fixture-alias");
	let data = real;
	if (variant === "parent-link") { symlinkSync(real, alias); data = alias; }
	else if (variant === "root-link") { mkdirSync(join(real, "fixture-target"), { mode: 0o700 }); symlinkSync(join(real, "fixture-target"), root(real)); }
	else if (variant === "parent-mode") chmodSync(real, 0o777);
	else { mkdirSync(root(real), { mode: 0o755 }); chmodSync(root(real), 0o755); }
	const before = readdirSync(real).sort(), s = await open({}, data);
	assert.equal(s.status().state, "unavailable"); assertFixed(s.status());
	assert.equal(s.status().code, variant.endsWith("mode") ? "permission-denied" : "io-failure");
	assert.deepEqual(readdirSync(real).sort(), before);
};
cases.fileMode = async () => {
	let { s } = await seed(); await close(s); const name = workerData.extra.name;
	chmodSync(path(name), 0o644); const before = read(name); s = await open();
	if (s.status().state === "ready") await rejects(s.head(METER_LIMITS), "permission-denied");
	assert.equal(s.status().code, "permission-denied"); assert.deepEqual(read(name), before); assert.equal(lstatSync(path(name)).mode & 0o777, 0o644);
};
cases.staleLock = async () => {
	let { s } = await seed(); await close(s); const before = journal();
	// Linux pid_max is at most 2^22; this synthetic lock cannot name a running process.
	put("lock", String(2 ** 22 + 1) + "\n");
	s = await open(); ready(s); assert.equal(read("lock").toString("utf8"), process.pid + "\n");
	const c = await collector(s); assert.equal((await collect(c, batch())).status, "duplicate"); assert.deepEqual(journal(), before);
	assert(!readdirSync(root()).some(n => /^lock\.(?:tmp|stale)-/.test(n)));
};
cases.writerLost = async () => {
	const { s, cp } = await seed(), before = journal(), lock = path("lock");
	const inode = lstatSync(lock).ino; writeFileSync(lock, "1\n"); assert.equal(lstatSync(lock).ino, inode);
	assert.equal(s.status().state, "unavailable"); assert.equal(s.status().code, "writer-lost");
	await rejects(s.append(1, cp.end.offset, line(cp.sequence + 1)), "writer-lost");
	assert.deepEqual(journal(), before); await close(s); assert.equal(readFileSync(lock, "utf8"), "1\n");
};
cases.rootReplaced = async () => {
	const { s, cp } = await seed(), before = journal();
	renameSync(root(), join(dir, "fixture-former-root")); mkdirSync(root(), { mode: 0o700 });
	assert.equal(s.status().code, "unsafe-path"); await rejects(s.append(1, cp.end.offset, line(2)), "unsafe-path");
	assert.deepEqual(readdirSync(root()), []);
	assert.deepEqual(readFileSync(join(dir, "fixture-former-root", journalName(1))), before[0]);
};
cases.checkpointLinkRace = async () => {
	const victim = join(dir, "fixture-victim.numeric"), untouched = Buffer.from("fixture-never-truncate\n"); writeFileSync(victim, untouched, { mode: 0o600 });
	let armed = false;
	const s = await initialized({ fault: (point: string) => {
		if (armed && point === "checkpoint-write") { rmSync(path("checkpoint.numeric")); linkSync(victim, path("checkpoint.numeric")); }
	} }); const cp = await committed(s), before = journal(); armed = true;
	const text = line(2), p = next(cp, text); await s.append(1, cp.end.offset, text); await s.sync(1);
	await rejects(s.checkpoint(canonical(p) + "\n"), "unsafe-path");
	assert.deepEqual(readFileSync(victim), untouched); assert.equal(lstatSync(victim).nlink, 2);
	assert(read(journalName(1)).subarray(0, before[0].length).equals(before[0]));
};
cases.scratchSwap = async () => {
	const victim = join(dir, "fixture-scratch-victim.numeric"), untouched = Buffer.from("fixture-victim-stays-numeric\n");
	writeFileSync(victim, untouched, { mode: 0o600 }); let armed = false, hits = 0;
	const point = workerData.extra.point, name = point === "native-write" ? "native.numeric" : "checkpoint.numeric";
	const s = await open({ fault: (at: string) => {
		if (!armed || at !== point) return; armed = false; hits++;
		const names = readdirSync(root()).filter(n => n.startsWith(name + ".next-")); assert.equal(names.length, 1);
		rmSync(path(names[0]));
		if (workerData.extra.kind === "symlink") symlinkSync(victim, path(names[0])); else linkSync(victim, path(names[0]));
	} }); ready(s); const c = await collector(s); assert.equal((await collect(c, batch())).status, "committed");
	const cp = s.committedPrefix(); assert(cp); await s.commitNative(nativeCursors(), cp);
	const prior = read(name), native = read("native.numeric"); let durableBytes = journal();
	if (point === "checkpoint-rename") {
		const text = line(cp.sequence + 1), p = next(cp, text);
		await s.append(p.end.segment, cp.end.offset, text); await s.sync(p.end.segment); durableBytes = journal(); armed = true;
		await rejects(s.checkpoint(canonical(p) + "\n"), "unsafe-path");
	} else {
		const updated = nativeCursors(); updated[0].token = "fixture-new-native-never-published"; armed = true;
		await rejects(s.commitNative(updated, cp), "unsafe-path");
	}
	assert.equal(hits, 1); assert.deepEqual(journal(), durableBytes); assert.deepEqual(s.committedPrefix(), cp);
	assert.deepEqual(read(name), prior); assert(lstatSync(path(name)).isFile()); assert.equal(lstatSync(path(name)).nlink, 1);
	const nativePreserved = read("native.numeric").equals(native) || readdirSync(root())
		.filter(n => /^evidence-native-[a-f0-9]{64}\.numeric$/.test(n)).some(n => read(n).equals(native));
	assert(nativePreserved); assert.deepEqual(readFileSync(victim), untouched); assert.equal(lstatSync(victim).mode & 0o777, 0o600);
};
cases.checkpointPublicationRace = async () => {
	const victim = join(dir, "fixture-final-sync-victim.numeric"), untouched = Buffer.from("fixture-do-not-publish-or-truncate\n");
	writeFileSync(victim, untouched, { mode: 0o600 }); let armed = false, hits = 0;
	const point = workerData.extra.point, s = await open({ fault: (at: string) => {
		if (!armed || at !== point) return; armed = false; hits++;
		if (point === "after-checkpoint-rename") writeFileSync(path("lock"), "1\n");
		else {
			rmSync(path("checkpoint.numeric"));
			if (workerData.extra.kind === "symlink") symlinkSync(victim, path("checkpoint.numeric")); else linkSync(victim, path("checkpoint.numeric"));
		}
	} }); ready(s); const c = await collector(s); assert.equal((await collect(c, batch())).status, "committed");
	const p = s.committedPrefix(); assert(p); await s.commitNative(nativeCursors(), p);
	const previous = read("checkpoint.numeric"), first = read(journalName(1)), native = read("native.numeric"), text = line(p.sequence + 1), nextPrefix = next(p, text);
	await s.append(nextPrefix.end.segment, p.end.offset, text); await s.sync(nextPrefix.end.segment); const retained = journal(); armed = true;
	await rejects(s.checkpoint(canonical(nextPrefix) + "\n"), point === "after-checkpoint-rename" ? "writer-lost" : "unsafe-path");
	assert.equal(hits, 1); assert.deepEqual(s.committedPrefix(), p); assert.deepEqual(journal(), retained);
	assert(read(journalName(1)).subarray(0, first.length).equals(first)); assert.deepEqual(read("checkpoint.previous.numeric"), previous);
	assert.deepEqual(read("native.numeric"), native); assert.deepEqual(readFileSync(victim), untouched);
	await close(s); if (point === "after-checkpoint-rename") assert.equal(read("lock").toString("utf8"), "1\n");
};
cases.restoreAlarms = async () => {
	let { s, c } = await seed(); assert.equal((await collect(c, batch(2))).status, "committed");
	assert.equal((await s.nativeCheckpoint()).state, "unavailable");
	const receipt = read("fault-native-unavailable.numeric"), retained = journal(), native = read("native.numeric");
	assert.equal(receipt.toString("utf8"), canonical({ v: "usage-store-fault/1", code: "native-unavailable" }) + "\n");
	await close(s); s = await open(); c = await collector(s); assertFixed(s.status());
	assert(s.status().alarms.some(a => a.code === "native-unavailable" && a.count === 1));
	assert.equal((await s.nativeCheckpoint()).state, "unavailable"); assert.deepEqual(read("fault-native-unavailable.numeric"), receipt);
	assert.equal((await collect(c, batch(2))).status, "duplicate"); assert.deepEqual(journal(), retained); assert.deepEqual(read("native.numeric"), native);
	await close(s);
	const altered = workerData.extra.variant === "parse" ? "{fixture-torn-receipt"
		: canonical({ v: "usage-store-fault/1", code: workerData.extra.variant === "code" ? "writer-lost" : "native-unavailable",
			...(workerData.extra.variant === "extra" ? { extra: "fixture-not-a-fixed-receipt" } : {}) }) + "\n";
	put("fault-native-unavailable.numeric", altered); s = await open(); await rejects(s.head(METER_LIMITS), "io-failure");
	assert.equal(read("fault-native-unavailable.numeric").toString("utf8"), altered); assert.deepEqual(journal(), retained); assert.deepEqual(read("native.numeric"), native);
};
cases.yieldOwnership = async () => {
	const { s } = await seed(), before = journal(), cp = read("checkpoint.numeric"), native = read("native.numeric");
	const originalYield = s.yield.bind(s); let armed = true, hits = 0;
	s.yield = async () => {
		if (armed) { armed = false; setImmediate(() => {
			hits++;
			if (workerData.extra.variant === "lease") Atomics.store(new Int32Array(workerData.lease), 0, 2);
			else { renameSync(root(), join(dir, "fixture-yield-former-root")); mkdirSync(root(), { mode: 0o700 }); }
		}); }
		await originalYield(); // Keep the actual production pause AND its post-yield ownership check.
	};
	await rejects(s.index.scan("r:", null, PAGE), workerData.extra.variant === "lease" ? "writer-lost" : "unsafe-path");
	assert.equal(hits, 1); assertFixed(s.status());
	if (workerData.extra.variant === "lease") {
		assert.deepEqual(journal(), before); assert.deepEqual(read("checkpoint.numeric"), cp); assert.deepEqual(read("native.numeric"), native);
		await close(s); assert.equal(Atomics.load(new Int32Array(workerData.lease), 0), 2);
	} else {
		assert.deepEqual(readdirSync(root()), []);
		assert.deepEqual(readFileSync(join(dir, "fixture-yield-former-root", journalName(1))), before[0]);
		assert.deepEqual(readFileSync(join(dir, "fixture-yield-former-root", "checkpoint.numeric")), cp);
	}
};
cases.version = async () => {
	const { s } = await seed(); await close(s);
	const h = JSON.parse(read("header.numeric").toString("utf8")), variant = workerData.extra.variant;
	if (variant === "newer") h.major = 2;
	else if (variant === "minor") h.minor = 1;
	else if (variant === "older") h.major = 0;
	else if (variant === "generation") h.generation = "not-a-generation";
	else h.extra = "fixture-unrecognized";
	put("header.numeric", variant === "parse" ? "{fixture-torn-header" : canonical(h) + "\n");
	// A dead-pid lock must not be moved before rejecting an incompatible header.
	put("lock", String(2 ** 22 + 1) + "\n"); const before = snapshot(), lock = read("lock");
	const denied = await open(); assert.equal(denied.status().state, "unavailable");
	assert.equal(denied.status().code, variant === "newer" ? "newer-store-major" : "store-version");
	assert.deepEqual(snapshot(), before); assert.deepEqual(read("lock"), lock); await close(denied); assert.deepEqual(read("lock"), lock);
};
cases.migration = async () => {
	const { s, cp } = await seed(), files = readdirSync(root()).filter(n => n !== "lock" && !n.startsWith("lock.") && !n.startsWith("index.")).sort();
	const expected = new Map(files.map(n => [n, read(n)])), before = journal();
	const receipt = await s.prepareMigration(); assert.equal(receipt.v, "usage-store-compatible-copy/1"); assert.equal(receipt.storeMajor, 1);
	assert.equal(receipt.files, files.length); assert.equal(receipt.bytes, [...expected.values()].reduce((n, b) => n + b.length, 0));
	assert.equal(receipt.generation, JSON.parse(read("header.numeric").toString("utf8")).generation);
	const copy = join(root(), "compatible-1"); assert.equal(lstatSync(copy).mode & 0o777, 0o700);
	assert.deepEqual(readdirSync(copy).sort(), [...files, "copy.numeric"].sort());
	for (const name of files) {
		const target = join(copy, name); assert.deepEqual(readFileSync(target), expected.get(name));
		assert.equal(lstatSync(target).mode & 0o777, 0o600); assert.equal(lstatSync(target).nlink, 1);
		assert.notEqual(lstatSync(target).ino, lstatSync(path(name)).ino);
	}
	assert.deepEqual(JSON.parse(readFileSync(join(copy, "copy.numeric"), "utf8")), receipt);
	assert.equal(s.status().code, "migration-prepared"); await rejects(s.append(1, cp.end.offset, line(2)), "migration-prepared"); assert.deepEqual(journal(), before);
	await close(s);
	// Restoring the copy as v1 is supported; this is not permission to migrate/downgrade a newer live header.
	const restoredDir = child("fixture-restored-copy"); mkdirSync(root(restoredDir), { mode: 0o700 });
	for (const name of readdirSync(copy)) put(name, readFileSync(join(copy, name)), restoredDir);
	const restored = await open({}, restoredDir, new SharedArrayBuffer(4)); ready(restored);
	const restoredCollector = await collector(restored);
	assert.equal((await collect(restoredCollector, batch())).status, "duplicate"); assert.equal((await fold(restoredCollector)).facts, 1);
	assert.deepEqual((await restored.nativeCheckpoint()).checkpoint?.cursors, nativeCursors()); await close(restored);
	const reopened = await open(); ready(reopened); await collector(reopened);
	const backup = files.map(n => readFileSync(join(copy, n)));
	await rejects(reopened.prepareMigration(), "io-failure");
	assert.deepEqual(files.map(n => readFileSync(join(copy, n))), backup); await close(reopened);
	const header = JSON.parse(read("header.numeric").toString("utf8")); header.major = 2; put("header.numeric", canonical(header) + "\n");
	const current = snapshot(), oldReader = await open(); assert.equal(oldReader.status().code, "newer-store-major");
	assert.deepEqual(snapshot(), current); assert.deepEqual(files.map(n => readFileSync(join(copy, n))), backup);
	assert.equal(JSON.parse(readFileSync(join(copy, "header.numeric"), "utf8")).major, 1);
};
cases.migrationLink = async () => {
	const { s } = await seed(), outside = child("fixture-copy-victim");
	writeFileSync(join(outside, "keep.numeric"), "fixture-do-not-overwrite", { mode: 0o600 });
	symlinkSync(outside, path("compatible-1")); const before = journal();
	await rejects(s.prepareMigration(), "io-failure"); assert.deepEqual(journal(), before);
	assert.deepEqual(readdirSync(outside), ["keep.numeric"]); assert.equal(readFileSync(join(outside, "keep.numeric"), "utf8"), "fixture-do-not-overwrite");
};
cases.migrationCreateFailure = async () => {
	const { s } = await seed(), originalFile = s.file.bind(s), before = journal(), cp = read("checkpoint.numeric"), native = read("native.numeric");
	let injected = false, sourceFd = -1, destination = "", opened: { name: string; fd: number } | null = null;
	s.file = (name: string, create = false, at?: number) => {
		if (create && at !== undefined && !injected) {
			injected = true; assert.equal(opened?.name, name); sourceFd = opened!.fd; destination = name;
			writeFileSync(join(root(), "compatible-1", name), "fixture-existing-exclusive-destination", { mode: 0o600, flag: "wx" });
		}
		const f = originalFile(name, create, at);
		if (!create && at === undefined) opened = { name, fd: f.fd };
		return f;
	};
	await rejects(s.prepareMigration(), "io-failure"); assert(injected && sourceFd >= 0);
	assert.throws(() => fstatSync(sourceFd), (e: any) => e.code === "EBADF");
	assert.equal(readFileSync(join(root(), "compatible-1", destination), "utf8"), "fixture-existing-exclusive-destination");
	assert(!existsSync(join(root(), "compatible-1", "copy.numeric")));
	assert.deepEqual(journal(), before); assert.deepEqual(read("checkpoint.numeric"), cp); assert.deepEqual(read("native.numeric"), native);
	await close(s); const reopened = await open(); const c = await collector(reopened);
	assert.equal((await collect(c, batch())).status, "duplicate"); assert.equal((await fold(c)).facts, 1);
};
cases.large = async () => {
	const started = performance.now(), sourceCount = 65, attempts = 100_000, phase = workerData.extra.phase;
	assert(phase === "ingest" || phase === "replay");
	const progress = (stage: string, store?: UsageAccountingStore) => process.stdout.write("W1-MEASURE-PROGRESS " +
		JSON.stringify({ phase, stage, elapsedMs: performance.now() - started, metrics: store?.metrics() }) + "\n");
	let peakHeap = 0, peakRss = 0, maxBatchRows = 0, maxBatchBytes = 0;
	const sample = () => { const m = process.memoryUsage(); peakHeap = Math.max(peakHeap, m.heapUsed); peakRss = Math.max(peakRss, m.rss); };
	const timer = setInterval(sample, 20); sample();
	const envelope = (s: UsageAccountingStore, c: any) => {
		sample(); assert(peakHeap > 0 && peakHeap <= METER_LIMITS.acceptedHeapBytes);
		assert(peakRss > 0 && peakRss <= METER_LIMITS.acceptedProcessRssBytes);
		const m = s.metrics(), cm = c.metrics(); assert(cm.yields > 0); assert(cm.maxActiveMs <= METER_LIMITS.unitWorkMs);
		assert(m.maxReadBytes <= METER_LIMITS.pageBytes); assert(m.maxStagingBytes <= METER_LIMITS.stagingBytes); assert(m.maxOutstanding <= 2);
		assert(m.journalBytes <= METER_LIMITS.journalBytes); assert(m.index.maxCacheBytes <= METER_LIMITS.indexCacheBytes);
		assert(m.index.maxWorkMs <= METER_LIMITS.unitWorkMs); assert(m.index.maxWorkNodes <= 256);
		assert(m.index.entries <= METER_LIMITS.indexEntries); assert(m.index.allocatedBytes <= METER_LIMITS.indexBytes);
		assert(lstatSync(path("index.nodes")).size + lstatSync(path("index.values")).size <= METER_LIMITS.indexBytes);
		assert(performance.now() - started < 240_000, "W1 individual durable stage deadline");
	};
	try {
		if (phase === "ingest") {
			const ordinals = Array<number>(sourceCount).fill(0); let generated = 0;
			// H-WIRE-1d: the same disk-prepared, bounded synthetic source layout as W0. Preparation is charged.
			for (let source = 0; source < sourceCount; source++) {
				const fd = openSync(join(dir, "native-" + source + ".synthetic"), "wx", 0o600);
				try {
					let facts: any[] = [];
					const flush = () => {
						if (!facts.length) return;
						const text = JSON.stringify(batch(++ordinals[source], facts, source));
						maxBatchRows = Math.max(maxBatchRows, facts.length); maxBatchBytes = Math.max(maxBatchBytes, bytes(text));
						assert(facts.length <= 128 && facts.length <= PAGE.maxRows && bytes(text) <= PAGE.maxBytes);
						writeFileSync(fd, text + "\n"); facts = []; sample();
					};
					for (let i = source; i < attempts; i += sourceCount) {
						facts.push(fact(i, source)); generated++;
						if (facts.length === 128) { flush(); await pause(); }
					}
					flush();
				} finally { closeSync(fd); }
			}
			assert.equal(generated, attempts); sample(); const preparationMs = performance.now() - started; progress("prepared");
			async function* nativePages(source: number): AsyncGenerator<string> {
				const fd = openSync(join(dir, "native-" + source + ".synthetic"), "r"), page = Buffer.allocUnsafe(PAGE.maxBytes);
				let offset = 0, carry = Buffer.alloc(0);
				try {
					for (;;) {
						const count = readSync(fd, page, 0, page.length, offset); if (!count) break;
						offset += count; const input = Buffer.concat([carry, page.subarray(0, count)]);
						assert(input.length <= METER_LIMITS.stagingBytes); let start = 0, end: number;
						while ((end = input.indexOf(10, start)) >= 0) {
							assert(end - start <= PAGE.maxBytes); yield input.subarray(start, end).toString("utf8"); start = end + 1;
						}
						carry = Buffer.from(input.subarray(start)); assert(carry.length <= PAGE.maxBytes); sample(); await pause();
					}
					assert.equal(carry.length, 0, "synthetic input must end with a complete line");
				} finally { closeSync(fd); }
			}
			const ingestionStart = performance.now(), s = await open(); ready(s); const c = await collector(s, inventory(sourceCount));
			for (let source = 0; source < sourceCount; source++) {
				let ordinal = 0;
				for await (const text of nativePages(source)) {
					ordinal++; const r = await c.collect("fixture-native-" + source, text, AT);
					assert.equal(r.status, "committed", "production-index ingestion: " + JSON.stringify({ code: r.code, source, ordinal, generated,
						store: s.status(), metrics: s.metrics(), collector: c.metrics() })); sample();
				}
				assert.equal(ordinal, ordinals[source]);
				if (source % 8 === 7 || source === sourceCount - 1) progress("ingest-" + source, s);
			}
			const ingestionMs = performance.now() - ingestionStart, before = c.checkpoint();
			assert.equal(before.sequence, 845); assert.equal(before.cursors.length, sourceCount);
			for (const cursor of before.cursors) {
				const source = Number(cursor.stream.slice("fixture-native-".length)); assert(source >= 0 && source < sourceCount);
				assert.equal(cursor.incarnation, "fixture-native-incarnation"); assert.equal(cursor.cursor.ordinal, ordinals[source]);
				assert.equal(cursor.cursor.token, "fixture-only:opaque-" + source + "-" + (ordinals[source] * 17 + 11));
			}
			assert(c.metrics().journalBytes > 16 * 1024 * 1024); progress("ingested", s); envelope(s, c);
			const initialStore = s.metrics(); await close(s); sample();
			return { phase, attempts, sources: sourceCount, before, preparationMs, ingestionMs, totalMs: performance.now() - started,
				peakHeap, peakRss, maxBatchRows, maxBatchBytes, initialStore };
		}
		// H-WIRE-1f: a fresh Worker opens only durable evidence; no live collector or cache crosses the boundary.
		const replayStart = performance.now(), s = await open(); ready(s); const c = await collector(s, inventory(sourceCount));
		assert.deepEqual(c.checkpoint(), workerData.extra.before); progress("replayed", s);
		const replayed = await fold(c), replayMs = performance.now() - replayStart; progress("folded", s);
		assert.equal(replayed.facts, attempts); assert.equal(replayed.units, "4333390000033333"); envelope(s, c);
		const replayStore = s.metrics(), warm = performance.now();
		const update = batch(Math.ceil(Math.ceil(attempts / sourceCount) / 128) + 1, [fact(attempts)], 0);
		assert.equal((await collect(c, update)).status, "committed"); const published = await fold(c);
		const warmMs = performance.now() - warm; sample();
		assert.equal(published.facts, attempts + 1); assert.equal(published.units, "4333390000033334"); assert(published.pages > 390);
		const sequence = c.checkpoint().sequence; assert.equal((await collect(c, update)).status, "duplicate"); assert.equal(c.checkpoint().sequence, sequence);
		assert(warmMs < 30_000, "W0 uninterrupted warm update/publication deadline"); envelope(s, c);
		return { phase, attempts, sources: sourceCount, replayMs, warmMs, totalMs: performance.now() - started,
			peakHeap, peakRss, replayed, published, replayStore, updatedStore: s.metrics() };
	} finally { clearInterval(timer); }
};

async function main() {
	if (workerData.caseName === "hold") {
		const s = await open();
		parentPort!.on("message", async command => {
			if (command === "close") { await close(s); parentPort!.postMessage({ kind: "closed" }); parentPort!.close(); }
		});
		parentPort!.postMessage({ kind: "result", value: s.status() }); return;
	}
	let result: unknown;
	try { assert(cases[workerData.caseName], "known worker scenario"); result = await cases[workerData.caseName](); }
	finally { for (const s of stores) await s.close(); stores.clear(); }
	parentPort!.postMessage({ kind: "result", value: result ?? "ok" }); parentPort!.close();
}
main().catch(error => {
	parentPort!.postMessage({ kind: "failure", code: String(error?.stack ?? error).slice(0, 3000) }); parentPort!.close();
});
`;

let bundle: Promise<string> | undefined;
function bundledWorker(): Promise<string> {
	return (bundle ??= (async () => {
		let contents = workerFixture;
		for (const [marker, module] of [
			["__STORE__", "usage-accounting-store"],
			["__COLLECTOR__", "usage-accounting-collector"],
			["__CONTRACT__", "usage-accounting-contract"],
			["__METER__", "usage-accounting-meter-contract"],
		]) {
			contents = contents.replace(
				JSON.stringify(marker),
				JSON.stringify(fileURLToPath(new URL(`../../server/${module}.ts`, import.meta.url))),
			);
		}
		const compiled = await build({
			stdin: {
				contents,
				loader: "ts",
				resolveDir: dirname(fileURLToPath(import.meta.url)),
				sourcefile: "usage-store-owned-fixture.ts",
			},
			bundle: true,
			platform: "node",
			target: "node22",
			format: "cjs",
			write: false,
			logLevel: "silent",
		});
		if (compiled.outputFiles?.length !== 1) throw new Error("usage-store-fixture-bundle");
		return compiled.outputFiles[0].text;
	})());
}
async function startCase(caseName: string, dir: string, lease: SharedArrayBuffer, extra: Record<string, unknown> = {}) {
	const worker = new Worker(await bundledWorker(), {
		eval: true,
		resourceLimits: { ...METER_WORKER_RESOURCE_LIMITS },
		workerData: { caseName, dir, lease, extra },
	});
	workers.add(worker);
	const result = new Promise<unknown>((done, fail) => {
		let settled = false;
		worker.once("error", fail);
		worker.once("message", (message) => {
			settled = true;
			if (message?.kind === "result") done(message.value);
			else fail(new Error(String(message?.code ?? "usage-store-fixture-message")));
		});
		worker.once("exit", (code) => {
			if (!settled) fail(new Error(`usage-store-fixture-exit:${code}`));
		});
	});
	return { worker, result };
}
async function runCase(caseName: string, extra: Record<string, unknown> = {}): Promise<unknown> {
	const { result } = await startCase(caseName, fixtureDir(), new SharedArrayBuffer(4), extra);
	return result;
}
async function releaseHolder(worker: Worker): Promise<void> {
	const closed = new Promise<void>((done, fail) => {
		worker.once("error", fail);
		worker.once("message", (message) =>
			message?.kind === "closed" ? done() : fail(new Error("usage-store-holder-close")),
		);
	});
	worker.postMessage("close");
	await closed;
}

describe("usage-accounting-store worker ownership and durable prefix", () => {
	it("refuses main-thread open without creating a directory or consuming the lease", async () => {
		const { UsageAccountingStore } = await import("../../server/usage-accounting-store.js");
		const dir = fixtureDir(),
			lease = new SharedArrayBuffer(4);
		const s = await UsageAccountingStore.open({ dataDir: dir, lease });
		try {
			expect(s.status()).toEqual({
				state: "unavailable",
				code: "worker-required",
				alarms: [{ code: "worker-required", count: 1 }],
			});
			expect(existsSync(join(dir, "usage-accounting"))).toBe(false);
			expect(Atomics.load(new Int32Array(lease), 0)).toBe(0);
		} finally {
			await s.close();
		}
	});
	it("creates one stable private numeric generation and releases ownership only on close", async () => {
		expect(await runCase("lifecycle")).toBe("ok");
	});
	it("rejects malformed lifetime lease cells before touching storage", async () => {
		expect(await runCase("invalidLease")).toBe("ok");
	});
	it("replays real W0 receipts exactly once and rebinds native metadata only after prefix proof", async () => {
		expect(await runCase("integration")).toBe("ok");
	});
	it.each(["unsynced", "sequence", "offset", "segment", "digest", "field"])(
		"never publishes a %s checkpoint beyond the synchronized prefix",
		async (variant) => {
			expect(await runCase("checkpointGuard", { variant })).toBe("ok");
		},
	);
	it("reassembles small read pages without changing bytes, order or prefix hash", async () => {
		expect(await runCase("pagedReads")).toBe("ok");
	});
	it.each(["unread", "partial", "unsynced", "one-sync"])(
		"will not append after an %s recovery prefix",
		async (variant) => {
			expect(await runCase("recoveryBarrier", { variant })).toBe("ok");
		},
	);
	it("replays and reuses an empty trailing segment without dropping the previous commit", async () => {
		expect(await runCase("emptyTrailingSegment")).toBe("ok");
	});
	it.each(["segment", "offset", "bound"])("rejects an invalid %s paged read", async (variant) => {
		expect(await runCase("badRead", { variant })).toBe("ok");
	});
	it("does not overwrite an externally changed journal length", async () => {
		expect(await runCase("appendCas")).toBe("ok");
	});
});

const crashPoints: UsageStorePoint[] = [
	"journal-write",
	"after-append",
	"journal-sync",
	"after-journal-sync",
	"checkpoint-write",
	"checkpoint-sync",
	"checkpoint-rename",
	"after-checkpoint-rename",
	"checkpoint-dir-sync",
	"index-write",
	"index-sync",
	"native-write",
];
describe("usage-accounting-store deterministic commit failure boundaries", () => {
	it.each(crashPoints)(
		"preserves prefix/evidence and retries exactly once after %s",
		async (point) => {
			expect(await runCase("fault", { point })).toBe("ok");
		},
		30_000,
	);
	it.each(["journal-write", "checkpoint-write", "index-write", "native-write"] satisfies UsageStorePoint[])(
		"does not promote a short %s into a commit",
		async (point) => {
			expect(await runCase("fault", { point, short: true })).toBe("ok");
		},
		30_000,
	);
	it("preserves committed evidence when reopening itself fails", async () => {
		expect(await runCase("reopenFault")).toBe("ok");
	});
});

describe("usage-accounting-store native/checkpoint/journal corruption", () => {
	it.each(["ahead", "stale"])(
		"retains native token bytes but never exposes an %s native prefix as available",
		async (variant) => {
			expect(await runCase("nativeGuard", { variant })).toBe("ok");
		},
	);
	it("reads and publishes native metadata larger than one page while preserving all opaque/quarantined tokens", async () => {
		expect(await runCase("largeNative")).toBe("ok");
	});
	it.each(["checksum", "generation", "ahead", "index", "torn"])(
		"quarantines a %s native sidecar without advancing a source",
		async (variant) => {
			expect(await runCase("corruptNative", { variant })).toBe("ok");
		},
	);
	it.each(["throw", "short"])(
		"retains a valid native previous cache and corrupt primary evidence after a %s native write failure",
		async (variant) => {
			expect(await runCase("untrustedNativeWrite", { variant })).toBe("ok");
		},
	);
	it.each(["parse", "ahead", "digest"])(
		"keeps %s checkpoint evidence and replays the journal conservatively",
		async (variant) => {
			expect(await runCase("corruptCheckpoint", { variant })).toBe("ok");
		},
	);
	it.each(["missing-checkpoint", "complete-suffix"])(
		"keeps %s evidence UNKNOWN until a new durable fault publication",
		async (variant) => {
			expect(await runCase("unanchored", { variant })).toBe("ok");
		},
	);
	it.each(["tail", "utf8", "duplicate", "sequence-gap", "noncanonical", "missing", "reordered", "json"])(
		"never reports a healthy/zero recovery after %s journal damage",
		async (variant) => {
			expect(await runCase("journalCorruption", { variant })).toBe("ok");
		},
	);
});

describe("usage-accounting-store retained fixed alarms", () => {
	it.each(["code", "extra", "parse"])(
		"reloads valid alarms exactly once and refuses a %s receipt without rewriting it",
		async (variant) => {
			expect(await runCase("restoreAlarms", { variant })).toBe("ok");
		},
	);
});

describe("usage-accounting-store production numeric index", () => {
	it("uses binary prefix order, exclusive continuations, bounded pages, updates, tombstones and genuine negative lookups", async () => {
		expect(await runCase("indexOrder")).toBe("ok");
	});
	it("coalesces derived writes while charging every slot to the 256-node work quantum", async () => {
		expect(await runCase("coalescedFlush")).toBe("ok");
	});
	it("trims node writes to dirty spans, skips fully dirty reads and preserves gaps and outside bytes", async () => {
		expect(await runCase("trimmedFlush")).toBe("ok");
	});
	it.each(["order", "near-bytes", "transient", "bytes", "short", "ownership"])(
		"batches payload bytes without changing %s ordering, capacity or checked-write behavior",
		async (variant) => {
			expect(await runCase("payloadPage", { variant })).toBe("ok");
		},
	);
	it("authenticates skipped-bit lower bounds for aa/ab, nonexistent 9zzzz and empty/prefix keys", async () => {
		expect(await runCase("indexLowerBound")).toBe("ok");
	});
	it.each(["get", "scan", "write", "bytes", "zero"])(
		"rejects an oversized or invalid %s index operation",
		async (variant) => {
			expect(await runCase("indexBounds", { variant })).toBe("ok");
		},
	);
	for (const file of ["index.nodes", "index.values"]) {
		for (const kind of file === "index.values" ? ["truncate", "checksum", "payload"] : ["truncate", "checksum"]) {
			it.each(["hit", "negative", "scan"])(
				`throws instead of trusting a cached %s after ${file} ${kind}`,
				async (lookup) => {
					expect(await runCase("indexCorruption", { file, kind, lookup })).toBe("ok");
				},
			);
		}
	}
	it("charges aggregate metadata across successful native/checkpoint replacements before admitting any next replacement", async () => {
		expect(await runCase("aggregateMetadata")).toBe("ok");
	});
	it.each(["options", "metadata", "native", "oversized-segment", "index", "queue", "segments", "journal"])(
		"enforces the %s capacity without truncating authoritative bytes",
		async (variant) => {
			expect(await runCase("capacity", { variant })).toBe("ok");
		},
	);
});

describe("usage-accounting-store path confinement and lifetime locks", () => {
	it.each(["symlink", "hardlink"])(
		"refuses %s accounting artifacts without touching their targets",
		async (kind) => {
			expect(await runCase("paths", { kind })).toBe("ok");
		},
		30_000,
	);
	it.each(["parent-link", "root-link", "parent-mode", "root-mode"])(
		"refuses a %s directory without traversal or repair",
		async (variant) => {
			expect(await runCase("directoryPaths", { variant })).toBe("ok");
		},
	);
	it.each([
		"header.numeric",
		"checkpoint.numeric",
		"native.numeric",
		"index.nodes",
		"index.values",
		"journal-000001.numeric",
	])("does not chmod or silently trust a nonprivate %s", async (name) => {
		expect(await runCase("fileMode", { name })).toBe("ok");
	});
	it("reclaims only a provably dead pid's lock without removing numeric evidence", async () => {
		expect(await runCase("staleLock")).toBe("ok");
	});
	it("stops writing when a lock's pid changes inside the same inode and leaves the replacement lock alone", async () => {
		expect(await runCase("writerLost")).toBe("ok");
	});
	it("rejects replacement of the pinned accounting directory", async () => {
		expect(await runCase("rootReplaced")).toBe("ok");
	});
	it("does not truncate a hardlink inserted while a checkpoint scratch file is written", async () => {
		expect(await runCase("checkpointLinkRace")).toBe("ok");
	});
	for (const point of ["native-write", "checkpoint-rename"] satisfies UsageStorePoint[]) {
		it.each(["symlink", "hardlink"])(
			`will not publish a %s swapped into the scratch name at ${point}`,
			async (kind) => {
				expect(await runCase("scratchSwap", { point, kind })).toBe("ok");
			},
		);
	}
	it("keeps the exact prior checkpoint if ownership is lost after its replacement rename", async () => {
		expect(await runCase("checkpointPublicationRace", { point: "after-checkpoint-rename" })).toBe("ok");
	});
	it.each(["symlink", "hardlink"])(
		"rejects a %s primary swap at the final checkpoint-directory sync without an injected throw",
		async (kind) => {
			expect(await runCase("checkpointPublicationRace", { point: "checkpoint-dir-sync", kind })).toBe("ok");
		},
	);
	it.each(["root", "lease"])("rechecks %s ownership after a real cooperative yield", async (variant) => {
		expect(await runCase("yieldOwnership", { variant })).toBe("ok");
	});
	it("excludes both shared-lease and distinct-lease same-pid writers until the actual holder closes", async () => {
		const dir = fixtureDir(),
			lease = new SharedArrayBuffer(4),
			holder = await startCase("hold", dir, lease);
		expect(await holder.result).toMatchObject({ state: "ready", code: null });
		const before = readdirSync(join(dir, "usage-accounting")).sort();
		for (const cell of [lease, new SharedArrayBuffer(4)]) {
			const contender = await startCase("hold", dir, cell);
			expect(await contender.result).toMatchObject({
				state: "waiting-for-previous-writer",
				code: "waiting-for-previous-writer",
			});
			await releaseHolder(contender.worker);
		}
		expect(Atomics.load(new Int32Array(lease), 0)).toBe(1);
		expect(readdirSync(join(dir, "usage-accounting")).sort()).toEqual(before);
		await releaseHolder(holder.worker);
		expect(Atomics.load(new Int32Array(lease), 0)).toBe(0);
		const next = await startCase("hold", dir, lease);
		expect(await next.result).toMatchObject({ state: "ready", code: null });
		await releaseHolder(next.worker);
	});
	it("never clears an uncertain host lease or steals a same-pid lock after worker termination", async () => {
		const dir = fixtureDir(),
			lease = new SharedArrayBuffer(4),
			holder = await startCase("hold", dir, lease);
		expect(await holder.result).toMatchObject({ state: "ready" });
		await holder.worker.terminate();
		workers.delete(holder.worker);
		expect(Atomics.load(new Int32Array(lease), 0)).toBe(1);
		for (const cell of [lease, new SharedArrayBuffer(4)]) {
			const contender = await startCase("hold", dir, cell);
			expect(await contender.result).toMatchObject({ state: "waiting-for-previous-writer" });
			await releaseHolder(contender.worker);
		}
		expect(Atomics.load(new Int32Array(lease), 0)).toBe(1);
	});
});

describe("usage-accounting-store versions and compatible evidence copy", () => {
	it.each(["newer", "minor", "older", "generation", "extra", "parse"])(
		"refuses a %s header before moving even a stale lock",
		async (variant) => {
			expect(await runCase("version", { variant })).toBe("ok");
		},
	);
	it("makes a byte-exact exclusive compatible copy, seals the writer and never downgrades a newer live store", async () => {
		expect(await runCase("migration")).toBe("ok");
	});
	it("does not traverse an existing compatible-copy symlink", async () => {
		expect(await runCase("migrationLink")).toBe("ok");
	});
	it("closes the source descriptor when an exclusive migration destination creation fails", async () => {
		expect(await runCase("migrationCreateFailure")).toBe("ok");
	});
});

// Measurement-only diagnostic: never add four extra engine workers to the normal concurrent gate.
// W1_INDEX_PROFILE=1 selects matched isolated/loaded trials; the mandatory full-corpus proof below is unchanged.
describe("usage-accounting-store bounded index attribution", () => {
	it.skipIf(process.env.W1_INDEX_PROFILE !== "1").each([
		{ copies: 1, trial: 1 },
		{ copies: 1, trial: 2 },
		{ copies: 4, trial: 1 },
		{ copies: 4, trial: 2 },
	])(
		"profiles $copies independent synthetic stores, trial $trial",
		async ({ copies, trial }) => {
			const started = performance.now(),
				cpu = process.cpuUsage();
			const results = await Promise.all(Array.from({ length: copies }, () => runCase("indexProfile")));
			const used = process.cpuUsage(cpu);
			process.stdout.write(
				`W1-INDEX-PROFILE ${JSON.stringify({
					copies,
					trial,
					elapsedMs: performance.now() - started,
					cpuMs: (used.user + used.system) / 1000,
					results,
				})}\n`,
			);
			expect(results).toHaveLength(copies);
		},
		120_000,
	);
});

describe.skipIf(process.env.W1_LARGE_CASE !== "1")("usage-accounting-store real-index W0 resource envelope", () => {
	let largeDir = "",
		ingestElapsedMs = 0;
	let ingested: {
		before: unknown;
		attempts: number;
		sources: number;
		preparationMs: number;
		ingestionMs: number;
		totalMs: number;
		peakHeap: number;
		peakRss: number;
		maxBatchRows: number;
		maxBatchBytes: number;
	};
	beforeAll(async () => {
		// H-WIRE-1f: this shared synthetic corpus is not registered for per-case cleanup.
		const started = performance.now();
		largeDir = mkdtempSync(join(tmpdir(), "usage-accounting-store-large-"));
		const { worker, result } = await startCase("large", largeDir, new SharedArrayBuffer(4), { phase: "ingest" });
		try {
			expect(worker.resourceLimits).toMatchObject(METER_WORKER_RESOURCE_LIMITS);
			ingested = (await result) as typeof ingested;
			expect(ingested.attempts).toBe(100_000);
			expect(ingested.sources).toBe(65);
			expect(ingested.totalMs).toBeLessThan(240_000);
			expect(ingested.peakHeap).toBeLessThanOrEqual(METER_LIMITS.acceptedHeapBytes);
			expect(ingested.peakRss).toBeLessThanOrEqual(METER_LIMITS.acceptedProcessRssBytes);
			expect(ingested.maxBatchRows).toBeLessThanOrEqual(METER_LIMITS.pageRows);
			expect(ingested.maxBatchBytes).toBeLessThanOrEqual(METER_LIMITS.pageBytes);
			const measurement = { ...ingested, before: undefined };
			process.stdout.write(`W1-STORE-INGEST ${JSON.stringify(measurement)}\n`);
		} finally {
			await worker.terminate();
			workers.delete(worker);
		}
		ingestElapsedMs = performance.now() - started;
		expect(ingestElapsedMs).toBeLessThan(240_000);
	}, 240_000);
	afterAll(async () => {
		await Promise.all([...workers].map((worker) => worker.terminate()));
		workers.clear();
		if (largeDir) rmSync(largeDir, { recursive: true, force: true });
	});
	it("reopens the durable 100000-attempt corpus in a fresh worker and preserves unchanged W0 warm and resource bounds", async () => {
		const started = performance.now();
		const { worker, result } = await startCase("large", largeDir, new SharedArrayBuffer(4), {
			phase: "replay",
			before: ingested.before,
		});
		expect(worker.resourceLimits).toMatchObject(METER_WORKER_RESOURCE_LIMITS);
		const measured = (await result) as {
			attempts: number;
			sources: number;
			replayMs: number;
			warmMs: number;
			totalMs: number;
			peakHeap: number;
			peakRss: number;
			published: { facts: number; units: string; maxRows: number; maxBytes: number };
		};
		const replayElapsedMs = performance.now() - started,
			combinedMs = ingestElapsedMs + replayElapsedMs;
		process.stdout.write(
			`W1-STORE-MEASURE ${JSON.stringify({ ...measured, preparationMs: ingested.preparationMs, ingestionMs: ingested.ingestionMs, ingestElapsedMs, replayElapsedMs, combinedMs })}\n`,
		);
		expect(measured.attempts).toBe(100_000);
		expect(measured.sources).toBe(65);
		expect(measured.published.facts).toBe(100_001);
		expect(measured.published.units).toBe("4333390000033334");
		expect(measured.warmMs).toBeLessThan(30_000);
		expect(measured.totalMs).toBeLessThan(240_000);
		expect(replayElapsedMs).toBeLessThan(240_000);
		expect(combinedMs).toBeLessThan(480_000);
		expect(measured.peakHeap).toBeLessThanOrEqual(METER_LIMITS.acceptedHeapBytes);
		expect(measured.peakRss).toBeLessThanOrEqual(METER_LIMITS.acceptedProcessRssBytes);
		expect(measured.published.maxRows).toBeLessThanOrEqual(METER_LIMITS.pageRows);
		expect(measured.published.maxBytes).toBeLessThanOrEqual(METER_LIMITS.pageBytes);
	}, 240_000);
});
