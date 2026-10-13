/**
 * lead-bar (fork patch, PATCHES.md; docs/lead-bar.md): with role leads (identities with a home chat) the
 * left bar shows only them, in the Roles page's order, each with the chats of its queue's open, started
 * tasks under it, plus one "Open now" row for the chat on screen when it's neither. Every other chat is in
 * "All chats" (the lists the bar showed before, with Back) and in search. Display only.
 *
 * A server of its own with a stand-in model (tests never call a real model), its own identities and saved
 * chats, the way pi-queue and pi-identity leave them:
 *   roles: design and qa (self-start: design by its own word, qa by the every-chat rules' default), ops
 *   (request-only), temper (its home chat file is gone), coo (no
 *   home chat: not a lead);
 *   ops's queue: task 1 working and task 2 on hold, each in a chat of its own; task 3 done (its chat
 *   stays); task 4 not started (no chat);
 *   a queue chat that isn't a lead's ("Side queue") with a task chat of its own; a chat of the user's.
 * The links (task chat -> its queue chat) are kept in the client state, as after a restart; Recent chats
 * keep one saved chat (task 2's), so one task chat comes as a Recent chats row and the other as a saved
 * chat that isn't a row (conversations.queueTasks).
 *
 *  1. desktop, dark: the bar shows exactly the leads in order, ops with its two task chats newest first,
 *     temper greyed, the new chat as "Open now"; New chat sits in the bar's header; nothing else;
 *  2. an idle lead's menu renames its saved chat in place; a lead opens from its row; the new chat
 *     leaves the bar; a task chat opens and stays under its lead;
 *     the fold toggle folds a lead's task chats (count kept), and back;
 *  3. New chat shows one "Open now" row, gone once he switches to a lead;
 *  4. All chats lists every other chat (Recent chats + History), Back returns; a chat picked there opens
 *     and shows as "Open now"; while it works elsewhere the All chats button counts it;
 *  5. search (Ctrl+K) still opens any chat;
 *  6. axe: no serious or critical hits in the bar, dark and White, leads view and All chats;
 *  7. phone: the same view in the chats drawer, New chat and All chats there, rows at least 44 px tall,
 *     picking a chat closes the drawer, and the drawer opens on the leads again; White too.
 *
 * Usage: npm run build && node tests/lead-bar-test.mjs
 *        LEADBAR_SHOT=/tmp/lb saves screenshots /tmp/lb-*.png
 *        PI_AXE_JS: axe-core (default the design kit's copy in ~/temper-ai)
 */
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";

const SHOT = process.env.LEADBAR_SHOT ?? "";
const AXE = process.env.PI_AXE_JS ?? join(userInfo().homedir, "temper-ai/configs/design/bin/vendor/axe-4.13.0.min.js");
let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✓" : "✗ FAIL:"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures += 1;
}
if (!existsSync(AXE)) {
	console.log(`✗ FAIL: axe-core not found at ${AXE} (set PI_AXE_JS)`);
	process.exit(1);
}

const T = {
	design: "Design lead",
	ops: "Ops lead",
	qa: "QA lead",
	taskA: "Queue #1: Paint the fence",
	taskB: "Queue #2: Wait for the paint to dry",
	taskDone: "Queue #3: Finished work",
	side: "Side queue",
	sideTask: "Queue #7: A side task",
	user: "A chat of the user's",
};
/** The Roles page's order: self-start first (design, qa), then the rest (ops, temper), each by id. */
const ORDER = ["design", "qa", "ops", "temper"];

// ---- the stand-in model: a held turn waits until the test lets it go --------------------------------
// LEADBAR-TASK: a task chat at work; LEADBAR-HOLD: a chat the bar doesn't show, at work.
const holds = {};
for (const key of ["LEADBAR-TASK", "LEADBAR-HOLD"]) {
	let release = () => {};
	const done = new Promise((r) => {
		release = r;
	});
	holds[key] = { done, release };
}
const letGo = (key) => holds[key].release();
const letAllGo = () => {
	for (const h of Object.values(holds)) h.release();
};
const seen = { held: 0, other: 0 };
/** What the user sent this turn: every user message after the model's last reply (the server may add a note
 *  of its own after his words, e.g. about other chats at work, so his aren't always the last). */
function turnText(payload) {
	const msgs = payload?.messages ?? [];
	let i = msgs.length - 1;
	while (i >= 0 && msgs[i].role !== "assistant") i -= 1;
	const text = (c) => (typeof c === "string" ? c : (c ?? []).map((p) => p?.text ?? "").join(" "));
	return msgs
		.slice(i + 1)
		.filter((m) => m.role === "user")
		.map((m) => text(m.content))
		.join("\n");
}
async function respond({ sideRequest, lastUser, payload }) {
	if (sideRequest) return "Mock title";
	const said = `${turnText(payload)}\n${lastUser}`;
	for (const [key, h] of Object.entries(holds)) {
		if (!said.includes(key)) continue;
		seen.held += 1;
		await h.done;
		return `${key} done.`;
	}
	seen.other += 1;
	return "ok";
}

// ---- the roles and saved chats -----------------------------------------------------------------------
const files = {};
let idDir = "";
function seed({ root, dataDir, agentDir, workdir }) {
	const dir = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(dir, { recursive: true });
	const file = (stamp, n) =>
		join(dir, `${stamp}_01a0f000-0000-7000-8000-0000000001${String(n).padStart(2, "0")}.jsonl`);
	files.ops = file("2026-09-30T10-00-00-000Z", 1);
	files.taskA = file("2026-09-30T10-01-00-000Z", 2);
	files.taskB = file("2026-09-30T10-02-00-000Z", 3);
	files.taskDone = file("2026-09-30T10-03-00-000Z", 4);
	files.qa = file("2026-09-30T10-04-00-000Z", 5);
	files.design = file("2026-09-30T10-05-00-000Z", 6);
	files.side = file("2026-09-30T10-06-00-000Z", 7);
	files.sideTask = file("2026-09-30T10-07-00-000Z", 8);
	files.user = file("2026-09-30T10-08-00-000Z", 9);
	// Never written: temper's home chat file is gone.
	files.temper = file("2026-09-20T10-00-00-000Z", 10);

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
	const write = (path, start, name, items, mtime) => {
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
		const at = new Date(mtime);
		utimesSync(path, at, at);
	};
	const assigned = (id, title, from, fromTitle) =>
		queue({ op: "assigned", id, plan: plan(title), touches: ["a repo"], from: { file: from, title: fromTitle } });
	const wait = (id) =>
		queue({
			op: "wait",
			id,
			what: "the paint to dry",
			check: "true",
			everyMs: 120_000,
			until: Date.now() + 86_400_000,
		});

	// Saved chats, oldest change first; task 2's chat changed last (the one Recent chats row).
	write(
		files.ops,
		"2026-09-30T10:00:00.000Z",
		T.ops,
		[
			user("LEADBAR-OPS plan the work"),
			assistant("OPS-HOME-REPLY Four tasks are queued."),
			queue({ op: "add", id: 1, plan: plan("Paint the fence"), touches: ["fence repo"] }),
			queue({ op: "add", id: 2, plan: plan("Wait for the paint to dry"), touches: ["paint repo"] }),
			queue({ op: "add", id: 3, plan: plan("Finished work"), touches: ["done repo"] }),
			queue({ op: "add", id: 4, plan: plan("Not started yet"), touches: ["later repo"] }),
			queue({ op: "start", id: 1, lane: true }),
			queue({ op: "chat", id: 1, file: files.taskA, title: T.taskA }),
			queue({ op: "start", id: 2, lane: true }),
			queue({ op: "chat", id: 2, file: files.taskB, title: T.taskB }),
			wait(2),
			queue({ op: "start", id: 3, lane: true }),
			queue({ op: "chat", id: 3, file: files.taskDone, title: T.taskDone }),
			queue({ op: "done", id: 3, summary: "Done." }),
		],
		"2026-09-30T11:00:00.000Z",
	);
	write(
		files.taskA,
		"2026-09-30T10:01:00.000Z",
		T.taskA,
		[assigned(1, "Paint the fence", files.ops, T.ops), user("[Queue] Task #1"), assistant("TASK-A-REPLY Painting.")],
		"2026-09-30T11:01:00.000Z",
	);
	write(
		files.taskDone,
		"2026-09-30T10:03:00.000Z",
		T.taskDone,
		[assigned(3, "Finished work", files.ops, T.ops), user("[Queue] Task #3"), assistant("DONE-REPLY Finished.")],
		"2026-09-30T11:03:00.000Z",
	);
	write(
		files.qa,
		"2026-09-30T10:04:00.000Z",
		T.qa,
		[user("hi qa"), assistant("QA-HOME-REPLY Ready.")],
		"2026-09-30T11:04:00.000Z",
	);
	write(
		files.design,
		"2026-09-30T10:05:00.000Z",
		T.design,
		[user("hi design"), assistant("DESIGN-HOME-REPLY Ready.")],
		"2026-09-30T11:05:00.000Z",
	);
	write(
		files.side,
		"2026-09-30T10:06:00.000Z",
		T.side,
		[
			user("LEADBAR-SIDE one task"),
			assistant("SIDE-HOME-REPLY Queued."),
			queue({ op: "add", id: 7, plan: plan("A side task"), touches: ["side repo"] }),
			queue({ op: "start", id: 7, lane: true }),
			queue({ op: "chat", id: 7, file: files.sideTask, title: T.sideTask }),
		],
		"2026-09-30T11:06:00.000Z",
	);
	write(
		files.sideTask,
		"2026-09-30T10:07:00.000Z",
		T.sideTask,
		[assigned(7, "A side task", files.side, T.side), user("[Queue] Task #7"), assistant("SIDE-TASK-REPLY On it.")],
		"2026-09-30T11:07:00.000Z",
	);
	write(
		files.user,
		"2026-09-30T10:08:00.000Z",
		T.user,
		[user("hello"), assistant("USER-REPLY hi")],
		"2026-09-30T11:08:00.000Z",
	);
	write(
		files.taskB,
		"2026-09-30T10:02:00.000Z",
		T.taskB,
		[
			assigned(2, "Wait for the paint to dry", files.ops, T.ops),
			user("[Queue] Task #2"),
			assistant("TASK-B-REPLY On hold until it's dry."),
			wait(2),
		],
		"2026-09-30T12:00:00.000Z",
	);

	// The links, as a restarted server finds them (queue-grouping keeps them in the client state).
	writeFileSync(
		join(dataDir, "client-state.json"),
		JSON.stringify({
			__settings__: {
				queueHomes: { [files.taskA]: files.ops, [files.taskB]: files.ops, [files.sideTask]: files.side },
			},
		}),
	);

	// The roles, as pi-identity keeps them.
	idDir = join(root, "identities");
	const roles = {
		design: { title: "Design", homeChat: files.design, workMode: "self-start" },
		ops: { title: "Ops/tooling", homeChat: files.ops },
		qa: { title: "QA", homeChat: files.qa },
		temper: { title: "Temper", homeChat: files.temper },
		coo: { title: "COO" },
	};
	for (const [id, r] of Object.entries(roles)) {
		mkdirSync(join(idDir, id), { recursive: true });
		writeFileSync(join(idDir, id, "identity.json"), `${JSON.stringify({ id, ...r }, null, "\t")}\n`);
		writeFileSync(join(idDir, id, "about.md"), `# ${r.title}\n\n**Focus:** ${r.title} for the test company.\n`);
		writeFileSync(join(idDir, id, "notebook.md"), "rules\n");
	}
}

// ---- the bar as shown --------------------------------------------------------------------------------
/** The left bar now: which view, the Open now row, each lead with its rows, the All chats button. */
const barState = (page, scope) =>
	page.evaluate((scope) => {
		const root = document.querySelector(scope);
		const title = (row) => (row?.querySelector(".session-title")?.textContent ?? "").trim();
		const now = root?.querySelector(".lp-open-now");
		return {
			leadsView: Boolean(root?.querySelector(".lp-section-leads")),
			allView: Boolean(root?.querySelector(".lp-allchats-head")),
			oldLists: root ? root.querySelectorAll(".lp-section-convs, .lp-section-sessions").length : -1,
			openNow: now
				? {
						kind: now.getAttribute("data-open-now"),
						rows: [...now.querySelectorAll(".lp-row")].map(title),
						active: Boolean(now.querySelector(".session-item.active")),
						working: Boolean(now.querySelector(".conv-dot.conv-running")),
					}
				: null,
			leads: [...(root?.querySelectorAll(".lp-lead-group") ?? [])].map((g) => {
				const rows = [...g.querySelectorAll(":scope > .lp-row")];
				const head = rows[0];
				return {
					id: g.getAttribute("data-lead"),
					kind: g.getAttribute("data-lead-chat"),
					title: title(head),
					sub: (head?.querySelector(".session-sub")?.textContent ?? "").trim(),
					active: Boolean(head?.querySelector(".session-item.active")),
					disabled: Boolean(head?.querySelector(".session-item:disabled")),
					expanded: head?.querySelector(".queue-fold-toggle")?.getAttribute("aria-expanded") ?? null,
					count: head?.querySelector(".queue-fold-count")?.textContent ?? null,
					countRunning: Boolean(head?.querySelector(".queue-fold-count.running")),
					tasks: rows.slice(1).map((r) => ({
						title: title(r),
						task: r.classList.contains("lp-queue-task"),
						active: Boolean(r.querySelector(".session-item.active")),
						working: Boolean(r.querySelector(".conv-dot.conv-running")),
						indent: Number.parseFloat(getComputedStyle(r).marginLeft) || 0,
					})),
				};
			}),
			rows: root ? root.querySelectorAll(".lp-section-leads .lp-row").length : -1,
			newInHeader: root ? root.querySelectorAll(".lp-section-leads .lp-section-header .lp-new-chat-action").length : -1,
			allChats: (root?.querySelector(".lp-all-chats")?.textContent ?? "").replace(/\s+/g, " ").trim(),
			text: root?.innerText ?? "",
		};
	}, scope);
async function waitBar(page, scope, ok, ms = 20_000) {
	const until = Date.now() + ms;
	let bar = await barState(page, scope);
	while (Date.now() < until) {
		if (ok(bar)) return bar;
		await sleep(150);
		bar = await barState(page, scope);
	}
	return bar;
}
const lead = (bar, id) => bar.leads.find((l) => l.id === id);
const has = (s, t) => s.includes(t);
/** Ops's two task chats, newest first, as task rows one step in. */
const opsTasksOk = (bar) => {
	const t = lead(bar, "ops")?.tasks ?? [];
	return (
		t.length === 2 && has(t[0].title, T.taskB) && has(t[1].title, T.taskA) && t.every((x) => x.task && x.indent === 18)
	);
};
/** No chat other than the leads', ops's task chats and (optionally) the open one is anywhere in the bar. */
const othersHidden = (bar, except = []) =>
	[T.taskDone, T.side, T.sideTask, T.user, "COO"].filter((t) => !except.includes(t)).every((t) => !has(bar.text, t));

const leadRow = (page, scope, id) => page.locator(`${scope} .lp-lead-group[data-lead="${id}"] > .lp-row`).first();
const taskRow = (page, scope, id, title) =>
	page.locator(`${scope} .lp-lead-group[data-lead="${id}"] > .lp-row.lp-queue-task`, { hasText: title });
const shown = (page, text) => page.evaluate((t) => document.body.innerText.includes(t), text);
const waitText = (page, text, timeout = 20_000) =>
	page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout });

/** axe on `sel` (every rule): its serious and critical hits, as "rule: target". */
async function axeHits(page, sel) {
	if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ path: AXE });
	return page.evaluate(async (sel) => {
		const root = document.querySelector(sel);
		if (!root) return ["(nothing to scan: no " + sel + ")"];
		const res = await window.axe.run(root, { resultTypes: ["violations"] });
		return res.violations
			.filter((v) => v.impact === "serious" || v.impact === "critical")
			.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`));
	}, sel);
}

async function openPage(ctx) {
	const page = await ctx.newPage();
	page.on("pageerror", (e) => pageErrors.push(String(e)));
	await page.goto(srv.http);
	await page.waitForSelector(".topbar", { timeout: 60_000 });
	await page.locator(".inputbox textarea").waitFor({ timeout: 20_000 });
	return page;
}
async function context(browser, theme, phone = false) {
	const ctx = await browser.newContext(
		phone
			? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }
			: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
	);
	await ctx.addInitScript(
		(k) => {
			localStorage.setItem("pi-web-ui:lang", "en");
			if (k) localStorage.setItem("pi-web-ui:theme", k);
		},
		theme === "white" ? "white" : "",
	);
	return ctx;
}
const themed = (page, bg) =>
	page
		.waitForFunction(
			(bg) => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().toLowerCase() === bg,
			bg,
			{ timeout: 15_000 },
		)
		.then(() => true)
		.catch(() => false);
async function shot(page, name, sel) {
	if (!SHOT) return;
	if (sel) await page.locator(sel).screenshot({ path: `${SHOT}-${name}.png` });
	else await page.screenshot({ path: `${SHOT}-${name}.png` });
}

const pageErrors = [];
let browser = null;
const srv = await ownServer({
	name: "lead-bar",
	mock: respond,
	prepare: seed,
	env: {
		get PI_IDENTITY_DIR() {
			return idDir;
		},
		PI_IDENTITY_REINDEX: "0",
		PI_WEB_UI_RECENT_LIMIT: "1",
	},
});
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const desk = await context(browser, "dark");
	const page = await openPage(desk);
	const D = ".panel-left";

	// ---- 1. only the leads, in order, each with its open task chats ------------------------------------
	let bar = await waitBar(page, D, (b) => b.leads.length === 4 && opsTasksOk(b));
	check(
		"the bar shows the role leads in the Roles page's order (self-start first, then by id; no home chat, no row)",
		JSON.stringify(bar.leads.map((l) => l.id)) === JSON.stringify(ORDER),
		JSON.stringify(bar.leads.map((l) => l.id)),
	);
	check(
		"leads are drawn as this window can show them: saved, saved, saved, home chat gone",
		JSON.stringify(bar.leads.map((l) => l.kind)) === JSON.stringify(["saved", "saved", "saved", "missing"]) &&
			has(lead(bar, "design")?.title ?? "", T.design) &&
			has(lead(bar, "ops")?.title ?? "", T.ops) &&
			has(lead(bar, "qa")?.title ?? "", T.qa),
		JSON.stringify(bar.leads.map((l) => [l.id, l.kind, l.title])),
	);
	check(
		"ops has its two open, started task chats under it, newest first (one open, one a saved chat that isn't a row)",
		opsTasksOk(bar),
		JSON.stringify(lead(bar, "ops")?.tasks),
	);
	const onScreen = lead(bar, "ops")?.tasks[0];
	check(
		"the chat on screen at load (task 2's, the newest saved chat) is its row under ops, marked active; no Open now row",
		bar.openNow === null && onScreen?.active === true && has(onScreen.title, T.taskB),
		JSON.stringify({ now: bar.openNow, onScreen }),
	);
	check(
		"the other leads have no task chats; ops's toggle is open",
		["design", "qa", "temper"].every((id) => (lead(bar, id)?.tasks.length ?? -1) === 0) &&
			lead(bar, "ops")?.expanded === "true",
		JSON.stringify(bar.leads.map((l) => [l.id, l.tasks.length, l.expanded])),
	);
	const temperLead = lead(bar, "temper");
	check(
		"a lead whose home chat is gone is greyed and can't be opened ('Home chat not found')",
		temperLead?.disabled === true && temperLead.sub === "Home chat not found" && has(temperLead.title, "Temper"),
		JSON.stringify(temperLead),
	);
	check(
		"nothing else is a row: 4 leads + 2 task chats; no Recent chats or History list",
		bar.rows === 6 && bar.oldLists === 0 && othersHidden(bar),
		`${bar.rows} rows, ${bar.oldLists} old lists: ${bar.text.replace(/\n/g, " | ").slice(0, 400)}`,
	);
	check("New chat sits in the bar's header", bar.newInHeader === 1, String(bar.newInHeader));
	check("All chats is there, with nothing running elsewhere", bar.allChats === "All chats", bar.allChats);
	check(
		"axe: no serious hits in the leads view (dark)",
		(await axeHits(page, D)).length === 0,
		(await axeHits(page, D)).join(" | "),
	);
	await shot(page, "desktop-dark", D);

	// ---- 2. a lead opens from its row; a task chat opens and stays under it; folding -------------------
	// An idle lead's menu is a History row's: its Rename renames the saved chat in place.
	await leadRow(page, D, "design").locator(".session-item").click({ button: "right" });
	await page.locator('.ctx-menu .ctx-menu-item[aria-label="Rename this chat"]').first().click();
	const rename = leadRow(page, D, "design").locator("input.session-rename-input");
	await rename.waitFor({ timeout: 5000 });
	await rename.fill(`${T.design} (renamed)`);
	await rename.press("Enter");
	bar = await waitBar(page, D, (b) => has(lead(b, "design")?.title ?? "", "(renamed)"));
	check(
		"an idle lead's menu renames its saved chat in place, and the lead keeps its place",
		has(lead(bar, "design")?.title ?? "", `${T.design} (renamed)`) &&
			lead(bar, "design")?.kind === "saved" &&
			bar.leads.map((l) => l.id).join() === ORDER.join(),
		JSON.stringify(lead(bar, "design")),
	);
	await leadRow(page, D, "ops").locator(".session-item").click();
	await waitText(page, "OPS-HOME-REPLY");
	bar = await waitBar(page, D, (b) => lead(b, "ops")?.kind === "conv" && lead(b, "ops")?.active && !b.openNow);
	check(
		"a lead's row opens its chat, which is now its live row, active",
		lead(bar, "ops")?.kind === "conv" && lead(bar, "ops")?.active === true,
		JSON.stringify(lead(bar, "ops")),
	);
	check("still no Open now row: the chat on screen is a lead's", bar.openNow === null, JSON.stringify(bar.openNow));
	check(
		"ops keeps its task chats, and the rows didn't move",
		opsTasksOk(bar) && bar.leads.map((l) => l.id).join() === ORDER.join(),
	);
	await taskRow(page, D, "ops", T.taskA).locator(".session-item").click();
	await waitText(page, "TASK-A-REPLY");
	bar = await waitBar(page, D, (b) => (lead(b, "ops")?.tasks ?? []).some((t) => has(t.title, T.taskA) && t.active));
	check(
		"a task chat opens from its row and stays under its lead, with no Open now row",
		opsTasksOk(bar) && lead(bar, "ops")?.tasks[1]?.active === true && bar.openNow === null,
		JSON.stringify({ tasks: lead(bar, "ops")?.tasks, now: bar.openNow }),
	);
	const ta = page.locator(".inputbox textarea");
	await ta.fill("LEADBAR-TASK keep painting");
	await ta.press("Enter");
	bar = await waitBar(page, D, (b) => (lead(b, "ops")?.tasks ?? []).some((t) => has(t.title, T.taskA) && t.working));
	check(
		"a task chat at work keeps its working light under its lead",
		lead(bar, "ops")?.tasks[1]?.working === true && opsTasksOk(bar),
		JSON.stringify(lead(bar, "ops")?.tasks),
	);
	await leadRow(page, D, "ops").locator(".session-item").click();
	await waitBar(page, D, (b) => lead(b, "ops")?.active === true);
	await leadRow(page, D, "ops").locator(".queue-fold-toggle").click();
	bar = await waitBar(page, D, (b) => lead(b, "ops")?.expanded === "false");
	check(
		"the toggle folds ops's task chats away; its row counts them, marked at work",
		lead(bar, "ops")?.tasks.length === 0 &&
			lead(bar, "ops")?.count === "2" &&
			lead(bar, "ops")?.countRunning === true &&
			lead(bar, "ops")?.active === true,
		JSON.stringify(lead(bar, "ops")),
	);
	await leadRow(page, D, "ops").locator(".queue-fold-toggle").click();
	bar = await waitBar(page, D, (b) => lead(b, "ops")?.expanded === "true" && opsTasksOk(b));
	check("unfolded, they're back", opsTasksOk(bar), JSON.stringify(lead(bar, "ops")?.tasks));

	// ---- 3. New chat: one Open now row, gone once he switches to a lead --------------------------------
	await page.locator(`${D} .lp-section-leads .lp-new-chat-action`).click();
	bar = await waitBar(page, D, (b) => b.openNow?.kind === "new");
	check(
		"New chat (in the header) shows one 'Open now' row",
		bar.openNow?.kind === "new" && bar.openNow.rows.length === 1,
	);
	await leadRow(page, D, "qa").locator(".session-item").click();
	await waitText(page, "QA-HOME-REPLY");
	bar = await waitBar(page, D, (b) => lead(b, "qa")?.active === true && !b.openNow);
	check("switching to a lead takes the new chat off the bar", bar.openNow === null && lead(bar, "qa")?.kind === "conv");

	// ---- 4. All chats: every other chat, Back, a chat picked there, the running count ------------------
	await page.locator(`${D} .lp-all-chats`).click();
	bar = await waitBar(page, D, (b) => b.allView);
	check(
		"All chats swaps in the old lists, with Back, and the leads view goes",
		bar.allView && !bar.leadsView && bar.oldLists >= 1,
		JSON.stringify({ all: bar.allView, leads: bar.leadsView, lists: bar.oldLists }),
	);
	const historyText = await page.locator(`${D} .lp-section-sessions`).innerText();
	check(
		"All chats reaches every other chat (History lists them all)",
		[T.taskDone, T.side, T.sideTask, T.user, T.design].every((t) => has(historyText, t)),
		historyText.replace(/\n/g, " | ").slice(0, 400),
	);
	check(
		"axe: no serious hits in All chats (dark)",
		(await axeHits(page, D)).length === 0,
		(await axeHits(page, D)).join(" | "),
	);
	await shot(page, "allchats-dark", D);
	await page.locator(`${D} .lp-allchats-back`).click();
	bar = await waitBar(page, D, (b) => b.leadsView);
	check("Back returns to the leads", bar.leadsView && !bar.allView && bar.leads.length === 4);
	await page.locator(`${D} .lp-all-chats`).click();
	await waitBar(page, D, (b) => b.allView);
	await page.locator(`${D} .lp-section-sessions .lp-row`, { hasText: T.user }).locator(".session-item").click();
	await waitText(page, "USER-REPLY");
	bar = await waitBar(page, D, (b) => b.leadsView && b.openNow?.kind === "conv");
	check(
		"a chat picked in All chats opens, the bar returns to the leads and shows it as 'Open now'",
		bar.leadsView && bar.openNow?.kind === "conv" && has(bar.openNow.rows[0] ?? "", T.user) && bar.openNow.active,
		JSON.stringify(bar.openNow),
	);
	check(
		"still nothing else in the bar: 1 Open now + 4 leads + 2 task chats",
		bar.rows === 7 && othersHidden(bar, [T.user]),
		String(bar.rows),
	);
	await ta.fill("LEADBAR-HOLD keep going");
	await ta.press("Enter");
	bar = await waitBar(page, D, (b) => b.openNow?.working === true);
	check(
		"while it works, its Open now row shows its working light",
		bar.openNow?.working === true,
		JSON.stringify(bar.openNow),
	);
	await leadRow(page, D, "design").locator(".session-item").click();
	await waitText(page, "DESIGN-HOME-REPLY");
	bar = await waitBar(page, D, (b) => !b.openNow && has(b.allChats, "1 running"));
	check(
		"switched away, it leaves the bar, and All chats counts it as running (not the task chat at work, which the bar shows)",
		bar.openNow === null && bar.allChats === "All chats · 1 running" && othersHidden(bar),
		bar.allChats,
	);
	letGo("LEADBAR-HOLD");
	bar = await waitBar(page, D, (b) => b.allChats === "All chats");
	check("once its turn ends, the count goes", bar.allChats === "All chats", bar.allChats);
	letGo("LEADBAR-TASK");
	bar = await waitBar(page, D, (b) => !(lead(b, "ops")?.tasks ?? []).some((t) => t.working));
	check(
		"once the task chat's turn ends, its working light goes, and it stays under ops",
		opsTasksOk(bar) && !(lead(bar, "ops")?.tasks ?? []).some((t) => t.working),
		JSON.stringify(lead(bar, "ops")?.tasks),
	);

	// ---- 5. search still opens any chat ------------------------------------------------------------------
	await page.keyboard.press("Control+k");
	await page.waitForSelector(".gs-modal", { timeout: 5000 });
	await page.fill(".gs-input-row input", T.side);
	await page.locator(".gs-item", { hasText: T.side }).first().waitFor({ timeout: 10_000 });
	await page.locator(".gs-item", { hasText: T.side }).first().click();
	await waitText(page, "SIDE-HOME-REPLY");
	bar = await waitBar(page, D, (b) => has(b.openNow?.rows[0] ?? "", T.side));
	check(
		"search (Ctrl+K) opens a chat that isn't in the bar; it shows as 'Open now'",
		has(bar.openNow?.rows[0] ?? "", T.side) && bar.openNow?.active === true,
		JSON.stringify(bar.openNow),
	);
	await sleep(800); // the server works the links out a moment after a chat opens
	bar = await barState(page, D);
	check(
		"a task of a queue that isn't a lead's stays out of the bar",
		!has(bar.text, T.sideTask) && bar.rows === 7,
		bar.text.replace(/\n/g, " | ").slice(0, 400),
	);

	// ---- 6. White -----------------------------------------------------------------------------------------
	const white = await context(browser, "white");
	const wpage = await openPage(white);
	check("White: the White theme is on", await themed(wpage, "#ffffff"));
	bar = await waitBar(wpage, D, (b) => b.leads.length === 4 && opsTasksOk(b));
	check("White: the same leads view", bar.leads.map((l) => l.id).join() === ORDER.join() && opsTasksOk(bar));
	check(
		"axe: no serious hits in the leads view (White)",
		(await axeHits(wpage, D)).length === 0,
		(await axeHits(wpage, D)).join(" | "),
	);
	await shot(wpage, "desktop-white", D);
	await wpage.locator(`${D} .lp-all-chats`).click();
	await waitBar(wpage, D, (b) => b.allView);
	check(
		"axe: no serious hits in All chats (White)",
		(await axeHits(wpage, D)).length === 0,
		(await axeHits(wpage, D)).join(" | "),
	);
	await white.close();

	// ---- 7. phone: the chats drawer ---------------------------------------------------------------------
	for (const theme of ["dark", "white"]) {
		const phone = await context(browser, theme, true);
		const mobile = await openPage(phone);
		const open = async () => {
			await mobile.locator(".topbar button.panel-toggle").first().click();
			await mobile.locator(".panel-drawer.drawer-left.open .panel-left").waitFor({ timeout: 10_000 });
			// The drawer slides in (0.25 s): measure it once it's all the way in.
			await mobile.waitForFunction(
				() =>
					Math.abs(document.querySelector(".panel-drawer.drawer-left.open")?.getBoundingClientRect().left ?? -1) < 0.5,
				null,
				{ timeout: 5000 },
			);
		};
		const P = ".panel-drawer.drawer-left .panel-left";
		await open();
		bar = await waitBar(mobile, P, (b) => b.leads.length === 4 && opsTasksOk(b));
		check(
			`phone (${theme}): the same leads view in the drawer, with New chat and All chats`,
			bar.leads.map((l) => l.id).join() === ORDER.join() &&
				opsTasksOk(bar) &&
				bar.newInHeader === 1 &&
				bar.allChats.startsWith("All chats"),
			JSON.stringify(bar.leads.map((l) => l.id)),
		);
		const heights = await mobile.evaluate((P) => {
			const sel = [
				`${P} .lp-section-leads .session-item`,
				`${P} .lp-section-leads .lp-new-chat-action`,
				`${P} .lp-all-chats`,
			].join(",");
			return [...document.querySelectorAll(sel)].map((e) => Math.round(e.getBoundingClientRect().height));
		}, P);
		check(
			`phone (${theme}): every row and button is at least 44 px tall`,
			// 4 leads + 2 task chats + New chat + All chats (+ an Open now row when the chat on screen is neither)
			heights.length >= 8 && heights.every((h) => h >= 44),
			JSON.stringify(heights),
		);
		if (theme === "dark")
			check(
				"axe: no serious hits in the drawer (phone)",
				(await axeHits(mobile, P)).length === 0,
				(await axeHits(mobile, P)).join(" | "),
			);
		await shot(mobile, `phone-${theme}`);
		await mobile.locator(`${P} .lp-all-chats`).tap();
		await waitBar(mobile, P, (b) => b.allView);
		const back = await mobile.locator(`${P} .lp-allchats-back`).boundingBox();
		check(`phone (${theme}): All chats' Back is at least 44 px tall`, (back?.height ?? 0) >= 44, JSON.stringify(back));
		await mobile.locator(`${P} .lp-section-sessions .lp-row`, { hasText: T.user }).locator(".session-item").tap();
		await waitText(mobile, "USER-REPLY");
		await mobile
			.waitForFunction(() => !document.querySelector(".panel-drawer.drawer-left.open"), null, { timeout: 5000 })
			.catch(() => {});
		check(
			`phone (${theme}): picking a chat closes the drawer`,
			(await mobile.locator(".panel-drawer.drawer-left.open").count()) === 0,
		);
		await open();
		bar = await waitBar(mobile, P, (b) => b.leadsView && has(b.openNow?.rows[0] ?? "", T.user));
		check(
			`phone (${theme}): the drawer opens on the leads again, the picked chat as 'Open now'`,
			bar.leadsView && !bar.allView && has(bar.openNow?.rows[0] ?? "", T.user),
			JSON.stringify({ leads: bar.leadsView, now: bar.openNow }),
		);
		await leadRow(mobile, P, "qa").locator(".session-item").tap();
		await waitText(mobile, "QA-HOME-REPLY");
		await mobile
			.waitForFunction(() => !document.querySelector(".panel-drawer.drawer-left.open"), null, { timeout: 5000 })
			.catch(() => {});
		check(
			`phone (${theme}): a lead's row opens its chat and closes the drawer`,
			(await mobile.locator(".panel-drawer.drawer-left.open").count()) === 0 && (await shown(mobile, "QA-HOME-REPLY")),
		);
		await phone.close();
	}

	check("the model got the two held turns and nothing else", seen.held === 2 && seen.other === 0, JSON.stringify(seen));
	check("no page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 400));
} catch (err) {
	check("the test ran to the end", false, String(err?.stack ?? err).slice(0, 1200));
} finally {
	letAllGo();
	await browser?.close().catch(() => {});
	await srv.stop();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall lead-bar checks passed");
process.exit(failures ? 1 : 0);
