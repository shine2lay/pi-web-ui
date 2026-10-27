import { describe, expect, it } from "vitest";
import { durableDatabaseName } from "../../server/durable-migrator.js";
import {
	createExtensionHookBridge,
	createInMemorySqliteEntryStore,
	type ExtensionHookBridge,
} from "../../server/durable-extension-port.js";
import {
	createInMemoryDurableSessionPort,
	formatDurableSessionKey,
	parseDurableSessionKey,
	resolveDurableStorageMode,
	type DurableSessionEvent,
	type DurableSessionPort,
} from "../../server/durable-session-port.js";

describe("DurableSessionPort & ExtensionHookBridge Wave 3 seam", () => {
	describe("fresh-environment boot (durable-only, no .jsonl files)", () => {
		it("boots cleanly in durable-only mode when no legacy .jsonl sessions exist", async () => {
			const port: DurableSessionPort = createInMemoryDurableSessionPort({
				defaultCwd: "/home/shinelay/rollcall",
				dbDir: "/tmp/pi-durable-clean",
			});

			const mode = port.getStorageMode();
			expect(mode).toEqual({
				mode: "durable-only",
				cleanBoot: true,
				dbDir: "/tmp/pi-durable-clean",
				legacySessionDir: null,
				legacyJsonlCount: 0,
				migratedSessions: 0,
			});

			const created = await port.create({
				cwd: "/home/shinelay/rollcall",
				sessionId: "clean-sess-1",
				name: "Clean Boot Chat",
				model: { provider: "anthropic", id: "claude-opus-4-6", thinkingLevel: "high" },
			});

			const expectedDbName = durableDatabaseName("/home/shinelay/rollcall");
			expect(created.origin).toBe("durable-native");
			expect(created.sourceSessionFile).toBeNull();
			expect(created.sessionKey).toBe(formatDurableSessionKey("/home/shinelay/rollcall", "clean-sess-1"));
			expect(port.getSessionKey()).toBe(created.sessionKey);
			expect(parseDurableSessionKey(created.sessionKey)).toEqual({
				dbName: expectedDbName,
				sessionId: "clean-sess-1",
			});

			const lookup = await port.lookupSession({ sessionId: "clean-sess-1", cwd: "/home/shinelay/rollcall" });
			expect(lookup).toEqual({
				found: true,
				origin: "durable-native",
				sessionKey: created.sessionKey,
				sessionId: "clean-sess-1",
				cwd: "/home/shinelay/rollcall",
				dbPath: `/tmp/pi-durable-clean/${expectedDbName}`,
				sourceSessionFile: null,
			});
		});

		it("supports full session lifecycle, turn execution, and custom-entry persistence on clean boot", async () => {
			const port = createInMemoryDurableSessionPort({
				defaultCwd: "/workspace/app",
				dbDir: "/workspace/.pi-durable",
			});

			const events: DurableSessionEvent[] = [];
			const unsub = port.subscribe((ev) => events.push(ev));

			const s1 = await port.create({
				sessionId: "s-lifecycle",
				name: "Primary",
				thinkingLevel: "low",
			});

			await port.switchModel({ provider: "openai", id: "gpt-5" });
			await port.setThinkingLevel("high");

			const customRec = await port.appendCustomEntry("pi-web-ui/model-pinned", { pinned: true });
			expect(customRec.kind).toBe("custom.pi-web-ui/model-pinned");
			expect(customRec.customType).toBe("pi-web-ui/model-pinned");
			expect(customRec.data).toEqual({ pinned: true });

			const turn = await port.prompt("run health check", {
				assistantResponse: "Health check passed",
				toolCalls: [
					{
						toolCallId: "tc-1",
						toolName: "bash",
						input: { command: "echo ok" },
						execute: async (input) => ({
							content: [{ type: "text", text: `ran:${String(input.command)}` }],
							details: { exitCode: 0 },
						}),
					},
				],
			});

			expect(turn.outcome).toBe("completed");
			expect(turn.assistantMessage?.content).toBe("Health check passed");
			expect(turn.toolResults).toHaveLength(1);
			expect(turn.toolResults[0]?.toolName).toBe("bash");

			expect(await port.steer("focus on latency", { source: "extension" })).toBe("delivered");
			expect(await port.followUp("summarize metrics", { source: "user" })).toBe("queued");

			const messages = port.getMessages();
			expect(messages.map((m) => m.role)).toEqual(["user", "toolResult", "assistant"]);

			const entries = port.getEntries();
			expect(entries.some((e) => e.type === "custom" && e.customType === "pi-web-ui/model-pinned")).toBe(true);
			expect(entries.some((e) => e.type === "model_change")).toBe(true);
			expect(entries.some((e) => e.type === "thinking_level_change")).toBe(true);

			// Fork from the user message entry before assistant response
			const userEntry = entries.find((e) => e.message?.role === "user");
			expect(userEntry).toBeDefined();
			const forked = await port.fork({
				sourceSessionKey: s1.sessionKey,
				fromEntryId: userEntry!.id,
				newSessionId: "s-forked",
				name: "Forked branch",
			});
			expect(forked.parentSessionKey).toBe(s1.sessionKey);
			expect(forked.forkFromEntryId).toBe(userEntry!.id);
			expect(port.getMessages(forked.sessionKey).map((m) => m.role)).toEqual(["user"]);

			await port.abort(forked.sessionKey);
			expect(events.some((e) => e.type === "session_aborted" && e.sessionKey === forked.sessionKey)).toBe(true);

			const listed = await port.list({ cwd: "/workspace/app" });
			expect(listed).toHaveLength(2);

			expect(await port.delete(forked.sessionKey)).toBe(true);
			expect(await port.list({ cwd: "/workspace/app" })).toHaveLength(1);

			unsub();
		});
	});

	describe("existing-session resume (migrated .jsonl lookup and continuation)", () => {
		it("resolves migrated .jsonl sessions by file path, sessionId, or sessionKey and resumes turns seamlessly", async () => {
			const legacyFile =
				"/home/shinelay/.pi/agent/sessions/--home-shinelay-rollcall--/2026-10-25T12-00-00-000Z_legacy-uuid-42.jsonl";

			const port = createInMemoryDurableSessionPort({
				defaultCwd: "/home/shinelay/rollcall",
				dbDir: "/home/shinelay/.pi-web-ui/durable",
				legacySessionDir: "/home/shinelay/.pi/agent/sessions",
				migratedSeeds: [
					{
						sessionId: "legacy-uuid-42",
						cwd: "/home/shinelay/rollcall",
						sourceSessionFile: legacyFile,
						name: "Migrated Ops Chat",
						model: { provider: "anthropic", id: "claude-opus-4-6" },
						thinkingLevel: "medium",
						entries: [
							{
								id: "seed-custom-1",
								parentId: null,
								type: "custom",
								kind: "custom.identity",
								customType: "identity",
								data: { v: 1, id: "ops" },
								timestamp: "2026-10-25T12:00:00.000Z",
							},
						],
						messages: [
							{
								id: "seed-msg-1",
								role: "user",
								content: "previous question before cutover",
								timestamp: 1761393600000,
							},
							{
								id: "seed-msg-2",
								role: "assistant",
								content: "previous answer before cutover",
								timestamp: 1761393605000,
							},
						],
					},
				],
			});

			const mode = port.getStorageMode();
			expect(mode).toEqual({
				mode: "migrated",
				cleanBoot: false,
				dbDir: "/home/shinelay/.pi-web-ui/durable",
				legacySessionDir: "/home/shinelay/.pi/agent/sessions",
				legacyJsonlCount: 1,
				migratedSessions: 1,
			});

			const byFile = await port.lookupSession({ sessionFile: legacyFile });
			expect(byFile.found).toBe(true);
			expect(byFile.origin).toBe("migrated-jsonl");
			expect(byFile.sourceSessionFile).toBe(legacyFile);
			expect(byFile.sessionId).toBe("legacy-uuid-42");

			const opened = await port.open({ sessionFile: legacyFile });
			expect(opened.sessionKey).toBe(byFile.sessionKey);
			expect(port.getMessages()).toHaveLength(2);

			// Resume turn execution on the migrated session
			const resumedTurn = await port.prompt("continue after W3 cutover", {
				assistantResponse: "resumed on durable SQLite",
			});
			expect(resumedTurn.outcome).toBe("completed");
			expect(port.getMessages()).toHaveLength(4);
			expect(port.getMessages().at(-1)?.content).toBe("resumed on durable SQLite");

			// Existing custom entry from .jsonl + new custom entry in SQLite
			await port.appendCustomEntry("queue", { taskId: 600, status: "running" });
			const customEntries = port.getEntries().filter((e) => e.type === "custom");
			expect(customEntries.map((e) => e.customType)).toEqual(["identity", "queue"]);
		});

		it("resolveDurableStorageMode distinguishes clean vs migrated states", () => {
			expect(
				resolveDurableStorageMode({
					dbDir: "/var/pi-durable",
					legacyJsonlFiles: [],
					migratedSessions: 0,
				}).cleanBoot,
			).toBe(true);

			expect(
				resolveDurableStorageMode({
					dbDir: "/var/pi-durable",
					legacySessionDir: "/var/pi-sessions",
					legacyJsonlFiles: ["/var/pi-sessions/a.jsonl"],
					migratedSessions: 1,
				}),
			).toEqual({
				mode: "migrated",
				cleanBoot: false,
				dbDir: "/var/pi-durable",
				legacySessionDir: "/var/pi-sessions",
				legacyJsonlCount: 1,
				migratedSessions: 1,
			});
		});
	});

	describe("ExtensionHookBridge contract", () => {
		it("chains before_agent_start, context/transformContext, turn_start, turn_end, tool_call, tool_result, session_before_compact, and SQLite appendEntry", async () => {
			const store = createInMemorySqliteEntryStore("proj:s1");
			const bridge: ExtensionHookBridge = createExtensionHookBridge({
				defaultSessionKey: "proj:s1",
				entryStore: store,
			});

			const trace: string[] = [];

			bridge.onBeforeAgentStart(async (event) => {
				trace.push(`before_agent_start:${event.prompt}`);
				return {
					prompt: `${event.prompt} [with-role-rules]`,
					systemPrompt: "Role: ops",
					selectedTools: ["read", "bash"],
					customMessages: [
						{
							customType: "board-note",
							content: "[Board] no new orders",
							display: false,
						},
					],
				};
			});

			bridge.onContext(async (event) => {
				trace.push(`context:${event.messages.length}`);
				return {
					messages: [
						...event.messages,
						{
							role: "system",
							content: "injected-context-guard",
						},
					],
				};
			});

			bridge.onTurnStart(async (event) => {
				trace.push(`turn_start:${event.turnIndex}`);
			});

			bridge.onToolCall(async (event) => {
				trace.push(`tool_call:${event.toolName}`);
				if (event.toolName === "forbidden_tool") {
					return { block: true, reason: "forbidden by guard" };
				}
				return {
					input: { ...event.input, safeFlag: true },
				};
			});

			bridge.onToolResult(async (event) => {
				trace.push(`tool_result:${event.toolName}`);
				return {
					content: [...event.content, { type: "text", text: "verified-by-hook" }],
					details: { ...(event.details as Record<string, unknown> | undefined), audited: true },
				};
			});

			bridge.onTurnEnd(async (event) => {
				trace.push(`turn_end:${event.turnIndex}:${event.outcome}`);
				await bridge.appendEntry("tldr-state", { turnIndex: event.turnIndex, summarized: true });
				return { continue: false };
			});

			bridge.onSessionBeforeCompact(async (event) => {
				trace.push(`before_compact:${event.entryCount}`);
				if (event.entryCount < 5) {
					return { cancel: true, reason: "too few entries to compact" };
				}
				return {
					cancel: false,
					summary: `Compacted ${event.entryCount} entries`,
					customData: { preservedFloor: 2 },
				};
			});

			const port = createInMemoryDurableSessionPort({
				defaultCwd: "/proj",
				dbDir: "/proj/.db",
				extensionBridge: bridge,
			});
			const session = await port.create({ sessionId: "s1" });

			const result = await port.prompt("deploy check", {
				toolCalls: [
					{
						toolCallId: "call-1",
						toolName: "bash",
						input: { command: "uptime" },
						execute: async (args) => ({
							content: [{ type: "text", text: `safe=${String(args.safeFlag)}` }],
							details: { raw: true },
						}),
					},
					{
						toolCallId: "call-2",
						toolName: "forbidden_tool",
						input: {},
					},
				],
			});

			expect(result.prompt).toBe("deploy check [with-role-rules]");
			expect(result.toolResults).toHaveLength(2);
			expect(result.toolResults[0]?.content).toEqual([
				{ type: "text", text: "safe=true" },
				{ type: "text", text: "verified-by-hook" },
			]);
			expect(result.toolResults[0]?.details).toEqual({ raw: true, audited: true });
			expect(result.toolResults[1]?.isError).toBe(true);

			// Check compaction hook behavior
			const compactBlocked = await bridge.session_before_compact({
				sessionKey: session.sessionKey,
				entryCount: 3,
			});
			expect(compactBlocked).toEqual({
				cancel: true,
				reason: "too few entries to compact",
			});

			const compactAllowed = await bridge.session_before_compact({
				sessionKey: session.sessionKey,
				entryCount: 12,
			});
			expect(compactAllowed).toEqual({
				cancel: false,
				summary: "Compacted 12 entries",
				customData: { preservedFloor: 2 },
			});

			// Verify appendEntry SQLite persistence
			const persisted = bridge.getPersistedEntries("proj:s1");
			expect(persisted).toHaveLength(1);
			expect(persisted[0]?.kind).toBe("custom.tldr-state");
			expect(persisted[0]?.data).toEqual({ turnIndex: 0, summarized: true });

			expect(trace).toEqual([
				"before_agent_start:deploy check",
				"turn_start:0",
				"context:2",
				"tool_call:bash",
				"tool_result:bash",
				"tool_call:forbidden_tool",
				"tool_result:forbidden_tool",
				"turn_end:0:completed",
				"before_compact:3",
				"before_compact:12",
			]);
		});
	});
});
