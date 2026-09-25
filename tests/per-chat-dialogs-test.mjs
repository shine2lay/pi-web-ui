/* per-chat-dialogs E2E (no tokens): an extension's pop-up belongs to the chat that asked, not to the window.
 *
 * The real pi-queue extension is loaded through settings.json `packages` (PI_QUEUE_PKG, default
 * ~/projects/pi-queue). Its queue_add asks the user to approve the plan with ctx.ui.confirm. A mock
 * OpenAI-compatible model plays two agents:
 *  - chat A ("DIALOG-A …") waits a few seconds, then calls queue_add with plan A;
 *  - chat B ("DIALOG-B …") calls queue_add with plan B right away.
 * Checks:
 *  - A asks while window 1 shows chat B: B shows no pop-up, A's row in the left list gets the "?",
 *    and the question sound plays once;
 *  - B asks: chat B shows B's pop-up, not A's; one more sound;
 *  - window 2 opens chat A and sees A's pop-up (a chat's pop-ups aren't tied to the window that
 *    opened it); it plays no sound for pop-ups that were already waiting when it connected;
 *  - window 1 switches to A: A's pop-up, no new sound; after a reload it's still there;
 *  - answering A in window 2 closes it in both windows, and A's run goes on; B's pop-up still waits;
 *  - answering B: each chat's Queue tab holds only its own task; no "?" is left.
 * Usage: npm run build && node tests/per-chat-dialogs-test.mjs    (DIALOGS_DEBUG=1 prints the mock's requests;
 *        DIALOGS_SHOT=/tmp/x.png saves x-waiting.png (chat B open, A's row marked) and x-own.png (B's own pop-up))
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
const base = mkdtempSync(join(tmpdir(), "piweb-dialogs-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });

const MODEL_ID = "dialogs-mock";
const RUN_A = "DIALOG-A queue the README task";
const RUN_B = "DIALOG-B queue the timing task";
const A_DONE = "DIALOG-A-DONE the README task is queued.";
const B_DONE = "DIALOG-B-DONE the timing task is queued.";
/** How long chat A's model waits before asking: time to open chat B first. */
const A_DELAY = 4000;
const PLAN_A = {
	title: "Tidy the README",
	goal: "Make the README's setup section match the current install steps",
	done_when: "A fresh reader can install by following it word for word",
	decided: "Only the setup section; keep the tone as it is",
	steps: "1. Compare the section with the install script\n2. Fix the steps\n3. Read it through once",
	verify: "Follow the steps in a clean folder",
	must_not: "Rewrite the other sections",
};
const PLAN_B = {
	title: "Add a timing check",
	goal: "Catch the settings page getting slow again before users do",
	done_when: "A test fails when the page takes longer than a second",
	decided: "Use the existing test runner; one second is the limit",
	steps: "1. Write the timing test\n2. Run it against the page\n3. Report the result",
	verify: "Run the new test and the suite",
	must_not: "Change the page itself",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
	const shown = String(extra)
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, ok ? 80 : 400);
	console.log(`  ${ok ? "✓" : "✗ FAIL:"} ${name}${shown ? " — " + shown : ""}`);
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
	id: "dialogs-mock",
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
/** When chat A's model called queue_add (0 = not yet). */
let aAskedAt = 0;
/** User messages the mock had no script for: should stay empty. */
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
	// Side requests (the title) carry no tools. B first: while A runs, the server puts a reminder
	// naming A's run in front of B's message (agent-service.ts "other run(s)"), so B's text mentions A.
	if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
		await say(body.includes("DIALOG-B") ? "Chat B" : body.includes("DIALOG-A") ? "Chat A" : "Chat");
		return;
	}
	// The prompt is the last user message that isn't the server's parallel-run reminder: while A
	// runs, B's prompt is followed by a "(System reminder: 1 other run(s) [DIALOG-A …]" message.
	let lastUser = -1;
	history.forEach((x, i) => {
		if (x.role === "user" && !textOf(x).startsWith("(System reminder:")) lastUser = i;
	});
	const userText = lastUser >= 0 ? textOf(history[lastUser]) : "";
	const results = history.slice(lastUser + 1).filter((x) => x.role === "tool").length;
	if (process.env.DIALOGS_DEBUG) console.log(`    [mock] ${JSON.stringify(userText.slice(0, 60))} results=${results}`);

	if (userText.includes(RUN_B)) {
		if (results === 0) {
			await sleep(300);
			await call("queue_add", PLAN_B, "call_add_b");
			return;
		}
		await sleep(200);
		await say(B_DONE);
		return;
	}
	if (userText.includes(RUN_A)) {
		if (results === 0) {
			await sleep(A_DELAY);
			aAskedAt = Date.now();
			await call("queue_add", PLAN_A, "call_add_a");
			return;
		}
		await sleep(200);
		await say(A_DONE);
		return;
	}
	unexpected.push(userText.slice(0, 90));
	await sleep(200);
	await say("DIALOG-OTHER ok.");
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
/** How many question cues (sounds.ts QUESTION: 587 → 880 Hz) this page played. */
const questionCues = (page) => page.evaluate(() => window.__cues.filter((c) => c.freqs.join(",") === "587,880").length);

let browser;
const pageErrors = [];
const messagesText = (page) => page.evaluate(() => document.querySelector(".messages")?.innerText ?? "");
async function openWindow(clientId) {
	const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
	await ctx.addInitScript(AUDIO_RECORDER);
	await ctx.addInitScript((id) => {
		localStorage.setItem("pi-web-client-id", id);
		localStorage.setItem("pi-web-ui:lang", "en");
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
const rowA = (page) =>
	page
		.locator(".lp-row", { hasText: /DIALOG-A|Chat A/ })
		.filter({ hasNotText: /DIALOG-B|Chat B/ })
		.first();
const rowB = (page) => page.locator(".lp-row", { hasText: /DIALOG-B|Chat B/ }).first();
const hasBadge = async (row) => (await row.locator(".question-badge").count()) > 0;
/** The row's ? lies inside its title's box, so a long title's ellipsis doesn't hide it. */
const badgeOnScreen = (row) =>
	row
		.locator(".question-badge")
		.first()
		.evaluate((b) => {
			const box = b.closest(".session-title")?.getBoundingClientRect();
			const r = b.getBoundingClientRect();
			return !!box && r.width > 0 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
		});
const dialogText = (page) =>
	page.evaluate(() => [...document.querySelectorAll(".dialog-inline")].map((d) => d.innerText).join(" || "));
const dialogCount = (page) => page.locator(".dialog-inline").count();
const approve = (page) => page.locator(".dialog-inline .dialog-actions .btn.primary").click();
/** Task titles in the open chat's Queue tab, top to bottom. */
const queueTitles = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll(".task-queue-panel .task-queue-title-text")].map((e) => e.textContent.trim()),
	);

try {
	await waitServer();
	browser = await chromium.launch({ executablePath: CHROME_PATH });

	console.log("window 1: chat A asks while chat B is open");
	const W1 = await openWindow("dialogs-window-1");
	await send(W1, RUN_A);
	check("chat A shows up in the list", await waitFor(async () => (await rowA(W1).count()) > 0, 10000));
	await W1.locator(".lp-new-chat-action").click();
	check(
		"a new chat (B) is open before A asks",
		(await waitFor(async () => !(await messagesText(W1)).includes("DIALOG-A"), 10000)) && aAskedAt === 0,
		aAskedAt ? "A asked too early; raise A_DELAY" : "",
	);
	check("A asks for approval", await waitFor(() => aAskedAt > 0, 15000));
	check("A's row gets the ?", await waitFor(() => hasBadge(rowA(W1)), 10000));
	check("… and a long title doesn't hide it", await badgeOnScreen(rowA(W1)));
	await sleep(1000); // time for a wrongly routed pop-up to show up
	check("chat B shows no pop-up", (await dialogCount(W1)) === 0, await dialogText(W1));
	if (process.env.DIALOGS_SHOT)
		await W1.screenshot({ path: process.env.DIALOGS_SHOT.replace(/\.png$/, "-waiting.png") });
	check(
		"the question sound played once, for A",
		await waitFor(async () => (await questionCues(W1)) === 1, 3000),
		String(await questionCues(W1)),
	);

	console.log("window 1: chat B asks too");
	await send(W1, RUN_B);
	check(
		"chat B shows B's pop-up",
		await waitFor(async () => (await dialogText(W1)).includes(PLAN_B.title), 15000),
		await dialogText(W1),
	);
	check("… and not A's", !(await dialogText(W1)).includes(PLAN_A.title), await dialogText(W1));
	check(
		"a second question sound, for B",
		await waitFor(async () => (await questionCues(W1)) === 2, 3000),
		String(await questionCues(W1)),
	);
	check("B's row gets the ? too", await waitFor(() => hasBadge(rowB(W1)), 10000));
	if (process.env.DIALOGS_SHOT) await W1.screenshot({ path: process.env.DIALOGS_SHOT.replace(/\.png$/, "-own.png") });
	check("A's row keeps its ?", await hasBadge(rowA(W1)));

	console.log("window 2: open chat A");
	const W2 = await openWindow("dialogs-window-2");
	await rowA(W2).click();
	check(
		"window 2 sees A's pop-up",
		await waitFor(async () => (await dialogText(W2)).includes(PLAN_A.title), 10000),
		await dialogText(W2),
	);
	check("window 2 shows one pop-up only", (await dialogCount(W2)) === 1, await dialogText(W2));

	console.log("window 1: switch to A, then reload");
	await rowA(W1).click();
	check(
		"window 1 shows A's pop-up in chat A",
		await waitFor(async () => (await dialogText(W1)).includes(PLAN_A.title), 10000),
		await dialogText(W1),
	);
	check("… and not B's", !(await dialogText(W1)).includes(PLAN_B.title), await dialogText(W1));
	await sleep(500);
	check("no new sound for a pop-up already heard", (await questionCues(W1)) === 2, String(await questionCues(W1)));
	await W1.reload();
	await W1.waitForSelector(".topbar", { timeout: 60000 });
	await W1.locator(".inputbox textarea").waitFor({ timeout: 20000 });
	await rowA(W1).click();
	check(
		"after a reload A's pop-up is still there",
		await waitFor(async () => (await dialogText(W1)).includes(PLAN_A.title), 15000),
		await dialogText(W1),
	);
	await sleep(500);
	check(
		"no sound after the reload for pop-ups that were already waiting",
		(await questionCues(W1)) === 0,
		String(await questionCues(W1)),
	);

	console.log("window 2: approve A");
	await approve(W2);
	check("A's pop-up closes in window 2", await waitFor(async () => (await dialogCount(W2)) === 0, 10000));
	check("… and in window 1", await waitFor(async () => (await dialogCount(W1)) === 0, 10000), await dialogText(W1));
	check("A's run goes on and answers", await waitFor(async () => (await messagesText(W1)).includes(A_DONE), 15000));
	check("A's ? is gone", await waitFor(async () => !(await hasBadge(rowA(W1))), 10000));
	check("B's ? is still there", await hasBadge(rowB(W1)));
	await openQueueTab(W1);
	check(
		"A's queue holds A's task only",
		await waitFor(async () => same(await queueTitles(W1), [PLAN_A.title]), 10000),
		JSON.stringify(await queueTitles(W1)),
	);

	console.log("window 1: back to B, approve it");
	await rowB(W1).click();
	check(
		"B's pop-up is still waiting",
		await waitFor(async () => (await dialogText(W1)).includes(PLAN_B.title), 10000),
		await dialogText(W1),
	);
	check(
		"B's queue is still empty",
		await waitFor(async () => same(await queueTitles(W1), []), 10000),
		JSON.stringify(await queueTitles(W1)),
	);
	await approve(W1);
	check("B's pop-up closes", await waitFor(async () => (await dialogCount(W1)) === 0, 10000), await dialogText(W1));
	check("B's run goes on and answers", await waitFor(async () => (await messagesText(W1)).includes(B_DONE), 15000));
	check(
		"B's queue holds B's task only",
		await waitFor(async () => same(await queueTitles(W1), [PLAN_B.title]), 10000),
		JSON.stringify(await queueTitles(W1)),
	);
	await rowA(W1).click();
	check(
		"A's queue still holds A's task only",
		await waitFor(async () => same(await queueTitles(W1), [PLAN_A.title]), 10000),
		JSON.stringify(await queueTitles(W1)),
	);
	check(
		"no ? left in the list",
		await waitFor(async () => (await W1.locator(".lp-row .question-badge").count()) === 0, 10000),
	);
	check(
		"window 2 played no question sound (both pop-ups were waiting when it connected)",
		(await questionCues(W2)) === 0,
		String(await questionCues(W2)),
	);
	check("the mock got no unscripted messages", unexpected.length === 0, unexpected.join(" | "));
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
console.log("\nall per-chat-dialogs checks passed");
