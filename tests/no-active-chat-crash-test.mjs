/* crash-guard E2E (no tokens): a window's chat can be closed by another window while the first
 * window has no socket (its page was reloaded; viewedElsewhere() skips socketless windows on
 * purpose). When that window's send later finished, prompt() threw "no active conversation"; the
 * WebSocket handler had started it with `void cs.prompt(...)`, so Node saw an unhandled rejection and
 * exited, ending every chat's run (2026-09-25 17:15 and 2026-09-26 09:11, same stack both times).
 *
 * This test walks that path with a mock Anthropic Messages API (a message holding SLOW-<n> answers
 * after n seconds):
 *  1. Window C starts a slow reply in its own chat W: the "other chat" that must keep running.
 *  2. Window A opens a new chat X, sends a slow message there, then clicks New chat (Y) while X is
 *     still answering.
 *  3. A's page goes away (socket closed); its send is still waiting on X's answer.
 *  4. A new page B opens. It lands on Y (the most recently active chat), then opens X from the
 *     running list. Leaving the blank Y closes it, although A still has Y as its active chat (A has
 *     no socket, so it doesn't count as looking at Y).
 *  5. X's answer ends, so A's send finishes.
 * Checks: the server process is still running and healthy; W's reply arrives; B can still chat; A
 * coming back (same client id) gets a snapshot of an open chat; the log has no crash.
 * Usage: npm run build:server && node tests/no-active-chat-crash-test.mjs [port]
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = Number(process.argv[2] || 8975);
const MOCK_PORT = PORT + 1;
const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-crash-")));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });

// ---- mock Anthropic Messages API ---------------------------------------------------------------
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
	const turn = Array.isArray(payload.tools) && payload.tools.length > 0;
	// The newest text that STARTS with a marker is what the window typed last. Other texts can quote
	// markers too (the parallel-work reminder names the other running chats by their first message).
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
	const slow = turn ? Number(last.match(/SLOW-(\d+)/)?.[1] ?? 0) : 0;
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
	ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply.slice(0, 7) } });
	if (slow > 0) await sleep(slow * 1000);
	ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply.slice(7) } });
	ev("content_block_stop", { index: 0 });
	ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
	ev("message_stop", {});
	res.end();
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "crash-test" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "anthropic-messages",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "crash-test",
				models: [
					{
						id: "crash-mock",
						name: "Crash Mock",
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
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "mock", defaultModel: "crash-mock" }));

// ---- the server under test -------------------------------------------------------------------------
const repoRoot = realpathSync(new URL("../", import.meta.url));
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
/** @type {{code: number | null, signal: string | null} | null} */
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

// ---- WebSocket client --------------------------------------------------------------------------
class Client {
	constructor(ws, name) {
		this.ws = ws;
		this.name = name;
		this.received = [];
		this.state = null;
		this.closed = false;
		ws.on("close", () => {
			this.closed = true;
		});
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
		const client = new Client(ws, clientId);
		client.send({ type: "hello", clientId, locale: "en" });
		await client.waitForType("ready");
		await client.waitForState((s) => Boolean(s.conversationId));
		return client;
	}
	send(message) {
		if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
	}
	async waitForType(type, predicate = () => true, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			const i = this.received.findIndex((m) => m.type === type && predicate(m));
			if (i >= 0) return this.received.splice(i, 1)[0];
			await sleep(50);
		}
		throw new Error(`${this.name}: timeout waiting for ${type}`);
	}
	async waitForState(predicate, timeout = 30000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error(`${this.name}: timeout waiting for state (conversation ${this.state?.conversationId})`);
	}
	async newChat() {
		const before = this.state.conversationId;
		this.send({ type: "new_chat" });
		const s = await this.waitForState((st) => st.conversationId !== before && (st.messages ?? []).length === 0);
		return s.conversationId;
	}
	close() {
		this.ws.close();
	}
}
const textOf = (m) =>
	(m.content ?? [])
		.map((b) => (b.type === "text" ? b.text : ""))
		.join("")
		.trim();
const hasAnswer = (s, marker) =>
	(s.messages ?? []).some((m) => m.role === "assistant" && textOf(m).includes(`answer to ${marker}`));

let exitCode = 0;
try {
	const up = await waitFor(healthy, 30000);
	if (!up) throw new Error(`server did not start on ${PORT}\n${serverLog.slice(-3000)}`);

	// 1. Window C: a slow reply in chat W, the other chat that must keep running.
	const c = await Client.connect("crash-win-C");
	const chatW = c.state.conversationId;
	c.send({ type: "prompt", text: "QW-SLOW-14 a long job in another chat" });
	await c.waitForState((s) => s.isStreaming === true);
	console.log(`C: chat ${chatW} is answering slowly (14 s)`);

	// 2. Window A: a new chat X, a slow message there, then New chat (Y) while X still answers.
	const a = await Client.connect("crash-win-A");
	const chatX = await a.newChat();
	a.send({ type: "prompt", text: "QX-SLOW-6 the send that finishes after its window is gone" });
	await a.waitForState((s) => s.conversationId === chatX && s.isStreaming === true);
	const xStarted = Date.now();
	const chatY = await a.newChat();
	console.log(`A: sent in ${chatX} (answers in 6 s), then opened ${chatY}`);

	// 3. A's page goes away; its send is still waiting on X's answer.
	a.close();
	await sleep(300);

	// 4. A new page B lands on Y (the most recently active chat) and opens X, which closes the blank Y.
	const b = await Client.connect("crash-win-B");
	check(
		"the new page B landed on A's last chat Y (the most recently active one)",
		b.state.conversationId === chatY,
		`B is on ${b.state.conversationId}`,
	);
	b.send({ type: "switch_conversation", id: chatX });
	await b.waitForState((s) => s.conversationId === chatX);
	const listed = await waitFor(() => {
		const list = b.received.filter((m) => m.type === "conversations").at(-1);
		return list && !JSON.stringify(list).includes(`"${chatY}"`);
	}, 5000);
	console.log(
		`B: opened ${chatX}; ${chatY} (A's active chat) ${listed ? "is gone from the running list" : "is maybe still listed"}`,
	);

	// 5. X's answer ends and A's send finishes. Give the server time to fall over if it's going to.
	const xDone = await waitFor(() => b.state && hasAnswer(b.state, "QX-SLOW-6") && b.state.isStreaming === false, 20000);
	console.log(
		`X's answer ${xDone ? "arrived" : "did NOT arrive"} after ${((Date.now() - xStarted) / 1000).toFixed(1)} s`,
	);
	await sleep(2500);
	check(
		"the server process is still running after A's send finished",
		exited === null,
		`exited ${JSON.stringify(exited)}`,
	);
	check("the server still answers /api/health", await healthy());
	if (exited !== null || !(await healthy())) {
		const crash = serverLog.match(/[^\n]*no active conversation[\s\S]{0,1200}/)?.[0];
		console.log(`--- server log around the crash ---\n${crash ?? serverLog.slice(-3000)}`);
		throw new Error("the server went down");
	}

	// Chat W (window C) keeps running and finishes normally.
	const wDone = await waitFor(
		() => c.state && hasAnswer(c.state, "QW-SLOW-14") && c.state.isStreaming === false,
		20000,
	);
	check("window C's slow reply in chat W still arrives", wDone && !c.closed);

	// Window B can still chat (in X, once X's reply is done).
	await waitFor(() => b.state && b.state.isStreaming === false, 20000);
	b.send({ type: "prompt", text: "QB-AFTER still fine?" });
	const bDone = await waitFor(() => hasAnswer(b.state, "QB-AFTER"), 20000);
	check("window B can still chat", bDone);

	// Window A comes back (same client id, e.g. after a network blip): it gets a snapshot of an open chat.
	const a2 = await Client.connect("crash-win-A");
	const aConv = a2.state.conversationId;
	check(
		"A coming back gets a snapshot of an open chat, not the closed Y",
		aConv && aConv !== chatY,
		`A is on ${aConv}`,
	);
	a2.send({ type: "prompt", text: "QA-BACK can I still chat?" });
	const aDone = await waitFor(() => hasAnswer(a2.state, "QA-BACK"), 20000);
	check("window A can chat again after coming back", aDone);

	check('the server log has no "no active conversation" error', !serverLog.includes("no active conversation"));
	check(
		"the server log says which window was moved off the closed chat",
		serverLog.includes("[crash-guard]") && serverLog.includes(chatY),
	);
	for (const cl of [a2, b, c]) cl.close();
} catch (err) {
	console.log(`✗ FAIL: ${err instanceof Error ? err.message : String(err)}`);
	failures += 1;
} finally {
	if (exited === null) server.kill("SIGTERM");
	mock.close();
	if (failures > 0) {
		console.log(`--- server exit: ${JSON.stringify(exited)} ---`);
		const crash = serverLog.match(/[^\n]*(no active conversation|Unhandled|unhandled)[\s\S]{0,1500}/)?.[0];
		console.log(`--- server log (${crash ? "around the error" : "tail"}) ---\n${crash ?? serverLog.slice(-2500)}`);
	}
	exitCode = failures > 0 ? 1 : 0;
	console.log(failures > 0 ? `\n${failures} check(s) failed` : "\nall checks passed");
}
process.exit(exitCode);
