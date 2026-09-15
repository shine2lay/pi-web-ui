// co-drive：两个客户端看同一条对话、都能说话。
//
// 老行为（issue #145）：一条会话只有一个持有者，别的客户端最多在左栏看到一行
// 「另一处正在运行」——看不到内容，更插不上话。老早以前（issue #10）倒是所有
// 标签页**被迫**互为镜像，B 切对话会把 A 也切走、甚至中断 A 的运行，于是被改成
// 每标签页一个 clientId。教训不在「共享」，而在「不经同意的共享」。
//
// 现在：`join_client` 让**这个 socket**改接到对方的 ClientSession 上 —— 主动加入、
// 随时 `leave_client` 退出，自己原来的会话原封不动。本用例断言：
//   1. B 加入后看到的是 A 的对话（同一 sessionFile、同一批消息），并收到 joined 回执；
//   2. B 发的消息进的是 A 的对话，A 自己也能看到（真·共同驾驶，不是只读镜像）；
//   3. B 退出后回到自己的空白会话，A 不受任何影响；
//   4. B 加入着直接断线，不会给 A 留下一个死 sink（A 之后仍能正常收推送）；
//   5. 加入一个不存在的客户端 → 明确拒绝，且本 socket 仍停在自己的会话上。
//
// 零 token：mock SSE 模型，纯 WS 协议，无需浏览器。
// Usage: node tests/co-drive-test.mjs [port]   （先 npm run build）
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = Number(process.argv[2] || 8971);
const MOCK_PORT = PORT + 1;
const base = mkdtempSync(join(tmpdir(), "pi-web-co-drive-"));
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

	A = await open("co-drive-A");
	A.send({ type: "prompt", text: "from A" });
	await A.waitForMessage((m) => m.role === "assistant" && JSON.stringify(m.content).includes("echo:from_A"));
	const aFile = (await A.waitForState((s) => Boolean(s.sessionFile))).sessionFile;
	const aConv = A.state.conversationId;
	console.log(`✓ A 有一条对话 ${aFile}`);

	// --- 1. B 加入 A 的会话 ---------------------------------------------
	B = await open("co-drive-B");
	// 同一个项目下的新客户端会自动接上该项目最近的会话（上游行为）——
	// 本用例要的是「B 本来在自己的对话里」，所以先开一条新的。
	B.send({ type: "new_chat" });
	await B.waitForState((s) => s.messages?.length === 0 || (B.messages.length === 0 && s.conversationId), 15000);
	await sleep(300);
	const ownFile = B.state.sessionFile ?? null;
	const ownConv = B.state.conversationId;
	if (ownConv === aConv) throw new Error("前提不成立：两个客户端本应各有各的对话");

	B.send({ type: "join_client", clientId: "co-drive-A" });
	const joined = await B.waitForType("joined", (m) => m.clientId === "co-drive-A");
	if (!(joined.viewers >= 2)) throw new Error(`joined.viewers 应 ≥2（A 与 B 都在看），实际 ${joined.viewers}`);
	await B.waitForState((s) => s.conversationId === aConv, 15000);
	if (B.state.sessionFile !== aFile) throw new Error("加入后看到的不是 A 那条对话的转录");
	await B.waitForMessage((m) => m.role === "assistant" && JSON.stringify(m.content).includes("echo:from_A"));
	console.log("✓ B 加入后看到的就是 A 的对话（同一转录、同一批消息）");

	// --- 2. B 说话 → 进 A 的对话，A 也看得见 ------------------------------
	B.send({ type: "prompt", text: "from B" });
	await B.waitForMessage((m) => m.role === "assistant" && JSON.stringify(m.content).includes("echo:from_B"), 25000);
	await A.waitForMessage((m) => m.role === "assistant" && JSON.stringify(m.content).includes("echo:from_B"), 25000);
	if (A.state.conversationId !== aConv) throw new Error("B 的发言把 A 的当前对话切走了");
	console.log("✓ B 发的消息进了同一条对话，A 实时看到（可看可说，不是只读镜像）");

	// --- 2b. 流式进行中加入：两边同时看到实时增量 -------------------------
	A.deltas = [];
	B.deltas = [];
	B.send({ type: "leave_client" });
	await B.waitForType("joined", (m) => m.clientId === null);
	A.send({ type: "prompt", text: "SLOW shared run" });
	await A.waitForState((s) => s.isStreaming, 15000);
	await sleep(900); // A 已经在收 tick 了，B 才加入 —— 中途加入才是真实场景
	const aBefore = A.deltas.length;
	if (aBefore === 0) throw new Error("A 自己都没收到实时增量，用例前提不成立");
	B.send({ type: "join_client", clientId: "co-drive-A" });
	await B.waitForType("joined", (m) => m.clientId === "co-drive-A");
	const joinedAt = Date.now();

	// B 在**流还没结束**时就该拿到增量（而不是等最后一条完整消息补上）。
	// 判据用「A 还在流式」而不是 B 自己的快照标志：run 一结束 isStreaming 立刻变 false，
	// 拿它和增量条数做“同一瞬间都成立”的轮询是自找的 flaky。
	const sawLive = await (async () => {
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline) {
			// 增量只在 run 进行中产生：B 在结束前收到 ≥2 条，就是「同时看到流」的直接证据。
			if (B.deltas.length >= 2) return true;
			await sleep(50);
		}
		return false;
	})();
	if (!sawLive) {
		console.log("DEBUG B.deltas=", B.deltas.length);
		throw new Error("B 加入后没有在流式进行中收到实时增量（只能等结果 = 不是同时看到）");
	}
	if (!B.deltas.every((d) => d.at >= joinedAt - 200)) throw new Error("时间戳异常：增量早于加入时刻");
	// 加入瞬间就该拿到一份「正在流式」的完整快照 —— 否则界面会先空着几秒才动起来。
	const liveSnap = (B.snaps ?? []).find((x) => x.streaming && x.at >= joinedAt - 500);
	if (!liveSnap) throw new Error("加入时没有立刻拿到 isStreaming 的完整快照（界面会先假装空闲）");
	// 同一份流：A 与 B 在加入之后收到的增量条数应当一致（同一个 sink 广播）。
	const aAfter = A.deltas.filter((d) => d.at >= joinedAt).length;
	const bAfter = B.deltas.filter((d) => d.at >= joinedAt).length;
	if (Math.abs(aAfter - bAfter) > 1) {
		throw new Error(`两边收到的实时增量条数差太多：A=${aAfter} B=${bAfter}（应当是同一份广播）`);
	}
	await A.waitForMessage(
		(m) => m.role === "assistant" && JSON.stringify(m.content).includes("echo:SLOW_shared_run"),
		25000,
	);
	await B.waitForMessage(
		(m) => m.role === "assistant" && JSON.stringify(m.content).includes("echo:SLOW_shared_run"),
		25000,
	);
	console.log(`✓ 流式进行中加入：两边同时收到实时增量（加入后 A=${aAfter} 条 / B=${bAfter} 条），结尾一致`);

	// --- 3. B 退出 → 回自己的会话，A 不受影响 ----------------------------
	B.send({ type: "leave_client" });
	const left = await B.waitForType("joined", (m) => m.clientId === null);
	if (left.clientId !== null) throw new Error("退出回执不对");
	await B.waitForState((s) => s.conversationId === ownConv, 15000);
	if (B.state.sessionFile !== ownFile) throw new Error("退出后没回到自己原来的会话");
	if (B.messages.some((m) => JSON.stringify(m.content).includes("echo:from_B"))) {
		throw new Error("退出后自己的会话里混进了对方对话的消息");
	}
	A.send({ type: "prompt", text: "after leave" });
	await A.waitForMessage(
		(m) => m.role === "assistant" && JSON.stringify(m.content).includes("echo:after_leave"),
		25000,
	);
	console.log("✓ B 退出后回到自己的空白会话，A 照常工作");

	// --- 4. 加入着直接断线：不给 A 留死 sink ------------------------------
	const C = await open("co-drive-C");
	C.send({ type: "join_client", clientId: "co-drive-A" });
	await C.waitForType("joined", (m) => m.clientId === "co-drive-A");
	C.ws.close();
	await sleep(500);
	A.send({ type: "prompt", text: "after drop" });
	await A.waitForMessage((m) => m.role === "assistant" && JSON.stringify(m.content).includes("echo:after_drop"), 25000);
	console.log("✓ 加入者直接断线，A 仍正常收推送（sink 断在了正确的一侧）");

	// --- 5. 加入不存在的客户端 → 明确拒绝 --------------------------------
	B.send({ type: "join_client", clientId: "nobody-here" });
	const notice = await B.waitForType(
		"notice",
		(m) => `${m.text ?? ""} ${m.textEn ?? ""}`.includes("已经不在") || `${m.textEn ?? ""}`.includes("gone"),
		10000,
	);
	if (notice.level !== "warning") throw new Error("拒绝应当是 warning 级");
	await B.waitForState((s) => s.conversationId === ownConv, 5000);
	console.log("✓ 加入不存在的会话：明确拒绝，本 socket 仍停在自己的会话上");

	console.log("\nco-drive: 全部通过");
} finally {
	A?.ws?.close();
	B?.ws?.close();
	server.kill("SIGTERM");
	mock.close();
}
