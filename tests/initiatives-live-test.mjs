/* initiatives-live E2E (Ops #271, H-INIT-LIVE-1 in docs/live-progress.md; no tokens, no live data): the
 * Initiatives page shows progress as it happens, and never reads as needing the owner unless it does.
 *
 * The test's own server (tests/lib/own-server.mjs) on a fixed work registry: initiative "Alpha launch" (lead
 * Architecture) with project "Login form" and four Ops tasks: #5 working, #6 working, #7 stuck, #9 blocked on
 * Temper #113. No lead posts. The live-progress fields #270's server adds (docs/live-progress.md) are laid
 * over the server's own work_page messages on their way to the page, as the contract gives them: #6's progress
 * line, #7's question with Ops (withLead), and #5's done summary once the registry says it is done. Headless
 * Chrome at 1400x900, then 390x844 (phone); the page is a script-free same-origin frame, read from the host.
 *  1. Latest updates starts with "#6 Writing the search tests" by Ops (a progress line, no lead post);
 *  2. #6's row shows its progress line with its age; #9's row "Waits on Temper #113 · Temper owes the
 *     dispatcher"; #7's row "Question with Ops", and nothing is waiting on the owner (Needs you 0);
 *  3. the chip and filter read "Blocked"; "Needs attention" appears nowhere, in the frame or the host page;
 *  4. a task-done record is appended to the registry: within one refresh (6 s) Latest updates starts with
 *     "#5 done: Form shipped and checked." by Ops, the registry's bare "done" line giving way to it;
 *  5. on a phone the same words show and nothing scrolls sideways.
 * And: no page errors; the server never writes the registry; the stand-in model is never called.
 * Usage: npm run build && node tests/run-sealed.mjs --no-build initiatives-live-test
 *   INITIATIVES_LIVE_SHOT=<dir>: also screenshots (the fixture only).
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";

const SHOTS = process.env.INITIATIVES_LIVE_SHOT || "";
const TZ = "America/Los_Angeles";
/** H-INIT-LIVE-1: one refresh (the server looks every 5 s, then settles 0.5 s). */
const REFRESH_MS = 6_000;
if (!CHROME_PATH) {
	console.log("FAIL no Chrome for the test (set PI_WEB_CHROME)");
	process.exit(1);
}

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}
async function until(fn, ms = 20_000, every = 100) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const v = await fn();
		if (v) return v;
		await sleep(every);
	}
	return null;
}

// ---- the fixed registry, in minutes before the test started ---------------------------------------------------
const T = Date.now();
const ago = (min) => T - min * 60_000;
const SUMMARY = "Form shipped and checked.";
const PROGRESS = "Writing the search tests";
const TASKS = [
	[5, "Ship the form", "working"],
	[6, "Wire the search", "working"],
	[7, "Pick the copy", "stuck"],
	[9, "Wait for Temper", "blocked"],
];
let workFile;
let queueFile;
let seq = 0;
const ev = (ts, by, e) => ({ v: 1, seq: ++seq, ts, by, ...e });
const added = (n) => ago(200) + n;
function seed({ root, agentDir }) {
	// A link whose queue file is gone is left out of the page: any file there will do.
	mkdirSync(join(root, "queues"), { recursive: true });
	queueFile = join(root, "queues", "ops-home.jsonl");
	writeFileSync(queueFile, "");
	const events = [
		ev(ago(100), "owner", {
			op: "initiative.create",
			id: "alpha",
			name: "Alpha launch",
			outcome: "Alpha ships to its first users",
			doneWhen: ["Alpha is live", "Owner checked it"],
			lead: "architecture",
		}),
		ev(ago(90), "owner", {
			op: "project.create",
			id: "p-login",
			name: "Login form",
			outcome: "The login form works",
			doneWhen: ["Form works", "Search works"],
			lead: "frontend",
			initiative: "alpha",
		}),
		...TASKS.map(([n, title]) =>
			ev(ago(80), "ops", {
				op: "task.link",
				queue: queueFile,
				queueName: "ops",
				task: n,
				added: added(n),
				title,
				parent: { project: "p-login" },
			}),
		),
		ev(ago(70), "ops", { op: "task.state", queue: queueFile, task: 5, added: added(5), status: "working" }),
		ev(ago(60), "ops", { op: "task.state", queue: queueFile, task: 6, added: added(6), status: "working" }),
		ev(ago(50), "ops", {
			op: "task.state",
			queue: queueFile,
			task: 9,
			added: added(9),
			status: "blocked",
			block: { on: ["Temper #113"], lead: "temper", owes: "the dispatcher", reminders: 0, since: ago(50) },
		}),
		ev(ago(20), "ops", { op: "task.state", queue: queueFile, task: 7, added: added(7), status: "stuck" }),
	];
	const workDir = join(agentDir, "work");
	mkdirSync(workDir, { recursive: true });
	workFile = join(workDir, "events.jsonl");
	writeFileSync(workFile, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

/** The live-progress fields #270's server adds (docs/live-progress.md), as the contract gives them. */
function liveFields(t) {
	if (t.task === 6) return { progress: { text: PROGRESS, at: ago(3) } };
	if (t.task === 7) return { withLead: "ops" };
	if (t.task === 5 && t.state === "done") return { doneSummary: SUMMARY };
	return {};
}
let pagesSeen = 0;
function overlay(text) {
	let msg;
	try {
		msg = JSON.parse(text);
	} catch {
		return text;
	}
	if (msg?.type !== "work_page" || !Array.isArray(msg.page?.tasks)) return text;
	pagesSeen++;
	msg.page.tasks = msg.page.tasks.map((t) => ({ ...t, ...liveFields(t) }));
	return JSON.stringify(msg);
}

let modelCalls = 0;
const srv = await ownServer({
	name: "initiatives-live",
	verbose: !!process.env.INITIATIVES_DEBUG,
	prepare: seed,
	mock: () => {
		modelCalls++;
		return "unused";
	},
	env: {
		TZ,
		get PI_WORK_DIR() {
			return join(workFile, "..");
		},
	},
});
let expected = readFileSync(workFile, "utf8");

/** What the page shows, read from the host (the frame runs no script). */
function look(page) {
	return page.evaluate(() => {
		const frame = document.querySelector('iframe[title="Initiatives"]');
		const doc = frame?.contentDocument;
		if (!doc?.body) return null;
		const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();
		const heading = [...doc.querySelectorAll("h3")].find((h) => norm(h.textContent) === "Latest updates");
		const box = heading?.parentElement?.parentElement;
		const latest = box
			? [...box.querySelectorAll("ol > li")].map((li) => [...li.children].map((e) => norm(e.textContent)))
			: null;
		const who = doc.querySelector('section[aria-labelledby="who"]');
		/** A task row's text: from its number up to the row, the first box that holds its "updated" line. */
		const row = (n) => {
			const mono = who && [...who.querySelectorAll("span")].find((s) => norm(s.textContent) === `#${n}`);
			let el = mono;
			while (el && el !== who && !/updated /.test(el.textContent ?? "")) el = el.parentElement;
			return el && el !== who ? norm(el.textContent) : null;
		};
		const pills = [...doc.querySelectorAll('[role="group"][aria-label="Filter initiatives"] button')].map((b) =>
			norm(b.textContent),
		);
		const card = [...doc.querySelectorAll("nav button")].find((b) => norm(b.textContent).startsWith("Alpha launch"));
		return {
			latest,
			rows: { 5: row(5), 6: row(6), 7: row(7), 9: row(9) },
			pills,
			card: card ? norm(card.textContent) : null,
			frameText: norm(doc.body.textContent),
			hostText: norm(document.body.innerText),
			frameOverflow: doc.documentElement.scrollWidth - frame.clientWidth,
			pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
		};
	});
}

/** The page's words that must hold on any page (before and after #5 is done). */
function checkWords(tag, s) {
	check(
		`${tag}: #6's row shows its progress line with its age`,
		new RegExp(`${PROGRESS} \u00b7 (just now|\\d+m ago)`).test(s.rows[6] ?? ""),
		s.rows[6],
	);
	check(
		`${tag}: #9's row says what it waits on`,
		(s.rows[9] ?? "").includes("Waits on Temper #113 \u00b7 Temper owes the dispatcher"),
		s.rows[9],
	);
	check(
		`${tag}: #7's row reads "Question with Ops", not Needs you`,
		(s.rows[7] ?? "").includes("Question with Ops") && !(s.rows[7] ?? "").includes("Needs you"),
		s.rows[7],
	);
	check(
		`${tag}: nothing is waiting on the owner`,
		s.frameText.includes("Nothing is waiting on you.") && s.pills.includes("Needs you 0"),
		JSON.stringify(s.pills),
	);
	check(
		`${tag}: the filter and the card read Blocked`,
		s.pills.includes("Blocked 1") && /Blocked/.test(s.card ?? ""),
		JSON.stringify([s.pills, s.card]),
	);
	check(
		`${tag}: "Needs attention" appears nowhere`,
		!s.frameText.includes("Needs attention") && !s.hostText.includes("Needs attention"),
	);
}

const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
let pageErrors = 0;
async function open(tag, width, height, phone) {
	const context = await browser.newContext({
		viewport: { width, height },
		deviceScaleFactor: 1,
		isMobile: phone,
		hasTouch: phone,
		locale: "en-US",
		timezoneId: TZ,
		reducedMotion: "reduce",
	});
	await context.addInitScript(() => localStorage.setItem("pi-web-ui:lang", "en"));
	// The page's socket goes through as it is; only the work page gets the contract's live-progress fields.
	await context.routeWebSocket(/./, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((m) => server.send(m));
		server.onMessage((m) => ws.send(typeof m === "string" ? overlay(m) : m));
	});
	const page = await context.newPage();
	page.on("pageerror", (err) => {
		pageErrors++;
		console.log(`page error (${tag}): ${String(err.message).split("\n")[0]}`);
	});
	await page.goto(`${srv.http}/?view=initiatives`);
	return { context, page };
}
try {
	// ---- 1400x900: the live page, then #5 is done ----
	{
		const { context, page } = await open("1400", 1400, 900, false);
		const first = await until(async () => {
			const s = await look(page);
			return s?.latest?.length && s.rows[9] ? s : null;
		}, 30_000);
		check("1400: the page shows Latest updates and the tasks", !!first, JSON.stringify(await look(page)));
		if (first) {
			check(
				`1400: Latest updates starts with #6's progress line by Ops`,
				first.latest[0][1] === "Ops" &&
					first.latest[0][2] === `#6 ${PROGRESS}` &&
					/^\d\d:\d\d$/.test(first.latest[0][0]),
				JSON.stringify(first.latest),
			);
			checkWords("1400", first);
			if (SHOTS) {
				mkdirSync(SHOTS, { recursive: true });
				await page.screenshot({ path: join(SHOTS, "1400-before.png"), fullPage: true });
			}

			// A task-done record, as pi-queue writes it; no lead post.
			const done = ev(Date.now(), "ops", {
				op: "task.state",
				queue: queueFile,
				task: 5,
				added: added(5),
				status: "done",
			});
			const line = `${JSON.stringify(done)}\n`;
			appendFileSync(workFile, line);
			expected += line;
			const t0 = Date.now();
			const after = await until(
				async () => {
					const s = await look(page);
					return s?.latest?.[0]?.[2]?.startsWith("#5 done") ? s : null;
				},
				REFRESH_MS + 4_000,
				50,
			);
			const took = Date.now() - t0;
			console.log(`  the done record showed in Latest updates after ${took} ms`);
			check(
				`1400: within one refresh (${REFRESH_MS} ms) Latest updates starts with #5's done summary by Ops`,
				!!after && took <= REFRESH_MS && after.latest[0][1] === "Ops" && after.latest[0][2] === `#5 done: ${SUMMARY}`,
				JSON.stringify([took, after?.latest]),
			);
			if (after) {
				check(
					"1400: then #6's progress line; three lines; the registry's bare done line gives way",
					after.latest.length === 3 &&
						after.latest[1][2] === `#6 ${PROGRESS}` &&
						!after.latest.some((l) => /\u201cShip the form\u201d: done/.test(l[2])),
					JSON.stringify(after.latest),
				);
				check("1400: #5 leaves the open rows", !after.rows[5], after.rows[5]);
				checkWords("1400 after", after);
				if (SHOTS) await page.screenshot({ path: join(SHOTS, "1400-after.png"), fullPage: true });
			}
		}
		await context.close();
	}
	// ---- 390x844 (phone): the same words, nothing sideways ----
	{
		const { context, page } = await open("390", 390, 844, true);
		const s = await until(async () => {
			const v = await look(page);
			return v?.latest?.[0]?.[2]?.startsWith("#5 done") && v.rows[9] ? v : null;
		}, 30_000);
		check("390: the page shows #5's done summary first", !!s, JSON.stringify(await look(page)));
		if (s) {
			checkWords("390", s);
			check("390: no sideways scroll", s.frameOverflow <= 1 && s.pageOverflow <= 1, JSON.stringify(s));
			if (SHOTS) await page.screenshot({ path: join(SHOTS, "390.png"), fullPage: true });
		}
		await context.close();
	}
} finally {
	await browser.close();
	await srv.stop();
}
check("the page got the work page through the socket", pagesSeen >= 2, String(pagesSeen));
check("no page errors", pageErrors === 0, String(pageErrors));
check("the server never writes the registry", readFileSync(workFile, "utf8") === expected);
check("the model was never called", modelCalls === 0, String(modelCalls));
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
