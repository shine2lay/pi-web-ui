/** Real installed Codex HTTP/WS adapters against loopback fixtures. Only tier/count assertions;
 * never print payloads, model-bound context, replies or tools. No credentials or external network. */
import { createServer } from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { FastModeRegistry } from "../../server/fast-mode.js";
import type { ChatSpeed } from "../../server/protocol.js";
// pi 1.0 no longer shrinkwraps a private pi-ai copy inside pi-coding-agent.
// Both dependencies are pinned to the same version; resolve its public import path.
const sdk = await import(import.meta.resolve("@earendil-works/pi-ai/api/openai-codex-responses"));
const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.test`;
const completed = (id: number, tier: unknown) => ({
	type: "response.completed",
	response: {
		id: `resp-${id}`,
		status: "completed",
		output: [],
		service_tier: tier ?? "default",
		usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
	},
});
describe("installed Codex transport", () => {
	it.each(["sse", "websocket-cached"])(
		"%s carries per-request tiers and never claims confirmation from cost",
		async (transport) => {
			const tiers: unknown[] = [];
			let connections = 0;
			const server = createServer(async (req, res) => {
				const chunks: Buffer[] = [];
				for await (const part of req) chunks.push(Buffer.from(part));
				const bytes = Buffer.concat(chunks);
				const raw = req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes;
				const tier = JSON.parse(raw.toString("utf8")).service_tier;
				tiers.push(tier ?? null);
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(`data: ${JSON.stringify(completed(tiers.length, tier))}\n\n`);
			});
			const ws = new WebSocketServer({ server });
			ws.on("connection", (socket) => {
				connections++;
				socket.on("message", (bytes) => {
					const tier = JSON.parse(String(bytes)).service_tier;
					tiers.push(tier ?? null);
					socket.send(JSON.stringify(completed(tiers.length, tier)));
				});
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("loopback fixture unavailable");
			const model = {
				id: "gpt-6-astra",
				provider: "openai-codex",
				api: "openai-codex-responses",
				name: "Fixture Astra",
				baseUrl: `http://127.0.0.1:${address.port}`,
				reasoning: false,
				input: ["text"],
				contextWindow: 10000,
				maxTokens: 64,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			const sm = { getSessionId: () => `transport-${transport}`, getEntries: () => [] };
			const reg = new FastModeRegistry();
			try {
				for (const mode of ["standard", "fast", "ultrafast", "standard"] as ChatSpeed[]) {
					reg.setMode(sm, mode);
					const response = await sdk
						.stream(
							model,
							{ messages: [] },
							{
								apiKey: token,
								sessionId: sm.getSessionId(),
								transport,
								maxRetries: 0,
								timeoutMs: 5000,
								onPayload: (payload: unknown) => reg.rewritePayload(sm, model, payload),
								onResponse: (r: { status: number }) => reg.noteResponse(sm, r.status),
							},
						)
						.result();
					expect(response.stopReason).toBe("stop");
					reg.noteReplySpeed(sm, response, model);
					reg.noteMessageEnd(sm, response);
					expect(reg.view(sm, model)?.confirmedMode).toBeUndefined();
				}
				expect(tiers).toEqual([null, "priority", "ultrafast", null]);
				if (transport !== "sse") expect(connections).toBe(1);
			} finally {
				sdk.closeOpenAICodexWebSocketSessions(sm.getSessionId());
				for (const socket of ws.clients) socket.terminate();
				await new Promise<void>((resolve) => ws.close(() => resolve()));
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		},
		20000,
	);
});
