/* queue-side-by-side E2E (no tokens): tasks that share only a repo or the installer run side by side;
 * a task can come after another.
 *
 * The real pi-queue extension is loaded through settings.json `packages` (PI_QUEUE_PKG, default
 * ~/projects/pi-queue), with its default shareable list (every "<name> repo" and pi-web-deploy). A mock
 * model plays the agent in every chat; each of the first three task chats waits on a gate the test opens.
 *  - the queue's chat plans four tasks: #1 and #2 touch "web-app repo" and "pi-web-deploy"; #3 touches
 *    "web-app repo" and "memory files"; #4 touches "memory files" and "scheduler" and comes after #3;
 *    then it tries to make #3 come after #4, which pi-queue refuses (a loop);
 *  - task chats: each calls queue_done; #4's first message says how #3 ended.
 * Checks:
 *  - the approval dialogs: #2 gets a lane of its own though it shares the repo and the installer with
 *    #1; #4 shares a lane with #3 (the memory files) and says it comes after #3;
 *  - the loop is refused without a dialog, and #3 stays as it was;
 *  - the Queue tab: lanes 1, 2, 3 and 3 (#4 with #3), "After #3 · still waiting for #3 (not started)" on #4
 *    only;
 *  - with 3 lanes at once, Start starts #1, #2 and #3 together, each in a chat of its own; #4 waits;
 *  - #3 done: #4 starts (its first message says #3 is done, with its summary) and finishes;
 *  - everything ends done, no page errors, and the mock saw no message it had no script for.
 * Usage: npm run build && node tests/queue-side-by-side-test.mjs   (QUEUE_DEBUG=1 prints the mock's steps;
 *        QUEUE_SHOT=/tmp/x.png saves screenshots of the right panel: x-lanes.png, x-running.png, x-done.png)
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { startMockModel, textOf, writeMockModelConfig } from "./lib/mock-model.mjs";
import { ownServer } from "./lib/own-server.mjs";

// The account's home (userInfo), not HOME: a sealed test run has a temp HOME.
const PI_QUEUE = process.env.PI_QUEUE_PKG ?? join(userInfo().homedir, "projects", "pi-queue");
if (!existsSync(join(PI_QUEUE, "package.json"))) {
	console.log(`✗ FAIL: pi-queue not found at ${PI_QUEUE} (set PI_QUEUE_PKG)`);
	process.exit(1);
}

const PLAN_RUN = "SIDE-PLAN queue up the four tasks we planned";
const PLANNED = "SIDE-PLANNED four tasks are queued.";
// Full plans: pi-queue refuses thin ones (checkPlan's minimum lengths) before any dialog opens.
const plan = (title, goal, touches, extra = {}) => ({
	title,
	goal,
	done_when: `${title} is finished and checked in the browser`,
	decided: "Plain changes in our own copy of the code, no new tools",
	steps: "1. Make the change\n2. Check it\n3. Report the result",
	verify: "Open the page and look at the result",
	must_not: "Touch anything outside the task",
	touches,
	...extra,
});
const PLANS = [
	plan("Polish the settings page", "GOAL-ONE: tidy the settings page", ["web-app repo", "pi-web-deploy"]),
	plan("Fix the chat list", "GOAL-TWO: fix the chat list", ["Web-App repo", "pi-web-deploy"]),
	plan("Tidy the memory files", "GOAL-THREE: tidy the memory files", ["web-app repo", "memory files"]),
	plan("Fold the notebooks", "GOAL-FOUR: fold the notebooks", ["memory files", "scheduler"], { after: [3] }),
];
/** The loop: #3 after #4, while #4 comes after #3. */
const LOOP = { ...PLANS[2], id: 3, after: [4] };
const SUMMARY = {
	1: "Settings page polished.",
	2: "Chat list fixed.",
	3: "Memory files tidied.",
	4: "Notebooks folded.",
};

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
/** When each task chat's first request arrived. */
const kickoff = new Map();
/** When each task chat called queue_done. */
const finished = new Map();
/** #4's first message said how #3 ended. */
let toldAboutThree = false;
/** pi-queue refused the loop (what the tool answered, as a yes or no only). */
let loopRefused = false;
const unexpected = [];
const isAppReminder = (text) => /^\(System reminder/.test(text);
const kindOf = (text) => (text.startsWith("[Queue]") ? "a queue reminder" : "a user message");

const mock = await startMockModel(async ({ payload, sideRequest }) => {
	if (sideRequest) return "Side by side chat";
	const history = Array.isArray(payload.messages) ? payload.messages : [];
	const users = [];
	history.forEach((m, i) => {
		if (m.role === "user" && !isAppReminder(textOf(m))) users.push(i);
	});
	const first = users[0] ?? -1;
	const last = users.at(-1) ?? -1;
	const firstUser = first >= 0 ? textOf(history[first]) : "";
	const lastUser = last >= 0 ? textOf(history[last]) : "";
	const tools = history.slice(last + 1).filter((m) => m.role === "tool");
	const results = tools.length;
	const kick = firstUser.match(/^\[Queue\] Task #(\d+): /);
	if (process.env.QUEUE_DEBUG) console.log(`    [mock] ${kick ? `task #${kick[1]}` : "queue chat"} step ${results}`);
	if (!kick) {
		if (lastUser.startsWith(PLAN_RUN)) {
			if (results < PLANS.length) {
				await sleep(300);
				return { tool: "queue_add", args: PLANS[results] };
			}
			if (results === PLANS.length) return { tool: "queue_add", args: LOOP };
			loopRefused = /makes a loop/.test(textOf(tools.at(-1)));
			return PLANNED;
		}
		unexpected.push(`queue chat: ${kindOf(lastUser)}`);
		return "SIDE-OTHER ok.";
	}
	const id = Number(kick[1]);
	if (last === first) {
		if (results === 0) {
			if (!kickoff.has(id)) kickoff.set(id, Date.now());
			if (id === 4) toldAboutThree = /#3 Tidy the memory files: done\. Memory files tidied\./.test(firstUser);
			await gate.get(id)?.promise;
			finished.set(id, Date.now());
			return { tool: "queue_done", args: { summary: SUMMARY[id] } };
		}
		return `SIDE-DONE-${id}`;
	}
	unexpected.push(`task #${id}: ${kindOf(lastUser)}`);
	return "SIDE-OTHER ok.";
});
mock.unref();

// ---- server ----------------------------------------------------------------
const srv = await ownServer({
	name: "piweb-queue-side-by-side",
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
		const after = {};
		for (const li of rows) {
			const badge = li.querySelector(".task-queue-lane");
			if (badge) lanes[li.dataset.taskId] = Number(badge.dataset.lane);
			const line = li.querySelector(".task-queue-after");
			if (line) after[li.dataset.taskId] = line.textContent.trim();
		}
		return {
			inChats: ids("lane"),
			next: ids("ready"),
			done: ids("done"),
			lanes,
			after,
			lanesAtOnce: p.querySelector(".task-queue-lanes-n")?.textContent?.trim() ?? "",
			status: p.querySelector(".task-queue-status")?.textContent?.trim() ?? "",
		};
	});
const show = async (page) => JSON.stringify(await view(page));
const pageText = (page) => page.evaluate(() => document.body.innerText);
const shot = async (page, suffix) => {
	if (!process.env.QUEUE_SHOT) return;
	await page.locator(".panel-right").screenshot({ path: process.env.QUEUE_SHOT.replace(/\.png$/, `-${suffix}.png`) });
};

try {
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const A = await openWindow("side-window-a");
	await A.locator(".panel-right .slot-tab", { hasText: "Queue" }).first().click();
	await A.locator(".task-queue-panel").first().waitFor({ timeout: 5000 });

	console.log("plan four tasks; approve each plan in the dialog");
	await send(A, PLAN_RUN);
	for (let i = 0; i < PLANS.length; i++) {
		const dialog = A.locator(".dialog-inline");
		const up = await waitFor(async () => (await dialog.innerText().catch(() => "")).includes(PLANS[i].title), 20000);
		check(`dialog ${i + 1} shows the plan "${PLANS[i].title}"`, up);
		if (!up) throw new Error("no approval dialog");
		const text = await dialog.innerText();
		if (i === 1) {
			check(
				"dialog 2: a lane of its own, though it shares the repo and the installer with #1",
				/Lane:\s*its own\. It shares only web-app repo and pi-web-deploy with #1/.test(text) &&
					!/Shares a lane with/.test(text),
				text.slice(-400),
			);
		}
		if (i === 3) {
			check(
				"dialog 4: shares a lane with #3 (the memory files) and comes after #3",
				/Shares a lane with:?\s*#3 Tidy the memory files \(memory files\)/.test(text) &&
					/After:?\s*#3 Tidy the memory files\. It starts only once that one is done or removed\./.test(text),
				text.slice(-500),
			);
		}
		await dialog.locator(".dialog-actions .btn.primary").click();
		check(
			`task #${i + 1} shows up in the Queue tab`,
			await waitFor(async () => (await view(A))?.next.length === i + 1, 10000),
			await show(A),
		);
	}
	check("the planning run answered", await waitFor(async () => (await pageText(A)).includes("SIDE-PLANNED"), 20000));
	check("the loop (#3 after #4) was refused", loopRefused);
	check("no dialog for the loop", !(await A.locator(".dialog-inline").count()));
	let a = await view(A);
	check(
		"4 tasks wait in order, nothing running",
		same(a.next, [1, 2, 3, 4]) && a.inChats.length === 0,
		JSON.stringify(a),
	);
	check(
		"lanes: #1, #2 and #3 each have their own; #4 is in #3's lane",
		same(a.lanes, { 1: 1, 2: 2, 3: 3, 4: 3 }),
		JSON.stringify(a.lanes),
	);
	check(
		"#4 says it comes after #3 and still waits for it; no other task has an after line",
		same(a.after, { 4: "After #3 \u00b7 still waiting for #3 (not started)" }),
		JSON.stringify(a.after),
	);
	await shot(A, "lanes");

	console.log("3 lanes at once; Start: #1, #2 and #3 start together, #4 waits for #3");
	await A.locator(".task-queue-lanes-more").click();
	check("3 lanes at once", await waitFor(async () => (await view(A))?.lanesAtOnce === "3", 10000), await show(A));
	await A.locator(".task-queue-toggle.start").click();
	const three = await waitFor(() => kickoff.has(1) && kickoff.has(2) && kickoff.has(3), 30000);
	check(
		"#1, #2 and #3 work side by side, each in a chat of its own",
		three && finished.size === 0,
		[...kickoff.keys()].join(","),
	);
	check(
		"the Queue tab shows them working in their chats; #4 still waits",
		await waitFor(async () => {
			const v = await view(A);
			return same(v?.inChats, [1, 2, 3]) && same(v?.next, [4]);
		}, 10000),
		await show(A),
	);
	await sleep(1500);
	check("#4 hasn't started", !kickoff.has(4));
	await shot(A, "running");

	console.log("#3 done: #4 starts, told how #3 ended");
	gate.get(3).open();
	check("#4 starts once #3 is done", await waitFor(() => kickoff.has(4), 30000));
	check("#4 started after #3 finished", (kickoff.get(4) ?? 0) >= (finished.get(3) ?? Infinity));
	check("#4's first message says #3 is done, with its summary", toldAboutThree);
	check("#4 finishes", await waitFor(async () => (await view(A))?.done.includes(4), 20000), await show(A));

	console.log("#1 and #2 done");
	gate.get(1).open();
	gate.get(2).open();
	check(
		"every task is done",
		await waitFor(async () => {
			const v = await view(A);
			return v?.done.length === 4 && v.next.length === 0 && v.inChats.length === 0;
		}, 30000),
		await show(A),
	);
	a = await view(A);
	check("status: all done", a.status === "All done.", a.status);
	check("no after lines on done tasks", same(a.after, {}), JSON.stringify(a.after));
	await shot(A, "done");
	check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
	check("the mock saw no message it had no script for", unexpected.length === 0, unexpected.join(" | "));
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
	await srv.stop();
	await mock.close().catch(() => {});
	if (failures) console.log(`server log (tail):\n${srv.stderr().slice(-3000)}`);
	rmSync(srv.root, { recursive: true, force: true });
}
console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ queue-side-by-side: all checks passed");
process.exit(failures ? 1 : 0);
