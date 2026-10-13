/* queue-ops-detail E2E (no tokens): a question Ops passes on to the owner shows its whole package (rule 21).
 *
 * A sealed test server with the real pi-queue (PI_QUEUE_PKG, default ~/projects/pi-queue), the mock model (no
 * turn is expected) and a real browser. One seeded chat, "tooling": its task #1 needs the owner, with a
 * question, two choices and the package Ops gave it (pi-queue's `detail`: goal, progress, prior decisions, why
 * the owner, every question, options, recommendation and what each answer authorises), long enough to scroll,
 * with a line of raw HTML that must stay text. Made-up words only; nothing the model is sent is printed.
 * Checks, in the dark and the white theme on a desktop and on a phone:
 *  - the Queue tab shows the question, then the package open beside it under "The whole picture, to decide
 *    from", as Markdown (headings, bold), whole (its last line is there), then the choices and the answer box;
 *  - the raw HTML stays text: no <img> made from it, nothing it would run;
 *  - the package scrolls on its own; from the keyboard: Tab from the task's title reaches its summary and then
 *    the package (a visible focus ring), and End scrolls the package to its last line;
 *  - axe finds nothing serious or critical on the question's card; nothing runs off the side on the phone;
 *  - no model call, no page errors.
 *
 * Usage: npm run build && PI_QUEUE_PKG=<pi-queue checkout> node tests/run-sealed.mjs queue-ops-detail
 *        QD_SHOT_DIR=<dir>: screenshots. QD_DEBUG=1: server log. PI_AXE_JS: axe-core (default the design
 *        kit's copy in ~/temper-ai).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";

const HOME = userInfo().homedir;
const PI_QUEUE = process.env.PI_QUEUE_PKG ?? join(HOME, "projects", "pi-queue");
if (!existsSync(join(PI_QUEUE, "package.json"))) {
	console.log(`✗ FAIL: pi-queue not found at ${PI_QUEUE} (set PI_QUEUE_PKG)`);
	process.exit(1);
}
const AXE = process.env.PI_AXE_JS ?? join(HOME, "temper-ai/configs/design/bin/vendor/axe-4.13.0.min.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`  ${ok ? "✓" : "✗ FAIL:"} ${name}${extra && !ok ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
	return ok;
};
async function waitFor(fn, ms = 20_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		try {
			const v = await fn();
			if (v) return v;
		} catch {
			/* not yet */
		}
		await sleep(150);
	}
	return null;
}

// ---- the seeded chat ---------------------------------------------------------------------------------
const QUESTION = "Approve $40 for a paid load test of the settings page?";
const CHOICES = ["Approve $40", "Don't spend"];
const LAST_LINE = "End of the package: nothing else is waiting on you for task #1.";
const PACKAGE = [
	"**Task #1 in tooling: Speed up the settings page.** Ops passes this on: only you can give it.",
	"",
	"## Goal",
	"The settings page shows its data within one second on the test account.",
	"",
	"## Progress and what changed",
	"Measured 2.4 s; the account list call is 1.9 s of it. A one-minute cache is built and brings it to 0.6 s locally.",
	"",
	"## Prior decisions",
	"- Ops decided the cache length (one minute) on 2026-10-12, as a technical choice within the goal.",
	"",
	"## Why the owner",
	"It spends money: a paid load test costs $40.",
	"",
	"## All outstanding questions",
	"1. Approve $40 for a paid load test of the settings page?",
	"",
	"## Options",
	"- **Approve $40**: a real load test today; cost $40, about an hour; risk low.",
	"- **Don't spend**: rely on the local timing; free; risk that real traffic is slower.",
	"",
	"## Recommendation",
	"Approve $40: the local timing can't show real traffic.",
	"",
	"## What each answer authorises",
	"- **Approve $40**: one load test, up to $40, nothing else.",
	"- **Don't spend**: no spending; the task finishes on the local timing.",
	"",
	"## Measurements so far",
	...Array.from(
		{ length: 40 },
		(_, i) => `- Run ${i + 1}: ${(2.4 - i * 0.04).toFixed(2)} s before, ${(0.6 + (i % 5) * 0.01).toFixed(2)} s after.`,
	),
	"",
	'<img src="x" onerror="window.__rawHtmlRan = true"> raw HTML stays text',
	"",
	LAST_LINE,
].join("\n");

const files = {};
const plan = (title) => ({
	title,
	goal: `${title}: the agreed result is in place for the team`,
	doneWhen: "The page shows the agreed result on the test account",
	decided: "Change only this part, then look at the page again",
	steps: "1. Make the change\n2. Look at the page\n3. Run the checks",
	verify: "Open the page and run the existing checks",
	mustNot: "Touch anything else on the page",
});

function seed({ agentDir, workdir: wd }) {
	const settingsFile = join(agentDir, "settings.json");
	const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
	writeFileSync(
		settingsFile,
		JSON.stringify({ ...settings, defaultProvider: "mock", defaultModel: "mock-model", packages: [PI_QUEUE] }, null, 2),
	);
	writeFileSync(join(agentDir, "pi-queue.json"), JSON.stringify({ stalledAfterMinutes: 0 }));
	const dir = join(agentDir, "sessions", `--${wd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(dir, { recursive: true });
	files.Q = join(dir, "2026-10-01T10-01-00-000Z_01a0f000-0000-7000-8000-0000000000d1.jsonl");
	let ts = Date.parse("2026-10-01T10:00:00.000Z");
	const lines = [
		{
			type: "session",
			version: 3,
			id: "01a0f000-0000-7000-8000-0000000000d1",
			timestamp: new Date(ts).toISOString(),
			cwd: wd,
		},
		{
			type: "model_change",
			id: "mc",
			parentId: null,
			timestamp: new Date(ts).toISOString(),
			provider: "mock",
			modelId: "mock-model",
		},
	];
	let parentId = "mc";
	const items = [
		{ name: "tooling" },
		{ queue: { op: "add", id: 1, plan: plan("Speed up the settings page") } },
		{ queue: { op: "start", id: 1 } },
		{ queue: { op: "stuck", id: 1, question: QUESTION, choices: CHOICES, detail: PACKAGE } },
	];
	for (const item of items) {
		ts += 1000;
		const base = { id: `e${lines.length}`, parentId, timestamp: new Date(ts).toISOString() };
		if (item.queue) lines.push({ type: "custom", customType: "queue", ...base, data: { v: 1, ts, ...item.queue } });
		else if (item.name) lines.push({ type: "session_info", ...base, name: item.name });
		parentId = base.id;
	}
	writeFileSync(files.Q, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

// ---- the mock model: no turn is expected ----------------------------------------------------------
const calls = [];
async function modelReply({ sideRequest }) {
	calls.push(sideRequest ? "side" : "turn");
	return "QUEUE-OPS-DETAIL no turn was expected.";
}

const srv = await ownServer({
	name: "queue-ops-detail",
	mock: modelReply,
	prepare: seed,
	verbose: !!process.env.QD_DEBUG,
	env: { PI_WEB_TOKEN: "" },
});
const hardStop = setTimeout(() => {
	console.log("✗ FAIL: the test took too long");
	process.exit(1);
}, 300_000);
hardStop.unref();

// ---- a real browser ----------------------------------------------------------------------------------
let browser = null;
const pageErrors = [];
const SHOTS = process.env.QD_SHOT_DIR;
const DESKTOP = ".panel-right";
const PHONE = ".drawer-right.open";
const ROW = 'li.task-queue-task[data-task-id="1"]';
async function openPage({ theme = "", phone = false } = {}) {
	const ctx = await browser.newContext({
		viewport: phone ? { width: 390, height: 844 } : { width: 1400, height: 900 },
		deviceScaleFactor: 1,
		isMobile: phone,
		hasTouch: phone,
		locale: "en-US",
	});
	await ctx.addInitScript((t) => {
		localStorage.setItem("pi-web-ui:lang", "en");
		localStorage.setItem("pi-web-ui:right-panel-collapsed", "0");
		if (t) localStorage.setItem("pi-web-ui:theme", t);
		else localStorage.removeItem("pi-web-ui:theme");
	}, theme);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => pageErrors.push(`${theme || "dark"}${phone ? " phone" : ""}: ${e}`));
	await page.goto(`${srv.http}/?chat=${encodeURIComponent(files.Q)}`);
	await page.waitForSelector(".topbar", { timeout: 60_000 });
	if (phone) {
		const toggle = page.locator("button.panel-toggle.has-label");
		if (!(await toggle.isVisible())) await page.locator(".topbar-overflow-btn").click();
		await toggle.click();
		await page.locator(PHONE).waitFor({ timeout: 10_000 });
	}
	const root = phone ? PHONE : DESKTOP;
	await page.locator(root).locator(".slot-tab", { hasText: "Queue" }).first().click();
	await page.locator(root).locator(".task-queue-panel").first().waitFor({ timeout: 10_000 });
	return { page, root };
}
/** The stuck task's card as the browser shows it. */
const cardOf = (page, root) =>
	page.evaluate(
		({ r, row }) => {
			const li = document.querySelector(`${r} ${row}`);
			const card = li?.querySelector(".task-queue-question");
			if (!card) return null;
			const det = card.querySelector("details.task-queue-question-detail");
			const body = det?.querySelector(".task-queue-question-detail-body");
			const order = [".task-queue-question-text", "details.task-queue-question-detail", ".task-queue-answer"].map(
				(s) => {
					const e = card.querySelector(s);
					return e ? [...card.querySelectorAll("*")].indexOf(e) : -1;
				},
			);
			return {
				needsYou: !!card.querySelector(".task-queue-badge"),
				question: card.querySelector(".task-queue-question-text")?.textContent ?? "",
				open: !!det?.open,
				summary: det?.querySelector("summary")?.textContent ?? "",
				role: body?.getAttribute("role") ?? "",
				label: body?.getAttribute("aria-label") ?? "",
				tabindex: body?.getAttribute("tabindex") ?? "",
				headings: [...(body?.querySelectorAll("h2") ?? [])].map((h) => h.textContent),
				bold: [...(body?.querySelectorAll("strong") ?? [])].map((b) => b.textContent),
				text: body?.textContent ?? "",
				imgs: body?.querySelectorAll("img").length ?? -1,
				scrolls: body ? body.scrollHeight > body.clientHeight + 4 : false,
				choices: [...card.querySelectorAll(".task-queue-choice")].map((c) => c.textContent),
				input: !!card.querySelector(".task-queue-answer-input"),
				order,
			};
		},
		{ r: root, row: ROW },
	);
async function runAxe(page, root) {
	if (!existsSync(AXE)) return { error: `axe-core not found at ${AXE} (set PI_AXE_JS)` };
	await page.addScriptTag({ path: AXE });
	return page.evaluate(
		async ({ r, row }) => {
			const node = document.querySelector(`${r} ${row} .task-queue-question`);
			const res = await window.axe.run(node, {
				runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
				resultTypes: ["violations"],
			});
			return {
				bad: res.violations
					.filter((v) => v.impact === "serious" || v.impact === "critical")
					.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
			};
		},
		{ r: root, row: ROW },
	);
}
async function shot(page, root, name) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await page
		.locator(`${root} ${ROW}`)
		.first()
		.screenshot({ path: join(SHOTS, name) });
}

/** One look: the card, raw HTML, keyboard, axe, overflow (phone), a screenshot. */
async function look(tag, opts) {
	const { page, root } = await openPage(opts);
	let card = null;
	await waitFor(async () => (card = await cardOf(page, root))?.open, 20_000);
	check(
		`${tag}: the task needs you with its question`,
		!!card?.needsYou && card?.question === QUESTION,
		JSON.stringify(card)?.slice(0, 300),
	);
	check(
		`${tag}: the package is open beside it, labelled "The whole picture, to decide from", as a keyboard-reachable region`,
		!!card?.open &&
			card.summary === "The whole picture, to decide from" &&
			card.role === "region" &&
			card.label === "The whole picture, to decide from" &&
			card.tabindex === "0",
		JSON.stringify(
			card && { open: card.open, summary: card.summary, role: card.role, label: card.label, tabindex: card.tabindex },
		),
	);
	check(
		`${tag}: as Markdown and whole: every part's heading, the bold options, its last line`,
		!!card &&
			[
				"Goal",
				"Progress and what changed",
				"Prior decisions",
				"Why the owner",
				"All outstanding questions",
				"Options",
				"Recommendation",
				"What each answer authorises",
			].every((h) => card.headings.includes(h)) &&
			card.bold.includes("Approve $40") &&
			card.text.includes(LAST_LINE) &&
			card.text.includes("Run 40:"),
		JSON.stringify(card && { headings: card.headings, bold: card.bold, end: card.text.slice(-120) }),
	);
	check(
		`${tag}: raw HTML stays text (no image made, nothing run)`,
		!!card &&
			card.imgs === 0 &&
			card.text.includes('<img src="x"') &&
			!(await page.evaluate(() => window.__rawHtmlRan === true)),
	);
	check(
		`${tag}: question, then the package, then the choices and the answer box`,
		!!card &&
			JSON.stringify(card.choices) === JSON.stringify(CHOICES) &&
			card.input &&
			card.order.every((i) => i >= 0) &&
			card.order[0] < card.order[1] &&
			card.order[1] < card.order[2],
		JSON.stringify(card && { choices: card.choices, order: card.order }),
	);
	check(`${tag}: the long package scrolls on its own`, !!card?.scrolls);

	// The keyboard: from the task's title, Tab reaches the summary, then the package; End scrolls it to the end.
	await page.locator(`${root} ${ROW} .task-queue-title`).first().focus();
	const seen = [];
	let ring = null;
	for (let i = 0; i < 12 && !seen.includes("region"); i++) {
		await page.keyboard.press("Tab");
		const at = await page.evaluate(() => {
			const a = document.activeElement;
			if (!a) return null;
			if (a.matches("details.task-queue-question-detail > summary")) return { where: "summary" };
			if (a.matches(".task-queue-question-detail-body")) {
				const cs = getComputedStyle(a);
				return { where: "region", ring: cs.outlineStyle !== "none" && Number.parseFloat(cs.outlineWidth) > 0 };
			}
			return { where: a.className || a.tagName };
		});
		if (at?.where === "summary" || at?.where === "region") seen.push(at.where);
		if (at?.where === "region") ring = at.ring;
	}
	check(
		`${tag}: keyboard: Tab reaches the summary, then the package`,
		seen.join(",") === "summary,region",
		seen.join(","),
	);
	check(`${tag}: keyboard: the package shows a focus ring`, ring === true);
	await page.keyboard.press("End");
	const bottom = await waitFor(
		() =>
			page.evaluate(
				({ r, row, last }) => {
					const body = document.querySelector(`${r} ${row} .task-queue-question-detail-body`);
					if (!body || body.scrollTop <= 0) return null;
					const p = [...body.querySelectorAll("p")].find((e) => e.textContent.includes(last));
					if (!p) return null;
					const b = body.getBoundingClientRect();
					const e = p.getBoundingClientRect();
					return e.top >= b.top - 1 && e.bottom <= b.bottom + 1;
				},
				{ r: root, row: ROW, last: LAST_LINE },
			),
		5000,
	);
	check(`${tag}: keyboard: End scrolls the package to its last line`, !!bottom);

	const axe = await runAxe(page, root);
	check(
		`${tag}: axe finds nothing serious or critical on the question's card`,
		!axe.error && axe.bad.length === 0,
		axe.error ?? axe.bad.join("; "),
	);
	if (opts.phone) {
		const over = await page.evaluate(
			({ r, row }) => {
				const d = document.querySelector(r);
				const card = d.querySelector(`${row} .task-queue-question`);
				return {
					drawer: d.scrollWidth - d.clientWidth,
					page: document.documentElement.scrollWidth - innerWidth,
					card: card ? Math.round(card.getBoundingClientRect().right - d.getBoundingClientRect().right) : 99,
				};
			},
			{ r: root, row: ROW },
		);
		check(
			`${tag}: nothing runs off the side`,
			over.drawer <= 0 && over.page <= 0 && over.card <= 0,
			JSON.stringify(over),
		);
	}
	await page
		.locator(`${root} ${ROW} .task-queue-question-detail-body`)
		.first()
		.evaluate((e) => {
			e.scrollTop = 0;
		});
	await shot(page, root, `${tag.replace(/[^a-z]+/g, "-")}.png`);
	await page.context().close();
}

try {
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	await look("desktop dark", {});
	await look("desktop white", { theme: "white" });
	await look("phone dark", { phone: true });
	await look("phone white", { phone: true, theme: "white" });
	check("no model call", calls.length === 0, calls.join(","));
	check("no page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 400));
} catch (err) {
	check("the test ran to the end", false, String(err?.stack ?? err).slice(0, 1200));
} finally {
	await browser?.close().catch(() => {});
	await srv.stop();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall queue-ops-detail checks passed");
process.exit(failures ? 1 : 0);
