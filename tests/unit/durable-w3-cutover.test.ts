import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService, ClientSession, isDurableEngineEnabled } from "../../server/agent-service.js";
import { createDurableExtensionBridge } from "../../server/durable-extension-bridge.js";
import { verifyMigration } from "../../server/durable-jsonl-migrator.js";
import { createPiDurableSessionDriver } from "../../server/pi-durable-session-driver.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const bootstrapScriptPath = resolve(repoRoot, "scripts", "bootstrap-durable-env.mjs");
const migrateScriptPath = resolve(repoRoot, "scripts", "migrate-jsonl-to-durable.mjs");

function findJsonlFilesRecursive(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const found: string[] = [];
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop()!;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const fullPath = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(fullPath);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl") && !fullPath.endsWith("/work/events.jsonl")) {
				found.push(fullPath);
			}
		}
	}
	return found.sort();
}

function sha256File(filePath: string): string {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

describe("Wave 3.5 durable cutover integration (#601-#604)", () => {
	const tempDirs: string[] = [];
	const prevDurableEnv = process.env.PI_DURABLE_ENGINE;

	function makeTempHome(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	afterEach(() => {
		ClientSession.setDurableSessionPort(null);
		if (prevDurableEnv === undefined) {
			delete process.env.PI_DURABLE_ENGINE;
		} else {
			process.env.PI_DURABLE_ENGINE = prevDurableEnv;
		}
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop()!;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("boots a clean zero-JSONL environment via bootstrap-durable-env.mjs, runs role homeChats + extensions, and survives crash/restart", async () => {
		process.env.PI_DURABLE_ENGINE = "1";
		const tempHome = makeTempHome("pi-w3-cutover-clean-");
		const agentDir = join(tempHome, ".pi", "agent");
		const dataDir = join(tempHome, ".pi-web-ui");
		const workspaceCwd = join(tempHome, "projects");
		const mainRepoDir = join(workspaceCwd, "pi-web-ui");
		const worktreeRepoDir = join(workspaceCwd, "pi-web-ui-feature");
		mkdirSync(join(mainRepoDir, ".git"), { recursive: true });
		mkdirSync(join(mainRepoDir, ".wt"), { recursive: true });
		writeFileSync(join(mainRepoDir, ".wt", "wt.yaml"), "base: mine\n", "utf8");
		mkdirSync(join(worktreeRepoDir, ".wt"), { recursive: true });
		writeFileSync(join(worktreeRepoDir, ".git"), "gitdir: /tmp/fake-gitdir\n", "utf8");
		writeFileSync(join(worktreeRepoDir, ".wt", "wt.yaml"), "base: mine\n", "utf8");

		expect(findJsonlFilesRecursive(tempHome)).toEqual([]);

		// 1. Run bootstrap-durable-env.mjs CLI in the empty temp HOME
		const seededRoles = ["ops", "architecture", "qa"];
		const cliOutput = execFileSync(
			process.execPath,
			[
				bootstrapScriptPath,
				"--agent-dir",
				agentDir,
				"--data-dir",
				dataDir,
				"--cwd",
				workspaceCwd,
				"--seed-roles",
				seededRoles.join(","),
			],
			{
				cwd: repoRoot,
				env: { ...process.env, HOME: tempHome },
				encoding: "utf8",
			},
		);
		const bootSummary = JSON.parse(cliOutput) as {
			dbPath: string;
			bootstrappedRoles: Array<{
				roleId: string;
				durableSessionId: string;
				durableHomeChatKey: string;
			}>;
			jsonlFilesCreated: number;
		};
		expect(bootSummary.bootstrappedRoles).toHaveLength(seededRoles.length);
		expect(bootSummary.jsonlFilesCreated).toBe(0);
		expect(findJsonlFilesRecursive(tempHome)).toEqual([]);

		const opsBoot = bootSummary.bootstrappedRoles.find((r) => r.roleId === "ops")!;
		expect(opsBoot).toBeDefined();
		const opsDurableKey = opsBoot.durableHomeChatKey;
		const opsSessionId = opsDurableKey.replace(/^durable:/, "");

		const identitiesDir = join(agentDir, "memory", "identities");
		writeFileSync(
			join(identitiesDir, "ops", "notebook.md"),
			"## pi-web-ui\n! Restart only with pi-web-deploy.\n",
			"utf8",
		);

		// 2. Boot DurableExtensionBridge + PiDurableSessionDriver + AgentService on the bootstrapped SQLite DB
		const capturedSystemPrompts: string[] = [];
		const bridge1 = createDurableExtensionBridge({
			cwd: workspaceCwd,
			identity: {
				enabled: true,
				identitiesDir,
			},
			queue: {
				enabled: true,
			},
			worktree: {
				enabled: true,
			},
		});

		const driver1 = createPiDurableSessionDriver({
			dbDir: dataDir,
			defaultCwd: workspaceCwd,
			hookBridge: bridge1,
		});

		await driver1.registerTool("write", async (input) => {
			const p = String(input.path ?? "");
			return {
				content: [{ type: "text", text: `wrote:${p}` }],
				details: { path: p },
			};
		});

		const origBeforeStart = bridge1.before_agent_start.bind(bridge1);
		bridge1.before_agent_start = async (event) => {
			const res = await origBeforeStart(event);
			if (res.systemPrompt) {
				capturedSystemPrompts.push(res.systemPrompt);
			}
			return res;
		};

		const prevHome = process.env.HOME;
		process.env.HOME = tempHome;
		try {
			const service1 = new AgentService(workspaceCwd, join(dataDir, "client-state.json"), {
				durablePort: driver1,
			});

			const pragmas = await driver1.getDatabasePragmas(workspaceCwd);
			expect(pragmas.journalMode).toBe("wal");
			expect(pragmas.schemaVersion).toBe(2);

			// 3. Verify driver & AgentService list all seeded durable role homeChats and resolve ops homeChat with 0 JSONL files
			const allSessions = await driver1.listSessions();
			expect(allSessions.length).toBe(seededRoles.length);

			const opsHome = await service1.resolveRoleHomeChat("ops");
			expect(opsHome).toEqual({
				ok: true,
				file: `durable://${opsSessionId}`,
			});
		} finally {
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
		}

		// 4. Verify pi-identity hook hydrates from bootstrapped custom entry and injects ops notebook.md
		expect(bridge1.getActiveIdentity(opsDurableKey)).toMatchObject({
			name: "ops",
		});

		const openedOps = await driver1.open(opsDurableKey, { cwd: workspaceCwd });
		expect(openedOps.created).toBe(false);
		expect(openedOps.reopened).toBe(true);
		expect(openedOps.origin).toBe("durable-native");

		const turn1 = await driver1.prompt(
			"Check clean durable environment status",
			{
				systemPrompt: "Base system prompt",
				assistantResponse: "Bootstrapped ops homeChat ready.",
			},
			opsDurableKey,
		);
		expect(turn1.outcome).toBe("completed");
		expect(turn1.assistantMessage?.content).toBe("Bootstrapped ops homeChat ready.");
		expect(capturedSystemPrompts.length).toBe(1);
		expect(capturedSystemPrompts[0]).toContain("## Identity: ops");
		expect(capturedSystemPrompts[0]).toContain("Restart only with pi-web-deploy.");

		// 5. Verify pi-queue state persistence + pi-worktree main-checkout protection & worktree allow
		await bridge1.setQueueState(
			{
				version: 2,
				autoRun: true,
				nextId: 606,
				items: [
					{
						id: 605,
						text: "Verify clean durable boot",
						status: "in_progress",
						createdAt: Date.now(),
					},
				],
			},
			opsDurableKey,
		);

		const turn2 = await driver1.prompt(
			"Test worktree guard and write in worktree",
			{
				toolCalls: [
					{
						toolCallId: "tc-blocked-main",
						toolName: "write",
						input: {
							path: join(mainRepoDir, "server", "forbidden.ts"),
							content: "nope",
						},
					},
					{
						toolCallId: "tc-allowed-wt",
						toolName: "write",
						input: {
							path: join(worktreeRepoDir, "server", "allowed.ts"),
							content: "ok",
						},
					},
				],
				assistantResponse: "Worktree guard verified.",
			},
			opsDurableKey,
		);
		expect(turn2.outcome).toBe("completed");
		expect(turn2.toolResults).toHaveLength(2);
		expect(turn2.toolResults[0]?.isError).toBe(true);
		expect(JSON.stringify(turn2.toolResults[0]?.content)).toContain("worktree");
		expect(turn2.toolResults[1]?.isError).toBe(false);
		expect(JSON.stringify(turn2.toolResults[1]?.content)).toContain("wrote:");

		await driver1.close();

		// 6. Simulate crash/restart: create fresh bridge2 + driver2 on the same SQLite DB
		const bridge2 = createDurableExtensionBridge({
			cwd: workspaceCwd,
			identity: {
				enabled: true,
				identitiesDir,
			},
			queue: {
				enabled: true,
			},
			worktree: {
				enabled: true,
			},
		});
		const driver2 = createPiDurableSessionDriver({
			dbDir: dataDir,
			defaultCwd: workspaceCwd,
			hookBridge: bridge2,
		});

		const reopenedAfterCrash = await driver2.open(opsDurableKey, {
			cwd: workspaceCwd,
		});
		expect(reopenedAfterCrash.created).toBe(false);
		expect(reopenedAfterCrash.reopened).toBe(true);
		expect(bridge2.getActiveIdentity(opsDurableKey)).toMatchObject({
			name: "ops",
		});
		expect(bridge2.getQueueState(opsDurableKey).items).toEqual([
			expect.objectContaining({
				id: 605,
				text: "Verify clean durable boot",
				status: "in_progress",
			}),
		]);

		const persistedMessages = driver2.getMessages(opsDurableKey);
		expect(persistedMessages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"toolResult",
			"toolResult",
			"assistant",
		]);
		expect(findJsonlFilesRecursive(tempHome)).toEqual([]);

		await driver2.close();
	});

	it("migrates existing .jsonl sessions losslessly via migrate-jsonl-to-durable.mjs, preserves attachments & custom entries, keeps .jsonl untouched, and supports instant PI_DURABLE_ENGINE=0 rollback", async () => {
		process.env.PI_DURABLE_ENGINE = "1";
		const tempHome = makeTempHome("pi-w3-cutover-migrate-");
		const agentDir = join(tempHome, ".pi", "agent");
		const sessionsDir = join(agentDir, "sessions");
		const projectSessionsDir = join(sessionsDir, "--home-shinelay-projects--");
		const identitiesDir = join(agentDir, "memory", "identities");
		const dataDir = join(tempHome, ".pi-web-ui");
		const workspaceCwd = "/home/shinelay/projects";

		mkdirSync(projectSessionsDir, { recursive: true });
		mkdirSync(join(identitiesDir, "ops"), { recursive: true });
		mkdirSync(dataDir, { recursive: true });

		const opsJsonlPath = join(projectSessionsDir, "2026-10-27T08-00-00_ops-home-session.jsonl");
		const attachmentPayload = {
			id: "att-screenshot-1",
			type: "image",
			fileName: "cutover-check.png",
			mimeType: "image/png",
			size: 128,
			content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
		};

		const opsJsonlLines = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "ops-home-session",
				timestamp: "2026-10-27T08:00:00.000Z",
				cwd: workspaceCwd,
			}),
			JSON.stringify({
				type: "custom",
				id: "entry-id-1",
				parentId: null,
				timestamp: "2026-10-27T08:00:01.000Z",
				customType: "identity",
				data: { id: "ops", name: "ops", title: "ops/tooling", via: "auto" },
			}),
			JSON.stringify({
				type: "custom",
				id: "entry-queue-1",
				parentId: "entry-id-1",
				timestamp: "2026-10-27T08:00:02.000Z",
				customType: "queue",
				data: {
					items: [
						{
							id: 605,
							text: "Durable W3.5 cutover",
							status: "in_progress",
							lane: "ops",
							createdAt: 1761552002000,
						},
					],
					running: true,
					updatedAt: 1761552002000,
				},
			}),
			JSON.stringify({
				type: "custom",
				id: "entry-tldr-1",
				parentId: "entry-queue-1",
				timestamp: "2026-10-27T08:00:03.000Z",
				customType: "tldr",
				data: {
					messageId: "msg-user-1",
					summary: "Wave 3 cutover in progress",
					createdAt: 1761552003000,
				},
			}),
			JSON.stringify({
				type: "message",
				id: "entry-msg-user-1",
				parentId: "entry-tldr-1",
				timestamp: "2026-10-27T08:00:04.000Z",
				message: {
					id: "msg-user-1",
					role: "user",
					content: [{ type: "text", text: "Please inspect the attached screenshot." }],
					attachments: [attachmentPayload],
					timestamp: 1761552004000,
				},
			}),
			JSON.stringify({
				type: "message",
				id: "entry-msg-asst-1",
				parentId: "entry-msg-user-1",
				timestamp: "2026-10-27T08:00:05.000Z",
				message: {
					id: "msg-asst-1",
					role: "assistant",
					content: [{ type: "text", text: "Screenshot inspected and verified." }],
					timestamp: 1761552005000,
				},
			}),
		];
		writeFileSync(opsJsonlPath, `${opsJsonlLines.join("\n")}\n`, "utf8");

		const opsIdentityPath = join(identitiesDir, "ops", "identity.json");
		writeFileSync(
			opsIdentityPath,
			JSON.stringify(
				{
					id: "ops",
					title: "ops/tooling",
					folder: workspaceCwd,
					homeChat: opsJsonlPath,
					pastHomeChats: [],
				},
				null,
				2,
			),
			"utf8",
		);

		const originalJsonlHash = sha256File(opsJsonlPath);
		const originalIdentityHash = sha256File(opsIdentityPath);

		// 1. Run migrate-jsonl-to-durable.mjs CLI with --no-update-identities so original disk files stay untouched
		const cliOut = execFileSync(
			process.execPath,
			[
				migrateScriptPath,
				"--sessions-dir",
				sessionsDir,
				"--data-dir",
				dataDir,
				"--agent-dir",
				agentDir,
				"--no-update-identities",
			],
			{
				cwd: repoRoot,
				env: { ...process.env, HOME: tempHome },
				encoding: "utf8",
			},
		);
		const migrationSummary = JSON.parse(cliOut) as {
			ok: boolean;
			dbPath: string;
			manifestPath: string;
			sessionsMigrated: number;
			entriesMigrated: number;
			verification: {
				ok: boolean;
				sessionsVerified: number;
				entriesVerified: number;
				originalsUntouched: boolean;
				mismatches: string[];
			};
		};
		const expectedEntryCount = opsJsonlLines.length - 1; // 5 entries after session header line
		expect(migrationSummary.ok).toBe(true);
		expect(migrationSummary.sessionsMigrated).toBe(1);
		expect(migrationSummary.entriesMigrated).toBe(expectedEntryCount);
		expect(migrationSummary.verification).toMatchObject({
			ok: true,
			sessionsVerified: 1,
			entriesVerified: expectedEntryCount,
			originalsUntouched: true,
			mismatches: [],
		});

		// 2. Verify original .jsonl and identity.json files on disk are 100% untouched byte-for-byte
		expect(sha256File(opsJsonlPath)).toBe(originalJsonlHash);
		expect(sha256File(opsIdentityPath)).toBe(originalIdentityHash);

		// 3. Boot PiDurableSessionDriver + DurableExtensionBridge + AgentService on migrated DB
		const bridge = createDurableExtensionBridge({
			cwd: workspaceCwd,
			identity: {
				enabled: true,
				identitiesDir,
			},
			queue: {
				enabled: true,
			},
		});
		const driver = createPiDurableSessionDriver({
			dbDir: dataDir,
			defaultCwd: workspaceCwd,
			hookBridge: bridge,
			customModelResponder: async () => ({
				text: "Post-migration durable reply.",
			}),
		});

		const migratedSessions = await driver.listSessions();
		expect(migratedSessions).toHaveLength(1);
		expect(migratedSessions[0]).toMatchObject({
			sessionKey: "durable:ops-home-session",
			sessionId: "ops-home-session",
			origin: "migrated-jsonl",
			sourceSessionFile: opsJsonlPath,
		});

		// Verify 100% entry, message, attachment, and extension state parity
		const migratedEntries = driver.getEntries("durable:ops-home-session");
		expect(migratedEntries).toHaveLength(expectedEntryCount);

		const migratedMessages = driver.getMessages("durable:ops-home-session");
		expect(migratedMessages).toHaveLength(2);
		expect(migratedMessages[0]).toMatchObject({
			id: "msg-user-1",
			role: "user",
			attachments: [attachmentPayload],
		});
		expect(migratedMessages[1]).toMatchObject({
			id: "msg-asst-1",
			role: "assistant",
		});

		expect(bridge.getActiveIdentity("durable:ops-home-session")).toMatchObject({
			name: "ops",
		});
		expect(bridge.getQueueState("durable:ops-home-session").items).toEqual([
			expect.objectContaining({
				id: 605,
				text: "Durable W3.5 cutover",
				status: "in_progress",
			}),
		]);
		expect(bridge.getTldrEntries("durable:ops-home-session").get("msg-user-1")).toMatchObject({
			summary: "Wave 3 cutover in progress",
		});

		// Verify AgentService + ClientSession.switchSession can open by original .jsonl path via DurableSessionPort
		const prevHome = process.env.HOME;
		process.env.HOME = tempHome;
		try {
			const svc = new AgentService(workspaceCwd, join(dataDir, "client-state.json"), {
				durablePort: driver,
			});
			const cs = await svc.attach("client-mig-1", () => {});
			await cs.switchSession(opsJsonlPath);
			expect(cs.session?.sessionId).toBe("ops-home-session");
			expect(cs.session?.sessionFile).toBe(opsJsonlPath);

			// Run a new durable turn on the migrated session and verify original .jsonl is still untouched
			const followUpTurn = await driver.prompt("Run a turn after migration", {}, "durable:ops-home-session");
			expect(followUpTurn.outcome).toBe("completed");
			expect(followUpTurn.assistantMessage?.content).toBe("Post-migration durable reply.");
			expect(sha256File(opsJsonlPath)).toBe(originalJsonlHash);

			// Verify migration manifest verification still passes 100% even after new durable turns
			const postTurnVerify = await verifyMigration({
				dbPath: migrationSummary.dbPath,
				manifest: migrationSummary.manifestPath,
			});
			expect(postTurnVerify.ok).toBe(true);
			expect(postTurnVerify.mismatches).toEqual([]);

			// 4. Prove instant rollback via PI_DURABLE_ENGINE=0
			process.env.PI_DURABLE_ENGINE = "0";
			expect(isDurableEngineEnabled()).toBe(false);
			expect(svc.activeDurablePort()).toBeNull();
			expect(cs.activeDurablePort()).toBeNull();
			expect(sha256File(opsJsonlPath)).toBe(originalJsonlHash);
		} finally {
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
		}

		await driver.close();
	});
});
