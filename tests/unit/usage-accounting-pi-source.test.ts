import { createHash } from "node:crypto";
import {
	appendFileSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkTaskBinding, observeUsage, type AccountingInput } from "../../server/usage-accounting-contract.js";
import { MEMBERSHIP_LIMITS, taskMembershipAt } from "../../server/usage-accounting-membership.js";
import { METER_LIMITS } from "../../server/usage-accounting-meter-contract.js";
import {
	PI_RECORDED_RATE_VERSION,
	PI_SESSION_LIMITS,
	PiSessionUsageReader,
} from "../../server/usage-accounting-pi-sessions.js";
import {
	PI_SOURCE_LIMITS,
	PiSourceAdapter,
	projectPiSourceOccurrence,
	type PiCatalogEntry,
	type PiRequiredSource,
	type PiSourceCatalog,
	type PiSourceIndex,
	type PiSourceKind,
	type PiSourcePrefix,
	type PiSourceUnit,
} from "../../server/usage-accounting-pi-source.js";

// H-WIRE-3: committed native receipts, not process-local caches, must preserve identity and task birth.
// All files below are generated under our own temporary roots. No native/live inventory is consulted.
const FROM = "2026-10-19T07:00:00.000Z";
const THROUGH = "2026-10-19T09:00:00.000Z";
const OLD = "2026-09-01T08:00:00.000Z";
const SECRET = "SYNTHETIC_ONLY_PI_SOURCE_PAYLOAD_7deca2";
const dirs: string[] = [];
type CommitUnit = Parameters<PiSourceIndex["commit"]>[1];
type Rows = CommitUnit["rows"];
type NativeBatch = NonNullable<CommitUnit["native"]>;
type Cursor = NativeBatch["toCursor"];
type JsonRecord = Record<string, unknown>;

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const idFor = (file: string) => digest(file);
const at = (minute: number) => new Date(Date.parse(FROM) + minute * 60_000).toISOString();
const ms = (value: string) => Date.parse(value);
const pad = (value: number) => String(value).padStart(16, "0");
const clone = <T>(value: T): T => structuredClone(value);
const emptyRows = (): Rows => ({
	facts: [],
	aliases: [],
	allocations: [],
	roots: [],
	policies: [],
	memberships: [],
	snapshots: [],
});
const rowCount = (rows: Rows) => Object.values(rows).reduce((sum, values) => sum + values.length, 0);
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
function nativeFile(file: string, records: readonly unknown[]): void {
	writeFileSync(file, records.map(line).join(""));
}
function header(id: string, timestamp = FROM, parentSession?: string): JsonRecord {
	return {
		type: "session",
		version: 3,
		id,
		timestamp,
		...(parentSession ? { parentSession } : {}),
		cwd: SECRET,
	};
}
function call(
	id: string,
	timestamp = at(60),
	options: { response?: string; input?: number; amount?: number } = {},
): JsonRecord {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: {
			role: "assistant",
			provider: "fixture-provider",
			model: "fixture-model",
			...(options.response ? { responseId: options.response } : {}),
			usage: {
				input: options.input ?? 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: options.amount ?? 0.01 },
			},
			content: [{ type: "text", text: SECRET }],
			request: { systemPrompt: SECRET },
		},
	};
}
function op(name: string, id: number, timestamp: string, extra: JsonRecord = {}): JsonRecord {
	return {
		type: "custom",
		customType: "queue",
		data: { v: 1, op: name, id, ts: ms(timestamp), plan: { goal: SECRET }, summary: SECRET, ...extra },
	};
}
function registry(seq: number, name: string, timestamp: string, extra: JsonRecord = {}): JsonRecord {
	return { v: 1, seq, op: name, ts: ms(timestamp), goal: SECRET, ...extra };
}
function conversation(id: string, file: string, sessionId: string, timestamp: string): JsonRecord {
	return {
		v: "usage-ledger/1",
		conversationId: id,
		sessionId,
		sessionFile: file,
		persist: true,
		origin: "chat",
		parentConversationId: null,
		at: timestamp,
		occurredAt: timestamp,
		systemPrompt: SECRET,
		initialMessages: [SECRET],
	};
}

/** Reject payloads in EVERY durable lane, including native receipts and private index values. */
function assertPrivateProjection(value: unknown): void {
	const text = JSON.stringify(value);
	expect(text.includes(SECRET)).toBe(false);
	const forbidden = new Set([
		"content",
		"message",
		"messages",
		"prompt",
		"systemPrompt",
		"initialMessages",
		"request",
		"response",
		"tools",
		"toolResult",
		"result",
		"results",
		"title",
		"goal",
		"plan",
		"summary",
		"question",
		"cwd",
	]);
	const visit = (entry: unknown): void => {
		if (Array.isArray(entry)) {
			for (const item of entry) visit(item);
		} else if (entry !== null && typeof entry === "object") {
			for (const [key, item] of Object.entries(entry)) {
				// Occurrence.response is a response ID, not a response payload.
				if (key === "response") expect(item === null || (typeof item === "string" && item.length <= 256)).toBe(true);
				else expect(forbidden.has(key)).toBe(false);
				visit(item);
			}
		}
	};
	visit(value);
}

interface Snapshot {
	head: PiSourcePrefix;
	values: ReadonlyMap<string, string>;
	units: readonly CommitUnit[];
}
interface DurableImage {
	committed: Snapshot;
}
function durableImage(): DurableImage {
	return {
		committed: {
			head: {
				v: "pi-source-index/1",
				storeMajor: 1,
				sequence: 0,
				sha256: digest("synthetic-pi-source-genesis"),
				verified: true,
			},
			values: new Map(),
			units: [],
		},
	};
}
interface StoredSource {
	id: string;
	file: string;
	original: string;
	header: { id: string; timestamp: string; parentSession?: string } | null;
	reader: Cursor | null;
	anchor: { line: number; end: number } | null;
	scanDone: boolean;
	readDone: boolean;
	gaps: string[];
}

/** One committed-prefix view per open port; a new port reopens the same durable image.
 * Evidence and its exact native receipt are atomically accepted BEFORE cursors become visible.
 * A failed CAS changes nothing; an uncertain post-accept failure requires reopening the port. */
class PrefixIndex implements PiSourceIndex {
	private view: Snapshot;
	failNext: "before" | "after" | null = null;
	beforeGet: ((key: string) => void) | null = null;
	readonly scans: { prefix: string; after: string | null; rows: number; bytes: number }[] = [];
	readonly gets: { key: string; sequence: number }[] = [];
	readonly commits: { rows: number; bytes: number; native: boolean }[] = [];
	constructor(readonly image: DurableImage = durableImage()) {
		this.view = image.committed;
	}
	async head(): Promise<PiSourcePrefix> {
		return clone(this.view.head);
	}
	async get(key: string): Promise<string | null> {
		this.beforeGet?.(key);
		this.gets.push({ key, sequence: this.view.head.sequence });
		return this.view.values.get(key) ?? null;
	}
	async scan(prefix: string, after: string | null, limits: { bytes: number; rows: number }) {
		expect(limits.rows).toBeGreaterThan(0);
		expect(limits.rows).toBeLessThanOrEqual(PI_SOURCE_LIMITS.pageRows);
		expect(limits.bytes).toBeGreaterThan(0);
		expect(limits.bytes).toBeLessThanOrEqual(PI_SOURCE_LIMITS.pageBytes);
		const remaining = [...this.view.values]
			.filter(([key]) => key.startsWith(prefix) && (after === null || key > after))
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		const entries: { key: string; value: string }[] = [];
		for (const [key, value] of remaining) {
			const candidate = { entries: [...entries, { key, value }], next: key };
			if (entries.length === limits.rows || Buffer.byteLength(JSON.stringify(candidate)) > limits.bytes) break;
			entries.push({ key, value });
		}
		if (remaining.length && !entries.length) throw new Error("synthetic-index-entry-exceeds-page");
		const next = entries.length < remaining.length ? entries.at(-1)!.key : null;
		const bytes = Buffer.byteLength(JSON.stringify({ entries, next }));
		expect(bytes).toBeLessThanOrEqual(limits.bytes);
		this.scans.push({ prefix, after, rows: entries.length, bytes });
		return { entries, next };
	}
	async commit(expected: PiSourcePrefix, unit: CommitUnit): Promise<PiSourcePrefix> {
		if (
			JSON.stringify(expected) !== JSON.stringify(this.view.head) ||
			JSON.stringify(expected) !== JSON.stringify(this.image.committed.head)
		)
			throw new Error("synthetic-index-cas");
		const rows = unit.puts.length + rowCount(unit.rows) + (unit.native ? rowCount(unit.native.rows) : 0);
		const bytes = Buffer.byteLength(JSON.stringify(unit));
		expect(rows).toBeLessThanOrEqual(PI_SOURCE_LIMITS.pageRows);
		expect(bytes).toBeLessThanOrEqual(PI_SOURCE_LIMITS.pageBytes);
		expect(new Set(unit.puts.map((put) => put.key)).size).toBe(unit.puts.length);
		assertPrivateProjection(unit.rows);
		if (unit.native) {
			assertPrivateProjection(unit.native);
			expect(unit.batch).toEqual({
				...unit.native,
				adapterRef: "pi-source-index/1",
				status: "partial",
				reason: "reported-gap",
				rows: unit.rows,
			});
			assertPrivateProjection(unit.batch);
		} else expect(unit.batch).toBeNull();
		for (const put of unit.puts) {
			expect(Buffer.byteLength(put.value)).toBeLessThanOrEqual(PI_SOURCE_LIMITS.pageBytes);
			const value: unknown = JSON.parse(put.value);
			assertPrivateProjection(value);
			if (put.key.startsWith("source:")) {
				const source = value as StoredSource;
				const prior = this.view.values.get(put.key);
				const reader = prior ? (JSON.parse(prior) as StoredSource).reader : null;
				if (unit.batch) {
					const granted = new Set([source.file, source.original].map((file) => `pi-session:${digest(resolve(file))}`));
					for (const fact of unit.batch.rows.facts) expect(granted.has(fact.source.stream)).toBe(true);
				}
				if (source.reader && JSON.stringify(source.reader) !== JSON.stringify(reader)) {
					expect(unit.native).not.toBeNull();
					expect(unit.native!.fromCursor).toEqual(reader);
					expect(unit.native!.toCursor).toEqual(source.reader);
				}
			}
		}
		this.commits.push({ rows, bytes, native: unit.native !== null });
		const failure = this.failNext;
		this.failNext = null;
		if (failure === "before") throw new Error("synthetic-index-before-accept");
		const accepted = clone(unit);
		const values = new Map(this.view.values);
		for (const put of accepted.puts) values.set(put.key, put.value);
		const head: PiSourcePrefix = {
			...expected,
			sequence: expected.sequence + 1,
			sha256: digest(`${expected.sha256}\n${JSON.stringify(accepted)}`),
		};
		const next: Snapshot = { head, values, units: [...this.view.units, accepted] };
		this.image.committed = next;
		if (failure === "after") throw new Error("synthetic-index-after-accept");
		this.view = next;
		return clone(head);
	}
}

/** An explicitly supplied synthetic catalog, not a directory walk or a timestamp-sorted usage index. */
class BoundedCatalog implements PiSourceCatalog {
	entries: PiCatalogEntry[] = [];
	generation = "synthetic-generation-1";
	status: "complete" | "partial" | "unavailable" = "complete";
	unavailable = false;
	readonly pages: { after: string | null; rows: number; bytes: number }[] = [];
	async page(after: string | null, limits: { bytes: number; rows: number }) {
		expect(limits.rows).toBeLessThanOrEqual(24);
		expect(limits.bytes).toBeLessThanOrEqual(32_768);
		if (this.unavailable) throw new Error("synthetic-catalog-unavailable");
		const start = after === null ? 0 : Number(after.slice("synthetic-page:".length));
		expect(Number.isSafeInteger(start) && start >= 0).toBe(true);
		const entries: PiCatalogEntry[] = [];
		for (const entry of this.entries.slice(start, start + limits.rows)) {
			// Do not serialize the raw entry: privacy cases install forbidden-field getters on it.
			const projected = [...entries, entry].map(({ file, kind, producer }) => ({ file, kind, producer }));
			if (Buffer.byteLength(JSON.stringify(projected)) > limits.bytes) break;
			entries.push(entry);
		}
		const bytes = Buffer.byteLength(
			JSON.stringify(entries.map(({ file, kind, producer }) => ({ file, kind, producer }))),
		);
		this.pages.push({ after, rows: entries.length, bytes });
		const end = start + entries.length;
		return {
			generation: this.generation,
			entries,
			next: end < this.entries.length ? `synthetic-page:${end}` : null,
			status: this.status,
		};
	}
}

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "usage-pi-source-synthetic-"));
	dirs.push(dir);
	const roots: Record<PiSourceKind, readonly string[]> = {
		session: [join(dir, "session")],
		registry: [join(dir, "registry")],
		conversation: [join(dir, "conversation")],
		delegate: [join(dir, "delegate")],
	};
	const temper = join(dir, "temper-owned");
	for (const root of [...Object.values(roots).flat(), temper]) mkdirSync(root);
	const catalog = new BoundedCatalog();
	const image = durableImage();
	let yields = 0;
	const open = (index = new PrefixIndex(image), clock: () => number = () => 0) =>
		PiSourceAdapter.open({
			index,
			catalog,
			roots,
			temperRoots: [temper],
			current: { from: FROM, through: THROUGH },
			clock,
			yield: async () => {
				yields++;
			},
		});
	const file = (
		kind: PiSourceKind,
		name: string,
		records: readonly unknown[],
		options: { temper?: boolean; producer?: "pi" | "acp" } = {},
	) => {
		const path = join(options.temper ? temper : roots[kind][0], name);
		nativeFile(path, records);
		catalog.entries.push({ file: path, kind, producer: options.producer ?? "pi" });
		return path;
	};
	return { dir, roots, temper, catalog, image, open, file, yields: () => yields };
}
type Fixture = ReturnType<typeof fixture>;
const durableRows = (f: Fixture): Rows => {
	const rows = emptyRows();
	for (const unit of f.image.committed.units) {
		// Exactly one evidence view: native.rows is an audit receipt, NOT another ingest batch.
		const accepted = unit.batch?.rows ?? unit.rows;
		rows.facts.push(...accepted.facts);
		rows.aliases.push(...accepted.aliases);
		rows.allocations.push(...accepted.allocations);
		rows.roots.push(...accepted.roots);
		rows.policies.push(...accepted.policies);
		rows.memberships.push(...accepted.memberships);
		rows.snapshots.push(...accepted.snapshots);
	}
	return rows;
};
function observed(f: Fixture, asOf = THROUGH) {
	const rows = durableRows(f);
	const streams = [...new Set(rows.facts.map((fact) => fact.source.stream))];
	const input: AccountingInput = {
		v: 1,
		...rows,
		requiredStreams: streams,
		coverage: streams.map((stream) => ({
			stream,
			from: FROM,
			through: THROUGH,
			observedAt: asOf,
			status: "partial" as const,
		})),
	};
	return observeUsage(input, { asOf, staleAfterMs: 60_000, window: { from: FROM, through: THROUGH } });
}
const receipts = (f: Fixture) => f.image.committed.units.flatMap((unit) => (unit.native ? [unit.native] : []));
const storedSource = (f: Fixture, id: string): StoredSource =>
	JSON.parse(f.image.committed.values.get(`source:${id}`)!) as StoredSource;
const indexed = (f: Fixture, prefix: string) =>
	[...f.image.committed.values]
		.filter(([key]) => key.startsWith(prefix))
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
function assertUnit(unit: PiSourceUnit): void {
	expect(unit.bytes).toBeGreaterThanOrEqual(0);
	expect(unit.bytes).toBeLessThanOrEqual(PI_SOURCE_LIMITS.pageBytes);
	expect(unit.records).toBeGreaterThanOrEqual(0);
	expect(unit.records).toBeLessThanOrEqual(PI_SOURCE_LIMITS.scanRows);
	expect(rowCount(unit.rows)).toBeLessThanOrEqual(PI_SOURCE_LIMITS.pageRows);
	expect(Buffer.byteLength(JSON.stringify(unit))).toBeLessThanOrEqual(PI_SOURCE_LIMITS.pageBytes);
	assertPrivateProjection(unit);
}
async function step(
	adapter: PiSourceAdapter,
	id: string,
	lane: "current" | "history" = "current",
	observedAt = THROUGH,
) {
	const unit = await adapter.step(id, lane, observedAt);
	assertUnit(unit);
	return unit;
}
async function discover(adapter: PiSourceAdapter): Promise<void> {
	for (let count = 0; count < 200; count++) {
		if ((await adapter.discover()).done) return;
	}
	throw new Error("synthetic-discovery-did-not-finish");
}
async function required(adapter: PiSourceAdapter): Promise<PiRequiredSource[]> {
	const entries: PiRequiredSource[] = [];
	let after: string | null = null;
	for (let count = 0; count < 100; count++) {
		const page = await adapter.required(after);
		expect(page.entries.length).toBeLessThanOrEqual(64);
		expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(PI_SOURCE_LIMITS.pageBytes);
		entries.push(...page.entries);
		if (page.next === null) return entries;
		expect(page.next).not.toBe(after);
		after = page.next;
	}
	throw new Error("synthetic-required-pages-did-not-finish");
}
async function scanSource(f: Fixture, adapter: PiSourceAdapter, id: string): Promise<PiSourceUnit[]> {
	const units: PiSourceUnit[] = [];
	for (let count = 0; count < 512; count++) {
		if (storedSource(f, id).scanDone) return units;
		const unit = await step(adapter, id);
		units.push(unit);
		if (unit.gaps.length || unit.action === "blocked") throw new Error(`synthetic-scan-gap:${unit.gaps.join(",")}`);
	}
	throw new Error("synthetic-scan-did-not-finish");
}
async function finish(adapter: PiSourceAdapter, id: string, lane: "current" | "history" = "current") {
	const units: PiSourceUnit[] = [];
	for (let count = 0; count < 300; count++) {
		const unit = await step(adapter, id, lane);
		units.push(unit);
		if (["idle", "blocked", "excluded"].includes(unit.action)) return units;
	}
	throw new Error("synthetic-source-did-not-finish");
}
async function nativeReceipt(file: string, from: string, cursor: Cursor | null = null): Promise<NativeBatch> {
	const through = new Date(Math.min(ms(from) + 169 * 3_600_000, ms(THROUGH))).toISOString();
	const value = await new PiSessionUsageReader({ readBytes: PI_SOURCE_LIMITS.readerBytes, batchRows: 8 }).read({
		file,
		producer: "pi",
		from,
		through,
		observedAt: THROUGH,
		cursor,
	});
	expect(value.batch).not.toBeNull();
	return value.batch!;
}
function metadataFiles(f: Fixture, events: readonly unknown[] = []) {
	return [
		f.file("registry", "registry.jsonl", events),
		f.file("conversation", "conversations.jsonl", []),
		f.file("delegate", "delegates.jsonl", []),
	];
}
function taskFixture() {
	const f = fixture();
	const queue = join(f.roots.session[0], "queue.jsonl");
	const task = join(f.roots.session[0], "task.jsonl");
	f.file("session", "queue.jsonl", [
		header("queue-main"),
		op("add", 7, at(10), { project: "alpha" }),
		op("start", 7, at(20), { lane: true }),
		op("chat", 7, at(21), { file: task }),
		op("update", 7, at(90), { initiative: "direct" }),
		op("done", 7, at(100)),
		// Replay rejects this late reparent. A latest-state substitute would incorrectly apply it.
		op("update", 7, at(110), { project: "forbidden-late-parent" }),
	]);
	f.file("session", "task.jsonl", [
		header("task-7", at(20)),
		op("assigned", 7, at(21), { from: { file: queue }, project: "alpha" }),
		call("before-project-move", at(60)),
		call("after-project-move", at(85)),
		call("after-task-move", at(95)),
	]);
	const events = [
		registry(1, "initiative.create", FROM, { id: "old" }),
		registry(2, "initiative.create", FROM, { id: "new" }),
		registry(3, "project.create", at(1), { id: "alpha", initiative: "old" }),
		registry(4, "project.change", at(80), { id: "alpha", changes: { initiative: "new", name: SECRET } }),
	];
	const metadata = metadataFiles(f, events);
	return { f, queue, task, metadata, events, ids: [task, queue, ...metadata].map(idFor) };
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("usage-accounting-pi-source: synthetic committed-prefix intake only", () => {
	it("pins source-unit limits without expanding #304 or #305 policy", () => {
		expect(PI_SOURCE_LIMITS).toEqual({
			pageBytes: METER_LIMITS.pageBytes,
			pageRows: METER_LIMITS.pageRows,
			scanRows: 32,
			lineBytes: 65_536, // W3's own scan cap. #421 raised #304's to 4 MiB; W3's follows in its own task (#420 A4).
			readerBytes: 131_072,
			unitWorkMs: METER_LIMITS.unitWorkMs,
			sliceMs: METER_LIMITS.sliceMs,
			sources: METER_LIMITS.sources,
			dependencies: 64,
		});
		expect(Object.isFrozen(PI_SOURCE_LIMITS)).toBe(true);
		expect(PI_SOURCE_LIMITS.lineBytes).toBeLessThanOrEqual(PI_SESSION_LIMITS.lineBytes);
		expect(PI_SESSION_LIMITS.sources).toBe(64);
		expect(PI_SESSION_LIMITS.indexEntries).toBe(10_000);
		expect(MEMBERSHIP_LIMITS.sources).toBe(64);
		expect(MEMBERSHIP_LIMITS.historyRows).toBe(10_000);
	});

	it("keeps old originals staged, crosses occurrence windows, and never rewrites observation times", async () => {
		const f = fixture();
		const file = f.file("session", "old-and-current.jsonl", [
			header("old-and-current", OLD),
			call("old-original", OLD, { input: 10, amount: 0.1 }),
			call("current-original", at(60), { input: 7, amount: 0.03 }),
		]);
		const index = new PrefixIndex(f.image);
		const adapter = await f.open(index);
		await discover(adapter);
		const units = await finish(adapter, idFor(file), "current");
		expect(units.flatMap((unit) => unit.staged).map((fact) => fact.source.event)).toEqual(["old-original"]);
		expect(units.flatMap((unit) => unit.current).map((fact) => fact.source.event)).toEqual(["current-original"]);
		const facts = durableRows(f).facts;
		expect(facts.map((fact) => fact.occurredAt)).toEqual([OLD, at(60)]);
		expect(facts.every((fact) => fact.source.observedAt === THROUGH)).toBe(true);
		expect(facts.every((fact) => fact.prices[0].rateVersion === PI_RECORDED_RATE_VERSION)).toBe(true);
		expect(receipts(f).map((batch) => batch.from)).toEqual([OLD, at(60)]);
		expect(receipts(f)[1].fromCursor).toEqual(receipts(f)[0].toCursor);
		expect(storedSource(f, idFor(file)).reader).toEqual(receipts(f).at(-1)!.toCursor);
		expect(f.yields()).toBeGreaterThan(units.length);
		expect(
			index.commits.every(
				(commit) => commit.rows <= PI_SOURCE_LIMITS.pageRows && commit.bytes <= PI_SOURCE_LIMITS.pageBytes,
			),
		).toBe(true);
		const source = (await required(adapter)).find((entry) => entry.id === idFor(file))!;
		expect(source).toMatchObject({ state: "complete-recorded", coverageOwner: "pi:W3", usageCoverage: "partial" });
	});

	it("classifies current endpoints inclusively without borrowing a later observation time", async () => {
		const f = fixture();
		const justBefore = new Date(ms(FROM) - 1).toISOString();
		const justAfter = new Date(ms(THROUGH) + 1).toISOString();
		const observedAt = at(125);
		const file = f.file("session", "window-boundaries.jsonl", [
			header("boundaries", justBefore),
			call("before", justBefore),
			call("from", FROM),
			call("through", THROUGH),
			call("after", justAfter),
		]);
		const adapter = await f.open();
		await discover(adapter);
		const pending = (await required(adapter)).find((entry) => entry.id === idFor(file))!;
		expect(pending.collector).toBeNull();
		await scanSource(f, adapter, idFor(file));
		expect((await required(adapter)).find((entry) => entry.id === idFor(file))!.collector).toEqual({
			stream: `pi-session:${digest(file)}`,
			incarnation: "boundaries",
			adapterRef: "pi-source-index/1",
			producer: "pi",
			occurrenceStreams: [`pi-session:${digest(file)}`],
			retainedFrom: justBefore,
			grants: ["facts", "aliases"],
		});
		const unit = await step(adapter, idFor(file), "history", observedAt);
		expect(unit.current.map((fact) => fact.occurredAt)).toEqual([FROM, THROUGH]);
		expect(unit.staged.map((fact) => fact.occurredAt)).toEqual([justBefore, justAfter]);
		expect(unit.rows.facts.every((fact) => fact.source.observedAt === observedAt)).toBe(true);
		expect(unit.batch).toEqual(f.image.committed.units.at(-1)!.batch);
		expect(unit.batch).toMatchObject({
			adapterRef: "pi-source-index/1",
			status: "partial",
			reason: "reported-gap",
			rows: unit.rows,
		});
	});

	it("promotes a fork's old parent before any copy, and stores exact native receipts separately from resolved rows", async () => {
		const f = fixture();
		const parent = f.file("session", "parent.jsonl", [
			header("parent", OLD),
			call("response-copy", OLD, { response: "response-1", input: 10, amount: 0.1 }),
			call("entry-copy", OLD, { input: 5, amount: 0.02 }),
		]);
		const child = f.file("session", "child.jsonl", [
			header("child", at(50), "parent.jsonl"),
			call("response-copy", OLD, { response: "response-1", input: 10, amount: 0.1 }),
			call("entry-copy", OLD, { input: 5, amount: 0.02 }),
			call("child-new", at(60), { input: 7, amount: 0.03 }),
		]);
		f.catalog.entries.reverse(); // Child-first discovery is not permission to charge its copied history.
		let adapter = await f.open();
		await discover(adapter);
		await scanSource(f, adapter, idFor(child));
		const blocked = await step(adapter, idFor(child));
		expect(blocked).toMatchObject({ action: "blocked", promote: idFor(parent), gaps: ["copy-pending"] });
		expect(blocked.rows.facts).toEqual([]);
		expect(blocked.current).toEqual([]);
		expect(blocked.staged).toEqual([]);
		expect(receipts(f)).toEqual([]);
		const promoted = await finish(adapter, idFor(parent), "current");
		expect(promoted.flatMap((unit) => unit.current)).toEqual([]);
		expect(promoted.flatMap((unit) => unit.staged).map((fact) => fact.occurredAt)).toEqual([OLD, OLD]);
		const originals = clone(durableRows(f).facts);
		const expectedOldReceipt = await nativeReceipt(child, OLD);
		expect(expectedOldReceipt.rows.facts.find((fact) => fact.source.event === "entry-copy")!.identityStatus).toBe(
			"unresolved",
		);
		adapter = await f.open(new PrefixIndex(f.image));
		const copied = await step(adapter, idFor(child));
		expect(copied.action).toBe("usage");
		expect(copied.gaps).toEqual([]);
		expect(copied.current).toEqual([]);
		expect(copied.staged).toHaveLength(2);
		expect(receipts(f).at(-1)).toEqual(expectedOldReceipt);
		expect(
			copied.rows.facts.every((fact) => fact.identityStatus === "verified" && fact.links.session === "parent"),
		).toBe(true);
		expect(copied.rows.aliases.map((alias) => alias.canonicalFactId).sort()).toEqual(
			originals.map((fact) => fact.id).sort(),
		);
		const current = await step(adapter, idFor(child));
		expect(current.current.map((fact) => fact.source.event)).toEqual(["child-new"]);
		expect(current.staged).toEqual([]);
		const rows = durableRows(f);
		expect(rows.facts.slice(0, 2)).toEqual(originals);
		expect(rows.facts).toHaveLength(5);
		expect(rows.aliases).toHaveLength(2);
		const aliases = new Set(rows.aliases.map((alias) => alias.aliasFactId));
		const charged = rows.facts.filter((fact) => !aliases.has(fact.id));
		expect(charged.map((fact) => fact.source.event)).toEqual(["response-copy", "entry-copy", "child-new"]);
		expect(charged.reduce((sum, fact) => sum + fact.tokens.input!, 0)).toBe(22);
		expect(await step(adapter, idFor(child))).toMatchObject({ action: "idle", rows: emptyRows() });
	});

	it("rechecks a finished parent that appended without a dirty event before charging its child's no-response copy", async () => {
		const f = fixture();
		const parent = f.file("session", "growing-parent.jsonl", [
			header("growing-parent"),
			call("old-parent-call", at(30)),
		]);
		const child = f.file("session", "growing-child.jsonl", [
			header("growing-child", at(65), "growing-parent.jsonl"),
			call("appended-parent-call", at(60)),
		]);
		const adapter = await f.open();
		await discover(adapter);
		await finish(adapter, idFor(parent));
		await scanSource(f, adapter, idFor(child));
		appendFileSync(parent, line(call("appended-parent-call", at(60))));
		// Deliberately miss the parent's notification. A stale readDone bit does not prove copy absence.
		const childFirst = await step(adapter, idFor(child));
		expect(childFirst).toMatchObject({ action: "blocked", promote: idFor(parent) });
		expect(childFirst.rows.facts).toEqual([]);
		await finish(adapter, idFor(parent));
		await finish(adapter, idFor(child));
		const rows = durableRows(f);
		expect(rows.aliases).toHaveLength(1);
		const aliasIds = new Set(rows.aliases.map((alias) => alias.aliasFactId));
		expect(rows.facts.filter((fact) => !aliasIds.has(fact.id)).map((fact) => fact.source.event)).toEqual([
			"old-parent-call",
			"appended-parent-call",
		]);
		const folded = observed(f);
		expect(folded.dedupKnownListUsd).toBe("0.02");
		expect(folded.unresolvedIdentities).toBe(0);
		expect(folded.faults.some((fault) => fault.code === "record-conflict")).toBe(false);
	});

	it("reevaluates copy-pending after a dirty child finishes bounded verification and rescan", async () => {
		const f = fixture();
		const parent = f.file("session", "pending-parent.jsonl", [header("pending-parent"), call("parent-copy", at(30))]);
		const child = f.file("session", "pending-child.jsonl", [
			header("pending-child", at(50), "pending-parent.jsonl"),
			call("parent-copy", at(30)),
		]);
		const adapter = await f.open();
		await discover(adapter);
		await scanSource(f, adapter, idFor(child));
		expect(await step(adapter, idFor(child))).toMatchObject({
			action: "blocked",
			promote: idFor(parent),
			gaps: ["copy-pending"],
		});
		appendFileSync(child, line(call("child-new", at(65))));
		await adapter.notify({ kind: "dirty", file: child });
		await finish(adapter, idFor(parent));
		const units: PiSourceUnit[] = [];
		for (let count = 0; count < 20; count++) {
			const unit = await step(adapter, idFor(child));
			units.push(unit);
			if (["idle", "blocked"].includes(unit.action)) break;
		}
		expect(units.some((unit) => unit.action === "usage")).toBe(true);
		expect(storedSource(f, idFor(child))).toMatchObject({ scanDone: true, readDone: true, gaps: [] });
		expect(durableRows(f).aliases).toHaveLength(1);
		expect(observed(f).dedupKnownListUsd).toBe("0.02");
	});

	it("promotes a temporarily partial parent instead of making its child's copy absence terminal", async () => {
		const f = fixture();
		const parent = f.file("session", "partial-parent.jsonl", [header("partial-parent")]);
		appendFileSync(parent, line(call("partial-parent-copy", at(30))).slice(0, -1));
		const child = f.file("session", "partial-parent-child.jsonl", [
			header("partial-parent-child", at(50), "partial-parent.jsonl"),
			call("partial-parent-copy", at(30)),
		]);
		const adapter = await f.open();
		await discover(adapter);
		expect(await step(adapter, idFor(parent))).toMatchObject({ action: "scan", gaps: ["partial-last-line"] });
		await scanSource(f, adapter, idFor(child));
		const waiting = await step(adapter, idFor(child));
		expect(waiting).toMatchObject({ action: "blocked", promote: idFor(parent), gaps: ["copy-pending"] });
		expect(waiting.gaps).not.toContain("missing-parent");
		expect(waiting.rows.facts).toEqual([]);
		appendFileSync(parent, "\n");
		await finish(adapter, idFor(parent));
		await finish(adapter, idFor(child));
		expect(storedSource(f, idFor(child))).toMatchObject({ scanDone: true, readDone: true, gaps: [] });
		expect(durableRows(f).aliases).toHaveLength(1);
		expect(observed(f).dedupKnownListUsd).toBe("0.01");
	});

	it("hydrates same-session originals after reopening and does not restamp a resumed copy", async () => {
		const f = fixture();
		const original = f.file("session", "original.jsonl", [header("same-session"), call("same-entry")]);
		const resumed = f.file("session", "resumed.jsonl", [header("same-session"), call("same-entry")]);
		let adapter = await f.open();
		await discover(adapter);
		await finish(adapter, idFor(original));
		const first = clone(durableRows(f).facts);
		adapter = await f.open(new PrefixIndex(f.image));
		await finish(adapter, idFor(resumed), "history");
		expect(durableRows(f).facts).toEqual(first);
		expect(durableRows(f).aliases).toEqual([]);
		expect(receipts(f).at(-1)!.rows.facts).toHaveLength(1);
		expect(receipts(f).at(-1)!.rows.facts[0].source.stream).not.toBe(first[0].source.stream);
		expect(first[0].source.stream).toBe(`pi-session:${digest(resolve(original))}`);
		expect(storedSource(f, idFor(resumed)).readDone).toBe(true);
		appendFileSync(resumed, line(call("same-entry")));
		adapter = await f.open(new PrefixIndex(f.image));
		await adapter.notify({ kind: "dirty", file: resumed });
		const replayed = await finish(adapter, idFor(resumed), "history");
		expect(storedSource(f, idFor(resumed)).readDone).toBe(true);
		expect(replayed.flatMap((unit) => unit.rows.facts)).toEqual([]);
		expect(durableRows(f).facts).toEqual(first);
		expect(durableRows(f).aliases).toEqual([]);
		expect(observed(f).dedupKnownListUsd).toBe("0.01");
	});

	it("reuses an exact repeated alias witness, including its first observation stamp, across restart", async () => {
		const f = fixture();
		const file = f.file("session", "repeat-alias.jsonl", [
			header("repeat-alias"),
			call("E1", at(30), { response: "R" }),
			call("E2", at(30), { response: "R" }),
			call("E2", at(30), { response: "R" }),
		]);
		let adapter = await f.open();
		await discover(adapter);
		await finish(adapter, idFor(file));
		const firstRows = clone(durableRows(f));
		const firstAlias = firstRows.aliases[0];
		expect(firstAlias).toBeDefined();
		for (const alias of firstRows.aliases) expect(alias).toEqual(firstAlias);
		const firstCopy = firstRows.facts.find((fact) => fact.id === firstAlias.aliasFactId)!;
		for (const fact of firstRows.facts.filter((fact) => fact.id === firstCopy.id)) expect(fact).toEqual(firstCopy);
		appendFileSync(file, line(call("E2", at(30), { response: "R" })));
		adapter = await f.open(new PrefixIndex(f.image));
		await adapter.notify({ kind: "dirty", file });
		for (let count = 0; count < 30; count++) {
			const unit = await step(adapter, idFor(file), "history", at(125));
			if (unit.action === "idle") break;
			expect(unit.action).not.toBe("blocked");
		}
		expect(storedSource(f, idFor(file)).readDone).toBe(true);
		const after = durableRows(f);
		for (const alias of after.aliases) expect(alias).toEqual(firstAlias);
		for (const fact of after.facts.filter((fact) => fact.id === firstCopy.id)) expect(fact).toEqual(firstCopy);
		expect(new Set(after.facts.map((fact) => fact.id)).size).toBe(2);
		const folded = observed(f, at(125));
		expect(folded.dedupKnownListUsd).toBe("0.01");
		expect(folded.unresolvedIdentities).toBe(0);
		expect(folded.faults.some((fault) => fault.code === "record-conflict")).toBe(false);
	});

	it("resumes an accepted bounded usage prefix after a fresh port and adapter, without replaying facts", async () => {
		const f = fixture();
		const file = f.file("session", "many-calls.jsonl", [
			header("many-calls"),
			...Array.from({ length: 40 }, (_, n) => call(`call-${n + 1}`, at(30 + n))),
		]);
		let adapter = await f.open();
		await discover(adapter);
		await scanSource(f, adapter, idFor(file));
		const first = await step(adapter, idFor(file));
		expect(first.rows.facts.length).toBeGreaterThan(0);
		expect(first.rows.facts.length).toBeLessThanOrEqual(8);
		const committedCursor = clone(storedSource(f, idFor(file)).reader);
		expect(committedCursor).toEqual(receipts(f).at(-1)!.toCursor);
		const index = new PrefixIndex(f.image);
		adapter = await f.open(index);
		await finish(adapter, idFor(file));
		const facts = durableRows(f).facts;
		expect(facts).toHaveLength(40);
		expect(new Set(facts.map((fact) => fact.id)).size).toBe(40);
		expect(receipts(f)[1].fromCursor).toEqual(committedCursor);
		expect(index.gets.every((get) => get.sequence >= 1)).toBe(true);
		expect(
			index.scans.every((scan) => scan.rows <= PI_SOURCE_LIMITS.pageRows && scan.bytes <= PI_SOURCE_LIMITS.pageBytes),
		).toBe(true);
	});

	it.each(["before", "after"] as const)(
		"seals on a %s-accept index failure and reopens only the durable prefix",
		async (failure) => {
			const f = fixture();
			const file = f.file("session", "failure.jsonl", [header("failure"), call("only-once")]);
			const index = new PrefixIndex(f.image);
			let adapter = await f.open(index);
			await discover(adapter);
			await scanSource(f, adapter, idFor(file));
			const before = clone(f.image.committed.head);
			index.failNext = failure;
			await expect(step(adapter, idFor(file))).rejects.toThrow("pi-source-index-unavailable");
			await expect(adapter.required()).rejects.toThrow("pi-source-index-unavailable");
			expect(f.image.committed.head.sequence).toBe(before.sequence + Number(failure === "after"));
			expect(durableRows(f).facts).toHaveLength(Number(failure === "after"));
			expect(storedSource(f, idFor(file)).reader === null).toBe(failure === "before");
			adapter = await f.open(new PrefixIndex(f.image));
			await finish(adapter, idFor(file));
			expect(durableRows(f).facts.map((fact) => fact.source.event)).toEqual(["only-once"]);
			expect(receipts(f)).toHaveLength(1);
		},
	);

	it("rejects a stale CAS without exposing another port's uncommitted cursor", async () => {
		const f = fixture();
		f.file("session", "cas.jsonl", [header("cas")]);
		const firstIndex = new PrefixIndex(f.image);
		const staleIndex = new PrefixIndex(f.image);
		const first = await f.open(firstIndex);
		const stale = await f.open(staleIndex);
		await first.discover();
		expect(await staleIndex.get("inventory")).toBeNull();
		const head = clone(f.image.committed.head);
		await expect(stale.discover()).rejects.toThrow("pi-source-index-unavailable");
		expect(f.image.committed.head).toEqual(head);
		expect(receipts(f)).toEqual([]);
	});

	it("pages more than 64 required native sources and reads all of them without the #304 cache ceiling", async () => {
		const f = fixture();
		const files = Array.from({ length: 70 }, (_, n) =>
			f.file("session", `session-${pad(n)}.jsonl`, [header(`session-${n}`), call(`call-${n}`)]),
		);
		const adapter = await f.open();
		await discover(adapter);
		expect(f.catalog.pages.map((page) => page.rows)).toEqual([24, 24, 22]);
		expect(f.catalog.pages.every((page) => page.bytes <= 32_768)).toBe(true);
		expect((await adapter.required()).next).not.toBeNull();
		for (const file of files) await finish(adapter, idFor(file));
		const entries = await required(adapter);
		const native = entries.filter((entry) => entry.kind !== "gap");
		expect(native).toHaveLength(70);
		expect(new Set(native.map((entry) => entry.id)).size).toBe(70);
		expect(native.every((entry) => entry.state === "complete-recorded" && entry.usageCoverage === "partial")).toBe(
			true,
		);
		expect(durableRows(f).facts).toHaveLength(70);
		expect(receipts(f)).toHaveLength(70);
		expect((await adapter.required()).inventory).toBe("complete");
		expect(
			entries
				.filter((entry) => entry.kind === "gap")
				.map((entry) => entry.id)
				.sort(),
		).toEqual(["aggregate-provenance", "fileless-calls", "unreported-failures", "unsupported-acp"]);
	});

	it("restarts a generation-changing catalog pass instead of losing the first or last inventory page", async () => {
		const f = fixture();
		for (let n = 0; n < 70; n++) f.file("session", `generation-${pad(n)}.jsonl`, [header(`generation-${n}`)]);
		const adapter = await f.open();
		expect((await adapter.discover()).done).toBe(false);
		f.catalog.generation = "synthetic-generation-2";
		expect((await adapter.discover()).gaps).toContain("inventory-changed");
		expect((await adapter.required()).inventory).toBe("partial");
		await discover(adapter);
		expect((await adapter.required()).inventory).toBe("complete");
		expect((await required(adapter)).filter((entry) => entry.kind === "session")).toHaveLength(70);
		expect(indexed(f, "source:")).toHaveLength(70);
		expect(f.catalog.pages.map((page) => page.after)).toEqual([
			null,
			"synthetic-page:24",
			null,
			"synthetic-page:24",
			"synthetic-page:48",
		]);
	});

	it("uses original task birth and event-time parents, rejecting a late ignored reparent", async () => {
		const { f, queue, task, ids } = taskFixture();
		const adapter = await f.open();
		await discover(adapter);
		for (const id of ids) await scanSource(f, adapter, id);
		const map = await adapter.membership(ids);
		expect(map.gaps).toEqual([]);
		expect(map.memberships.find((membership) => membership.file === task)).toMatchObject({
			queue,
			task: 7,
			addedAt: at(10),
			from: at(21),
		});
		const earlier = taskMembershipAt(map, task, at(60), "chat")!;
		const movedProject = taskMembershipAt(map, task, at(85), "chat")!;
		const movedTask = taskMembershipAt(map, task, at(95), "chat")!;
		expect([
			earlier.project,
			earlier.initiative,
			movedProject.project,
			movedProject.initiative,
			movedTask.project,
			movedTask.initiative,
		]).toEqual(["alpha", "old", "alpha", "new", null, "direct"]);
		expect(taskMembershipAt(map, task, at(115), "chat")).toEqual(movedTask);
		expect(map.parentHistory.some((parent) => parent.project === "forbidden-late-parent")).toBe(false);
		await finish(adapter, idFor(task));
		const fact = durableRows(f).facts.find((item) => item.source.event === "before-project-move")!;
		expect(checkTaskBinding({ ...fact, links: { ...fact.links, task: earlier } }, map.parentHistory)).toBe("verified");
		expect(checkTaskBinding({ ...fact, links: { ...fact.links, task: movedTask } }, map.parentHistory)).toBe(
			"mismatch",
		);
		expect(durableRows(f).memberships).toEqual(map.parentHistory);
		expect(indexed(f, "parent:")).toHaveLength(3);
	});

	it("retains rejected source-tag reparent/requeue witnesses and neutral chain events without altering task birth", async () => {
		const { f, queue, task, ids } = taskFixture();
		nativeFile(queue, [
			header("queue-main"),
			op("add", 7, at(10), {
				project: "alpha",
				source: { key: "native-key", configuration: "native-config", sessionId: "queue-main" },
			}),
			op("start", 7, at(20), { lane: true }),
			op("chat", 7, at(21), { file: task }),
			op("chain", 7, at(30), { after: [8] }),
			op("update", 7, at(40), { project: "forbidden-reparent" }),
			op("requeue", 7, at(50), { initiative: "forbidden-requeue" }),
			op("done", 7, at(100)),
		]);
		const adapter = await f.open();
		await discover(adapter);
		for (const id of ids) await scanSource(f, adapter, id);
		const map = await adapter.membership(ids);
		expect(map.gaps).toEqual([]);
		expect(taskMembershipAt(map, task, at(60), "chat")).toMatchObject({
			addedAt: at(10),
			project: "alpha",
			initiative: "old",
		});
		expect(taskMembershipAt(map, task, at(95), "chat")).toMatchObject({
			addedAt: at(10),
			project: "alpha",
			initiative: "new",
		});
		const witnesses = indexed(f, `queue-event:${idFor(queue)}:`).map(([, value]) => JSON.parse(value));
		expect(witnesses.filter((value) => value.accepted === false).map((value) => value.record.data.op)).toEqual([
			"update",
			"requeue",
		]);
		expect(witnesses.find((value) => value.record.data.op === "chain")).toMatchObject({ accepted: true });
		const meta = indexed(f, `meta:${idFor(queue)}:`).map(([, value]) => JSON.parse(value));
		expect(meta.some((value) => ["update", "requeue", "chain"].includes(value.record.data?.op))).toBe(false);
		expect(JSON.parse(f.image.committed.values.get(`task:${idFor(queue)}:${pad(7)}`)!)).toEqual({ immutable: true });
	});

	it("requires explicit metadata witness IDs and never treats absent metadata as known-empty", async () => {
		const { f, queue, task, ids } = taskFixture();
		const adapter = await f.open();
		await discover(adapter);
		for (const id of ids) await scanSource(f, adapter, id);
		const missing = await adapter.membership([idFor(task), idFor(queue)]);
		expect(missing.gaps.map((gap) => gap.code)).toEqual(expect.arrayContaining(["missing", "unsupported"]));
		expect(taskMembershipAt(missing, task, at(60), "chat")).toBeNull();
		expect(durableRows(f).memberships).toEqual([]);
		const complete = await adapter.membership(ids);
		expect(complete.gaps).toEqual([]);
		expect(taskMembershipAt(complete, task, at(60), "chat")?.initiative).toBe("old");
	});

	it("uses explicit conversation/delegate parent witnesses, not helper names, to inherit task membership", async () => {
		const { f, task, metadata, ids } = taskFixture();
		const helper = f.file("session", "task-7-helper.jsonl", [header("helper", at(40))]);
		const delegate = f.file("session", "task-7-delegate.jsonl", [header("delegate", at(35))]);
		const adHoc = f.file("session", "task-7-unassigned.jsonl", [header("ad-hoc", at(40))]);
		nativeFile(metadata[1], [
			conversation("parent-conv", task, "task-7", at(21)),
			{
				...conversation("helper-conv", helper, "helper", at(40)),
				origin: "helper",
				parentConversationId: "parent-conv",
			},
			{ ...conversation("ad-hoc-conv", adHoc, "ad-hoc", at(40)), origin: "helper", title: "Task 7" },
			{ ...conversation("app-conv", task, "task-7", at(40)), origin: "app", parentConversationId: "parent-conv" },
		]);
		nativeFile(metadata[2], [
			{ runId: "delegate-7", file: delegate, parentFile: task, ts: ms(at(35)), prompt: SECRET, result: SECRET },
		]);
		const all = [...ids, helper, delegate, adHoc].map((id) => (id.startsWith("/") ? idFor(id) : id));
		const adapter = await f.open();
		await discover(adapter);
		for (const id of all) await scanSource(f, adapter, id);
		const map = await adapter.membership(all);
		expect(map.gaps).toEqual([]);
		expect(taskMembershipAt(map, helper, at(60), "helper")).toMatchObject({
			task: 7,
			addedAt: at(10),
			project: "alpha",
			initiative: "old",
		});
		expect(taskMembershipAt(map, delegate, at(85), "helper")).toMatchObject({
			task: 7,
			addedAt: at(10),
			project: "alpha",
			initiative: "new",
		});
		expect(taskMembershipAt(map, adHoc, at(60), "helper")).toBeNull();
		expect(taskMembershipAt(map, task, at(60), "app")).toBeNull();
		expect(map.notInAnyTask).toContainEqual({ file: adHoc, sessionId: "ad-hoc" });
	});

	it("replays persisted metadata after reopening rather than substituting a registry's latest parent", async () => {
		const { f, task, ids } = taskFixture();
		let adapter = await f.open();
		await discover(adapter);
		for (const id of ids) await scanSource(f, adapter, id);
		const before = await adapter.membership(ids);
		adapter = await f.open(new PrefixIndex(f.image));
		const after = await adapter.membership([...ids].reverse());
		expect(after).toEqual(before);
		expect(taskMembershipAt(after, task, at(60), "chat")?.initiative).toBe("old");
		expect(taskMembershipAt(after, task, at(85), "chat")?.initiative).toBe("new");
	});

	// Extra time is only for this test double's repeated durable Map copies and privacy assertions; native limits stay fixed.
	it("retains over 10,000 metadata events in bounded native pages and exposes the real #305 continuation gap", async () => {
		const { f, task, ids, metadata, events } = taskFixture();
		const history = [
			...events.slice(0, 3),
			...Array.from({ length: 9_997 }, (_, n) => registry(n + 4, "initiative.change", at(2), { id: "old" })),
			registry(10_001, "project.change", at(80), { id: "alpha", changes: { initiative: "new" } }),
		];
		expect(history).toHaveLength(MEMBERSHIP_LIMITS.historyRows + 1);
		nativeFile(metadata[0], history);
		let adapter = await f.open();
		await discover(adapter);
		const units = await scanSource(f, adapter, idFor(metadata[0]));
		expect(units.length).toBeGreaterThanOrEqual(Math.ceil(10_001 / PI_SOURCE_LIMITS.scanRows));
		expect(units.reduce((sum, unit) => sum + unit.records, 0)).toBe(10_001);
		expect(indexed(f, `meta:${idFor(metadata[0])}:`)).toHaveLength(10_001);
		const tail = JSON.parse(f.image.committed.values.get(`meta:${idFor(metadata[0])}:${pad(10_001)}`)!);
		expect(tail.record).toMatchObject({ seq: 10_001, changes: { initiative: "new" } });
		for (const id of ids.filter((id) => id !== idFor(metadata[0]))) await scanSource(f, adapter, id);
		adapter = await f.open(new PrefixIndex(f.image));
		const map = await adapter.membership(ids);
		// #305 cannot yet replay this dependency closure. Never hide that gap by taking only its first page.
		expect(map.gaps.map((gap) => gap.code)).toContain("partial");
		expect(taskMembershipAt(map, task, at(85), "chat")).toBeNull();
		expect(durableRows(f).memberships).toEqual([]);
		expect(indexed(f, "parent:")).toEqual([]);
		expect(indexed(f, `meta:${idFor(metadata[0])}:`)).toHaveLength(10_001);
	});

	it.each([
		{ name: "sequence hole", code: "registry-sequence", seq: 3, timestamp: at(1) },
		{ name: "backwards event time", code: "event-time-order", seq: 2, timestamp: FROM },
	])("preserves an explicit $name instead of applying later registry parents", async ({ code, seq, timestamp }) => {
		const f = fixture();
		const file = f.file("registry", "broken-registry.jsonl", [
			registry(1, "initiative.create", at(1), { id: "old" }),
			registry(seq, "project.create", timestamp, { id: "alpha", initiative: "old" }),
		]);
		const adapter = await f.open();
		await discover(adapter);
		const unit = await step(adapter, idFor(file));
		expect(unit.gaps).toContain(code);
		expect(storedSource(f, idFor(file)).anchor?.line).toBe(1);
		expect(indexed(f, `meta:${idFor(file)}:`)).toHaveLength(1);
		expect((await step(adapter, idFor(file))).action).toBe("blocked");
		expect(durableRows(f).memberships).toEqual([]);
	});

	it.each(["missing", "self"] as const)("never charges a copy with a %s parent witness", async (which) => {
		const f = fixture();
		const file = f.file("session", "child.jsonl", [
			header("unproved-child", at(50), which === "self" ? "child.jsonl" : "absent.jsonl"),
			call("unproved-old-copy", OLD),
		]);
		const adapter = await f.open();
		await discover(adapter);
		await scanSource(f, adapter, idFor(file));
		const unit = await step(adapter, idFor(file));
		expect(unit.action).toBe("blocked");
		expect(unit.gaps).toContain(which === "self" ? "parent-cycle" : "missing-parent");
		expect(durableRows(f).facts).toEqual([]);
		expect(receipts(f)).toEqual([]);
	});

	it("retains an identity conflict as a gap, not a second resolved charge", async () => {
		const f = fixture();
		const first = f.file("session", "first.jsonl", [
			header("first"),
			call("one", at(60), { response: "same-response" }),
		]);
		const other = f.file("session", "other.jsonl", [
			header("other"),
			call("two", at(60), { response: "same-response", input: 2 }),
		]);
		const adapter = await f.open();
		await discover(adapter);
		await finish(adapter, idFor(first));
		const units = await finish(adapter, idFor(other));
		expect(units.flatMap((unit) => unit.gaps)).toContain("identity-conflict");
		expect(durableRows(f).facts.map((fact) => fact.source.event)).toEqual(["one"]);
		expect(durableRows(f).aliases).toEqual([]);
	});

	it("invalidates inventory on watcher overflow, reconciles rename/new/missing files, and preserves the first source ID", async () => {
		const f = fixture();
		const original = f.file("session", "original.jsonl", [header("renamed"), call("before-rename")]);
		const missing = f.file("session", "missing.jsonl", [header("missing")]);
		let adapter = await f.open();
		await discover(adapter);
		await finish(adapter, idFor(original));
		const before = clone(durableRows(f).facts);
		const renamed = join(f.roots.session[0], "renamed.jsonl");
		renameSync(original, renamed);
		rmSync(missing);
		f.catalog.entries = [{ file: renamed, kind: "session", producer: "pi" }];
		const added = f.file("session", "new.jsonl", [header("new"), call("new-call")]);
		f.catalog.generation = "synthetic-generation-2";
		await adapter.notify({ kind: "overflow" });
		expect(await adapter.required()).toMatchObject({ inventory: "partial", gaps: ["inventory-pending"] });
		await discover(adapter);
		adapter = await f.open(new PrefixIndex(f.image));
		const entries = await required(adapter);
		expect(entries.find((entry) => entry.id === idFor(missing))).toMatchObject({
			state: "terminal-gap",
			gaps: ["source-missing"],
		});
		expect(entries.filter((entry) => entry.kind === "session")).toHaveLength(3);
		expect(entries.some((entry) => entry.id === idFor(renamed))).toBe(false);
		expect(storedSource(f, idFor(original))).toMatchObject({ id: idFor(original), file: renamed, original });
		appendFileSync(renamed, line(call("after-rename", at(65))));
		await adapter.notify({ kind: "dirty", file: renamed });
		await finish(adapter, idFor(original));
		await finish(adapter, idFor(added));
		expect(durableRows(f).facts.slice(0, 1)).toEqual(before);
		expect(durableRows(f).facts.map((fact) => fact.source.event)).toEqual([
			"before-rename",
			"after-rename",
			"new-call",
		]);
	});

	it("keeps an intermediate renamed-stream replay identity-only after a second rename and reopen", async () => {
		const f = fixture();
		const original = f.file("session", "rename-a.jsonl", [header("twice-renamed"), call("first-call", at(30))]);
		let adapter = await f.open();
		await discover(adapter);
		await finish(adapter, idFor(original));
		const middle = join(f.roots.session[0], "rename-b.jsonl");
		renameSync(original, middle);
		f.catalog.entries = [{ file: middle, kind: "session", producer: "pi" }];
		f.catalog.generation = "synthetic-rename-generation-2";
		await adapter.notify({ kind: "directory" });
		await discover(adapter);
		appendFileSync(middle, line(call("renamed-entry", at(65))));
		await adapter.notify({ kind: "dirty", file: middle });
		await finish(adapter, idFor(original));
		expect(storedSource(f, idFor(original)).readDone).toBe(true);
		const accepted = clone(durableRows(f).facts);
		expect(accepted.map((fact) => fact.source.event)).toEqual(["first-call", "renamed-entry"]);
		expect(accepted[1].source.stream).toBe(`pi-session:${digest(middle)}`);
		const cursor = clone(storedSource(f, idFor(original)).reader);
		const last = join(f.roots.session[0], "rename-c.jsonl");
		renameSync(middle, last);
		f.catalog.entries = [{ file: last, kind: "session", producer: "pi" }];
		f.catalog.generation = "synthetic-rename-generation-3";
		adapter = await f.open(new PrefixIndex(f.image));
		await adapter.notify({ kind: "overflow" });
		await discover(adapter);
		const descriptor = (await required(adapter)).find((entry) => entry.id === idFor(original))!.collector!;
		expect(descriptor.occurrenceStreams).toEqual([`pi-session:${digest(original)}`, `pi-session:${digest(last)}`]);
		expect(descriptor.occurrenceStreams).not.toContain(accepted[1].source.stream);
		appendFileSync(last, line(call("renamed-entry", at(65))));
		await adapter.notify({ kind: "dirty", file: last });
		const replayed = await finish(adapter, idFor(original), "history");
		expect(storedSource(f, idFor(original)).readDone).toBe(true);
		expect(replayed.flatMap((unit) => unit.rows.facts)).toEqual([]);
		expect(durableRows(f).facts).toEqual(accepted);
		expect(durableRows(f).aliases).toEqual([]);
		expect(receipts(f).at(-1)!.fromCursor).toEqual(cursor);
		expect(receipts(f).at(-1)!.rows.facts[0].source.stream).toBe(`pi-session:${digest(last)}`);
		expect(observed(f).dedupKnownListUsd).toBe("0.02");
	});

	it("treats an unknown dirty path and directory notification as fresh bounded inventory obligations", async () => {
		const f = fixture();
		const adapter = await f.open();
		await discover(adapter);
		expect((await adapter.required()).inventory).toBe("complete");
		const file = f.file("session", "new-from-event.jsonl", [header("new-from-event"), call("new-from-event")]);
		await adapter.notify({ kind: "dirty", file });
		expect((await adapter.required()).inventory).toBe("partial");
		await discover(adapter);
		await finish(adapter, idFor(file));
		await adapter.notify({ kind: "directory" });
		expect((await adapter.required()).inventory).toBe("partial");
		await discover(adapter);
		expect(durableRows(f).facts).toHaveLength(1);
	});

	it("verifies every committed native prefix before consuming an append, without replaying its earlier facts", async () => {
		const f = fixture();
		const file = f.file("session", "append.jsonl", [header("append"), call("before-append")]);
		const adapter = await f.open();
		await discover(adapter);
		await finish(adapter, idFor(file));
		const before = clone(durableRows(f).facts);
		appendFileSync(file, line(call("after-append", at(65))));
		await adapter.notify({ kind: "dirty", file });
		expect((await required(adapter)).find((entry) => entry.id === idFor(file))!.state).toBe("pending");
		const units = await finish(adapter, idFor(file));
		expect(units[0].action).toBe("verify");
		expect(units.flatMap((unit) => unit.rows.facts).map((fact) => fact.source.event)).toEqual(["after-append"]);
		expect(durableRows(f).facts.slice(0, 1)).toEqual(before);
		expect(receipts(f)[1].fromCursor).toEqual(receipts(f)[0].toCursor);
	});

	it.each(["truncated", "rewritten-prefix", "replaced"] as const)(
		"blocks a %s file without restoring or advancing a changed usage cursor",
		async (change) => {
			const f = fixture();
			const records = [
				header("changed"),
				...Array.from({ length: 250 }, (_, n) => ({
					type: "custom",
					customType: "opaque",
					marker: n === 0 ? "aaaaaaaa" : "unchanged",
				})),
				call("accepted-before-change"),
			];
			const file = f.file("session", "changed.jsonl", records);
			const adapter = await f.open();
			await discover(adapter);
			await finish(adapter, idFor(file));
			const cursor = clone(storedSource(f, idFor(file)).reader);
			const facts = clone(durableRows(f).facts);
			if (change === "truncated") truncateSync(file, 0);
			else if (change === "rewritten-prefix") {
				// Same byte count; neither the last line nor the header changed. A tail-only check is insufficient.
				nativeFile(file, [
					records[0],
					{ type: "custom", customType: "opaque", marker: "bbbbbbbb" },
					...records.slice(2),
				]);
			} else {
				const replacement = join(f.roots.session[0], "replacement.jsonl");
				nativeFile(replacement, records);
				renameSync(replacement, file);
			}
			await adapter.notify({ kind: "dirty", file });
			const unit = await step(adapter, idFor(file));
			const code =
				change === "truncated" ? "source-truncated" : change === "replaced" ? "source-replaced" : "anchor-changed";
			expect(unit.action).toBe("verify");
			expect(unit.gaps).toContain(code);
			expect(unit.rows).toEqual(emptyRows());
			expect(storedSource(f, idFor(file)).reader).toEqual(cursor);
			expect(durableRows(f).facts).toEqual(facts);
			expect((await step(adapter, idFor(file))).action).toBe("blocked");
		},
	);

	it("detects a file changing during a native metadata unit, not just between notifications", async () => {
		const f = fixture();
		const file = f.file("registry", "changing.jsonl", [registry(1, "initiative.create", FROM, { id: "old" })]);
		const index = new PrefixIndex(f.image);
		const adapter = await f.open(index);
		await discover(adapter);
		let changed = false;
		index.beforeGet = (key) => {
			if (key !== `registry:${idFor(file)}` || changed) return;
			changed = true;
			appendFileSync(file, line(registry(2, "initiative.change", at(1), { id: "old" })));
		};
		const unit = await step(adapter, idFor(file));
		expect(changed).toBe(true);
		expect(unit.gaps).toContain("anchor-changed");
		expect(durableRows(f).facts).toEqual([]);
		expect(durableRows(f).memberships).toEqual([]);
		expect((await required(adapter)).find((entry) => entry.id === idFor(file))!.state).toBe("terminal-gap");
	});

	it("gaps a zero-byte session while known-empty registry/conversation/delegate witnesses stay usable", async () => {
		const f = fixture();
		const file = f.file("session", "empty-session.jsonl", []);
		const metadata = metadataFiles(f);
		const adapter = await f.open();
		await discover(adapter);
		const empty = await step(adapter, idFor(file));
		expect(empty).toMatchObject({ action: "scan", records: 0, gaps: ["invalid-record"], batch: null });
		expect((await step(adapter, idFor(file))).action).toBe("blocked");
		for (const witness of metadata) await scanSource(f, adapter, idFor(witness));
		expect((await adapter.membership(metadata.map(idFor))).gaps).toEqual([]);
		expect((await required(adapter)).find((entry) => entry.id === idFor(file))).toMatchObject({
			state: "terminal-gap",
			collector: null,
		});
		expect(durableRows(f).facts).toEqual([]);
	});

	it("keeps a partial last line pending until its exact bytes are completed", async () => {
		const f = fixture();
		const file = f.file("session", "partial.jsonl", [header("partial"), call("first")]);
		appendFileSync(file, JSON.stringify(call("second", at(65))));
		const adapter = await f.open();
		await discover(adapter);
		const partial = await step(adapter, idFor(file));
		expect(partial.gaps).toContain("partial-last-line");
		expect(receipts(f)).toEqual([]);
		appendFileSync(file, "\n");
		await adapter.notify({ kind: "dirty", file });
		await finish(adapter, idFor(file));
		expect(durableRows(f).facts.map((fact) => fact.source.event)).toEqual(["first", "second"]);
	});

	it("reports a native overlong line without projecting its payload or claiming completion", async () => {
		const f = fixture();
		const file = f.file("session", "overlong.jsonl", [
			header("overlong"),
			{
				type: "message",
				id: "overlong",
				timestamp: at(60),
				message: { role: "assistant", content: "x".repeat(PI_SOURCE_LIMITS.lineBytes), payload: SECRET },
			},
		]);
		const adapter = await f.open();
		await discover(adapter);
		const unit = await step(adapter, idFor(file));
		expect(unit.gaps).toContain("line-limit");
		expect(unit.records).toBe(1);
		expect(durableRows(f).facts).toEqual([]);
		expect((await required(adapter)).find((entry) => entry.id === idFor(file))!.state).toBe("terminal-gap");
	});

	it("yields at the slice boundary and seals a hard work overrun before accepting evidence", async () => {
		const f = fixture();
		const file = f.file("session", "clock.jsonl", [header("clock"), call("clock")]);
		let active = false;
		let ticks = 0;
		const adapter = await f.open(new PrefixIndex(f.image), () => (active && ++ticks >= 5 ? 30 : 0));
		await discover(adapter);
		active = true;
		const sliced = await step(adapter, idFor(file));
		expect(sliced.records).toBe(1);
		expect(sliced.gaps).toEqual([]);
		expect(f.yields()).toBeGreaterThan(0);
		const before = clone(f.image.committed.head);
		let hardTicks = 0;
		const reopened = await f.open(new PrefixIndex(f.image), () => (++hardTicks >= 4 ? 101 : 0));
		await expect(step(reopened, idFor(file))).rejects.toThrow("pi-source-index-unavailable");
		expect(f.image.committed.head).toEqual(before);
		expect(durableRows(f).facts).toEqual([]);
	});

	it.each([
		"outside-root",
		"relative",
		"parent-traversal",
		"file-symlink",
		"directory-symlink",
		"hardlink",
		"directory",
	] as const)("rejects a synthetic %s source before any usage or metadata is trusted", async (which) => {
		const f = fixture();
		const safe = f.file("session", "safe.jsonl", [header("safe"), call("unsafe-if-followed")]);
		let unsafe: string;
		if (which === "outside-root" || which === "parent-traversal") {
			nativeFile(join(f.dir, "outside.jsonl"), [header("outside"), call("outside")]);
			unsafe = which === "outside-root" ? join(f.dir, "outside.jsonl") : `${f.roots.session[0]}/../outside.jsonl`;
		} else if (which === "relative") unsafe = "synthetic-relative-session.jsonl";
		else if (which === "file-symlink") {
			unsafe = join(f.roots.session[0], "linked.jsonl");
			symlinkSync(safe, unsafe);
		} else if (which === "directory-symlink") {
			const linked = join(f.roots.session[0], "linked-directory");
			symlinkSync(f.roots.session[0], linked, "dir");
			unsafe = join(linked, "safe.jsonl");
		} else if (which === "hardlink") {
			unsafe = join(f.roots.session[0], "hardlink.jsonl");
			linkSync(safe, unsafe);
		} else {
			unsafe = join(f.roots.session[0], "not-a-file");
			mkdirSync(unsafe);
		}
		f.catalog.entries = [{ file: unsafe, kind: "session", producer: "pi" }];
		const adapter = await f.open();
		await discover(adapter);
		const page = await adapter.required();
		const entries = await required(adapter);
		expect([...page.gaps, ...entries.flatMap((entry) => entry.gaps)]).toContain("unsafe-path");
		expect(entries.filter((entry) => entry.kind !== "gap").every((entry) => entry.state === "terminal-gap")).toBe(true);
		expect(indexed(f, "meta:")).toEqual([]);
		expect(durableRows(f).facts).toEqual([]);
		expect(receipts(f)).toEqual([]);
	});

	it("uses explicit native Temper roots, never a suggestive filename, to exclude Pi ownership", async () => {
		const f = fixture();
		const owned = f.file("session", "innocent-name.jsonl", [header("owned-by-temper"), call("temper-call")], {
			temper: true,
		});
		const pi = f.file("session", "temper-worker-run.jsonl", [header("ordinary-pi"), call("pi-call")]);
		const adapter = await f.open();
		await discover(adapter);
		const excluded = await step(adapter, idFor(owned));
		expect(excluded).toMatchObject({ action: "excluded", bytes: 0, records: 0, rows: emptyRows() });
		await finish(adapter, idFor(pi));
		expect(durableRows(f).facts.map((fact) => fact.source.event)).toEqual(["pi-call"]);
		expect(indexed(f, `meta:${idFor(owned)}:`)).toEqual([]);
		expect(indexed(f, `occ:${idFor(owned)}:`)).toEqual([]);
		expect((await required(adapter)).find((entry) => entry.id === idFor(owned))).toMatchObject({
			required: false,
			coverageOwner: "temper:T0",
			excluded: true,
			state: "excluded",
			usageCoverage: "unknown",
		});
	});

	it("keeps an explicitly unsupported ACP source out of Pi usage even when its native rows look numeric", async () => {
		const f = fixture();
		const file = f.file("session", "unsupported-acp.jsonl", [header("acp"), call("not-a-pi-call")], {
			producer: "acp",
		});
		const adapter = await f.open();
		await discover(adapter);
		expect(await step(adapter, idFor(file))).toMatchObject({
			action: "blocked",
			gaps: ["unsupported-acp"],
			batch: null,
		});
		expect((await required(adapter)).find((entry) => entry.id === idFor(file))).toMatchObject({
			state: "terminal-gap",
			collector: null,
		});
		expect(durableRows(f).facts).toEqual([]);
		expect(receipts(f)).toEqual([]);
	});

	it("never clears an unavailable inventory or unsupported obligations merely because a later page is clean", async () => {
		const f = fixture();
		f.file("session", "one.jsonl", [header("one")]);
		f.catalog.unavailable = true;
		const adapter = await f.open();
		expect((await adapter.discover()).gaps).toContain("inventory-unavailable");
		f.catalog.unavailable = false;
		await discover(adapter);
		expect((await adapter.required()).inventory).toBe("partial");
		expect((await adapter.required()).gaps).toContain("inventory-unavailable");
		await adapter.notify({ kind: "directory" });
		await discover(adapter);
		expect((await adapter.required()).inventory).toBe("complete");
		expect(
			(await required(adapter))
				.filter((entry) => entry.kind === "gap")
				.every((entry) => entry.state === "terminal-gap" && entry.usageCoverage === "unknown"),
		).toBe(true);
	});

	it("projects only occurrence identity/numbers without opening throwing payload getters", () => {
		const raw = call("projection", at(60), { response: "projection-response" });
		const message = raw.message as JsonRecord;
		const usage = message.usage as JsonRecord;
		let opened = 0;
		const poison = (object: object, key: string) =>
			Object.defineProperty(object, key, {
				configurable: true,
				get() {
					opened++;
					throw new Error("synthetic-forbidden-payload-getter");
				},
			});
		for (const key of ["cwd", "content", "prompt", "toJSON"]) poison(raw, key);
		for (const key of ["content", "request", "tools", "systemPrompt", "toJSON"]) poison(message, key);
		poison(usage, "details");
		const projected = projectPiSourceOccurrence(raw)!;
		expect(projected).toMatchObject({
			at: at(60),
			entry: "projection",
			entryAt: at(60),
			response: "projection-response",
			provider: "fixture-provider",
		});
		expect(projected.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(opened).toBe(0);
		assertPrivateProjection(projected);
		const changed = call("projection", at(60), { response: "projection-response", input: 2 });
		expect(projectPiSourceOccurrence(changed)!.fingerprint).not.toBe(projected.fingerprint);
	});

	it("rejects an allowed-field accessor without invoking it and ignores tool/user usage payloads", () => {
		let opened = 0;
		const raw = call("accessor");
		Object.defineProperty(raw.message as object, "usage", {
			get() {
				opened++;
				throw new Error("synthetic-allowed-accessor");
			},
		});
		expect(() => projectPiSourceOccurrence(raw)).toThrow("pi-source-metadata");
		for (const role of ["user", "toolResult"]) {
			const message = { role };
			Object.defineProperty(message, "usage", {
				get() {
					opened++;
					throw new Error("synthetic-nonassistant-usage");
				},
			});
			expect(projectPiSourceOccurrence({ type: "message", message })).toBeNull();
		}
		expect(opened).toBe(0);
	});

	it("rejects a catalog file object before invoking even a nested throwing toJSON payload", async () => {
		const f = fixture();
		let opened = 0;
		const malformed = {
			file: {
				nested: {
					payload: SECRET,
					toJSON() {
						opened++;
						throw new Error("synthetic-nested-catalog-payload");
					},
				},
			},
			kind: "session",
			producer: "pi",
		};
		// The catalog must hand the raw malformed entry to W3; a test-double JSON clone would open it first.
		f.catalog.page = async () => ({
			generation: "synthetic-malformed-catalog",
			entries: [malformed as unknown as PiCatalogEntry],
			next: null,
			status: "complete",
		});
		const adapter = await f.open();
		const before = clone(f.image.committed.head);
		await expect(adapter.discover()).rejects.toThrow("pi-source-index-unavailable");
		expect(opened).toBe(0);
		expect(f.image.committed.head).toEqual(before);
		expect(indexed(f, "source:")).toEqual([]);
		expect(durableRows(f).facts).toEqual([]);
	});

	it("does not serialize raw catalog entries or retain planted source payloads in any committed lane", async () => {
		const { f, ids } = taskFixture();
		let opened = 0;
		for (const entry of f.catalog.entries) {
			for (const key of ["prompt", "title", "toJSON"])
				Object.defineProperty(entry, key, {
					get() {
						opened++;
						throw new Error("synthetic-catalog-payload");
					},
				});
		}
		const adapter = await f.open();
		await discover(adapter);
		for (const id of ids) await finish(adapter, id);
		await adapter.membership(ids);
		expect(opened).toBe(0);
		for (const [, text] of f.image.committed.values) assertPrivateProjection(JSON.parse(text));
		for (const unit of f.image.committed.units) {
			assertPrivateProjection(unit.rows);
			if (unit.native) assertPrivateProjection(unit.native);
		}
	});
});
