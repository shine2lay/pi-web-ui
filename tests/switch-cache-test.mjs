// switch-cache：切回看过的对话，浏览器先显示自己缓存的那份，服务端只补差异。
//
// 协议（服务端那一半，纯 WS）：
//   1. have 对得上、这期间没新消息：快照带 reuse（= have），messages 为空；先快照后 switch_done。
//   2. have 是旧的（之后又聊了一轮）：reuse + 只有新增的那两条，拼起来和完整列表一样。
//   3. 指纹不对 / 会话不对 / 条数超出 / 字段是垃圾：照常发完整的，不带 reuse，服务端不崩。
//   4. 切回一条还在跑的对话（switch_conversation）：同样只补差异。
// 页面（浏览器）：
//   5. 点回看过的对话：发出去的 switch 带 have，收到的快照带 reuse；
//      缓存那份在服务端的快照交到页面**之前**就显示出来了（预览）；两轮回答都在；接着聊照常。
//      小对话服务端几十毫秒就回来了，比大小会抢跑：点击前在页面里模拟 400ms 网络延迟（按到达顺序
//      排队再交给应用），比的是「预览出现」和「应用最早能拿到快照」。缓存预览坟了的话文字要等快照，必挂。
//
// 零 token：mock SSE 模型。Usage: node tests/switch-cache-test.mjs [port]   （先 npm run build）
import { CHROME_PATH } from "./lib/chrome.mjs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import WebSocket from "ws";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const { messagesHash } = await import(join(REPO, "dist", "server", "window-hash.js"));
const PORT = Number(process.argv[2] || 8995);
const MOCK_PORT = PORT + 1;
const MODEL_ID = "mock-model";
const base = mkdtempSync(join(tmpdir(), "pi-web-switch-cache-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });

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
		await sleep(100);
	}
	return false;
}

// ---- mock provider ---------------------------------------------------------
const chunk = (model, delta, finish = null) => ({
	id: "switch-cache-mock",
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
const textOf = (x) =>
	typeof x.content === "string" ? x.content : (x.content ?? []).map((p) => p.text ?? "").join(" ");
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
	// 跳过「(System reminder …」：上游会在提问后附一条提醒，列出同项目里别的对话。
	const users = (payload.messages ?? [])
		.filter((x) => x.role === "user")
		.map(textOf)
		.filter((t) => !t.startsWith("(System reminder"));
	const own = users.join("\n");
	// 旁路请求（起标题）不带工具。
	if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
		const title = own.includes("CACHE-P")
			? "Page chat P"
			: own.includes("CACHE-Q")
				? "Page chat Q"
				: own.includes("CACHE-SLOW")
					? "Chat Slow"
					: "Chat Alpha";
		await sse(res, [chunk(m, { content: title }), chunk(m, {}, "stop")]);
		return;
	}
	const last = (users.at(-1) ?? "").trim().split(/\s+/)[0];
	if (last.startsWith("CACHE-SLOW")) {
		const parts = Array.from({ length: 8 }, (_, i) => chunk(m, { content: `${i ? " " : ""}slow${i}` }));
		await sse(res, [...parts, chunk(m, { content: ` REPLY:${last}` }), chunk(m, {}, "stop")], 500);
		return;
	}
	await sse(res, [chunk(m, { content: `REPLY:${last}` }), chunk(m, {}, "stop")]);
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
			if ((await fetch(`http://localhost:${PORT}/`)).ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(200);
	}
	throw new Error("server did not start");
}

// ---- WS client ---------------------------------------------------------------
class Client {
	constructor(ws, name) {
		this.ws = ws;
		this.name = name;
		this.received = [];
		this.all = [];
		this.sizes = new Map();
		this.state = null;
		this.messages = [];
		ws.on("message", (data) => {
			const raw = data.toString();
			const message = JSON.parse(raw);
			this.sizes.set(message, raw.length);
			this.received.push(message);
			this.all.push(message);
			if (message.type === "snapshot") {
				this.state = message.state;
				// reuse：把自己手里那截接上（这里只在测试里用：手里那截就是上次记下的完整列表）
				this.messages = message.reuse
					? [...this.cached.slice(0, message.reuse.count), ...(message.state.messages ?? [])]
					: (message.state.messages ?? []);
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
		/** 「手里的缓存」：reuse 时从这里取前 count 条。 */
		this.cached = [];
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
			await sleep(30);
		}
		throw new Error(`[${this.name}] timeout waiting for ${type}`);
	}
	async waitForState(predicate, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(30);
		}
		throw new Error(`[${this.name}] timeout waiting for state`);
	}
	async waitForMessage(predicate, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			const m = this.messages.find(predicate);
			if (m) return m;
			await sleep(30);
		}
		throw new Error(`[${this.name}] timeout waiting for message`);
	}
}

const windowOf = (sessionId, msgs, start = 0) => ({ sessionId, start, count: msgs.length, hash: messagesHash(msgs) });
const ids = (msgs) => msgs.map((m) => m.id).join(",");

/** 切到 path/id 并等 switch_done；返回这次切换的那份快照（在 switch_done 之前到的）。 */
async function switchAndGetSnapshot(W, msg) {
	const mark = W.all.length;
	W.send(msg);
	const done = await W.waitForType("switch_done", () => true, 20000);
	const doneIdx = W.all.indexOf(done);
	const snaps = W.all.slice(mark, doneIdx).filter((m) => m.type === "snapshot");
	return { snap: snaps.at(-1) ?? null, beforeDone: snaps.length > 0 };
}

async function ask(W, text) {
	const word = text.split(/\s+/)[0];
	W.send({ type: "prompt", text });
	await W.waitForMessage((m) => m.role === "assistant" && JSON.stringify(m.content).includes(`REPLY:${word}`), 30000);
	await W.waitForState((s) => !s.isStreaming, 20000);
}

// ---- browser helpers -----------------------------------------------------------
/** 记下页面收到的每份快照（到达时刻、是否 reuse、字节数）和发出的切换（带没带 have）。
 *  监听在构造时就挂上，先于页面自己的 onmessage：记的是「到达」而不是「处理完」。 */
const WS_RECORDER = () => {
	window.__snaps = [];
	window.__sent = [];
	// 模拟网络延迟：>0 时应用的 onmessage 晚这么多毫秒才拿到消息（排队，不乱序）。
	window.__lagMs = 0;
	const Native = window.WebSocket;
	window.WebSocket = class extends Native {
		constructor(...args) {
			super(...args);
			this.__app = null;
			this.__q = [];
			super.onmessage = (ev) => {
				const lag = window.__lagMs || 0;
				if (!lag && this.__q.length === 0) return this.__app?.call(this, ev);
				this.__q.push({ ev, due: performance.now() + lag });
				if (this.__q.length === 1) this.__pump();
			};
			this.addEventListener("message", (ev) => {
				try {
					const m = JSON.parse(ev.data);
					if (m.type !== "snapshot") return;
					window.__snaps.push({
						at: performance.now(),
						lag: window.__lagMs || 0,
						reuse: m.reuse ?? null,
						n: m.state.messages.length,
						bytes: ev.data.length,
						file: m.state.sessionFile,
					});
				} catch {
					/* not json */
				}
			});
			const send = this.send.bind(this);
			this.send = (data) => {
				try {
					const m = JSON.parse(data);
					if (m.type === "switch_session" || m.type === "switch_conversation")
						window.__sent.push({ at: performance.now(), type: m.type, have: m.have ?? null });
				} catch {
					/* not json */
				}
				return send(data);
			};
		}
		__pump() {
			const head = this.__q[0];
			if (!head) return;
			setTimeout(
				() => {
					this.__q.shift();
					this.__app?.call(this, head.ev);
					this.__pump();
				},
				Math.max(0, head.due - performance.now()),
			);
		}
		get onmessage() {
			return this.__app;
		}
		set onmessage(fn) {
			this.__app = fn;
		}
	};
	// 预览检测：点击前设 __watch = 要找的文字；它第一次出现在消息区的时刻记进 __seenAt。
	window.__watch = null;
	window.__seenAt = 0;
	new MutationObserver(() => {
		if (!window.__watch || window.__seenAt) return;
		const text = document.querySelector(".messages")?.innerText ?? "";
		if (text.includes(window.__watch)) window.__seenAt = performance.now();
	}).observe(document, { subtree: true, childList: true, characterData: true });
};
const messagesText = (page) => page.evaluate(() => document.querySelector(".messages")?.innerText ?? "");
async function sendIn(page, text) {
	const ta = page.locator(".inputbox textarea");
	await ta.fill(text);
	await ta.press("Enter");
}

let browser;
const pageErrors = [];
try {
	await waitServer();

	// ======== 协议 ========
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const W = new Client(ws, "W");
	W.send({ type: "hello", clientId: "switch-cache-ws" });
	await W.waitForType("ready");
	await W.waitForState((s) => Boolean(s.conversationId));

	console.log("protocol: chat A gets three exchanges");
	for (const n of [1, 2, 3]) await ask(W, `CACHE-A-${n} hello`);
	const aFile = W.state.sessionFile;
	const aSession = W.state.sessionId;
	const aConv = W.state.conversationId;
	const a6 = W.messages.slice();
	check(
		"chat A has 6 messages, window starts at 0",
		a6.length === 6 && (W.state.messagesStart ?? 0) === 0,
		`${a6.length}`,
	);

	console.log("1. switch back with a matching window, nothing new");
	W.send({ type: "new_chat" });
	await W.waitForState((s) => s.conversationId !== aConv);
	W.cached = a6;
	const have6 = windowOf(aSession, a6);
	const r1 = await switchAndGetSnapshot(W, { type: "switch_session", path: aFile, have: have6 });
	check("the snapshot came before switch_done", r1.beforeDone);
	check(
		"the snapshot carries reuse = have",
		JSON.stringify(r1.snap?.reuse) === JSON.stringify(have6),
		JSON.stringify(r1.snap?.reuse),
	);
	check("no messages resent", r1.snap?.state.messages.length === 0, `${r1.snap?.state.messages.length}`);
	check("window start kept", (r1.snap?.state.messagesStart ?? -1) === 0);
	check("prefix + tail = the whole chat", ids(W.messages) === ids(a6));
	const reopened = W.state.conversationId !== aConv;
	console.log(`    (chat A was ${reopened ? "reopened from history" : "still open"} on the way back)`);
	const reuseBytes = W.sizes.get(r1.snap);
	const markFull = W.all.length;
	W.send({ type: "get_state" });
	await waitFor(() => W.all.slice(markFull).some((m) => m.type === "snapshot"), 10000);
	const full = W.all.slice(markFull).find((m) => m.type === "snapshot");
	const fullBytes = W.sizes.get(full);
	check(
		"a get_state is still a full snapshot",
		full && !full.reuse && full.state.messages.length === 6,
		`${full?.state.messages.length} reuse=${!!full?.reuse}`,
	);
	console.log(`    bytes: full snapshot ${fullBytes}, reuse snapshot ${reuseBytes}`);

	console.log("2. an older window: only the new messages come back");
	await ask(W, "CACHE-A-4 more");
	const a8 = W.messages.slice();
	check("chat A has 8 messages now", a8.length === 8, `${a8.length}`);
	W.send({ type: "new_chat" });
	await W.waitForState((s) => s.sessionFile !== aFile);
	W.cached = a6;
	const r2 = await switchAndGetSnapshot(W, { type: "switch_session", path: aFile, have: have6 });
	check("reuse for the old window", JSON.stringify(r2.snap?.reuse) === JSON.stringify(have6));
	check("only the 2 new messages resent", r2.snap?.state.messages.length === 2, `${r2.snap?.state.messages.length}`);
	check("prefix + tail = the whole chat (8)", ids(W.messages) === ids(a8), `${W.messages.length}`);

	console.log("3. windows that don't match get a full snapshot");
	const have8 = windowOf(aSession, a8);
	const bad = [
		["wrong hash", { ...have8, hash: "nope" }],
		["wrong session", { ...have8, sessionId: "not-this-session" }],
		["count past the end", { ...have8, count: 99 }],
		["garbage fields", { sessionId: aSession, start: "x", count: -1, hash: 5 }],
	];
	for (const [label, have] of bad) {
		W.send({ type: "new_chat" });
		await W.waitForState((s) => s.sessionFile !== aFile);
		W.cached = [];
		const r = await switchAndGetSnapshot(W, { type: "switch_session", path: aFile, have });
		check(
			`${label}: full snapshot, no reuse`,
			r.snap && !r.snap.reuse && r.snap.state.messages.length === 8,
			`${r.snap?.state.messages.length} reuse=${!!r.snap?.reuse}`,
		);
	}

	console.log("4. a chat that is still running (switch_conversation)");
	W.send({ type: "new_chat" });
	await W.waitForState((s) => s.sessionFile !== aFile);
	W.send({ type: "prompt", text: "CACHE-SLOW-1 go" });
	// deltas 把新消息放在 appended 里（state 里没有 messages）：看合并后的列表。
	check(
		"the slow chat is running with its question in the list",
		await waitFor(() => W.state?.isStreaming && W.state.sessionId && W.messages.some((m) => m.role === "user"), 20000),
	);
	const sConv = W.state.conversationId;
	const sSession = W.state.sessionId;
	// 手里有的就是此刻的整个列表（消息只往后长，任何前缀服务端都还有）。
	const sMsgs = W.messages.slice();
	await switchAndGetSnapshot(W, { type: "switch_session", path: aFile });
	check("chat A is shown while the slow chat runs", W.state.sessionFile === aFile);
	W.cached = sMsgs;
	const haveS = windowOf(sSession, sMsgs);
	const r4 = await switchAndGetSnapshot(W, { type: "switch_conversation", id: sConv, have: haveS });
	check("the running chat is still the same conversation", W.state.conversationId === sConv);
	check(
		"reuse for the running chat",
		JSON.stringify(r4.snap?.reuse) === JSON.stringify(haveS),
		JSON.stringify(r4.snap?.reuse),
	);
	check("its first message is not resent", !(r4.snap?.state.messages ?? []).some((m) => m.id === sMsgs[0].id));
	await W.waitForMessage(
		(m) => m.role === "assistant" && JSON.stringify(m.content).includes("REPLY:CACHE-SLOW-1"),
		30000,
	);
	await W.waitForState((s) => !s.isStreaming, 20000);
	check(
		"the slow chat finished on the merged list",
		W.messages[0]?.id === sMsgs[0].id && W.messages.length >= 2,
		`${W.messages.length}`,
	);
	ws.close();

	// ======== 页面 ========
	console.log("5. the page");
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
	await ctx.addInitScript(WS_RECORDER);
	await ctx.addInitScript(() => {
		localStorage.setItem("pi-web-client-id", "switch-cache-page");
		localStorage.setItem("pi-web-ui:lang", "en");
	});
	const page = await ctx.newPage();
	page.on("pageerror", (e) => pageErrors.push(String(e)));
	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".topbar", { timeout: 60000 });
	await page.locator(".inputbox textarea").waitFor({ timeout: 20000 });

	await page.locator(".lp-new-chat-action").click();
	await sleep(500);
	await sendIn(page, "CACHE-P-1 alpha");
	check(
		"page chat P answered once",
		await waitFor(async () => (await messagesText(page)).includes("REPLY:CACHE-P-1"), 20000),
	);
	await sendIn(page, "CACHE-P-2 beta");
	check(
		"page chat P answered twice",
		await waitFor(async () => (await messagesText(page)).includes("REPLY:CACHE-P-2"), 20000),
	);
	await sleep(800);

	await page.locator(".lp-new-chat-action").click();
	check(
		"switched to a new chat",
		await waitFor(async () => !(await messagesText(page)).includes("REPLY:CACHE-P-2"), 10000),
	);
	await sendIn(page, "CACHE-Q-1 gamma");
	check(
		"page chat Q answered",
		await waitFor(async () => (await messagesText(page)).includes("REPLY:CACHE-Q-1"), 20000),
	);
	await sleep(800);

	// 点回 P：记下点击时刻，看 P 的回答什么时候出现在屏幕上。
	const clickAt = await page.evaluate(() => {
		window.__watch = "REPLY:CACHE-P-2";
		window.__seenAt = 0;
		window.__lagMs = 400;
		return performance.now();
	});
	await page
		.locator(".lp-row", { hasText: /Page chat P|CACHE-P/ })
		.first()
		.click();
	check(
		"chat P is back on screen",
		await waitFor(async () => (await messagesText(page)).includes("REPLY:CACHE-P-2"), 15000),
	);
	await waitFor(() => page.evaluate(() => !document.querySelector(".switch-overlay")), 15000);
	const rec = await page.evaluate(
		(t) => ({
			sent: window.__sent.filter((s) => s.at >= t),
			snaps: window.__snaps.filter((s) => s.at >= t),
			seenAt: window.__seenAt,
		}),
		clickAt,
	);
	const sw = rec.sent[0];
	check("the page asked with have", !!sw?.have, `${sw?.type} ${JSON.stringify(sw?.have)}`);
	const snapP = rec.snaps.find((s) => s.reuse);
	check(
		"the server answered with reuse",
		!!snapP,
		rec.snaps.map((s) => `reuse=${!!s.reuse} n=${s.n} ${s.bytes}B`).join(" | "),
	);
	check("the simulated lag was on for that snapshot", snapP?.lag === 400, `${snapP?.lag}`);
	const deliveredAt = snapP ? snapP.at + snapP.lag : Infinity;
	check(
		"chat P was on screen before the server's snapshot reached the app (preview)",
		rec.seenAt > 0 && rec.seenAt < deliveredAt,
		`seen +${Math.round(rec.seenAt - clickAt)}ms, snapshot arrived +${snapP ? Math.round(snapP.at - clickAt) : "?"}ms, reached the app ≥ +${Math.round(deliveredAt - clickAt)}ms`,
	);
	await page.evaluate(() => {
		window.__lagMs = 0;
	});
	const pText = await messagesText(page);
	check("both answers of chat P are shown", pText.includes("REPLY:CACHE-P-1") && pText.includes("REPLY:CACHE-P-2"));
	check("chat Q's answer is gone", !pText.includes("REPLY:CACHE-Q-1"));

	await sendIn(page, "CACHE-P-3 delta");
	check(
		"chat P keeps working after the cached switch",
		await waitFor(async () => (await messagesText(page)).includes("REPLY:CACHE-P-3"), 20000),
	);
	const after = await messagesText(page);
	check(
		"…and nothing went missing",
		["REPLY:CACHE-P-1", "REPLY:CACHE-P-2", "REPLY:CACHE-P-3"].every((s) => after.includes(s)),
	);
	check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (e) {
	failures++;
	console.log(`  ✗ FAIL: ${e?.stack ?? e}`);
} finally {
	await browser?.close().catch(() => {});
	mock.close();
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
}
if (failures > 0) {
	if (process.env.SWITCHCACHE_DEBUG) console.log(serverLog.slice(-4000));
	console.log(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
