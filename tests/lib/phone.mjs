/**
 * phone.mjs: an Android phone in headless Chrome, for the phone tests (tests/phone-*-test.mjs) and
 * the phone measurements (tests/tools/phone-measure.mjs).
 *
 *   const browser = await launchBrowser();
 *   const phone = await openPhone(browser, { size: PHONE_412, cpu: 4 });
 *   await phone.page.goto(url);
 *   await phone.keyboard.show();   // the on-screen keyboard comes up: the window gets shorter, which
 *                                  // is what Android Chrome does with interactive-widget=resizes-content
 *   await phone.keyboard.hide();
 *   await phone.sleep();           // the phone goes to sleep: the page is hidden, then frozen
 *   await phone.wake();            // ... and back: resumed, then visible again
 *   await phone.typeLikeAndroid("hello world");   // word by word through the IME (composition)
 *   await phone.close();
 *
 * The phone: 412×915 (a Pixel-sized phone) or 360×800 (a small one), touch, mobile, an Android
 * Chrome user agent, and the CPU slowed down (4× by default), because phones are slower than the
 * machine the tests run on.
 */
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./chrome.mjs";

export const PHONE_412 = { name: "412", width: 412, height: 915, deviceScaleFactor: 2.625, keyboard: 336 };
export const PHONE_360 = { name: "360", width: 360, height: 800, deviceScaleFactor: 3, keyboard: 300 };
export const ANDROID_UA =
	"Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

export async function launchBrowser(opts = {}) {
	if (!CHROME_PATH) throw new Error("no Chrome for the phone tests (set PI_WEB_CHROME)");
	return chromium.launch({ executablePath: CHROME_PATH, headless: true, ...opts });
}

/**
 * A new phone (its own browser context: own cookies, storage and cache).
 * @param {import("playwright-core").Browser} browser
 */
export async function openPhone(browser, { size = PHONE_412, cpu = 4, locale = "en-US" } = {}) {
	const context = await browser.newContext({
		viewport: { width: size.width, height: size.height },
		screen: { width: size.width, height: size.height },
		deviceScaleFactor: size.deviceScaleFactor,
		isMobile: true,
		hasTouch: true,
		userAgent: ANDROID_UA,
		locale,
	});
	const page = await context.newPage();
	const cdp = await context.newCDPSession(page);
	if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
	let keyboardUp = false;

	const setHidden = async (hidden) => {
		// Headless Chrome has no real tab switching; the page is told it is hidden or visible the way
		// the browser tells it (visibilityState + visibilitychange, pagehide/pageshow stay untouched).
		await page.evaluate((h) => {
			Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
			Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
			document.dispatchEvent(new Event("visibilitychange"));
		}, hidden);
	};

	const phone = {
		size,
		context,
		page,
		cdp,
		keyboard: {
			get up() {
				return keyboardUp;
			},
			async show() {
				keyboardUp = true;
				await page.setViewportSize({ width: size.width, height: size.height - size.keyboard });
			},
			async hide() {
				keyboardUp = false;
				await page.setViewportSize({ width: size.width, height: size.height });
			},
		},
		async setCpu(rate) {
			await cdp.send("Emulation.setCPUThrottlingRate", { rate });
		},
		setHidden,
		/** Screen off: the tab is hidden, then Chrome freezes it (no timers, no events). */
		async sleep() {
			await setHidden(true);
			await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
		},
		/** Screen on again: Chrome resumes the tab, then shows it. */
		async wake() {
			await cdp.send("Page.setWebLifecycleState", { state: "active" });
			await setHidden(false);
		},
		/**
		 * Type the way Android keyboards do (Gboard): each word is composed letter by letter through
		 * the IME (keydown 229 "Unidentified", then the composition grows), then committed, then the
		 * space. Characters that are not letters or digits are committed on their own, like "/" or "@".
		 */
		async typeLikeAndroid(text, { letterMs = 0 } = {}) {
			const tokens = text.match(/[\p{L}\p{N}]+|[^\p{L}\p{N}]/gu) ?? [];
			for (const token of tokens) {
				const word = /^[\p{L}\p{N}]+$/u.test(token);
				if (word) {
					for (let i = 1; i <= token.length; i++) {
						const part = token.slice(0, i);
						await key229();
						await cdp.send("Input.imeSetComposition", { text: part, selectionStart: i, selectionEnd: i });
						await keyUp229();
						if (letterMs) await new Promise((r) => setTimeout(r, letterMs));
					}
					await key229();
					await cdp.send("Input.insertText", { text: token });
					await keyUp229();
				} else {
					await key229();
					await cdp.send("Input.insertText", { text: token });
					await keyUp229();
				}
			}
		},
		async close() {
			await context.close().catch(() => {});
		},
	};

	async function key229() {
		await cdp.send("Input.dispatchKeyEvent", {
			type: "rawKeyDown",
			key: "Unidentified",
			code: "",
			windowsVirtualKeyCode: 229,
			nativeVirtualKeyCode: 229,
		});
	}
	async function keyUp229() {
		await cdp.send("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: "Unidentified",
			code: "",
			windowsVirtualKeyCode: 229,
			nativeVirtualKeyCode: 229,
		});
	}

	return phone;
}

/**
 * Tap targets inside `scopes` (CSS selectors): every visible button, link, menu item, checkbox or
 * other control, with its box. Only layout facts: class names and the control's own label
 * (aria-label / data-tip / title), never text from a chat.
 * Returns { targets: [{ scope, name, x, y, w, h, main }], overlaps: [[a, b]], cut: [name] }.
 */
export async function tapTargets(page, scopes, { mainSelectors = [] } = {}) {
	return page.evaluate(
		({ scopes, mainSelectors }) => {
			const SEL =
				'button, a[href], [role="button"], [role="menuitem"], [role="tab"], [role="switch"], [role="checkbox"], input[type="checkbox"], input[type="radio"], select, summary';
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			const nameOf = (el) => {
				const cls = [...el.classList].slice(0, 3).join(".");
				const label = el.getAttribute("aria-label") || el.getAttribute("data-tip") || el.getAttribute("title") || "";
				return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}${label ? `[${label.slice(0, 40)}]` : ""}`;
			};
			const visible = (el) => {
				const r = el.getBoundingClientRect();
				if (r.width < 1 || r.height < 1) return false;
				const cs = getComputedStyle(el);
				if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
				if (el.closest("[aria-hidden='true'], [inert]")) return false;
				// Covered by something else at its middle (e.g. a closed drawer's leftovers): still counted.
				return r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
			};
			/* Cut off: part of the control can't be seen and can't be scrolled to: it sticks out of the
			   screen or out of a box that clips it, or its own content is clipped without an ellipsis.
			   A row that scrolls sideways (or up and down) doesn't cut: the rest is a swipe away. */
			const scrolls = (cs, axis) => /(auto|scroll)/.test(axis === "x" ? cs.overflowX : cs.overflowY);
			const isCut = (el, r) => {
				const cs = getComputedStyle(el);
				const ellipsis = cs.textOverflow === "ellipsis" && !/flex|grid/.test(cs.display);
				if (!ellipsis && el.scrollWidth > el.clientWidth + 1 && !scrolls(cs, "x")) return true;
				if (el.scrollHeight > el.clientHeight + 2 && !scrolls(cs, "y")) return true;
				let box = { left: 0, top: 0, right: vw, bottom: vh };
				let scrollX = false;
				let scrollY = false;
				for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
					const acs = getComputedStyle(a);
					if (acs.position === "fixed") break;
					const ar = a.getBoundingClientRect();
					if (acs.overflowX !== "visible") {
						if (scrolls(acs, "x")) scrollX = true;
						else if (!scrollX)
							box = { ...box, left: Math.max(box.left, ar.left), right: Math.min(box.right, ar.right) };
					}
					if (acs.overflowY !== "visible") {
						if (scrolls(acs, "y")) scrollY = true;
						else if (!scrollY)
							box = { ...box, top: Math.max(box.top, ar.top), bottom: Math.min(box.bottom, ar.bottom) };
					}
				}
				const outX = r.left < box.left - 0.5 || r.right > box.right + 0.5;
				const outY = r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5;
				return (outX && !scrollX) || (outY && !scrollY);
			};
			const targets = [];
			const seen = new Set();
			for (const scope of scopes) {
				for (const root of document.querySelectorAll(scope)) {
					for (const el of root.querySelectorAll(SEL)) {
						if (seen.has(el) || !visible(el)) continue;
						// A control inside another control counts once (the outer one is what a finger hits).
						if (el.parentElement?.closest(SEL) && root.contains(el.parentElement.closest(SEL))) continue;
						seen.add(el);
						const r = el.getBoundingClientRect();
						const main = mainSelectors.some((s) => el.matches(s));
						const cut = isCut(el, r);
						targets.push({
							scope,
							name: nameOf(el),
							x: Math.round(r.left),
							y: Math.round(r.top),
							w: Math.round(r.width * 10) / 10,
							h: Math.round(r.height * 10) / 10,
							main,
							cut,
						});
					}
				}
			}
			const overlaps = [];
			for (let i = 0; i < targets.length; i++) {
				for (let j = i + 1; j < targets.length; j++) {
					const a = targets[i];
					const b = targets[j];
					const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
					const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
					if (ox > 1 && oy > 1) overlaps.push([a.name, b.name]);
				}
			}
			return { targets, overlaps, cut: targets.filter((t) => t.cut).map((t) => t.name) };
		},
		{ scopes, mainSelectors },
	);
}
