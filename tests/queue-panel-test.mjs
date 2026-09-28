/* queue-panel E2E (no tokens): the right panel's Queue tab shows and steers the chat's pi-queue queue.
 *
 * The real pi-queue extension is loaded through settings.json `packages` (PI_QUEUE_PKG, default
 * ~/projects/pi-queue). A mock OpenAI-compatible model plays the agent:
 *  - the planning run calls queue_add three times (the user approves each plan in the dialog), then answers;
 *  - each task runs in a chat of its own, which starts with "[Queue] Task #N: <title>": "Add a timing
 *    check" -> queue_done; "Rename the settings button" -> queue_stuck (with 2 choices); the user's answer,
 *    typed in the Queue tab, goes into that task's chat -> queue_done.
 *    The plans list nothing they touch, so each runs alone: one task chat at a time.
 * Checks:
 *  - queue_add is offered to the model inside pi-web-ui (pi-queue loaded, hasUI);
 *  - a long plan's approval dialog scrolls its text and keeps OK / Cancel in view (Dialog.tsx);
 *  - window A's Queue tab shows each approved task live, in order, not running;
 *  - window B opens the same chat and sees them; ↓ in A and ✕ (inline confirm) in B show up live in both;
 *  - clicking a title opens the task's plan;
 *  - the dialog says a plan that lists nothing it touches runs alone;
 *  - Start runs the queue: #2 works in a chat of its own (its row links to it), then is done with its
 *    summary; only then #1 starts in its own chat and needs the user, with the question, its choices as
 *    buttons and a box to type an answer, highlighted in both windows; the queue's chat gets a note for each; each task chat that stopped rings one done cue
 *    in each window, and the windows on the queue's chat hear no start tick (it doesn't run itself);
 *  - an answer typed in the Queue tab goes into #1's chat and finishes #1; #1's row opens its chat: it
 *    has only its plan, the question, the answer and the finish, and its Queue tab says where the queue
 *    is; the queue's chat shows "All done.", Start disabled, done tasks newest first;
 *  - after a reload the queue is still there; a new chat shows the empty state; switching back brings it back.
 * Usage: npm run build && node tests/queue-panel-test.mjs    (QUEUE_DEBUG=1 prints the mock's requests;
 *        QUEUE_SHOT=/tmp/x.png saves screenshots: x-dialog.png, x-plan.png, x-stuck.png, x-done.png)
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const MOCK_PORT = PORT + 1;
const REPO = fileURLToPath(new URL("..", import.meta.url));
// The account's home (userInfo), not HOME: a sealed test run has a temp HOME.
const PI_QUEUE = process.env.PI_QUEUE_PKG ?? join(userInfo().homedir, "projects", "pi-queue");
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
/** queue_stuck asks with 2-4 answers to pick from (telegram-answers); the Queue tab shows them as buttons. */
const STUCK_CHOICES = ["Settings", "Preferences"];
const ANSWER = "QUEUE-ANSWER use Settings as the label";
/** done-settle's wait (web/src/done-settle.ts DONE_SETTLE_MS) plus room for a late cue. */
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
/** Task chats' kickoffs and finishes, in the order the mock saw them. */
const taskEvents = [];
const taskEvent = (e) => {
	if (!taskEvents.includes(e)) taskEvents.push(e);
};
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
	// pi-web-ui adds reminders of its own as user messages (e.g. other runs going on); they aren't the user's.
	const users = [];
	history.forEach((x, i) => {
		if (x.role === "user" && !/^\(System reminder/.test(textOf(x))) users.push(i);
	});
	const first = users[0] ?? -1;
	const last = users.at(-1) ?? -1;
	const userText = last >= 0 ? textOf(history[last]) : "";
	const results = history.slice(last + 1).filter((x) => x.role === "tool").length;
	// A task's chat starts with its kickoff, "[Queue] Task #N: <title>" on the first line.
	const kick = (first >= 0 ? textOf(history[first]) : "").match(/^\[Queue\] Task #(\d+): ([^\n]+)/);
	const kickoffTurn = !!kick && last === first;
	if (process.env.QUEUE_DEBUG) console.log(`    [mock] ${kick ? `task #${kick[1]}` : "queue chat"} step ${results}`);

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
	if (kickoffTurn && kick[2] === PLANS[1].title) {
		if (results === 0) {
			taskEvent("start #2");
			await sleep(2500); // long enough to see #2 at work in both windows
			taskEvent("done #2");
			await call("queue_done", { summary: TIMING_SUMMARY }, "call_done_timing");
			return;
		}
		await sleep(300);
		await say("QUEUE-DONE-TIMING the timing check is in.");
		return;
	}
	if (kickoffTurn && kick[2] === PLANS[0].title) {
		if (results === 0) {
			taskEvent("start #1");
			// Stop well after #2's chat did: stops within done-settle's wait share one sound.
			await sleep(SETTLE_WAIT);
			await call("queue_stuck", { question: STUCK_QUESTION, choices: STUCK_CHOICES }, "call_stuck");
			return;
		}
		await sleep(300);
		await say(`QUEUE-ASK ${STUCK_QUESTION}`);
		return;
	}
	if (kick?.[2] === PLANS[0].title && userText.startsWith(ANSWER)) {
		if (results === 0) {
			await sleep(600);
			await call("queue_done", { summary: RENAME_SUMMARY }, "call_done_rename");
			return;
		}
		await sleep(300);
		await say("QUEUE-DONE-RENAME renamed.");
		return;
	}
	unexpected.push(kick ? `task #${kick[1]}: a user message` : "queue chat: a user message");
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
const pageText = (page) => page.evaluate(() => document.body.innerText);
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
			inChats: ids("lane"),
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
			choices: [...p.querySelectorAll(".task-queue-choice")].map((b) => b.textContent.trim()),
			answerBox: !!p.querySelector(".task-queue-answer-input"),
			hints: [...p.querySelectorAll(".task-queue-hint")].map((e) => e.textContent.trim()),
			links: [...p.querySelectorAll("li.task-queue-task")]
				.filter((li) => li.querySelector(".task-queue-open-chat"))
				.map((li) => Number(li.dataset.taskId)),
			from: p.querySelector(".task-queue-from")?.textContent?.trim() ?? "",
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
			check(
				"the dialog says a plan that lists nothing it touches runs alone",
				/runs alone/.test(await dialog.innerText()),
			);
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
	check(
		"3 tasks wait in order, nothing running",
		same(a.next, [1, 2, 3]) && a.now.length === 0 && a.inChats.length === 0,
		JSON.stringify(a),
	);
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

	console.log("window A: Start: each task runs in a chat of its own, one at a time (they list nothing they touch)");
	// The planning run's own done cue lands SETTLE after it ends; count from after it.
	await waitFor(async () => (await cueCounts(A)).done >= 1, SETTLE_WAIT);
	await sleep(500);
	const a0 = await cueCounts(A);
	const b0 = await cueCounts(B);
	await A.locator(".task-queue-panel .task-queue-toggle.start").click();
	check(
		"A: #2 works in a chat of its own, with a link to it; #1 waits; Stop is offered",
		await waitFor(async () => {
			const v = await view(A);
			return (
				same(v.inChats, [2]) &&
				same(v.links, [2]) &&
				same(v.next, [1]) &&
				v.now.length === 0 &&
				v.status.startsWith("Running") &&
				v.status.endsWith(" #2 is working in its own chat") &&
				v.toggle === "stop"
			);
		}, 10000),
		await show(A),
	);
	check("B: follows live", await waitFor(async () => same((await view(B)).inChats, [2]), 5000), await show(B));
	check(
		"A: #2 is done with its summary; then #1 works in its own chat and needs you, with the question, its choices and a box to type in",
		await waitFor(async () => {
			const v = await view(A);
			return (
				same(v.done, [2]) &&
				same(v.inChats, [1]) &&
				same(v.needsYou, [1]) &&
				v.question === STUCK_QUESTION &&
				same(v.choices, STUCK_CHOICES) &&
				v.answerBox &&
				v.hints.includes("Your answer goes into the task's own chat and it carries on.") &&
				v.summaries[0] === TIMING_SUMMARY &&
				v.status === "Waiting for your answer on #1"
			);
		}, 20000),
		await show(A),
	);
	check(
		"B: the same, live",
		await waitFor(async () => {
			const v = await view(B);
			return (
				same(v.done, [2]) && same(v.needsYou, [1]) && v.question === STUCK_QUESTION && same(v.choices, STUCK_CHOICES)
			);
		}, 5000),
		await show(B),
	);
	check(
		"one at a time: #1's chat started only after #2 was done",
		same(taskEvents, ["start #2", "done #2", "start #1"]),
		JSON.stringify(taskEvents),
	);
	// pi-queue saves the new state first (the tab shows it) and posts the note right after, so wait for it.
	const wanted = [
		`Task #2 (${PLANS[1].title}) is done in its chat`,
		`Task #1 (${PLANS[0].title}) needs the user in its chat`,
	];
	let missing = wanted;
	check(
		"the queue's chat got a note for each: #2 is done, #1 needs you, each in its own chat",
		await waitFor(async () => {
			const text = await pageText(A);
			missing = wanted.filter((n) => !text.includes(n));
			return missing.length === 0;
		}, 10000),
		missing.length ? `missing: ${missing.join(" | ")}` : "",
	);
	// Each task chat that stopped rings one done cue in every window (done-any-chat). done-settle merges
	// stops within DONE_SETTLE_MS into one sound, so #1's chat stops well after #2's (the mock above).
	// The queue's chat doesn't run itself, so the windows on it hear no start tick.
	await waitFor(async () => (await cueCounts(A)).done >= a0.done + 2, SETTLE_WAIT + 10000);
	await sleep(SETTLE_WAIT);
	for (const [name, page, c0] of [
		["A", A, a0],
		["B", B, b0],
	]) {
		const c = await cueCounts(page);
		check(
			`${name}: one done cue per task chat that stopped (2), no start tick`,
			c.start - c0.start === 0 && c.done - c0.done === 2,
			`start +${c.start - c0.start}, done +${c.done - c0.done}`,
		);
	}
	await shot(A, "stuck");

	console.log("window A: answer #1 in the Queue tab, then open its chat from its row");
	await A.locator('.task-queue-panel li[data-task-id="1"] .task-queue-answer-input').fill(ANSWER);
	await A.locator('.task-queue-panel li[data-task-id="1"] .task-queue-answer-send').click();
	check(
		"the answer typed in the Queue tab goes into #1's chat, and #1 finishes",
		await waitFor(async () => same((await view(A))?.done, [1, 2]), 30000),
		await show(A),
	);
	await A.locator('.task-queue-panel li[data-task-id="1"] .task-queue-open-chat').click();
	check(
		"#1's row opens its chat: it started with its plan, asked, got the answer there and finished",
		await waitFor(async () => {
			const text = await messagesText(A);
			return (
				text.includes(`[Queue] Task #1: ${PLANS[0].title}`) &&
				text.includes("QUEUE-ASK") &&
				text.includes(ANSWER) &&
				text.includes("QUEUE-DONE-RENAME")
			);
		}, 15000),
	);
	check("#1's chat has none of the queue chat's history", !(await messagesText(A)).includes("QUEUE-PLAN"));
	check(
		"its Queue tab says where the queue is, with no Start/Stop",
		await waitFor(async () => {
			const v = await view(A);
			return !!v?.from.startsWith("This chat works on a queued task") && v.toggle === "";
		}, 10000),
		await show(A),
	);
	await A.locator(".task-queue-from .task-queue-open-chat").click();
	check(
		"back in the queue's chat: #1 is done too; all done; Start is disabled",
		await waitFor(async () => {
			const v = await view(A);
			return (
				same(v.done, [1, 2]) &&
				v.inChats.length === 0 &&
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

	console.log("window B: clear the done tasks");
	await B.locator(".task-queue-panel .task-queue-clear").click();
	check(
		"Clear empties the list in both windows",
		await waitFor(async () => (await view(A))?.empty === true && (await view(B))?.empty === true, 10000),
		`${await show(A)} | ${await show(B)}`,
	);
	await A.reload();
	await A.waitForSelector(".topbar", { timeout: 60000 });
	await A.locator(".task-queue-panel").waitFor({ timeout: 10000 });
	check(
		"the clear sticks after a reload",
		await waitFor(async () => (await view(A))?.empty === true, 10000),
		await show(A),
	);

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
