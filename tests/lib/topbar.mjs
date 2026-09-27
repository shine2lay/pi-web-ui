// Shared helpers for finding top-bar buttons in browser tests.
//
// Our fork's topbar-crowding patch (PATCHES.md) puts some built-in buttons, such as
// Settings and Background tasks, in the "⋯" menu by default. Upstream tests that click them
// straight on the bar must open that menu first. The buttons in the menu are the same
// chips as on the bar, so the selectors don't change.

/** The Settings button, on the bar or in the "⋯" menu. An exact match: other bar buttons
 *  (such as sound settings) also have "设置" / "Settings" in their tips. */
export const SETTINGS_CHIP = 'button.chip[data-tip="设置"], button.chip[data-tip="Settings"]';

const MORE_BUTTON = ".plugin-topbar-more > button";

/** The "..." menu's entry row whose text matches `entry` (sound, language, theme and version
 *  are entry rows there that open a drawer from the right). */
const menuEntry = (page, entry) =>
	page.locator(".plugin-topbar-menu [role=menuitem]").filter({ hasText: entry }).first();

async function isVisibleSoon(locator, ms) {
	return locator
		.waitFor({ state: "visible", timeout: ms })
		.then(() => true)
		.catch(() => false);
}

async function openMoreMenu(page) {
	const more = page.locator(MORE_BUTTON).first();
	await more.waitFor({ state: "visible", timeout: 15000 });
	if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
}

/**
 * Text of a top-bar item that can sit on the bar (`bar`, a locator) or, with our fork's
 * topbar-crowding, as an entry row in the "..." menu (`entry`, a RegExp). Reads the menu row
 * and closes the menu again when the item isn't on the bar.
 */
export async function topbarItemText(page, { bar, entry }) {
	if (await isVisibleSoon(bar, 2500)) return bar.textContent();
	await openMoreMenu(page);
	const row = menuEntry(page, entry);
	await row.waitFor({ state: "visible", timeout: 15000 });
	const text = await row.textContent();
	await page.keyboard.press("Escape");
	if ((await page.locator(MORE_BUTTON).first().getAttribute("aria-expanded")) === "true") {
		await page.locator(MORE_BUTTON).first().click();
	}
	return text;
}

/**
 * Open a top-bar panel (sound, language, theme, version): click its dropdown chip on the bar
 * (`bar`) or, when it is in the "..." menu, the menu row (`entry`), which opens the same panel
 * in a drawer. The panel's rows are the same `.dd-item`s either way.
 * @returns {Promise<"bar" | "drawer">}
 */
export async function openTopbarPanel(page, { bar, entry }) {
	// A drawer left open by an earlier pick covers the page: close it first.
	if ((await page.locator(".topbar-drawer-backdrop").count()) > 0) await closeTopbarPanel(page);
	if (await isVisibleSoon(bar, 2500)) {
		await bar.click();
		return "bar";
	}
	await openMoreMenu(page);
	await menuEntry(page, entry).click();
	await page.locator(".topbar-drawer").first().waitFor({ state: "visible", timeout: 15000 });
	return "drawer";
}

/** Close a panel opened with openTopbarPanel. The drawer stays open after a pick (on purpose,
 *  to try several themes in a row); its backdrop closes it. */
export async function closeTopbarPanel(page) {
	const backdrop = page.locator(".topbar-drawer-backdrop").first();
	if ((await backdrop.count()) > 0) {
		await backdrop.click({ position: { x: 5, y: 5 } });
		await backdrop.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
	} else {
		await page.keyboard.press("Escape");
	}
}

/**
 * Make a top-bar item visible and return its locator. If it isn't on the bar, open the
 * "⋯" menu (once) and look again.
 * @param {import("playwright-core").Page} page
 * @param {string} selector
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function revealTopbarItem(page, selector, { timeoutMs = 15000 } = {}) {
	const item = page.locator(selector).first();
	const visible = async (ms) =>
		item
			.waitFor({ state: "visible", timeout: ms })
			.then(() => true)
			.catch(() => false);
	if (await visible(2500)) return item;
	const more = page.locator(".plugin-topbar-more > button").first();
	if ((await more.count()) > 0 && (await more.getAttribute("aria-expanded")) !== "true") {
		await more.click();
	}
	if (await visible(timeoutMs)) return item;
	throw new Error(`top bar: "${selector}" is neither on the bar nor in the "⋯" menu`);
}
