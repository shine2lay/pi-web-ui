/* OpenViking (?) tooltips stay on screen (frontend #280, QA #136 final check F1).
 *
 * In a real browser, with the dashboard fed the jsdom suite's own fixtures (one fixture source), at
 * 320x700, 390x844 and 1440x900: every visible (?) trigger — the three cards' and each workspace tab's
 * contract badges — is opened by keyboard focus and by pointer hover, and the [role=tooltip] it
 * describes must lie wholly inside the viewport (QA saw "wt land Sync" at left -126px on 390 and
 * "Write Guard" at right 1577px on 1440). The tooltip's semantics stay as they were: role="tooltip",
 * the trigger's aria-describedby names it, Escape closes it.
 *
 * Before-control: OVK_BASE=<url of a running build> runs the same checks against that build instead of
 * a fresh server; on 7acf602e (before #280) they must fail.
 *
 * Run: npm run build && node tests/openviking-tooltip-edges-test.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const SIZES = [
	{ w: 320, h: 700 },
	{ w: 390, h: 844 },
	{ w: 1440, h: 900 },
];
const TABS = ["mount-map", "namespace-explorer", "commit-audit"];

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

if (!CHROME_PATH) {
	console.log("✗ no Chrome for the test (set PI_WEB_CHROME)");
	process.exit(1);
}

const fixtures = JSON.parse(
	execFileSync(join(REPO_ROOT, "node_modules/.bin/tsx"), ["tests/openviking-dashboard/fixtures-json.ts"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	}),
);

let server = null;
let baseUrl = process.env.OVK_BASE?.replace(/\/$/, "");
if (!baseUrl) {
	const port = 30000 + Math.floor(Math.random() * 10000);
	const base = mkdtempSync(join(tmpdir(), "piweb-ovk-tooltip-"));
	const workdir = join(base, "work");
	const dataDir = join(base, "data");
	const agentDir = join(base, "agent");
	for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });
	writeFileSync(join(workdir, "a.txt"), "a");
	server = spawn("node", ["dist/server/index.js"], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			PI_WEB_PORT: String(port),
			PI_WEB_CWD: workdir,
			PI_WEB_DATA_DIR: dataDir,
			PI_CODING_AGENT_DIR: agentDir,
		},
		stdio: "ignore",
	});
	baseUrl = `http://localhost:${port}`;
	for (let i = 0; i < 80; i++) {
		try {
			if ((await fetch(`${baseUrl}/api/health`)).ok) break;
		} catch {}
		await sleep(250);
	}
}

/** In the page: tag the visible (?) triggers of the open panel and the cards, and return their labels. */
function tagVisibleTriggers() {
	const out = [];
	for (const el of document.querySelectorAll("[data-tooltip-trigger]")) {
		el.removeAttribute("data-probe-trigger");
		const r = el.getBoundingClientRect();
		if (r.width < 1 || r.height < 1 || el.closest(".ovk-is-hidden, [hidden]")) continue;
		el.setAttribute("data-probe-trigger", String(out.length));
		out.push(el.getAttribute("data-tooltip-trigger"));
	}
	return out;
}

/** In the page: the open tooltip the trigger describes, its rect against the viewport, and its semantics. */
function tooltipPlace(index) {
	const trigger = document.querySelector(`[data-probe-trigger="${index}"]`);
	const id = trigger?.getAttribute("aria-describedby");
	const tip = id ? document.getElementById(id) : null;
	if (!tip) return { open: false };
	const r = tip.getBoundingClientRect();
	const vw = document.documentElement.clientWidth;
	const vh = window.innerHeight;
	return {
		open: true,
		role: tip.getAttribute("role"),
		rect: {
			left: Math.round(r.left),
			right: Math.round(r.right),
			top: Math.round(r.top),
			bottom: Math.round(r.bottom),
		},
		vw,
		vh,
		inside: r.left >= 0 && r.right <= vw && r.top >= 0 && r.bottom <= vh,
	};
}

const browser = await chromium.launch({ executablePath: CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.route("**/api/openviking/**", (route) => {
	const url = new globalThis.URL(route.request().url());
	const key = url.pathname.split("/").pop();
	const body = key === "overview" ? fixtures.overview : key === "audit" ? fixtures.audit : fixtures.entries;
	return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
});
await page.goto(`${baseUrl}/?view=openviking`);
await page.waitForSelector(".ovk-status-title", { timeout: 20000 });
await sleep(1500);
// A fresh profile opens the shell's first-run setup modal over everything; close it first.
await page.evaluate(() => document.querySelector(".modal-backdrop .modal-close")?.click());
await sleep(400);

for (const { w, h } of SIZES) {
	await page.setViewportSize({ width: w, height: h });
	await sleep(400);
	const at = `${w}x${h}`;
	let opened = 0;
	const seen = new Set();

	for (const tab of TABS) {
		await page.click(`[role='tab'][data-tab='${tab}']`);
		await sleep(250);
		const labels = await page.evaluate(tagVisibleTriggers);
		for (const [index, label] of labels.entries()) {
			const sel = `[data-probe-trigger="${index}"]`;
			const where = `${at} ${tab} "${label}"`;

			// Keyboard path: focus opens it, Escape closes it.
			await page.evaluate((s) => {
				const el = document.querySelector(s);
				el.scrollIntoView({ block: "center" });
				el.focus();
			}, sel);
			await sleep(120);
			const byFocus = await page.evaluate(tooltipPlace, index);
			check(
				`${where} on focus: role=tooltip, inside the ${byFocus.vw ?? "?"}x${byFocus.vh ?? "?"} viewport`,
				byFocus.open && byFocus.role === "tooltip" && byFocus.inside,
				byFocus.open ? JSON.stringify(byFocus.rect) : "no tooltip named by aria-describedby",
			);
			await page.keyboard.press("Escape");
			await sleep(80);
			const closed = await page.evaluate(tooltipPlace, index);
			check(`${where}: Escape closes it`, !closed.open);
			await page.evaluate(() => document.activeElement?.blur());

			// Pointer path: hover opens it.
			await page.hover(sel);
			await sleep(120);
			const byHover = await page.evaluate(tooltipPlace, index);
			check(
				`${where} on hover: inside the viewport`,
				byHover.open && byHover.inside,
				byHover.open ? JSON.stringify(byHover.rect) : "no tooltip on hover",
			);
			await page.mouse.move(0, 0);
			await sleep(80);
			opened++;
			seen.add(label);
		}
	}
	// Per tab: the 3 card tips + that tab's 2 contract badges; 5 distinct labels across the page.
	check(`${at}: opened every (?) — ${opened} triggers, ${seen.size} distinct`, opened >= 15 && seen.size >= 5);
}

await page.close();
await browser.close();
server?.kill();
console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
