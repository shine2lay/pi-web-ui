/* accent-contrast E2E (no tokens): the violet and amber text is readable in the main views too, and the
 * change that made it so (Design rm-2c447ce9, task #97: --accent-text, --accent-fill, --amber-fg) adds no new
 * colour-contrast problem there. WCAG 2.2 AA 1.4.3, 4.5:1. The Queue tab has its own test
 * (tests/faint-contrast-test.mjs); this one looks at the rest of the app.
 *
 * A sealed test server with the mock model (no turn is expected) and a real browser, at 1440x900, in the default
 * dark theme and in White:
 *  - a chat with fixture messages (a question, thinking, a tool call and its result, an answer in Markdown with a
 *    link, code, a list, a quote and a table; TL;DR lines, one that needs you);
 *  - Settings, every tab;
 *  - the Roles page, with four roles: queues at work, a question waiting for you, a wait, TL;DR lines.
 * Each is scanned with axe's color-contrast rule, scrolled through so every line is looked at in view.
 * Checks, per theme and view:
 *  - no violet or amber text under 4.5:1: no hit in dark's violet --accent #8b5cf6 (nor white text on it) and
 *    none in White's amber --amber #d97706, the two colours task #97 is about (before it, 30 dark hits and 10
 *    White ones here);
 *  - no new hit: every other hit is a colour pair that was there before task #97 in that view (KNOWN, measured
 *    on mine at 266f142: greys, the identity tags' green, White's own blue accent on its tinted active tab), so a
 *    repointed rule that made something else worse fails;
 *  - no model call, no page errors.
 *
 *   npm run build && node tests/run-sealed.mjs accent-contrast
 *   env: AC_SHOT_DIR=<dir> (screenshots of each view), AC_REPORT=<file> (every hit as JSON), AC_ONLY=dark|white,
 *        PI_AXE_JS: axe-core (default the design kit's copy in ~/temper-ai).
 */
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";
import { revealTopbarItem, SETTINGS_CHIP } from "./lib/topbar.mjs";

const HOME = userInfo().homedir;
const AXE = process.env.PI_AXE_JS ?? join(HOME, "temper-ai/configs/design/bin/vendor/axe-4.13.0.min.js");
if (!existsSync(AXE)) {
	console.log(`✗ FAIL: axe-core not found at ${AXE} (set PI_AXE_JS)`);
	process.exit(1);
}
const SHOTS = process.env.AC_SHOT_DIR;
const REPORT = process.env.AC_REPORT;
const ONLY = process.env.AC_ONLY;
const AA = 4.5;

/** The colours task #97 is about, per theme, as they were before it: text in them (or white text on the fill)
 *  under 4.5:1 fails. Dark's violet --accent; White's amber --amber (White keeps its own blue accent). */
const THEMES = {
	dark: { key: "", bg: "#0d0e12", text: ["#8b5cf6"], fill: "#8b5cf6" },
	white: { key: "white", bg: "#ffffff", text: ["#d97706"], fill: null },
};
/** The colour-contrast hits the main views had before task #97 in other colours (measured on mine at 266f142 with
 *  this fixture), as "view|fg on bg" (a view ending in * covers each one it starts with). They are outside task
 *  #97 (Design's to decide); any other hit is new. */
const KNOWN = {
	dark: [
		"settings approval-rules|#797e8e on #14161c", // the rules' descriptions, a dimmed grey
		"settings sound|#494d59 on #14161c",
		"settings sound|#73757b on #14161c",
		"settings tools|#9aa1b4 on #6b6b6b",
	],
	white: [
		"chat|#059669 on #e6f4f0", // the identity tags' green
		// "Ephemeral chat": the link violet, hard-coded in every theme (2.48:1 here). White keeps its look apart from
		// the amber (task #97's plan); left for Design.
		"chat|#a78bfa on #f7f3fe",
		"settings approval-rules|#727a84 on #ffffff",
		"settings approval-rules|#838a92 on #ffffff",
		"settings prompt|#1d75dd on #f7f9fa", // "Show more": White's blue, faded
		"settings prompt|#9aa0a6 on #f6f8fa",
		"settings prompt|#9aa0a6 on #ffffff",
		"settings prompt|#a2a8ad on #f7f9fa",
		"settings prompt|#dddddd on #ffffff",
		"settings identities|#059669 on #deeeec",
		"settings sound|#9a9c9e on #ffffff",
		"settings sound|#b9bec3 on #ffffff",
		"settings *|#0969da on #deeaf7", // the active tab's label: White's own blue on its tint, 4.25:1
	],
};
const isKnown = (theme, view, h) =>
	KNOWN[theme].some((k) => {
		const [v, pair] = k.split("|");
		return pair === `${h.fg} on ${h.bg}` && (v.endsWith("*") ? view.startsWith(v.slice(0, -1).trim()) : v === view);
	});

let failures = 0;
const check = (name, ok, extra = "") => {
	if (!ok) failures += 1;
	console.log(`  ${ok ? "✓" : "✗ FAIL:"} ${name}${!ok && extra ? ` — ${extra}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			const v = await fn();
			if (v) return v;
		} catch {}
		await sleep(200);
	}
	return null;
}

// ---- the fixture ------------------------------------------------------------------------------------------
const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
let seq = 0;
const eid = () => (++seq).toString(16).padStart(8, "0");
const iso = (ms) => new Date(ms).toISOString();
const user = (text, ts) => ({
	type: "message",
	id: eid(),
	timestamp: iso(ts),
	message: { role: "user", content: [{ type: "text", text }], timestamp: ts },
});
const assistant = (text, ts, before = [], stopReason = "stop") => ({
	type: "message",
	id: eid(),
	timestamp: iso(ts),
	message: {
		role: "assistant",
		content: [...before, { type: "text", text }],
		api: "openai-completions",
		provider: "mock",
		model: "mock-model",
		usage,
		stopReason,
		timestamp: ts,
	},
});
const toolResult = (text, ts) => ({
	type: "message",
	id: eid(),
	timestamp: iso(ts),
	message: {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: ts,
	},
});
const tldr = (text, ts, extra = {}) => ({
	type: "custom",
	customType: "tldr",
	data: { v: 1, text, needsYou: false, ts, ...extra },
	id: eid(),
	timestamp: iso(ts),
});
const q = (op, ts = NOW - 2 * HOUR) => ({
	type: "custom",
	customType: "queue",
	data: { v: 1, ts, ...op },
	id: eid(),
	timestamp: iso(ts),
});
const plan = (title) => ({
	title,
	goal: `${title}: the agreed result is in place`,
	doneWhen: "The page shows it",
	decided: "Change only this part",
	steps: "1. Make the change\n2. Look at the page",
	verify: "Open the page",
	mustNot: "Touch anything else",
});
const opening = (who) => [user(`${who}: good morning`, NOW - 5 * HOUR), assistant("Morning.", NOW - 5 * HOUR + 1000)];

/** A transcript: the header, then the lines chained by parentId (the app reads its branch). */
function writeChat(path, sessionId, cwd, lines, name) {
	let parent = null;
	const chained = lines.map((l) => {
		const out = { ...l, parentId: parent };
		parent = l.id;
		return out;
	});
	const head = { type: "session", version: 3, id: sessionId, timestamp: iso(NOW - 6 * HOUR), cwd };
	const tail = name ? [{ type: "session_info", id: eid(), parentId: parent, timestamp: iso(NOW - MIN), name }] : [];
	writeFileSync(path, `${[head, ...chained, ...tail].map((l) => JSON.stringify(l)).join("\n")}\n`);
	const newest = Math.max(...[head, ...lines].map((l) => Date.parse(l.timestamp) || 0));
	utimesSync(path, newest / 1000, newest / 1000);
}

const ANSWER = [
	"## What changed",
	"",
	"The page now reads the **saved** colours first, then the theme's. See [the plan](https://example.test/plan) and `theme.css`.",
	"",
	"- the list keeps its order",
	"- the badges keep their colours",
	"",
	"> Checked on the test account, both themes.",
	"",
	"| Part | Before | After |",
	"| --- | --- | --- |",
	"| Header | 3.2:1 | 5.1:1 |",
	"| Badge | 2.8:1 | 6.2:1 |",
	"",
	"```js",
	'const colour = getComputedStyle(el).getPropertyValue("--accent-text");',
	"```",
].join("\n");

const files = {};
let idDir = "";
let stateDir = "";
const ROLES = [
	["ops", "Ops/tooling"],
	["design", "Design"],
	["qa", "QA"],
	["product", "Product management"],
];
function seed({ root, agentDir, workdir }) {
	const sessions = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(sessions, { recursive: true });
	let n = 0;
	const chat = (key, lines, name) => {
		n += 1;
		const id = `01a0f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
		const path = join(sessions, `2026-10-01T10-00-00-000Z_${id}.jsonl`);
		writeChat(path, id, workdir, lines, name);
		files[key] = path;
	};
	chat("ops3", [...opening("ops task 3"), tldr("Which backup bucket should I use?", NOW - HOUR, { needsYou: true })]);
	chat(
		"main",
		[
			user("Can you make the page's colours readable?", NOW - 3 * HOUR),
			assistant(
				"Let me look at the theme first.",
				NOW - 3 * HOUR + 1000,
				[
					{ type: "thinking", thinking: "The theme's tokens decide it; read them before changing anything." },
					{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "grep -n accent theme.css" } },
				],
				"toolUse",
			),
			toolResult("12: --accent: #8b5cf6;\n13: --accent-soft: rgba(139, 92, 246, 0.14);", NOW - 3 * HOUR + 2000),
			assistant(ANSWER, NOW - 3 * HOUR + 3000),
			tldr("Looking at the page's colours", NOW - 3 * HOUR),
			tldr("Fixed the colours, checking both themes", NOW - 2 * HOUR),
			tldr("Which theme should be the default?", NOW - HOUR, { needsYou: true }),
			user("Thanks, that reads well now.", NOW - 30 * MIN),
			assistant("Good. Both themes pass the contrast check.", NOW - 29 * MIN),
		],
		"Launch notes",
	);
	chat("ops", [
		...opening("ops"),
		q({ op: "run" }),
		q({ op: "add", id: 3, plan: plan("Rotate the backup keys") }),
		q({ op: "start", id: 3, lane: true }),
		q({ op: "chat", id: 3, file: files.ops3, title: "Rotate the backup keys" }),
		q({ op: "stuck", id: 3, question: "Which backup bucket should I use?" }, NOW - HOUR),
		q({ op: "add", id: 4, plan: plan("Tidy the scheduler") }),
		tldr("Which backup bucket should I use?", NOW - HOUR, {
			needsYou: true,
			chat: { file: files.ops3, title: "Rotate the backup keys" },
		}),
	]);
	chat("design", [...opening("design"), tldr("Drew the onboarding screens", NOW - 40 * MIN)]);
	chat("qa", [
		...opening("qa"),
		tldr("Ran the checkout checks", NOW - 2 * HOUR),
		tldr("Approve the release notes?", NOW - 20 * MIN, { needsYou: true }),
	]);
	chat("product", [
		...opening("product"),
		q({ op: "run" }),
		q({ op: "add", id: 30, plan: plan("Repeatable early-screen scores") }),
		q({ op: "start", id: 30, lane: true }),
		q({ op: "wait", id: 30, what: "run B finishing", check: "false", everyMs: 120_000, until: NOW + 86_400_000 }),
		q({ op: "add", id: 31, plan: plan("Critic checks from research") }),
		tldr("Sizing the next experiment", NOW - 10 * MIN),
	]);
	idDir = join(root, "identities");
	for (const [id, title] of ROLES) {
		mkdirSync(join(idDir, id), { recursive: true });
		writeFileSync(
			join(idDir, id, "identity.json"),
			`${JSON.stringify({ id, title, homeChat: files[id] }, null, "\t")}\n`,
		);
		writeFileSync(
			join(idDir, id, "about.md"),
			`# ${title}\n\n**Focus:** ${title.toLowerCase()} for the test company.\n`,
		);
		writeFileSync(join(idDir, id, "notebook.md"), "Rules\n");
	}
	stateDir = join(root, "state");
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(join(root, "memory"), { recursive: true });
}

let modelCalls = 0;
const srv = await ownServer({
	name: "accent-contrast",
	mock: () => {
		modelCalls += 1;
		return "ACCENT-CONTRAST no turn was expected.";
	},
	prepare: seed,
	verbose: !!process.env.AC_DEBUG,
	env: {
		PI_WEB_TOKEN: "",
		get HOME() {
			return join(idDir, "..");
		},
		get XDG_STATE_HOME() {
			return stateDir;
		},
		get PI_IDENTITY_DIR() {
			return idDir;
		},
		get PI_MEMORY_DIR() {
			return join(idDir, "..", "memory");
		},
		PI_IDENTITY_REINDEX: "0",
	},
});
const hardStop = setTimeout(() => {
	console.log("✗ FAIL: the test took too long");
	process.exit(1);
}, 420_000);
hardStop.unref();

// ---- the scan ---------------------------------------------------------------------------------------------
/** axe's color-contrast rule on `rootSel`, scrolled through (its biggest scroller) so every line is looked at in
 *  view. Returns the hits: { target, text, fg, bg, ratio }. */
async function hitsIn(page, rootSel) {
	if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ path: AXE });
	return page.evaluate(async (sel) => {
		const root = document.querySelector(sel);
		if (!root) return { missing: true, hits: [], passes: 0 };
		const scrollable = (e) => e.scrollHeight > e.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(e).overflowY);
		let scroller = null;
		for (const e of [root, ...root.querySelectorAll("*")])
			if (
				scrollable(e) &&
				(!scroller || e.scrollHeight - e.clientHeight > scroller.scrollHeight - scroller.clientHeight)
			)
				scroller = e;
		const frame = () => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
		const start = scroller ? scroller.scrollTop : 0;
		if (scroller) {
			scroller.scrollTop = 0;
			await frame();
		}
		const hits = new Map();
		let passes = 0;
		for (let i = 0; i < 40; i++) {
			const res = await window.axe.run(root, {
				runOnly: { type: "rule", values: ["color-contrast"] },
				resultTypes: ["violations"],
			});
			for (const v of res.violations)
				for (const n of v.nodes) {
					const d = n.any?.[0]?.data ?? {};
					const target = n.target.join(" ");
					const el = document.querySelector(n.target[0]);
					const hit = {
						target,
						text: (el?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60),
						fg: String(d.fgColor ?? "").toLowerCase(),
						bg: String(d.bgColor ?? "").toLowerCase(),
						ratio: d.contrastRatio,
					};
					hits.set(`${target}|${hit.fg}|${hit.bg}`, hit);
				}
			passes += 1;
			if (!scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) break;
			scroller.scrollTop += Math.max(40, Math.floor(scroller.clientHeight * 0.7));
			await frame();
		}
		if (scroller) scroller.scrollTop = start;
		return { hits: [...hits.values()], passes };
	}, rootSel);
}

const report = [];
const pageErrors = [];
/** One view's hits, held to the two checks. */
function judge(theme, view, scan) {
	const t = THEMES[theme];
	const violetOrAmber = (h) => t.text.includes(h.fg) || (!!t.fill && h.bg === t.fill && /^#fff(fff)?$/.test(h.fg));
	const ours = scan.hits.filter(violetOrAmber);
	const others = scan.hits.filter((h) => !violetOrAmber(h));
	const fresh = others.filter((h) => !isKnown(theme, view, h));
	check(
		`${theme} ${view}: no violet or amber text under ${AA}:1 (${scan.passes} scroll position(s))`,
		!scan.missing && ours.length === 0,
		scan.missing ? "the view isn't there" : `${ours.length} hit(s)`,
	);
	check(`${theme} ${view}: no new colour-contrast hit`, fresh.length === 0, `${fresh.length} new`);
	for (const h of scan.hits)
		console.log(
			`      ${ours.includes(h) ? "violet/amber" : fresh.includes(h) ? "new" : "known"} ${h.ratio}:1 ${h.fg} on ${h.bg} ${h.target} "${h.text}"`,
		);
	report.push({ theme, view, passes: scan.passes, hits: scan.hits, violetOrAmber: ours.length, fresh: fresh.length });
}

async function shot(page, name) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function look(browser, theme) {
	console.log(`the main views, ${theme}`);
	const ctx = await browser.newContext({
		viewport: { width: 1440, height: 900 },
		deviceScaleFactor: 1,
		locale: "en-US",
	});
	await ctx.addInitScript((k) => {
		localStorage.setItem("pi-web-ui:lang", "en");
		if (k) localStorage.setItem("pi-web-ui:theme", k);
		else localStorage.removeItem("pi-web-ui:theme");
	}, THEMES[theme].key);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => pageErrors.push(`${theme}: ${e}`));
	const themed = () =>
		waitFor(
			() =>
				page.evaluate(
					(bg) => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().toLowerCase() === bg,
					THEMES[theme].bg,
				),
			15_000,
		);

	// The chat.
	await page.goto(`${srv.http}/?chat=${encodeURIComponent(files.main)}`);
	await page.waitForSelector(".topbar", { timeout: 60_000 });
	check(`${theme}: the ${theme} theme is on (--bg ${THEMES[theme].bg})`, !!(await themed()));
	const shown = await waitFor(
		() => page.evaluate(() => document.body.innerText.includes("Both themes pass the contrast check.")),
		20_000,
	);
	check(`${theme} chat: the fixture messages are on screen`, !!shown);
	await page.evaluate(() => document.fonts?.ready);
	await sleep(300);
	judge(theme, "chat", await hitsIn(page, "body"));
	await shot(page, `chat-${theme}`);

	// Settings, every tab.
	await (await revealTopbarItem(page, SETTINGS_CHIP)).click();
	await page.locator(".settings-modal").waitFor({ timeout: 10_000 });
	const tabs = await page.locator(".settings-tab[data-tab]").evaluateAll((els) => els.map((e) => e.dataset.tab));
	check(`${theme} settings: the tabs are there (${tabs.length})`, tabs.length >= 10, tabs.join(","));
	for (const tab of tabs) {
		await page.locator(`.settings-tab[data-tab="${tab}"]`).click();
		await sleep(400);
		judge(theme, `settings ${tab}`, await hitsIn(page, ".settings-modal"));
		if (["display", "tools", "plugins"].includes(tab)) await shot(page, `settings-${tab}-${theme}`);
	}
	await page.locator(".settings-modal .modal-close").first().click();

	// The Roles page.
	await page.goto(`${srv.http}/?view=roles`);
	const roles = await waitFor(
		() => page.evaluate(() => document.querySelectorAll(".roles-view [data-role-id]").length >= 4),
		30_000,
	);
	check(`${theme} roles: the four roles are on the page`, !!roles);
	await page.evaluate(() => document.fonts?.ready);
	await sleep(300);
	judge(theme, "roles", await hitsIn(page, ".roles-view"));
	await shot(page, `roles-${theme}`);
	await ctx.close();
}

let browser = null;
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	for (const theme of ["dark", "white"]) if (!ONLY || ONLY === theme) await look(browser, theme);
	check("no model call", modelCalls === 0, `${modelCalls} call(s)`);
	check("no page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 400));
} catch (err) {
	check("the test ran to the end", false, String(err?.stack ?? err).slice(0, 1200));
} finally {
	await browser?.close().catch(() => {});
	await srv.stop();
	if (REPORT) {
		mkdirSync(dirname(REPORT), { recursive: true });
		writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
	}
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall accent-contrast checks passed");
process.exit(failures ? 1 : 0);
