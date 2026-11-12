/* Status bar overlap E2E (frontend #276, QA rm-1c193552): the app's bottom `.statusbar` must never
 * cover the Memory page's text or controls.
 *
 * QA found the dashboard's content running under the bar (45px): at 390x844 the "Live Activity" and
 * "Memory Explorer" tabs sat behind it, at 320x568 the "Context & Token Injection" title and its hint.
 * The cause is the pane, not the bar: `.ovk-dashboard` was a plain flex child of `.view-pane` with no
 * scroll box of its own, so its content overflowed the pane instead of scrolling inside it, and the
 * overflow painted over the bar that follows the pane in the shell's column.
 *
 * What is measured: every text or control element inside `.openviking-pane`, clipped by its scrolling
 * ancestors (an element scrolled out of its own box is invisible and must not count), against the
 * bar's rectangle. Checked at 320/390/1440, both on the first view and scrolled to the end — QA's own
 * probe could not confirm the scrolled case, which is the one a scroll box has to get right.
 *
 * Non-vacuous on every run: the same measurements first run with the pane's scroll box taken away
 * (the state QA reported) and must catch the overlap.
 *
 * Run: npm run build && node tests/statusbar-overlap-test.mjs
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
const SIZES = [
	{ w: 320, h: 568 },
	{ w: 390, h: 844 },
	{ w: 1440, h: 900 },
];
/** The pane's scroll box removed: the overflow QA photographed. */
const NO_SCROLL_BOX = ".openviking-pane{overflow:visible!important;}";

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

if (!CHROME_PATH) {
	console.log("✗ no Chrome for the test (set PI_WEB_CHROME)");
	process.exit(1);
}

const base = mkdtempSync(join(tmpdir(), "piweb-statusbar-"));
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

/** In the page: what the status bar covers, and whether the page's tabs can be clicked. */
function coverage() {
	const rect = (el) => {
		const r = el.getBoundingClientRect();
		return { x: r.left, y: r.top, r: r.right, b: r.bottom };
	};
	const overlap = (a, b) => {
		const w = Math.min(a.r, b.r) - Math.max(a.x, b.x);
		const h = Math.min(a.b, b.b) - Math.max(a.y, b.y);
		return w > 0.5 && h > 0.5 ? Math.round(w * h) : 0;
	};
	const barEl = document.querySelector(".statusbar");
	const pane = document.querySelector(".openviking-pane");
	if (!barEl || !pane) return { bar: !!barEl, pane: !!pane, covered: [], tabs: [] };
	const bar = rect(barEl);

	/* What the eye sees of an element: its own box cut down by every ancestor that clips. Content
	   scrolled out of the pane's box is painted nowhere and cannot be covering the bar. */
	const visibleRect = (el) => {
		const s = getComputedStyle(el);
		if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return null;
		let box = rect(el);
		for (let p = el.parentElement; p; p = p.parentElement) {
			const ps = getComputedStyle(p);
			if (ps.overflow === "visible" && ps.overflowX === "visible" && ps.overflowY === "visible") continue;
			const pb = rect(p);
			box = { x: Math.max(box.x, pb.x), y: Math.max(box.y, pb.y), r: Math.min(box.r, pb.r), b: Math.min(box.b, pb.b) };
		}
		if (box.r - box.x <= 1 || box.b - box.y <= 1) return null;
		return box;
	};

	const CONTROL = "button, a[href], input, select, textarea, [role='tab'], [tabindex]:not([tabindex='-1'])";
	const covered = [];
	for (const el of pane.querySelectorAll("*")) {
		const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
		if (!ownText && !el.matches(CONTROL)) continue;
		const box = visibleRect(el);
		if (!box) continue;
		const area = overlap(box, bar);
		if (area > 0) {
			covered.push({
				tag: el.tagName.toLowerCase(),
				cls: el.className?.baseVal ?? String(el.className ?? ""),
				text: (el.textContent ?? "").trim().slice(0, 40),
				area,
			});
		}
	}

	return { bar: true, pane: true, covered };
}

/* The tabs QA named: reachable means the page can bring each one into its box and a real click at the
   tab's own centre then lands on the tab — not on the status bar lying over it. */
function tabReach() {
	const pane = document.querySelector(".openviking-pane");
	if (!pane) return [];
	return [...pane.querySelectorAll("[role='tab'], .ovk-tab")].map((el) => {
		el.scrollIntoView({ block: "center", inline: "nearest" });
		const r = el.getBoundingClientRect();
		const text = (el.textContent ?? "").trim();
		if (r.width <= 1 || r.height <= 1) return { text, reachable: false, why: "not rendered" };
		const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
		return {
			text,
			reachable: !!hit && (hit === el || el.contains(hit) || hit.contains(el)),
			why: hit ? `${hit.tagName.toLowerCase()}.${String(hit.className ?? "").split(" ")[0]}` : "nothing at point",
		};
	});
}

/** Scroll every scrolling box in the pane, and the window, to the very end. */
function scrollToEnd() {
	const pane = document.querySelector(".openviking-pane");
	if (pane) {
		for (const el of [pane, ...pane.querySelectorAll("*")]) {
			if (el.scrollHeight > el.clientHeight + 1) el.scrollTop = el.scrollHeight;
		}
	}
	window.scrollTo(0, document.documentElement.scrollHeight);
	document.documentElement.scrollTop = document.documentElement.scrollHeight;
	document.body.scrollTop = document.body.scrollHeight;
}

const browser = await chromium.launch({ executablePath: CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto(`http://localhost:${PORT}/?view=openviking`);
await page.waitForSelector(".ovk-status-title", { timeout: 20000 });
await sleep(1500);
// A fresh profile opens the shell's first-run setup modal over everything; this test is about the
// status bar, so it is closed before anything is measured.
await page.evaluate(() => document.querySelector(".modal-backdrop .modal-close")?.click());
await sleep(400);

/** Control: with the pane's scroll box taken away, the overlap QA reported must be caught. */
const planted = await page.addStyleTag({ content: NO_SCROLL_BOX });
for (const { w, h } of [
	{ w: 320, h: 568 },
	{ w: 390, h: 844 },
]) {
	await page.setViewportSize({ width: w, height: h });
	await sleep(400);
	const m = await page.evaluate(coverage);
	check(
		`control ${w}x${h}: without the pane's scroll box the bar covers content (the reported bug)`,
		m.covered.length > 0,
		`${m.covered.length} covered, e.g. ${m.covered[0] ? JSON.stringify(m.covered[0].text) : "—"}`,
	);
}
await planted.evaluate((el) => el.remove());

for (const { w, h } of SIZES) {
	await page.setViewportSize({ width: w, height: h });
	await sleep(400);

	for (const where of ["first view", "scrolled to end"]) {
		if (where === "scrolled to end") {
			await page.evaluate(scrollToEnd);
			await sleep(400);
		}
		const m = await page.evaluate(coverage);
		check(`${w}x${h} ${where}: the page renders with its status bar`, m.bar && m.pane);
		check(
			`${w}x${h} ${where}: no dashboard text or control under the status bar`,
			m.covered.length === 0,
			m.covered.length === 0 ? "" : JSON.stringify(m.covered.slice(0, 4)),
		);
		const tabs = await page.evaluate(tabReach);
		const unreachable = tabs.filter((t) => !t.reachable);
		check(
			`${w}x${h} ${where}: every tab is reachable (${tabs.length} tabs)`,
			tabs.length > 0 && unreachable.length === 0,
			unreachable.length === 0 ? tabs.map((t) => t.text).join(", ") : JSON.stringify(unreachable),
		);
	}
	// Back to the top for the next width.
	await page.evaluate(() => {
		const pane = document.querySelector(".openviking-pane");
		if (pane) for (const el of [pane, ...pane.querySelectorAll("*")]) el.scrollTop = 0;
	});
}

await page.close();
await browser.close();
server.kill();
console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
