/**
 * mock-model.mjs: a stand-in model for tests (OpenAI chat-completions API, streamed). No test may
 * call a real model: point the test's own agent folder at this one instead.
 *
 *   const mock = await startMockModel(({ lastUser, toolResult, sideRequest, payload }) => …reply);
 *   writeMockModelConfig(agentDir, mock.port);  // auth.json + models.json with only the mock
 *   mock.requests                               // every request body received
 *   await mock.close();
 *
 * A reply is a string (text), { text }, or { tool, args } (one tool call). { text, stream: { everyMs,
 * pieceChars } } sends the text a piece at a time, like a real model typing its answer. The callback
 * may be async. It gets:
 *   - payload: the request body;
 *   - lastUser: the text of the last user message;
 *   - toolResult: { content } when the last message is a tool result, else null;
 *   - sideRequest: true when the request carries no tools (a title or other side request).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

export function textOf(message) {
	const c = message?.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join(" ");
	return "";
}

export async function startMockModel(respond) {
	const requests = [];
	let n = 0;
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		let payload;
		try {
			payload = JSON.parse(body);
		} catch {
			res.writeHead(400).end("bad json");
			return;
		}
		requests.push(payload);
		const history = Array.isArray(payload.messages) ? payload.messages : [];
		const last = history.at(-1);
		const lastUserMsg = [...history].reverse().find((m) => m.role === "user");
		const ctx = {
			payload,
			lastUser: textOf(lastUserMsg),
			toolResult: last?.role === "tool" ? { content: textOf(last) } : null,
			sideRequest: !Array.isArray(payload.tools) || payload.tools.length === 0,
		};
		let reply;
		try {
			reply = await respond(ctx);
		} catch (e) {
			res.writeHead(500).end(String(e));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const id = `mock-${++n}`;
		const send = (delta, finish = null) =>
			res.write(
				`data: ${JSON.stringify({
					id,
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: payload.model,
					choices: [{ index: 0, delta, finish_reason: finish }],
				})}\n\n`,
			);
		if (reply && typeof reply === "object" && reply.tool) {
			send({
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: `call_${n}`,
						type: "function",
						function: { name: reply.tool, arguments: JSON.stringify(reply.args ?? {}) },
					},
				],
			});
			send({}, "tool_calls");
		} else if (reply && typeof reply === "object" && reply.stream) {
			const text = String(reply.text ?? "");
			const size = Math.max(1, reply.stream.pieceChars ?? 20);
			const every = Math.max(0, reply.stream.everyMs ?? 50);
			send({ role: "assistant", content: "" });
			for (let i = 0; i < text.length; i += size) {
				if (res.destroyed) return;
				send({ content: text.slice(i, i + size) });
				if (every) await new Promise((r) => setTimeout(r, every));
			}
			send({}, "stop");
		} else {
			const text = typeof reply === "string" ? reply : (reply?.text ?? "");
			send({ role: "assistant", content: text });
			send({}, "stop");
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		port,
		requests,
		close: () => new Promise((resolve) => server.close(() => resolve())),
		/** Don't keep the test process alive for the mock's sake. */
		unref: () => server.unref(),
	};
}

/**
 * The goal wizard's side of a conversation (server/goal-service.ts startGoalWizard): its own session,
 * the only one with a goal_ask tool (the wizard instructions come as its user message). Asks `questions` one at a time
 * ({question, options?} each, the goal_ask arguments), then answers "GOAL: <goal>" like a real model.
 * Returns null for any other request, so a test can chain its own replies after it.
 */
export function wizardReply(payload, { questions, goal }) {
	const history = Array.isArray(payload?.messages) ? payload.messages : [];
	const tools = Array.isArray(payload?.tools) ? payload.tools : [];
	if (!tools.some((t) => (t.function?.name ?? t.name) === "goal_ask")) return null;
	const asked = history.filter((m) => m.role === "tool").length;
	if (asked < questions.length) return { tool: "goal_ask", args: questions[asked] };
	return `GOAL: ${goal}`;
}

/** Turn pi's automatic retries off in an agent folder's settings.json (kept otherwise). */
export function noRetries(agentDir) {
	const file = join(agentDir, "settings.json");
	let settings = {};
	if (existsSync(file)) {
		try {
			settings = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			settings = {};
		}
	}
	settings.retry = { ...settings.retry, enabled: false };
	writeFileSync(file, JSON.stringify(settings, null, 2));
}

/** Point an agent folder at the mock: it becomes the only model there is. */
export function writeMockModelConfig(agentDir, port, { provider = "mock", model = "mock-model" } = {}) {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ [provider]: { type: "api_key", key: "mock" } }));
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[provider]: {
					api: "openai-completions",
					baseUrl: `http://127.0.0.1:${port}`,
					apiKey: "mock",
					models: [{ id: model, name: "Mock model", input: ["text"], contextWindow: 32000, maxTokens: 4096 }],
				},
			},
		}),
	);
}

/**
 * A model that can't be reached (port 1): every call fails at once. For tests that only need the
 * user message saved, not an answer. Automatic retries are turned off (settings.json), or pi keeps
 * the run going for a while with retries and later prompts queue up behind it.
 */
export function writeFastFailModelConfig(agentDir) {
	mkdirSync(agentDir, { recursive: true });
	noRetries(agentDir);
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ fastfail: { type: "api_key", key: "dummy" } }));
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				fastfail: { api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "dummy", models: [{ id: "test-model" }] },
			},
		}),
	);
}
