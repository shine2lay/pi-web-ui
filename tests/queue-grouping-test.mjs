/**
 * queue-grouping (fork patch, PATCHES.md): in the chat list, an open queued task's own chat
 * ("Queue #n: …") sits under the queue chat it came from (its home chat), the way a subagent sits under
 * its parent, and the home chat's toggle folds them away, remembered after a reload. Display only.
 *
 * A server of its own with a stand-in model (tests never call a real model) and five saved chats, the
 * way pi-queue leaves them: a queue chat ("tooling") with two open tasks, each running in a chat of its
 * own (task 1 working, task 2 on hold), a task chat whose queue chat isn't in the list, and a chat of the
 * user's. pi-queue itself isn't needed: the server reads the queue from the chats as they are.
 *  1. desktop: once the queue chat is open, both its task chats sit under it, newest first, titles
 *     unchanged; the other task chat and the user's chat stay rows of their own;
 *  2. a nested chat opens from its row, stays nested, and shows its working dot while it works;
 *  3. the toggle folds the group (the queue chat's row counts the hidden chats and shows one is
 *     working) without opening the queue chat; folded and unfolded both survive a reload;
 *  4. phone width: the same nesting in the chats drawer, a toggle big enough to tap, folding works.
 *
 * Usage: npm run build && node tests/queue-grouping-test.mjs
 *        GROUPING_SHOT=/tmp/qg saves screenshots /tmp/qg-*.png (the chat list, desktop and phone)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";

const SHOT = process.env.GROUPING_SHOT ?? "";
let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✓" : "✗ FAIL:"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures += 1;
}

const HOME = "tooling";
const TASK_A = "Queue #1: Paint the fence";
const TASK_B = "Queue #2: Wait for the paint to dry";
const ELSEWHERE = "Queue #3: A task from a queue chat that isn't listed";
const USER = "A chat of the user's";
const FOLDS_KEY = "pi-web-ui:lp-queue-folded";

// ---- the stand-in model: task 1's next turn is held until the test lets it go -----------------------
let letWorkFinish = () => {};
const held = new Promise((r) => {
	letWorkFinish = r;
});
const seen = { work: 0, other: 0 };
async function respond({ sideRequest, lastUser }) {
	if (sideRequest) return "Mock title";
	if (lastUser.includes("GROUPING-WORK")) {
		seen.work += 1;
		await held;
		return "GROUPING-WORK done.";
	}
	seen.other += 1;
	return "ok";
}

// ---- the saved chats, as pi-queue leaves them --------------------------------------------------------
const files = {};
function seed({ agentDir, workdir }) {
	const dir = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(dir, { recursive: true });
	const file = (stamp, n) => join(dir, `${stamp}_01a0f000-0000-7000-8000-0000000000a${n}.jsonl`);
	files.home = file("2026-09-30T10-00-00-000Z", 1);
	files.taskA = file("2026-09-30T10-01-00-000Z", 2);
	files.taskB = file("2026-09-30T10-02-00-000Z", 3);
	files.elsewhere = file("2026-09-30T10-03-00-000Z", 4);
	files.user = file("2026-09-30T10-04-00-000Z", 5);
	// Never written: the queue chat task 3 came from isn't in the list.
	const gone = file("2026-09-20T10-00-00-000Z", 6);

	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const user = (text) => ({ message: { role: "user", content: [{ type: "text", text }] } });
	const assistant = (text) => ({
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-completions",
			provider: "mock",
			model: "mock-model",
			usage,
			stopReason: "stop",
		},
	});
	const plan = (title) => ({
		title,
		goal: "A goal",
		doneWhen: "It is done",
		decided: "-",
		steps: "-",
		verify: "-",
		mustNot: "-",
	});
	const queue = (op) => ({ queue: op });
	const write = (path, start, name, items) => {
		let ts = Date.parse(start);
		const id = path.match(/_([^_]+)\.jsonl$/)?.[1];
		const lines = [
			{ type: "session", version: 3, id, timestamp: new Date(ts).toISOString(), cwd: workdir },
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
			lines.push(
				item.queue
					? { type: "custom", customType: "queue", ...base, data: { v: 1, ts, ...item.queue } }
					: { type: "message", ...base, message: { ...item.message, timestamp: ts } },
			);
			parentId = base.id;
		}
		lines.push({ type: "session_info", id: "name", parentId, timestamp: new Date(ts + 1000).toISOString(), name });
		writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	};
	const wait = (id) =>
		queue({
			op: "wait",
			id,
			what: "the paint to dry",
			check: "true",
			everyMs: 120_000,
			until: Date.now() + 86_400_000,
		});

	write(files.home, "2026-09-30T10:00:00.000Z", HOME, [
		user("GROUPING-HOME plan two tasks"),
		assistant("HOME-REPLY Two tasks are queued."),
		queue({ op: "add", id: 1, plan: plan("Paint the fence"), touches: ["fence repo"] }),
		queue({ op: "add", id: 2, plan: plan("Wait for the paint to dry"), touches: ["paint repo"] }),
		queue({ op: "start", id: 1, lane: true }),
		queue({ op: "chat", id: 1, file: files.taskA, title: TASK_A }),
		queue({ op: "start", id: 2, lane: true }),
		queue({ op: "chat", id: 2, file: files.taskB, title: TASK_B }),
		wait(2),
	]);
	const assigned = (id, title, from) =>
		queue({ op: "assigned", id, plan: plan(title), touches: ["a repo"], from: { file: from, title: HOME } });
	write(files.taskA, "2026-09-30T10:01:00.000Z", TASK_A, [
		assigned(1, "Paint the fence", files.home),
		user("[Queue] Task #1: Paint the fence"),
		assistant("TASK-A-REPLY Painting."),
	]);
	write(files.taskB, "2026-09-30T10:02:00.000Z", TASK_B, [
		assigned(2, "Wait for the paint to dry", files.home),
		user("[Queue] Task #2: Wait for the paint to dry"),
		assistant("TASK-B-REPLY On hold until it's dry."),
		wait(2),
	]);
	write(files.elsewhere, "2026-09-30T10:03:00.000Z", ELSEWHERE, [
		assigned(3, "A task from a queue chat that isn't listed", gone),
		user("[Queue] Task #3"),
		assistant("ELSEWHERE-REPLY Working on it."),
	]);
	write(files.user, "2026-09-30T10:04:00.000Z", USER, [user("hello"), assistant("USER-REPLY hi")]);
}

// ---- the chat list as shown -------------------------------------------------------------------------
/** The chat list's rows in order: title, indent, queue roles, toggle state, count and marks. */
const listRows = (page, scope) =>
	page.evaluate((scope) => {
		const root = document.querySelector(scope);
		return [...(root?.querySelectorAll(".panel-convs .lp-row") ?? [])].map((row) => {
			const item = row.querySelector(".session-item");
			const toggle = row.querySelector(".queue-fold-toggle");
			const count = row.querySelector(".queue-fold-count");
			return {
				title: (item?.getAttribute("title") ?? "").split(" \u2014 ")[0],
				indent: Number.parseFloat(getComputedStyle(row).marginLeft) || 0,
				task: row.classList.contains("lp-queue-task"),
				home: row.classList.contains("lp-queue-home"),
				expanded: toggle ? toggle.getAttribute("aria-expanded") : null,
				count: count ? count.textContent : null,
				countRunning: count ? count.classList.contains("running") : false,
				working: Boolean(row.querySelector(".conv-dot.conv-running")),
				active: Boolean(item?.classList.contains("active")),
			};
		});
	}, scope);
const titles = (rows) => rows.map((r) => r.title);
const rowOf = (rows, title) => rows.find((r) => r.title === title);
async function waitRows(page, scope, ok, ms = 20_000) {
	const until = Date.now() + ms;
	let rows = [];
	while (Date.now() < until) {
		rows = await listRows(page, scope);
		if (ok(rows)) return rows;
		await sleep(150);
	}
	return rows;
}
/** The rows right under the queue chat's row (its group), in order. */
const groupOf = (rows, title) => {
	const i = rows.findIndex((r) => r.title === title);
	if (i < 0) return [];
	const out = [];
	for (const r of rows.slice(i + 1)) {
		if (r.indent <= rows[i].indent) break;
		out.push(r);
	}
	return out;
};
const grouped = (rows) => {
	const g = groupOf(rows, HOME);
	return g.length === 2 && g.every((r) => r.task) && titles(g).join("|") === `${TASK_B}|${TASK_A}`;
};
const row = (page, scope, title) =>
	page.locator(`${scope} .panel-convs .lp-row`, { has: page.locator(`.session-item[title^="${title} \u2014"]`) });
const shown = (page, text) => page.evaluate((t) => document.body.innerText.includes(t), text);

async function openPage(ctx) {
	const page = await ctx.newPage();
	page.on("pageerror", (e) => pageErrors.push(String(e)));
	await page.goto(srv.http);
	await page.waitForSelector(".topbar", { timeout: 60_000 });
	await page.locator(".inputbox textarea").waitFor({ timeout: 20_000 });
	return page;
}

const pageErrors = [];
let browser = null;
const srv = await ownServer({ name: "queue-grouping", mock: respond, prepare: seed });
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const desk = await browser.newContext({ viewport: { width: 1300, height: 900 } });
	await desk.addInitScript(() => localStorage.setItem("pi-web-ui:lang", "en"));
	const page = await openPage(desk);
	const D = ".panel-left";

	// ---- 1. a task chat whose queue chat isn't listed stays a row of its own -----------------------------
	let rows = await waitRows(page, D, (r) => [HOME, TASK_A, TASK_B, ELSEWHERE, USER].every((t) => rowOf(r, t)));
	check(
		"the five saved chats are listed",
		[HOME, TASK_A, TASK_B, ELSEWHERE, USER].every((t) => rowOf(rows, t)),
		JSON.stringify(titles(rows)),
	);
	await row(page, D, ELSEWHERE).locator(".session-item").click();
	await page.waitForFunction(() => document.body.innerText.includes("ELSEWHERE-REPLY"), null, { timeout: 20_000 });
	await sleep(800); // the server works the links out a moment after a chat opens
	rows = await listRows(page, D);
	const elsewhere = rowOf(rows, ELSEWHERE);
	check(
		"opened, a task chat whose queue chat isn't listed stays a normal row",
		elsewhere?.indent === 0 && !elsewhere.task && elsewhere.active,
		JSON.stringify(elsewhere),
	);

	// ---- 2. the queue chat opens: its open tasks' chats gather under it ---------------------------------
	await row(page, D, HOME).locator(".session-item").click();
	await page.waitForFunction(() => document.body.innerText.includes("HOME-REPLY"), null, { timeout: 20_000 });
	rows = await waitRows(page, D, grouped);
	const home = rowOf(rows, HOME);
	check("both task chats sit under their queue chat, newest first", grouped(rows), JSON.stringify(rows));
	check(
		"the queue chat's row has an open toggle and stays a top-level row",
		home?.home === true && home.expanded === "true" && home.indent === 0 && home.count === null,
		JSON.stringify(home),
	);
	check(
		"nested rows are indented like subagents (18 px)",
		groupOf(rows, HOME).every((r) => r.indent === (home?.indent ?? 0) + 18),
		JSON.stringify(groupOf(rows, HOME).map((r) => r.indent)),
	);
	check(
		"the other chats stay rows of their own, titles unchanged",
		[ELSEWHERE, USER].every((t) => rowOf(rows, t)?.indent === 0 && !rowOf(rows, t)?.task) &&
			[TASK_A, TASK_B].every((t) => rowOf(rows, t)),
		JSON.stringify(titles(rows)),
	);
	if (SHOT) await page.locator(D).screenshot({ path: `${SHOT}-desktop.png` });

	// ---- 3. a nested chat opens from its row and shows that it works ------------------------------------
	await row(page, D, TASK_A).locator(".session-item").click();
	await page.waitForFunction(() => document.body.innerText.includes("TASK-A-REPLY"), null, { timeout: 20_000 });
	rows = await waitRows(page, D, (r) => rowOf(r, TASK_A)?.active === true);
	check(
		"a nested chat opens from its row",
		rowOf(rows, TASK_A)?.active === true && (await shown(page, "TASK-A-REPLY")),
	);
	check("opened, it stays under its queue chat", grouped(rows), JSON.stringify(titles(groupOf(rows, HOME))));
	const ta = page.locator(".inputbox textarea");
	await ta.fill("GROUPING-WORK keep painting");
	await ta.press("Enter");
	rows = await waitRows(page, D, (r) => rowOf(r, TASK_A)?.working === true);
	check(
		"while it works, the nested row shows its working dot",
		rowOf(rows, TASK_A)?.working === true,
		JSON.stringify(rowOf(rows, TASK_A)),
	);
	check("still nested while it works", grouped(rows));

	// ---- 4. the toggle folds the group, and the fold survives a reload -----------------------------------
	await row(page, D, HOME).locator(".queue-fold-toggle").click();
	rows = await waitRows(page, D, (r) => rowOf(r, HOME)?.expanded === "false");
	const folded = rowOf(rows, HOME);
	check(
		"folded: the task chats leave the list, the queue chat's row counts them and shows one works",
		folded?.expanded === "false" &&
			folded.count === "2" &&
			folded.countRunning &&
			!rowOf(rows, TASK_A) &&
			!rowOf(rows, TASK_B),
		JSON.stringify(folded),
	);
	check("folding doesn't open the queue chat", folded?.active === false);
	check(
		"the other rows stay",
		[ELSEWHERE, USER].every((t) => rowOf(rows, t)),
		JSON.stringify(titles(rows)),
	);
	const stored = await page.evaluate((k) => localStorage.getItem(k), FOLDS_KEY);
	check(
		"the fold is kept in this browser, by the queue chat's transcript",
		(stored ?? "").includes(files.home),
		stored ?? "none",
	);

	await page.reload();
	await page.waitForSelector(".topbar", { timeout: 60_000 });
	rows = await waitRows(page, D, (r) => rowOf(r, HOME)?.expanded === "false" && rowOf(r, HOME)?.count === "2");
	check(
		"after a reload the group is still folded",
		rowOf(rows, HOME)?.expanded === "false" && !rowOf(rows, TASK_A) && !rowOf(rows, TASK_B),
		JSON.stringify(rows),
	);
	await row(page, D, HOME).locator(".queue-fold-toggle").click();
	rows = await waitRows(page, D, grouped);
	check("unfolded again: the task chats are back under it", grouped(rows) && rowOf(rows, HOME)?.expanded === "true");
	await page.reload();
	await page.waitForSelector(".topbar", { timeout: 60_000 });
	rows = await waitRows(page, D, grouped);
	check(
		"after a reload the group is still unfolded",
		grouped(rows) && rowOf(rows, HOME)?.expanded === "true",
		JSON.stringify(rows),
	);

	// ---- 5. phone width: the chats drawer --------------------------------------------------------------
	const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
	await phone.addInitScript(() => localStorage.setItem("pi-web-ui:lang", "en"));
	const mobile = await openPage(phone);
	await mobile.locator(".topbar button.panel-toggle").first().click();
	const P = ".panel-drawer.drawer-left.open .panel-left";
	await mobile.locator(P).waitFor({ timeout: 10_000 });
	// The drawer slides in (0.25 s): measure and photograph it once it's all the way in.
	await mobile.waitForFunction(
		() => Math.abs(document.querySelector(".panel-drawer.drawer-left.open")?.getBoundingClientRect().left ?? -1) < 0.5,
		null,
		{ timeout: 5000 },
	);
	rows = await waitRows(mobile, P, grouped);
	check("phone: the task chats sit under their queue chat in the chats drawer", grouped(rows), JSON.stringify(rows));
	const box = await row(mobile, P, HOME).locator(".queue-fold-toggle").boundingBox();
	check(
		"phone: the toggle is big enough to tap (at least 40 \u00d7 44 px) and on screen",
		(box?.width ?? 0) >= 40 && (box?.height ?? 0) >= 44 && (box?.x ?? -1) >= 0,
		JSON.stringify(box),
	);
	if (SHOT) await mobile.screenshot({ path: `${SHOT}-phone.png` });
	await row(mobile, P, HOME).locator(".queue-fold-toggle").tap();
	rows = await waitRows(mobile, P, (r) => rowOf(r, HOME)?.expanded === "false");
	check(
		"phone: a tap on the toggle folds the group",
		rowOf(rows, HOME)?.count === "2" && !rowOf(rows, TASK_A) && !rowOf(rows, TASK_B),
		JSON.stringify(rows),
	);
	check("phone: the drawer stays open (the tap didn't open a chat)", (await mobile.locator(P).count()) === 1);
	await row(mobile, P, HOME).locator(".queue-fold-toggle").tap();
	rows = await waitRows(mobile, P, grouped);
	check("phone: a second tap unfolds it", grouped(rows));
	await phone.close();

	// ---- the held turn finishes; nothing else went to the model ------------------------------------------
	letWorkFinish();
	await page
		.waitForFunction(() => document.body.innerText.includes("GROUPING-WORK done."), null, { timeout: 20_000 })
		.catch(() => {});
	rows = await waitRows(page, D, (r) => rowOf(r, TASK_A)?.working === false);
	check(
		"the task chat's turn finished and it is still nested",
		rowOf(rows, TASK_A)?.working === false && grouped(rows),
	);
	check("the model got the one held turn and nothing else", seen.work === 1 && seen.other === 0, JSON.stringify(seen));
	check("no page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 400));
} catch (err) {
	check("the test ran to the end", false, String(err?.stack ?? err).slice(0, 1200));
} finally {
	letWorkFinish();
	await browser?.close().catch(() => {});
	await srv.stop();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall queue-grouping checks passed");
process.exit(failures ? 1 : 0);
