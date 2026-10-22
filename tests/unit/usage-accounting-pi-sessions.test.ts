import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
	COLLECTOR_LIMITS,
	UsageAccountingCollector,
	type CollectorIO,
	type NumericRows,
	type SourceBatch,
	type SourceCursor,
	type SourceInventory,
} from "../../server/usage-accounting-collector.js";
import {
	accountUsage,
	factId,
	parseAccountingInput,
	type AccountingInput,
	type UsageFact,
} from "../../server/usage-accounting-contract.js";
import {
	PI_SESSION_LIMITS,
	PI_RECORDED_RATE_VERSION,
	PiSessionUsageReader,
	type PiSessionReadRequest,
	type PiSessionReadResult,
} from "../../server/usage-accounting-pi-sessions.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/usage-accounting-pi-sessions/", import.meta.url));
const FROM = "2026-10-19T07:00:00.000Z";
const AS_OF = "2026-10-19T09:00:00.000Z";
const SECRET = "SYNTHETIC_ONLY_NEVER_PROJECT_8c27";
const dirs: string[] = [];
interface FixedCase {
	entries: string[];
	amounts: (string | null)[];
	faults: string[];
	aliases?: [string, string][];
	kinds?: UsageFact["kind"][];
	roundedAmounts?: number;
}
const golden = JSON.parse(readFileSync(join(FIXTURES, "expected.json"), "utf8")) as Record<string, FixedCase> & {
	faultLines: Record<string, number[]>;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "usage-pi-synthetic-"));
	dirs.push(dir);
	return dir;
}
function request(name: string, extra: Partial<PiSessionReadRequest> = {}): PiSessionReadRequest {
	return {
		file: join(FIXTURES, `${name}.jsonl`),
		producer: "pi",
		from: FROM,
		through: AS_OF,
		observedAt: AS_OF,
		...extra,
	};
}
function digest(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}
function stream(file: string): string {
	return `pi-session:${digest(resolve(file))}`;
}
function noRows(): NumericRows {
	return { facts: [], allocations: [], aliases: [], roots: [], policies: [], memberships: [], snapshots: [] };
}
function fact(options: {
	file: string;
	session: string;
	entry: string;
	at: string;
	tokens: [number | null, number | null, number | null, number | null];
	response?: string;
	kind?: UsageFact["kind"];
	producer?: "pi" | "acp";
	origin?: string;
	unresolved?: boolean;
	price?: "unpriced" | "unknown-model";
	amount?: string;
	unknownModel?: boolean;
}): UsageFact {
	const provider = options.unknownModel ? "unknown" : "fixture-provider";
	const identity = {
		producer: options.producer ?? "pi",
		incarnation: options.session,
		attempt: options.response
			? `response:${digest(JSON.stringify([provider, options.response, stream(options.file), options.entry]))}`
			: options.entry,
	};
	const [input, output, cacheRead, cacheWrite] = options.tokens;
	return {
		v: "usage-fact/1",
		id: factId(identity),
		revision: 0,
		supersedes: null,
		identity,
		identityStatus: options.unresolved ? "unresolved" : "verified",
		occurredAt: options.at,
		provider,
		model: options.unknownModel ? "unknown" : "fixture-model",
		kind: options.kind ?? "assistant",
		tokens: { input, output, cacheRead, cacheWrite },
		prices: [
			{
				basis: "list-estimate",
				currency: "USD",
				amount: options.price ? null : (options.amount ?? "0.01"),
				status: options.price ?? "known",
				rateVersion: options.price ? null : PI_RECORDED_RATE_VERSION,
			},
		],
		source: { stream: stream(options.file), event: options.entry, observedAt: AS_OF, coverage: "complete" },
		links: { task: null, session: options.origin ?? options.session, run: null },
	};
}
function at(minute: number): string {
	return `2026-10-19T08:${String(minute).padStart(2, "0")}:00.000Z`;
}
function plainFacts(file = request("plain").file): UsageFact[] {
	return [
		fact({
			file,
			session: "session-plain",
			entry: "call-1",
			at: at(2),
			tokens: [10, 2, 3, 4],
			response: "response-1",
			amount: "0.1",
		}),
		fact({ file, session: "session-plain", entry: "fallback-1", at: at(3), tokens: [5, 1, 0, 0], amount: "0.02" }),
	];
}
function assertFixed(name: string, value: PiSessionReadResult, prior: PiSessionReadResult[] = []): void {
	const expected = golden[name];
	expect(value.batch).not.toBeNull();
	expect(value.batch!.rows.facts.map((f) => f.source.event)).toEqual(expected.entries);
	expect(value.observations.map((o) => o.recordedPrice.amount)).toEqual(expected.amounts);
	expect(value.roundedAmounts).toBe(expected.roundedAmounts ?? 0);
	expect(value.faults).toEqual(expected.faults.map((code, i) => ({ code, line: golden.faultLines[name][i] })));
	const facts = new Map([...prior, value].flatMap((r) => r.batch?.rows.facts ?? []).map((f) => [f.id, f]));
	expect(
		value.batch!.rows.aliases.map((a) => [
			facts.get(a.aliasFactId)?.source.event,
			facts.get(a.canonicalFactId)?.source.event,
		]),
	).toEqual(expected.aliases ?? []);
	if (expected.kinds) expect(value.batch!.rows.facts.map((f) => f.kind)).toEqual(expected.kinds);
	expect(value.batch!.rows.allocations).toEqual([]);
	expect(value.batch!.rows.roots).toEqual([]);
	expect(value.batch!.rows.policies).toEqual([]);
	expect(value.batch!.rows.memberships).toEqual([]);
	expect(value.batch!.rows.snapshots).toEqual([]);
	expect(JSON.stringify(value)).not.toContain(SECRET);
}
/** Synthetic in-memory collector port; no paths, roots, model calls or live inventory. */
class MemoryIO implements CollectorIO {
	segments: string[] = [];
	image: string | null = null;
	async read() {
		return { segments: [...this.segments], checkpoint: this.image };
	}
	async append(segment: number, expectedBytes: number, line: string) {
		const current = this.segments[segment - 1] ?? "";
		expect(Buffer.byteLength(current)).toBe(expectedBytes);
		this.segments[segment - 1] = current + line;
	}
	async sync() {}
	async checkpoint(text: string) {
		this.image = text;
	}
}
async function accepts(results: PiSessionReadResult[]): Promise<MemoryIO> {
	const sources = [...new Map(results.filter((r) => r.source).map((r) => [r.source!.stream, r.source!])).values()];
	const inventory: SourceInventory = {
		v: "usage-inventory/1",
		evidenceRef: "fixture-only:explicit-sessions",
		observedAt: AS_OF,
		complete: false,
		sources,
	};
	const io = new MemoryIO();
	const collector = await UsageAccountingCollector.open({
		inventory,
		io,
		clock: () => 0,
		verifier: { inventory: () => true, batch: (b) => b.adapterRef === "pi-session-jsonl/1" },
	});
	for (const result of results) {
		if (!result.batch) continue;
		// Compile-time structural compatibility with the unchanged collector, without a production dependency.
		const batch: SourceBatch = result.batch;
		const cursor: SourceCursor | null = result.cursor;
		expect(cursor).toEqual(batch.toCursor);
		expect(
			parseAccountingInput({ v: 1, ...result.batch.rows, coverage: [], requiredStreams: [result.batch.stream] }).ok,
		).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(result.batch))).toBeLessThanOrEqual(COLLECTOR_LIMITS.batchBytes);
		expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(PI_SESSION_LIMITS.batchBytes);
		const committed = await collector.collect(result.batch.stream, JSON.stringify(result.batch), AS_OF);
		expect(committed.code).toBeNull();
		expect(committed.status).toBe("committed");
	}
	expect(JSON.stringify(io)).not.toContain(SECRET);
	return io;
}
function syntheticHeader(id = "scratch-session"): string {
	return JSON.stringify({ type: "session", version: 3, id, timestamp: at(0), cwd: "/synthetic-only" }) + "\n";
}
function syntheticCall(id: string, minute = 23): string {
	return (
		JSON.stringify({
			type: "message",
			id,
			parentId: null,
			timestamp: at(minute),
			message: {
				role: "assistant",
				provider: "fixture-provider",
				model: "fixture-model",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				content: [{ type: "text", text: SECRET }],
			},
		}) + "\n"
	);
}
interface OversizedLine {
	kind: "header" | "call" | "tool";
	id?: string;
	minute?: number;
	bytes?: number;
	escapes?: boolean;
	torn?: boolean;
}
interface OversizedFile {
	lines: OversizedLine[];
	entries: string[];
	faults: { code: string; line: number }[];
}
const oversized = JSON.parse(readFileSync(join(FIXTURES, "oversized-lines.json"), "utf8")) as {
	escape: string;
	files: Record<string, OversizedFile>;
};
/** One oversized-lines.json line at its exact byte length; its text starts with the planted secret. */
function oversizedLine(spec: OversizedLine, session: string): string {
	if (spec.kind === "header") return syntheticHeader(session);
	const line = (text: string) =>
		JSON.stringify({
			type: "message",
			id: spec.id,
			parentId: null,
			timestamp: at(spec.minute!),
			message:
				spec.kind === "call"
					? {
							role: "assistant",
							provider: "fixture-provider",
							model: "fixture-model",
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
							content: [{ type: "text", text }],
						}
					: {
							role: "toolResult",
							toolCallId: `${spec.id}-call`,
							toolName: "bash",
							content: [{ type: "text", text }],
							isError: false,
							timestamp: Date.parse(at(spec.minute!)),
						},
		}) + "\n";
	if (!spec.bytes) return line(SECRET);
	const unit = spec.escapes ? oversized.escape : "y";
	const unitBytes = JSON.stringify(unit).length - 2;
	const room = spec.bytes - Buffer.byteLength(line(SECRET));
	const built = line(SECRET + unit.repeat(Math.floor(room / unitBytes)) + "y".repeat(room % unitBytes));
	expect(Buffer.byteLength(built)).toBe(spec.bytes);
	return built;
}
function buildOversized(name: string): string {
	const spec = oversized.files[name];
	const file = join(scratch(), `${name}.jsonl`);
	const text = spec.lines.map((line) => oversizedLine(line, `session-${name}`)).join("");
	writeFileSync(file, spec.lines.at(-1)!.torn ? text.slice(0, -1) : text);
	return file;
}

describe("inert persisted Pi usage reader (synthetic files only)", () => {
	it("projects exact plain facts and never counts a parent's tool-result usage", async () => {
		const r = await new PiSessionUsageReader().read(request("plain"));
		assertFixed("plain", r);
		expect(r.batch!.rows.facts).toEqual(plainFacts());
		expect(r.status).toBe("complete");
		expect(r.source).toEqual({
			stream: stream(request("plain").file),
			incarnation: "session-plain",
			adapterRef: "pi-session-jsonl/1",
			producer: "pi",
			occurrenceStreams: [stream(request("plain").file)],
			retainedFrom: FROM,
			grants: ["facts", "aliases"],
		});
		expect(r.batch!.rows.facts.map((f) => f.prices[0].amount)).toEqual(["0.1", "0.02"]);
		expect(r.batch!.rows.facts.every((f) => f.prices[0].rateVersion === "pi-recorded-1")).toBe(true);
		expect(r.observations.map((o) => o.responseId)).toEqual(["response-1", null]);
		expect(r.observations.every((o) => o.disposition === "original")).toBe(true);
		await accepts([r]);
	});

	it("aliases response ids and id+timestamp copied parent history; resume copies never rewrite evidence", async () => {
		const reader = new PiSessionUsageReader();
		const plain = await reader.read(request("plain"));
		const fork = await reader.read(request("fork"));
		const resume = await reader.read(request("resume-copy"));
		assertFixed("fork", fork, [plain]);
		assertFixed("resume-copy", resume, [plain, fork]);
		const file = request("fork").file;
		const expectedFork = [
			fact({
				file,
				session: "session-fork",
				entry: "call-1",
				response: "response-1",
				at: at(2),
				tokens: [10, 2, 3, 4],
				amount: "0.1",
				origin: "session-plain",
			}),
			fact({
				file,
				session: "session-fork",
				entry: "fallback-1",
				at: at(3),
				tokens: [5, 1, 0, 0],
				amount: "0.02",
				origin: "session-plain",
			}),
			fact({ file, session: "session-fork", entry: "fork-new", at: at(5), tokens: [7, 2, 0, 0], amount: "0.03" }),
		];
		expect(fork.batch!.rows.facts).toEqual(expectedFork);
		expect(resume.batch!.rows.facts).toEqual([plainFacts(request("resume-copy").file)[0]]);
		expect(fork.batch!.rows.aliases).toEqual(
			expectedFork.slice(0, 2).map((f, i) => ({
				aliasFactId: f.id,
				canonicalFactId: plainFacts()[i].id,
				provenance: "native-call-map/1",
				evidenceRef: `pi-session-map:${digest(JSON.stringify([i === 0 ? "response-1" : null, f.source.event, i === 0 ? "2026-10-19T08:02:01.000Z" : at(3)]))}`,
			})),
		);
		expect(resume.observations.map((o) => o.disposition)).toEqual(["alias", "alias"]);
		expect(resume.observations[1].canonicalFactId).toBe(plainFacts()[1].id);
		await accepts([plain, fork, resume]);
	});

	it("reads standalone cache warming and other usage, compaction and branch summaries without inferring a model", async () => {
		const r = await new PiSessionUsageReader().read(request("usage-kinds"));
		assertFixed("usage-kinds", r);
		const file = request("usage-kinds").file;
		expect(r.batch!.rows.facts).toEqual([
			fact({
				file,
				session: "session-kinds",
				entry: "warm-1",
				at: at(6),
				tokens: [0, 0, 0, 8],
				kind: "cache-warm",
				amount: "0.004",
			}),
			fact({ file, session: "session-kinds", entry: "other-1", at: at(7), tokens: [1, 1, 0, 0], amount: "0.006" }),
			fact({
				file,
				session: "session-kinds",
				entry: "compact-1",
				at: at(8),
				tokens: [4, 2, 0, 0],
				kind: "compaction",
				unknownModel: true,
				price: "unknown-model",
			}),
			fact({
				file,
				session: "session-kinds",
				entry: "branch-1",
				at: at(9),
				tokens: [6, 2, 0, 0],
				kind: "compaction",
				unknownModel: true,
				price: "unknown-model",
			}),
		]);
		await accepts([r]);
	});

	it("counts recorded totals with explicit half-even rounding, but missing/invalid prices remain UNKNOWN", async () => {
		const r = await new PiSessionUsageReader().read(request("prices"));
		assertFixed("prices", r);
		const file = request("prices").file;
		expect(r.batch!.rows.facts).toEqual(
			golden.prices.entries.map((entry, i) =>
				fact({
					file,
					session: "session-prices",
					entry,
					at: at(i + 11),
					tokens:
						entry === "zero-unknown-tokens"
							? [null, 0, 0, 0]
							: entry === "zero-tokens" || entry === "nonzero-total-tokens"
								? [0, 0, 0, 0]
								: entry === "missing-cost"
									? [1, 2, 0, 0]
									: [1, 0, 0, 0],
					kind: i >= 3 ? "cache-warm" : "assistant",
					...(golden.prices.amounts[i] === null
						? { price: "unpriced" as const }
						: { amount: golden.prices.amounts[i]! }),
				}),
			),
		);
		expect(r.roundedAmounts).toBe(8);
		expect(
			r.batch!.rows.facts.every((f) => f.prices[0].status !== "known" || f.prices[0].rateVersion === "pi-recorded-1"),
		).toBe(true);
		expect(r.observations.every((o) => o.recordedPrice.rateVersion === null)).toBe(true);
		expect(r.batch!.rows.facts.find((f) => f.source.event === "float-noise")!.prices[0].amount).toBe("0.3");
		await accepts([r]);
	});

	it("does not open a missing parent and explicitly excludes unverified identity from verified totals", async () => {
		const r = await new PiSessionUsageReader().read(request("unresolved-parent"));
		assertFixed("unresolved-parent", r);
		expect(r.batch!.rows.facts[0]).toEqual(
			fact({
				file: request("unresolved-parent").file,
				session: "session-unresolved",
				entry: "unverified-1",
				at: at(16),
				tokens: [3, 1, 0, 0],
				unresolved: true,
			}),
		);
		expect(r.observations[1].factId).toBeNull();
		expect(r.observations.every((o) => o.disposition === "unverified")).toBe(true);
		await accepts([r]);
		const input = reportingInput([r]);
		expect(input.facts[0].prices[0]).toEqual({
			basis: "list-estimate",
			currency: "USD",
			amount: "0.01",
			status: "known",
			rateVersion: "pi-recorded-1",
		});
		const report = accountUsage(input, { policyRef: "fixture-only:policy", asOf: AS_OF, staleAfterMs: 3_600_000 });
		expect(report.unresolvedIdentities).toBe(1);
		expect(report.dedupKnownListUsd).toBe("0");
		expect(report.verifiedOwnLowerBoundUsd).toBe("0");
	});

	it("reads the delegate's own file as ACP; deduplicated synthetic known prices prove copies are not extra charges", async () => {
		const reader = new PiSessionUsageReader();
		const results: PiSessionReadResult[] = [];
		for (const name of ["plain", "fork", "resume-copy", "delegate"])
			results.push(await reader.read(request(name, { producer: name === "delegate" ? "acp" : "pi" })));
		const delegate = results[3];
		assertFixed("delegate", delegate);
		expect(delegate.batch!.rows.facts).toEqual([
			fact({
				file: request("delegate").file,
				session: "session-delegate",
				entry: "delegate-1",
				response: "reported-delegate-response",
				at: at(18),
				tokens: [9, 2, 0, 0],
				amount: "0.04",
				producer: "acp",
			}),
		]);
		await accepts(results);
		const input = reportingInput(results);
		// Account the reader's actual prices unchanged: recorded estimates must reach the totals.
		expect(input.facts.every((f) => f.prices[0].rateVersion === "pi-recorded-1")).toBe(true);
		expect(parseAccountingInput(input).ok).toBe(true);
		const report = accountUsage(input, { policyRef: "fixture-only:policy", asOf: AS_OF, staleAfterMs: 3_600_000 });
		expect(report.grossKnownListUsd).toBe("0.41");
		expect(report.dedupKnownListUsd).toBe("0.19");
		expect(report.unresolvedIdentities).toBe(0);
	});

	it("reports a torn final line and leaves the byte cursor before it", async () => {
		const r = await new PiSessionUsageReader().read(request("torn"));
		assertFixed("torn", r);
		expect(r.batch!.rows.facts).toEqual([
			fact({
				file: request("torn").file,
				session: "session-torn",
				entry: "before-torn",
				at: at(19),
				tokens: [1, 1, 0, 0],
			}),
		]);
		expect(r.status).toBe("partial");
		expect(r.batch!.status).toBe("partial");
		expect(r.endOfFile).toBe(false);
		const bytes = readFileSync(request("torn").file);
		const lastCompleteEnd = bytes.lastIndexOf(10) + 1;
		expect(r.cursor!.ordinal).toBe(2);
		expect(Number(r.cursor!.token.split(":")[1])).toBe(lastCompleteEnd);
		expect(r.cursor!.token.split(":")[4]).toBe(digest(bytes.subarray(bytes.indexOf(10) + 1, lastCompleteEnd)));
		await accepts([r]);
	});

	it("stops on the fixed oversized line without parsing or silently skipping it", async () => {
		const reader = new PiSessionUsageReader({ lineBytes: 512 });
		const r = await reader.read(request("oversized"));
		expect(r.faults).toEqual([{ code: "line-limit", line: 2 }]);
		expect(r.observations).toEqual([]);
		expect(r.cursor!.ordinal).toBe(1);
		expect(r.batch!.rows).toEqual(noRows());
		expect(r.status).toBe("partial");
		await accepts([r]);
	});

	it("reads a week-shaped file past 64 KiB-4 MiB lines to its end, one line per read past the budget (#421)", async () => {
		const spec = oversized.files["week-shaped"];
		const file = buildOversized("week-shaped");
		const probe = await open(file, "r");
		const handle = Object.getPrototypeOf(probe) as FileHandle;
		await probe.close();
		// Every distinct buffer the reader reads the file into, per read: an upper bound on the file bytes it holds.
		const spy = vi.spyOn(handle, "read");
		const reader = new PiSessionUsageReader();
		const results: PiSessionReadResult[] = [];
		const held: number[] = [];
		try {
			let cursor: PiSessionReadResult["cursor"] = null;
			while (!results.at(-1)?.endOfFile && results.length < spec.lines.length) {
				spy.mockClear();
				const r = await reader.read(request("plain", { file, cursor }));
				const buffers = new Set(spy.mock.calls.map((call) => call[0] as unknown as Uint8Array));
				held.push([...buffers].reduce((n, b) => n + b.byteLength, 0));
				expect(r.cursor!.ordinal).toBeGreaterThan(cursor?.ordinal ?? 0); // Every read moves on: no stall.
				results.push(r);
				cursor = r.cursor;
			}
		} finally {
			spy.mockRestore();
		}
		const last = results.at(-1)!;
		expect(last).toMatchObject({ endOfFile: true, status: "complete", faults: spec.faults });
		expect(last.cursor!.ordinal).toBe(spec.lines.length);
		expect(Number(last.cursor!.token.split(":")[1])).toBe(statSync(file).size);
		expect(results.flatMap((r) => r.batch!.rows.facts.map((f) => f.source.event))).toEqual(spec.entries);
		// Each earlier read stops at the line after the one it let past the budget.
		expect(results.slice(0, -1).map((r) => r.faults.map((f) => f.code))).toEqual(
			results.slice(0, -1).map(() => ["read-limit"]),
		);
		expect(results).toHaveLength(7);
		// H-S1: one line of at most lineBytes on top of the read budget, i.e. 4.25 MiB.
		expect(Math.max(...held)).toBeLessThanOrEqual(PI_SESSION_LIMITS.readBytes + PI_SESSION_LIMITS.lineBytes);
		await accepts(results);
	});

	it("still stops with line-limit past 4 MiB: partial, earlier usage kept, the line never skipped (#421)", async () => {
		const spec = oversized.files["over-cap"];
		const file = buildOversized("over-cap");
		const reader = new PiSessionUsageReader();
		const first = await reader.read(request("plain", { file }));
		expect(first).toMatchObject({ status: "partial", endOfFile: false, faults: spec.faults });
		expect(first.cursor!.ordinal).toBe(2);
		expect(first.batch!.rows.facts.map((f) => f.source.event)).toEqual(spec.entries);
		const again = await reader.read(request("plain", { file, cursor: first.cursor }));
		expect(again).toMatchObject({ status: "partial", batch: null, cursor: first.cursor, faults: spec.faults });
		await accepts([first, again]);
	});

	it("leaves an oversized torn last line unread until its newline arrives, then reads to the end (#421)", async () => {
		const spec = oversized.files["torn-oversized"];
		const file = buildOversized("torn-oversized");
		const reader = new PiSessionUsageReader();
		const first = await reader.read(request("plain", { file }));
		expect(first).toMatchObject({ status: "partial", endOfFile: false, faults: spec.faults });
		expect(first.batch!.rows.facts.map((f) => f.source.event)).toEqual(spec.entries);
		writeFileSync(file, "\n", { flag: "a" });
		const completed = await reader.read(request("plain", { file, cursor: first.cursor }));
		expect(completed).toMatchObject({ status: "complete", endOfFile: true, faults: [] });
		expect(completed.batch!.rows.facts.map((f) => f.source.event)).toEqual(["torn-3"]);
		await accepts([first, completed]);
	});

	it("retains valid numeric fields around invalid JSON and marks incomplete tokens null, never zero", async () => {
		const r = await new PiSessionUsageReader().read(request("invalid"));
		assertFixed("invalid", r);
		expect(r.status).toBe("partial");
		expect(r.batch!.rows.facts).toEqual([
			fact({
				file: request("invalid").file,
				session: "session-invalid",
				entry: "bad-tokens",
				at: at(20),
				tokens: [null, 2, 0, 0],
			}),
			fact({
				file: request("invalid").file,
				session: "session-invalid",
				entry: "after-invalid",
				at: at(21),
				tokens: [1, 1, 0, 0],
			}),
		]);
		await accepts([r]);
	});

	it("accepts SDK millisecond assistant timestamps and gives them precedence over entry time", async () => {
		const file = join(scratch(), "milliseconds.jsonl");
		const call = JSON.parse(syntheticCall("milliseconds"));
		call.message.timestamp = Date.parse(at(24));
		writeFileSync(file, syntheticHeader() + JSON.stringify(call) + "\n");
		const r = await new PiSessionUsageReader().read(request("plain", { file }));
		expect(r.batch!.rows.facts[0].occurredAt).toBe(at(24));
		await accepts([r]);
	});

	it("resumes by byte offset and line count, verifies the saved last-line hash, and never fakes EOF progress", async () => {
		const file = join(scratch(), "append.jsonl");
		writeFileSync(file, syntheticHeader() + syntheticCall("first"));
		const reader = new PiSessionUsageReader();
		const first = await reader.read(request("plain", { file }));
		writeFileSync(file, readFileSync(file, "utf8") + syntheticCall("second", 24));
		const second = await reader.read(request("plain", { file, cursor: first.cursor }));
		expect(second.batch!.fromCursor).toEqual(first.cursor);
		expect(second.batch!.rows.facts.map((f) => f.source.event)).toEqual(["second"]);
		expect(second.cursor!.ordinal).toBe(3);
		expect(Number(second.cursor!.token.split(":")[1])).toBe(statSync(file).size);
		const idle = await reader.read(request("plain", { file, cursor: second.cursor }));
		expect(idle.batch).toBeNull();
		expect(idle.cursor).toEqual(second.cursor);
		expect(idle.status).toBe("complete");
		await accepts([first, second, idle]);
		writeFileSync(file, readFileSync(file, "utf8").replace('"second"', '"tamper"'));
		const changed = await reader.read(request("plain", { file, cursor: second.cursor }));
		expect(changed.batch).toBeNull();
		expect(changed.faults).toEqual([{ code: "cursor-changed", line: 3 }]);
		expect(changed.status).toBe("partial");
	});

	it("reports truncated and unreadable files explicitly, without manufacturing a cursor or batch", async () => {
		const file = join(scratch(), "truncate.jsonl");
		writeFileSync(file, syntheticHeader() + syntheticCall("before-truncate"));
		const reader = new PiSessionUsageReader();
		const first = await reader.read(request("plain", { file }));
		writeFileSync(file, syntheticHeader());
		const truncated = await reader.read(request("plain", { file, cursor: first.cursor }));
		expect(truncated.faults).toEqual([{ code: "source-truncated", line: 2 }]);
		expect(truncated.batch).toBeNull();
		expect(truncated.status).toBe("partial");
		const unreadable = await reader.read(request("plain", { file: join(scratch(), "absent.jsonl") }));
		expect(unreadable).toMatchObject({
			source: null,
			batch: null,
			cursor: null,
			status: "partial",
			faults: [{ code: "source-unreadable", line: 0 }],
		});
		expect(JSON.stringify(unreadable)).not.toContain("absent");
	});

	it("recovers a torn line only after its final newline is present", async () => {
		const file = join(scratch(), "torn.jsonl");
		const call = syntheticCall("later-complete");
		writeFileSync(file, syntheticHeader() + call.slice(0, -1));
		const reader = new PiSessionUsageReader();
		const first = await reader.read(request("plain", { file }));
		expect(first.faults).toEqual([{ code: "partial-last-line", line: 2 }]);
		writeFileSync(file, syntheticHeader() + call);
		const completed = await reader.read(request("plain", { file, cursor: first.cursor }));
		expect(completed.batch!.rows.facts.map((f) => f.source.event)).toEqual(["later-complete"]);
		expect(completed.status).toBe("complete");
		await accepts([first, completed]);
	});

	it("bounds each input scan, output batch, numeric identity index and source inventory", async () => {
		const file = join(scratch(), "bounded.jsonl");
		writeFileSync(
			file,
			syntheticHeader() + Array.from({ length: 12 }, (_, i) => syntheticCall(`bounded-${i}`)).join(""),
		);
		const reader = new PiSessionUsageReader({ batchRows: 2, batchBytes: 8192 });
		const results: PiSessionReadResult[] = [];
		let cursor: PiSessionReadResult["cursor"] = null;
		for (let i = 0; i < 7; i++) {
			const r = await reader.read(request("plain", { file, cursor }));
			results.push(r);
			expect(r.batch!.rows.facts.length).toBeLessThanOrEqual(2);
			expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(8192);
			cursor = r.cursor;
			if (r.endOfFile) break;
		}
		expect(results.at(-1)!.endOfFile).toBe(true);
		expect(results.flatMap((r) => r.batch!.rows.facts).map((f) => f.source.event)).toEqual(
			Array.from({ length: 12 }, (_, i) => `bounded-${i}`),
		);
		await accepts(results);
		const capped = await new PiSessionUsageReader({ readBytes: 512 }).read(request("plain", { file }));
		expect(capped.status).toBe("partial");
		expect(capped.faults.some((f) => f.code === "read-limit")).toBe(true);
		const index = await new PiSessionUsageReader({ indexEntries: 1 }).read(request("plain"));
		expect(index.faults.at(-1)).toEqual({ code: "index-limit", line: 5 });
		const sourceReader = new PiSessionUsageReader({ sources: 1 });
		await sourceReader.read(request("plain"));
		expect((await sourceReader.read(request("delegate"))).faults).toEqual([{ code: "index-limit", line: 1 }]);
	});

	it("rejects conflicting response evidence instead of aliasing a different cost or timestamp", async () => {
		const file = join(scratch(), "conflict.jsonl");
		copyFileSync(request("resume-copy").file, file);
		writeFileSync(file, readFileSync(file, "utf8").replace('"total":0.1', '"total":0.9'));
		const reader = new PiSessionUsageReader();
		const plain = await reader.read(request("plain"));
		const conflict = await reader.read(request("plain", { file }));
		expect(conflict.batch!.rows.facts).toEqual([]);
		expect(conflict.observations[0].disposition).toBe("unverified");
		expect(conflict.faults).toContainEqual({ code: "identity-unverified", line: 2 });
		expect(conflict.batch!.rows.aliases).toEqual([]);
		await accepts([plain, conflict]);
	});

	it("closed outputs do not leak planted content, invalid JSON, paths, cursor extras or returned-object mutations", async () => {
		const reader = new PiSessionUsageReader();
		const results: PiSessionReadResult[] = [];
		for (const name of Object.keys(golden).filter((name) => name !== "faultLines"))
			results.push(await reader.read(request(name)));
		const plain = results[0];
		plain.batch!.rows.facts[0].provider = SECRET;
		const copy = await reader.read(request("resume-copy"));
		expect(JSON.stringify(copy)).not.toContain(SECRET);
		const badCursor = await reader.read(request("plain", { cursor: { ordinal: 1, token: SECRET } }));
		expect(badCursor.faults).toEqual([{ code: "cursor-invalid", line: 1 }]);
		expect(badCursor.cursor).toBeNull();
		const cursorWithExtra = { ...plain.cursor!, unexpected: SECRET };
		const noExtra = await reader.read(request("plain", { cursor: cursorWithExtra }));
		expect(JSON.stringify(noExtra)).not.toContain(SECRET);
		for (const r of [...results.slice(1), copy, badCursor]) {
			const text = JSON.stringify(r);
			expect(text).not.toContain(SECRET);
			for (const forbidden of ['"content"', '"arguments"', '"details"', '"summary"', '"note"', '"cwd"', FIXTURES])
				expect(text).not.toContain(forbidden);
		}
	});

	it("leaves an out-of-window record before the cursor rather than silently discarding its usage", async () => {
		const reader = new PiSessionUsageReader();
		const first = await reader.read(request("plain", { through: at(2) }));
		expect(first.cursor!.ordinal).toBe(4);
		expect(first.batch!.rows.facts.map((f) => f.source.event)).toEqual(["call-1"]);
		expect(first.faults.at(-1)).toEqual({ code: "window-mismatch", line: 5 });
		const second = await reader.read(request("plain", { from: at(3), cursor: first.cursor }));
		expect(second.batch!.rows.facts.map((f) => f.source.event)).toEqual(["fallback-1"]);
		expect(second.source!.retainedFrom).toBe(FROM);
		await accepts([first, second]);
	});

	it("bounds diagnostics for many malformed lines and does not treat an invalid response id as a verified fallback", async () => {
		const dir = scratch();
		const malformed = join(dir, "many-malformed.jsonl");
		writeFileSync(malformed, syntheticHeader() + ("!" + SECRET + "\n").repeat(2000));
		const r = await new PiSessionUsageReader().read(request("plain", { file: malformed }));
		expect(r.faults.at(-1)?.code).toBe("batch-limit");
		expect(r.faults.length).toBeLessThanOrEqual(COLLECTOR_LIMITS.batchRows + 1);
		expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(PI_SESSION_LIMITS.batchBytes);
		expect(JSON.stringify(r)).not.toContain(SECRET);
		const file = join(dir, "invalid-response.jsonl");
		const call = JSON.parse(syntheticCall("invalid-response"));
		call.message.responseId = { secret: SECRET };
		writeFileSync(file, syntheticHeader() + JSON.stringify(call) + "\n");
		const invalid = await new PiSessionUsageReader().read(request("plain", { file }));
		expect(invalid.batch!.rows.facts).toEqual([]);
		expect(invalid.observations[0].disposition).toBe("unverified");
		expect(invalid.faults.at(-1)?.code).toBe("identity-unverified");
		await accepts([r, invalid]);
	});

	it("preserves frozen caps and fixed errors without a collector dependency", async () => {
		expect({
			batchBytes: PI_SESSION_LIMITS.batchBytes,
			readBytes: PI_SESSION_LIMITS.readBytes,
			batchRows: PI_SESSION_LIMITS.batchRows,
			indexEntries: PI_SESSION_LIMITS.indexEntries,
			sources: PI_SESSION_LIMITS.sources,
			spanMs: PI_SESSION_LIMITS.spanMs,
		}).toEqual({
			batchBytes: COLLECTOR_LIMITS.batchBytes,
			readBytes: COLLECTOR_LIMITS.batchBytes,
			batchRows: COLLECTOR_LIMITS.batchRows,
			indexEntries: COLLECTOR_LIMITS.historyRows,
			sources: COLLECTOR_LIMITS.sources,
			spanMs: COLLECTOR_LIMITS.spanMs,
		});
		expect(PI_SESSION_LIMITS.lineBytes).toBe(4_194_304); // #421: newline included; overrides only lower it.
		expect(() => new PiSessionUsageReader({ lineBytes: PI_SESSION_LIMITS.lineBytes + 1 })).toThrow("pi-session-limits");
		const source = readFileSync(new URL("../../server/usage-accounting-pi-sessions.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(/(?:from\s*|import\s*\()["'][^"']*usage-accounting-collector/);
		const file = join(scratch(), "old-header.jsonl");
		writeFileSync(file, syntheticHeader().replace('"version":3', '"version":2'));
		expect((await new PiSessionUsageReader().read(request("plain", { file }))).faults).toEqual([
			{ code: "header-invalid", line: 1 },
		]);
		expect(() => new PiSessionUsageReader({ batchBytes: 1 })).toThrow("pi-session-limits");
		await expect(new PiSessionUsageReader().read(request("plain", { through: FROM, from: AS_OF }))).rejects.toThrow(
			"pi-session-request",
		);
	});
});

function reportingInput(results: PiSessionReadResult[]): AccountingInput {
	const rows = noRows();
	for (const result of results) {
		if (!result.batch) continue;
		rows.facts.push(...structuredClone(result.batch.rows.facts));
		rows.aliases.push(...structuredClone(result.batch.rows.aliases));
	}
	return {
		v: 1,
		...rows,
		policies: [
			{
				ref: "fixture-only:policy",
				role: "design",
				scopeRef: "fixture-only:scope",
				effectiveAt: FROM,
				weeklyUsd: "2000",
				basis: "list-estimate",
				timeZone: "America/Los_Angeles",
				sourceRef: "fixture-only:owner",
			},
		],
		coverage: [],
		requiredStreams: [...new Set(results.flatMap((r) => (r.source ? [r.source.stream] : [])))],
	};
}

// H-WIRE-0: admit only reviewed worker edges, while checking real main-thread reachability.
// The fixed mutations below use the same AST/resolver as production inspection, never server writes.
describe("usage-accounting reader and transitive worker import boundaries", () => {
	const project = fileURLToPath(new URL("../../", import.meta.url));
	const server = join(project, "server");
	const reader = join(server, "usage-accounting-pi-sessions.ts");
	// W3 owns the reader adapter; W6 owns worker orchestration, not the main-thread startup hook.
	const readerImporters = ["usage-accounting-pi-source.ts", "usage-accounting-worker.ts"];
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
		"usage-accounting-snapshot.ts", // W5 builder, never its separate main-thread cache.
	];
	const forbidden = new Set(engines.map((name) => join(server, name)));
	type ImportHost = { fileExists(file: string): boolean; readFile(file: string): string | undefined };
	type ImportOptions = { paths?: Record<string, string[]>; baseUrl?: string };
	const config = JSON.parse(readFileSync(join(project, "tsconfig.server.json"), "utf8")) as {
		extends?: unknown;
		compilerOptions: ImportOptions;
	};
	if (config.extends) throw new Error("import guard must resolve extended server config before accepting it");
	const options = config.compilerOptions;
	const disk: ImportHost = {
		fileExists: existsSync,
		readFile: (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined),
	};
	const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];
	function serverFiles(dir = server): string[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const file = join(dir, entry.name);
			return entry.isDirectory() ? serverFiles(file) : extensions.includes(extname(file)) ? [file] : [];
		});
	}
	// TypeScript 7 exposes AST parsing through its native API, not the removed TS 5 createSourceFile API.
	// All parser inputs are virtual; no fixture or compiler output is written to disk.
	const syntaxDir = join(project, ".reader-import-guard-memory");
	const syntaxFs = createVirtualFileSystem({});
	const parser = new API({
		cwd: project,
		fs: { ...syntaxFs, readFile: (file) => syntaxFs.readFile!(file) ?? null },
	});
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
		const result: Reference[] = [];
		function visit(node: ts.Node): void {
			let specifier: ts.Node | undefined;
			let typeOnly = false;
			if (ts.isImportDeclaration(node)) {
				specifier = node.moduleSpecifier;
				// With the reviewed verbatimModuleSyntax, inline `type` specifiers still emit a runtime import.
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
			) {
				specifier = node.arguments[0];
			}
			if (specifier && ts.isStringLiteralLikeNode(specifier)) result.push({ specifier: specifier.text, typeOnly });
			node.forEachChild(visit);
		}
		visit(source);
		return result;
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
			return null; // External packages and node builtins are not application module edges.
		}
		for (const candidate of candidates) {
			const extension = extname(candidate);
			const stem = candidate.slice(0, candidate.length - extension.length);
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
	function unreviewedReaderImporters(files: string[], host: ImportHost, compilerOptions = options): string[] {
		cacheReferences(files, host);
		return files
			.filter(
				(file) =>
					file !== reader &&
					references(file, host.readFile(file)!).some(
						(ref) => target(file, ref.specifier, host, compilerOptions) === reader,
					),
			)
			.filter((file) => !readerImporters.some((name) => file === join(server, name)))
			.map((file) => relative(server, file))
			.sort();
	}
	function enginePaths(host: ImportHost, entrypoints: string[], compilerOptions = options): string[][] {
		const paths: string[][] = [];
		const parsedImports = new Map<string, Reference[]>();
		for (const root of entrypoints) {
			const visited = new Set<string>();
			function visit(file: string, path: string[]): void {
				if (visited.has(file)) return;
				visited.add(file);
				let imports = parsedImports.get(file);
				if (!imports) {
					const text = host.readFile(file);
					if (text === undefined) throw new Error(`missing graph module: ${relative(project, file)}`);
					imports = references(file, text);
					parsedImports.set(file, imports);
				}
				for (const ref of imports) {
					const dependency = target(file, ref.specifier, host, compilerOptions);
					if (!dependency) continue;
					const next = [...path, relative(server, dependency)];
					if (forbidden.has(dependency)) paths.push(next);
					else visit(dependency, next);
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
		return {
			fileExists: (file) => files.has(resolve(file)),
			readFile: (file) => files.get(resolve(file)),
		};
	}
	const forms = [
		(specifier: string) => `import { value } from '${specifier}';`,
		(specifier: string) => `import '${specifier}';`,
		(specifier: string) => `export { value } from '${specifier}';`,
		(specifier: string) => `export * from '${specifier}';`,
		(specifier: string) => `void import('${specifier}');`,
		(specifier: string) => `void require('${specifier}');`,
		(specifier: string) => `void module.require('${specifier}');`,
		(specifier: string) => `import value = require('${specifier}');`,
		(specifier: string) => `void import(\`${specifier}\`);`,
		(specifier: string) => `import type { Value } from '${specifier}';`,
		(specifier: string) => `export type { Value } from '${specifier}';`,
		(specifier: string) => `export type * from '${specifier}';`,
		(specifier: string) => `type Value = import('${specifier}').Value;`,
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
	// Native whole-tree setup crossed 5 s in the full gate; no runtime or mutation deadline changes.
	it("admits only the exact W3/W6 reader importers throughout the production server tree", () => {
		const files = serverFiles();
		expect(files).toContain(reader);
		expect(unreviewedReaderImporters(files, disk)).toEqual([]);
	}, 15_000);
	it("admits the reviewed reader edges but rejects unreviewed basenames, nested lookalikes and alternate syntax", () => {
		for (const form of forms) {
			const modules: Record<string, string> = { "usage-accounting-pi-sessions.ts": "export const value = 1;" };
			for (const name of readerImporters) modules[name] = form("./usage-accounting-pi-sessions.js");
			modules["unreviewed.ts"] = form("./usage-accounting-pi-sessions.js");
			modules["usage-accounting-meter-cache.ts"] = form("./usage-accounting-pi-sessions.js");
			modules["nested/usage-accounting-worker.ts"] = form("../usage-accounting-pi-sessions.js");
			expect(
				unreviewedReaderImporters(
					Object.keys(modules).map((name) => join(server, name)),
					memoryHost(modules),
				),
			).toEqual(["nested/usage-accounting-worker.ts", "unreviewed.ts", "usage-accounting-meter-cache.ts"]);
		}
	});
	it("checks every real main-thread root and explicitly models only the undelivered W5 cache as empty", () => {
		const cache = join(server, "usage-accounting-meter-cache.ts");
		for (const root of roots.slice(0, 3)) expect(disk.fileExists(join(server, root)), root).toBe(true);
		const cachePresent = disk.fileExists(cache);
		// Not a skipped root: the future cache is still an entrypoint; once present its real source is inspected.
		const host: ImportHost = {
			fileExists: (file) => resolve(file) === cache || disk.fileExists(file),
			readFile: (file) => (!cachePresent && resolve(file) === cache ? "" : disk.readFile(file)),
		};
		cacheReferences(serverFiles(), host); // Also batch real sources when this test runs in isolation.
		expect(enginePaths(host, roots)).toEqual([]);
		expect(cacheImports(host)).toEqual([]);
	});
	it.each(roots)("rejects every direct and helper-mediated engine mutation from %s", (root) => {
		for (const engine of engines) {
			for (const form of forms) {
				const specifier = `./${engine.replace(/\.ts$/, ".js")}`;
				const direct = memoryHost({ [root]: form(specifier), [engine]: "export const value = 1;" });
				expect(enginePaths(direct, [root])).toEqual([[root, engine]]);
				const indirect = memoryHost({
					[root]: form("./innocent-helper.js"),
					"innocent-helper.ts": form(specifier),
					[engine]: "export const value = 1;",
				});
				expect(enginePaths(indirect, [root])).toEqual([[root, "innocent-helper.ts", engine]]);
			}
		}
	});
	it("resolves .js-to-.ts, directory indexes and tsconfig aliases through transitive reexports", () => {
		const host = memoryHost({
			"index.ts": "export * from './bridge';",
			"bridge/index.ts": "export * from '@meter/usage-accounting-snapshot.js';",
			"usage-accounting-snapshot.ts": "export const value = 1;",
		});
		const aliased = { ...options, paths: { "@meter/*": [join(server, "*")] } };
		expect(enginePaths(host, ["index.ts"], aliased)).toEqual([
			["index.ts", "bridge/index.ts", "usage-accounting-snapshot.ts"],
		]);
		expect(() => enginePaths(memoryHost({ "index.ts": "import './missing-helper.js';" }), ["index.ts"])).toThrow(
			"unresolved local import",
		);
	});
	it("permits safe contract/cache graphs, ignores comment/string decoys and terminates harmless cycles", () => {
		const host = memoryHost({
			"index.ts": "export * from './roles-overview.js';",
			"roles-overview.ts": "export * from './usage-accounting-meter-cache.js'; export * from './safe-helper.js';",
			"protocol.ts": "import type { Snapshot } from './usage-accounting-meter-contract.js';",
			"usage-accounting-meter-cache.ts": "import type { Snapshot } from './usage-accounting-meter-contract.js';",
			"usage-accounting-meter-contract.ts": "export interface Snapshot { generation: number }",
			"safe-helper.ts":
				"import './roles-overview.js'; // import './usage-accounting-collector.js'\n" +
				"const text = \"require('./usage-accounting-snapshot.js')\";",
		});
		expect(enginePaths(host, roots)).toEqual([]);
		expect(cacheImports(host)).toEqual([]);
	});
	it("does not mistake runtime-retained inline type specifiers for erased contract imports", () => {
		for (const statement of [
			"import { type Snapshot } from './innocent-helper.js';",
			"export { type Snapshot } from './innocent-helper.js';",
		]) {
			const host = memoryHost({
				"index.ts": statement,
				"innocent-helper.ts": "export * from './usage-accounting-snapshot.js';",
				"usage-accounting-snapshot.ts": "export interface Snapshot {}",
			});
			expect(enginePaths(host, ["index.ts"])).toEqual([
				["index.ts", "innocent-helper.ts", "usage-accounting-snapshot.ts"],
			]);
		}
	});
	it("permits reviewed worker graphs without making snapshot builders safe for main-thread import", () => {
		const modules: Record<string, string> = Object.fromEntries(
			engines.map((engine) => [engine, "export const value = 1;"]),
		);
		modules["usage-accounting-worker.ts"] = engines
			.map((engine) => `import './${engine.replace(/\.ts$/, ".js")}';`)
			.join("\n");
		modules["usage-accounting-pi-source.ts"] = "export * from './usage-accounting-pi-sessions.js';";
		for (const root of roots) modules[root] = "";
		const host = memoryHost(modules);
		expect(enginePaths(host, roots)).toEqual([]);
		expect(
			unreviewedReaderImporters(
				Object.keys(modules).map((name) => join(server, name)),
				host,
			),
		).toEqual([]);
		for (const root of roots) {
			const escaped = memoryHost({ ...modules, [root]: "import './usage-accounting-worker.js';" });
			expect(enginePaths(escaped, [root])).toContainEqual([
				root,
				"usage-accounting-worker.ts",
				"usage-accounting-snapshot.ts",
			]);
		}
	});
	it("restricts the tiny cache to type-only meter-contract edges, not runtime contracts or unrelated helpers", () => {
		for (const statement of [
			"import { Snapshot } from './usage-accounting-meter-contract.js';",
			"import { type Snapshot } from './usage-accounting-meter-contract.js';",
			"export * from './safe-helper.js';",
			"import type { Snapshot } from './usage-accounting-contract.js';",
		]) {
			const host = memoryHost({
				"usage-accounting-meter-cache.ts": statement,
				"usage-accounting-meter-contract.ts": "export interface Snapshot {}",
				"usage-accounting-contract.ts": "export interface Snapshot {}",
				"safe-helper.ts": "export const value = 1;",
			});
			expect(cacheImports(host)).toHaveLength(1);
		}
	});
});
