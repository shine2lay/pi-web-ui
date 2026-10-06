/* queue-paused E2E (no tokens): "Paused by you", the owner's real pause on a queued task or a whole queue.
 *
 * A sealed test server with the real pi-queue (PI_QUEUE_PKG, default ~/projects/pi-queue) and the real
 * pi-identity (PI_IDENTITY_PKG), the mock model, plain WebSocket clients and a real browser for the Queue
 * tab and the Roles page. Test clocks: block pokes at 8, 12 and 16 s (PI_QUEUE_TEST_BLOCK_POKES_MS), the
 * server's block check every second, the watchdog's "stopped" after 3 s (pi-queue.json stalledAfterMinutes
 * 0.05 with PI_QUEUE_TEST_FAST=1). Three roles: tooling (queue A, six lanes), temper (a home chat that
 * answers a question) and design (queue C: one lane, Auto start on, its task #1 paused from the start).
 *
 * Queue A, each task in a chat of its own:
 *   A#1 "Long work": asks temper a question, then is paused from the Queue tab (a click) while its turn is
 *       still going. It gets one "stop at a safe point" note and stops; it is never aborted. Then temper's
 *       reply, a scheduled wake-up bound to its chat and the watchdog all reach it: each goes in without a
 *       turn (no model call), and the task stays working. Resume (a click): one "Back to task #1: the owner
 *       lifted the pause (paused HH:MM–HH:MM)" turn, whose context has the reply and the wake-up; it finishes.
 *   A#2 "Need a login": blocked on a need, then paused by the main chat's queue_control (the owner's words,
 *       relayed): no poke and no ask over the whole poke schedule; on resume its pokes count from the
 *       resume (the first one 8 s later), and it finishes.
 *   A#3 "Wait for flag": on hold with a 15 s give-up, paused with A#2: its checks stop and it doesn't give up
 *       past its give-up time; on resume that time moves later by exactly the time paused, its checks go
 *       on, and it finishes once its file is there.
 * Queue C (Auto start on, one lane): its paused ready task #1 is skipped and #2 starts. "Pause queue" (a
 * click): #2 gets one note and stops, #3 doesn't start; the Queue tab shows the banner and the Roles page
 * says "Queue paused by you". "Resume queue": #2 gets its back note first and finishes, then #3 runs; #1's
 * own pause outlives the queue's, until its own Resume (a click). Order of starts: #2, #3, #1.
 * The mock's script checks what the chats get; nothing the model is sent is printed.
 *
 * Usage: npm run build && PI_QUEUE_PKG=<pi-queue checkout> node tests/run-sealed.mjs queue-paused
 *        QP_SHOT_DIR=<dir>: screenshots. QP_DEBUG=1: server log.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { textOf } from "./lib/mock-model.mjs";
import { ownServer } from "./lib/own-server.mjs";

const HOME = userInfo().homedir;
const PI_QUEUE = process.env.PI_QUEUE_PKG ?? join(HOME, "projects", "pi-queue");
const PI_IDENTITY = process.env.PI_IDENTITY_PKG ?? join(HOME, "projects", "pi-identity");
for (const [name, dir] of [
	["pi-queue", PI_QUEUE],
	["pi-identity", PI_IDENTITY],
]) {
	if (!existsSync(join(dir, "package.json"))) {
		console.log(
			`✗ FAIL: ${name} not found at ${dir} (set ${name === "pi-queue" ? "PI_QUEUE_PKG" : "PI_IDENTITY_PKG"})`,
		);
		process.exit(1);
	}
}
const POKES_MS = [8000, 12000, 16000];
const GIVE_UP_MS = 15_000;
/** pi-queue's note to a working task the owner paused (queue.ts HOLD_NOTE). */
const HOLD_NOTE =
	"[Queue] The owner paused this task: finish the step you're on and note where you stopped. " +
	"Don't start new runs, workflows or wake-ups, and cancel wake-ups you scheduled. Then end your turn.";
const BACK_RE = (id) =>
	new RegExp(
		`^\\[Queue\\] Back to task #${id}: the owner lifted the pause \\(paused \\d\\d:\\d\\d\\u2013\\d\\d:\\d\\d\\)\\. Carry on where you stopped\\.`,
	);
const STALL_RE = /^\[Queue\] This chat stopped while its task was still being worked on/;
const RELAYED_WHY = "owner on Telegram, relayed by COO (rm-0000test): pause tasks 2 and 3 to save Claude limits";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`  ${ok ? "✓" : "✗ FAIL:"} ${name}${extra && !ok ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
	return ok;
};
/** A check the rest of the test can't go on without. */
const must = (name, ok, extra = "") => {
	if (!check(name, ok, extra)) throw new Error(`stopped: ${name}`);
};
async function waitFor(fn, ms = 20_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		try {
			const v = await fn();
			if (v) return v;
		} catch {
			/* not yet */
		}
		await sleep(150);
	}
	return null;
}

// ---- seeded chats -------------------------------------------------------------------------------------
const files = {};
let idDir = "";
let workdir = "";
const plan = (title) => ({
	title,
	goal: `${title}: the agreed result is in place for the team`,
	doneWhen: "The page shows the agreed result on the test account",
	decided: "Change only this part, then look at the page again",
	steps: "1. Make the change\n2. Look at the page\n3. Run the checks",
	verify: "Open the page and run the existing checks",
	mustNot: "Touch anything else on the page",
});
const A_TASKS = { 1: "Long work", 2: "Need a login", 3: "Wait for flag" };
const C_TASKS = { 1: "C one", 2: "C two", 3: "C three" };
const C_ID = "01a0f000-0000-7000-8000-0000000000c3";
/** Turns held by the mock until the test lets them go on. */
const go = new Set();

function seed({ root, agentDir, workdir: wd }) {
	workdir = wd;
	const settingsFile = join(agentDir, "settings.json");
	const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
	writeFileSync(
		settingsFile,
		JSON.stringify(
			{ ...settings, defaultProvider: "mock", defaultModel: "mock-model", packages: [PI_QUEUE, PI_IDENTITY] },
			null,
			2,
		),
	);
	// The watchdog: a working task's chat counts as stopped after 3 s.
	writeFileSync(join(agentDir, "pi-queue.json"), JSON.stringify({ stalledAfterMinutes: 0.05 }));
	const dir = join(agentDir, "sessions", `--${wd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(dir, { recursive: true });
	files.A = join(dir, "2026-10-01T10-01-00-000Z_01a0f000-0000-7000-8000-0000000000a1.jsonl");
	files.T = join(dir, "2026-10-01T10-02-00-000Z_01a0f000-0000-7000-8000-0000000000b2.jsonl");
	files.C = join(dir, `2026-10-01T10-03-00-000Z_${C_ID}.jsonl`);
	files.flag = join(wd, "flag-3");
	files.checks = join(wd, "checks-3.log");
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const write = (path, items) => {
		let ts = Date.parse("2026-10-01T10:00:00.000Z");
		const id = path.match(/_([^_]+)\.jsonl$/)?.[1];
		const lines = [
			{ type: "session", version: 3, id, timestamp: new Date(ts).toISOString(), cwd: wd },
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
			if (item.queue) lines.push({ type: "custom", customType: "queue", ...base, data: { v: 1, ts, ...item.queue } });
			else if (item.identity)
				lines.push({
					type: "custom",
					customType: "identity",
					...base,
					data: { v: 1, id: item.identity, via: "command" },
				});
			else if (item.name) lines.push({ type: "session_info", ...base, name: item.name });
			else if (item.user)
				lines.push({
					type: "message",
					...base,
					message: { role: "user", content: [{ type: "text", text: item.user }], timestamp: ts },
				});
			else if (item.assistant)
				lines.push({
					type: "message",
					...base,
					message: {
						role: "assistant",
						content: [{ type: "text", text: item.assistant }],
						api: "openai-completions",
						provider: "mock",
						model: "mock-model",
						usage,
						stopReason: "stop",
						timestamp: ts,
					},
				});
			parentId = base.id;
		}
		writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	};
	write(files.A, [
		{ identity: "tooling" },
		{ name: "tooling" },
		...Object.entries(A_TASKS).map(([id, title]) => ({
			queue: { op: "add", id: Number(id), plan: plan(title), touches: [`a${id} repo`] },
		})),
		{ queue: { op: "lanes", n: 6 } },
	]);
	write(files.T, [{ identity: "temper" }, { name: "temper" }, { user: "temper home starts" }, { assistant: "ok" }]);
	write(files.C, [
		{ identity: "design" },
		{ name: "design" },
		...Object.entries(C_TASKS).map(([id, title]) => ({
			queue: { op: "add", id: Number(id), plan: plan(title), touches: [`c${id} repo`] },
		})),
		{ queue: { op: "lanes", n: 1 } },
		// The owner paused C#1 in the Queue panel before Auto start was switched on.
		{ queue: { op: "hold", id: 1, why: "pressed Pause in the Queue panel", by: "panel" } },
		{ queue: { op: "autonomy", queueId: C_ID, setting: "autoStart", value: true } },
	]);
	idDir = join(root, "identities");
	const role = (id, json) => {
		mkdirSync(join(idDir, id), { recursive: true });
		writeFileSync(join(idDir, id, "identity.json"), JSON.stringify({ id, ...json }, null, "\t"));
		writeFileSync(join(idDir, id, "about.md"), `# ${json.title}\n\n**Focus:** ${json.title.toLowerCase()}.\n`);
		writeFileSync(join(idDir, id, "notebook.md"), "");
	};
	role("tooling", { title: "Tooling", homeChat: files.A });
	role("temper", { title: "Temper", homeChat: files.T });
	role("design", { title: "Design", homeChat: files.C });
}

// ---- the mock model ---------------------------------------------------------------------------------------
/** What the chats got (kept here, never printed). */
const seen = {
	calls: new Map(), // task title -> model calls for its chat
	started: new Map(), // task title -> first kickoff
	a1Asked: "",
	a1Back: null, // { at, sawReply, sawWake }
	c2Back: 0,
	pokes2: [], // [{ at, text }]
	notes3: [], // [{ at, text }]
	cards: [], // [{ at, text }] in queue chats
	mainResults: new Map(), // prompt -> tool results
	tQuestion: "",
	tReplied: "",
	stopped: new Map(), // task title -> when its chat stopped after the hold note
};
const unexpected = [];
const HEADER = /^\[Role message (rm-[0-9a-f]{8}) from (\S+) /;

async function holdUntil(key) {
	const t0 = Date.now();
	while (!go.has(key) && Date.now() - t0 < 480_000) await sleep(200);
	return go.has(key);
}

async function modelReply({ payload, sideRequest }) {
	if (sideRequest) return "Paused test";
	const history = Array.isArray(payload.messages) ? payload.messages : [];
	const users = [];
	history.forEach((m, i) => {
		if (m.role === "user" && !/^\(System reminder/.test(textOf(m))) users.push(i);
	});
	const first = users[0] ?? -1;
	const firstText = first >= 0 ? textOf(history[first]) : "";
	const kick = firstText.match(/^\[Queue\] Task #(\d+): (.+)/);
	// A queue chat's notes from pi-queue (reports, not turns of their own; a card is a turn).
	const isNote = (i) => {
		const t = textOf(history[i]).trim();
		return !kick && /^\[Queue\]/.test(t) && !/^\[Queue\] Task #\d+ asks\b/.test(t);
	};
	const anchors = users.filter((i) => !isNote(i));
	const last = anchors.at(-1) ?? -1;
	const userText = last >= 0 ? textOf(history[last]).trim() : "";
	const results = history
		.slice(last + 1)
		.filter((m) => m.role === "tool")
		.map(textOf);
	const step = results.length;
	const all = history.map(textOf).join("\n");

	if (!kick) {
		if (firstText === "temper home starts") {
			// Temper's home chat answers A#1's question once the test lets it (A#1 is paused by then).
			const rm = HEADER.exec(userText);
			if (rm && userText.includes("Q-A1")) {
				if (step === 0) {
					seen.tQuestion = rm[1];
					if (!(await holdUntil("reply"))) return "T-GAVE-UP";
					return {
						tool: "message_role",
						args: { to: "tooling", kind: "reply", replyTo: rm[1], text: "R-A1: use the main branch." },
					};
				}
				seen.tReplied = results[0] ?? "";
				return "T-REPLIED";
			}
			return "T-OTHER ok.";
		}
		// A queue's chat.
		if (userText === "PAUSE-2-3" || userText === "RESUME-2-3") {
			const action = userText.startsWith("PAUSE") ? "pause" : "resume";
			if (step < 2) return { tool: "queue_control", args: { action, id: step + 2, why: RELAYED_WHY } };
			seen.mainResults.set(userText, results);
			return "MC-DONE";
		}
		if (/^\[Queue\] Task #\d+ asks\b/.test(userText)) {
			if (step === 0) seen.cards.push({ at: Date.now(), text: userText });
			return "MC-NOT-SURE";
		}
		return "MC-OTHER ok.";
	}

	const title = kick[2].trim();
	seen.calls.set(title, (seen.calls.get(title) ?? 0) + 1);
	const kickoff = last === first;
	if (kickoff && step === 0 && !seen.started.has(title)) seen.started.set(title, Date.now());
	if (userText === HOLD_NOTE) {
		if (step === 0) {
			seen.stopped.set(title, Date.now());
			return `${title}: stopped after step one; next is step two.`;
		}
		unexpected.push(`${title}: a tool result after the hold note`);
		return "X";
	}

	if (title === "Long work") {
		if (kickoff) {
			if (step === 0)
				return {
					tool: "message_role",
					args: { to: "temper", kind: "question", text: "Q-A1: which branch should the long work use?" },
				};
			if (step === 1) {
				seen.a1Asked = results[0] ?? "";
				if (!(await holdUntil("A1"))) return "A1-GAVE-UP";
				return { tool: "bash", args: { command: "echo step one done" } };
			}
			return "A1-NO-NOTE";
		}
		if (BACK_RE(1).test(userText)) {
			if (step === 0) {
				seen.a1Back = { at: Date.now(), sawReply: all.includes("R-A1"), sawWake: all.includes("S-A1") };
				return { tool: "queue_done", args: { summary: "Long work finished on the main branch" } };
			}
			return "A1-DONE";
		}
		unexpected.push(`Long work: a message (${STALL_RE.test(userText) ? "the watchdog's note" : "other"})`);
		return "A1-OTHER";
	}
	if (title === "Need a login") {
		if (kickoff) {
			if (step === 0) return { tool: "queue_blocked", args: { need: "the staging login" } };
			return "A2-BLOCKED";
		}
		if (step === 0) {
			seen.pokes2.push({ at: Date.now(), text: userText });
			if (/the owner lifted the pause/.test(userText)) unexpected.push("Need a login: a back-from-pause note");
			return { tool: "queue_done", args: { summary: "Got the staging login" } };
		}
		return "A2-DONE";
	}
	if (title === "Wait for flag") {
		if (kickoff) {
			if (step === 0)
				return {
					tool: "queue_wait",
					args: {
						what: "a flag file",
						check: `echo x >> ${files.checks}; test -f ${files.flag}`,
						every_minutes: 0.02,
						give_up_hours: GIVE_UP_MS / 3_600_000,
					},
				};
			return "A3-WAITING";
		}
		if (step === 0) {
			seen.notes3.push({ at: Date.now(), text: userText });
			if (/^\[Queue\] Back to task #3: Wait for flag/.test(userText))
				return { tool: "queue_done", args: { summary: "The flag file is there" } };
			return "A3-OTHER";
		}
		return "A3-DONE";
	}
	if (title === "C two") {
		if (kickoff) {
			if (step === 0) {
				if (!(await holdUntil("C2"))) return "C2-GAVE-UP";
				return { tool: "bash", args: { command: "echo c2 step one" } };
			}
			return "C2-NO-NOTE";
		}
		if (BACK_RE(2).test(userText)) {
			if (step === 0) {
				seen.c2Back++;
				return { tool: "queue_done", args: { summary: "C two finished" } };
			}
			return "C2-DONE";
		}
		unexpected.push(`C two: a message (${STALL_RE.test(userText) ? "the watchdog's note" : "other"})`);
		return "C2-OTHER";
	}
	if (title === "C one" || title === "C three") {
		if (kickoff) {
			if (step === 0) return { tool: "queue_done", args: { summary: `${title} finished` } };
			return "C-DONE";
		}
		unexpected.push(`${title}: a message`);
		return "C-OTHER";
	}
	unexpected.push(`${title}: a message`);
	return "OTHER ok.";
}

// ---- a window, as a WebSocket client ---------------------------------------------------------------------
class Client {
	constructor(ws, name) {
		this.ws = ws;
		this.name = name;
		this.received = [];
		this.state = null;
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			if (message.type === "snapshot") this.state = message.state;
			else if (message.type === "snapshot_delta") {
				if (this.state && this.state.rev === message.baseRev && message.conversationId === this.state.conversationId)
					this.state = { ...this.state, ...message.state };
				else this.send({ type: "get_state" });
			}
		});
	}
	send(message) {
		if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
	}
	async open(file) {
		this.send({ type: "switch_session", path: file });
		if (!(await waitFor(() => this.state?.sessionFile === file, 20_000)))
			throw new Error(`[${this.name}] couldn't open a chat`);
	}
	async prompt(text) {
		await waitFor(() => this.state && !this.state.isStreaming, 30_000);
		this.send({ type: "prompt", text });
		await sleep(400);
		await waitFor(() => this.state && !this.state.isStreaming, 30_000);
	}
	close() {
		try {
			this.ws.close();
		} catch {
			/* gone */
		}
	}
}

const srv = await ownServer({
	name: "queue-paused",
	mock: modelReply,
	prepare: seed,
	verbose: !!process.env.QP_DEBUG,
	env: {
		PI_WEB_TOKEN: "",
		PI_QUEUE_TEST_FAST: "1",
		PI_QUEUE_TEST_BLOCK_POKES_MS: POKES_MS.join(","),
		PI_WEB_QUEUE_BLOCKS_MS: "1000",
		get PI_IDENTITY_DIR() {
			return idDir;
		},
		PI_IDENTITY_REINDEX: "0",
	},
});
const hardStop = setTimeout(() => {
	console.log("✗ FAIL: the test took too long");
	process.exit(1);
}, 600_000);
hardStop.unref();

async function connect(name) {
	const ws = new WebSocket(srv.ws);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const c = new Client(ws, name);
	c.send({ type: "hello", clientId: `${name}-${Date.now()}`, locale: "en" });
	if (!(await waitFor(() => c.received.some((m) => m.type === "ready"), 60_000))) throw new Error("no ready");
	if (!(await waitFor(() => c.state?.conversationId, 20_000))) throw new Error("no snapshot");
	return c;
}

/** A queue's tasks as the server reads them for a window on that chat. */
const tasksIn = (c) => c.state?.taskQueue?.tasks ?? [];

/** A transcript's lines, parsed (read only). */
function lines(file) {
	try {
		return readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}
const opsIn = (file) =>
	lines(file)
		.filter((e) => e.type === "custom" && e.customType === "queue")
		.map((e) => e.data);
/** A task's status from its queue's ops (the ones this test cares about). */
function statusIn(file, id) {
	let status = "gone";
	for (const op of opsIn(file)) {
		if (op.id !== id) continue;
		if (op.op === "add") status = "ready";
		else if (op.op === "start") status = "working";
		else if (op.op === "block") status = "blocked";
		else if (op.op === "resume") status = "working";
		else if (op.op === "done") status = "done";
		else if (op.op === "remove") status = "removed";
		else if (op.op === "stuck") status = "stuck";
		else if (op.op === "ask") status = "asking";
		else if (op.op === "wait") status = "waiting";
	}
	return status;
}
const chatOf = (file, id) => [...opsIn(file)].reverse().find((op) => op.op === "chat" && op.id === id)?.file;
const holdOp = (file, id) => opsIn(file).find((op) => op.op === "hold" && op.id === id);
const releaseOp = (file, id) => opsIn(file).find((op) => op.op === "release" && op.id === id);
/** A transcript's user messages' texts. */
const userTexts = (file) =>
	lines(file)
		.filter((e) => e.type === "message" && e.message?.role === "user")
		.map((e) => textOf(e.message).trim());
const holdNotes = (file) => userTexts(file).filter((t) => t === HOLD_NOTE).length;
/** A transcript's custom messages of one kind, as texts. */
const customTexts = (file, type) =>
	lines(file)
		.filter((e) => e.type === "custom_message" && e.customType === type)
		.map((e) => textOf(e));
const lastMessage = (file) =>
	lines(file)
		.filter((e) => e.type === "message")
		.map((e) => ({ role: e.message?.role, text: textOf(e.message) }))
		.at(-1);
const checkCount = () => {
	try {
		return readFileSync(files.checks, "utf8").split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
};

// ---- a real browser -----------------------------------------------------------------------------------------
let browser = null;
const pageErrors = [];
const SHOTS = process.env.QP_SHOT_DIR;
async function openQueue(clientId, file) {
	const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
	await ctx.addInitScript((id) => {
		localStorage.setItem("pi-web-client-id", id);
		localStorage.setItem("pi-web-ui:lang", "en");
	}, clientId);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => pageErrors.push(`${clientId}: ${e}`));
	await page.goto(`${srv.http}/?chat=${encodeURIComponent(file)}`);
	await page.waitForSelector(".topbar", { timeout: 60_000 });
	await page.locator(".panel-right .slot-tab", { hasText: "Queue" }).first().click();
	await page.locator(".task-queue-panel, .panel-right .task-queue").first().waitFor({ timeout: 10_000 });
	return page;
}
/** A task's row in the Queue tab: its classes, its pause line, its Pause/Resume button. */
const rowOf = (page, id) =>
	page.evaluate((n) => {
		const li = document.querySelector(`li.task-queue-task[data-task-id="${n}"]`);
		if (!li) return null;
		return {
			cls: li.className,
			paused: li.querySelector(".task-queue-paused")?.getAttribute("data-paused") ?? "",
			line: li.querySelector(".task-queue-paused")?.textContent ?? "",
			button: li.querySelector("button.task-queue-pause")?.textContent ?? "",
		};
	}, id);
const headerOf = (page) =>
	page.evaluate(() => ({
		button: document.querySelector("button.task-queue-pause-queue")?.textContent ?? "",
		banner: document.querySelector(".task-queue-paused-banner")?.textContent ?? "",
	}));
async function shot(page, name, selector = ".panel-right") {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await page
		.locator(selector)
		.first()
		.screenshot({ path: join(SHOTS, name) });
}

let W = null;
try {
	W = await connect("qp-a");
	await W.open(files.A);

	// ---- Queue A: the three tasks start ------------------------------------------------------------------
	await W.prompt("/queue start");
	const started = await waitFor(
		() =>
			seen.a1Asked &&
			statusIn(files.A, 2) === "blocked" &&
			statusIn(files.A, 3) === "waiting" &&
			[1, 2, 3].every((id) => chatOf(files.A, id)),
		45_000,
	);
	must(
		"queue A: #1 works (it asked temper), #2 is blocked, #3 is on hold, each in a chat of its own",
		!!started,
		JSON.stringify({ status: [1, 2, 3].map((id) => statusIn(files.A, id)), asked: !!seen.a1Asked }),
	);
	const chat1 = chatOf(files.A, 1);
	const chat2 = chatOf(files.A, 2);
	const chat3 = chatOf(files.A, 3);
	const blockedAt = opsIn(files.A).find((op) => op.op === "block" && op.id === 2)?.ts ?? Date.now();
	const waitOp = opsIn(files.A).find((op) => op.op === "wait" && op.id === 3);
	const waitSince = waitOp?.ts ?? Date.now();
	const until0 = await waitFor(() => tasksIn(W).find((t) => t.id === 3)?.wait?.until, 10_000);
	must(
		"the Queue panel knows #3's give-up time",
		typeof until0 === "number",
		JSON.stringify(tasksIn(W).find((t) => t.id === 3)),
	);

	// ---- #2 and #3 paused by the main chat's queue_control (the owner's words, relayed) -------------------
	await W.prompt("PAUSE-2-3");
	const paused23 = await waitFor(() => holdOp(files.A, 2) && holdOp(files.A, 3), 15_000);
	const r23 = seen.mainResults.get("PAUSE-2-3") ?? [];
	must(
		"queue_control pause (id 2, then id 3, with the owner's words) pauses both tasks",
		!!paused23 &&
			/^Task #2 \(Need a login\) is paused by the owner: no pokes, asks, checks, give-ups or starts/.test(
				r23[0] ?? "",
			) &&
			/^Task #3 \(Wait for flag\) is paused by the owner/.test(r23[1] ?? ""),
		JSON.stringify({ ops: opsIn(files.A).map((o) => o.op), r: r23.map((r) => r.slice(0, 70)) }),
	);
	const pausedAt = holdOp(files.A, 3).ts;
	check(
		"#2 was paused before its first poke was due",
		holdOp(files.A, 2).ts < blockedAt + POKES_MS[0] && seen.pokes2.length === 0,
		JSON.stringify({ after: holdOp(files.A, 2).ts - blockedAt, pokes: seen.pokes2.length }),
	);
	check(
		"the pause keeps the owner's words and where they came from",
		holdOp(files.A, 2).why === RELAYED_WHY && holdOp(files.A, 2).by === "tool",
		JSON.stringify(holdOp(files.A, 2)),
	);
	check(
		"the pause reached #3's own chat (its checks stop there)",
		!!(await waitFor(() => opsIn(chat3).some((op) => op.op === "hold" && op.id === 3), 10_000)),
	);
	await sleep(3000);
	const checksPaused = checkCount();

	// ---- the Queue tab ----------------------------------------------------------------------------------------
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const pageA = await openQueue("qp-browser-a", files.A);
	const rowsA = await waitFor(async () => {
		const r2 = await rowOf(pageA, 2);
		const r1 = await rowOf(pageA, 1);
		return r2?.paused === "task" && r1?.button === "Pause" ? { r1, r2, r3: await rowOf(pageA, 3) } : null;
	}, 20_000);
	check(
		"Queue tab: #2 and #3 say Paused by you (since when, the owner's words) with Resume; #1 has Pause",
		!!rowsA &&
			/paused/.test(rowsA.r2.cls) &&
			/^Paused by you/.test(rowsA.r2.line) &&
			rowsA.r2.line.includes("owner on Telegram, relayed by COO") &&
			rowsA.r2.button === "Resume" &&
			rowsA.r3?.paused === "task" &&
			rowsA.r3.button === "Resume",
		JSON.stringify(rowsA),
	);
	check("Queue tab: the header offers Pause queue", (await headerOf(pageA)).button === "Pause queue");

	// ---- #1 paused from the Queue tab while its turn still runs ---------------------------------------------
	await pageA.click('button.task-queue-pause[data-pause-task="1"]');
	const held1 = await waitFor(
		() => holdOp(files.A, 1) && opsIn(chat1).some((op) => op.op === "hold" && op.id === 1),
		15_000,
	);
	must(
		"Pause (a click) pauses #1, with the panel's words, and its chat records it",
		!!held1 && holdOp(files.A, 1).why === "pressed Pause in the Queue panel" && holdOp(files.A, 1).by === "panel",
		JSON.stringify(holdOp(files.A, 1)),
	);
	go.add("A1");
	const stopped1 = await waitFor(
		() =>
			seen.stopped.has("Long work") &&
			lastMessage(chat1)?.role === "assistant" &&
			/stopped after step one/.test(lastMessage(chat1).text),
		30_000,
	);
	check(
		"#1 wasn't aborted: it finished its step, got one note to stop at a safe point, and stopped",
		!!stopped1 && holdNotes(chat1) === 1 && statusIn(files.A, 1) === "working",
		JSON.stringify({ notes: holdNotes(chat1), status: statusIn(files.A, 1), last: lastMessage(chat1)?.role }),
	);
	const row1 = await waitFor(async () => {
		const r = await rowOf(pageA, 1);
		return r?.paused === "task" && r.button === "Resume" ? r : null;
	}, 10_000);
	check("Queue tab: #1 now says Paused by you, with Resume", !!row1, JSON.stringify(await rowOf(pageA, 1)));
	await shot(pageA, "queue-paused-tasks.png");
	await sleep(1000);
	const calls1 = seen.calls.get("Long work") ?? 0;

	// temper's answer reaches #1's chat without a turn.
	go.add("reply");
	const replied = await waitFor(() => customTexts(chat1, "role-message").some((t) => t.includes("R-A1")), 30_000);
	check(
		"temper's reply goes into the paused task's chat without starting a turn",
		!!replied && (seen.calls.get("Long work") ?? 0) === calls1,
		JSON.stringify({ replied: !!replied, calls: (seen.calls.get("Long work") ?? 0) - calls1 }),
	);

	// A scheduled wake-up bound to #1's chat goes in without a turn too.
	W.send({
		type: "schedule_save",
		task: {
			id: "qp-wake",
			name: "QP wake",
			kind: "cron",
			spec: "0 0 1 1 *",
			prompt: "S-A1: check the long work's build",
			cwd: workdir,
			enabled: false,
			catchUp: "skip",
			sessionFile: chat1,
		},
	});
	await waitFor(
		() => W.received.some((m) => m.type === "scheduler_tasks" && (m.tasks ?? []).some((t) => t.id === "qp-wake")),
		15_000,
	);
	W.send({ type: "schedule_run", id: "qp-wake" });
	const woke = await waitFor(() => customTexts(chat1, "queue-paused").some((t) => t.includes("S-A1")), 30_000);
	check(
		"a scheduled wake-up for the paused task's chat goes in without a turn (kept for after the pause)",
		!!woke &&
			/This came while the owner had this task paused/.test(customTexts(chat1, "queue-paused").join("\n")) &&
			(seen.calls.get("Long work") ?? 0) === calls1,
		JSON.stringify({ woke: !!woke, calls: (seen.calls.get("Long work") ?? 0) - calls1 }),
	);

	// The watchdog leaves it alone (its chat has been stopped for longer than the 3 s it allows).
	await sleep(6000);
	check(
		"nothing started a turn in #1's chat while paused: no reminder, no watchdog note, no reply or wake-up turn",
		(seen.calls.get("Long work") ?? 0) === calls1 &&
			!userTexts(chat1).some((t) => STALL_RE.test(t)) &&
			/stopped after step one/.test(lastMessage(chat1)?.text ?? "") &&
			statusIn(files.A, 1) === "working",
		JSON.stringify({ calls: (seen.calls.get("Long work") ?? 0) - calls1, status: statusIn(files.A, 1) }),
	);

	// ---- #2 and #3 stay quiet past their poke schedule and give-up time --------------------------------------
	const quietUntil = Math.max(blockedAt + POKES_MS[2] + 4000, waitSince + GIVE_UP_MS + 4000);
	if (Date.now() < quietUntil) await sleep(quietUntil - Date.now());
	check(
		"paused blocked #2: no poke and no ask over its whole poke schedule",
		seen.pokes2.length === 0 &&
			!seen.cards.some((c) => /^\[Queue\] Task #2 asks/.test(c.text)) &&
			statusIn(files.A, 2) === "blocked",
		JSON.stringify({ pokes: seen.pokes2.length, cards: seen.cards.length, status: statusIn(files.A, 2) }),
	);
	check(
		"paused waiting #3: no checks and no give-up past its give-up time",
		checkCount() === checksPaused &&
			statusIn(files.A, 3) === "waiting" &&
			statusIn(chat3, 3) === "waiting" &&
			seen.notes3.length === 0 &&
			Date.now() > until0,
		JSON.stringify({ checks: checkCount() - checksPaused, status: statusIn(files.A, 3), own: statusIn(chat3, 3) }),
	);
	check(
		"no paused task counts as needs-you (the main chat was asked nothing)",
		seen.cards.length === 0,
		JSON.stringify(seen.cards.map((c) => c.text.slice(0, 40))),
	);

	// ---- resume #2 and #3 (the main chat's queue_control) ------------------------------------------------------
	await W.prompt("RESUME-2-3");
	const resumed = await waitFor(() => releaseOp(files.A, 2) && releaseOp(files.A, 3), 15_000);
	const rr = seen.mainResults.get("RESUME-2-3") ?? [];
	must(
		"queue_control resume lifts both pauses",
		!!resumed &&
			/^Task #2 \(Need a login\) carries on where it stopped\./.test(rr[0] ?? "") &&
			/^Task #3 \(Wait for flag\) carries on where it stopped\./.test(rr[1] ?? ""),
		JSON.stringify(rr.map((r) => r.slice(0, 70))),
	);
	const resumedAt = releaseOp(files.A, 3).ts;
	const shift = resumedAt - Math.max(pausedAt, waitSince);
	const until1 = await waitFor(() => {
		const u = tasksIn(W).find((t) => t.id === 3)?.wait?.until;
		return typeof u === "number" && u !== until0 ? u : null;
	}, 10_000);
	check(
		"#3's give-up time moved later by exactly the time it was paused",
		until1 === until0 + shift,
		JSON.stringify({ moved: (until1 ?? until0) - until0, paused: shift }),
	);
	const checksAgain = await waitFor(() => checkCount() > checksPaused, 10_000);
	check("#3's checks go on after the resume", !!checksAgain);
	writeFileSync(files.flag, "ready\n");
	const done3 = await waitFor(() => statusIn(files.A, 3) === "done", 30_000);
	check(
		"#3 carried on: its check passed, it was woken and finished (no back-from-pause note: it wasn't working)",
		!!done3 && seen.notes3.length === 1 && /^\[Queue\] Back to task #3: Wait for flag/.test(seen.notes3[0].text),
		JSON.stringify({ status: statusIn(files.A, 3), notes: seen.notes3.length }),
	);
	const poked2 = await waitFor(() => seen.pokes2.length > 0, 30_000);
	const resumed2 = releaseOp(files.A, 2).ts;
	const firstPoke = seen.pokes2[0]?.at ?? 0;
	check(
		"#2's pokes count from the resume: the first one came about 8 s after it",
		!!poked2 &&
			/poke 1 of 3/.test(seen.pokes2[0].text) &&
			firstPoke - resumed2 >= POKES_MS[0] - 1000 &&
			firstPoke - resumed2 < POKES_MS[0] + 8000,
		JSON.stringify({ after: firstPoke - resumed2 }),
	);
	check("#2 carried on and finished", !!(await waitFor(() => statusIn(files.A, 2) === "done", 20_000)));

	// ---- resume #1 (a click) ------------------------------------------------------------------------------------
	await pageA.click('button.task-queue-pause[data-pause-task="1"]');
	const back1 = await waitFor(() => seen.a1Back, 30_000);
	check(
		"Resume (a click): #1's chat gets one 'Back to task #1: the owner lifted the pause (paused HH:MM–HH:MM)' turn",
		!!back1 && userTexts(chat1).filter((t) => BACK_RE(1).test(t)).length === 1,
		JSON.stringify({ back: !!back1, notes: userTexts(chat1).filter((t) => BACK_RE(1).test(t)).length }),
	);
	check(
		"that turn reads what came while paused: temper's reply and the scheduled wake-up",
		!!back1?.sawReply && !!back1?.sawWake,
		JSON.stringify(back1),
	);
	check(
		"#1 carried on and finished; it got exactly one hold note in all",
		!!(await waitFor(() => statusIn(files.A, 1) === "done", 20_000)) && holdNotes(chat1) === 1,
		JSON.stringify({ status: statusIn(files.A, 1), notes: holdNotes(chat1) }),
	);
	check(
		"the role message and the wake-up each started no turn of their own (only the hold note and the back note did)",
		(seen.calls.get("Long work") ?? 0) - calls1 === 2,
		String((seen.calls.get("Long work") ?? 0) - calls1),
	);
	await pageA.context().close();

	// ---- Queue C: Auto start on, its paused #1 skipped ------------------------------------------------------------
	await W.open(files.C);
	const c2Started = await waitFor(() => seen.started.has("C two"), 45_000);
	must(
		"queue C (Auto start on, one lane): its paused #1 is skipped and #2 starts",
		!!c2Started && !seen.started.has("C one") && statusIn(files.C, 1) === "ready",
		JSON.stringify({ started: [...seen.started.keys()], status: [1, 2, 3].map((id) => statusIn(files.C, id)) }),
	);
	const chatC2 = chatOf(files.C, 2);
	const pageC = await openQueue("qp-browser-c", files.C);
	const rowC1 = await waitFor(async () => {
		const r = await rowOf(pageC, 1);
		return r?.paused === "task" && r.button === "Resume" ? r : null;
	}, 20_000);
	check("Queue tab: C#1 says Paused by you, with Resume", !!rowC1, JSON.stringify(await rowOf(pageC, 1)));
	await pageC.click("button.task-queue-pause-queue");
	const heldC = await waitFor(
		() =>
			opsIn(files.C).some((op) => op.op === "hold" && op.id === undefined) &&
			opsIn(chatC2).some((op) => op.op === "hold"),
		15_000,
	);
	must("Pause queue (a click) pauses the whole queue, and #2's chat records it", !!heldC);
	go.add("C2");
	const stoppedC2 = await waitFor(
		() =>
			seen.stopped.has("C two") &&
			lastMessage(chatC2)?.role === "assistant" &&
			/stopped after step one/.test(lastMessage(chatC2).text),
		30_000,
	);
	check(
		"C#2 (working) finished its step, got one note and stopped",
		!!stoppedC2 && holdNotes(chatC2) === 1 && statusIn(files.C, 2) === "working",
		JSON.stringify({ notes: holdNotes(chatC2), status: statusIn(files.C, 2) }),
	);
	const bannerC = await waitFor(async () => {
		const h = await headerOf(pageC);
		const r3 = await rowOf(pageC, 3);
		const r1 = await rowOf(pageC, 1);
		return h.button === "Resume queue" &&
			/Paused by you/.test(h.banner) &&
			r3?.paused === "queue" &&
			r1?.paused === "task"
			? { h, r3, r1 }
			: null;
	}, 15_000);
	check(
		"Queue tab: a banner 'Paused by you', Resume queue; #3 paused with the whole queue, #1 on its own",
		!!bannerC && /with the whole queue/.test(bannerC.r3.line) && bannerC.r3.button === "Pause",
		JSON.stringify({ h: await headerOf(pageC), r3: await rowOf(pageC, 3) }),
	);
	await shot(pageC, "queue-paused-queue.png");

	// The Roles page says so.
	const ctxR = await browser.newContext({ viewport: { width: 1400, height: 900 } });
	await ctxR.addInitScript(() => localStorage.setItem("pi-web-ui:lang", "en"));
	const pageR = await ctxR.newPage();
	pageR.on("pageerror", (e) => pageErrors.push(`roles: ${e}`));
	await pageR.goto(`${srv.http}/?view=roles`);
	// The page first gets the last snapshot the server has (it may be from while C#2 was still finishing its
	// step, so "busy"); the next look, moments later, has it settled.
	const tileNow = () =>
		pageR.evaluate(() => {
			const el = document.querySelector('.roles-view .rv-tile[data-role-id="design"]');
			return el ? { cls: el.className, text: (el.textContent ?? "").replace(/\s+/g, " ").slice(0, 300) } : null;
		});
	const tile = await waitFor(async () => {
		const t = await tileNow();
		return t && /Queue paused by you/.test(t.text) && /\bpaused\b/.test(t.cls) ? t : null;
	}, 40_000);
	check(
		"Roles page: design's tile says 'Queue paused by you' and isn't waiting on the owner",
		!!tile && !/needs-you/.test(tile.cls),
		JSON.stringify(tile ?? (await tileNow())),
	);
	await shot(pageR, "roles-paused.png", ".roles-view");
	await ctxR.close();

	await sleep(4000);
	check(
		"while the queue is paused nothing starts (Auto start is on and the lane is free)",
		!seen.started.has("C three") && !seen.started.has("C one"),
		JSON.stringify([...seen.started.keys()]),
	);

	// Resume queue: #2 first, then #3; #1 stays paused on its own.
	await pageC.click("button.task-queue-pause-queue");
	const doneC2 = await waitFor(() => statusIn(files.C, 2) === "done", 30_000);
	check(
		"Resume queue: C#2 gets its back note first and finishes",
		!!doneC2 && seen.c2Back === 1 && userTexts(chatC2).filter((t) => BACK_RE(2).test(t)).length === 1,
		JSON.stringify({ status: statusIn(files.C, 2), back: seen.c2Back }),
	);
	const doneC3 = await waitFor(() => statusIn(files.C, 3) === "done", 30_000);
	check("then C#3 runs and finishes", !!doneC3, statusIn(files.C, 3));
	await sleep(3000);
	const stillC1 = await rowOf(pageC, 1);
	check(
		"C#1's own pause outlived the queue's: still paused, not started",
		!seen.started.has("C one") &&
			statusIn(files.C, 1) === "ready" &&
			stillC1?.paused === "task" &&
			stillC1.button === "Resume",
		JSON.stringify({ started: seen.started.has("C one"), row: stillC1 }),
	);
	await pageC.click('button.task-queue-pause[data-pause-task="1"]');
	const doneC1 = await waitFor(() => statusIn(files.C, 1) === "done", 30_000);
	check("its own Resume (a click): C#1 starts and finishes", !!doneC1, statusIn(files.C, 1));
	const order = ["C two", "C three", "C one"].map((t) => seen.started.get(t) ?? 0);
	check(
		"queue C started #2, then #3, then #1",
		order.every((t, i) => t > 0 && (i === 0 || t > order[i - 1])),
	);
	await pageC.context().close();

	check("nothing the script didn't expect", unexpected.length === 0, unexpected.join("; "));
	check("no page errors", pageErrors.length === 0, pageErrors.join("; "));
} catch (err) {
	failures++;
	console.log(`✗ FAIL: ${err?.message ?? err}`);
} finally {
	W?.close();
	await browser?.close().catch(() => {});
	await srv.stop();
}
console.log(failures ? `✗ queue-paused: ${failures} failed` : "✓ queue-paused: all passed");
process.exit(failures ? 1 : 0);
