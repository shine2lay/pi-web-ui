/* queue-panel E2E (no tokens): the right panel's Queue tab shows and steers the chat's pi-queue queue.
 *
 * The real pi-queue extension is loaded through settings.json `packages` (PI_QUEUE_PKG, default
 * ~/projects/pi-queue). A mock OpenAI-compatible model plays the agent:
 *  - the planning run calls queue_add three times (the user approves each plan in the dialog), then answers;
 *  - "[Queue] Task #N" kickoffs: "Add a timing check" → queue_done; "Rename the settings button" → queue_stuck;
 *  - the user's answer → queue_done for the stuck task.
 * Checks:
 *  - queue_add is offered to the model inside pi-web-ui (pi-queue loaded, hasUI);
 *  - a long plan's approval dialog scrolls its text and keeps OK / Cancel in view (Dialog.tsx);
 *  - window A's Queue tab shows each approved task live, in order, not running;
 *  - window B opens the same chat and sees them; ↓ in A and ✕ (inline confirm) in B show up live in both;
 *  - clicking a title opens the task's plan;
 *  - Start runs the queue: #2 works, then is done with its summary; #1 then needs the user, with the
 *    question, highlighted in both windows; the whole queue run sounds like one run in each window
 *    (1 start tick, 1 done cue; done-settle in web/src/done-cues.ts);
 *  - answering in the chat finishes #1: "All done.", Start disabled, done tasks newest first;
 *  - after a reload the queue is still there; a new chat shows the empty state; switching back brings it back.
 * Usage: npm run build && node tests/queue-panel-test.mjs    (QUEUE_DEBUG=1 prints the mock's requests;
 *        QUEUE_SHOT=/tmp/x.png saves screenshots: x-dialog.png, x-plan.png, x-stuck.png, x-done.png)
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const MOCK_PORT = PORT + 1;
const REPO = fileURLToPath(new URL("..", import.meta.url));
const PI_QUEUE = process.env.PI_QUEUE_PKG ?? join(homedir(), "projects", "pi-queue");
if (!existsSync(join(PI_QUEUE, "package.json"))) {
	console.log(`✗ FAIL: pi-queue not found at ${PI_QUEUE} (set PI_QUEUE_PKG)`);
	process.exit(1);
}
const base = mkdtempSync(join(tmpdir(), "piweb-queue-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });

const MODEL_ID = "queue-mock";
const PLAN_RUN = "QUEUE-PLAN queue up the three tasks we planned";
const PLANNED = "QUEUE-PLANNED three tasks are queued.";
const STUCK_QUESTION = "Which label should the button use: Settings or Preferences?";
const ANSWER = "QUEUE-ANSWER use Settings as the label";
/** done-settle's wait (web/src/done-cues.ts DONE_SETTLE_MS) plus room for a late cue. */
const SETTLE_WAIT = 1500 + 2000;

/** The plans the mock queues, in order (#1, #2, #3). #1's long steps make the dialog scroll. */
const PLANS = [
	{
		title: "Rename the settings button",
		goal: "Make the settings button's label match the page it opens",
		done_when: "The button reads the new label on every page that shows it",
		decided: "Keep the current layout; no new dependencies",
		steps: Array.from({ length: 40 }, (_, i) => `${i + 1}. Update the label in place ${i + 1} and check it`).join("\n"),
		verify: "Run the test suite and look at the page",
		must_not: "Touch unrelated files",
	},
	{
		title: "Add a timing check",
		goal: "Catch the settings page getting slow again before users do",
		done_when: "A test fails when the page takes longer than a second",
		decided: "Use the existing test runner; one second is the limit",
		steps: "1. Write the timing test\n2. Run it against the page\n3. Report the result",
		verify: "Run the new test and the suite",
		must_not: "Change the page itself",
	},
	{
		title: "Tidy the README",
		goal: "Make the README's setup section match the current install steps",
		done_when: "A fresh reader can install by following it word for word",
		decided: "Only the setup section; keep the tone as it is",
		steps: "1. Compare the section with the install script\n2. Fix the steps\n3. Read it through once",
		verify: "Follow the steps in a clean folder",
		must_not: "Rewrite the other sections",
	},
];
const TIMING_SUMMARY = "Added the timing check and ran it; it passes.";
const RENAME_SUMMARY = "Renamed the button to Settings and checked every page.";

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

// ---- mock provider ---------------------------------------------------------
const chunk = (model, delta, finish = null) => ({
	id: "queue-mock",
	object: "chat.completion.chunk",
	created: Math.floor(Date.now() / 1000),
	model,
	choices: [{ index: 0, delta, finish_reason: finish }],
});
async function sse(res, chunks) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
}
const textOf = (msg) =>
	typeof msg?.content === "string"
		? msg.content
		: (msg?.content ?? []).map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
let queueAddOffered = false;
/** User messages the mock had no script for (a reminder, a "continue", …): should stay empty. */
const unexpected = [];
const mock = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${MOCK_PORT}`);
	if (url.pathname.endsWith("/models")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model" }] }));
		return;
	}
	if (!url.pathname.endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	for await (const c of req) body += c;
	const payload = JSON.parse(body || "{}");
	const m = payload.model;
	const history = payload.messages ?? [];
	const say = (text) => sse(res, [chunk(m, { content: text }), chunk(m, {}, "stop")]);
	const call = (name, args, id) =>
		sse(res, [
			chunk(m, {
				tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
			}),
			chunk(m, {}, "tool_calls"),
		]);
	// Side requests (the title) carry no tools.
	if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
		await say("Queue chat");
		return;
	}
	const names = payload.tools.map((t) => t.function?.name ?? t.name);
	if (names.includes("queue_add")) queueAddOffered = true;
	let lastUser = -1;
	history.forEach((x, i) => {
		if (x.role === "user") lastUser = i;
	});
	const userText = lastUser >= 0 ? textOf(history[lastUser]) : "";
	const results = history.slice(lastUser + 1).filter((x) => x.role === "tool").length;
	if (process.env.QUEUE_DEBUG) console.log(`    [mock] ${JSON.stringify(userText.slice(0, 70))} results=${results}`);

	if (userText.startsWith(PLAN_RUN)) {
		if (results < PLANS.length) {
			await sleep(400);
			await call("queue_add", PLANS[results], `call_add_${results}`);
			return;
		}
		await sleep(300);
		await say(PLANNED);
		return;
	}
	const kick = userText.match(/^\[Queue\] Task #(\d+): (.+?) \(/);
	if (kick?.[2] === PLANS[1].title) {
		if (results === 0) {
			await sleep(2500); // long enough to see "working on #2" in both windows
			await call("queue_done", { summary: TIMING_SUMMARY }, "call_done_timing");
			return;
		}
		await sleep(300);
		await say("QUEUE-DONE-TIMING the timing check is in.");
		return;
	}
	if (kick?.[2] === PLANS[0].title) {
		if (results === 0) {
			await sleep(600);
			await call("queue_stuck", { question: STUCK_QUESTION }, "call_stuck");
			return;
		}
		await sleep(300);
		await say(`QUEUE-ASK ${STUCK_QUESTION}`);
		return;
	}
	if (userText.startsWith(ANSWER)) {
		if (results === 0) {
			await sleep(600);
			await call("queue_done", { summary: RENAME_SUMMARY }, "call_done_rename");
			return;
		}
		await sleep(300);
		await say("QUEUE-DONE-RENAME renamed.");
		return;
	}
	unexpected.push(userText.slice(0, 90));
	await sleep(200);
	await say("QUEUE-OTHER ok.");
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "mock-key",
				models: [{ id: MODEL_ID, name: "Mock", input: ["text"], contextWindow: 200000, maxTokens: 4096 }],
			},
		},
	}),
);
writeFileSync(
	join(agentDir, "settings.json"),
	JSON.stringify({ defaultProvider: "mock", defaultModel: MODEL_ID, packages: [PI_QUEUE] }),
);

// ---- server ----------------------------------------------------------------
const server = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
	cwd: REPO,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: workdir,
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_TOKEN: "",
	},
	stdio: ["ignore", "pipe", "pipe"],
	detached: true,
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
process.on("exit", () => {
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
});

async function waitServer() {
	for (let i = 0; i < 150; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(200);
	}
	throw new Error("server did not start");
}

// ---- browser ---------------------------------------------------------------
/** Replaces AudioContext: the notes one playSound schedules together count as one cue (from done-any-chat-test). */
const AUDIO_RECORDER = () => {
	const cues = [];
	window.__cues = cues;
	let group = null;
	const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} };
	class FakeOscillator {
		type = "sine";
		frequency = { value: 0 };
		connect() {}
		disconnect() {}
		start() {
			if (!group) {
				group = [];
				cues.push({ at: Date.now(), freqs: group });
				queueMicrotask(() => {
					group = null;
				});
			}
			group.push(Math.round(this.frequency.value));
		}
		stop() {}
	}
	class FakeAudioContext {
		state = "running";
		currentTime = 0;
		destination = {};
		resume() {
			return Promise.resolve();
		}
		createOscillator() {
			return new FakeOscillator();
		}
		createGain() {
			return { gain: param, connect() {}, disconnect() {} };
		}
	}
	window.AudioContext = FakeAudioContext;
	window.webkitAudioContext = FakeAudioContext;
};
/** How many start ticks (sounds.ts START: 660 Hz) and done cues (DONE: 880 → 587 Hz) this window played. */
const cueCounts = (page) =>
	page.evaluate(() => ({
		start: window.__cues.filter((c) => c.freqs.join(",") === "660").length,
		done: window.__cues.filter((c) => c.freqs.join(",") === "880,587").length,
	}));

let browser;
const pageErrors = [];
const messagesText = (page) => page.evaluate(() => document.querySelector(".messages")?.innerText ?? "");
async function openWindow(clientId) {
	const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
	await ctx.addInitScript(AUDIO_RECORDER);
	await ctx.addInitScript((id) => {
		localStorage.setItem("pi-web-client-id", id);
		localStorage.setItem("pi-web-ui:lang", "en");
		// The start tick is off by default; the queue run's sound check needs it.
		localStorage.setItem(
			"pi-web-sounds",
			JSON.stringify({ enabled: true, question: true, done: true, start: true, error: true, volume: 100 }),
		);
	}, clientId);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => pageErrors.push(`${clientId}: ${e}`));
	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".topbar", { timeout: 60000 });
	await page.locator(".inputbox textarea").waitFor({ timeout: 20000 });
	return page;
}
async function openQueueTab(page) {
	await page.locator(".panel-right .slot-tab", { hasText: "Queue" }).first().click();
	await page.locator(".task-queue-panel").waitFor({ timeout: 5000 });
}
async function send(page, text) {
	const ta = page.locator(".inputbox textarea");
	await ta.fill(text);
	await ta.press("Enter");
}
const chatRow = (page) => page.locator(".lp-row", { hasText: /QUEUE-PLAN|Queue chat/ }).first();
/** The Queue tab as shown: task ids per section (top to bottom), the status line, the Start/Stop button. */
const view = (page) =>
	page.evaluate(() => {
		const p = document.querySelector(".task-queue-panel");
		if (!p) return null;
		const ids = (cls) => [...p.querySelectorAll(`li.task-queue-task.${cls}`)].map((li) => Number(li.dataset.taskId));
		const toggle = p.querySelector(".task-queue-toggle");
		return {
			now: ids("current"),
			next: ids("ready"),
			done: ids("done"),
			needsYou: ids("needs-you"),
			status: p.querySelector(".task-queue-status")?.textContent?.trim() ?? "",
			toggle: toggle
				? `${toggle.className.replace("task-queue-toggle ", "")}${toggle.disabled ? " disabled" : ""}`
				: "",
			empty: !!p.querySelector(".task-queue-empty"),
			note: !!p.querySelector(".task-queue-note"),
			question: p.querySelector(".task-queue-question-text")?.textContent?.trim() ?? "",
			summaries: [...p.querySelectorAll("li.task-queue-task.done .task-queue-summary")].map((e) =>
				e.textContent.trim(),
			),
		};
	});
const show = async (page) => JSON.stringify(await view(page));
/** The approval dialog: does its text scroll, and are OK and Cancel inside it and on screen? */
const dialogFit = (page) =>
	page.evaluate(() => {
		const d = document.querySelector(".dialog-inline");
		const msg = d?.querySelector(".dialog-message");
		const buttons = [...(d?.querySelectorAll(".dialog-actions .btn") ?? [])];
		if (!d || !msg || buttons.length !== 2) return { ok: false, why: "no dialog-message / buttons" };
		const db = d.getBoundingClientRect();
		const inView = buttons.every((b) => {
			const r = b.getBoundingClientRect();
			return r.height > 0 && r.top >= db.top - 1 && r.bottom <= db.bottom + 1 && r.bottom <= innerHeight;
		});
		return {
			ok: msg.scrollHeight > msg.clientHeight + 20 && inView,
			why: `message ${msg.scrollHeight}/${msg.clientHeight}px, dialog ${Math.round(db.top)}–${Math.round(db.bottom)}, buttons in view: ${inView}`,
		};
	});
const shot = async (page, suffix) => {
	if (!process.env.QUEUE_SHOT) return;
	await page.locator(".panel-right").screenshot({ path: process.env.QUEUE_SHOT.replace(/\.png$/, `-${suffix}.png`) });
};

try {
	await waitServer();
	browser = await chromium.launch({ executablePath: CHROME_PATH });

	console.log("window A: Queue tab before anything is queued");
	const A = await openWindow("queue-window-a");
	await openQueueTab(A);
	check("a fresh chat shows the empty state", (await view(A))?.empty === true, await show(A));

	console.log("window A: plan three tasks; approve each plan in the dialog");
	await send(A, PLAN_RUN);
	for (let i = 0; i < PLANS.length; i++) {
		const dialog = A.locator(".dialog-inline");
		const up = await waitFor(async () => (await dialog.innerText().catch(() => "")).includes(PLANS[i].title), 20000);
		check(`dialog ${i + 1} shows the plan "${PLANS[i].title}"`, up);
		if (!up) throw new Error("no approval dialog");
		if (i === 0) {
			check("queue_add was offered to the model (pi-queue loaded in pi-web-ui)", queueAddOffered);
			const fit = await dialogFit(A);
			check("the long plan scrolls inside the dialog; OK and Cancel stay in view", fit.ok, fit.why);
			if (process.env.QUEUE_SHOT) await A.screenshot({ path: process.env.QUEUE_SHOT.replace(/\.png$/, "-dialog.png") });
		}
		await dialog.locator(".dialog-actions .btn.primary").click();
		check(
			`task #${i + 1} shows up in the Queue tab live`,
			await waitFor(async () => (await view(A))?.next.length === i + 1, 10000),
			await show(A),
		);
	}
	check(
		"the planning run answered",
		await waitFor(async () => (await messagesText(A)).includes("QUEUE-PLANNED"), 20000),
	);
	let a = await view(A);
	check("3 tasks wait in order, nothing running", same(a.next, [1, 2, 3]) && a.now.length === 0, JSON.stringify(a));
	check(
		"status says it's not running, and Start is offered",
		a.status.startsWith("Not running") && a.toggle === "start",
		`${a.status} | ${a.toggle}`,
	);
	check("no 'pi-queue isn't loaded' note", !a.note);

	console.log("window B: open the same chat");
	const B = await openWindow("queue-window-b");
	await chatRow(B).click();
	await openQueueTab(B);
	check(
		"window B shows the 3 tasks",
		await waitFor(async () => same((await view(B))?.next, [1, 2, 3]), 10000),
		await show(B),
	);

	console.log("reorder in A, remove in B");
	await A.locator('.task-queue-panel li[data-task-id="1"] .task-queue-down').click();
	check(
		"A: ↓ moves #1 below #2",
		await waitFor(async () => same((await view(A)).next, [2, 1, 3]), 5000),
		await show(A),
	);
	check("B: follows live", await waitFor(async () => same((await view(B)).next, [2, 1, 3]), 5000), await show(B));
	await B.locator('.task-queue-panel li[data-task-id="3"] .task-queue-remove').click();
	check(
		"B: ✕ asks first",
		(await B.locator('.task-queue-panel li[data-task-id="3"] .task-queue-remove-yes').count()) === 1 &&
			same((await view(B)).next, [2, 1, 3]),
	);
	await B.locator('.task-queue-panel li[data-task-id="3"] .task-queue-remove-yes').click();
	check("B: #3 is gone", await waitFor(async () => same((await view(B)).next, [2, 1]), 5000), await show(B));
	check("A: follows live", await waitFor(async () => same((await view(A)).next, [2, 1]), 5000), await show(A));

	console.log("window A: open #2's plan");
	await A.locator('.task-queue-panel li[data-task-id="2"] .task-queue-title').click();
	const plan2 = A.locator('.task-queue-panel li[data-task-id="2"] .task-queue-plan');
	check(
		"the plan opens with its parts",
		(await plan2.count()) === 1 &&
			(await plan2.innerText()).includes(PLANS[1].goal) &&
			(await plan2.innerText()).includes(PLANS[1].must_not),
	);
	await shot(A, "plan");

	console.log("window A: Start");
	// The planning run's own done cue lands SETTLE after it ends; count from after it.
	await waitFor(async () => (await cueCounts(A)).done >= 1, SETTLE_WAIT);
	await sleep(500);
	const a0 = await cueCounts(A);
	const b0 = await cueCounts(B);
	await A.locator(".task-queue-panel .task-queue-toggle.start").click();
	check(
		"A: #2 is being worked on",
		await waitFor(async () => {
			const v = await view(A);
			return same(v.now, [2]) && v.status.includes("#2") && v.status.startsWith("Running") && v.toggle === "stop";
		}, 10000),
		await show(A),
	);
	check("B: follows live", await waitFor(async () => same((await view(B)).now, [2]), 5000), await show(B));
	check(
		"A: #2 is done with its summary; #1 needs you, with the question",
		await waitFor(async () => {
			const v = await view(A);
			return (
				same(v.done, [2]) &&
				same(v.now, [1]) &&
				same(v.needsYou, [1]) &&
				v.question === STUCK_QUESTION &&
				v.summaries[0] === TIMING_SUMMARY &&
				v.status.includes("#1") &&
				v.status.startsWith("Waiting for your answer")
			);
		}, 20000),
		await show(A),
	);
	check(
		"B: the same, live",
		await waitFor(async () => {
			const v = await view(B);
			return same(v.done, [2]) && same(v.needsYou, [1]) && v.question === STUCK_QUESTION;
		}, 5000),
		await show(B),
	);
	check("the run asked the question", await waitFor(async () => (await messagesText(A)).includes("QUEUE-ASK"), 10000));
	await waitFor(async () => (await cueCounts(A)).done > a0.done, SETTLE_WAIT);
	await sleep(SETTLE_WAIT);
	for (const [name, page, c0] of [
		["A", A, a0],
		["B", B, b0],
	]) {
		const c = await cueCounts(page);
		check(
			`${name}: the queue run sounded like one run (1 start tick, 1 done cue)`,
			c.start - c0.start === 1 && c.done - c0.done === 1,
			`start +${c.start - c0.start}, done +${c.done - c0.done}`,
		);
	}
	await shot(A, "stuck");

	console.log("window A: answer the question in the chat");
	await send(A, ANSWER);
	check(
		"A: #1 is done too; all done; Start is disabled",
		await waitFor(async () => {
			const v = await view(A);
			return (
				same(v.done, [1, 2]) &&
				v.now.length === 0 &&
				v.next.length === 0 &&
				v.summaries[0] === RENAME_SUMMARY &&
				v.status === "All done." &&
				v.toggle === "start disabled"
			);
		}, 20000),
		await show(A),
	);
	check(
		"B: follows live",
		await waitFor(async () => same((await view(B)).done, [1, 2]) && (await view(B)).status === "All done.", 5000),
		await show(B),
	);
	await shot(A, "done");

	console.log("window A: reload, new chat, back");
	await A.reload();
	await A.waitForSelector(".topbar", { timeout: 60000 });
	await A.locator(".task-queue-panel").waitFor({ timeout: 10000 }); // the tab choice is remembered
	check(
		"after a reload the queue is back",
		await waitFor(async () => same((await view(A))?.done, [1, 2]) && (await view(A)).status === "All done.", 10000),
		await show(A),
	);
	await A.locator(".lp-new-chat-action").click();
	check(
		"a new chat shows the empty state",
		await waitFor(async () => (await view(A))?.empty === true, 10000),
		await show(A),
	);
	await chatRow(A).click();
	check("switching back brings the queue back", await waitFor(async () => same((await view(A))?.done, [1, 2]), 10000));
	check("B still shows it", same((await view(B)).done, [1, 2]));

	check(
		"the mock got no unscripted messages (no reminders, no continues)",
		unexpected.length === 0,
		unexpected.join(" | "),
	);
	check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (e) {
	failures++;
	console.log(`  ✗ FAIL: ${e?.stack ?? e}`);
} finally {
	await browser?.close();
	mock.close();
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
}

if (failures) {
	console.log(`\n${failures} check(s) failed. Server log tail:\n${serverLog.split("\n").slice(-30).join("\n")}`);
	process.exit(1);
}
console.log("\nall queue-panel checks passed");
