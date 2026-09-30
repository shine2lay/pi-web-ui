/**
 * desktop-look: screenshots of the desktop layout at 1440×900, to compare two builds (mobile-fixes
 * must leave the desktop look as it was).
 *
 *   npm run build && scripts/sealed.sh node tests/tools/desktop-look.mjs <out dir>
 *
 * Takes the same shots every run, on a test server of its own with a made-up chat (tests/lib/phone-chat.mjs):
 * the chat at the bottom, the chat's top, the "/" menu, Settings, the top bar's "⋯" menu (when there is one)
 * and the terminal. Compare two runs with tests/tools/compare-shots.py.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "../lib/chrome.mjs";
import { startPhoneServer } from "../lib/phone-chat.mjs";
import { revealTopbarItem, SETTINGS_CHIP } from "../lib/topbar.mjs";

const out = process.argv[2];
if (!out) {
	console.error("usage: desktop-look.mjs <out dir>");
	process.exit(2);
}
mkdirSync(out, { recursive: true });

const kit = await startPhoneServer({ name: "desktop-look", exchanges: 30 });
kit.link.setSpeed(null);
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext({
	viewport: { width: 1440, height: 900 },
	deviceScaleFactor: 1,
	locale: "en-US",
	timezoneId: "UTC",
	reducedMotion: "reduce",
});
const page = await context.newPage();
const shot = async (name) => {
	await sleep(700);
	await page.screenshot({ path: join(out, `${name}.png`), animations: "disabled", caret: "hide" });
	console.log(`shot ${name}`);
};

try {
	await page.goto(`${kit.link.http}/?chat=${encodeURIComponent(kit.seeded.file)}`);
	await page.locator(".inputbox textarea").first().waitFor({ state: "visible", timeout: 60_000 });
	await page.getByText(kit.seeded.lastMarker).first().waitFor({ timeout: 60_000 });
	await sleep(2000);
	await shot("chat");

	// The top of the chat.
	await page.evaluate(() => {
		const list = document.querySelector(".messages");
		if (list) list.scrollTop = 0;
	});
	await sleep(1500);
	await shot("chat-top");
	await page.evaluate(() => {
		const list = document.querySelector(".messages");
		if (list) list.scrollTop = list.scrollHeight;
	});

	// The "/" menu.
	const ta = page.locator(".inputbox textarea").first();
	await ta.click();
	await ta.fill("/");
	await sleep(800);
	await shot("slash-menu");
	await ta.fill("");
	await page.keyboard.press("Escape");

	// The top bar's "⋯" menu, when the bar has one at this width.
	const more = page.locator(".plugin-topbar-more > button").first();
	if ((await more.count()) > 0 && (await more.isVisible())) {
		await more.click();
		await sleep(500);
		await shot("more-menu");
		await page.keyboard.press("Escape");
		if ((await more.getAttribute("aria-expanded")) === "true") await more.click();
	}

	// Settings.
	await (await revealTopbarItem(page, SETTINGS_CHIP)).click();
	await page.locator(".settings-modal").first().waitFor({ state: "visible", timeout: 30_000 });
	await shot("settings");
	await page.locator(".settings-modal .modal-close").first().click();
	await page
		.locator(".settings-modal")
		.first()
		.waitFor({ state: "detached", timeout: 10_000 })
		.catch(() => {});

	// The terminal.
	await (await revealTopbarItem(page, '[role="tab"]:has-text("Terminal")')).click();
	await page.locator(".xterm").first().waitFor({ state: "visible", timeout: 30_000 });
	await sleep(1500);
	await shot("terminal");
} finally {
	await browser.close().catch(() => {});
	await kit.link.close().catch(() => {});
	await kit.srv.stop().catch(() => {});
}
