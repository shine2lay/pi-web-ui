import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, AssistantEntry, defineExtension, defineTool, ToolTask } from "@earendil-works/pi-durable";
import type { Conversation, JsonObject } from "@earendil-works/pi-durable";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DurableAgentDriver } from "../server/durable/durable-driver.js";
import {
	DurableAddonBridge,
	configuredExtensionPaths,
	loadBillionContextExtension,
} from "../server/durable/addon-bridges.js";
import { loadDurablePeerModule, setupDurableModels } from "../server/durable/models-adapter.js";
import type { DurableModelSetup } from "../server/durable/models-adapter.js";
import { MigrationDoc } from "../server/durable/session-state.js";

// Authored WAL/package fixtures only. ToolTask is scheduled directly: no provider, sendPrompt, or model request.
const root = mkdtempSync(join(tmpdir(), "durable-driver-review-"));
const requireHere = createRequire(import.meta.url);
const drivers: DurableAgentDriver[] = [];
const bridges: DurableAddonBridge[] = [];
const tokens: string[] = [];
let n = 0;
let models: DurableModelSetup;
let ai: typeof import("@earendil-works/pi-ai");
const agentDir = join(root, "agent");
mkdirSync(agentDir);
writeFileSync(join(agentDir, "auth.json"), "{}");
writeFileSync(join(agentDir, "settings.json"), "{}");
function makeDriver(options: Partial<ConstructorParameters<typeof DurableAgentDriver>[1]> = {}, cwd?: string) {
	cwd ??= join(root, `cwd-${++n}`);
	mkdirSync(cwd, { recursive: true });
	const driver = new DurableAgentDriver(cwd, {
		dataDir: join(root, "data"),
		agentDir,
		modelSetup: models,
		extensionPaths: [],
		...options,
	});
	drivers.push(driver);
	return driver;
}
function fixture(options: { target?: unknown; source?: string; location?: "direct" | "npm" } = {}) {
	const directory = join(root, `package-${++n}`);
	const pkg = join(directory, ...(options.location === "direct" ? [] : ["npm"]), "node_modules", "billion-context-pi");
	const token = `durable-review-${n}`;
	tokens.push(token);
	mkdirSync(join(pkg, "dist"), { recursive: true });
	writeFileSync(join(directory, "auth.json"), "{}");
	writeFileSync(join(directory, "settings.json"), JSON.stringify({ packages: [pkg] }));
	writeFileSync(
		join(pkg, "package.json"),
		JSON.stringify({
			name: "billion-context-pi",
			type: "module",
			version: "0.1.83",
			exports: { "./durable": options.target ?? { types: "./dist/durable.d.ts", import: "./dist/durable.js" } },
			pi: { extensions: ["./dist/index.js"] },
		}),
	);
	writeFileSync(
		join(pkg, "dist", "index.js"),
		`export default (pi) => { pi.on('session_start', () => { throw new Error('classic ACP started'); }); };`,
	);
	writeFileSync(join(pkg, "dist", "durable.d.ts"), "throw new Error('types must never execute');");
	writeFileSync(
		join(pkg, "dist", "durable.js"),
		options.source ??
			`
		import { defineExtension, defineTool } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-durable"))};
		globalThis[${JSON.stringify(token)}] = { evaluations: 1, factories: 0, executions: 0 };
		export function createDurableExtension({ context }) {
			globalThis[${JSON.stringify(token)}].factories++;
			return defineExtension({ name: 'billion-context', tools: ['compress', 'decompress', 'acp_status'].map(name => defineTool({
				name, description: 'Harmless native ACP fixture', parameters: {type:'object',properties:{}},
				execute: async (_args, api, ctx) => {
					await context(api.conversationId, ctx);
					globalThis[${JSON.stringify(token)}].executions++;
					return { output: [{type:'text',text:'fixture completed'}] };
				}
			})) });
		}`,
	);
	return { directory, pkg, token, file: join(pkg, "dist", "durable.js") };
}
function counters(token: string): { evaluations: number; factories: number; executions: number } | undefined {
	return (globalThis as unknown as Record<string, ReturnType<typeof counters>>)[token];
}
async function invoke(conversation: Conversation, name: string, args: JsonObject = {}): Promise<boolean> {
	const callId = `direct-tool-${++n}`;
	const task = await conversation.commit(async (tx) => {
		const assistant = await tx.appendEntry(AssistantEntry, conversation.id, {
			model: [ai.fauxAssistantMessage([ai.fauxToolCall(name, args, { id: callId })])],
		});
		return tx.createTask(
			ToolTask,
			{ kind: "model", assistant: assistant.id, callId },
			{ ownership: { kind: "conversation" } },
		);
	}, BACKGROUND_CONTEXT);
	await conversation.waitForIdle(BACKGROUND_CONTEXT);
	const complete = await conversation.commit(async (tx) => (await tx.task(task))?.state, BACKGROUND_CONTEXT);
	expect(complete?.status === "terminal" && complete.outcome.status === "completed").toBe(true);
	const history = await conversation.entries({ order: "descending" }, 100, undefined, BACKGROUND_CONTEXT);
	const result = history.items
		.flatMap((entry) => entry.model ?? [])
		.find((message) => message.role === "toolResult" && message.toolCallId === callId);
	expect(result?.role === "toolResult").toBe(true);
	return result?.role === "toolResult" && !result.isError;
}
async function names(driver: DurableAgentDriver) {
	return (await driver.getCallableTools()).map((tool) => tool.name);
}

beforeAll(async () => {
	models = await setupDurableModels(agentDir);
	ai = await loadDurablePeerModule<typeof ai>("@earendil-works/pi-ai");
});
afterEach(async () => {
	for (const bridge of bridges.splice(0)) await bridge.close();
	for (const driver of drivers.splice(0)) await driver.dispose();
});
afterAll(() => {
	for (const token of tokens) delete (globalThis as unknown as Record<string, unknown>)[token];
	rmSync(root, { recursive: true, force: true });
});

describe("native durable ACP review", () => {
	it("loads the real import-only export shape lazily (old require resolution fails)", async () => {
		const f = fixture();
		expect(counters(f.token) === undefined).toBe(true);
		expect(() =>
			requireHere.resolve("billion-context-pi/durable", { paths: [f.directory, join(f.directory, "npm")] }),
		).toThrow(/No "exports" main|not defined by "exports"|not exported/);
		const extension = await loadBillionContextExtension(f.directory, async () => ({
			head: undefined,
			entries: [],
			contributions: [],
			messages: [],
		}));
		expect(extension?.name === "billion-context", "native-control: import-only export").toBe(true);
		expect(counters(f.token)?.evaluations === 1).toBe(true);
		expect(counters(f.token)?.factories === 1).toBe(true);
	});

	it.each(["direct", "npm"] as const)(
		"supports the explicit %s installation root and symlinked built packages",
		async (location) => {
			const f = fixture({ location });
			const linked = join(root, `linked-${++n}`);
			const target = join(linked, ...(location === "direct" ? [] : ["npm"]), "node_modules", "billion-context-pi");
			mkdirSync(join(target, ".."), { recursive: true });
			symlinkSync(f.pkg, target, "dir");
			expect((await loadBillionContextExtension(linked))?.name === "billion-context").toBe(true);
		},
	);

	it("permits genuine absence only, and retains the older unconditional export", async () => {
		expect((await loadBillionContextExtension(agentDir)) === undefined).toBe(true);
		const f = fixture({ target: "./dist/durable.js" });
		expect((await loadBillionContextExtension(f.directory))?.name === "billion-context").toBe(true);
	});

	it.each([
		{ label: "types-only", target: { types: "./dist/durable.d.ts" }, error: /Unsupported/ },
		{ label: "require-only", target: { require: "./dist/durable.js" }, error: /Unsupported/ },
		{
			label: "unknown conditional map",
			target: { import: "./dist/durable.js", default: "./dist/durable.js" },
			error: /Unsupported/,
		},
		{ label: "outside package", target: { import: "../escape.js" }, error: /Unsupported/ },
		{ label: "missing entry", target: { import: "./dist/absent.js" }, error: /Cannot find module|Failed to load/ },
		{
			label: "missing dependency",
			source: "import 'missing-native-acp-fixture-dependency';",
			error: /Cannot find|Failed to load/,
		},
		{
			label: "evaluation error",
			source: "throw new Error('native-evaluation-failed');",
			error: /native-evaluation-failed/,
		},
		{
			label: "factory error",
			source: "export function createDurableExtension(){throw new Error('native-factory-failed')}",
			error: /native-factory-failed/,
		},
		{ label: "no adapter", source: "export const notAnAdapter = true;", error: /exports no durable extension/ },
	])("fails loudly for installed $label rather than pretending absence", async (options) => {
		const f = fixture(options);
		await expect(loadBillionContextExtension(f.directory)).rejects.toThrow(options.error);
	});

	it("does not conceal malformed manifests, missing manifests or dangling installations", async () => {
		const badJson = fixture();
		writeFileSync(join(badJson.pkg, "package.json"), "{");
		await expect(loadBillionContextExtension(badJson.directory)).rejects.toThrow();
		const missingManifest = fixture();
		rmSync(join(missingManifest.pkg, "package.json"));
		await expect(loadBillionContextExtension(missingManifest.directory)).rejects.toThrow();
		const dangling = fixture();
		rmSync(dangling.pkg, { recursive: true });
		symlinkSync(join(root, "does-not-exist"), dangling.pkg, "dir");
		expect(lstatSync(dangling.pkg).isSymbolicLink()).toBe(true);
		await expect(loadBillionContextExtension(dangling.directory)).rejects.toThrow();
	});

	it("executes native registrations, and never starts classic ACP", async () => {
		// Legacy first isolates the old loadout failure from the separate import-condition failure.
		for (const target of ["./dist/durable.js", { types: "./dist/durable.d.ts", import: "./dist/durable.js" }]) {
			const f = fixture({ target });
			mkdirSync(join(f.directory, "extensions"));
			symlinkSync(f.pkg, join(f.directory, "extensions", "classic-acp"), "dir");
			expect(configuredExtensionPaths(f.directory, { nativeBillionContext: true }).length === 0).toBe(true);
			const driver = makeDriver({ agentDir: f.directory, extensionPaths: undefined });
			await driver.createSession();
			expect((await names(driver)).includes("compress"), "native-control: native callable loadout").toBe(true);
			const state = await driver.getSessionState();
			expect(await invoke(state.conversation, "compress")).toBe(true);
			expect(counters(f.token)?.executions === 1).toBe(true);
			const oldBridge = await DurableAddonBridge.create({
				cwd: driver.cwd,
				agentDir: f.directory,
				state,
				models,
				extensionPaths: [],
				nativeBillionContext: true,
			});
			bridges.push(oldBridge);
			// Old intersection never had native names; merely installing the extension was not enough.
			expect(oldBridge.callableTools.includes("compress")).toBe(false);
		}
	});

	it("persists explicit native disables through restart and permits an explicit later selection", async () => {
		const f = fixture();
		const driver = makeDriver({ agentDir: f.directory });
		const id = await driver.createSession();
		await driver.setActiveTools(["read", "acp_status"]);
		expect(await invoke((await driver.getSessionState()).conversation, "compress")).toBe(false);
		expect(counters(f.token)?.executions === 0).toBe(true);
		await driver.dispose();
		const reopened = makeDriver({ agentDir: f.directory }, driver.cwd);
		await reopened.resumeSession(id);
		expect((await names(reopened)).includes("compress")).toBe(false);
		expect(await invoke((await reopened.getSessionState()).conversation, "acp_status")).toBe(true);
		await reopened.setActiveTools(["compress"]);
		expect(await invoke((await reopened.getSessionState()).conversation, "compress")).toBe(true);
		expect((await names(reopened)).includes("acp_status")).toBe(false);
	});

	it("honors persisted remove filters and extension selection instead of re-enabling native ACP", async () => {
		const f = fixture();
		const driver = makeDriver({ agentDir: f.directory });
		const id = await driver.createSession();
		const state = await driver.getSessionState();
		await state.conversation.commit(async (tx) => {
			(await tx.doc(AgentDoc, state.conversation.id)).tools = { remove: ["compress"] };
		}, BACKGROUND_CONTEXT);
		await driver.dispose();
		const reopened = makeDriver({ agentDir: f.directory }, driver.cwd);
		await reopened.resumeSession(id);
		expect((await names(reopened)).includes("compress")).toBe(false);
		expect((await names(reopened)).includes("acp_status")).toBe(true);
		const selected = await reopened.getSessionState();
		await selected.conversation.commit(async (tx) => {
			(await tx.doc(AgentDoc, selected.conversation.id)).extensions = { remove: ["billion-context"] };
		}, BACKGROUND_CONTEXT);
		await reopened.dispose();
		const deselected = makeDriver({ agentDir: f.directory }, driver.cwd);
		await deselected.resumeSession(id);
		expect((await names(deselected)).includes("acp_status")).toBe(false);
	});

	it("preserves native callers/deferred semantics and plugin default/exposure filters", async () => {
		const native = (name: string, extra = {}) =>
			defineTool({
				name,
				description: name,
				parameters: Type.Object({}),
				...extra,
				execute: async () => ({ output: [] }),
			});
		const host = (name: string, extra = {}): ToolDefinition => ({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}),
			...extra,
			execute: async () => ({ content: [], details: {} }),
		});
		const driver = makeDriver({
			extensions: [
				defineExtension({
					name: "native-fixture",
					tools: [
						native("native_hidden", { callers: ["tools"] }),
						native("native_deferred", { deferred: true }),
						native("native_model", { callers: ["model"] }),
						native("shadowed"),
					],
				}),
			],
			pluginTools: [
				host("default_off", { defaultActive: false }),
				host("host_hidden", { exposure: "hidden" }),
				host("host_model", { exposure: "model-only" }),
				host("shadowed", { defaultActive: false }),
			],
		});
		await driver.createSession();
		const agent = await (await driver.getSessionState()).conversation.agent(BACKGROUND_CONTEXT);
		const modelNames = agent.tools.map((tool) => tool.name);
		const nestedNames = agent.callable.map((tool) => tool.name);
		expect(modelNames.includes("native_model") && modelNames.includes("host_model")).toBe(true);
		expect(
			!modelNames.includes("native_hidden") &&
				!modelNames.includes("host_hidden") &&
				!modelNames.includes("native_deferred"),
		).toBe(true);
		expect(
			nestedNames.includes("native_hidden") &&
				nestedNames.includes("host_hidden") &&
				nestedNames.includes("native_deferred"),
		).toBe(true);
		expect(
			!nestedNames.includes("native_model") &&
				!nestedNames.includes("host_model") &&
				!nestedNames.includes("default_off") &&
				!nestedNames.includes("shadowed"),
		).toBe(true);
		expect(agent.deferred.some((tool) => tool.name === "native_deferred")).toBe(true);
	});

	it("preserves reordered duplicate-name native policy registrations across reopen", async () => {
		let executions = 0;
		const registration = (name: string, callers: ("model" | "tools")[]) =>
			defineExtension({
				name,
				tools: [
					defineTool({
						name: "ordered_policy",
						description: name,
						parameters: Type.Object({}),
						callers,
						execute: async () => {
							executions++;
							return { output: [] };
						},
					}),
				],
			});
		const restricted = registration("restricted", ["tools"]);
		const unrestricted = registration("unrestricted", ["model", "tools"]);
		const extensions = [restricted, unrestricted];
		const driver = makeDriver({ extensions });
		const id = await driver.createSession();
		const state = await driver.getSessionState();
		const agent = await state.conversation.agent(BACKGROUND_CONTEXT);
		await state.conversation.configure(
			{
				extensions: [
					...agent.extensions.filter(
						(extension) => extension.name !== "restricted" && extension.name !== "unrestricted",
					),
					unrestricted,
					restricted,
				],
			},
			BACKGROUND_CONTEXT,
		);
		expect(
			(await state.conversation.agent(BACKGROUND_CONTEXT)).tools.some((tool) => tool.name === "ordered_policy"),
		).toBe(false);
		await driver.dispose();
		const reopened = makeDriver({ extensions }, driver.cwd);
		await reopened.resumeSession(id);
		const selected = await reopened.getSessionState();
		expect(
			(await selected.conversation.agent(BACKGROUND_CONTEXT)).tools.some((tool) => tool.name === "ordered_policy"),
		).toBe(false);
		expect(await invoke(selected.conversation, "ordered_policy")).toBe(false);
		expect(executions === 0).toBe(true);
	});

	it("mapped forks retain distinct host identities and immutable source provenance in guards", async () => {
		const parentId = "a9ba023a-c6df-464f-9b66-470e7a26a148";
		const childId = "4064c0b7-3e58-47fa-8234-8d5dc096d142";
		const ids = new Map<string, string>();
		const seen: string[] = [];
		let denied = false;
		const driver = makeDriver({
			hostSessionIdFor: (id) => {
				if (!ids.has(id)) ids.set(id, ids.size === 0 ? parentId : childId);
				return ids.get(id)!;
			},
			extensions: [
				defineExtension({
					name: "harmless-read",
					tools: [
						defineTool({
							name: "read",
							description: "No filesystem access",
							parameters: Type.Object({}),
							execute: async () => ({ output: [] }),
						}),
					],
				}),
			],
			toolGuard: {
				pre: async (ctx) => {
					seen.push(`pre:${ctx.conversationId}`);
					return { verdict: { decision: denied ? "ask" : "allow" } };
				},
				post: async (ctx) => {
					seen.push(`post:${ctx.conversationId}`);
					return undefined;
				},
			},
		});
		const parent = await driver.createSession();
		const state = await driver.getSessionState();
		const sourceHeader = {
			type: "session",
			version: 3,
			id: parentId,
			timestamp: "2026-01-01T00:00:00Z",
			cwd: driver.cwd,
		};
		const forkAt = await state.conversation.commit(async (tx) => {
			const active = await tx.appendEntry(state.conversation.id, {
				kind: "fixture.ancestry",
				model: [{ role: "user", content: "authored ancestor", timestamp: 1 }],
			});
			Object.assign(await tx.doc(MigrationDoc, state.conversation.id), {
				header: sourceHeader,
				headId: active.id,
				branch: ["legacy"],
				entryIds: { legacy: active.id },
			});
			return active.id;
		}, BACKGROUND_CONTEXT);
		await state.sync();
		expect(await invoke(state.conversation, "read")).toBe(true);
		const fork = await driver.forkSession(parent, forkAt);
		const child = await driver.getSessionState();
		expect(
			child.sessionManager.getSessionId() === childId && state.sessionManager.getSessionId() === parentId,
			"native-control: mapped fork UUID",
		).toBe(true);
		expect(await invoke(child.conversation, "read")).toBe(true);
		const provenance = await child.conversation.commit(
			async (tx) => JSON.parse(JSON.stringify(await tx.doc(MigrationDoc, child.conversation.id))),
			BACKGROUND_CONTEXT,
		);
		expect(JSON.stringify(provenance.header) === JSON.stringify(sourceHeader)).toBe(true);
		// This is exactly the old precedence predicate: it would substitute the inherited parent's UUID.
		expect(provenance.header.id !== child.sessionManager.getSessionId()).toBe(true);
		expect(provenance.entryIds.legacy === forkAt).toBe(true);
		expect(
			(await child.conversation.context(BACKGROUND_CONTEXT)).messages.some(
				(message) => message.role === "user" && message.content === "authored ancestor",
			),
		).toBe(true);
		expect(seen).toEqual([`pre:${parentId}`, `post:${parentId}`, `pre:${childId}`, `post:${childId}`]);
		denied = true;
		expect(await invoke(child.conversation, "read")).toBe(false);
		expect(seen.at(-1) === `pre:${childId}`).toBe(true);
		await driver.dispose();
		const reopened = makeDriver({ hostSessionIdFor: (id) => ids.get(id)! }, driver.cwd);
		await reopened.resumeSession(fork);
		expect((await reopened.getSessionState()).sessionManager.getSessionId() === childId).toBe(true);
	});

	it("does not turn archive reads into active context or accept foreign fork references", async () => {
		const driver = makeDriver();
		const first = await driver.createSession();
		const state = await driver.getSessionState();
		const entries = await state.conversation.commit(async (tx) => {
			const original = await tx.appendEntry(state.conversation.id, {
				kind: "fixture.original",
				model: [{ role: "user", content: "authored archive", timestamp: 1 }],
			});
			const edited = await tx.appendEntry(state.conversation.id, {
				kind: "fixture.edit",
				edits: [
					{
						target: original.id,
						action: "replace",
						messages: [{ role: "user", content: "authored replacement", timestamp: 1 }],
					},
				],
			});
			return { original: original.id, edited: edited.id };
		}, BACKGROUND_CONTEXT);
		await state.sync();
		expect(
			state.sessionManager
				.buildSessionContext()
				.messages.some((message) => message.role === "user" && message.content === "authored replacement"),
		).toBe(true);
		expect((await driver.readContextFrom()).some((entry) => entry.id === entries.original)).toBe(true);
		const foreign = await driver.createSession();
		await expect(driver.forkSession(foreign, entries.edited)).rejects.toThrow();
		await driver.resumeSession(first);
		expect((await driver.readContextFrom(entries.original)).some((entry) => entry.id === entries.edited)).toBe(true);
	});
});
