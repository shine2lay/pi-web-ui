/* queue-blocked E2E (no tokens): blocked tasks wait on tasks in any queue, and are poked the moment
 * those are over.
 *
 * A sealed test server with the real pi-queue (PI_QUEUE_PKG, default ~/projects/pi-queue) and the real
 * pi-identity (PI_IDENTITY_PKG, default ~/projects/pi-identity), the mock model and plain WebSocket
 * clients. Two roles: "tooling" (home chat A, a queue, its chats limited to an allow list: queue_blocked
 * comes from pi-identity.json's alwaysAllow) and "temper" (home chat B, a queue). Test clocks: the
 * server's check every 2 s (PI_WEB_QUEUE_BLOCKS_MS), need pokes at 20, 30 and 40 s (pi-queue's
 * PI_QUEUE_TEST_BLOCK_POKES_MS); the unit tests check the real minute and 10/30/60 min on fake clocks.
 * Queue B's tasks start and are worked on (each turn held until the test lets it act). Queue A's tasks,
 * each in a chat of its own (a role chat with an allow list), call queue_blocked:
 *   A#1 on "temper #1": no poke while it's worked on; all chats closed and the server restarted, then
 *       temper #1 finishes: A#1's chat is poked with its summary within 2 min and finishes.
 *   A#6 is planned in A's chat with after "temper #2": it stays in Up next and starts by itself once
 *       temper #2 is done (also after the restart, with every chat closed).
 *   A#3 on "temper #3": temper #3 is removed: A#3 is poked at once with that news.
 *   A#4 on "temper #4": temper #4 needs the user: shown on A#4's line, no poke.
 *   A#5 needs "the staging login" (a need only): poked at 20, 30, 40 s (it re-blocks each time), then it
 *       asks its main chat (#61's path).
 * The Queue tab shows Blocked lines (a real browser, the dark and the white theme; screenshots with
 * QB_SHOT_DIR). Also reported, not checked (task #63 step 7): whether On hold waits are still checked
 * after a restart while their queue chat and task chat are idle: queue C (one On hold task, nothing
 * else) and temper #5 (its queue has other tasks still running).
 * The mock's script checks what the chats get; nothing the model is sent is printed.
 *
 * Usage: npm run build && scripts/sealed.sh node tests/queue-blocked-test.mjs
 *        PI_QUEUE_PKG / PI_IDENTITY_PKG pick the checkouts. QB_DEBUG=1: server log.
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
const POKES_MS = [20000, 30000, 40000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`  ${ok ? "✓" : "✗ FAIL:"} ${name}${extra && !ok ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
	return ok;
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

// ---- seeded chats ---------------------------------------------------------------------------------
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
const B_TASKS = ["Team runner", "Write docs", "Spike", "Port pick", "Wait for file"];
/** Queue B tasks the test has let act (finish, or ask); the others stay worked on. */
const go = new Set();
const A_TASKS = { 1: "Wait on runner", 3: "Wait on spike", 4: "Wait on port", 5: "Need a login" };

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
	writeFileSync(join(agentDir, "pi-queue.json"), JSON.stringify({ stalledAfterMinutes: 0 }));
	// The owner's alwaysAllow plus queue_blocked: the line task #63 hands the owner.
	writeFileSync(
		join(agentDir, "pi-identity.json"),
		JSON.stringify({ alwaysAllow: ["notebook", "tldr", "queue_done", "queue_stuck", "queue_wait", "queue_blocked"] }),
	);
	const dir = join(agentDir, "sessions", `--${wd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(dir, { recursive: true });
	files.A = join(dir, "2026-10-01T10-01-00-000Z_01a0f000-0000-7000-8000-0000000000a1.jsonl");
	files.B = join(dir, "2026-10-01T10-02-00-000Z_01a0f000-0000-7000-8000-0000000000b2.jsonl");
	files.flag = join(wd, "ready.flag");
	// Queue C: one On hold task and nothing else, so after the restart its queue chat is truly idle.
	files.C = join(dir, "2026-10-01T10-03-00-000Z_01a0f000-0000-7000-8000-0000000000c3.jsonl");
	files.flagC = join(wd, "ready-c.flag");
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
			parentId = base.id;
		}
		writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	};
	write(files.B, [
		{ identity: "temper" },
		{ name: "temper" },
		...B_TASKS.map((title, i) => ({ queue: { op: "add", id: i + 1, plan: plan(title), touches: [`b${i + 1} repo`] } })),
		{ queue: { op: "lanes", n: 6 } },
		{ queue: { op: "run" } },
	]);
	write(files.C, [
		{ name: "idle queue" },
		{ queue: { op: "add", id: 1, plan: plan("Idle wait"), touches: ["c1 repo"] } },
		{ queue: { op: "run" } },
	]);
	write(files.A, [
		{ identity: "tooling" },
		{ name: "tooling" },
		...Object.entries(A_TASKS).map(([id, title]) => ({
			queue: { op: "add", id: Number(id), plan: plan(title), touches: [`a${id} repo`] },
		})),
		{ queue: { op: "lanes", n: 6 } },
	]);
	idDir = join(root, "identities");
	const role = (id, json) => {
		mkdirSync(join(idDir, id), { recursive: true });
		writeFileSync(join(idDir, id, "identity.json"), JSON.stringify({ id, ...json }, null, "\t"));
		writeFileSync(join(idDir, id, "about.md"), `# ${json.title}\n`);
		writeFileSync(join(idDir, id, "notebook.md"), "");
	};
	role("tooling", {
		title: "Tooling",
		homeChat: files.A,
		tools: { allow: ["read", "queue_add", "queue_control", "queue_reply"] },
	});
	role("temper", { title: "Temper", homeChat: files.B });
}

// ---- the mock model --------------------------------------------------------------------------------
/** What the chats got (kept here, never printed). */
const seen = {
	offered: new Map(), // task title -> queue_blocked offered (booleans)
	blockResults: new Map(), // task title -> the tool's answer
	notes: new Map(), // task title -> [{ at, text }]
	cards: [], // [{ at, text }] in queue chats
	started: new Map(), // task title -> first kickoff
	waitWoke: 0,
	idleWoke: 0, // queue C's On hold task woken (step 7)
	afterPlanned: "",
};
const unexpected = [];
const noteOf = (title) => {
	if (!seen.notes.has(title)) seen.notes.set(title, []);
	return seen.notes.get(title);
};

async function modelReply({ payload, sideRequest }) {
	if (sideRequest) return "Blocked test";
	const history = Array.isArray(payload.messages) ? payload.messages : [];
	const users = [];
	history.forEach((m, i) => {
		if (m.role === "user" && !/^\(System reminder/.test(textOf(m))) users.push(i);
	});
	const first = users[0] ?? -1;
	const kick = first >= 0 ? textOf(history[first]).match(/^\[Queue\] Task #(\d+): (.+)/) : null;
	const isNote = (i) => !kick && /^\[Queue\] Task #\d+ \(/.test(textOf(history[i]));
	const anchors = users.filter((i) => !isNote(i));
	const last = anchors.at(-1) ?? -1;
	const userText = last >= 0 ? textOf(history[last]) : "";
	const results = history
		.slice(last + 1)
		.filter((m) => m.role === "tool")
		.map(textOf);
	const step = results.length;
	const tools = (payload.tools ?? []).map((t) => t.function?.name ?? t.name);
	if (!kick) {
		// A queue's chat.
		if (userText.startsWith("PLAN-AFTER")) {
			if (step === 0)
				return { tool: "queue_add", args: { ...planArgs("After docs"), touches: ["a2 repo"], after: ["temper #2"] } };
			seen.afterPlanned = results[0] ?? "";
			return "MC-PLANNED";
		}
		if (userText.startsWith("REMOVE-3")) {
			if (step === 0) return { tool: "queue_control", args: { action: "remove", id: 3 } };
			return "MC-REMOVED";
		}
		if (/^\[Queue\] Task #\d+ asks\b/.test(userText)) {
			if (step === 0) seen.cards.push({ at: Date.now(), text: userText });
			return "MC-NOT-SURE"; // ends the turn without queue_reply: it goes to the user
		}
		return "MC-OTHER ok.";
	}
	const title = kick[2].trim();
	if (last === first && step === 0) {
		if (!seen.started.has(title)) seen.started.set(title, Date.now());
		seen.offered.set(title, tools.includes("queue_blocked"));
	}
	if (B_TASKS.includes(title) && title !== "Wait for file") {
		// Queue B's tasks are worked on: each turn runs (held here) until the test lets it act; a turn cut
		// off by the restart carries on by itself and is held again.
		if (step > 0) return `B-${title}-OVER`;
		const t0 = Date.now();
		while (!go.has(title) && Date.now() - t0 < 480_000) await sleep(200);
		if (!go.has(title)) return "B-GAVE-UP";
		if (title === "Port pick")
			return { tool: "queue_stuck", args: { question: "Which port should it use?", choices: ["8080", "9090"] } };
		if (title === "Spike") return "B-SPIKE";
		return { tool: "queue_done", args: { summary: `${title} landed` } };
	}
	if (title === "Wait for file" || title === "Idle wait") {
		const idle = title === "Idle wait";
		if (last === first) {
			const flag = idle ? files.flagC : files.flag;
			if (step === 0)
				return { tool: "queue_wait", args: { what: "a flag file", check: `test -f ${flag}`, every_minutes: 0.05 } };
			return "B-WAITING";
		}
		if (step === 0 && userText.startsWith("[Queue]")) {
			if (idle) seen.idleWoke ||= Date.now();
			else seen.waitWoke ||= Date.now();
			return { tool: "queue_done", args: { summary: "The flag file is there" } };
		}
		return "B-DONE";
	}
	if (last === first) {
		// An A task's kickoff turn.
		const on = { "Wait on runner": ["temper #1"], "Wait on spike": ["temper #3"], "Wait on port": ["temper #4"] }[
			title
		];
		if (on || title === "Need a login") {
			if (step === 0) return { tool: "queue_blocked", args: on ? { on } : { need: "the staging login" } };
			seen.blockResults.set(title, results[0] ?? "");
			return "A-BLOCKED";
		}
		if (title === "After docs") {
			if (step === 0) return { tool: "queue_done", args: { summary: "After docs is done" } };
			return "A-DONE";
		}
	} else if (title === "Need a login") {
		if (step === 0) {
			noteOf(title).push({ at: Date.now(), text: userText });
			if (/poke \d of 3/.test(userText)) return { tool: "queue_blocked", args: { need: "the staging login" } };
			return "A-OTHER";
		}
		seen.blockResults.set(`${title} again ${noteOf(title).length}`, results[0] ?? "");
		return "A-STILL";
	} else if (Object.values(A_TASKS).includes(title)) {
		if (step === 0) {
			noteOf(title).push({ at: Date.now(), text: userText });
			if (/what it was blocked on changed/.test(userText))
				return { tool: "queue_done", args: { summary: `${title}: went on` } };
			return "A-OTHER";
		}
		return "A-DONE";
	}
	unexpected.push(`${title}: a message`);
	return "OTHER ok.";
}
/** Which of pi-queue's refusals an answer is (a category only: tool results are never printed). */
function whyNot(text) {
	const kinds = {
		noHost: /can only be named in pi-web-ui/,
		unknownName: /isn't a role or a queue chat's title/,
		noHome: /has no home chat/,
		unreadable: /can't be read/,
		missing: /doesn't exist/,
		loop: /makes a loop/,
		lookup: /couldn't look the tasks up/,
		declined: /declin|not approved|didn't approve/i,
		notAdded: /^Not added/,
		added: /^(Added|Task #\d+ added|Queued)/,
	};
	return Object.entries(kinds).find(([, re]) => re.test(text ?? ""))?.[0] ?? "other";
}
function planArgs(title) {
	const p = plan(title);
	return {
		title,
		goal: p.goal,
		done_when: p.doneWhen,
		decided: p.decided,
		steps: p.steps,
		verify: p.verify,
		must_not: p.mustNot,
	};
}

// ---- a window, as a WebSocket client -----------------------------------------------------------------
class Client {
	constructor(ws, name) {
		this.ws = ws;
		this.name = name;
		this.received = [];
		this.state = null;
		this.approved = new Set();
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			if (message.type === "snapshot") this.state = message.state;
			else if (message.type === "snapshot_delta") {
				if (this.state && this.state.rev === message.baseRev && message.conversationId === this.state.conversationId)
					this.state = { ...this.state, ...message.state };
				else this.send({ type: "get_state" });
			}
			// The owner says yes to the plan and the removal.
			const dialog = this.state?.dialog;
			if (dialog?.kind === "confirm" && !this.approved.has(dialog.id)) {
				this.approved.add(dialog.id);
				this.send({ type: "dialog_response", id: dialog.id, value: true });
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
	name: "queue-blocked",
	mock: modelReply,
	prepare: seed,
	verbose: !!process.env.QB_DEBUG,
	env: {
		PI_WEB_TOKEN: "",
		PI_QUEUE_TEST_FAST: "1",
		PI_QUEUE_TEST_BLOCK_POKES_MS: POKES_MS.join(","),
		PI_WEB_QUEUE_BLOCKS_MS: "2000",
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

/** A queue's tasks as its transcript says, through the server's own reading (a window on that chat). */
const tasksIn = (c) => c.state?.taskQueue?.tasks ?? [];

/** The queue ops in a transcript (read only). */
function opsIn(file) {
	try {
		return readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
			.filter((e) => e.type === "custom" && e.customType === "queue")
			.map((e) => e.data);
	} catch {
		return [];
	}
}
/** A task's status from its queue's ops, the way the queue counts the ones this test cares about. */
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

// ---- a real browser, for the Queue tab --------------------------------------------------------------
let browser = null;
const pageErrors = [];
const SHOTS = process.env.QB_SHOT_DIR;
async function openPage(clientId, file, theme = "") {
	const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
	await ctx.addInitScript(
		([id, t]) => {
			localStorage.setItem("pi-web-client-id", id);
			localStorage.setItem("pi-web-ui:lang", "en");
			if (t) localStorage.setItem("pi-web-ui:theme", t);
		},
		[clientId, theme],
	);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => pageErrors.push(`${clientId}: ${e}`));
	await page.goto(`${srv.http}/?chat=${encodeURIComponent(file)}`);
	await page.waitForSelector(".topbar", { timeout: 60_000 });
	await page.locator(".panel-right .slot-tab", { hasText: "Queue" }).first().click();
	await page.locator(".task-queue-panel, .panel-right .task-queue").first().waitFor({ timeout: 10_000 });
	return page;
}
/** The Queue tab's blocked lines: task id, text, badge colour, and the refs' labels and states. */
const blockedLines = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll("li.task-queue-task")].flatMap((li) => {
			const b = li.querySelector(".task-queue-blocked");
			if (!b) return [];
			const badge = b.querySelector(".task-queue-blocked-badge");
			return [
				{
					id: Number(li.dataset.taskId),
					cls: li.className,
					text: b.textContent ?? "",
					badge: badge ? getComputedStyle(badge).color : "",
					refs: [...b.querySelectorAll(".task-queue-ref")].map((r) => ({
						ref: r.dataset.ref,
						cls: r.className,
						link: !!r.querySelector("a,.task-queue-ref-link"),
					})),
				},
			];
		}),
	);
const themeColours = (page) =>
	page.evaluate(() => {
		const probe = document.createElement("span");
		document.body.append(probe);
		const of = (name) => {
			probe.style.color = `var(${name})`;
			return getComputedStyle(probe).color;
		};
		const out = { cyan: of("--term-cyan"), amber: of("--amber"), blue: of("--blue") };
		probe.remove();
		return out;
	});
async function shot(page, name) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await page
		.locator(".panel-right")
		.first()
		.screenshot({ path: join(SHOTS, name) });
}
async function lookAtPanel(theme, name) {
	const page = await openPage(`qb-browser-${theme || "dark"}`, files.A, theme);
	if (theme === "white") {
		check(
			"the white theme is on",
			await waitFor(
				() =>
					page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() === "#ffffff"),
				10_000,
			),
		);
	}
	let lines = [];
	const ok = await waitFor(async () => {
		lines = await blockedLines(page);
		const l4 = lines.find((l) => l.id === 4);
		const l5 = lines.find((l) => l.id === 5);
		const l1 = lines.find((l) => l.id === 1);
		return (
			l1?.refs[0]?.ref === "temper #1" &&
			l1.refs[0].link &&
			l4?.refs[0]?.cls.includes("needs-you") &&
			/staging login/.test(l5?.text ?? "")
		);
	}, 20_000);
	const c = await themeColours(page);
	const l1 = lines.find((l) => l.id === 1);
	check(
		`${theme || "dark"}: the Queue tab shows Blocked lines: on temper #1 (a link to its chat), temper #4 needing you, the need`,
		!!ok && /^Blocked/.test(l1?.text ?? "") && /working/.test(l1?.text ?? ""),
		JSON.stringify(lines),
	);
	check(
		`${theme || "dark"}: the Blocked label has its own colour (cyan, not amber or blue)`,
		l1?.badge === c.cyan && c.cyan !== c.amber && c.cyan !== c.blue,
		JSON.stringify({ c, badge: l1?.badge }),
	);
	const after = await page.evaluate(() =>
		[...document.querySelectorAll(".task-queue-after")].map((e) => e.textContent),
	);
	check(
		`${theme || "dark"}: A#6 shows "after temper #2"`,
		after.some((t) => /temper #2/.test(t ?? "")),
		JSON.stringify(after),
	);
	await shot(page, name);
	await page.context().close();
}

let W = null;
let V = null;
const report = [];
try {
	// Queue B starts its tasks; they wait.
	W = await connect("qb-a");
	await W.open(files.B);
	await W.prompt("/queue start");
	const bStarted = await waitFor(
		() => B_TASKS.every((t) => seen.started.has(t)) && [1, 2, 3, 4].every((id) => chatOf(files.B, id)),
		60_000,
	);
	check(
		"queue B's tasks run in chats of their own",
		!!bStarted,
		JSON.stringify({
			status: [1, 2, 3, 4, 5].map((id) => statusIn(files.B, id)),
			started: [...seen.started.keys()],
			ops: opsIn(files.B).map((o) => o.op),
		}),
	);
	const bChat = (id) => chatOf(files.B, id);

	// Queue C (step 7): its one task goes On hold.
	await W.open(files.C);
	await W.prompt("/queue start");
	const cWaiting = await waitFor(() => statusIn(files.C, 1) === "waiting", 60_000);
	if (!cWaiting)
		report.push(`Queue C's task never went On hold (status ${statusIn(files.C, 1)}); step 7's idle case wasn't tried.`);

	// Queue A: its tasks start and block.
	await W.open(files.A);
	await W.prompt("PLAN-AFTER");
	await waitFor(() => tasksIn(W).some((t) => t.id === 2 || t.plan?.title === "After docs"), 20_000);
	const a2 = () => tasksIn(W).find((t) => t.plan?.title === "After docs");
	check(
		'queue_add takes after "temper #2" (another queue\'s task)',
		a2()?.outside?.[0]?.name === "temper" && a2()?.outside?.[0]?.id === 2,
		JSON.stringify(a2()?.outside),
	);
	check(
		"the plan's answer says it starts once temper #2 is done",
		/temper #2/.test(seen.afterPlanned),
		JSON.stringify({
			answered: !!seen.afterPlanned,
			why: whyNot(seen.afterPlanned),
			aOps: opsIn(files.A).map((o) => o.op),
		}),
	);
	await W.prompt("/queue start");
	const allBlocked = await waitFor(() => [1, 3, 4, 5].every((id) => statusIn(files.A, id) === "blocked"), 60_000);
	check(
		"A#1, #3, #4 and #5 are blocked",
		!!allBlocked,
		JSON.stringify([1, 2, 3, 4, 5].map((id) => statusIn(files.A, id))),
	);
	check(
		"a role chat with an allow list is offered queue_blocked (pi-identity.json alwaysAllow) and can call it",
		Object.values(A_TASKS).every((t) => seen.offered.get(t) === true) &&
			/^Task #1 is blocked \(on temper #1\)/.test(seen.blockResults.get("Wait on runner") ?? ""),
		JSON.stringify({ offered: [...seen.offered], r: (seen.blockResults.get("Wait on runner") ?? "").slice(0, 60) }),
	);
	await sleep(3000);
	check("A#6 waits in Up next while temper #2 is worked on", statusIn(files.A, a2Id()) === "ready");
	function a2Id() {
		return opsIn(files.A).find((op) => op.op === "add" && op.plan?.title === "After docs")?.id ?? 2;
	}

	// temper #4 needs the user: A#4's line shows it; no poke.
	go.add("Port pick");
	const b4Stuck = await waitFor(() => ["stuck", "asking"].includes(statusIn(files.B, 4)), 30_000);
	check("temper #4 needs the user", !!b4Stuck, statusIn(files.B, 4));
	const shown4 = await waitFor(() => {
		const t = tasksIn(W).find((x) => x.id === 4);
		return ["stuck", "asking"].includes(t?.block?.on?.[0]?.status ?? "");
	}, 20_000);
	check(
		"A#4's line in the panel shows temper #4 needs the user",
		!!shown4,
		JSON.stringify(tasksIn(W).find((x) => x.id === 4)?.block),
	);

	// The Queue tab, in a real browser.
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	await lookAtPanel("", "queue-blocked-dark.png");
	await lookAtPanel("white", "queue-blocked-white.png");

	// The need: pokes at 20, 30, 40 s, then it asks the main chat.
	const asked5 = await waitFor(() => seen.cards.some((c) => /^\[Queue\] Task #5 asks/.test(c.text)), 90_000);
	const pokes = noteOf("Need a login");
	const t5 = seen.started.get("Need a login") ?? 0;
	check(
		"A#5 (a need only) was poked three times, at about 20, 30 and 40 s, re-blocking each time",
		pokes.length === 3 &&
			pokes.every((p, i) => new RegExp(`poke ${i + 1} of 3`).test(p.text) && p.at - t5 >= POKES_MS[i] - 500),
		JSON.stringify(pokes.map((p) => p.at - t5)),
	);
	check(
		"then it asked its main chat, saying it was poked three times",
		!!asked5 && /3 pokes didn't get it going/.test(seen.cards.find((c) => /Task #5 asks/.test(c.text))?.text ?? ""),
	);
	await waitFor(() => statusIn(files.A, 5) === "stuck", 30_000);
	check(
		"the main chat didn't answer, so it went to the user (#61's path)",
		statusIn(files.A, 5) === "stuck",
		statusIn(files.A, 5),
	);

	// temper #3 removed without finishing: A#3 is poked at once with that news.
	V = await connect("qb-b");
	await V.open(files.B);
	const removedAt = Date.now();
	await V.prompt("REMOVE-3");
	await waitFor(() => statusIn(files.B, 3) === "removed", 30_000);
	const poked3 = await waitFor(() => noteOf("Wait on spike").length > 0, 30_000);
	check(
		"temper #3 removed: A#3 is poked at once with that news, and goes on",
		!!poked3 &&
			/temper #3 \(Spike\) was removed from its queue without finishing/.test(noteOf("Wait on spike")[0]?.text ?? "") &&
			noteOf("Wait on spike")[0].at - removedAt < 20_000,
		statusIn(files.B, 3),
	);
	await waitFor(() => statusIn(files.A, 3) === "done", 20_000);
	check("A#3 finished after the poke", statusIn(files.A, 3) === "done", statusIn(files.A, 3));

	// While temper #1 is still worked on: no poke for A#1, ever.
	check("no poke while temper #1 is worked on", noteOf("Wait on runner").length === 0);

	// Every chat closed, the server restarted; then temper #1 and #2 finish.
	W.close();
	V.close();
	W = V = null;
	await sleep(500);
	await srv.restart();
	const b1Chat = bChat(1);
	const b2Chat = bChat(2);
	const b5Chat = chatOf(files.B, 5);

	// Step 7 (a finding, not checked): On hold waits after the restart, while their queue chat and
	// task chat are closed. Queue C is truly idle (nothing else in it); queue B still has tasks whose
	// cut-off turns carry on. Is each wait checked once its file appears?
	writeFileSync(files.flagC, "ready\n");
	writeFileSync(files.flag, "ready\n");
	const flagAt = Date.now();
	const wokeEarly = await waitFor(() => seen.waitWoke, 45_000);
	if (cWaiting) {
		const idleWoke = await waitFor(() => seen.idleWoke, Math.max(1, 90_000 - (Date.now() - flagAt)));
		report.push(
			idleWoke
				? `On hold after a restart, queue fully idle (queue C: its queue chat and task chat closed, nothing else running): checked; its chat was woken ${Math.round((idleWoke - flagAt) / 1000)} s after its check started passing.`
				: `On hold after a restart, queue fully idle (queue C: its queue chat and task chat closed, nothing else running): NOT checked; 90 s after its check started passing (it checks every 3 s here) the task is still ${statusIn(files.C, 1)} and its chat wasn't woken.`,
		);
	}
	report.push(
		wokeEarly
			? `On hold after a restart, queue with other tasks still running (temper #5): checked; its chat was woken ${Math.round((wokeEarly - flagAt) / 1000)} s after its check started passing.`
			: `On hold after a restart, queue with other tasks still running (temper #5): NOT checked within 45 s (status ${statusIn(files.B, 5)}; chat ${b5Chat ? "kept" : "missing"}).`,
	);

	// temper #1 and #2 finish (their turns carried on after the restart; A's chats stay closed).
	go.add("Team runner");
	go.add("Write docs");
	if (!(await waitFor(() => statusIn(files.B, 1) === "done" && statusIn(files.B, 2) === "done", 20_000))) {
		// Their turns didn't carry on by themselves: a new turn in each does it.
		V = await connect("qb-c");
		for (const f of [b1Chat, b2Chat]) {
			await V.open(f);
			await V.prompt("Go on");
		}
		console.log("    (temper #1 and #2 were finished in new turns: their cut-off turns didn't carry on)");
	}
	await waitFor(() => statusIn(files.B, 1) === "done" && statusIn(files.B, 2) === "done", 30_000);
	const doneAt = Date.now();
	check("temper #1 and #2 are done", statusIn(files.B, 1) === "done" && statusIn(files.B, 2) === "done");
	const poked1 = await waitFor(() => noteOf("Wait on runner").length > 0, 120_000);
	const n1 = noteOf("Wait on runner")[0];
	check(
		"after the restart, with A's chats closed, A#1 is poked within 2 min with temper #1's summary",
		!!poked1 &&
			/temper #1 \(Team runner\) is done: Team runner landed/.test(n1?.text ?? "") &&
			n1.at - doneAt < 120_000,
	);
	if (n1) console.log(`    (A#1 poked ${Math.round((n1.at - doneAt) / 1000)} s after temper #1 finished)`);
	await waitFor(() => statusIn(files.A, 1) === "done", 30_000);
	check("A#1 went back to work and finished", statusIn(files.A, 1) === "done", statusIn(files.A, 1));
	const startedAfter = await waitFor(() => seen.started.has("After docs"), 120_000);
	check(
		"A#6 (after temper #2) started by itself within 2 min",
		!!startedAfter && seen.started.get("After docs") - doneAt < 120_000,
	);
	check(
		"A#4 (its blocker needs the user) was never poked",
		noteOf("Wait on port").length === 0 && statusIn(files.A, 4) === "blocked",
	);
	check("nothing the script didn't expect", unexpected.length === 0, unexpected.join("; "));
	check("no page errors", pageErrors.length === 0, pageErrors.join("; "));

	if (!wokeEarly) {
		const woke = await waitFor(() => seen.waitWoke, 45_000);
		report.push(
			woke
				? `Once temper #1's done opened queue chat B, the wait was checked: woken ${Math.round((woke - doneAt) / 1000)} s later.`
				: "Even after queue chat B was opened (temper #1's done), the wait wasn't checked within 45 s.",
		);
	}
} catch (err) {
	failures++;
	console.log(`✗ FAIL: ${err?.stack ?? err}`);
} finally {
	for (const line of report) console.log(`  FINDING: ${line}`);
	W?.close();
	V?.close();
	await browser?.close().catch(() => {});
	await srv.stop();
}
console.log(failures ? `✗ queue-blocked: ${failures} failed` : "✓ queue-blocked: all passed");
process.exit(failures ? 1 : 0);
