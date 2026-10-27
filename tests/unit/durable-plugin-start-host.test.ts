import { describe, expect, it } from "vitest";
import {
	createPluginHostApi,
	getPluginApiCaller,
	installPluginHostApi,
	triggerPluginUiAction,
	withPluginScope,
} from "../../web/src/plugin-host";
import {
	catalogPluginStarts,
	exportPluginStarts,
	openPluginStartCheckpoint,
	PLUGIN_START_PREFIX,
	readPluginStartExport,
	type PluginStartOpenOptions,
	type PluginStartOwner,
} from "../../web/src/plugin-start-checkpoint";
import { computePluginStartRecoveryView } from "../../web/src/use-plugin-start-recovery";

function memoryStorage(opts?: {
	quotaAt?: number;
	readbackMismatchAt?: number;
}): Storage & { values: Map<string, string> } {
	const values = new Map<string, string>();
	let writes = 0;
	let mismatchKey: string | null = null;
	return {
		values,
		get length() {
			return values.size;
		},
		clear() {
			values.clear();
		},
		getItem(key: string) {
			const val = values.get(String(key)) ?? null;
			if (val !== null && mismatchKey === key) {
				mismatchKey = null;
				return `${val} `;
			}
			return val;
		},
		key(index: number) {
			return [...values.keys()][index] ?? null;
		},
		removeItem(key: string) {
			values.delete(String(key));
		},
		setItem(key: string, value: string) {
			writes += 1;
			if (opts?.quotaAt && writes >= opts.quotaAt) {
				throw new Error("QuotaExceededError");
			}
			values.set(String(key), String(value));
			if (opts?.readbackMismatchAt && writes === opts.readbackMismatchAt) {
				mismatchKey = String(key);
			}
		},
	};
}

function createLocks(): NonNullable<PluginStartOpenOptions["locks"]> {
	const held = new Set<string>();
	const request = async <T>(
		name: string,
		optionsOrCb: LockOptions | LockGrantedCallback<T>,
		maybeCb?: LockGrantedCallback<T>,
	): Promise<Awaited<T>> => {
		const options = typeof optionsOrCb === "function" ? {} : optionsOrCb;
		const callback = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb!;
		if (options.ifAvailable && held.has(name)) {
			return (await callback(null)) as Awaited<T>;
		}
		held.add(name);
		try {
			return (await callback({ name, mode: options.mode ?? "exclusive" })) as Awaited<T>;
		} finally {
			held.delete(name);
		}
	};
	return { request: request as NonNullable<PluginStartOpenOptions["locks"]>["request"] };
}

const UNTRIMMED_PROMPT = "  \n\t 插件修复请求：保留首尾空白与 CRLF \r\n 雪🙂 \ud83d\ude80  \n ";

describe("W2 legacy plugin startChat host integration (#570 + #584)", () => {
	it("checkpoints intent + begin synchronously before returning true or sending any effect, preserving untrimmed prompt, option presence, and pluginId", async () => {
		installPluginHostApi(null);
		const storage = memoryStorage();
		const locks = createLocks();
		let cwd = "/workspace/initial";
		let convId = "c-initial";
		let sessionId = "s-initial";
		let blank = false;
		let currentModel = "anthropic/claude-sonnet-4";
		let owner: PluginStartOwner | null = null;

		const openRes = await openPluginStartCheckpoint({
			ownerId: "owner-1",
			storage,
			locks,
			getSource: () => ({
				ownerId: "owner-1",
				sessionId,
				conversationId: convId,
				pluginId: getPluginApiCaller(),
			}),
		});
		expect(openRes.ok).toBe(true);
		if (!openRes.ok) throw new Error("expected owner");
		owner = openRes.owner;

		const events: string[] = [];
		const sent: unknown[] = [];
		const admitted: Array<{
			msg: { type: "prompt"; text: string; id: string; forSession?: string };
			binding: { conversationId: string; sessionId: string };
		}> = [];

		const api = createPluginHostApi({
			send: (msg) => {
				// At the exact moment the first outbound transition is sent, both intent and begin must already be in localStorage.
				if (events.length === 0) {
					const cat = catalogPluginStarts(storage);
					expect(cat.complete).toBe(true);
					const intentEntries = cat.entries.filter((e) => e.kind === "intent");
					expect(intentEntries).toHaveLength(1);
					expect(intentEntries[0]?.possibleEffects).toBe(true);
					expect(intentEntries[0]?.intent?.original.prompt).toBe(UNTRIMMED_PROMPT);
					expect(intentEntries[0]?.intent?.source.pluginId).toBe("legado-web");
				}
				events.push(`send:${msg.type}`);
				sent.push(msg);
				if (msg.type === "set_cwd") {
					setTimeout(() => {
						cwd = msg.path;
					}, 2);
				} else if (msg.type === "new_chat") {
					setTimeout(() => {
						convId = "c-new";
						sessionId = "s-new";
						blank = true;
					}, 2);
				} else if (msg.type === "set_model") {
					setTimeout(() => {
						currentModel = msg.modelId;
					}, 2);
				}
				return true;
			},
			isReady: () => true,
			setView: () => {},
			getCwd: () => cwd,
			getWorkspaceRoots: () => [],
			listSessions: () => [],
			getConversationId: () => convId,
			getSessionId: () => sessionId,
			getStartChatOwner: () => owner,
			isConversationBlank: () => blank,
			listModels: () => [
				{ id: "anthropic/claude-sonnet-4", provider: "anthropic", name: "Sonnet" },
				{ id: "openai/gpt-4o-mini", provider: "openai", name: "GPT-4o mini" },
			],
			getCurrentModelId: () => currentModel,
			pollMs: 1,
			timeoutMs: 100,
			admitPrompt: async (msg, binding) => {
				events.push("admitPrompt");
				admitted.push({ msg, binding });
				return true;
			},
		});
		installPluginHostApi(api);

		const mutableOpts: { prompt: string; cwd?: string; model?: string; newChat?: boolean } = {
			prompt: UNTRIMMED_PROMPT,
			cwd: " /workspace/target ",
			model: " openai/gpt-4o-mini ",
			newChat: undefined,
		};

		let accepted = false;
		const unregister = withPluginScope("legado-web", () =>
			api.onUiAction("fix", () => {
				accepted = api.startChat(mutableOpts);
				// Mutate caller object immediately after synchronous return.
				mutableOpts.prompt = "MUTATED PROMPT";
				mutableOpts.cwd = "/workspace/mutated";
				mutableOpts.model = "anthropic/claude-sonnet-4";
				mutableOpts.newChat = false;
			}),
		);
		expect(await triggerPluginUiAction("legado-web", "fix", "item-1")).toBe(true);
		unregister();
		expect(accepted).toBe(true);

		// Wait for async transitions + admitPrompt to settle.
		await new Promise((r) => setTimeout(r, 40));

		expect(events).toEqual(["send:set_cwd", "send:new_chat", "send:set_model", "admitPrompt"]);
		expect(sent).toEqual([
			{ type: "set_cwd", path: "/workspace/target" },
			{ type: "new_chat" },
			{ type: "set_model", modelId: "openai/gpt-4o-mini" },
		]);
		expect(admitted).toHaveLength(1);
		expect(admitted[0]?.msg.text).toBe(UNTRIMMED_PROMPT);
		expect(admitted[0]?.msg.forSession).toBe("s-new");
		expect(admitted[0]?.binding).toEqual({ conversationId: "c-new", sessionId: "s-new" });

		const cat = catalogPluginStarts(storage);
		const intentEntry = cat.entries.find((e) => e.kind === "intent");
		expect(intentEntry?.intent?.original).toEqual({
			prompt: UNTRIMMED_PROMPT,
			newChat: { presence: "undefined" },
			cwd: { presence: "value", value: " /workspace/target " },
			model: { presence: "value", value: " openai/gpt-4o-mini " },
		});
		expect(intentEntry?.intent?.promptId).toBe(admitted[0]?.msg.id);

		// In the active generation where continuation succeeded, the recovery panel view stays quiet.
		const activeView = computePluginStartRecoveryView({
			storage,
			ownerId: "owner-1",
			ownerGeneration: owner.generation,
			runtimeIssues: api.startChatIssues?.() ?? [],
			failedIntentIds: api.failedStartChatIntentIds?.() ?? [],
		});
		expect(activeView.entries).toHaveLength(0);

		// After reload (new owner generation), the unretired entry is surfaced as recovery-required without auto-replay.
		owner.close();
		await Promise.resolve();
		await Promise.resolve();
		const reloadRes = await openPluginStartCheckpoint({
			ownerId: "owner-1",
			storage,
			locks,
			getSource: () => ({
				ownerId: "owner-1",
				sessionId: "s-new",
				conversationId: "c-new",
				pluginId: null,
			}),
		});
		expect(reloadRes.ok).toBe(true);
		if (!reloadRes.ok) throw new Error("expected reload owner");
		const reloadView = computePluginStartRecoveryView({
			storage,
			ownerId: "owner-1",
			ownerGeneration: reloadRes.owner.generation,
		});
		expect(reloadView.entries).toHaveLength(1);
		expect(reloadView.entries[0]?.intent?.original.prompt).toBe(UNTRIMMED_PROMPT);
		expect(reloadView.entries[0]?.possibleEffects).toBe(true);

		const exported = readPluginStartExport(exportPluginStarts(storage));
		expect(exported.complete).toBe(true);
		expect(exported.entries.find((e) => e.kind === "intent")?.intent?.original.prompt).toBe(UNTRIMMED_PROMPT);
		reloadRes.owner.close();
	});

	it("returns false with zero effects on quota, readback mismatch, corrupt storage, uninitialized owner, not-ready host, unknown model, or invalid options", async () => {
		installPluginHostApi(null);
		const locks = createLocks();

		// 1. Quota failure on intent write
		const quotaStore = memoryStorage({ quotaAt: 1 });
		const quotaOwnerRes = await openPluginStartCheckpoint({
			ownerId: "owner-q",
			storage: quotaStore,
			locks,
			getSource: () => ({ ownerId: "owner-q", sessionId: "s1", conversationId: "c1", pluginId: null }),
		});
		if (!quotaOwnerRes.ok) throw new Error("expected owner");
		const effects: unknown[] = [];
		const quotaApi = createPluginHostApi({
			send: (msg) => {
				effects.push(msg);
				return true;
			},
			isReady: () => true,
			setView: () => {},
			getCwd: () => "/w",
			getWorkspaceRoots: () => [],
			listSessions: () => [],
			getConversationId: () => "c1",
			getSessionId: () => "s1",
			getStartChatOwner: () => quotaOwnerRes.owner,
			isConversationBlank: () => true,
			listModels: () => [{ id: "openai/gpt-4o-mini", provider: "openai", name: "mini" }],
			admitPrompt: async (msg) => {
				effects.push(msg);
				return true;
			},
		});
		const callerInput = { prompt: UNTRIMMED_PROMPT, newChat: false };
		expect(quotaApi.startChat(callerInput)).toBe(false);
		expect(callerInput.prompt).toBe(UNTRIMMED_PROMPT);
		expect(effects).toHaveLength(0);
		expect(quotaApi.lastStartChatResult?.()?.ok).toBe(false);
		quotaOwnerRes.owner.close();

		// 2. Readback mismatch
		const rbStore = memoryStorage({ readbackMismatchAt: 1 });
		const rbOwnerRes = await openPluginStartCheckpoint({
			ownerId: "owner-rb",
			storage: rbStore,
			locks,
			getSource: () => ({ ownerId: "owner-rb", sessionId: "s1", conversationId: "c1", pluginId: null }),
		});
		if (!rbOwnerRes.ok) throw new Error("expected owner");
		const rbApi = createPluginHostApi({
			send: (msg) => {
				effects.push(msg);
				return true;
			},
			isReady: () => true,
			setView: () => {},
			getCwd: () => "/w",
			getWorkspaceRoots: () => [],
			listSessions: () => [],
			getConversationId: () => "c1",
			getSessionId: () => "s1",
			getStartChatOwner: () => rbOwnerRes.owner,
			isConversationBlank: () => true,
		});
		expect(rbApi.startChat({ prompt: "hello" })).toBe(false);
		expect(effects).toHaveLength(0);
		rbOwnerRes.owner.close();

		// 3. Corrupt storage key blocks new checkpoint (catalogue-incomplete)
		const corruptStore = memoryStorage();
		const corruptOwnerRes = await openPluginStartCheckpoint({
			ownerId: "owner-c",
			storage: corruptStore,
			locks,
			getSource: () => ({ ownerId: "owner-c", sessionId: "s1", conversationId: "c1", pluginId: null }),
		});
		if (!corruptOwnerRes.ok) throw new Error("expected owner");
		corruptStore.setItem(`${PLUGIN_START_PREFIX}intent:owner-c:bad`, "{not-json");
		const corruptApi = createPluginHostApi({
			send: (msg) => {
				effects.push(msg);
				return true;
			},
			isReady: () => true,
			setView: () => {},
			getCwd: () => "/w",
			getWorkspaceRoots: () => [],
			listSessions: () => [],
			getConversationId: () => "c1",
			getSessionId: () => "s1",
			getStartChatOwner: () => corruptOwnerRes.owner,
			isConversationBlank: () => true,
			listModels: () => [{ id: "openai/gpt-4o-mini", provider: "openai", name: "mini" }],
		});
		expect(corruptApi.startChat({ prompt: "hello" })).toBe(false);
		expect(corruptApi.lastStartChatResult?.()).toMatchObject({ ok: false, code: "catalogue-incomplete" });
		// Unknown model rejected before checkpoint
		corruptStore.removeItem(`${PLUGIN_START_PREFIX}intent:owner-c:bad`);
		expect(corruptApi.startChat({ prompt: "hello", model: "unknown/model" })).toBe(false);
		expect(corruptApi.lastStartChatResult?.()).toMatchObject({
			ok: false,
			code: "invalid-input",
			checkpointMayExist: false,
		});
		expect(corruptStore.values.size).toBe(0);
		corruptOwnerRes.owner.close();

		// 4. Null owner / not-ready host
		const nullOwnerApi = createPluginHostApi({
			send: (msg) => {
				effects.push(msg);
				return true;
			},
			isReady: () => true,
			setView: () => {},
			getCwd: () => "/w",
			getWorkspaceRoots: () => [],
			listSessions: () => [],
			getConversationId: () => "c1",
			getSessionId: () => "s1",
			getStartChatOwner: () => null,
			isConversationBlank: () => true,
		});
		expect(nullOwnerApi.startChat({ prompt: "hello" })).toBe(false);
		expect(effects).toHaveLength(0);
	});

	it("aborts continuation and surfaces recovery-required when newChat:false session drifts or a transition/admitPrompt fails", async () => {
		installPluginHostApi(null);
		const storage = memoryStorage();
		const locks = createLocks();
		let cwd = "/workspace/a";
		let convId = "c-origin";
		let sessionId = "s-origin";

		const ownerRes = await openPluginStartCheckpoint({
			ownerId: "owner-drift",
			storage,
			locks,
			getSource: () => ({ ownerId: "owner-drift", sessionId, conversationId: convId, pluginId: null }),
		});
		if (!ownerRes.ok) throw new Error("expected owner");

		const admitted: unknown[] = [];
		const api = createPluginHostApi({
			send: (msg) => {
				if (msg.type === "set_cwd") {
					// Simulate conversation/session drifting while set_cwd is in flight for newChat:false.
					setTimeout(() => {
						cwd = msg.path;
						convId = "c-drifted";
						sessionId = "s-drifted";
					}, 2);
				}
				return true;
			},
			isReady: () => true,
			setView: () => {},
			getCwd: () => cwd,
			getWorkspaceRoots: () => [],
			listSessions: () => [],
			getConversationId: () => convId,
			getSessionId: () => sessionId,
			getStartChatOwner: () => ownerRes.owner,
			isConversationBlank: () => false,
			pollMs: 1,
			timeoutMs: 30,
			admitPrompt: async (msg) => {
				admitted.push(msg);
				return true;
			},
		});

		expect(api.startChat({ prompt: UNTRIMMED_PROMPT, cwd: "/workspace/b", newChat: false })).toBe(true);
		await new Promise((r) => setTimeout(r, 25));

		// Prompt must NOT be sent into the drifted conversation/session.
		expect(admitted).toHaveLength(0);
		expect(api.failedStartChatIntentIds?.()).toHaveLength(1);
		expect(api.startChatIssues?.().some((i) => i.code === "continuation-failed")).toBe(true);

		const view = computePluginStartRecoveryView({
			storage,
			ownerId: "owner-drift",
			ownerGeneration: ownerRes.owner.generation,
			runtimeIssues: api.startChatIssues?.() ?? [],
			failedIntentIds: api.failedStartChatIntentIds?.() ?? [],
		});
		expect(view.entries).toHaveLength(1);
		expect(view.entries[0]?.intent?.original.prompt).toBe(UNTRIMMED_PROMPT);
		ownerRes.owner.close();
	});
});
