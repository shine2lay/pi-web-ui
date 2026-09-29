/* Self-update E2E: the corner chip shows the running version, opening the
 * dropdown triggers a registry check and displays current/latest + status.
 * (The update itself runs in a visible terminal tab — not exercised here;
 * it would really run npm i -g.)
 * Run: npm run build && node update-test.mjs */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { openTopbarPanel, topbarItemText } from "./lib/topbar.mjs";
import { freePort } from "./lib/port-utils.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const base = mkdtempSync(join(tmpdir(), "piweb-update-"));
mkdirSync(join(base, "work"), { recursive: true });
process.env.PI_WEB_PORT = String(PORT);
process.env.PI_WEB_CWD = join(base, "work");
process.env.PI_WEB_DATA_DIR = join(base, "data");

// fileURLToPath（不是 URL.pathname）：Windows 上 ".pathname" 得到 "/E:/..."，
// spawn 的脚本参数不存在 → ENOENT，测试根本起不来。
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const server = spawn(process.execPath, [join(repoRoot, "dist", "server", "index.js")], {
	stdio: ["ignore", "pipe", "pipe"],
	detached: process.platform !== "win32",
});
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
	let pkgVersion = "0.0.0";
	try {
		pkgVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
	} catch {
		// keep the fallback — the chip assertion below will simply fail loudly
	}
	console.log(`package.json version: ${pkgVersion}`);

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
	await page.waitForSelector(".topbar", { timeout: 60000 });

	// -- corner chip shows the running version -------------------------------
	// The version chip is in the top bar's "..." menu by default (upstream ui-slots host:update
	// hidden: true); there it is an entry row "<update word> . v<version>" that opens the same
	// dropdown in a drawer. tests/lib/topbar.mjs reads either place.
	const versionRe = new RegExp(`v${pkgVersion.replace(/\./g, "\\.")}`);
	const barChip = page.locator(".topbar-flow .dropdown", { hasText: "v" + pkgVersion });
	let versionText = "";
	for (let i = 0; i < 20 && !versionRe.test(versionText); i++) {
		versionText = (await topbarItemText(page, { bar: barChip, entry: /v(\d|\u2026)/ }).catch(() => "")) ?? "";
		if (!versionRe.test(versionText)) await sleep(1000);
	}
	check("corner update chip shows v" + pkgVersion, versionRe.test(versionText));

	// -- open dropdown → registry check completes ----------------------------
	await openTopbarPanel(page, { bar: barChip.locator("button.chip"), entry: versionRe });
	await page.waitForSelector(".dd-update", { timeout: 5000 });
	await page.waitForFunction(
		() => {
			const rows = [...document.querySelectorAll(".dd-row")];
			const latest = rows.find((r) => r.textContent.includes("Latest version"))?.textContent;
			return latest && !latest.includes("Checking");
		},
		{ timeout: 20000 },
	);
	const rows = await page.locator(".dd-row").allTextContents();
	const currentRow = rows.find((r) => r.includes("Current version")) ?? "";
	const latestRow = rows.find((r) => r.includes("Latest version")) ?? "";
	check(`current version row shows v${pkgVersion}`, currentRow.includes(`v${pkgVersion}`));
	check(
		"latest version row resolved (version or error)",
		/v\d+\.\d+\.\d+/.test(latestRow) || latestRow.includes("failed"),
	);
	const note = await page
		.locator(".dd-note")
		.first()
		.textContent()
		.catch(() => "");
	check(
		"status note shown (up-to-date / new version / error)",
		note.includes("up to date") || note.includes("failed") || note.includes("version"),
	);
	check("no page errors", consoleErrors.length === 0);

	await browser.close();
	console.log(`\n${passed} checks passed`);
	process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
	console.error("❌", e.message);
	process.exit(1);
});
