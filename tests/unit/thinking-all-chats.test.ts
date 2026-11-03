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
import { chatThinkingChoice, latestThinkingChangeAt, thinkingMove } from "../../server/model-all-chats.js";
import { moveThinkingInMemory, moveThinkingInSettingsFile } from "../../server/thinking-level-settings.js";
import type { ThinkingAllChatsResult } from "../../server/protocol.js";

// Thinking for all chats: every chat on one level moves to another, live and on reopen,
// with pi's settings file written once. No model transport, real chats or real settings.
const BASE = Date.parse("2026-09-01T00:00:00Z");
const XHIGH_AND_MAX = { xhigh: "xhigh", max: "max" } as const;
const model = (id: string, thinkingLevelMap: Model<"openai-completions">["thinkingLevelMap"] = XHIGH_AND_MAX) =>
	({
		provider: "fixture",
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1",
		reasoning: true,
		thinkingLevelMap,
		input: ["text"],
		contextWindow: 32000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}) as Model<"openai-completions">;
const models = [model("alpha"), model("beta"), model("max-only", { xhigh: null, max: "max" })];
const tick = () => vi.setSystemTime(Date.now() + 20);

/** pi's global settings file as the SDK's storage sees it, counting writes. */
function settingsFile(initial: Record<string, unknown>) {
	const file = {
		text: JSON.stringify(initial, null, 2) as string | undefined,
		writes: 0,
		withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined) {
			const next = fn(scope === "global" ? file.text : undefined);
			if (next !== undefined && scope === "global") {
				file.text = next;
				file.writes++;
			}
		},
		json: () => JSON.parse(file.text ?? "{}") as Record<string, unknown>,
	};
	return file;
}
const PI_SETTINGS = {
	defaultThinkingLevel: "max",
	modelThinkingLevels: { "fixture/alpha": "max", "fixture/beta": "high", "fixture/gamma": "low" },
	theme: "dark",
	compaction: { enabled: true },
};

let root: string;
let store: ClientStateStore;
let file: ReturnType<typeof settingsFile>;

interface TestHost {
	setThinkingAllChats(from: unknown, to: unknown, dryRun?: unknown): Promise<ThinkingAllChatsResult>;
	restoreChatThinkingChoice(conv: Conversation): Promise<boolean>;
	emit: ReturnType<typeof vi.fn>;
	convs: Map<string, Conversation>;
}

function fixture(level: string, initial = models[0]) {
	// Real SDK setters, SessionManager and SettingsManager (its own in-memory copy of the
	// shared settings file, like every live chat); only auth/events are stubbed.
	const sm = SessionManager.inMemory("/fixture");
	sm.appendModelChange(initial.provider, initial.id);
	sm.appendThinkingLevelChange(level);
	const settings = SettingsManager.fromStorage(file);
	const control = { running: false, auth: vi.fn(async () => true) };
	// Stopping a reply goes through one of these two; a live change must use neither.
	const stop = { agent: vi.fn(), session: vi.fn(async () => {}) };
	const session = Object.assign(Object.create(AgentSession.prototype), {
		agent: { state: { model: initial, thinkingLevel: level }, abort: stop.agent },
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
		createdAt: Date.now(),
		session,
		runtime: { services: { modelRuntime: { getModel: (_p: string, id: string) => models.find((m) => m.id === id) } } },
		wizardRunning: false,
		sendsInFlight: 0,
	} as unknown as Conversation;
	const stops = () => stop.agent.mock.calls.length + stop.session.mock.calls.length;
	return { conv, sm, session, settings, control, stops };
}

function host(convs: Conversation[]): TestHost {
	const ctx = Object.assign(Object.create(ClientSession.prototype), {
		activeId: convs[0]?.id,
		stateStore: store,
		cwd: "/fixture",
		disposed: false,
		settingsFileManager: () => SettingsManager.fromStorage(file),
		applyCompactionOverrides: vi.fn(),
		checkpointViewers: vi.fn(),
		flushSnapshot: vi.fn(),
		scheduleSnapshot: vi.fn(),
		emit: vi.fn(),
	});
	Object.defineProperty(ctx, "convs", { value: new Map(convs.map((c) => [c.id, c])) });
	return ctx as TestHost;
}

const thinkingEntries = (sm: SessionManager) => sm.getBranch().filter((e) => e.type === "thinking_level_change").length;
const notices = (ctx: TestHost) =>
	ctx.emit.mock.calls
		.map(([m]) => m as { type: string; level?: string; text?: string })
		.filter((m) => m.type === "notice");
const result = (ctx: TestHost) =>
	ctx.emit.mock.calls.map(([m]) => m as ThinkingAllChatsResult).find((m) => m.type === "thinking_all_chats_result");

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(BASE);
	root = mkdtempSync(join(tmpdir(), "thinking-all-unit-"));
	store = new ClientStateStore(join(root, "client-state.json"));
	file = settingsFile(PI_SETTINGS);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

describe("the requested move is checked before anything changes", () => {
	it.each([
		[undefined, "xhigh", /Missing "from" thinking level \(one of: off, minimal, low, medium, high, xhigh, max\)/],
		["max", undefined, /Missing "to" thinking level/],
		["maximum", "xhigh", /Unknown "from" thinking level: maximum \(one of: off/],
		["max", "ultra", /Unknown "to" thinking level: ultra/],
		["max", "max", /"from" and "to" are both max: nothing to move/],
	])("thinkingMove(%s, %s) fails with a clear message", (from, to, message) => {
		expect(() => thinkingMove(from, to)).toThrow(message);
	});

	it("a refused move records nothing, writes nothing and moves no chat", async () => {
		const a = fixture("max");
		const ctx = host([a.conv]);
		for (const [from, to, dryRun] of [
			["max", "max"],
			[undefined, "xhigh"],
			["max", "ultra"],
			["max", "xhigh", "yes"],
		] as const) {
			ctx.emit.mockClear();
			const r = await ctx.setThinkingAllChats(from, to, dryRun);
			expect(r).toMatchObject({ ok: false, changed: 0 });
			expect(r.error).toBeTruthy();
			expect(result(ctx)).toEqual(r);
			expect(notices(ctx)).toEqual([
				expect.objectContaining({ level: "error", text: expect.stringContaining(r.error!) }),
			]);
		}
		expect(store.getAllChatsThinking()).toBeUndefined();
		expect(file.writes).toBe(0);
		expect(a.session.thinkingLevel).toBe("max");
		expect(a.settings.getDefaultThinkingLevel()).toBe("max");
	});
});

describe("every open chat on the old level moves", () => {
	it("a streaming chat on max moves without being stopped; an idle chat on high stays; pi's settings move once", async () => {
		const streaming = fixture("max");
		streaming.control.running = true;
		const idle = fixture("high", models[1]);
		const ctx = host([streaming.conv, idle.conv]);
		tick();
		const r = await ctx.setThinkingAllChats("max", "xhigh");

		expect(r).toMatchObject({ ok: true, dryRun: false, from: "max", to: "xhigh", changed: 1, skipped: 1, failed: 0 });
		expect(streaming.session.thinkingLevel).toBe("xhigh");
		expect(idle.session.thinkingLevel).toBe("high");
		expect(streaming.stops()).toBe(0);
		expect(streaming.session.isStreaming).toBe(true);
		// The change is in the chat's own transcript, like its own picker; the idle chat gets nothing.
		expect(streaming.sm.getBranch().findLast((e) => e.type === "thinking_level_change")).toMatchObject({
			thinkingLevel: "xhigh",
		});
		expect(thinkingEntries(idle.sm)).toBe(1);

		// pi's settings file: one write, only the entries that were max.
		expect(file.writes).toBe(1);
		expect(file.json()).toEqual({
			...PI_SETTINGS,
			defaultThinkingLevel: "xhigh",
			modelThinkingLevels: { "fixture/alpha": "xhigh", "fixture/beta": "high", "fixture/gamma": "low" },
		});
		expect(r.settingsFileEntries).toEqual(["defaultThinkingLevel", "modelThinkingLevels.fixture/alpha"]);
		// Each chat's own in-memory copy moved too, without writing.
		expect(r.settingsCopies).toBe(2);
		for (const f of [streaming, idle]) {
			expect(f.settings.getDefaultThinkingLevel()).toBe("xhigh");
			expect(f.settings.getModelThinkingLevel("fixture", "alpha")).toBe("xhigh");
			expect(f.settings.getModelThinkingLevel("fixture", "beta")).toBe("high");
			expect(f.settings.getModelThinkingLevel("fixture", "gamma")).toBe("low");
		}
		expect(store.getAllChatsThinking()).toMatchObject({ from: "max", to: "xhigh" });
		expect(notices(ctx)).toEqual([
			expect.objectContaining({ level: "info", text: "Thinking max → xhigh: 1 open chat changed, 1 left as it was." }),
		]);

		// An account switch reads the chat's in-memory copy: it must not snap back to max.
		await streaming.session.setModel(models[0]);
		expect(streaming.session.thinkingLevel).toBe("xhigh");
	});

	it("a second run changes nothing and writes nothing", async () => {
		const a = fixture("max");
		const ctx = host([a.conv]);
		tick();
		await ctx.setThinkingAllChats("max", "xhigh");
		tick();
		const again = await ctx.setThinkingAllChats("max", "xhigh");
		expect(again).toMatchObject({ ok: true, changed: 0, skipped: 1, failed: 0, settingsCopies: 0 });
		expect(again.settingsFileEntries).toEqual([]);
		expect(file.writes).toBe(1);
	});

	it("a dry run counts what would change and changes nothing", async () => {
		const a = fixture("max");
		const b = fixture("low");
		const ctx = host([a.conv, b.conv]);
		const r = await ctx.setThinkingAllChats("max", "xhigh", true);
		expect(r).toMatchObject({ ok: true, dryRun: true, changed: 1, skipped: 1, settingsCopies: 2 });
		expect(r.settingsFileEntries).toEqual(["defaultThinkingLevel", "modelThinkingLevels.fixture/alpha"]);
		expect(a.session.thinkingLevel).toBe("max");
		expect(a.settings.getDefaultThinkingLevel()).toBe("max");
		expect(file.writes).toBe(0);
		expect(store.getAllChatsThinking()).toBeUndefined();
	});

	it("a chat whose model has no xhigh is reported, and the rest still move", async () => {
		const stuck = fixture("max", models[2]);
		const fine = fixture("max");
		const ctx = host([stuck.conv, fine.conv]);
		const r = await ctx.setThinkingAllChats("max", "xhigh");
		expect(r).toMatchObject({ ok: true, changed: 1, failed: 1 });
		expect(r.failures).toEqual([`${stuck.conv.id}: fixture/max-only has no xhigh level`]);
		expect(stuck.session.thinkingLevel).toBe("max");
		expect(fine.session.thinkingLevel).toBe("xhigh");
		expect(notices(ctx)[0]).toMatchObject({ level: "warning" });
	});
});

describe("pi's settings: fail loud, change nothing on bad input", () => {
	it("a settings file that isn't JSON is refused and left as it was", () => {
		const manager = SettingsManager.fromStorage(file);
		file.text = "{ not json";
		expect(() => moveThinkingInSettingsFile(manager, "max", "xhigh")).toThrow(
			/settings.json is not valid JSON, nothing changed/,
		);
		expect(file.text).toBe("{ not json");
		expect(file.writes).toBe(0);
	});

	it("an SDK whose SettingsManager changed shape fails loud; a non-SDK stand-in is left alone", () => {
		const manager = SettingsManager.inMemory({ defaultThinkingLevel: "max" });
		delete (manager as unknown as { globalSettings?: unknown }).globalSettings;
		expect(() => moveThinkingInMemory(manager, "max", "xhigh")).toThrow(/pi SDK SettingsManager changed shape/);
		expect(moveThinkingInMemory({ getDefaultThinkingLevel: () => "max" }, "max", "xhigh")).toEqual([]);
	});
});

describe("older chats follow when they next open", () => {
	it("the dated rule: older chat on the old level, with no later pick", () => {
		const press = { from: "max" as const, to: "xhigh" as const, at: BASE + 1000.5 };
		expect(chatThinkingChoice(press, BASE, "max", BASE)).toBe("xhigh");
		expect(chatThinkingChoice(press, BASE, "high", BASE)).toBeUndefined(); // not on the old level
		expect(chatThinkingChoice(press, BASE + 1000, "max", BASE)).toBeUndefined(); // born at the press
		expect(chatThinkingChoice(press, BASE, "max", BASE + 2000)).toBeUndefined(); // picked again later
		expect(chatThinkingChoice(undefined, BASE, "max", BASE)).toBeUndefined();
		expect(latestThinkingChangeAt([])).toBe(Number.NEGATIVE_INFINITY);
	});

	it("an older chat restored on max opens on xhigh; a later pick and a newer chat keep max", async () => {
		const older = fixture("max");
		const olderHigh = fixture("high");
		const picked = fixture("max");
		tick();
		const ctx = host([]);
		await ctx.setThinkingAllChats("max", "xhigh"); // none of them is open yet
		tick();
		picked.sm.appendThinkingLevelChange("max"); // a manual pick after the press (never undone)
		const newer = fixture("max"); // born after the press: the new-chat default rules it
		tick();
		const changed: Record<string, boolean> = {};
		for (const [name, f] of Object.entries({ older, olderHigh, picked, newer })) {
			ctx.convs.set(f.conv.id, f.conv);
			changed[name] = await ctx.restoreChatThinkingChoice(f.conv);
		}
		expect(changed).toEqual({ older: true, olderHigh: false, picked: false, newer: false });
		expect(older.session.thinkingLevel).toBe("xhigh");
		expect(olderHigh.session.thinkingLevel).toBe("high");
		expect(picked.session.thinkingLevel).toBe("max");
		expect(newer.session.thinkingLevel).toBe("max");
		// Opening it again changes nothing more.
		expect(await ctx.restoreChatThinkingChoice(older.conv)).toBe(false);
		expect(thinkingEntries(older.sm)).toBe(2);
	});
});

describe("a real pi run (faux model: no network, no tokens)", () => {
	it("the next request of a running reply uses the new level; the running tool step is not stopped or rerun", async () => {
		vi.useRealTimers();
		const faux = fauxProvider({ provider: "faux-run", models: [{ id: "alpha", reasoning: true }] });
		const modelRuntime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		// Only the requested level of each request is kept, never what is sent to the model.
		const levels: (string | undefined)[] = [];
		faux.setResponses([
			(_context, options) => {
				levels.push(options?.reasoning);
				return fauxAssistantMessage(fauxToolCall("wait_step", {}), { stopReason: "toolUse" });
			},
			(_context, options) => {
				levels.push(options?.reasoning);
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
		const settingsManager = SettingsManager.fromStorage(file);
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
		const alpha = faux.getModel("alpha");
		if (!alpha) throw new Error("faux model alpha missing");
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: root,
			modelRuntime,
			model: { ...alpha, thinkingLevelMap: XHIGH_AND_MAX },
			thinkingLevel: "max",
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
		const runningAtChange = session.isStreaming;
		const r = await ctx.setThinkingAllChats("max", "xhigh");
		release();
		await run;
		await vi.waitUntil(() => !session.isStreaming);
		const replies = session.messages.filter((m) => m.role === "assistant") as { stopReason?: string }[];
		session.dispose();
		expect({ runningAtChange, changed: r.changed, levels, toolRuns }).toEqual({
			runningAtChange: true,
			changed: 1,
			// The request already sent keeps max; the next one asks for xhigh.
			levels: ["max", "xhigh"],
			toolRuns: 1,
		});
		expect(replies.map((m) => m.stopReason)).toEqual(["toolUse", "stop"]);
	});
});
