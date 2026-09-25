/**
 * exchange-digest 浏览器冒烟（零 token）。
 *
 * 分页之后快照只带最新的 N 条消息；agent 一轮动辄几百步，这一截常常全落在最后一轮里，
 * 折叠之后页面上只剩一行。exchange-digest 让快照再带上窗口之前最近几轮的摘要
 * （提问 + 回答 + 折叠行计数）。这里用一份预先写好的会话把整条路走一遍：
 *
 *  1. 打开会话：窗口（PI_WEB_MESSAGE_WINDOW=20）从最后一轮中间开始，页面照样看得到
 *     最近 PI_WEB_EXCHANGE_DIGESTS=2 轮的提问和回答，最后一行的计数是**整轮**的
 *     （窗口之前那一截 + 窗口里那一截），步骤一个都没画；
 *  2. 「显示更早的对话」往前取两轮摘要；
 *  3. 点导轨上还没显示的第 1 个提问：一路取到它，滚过去高亮；
 *  4. 点开最后一轮（开头在窗口之前）：把这一轮的消息取回来，30 步全在，提问不重复；
 *  5. 点开摘要里的一轮：同样取回来并展开，其它轮照旧折着。
 *
 * 跑编译产物（dist/server/index.js，需先构建）。DIGEST_DEBUG=1 打印每一步的页面状态。
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const REPO = fileURLToPath(new URL("..", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "piweb-digest-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
const sessionsDir = join(agentDir, "sessions");
for (const d of [workdir, dataDir, sessionsDir]) mkdirSync(d, { recursive: true });
// 要有一个可用模型，否则页面弹「pi agent config not detected」挡住点击。这里不调模型，地址随便填。
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:9",
				apiKey: "mock-key",
				models: [{ id: "mock-model", name: "Mock", input: ["text"], contextWindow: 200000, maxTokens: 4096 }],
			},
		},
	}),
);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "mock", defaultModel: "mock-model" }));
const CLIENT_ID = "digest-test-client";
const WINDOW = 20;
/** 每一轮的步数：前六轮各 3 步，最后一轮 30 步。 */
const STEPS = [3, 3, 3, 3, 3, 3, 30];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
}

/** 七轮：提问 → 每步一次工具调用（第一步带思考）+ 工具结果 → 文字回答。 */
function seedSession() {
	const id = "01a0d000-0000-7000-8000-00000000d1d1";
	const lines = [
		JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: workdir }),
	];
	let parentId = null;
	let n = 0;
	let ts = Date.now() - 3_600_000;
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const push = (message) => {
		const entryId = `e${String(n++).padStart(4, "0")}`;
		lines.push(
			JSON.stringify({ type: "message", id: entryId, parentId, timestamp: new Date(ts).toISOString(), message }),
		);
		parentId = entryId;
		ts += 1000;
	};
	const asst = (content, stopReason) => ({
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-8",
		usage,
		stopReason,
		timestamp: ts,
	});
	STEPS.forEach((steps, k) => {
		const q = k + 1;
		push({ role: "user", content: [{ type: "text", text: `question ${q}` }], timestamp: ts });
		for (let j = 0; j < steps; j++) {
			const callId = `call_${q}_${j}`;
			const content = [{ type: "toolCall", id: callId, name: "bash", arguments: { command: `echo step ${q}.${j}` } }];
			if (j === 0) content.unshift({ type: "thinking", thinking: `plan for ${q}` });
			push(asst(content, "toolUse"));
			push({
				role: "toolResult",
				toolCallId: callId,
				toolName: "bash",
				content: [{ type: "text", text: `step ${q}.${j} done` }],
				isError: false,
				timestamp: ts,
			});
		}
		push(asst([{ type: "text", text: `answer ${q}` }], "stop"));
	});
	const file = join(sessionsDir, `2026-09-24T00-00-00-000Z_${id}.jsonl`);
	writeFileSync(file, lines.join("\n") + "\n");
	return { file, total: n };
}

const seeded = seedSession();

const server = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
	cwd: REPO,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: workdir,
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CODING_AGENT_SESSION_DIR: sessionsDir,
		PI_WEB_TOKEN: "",
		PI_WEB_MESSAGE_WINDOW: String(WINDOW),
		PI_WEB_EXCHANGE_DIGESTS: "2",
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

/** 消息区的状态。 */
function probe(page) {
	return page.evaluate(() => {
		const root = document.querySelector(".messages");
		const rows = [...(root?.querySelectorAll(".xfold") ?? [])];
		const users = [...(root?.querySelectorAll(".msg-user") ?? [])].map((n) => n.textContent ?? "");
		const txt = root?.innerText ?? "";
		const questions = [];
		const answers = [];
		for (let q = 1; q <= 7; q++) {
			if (users.some((u) => u.includes(`question ${q}`))) questions.push(q);
			if (txt.includes(`answer ${q}`)) answers.push(q);
		}
		return {
			rows: rows.length,
			open: rows.map((r) => r.querySelector(".xfold-head")?.getAttribute("aria-expanded") === "true"),
			lastCounts: rows.at(-1)?.querySelector(".xfold-counts")?.textContent ?? "",
			toolcards: root?.querySelectorAll(".toolcall").length ?? 0,
			/** 每条画出来的消息一个节点（工具结果并在调用卡里，不单独成节点）。 */
			nodes: new Set([...(root?.querySelectorAll("[data-msg-id]") ?? [])].map((n) => n.getAttribute("data-msg-id")))
				.size,
			users: users.length,
			questions,
			answers,
			button: root?.querySelector(".load-older button")?.textContent ?? "",
			flash: root?.querySelector(".msg-flash")?.textContent ?? "",
			modal: (document.querySelector(".modal-backdrop")?.textContent ?? "").slice(0, 160),
		};
	});
}

async function until(page, what, pred, timeout = 15000) {
	const t0 = Date.now();
	let last;
	while (Date.now() - t0 < timeout) {
		last = await probe(page);
		if (pred(last)) return last;
		await sleep(100);
	}
	console.log(`  (timed out waiting for ${what}: ${JSON.stringify(last)})`);
	return last;
}

const debug = (label, s) => process.env.DIGEST_DEBUG && console.log(`  [${label}] ${JSON.stringify(s)}`);
let sentRef = [];
const debugSent = (label) => {
	if (!process.env.DIGEST_DEBUG) return;
	for (const p of sentRef.splice(0)) console.log(`  [${label} → server] ${p}`);
};

let browser;
try {
	await waitServer();
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
	const pageErrors = [];
	page.on("pageerror", (e) => pageErrors.push(String(e)));
	page.on("websocket", (ws) =>
		ws.on("framesent", (f) => {
			if (/"type":"load_[a-z_]+"/.test(f.payload)) sentRef.push(String(f.payload).slice(0, 200));
		}),
	);
	// 抓住页面自己的 WebSocket：零 token 打开种好的会话（switch_session 不调模型）。
	await page.addInitScript((id) => {
		localStorage.setItem("pi-web-client-id", id);
		localStorage.setItem("pi-web-ui:lang", "en");
		const Orig = window.WebSocket;
		window.WebSocket = class extends Orig {
			constructor(...args) {
				super(...args);
				window.__piWs = this;
			}
		};
	}, CLIENT_ID);
	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".topbar", { timeout: 60000 });
	await page.waitForFunction(() => window.__piWs?.readyState === 1, null, { timeout: 20000 });
	await sleep(500);
	await page.evaluate((path) => window.__piWs.send(JSON.stringify({ type: "switch_session", path })), seeded.file);

	// ---- 1) 打开：窗口从最后一轮中间开始 --------------------------------------
	let s = await until(page, "the seeded chat", (x) => x.answers.includes(7) && x.questions.includes(6));
	debug("open", s);
	check("the last two exchanges show their questions", s.questions.join(",") === "6,7", s.questions.join(","));
	check("…and their answers", s.answers.join(",") === "6,7", s.answers.join(","));
	check("one row per exchange (the digest's + the one straddling the window)", s.rows === 2, `${s.rows} rows`);
	check(
		"the last row counts the WHOLE exchange (before + inside the window)",
		/31 turns/.test(s.lastCounts) && /30 tool calls/.test(s.lastCounts) && /1 thinking/.test(s.lastCounts),
		s.lastCounts,
	);
	check(
		"no step is drawn while folded",
		s.toolcards === 0 && s.nodes === 4,
		`${s.toolcards} tool cards, ${s.nodes} nodes`,
	);
	check("the button offers the 5 earlier questions", /5 more questions/.test(s.button), s.button);

	// ---- 2) 显示更早的对话 ------------------------------------------------------
	await page.locator(".load-older button").click();
	s = await until(page, "two more exchanges", (x) => x.questions.includes(4));
	debug("older", s);
	debugSent("older");
	check("two more exchanges came in (questions 4–7)", s.questions.join(",") === "4,5,6,7", s.questions.join(","));
	check(
		"…with their answers and rows",
		s.answers.join(",") === "4,5,6,7" && s.rows === 4,
		`${s.answers} / ${s.rows} rows`,
	);
	check("the button now offers the 3 left", /3 more questions/.test(s.button), s.button);

	// ---- 3) 导轨跳到还没显示的第一个提问 --------------------------------------
	await page.locator('.qn-bar[aria-label^="1."]').evaluate((el) => el.click());
	s = await until(page, "the jump to question 1", (x) => x.questions.includes(1) && /question 1/.test(x.flash));
	debug("jump", s);
	debugSent("jump");
	check(
		"the rail fetched everything up to question 1",
		s.questions.join(",") === "1,2,3,4,5,6,7",
		s.questions.join(","),
	);
	check("…and jumped to it (highlighted)", /question 1/.test(s.flash), s.flash.slice(0, 40));
	check("no button once everything is shown", s.button === "", s.button);
	check("still one row per exchange, all folded", s.rows === 7 && s.open.every((o) => !o), `${s.rows} rows`);

	// ---- 4) 点开最后一轮（开头在窗口之前）------------------------------------
	// 惰性窗口化把视口外的消息换成占位（.msg-lazy-ph），数 .toolcall 就数不全；搜索栏开着时全量渲染，
	// 且不会把折叠行展开（同 lazy-window-test）。
	await page.keyboard.press("Control+f");
	await page.waitForSelector(".search-bar", { timeout: 5000 });
	await page.locator(".xfold-head").last().click();
	// 较老的消息画成一行折叠行（oldRow），不是 .toolcall 卡片——数消息节点：
	// 7 个提问 + 7 个回答 + 最后一轮 30 步 = 44。
	s = await until(page, "the last exchange's 30 steps", (x) => x.nodes === 44);
	debug("open-last", s);
	debugSent("open-last");
	check(
		"opening the straddling exchange loads all 30 of its steps",
		s.nodes === 44,
		`${s.nodes} message nodes (want 44)`,
	);
	check("…and it stays open", s.open.at(-1) === true, JSON.stringify(s.open));
	check("its question is not duplicated", s.users === 7, `${s.users} user messages`);
	check("every exchange still shows", s.questions.length === 7 && s.answers.length === 7 && s.rows === 7);

	// ---- 5) 点开摘要里的一轮 ----------------------------------------------------
	await page.locator(".xfold-head").nth(3).click();
	s = await until(page, "exchange 4's 3 steps", (x) => x.nodes === 47);
	debug("open-4", s);
	debugSent("open-4");
	check("opening a digest's row loads that exchange's steps", s.nodes === 47, `${s.nodes} message nodes (want 47)`);
	check(
		"…only that one opens (others stay folded)",
		s.open.map((o) => (o ? 1 : 0)).join("") === "0001001",
		s.open.map((o) => (o ? 1 : 0)).join(""),
	);
	check("no question or answer lost or doubled", s.users === 7 && s.answers.length === 7 && s.rows === 7);

	await page.keyboard.press("Escape");
	check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (e) {
	failures++;
	console.log(`✗ crashed: ${e?.stack ?? e}`);
	console.log(serverLog.split("\n").slice(-30).join("\n"));
} finally {
	await browser?.close();
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
}
console.log(failures === 0 ? "\nexchange-digest: all checks passed" : `\nexchange-digest: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
