import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { normalizeContext as normalizeSDKContext } from "@earendil-works/pi-ai";
import type {
	AssistantMessageEventStream,
	CredentialStore,
	Provider,
	ProviderResponse,
	ProviderHeaders,
	AnyModel,
	Model,
	Api,
} from "@earendil-works/pi-ai";
import type { HarnessOptions, ModelRef } from "@earendil-works/pi-durable";

// Do not import Models from the top-level pi-ai: its TranscriptContext brand is 1.0.1.
export type DurableModels = Exclude<HarnessOptions["models"], () => unknown>;
export type DurableProvider = ReturnType<DurableModels["getProviders"]>[number];
type MutableModels = DurableModels & { setProvider(provider: DurableProvider): void; deleteProvider(id: string): void };
type DurableModel = ReturnType<DurableModels["getModels"]>[number];

function packageRoot(name: string, from: string): string {
	for (let at = from; ; at = dirname(at)) {
		const candidate = join(at, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return candidate;
		if (dirname(at) === at) break;
	}
	throw new Error(`Missing durable dependency ${name} (searched from ${from})`);
}

/** Resolve import-only exports relative to durable, including its private pi-ai copy. */
export async function loadDurablePeerModule<T = unknown>(name: string, subpath = ""): Promise<T> {
	const durableRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-durable"))));
	const root = packageRoot(name, durableRoot);
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		exports?: Record<string, unknown>;
		main?: string;
	};
	const key = subpath ? `./${subpath}` : ".";
	let entry = manifest.exports?.[key];
	let wildcard: string | undefined;
	if (entry === undefined) {
		for (const [pattern, value] of Object.entries(manifest.exports ?? {})) {
			const [prefix, suffix] = pattern.split("*");
			if (suffix !== undefined && key.startsWith(prefix!) && key.endsWith(suffix)) {
				wildcard = key.slice(prefix!.length, suffix ? -suffix.length : undefined);
				entry = value;
				break;
			}
		}
	}
	const choose = (value: unknown): string | undefined => {
		if (typeof value === "string") return value;
		if (!value || typeof value !== "object") return undefined;
		const conditions = value as Record<string, unknown>;
		return choose(conditions.node) ?? choose(conditions.import) ?? choose(conditions.default);
	};
	const target = choose(entry) ?? (!subpath ? manifest.main : undefined);
	if (!target) throw new Error(`${name} does not export ${key} for Node imports`);
	return import(
		pathToFileURL(resolve(root, wildcard === undefined ? target : target.replaceAll("*", wildcard))).href
	) as Promise<T>;
}

export interface DurableRequestHooks {
	onPayload(payload: unknown): Promise<unknown>;
	onResponse(response: ProviderResponse, model: Model<Api>): Promise<void>;
	transformHeaders(headers: Record<string, string | null>): Promise<Record<string, string | null>>;
}

export interface DurableModelSetup {
	models: DurableModels;
	setRequestHooks?(sessionId: string, hooks: DurableRequestHooks | undefined): void;
	modelRegistry: ModelRegistry;
	registerProvider(name: string, config: ProviderConfig): void;
	registerNativeProvider(provider: Provider): void;
	unregisterProvider(name: string): void;
}

export async function setupDurableModels(
	agentDir = join(homedir(), ".pi", "agent"),
	options: { modelRegistry?: ModelRegistry } = {},
): Promise<DurableModelSetup> {
	// Reuse coding-agent's cross-process locked auth store: OAuth refreshes must not clobber another chat.
	const sdkRoot = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
	const { AuthStorage } = (await import(pathToFileURL(join(sdkRoot, "core", "auth-storage.js")).href)) as {
		AuthStorage: { create(path: string): CredentialStore };
	};
	const credentials = AuthStorage.create(join(agentDir, "auth.json"));
	const { createModels } = await loadDurablePeerModule<{
		createModels(options: { credentials: CredentialStore }): MutableModels;
	}>("@earendil-works/pi-ai", "models");
	const { createAssistantMessageEventStream } = await loadDurablePeerModule<{
		createAssistantMessageEventStream(): ReturnType<DurableProvider["streamSimple"]>;
	}>("@earendil-works/pi-ai");
	const relay = (source: AssistantMessageEventStream, model: Model<Api>) => {
		const output = createAssistantMessageEventStream();
		void (async () => {
			try {
				for await (const event of source) output.push(event);
				output.end(await source.result());
			} catch (error) {
				output.push({
					type: "error",
					reason: "error",
					error: {
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						stopReason: "error",
						errorMessage: error instanceof Error ? error.message : String(error),
						timestamp: Date.now(),
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				});
			} finally {
				output.end();
			}
		})();
		return output;
	};
	const { builtinProviders } = await loadDurablePeerModule<{ builtinProviders(): DurableProvider[] }>(
		"@earendil-works/pi-ai",
		"providers/all",
	);
	const models = createModels({ credentials });
	const requestHooks = new Map<string, DurableRequestHooks>();
	const streamSimple = models.streamSimple.bind(models);
	models.streamSimple = (model, context, options) => {
		const hooks = options?.sessionId ? requestHooks.get(options.sessionId) : undefined;
		if (!hooks) return streamSimple(model, context, options);
		return streamSimple(model, context, {
			...options,
			onPayload: async (payload, selected) =>
				hooks.onPayload((await options?.onPayload?.(payload, selected)) ?? payload),
			onResponse: async (response, selected) => {
				await options?.onResponse?.(response, selected);
				await hooks.onResponse(response, selected);
			},
			transformHeaders: async (headers) =>
				hooks.transformHeaders((await options?.transformHeaders?.(headers)) ?? headers),
		});
	};
	const builtins = builtinProviders();
	for (const provider of builtins) models.setProvider(provider);
	const modelRegistry =
		options.modelRegistry ??
		new ModelRegistry(
			await ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: join(agentDir, "models.json"),
				modelsStorePath: join(agentDir, "models-store.json"),
				allowModelNetwork: false,
			}),
		);
	const { ModelConfig } = (await import(pathToFileURL(join(sdkRoot, "core", "model-config.js")).href)) as {
		ModelConfig: { load(path: string): Promise<{ getProvider(id: string): unknown }> };
	};
	const { resolveConfiguredModelHeaders } = (await import(
		pathToFileURL(join(sdkRoot, "core", "provider-composer.js")).href
	)) as {
		resolveConfiguredModelHeaders(
			model: AnyModel,
			config: unknown,
			extension: ProviderConfig | undefined,
			env: Record<string, string>,
		): ProviderHeaders | undefined;
	};
	// Match SDK model-header composition before durable applies request overrides and
	// transformHeaders. Do not nest two authenticated streams: that reverses precedence.
	const getAuth = models.getAuth.bind(models);
	models.getAuth = async (target, overrides) => {
		const resolution = typeof target === "string" ? await getAuth(target, overrides) : await getAuth(target, overrides);
		if (!resolution || typeof target === "string") return resolution;
		const config = await ModelConfig.load(join(agentDir, "models.json"));
		const headers = resolveConfiguredModelHeaders(
			target,
			config.getProvider(target.provider),
			modelRegistry.getRegisteredProviderConfig(target.provider),
			{ ...(resolution.env ?? {}), ...(overrides?.env ?? {}) },
		);
		return { ...resolution, auth: { ...resolution.auth, headers: { ...resolution.auth.headers, ...headers } } };
	};
	const install = (id: string): void => {
		const legacy = modelRegistry.getProvider(id);
		if (!legacy) return;
		const baseId = id.replace(/-\d+$/, "");
		const base = builtins.find((provider) => provider.id === id || provider.id === baseId);
		const catalog = new Map<string, DurableModel>();
		for (const model of base?.getModels() ?? []) catalog.set(model.id, { ...model, provider: id });
		for (const model of legacy.getModels()) catalog.set(model.id, model);
		const config = modelRegistry.getRegisteredProviderConfig(id);
		const customized =
			modelRegistry.getRegisteredNativeProvider(id) || config?.streamSimple || config?.images || config?.classifiers;
		const compatible =
			base && legacy.getModels().every((model) => base.getModels().some((known) => known.api === model.api));
		const stream: DurableProvider["stream"] = (model, context, options) =>
			relay(legacy.stream(model, normalizeSDKContext({ messages: [...context.messages] }), options), model);
		const streamSimple: DurableProvider["streamSimple"] = (model, context, options) =>
			relay(legacy.streamSimple(model, normalizeSDKContext({ messages: [...context.messages] }), options), model);
		if (base && compatible && !customized) {
			models.setProvider({
				...base,
				id,
				name: legacy.name,
				baseUrl: legacy.baseUrl ?? base.baseUrl,
				headers: legacy.headers,
				getModels: () => [...catalog.values()],
				// Keep effective configured API-key/header/OAuth hooks, including subscription aliases.
				auth: { ...base.auth, ...legacy.auth },
			});
		} else {
			// Native/custom providers own their implementation. Normalize at the SDK brand boundary,
			// not by reconstructing a provider from a guessed API factory. Bind prototype methods too.
			models.setProvider(
				new Proxy(legacy, {
					get(target, key) {
						if (key === "stream") return stream;
						if (key === "streamSimple") return streamSimple;
						if (key === "fetchDeferred" && target.fetchDeferred)
							return (...args: Parameters<NonNullable<Provider["fetchDeferred"]>>) =>
								relay(target.fetchDeferred!(...args), args[0]);
						const member = Reflect.get(target, key, target);
						return typeof member === "function" ? member.bind(target) : member;
					},
				}) as unknown as DurableProvider,
			);
		}
	};
	for (const provider of new Set(modelRegistry.getAll().map((model) => model.provider))) install(provider);
	return {
		models,
		modelRegistry,
		setRequestHooks(sessionId, hooks) {
			if (hooks) requestHooks.set(sessionId, hooks);
			else requestHooks.delete(sessionId);
		},
		registerProvider(name, config) {
			modelRegistry.registerProvider(name, config);
			install(name);
		},
		registerNativeProvider(provider) {
			modelRegistry.registerProvider(provider);
			install(provider.id);
		},
		unregisterProvider(name) {
			modelRegistry.unregisterProvider(name);
			models.deleteProvider(name);
		},
	};
}

export function resolveDurableModelChoice(
	id: string | undefined,
	models: readonly { id: string }[],
	fallback?: ModelRef,
): ModelRef | undefined {
	if (!id || id === "default") {
		const first = models[0];
		return first ? resolveDurableModelChoice(first.id, [], fallback) : fallback;
	}
	const slash = id.indexOf("/");
	if (slash > 0 && slash < id.length - 1) return { provider: id.slice(0, slash), modelId: id.slice(slash + 1) };
	const match = models.find((model) => model.id.endsWith(`/${id}`));
	if (match) return resolveDurableModelChoice(match.id, [], fallback);
	if (fallback) return { provider: fallback.provider, modelId: id };
	throw new Error(`Model ${id} needs an explicit provider/model id`);
}

export async function listGlobalAvailableModels(
	_cwd: string,
	agentDir?: string,
): Promise<{ id: string; name: string }[]> {
	const { models } = await setupDurableModels(agentDir);
	return (await models.getAvailable()).map((model) => ({ id: `${model.provider}/${model.id}`, name: model.name }));
}
