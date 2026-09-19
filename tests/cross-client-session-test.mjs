// issue #145 跨客户端同会话双写防护 —— 第二个 writer 造不出来，新标签页不默认落进正在跑的对话，
// 且同项目并行互相可见。
//
// A 客户端开一条 SLOW run（streaming）；B 客户端（另一标签页/设备 = 不同 clientId）：
//   1. B 直接 switch_session 到 A 正在跑的 session 文件 → 必须被拒绝（warning notice），
//      B 的 conversationId / sessionFile 不变（改前 RED：B 会打开成功并持有同一文件）；
//   2. B 在自己的会话（同一项目）发消息 → 允许并行，但 B 收到同项目并行提醒，
//      A 收到对端并行通告；两边 run 都能正常跑完；
//   3. A 跑完后 B 再 switch_session 同一文件 → 允许（owner 空闲），B 能打开。
//
// 零 token：mock SSE 模型（prompt 含 SLOW 即慢速输出），纯 WS 协议，无需浏览器。
// Usage: node tests/cross-client-session-test.mjs [port]   （先 npm run build）
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = Number(process.argv[2] || 8969);
const MOCK_PORT = PORT + 1;
const base = mkdtempSync(join(tmpdir(), "pi-web-cross-client-"));
const workdir = join(base, "work");
const otherdir = join(base, "other");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(otherdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

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
	const slow = prompt.includes("SLOW");
	const first = slow ? "background-" : "seed-";
	const lastChunk = slow ? "finished" : "message";
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
	});
	const writeChunk = (content) =>
		res.write(
			`data: ${JSON.stringify({
				id: "cross-client-test",
				object: "chat.completion.chunk",
				created: Date.now(),
				model: payload.model,
				choices: [{ index: 0, delta: { content }, finish_reason: null }],
			})}\n\n`,
		);
	writeChunk(first);
	// SLOW 分支要盖住 B 的三步断言（elsewhere/拒绝/并行提醒），给足窗口。
	if (slow) await sleep(12000);
	writeChunk(lastChunk);
	res.write(
		`data: ${JSON.stringify({
			id: "cross-client-test",
			object: "chat.completion.chunk",
			created: Date.now(),
			model: payload.model,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		})}\n\n`,
	);
	res.write("data: [DONE]\n\n");
	res.end();
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ main: { type: "api_key", key: "cross-client-test" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "cross-client-test",
				models: [
					{
						id: "cross-client-mock",
						name: "Cross Client Mock",
						input: ["text"],
						contextWindow: 32000,
						maxTokens: 4096,
					},
				],
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
		// 服务默认目录就是 work（最常见的单项目情形）：新 clientId 上来初始恢复即命中。
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: "ignore",
	windowsHide: true,
});

const waitForPort = async (port, timeout = 15000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health`);
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
	async waitForType(type, predicate = () => true, timeout = 15000) {
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
	async waitForState(predicate, timeout = 15000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error(`[${this.name}] timeout waiting for state`);
	}
	async waitForMessage(predicate, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			const message = this.messages.find(predicate);
			if (message) return message;
			await sleep(50);
		}
		throw new Error(`[${this.name}] timeout waiting for message`);
	}
}

let clientA;
let clientB;
let clientC;
let clientF;
const noticeText = (m) => `${m.text ?? ""} ${m.textEn ?? ""}`;
try {
	await waitForPort(PORT);

	const openClient = async (clientId, withModel = true) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		await new Promise((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		const c = new Client(ws, clientId);
		c.send({ type: "hello", clientId });
		await c.waitForType("ready");
		await c.waitForState((s) => Boolean(s.conversationId));
		if (withModel) {
			c.send({ type: "set_model", modelId: "main/cross-client-mock" });
			await c.waitForState((s) => s.model?.id === "cross-client-mock");
		}
		return c;
	};

	clientA = await openClient("cross-client-A");

	// A 先用普通首条命名对话（标题进 AI 提醒，不能含 mock 的 SLOW 特征串），
	// 再开一条慢 run（streaming 中）。
	clientA.send({ type: "prompt", text: "seed" });
	await clientA.waitForMessage(
		(m) => m.role === "assistant" && JSON.stringify(m.content).includes("seed-message"),
		20000,
	);
	clientA.send({ type: "prompt", text: "SLOW run A" });
	await clientA.waitForState((s) => s.isStreaming, 15000);
	const runningFile = await clientA.waitForState((s) => Boolean(s.sessionFile), 15000).then((s) => s.sessionFile);
	console.log(`✓ A streaming on ${runningFile}`);

	// 0a. attach 路径（reload-adopt）：对话是进程共享的，新标签页/刷新**直接接管**
	// 已经开着的那条 —— 不再从磁盘恢复第二份，也不再有「为你停在了新对话」那层保护。
	// client-per-load 之后每次刷新都是新 clientId，那层保护挡的其实是用户自己。
	clientC = await openClient("cross-client-C", false);
	await clientC.waitForState((s) => s.sessionFile === runningFile, 15000);
	await sleep(500);
	if (clientC.messages.length === 0) throw new Error("接管之后应当看到那条对话的历史，而不是空白");
	if (clientC.received.some((m) => m.type === "notice" && noticeText(m).includes("停在了新对话")))
		throw new Error("不该再出现「停在了新对话」——那是自己刷新前的窗口");
	console.log("✓ 新标签页/刷新直接接管正在跑的那条对话（无第二份 runtime、无提示）");
	clientC.ws.close();

	// 0b. setCwd 路径：server-owned-chats 之后，进入某个项目会直接**订阅**该项目里
	// 正在跑的那条共享对话（就是同一条，不存在第二个 writer），所以不再有
	// 「为你停在了新对话」这层保护。要断言的是：没有任何拒绝/持有者提示。
	clientF = await openClient("cross-client-F", false);
	clientF.send({ type: "set_cwd", path: otherdir });
	await clientF.waitForState((s) => s.cwd === otherdir, 15000);
	clientF.send({ type: "set_cwd", path: workdir });
	await clientF.waitForState((s) => s.cwd === workdir, 15000);
	await sleep(800);
	if (clientF.received.some((m) => m.type === "notice" && /另一处|second writer|another window/.test(noticeText(m))))
		throw new Error("不该再有持有者/拒绝提示");
	console.log("✓ 进入项目直接订阅共享对话，无拒绝、无第二个 writer");
	clientF.ws.close();

	// 1. B 打开 A 正在跑的会话：现在是**订阅同一条**（以前拒绝，因为会造出第二个 writer）。
	clientB = await openClient("cross-client-B");
	clientB.send({ type: "switch_session", path: runningFile });
	await clientB.waitForState((s) => s.sessionFile === runningFile, 20000);
	if (clientB.received.some((m) => m.type === "notice" && /另一处|second writer|another window/.test(noticeText(m))))
		throw new Error("不该再拒绝打开正在跑的对话");
	console.log("✓ 第二个窗口可直接订阅正在跑的对话（同一个 conversation）");

	// 2. 共享对话里两边同时发：按到达顺序排队（不拒绝、不分叉）。
	clientB.send({ type: "prompt", text: "B into shared" });
	await clientA.waitForMessage((m) => m.role === "user" && JSON.stringify(m.content).includes("B into shared"), 30000);
	if (clientB.received.some((m) => m.type === "notice" && /拦截|blocked/.test(noticeText(m))))
		throw new Error("共享对话里的发送不该被拦截——排队即可");
	console.log("✓ 两个窗口往同一条对话发送 = 排队，A 也立刻看到 B 的消息");

	// 3. A 的 run 仍然正常跑完（共享没有打断它）。排队的那条随后还会再跑一轮，
	// 所以判据用「回到空闲」而不是某一句具体输出。
	await clientA.waitForState((s) => s.isStreaming === false, 60000);
	console.log("✓ A 的 run 不受另一个订阅者影响，正常跑完");

	console.log("\ncross-client: 全部通过（server-owned-chats 口径）");
} finally {
	clientA?.ws.close();
	clientB?.ws.close();
	clientC?.ws.close();
	clientF?.ws.close();
	server.kill();
	mock.close();
}
