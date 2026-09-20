// switch-loading 补丁：切换对话的回执契约（服务端）。
//
// 客户端在发出 switch_session / switch_conversation 的那一刻盖上「正在打开…」，靠
// switch_done / switch_failed 撤掉。这里守住的是**服务端**那一半：
//   1. 成功：先来目标对话的快照，**再**来 switch_done（顺序反了遮罩会在内容到达前撤掉，
//      露一帧旧对话）；target 原样回传。
//   2. 打开一个目录（SessionManager.open 抛 EISDIR）：switch_failed 带原因，且当前对话不变。
//   3. switch_conversation 一个不存在的 id：以前静默返回，现在 switch_failed。
//   4. switch_session 到**已经是当前**的转录：仍然回执（外部客户端不会像浏览器那样先拦）。
//   5. switch_conversation 到另一条活着的对话：快照 → switch_done。
//
// 零 token：mock SSE 模型，纯 WS 协议，无需浏览器。
// Usage: node tests/switch-ack-test.mjs [port]   （先 npm run build）
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = Number(process.argv[2] || 8987);
const MOCK_PORT = PORT + 1;
const base = mkdtempSync(join(tmpdir(), "pi-web-switch-ack-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });

const mock = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	let payload;
	try {
		payload = JSON.parse(body);
	} catch {
		res.writeHead(400).end();
		return;
	}
	const last = payload.messages?.at(-1);
	const prompt =
		typeof last?.content === "string"
			? last.content
			: (last?.content
					?.filter?.((p) => p.type === "text")
					.map((p) => p.text)
					.join(" ") ?? "");
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const chunk = (content, finish = null) =>
		res.write(
			`data: ${JSON.stringify({
				id: "switch-ack",
				object: "chat.completion.chunk",
				created: Date.now(),
				model: payload.model,
				choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }],
			})}\n\n`,
		);
	chunk(`echo:${prompt.replace(/\s+/g, "_").slice(0, 40)}`);
	chunk(null, "stop");
	res.write("data: [DONE]\n\n");
	res.end();
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ main: { type: "api_key", key: "switch-ack" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "switch-ack",
				models: [{ id: "mock", name: "Mock", input: ["text"], contextWindow: 32000, maxTokens: 4096 }],
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
		/** 未消费队列（waitForType 会从这里摘走）。 */
		this.received = [];
		/** 全量流水（只追加），用来断言**顺序**。 */
		this.all = [];
		this.state = null;
		this.messages = [];
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			this.all.push(message);
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
	/** 在全量流水里找最后一条满足条件的消息的下标（-1 = 没有）。 */
	lastIndex(predicate) {
		for (let i = this.all.length - 1; i >= 0; i--) if (predicate(this.all[i])) return i;
		return -1;
	}
}

const sameTarget = (a, b) => a && b && a.kind === b.kind && (a.kind === "session" ? a.path === b.path : a.id === b.id);

let A;
let B;
try {
	await waitForPort(PORT);
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	A = new Client(ws, "A");
	A.send({ type: "hello", clientId: "switch-ack-A" });
	await A.waitForType("ready");
	await A.waitForState((s) => Boolean(s.conversationId));
	A.send({ type: "set_model", modelId: "main/mock" });
	await A.waitForState((s) => s.model?.id === "mock");

	// 造一条落盘的对话 A1，再新建一条空对话离开它。
	A.send({ type: "prompt", text: "first chat" });
	await A.waitForMessage((m) => m.role === "assistant" && JSON.stringify(m.content).includes("echo:first_chat"));
	const a1File = (await A.waitForState((s) => Boolean(s.sessionFile))).sessionFile;
	const a1Conv = A.state.conversationId;
	A.send({ type: "new_chat" });
	await A.waitForState((s) => s.conversationId !== a1Conv);
	const blankConv = A.state.conversationId;

	// --- 1. 成功：快照在前，switch_done 在后，target 原样 ---------------------
	const t1 = { kind: "session", path: a1File };
	const mark1 = A.all.length;
	A.send({ type: "switch_session", path: a1File });
	const done1 = await A.waitForType("switch_done", (m) => sameTarget(m.target, t1));
	const snapIdx = A.all.findIndex((m, i) => i >= mark1 && m.type === "snapshot" && m.state.sessionFile === a1File);
	const doneIdx = A.all.indexOf(done1);
	if (snapIdx < 0) throw new Error("切换成功后没有收到目标对话的快照");
	if (snapIdx > doneIdx)
		throw new Error(`switch_done（#${doneIdx}）跑到了快照（#${snapIdx}）前面 —— 遮罩会在内容到达前撤掉`);
	// 注意：离开时 A1 的运行时被释放了，重新打开是一条**新** conversation id（id 是临时的，
	// 转录路径才是身份）—— 所以断言看 sessionFile，不看 id。
	if (A.state.sessionFile !== a1File) throw new Error(`应当回到 ${a1File}，实际 ${A.state.sessionFile}`);
	const a1Live = A.state.conversationId;
	console.log("✓ 成功切换：先快照后 switch_done，target 原样回传");

	// --- 2. 打开目录：switch_failed 带原因，当前对话不变 ----------------------
	const t2 = { kind: "session", path: workdir };
	A.send({ type: "switch_session", path: workdir });
	const fail2 = await A.waitForType("switch_failed", (m) => sameTarget(m.target, t2));
	if (!/EISDIR|directory|失败|Failed/i.test(`${fail2.error} ${fail2.errorEn ?? ""}`)) {
		throw new Error(`失败原因看不出是什么：${JSON.stringify(fail2)}`);
	}
	if (!fail2.errorEn) throw new Error("switch_failed 缺 errorEn（非中文界面要用）");
	await sleep(300);
	if (A.state.conversationId !== a1Live || A.state.sessionFile !== a1File) {
		throw new Error("失败的切换动了当前对话");
	}
	const doneAfterFail = A.all
		.slice(A.all.indexOf(fail2))
		.some((m) => m.type === "switch_done" && sameTarget(m.target, t2));
	if (doneAfterFail) throw new Error("失败之后不该再来 switch_done");
	console.log("✓ 打开目录失败：switch_failed 带原因（中英），当前对话纹丝不动");

	// --- 3. 不存在的对话 id：以前静默，现在 switch_failed -----------------------
	A.send({ type: "switch_conversation", id: "c-does-not-exist" });
	const fail3 = await A.waitForType(
		"switch_failed",
		(m) => m.target.kind === "conversation" && m.target.id === "c-does-not-exist",
	);
	if (!fail3.error) throw new Error("switch_failed 没有原因");
	console.log("✓ 不存在的对话 id：switch_failed，不再静默");

	// --- 4. 切到已经是当前的转录：仍然回执 --------------------------------------
	A.send({ type: "switch_session", path: a1File });
	await A.waitForType("switch_done", (m) => sameTarget(m.target, t1), 5000);
	console.log("✓ 切到已经是当前的转录：照样 switch_done（外部客户端不会先拦）");

	// --- 5. switch_conversation 到另一条活着的对话：快照 → switch_done -----------
	// blankConv 离开时被丢弃了（空对话不留），所以再造一条有内容的对话 A2。
	// 当前对话空闲、没终端、从没被列过 → 离开时运行时会被释放（上游的回收规则，不是这个
	// 补丁的事）。要拿到一条**活着**的非当前对话，照界面上真实的做法：另一个窗口正看着它。
	void blankConv;
	void a1Conv;
	const wsB = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		wsB.once("open", resolve);
		wsB.once("error", reject);
	});
	B = new Client(wsB, "B");
	B.send({ type: "hello", clientId: "switch-ack-B" });
	await B.waitForType("ready");
	await B.waitForState((s) => Boolean(s.conversationId));
	B.send({ type: "switch_session", path: a1File });
	await B.waitForType("switch_done", (m) => sameTarget(m.target, t1));
	if (B.state.conversationId !== a1Live) throw new Error("第二个窗口应当订阅到同一条对话");
	A.send({ type: "new_chat" });
	await A.waitForState((s) => s.conversationId !== a1Live);
	A.send({ type: "prompt", text: "second chat" });
	await A.waitForMessage((m) => m.role === "assistant" && JSON.stringify(m.content).includes("echo:second_chat"));
	const a2Conv = A.state.conversationId;
	const t5 = { kind: "conversation", id: a1Live };
	const mark5 = A.all.length;
	A.send({ type: "switch_conversation", id: a1Live });
	const done5 = await A.waitForType("switch_done", (m) => sameTarget(m.target, t5));
	const snap5 = A.all.findIndex((m, i) => i >= mark5 && m.type === "snapshot" && m.state.conversationId === a1Live);
	if (snap5 < 0 || snap5 > A.all.indexOf(done5)) throw new Error("switch_conversation：快照应在 switch_done 之前");
	if (A.state.conversationId !== a1Live)
		throw new Error(`应当在 ${a1Live}，实际 ${A.state.conversationId}（来自 ${a2Conv}）`);
	console.log("✓ 切到另一条活着的对话：先快照后 switch_done");

	console.log("\nswitch-ack: 全部通过");
} finally {
	A?.ws?.close();
	B?.ws?.close();
	server.kill("SIGTERM");
	mock.close();
}
