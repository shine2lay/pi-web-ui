import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientSession, type Conversation } from "../../server/agent-service.js";
import { ClientStateStore } from "../../server/client-state.js";
import { FAST_MODE_ENTRY, fastModeRegistry } from "../../server/fast-mode.js";
import { chatModelChoice, latestChatModelChoice } from "../../server/model-all-chats.js";

const BASE = Date.parse("2026-09-01T00:00:00Z");
const model = (provider: string, id: string, reasoning = true): Model<"openai-completions"> => ({
	provider,
	id,
	name: id,
	api: "openai-completions",
	baseUrl: "http://127.0.0.1:1",
	reasoning,
	input: ["text"],
	contextWindow: 32000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const models = [
	model("fixture", "alpha"),
	model("fixture", "beta"),
	model("fixture", "plain", false),
	model("openai-codex", "gpt-6-astra"),
	model("openai-codex", "gpt-6.1-sol"),
];
const template = {
	name: "pinned",
	description: "Fixture",
	promptMode: "append" as const,
	systemPrompt: "",
	enabledSkills: [],
	enabledExtensions: [],
	model: "fixture/alpha",
	thinkingLevel: "",
	enabled: true,
};
let root: string;
let store: ClientStateStore;
const tick = () => vi.setSystemTime(Date.now() + 20);

interface TestHost {
	setModel(id: string): Promise<void>;
	setModelAllChats(id: string): Promise<void>;
	restoreChatModelChoice(conv: Conversation): Promise<boolean>;
	restoreKeyForModel: ReturnType<typeof vi.fn>;
	rememberProjectModel: ReturnType<typeof vi.fn>;
	emit: ReturnType<typeof vi.fn>;
}

function fixture(initial = models[0]) {
	// Real SDK setters + in-memory SessionManager; only auth/events are stubbed.
	// No model transport, prompts, real chat files, or global settings are touched.
	const sm = SessionManager.inMemory("/fixture");
	sm.appendModelChange(initial.provider, initial.id);
	const settings = {
		getModelThinkingLevel: () => undefined,
		getDefaultThinkingLevel: () => "max",
		setDefaultModelAndProvider: vi.fn(),
		setDefaultThinkingLevel: vi.fn(),
	};
	const control = { running: false, auth: vi.fn(async () => true) };
	// Stopping a reply goes through one of these two; a live switch must use neither.
	const stop = { agent: vi.fn(), session: vi.fn(async () => {}) };
	const session = Object.assign(Object.create(AgentSession.prototype), {
		agent: { state: { model: initial, thinkingLevel: "high" }, abort: stop.agent },
		sessionManager: sm,
		settingsManager: settings,
		_modelRuntime: { checkAuth: control.auth },
		_emitModelSelect: vi.fn(async () => {}),
		_emit: vi.fn(),
		_extensionRunner: { emit: vi.fn(async () => {}) },
		abort: stop.session,
	}) as AgentSession;
	Object.defineProperty(session, "isStreaming", { get: () => control.running });
	const conv = {
		id: sm.getSessionId(),
		cwd: "/fixture",
		createdAt: BASE,
		session,
		runtime: {
			services: {
				modelRuntime: { getModel: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id) },
			},
		},
		wizardRunning: false,
		sendsInFlight: 0,
	} as unknown as Conversation;
	const stops = () => stop.agent.mock.calls.length + stop.session.mock.calls.length;
	return { conv, sm, session, settings, control, stops };
}

function host(convs: Conversation[]): TestHost {
	const ctx = Object.assign(Object.create(ClientSession.prototype), {
		activeId: convs[0].id,
		stateStore: store,
		cwd: "/fixture",
		disposed: false,
		restoreKeyForModel: vi.fn(async () => {}),
		rememberProjectModel: vi.fn(),
		applyCompactionOverrides: vi.fn(),
		currentBaseTokens: () => undefined,
		checkpointViewers: vi.fn(),
		flushSnapshot: vi.fn(),
		scheduleSnapshot: vi.fn(),
		emit: vi.fn(),
	});
	Object.defineProperty(ctx, "convs", { value: new Map(convs.map((c) => [c.id, c])) });
	return ctx as TestHost;
}

const ids = (...fixtures: ReturnType<typeof fixture>[]) => fixtures.map((f) => f.session.model?.id);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(BASE);
	root = mkdtempSync(join(tmpdir(), "all-model-unit-"));
	store = new ClientStateStore(join(root, "client-state.json"));
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

describe("dated all-chats choice", () => {
	it("older picks switch; a manual pick after the press and a new chat do not", () => {
		const press = { modelId: "fixture/beta", at: BASE + 20 };
		const old = { modelId: "fixture/alpha", at: BASE };
		expect(chatModelChoice(press, BASE, old, undefined)).toEqual(press);
		const manual = { modelId: "fixture/plain", at: BASE + 30 };
		expect(chatModelChoice(press, BASE, old, manual)).toEqual(manual);
		expect(chatModelChoice(press, BASE + 21, old, undefined)).toBeUndefined();
		expect(chatModelChoice({ ...press, at: BASE + 20.001 }, BASE + 20, old, undefined)).toBeUndefined();
	});
	it("a pinned chat follows only a press that reaches pinned chats, made after it and after its last pick", () => {
		const old = { modelId: "fixture/alpha", at: BASE };
		const before = { modelId: "fixture/beta", at: BASE + 20 };
		expect(chatModelChoice(before, BASE, old, undefined, true)).toBeUndefined();
		const press = { ...before, reachesPinned: true };
		expect(chatModelChoice(press, BASE, old, undefined, true)).toEqual(press);
		expect(chatModelChoice(press, BASE, old, { modelId: "fixture/plain", at: BASE + 30 }, true)).toBeUndefined();
		expect(chatModelChoice(press, BASE, { modelId: "fixture/plain", at: BASE + 30 }, undefined, true)).toBeUndefined();
		expect(chatModelChoice(press, BASE + 21, old, undefined, true)).toBeUndefined();
	});
	it("only current-branch manual model entries count, not a slow bulk application's write time", () => {
		const old = {
			id: "manual",
			type: "model_change",
			timestamp: new Date(BASE).toISOString(),
			provider: "fixture",
			modelId: "alpha",
		};
		const bulk = { ...old, id: "bulk", timestamp: new Date(BASE + 30).toISOString(), modelId: "beta" };
		const marker = { type: "custom", customType: "pi-web-ui/all-chats-applied", data: { modelChangeId: "bulk" } };
		expect(latestChatModelChoice(BASE, [old, bulk, marker])).toEqual({ modelId: "fixture/alpha", at: BASE });
		const click = {
			type: "custom",
			customType: "pi-web-ui/model-choice",
			data: { modelChangeId: "bulk", at: BASE + 10 },
		};
		expect(latestChatModelChoice(BASE, [old, bulk, click])).toEqual({ modelId: "fixture/beta", at: BASE + 10 });
	});
	it("persists one replacement press, ordered picks even in the same millisecond, without changing the default", () => {
		store.saveDefaultModel("fixture/alpha");
		const first = store.saveAllChatsModel("fixture/beta");
		expect(first.reachesPinned).toBe(true);
		const manual = store.saveChatModelChoice("chat", "fixture/plain");
		const second = store.saveAllChatsModel("fixture/alpha");
		expect(manual.at).toBeGreaterThan(first.at);
		expect(second.at).toBeGreaterThan(manual.at);
		expect(Math.floor(second.at)).toBe(BASE);
		const loaded = new ClientStateStore(join(root, "client-state.json"));
		expect(loaded.getAllChatsModel()).toEqual(second);
		expect(loaded.getChatModelChoice("chat")).toEqual(manual);
		expect(loaded.getDefaultModel()).toBe("fixture/alpha");
	});
});

describe("normal SDK model path", () => {
	it("switches every loaded idle chat; unknown models are refused before saving", async () => {
		const a = fixture(),
			b = fixture();
		const ctx = host([a.conv, b.conv]);
		tick();
		store.saveDefaultModel("fixture/alpha");
		await ctx.setModelAllChats("fixture/beta");
		expect(ids(a, b)).toEqual(["beta", "beta"]);
		expect(ctx.rememberProjectModel).not.toHaveBeenCalled();
		expect(store.getDefaultModel()).toBe("fixture/alpha");
		expect(a.settings.setDefaultModelAndProvider).not.toHaveBeenCalled();
		expect(ctx.emit).toHaveBeenLastCalledWith(expect.objectContaining({ textEn: "2 open chats switched." }));
		const record = store.getAllChatsModel();
		await ctx.setModelAllChats("fixture/missing");
		expect(store.getAllChatsModel()).toEqual(record);
		expect(ctx.emit).toHaveBeenLastCalledWith(expect.objectContaining({ level: "error" }));
	});
	it("a running reply switches now, exactly like the chat's own picker, and is not stopped", async () => {
		const outcome = [];
		for (const how of ["picker", "all chats"]) {
			const a = fixture();
			a.control.running = true;
			const ctx = host([a.conv]);
			tick();
			if (how === "picker") await ctx.setModel("fixture/beta");
			else await ctx.setModelAllChats("fixture/beta");
			outcome.push({
				// pi reads agent.state.model again for the reply's next request.
				model: a.session.model?.id,
				stillRunning: a.session.isStreaming,
				stops: a.stops(),
				authChecks: a.control.auth.mock.calls.length,
				modelChanges: a.sm.getEntries().filter((e) => e.type === "model_change").length,
				errors: ctx.emit.mock.calls.filter(([m]) => m.level !== "info").length,
			});
		}
		expect(outcome[0]).toEqual({
			model: "beta",
			stillRunning: true,
			stops: 0,
			authChecks: 1,
			modelChanges: 2,
			errors: 0,
		});
		expect(outcome[1]).toEqual(outcome[0]);
	});
	it("compacting, goal-wizard and just-sent chats switch at once too", async () => {
		const a = fixture(),
			b = fixture(),
			c = fixture();
		Object.defineProperty(a.session, "isCompacting", { get: () => true });
		b.conv.wizardRunning = true;
		c.conv.sendsInFlight = 1;
		const ctx = host([a.conv, b.conv, c.conv]);
		tick();
		await ctx.setModelAllChats("fixture/beta");
		expect(ids(a, b, c)).toEqual(["beta", "beta", "beta"]);
		expect(a.stops() + b.stops() + c.stops()).toBe(0);
	});
	it("a manual pick after a press on a running chat wins and survives a normal open", async () => {
		const a = fixture();
		a.control.running = true;
		const ctx = host([a.conv]);
		tick();
		await ctx.setModelAllChats("fixture/beta");
		expect(a.session.model?.id).toBe("beta");
		tick();
		await ctx.setModel("fixture/plain");
		a.control.running = false;
		await ctx.restoreChatModelChoice(a.conv);
		expect(a.session.model?.id).toBe("plain");
	});
	it("a second press on a running chat replaces the first at once", async () => {
		const a = fixture();
		a.control.running = true;
		const ctx = host([a.conv]);
		tick();
		await ctx.setModelAllChats("fixture/beta");
		tick();
		await ctx.setModelAllChats("fixture/plain");
		expect(a.session.model?.id).toBe("plain");
		await ctx.restoreChatModelChoice(a.conv);
		expect(a.session.model?.id).toBe("plain");
	});
	it("a second press also wins if the first SDK auth check is still finishing", async () => {
		const a = fixture();
		const ctx = host([a.conv]);
		tick();
		let release!: (value: boolean) => void;
		const waiting = new Promise<boolean>((r) => {
			release = r;
		});
		a.control.auth.mockImplementationOnce(() => waiting);
		const first = ctx.setModelAllChats("fixture/beta");
		await vi.waitUntil(() => a.control.auth.mock.calls.length === 1);
		tick();
		const second = ctx.setModelAllChats("fixture/plain");
		tick();
		release(true);
		await Promise.all([first, second]);
		expect(a.session.model?.id).toBe("plain");
	});
	it("a manual pick made BEFORE the press cannot win by finishing auth after it", async () => {
		const a = fixture();
		const ctx = host([a.conv]);
		tick();
		let release!: (value: boolean) => void;
		const waiting = new Promise<boolean>((r) => {
			release = r;
		});
		a.control.auth.mockImplementationOnce(() => waiting);
		const manual = ctx.setModel("fixture/plain");
		await vi.waitUntil(() => a.control.auth.mock.calls.length === 1);
		tick();
		const press = ctx.setModelAllChats("fixture/beta");
		tick();
		release(true);
		await Promise.all([manual, press]);
		expect(a.session.model?.id).toBe("beta");
	});
	it("clamps each chat's own thinking and speed, not the SDK's new-model default", async () => {
		const a = fixture(models[3]);
		fastModeRegistry.setMode(a.sm, "ultrafast");
		const ctx = host([a.conv]);
		tick();
		await ctx.setModelAllChats("openai-codex/gpt-6.1-sol");
		expect(a.session.thinkingLevel).toBe("high");
		expect(fastModeRegistry.mode(a.sm)).toBe("fast");
		tick();
		await ctx.setModelAllChats("fixture/plain");
		expect(a.session.thinkingLevel).toBe("off");
		expect(fastModeRegistry.mode(a.sm)).toBe("standard");
		expect(a.sm.getEntries().some((e) => e.type === "custom" && e.customType === FAST_MODE_ENTRY)).toBe(true);
		expect(a.settings.setDefaultThinkingLevel).not.toHaveBeenCalled();
	});
	it("reaches template-pinned, explicitly pinned and saved-pin chats that existed before the press", async () => {
		const a = fixture(),
			b = fixture(),
			c = fixture(),
			d = fixture(),
			saved = fixture();
		a.conv.subagentTemplate = { ...template };
		b.sm.appendCustomEntry("pi-web-ui/model-pinned", { pinned: true });
		c.conv.modelPinned = true;
		c.control.running = true;
		saved.sm.appendCustomEntry("pi-web-ui/model-pinned", { pinned: true });
		const ctx = host([a.conv, b.conv, c.conv, d.conv]);
		tick();
		store.saveDefaultModel("fixture/alpha");
		await ctx.setModelAllChats("fixture/beta");
		expect(ids(a, b, c, d)).toEqual(["beta", "beta", "beta", "beta"]);
		expect(ctx.emit).toHaveBeenLastCalledWith(expect.objectContaining({ textEn: "4 open chats switched." }));
		expect(store.getDefaultModel()).toBe("fixture/alpha");
		expect(a.conv.subagentTemplate?.model).toBe("fixture/alpha");
		// A saved pinned chat that wasn't open switches when it opens, and keeps it on the next open.
		await ctx.restoreChatModelChoice(saved.conv);
		await ctx.restoreChatModelChoice(saved.conv);
		expect(saved.session.model?.id).toBe("beta");
		expect(saved.sm.getEntries().filter((e) => e.type === "model_change").length).toBe(2);
		// A pinned chat (a task's subagent) created after the press keeps its own model.
		tick();
		const later = fixture();
		later.conv.subagentTemplate = { ...template };
		later.conv.modelPinned = true;
		await ctx.restoreChatModelChoice(later.conv);
		expect(later.session.model?.id).toBe("alpha");
	});
	it("a press saved before this change still skips pinned chats, so installing it moves none", async () => {
		const pinned = fixture(),
			plain = fixture();
		pinned.sm.appendCustomEntry("pi-web-ui/model-pinned", { pinned: true });
		const ctx = host([pinned.conv, plain.conv]);
		tick();
		vi.spyOn(store, "getAllChatsModel").mockReturnValue({ modelId: "fixture/beta", at: Date.now() });
		tick();
		await ctx.restoreChatModelChoice(pinned.conv);
		await ctx.restoreChatModelChoice(plain.conv);
		expect(ids(pinned, plain)).toEqual(["alpha", "beta"]);
	});
	it("keeps going past a chat that can't switch and reports the counts truthfully", async () => {
		const a = fixture(),
			b = fixture(),
			c = fixture();
		b.control.auth.mockResolvedValue(false);
		const ctx = host([a.conv, b.conv, c.conv]);
		tick();
		await ctx.setModelAllChats("fixture/beta");
		expect(ids(a, b, c)).toEqual(["beta", "alpha", "beta"]);
		expect(ctx.emit).toHaveBeenCalledTimes(1);
		expect(ctx.emit).toHaveBeenLastCalledWith(
			expect.objectContaining({
				level: "warning",
				textEn: "2 open chats switched; 1 couldn't switch: No API key for fixture/beta.",
			}),
		);
		// Opened alone later, the same failure is reported for that chat.
		await ctx.restoreChatModelChoice(b.conv);
		expect(ctx.emit).toHaveBeenLastCalledWith(
			expect.objectContaining({ level: "error", textEn: "Failed to switch model: No API key for fixture/beta" }),
		);
	});
	it("idle chats in other folders switch with their own folder's key; every viewer is refreshed", async () => {
		const a = fixture(),
			b = fixture();
		a.control.running = true;
		b.conv.cwd = "/elsewhere";
		const viewers = [a, b].map((f) => ({ activeId: f.conv.id, flushSnapshot: vi.fn(), checkpointViewers: vi.fn() }));
		const live = (ClientSession as unknown as { liveSessions: Set<unknown> }).liveSessions;
		for (const v of viewers) live.add(v);
		try {
			const ctx = host([a.conv, b.conv]);
			tick();
			await ctx.setModelAllChats("fixture/beta");
			expect(ids(a, b)).toEqual(["beta", "beta"]);
			expect(ctx.restoreKeyForModel.mock.calls).toEqual([
				["fixture/beta", "/fixture"],
				["fixture/beta", "/elsewhere"],
			]);
			for (const v of viewers) expect(v.flushSnapshot).toHaveBeenCalledTimes(1);
			expect(viewers[0].checkpointViewers.mock.calls).toEqual([
				[a.conv.id, true],
				[b.conv.id, true],
			]);
		} finally {
			for (const v of viewers) live.delete(v);
		}
	});
	it("a newly created chat ignores the old press", async () => {
		const a = fixture();
		const ctx = host([a.conv]);
		tick();
		await ctx.setModelAllChats("fixture/beta");
		tick();
		const fresh = fixture();
		await ctx.restoreChatModelChoice(fresh.conv);
		expect(fresh.session.model?.id).toBe("alpha");
		expect(a.session.model?.id).toBe("beta");
	});
});

describe("a real pi run (faux model: no network, no tokens)", () => {
	// One reply: request 1 asks for a tool; the switch happens while the tool runs; request 2
	// finishes. Only model ids and counts are kept, never what is sent to the model.
	async function switchDuringTool(how: "picker" | "all chats") {
		vi.useRealTimers();
		const faux = fauxProvider({
			provider: "faux-run",
			models: [
				{ id: "alpha", reasoning: true },
				{ id: "beta", reasoning: true },
			],
		});
		const modelRuntime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		const requests: string[] = [];
		faux.setResponses([
			(_context, _options, _state, m) => {
				requests.push(m.id);
				return fauxAssistantMessage(fauxToolCall("wait_step", {}), { stopReason: "toolUse" });
			},
			(_context, _options, _state, m) => {
				requests.push(m.id);
				return fauxAssistantMessage("done");
			},
		]);
		let toolRuns = 0;
		let toolStarted!: () => void;
		const started = new Promise<void>((r) => {
			toolStarted = r;
		});
		let release!: () => void;
		const released = new Promise<void>((r) => {
			release = r;
		});
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: root,
			modelRuntime,
			model: faux.getModel("alpha"),
			thinkingLevel: "high",
			tools: ["wait_step"],
			customTools: [
				{
					name: "wait_step",
					label: "Wait step",
					description: "Fixture step that waits for the test.",
					parameters: Type.Object({}),
					execute: async () => {
						toolRuns++;
						toolStarted();
						await released;
						return { content: [{ type: "text", text: "ok" }], details: {} };
					},
				},
			],
			resourceLoader,
			sessionManager: SessionManager.inMemory(root),
			settingsManager,
		});
		const conv = {
			id: session.sessionManager.getSessionId(),
			cwd: root,
			createdAt: Date.now(),
			session,
			runtime: { services: { modelRuntime } },
			wizardRunning: false,
			sendsInFlight: 0,
		} as unknown as Conversation;
		const ctx = host([conv]);
		const run = session.prompt("go");
		await started;
		await new Promise((r) => setTimeout(r, 5)); // the press is later than the chat's creation
		const runningAtSwitch = session.isStreaming;
		if (how === "picker") await ctx.setModel("faux-run/beta");
		else await ctx.setModelAllChats("faux-run/beta");
		const modelAtSwitch = session.model?.id;
		release();
		await run;
		await vi.waitUntil(() => !session.isStreaming);
		const replies = session.messages.filter((m) => m.role === "assistant") as { stopReason?: string }[];
		const outcome = {
			runningAtSwitch,
			modelAtSwitch,
			requests,
			toolRuns,
			stopReasons: replies.map((m) => m.stopReason),
			modelChanges: session.sessionManager.getEntries().filter((e) => e.type === "model_change").length,
			thinking: session.thinkingLevel,
			errors: ctx.emit.mock.calls.filter(([m]) => m.level !== "info").length,
		};
		session.dispose();
		return outcome;
	}

	it("All chats switches a reply in the middle of a tool step exactly like the chat's own picker", async () => {
		const picker = await switchDuringTool("picker");
		const allChats = await switchDuringTool("all chats");
		expect(picker).toMatchObject({
			runningAtSwitch: true,
			modelAtSwitch: "beta",
			// The request already sent stays on the old model; the next one uses the new model.
			requests: ["alpha", "beta"],
			// The running tool step finishes once and is not run again; nothing is stopped.
			toolRuns: 1,
			stopReasons: ["toolUse", "stop"],
			errors: 0,
		});
		expect(allChats).toEqual(picker);
	});
});
