/* roles-live (Ops #272 H-ROLES-LIVE-1's sealed parts, retargeted onto the roles-by-project page by frontend #299):
 * one role with a working task and a done task whose queue_done summary is on record. On the Roles page (root .rbp,
 * grouped by Department), the role's opened tile shows the working task as Working and the done task with its
 * summary; a task finished in the role's home chat (a real queue record, as pi-queue writes it) shows as Done with
 * its own summary within one overview refresh (at most 4 s), and within 1 s of the overview that brings it.
 * The old page's per-role "Latest progress" and "Recent activity" (TL;DR lines) are not on the new page by design
 * (spec-page.md, design-elements.md: tiles and task maps only), so they are no longer checked here.
 * Real server and page, Chrome; no model is ever asked. Output is fixed labels, counts and times only.
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
const T_OPS = now - 60 * MIN;
const T_DONE = now - 20 * MIN;
const DONE_SUMMARY = "Fixture done summary";
const NEW_SUMMARY = "Fixture newer done summary";
/** One overview refresh: the server looks every 3 s while a Roles page is open (RolesWatch fullMs). */
const REFRESH_LIMIT_MS = 4000;
/** The page shows what an overview brings this soon after it arrives. */
const PAGE_LIMIT_MS = 1000;

let identities, work, home;
let homeLast = null;
let failures = 0,
	pageErrors = 0;
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` (${detail})`}`);
	if (!ok) failures++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
	/** A saved chat: its header, a model line, then the given custom entries (queue records). */
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
	home = fileOf(1);
	const taskChat = fileOf(2);
	const doneChat = fileOf(3);
	transcript(taskChat, idOf(2), []);
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
	homeLast = transcript(home, idOf(1), [
		queue({ op: "lanes", n: 2 }),
		queue({ op: "add", id: 1, plan: plan(1), standalone: true, touches: ["fixture-1"] }),
		queue({ op: "add", id: 2, plan: plan(2), standalone: true, touches: ["fixture-2"] }),
		queue({ op: "run" }),
		queue({ op: "start", id: 1, lane: true }),
		queue({ op: "chat", id: 1, file: taskChat, title: "Fixture task chat 1" }),
		queue({ op: "start", id: 2, lane: true }),
		queue({ op: "chat", id: 2, file: doneChat, title: "Fixture task chat 2" }),
		queue({ op: "done", id: 2, summary: DONE_SUMMARY, ts: T_DONE }),
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
/** Finishes task 1 in the role's home chat, as pi-queue's queue_done records it. */
function finishTask(summary, ts) {
	const row = {
		type: "custom",
		customType: "queue",
		data: { v: 1, ts, op: "done", id: 1, summary },
		id: "f-done-1",
		parentId: homeLast,
		timestamp: new Date(ts).toISOString(),
	};
	appendFileSync(home, `${JSON.stringify(row)}\n`);
	homeLast = row.id;
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
let overviews = 0;
/** When the first overview carrying the new summary reached the page. */
let newAt = null;
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const context = await browser.newContext({
		viewport: { width: 1440, height: 1000 },
		locale: "en-US",
		timezoneId: "UTC",
	});
	const page = await context.newPage();
	page.on("pageerror", () => {
		pageErrors++;
	});
	page.on("websocket", (ws) =>
		ws.on("framereceived", ({ payload }) => {
			if (typeof payload !== "string" || !payload.startsWith('{"type":"roles"')) return;
			overviews++;
			if (newAt === null && payload.includes(NEW_SUMMARY)) newAt = Date.now();
		}),
	);
	await page.goto(`${srv.http}/?view=roles`);
	const root = page.locator(".rbp");
	await root.getByRole("radio", { name: "Department" }).click({ timeout: 30000 });
	const tile = root.locator("button[aria-expanded]").filter({ hasText: ROLE_TITLE }).first();
	await tile.waitFor({ timeout: 30000 });
	await tile.click();
	/** Task N's card on the page: its state pill's words and its text (null when absent). */
	const readCards = () =>
		root.evaluate((el, role) => {
			const card = (n) => {
				const c = el.querySelector(`article.rbp-task[data-ref="${role} #${n}"]`);
				return c
					? {
							pill: c.querySelector(".rbp-pill")?.textContent.trim() ?? null,
							text: c.textContent.replace(/\s+/g, " ").trim(),
						}
					: null;
			};
			return { one: card(1), two: card(2) };
		}, ROLE);
	const until = async (test, ms) => {
		const end = Date.now() + ms;
		for (;;) {
			const cards = await readCards();
			if (test(cards)) return { cards, at: Date.now() };
			if (Date.now() >= end) return { cards, at: null };
			await sleep(50);
		}
	};
	const before = await until((c) => c.one?.pill === "Working" && !!c.two, 15000);
	check(
		"the role's opened tile shows its working task as Working",
		before.at !== null,
		JSON.stringify(before.cards?.one),
	);
	check(
		"and its done task as Done with its queue_done summary",
		before.cards?.two?.pill === "Done" && before.cards.two.text.includes(DONE_SUMMARY),
		JSON.stringify(before.cards?.two),
	);

	// Task 1 finishes in the home chat, as pi-queue writes it.
	const written = Date.now();
	finishTask(NEW_SUMMARY, written);
	const after = await until((c) => c.one?.pill === "Done" && c.one.text.includes(NEW_SUMMARY), 15000);
	const took = after.at === null ? null : after.at - written;
	console.log(`finished task shown after ${took === null ? "never" : `${took} ms`} (${overviews} overviews seen)`);
	check(
		`a task finished in the home chat shows as Done with its summary within ${REFRESH_LIMIT_MS} ms`,
		took !== null && took <= REFRESH_LIMIT_MS,
		JSON.stringify(after.cards?.one),
	);
	check(
		`the page shows it within ${PAGE_LIMIT_MS} ms of the overview that brings it`,
		after.at !== null && newAt !== null && after.at - newAt <= PAGE_LIMIT_MS,
	);
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
