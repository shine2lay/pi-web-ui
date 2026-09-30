/**
 * fast-mode: the per-chat "⚡ Fast" button for ChatGPT (openai-codex) chats (server/fast-mode.ts).
 *  - which chats get the button (openai-codex fast-mode models only; never Claude or others);
 *  - the request gets the fast tier only when the chat has it on, its model has fast mode, and fast
 *    is not cooling down;
 *  - a refused fast request: normal speed for 15 minutes with the reason, one retry at normal speed,
 *    and fast again after the cooldown (or right away after off-and-on);
 *  - the choice is saved with the chat (survives a reload), new chats and copies start off.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	FAST_MODE_COOLDOWN_MS,
	FAST_MODE_ENTRY,
	FAST_MODE_MODELS,
	FAST_MODE_SLOW_REASON,
	FastModeRegistry,
	fastPriceTells,
	fastModeEntryData,
	fastModeExtension,
	fastModeSupported,
	fastRefusalReason,
	fastRetryBoundary,
	readFastModeFromSession,
	replyPriceMultiplier,
	type FastModeSession,
} from "../../server/fast-mode.js";

const SOL = { provider: "openai-codex", id: "gpt-5.6-sol" };
const GPT6 = { provider: "openai-codex", id: "gpt-6-sol" };
const TERRA = { provider: "openai-codex", id: "gpt-5.6-terra" };
const CLAUDE = { provider: "anthropic", id: "claude-opus-4-8" };
const CLAUDE2 = { provider: "anthropic-2", id: "claude-opus-4-8" };

/** A session manager stand-in: an id and the entries the registry reads the saved choice from. */
function fakeSession(id: string, entries: unknown[] = []): FastModeSession {
	return { getSessionId: () => id, getEntries: () => entries };
}

function assistantError(errorMessage: string, timestamp = Date.now()) {
	return { role: "assistant", stopReason: "error", errorMessage, content: [], timestamp };
}

function assistantOk(text = "hi", timestamp = Date.now()) {
	return { role: "assistant", stopReason: "stop", content: [{ type: "text", text }], timestamp };
}

/** A registry with a clock the test moves. */
function registryAt(start = 1_000_000) {
	const clock = { now: start };
	return { reg: new FastModeRegistry(() => clock.now), clock };
}

describe("fast-mode: which chats get the button", () => {
	it("openai-codex models from the list only", () => {
		for (const id of FAST_MODE_MODELS) expect(fastModeSupported({ provider: "openai-codex", id }), id).toBe(true);
		expect(fastModeSupported(SOL)).toBe(true);
		expect(fastModeSupported(GPT6)).toBe(true);
		// Left out until a live check shows them running fast.
		expect(fastModeSupported(TERRA)).toBe(false);
		expect(fastModeSupported({ provider: "openai-codex", id: "gpt-5.3-codex-spark" })).toBe(false);
	});

	it("never Claude or any other provider, even with a listed model id", () => {
		expect(fastModeSupported(CLAUDE)).toBe(false);
		expect(fastModeSupported(CLAUDE2)).toBe(false);
		expect(fastModeSupported({ provider: "anthropic", id: "gpt-5.6-sol" })).toBe(false);
		expect(fastModeSupported({ provider: "openai", id: "gpt-5.6-sol" })).toBe(false);
		expect(fastModeSupported({ provider: "openrouter", id: "gpt-5.5" })).toBe(false);
		expect(fastModeSupported(null)).toBe(false);
		expect(fastModeSupported(undefined)).toBe(false);
	});

	it("the button's state: off in a new chat, null (no button) for unsupported models", () => {
		const { reg } = registryAt();
		const sm = fakeSession("s1");
		expect(reg.view(sm, SOL)).toEqual({ on: false });
		expect(reg.view(sm, GPT6)).toEqual({ on: false });
		expect(reg.view(sm, CLAUDE)).toBeNull();
		expect(reg.view(sm, TERRA)).toBeNull();
		expect(reg.view(sm, null)).toBeNull();
	});

	it("switching to an unsupported model hides it; switching back shows the saved state", () => {
		const { reg } = registryAt();
		const sm = fakeSession("s1");
		reg.setOn(sm, true);
		expect(reg.view(sm, SOL)).toEqual({ on: true });
		expect(reg.view(sm, CLAUDE)).toBeNull();
		expect(reg.rewritePayload(sm, CLAUDE, { model: CLAUDE.id })).toBeUndefined();
		expect(reg.view(sm, SOL)).toEqual({ on: true });
	});
});

describe("fast-mode: the request rewrite", () => {
	it("adds the fast tier only when on, supported and not cooling down", () => {
		const { reg } = registryAt();
		const sm = fakeSession("s1");
		const payload = { model: SOL.id, input: [], stream: true };
		// Off: nothing changes.
		expect(reg.rewritePayload(sm, SOL, payload)).toBeUndefined();
		reg.setOn(sm, true);
		const out = reg.rewritePayload(sm, SOL, payload) as Record<string, unknown>;
		expect(out.service_tier).toBe("priority");
		expect(out.model).toBe(SOL.id);
		// The original payload object is left alone.
		expect((payload as Record<string, unknown>).service_tier).toBeUndefined();
		// GPT-6 models too.
		expect((reg.rewritePayload(sm, GPT6, { model: GPT6.id }) as Record<string, unknown>).service_tier).toBe("priority");
	});

	it("never on Claude or other providers, even with fast on", () => {
		const { reg } = registryAt();
		const sm = fakeSession("s1");
		reg.setOn(sm, true);
		expect(reg.rewritePayload(sm, CLAUDE, { model: CLAUDE.id, messages: [] })).toBeUndefined();
		expect(reg.rewritePayload(sm, CLAUDE2, { model: CLAUDE2.id, messages: [] })).toBeUndefined();
		expect(reg.rewritePayload(sm, { provider: "openai", id: "gpt-5.6-sol" }, { model: "gpt-5.6-sol" })).toBeUndefined();
		expect(reg.rewritePayload(sm, TERRA, { model: TERRA.id })).toBeUndefined();
	});

	it("leaves side requests for another model and odd payloads alone", () => {
		const { reg } = registryAt();
		const sm = fakeSession("s1");
		reg.setOn(sm, true);
		expect(reg.rewritePayload(sm, SOL, { model: "gpt-5.5-mini" })).toBeUndefined();
		expect(reg.rewritePayload(sm, SOL, null)).toBeUndefined();
		expect(reg.rewritePayload(sm, SOL, [1, 2])).toBeUndefined();
		expect(reg.rewritePayload(sm, SOL, "text")).toBeUndefined();
	});

	it("each chat has its own switch", () => {
		const { reg } = registryAt();
		const a = fakeSession("a");
		const b = fakeSession("b");
		reg.setOn(a, true);
		expect(reg.rewritePayload(a, SOL, { model: SOL.id })).toBeDefined();
		expect(reg.rewritePayload(b, SOL, { model: SOL.id })).toBeUndefined();
		expect(reg.view(b, SOL)).toEqual({ on: false });
	});
});

describe("fast-mode: when ChatGPT refuses fast mode", () => {
	it("a refusal: normal speed for 15 minutes with the reason, one retry, then fast again", () => {
		const { reg, clock } = registryAt();
		const sm = fakeSession("s1");
		reg.setOn(sm, true);
		expect(reg.rewritePayload(sm, SOL, { model: SOL.id })).toBeDefined();
		reg.noteResponse(sm, 400);
		const failed = assistantError("Unsupported value: 'service_tier'", clock.now);
		expect(reg.noteMessageEnd(sm, failed)).toBe("ChatGPT refused fast mode (HTTP 400)");

		// The button: still on, but at normal speed for now, with the reason.
		expect(reg.view(sm, SOL)).toEqual({
			on: true,
			coolingUntil: clock.now + FAST_MODE_COOLDOWN_MS,
			reason: "ChatGPT refused fast mode (HTTP 400)",
		});
		// The run ends on the refused reply: it will be retried (treated like pi's own retry).
		const messages = [{ role: "user", content: "hi", timestamp: 1 }, failed];
		expect(reg.retryPending(sm, messages)).toBe(true);
		// Taken once for the retry, never twice.
		expect(reg.takeRefused(sm)).toBe(failed);
		expect(reg.takeRefused(sm)).toBeUndefined();
		expect(reg.retryPending(sm, messages)).toBe(false);

		// The retry (and every request during the cooldown) goes out at normal speed.
		expect(reg.rewritePayload(sm, SOL, { model: SOL.id })).toBeUndefined();
		expect(reg.noteMessageEnd(sm, assistantOk())).toBeNull();
		clock.now += FAST_MODE_COOLDOWN_MS - 1;
		expect(reg.rewritePayload(sm, SOL, { model: SOL.id })).toBeUndefined();
		expect(reg.view(sm, SOL)?.reason).toBe("ChatGPT refused fast mode (HTTP 400)");

		// After the cooldown: fast again, the reason is gone.
		clock.now += 2;
		expect(reg.view(sm, SOL)).toEqual({ on: true });
		expect((reg.rewritePayload(sm, SOL, { model: SOL.id }) as Record<string, unknown>).service_tier).toBe("priority");
	});

	it("turning it off and on again clears the cooldown", () => {
		const { reg, clock } = registryAt();
		const sm = fakeSession("s1");
		reg.setOn(sm, true);
		reg.rewritePayload(sm, SOL, { model: SOL.id });
		reg.noteResponse(sm, 403);
		expect(reg.noteMessageEnd(sm, assistantError("forbidden", clock.now))).toBe("ChatGPT refused fast mode (HTTP 403)");
		expect(reg.view(sm, SOL)?.coolingUntil).toBeDefined();
		reg.setOn(sm, false);
		expect(reg.view(sm, SOL)).toEqual({ on: false });
		reg.setOn(sm, true);
		expect(reg.view(sm, SOL)).toEqual({ on: true });
		expect(reg.rewritePayload(sm, SOL, { model: SOL.id })).toBeDefined();
	});

	it("errors that are not about the tier start no cooldown", () => {
		const { reg } = registryAt();
		const sm = fakeSession("s1");
		reg.setOn(sm, true);
		for (const [status, text] of [
			[401, "Unauthorized"],
			[500, "Internal server error"],
			[undefined, "Codex error: The server is overloaded"],
			[undefined, "WebSocket closed 1006"],
			[undefined, "Your input exceeds the context window of this model"],
			[undefined, "401 Unauthorized: token expired"],
			[400, "This model's maximum context length is 400000 tokens"],
		] as const) {
			reg.rewritePayload(sm, SOL, { model: SOL.id });
			if (status !== undefined) reg.noteResponse(sm, status);
			expect(reg.noteMessageEnd(sm, assistantError(text)), text).toBeNull();
			expect(reg.view(sm, SOL), text).toEqual({ on: true });
		}
	});

	it("a failed request that went out at normal speed is not a refusal", () => {
		const { reg } = registryAt();
		const sm = fakeSession("s1");
		// Off: the request had no tier.
		reg.rewritePayload(sm, SOL, { model: SOL.id });
		reg.noteResponse(sm, 400);
		expect(reg.noteMessageEnd(sm, assistantError("400 bad request"))).toBeNull();
		// On, but on Claude: no tier either.
		reg.setOn(sm, true);
		reg.rewritePayload(sm, CLAUDE, { model: CLAUDE.id });
		reg.noteResponse(sm, 400);
		expect(reg.noteMessageEnd(sm, assistantError("400 bad request"))).toBeNull();
		expect(reg.view(sm, SOL)).toEqual({ on: true });
	});

	it("the WebSocket transport reports no status: the error text decides", () => {
		expect(fastRefusalReason(undefined, "Codex error: 400 Unsupported service_tier")).toBe(
			"ChatGPT refused fast mode (HTTP 400)",
		);
		expect(fastRefusalReason(undefined, "Codex error: Unsupported value for service_tier")).toBe(
			"ChatGPT refused fast mode (Unsupported value for service_tier)",
		);
		expect(fastRefusalReason(undefined, "Rate limit reached, too many requests")).toBe(
			"ChatGPT refused fast mode (HTTP 429)",
		);
		expect(fastRefusalReason(429, "You have hit your ChatGPT usage limit")).toBe(
			"ChatGPT refused fast mode (HTTP 429)",
		);
		expect(fastRefusalReason(undefined, "Codex error: 503 Service Unavailable")).toBeNull();
		expect(fastRefusalReason(undefined, "fetch failed")).toBeNull();
		expect(fastRefusalReason(undefined, "")).toBe("ChatGPT refused fast mode");
		const long = fastRefusalReason(undefined, `Codex error: ${"x".repeat(200)}`);
		expect(long!.length).toBeLessThan(120);
	});

	it("a successful fast reply changes nothing", () => {
		const { reg } = registryAt();
		const sm = fakeSession("s1");
		reg.setOn(sm, true);
		reg.rewritePayload(sm, SOL, { model: SOL.id });
		reg.noteResponse(sm, 200);
		expect(reg.noteMessageEnd(sm, assistantOk())).toBeNull();
		expect(reg.view(sm, SOL)).toEqual({ on: true });
		expect(reg.takeRefused(sm)).toBeUndefined();
	});

	it("the retry at normal speed fails too: it was not about fast mode, so no cooldown", () => {
		const { reg, clock } = registryAt();
		const sm = fakeSession("s1");
		reg.setOn(sm, true);
		reg.rewritePayload(sm, SOL, { model: SOL.id });
		const failed = assistantError("Codex error: The 'gpt-5.6-sol' model is not supported", clock.now);
		expect(reg.noteMessageEnd(sm, failed)).not.toBeNull();
		expect(reg.takeRefused(sm)).toBe(failed);
		reg.noteRetrying(sm);
		// The retry went out at normal speed and failed the same way.
		expect(reg.rewritePayload(sm, SOL, { model: SOL.id })).toBeUndefined();
		expect(reg.noteMessageEnd(sm, assistantError("Codex error: The 'gpt-5.6-sol' model is not supported"))).toBeNull();
		// The button stays plainly on (the chat shows the real error), and the next request is fast again.
		expect(reg.view(sm, SOL)).toEqual({ on: true });
		expect(reg.rewritePayload(sm, SOL, { model: SOL.id })).toBeDefined();
	});

	it("a retry that works keeps the cooldown; the run's end forgets what waited for a retry", () => {
		const { reg, clock } = registryAt();
		const sm = fakeSession("s1");
		reg.setOn(sm, true);
		reg.rewritePayload(sm, SOL, { model: SOL.id });
		reg.noteResponse(sm, 400);
		const failed = assistantError("nope", clock.now);
		reg.noteMessageEnd(sm, failed);
		reg.takeRefused(sm);
		reg.noteRetrying(sm);
		reg.rewritePayload(sm, SOL, { model: SOL.id });
		expect(reg.noteMessageEnd(sm, assistantOk())).toBeNull();
		expect(reg.view(sm, SOL)?.reason).toBe("ChatGPT refused fast mode (HTTP 400)");
		// A refusal the run never retried (stopped) is dropped when the run settles.
		clock.now += FAST_MODE_COOLDOWN_MS + 1;
		reg.rewritePayload(sm, SOL, { model: SOL.id });
		const again = assistantError("Codex error: 400 nope", clock.now);
		reg.noteMessageEnd(sm, again);
		reg.noteSettled(sm);
		expect(reg.takeRefused(sm)).toBeUndefined();
		expect(reg.retryPending(sm, [again])).toBe(false);
	});

	it("the run is not treated as retrying when the refused reply is not its last reply", () => {
		const { reg } = registryAt();
		const sm = fakeSession("s1");
		reg.setOn(sm, true);
		reg.rewritePayload(sm, SOL, { model: SOL.id });
		const failed = assistantError("Codex error: 400 nope", 5);
		reg.noteMessageEnd(sm, failed);
		// pi's own retry already answered: a newer reply ends the run.
		expect(reg.retryPending(sm, [failed, { role: "user", content: "x", timestamp: 6 }, assistantOk("ok", 7)])).toBe(
			false,
		);
		expect(reg.retryPending(sm, [{ role: "user", content: "x", timestamp: 4 }, failed])).toBe(true);
	});
});

describe("fast-mode: ChatGPT answers a fast request at normal speed", () => {
	// gpt-5.6-sol's prices (per million tokens); pi prices a reply by the tier ChatGPT reports.
	const PRICED = { ...SOL, cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 0 } };
	const base = (1000 * 4 + 200 * 20 + 500 * 0.4) / 1e6;
	const reply = (multiplier: number) => ({
		...assistantOk(),
		usage: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 0, cost: { total: base * multiplier } },
	});

	it("reads the price multiplier pi applied", () => {
		expect(replyPriceMultiplier(reply(2), PRICED)).toBeCloseTo(2);
		expect(replyPriceMultiplier(reply(1), PRICED)).toBeCloseTo(1);
		// No prices or no tokens: can't tell.
		expect(replyPriceMultiplier(reply(1), SOL)).toBeUndefined();
		expect(replyPriceMultiplier(assistantOk(), PRICED)).toBeUndefined();
		// The long-chat price step, like pi's calculateCost.
		const tiered = {
			cost: {
				...PRICED.cost,
				tiers: [{ inputTokensAbove: 1200, input: 8, output: 40, cacheRead: 0.8, cacheWrite: 0 }],
			},
		};
		expect(replyPriceMultiplier(reply(2), tiered)).toBeCloseTo(1);
	});

	it("a fast request answered at the normal rate: normal speed for now, no retry, fast again later", () => {
		const { reg, clock } = registryAt();
		const sm = fakeSession("s1");
		reg.setOn(sm, true);
		reg.rewritePayload(sm, SOL, { model: SOL.id });
		const slow = reply(1);
		expect(reg.noteReplySpeed(sm, slow, PRICED)).toBe(FAST_MODE_SLOW_REASON);
		expect(reg.noteMessageEnd(sm, slow)).toBeNull();
		expect(reg.takeRefused(sm)).toBeUndefined();
		expect(reg.view(sm, SOL)).toEqual({
			on: true,
			coolingUntil: clock.now + FAST_MODE_COOLDOWN_MS,
			reason: FAST_MODE_SLOW_REASON,
		});
		expect(reg.rewritePayload(sm, SOL, { model: SOL.id })).toBeUndefined();
		clock.now += FAST_MODE_COOLDOWN_MS + 1;
		expect(reg.rewritePayload(sm, SOL, { model: SOL.id })).toBeDefined();
	});

	it("GPT-6 models report a fast reply as 'fast', which pi prices normally: the price tells nothing", () => {
		const { reg } = registryAt();
		const sm = fakeSession("s1");
		const PRICED6 = { ...GPT6, cost: PRICED.cost };
		reg.setOn(sm, true);
		reg.rewritePayload(sm, PRICED6, { model: GPT6.id });
		expect(reg.noteReplySpeed(sm, reply(1), PRICED6)).toBeNull();
		reg.noteMessageEnd(sm, reply(1));
		expect(reg.view(sm, GPT6)).toEqual({ on: true });
		// A reply from another model than the one whose prices are at hand: can't tell either.
		reg.rewritePayload(sm, PRICED, { model: SOL.id });
		expect(reg.noteReplySpeed(sm, { ...reply(1), model: "gpt-5.6-luna" }, PRICED)).toBeNull();
		expect(fastPriceTells("gpt-5.6-sol")).toBe(true);
		expect(fastPriceTells("gpt-5.5")).toBe(true);
		expect(fastPriceTells("gpt-6-sol")).toBe(false);
		expect(fastPriceTells("gpt-6.1-sol")).toBe(false);
	});

	it("a reply at the fast rate, a request sent at normal speed, or no prices: nothing changes", () => {
		const { reg } = registryAt();
		const sm = fakeSession("s1");
		reg.setOn(sm, true);
		reg.rewritePayload(sm, SOL, { model: SOL.id });
		expect(reg.noteReplySpeed(sm, reply(2), PRICED)).toBeNull();
		reg.noteMessageEnd(sm, reply(2));
		reg.rewritePayload(sm, SOL, { model: SOL.id });
		expect(reg.noteReplySpeed(sm, reply(1), SOL)).toBeNull();
		expect(reg.noteReplySpeed(sm, { ...reply(1), stopReason: "aborted" }, PRICED)).toBeNull();
		reg.noteMessageEnd(sm, reply(1));
		// Off: the request had no tier.
		reg.setOn(sm, false);
		reg.rewritePayload(sm, SOL, { model: SOL.id });
		expect(reg.noteReplySpeed(sm, reply(1), PRICED)).toBeNull();
		reg.setOn(sm, true);
		expect(reg.view(sm, SOL)).toEqual({ on: true });
	});
});

describe("fast-mode: the one retry at normal speed (agent_before_settle)", () => {
	const user = { role: "user", content: "hi", timestamp: 1 };
	const failed = assistantError("Codex error: 400 nope", 2);
	const branch = (extra: unknown[] = []) => [
		{ type: "message", id: "u1", message: user },
		{ type: "message", id: "a1", message: failed },
		...extra,
	];
	const event = (outcome = "error", contextMessages: unknown[] = [user, failed]) => ({
		entries: [],
		outcome,
		context: { contextMessages },
	});

	it("hides the refused reply from the model and carries on", () => {
		expect(fastRetryBoundary(failed, event(), branch())).toEqual({
			entries: [{ type: "context_edit", targetId: "a1", replacement: null }],
			continue: true,
		});
	});

	it("keeps drafts other hooks already made", () => {
		const other = { type: "context_edit", targetId: "x", replacement: null };
		const res = fastRetryBoundary(failed, { ...event(), entries: [other as never] }, branch());
		expect(res?.entries).toEqual([other, { type: "context_edit", targetId: "a1", replacement: null }]);
	});

	it("no retry when the user stopped the run", () => {
		expect(fastRetryBoundary(failed, event("aborted"), branch())).toBeUndefined();
	});

	it("no retry when a newer reply exists (pi retried it already) or it was hidden before", () => {
		const newer = { type: "message", id: "a2", message: assistantOk("ok", 3) };
		expect(fastRetryBoundary(failed, event(), branch([newer]))).toBeUndefined();
		const hidden = { type: "context_edit", id: "e1", targetId: "a1", replacement: null };
		expect(fastRetryBoundary(failed, event(), branch([hidden]))).toBeUndefined();
	});

	it("no retry when the model would see two replies in a row", () => {
		const prev = assistantOk("before", 0);
		expect(fastRetryBoundary(failed, event("error", [prev, failed]), branch())).toBeUndefined();
		expect(fastRetryBoundary(failed, event("error", [failed]), branch())).toBeUndefined();
	});

	it("nothing to retry", () => {
		expect(fastRetryBoundary(undefined, event(), branch())).toBeUndefined();
	});
});

describe("fast-mode: the hidden extension", () => {
	type Handler = (event: unknown, ctx: unknown) => unknown;
	function load(reg: FastModeRegistry) {
		const handlers = new Map<string, Handler>();
		fastModeExtension(reg)({ on: (name: string, fn: Handler) => handlers.set(name, fn) } as never);
		return handlers;
	}

	it("rewrites through before_provider_request and retries a refusal once", () => {
		const { reg } = registryAt();
		const h = load(reg);
		expect([...h.keys()].sort()).toEqual([
			"after_provider_response",
			"agent_before_settle",
			"agent_settled",
			"before_provider_request",
			"message_end",
		]);
		const user = { role: "user", content: "hi", timestamp: 1 };
		const failed = assistantError("Codex error: 400 nope", 2);
		const entries: unknown[] = [];
		const sm = {
			getSessionId: () => "s-ext",
			getEntries: () => entries,
			getBranch: () => [
				{ type: "message", id: "u1", message: user },
				{ type: "message", id: "a1", message: failed },
			],
		};
		const codexCtx = { model: SOL, sessionManager: sm };
		const claudeCtx = { model: CLAUDE, sessionManager: sm };
		reg.setOn(sm, true);
		// Claude: never.
		expect(h.get("before_provider_request")!({ payload: { model: CLAUDE.id } }, claudeCtx)).toBeUndefined();
		// ChatGPT fast model: the tier.
		const out = h.get("before_provider_request")!({ payload: { model: SOL.id } }, codexCtx) as Record<string, unknown>;
		expect(out.service_tier).toBe("priority");
		h.get("after_provider_response")!({ status: 400, headers: {} }, codexCtx);
		h.get("message_end")!({ message: failed }, codexCtx);
		const settle = h.get("agent_before_settle")!;
		const ev = { entries: [], outcome: "error", context: { contextMessages: [user, failed] } };
		expect(settle(ev, codexCtx)).toEqual({
			entries: [{ type: "context_edit", targetId: "a1", replacement: null }],
			continue: true,
		});
		// Only once.
		expect(settle(ev, codexCtx)).toBeUndefined();
		// The retry goes out at normal speed.
		expect(h.get("before_provider_request")!({ payload: { model: SOL.id } }, codexCtx)).toBeUndefined();
	});
});

describe("fast-mode: saved with the chat", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fast-mode-test-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** A chat on disk: pi writes the file once the first reply is in. */
	function chat() {
		const sm = SessionManager.create(dir, dir);
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });
		sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: Date.now() } as never);
		return sm;
	}

	it("a new chat starts off", () => {
		expect(readFastModeFromSession(SessionManager.create(dir, dir))).toBe(false);
		expect(readFastModeFromSession(chat())).toBe(false);
	});

	it("the choice survives a reload (the file opened again), the latest choice wins", () => {
		const sm = chat();
		sm.appendCustomEntry(FAST_MODE_ENTRY, fastModeEntryData(sm, true));
		const file = sm.getSessionFile()!;
		expect(readFastModeFromSession(SessionManager.open(file, dir))).toBe(true);
		// A fresh registry (a pi-web-ui restart) loads it from the file.
		const { reg } = registryAt();
		expect(reg.view(SessionManager.open(file, dir), SOL)).toEqual({ on: true });
		sm.appendCustomEntry(FAST_MODE_ENTRY, fastModeEntryData(sm, false));
		expect(readFastModeFromSession(SessionManager.open(file, dir))).toBe(false);
		sm.appendCustomEntry(FAST_MODE_ENTRY, fastModeEntryData(sm, true));
		expect(readFastModeFromSession(SessionManager.open(file, dir))).toBe(true);
	});

	it("a copy of the chat starts off (its entries name the original chat)", () => {
		const sm = chat();
		sm.appendCustomEntry(FAST_MODE_ENTRY, fastModeEntryData(sm, true));
		const copyFile = SessionManager.open(sm.getSessionFile()!, dir).createBranchedSession(sm.getLeafId()!)!;
		const copy = SessionManager.open(copyFile, dir);
		expect(copy.getSessionId()).not.toBe(sm.getSessionId());
		expect(copy.getEntries().some((e) => e.type === "custom" && e.customType === FAST_MODE_ENTRY)).toBe(true);
		expect(readFastModeFromSession(copy)).toBe(false);
		const { reg } = registryAt();
		expect(reg.view(copy, SOL)).toEqual({ on: false });
		// A copy into another folder, too.
		const other = mkdtempSync(join(tmpdir(), "fast-mode-other-"));
		try {
			const moved = SessionManager.forkFrom(sm.getSessionFile()!, other, other);
			expect(readFastModeFromSession(moved)).toBe(false);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("a broken session manager reads as off", () => {
		const broken = {
			getSessionId: () => {
				throw new Error("gone");
			},
			getEntries: () => [],
		};
		expect(readFastModeFromSession(broken)).toBe(false);
		const { reg } = registryAt();
		expect(reg.view(broken, SOL)).toBeNull();
		expect(reg.rewritePayload(broken, SOL, { model: SOL.id })).toBeUndefined();
	});
});
