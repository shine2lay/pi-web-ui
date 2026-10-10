/* queue-why E2E (no tokens): the Queue tab says why a task can't start yet, and a queue hears at once when a
 * task in another queue that one of its tasks comes after is paused by the owner.
 *
 * A sealed test server with the real pi-queue (PI_QUEUE_PKG, default ~/projects/pi-queue; it needs task #90's
 * notes), the mock model (no turn is expected) and a real browser. The server's background check runs every
 * second (PI_WEB_QUEUE_BLOCKS_MS). Two seeded queues, neither started:
 *   alpha: #1 "Alpha task".
 *   beta:  #1 "Beta first" comes after alpha #1; #2 "Beta second" after #1; #3 "Beta paused", paused by the
 *          owner (the Queue panel's Pause); #4 "Beta fourth" after #3.
 * Checks:
 *  - beta's Queue tab: #1 "After alpha #1 · still waiting for alpha #1 (not started)"; #2 "After #1 · still
 *    waiting for #1 (not started)"; #4 "After #3 · still waiting for #3 (paused by you)" and, muted, "Can't
 *    start until you resume #3", with no needs-you badge or colour. In the dark and the white theme, on a
 *    desktop and a phone (no sideways overflow); axe finds nothing serious on those lines; keyboard: Tab
 *    from #4's title reaches the #3 link (a visible ring), Enter shows #3 (its title gets focus); the
 *    alpha #1 link opens alpha's chat.
 *  - alpha #1 paused from alpha's Queue tab (a click): beta's chat gets pi-queue's note about it once,
 *    within a few seconds; beta #1's line says "(paused by you)" with "Can't start until you resume
 *    alpha #1". Nothing more over the next rounds. Resumed: back to "(not started)", no note. Paused again
 *    (a new pause): one more note.
 *  - no model call, no page errors.
 * Nothing the model is sent is printed.
 *
 * Usage: npm run build && PI_QUEUE_PKG=<pi-queue checkout> node tests/run-sealed.mjs queue-why
 *        QW_SHOT_DIR=<dir>: screenshots. QW_DEBUG=1: server log. PI_AXE_JS: axe-core (default the design
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
const CHECK_MS = 1000;
/** How soon the note should be there after the pause: a few rounds of the check. */
const NOTE_WITHIN_MS = 8 * CHECK_MS;

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

// ---- seeded chats ---------------------------------------------------------------------------------
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
	files.A = join(dir, "2026-10-01T10-01-00-000Z_01a0f000-0000-7000-8000-0000000000a1.jsonl");
	files.B = join(dir, "2026-10-01T10-02-00-000Z_01a0f000-0000-7000-8000-0000000000b2.jsonl");
	const write = (path, items) => {
		let ts = Date.parse("2026-10-01T10:00:00.000Z");
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
			ts += 1000;
			const base = { id: `e${lines.length}`, parentId, timestamp: new Date(ts).toISOString() };
			if (item.queue) lines.push({ type: "custom", customType: "queue", ...base, data: { v: 1, ts, ...item.queue } });
			else if (item.name) lines.push({ type: "session_info", ...base, name: item.name });
			parentId = base.id;
		}
		writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	};
	write(files.A, [{ name: "alpha" }, { queue: { op: "add", id: 1, plan: plan("Alpha task"), touches: ["a1 repo"] } }]);
	write(files.B, [
		{ name: "beta" },
		{
			queue: {
				op: "add",
				id: 1,
				plan: plan("Beta first"),
				touches: ["b1 repo"],
				outside: [{ file: files.A, name: "alpha", id: 1 }],
			},
		},
		{ queue: { op: "add", id: 2, plan: plan("Beta second"), touches: ["b2 repo"], after: [1] } },
		{ queue: { op: "add", id: 3, plan: plan("Beta paused"), touches: ["b3 repo"] } },
		{ queue: { op: "add", id: 4, plan: plan("Beta fourth"), touches: ["b4 repo"], after: [3] } },
		{ queue: { op: "hold", id: 3, why: "pressed Pause in the Queue panel", by: "panel" } },
		{ queue: { op: "lanes", n: 4 } },
	]);
}

// ---- the mock model: no turn is expected ----------------------------------------------------------
const calls = [];
async function modelReply({ sideRequest }) {
	calls.push(sideRequest ? "side" : "turn");
	return "QUEUE-WHY no turn was expected.";
}

const srv = await ownServer({
	name: "queue-why",
	mock: modelReply,
	prepare: seed,
	verbose: !!process.env.QW_DEBUG,
	env: { PI_WEB_TOKEN: "", PI_WEB_QUEUE_BLOCKS_MS: String(CHECK_MS) },
});
const hardStop = setTimeout(() => {
	console.log("✗ FAIL: the test took too long");
	process.exit(1);
}, 300_000);
hardStop.unref();

// ---- transcripts -----------------------------------------------------------------------------------
const lines = (file) => {
	let text = "";
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter(Boolean)
		.flatMap((l) => {
			try {
				return [JSON.parse(l)];
			} catch {
				return [];
			}
		});
};
const opsIn = (file) =>
	lines(file)
		.filter((e) => e.type === "custom" && e.customType === "queue")
		.map((e) => e.data);
/** pi-queue's notes in a queue's chat about one task others wait on (its label: "#3", "alpha #1"). */
const notesAbout = (file, label) =>
	lines(file).filter(
		(e) => e.type === "custom_message" && e.customType === "queue-report" && e.details?.held === label,
	);

// ---- a real browser ----------------------------------------------------------------------------------
let browser = null;
const pageErrors = [];
const SHOTS = process.env.QW_SHOT_DIR;
const DESKTOP = ".panel-right";
const PHONE = ".drawer-right.open";
async function openPage(file, { theme = "", phone = false } = {}) {
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
	await page.goto(`${srv.http}/?chat=${encodeURIComponent(file)}`);
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
/** The Queue tab's rows: the after line, the "resume" line, which refs are marked needs-you, the badge. */
const rowsOf = (page, root) =>
	page.evaluate(
		(r) =>
			[...document.querySelectorAll(`${r} li.task-queue-task`)].map((li) => ({
				id: Number(li.dataset.taskId),
				title: li.querySelector(".task-queue-title-text")?.textContent ?? "",
				after: li.querySelector(".task-queue-after")?.textContent ?? "",
				resume: li.querySelector(".task-queue-resume-first")?.textContent ?? "",
				needsYou: [...li.querySelectorAll(".task-queue-ref.needs-you")].map((e) => e.dataset.ref),
				badge: li.querySelector(".task-queue-badge")?.textContent ?? "",
			})),
		root,
	);
const rowOf = (rows, id) => rows.find((r) => r.id === id);
const STILL = " \u00b7 still waiting for ";
const startRows = (rows) =>
	rowOf(rows, 1)?.after === `After alpha #1${STILL}alpha #1 (not started)` &&
	rowOf(rows, 1)?.resume === "" &&
	rowOf(rows, 2)?.after === `After #1${STILL}#1 (not started)` &&
	rowOf(rows, 2)?.resume === "" &&
	rowOf(rows, 3)?.after === "" &&
	rowOf(rows, 4)?.after === `After #3${STILL}#3 (paused by you)` &&
	rowOf(rows, 4)?.resume === "Can't start until you resume #3";
const colours = (page, root) =>
	page.evaluate((r) => {
		const probe = document.createElement("span");
		document.body.append(probe);
		const of = (name) => {
			probe.style.color = `var(${name})`;
			return getComputedStyle(probe).color;
		};
		const out = {
			dim: of("--text-dim"),
			amber: of("--amber"),
			resume: (() => {
				const e = document.querySelector(`${r} .task-queue-resume-first`);
				return e ? getComputedStyle(e).color : "";
			})(),
			state4: (() => {
				const e = document.querySelector(`${r} li[data-task-id="4"] .task-queue-after .task-queue-ref-state`);
				return e ? getComputedStyle(e).color : "";
			})(),
		};
		probe.remove();
		return out;
	}, root);
/** axe-core on the after lines and the "resume" lines only (the rest of the panel isn't this change's). */
async function runAxe(page, root) {
	if (!existsSync(AXE)) return { error: `axe-core not found at ${AXE} (set PI_AXE_JS)` };
	await page.addScriptTag({ path: AXE });
	return page.evaluate(async (r) => {
		const nodes = document.querySelectorAll(`${r} .task-queue-after, ${r} .task-queue-resume-first`);
		const res = await window.axe.run(nodes, {
			runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
			resultTypes: ["violations"],
		});
		return {
			nodes: nodes.length,
			bad: res.violations
				.filter((v) => v.impact === "serious" || v.impact === "critical")
				.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
		};
	}, root);
}
async function shot(page, root, name) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await page
		.locator(root)
		.first()
		.screenshot({ path: join(SHOTS, name) });
}

/** One look at beta's Queue tab: the lines, the colours, axe; a screenshot. */
async function lookAtBeta(tag, opts) {
	const { page, root } = await openPage(files.B, opts);
	let rows = [];
	const ok = await waitFor(async () => startRows((rows = await rowsOf(page, root))), 20_000);
	check(
		`${tag}: #1, #2 and #4 say what they still wait for and how it stands; #4 "Can't start until you resume #3"`,
		!!ok,
		JSON.stringify(rows),
	);
	check(
		`${tag}: no needs-you anywhere (the pause is the owner's own)`,
		rows.every((r) => r.needsYou.length === 0 && r.badge === ""),
		JSON.stringify(rows),
	);
	const c = await colours(page, root);
	check(
		`${tag}: the resume line is muted (the dim text colour, not amber), and so is "(paused by you)"`,
		c.resume === c.dim && c.resume !== c.amber && c.state4 !== c.amber,
		JSON.stringify(c),
	);
	const axe = await runAxe(page, root);
	check(
		`${tag}: axe finds nothing serious or critical on those lines`,
		!axe.error && axe.nodes > 0 && axe.bad.length === 0,
		axe.error ?? axe.bad.join("; "),
	);
	if (opts.phone) {
		const over = await page.evaluate((r) => {
			const d = document.querySelector(r);
			const lines = [...d.querySelectorAll(".task-queue-after, .task-queue-resume-first")];
			return {
				drawer: d.scrollWidth - d.clientWidth,
				page: document.documentElement.scrollWidth - innerWidth,
				lines: lines.filter((e) => e.getBoundingClientRect().right > d.getBoundingClientRect().right + 0.5).length,
			};
		}, root);
		check(
			`${tag}: nothing runs off the side`,
			over.drawer <= 0 && over.page <= 0 && over.lines === 0,
			JSON.stringify(over),
		);
	}
	await shot(page, root, `${tag.replace(/[^a-z]+/g, "-")}.png`);
	return { page, root };
}

let pageA = null;
let pageB = null;
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });

	// ---- the lines, desktop dark: keyboard; the alpha #1 link opens alpha's chat ---------------------
	console.log("beta's Queue tab, before anything is paused in alpha");
	const dark = await lookAtBeta("desktop dark", {});
	{
		const { page, root } = dark;
		await page.locator(`${root} li.task-queue-task[data-task-id="4"] .task-queue-title`).focus();
		let reached = null;
		for (let i = 0; i < 8 && !reached; i++) {
			await page.keyboard.press("Tab");
			reached = await page.evaluate(() => {
				const a = document.activeElement;
				if (!a?.classList.contains("task-queue-ref-link")) return null;
				if (a.closest(".task-queue-ref")?.getAttribute("data-ref") !== "#3") return null;
				if (a.closest("li.task-queue-task")?.getAttribute("data-task-id") !== "4") return null;
				const cs = getComputedStyle(a);
				return { ring: cs.outlineStyle !== "none" && Number.parseFloat(cs.outlineWidth) > 0 };
			});
		}
		check("keyboard: Tab from #4's title reaches the #3 link on its after line", !!reached);
		check("keyboard: the link shows a focus ring", !!reached?.ring, JSON.stringify(reached));
		await page.keyboard.press("Enter");
		check(
			"keyboard: Enter shows #3 (its title gets focus)",
			!!(await waitFor(
				() =>
					page.evaluate(
						() =>
							document.activeElement?.classList.contains("task-queue-title") &&
							document.activeElement.closest("li.task-queue-task")?.getAttribute("data-task-id") === "3",
					),
				5000,
			)),
		);
		await page.locator(`${root} li.task-queue-task[data-task-id="1"] .task-queue-ref-link`).first().click();
		const inAlpha = await waitFor(async () => {
			const rows = await rowsOf(page, root);
			return rows.length === 1 && rowOf(rows, 1)?.title === "Alpha task";
		}, 15_000);
		check("the alpha #1 link opens alpha's chat (its Queue tab shows Alpha task)", !!inAlpha);
		pageA = page;
	}

	// ---- the white theme and the phone ----------------------------------------------------------------
	const white = await lookAtBeta("desktop white", { theme: "white" });
	await white.page.context().close();
	const phone = await lookAtBeta("phone dark", { phone: true });
	await phone.page.context().close();

	// ---- alpha #1 paused: beta hears it once ------------------------------------------------------------
	console.log("alpha #1 paused from alpha's Queue tab");
	const B = await openPage(files.B);
	pageB = B.page;
	check("beta's tab is up before the pause", !!(await waitFor(async () => startRows(await rowsOf(pageB, DESKTOP)))));
	check("no note about alpha #1 in beta's chat yet", notesAbout(files.B, "alpha #1").length === 0);
	const pauseButton = pageA.locator(`${DESKTOP} button.task-queue-pause[data-pause-task="1"]`);
	await pauseButton.click();
	const t0 = Date.now();
	const held = await waitFor(() => opsIn(files.A).some((op) => op.op === "hold" && op.id === 1), 10_000);
	check("Pause (a click) pauses alpha #1", !!held);
	const noted = await waitFor(() => notesAbout(files.B, "alpha #1").length >= 1, 20_000);
	const tookMs = Date.now() - t0;
	check(
		`beta's chat gets pi-queue's note about alpha #1 within ${NOTE_WITHIN_MS / 1000} s`,
		!!noted && tookMs <= NOTE_WITHIN_MS,
		`${noted ? `after ${tookMs} ms` : "no note"}`,
	);
	const text = notesAbout(files.B, "alpha #1")[0]?.content;
	const said = typeof text === "string" ? text : Array.isArray(text) ? text.map((p) => p.text ?? "").join("") : "";
	check(
		"the note says alpha #1 is paused by the owner and #1 can't start until he resumes it",
		/alpha #1/.test(said) && /paused by the owner/.test(said) && /until he resumes it/.test(said),
		said.slice(0, 300),
	);
	let rows = [];
	const shown = await waitFor(async () => {
		rows = await rowsOf(pageB, DESKTOP);
		return (
			rowOf(rows, 1)?.after === `After alpha #1${STILL}alpha #1 (paused by you)` &&
			rowOf(rows, 1)?.resume === "Can't start until you resume alpha #1"
		);
	}, 15_000);
	check(
		'beta #1: "still waiting for alpha #1 (paused by you)" and "Can\'t start until you resume alpha #1"',
		!!shown,
		JSON.stringify(rowOf(rows, 1)),
	);
	check(
		"still no needs-you in beta's tab",
		rows.every((r) => r.needsYou.length === 0 && r.badge === ""),
		JSON.stringify(rows),
	);
	await shot(pageB, DESKTOP, "desktop-dark-alpha-paused.png");
	await sleep(5 * CHECK_MS);
	check(
		"one note only, over the next rounds",
		notesAbout(files.B, "alpha #1").length === 1,
		`${notesAbout(files.B, "alpha #1").length} notes`,
	);

	// ---- resumed, then paused again (a new pause) ------------------------------------------------------------
	console.log("alpha #1 resumed, then paused again");
	await pauseButton.click();
	check(
		"Resume (a click) lifts the pause",
		!!(await waitFor(() => opsIn(files.A).some((op) => op.op === "release" && op.id === 1), 10_000)),
	);
	const back = await waitFor(async () => {
		rows = await rowsOf(pageB, DESKTOP);
		return rowOf(rows, 1)?.after === `After alpha #1${STILL}alpha #1 (not started)` && rowOf(rows, 1)?.resume === "";
	}, 15_000);
	check('beta #1 is back to "(not started)", no resume line', !!back, JSON.stringify(rowOf(rows, 1)));
	await sleep(4 * CHECK_MS);
	check("no note for the resume", notesAbout(files.B, "alpha #1").length === 1);
	await pauseButton.click();
	const again = await waitFor(() => notesAbout(files.B, "alpha #1").length === 2, 20_000);
	check("paused again: one more note (a new pause)", !!again, `${notesAbout(files.B, "alpha #1").length} notes`);
	await sleep(4 * CHECK_MS);
	check("and only one", notesAbout(files.B, "alpha #1").length === 2);

	check("no model call (the notes start no turn)", calls.length === 0, calls.join(","));
	check("no page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 400));
} catch (err) {
	check("the test ran to the end", false, String(err?.stack ?? err).slice(0, 1200));
} finally {
	await browser?.close().catch(() => {});
	await srv.stop();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall queue-why checks passed");
process.exit(failures ? 1 : 0);
