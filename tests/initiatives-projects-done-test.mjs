/* initiatives-projects-done E2E (Ops #274, H-PROJECTS-DONE-1 in docs/initiatives-projects-done.md; no tokens, no
 * live data): the Initiatives page shows an initiative's finished projects at a glance.
 *
 * The test's own server (tests/lib/own-server.mjs) on a fixed work registry (pi-work-management's events): one
 * initiative with 2 done, 1 dropped and 4 active projects. Headless Chrome at 1400x900 and 390x844 (phone);
 * the page is drawn in a script-free same-origin frame, so it is read from the host. At each size:
 *  1. the card reads "2 of 6 projects done · 1 dropped", on its own line under its outcomes count;
 *  2. "Who's doing what" starts with the fold "Finished projects · 3" ("latest Sat Oct 17"), closed, above the
 *     first active row, its line at least 44 px high;
 *  3. while it is closed, no finished project shows in the section;
 *  4. a click opens it: 3 rows, newest first, each with its lead, done-when count and "done/dropped <date>",
 *     every finished project's name inside the fold and none among the active rows;
 *  5. a finished project's name opens that project; nothing scrolls sideways.
 * And: the registry keeps its bytes; the stand-in model is never called.
 * Usage: npm run build && node tests/run-sealed.mjs --no-build initiatives-projects-done-test
 *   INITIATIVES_PROJECTS_SHOT=<dir>: also screenshots (the fixture only).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";

const SHOTS = process.env.INITIATIVES_PROJECTS_SHOT || "";
const TZ = "America/Los_Angeles";
if (!CHROME_PATH) {
	console.log("FAIL no Chrome for the test (set PI_WEB_CHROME)");
	process.exit(1);
}

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}
async function until(fn, ms = 20_000, every = 150) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const v = await fn();
		if (v) return v;
		await sleep(every);
	}
	return null;
}
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

// ---- the fixed registry: noon in Los Angeles on each day, so the dates read the same in any US zone or UTC --
const day = (d) => Date.parse(`2026-10-${String(d).padStart(2, "0")}T19:00:00.000Z`);
const PROJECTS = [
	["p-search", "Search box", "backend", ["Box shows", "Results rank", "Owner tried it"]],
	["p-login", "Login form", "frontend", ["Form works", "Errors read well"]],
	["p-idea", "Old idea", "design", ["Idea tested"]],
	["p-one", "Lane one", "frontend", ["One works", "One checked"]],
	["p-two", "Lane two", "backend", ["Two works", "Two checked"]],
	["p-three", "Lane three", "qa", ["Three works"]],
	["p-four", "Lane four", "docs", ["Four works"]],
];
const FINISHED = ["Search box", "Login form", "Old idea"];
let workDir;
let workFile;
function seed({ agentDir }) {
	let seq = 0;
	const ev = (ts, e) => ({ v: 1, seq: ++seq, ts, by: "owner", ...e });
	const events = [
		ev(day(10), {
			op: "initiative.create",
			id: "alpha",
			name: "Alpha launch",
			outcome: "Alpha ships to its first users",
			doneWhen: ["Alpha is live", "Docs say so", "Owner checked it"],
			lead: "architecture",
		}),
		...PROJECTS.map(([id, name, lead, doneWhen]) =>
			ev(day(10), {
				op: "project.create",
				id,
				name,
				outcome: `${name} is done right`,
				doneWhen,
				lead,
				initiative: "alpha",
			}),
		),
		...PROJECTS[0][3].map((item) => ev(day(14), { op: "project.met", id: "p-search", item, proof: "checked" })),
		...PROJECTS[1][3].map((item) => ev(day(14), { op: "project.met", id: "p-login", item, proof: "checked" })),
		ev(day(14), { op: "project.met", id: "p-two", item: "Two works", proof: "checked" }),
		ev(day(15), { op: "project.change", id: "p-idea", changes: { status: "dropped" } }),
		ev(day(16), { op: "project.change", id: "p-search", changes: { status: "done" } }),
		ev(day(17), { op: "project.change", id: "p-login", changes: { status: "done" } }),
	];
	workDir = join(agentDir, "work");
	mkdirSync(workDir, { recursive: true });
	workFile = join(workDir, "events.jsonl");
	writeFileSync(workFile, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

let modelCalls = 0;
const srv = await ownServer({
	name: "initiatives-projects-done",
	verbose: !!process.env.INITIATIVES_DEBUG,
	prepare: seed,
	mock: () => {
		modelCalls++;
		return "unused";
	},
	env: {
		TZ,
		get PI_WORK_DIR() {
			return workDir;
		},
	},
});
const before = sha(workFile);

/** What the page shows, read from the host (the frame runs no script). */
function look(page) {
	return page.evaluate((finished) => {
		const frame = document.querySelector('iframe[title="Initiatives"]');
		const doc = frame?.contentDocument;
		if (!doc) return null;
		const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();
		const box = (el) => {
			const r = el.getBoundingClientRect();
			return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
		};
		const leaf = (root, text) =>
			[...root.querySelectorAll("button, span, p")].filter(
				(e) => norm(e.textContent) === text && !e.querySelector("button, span, p"),
			);
		const card = [...doc.querySelectorAll("button")].find((b) => norm(b.textContent).startsWith("Alpha launch"));
		const outcomes =
			card &&
			[...card.querySelectorAll("span")].find(
				(s) => / outcomes done$/.test(norm(s.textContent)) && !s.querySelector("span"),
			);
		const projects =
			card &&
			[...card.querySelectorAll("span")].find(
				(s) => / projects? done/.test(norm(s.textContent)) && !s.querySelector("span"),
			);
		const who = doc.querySelector('section[aria-labelledby="who"]');
		const fold =
			who &&
			[...who.querySelectorAll("button[aria-expanded]")].find((b) =>
				norm(b.textContent).startsWith("Finished projects"),
			);
		const foldBox = fold?.parentElement;
		const firstActive = who && leaf(who, "Lane one")[0];
		const rows = foldBox ? [...foldBox.querySelectorAll("li")] : [];
		const names = who ? finished.flatMap((n) => leaf(who, n)) : [];
		return {
			outcomesText: outcomes ? norm(outcomes.textContent) : null,
			projectsText: projects ? norm(projects.textContent) : null,
			projectsUnder: !!(outcomes && projects) && box(projects).top >= box(outcomes).bottom - 1,
			foldParts: fold ? [...fold.children].map((e) => norm(e.textContent)).filter(Boolean) : null,
			expanded: fold?.getAttribute("aria-expanded") ?? null,
			foldHeight: fold ? box(fold).height : 0,
			foldAboveFirstActive: !!(fold && firstActive) && box(fold).bottom <= box(firstActive).top,
			firstActive: !!firstActive,
			rows: rows.map((li) => [...li.children].map((e) => norm(e.textContent)).filter(Boolean)),
			namesShown: names.length,
			namesOutsideFold: names.filter((e) => !foldBox?.contains(e)).length,
			namesBelowFirstActive: firstActive ? names.filter((e) => box(e).top >= box(firstActive).top).length : -1,
			heading: norm(doc.getElementById("ititle")?.textContent),
			frameOverflow: doc.documentElement.scrollWidth - frame.clientWidth,
			pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
		};
	}, FINISHED);
}

const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
let pageErrors = 0;
try {
	for (const [tag, width, height, phone] of [
		["1400", 1400, 900, false],
		["390", 390, 844, true],
	]) {
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
		const page = await context.newPage();
		page.on("pageerror", (err) => {
			pageErrors++;
			console.log(`page error (${tag}): ${String(err.message).split("\n")[0]}`);
		});
		await page.goto(`${srv.http}/?view=initiatives`);
		const first = await until(async () => {
			const s = await look(page);
			return s?.projectsText && s.foldParts ? s : null;
		}, 30_000);
		check(`${tag}: the page shows the card and the fold`, !!first, JSON.stringify(await look(page)));
		if (!first) {
			await context.close();
			continue;
		}
		check(`${tag}: card counts outcomes`, first.outcomesText === "0 of 3 outcomes done", first.outcomesText);
		check(
			`${tag}: card reads "2 of 6 projects done · 1 dropped", on its own line under the outcomes`,
			first.projectsText === "2 of 6 projects done \u00b7 1 dropped" && first.projectsUnder,
			JSON.stringify([first.projectsText, first.projectsUnder]),
		);
		check(
			`${tag}: fold "Finished projects · 3", latest Sat Oct 17`,
			JSON.stringify(first.foldParts) === JSON.stringify(["Finished projects \u00b7 3", "latest Sat Oct 17"]),
			JSON.stringify(first.foldParts),
		);
		check(`${tag}: fold closed by default`, first.expanded === "false", first.expanded);
		check(`${tag}: fold line at least 44 px high`, first.foldHeight >= 44, String(first.foldHeight));
		check(
			`${tag}: fold above the first active row`,
			first.firstActive && first.foldAboveFirstActive,
			JSON.stringify([first.firstActive, first.foldAboveFirstActive]),
		);
		check(`${tag}: no finished project shows while it is closed`, first.namesShown === 0, String(first.namesShown));
		if (SHOTS) {
			mkdirSync(SHOTS, { recursive: true });
			await page.screenshot({ path: join(SHOTS, `${tag}-closed.png`) });
		}

		const frame = page.frameLocator('iframe[title="Initiatives"]');
		await frame
			.locator('section[aria-labelledby="who"] button[aria-expanded]', { hasText: "Finished projects" })
			.click();
		const open = await until(async () => {
			const s = await look(page);
			return s?.expanded === "true" && s.rows.length ? s : null;
		}, 10_000);
		check(`${tag}: a click opens the fold`, !!open, JSON.stringify(await look(page)));
		if (open) {
			check(
				`${tag}: 3 rows, newest first, with lead, count and date`,
				JSON.stringify(open.rows) ===
					JSON.stringify([
						["Login form", "Lead \u00b7 Frontend", "2 of 2 done", "done Sat Oct 17"],
						["Search box", "Lead \u00b7 Backend", "3 of 3 done", "done Fri Oct 16"],
						["Old idea", "Lead \u00b7 Design", "0 of 1 done", "dropped Thu Oct 15"],
					]),
				JSON.stringify(open.rows),
			);
			check(
				`${tag}: every finished project inside the fold, above the active rows; none among them`,
				open.namesShown === 3 && open.namesOutsideFold === 0 && open.namesBelowFirstActive === 0,
				JSON.stringify([open.namesShown, open.namesOutsideFold, open.namesBelowFirstActive]),
			);
			check(`${tag}: no sideways scroll`, open.frameOverflow <= 1 && open.pageOverflow <= 1, JSON.stringify(open));
			if (SHOTS) {
				await frame.locator('section[aria-labelledby="who"]').scrollIntoViewIfNeeded();
				await page.screenshot({ path: join(SHOTS, `${tag}-open.png`) });
			}
			await frame.locator('section[aria-labelledby="who"] li button', { hasText: "Search box" }).click();
			const opened = await until(async () => ((await look(page))?.heading === "Search box" ? true : null), 10_000);
			check(`${tag}: a finished project's name opens that project`, !!opened, (await look(page))?.heading);
		}
		await context.close();
	}
} finally {
	await browser.close();
	await srv.stop();
}
check("no page errors", pageErrors === 0, String(pageErrors));
check("the registry keeps its bytes", sha(workFile) === before);
check("the model was never called", modelCalls === 0, String(modelCalls));
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
