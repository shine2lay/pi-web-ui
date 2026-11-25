/* waiting-questions bell (Ops #1090): the top bar's bell, its list and answering in place, on screen.
 *
 * 1. The real app on its own sealed server (tests/lib/own-server.mjs; a stand-in model asks one question in each of
 *    two chats): ui-check (320/390/1440, light + dark) on the app with the bell showing its count.
 * 2. The bell's list and Answer form as fixed cases (tests/waiting-questions-bell-harness.tsx, never in the app
 *    bundle): ui-check on each of list / empty / answer.
 * 3. The real app at 320x568, 390x844 and 1440x900 in light and dark: the bell is on the bar (not folded into ⋯) with
 *    "2"; it opens the list (2 items, nothing wider than the screen); Answer opens the form in place. Then, once:
 *    an answer from the bell leaves 1 waiting, Open chat switches to the asking chat with its question shown, and
 *    Cancel question empties the bell. @2x screenshots of each view.
 * 4. QA #244 (Ops #1091): the fixed Answer case shows the real form (F5); WebKit at the same sizes keeps the bell on
 *    the bar outside ⋯ (F3); with one question saved for later in chat A and chat B's live, Open chat on the saved
 *    one shows it and Later shows chat A's saved-for-later bar, in Chromium and WebKit (F2, QA's B7).
 *
 * Usage: npm run build && scripts/sealed.sh node tests/waiting-questions-bell-ui-test.mjs [out-dir]
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, webkit } from "playwright-core";
import WebSocket from "ws";
import { CHROME_PATH, WEBKIT_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT = process.argv[2] ?? "/tmp/waiting-questions-bell-ui";
const VIEWPORTS = [
	{ width: 320, height: 568 },
	{ width: 390, height: 844 },
	{ width: 1440, height: 900 },
];
mkdirSync(OUT, { recursive: true });
let failed = 0;
const rows = [];
function check(name, ok, detail = "") {
	rows.push({ name, ok, detail });
	console.log(`${ok ? "✓" : "✗ FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
	if (!ok) failed++;
}

const QUESTIONS = {
	port: {
		id: "port",
		question: "Which port should the preview server use?",
		options: [{ label: "8080" }, { label: "3000" }],
	},
	release: {
		id: "when",
		question: "Release the installer tonight or Monday?",
		options: [{ label: "Tonight" }, { label: "Monday" }],
	},
};
function mockReply({ lastUser, toolResult, sideRequest }) {
	if (sideRequest) return "Title";
	if (toolResult) return "POSTED";
	const m = /BELL-ASK (\w+)/.exec(lastUser ?? "");
	if (!m) return "ok";
	return { tool: "ask_user_question", args: { questions: [QUESTIONS[m[1]]] } };
}

async function until(fn, ms = 20000) {
	const t0 = Date.now();
	let v = await fn();
	while (!v && Date.now() - t0 < ms) {
		await sleep(100);
		v = await fn();
	}
	return v;
}

/** The waiting questions' card ids by their text, as the asking windows were told (`question_pending`). */
const asked = new Map();

/** Two chats, each with one question waiting (the stand-in model asks it), each in a window of its own that stays
 *  open (a chat its last window leaves closes, and its cards with it); returns the windows, closed at the end. */
async function askTwo(srv) {
	const windows = [];
	const store = join(srv.dataDir, "pending-questions.json");
	const records = () => (existsSync(store) ? (JSON.parse(readFileSync(store, "utf8")).records ?? []) : []);
	for (const [i, word] of ["release", "port"].entries()) {
		const ws = new WebSocket(srv.ws, { headers: { origin: `http://localhost:${srv.port}` } });
		await new Promise((ok, bad) => {
			ws.once("open", ok);
			ws.once("error", bad);
		});
		const send = (m) => ws.send(JSON.stringify(m));
		ws.on("message", (data) => {
			const m = JSON.parse(String(data));
			if (m.type === "question_pending") asked.set(m.questions[0]?.question, m.id);
		});
		send({ type: "hello", clientId: `bell-ui-${word}`, locale: "en" });
		await sleep(1000);
		send({ type: "set_model", modelId: "mock/mock-model" });
		await sleep(500);
		send({ type: "new_chat" });
		await sleep(400);
		send({ type: "prompt", text: `BELL-ASK ${word}` });
		await until(() => records().length > i);
		windows.push(ws);
	}
	const found = records().length;
	if (found !== 2) throw new Error(`expected 2 waiting questions, found ${found}`);
	await until(() => asked.size === 2, 5000);
	return windows;
}

function uiCheck(url, outDir) {
	return new Promise((done) =>
		execFile(
			"ui-check",
			[url, "--out-dir", outDir, "--json"],
			// ui-check's Python Playwright lives in the user's own site-packages, which the sealed temp HOME hides.
			{
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
				env: { ...process.env, PYTHONUSERBASE: `${userInfo().homedir}/.local` },
			},
			(error, stdout, stderr) => {
				const status = error ? (error.code ?? 1) : 0;
				writeFileSync(`${outDir}.json`, stdout || stderr);
				done(status);
			},
		),
	);
}

async function harness() {
	const result = await build({
		absWorkingDir: ROOT,
		entryPoints: ["tests/waiting-questions-bell-harness.tsx"],
		bundle: true,
		write: false,
		outdir: "/harness",
		format: "iife",
		platform: "browser",
		jsx: "automatic",
		loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl", ".svg": "dataurl", ".png": "dataurl" },
		define: { "process.env.NODE_ENV": '"production"' },
		logLevel: "error",
	});
	const js = result.outputFiles.find((f) => f.path.endsWith(".js")).text;
	const css = result.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
	const light = readFileSync(join(ROOT, "themes/white.css"), "utf8");
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Questions</title><link rel="stylesheet" href="app.css"><style>@media (prefers-color-scheme: light) { ${light} }</style></head><body><script src="app.js"></script></body></html>`;
	const server = createServer((req, res) => {
		const path = new URL(req.url ?? "/", "http://x").pathname;
		const [type, body] =
			path === "/app.js" ? ["text/javascript", js] : path === "/app.css" ? ["text/css", css] : ["text/html", html];
		res.setHeader("Content-Type", type);
		res.end(body);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

/** The bell's place and the list's fit, measured in the page. */
async function measure(page) {
	return page.evaluate(() => {
		const r = (el) => el?.getBoundingClientRect().toJSON() ?? null;
		const bell = document.querySelector(".topbar .bell-chip");
		const modal = document.querySelector("dialog.wq-modal[open]");
		const wide = modal
			? [...modal.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5)
					.length
			: 0;
		return {
			bell: r(bell),
			badge: bell?.querySelector(".bell-badge")?.textContent ?? null,
			label: bell?.getAttribute("aria-label") ?? null,
			modal: r(modal),
			items: modal ? modal.querySelectorAll(".wq-item").length : 0,
			wide,
		};
	});
}

/** The bar's flow as laid out: its width, gap, each entry's width and left edge, and whether the bell is on it. */
async function barFit(page) {
	return page.evaluate(() => {
		const flow = document.querySelector(".topbar .topbar-flow");
		const kids = [...(flow?.children ?? [])].map((el) => [
			el.className.toString().split(" ")[0],
			el.offsetWidth,
			Math.round(el.getBoundingClientRect().left),
		]);
		const more = document.querySelector(".topbar .plugin-topbar-more")?.getBoundingClientRect();
		return {
			flowWidth: flow?.clientWidth,
			gap: flow ? getComputedStyle(flow).columnGap : null,
			kids,
			moreLeft: more ? Math.round(more.left) : null,
			bellOnBar: !!flow?.querySelector(".bell-chip .bell-badge"),
			scrollWidth: document.documentElement.scrollWidth,
		};
	});
}

/** F3: in WebKit, at every size and theme, the bell with its count is on the bar (not folded into ⋯). */
async function webkitBar(browser, url) {
	for (const viewport of VIEWPORTS) {
		for (const colorScheme of ["light", "dark"]) {
			const tag = `webkit-${viewport.width}x${viewport.height}-${colorScheme}`;
			const page = await browser.newPage({ viewport, colorScheme, deviceScaleFactor: 2 });
			if (colorScheme === "light")
				await page.addInitScript(() => localStorage.setItem("pi-web-ui:theme", "flow-light"));
			await page.goto(url);
			await page.waitForSelector(".topbar .topbar-flow", { timeout: 20000 });
			await until(async () => (await barFit(page)).bellOnBar, 5000);
			await sleep(300);
			const fit = await barFit(page);
			const bar = await measure(page);
			await page.screenshot({ path: join(OUT, `bar-${tag}@2x.png`) });
			check(
				`${tag} bell on the bar outside ⋯ with its count`,
				fit.bellOnBar && bar.badge === "2" && bar.bell.right <= viewport.width && fit.scrollWidth <= viewport.width,
				JSON.stringify(fit),
			);
			await page.close();
		}
	}
}

/** QA's B10 path: narrowing below 320 folds the bell into ⋯; widening back to 320 re-fits it with its real width. */
async function narrowAndBack(browser, engine, url) {
	const page = await browser.newPage({ viewport: VIEWPORTS[1], deviceScaleFactor: 2 });
	await page.goto(url);
	await until(async () => (await barFit(page)).bellOnBar, 20000);
	for (const width of [256, 291, 320]) {
		await page.setViewportSize({ width, height: 568 });
		await sleep(400);
	}
	const fit = await barFit(page);
	await page.screenshot({ path: join(OUT, `bar-${engine}-320-after-256@2x.png`) });
	check(`${engine} 256 -> 291 -> 320: bell back on the bar outside ⋯`, fit.bellOnBar, JSON.stringify(fit));
	await page.close();
}

/** F2 (QA's B7): the window's own chat B shows its live question; Open chat on chat A's saved one shows that one, and
 *  Later folds it into chat A's saved-for-later bar (not chat B's question over it). */
async function openChatOnSaved(browser, engine, url) {
	const page = await browser.newPage({ viewport: VIEWPORTS[2], deviceScaleFactor: 2 });
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await page.goto(url);
	await page.waitForSelector(".topbar .bell-chip .bell-badge", { timeout: 20000 });
	await page.click(".topbar .bell-chip");
	const saved = page.locator("dialog.wq-modal .wq-item", { hasText: "Release the installer" });
	await saved.getByRole("button", { name: "Open chat" }).click();
	const card = () =>
		page
			.locator(".dialog-inline")
			.innerText({ timeout: 500 })
			.catch(() => "");
	const shown = await until(async () => (await card()).includes("Release the installer"), 10000);
	await sleep(300);
	await page.screenshot({ path: join(OUT, `open-saved-${engine}-1440x900@2x.png`) });
	check(
		`${engine} B7 Open chat on a saved question shows that question, not another chat's live one`,
		!!shown && !(await page.$("dialog.wq-modal[open]")),
		(await card()).replace(/\s+/g, " ").slice(0, 120),
	);
	const savedCard = page.locator(".dialog-inline", { hasText: "Release the installer" });
	await savedCard.locator(".dialog-later").click();
	const barText = () =>
		page
			.locator(".question-later-bar")
			.evaluate((el) => el.textContent ?? "", null, { timeout: 500 })
			.catch(() => "");
	const bar = await until(async () => (await barText()).includes("Release the installer"), 5000);
	await page.screenshot({ path: join(OUT, `open-saved-later-${engine}-1440x900@2x.png`) });
	check(`${engine} B7 Later shows the asking chat's saved-for-later bar`, !!bar, (await barText()).slice(0, 120));
	check(`${engine} B7 no page errors`, errors.length === 0, errors.join(" | "));
	await page.close();
}

/** F5: the fixed Answer case shows the real form (its options), never the "cannot be shown safely" line. */
async function fixedAnswerForm(browser, url) {
	const page = await browser.newPage({ viewport: VIEWPORTS[0] });
	await page.goto(`${url}?state=answer`);
	const options = await until(
		async () => (await page.$$("dialog.roles-answer[open] .roles-answer-option")).length,
		10000,
	);
	const text = await page.evaluate(() => document.body.innerText);
	check(
		"fixed case answer shows the real Answer form",
		options >= 2 && !text.includes("cannot be shown safely"),
		JSON.stringify({ options, refused: text.includes("cannot be shown safely") }),
	);
	await page.close();
}

const srv = await ownServer({ name: "waiting-questions-bell-ui", mock: mockReply });
const fixed = await harness();
let chatWindows = [];
try {
	chatWindows = await askTwo(srv);
	const url = `http://127.0.0.1:${srv.port}/`;
	check("ui-check, the app with the bell's count", (await uiCheck(url, join(OUT, "ui-check-app"))) === 0);
	for (const state of ["list", "empty", "answer"])
		check(
			`ui-check, bell list fixed case ${state}`,
			(await uiCheck(`${fixed.url}?state=${state}`, join(OUT, `ui-check-${state}`))) === 0,
		);

	const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	try {
		await fixedAnswerForm(browser, fixed.url);
		for (const viewport of VIEWPORTS) {
			for (const colorScheme of ["light", "dark"]) {
				const tag = `${viewport.width}x${viewport.height}-${colorScheme}`;
				const page = await browser.newPage({ viewport, colorScheme, deviceScaleFactor: 2 });
				const errors = [];
				page.on("pageerror", (e) => errors.push(String(e)));
				if (colorScheme === "light")
					await page.addInitScript(() => localStorage.setItem("pi-web-ui:theme", "flow-light"));
				await page.goto(url);
				await page.waitForSelector(".topbar .bell-chip .bell-badge", { timeout: 20000 });
				await sleep(300);
				const bar = await measure(page);
				await page.screenshot({ path: join(OUT, `bar-${tag}@2x.png`) });
				const onBar = !!bar.bell && bar.bell.width > 0 && bar.bell.right <= viewport.width && bar.bell.top >= 0;
				check(
					`${tag} bell on the bar with its count`,
					onBar && bar.badge === "2" && bar.label === "2 questions waiting for you",
					JSON.stringify({ badge: bar.badge, label: bar.label, right: bar.bell?.right }),
				);
				await page.click(".topbar .bell-chip");
				await page.waitForSelector("dialog.wq-modal[open] .wq-item", { timeout: 10000 });
				await sleep(200);
				const list = await measure(page);
				await page.screenshot({ path: join(OUT, `list-${tag}@2x.png`) });
				check(
					`${tag} list shows both, nothing wider than the screen`,
					list.items === 2 && list.wide === 0 && list.modal.right <= viewport.width,
					JSON.stringify({ items: list.items, wide: list.wide }),
				);
				await page.click("dialog.wq-modal .wq-answer");
				await page.waitForSelector("dialog.roles-answer[open] .roles-answer-option", { timeout: 10000 });
				await sleep(200);
				await page.screenshot({ path: join(OUT, `answer-${tag}@2x.png`) });
				const form = await page.evaluate(() =>
					document.querySelector("dialog.roles-answer[open]")?.getBoundingClientRect().toJSON(),
				);
				check(
					`${tag} Answer opens the form in place`,
					!!form && form.right <= viewport.width && form.bottom <= viewport.height + 0.5,
				);
				check(`${tag} no page errors`, errors.length === 0, errors.join(" | "));
				await page.close();
			}
		}

		// WebKit's bar (F3); then chat A's question saved for later, chat B's live: Open chat in both engines (F2).
		if (!WEBKIT_PATH) check("WebKit installed", false, "no webkit-*/pw_run.sh in the playwright cache");
		const safari = WEBKIT_PATH ? await webkit.launch({ executablePath: WEBKIT_PATH, headless: true }) : null;
		try {
			if (safari) await webkitBar(safari, url);
			await narrowAndBack(browser, "chromium", url);
			if (safari) await narrowAndBack(safari, "webkit", url);
			const releaseId = asked.get(QUESTIONS.release.question);
			chatWindows[0].send(JSON.stringify({ type: "question_later", id: releaseId, later: true }));
			const store = join(srv.dataDir, "pending-questions.json");
			const tucked = await until(
				() => (JSON.parse(readFileSync(store, "utf8")).records ?? []).some((r) => r.later === true),
				5000,
			);
			check("chat A's question saved for later", !!tucked && !!releaseId, String(releaseId));
			await openChatOnSaved(browser, "chromium", url);
			if (safari) await openChatOnSaved(safari, "webkit", url);
		} finally {
			await safari?.close();
		}

		// Once, at 390x844 light: answer from the bell, Open chat, Cancel question.
		const page = await browser.newPage({ viewport: VIEWPORTS[1], deviceScaleFactor: 2 });
		await page.addInitScript(() => localStorage.setItem("pi-web-ui:theme", "flow-light"));
		await page.goto(url);
		await page.waitForSelector(".topbar .bell-chip .bell-badge", { timeout: 20000 });
		await page.click(".topbar .bell-chip");
		await page.waitForSelector("dialog.wq-modal[open] .wq-item");
		await page.click("dialog.wq-modal .wq-item:nth-child(1) .wq-answer");
		await page.waitForSelector("dialog.roles-answer[open] .roles-answer-option");
		await page.click("dialog.roles-answer[open] .roles-answer-option >> nth=0");
		await page.click("dialog.roles-answer[open] .roles-answer-send");
		const one = await until(async () => (await measure(page)).badge === "1", 15000);
		await sleep(300);
		await page.screenshot({ path: join(OUT, "answered-390x844-light@2x.png") });
		check("answer from the bell leaves 1 waiting", !!one, JSON.stringify(await measure(page)));
		await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");
		await until(
			async () => !(await page.$("dialog.wq-modal[open]")) && !(await page.$("dialog.roles-answer[open]")),
			5000,
		);
		if (!(await page.$("dialog.wq-modal[open]"))) await page.click(".topbar .bell-chip");
		await page.waitForSelector("dialog.wq-modal[open] .wq-item");
		const leftChat = await page.evaluate(() => document.querySelector(".wq-item .wq-who")?.textContent ?? "");
		await page.click("dialog.wq-modal .wq-item:nth-child(1) >> text=Open chat");
		const shown = await until(
			() => page.$(".dialog-inline .question-option, .question-later-answer, .chat-owner-question"),
			10000,
		);
		await sleep(400);
		await page.screenshot({ path: join(OUT, "open-chat-390x844-light@2x.png") });
		check(
			"Open chat closes the list and shows the asking chat's question",
			!!shown && !(await page.$("dialog.wq-modal[open]")),
			leftChat,
		);
		await page.click(".topbar .bell-chip");
		await page.waitForSelector("dialog.wq-modal[open] .wq-cancel");
		await page.click("dialog.wq-modal .wq-cancel");
		const empty = await until(() => page.$("dialog.wq-modal[open] .wq-empty"), 10000);
		await until(async () => (await measure(page)).badge === null, 10000);
		const after = await measure(page);
		await page.screenshot({ path: join(OUT, "cancelled-390x844-light@2x.png") });
		check(
			"Cancel question empties the bell",
			!!empty && after.badge === null && after.label === "No questions waiting",
			JSON.stringify(after),
		);
		const store = JSON.parse(readFileSync(join(srv.dataDir, "pending-questions.json"), "utf8")).records ?? [];
		check(
			"no question left waiting on disk",
			store.every((r) => r.state !== "waiting"),
			JSON.stringify(store.map((r) => r.state)),
		);
		await page.close();
	} finally {
		await browser.close();
	}
} catch (e) {
	failed++;
	console.log(`✗ FAIL ${String(e?.stack ?? e)}`);
} finally {
	writeFileSync(join(OUT, "bell-ui.json"), `${JSON.stringify(rows, null, 2)}\n`);
	fixed.close();
	for (const ws of chatWindows) ws.close();
	await srv.stop();
}
console.log(failed ? `✗ ${failed} check(s) failed` : "✓ waiting-questions-bell-ui: all checks passed");
process.exit(failed ? 1 : 0);
