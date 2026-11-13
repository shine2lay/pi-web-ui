// issue #291 回归（零 token）：elsewhere（「另一处」）列表的生命周期缺陷。
//
// 1) 断连残骸不入列表：客户端 A 用随机 clientId attach 并发一次 prompt（产生对话），
//    断开 socket 后，另一个客户端 B 的 elsewhere 里不应再有 A 的行（修复前会永久留着）。
//    含正向对照：A 在线时 B 必须能看到那一行（证明测试真的在读这张列表）。
// 2) 删除定时任务回收伪客户端：建一个任务并 schedule_run 一次（产生 `scheduler:<id>`
//    伪客户端 + 一条对话）→ B 的 elsewhere 有该行；schedule_delete 后该行应消失。
//
// 断言口：conversations 消息里的 elsewhere 数组（owner 字段标识持有方）。
// Usage: npm run build && node tests/elsewhere-lifecycle-test.mjs [port]
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.argv[2] || 8981);
const MOCK_PORT = PORT + 1;
freePort(PORT);
freePort(MOCK_PORT);

const base = mkdtempSync(join(tmpdir(), "pi-web-elsewhere-lifecycle-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const MODEL_ID = "elsewhere-lifecycle-mock";
const sse = (res, chunks) => {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
};
const delta = (model, d, finish = null) => ({
	id: MODEL_ID,
	object: "chat.completion.chunk",
	created: Date.now(),
	model,
	choices: [{ index: 0, delta: d, finish_reason: finish }],
});
// mock：直接回文本并结束（run 结束后对话仍被持有方留着 = 空闲 elsewhere 行）。
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
	sse(res, [delta(payload.model, { content: "ELSEWHERE-OK" }), delta(payload.model, {}, "stop")]);
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify(
		{
			providers: {
				mock: {
					name: "Mock",
					api: "openai-completions",
					baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
					apiKey: "sk-mock",
					models: [{ id: MODEL_ID, name: "Mock" }],
				},
			},
		},
		null,
		2,
	),
);

const server = spawn(process.execPath, [join(realpathSync("."), "dist", "server", "index.js")], {
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_HOST: "127.0.0.1",
		PI_WEB_CWD: workdir,
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		// 显式清空：测试必须与 ambient shell 的 PI_WEB_TOKEN 无关。
		PI_WEB_TOKEN: "",
		PI_WEB_PLUGIN_CATALOG_URL: "",
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});

let serverOut = "";
server.stdout.on("data", (d) => (serverOut += String(d)));
server.stderr.on("data", (d) => (serverOut += String(d)));

const cleanup = () => {
	try {
		clientB?.ws.close();
	} catch {
		/* ignore */
	}
	try {
		server.kill();
	} catch {
		/* ignore */
	}
	try {
		mock.close();
	} catch {
		/* ignore */
	}
};

class Client {
	constructor(ws, name) {
		this.ws = ws;
		this.name = name;
		this.received = [];
		this.state = null;
		this.conversations = [];
		this.elsewhere = [];
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			if (message.type === "snapshot") this.state = message.state;
			else if (message.type === "conversations") {
				this.conversations = message.conversations ?? [];
				this.elsewhere = message.elsewhere ?? [];
			}
		});
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	async waitForType(type, predicate = () => true, timeout = 30000) {
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
	async waitForState(predicate, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error(`[${this.name}] timeout waiting for state`);
	}
}

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

/** 等 B 的对话列表出现符合谓词的行 / 不再有（conversations 推送驱动）。 */
const waitRow = async (c, pred, what, timeout = 15000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const row = c.conversations.find(pred);
		if (row) return row;
		await sleep(100);
	}
	throw new Error(
		`[${c.name}] timeout waiting for row: ${what}; rows=${JSON.stringify(c.conversations.map((r) => ({ id: r.id, title: r.title, live: r.live, n: r.messageCount })))}`,
	);
};
const waitRowGone = async (c, pred, timeout = 15000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		if (!c.conversations.some(pred)) return true;
		await sleep(100);
	}
	return false;
};

let clientA;
let clientB;
try {
	// 等健康检查
	for (let i = 0; i < 160; i++) {
		try {
			const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
			if (r.ok) break;
		} catch {
			/* not up yet */
		}
		await sleep(250);
		if (i === 159) throw new Error("server did not come up");
	}

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
		await c.waitForState((s) => Boolean(s), 20000);
		if (withModel) {
			c.send({ type: "set_model", modelId: `mock/${MODEL_ID}` });
			await c.waitForState((s) => s.model?.id === MODEL_ID);
		}
		return c;
	};

	// B：先上线的观察者（有 sink → 其他客户端的对话在它这里是 elsewhere 行）。
	clientB = await openClient("observer-b");

	// --- 场景 1：关掉的页面不留只读残骸 ---
	const deadId = "probe-dead-1790000000000";
	clientA = await openClient(deadId);
	clientA.send({ type: "prompt", text: "残骸测试：只回复 OK" });
	await clientA.waitForState((s) => s.isStreaming === true, 20000).catch(() => {});
	const convA = clientA.state.conversationId;
	// 正向对照：A 在线时，B 必须在自己的列表里看到 A 的对话（证明测试真的在读这张列表）。
	const liveRow = await waitRow(clientB, (c) => c.id === convA && (c.messageCount ?? 0) > 0, "A live row");
	check("A 在线时 B 的列表里有 A 的对话（正向对照）", !!liveRow, `id=${liveRow.id}`);
	await clientA.waitForState((s) => s.isStreaming === false, 30000).catch(() => {});

	// 断开 A（不 detach 回收 → 模拟「关浏览器」）。对话归服务端：它留在 B 的列表里，是一条
	// B 能打开的普通对话，而不是打不开的「另一处」只读残骸（#291 的症状）。
	clientA.ws.close();
	await sleep(1500);
	check("A 断连后 B 没有只读残骸行（#291 修复点）", clientB.elsewhere.length === 0, JSON.stringify(clientB.elsewhere));
	clientB.send({ type: "switch_conversation", id: convA });
	await clientB.waitForState((s) => s.conversationId === convA, 15000);
	// 这个客户端只记完整快照（不合并增量）：要一份新的再看内容。
	clientB.send({ type: "get_state" });
	const opened = await clientB
		.waitForState((s) => (s.messages ?? []).some((m) => JSON.stringify(m.content ?? "").includes("残骸测试")), 15000)
		.catch(() => null);
	check("A 断连后 B 能打开那条对话、看到内容", !!opened, `msgs=${(clientB.state.messages ?? []).length}`);

	// --- 场景 2：删除定时任务回收它的对话 ---
	const taskId = "task-lifecycle-291";
	clientB.send({
		type: "schedule_save",
		task: {
			id: taskId,
			name: "生命周期测试",
			kind: "cron",
			spec: "0 0 1 1 *",
			prompt: "hi",
			cwd: workdir,
			enabled: false,
			catchUp: "skip",
		},
	});
	await clientB.waitForType("scheduler_tasks", (m) => (m.tasks ?? []).some((t) => t.id === taskId), 15000);

	const before = new Set(clientB.conversations.map((c) => c.id));
	clientB.send({ type: "schedule_run", id: taskId });
	// 正向对照：任务跑起来后它的对话出现在 B 的列表里。
	const schedRow = await waitRow(clientB, (c) => !before.has(c.id) && !c.isSubagent, "scheduler row", 30000);
	check("定时任务的对话出现在列表里（正向对照）", !!schedRow, `id=${schedRow.id} title=${schedRow.title}`);

	// 删除任务 → 它的对话应被回收。
	clientB.send({ type: "schedule_delete", id: taskId });
	const schedGone = await waitRowGone(clientB, (c) => c.id === schedRow.id, 20000);
	check(
		"删除定时任务后它的对话从列表消失（#291 修复点）",
		schedGone,
		`rows=${JSON.stringify(clientB.conversations.map((c) => c.id))}`,
	);
} catch (err) {
	console.error(`\nFAIL: ${err.message}`);
	console.error("--- server output ---\n" + serverOut.slice(-4000));
	cleanup();
	process.exit(1);
}

cleanup();
if (failures > 0) {
	console.error("--- server output ---\n" + serverOut.slice(-3000));
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nPASS: elsewhere 生命周期（#291）");
process.exit(0);
