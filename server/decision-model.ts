/**
 * decision-model (task #84): the one model call the decision reader makes per batch.
 *
 * Same SDK chain as plugin-llm (createAgentSessionServices + ModelRuntime + an in-memory session,
 * no tools, prompt, last assistant text, dispose), but leaner, because the reader runs it hundreds of
 * times: no extensions except the two the Claude pool needs (pi-anthropic-auth for the subscription
 * login, pi-multi-pass for the pool's accounts), no skills, prompt templates, themes or context files,
 * and the reader's own system prompt instead of the coding agent's.
 *
 * Nothing here logs what is sent to the model; callers log only sizes, the model used and tokens.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

export interface DecisionModelCall {
	system: string;
	prompt: string;
	/** "provider/id", or "auto": the cheapest Claude model of the chat pool, on its first account not in avoid. */
	model: string;
	/** With "auto": pool accounts resting after a limit refusal, not asked this time. */
	avoid?: readonly string[];
	/** Thinking level; left out = "low" (the chats' default, often "max", is far too slow here). */
	thinking?: "off" | "minimal" | "low" | "medium" | "high";
	timeoutMs?: number;
}

export type DecisionModelReply =
	| { ok: true; text: string; model: string; usage: { input: number; output: number } }
	| {
			ok: false;
			error: string;
			model?: string;
			usage?: { input: number; output: number };
			/** The account refused for its limit (or, without account, every pool account rests): try another or wait. */
			limited?: boolean;
			/** The pool account (provider) the call asked, with "auto". */
			account?: string;
	  };

export type DecisionModel = (call: DecisionModelCall) => Promise<DecisionModelReply>;

export interface DecisionModelEnv {
	cwd: string;
	agentDir: string;
	/** Extension folders loaded into the reader's session (default: readerExtensionPaths(agentDir)). */
	extensionPaths?: string[];
}

const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * The extension folders the Claude pool needs, read from pi's settings.json packages: the local
 * pi-anthropic-auth folder and the pi-multi-pass git package (git:<host>/<path>@ref is installed
 * at <agentDir>/git/<host>/<path>). Others (queue, identity, memory, …) are left out on purpose.
 */
export function readerExtensionPaths(agentDir: string): string[] {
	let packages: unknown[] = [];
	try {
		const s = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as { packages?: unknown[] };
		packages = Array.isArray(s.packages) ? s.packages : [];
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const p of packages) {
		const src =
			typeof p === "string"
				? p
				: typeof (p as { source?: unknown })?.source === "string"
					? String((p as { source: string }).source)
					: "";
		if (!/pi-anthropic-auth|pi-multi-pass/.test(src)) continue;
		let dir = src;
		const git = /^git:(.+?)(?:@[^@/]+)?$/.exec(src);
		if (git) dir = join(agentDir, "git", git[1]);
		else if (src.startsWith("npm:")) dir = join(agentDir, "npm", "node_modules", src.slice(4).replace(/@[^@/]+$/, ""));
		else if (!src.startsWith("/")) dir = join(agentDir, src);
		if (existsSync(dir)) out.push(dir);
	}
	return out;
}

interface CostedModel {
	provider: string;
	id: string;
	cost?: { input?: number; output?: number };
}

/** The cheapest model (input price, then output price) of a provider's list; ids sorted for ties. */
export function cheapestModel(models: readonly CostedModel[]): CostedModel | undefined {
	const priced = models.filter((m) => typeof m.cost?.input === "number" && (m.cost?.input ?? 0) > 0);
	const list = priced.length ? priced : [...models];
	return [...list].sort(
		(a, b) =>
			(a.cost?.input ?? Infinity) - (b.cost?.input ?? Infinity) ||
			(a.cost?.output ?? Infinity) - (b.cost?.output ?? Infinity) ||
			a.id.localeCompare(b.id),
	)[0];
}

/** The base provider of the enabled Claude pool in multi-pass.json ("anthropic" when there is none). */
export function claudePoolProvider(agentDir: string): string {
	try {
		const cfg = JSON.parse(readFileSync(join(agentDir, "multi-pass.json"), "utf8")) as {
			pools?: { baseProvider?: string; enabled?: boolean }[];
		};
		const pool = (cfg.pools ?? []).find((p) => p.enabled !== false && p.baseProvider === "anthropic");
		if (pool?.baseProvider) return pool.baseProvider;
	} catch {
		/* no multi-pass config */
	}
	return "anthropic";
}

/** The enabled Claude pool's accounts (providers) in its order; just the base provider when there is no pool. */
export function claudePoolMembers(agentDir: string): string[] {
	try {
		const cfg = JSON.parse(readFileSync(join(agentDir, "multi-pass.json"), "utf8")) as {
			pools?: { baseProvider?: string; enabled?: boolean; members?: unknown }[];
		};
		const pool = (cfg.pools ?? []).find((p) => p.enabled !== false && p.baseProvider === "anthropic");
		const members = Array.isArray(pool?.members)
			? pool.members.filter((m): m is string => typeof m === "string" && !!m)
			: [];
		if (members.length) return [...new Set(members)];
	} catch {
		/* no multi-pass config */
	}
	return [claudePoolProvider(agentDir)];
}

/** The account "auto" asks: the pool's first account that isn't resting; none when all are. */
export function pickAccount(members: readonly string[], avoid: readonly string[] = []): string | undefined {
	return members.find((m) => !avoid.includes(m));
}

/** A provider error that means the account hit its limit (HTTP 429, rate or usage limit), not a passing fault. */
export function isLimitRefusal(error: string | undefined): boolean {
	return (
		!!error && /\b429\b|rate[_ ]limit|usage limit|exceed your account's rate limit|out of (extra )?usage/i.test(error)
	);
}

/** Why the last answer failed, in the provider's words (a sign-in or limit error), clipped; no request content. */
export function lastError(messages: readonly unknown[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; stopReason?: string; errorMessage?: unknown };
		if (m?.role !== "assistant") continue;
		if (m.stopReason !== "error" && m.stopReason !== "aborted") return undefined;
		const why = typeof m.errorMessage === "string" ? m.errorMessage.replace(/\s+/g, " ").trim() : "";
		return why
			? `the model call failed: ${why.length > 240 ? `${why.slice(0, 239)}\u2026` : why}`
			: `the model call ended: ${m.stopReason}`;
	}
	return undefined;
}

/** What a call that ran out of time had been doing: failed tries the session retried, in the provider's words. */
export function timeoutNote(
	messages: readonly unknown[],
	retries: readonly { errorMessage: string; delayMs: number }[] = [],
): string | undefined {
	const failed = messages.filter((m) => {
		const a = m as { role?: string; stopReason?: string };
		return a?.role === "assistant" && a.stopReason === "error";
	});
	const n = Math.max(failed.length, retries.length);
	if (!n) return "no answer and no error from the provider";
	const last = retries[retries.length - 1];
	const why = last
		? `${clip(last.errorMessage)}, next try after ${Math.round(last.delayMs / 1000)} s`
		: lastError([failed[failed.length - 1]])?.replace(/^the model call failed: /, "");
	return `${n} failed ${n === 1 ? "try" : "tries"} before it${why ? `, last: ${why}` : ""}`;
}

const clip = (s: string) => {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > 240 ? `${t.slice(0, 239)}\u2026` : t;
};

export function isolatedDecisionModel(env: DecisionModelEnv): DecisionModel {
	const extensionPaths = env.extensionPaths ?? readerExtensionPaths(env.agentDir);
	return async (call) => {
		const timeoutMs = call.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		let dispose: (() => void) | undefined;
		let abort: (() => void) | undefined;
		/** On a timeout: the provider's words for any failed tries so far (pi retries some errors itself). */
		let peek: (() => string | undefined) | undefined;
		let modelName = call.model;
		/** With "auto": the pool account asked. */
		let account: string | undefined;
		/** A limit refusal seen while the session was about to retry it: the call stops at once. */
		let refusal: string | undefined;
		const run = (async (): Promise<DecisionModelReply> => {
			try {
				const services = await createAgentSessionServices({
					cwd: env.cwd,
					agentDir: env.agentDir,
					resourceLoaderOptions: {
						noExtensions: true,
						additionalExtensionPaths: extensionPaths,
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
						noContextFiles: true,
						systemPromptOverride: () => call.system,
					},
					modelRuntime: await ModelRuntime.create({
						authPath: join(env.agentDir, "auth.json"),
						modelsPath: join(env.agentDir, "models.json"),
					}),
				});
				let provider: string;
				let id: string;
				if (!call.model || call.model === "auto") {
					const members = claudePoolMembers(env.agentDir);
					const picked = pickAccount(members, call.avoid);
					if (!picked) {
						return {
							ok: false,
							limited: true,
							error: `every Claude account of the chat pool (${members.join(", ")}) is resting after a limit refusal`,
						};
					}
					provider = picked;
					account = picked;
					const pick = cheapestModel(services.modelRuntime.getModels(provider) as readonly CostedModel[]);
					if (!pick) return { ok: false, error: `no models for provider ${provider}` };
					id = pick.id;
				} else {
					const slash = call.model.indexOf("/");
					if (slash <= 0) return { ok: false, error: `model must be provider/id or auto: ${call.model}` };
					provider = call.model.slice(0, slash);
					id = call.model.slice(slash + 1);
				}
				modelName = `${provider}/${id}`;
				const model = services.modelRuntime.getModel(provider, id);
				if (!model) return { ok: false, error: `model not found: ${modelName}`, model: modelName };
				const srv = await createAgentSessionFromServices({
					services,
					sessionManager: SessionManager.inMemory(env.cwd),
					model,
					thinkingLevel: call.thinking ?? "low",
					noTools: "all",
				});
				abort = () => {
					void srv.session.abort().catch(() => {});
				};
				// pi retries some provider errors itself and drops the failed answer: note them as they start.
				const retries: { errorMessage: string; delayMs: number }[] = [];
				srv.session.subscribe((e) => {
					if (e.type !== "auto_retry_start") return;
					retries.push({ errorMessage: e.errorMessage, delayMs: e.delayMs });
					// A limit refusal isn't waited out on the same account: stop now, so the reader can ask the
					// next account (with "auto") or wait, instead of hanging until the timeout.
					if (!refusal && isLimitRefusal(e.errorMessage)) {
						refusal = e.errorMessage;
						abort?.();
					}
				});
				peek = () => timeoutNote(srv.session.messages, retries);
				dispose = () => {
					try {
						srv.session.dispose();
					} catch {
						/* best effort */
					}
				};
				try {
					await srv.session.prompt(call.prompt, { expandPromptTemplates: false });
				} catch (err) {
					if (!refusal) throw err;
				}
				if (refusal)
					return {
						ok: false,
						limited: true,
						account,
						error: `limit refusal on ${provider}: ${clip(refusal)}`,
						model: modelName,
					};
				const text = srv.session.getLastAssistantText() ?? "";
				let usage = { input: 0, output: 0 };
				try {
					const stats = srv.session.getSessionStats();
					// The prompt mostly lands in the provider's cache (written or read), so all three count as input.
					const t = stats.tokens;
					usage = { input: (t.input ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0), output: t.output ?? 0 };
				} catch {
					/* usage best effort */
				}
				const used = srv.session.model ? `${srv.session.model.provider}/${srv.session.model.id}` : modelName;
				if (!text.trim()) {
					const why = lastError(srv.session.messages) ?? "the model gave no text";
					return {
						ok: false,
						error: why,
						model: used,
						usage,
						...(isLimitRefusal(why) ? { limited: true, account } : {}),
					};
				}
				return { ok: true, text, model: used, usage };
			} finally {
				try {
					dispose?.();
				} catch {
					/* best effort */
				}
			}
		})();
		void run.catch(() => {});
		let timeout: NodeJS.Timeout | undefined;
		try {
			const timer = new Promise<DecisionModelReply>((resolve) => {
				timeout = setTimeout(() => {
					// Stop the model's work too, so a slow call doesn't keep spending after it was given up.
					let note: string | undefined;
					try {
						note = peek?.();
					} catch {
						/* best effort */
					}
					abort?.();
					const error = `timed out after ${Math.round(timeoutMs / 1000)} s${note ? ` (${note})` : ""}`;
					resolve({ ok: false, error, model: modelName, ...(isLimitRefusal(note) ? { limited: true, account } : {}) });
				}, timeoutMs);
				timeout.unref?.();
			});
			return await Promise.race([run, timer]);
		} catch (err) {
			return { ok: false, error: (err as Error).message, model: modelName };
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	};
}
