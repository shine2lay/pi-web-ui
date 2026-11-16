/* roles-by-project L-cases (spec-acceptance.md §L, spec-page.md §Live updates; frontend #293 seam, built by #294).
 * Real server and page; every roles payload the page sees is this test's (tests/unit/roles-by-project-page-data.ts):
 * the server's own roles messages are replaced on the wire and held, so an update arrives only when the test sends
 * one (deterministic, never reruns). Starts with one happy-path journey (owner bp-be8d76b9: text, axe, 24 px
 * targets, both themes), then the contract points:
 *   L1 a payload mid-interaction keeps scroll, focus, search text + caret, open tiles, the answer dialog + choice;
 *   L2 a payload between mousedown and mouseup still opens the tile (Chromium and WebKit);
 *   L3 320/390/1440 px, light and dark: 0 horizontal overflow, 0 overlapping text, 0 console errors;
 *   P3-layout: Needs you shows its first row (3 cards at 1440 px, 1 at 390 px), then "Show N more".
 * Until #294 mounts the page, it prints "roles-by-project: not built (Frontend #294 task)" and fails.
 * Run after build: scripts/sealed.sh node tests/roles-by-project-test.mjs
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { chromium, webkit } from "playwright-core";
import { tsImport } from "tsx/esm/api";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";
if (!process.env.PI_SEALED) throw new Error("Run with scripts/sealed.sh");
if (!CHROME_PATH) throw new Error("Chrome is required");

const NOT_BUILT = "roles-by-project: not built (Frontend #294 task)";
const data = await tsImport("./unit/roles-by-project-page-data.ts", import.meta.url);
const home = userInfo().homedir;
const AXE = process.env.PI_AXE_JS ?? join(home, "temper-ai/configs/design/bin/vendor/axe-4.13.0.min.js");
const WEBKIT = (() => {
	const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(home, ".cache", "ms-playwright");
	if (!existsSync(root)) return null;
	const dir = readdirSync(root).filter((d) => /^webkit-\d+$/.test(d)).sort((a, b) => Number(b.slice(7)) - Number(a.slice(7)))[0];
	return dir && existsSync(join(root, dir, "pw_run.sh")) ? join(root, dir, "pw_run.sh") : null;
})();
const VIEW = { roles: data.LABELS.roles, ink: data.LABELS.ink };
const FRESH = { label: "fresh-tag", title: "Fresh arrival" };
const ASK_VIEW = {
	id: "ask-frontend-294",
	revision: "c".repeat(64),
	kind: "stuck",
	title: "Pick the tile density?",
	fields: [{ id: "q1", text: "Pick the tile density?", options: [{ value: "Yes", label: "Yes" }, { value: "No", label: "No" }], multi: false, allowText: false }],
};

let failures = 0;
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` (${detail})`}`);
	if (!ok) failures++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let checkedAt = data.AT;
/** A roles message as the server sends it, carrying the given board. */
const rolesMessage = (tasks) => {
	checkedAt += 1000;
	const overview = data.overviewOf(data.boardOf(tasks), checkedAt);
	return JSON.stringify({ type: "roles", asks: overview.asks.length, checkedAt, overview });
};
/** The update every L case sends: the same board plus one queued backend task in a new last group. */
const freshTasks = (tasks) => [...tasks, data.boardTask("backend #4242", `tag:${FRESH.label}`, "queued", FRESH.title, { tags: [FRESH.label], queueIndex: 99 })];

const srv = await ownServer({ name: "roles-by-project", env: { PI_WEB_TOKEN: "", PI_IDENTITY_REINDEX: "0" } });
const hardStop = setTimeout(() => {
	console.error("FAIL bounded fixture timeout");
	process.exitCode = 1;
	void srv.stop();
}, 300000);
hardStop.unref();

/** A page whose roles feed is this test's: `send(tasks)` delivers one payload; the server's are dropped. */
async function openPage(browser, { width, height = 900, theme = "dark", tasks = data.scaleTasks() }) {
	const context = await browser.newContext({ viewport: { width, height }, locale: "en-US", timezoneId: "UTC" });
	await context.addInitScript((t) => {
		if (t === "light") localStorage.setItem("pi-web-ui:theme", "flow-light");
	}, theme);
	let socket = null;
	let firstSent = false;
	await context.routeWebSocket(/\/ws(\?|$)/, (ws) => {
		const server = ws.connectToServer();
		socket = ws;
		ws.onMessage((message) => {
			const text = typeof message === "string" ? message : "";
			if (text.startsWith('{"type":"roles_ask_open"')) {
				const { reqId } = JSON.parse(text);
				ws.send(JSON.stringify({ type: "roles_ask", reqId, ok: true, ask: ASK_VIEW }));
				return;
			}
			server.send(message);
		});
		server.onMessage((message) => {
			if (typeof message === "string" && message.startsWith('{"type":"roles"')) {
				if (!firstSent) ws.send(rolesMessage(tasks));
				firstSent = true;
				return;
			}
			ws.send(message);
		});
	});
	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(`pageerror ${e.message}`));
	page.on("console", (m) => m.type() === "error" && errors.push(`console ${m.text()}`));
	await page.goto(`${srv.http}/?view=roles`);
	const group = page.locator('[role="radiogroup"]').filter({ has: page.getByRole("radio", { name: "Project" }) });
	const built = await group.first().waitFor({ timeout: 20000 }).then(() => true, () => false);
	if (!built) {
		const shell = await page.evaluate(() => document.body.children.length > 0).catch(() => false);
		throw new Error(shell ? NOT_BUILT : "harness: the app shell did not load");
	}
	await page.getByRole("button", { name: new RegExp(VIEW.roles) }).first().waitFor({ timeout: 10000 });
	const send = async (next) => {
		if (!socket) throw new Error("harness: no socket");
		socket.send(rolesMessage(next));
		await page.getByText(FRESH.label, { exact: false }).first().waitFor({ timeout: 5000 });
	};
	return { context, page, errors, send };
}
const tile = (page, label) => page.locator("button[aria-expanded]").filter({ hasText: label }).first();
/** Every scrolled element (and the window) with its offset, by a stable path. */
const scrollState = (page) =>
	page.evaluate(() => {
		const path = (el) => {
			const parts = [];
			for (let e = el; e && e !== document.documentElement; e = e.parentElement) parts.unshift(`${e.tagName}:${[...(e.parentElement?.children ?? [])].indexOf(e)}`);
			return parts.join("/");
		};
		const out = { window: window.scrollY };
		for (const el of document.querySelectorAll("*")) if (el.scrollTop > 0) out[path(el)] = el.scrollTop;
		return out;
	});

async function journey(browser, theme) {
	const { context, page, errors } = await openPage(browser, { width: 1440, theme, tasks: data.liveTasks() });
	try {
		const body = await page.locator("body").innerText();
		check(`journey ${theme}: title, lede and As of`, /Roles/.test(body) && /5 things need you/.test(body) && /As of/.test(body));
		check(`journey ${theme}: Needs you · 5 and a tile per open group`, /Needs you · 5/.test(body) && [VIEW.roles, VIEW.ink, data.LABELS.smoke, data.LABELS.none].every((l) => body.includes(l)));
		await tile(page, VIEW.roles).click();
		check(`journey ${theme}: a tile opens (aria-expanded) and shows its map and Done when`, (await tile(page, VIEW.roles).getAttribute("aria-expanded")) === "true" && /Done when/.test(await page.locator("body").innerText()));
		const small = await page.evaluate(() =>
			[...document.querySelectorAll("button, [role=radio], input, a[href], summary")]
				.filter((e) => e.getClientRects().length && !e.closest("[hidden]"))
				.map((e) => [e.textContent?.trim().slice(0, 30) || e.getAttribute("aria-label"), e.getBoundingClientRect()])
				.filter(([, r]) => r.width < 24 || r.height < 24)
				.map(([n, r]) => `${n} ${Math.round(r.width)}x${Math.round(r.height)}`),
		);
		check(`journey ${theme}: every target at least 24 px`, small.length === 0, small.slice(0, 5).join(" | "));
		if (!existsSync(AXE)) check(`journey ${theme}: axe-core`, false, `axe-core not found at ${AXE}`);
		else {
			await page.addScriptTag({ path: AXE });
			const bad = await page.evaluate(async () => {
				const tags = { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] }, resultTypes: ["violations"] };
				const a = await window.axe.run(document, tags);
				const b = await window.axe.run(document, { runOnly: { type: "rule", values: ["label-content-name-mismatch"] } });
				return [...a.violations, ...b.violations].filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(", ")}`);
			});
			check(`journey ${theme}: axe-core, no serious or critical finding`, bad.length === 0, bad.join(" | "));
		}
		check(`journey ${theme}: no console or page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
	} finally {
		await context.close();
	}
}

async function l1(browser) {
	const tasks = data.scaleTasks();
	const a = await openPage(browser, { width: 1440, tasks });
	try {
		const { page } = a;
		await tile(page, VIEW.roles).click();
		await tile(page, VIEW.ink).click();
		const box = page.getByRole("searchbox", { name: "Find a task, project or role" });
		await box.fill("backend");
		await box.evaluate((el) => el.setSelectionRange(3, 3));
		await page.mouse.move(720, 700);
		await page.mouse.wheel(0, 600);
		await sleep(300);
		const before = await scrollState(page);
		check("L1 harness: the page scrolled before the update", Object.values(before).some((v) => v > 0), JSON.stringify(before));
		await a.send(freshTasks(tasks));
		const after = await scrollState(page);
		check("L1 scroll offset kept", JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
		const focus = await page.evaluate(() => ({ search: document.activeElement?.getAttribute("type") === "search" || document.activeElement?.getAttribute("role") === "searchbox", value: document.activeElement?.value, start: document.activeElement?.selectionStart, end: document.activeElement?.selectionEnd }));
		check("L1 search keeps focus, text and caret mid-word", focus.search && focus.value === "backend" && focus.start === 3 && focus.end === 3, JSON.stringify(focus));
		const open = [await tile(page, VIEW.roles).getAttribute("aria-expanded"), await tile(page, VIEW.ink).getAttribute("aria-expanded")];
		check("L1 both opened tiles stay aria-expanded=true", open.every((v) => v === "true"), open.join(","));
	} finally {
		await a.context.close();
	}
	const b = await openPage(browser, { width: 1440, tasks: data.liveTasks() });
	try {
		await tile(b.page, VIEW.ink).focus();
		await b.send(freshTasks(data.liveTasks()));
		const focused = await b.page.evaluate(() => [document.activeElement?.getAttribute("aria-expanded"), document.activeElement?.textContent ?? ""]);
		check("L1 a focused tile keeps keyboard focus", focused[0] !== null && focused[1].includes("Inkflow onboarding"), JSON.stringify(focused));
	} finally {
		await b.context.close();
	}
	const c = await openPage(browser, { width: 1440, tasks: data.liveTasks() });
	try {
		await c.page.getByRole("button", { name: "Answer", exact: true }).first().click();
		const dialog = c.page.locator("dialog[open]");
		await dialog.getByRole("radio", { name: "No" }).check();
		await c.send(freshTasks(data.liveTasks()));
		const state = await c.page.evaluate(() => ({ open: !!document.querySelector("dialog[open]"), picked: document.querySelector("dialog[open] input:checked")?.value ?? null }));
		check("L1 the answer dialog stays open with the picked choice", state.open && state.picked === "No", JSON.stringify(state));
	} finally {
		await c.context.close();
	}
}

async function l2(browser, name) {
	const { context, page, send, errors } = await openPage(browser, { width: 1440, tasks: data.liveTasks() });
	try {
		const target = tile(page, VIEW.ink);
		const r = await target.boundingBox();
		if (!r) throw new Error("harness: no tile box");
		await page.mouse.move(r.x + r.width / 2, r.y + Math.min(r.height / 2, 20));
		await page.mouse.down();
		await send(freshTasks(data.liveTasks()));
		await page.mouse.up();
		await sleep(200);
		check(`L2 ${name}: a payload between mousedown and mouseup still opens the tile`, (await target.getAttribute("aria-expanded")) === "true");
		check(`L2 ${name}: no page errors`, errors.filter((e) => e.startsWith("pageerror")).length === 0, errors.join(" | "));
	} finally {
		await context.close();
	}
}

async function l3(browser) {
	for (const width of [320, 390, 1440])
		for (const theme of ["light", "dark"]) {
			const { context, page, errors } = await openPage(browser, { width, theme });
			try {
				await tile(page, VIEW.roles).click();
				const r = await page.evaluate(() => {
					const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
					const boxes = [];
					for (const el of document.querySelectorAll("body *")) {
						if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
						const s = getComputedStyle(el);
						if (s.visibility === "hidden" || s.display === "none" || el.closest("[hidden], [aria-hidden=true]")) continue;
						const b = el.getBoundingClientRect();
						if (b.width && b.height) boxes.push([el, b]);
					}
					const hits = [];
					for (let i = 0; i < boxes.length; i++)
						for (let j = i + 1; j < boxes.length; j++) {
							const [ea, a] = boxes[i];
							const [eb, b] = boxes[j];
							if (ea.contains(eb) || eb.contains(ea)) continue;
							const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
							const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
							if (w > 1 && h > 1) hits.push(`${ea.textContent.trim().slice(0, 20)} / ${eb.textContent.trim().slice(0, 20)}`);
						}
					return { overflow, hits };
				});
				const tag = `L3 ${width}px ${theme}`;
				check(`${tag}: 0 horizontal overflow`, r.overflow <= 0, `${r.overflow}px`);
				check(`${tag}: 0 overlapping text`, r.hits.length === 0, r.hits.slice(0, 3).join(" | "));
				check(`${tag}: 0 console errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
				if (width === 390 || width === 1440) {
					const shown = await page.getByRole("button", { name: "Answer", exact: true }).filter({ visible: true }).count();
					const want = width === 1440 ? [3, "Show 2 more"] : [1, "Show 4 more"];
					const more = await page.getByRole("button", { name: want[1] }).count();
					check(`P3-layout ${tag}: Needs you shows ${want[0]} cards and "${want[1]}"`, shown === want[0] && more === 1, `${shown} shown`);
				}
			} finally {
				await context.close();
			}
		}
}

let chrome, safari;
try {
	chrome = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	await journey(chrome, "dark");
	await journey(chrome, "light");
	await l1(chrome);
	await l2(chrome, "Chromium");
	if (!WEBKIT) check("L2 WebKit: browser installed", false, "no webkit-*/pw_run.sh in the playwright cache");
	else {
		safari = await webkit.launch({ executablePath: WEBKIT, headless: true });
		await l2(safari, "WebKit");
	}
	await l3(chrome);
} catch (error) {
	console.error(`FAIL ${error instanceof Error ? error.message : "fixture error"}`);
	failures++;
} finally {
	clearTimeout(hardStop);
	await chrome?.close().catch(() => {});
	await safari?.close().catch(() => {});
	await srv.stop();
}
console.log(failures ? `roles-by-project: ${failures} failed` : "roles-by-project: all passed");
process.exitCode = failures ? 1 : 0;
