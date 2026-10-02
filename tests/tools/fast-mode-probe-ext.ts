/**
 * fast-mode live probe: a pi extension used by `tests/tools/fast-mode-probe.mjs` (never loaded by
 * pi-web-ui itself). It runs pi-web-ui's own fast-mode extension (`server/fast-mode.ts`) inside a
 * one-off `pi -p` run and writes NUMBERS ONLY to $FAST_PROBE_OUT (one JSON line per event): whether
 * each request carried the fast tier, its HTTP status, the reply's stop reason, tokens, cost and the
 * price multiplier pi applied, timings, and the button's reason after a refusal. It never records
 * request bodies, prompts or replies.
 *
 * Env:
 *   FAST_PROBE_OUT    file to append the JSON lines to (required)
 *   FAST_PROBE_MODE   standard | fast | ultrafast (no forced models or arbitrary tiers)
 *   FAST_PROBE_SSE=1  (with the SSE transport) also record the tier ChatGPT reports back for each
 *                     reply: only that one field of the response is read, nothing else is kept
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FastModeRegistry, fastModeExtension, isChatSpeed } from "../../server/fast-mode.ts";

const OUT = process.env.FAST_PROBE_OUT ?? "";
const mode = process.env.FAST_PROBE_MODE;
const MODE = isChatSpeed(mode) ? mode : "standard";

class ProbeRegistry extends FastModeRegistry {
	// This disposable probe has a strict request budget: report a refusal, never retry it.
	override takeRefused(): unknown {
		return undefined;
	}
}

function write(line: Record<string, unknown>): void {
	if (OUT) appendFileSync(OUT, `${JSON.stringify({ t: Date.now(), ...line })}\n`);
}

/** SSE transport: read the `service_tier` ChatGPT reports in its reply stream (only that field). */
function watchReportedTier(): void {
	const orig = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const res = await orig(input, init);
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!url.includes("/codex/responses") || !res.body) return res;
		const [mine, theirs] = res.body.tee();
		void (async () => {
			const reader = theirs.getReader();
			const dec = new TextDecoder();
			let tail = "";
			let tier: string | null = null;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				const text = tail + dec.decode(value, { stream: true });
				for (const m of text.matchAll(/"service_tier"\s*:\s*"([a-z_]+)"/g)) tier = m[1] ?? tier;
				tail = text.slice(-64);
			}
			write({ kind: "reported", tier });
		})().catch(() => write({ kind: "reported", tier: "unreadable" }));
		return new Response(mine, { status: res.status, statusText: res.statusText, headers: res.headers });
	};
}

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };
type Cost = { input: number; output: number; cacheRead: number; cacheWrite: number };

export default function (pi: ExtensionAPI): void {
	if (process.env.FAST_PROBE_SSE === "1") watchReportedTier();
	const registry = new ProbeRegistry();
	let started = false;
	let firstUpdate: number | undefined;
	let requestAt: number | undefined;

	pi.on("before_agent_start", (_event, ctx) => {
		if (!started) {
			started = true;
			registry.setMode(ctx.sessionManager, MODE);
		}
		return undefined;
	});
	// pi-web-ui's extension first: the probe's own handlers see what it did.
	fastModeExtension(registry)(pi);
	pi.on("before_provider_request", (event) => {
		const p = event.payload as Record<string, unknown> | null;
		const tier = p && typeof p.service_tier === "string" ? p.service_tier : null;
		requestAt = Date.now();
		firstUpdate = undefined;
		write({ kind: "request", tier });
		return undefined;
	});
	pi.on("after_provider_response", (event) => {
		write({ kind: "response", status: event.status });
	});
	pi.on("message_update", (event) => {
		if (firstUpdate === undefined && (event.message as { role?: string }).role === "assistant")
			firstUpdate = Date.now();
	});
	pi.on("message_end", (event, ctx) => {
		const m = event.message as { role?: string; stopReason?: string; errorMessage?: string; usage?: Usage };
		if (m.role !== "assistant") return undefined;
		const u = m.usage;
		const c = (ctx.model as { cost?: Cost } | undefined)?.cost;
		const base =
			u && c
				? (u.input * c.input + u.output * c.output + u.cacheRead * c.cacheRead + u.cacheWrite * c.cacheWrite) / 1e6
				: 0;
		const end = Date.now();
		write({
			kind: "reply",
			model: ctx.model?.id,
			stopReason: m.stopReason,
			failed: m.stopReason === "error",
			input: u?.input,
			output: u?.output,
			cacheRead: u?.cacheRead,
			cost: u?.cost?.total,
			multiplier: base > 0 && u ? Math.round((u.cost.total / base) * 100) / 100 : null,
			firstMs: requestAt !== undefined && firstUpdate !== undefined ? firstUpdate - requestAt : null,
			totalMs: requestAt !== undefined ? end - requestAt : null,
			streamMs: firstUpdate !== undefined ? end - firstUpdate : null,
		});
		return undefined;
	});
	pi.on("agent_settled", (_event, ctx) => {
		write({ kind: "settled", view: registry.view(ctx.sessionManager, ctx.model) });
	});
}
