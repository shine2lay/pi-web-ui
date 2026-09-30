/**
 * phone-layout E2E (no tokens): pi-web-ui on an Android phone (mobile-fixes).
 *
 * An emulated Android phone (Chrome, 412×915 and 360×800, touch; tests/lib/phone.mjs) on a sealed
 * test server with a seeded chat (tests/lib/phone-chat.mjs). Checks:
 *  1. Startup: on a slow mobile-data link (tests/lib/slow-link.mjs, CPU 4× slower) the chat becomes
 *     usable without loading what a chat doesn't need yet (terminal, math, HTML in markdown,
 *     settings); each of those loads when first used, and works.
 *  2. Typing: the page tells Android to shrink itself for the keyboard (interactive-widget); with
 *     the keyboard up (the screen gets shorter, as Android does) the message box and Send stay fully
 *     visible, the top bar stays put, a chat that was at the bottom stays there, a message growing
 *     line by line doesn't make the page jump, Enter adds a line; Android-style typing (the keyboard
 *     composes each word) gives the right text and cursor, also mid-text and in the / and @ menus.
 *  3. Buttons, at 412 and 360: every tap target is at least 44×44 px (Send 48), no two overlap,
 *     nothing is cut off: on the chat screen, a message's buttons, the "⋯" menu and the chats
 *     drawer. Everything the top bar has on a desktop is still there on the phone (on the bar or in
 *     "⋯").
 *
 * Usage: npm run build && scripts/sealed.sh node tests/phone-layout-test.mjs
 *   scripts/sealed.sh env PI_PHONE_SHOTS=<folder> node tests/phone-layout-test.mjs   (screenshots)
 * Only layout and timing facts are read; the only chat text is the made-up seeded chat.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { launchBrowser, openPhone, PHONE_360, PHONE_412 } from "./lib/phone.mjs";
import { hookSocket, startPhoneServer } from "./lib/phone-chat.mjs";
import {
	closeDrawers,
	installTimers,
	measureKeyboard,
	measureTargets,
	measureTyping,
	sendFromPhone,
	TA,
} from "./lib/phone-checks.mjs";
import { revealTopbarItem, SETTINGS_CHIP } from "./lib/topbar.mjs";

const SHOTS = process.env.PI_PHONE_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}

/** Parts that load only when first needed (vite chunk names). */
const LATER = /\/assets\/(TerminalPanel|xterm|katex|md-math|md-raw|md-html|SettingsModal|ModelConfigModal)-/;

/** Every control of the top bar, by its own label: on the bar, and in the "⋯" menu. */
async function topbarControls(page) {
	const read = (where) =>
		page.evaluate((where) => {
			const label = (el) =>
				(
					el.getAttribute("aria-label") ||
					el.getAttribute("data-tip") ||
					el.getAttribute("title") ||
					el.textContent ||
					""
				)
					.replace(/\s+/g, " ")
					// Live parts change while the page runs (the Update item's "· v1.2.3" and its
					// "N updates" badge fill in whenever the update check answers): keep the name.
					.replace(/ · .*$/, "")
					.trim();
			const sel =
				where === "bar"
					? ".topbar button, .topbar a[href], .topbar [role=tab]"
					: ".plugin-topbar-menu button, .plugin-topbar-menu a[href], .plugin-topbar-menu [role=menuitem], .plugin-topbar-menu [role=tab]";
			const out = [];
			for (const el of document.querySelectorAll(sel)) {
				if (where === "bar" && el.closest(".plugin-topbar-more")) continue;
				// A control inside another control is part of it.
				if (el.parentElement?.closest("button, a[href], [role=menuitem], [role=tab]")) continue;
				const r = el.getBoundingClientRect();
				if (r.width > 0 && r.height > 0) out.push(label(el));
			}
			return out;
		}, where);
	const bar = await read("bar");
	const menu = [];
	const more = page.locator(".plugin-topbar-more > button").first();
	if ((await more.count()) > 0 && (await more.isVisible())) {
		await more.click();
		await page.locator(".plugin-topbar-menu").first().waitFor({ state: "visible", timeout: 5000 });
		await sleep(300);
		menu.push(...(await read("menu")));
		await page.keyboard.press("Escape");
		if ((await more.getAttribute("aria-expanded")) === "true") await more.click();
		await sleep(200);
	}
	return { bar: [...new Set(bar)].filter(Boolean), menu: [...new Set(menu)].filter(Boolean) };
}

const kit = await startPhoneServer({ name: "phone-layout", exchanges: 40 });
const chatUrl = (file) => `${kit.link.http}/?chat=${encodeURIComponent(file)}`;
// Something for the @ menu to find.
mkdirSync(join(kit.srv.workdir, "src"), { recursive: true });
writeFileSync(join(kit.srv.workdir, "src", "phone-app.ts"), "export const phone = true;\n");
const browser = await launchBrowser();

try {
	// ── 1. Startup on the slow link ─────────────────────────────────────────────────────────
	{
		kit.link.setSpeed({});
		const phone = await openPhone(browser, { size: PHONE_412, cpu: 4 });
		const { page } = phone;
		await hookSocket(page);
		await installTimers(page);
		const requested = [];
		page.on("request", (r) => requested.push(new URL(r.url()).pathname));
		await page.goto(chatUrl(kit.seeded.file));
		await page.waitForFunction(
			() => window.__phoneT?.chat != null && window.__phoneT?.composer != null && window.__phoneT?.ws != null,
			null,
			{
				timeout: 180_000,
			},
		);
		const usableMs = await page.evaluate(() =>
			Math.max(window.__phoneT.chat, window.__phoneT.composer, window.__phoneT.ws),
		);
		// What loads right after still counts as startup.
		await sleep(3000);
		const early = requested.filter((p) => LATER.test(p));
		check("the chat becomes usable on a slow link (CPU 4×)", usableMs < 60_000, `${usableMs} ms`);
		check("startup loads no terminal, math, HTML-in-markdown or settings code", early.length === 0, early.join(", "));
		const viewport = (await page.getAttribute('meta[name="viewport"]', "content")) ?? "";
		check(
			"the page asks Android to shrink it for the keyboard",
			/interactive-widget=resizes-content/.test(viewport),
			viewport,
		);

		kit.link.setSpeed(null);
		await phone.setCpu(1);
		// Math: loads when a text has some, then shows as math.
		await sendFromPhone(page, "Show $E=mc^2$ as math please");
		const katex = await page
			.locator(".messages .katex")
			.first()
			.waitFor({ state: "visible", timeout: 30_000 })
			.then(() => true)
			.catch(() => false);
		check(
			"math loads when a message has some, and shows as math",
			katex && requested.some((p) => /\/assets\/(md-math|katex)-/.test(p)),
		);
		// Settings: loads when opened.
		await (await revealTopbarItem(page, SETTINGS_CHIP)).click();
		const settings = await page
			.locator(".settings-modal")
			.first()
			.waitFor({ state: "visible", timeout: 30_000 })
			.then(() => true)
			.catch(() => false);
		check(
			"Settings opens on the phone (loaded when first opened)",
			settings && requested.some((p) => /\/assets\/SettingsModal-/.test(p)),
		);
		await page.keyboard.press("Escape");
		if ((await page.locator(".settings-modal").count()) > 0)
			await page.locator(".settings-modal .modal-close").first().click();
		await page
			.locator(".settings-modal")
			.first()
			.waitFor({ state: "detached", timeout: 10_000 })
			.catch(() => {});
		// Terminal: loads when opened.
		await (await revealTopbarItem(page, '[role="tab"]:has-text("Terminal")')).click();
		const term = await page
			.locator(".terminal-view .xterm")
			.first()
			.waitFor({ state: "visible", timeout: 30_000 })
			.then(() => true)
			.catch(() => false);
		check(
			"the terminal opens on the phone (loaded when first opened)",
			term && requested.some((p) => /\/assets\/(TerminalPanel|xterm)-/.test(p)),
		);
		if (SHOTS) await page.screenshot({ path: join(SHOTS, "412-terminal.png") });
		await phone.close();
	}

	// ── 2 + 3. Typing and buttons, at both phone sizes ──────────────────────────────────────
	const desktop = await (async () => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await context.newPage();
		await page.goto(chatUrl(kit.seeded.file));
		await page.locator(TA).waitFor({ state: "visible", timeout: 60_000 });
		await sleep(1500);
		const c = await topbarControls(page);
		if (SHOTS) await page.screenshot({ path: join(SHOTS, "1440-chat.png") });
		await context.close();
		return c;
	})();

	for (const size of [PHONE_412, PHONE_360]) {
		const phone = await openPhone(browser, { size, cpu: 1 });
		const { page } = phone;
		await hookSocket(page);
		await installTimers(page);
		await page.goto(kit.link.http);
		await page.evaluate(() => sessionStorage.setItem("__phoneMarker", ""));
		await page.goto(chatUrl(kit.seeded.file));
		await page.waitForFunction(() => window.__phoneT?.chat != null && window.__phoneT?.ws != null, null, {
			timeout: 120_000,
		});
		await sleep(1000);
		const at = `${size.width}`;

		// A chat at the bottom stays there when something appears under it (the goal row just after the
		// chat opens, the keyboard, the "Reconnecting…" note), even though nothing in the chat changed.
		// And when it goes away again, the chat keeps following: the browser pulling the list back as its
		// box grows must not read as the user scrolling up (the next shrink would then leave it behind).
		const pinned = await page.evaluate(async () => {
			const list = document.querySelector(".messages");
			const wrap = list?.closest(".messages-wrap");
			if (!list || !wrap) return null;
			const settle = async () => {
				await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
				await new Promise((r) => setTimeout(r, 120));
			};
			const fromBottom = () => Math.round(list.scrollHeight - list.clientHeight - list.scrollTop);
			const strip = document.createElement("div");
			strip.style.cssText = "height:40px;flex:none";
			list.scrollTop = list.scrollHeight;
			await settle();
			const full = list.clientHeight;
			wrap.after(strip);
			await settle();
			const first = { shrunkBy: full - list.clientHeight, fromBottom: fromBottom() };
			strip.remove();
			await settle();
			await new Promise((r) => setTimeout(r, 300));
			wrap.after(strip);
			await settle();
			const again = fromBottom();
			strip.remove();
			await settle();
			return { ...first, again };
		});
		check(
			`${at}: a chat at the bottom stays there when something appears under it`,
			!!pinned && pinned.shrunkBy >= 30 && pinned.fromBottom <= 2,
			JSON.stringify(pinned),
		);
		check(
			`${at}: ...and still follows after it went away (not read as scrolling up)`,
			!!pinned && pinned.again <= 2,
			JSON.stringify(pinned),
		);
		const shots = SHOTS ? join(SHOTS, at) : "";

		// Buttons.
		const { summary } = await measureTargets(phone, { shots });
		for (const [where, s] of Object.entries(summary)) {
			check(`${at}: ${where}: every tap target is at least 44×44 px`, s.small.length === 0, s.small.join(", "));
			check(`${at}: ${where}: main buttons are at least 48×48 px`, s.mainSmall.length === 0, s.mainSmall.join(", "));
			check(`${at}: ${where}: no tap targets overlap`, s.overlaps.length === 0, s.overlaps.join("; "));
			check(`${at}: ${where}: nothing is cut off or squashed`, s.cut.length === 0, s.cut.join(", "));
		}
		for (const where of ["chat", "messageActions", "moreMenu", "drawer"]) {
			check(`${at}: ${where} was measured`, (summary[where]?.count ?? 0) > 0);
		}
		const mine = await topbarControls(page);
		if (process.env.PI_PHONE_REPORT)
			console.log(`top bar at 1440: ${JSON.stringify(desktop)}\ntop bar at ${at}: ${JSON.stringify(mine)}`);
		const reachable = new Set([...mine.bar, ...mine.menu]);
		const missing = [...desktop.bar, ...desktop.menu].filter((l) => !reachable.has(l));
		check(
			`${at}: everything the desktop top bar has is on the phone (bar or "⋯")`,
			missing.length === 0,
			missing.join(", "),
		);
		check(
			`${at}: the top bar keeps the "⋯" menu for the less-used buttons`,
			mine.menu.length > 0,
			`${mine.bar.length} on the bar`,
		);

		// Typing.
		await closeDrawers(page);
		const kb = await measureKeyboard(phone, { shots });
		check(`${at}: keyboard up: the message box is fully visible`, kb.keyboardUp.composerVisible === true);
		check(`${at}: keyboard up: Send is fully visible`, kb.keyboardUp.sendVisible === true);
		check(
			`${at}: keyboard up: the top bar stays put`,
			kb.keyboardUp.topbarTop === 0 && kb.keyboardUp.docScroll === 0,
			JSON.stringify(kb.keyboardUp),
		);
		check(
			`${at}: keyboard up: a chat at the bottom stays at the bottom`,
			kb.before.fromBottom <= 2 && kb.keyboardUp.fromBottom <= 2,
			JSON.stringify(kb),
		);
		const jumps = kb.growth.filter(
			(g) => g.topbarTop !== 0 || g.docScroll !== 0 || !g.composerVisible || !g.sendVisible || g.fromBottom > 2,
		);
		check(`${at}: a message growing line by line doesn't move the page`, jumps.length === 0, JSON.stringify(jumps));
		check(
			`${at}: keyboard down and up again: the chat is still at the bottom`,
			kb.upAgain.fromBottom <= 2,
			JSON.stringify(kb.upAgain),
		);
		check(`${at}: Enter adds a line on the phone`, kb.enterAddsLine === true);
		if (size === PHONE_412) {
			const ty = await measureTyping(phone);
			check("Android-style typing: plain text and cursor right", ty.plainOk, JSON.stringify(ty.plain));
			check("Android-style typing: in the middle of the text", ty.middleOk, JSON.stringify(ty.middle));
			check(
				"Android-style typing: the / menu",
				ty.slashOk && ty.slashMenu.open && ty.slashMenu.onScreen,
				JSON.stringify([ty.slash, ty.slashMenu]),
			);
			check(
				"Android-style typing: the @ menu",
				ty.mentionOk && ty.mentionMenu.open && ty.mentionMenu.onScreen,
				JSON.stringify([ty.mention, ty.mentionMenu]),
			);
		}
		await phone.close();
	}
} catch (e) {
	check("the test ran to the end", false, e?.stack ?? String(e));
} finally {
	await browser.close().catch(() => {});
	await kit.link.close().catch(() => {});
	await kit.srv.stop().catch(() => {});
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall phone layout checks passed");
process.exit(failures ? 1 : 0);
