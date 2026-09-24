/* exchange-fold E2E（零 token）：mock 的 OpenAI 兼容 provider 演一轮三回合的 run
 * （思考 + 一句话 + bash → bash → 流式回答），在真浏览器里验证：
 *  - 运行中整轮只是一行直播行：转圈、计数往上走、当前步骤写着在跑的工具和命令，
 *    不出工具卡片、不出思考块；中间那句话一旦开始调工具就收进折叠里；
 *  - 回答在直播行下面流式出现；
 *  - 跑完：「3 turns · 1 thinking · 2 tool calls」，只剩提问和回答；
 *  - 点这一行展开全部步骤，再点收起；
 *  - 刷新后照样折着、计数不变。
 * 用法: npm run build && node tests/exchange-fold-test.mjs
 * 截图: /tmp/exchange-fold-{live,done,open}.png */
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
const base = mkdtempSync(join(tmpdir(), "piweb-xfold-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });

const MODEL_ID = "xfold-mock";
const CLIENT_ID = "xfold-test-client";
const QUESTION = "XFOLD-QUESTION check the files";
const THOUGHT = "XFOLD-THOUGHT let me look around first.";
const MIDDLE = "XFOLD-MIDDLE I'll check the files first.";
const ANSWER_PARTS = ["XFOLD-ANSWER ", "all ", "good, ", "both ", "checks ", "passed."];
const ANSWER = ANSWER_PARTS.join("");
const CMD1 = "sleep 1.5; echo one";
const CMD2 = "sleep 1.5; echo two";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`  ${ok ? "✓" : "✗ FAIL:"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

// ---- mock provider ---------------------------------------------------------
const chunk = (model, delta, finish = null) => ({
	id: "xfold-mock",
	object: "chat.completion.chunk",
	created: Math.floor(Date.now() / 1000),
	model,
	choices: [{ index: 0, delta, finish_reason: finish }],
});
const bashCall = (id, command) => ({
	tool_calls: [{ index: 0, id, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }],
});
async function sse(res, chunks, gapMs) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const c of chunks) {
		res.write(`data: ${JSON.stringify(c)}\n\n`);
		if (gapMs) await sleep(gapMs);
	}
	res.write("data: [DONE]\n\n");
	res.end();
}
let agentRequests = 0;
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
	// 旁路请求（起标题之类）不带工具：直接回一句话，不算进 run。
	if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
		await sse(res, [chunk(m, { content: "Mock title" }), chunk(m, {}, "stop")], 0);
		return;
	}
	agentRequests++;
	const results = (payload.messages ?? []).filter((x) => x.role === "tool").length;
	if (results === 0) {
		await sse(
			res,
			[
				chunk(m, { reasoning_content: THOUGHT.slice(0, 14) }),
				chunk(m, { reasoning_content: THOUGHT.slice(14) }),
				chunk(m, { content: MIDDLE }),
				chunk(m, bashCall("call_xfold_1", CMD1)),
				chunk(m, {}, "tool_calls"),
			],
			300,
		);
	} else if (results === 1) {
		await sse(res, [chunk(m, bashCall("call_xfold_2", CMD2)), chunk(m, {}, "tool_calls")], 300);
	} else {
		await sse(res, [...ANSWER_PARTS.map((p) => chunk(m, { content: p })), chunk(m, {}, "stop")], 350);
	}
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

/** 最后一行折叠行 + 消息区的状态。 */
function probe(page) {
	return page.evaluate(
		({ MIDDLE, QUESTION }) => {
			const root = document.querySelector(".messages");
			const rows = [...(root?.querySelectorAll(".xfold") ?? [])];
			const row = rows.at(-1);
			const txt = root?.innerText ?? "";
			return {
				rows: rows.length,
				live: !!row?.querySelector(".xfold-spin"),
				open: row?.querySelector(".xfold-head")?.getAttribute("aria-expanded") === "true",
				cls: row?.className ?? "",
				counts: row?.querySelector(".xfold-counts")?.textContent ?? "",
				stepTool: row?.querySelector(".xfold-step-tool")?.textContent ?? "",
				stepHint: row?.querySelector(".xfold-step-hint")?.textContent ?? "",
				step: row?.querySelector(".xfold-step")?.textContent ?? "",
				toolcards: root?.querySelectorAll(".toolcall").length ?? 0,
				thinking: root?.querySelectorAll(".thinking").length ?? 0,
				question: txt.includes(QUESTION),
				middle: txt.includes(MIDDLE),
				answer: txt.includes("XFOLD-ANSWER"),
				fullAnswer: txt.includes("both checks passed."),
			};
		},
		{ MIDDLE, QUESTION },
	);
}

let browser;
try {
	await waitServer();
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
	const pageErrors = [];
	const consoleErrors = [];
	page.on("pageerror", (e) => pageErrors.push(String(e)));
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	const frames = [];
	let frameT0 = 0;
	if (process.env.XFOLD_DEBUG) {
		page.on("websocket", (ws) =>
			ws.on("framereceived", (f) => {
				if (!frameT0) return;
				let m;
				try {
					m = JSON.parse(f.payload);
				} catch {
					return;
				}
				const s = m.state ?? m.patch ?? m;
				const bits = [m.type];
				if ("isStreaming" in s) bits.push(`isStreaming=${s.isStreaming}`);
				if (Array.isArray(s.messages)) bits.push(`messages=[${s.messages.map((x) => x.role).join(",")}]`);
				if (Array.isArray(m.appended)) bits.push(`appended=[${m.appended.map((x) => x.role).join(",")}]`);
				if ("streamingMessage" in s)
					bits.push(
						`streaming=${s.streamingMessage ? s.streamingMessage.content?.map((b) => b.type).join("+") || "empty" : "null"}`,
					);
				if (m.type !== "snapshot" && m.type !== "snapshot_delta")
					bits.push(`keys=${Object.keys(m).slice(0, 8).join(",")}`);
				frames.push(`+${Date.now() - frameT0}ms ${bits.join(" ")}`);
			}),
		);
	}
	await page.addInitScript((id) => {
		localStorage.setItem("pi-web-client-id", id);
		localStorage.setItem("pi-web-ui:lang", "en");
	}, CLIENT_ID);
	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".topbar", { timeout: 60000 });
	const ta = page.locator(".inputbox textarea");
	await ta.waitFor({ timeout: 20000 });
	await ta.fill(QUESTION);
	frameT0 = Date.now();
	await ta.press("Enter");
	console.log("prompt sent; watching the live run…");

	// ---- live phase ----------------------------------------------------------
	const counts = [];
	const steps = new Set();
	let liveSeen = false;
	let cardsWhileFolded = 0;
	let thinkingWhileFolded = 0;
	let middleAfterTool = false;
	let answerWhileLive = false;
	let liveShot = false;
	let last = null;
	const timeline = [];
	let exposedBeforeRow = "";
	const t0 = Date.now();
	while (Date.now() - t0 < 60000) {
		const o = await probe(page);
		last = o;
		const sig = `rows=${o.rows} live=${o.live} counts="${o.counts}" step="${o.step}" cards=${o.toolcards} think=${o.thinking} middle=${o.middle} answer=${o.answer}`;
		if (timeline.at(-1)?.sig !== sig) timeline.push({ t: Date.now() - t0, sig });
		if (!o.open && (o.thinking > 0 || o.toolcards > 0) && !exposedBeforeRow) exposedBeforeRow = sig;
		if (o.rows > 0 && counts.at(-1) !== o.counts.replace(/ · \d+s$| · \d+m \d+s$/, "")) {
			counts.push(o.counts.replace(/ · \d+s$| · \d+m \d+s$/, ""));
		}
		if (o.live) {
			liveSeen = true;
			if (o.step) steps.add(o.stepTool ? `${o.stepTool}: ${o.stepHint}` : o.step);
			if (!o.open) {
				cardsWhileFolded = Math.max(cardsWhileFolded, o.toolcards);
				thinkingWhileFolded = Math.max(thinkingWhileFolded, o.thinking);
			}
			if (/tool call/.test(o.counts) && o.middle) middleAfterTool = true;
			if (o.answer) answerWhileLive = true;
			if (!liveShot && o.stepTool === "bash") {
				liveShot = true;
				await page.screenshot({ path: "/tmp/exchange-fold-live.png" });
			}
		}
		if (o.rows > 0 && !o.live && o.fullAnswer && /xfold-done/.test(o.cls)) break;
		await sleep(80);
	}
	if (process.env.XFOLD_DEBUG) {
		for (const e of timeline) console.log(`    +${e.t}ms ${e.sig}`);
		console.log("  frames:");
		for (const f of frames.slice(0, 60)) console.log(`    ${f}`);
		console.log("  server snapdbg:");
		let shown = 0;
		let early = 0;
		for (const line of serverLog.split("\n")) {
			const m = line.match(/\[snapdbg\] (\d+) (.*)$/);
			if (!m) continue;
			if (Number(m[1]) < frameT0 - 200 ? early++ >= 30 : shown++ >= 90) continue;
			console.log(`    +${Number(m[1]) - frameT0}ms ${m[2]}`);
		}
	}
	console.log(`  counts seen: ${counts.join("  →  ")}`);
	check("a thinking block or tool card never showed outside an open row", !exposedBeforeRow, exposedBeforeRow);
	check(
		"the live row showed while the model was still only thinking",
		steps.has("Thinking…") || counts[0] === "1 turn · 1 thinking",
		counts[0],
	);
	console.log(`  steps seen: ${[...steps].join("  |  ")}`);
	check("the mock played all three turns", agentRequests === 3, `${agentRequests} request(s)`);
	check("a live row showed while the agent worked (spinner)", liveSeen);
	check(
		"the live row named the running tool and its command",
		steps.has(`bash: ${CMD1}`) && steps.has(`bash: ${CMD2}`),
		[...steps].join(" | "),
	);
	check(
		"counts ticked up to 2 tool calls",
		counts.some((c) => /1 tool call\b/.test(c)) && counts.some((c) => /2 tool calls/.test(c)),
	);
	check("no tool cards while the run was folded", cardsWhileFolded === 0, `max ${cardsWhileFolded}`);
	check("no thinking blocks while the run was folded", thinkingWhileFolded === 0, `max ${thinkingWhileFolded}`);
	check("the in-between sentence folded away once tools started", !middleAfterTool);
	check("the answer streamed in below the live row", answerWhileLive);

	// ---- finished --------------------------------------------------------------
	const done = last;
	check("exactly one row for the exchange", done?.rows === 1, `${done?.rows} row(s)`);
	check("row is finished (no spinner, done status)", !!done && !done.live && /xfold-done/.test(done.cls), done?.cls);
	check(
		"row reads 3 turns · 1 thinking · 2 tool calls · <time>",
		/^3 turns · 1 thinking · 2 tool calls · \d+s$/.test(done?.counts ?? ""),
		done?.counts,
	);
	check("question and full answer visible", !!done?.question && !!done?.fullAnswer);
	check("in-between sentence hidden", !done?.middle);
	check("no tool cards or thinking visible when folded", done?.toolcards === 0 && done?.thinking === 0);
	await page.screenshot({ path: "/tmp/exchange-fold-done.png" });

	// ---- open / close ----------------------------------------------------------
	await page.locator(".xfold-head").last().click();
	await page.waitForSelector('.xfold-head[aria-expanded="true"]', { timeout: 5000 });
	await sleep(300);
	const opened = await probe(page);
	check("clicking the row shows both tool cards", opened.toolcards === 2, `${opened.toolcards}`);
	check("…the thinking block", opened.thinking >= 1, `${opened.thinking}`);
	check("…and the in-between sentence", opened.middle);
	check("…while the answer stays", opened.fullAnswer);
	await page.screenshot({ path: "/tmp/exchange-fold-open.png" });
	await page.locator(".xfold-head").last().click();
	await page.waitForSelector('.xfold-head[aria-expanded="false"]', { timeout: 5000 });
	await sleep(300);
	const closed = await probe(page);
	check("clicking again folds the steps away", closed.toolcards === 0 && !closed.middle && closed.fullAnswer);

	// ---- reload ----------------------------------------------------------------
	await page.reload();
	await page.waitForSelector(".xfold", { timeout: 30000 });
	await sleep(500);
	const reloaded = await probe(page);
	check("after a reload the exchange is still one folded row", reloaded.rows === 1 && !reloaded.open);
	check("…with the same counts", reloaded.counts === done?.counts, `${reloaded.counts} vs ${done?.counts}`);
	check(
		"…and only the question and the answer showing",
		reloaded.question && reloaded.fullAnswer && !reloaded.middle && reloaded.toolcards === 0,
	);

	check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 400));
	if (consoleErrors.length)
		console.log(`  (console errors, informational: ${consoleErrors.slice(0, 5).join(" | ").slice(0, 400)})`);
} catch (e) {
	check(`test crashed: ${e?.stack ?? e}`, false);
	console.log(serverLog.slice(-2000));
} finally {
	await browser?.close();
	mock.close();
}
console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
