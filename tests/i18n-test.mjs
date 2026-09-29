/* i18n smoke test: boots the compiled server, opens the built UI and verifies the UI is English
 * only: English even with a Chinese browser language (tests/lib/chrome.mjs pins zh_CN), no language
 * menu, and a stale saved "zh" choice is ignored.
 * Run:  npm run build && node i18n-test.mjs */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { freePort } from "./lib/port-utils.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// fileURLToPath（不是 URL.pathname）：Windows 上 ".pathname" 得到 "/E:/..."，
// spawn 的 cwd 与脚本参数都不存在 → ENOENT，测试根本起不来。
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 30000 + Math.floor(Math.random() * 10000);
const workdir = mkdtempSync(join(tmpdir(), "piweb-ui-"));
process.env.PI_WEB_PORT = String(PORT);
process.env.PI_WEB_CWD = workdir;

const server = spawn(process.execPath, [join(ROOT, "dist", "server", "index.js")], {
	cwd: ROOT,
	stdio: ["ignore", "pipe", "pipe"],
	detached: process.platform !== "win32",
});
server.on("error", (e) => console.error("[srv spawn error]", e));
server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));
process.on("exit", () => {
	try {
		// win32 没有负数 PID 的进程组，退回按端口清理。
		if (process.platform === "win32") freePort(PORT);
		else process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};

async function waitServer() {
	for (let i = 0; i < 100; i++) {
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

async function main() {
	await waitServer();
	const browser = await chromium.launch({
		executablePath: CHROME_PATH,
	});
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const consoleErrors = [];
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	page.on("pageerror", (e) => consoleErrors.push(String(e)));

	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".boot-wait", { state: "hidden", timeout: 60000 });
	console.log("app booted");
	const dismissModalIfOpen = async () => {
		try {
			const closeBtn = page.locator(".setup-modal .modal-close, .modal-close").first();
			if (await closeBtn.isVisible({ timeout: 2500 })) {
				await closeBtn.click();
				await page.waitForSelector(".modal-backdrop", { state: "hidden", timeout: 3000 });
				await sleep(200);
			}
		} catch {
			/* modal not shown */
		}
	};

	// -- English with a Chinese browser language ---------------------------------
	await page.waitForSelector(".brand-logo", { timeout: 5000 });
	await dismissModalIfOpen();
	const htmlLang = await page.evaluate(() => document.documentElement.lang);
	check(`page language is "en" (${htmlLang})`, htmlLang === "en");
	const newChat = await page.locator(".lp-new-chat-action").getAttribute("aria-label");
	check(`UI is English ("New chat")`, newChat?.includes("New chat"));
	const enTab = await page.locator('.topbar-flow [role="tab"] span').first().textContent();
	check(`view tab shows "Chat"`, enTab?.includes("Chat"));

	// model dropdown header in English
	await page.locator(".composer-tools .dropdown").first().locator("button.chip").click();
	await page.waitForSelector(".dd-header", { timeout: 3000 });
	const ddHeader = await page.locator(".dd-header").first().textContent();
	check(`model dropdown header is "Available models"`, ddHeader?.includes("Available models"));
	await page.keyboard.press("Escape");

	// -- no language menu: not on the bar, not in the "..." menu ----------------
	const tipped = await page.locator('.topbar [data-tip*="Language"], .topbar [aria-label*="Language"]').count();
	check(`no language button on the bar (${tipped})`, tipped === 0);
	const more = page.locator(".plugin-topbar-more > button").first();
	let menuRows = [];
	if (await more.isVisible().catch(() => false)) {
		if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
		await page.locator(".plugin-topbar-menu [role=menuitem]").first().waitFor({ timeout: 5000 });
		menuRows = await page.locator(".plugin-topbar-menu [role=menuitem]").allTextContents();
		await page.keyboard.press("Escape");
		if ((await more.getAttribute("aria-expanded")) === "true") await more.click();
	}
	check(`no language row in the "..." menu (${menuRows.join(" | ")})`, !menuRows.some((t) => /Language/i.test(t)));

	// -- reload keeps English ---------------------------------------------------
	await page.reload();
	await page.waitForSelector(".topbar", { timeout: 15000 });
	await sleep(500);
	await dismissModalIfOpen();
	const afterReload = await page.locator(".lp-new-chat-action").getAttribute("aria-label");
	check(`English after reload`, afterReload?.includes("New chat"));

	// -- a stale saved Chinese choice is ignored --------------------------------
	await page.evaluate(() => localStorage.setItem("pi-web-ui:lang", "zh"));
	await page.reload();
	await page.waitForSelector(".topbar", { timeout: 15000 });
	await sleep(500);
	await dismissModalIfOpen();
	const staleZh = await page.locator(".lp-new-chat-action").getAttribute("aria-label");
	check(`a saved "zh" choice still shows English`, staleZh?.includes("New chat"));

	const errs = consoleErrors.filter((e) => !e.includes("favicon") && !e.includes("ResizeObserver"));
	check(`no console errors (${errs.length})`, errs.length === 0);

	await browser.close();
	console.log(`\n${passed} checks passed`);
	process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
