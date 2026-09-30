/* phone-look: a quick look at the phone layout (screenshots + tap targets), no timing.
 * Usage: npm run build && scripts/sealed.sh node tests/tools/phone-look.mjs /tmp/phone-look
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, openPhone, PHONE_360, PHONE_412, tapTargets } from "../lib/phone.mjs";
import { hookSocket, openChatOnPage, startPhoneServer } from "../lib/phone-chat.mjs";

const out = process.argv[2] ?? "/tmp/phone-look";
mkdirSync(out, { recursive: true });
const kit = await startPhoneServer({ name: "phone-look", exchanges: 40 });
kit.link.setSpeed(null);
const browser = await launchBrowser();
const result = {};
try {
	for (const size of [PHONE_412, PHONE_360]) {
		const phone = await openPhone(browser, { size, cpu: 1 });
		const { page } = phone;
		await hookSocket(page);
		await page.goto(kit.link.http);
		await openChatOnPage(page, kit.seeded.file);
		await page.waitForFunction((m) => document.body.innerText.includes(m), kit.seeded.lastMarker, { timeout: 60_000 });
		await page.waitForTimeout(800);
		await page.screenshot({ path: join(out, `${size.name}-chat.png`) });
		const outline = await page.evaluate(() => {
			const pick = (sel) =>
				[...document.querySelectorAll(sel)].slice(0, 3).map((el) => {
					const r = el.getBoundingClientRect();
					return { sel, cls: el.className?.toString().slice(0, 80), x: r.x, y: r.y, w: r.width, h: r.height };
				});
			return [
				".app",
				".topbar",
				".topbar-flow",
				".plugin-topbar-more",
				".messages",
				".inputbox",
				".composer-tools",
				".inputbox-actions",
				".btn.send",
				"footer, .footerbar, .footer-bar",
			].flatMap(pick);
		});
		const targets = await tapTargets(page, [".topbar", ".inputbox", ".composer-tools", ".inputbox-actions"], {
			mainSelectors: [".btn.send"],
		});
		result[size.name] = { outline, targets };
		await phone.close();
	}
} finally {
	writeFileSync(join(out, "look.json"), JSON.stringify(result, null, 1));
	await browser.close();
	await kit.link.close();
	await kit.srv.stop();
}
console.log(JSON.stringify(result, null, 1).slice(0, 6000));
