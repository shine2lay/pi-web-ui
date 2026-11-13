// 已结束的对话在另一页打开（零 token）：A 的 run 跑完后，B（全新页面，A 还在线）
// 仍在自己的列表里看到那条空闲对话，打开就能看完整转录。server-owned-chats 口径
// （ops #870 改写；删掉的上游「空白落地 / 过户」断言及原因见 PATCHES.md server-owned-chats）。
// 回归：列表只推 running 时，对话一结束行就消失，只能趁运行中打开。
// Usage: npm run build && node tests/idle-takeover-test.mjs [port]
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.argv[2] || 8961);
const MOCK_PORT = PORT + 1;
freePort(PORT);
freePort(MOCK_PORT);

const base = mkdtempSync(join(tmpdir(), "pi-web-idle-takeover-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const MODEL_ID = "idle-takeover-mock";
const sse = (res, chunks) => {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
};
const delta = (model, d, finish = null) => ({
	id: "idle-takeover-mock",
	object: "chat.completion.chunk",
	created: Date.now(),
	model,
	choices: [{ index: 0, delta: d, finish_reason: finish }],
});
// mock 恒直接回文本（不提问），run 一次即结束。
const mock = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${MOCK_PORT}`);
	if (url.pathname.endsWith("/models")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model", name: "Mock", input: ["text"] }] }),
		);
		return;
	}
	if (!url.pathname.endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	for await (const chunk of req) body += chunk;
	const payload = JSON.parse(body || "{}");
	sse(res, [delta(payload.model, { content: "IDLE-TAKEOVER-ANSWER" }), delta(payload.model, {}, "stop")]);
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "mock-key",
				models: [{ id: MODEL_ID, name: "Mock", input: ["text"], contextWindow: 32000, maxTokens: 4096 }],
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
		// 显式清空：测试必须与 ambient shell 的 PI_WEB_TOKEN 无关。
		PI_WEB_TOKEN: "",
	},
	stdio: "ignore",
	windowsHide: true,
});

const waitForPort = async (port, timeout = 20000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/health`);
			if (response.ok) return;
		} catch {
			/* starting */
		}
		await sleep(100);
	}
	throw new Error(`server did not start on ${port}`);
};

class Client {
	constructor(ws, name) {
		this.ws = ws;
		this.name = name;
		this.received = [];
		this.state = null;
		this.messages = [];
		this.conversations = [];
		this.elsewhere = [];
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			if (message.type === "snapshot") {
				this.state = message.state;
				this.messages = message.state.messages ?? [];
			} else if (
				message.type === "snapshot_delta" &&
				this.state &&
				this.state.rev === message.baseRev &&
				message.conversationId === this.state.conversationId
			) {
				this.state = { ...this.state, ...message.state };
				this.messages = [...this.messages, ...message.appended];
			} else if (message.type === "conversations") {
				this.conversations = message.conversations;
				this.elsewhere = message.elsewhere ?? [];
			}
		});
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	async waitForType(type, predicate = () => true, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				const message = this.received[i];
				if (message.type !== type || !predicate(message)) continue;
				this.received.splice(i, 1);
				return message;
			}
			await sleep(50);
		}
		throw new Error(`[${this.name}] timeout waiting for ${type}`);
	}
	async waitForState(predicate, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error(`[${this.name}] timeout waiting for state`);
	}
	notices() {
		return this.received.filter((m) => m.type === "notice");
	}
}

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

let clientA;
let clientB;
try {
	await waitForPort(PORT);

	const openClient = async (clientId) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		await new Promise((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		const c = new Client(ws, clientId);
		c.send({ type: "hello", clientId, locale: "zh" });
		await c.waitForType("ready");
		c.send({ type: "get_state" });
		await c.waitForState((s) => Boolean(s.conversationId));
		c.send({ type: "set_model", modelId: `mock/${MODEL_ID}` });
		await c.waitForState((s) => s.model?.id === MODEL_ID);
		return c;
	};

	// A：run 一次即结束（mock 直接回文本，不提问）。
	clientA = await openClient("idle-takeover-A");
	clientA.send({ type: "prompt", text: "hi" });
	await clientA.waitForState((s) => s.isStreaming === false, 60000);
	{
		const started = Date.now();
		let done = false;
		while (Date.now() - started < 60000) {
			const texts = (clientA.messages ?? [])
				.filter((m) => m.role === "assistant")
				.flatMap((m) => m.content ?? [])
				.map((b) => b.text ?? "")
				.join("\n");
			if (texts.includes("IDLE-TAKEOVER-ANSWER")) {
				done = true;
				break;
			}
			await sleep(100);
		}
		check("A 的 run 已结束并拿到回答", done);
	}
	const convA = clientA.state.conversationId;

	// B：A 结束后才上线（A 还在线）。对话归服务端：结束后 A 那条仍在 B 的列表里
	// （空闲、同一 convId），不是跑完即消失；只此一行，没有另一处只读副本。
	clientB = await openClient("idle-takeover-B");
	let row = null;
	{
		const started = Date.now();
		while (Date.now() - started < 15000) {
			row = clientB.conversations.find((c) => c.id === convA);
			if (row) break;
			await sleep(100);
		}
	}
	check("结束后 B 的列表里仍有 A 那条", !!row, JSON.stringify(row ?? clientB.conversations));
	check("结束的行标为空闲（非 running）", row?.isStreaming === false, `isStreaming=${row?.isStreaming}`);
	check("没有另一处只读副本", clientB.elsewhere.length === 0, JSON.stringify(clientB.elsewhere));

	// B 打开已结束的对话 → 看到完整转录（提问 + 回答都在）。
	if (clientB.state.conversationId !== convA) clientB.send({ type: "switch_conversation", id: convA });
	await clientB.waitForState((s) => s.conversationId === convA, 15000);
	{
		const started = Date.now();
		let seen = false;
		while (Date.now() - started < 30000) {
			const texts = (clientB.messages ?? [])
				.flatMap((m) => m.content ?? [])
				.map((b) => b.text ?? "")
				.join("\n");
			if (texts.includes("IDLE-TAKEOVER-ANSWER") && texts.includes("hi")) {
				seen = true;
				break;
			}
			await sleep(100);
		}
		check("B 打开后看到完整转录", seen);
	}
	// A 没丢任何东西：仍在这条对话上、列表里仍有它。
	check("A 仍在同一条对话上", clientA.state?.conversationId === convA, clientA.state?.conversationId);
	check(
		"A 的列表里仍有这条对话",
		clientA.conversations.some((c) => c.id === convA),
	);

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
} catch (err) {
	failures++;
	console.error("💥", err.message ?? err);
} finally {
	clientA?.ws.close();
	clientB?.ws.close();
	server.kill();
	mock.close();
	await sleep(500);
	await freePort(PORT);
	await freePort(MOCK_PORT);
}
process.exit(failures === 0 ? 0 : 1);
