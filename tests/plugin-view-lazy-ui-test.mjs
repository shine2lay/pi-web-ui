/* Browser E2E (frontend #297): a plugin's view tab mounts only when it is first opened.
 *
 * Why: the app used to mount every enabled plugin view hidden at start, so a plugin that embeds
 * a page (the Temper plugin embeds temper-dev) loaded its iframe on every page, and a site that
 * refuses framing put a console error on every page. A view now mounts on first opening and then
 * stays mounted and hidden, like the Roles page.
 *
 * Covers (no tokens, a local fixture plugin, no network):
 *   - before its tab is opened: no plugin iframe, no request to its frame URL, mount() not called
 *     (its client bundle still loads: bundle loading stays eager)
 *   - first opening, from the top bar's Plugins menu: the view mounts once and its iframe loads
 *   - switching away and back: the same iframe node (state kept), mount() still called once
 *
 * Run: npm run build && scripts/sealed.sh node tests/plugin-view-lazy-ui-test.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";
import { revealTopbarItem } from "./lib/topbar.mjs";

if (!process.env.PI_SEALED) throw new Error("Run with scripts/sealed.sh");
if (!CHROME_PATH) throw new Error("Chrome is required");

// A closed port: the browser makes the frame's request, and nothing answers it.
const FRAME_MARKER = "lazy-frame-marker";
const FRAME_URL = `http://127.0.0.1:9/${FRAME_MARKER}.html`;
const TAB_LABEL = "Lazy Frame";
const FRAME = 'iframe[title="lazy-frame"]';

let passed = 0;
const check = (name, cond, detail = "") => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}${detail ? ` (${detail})` : ""}`);
		process.exitCode = 1;
	}
};

/** Fixture plugin: a view tab whose mount() embeds a page, as the Temper plugin does. */
function writeFixturePlugin({ dataDir }) {
	const pdir = join(dataDir, "plugins", "lazyframe");
	mkdirSync(join(pdir, "client"), { recursive: true });
	writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: TAB_LABEL, version: "0.0.1", view: true }));
	writeFileSync(
		join(pdir, "client", "entry.mjs"),
		`export default {
	mount(container) {
		window.__lazyMounts = (window.__lazyMounts || 0) + 1;
		const frame = document.createElement("iframe");
		frame.title = "lazy-frame";
		frame.src = ${JSON.stringify(FRAME_URL)};
		container.appendChild(frame);
	},
};
`,
	);
}

/** Mount count, iframe count, visibility and the iframe's tag, read in one evaluate. */
const frameState = (page) =>
	page.evaluate((sel) => {
		const frames = document.querySelectorAll(sel);
		const f = frames[0];
		return {
			mounts: window.__lazyMounts ?? 0,
			frames: frames.length,
			visible: Boolean(f && f.getClientRects().length > 0),
			tag: f ? (f.dataset.lazyTag ?? "") : "",
		};
	}, FRAME);

/** Open the view as the owner does: the top bar's Plugins menu, then the plugin's row. */
async function openTab(page) {
	const menu = await revealTopbarItem(page, 'button.chip[aria-haspopup="menu"][data-tip="Plugins"]');
	await menu.click();
	const row = page.locator(".pm-panel .pm-row-main", { hasText: TAB_LABEL }).first();
	await row.waitFor({ state: "visible", timeout: 15000 });
	await row.click();
}

const srv = await ownServer({ name: "plugin-view-lazy", env: { PI_WEB_TOKEN: "" }, prepare: writeFixturePlugin });
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
try {
	const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
	const pageErrors = [];
	const frameRequests = [];
	page.on("pageerror", (e) => pageErrors.push(String(e)));
	page.on("request", (r) => {
		if (r.url().includes(FRAME_MARKER)) frameRequests.push(r.url());
	});

	// The plugin's client bundle still loads at start; wait for it, then give a mount time to happen.
	const bundle = page.waitForResponse((r) => r.url().includes("/plugins/lazyframe/client/entry.mjs"), {
		timeout: 20000,
	});
	await page.goto(srv.http, { waitUntil: "domcontentloaded" });
	await bundle;
	await sleep(1500);
	const before = await frameState(page);
	check("before its tab is opened: no plugin iframe", before.frames === 0, `frames=${before.frames}`);
	check("before its tab is opened: mount() not called", before.mounts === 0, `mounts=${before.mounts}`);
	check(
		"before its tab is opened: no request to its frame URL",
		frameRequests.length === 0,
		`requests=${frameRequests.length}`,
	);

	await openTab(page);
	await page.locator(FRAME).first().waitFor({ state: "attached", timeout: 15000 });
	await sleep(300);
	const opened = await frameState(page);
	check("first opening mounts the view once", opened.mounts === 1 && opened.frames === 1, JSON.stringify(opened));
	check("first opening shows the frame", opened.visible);
	check("first opening requests the frame URL", frameRequests.length >= 1);
	await page.evaluate((sel) => {
		const f = document.querySelector(sel);
		if (f) f.dataset.lazyTag = "first";
	}, FRAME);

	await page.evaluate(() => window.__piWebUiHost?.setView("chat"));
	await sleep(400);
	const away = await frameState(page);
	check("switching away hides the view but keeps it mounted", away.frames === 1 && !away.visible, JSON.stringify(away));

	await openTab(page);
	await sleep(400);
	const back = await frameState(page);
	check("switching back shows the same iframe node", back.visible && back.tag === "first", JSON.stringify(back));
	check("switching back does not mount again", back.mounts === 1, `mounts=${back.mounts}`);

	check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
	console.log(`\n${passed} checks passed`);
} catch (err) {
	console.error("test error:", err);
	process.exitCode = 1;
} finally {
	await browser.close().catch(() => {});
	await srv.stop();
}
