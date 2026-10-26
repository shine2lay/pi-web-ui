import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	buildSessionProjection,
	createEventBus,
	discoverAndLoadExtensions,
	ExtensionRunner,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
	BuildSystemPromptOptions,
	ExtensionActions,
	ExtensionContextActions,
	LoadExtensionsResult,
	ToolDefinition,
	ExtensionUIContext,
	SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, Api, ProviderResponse } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, GenerationTask, hook, section, ToolTask } from "@earendil-works/pi-durable";
import type {
	AgentEvent,
	Conversation,
	ConversationId,
	Extension,
	ToolExecutionResult,
	ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ToolGuardHook } from "../agent-service.js";
import type { DurableModelSetup } from "./models-adapter.js";
import { DurableSessionState, jsonValue } from "./session-state.js";

import { configuredExtensionPaths, isClassicBillionContext } from "./addon-resources.js";
import { resolveNativeContextModule } from "./native-context-loader.js";
export { configuredExtensionPaths } from "./addon-resources.js";

export type DurableExtensionMode = NonNullable<Parameters<ExtensionRunner["setUIContext"]>[1]>;

export interface AddonBridgeOptions {
	cwd: string;
	agentDir: string;
	state: DurableSessionState;
	models: DurableModelSetup;
	pluginTools?: readonly (ToolDefinition | AgentTool)[];
	/** Base durable registrations, not rewrapped SDK tools. Their caller/deferred policy stays native. */
	nativeTools?: readonly ToolRegistration[];
	/** A fresh loader result can be supplied by the host; never share a live runner between conversations. */
	extensions?: LoadExtensionsResult;
	extensionPaths?: string[];
	nativeBillionContext?: boolean;
	/** Reuse the host's real native dialogs; do not pretend a headless session can approve things. */
	extensionUI?: ExtensionUIContext;
	extensionMode?: DurableExtensionMode;
	identityId?: string;
	/** Hydrate persisted choices before session_start, so pool startup hooks see the actual model. */
	model?: Model<Api>;
	thinkingLevel?: ReturnType<ExtensionActions["getThinkingLevel"]>;
	activeTools?: readonly string[];
	disabledTools?: readonly string[];
	toolGuard?: ToolGuardHook;
	lang?: string;
	instructions?: string;
	onModelChange?(model: Model<Api>): void;
	onToolsChange?(tools: readonly ToolRegistration[]): void;
	onMessage?(message: unknown): void;
	onError?(error: Error): void;
	onShutdown?(): void;
	executeTool?: ExtensionContextActions["executeTool"];
}

/** Reuse the real SDK extension runner, not reimplementations of identity/queue/guard policy. */
export class DurableAddonBridge {
	readonly runner: ExtensionRunner;
	readonly extension: Extension;
	private readonly tools = new Map<string, ToolDefinition>();
	private active = new Set<string>();
	private allowed: Set<string> | undefined;
	private disabled = new Set<string>();
	private model: Model<Api> | undefined;
	private instructions: string;
	private signal: AbortSignal | undefined;
	private running = false;
	private pendingMessages: { message: AgentMessage; steer: boolean }[] = [];
	private readonly errors: Error[] = [];
	private registeredCount = 0;
	private turnIndex = 0;
	private thinking: ReturnType<ExtensionActions["getThinkingLevel"]> = "off";

	private constructor(
		readonly options: AddonBridgeOptions,
		loaded: LoadExtensionsResult,
	) {
		this.instructions = options.instructions ?? "";
		this.model = options.model;
		this.thinking = options.thinkingLevel ?? "off";
		this.runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			options.cwd,
			options.state.sessionManager,
			options.models.modelRegistry,
		);
		if (options.extensionUI) this.runner.setUIContext(options.extensionUI, options.extensionMode ?? "rpc");
		this.runner.onError((error) => {
			const failure = new Error(`Durable extension ${error.event ?? "handler"}: ${error.error}`);
			this.errors.push(failure);
			options.onError?.(failure);
		});
		for (const tool of options.pluginTools ?? []) this.tools.set(tool.name, tool);
		for (const registered of this.runner.getAllRegisteredTools())
			this.tools.set(registered.definition.name, registered.definition);
		this.active = new Set([
			...(options.nativeTools
				? options.nativeTools
						.filter(
							(tool) =>
								!this.tools.has(tool.name) && !tool.deferred && (!tool.callers || tool.callers.includes("model")),
						)
						.map((tool) => tool.name)
				: ["bash", "read", "write", "edit", "grep", "find", "ls"]),
			...[...this.tools.values()]
				.filter(
					(tool) =>
						(!tool.exposure || tool.exposure === "direct" || tool.exposure === "model-only") &&
						tool.defaultActive !== false,
				)
				.map((tool) => tool.name),
		]);
		if (options.activeTools) {
			this.active = new Set(options.activeTools);
			this.allowed = new Set(options.activeTools);
		}
		this.disabled = new Set(options.disabledTools ?? []);
		const settings = SettingsManager.create(options.cwd, options.agentDir);
		const actions: ExtensionActions = {
			sendMessage: (message, sendOptions) => {
				options.onMessage?.(message);
				this.pendingMessages.push({
					message: {
						role: "custom",
						customType: message.customType,
						content: message.content,
						display: message.display,
						details: message.details,
						timestamp: Date.now(),
					},
					steer: sendOptions?.deliverAs === "steer",
				});
			},
			sendUserMessage: (content, sendOptions) => {
				this.pendingMessages.push({
					message: { role: "user", content, timestamp: Date.now() },
					steer: sendOptions?.deliverAs === "steer",
				});
			},
			appendEntry: (type, data) => options.state.appendEntry(type, data),
			setSessionName: (name) => options.state.setName(name),
			getSessionName: () => options.state.sessionManager.getSessionName(),
			setLabel: (id, label) => options.state.sessionManager.appendLabelChange(id, label),
			getActiveTools: () => this.activeTools,
			getAllTools: () =>
				[
					...(options.nativeTools ?? [])
						.filter((tool) => !this.tools.has(tool.name))
						.map((tool) => ({
							...tool,
							exposure: tool.deferred
								? ("deferred" as const)
								: tool.callers && !tool.callers.includes("model")
									? ("hidden" as const)
									: tool.callers && !tool.callers.includes("tools")
										? ("model-only" as const)
										: ("direct" as const),
						})),
					...this.tools.values(),
				].map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					exposure: tool.exposure ?? "direct",
					sourceInfo: { path: this.options.agentDir, source: "durable-host", scope: "user", origin: "top-level" },
				})),
			getSettings: () => settings.getSettings(),
			setActiveTools: (names) => {
				this.active = new Set(names);
			},
			refreshTools: () => {
				this.refreshTools();
			},
			getCommands: () => [],
			setModel: async (model) => {
				this.model = model;
				options.onModelChange?.(model);
				return true;
			},
			getThinkingLevel: () => this.thinking,
			setThinkingLevel: (level) => {
				this.thinking = level;
			},
		};
		this.runner.bindCore(
			actions,
			{
				getModel: () => this.model,
				getScopedModels: () => [],
				isIdle: () => !this.running,
				isProjectTrusted: () => true,
				getSignal: () => this.signal,
				abort: () => options.onShutdown?.(),
				hasPendingMessages: () => this.pendingMessages.length > 0,
				shutdown: () => options.onShutdown?.(),
				getContextUsage: () => undefined,
				compact: () => {
					throw new Error("SDK compaction requires the durable context extension; no silent compaction fallback");
				},
				getSystemPrompt: () => this.instructions,
				getSystemPromptOptions: () => this.promptOptions(),
				executeTool: options.executeTool,
			},
			{
				registerProvider: (name, config) => options.models.registerProvider(name, config),
				registerNativeProvider: (provider) => options.models.registerNativeProvider(provider),
				unregisterProvider: (name) => options.models.unregisterProvider(name),
			},
		);
		this.extension = defineExtension({
			name: `pi_addon_bridges_${options.state.conversation.id}`,
			sections: [section("pi_addons", () => this.instructions, { tag: false })],
			hooks: [
				hook(ToolTask, {
					beforeTool: async (call) => {
						const input = { ...call.arguments };
						const decision = await this.runner.emitToolCall({
							type: "tool_call",
							toolName: call.name,
							toolCallId: call.id,
							input,
						});
						await this.flush(); // A broken policy handler must not silently allow a command.
						if (decision?.block) return { block: decision.reason ?? "Tool execution was blocked" };
						if (this.options.toolGuard && (call.name === "bash" || call.name === "read")) {
							const guarded = await this.options.toolGuard.pre(
								{
									toolName: call.name,
									params: input,
									conversationId: this.options.state.sessionManager.getSessionId(),
								},
								this.options.lang ?? "en",
							);
							if (guarded.verdict.decision !== "allow")
								return {
									block:
										guarded.verdict.reasonEn ??
										guarded.verdict.reason ??
										`Plugin ${guarded.pluginId ?? "guard"} requires approval`,
								};
						}
						return { arguments: jsonValue(input) as import("@earendil-works/pi-durable").JsonObject };
					},
					afterTool: async (call, result) => {
						let content = result.output ?? [];
						if (this.options.toolGuard && (call.name === "bash" || call.name === "read")) {
							const guarded = await this.options.toolGuard.post(
								{
									toolName: call.name,
									params: call.arguments,
									conversationId: this.options.state.sessionManager.getSessionId(),
									result: { content, isError: result.isError },
								},
								this.options.lang ?? "en",
							);
							if (guarded?.content) content = guarded.content as typeof content;
						}
						const changed = await this.runner.emitToolResult({
							type: "tool_result",
							toolName: call.name,
							toolCallId: call.id,
							input: call.arguments,
							content: content as never,
							details: result.details,
							isError: !!result.isError,
						});
						const next = {
							...result,
							output: (changed?.content ?? content) as ToolExecutionResult["output"],
							details: jsonValue(changed?.details ?? result.details),
							isError: changed?.isError ?? result.isError,
						};
						await this.flush();
						return next;
					},
				}),
				hook(GenerationTask, {
					beforeRequest: async (request) => {
						const messages = await this.runner.emitContext(request.messages as Message[]);
						await this.flush();
						return { messages: messages as typeof request.messages };
					},
				}),
			],
		});
	}

	static async create(options: AddonBridgeOptions): Promise<DurableAddonBridge> {
		let loaded =
			options.extensions ??
			(await discoverAndLoadExtensions(
				options.extensionPaths ??
					configuredExtensionPaths(options.agentDir, { nativeBillionContext: options.nativeBillionContext }),
				options.cwd,
				options.agentDir,
				createEventBus(),
			));
		if (options.nativeBillionContext)
			loaded = {
				...loaded,
				extensions: loaded.extensions.filter((extension) => !isClassicBillionContext(extension.path)),
				errors: loaded.errors.filter((error) => !isClassicBillionContext(error.path)),
			};
		if (loaded.errors.length)
			throw new Error(
				`Durable add-on load failed: ${loaded.errors.map((error) => `${error.path}: ${error.error}`).join("; ")}`,
			);
		const bridge = new DurableAddonBridge(options, loaded);
		if (
			options.identityId &&
			!options.state.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "identity")
		)
			options.state.appendEntry("identity", { v: 1, id: options.identityId, via: "queue" });
		await bridge.runner.emit({ type: "session_start", reason: "startup" });
		bridge.refreshTools();
		await bridge.flush();
		return bridge;
	}
	private refreshTools(): void {
		for (const registered of this.runner.getAllRegisteredTools()) {
			const tool = registered.definition;
			if (!this.tools.has(tool.name)) this.active.add(tool.name);
			this.tools.set(tool.name, tool);
		}
		if (this.tools.size !== this.registeredCount) {
			this.registeredCount = this.tools.size;
			this.options.onToolsChange?.(this.toolRegistrations());
		}
	}
	toolRegistrations(): ToolRegistration[] {
		return [...this.tools.values()].map((tool) =>
			defineTool({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				replay: "unsafe",
				executionMode: tool.executionMode,
				prepareArguments: tool.prepareArguments,
				...(tool.outputSchema ? { structuredOutputSchema: tool.outputSchema } : {}),
				...(tool.exposure === "hidden" || tool.exposure === "codemode"
					? { callers: ["tools"] as const }
					: tool.exposure === "model-only"
						? { callers: ["model"] as const }
						: {}),
				...(tool.exposure === "deferred" ? { deferred: true as const } : {}),
				execute: async (args, api, context) => {
					const output = await tool.execute(
						api.callId,
						args,
						context.abortSignal,
						(partial) => {
							for (const item of partial.content) if (item.type === "text") api.output(item.text);
						},
						this.runner.createToolContext(api.callId, context.abortSignal),
					);
					return {
						output: output.content as ToolExecutionResult["output"],
						details: jsonValue(output.details),
						isError: output.isError,
						...(tool.outputSchema && "structuredContent" in output
							? { structuredOutput: jsonValue(output.structuredContent) }
							: {}),
						usage: output.usage,
						...(output.terminate ? { control: { terminate: true } } : {}),
					};
				},
			}),
		);
	}
	private promptOptions(): BuildSystemPromptOptions {
		return {
			cwd: this.options.cwd,
			selectedTools: this.activeTools,
			forceSystemPrompt: this.options.instructions ?? "",
		};
	}
	get activeTools(): string[] {
		return [...this.active].filter((name) => !this.disabled.has(name) && (!this.allowed || this.allowed.has(name)));
	}
	get callableTools(): string[] {
		return [
			...new Set([
				...this.active,
				...(this.options.nativeTools ?? [])
					.filter(
						(tool) =>
							!this.tools.has(tool.name) && (tool.deferred || (tool.callers && !tool.callers.includes("model"))),
					)
					.map((tool) => tool.name),
				...[...this.tools.values()]
					.filter((tool) => ["codemode", "hidden", "deferred"].includes(tool.exposure ?? "direct"))
					.map((tool) => tool.name),
			]),
		].filter((name) => !this.disabled.has(name) && (!this.allowed || this.allowed.has(name)));
	}
	setActiveTools(names: readonly string[]): void {
		this.active = new Set(names);
		this.allowed = new Set(names);
		this.disabled.clear();
	}
	get injectedInstructions(): string {
		return this.instructions;
	}
	async providerPayload(payload: unknown): Promise<unknown> {
		const next = await this.runner.emitBeforeProviderRequest(payload);
		await this.flush();
		return next;
	}
	async providerHeaders(headers: Record<string, string | null>): Promise<Record<string, string | null>> {
		const next = await this.runner.emitBeforeProviderHeaders(headers);
		await this.flush();
		return next;
	}
	async providerResponse(response: ProviderResponse, _model: Model<Api>): Promise<void> {
		await this.runner.emit({ type: "after_provider_response", status: response.status, headers: response.headers });
		await this.flush();
	}
	async event(event: AgentEvent): Promise<void> {
		if (event.type === "turn_start")
			await this.runner.emit({ type: "turn_start", turnIndex: this.turnIndex++, timestamp: Date.now() });
		if (event.type === "turn_end") {
			await this.options.state.sync();
			const messages = this.options.state.sessionManager.getBranch().filter((entry) => entry.type === "message");
			const last = messages.findLast((entry) => entry.message.role === "assistant");
			if (last)
				await this.boundary({
					type: "turn_end",
					turnIndex: this.turnIndex - 1,
					message: last.message,
					toolResults: [],
					messageEntryId: last.id,
					toolResultEntryIds: [],
					outcome: "completed",
				});
		}
		if (event.type === "message_end")
			for (const message of event.entry.model ?? []) await this.runner.emit({ type: "message_end", message } as never);
		if (event.type === "tool_execution_start")
			await this.runner.emit({
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			});
		if (event.type === "tool_execution_end") {
			const message = event.entry?.model?.find((item) => item.role === "toolResult");
			await this.runner.emit({
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: { content: message?.role === "toolResult" ? message.content : [], details: event.entry?.data },
				isError: message?.role === "toolResult" ? message.isError : (event.result?.isError ?? true),
			} as never);
		}
		await this.flush();
	}
	get thinkingLevel(): ReturnType<ExtensionActions["getThinkingLevel"]> {
		return this.thinking;
	}
	setThinkingLevel(level: ReturnType<ExtensionActions["getThinkingLevel"]>): void {
		this.thinking = level;
	}
	get selectedModel(): Model<Api> | undefined {
		return this.model;
	}
	setModel(model: Model<Api> | undefined): void {
		this.model = model;
	}
	async prepare(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
		this.signal = signal;
		await this.options.state.sync();
		const result = await this.runner.emitInput(prompt, undefined, "interactive");
		await this.flush();
		if (result.action === "handled") return undefined;
		const text = result.action === "transform" ? result.text : prompt;
		const start = await this.runner.emitBeforeAgentStart(text, undefined, this.promptOptions());
		for (const message of start.messages) await this.appendBoundary({ type: "custom_message", ...message });
		this.instructions = start?.systemPromptOptions?.forceSystemPrompt ?? this.options.instructions ?? "";
		if (start?.systemPromptOptions?.selectedTools) this.active = new Set(start.systemPromptOptions.selectedTools);
		this.running = true;
		await this.runner.emit({ type: "agent_start" });
		await this.flush();
		return text;
	}
	private async boundary(event: Parameters<ExtensionRunner["emitBoundary"]>[0]): Promise<boolean> {
		const manager = this.options.state.sessionManager;
		const result = await this.runner.emitBoundary(event, (drafts) => {
			const entries = [...manager.getEntries()];
			for (const [n, draft] of drafts.entries()) {
				if (draft.type === "compaction" || draft.type === "context_edit")
					throw new Error(`SDK boundary ${draft.type} needs a durable context-edit adapter`);
				entries.push({
					...draft,
					id: `boundary-${n}`,
					parentId: entries.at(-1)?.id ?? null,
					timestamp: new Date().toISOString(),
				});
			}
			const projection = buildSessionProjection(entries);
			return {
				contextEntries: projection.entries,
				contextMessages: projection.messages,
				llmMessages: projection.messages.filter((message): message is Message => message.role !== "custom"),
				pendingMessages: this.pendingMessages.map((item) => item.message),
				canContinue: !this.signal?.aborted,
			};
		});
		for (const draft of result.entries) await this.appendBoundary(draft);
		await this.flush();
		return result.continue;
	}
	private async appendBoundary(draft: SessionBoundaryDraft): Promise<void> {
		if (draft.type === "custom") this.options.state.appendEntry(draft.customType, draft.data);
		else if (draft.type === "custom_message") {
			await this.options.state.conversation.commit(async (tx) => {
				await tx.appendEntry(this.options.state.conversation.id, {
					kind: "app.pi.extension_message",
					data: jsonValue(draft),
					model: [{ role: "user", content: draft.content, timestamp: Date.now() }],
				});
			}, BACKGROUND_CONTEXT);
		} else throw new Error(`SDK boundary ${draft.type} needs a durable context-edit adapter`);
	}
	async settled(messages: AgentMessage[], outcome: "completed" | "aborted" | "error" = "completed"): Promise<boolean> {
		this.running = false;
		await this.options.state.sync();
		await this.runner.emit({ type: "agent_end", messages });
		const continuation = await this.boundary({ type: "agent_before_settle", outcome });
		// Pool failover is not final settlement: the queue must not finish the task yet.
		if (!continuation) await this.runner.emit({ type: "agent_settled" });
		else this.running = true;
		await this.flush();
		return continuation;
	}
	async persistMessage(message: Extract<AgentMessage, { role: "custom" }>): Promise<void> {
		await this.appendBoundary({
			type: "custom_message",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
		});
	}
	takeMessages(): { message: AgentMessage; steer: boolean }[] {
		return this.pendingMessages.splice(0);
	}
	async flush(): Promise<void> {
		await this.options.state.flush();
		if (this.errors.length) throw this.errors.shift();
	}
	async close(): Promise<void> {
		await this.runner.emit({ type: "session_shutdown", reason: "quit" });
		await this.flush();
	}
}

/** Absence before W2 links the package is allowed; broken installed extensions fail loudly. */
export type DurableContextResolver = (
	id: ConversationId,
	context: Parameters<Conversation["context"]>[0],
) => ReturnType<Conversation["context"]>;
export async function loadBillionContextExtension(
	agentDir: string,
	context?: DurableContextResolver,
): Promise<Extension | undefined> {
	const entry = resolveNativeContextModule(agentDir);
	if (entry === undefined) return undefined;
	// Never turn an installed adapter's import, dependency or factory error into "package absent".
	const module = (await import(entry)) as {
		default?: Extension | (() => Extension | Promise<Extension>);
		createDurableExtension?: (options: { context: DurableContextResolver }) => Extension | Promise<Extension>;
	};
	const extension = module.createDurableExtension
		? await module.createDurableExtension({
				context:
					context ??
					(() => {
						throw new Error("Durable context resolver is not bound");
					}),
			})
		: typeof module.default === "function"
			? await module.default()
			: module.default;
	if (!extension || typeof extension !== "object" || typeof extension.name !== "string" || !extension.name)
		throw new Error("billion-context-pi/durable exports no durable extension");
	return extension;
}
