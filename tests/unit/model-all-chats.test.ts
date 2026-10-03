import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
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
let root: string;
let store: ClientStateStore;
const tick = () => vi.setSystemTime(Date.now() + 20);

interface TestHost {
	setModel(id: string): Promise<void>;
	setModelAllChats(id: string): Promise<void>;
	restoreChatModelChoice(conv: Conversation, beforePrompt?: boolean): Promise<boolean>;
	onEventNow(conv: Conversation, event: { type: "agent_settled" }): void;
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
	const session = Object.assign(Object.create(AgentSession.prototype), {
		agent: { state: { model: initial, thinkingLevel: "high" } },
		sessionManager: sm,
		settingsManager: settings,
		_modelRuntime: { checkAuth: control.auth },
		_emitModelSelect: vi.fn(async () => {}),
		_emit: vi.fn(),
		_extensionRunner: { emit: vi.fn(async () => {}) },
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
	return { conv, sm, session, settings, control };
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

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(BASE);
	root = mkdtempSync(join(tmpdir(), "all-model-unit-"));
	store = new ClientStateStore(join(root, "client-state.json"));
});
afterEach(() => {
	vi.useRealTimers();
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
		expect(chatModelChoice(press, BASE, old, undefined, true)).toBeUndefined();
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
		expect([a.session.model?.id, b.session.model?.id]).toEqual(["beta", "beta"]);
		expect(ctx.rememberProjectModel).not.toHaveBeenCalled();
		expect(store.getDefaultModel()).toBe("fixture/alpha");
		expect(a.settings.setDefaultModelAndProvider).not.toHaveBeenCalled();
		expect(ctx.emit).toHaveBeenLastCalledWith(expect.objectContaining({ textEn: "2 open chats switched." }));
		const record = store.getAllChatsModel();
		await ctx.setModelAllChats("fixture/missing");
		expect(store.getAllChatsModel()).toEqual(record);
		expect(ctx.emit).toHaveBeenLastCalledWith(expect.objectContaining({ level: "error" }));
	});
	it("a busy reply is not interrupted; the production settled event applies the pending model", async () => {
		const a = fixture();
		a.control.running = true;
		const ctx = host([a.conv]);
		tick();
		await ctx.setModelAllChats("fixture/beta");
		expect(a.session.model?.id).toBe("alpha");
		expect(a.control.auth).not.toHaveBeenCalled();
		expect(a.conv.pendingAllChatsModel?.modelId).toBe("fixture/beta");
		a.control.running = false;
		ctx.onEventNow(a.conv, { type: "agent_settled" });
		await a.conv.modelChangeTail;
		expect(a.session.model?.id).toBe("beta");
		expect(a.conv.pendingAllChatsModel).toBeUndefined();
	});
	it("a later manual pick clears a pending press and survives a normal open", async () => {
		const a = fixture();
		a.control.running = true;
		const ctx = host([a.conv]);
		tick();
		await ctx.setModelAllChats("fixture/beta");
		tick();
		await ctx.setModel("fixture/plain");
		a.control.running = false;
		await ctx.restoreChatModelChoice(a.conv);
		expect(a.session.model?.id).toBe("plain");
		expect(a.conv.pendingAllChatsModel).toBeUndefined();
	});
	it("a second press replaces a busy pending press", async () => {
		const a = fixture();
		a.control.running = true;
		const ctx = host([a.conv]);
		tick();
		await ctx.setModelAllChats("fixture/beta");
		tick();
		await ctx.setModelAllChats("fixture/plain");
		a.control.running = false;
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
	it("skips template-pinned and persisted explicitly pinned subagents", async () => {
		const a = fixture(),
			b = fixture(),
			c = fixture();
		a.conv.subagentTemplate = {
			name: "pinned",
			description: "Fixture",
			promptMode: "append",
			systemPrompt: "",
			enabledSkills: [],
			enabledExtensions: [],
			model: "fixture/alpha",
			thinkingLevel: "",
			enabled: true,
		};
		b.sm.appendCustomEntry("pi-web-ui/model-pinned", { pinned: true });
		const ctx = host([a.conv, b.conv, c.conv]);
		tick();
		await ctx.setModelAllChats("fixture/beta");
		expect([a.session.model?.id, b.session.model?.id, c.session.model?.id]).toEqual(["alpha", "alpha", "beta"]);
	});
	it("a newly created chat ignores the old press; a pending choice applies before its next prompt admission", async () => {
		const a = fixture();
		const ctx = host([a.conv]);
		tick();
		await ctx.setModelAllChats("fixture/beta");
		tick();
		const fresh = fixture();
		await ctx.restoreChatModelChoice(fresh.conv);
		expect(fresh.session.model?.id).toBe("alpha");
		// Admissions are busy while preflight is pending, but no reply has begun.
		a.conv.sendsInFlight = 1;
		tick();
		await ctx.setModelAllChats("fixture/plain");
		expect(a.session.model?.id).toBe("beta");
		await ctx.restoreChatModelChoice(a.conv, true);
		expect(a.session.model?.id).toBe("plain");
	});
});
