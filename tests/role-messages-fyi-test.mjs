/**
 * role-messages (fyi as a note) E2E: an FYI from another role is added to the receiving role's home chat
 * without starting a turn there, and that chat's model reads it with its next message.
 *
 * Checks:
 *  1. an fyi to beta's closed home chat: the sender hears it's added without a turn; beta's transcript
 *     gets a role-message custom entry, the store says delivered, and beta's model gets no call;
 *  2. an fyi to beta's open, idle home chat: the window shows the role-message card (from alpha, fyi),
 *     the chat doesn't start a turn, and beta's model still gets no call;
 *  3. a message typed in beta's chat: one model call, and its context carries both FYIs; each FYI is
 *     in the transcript exactly once and delivered exactly once in the store;
 *  4. a request to beta still starts a turn there at once.
 *
 * The mock model's requests are checked inside this test only: nothing of them is printed.
 *
 * Run: node tests/run-sealed.mjs role-messages-fyi (debug: ROLEMSG_DEBUG=1 prints markers only)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { textOf } from "./lib/mock-model.mjs";
import { ownServer } from "./lib/own-server.mjs";

// The account's home (userInfo), not HOME: a sealed run has a temp HOME.
const PI_IDENTITY = process.env.PI_IDENTITY_PKG ?? join(userInfo().homedir, "projects", "pi-identity");
if (!existsSync(join(PI_IDENTITY, "package.json"))) {
	console.log(`✗ FAIL: pi-identity not found at ${PI_IDENTITY} (set PI_IDENTITY_PKG)`);
	process.exit(1);
}

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✓" : "✗ FAIL:"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures += 1;
}
async function waitFor(fn, timeout = 30000, step = 150) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const v = await fn();
		if (v) return v;
		await sleep(step);
	}
	return null;
}

// ---- the scripted model ------------------------------------------------------------------------------
const HEADER = /^\[Role message (rm-[0-9a-f]{8}) from (\S+) /;
/** What the model saw, as counts and booleans only. */
const seen = {
	/** Requests made for beta's chat (its context has beta's first message). */
	betaCalls: 0,
	/** The typed message's request: did its context carry each FYI? */
	typedSawFyi1: null,
	typedSawFyi2: null,
	/** Did an FYI ever end a request's context (= a turn started for it)? */
	fyiStartedTurn: false,
};
function reply(ctx) {
	// When another chat in the same folder is running, the app adds a "(System reminder: …)" after the
	// prompt: the test's own last message is the one before it.
	const messages = Array.isArray(ctx.payload.messages) ? ctx.payload.messages : [];
	const users = messages.filter((m) => m.role === "user" && !/^\(System reminder/.test(textOf(m)));
	const lastUser = users.length > 0 ? textOf(users.at(-1)) : (ctx.lastUser ?? "");
	const out = decide({ ...ctx, messages, users, lastUser });
	if (process.env.ROLEMSG_DEBUG) {
		const marks = ["FYI-CLOSED-1", "FYI-IDLE-2", "TYPED-AFTER", "REQ-NOW-3", "SEND"].filter((m) =>
			lastUser.includes(m),
		);
		console.log(`[mock] ${marks.join("+") || "-"} beta=${users.some((m) => textOf(m) === "beta home starts")}`);
	}
	return out;
}
function decide({ users, lastUser, toolResult, sideRequest }) {
	if (sideRequest) return "Chat";
	const userTexts = users.map((m) => textOf(m));
	if (userTexts.includes("beta home starts")) {
		seen.betaCalls += 1;
		if (HEADER.test(lastUser) && lastUser.includes("fyi]")) seen.fyiStartedTurn = true;
		if (lastUser === "TYPED-AFTER-FYI") {
			seen.typedSawFyi1 = userTexts.some((t) => HEADER.test(t) && t.includes("FYI-CLOSED-1"));
			seen.typedSawFyi2 = userTexts.some((t) => HEADER.test(t) && t.includes("FYI-IDLE-2"));
		}
	}
	if (toolResult) return `TOOL RESULT: ${toolResult.content}`;
	const rm = HEADER.exec(lastUser);
	if (rm) return `noted ${rm[1]}`;
	if (/^SEND /.test(lastUser)) return { tool: "message_role", args: JSON.parse(lastUser.replace(/^SEND /, "")) };
	return "ok";
}

// ---- the saved chats and the roles -------------------------------------------------------------------
const files = {};
let idDir = "";

function seed({ root, agentDir, workdir }) {
	const settingsFile = join(agentDir, "settings.json");
	const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {};
	settings.packages = [PI_IDENTITY];
	writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

	const dir = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(dir, { recursive: true });
	const file = (n) => join(dir, `2026-10-01T10-0${n}-00-000Z_01a0f000-0000-7000-8000-0000000000c${n}.jsonl`);
	files.A = file(1);
	files.B = file(2);
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
			{ type: "session", version: 3, id, timestamp: new Date(ts).toISOString(), cwd: workdir },
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
			if (item.identity) {
				lines.push({
					type: "custom",
					customType: "identity",
					...base,
					data: { v: 1, id: item.identity, via: "command" },
				});
			} else if (item.user) {
				lines.push({
					type: "message",
					...base,
					message: { role: "user", content: [{ type: "text", text: item.user }], timestamp: ts },
				});
			} else {
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
			}
			parentId = base.id;
		}
		writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	};
	write(files.A, [{ identity: "alpha" }, { user: "alpha home starts" }, { assistant: "ok" }]);
	write(files.B, [{ identity: "beta" }, { user: "beta home starts" }, { assistant: "ok" }]);

	idDir = join(root, "identities");
	const role = (id, json, about) => {
		mkdirSync(join(idDir, id), { recursive: true });
		writeFileSync(join(idDir, id, "identity.json"), JSON.stringify({ id, ...json }, null, "\t"));
		writeFileSync(join(idDir, id, "about.md"), about);
		writeFileSync(join(idDir, id, "notebook.md"), "");
	};
	role("alpha", { title: "Alpha desk", homeChat: files.A }, "# Alpha desk\n\n**Focus:** the alpha checks.\n");
	role("beta", { title: "Beta desk", homeChat: files.B }, "# Beta desk\n\n**Focus:** beta answers.\n");
}

const srv = await ownServer({
	name: "role-messages-fyi",
	verbose: !!process.env.ROLEMSG_DEBUG,
	mock: reply,
	prepare: seed,
	env: {
		get PI_IDENTITY_DIR() {
			return idDir;
		},
		PI_IDENTITY_REINDEX: "0",
	},
});

// ---- a window -------------------------------------------------------------------------------------
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
				if (this.state?.rev === message.baseRev && message.conversationId === this.state.conversationId) {
					const messages = [...(this.state.messages ?? []), ...(message.appended ?? [])];
					this.state = { ...this.state, ...message.state, messages };
				} else this.send({ type: "get_state" });
			}
		});
	}
	static async connect(name) {
		const ws = new WebSocket(srv.ws);
		await new Promise((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		const client = new Client(ws);
		client.send({ type: "hello", clientId: `${name}-${Date.now()}` });
		if (!(await waitFor(() => client.received.some((m) => m.type === "ready"), 40000, 50))) throw new Error("no ready");
		if (!(await waitFor(() => client.state?.conversationId, 15000, 50))) throw new Error("no snapshot");
		return client;
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	async open(file) {
		this.send({ type: "switch_session", path: file });
		if (!(await waitFor(() => this.state?.sessionFile === file && this.state.isStreaming === false, 20000))) {
			throw new Error(`couldn't open ${file}`);
		}
	}
	async prompt(text, timeout = 30000) {
		const file = this.state.sessionFile;
		const before = file ? entries(file).length : 0;
		this.send({ type: "prompt", text });
		const done = await waitFor(() => {
			const f = this.state.sessionFile;
			if (!f || this.state.isStreaming !== false) return false;
			const after = entries(f);
			return (
				after.length > before && after.at(-1)?.role === "assistant" && after.slice(before).some((m) => m.text === text)
			);
		}, timeout);
		if (!done) throw new Error(`no answer to "${text.slice(0, 40)}"`);
	}
	async roleMessages() {
		const n = this.received.length;
		this.send({ type: "role_messages_get" });
		const msg = await waitFor(() => this.received.slice(n).find((m) => m.type === "role_messages"), 10000, 50);
		if (!msg) throw new Error("no role_messages answer");
		return msg;
	}
	close() {
		try {
			this.ws.close();
		} catch {
			/* gone */
		}
	}
}

/** The transcript's lines, parsed. */
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
/** The transcript's messages: { role, text }. */
const entries = (file) =>
	lines(file)
		.filter((e) => e.type === "message")
		.map((e) => ({ role: e.message?.role, text: textOf(e.message) }));
/** The transcript as kinds in order: "user" / "assistant" / "toolResult" / "note" (a role-message entry). */
const timeline = (file) =>
	lines(file)
		.filter((e) => e.type === "message" || (e.type === "custom_message" && e.customType === "role-message"))
		.map((e) =>
			e.type === "message" ? { kind: e.message?.role, text: textOf(e.message) } : { kind: "note", text: textOf(e) },
		);
const notesWith = (file, mark) => timeline(file).filter((m) => m.kind === "note" && m.text.includes(mark));
const userRoleMessagesWith = (file, mark) =>
	entries(file).filter((m) => m.role === "user" && m.text.startsWith("[Role message rm-") && m.text.includes(mark));
const toolResultsIn = (file) =>
	entries(file)
		.filter((m) => m.role === "toolResult")
		.map((m) => m.text);
/** The window's last message whose text has `mark`. */
const uiMessageWith = (w, mark) =>
	[...(w.state.messages ?? [])]
		.reverse()
		.find((m) => (m.content ?? []).some((b) => typeof b.text === "string" && b.text.includes(mark)));
/** Nothing after the note: no turn started from it. */
const nothingAfter = (file, mark) => {
	const t = timeline(file);
	const i = t.findIndex((m) => m.kind === "note" && m.text.includes(mark));
	return i >= 0 && i === t.length - 1;
};
const rowWith = async (w, mark) => (await w.roleMessages()).messages.find((r) => r.firstLine.includes(mark));

let w;
let w2;
try {
	w = await Client.connect("rolefyi-w");
	await w.open(files.A);

	// 1. An fyi to beta's closed home chat.
	await w.prompt(`SEND ${JSON.stringify({ to: "beta", kind: "fyi", text: "FYI-CLOSED-1 the build is green" })}`);
	check(
		"the sender hears it's added without a turn",
		toolResultsIn(files.A).some((t) =>
			/^Sent rm-[0-9a-f]{8} \(fyi to beta\)\. It's added to its home chat without starting a turn; that chat reads it with its next message\./.test(
				t,
			),
		),
		toolResultsIn(files.A).at(-1)?.slice(0, 120),
	);
	const closedIn = await waitFor(() => notesWith(files.B, "FYI-CLOSED-1").length === 1, 45000);
	check("beta's closed home chat gets it as a role-message entry", !!closedIn);
	check("not as a user message", userRoleMessagesWith(files.B, "FYI-CLOSED-1").length === 0);
	const row1 = await waitFor(async () => {
		const r = await rowWith(w, "FYI-CLOSED-1");
		return r?.state === "delivered" ? r : null;
	}, 30000);
	check("the store says delivered, to beta's home chat", row1?.toChat === "home chat", JSON.stringify(row1?.state));
	await sleep(2500);
	check("beta's model gets no call for it", seen.betaCalls === 0, `${seen.betaCalls} calls`);
	check("and no turn follows it in beta's transcript", nothingAfter(files.B, "FYI-CLOSED-1"));

	// 2. An fyi to beta's open, idle home chat.
	w2 = await Client.connect("rolefyi-w2");
	await w2.open(files.B);
	const shownOnOpen = uiMessageWith(w2, "FYI-CLOSED-1");
	check(
		"opening beta's chat shows the first one as a role-message card",
		shownOnOpen?.role === "custom" &&
			shownOnOpen?.roleMessage?.kind === "fyi" &&
			shownOnOpen.roleMessage.from === "alpha",
		JSON.stringify({ role: shownOnOpen?.role, card: !!shownOnOpen?.roleMessage }),
	);
	await w.prompt(`SEND ${JSON.stringify({ to: "beta", kind: "fyi", text: "FYI-IDLE-2 the deploy is done" })}`);
	const card = await waitFor(() => {
		const m = uiMessageWith(w2, "FYI-IDLE-2");
		return m?.roleMessage ? m : null;
	}, 45000);
	check(
		"the open chat shows it at once as a card from alpha, fyi",
		card?.role === "custom" &&
			card.customType === "role-message" &&
			card.roleMessage.from === "alpha" &&
			card.roleMessage.fromChat === "home chat" &&
			card.roleMessage.kind === "fyi" &&
			card.roleMessage.text === "FYI-IDLE-2 the deploy is done",
		JSON.stringify({ role: card?.role, kind: card?.roleMessage?.kind }),
	);
	await sleep(2500);
	check("the open chat doesn't start a turn", w2.state.isStreaming === false && nothingAfter(files.B, "FYI-IDLE-2"));
	check("beta's model still gets no call", seen.betaCalls === 0, `${seen.betaCalls} calls`);
	check(
		"the store says delivered",
		(await rowWith(w, "FYI-IDLE-2"))?.state === "delivered",
		(await rowWith(w, "FYI-IDLE-2"))?.state,
	);

	// 3. The next typed message's turn reads them.
	await w2.prompt("TYPED-AFTER-FYI");
	check("the typed message makes one model call", seen.betaCalls === 1, `${seen.betaCalls} calls`);
	check("its context carries the first FYI", seen.typedSawFyi1 === true);
	check("and the second", seen.typedSawFyi2 === true);
	check("no turn ever started from an FYI", seen.fyiStartedTurn === false);
	await sleep(2000);
	const rows = (await w.roleMessages()).messages.filter((r) => /FYI-(CLOSED-1|IDLE-2)/.test(r.firstLine));
	check(
		"each FYI is delivered exactly once",
		rows.length === 2 &&
			rows.every((r) => r.state === "delivered") &&
			notesWith(files.B, "FYI-CLOSED-1").length === 1 &&
			notesWith(files.B, "FYI-IDLE-2").length === 1,
		JSON.stringify(rows.map((r) => r.state)),
	);

	// 4. A request still starts a turn at once.
	const callsBefore = seen.betaCalls;
	await w.prompt(`SEND ${JSON.stringify({ to: "beta", kind: "request", text: "REQ-NOW-3 please check" })}`);
	const answered = await waitFor(() => {
		const all = entries(files.B);
		const i = all.findIndex((m) => m.role === "user" && m.text.includes("REQ-NOW-3"));
		return i >= 0 && all.slice(i + 1).some((m) => m.role === "assistant" && m.text.startsWith("noted"));
	}, 45000);
	check("a request arrives as a message and is answered at once", !!answered && seen.betaCalls > callsBefore);
} catch (error) {
	check("the run finished", false, error instanceof Error ? error.message : String(error));
} finally {
	w?.close();
	w2?.close();
	await srv.stop();
}
if (failures > 0) {
	// What the store says about each message (the service's own record, not what went to the model).
	try {
		const store = JSON.parse(readFileSync(join(srv.dataDir, "role-messages.json"), "utf8"));
		for (const m of store.messages ?? []) {
			console.log(
				`  ${m.id} ${m.kind} ${m.from?.role}->${m.to?.role} ${m.state} sends ${m.sends} attempts ${m.attempts}${m.error ? ` error: ${m.error}` : ""} | ${String(m.text).split("\n")[0].slice(0, 40)}`,
			);
		}
	} catch (err) {
		console.log(`store: unreadable (${err instanceof Error ? err.message : String(err)})`);
	}
}
console.log(failures === 0 ? "role-messages-fyi: all passed" : `role-messages-fyi: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
