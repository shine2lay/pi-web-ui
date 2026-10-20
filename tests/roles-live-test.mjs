/* roles-live (Ops #272, docs/live-progress.md, H-ROLES-LIVE-1's sealed parts): one role with a working task whose
 * own chat has a TL;DR line, a done task with a queue_done summary, and a line in its home chat. On the Roles page,
 * the role's panel shows the working task's Latest progress with that line's time (it said "Not recorded"); a new
 * line written in the task chat shows within one overview refresh (at most 4 s), with its time; and Activity lists
 * the task lines ("#N <line>"), the done summary ("#N done: <summary>") and the home line, newest first, each timed.
 * Real server and page, Chrome; no model is ever asked. Until Ops #270's server sends doneRecent, the test adds it
 * on the wire exactly as #270 builds it from the same done record (the contract's fixture); a server that sends it
 * is used as it is. Output is fixed labels, counts and times only, never chat text.
 * Run after build: scripts/sealed.sh node tests/roles-live-test.mjs
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";
if (!process.env.PI_SEALED) throw new Error("Run with scripts/sealed.sh");
if (!CHROME_PATH) throw new Error("Chrome is required");

const ROLE = "design";
const ROLE_TITLE = "Fixture Design";
const MIN = 60_000;
const now = Date.now();
/** Queue records an hour back, so the task's line (10 min back) is newer than its "started" milestone. */
const T_OPS = now - 60 * MIN;
const T_HOME = now - 30 * MIN;
const T_DONE = now - 20 * MIN;
const T_FIRST = now - 10 * MIN;
const HOME_LINE = "Fixture home line";
const FIRST_LINE = "Fixture first task line";
const NEW_LINE = "Fixture newer task line";
const DONE_SUMMARY = "Fixture done summary";
/** What Ops #270's server sends for the seeded done record (docs/live-progress.md, UiRoleDoneTask). */
const FIXTURE_DONE = [{ id: 2, title: "Fixture task 2", summary: DONE_SUMMARY, at: T_DONE }];
/** One overview refresh: the server looks every 3 s while a Roles page is open (RolesWatch fullMs). */
const REFRESH_LIMIT_MS = 4000;
/** The page shows what an overview brings this soon after it arrives. */
const PAGE_LIMIT_MS = 1000;

let identities, work, taskChat;
let lastId = null;
let failures = 0,
	pageErrors = 0;
const check = (name, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
	if (!ok) failures++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hhmm = (t) => {
	const d = new Date(t);
	return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function seed({ root, agentDir, workdir }) {
	const settings = join(agentDir, "settings.json");
	writeFileSync(
		settings,
		JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), compaction: { enabled: false } }),
	);
	const sessions = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(sessions, { recursive: true });
	const idOf = (n) => `01a0f000-0000-7000-8000-${String(n).padStart(12, "0")}`;
	const fileOf = (n) => join(sessions, `2026-10-19T00-00-${String(n).padStart(2, "0")}-000Z_${idOf(n)}.jsonl`);
	/** A saved chat: its header, a model line, then the given custom entries (queue records, TL;DR lines). */
	function transcript(file, id, entries) {
		let parentId = null;
		const lines = [{ type: "session", version: 3, id, timestamp: new Date(T_OPS).toISOString(), cwd: workdir }];
		const append = (entry) => {
			const row = { id: `f${lines.length}`, parentId, timestamp: new Date(T_OPS).toISOString(), ...entry };
			lines.push(row);
			parentId = row.id;
		};
		append({ type: "model_change", provider: "mock", modelId: "mock-model" });
		for (const entry of entries) append(entry);
		writeFileSync(file, `${lines.map((row) => JSON.stringify(row)).join("\n")}\n`);
		return parentId;
	}
	const queue = (op) => ({ type: "custom", customType: "queue", data: { v: 1, ts: T_OPS, ...op } });
	const tldr = (text, ts) => ({ type: "custom", customType: "tldr", data: { v: 1, text, needsYou: false, ts } });
	const home = fileOf(1);
	taskChat = fileOf(2);
	const doneChat = fileOf(3);
	lastId = transcript(taskChat, idOf(2), [tldr(FIRST_LINE, T_FIRST)]);
	transcript(doneChat, idOf(3), []);
	const plan = (i) => ({
		title: `Fixture task ${i}`,
		goal: "Fixture",
		doneWhen: "Never",
		decided: "Fixture only",
		steps: "Wait",
		verify: "None",
		mustNot: "Touch live state",
	});
	transcript(home, idOf(1), [
		queue({ op: "lanes", n: 2 }),
		queue({ op: "add", id: 1, plan: plan(1), standalone: true, touches: ["fixture-1"] }),
		queue({ op: "add", id: 2, plan: plan(2), standalone: true, touches: ["fixture-2"] }),
		queue({ op: "run" }),
		queue({ op: "start", id: 1, lane: true }),
		queue({ op: "chat", id: 1, file: taskChat, title: "Fixture task chat 1" }),
		queue({ op: "start", id: 2, lane: true }),
		queue({ op: "chat", id: 2, file: doneChat, title: "Fixture task chat 2" }),
		queue({ op: "done", id: 2, summary: DONE_SUMMARY, ts: T_DONE }),
		tldr(HOME_LINE, T_HOME),
	]);
	identities = join(root, "identities");
	work = join(agentDir, "work");
	mkdirSync(join(identities, ROLE), { recursive: true });
	writeFileSync(
		join(identities, ROLE, "identity.json"),
		JSON.stringify({ id: ROLE, title: ROLE_TITLE, homeChat: home }),
	);
	writeFileSync(join(identities, ROLE, "about.md"), `# ${ROLE_TITLE}\n`);
	writeFileSync(join(identities, ROLE, "notebook.md"), "");
}
/** Writes a TL;DR line into the task's own chat, as pi-tldr does. */
function writeLine(text, ts) {
	const row = {
		type: "custom",
		customType: "tldr",
		data: { v: 1, text, needsYou: false, ts },
		id: "f-new",
		parentId: lastId,
		timestamp: new Date(ts).toISOString(),
	};
	appendFileSync(taskChat, `${JSON.stringify(row)}\n`);
	lastId = row.id;
}

const srv = await ownServer({
	name: "roles-live",
	prepare: seed,
	env: {
		PI_WEB_TOKEN: "",
		PI_IDENTITY_REINDEX: "0",
		get PI_IDENTITY_DIR() {
			return identities;
		},
		get PI_WORK_DIR() {
			return work;
		},
	},
});
let browser;
const hardStop = setTimeout(() => {
	console.error("FAIL bounded fixture timeout");
	process.exitCode = 1;
	void srv.stop();
}, 180000);
hardStop.unref();
/** Whether the server itself sent doneRecent (null: no overview seen yet). */
let serverDone = null;
let overviews = 0;
/** When the first overview carrying the new line reached this process (on its way to the page). */
let newLineAt = null;
/** Server -> page: an overview passes as it is; one without doneRecent gets the contract's fixture. */
function relay(message) {
	if (typeof message !== "string" || !message.startsWith('{"type":"roles"')) return message;
	let msg;
	try {
		msg = JSON.parse(message);
	} catch {
		return message;
	}
	const row = msg.overview?.roles?.find((r) => r?.id === ROLE);
	if (!row) return message;
	overviews++;
	if (newLineAt === null && message.includes(NEW_LINE)) newLineAt = Date.now();
	serverDone ??= "doneRecent" in row;
	if ("doneRecent" in row) return message;
	row.doneRecent = FIXTURE_DONE;
	return JSON.stringify(msg);
}
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const context = await browser.newContext({
		viewport: { width: 1440, height: 1000 },
		locale: "en-US",
		timezoneId: "UTC",
	});
	await context.routeWebSocket(/\/ws(\?|$)/, (ws) => {
		const server = ws.connectToServer();
		server.onMessage((message) => ws.send(relay(message)));
	});
	const page = await context.newPage();
	page.on("pageerror", () => {
		pageErrors++;
	});
	await page.goto(`${srv.http}/?view=roles`);
	const frame = page.frameLocator('iframe[title="Roles"]');
	const card = frame.locator('button[aria-haspopup="dialog"]', { hasText: ROLE_TITLE }).first();
	await card.waitFor({ timeout: 30000 });
	await card.click();
	/** The open panel's Latest progress (its words and time) and its Activity rows ([time, text]). */
	const readPanel = () =>
		page.evaluate(() => {
			const region = document.querySelector('iframe[title="Roles"]')?.contentDocument?.querySelector('[role="region"]');
			if (!region) return null;
			const dt = [...region.querySelectorAll("dt")].find((d) => d.textContent.trim() === "Latest progress");
			const h3 = [...region.querySelectorAll("h3")].find((h) => h.textContent.trim() === "Recent activity");
			const section = h3?.closest("section");
			return {
				progress: dt?.nextElementSibling?.textContent.replace(/\s+/g, " ").trim() ?? null,
				acts: section
					? [...section.querySelectorAll("ul > li")].map((li) =>
							[...li.querySelectorAll(":scope > span")].map((s) => s.textContent.trim()),
						)
					: null,
			};
		});
	const until = async (test, ms) => {
		const end = Date.now() + ms;
		for (;;) {
			const panel = await readPanel();
			if (panel && test(panel)) return { panel, at: Date.now() };
			if (Date.now() >= end) return { panel, at: null };
			await sleep(50);
		}
	};
	const firstProgress = `${FIRST_LINE} · ${hhmm(T_FIRST)}`;
	const before = await until((p) => p.progress === firstProgress, 15000);
	check("a working task's Latest progress shows its own chat's line with that line's time", before.at !== null);
	check('its time is recorded (not "Not recorded")', !(before.panel?.progress ?? "").includes("Not recorded"));
	const doneRow = [hhmm(T_DONE), `#2 done: ${DONE_SUMMARY}`];
	check(
		"Activity: the task line, the done summary and the home line, newest first, each with its time",
		same(before.panel?.acts, [[hhmm(T_FIRST), `#1 ${FIRST_LINE}`], doneRow, [hhmm(T_HOME), HOME_LINE]]),
	);

	// A new line in the task chat, as pi-tldr writes it.
	const written = Date.now();
	writeLine(NEW_LINE, written);
	const after = await until((p) => p.progress === `${NEW_LINE} · ${hhmm(written)}`, 15000);
	const took = after.at === null ? null : after.at - written;
	console.log(`new line shown after ${took === null ? "never" : `${took} ms`} (${overviews} overviews seen)`);
	check(
		`the new line shows in Latest progress with its time within ${REFRESH_LIMIT_MS} ms`,
		took !== null && took <= REFRESH_LIMIT_MS,
	);
	check(
		`the page shows it within ${PAGE_LIMIT_MS} ms of the overview that brings it`,
		after.at !== null && newLineAt !== null && after.at - newLineAt <= PAGE_LIMIT_MS,
	);
	check(
		"Activity: the new line first, then the older line, the done summary and the home line",
		same(after.panel?.acts, [
			[hhmm(written), `#1 ${NEW_LINE}`],
			[hhmm(T_FIRST), `#1 ${FIRST_LINE}`],
			doneRow,
			[hhmm(T_HOME), HOME_LINE],
		]),
	);
	console.log(`doneRecent ${serverDone ? "sent by the server" : "added on the wire (the server leaves it out)"}`);
	check("no page errors", pageErrors === 0);
} catch (error) {
	console.error(`FAIL ${error instanceof Error ? error.message : "fixture error"}`);
	failures++;
} finally {
	clearTimeout(hardStop);
	await browser?.close().catch(() => {});
	await srv.stop();
}
console.log(failures ? `roles-live: ${failures} failed` : "roles-live: all passed");
process.exitCode = failures ? 1 : 0;
