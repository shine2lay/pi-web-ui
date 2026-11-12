/* OpenViking reader modal + type floor E2E (frontend #274, Design PROD-SIGNOFF M2 + M3, #269 F3/F4/F5).
 *
 * In a real browser, with the dashboard fed the jsdom suite's own fixtures (one fixture source):
 *   M2  With the reader open, 12 Tabs and 12 Shift+Tabs never leave the dialog; Escape pressed after
 *       tabbing closes it and gives focus back to the row that opened it; while open, the dashboard
 *       and the app's top bar and status bar are inert, and live again after closing.
 *   F4  The workspace tablist is one Tab stop and Right / Left / Home / End move selection and focus.
 *   M3  No visible text run renders under 12px (Design's probe_type method: every visible element with
 *       its own text), body copy reads at 16px, and the type peaks at 22px on the three card heroes with
 *       the page title at 17px — the approved prototype's own distribution (probe-type.json: 22px x3, 17px x1).
 * Checked at 390x844 and 1440x900.
 *
 * Before-control: OVK_BASE=<url of a running build> runs the same checks against that build instead of
 * a fresh server; on the build before #274 they must fail.
 *
 * Run: npm run build && node tests/openviking-modal-type-test.mjs
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
	{ w: 390, h: 844 },
	{ w: 1440, h: 900 },
];
const FLOOR_PX = 12;

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
	const base = mkdtempSync(join(tmpdir(), "piweb-ovk-modal-"));
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

/** In the page: where focus is relative to the open reader. */
function focusPlace() {
	const dialog = document.querySelector("[role='dialog'][data-row-key]");
	const a = document.activeElement;
	const label = a ? (a.getAttribute("aria-label") || a.textContent || a.tagName).trim().slice(0, 40) : "none";
	return { open: !!dialog, inside: !!dialog && !!a && dialog.contains(a), label };
}

/** In the page: is each part of the shell behind the reader inert? */
function inertState() {
	const isInert = (sel) => {
		const el = document.querySelector(sel);
		return el ? !!el.closest("[inert]") : null;
	};
	const dialog = document.querySelector("[role='dialog'][data-row-key]");
	return {
		dialogInert: dialog ? !!dialog.closest("[inert]") : null,
		dashboard: isInert(".ovk-dashboard"),
		statusbar: isInert(".statusbar"),
		topbar: isInert(".topbar"),
	};
}

/** In the page: Design's probe_type method — every visible element with its own text, at its computed size. */
function typeRuns() {
	const root = document.querySelector(".openviking-pane");
	if (!root) return { n: 0, below: [], sizes: {} };
	const runs = [];
	for (const el of root.querySelectorAll("*")) {
		const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
		if (!own) continue;
		const s = getComputedStyle(el);
		const r = el.getBoundingClientRect();
		if (s.display === "none" || s.visibility === "hidden" || r.width < 1 || r.height < 1) continue;
		if (el.closest("[hidden], .sr-only, .visually-hidden")) continue;
		runs.push({
			cls: String(el.className || el.tagName),
			px: Number.parseFloat(s.fontSize),
			text: el.textContent.trim().slice(0, 30),
		});
	}
	const px = (sel) => {
		const el = root.querySelector(sel);
		return el ? Number.parseFloat(getComputedStyle(el).fontSize) : null;
	};
	return {
		n: runs.length,
		below: runs.filter((r) => r.px < 12),
		title: px(".ovk-status-title"),
		heroes: [...root.querySelectorAll(".ovk-card-headline")].map((el) =>
			Number.parseFloat(getComputedStyle(el).fontSize),
		),
		bodyRoot: px(".ovk-root") ?? px(".ovk-dashboard"),
		modeLabel: px(".ovk-mode-label"),
		maxPx: Math.max(...runs.map((r) => r.px)),
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

	// M3 — the type floor, on the first view and with the Explorer open.
	for (const tab of ["first view", "namespace-explorer"]) {
		if (tab !== "first view") await page.click(`[role='tab'][data-tab='${tab}']`);
		await sleep(300);
		const t = await page.evaluate(typeRuns);
		check(
			`${at} ${tab}: 0 of ${t.n} visible text runs below ${FLOOR_PX}px`,
			t.n > 0 && t.below.length === 0,
			t.below.length ? `${t.below.length} below, e.g. ${JSON.stringify(t.below.slice(0, 3))}` : "",
		);
		check(
			`${at} ${tab}: body reads at 16px`,
			t.bodyRoot === 16 && t.modeLabel === 16,
			`root=${t.bodyRoot} mode-label=${t.modeLabel}`,
		);
		if (w >= 1440)
			check(
				`${at} ${tab}: the three card heroes are 22px, the largest type, over a 17px page title`,
				t.heroes.length === 3 && t.heroes.every((px) => px === 22) && t.maxPx === 22 && t.title === 17,
				`heroes=${t.heroes.join(",")} title=${t.title} max=${t.maxPx}`,
			);
	}

	// F4 — the workspace tablist: one Tab stop, arrows move selection and focus.
	await page.click("[role='tab'][data-tab='mount-map']");
	const stops = await page.$$eval(
		"[role='tablist'] [role='tab'][data-tab]",
		(tabs) => tabs.filter((t) => t.tabIndex >= 0).length,
	);
	check(`${at}: the workspace tablist is one Tab stop`, stops === 1, `${stops} stops`);
	const walk = [];
	for (const key of ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowLeft", "End", "Home"]) {
		await page.keyboard.press(key);
		walk.push(
			await page.evaluate(
				() =>
					`${document.activeElement?.getAttribute("data-tab")}:${document.activeElement?.getAttribute("aria-selected")}`,
			),
		);
	}
	const want = ["namespace-explorer", "commit-audit", "mount-map", "commit-audit", "commit-audit", "mount-map"].map(
		(t) => `${t}:true`,
	);
	check(`${at}: Right / Left / Home / End move selection and focus`, walk.join() === want.join(), walk.join(" "));

	// M2 — the reader is a real modal.
	await page.click("[role='tab'][data-tab='namespace-explorer']");
	await sleep(200);
	const open = async () => {
		await page.evaluate(() => {
			const row = document.querySelector("[data-tabpanel='namespace-explorer'] [data-open-reader]");
			row.setAttribute("data-probe-row", "0");
			row.scrollIntoView({ block: "center" });
			row.focus();
		});
		await page.keyboard.press("Enter");
		await page.waitForSelector("[role='dialog'][data-row-key]", { timeout: 5000 });
		await sleep(150);
	};
	for (const [dir, key] of [
		["forward", "Tab"],
		["backward", "Shift+Tab"],
	]) {
		await open();
		const trail = [];
		for (let i = 0; i < 12; i++) {
			await page.keyboard.press(key);
			trail.push(await page.evaluate(focusPlace));
		}
		const out = trail.filter((p) => !p.inside);
		check(
			`${at} ${dir} trail: 12 of 12 ${key} stops inside the dialog`,
			out.length === 0,
			out.length
				? `${out.length} outside: ${out
						.map((p) => p.label)
						.slice(0, 4)
						.join(" | ")}`
				: "",
		);
		await page.keyboard.press("Escape");
		await sleep(150);
	}

	await open();
	const inert = await page.evaluate(inertState);
	check(
		`${at}: shell inert while open, dialog not`,
		inert.dashboard && inert.statusbar && inert.topbar && inert.dialogInert === false,
		JSON.stringify(inert),
	);
	for (let i = 0; i < 3; i++) await page.keyboard.press("Tab");
	await page.keyboard.press("Escape");
	await sleep(200);
	const after = await page.evaluate(() => ({
		drawers: document.querySelectorAll("[role='dialog'][data-row-key]").length,
		focusBackOnRow: document.activeElement?.getAttribute("data-probe-row") === "0",
		shellInert:
			!!document.querySelector(".statusbar")?.closest("[inert]") ||
			!!document.querySelector(".ovk-dashboard")?.closest("[inert]"),
	}));
	check(
		`${at}: Escape from the 3rd stop closes and returns focus to the row`,
		after.drawers === 0 && after.focusBackOnRow,
		JSON.stringify(after),
	);
	check(`${at}: the shell is live again after closing`, !after.shellInert);

	// The other close path: the reader's own Close button gives focus back too.
	await open();
	await page.click("[role='dialog'][data-row-key] [aria-label='Close reader']");
	await sleep(200);
	const closed = await page.evaluate(() => ({
		drawers: document.querySelectorAll("[role='dialog'][data-row-key]").length,
		focusBackOnRow: document.activeElement?.getAttribute("data-probe-row") === "0",
	}));
	check(
		`${at}: the Close button closes and returns focus to the row`,
		closed.drawers === 0 && closed.focusBackOnRow,
		JSON.stringify(closed),
	);
}

await page.close();
await browser.close();
server?.kill();
console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
