// busy-endpoint: GET /api/busy lists every chat that is working right now, across the whole
// process, whichever window has it open. pi-web-deploy reads it to decide whether a restart is
// safe.
//
// The `conversations` push can't answer that: it is per window (background chats plus the one
// this window shows), so a fresh client, like the deploy tool, never sees a chat that another
// window runs in the foreground. This test shows both halves:
//   - window W1 moves to a second project and starts a slow run there, without leaving that chat;
//   - a fresh client's `conversations` push lists no busy chat (the blind spot);
//   - /api/busy lists that chat once (id, title, cwd, doing "run") while two clients are connected;
//   - once the run ends, /api/busy is empty.
//
// Zero tokens: a mock OpenAI-compatible provider answers.
// Usage: npm run build && node tests/busy-endpoint-test.mjs [port]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = Number(process.argv[2] || 8961);
const MOCK_PORT = PORT + 1;
const SLOW_MS = 5000;
const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-busy-endpoint-")));
const workdir = join(base, "work");
const other = join(base, "other-project");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, other, dataDir, agentDir]) mkdirSync(d, { recursive: true });

const mock = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	let payload;
	try {
		payload = JSON.parse(body);
	} catch {
		res.writeHead(400).end("bad json");
		return;
	}
	const last = payload.messages?.at(-1);
	const prompt =
		typeof last?.content === "string"
			? last.content
			: (last?.content
					?.filter?.((part) => part.type === "text")
					.map((part) => part.text)
					.join(" ") ?? "");
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const chunk = (delta, finish = null) =>
		res.write(
			`data: ${JSON.stringify({
				id: "busy-endpoint-test",
				object: "chat.completion.chunk",
				created: Date.now(),
				model: payload.model,
				choices: [{ index: 0, delta, finish_reason: finish }],
			})}\n\n`,
		);
	chunk({ content: "working-" });
	if (prompt.includes("SLOW")) await sleep(SLOW_MS);
	chunk({ content: "done" });
	chunk({}, "stop");
	res.write("data: [DONE]\n\n");
	res.end();
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ main: { type: "api_key", key: "busy-endpoint-test" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "busy-endpoint-test",
				models: [{ id: "busy-mock", name: "Busy Mock", input: ["text"], contextWindow: 32000, maxTokens: 4096 }],
			},
		},
	}),
);

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
	stdio: ["ignore", "ignore", "pipe"],
	windowsHide: true,
});
let serverErr = "";
server.stderr.on("data", (d) => {
	serverErr = (serverErr + d).slice(-4000);
});

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✓" : "✗ FAIL:"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures += 1;
}

async function waitForPort(port, timeout = 15000) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
		} catch {
			/* starting */
		}
		await sleep(100);
	}
	throw new Error(`server did not start on ${port}`);
}

async function busyNow() {
	const res = await fetch(`http://127.0.0.1:${PORT}/api/busy`);
	return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.json() };
}

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		this.state = null;
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			if (message.type === "snapshot") this.state = message.state;
			else if (
				message.type === "snapshot_delta" &&
				this.state &&
				this.state.rev === message.baseRev &&
				message.conversationId === this.state.conversationId
			) {
				this.state = { ...this.state, ...message.state };
			}
		});
	}
	static async connect(clientId) {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		await new Promise((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		const client = new Client(ws);
		client.send({ type: "hello", clientId });
		await client.waitForType("ready");
		await client.waitForState((s) => Boolean(s.conversationId));
		return client;
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	async waitForType(type, predicate = () => true, timeout = 15000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			const i = this.received.findIndex((m) => m.type === type && predicate(m));
			if (i >= 0) return this.received.splice(i, 1)[0];
			await sleep(50);
		}
		throw new Error(`timeout waiting for ${type}`);
	}
	async waitForState(predicate, timeout = 15000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error(
			`timeout waiting for state (now ${JSON.stringify(this.state && { cwd: this.state.cwd, isStreaming: this.state.isStreaming })})`,
		);
	}
}

const clients = [];
try {
	await waitForPort(PORT);
	const idle = await busyNow();
	check(
		"before any run, /api/busy answers JSON with an empty list",
		idle.status === 200 && /json/.test(idle.type) && Array.isArray(idle.body.busy) && idle.body.busy.length === 0,
		JSON.stringify(idle),
	);

	console.log("window 1: move to a second project and start a slow run there");
	const w1 = await Client.connect("busy-w1");
	clients.push(w1);
	w1.send({ type: "set_model", modelId: "main/busy-mock" });
	await w1.waitForState((s) => s.model?.id === "busy-mock");
	w1.send({ type: "set_cwd", path: other });
	await w1.waitForState((s) => s.cwd === other);
	w1.send({ type: "prompt", text: "SLOW run in the other project" });
	const running = await w1.waitForState((s) => s.isStreaming);
	const convA = running.conversationId;
	const startedAt = Date.now();

	console.log("a fresh client connects, the way the deploy tool used to check");
	const probe = await Client.connect("busy-probe");
	clients.push(probe);
	const push = await probe.waitForType("conversations");
	const pushBusy = [...(push.conversations ?? []), ...(push.elsewhere ?? [])].filter((c) => c?.isStreaming);
	check(
		"its conversations push shows no busy chat, although window 1 is running one (the blind spot)",
		pushBusy.length === 0,
		JSON.stringify(pushBusy.map((c) => c.id)),
	);

	const during = await busyNow();
	const entry = during.body.busy?.[0];
	check(
		"/api/busy lists window 1's chat exactly once, with two clients connected",
		during.status === 200 && during.body.busy?.length === 1 && entry?.id === convA,
		JSON.stringify(during.body),
	);
	check(
		"...with its title, its project and what it's doing",
		typeof entry?.title === "string" &&
			entry.title.length > 0 &&
			entry?.cwd === other &&
			entry?.doing === "run" &&
			!("subagent" in entry),
		JSON.stringify(entry),
	);
	check(
		"...while the run was still going",
		Date.now() - startedAt < SLOW_MS && w1.state.isStreaming === true,
		`${Date.now() - startedAt} ms`,
	);

	await w1.waitForState((s) => !s.isStreaming, SLOW_MS + 10000);
	const after = await busyNow();
	check(
		"after the run ends, /api/busy is empty again",
		after.status === 200 && Array.isArray(after.body.busy) && after.body.busy.length === 0,
		JSON.stringify(after.body),
	);
} catch (error) {
	check(`no error: ${error.message}`, false);
}
for (const c of clients) c.ws.close();
server.kill();
mock.close();
if (failures) {
	console.log(`\n${failures} check(s) FAILED\n--- server stderr (tail) ---\n${serverErr}`);
	process.exitCode = 1;
} else console.log("\nall checks passed");
