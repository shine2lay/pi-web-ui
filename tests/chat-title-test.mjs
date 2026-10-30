/**
 * chat-title (fork patch, PATCHES.md): the open chat's title at the top of the middle pane, the left
 * bar's own name for it (web/src/chat-title.ts; its rules: tests/unit/chat-title.test.ts).
 *
 * A server of its own (tests/lib/own-server.mjs) with two made-up saved chats (seedChat, then named the
 * way pi's /name names a chat); no real chats, and nothing is sent, so no model is called:
 *  1. desktop 1440×900: a blank new chat has no title and no header bar;
 *  2. a chat opened from History: the title is the left bar's current row's name, a heading outside the
 *     header's toolbars, on one line, its tooltip the full title;
 *  3. renamed from the left bar: the title follows; a long name ends in an ellipsis on one line and the
 *     header stays one line tall;
 *  4. switched to the other chat and back: the title follows both times;
 *  5. axe: no serious or critical hits in the header;
 *  6. Settings > Interface layout > Chat header > Chat title off: no title; on again: back;
 *  7. New chat: the title goes;
 *  8. phone 390×844: the chat picked in the chats drawer: its row's name is the title, on one line with an
 *     ellipsis, inside the screen, the header one line tall; axe.
 *
 * Usage: npm run build && node tests/chat-title-test.mjs   (sealed: node tests/run-sealed.mjs chat-title-test)
 *        CHATTITLE_SHOT=/tmp/ct saves screenshots /tmp/ct-*.png
 *        PI_AXE_JS: axe-core (default the design kit's copy in ~/temper-ai)
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";
import { seedChat } from "./lib/phone-chat.mjs";
import { revealTopbarItem, SETTINGS_CHIP } from "./lib/topbar.mjs";

const SHOT = process.env.CHATTITLE_SHOT ?? "";
const AXE = process.env.PI_AXE_JS ?? join(userInfo().homedir, "temper-ai/configs/design/bin/vendor/axe-4.13.0.min.js");
let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✓" : "✗ FAIL:"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures += 1;
}
if (!existsSync(AXE)) {
	console.log(`✗ FAIL: axe-core not found at ${AXE} (set PI_AXE_JS)`);
	process.exit(1);
}

const ALPHA = "Alpha notes";
const BETA = "Queue #644: Make the queue's task list load fast and keep every row where it was";
const RENAMED = `Alpha notes, renamed: ${"a name long enough to run past the edge of any screen ".repeat(4).trim()}`;
const HEADER_MAX = 30; // px: the header's 6 px top padding plus one 21 px line, and a little slack

/** Name a made-up chat the way pi's /name does: a session_info entry (SessionManager.appendSessionInfo). */
function nameChat(file, name) {
	const last = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1));
	const timestamp = new Date(Date.parse(last.timestamp) + 1000).toISOString();
	appendFileSync(
		file,
		`${JSON.stringify({ type: "session_info", id: `n${last.id}`, parentId: last.id, timestamp, name })}\n`,
	);
}

// The chats, and an empty identities folder (no role leads: the left bar shows Recent chats and History).
const sessionsDir = mkdtempSync(join(tmpdir(), "chat-title-sessions-"));
const idDir = mkdtempSync(join(tmpdir(), "chat-title-identities-"));
process.on("exit", () => {
	for (const d of [sessionsDir, idDir]) rmSync(d, { recursive: true, force: true });
});

/** The middle pane's header (its title, if any, and how it sits) and the left bar's current rows' names. */
const look = (page) =>
	page.evaluate(() => {
		const ownText = (el) =>
			[...el.childNodes]
				.filter((n) => n.nodeType === Node.TEXT_NODE)
				.map((n) => n.textContent)
				.join("")
				.trim();
		const header = document.querySelector(".chat-header");
		const h = document.querySelector(".chat-header .chat-header-title");
		const cs = h ? getComputedStyle(h) : null;
		const box = h?.getBoundingClientRect();
		return {
			rows: [...document.querySelectorAll(".panel-left .session-item.active .session-title")].map(ownText),
			header: !!header,
			headerRole: header?.getAttribute("role") ?? null,
			headerHeight: header ? Math.round(header.getBoundingClientRect().height) : 0,
			title: h ? h.textContent : null,
			tip: h?.getAttribute("title") ?? null,
			tag: h?.tagName ?? null,
			inToolbar: !!h?.closest('[role="toolbar"]'),
			oneLine:
				!!cs &&
				cs.whiteSpace === "nowrap" &&
				cs.textOverflow === "ellipsis" &&
				box.height <= parseFloat(cs.lineHeight) + 1,
			cut: !!h && h.scrollWidth > h.clientWidth,
			left: box ? Math.round(box.left) : null,
			right: box ? Math.round(box.right) : null,
		};
	});
/** Look again until `ok`, for up to `ms`; the last look either way. */
async function until(page, ok, ms = 20_000) {
	const t0 = Date.now();
	let v = await look(page);
	while (!ok(v) && Date.now() - t0 < ms) {
		await sleep(100);
		v = await look(page);
	}
	return v;
}
/** The title is `want`, and so is every current row in the left bar (there is at least one). */
const titled = (want) => (v) => v.title === want && v.rows.length > 0 && v.rows.every((r) => r === want);
const untitled = (v) => v.title === null;

/** axe on `sel` (every rule): its serious and critical hits, as "rule: target". */
async function axeHits(page, sel) {
	if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ path: AXE });
	return page.evaluate(async (sel) => {
		const root = document.querySelector(sel);
		if (!root) return ["(nothing to scan: no " + sel + ")"];
		const res = await window.axe.run(root, { resultTypes: ["violations"] });
		return res.violations
			.filter((v) => v.impact === "serious" || v.impact === "critical")
			.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`));
	}, sel);
}
async function shot(page, name) {
	if (SHOT) await page.screenshot({ path: `${SHOT}-${name}.png` });
}
async function context(browser, phone = false) {
	return browser.newContext(
		phone
			? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }
			: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
	);
}
async function openPage(ctx) {
	const page = await ctx.newPage();
	page.on("pageerror", (e) => pageErrors.push(String(e)));
	await page.goto(srv.http);
	await page.waitForSelector(".topbar", { timeout: 60_000 });
	await page.locator(".inputbox textarea").waitFor({ timeout: 20_000 });
	return page;
}
/** Settings > Interface layout, Chat header's Chat title row: its show box, clicked; the settings closed again. */
async function toggleTitleInLayout(page) {
	if ((await page.locator(".settings-modal").count()) === 0)
		await (await revealTopbarItem(page, SETTINGS_CHIP)).click();
	await page
		.locator(".settings-tab", { hasText: /Interface layout/ })
		.first()
		.click();
	const row = page
		.locator(".set-ui-slot", { hasText: "Chat header" })
		.first()
		.locator(".set-row", { hasText: "Chat title" })
		.first();
	const box = row.locator('input[type="checkbox"]').first();
	await box.waitFor({ timeout: 15_000 });
	const was = await box.isChecked();
	await box.click();
	await page.locator(".settings-modal .modal-close").first().click();
	await page.locator(".settings-modal").waitFor({ state: "detached", timeout: 10_000 });
	return was;
}

const pageErrors = [];
let browser = null;
const srv = await ownServer({
	name: "chat-title",
	env: { PI_CODING_AGENT_SESSION_DIR: sessionsDir, PI_IDENTITY_DIR: idDir, PI_IDENTITY_REINDEX: "0" },
	prepare: async ({ workdir }) => {
		nameChat(seedChat(sessionsDir, workdir, { id: "01a0f000-0000-7000-8000-00000000c001", exchanges: 2 }).file, ALPHA);
		nameChat(seedChat(sessionsDir, workdir, { id: "01a0f000-0000-7000-8000-00000000c002", exchanges: 2 }).file, BETA);
	},
});
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const desk = await context(browser);
	const page = await openPage(desk);
	const history = (name) => page.locator(".panel-left .panel-sessions .session-item", { hasText: name }).first();

	// ---- 1. a blank new chat ------------------------------------------------------------------------------
	await history(ALPHA).waitFor({ timeout: 30_000 });
	let v = await look(page);
	check("a blank new chat has no title and no header bar", untitled(v) && !v.header, JSON.stringify(v));

	// ---- 2. a chat opened from History ------------------------------------------------------------------
	await history(ALPHA).click();
	v = await until(page, titled(ALPHA));
	check("a chat opened from History: its left-bar row's name is the title", titled(ALPHA)(v), JSON.stringify(v));
	check(
		"the title is a heading outside the header's toolbars, and the header itself is no toolbar",
		v.tag === "H1" && !v.inToolbar && v.headerRole === null,
		JSON.stringify(v),
	);
	check("on one line, its tooltip the full title", v.oneLine && v.tip === ALPHA, JSON.stringify(v));
	check("the header is one line tall", v.headerHeight > 0 && v.headerHeight <= HEADER_MAX, JSON.stringify(v));
	await shot(page, "desktop-opened");

	// ---- 3. renamed from the left bar ---------------------------------------------------------------------
	await page.locator(".panel-left .panel-convs .session-item.active").first().click({ button: "right" });
	await page.locator('.ctx-menu .ctx-menu-item[aria-label="Rename this chat"]').first().click();
	const rename = page.locator(".panel-left input.session-rename-input").first();
	await rename.waitFor({ timeout: 5000 });
	await rename.fill(RENAMED);
	await rename.press("Enter");
	v = await until(page, titled(RENAMED));
	check("renamed in the left bar: the title follows", titled(RENAMED)(v), JSON.stringify(v));
	check(
		"a long title ends in an ellipsis on one line, its tooltip the full title",
		v.oneLine && v.cut && v.tip === RENAMED,
		JSON.stringify(v),
	);
	check("the header stays one line tall", v.headerHeight <= HEADER_MAX, JSON.stringify(v));
	await shot(page, "desktop-renamed");

	// ---- 4. switched to the other chat and back -----------------------------------------------------------
	await history(BETA).click();
	v = await until(page, titled(BETA));
	check("switched to the other chat: the title follows", titled(BETA)(v), JSON.stringify(v));
	await page.locator(".panel-left .panel-convs .session-item", { hasText: "Alpha notes, renamed" }).first().click();
	v = await until(page, titled(RENAMED));
	check("switched back: the title follows again", titled(RENAMED)(v), JSON.stringify(v));

	// ---- 5. axe -------------------------------------------------------------------------------------------
	let hits = await axeHits(page, ".chat-header");
	check("axe: no serious or critical hits in the header", hits.length === 0, hits.join(" | "));

	// ---- 6. hidden and shown in Settings > Interface layout ------------------------------------------------
	const wasShown = await toggleTitleInLayout(page);
	v = await until(page, untitled);
	check(
		"Chat title is under Chat header in Settings > Interface layout, shown by default; hidden there: no title",
		wasShown && untitled(v) && !v.header,
		JSON.stringify({ wasShown, ...v }),
	);
	await toggleTitleInLayout(page);
	v = await until(page, titled(RENAMED));
	check("shown there again: the title is back", titled(RENAMED)(v), JSON.stringify(v));

	// ---- 7. New chat --------------------------------------------------------------------------------------
	await page.locator(".panel-left .lp-new-chat-action").first().click();
	v = await until(page, (v) => untitled(v) && !v.header);
	check("New chat: no title and no header bar", untitled(v) && !v.header, JSON.stringify(v));
	await desk.close();

	// ---- 8. phone -----------------------------------------------------------------------------------------
	const phone = await context(browser, true);
	const mobile = await openPage(phone);
	await mobile.locator(".topbar button.panel-toggle").first().click();
	await mobile.locator(".panel-drawer.drawer-left.open .panel-left").waitFor({ timeout: 10_000 });
	await mobile.locator(".panel-drawer.drawer-left .panel-left .session-item", { hasText: BETA }).first().click();
	v = await until(mobile, titled(BETA));
	check("phone: the chat picked in the drawer: its row's name is the title", titled(BETA)(v), JSON.stringify(v));
	check(
		"phone: on one line, ending in an ellipsis, inside the screen",
		v.oneLine && v.cut && v.left >= 0 && v.right <= 390,
		JSON.stringify(v),
	);
	check("phone: the header is one line tall", v.headerHeight > 0 && v.headerHeight <= HEADER_MAX, JSON.stringify(v));
	hits = await axeHits(mobile, ".chat-header");
	check("phone: axe finds no serious or critical hits in the header", hits.length === 0, hits.join(" | "));
	await shot(mobile, "phone");
	await phone.close();

	check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (err) {
	check("the test ran to the end", false, err?.stack ?? String(err));
} finally {
	await browser?.close().catch(() => {});
	await srv.stop();
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
