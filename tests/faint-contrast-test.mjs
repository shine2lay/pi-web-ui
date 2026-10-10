/* faint-contrast E2E (no tokens): all the Queue tab's text is readable: WCAG 2.2 AA 1.4.3, 4.5:1. First its faint
 * secondary text (Design rm-947a15e3, after Ops #91's finding rm-04c8efaf: --text-faint was 3.86:1 in dark, 3.45:1
 * in White); since accent-contrast (Design rm-2c447ce9, task #97) the violet and amber text too, which this test
 * used to pin as known hits: now every colour-contrast hit fails, whatever its colour.
 *
 * A sealed test server with the real pi-queue (PI_QUEUE_PKG, default ~/projects/pi-queue), the mock model (no
 * turn is expected) and a real browser. One seeded queue chat, "gamma", running (so "Stop" shows) with Auto
 * approve and Auto start on, two lanes (both in use: nothing new starts), and every kind of faint line the Queue
 * tab has:
 *   #1 "Write the wording"        done (the Done section: the whole row is faint; "Clear done");
 *   #9-#13                        done earlier: six done tasks, so the list shows five and "Show all done (6)";
 *   #2 "Build the page"           working in a chat of its own (its started time, Touches);
 *   #3 "Ask about the colours"    needs you, in a chat of its own (the question, the answer hint);
 *   #4 "Wait for the design files" blocked on a need (the Blocked line and when it's poked next);
 *   #5 "Wait for the deploy"      on hold (queue_wait);
 *   #6 "Check the page"           after #1, which is done ("After #1"; Touches; up/down/remove);
 *   #7 "Paused task"              paused by the owner;
 *   #8 "Follow the paused task"   after #7 ("After #7 · still waiting for #7 (paused by you)", "Can't start
 *                                 until you resume #7", Touches).
 *   #6's plan is opened (its part labels). Section headings, ids, Lane and Pause buttons are there as always.
 * Checks, in the default dark theme and in White, on a desktop (1440x900) and a phone (390x844):
 *  - each of those faint lines is on screen, and so are Stop, the two Auto switches (on) and "Show all done";
 *  - axe's color-contrast rule finds no faint text in the Queue tab (the panel is scrolled through, so every
 *    line is looked at in view; each hit is listed with its ratio and colours);
 *  - nor anything else: no pinned hits any more (the violet --accent-text and White's amber --amber-fg);
 *  - Stop, the Auto switches when on and "Show all done" (violet text, which only a live queue showed before)
 *    are measured at 4.5:1 or more on the background they sit on;
 *  - the faint text axe measured is at 4.5:1 or more, and --text-faint stays fainter than --text-dim (dim's
 *    ratio on the same background at least 1.15 times faint's);
 *  - no model call, no page errors.
 * Nothing the model is sent is printed.
 *
 * Usage: npm run build && PI_QUEUE_PKG=<pi-queue checkout> node tests/run-sealed.mjs faint-contrast
 *        scripts/sealed.sh env FC_SHOT_DIR=<dir> FC_REPORT=<file> node tests/faint-contrast-test.mjs
 *        FC_SHOT_DIR: screenshots. FC_REPORT: every measured node as JSON. FC_DEBUG=1: server log.
 *        FC_ONLY="desktop dark" (or phone white, ...): only that one look, while debugging.
 *        PI_AXE_JS: axe-core (default the design kit's copy in ~/temper-ai).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
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
if (!existsSync(AXE)) {
	console.log(`✗ FAIL: axe-core not found at ${AXE} (set PI_AXE_JS)`);
	process.exit(1);
}
const SHOTS = process.env.FC_SHOT_DIR;
const REPORT = process.env.FC_REPORT;
const ONLY = process.env.FC_ONLY;
/** WCAG 2.2 AA 1.4.3 for text under 18.66 px bold / 24 px: every faint line here is 11-13 px. */
const AA = 4.5;
/** Faint must stay visibly fainter than dim: dim's ratio on the same background is at least this times faint's. */
const DIM_OVER_FAINT = 1.15;
/** The violet and amber controls measured by hand too (accent-contrast, task #97): #93's live look found them
 *  under 4.5:1 where this fixture didn't show them (a running queue, Auto switches on, more than five done). */
const ACCENT_CONTROLS = [
	{ what: "Stop", sel: ".task-queue-toggle.stop", count: 1, text: /^Stop$/ },
	{
		what: "the Auto switches, on",
		sel: '.task-queue-switch[aria-checked="true"]',
		count: 2,
		text: /^Auto (approve|start)/,
	},
	{ what: '"Show all done"', sel: ".task-queue-more", count: 1, text: /^Show all done \(6\)$/ },
];

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

// ---- WCAG contrast (the same formula axe uses) ------------------------------------------------------
const channel = (c) => {
	const s = c / 255;
	return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const ratio = (a, b) => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
};
const hexRgb = (hex) => {
	const h = hex.replace("#", "");
	return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
};
const cssRgb = (css) => (css.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
const toHex = (rgb) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;

// ---- the seeded queue ---------------------------------------------------------------------------------
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
	const file = (minute, n) =>
		join(dir, `2026-10-01T10-0${minute}-00-000Z_01a0f000-0000-7000-8000-0000000000c${n}.jsonl`);
	files.Q = file(1, 1);
	/** The queue chat's session id: Auto approve and Auto start are bound to it (an "autonomy" op names it). */
	const queueId = files.Q.match(/_([^_]+)\.jsonl$/)?.[1];
	files.T2 = file(2, 2);
	files.T3 = file(3, 3);
	files.T4 = file(4, 4);
	files.T5 = file(5, 5);
	const write = (path, name, items) => {
		let ts = Date.now() - 3_600_000;
		const id = path.match(/_([^_]+)\.jsonl$/)?.[1];
		const lines = [
			{ type: "session", version: 3, id, timestamp: new Date(ts).toISOString(), cwd: wd },
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
		for (const item of items) {
			ts += 60_000;
			const base = { id: `e${lines.length}`, parentId, timestamp: new Date(ts).toISOString() };
			lines.push({ type: "custom", customType: "queue", ...base, data: { v: 1, ts, ...item } });
			parentId = base.id;
		}
		lines.push({ type: "session_info", id: "name", parentId, timestamp: new Date(ts + 1000).toISOString(), name });
		writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	};
	const add = (id, title, touches, after) => ({
		op: "add",
		id,
		plan: plan(title),
		touches,
		...(after ? { after } : {}),
	});
	write(files.Q, "gamma", [
		add(1, "Write the wording", ["docs repo"]),
		add(2, "Build the page", ["web repo"]),
		add(3, "Ask about the colours", ["design files"]),
		add(4, "Wait for the design files", ["web repo"]),
		add(5, "Wait for the deploy", ["pi-web-deploy"]),
		add(6, "Check the page", ["web repo", "pi-web-deploy"], [1]),
		add(7, "Paused task", ["api repo"]),
		add(8, "Follow the paused task", ["api repo"], [7]),
		add(9, "Collect the notes", ["docs repo"]),
		add(10, "Sort the notes", ["docs repo"]),
		add(11, "Name the parts", ["docs repo"]),
		add(12, "Draw the layout", ["design files"]),
		add(13, "Agree the layout", ["design files"]),
		{ op: "lanes", n: 4 },
		// Done before #1, so #1 (the newest) is among the five the Done list shows.
		...[9, 10, 11, 12, 13].map((id) => ({ op: "done", id, summary: "Done and checked." })),
		{ op: "done", id: 1, summary: "The wording is in place and checked on the test account." },
		{ op: "start", id: 2, lane: true },
		{ op: "chat", id: 2, file: files.T2, title: "Build the page" },
		{ op: "start", id: 3, lane: true },
		{ op: "chat", id: 3, file: files.T3, title: "Ask about the colours" },
		{
			op: "stuck",
			id: 3,
			question: "Which grey should the hints use?",
			choices: ["The new faint grey", "The dim grey"],
		},
		{ op: "start", id: 4, lane: true },
		{ op: "chat", id: 4, file: files.T4, title: "Wait for the design files" },
		{ op: "block", id: 4, need: "the design files from Design" },
		{ op: "start", id: 5, lane: true },
		{ op: "chat", id: 5, file: files.T5, title: "Wait for the deploy" },
		// The check never passes (exit 1: still waiting): with the queue running, a wait that ended would wake #5's chat.
		{ op: "wait", id: 5, what: "the deploy", check: "false", everyMs: 120_000, until: Date.now() + 86_400_000 },
		{ op: "hold", id: 7, why: "pressed Pause in the Queue panel", by: "panel" },
		// Running, so the head shows Stop; two lanes, both in use (#2 working, #3 waiting for an answer): nothing
		// new starts and no task wakes, so the fixture stays as seeded and no model is called.
		{ op: "lanes", n: 2 },
		{ op: "autonomy", queueId, setting: "autoApprove", value: true },
		{ op: "autonomy", queueId, setting: "autoStart", value: true },
		{ op: "run", queueId },
	]);
	const assigned = (id, title) => ({
		op: "assigned",
		id,
		plan: plan(title),
		touches: ["web repo"],
		from: { file: files.Q, title: "gamma" },
	});
	// A lane task's own chat is the truth about it: opening the queue chat syncs each lane task from its chat, so
	// the stuck / blocked / waiting states are written there too (as queue_stuck, queue_blocked, queue_wait would).
	write(files.T2, "Build the page", [assigned(2, "Build the page")]);
	write(files.T3, "Ask about the colours", [
		assigned(3, "Ask about the colours"),
		{
			op: "stuck",
			id: 3,
			question: "Which grey should the hints use?",
			choices: ["The new faint grey", "The dim grey"],
		},
	]);
	write(files.T4, "Wait for the design files", [
		assigned(4, "Wait for the design files"),
		{ op: "block", id: 4, need: "the design files from Design" },
	]);
	write(files.T5, "Wait for the deploy", [
		assigned(5, "Wait for the deploy"),
		{ op: "wait", id: 5, what: "the deploy", check: "false", everyMs: 120_000, until: Date.now() + 86_400_000 },
	]);
}

// ---- the mock model: no turn is expected ----------------------------------------------------------
const calls = [];
async function modelReply({ sideRequest }) {
	calls.push(sideRequest ? "side" : "turn");
	return "FAINT-CONTRAST no turn was expected.";
}

const srv = await ownServer({
	name: "faint-contrast",
	mock: modelReply,
	prepare: seed,
	verbose: !!process.env.FC_DEBUG,
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
const DESKTOP = ".panel-right";
const PHONE = ".drawer-right.open";
const THEMES = { dark: { key: "", bg: "#0d0e12" }, white: { key: "white", bg: "#ffffff" } };

async function openQueueTab(theme, phone) {
	const ctx = await browser.newContext({
		viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
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
	}, THEMES[theme].key);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => pageErrors.push(`${theme}${phone ? " phone" : ""}: ${e}`));
	await page.goto(`${srv.http}/?chat=${encodeURIComponent(files.Q)}`);
	await page.waitForSelector(".topbar", { timeout: 60_000 });
	const themed = await waitFor(
		() =>
			page.evaluate(
				(bg) => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().toLowerCase() === bg,
				THEMES[theme].bg,
			),
		15_000,
	);
	check(`${theme}${phone ? " phone" : ""}: the ${theme} theme is on (--bg ${THEMES[theme].bg})`, !!themed);
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

/** Which of the faint lines are on screen (in the Queue tab's DOM). */
const faintLines = (page, root) =>
	page.evaluate((r) => {
		const q = (sel) => [...document.querySelectorAll(`${r} ${sel}`)];
		const text = (sel) => q(sel).map((e) => e.textContent.trim());
		const row = (id) => document.querySelector(`${r} li.task-queue-task[data-task-id="${id}"]`);
		const inRow = (id, sel) => row(id)?.querySelector(sel)?.textContent.trim() ?? "";
		return {
			done: !!document.querySelector(`${r} li.task-queue-task.done[data-task-id="1"]`),
			doneTime: inRow(1, ".task-queue-time"),
			started: inRow(2, ".task-queue-time"),
			touches2: inRow(2, ".task-queue-touches"),
			after6: inRow(6, ".task-queue-after"),
			touches8: inRow(8, ".task-queue-touches"),
			after8: inRow(8, ".task-queue-after"),
			resume8: inRow(8, ".task-queue-resume-first"),
			hints: text(".task-queue-hint").length,
			blockedNext: text(".task-queue-blocked-next").length,
			ids: text(".task-queue-id").length,
			controls: q(".task-queue-controls button").length,
			clear: text(".task-queue-clear").length,
			headings: text(".task-queue-heading").length,
			parts: text(".task-queue-part dt").length,
		};
	}, root);
const allThere = (f) =>
	f.done &&
	/^done /i.test(f.doneTime) &&
	/^started /i.test(f.started) &&
	/web repo/.test(f.touches2) &&
	f.after6 === "After #1" &&
	/api repo/.test(f.touches8) &&
	/^After #7/.test(f.after8) &&
	f.resume8 === "Can't start until you resume #7" &&
	f.hints >= 1 &&
	// Seven open tasks and five of the six done ones.
	f.ids === 12 &&
	f.controls >= 3 &&
	f.clear === 1 &&
	f.headings >= 3 &&
	f.parts >= 3;

/** axe's color-contrast rule on the whole Queue tab, scrolled through so every line is looked at in view.
 *  Returns every measured node (passes and hits) and the ones axe couldn't decide. */
async function contrastNodes(page, root) {
	await page.addScriptTag({ path: AXE });
	return page.evaluate(async (r) => {
		const panel = document.querySelector(`${r} .task-queue-panel`);
		let scroller = panel;
		while (
			scroller &&
			!(scroller.scrollHeight > scroller.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))
		)
			scroller = scroller.parentElement;
		// Start at the top: opening #6's plan scrolled the panel down to it, and axe skips what is out of view.
		if (scroller) {
			scroller.scrollTop = 0;
			await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
		}
		const nodes = new Map();
		const unsure = new Map();
		const take = (n, pass) => {
			const d = n.any?.[0]?.data ?? {};
			const target = n.target.join(" ");
			const el = document.querySelector(n.target[0]);
			const item = {
				target,
				cls: el ? String(el.className) : "",
				task: el?.closest("li.task-queue-task")?.getAttribute("data-task-id") ?? null,
				text: (el?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 70),
				fg: d.fgColor,
				bg: d.bgColor,
				ratio: d.contrastRatio,
				size: d.fontSize,
				weight: d.fontWeight,
				pass,
			};
			const key = `${target}|${item.bg}`;
			if (!nodes.has(key) || !pass) nodes.set(key, item);
		};
		const passes = [];
		for (let i = 0; i < 30; i++) {
			const res = await window.axe.run(panel, {
				runOnly: { type: "rule", values: ["color-contrast"] },
				resultTypes: ["passes", "violations", "incomplete"],
			});
			for (const v of res.violations) for (const n of v.nodes) take(n, false);
			for (const v of res.passes) for (const n of v.nodes) take(n, true);
			for (const v of res.incomplete)
				for (const n of v.nodes) {
					const target = n.target.join(" ");
					if (unsure.has(target)) continue;
					// What sits on top of it, when axe says something does (first seen, in view).
					const el = document.querySelector(n.target[0]);
					const box = el?.getBoundingClientRect();
					const top = box ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) : null;
					const over =
						top && el && top !== el && !el.contains(top)
							? `${top.tagName.toLowerCase()}.${String(top.className).trim().replace(/\s+/g, ".")} at ${Math.round(box.top)}px`
							: "";
					unsure.set(target, { target, why: n.any?.[0]?.data?.messageKey ?? n.any?.[0]?.message ?? "", over });
				}
			passes.push(scroller ? scroller.scrollTop : 0);
			if (!scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) break;
			scroller.scrollTop += Math.max(40, Math.floor(scroller.clientHeight * 0.7));
			await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
		}
		if (scroller) scroller.scrollTop = 0;
		// Decided in one pass, unsure in another (out of view there): decided wins.
		const decided = new Set([...nodes.values()].map((n) => n.target));
		return {
			passes,
			nodes: [...nodes.values()],
			unsure: [...unsure.values()].filter((u) => !decided.has(u.target)),
		};
	}, root);
}

/** The elements matching `sel` in the panel: their text colour and the background they sit on, composited from
 *  their ancestors (rgb() or color(srgb ...) with alpha). */
const measured = (page, root, sel) =>
	page.evaluate(
		({ r, sel }) => {
			const rgba = (c) => {
				let m = /^rgba?\(([^)]+)\)$/.exec(c);
				if (m) {
					const p = m[1]
						.split(/[\s,/]+/)
						.filter(Boolean)
						.map(Number);
					return [p[0], p[1], p[2], p[3] ?? 1];
				}
				m = /^color\(srgb ([^)]+)\)$/.exec(c);
				if (m) {
					const p = m[1]
						.split(/[\s/]+/)
						.filter(Boolean)
						.map(Number);
					return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1];
				}
				return null;
			};
			const background = (el) => {
				const layers = [];
				for (let e = el; e; e = e.parentElement) {
					const c = rgba(getComputedStyle(e).backgroundColor);
					if (c && c[3] > 0) {
						layers.push(c);
						if (c[3] >= 1) break;
					}
				}
				let out = [255, 255, 255];
				for (const [lr, lg, lb, la] of layers.reverse())
					out = [lr * la + out[0] * (1 - la), lg * la + out[1] * (1 - la), lb * la + out[2] * (1 - la)];
				return out;
			};
			return [...document.querySelectorAll(`${r} ${sel}`)].map((b) => {
				const cs = getComputedStyle(b);
				const [fr, fg, fb, fa] = rgba(cs.color) ?? [0, 0, 0, 1];
				const bg = background(b);
				const a = fa * Number(cs.opacity);
				return {
					task: b.closest("li.task-queue-task")?.getAttribute("data-task-id"),
					glyph: b.textContent.trim().replace(/\s+/g, " "),
					label: b.getAttribute("aria-label"),
					fg: [fr * a + bg[0] * (1 - a), fg * a + bg[1] * (1 - a), fb * a + bg[2] * (1 - a)],
					bg,
				};
			});
		},
		{ r: root, sel },
	);
/** The glyph-only controls (the move and remove arrows, ↑ ↓ ✕) that axe leaves out ("nonBmp"). */
const glyphControls = (page, root) => measured(page, root, ".task-queue-controls button:not(:disabled)");

/** The theme's --text-faint and --text-dim as the page resolves them. */
const tokens = (page) =>
	page.evaluate(() => {
		const probe = document.createElement("span");
		document.body.append(probe);
		const of = (name) => {
			probe.style.color = `var(${name})`;
			return getComputedStyle(probe).color;
		};
		const out = { faint: of("--text-faint"), dim: of("--text-dim") };
		probe.remove();
		return out;
	});

const report = [];
async function look(theme, phone) {
	const tag = `${phone ? "phone" : "desktop"} ${theme}`;
	console.log(`the Queue tab, ${tag}`);
	const { page, root } = await openQueueTab(theme, phone);
	// #6's plan opened: its part labels (a view-only toggle).
	const title6 = page.locator(`${root} li.task-queue-task[data-task-id="6"] .task-queue-title`);
	if ((await title6.getAttribute("aria-expanded")) !== "true") await title6.click();
	let f = {};
	const there = await waitFor(async () => allThere((f = await faintLines(page, root))), 20_000);
	check(`${tag}: every kind of faint line is on screen`, !!there, JSON.stringify(f));
	if (!f.blockedNext) console.log(`    (no "poked next" part on #4's Blocked line in this run)`);
	await page.evaluate(() => document.fonts?.ready);

	const t = await tokens(page);
	const faint = toHex(cssRgb(t.faint));
	const dim = cssRgb(t.dim);
	const { nodes, unsure, passes } = await contrastNodes(page, root);
	const hits = nodes.filter((n) => !n.pass);
	const faintHits = hits.filter((h) => h.fg?.toLowerCase() === faint);
	check(
		`${tag}: axe's color-contrast rule finds no faint text in the Queue tab (${nodes.length} text nodes measured, ${passes.length} scroll position(s))`,
		faintHits.length === 0,
		`${faintHits.length} faint hit(s)`,
	);
	const others = hits.filter((h) => !faintHits.includes(h));
	check(
		`${tag}: nor anything else (the violet and amber text included: nothing is pinned)`,
		others.length === 0,
		`${others.length} other hit(s)`,
	);
	for (const h of hits)
		console.log(`      hit ${h.ratio}:1 ${h.fg} on ${h.bg} ${h.size} ${h.weight} ${h.target} "${h.text}"`);
	// The violet controls a live queue shows: Stop, the Auto switches when on, "Show all done".
	const controls = [];
	for (const c of ACCENT_CONTROLS) {
		const found = (await measured(page, root, c.sel))
			.filter((m) => c.text.test(m.glyph))
			.map((m) => ({
				what: c.what,
				text: m.glyph,
				fg: toHex(m.fg),
				bg: toHex(m.bg),
				ratio: Number(ratio(m.fg, m.bg).toFixed(2)),
			}));
		controls.push(...found);
		const weak = found.filter((m) => m.ratio < AA);
		check(
			`${tag}: ${c.what} (${c.count}) on screen at ${AA}:1 or more`,
			found.length === c.count && weak.length === 0,
			found.map((m) => `"${m.text}" ${m.fg} on ${m.bg} ${m.ratio}:1`).join("; ") || "not found",
		);
	}
	console.log(`    ${controls.map((m) => `"${m.text}" ${m.fg} on ${m.bg} ${m.ratio}:1`).join("; ")}`);
	// The arrows axe can't read: measured here, held to the text bar too (they are characters, and faint).
	const glyphs = (await glyphControls(page, root)).map((g) => ({
		...g,
		fg: toHex(g.fg),
		bg: toHex(g.bg),
		ratio: Number(ratio(g.fg, g.bg).toFixed(2)),
	}));
	const weakGlyphs = glyphs.filter((g) => g.ratio < AA);
	check(
		`${tag}: the move and remove arrows axe leaves out (${glyphs.length}) are at ${AA}:1 or more too`,
		glyphs.length >= 3 && weakGlyphs.length === 0,
		weakGlyphs.map((g) => `#${g.task} ${g.glyph} ${g.fg} on ${g.bg} ${g.ratio}:1`).join("; ") ||
			`${glyphs.length} found`,
	);
	if (unsure.length)
		console.log(
			`    axe couldn't decide ${unsure.length}: ${unsure.map((u) => `${u.target} (${u.why}${u.over ? `, under ${u.over}` : ""})`).join("; ")}`,
		);

	const faintNodes = nodes.filter((n) => n.fg?.toLowerCase() === faint);
	const minFaint = faintNodes.reduce((m, n) => Math.min(m, n.ratio), Number.POSITIVE_INFINITY);
	check(
		`${tag}: the faint text axe measured (${faintNodes.length} nodes, ${faint}) is at ${AA}:1 or more`,
		faintNodes.length > 0 && minFaint >= AA,
		`lowest ${minFaint}:1 on ${faintNodes.find((n) => n.ratio === minFaint)?.bg}`,
	);
	const bgs = [...new Set(faintNodes.map((n) => n.bg))];
	const fainter = bgs.map((bg) => {
		const fr = ratio(hexRgb(faint), hexRgb(bg));
		const dr = ratio(dim, hexRgb(bg));
		return { bg, faint: Number(fr.toFixed(2)), dim: Number(dr.toFixed(2)), ok: dr >= fr * DIM_OVER_FAINT };
	});
	check(
		`${tag}: faint stays fainter than dim (dim at least ${DIM_OVER_FAINT}x faint's ratio on each background)`,
		fainter.length > 0 && fainter.every((x) => x.ok),
		JSON.stringify(fainter),
	);
	console.log(
		`    faint ${faint}, dim ${toHex(dim)}: ${fainter.map((x) => `${x.faint} vs ${x.dim} on ${x.bg}`).join("; ")}`,
	);
	report.push({
		theme,
		phone,
		faint,
		dim: toHex(dim),
		faintOn: fainter,
		hits,
		faintHits: faintHits.length,
		otherHits: others.length,
		controls,
		unsure,
		glyphs,
		nodes,
	});

	if (SHOTS) {
		mkdirSync(SHOTS, { recursive: true });
		const name = `queue-${tag.replace(/ /g, "-")}`;
		await page.screenshot({ path: join(SHOTS, `${name}.png`) });
		await page
			.locator(root)
			.first()
			.screenshot({ path: join(SHOTS, `${name}-panel.png`) });
		// The panel scrolled to its end too: the after lines, "Can't start until you resume", the Done section.
		await page.evaluate(async (r) => {
			let s = document.querySelector(`${r} .task-queue-panel`);
			while (s && !(s.scrollHeight > s.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(s).overflowY)))
				s = s.parentElement;
			if (s) s.scrollTop = s.scrollHeight;
			await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
		}, root);
		await page
			.locator(root)
			.first()
			.screenshot({ path: join(SHOTS, `${name}-panel-end.png`) });
	}
	await page.context().close();
}

try {
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	for (const theme of ["dark", "white"])
		for (const phone of [false, true])
			if (!ONLY || ONLY === `${phone ? "phone" : "desktop"} ${theme}`) await look(theme, phone);
	check("no model call", calls.length === 0, calls.join(","));
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
console.log(failures ? `\n${failures} check(s) failed` : "\nall faint-contrast checks passed");
process.exit(failures ? 1 : 0);
