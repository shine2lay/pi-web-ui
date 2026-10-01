/* queue-lanes E2E (no tokens): queued tasks run in fresh chats of their own, in parallel lanes.
 *
 * The real pi-queue extension is loaded through settings.json `packages` (PI_QUEUE_PKG, default
 * ~/projects/pi-queue). A mock model plays the agent in every chat; each task chat's first reply
 * waits on a gate the test opens, so the test decides when each task finishes.
 *  - the queue's chat plans three tasks: #1 touches repo-a, #2 touches repo-a and service-x (so it
 *    shares #1's lane), #3 touches repo-b (a lane of its own);
 *  - task chats: #1 and #2 call queue_done, #3 calls queue_stuck (with 2 choices); the user's answer in #3's chat
 *    makes it call queue_done.
 * Checks:
 *  - the approval dialog says which queued task a plan shares a lane with;
 *  - the Queue tab shows the lanes and the lanes-at-once setting (2);
 *  - Start: #1 and #3 start at once, each in a new chat named "Queue #n: <title>" that got only its
 *    plan (none of the queue chat's history); #2 waits behind #1;
 *  - Stop while both run: they aren't interrupted; #1 finishes and reports back (done, summary), but
 *    #2 doesn't start while the queue is stopped;
 *  - #3 needs the user: the question shows in the Queue tab and in the TL;DR with a link to its chat;
 *  - the lanes limit: with 1 lane at once, #2 doesn't start while #3 holds its lane; with 2 it does;
 *  - the TL;DR link opens #3's chat, whose Queue tab says where the queue is; answering there
 *    finishes #3, and the queue's chat shows every task done;
 *  - finished task chats leave the chat list, running and Recent chats, on every window (#3's, which
 *    window A is looking at, once A moves on); their transcripts stay and History lists them; the
 *    Queue tab's link opens one, which puts it back in the chat list (queue-done-hidden);
 *  - no page errors, and the mock saw no user message it had no script for.
 * Usage: npm run build && node tests/queue-lanes-test.mjs   (QUEUE_DEBUG=1 prints the mock's requests;
 *        QUEUE_SHOT=/tmp/x.png saves screenshots of the right panel: x-lanes.png, x-stuck.png, x-done.png)
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { startMockModel, textOf, writeMockModelConfig } from "./lib/mock-model.mjs";
import { ownServer } from "./lib/own-server.mjs";

// The account's home (userInfo), not HOME: a sealed test run has a temp HOME.
const PI_QUEUE = process.env.PI_QUEUE_PKG ?? join(userInfo().homedir, "projects", "pi-queue");
if (!existsSync(join(PI_QUEUE, "package.json"))) {
	console.log(`✗ FAIL: pi-queue not found at ${PI_QUEUE} (set PI_QUEUE_PKG)`);
	process.exit(1);
}

const PLAN_RUN = "LANES-PLAN queue up the three tasks we planned";
const PLANNED = "LANES-PLANNED three tasks are queued.";
const STUCK_QUESTION = "Which colour should lane B use: blue or green?";
/** queue_stuck asks with 2-4 answers to pick from (telegram-answers). */
const STUCK_CHOICES = ["Blue", "Green"];
const ANSWER = "LANES-ANSWER use blue";
// Full plans: pi-queue refuses thin ones (checkPlan's minimum lengths) before any dialog opens.
const PLANS = [
	{
		title: "Write lane A's first file",
		goal: "GOAL-ONE: put the first file in repo A",
		done_when: "The first file is in repo A and reads back correctly",
		decided: "Plain text, one line, no new tools",
		steps: "1. Write the file\n2. Read it back\n3. Report the result",
		verify: "Read the file back and compare it",
		must_not: "Touch repo B",
		touches: ["repo-a"],
	},
	{
		title: "Write lane A's second file",
		goal: "GOAL-TWO: put the second file in repo A and restart service X",
		done_when: "The second file is in repo A and service X answers again",
		decided: "Plain text, one line, restart service X once",
		steps: "1. Write the file\n2. Restart service X\n3. Report the result",
		verify: "Read the file back and call service X",
		must_not: "Touch repo B",
		touches: ["Repo-A", "service-x"],
	},
	{
		title: "Write lane B's file",
		goal: "GOAL-THREE: put a file in repo B",
		done_when: "The file is in repo B, in the colour the user picks",
		decided: "Ask the user for the colour first, then write the file",
		steps: "1. Ask the user for the colour\n2. Write the file\n3. Report the result",
		verify: "Read the file back and check the colour",
		must_not: "Touch repo A",
		touches: ["repo-b"],
	},
];
const SUMMARY = {
	1: "Wrote lane A's first file.",
	2: "Wrote lane A's second file.",
	3: "Wrote lane B's file in blue.",
};
const chatName = (id) => `Queue #${id}: ${PLANS[id - 1].title}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`  ${ok ? "✓" : "✗ FAIL:"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};
async function waitFor(fn, ms) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await fn()) return true;
		await sleep(200);
	}
	return false;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- mock model ------------------------------------------------------------
const gate = new Map();
for (const id of [1, 2, 3]) {
	let open;
	const promise = new Promise((r) => (open = r));
	gate.set(id, { promise, open });
}
/** When each task chat's first request arrived, and what it carried. */
const kickoff = new Map();
let queueAddOffered = false;
/** User messages the mock had no script for (a reminder, a "continue", …): should stay empty. */
const unexpected = [];

/** pi-web-ui adds reminders of its own as user messages (e.g. other runs going on); they aren't the user's. */
const isAppReminder = (text) => /^\(System reminder/.test(text);
/** What an unscripted message was, for the failure note (never its text). */
const kindOf = (text) => (text.startsWith("[Queue]") ? "a queue reminder" : "a user message");

const mock = await startMockModel(async ({ payload, sideRequest }) => {
	if (sideRequest) return "Lanes chat";
	const history = Array.isArray(payload.messages) ? payload.messages : [];
	const users = [];
	history.forEach((m, i) => {
		if (m.role === "user" && !isAppReminder(textOf(m))) users.push(i);
	});
	const first = users[0] ?? -1;
	const last = users.at(-1) ?? -1;
	const firstUser = first >= 0 ? textOf(history[first]) : "";
	const lastUser = last >= 0 ? textOf(history[last]) : "";
	const results = history.slice(last + 1).filter((m) => m.role === "tool").length;
	const names = (payload.tools ?? []).map((t) => t.function?.name ?? t.name);
	const kick = firstUser.match(/^\[Queue\] Task #(\d+): /);
	if (process.env.QUEUE_DEBUG) {
		console.log(`    [mock] ${kick ? `task #${kick[1]}` : "queue chat"} step ${results}`);
	}
	if (!kick) {
		// The queue's chat.
		if (names.includes("queue_add")) queueAddOffered = true;
		if (lastUser.startsWith(PLAN_RUN)) {
			if (results < PLANS.length) {
				await sleep(300);
				return { tool: "queue_add", args: PLANS[results] };
			}
			return PLANNED;
		}
		unexpected.push(`queue chat: ${kindOf(lastUser)}`);
		return "LANES-OTHER ok.";
	}
	const id = Number(kick[1]);
	if (last === first) {
		// The task's kickoff turn.
		if (results === 0) {
			if (!kickoff.has(id)) {
				kickoff.set(id, {
					at: Date.now(),
					text: firstUser,
					users: users.length,
					all: history.map(textOf).join("\n"),
				});
			}
			await gate.get(id).promise;
			return id === 3
				? { tool: "queue_stuck", args: { question: STUCK_QUESTION, choices: STUCK_CHOICES } }
				: { tool: "queue_done", args: { summary: SUMMARY[id] } };
		}
		return id === 3 ? `LANES-ASK ${STUCK_QUESTION}` : `LANES-DONE-${id}`;
	}
	if (id === 3 && lastUser.startsWith(ANSWER)) {
		if (results === 0) {
			await sleep(300);
			return { tool: "queue_done", args: { summary: SUMMARY[3] } };
		}
		return "LANES-DONE-3";
	}
	unexpected.push(`task #${id}: ${kindOf(lastUser)}`);
	return "LANES-OTHER ok.";
});
mock.unref();

// ---- server ----------------------------------------------------------------
const srv = await ownServer({
	name: "piweb-queue-lanes",
	verbose: !!process.env.QUEUE_DEBUG,
	model: (agentDir) => {
		writeMockModelConfig(agentDir, mock.port);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "mock",
				defaultModel: "mock-model",
				packages: [PI_QUEUE],
				retry: { enabled: false },
			}),
		);
	},
});

// A second client that only watches the chat list (running chats and recent transcripts). Like a
// window, it asks for the saved chats once: the Recent chats rows come from that list.
let convs = [];
/** The saved chats (History) as last sent to the observer. */
let saved = [];
/** Each task chat's transcript, as soon as its row shows one. */
const taskFiles = new Map();
const observer = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
observer.on("open", () => observer.send(JSON.stringify({ type: "hello", clientId: "lanes-observer" })));
observer.on("message", (raw) => {
	try {
		const m = JSON.parse(String(raw));
		if (m.type === "ready") observer.send(JSON.stringify({ type: "list_sessions" }));
		if (m.type === "conversations" && Array.isArray(m.conversations)) {
			convs = m.conversations;
			for (const id of [1, 2, 3]) {
				const file = convRow(id)?.sessionFile ?? convRow(id)?.sessionPath;
				if (file) taskFiles.set(id, file);
			}
		}
		if (m.type === "sessions" && Array.isArray(m.sessions)) saved = m.sessions;
	} catch {
		/* not JSON */
	}
});
/** The chat list's row for a task's chat (running, or a recent transcript with live: false). */
const convRow = (id) => convs.find((c) => c.title === chatName(id));
/** Whether a task chat's transcript is still there, and History (the saved chats) lists it. */
const kept = (id) => {
	const file = taskFiles.get(id);
	return !!file && existsSync(file) && saved.some((s) => resolve(s.path) === resolve(file));
};

// ---- browser ---------------------------------------------------------------
const pageErrors = [];
let browser;
async function openWindow(clientId) {
	const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
	await ctx.addInitScript((id) => {
		localStorage.setItem("pi-web-client-id", id);
		localStorage.setItem("pi-web-ui:lang", "en");
	}, clientId);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => pageErrors.push(`${clientId}: ${e}`));
	await page.goto(srv.http);
	await page.waitForSelector(".topbar", { timeout: 60000 });
	await page.locator(".inputbox textarea").waitFor({ timeout: 20000 });
	return page;
}
async function openTab(page, name, selector) {
	await page.locator(".panel-right .slot-tab", { hasText: name }).first().click();
	await page.locator(selector).first().waitFor({ timeout: 5000 });
}
const openQueueTab = (page) => openTab(page, "Queue", ".task-queue-panel");
async function send(page, text) {
	const ta = page.locator(".inputbox textarea");
	await ta.fill(text);
	await ta.press("Enter");
}
/** The Queue tab as shown. */
const view = (page) =>
	page.evaluate(() => {
		const p = document.querySelector(".task-queue-panel");
		if (!p) return null;
		const rows = [...p.querySelectorAll("li.task-queue-task")];
		const ids = (cls) => rows.filter((li) => li.classList.contains(cls)).map((li) => Number(li.dataset.taskId));
		const lanes = {};
		for (const li of rows) {
			const badge = li.querySelector(".task-queue-lane");
			if (badge) lanes[li.dataset.taskId] = Number(badge.dataset.lane);
		}
		const toggle = p.querySelector(".task-queue-toggle");
		return {
			inChats: ids("lane"),
			now: ids("current"),
			next: ids("ready"),
			done: ids("done"),
			needsYou: ids("needs-you"),
			lanes,
			links: rows.filter((li) => li.querySelector(".task-queue-open-chat")).map((li) => Number(li.dataset.taskId)),
			lanesAtOnce: p.querySelector(".task-queue-lanes-n")?.textContent?.trim() ?? "",
			touches: [...p.querySelectorAll(".task-queue-touches")].map((e) => e.textContent.trim()),
			status: p.querySelector(".task-queue-status")?.textContent?.trim() ?? "",
			toggle: toggle
				? `${toggle.className.replace("task-queue-toggle ", "")}${toggle.disabled ? " disabled" : ""}`
				: "",
			question: p.querySelector(".task-queue-question-text")?.textContent?.trim() ?? "",
			hints: [...p.querySelectorAll(".task-queue-hint")].map((e) => e.textContent.trim()),
			from: p.querySelector(".task-queue-from")?.textContent?.trim() ?? "",
			summaries: [...p.querySelectorAll("li.task-queue-task.done .task-queue-summary")].map((e) =>
				e.textContent.trim(),
			),
		};
	});
const show = async (page) => JSON.stringify(await view(page));
/** The left panel's rows (running and Recent chats): their tooltips ("<title> \u2014 <folder>") and the open one. */
const leftPanel = (page) =>
	page.evaluate(() => {
		const items = [...document.querySelectorAll(".panel-left .panel-convs .session-item")];
		return {
			rows: items.map((el) => el.getAttribute("title") ?? el.textContent ?? ""),
			active: items.find((el) => el.classList.contains("active"))?.getAttribute("title") ?? "",
		};
	});
const inLeftPanel = async (page, id) => (await leftPanel(page)).rows.some((row) => row.includes(chatName(id)));
/** The TL;DR tab's lines: text, needs-you, and whether it links to a chat. */
const tldrLines = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll(".tldr-line")].map((li) => ({
			text: li.querySelector(".tldr-text")?.textContent?.trim() ?? "",
			needsYou: li.classList.contains("needs-you"),
			link: !!li.querySelector(".tldr-open-chat"),
		})),
	);
const pageText = (page) => page.evaluate(() => document.body.innerText);
const shot = async (page, suffix) => {
	if (!process.env.QUEUE_SHOT) return;
	await page.locator(".panel-right").screenshot({ path: process.env.QUEUE_SHOT.replace(/\.png$/, `-${suffix}.png`) });
};

try {
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const A = await openWindow("lanes-window-a");
	await openQueueTab(A);

	console.log("plan three tasks; approve each plan in the dialog");
	await send(A, PLAN_RUN);
	for (let i = 0; i < PLANS.length; i++) {
		const dialog = A.locator(".dialog-inline");
		const up = await waitFor(async () => (await dialog.innerText().catch(() => "")).includes(PLANS[i].title), 20000);
		check(`dialog ${i + 1} shows the plan "${PLANS[i].title}"`, up);
		if (!up) throw new Error("no approval dialog");
		const text = await dialog.innerText();
		if (i === 0) check("queue_add was offered to the model", queueAddOffered);
		if (i === 1) {
			check(
				"dialog 2 says it shares a lane with #1, and what they share",
				/Shares a lane with/.test(text) && text.includes("#1") && text.includes("repo-a"),
				text.slice(-300),
			);
		}
		if (i === 2) check("dialog 3 says it gets a lane of its own", /Lane:\s*its own/.test(text), text.slice(-300));
		await dialog.locator(".dialog-actions .btn.primary").click();
		check(
			`task #${i + 1} shows up in the Queue tab`,
			await waitFor(async () => (await view(A))?.next.length === i + 1, 10000),
			await show(A),
		);
	}
	check("the planning run answered", await waitFor(async () => (await pageText(A)).includes("LANES-PLANNED"), 20000));
	let a = await view(A);
	check("3 tasks wait in order, nothing running", same(a.next, [1, 2, 3]) && a.inChats.length === 0, JSON.stringify(a));
	check("#1 and #2 share lane 1; #3 has lane 2", same(a.lanes, { 1: 1, 2: 1, 3: 2 }), JSON.stringify(a.lanes));
	check("the lanes-at-once setting shows 2", a.lanesAtOnce === "2", a.lanesAtOnce);
	check(
		"each task says what it touches (lower case, no duplicates)",
		same(a.touches, ["Touches: repo-a", "Touches: repo-a, service-x", "Touches: repo-b"]),
		JSON.stringify(a.touches),
	);
	check("Start is offered", a.toggle === "start", a.toggle);
	await shot(A, "lanes");

	console.log("Start: #1 and #3 start at once in chats of their own; #2 waits behind #1");
	await A.locator(".task-queue-toggle.start").click();
	const both = await waitFor(() => kickoff.has(1) && kickoff.has(3), 30000);
	check("#1 and #3 are both at work before either finishes (gates still closed)", both, [...kickoff.keys()].join(","));
	check("#2 hasn't started", !kickoff.has(2));
	check(
		"both run as chats of their own, named after their task",
		await waitFor(() => convRow(1)?.isStreaming === true && convRow(3)?.isStreaming === true, 15000),
		JSON.stringify(convs.map((c) => [c.title, c.isStreaming, c.live])),
	);
	for (const id of [1, 3]) {
		const k = kickoff.get(id);
		check(
			`#${id}'s chat started with its plan, and nothing else`,
			!!k && k.users === 1 && k.text.includes(PLANS[id - 1].goal) && !k.all.includes("LANES-PLAN"),
			k ? `users=${k.users} plan=${k.text.includes(PLANS[id - 1].goal)}` : "no kickoff",
		);
	}
	check(
		"the Queue tab lists #1 and #3 as working in their own chats, with links; #2 still queued",
		await waitFor(async () => {
			const v = await view(A);
			return same(v?.inChats, [1, 3]) && same(v?.next, [2]) && same(v?.links, [1, 3]);
		}, 15000),
		await show(A),
	);
	a = await view(A);
	check("the status says 2 tasks are working in their own chats", a.status.includes("2 tasks working"), a.status);
	if (process.env.QUEUE_PEEK) {
		// Debugging aid: what the app itself shows for #3 (its Queue tab question, and its chat).
		console.log(`    [peek] #3 question in the Queue tab: ${JSON.stringify(a.question)}`);
		const B = await openWindow("lanes-window-peek");
		await openQueueTab(B);
		await B.locator(".lp-row", { hasText: chatName(3) })
			.first()
			.click();
		await sleep(2500);
		await B.screenshot({ path: "/tmp/task12/peek-3.png" });
		await B.context().close();
	}

	console.log("Stop while both run: they go on; #1 finishes, #2 doesn't start");
	await A.locator(".task-queue-toggle.stop").click();
	check("the queue is stopped", await waitFor(async () => (await view(A))?.toggle === "start", 10000), await show(A));
	gate.get(1).open();
	check(
		"#1 reports back: done, with its summary",
		await waitFor(async () => {
			const v = await view(A);
			return v?.done.includes(1) && v.summaries.includes(SUMMARY[1]);
		}, 30000),
		await show(A),
	);
	await sleep(3000);
	a = await view(A);
	check("#2 didn't start while the queue is stopped", !kickoff.has(2) && same(a.next, [2]), JSON.stringify(a));
	check("#3 wasn't interrupted", convRow(3)?.isStreaming === true && same(a.inChats, [3]), JSON.stringify(convRow(3)));
	check("#1's chat had a transcript while it ran", taskFiles.has(1));
	check(
		"#1's finished chat left the chat list, running and Recent chats, on every window",
		await waitFor(async () => !convRow(1) && !(await inLeftPanel(A, 1)), 15000),
		JSON.stringify({ row: convRow(1), panel: await leftPanel(A) }),
	);
	check("#1's transcript stays, and History lists it", await waitFor(() => kept(1), 15000), String(taskFiles.get(1)));
	check(
		"a note in the queue's chat says #1 is done in its chat",
		(await pageText(A)).includes(`Task #1 (${PLANS[0].title}) is done in its chat`),
	);

	console.log("#3 needs you: the question shows in the Queue tab and the TL;DR, with a link");
	gate.get(3).open();
	check(
		"#3 needs you, with its question",
		await waitFor(async () => {
			const v = await view(A);
			return v?.needsYou.includes(3) && v.question === STUCK_QUESTION;
		}, 30000),
		await show(A),
	);
	a = await view(A);
	check(
		"it says the answer goes into the task's own chat",
		a.hints.includes("Your answer goes into the task's own chat and it carries on."),
		JSON.stringify(a.hints),
	);
	check("the status says it waits for your answer on #3", a.status.includes("#3"), a.status);
	await shot(A, "stuck");
	await openTab(A, "TL;DR", ".tldr-line");
	const lines = await tldrLines(A);
	check(
		"the TL;DR says #1 is done and #3 needs you, each linking to its chat",
		lines.some((l) => l.text.startsWith("Task #1 done") && l.link) &&
			lines.some((l) => l.text === `Task #3 needs you: ${STUCK_QUESTION}` && l.needsYou && l.link),
		JSON.stringify(lines),
	);

	console.log("the lanes limit: with 1 lane at once #2 waits while #3 holds its lane; with 2 it starts");
	await openQueueTab(A);
	await A.locator(".task-queue-lanes-fewer").click();
	check(
		"the setting goes down to 1",
		await waitFor(async () => (await view(A))?.lanesAtOnce === "1", 10000),
		await show(A),
	);
	await A.locator(".task-queue-toggle.start").click();
	check("the queue runs again", await waitFor(async () => (await view(A))?.toggle === "stop", 10000), await show(A));
	await sleep(3000);
	check("#2 doesn't start: #3's lane counts, and only 1 may run", !kickoff.has(2), await show(A));
	await A.locator(".task-queue-lanes-more").click();
	check(
		"with 2 lanes allowed, #2 starts in a chat of its own",
		await waitFor(() => kickoff.has(2), 20000),
		await show(A),
	);
	const k2 = kickoff.get(2);
	check("#2's chat started with its plan", !!k2 && k2.text.includes(PLANS[1].goal) && k2.users === 1);
	gate.get(2).open();
	check("#2 reports back: done", await waitFor(async () => (await view(A))?.done.includes(2), 30000), await show(A));

	console.log("answer #3 in its own chat, opened from the TL;DR link");
	await openTab(A, "TL;DR", ".tldr-line");
	await A.locator(".tldr-line", { hasText: "Task #3 needs you" }).locator(".tldr-open-chat").click();
	check(
		"the link opens #3's chat",
		await waitFor(async () => (await pageText(A)).includes(`[Queue] Task #3: ${PLANS[2].title}`), 15000),
	);
	await openQueueTab(A);
	check(
		"its Queue tab says it works on a task from the queue",
		await waitFor(async () => (await view(A))?.from.startsWith("This chat works on a queued task"), 10000),
		await show(A),
	);
	a = await view(A);
	check(
		"no Start/Stop or lanes setting there (the queue is steered from its own chat), and no empty quotes",
		a.toggle === "" && a.lanesAtOnce === "" && !a.from.includes('""'),
		JSON.stringify({ toggle: a.toggle, lanesAtOnce: a.lanesAtOnce, from: a.from }),
	);
	await send(A, ANSWER);
	check("#3 finishes after the answer", await waitFor(async () => (await pageText(A)).includes("LANES-DONE-3"), 30000));
	await A.locator(".task-queue-from .task-queue-open-chat").click();
	check(
		"the queue's chat shows every task done, newest first, with the summaries",
		await waitFor(async () => {
			const v = await view(A);
			return same(v?.done, [3, 2, 1]) && same(v.summaries, [SUMMARY[3], SUMMARY[2], SUMMARY[1]]);
		}, 20000),
		await show(A),
	);
	a = await view(A);
	check("status: all done", a.status === "All done.", a.status);
	check("no lanes left", same(a.inChats, []) && same(a.next, []) && same(a.lanes, {}), JSON.stringify(a));
	await shot(A, "done");

	console.log("the task chats afterwards");
	check(
		"all three task chats left the chat list, running and Recent chats, on every window (#3 once A moved on)",
		await waitFor(async () => {
			if ([1, 2, 3].some((id) => convRow(id))) return false;
			for (const id of [1, 2, 3]) if (await inLeftPanel(A, id)) return false;
			return true;
		}, 20000),
		JSON.stringify({
			rows: [1, 2, 3].map((id) => convRow(id) && [convRow(id).title, convRow(id).live]),
			panel: await leftPanel(A),
		}),
	);
	check(
		"their transcripts stay, and History lists them",
		await waitFor(() => [1, 2, 3].every(kept), 20000),
		JSON.stringify([1, 2, 3].map((id) => [id, taskFiles.has(id), kept(id)])),
	);
	await shot(A, "gone");
	await A.locator('li.task-queue-task.done[data-task-id="1"] .task-queue-open-chat').click();
	check(
		"the Queue tab's link opens #1's chat, and it's back in the chat list",
		await waitFor(
			async () => (await leftPanel(A)).active.includes(chatName(1)) && !!convRow(1) && (await inLeftPanel(A, 1)),
			15000,
		),
		JSON.stringify({ row: convRow(1), panel: await leftPanel(A) }),
	);
	check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
	check("the mock saw no user message it had no script for", unexpected.length === 0, unexpected.join(" | "));
} catch (err) {
	console.log(`✗ FAIL: ${err?.stack ?? err}`);
	failures++;
	if (process.env.QUEUE_SHOT) {
		for (const ctx of browser?.contexts() ?? []) {
			for (const p of ctx.pages()) {
				await p.screenshot({ path: process.env.QUEUE_SHOT.replace(/\.png$/, "-fail.png") }).catch(() => {});
			}
		}
	}
} finally {
	for (const g of gate.values()) g.open();
	await browser?.close().catch(() => {});
	observer.close();
	await srv.stop();
	await mock.close().catch(() => {});
	if (failures) console.log(`server log (tail):\n${srv.stderr().slice(-3000)}`);
	rmSync(srv.root, { recursive: true, force: true });
}
console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ queue-lanes: all checks passed");
process.exit(failures ? 1 : 0);
