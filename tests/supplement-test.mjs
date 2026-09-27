/**
 * 排队（followUp）按钮 test：智能体回复期间，输入 + 点「排队」（运行中发送位那颗
 * 对半胶囊的左半）把消息加队列；本轮回复一结束它立刻出现在聊天里，智能体随后回答。
 * 同时覆盖对半胶囊的两个状态：无输入时两半禁用（胶囊变暗），输入后解锁可点。
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp, freePort } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startMockModel, writeMockModelConfig } from "./lib/mock-model.mjs";
// fileURLToPath: URL.pathname 在 Windows 下是 /E:/... 形式，直接当 cwd 会失败
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

const HEADLESS = CHROME_PATH;
const PORT = 8899;
const URL = `http://localhost:${PORT}`;
const PROJ = REPO_ROOT;

const WS = mkdtempSync(join(tmpdir(), "pi-supp-"));
writeFileSync(join(WS, "a.txt"), "a");

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

try {
	if (!process.env.PI_TEST_PREBUILT) execSync("npm run build", { cwd: PROJ, stdio: "ignore" });
} catch {
	console.error("build failed");
	process.exit(1);
}
try {
	await freePort(PORT);
} catch {
	/* port free */
}
await sleep(500);
// A stand-in model on this machine (tests never call the real model). The first answer takes
// 5 seconds, so the test has time to queue a follow-up while it streams.
const mock = await startMockModel(async ({ sideRequest }) => {
	if (sideRequest) return "Title";
	if (mock.requests.filter((r) => r.tools?.length).length <= 1) await sleep(5000);
	return "OK";
});
mock.unref();
const agentDir = mkdtempSync(join(tmpdir(), "pi-supplement-agent-"));
writeMockModelConfig(agentDir, mock.port);
const server = spawn("node", ["dist/server/index.js"], {
	cwd: PROJ,
	// Own pi folder (with the stand-in model) and client state, never the real ones.
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: WS,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_DATA_DIR: mkdtempSync(join(tmpdir(), "pi-supplement-data-")),
	},
	stdio: "ignore",
});
for (let i = 0; i < 40 && !(await portUp(PORT)); i++) await sleep(250);
if (!(await portUp(PORT))) {
	console.error("server failed to start");
	process.exit(1);
}

const browser = await chromium.launch({ executablePath: HEADLESS });
const page = await browser.newPage();
await page.goto(URL);
await page.waitForSelector("textarea", { timeout: 15000 });
await sleep(800);

// --- 1. send the first prompt; wait for streaming (stop button) ---
await page.locator("textarea").fill("只回复两个字：好的");
await page.keyboard.press("Enter");
await page
	.waitForSelector(".btn.stop", { timeout: 60000 })
	.then(() => check("first reply streaming", true))
	.catch(() => check("first reply streaming", false, "no stop button"));

// --- 2. While streaming, the send slot is either the stop button (empty input) or the
// queue|steer pill (something to send): upstream ChatInput renderActions shows them one at a
// time, so an empty input shows only the stop button and typing swaps in the pill.
const pill = page.locator(".split-send");
const queueBtn = page.locator(".split-send .split-queue");
const steerBtn = page.locator(".split-send .split-steer");
check(
	"empty input while streaming: stop button, no pill",
	(await pill.count()) === 0 && (await page.locator(".btn.stop").count()) === 1,
	`pill=${await pill.count()}`,
);
await page.locator("textarea").fill("\u8865\u5145\u4e00\u53e5\u8bdd\uff1a\u8bf7\u518d\u8bf4\u4e00\u904d");
await sleep(400);
check("typed text while streaming: the pill appears", (await pill.count()) === 1, `count=${await pill.count()}`);
check("both halves enabled", (await queueBtn.isEnabled()) && (await steerBtn.isEnabled()));

// --- 3. 点左半（排队）→ 输入框清空 + 队列提示出现 ---
await queueBtn.click();
await sleep(600);
check("input cleared after 排队", (await page.locator("textarea").inputValue()) === "");
// Upstream 7556de8 replaced the old ".queue-hint" line with the real list: each queued message
// shows as its own bubble (.msg-queued, MessageList.tsx) with recall/remove buttons.
const queuedTexts = await page
	.locator(".msg-queued")
	.allTextContents()
	.catch(() => []);
check(
	"queued follow-up shows as a queued bubble",
	queuedTexts.some((h) => h.includes("\u8bf7\u518d\u8bf4\u4e00\u904d")),
	queuedTexts.join(" | "),
);

// --- 4. wait for the first reply to finish, then the queued message fires ---
await page
	.waitForSelector(".btn.stop", { state: "detached", timeout: 120000 })
	.then(() => check("first reply finished", true))
	.catch(() => check("first reply finished", false, "still streaming"));

// The queued message delivers immediately after; its user message should
// appear in the chat, then a second reply streams.
const supplementSeen = await page
	.waitForFunction(() => document.body.innerText.includes("补充一句话：请再说一遍"), { timeout: 180000 })
	.then(() => true)
	.catch(() => false);
check("queued message delivered right after reply", supplementSeen);
// The second assistant reply must follow the queued message (count is
// race-free even when the reply is fast).
const secondReply = await page
	.waitForFunction(() => document.querySelectorAll('.msg[data-role="assistant"]').length >= 2, { timeout: 90000 })
	.then(() => true)
	.catch(() => false);
check("agent answered the queued message", secondReply);

await browser.close();
server.kill("SIGKILL");
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
