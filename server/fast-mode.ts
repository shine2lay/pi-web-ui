/**
 * Per-chat ChatGPT speed. Standard is always the default, including copied sessions.
 * Only supported pi extension hooks are used: no shared models, headers or transports change.
 * Codex sends service_tier in both HTTP and WebSocket requests. Its routing hint is advisory:
 * https://github.com/openai/codex/blob/91168365a579420f7932f48bfb1ad15d810da3af/codex-rs/core/tests/suite/client_websockets.rs
 * (responses_websocket_prewarm_reuses_advisory_model_and_tier_routing_hint).
 * Fast -> priority; Astra Ultrafast -> ultrafast. A request is NOT proof of acceptance.
 */
import type { AgentBeforeSettleEventResult, ExtensionAPI, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { ChatSpeed, UiFastMode } from "./protocol.js";

export const FAST_MODE_PROVIDER = "openai-codex";
export const FAST_MODE_MODELS: readonly string[] = [
	"gpt-6.1-sol",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-luna",
	"gpt-5.5",
];
export const FAST_MODE_COOLDOWN_MS = 15 * 60_000;
export const FAST_MODE_ENTRY = "pi-web-ui/fast-mode";
export const FAST_MODE_EXT_NAME = "pi-webui-fast-mode";
export const FAST_MODE_SLOW_REASON = "ChatGPT answered at Standard speed (the selected speed may be unavailable)";
export type FastModeView = UiFastMode;
type ModelLike = { provider?: unknown; id?: unknown } | null | undefined;
type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };
type PricedModel = { cost?: Rates & { tiers?: readonly (Rates & { inputTokensAbove: number })[] } };
type UsageLike = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
};
export interface FastModeSession {
	getSessionId(): string;
	getEntries(): readonly unknown[];
}
type MessageLike = {
	role?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
	timestamp?: unknown;
	model?: unknown;
	content?: unknown;
	usage?: UsageLike;
	service_tier?: unknown;
	serviceTier?: unknown;
};

export function isChatSpeed(value: unknown): value is ChatSpeed {
	return value === "standard" || value === "fast" || value === "ultrafast";
}
export function fastModeSupported(model: ModelLike): boolean {
	return model?.provider === FAST_MODE_PROVIDER && typeof model.id === "string" && FAST_MODE_MODELS.includes(model.id);
}
export function ultrafastSupported(model: ModelLike): boolean {
	return model?.provider === FAST_MODE_PROVIDER && model.id === "gpt-6-astra";
}
export function speedSupported(model: ModelLike, mode: ChatSpeed): boolean {
	return fastModeSupported(model) && (mode !== "ultrafast" || ultrafastSupported(model));
}
export function fastTierFor(modelId: string, mode: ChatSpeed = "fast"): "priority" | "ultrafast" | undefined {
	if (!FAST_MODE_MODELS.includes(modelId)) return undefined;
	if (mode === "fast") return "priority";
	return mode === "ultrafast" && modelId === "gpt-6-astra" ? "ultrafast" : undefined;
}

/** A malformed explicit mode never falls through to legacy on=true. Latest entry wins. */
export function readFastModeFromSession(sm: FastModeSession): ChatSpeed {
	try {
		const sessionId = sm.getSessionId();
		const entries = sm.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i] as { type?: unknown; customType?: unknown; data?: unknown } | null;
			if (e?.type !== "custom" || e.customType !== FAST_MODE_ENTRY) continue;
			const data = e.data as { mode?: unknown; on?: unknown; sessionId?: unknown } | null;
			if (!data || data.sessionId !== sessionId) return "standard";
			if (Object.hasOwn(data, "mode")) return isChatSpeed(data.mode) ? data.mode : "standard";
			return data.on === true ? "fast" : "standard";
		}
	} catch {
		/* An unavailable manager is never an opt-in. */
	}
	return "standard";
}
export function fastModeEntryData(sm: FastModeSession, mode: ChatSpeed): { mode: ChatSpeed; sessionId: string } {
	return { mode: isChatSpeed(mode) ? mode : "standard", sessionId: sm.getSessionId() };
}

/** GPT-6 reports tiers the installed SDK doesn't price reliably. Never infer its tier from cost. */
export function fastPriceTells(modelId: unknown): boolean {
	return typeof modelId === "string" && /^gpt-5([.-]|$)/.test(modelId);
}
export function replyPriceMultiplier(message: unknown, model: unknown): number | undefined {
	const u = (message as MessageLike | undefined)?.usage;
	const cost = (model as PricedModel | null | undefined)?.cost;
	if (!u || !cost || typeof u.cost?.total !== "number") return undefined;
	const input = u.input ?? 0,
		output = u.output ?? 0,
		cacheRead = u.cacheRead ?? 0,
		cacheWrite = u.cacheWrite ?? 0;
	let rates: Rates = cost;
	let above = -1;
	for (const tier of cost.tiers ?? []) {
		if (input + cacheRead + cacheWrite > tier.inputTokensAbove && tier.inputTokensAbove > above) {
			rates = tier;
			above = tier.inputTokensAbove;
		}
	}
	const base =
		(rates.input * input + rates.output * output + rates.cacheRead * cacheRead + rates.cacheWrite * cacheWrite) / 1e6;
	return base > 0 ? u.cost.total / base : undefined;
}

const UNRELATED_ERROR =
	/\b401\b|unauthori[sz]ed|authentication|invalid.{0,12}token|token.{0,12}expired|sign.?in|context.{0,24}(length|window|limit|overflow)|maximum context|too many tokens|prompt is too long|network.?error|connection|econn|socket|fetch failed|timed? ?out|timeout|terminated|stream (closed|ended)/i;
const TIER_ERROR = /service[ _-]?tier|ultrafast|priority|fast mode/i;
/** Only tier/allowance refusals, not arbitrary 4xx or unknown errors. Never display backend content. */
export function fastRefusalReason(
	status: number | undefined,
	errorText: unknown,
	mode: ChatSpeed = "fast",
): string | null {
	const text = typeof errorText === "string" ? errorText : "";
	if (status === 401 || UNRELATED_ERROR.test(text)) return null;
	const code = status ?? Number(/\b([45]\d\d)\b/.exec(text)?.[1] || 0);
	if (
		!TIER_ERROR.test(text) &&
		!(code === 429 && /rate.?limit|too many requests|usage.?limit|allowance|quota/i.test(text))
	)
		return null;
	if (code >= 500 && !TIER_ERROR.test(text)) return null;
	const label = mode === "ultrafast" ? "Ultrafast" : "Fast";
	return `ChatGPT refused ${label}${code ? ` (HTTP ${code})` : " (tier unavailable)"}`;
}
function sameMessage(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	const x = a as MessageLike | null | undefined,
		y = b as MessageLike | null | undefined;
	return (
		!!x &&
		!!y &&
		x.role === "assistant" &&
		y.role === "assistant" &&
		x.stopReason === y.stopReason &&
		x.errorMessage === y.errorMessage &&
		x.timestamp !== undefined &&
		x.timestamp === y.timestamp
	);
}
function lastAssistant(messages: readonly unknown[]): unknown {
	for (let i = messages.length - 1; i >= 0; i--)
		if ((messages[i] as MessageLike | undefined)?.role === "assistant") return messages[i];
	return undefined;
}
/** Fail closed: no retry after any output/tool-call block, even a partially streamed one. */
function emptyFailedReply(message: unknown): boolean {
	const m = message as MessageLike | undefined;
	return m?.role === "assistant" && m.stopReason === "error" && Array.isArray(m.content) && m.content.length === 0;
}
function returnedMode(tier: unknown): ChatSpeed | undefined {
	if (tier === "ultrafast") return "ultrafast";
	if (tier === "priority" || tier === "fast") return "fast";
	if (tier === "default" || tier === "standard") return "standard";
	return undefined;
}
interface FastState {
	mode: ChatSpeed;
	selectionRevision: number;
	coolingUntil?: number;
	reason?: string;
	inflightMode?: ChatSpeed;
	inflightSelectionRevision?: number;
	inflightModel?: unknown;
	inflightStatus?: number;
	confirmedMode?: ChatSpeed;
	confirmedModel?: unknown;
	refused?: unknown;
	retryUsed?: boolean;
	runFallback?: boolean;
}

export class FastModeRegistry {
	private readonly states = new Map<string, FastState>();
	constructor(private readonly now: () => number = Date.now) {}
	private state(sm: FastModeSession): FastState | undefined {
		let id: string;
		try {
			id = sm.getSessionId();
		} catch {
			return undefined;
		}
		if (!id) return undefined;
		let s = this.states.get(id);
		if (!s) {
			s = { mode: readFastModeFromSession(sm), selectionRevision: 0 };
			this.states.set(id, s);
			if (this.states.size > 2000)
				for (const [key, v] of this.states) {
					if (this.states.size <= 2000) break;
					if (key !== id && !v.inflightMode && !v.refused) this.states.delete(key);
				}
		}
		return s;
	}
	mode(sm: FastModeSession): ChatSpeed {
		return this.state(sm)?.mode ?? "standard";
	}
	setMode(sm: FastModeSession, mode: ChatSpeed): void {
		const s = this.state(sm);
		if (!s) return;
		Object.assign(s, {
			mode: isChatSpeed(mode) ? mode : "standard",
			selectionRevision: s.selectionRevision + 1,
			// Explicit choices supersede old feedback/retries, not the request already on the wire.
			runFallback: false,
			refused: undefined,
			coolingUntil: undefined,
			reason: undefined,
			confirmedMode: undefined,
			confirmedModel: undefined,
		});
	}
	private coolingDown(s: FastState): boolean {
		if (s.coolingUntil === undefined) return false;
		if (s.coolingUntil > this.now()) return true;
		s.coolingUntil = undefined;
		s.reason = undefined;
		return false;
	}
	view(sm: FastModeSession, model: ModelLike): FastModeView | null {
		if (!fastModeSupported(model)) return null;
		const s = this.state(sm);
		if (!s) return null;
		const cooling = this.coolingDown(s);
		const supported = speedSupported(model, s.mode);
		return {
			mode: s.mode,
			effective: cooling || s.runFallback || !supported ? "standard" : s.mode,
			ultrafastAvailable: ultrafastSupported(model),
			...(cooling ? { coolingUntil: s.coolingUntil, reason: s.reason } : {}),
			...(!supported ? { reason: "Ultrafast is saved for Astra; this model uses Standard" } : {}),
			...(s.confirmedModel === model?.id && s.confirmedMode ? { confirmedMode: s.confirmedMode } : {}),
		};
	}
	rewritePayload(sm: FastModeSession, model: ModelLike, payload: unknown): unknown {
		const s = this.state(sm);
		if (!s) return undefined;
		s.inflightMode = undefined;
		s.inflightSelectionRevision = undefined;
		s.inflightStatus = undefined;
		s.inflightModel = undefined;
		s.confirmedMode = undefined;
		s.confirmedModel = undefined;
		const body = payload as Record<string, unknown> | null;
		if (
			!fastModeSupported(model) ||
			!body ||
			typeof body !== "object" ||
			Array.isArray(body) ||
			(body.model !== undefined && body.model !== model?.id)
		)
			return undefined;
		const mode = this.view(sm, model)?.effective ?? "standard";
		s.inflightMode = mode;
		s.inflightSelectionRevision = s.selectionRevision;
		s.inflightModel = model?.id;
		const tier = fastTierFor(String(model?.id), mode);
		if (tier) return { ...body, service_tier: tier };
		// A reused payload must not leak a previously selected speed into Standard/cooldown.
		if (body.service_tier !== undefined) {
			const { service_tier: _tier, ...standard } = body;
			return standard;
		}
		return undefined;
	}
	noteResponse(sm: FastModeSession, status: unknown): void {
		const s = this.state(sm);
		if (s?.inflightMode && typeof status === "number") s.inflightStatus = status;
	}
	/** The current SDK drops streamed service_tier metadata; absent metadata stays unconfirmed.
	 * Future SDKs may retain it on the message. Cost is only a legacy GPT-5 downgrade signal. */
	noteReplySpeed(sm: FastModeSession, message: unknown, model: unknown): string | null {
		const m = message as MessageLike | undefined;
		const s = this.state(sm);
		const id = (model as ModelLike)?.id;
		if (
			m?.role !== "assistant" ||
			m.stopReason === "error" ||
			m.stopReason === "aborted" ||
			!s?.inflightMode ||
			s.inflightSelectionRevision !== s.selectionRevision ||
			s.inflightModel !== id ||
			(typeof m.model === "string" && m.model !== id)
		)
			return null;
		const confirmed = returnedMode(m.service_tier ?? m.serviceTier);
		if (confirmed) {
			s.confirmedMode = confirmed;
			s.confirmedModel = id;
		}
		if (s.inflightMode === "standard") return null;
		const downgraded =
			confirmed !== undefined
				? confirmed !== s.inflightMode
				: fastPriceTells(id) && (replyPriceMultiplier(message, model) ?? 2) < 1.5;
		if (!downgraded) return null;
		const reason =
			confirmed === "fast" ? "ChatGPT answered at Fast, not Ultrafast; using Standard for now" : FAST_MODE_SLOW_REASON;
		s.coolingUntil = this.now() + FAST_MODE_COOLDOWN_MS;
		s.reason = reason;
		s.runFallback = true;
		return reason;
	}
	noteMessageEnd(sm: FastModeSession, message: unknown): string | null {
		const m = message as MessageLike | undefined,
			s = this.state(sm);
		if (m?.role !== "assistant" || !s) return null;
		const mode = s.inflightMode,
			status = s.inflightStatus,
			selectionRevision = s.inflightSelectionRevision;
		s.inflightMode = undefined;
		s.inflightSelectionRevision = undefined;
		s.inflightStatus = undefined;
		// A delayed refusal of the previous choice must not disable or retry the new choice.
		if (!mode || mode === "standard" || m.stopReason !== "error" || selectionRevision !== s.selectionRevision)
			return null;
		const reason = fastRefusalReason(status, m.errorMessage, mode);
		if (!reason) return null;
		s.coolingUntil = this.now() + FAST_MODE_COOLDOWN_MS;
		s.reason = reason;
		s.runFallback = true;
		if (!s.retryUsed && emptyFailedReply(message)) s.refused = message;
		return reason;
	}
	retryPending(sm: FastModeSession, messages: readonly unknown[]): boolean {
		const s = this.state(sm);
		return !!s?.refused && !s.retryUsed && sameMessage(lastAssistant(messages), s.refused);
	}
	takeRefused(sm: FastModeSession): unknown {
		const s = this.state(sm);
		if (!s?.refused || s.retryUsed) return undefined;
		const m = s.refused;
		s.refused = undefined;
		return m;
	}
	noteRetrying(sm: FastModeSession): void {
		const s = this.state(sm);
		if (s) s.retryUsed = true;
	}
	noteSettled(sm: FastModeSession): void {
		const s = this.state(sm);
		if (s)
			Object.assign(s, {
				refused: undefined,
				retryUsed: false,
				runFallback: false,
				inflightMode: undefined,
				inflightSelectionRevision: undefined,
				inflightStatus: undefined,
			});
	}
	clear(): void {
		this.states.clear();
	}
}
export const fastModeRegistry = new FastModeRegistry();
type BranchEntry = { type?: unknown; id?: unknown; targetId?: unknown; message?: unknown };
type BoundaryLike = {
	entries: SessionBoundaryDraft[];
	outcome?: unknown;
	context?: { contextMessages?: readonly unknown[] };
};

/** Continue from the existing user/tool-result boundary; never re-prompt or replay tool calls. */
export function fastRetryBoundary(
	failed: unknown,
	event: BoundaryLike,
	branch: readonly unknown[],
): AgentBeforeSettleEventResult | undefined {
	if (!emptyFailedReply(failed) || event.outcome !== "error") return undefined;
	const edited = new Set<unknown>(
		event.entries.filter((e) => e.type === "context_edit").map((e) => (e as { targetId: string }).targetId),
	);
	let targetId: string | undefined;
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i] as BranchEntry | undefined;
		if (!e) continue;
		if (e.type === "context_edit") {
			edited.add(e.targetId);
			continue;
		}
		if (e.type !== "message") continue;
		// Nothing, including a queued user message or tool result, may follow the failed attempt.
		if (sameMessage(e.message, failed) && typeof e.id === "string" && !edited.has(e.id)) targetId = e.id;
		break;
	}
	const msgs = event.context?.contextMessages;
	if (!targetId || !Array.isArray(msgs) || msgs.length < 2 || !sameMessage(msgs.at(-1), failed)) return undefined;
	const prev = msgs.at(-2) as MessageLike | undefined;
	if (prev?.role !== "user" && prev?.role !== "toolResult") return undefined;
	return { entries: [...event.entries, { type: "context_edit", targetId, replacement: null }], continue: true };
}
export function fastModeExtension(registry: FastModeRegistry = fastModeRegistry): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.on("before_provider_request", (event, ctx) =>
			registry.rewritePayload(ctx.sessionManager, ctx.model, event.payload),
		);
		pi.on("after_provider_response", (event, ctx) => {
			registry.noteResponse(ctx.sessionManager, event.status);
		});
		pi.on("message_end", (event, ctx) => {
			const slow = registry.noteReplySpeed(ctx.sessionManager, event.message, ctx.model);
			const reason = registry.noteMessageEnd(ctx.sessionManager, event.message);
			if (slow || reason) console.warn(`[fast-mode] ${slow || reason}: Standard for 15 minutes`);
		});
		pi.on("agent_before_settle", (event, ctx) => {
			const failed = registry.takeRefused(ctx.sessionManager);
			if (!failed) return undefined;
			const retry = fastRetryBoundary(failed, event, ctx.sessionManager.getBranch());
			if (retry) registry.noteRetrying(ctx.sessionManager);
			return retry;
		});
		pi.on("agent_settled", (_event, ctx) => {
			registry.noteSettled(ctx.sessionManager);
		});
	};
}
