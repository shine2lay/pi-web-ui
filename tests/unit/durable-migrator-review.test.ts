import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import type { ConversationId, EntryId, EntryRecord, JsonObject, Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MigrationMapping } from "../../server/durable-migrator.js";

/**
 * Ops #573 review hypothesis: the baseline treats ACP transport folds as native
 * compaction, ignores inherited sidecars, checks UUIDs only within one database,
 * and reads titles only on the selected branch. Authored fixtures below test
 * those claims independently; a passing old control disproves the corresponding
 * claim. Literal message/block/ref expectations never call projection helpers.
 * Restart cases additionally distinguish recoverable stale publication from an
 * identity conflict. Only this suite's temporary JSONL, sidecars and SQLite are used.
 */
const override = process.env.PI_MIGRATION_REVIEW_MODULE;
if (override && !isAbsolute(override)) throw new Error("PI_MIGRATION_REVIEW_MODULE must be an absolute path");
const migrator: typeof import("../../server/durable-migrator.js") = override
	? await import(/* @vite-ignore */ pathToFileURL(override).href)
	: await import("../../server/durable-migrator.js");
// Keep this suite type-compatible with the pinned control, which predates the
// optional explicit parent map. Extra optional input does not weaken assertions.
type ReviewMigrationOptions = Parameters<typeof migrator.migrateSessionsToDurable>[0] & {
	parentSessionMap?: Readonly<Record<string, string>>;
};
const migrateSessionsToDurable: (
	options: ReviewMigrationOptions,
) => ReturnType<typeof migrator.migrateSessionsToDurable> = migrator.migrateSessionsToDurable;

// Use the installed real Harness context reader, not a projection or storage mock.
const runtimePath = pathToFileURL(
	join(dirname(createRequire(import.meta.url).resolve("@earendil-works/pi-durable")), "harness/context.js"),
).href;
type View = { messages: NonNullable<EntryRecord["model"]>; entries: EntryRecord[] };
const runtime = (await import(/* @vite-ignore */ runtimePath)) as {
	readContextFrom: (
		session: { readOnLine: <T>(run: () => Promise<T>) => Promise<T> },
		storage: Storage,
		conversationId: ConversationId,
		context: typeof ctx,
		at?: EntryId,
	) => Promise<{ view: View }>;
};
const line = { readOnLine: <T>(run: () => Promise<T>) => run() };
const stamp = "1970-01-01T00:00:00.000Z";
const workspace = "/migration-review/workspace";
const manifestName = "migration-manifest.json";
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function header(id = "review-session", cwd = workspace, parentSession?: string): SessionHeader {
	return { type: "session", version: 3, id, timestamp: stamp, cwd, ...(parentSession ? { parentSession } : {}) };
}
function user(id: string, parentId: string | null, body: string): SessionEntry {
	return { type: "message", id, parentId, timestamp: stamp, message: { role: "user", content: body, timestamp: 0 } };
}
function assistant(id: string, parentId: string, body: string): SessionEntry {
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
			model: "offline-fixture",
			usage,
			stopReason: "stop",
			timestamp: 0,
		},
	};
}
function fold(id: string, parentId: string, firstKeptEntryId: string): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: stamp,
		summary: "ACP TRANSPORT MARKER: not a conversation summary",
		firstKeptEntryId,
		tokensBefore: 100,
		details: { acp: { v: 1, kept: 1, folded: 2 } },
	};
}
function native(id: string, parentId: string, firstKeptEntryId: string): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: stamp,
		summary: "genuine native checkpoint",
		firstKeptEntryId,
		tokensBefore: 100,
	};
}

type IdMaps = {
	entryIds: Record<string, number>;
	contextEntryIds: Record<string, number>;
	contextOrder: number[];
	headId: number;
};
type MigrationMetadata = IdMaps & {
	entryOrder: string[];
	branch: string[];
	title: string | null;
	header: SessionHeader;
};
type Manifest = { format: number; sessions: MigrationMapping[] };

let root: string;
let sourceDir: string;
let targetDir: string;
const opened: Storage[] = [];
const authoredSources = new Map<string, string>();

async function authoredFile(file: string, bytes: string): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, bytes);
	authoredSources.set(file, bytes);
}
async function fixture(name: string, entries: SessionEntry[], state?: JsonObject, record = header()): Promise<string> {
	const file = join(sourceDir, name);
	const jsonl = `${[record, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	await authoredFile(file, jsonl);
	if (state !== undefined) await authoredFile(`${file}.acp.json`, JSON.stringify(state));
	return file;
}
async function sourceFiles(dir: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const file = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await sourceFiles(file)));
		else files.push(file);
	}
	return files.sort();
}
async function store(mapping: MigrationMapping): Promise<Storage> {
	const storage = await openNodeSqliteStorage(join(targetDir, mapping.database));
	opened.push(storage);
	return storage;
}
async function close(storage: Storage): Promise<void> {
	opened.splice(opened.indexOf(storage), 1);
	await storage.close(ctx);
}
async function document(storage: Storage, id: ConversationId, kind = "acp.state"): Promise<JsonObject> {
	const record = await storage.findDocument(
		{ kind, scope: { kind: "conversation", conversationId: id } },
		"current",
		ctx,
	);
	if (!record) throw new Error(`Missing fixture document: ${kind}`);
	const doc = await storage.document(record.id, "current", ctx);
	if (!doc) throw new Error(`Unreadable fixture document: ${kind}`);
	return doc.value;
}
async function metadata(storage: Storage, id: ConversationId): Promise<MigrationMetadata> {
	return (await document(storage, id, "pi-web-ui.migration")) as unknown as MigrationMetadata;
}
async function context(storage: Storage, id: ConversationId, at?: EntryId): Promise<View> {
	return (await runtime.readContextFrom(line, storage, id, ctx, at)).view;
}
async function archive(storage: Storage, id: ConversationId, raw: SessionEntry[]): Promise<MigrationMetadata> {
	const meta = await metadata(storage, id);
	expect(meta.entryOrder).toEqual(raw.map((entry) => entry.id));
	for (const entry of raw) {
		expect(meta.entryIds[entry.id]).toEqual(expect.any(Number));
		const row = await storage.entry(id, meta.entryIds[entry.id]! as EntryId, ctx);
		expect(row?.entry.data).toEqual(entry);
	}
	const rawIds = Object.values(meta.entryIds);
	const contextIds = Object.values(meta.contextEntryIds);
	// Raw archive lookup must never alias a materialized/edited context row.
	expect(new Set([...rawIds, ...contextIds]).size).toBe(rawIds.length + contextIds.length);
	return meta;
}
async function readManifest(): Promise<Manifest> {
	return JSON.parse(await readFile(join(targetDir, manifestName), "utf8")) as Manifest;
}
async function optionalText(file: string): Promise<string | null> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return null;
	}
}

// Compare publication, not SQLite/WAL housekeeping bytes. Opening an empty DB is
// not itself a published conversation; any conversation, entry or document is.
async function publishedDatabases(): Promise<Record<string, unknown>> {
	let names: string[];
	try {
		names = await readdir(targetDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return {};
	}
	const databases: Record<string, unknown> = {};
	for (const name of names.filter((item) => item.endsWith(".sqlite")).sort()) {
		const db = new DatabaseSync(join(targetDir, name), { readOnly: true });
		try {
			const conversations = db.prepare("SELECT * FROM conversations ORDER BY id").all();
			const entries = db.prepare("SELECT * FROM entries ORDER BY id").all();
			const documents = db.prepare("SELECT * FROM documents ORDER BY id").all();
			const revisions = db.prepare("SELECT * FROM document_revisions ORDER BY document_id, seq").all();
			if (conversations.length || entries.length || documents.length || revisions.length)
				databases[name] = { conversations, entries, documents, revisions };
		} finally {
			db.close();
		}
	}
	return databases;
}
async function publication() {
	return {
		manifest: await optionalText(join(targetDir, manifestName)),
		databases: await publishedDatabases(),
	};
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "durable-migrator-review-"));
	sourceDir = join(root, "offline-sources");
	targetDir = join(root, "durable");
	authoredSources.clear();
	await mkdir(sourceDir);
});
afterEach(async () => {
	try {
		for (const storage of opened.splice(0)) await storage.close(ctx);
		for (const [file, bytes] of authoredSources) expect(await readFile(file, "utf8")).toBe(bytes);
		// Also catch an unexpected child sidecar or any other write beside a source.
		expect(await sourceFiles(sourceDir)).toEqual(
			[...authoredSources.keys()].filter((file) => file.startsWith(`${sourceDir}${sep}`)).sort(),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

describe("independent offline durable-migrator review (Ops #573)", () => {
	it("unfolds an ACP transport marker without inventing a native summary", async () => {
		const raw = [
			user("firstusr", null, "first request"),
			assistant("oldreply", "firstusr", "uncompressed old answer"),
			user("keep0001", "oldreply", "kept request"),
			fold("fold0001", "keep0001", "keep0001"),
			user("tail0001", "fold0001", "after transport fold"),
		];
		await fixture("transport.jsonl", raw);
		const report = await migrateSessionsToDurable({ sourceDir, targetDir });
		const mapping = report.sessions[0]!;
		const storage = await store(mapping);
		const id = mapping.conversationId as ConversationId;
		expect((await context(storage, id)).messages).toEqual([
			{ role: "user", content: "first request", timestamp: 0 },
			{
				role: "assistant",
				content: [{ type: "text", text: "uncompressed old answer" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "offline-fixture",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 0,
			},
			{ role: "user", content: "kept request", timestamp: 0 },
			{ role: "user", content: "after transport fold", timestamp: 0 },
		]);
		expect(Object.keys((await archive(storage, id, raw)).contextEntryIds)).toEqual([
			"firstusr",
			"oldreply",
			"keep0001",
			"tail0001",
		]);
	});

	it("unfolds repeated transport markers before applying authored ACP coverage and stable refs", async () => {
		const raw = [
			user("firstusr", null, "pinned first request"),
			user("covered1", "firstusr", "covered old one"),
			user("uncover1", "covered1", "uncovered old request"),
			user("covered2", "uncover1", "covered old two"),
			fold("fold0001", "covered2", "covered2"),
			user("keep0001", "fold0001", "kept request"),
			fold("fold0002", "keep0001", "keep0001"),
			user("tail0001", "fold0002", "latest request"),
		];
		const state: JsonObject = {
			blocks: [
				{ blockId: "b1", active: false, summary: "superseded observation", directMessageIds: ["covered1"] },
				{
					blockId: "b2",
					active: true,
					summary: "authored two-message observation",
					topic: "review",
					directMessageIds: ["covered2#0"],
					effectiveMessageIds: ["covered1", "covered2#0"],
					directBlockIds: ["b1"],
				},
			],
			messageRefs: {
				byRaw: { covered1: "m00002", "covered2#0": "m00004" },
				byRef: { m00002: "covered1", m00004: "covered2#0" },
			},
			nextBlockId: 3,
		};
		await fixture("covered-transport.jsonl", raw, state);
		const report = await migrateSessionsToDurable({ sourceDir, targetDir });
		const storage = await store(report.sessions[0]!);
		const id = report.sessions[0]!.conversationId as ConversationId;
		expect((await context(storage, id)).messages).toEqual([
			{ role: "user", content: "pinned first request", timestamp: 0 },
			{
				role: "user",
				content: [{ type: "text", text: "[Observation from compress b2 — review]\nauthored two-message observation" }],
				timestamp: 0,
			},
			{ role: "user", content: "uncovered old request", timestamp: 0 },
			{ role: "user", content: "kept request", timestamp: 0 },
			{ role: "user", content: "latest request", timestamp: 0 },
		]);
		const acp = await document(storage, id);
		expect(acp.blocks).toEqual([
			{ blockId: "b1", active: false, summary: "superseded observation", directMessageIds: ["covered1"] },
			{
				blockId: "b2",
				active: true,
				summary: "authored two-message observation",
				topic: "review",
				directMessageIds: ["covered2#0"],
				effectiveMessageIds: ["covered1", "covered2#0"],
				directBlockIds: ["b1"],
			},
		]);
		expect(acp.messageRefs).toEqual({
			byRaw: { covered1: "m00002", "covered2#0": "m00004" },
			byRef: { m00002: "covered1", m00004: "covered2#0" },
		});
		expect(Object.keys((await archive(storage, id, raw)).contextEntryIds)).toEqual([
			"firstusr",
			"b2",
			"uncover1",
			"keep0001",
			"tail0001",
		]);
	});

	it("accepts an inactive embedded range-only block whose old boundaries are absent from current context", async () => {
		// W1 range compatibility preserves an explicitly inactive historical block.
		// Resolving its missing boundaries would introduce a refusal, unlike legacy.
		const raw: SessionEntry[] = [
			user("firstusr", null, "valid current root"),
			{
				type: "custom",
				id: "state001",
				parentId: "firstusr",
				timestamp: stamp,
				customType: "acp-state",
				data: {
					blocks: [
						{
							blockId: "b4",
							active: false,
							summary: "inactive historical range must not appear",
							startRef: "m00002",
							endRef: "m00004",
						},
					],
					messageRefs: {
						byRaw: { gone0001: "m00002", gone0002: "m00004", firstusr: "m00005" },
						byRef: { m00002: "gone0001", m00004: "gone0002", m00005: "firstusr" },
					},
					nextBlockId: 5,
				},
			},
			user("tail0001", "state001", "valid current tail"),
		];
		await fixture("inactive-historical-range.jsonl", raw);
		const report = await migrateSessionsToDurable({ sourceDir, targetDir });
		const mapping = report.sessions[0]!;
		expect(mapping.blocks).toBe(1);
		expect(mapping.activeBlocks).toBe(0);
		const storage = await store(mapping);
		const id = mapping.conversationId as ConversationId;
		const meta = await archive(storage, id, raw);
		expect(Object.keys(meta.contextEntryIds)).toEqual(["firstusr", "tail0001"]);
		expect(meta.contextEntryIds).not.toHaveProperty("b4");
		expect((await context(storage, id)).messages).toEqual([
			{ role: "user", content: "valid current root", timestamp: 0 },
			{ role: "user", content: "valid current tail", timestamp: 0 },
		]);
		const acp = await document(storage, id);
		expect(acp.blocks).toEqual([
			{
				blockId: "b4",
				active: false,
				summary: "inactive historical range must not appear",
				startRef: "m00002",
				endRef: "m00004",
			},
		]);
		expect(acp.messageRefs).toEqual({
			byRaw: { gone0001: "m00002", gone0002: "m00004", firstusr: "m00005" },
			byRef: { m00002: "gone0001", m00004: "gone0002", m00005: "firstusr" },
		});
		expect(acp.nextBlockId).toBe(5);
	});

	it("keeps a genuine native compaction instead of resurrecting its summarized history", async () => {
		const raw = [
			user("firstusr", null, "must stay archived"),
			user("old00001", "firstusr", "also archived"),
			user("keep0001", "old00001", "native retained request"),
			native("native01", "keep0001", "keep0001"),
			user("tail0001", "native01", "after native checkpoint"),
		];
		await fixture("native.jsonl", raw, { blocks: [] });
		const report = await migrateSessionsToDurable({ sourceDir, targetDir });
		const storage = await store(report.sessions[0]!);
		const id = report.sessions[0]!.conversationId as ConversationId;
		expect((await context(storage, id)).messages).toEqual([
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\ngenuine native checkpoint\n</summary>",
					},
				],
				timestamp: 0,
			},
			{ role: "user", content: "native retained request", timestamp: 0 },
			{ role: "user", content: "after native checkpoint", timestamp: 0 },
		]);
		expect((await document(storage, id)).blocks).toEqual([]);
		expect(Object.keys((await archive(storage, id, raw)).contextEntryIds)).toEqual([
			"native01",
			"keep0001",
			"tail0001",
		]);
	});

	it("excludes an absent ACP block after genuine native compaction without rewriting archival block/ref state", async () => {
		// Legacy syncBlocks uses the post-native-compaction message IDs: this block
		// has no remaining coverage. Effective selection must not rewrite raw state.
		const raw = [
			user("firstusr", null, "archived first request"),
			user("old00001", "firstusr", "archived covered request"),
			user("keep0001", "old00001", "native retained request"),
			native("native01", "keep0001", "keep0001"),
			user("tail0001", "native01", "after native checkpoint"),
		];
		await fixture("native-absent-block.jsonl", raw, {
			blocks: [
				{
					blockId: "b7",
					active: true,
					summary: "observation outside the native context",
					directMessageIds: ["old00001#0"],
					effectiveMessageIds: ["old00001#0"],
					directBlockIds: [],
				},
			],
			messageRefs: {
				byRaw: { firstusr: "m00001", "old00001#0": "m00002", keep0001: "m00003" },
				byRef: { m00001: "firstusr", m00002: "old00001#0", m00003: "keep0001" },
			},
			tokenSnapshot: { m00002: 23 },
			nextBlockId: 8,
		});
		const report = await migrateSessionsToDurable({ sourceDir, targetDir });
		const mapping = report.sessions[0]!;
		expect(mapping.blocks).toBe(1);
		expect(mapping.activeBlocks).toBe(0);
		expect((await readManifest()).sessions[0]!.activeBlocks).toBe(0);
		const storage = await store(mapping);
		const id = mapping.conversationId as ConversationId;
		const meta = await archive(storage, id, raw);
		expect(Object.keys(meta.contextEntryIds)).toEqual(["native01", "keep0001", "tail0001"]);
		expect(meta.contextEntryIds).not.toHaveProperty("b7");
		expect(meta.contextOrder).toHaveLength(3);
		expect((await context(storage, id)).messages).toEqual([
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\ngenuine native checkpoint\n</summary>",
					},
				],
				timestamp: 0,
			},
			{ role: "user", content: "native retained request", timestamp: 0 },
			{ role: "user", content: "after native checkpoint", timestamp: 0 },
		]);
		const acp = await document(storage, id);
		expect(acp.blocks).toEqual([
			{
				blockId: "b7",
				active: true,
				summary: "observation outside the native context",
				directMessageIds: ["old00001#0"],
				effectiveMessageIds: ["old00001#0"],
				directBlockIds: [],
			},
		]);
		expect(acp.messageRefs).toEqual({
			byRaw: { firstusr: "m00001", "old00001#0": "m00002", keep0001: "m00003" },
			byRef: { m00001: "firstusr", m00002: "old00001#0", m00003: "keep0001" },
		});
		expect(acp.tokenSnapshot).toEqual({ m00002: 23 });
		expect(acp.nextBlockId).toBe(8);
	});

	it("unfolds a later ACP marker while retaining the earlier genuine native boundary", async () => {
		const raw = [
			user("firstusr", null, "before genuine boundary"),
			user("keep0001", "firstusr", "native retained request"),
			native("native01", "keep0001", "keep0001"),
			user("middle01", "native01", "between native and transport"),
			fold("fold0001", "middle01", "middle01"),
			user("tail0001", "fold0001", "after both boundaries"),
		];
		await fixture("native-then-transport.jsonl", raw);
		const report = await migrateSessionsToDurable({ sourceDir, targetDir });
		const storage = await store(report.sessions[0]!);
		const id = report.sessions[0]!.conversationId as ConversationId;
		expect((await context(storage, id)).messages).toEqual([
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\ngenuine native checkpoint\n</summary>",
					},
				],
				timestamp: 0,
			},
			{ role: "user", content: "native retained request", timestamp: 0 },
			{ role: "user", content: "between native and transport", timestamp: 0 },
			{ role: "user", content: "after both boundaries", timestamp: 0 },
		]);
		await archive(storage, id, raw);
	});

	it.each(["absent", "empty"] as const)(
		"inherits a copied offline parent sidecar when child state is %s; fork refs survive reopen",
		async (childState) => {
			const parentName = "1970-01-01_parent-review.jsonl";
			const inherited = [
				user("firstusr", null, "inherited first request"),
				user("covered1", "firstusr", "parent old one"),
				user("covered2", "covered1", "parent old two"),
			];
			const parent = await fixture(
				join("copied", parentName),
				[...inherited, user("parent01", "covered2", "parent-only tail")],
				{
					blocks: [
						{
							blockId: "b7",
							active: true,
							summary: "inherited authored observation",
							effectiveMessageIds: ["covered1", "covered2#0"],
						},
					],
					messageRefs: {
						byRaw: { firstusr: "m00001", covered1: "m00002", "covered2#0": "m00003" },
						byRef: { m00001: "firstusr", m00002: "covered1", m00003: "covered2#0" },
					},
					tokenSnapshot: { m00002: 9, m00003: 11 },
					nextBlockId: 8,
					nextRunId: 4,
				},
				header("parent-review"),
			);
			const childRaw = [...inherited, user("child001", "covered2", "child fork tail")];
			// The copied header retains an unavailable synthetic original path.
			// Only the explicit map authorizes using its listed offline replacement.
			const originalParent = `/__pi_migration_review_not_live__/${parentName}`;
			const parentSessionMap = {
				[originalParent]: childState === "absent" ? join("copied", parentName) : parent,
			};
			await fixture(
				"child.jsonl",
				childRaw,
				childState === "empty" ? { blocks: [], messageRefs: { byRaw: {}, byRef: {} } } : undefined,
				header("child-review", workspace, originalParent),
			);
			const report = await migrateSessionsToDurable({ sourceDir, targetDir, parentSessionMap });
			const mapping = report.sessions.find((item) => item.sessionId === "child-review")!;
			expect(mapping.blocks).toBe(1);
			expect(mapping.activeBlocks).toBe(1);
			const storage = await store(mapping);
			const id = mapping.conversationId as ConversationId;
			const meta = await archive(storage, id, childRaw);
			expect(meta.branch).toEqual(["firstusr", "covered1", "covered2", "child001"]);
			await close(storage);

			const reopened = await store(mapping);
			expect((await context(reopened, id)).messages).toEqual([
				{ role: "user", content: "inherited first request", timestamp: 0 },
				{
					role: "user",
					content: [{ type: "text", text: "[Observation from compress b7]\ninherited authored observation" }],
					timestamp: 0,
				},
				{ role: "user", content: "child fork tail", timestamp: 0 },
			]);
			expect((await context(reopened, id, meta.contextOrder[1]! as EntryId)).messages).toEqual([
				{ role: "user", content: "inherited first request", timestamp: 0 },
				{
					role: "user",
					content: [{ type: "text", text: "[Observation from compress b7]\ninherited authored observation" }],
					timestamp: 0,
				},
			]);
			const acp = await document(reopened, id);
			expect(acp.blocks).toEqual([
				{
					blockId: "b7",
					active: true,
					summary: "inherited authored observation",
					effectiveMessageIds: ["covered1", "covered2#0"],
				},
			]);
			expect(acp.messageRefs).toEqual({
				byRaw: { firstusr: "m00001", covered1: "m00002", "covered2#0": "m00003" },
				byRef: { m00001: "firstusr", m00002: "covered1", m00003: "covered2#0" },
			});
			expect(acp.tokenSnapshot).toEqual({ m00002: 9, m00003: 11 });
			expect(acp.nextBlockId).toBe(8);
			expect(acp.nextRunId).toBe(4);
			await archive(reopened, id, childRaw);
			await close(reopened);
			expect(
				(await migrateSessionsToDurable({ sourceDir, targetDir, parentSessionMap, verify: true })).mismatches,
			).toBe(0);
		},
	);

	it("excludes an inherited active parent block wholly beyond the fork while preserving raw block/ref state", async () => {
		// The parent advanced past the child's fork. Legacy syncBlocks deactivates
		// this block for the child's effective context, not for the parent's archive.
		const parentRaw = [
			user("root0001", null, "shared root request"),
			user("parent01", "root0001", "parent-only request beyond fork"),
		];
		const parent = await fixture(
			"a-parent.jsonl",
			parentRaw,
			{
				blocks: [
					{
						blockId: "b7",
						active: true,
						summary: "parent-only observation beyond fork",
						directMessageIds: ["parent01#0"],
						effectiveMessageIds: ["parent01#0"],
						directBlockIds: [],
					},
				],
				messageRefs: {
					byRaw: { root0001: "m00001", "parent01#0": "m00002" },
					byRef: { m00001: "root0001", m00002: "parent01#0" },
				},
				tokenSnapshot: { m00002: 13 },
				nextBlockId: 8,
			},
			header("parent-beyond-fork"),
		);
		const childRaw = [user("root0001", null, "shared root request"), user("child001", "root0001", "child fork tail")];
		await fixture("b-child.jsonl", childRaw, undefined, header("child-before-parent-block", workspace, parent));
		const report = await migrateSessionsToDurable({ sourceDir, targetDir });
		const parentMapping = report.sessions.find((item) => item.sessionId === "parent-beyond-fork")!;
		const mapping = report.sessions.find((item) => item.sessionId === "child-before-parent-block")!;
		expect(parentMapping.activeBlocks).toBe(1);
		expect(mapping.blocks).toBe(1);
		expect(mapping.activeBlocks).toBe(0);
		expect(
			(await readManifest()).sessions.find((item) => item.sessionId === "child-before-parent-block")!.activeBlocks,
		).toBe(0);
		const storage = await store(mapping);
		const id = mapping.conversationId as ConversationId;
		const meta = await archive(storage, id, childRaw);
		await archive(storage, parentMapping.conversationId as ConversationId, parentRaw);
		expect(meta.branch).toEqual(["root0001", "child001"]);
		expect(Object.keys(meta.contextEntryIds)).toEqual(["root0001", "child001"]);
		expect(meta.contextEntryIds).not.toHaveProperty("b7");
		expect(meta.contextOrder).toHaveLength(2);
		await close(storage);

		const reopened = await store(mapping);
		expect((await context(reopened, id)).messages).toEqual([
			{ role: "user", content: "shared root request", timestamp: 0 },
			{ role: "user", content: "child fork tail", timestamp: 0 },
		]);
		const acp = await document(reopened, id);
		expect(acp.blocks).toEqual([
			{
				blockId: "b7",
				active: true,
				summary: "parent-only observation beyond fork",
				directMessageIds: ["parent01#0"],
				effectiveMessageIds: ["parent01#0"],
				directBlockIds: [],
			},
		]);
		expect(acp.messageRefs).toEqual({
			byRaw: { root0001: "m00001", "parent01#0": "m00002" },
			byRef: { m00001: "root0001", m00002: "parent01#0" },
		});
		expect(acp.tokenSnapshot).toEqual({ m00002: 13 });
		expect(acp.nextBlockId).toBe(8);
	});

	it.each(["absolute", "relative"] as const)(
		"accepts an exact %s offline parent reference with an explicitly empty terminal sidecar",
		async (pathKind) => {
			const parent = await fixture(
				join("copied", "uncompressed-parent.jsonl"),
				[user("firstusr", null, "uncompressed inherited request")],
				{
					blocks: [],
					messageRefs: { byRaw: { firstusr: "m00001" }, byRef: { m00001: "firstusr" } },
				},
				header("uncompressed-parent"),
			);
			const raw = [
				user("firstusr", null, "uncompressed inherited request"),
				user("child001", "firstusr", "uncompressed fork request"),
			];
			await fixture(
				"child.jsonl",
				raw,
				undefined,
				header(
					"uncompressed-child",
					workspace,
					pathKind === "absolute" ? parent : join("copied", "uncompressed-parent.jsonl"),
				),
			);
			const report = await migrateSessionsToDurable({ sourceDir, targetDir });
			const mapping = report.sessions.find((item) => item.sessionId === "uncompressed-child")!;
			const storage = await store(mapping);
			const id = mapping.conversationId as ConversationId;
			expect((await context(storage, id)).messages).toEqual([
				{ role: "user", content: "uncompressed inherited request", timestamp: 0 },
				{ role: "user", content: "uncompressed fork request", timestamp: 0 },
			]);
			const acp = await document(storage, id);
			// Legacy inherits only nonempty parent blocks; an empty terminal parent
			// proves lineage validity but leaves the child's default state untouched.
			// Missing persisted fields represent those empty defaults, not parent refs.
			expect(acp.blocks === undefined ? [] : acp.blocks).toEqual([]);
			expect(acp.messageRefs === undefined ? { byRaw: {}, byRef: {} } : acp.messageRefs).toEqual({
				byRaw: {},
				byRef: {},
			});
			await archive(storage, id, raw);
		},
	);

	it("prefers nonempty child-owned ACP without requiring an unavailable historical parent", async () => {
		const raw = [
			user("firstusr", null, "child first request"),
			user("covered1", "firstusr", "child covered request"),
			user("tail0001", "covered1", "child current request"),
		];
		await fixture(
			"child-owned.jsonl",
			raw,
			{
				blocks: [
					{ blockId: "b9", active: true, summary: "child-owned observation", effectiveMessageIds: ["covered1"] },
				],
				messageRefs: { byRaw: { covered1: "m00022" }, byRef: { m00022: "covered1" } },
				nextBlockId: 10,
			},
			header("child-owned", workspace, "/__pi_migration_review_not_live__/unavailable-parent.jsonl"),
		);
		const report = await migrateSessionsToDurable({ sourceDir, targetDir });
		const storage = await store(report.sessions[0]!);
		const id = report.sessions[0]!.conversationId as ConversationId;
		expect((await context(storage, id)).messages).toEqual([
			{ role: "user", content: "child first request", timestamp: 0 },
			{
				role: "user",
				content: [{ type: "text", text: "[Observation from compress b9]\nchild-owned observation" }],
				timestamp: 0,
			},
			{ role: "user", content: "child current request", timestamp: 0 },
		]);
		const acp = await document(storage, id);
		expect(acp.blocks).toEqual([
			{ blockId: "b9", active: true, summary: "child-owned observation", effectiveMessageIds: ["covered1"] },
		]);
		expect(acp.messageRefs).toEqual({ byRaw: { covered1: "m00022" }, byRef: { m00022: "covered1" } });
		expect(acp.nextBlockId).toBe(10);
		await archive(storage, id, raw);
	});

	it("does not basename-guess a copied parent for an unmapped outside historical reference", async () => {
		await fixture(
			join("copied", "same-name-parent.jsonl"),
			[user("firstusr", null, "copied parent request")],
			{ blocks: [] },
			header("copied-parent"),
		);
		await fixture(
			"child.jsonl",
			[user("firstusr", null, "copied parent request"), user("child001", "firstusr", "fork request")],
			undefined,
			header("unmapped-child", workspace, "/__pi_migration_review_not_live__/same-name-parent.jsonl"),
		);
		const before = await publication();
		await expect(migrateSessionsToDurable({ sourceDir, targetDir })).rejects.toThrow(/parent|map|source|offline/i);
		expect(await publication()).toEqual(before);
	});

	it.each(["missing", "outside"] as const)(
		"refuses an explicit parent map targeting a %s source snapshot before publishing",
		async (targetKind) => {
			const originalParent = "/__pi_migration_review_not_live__/original-parent.jsonl";
			// The outside fixture is still authored under this test's own temp root,
			// but is not listed in sourceDir and must not be read as a parent.
			const mappedParent =
				targetKind === "outside"
					? await fixture(
							"../unlisted-parent.jsonl",
							[user("firstusr", null, "unlisted synthetic parent")],
							{ blocks: [] },
							header("unlisted-parent"),
						)
					: join(sourceDir, "missing-parent.jsonl");
			await fixture("a-valid.jsonl", [user("valid001", null, "valid request")], undefined, header("valid"));
			await fixture(
				"z-child.jsonl",
				[user("firstusr", null, "child request")],
				undefined,
				header("invalid-map-child", workspace, originalParent),
			);
			const before = await publication();
			await expect(
				migrateSessionsToDurable({ sourceDir, targetDir, parentSessionMap: { [originalParent]: mappedParent } }),
			).rejects.toThrow(/parent|map|source|offline/i);
			expect(await publication()).toEqual(before);
		},
	);

	it.each(["JSONL", "ACP sidecar"] as const)(
		"validates an invalid later %s before publishing an earlier valid source",
		async (invalidKind) => {
			await fixture("a-valid.jsonl", [user("valid001", null, "valid request")], undefined, header("valid"));
			const invalid = await fixture(
				"z-invalid.jsonl",
				[user("firstusr", null, "invalid source")],
				undefined,
				header("invalid"),
			);
			if (invalidKind === "JSONL") {
				await authoredFile(invalid, `${JSON.stringify(header("invalid"))}\n{"type":"message"\n`);
			} else {
				await authoredFile(`${invalid}.acp.json`, '{"blocks":[');
			}
			const before = await publication();
			await expect(migrateSessionsToDurable({ sourceDir, targetDir })).rejects.toThrow();
			expect(await publication()).toEqual(before);
		},
	);

	it("validates a malformed off-branch message payload before publishing an earlier valid source", async () => {
		// The selected root/tail branch is valid. Preflight must also validate the
		// off-branch raw archive, before committing the earlier valid session.
		await fixture("a-valid.jsonl", [user("valid001", null, "valid earlier request")], undefined, header("valid-first"));
		const invalid = [
			header("invalid-off-branch"),
			user("root0001", null, "valid selected root"),
			{ type: "message", id: "bad00001", parentId: "root0001", timestamp: stamp },
			user("tail0001", "root0001", "valid selected tail"),
		];
		await authoredFile(
			join(sourceDir, "z-invalid.jsonl"),
			`${invalid.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);
		const before = await publication();
		await expect(migrateSessionsToDurable({ sourceDir, targetDir })).rejects.toThrow();
		expect(await publication()).toEqual(before);
	});

	it("refuses a missing required offline parent before publishing even an earlier valid source", async () => {
		await fixture("a-valid.jsonl", [user("valid001", null, "independent valid request")], undefined, header("valid"));
		await fixture(
			"z-child.jsonl",
			[
				user("firstusr", null, "child copied history"),
				user("keep0001", "firstusr", "kept child history"),
				fold("fold0001", "keep0001", "keep0001"),
			],
			undefined,
			header("missing-parent-child", workspace, join(sourceDir, "not-copied-parent.jsonl")),
		);
		const before = await publication();
		await expect(migrateSessionsToDurable({ sourceDir, targetDir })).rejects.toThrow(/parent|inherit|fork|ACP/i);
		expect(await publication()).toEqual(before);
	});

	it("refuses required parent ACP state that is absent instead of silently inheriting empty state", async () => {
		const parent = await fixture(
			"parent-without-state.jsonl",
			[user("firstusr", null, "parent history")],
			undefined,
			header("parent-without-state"),
		);
		await fixture(
			"child.jsonl",
			[user("firstusr", null, "parent history"), fold("fold0001", "firstusr", "firstusr")],
			undefined,
			header("child-needs-state", workspace, parent),
		);
		const before = await publication();
		await expect(migrateSessionsToDurable({ sourceDir, targetDir })).rejects.toThrow(/parent|inherit|ACP|state/i);
		expect(await publication()).toEqual(before);
	});

	it.each(["present", "missing"] as const)(
		"refuses the same UUID under a changed cwd globally with a %s manifest and no target mutation",
		async (manifestState) => {
			const raw = [user("firstusr", null, "original workspace request")];
			await fixture("session.jsonl", raw, undefined, header("workspace-identity"));
			await migrateSessionsToDurable({ sourceDir, targetDir });
			if (manifestState === "missing") await rm(join(targetDir, manifestName));
			await fixture("session.jsonl", raw, undefined, header("workspace-identity", "/migration-review/other-workspace"));
			const before = await publication();
			await expect(migrateSessionsToDurable({ sourceDir, targetDir })).rejects.toThrow(
				/cwd|workspace|identity|header/i,
			);
			expect(await publication()).toEqual(before);
		},
	);

	it.each(["same", "different"] as const)(
		"preflights duplicate source UUIDs in %s workspaces before any partial publication",
		async (cwdKind) => {
			await fixture("a-valid.jsonl", [user("valid001", null, "valid request")], undefined, header("unique-first"));
			await fixture("b-duplicate.jsonl", [user("firstusr", null, "duplicate one")], undefined, header("duplicate"));
			await fixture(
				"c-duplicate.jsonl",
				[user("firstusr", null, "duplicate two")],
				undefined,
				header("duplicate", cwdKind === "same" ? workspace : "/migration-review/second-workspace"),
			);
			const before = await publication();
			await expect(migrateSessionsToDurable({ sourceDir, targetDir })).rejects.toThrow(/duplicate.*(?:UUID|session)/i);
			expect(await publication()).toEqual(before);
		},
	);

	it.each([
		{ label: "rename", name: "  Latest file-wide title  ", expected: "Latest file-wide title" },
		{ label: "empty clear", name: "", expected: null },
		{ label: "whitespace clear", name: " \t ", expected: null },
		{ label: "missing-name clear", name: undefined, expected: null },
	])("uses the latest file-wide $label off the active branch", async ({ name, expected }) => {
		const raw: SessionEntry[] = [
			user("firstusr", null, "first request"),
			{ type: "session_info", id: "titleold", parentId: "firstusr", timestamp: stamp, name: "Old branch title" },
			user("active01", "titleold", "active branch request"),
			{
				type: "session_info",
				id: "titleoff",
				parentId: "firstusr",
				timestamp: stamp,
				...(name === undefined ? {} : { name }),
			},
			user("tail0001", "active01", "active branch tail"),
		];
		await fixture("title.jsonl", raw);
		const report = await migrateSessionsToDurable({ sourceDir, targetDir });
		const mapping = report.sessions[0]!;
		expect(mapping.title).toBe(expected);
		expect((await readManifest()).sessions[0]!.title).toBe(expected);
		const storage = await store(mapping);
		const id = mapping.conversationId as ConversationId;
		const meta = await archive(storage, id, raw);
		expect(meta.title).toBe(expected);
		expect(meta.branch).toEqual(["firstusr", "titleold", "active01", "tail0001"]);
		expect((await context(storage, id)).messages).toEqual([
			{ role: "user", content: "first request", timestamp: 0 },
			{ role: "user", content: "active branch request", timestamp: 0 },
			{ role: "user", content: "active branch tail", timestamp: 0 },
		]);
		await close(storage);
		expect((await migrateSessionsToDurable({ sourceDir, targetDir, verify: true })).mismatches).toBe(0);
	});

	it("replays unchanged history and appends once across reopen without aliasing raw/context IDs", async () => {
		const initialRaw = [user("12345678", null, "initial request"), user("23456789", "12345678", "second request")];
		await fixture("append.jsonl", initialRaw);
		const initial = await migrateSessionsToDurable({ sourceDir, targetDir });
		expect(initial.migrated).toBe(1);
		const first = initial.sessions[0]!;
		const id = first.conversationId as ConversationId;
		const storage = await store(first);
		const firstIds = (await archive(storage, id, initialRaw)).entryIds;
		expect((await context(storage, id)).messages).toEqual([
			{ role: "user", content: "initial request", timestamp: 0 },
			{ role: "user", content: "second request", timestamp: 0 },
		]);
		await close(storage);
		const beforeReplay = await publication();
		const replay = await migrateSessionsToDurable({ sourceDir, targetDir });
		expect({ migrated: replay.migrated, skipped: replay.skipped }).toEqual({ migrated: 0, skipped: 1 });
		expect(replay.sessions).toEqual(initial.sessions);
		expect(await publication()).toEqual(beforeReplay);

		const appendedRaw = [...initialRaw, user("34567890", "23456789", "authored appended request")];
		await fixture("append.jsonl", appendedRaw);
		const updated = await migrateSessionsToDurable({ sourceDir, targetDir });
		expect({ migrated: updated.migrated, skipped: updated.skipped }).toEqual({ migrated: 1, skipped: 0 });
		expect(updated.sessions[0]!.conversationId).toBe(first.conversationId);
		expect(updated.sessions[0]!.headId).toBeGreaterThan(first.headId);
		const reopened = await store(updated.sessions[0]!);
		const nextIds = (await archive(reopened, id, appendedRaw)).entryIds;
		expect(nextIds["12345678"]).toBe(firstIds["12345678"]);
		expect(nextIds["23456789"]).toBe(firstIds["23456789"]);
		expect((await context(reopened, id)).messages).toEqual([
			{ role: "user", content: "initial request", timestamp: 0 },
			{ role: "user", content: "second request", timestamp: 0 },
			{ role: "user", content: "authored appended request", timestamp: 0 },
		]);
		const rows = (await reopened.scanEntries({ conversationId: id, order: "ascending" }, 100, undefined, ctx)).items;
		expect(rows.filter((row) => (row.data as JsonObject | undefined)?.type === "message")).toHaveLength(3);
		await close(reopened);
		const beforeSecondReplay = await publication();
		const secondReplay = await migrateSessionsToDurable({ sourceDir, targetDir });
		expect({ migrated: secondReplay.migrated, skipped: secondReplay.skipped }).toEqual({ migrated: 0, skipped: 1 });
		expect(secondReplay.sessions).toEqual(updated.sessions);
		expect(await publication()).toEqual(beforeSecondReplay);
		expect((await migrateSessionsToDurable({ sourceDir, targetDir, verify: true })).mismatches).toBe(0);
	});

	it("recovers committed DB mappings from a missing manifest, including an unselected workspace", async () => {
		await fixture("a.jsonl", [user("firstusr", null, "outside later selection")], undefined, header("session-a"));
		await fixture(
			join("subset", "b.jsonl"),
			[user("firstusr", null, "inside later selection")],
			undefined,
			header("session-b", "/migration-review/workspace-b"),
		);
		const initial = await migrateSessionsToDurable({ sourceDir, targetDir });
		const committed = await readManifest();
		expect(committed.sessions.map((item) => item.sessionId)).toEqual(["session-a", "session-b"]);
		const before = await publishedDatabases();
		await rm(join(targetDir, manifestName));
		await writeFile(join(targetDir, `${manifestName}.tmp`), '{"format":1,"sessions":[');
		const recovered = await migrateSessionsToDurable({ sourceDir: join(sourceDir, "subset"), targetDir });
		expect({ migrated: recovered.migrated, skipped: recovered.skipped }).toEqual({ migrated: 0, skipped: 1 });
		expect(recovered.sessions).toEqual(initial.sessions.filter((item) => item.sessionId === "session-b"));
		expect(await readManifest()).toEqual(committed);
		expect(await publishedDatabases()).toEqual(before);
		expect(await optionalText(join(targetDir, `${manifestName}.tmp`))).toBeNull();
		expect((await migrateSessionsToDurable({ sourceDir, targetDir, verify: true })).mismatches).toBe(0);
	});

	it("recovers a stale manifest after a committed append without remigrating entries", async () => {
		const raw = [user("firstusr", null, "initial request")];
		await fixture("stale.jsonl", raw);
		await migrateSessionsToDurable({ sourceDir, targetDir });
		const stale = await readFile(join(targetDir, manifestName), "utf8");
		await fixture("stale.jsonl", [...raw, user("append01", "firstusr", "committed append")]);
		const updated = await migrateSessionsToDurable({ sourceDir, targetDir });
		const committed = await readManifest();
		const before = await publishedDatabases();
		await writeFile(join(targetDir, manifestName), stale);
		await writeFile(join(targetDir, `${manifestName}.tmp`), '{"format":1');
		const recovered = await migrateSessionsToDurable({ sourceDir, targetDir });
		expect({ migrated: recovered.migrated, skipped: recovered.skipped }).toEqual({ migrated: 0, skipped: 1 });
		expect(recovered.sessions).toEqual(updated.sessions);
		expect(await readManifest()).toEqual(committed);
		expect(await publishedDatabases()).toEqual(before);
		expect(await optionalText(join(targetDir, `${manifestName}.tmp`))).toBeNull();
		expect((await migrateSessionsToDurable({ sourceDir, targetDir, verify: true })).mismatches).toBe(0);
	});

	it("refuses a conflicting manifest identity before publishing a pending valid append", async () => {
		const raw = [user("firstusr", null, "initial request")];
		await fixture("conflict.jsonl", raw);
		const initial = await migrateSessionsToDurable({ sourceDir, targetDir });
		const mapping = initial.sessions[0]!;
		await writeFile(
			join(targetDir, manifestName),
			JSON.stringify({
				format: 1,
				sessions: [
					{
						...mapping,
						cwd: "/migration-review/conflicting-workspace",
						database: "session-conflicting.sqlite",
						conversationId: mapping.conversationId + 10_000,
					},
				],
			}),
		);
		await fixture("conflict.jsonl", [...raw, user("append01", "firstusr", "not published on conflict")]);
		const before = await publication();
		await expect(migrateSessionsToDurable({ sourceDir, targetDir })).rejects.toThrow(
			/manifest|mapping|conflict|identity/i,
		);
		expect(await publication()).toEqual(before);
	});
});
