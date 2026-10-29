import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
	buildSessionContext,
	convertToLlm,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import type { ConversationId, DocumentId, EntryId, EntryRecord, JsonObject, Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { threadCpuMs } from "./load-independent.js";
import {
	durableDatabaseName,
	migrateSessionsToDurable,
	readMigratedSourceEntry,
	renderMigrationSummary,
} from "../../server/durable-migrator.js";

// Pin the actual 1.4.0 context implementation, not a mock of its SQL/edits/head semantics.
// This internal API is not package-exported, so resolve from the installed public entry.
const runtimePath = pathToFileURL(
	join(dirname(createRequire(import.meta.url).resolve("@earendil-works/pi-durable")), "harness/context.js"),
).href;
type View = { messages: NonNullable<EntryRecord["model"]>; entries: EntryRecord[] };
const runtime = (await import(/* @vite-ignore */ runtimePath)) as {
	captureContextBounds: (
		storage: Storage,
		conversationId: ConversationId,
		context: typeof ctx,
		at?: EntryId,
	) => Promise<{ head?: EntryRecord; tail: EntryId }>;
	readContextFrom: (
		session: { readOnLine: <T>(run: () => Promise<T>) => Promise<T> },
		storage: Storage,
		conversationId: ConversationId,
		context: typeof ctx,
		at?: EntryId,
	) => Promise<{ view: View }>;
};
const line = { readOnLine: <T>(run: () => Promise<T>) => run() };
const stamp = "2026-01-01T00:00:00.000Z";
const header = (id = "test-session", cwd = "/test/workspace"): SessionHeader => ({
	type: "session",
	version: 3,
	id,
	timestamp: stamp,
	cwd,
});
const hash = (value: unknown) =>
	createHash("sha256")
		.update(value instanceof Uint8Array ? value : JSON.stringify(value))
		.digest("hex");
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function user(id: string, parentId: string | null, body = id): SessionEntry {
	return { type: "message", id, parentId, timestamp: stamp, message: { role: "user", content: body, timestamp: 0 } };
}
function assistant(id: string, parentId: string, body = id): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: stamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: body }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "fixture",
			usage,
			stopReason: "stop",
			timestamp: 0,
		},
	};
}
function custom(id: string, parentId: string, customType: string, data: JsonObject): SessionEntry {
	return { type: "custom", id, parentId, timestamp: stamp, customType, data };
}
function block(id: string, ids: string[], tier = 1, active = true) {
	return {
		blockId: id,
		runId: tier,
		tier,
		active,
		summary: `fixture observation ${id}`,
		topic: `topic ${id}`,
		directMessageIds: ids,
		effectiveMessageIds: ids,
		directBlockIds: [] as string[],
		createdAt: 1,
		compressedTokens: ids.length * 100,
		survivedCount: 0,
		generation: tier,
	};
}

let root: string;
let sourceDir: string;
let targetDir: string;
const opened: Storage[] = [];
async function source(entries: SessionEntry[], state?: JsonObject, name = "session.jsonl", record = header()) {
	const file = join(sourceDir, name);
	await writeFile(file, [record, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	if (state) await writeFile(`${file}.acp.json`, JSON.stringify(state));
	return file;
}
async function store(cwd = "/test/workspace") {
	const storage = await openNodeSqliteStorage(join(targetDir, durableDatabaseName(cwd)));
	opened.push(storage);
	return storage;
}
async function close(storage: Storage) {
	opened.splice(opened.indexOf(storage), 1);
	await storage.close(ctx);
}
async function doc(storage: Storage, conversationId: ConversationId, kind = "acp.state") {
	const record = await storage.findDocument({ kind, scope: { kind: "conversation", conversationId } }, "current", ctx);
	return record ? (await storage.document(record.id, "current", ctx))!.value : undefined;
}
async function entries(storage: Storage, conversationId: ConversationId) {
	return (await storage.scanEntries({ conversationId, order: "ascending" }, 100_000, undefined, ctx)).items;
}
async function context(storage: Storage, conversationId: ConversationId, at?: EntryId) {
	return (await runtime.readContextFrom(line, storage, conversationId, ctx, at)).view;
}
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "durable-migrator-test-"));
	sourceDir = join(root, "sources");
	targetDir = join(root, "durable");
	await mkdir(sourceDir);
});
afterEach(async () => {
	for (const storage of opened.splice(0)) await storage.close(ctx);
	await rm(root, { recursive: true, force: true });
});

describe("offline durable migration", () => {
	it("preserves selected-branch context, native compaction/edits and all metadata without touching sources", async () => {
		const raw = [
			user("00000001", null),
			assistant("00000002", "00000001"),
			assistant("offshoot", "00000001", "inactive branch"),
			user("00000003", "00000002"),
			{
				type: "compaction",
				id: "compact1",
				parentId: "00000003",
				timestamp: stamp,
				summary: "native checkpoint",
				firstKeptEntryId: "00000003",
				tokensBefore: 1000,
			},
			custom("identity", "compact1", "identity", { role: "ops", home: "test-session" }),
			custom("queue001", "identity", "queue", { tasks: [{ id: 9, status: "blocked" }] }),
			custom("tldr0001", "queue001", "tldr", { text: "ready" }),
			{ type: "session_info", id: "title001", parentId: "tldr0001", timestamp: stamp, name: "Test title" },
			{
				type: "custom_message",
				id: "notice01",
				parentId: "title001",
				timestamp: stamp,
				customType: "board",
				content: "board fixture",
				display: true,
				details: { x: 1 },
			},
			{
				type: "context_edit",
				id: "edit0001",
				parentId: "notice01",
				timestamp: stamp,
				targetId: "00000003",
				replacement: { content: "edited source fixture" },
			},
		] as SessionEntry[];
		const file = await source(raw);
		const before = hash(await readFile(file));
		const result = await migrateSessionsToDurable({ sourceDir, targetDir });
		const mapping = result.sessions[0]!;
		const storage = await store();
		const id = mapping.conversationId as ConversationId;
		const expected = convertToLlm(buildSessionContext(raw).messages);
		expect(hash((await context(storage, id)).messages)).toBe(hash(expected));
		for (const entry of raw) expect(hash(await readMigratedSourceEntry(storage, id, entry.id))).toBe(hash(entry));
		const meta = (await doc(storage, id, "pi-web-ui.migration"))!;
		expect(meta.title).toBe("Test title");
		expect(hash(meta.header)).toBe(hash(header()));
		expect(mapping.sessionId).toBe(header().id);
		expect(mapping.entryCount).toBe(raw.length);
		expect(hash(await readFile(file))).toBe(before);
		await close(storage);
		expect((await migrateSessionsToDurable({ sourceDir, targetDir, verify: true })).mismatches).toBe(0);
	});

	it("preserves T1/T2/T3, references and cache metadata; summary edits do not destroy raw decompression", async () => {
		const raw = [
			user("firstusr", null),
			assistant("old00001", "firstusr"),
			user("old00002", "old00001"),
			assistant("old00003", "old00002"),
			user("tail0001", "old00003"),
		];
		const b1 = block("b1", ["old00001"], 1, false);
		const b2 = { ...block("b2", ["old00001", "old00002"], 2), directBlockIds: ["b1"] };
		const b3 = block("b3", ["old00003"], 3);
		const state = {
			blocks: [b1, b2, b3],
			messageRefs: { byRaw: { old00001: "m00002" }, byRef: { m00002: "old00001" } },
			cacheStats: { hits: 7 },
			stats: { totalCompressed: 42 },
			nextBlockId: 4,
			hiddenOrphanRefs: [],
		};
		await source(raw, state);
		const result = await migrateSessionsToDurable({ sourceDir, targetDir });
		const storage = await store();
		const id = result.sessions[0]!.conversationId as ConversationId;
		const expected = [message(raw[0]!), renderMigrationSummary(b2), renderMigrationSummary(b3), message(raw[4]!)];
		expect(hash((await context(storage, id)).messages)).toBe(hash(expected));
		const acp = (await doc(storage, id))!;
		const { migration, ...preserved } = acp;
		expect(hash(preserved)).toBe(hash(state));
		expect(migration).toBeDefined();
		for (const entry of raw) expect(hash(await readMigratedSourceEntry(storage, id, entry.id))).toBe(hash(entry));
		const rows = await entries(storage, id);
		const historical = rows.find((row) => row.kind === "acp.migration.archive-edits")!;
		expect(historical.edits?.filter((edit) => edit.action === "replace").length).toBe(2);
		expect(historical.edits?.filter((edit) => edit.action === "omit").length).toBe(1);
		const head = rows.find((row) => row.kind === "acp.migration.head")!;
		expect(historical.id).toBeLessThan(head.head!);
		expect(head.edits?.length).toBe(2);
		await close(storage);
		expect((await migrateSessionsToDurable({ sourceDir, targetDir, verify: true })).mismatches).toBe(0);
	});

	it("keeps historical reads and SQL-visible forks bounded before the final head", async () => {
		const raw = [user("firstusr", null), assistant("old00001", "firstusr"), user("tail0001", "old00001")];
		const summary = block("b1", ["old00001"]);
		await source(raw, { blocks: [summary] });
		const report = await migrateSessionsToDurable({ sourceDir, targetDir });
		const storage = await store();
		const id = report.sessions[0]!.conversationId as ConversationId;
		const meta = (await doc(storage, id, "pi-web-ui.migration"))!;
		const order = meta.contextOrder as number[];
		const expected = [message(raw[0]!), renderMigrationSummary(summary), message(raw[2]!)];
		for (let at = 0; at < order.length; at++) {
			const view = await context(storage, id, order[at] as EntryId);
			expect(hash(view.messages)).toBe(hash(expected.slice(0, at + 1)));
			expect(view.entries.length).toBe(at + 2); // prefix head plus the small active prefix
		}
		const child = await storage.mintId<ConversationId>();
		await storage.commit(
			[{ type: "conversation", value: { id: child, parent: { conversationId: id, at: order[1] as EntryId } } }],
			ctx,
		);
		expect(hash((await context(storage, child)).messages)).toBe(hash(expected.slice(0, 2)));
	});

	it("uses the latest embedded acp-state when no sidecar exists, with range/refMap compatibility", async () => {
		const first = { blocks: [block("b0", ["old00001"], 1, false)] };
		const latest = {
			blocks: [{ blockId: "b1", active: true, summary: "range fixture", tier: 1, startEntryId: 2, endEntryId: 3 }],
			refMap: { m00002: "old00001" },
			cacheStats: { hits: 4 },
		};
		const raw = [
			user("firstusr", null),
			assistant("old00001", "firstusr"),
			user("old00002", "old00001"),
			custom("state001", "old00002", "acp-state", first),
			custom("state002", "state001", "acp-state", latest),
			user("tail0001", "state002"),
		];
		await source(raw);
		const result = await migrateSessionsToDurable({ sourceDir, targetDir });
		const storage = await store();
		const id = result.sessions[0]!.conversationId as ConversationId;
		const actual = (await doc(storage, id))!;
		expect(hash(actual.blocks)).toBe(hash(latest.blocks));
		expect((await context(storage, id)).messages.length).toBe(3);
	});

	it("uses sidecar state in preference to stale embedded state", async () => {
		const raw = [
			user("firstusr", null),
			custom("state001", "firstusr", "acp-state", { blocks: [block("b1", [], 1, false)] }),
		];
		await source(raw, { blocks: [], cacheStats: { hits: 99 } });
		const result = await migrateSessionsToDurable({ sourceDir, targetDir });
		const storage = await store();
		expect(hash((await doc(storage, result.sessions[0]!.conversationId as ConversationId))!.cacheStats)).toBe(
			hash({ hits: 99 }),
		);
	});

	it("is idempotent and appends new source rows exactly once, including numeric source IDs", async () => {
		let raw = [user("12345678", null), assistant("00000002", "12345678")];
		await source(raw);
		const initial = await migrateSessionsToDurable({ sourceDir, targetDir });
		const storage = await store();
		const id = initial.sessions[0]!.conversationId as ConversationId;
		const firstRows = await entries(storage, id);
		const firstMap = (await doc(storage, id))!.migration;
		await close(storage);
		const unchanged = await migrateSessionsToDurable({ sourceDir, targetDir });
		expect(unchanged.skipped).toBe(1);
		expect(unchanged.migrated).toBe(0);
		const second = await store();
		expect((await entries(second, id)).length).toBe(firstRows.length);
		await close(second);
		raw = [...raw, user("99999999", "00000002")];
		await source(raw);
		const updated = await migrateSessionsToDurable({ sourceDir, targetDir });
		expect(updated.migrated).toBe(1);
		expect(updated.sessions[0]!.conversationId).toBe(Number(id));
		const third = await store();
		const rows = await entries(third, id);
		expect(rows.filter((row) => (row.data as JsonObject | undefined)?.type === "message").length).toBe(3);
		expect(hash((await context(third, id)).messages)).toBe(hash(raw.map(message)));
		const oldMap = firstMap as { entryIds: Record<string, number> };
		const newMap = (await doc(third, id))!.migration as { entryIds: Record<string, number> };
		expect(newMap.entryIds["12345678"]).toBe(oldMap.entryIds["12345678"]);
		await close(third);
		expect((await migrateSessionsToDurable({ sourceDir, targetDir, verify: true })).mismatches).toBe(0);
	});

	it("allocates globally unique conversations/entries for multiple sessions in the same WAL workspace", async () => {
		await source([user("firstusr", null)], undefined, "a.jsonl", header("a"));
		await source([user("firstusr", null)], undefined, "b.jsonl", header("b"));
		await source([user("firstusr", null)], undefined, "c.jsonl", header("c", "/other/workspace"));
		const result = await migrateSessionsToDurable({ sourceDir, targetDir });
		expect(result.sessions.length).toBe(3);
		expect(durableDatabaseName("/test/nested/../workspace")).toBe(durableDatabaseName("/test/workspace"));
		expect(result.sessions[0]!.database).toBe(result.sessions[1]!.database);
		expect(result.sessions[0]!.conversationId).not.toBe(result.sessions[1]!.conversationId);
		const db = new DatabaseSync(join(targetDir, result.sessions[0]!.database));
		expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
		db.close();
		const storage = await store();
		const ids = await Promise.all(
			result.sessions.slice(0, 2).map((item) => doc(storage, item.conversationId as ConversationId)),
		);
		const maps = ids.map((value) => value!.migration as { entryIds: Record<string, number> });
		expect(maps[0]!.entryIds.firstusr).not.toBe(maps[1]!.entryIds.firstusr);
		await close(storage);
		expect((await migrateSessionsToDurable({ sourceDir, targetDir, verify: true })).mismatches).toBe(0);
	});

	it("dry-run writes nothing and missing-target verification creates nothing", async () => {
		await source([user("firstusr", null)]);
		const before = await readdir(root);
		const result = await migrateSessionsToDurable({ sourceDir, targetDir, dryRun: true });
		expect(result.mode).toBe("dry-run");
		expect(result.sessions[0]!.activeMessages).toBe(1);
		expect(hash(await readdir(root))).toBe(hash(before));
		await expect(migrateSessionsToDurable({ sourceDir, targetDir, verify: true })).rejects.toThrow();
		expect(hash(await readdir(root))).toBe(hash(before));
	});

	it("rejects target-inside-source aliases and another migrator without writing sources", async () => {
		const file = await source([user("firstusr", null)]);
		const before = hash(await readFile(file));
		await symlink(sourceDir, join(root, "alias"));
		await expect(
			migrateSessionsToDurable({ sourceDir, targetDir: join(root, "alias", "nested"), dryRun: true }),
		).rejects.toThrow("outside the source");
		await mkdir(join(targetDir, ".migration-lock"), { recursive: true });
		await expect(migrateSessionsToDurable({ sourceDir, targetDir })).rejects.toThrow("Another migration");
		expect(hash(await readFile(file))).toBe(before);
		expect((await readdir(targetDir)).length).toBe(1);
	});

	it("verification rejects an unexpected omit edit in the active window", async () => {
		await source([user("firstusr", null)]);
		const result = await migrateSessionsToDurable({ sourceDir, targetDir });
		const db = new DatabaseSync(join(targetDir, result.sessions[0]!.database));
		const row = db.prepare("SELECT record FROM entries WHERE id = ?").get(result.sessions[0]!.headId);
		expect(row).toBeDefined();
		const value = JSON.parse(row!.record as string) as EntryRecord;
		const corrupt = { ...value, edits: [{ target: value.head!, action: "omit" }] };
		db.prepare("UPDATE entries SET record = ? WHERE id = ?").run(JSON.stringify(corrupt), value.id);
		db.close();
		await expect(migrateSessionsToDurable({ sourceDir, targetDir, verify: true })).rejects.toThrow("active context");
	});

	it.each(["anchor", "window"])("verification detects masked historical %s corruption", async (kind) => {
		await source([user("firstusr", null), assistant("old00001", "firstusr")], {
			blocks: [block("b1", ["old00001"])],
		});
		const result = await migrateSessionsToDurable({ sourceDir, targetDir });
		const db = new DatabaseSync(join(targetDir, result.sessions[0]!.database));
		const row = db
			.prepare("SELECT record FROM entries WHERE json_extract(record, '$.kind') = ?")
			.get(`acp.migration.${kind}`);
		expect(row).toBeDefined();
		const value = JSON.parse(row!.record as string) as EntryRecord;
		const corrupt =
			kind === "anchor" ? { ...value, model: [message(user("changed1", null))] } : { ...value, head: value.id + 1 };
		db.prepare("UPDATE entries SET record = ? WHERE id = ?").run(JSON.stringify(corrupt), value.id);
		db.close();
		await expect(migrateSessionsToDurable({ sourceDir, targetDir, verify: true })).rejects.toThrow(
			kind === "anchor" ? "historical context row" : "historical window marker",
		);
	});

	it("verification rejects corrupt raw data or ACP metadata instead of repairing it", async () => {
		await source([user("firstusr", null)], { blocks: [] });
		const result = await migrateSessionsToDurable({ sourceDir, targetDir });
		const storage = await store();
		const conversationId = result.sessions[0]!.conversationId as ConversationId;
		const acp = await storage.findDocument(
			{ kind: "acp.state", scope: { kind: "conversation", conversationId } },
			"current",
			ctx,
		);
		await storage.commit(
			[
				{
					type: "document.change",
					id: acp!.id as DocumentId,
					content: { version: 1, kind: "base", value: { blocks: [], corrupt: true } },
				},
			],
			ctx,
		);
		await close(storage);
		const manifest = hash(await readFile(join(targetDir, "migration-manifest.json")));
		await expect(migrateSessionsToDurable({ sourceDir, targetDir, verify: true })).rejects.toThrow(
			"ACP blocks/refs/metadata",
		);
		expect(hash(await readFile(join(targetDir, "migration-manifest.json")))).toBe(manifest);
	});

	it("verifies empty sessions and refuses a tampered UUID/database manifest", async () => {
		await source([]);
		const report = await migrateSessionsToDurable({ sourceDir, targetDir });
		expect(report.sessions[0]!.activeMessages).toBe(0);
		expect((await migrateSessionsToDurable({ sourceDir, targetDir, verify: true })).mismatches).toBe(0);
		const path = join(targetDir, "migration-manifest.json");
		const manifest = JSON.parse(await readFile(path, "utf8"));
		manifest.sessions[0].conversationId++;
		await writeFile(path, JSON.stringify(manifest));
		await expect(migrateSessionsToDurable({ sourceDir, targetDir, verify: true })).rejects.toThrow("manifest mapping");
	});

	it("refuses rewritten source history and resumed target conversations", async () => {
		const raw = [user("firstusr", null), assistant("second01", "firstusr")];
		await source(raw);
		const result = await migrateSessionsToDurable({ sourceDir, targetDir });
		await source([user("firstusr", null, "rewritten"), raw[1]!]);
		await expect(migrateSessionsToDurable({ sourceDir, targetDir })).rejects.toThrow("not an append-only");
		await source(raw);
		const storage = await store();
		const conversationId = result.sessions[0]!.conversationId as ConversationId;
		await storage.commit(
			[
				{
					type: "entry",
					value: {
						id: await storage.mintId<EntryId>(),
						conversationId,
						kind: "pi.user",
						model: [message(user("later", null))],
					},
				},
			],
			ctx,
		);
		await close(storage);
		await expect(migrateSessionsToDurable({ sourceDir, targetDir })).rejects.toThrow("has resumed");
	});

	it("accepts forward parents without changing physical archive order or the SDK-selected branch", async () => {
		const raw: SessionEntry[] = [
			user("firstusr", null),
			assistant("answer01", "future01"),
			user("future01", "firstusr"),
			{
				type: "custom",
				id: "legacy01",
				parentId: "answer01",
				timestamp: stamp,
				customType: "queue",
				data: { kept: true },
			},
		];
		await source(raw);
		const result = await migrateSessionsToDurable({ sourceDir, targetDir });
		const storage = await store();
		const id = result.sessions[0]!.conversationId as ConversationId;
		expect(hash((await context(storage, id)).messages)).toBe(hash(convertToLlm(buildSessionContext(raw).messages)));
		const meta = (await doc(storage, id, "pi-web-ui.migration"))!;
		expect(hash(meta.entryOrder)).toBe(hash(raw.map((entry) => entry.id)));
		expect(hash(meta.branch)).toBe(hash(["firstusr", "future01", "answer01", "legacy01"]));
		for (const entry of raw) expect(hash(await readMigratedSourceEntry(storage, id, entry.id))).toBe(hash(entry));
		await close(storage);
		expect((await migrateSessionsToDurable({ sourceDir, targetDir, verify: true })).mismatches).toBe(0);
	});

	it("validates incomplete lines, duplicate IDs, missing parents and cycles without silently dropping entries", async () => {
		const file = await source([user("firstusr", null)]);
		await writeFile(file, `${JSON.stringify(header())}\n{"broken":`);
		await expect(migrateSessionsToDurable({ sourceDir, targetDir, dryRun: true })).rejects.toThrow("Invalid JSONL");
		await source([user("firstusr", null), user("firstusr", null)]);
		await expect(migrateSessionsToDurable({ sourceDir, targetDir, dryRun: true })).rejects.toThrow("Duplicate entry");
		await source([user("firstusr", "missing")]);
		await expect(migrateSessionsToDurable({ sourceDir, targetDir, dryRun: true })).rejects.toThrow("Missing parent");
		await source([user("firstusr", "next0001"), user("next0001", "firstusr")]);
		await expect(migrateSessionsToDurable({ sourceDir, targetDir, dryRun: true })).rejects.toThrow("Parent cycle");
	});

	it("preserves parallel tool-call pairing and filters failed turns/orphan results through actual context code", async () => {
		const a = assistant("calls001", "firstusr");
		if (a.type !== "message" || a.message.role !== "assistant") throw new Error("fixture");
		a.message.content = [
			{ type: "toolCall", id: "call1", name: "read", arguments: {} },
			{ type: "toolCall", id: "call2", name: "read", arguments: {} },
		];
		const r = (id: string, parentId: string, call: string): SessionEntry => ({
			type: "message",
			id,
			parentId,
			timestamp: stamp,
			message: {
				role: "toolResult",
				toolCallId: call,
				toolName: "read",
				content: [{ type: "text", text: "fixture result" }],
				isError: false,
				timestamp: 0,
			},
		});
		const failed = assistant("failed01", "result01");
		if (failed.type === "message" && failed.message.role === "assistant") failed.message.stopReason = "error";
		await source([
			user("firstusr", null),
			a,
			r("result02", "calls001", "call2"),
			r("result01", "result02", "call1"),
			failed,
			user("tail0001", "failed01"),
		]);
		const result = await migrateSessionsToDurable({ sourceDir, targetDir });
		const storage = await store();
		const view = await context(storage, result.sessions[0]!.conversationId as ConversationId);
		expect(hash(view.messages.map((msg) => msg.role))).toBe(
			hash(["user", "assistant", "toolResult", "toolResult", "user"]),
		);
		expect(hash(view.messages.filter((msg) => msg.role === "toolResult").map((msg) => msg.toolCallId))).toBe(
			hash(["call1", "call2"]),
		);
	});

	it("CLI reports dry-run and refuses unknown/missing arguments", async () => {
		await source([user("firstusr", null)]);
		const cli = join(process.cwd(), "scripts/migrate-sessions-to-durable.mjs");
		const run = promisify(execFile);
		const { stdout } = await run(process.execPath, [
			cli,
			"--source-dir",
			sourceDir,
			"--target-dir",
			targetDir,
			"--dry-run",
		]);
		expect(JSON.parse(stdout).mode).toBe("dry-run");
		await expect(run(process.execPath, [cli, "--wat"])).rejects.toThrow();
		await expect(run(process.execPath, [cli, "--source-dir"])).rejects.toThrow();
	});

	it("bounds 70,000 raw entries / 2,600 blocks to a sub-5ms active-context read", async () => {
		const raw: SessionEntry[] = [];
		for (let at = 0; at < 70_000; at++) {
			const id = `r${at.toString(16).padStart(7, "0")}`;
			const parent = raw.at(-1)?.id ?? null;
			raw.push(at % 2 === 0 ? user(id, parent, `fixture ${at}`) : assistant(id, parent!, `fixture ${at}`));
		}
		const allBlocks = Array.from({ length: 2600 }, (_, at) =>
			block(`b${at + 1}`, [], at < 2200 ? 1 : at < 2500 ? 2 : 3, false),
		);
		const active = allBlocks.at(-1)!;
		active.active = true;
		active.effectiveMessageIds = raw.slice(1, -16).map((entry) => entry.id);
		active.directMessageIds = active.effectiveMessageIds;
		await source(raw, {
			blocks: allBlocks,
			messageRefs: { byRaw: Object.fromEntries(raw.map((entry, at) => [entry.id, `m${at + 1}`])) },
			cacheStats: { hits: 2600 },
		});
		const result = await migrateSessionsToDurable({ sourceDir, targetDir });
		const storage = await store();
		const conversationId = result.sessions[0]!.conversationId as ConversationId;
		// Every read is cold at the context level: do not pass the incremental previous range.
		// Ops #639: each read's cost is this thread's CPU time (node:sqlite reads synchronously on it), not wall-clock,
		// so a busy machine can't fail it; a read that walks the 70,000 entries or 2,600 blocks still costs far more.
		const samples: number[] = [];
		for (let at = 0; at < 10; at++) {
			const start = threadCpuMs();
			await runtime.captureContextBounds(storage, conversationId, ctx);
			const view = await runtime.readContextFrom(line, storage, conversationId, ctx);
			samples.push(threadCpuMs() - start);
			expect(view.view.entries.length).toBe(19);
			expect(view.view.messages.length).toBe(18);
		}
		const median = samples.toSorted((left, right) => left - right)[5]!;
		expect(median).toBeLessThan(5);
		const acp = (await doc(storage, conversationId))!;
		expect((acp.blocks as unknown[]).length).toBe(2600);
		expect(hash(await readMigratedSourceEntry(storage, conversationId, raw[35_000]!.id))).toBe(hash(raw[35_000]));
		await close(storage);
		expect((await migrateSessionsToDurable({ sourceDir, targetDir, verify: true })).mismatches).toBe(0);
		if (process.env.DURABLE_MIGRATOR_REPORT)
			await writeFile(
				process.env.DURABLE_MIGRATOR_REPORT,
				`${JSON.stringify({ fixture: "synthetic", entries: 70_000, blocks: 2600, messages: 18, medianMs: median, samplesMs: samples })}\n`,
				{ flag: "a" },
			);
		console.info(
			`durable-migrator: 70000 raw entries, 2600 blocks, 18 messages, cold-context median ${median.toFixed(3)} ms`,
		);
	});

	it.skipIf(!process.env.DURABLE_MIGRATOR_COPY_SOURCE)(
		"verifies a temporary copy of a large existing transcript and sidecar, never the live file",
		async () => {
			const original = process.env.DURABLE_MIGRATOR_COPY_SOURCE!;
			const file = join(sourceDir, "copied.jsonl");
			await copyFile(original, file);
			try {
				await copyFile(`${original}.acp.json`, `${file}.acp.json`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const before = hash(await readFile(file));
			const report = await migrateSessionsToDurable({ sourceDir, targetDir });
			expect(report.sessions.length).toBe(1);
			expect((await migrateSessionsToDurable({ sourceDir, targetDir, verify: true })).mismatches).toBe(0);
			expect(hash(await readFile(file))).toBe(before);
			const storage = await store(report.sessions[0]!.cwd);
			const start = performance.now();
			const view = await context(storage, report.sessions[0]!.conversationId as ConversationId);
			const ms = performance.now() - start;
			expect(view.messages.length).toBe(report.sessions[0]!.activeMessages);
			if (process.env.DURABLE_MIGRATOR_REPORT)
				await writeFile(
					process.env.DURABLE_MIGRATOR_REPORT,
					`${JSON.stringify({ fixture: "copy", entries: report.sessions[0]!.entryCount, blocks: report.sessions[0]!.blocks, messages: view.messages.length, contextMs: ms })}\n`,
					{ flag: "a" },
				);
			console.info(
				`durable-migrator copy: ${report.sessions[0]!.entryCount} raw entries, ${report.sessions[0]!.blocks} blocks, ${view.messages.length} active messages, context ${ms.toFixed(3)} ms`,
			);
		},
	);
});

function message(entry: SessionEntry): NonNullable<EntryRecord["model"]>[number] {
	if (entry.type !== "message") throw new Error("fixture");
	return entry.message as NonNullable<EntryRecord["model"]>[number];
}
