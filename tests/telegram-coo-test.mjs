/**
 * telegram-coo (sealed, zero tokens): the owner chats with a role (the COO) through the Telegram bot.
 * A fake Telegram stands in for api.telegram.org (PI_WEB_TELEGRAM_API_BASE), the mock model for the
 * model, a made-up "coo" role (with a saved, closed home chat) in a temp identities folder, and a
 * plain WebSocket client for the browser. The real plugin (plugins/telegram) is installed into the
 * server's own data folder; its clock is forced with PI_WEB_TELEGRAM_NOW.
 *
 *  1. the plugin's status says where messages go; a plain message lands in the COO's closed home
 *     chat as the owner's own, with "📱 " in front; Telegram shows "typing…", and the COO's answer
 *     comes back formatted and threaded under the owner's message;
 *  2. a reply to the COO's message goes to it too;
 *  3. a turn started in the browser stays there;
 *  4. a message sent while the COO is busy: the bot says so, the message goes in right after the
 *     running turn, and its answer comes back threaded (the browser turn's answer doesn't);
 *  5. the morning brief: once its time has passed (before noon) the COO is asked; it reads
 *     roles_overview and its brief reaches Telegram;
 *  6. a role without a home chat: a plain error line under the owner's message;
 *  7. no Telegram line in the server's output holds what was written.
 * Never prints what goes to the model (rule 11).
 *
 * Usage: npm run build && scripts/sealed.sh node tests/telegram-coo-test.mjs
 *        PI_IDENTITY_PKG=<pi-identity checkout> (default ~/projects/pi-identity). TGCOO_DEBUG=1: server output.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { textOf } from "./lib/mock-model.mjs";
import { ownServer } from "./lib/own-server.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PI_IDENTITY = process.env.PI_IDENTITY_PKG ?? join(userInfo().homedir, "projects", "pi-identity");
if (!existsSync(join(PI_IDENTITY, "package.json"))) {
	console.log(`✗ FAIL: pi-identity not found at ${PI_IDENTITY} (set PI_IDENTITY_PKG)`);
	process.exit(1);
}

/** Made-up Telegram ids and token: the fake Telegram is all this test talks to. */
const OWNER = 424242001;
const TOKEN = "700000002:TEST-secret-part-not-a-real-token";
const WEB = "https://pi.test.example:8787/";
/** The forced clock: 05:10 Pacific, before any brief time used below. */
const NOW = "2026-10-06T05:10:00-07:00";
const DAY = "2026-10-06";
const PHONE = "\u{1F4F1} ";
const SLOW_TEXT = `SLOW-ANSWER ${"lorem ipsum dolor sit amet ".repeat(30)}END-OF-SLOW`;

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
		await sleep(100);
	}
	return null;
}

// ---- the fake Telegram ------------------------------------------------------
function fakeTelegram(token) {
	const calls = [];
	const messages = new Map();
	const updates = [];
	let nextUpdate = 1000;
	let nextMessage = 100;
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
		const method = m[2];
		const params = body ? JSON.parse(body) : {};
		calls.push({ method, params, at: Date.now() });
		const ok = (result) => reply(res, 200, { ok: true, result });
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
				messages.set(id, {
					id,
					text: String(params.text ?? ""),
					parseMode: params.parse_mode ?? null,
					replyTo: params.reply_parameters?.message_id ?? null,
				});
				return ok({
					message_id: id,
					date: Math.floor(Date.now() / 1000),
					chat: { id: Number(params.chat_id), type: "private" },
					text: params.text,
				});
			}
			default:
				return ok(true);
		}
	});
	const chat = { id: OWNER, type: "private", first_name: "x" };
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
		/** A text message from the owner, optionally a reply to one of the bot's. Returns its message id. */
		say(text, { replyTo } = {}) {
			const messageId = 5000 + nextUpdate;
			updates.push({
				update_id: nextUpdate++,
				message: {
					message_id: messageId,
					date: Math.floor(Date.now() / 1000),
					from: { id: OWNER, is_bot: false, first_name: "Owner" },
					chat,
					text,
					...(replyTo
						? { reply_to_message: { message_id: replyTo, date: 0, chat, from: { id: 1, is_bot: true }, text: "x" } }
						: {}),
				},
			});
			wake();
			return messageId;
		},
		find: (pred) => [...messages.values()].reverse().find(pred) ?? null,
		waitMessage(pred, ms = 30_000) {
			return waitFor(() => this.find(pred), ms);
		},
	};
}

// ---- the mock model ------------------------------------------------------------
/** What the brief's roles_overview call returned. */
const seen = { overview: null };
function modelReply({ payload, sideRequest }) {
	if (sideRequest) return "COO chat";
	const history = Array.isArray(payload.messages) ? payload.messages : [];
	const users = history
		.map((m, i) => [m, i])
		.filter(([m]) => m.role === "user" && !/^\(System reminder/.test(textOf(m)));
	const [lastMsg, lastAt] = users.at(-1) ?? [null, -1];
	const userText = lastMsg ? textOf(lastMsg) : "";
	const results = history
		.slice(lastAt + 1)
		.filter((m) => m.role === "tool")
		.map(textOf);
	if (userText.startsWith("Morning brief for the owner")) {
		if (results.length === 0) return { tool: "roles_overview", args: {} };
		seen.overview = results[0];
		return `Morning brief, ${DAY}\n\n**Needs you:** nothing today.`;
	}
	if (userText.startsWith(PHONE)) return `COO-ANSWER to **${userText.slice(PHONE.length).trim()}**`;
	if (userText.startsWith("BROWSER-TURN")) return "BROWSER-ANSWER";
	if (userText.startsWith("SLOW-TURN")) return { text: SLOW_TEXT, stream: { everyMs: 60, pieceChars: 8 } };
	return "OTHER";
}

// ---- the role and its saved home chat ----------------------------------------------
let idDir = "";
let cooFile = "";
function seed({ root, dataDir, agentDir, workdir }) {
	cpSync(join(REPO, "plugins", "telegram"), join(dataDir, "plugins", "telegram"), { recursive: true });
	const settingsFile = join(agentDir, "settings.json");
	const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {};
	writeFileSync(
		settingsFile,
		JSON.stringify(
			{ ...settings, defaultProvider: "mock", defaultModel: "mock-model", packages: [PI_IDENTITY] },
			null,
			2,
		),
	);
	const dir = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(dir, { recursive: true });
	cooFile = join(dir, "2026-10-06T03-00-00-000Z_01a0f000-0000-7000-8000-0000000000c1.jsonl");
	const ts = Date.parse("2026-10-06T03:00:00.000Z");
	const at = (n) => new Date(ts + n * 1000).toISOString();
	const lines = [
		{ type: "session", version: 3, id: "01a0f000-0000-7000-8000-0000000000c1", timestamp: at(0), cwd: workdir },
		{ type: "model_change", id: "mc", parentId: null, timestamp: at(0), provider: "mock", modelId: "mock-model" },
		{
			type: "custom",
			customType: "identity",
			id: "e1",
			parentId: "mc",
			timestamp: at(1),
			data: { v: 1, id: "coo", via: "command" },
		},
		{
			type: "message",
			id: "e2",
			parentId: "e1",
			timestamp: at(2),
			message: { role: "user", content: [{ type: "text", text: "coo home starts" }], timestamp: ts + 2000 },
		},
		{
			type: "message",
			id: "e3",
			parentId: "e2",
			timestamp: at(3),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: "openai-completions",
				provider: "mock",
				model: "mock-model",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: ts + 3000,
			},
		},
	];
	writeFileSync(cooFile, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);

	// The roles (no `folder`: that would give every chat there a role). ghost has no home chat.
	idDir = join(root, "identities");
	const role = (id, json) => {
		mkdirSync(join(idDir, id), { recursive: true });
		writeFileSync(join(idDir, id, "identity.json"), JSON.stringify({ id, ...json }, null, "\t"));
		writeFileSync(join(idDir, id, "about.md"), `# ${json.title}\n\n**Focus:** ${id} things.\n`);
		writeFileSync(join(idDir, id, "notebook.md"), "");
	};
	role("coo", { title: "COO", homeChat: cooFile });
	role("ghost", { title: "Ghost" });
}

/** The COO chat's messages: [{ role, text }]. */
function entries(file) {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.filter((e) => e.type === "message")
		.map((e) => ({ role: e.message.role, text: textOf(e.message) }));
}

// ---- a browser window, as a WebSocket client --------------------------------------
class Client {
	constructor(ws) {
		this.ws = ws;
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
	async waitForType(type, pred = () => true, ms = 20_000) {
		const found = await waitFor(() => this.received.find((m) => m.type === type && pred(m)), ms);
		if (!found) throw new Error(`no ${type} within ${ms} ms`);
		return found;
	}
	async waitForState(pred, ms = 20_000) {
		if (!(await waitFor(() => this.state && pred(this.state), ms))) throw new Error("state never matched");
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
	name: "telegram-coo",
	mock: modelReply,
	stdout: true,
	verbose: !!process.env.TGCOO_DEBUG,
	prepare: seed,
	env: {
		PI_WEB_TELEGRAM_API_BASE: tgBase,
		PI_WEB_TELEGRAM_NOW: NOW,
		PI_WEB_TOKEN: "",
		// Read when the server starts, after seed() made the folder.
		get PI_IDENTITY_DIR() {
			return idDir;
		},
		PI_IDENTITY_REINDEX: "0",
	},
});
const hardStop = setTimeout(() => {
	console.log("✗ FAIL: the test took too long");
	process.exit(1);
}, 240_000);
hardStop.unref();

const userTexts = () =>
	entries(cooFile)
		.filter((e) => e.role === "user")
		.map((e) => e.text);
const answered = (text) => {
	const all = entries(cooFile);
	const i = all.findIndex((e) => e.role === "user" && e.text === text);
	return i >= 0 && all.slice(i + 1).some((e) => e.role === "assistant");
};

let A = null;
try {
	const ws = new WebSocket(srv.ws);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	A = new Client(ws);
	A.send({ type: "hello", clientId: "tgcoo-window", locale: "en" });
	await A.waitForType("ready", () => true, 40_000);
	A.send({ type: "get_state" });
	await A.waitForState((s) => Boolean(s.conversationId));

	const settings = (extra) => {
		A.received = A.received.filter((m) => m.type !== "notice");
		A.send({
			type: "plugin_settings",
			pluginId: "telegram",
			values: { enabled: true, botToken: TOKEN, ownerId: String(OWNER), webAppAddress: WEB, ...extra },
		});
		return A.waitForType("notice", (m) => /Plugin settings saved|插件设置已保存/.test(m.text ?? ""));
	};
	const statusLine = () =>
		[...A.received]
			.reverse()
			.find((m) => m.type === "bg_servers" && m.servers?.some((s) => s.plugin === "telegram"))
			?.servers.find((s) => s.plugin === "telegram")?.status ?? "";

	console.log("1. a plain message goes to the COO's closed home chat and its answer comes back");
	// "Messages go to" is left at its default (coo); the brief stays off until step 5.
	await settings({ briefAt: "" });
	check("the plugin polls its bot", !!(await waitFor(() => tg.calls.some((c) => c.method === "getUpdates"), 15_000)));
	check(
		"its status says messages go to coo",
		!!(await waitFor(() => /^listening \u00B7 messages go to coo$/.test(statusLine()), 15_000)),
		statusLine(),
	);
	const hello = tg.say("COO-HELLO how are things?");
	check(
		"the message lands in the COO's chat as the owner's, with 📱",
		!!(await waitFor(() => userTexts().includes(`${PHONE}COO-HELLO how are things?`), 30_000)),
		JSON.stringify(userTexts()),
	);
	const answer1 = await tg.waitMessage((m) => m.text.includes("COO-ANSWER to"));
	check(
		"its answer comes back formatted",
		answer1?.text === "COO-ANSWER to <b>COO-HELLO how are things?</b>" && answer1.parseMode === "HTML",
		answer1?.text,
	);
	check("threaded under his message", answer1?.replyTo === hello, String(answer1?.replyTo));
	check(
		"Telegram showed typing",
		tg.calls.some((c) => c.method === "sendChatAction" && c.params.action === "typing"),
	);

	console.log("2. a reply to the COO's message goes to it");
	const follow = tg.say("COO-FOLLOWUP and rollcall?", { replyTo: answer1?.id });
	const answer2 = await tg.waitMessage((m) => m.text.includes("COO-FOLLOWUP"));
	check("it reached the COO", userTexts().includes(`${PHONE}COO-FOLLOWUP and rollcall?`));
	check("and its answer came back under it", answer2?.replyTo === follow, String(answer2?.replyTo));

	console.log("3. a turn started in the browser stays there");
	A.send({ type: "switch_session", path: cooFile });
	await A.waitForState((s) => s.sessionFile === cooFile && s.isStreaming === false);
	A.send({ type: "prompt", text: "BROWSER-TURN hello" });
	check("the browser turn ran", !!(await waitFor(() => answered("BROWSER-TURN hello"), 30_000)));
	await sleep(2000);
	check("its answer isn't sent to Telegram", !tg.find((m) => m.text.includes("BROWSER-ANSWER")));

	console.log("4. a message while the COO is busy goes in after its turn");
	A.send({ type: "prompt", text: "SLOW-TURN please" });
	await A.waitForState((s) => s.isStreaming === true, 15_000);
	const busyMsg = tg.say("COO-BUSY are you there?");
	const note = await tg.waitMessage((m) => m.text.includes("busy right now"), 15_000);
	check(
		"the bot says it's busy, under his message",
		note?.text === "The COO is busy right now: your message goes in right after its current turn." &&
			note.replyTo === busyMsg,
		note?.text,
	);
	check("the message isn't in the chat while the turn runs", !userTexts().includes(`${PHONE}COO-BUSY are you there?`));
	check("the slow turn ends", !!(await waitFor(() => answered("SLOW-TURN please"), 30_000)));
	const answer3 = await tg.waitMessage((m) => m.text.includes("COO-BUSY"), 30_000);
	const texts = userTexts();
	check(
		"then the message goes in, after the slow turn",
		texts.indexOf(`${PHONE}COO-BUSY are you there?`) > texts.indexOf("SLOW-TURN please"),
		JSON.stringify(texts),
	);
	check("its answer comes back under it", answer3?.replyTo === busyMsg, String(answer3?.replyTo));
	check("the browser's slow answer isn't sent", !tg.find((m) => m.text.includes("SLOW-ANSWER")));

	console.log("5. the morning brief");
	await settings({ briefAt: "05:00" });
	check(
		"the status shows the brief's time",
		!!(await waitFor(() => statusLine().includes("brief at 05:00"), 15_000)),
		statusLine(),
	);
	check(
		"the COO is asked for it",
		!!(await waitFor(() => userTexts().some((t) => t.startsWith(`Morning brief for the owner, ${DAY}`)), 30_000)),
	);
	const brief = await tg.waitMessage((m) => m.text.startsWith(`Morning brief, ${DAY}`), 30_000);
	check(
		"its brief reaches Telegram, formatted, on its own",
		brief?.text === `Morning brief, ${DAY}\n\n<b>Needs you:</b> nothing today.` && brief.replyTo === null,
		brief?.text,
	);
	check(
		"the COO read every role with roles_overview",
		typeof seen.overview === "string" &&
			/## coo \(COO\)/.test(seen.overview) &&
			/## ghost \(Ghost\)/.test(seen.overview),
		String(seen.overview).slice(0, 200),
	);
	await sleep(12_000);
	check("asked once", userTexts().filter((t) => t.startsWith("Morning brief for the owner")).length === 1);

	console.log("6. a role without a home chat");
	await settings({ briefAt: "", routeTo: "ghost" });
	await waitFor(() => statusLine().includes("messages go to ghost"), 15_000);
	const ghostMsg = tg.say("GHOST-HELLO anyone?");
	const err = await tg.waitMessage((m) => m.text.startsWith("Couldn't send it to the ghost role:"), 20_000);
	check("a plain error line under his message", !!err && err.replyTo === ghostMsg, err?.text);
	check("it says there's no home chat", /home chat/.test(err?.text ?? ""), err?.text);

	console.log("7. the server's output");
	const out = `${srv.stdout()}\n${srv.stderr()}`
		.split("\n")
		.filter((l) => /telegram/i.test(l))
		.join("\n");
	check(
		"no Telegram line holds what was written",
		!/COO-HELLO|COO-FOLLOWUP|COO-BUSY|COO-ANSWER|GHOST-HELLO|Needs you/.test(out),
	);
} catch (err) {
	check("the test ran to the end", false, err?.stack ?? String(err));
} finally {
	A?.close();
	tg.close();
	await srv.stop();
}
console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ telegram-coo: all checks passed");
process.exit(failures ? 1 : 0);
