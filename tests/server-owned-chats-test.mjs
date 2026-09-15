// server-owned-chats：对话属于服务端，两个客户端各自「订阅」即可。
//
// 老行为（issue #145）：一条会话只有一个持有者，别的客户端最多在左栏看到一行
// 「另一处正在运行」——看不到内容，更插不上话。老早以前（issue #10）倒是所有
// 标签页**被迫**互为镜像，B 切对话会把 A 也切走、甚至中断 A 的运行，于是被改成
// 每标签页一个 clientId。教训不在「共享」，而在「不经同意的共享」。
//
// 现在：对话表进程共享（ClientSession.sharedConvs），`activeId` 只是「这个窗口在看哪条」。
// 两个窗口打开同一条就是订阅同一个 runtime —— 不用谁「加入」谁。本用例断言：
//   1. 两个窗口打开同一条对话 = 同一个 conversation（无拒绝、无第二个 writer）；
//   2. 两边轮流发言都进同一条对话，彼此都看得到（历史不分叉）；
//   3. 流式进行中两个订阅者同时收到增量；
//   4. 一个窗口切走，另一个不受影响（没有归属，也就没有连坐）；
//   5. 订阅者断线不影响对话本身（对话是服务端的，不随浏览器消失）；
//   6. 断线的订阅者不会让对话关不掉（只有活 socket 才算「在看」）。
//
// 零 token：mock SSE 模型，纯 WS 协议，无需浏览器。
// Usage: node tests/server-owned-chats-test.mjs [port]   （先 npm run build）
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = Number(process.argv[2] || 8973);
const MOCK_PORT = PORT + 1;
const base = mkdtempSync(join(tmpdir(), "pi-web-server-owned-chats-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });

const mock = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	const payload = JSON.parse(body || "{}");
	const last = payload.messages?.at(-1);
	const prompt =
		typeof last?.content === "string"
			? last.content
			: (last?.content
					?.filter?.((p) => p.type === "text")
					.map((p) => p.text)
					.join(" ") ?? "");
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const chunk = (content) =>
		res.write(
			`data: ${JSON.stringify({
				id: "co-drive",
				object: "chat.completion.chunk",
				created: Date.now(),
				model: payload.model,
				choices: [{ index: 0, delta: { content }, finish_reason: null }],
			})}\n\n`,
		);
	// 回声：把提示词原样带回，断言「谁说的话进了哪条对话」时好认。
	// SLOW：分多段慢慢吐，好让第二个客户端在**流式进行中**加入，断言它拿到的是
	// 实时增量（message_delta）而不是只等到最后一条完整消息。
	if (prompt.includes("SLOW")) {
		for (let i = 0; i < 6; i++) {
			chunk(`tick${i} `);
			await sleep(700);
		}
		chunk(`echo:${prompt.replace(/\s+/g, "_").slice(0, 40)}`);
	} else {
		chunk(`echo:${prompt.replace(/\s+/g, "_").slice(0, 40)}`);
	}
	res.write(
		`data: ${JSON.stringify({
			id: "co-drive",
			object: "chat.completion.chunk",
			created: Date.now(),
			model: payload.model,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		})}\n\n`,
	);
	res.write("data: [DONE]\n\n");
	res.end();
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ main: { type: "api_key", key: "co-drive" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "co-drive",
				models: [
					{ id: "co-drive-mock", name: "Co Drive Mock", input: ["text"], contextWindow: 32000, maxTokens: 4096 },
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
			if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
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
		/** 实时增量（co-drive 的重点：两边必须同时看到流，而不是只看到结果）。 */
		this.deltas = [];
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			if (message.type === "message_delta") {
				this.deltas.push({ at: Date.now(), text: message.assistantMessageEvent?.delta ?? "" });
			}
			if (message.type === "snapshot") {
				(this.snaps ??= []).push({
					at: Date.now(),
					conv: message.state.conversationId,
					streaming: message.state.isStreaming,
				});
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
				const m = this.received[i];
				if (m.type !== type || !predicate(m)) continue;
				this.received.splice(i, 1);
				return m;
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
			const m = this.messages.find(predicate);
			if (m) return m;
			await sleep(50);
		}
		throw new Error(`[${this.name}] timeout waiting for message`);
	}
}

let A;
let B;
try {
	await waitForPort(PORT);

	const open = async (clientId) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		await new Promise((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		const c = new Client(ws, clientId);
		c.send({ type: "hello", clientId });
		await c.waitForType("ready");
		await c.waitForState((s) => Boolean(s.conversationId));
		c.send({ type: "set_model", modelId: "main/co-drive-mock" });
		await c.waitForState((s) => s.model?.id === "co-drive-mock");
		return c;
	};

	A = await open("owned-A");
	A.send({ type: "prompt", text: "from A" });
	await A.waitForMessage((m) => m.role === "assistant" && JSON.stringify(m.content).includes("echo:from_A"));
	const aFile = (await A.waitForState((s) => Boolean(s.sessionFile))).sessionFile;
	const aConv = A.state.conversationId;

	// --- 1. 第二个窗口打开同一条转录：既不被拒绝，也不新建 writer ----------
	B = await open("owned-B");
	B.send({ type: "new_chat" });
	await sleep(400);
	const ownConv = B.state.conversationId;
	B.send({ type: "switch_session", path: aFile });
	await B.waitForState((s) => s.sessionFile === aFile, 15000);
	if (B.state.conversationId !== aConv) {
		throw new Error(`第二个窗口应当订阅到同一条对话（${aConv}），实际 ${B.state.conversationId}`);
	}
	const refusals = B.received.filter(
		(m) => m.type === "notice" && /另一处|another window|second writer/.test(`${m.text ?? ""} ${m.textEn ?? ""}`),
	);
	if (refusals.length > 0) throw new Error(`不该再出现持有者相关的提示：${JSON.stringify(refusals[0])}`);
	await B.waitForMessage((m) => m.role === "assistant" && JSON.stringify(m.content).includes("echo:from_A"));
	console.log("✓ 两个窗口打开同一条对话 = 同一个 conversation（无拒绝、无第二个 writer）");

	// --- 2. 两边都能发言，且都实时看到 ------------------------------------
	B.send({ type: "prompt", text: "from B" });
	await B.waitForMessage((m) => m.role === "assistant" && JSON.stringify(m.content).includes("echo:from_B"), 25000);
	await A.waitForMessage((m) => m.role === "assistant" && JSON.stringify(m.content).includes("echo:from_B"), 25000);
	A.send({ type: "prompt", text: "from A again" });
	await A.waitForMessage(
		(m) => m.role === "assistant" && JSON.stringify(m.content).includes("echo:from_A_again"),
		25000,
	);
	await B.waitForMessage(
		(m) => m.role === "assistant" && JSON.stringify(m.content).includes("echo:from_A_again"),
		25000,
	);
	console.log("✓ 两边轮流发言都进同一条对话，彼此都看得到（历史不分叉）");

	// --- 3. 流式进行中：两个订阅者同时收到实时增量 -------------------------
	A.deltas = [];
	B.deltas = [];
	A.send({ type: "prompt", text: "SLOW shared run" });
	const live = await (async () => {
		const deadline = Date.now() + 12000;
		while (Date.now() < deadline) {
			if (A.deltas.length >= 2 && B.deltas.length >= 2) return true;
			await sleep(50);
		}
		return false;
	})();
	if (!live) throw new Error(`订阅者没有同时拿到实时增量：A=${A.deltas.length} B=${B.deltas.length}`);
	console.log(`✓ 流式进行中两个订阅者同时收到增量（A=${A.deltas.length} B=${B.deltas.length}）`);
	await A.waitForMessage(
		(m) => m.role === "assistant" && JSON.stringify(m.content).includes("echo:SLOW_shared_run"),
		30000,
	);
	await B.waitForMessage(
		(m) => m.role === "assistant" && JSON.stringify(m.content).includes("echo:SLOW_shared_run"),
		30000,
	);

	// --- 4. 一个窗口离开，另一个照常 --------------------------------------
	// 用 new_chat 离开：B 原来那条空白对话在切走时就被丢弃了（空对话不留），
	// 所以不能再切回那个 id —— 这是既有且正确的行为，不是共享带来的问题。
	void ownConv;
	B.send({ type: "new_chat" });
	await B.waitForState((s) => s.conversationId !== aConv, 15000);
	A.send({ type: "prompt", text: "after B left" });
	await A.waitForMessage(
		(m) => m.role === "assistant" && JSON.stringify(m.content).includes("echo:after_B_left"),
		25000,
	);
	console.log("✓ 一个窗口切走，另一个不受影响（没有归属，也就没有连坐）");

	// --- 5. 断线的窗口不拖垮共享对话 --------------------------------------
	const C = await open("owned-C");
	C.send({ type: "switch_session", path: aFile });
	await C.waitForState((s) => s.conversationId === aConv, 15000);
	C.ws.close();
	await sleep(800);
	A.send({ type: "prompt", text: "after C dropped" });
	await A.waitForMessage(
		(m) => m.role === "assistant" && JSON.stringify(m.content).includes("echo:after_C_dropped"),
		25000,
	);
	console.log("✓ 订阅者断线不影响对话本身（对话是服务端的，不随浏览器消失）");

	// --- 6. 断线的订阅者不得让对话「关不掉」 ------------------------------
	// ClientSession 活得比 socket 久（断线重连要接回原状态），client-per-load 之后
	// 每次刷新还会留下一个被遗弃的会话。如果「有人在看」只看 activeId，这些幽灵会
	// 永远钉住它们最后看的那条对话 —— 用户看到的就是「这条对话关不掉」。
	const D = await open("owned-D");
	D.send({ type: "switch_session", path: aFile });
	await D.waitForState((s) => s.conversationId === aConv, 15000);
	D.ws.close();
	await sleep(800);
	// A 切到别处，再从最近对话里移出那条共享对话：必须真的移出。
	A.send({ type: "new_chat" });
	await A.waitForState((s) => s.conversationId !== aConv, 15000);
	A.send({ type: "dismiss_conversation", id: aConv });
	const gone = await (async () => {
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			const list = A.received.filter((m) => m.type === "conversations").at(-1);
			if (list && !list.conversations.some((c) => c.id === aConv && c.live !== false)) return true;
			await sleep(200);
		}
		return false;
	})();
	if (!gone) throw new Error("断线的订阅者把对话钉住了 —— 关不掉");
	console.log("✓ 断线的订阅者不会让对话关不掉（只有活 socket 才算“在看”）");

	console.log("\nserver-owned-chats: 全部通过");
} finally {
	A?.ws?.close();
	B?.ws?.close();
	server.kill("SIGTERM");
	mock.close();
}
