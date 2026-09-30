/**
 * fast-mode: the per-chat "⚡ Fast" button for ChatGPT (openai-codex) chats.
 *
 * With it on, the chat's model requests carry OpenAI's fast tier (`service_tier`), so replies come
 * faster and use the ChatGPT plan's limits 2.5× quicker (no extra money). It is off in every new
 * chat and never touches any other provider (Claude and the rest never get a tier).
 *
 * How it works (pi's own extension hooks only — pi itself is not changed):
 *  - `before_provider_request` adds the tier to the request of a chat that has fast on, on a model
 *    from FAST_MODE_MODELS, while fast is not cooling down.
 *  - A fast request ChatGPT refuses (a 4xx; on the WebSocket transport only the error text is
 *    known) puts the chat on "normal speed for now" for 15 minutes, with the reason for the button.
 *    So does a fast request ChatGPT quietly answers at normal speed (its plan has no fast mode, or
 *    fast is busy): pi prices each reply by the tier ChatGPT reports, so a reply priced at the
 *    normal rate ran at normal speed. Only on GPT-5.x models: GPT-6 models report a fast reply as
 *    "fast", which pi prices like a normal one, so there the price can't tell (fastPriceTells).
 *  - The refused reply is retried once at normal speed in the same run (`agent_before_settle`
 *    hides the failed attempt and continues — the same way pi's own auto-retry does it), so the
 *    user's message is neither lost nor sent twice. pi's auto-retry already covers what it
 *    retries itself (rate limits): those attempts go out at normal speed because of the cooldown.
 *
 * The choice is saved in the chat's session file as a custom entry that names its own session id,
 * so copies of a chat (which copy the entries) start off.
 */
import type { AgentBeforeSettleEventResult, ExtensionAPI, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";

/** Only ChatGPT sign-in chats get fast mode. */
export const FAST_MODE_PROVIDER = "openai-codex";

/**
 * Models with fast mode — keep in step with OpenAI's Codex speed page:
 * https://developers.openai.com/codex/speed
 * (GPT-6.1 Sol, GPT-6 Astra/Sol/Luna; GPT-5.6 and GPT-5.5 get about 1.5× the speed.)
 * gpt-5.6-terra and gpt-5.3-codex-spark are left out until a live check shows them running fast.
 */
export const FAST_MODE_MODELS: readonly string[] = [
	"gpt-6.1-sol",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-luna",
	"gpt-5.5",
];

/** How long a chat stays at normal speed after ChatGPT refused fast mode. */
export const FAST_MODE_COOLDOWN_MS = 15 * 60_000;

/** Custom session entry that saves the choice: `{ on, sessionId }`. */
export const FAST_MODE_ENTRY = "pi-web-ui/fast-mode";

/** Name of the hidden in-process extension. */
export const FAST_MODE_EXT_NAME = "pi-webui-fast-mode";

/** The button's reason when ChatGPT answered a fast request at normal speed. */
export const FAST_MODE_SLOW_REASON = "ChatGPT answered at normal speed (fast mode may not be in your plan, or is busy)";

/**
 * Does a reply's price show whether it ran fast? ChatGPT reports the tier it used and pi prices the
 * reply by it. GPT-5.6 and earlier report a fast reply as "priority", which pi prices at 2 times
 * (2.5 times for gpt-5.5); GPT-6 models report "fast", which pi (0.87) prices like a normal reply. See
 * <https://developers.openai.com/api/docs/guides/priority-processing>.
 */
export function fastPriceTells(modelId: unknown): boolean {
	return typeof modelId === "string" && /^gpt-5([.-]|$)/.test(modelId);
}

/** What the page gets for the ⚡ button (null = no button: not a fast-mode model). */
export interface FastModeView {
	on: boolean;
	/** Epoch ms: ChatGPT refused fast mode, so the chat runs at normal speed until then. */
	coolingUntil?: number;
	/** Why it is at normal speed for now, e.g. "ChatGPT refused fast mode (HTTP 400)". */
	reason?: string;
}

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

/** Session manager surface we need (pi's SessionManager / ReadonlySessionManager both fit). */
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
	usage?: UsageLike;
};

/**
 * The price multiplier pi applied to a reply: pi prices a ChatGPT reply by the tier ChatGPT reports
 * back (fast = 2×, 2.5× for gpt-5.5; normal = 1×). Undefined when it can't tell (no prices, no tokens).
 */
export function replyPriceMultiplier(message: unknown, model: unknown): number | undefined {
	const u = (message as MessageLike | undefined)?.usage;
	const cost = (model as PricedModel | null | undefined)?.cost;
	if (!u || !cost || typeof u.cost?.total !== "number") return undefined;
	const input = u.input ?? 0;
	const output = u.output ?? 0;
	const cacheRead = u.cacheRead ?? 0;
	const cacheWrite = u.cacheWrite ?? 0;
	// The same long-chat price step pi uses (calculateCost).
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
	if (!(base > 0)) return undefined;
	return u.cost.total / base;
}

/** Does this model have fast mode? Only openai-codex models from FAST_MODE_MODELS do. */
export function fastModeSupported(model: ModelLike): boolean {
	return (
		!!model &&
		model.provider === FAST_MODE_PROVIDER &&
		typeof model.id === "string" &&
		FAST_MODE_MODELS.includes(model.id)
	);
}

/** The `service_tier` value sent for a model. "priority" is what pi-subagents uses successfully
 *  and what pi prices as the fast rate; change a model here if a live check shows it needs "fast". */
export function fastTierFor(_modelId: string): string {
	return "priority";
}

/** The chat's saved choice. Only an entry written for this very session counts, so a copied chat
 *  (whose file carries the original's entries) starts off. All branches count: the latest wins. */
export function readFastModeFromSession(sm: FastModeSession): boolean {
	let sessionId: string;
	let entries: readonly unknown[];
	try {
		sessionId = sm.getSessionId();
		entries = sm.getEntries();
	} catch {
		return false;
	}
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as { type?: unknown; customType?: unknown; data?: unknown };
		if (e?.type !== "custom" || e.customType !== FAST_MODE_ENTRY) continue;
		const data = e.data as { on?: unknown; sessionId?: unknown } | undefined;
		if (data?.sessionId !== sessionId) return false;
		return data.on === true;
	}
	return false;
}

/** The data of the entry that saves the choice for this session. */
export function fastModeEntryData(sm: FastModeSession, on: boolean): { on: boolean; sessionId: string } {
	return { on, sessionId: sm.getSessionId() };
}

const TRANSIENT_ERROR =
	/overloaded|service.?unavailable|server.?error|internal.?error|bad gateway|gateway|network.?error|connection|econn|socket|fetch failed|timed? ?out|timeout|terminated|websocket.?(closed|error)|ended without|stream (closed|ended)|\b5\d\d\b/i;
const CONTEXT_OVERFLOW =
	/context.{0,24}(length|window|limit|overflow)|maximum context|too many tokens|prompt is too long/i;
const SIGN_IN_ERROR = /\b401\b|unauthori[sz]ed|authentication|invalid.{0,12}token|token.{0,12}expired|sign.?in/i;

function shortReason(text: string): string {
	const s = text
		.replace(/^codex error:\s*/i, "")
		.replace(/\s+/g, " ")
		.trim();
	return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

/**
 * Was this failed fast request a refusal of fast mode? Returns the reason for the button, or null
 * for failures that have nothing to do with the tier (sign-in, context too long, server trouble).
 * `status` is the HTTP status when the transport reported one (SSE); the WebSocket transport only
 * gives the error text.
 */
export function fastRefusalReason(status: number | undefined, errorText: unknown): string | null {
	const text = typeof errorText === "string" ? errorText : "";
	if (CONTEXT_OVERFLOW.test(text)) return null;
	if (typeof status === "number" && status > 0) {
		if (status >= 400 && status < 500 && status !== 401) return `ChatGPT refused fast mode (HTTP ${status})`;
		return null;
	}
	if (SIGN_IN_ERROR.test(text)) return null;
	const code = /\b(4\d\d)\b/.exec(text)?.[1];
	if (code) return `ChatGPT refused fast mode (HTTP ${code})`;
	if (/rate.?limit|too many requests|usage.?limit/i.test(text)) return "ChatGPT refused fast mode (HTTP 429)";
	if (TRANSIENT_ERROR.test(text)) return null;
	return text.trim() ? `ChatGPT refused fast mode (${shortReason(text)})` : "ChatGPT refused fast mode";
}

/** Same message? The object normally is the very same one; the fields cover a replaced copy. */
function sameMessage(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	const x = a as MessageLike | null | undefined;
	const y = b as MessageLike | null | undefined;
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
	for (let i = messages.length - 1; i >= 0; i--) {
		if ((messages[i] as MessageLike | undefined)?.role === "assistant") return messages[i];
	}
	return undefined;
}

interface FastState {
	on: boolean;
	coolingUntil?: number;
	reason?: string;
	/** The request in flight went out with the fast tier. */
	inflightFast?: boolean;
	/** HTTP status the transport reported for it (SSE only). */
	inflightStatus?: number;
	/** A refused fast reply waiting for its one retry at normal speed. */
	refused?: unknown;
	/** That retry is under way. */
	retrying?: boolean;
}

/** Per-chat fast-mode state, keyed by session id (a chat can move between windows; its session
 *  id stays). The saved choice is loaded from the session file the first time it is needed. */
export class FastModeRegistry {
	private readonly states = new Map<string, FastState>();
	private static readonly MAX = 2000;

	constructor(private readonly now: () => number = Date.now) {}

	private state(sm: FastModeSession): FastState | undefined {
		let id: string;
		try {
			id = sm.getSessionId();
		} catch {
			return undefined;
		}
		let s = this.states.get(id);
		if (!s) {
			s = { on: readFastModeFromSession(sm) };
			this.states.set(id, s);
			if (this.states.size > FastModeRegistry.MAX) {
				for (const [key, v] of this.states) {
					if (this.states.size <= FastModeRegistry.MAX) break;
					if (key !== id && !v.on && !v.refused) this.states.delete(key);
				}
			}
		}
		return s;
	}

	isOn(sm: FastModeSession): boolean {
		return this.state(sm)?.on === true;
	}

	/** Turn fast mode on/off for a chat. Any change clears the cooldown (toggling off and on
	 *  is how the user asks to try fast again right away). */
	setOn(sm: FastModeSession, on: boolean): void {
		const s = this.state(sm);
		if (!s) return;
		s.on = on;
		s.coolingUntil = undefined;
		s.reason = undefined;
	}

	private coolingDown(s: FastState): boolean {
		if (s.coolingUntil === undefined) return false;
		if (s.coolingUntil > this.now()) return true;
		s.coolingUntil = undefined;
		s.reason = undefined;
		return false;
	}

	/** The button's state for this chat, or null when its model has no fast mode. */
	view(sm: FastModeSession, model: ModelLike): FastModeView | null {
		if (!fastModeSupported(model)) return null;
		const s = this.state(sm);
		if (!s) return null;
		if (!s.on) return { on: false };
		if (this.coolingDown(s)) return { on: true, coolingUntil: s.coolingUntil, reason: s.reason };
		return { on: true };
	}

	/** Would a request of this chat on this model go out fast right now? */
	shouldSendFast(sm: FastModeSession, model: ModelLike): boolean {
		if (!fastModeSupported(model)) return false;
		const s = this.state(sm);
		return !!s && s.on && !this.coolingDown(s);
	}

	/** before_provider_request: the payload with the fast tier, or undefined to leave it alone. */
	rewritePayload(sm: FastModeSession, model: ModelLike, payload: unknown): unknown {
		const s = this.state(sm);
		if (!s) return undefined;
		s.inflightStatus = undefined;
		const body = payload as Record<string, unknown> | null;
		const sendFast =
			this.shouldSendFast(sm, model) &&
			!!body &&
			typeof body === "object" &&
			!Array.isArray(body) &&
			// The request must be for the chat's model (not some side request on another model).
			(body.model === undefined || body.model === (model as { id?: unknown }).id);
		s.inflightFast = sendFast;
		if (!sendFast) return undefined;
		return { ...body, service_tier: fastTierFor(String((model as { id?: unknown }).id)) };
	}

	/** after_provider_response: remember the HTTP status of a fast request. */
	noteResponse(sm: FastModeSession, status: unknown): void {
		const s = this.state(sm);
		if (!s?.inflightFast) return;
		if (typeof status === "number") s.inflightStatus = status;
	}

	/** message_end, before noteMessageEnd: a fast request ChatGPT answered at normal speed (priced
	 *  at the normal rate) starts the cooldown. The reply itself is fine: no retry. Returns the reason. */
	noteReplySpeed(sm: FastModeSession, message: unknown, model: unknown): string | null {
		const m = message as MessageLike | undefined;
		if (m?.role !== "assistant" || m.stopReason === "error" || m.stopReason === "aborted") return null;
		const s = this.state(sm);
		if (!s?.inflightFast) return null;
		const id = (model as { id?: unknown } | null | undefined)?.id;
		// The price only tells on GPT-5.x, and only against the prices of the model that answered.
		if (!fastPriceTells(id) || (typeof m.model === "string" && m.model !== id)) return null;
		const multiplier = replyPriceMultiplier(message, model);
		if (multiplier === undefined || multiplier >= 1.5) return null;
		s.coolingUntil = this.now() + FAST_MODE_COOLDOWN_MS;
		s.reason = FAST_MODE_SLOW_REASON;
		return FAST_MODE_SLOW_REASON;
	}

	/** message_end: a refused fast reply starts the cooldown and waits for its retry.
	 *  Returns the reason when it was a refusal. */
	noteMessageEnd(sm: FastModeSession, message: unknown): string | null {
		const m = message as MessageLike | undefined;
		if (m?.role !== "assistant") return null;
		const s = this.state(sm);
		if (!s) return null;
		const wasRetry = s.retrying === true;
		s.retrying = false;
		if (!s.inflightFast) {
			// The retry at normal speed failed too, so the failure was not about fast mode (the model
			// isn't available, the chat is too long, ...): no cooldown, and the chat shows that error.
			if (wasRetry && m.stopReason === "error") {
				s.coolingUntil = undefined;
				s.reason = undefined;
			}
			return null;
		}
		const status = s.inflightStatus;
		s.inflightFast = false;
		s.inflightStatus = undefined;
		if (m.stopReason !== "error") return null;
		const reason = fastRefusalReason(status, m.errorMessage);
		if (!reason) return null;
		s.coolingUntil = this.now() + FAST_MODE_COOLDOWN_MS;
		s.reason = reason;
		s.refused = message;
		return reason;
	}

	/** Is the last reply of this run a refused fast reply that will be retried at normal speed?
	 *  (pi-web-ui treats the run's end like pi's own auto-retry then.) */
	retryPending(sm: FastModeSession, messages: readonly unknown[]): boolean {
		const s = this.state(sm);
		return !!s?.refused && sameMessage(lastAssistant(messages), s.refused);
	}

	/** agent_before_settle: take the refused reply that waits for its retry (at most once). */
	takeRefused(sm: FastModeSession): unknown {
		const s = this.state(sm);
		if (!s?.refused) return undefined;
		const m = s.refused;
		s.refused = undefined;
		return m;
	}

	/** The retry at normal speed is going out (its reply decides whether it was about fast mode). */
	noteRetrying(sm: FastModeSession): void {
		const s = this.state(sm);
		if (s) s.retrying = true;
	}

	/** agent_settled: the run is over; nothing of it waits for a retry any more. */
	noteSettled(sm: FastModeSession): void {
		const s = this.state(sm);
		if (!s) return;
		s.refused = undefined;
		s.retrying = false;
		s.inflightFast = false;
		s.inflightStatus = undefined;
	}

	/** Forget a session (tests). */
	clear(): void {
		this.states.clear();
	}
}

/** The one registry of this server process. */
export const fastModeRegistry = new FastModeRegistry();

type BranchEntry = { type?: unknown; id?: unknown; targetId?: unknown; message?: unknown };
type BoundaryLike = {
	entries: SessionBoundaryDraft[];
	outcome?: unknown;
	context?: { contextMessages?: readonly unknown[] };
};

/**
 * The boundary drafts that retry a refused fast reply once at normal speed: hide the failed attempt
 * from the model (a context edit, as pi's auto-retry does) and continue the run. Undefined when
 * there is nothing to retry — pi already retried it, the run was stopped, or the reply is gone.
 */
export function fastRetryBoundary(
	failed: unknown,
	event: BoundaryLike,
	branch: readonly unknown[],
): AgentBeforeSettleEventResult | undefined {
	if (!failed || event.outcome === "aborted") return undefined;
	const edited = new Set<unknown>();
	let targetId: string | undefined;
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i] as BranchEntry | undefined;
		if (!e) continue;
		if (e.type === "context_edit") {
			edited.add(e.targetId);
			continue;
		}
		if (e.type !== "message" || (e.message as MessageLike | undefined)?.role !== "assistant") continue;
		// Only when the refused reply is still the chat's last reply (pi's own retry would have added a newer one).
		if (sameMessage(e.message, failed) && typeof e.id === "string" && !edited.has(e.id)) targetId = e.id;
		break;
	}
	if (!targetId) return undefined;
	// The run can only go on if the reply before the failed one is not a reply itself.
	const msgs = event.context?.contextMessages;
	if (Array.isArray(msgs)) {
		let idx = -1;
		for (let i = msgs.length - 1; i >= 0; i--) {
			if (sameMessage(msgs[i], failed)) {
				idx = i;
				break;
			}
		}
		const prev = idx > 0 ? (msgs[idx - 1] as MessageLike | undefined) : undefined;
		if (idx < 1 || prev?.role === "assistant") return undefined;
	}
	return {
		entries: [...event.entries, { type: "context_edit", targetId, replacement: null }],
		continue: true,
	};
}

/** The hidden extension that sends fast mode and handles refusals (see the top of this file). */
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
			if (slow) console.warn(`[fast-mode] ${slow}: normal speed for 15 minutes`);
			const reason = registry.noteMessageEnd(ctx.sessionManager, event.message);
			// The server's own log line: no request contents, just what happened.
			if (reason) console.warn(`[fast-mode] ${reason}: normal speed for 15 minutes, retrying this reply once`);
			return undefined;
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
