import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createDurableExtensionBridge,
	createSqliteWalEntryStore,
	NOTEBOOK_REMINDER_TEXT,
	type SqliteWalEntryStore,
} from "../../server/durable-extension-bridge.js";
import { createInMemoryDurableSessionPort, formatDurableSessionKey } from "../../server/durable-session-port.js";

function findJsonlFiles(rootDir: string): string[] {
	if (!existsSync(rootDir)) return [];
	const matches: string[] = [];
	const stack = [rootDir];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(fullPath);
			} else if (entry.name.endsWith(".jsonl")) {
				matches.push(fullPath);
			}
		}
	}
	return matches;
}

describe("Wave 3.2: durable-extension-bridge (SQLite hooks & custom entries, zero .jsonl files)", () => {
	const tempDirs: string[] = [];
	const openStores: SqliteWalEntryStore[] = [];

	const makeTempDir = (prefix: string): string => {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	};

	const openWalStore = (dbDir: string, sessionKey: string): SqliteWalEntryStore => {
		const store = createSqliteWalEntryStore(join(dbDir, "durable-ext.sqlite"), sessionKey);
		openStores.push(store);
		return store;
	};

	afterEach(() => {
		while (openStores.length > 0) {
			const store = openStores.pop()!;
			store.close();
		}
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop()!;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("wires before_agent_start for pi-identity (role prompt + notebook rules) and pi-queue (task handoff) with zero .jsonl files", async () => {
		const root = makeTempDir("w3-ext-before-start-");
		const dbDir = join(root, "durable-db");
		const identitiesDir = join(root, "identities");
		const opsRoleDir = join(identitiesDir, "ops");
		mkdirSync(join(opsRoleDir, "notes"), { recursive: true });

		writeFileSync(
			join(opsRoleDir, "identity.json"),
			JSON.stringify({
				description: "ops/tooling",
				rolePrompt: "# How you work: ops/tooling\nKeep tooling reliable.",
			}),
			"utf8",
		);
		writeFileSync(join(opsRoleDir, "about.md"), "# ops/tooling\nFolders: ~/projects/pi-web-ui\n", "utf8");
		writeFileSync(join(opsRoleDir, "notebook.md"), "## pi-web-ui\n! Gate: TZ=UTC scripts/check.sh\n", "utf8");
		writeFileSync(join(opsRoleDir, "notes", "n1.md"), "note 1\n", "utf8");

		const sessionKey = formatDurableSessionKey(root, "sess-before-start");
		const store = openWalStore(dbDir, sessionKey);

		const bridge = createDurableExtensionBridge({
			cwd: root,
			dbDir,
			defaultSessionKey: sessionKey,
			entryStore: store,
			identity: { identitiesDir },
			queue: { handoffOnBeforeAgentStart: true },
		});

		await bridge.setIdentity("ops");
		await bridge.enqueueTask({ text: "Implement durable extension bridge" });

		const firstStart = await bridge.before_agent_start({
			prompt: "Work through the queued task.",
			systemPrompt: "Base system prompt.",
			sessionKey,
		});

		expect(firstStart.systemPrompt).toContain("Base system prompt.");
		expect(firstStart.systemPrompt).toContain("## Identity: ops/tooling (ops)");
		expect(firstStart.systemPrompt).toContain("! Gate: TZ=UTC scripts/check.sh");
		expect(firstStart.systemPrompt).toContain("1 notes");
		expect(firstStart.prompt).toContain("[Queue] Task #1: Implement durable extension bridge");
		expect(firstStart.customMessages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					customType: "queue-task-handoff",
					content: "[Queue] Task #1: Implement durable extension bridge",
				}),
			]),
		);

		// Verify task transitioned to in_progress in SQLite
		const queueState = bridge.getQueueState(sessionKey);
		expect(queueState.items[0]?.status).toBe("in_progress");

		// Simulate external rules update outside the chat
		writeFileSync(
			join(opsRoleDir, "notebook.md"),
			"## pi-web-ui\n! Gate: TZ=UTC scripts/check.sh\n! Land only when quiet\n",
			"utf8",
		);
		bridge.markExternalRulesChanged("ops", sessionKey);

		const secondStart = await bridge.before_agent_start({
			prompt: "Continue task.",
			systemPrompt: "Base system prompt.",
			sessionKey,
		});
		expect(secondStart.customMessages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					customType: "identity-rules",
					display: false,
					content: expect.stringContaining("! Land only when quiet"),
				}),
			]),
		);
		expect(findJsonlFiles(root)).toEqual([]);
	});

	it("wires context / transformContext for @earendil-works/pi-context ACP block folding", async () => {
		const root = makeTempDir("w3-ext-acp-");
		const dbDir = join(root, "durable-db");
		const sessionKey = formatDurableSessionKey(root, "sess-acp");
		const store = openWalStore(dbDir, sessionKey);

		const bridge = createDurableExtensionBridge({
			cwd: root,
			dbDir,
			defaultSessionKey: sessionKey,
			entryStore: store,
			acp: { enabled: true, injectMessageRefs: true },
		});

		await bridge.appendAcpBlock({
			blockId: "b1",
			startId: "m00002",
			endId: "m00003",
			topic: "Initial exploration",
			summary: "Inspected durable ports and extension hooks.",
		});

		const rawMessages = [
			{ id: "m00001", role: "user" as const, content: "Start task #602" },
			{ id: "m00002", role: "assistant" as const, content: "Reading files..." },
			{ id: "m00003", role: "toolResult" as const, content: "File contents..." },
			{ id: "m00004", role: "assistant" as const, content: "Implementing bridge now." },
		];

		const transformed = await bridge.transformContext(rawMessages, sessionKey);
		expect(transformed).toHaveLength(3);
		expect(transformed[0]?.id).toBe("m00001");
		expect(transformed[1]).toMatchObject({
			id: "b1",
			role: "custom",
			customType: "acp-summary",
		});
		expect(String(transformed[1]?.content)).toContain(
			'<acp-block id="b1" range="m00002..m00003" topic="Initial exploration">Inspected durable ports and extension hooks.</acp-block>',
		);
		expect(transformed[2]?.id).toBe("m00004");
		expect(findJsonlFiles(root)).toEqual([]);
	});

	it("enforces pi-worktree main-checkout and role-folder guards in tool_call (block and allow)", async () => {
		const root = makeTempDir("w3-ext-worktree-");
		const dbDir = join(root, "durable-db");
		const mainRepo = join(root, "repo-main");
		const worktreeRepo = join(root, "repo-wt");
		const allowedRoleDir = join(root, "allowed-ops");
		const outsideRoleDir = join(root, "outside-frontend");

		// Main git checkout has a `.git` directory + `.wt/wt.yaml`
		mkdirSync(join(mainRepo, ".git"), { recursive: true });
		mkdirSync(join(mainRepo, ".wt"), { recursive: true });
		writeFileSync(join(mainRepo, ".wt", "wt.yaml"), "base: mine\n", "utf8");

		// Linked worktree has a `.git` file pointing to gitdir
		mkdirSync(join(worktreeRepo, ".wt"), { recursive: true });
		writeFileSync(join(worktreeRepo, ".git"), "gitdir: /tmp/fake-gitdir\n", "utf8");
		writeFileSync(join(worktreeRepo, ".wt", "wt.yaml"), "base: mine\n", "utf8");

		mkdirSync(allowedRoleDir, { recursive: true });
		mkdirSync(outsideRoleDir, { recursive: true });

		const sessionKey = formatDurableSessionKey(root, "sess-worktree");
		const store = openWalStore(dbDir, sessionKey);

		const bridge = createDurableExtensionBridge({
			cwd: root,
			dbDir,
			defaultSessionKey: sessionKey,
			entryStore: store,
			worktree: {
				enabled: true,
				roleAllowedFolders: {
					ops: [allowedRoleDir, worktreeRepo],
				},
			},
		});

		await bridge.setIdentity("ops");

		// 1. Main checkout write is blocked (Rule 12)
		const mainWrite = await bridge.tool_call({
			toolCallId: "tc-1",
			toolName: "write",
			input: { path: join(mainRepo, "server/index.ts"), content: "x" },
			sessionKey,
		});
		expect(mainWrite.block).toBe(true);
		expect(mainWrite.reason).toContain("wt new");

		// 2. Read-only bash in main checkout is allowed
		const readOnlyBash = await bridge.tool_call({
			toolCallId: "tc-2",
			toolName: "bash",
			input: { command: "git status --short" },
			sessionKey,
		});
		expect(readOnlyBash.block).toBe(false);

		// 3. Role-folder guard blocks write outside allowed folders when no queued task has started
		const outsideWriteBlocked = await bridge.tool_call({
			toolCallId: "tc-3",
			toolName: "edit",
			input: { path: join(outsideRoleDir, "App.tsx"), edits: [] },
			sessionKey,
		});
		expect(outsideWriteBlocked.block).toBe(true);
		expect(outsideWriteBlocked.reason).toContain('Role "ops" cannot modify');

		// 4. Write inside allowed worktree folder is permitted
		const worktreeWriteAllowed = await bridge.tool_call({
			toolCallId: "tc-4",
			toolName: "write",
			input: { path: join(worktreeRepo, "server/durable-extension-bridge.ts"), content: "ok" },
			sessionKey,
		});
		expect(worktreeWriteAllowed.block).toBe(false);

		// 5. Once a queue task is in_progress in durable SQLite entries, cross-folder work for that task is allowed
		const { task } = await bridge.enqueueTask({ text: "Cross-folder task" });
		const state = bridge.getQueueState(sessionKey);
		state.items.find((i) => i.id === task.id)!.status = "in_progress";
		await bridge.setQueueState(state, sessionKey);

		const outsideWriteWithActiveTask = await bridge.tool_call({
			toolCallId: "tc-5",
			toolName: "edit",
			input: { path: join(outsideRoleDir, "App.tsx"), edits: [] },
			sessionKey,
		});
		expect(outsideWriteWithActiveTask.block).toBe(false);
		expect(findJsonlFiles(root)).toEqual([]);
	});

	it("appends the pi-identity notebook reminder on queue_done tool_result unless notebook was already written", async () => {
		const root = makeTempDir("w3-ext-tool-result-");
		const dbDir = join(root, "durable-db");
		const sessionKey = formatDurableSessionKey(root, "sess-tool-result");
		const store = openWalStore(dbDir, sessionKey);

		const bridge = createDurableExtensionBridge({
			cwd: root,
			dbDir,
			defaultSessionKey: sessionKey,
			entryStore: store,
		});

		await bridge.setIdentity("ops");

		// Without calling `notebook` write action first, `queue_done` gets the reminder appended
		const firstDone = await bridge.tool_result({
			toolCallId: "tr-1",
			toolName: "queue_done",
			input: { summary: "Task completed" },
			content: [{ type: "text", text: "Marked task #602 done." }],
			isError: false,
			sessionKey,
		});
		expect(firstDone.content).toHaveLength(2);
		expect(firstDone.content?.[1]).toEqual({
			type: "text",
			text: NOTEBOOK_REMINDER_TEXT,
		});

		// Record a note via `notebook` tool_call, then verify `queue_done` does not duplicate reminder
		await bridge.tool_call({
			toolCallId: "tc-nb",
			toolName: "notebook",
			input: { action: "record", topic: "W3.2", summary: "Bridge verified", detail: "All checks pass" },
			sessionKey,
		});

		const secondDone = await bridge.tool_result({
			toolCallId: "tr-2",
			toolName: "queue_done",
			input: { summary: "Task completed after recording note" },
			content: [{ type: "text", text: "Marked task #602 done." }],
			isError: false,
			sessionKey,
		});
		expect(secondDone.content).toHaveLength(1);
		expect(findJsonlFiles(root)).toEqual([]);
	});

	it("wires turn_end for pi-multi-pass account failover and pi-queue next-task dispatch", async () => {
		const root = makeTempDir("w3-ext-turn-end-");
		const dbDir = join(root, "durable-db");
		const sessionKey = formatDurableSessionKey(root, "sess-turn-end");
		const store = openWalStore(dbDir, sessionKey);

		const dispatchedTasks: number[] = [];
		const bridge = createDurableExtensionBridge({
			cwd: root,
			dbDir,
			defaultSessionKey: sessionKey,
			entryStore: store,
			multiPass: {
				enabled: true,
				accounts: [
					{ id: "anthropic-1", provider: "anthropic" },
					{ id: "anthropic-2", provider: "anthropic" },
				],
			},
			queue: {
				enabled: true,
				dispatchNextOnTurnEnd: true,
				onTaskDispatched: (task) => {
					dispatchedTasks.push(task.id);
				},
			},
		});

		expect(bridge.getActiveMultiPassAccount("anthropic")?.id).toBe("anthropic-1");

		// 1. Simulate a 429 rate-limit error on turn_end -> rotates to anthropic-2 and requests continuation
		const failoverTurn = await bridge.turn_end({
			turnIndex: 0,
			outcome: "error",
			message: {
				role: "assistant",
				provider: "anthropic",
				content: "429 Too many tokens, please wait before trying again.",
				isError: true,
			},
			sessionKey,
		});

		expect(failoverTurn.continue).toBe(true);
		expect(bridge.getActiveMultiPassAccount("anthropic")?.id).toBe("anthropic-2");
		expect(failoverTurn.appendedEntries?.some((e) => e.customType === "multi-pass")).toBe(true);

		// 2. Enqueue Task #1 (done) and Task #2 (waiting, after: [1]) -> turn_end dispatches Task #2
		const { task: task1 } = await bridge.enqueueTask({ text: "First task" }, sessionKey);
		const { task: task2 } = await bridge.enqueueTask({ text: "Second task", after: [task1.id] }, sessionKey);
		await bridge.completeTask(task1.id, "First task finished", sessionKey);

		const dispatchTurn = await bridge.turn_end({
			turnIndex: 1,
			outcome: "completed",
			message: {
				role: "assistant",
				content: "Completed first task.",
			},
			sessionKey,
		});

		expect(dispatchTurn.continue).toBe(true);
		expect(dispatchedTasks).toEqual([task2.id]);
		expect(bridge.getQueueState(sessionKey).items.find((i) => i.id === task2.id)?.status).toBe("in_progress");
		expect(findJsonlFiles(root)).toEqual([]);
	});

	it("persists and cold-replays queue, identity, tldr, and todo custom entries in SQLite + adapts SessionManager and ExtensionRunner", async () => {
		const root = makeTempDir("w3-ext-replay-");
		const dbDir = join(root, "durable-db");
		const sessionKey = formatDurableSessionKey(root, "sess-replay");
		const sqlitePath = join(dbDir, "durable-replay.sqlite");
		const store1 = createSqliteWalEntryStore(sqlitePath, sessionKey);
		openStores.push(store1);

		const bridge1 = createDurableExtensionBridge({
			cwd: root,
			dbDir,
			defaultSessionKey: sessionKey,
			entryStore: store1,
		});

		await bridge1.setIdentity("ops", { rulesSummary: "ops rules v1" });
		const { task } = await bridge1.enqueueTask({ text: "Verify SQLite custom-entry replay" });
		await bridge1.appendTldrEntry({
			messageId: "msg-42",
			summary: "SQLite custom entries replay cleanly without jsonl",
			bullets: ["zero jsonl", "full branch replay"],
		});
		await bridge1.appendTodoEntry({
			id: 1,
			subject: "Commit W3.2 bridge",
			status: "in_progress",
		});
		store1.close();

		// Reopen the SQLite WAL file from disk in a brand-new bridge instance to test cold replay
		const store2 = createSqliteWalEntryStore(sqlitePath, sessionKey);
		openStores.push(store2);
		const bridge2 = createDurableExtensionBridge({
			cwd: root,
			dbDir,
			defaultSessionKey: sessionKey,
			entryStore: store2,
		});

		expect(bridge2.getActiveIdentity()).toMatchObject({
			name: "ops",
			rulesSummary: "ops rules v1",
		});
		expect(bridge2.getQueueState().items).toEqual([
			expect.objectContaining({
				id: task.id,
				text: "Verify SQLite custom-entry replay",
				status: "waiting",
			}),
		]);
		expect(bridge2.getTldrEntries().get("msg-42")?.summary).toBe("SQLite custom entries replay cleanly without jsonl");
		expect(bridge2.getTodoEntries()).toEqual([
			expect.objectContaining({
				id: 1,
				subject: "Commit W3.2 bridge",
				status: "in_progress",
			}),
		]);

		// Verify Pi SessionManager-compatible view (`getEntries`, `getBranch`, `appendCustomEntry`, `getSessionFile`, `getSessionId`)
		const sm = bridge2.sessionManager;
		expect(sm.getSessionId()).toBe("sess-replay");
		expect(sm.getSessionFile()).toBeUndefined();
		const entries = sm.getEntries();
		expect(entries.length).toBeGreaterThanOrEqual(4);
		const branch = sm.getBranch();
		expect(branch.map((e) => e.id)).toEqual(entries.map((e) => e.id));

		const appendedId = sm.appendCustomEntry("identity", { name: "architecture", setAt: 12345 });
		expect(typeof appendedId).toBe("string");
		expect(bridge2.getActiveIdentity()?.name).toBe("architecture");

		// Bind a real Pi ExtensionFactory onto the durable ExtensionRunner and run through DurableSessionPort
		const port = createInMemoryDurableSessionPort({
			defaultCwd: root,
			dbDir,
			extensionBridge: bridge2,
		});
		const created = await port.create({ cwd: root, sessionId: "sess-replay" });

		let factorySessionStartFired = false;
		const turnStartsSeen: number[] = [];
		await bridge2.bindExtensionFactories([
			(pi) => {
				pi.on("session_start", () => {
					factorySessionStartFired = true;
				});
				pi.on("turn_start", (event) => {
					turnStartsSeen.push(event.turnIndex);
				});
				pi.on("before_agent_start", async (event) => {
					pi.appendEntry("custom-ext-marker", { promptSeen: event.prompt });
					return {
						systemPrompt: `${event.systemPrompt}\n[ExtensionRunner Attached]`,
					};
				});
			},
		]);

		bridge2.onSessionBeforeCompact(async (event) => ({
			cancel: false,
			summary: `Compacted ${event.entryCount} durable entries`,
			customData: { acpBlocks: bridge2.getAcpBlocks(event.sessionKey).length },
		}));

		expect(factorySessionStartFired).toBe(true);
		const turnRes = await port.prompt("Hello durable runner", {
			sessionKey: created.sessionKey,
			systemPrompt: "Core prompt",
		});
		expect(turnRes.outcome).toBe("completed");
		expect(turnStartsSeen).toEqual([0]);
		expect(bridge2.getPersistedEntries(created.sessionKey).some((e) => e.customType === "custom-ext-marker")).toBe(
			true,
		);

		const compactRes = await bridge2.session_before_compact({
			sessionKey: created.sessionKey,
			entryCount: sm.getEntries().length,
		});
		expect(compactRes).toEqual({
			cancel: false,
			summary: `Compacted ${sm.getEntries().length} durable entries`,
			customData: { acpBlocks: 0 },
		});
		expect(findJsonlFiles(root)).toEqual([]);
	});
});
