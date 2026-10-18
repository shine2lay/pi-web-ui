/* queue-question-lead E2E (no tokens): a task's question goes to its queue's department first, then up the
 * chain to the owner (owner 2026-10-17, Ops note n181; pi-queue 84b50bc + 03ccd8b, pi-web-ui question-lead).
 *
 * A sealed test server with the real pi-queue (PI_QUEUE_PKG, default ~/projects/pi-queue) and the real
 * pi-identity (PI_IDENTITY_PKG, default ~/projects/pi-identity), the mock model, WebSocket clients and a real
 * browser. Roles and their home chats: systems (S, whose queue holds #1-#3), ops (O, the coordinator), design
 * (D, the project's lead), architecture (A, the initiative's lead), and qa, whose identity names no home chat
 * (its queue is in Q). The work registry holds initiative "proof-init" (lead architecture) and project
 * "proof-project" (lead design, under proof-init); S's tasks are in the project. Test clock: a question waits
 * 30 s (PI_QUEUE_TEST_ASK_WAIT_MS). Past its first due time the queue's chat looks again only every 10
 * minutes (not test-scaled), so while a question climbs the test asks S to look now ("/queue ping") every 2 s;
 * the task's chat still checks its own record and clock before each step.
 *  1. S #1 asks: the card comes to S (systems's lead), not to Ops; the task is told it went to its department;
 *     the Queue tab and the Roles page name systems's lead; Ops answering it is refused; systems's answer
 *     reaches the task as its decision, the queue records systems as the decider, and the task finishes.
 *  2. Q #1 asks (qa has no home chat): the card comes to Ops, whose answer is the decision; the task finishes.
 *  3. S #2 asks and nobody answers: one reminder to S, then once to D, then once to A, then it goes to the
 *     owner (stuck, passed on, the whole trail in his package); D answering after it went on is refused, and
 *     so is A once the owner has it; the task's chat is told once.
 *  4. S #3 asks what only the owner can give: S's answer is refused; S passes it on; it reaches the owner, and
 *     no lead above S or Ops gets it.
 *  Throughout: each card once, no card where it doesn't belong, nothing unexpected, no page errors.
 * Only counts and yes/no are printed: nothing the model is sent (rule 11).
 *
 * Usage: npm run build && node tests/run-sealed.mjs queue-question-lead
 *        PI_QUEUE_PKG / PI_IDENTITY_PKG pick the checkouts. QL_DEBUG=1: server log.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { textOf } from "./lib/mock-model.mjs";
import { ownServer } from "./lib/own-server.mjs";

const HOME = userInfo().homedir;
const PI_QUEUE = process.env.PI_QUEUE_PKG ?? join(HOME, "projects", "pi-queue");
const PI_IDENTITY = process.env.PI_IDENTITY_PKG ?? join(HOME, "projects", "pi-identity");
for (const [name, dir, env] of [
	["pi-queue", PI_QUEUE, "PI_QUEUE_PKG"],
	["pi-identity", PI_IDENTITY, "PI_IDENTITY_PKG"],
]) {
	if (!existsSync(join(dir, "package.json"))) {
		console.log(`✗ FAIL: ${name} not found at ${dir} (set ${env})`);
		process.exit(1);
	}
}
/** How long a question waits for its decider (the test clock; live it is 30 minutes). */
const WAIT_MS = 30_000;
/** Slack for the queue's looks (the test asks for one every 2 s) and the card's delivery. */
const SLACK_MS = 8_000;

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

// ---- the seeded chats, roles and registry --------------------------------------------------------------
const files = {};
let idDir = "";
let workDir = "";
const T = {
	s1: "Pick the cache size",
	s2: "Pick the log level",
	s3: "Approve the spend",
	q1: "Pick the retry count",
};
/** The deciders' answers; each carries a marker the task's chat looks for. */
const ANSWER = { [T.s1]: "Use 64 MB. DECIDE-S1", [T.q1]: "Retry three times. DECIDE-Q1" };
const MARK = { [T.s1]: "DECIDE-S1", [T.q1]: "DECIDE-Q1" };
const plan = (title) => ({
	title,
	goal: `${title}: the agreed result is in place for the team`,
	doneWhen: "The setting holds the agreed value on the test account",
	decided: "Change only this setting, then look at it again",
	steps: "1. Ask which value\n2. Set it\n3. Run the checks",
	verify: "Open the settings page and run the existing checks",
	mustNot: "Touch any other setting",
});
const S_ID = "01a0f000-0000-7000-8000-0000000000f1";
const Q_ID = "01a0f000-0000-7000-8000-0000000000f5";

function seed({ root, agentDir, workdir: wd }) {
	const settingsFile = join(agentDir, "settings.json");
	const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
	writeFileSync(
		settingsFile,
		JSON.stringify(
			{
				...settings,
				defaultProvider: "mock",
				defaultModel: "mock-model",
				packages: [PI_QUEUE, PI_IDENTITY],
				// The mock model's small context would compact the leads' chats after a card or two, and the mock
				// reads each chat's whole transcript: this test is about routing, so no compaction.
				compaction: { ...(settings.compaction ?? {}), enabled: false },
			},
			null,
			2,
		),
	);
	writeFileSync(join(agentDir, "pi-queue.json"), JSON.stringify({ stalledAfterMinutes: 0 }));
	const dir = join(agentDir, "sessions", `--${wd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(dir, { recursive: true });
	files.S = join(dir, `2026-10-01T10-01-00-000Z_${S_ID}.jsonl`);
	files.O = join(dir, "2026-10-01T10-02-00-000Z_01a0f000-0000-7000-8000-0000000000f2.jsonl");
	files.D = join(dir, "2026-10-01T10-03-00-000Z_01a0f000-0000-7000-8000-0000000000f3.jsonl");
	files.A = join(dir, "2026-10-01T10-04-00-000Z_01a0f000-0000-7000-8000-0000000000f4.jsonl");
	files.Q = join(dir, `2026-10-01T10-05-00-000Z_${Q_ID}.jsonl`);
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
			else
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
	const homeOf = (role, name) => [{ identity: role }, { name }, { user: `HOME:${role}` }, { assistant: "ok" }];
	write(files.S, [
		...homeOf("systems", "systems"),
		// Lanes on and touches declared, so each task runs in a chat of its own (rule 21's route needs that).
		{ queue: { op: "lanes", n: 2 } },
		{ queue: { op: "add", id: 1, plan: plan(T.s1), touches: ["s1 repo"], project: "proof-project" } },
		{ queue: { op: "add", id: 2, plan: plan(T.s2), touches: ["s2 repo"], after: [1], project: "proof-project" } },
		{ queue: { op: "add", id: 3, plan: plan(T.s3), touches: ["s3 repo"], after: [1], project: "proof-project" } },
		// Auto start on (the owner's switch), so the queue starts itself with a run bound to this chat.
		{ queue: { op: "autonomy", queueId: S_ID, setting: "autoStart", value: true } },
	]);
	write(files.Q, [
		...homeOf("qa", "qa queue"),
		{ queue: { op: "lanes", n: 2 } },
		{ queue: { op: "add", id: 1, plan: plan(T.q1), touches: ["q1 repo"], standalone: true } },
		{ queue: { op: "autonomy", queueId: Q_ID, setting: "autoStart", value: true } },
	]);
	write(files.O, homeOf("ops", "ops home"));
	write(files.D, homeOf("design", "design home"));
	write(files.A, homeOf("architecture", "architecture home"));
	idDir = join(root, "identities");
	const role = (id, json) => {
		mkdirSync(join(idDir, id), { recursive: true });
		writeFileSync(join(idDir, id, "identity.json"), JSON.stringify({ id, ...json }, null, "\t"));
		writeFileSync(join(idDir, id, "about.md"), `# ${json.title}\n`);
		writeFileSync(join(idDir, id, "notebook.md"), "");
	};
	role("systems", { title: "Systems", homeChat: files.S });
	role("ops", { title: "Ops", homeChat: files.O });
	role("design", { title: "Design", homeChat: files.D });
	role("architecture", { title: "Architecture", homeChat: files.A });
	role("qa", { title: "QA" }); // no home chat: its questions go to Ops
	// The work registry (pi-work-management's events): an initiative and a project under it.
	workDir = join(agentDir, "work");
	mkdirSync(workDir, { recursive: true });
	const at = Date.parse("2026-10-01T09:00:00.000Z");
	const events = [
		{
			op: "initiative.create",
			id: "proof-init",
			name: "Proof initiative",
			outcome: "Task questions reach the right lead",
			doneWhen: ["A question with no answer reaches the owner"],
			lead: "architecture",
			v: 1,
			seq: 1,
			ts: at,
			by: "owner",
		},
		{
			op: "project.create",
			id: "proof-project",
			name: "Proof project",
			outcome: "Settings are picked by the right lead",
			doneWhen: ["Each setting is picked"],
			lead: "design",
			initiative: "proof-init",
			v: 1,
			seq: 2,
			ts: at + 1000,
			by: "owner",
		},
	];
	writeFileSync(join(workDir, "events.jsonl"), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

// ---- the mock model ------------------------------------------------------------------------------------
/** What the chats got (kept here, never printed). */
const seen = {
	asked: new Map(), // task title -> queue_stuck's answer, as a category
	notes: new Map(), // task title -> [{ at, text }]: later messages in the task's own chat
	cards: [], // cards the home chats got: [{ home, who, id, queue, kind, tag, title, at }]
	replies: [], // the deciders' queue_reply answers: [{ home, title, step, kind }]
	tries: new Map(), // test-driven queue_reply attempts: key -> category
};
const release = { s1: false };
const unexpected = [];
const noteOf = (title) => {
	if (!seen.notes.has(title)) seen.notes.set(title, []);
	return seen.notes.get(title);
};
const CARD = /^\[Queue\] (Ops|Lead): task #(\d+) in "([^"]*)" (.+?) \[(k[0-9a-f]{8})\]: (.*)$/;
function cardOf(text) {
	const m = CARD.exec((text ?? "").split("\n")[0]);
	if (!m) return null;
	const what = m[4];
	const kind = /^asks again/.test(what)
		? "again"
		: /^asks you, one level up/.test(what)
			? "up"
			: /^asks \(question/.test(what)
				? "asks"
				: /still waits for your decision/.test(what)
					? "remind"
					: /is parked/.test(what)
						? "parked"
						: "other";
	return { who: m[1], id: Number(m[2]), queue: m[3], kind, tag: m[5], title: m[6].trim() };
}
/** queue_reply's answer, as a category (pi-queue's own texts; the text itself is never printed). */
function replyKind(text) {
	const t = text ?? "";
	if (/^Decided: task #\d+'s chat got your decision as /.test(t)) return "decided";
	if (/^Passed on: the owner sees task #\d+'s question/.test(t)) return "passed-on";
	if (/^Not taken: this chat doesn't decide task #\d+'s question now/.test(t)) return "not-decider";
	if (/^Not taken: task #\d+'s question went on to /.test(t)) return "went-on";
	if (/^Not taken: task #\d+ has no open question now/.test(t)) return "no-open";
	if (/^Not taken: k[0-9a-f]{8} is task #/.test(t)) return "stale";
	if (/^No question of task #\d+ came to this chat under/.test(t)) return "no-card";
	if (/says only the owner can give this .*You can't answer it/s.test(t)) return "owner-only";
	return "other";
}
/** queue_stuck's answer in a task's chat, as a category. */
function askKind(text) {
	const t = text ?? "";
	if (/^Asked systems's lead, your queue's department \(rule 21\)/.test(t)) return "systems";
	if (/^Asked Ops \(rule 21\)/.test(t)) return "ops";
	if (/your question is parked/.test(t)) return "parked";
	return "other";
}
const CHOICES = ["Option A", "Option B"];
const ownerContext = () => ({
	goal: "Prove that a task's question reaches the right lead.",
	progress: "Everything else is set up; only this choice is left.",
	decided: "none yet",
	why_owner: "It spends money, which only the owner can approve.",
	questions: ["Spend it for the test or not?"],
	options: CHOICES.map((choice) => ({
		choice,
		tradeoffs: `${choice} keeps the test small.`,
		cost: "none",
		time: "a minute",
		risk: "none",
		authorizes: `Picking ${choice} authorizes only this test step and nothing else.`,
	})),
	recommendation: "Option A, because it is the smaller step.",
});
function stuckArgs(title) {
	const base = {
		question: `Which value for: ${title}?`,
		choices: CHOICES,
		progress: "Did the groundwork; one choice is left.",
		recommendation: "Option A, because it is the simpler one.",
	};
	return title === T.s3
		? {
				...base,
				needs_owner: { kind: "spend", why: "It spends money, which only the owner can approve." },
				owner_context: ownerContext(),
			}
		: base;
}

/**
 * Each chat's progress through its own transcript: how many of its user messages and tool results the mock
 * has handled, the tool calls it made (in order: the n-th tool result answers the n-th call), and what it
 * still has to do. Several messages can come in one turn (two cards, a card and a notice), so every new one
 * is handled, not just the last.
 */
const chats = new Map();
const chatOf = (key) => {
	if (!chats.has(key)) chats.set(key, { users: 0, tools: 0, made: [], todo: [] });
	return chats.get(key);
};
/** A home chat's new user message: a card (recorded; what its lead does with it) or a test-driven try. */
function onHomeMessage(home, text, c) {
	const card = cardOf(text);
	if (card) {
		seen.cards.push({ home, ...card, at: Date.now() });
		const answer = (label, answerText) =>
			c.todo.push({ label, tool: "queue_reply", args: { id: card.id, ask: card.tag, answer: answerText } });
		if (card.kind !== "asks") return; // a lead that doesn't answer (#2's whole chain)
		if (home === "systems" && card.title === T.s1) answer({ title: T.s1, step: 1, hold: true }, ANSWER[T.s1]);
		else if (home === "ops" && card.title === T.q1) answer({ title: T.q1, step: 1 }, ANSWER[T.q1]);
		else if (home === "systems" && card.title === T.s3) {
			// Only the owner can give this: an answer is refused, then it passes it on with the whole package.
			answer({ title: T.s3, step: 1 }, "Spend it.");
			c.todo.push({
				label: { title: T.s3, step: 2 },
				tool: "queue_reply",
				args: {
					id: card.id,
					ask: card.tag,
					question: "Approve the test spend?",
					choices: CHOICES,
					owner_context: ownerContext(),
				},
			});
		}
		return;
	}
	const tr = /^TRY (\d+) (k[0-9a-f]{8}) (\S+)$/.exec(text);
	if (tr) {
		c.todo.push({
			label: { try: tr[3] },
			tool: "queue_reply",
			args: { id: Number(tr[1]), ask: tr[2], answer: "TRY-ANSWER" },
		});
		return;
	}
	// A card this test can't read would be a change in its format: say so.
	if (/^\[Queue\] (Ops|Lead):/.test(text)) unexpected.push(`a card in ${home}'s home chat this test can't read`);
}

async function modelReply({ payload, sideRequest }) {
	if (sideRequest) return "Question routing";
	const history = Array.isArray(payload.messages) ? payload.messages : [];
	const users = history.filter((m) => m.role === "user" && !/^\(System reminder/.test(textOf(m))).map((m) => textOf(m));
	const tools = history.filter((m) => m.role === "tool").map((m) => textOf(m));
	const firstText = users[0] ?? "";
	const home = /^HOME:([a-z]+)/.exec(firstText)?.[1];
	const kick = /^\[Queue\] Task #(\d+): (.+)/.exec(firstText);
	const title = kick?.[2].trim();
	if (!home && !kick) {
		if (process.env.QL_TRACE)
			console.log(
				`    trace other users=${users.length} tools=${tools.length} roles=${history.map((m) => m.role[0]).join("")} first=${/^\[Queue\]/.test(firstText) ? "queue" : /^\(/.test(firstText) ? "paren" : firstText ? "text" : "none"}`,
			);
		unexpected.push("a chat this test didn't seed");
		return "OTHER";
	}
	if (title && !Object.values(T).includes(title)) {
		unexpected.push("a task this test didn't plan");
		return "OTHER";
	}
	const c = chatOf(home ? `home:${home}` : `task:${title}`);
	// The results of the tool calls this chat made, in order.
	for (; c.tools < tools.length; c.tools++) {
		const label = c.made[c.tools];
		const text = tools[c.tools];
		if (!label) unexpected.push("a tool result this test didn't ask for");
		else if (label.try) seen.tries.set(label.try, replyKind(text));
		else if (label.asked) seen.asked.set(label.asked, askKind(text));
		else if (label.title) seen.replies.push({ home, title: label.title, step: label.step, kind: replyKind(text) });
	}
	// Its new messages.
	for (; c.users < users.length; c.users++) {
		const text = users[c.users];
		if (home) {
			if (c.users > 0) onHomeMessage(home, text, c);
		} else if (c.users === 0) {
			// The task's kickoff: it can't go on without a decision, and asks.
			c.todo.push({ label: { asked: title }, tool: "queue_stuck", args: stuckArgs(title) });
		} else {
			noteOf(title).push({ at: Date.now(), text });
			if (MARK[title] && text.includes(MARK[title]))
				c.todo.push({ label: { done: title }, tool: "queue_done", args: { summary: `${title}: decided, done` } });
		}
	}
	const next = c.todo.shift();
	// QL_TRACE=1: one line per model call, with counts and roles only (never the text, rule 11).
	if (process.env.QL_TRACE)
		console.log(
			`    trace ${home ? `home:${home}` : `task:${Object.keys(T).find((k) => T[k] === title)}`} users=${users.length} tools=${tools.length} roles=${history.map((m) => m.role[0]).join("")} next=${next ? JSON.stringify(Object.keys(next.label)) : "text"}`,
		);
	if (!next) return home ? "OK." : "TASK-WAITS";
	if (next.label.hold) {
		const t0 = Date.now();
		while (!release.s1 && Date.now() - t0 < 180_000) await sleep(100);
	}
	c.made.push(next.label);
	return { tool: next.tool, args: next.args };
}

// ---- a window, as a WebSocket client -------------------------------------------------------------------
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
	/** Open a chat. A queue's chat may be busy at once (its department's first card comes to it), so no idle wait. */
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
	name: "queue-question-lead",
	mock: modelReply,
	prepare: seed,
	verbose: !!process.env.QL_DEBUG,
	env: {
		PI_WEB_TOKEN: "",
		PI_QUEUE_TEST_FAST: "1",
		PI_QUEUE_TEST_ASK_WAIT_MS: String(WAIT_MS),
		get PI_IDENTITY_DIR() {
			return idDir;
		},
		get PI_WORK_DIR() {
			return workDir;
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

// ---- reading the saved state (read only) ------------------------------------------------------------
function linesOf(file) {
	try {
		return readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}
/** The queue ops in a transcript. */
const opsIn = (file) => linesOf(file).flatMap((e) => (e.type === "custom" && e.customType === "queue" ? [e.data] : []));
/** A task's status from its queue's ops. */
function statusIn(file, id) {
	let status = "gone";
	for (const op of opsIn(file)) {
		if (op.id !== id) continue;
		if (op.op === "add") status = "ready";
		else if (op.op === "start" || op.op === "resume") status = "working";
		else if (op.op === "done") status = "done";
		else if (op.op === "remove") status = "removed";
		else if (op.op === "stuck") status = "stuck";
		else if (op.op === "ask") status = "asking";
	}
	return status;
}
const lastOp = (file, id, kind) => [...opsIn(file)].reverse().find((op) => op.op === kind && op.id === id);
/** A task's own chat: the transcript under the sessions folder whose kickoff names it. */
function taskChatOf(title) {
	const root = dirname(dirname(files.S));
	const seeded = new Set(Object.values(files));
	for (const sub of readdirSync(root)) {
		const dir = join(root, sub);
		if (!statSync(dir).isDirectory()) continue;
		for (const f of readdirSync(dir)) {
			const path = join(dir, f);
			if (!f.endsWith(".jsonl") || seeded.has(path)) continue;
			const kick = linesOf(path).find((e) => e.type === "message" && e.message?.role === "user");
			const text = kick ? textOf(kick.message) : "";
			if (/^\[Queue\] Task #\d+: /.test(text) && text.split("\n")[0].endsWith(`: ${title}`)) return path;
		}
	}
	return null;
}
/** How often a text is in a transcript (any entry: a shown note doesn't start a turn, so the mock never sees it). */
const timesIn = (file, text) => (file ? readFileSync(file, "utf8").split(text).length - 1 : 0);
const cardsTo = (home, title, kind) =>
	seen.cards.filter((c) => c.home === home && c.title === title && (!kind || c.kind === kind));
const reply = (home, title, step) =>
	seen.replies.find((r) => r.home === home && r.title === title && (step === undefined || r.step === step));

// ---- a real browser, for the Queue tab and the Roles page --------------------------------------------
let browser = null;
const pageErrors = [];
async function openPage(clientId, url) {
	const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
	await ctx.addInitScript((id) => {
		localStorage.setItem("pi-web-client-id", id);
		localStorage.setItem("pi-web-ui:lang", "en");
		localStorage.setItem("pi-web-ui:right-panel-collapsed", "0");
	}, clientId);
	const page = await ctx.newPage();
	page.on("pageerror", () => pageErrors.push(clientId));
	await page.goto(url);
	await page.waitForSelector(".topbar", { timeout: 60_000 });
	return page;
}
const bodyHas = (page, text) => page.evaluate((t) => (document.body?.textContent ?? "").includes(t), text);

const clients = [];
let ticking = false;
try {
	// The leads' home chats first, then the two queues (Auto start starts each when it opens).
	for (const [name, file] of [
		["ql-o", files.O],
		["ql-d", files.D],
		["ql-a", files.A],
		["ql-s", files.S],
		["ql-q", files.Q],
	]) {
		const c = await connect(name);
		await c.open(file);
		clients.push(c);
	}
	const [WO, WD, WA, W] = clients;

	// 1. S #1 asks: its department (systems) decides.
	const asked1 = await waitFor(() => statusIn(files.S, 1) === "asking" && seen.asked.has(T.s1), 60_000);
	if (!check("S #1 runs in a chat of its own and asks", !!asked1, `status ${statusIn(files.S, 1)}`))
		throw new Error("S #1 didn't ask; the rest can't run");
	check(
		"queue_stuck tells it the question went to systems's lead, its queue's department",
		seen.asked.get(T.s1) === "systems",
		seen.asked.get(T.s1),
	);
	const card1 = await waitFor(() => cardsTo("systems", T.s1, "asks")[0], 30_000);
	check(
		"the card comes to systems's home chat, as a lead's card from \"systems\"",
		!!card1 && card1.who === "Lead" && card1.queue === "systems" && card1.id === 1,
		JSON.stringify(card1 ? { who: card1.who, queue: card1.queue === "systems" } : null),
	);
	const ask1 = lastOp(files.S, 1, "ask");
	check("the queue records the question with systems as its lead", ask1?.lead === "systems", ask1?.lead ?? "none");

	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const qPage = await openPage("ql-browser-q", `${srv.http}/?chat=${encodeURIComponent(files.S)}`);
	await qPage.locator(".panel-right .slot-tab", { hasText: "Queue" }).first().click();
	const qLine = await waitFor(
		() =>
			qPage.evaluate(
				() =>
					document
						.querySelector('li.task-queue-task[data-task-id="1"]')
						?.textContent?.includes("Asking systems's lead") ?? false,
			),
		20_000,
	);
	check('the Queue tab says task #1 is "Asking systems\'s lead"', !!qLine);
	const rPage = await openPage("ql-browser-r", `${srv.http}/?view=roles`);
	const rLine = await waitFor(() => bodyHas(rPage, "question with systems's lead"), 30_000);
	check("the Roles page says the question is with systems's lead", !!rLine);

	WO.prompt(`TRY 1 ${card1?.tag ?? "k00000000"} ops-s1`);
	const opsTry = await waitFor(() => seen.tries.get("ops-s1"), 30_000);
	check(
		"Ops answering it is refused (not its question now)",
		opsTry === "not-decider" || opsTry === "no-card",
		opsTry ?? "no result",
	);
	release.s1 = true;
	const r1 = await waitFor(() => reply("systems", T.s1), 30_000);
	check("systems's answer is taken as its decision", r1?.kind === "decided", r1?.kind ?? "no reply");
	const note1 = await waitFor(() => noteOf(T.s1).find((n) => n.text.includes(MARK[T.s1])), 30_000);
	check(
		"task #1's chat gets it as systems's lead's decision",
		!!note1 && /^\[Queue\] systems's lead's decision/.test(note1.text),
	);
	const done1 = await waitFor(() => statusIn(files.S, 1) === "done", 30_000);
	check("task #1 goes on and finishes", !!done1, statusIn(files.S, 1));
	const resume1 = lastOp(files.S, 1, "resume");
	check(
		"the queue records systems as the decider (rule 21), not Ops and not the owner",
		resume1?.decider === "systems" && resume1?.by === "ops",
		JSON.stringify({ decider: resume1?.decider ?? null, by: resume1?.by ?? null }),
	);
	check(
		"task #1's chat got exactly one message after it asked (the decision)",
		noteOf(T.s1).length === 1,
		`${noteOf(T.s1).length}`,
	);
	await qPage.context().close();
	await rPage.context().close();

	// 2. Q #1 asks: qa has no home chat, so Ops decides.
	const asked2 = await waitFor(() => seen.asked.has(T.q1), 60_000);
	check("Q #1 asks; it is told Ops has it", !!asked2 && seen.asked.get(T.q1) === "ops", seen.asked.get(T.q1));
	const cardQ = await waitFor(() => cardsTo("ops", T.q1, "asks")[0], 30_000);
	check("the card comes to Ops's home chat", !!cardQ && cardQ.who === "Ops", JSON.stringify(cardQ?.who ?? null));
	const rQ = await waitFor(() => reply("ops", T.q1), 30_000);
	check("Ops's answer is taken as its decision", rQ?.kind === "decided", rQ?.kind ?? "no reply");
	const doneQ = await waitFor(() => statusIn(files.Q, 1) === "done", 30_000);
	check("Q's task #1 gets it and finishes", !!doneQ && !!noteOf(T.q1).find((n) => n.text.includes(MARK[T.q1])));

	// 4. S #3 asks what only the owner can give (it starts beside #2, after #1).
	const card3 = await waitFor(() => cardsTo("systems", T.s3, "asks")[0], 90_000);
	check("S #3 asks; the card comes to systems's home chat", !!card3, `status ${statusIn(files.S, 3)}`);
	check("queue_stuck tells #3 it went to systems's lead", seen.asked.get(T.s3) === "systems", seen.asked.get(T.s3));
	const try3 = await waitFor(() => reply("systems", T.s3, 1), 30_000);
	check("systems answering it itself is refused: only the owner can give it", try3?.kind === "owner-only", try3?.kind);
	const pass3 = await waitFor(() => reply("systems", T.s3, 2), 30_000);
	check("systems passes it on to the owner with the whole package", pass3?.kind === "passed-on", pass3?.kind);
	const stuck3 = await waitFor(() => {
		const op = lastOp(files.S, 3, "stuck");
		return op?.ask?.passed ? op : null;
	}, 20_000);
	check("the queue records #3 as the owner's (stuck, passed on)", !!stuck3 && statusIn(files.S, 3) === "stuck");

	// 3. S #2 asks and nobody answers: one reminder, then up the chain to the owner.
	const card2 = await waitFor(() => cardsTo("systems", T.s2, "asks")[0], 60_000);
	if (!check("S #2 asks; the card comes to systems's home chat", !!card2, `status ${statusIn(files.S, 2)}`))
		throw new Error("S #2's card didn't come; its climb can't be checked");
	ticking = true;
	(async () => {
		while (ticking) {
			await W.prompt("/queue ping").catch(() => {});
			await sleep(2000);
		}
	})();
	const remind2 = await waitFor(() => cardsTo("systems", T.s2, "remind")[0], WAIT_MS + 3 * SLACK_MS);
	check(
		"one reminder to systems, a wait after the question",
		!!remind2 && remind2.at - card2.at >= WAIT_MS - SLACK_MS,
		JSON.stringify({ sent: !!remind2, after: remind2 ? remind2.at - card2.at : null }),
	);
	const up2d = await waitFor(() => cardsTo("design", T.s2, "up")[0], 2 * WAIT_MS + 3 * SLACK_MS);
	check(
		"then up to design, the project's lead, two waits after the question",
		!!up2d && up2d.at - card2.at >= 2 * WAIT_MS - SLACK_MS && up2d.queue === "systems",
		JSON.stringify({ sent: !!up2d, after: up2d ? up2d.at - card2.at : null }),
	);
	const up2a = await waitFor(() => cardsTo("architecture", T.s2, "up")[0], WAIT_MS + 3 * SLACK_MS);
	check(
		"then up to architecture, the initiative's lead, a wait after design",
		!!up2a && !!up2d && up2a.at - up2d.at >= WAIT_MS - SLACK_MS,
		JSON.stringify({ sent: !!up2a, after: up2a && up2d ? up2a.at - up2d.at : null }),
	);
	WD.prompt(`TRY 2 ${up2d?.tag ?? "k00000000"} design-late`);
	const lateD = await waitFor(() => seen.tries.get("design-late"), 30_000);
	check(
		"design answering after it went on is refused",
		lateD === "went-on" || lateD === "no-open" || lateD === "stale",
		lateD ?? "no result",
	);
	const stuck2 = await waitFor(
		() => {
			const op = lastOp(files.S, 2, "stuck");
			return op?.ask?.passed ? op : null;
		},
		WAIT_MS + 3 * SLACK_MS,
	);
	check(
		"then it goes to the owner (stuck, passed on), a wait after architecture",
		!!stuck2 && !!up2a && stuck2.ts - up2a.at >= WAIT_MS - SLACK_MS,
		JSON.stringify({ passed: !!stuck2, after: stuck2 && up2a ? stuck2.ts - up2a.at : null }),
	);
	const pack = JSON.stringify(stuck2 ?? {});
	check(
		"the owner's package names everyone it went to",
		["systems's lead", "design's lead", "architecture's lead"].every((s) => pack.includes(s)),
	);
	WA.prompt(`TRY 2 ${up2a?.tag ?? "k00000000"} arch-late`);
	const lateA = await waitFor(() => seen.tries.get("arch-late"), 30_000);
	check(
		"architecture answering once the owner has it is refused",
		lateA === "no-open" || lateA === "went-on" || lateA === "stale",
		lateA ?? "no result",
	);
	const chat2 = taskChatOf(T.s2);
	const told2 = await waitFor(() => timesIn(chat2, "went to the owner with the whole record") > 0, 20_000);
	check("task #2's chat shows that it went to the owner", !!told2, chat2 ? "no note" : "its chat wasn't found");
	// A few more looks: nothing goes twice.
	await sleep(3 * 2000 + 2000);
	ticking = false;
	await sleep(2500);

	const count = (home, title, kind) => cardsTo(home, title, kind).length;
	const counts = {
		s1: count("systems", T.s1),
		s2: [
			count("systems", T.s2, "asks"),
			count("systems", T.s2, "remind"),
			count("design", T.s2),
			count("architecture", T.s2),
		],
		s3: count("systems", T.s3),
		q1: count("ops", T.q1),
	};
	check(
		"each card once: #1 one, #2 one + one reminder + one to design + one to architecture, #3 one, Q #1 one",
		counts.s1 === 1 &&
			counts.s2.join() === "1,1,1,1" &&
			seen.cards.filter((c) => c.title === T.s2).length === 4 &&
			counts.s3 === 1 &&
			counts.q1 === 1,
		JSON.stringify(counts),
	);
	check(
		"Ops got no card about systems's tasks, and design and architecture none about #1 or #3",
		seen.cards.filter((c) => c.home === "ops" && c.title !== T.q1).length === 0 &&
			seen.cards.filter((c) => (c.home === "design" || c.home === "architecture") && c.title !== T.s2).length === 0,
	);
	check(
		"#2's note is shown once, and neither #2's nor #3's chat is woken while it waits for the owner",
		timesIn(chat2, "went to the owner with the whole record") === 1 &&
			noteOf(T.s2).length === 0 &&
			noteOf(T.s3).length === 0,
		JSON.stringify({
			notes: timesIn(chat2, "went to the owner with the whole record"),
			s2: noteOf(T.s2).length,
			s3: noteOf(T.s3).length,
		}),
	);
	const panel = W.state?.taskQueue?.tasks ?? [];
	check(
		"the Queue tab's data shows #2 and #3 waiting on the owner",
		panel.find((t) => t.id === 2)?.status === "stuck" && panel.find((t) => t.id === 3)?.status === "stuck",
		JSON.stringify(panel.map((t) => ({ id: t.id, status: t.status }))),
	);
	check("nothing unexpected reached the model", unexpected.length === 0, `${unexpected.length}`);
	check("no page errors", pageErrors.length === 0, `${pageErrors.length}`);
} catch (err) {
	console.log(`✗ FAIL: ${err instanceof Error ? err.message : String(err)}`);
	failures++;
} finally {
	if (process.env.QL_TRACE)
		console.log(`    trace streaming ${clients.map((c) => `${c.name}=${c.state?.isStreaming}`).join(" ")}`);
	ticking = false;
	release.s1 = true;
	for (const c of clients) c.close();
	await browser?.close().catch(() => {});
	await srv.stop();
}
console.log(failures === 0 ? "queue-question-lead: all passed" : `queue-question-lead: ${failures} failed`);
process.exit(failures ? 1 : 0);
