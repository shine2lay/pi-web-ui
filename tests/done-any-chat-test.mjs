/* done-any-chat E2E（零 token）：任何一条对话跑完都响「完成」，不只是正开着的那条。
 *
 * mock 的 OpenAI 兼容 provider：「DONEANY-SLOW」那条先跑一个 SLOW_SECS 秒的 bash 再回答，
 * 「DONEANY-QUICK」立刻回答。两个浏览器上下文 = 两个窗口（各自的 client id），AudioContext
 * 换成记录器，按音符认出是哪种提示音（完成 = 880→587 Hz）：
 *  - 窗口 A：慢对话在跑时新开一个对话 —— 不响（以前从在跑的对话切走会误响一次「完成」）；
 *    在新对话里问一句 —— 它答完响一次（正开着的那条）；
 *  - 窗口 B：后打开，切到快对话 —— 它从没订阅过慢对话；
 *  - 慢对话跑完：A 再响一次，B 也响一次（服务端在 agent_settled 时把列表推给所有窗口）；
 *    之后不再多响。
 * 用法: npm run build && node tests/done-any-chat-test.mjs
 *      DONEANY_DEBUG=1 打印两个窗口的提示音时间线。 */
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
const base = mkdtempSync(join(tmpdir(), "piweb-doneany-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });

const MODEL_ID = "doneany-mock";
const SLOW_Q = "DONEANY-SLOW run the slow job";
const SLOW_A = "DONEANY-SLOW-ANSWER the slow job is done.";
const QUICK_Q = "DONEANY-QUICK just say ok";
const QUICK_A = "DONEANY-QUICK-ANSWER ok.";
const SLOW_SECS = 20;

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
	id: "doneany-mock",
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
/** 慢对话的第一个模型请求到达的时刻 / 它的回答发出去的时刻。 */
let slowStartedAt = 0;
let slowAnsweredAt = 0;
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
	// 按这条对话自己的提问认是哪条。跳过「(System reminder …」：首条提问时上游会附一条提醒，
	// 列出同一项目里正在跑的别的对话（连同它们的提问），快对话的请求里就会出现 DONEANY-SLOW。
	const ownText = history
		.filter((x) => x.role === "user")
		.flatMap((x) => (typeof x.content === "string" ? [x.content] : (x.content ?? []).map((p) => p.text ?? "")))
		.filter((t) => !t.startsWith("(System reminder"))
		.join("\n");
	const isSlow = ownText.includes("DONEANY-SLOW");
	// 旁路请求（起标题之类）不带工具：按是哪条对话回一个标题。
	if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
		const title = isSlow ? "Slow chat" : ownText.includes("DONEANY-QUICK") ? "Quick chat" : "Mock";
		await sse(res, [chunk(m, { content: title }), chunk(m, {}, "stop")]);
		return;
	}
	let lastUser = -1;
	history.forEach((x, i) => {
		if (x.role === "user") lastUser = i;
	});
	const results = history.slice(lastUser + 1).filter((x) => x.role === "tool").length;
	if (process.env.DONEANY_DEBUG) {
		const chat = isSlow ? "slow" : "quick";
		console.log(`    [mock ${new Date().toISOString().slice(17, 23)}] ${chat} chat request, tool results ${results}`);
	}
	if (isSlow) {
		if (results === 0) {
			slowStartedAt ||= Date.now();
			const call = { index: 0, id: "call_slow", type: "function" };
			call.function = { name: "bash", arguments: JSON.stringify({ command: `sleep ${SLOW_SECS}; echo slow` }) };
			await sse(res, [chunk(m, { tool_calls: [call] }), chunk(m, {}, "tool_calls")]);
		} else {
			await sse(res, [chunk(m, { content: SLOW_A }), chunk(m, {}, "stop")]);
			slowAnsweredAt = Date.now();
		}
		return;
	}
	// 快对话也要跑一小会儿：几毫秒就答完的话，页面的快照来不及显示它在跑，正开着的那条就不响。
	const parts = QUICK_A.split(" ").map((w, i) => chunk(m, { content: (i ? " " : "") + w }));
	await sse(res, [...parts, chunk(m, {}, "stop")], 500);
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
/** 换掉 AudioContext：每次 playSound 同步排的几个音符记成一组（一组 = 一个提示音）。 */
const AUDIO_RECORDER = () => {
	const cues = [];
	window.__cues = cues;
	let group = null;
	const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} };
	class FakeOscillator {
		type = "sine";
		frequency = { value: 0 };
		connect() {}
		disconnect() {}
		start() {
			if (!group) {
				group = [];
				cues.push({ at: Date.now(), freqs: group });
				queueMicrotask(() => {
					group = null;
				});
			}
			group.push(Math.round(this.frequency.value));
		}
		stop() {}
	}
	class FakeAudioContext {
		state = "running";
		currentTime = 0;
		destination = {};
		resume() {
			return Promise.resolve();
		}
		createOscillator() {
			return new FakeOscillator();
		}
		createGain() {
			return { gain: param, connect() {}, disconnect() {} };
		}
	}
	window.AudioContext = FakeAudioContext;
	window.webkitAudioContext = FakeAudioContext;
};
/** 这个窗口响过的「完成」提示音（sounds.ts 的 DONE：880 Hz 接 587.33 Hz）的时刻。 */
const doneCues = (page) =>
	page.evaluate(() => window.__cues.filter((c) => c.freqs.join(",") === "880,587").map((c) => c.at));
const allCues = (page) => page.evaluate(() => window.__cues.map((c) => ({ at: c.at, freqs: c.freqs.join(",") })));
const messagesText = (page) => page.evaluate(() => document.querySelector(".messages")?.innerText ?? "");

let browser;
const pageErrors = [];
async function openWindow(clientId) {
	const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
	await ctx.addInitScript(AUDIO_RECORDER);
	await ctx.addInitScript((id) => {
		localStorage.setItem("pi-web-client-id", id);
		localStorage.setItem("pi-web-ui:lang", "en");
	}, clientId);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => pageErrors.push(`${clientId}: ${e}`));
	if (process.env.DONEANY_DEBUG) {
		const t0 = Date.now();
		const log = (s) => console.log(`    [${clientId} +${Date.now() - t0}ms] ${s}`);
		page.on("framenavigated", (f) => {
			if (f === page.mainFrame()) log(`navigated ${f.url()}`);
		});
		page.on("websocket", (ws) => {
			ws.on("framesent", (f) => {
				const m = JSON.parse(String(f.payload));
				if (!/^(ping|get_state|list_sessions)$/.test(m.type)) log(`sent ${m.type} ${JSON.stringify(m).slice(0, 120)}`);
			});
			ws.on("framereceived", (f) => {
				let m;
				try {
					m = JSON.parse(String(f.payload));
				} catch {
					return;
				}
				if (m.type !== "conversations") return;
				const rows = (m.conversations ?? []).map(
					(c) => `${c.id.slice(0, 6)}${c.isStreaming ? "*" : ""}${c.live === false ? "(h)" : ""}`,
				);
				log(`conversations active=${String(m.activeId).slice(0, 6)} [${rows.join(" ")}]`);
			});
		});
	}
	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".topbar", { timeout: 60000 });
	await page.locator(".inputbox textarea").waitFor({ timeout: 20000 });
	return page;
}
async function send(page, text) {
	const ta = page.locator(".inputbox textarea");
	await ta.fill(text);
	await ta.press("Enter");
}

try {
	await waitServer();
	browser = await chromium.launch({ executablePath: CHROME_PATH });

	console.log(`window A: start the slow chat (${new Date().toISOString().slice(17, 23)})`);
	const A = await openWindow("doneany-window-a");
	await send(A, SLOW_Q);
	check("the slow run started", await waitFor(() => slowStartedAt > 0, 20000));
	await sleep(1500); // its bash is running now

	console.log("window A: open a new chat while the slow one runs");
	const aBase = (await doneCues(A)).length;
	await A.locator(".lp-new-chat-action").click();
	check(
		"window A switched to a new chat",
		await waitFor(async () => !(await messagesText(A)).includes("DONEANY-SLOW"), 10000),
	);
	await sleep(2000);
	const aAfterSwitch = (await doneCues(A)).length - aBase;
	check("switching away from the running chat did not sound 'done'", aAfterSwitch === 0, `${aAfterSwitch} cue(s)`);

	await send(A, QUICK_Q);
	check(
		"the quick chat answered",
		await waitFor(async () => (await messagesText(A)).includes("DONEANY-QUICK-ANSWER"), 20000),
	);
	check(
		"window A sounded 'done' once for the chat it has open",
		await waitFor(async () => (await doneCues(A)).length - aBase === 1, 5000),
		`${(await doneCues(A)).length - aBase} cue(s)`,
	);

	console.log("window B: open the quick chat (never subscribed to the slow one)");
	const B = await openWindow("doneany-window-b");
	await B.locator(".lp-row", { hasText: /DONEANY-QUICK|Quick chat/ })
		.first()
		.click();
	check(
		"window B shows the quick chat",
		await waitFor(async () => (await messagesText(B)).includes("DONEANY-QUICK-ANSWER"), 10000),
	);
	check("window B has not sounded 'done' yet", (await doneCues(B)).length === 0, `${(await doneCues(B)).length}`);
	check("the slow chat was still running when B was ready", slowAnsweredAt === 0);

	console.log("the slow chat finishes…");
	check("the slow run answered", await waitFor(() => slowAnsweredAt > 0, (SLOW_SECS + 20) * 1000));
	// 要的是慢对话答完之后响的那一声（只数总数的话，切走时误响的那次正好凑数）。
	const after = async (page) => (await doneCues(page)).filter((t) => t >= slowAnsweredAt).length;
	const aDone = await waitFor(async () => (await after(A)) === 1, 8000);
	const bDone = await waitFor(async () => (await after(B)) === 1, 8000);
	const since = (ts) => ts.map((t) => `${t - slowAnsweredAt}ms`).join(", ");
	check("window A sounded 'done' for the background chat", aDone, since(await doneCues(A)));
	check("window B sounded 'done' too", bDone, since(await doneCues(B)));
	await sleep(2500);
	check("no extra cues in A", (await doneCues(A)).length - aBase === 2, `${(await doneCues(A)).length - aBase}`);
	check("no extra cues in B", (await doneCues(B)).length === 1, `${(await doneCues(B)).length}`);
	check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

	if (process.env.DONEANY_DEBUG) {
		for (const [name, page] of [
			["A", A],
			["B", B],
		]) {
			console.log(`  cues in ${name} (ms from the slow answer):`);
			for (const c of await allCues(page)) console.log(`    ${c.at - slowAnsweredAt}ms ${c.freqs}`);
		}
	}
} catch (e) {
	failures++;
	console.log(`  ✗ FAIL: ${e?.stack ?? e}`);
} finally {
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
console.log("\nall done-any-chat checks passed");
