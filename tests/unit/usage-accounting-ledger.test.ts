import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	attachUsageLedger,
	recordUsageLedgerEntry,
	UsageLedger,
	type UsageLedgerApp,
	type UsageLedgerRecord,
	type UsageLedgerSession,
} from "../../server/usage-accounting-ledger.js";

const fields = [
	"v",
	"at",
	"occurredAt",
	"kind",
	"provider",
	"model",
	"modelSource",
	"responseId",
	"stopReason",
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"totalTokens",
	"costTotal",
	"conversationId",
	"sessionId",
	"sessionFile",
	"persist",
	"origin",
	"parentConversationId",
].sort();
const secret = "PLANTED-NOT-LEDGER-CONTENT-306";
const usage = () => ({
	input: 11,
	output: 7,
	cacheRead: 3,
	cacheWrite: 2,
	totalTokens: 23,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.002, total: 0.035 },
});
function message(overrides: Record<string, unknown> = {}) {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			api: "fixture",
			provider: "response-provider",
			model: "response-model",
			timestamp: 1_792_497_600_000,
			responseId: "response-1",
			stopReason: "stop",
			usage: usage(),
			content: [{ type: "text", text: secret }],
			errorMessage: secret,
			...overrides,
		},
	};
}
function entry(type: string, overrides: Record<string, unknown> = {}) {
	return {
		type,
		id: `${type}-1`,
		parentId: null,
		timestamp: "2026-10-20T12:00:00.000Z",
		usage: usage(),
		summary: secret,
		details: { secret },
		...overrides,
	} as unknown as SessionEntry;
}
class FakeSession implements UsageLedgerSession {
	listeners = new Set<(event: AgentSessionEvent) => void>();
	sessionId = "session-1";
	sessionFile: string | undefined;
	model = { provider: "requested-provider", id: "requested-model" } as NonNullable<AgentSession["model"]>;
	leaf: SessionEntry | undefined;
	completed = 0;
	constructor(readonly persisted = false) {
		this.sessionFile = persisted ? "/fixture/sessions/session-1.jsonl" : undefined;
	}
	sessionManager = { isPersisted: () => this.persisted, getLeafEntry: () => this.leaf };
	subscribe(fn: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}
	emit(event: unknown): void {
		for (const listener of this.listeners) listener(event as AgentSessionEvent);
		this.completed++;
	}
}
const dirs: string[] = [];
async function directory() {
	const dir = await mkdtemp(join(tmpdir(), "usage-ledger-test-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function memory() {
	const dir = await directory();
	const rows: UsageLedgerRecord[] = [];
	const warn = vi.fn();
	const ledger = new UsageLedger(dir, {
		append: async (row) => {
			rows.push(row);
		},
		warn,
	});
	return { dir, rows, ledger, warn };
}
function exactKeys(row: UsageLedgerRecord) {
	expect(Object.keys(row).sort()).toEqual(row.origin === "app" ? [...fields, "app"].sort() : fields);
}

describe("usage-ledger/1 — finalized numeric observations only", () => {
	it("records persistent assistant usage once and keeps response identity and message time", async () => {
		const { rows, ledger } = await memory();
		const s = new FakeSession(true);
		attachUsageLedger(s, { origin: "chat", conversationId: "chat-1" }, ledger);
		const event = message();
		s.emit(event);
		s.emit(event);
		s.emit(message());
		await ledger.flush();
		expect(rows).toHaveLength(1);
		exactKeys(rows[0]);
		expect(rows[0]).toEqual({
			v: "usage-ledger/1",
			at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
			occurredAt: new Date(event.message.timestamp).toISOString(),
			kind: "assistant",
			provider: "response-provider",
			model: "response-model",
			modelSource: "response",
			responseId: "response-1",
			stopReason: "stop",
			input: 11,
			output: 7,
			cacheRead: 3,
			cacheWrite: 2,
			totalTokens: 23,
			costTotal: 0.035,
			conversationId: "chat-1",
			sessionId: "session-1",
			sessionFile: "/fixture/sessions/session-1.jsonl",
			persist: true,
			origin: "chat",
			parentConversationId: null,
		});
	});
	it("records in-memory helpers with the owning chat, and never infers persistence from a path", async () => {
		const { rows, ledger } = await memory();
		const s = new FakeSession();
		s.sessionFile = "/fixture/misleading-path.jsonl";
		attachUsageLedger(s, { origin: "helper", conversationId: "helper-1", parentConversationId: "spawner-1" }, ledger);
		s.emit(message());
		await ledger.flush();
		expect(rows).toHaveLength(1);
		exactKeys(rows[0]);
		expect(rows[0]).toMatchObject({
			origin: "helper",
			conversationId: "helper-1",
			parentConversationId: "spawner-1",
			persist: false,
			sessionFile: null,
		});
	});
	it.each([
		"plugin-llm",
		"decision-model",
		"decision-bounded-model",
		"goal-wizard",
		"goal-reviewer",
	] as UsageLedgerApp[])("covers the isolated %s session with only an allowlisted app field", async (app) => {
		const { rows, ledger } = await memory();
		const s = new FakeSession();
		attachUsageLedger(s, { origin: "app", app, parentConversationId: "owner-1" }, ledger);
		s.emit(message());
		await ledger.flush();
		expect(rows).toHaveLength(1);
		exactKeys(rows[0]);
		expect(rows[0]).toMatchObject({
			app,
			conversationId: "app:session-1",
			origin: "app",
			parentConversationId: "owner-1",
			persist: false,
			sessionFile: null,
		});
	});
	it.each(["error", "aborted"])("retains reported %s usage, but not the error message", async (stopReason) => {
		const { rows, ledger } = await memory();
		const s = new FakeSession();
		attachUsageLedger(s, { origin: "chat", conversationId: "chat-1" }, ledger);
		s.emit(message({ stopReason }));
		await ledger.flush();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ stopReason, input: 11, costTotal: 0.035 });
		expect(JSON.stringify(rows).includes(secret)).toBe(false);
		exactKeys(rows[0]);
	});
	it("captures cache-warm entries without mislabelling other usage kinds", async () => {
		const { rows, ledger } = await memory();
		const s = new FakeSession();
		attachUsageLedger(s, { origin: "helper", conversationId: "helper-1", parentConversationId: "parent-1" }, ledger);
		const warm = entry("usage", { kind: "cache_warm", provider: "warm-provider", model: "warm-model" });
		s.emit({ type: "entry_appended", entry: warm });
		s.emit({ type: "entry_appended", entry: warm });
		s.emit({ type: "entry_appended", entry: entry("usage", { id: "other", kind: "unknown-future-kind" }) });
		await ledger.flush();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "cache_warm",
			occurredAt: "2026-10-20T12:00:00.000Z",
			provider: "warm-provider",
			model: "warm-model",
			modelSource: "requested",
			responseId: null,
			stopReason: null,
		});
		exactKeys(rows[0]);
	});
	it("captures compaction_end once, even when entry_appended also delivers the entry", async () => {
		const { rows, ledger } = await memory();
		const s = new FakeSession();
		attachUsageLedger(s, { origin: "chat", conversationId: "chat-1" }, ledger);
		s.emit({ type: "compaction_start", reason: "manual" });
		const compact = entry("compaction");
		s.leaf = compact;
		s.emit({ type: "entry_appended", entry: compact });
		s.emit({ type: "compaction_end", result: { summary: secret, usage: (compact as { usage?: unknown }).usage } });
		await ledger.flush();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "compaction",
			occurredAt: "2026-10-20T12:00:00.000Z",
			responseId: null,
			model: "requested-model",
			modelSource: "requested",
		});
		exactKeys(rows[0]);
	});
	it("uses compaction's starting requested model, not a later selected model", async () => {
		const { rows, ledger } = await memory();
		const s = new FakeSession();
		attachUsageLedger(s, { origin: "chat" }, ledger);
		s.emit({ type: "compaction_start", reason: "manual" });
		s.model = { provider: "other", id: "other" } as typeof s.model;
		s.emit({ type: "compaction_end", result: { summary: secret, usage: usage() } });
		s.emit({ type: "compaction_end", result: undefined, aborted: true });
		await ledger.flush();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			model: "requested-model",
			provider: "requested-provider",
			modelSource: "requested",
		});
	});
	it("captures the returned branch summary and deduplicates an optional public entry event", async () => {
		const { rows, ledger } = await memory();
		const s = new FakeSession();
		attachUsageLedger(s, { origin: "chat", conversationId: "chat-1" }, ledger);
		const summary = entry("branch_summary");
		recordUsageLedgerEntry(s, summary);
		s.emit({ type: "entry_appended", entry: summary });
		recordUsageLedgerEntry(s, undefined);
		await ledger.flush();
		expect(rows).toHaveLength(1);
		exactKeys(rows[0]);
		expect(rows[0]).toMatchObject({
			kind: "branch_summary",
			occurredAt: "2026-10-20T12:00:00.000Z",
			responseId: null,
			modelSource: "requested",
		});
	});
	it("falls back to the requested model when the response has none, with null unknown cost/id", async () => {
		const { rows, ledger } = await memory();
		const s = new FakeSession();
		attachUsageLedger(s, { origin: "chat", conversationId: "chat-1" }, ledger);
		s.emit(message({ model: undefined, provider: undefined, responseId: undefined, usage: { input: 2, output: 3 } }));
		await ledger.flush();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			provider: "requested-provider",
			model: "requested-model",
			modelSource: "requested",
			responseId: null,
			input: 2,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5,
			costTotal: null,
		});
	});
	it("preserves exact zero counts and cost instead of treating them as missing", async () => {
		const { rows, ledger } = await memory();
		const s = new FakeSession();
		attachUsageLedger(s, { origin: "chat" }, ledger);
		s.emit(
			message({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } }),
		);
		await ledger.flush();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 });
	});
	it("ignores absent/malformed usage and all non-final/non-assistant messages", async () => {
		const { rows, ledger } = await memory();
		const s = new FakeSession();
		attachUsageLedger(s, { origin: "chat" }, ledger);
		for (const raw of [
			undefined,
			null,
			{},
			{ input: -1, output: 2 },
			{ input: 1, output: NaN },
			{ input: 1, output: 2, cacheRead: "3" },
			{ input: Infinity, output: 2 },
		])
			s.emit(message({ usage: raw }));
		s.emit(message({ role: "user" }));
		s.emit(message({ role: "toolResult" }));
		s.emit({ type: "message_update", message: message().message });
		s.emit({ type: "entry_appended", entry: entry("branch_summary", { usage: undefined }) });
		await ledger.flush();
		expect(rows).toHaveLength(0);
	});
	it("reattachment updates metadata once, snapshots it before queued writes, and handles a new session identity", async () => {
		const { rows, ledger } = await memory();
		const s = new FakeSession();
		let conversationId = "initial";
		attachUsageLedger(s, { origin: "chat", conversationId: "discard" }, ledger);
		const off = attachUsageLedger(
			s,
			() => ({ origin: "helper", conversationId, parentConversationId: "spawn-time-parent" }),
			ledger,
		);
		expect(s.listeners.size).toBe(1);
		s.emit(message());
		conversationId = "later";
		s.sessionId = "session-2";
		s.emit(message());
		await ledger.flush();
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => [r.conversationId, r.sessionId, r.parentConversationId])).toEqual([
			["initial", "session-1", "spawn-time-parent"],
			["later", "session-2", "spawn-time-parent"],
		]);
		off();
		expect(s.listeners.size).toBe(0);
	});
	it("does not even access content, prompt, tool data, summaries or errors", async () => {
		const { rows, ledger } = await memory();
		const s = new FakeSession();
		attachUsageLedger(s, { origin: "chat" }, ledger);
		const event = message();
		for (const key of ["content", "prompt", "toolData", "errorMessage"])
			Object.defineProperty(event.message, key, {
				get: () => {
					throw new Error(secret);
				},
			});
		s.emit(event);
		const compact = entry("branch_summary");
		Object.defineProperty(compact, "summary", {
			get: () => {
				throw new Error(secret);
			},
		});
		recordUsageLedgerEntry(s, compact);
		await ledger.flush();
		expect(rows).toHaveLength(2);
		for (const row of rows) exactKeys(row);
		expect(JSON.stringify(rows).includes(secret)).toBe(false);
	});
});

describe("usage ledger — asynchronous private storage", () => {
	it("writes one complete JSON line per call, in order, to the UTC monthly file with private modes", async () => {
		const dir = await directory();
		const ledger = new UsageLedger(dir);
		const s = new FakeSession();
		attachUsageLedger(s, { origin: "helper", conversationId: "helper-1", parentConversationId: "parent-1" }, ledger);
		for (let i = 0; i < 40; i++)
			s.emit(
				message({
					responseId: `response-${i}`,
					usage: { ...usage(), content: secret, error: secret },
					prompt: secret,
					toolData: secret,
				}),
			);
		expect(s.completed).toBe(40);
		await ledger.flush();
		const files = await readdir(join(dir, "usage-ledger"));
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^\d{4}-\d{2}\.jsonl$/);
		const path = join(dir, "usage-ledger", files[0]);
		const raw = await readFile(path, "utf8");
		expect(raw.includes(secret)).toBe(false);
		expect(raw.endsWith("\n")).toBe(true);
		const rows = raw
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as UsageLedgerRecord);
		expect(rows).toHaveLength(40);
		rows.forEach(exactKeys);
		expect(rows.map((r) => r.responseId)).toEqual(Array.from({ length: 40 }, (_, i) => `response-${i}`));
		expect(files[0]).toBe(`${rows[0].at.slice(0, 7)}.jsonl`);
		expect((await lstat(path)).mode & 0o777).toBe(0o600);
		expect((await lstat(join(dir, "usage-ledger"))).mode & 0o777).toBe(0o700);
	});
	it("repairs modes on existing files/directories before append", async () => {
		const dir = await directory();
		const ledgerDir = join(dir, "usage-ledger");
		await mkdir(ledgerDir);
		await chmod(ledgerDir, 0o755);
		const path = join(ledgerDir, `${new Date().toISOString().slice(0, 7)}.jsonl`);
		await writeFile(path, "");
		await chmod(path, 0o644);
		const ledger = new UsageLedger(dir);
		const s = new FakeSession();
		attachUsageLedger(s, { origin: "chat" }, ledger);
		s.emit(message());
		await ledger.flush();
		expect((await lstat(ledgerDir)).mode & 0o777).toBe(0o700);
		expect((await lstat(path)).mode & 0o777).toBe(0o600);
	});
	it("obeys the live off/on switch and does not invent a settings file", async () => {
		const { dir, ledger, rows } = await memory();
		const s = new FakeSession();
		attachUsageLedger(s, { origin: "chat" }, ledger);
		s.emit(message({ responseId: "before" }));
		await ledger.flush();
		expect(await readdir(dir)).toEqual([]);
		await writeFile(join(dir, "usage-ledger.json"), JSON.stringify({ enabled: false }));
		s.emit(message({ responseId: "off" }));
		await ledger.flush();
		await writeFile(join(dir, "usage-ledger.json"), JSON.stringify({ enabled: true }));
		s.emit(message({ responseId: "on" }));
		await ledger.flush();
		expect(rows.map((r) => r.responseId)).toEqual(["before", "on"]);
	});
	it("invalid settings fail closed with a fixed, content-free warning", async () => {
		const { dir, ledger, rows, warn } = await memory();
		const s = new FakeSession();
		await writeFile(join(dir, "usage-ledger.json"), secret);
		attachUsageLedger(s, { origin: "chat" }, ledger);
		s.emit(message());
		await ledger.flush();
		expect(rows).toHaveLength(0);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(warn.mock.calls).includes(secret)).toBe(false);
	});
	it("a blocked writer cannot delay the emitter/session", async () => {
		const dir = await directory();
		let release!: () => void;
		const blocked = new Promise<void>((done) => {
			release = done;
		});
		const started = vi.fn();
		let began!: () => void;
		const writing = new Promise<void>((done) => {
			began = done;
		});
		const ledger = new UsageLedger(dir, {
			append: async () => {
				started();
				began();
				await blocked;
			},
		});
		const s = new FakeSession();
		attachUsageLedger(s, { origin: "chat" }, ledger);
		s.emit(message());
		expect(s.completed).toBe(1);
		await writing;
		// Emitting more events still completes synchronously while I/O is actually blocked.
		s.emit(message({ responseId: "second" }));
		expect(s.completed).toBe(2);
		release();
		await ledger.flush();
		expect(started).toHaveBeenCalledTimes(2);
	});
	it("failing writes and even a failing logger never break the session; warning is limited to once a minute", async () => {
		const dir = await directory();
		let now = 0;
		const warnings: string[] = [];
		let fail = true;
		let attempts = 0;
		const ledger = new UsageLedger(dir, {
			now: () => now,
			warn: (warning) => {
				warnings.push(warning);
				throw new Error(secret);
			},
			append: async () => {
				attempts++;
				if (fail) throw new Error(secret);
			},
		});
		const s = new FakeSession();
		attachUsageLedger(s, { origin: "chat" }, ledger);
		for (let i = 0; i < 3; i++) s.emit(message({ responseId: `first-${i}` }));
		await ledger.flush();
		expect(s.completed).toBe(3);
		expect(warnings).toHaveLength(1);
		now = 59_999;
		s.emit(message({ responseId: "before-minute" }));
		await ledger.flush();
		expect(warnings).toHaveLength(1);
		now = 60_000;
		s.emit(message({ responseId: "after-minute" }));
		await ledger.flush();
		expect(warnings).toHaveLength(2);
		fail = false;
		s.emit(message({ responseId: "recovered" }));
		await ledger.flush();
		expect(attempts).toBe(6);
		expect(s.completed).toBe(6);
		expect(warnings.some((w) => w.includes(secret))).toBe(false);
	});
	it("refuses a symlink monthly file without touching its target", async () => {
		const dir = await directory();
		const ledgerDir = join(dir, "usage-ledger");
		await mkdir(ledgerDir, { mode: 0o700 });
		const target = join(dir, "unrelated");
		await writeFile(target, "unchanged");
		await symlink(target, join(ledgerDir, `${new Date().toISOString().slice(0, 7)}.jsonl`));
		const warn = vi.fn();
		const ledger = new UsageLedger(dir, { warn });
		const s = new FakeSession();
		attachUsageLedger(s, { origin: "chat" }, ledger);
		s.emit(message());
		await ledger.flush();
		expect(s.completed).toBe(1);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(await readFile(target, "utf8")).toBe("unchanged");
	});
	it("an invalid metadata reader cannot fail a session", async () => {
		const { ledger } = await memory();
		const s = new FakeSession();
		attachUsageLedger(
			s,
			() => {
				throw new Error(secret);
			},
			ledger,
		);
		expect(() => s.emit(message())).not.toThrow();
		expect(s.completed).toBe(1);
		await ledger.flush();
	});
});
