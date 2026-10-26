import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineTask } from "@earendil-works/pi-durable";
import type { EntryId, JsonObject } from "@earendil-works/pi-durable";
import {
	fauxProvider as sdkFauxProvider,
	fauxAssistantMessage as sdkFauxAssistantMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionUIContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DurableAgentDriver } from "../server/durable/durable-driver.js";
import {
	DurableAddonBridge,
	loadBillionContextExtension,
	configuredExtensionPaths,
} from "../server/durable/addon-bridges.js";
import { loadDurablePeerModule, setupDurableModels } from "../server/durable/models-adapter.js";
import type { DurableModelSetup, DurableModels, DurableProvider } from "../server/durable/models-adapter.js";
import { MigrationDoc } from "../server/durable/session-state.js";
import { DURABLE_IDLE_RETENTION_MS, durableDatabasePath, IdleSessionCache } from "../server/durable/sqlite-storage.js";

// This file deliberately lives outside tests/unit (W1-C's non-overlapping slice).
// Run with a disposable config whose test.include is ["tests/durable-driver.test.ts"].
const root = mkdtempSync(join(tmpdir(), "durable-w1c-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir);
writeFileSync(join(agentDir, "auth.json"), "{}");
writeFileSync(join(agentDir, "settings.json"), "{}");
const addons = resolve(process.cwd(), "..", "pi-worktree");
const identity = resolve(process.cwd(), "..", "pi-identity");
const tldr = resolve(process.cwd(), "..", "pi-tldr");
const queue = resolve(process.cwd(), "..", "pi-queue");
const multiPass = resolve(process.cwd(), "..", "pi-multi-pass", "extensions", "multi-sub.ts");
let setup: DurableModelSetup;
let ai: typeof import("@earendil-works/pi-ai") & { readonly PI_AI_VERSION: string };
let faux: ReturnType<typeof ai.fauxProvider>;
const drivers: DurableAgentDriver[] = [];
const manualBridges: DurableAddonBridge[] = [];
let counter = 0;
function driver(
	options: Partial<ConstructorParameters<typeof DurableAgentDriver>[1]> = {},
	cwd = join(root, `workspace-${++counter}`),
) {
	mkdirSync(cwd, { recursive: true });
	const value = new DurableAgentDriver(cwd, {
		dataDir: join(root, "data"),
		agentDir,
		modelSetup: setup,
		model: "fixture/fixed",
		extensionPaths: [],
		...options,
	});
	drivers.push(value);
	return value;
}
function script(...calls: { name: string; args: JsonObject }[]) {
	faux.setResponses([
		ai.fauxAssistantMessage(
			calls.map((call, index) => ai.fauxToolCall(call.name, call.args, { id: `fixture-${counter}-${index}` })),
			{ stopReason: "toolUse" },
		),
		ai.fauxAssistantMessage("Finished fixture"),
	]);
}
function fixtureUi(): ExtensionUIContext {
	const text = (_color: string, value: string) => value;
	return {
		notify() {},
		setStatus() {},
		setWidget() {},
		setTitle() {},
		setWorkingMessage() {},
		setFooter() {},
		setHeader() {},
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		editor: async () => undefined,
		custom: async () => undefined,
		getEditorText: () => "",
		setEditorText() {},
		pasteToEditor() {},
		setEditorComponent() {},
		setToolsExpanded() {},
		getToolsExpanded: () => false,
		theme: { fg: text, bg: text, bold: (s: string) => s, dim: (s: string) => s },
	} as unknown as ExtensionUIContext;
}
function toolText(entries: Awaited<ReturnType<DurableAgentDriver["readContextFrom"]>>, name: string): string {
	return entries
		.flatMap((entry) => entry.model ?? [])
		.filter((message) => message.role === "toolResult" && message.toolName === name)
		.flatMap((message) =>
			typeof message.content === "string"
				? []
				: message.content.filter((part) => part.type === "text").map((part) => (part as { text: string }).text),
		)
		.join("\n");
}
function addonFixture(name: string, content: string): string {
	const file = join(root, `${name}-${++counter}.ts`);
	writeFileSync(file, content);
	return file;
}

beforeAll(async () => {
	setup = await setupDurableModels(agentDir);
	ai = await loadDurablePeerModule<typeof ai>("@earendil-works/pi-ai");
	faux = ai.fauxProvider({ provider: "fixture", models: [{ id: "fixed" }], tokensPerSecond: 0 });
	(setup.models as DurableModels & { setProvider(provider: DurableProvider): void }).setProvider(
		faux.provider as unknown as DurableProvider,
	);
});
afterEach(async () => {
	for (const bridge of manualBridges.splice(0)) await bridge.close();
	for (const value of drivers.splice(0)) await value.dispose();
	vi.unstubAllEnvs();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("W1-C isolated durable driver", () => {
	it("uses durable's own pi-ai peer and a workspace-normalized SQLite WAL", async () => {
		expect(ai.PI_AI_VERSION).toBe("1.4.0");
		const value = driver();
		const id = await value.createSession({ name: "WAL fixture" });
		expect(Number(id) > 0).toBe(true);
		expect(value.databasePath === durableDatabasePath(join(root, "data"), value.cwd)).toBe(true);
		expect(durableDatabasePath(join(root, "data"), join(value.cwd, "..", basename(value.cwd)))).toBe(
			value.databasePath,
		);
		const db = new DatabaseSync(value.databasePath!);
		expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal").toBe(true);
		db.close();
		await value.appendEntry("queue", { v: 1, state: "ready" });
		const state = await value.getSessionState();
		expect(state.sessionManager.getSessionName() === "WAL fixture").toBe(true);
		expect(
			state.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "queue"),
		).toBe(true);
	});

	it("persists append-only custom entries and reads only the incremental tail under 5 ms", async () => {
		const value = driver();
		const id = await value.createSession();
		const state = await value.getSessionState();
		await state.conversation.commit(async (tx) => {
			for (let n = 0; n < 1000; n++)
				await tx.appendEntry(state.conversation.id, { kind: "fixture.history", data: { n } });
		}, BACKGROUND_CONTEXT);
		const first = await value.readContextFrom();
		const tail = first.at(-1)!.id;
		await value.appendEntry("tldr", { text: "Saved durable fixture" });
		const elapsed: number[] = [];
		for (let n = 0; n < 31; n++) {
			const start = performance.now();
			const next = await value.readContextFrom(tail);
			elapsed.push(performance.now() - start);
			expect(next.length).toBe(1);
		}
		elapsed.sort((a, b) => a - b);
		expect(elapsed[15]!).toBeLessThan(5);
		await value.dispose();
		const reopened = driver({}, value.cwd);
		await reopened.resumeSession(id);
		expect((await reopened.readContextFrom(tail)).length).toBe(1);
		expect((await reopened.readContextFrom(first[0]!.id as EntryId)).length > 900).toBe(true);
	});

	it("executes actual host/plugin/MCP-shaped tools, preserving details, errors and updates", async () => {
		let executed = 0;
		const tool: ToolDefinition = {
			name: "host_fixture",
			label: "Host fixture",
			description: "Fixed host tool",
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_id, args, _signal, update) => {
				executed++;
				update?.({ content: [{ type: "text", text: "working" }], details: {} });
				return {
					content: [{ type: "text", text: String((args as { value: string }).value) }],
					details: { source: "host" },
				};
			},
		};
		const value = driver({ pluginTools: [tool] });
		await value.createSession();
		expect((await value.getCallableTools()).some((entry) => entry.name === "host_fixture")).toBe(true);
		script({ name: "host_fixture", args: { value: "host-tool-executed" } });
		await value.sendPrompt("Run the fixed fixture");
		expect(executed).toBe(1);
		expect(toolText(await value.readContextFrom(), "host_fixture").includes("host-tool-executed")).toBe(true);
	});

	it("applies persisted inspector disables before a resumed session's first turn", async () => {
		let executed = 0;
		const tool: ToolDefinition = {
			name: "disabled_fixture",
			label: "Disabled fixture",
			description: "Must not execute",
			parameters: Type.Object({}),
			execute: async () => {
				executed++;
				return { content: [], details: {} };
			},
		};
		const value = driver({ pluginTools: [tool] });
		const id = await value.createSession();
		await value.setActiveTools(["read"]);
		await value.setThinkingLevel("high");
		await value.dispose();
		const reopened = driver({ pluginTools: [tool] }, value.cwd);
		await reopened.resumeSession(id);
		expect(await reopened.getThinkingLevel()).toBe("high");
		expect((await reopened.getCallableTools()).some((entry) => entry.name === "disabled_fixture")).toBe(false);
		script({ name: "disabled_fixture", args: {} });
		await reopened.sendPrompt("Attempt disabled fixture");
		expect(executed).toBe(0);
	});

	it.skipIf(!existsSync(join(addons, "index.ts")))(
		"reuses real pi-worktree refusals for file writes and protected bash; harmless bash allowed",
		async () => {
			const cwd = join(root, "guard-repository");
			mkdirSync(cwd);
			execFileSync("git", ["init", "--quiet", cwd]);
			writeFileSync(join(cwd, "tracked.txt"), "original");
			execFileSync("git", ["-C", cwd, "add", "tracked.txt"]);
			execFileSync("git", [
				"-C",
				cwd,
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@invalid",
				"commit",
				"--quiet",
				"-m",
				"fixture",
			]);
			const role = join(root, ".pi", "agent", "memory", "identities", "guard-fixture");
			mkdirSync(role, { recursive: true });
			writeFileSync(join(role, "about.md"), "owner-only fixture");
			writeFileSync(join(role, "identity.json"), JSON.stringify({ id: "guard-fixture", name: "Fixture" }));
			const extension = addonFixture(
				"guard",
				`import { createWorktreeGuard } from ${JSON.stringify(join(addons, "index.ts"))}; export default (pi) => createWorktreeGuard({ allowRoots: [], env: { HOME: ${JSON.stringify(root)} }, log: () => {} })(pi);`,
			);
			const value = driver({ extensionPaths: [extension], hostSessionId: "host-uuid-guard-fixture" }, cwd);
			await value.createSession();
			script(
				{ name: "write", args: { path: join(cwd, "tracked.txt"), content: "unsafe" } },
				{ name: "bash", args: { command: `printf unsafe > ${join(role, "about.md")}` } },
				{ name: "bash", args: { command: "printf durable-allowed" } },
			);
			await value.sendPrompt("Exercise fixed guard cases");
			expect(readFileSync(join(cwd, "tracked.txt"), "utf8") === "original").toBe(true);
			const records = await value.readContextFrom();
			expect(toolText(records, "write").includes("wt new")).toBe(true);
			expect(readFileSync(join(role, "about.md"), "utf8")).toBe("owner-only fixture");
			const output = toolText(records, "bash");
			expect(output.includes("durable-allowed")).toBe(true);
		},
	);

	it("fails closed on host approval and retains the host UUID in guard context", async () => {
		const seen: (string | undefined)[] = [];
		const value = driver({
			hostSessionId: "host-uuid-fixture",
			toolGuard: {
				pre: async (context) => {
					seen.push(context.conversationId);
					return { verdict: { decision: "ask", reason: "Fixture requires approval" }, pluginId: "fixture" };
				},
				post: async () => undefined,
			},
		});
		await value.createSession();
		script({ name: "bash", args: { command: `touch ${join(root, "must-not-exist")}` } });
		await value.sendPrompt("Exercise host approval fixture");
		expect(seen.every((id) => id === "host-uuid-fixture") && seen.length > 0).toBe(true);
		expect(existsSync(join(root, "must-not-exist"))).toBe(false);
	});

	it.skipIf(!existsSync(join(identity, "core.ts")))(
		"injects real pi-identity about/rules/notes and registers notebook without touching a live identity",
		async () => {
			const identities = join(root, "memory", "identities");
			const role = join(identities, "fixture");
			mkdirSync(join(role, "notes"), { recursive: true });
			writeFileSync(join(role, "about.md"), "# Fixture role\nFixture about marker\n");
			writeFileSync(join(role, "notebook.md"), "## Rules\nFixture rule marker\n");
			writeFileSync(
				join(role, "identity.json"),
				JSON.stringify({ id: "fixture", name: "Fixture", enabled: true, prompt: "Fixture prompt marker" }),
			);
			writeFileSync(
				join(role, "notes", "n1.md"),
				"id: n1\ndate: 2026-01-01\ntopic: Fixture note\nsummary: Fixture notes marker\n---\nOnly fixture data.\n",
			);
			const extension = addonFixture(
				"identity",
				`import { setup } from ${JSON.stringify(join(identity, "core.ts"))}; export default (pi) => setup(pi, { env: { HOME: ${JSON.stringify(root)}, PI_IDENTITY_DIR: ${JSON.stringify(identities)} }, notebookParameters: {type:'object',properties:{}}, reindex: () => {}, log: () => {} });`,
			);
			const value = driver();
			await value.createSession();
			const bridge = await DurableAddonBridge.create({
				cwd: value.cwd,
				agentDir,
				state: await value.getSessionState(),
				models: setup,
				identityId: "fixture",
				extensionPaths: [extension],
				instructions: "Base fixture",
			});
			manualBridges.push(bridge);
			await bridge.prepare("Inspect fixed identity");
			expect(bridge.injectedInstructions.includes("Fixture about marker")).toBe(true);
			expect(bridge.injectedInstructions.includes("Fixture rule marker")).toBe(true);
			expect(bridge.injectedInstructions.includes("Fixture notes marker")).toBe(true);
			expect(bridge.toolRegistrations().some((tool) => tool.name === "notebook")).toBe(true);
		},
	);

	it.skipIf(!existsSync(join(tldr, "index.ts")) || !existsSync(join(queue, "index.ts")))(
		"runs real TL;DR and queue tools and saves their custom state in SQLite",
		async () => {
			vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
			vi.stubEnv("PI_TLDR_NUDGES", "off");
			const value = driver({
				extensionPaths: [join(tldr, "index.ts"), join(queue, "index.ts")],
				extensionUI: fixtureUi(),
			});
			await value.createSession();
			const names = (await value.getCallableTools()).map((tool) => tool.name);
			expect(names.includes("tldr") && names.includes("queue_control") && names.includes("queue_done")).toBe(true);
			script(
				{ name: "tldr", args: { text: "The durable fixture saved its progress" } },
				{ name: "queue_control", args: { action: "lanes", n: 3 } },
			);
			await value.sendPrompt("Exercise isolated progress fixtures");
			const entries = (await value.getSessionState()).sessionManager.getEntries();
			expect(entries.some((entry) => entry.type === "custom" && entry.customType === "tldr")).toBe(true);
			expect(entries.some((entry) => entry.type === "custom" && entry.customType.includes("queue"))).toBe(true);
		},
	);

	it.skipIf(!existsSync(multiPass))(
		"loads real pi-multi-pass subscriptions and resolves alias credentials through durable's own model runtime",
		async () => {
			const directory = join(root, "multipass-agent");
			mkdirSync(directory);
			writeFileSync(
				join(directory, "auth.json"),
				JSON.stringify({ "anthropic-1": { type: "api_key", key: "fixture-not-a-real-credential" } }),
			);
			writeFileSync(join(directory, "settings.json"), "{}");
			writeFileSync(
				join(directory, "multi-pass.json"),
				JSON.stringify({ subscriptions: [{ provider: "anthropic", index: 1 }], pools: [], chains: [], presets: [] }),
			);
			vi.stubEnv("PI_CODING_AGENT_DIR", directory);
			vi.stubEnv("MULTI_SUB", "");
			const models = await setupDurableModels(directory);
			const value = driver({
				agentDir: directory,
				modelSetup: models,
				extensionPaths: [multiPass],
				extensionUI: fixtureUi(),
			});
			await value.createSession();
			expect(models.models.getProviders().some((provider) => provider.id === "anthropic-1")).toBe(true);
			expect(models.modelRegistry.getAll().some((model) => model.provider === "anthropic-1")).toBe(true);
			expect((await models.models.getAuth("anthropic-1"))?.auth.apiKey === "fixture-not-a-real-credential").toBe(true);
		},
	);

	it("routes provider hooks and settlement continuation through the real SDK runner", async () => {
		const extension = addonFixture(
			"provider-hooks",
			`export default (pi) => {
			pi.on('before_provider_request', () => { pi.appendEntry('fixture.payload', { seen: true }); });
			pi.on('before_provider_headers', (event) => { event.headers['x-fixture'] = 'yes'; });
			pi.on('after_provider_response', (event) => { pi.appendEntry('fixture.response', { status: event.status }); });
			pi.on('agent_before_settle', () => ({ continue: true }));
		};`,
		);
		const value = driver();
		await value.createSession();
		const bridge = await DurableAddonBridge.create({
			cwd: value.cwd,
			agentDir,
			state: await value.getSessionState(),
			models: setup,
			extensionPaths: [extension],
		});
		manualBridges.push(bridge);
		await bridge.providerPayload({ fixture: true });
		expect((await bridge.providerHeaders({}))["x-fixture"]).toBe("yes");
		await bridge.providerResponse({ status: 429, headers: {} }, setup.modelRegistry.getAll()[0]!);
		expect(await bridge.settled([], "error")).toBe(true);
		const entries = (await value.getSessionState()).sessionManager.getEntries();
		expect(entries.some((entry) => entry.type === "custom" && entry.customType === "fixture.payload")).toBe(true);
		expect(entries.some((entry) => entry.type === "custom" && entry.customType === "fixture.response")).toBe(true);
	});

	it("hydrates only edited active context and selected migrated customs, including after head changes and forks", async () => {
		const value = driver();
		const id = await value.createSession();
		const state = await value.getSessionState();
		const conversation = state.conversation;
		const row = await conversation.commit(async (tx) => {
			const selected = await tx.appendEntry(conversation.id, {
				kind: "legacy.custom",
				data: {
					type: "custom",
					id: "selected-identity",
					parentId: null,
					timestamp: "2026-01-01T00:00:00Z",
					customType: "identity",
					data: { id: "fixture" },
				},
			});
			const other = await tx.appendEntry(conversation.id, {
				kind: "legacy.custom",
				data: {
					type: "custom",
					id: "off-branch",
					parentId: null,
					timestamp: "2026-01-01T00:00:00Z",
					customType: "identity",
					data: { id: "wrong-role" },
				},
			});
			await tx.appendEntry(conversation.id, {
				kind: "legacy.message",
				model: [{ role: "user", content: "archived source must not replay", timestamp: 1 }],
			});
			const window = await tx.appendEntry(conversation.id, { kind: "acp.migration.window" });
			const active = await tx.appendEntry(conversation.id, {
				kind: "acp.migration.message",
				model: [{ role: "user", content: "active summarized fixture", timestamp: 2 }],
			});
			const head = await tx.appendEntry(conversation.id, { kind: "acp.migration.head", head: window.id });
			Object.assign(await tx.doc(MigrationDoc, conversation.id), {
				header: {
					type: "session",
					version: 3,
					id: "host-migration-uuid",
					cwd: value.cwd,
					timestamp: "2026-01-01T00:00:00Z",
				},
				title: "Migrated fixture",
				branch: ["selected-identity"],
				entryIds: { "selected-identity": selected.id, "off-branch": other.id },
				headId: head.id,
			});
			return { active: active.id, head: head.id };
		}, BACKGROUND_CONTEXT);
		await state.sync();
		const texts = () =>
			state.sessionManager
				.buildSessionContext()
				.messages.map((message) =>
					"content" in message && typeof message.content === "string" ? message.content : "nontext",
				);
		expect(texts()).toEqual(["active summarized fixture"]);
		expect(state.sessionManager.getSessionId()).toBe("host-migration-uuid");
		expect(state.sessionManager.getSessionName()).toBe("Migrated fixture");
		const customs = state.sessionManager.getEntries().filter((entry) => entry.type === "custom");
		expect(customs.length).toBe(1);
		expect(customs[0]?.id).toBe("selected-identity");
		state.setName("Native renamed fixture");
		await state.sync();
		expect(state.sessionManager.getSessionName()).toBe("Native renamed fixture");
		await conversation.commit(async (tx) => {
			await tx.appendEntry(conversation.id, {
				kind: "fixture.edit",
				edits: [
					{
						target: row.active,
						action: "replace",
						messages: [{ role: "user", content: "edited summary fixture", timestamp: 2 }],
					},
				],
			});
		}, BACKGROUND_CONTEXT);
		await state.sync();
		expect(texts()).toEqual(["edited summary fixture"]);
		await value.forkSession(id, row.head);
		const fork = await value.getSessionState();
		expect(
			fork.sessionManager
				.buildSessionContext()
				.messages.map((message) => ("content" in message ? message.content : undefined)),
		).toEqual(["active summarized fixture"]);
		await conversation.commit(async (tx) => {
			const next = await tx.appendEntry(conversation.id, {
				kind: "fixture.next",
				model: [{ role: "user", content: "new head fixture", timestamp: 3 }],
			});
			await tx.appendEntry(conversation.id, { kind: "fixture.head", head: next.id });
		}, BACKGROUND_CONTEXT);
		await state.sync();
		expect(texts()).toEqual(["new head fixture"]);
		expect((await value.readContextFrom(undefined, id)).filter((entry) => entry.kind === "app.pi.custom").length).toBe(
			0,
		);
	});

	it("retains native custom provider implementations and effective configured credentials", async () => {
		const directory = join(root, "native-provider-agent");
		mkdirSync(directory);
		writeFileSync(join(directory, "auth.json"), "{}");
		writeFileSync(
			join(directory, "models.json"),
			JSON.stringify({
				providers: {
					"native-fixture": {
						headers: { "x-model-fixture": "provider-configured" },
						modelOverrides: { "native-fixed": { headers: { "x-model-fixture": "model-configured" } } },
					},
				},
			}),
		);
		const models = await setupDurableModels(directory);
		const native = sdkFauxProvider({
			provider: "native-fixture",
			models: [{ id: "native-fixed" }],
			tokensPerSecond: 0,
		});
		native.setResponses([sdkFauxAssistantMessage("Native fixture reply")]);
		let modelHeadersApplied = false;
		let hookSawModelHeaders = false;
		models.setRequestHooks!("native-header-fixture", {
			onPayload: async (payload) => payload,
			onResponse: async () => {},
			transformHeaders: async (headers) => {
				hookSawModelHeaders = headers["x-model-fixture"] === "model-configured";
				return { ...headers, "x-model-fixture": "hook-configured" };
			},
		});
		const nativeStream = native.provider.streamSimple.bind(native.provider);
		native.provider.streamSimple = (model, context, options) => {
			modelHeadersApplied = options?.headers?.["x-model-fixture"] === "hook-configured";
			return nativeStream(model, context, options);
		};
		models.registerNativeProvider(native.provider);
		const selected = models.models.getModel("native-fixture", "native-fixed")!;
		const response = await models.models.completeSimple(
			selected,
			{ messages: [] },
			{ sessionId: "native-header-fixture" },
		);
		expect(response.stopReason).toBe("stop");
		expect(native.state.callCount).toBe(1);
		expect(modelHeadersApplied && hookSawModelHeaders).toBe(true);
		models.registerProvider("anthropic", { apiKey: "fixture-config-key", headers: { "x-fixture": "configured" } });
		const effective = await models.models.getAuth("anthropic");
		expect(effective?.auth.apiKey === "fixture-config-key").toBe(true);
		expect(effective?.auth.headers?.["x-fixture"]).toBe("configured");
	});

	it("hydrates the persisted model before startup and retains startup model/thinking choices", async () => {
		const first = setup.modelRegistry.getAll()[0]!;
		const selected = setup.modelRegistry.getAll().find((model) => model.id !== first.id)!;
		expect(!!first && !!selected).toBe(true);
		const extension = addonFixture(
			"startup-model",
			`export default function(pi) {
			pi.on("session_start", async (_event, ctx) => {
				pi.appendEntry("fixture.startup", { provider: ctx.model?.provider, id: ctx.model?.id });
				await pi.setModel(ctx.modelRegistry.find(${JSON.stringify(selected.provider)}, ${JSON.stringify(selected.id)}));
				pi.setThinkingLevel("low");
			});
		}`,
		);
		const value = driver({ model: `${first.provider}/${first.id}`, extensionPaths: [extension] });
		await value.createSession();
		const state = await value.getSessionState();
		const startup = state.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom" && entry.customType === "fixture.startup");
		expect(
			startup?.type === "custom" &&
				JSON.stringify(startup.data) === JSON.stringify({ provider: first.provider, id: first.id }),
		).toBe(true);
		expect((await state.conversation.agent(BACKGROUND_CONTEXT)).model).toEqual({
			provider: selected.provider,
			modelId: selected.id,
		});
		expect(await value.getThinkingLevel()).toBe("low");
	});

	it("protects sleeping/background work from idle eviction outside sendPrompt", async () => {
		let now = 0;
		const task = defineTask<null, { phase: "wait" }, null>({
			name: "fixture.background",
			version: 1,
			initial: () => ({ phase: "wait" }),
			phases: {
				wait: async (_task, runtime, ctx) => {
					await runtime.sleepUntil(now + 2 * DURABLE_IDLE_RETENTION_MS, { phase: "wait" }, ctx);
				},
			},
			abort: async (_task, runtime, ctx) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		const value = driver({
			now: () => now,
			extensions: [defineExtension({ name: "fixture.background", tasks: [task] })],
		});
		const id = await value.createSession();
		const state = await value.getSessionState();
		const taskId = await state.conversation.commit(
			(tx) => tx.createTask(task, null, { ownership: { kind: "conversation" }, background: true }),
			BACKGROUND_CONTEXT,
		);
		faux.setResponses([ai.fauxAssistantMessage("Started background fixture")]);
		await value.sendPrompt("Schedule background fixture");
		expect(
			await state.conversation.commit(async (tx) => (await tx.task(taskId))?.state.status, BACKGROUND_CONTEXT),
		).toBe("sleeping");
		now += DURABLE_IDLE_RETENTION_MS;
		expect(await value.evictIdle()).toEqual([]);
		expect(value.cachedSessionCount).toBe(1);
	});

	it("honors package manifests, resource filters and disabled autoload without importing scripts", () => {
		const directory = join(root, `resource-settings-${++counter}`);
		const pkg = join(directory, "package");
		mkdirSync(join(pkg, "extensions"), { recursive: true });
		writeFileSync(
			join(pkg, "package.json"),
			JSON.stringify({ name: "fixture-resources", pi: { extensions: ["extensions/*.ts", "!extensions/never.ts"] } }),
		);
		for (const name of ["alpha", "bravo", "never"])
			writeFileSync(join(pkg, "extensions", `${name}.ts`), "throw new Error('must not import during discovery')");
		const settings = (value: unknown) => writeFileSync(join(directory, "settings.json"), JSON.stringify(value));
		settings({ packages: [{ source: pkg, extensions: ["extensions/alpha.ts"] }] });
		expect(configuredExtensionPaths(directory)).toEqual([join(pkg, "extensions", "alpha.ts")]);
		settings({ packages: [{ source: pkg, autoload: false, extensions: ["+extensions/bravo.ts"] }] });
		expect(configuredExtensionPaths(directory)).toEqual([join(pkg, "extensions", "bravo.ts")]);
		settings({ packages: [{ source: pkg, extensions: ["+extensions/never.ts", "!**"] }] });
		expect(configuredExtensionPaths(directory)).toEqual([]);
		settings({ packages: [{ source: pkg, autoload: false }] });
		expect(configuredExtensionPaths(directory)).toEqual([]);
	});

	it("loads native ACP once and suppresses its classic package, including automatic symlinks", async () => {
		const directory = join(root, `native-acp-${++counter}`);
		const pkg = join(directory, "npm", "node_modules", "billion-context-pi");
		mkdirSync(pkg, { recursive: true });
		mkdirSync(join(directory, "extensions"));
		writeFileSync(join(directory, "auth.json"), "{}");
		writeFileSync(join(directory, "settings.json"), JSON.stringify({ packages: [pkg] }));
		writeFileSync(
			join(pkg, "package.json"),
			JSON.stringify({
				name: "billion-context-pi",
				type: "module",
				exports: { "./durable": "./durable.js" },
				pi: { extensions: ["index.ts"] },
			}),
		);
		writeFileSync(
			join(pkg, "index.ts"),
			`export default function(pi) { pi.on("session_start", () => { throw new Error("classic ACP must remain inactive"); }); }`,
		);
		writeFileSync(
			join(pkg, "durable.js"),
			`import { defineExtension } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-durable"))}; export function createDurableExtension() { return defineExtension({ name: "fixture.native.acp" }); }`,
		);
		symlinkSync(pkg, join(directory, "extensions", "classic-acp"), "dir");
		expect(configuredExtensionPaths(directory, { nativeBillionContext: true })).toEqual([]);
		const value = driver({ agentDir: directory, extensionPaths: undefined });
		await value.createSession();
		expect(
			(await (await value.getSessionState()).conversation.agent(BACKGROUND_CONTEXT)).extensions.some(
				(extension) => extension.name === "fixture.native.acp",
			),
		).toBe(true);
	});

	it("evicts only idle projections after ten minutes and reloads the persisted session", async () => {
		let now = 0;
		const value = driver({ now: () => now });
		const id = await value.createSession();
		await value.appendEntry("fixture", { preserved: true });
		now = DURABLE_IDLE_RETENTION_MS - 1;
		expect((await value.evictIdle()).length).toBe(0);
		now++;
		expect((await value.evictIdle()).includes(id)).toBe(true);
		expect(value.cachedSessionCount).toBe(0);
		await value.resumeSession(id);
		expect(
			(await value.getSessionState()).sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "fixture"),
		).toBe(true);
		const cache = new IdleSessionCache(() => now);
		cache.set("running", {});
		const release = cache.pin("running");
		now += DURABLE_IDLE_RETENTION_MS;
		expect(cache.evict().length).toBe(0);
		release();
		now += DURABLE_IDLE_RETENTION_MS;
		expect(cache.evict().length).toBe(1);
	});

	it("gracefully omits billion-context-pi before W2 links it; rejects invalid resume IDs", async () => {
		expect(await loadBillionContextExtension(agentDir)).toBeUndefined();
		const value = driver();
		await value.ensureInitialized();
		await expect(value.resumeSession("host-uuid-not-a-manifest-mapping")).rejects.toThrow();
		await expect(value.resumeSession("9999999")).rejects.toThrow();
	});
});
