/**
 * 切项目时左栏「运行的对话」不许闪一下项目名（#140 的回归）。
 *
 * 场景：切项目会自动切到该项目的对话；如果切过去时那个项目只有一条对话（就是
 * 这条激活的），列表里就只有一组 —— 它顶上原来会闪出一行项目名再消失。原因是
 * `conversations` 推送（activeId 已是新项目的对话）先到、带新 `cwd` 的快照后到，
 * 只按 `cwd` 分组的那一帧把当前项目当成了「别的项目」。
 *
 * 这里用 MutationObserver 记录整个左栏的每一帧 DOM，逐帧断言「当前项目那组没有
 * 组标题」。零 token（本地 OpenAI 兼容 mock）。
 *
 * Our fork: flat-recent-chats (PATCHES.md) has no project groups, so the checks below test that
 * patch's promise instead: a project switch never shows a group title and never changes the rows.
 *
 * Run: npm run build && node tests/conv-group-flash-test.mjs
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp, freePort } from "./lib/port-utils.mjs";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = realpathSync(new URL("../", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-flash-"));
const A = join(base, "proj-a");
const B = join(base, "proj-b");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const dir of [A, B, dataDir, agentDir]) mkdirSync(dir, { recursive: true });
writeFileSync(join(A, "a.txt"), "a");
writeFileSync(join(B, "b.txt"), "b");

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
};

// --- 即时回包的 mock 模型（每轮立刻结束，列表状态稳定便于观察）---
const mock = createServer(async (req, res) => {
	for await (const _chunk of req) {
		/* drain */
	}
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const chunk = (content) =>
		res.write(
			`data: ${JSON.stringify({
				id: "flash-mock",
				object: "chat.completion.chunk",
				created: Date.now(),
				model: "flash-mock",
				choices: [{ index: 0, delta: { content }, finish_reason: null }],
			})}\n\n`,
		);
	chunk("ok");
	res.write(
		`data: ${JSON.stringify({
			id: "flash-mock",
			object: "chat.completion.chunk",
			created: Date.now(),
			model: "flash-mock",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		})}\n\n`,
	);
	res.write("data: [DONE]\n\n");
	res.end();
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const MOCK_PORT = mock.address().port;
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ m: { type: "api_key", key: "flash" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			m: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "flash",
				models: [{ id: "flash-1", name: "Flash" }],
			},
		},
	}),
);

const PORT = 8952;
try {
	await freePort(PORT);
} catch {
	/* port free */
}
const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: ROOT,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: A,
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: "ignore",
});
for (let i = 0; i < 60 && !(await portUp(PORT)); i++) await sleep(250);

const browser = await chromium.launch({ executablePath: CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

try {
	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector("textarea", { timeout: 20000 });
	await sleep(800);
	const skip = page.locator("button:has-text('跳过'), button:has-text('Skip')").first();
	if (await skip.isVisible().catch(() => false)) await skip.click();

	/** 发一条消息并等它跑完（mock 立即回包）。 */
	const prompt = async (text) => {
		await page.locator("textarea").first().fill(text);
		await page.keyboard.press("Enter");
		await sleep(2500);
	};
	/** 通过底栏 cwd 输入切项目。 */
	const switchTo = async (path) => {
		await page.locator(".status-cwd").click();
		await page.locator(".status-cwd-input").fill(path);
		await page.keyboard.press("Enter");
		await sleep(3000);
	};
	// Our fork's flat-recent-chats patch (PATCHES.md) replaced upstream's per-project groups with
	// ONE flat list of every chat, newest-created first. So upstream's checks ("only the current
	// project's chat is listed", "no project name flashes") turn into that patch's stronger promise,
	// checked frame by frame: a project switch never shows a group title, never drops or adds a row,
	// and never reorders the rows.
	/** The left panel right now: group titles, the rows (as their folder, in order), the active row. */
	const panelState = () =>
		page.evaluate(() => {
			const root = document.querySelector(".panel-left");
			// A row's tooltip is "<title> \u2014 <folder>"; the folder tells A's chat from B's.
			const folder = (el) => {
				const tip = el?.getAttribute("title") ?? "";
				return tip.slice(tip.lastIndexOf(" \u2014 ") + 3);
			};
			return {
				titles: [...root.querySelectorAll(".panel-conv-group-title")].map((el) => el.textContent),
				order: [...root.querySelectorAll(".panel-convs .session-item")].map(folder).join(" | "),
				active: folder(root.querySelector(".panel-convs .session-item.active")),
			};
		});
	/** Record the same state for every DOM change of the left panel. */
	const recordFrames = () =>
		page.evaluate(() => {
			window.__frames = [];
			const root = document.querySelector(".panel-left");
			const folder = (el) => {
				const tip = el?.getAttribute("title") ?? "";
				return tip.slice(tip.lastIndexOf(" \u2014 ") + 3);
			};
			const snap = () =>
				window.__frames.push({
					titles: [...root.querySelectorAll(".panel-conv-group-title")].map((el) => el.textContent),
					order: [...root.querySelectorAll(".panel-convs .session-item")].map(folder).join(" | "),
				});
			snap();
			new MutationObserver(snap).observe(root, { childList: true, subtree: true, characterData: true });
		});
	const shortOrder = (order) => order.replaceAll(base, "");

	// 1. A chat in A -> it is listed, with no group title (#140)
	await prompt("A: first message");
	await page.waitForSelector(".panel-convs .session-item", { timeout: 15000 });
	const aState = await panelState();
	check("A's chat is listed", aState.order.endsWith("proj-a"), shortOrder(aState.order));
	check("no group title", aState.titles.length === 0, JSON.stringify(aState.titles));

	// 2. Switch to B and chat there: both chats are in the one list, the newer (B) on top
	await switchTo(B);
	await prompt("B: first message");
	await page.waitForFunction(() => document.querySelectorAll(".panel-convs .session-item").length === 2, null, {
		timeout: 15000,
	});
	const before = await panelState();
	check(
		"one flat list: B's chat (newer) above A's",
		/proj-b \| .*proj-a$/.test(before.order),
		shortOrder(before.order),
	);

	// 3. B -> A: frame by frame, no group title and the same rows in the same order
	await recordFrames();
	await switchTo(A);
	const backFrames = await page.evaluate(() => window.__frames);
	check(
		"switching back to A never renders a group title",
		backFrames.every((f) => f.titles.length === 0),
		JSON.stringify(backFrames.filter((f) => f.titles.length > 0).slice(0, 3)),
	);
	check(
		"switching back to A never drops, adds or reorders a row",
		backFrames.every((f) => f.order === before.order),
		JSON.stringify(
			backFrames
				.filter((f) => f.order !== before.order)
				.map((f) => shortOrder(f.order))
				.slice(0, 3),
		),
	);
	const atA = await panelState();
	check("A's chat is the active row", atA.active.endsWith("proj-a"), shortOrder(atA.active));

	// 4. A -> B: the same the other way
	await recordFrames();
	await switchTo(B);
	const forthFrames = await page.evaluate(() => window.__frames);
	check(
		"switching to B never renders a group title",
		forthFrames.every((f) => f.titles.length === 0),
		JSON.stringify(forthFrames.filter((f) => f.titles.length > 0).slice(0, 3)),
	);
	check(
		"switching to B never drops, adds or reorders a row",
		forthFrames.every((f) => f.order === before.order),
		JSON.stringify(
			forthFrames
				.filter((f) => f.order !== before.order)
				.map((f) => shortOrder(f.order))
				.slice(0, 3),
		),
	);

	// 5. Settled: B's chat is the active row, the list is unchanged, no group title left
	const finalState = await panelState();
	check("B's chat is the active row", finalState.active.endsWith("proj-b"), shortOrder(finalState.active));
	check("the list is unchanged", finalState.order === before.order, shortOrder(finalState.order));
	check("no group title left", finalState.titles.length === 0, JSON.stringify(finalState.titles));
} catch (error) {
	console.error(`✗ ${error.message}`);
	process.exitCode = 1;
} finally {
	await browser.close();
	server.kill();
	mock.close();
}

console.log(failures === 0 && !process.exitCode ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? (process.exitCode ?? 0) : 1;
