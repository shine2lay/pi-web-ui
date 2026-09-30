/**
 * telegram-answers (sealed, zero tokens): what a chat waits on reaches the owner on Telegram at once,
 * and a tap or a reply there answers the chat. A fake Telegram stands in for api.telegram.org
 * (PI_WEB_TELEGRAM_API_BASE), the mock model for the model, and plain WebSocket clients for the
 * browser. The real plugin (plugins/telegram) is installed into the server's own data folder.
 *
 *  1. a question: it's sent with its choices as buttons, a one-line head with the chat it's from,
 *     the question in bold, its choices apart under a "CHOICES" line and numbered like their
 *     buttons, and under a line a footer with the folder and a link to the chat; a stranger's tap
 *     and text, and the owner writing in a group, are ignored; the owner's tap answers the chat,
 *     closes the browser's dialog and shrinks the message to one line
 *     ("\u2705 Colour \u00B7 <chat>: Blue (on Telegram)");
 *  2. a question answered in the browser: its message shrinks to one line too, and its old buttons
 *     only say "No longer waiting.";
 *  3. permission prompts: Approve on Telegram runs the command, Deny doesn't; one answered in the
 *     browser shrinks its message to one line;
 *  4. the queue: a plan's approval pop-up (its markdown shown as formatting) is answered on
 *     Telegram; the task's own chat (no browser on it) asks permission, then gets stuck with
 *     choices ("Task #1 needs you"); both are answered on Telegram; the answer goes into the task's
 *     chat and the task finishes;
 *  5. no browser open at all: a question outlives the 30 s no-browser wait and, like the permission
 *     prompt after it, is answered on Telegram;
 *  6. the bot token is in no file the server wrote.
 *
 * Usage: npm run build && scripts/sealed.sh node tests/telegram-answers-test.mjs
 *        PI_QUEUE_PKG=<pi-queue checkout> picks the pi-queue to load (default ~/projects/pi-queue).
 */
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
const OWNER = 424242001;
const STRANGER = 555000111;
const TOKEN = "700000001:TEST-secret-part-not-a-real-token";
const TOKEN_SECRET = TOKEN.split(":")[1];
const WEB = "https://pi.test.example:8787/";
const TYPE_ANSWER = "\u270F\uFE0F Type an answer";
/** The line over a question's listed choices, and the one over the footer. */
const CHOICES_LINE = `\u2500\u2500 CHOICES ${"\u2500".repeat(8)}`;
const RULE = "\u2500".repeat(18);
const NO_BROWSER_GRACE_MS = 30_000; // server/ask-delivery.ts ASK_USER_NO_CLIENT_GRACE_MS

const PLAN = {
	title: "Pick the button label",
	goal: "The settings button's label matches the page it opens",
	done_when: "The button reads the chosen label",
	decided: "Ask which label first",
	steps: "1. Ask which label\n2. Rename the button",
	verify: "Look at the page",
	must_not: "Touch other buttons",
};
const STUCK_QUESTION = "Which label should the button use?";
const CHOICES = ["Settings", "Preferences"];

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

// ---- the fake Telegram ------------------------------------------------------
function fakeTelegram(token) {
	const calls = [];
	const messages = new Map();
	const updates = [];
	const wrongToken = [];
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
		if (!m) return reply(res, 404, { ok: false, error_code: 404, description: "Not Found" });
		if (m[1] !== token) {
			wrongToken.push(m[2]);
			return reply(res, 401, { ok: false, error_code: 401, description: "Unauthorized" });
		}
		const method = m[2];
		let params = {};
		try {
			params = body ? JSON.parse(body) : {};
		} catch {
			return reply(res, 400, { ok: false, error_code: 400, description: "Bad Request: can't parse JSON" });
		}
		calls.push({ method, params, at: Date.now() });
		const ok = (result) => reply(res, 200, { ok: true, result });
		const msg = messages.get(Number(params.message_id));
		switch (method) {
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
				const markup = params.reply_markup ?? null;
				messages.set(id, {
					id,
					chatId: String(params.chat_id),
					text: String(params.text ?? ""),
					markup,
					firstMarkup: markup,
					replyTo: params.reply_parameters?.message_id ?? null,
					deleted: false,
				});
				return ok({
					message_id: id,
					date: Math.floor(Date.now() / 1000),
					chat: { id: Number(params.chat_id), type: "private" },
					text: params.text,
				});
			}
			case "editMessageText":
				if (!msg)
					return reply(res, 400, { ok: false, error_code: 400, description: "Bad Request: message to edit not found" });
				msg.text = String(params.text ?? "");
				msg.markup = params.reply_markup ?? null;
				return ok(true);
			case "editMessageReplyMarkup":
				if (!msg)
					return reply(res, 400, { ok: false, error_code: 400, description: "Bad Request: message to edit not found" });
				msg.markup = params.reply_markup ?? null;
				return ok(true);
			case "deleteMessage":
				if (msg) msg.deleted = true;
				return ok(true);
			default:
				return ok(true);
		}
	});
	const push = (update) => {
		const u = { update_id: nextUpdate++, ...update };
		updates.push(u);
		wake();
		return u.update_id;
	};
	const person = (id) => ({ id, is_bot: false, first_name: id === OWNER ? "Owner" : "Someone" });
	const privateChat = (id) => ({ id, type: "private", first_name: "x" });
	return {
		calls,
		messages,
		wrongToken,
		async start() {
			await new Promise((r) => server.listen(0, "127.0.0.1", r));
			return `http://127.0.0.1:${server.address().port}`;
		},
		close: () => {
			wake();
			server.closeAllConnections?.();
			server.close();
		},
		/** Tap a button on a message (`stale`: as it looked when it was sent). Returns the callback id. */
		tap(msg, label, { from = OWNER, chat = privateChat(from), stale = false } = {}) {
			const buttons = ((stale ? msg.firstMarkup : msg.markup)?.inline_keyboard ?? []).flat();
			const button = buttons.find((b) => b.text === label) ?? buttons.find((b) => b.text.includes(label));
			if (!button)
				throw new Error(`no button "${label}" on message ${msg.id}: ${buttons.map((b) => b.text).join(" | ")}`);
			const id = `cb-${nextCallback++}`;
			const updateId = push({
				callback_query: {
					id,
					from: person(from),
					chat_instance: "ci-1",
					data: button.callback_data,
					message: { message_id: msg.id, date: Math.floor(Date.now() / 1000), chat, text: msg.text },
				},
			});
			return { id, updateId };
		},
		/** A text message to the bot, optionally a reply to one of its messages. */
		say(text, { from = OWNER, chat = privateChat(from), replyTo } = {}) {
			return push({
				message: {
					message_id: 5000 + nextUpdate,
					date: Math.floor(Date.now() / 1000),
					from: person(from),
					chat,
					text,
					...(replyTo ? { reply_to_message: { message_id: replyTo, date: 0, chat } } : {}),
				},
			});
		},
		/** The newest message the bot sent that matches. */
		find(pred) {
			return [...messages.values()].reverse().find((m) => !m.deleted && pred(m)) ?? null;
		},
		async waitMessage(pred, ms = 20_000) {
			let found = null;
			await waitFor(() => (found = this.find(pred)), ms);
			return found;
		},
		callbackAnswer: (id) =>
			calls.find((c) => c.method === "answerCallbackQuery" && c.params.callback_query_id === id) ?? null,
		/** The plugin has fetched past this update (it polls again only after handling what it got). */
		consumed: (updateId) => calls.some((c) => c.method === "getUpdates" && Number(c.params.offset) > updateId),
		apiCalls: () => calls.filter((c) => c.method !== "getUpdates").length,
	};
}
const labels = (msg) => (msg?.markup?.inline_keyboard ?? []).flat().map((b) => b.text);
const noButtons = (msg) => labels(msg).length === 0;
/** The buttons' labels without the numbers they carry when the text lists the choices. */
const bare = (msg) => labels(msg).map((l) => l.replace(/^\d+ \u00B7 /, ""));
/** The choices' buttons are numbered like the text's list of them when it has one, and not otherwise. */
const numberedRight = (msg) => {
	const opts = labels(msg).filter((l) => l !== TYPE_ANSWER && !l.startsWith("\u2705"));
	return msg.text.includes(CHOICES_LINE)
		? opts.every((l, i) => l.startsWith(`${i + 1} \u00B7 `) && msg.text.includes(`<b>${l}</b>`))
		: opts.every((l) => !/^\d+ \u00B7 /.test(l));
};
/**
 * A message's final words: one line, "\u2705 <title, linking to the chat> \u00B7 <what>: ...<end>".
 * `what` is the chat's title (any, when not given) or, for a queued task, the task's title.
 */
const oneLineFinal = (msg, title, end, what = null) => {
	const t = msg?.text ?? "";
	const whatRe = what === null ? "[^<]+" : what.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const head = new RegExp(`^\\u2705 <a href="[^"]+">${title.replace(/[?]/g, "\\?")}</a> \\u00B7 <i>${whatRe}</i>: `);
	return !t.includes("\n") && head.test(t) && t.endsWith(end);
};

// ---- the mock model ------------------------------------------------------------
/** What the model saw come back, by script step (tool results and answers). */
const seen = {};
/** User messages the mock had no script for: should stay empty. */
const unexpected = [];
async function modelReply({ payload, sideRequest }) {
	if (sideRequest) return "Telegram test chat";
	const history = Array.isArray(payload.messages) ? payload.messages : [];
	const users = [];
	history.forEach((m, i) => {
		if (m.role === "user" && !/^\(System reminder/.test(textOf(m))) users.push(i);
	});
	const first = users[0] ?? -1;
	const last = users.at(-1) ?? -1;
	const userText = last >= 0 ? textOf(history[last]) : "";
	const results = history
		.slice(last + 1)
		.filter((m) => m.role === "tool")
		.map(textOf);
	const step = results.length;
	const kick = first >= 0 ? textOf(history[first]).match(/^\[Queue\] Task #(\d+): ([^\n]+)/) : null;
	let m;
	if ((m = /^TG-ASK (\d+)/.exec(userText))) {
		if (step === 0)
			return {
				tool: "ask_user_question",
				args: {
					questions: [
						{
							id: "colour",
							header: "Colour",
							question: `Which colour, round ${m[1]}?`,
							options: [{ label: "Red", description: "warm" }, { label: "Blue" }],
						},
					],
				},
			};
		seen[`ask ${m[1]}`] = results[0];
		return `ANSWERED ${m[1]}`;
	}
	if ((m = /^TG-RUN (\d+)/.exec(userText))) {
		// The output differs from the command's text: it shows only if the command ran.
		if (step === 0)
			return { tool: "bash", args: { command: `rm -rf ./tg-gone-${m[1]} && echo TG-RAN-$((100+${m[1]}))` } };
		seen[`run ${m[1]}`] = results[0];
		return `RAN ${m[1]}`;
	}
	if (userText.startsWith("TG-PLAN")) {
		if (step === 0) return { tool: "queue_add", args: PLAN };
		seen.plan = results[0];
		return "TG-PLANNED";
	}
	if (kick && last === first) {
		// The task's own chat: ask permission, then get stuck with choices.
		if (step === 0) return { tool: "bash", args: { command: "rm -rf ./tg-task-gone && echo TG-RAN-$((200+1))" } };
		if (step === 1) {
			seen.taskRun = results[0];
			return { tool: "queue_stuck", args: { question: STUCK_QUESTION, choices: CHOICES } };
		}
		seen.stuck = results[1];
		return "TG-TASK-ASKED";
	}
	if (kick) {
		if (step === 0) {
			seen.taskAnswer = userText;
			return { tool: "queue_done", args: { summary: `Used ${userText}` } };
		}
		return "TG-TASK-DONE";
	}
	if (userText.startsWith("TG-QUIET")) {
		if (step === 0) {
			// Ask only once the browser has gone.
			await sleep(1500);
			return {
				tool: "ask_user_question",
				args: {
					questions: [
						{ id: "size", header: "Size", question: "Which size?", options: [{ label: "Small" }, { label: "Large" }] },
					],
				},
			};
		}
		if (step === 1) {
			seen.quietAsk = results[0];
			return { tool: "bash", args: { command: "rm -rf ./tg-quiet-gone && echo TG-RAN-$((300+1))" } };
		}
		seen.quietRun = results[1];
		return "TG-QUIET-DONE";
	}
	unexpected.push(userText.slice(0, 80));
	return "TG-OTHER ok.";
}

// ---- a browser window, as a WebSocket client --------------------------------------
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
	has(type, pred = () => true) {
		return this.received.some((m) => m.type === type && pred(m));
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

// ---- run ---------------------------------------------------------------------------
const tg = fakeTelegram(TOKEN);
const tgBase = await tg.start();
const srv = await ownServer({
	name: "telegram-answers",
	mock: modelReply,
	env: { PI_WEB_TELEGRAM_API_BASE: tgBase, PI_WEB_TOKEN: "" },
	verbose: !!process.env.TG_DEBUG,
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
	},
});
const hardStop = setTimeout(() => {
	console.log("✗ FAIL: the test took too long");
	process.exit(1);
}, 240_000);
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
try {
	A = await openClient("tg-window-a");
	A.send({ type: "set_model", modelId: "mock/mock-model" });
	await A.waitForState((s) => s.model?.id === "mock-model");

	console.log("set up: the plugin gets its bot token and owner in its settings");
	A.send({
		type: "plugin_settings",
		pluginId: "telegram",
		values: { enabled: true, botToken: TOKEN, ownerId: String(OWNER), webAppAddress: WEB },
	});
	await A.waitForType("notice", (m) => /Plugin settings saved|插件设置已保存/.test(m.text ?? ""));
	check("the plugin polls its own bot", await waitFor(() => tg.calls.some((c) => c.method === "getUpdates"), 15_000));
	// A window that opens while the plugin runs gets its line in the very first list (it used to
	// come only when the line next changed).
	const hasTelegramLine = (m) => m.type === "bg_servers" && m.servers?.some((s) => s.plugin === "telegram");
	await waitFor(() => A.received.some(hasTelegramLine), 15_000);
	const late = await openClient("tg-window-late");
	const firstBg = await late.waitForType("bg_servers", () => true, 10_000).catch(() => null);
	late.close();
	check(
		"a window opened later gets the Telegram line in its first background list",
		!!firstBg && hasTelegramLine(firstBg),
		JSON.stringify(firstBg?.servers?.map((s) => s.plugin ?? s.name ?? s.taskId) ?? null),
	);
	if (process.env.TG_DEBUG) {
		const plugins = A.received.filter((m) => m.type === "plugins").at(-1);
		console.log(
			"[debug] plugin:",
			JSON.stringify(plugins?.plugins?.find((p) => p.id === "telegram") ?? plugins?.plugins?.map((p) => p.id)),
		);
		const bg = A.received.filter((m) => m.type === "bg_servers").at(-1);
		console.log("[debug] background:", JSON.stringify(bg?.servers ?? null).slice(0, 600));
		console.log("[debug] telegram calls:", tg.calls.length, "wrong token:", tg.wrongToken.join(","));
	}

	console.log("1. a question, answered on Telegram");
	A.send({ type: "prompt", text: "TG-ASK 1 ask me something" });
	const q1 = await A.waitForType("question_pending", () => true, 30_000);
	const m1 = await tg.waitMessage((m) => m.text.includes("Which colour, round 1?"));
	check(
		"the question reaches the owner on Telegram at once",
		m1?.chatId === String(OWNER),
		m1 ? m1.chatId : "no message",
	);
	if (!m1) throw new Error("no Telegram message for the question");
	check(
		"its choices are buttons, numbered like the text lists them, plus a typed answer",
		same(labels(m1), ["1 \u00B7 Red", "2 \u00B7 Blue", TYPE_ANSWER]) && numberedRight(m1),
		labels(m1).join(" | "),
	);
	const [m1Head, ...m1Parts] = m1.text.split("\n\n");
	check(
		"it opens with the question's header and the chat it's from (on one line when it fits a phone's)",
		/^\u2753 <b>Colour<\/b>(?: \u00B7 |\n)<i>from [^<\n]+<\/i>$/.test(m1Head) && !/Chat: |Folder: /.test(m1.text),
		m1Head,
	);
	check(
		"... then the question in bold and its choices apart under a CHOICES line, with the header said only once",
		m1Parts[0] === "<b>Which colour, round 1?</b>" &&
			m1.text.includes(`\n\n${CHOICES_LINE}\n<b>1 \u00B7 Red</b>\nwarm\n\n<b>2 \u00B7 Blue</b>\n${RULE}\n`) &&
			m1.text.split("Colour").length === 2,
		m1.text,
	);
	const m1Lines = m1.text.split("\n");
	check(
		"it ends with a line, then one line: the folder, and a link to the chat",
		m1Lines.at(-2) === RULE &&
			/^<i>\u{1F4C1} [^<]*work<\/i> \u00B7 <a href="[^"]+">Open the chat<\/a>$/u.test(m1Lines.at(-1) ?? ""),
		m1Lines.slice(-2).join("\n"),
	);
	const href = /<a href="([^"]+)">Open the chat<\/a>/.exec(m1.text)?.[1]?.replace(/&amp;/g, "&");
	const link = href ? new URL(href) : null;
	check(
		"it links to the chat in the web app",
		link?.origin === "https://pi.test.example:8787" && link.searchParams.get("chat") === A.state.sessionFile,
		`${href} vs ${A.state.sessionFile}`,
	);
	const callsBefore = tg.apiCalls();
	tg.tap(m1, "Red", { from: STRANGER });
	tg.say("Red", { from: STRANGER, replyTo: m1.id });
	tg.say("/start", { from: STRANGER });
	const lastIgnored = tg.say("Red", {
		from: OWNER,
		chat: { id: -100555, type: "supergroup", title: "A group" },
		replyTo: m1.id,
	});
	await waitFor(() => tg.consumed(lastIgnored), 10_000);
	await sleep(500);
	check(
		"a stranger's tap and messages, and the owner writing in a group, are ignored",
		tg.apiCalls() === callsBefore && !A.has("question_retracted", (m) => m.id === q1.id) && !seen["ask 1"],
		`${tg.apiCalls() - callsBefore} new Bot API calls`,
	);
	const tap1 = tg.tap(m1, "Blue");
	check("the owner's tap answers the chat", await waitFor(() => /Blue/.test(seen["ask 1"] ?? "")), seen["ask 1"]);
	check(
		"the browser's question dialog closes",
		await waitFor(() => A.has("question_retracted", (m) => m.id === q1.id), 10_000),
	);
	check(
		"the tap is acknowledged",
		await waitFor(() => tg.callbackAnswer(tap1.id)?.params.text === "Chosen: Blue", 10_000),
	);
	check(
		"the message shrinks to one line: answered on Telegram, and its buttons are gone",
		await waitFor(() => oneLineFinal(m1, "<b>Colour</b>", "Blue <i>(on Telegram)</i>") && noButtons(m1), 10_000),
		m1.text,
	);
	await waitIdle(A);

	console.log("2. a question answered in the browser");
	A.send({ type: "prompt", text: "TG-ASK 2 ask me again" });
	const q2 = await A.waitForType("question_pending", (m) => m.id !== q1.id, 30_000);
	const m2 = await tg.waitMessage((m) => m.text.includes("Which colour, round 2?"));
	if (!m2) throw new Error("no Telegram message for the second question");
	A.send({ type: "question_answer", id: q2.id, answers: [{ id: "colour", selected: ["Red"] }] });
	check("the browser's answer reaches the chat", await waitFor(() => /Red/.test(seen["ask 2"] ?? "")), seen["ask 2"]);
	check(
		"the Telegram message shrinks to one line: answered in the browser",
		await waitFor(() => oneLineFinal(m2, "<b>Colour</b>", "Red <i>(in the browser)</i>") && noButtons(m2), 10_000),
		m2.text,
	);
	const tap2 = tg.tap(m2, "Blue", { stale: true });
	check(
		"its old buttons only say it's no longer waiting",
		await waitFor(() => tg.callbackAnswer(tap2.id)?.params.text === "No longer waiting.", 10_000),
	);
	await waitIdle(A);
	check("... and change nothing", !/Blue/.test(seen["ask 2"] ?? ""));

	console.log("3. permission prompts");
	A.send({ type: "prompt", text: "TG-RUN 1 clean up" });
	const a1 = await A.waitForType("tool_approval_pending", () => true, 30_000);
	const m3 = await tg.waitMessage((m) => m.text.includes("rm -rf ./tg-gone-1"));
	if (!m3) throw new Error("no Telegram message for the permission prompt");
	check(
		"a permission prompt reaches Telegram with the browser's allow / deny choices",
		bare(m3).includes("Approve") &&
			bare(m3).includes("Allow all here") &&
			bare(m3).at(-1) === "Deny" &&
			numberedRight(m3) &&
			m3.text.split("\n").at(-2) === RULE,
		labels(m3).join(" | "),
	);
	tg.tap(m3, "Approve");
	check(
		"Approve on Telegram runs the command",
		await waitFor(() => /TG-RAN-101/.test(seen["run 1"] ?? "")),
		seen["run 1"],
	);
	check(
		"the browser's permission dialog closes",
		await waitFor(() => A.has("tool_approval_resolved", (m) => m.id === a1.id), 10_000),
	);
	check(
		"the message shrinks to one line: answered on Telegram",
		await waitFor(() => oneLineFinal(m3, "<b>Allow bash?</b>", "<i>(on Telegram)</i>") && noButtons(m3), 10_000),
		m3.text,
	);
	await waitIdle(A);

	A.send({ type: "prompt", text: "TG-RUN 2 clean up again" });
	const a2 = await A.waitForType("tool_approval_pending", (m) => m.id !== a1.id, 30_000);
	const m4 = await tg.waitMessage((m) => m.text.includes("rm -rf ./tg-gone-2"));
	if (!m4) throw new Error("no Telegram message for the second permission prompt");
	tg.tap(m4, "Deny");
	check(
		"Deny on Telegram stops the command",
		(await waitFor(() => seen["run 2"] !== undefined)) && !/TG-RAN-102/.test(seen["run 2"]),
		seen["run 2"],
	);
	check(
		"... and closes the browser's dialog",
		await waitFor(() => A.has("tool_approval_resolved", (m) => m.id === a2.id), 10_000),
	);
	await waitIdle(A);

	A.send({ type: "prompt", text: "TG-RUN 3 once more" });
	const a3 = await A.waitForType("tool_approval_pending", (m) => m.id !== a1.id && m.id !== a2.id, 30_000);
	const m5 = await tg.waitMessage((m) => m.text.includes("rm -rf ./tg-gone-3"));
	if (!m5) throw new Error("no Telegram message for the third permission prompt");
	A.send({ type: "tool_approval_response", id: a3.id, decision: "approve" });
	check(
		"a permission prompt approved in the browser runs",
		await waitFor(() => /TG-RAN-103/.test(seen["run 3"] ?? "")),
		seen["run 3"],
	);
	check(
		"... and its Telegram message shrinks to one line: answered in the browser",
		await waitFor(() => oneLineFinal(m5, "<b>Allow bash?</b>", "<i>(in the browser)</i>") && noButtons(m5), 10_000),
		m5.text,
	);
	await waitIdle(A);

	console.log("4. the queue: a plan's pop-up, then a stuck task, answered on Telegram");
	A.send({ type: "prompt", text: "TG-PLAN queue the label task" });
	const m6 = await tg.waitMessage((m) => m.text.includes("Add to the queue?") && m.text.includes(PLAN.title), 30_000);
	if (!m6) throw new Error("no Telegram message for the plan's pop-up");
	check(
		"the plan's approval pop-up reaches Telegram with Yes / No (no numbers: there's nothing to read about them)",
		same(labels(m6), ["Yes", "No"]) && numberedRight(m6),
		labels(m6).join(" | "),
	);
	check(
		"... its plan shown as formatting, not as markdown marks",
		m6.text.includes(`<b>Task #1: ${PLAN.title}</b>`) && !/\*\*|###/.test(m6.text),
		m6.text,
	);
	check(
		"... while the browser shows it too",
		await waitFor(() => A.state.dialog?.title === "Add to the queue?", 10_000),
		JSON.stringify(A.state.dialog),
	);
	tg.tap(m6, "Yes");
	check(
		"Yes on Telegram adds the task",
		await waitFor(() => seen.plan !== undefined && A.state.taskQueue?.tasks?.some((t) => t.id === 1)),
		seen.plan,
	);
	check("the browser's pop-up closes", await waitFor(() => !A.state.dialog, 10_000));
	await waitIdle(A);
	A.send({ type: "task_queue_command", action: "start", conversationId: A.state.conversationId });
	const m7 = await tg.waitMessage((m) => m.text.includes("rm -rf ./tg-task-gone"), 30_000);
	check("the task's own chat (no browser on it) asks permission on Telegram", !!m7);
	if (!m7) throw new Error("no Telegram message for the task chat's permission prompt");
	check(
		"... and every open browser is shown it too",
		await waitFor(
			() => A.has("tool_approval_pending", (m) => String(m.params?.command ?? "").includes("tg-task-gone")),
			10_000,
		),
	);
	tg.tap(m7, "Approve");
	check("Approve runs the task's command", await waitFor(() => /TG-RAN-201/.test(seen.taskRun ?? "")), seen.taskRun);
	const m8 = await tg.waitMessage((m) => m.text.includes("needs you") && m.text.includes(STUCK_QUESTION), 30_000);
	if (!m8) throw new Error("no Telegram message for the stuck task");
	check(
		"the stuck task asks on Telegram with its choices and a typed answer",
		same(labels(m8), [...CHOICES, TYPE_ANSWER]),
		labels(m8).join(" | "),
	);
	check(
		"... under 'Task #1 needs you' and the task's title, with no chat line, and its question in bold",
		m8.text.startsWith(`\u{1F4CC} <b>Task #1 needs you</b>\n<i>${PLAN.title}</i>\n\n<b>${STUCK_QUESTION}</b>`) &&
			!m8.text.includes("Chat: "),
		m8.text,
	);
	const task1 = () => A.state.taskQueue?.tasks?.find((t) => t.id === 1);
	check(
		"the Queue tab shows it stuck, with the same choices",
		await waitFor(() => task1()?.status === "stuck" && same(task1()?.choices, CHOICES), 10_000),
		JSON.stringify(task1()),
	);
	tg.tap(m8, "Settings");
	check(
		"the answer goes into the task's chat",
		await waitFor(() => seen.taskAnswer === "Settings", 30_000),
		seen.taskAnswer,
	);
	check(
		"the task carries on and finishes",
		await waitFor(() => task1()?.status === "done", 30_000),
		JSON.stringify(task1()),
	);
	check(
		"the message shrinks to one line: the task, and the answer given on Telegram",
		await waitFor(
			() => oneLineFinal(m8, "<b>Task #1</b>", "Settings <i>(on Telegram)</i>", PLAN.title) && noButtons(m8),
			10_000,
		),
		m8.text,
	);
	await waitIdle(A);

	console.log(`5. no browser open: a question outlives the ${NO_BROWSER_GRACE_MS / 1000} s no-browser wait`);
	A.send({ type: "prompt", text: "TG-QUIET 1 work while I'm away" });
	await A.waitForState((s) => s.isStreaming, 15_000);
	A.close();
	A = null;
	const m9 = await tg.waitMessage((m) => m.text.includes("Which size?"), 20_000);
	check("with no browser open, the question still reaches Telegram", !!m9);
	if (!m9) throw new Error("no Telegram message for the no-browser question");
	await sleep(NO_BROWSER_GRACE_MS + 3000);
	check(
		"... and still waits after the no-browser wait",
		!/no longer waiting/i.test(m9.text) &&
			same(labels(m9), ["Small", "Large", TYPE_ANSWER]) &&
			seen.quietAsk === undefined,
		m9.text.slice(-160),
	);
	tg.tap(m9, "Large");
	const m10 = await tg.waitMessage((m) => m.text.includes("rm -rf ./tg-quiet-gone"), 20_000);
	check("with no browser open, the permission prompt waits on Telegram too", !!m10);
	if (m10) tg.tap(m10, "Approve");
	check(
		"both answers reach the chat, and it carries on",
		await waitFor(() => /Large/.test(seen.quietAsk ?? "") && /TG-RAN-301/.test(seen.quietRun ?? "")),
		`${seen.quietAsk} | ${seen.quietRun}`,
	);

	console.log("6. the bot token stays out of files");
	const leaks = [];
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else if (st.isFile() && st.size < 20_000_000 && readFileSync(p).includes(TOKEN_SECRET))
				leaks.push(p.slice(srv.root.length));
		}
	};
	walk(srv.root);
	check("the bot token is in no file the server wrote", leaks.length === 0, leaks.join(", "));
	check("the server's output doesn't show it", !srv.stderr().includes(TOKEN_SECRET));
	check("every Bot API call used the token", tg.wrongToken.length === 0, tg.wrongToken.join(", "));
	check("the model saw no user message it had no script for", unexpected.length === 0, unexpected.join(" | "));
} catch (e) {
	failures++;
	console.log(`  ✗ FAIL: ${e?.stack ?? e}`);
} finally {
	A?.close();
	await srv.stop();
	tg.close();
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
