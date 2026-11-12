/* Reconnecting note E2E (frontend #271): the app shell's "Reconnecting…" note stays in the status bar's
 * band (over the bar's left group), so it never lands on a page's title, the top bar, a page's controls
 * or the bar's workspace button, and showing it never moves anything.
 *
 * A note that only shows while a connection is lost is invisible to a steady-state screen check, so this
 * test forces the state: once the page is up, every socket is closed and each new one goes to a dead
 * port, so the app stays "Reconnecting…". Then, at 320/390/1440 on the Memory page, the Roles page and
 * the chat, it measures the note against the page's h1 title, the top bar, the status bar and the bar's
 * right group, and the title's and the bar's positions with the note against their positions without it.
 *
 * Non-vacuous on every run: the same measurements first run with earlier placements planted back and
 * must catch them: the old fixed top: 52px (on the phone's page titles) and a floating pill just above
 * the status bar (on the chat's composer).
 *
 * Run: npm run build && node tests/reconnecting-note-overlap-test.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 30000 + Math.floor(Math.random() * 10000);
const WIDTHS = [320, 390, 1440];
const VIEWS = [
	{ name: "memory", path: "/?view=openviking", title: ".ovk-status-title" },
	{ name: "roles", path: "/?view=roles", title: ".view-pane:not(.hidden) .brand-title" },
	{ name: "chat", path: "/", title: null },
];
const PILL = "padding:6px 14px!important;max-width:none!important;";
/** Placements this test exists to catch. */
const OLD_TOP = `.reconnecting-note{position:fixed!important;top:52px!important;bottom:auto!important;left:50%!important;transform:translateX(-50%)!important;${PILL}}`;
const FLOATING_ABOVE_BAR = `.reconnecting-note{top:auto!important;bottom:calc(100% + 8px)!important;left:50%!important;transform:translateX(-50%)!important;${PILL}}`;

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

if (!CHROME_PATH) {
	console.log("✗ no Chrome for the test (set PI_WEB_CHROME)");
	process.exit(1);
}

const base = mkdtempSync(join(tmpdir(), "piweb-reconnecting-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });
writeFileSync(join(workdir, "a.txt"), "a");

const server = spawn("node", ["dist/server/index.js"], {
	cwd: REPO_ROOT,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: workdir,
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: "ignore",
});
for (let i = 0; i < 80; i++) {
	try {
		if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) break;
	} catch {}
	await sleep(250);
}

/** In the page: where the note is and what it covers. */
function measure(titleSel) {
	const box = (el) => {
		if (!el) return null;
		const r = el.getBoundingClientRect();
		const s = getComputedStyle(el);
		if (r.width <= 0 || r.height <= 0 || s.display === "none" || s.visibility === "hidden") return null;
		return { x: r.left, y: r.top, r: r.right, b: r.bottom };
	};
	const area = (a, b) => {
		if (!a || !b) return 0;
		const w = Math.min(a.r, b.r) - Math.max(a.x, b.x);
		const h = Math.min(a.b, b.b) - Math.max(a.y, b.y);
		return w > 0.5 && h > 0.5 ? Math.round(w * h) : 0;
	};
	const round = (v) => (v == null ? null : Math.round(v * 10) / 10);
	const note = box(document.querySelector(".reconnecting-note"));
	const title = titleSel ? box(document.querySelector(titleSel)) : null;
	const bar = box(document.querySelector(".statusbar"));
	return {
		note,
		titleTop: round(title?.y),
		barTop: round(bar?.y),
		onTitle: area(note, title),
		onTopbar: area(note, box(document.querySelector(".topbar"))),
		onBarRight: area(note, box(document.querySelector(".statusbar-right"))),
		inBar:
			!!note &&
			!!bar &&
			note.x >= bar.x - 0.5 &&
			note.r <= bar.r + 0.5 &&
			note.y >= bar.y - 0.5 &&
			note.b <= bar.b + 0.5,
	};
}

const browser = await chromium.launch({ executablePath: CHROME_PATH });

for (const view of VIEWS) {
	const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
	await page.addInitScript(() => {
		const Native = window.WebSocket;
		window.__cut = false;
		window.__socks = [];
		window.WebSocket = class extends Native {
			constructor(url, ...rest) {
				// While cut, every new socket goes to a dead port: the app stays in its reconnecting state.
				super(window.__cut ? String(url).replace(/:(\d+)\//, ":1/") : url, ...rest);
				window.__socks.push(this);
			}
		};
	});
	await page.goto(`http://localhost:${PORT}${view.path}`);
	if (view.title) await page.waitForSelector(view.title, { timeout: 20000 });
	await sleep(2500);

	// The title's and the status bar's places before the note shows, at each width.
	const before = {};
	for (const w of WIDTHS) {
		await page.setViewportSize({ width: w, height: 844 });
		await sleep(250);
		before[w] = await page.evaluate(measure, view.title);
	}

	await page.evaluate(() => {
		window.__cut = true;
		for (const s of window.__socks) s.close();
	});
	const shown = await page
		.waitForFunction(() => document.querySelector(".reconnecting-note")?.getBoundingClientRect().height > 0, null, {
			timeout: 20000,
		})
		.then(() => true)
		.catch(() => false);
	check(`${view.name}: the forced lost connection shows "Reconnecting…"`, shown);
	if (!shown) {
		await page.close();
		continue;
	}

	// Controls: earlier placements planted back must be caught.
	const plant = async (css, label, caught) => {
		const tag = await page.addStyleTag({ content: css });
		for (const w of [320, 390]) {
			await page.setViewportSize({ width: w, height: 844 });
			await sleep(250);
			const m = await page.evaluate(measure, view.title);
			check(
				`${view.name} w=${w}: control — ${label} is caught`,
				caught(m),
				JSON.stringify({ onTitle: m.onTitle, inBar: m.inBar }),
			);
		}
		await tag.evaluate((el) => el.remove());
	};
	if (view.title) await plant(OLD_TOP, "the old top placement on the title", (m) => m.onTitle > 0);
	else await plant(FLOATING_ABOVE_BAR, "a pill floating above the bar (on the composer)", (m) => !m.inBar);

	for (const w of WIDTHS) {
		await page.setViewportSize({ width: w, height: 844 });
		await sleep(250);
		const m = await page.evaluate(measure, view.title);
		const where = m.note
			? `note ${Math.round(m.note.x)},${Math.round(m.note.y)}–${Math.round(m.note.r)},${Math.round(m.note.b)}`
			: "no note";
		check(`${view.name} w=${w}: note stays inside the status bar (covers no page content)`, m.inBar, where);
		check(
			`${view.name} w=${w}: note covers no title, top bar or workspace button`,
			m.onTitle === 0 && m.onTopbar === 0 && m.onBarRight === 0,
			`title ${m.onTitle}px², top bar ${m.onTopbar}px², bar right ${m.onBarRight}px²`,
		);
		check(
			`${view.name} w=${w}: the note moves nothing`,
			m.titleTop === before[w].titleTop && m.barTop === before[w].barTop,
			`title ${before[w].titleTop} → ${m.titleTop}, bar ${before[w].barTop} → ${m.barTop}`,
		);
	}
	await page.close();
}

await browser.close();
server.kill();
console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
