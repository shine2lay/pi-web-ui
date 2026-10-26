// @vitest-environment jsdom
/** W1-F: real SDK, synthetic tools/faux model, disposable files and a real drawer DOM.
 * No ports, external providers, installed extensions or real conversations.
 * Model-facing state is asserted as booleans only (AGENTS rule 11).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyToolInspectorUpdate,
	attachToolInspector,
	getToolInspectorSnapshot,
	handleToolInspectorRequest,
	registerToolInspectorRoutes,
	summarizeToolParameters,
	ToolInspectorStore,
	type ToolInspectorDependencies,
	type ToolInspectorSession,
	type ToolInspectorSnapshot,
	type ToolInspectorTool,
	type ToolInspectorUpdate,
} from "../../server/tool-inspector.js";
import "../../web/public/tool-inspector.js";

interface BrowserApi {
	open(options: { clientId: string; convId: string; baseUrl?: string; fetch?: typeof fetch }): Promise<void>;
	close(): void;
	refresh(): Promise<void> | null;
	helpers: {
		escapeHtml(value: unknown): string;
		filterTools(tools: ToolInspectorTool[], search?: string, source?: string): ToolInspectorTool[];
		formatSchema(schema: unknown): string;
		renderToolRow(tool: ToolInspectorTool, index: number, options?: object): string;
		renderToolList(snapshot: ToolInspectorSnapshot, options?: object): string;
		buildUpdate(name: string, values: object, scope?: string): ToolInspectorUpdate;
	};
}
const browser = (globalThis as unknown as { PiToolInspector: BrowserApi }).PiToolInspector;
let root: string;
const sessions: AgentSession[] = [];
let serial = 0;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "tool-inspector-"));
	localStorage.clear();
});
afterEach(() => {
	browser.close();
	for (const session of sessions.splice(0)) session.dispose();
	document.body.replaceChildren();
	localStorage.clear();
	rmSync(root, { recursive: true, force: true });
});

function definition(
	execute = async () => ({ content: [{ type: "text" as const, text: "fixture result" }], details: {} }),
) {
	return {
		name: "inspected",
		label: "Inspected fixture",
		description: "Default fixture description.",
		promptGuidelines: ["Default fixture guideline."],
		parameters: Type.Object({
			path: Type.String({ description: "Fixture path" }),
			options: Type.Optional(Type.Object({ verbose: Type.Boolean() })),
		}),
		execute,
	};
}
async function fixture(cwd = root, shared = definition()) {
	mkdirSync(cwd, { recursive: true });
	const faux = fauxProvider({ provider: `inspector-fixture-${++serial}`, models: [{ id: "m" }] });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, `auth-${serial}.json`),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: root,
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir: root,
		modelRuntime,
		model: faux.getModel("m"),
		tools: ["inspected", "deferred_fixture"],
		customTools: [shared, { ...definition(), name: "deferred_fixture", exposure: "deferred" }],
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager,
	});
	sessions.push(session);
	await session.bindExtensions({});
	// SDK options.tools is an allow-list too: register the deferred fixture, but do not declare it.
	session.setActiveToolsByName(["inspected"]);
	return { session, faux };
}
function sdk(session: AgentSession) {
	return session as unknown as {
		_applyToolLoadout(names: string[]): { name: string; description: string }[];
		_refreshToolRegistry(): void;
		_toolRegistry: Map<string, { name: string; description: string }>;
	};
}
function inspectorTool(session: ToolInspectorSession, name = "inspected") {
	return getToolInspectorSnapshot(session).tools.find((tool) => tool.name === name)!;
}

/** Plain catalog fixture, never sent to a provider. */
function catalog(): ToolInspectorSession {
	const tools = [
		{
			name: "read",
			description: "Read a fixture",
			parameters: { type: "object", properties: { path: { type: "string", description: "Path" } }, required: ["path"] },
			sourceInfo: { source: "builtin", path: "builtin:read" },
		},
		{ name: "mail", description: "Mail", sourceInfo: { source: "sdk" } },
		{ name: "remote", description: "Remote", sourceInfo: { source: "sdk" } },
		{ name: "mcp__test", sourceInfo: { source: "/fixture/pi-mcp-adapter" } },
		{ name: "addon", description: "Extension fixture", sourceInfo: { source: "/fixture/addon.ts" } },
	];
	return {
		sessionId: "catalog",
		sessionManager: { getCwd: () => root },
		getAllTools: () => tools,
		getActiveToolNames: () => ["read", "mail"],
		setActiveToolsByName() {},
	};
}

describe("Tool Inspector catalog and storage", () => {
	it("classifies core, extension, plugin and MCP tools with explicit external metadata", () => {
		const snapshot = getToolInspectorSnapshot(catalog(), [
			{ name: "mail", source: "plugin", origin: "fixture-plugin" },
			{ name: "remote", source: "mcp", origin: "fixture-server" },
		]);
		expect(snapshot.tools.map((tool) => [tool.name, tool.source])).toEqual([
			["addon", "extension"],
			["mail", "plugin"],
			["mcp__test", "mcp"],
			["read", "core"],
			["remote", "mcp"],
		]);
		expect(snapshot.tools.find((tool) => tool.name === "mail")?.origin).toBe("fixture-plugin");
		const read = snapshot.tools.find((tool) => tool.name === "read")!;
		expect(read.active && read.enabled).toBe(true);
		expect(read.parameterSummary).toEqual([{ name: "path", type: "string", required: true, description: "Path" }]);
		expect(snapshot.tools.find((tool) => tool.name === "addon")?.active).toBe(false);
	});
	it("summarizes nested and array parameters, unions and cycles without mutating schemas", () => {
		const schema = {
			type: "object",
			properties: {
				rows: {
					type: "array",
					items: { type: "object", properties: { id: { type: ["string", "null"] } }, required: ["id"] },
				},
				variant: { oneOf: [{ type: "string" }, { type: "number" }] },
			},
		};
		expect(summarizeToolParameters(schema).map((row) => [row.name, row.type, row.required])).toEqual([
			["rows", "array", false],
			["rows[].id", "string | null", true],
			["variant", "union", false],
		]);
		const cyclic: Record<string, unknown> = { type: "object" };
		cyclic.properties = { cycle: cyclic };
		expect(summarizeToolParameters(cyclic)).toHaveLength(1);
	});
	it("uses existing tool-info limits for unrenderable schema and detaches snapshot schemas", () => {
		const session = catalog();
		const tool = session.getAllTools()[0];
		const snapshot = getToolInspectorSnapshot(session);
		const parameters = snapshot.tools.find((item) => item.name === "read")?.parameters as { type: string };
		parameters.type = "changed";
		expect((tool.parameters as { type: string }).type).toBe("object");
		tool.parameters = { long: "x".repeat(64_001) };
		expect(getToolInspectorSnapshot(session).tools.find((item) => item.name === "read")?.parametersDropped).toBe(true);
	});
	it("round-trips scope overrides atomically with private permissions and clears empty entries", () => {
		const path = join(root, "settings", "tools.json");
		const store = new ToolInspectorStore(path);
		store.set("chat", "c1", "read", { enabled: false, customDescription: "Fixture text" });
		store.set("workspace", root, "read", { promptRule: "Fixture rule" });
		const reloaded = new ToolInspectorStore(path);
		expect(reloaded.get("chat", "c1", "read")).toEqual({ enabled: false, customDescription: "Fixture text" });
		expect(statSync(path).mode & 0o777).toBe(0o600);
		reloaded.set("chat", "c1", "read", {});
		expect(JSON.parse(readFileSync(path, "utf8")).chats.c1).toBeUndefined();
	});
	it("keeps prototype-shaped tool names as data and refuses corrupt/unknown versions without overwriting them", () => {
		const path = join(root, "tools.json");
		const store = new ToolInspectorStore(path);
		store.set("chat", "__proto__", "constructor", { enabled: false });
		expect(new ToolInspectorStore(path).get("chat", "__proto__", "constructor").enabled).toBe(false);
		writeFileSync(path, '{"version":2,"chats":{},"workspaces":{}}');
		expect(() => new ToolInspectorStore(path)).toThrow("Unrecognized Tool Inspector store");
		expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(2);
		writeFileSync(path, "not-json");
		expect(() => new ToolInspectorStore(path)).toThrow();
		expect(readFileSync(path, "utf8")).toBe("not-json");
	});
});

describe("real SDK per-session policy", () => {
	it("excludes disabled tools on every loadout, including direct activation and registry refresh", async () => {
		const { session } = await fixture();
		attachToolInspector(session, new ToolInspectorStore());
		applyToolInspectorUpdate(session, { toolName: "inspected", enabled: false });
		expect(session.getActiveToolNames().includes("inspected")).toBe(false);
		session.setActiveToolsByName(["inspected"]);
		expect(session.getActiveToolNames().includes("inspected")).toBe(false);
		sdk(session)._refreshToolRegistry();
		expect(
			sdk(session)
				._applyToolLoadout(["inspected"])
				.some((tool) => tool.name === "inspected"),
		).toBe(false);
		applyToolInspectorUpdate(session, { toolName: "inspected", enabled: true });
		expect(session.getActiveToolNames().includes("inspected")).toBe(true);
	});
	it("does not mutate another conversation, shared definitions or callable deferred tools", async () => {
		const shared = definition();
		const a = await fixture(root, shared),
			b = await fixture(root, shared);
		const store = new ToolInspectorStore();
		attachToolInspector(a.session, store);
		attachToolInspector(b.session, store);
		applyToolInspectorUpdate(a.session, {
			toolName: "inspected",
			enabled: false,
			customDescription: "Chat A fixture text",
			promptRule: "Fixture rule A only.",
		});
		expect(b.session.getActiveToolNames().includes("inspected")).toBe(true);
		expect(sdk(b.session)._toolRegistry.get("inspected")?.description === shared.description).toBe(true);
		expect(shared.description === "Default fixture description.").toBe(true);
		expect(a.session.getActiveToolNames().includes("deferred_fixture")).toBe(false);
		expect(a.session.getCallableToolNames().includes("deferred_fixture")).toBe(true);
		applyToolInspectorUpdate(a.session, { toolName: "deferred_fixture", enabled: false });
		expect(a.session.getCallableToolNames().includes("deferred_fixture")).toBe(false);
		expect(b.session.getCallableToolNames().includes("deferred_fixture")).toBe(true);
	});
	it("keeps overrides after refresh and refuses replacing an attached store", async () => {
		const { session } = await fixture();
		attachToolInspector(session, new ToolInspectorStore());
		applyToolInspectorUpdate(session, {
			toolName: "inspected",
			customDescription: "Overridden fixture",
			promptRule: "Inspector fixture rule.",
		});
		expect(sdk(session)._toolRegistry.get("inspected")?.description === "Overridden fixture").toBe(true);
		expect(session.systemPrompt.includes("Inspector fixture rule.")).toBe(true);
		sdk(session)._refreshToolRegistry();
		expect(sdk(session)._toolRegistry.get("inspected")?.description === "Overridden fixture").toBe(true);
		expect(() => attachToolInspector(session, new ToolInspectorStore())).toThrow("another Tool Inspector store");
	});
	it("reuses attachment without wrapper stacking and preserves override defaults on reset", async () => {
		const { session } = await fixture();
		const store = new ToolInspectorStore();
		attachToolInspector(session, store);
		const wrapper = sdk(session)._applyToolLoadout;
		applyToolInspectorUpdate(session, {
			toolName: "inspected",
			customDescription: "Overridden fixture",
			promptRule: "Inspector fixture rule.",
		});
		sdk(session)._refreshToolRegistry();
		attachToolInspector(session, store);
		expect(sdk(session)._applyToolLoadout === wrapper).toBe(true);
		expect(sdk(session)._toolRegistry.get("inspected")?.description === "Overridden fixture").toBe(true);
		expect(inspectorTool(session).promptGuidelines.filter((line) => line === "Inspector fixture rule.")).toHaveLength(
			1,
		);
		expect(session.systemPrompt.includes("Inspector fixture rule.")).toBe(true);
		applyToolInspectorUpdate(session, { toolName: "inspected", customDescription: null, promptRule: null });
		expect(sdk(session)._toolRegistry.get("inspected")?.description === "Default fixture description.").toBe(true);
		expect(session.systemPrompt.includes("Inspector fixture rule.")).toBe(false);
	});
	it("propagates explicit workspace changes only within that cwd and honors chat precedence", async () => {
		const a = await fixture(),
			b = await fixture(),
			other = await fixture(join(root, "elsewhere"));
		const store = new ToolInspectorStore();
		for (const item of [a, b, other]) attachToolInspector(item.session, store);
		applyToolInspectorUpdate(b.session, { toolName: "inspected", enabled: true, customDescription: "B fixture text" });
		applyToolInspectorUpdate(a.session, {
			toolName: "inspected",
			scope: "workspace",
			enabled: false,
			customDescription: "Workspace fixture text",
			promptRule: "Workspace fixture rule.",
		});
		expect(a.session.getActiveToolNames().includes("inspected")).toBe(false);
		expect(b.session.getActiveToolNames().includes("inspected")).toBe(true);
		expect(other.session.getActiveToolNames().includes("inspected")).toBe(true);
		expect(sdk(b.session)._toolRegistry.get("inspected")?.description === "B fixture text").toBe(true);
		expect(b.session.systemPrompt.includes("Workspace fixture rule.")).toBe(true);
		expect(other.session.systemPrompt.includes("Workspace fixture rule.")).toBe(false);
		applyToolInspectorUpdate(b.session, { toolName: "inspected", enabled: null, customDescription: null });
		expect(b.session.getActiveToolNames().includes("inspected")).toBe(false);
		applyToolInspectorUpdate(a.session, { toolName: "inspected", scope: "workspace", enabled: null });
		expect(b.session.getActiveToolNames().includes("inspected")).toBe(true);
	});
	it("reloads persisted chat policy before its next turn and does not execute a disabled tool", async () => {
		let executions = 0;
		const { session, faux } = await fixture(
			root,
			definition(async () => {
				executions++;
				return { content: [{ type: "text", text: "fixture" }], details: {} };
			}),
		);
		const path = join(root, "tool-inspector.json");
		const disk = new ToolInspectorStore(path);
		disk.set("chat", session.sessionId, "inspected", { enabled: false });
		attachToolInspector(session, new ToolInspectorStore(path));
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("inspected", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Fixture complete."),
		]);
		await session.prompt("Synthetic inspector fixture");
		expect(executions).toBe(0);
		expect(session.getActiveToolNames().includes("inspected")).toBe(false);
	});
	it("uses the current session identity after newSession rather than leaking the old chat disable", async () => {
		const { session } = await fixture();
		attachToolInspector(session, new ToolInspectorStore());
		applyToolInspectorUpdate(session, { toolName: "inspected", enabled: false });
		const oldId = session.sessionId;
		session.sessionManager.newSession();
		session.setActiveToolsByName(["inspected"]);
		expect(session.sessionId !== oldId).toBe(true);
		expect(session.getActiveToolNames().includes("inspected")).toBe(true);
	});
	it("rejects invalid updates and SDK shape changes instead of promising unenforced toggles", async () => {
		expect(() => attachToolInspector(catalog(), new ToolInspectorStore())).toThrow("SDK 1.0.1");
		const { session } = await fixture();
		attachToolInspector(session, new ToolInspectorStore());
		expect(() => applyToolInspectorUpdate(session, { toolName: "missing", enabled: false })).toThrow("Tool not found");
		expect(() =>
			applyToolInspectorUpdate(session, { toolName: "inspected", enabled: "false" } as unknown as ToolInspectorUpdate),
		).toThrow("boolean");
		expect(() =>
			applyToolInspectorUpdate(session, { toolName: "inspected", customDescription: "x".repeat(8001) }),
		).toThrow("limit");
		expect(() => applyToolInspectorUpdate(session, { toolName: "inspected" })).toThrow("Supply");
		expect(session.getActiveToolNames().includes("inspected")).toBe(true);
	});
	it("keeps in-memory settings unchanged when a disk save fails", async () => {
		const { session } = await fixture();
		const blocked = join(root, "blocked");
		const store = new ToolInspectorStore(join(blocked, "tools.json"));
		attachToolInspector(session, store);
		writeFileSync(blocked, "a file, not a directory");
		expect(() => applyToolInspectorUpdate(session, { toolName: "inspected", enabled: false })).toThrow();
		expect(session.getActiveToolNames().includes("inspected")).toBe(true);
		expect(store.get("chat", session.sessionId, "inspected")).toEqual({});
	});
});

describe("HTTP adapter without a listening server", () => {
	it("resolves the exact client and conversation and returns a catalog after updates", async () => {
		const { session } = await fixture();
		const resolveSession = vi.fn((clientId: string, convId: string) =>
			clientId === "client" && convId === "conv" ? session : undefined,
		);
		const deps: ToolInspectorDependencies = {
			store: new ToolInspectorStore(),
			resolveSession,
			pluginTools: () => [{ name: "inspected", source: "plugin" }],
		};
		expect((await handleToolInspectorRequest(deps, { method: "GET", clientId: "client", convId: "conv" })).status).toBe(
			200,
		);
		const updated = await handleToolInspectorRequest(deps, {
			method: "POST",
			clientId: "client",
			convId: "conv",
			update: { toolName: "inspected", enabled: false },
		});
		expect(updated.status).toBe(200);
		expect(
			(updated.body as ToolInspectorSnapshot).tools.some(
				(tool) => tool.name === "inspected" && tool.enabled === false && tool.source === "plugin",
			),
		).toBe(true);
		expect(
			(await handleToolInspectorRequest(deps, { method: "GET", clientId: "client", convId: "different" })).status,
		).toBe(404);
		expect((await handleToolInspectorRequest(deps, { method: "GET", clientId: "client" })).status).toBe(400);
		expect(
			(await handleToolInspectorRequest(deps, { method: "POST", clientId: "client", convId: "conv", update: null }))
				.status,
		).toBe(400);
		expect(resolveSession).toHaveBeenCalledWith("client", "conv");
	});
	it("registers only the isolated GET and POST routes without mounting global middleware", () => {
		const app = { get: vi.fn(), post: vi.fn() };
		registerToolInspectorRoutes(app as never, { store: new ToolInspectorStore(), resolveSession: () => undefined });
		expect(app.get.mock.calls[0][0]).toBe("/api/tool-inspector");
		expect(app.post.mock.calls[0][0]).toBe("/api/tool-inspector/update");
		expect(app.get).toHaveBeenCalledTimes(1);
		expect(app.post).toHaveBeenCalledTimes(1);
	});
});

function viewSnapshot(description = "Fixture description"): ToolInspectorSnapshot {
	const tools: ToolInspectorTool[] = [
		{
			name: "read",
			source: "core",
			origin: "builtin:read",
			description,
			defaultDescription: description,
			promptGuidelines: [],
			parameterSummary: [{ name: "path", type: "string", required: true, description: "Fixture path" }],
			parameters: { type: "object" },
			exposure: "direct",
			enabled: true,
			active: true,
			overrides: { chat: {}, workspace: {}, effective: {} },
		},
		{
			name: "mail",
			source: "plugin",
			description: "Fixture mail",
			defaultDescription: "Fixture mail",
			promptGuidelines: [],
			parameterSummary: [],
			exposure: "deferred",
			enabled: false,
			active: false,
			overrides: { chat: {}, workspace: {}, effective: {} },
		},
	];
	return { sessionId: "fixture", workspace: "/fixture", tools };
}
const response = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as Response;
async function settleUi() {
	await vi.waitFor(() => expect(document.querySelector("[data-action=scope]")?.hasAttribute("disabled")).toBe(false));
}

describe("drawer rendering helpers and browser interaction", () => {
	it("filters source and description/name case-insensitively without altering the catalog", () => {
		const snapshot = viewSnapshot();
		expect(browser.helpers.filterTools(snapshot.tools, "READ", "core")).toHaveLength(1);
		expect(browser.helpers.filterTools(snapshot.tools, "fixture", "plugin")).toHaveLength(1);
		expect(browser.helpers.filterTools(snapshot.tools, "none")).toHaveLength(0);
		expect(snapshot.tools).toHaveLength(2);
		expect(browser.helpers.buildUpdate("read", { enabled: false, ignored: true })).toEqual({
			toolName: "read",
			scope: "chat",
			enabled: false,
		});
	});
	it("escapes schemas, descriptions, tool names and editor content rather than executing markup", () => {
		const tool = viewSnapshot('<script>unsafe()</script> & "').tools[0];
		tool.name = '<img src=x onerror="unsafe()">';
		tool.overrides.chat.promptRule = "</textarea><img src=x>";
		document.body.innerHTML = browser.helpers.renderToolRow(tool, 0);
		expect(document.querySelector("script,img")).toBeNull();
		expect(document.querySelector("textarea[name=promptRule]")?.textContent).toBe("</textarea><img src=x>");
		expect(document.querySelector("input")?.getAttribute("aria-label")).toBe(`Enable ${tool.name}`);
		expect(document.querySelector("th[scope=row]")?.textContent).toBe("path");
		expect(browser.helpers.formatSchema(undefined)).toContain("No parameter");
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		expect(browser.helpers.formatSchema(cycle)).toContain("cannot");
		expect(browser.helpers.renderToolList(viewSnapshot(), { search: "absent" })).toContain("No tools match");
	});
	it("opens with accessible controls and sends a per-chat toggle to the pinned conversation", async () => {
		const snapshot = viewSnapshot();
		const network = vi.fn(async (_url: unknown, init?: RequestInit) => {
			if (init?.method === "POST") {
				snapshot.tools[0].enabled = false;
				snapshot.tools[0].active = false;
			}
			return response(snapshot);
		});
		await browser.open({ clientId: "client 1", convId: "chat 1", baseUrl: "/pi/", fetch: network as typeof fetch });
		expect(document.querySelector("[role=dialog][aria-modal=true]")).not.toBeNull();
		expect(document.activeElement?.getAttribute("data-action")).toBe("search");
		const url = new URL(String(network.mock.calls[0][0]));
		expect(url.pathname).toBe("/pi/api/tool-inspector");
		expect(url.searchParams.get("convId")).toBe("chat 1");
		const toggle = document.querySelector<HTMLInputElement>('[data-tool-index="0"] [data-action=toggle]')!;
		toggle.checked = false;
		toggle.dispatchEvent(new Event("change", { bubbles: true }));
		await settleUi();
		const sent = JSON.parse(network.mock.calls[1][1]!.body as string);
		expect(sent).toEqual({
			clientId: "client 1",
			convId: "chat 1",
			update: { toolName: "read", scope: "chat", enabled: false },
		});
		expect(document.querySelector<HTMLInputElement>('[data-tool-index="0"] input')?.checked).toBe(false);
	});
	it("saves workspace text, resets overrides and filters rows through the actual drawer", async () => {
		const network = vi.fn(async () => response(viewSnapshot()));
		await browser.open({ clientId: "c", convId: "v", fetch: network });
		const scope = document.querySelector<HTMLSelectElement>("[data-action=scope]")!;
		scope.value = "workspace";
		scope.dispatchEvent(new Event("change", { bubbles: true }));
		const form = document.querySelector<HTMLFormElement>("form")!;
		form.querySelector<HTMLTextAreaElement>("[name=customDescription]")!.value = "Fixture custom text";
		form.querySelector<HTMLTextAreaElement>("[name=promptRule]")!.value = "Fixture rule";
		form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		await settleUi();
		expect(JSON.parse((network.mock.calls[1] as unknown as [unknown, RequestInit])[1].body as string).update).toEqual({
			toolName: "read",
			scope: "workspace",
			customDescription: "Fixture custom text",
			promptRule: "Fixture rule",
		});
		document.querySelector<HTMLButtonElement>("[data-action=reset]")!.click();
		await settleUi();
		expect(JSON.parse((network.mock.calls[2] as unknown as [unknown, RequestInit])[1].body as string).update).toEqual({
			toolName: "read",
			scope: "workspace",
			enabled: null,
			customDescription: null,
			promptRule: null,
		});
		const search = document.querySelector<HTMLInputElement>("[data-action=search]")!;
		search.value = "MAIL";
		search.dispatchEvent(new Event("input", { bubbles: true }));
		expect(document.querySelectorAll(".pti-tool")).toHaveLength(1);
		expect(document.querySelector(".pti-tool-name")?.textContent).toBe("mail");
	});
	it("keeps separate unsaved drafts through search and scope changes", async () => {
		await browser.open({ clientId: "c", convId: "v", fetch: async () => response(viewSnapshot()) });
		const textarea = document.querySelector<HTMLTextAreaElement>("textarea")!;
		textarea.value = "Chat draft";
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
		const search = document.querySelector<HTMLInputElement>("[data-action=search]")!;
		search.value = "mail";
		search.dispatchEvent(new Event("input", { bubbles: true }));
		search.value = "";
		search.dispatchEvent(new Event("input", { bubbles: true }));
		expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Chat draft");
		const scope = document.querySelector<HTMLSelectElement>("[data-action=scope]")!;
		scope.value = "workspace";
		scope.dispatchEvent(new Event("change", { bubbles: true }));
		expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("");
		scope.value = "chat";
		scope.dispatchEvent(new Event("change", { bubbles: true }));
		expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Chat draft");
	});
	it("reports errors, rolls back failed switches and retains unsaved editor text", async () => {
		const network = vi.fn(async (_url: unknown, init?: RequestInit) =>
			response(
				init?.method === "POST" ? { error: "Fixture save refused" } : viewSnapshot(),
				init?.method !== "POST",
				init?.method === "POST" ? 500 : 200,
			),
		);
		await browser.open({ clientId: "c", convId: "v", fetch: network as typeof fetch });
		const textarea = document.querySelector<HTMLTextAreaElement>("textarea")!;
		textarea.value = "Do not lose fixture draft";
		const toggle = document.querySelector<HTMLInputElement>("[data-action=toggle]")!;
		toggle.checked = false;
		toggle.dispatchEvent(new Event("change", { bubbles: true }));
		await settleUi();
		expect(document.querySelector("[role=alert]")?.textContent).toBe("Fixture save refused");
		expect(toggle.checked).toBe(true);
		expect(textarea.value).toBe("Do not lose fixture draft");
	});
	it("closes on Escape, restores focus and ignores late responses from an earlier chat", async () => {
		const prior = document.createElement("button");
		document.body.append(prior);
		prior.focus();
		let release!: (response: Response) => void;
		const delayed = browser.open({
			clientId: "c",
			convId: "old",
			fetch: () =>
				new Promise<Response>((resolve) => {
					release = resolve;
				}),
		});
		await browser.open({ clientId: "c", convId: "new", fetch: async () => response(viewSnapshot("New chat fixture")) });
		release(response(viewSnapshot("Old chat fixture")));
		await delayed;
		expect(document.querySelector(".pti-description")?.textContent).toBe("New chat fixture");
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(document.querySelector(".pti-overlay")).toBeNull();
		expect(document.activeElement).toBe(prior);
	});
	it("rejects missing conversation IDs and refuses cross-origin API requests", async () => {
		await expect(browser.open({ clientId: "c", convId: "" })).rejects.toThrow("Select a chat");
		const network = vi.fn();
		await browser.open({ clientId: "c", convId: "v", baseUrl: "https://not-this-app.invalid/", fetch: network });
		expect(network).not.toHaveBeenCalled();
		expect(document.querySelector("[role=alert]")?.textContent).toContain("own origin");
	});
});
