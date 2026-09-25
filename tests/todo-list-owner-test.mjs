#!/usr/bin/env node
/**
 * todo_list 读的是调用它的那条对话的任务，不是窗口正开着的那条（2026-09-24 实际遇到过：
 * 一条后台对话调 todo_list，拿到的是前台对话的任务列表）。
 *
 * 零 token：mock OpenAI 兼容 provider。一个窗口：
 *   0. 先在页面自带的第一条对话里说一句，再新开对话 A。第一条对话可能是上游「页面加载两次」里
 *      被丢掉的那个连接建的，它的「正开着的对话」永远停在这条上，修复前也碰巧读对；
 *      A 要由活着、之后会切走的这个窗口建。
 *   1. 对话 A 用内联标记记一条任务（alpha task），调一次 todo_list，然后下一次模型调用被 mock 扣住；
 *   2. 窗口新开对话 B，B 记一条自己的任务（bravo task）；
 *   3. 放开 A：A 在后台再调一次 todo_list，mock 把这次的工具结果记下来。
 * 修复前这次结果是 B 的列表（bravo task），修复后是 A 自己的（alpha task）。
 *
 * 需要已构建的 dist/（npm run build）。用法：node tests/todo-list-owner-test.mjs
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const MOCK_PORT = PORT + 1;
const REPO = fileURLToPath(new URL("..", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "piweb-todoowner-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });

const MODEL_ID = "todoowner-mock";
const W_Q = "TODOTEST-W warm up";
const A_Q = "TODOTEST-A keep a task list";
const B_Q = "TODOTEST-B a different chat";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`  ${ok ? "✓" : "✗ FAIL:"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};
async function waitFor(fn, ms) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await fn()) return true;
		await sleep(200);
	}
	return false;
}

// ---- mock provider ---------------------------------------------------------
const chunk = (model, delta, finish = null) => ({
	id: "todoowner-mock",
	object: "chat.completion.chunk",
	created: Math.floor(Date.now() / 1000),
	model,
	choices: [{ index: 0, delta, finish_reason: finish }],
});
async function sse(res, chunks, gapMs = 0) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const c of chunks) {
		res.write(`data: ${JSON.stringify(c)}\n\n`);
		if (gapMs) await sleep(gapMs);
	}
	res.write("data: [DONE]\n\n");
	res.end();
}
const todoCall = (id) => ({
	index: 0,
	id,
	type: "function",
	function: { name: "todo_list", arguments: JSON.stringify({ action: "list" }) },
});
const textOf = (msg) => {
	const c = msg?.content;
	return typeof c === "string" ? c : (c ?? []).map((p) => p.text ?? "").join("\n");
};

let releaseA;
const gateA = new Promise((r) => (releaseA = r));
/** A 的第二次模型调用到达（被扣住）的时刻 / A 答完的时刻。 */
let aHeldAt = 0;
let aDoneAt = 0;
/** A 在后台调 todo_list 拿到的文本。 */
let aListWhileBehind = null;
let todoOffered = null;

const mock = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${MOCK_PORT}`);
	if (url.pathname.endsWith("/models")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model" }] }));
		return;
	}
	if (!url.pathname.endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	for await (const c of req) body += c;
	const payload = JSON.parse(body || "{}");
	const m = payload.model;
	const history = payload.messages ?? [];
	// 按这条对话自己的提问认是哪条。跳过「(System reminder …」：上游会在提问后附一条提醒，
	// 列出同一项目里正在跑的别的对话（连同它们的提问）。
	const ownText = history
		.filter((x) => x.role === "user")
		.flatMap((x) => (typeof x.content === "string" ? [x.content] : (x.content ?? []).map((p) => p.text ?? "")))
		.filter((t) => !t.startsWith("(System reminder"))
		.join("\n");
	const isA = ownText.includes("TODOTEST-A");
	const isW = ownText.includes("TODOTEST-W");
	const tools = payload.tools ?? [];
	// 旁路请求（起标题之类）不带工具。
	if (!Array.isArray(tools) || tools.length === 0) {
		await sse(res, [chunk(m, { content: isA ? "Chat A" : isW ? "Warm-up" : "Chat B" }), chunk(m, {}, "stop")]);
		return;
	}
	if (isW) {
		await sse(res, [chunk(m, { content: "Warmed up" }), chunk(m, {}, "stop")], 200);
		return;
	}
	todoOffered ??= tools.some((t) => (t.function?.name ?? t.name) === "todo_list");
	let lastUser = -1;
	history.forEach((x, i) => {
		if (x.role === "user") lastUser = i;
	});
	const results = history.slice(lastUser + 1).filter((x) => x.role === "tool").length;
	if (process.env.TODOOWNER_DEBUG) {
		console.log(
			`    [mock ${new Date().toISOString().slice(17, 23)}] chat ${isA ? "A" : "B"}, tool results ${results}`,
		);
	}
	if (isA) {
		if (results === 0) {
			// 记一条任务（标记在这条消息定稿时生效），顺手调一次 todo_list，好让循环接着走。
			await sse(res, [
				chunk(m, { content: "Alpha noted [[todo:new:alpha task]]" }),
				chunk(m, { tool_calls: [todoCall("call_a1")] }),
				chunk(m, {}, "tool_calls"),
			]);
		} else if (results === 1) {
			aHeldAt = Date.now();
			await gateA; // 等窗口换到 B、B 记好自己的任务
			await sse(res, [chunk(m, { tool_calls: [todoCall("call_a2")] }), chunk(m, {}, "tool_calls")]);
		} else {
			aListWhileBehind = textOf(history.filter((x) => x.role === "tool").at(-1));
			await sse(res, [chunk(m, { content: "TODOTEST-A-DONE" }), chunk(m, {}, "stop")]);
			aDoneAt = Date.now();
		}
		return;
	}
	await sse(
		res,
		[chunk(m, { content: "Bravo noted" }), chunk(m, { content: " [[todo:new:bravo task]]" }), chunk(m, {}, "stop")],
		300,
	);
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "mock-key",
				models: [{ id: MODEL_ID, name: "Mock", input: ["text"], contextWindow: 200000, maxTokens: 4096 }],
			},
		},
	}),
);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "mock", defaultModel: MODEL_ID }));

// ---- server ----------------------------------------------------------------
const server = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
	cwd: REPO,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: workdir,
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_TOKEN: "",
	},
	stdio: ["ignore", "pipe", "pipe"],
	detached: true,
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
process.on("exit", () => {
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
});

async function waitServer() {
	for (let i = 0; i < 150; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(200);
	}
	throw new Error("server did not start");
}

// ---- browser ---------------------------------------------------------------
const messagesText = (page) => page.evaluate(() => document.querySelector(".messages")?.innerText ?? "");

let browser;
const pageErrors = [];
try {
	await waitServer();
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
	await ctx.addInitScript(() => {
		localStorage.setItem("pi-web-client-id", "todoowner-window");
		localStorage.setItem("pi-web-ui:lang", "en");
	});
	const page = await ctx.newPage();
	page.on("pageerror", (e) => pageErrors.push(String(e)));
	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".topbar", { timeout: 60000 });
	const ta = page.locator(".inputbox textarea");
	await ta.waitFor({ timeout: 20000 });
	const send = async (text) => {
		await ta.fill(text);
		await ta.press("Enter");
	};

	console.log("warm up in the first chat, then open chat A from this window");
	await send(W_Q);
	check("the first chat answered", await waitFor(async () => (await messagesText(page)).includes("Warmed up"), 20000));
	await page.locator(".lp-new-chat-action").click();
	check(
		"the window opened a new chat",
		await waitFor(async () => !(await messagesText(page)).includes("Warmed up"), 10000),
	);

	console.log("chat A: record a task, then wait on the model");
	await send(A_Q);
	check("chat A's second model call is being held", await waitFor(() => aHeldAt > 0, 20000));

	console.log("open chat B while A is still running");
	await page.locator(".lp-new-chat-action").click();
	check(
		"the window switched to a new chat",
		await waitFor(async () => !(await messagesText(page)).includes("TODOTEST-A"), 10000),
	);
	await send(B_Q);
	check("chat B answered", await waitFor(async () => (await messagesText(page)).includes("Bravo noted"), 20000));
	await sleep(1000); // B 的标记生效

	console.log("let chat A call todo_list in the background");
	releaseA();
	check("chat A finished", await waitFor(() => aDoneAt > 0, 20000));
	check("the window still showed chat B", !(await messagesText(page)).includes("TODOTEST-A"));
	check("todo_list was offered to the model", todoOffered === true, String(todoOffered));
	check(
		"A's todo_list lists A's own task",
		!!aListWhileBehind?.includes("alpha task"),
		JSON.stringify(aListWhileBehind),
	);
	check("A's todo_list does not list the open chat's task", !aListWhileBehind?.includes("bravo task"));
	check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (e) {
	failures++;
	console.log(`  ✗ FAIL: ${e?.stack ?? e}`);
} finally {
	releaseA?.();
	await browser?.close();
	mock.close();
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
}

if (failures) {
	console.log(`\n${failures} check(s) failed. Server log tail:\n${serverLog.split("\n").slice(-30).join("\n")}`);
	process.exit(1);
}
console.log("\nall todo-list-owner checks passed");
