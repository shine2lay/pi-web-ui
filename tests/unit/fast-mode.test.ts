import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	FAST_MODE_COOLDOWN_MS,
	FAST_MODE_ENTRY,
	FAST_MODE_MODELS,
	FastModeRegistry,
	fastModeEntryData,
	fastModeExtension,
	fastModeSupported,
	fastPriceTells,
	fastRefusalReason,
	fastRetryBoundary,
	fastTierFor,
	isChatSpeed,
	readFastModeFromSession,
	replyPriceMultiplier,
	speedSupported,
	type FastModeSession,
} from "../../server/fast-mode.js";
import type { ChatSpeed } from "../../server/protocol.js";
const ASTRA = { provider: "openai-codex", id: "gpt-6-astra" };
const SOL = { provider: "openai-codex", id: "gpt-5.6-sol" };
const CLAUDE = { provider: "anthropic", id: "claude-opus-5-5" };
const modes: ChatSpeed[] = ["standard", "fast", "ultrafast"];
const session = (id = "one", entries: unknown[] = []): FastModeSession => ({
	getSessionId: () => id,
	getEntries: () => entries,
});
const entry = (data: unknown) => ({ type: "custom", customType: FAST_MODE_ENTRY, data });
const failure = (errorMessage = "Unsupported service_tier", timestamp = 2) => ({
	role: "assistant",
	stopReason: "error",
	content: [],
	errorMessage,
	timestamp,
});
const ok = () => ({ role: "assistant", stopReason: "stop", content: [], timestamp: 3 });
function setup(mode: ChatSpeed = "ultrafast") {
	const clock = { now: 1000000 },
		reg = new FastModeRegistry(() => clock.now),
		sm = session();
	reg.setMode(sm, mode);
	return { reg, sm, clock };
}
function request(reg: FastModeRegistry, sm: FastModeSession, model = ASTRA) {
	return reg.rewritePayload(sm, model, { model: model.id }) as { service_tier?: string } | undefined;
}

describe("validated per-chat speed", () => {
	it("only ChatGPT's advertised fast models; Ultrafast only Astra", () => {
		for (const id of FAST_MODE_MODELS) expect(fastModeSupported({ provider: "openai-codex", id })).toBe(true);
		for (const provider of ["openai", "anthropic", "anthropic-2", "openrouter", "openai-codex-other"]) {
			expect(speedSupported({ provider, id: ASTRA.id }, "ultrafast")).toBe(false);
		}
		expect(speedSupported(SOL, "ultrafast")).toBe(false);
		expect(speedSupported(ASTRA, "ultrafast")).toBe(true);
		expect(fastModeSupported(null)).toBe(false);
		expect(fastModeSupported({ ...ASTRA, id: "gpt-5.6-terra" })).toBe(false);
		for (const bad of [undefined, null, true, "priority", "ULTRAFAST", {}, 1]) expect(isChatSpeed(bad)).toBe(false);
	});
	it.each(modes)("dispatches exactly %s without mutating the payload", (mode) => {
		const { reg, sm } = setup(mode),
			body = { model: ASTRA.id };
		const out = reg.rewritePayload(sm, ASTRA, body) as { service_tier?: string } | undefined;
		expect(out?.service_tier).toBe(mode === "standard" ? undefined : mode === "fast" ? "priority" : "ultrafast");
		expect(Object.hasOwn(body, "service_tier")).toBe(false);
		expect(reg.view(sm, ASTRA)?.effective).toBe(mode);
		expect(reg.view(sm, ASTRA)?.confirmedMode).toBeUndefined();
	});
	it("never upgrades saved Fast and never applies Ultrafast to another model", () => {
		expect(fastTierFor(ASTRA.id, "fast")).toBe("priority");
		expect(fastTierFor(SOL.id, "ultrafast")).toBeUndefined();
		expect(fastTierFor("unknown", "fast")).toBeUndefined();
		const { reg, sm } = setup();
		expect(request(reg, sm)?.service_tier).toBe("ultrafast");
		// Same hook is called after either manual model selection or automatic rotation.
		for (const model of [CLAUDE, { provider: "openai", id: ASTRA.id }, SOL]) {
			expect(request(reg, sm, model)?.service_tier).toBeUndefined();
		}
		expect(reg.view(sm, CLAUDE)).toBeNull();
		expect(reg.view(sm, SOL)?.effective).toBe("standard");
		expect(reg.view(sm, SOL)?.mode).toBe("ultrafast");
		expect(request(reg, sm)?.service_tier).toBe("ultrafast");
	});
	it("isolates chats and rejects side requests/malformed payloads", () => {
		const { reg, sm } = setup(),
			other = session("two");
		expect(reg.view(other, ASTRA)?.mode).toBe("standard");
		expect(request(reg, other)).toBeUndefined();
		expect(request(reg, sm)?.service_tier).toBe("ultrafast");
		for (const body of [null, [], "bad", { model: SOL.id }])
			expect(reg.rewritePayload(sm, ASTRA, body)).toBeUndefined();
		reg.setMode(sm, "standard");
		const out = reg.rewritePayload(sm, ASTRA, { model: ASTRA.id, service_tier: "ultrafast" }) as {
			service_tier?: string;
		};
		expect(out.service_tier).toBeUndefined();
	});
});

describe("speed changes between requests", () => {
	it.each(modes)("selects %s during a request without changing that request or accepting stale feedback", (mode) => {
		const { reg, sm } = setup(),
			inflight = request(reg, sm);
		reg.setMode(sm, mode);
		expect(inflight?.service_tier).toBe("ultrafast");
		expect(reg.view(sm, ASTRA)?.mode).toBe(mode);
		// Even reselecting the same tier is a new choice; old metadata cannot confirm or cool it.
		expect(reg.noteReplySpeed(sm, { ...ok(), service_tier: "default" }, ASTRA)).toBeNull();
		expect(reg.view(sm, ASTRA)?.confirmedMode).toBeUndefined();
		expect(reg.view(sm, ASTRA)?.coolingUntil).toBeUndefined();
		reg.noteMessageEnd(sm, ok());
		expect(request(reg, sm)?.service_tier).toBe(
			mode === "standard" ? undefined : mode === "fast" ? "priority" : "ultrafast",
		);
	});
	it("ignores a delayed refusal after switching away and back to the same speed", () => {
		const { reg, sm } = setup();
		request(reg, sm);
		reg.setMode(sm, "standard");
		reg.setMode(sm, "ultrafast");
		reg.noteResponse(sm, 400);
		expect(reg.noteMessageEnd(sm, failure())).toBeNull();
		expect(reg.takeRefused(sm)).toBeUndefined();
		expect(reg.view(sm, ASTRA)?.effective).toBe("ultrafast");
		expect(reg.view(sm, ASTRA)?.coolingUntil).toBeUndefined();
		expect(request(reg, sm)?.service_tier).toBe("ultrafast");
	});
	it("an explicit choice clears an old pending retry and fallback without waiting for settle", () => {
		const { reg, sm } = setup();
		request(reg, sm);
		reg.noteMessageEnd(sm, failure());
		reg.setMode(sm, "fast");
		expect(reg.takeRefused(sm)).toBeUndefined();
		expect(reg.view(sm, ASTRA)?.effective).toBe("fast");
		expect(reg.view(sm, ASTRA)?.coolingUntil).toBeUndefined();
		expect(request(reg, sm)?.service_tier).toBe("priority");
	});
	it("changing speed does not grant another automatic retry in the same run", () => {
		const { reg, sm } = setup();
		request(reg, sm);
		reg.noteMessageEnd(sm, failure());
		reg.takeRefused(sm);
		reg.noteRetrying(sm);
		reg.setMode(sm, "fast");
		request(reg, sm);
		reg.noteMessageEnd(sm, failure());
		expect(reg.takeRefused(sm)).toBeUndefined();
	});
});

describe("storage compatibility and copy safety", () => {
	it("legacy on=true stays Fast; absent, invalid or foreign data fail to Standard", () => {
		expect(readFastModeFromSession(session())).toBe("standard");
		expect(readFastModeFromSession(session("one", [entry({ on: true, sessionId: "one" })]))).toBe("fast");
		for (const data of [
			null,
			{},
			{ on: false, sessionId: "one" },
			{ on: "true", sessionId: "one" },
			{ mode: null, on: true, sessionId: "one" },
			{ mode: "priority", on: true, sessionId: "one" },
			{ mode: "ultrafast", sessionId: "other" },
			{ mode: "ultrafast" },
		]) {
			expect(readFastModeFromSession(session("one", [entry({ on: true, sessionId: "one" }), entry(data)]))).toBe(
				"standard",
			);
		}
	});
	it("new chats and broken managers are Standard", () => {
		const broken = {
			getSessionId: () => {
				throw new Error("closed");
			},
			getEntries: () => [],
		};
		expect(readFastModeFromSession(broken)).toBe("standard");
		expect(new FastModeRegistry().view(broken, ASTRA)).toBeNull();
	});
	it.each(modes)("%s survives disk reopen and registry restart; both copy methods start Standard", (mode) => {
		const dir = mkdtempSync(join(tmpdir(), "speed-session-"));
		try {
			const sm = SessionManager.create(dir, dir);
			expect(readFastModeFromSession(sm)).toBe("standard");
			sm.appendMessage({ role: "user", content: [], timestamp: 1 });
			sm.appendMessage(ok() as never);
			sm.appendCustomEntry(FAST_MODE_ENTRY, fastModeEntryData(sm, mode));
			const reopened = SessionManager.open(sm.getSessionFile()!, dir);
			expect(new FastModeRegistry().view(reopened, ASTRA)?.mode).toBe(mode);
			const copy = SessionManager.open(reopened.createBranchedSession(reopened.getLeafId()!)!, dir);
			expect(readFastModeFromSession(copy)).toBe("standard");
			const fork = SessionManager.forkFrom(sm.getSessionFile()!, dir, dir);
			expect(readFastModeFromSession(fork)).toBe("standard");
			sm.appendCustomEntry(FAST_MODE_ENTRY, fastModeEntryData(sm, "standard"));
			expect(readFastModeFromSession(SessionManager.open(sm.getSessionFile()!, dir))).toBe("standard");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("refusal, cooldown and one safe retry", () => {
	it.each(["fast", "ultrafast"] as ChatSpeed[])(
		"%s refuses once, Standard temporarily without changing saved choice",
		(mode) => {
			const { reg, sm, clock } = setup(mode),
				failed = failure();
			request(reg, sm);
			reg.noteResponse(sm, 400);
			expect(reg.noteMessageEnd(sm, failed)).toContain("HTTP 400");
			expect(reg.view(sm, ASTRA)?.mode).toBe(mode);
			expect(reg.view(sm, ASTRA)?.effective).toBe("standard");
			expect(reg.view(sm, ASTRA)?.coolingUntil).toBe(clock.now + FAST_MODE_COOLDOWN_MS);
			expect(reg.retryPending(sm, [{ role: "user" }, failed])).toBe(true);
			expect(reg.takeRefused(sm) === failed).toBe(true);
			reg.noteRetrying(sm);
			expect(reg.takeRefused(sm)).toBeUndefined();
			expect(request(reg, sm)).toBeUndefined();
			reg.noteMessageEnd(sm, failure());
			expect(reg.retryPending(sm, [failed])).toBe(false);
			// Even a long multi-tool run never opts itself back in during its retry.
			clock.now += FAST_MODE_COOLDOWN_MS + 1;
			expect(request(reg, sm)).toBeUndefined();
			reg.noteSettled(sm);
			expect(request(reg, sm)?.service_tier).toBe(mode === "fast" ? "priority" : "ultrafast");
		},
	);
	it("explicit Standard then Ultrafast clears an idle cooldown", () => {
		const { reg, sm } = setup();
		request(reg, sm);
		reg.noteMessageEnd(sm, failure());
		reg.noteSettled(sm);
		reg.setMode(sm, "standard");
		reg.setMode(sm, "ultrafast");
		expect(reg.view(sm, ASTRA)?.coolingUntil).toBeUndefined();
		expect(request(reg, sm)?.service_tier).toBe("ultrafast");
	});
	it("unrelated errors stay ordinary, including generic HTTP 400/403/model refusals", () => {
		for (const [status, text] of [
			[401, "Unauthorized"],
			[400, "maximum context length"],
			[403, "account disabled"],
			[400, "model not supported"],
			[undefined, "fetch failed"],
			[undefined, "WebSocket closed 1006"],
			[500, "Internal server error"],
			[undefined, "server overloaded"],
			[undefined, ""],
			[400, "Invalid token for service_tier"],
		] as const) {
			const { reg, sm } = setup();
			request(reg, sm);
			reg.noteResponse(sm, status);
			expect(reg.noteMessageEnd(sm, failure(text))).toBeNull();
			expect(reg.view(sm, ASTRA)?.effective).toBe("ultrafast");
		}
		expect(fastRefusalReason(undefined, "Ultrafast unavailable for this plan", "ultrafast")).toContain("Ultrafast");
		expect(fastRefusalReason(429, "usage limit reached")).toContain("429");
	});
	it("partial output or a tool call can cool down but never be retried", () => {
		for (const content of [
			[{ type: "text", text: "partial" }],
			[{ type: "toolCall", id: "call" }],
			[{ type: "thinking", thinking: "partial" }],
		]) {
			const { reg, sm } = setup();
			request(reg, sm);
			reg.noteMessageEnd(sm, { ...failure(), content });
			expect(reg.view(sm, ASTRA)?.effective).toBe("standard");
			expect(reg.takeRefused(sm)).toBeUndefined();
		}
	});
	it("retries only an empty last failed attempt, retaining prior tool results", () => {
		const failed = failure(),
			user = { role: "user" },
			tool = { role: "toolResult" };
		const branch = [
			{ type: "message", id: "u", message: user },
			{ type: "message", id: "a", message: failed },
		];
		const ev = { entries: [], outcome: "error", context: { contextMessages: [user, failed] } };
		const result = fastRetryBoundary(failed, ev, branch);
		expect(result?.continue).toBe(true);
		expect(result?.entries?.length).toBe(1);
		expect((result?.entries?.[0] as { targetId?: string }).targetId).toBe("a");
		expect(fastRetryBoundary(failed, { ...ev, context: { contextMessages: [tool, failed] } }, branch)?.continue).toBe(
			true,
		);
		for (const outcome of ["aborted", "success"])
			expect(fastRetryBoundary(failed, { ...ev, outcome }, branch)).toBeUndefined();
		for (const messages of [[failed], [ok(), failed], [user, failed, ok()]])
			expect(fastRetryBoundary(failed, { ...ev, context: { contextMessages: messages } }, branch)).toBeUndefined();
		expect(fastRetryBoundary(failed, ev, [...branch, { type: "context_edit", targetId: "a" }])).toBeUndefined();
		expect(fastRetryBoundary(failed, ev, [...branch, { type: "message", id: "u2", message: user }])).toBeUndefined();
	});
});

describe("honest tier reporting", () => {
	it("GPT-6 price proves nothing; missing/unknown tier remains unconfirmed", () => {
		const { reg, sm } = setup(),
			priced = { ...ASTRA, cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 0 } };
		for (const tier of [undefined, "new-unknown-tier"]) {
			request(reg, sm);
			expect(
				reg.noteReplySpeed(sm, { ...ok(), service_tier: tier, usage: { input: 1000, cost: { total: 0.004 } } }, priced),
			).toBeNull();
			expect(reg.view(sm, ASTRA)?.confirmedMode).toBeUndefined();
		}
		expect(fastPriceTells(ASTRA.id)).toBe(false);
		expect(fastPriceTells("gpt-6.1-sol")).toBe(false);
	});
	it("returned metadata confirms only that reply; a mismatch cools without retrying", () => {
		const { reg, sm } = setup();
		request(reg, sm);
		reg.noteReplySpeed(sm, { ...ok(), service_tier: "ultrafast" }, ASTRA);
		expect(reg.view(sm, ASTRA)?.confirmedMode).toBe("ultrafast");
		expect(reg.view(sm, SOL)?.confirmedMode).toBeUndefined();
		request(reg, sm);
		expect(reg.view(sm, ASTRA)?.confirmedMode).toBeUndefined();
		expect(reg.noteReplySpeed(sm, { ...ok(), service_tier: "default" }, ASTRA)).toContain("Standard");
		expect(reg.view(sm, ASTRA)?.effective).toBe("standard");
		expect(reg.takeRefused(sm)).toBeUndefined();
	});
	it("legacy GPT-5 price downgrade still works, never for a different model", () => {
		const { reg, sm } = setup("fast"),
			priced = { ...SOL, cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 0 } };
		const reply = { ...ok(), model: SOL.id, usage: { input: 1000, cost: { total: 0.004 } } };
		expect(replyPriceMultiplier(reply, priced)).toBe(1);
		request(reg, sm, SOL);
		expect(reg.noteReplySpeed(sm, reply, ASTRA)).toBeNull();
		expect(reg.noteReplySpeed(sm, reply, priced)).toContain("Standard");
	});
	it("the supported extension hooks use the registry and reset at settle", () => {
		const { reg, sm } = setup();
		type Handler = (event: unknown, ctx: unknown) => unknown;
		const hooks = new Map<string, Handler>();
		fastModeExtension(reg)({ on: (name: string, handler: Handler) => hooks.set(name, handler) } as never);
		const ctx = { sessionManager: { ...sm, getBranch: () => [] }, model: ASTRA };
		const out = hooks.get("before_provider_request")!({ payload: { model: ASTRA.id } }, ctx) as {
			service_tier: string;
		};
		expect(out.service_tier).toBe("ultrafast");
		hooks.get("after_provider_response")!({ status: 400 }, ctx);
		hooks.get("message_end")!({ message: failure() }, ctx);
		hooks.get("agent_settled")!({}, ctx);
		expect(reg.takeRefused(sm)).toBeUndefined();
	});
});
