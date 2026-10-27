// @vitest-environment node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it } from "vitest";
import {
	bootstrapDurableEnvironment,
	CURRENT_DURABLE_SCHEMA_VERSION,
	fromDurableSessionKey,
	isDurableSessionRef,
	makeSettingsPortable,
} from "../../server/durable-env-bootstrap.js";
import {
	createPreMigrationSnapshot,
	migrateJsonlToDurable,
	rollbackToJsonl,
	verifyMigration,
} from "../../server/durable-jsonl-migrator.js";
import { identityIdOfEntry, loadIdentities } from "../../server/identities.js";
import { parseBootstrapCliArgs } from "../../scripts/bootstrap-durable-env.mjs";

function sha256File(filePath: string): string {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

describe("Wave 3.3 (#603): clean-environment durable bootstrap + lossless JSONL migrator", () => {
	const tempDirs: string[] = [];

	function makeTempHome(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop()!;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("bootstraps a brand-new empty $HOME directly on pi-durable SQLite WAL with zero .jsonl session files", async () => {
		const tempHome = makeTempHome("pi-durable-bootstrap-");
		const identitiesDir = join(tempHome, ".pi", "agent", "memory", "identities");

		// Seed two role identity.json files: one with a legacy .jsonl homeChat, one brand-new
		mkdirSync(join(identitiesDir, "ops"), { recursive: true });
		writeFileSync(
			join(identitiesDir, "ops", "identity.json"),
			JSON.stringify(
				{
					id: "ops",
					title: "ops/tooling",
					description: "Tooling & infrastructure",
					homeChat: "/home/shinelay/.pi/agent/sessions/legacy-ops-home.jsonl",
				},
				null,
				2,
			),
			"utf8",
		);

		mkdirSync(join(identitiesDir, "temper"), { recursive: true });
		writeFileSync(
			join(identitiesDir, "temper", "identity.json"),
			JSON.stringify(
				{
					id: "temper",
					title: "temper",
					description: "Workflow engine",
				},
				null,
				2,
			),
			"utf8",
		);

		// Provide a template settings.json containing hardcoded /home/shinelay/... paths
		const templateSettingsPath = join(tempHome, "template-settings.json");
		writeFileSync(
			templateSettingsPath,
			JSON.stringify(
				{
					defaultProvider: "anthropic",
					defaultModel: "claude-opus-4-6",
					defaultThinkingLevel: "high",
					packages: [
						"/home/shinelay/.pi/agent/npm/node_modules/pi-mcp-adapter",
						"/home/shinelay/projects/pi-queue",
						"/home/shinelay/projects/pi-identity",
					],
					compaction: { enabled: false },
				},
				null,
				2,
			),
			"utf8",
		);

		const result = await bootstrapDurableEnvironment({
			homeDir: tempHome,
			templateSettingsPath,
			seedRoleIds: ["design"],
		});

		// 1. Verify zero .jsonl session files were created
		expect(result.jsonlFilesCreated).toBe(0);
		expect(existsSync(join(tempHome, ".pi", "agent", "sessions"))).toBe(false);

		// 2. Verify portable settings.json has $HOME paths and zero hardcoded /home/shinelay references
		const settingsRaw = readFileSync(result.settingsPath, "utf8");
		expect(settingsRaw).not.toContain("/home/shinelay");
		const settingsJson = JSON.parse(settingsRaw) as { packages: string[] };
		expect(settingsJson.packages).toEqual([
			"$HOME/.pi/agent/npm/node_modules/pi-mcp-adapter",
			"$HOME/projects/pi-queue",
			"$HOME/projects/pi-identity",
		]);

		// 3. Verify work/events.jsonl and board.json were initialized
		expect(existsSync(result.eventsPath)).toBe(true);
		expect(existsSync(result.boardPath)).toBe(true);
		expect(JSON.parse(readFileSync(result.boardPath, "utf8"))).toEqual({
			version: 1,
			posts: [],
		});

		// 4. Verify all 3 roles (design, ops, temper) were bootstrapped with durable: homeChats
		expect(result.bootstrappedRoles.map((r) => r.roleId)).toEqual(["design", "ops", "temper"]);
		for (const role of result.bootstrappedRoles) {
			expect(isDurableSessionRef(role.durableHomeChatKey)).toBe(true);
		}

		const opsRole = result.bootstrappedRoles.find((r) => r.roleId === "ops")!;
		expect(opsRole.previousHomeChat).toBe("/home/shinelay/.pi/agent/sessions/legacy-ops-home.jsonl");

		const { identities: loadedDefs, problems } = loadIdentities(identitiesDir);
		expect(problems).toEqual([]);
		expect(loadedDefs.map((d) => d.id)).toEqual(["design", "ops", "temper"]);
		const opsDef = loadedDefs.find((d) => d.id === "ops")!;
		expect(opsDef.homeChat).toBe(opsRole.durableHomeChatKey);
		expect(opsDef.pastHomeChats).toEqual(["/home/shinelay/.pi/agent/sessions/legacy-ops-home.jsonl"]);

		// 5. Verify durable-sessions.db SQLite WAL schema v2 and initial customType: "identity" entries
		const db = new DatabaseSync(result.dbPath);
		try {
			const journalMode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
			expect(journalMode.journal_mode.toLowerCase()).toBe("wal");

			const userVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
			expect(userVersion.user_version).toBe(CURRENT_DURABLE_SCHEMA_VERSION);

			const schemaVer = db
				.prepare("SELECT version FROM durable_schema WHERE singleton = 1")
				.get() as { version: number };
			expect(schemaVer.version).toBe(CURRENT_DURABLE_SCHEMA_VERSION);

			for (const role of result.bootstrappedRoles) {
				const sessionId = fromDurableSessionKey(role.durableHomeChatKey);
				const sessionRow = db
					.prepare("SELECT session_id, file_path, entry_count FROM durable_sessions WHERE session_id = ?")
					.get(sessionId) as { session_id: string; file_path: string; entry_count: number } | undefined;
				expect(sessionRow).toBeDefined();
				expect(sessionRow?.file_path).toBe(role.durableHomeChatKey);
				expect(sessionRow?.entry_count).toBe(1);

				const entryRow = db
					.prepare("SELECT entry_type, custom_type, payload_json FROM durable_entries WHERE session_id = ?")
					.get(sessionId) as { entry_type: string; custom_type: string; payload_json: string } | undefined;
				expect(entryRow?.entry_type).toBe("custom");
				expect(entryRow?.custom_type).toBe("identity");
				const parsedEntry = JSON.parse(entryRow!.payload_json) as {
					type: string;
					customType: string;
					data: unknown;
				};
				expect(identityIdOfEntry(parsedEntry)).toBe(role.roleId);
			}
		} finally {
			db.close();
		}

		// 6. Verify @earendil-works/pi-durable openNodeSqliteStorage opens durable-sessions.db natively
		const piDurableStorage = await openNodeSqliteStorage(result.dbPath);
		try {
			const convPage = await piDurableStorage.scanConversations({}, 10, undefined, BACKGROUND_CONTEXT);
			expect(convPage.items.length).toBe(3);
		} finally {
			await piDurableStorage.close(BACKGROUND_CONTEXT);
		}
	});

	it("supports CLI bootstrap via scripts/bootstrap-durable-env.mjs", () => {
		const parsedArgs = parseBootstrapCliArgs([
			"--home-dir",
			"/tmp/test-home",
			"--seed-roles",
			"ops,temper",
			"--cwd",
			"/tmp/test-home/projects",
		]);
		expect(parsedArgs.help).toBe(false);
		expect(parsedArgs.options).toEqual({
			homeDir: "/tmp/test-home",
			seedRoleIds: ["ops", "temper"],
			cwd: "/tmp/test-home/projects",
		});

		const cliHome = makeTempHome("pi-durable-cli-");
		const scriptPath = fileURLToPath(new URL("../../scripts/bootstrap-durable-env.mjs", import.meta.url));
		const stdout = execFileSync(
			process.execPath,
			[scriptPath, "--home-dir", cliHome, "--seed-roles", "ops,qa"],
			{ encoding: "utf8" },
		);
		const output = JSON.parse(stdout) as {
			dbPath: string;
			jsonlFilesCreated: number;
			bootstrappedRoles: Array<{ roleId: string; durableHomeChatKey: string }>;
		};
		expect(output.jsonlFilesCreated).toBe(0);
		expect(existsSync(output.dbPath)).toBe(true);
		expect(output.bootstrappedRoles.map((r) => r.roleId)).toEqual(["ops", "qa"]);
	});

	it("losslessly migrates multi-branch .jsonl sessions (with ACP blocks, custom entries, and large attachments) and verifies rollback", async () => {
		const tempHome = makeTempHome("pi-durable-migrate-");
		const agentDir = join(tempHome, ".pi", "agent");
		const dataDir = join(tempHome, ".pi-web-ui");
		const sessionsDir = join(agentDir, "sessions", "--home-shinelay-projects--");
		const identitiesDir = join(agentDir, "memory", "identities", "ops");
		mkdirSync(sessionsDir, { recursive: true });
		mkdirSync(identitiesDir, { recursive: true });

		const sessionId = "sess-multibranch-001";
		const jsonlPath = join(sessionsDir, `2026-10-27T08-00-00_${sessionId}.jsonl`);
		const largeBase64Attachment = Buffer.alloc(140 * 1024, "A").toString("base64");

		const jsonlLines = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: sessionId,
				timestamp: "2026-10-27T08:00:00.000Z",
				cwd: "/home/shinelay/projects/pi-web-ui",
				parentSession: null,
			}),
			JSON.stringify({
				type: "custom",
				customType: "identity",
				id: "e1-id",
				parentId: null,
				timestamp: "2026-10-27T08:00:01.000Z",
				data: { id: "ops", name: "ops", title: "ops/tooling", via: "home" },
			}),
			JSON.stringify({
				type: "model_change",
				id: "e2-model",
				parentId: "e1-id",
				timestamp: "2026-10-27T08:00:02.000Z",
				provider: "anthropic",
				modelId: "claude-opus-4-6",
			}),
			JSON.stringify({
				type: "thinking_level_change",
				id: "e3-thinking",
				parentId: "e2-model",
				timestamp: "2026-10-27T08:00:03.000Z",
				thinkingLevel: "high",
			}),
			JSON.stringify({
				type: "custom",
				customType: "queue",
				id: "e4-queue",
				parentId: "e3-thinking",
				timestamp: "2026-10-27T08:00:04.000Z",
				data: { action: "add", taskId: 603, title: "Durable W3.3" },
			}),
			JSON.stringify({
				type: "custom",
				customType: "tldr",
				id: "e5-tldr",
				parentId: "e4-queue",
				timestamp: "2026-10-27T08:00:05.000Z",
				data: { summary: "W3.3 bootstrap + migrator" },
			}),
			JSON.stringify({
				type: "custom",
				customType: "todo",
				id: "e6-todo",
				parentId: "e5-tldr",
				timestamp: "2026-10-27T08:00:06.000Z",
				data: { items: [{ id: 1, subject: "Build migrator", status: "in_progress" }] },
			}),
			// Side branch from e6-todo -> e7-side-leaf
			JSON.stringify({
				type: "message",
				id: "e7-side-leaf",
				parentId: "e6-todo",
				timestamp: "2026-10-27T08:00:07.000Z",
				message: {
					role: "user",
					content: [{ type: "text", text: "Alternate exploration branch message" }],
				},
			}),
			// Main branch from e6-todo -> e8-attachment -> e9-acp-compaction -> e10-main-leaf
			JSON.stringify({
				type: "message",
				id: "e8-attachment",
				parentId: "e6-todo",
				timestamp: "2026-10-27T08:00:08.000Z",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "Message with large attachment" },
						{
							type: "image",
							mimeType: "image/png",
							data: largeBase64Attachment,
						},
					],
				},
			}),
			JSON.stringify({
				type: "compaction",
				id: "e9-acp-compaction",
				parentId: "e8-attachment",
				timestamp: "2026-10-27T08:00:09.000Z",
				summary: "TASK AS OF THIS BLOCK: Compressed exploration range m00001-m00005.",
				firstKeptEntryId: "e8-attachment",
				tokensBefore: 48000,
				details: {
					acp: {
						blockId: "b1",
						startId: "m00001",
						endId: "m00005",
						topic: "Initial exploration",
					},
				},
			}),
			JSON.stringify({
				type: "message",
				id: "e10-main-leaf",
				parentId: "e9-acp-compaction",
				timestamp: "2026-10-27T08:00:10.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Migration verified on main branch." }],
				},
			}),
		];

		writeFileSync(jsonlPath, `${jsonlLines.join("\n")}\n`, "utf8");
		const originalJsonlSha = sha256File(jsonlPath);

		// Also create an adjacent .jsonl.acp.json sidecar
		const sidecarPath = `${jsonlPath}.acp.json`;
		writeFileSync(
			sidecarPath,
			JSON.stringify({
				version: 1,
				blocks: [{ blockId: "b1", startId: "m00001", endId: "m00005", summary: "Compressed block b1" }],
			}),
			"utf8",
		);

		// Bind ops identity.json homeChat to the .jsonl file prior to migration
		const opsIdentityPath = join(identitiesDir, "identity.json");
		writeFileSync(
			opsIdentityPath,
			`${JSON.stringify(
				{
					id: "ops",
					title: "ops/tooling",
					description: "Ops role",
					homeChat: jsonlPath,
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		const originalIdentitySha = sha256File(opsIdentityPath);

		// Run lossless migration
		const migration = await migrateJsonlToDurable({
			sessionsDir,
			dataDir,
			agentDir,
		});

		expect(migration.ok).toBe(true);
		expect(migration.rolledBack).toBe(false);
		expect(migration.migratedSessions).toHaveLength(1);

		const summary = migration.migratedSessions[0];
		expect(summary.sessionId).toBe(sessionId);
		expect(summary.entryCount).toBe(10);
		expect(summary.branchCount).toBe(2);
		expect(summary.leafEntryIds).toEqual(["e7-side-leaf", "e10-main-leaf"]);
		expect(summary.activeLeafEntryId).toBe("e10-main-leaf");
		expect(summary.acpBlockCount).toBe(2); // 1 inline compaction + 1 sidecar block
		expect(summary.attachmentCount).toBe(1);
		expect(summary.customEntryCounts).toMatchObject({
			identity: 1,
			model_change: 1,
			thinking_level_change: 1,
			queue: 1,
			tldr: 1,
			todo: 1,
			compaction: 1,
		});

		// Original .jsonl file on disk must be untouched
		expect(sha256File(jsonlPath)).toBe(originalJsonlSha);

		// Role identity.json must now point to durable:<sessionId> with original .jsonl in pastHomeChats
		const updatedIdentity = JSON.parse(readFileSync(opsIdentityPath, "utf8")) as {
			homeChat: string;
			pastHomeChats: string[];
		};
		expect(updatedIdentity.homeChat).toBe(`durable:${sessionId}`);
		expect(updatedIdentity.pastHomeChats).toContain(jsonlPath);

		// Verify large attachment payload round-trips byte-for-byte from durable-sessions.db
		const db = new DatabaseSync(migration.dbPath);
		try {
			const attachmentRow = db
				.prepare("SELECT payload_json FROM durable_entries WHERE session_id = ? AND entry_id = ?")
				.get(sessionId, "e8-attachment") as { payload_json: string } | undefined;
			expect(attachmentRow).toBeDefined();
			const parsedAttachmentEntry = JSON.parse(attachmentRow!.payload_json) as {
				message: { content: Array<{ type: string; data?: string }> };
			};
			expect(parsedAttachmentEntry.message.content[1].data).toBe(largeBase64Attachment);
		} finally {
			db.close();
		}

		// Test tamper detection via verifyMigration()
		const tamperDb = new DatabaseSync(migration.dbPath);
		try {
			tamperDb
				.prepare("UPDATE durable_entries SET content_hash = 'corrupted' WHERE session_id = ? AND entry_id = ?")
				.run(sessionId, "e4-queue");
		} finally {
			tamperDb.close();
		}

		const failedVerify = await verifyMigration({
			dbPath: migration.dbPath,
			manifest: migration.manifest,
		});
		expect(failedVerify.ok).toBe(false);
		expect(failedVerify.mismatches.some((m) => m.includes("e4-queue"))).toBe(true);

		// Simulate damaged source .jsonl and execute rollbackToJsonl()
		writeFileSync(jsonlPath, "corrupted partial write", "utf8");
		const rollback = await rollbackToJsonl({
			dbPath: migration.dbPath,
			manifest: migration.manifest,
			removeDb: true,
		});
		expect(rollback.ok).toBe(true);
		expect(rollback.restoredFiles).toBe(1);
		expect(rollback.restoredIdentities).toBe(1);
		expect(rollback.removedDb).toBe(true);
		expect(rollback.verifiedSha256).toBe(true);

		// Verify exact pre-cutover state restored byte-for-byte
		expect(sha256File(jsonlPath)).toBe(originalJsonlSha);
		expect(sha256File(opsIdentityPath)).toBe(originalIdentitySha);
		expect(existsSync(migration.dbPath)).toBe(false);
	});

	it("rewrites hardcoded home paths via makeSettingsPortable and takes standalone pre-migration snapshots", async () => {
		const portable = makeSettingsPortable({
			packages: ["/home/shinelay/.pi/agent/npm/node_modules/pi-safety", "/Users/alice/projects/pi-queue"],
			nested: { path: "/home/shinelay" },
		});
		expect(portable).toEqual({
			packages: ["$HOME/.pi/agent/npm/node_modules/pi-safety", "$HOME/projects/pi-queue"],
			nested: { path: "$HOME" },
		});

		const tempHome = makeTempHome("pi-durable-snap-");
		const sessionsDir = join(tempHome, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const file = join(sessionsDir, "s1.jsonl");
		writeFileSync(
			file,
			`${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-10-27T00:00:00Z", cwd: "/tmp" })}\n`,
			"utf8",
		);
		const snap = await createPreMigrationSnapshot({
			sessionsDir,
			dataDir: join(tempHome, ".pi-web-ui"),
		});
		expect(snap.files).toHaveLength(1);
		expect(snap.files[0].sessionId).toBe("s1");
		expect(snap.files[0].entryCount).toBe(0);
	});
});
