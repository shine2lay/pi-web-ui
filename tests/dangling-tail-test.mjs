/**
 * dangling-tail-only (fork patch): the send guard may only fill in results for the tool calls of the
 * transcript's LAST assistant message. On 2026-09-26 it filled in results for old unanswered calls
 * (a restart had cut a turn off mid-tool and the user kept chatting) and appended them at the end of
 * the chat; Anthropic then refused every send with 400 "unexpected `tool_use_id` found in
 * `tool_result` blocks".
 *
 * A mock Anthropic Messages API checks every request the way Anthropic does (each tool_result must
 * answer a tool_use in the message right before it, each tool_use must be answered in the message
 * right after it) and answers 400 with Anthropic's wording otherwise. Two saved chats are opened and
 * sent to:
 *  1. "old": an unanswered call in an early turn, then the user kept chatting. The send must go
 *     through untouched: no filled-in results in the file, no 400, a normal answer.
 *  2. "tail": the last message is an assistant whose call never got a result (the case the guard is
 *     for). The call gets exactly one filled-in result, and the send goes through.
 *
 * Usage: npm run build:server && node tests/dangling-tail-test.mjs [port]
 * PI_WEB_TEST_ROOT=<another checkout, built> runs that checkout's server instead (for a counter-proof).
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = Number(process.argv[2] || 8977);
const MOCK_PORT = PORT + 1;
const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-dangling-")));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
const sessionDir = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
for (const d of [workdir, dataDir, agentDir, sessionDir]) mkdirSync(d, { recursive: true });

// ---- mock Anthropic Messages API that enforces tool_use / tool_result pairing ----------------------
const blocksOf = (m) => (Array.isArray(m?.content) ? m.content : []);
function pairingError(messages) {
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role === "user") {
			const prev = messages[i - 1];
			const uses = new Set(
				prev?.role === "assistant"
					? blocksOf(prev)
							.filter((b) => b.type === "tool_use")
							.map((b) => b.id)
					: [],
			);
			const blocks = blocksOf(m);
			for (let j = 0; j < blocks.length; j++) {
				const b = blocks[j];
				if (b.type === "tool_result" && !uses.has(b.tool_use_id)) {
					return `messages.${i}.content.${j}: unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${b.tool_use_id}. Each \`tool_result\` block must have a corresponding \`tool_use\` block in the previous message.`;
				}
			}
		} else if (m.role === "assistant") {
			const next = messages[i + 1];
			const answered = new Set(
				next?.role === "user"
					? blocksOf(next)
							.filter((b) => b.type === "tool_result")
							.map((b) => b.tool_use_id)
					: [],
			);
			const missing = blocksOf(m)
				.filter((b) => b.type === "tool_use" && !answered.has(b.id))
				.map((b) => b.id);
			if (missing.length > 0) {
				return `messages.${i}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${missing.join(", ")}. Each \`tool_use\` block must have a corresponding \`tool_result\` block in the next message.`;
			}
		}
	}
	return null;
}
function textsOf(value, out = []) {
	if (Array.isArray(value)) {
		for (const v of value) textsOf(v, out);
		return out;
	}
	if (!value || typeof value !== "object") return out;
	if (value.type === "text" && typeof value.text === "string") out.push(value.text);
	if (typeof value.content === "string") out.push(value.content);
	for (const [k, v] of Object.entries(value)) if (k !== "text" && v && typeof v === "object") textsOf(v, out);
	return out;
}
/** Every 400 the mock sent, with its message. */
const refusals = [];
const mock = createServer(async (req, res) => {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	let payload;
	try {
		payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		res.writeHead(400).end("bad json");
		return;
	}
	const problem = pairingError(payload.messages ?? []);
	if (problem) {
		refusals.push(problem);
		res.writeHead(400, { "content-type": "application/json" });
		res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: problem } }));
		return;
	}
	const turn = Array.isArray(payload.tools) && payload.tools.length > 0;
	let last = "none";
	for (const message of [...(payload.messages ?? [])].reverse()) {
		const hit = textsOf(message)
			.reverse()
			.map((t) => t.match(/^Q[A-Z]-[A-Z0-9-]+/)?.[0])
			.find(Boolean);
		if (hit) {
			last = hit;
			break;
		}
	}
	const reply = turn ? `answer to ${last}` : "Mock title";
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	ev("message_start", {
		message: {
			id: `msg_${Date.now()}`,
			type: "message",
			role: "assistant",
			model: payload.model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 1 },
		},
	});
	ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply } });
	ev("content_block_stop", { index: 0 });
	ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
	ev("message_stop", {});
	res.end();
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "dangling-test" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "anthropic-messages",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "dangling-test",
				models: [
					{
						id: "dangling-mock",
						name: "Dangling Mock",
						input: ["text"],
						contextWindow: 200000,
						maxTokens: 4096,
						reasoning: false,
					},
				],
			},
		},
	}),
);
writeFileSync(
	join(agentDir, "settings.json"),
	JSON.stringify({ defaultProvider: "mock", defaultModel: "dangling-mock" }),
);

// ---- the two saved chats ---------------------------------------------------------------------------
let clock = Date.parse("2026-09-26T10:00:00.000Z");
function sessionFile(name, hexTag, messages) {
	const id = `0199${hexTag}-0000-7000-8000-000000000000`;
	const lines = [
		{ type: "session", version: 3, id, timestamp: new Date(clock).toISOString(), cwd: workdir },
		{
			type: "model_change",
			id: `${name}-mc`,
			parentId: null,
			timestamp: new Date(clock).toISOString(),
			provider: "mock",
			modelId: "dangling-mock",
		},
	];
	let parentId = `${name}-mc`;
	messages.forEach((message, i) => {
		clock += 1000;
		const entryId = `${name}-${i}`;
		lines.push({
			type: "message",
			id: entryId,
			parentId,
			timestamp: new Date(clock).toISOString(),
			message: { ...message, timestamp: clock },
		});
		parentId = entryId;
	});
	const file = join(sessionDir, `2026-09-26T10-00-00-000Z_${id}.jsonl`);
	writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
	return file;
}
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (content, stopReason) => ({
	role: "assistant",
	content,
	api: "anthropic-messages",
	provider: "mock",
	model: "dangling-mock",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason,
});
const call = (id) => ({ type: "toolCall", id, name: "bash", arguments: { command: "sleep 600" } });
// 1. The outage shape: a restart cut the first turn off mid-tool; the user kept chatting.
const oldFile = sessionFile("old", "0a1d", [
	user("QO-FIRST start the long job"),
	assistant([{ type: "text", text: "Starting." }, call("toolu_old_1"), call("toolu_old_2")], "toolUse"),
	user("QO-SECOND are you there?"),
	assistant([{ type: "text", text: "answer to QO-SECOND" }], "stop"),
]);
// 2. What the guard is for: the chat ends on a call that never got a result.
const tailFile = sessionFile("tail", "7a11", [user("QT-FIRST go"), assistant([call("toolu_tail")], "toolUse")]);
const toolResultsIn = (file) =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l))
		.filter((e) => e.type === "message" && e.message?.role === "toolResult");

// ---- the server under test -------------------------------------------------------------------------
const repoRoot = realpathSync(process.env.PI_WEB_TEST_ROOT || new URL("../", import.meta.url));
const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: repoRoot,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});
let serverLog = "";
server.stdout.on("data", (d) => {
	serverLog += d;
});
server.stderr.on("data", (d) => {
	serverLog += d;
});
let exited = null;
server.on("exit", (code, signal) => {
	exited = { code, signal };
});

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✓" : "✗ FAIL:"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures += 1;
}
async function waitFor(fn, timeout = 20000, step = 100) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		try {
			if (await fn()) return true;
		} catch {
			/* not yet */
		}
		await sleep(step);
	}
	return false;
}
const healthy = async () => {
	try {
		return (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok;
	} catch {
		return false;
	}
};

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		this.state = null;
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			if (message.type === "snapshot") this.state = message.state;
			else if (message.type === "snapshot_delta") {
				if (this.state?.rev === message.baseRev && message.conversationId === this.state.conversationId) {
					const messages = [...(this.state.messages ?? []), ...(message.appended ?? [])];
					this.state = { ...this.state, ...message.state, messages };
				} else if (!this.resyncing) {
					this.resyncing = setTimeout(() => {
						this.resyncing = null;
						this.send({ type: "get_state" });
					}, 300);
				}
			} else this.received.push(message);
		});
	}
	static async connect(clientId) {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		await new Promise((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		const client = new Client(ws);
		client.send({ type: "hello", clientId, locale: "en" });
		await waitFor(() => client.received.some((m) => m.type === "ready"));
		await waitFor(() => Boolean(client.state?.conversationId));
		return client;
	}
	send(message) {
		if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
	}
	close() {
		this.ws.close();
	}
}
const textOf = (m) =>
	(Array.isArray(m.content) ? m.content : [])
		.map((b) => (b.type === "text" ? b.text : ""))
		.join("")
		.trim();
const hasText = (s, text) => (s?.messages ?? []).some((m) => textOf(m).includes(text));
const hasAnswer = (s, marker) =>
	(s?.messages ?? []).some((m) => m.role === "assistant" && textOf(m).includes(`answer to ${marker}`));
const errorOf = (s) => (s?.messages ?? []).findLast((m) => m.role === "assistant" && m.stopReason === "error");
const filledInNotices = (c) => c.received.filter((m) => m.type === "notice" && /without results/.test(m.textEn ?? ""));

/** Open a saved chat, send `text` (starting with `marker`), wait for the answer or an error. */
async function sendIn(client, file, seen, marker, text) {
	client.send({ type: "switch_session", path: file });
	const opened = await waitFor(() => hasText(client.state, seen) && client.state.isStreaming !== true);
	if (!opened) throw new Error(`could not open ${file}`);
	client.send({ type: "prompt", text });
	await waitFor(() => hasAnswer(client.state, marker) || (errorOf(client.state) && !client.state.isStreaming), 20000);
	const err = errorOf(client.state);
	return { answered: hasAnswer(client.state, marker), error: err?.errorMessage ?? (err ? textOf(err) : "") };
}

let exitCode = 0;
try {
	const up = await waitFor(healthy, 30000);
	if (!up) throw new Error(`server did not start on ${PORT}\n${serverLog.slice(-3000)}`);
	const c = await Client.connect("dangling-win");

	// 1. Old unanswered calls, then the user kept chatting.
	const old = await sendIn(c, oldFile, "answer to QO-SECOND", "QO-THIRD", "QO-THIRD one more question");
	check("a chat with an old unanswered call still gets an answer", old.answered, old.error || "no answer");
	check(
		"nothing was filled in for the old calls",
		toolResultsIn(oldFile).length === 0,
		`${toolResultsIn(oldFile).length} filled-in result(s)`,
	);
	check('no "filled in results" notice for that chat', filledInNotices(c).length === 0);

	// 2. The chat ends on a call that never got a result: the guard still fixes that one.
	const tail = await sendIn(c, tailFile, "QT-FIRST", "QT-SECOND", "QT-SECOND carry on");
	const results = toolResultsIn(tailFile);
	check(
		"a chat ending on an unanswered call gets exactly one filled-in result for it",
		results.length === 1 && results[0].message.toolCallId === "toolu_tail" && results[0].parentId === "tail-1",
		JSON.stringify(results.map((r) => ({ id: r.message.toolCallId, parentId: r.parentId }))),
	);
	check("that chat gets an answer too", tail.answered, tail.error || "no answer");

	check("the mock Anthropic refused nothing", refusals.length === 0, refusals.join(" | "));
	c.close();
} catch (err) {
	console.log(`✗ FAIL: ${err instanceof Error ? err.message : String(err)}`);
	failures += 1;
} finally {
	if (exited === null) server.kill("SIGTERM");
	mock.close();
	if (failures > 0) console.log(`--- server log (tail) ---\n${serverLog.slice(-2500)}`);
	exitCode = failures > 0 ? 1 : 0;
	console.log(failures > 0 ? `\n${failures} check(s) failed` : "\nall checks passed");
}
process.exit(exitCode);
