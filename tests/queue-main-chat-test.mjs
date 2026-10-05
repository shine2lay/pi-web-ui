/* queue-main-chat E2E (no tokens): a queued task's question goes to its main chat first.
 *
 * A sealed test server with the real pi-queue (PI_QUEUE_PKG, default ~/projects/pi-queue), the mock
 * model, the Telegram plugin on a fake Telegram (PI_WEB_TELEGRAM_API_BASE) and plain WebSocket clients.
 * PI_QUEUE_TEST_FAST=1 and PI_QUEUE_TEST_ASK_WAIT_MS stand in for the 30 minutes a main chat has to
 * answer (pi-queue's test clock); its own tests check the real 30 minutes on a fake clock. The queue
 * chat (the main chat) plans five tasks; each runs in a chat of its own, one at a time:
 *   #1 asks; the main chat answers it: the task carries on with the answer ("[Queue] Answer from your
 *      main chat") and finishes, and the main chat's TL;DR says "Task #1 asked …; the main chat
 *      answered …", linking to the task's chat and not "needs you". While it asked, nothing said the
 *      user was needed: no Telegram ask, no needs-you line or notice, and its chat's row asking with no
 *      green light.
 *   #2 asks; the main chat passes it on in its own words: the task needs the user as before (its Queue
 *      tab shows the main chat's question and choices, a needs-you TL;DR line, the notice, a Telegram
 *      ask); the owner answers on Telegram and it finishes.
 *   #3 asks; the main chat's turn ends without a queue_reply: the question goes to the user at once,
 *      worded as the task asked it, plus why.
 *   #4 asks; the main chat's turn is still going when the wait is over: the question goes to the user
 *      then; that turn ending later changes nothing.
 *   #5: the owner stops the task's run: it needs the user straight away, and its main chat gets no card.
 * The mock's script checks what the chats get; nothing the model is sent is printed.
 *
 * Usage: npm run build && scripts/sealed.sh node tests/queue-main-chat-test.mjs
 *        PI_QUEUE_PKG=<pi-queue checkout> picks the pi-queue to load. QMC_DEBUG=1: server log.
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { textOf } from "./lib/mock-model.mjs";
import { ownServer } from "./lib/own-server.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PI_QUEUE = process.env.PI_QUEUE_PKG ?? join(userInfo().homedir, "projects", "pi-queue");
if (!existsSync(join(PI_QUEUE, "package.json"))) {
	console.log(`✗ FAIL: pi-queue not found at ${PI_QUEUE} (set PI_QUEUE_PKG)`);
	process.exit(1);
}

/** Made-up Telegram ids and token: the fake Telegram is all this test talks to. */
const OWNER = 424242002;
const TOKEN = "700000002:TEST-main-chat-not-a-real-token";
const WEB = "https://pi.test.example:8787/";
/** How long the main chat has to answer, in this test (pi-queue's PI_QUEUE_TEST_ASK_WAIT_MS). */
const ASK_WAIT_MS = 6000;

const plan = (title, goal) => ({
	title,
	goal,
	done_when: "The page shows the chosen value",
	decided: "Ask which value first, then change only that",
	steps: "1. Ask which value\n2. Change it\n3. Look at the page",
	verify: "Open the page and look at it",
	must_not: "Touch anything else on the page",
});
const PLANS = [
	plan("Pick the port", "The dev server listens on the agreed port"),
	plan("Pick the label", "The settings button's label matches the page it opens"),
	plan("Pick the colour", "The banner has the agreed colour"),
	plan("Pick the font", "The page uses the agreed font"),
	plan("Clean the logs", "Old log files are gone"),
];
/** Each task's own question and answers (#1-#4 ask; #5 is stopped by the owner instead). */
const ASKS = {
	1: { question: "Which port should the dev server use?", choices: ["8080", "9090"] },
	2: { question: "Which label should the button use?", choices: ["Settings", "Preferences"] },
	3: { question: "Which colour should the banner be?", choices: ["Blue", "Green"] },
	4: { question: "Which font should the page use?", choices: ["Inter", "Roboto"] },
};
const MAIN_ANSWER = "Use 8080: it is the project's default port.";
const PASS_QUESTION = "The settings button needs a label: Settings or Preferences?";
const PASS_CHOICES = ["Settings (recommended)", "Preferences"];
const STOPPED = "You stopped this task's run. Reply here to carry on.";

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
			if (await fn()) return true;
		} catch {
			/* not yet */
		}
		await sleep(100);
	}
	return false;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- the fake Telegram (what telegram-answers-test.mjs uses, cut down) --------------------------
function fakeTelegram(token) {
	const messages = new Map();
	const updates = [];
	const calls = [];
	let nextUpdate = 1000;
	let nextMessage = 100;
	let nextCallback = 1;
	let waiters = [];
	const wake = () => {
		const w = waiters;
		waiters = [];
		for (const f of w) f();
	};
	const reply = (res, code, body) => {
		if (res.writableEnded || res.destroyed) return;
		res.writeHead(code, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const c of req) body += c;
		const m = /^\/bot([^/]+)\/(\w+)$/.exec(new URL(req.url ?? "/", "http://x").pathname);
		if (!m || m[1] !== token) return reply(res, 401, { ok: false, error_code: 401, description: "Unauthorized" });
		let params = {};
		try {
			params = body ? JSON.parse(body) : {};
		} catch {
			return reply(res, 400, { ok: false, error_code: 400, description: "Bad Request" });
		}
		calls.push(m[2]);
		const ok = (result) => reply(res, 200, { ok: true, result });
		const msg = messages.get(Number(params.message_id));
		switch (m[2]) {
			case "getMe":
				return ok({ id: Number(token.split(":")[0]), is_bot: true, first_name: "pi test", username: "pi_test_bot" });
			case "getUpdates": {
				const offset = Number(params.offset ?? 0);
				const ready = () => updates.filter((u) => u.update_id >= offset);
				let closed = false;
				res.on("close", () => {
					closed = true;
				});
				const deadline = Date.now() + 1500;
				while (!closed && ready().length === 0 && Date.now() < deadline) {
					await new Promise((r) => {
						waiters.push(r);
						setTimeout(r, 200);
					});
				}
				return ok(ready());
			}
			case "sendMessage": {
				const id = nextMessage++;
				messages.set(id, { id, text: String(params.text ?? ""), markup: params.reply_markup ?? null, deleted: false });
				return ok({ message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: Number(params.chat_id) } });
			}
			case "editMessageText":
				if (!msg) return reply(res, 400, { ok: false, error_code: 400, description: "Bad Request: not found" });
				msg.text = String(params.text ?? "");
				msg.markup = params.reply_markup ?? null;
				return ok(true);
			case "editMessageReplyMarkup":
				if (!msg) return reply(res, 400, { ok: false, error_code: 400, description: "Bad Request: not found" });
				msg.markup = params.reply_markup ?? null;
				return ok(true);
			case "deleteMessage":
				if (msg) msg.deleted = true;
				return ok(true);
			default:
				return ok(true);
		}
	});
	return {
		calls,
		messages,
		async start() {
			await new Promise((r) => server.listen(0, "127.0.0.1", r));
			return `http://127.0.0.1:${server.address().port}`;
		},
		close: () => {
			wake();
			server.closeAllConnections?.();
			server.close();
		},
		/** Tap a button on a message (the owner, in a private chat with the bot). */
		tap(msg, label) {
			const buttons = (msg.markup?.inline_keyboard ?? []).flat();
			const button = buttons.find((b) => b.text === label) ?? buttons.find((b) => b.text.includes(label));
			if (!button) throw new Error(`no button "${label}" on message ${msg.id}`);
			const chat = { id: OWNER, type: "private", first_name: "x" };
			updates.push({
				update_id: nextUpdate++,
				callback_query: {
					id: `cb-${nextCallback++}`,
					from: { id: OWNER, is_bot: false, first_name: "Owner" },
					chat_instance: "ci-1",
					data: button.callback_data,
					message: { message_id: msg.id, date: Math.floor(Date.now() / 1000), chat, text: msg.text },
				},
			});
			wake();
		},
		/** Every message the bot sent (deleted ones too: a deleted ask still reached the owner). */
		all: () => [...messages.values()],
		async waitMessage(pred, ms = 20_000) {
			let found = null;
			await waitFor(() => (found = [...messages.values()].reverse().find((x) => !x.deleted && pred(x)) ?? null), ms);
			return found;
		},
	};
}
const labels = (msg) => (msg?.markup?.inline_keyboard ?? []).flat().map((b) => b.text);

// ---- the mock model ------------------------------------------------------------------------------
/** What the chats got, by script step (kept here, never printed). */
const seen = { cards: new Map(), answers: new Map(), stuckResults: new Map(), replies: new Map() };
/** Messages the mock had no script for: should stay empty (only what they were, never their text). */
const unexpected = [];
/** #5's run waits here until the owner has stopped it. */
let releaseRun5 = () => {};
const run5Held = new Promise((r) => {
	releaseRun5 = r;
});

async function modelReply({ payload, sideRequest }) {
	if (sideRequest) return "Main chat test";
	const history = Array.isArray(payload.messages) ? payload.messages : [];
	const users = [];
	history.forEach((m, i) => {
		if (m.role === "user" && !/^\(System reminder/.test(textOf(m))) users.push(i);
	});
	const first = users[0] ?? -1;
	const kick = first >= 0 ? textOf(history[first]).match(/^\[Queue\] Task #(\d+): /) : null;
	// In the queue's chat, the queue's notes ("[Queue] Task #2 (...) needs the user ...") can land in the
	// middle of a turn, after a tool result; that turn is still about the card (or the plan) before them.
	const isNote = (i) => !kick && /^\[Queue\] Task #\d+ \(/.test(textOf(history[i]));
	const anchors = users.filter((i) => !isNote(i));
	const last = anchors.at(-1) ?? -1;
	const userText = last >= 0 ? textOf(history[last]) : "";
	const results = history
		.slice(last + 1)
		.filter((m) => m.role === "tool")
		.map(textOf);
	const step = results.length;
	let m;
	if (!kick) {
		// The queue's chat: the main chat.
		if (userText.startsWith("MC-PLAN")) {
			if (step < PLANS.length) return { tool: "queue_add", args: PLANS[step] };
			return "MC-PLANNED";
		}
		if ((m = /^\[Queue\] Task #(\d+) asks\b/.exec(userText))) {
			const id = Number(m[1]);
			if (step === 0) seen.cards.set(id, (seen.cards.get(id) ?? 0) + 1);
			if (id === 1) {
				if (step === 0) {
					await sleep(4000); // long enough to look at #1 while it asks
					return { tool: "queue_reply", args: { id: 1, answer: MAIN_ANSWER } };
				}
				seen.replies.set(1, results[0]);
				return "MC-ANSWERED-1";
			}
			if (id === 2) {
				if (step === 0) {
					await sleep(2500);
					return { tool: "queue_reply", args: { id: 2, question: PASS_QUESTION, choices: PASS_CHOICES } };
				}
				seen.replies.set(2, results[0]);
				return "MC-PASSED-2";
			}
			if (id === 3) {
				await sleep(1500);
				return "MC-NOT-SURE-3"; // ends its turn without a queue_reply
			}
			if (id === 4) {
				await sleep(ASK_WAIT_MS + 4000); // still going when the wait is over
				seen.late4 = Date.now();
				return "MC-LATE-4";
			}
		}
		unexpected.push(`queue chat: ${userText.startsWith("[Queue]") ? "a queue message" : "a user message"}`);
		return "MC-OTHER ok.";
	}
	const id = Number(kick[1]);
	if (last === first) {
		// The task's kickoff turn.
		if (id === 5) {
			if (step === 0) {
				seen.run5Started = Date.now();
				await Promise.race([run5Held, new Promise((r) => setTimeout(r, 90_000).unref())]);
				return "MC-NEVER-5";
			}
		} else if (ASKS[id]) {
			if (step === 0) return { tool: "queue_stuck", args: ASKS[id] };
			seen.stuckResults.set(id, results[0]);
			return `MC-ASKED-${id}`;
		}
	} else if (step === 0) {
		seen.answers.set(id, userText);
		return { tool: "queue_done", args: { summary: `Task ${id} used the answer it got` } };
	} else {
		return `MC-DONE-${id}`;
	}
	unexpected.push(`task #${id}: a message`);
	return "MC-OTHER ok.";
}

// ---- a browser window, as a WebSocket client ------------------------------------------------------
class Client {
	constructor(ws, name) {
		this.ws = ws;
		this.name = name;
		this.received = [];
		this.state = null;
		/** The chat list as last sent. */
		this.convs = [];
		/** Plan pop-ups already approved, by id. */
		this.approved = new Set();
		/** Called with the state after each message (the test notes when each task changed status). */
		this.onState = null;
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			if (message.type === "snapshot") this.state = message.state;
			else if (message.type === "snapshot_delta") {
				if (this.state && this.state.rev === message.baseRev && message.conversationId === this.state.conversationId)
					this.state = { ...this.state, ...message.state };
				else this.send({ type: "get_state" });
			} else if (message.type === "conversations" && Array.isArray(message.conversations)) {
				this.convs = message.conversations;
			}
			// The owner approves each plan (the pop-up is part of the chat's state).
			const dialog = this.state?.dialog;
			if (dialog?.kind === "confirm" && dialog.title === "Add to the queue?" && !this.approved.has(dialog.id)) {
				this.approved.add(dialog.id);
				this.send({ type: "dialog_response", id: dialog.id, value: true });
			}
			if (this.state) this.onState?.(this.state);
		});
	}
	send(message) {
		if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
	}
	async waitForType(type, pred = () => true, ms = 20_000) {
		let found = null;
		await waitFor(() => (found = this.received.find((m) => m.type === type && pred(m))), ms);
		if (!found) throw new Error(`[${this.name}] no ${type} within ${ms} ms`);
		return found;
	}
	async waitForState(pred, ms = 20_000) {
		if (!(await waitFor(() => this.state && pred(this.state), ms)))
			throw new Error(`[${this.name}] state never matched`);
		return this.state;
	}
	close() {
		this.ws.close();
	}
}

// ---- run -------------------------------------------------------------------------------------------
const tg = fakeTelegram(TOKEN);
const tgBase = await tg.start();
const srv = await ownServer({
	name: "queue-main-chat",
	mock: modelReply,
	env: {
		PI_WEB_TELEGRAM_API_BASE: tgBase,
		PI_WEB_TOKEN: "",
		PI_QUEUE_TEST_FAST: "1",
		PI_QUEUE_TEST_ASK_WAIT_MS: String(ASK_WAIT_MS),
	},
	verbose: !!process.env.QMC_DEBUG,
	prepare: async ({ dataDir, agentDir }) => {
		cpSync(join(REPO, "plugins", "telegram"), join(dataDir, "plugins", "telegram"), { recursive: true });
		const file = join(agentDir, "settings.json");
		const settings = JSON.parse(readFileSync(file, "utf8"));
		writeFileSync(
			file,
			JSON.stringify(
				{ ...settings, defaultProvider: "mock", defaultModel: "mock-model", packages: [PI_QUEUE] },
				null,
				2,
			),
		);
		// This test is about questions: the watchdog stays off.
		writeFileSync(join(agentDir, "pi-queue.json"), JSON.stringify({ stalledAfterMinutes: 0 }));
	},
});
const hardStop = setTimeout(() => {
	console.log("✗ FAIL: the test took too long");
	process.exit(1);
}, 300_000);
hardStop.unref();

async function openClient(clientId) {
	const ws = new WebSocket(srv.ws);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const c = new Client(ws, clientId);
	c.send({ type: "hello", clientId, locale: "en" });
	await c.waitForType("ready");
	c.send({ type: "get_state" });
	await c.waitForState((s) => Boolean(s.conversationId));
	return c;
}
async function waitIdle(c) {
	await sleep(300);
	await c.waitForState((s) => !s.isStreaming, 30_000);
}

let A = null;
let B = null;
try {
	A = await openClient("mc-window-a");
	A.send({ type: "set_model", modelId: "mock/mock-model" });
	await A.waitForState((s) => s.model?.id === "mock-model");
	A.send({
		type: "plugin_settings",
		pluginId: "telegram",
		values: { enabled: true, botToken: TOKEN, ownerId: String(OWNER), webAppAddress: WEB },
	});
	await A.waitForType("notice", (m) => /Plugin settings saved|插件设置已保存/.test(m.text ?? ""));
	if (!(await waitFor(() => tg.calls.includes("getUpdates"), 15_000)))
		throw new Error("the Telegram plugin never polled");

	const task = (id) => A.state?.taskQueue?.tasks?.find((t) => t.id === id);
	const row = (id) => {
		const file = task(id)?.chat?.file;
		return file ? A.convs.find((c) => c.sessionPath === file || c.sessionFile === file) : undefined;
	};
	const tldr = () => A.state?.tldr ?? [];
	const telegramAbout = (text) => tg.all().filter((x) => x.text.includes(text));
	/** When a task first showed each status in window A. */
	const firstSeen = new Map();
	A.onState = (s) => {
		for (const t of s.taskQueue?.tasks ?? []) {
			const key = `${t.id}:${t.status}`;
			if (!firstSeen.has(key)) firstSeen.set(key, Date.now());
		}
	};
	/** The notices window A (on the queue's chat) got that say a task needs the user. */
	const needsYouNotices = (id) =>
		A.received.filter((m) => m.type === "notice" && String(m.text ?? "").startsWith(`Task #${id} needs you`));

	console.log("the queue chat plans five tasks (the owner approves each)");
	A.send({ type: "prompt", text: "MC-PLAN five tasks" });
	check(
		"all five are queued",
		await waitFor(() => A.state?.taskQueue?.tasks?.length === PLANS.length, 30_000),
		JSON.stringify(A.state?.taskQueue?.tasks?.map((t) => [t.id, t.status])),
	);
	await waitIdle(A);
	A.send({ type: "task_queue_command", action: "start", conversationId: A.state.conversationId });

	// ---- #1: the main chat answers -------------------------------------------------------------------
	console.log("#1 asks; the main chat answers it");
	check(
		"#1 asks its main chat: the Queue tab says it asks, with its question and no needs-you",
		await waitFor(
			() =>
				task(1)?.status === "asking" &&
				task(1)?.question === ASKS[1].question &&
				same(task(1)?.choices, ASKS[1].choices),
			30_000,
		),
		JSON.stringify(task(1)),
	);
	check("the main chat got one card for it", await waitFor(() => seen.cards.get(1) === 1, 10_000));
	check(
		"while it asks, its chat's row says so, with no green light and no needs-you",
		await waitFor(() => {
			const r = row(1);
			return (
				task(1)?.status === "asking" && r?.queueAsking === true && !r.isStreaming && !r.waiting && !r.tldr?.needsYou
			);
		}, 3500),
		JSON.stringify(row(1) ? { ...row(1), title: undefined } : null),
	);
	check(
		"... and the main chat's TL;DR has no needs-you line for it",
		!tldr().some((l) => l.needsYou && l.text.startsWith("Task #1")),
	);
	check(
		"#1 carries on with the main chat's answer and finishes",
		await waitFor(() => task(1)?.status === "done", 30_000),
		JSON.stringify(task(1)),
	);
	const got1 = seen.answers.get(1) ?? "";
	check(
		'its chat got the answer as "[Queue] Answer from your main chat", quoting its question',
		got1.startsWith("[Queue] Answer from your main chat") &&
			got1.includes(ASKS[1].question) &&
			got1.includes(MAIN_ANSWER),
	);
	check(
		"queue_reply told the main chat the answer got there",
		(seen.replies.get(1) ?? "").startsWith("Answered: task #1's chat got your answer"),
	);
	const line1 = `Task #1 asked: ${ASKS[1].question}; the main chat answered: ${MAIN_ANSWER}`;
	check(
		'the main chat\'s TL;DR says "Task #1 asked …; the main chat answered …", linking to its chat, not needs-you',
		await waitFor(
			() => tldr().some((l) => l.text === line1 && !l.needsYou && l.chat?.file === task(1)?.chat?.file),
			10_000,
		),
		JSON.stringify(tldr().map((l) => [l.text, l.needsYou])),
	);
	check("#1's question never reached Telegram", telegramAbout(ASKS[1].question).length === 0);
	check("... and no notice said #1 needs the user", needsYouNotices(1).length === 0);

	// ---- #2: the main chat passes it on --------------------------------------------------------------
	console.log("#2 asks; the main chat passes it on to the owner in its own words");
	check("#2 asks its main chat", await waitFor(() => task(2)?.status === "asking", 30_000), JSON.stringify(task(2)));
	check(
		"it needs the owner, with the main chat's question and choices",
		await waitFor(
			() => task(2)?.status === "stuck" && task(2)?.question === PASS_QUESTION && same(task(2)?.choices, PASS_CHOICES),
			20_000,
		),
		JSON.stringify(task(2)),
	);
	check(
		"queue_reply told the main chat it was passed on",
		(seen.replies.get(2) ?? "").startsWith("Passed on: the user sees task #2's question"),
	);
	check(
		"the main chat's TL;DR has a needs-you line for it, linking to its chat",
		await waitFor(
			() =>
				tldr().some(
					(l) => l.text === `Task #2 needs you: ${PASS_QUESTION}` && l.needsYou && l.chat?.file === task(2)?.chat?.file,
				),
			10_000,
		),
		JSON.stringify(tldr().map((l) => [l.text, l.needsYou])),
	);
	check(
		"the queue's chat shows the notice, in the main chat's words",
		await waitFor(
			() => needsYouNotices(2).length === 1 && needsYouNotices(2)[0].text === `Task #2 needs you: ${PASS_QUESTION}`,
			10_000,
		),
		JSON.stringify(needsYouNotices(2).map((m) => m.text)),
	);
	check(
		"its chat's row is no longer asking",
		await waitFor(() => !!row(2) && !row(2).queueAsking, 10_000),
		JSON.stringify(row(2) ? { queueAsking: row(2).queueAsking } : null),
	);
	const m2 = await tg.waitMessage(
		(x) => x.text.includes("Task #2 needs you") && x.text.includes(PASS_QUESTION),
		30_000,
	);
	check(
		"the owner gets a Telegram ask in the main chat's words, with its choices",
		!!m2 && PASS_CHOICES.every((c) => labels(m2).some((l) => l.includes(c))),
		m2 ? labels(m2).join(" | ") : "no message",
	);
	check("the task's own wording never reached Telegram", telegramAbout(ASKS[2].question).length === 0);
	if (m2) tg.tap(m2, PASS_CHOICES[0]);
	check(
		"the owner's answer on Telegram goes into #2's chat, and it finishes",
		(await waitFor(() => task(2)?.status === "done", 30_000)) && seen.answers.get(2) === PASS_CHOICES[0],
		JSON.stringify(task(2)),
	);

	// ---- #3: the main chat's turn ends without an answer ---------------------------------------------
	console.log("#3 asks; the main chat's turn ends without a queue_reply");
	check("#3 asks its main chat", await waitFor(() => task(3)?.status === "asking", 30_000), JSON.stringify(task(3)));
	check(
		"the question goes to the owner as the task asked it, plus why",
		await waitFor(
			() =>
				task(3)?.status === "stuck" &&
				task(3)?.question?.startsWith(ASKS[3].question) &&
				task(3)?.question?.includes("your main chat ended its turn without answering it") &&
				same(task(3)?.choices, ASKS[3].choices),
			20_000,
		),
		JSON.stringify(task(3)),
	);
	const asked3 = firstSeen.get("3:asking") ?? 0;
	const stuck3 = firstSeen.get("3:stuck") ?? 0;
	check(
		"... at once when that turn ended, not after the wait",
		stuck3 > asked3 && stuck3 - asked3 < ASK_WAIT_MS - 1000,
		`${stuck3 - asked3} ms`,
	);
	check(
		"the TL;DR and Telegram say #3 needs the owner",
		(await waitFor(
			() => tldr().some((l) => l.needsYou && l.text.startsWith(`Task #3 needs you: ${ASKS[3].question}`)),
			10_000,
		)) &&
			!!(await tg.waitMessage(
				(x) => x.text.includes("Task #3 needs you") && x.text.includes(ASKS[3].question),
				30_000,
			)),
	);
	A.send({ type: "task_queue_answer", conversationId: A.state.conversationId, taskId: 3, text: "Blue" });
	check(
		"the owner's answer goes into #3's chat, and it finishes",
		(await waitFor(() => task(3)?.status === "done", 30_000)) && seen.answers.get(3) === "Blue",
		JSON.stringify(task(3)),
	);

	// ---- #4: no answer in time ---------------------------------------------------------------------------
	console.log("#4 asks; the main chat's turn is still going when the wait is over");
	check("#4 asks its main chat", await waitFor(() => task(4)?.status === "asking", 30_000), JSON.stringify(task(4)));
	check(
		"the question goes to the owner when the wait is over, with why",
		await waitFor(
			() =>
				task(4)?.status === "stuck" &&
				task(4)?.question?.startsWith(ASKS[4].question) &&
				task(4)?.question?.includes("your main chat didn't answer it within"),
			ASK_WAIT_MS + 15_000,
		),
		JSON.stringify(task(4)),
	);
	const asked4 = firstSeen.get("4:asking") ?? 0;
	const stuck4 = firstSeen.get("4:stuck") ?? 0;
	check(
		"... not before the wait, and while the main chat's turn still went on",
		stuck4 - asked4 >= ASK_WAIT_MS - 500 && !seen.late4,
		`${stuck4 - asked4} ms, turn ended: ${!!seen.late4}`,
	);
	check("that turn ends later", await waitFor(() => !!seen.late4, ASK_WAIT_MS + 10_000));
	await waitIdle(A);
	await sleep(1500);
	check(
		"... and changes nothing: #4 still needs the owner, asked once on Telegram",
		task(4)?.status === "stuck" &&
			task(4)?.question?.includes("didn't answer it within") &&
			telegramAbout(ASKS[4].question).length === 1,
		`${JSON.stringify(task(4))} telegram: ${telegramAbout(ASKS[4].question).length}`,
	);
	A.send({ type: "task_queue_answer", conversationId: A.state.conversationId, taskId: 4, text: "Inter" });
	check(
		"the owner's answer goes into #4's chat, and it finishes",
		(await waitFor(() => task(4)?.status === "done", 30_000)) && seen.answers.get(4) === "Inter",
		JSON.stringify(task(4)),
	);

	// ---- #5: the owner stops the run -----------------------------------------------------------------
	console.log("#5: the owner stops the task's run");
	check("#5's run is going", await waitFor(() => !!seen.run5Started && task(5)?.status === "working", 30_000));
	const file5 = task(5)?.chat?.file;
	B = await openClient("mc-window-b");
	// The owner opens #5's chat (the same conversation the queue runs) and stops its run.
	B.send({ type: "switch_session", path: file5 });
	await B.waitForState((s) => s.sessionFile === file5 && s.isStreaming, 15_000);
	B.send({ type: "abort" });
	check(
		"it needs the owner straight away, as before",
		await waitFor(() => task(5)?.status === "stuck" && task(5)?.question === STOPPED, 15_000),
		JSON.stringify(task(5)),
	);
	releaseRun5();
	check(
		"the TL;DR and Telegram say #5 needs the owner",
		(await waitFor(() => tldr().some((l) => l.needsYou && l.text.startsWith("Task #5 needs you")), 10_000)) &&
			!!(await tg.waitMessage((x) => x.text.includes("Task #5 needs you"), 30_000)),
	);
	check("its main chat got no card for it", !seen.cards.has(5) && firstSeen.get("5:asking") === undefined);
	B.close();
	B = null;
	A.send({ type: "task_queue_answer", conversationId: A.state.conversationId, taskId: 5, text: "Carry on" });
	check(
		"the owner's answer carries #5 on, and it finishes",
		(await waitFor(() => task(5)?.status === "done", 30_000)) && seen.answers.get(5) === "Carry on",
		JSON.stringify(task(5)),
	);

	check(
		"one card each for #1-#4 in the main chat",
		same(
			[1, 2, 3, 4].map((id) => seen.cards.get(id)),
			[1, 1, 1, 1],
		),
		JSON.stringify([...seen.cards]),
	);
	check(
		"each asking task's queue_stuck said it asked its main chat",
		[1, 2, 3, 4].every((id) => (seen.stuckResults.get(id) ?? "").startsWith("Asked your main chat")),
	);
	check("the model saw no message it had no script for", unexpected.length === 0, unexpected.join(" | "));
} catch (e) {
	failures++;
	console.log(`✗ FAIL: ${e?.message ?? e}`);
	if (process.env.QMC_DEBUG) console.log(srv.stderr().slice(-3000));
} finally {
	releaseRun5();
	B?.close();
	A?.close();
	await srv.stop();
	tg.close();
}
console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
process.exit(failures ? 1 : 0);
