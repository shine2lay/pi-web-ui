import { join } from "node:path";
import { homedir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, Harness, ProviderDoc, watchEvents } from "@earendil-works/pi-durable";
import type {
	AgentEventStream,
	Conversation,
	EntryId,
	EntryRecord,
	Extension,
	Harness as HarnessInstance,
	ModelRef,
	Registry,
	Storage,
	UserInput,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ToolGuardHook } from "../agent-service.js";
import type { DurableExtensionMode } from "./addon-bridges.js";
import type { ExtensionActions } from "@earendil-works/pi-coding-agent";
type ThinkingLevel = ReturnType<ExtensionActions["getThinkingLevel"]>;
import { DurableAddonBridge } from "./addon-bridges.js";
import { setupDurableModels, resolveDurableModelChoice } from "./models-adapter.js";
import type { DurableModelSetup } from "./models-adapter.js";
import {
	hasNativeBillionContext,
	hostToolsExtensionName,
	installAddonBridge,
	setupDurableRegistry,
} from "./registry-adapter.js";
import { DurableSessionState, jsonValue, readContextFrom } from "./session-state.js";
import { openDurableStorage } from "./sqlite-storage.js";
import { DurableStreamBridge } from "./stream-bridge.js";
import type { DurableEventSink } from "./stream-bridge.js";
import { WorkspaceSessions } from "./workspace-sessions.js";

export interface DurableDriverOptions {
	dataDir: string;
	agentDir?: string;
	identityId?: string;
	model?: string;
	instructions?: string;
	pluginTools?: readonly (ToolDefinition | AgentTool)[];
	/** W2 must resolve migrated IDs through migration-manifest.json, never by parsing a host UUID. */
	hostSessionId?: string;
	hostSessionIdFor?(durableId: string): string;
	extensionPaths?: string[];
	extensionUI?: ExtensionUIContext;
	extensionMode?: DurableExtensionMode;
	extensions?: readonly Extension[];
	toolGuard?: ToolGuardHook;
	lang?: string;
	/** Offline fixtures and hosts can supply an already constructed, version-correct model runtime. */
	modelSetup?: DurableModelSetup;
	now?: () => number;
	onCustomMessage?(message: unknown): void;
}

/**
 * One workspace WAL with conversation-scoped SDK runners; never opens a JSONL file.
 * Host integration (W2): pass ALL AgentService plugin/MCP tools, the real extension UI,
 * toolGuard, instructions and configured add-on paths. Resolve UUIDs via the migrator's
 * manifest and supply hostSessionIdFor; native numeric IDs are not host conversation IDs.
 * Inspector uses getCallableTools/setActiveTools, not coding-agent private methods.
 * This module neither selects the live engine nor migrates/deploys any conversation.
 */
export class DurableAgentDriver {
	readonly id = "durable";
	readonly name = "Pi Durable Agent";
	readonly capabilities = {
		supportsTreeFork: true,
		supportsHistoryEdit: false,
		supportsToolPromptOverride: false,
		supportsModelSwitch: true,
		supportsThinkingLevels: true,
		supportsAskUser: true,
		supportsSubagents: true,
	};
	readonly agentDir: string;
	private initialization?: Promise<void>;
	private store?: Storage;
	private runtime?: HarnessInstance;
	private registry?: Registry;
	private models?: DurableModelSetup;
	private workspace?: WorkspaceSessions;
	private readonly bridges = new Map<string, { bridge: DurableAddonBridge; providerSession: string }>();
	private readonly preparing = new Map<string, Promise<DurableAddonBridge>>();
	private baseExtensions: Extension[] = [];
	private currentConversationId?: string;
	private modelId?: string;
	private running?: Conversation;
	private watch?: AgentEventStream;
	private timer?: ReturnType<typeof setInterval>;
	private abortRequested = false;
	private closed = false;
	private dbPath?: string;

	constructor(
		readonly cwd: string,
		readonly options: DurableDriverOptions,
	) {
		this.agentDir = options.agentDir ?? join(homedir(), ".pi", "agent");
		this.modelId = options.model;
	}
	get databasePath(): string | undefined {
		return this.dbPath;
	}
	get sessionId(): string | undefined {
		return this.currentConversationId;
	}
	get cachedSessionCount(): number {
		return this.workspace?.cachedCount ?? 0;
	}
	async ensureInitialized(): Promise<void> {
		if (this.closed) throw new Error("Durable driver is closed");
		return (this.initialization ??= this.initialize());
	}
	private async initialize(): Promise<void> {
		const opened = await openDurableStorage(this.options.dataDir, this.cwd);
		this.store = opened.storage;
		this.dbPath = opened.path;
		try {
			this.models = this.options.modelSetup ?? (await setupDurableModels(this.agentDir));
			this.registry = await setupDurableRegistry({
				cwd: this.cwd,
				agentDir: this.agentDir,
				extensions: this.options.extensions,
				context: async (id, ctx) => {
					if (!this.runtime) throw new Error("Durable Harness is not open");
					const conversation = await this.runtime.conversation(id, ctx);
					if (!conversation) throw new Error(`Durable conversation not found: ${id}`);
					return conversation.context(ctx);
				},
			});
			this.baseExtensions = [...this.registry.snapshot().installed()];
			this.runtime = await Harness.open(
				this.store,
				{
					models: this.models.models,
					registry: this.registry,
					env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? this.cwd }),
					...(this.options.now ? { now: this.options.now } : {}),
				},
				BACKGROUND_CONTEXT,
			);
			this.workspace = new WorkspaceSessions(
				this.runtime,
				this.store,
				this.cwd,
				this.options.now,
				(id) => this.options.hostSessionIdFor?.(id) ?? this.options.hostSessionId ?? id,
			);
			// Install all persisted conversation policies BEFORE any submit/resume can schedule work.
			for (const session of await this.workspace.list()) await this.bridge(session.id);
			this.timer = setInterval(() => {
				void this.evictIdle().catch((error: unknown) =>
					console.error("Durable idle eviction failed:", error instanceof Error ? error.message : String(error)),
				);
			}, 60_000);
			this.timer.unref();
		} catch (error) {
			await this.runtime?.close(BACKGROUND_CONTEXT);
			await this.store.close(BACKGROUND_CONTEXT);
			throw error;
		}
	}
	private async bridge(id: string): Promise<DurableAddonBridge> {
		const pending = this.preparing.get(id);
		if (pending) return pending;
		const setup = this.prepareBridge(id).finally(() => {
			this.preparing.delete(id);
		});
		this.preparing.set(id, setup);
		return setup;
	}
	private async prepareBridge(id: string): Promise<DurableAddonBridge> {
		const state = await this.workspace!.state(id);
		const existing = this.bridges.get(id);
		if (existing) return existing.bridge;
		const models = this.models!;
		const configured = await state.conversation.agent(BACKGROUND_CONTEXT);
		const enabled = await state.conversation.commit(
			async (tx) => jsonValue((await tx.doc(AgentDoc, state.conversation.id)).tools),
			BACKGROUND_CONTEXT,
		);
		const bridge = await DurableAddonBridge.create({
			cwd: this.cwd,
			agentDir: this.agentDir,
			state,
			models,
			pluginTools: this.options.pluginTools,
			extensionPaths: this.options.extensionPaths,
			nativeBillionContext: hasNativeBillionContext(this.registry!),
			extensionUI: this.options.extensionUI,
			extensionMode: this.options.extensionMode,
			identityId: this.options.identityId,
			model: configured.model
				? models.modelRegistry.find(configured.model.provider, configured.model.modelId)
				: undefined,
			thinkingLevel: configured.thinkingLevel,
			...(Array.isArray(enabled)
				? { activeTools: enabled.filter((value): value is string => typeof value === "string") }
				: enabled && typeof enabled === "object" && Array.isArray(enabled.remove)
					? { disabledTools: enabled.remove.filter((value): value is string => typeof value === "string") }
					: {}),
			toolGuard: this.options.toolGuard,
			instructions: this.options.instructions,
			lang: this.options.lang,
			onMessage: this.options.onCustomMessage,
			onShutdown: () => {
				void this.abort();
			},
			onToolsChange: () => {},
		});
		installAddonBridge(this.registry!, bridge);
		const providerSession = await state.conversation.commit(
			async (tx) => (await tx.doc(ProviderDoc, state.conversation.id)).sessionId,
			BACKGROUND_CONTEXT,
		);
		models.setRequestHooks?.(providerSession, {
			onPayload: (payload) => bridge.providerPayload(payload),
			onResponse: (response, model) => bridge.providerResponse(response, model),
			transformHeaders: (headers) => bridge.providerHeaders(headers),
		});
		this.bridges.set(id, { bridge, providerSession });
		await state.conversation.configure(
			{
				cwd: this.cwd,
				thinkingLevel: bridge.thinkingLevel,
				...(bridge.selectedModel
					? { model: { provider: bridge.selectedModel.provider, modelId: bridge.selectedModel.id } }
					: {}),
				tools: this.registrations(bridge),
				extensions: [
					...this.baseExtensions,
					this.registry!.snapshot().extension(hostToolsExtensionName(bridge))!,
					bridge.extension,
				],
			},
			BACKGROUND_CONTEXT,
		);
		return bridge;
	}
	async createSession(options: { name?: string; model?: string } = {}): Promise<string> {
		await this.ensureInitialized();
		if (this.running) throw new Error("Cannot replace a running durable session");
		const model = this.modelChoice(options.model ?? this.modelId);
		const conversation = await this.runtime!.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { cwd: this.cwd, extensions: this.baseExtensions, ...(model ? { model } : {}) },
			},
			BACKGROUND_CONTEXT,
		);
		const id = String(conversation.id);
		this.currentConversationId = id;
		await this.bridge(id);
		if (options.name) {
			const state = await this.workspace!.state(id);
			state.setName(options.name);
			await state.flush();
		}
		return id;
	}
	async resumeSession(id: string): Promise<void> {
		await this.ensureInitialized();
		if (this.running) throw new Error("Cannot replace a running durable session");
		await this.bridge(id); // Invalid/missing IDs fail, never silently create an empty chat.
		this.currentConversationId = id;
	}
	async forkSession(id: string, at: EntryId): Promise<string> {
		await this.ensureInitialized();
		if (this.running) throw new Error("Cannot fork a running durable session");
		const fork = await this.workspace!.fork(id, at);
		await this.resumeSession(fork);
		return fork;
	}
	async getSessionState(id = this.currentConversationId): Promise<DurableSessionState> {
		await this.ensureInitialized();
		if (!id) throw new Error("No durable session selected");
		const state = await this.workspace!.state(id);
		await state.sync();
		return state;
	}
	async readContextFrom(after?: EntryId, id = this.currentConversationId): Promise<readonly EntryRecord[]> {
		const state = await this.getSessionState(id);
		return readContextFrom(this.store!, state.conversation.id, after);
	}
	async appendEntry(customType: string, data: unknown): Promise<void> {
		const state = await this.getSessionState();
		state.appendEntry(customType, data);
		await state.flush();
	}
	async listSessions() {
		await this.ensureInitialized();
		return this.workspace!.list();
	}
	async listModels(): Promise<{ id: string; name: string }[]> {
		await this.ensureInitialized();
		return (await this.models!.models.getAvailable()).map((model) => ({
			id: `${model.provider}/${model.id}`,
			name: model.name,
		}));
	}
	private modelChoice(id: string | undefined): ModelRef | undefined {
		const all = this.models!.models.getModels().map((model) => ({ id: `${model.provider}/${model.id}` }));
		return resolveDurableModelChoice(id, all);
	}
	private registrations(bridge: DurableAddonBridge) {
		const names = new Set([...this.baseExtensions.map((extension) => extension.name), hostToolsExtensionName(bridge)]);
		const tools = new Map(
			this.registry!.snapshot()
				.tools()
				.filter((item) => names.has(item.extension.name))
				.map((item) => [item.tool.name, item.tool]),
		);
		return bridge.callableTools
			.map((name) => tools.get(name))
			.filter((tool): tool is NonNullable<typeof tool> => !!tool);
	}
	/** Host inspector adapter: apply persisted disables before sendPrompt, not an SDK-private no-op. */
	async setActiveTools(names: readonly string[]): Promise<void> {
		await this.ensureInitialized();
		if (!this.currentConversationId) throw new Error("No durable session selected");
		const bridge = await this.bridge(this.currentConversationId);
		bridge.setActiveTools(names);
		await (
			await this.workspace!.state(this.currentConversationId)
		).conversation.configure({ tools: this.registrations(bridge) }, BACKGROUND_CONTEXT);
	}
	async getCallableTools() {
		await this.ensureInitialized();
		if (!this.currentConversationId) throw new Error("No durable session selected");
		return this.registrations(await this.bridge(this.currentConversationId));
	}
	async setModel(id: string): Promise<void> {
		await this.ensureInitialized();
		const model = this.modelChoice(id);
		if (!model || !this.models!.models.getModel(model.provider, model.modelId))
			throw new Error(`Unknown durable model: ${id}`);
		this.modelId = id;
		if (this.currentConversationId) {
			const state = await this.getSessionState();
			await state.conversation.configure({ model }, BACKGROUND_CONTEXT);
			(await this.bridge(this.currentConversationId)).setModel(
				this.models!.modelRegistry.find(model.provider, model.modelId),
			);
		}
	}
	async getThinkingLevel(): Promise<ThinkingLevel> {
		return (await (await this.getSessionState()).conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel;
	}
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		const state = await this.getSessionState();
		await state.conversation.configure({ thinkingLevel: level }, BACKGROUND_CONTEXT);
		(await this.bridge(String(state.conversation.id))).setThinkingLevel(level);
	}
	async sendPrompt(
		prompt: string,
		attachments: readonly { type: "image"; data: string; mimeType: string }[] = [],
		sink: DurableEventSink = { onTextDelta() {} },
	): Promise<void> {
		await this.ensureInitialized();
		if (this.running) throw new Error("Durable driver already has a running turn; use a queued input");
		if (!this.currentConversationId) await this.createSession();
		const id = this.currentConversationId!;
		const bridge = await this.bridge(id);
		const state = await this.workspace!.state(id);
		const unpin = this.workspace!.pin(id);
		this.running = state.conversation;
		this.abortRequested = false;
		const stream = new DurableStreamBridge(sink);
		let eventError: unknown;
		try {
			let input: string | undefined = prompt;
			let continuation = false;
			do {
				if (!continuation) input = await bridge.prepare(input ?? "");
				if (input !== undefined) {
					// Refresh dynamically registered extension/host tools before resolving the next generation.
					installAddonBridge(this.registry!, bridge);
					const selected = bridge.selectedModel;
					await state.conversation.configure(
						{
							tools: this.registrations(bridge),
							thinkingLevel: bridge.thinkingLevel,
							...(selected ? { model: { provider: selected.provider, modelId: selected.id } } : {}),
						},
						BACKGROUND_CONTEXT,
					);
					const watch = await watchEvents(this.runtime!, state.conversation.id, BACKGROUND_CONTEXT);
					this.watch = watch;
					watch.start(async (events) => {
						try {
							for (const event of events) {
								stream.accept(event);
								await bridge.event(event);
							}
						} catch (error) {
							eventError = error;
						}
					});
					const content: UserInput = attachments.length ? [{ type: "text", text: input }, ...attachments] : input;
					const submission = await state.conversation.submit(
						{ type: "input", content, ...(continuation ? { entry: { kind: "app.pi.continue" } } : {}) },
						BACKGROUND_CONTEXT,
					);
					if (this.abortRequested) await state.conversation.abort(BACKGROUND_CONTEXT);
					await submission.wait(BACKGROUND_CONTEXT);
					await state.conversation.waitForIdle(BACKGROUND_CONTEXT);
					await watch.stop();
					this.watch = undefined;
					if (eventError) throw eventError;
					await state.sync();
					const messages = stream.entries.flatMap((entry) => [...(entry.model ?? [])]) as AgentMessage[];
					const last = messages.findLast((message) => message.role === "assistant");
					const failed = last?.role === "assistant" && last.stopReason === "error";
					continuation = await bridge.settled(
						messages,
						this.abortRequested ? "aborted" : failed ? "error" : "completed",
					);
					if (failed && !continuation) throw new Error(last.errorMessage ?? "Durable model request failed");
				}
				const pending = bridge.takeMessages();
				input = undefined;
				for (const item of pending) {
					if (item.message.role === "user") {
						const content = item.message.content;
						const text =
							typeof content === "string"
								? content
								: content
										.filter((part) => part.type === "text")
										.map((part) => (part as { text: string }).text)
										.join("\n");
						input = input ? `${input}\n${text}` : text;
					} else if (item.message.role === "custom") await bridge.persistMessage(item.message);
				}
				await state.flush();
				// Continue the existing history after pool failover, never replay the original user input.
				if (continuation && input === undefined) input = "";
			} while (input !== undefined && !this.abortRequested);
			const assistant = stream.entries
				.flatMap((entry) => entry.model ?? [])
				.filter((message) => message.role === "assistant");
			const last = assistant.at(-1);
			sink.onTurnComplete?.({
				costUSD: assistant.reduce((sum, message) => sum + (message.usage?.cost.total ?? 0), 0),
				contextTokens: last ? last.usage.input + last.usage.cacheRead + last.usage.cacheWrite : 0,
				model: last ? `${last.provider}/${last.model}` : (this.modelId ?? "default"),
				aborted: this.abortRequested,
			});
		} catch (error) {
			sink.onError?.(error instanceof Error ? error : new Error(String(error)));
			throw error;
		} finally {
			await this.watch?.stop();
			this.watch = undefined;
			await bridge.flush();
			this.running = undefined;
			unpin();
		}
	}
	async abort(): Promise<void> {
		this.abortRequested = true;
		await this.running?.abort(BACKGROUND_CONTEXT);
	}
	async evictIdle(): Promise<string[]> {
		if (!this.workspace) return [];
		// Scheduler-resumed, sleeping and background tasks need the same guards as sendPrompt.
		const live = await this.runtime!.inspect(BACKGROUND_CONTEXT);
		const protectedIds = new Set([
			...live.tasks.map(({ record }) => String(record.conversationId)),
			...live.submissions.map((submission) => String(submission.conversationId)),
			...this.preparing.keys(),
		]);
		// Owned/background conversations can retain their parent's selected bridge extensions.
		for (const id of [...protectedIds]) {
			const conversation = await this.workspace.conversation(id);
			const agent = await conversation.agent(BACKGROUND_CONTEXT);
			for (const [owner, { bridge }] of this.bridges)
				if (agent.extensions.some((extension) => extension.name === bridge.extension.name)) protectedIds.add(owner);
		}
		const ids = this.workspace.evictIdle(protectedIds);
		for (const id of ids) {
			const item = this.bridges.get(id);
			if (!item) continue;
			await item.bridge.close();
			this.models!.setRequestHooks?.(item.providerSession, undefined);
			for (const extension of this.registry!.snapshot().installed())
				if (extension.name === item.bridge.extension.name || extension.name === hostToolsExtensionName(item.bridge))
					this.registry!.uninstall(extension);
			this.bridges.delete(id);
		}
		return ids;
	}
	async dispose(): Promise<void> {
		if (this.closed) return;
		if (this.timer) clearInterval(this.timer);
		await this.abort();
		await this.watch?.stop();
		for (const { bridge, providerSession } of this.bridges.values()) {
			await bridge.close();
			this.models!.setRequestHooks?.(providerSession, undefined);
		}
		await this.runtime?.close(BACKGROUND_CONTEXT);
		await this.store?.close(BACKGROUND_CONTEXT);
		this.workspace?.clear();
		this.bridges.clear();
		this.closed = true;
	}
}
