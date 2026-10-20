// Same qualified reader/model, with the proven zero-extras session and hard pre-prompt allowance.
import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	cheapestModel,
	isLimitRefusal,
	readerExtensionPaths,
	type DecisionModel,
	type DecisionModelEnv,
} from "./decision-model.js";
import { attachUsageLedger } from "./usage-accounting-ledger.js";
import { BATCH_MODEL, BATCH_PROVIDER, type DecisionBatchControl } from "./decision-batches.js";
import { REQUEST_FRAMING } from "./decision-batch-budget.js";
import { runBoundedCall, type CallDriver, type LifecycleRow, type ReaderIdentity } from "./decision-call-lifecycle.js";
const PROVIDER_HOOKS = new Set([
	"before_provider_headers",
	"before_provider_request",
	"after_provider_response",
	"provider_stream_event",
]);
export function fenceReaderSettings(settings: SettingsManager): void {
	settings.applyOverrides({
		retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
		compaction: { enabled: false },
		cacheWarming: "off",
	});
	// SDK 1.0.1's getter reads global settings rather than overrides. Shadow only this session instance.
	settings.getCacheWarmingMode = () => "off";
}
export function isolateReaderExtensions<T extends { extensions: { path: string; handlers: Map<string, unknown> }[] }>(
	loaded: T,
): T {
	if (!Array.isArray(loaded?.extensions)) throw new Error("unsupported reader extension descriptors");
	let multi = 0;
	let auth = 0;
	const extensions = loaded.extensions.map((extension) => {
		if (typeof extension?.path !== "string" || !(extension.handlers instanceof Map))
			throw new Error("unsupported reader extension descriptor");
		if (extension.path.includes("/pi-multi-pass/") && /\/extensions\/multi-sub\.(?:ts|js)$/.test(extension.path)) {
			multi++;
			return {
				...extension,
				handlers: new Map([...extension.handlers].filter(([event]) => PROVIDER_HOOKS.has(event))),
			};
		}
		if (extension.path.includes("/pi-anthropic-auth/")) {
			auth++;
			return extension;
		}
		throw new Error("unexpected reader extension");
	});
	if (multi !== 1 || auth !== 1) throw new Error("reader auth/registry extensions unavailable");
	return { ...loaded, extensions } as T;
}
export interface ReaderDriverInfo extends ReaderIdentity {
	maxTokens: number;
	messages: number;
	tokens: number;
	prompts: number;
	lifecycleIsolated: boolean;
	sdkRetryEnabled: boolean;
	providerMaxRetries: number;
	compactionEnabled: boolean;
	cacheWarming: string;
}
export function sessionBlock(info: ReaderDriverInfo): string | undefined {
	if (info.provider !== BATCH_PROVIDER || info.id !== BATCH_MODEL || info.thinking !== "medium")
		return "reader identity mismatch";
	if (
		!Number.isSafeInteger(info.maxTokens) ||
		info.maxTokens <= 0 ||
		info.messages !== 0 ||
		info.tokens !== 0 ||
		info.prompts !== 0
	)
		return "reader session is not empty";
	if (
		!info.lifecycleIsolated ||
		info.sdkRetryEnabled !== false ||
		info.providerMaxRetries !== 0 ||
		info.compactionEnabled !== false ||
		info.cacheWarming !== "off"
	)
		return "reader session extras are not fenced";
	return undefined;
}
type SDKSession = Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"];
interface BoundDriver extends CallDriver {
	info(): ReaderDriverInfo;
}
async function openReaderDriver(
	env: DecisionModelEnv,
	system: string,
	thinking: "medium",
	prompt: (session: SDKSession) => Promise<void>,
): Promise<BoundDriver> {
	const settingsManager = SettingsManager.create(env.cwd, env.agentDir);
	fenceReaderSettings(settingsManager);
	const services = await createAgentSessionServices({
		cwd: env.cwd,
		agentDir: env.agentDir,
		settingsManager,
		resourceLoaderOptions: {
			noExtensions: true,
			additionalExtensionPaths: env.extensionPaths ?? readerExtensionPaths(env.agentDir),
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => system,
		},
		modelRuntime: await ModelRuntime.create({
			authPath: join(env.agentDir, "auth.json"),
			modelsPath: join(env.agentDir, "models.json"),
		}),
	});
	fenceReaderSettings(services.settingsManager); // resource loading can reload settings
	const isolated = isolateReaderExtensions(services.resourceLoader.getExtensions());
	services.resourceLoader.getExtensions = () => isolated;
	const choice = cheapestModel(services.modelRuntime.getModels(BATCH_PROVIDER));
	if (!choice || choice.id !== BATCH_MODEL) throw new Error("authorised cheapest Haiku unavailable");
	const model = services.modelRuntime.getModel(BATCH_PROVIDER, choice.id);
	if (!model || model.provider !== BATCH_PROVIDER || model.id !== BATCH_MODEL)
		throw new Error("authorised model unavailable");
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.inMemory(env.cwd),
		model,
		thinkingLevel: thinking,
		noTools: "all",
	});
	attachUsageLedger(session, { origin: "app", app: "decision-bounded-model", dataDir: env.dataDir });
	let prompts = 0;
	const identity = (): ReaderIdentity => ({
		provider: session.model?.provider ?? "",
		id: session.model?.id ?? "",
		thinking: session.thinkingLevel,
	});
	return {
		identity,
		info: () => {
			const t = session.getSessionStats().tokens;
			return {
				...identity(),
				maxTokens: session.model?.maxTokens ?? 0,
				messages: session.messages.length,
				tokens: (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0),
				prompts,
				lifecycleIsolated: true,
				sdkRetryEnabled: services.settingsManager.getRetrySettings().enabled,
				providerMaxRetries: services.settingsManager.getProviderRetrySettings().maxRetries ?? -1,
				compactionEnabled: services.settingsManager.getCompactionEnabled(),
				cacheWarming: services.settingsManager.getCacheWarmingMode(),
			};
		},
		subscribe: (refused) =>
			session.subscribe((event) => {
				if (
					(event.type === "auto_retry_start" && isLimitRefusal(event.errorMessage)) ||
					(event.type === "message_end" &&
						event.message.role === "assistant" &&
						isLimitRefusal(event.message.errorMessage))
				)
					refused();
			}),
		prompt: async () => {
			prompts++;
			await prompt(session);
		},
		abort: () => session.abort(),
		dispose: () => session.dispose(),
	};
}
/** Metadata-only native SDK canary: deliberately blocks the one prompt before reservation. */
export async function readerSessionProof(env: DecisionModelEnv): Promise<ReaderDriverInfo> {
	let driver: BoundDriver | undefined;
	let info: ReaderDriverInfo | undefined;
	const outcome = await runBoundedCall({
		open: async () => {
			driver = await openReaderDriver(env, "", "medium", async () => {
				throw new Error("metadata must not prompt");
			});
			return driver;
		},
		beforePrompt: () => {
			info = driver!.info();
			return sessionBlock(info) ?? "metadata-only";
		},
		timeoutMs: 15_000,
		trace: () => {},
	});
	if (outcome.status !== "blocked" || outcome.block !== "metadata-only" || !info || driver!.info().prompts !== 0)
		throw new Error("reader metadata proof failed");
	return info;
}
export function boundedDecisionModel(
	env: DecisionModelEnv,
	control: DecisionBatchControl,
	trace: (row: LifecycleRow) => void = () => {},
): DecisionModel {
	return async (call) => {
		const usedModel = `${BATCH_PROVIDER}/${BATCH_MODEL}`;
		const fence = control.captureFence();
		let local = control.localCallMetadata();
		const mark = (row: LifecycleRow) => trace({ ...row, ...(local ? { localCall: local } : {}) });
		let reason = control.preflight();
		if (call.model !== "auto" || call.thinking !== "medium" || call.avoid?.includes(BATCH_PROVIDER))
			reason = "reader call differs from authorised model/account";
		if (reason) {
			control.pause(reason, false, fence);
			return { ok: false, limited: true, error: reason, model: usedModel };
		}
		let driver: BoundDriver | undefined;
		let snapshot:
			| {
					usage: { input: number; output: number };
					lastPresent: boolean;
					error: boolean;
					refusal: boolean;
					text: string;
			  }
			| undefined;
		try {
			const outcome = await runBoundedCall({
				open: async () => {
					driver = await openReaderDriver(env, call.system, "medium", async (session) => {
						await session.prompt(call.prompt, { expandPromptTemplates: false });
						const last = [...session.messages].reverse().find((message) => message.role === "assistant");
						const t = session.getSessionStats().tokens;
						snapshot = {
							usage: { input: (t.input ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0), output: t.output ?? 0 },
							lastPresent: !!last,
							error: last?.stopReason === "error" || last?.stopReason === "aborted",
							refusal: isLimitRefusal(last?.errorMessage),
							text: session.getLastAssistantText() ?? "",
						};
					});
					return driver;
				},
				beforePrompt: (identity) => {
					const blocked = control.preflight(identity) ?? sessionBlock(driver!.info());
					if (blocked) return blocked;
					const block = control.reserve(
						Buffer.byteLength(call.system, "utf8") + Buffer.byteLength(call.prompt, "utf8") + REQUEST_FRAMING,
						driver!.info().maxTokens,
						identity,
						fence,
					);
					local = control.localCallMetadata();
					return block;
				},
				timeoutMs: call.timeoutMs ?? 420_000,
				trace: mark,
			});
			if (
				outcome.status !== "settled" ||
				!snapshot?.lastPresent ||
				snapshot.error ||
				snapshot.refusal ||
				snapshot.usage.input + snapshot.usage.output <= 0
			) {
				const why = outcome.block ?? `transport ${outcome.status}; uncertain allowance retained`;
				const transient =
					outcome.status === "blocked" &&
					[
						"daily token boundary",
						"quota unavailable",
						"quota stale",
						"weekly usage stop",
						"five-hour usage stop",
						"usage guard inactive or stopped",
						"usage guard unavailable",
						"reader disabled",
					].includes(why);
				control.pause(why, !transient, fence);
				return { ok: false, limited: true, error: why, model: usedModel };
			}
			control.settle(snapshot.usage, fence);
			if (!snapshot.text.trim()) {
				control.pause("no usable model answer", true, fence);
				return { ok: false, limited: true, error: "no usable model answer", model: usedModel, usage: snapshot.usage };
			}
			return { ok: true, text: snapshot.text, model: usedModel, usage: snapshot.usage };
		} catch {
			control.pause("reader call failed; unresolved allowance retained", true, fence);
			return { ok: false, limited: true, error: "reader call failed; unresolved allowance retained", model: usedModel };
		}
	};
}
