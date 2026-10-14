/** lazy-files-visibility: sealed synthetic browser, no model route or real chat. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";

if (!CHROME_PATH) throw new Error("Files visibility browser qualification requires Chrome; not a pass/skip.");
const REPO = fileURLToPath(new URL("../", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-files-visibility-"));
const work = join(base, "work");
const sessions = join(base, "agent", "sessions");
for (const path of [work, sessions, join(work, "folder-fixed"), join(base, "data")])
	mkdirSync(path, { recursive: true });
writeFileSync(join(work, "folder-fixed", "keep.txt"), "synthetic file\n");
// A synthetic saved chat supplies history only; it is never prompted.
writeFileSync(
	join(sessions, "2026-10-14T00-00-00-000Z_files-fixture.jsonl"),
	[
		{ type: "session", version: 3, id: "files-fixture", timestamp: "2026-10-14T00:00:00.000Z", cwd: work },
		{
			type: "message",
			id: "fixture",
			parentId: null,
			timestamp: "2026-10-14T00:00:01.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "Synthetic Files visibility fixture." }],
				timestamp: 1791936001000,
			},
		},
	]
		.map((row) => JSON.stringify(row))
		.join("\n") + "\n",
);
const reserve = createServer();
await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
let browser;
const child = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: REPO,
	stdio: "ignore",
	env: {
		...process.env,
		PI_WEB_PORT: String(port),
		PI_WEB_CWD: work,
		PI_WEB_DATA_DIR: join(base, "data"),
		PI_CODING_AGENT_DIR: join(base, "agent"),
		PI_CODING_AGENT_SESSION_DIR: sessions,
	},
});
const checks = [];
const metrics = {};
const check = (name, actual, expected) => {
	assert.deepEqual(actual, expected, name);
	checks.push({ name, actual, expected });
	console.log(`PASS ${name}: ${JSON.stringify(actual)}`);
};
async function windowFor(viewport, tab) {
	const context = await browser.newContext({ viewport });
	await context.addInitScript((selected) => localStorage.setItem("pi-web-ui:rightpanel:tab", selected), tab);
	const page = await context.newPage();
	const lists = [];
	page.on("websocket", (ws) =>
		ws.on("framesent", ({ payload }) => {
			const message = JSON.parse(String(payload));
			// Retain ONLY listing metadata. No other message/body/transcript is stored or printed.
			if (message.type === "list_files")
				lists.push({ path: message.path ?? "", requestId: message.requestId, at: Date.now() });
		}),
	);
	const began = Date.now();
	await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
	await page.locator(".statusbar").waitFor({ state: "visible" });
	metrics[`${tab}-${viewport.width}-initialDisplayMs`] = Date.now() - began;
	// An intentionally credential-free sealed home shows normal setup UI. Close only that
	// window through its existing control; never force a Files click through an overlay.
	await page.locator(".setup-modal .modal-close").click();
	await page.locator(".setup-modal").waitFor({ state: "hidden" });
	return { page, lists, context };
}
const filesTab = (page) => page.locator('.panel-right [role="tab"]').filter({ hasText: /^(Files|文件)$/ });
const tldrTab = (page) => page.locator('.panel-right [role="tab"]').filter({ hasText: "TL;DR" });
async function exactlyOne(lists, action, path, name) {
	const before = lists.length;
	const began = Date.now();
	await action();
	const deadline = Date.now() + 5000;
	while (lists.length === before && Date.now() < deadline) await delay(10);
	await delay(100);
	check(`${name} count`, lists.length - before, 1);
	check(`${name} folder`, lists.at(-1)?.path, path);
	assert.equal(typeof lists.at(-1)?.requestId, "string");
	assert.ok(lists.at(-1).requestId.length <= 64);
	return lists.at(-1).at - began;
}
try {
	const deadline = Date.now() + 30_000;
	while (!(await portUp(port)) && Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`Synthetic server exited ${child.exitCode}`);
		await delay(100);
	}
	assert.ok(await portUp(port), "synthetic server listening");
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const desktop = await windowFor({ width: 1440, height: 900 }, "tldr");
	const { page, lists } = desktop;
	await tldrTab(page).waitFor({ state: "visible" });
	await delay(250);
	check("saved non-Files tab hidden bootstrap", lists.length, 0);
	metrics.firstRevealMs = await exactlyOne(lists, () => filesTab(page).click(), "", "desktop first reveal");
	await page.locator(".panel-right .file-item.dir .file-name").filter({ hasText: "folder-fixed" }).click();
	await page.locator(".panel-right .file-item.file .file-name").filter({ hasText: "keep.txt" }).waitFor();
	await tldrTab(page).click();
	const hiddenAt = lists.length;
	writeFileSync(join(work, "folder-fixed", "changed.txt"), "synthetic hidden change\n");
	await delay(250);
	check("hidden watch event sends no listing", lists.length, hiddenAt);
	await exactlyOne(lists, () => filesTab(page).click(), "folder-fixed", "dirty folder reveal");
	await page.locator(".panel-right .file-name").filter({ hasText: "changed.txt" }).waitFor();
	await page.locator(".panel-right .panel-collapse-btn").click();
	const collapsedAt = lists.length;
	writeFileSync(join(work, "folder-fixed", "collapsed.txt"), "synthetic collapsed change\n");
	await delay(250);
	check("desktop collapsed watch event sends no listing", lists.length, collapsedAt);
	await exactlyOne(lists, () => page.locator(".panel-rail-right").click(), "folder-fixed", "desktop expansion");
	await tldrTab(page).click();
	const desktopAt = lists.length;

	const mobile = await windowFor({ width: 520, height: 800 }, "files");
	await delay(250);
	check("mobile closed drawer hidden bootstrap", mobile.lists.length, 0);
	await exactlyOne(
		mobile.lists,
		() => mobile.page.locator(".panel-toggle.has-label").click(),
		"",
		"mobile drawer reveal",
	);
	await mobile.page.locator(".drawer-backdrop").click({ position: { x: 5, y: 400 } });
	const mobileAt = mobile.lists.length;
	writeFileSync(join(work, "mobile-hidden.txt"), "synthetic hidden change\n");
	await delay(250);
	check("mobile closed drawer watch event sends no listing", mobile.lists.length, mobileAt);
	await exactlyOne(
		mobile.lists,
		() => mobile.page.locator(".panel-toggle.has-label").click(),
		"",
		"mobile drawer return",
	);
	check("other window stayed hidden/independent", lists.length, desktopAt);
	if (process.env.PI_FILES_VISIBILITY_SCREENSHOT) {
		await page.screenshot({ path: process.env.PI_FILES_VISIBILITY_SCREENSHOT });
	}
	const report = process.env.PI_FILES_VISIBILITY_REPORT ?? join(REPO, "tests/scratch/files-visibility.json");
	mkdirSync(dirname(report), { recursive: true });
	writeFileSync(
		report,
		JSON.stringify(
			{
				result: "PASS",
				checks,
				metrics,
				scope: "Synthetic sealed Files UI only; no model, real chat, heap or server-watch reduction claim.",
			},
			null,
			2,
		) + "\n",
	);
	console.log(`ALL PASS (${checks.length} checks); initial chat display and first Files reveal measured separately.`);
} finally {
	await browser?.close();
	child.kill("SIGTERM");
	if (child.exitCode === null)
		await new Promise((resolve) => {
			const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
			child.once("exit", () => {
				clearTimeout(kill);
				resolve();
			});
		});
	rmSync(base, { recursive: true, force: true });
}
