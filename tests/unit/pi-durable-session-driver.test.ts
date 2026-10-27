import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExtensionHookBridge } from "../../server/durable-extension-port.js";
import {
	createPiDurableSessionDriver,
	DurableEngine,
	type DurableSessionPortEvent,
	PiDurableSessionDriver,
	PiModelCallExecutor,
	PiToolExecutor,
	SqliteDurableBackend,
} from "../../server/pi-durable-session-driver.js";

describe("Wave 3.1 @earendil-works/pi-durable SQLite WAL session driver", () => {
	let tempDir: string;
	let dbDir: string;
	let workspaceCwd: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-durable-w3-driver-"));
		dbDir = join(tempDir, "durable-db");
		workspaceCwd = join(tempDir, "workspace");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("initializes SqliteDurableBackend in WAL mode (journal_mode=wal, synchronous=NORMAL, schema v2) with zero .jsonl files", async () => {
		const driver = createPiDurableSessionDriver({
			dbDir,
			defaultCwd: workspaceCwd,
		});

		try {
			const created = await driver.create({
				sessionKey: "session-fresh-1",
				cwd: workspaceCwd,
				category: "InteractiveSession",
				title: "Fresh SQLite Session",
			});

			expect(created.created).toBe(true);
			expect(created.recoveredInterruptedTurn).toBe(false);
			expect(created.metadata.sessionKey).toBe("session-fresh-1");
			expect(created.metadata.category).toBe("InteractiveSession");

			const pragmas = await driver.getDatabasePragmas(workspaceCwd);
			expect(pragmas.journalMode).toBe("wal");
			expect(pragmas.synchronous).toBe(1); // SQLite NORMAL = 1
			expect(pragmas.schemaVersion).toBe(2);

			const engine = await driver.getEngineForCwd(workspaceCwd);
			expect(engine).toBeInstanceOf(DurableEngine);
			expect(engine.backend).toBeInstanceOf(SqliteDurableBackend);
			expect(engine.modelExecutor).toBeInstanceOf(PiModelCallExecutor);
			expect(engine.toolExecutor).toBeInstanceOf(PiToolExecutor);

			const files = readdirSync(dbDir);
			expect(files.some((f) => f.endsWith(".sqlite"))).toBe(true);
			expect(files.some((f) => f.endsWith(".jsonl"))).toBe(false);
		} finally {
			await driver.close();
		}
	});

	it("executes multi-turn prompts, tools, ExtensionHookBridge callbacks, and streams UI events", async () => {
		const hookTrace: string[] = [];
		const bridge = createExtensionHookBridge();

		bridge.on("before_agent_start", async (event) => {
			hookTrace.push(`before_agent_start:${event.prompt}`);
			return {
				prompt: `${event.prompt} [checked]`,
				customMessages: [
					{
						customType: "extension-banner",
						content: "[Extension Banner]",
						display: false,
					},
				],
			};
		});
		bridge.on("turn_start", async (event) => {
			hookTrace.push(`turn_start:${event.turnIndex}`);
		});
		bridge.on("context", async (event) => {
			hookTrace.push(`context:${event.messages.length}`);
			return { messages: [...event.messages] };
		});
		bridge.on("tool_call", async (event) => {
			hookTrace.push(`tool_call:${event.toolName}`);
			if (event.toolName === "blocked_rm") {
				return { block: true, reason: "rm blocked by policy" };
			}
			return undefined;
		});
		bridge.on("tool_result", async (event) => {
			hookTrace.push(`tool_result:${event.toolName}`);
			if (!event.isError) {
				return {
					details: { ...((event.details as Record<string, unknown>) ?? {}), auditedBy: "w3-audit-ext" },
				};
			}
			return undefined;
		});
		bridge.on("turn_end", async (event) => {
			hookTrace.push(`turn_end:${event.turnIndex}:${event.outcome}`);
		});

		const driver = new PiDurableSessionDriver({
			dbDir,
			defaultCwd: workspaceCwd,
			hookBridge: bridge,
		});

		try {
			await driver.create({
				sessionKey: "session-multiturn",
				cwd: workspaceCwd,
			});

			const streamedEvents: DurableSessionPortEvent[] = [];
			const unsubscribe = driver.subscribe((ev) => {
				streamedEvents.push(ev);
			}, "session-multiturn");

			const turn1 = await driver.prompt("status check", {
				assistantResponse: "Status check complete",
				toolCalls: [
					{
						toolCallId: "tc-bash-1",
						toolName: "bash",
						input: { command: "uptime" },
						execute: async (input) => ({
							content: [{ type: "text", text: `exec:${String(input.command)}` }],
							details: { exitCode: 0 },
						}),
					},
					{
						toolCallId: "tc-blocked-1",
						toolName: "blocked_rm",
						input: { path: "/tmp/x" },
					},
				],
			});

			expect(turn1.outcome).toBe("completed");
			expect(turn1.turnIndex).toBe(0);
			expect(turn1.prompt).toBe("status check [checked]");
			expect(turn1.assistantMessage?.content).toBe("Status check complete");
			expect(turn1.toolResults).toHaveLength(2);
			expect(turn1.toolResults[0]).toMatchObject({
				toolCallId: "tc-bash-1",
				toolName: "bash",
				isError: false,
				details: { exitCode: 0, auditedBy: "w3-audit-ext" },
			});
			expect(turn1.toolResults[1]).toMatchObject({
				toolCallId: "tc-blocked-1",
				toolName: "blocked_rm",
				isError: true,
			});

			const turn2 = await driver.prompt("second question", {
				assistantResponse: "Second answer ready",
			});
			expect(turn2.outcome).toBe("completed");
			expect(turn2.turnIndex).toBe(1);
			expect(turn2.assistantMessage?.content).toBe("Second answer ready");

			await driver.steer("steer follow-up");
			await driver.followUp("queued follow-up");

			unsubscribe();

			const eventTypes = streamedEvents.map((e) => e.type);
			expect(eventTypes).toContain("agent_start");
			expect(eventTypes).toContain("turn_start");
			expect(eventTypes).toContain("tool_execution_start");
			expect(eventTypes).toContain("tool_execution_end");
			expect(eventTypes).toContain("message_start");
			expect(eventTypes).toContain("message_update");
			expect(eventTypes).toContain("message_end");
			expect(eventTypes).toContain("turn_end");
			expect(eventTypes).toContain("agent_end");

			expect(hookTrace).toContain("before_agent_start:status check");
			expect(hookTrace).toContain("turn_start:0");
			expect(hookTrace).toContain("context:2");
			expect(hookTrace).toContain("tool_call:bash");
			expect(hookTrace).toContain("tool_result:bash");
			expect(hookTrace).toContain("tool_call:blocked_rm");
			expect(hookTrace).toContain("tool_result:blocked_rm");
			expect(hookTrace).toContain("turn_end:0:completed");
			expect(hookTrace).toContain("turn_end:1:completed");

			const meta = driver.getSessionMetadata("session-multiturn");
			expect(meta?.turnCount).toBe(4);
		} finally {
			await driver.close();
		}
	});

	it("recovers interrupted mid-turn leases and tool tasks from SQLite WAL after crash and resumes cleanly", async () => {
		let crashToolInvocations = 0;
		let notifyToolEntered!: () => void;
		const toolEntered = new Promise<void>((resolve) => {
			notifyToolEntered = resolve;
		});

		const driver1 = createPiDurableSessionDriver({
			dbDir,
			defaultCwd: workspaceCwd,
		});

		await driver1.create({
			sessionKey: "session-crash-resume",
			cwd: workspaceCwd,
			title: "Crash Recovery Session",
		});

		await driver1.registerTool(
			"deploy_step",
			async (input, ctx) => {
				crashToolInvocations += 1;
				notifyToolEntered();
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(resolve, 10_000);
					ctx.abortSignal.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							reject(ctx.abortSignal.reason ?? new Error("crashed mid tool"));
						},
						{ once: true },
					);
				});
				return {
					content: [{ type: "text", text: `deployed:${String(input.service)}` }],
					details: { ok: true },
				};
			},
			workspaceCwd,
		);

		const inFlightPrompt = driver1
			.prompt("deploy api", {
				assistantResponse: "Deployment completed after recovery",
				toolCalls: [
					{
						toolCallId: "tc-crash-1",
						toolName: "deploy_step",
						input: { service: "api" },
					},
				],
			})
			.catch(() => undefined);

		await toolEntered;
		expect(crashToolInvocations).toBe(1);

		// Simulate an abrupt process crash while the tool lease is active in SQLite.
		await driver1.close();
		await inFlightPrompt;

		// Open a brand-new driver instance on the same SQLite WAL directory.
		let recoveredToolInvocations = 0;
		const driver2 = createPiDurableSessionDriver({
			dbDir,
			defaultCwd: workspaceCwd,
		});

		try {
			await driver2.registerTool(
				"deploy_step",
				async (input) => {
					recoveredToolInvocations += 1;
					return {
						content: [
							{
								type: "text",
								text: `recovered-deploy:${String(input.service)}`,
							},
						],
						details: { recovered: true },
					};
				},
				workspaceCwd,
			);

			const reopened = await driver2.open("session-crash-resume", {
				cwd: workspaceCwd,
			});

			expect(reopened.created).toBe(false);
			expect(reopened.recoveredInterruptedTurn).toBe(true);
			expect(recoveredToolInvocations).toBe(1);

			const messages = driver2.getMessages("session-crash-resume");
			expect(messages.map((m) => m.role)).toEqual(["user", "toolResult", "assistant"]);
			expect(messages[2]?.content).toBe("Deployment completed after recovery");

			// Subsequent turns continue cleanly on the recovered session.
			const nextTurn = await driver2.prompt(
				"verify post-recovery health",
				{ assistantResponse: "All systems green" },
				"session-crash-resume",
			);
			expect(nextTurn.outcome).toBe("completed");
			expect(driver2.getMessages("session-crash-resume")).toHaveLength(5);
		} finally {
			await driver2.close();
		}
	});

	it("persists model/thinking switches, custom entries, compaction, and forks across SQLite restarts", async () => {
		const modelEvents: string[] = [];
		const bridge = createExtensionHookBridge();
		bridge.on("session_before_compact", async (ev) => {
			modelEvents.push(`compact:${ev.entryCount}:${ev.instructions ?? ""}`);
			return undefined;
		});

		const driver1 = createPiDurableSessionDriver({
			dbDir,
			defaultCwd: workspaceCwd,
			hookBridge: bridge,
		});

		let forkPointEntryId = "";
		try {
			await driver1.create({
				sessionKey: "session-stateful",
				cwd: workspaceCwd,
				model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
				thinkingLevel: "low",
			});

			await driver1.setModel({ provider: "anthropic", modelId: "claude-opus-4-7" }, "session-stateful");
			await driver1.setThinkingLevel("high", "session-stateful");

			const customMsgEntry = await driver1.appendCustomMessage(
				{
					customType: "ops-note",
					content: "Pinned note",
					display: true,
					details: { priority: 1 },
				},
				"session-stateful",
			);
			forkPointEntryId = customMsgEntry.id;

			await driver1.appendCustomEntry("audit_marker", { step: "pre-compact", ok: true }, "session-stateful");

			await driver1.prompt("turn before fork", { assistantResponse: "Ack before fork" }, "session-stateful");

			const forked = await driver1.fork("session-forked", forkPointEntryId, "session-stateful");
			expect(forked.created).toBe(true);
			expect(forked.metadata.parentSessionKey).toBe("session-stateful");
			expect(forked.metadata.forkFromEntryId).toBe(forkPointEntryId);

			const compactRes = await driver1.compact(
				{ summary: "Compacted history summary", focus: "state" },
				"session-stateful",
			);
			expect(compactRes.compacted).toBe(true);
			expect(compactRes.summary).toBe("Compacted history summary");
		} finally {
			await driver1.close();
		}

		expect(modelEvents).toEqual(["compact:6:state"]);
		const persistedExtEntries = bridge.getPersistedEntries("session-stateful");
		expect(persistedExtEntries).toHaveLength(2);
		expect(persistedExtEntries[0]?.customType).toBe("model_select");
		expect(persistedExtEntries[0]?.data).toEqual({
			provider: "anthropic",
			modelId: "claude-opus-4-7",
			previousProvider: "anthropic",
			previousModelId: "claude-sonnet-4-5",
		});
		expect(persistedExtEntries[1]?.customType).toBe("audit_marker");

		// Reopen from disk in a fresh driver and verify everything persisted in SQLite.
		const driver2 = createPiDurableSessionDriver({
			dbDir,
			defaultCwd: workspaceCwd,
		});

		try {
			const reopenedMain = await driver2.open("session-stateful", {
				cwd: workspaceCwd,
			});
			expect(reopenedMain.created).toBe(false);
			expect(reopenedMain.metadata.model).toMatchObject({
				provider: "anthropic",
				modelId: "claude-opus-4-7",
			});
			expect(reopenedMain.metadata.thinkingLevel).toBe("high");

			const entries = driver2.getEntries("session-stateful");
			expect(entries.map((e) => e.type)).toContain("model_change");
			expect(entries.map((e) => e.type)).toContain("thinking_level_change");
			expect(entries.map((e) => e.type)).toContain("custom_message");
			expect(entries.map((e) => e.type)).toContain("custom");
			expect(entries.map((e) => e.type)).toContain("compaction");

			const mainMessages = driver2.getMessages("session-stateful");
			expect(mainMessages[0]?.role).toBe("system");
			expect(mainMessages[0]?.content).toBe("Compacted history summary");

			const reopenedFork = await driver2.open("session-forked", {
				cwd: workspaceCwd,
			});
			expect(reopenedFork.created).toBe(false);
			const forkLeaf = driver2.getBranchLeaf("session-forked");
			expect(forkLeaf.parentSessionKey).toBe("session-stateful");
			expect(forkLeaf.forkFromEntryId).toBe(forkPointEntryId);
			expect(forkLeaf.leafEntryId).toBe(forkPointEntryId);
		} finally {
			await driver2.close();
		}
	});

	it("supports aborting in-flight turns as well as session lookup, listing, and deletion", async () => {
		const driver = createPiDurableSessionDriver({
			dbDir,
			defaultCwd: workspaceCwd,
		});

		try {
			await driver.create({
				sessionKey: "session-abort",
				cwd: workspaceCwd,
			});

			let notifyStarted!: () => void;
			const started = new Promise<void>((resolve) => {
				notifyStarted = resolve;
			});

			await driver.registerTool(
				"slow_op",
				async (_input, ctx) => {
					notifyStarted();
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(resolve, 10_000);
						ctx.abortSignal.addEventListener(
							"abort",
							() => {
								clearTimeout(timer);
								reject(ctx.abortSignal.reason ?? new Error("aborted"));
							},
							{ once: true },
						);
					});
					return { content: [{ type: "text", text: "done" }] };
				},
				workspaceCwd,
			);

			const promptPromise = driver.prompt(
				"run slow op",
				{
					toolCalls: [
						{
							toolCallId: "tc-slow-1",
							toolName: "slow_op",
							input: {},
						},
					],
				},
				"session-abort",
			);

			await started;
			expect(driver.isStreaming("session-abort")).toBe(true);

			await driver.abort("session-abort");
			const abortedTurn = await promptPromise;
			expect(abortedTurn.outcome).toBe("aborted");
			expect(driver.isStreaming("session-abort")).toBe(false);

			const lookup = await driver.lookupSession("session-abort");
			expect(lookup.found).toBe(true);
			expect(lookup.origin).toBe("durable-native");

			const listBefore = await driver.list({ cwd: workspaceCwd });
			expect(listBefore.some((s) => s.sessionKey === "session-abort")).toBe(true);

			const deleted = await driver.delete("session-abort");
			expect(deleted).toBe(true);

			const lookupAfter = await driver.lookupSession("session-abort");
			expect(lookupAfter.found).toBe(false);
		} finally {
			await driver.close();
		}
	});
});
