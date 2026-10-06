/**
 * telegram-owner-answers (sealed, zero tokens): only the COO's answer to something the owner asked
 * it comes through on Telegram; everything else between roles stays off it (owner, 2026-10-06: "No I
 * dont want to read agent to agent messages at all", then "Yes, answers to my questions").
 * A fake Telegram stands in for api.telegram.org (PI_WEB_TELEGRAM_API_BASE), the mock model for the
 * model, three made-up roles (coo, temper, security, each with a saved, closed home chat) in a temp
 * identities folder, and a plain WebSocket client for the browser. The real plugin (plugins/telegram)
 * is installed into the server's own data folder.
 *
 *  1. the owner asks the COO on Telegram; it asks temper (message_role question) and answers him: its
 *     answer comes back under his message as before, and the question is marked forOwner in
 *     role-messages.json with his send id;
 *  2. temper's reply starts a COO turn: that answer reaches Telegram in full, under his message, with
 *     a notification and a line saying temper answered;
 *  3. a chain: inside that turn the COO asks security; security's reply starts a COO turn that
 *     reaches him too, under the same message;
 *  4. a question the COO asks from a browser turn isn't his: the turn the reply starts sends nothing;
 *  5. an unrelated request from temper to the COO, and an FYI, send nothing;
 *  6. the plugin's lines say what happened, and none holds what was written.
 * Never prints what goes to the model (rule 11).
 *
 * Usage: npm run build && scripts/sealed.sh node tests/telegram-owner-answers-test.mjs
 *        PI_IDENTITY_PKG=<pi-identity checkout> (default ~/projects/pi-identity). TGOA_DEBUG=1: server output.
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
const OWNER = 424242003;
const TOKEN = "700000003:TEST-secret-part-not-a-real-token";
const WEB = "https://pi.test.example:8787/";
/** The forced clock: 05:10 Pacific (the brief stays off here; telegram-coo-test.mjs covers it). */
const NOW = "2026-10-06T05:10:00-07:00";
const PHONE = "\u{1F4F1} ";

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
					silent: params.disable_notification === true,
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
		/** A text message from the owner. Returns its message id. */
		say(text) {
			const messageId = 5000 + nextUpdate;
			updates.push({
				update_id: nextUpdate++,
				message: {
					message_id: messageId,
					date: Math.floor(Date.now() / 1000),
					from: { id: OWNER, is_bot: false, first_name: "Owner" },
					chat,
					text,
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
// Each chat's turn is told apart by a word in its last user message; a role message's id is read from
// its header so a reply can name it.
function modelReply({ payload, sideRequest }) {
	if (sideRequest) return "Role chat";
	const history = Array.isArray(payload.messages) ? payload.messages : [];
	const users = history
		.map((m, i) => [m, i])
		.filter(([m]) => m.role === "user" && !/^\(System reminder/.test(textOf(m)));
	const [lastMsg, lastAt] = users.at(-1) ?? [null, -1];
	const userText = lastMsg ? textOf(lastMsg) : "";
	const results = history.slice(lastAt + 1).filter((m) => m.role === "tool").length;
	const has = (word) => new RegExp(`(^|\\W)${word}(\\W|$)`).test(userText);
	const msgId = /^\[Role message (rm-[0-9a-f]{8}) /.exec(userText)?.[1];
	const send = (args) => ({ tool: "message_role", args });
	const ask = (to, text) => send({ to, kind: "question", text });
	const answer = (to, text) => send({ to, kind: "reply", replyTo: msgId, text });
	// 1-3: the owner's question, the chain, and the answers.
	if (userText.startsWith(`${PHONE}OWNER-ASK`))
		return results ? "COO-ACK I asked temper." : ask("temper", "ASK-TEMPER-ONE what do you think of the plan?");
	if (has("ASK-TEMPER-ONE")) return results ? "TEMPER-DONE" : answer("coo", "ANSWER-TEMPER-ONE the plan looks fine.");
	if (has("ANSWER-TEMPER-ONE"))
		return results
			? "COO-RELAY temper says the plan **looks fine**; I asked security too."
			: ask("security", "ASK-SECURITY is the plan safe?");
	if (has("ASK-SECURITY")) return results ? "SECURITY-DONE" : answer("coo", "ANSWER-SECURITY it is safe.");
	if (has("ANSWER-SECURITY")) return "COO-SECURITY security says it is safe.";
	// 4: a question asked from a browser turn.
	if (userText.startsWith("BROWSER-ASK"))
		return results ? "COO-BROWSER-ACK" : ask("temper", "ASK-TEMPER-BROWSER a browser question");
	if (has("ASK-TEMPER-BROWSER"))
		return results ? "TEMPER-DONE-2" : answer("coo", "ANSWER-TEMPER-BROWSER a browser answer");
	if (has("ANSWER-TEMPER-BROWSER")) return "COO-RELAY-BROWSER not for Telegram";
	// 5: temper's own request and FYI to the COO.
	if (userText.startsWith("BROWSER-TEMPER")) {
		if (results === 0) return send({ to: "coo", kind: "request", text: "UNRELATED-REQUEST please look at the logs" });
		if (results === 1) return send({ to: "coo", kind: "fyi", text: "UNRELATED-FYI the logs are big" });
		return "TEMPER-SENT";
	}
	if (has("UNRELATED-REQUEST")) return "COO-UNRELATED looked at the logs";
	return "OTHER";
}

// ---- the roles and their saved home chats -------------------------------------------
let idDir = "";
const files = {};
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
	const ts = Date.parse("2026-10-06T03:00:00.000Z");
	const at = (n) => new Date(ts + n * 1000).toISOString();
	const homeChat = (id, n) => {
		const sessionId = `01a0f000-0000-7000-8000-0000000000d${n}`;
		const file = join(dir, `2026-10-06T03-00-0${n}-000Z_${sessionId}.jsonl`);
		const lines = [
			{ type: "session", version: 3, id: sessionId, timestamp: at(0), cwd: workdir },
			{ type: "model_change", id: "mc", parentId: null, timestamp: at(0), provider: "mock", modelId: "mock-model" },
			{
				type: "custom",
				customType: "identity",
				id: "e1",
				parentId: "mc",
				timestamp: at(1),
				data: { v: 1, id, via: "command" },
			},
			{
				type: "message",
				id: "e2",
				parentId: "e1",
				timestamp: at(2),
				message: { role: "user", content: [{ type: "text", text: `${id} home starts` }], timestamp: ts + 2000 },
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
		writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		return file;
	};
	files.coo = homeChat("coo", 1);
	files.temper = homeChat("temper", 2);
	files.security = homeChat("security", 3);

	// The roles (no `folder`: that would give every chat there a role).
	idDir = join(root, "identities");
	const role = (id, json) => {
		mkdirSync(join(idDir, id), { recursive: true });
		writeFileSync(join(idDir, id, "identity.json"), JSON.stringify({ id, ...json }, null, "\t"));
		writeFileSync(join(idDir, id, "about.md"), `# ${json.title}\n\n**Focus:** ${id} things.\n`);
		writeFileSync(join(idDir, id, "notebook.md"), "");
	};
	role("coo", { title: "COO", homeChat: files.coo });
	role("temper", { title: "Temper", homeChat: files.temper });
	role("security", { title: "Security", homeChat: files.security });
}

/** A chat's messages: [{ role, text }] (custom messages too, as role "custom"). */
function entries(file) {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.flatMap((e) =>
			e.type === "message"
				? [{ role: e.message.role, text: textOf(e.message) }]
				: e.type === "custom_message"
					? [{ role: "custom", text: typeof e.content === "string" ? e.content : textOf(e) }]
					: [],
		);
}
/** Whether a chat has a user message holding `word` with an assistant message after it saying `answer`. */
const answeredWith = (file, word, answer) => {
	const all = entries(file);
	const i = all.findIndex((e) => e.role === "user" && e.text.includes(word));
	return i >= 0 && all.slice(i + 1).some((e) => e.role === "assistant" && e.text.includes(answer));
};

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
	name: "telegram-owner-answers",
	mock: modelReply,
	stdout: true,
	verbose: !!process.env.TGOA_DEBUG,
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
}, 300_000);
hardStop.unref();

/** role-messages.json's record whose text holds `word`. */
const roleRecord = (word) => {
	try {
		const store = JSON.parse(readFileSync(join(srv.dataDir, "role-messages.json"), "utf8"));
		return (store.messages ?? []).find((m) => String(m.text ?? "").includes(word)) ?? null;
	} catch {
		return null;
	}
};
/** The lines the Telegram plugin logged. */
const pluginLines = () =>
	`${srv.stdout()}\n${srv.stderr()}`
		.split("\n")
		.filter((l) => /telegram:/i.test(l))
		.join("\n");

let A = null;
try {
	const ws = new WebSocket(srv.ws);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	A = new Client(ws);
	A.send({ type: "hello", clientId: "tgoa-window", locale: "en" });
	await A.waitForType("ready", () => true, 40_000);
	A.send({ type: "get_state" });
	await A.waitForState((s) => Boolean(s.conversationId));
	A.received = A.received.filter((m) => m.type !== "notice");
	A.send({
		type: "plugin_settings",
		pluginId: "telegram",
		values: { enabled: true, botToken: TOKEN, ownerId: String(OWNER), webAppAddress: WEB, briefAt: "" },
	});
	await A.waitForType("notice", (m) => /Plugin settings saved|插件设置已保存/.test(m.text ?? ""));
	check("the plugin polls its bot", !!(await waitFor(() => tg.calls.some((c) => c.method === "getUpdates"), 15_000)));

	console.log("1. the owner asks; the COO asks temper and answers him as before");
	const ownerMsg = tg.say("OWNER-ASK what does temper think of the plan?");
	const ack = await tg.waitMessage((m) => m.text.includes("COO-ACK"));
	check("the COO's own answer comes back under his message", ack?.replyTo === ownerMsg, String(ack?.replyTo));
	check("with no line in front", ack?.text === "COO-ACK I asked temper.", ack?.text);
	const q1 = await waitFor(() => roleRecord("ASK-TEMPER-ONE"), 20_000);
	check(
		"the COO's question went to temper",
		q1?.to?.role === "temper" && q1?.kind === "question",
		JSON.stringify(q1?.to),
	);
	check(
		"it is marked forOwner in role-messages.json, with his send id",
		q1?.forOwner === true && Array.isArray(q1.ownerIds) && q1.ownerIds.length === 1,
		JSON.stringify({ forOwner: q1?.forOwner, ownerIds: q1?.ownerIds }),
	);

	console.log("2. temper's reply starts a COO turn that reaches him");
	check(
		"temper answered in its chat",
		!!(await waitFor(() => answeredWith(files.temper, "ASK-TEMPER-ONE", "TEMPER-DONE"), 40_000)),
	);
	const relay = await tg.waitMessage((m) => m.text.includes("COO-RELAY temper"), 40_000);
	check(
		"the answer reaches Telegram in full, with a line saying temper answered",
		relay?.text ===
			"<i>The COO, after the temper role answered:</i>\n\nCOO-RELAY temper says the plan <b>looks fine</b>; I asked security too.",
		relay?.text,
	);
	check("under his message", relay?.replyTo === ownerMsg, String(relay?.replyTo));
	check("with a notification", relay ? !relay.silent : false);

	console.log("3. a chain: the COO asks security inside that turn; its answer reaches him too");
	const q2 = await waitFor(() => roleRecord("ASK-SECURITY"), 20_000);
	check(
		"the chained question is marked forOwner, with the same send id",
		q2?.forOwner === true && JSON.stringify(q2.ownerIds) === JSON.stringify(q1?.ownerIds),
		JSON.stringify({ forOwner: q2?.forOwner, ownerIds: q2?.ownerIds }),
	);
	const sec = await tg.waitMessage((m) => m.text.includes("COO-SECURITY"), 40_000);
	check(
		"security's answer reaches Telegram, with a line saying security answered",
		sec?.text === "<i>The COO, after the security role answered:</i>\n\nCOO-SECURITY security says it is safe.",
		sec?.text,
	);
	check("under his message too", sec?.replyTo === ownerMsg, String(sec?.replyTo));
	check(
		"the replies themselves aren't marked",
		!roleRecord("ANSWER-TEMPER-ONE")?.forOwner && !roleRecord("ANSWER-SECURITY")?.forOwner,
	);

	console.log("4. a question the COO asks from a browser turn isn't his");
	A.send({ type: "switch_session", path: files.coo });
	await A.waitForState((s) => s.sessionFile === files.coo && s.isStreaming === false, 30_000);
	A.send({ type: "prompt", text: "BROWSER-ASK ask temper something" });
	const q3 = await waitFor(() => roleRecord("ASK-TEMPER-BROWSER"), 30_000);
	check("the question went to temper", q3?.to?.role === "temper");
	check("it isn't marked forOwner", q3 ? q3.forOwner !== true : false, JSON.stringify(q3?.forOwner));
	check(
		"the COO's turn that temper's reply started ran",
		!!(await waitFor(() => answeredWith(files.coo, "ANSWER-TEMPER-BROWSER", "COO-RELAY-BROWSER"), 40_000)),
	);

	console.log("5. an unrelated request from temper, and an FYI");
	A.send({ type: "switch_session", path: files.temper });
	await A.waitForState((s) => s.sessionFile === files.temper && s.isStreaming === false, 30_000);
	A.send({ type: "prompt", text: "BROWSER-TEMPER tell the COO about the logs" });
	check(
		"the COO's turn that the request started ran",
		!!(await waitFor(() => answeredWith(files.coo, "UNRELATED-REQUEST", "COO-UNRELATED"), 40_000)),
	);
	check(
		"the FYI is in the COO's chat",
		!!(await waitFor(() => entries(files.coo).some((e) => e.text.includes("UNRELATED-FYI")), 20_000)),
	);
	await sleep(4000);
	check(
		"none of these reached Telegram",
		!tg.find((m) => /COO-BROWSER-ACK|COO-RELAY-BROWSER|COO-UNRELATED|UNRELATED-|ANSWER-|ASK-|TEMPER-DONE/.test(m.text)),
		JSON.stringify([...tg.messages.values()].map((m) => m.text.slice(0, 60))),
	);
	const sent = [...tg.messages.values()].map((m) => m.text);
	check(
		"Telegram got exactly the three answers for him",
		sent.length === 3 &&
			sent.some((t) => t.includes("COO-ACK")) &&
			sent.some((t) => t.includes("COO-RELAY temper")) &&
			sent.some((t) => t.includes("COO-SECURITY")),
		JSON.stringify(sent.map((t) => t.slice(0, 60))),
	);

	console.log("6. the plugin's lines");
	const lines = pluginLines();
	check(
		"it logged the answers for the owner",
		/coo answered \(for the owner, after temper,/.test(lines) &&
			/coo answered \(for the owner, after security,/.test(lines),
		lines.slice(-600),
	);
	check(
		"and the turns it kept off Telegram",
		(lines.match(/answered another role's message \(not sent/g) ?? []).length >= 2,
		lines.slice(-600),
	);
	check(
		"no line holds what was written",
		!/OWNER-ASK|COO-ACK|COO-RELAY|COO-SECURITY|COO-UNRELATED|looks fine/.test(lines),
	);
} catch (err) {
	check("the test ran to the end", false, err?.stack ?? String(err));
} finally {
	A?.close();
	tg.close();
	await srv.stop();
}
console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ telegram-owner-answers: all checks passed");
process.exit(failures ? 1 : 0);
