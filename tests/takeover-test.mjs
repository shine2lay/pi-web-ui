// 另一页打开正在等答复的对话（零 token）：对话归服务端（server-owned-chats），B 页直接在
// 自己的列表里打开 A 页那条，接着答卷、继续跑。原为上游「过户」take_over_conversation 冒烟。
//
// 假模型（question-bridge 同款）：第 1 回合回 ask_user_question 工具调用，第 2 回合
// （B 答卷之后）**再回一次** ask_user_question，第 3 回合回 browser_page，第 4 回合把
// 全部工具结果回显成 assistant 文本。
//
// 验证（server-owned-chats 口径，ops #870 改写；原上游「过户」口径的哪些断言删了、为什么，见
// PATCHES.md server-owned-chats「上游冒烟按新口径改写」）：
//   1. A 提问挂起（question_pending + streaming）时，B（全新 clientId，A 还在线）在**自己的**
//      对话列表里看到 A 那条（同一个 convId、在跑、带 hasQuestion），只此一行，没有另一处只读行；
//   2. B 打开它（switch_conversation）→ 看到历史、快照里就有那张问卷；
//   3. B 回答 → A 页对话框收起（question_retracted），工具结果回到模型，run 继续；
//   4. **B 打开之后新提出的问卷/页面调用**：问卷进 B 的快照；page_request 只送 B（最新接入的
//      正在看这条对话的在线浏览器，conversation-home），不漂到 A；
//   5. A 没丢任何东西：仍在同一条对话上、列表里仍有它、看得到 B 答完后的回答。
// Usage: npm run build && node tests/takeover-test.mjs [port]
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";

const PORT = Number(process.argv[2] || 8987);
const MOCK_PORT = PORT + 1;
freePort(PORT);
freePort(MOCK_PORT);
const base = mkdtempSync(join(tmpdir(), "pi-web-takeover-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const MODEL_ID = "takeover-mock";
const QUESTIONS = [
	{
		id: "scope",
		header: "范围",
		question: "要做到什么程度？",
		options: [{ label: "最小可用" }, { label: "完整实现" }],
	},
	{
		id: "note",
		header: "补充",
		question: "还有什么要交代的？",
	},
];

const sse = (res, chunks) => {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
};
const delta = (model, d, finish = null) => ({
	id: "takeover-mock",
	object: "chat.completion.chunk",
	created: Date.now(),
	model,
	choices: [{ index: 0, delta: d, finish_reason: finish }],
});

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
	const messages = Array.isArray(payload.messages) ? payload.messages : [];
	const toolMsgs = messages.filter((m) => m.role === "tool");
	const askCall = (payload, callId) => [
		delta(payload.model, {
			tool_calls: [
				{
					index: 0,
					id: callId,
					type: "function",
					function: { name: "ask_user_question", arguments: JSON.stringify({ questions: QUESTIONS }) },
				},
			],
		}),
		delta(payload.model, {}, "tool_calls"),
	];
	const pageCall = (payload) => [
		delta(payload.model, {
			tool_calls: [
				{
					index: 0,
					id: "call_page_1",
					type: "function",
					function: { name: "browser_page", arguments: JSON.stringify({ op: "read", what: "title" }) },
				},
			],
		}),
		delta(payload.model, {}, "tool_calls"),
	];
	if (toolMsgs.length === 0) {
		if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
			sse(res, [delta(payload.model, { content: "ok" }), delta(payload.model, {}, "stop")]);
			return;
		}
		sse(res, askCall(payload, "call_ask_1"));
		return;
	}
	// 过户之后提出的第二张问卷（回归：必须送到新持有方）。
	if (toolMsgs.length === 1) {
		sse(res, askCall(payload, "call_ask_2"));
		return;
	}
	// 再过一轮：过户之后调 browser_page（同一根因，page_request 也必须送到新持有方）。
	if (toolMsgs.length === 2) {
		sse(res, pageCall(payload));
		return;
	}
	sse(res, [
		delta(payload.model, {
			content: `ANSWERED:${toolMsgs.map((m) => String(m.content ?? "")).join(" | ")}`,
		}),
		delta(payload.model, {}, "stop"),
	]);
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
/** 等运行列表里出现符合谓词的行（conversations 推送驱动）。 */
const waitRow = async (c, pred, what, timeout = 15000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const row = c.conversations.find(pred);
		if (row) return row;
		await sleep(100);
	}
	throw new Error(`[${c.name}] timeout waiting for row: ${what}`);
};
try {
	await waitForPort(PORT);

	const openClient = async (clientId, withModel = true) => {
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
		if (withModel) {
			c.send({ type: "set_model", modelId: `mock/${MODEL_ID}` });
			await c.waitForState((s) => s.model?.id === MODEL_ID);
		}
		return c;
	};

	// A：提问挂起（run 阻塞在等人类回答，streaming 中）。
	clientA = await openClient("takeover-A");
	clientA.send({ type: "prompt", text: "先问我几个问题" });
	const pendingA = await clientA.waitForType("question_pending", () => true, 40000);
	check("A 问卷挂起", pendingA.questions?.length === 2, `id=${pendingA.id}`);
	await clientA.waitForState((s) => s.isStreaming === true, 15000);
	const convA = clientA.state.conversationId;
	// 运行列表给等问卷的对话挂「?」角标（自有行；elsewhere 行同信息已在下面断言）。
	const rowAq = await waitRow(clientA, (c) => c.id === convA && c.hasQuestion === true, "A row hasQuestion");
	check("运行列表标出等问卷（A 页自有行）", !!rowAq);

	// 小工具：轮询到真或超时。
	const until = async (pred, timeout = 15000) => {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (pred()) return true;
			await sleep(100);
		}
		return false;
	};
	const assistantText = (c) =>
		(c.messages ?? [])
			.filter((m) => m.role === "assistant")
			.flatMap((m) => m.content ?? [])
			.map((b) => b.text ?? "")
			.join("\n");

	// B：全新页面（A 还在线）。对话归服务端：A 那条就在 B 自己的列表里，同一个 convId。
	clientB = await openClient("takeover-B", false);
	// 新标签会接管同项目最近那条（reload-adopt）；B 先去自己的新对话，下面的「打开」才是真切换。
	if (clientB.state.conversationId === convA) {
		clientB.send({ type: "new_chat" });
		await clientB.waitForState((s) => s.conversationId !== convA, 15000);
	}
	const row = await waitRow(clientB, (c) => c.id === convA && c.isStreaming === true, "A's chat in B's list");
	check("B 的列表里有 A 正在跑的对话（同一 convId）", row?.id === convA, `id=${row?.id}`);
	check("B 的列表行标出等答复问卷", row?.hasQuestion === true, `hasQuestion=${row?.hasQuestion}`);
	check(
		"只此一行，没有另一处只读副本",
		clientB.conversations.filter((c) => c.id === convA).length === 1 && clientB.elsewhere.length === 0,
		JSON.stringify({ rows: clientB.conversations.map((c) => c.id), elsewhere: clientB.elsewhere }),
	);

	// B 打开它（普通切换；不搬 runtime，单 writer 由共享表保证）。
	clientB.send({ type: "switch_conversation", id: convA });
	await clientB.waitForState((s) => s.conversationId === convA, 15000);
	check(
		"B 打开后看到历史",
		await until(() => JSON.stringify(clientB.messages).includes("先问我几个问题")),
		`msgs=${clientB.messages.length}`,
	);
	await clientB.waitForState((s) => s.pendingQuestion?.id === pendingA.id, 15000);
	check("B 快照里就有那张问卷（同题目）", clientB.state.pendingQuestion?.questions?.[0]?.id === "scope");

	// B 回答问卷 → A 页对话框收起，工具结果回到模型，run 继续。
	clientB.send({
		type: "question_answer",
		id: pendingA.id,
		answers: [
			{ id: "scope", selected: ["完整实现"] },
			{ id: "note", selected: [], custom: "别动图标" },
		],
	});
	const retracted = await clientA.waitForType("question_retracted", (m) => m.id === pendingA.id, 15000);
	check("A 页旧问卷被撤回（对话框收起）", retracted.id === pendingA.id, `id=${retracted.id}`);
	check(
		"A 页不再挂着那张问卷",
		await until(() => clientA.state?.pendingQuestion?.id !== pendingA.id),
		`pending=${clientA.state?.pendingQuestion?.id}`,
	);

	// B 打开之后模型再提问：B 必须收到并进它的快照（刷新/重连可恢复）。
	const pendingB2 = await clientB.waitForType("question_pending", (m) => m.id !== pendingA.id, 30000);
	check("打开后新问卷送达 B", pendingB2.questions?.length === 2, `id=${pendingB2.id}`);
	await clientB.waitForState((s) => s.pendingQuestion?.id === pendingB2.id, 15000);
	check("打开后新问卷进 B 的快照（刷新/重连可恢复）", true);
	clientB.send({
		type: "question_answer",
		id: pendingB2.id,
		answers: [{ id: "scope", selected: ["完整实现"] }],
	});

	// browser_page 的 page_request 只送一个页面：最新接入的、正在看这条对话的在线浏览器（B）。
	const pageReq = await clientB.waitForType("page_request", () => true, 30000);
	check("打开后 page_request 送达 B", typeof pageReq.id === "string", `id=${pageReq.id} op=${pageReq.op}`);
	{
		await sleep(1500);
		const stray = clientA.received.find((m) => m.type === "page_request");
		check("page_request 没有误发给 A", !stray, stray ? `id=${stray.id}` : "无");
	}
	clientB.send({ type: "page_response", id: pageReq.id, ok: true, result: { title: "Mock page" } });

	{
		const ok = await until(
			() => assistantText(clientB).includes("ANSWERED:") && assistantText(clientB).includes("完整实现"),
			30000,
		);
		check(
			"B 答卷后模型收到答案并继续",
			ok && assistantText(clientB).includes("别动图标"),
			assistantText(clientB).slice(-200),
		);
	}
	check(
		"回答后等问卷角标消失",
		await until(() => {
			const r = clientB.conversations.find((c) => c.id === convA);
			return !!r && !r.hasQuestion;
		}, 30000),
	);
	// A 没丢任何东西：仍在这条对话上、列表里仍有它、看得到同一个回答。
	check("A 仍在同一条对话上", clientA.state?.conversationId === convA, clientA.state?.conversationId);
	check(
		"A 的列表里仍有这条对话",
		clientA.conversations.some((c) => c.id === convA),
	);
	check(
		"A 也看到 B 答完后的回答",
		await until(() => assistantText(clientA).includes("别动图标"), 15000),
		assistantText(clientA).slice(-120),
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
	process.exit(failures === 0 ? 0 : 1);
}
