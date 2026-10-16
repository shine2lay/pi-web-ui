/* queue-lead-reminders E2E (no tokens): the lead a blocked task waits on is reminded in its home chat, and its
 * answer reaches the task (AGENTS.md rule 24, Ops #199).
 *
 * A sealed test server with the real pi-queue (PI_QUEUE_PKG, default ~/projects/pi-queue) and the real
 * pi-identity (PI_IDENTITY_PKG, default ~/projects/pi-identity), the mock model, WebSocket clients and a real
 * browser. Two roles: "systems" (home chat S, its queue: #1 "Wait for admission", then #2 "Wait for review"
 * after #1) and "ops" (home chat O, the lead both tasks wait on). Test clocks: the server's check every 2 s
 * (PI_WEB_QUEUE_BLOCKS_MS), the first reminder 12 s after a block starts and the next 60 s later
 * (PI_QUEUE_TEST_LEAD_MS), need pokes at 5, 6 and 7 s (PI_QUEUE_TEST_BLOCK_POKES_MS), so a task chat poking
 * itself about a lead block would show; the unit tests check the real hour and two hours on fake clocks.
 *  1. The owner pauses role messages. #1 blocks on ops (queue_blocked lead + owes): its checkpoint passes
 *     and nothing goes anywhere: no card in O, no line in the server's ledger, no remind op, no poke in
 *     #1's own chat.
 *  2. O is busy in a long turn; the owner resumes role messages. The reminder goes out within seconds (the
 *     ledger, S's remind op), but O gets no card while its turn runs; the turn ends whole, then the card
 *     comes, once. It says who waits, for how long, what is owed, the checkpoint, how to answer, and that it
 *     carries no approval.
 *  3. Ops answers with queue_reply (id, tag, answer): #1's own chat gets the answer, marked as ops's lead's
 *     decision, not the owner's consent, and #1 finishes. S records the answer once.
 *  4. #2 blocks on ops: at its checkpoint the card comes to O (idle now); ops gives a new checkpoint ("in 1d"):
 *     #2's chat isn't woken, S records it, no second card; the Queue tab shows "waits on ops: <owed>" and when
 *     ops is reminded next (screenshot with LR_SHOT_DIR).
 *  Throughout: one card and one ledger line per reminder, no ask card, no page errors.
 * Only counts and yes/no are printed: nothing the model is sent (rule 11).
 *
 * Usage: npm run build && node tests/run-sealed.mjs queue-lead-reminders
 *        PI_QUEUE_PKG / PI_IDENTITY_PKG pick the checkouts. LR_DEBUG=1: server log.
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
for (const [name, dir, env] of [
	["pi-queue", PI_QUEUE, "PI_QUEUE_PKG"],
	["pi-identity", PI_IDENTITY, "PI_IDENTITY_PKG"],
]) {
	if (!existsSync(join(dir, "package.json"))) {
		console.log(`✗ FAIL: ${name} not found at ${dir} (set ${env})`);
		process.exit(1);
	}
}
/** The test clocks (see the header). */
const CHECKPOINT_MS = 12_000;
const GAP_MS = 60_000;
const DAY_MS = 24 * 3600_000;

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

// ---- the seeded chats and roles ------------------------------------------------------------------------
const files = {};
let idDir = "";
const plan = (title) => ({
	title,
	goal: `${title}: the agreed result is in place for the team`,
	doneWhen: "The page shows the agreed result on the test account",
	decided: "Change only this part, then look at the page again",
	steps: "1. Make the change\n2. Look at the page\n3. Run the checks",
	verify: "Open the page and run the existing checks",
	mustNot: "Touch anything else on the page",
});
const T1 = "Wait for admission";
const T2 = "Wait for review";
const OWES = { [T1]: "admission for the fresh diagnosis", [T2]: "a review of the patch" };
const ANSWER = "Admitted: go ahead with the diagnosis. ADMIT-1";

function seed({ root, agentDir, workdir: wd }) {
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
	const dir = join(agentDir, "sessions", `--${wd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(dir, { recursive: true });
	files.S = join(dir, "2026-10-01T10-01-00-000Z_01a0f000-0000-7000-8000-0000000000e1.jsonl");
	files.O = join(dir, "2026-10-01T10-02-00-000Z_01a0f000-0000-7000-8000-0000000000e2.jsonl");
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
	write(files.S, [
		{ identity: "systems" },
		{ name: "systems" },
		// Lanes on and touches declared, so each task runs in a chat of its own (queue_blocked works only there).
		{ queue: { op: "lanes", n: 2 } },
		{ queue: { op: "add", id: 1, plan: plan(T1), touches: ["s1 repo"] } },
		{ queue: { op: "add", id: 2, plan: plan(T2), touches: ["s2 repo"], after: [1] } },
	]);
	write(files.O, [{ identity: "ops" }, { name: "ops home" }, { user: "ops home starts" }, { assistant: "ok" }]);
	idDir = join(root, "identities");
	const role = (id, json) => {
		mkdirSync(join(idDir, id), { recursive: true });
		writeFileSync(join(idDir, id, "identity.json"), JSON.stringify({ id, ...json }, null, "\t"));
		writeFileSync(join(idDir, id, "about.md"), `# ${json.title}\n`);
		writeFileSync(join(idDir, id, "notebook.md"), "");
	};
	role("systems", { title: "Systems", homeChat: files.S });
	role("ops", { title: "Ops", homeChat: files.O });
}

// ---- the mock model ------------------------------------------------------------------------------------
/** What the chats got (kept here, never printed). */
const seen = {
	blockResults: new Map(), // task title -> queue_blocked's answer
	notes: new Map(), // task title -> [{ at, text }]: later messages in the task's own chat
	cards: [], // reminder cards ops's chat answered: [{ at, n, tag, id }]
	replies: [], // what queue_reply answered: [{ id, kind }]
	asks: 0, // ask cards (none expected)
	busy: { started: 0, ended: 0 },
};
let release = false;
const unexpected = [];
const noteOf = (title) => {
	if (!seen.notes.has(title)) seen.notes.set(title, []);
	return seen.notes.get(title);
};
/** queue_reply's answer to a lead, as a category. */
function replyKind(text) {
	if (/^Sent: task #\d+ goes back to work with your answer/.test(text ?? "")) return "sent";
	if (/^Checkpoint moved: the next reminder about task #\d+/.test(text ?? "")) return "moved";
	if (/^Already answered/.test(text ?? "")) return "again";
	if (/^Not taken/.test(text ?? "")) return "not-taken";
	return "other";
}
/** queue_blocked's answer, as a category (pi-queue's own texts; the text itself is never printed). */
function blockKind(text) {
	const t = text ?? "";
	if (/isn't poked about it/.test(t)) return "ok";
	const known = [
		["only in a queued task's own chat", "not-task-chat"],
		["isn't being worked on", "not-working"],
		["lead: give the role id", "bad-lead"],
		["owes and checkpoint go with lead", "owes-without-lead"],
		["owes: say what", "no-owes"],
		["Say what it waits on", "nothing"],
		["checkpoint: write when", "bad-checkpoint"],
		["can't remind a lead yet", "no-host"],
		["there's no role", "no-role"],
		["Couldn't mark the task blocked", "not-marked"],
		["alidation", "invalid-args"],
	];
	for (const [s, k] of known) if (t.includes(s)) return k;
	return /Blocked/.test(t) ? "blocked-other-text" : "other";
}
const CARD = /^\[Queue\] Reminder (\d+) of \d+ for ops \(rule 24\) \[(l[0-9a-f]{8})\]: task #(\d+) \(/;

async function modelReply({ payload, sideRequest }) {
	if (sideRequest) return "Lead reminders";
	const history = Array.isArray(payload.messages) ? payload.messages : [];
	const users = [];
	history.forEach((m, i) => {
		if (m.role === "user" && !/^\(System reminder/.test(textOf(m))) users.push(i);
	});
	const first = users[0] ?? -1;
	const kick = first >= 0 ? textOf(history[first]).match(/^\[Queue\] Task #(\d+): (.+)/) : null;
	const last = users.at(-1) ?? -1;
	const userText = last >= 0 ? textOf(history[last]) : "";
	const results = history
		.slice(last + 1)
		.filter((m) => m.role === "tool")
		.map(textOf);
	const step = results.length;
	if (!kick) {
		// A role's home chat: systems (the queue's chat) or ops (the lead).
		if (userText.startsWith("BUSY-TURN")) {
			if (step > 0) return "BUSY-OVER";
			seen.busy.started ||= Date.now();
			const t0 = Date.now();
			while (!release && Date.now() - t0 < 150_000) await sleep(100);
			seen.busy.ended = Date.now();
			return "BUSY-DONE";
		}
		const card = CARD.exec(userText);
		if (card) {
			const [, n, tag, id] = card;
			if (step === 0) {
				seen.cards.push({ at: Date.now(), n: Number(n), tag, id: Number(id) });
				return Number(id) === 1
					? { tool: "queue_reply", args: { id: 1, ask: tag, answer: ANSWER } }
					: { tool: "queue_reply", args: { id: Number(id), ask: tag, checkpoint: "in 1d" } };
			}
			seen.replies.push({ id: Number(id), kind: replyKind(results[0]) });
			return "LEAD-REPLIED";
		}
		if (/^\[Queue\] Task #\d+ asks\b/.test(userText) || /^\[Queue\] Ops: task #/.test(userText)) {
			if (step === 0) seen.asks++;
			return "NOT-SURE";
		}
		return "HOME ok.";
	}
	const title = kick[2].trim();
	if (last === first) {
		// The task's kickoff: it needs ops's go, and says so.
		if (step === 0) {
			if (!OWES[title]) {
				unexpected.push("a task this test didn't plan");
				return "OTHER";
			}
			return { tool: "queue_blocked", args: { need: `Ops's go for: ${title}`, lead: "ops", owes: OWES[title] } };
		}
		seen.blockResults.set(title, results[0] ?? "");
		return "TASK-BLOCKED";
	}
	if (step === 0) {
		noteOf(title).push({ at: Date.now(), text: userText });
		if (userText.includes("ADMIT-1")) return { tool: "queue_done", args: { summary: `${title}: admitted, went on` } };
		return "TASK-OTHER";
	}
	return "TASK-DONE";
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
	async open(file) {
		this.send({ type: "switch_session", path: file });
		if (!(await waitFor(() => this.state?.sessionFile === file && this.state.isStreaming === false, 20_000)))
			throw new Error(`[${this.name}] couldn't open a chat`);
	}
	async prompt(text) {
		await waitFor(() => this.state && !this.state.isStreaming, 30_000);
		this.send({ type: "prompt", text });
		await sleep(400);
		await waitFor(() => this.state && !this.state.isStreaming, 30_000);
	}
	/** The owner's pause on role messages (the Roles page's switch). */
	async pause(paused) {
		const n = this.received.length;
		this.send({ type: "role_messages_pause", paused });
		const msg = await waitFor(() => this.received.slice(n).find((m) => m.type === "role_messages"), 10_000);
		return msg?.paused === paused;
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
	name: "queue-lead-reminders",
	mock: modelReply,
	prepare: seed,
	verbose: !!process.env.LR_DEBUG,
	env: {
		PI_WEB_TOKEN: "",
		PI_QUEUE_TEST_FAST: "1",
		PI_QUEUE_TEST_LEAD_MS: `${CHECKPOINT_MS},${GAP_MS}`,
		PI_QUEUE_TEST_BLOCK_POKES_MS: "5000,6000,7000",
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
}, 420_000);
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
/** A task's status from its queue's ops, for the ones this test uses. */
function statusIn(file, id) {
	let status = "gone";
	for (const op of opsIn(file)) {
		if (op.id !== id) continue;
		if (op.op === "add") status = "ready";
		else if (op.op === "start" || op.op === "resume") status = "working";
		else if (op.op === "block") status = "blocked";
		else if (op.op === "done") status = "done";
		else if (op.op === "remove") status = "removed";
		else if (op.op === "stuck") status = "stuck";
		else if (op.op === "ask") status = "asking";
	}
	return status;
}
const lastBlockOp = (file, id) => [...opsIn(file)].reverse().find((op) => op.op === "block" && op.id === id);
/** The transcript's messages: { role, text, stopReason }. */
const entries = (file) =>
	linesOf(file).flatMap((e) =>
		e.type === "message" ? [{ role: e.message?.role, text: textOf(e.message), stopReason: e.message?.stopReason }] : [],
	);
/** Reminder cards about task `id` in ops's home chat (user messages). */
const cardsIn = (id) =>
	entries(files.O).filter((m) => m.role === "user" && CARD.test(m.text) && Number(CARD.exec(m.text)[3]) === id);
/** The server's ledger of reminders sent (queue-lead-reminders.jsonl). */
const ledger = () => linesOf(join(srv.dataDir, "queue-lead-reminders.jsonl"));
const panelBlock = (c, id) => c.state?.taskQueue?.tasks?.find((t) => t.id === id)?.block;

// ---- a real browser, for the Queue tab --------------------------------------------------------------
let browser = null;
const pageErrors = [];
const SHOTS = process.env.LR_SHOT_DIR;
async function openPage(clientId, file) {
	const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
	await ctx.addInitScript((id) => {
		localStorage.setItem("pi-web-client-id", id);
		localStorage.setItem("pi-web-ui:lang", "en");
		localStorage.setItem("pi-web-ui:right-panel-collapsed", "0");
	}, clientId);
	const page = await ctx.newPage();
	page.on("pageerror", () => pageErrors.push(clientId));
	await page.goto(`${srv.http}/?chat=${encodeURIComponent(file)}`);
	await page.waitForSelector(".topbar", { timeout: 60_000 });
	await page.locator(".panel-right .slot-tab", { hasText: "Queue" }).first().click();
	await page.locator(".task-queue-panel, .panel-right .task-queue").first().waitFor({ timeout: 10_000 });
	return page;
}

let W = null;
let W2 = null;
try {
	// 1. The owner pauses role messages; task #1 blocks on ops; its checkpoint passes; nothing goes anywhere.
	W = await connect("lr-s");
	await W.open(files.S);
	check("the owner pauses role messages", await W.pause(true));
	await W.prompt("/queue start");
	const blocked1 = await waitFor(() => statusIn(files.S, 1) === "blocked" && seen.blockResults.has(T1), 60_000);
	if (
		!check(
			"task #1 runs in a chat of its own and blocks on ops",
			!!blocked1,
			`status ${statusIn(files.S, 1)}, queue_blocked: ${seen.blockResults.has(T1) ? blockKind(seen.blockResults.get(T1)) : "not called back"}`,
		)
	) {
		const ops1 = opsIn(files.S).filter((o) => o.id === 1);
		const stuck = ops1.findLast((o) => o.op === "stuck");
		console.log(
			`  queue ops for #1: ${ops1.map((o) => o.op).join(",")}${stuck ? " (it stopped without blocking)" : ""}`,
		);
		throw new Error("task #1 didn't block; the rest can't run");
	}
	const b1 = lastBlockOp(files.S, 1);
	check(
		"the queue's copy of the block names the lead and what it owes (default checkpoint)",
		b1?.lead === "ops" && b1?.owes === OWES[T1] && b1?.checkpoint === undefined && typeof b1?.start === "number",
		JSON.stringify({ lead: b1?.lead ?? null, owes: b1?.owes === OWES[T1], checkpoint: b1?.checkpoint ?? null }),
	);
	check(
		"queue_blocked tells the task its chat isn't poked: ops gets the reminder",
		/isn't poked about it/.test(seen.blockResults.get(T1) ?? "") &&
			/ops's lead gets a reminder/.test(seen.blockResults.get(T1) ?? ""),
	);
	const due1 = (b1?.start ?? Date.now()) + CHECKPOINT_MS;
	await waitFor(() => Date.now() > due1 + 10_000, 60_000);
	check(
		"paused: past the checkpoint nothing went: no card in ops's chat, no ledger line, no remind op",
		cardsIn(1).length === 0 && ledger().length === 0 && !opsIn(files.S).some((o) => o.op === "remind"),
		JSON.stringify({ cards: cardsIn(1).length, ledger: ledger().length }),
	);
	check(
		"no self-poke: task #1's chat got nothing while it waited",
		noteOf(T1).length === 0,
		`${noteOf(T1).length} messages`,
	);
	const p1 = await waitFor(() => {
		const b = panelBlock(W, 1);
		return b?.lead === "ops" && b.nextRemindN === 1 ? b : null;
	}, 10_000);
	check(
		"the panel's data shows the lead, what it owes, and the reminder that is due",
		p1?.owes === OWES[T1] && p1?.nextRemindAt <= Date.now() && p1?.nextPokeAt === undefined,
		JSON.stringify({ lead: p1?.lead ?? null, n: p1?.nextRemindN ?? null }),
	);

	// 2. Ops's home chat is busy in a turn; the owner resumes: the reminder goes, the card waits for the turn.
	W2 = await connect("lr-o");
	await W2.open(files.O);
	W2.send({ type: "prompt", text: "BUSY-TURN hold on" });
	check(
		"ops's home chat is busy in a turn",
		!!(await waitFor(() => seen.busy.started && W2.state?.isStreaming === true, 20_000)),
	);
	check("the owner resumes role messages", await W.pause(false));
	const resumedAt = Date.now();
	const sent1 = await waitFor(() => ledger().find((r) => r.id === 1 && r.n === 1 && r.lead === "ops"), 20_000);
	check(
		"the reminder goes out within seconds of the resume, to ops's home chat (the server's ledger)",
		!!sent1 && sent1.to === files.O && sent1.at - resumedAt < 10_000,
		JSON.stringify({
			sent: !!sent1,
			toO: sent1 ? sent1.to === files.O : null,
			ms: sent1 ? sent1.at - resumedAt : null,
		}),
	);
	const remind1 = await waitFor(() => opsIn(files.S).find((o) => o.op === "remind" && o.id === 1 && o.n === 1), 10_000);
	check("the queue records it (remind op to ops)", remind1?.to === "ops" && remind1?.missed === undefined);
	await sleep(4000);
	check(
		"mid-turn: ops's chat gets no card while its turn runs",
		cardsIn(1).length === 0 && W2.state?.isStreaming === true && !seen.busy.ended,
		JSON.stringify({ cards: cardsIn(1).length, streaming: W2.state?.isStreaming ?? null }),
	);
	release = true;
	const card1 = await waitFor(() => cardsIn(1).length > 0, 30_000);
	const oAll = entries(files.O);
	const busyAt = oAll.findIndex((m) => m.role === "assistant" && m.text === "BUSY-DONE");
	const cardAt = oAll.findIndex((m) => m.role === "user" && CARD.test(m.text));
	check(
		"the card comes after the turn, which ends whole",
		!!card1 && busyAt >= 0 && cardAt > busyAt && oAll[busyAt].stopReason === "stop",
		JSON.stringify({ busyAt, cardAt }),
	);
	const text1 = cardsIn(1)[0]?.text ?? "";
	const says = {
		first:
			/^\[Queue\] Reminder 1 of 2 for ops \(rule 24\) \[l[0-9a-f]{8}\]: task #1 \(Wait for admission\) in the queue of "systems" has waited /.test(
				text1,
			),
		owed: text1.includes(`Owed: ${OWES[T1]}.`),
		checkpoint: /Checkpoint: [^\n]*\(passed\)/.test(text1),
		how: /Answer it with queue_reply \(id 1, ask "l[0-9a-f]{8}"\)/.test(text1) && text1.includes("- or checkpoint"),
		noApproval: text1.includes("This card carries no approval") && text1.includes("not the owner's consent (rule 21)"),
	};
	check(
		"it says who waits, for how long, what is owed, the checkpoint, how to answer, and that it approves nothing",
		Object.values(says).every(Boolean),
		JSON.stringify(says),
	);

	// 3. Ops answers: the waiting task gets it and goes on.
	const answered = await waitFor(() => noteOf(T1).find((n) => n.text.includes("ADMIT-1")), 45_000);
	check(
		"ops's answer (queue_reply id + tag) reaches task #1's own chat, marked as ops's lead's decision",
		!!answered &&
			/^\[Queue\] Task #1: ops's lead answered what this task was blocked on/.test(answered.text) &&
			answered.text.includes("not the owner's consent (rule 21)"),
	);
	check(
		"queue_reply tells ops it was sent",
		!!(await waitFor(() => seen.replies.some((r) => r.id === 1 && r.kind === "sent"), 15_000)),
		JSON.stringify(seen.replies),
	);
	const done1 = await waitFor(() => statusIn(files.S, 1) === "done", 30_000);
	check("task #1 goes back to work with it and finishes", !!done1, statusIn(files.S, 1));
	const lead1 = opsIn(files.S).filter((o) => o.op === "lead" && o.id === 1);
	check(
		"the queue records the answer once, as ops's (its record id)",
		lead1.length === 1 &&
			lead1[0].by === "ops" &&
			lead1[0].answer === ANSWER &&
			/^r[0-9a-f]{12}$/.test(lead1[0].rid ?? "") &&
			lead1[0].since === b1?.ts,
		JSON.stringify({ n: lead1.length, by: lead1[0]?.by ?? null }),
	);
	check(
		"task #1's chat got exactly one message after it blocked (the answer)",
		noteOf(T1).length === 1,
		`${noteOf(T1).length}`,
	);

	// 4. Task #2 blocks on ops; at its checkpoint the card comes to ops's idle chat; ops moves the checkpoint.
	const blocked2 = await waitFor(() => statusIn(files.S, 2) === "blocked" && seen.blockResults.has(T2), 60_000);
	if (
		!check(
			"task #2 starts after #1 and blocks on ops",
			!!blocked2,
			`status ${statusIn(files.S, 2)}, queue_blocked: ${seen.blockResults.has(T2) ? blockKind(seen.blockResults.get(T2)) : "not called back"}`,
		)
	)
		throw new Error("task #2 didn't block; the rest can't run");
	const b2 = lastBlockOp(files.S, 2);
	const due2 = (b2?.start ?? Date.now()) + CHECKPOINT_MS;
	const card2 = await waitFor(() => cardsIn(2).length > 0, CHECKPOINT_MS + 40_000);
	const sent2 = ledger().find((r) => r.id === 2 && r.n === 1);
	check(
		"at its checkpoint the card comes to ops's chat (idle now), within seconds of due",
		!!card2 && !!sent2 && sent2.at >= due2 && sent2.at - due2 < 10_000,
		JSON.stringify({ card: !!card2, sent: !!sent2, late: sent2 ? sent2.at - due2 : null }),
	);
	const moved = await waitFor(() => opsIn(files.S).find((o) => o.op === "lead" && o.id === 2), 30_000);
	check(
		'ops gives a new checkpoint ("in 1d"): the queue records it, with no answer',
		!!moved &&
			moved.by === "ops" &&
			moved.answer === undefined &&
			Math.abs(moved.checkpoint - (moved.ts + DAY_MS)) < 120_000,
		JSON.stringify({ recorded: !!moved, answer: moved ? moved.answer !== undefined : null }),
	);
	check(
		"queue_reply tells ops the checkpoint moved and the task wasn't woken",
		!!(await waitFor(() => seen.replies.some((r) => r.id === 2 && r.kind === "moved"), 15_000)),
		JSON.stringify(seen.replies),
	);
	await sleep(8000);
	check(
		"task #2's chat isn't woken; it stays blocked",
		noteOf(T2).length === 0 && statusIn(files.S, 2) === "blocked",
		JSON.stringify({ messages: noteOf(T2).length, status: statusIn(files.S, 2) }),
	);
	check(
		"exactly once: one card and one ledger line per reminder, no second reminder",
		cardsIn(1).length === 1 &&
			cardsIn(2).length === 1 &&
			ledger().length === 2 &&
			opsIn(files.S).filter((o) => o.op === "remind").length === 2 &&
			seen.cards.length === 2,
		JSON.stringify({
			cards1: cardsIn(1).length,
			cards2: cardsIn(2).length,
			ledger: ledger().length,
			remindOps: opsIn(files.S).filter((o) => o.op === "remind").length,
			answered: seen.cards.length,
		}),
	);
	const p2 = await waitFor(() => {
		const b = panelBlock(W, 2);
		return b?.nextRemindAt === moved?.checkpoint ? b : null;
	}, 10_000);
	check(
		"the panel's data shows the next reminder (2 of 2) at the new checkpoint",
		p2?.nextRemindN === 2 && p2?.lead === "ops",
		JSON.stringify({ n: p2?.nextRemindN ?? null }),
	);

	// The Queue tab.
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await openPage("lr-browser", files.S);
	const line = await waitFor(async () => {
		const l = await page.evaluate(() => {
			const li = document.querySelector('li.task-queue-task[data-task-id="2"]');
			const lead = li?.querySelector(".task-queue-blocked-lead");
			const next = li?.querySelector(".task-queue-blocked-next");
			return lead
				? { lead: lead.getAttribute("data-lead"), text: lead.textContent ?? "", next: next?.textContent ?? "" }
				: null;
		});
		return l && /waits on ops/.test(l.text) && /reminds ops/.test(l.next) ? l : null;
	}, 20_000);
	check(
		"the Queue tab shows task #2 waiting on ops, what it owes, and when ops is reminded next",
		line?.lead === "ops" && line.text.includes(OWES[T2]),
		JSON.stringify({ shown: !!line }),
	);
	if (SHOTS) {
		mkdirSync(SHOTS, { recursive: true });
		await page
			.locator(".panel-right")
			.first()
			.screenshot({ path: join(SHOTS, "queue-lead-reminders.png") });
	}
	await page.context().close();

	check("no ask card anywhere (nothing went past the reminders)", seen.asks === 0, `${seen.asks}`);
	check("nothing unexpected reached the model", unexpected.length === 0, `${unexpected.length}`);
	check("no page errors", pageErrors.length === 0, `${pageErrors.length}`);
} catch (err) {
	console.log(`✗ FAIL: ${err instanceof Error ? err.message : String(err)}`);
	failures++;
} finally {
	release = true;
	W?.close();
	W2?.close();
	await browser?.close().catch(() => {});
	await srv.stop();
}
console.log(failures === 0 ? "queue-lead-reminders: all passed" : `queue-lead-reminders: ${failures} failed`);
process.exit(failures ? 1 : 0);
