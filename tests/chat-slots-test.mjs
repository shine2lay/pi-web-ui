/**
 * chat-slots (Ops #266, docs/chat-slots.md): blank chats don't take one of a project's 40 slots and close
 * by themselves; chats in use still stop at 40, with the one message.
 *   1. 30 pseudo clients (a look check's carry-on:… ids) connect and leave: the open count is back at once,
 *      and a new chat opens.
 *   2. 39 chats in use plus blank ones held by connected windows: a new chat still opens.
 *   3. 40 chats in use: a new chat and a 41st saved chat are refused with the new message.
 *   4. A window whose blank chat closed while it was away (the sweep) comes back to a fresh blank chat,
 *      even in a full project, with no warning; blank chats of connected windows are never closed.
 * No model/provider or prompt: disposable saved transcripts, normal WS operations and the counts-only
 * GET /api/open-chats. Run through tests/run-sealed.mjs after building.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { portUp } from "./lib/port-utils.mjs";

const PORT = 9127;
const LIMIT = 40; // Deliberate contract (owner, 2026-10-19: "raise it to 40"), independent of the production constant.
const FULL = "This project has 40 open chats, the most it can hold. Close one in the left list (✕) to open another.";
const IDLE_MS = 4000; // the sweep closes a blank chat no connected window had open for this long
const repo = fileURLToPath(new URL("..", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-web-chat-slots-"));
const work = join(base, "work");
const data = join(base, "data");
const agent = join(base, "agent");
const sessions = join(base, "sessions");
for (const path of [work, data, agent, sessions]) mkdirSync(path, { recursive: true });

function seed(index) {
	const id = `01a0c000-0000-7000-8266-${String(index).padStart(12, "0")}`;
	const timestamp = "2026-10-19T00:00:00.000Z";
	const rows = [
		{ type: "session", version: 3, id, timestamp, cwd: work },
		{
			type: "message",
			id: `user-${index}`,
			parentId: null,
			timestamp,
			message: { role: "user", content: [{ type: "text", text: "Saved fixture" }], timestamp: 1 },
		},
		{
			type: "message",
			id: `reply-${index}`,
			parentId: `user-${index}`,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Saved reply" }],
				api: "openai-completions",
				provider: "fixture",
				model: "never-called",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
		},
	];
	const file = join(sessions, `2026-10-19T00-00-00-000Z_${id}.jsonl`);
	writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	return file;
}

async function waitFor(predicate, label, ms = 30_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await predicate()) return;
		await sleep(25);
	}
	throw new Error(`Timed out: ${label}`);
}

/** The project's open chats, counts only: { open, counted, blank }. */
async function counts() {
	const res = await fetch(`http://127.0.0.1:${PORT}/api/open-chats`);
	assert.equal(res.status, 200, "GET /api/open-chats");
	const body = await res.json();
	assert.equal(body.limit, LIMIT);
	const row = body.projects.find((p) => p.cwd === work) ?? { open: 0, counted: 0, blank: 0 };
	return { open: row.open, counted: row.counted, blank: row.blank };
}

async function expectCounts(expected, label, ms = 5000) {
	let last;
	try {
		await waitFor(
			async () => {
				last = await counts();
				return last.open === expected.open && last.counted === expected.counted && last.blank === expected.blank;
			},
			label,
			ms,
		);
	} catch {
		assert.deepEqual(last, expected, label);
	}
}

/** One window (or pseudo client) on the WS: keeps only UI metadata, never settings, tools or message bodies. */
class Client {
	constructor(clientId) {
		this.clientId = clientId;
		this.state = {};
		this.events = [];
	}

	async connect() {
		this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		this.ws.on("message", (raw) => {
			const m = JSON.parse(raw.toString());
			if (m.type === "snapshot" || m.type === "snapshot_delta") {
				this.state = {
					conversationId: m.state?.conversationId ?? this.state.conversationId,
					sessionFile: m.state?.sessionFile ?? this.state.sessionFile,
				};
			} else if (["switch_done", "switch_failed", "notice", "ready"].includes(m.type)) {
				this.events.push({
					type: m.type,
					level: m.level,
					target: m.target,
					text: m.text ?? m.error,
					textEn: m.textEn ?? m.errorEn,
				});
			}
		});
		await once(this.ws, "open");
		this.send({ type: "hello", clientId: this.clientId });
		await waitFor(() => this.state.conversationId, `${this.clientId}: first chat`);
		return this;
	}

	send(message) {
		this.ws.send(JSON.stringify(message));
	}

	async close() {
		const closed = once(this.ws, "close");
		this.ws.close();
		await closed;
	}

	async switchTo(path, succeeds = true) {
		const start = this.events.length;
		const receipt = () =>
			this.events
				.slice(start)
				.find((e) => (e.type === "switch_done" || e.type === "switch_failed") && e.target?.path === path);
		this.send({ type: "switch_session", path });
		await waitFor(() => receipt(), `${this.clientId}: switch receipt`);
		assert.equal(receipt().type, succeeds ? "switch_done" : "switch_failed");
		if (succeeds) await waitFor(() => this.state.sessionFile === path, `${this.clientId}: on the saved chat`);
		return receipt();
	}

	/** A new chat: resolves with the new chat's id, or with the notice that refused it. */
	async newChat() {
		const before = this.state.conversationId;
		const start = this.events.length;
		this.send({ type: "new_chat" });
		let notice;
		await waitFor(() => {
			notice = this.events.slice(start).find((e) => e.type === "notice" && e.level !== "info");
			return notice || this.state.conversationId !== before;
		}, `${this.clientId}: new chat`);
		return notice ? { refused: notice } : { id: this.state.conversationId };
	}
}

let server;
const clients = [];
async function connect(clientId) {
	const c = new Client(clientId);
	clients.push(c);
	return c.connect();
}

try {
	assert.equal(await portUp(PORT), false, "isolated port must be free");
	const files = Array.from({ length: LIMIT + 1 }, (_, i) => seed(i + 1));
	server = spawn(process.execPath, ["dist/server/index.js"], {
		cwd: repo,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: data,
			PI_WEB_CWD: work,
			PI_CODING_AGENT_DIR: agent,
			PI_CODING_AGENT_SESSION_DIR: sessions,
			PI_WEB_BLANK_CHAT_IDLE_MS: String(IDLE_MS),
			PI_WEB_BLANK_CHAT_SWEEP_MS: "250",
		},
		stdio: "ignore",
	});
	await waitFor(() => portUp(PORT), "isolated server");

	// The owner's window, on a saved chat.
	const main = await connect("sealed-chat-slots-main");
	await main.switchTo(files[0]);
	const baseline = { open: 1, counted: 1, blank: 0 };
	await expectCounts(baseline, "baseline: one chat in use");

	// 1. A look run's worth of pseudo clients, ten times over.
	const looks = await Promise.all(Array.from({ length: 30 }, (_, i) => connect(`carry-on:sealed-look-${i}`)));
	assert.equal(new Set(looks.map((l) => l.state.conversationId)).size, 30, "each pseudo client has its own blank chat");
	await expectCounts({ open: 31, counted: 1, blank: 30 }, "30 pseudo clients: their blank chats take no slot");
	await Promise.all(looks.map((l) => l.close()));
	const left = Date.now();
	await expectCounts(baseline, "pseudo clients left: the open count is back", 1000);
	console.log(
		`PASS: 30 pseudo clients came and went; the open count was back in ${Date.now() - left} ms (not the sweep)`,
	);
	const fresh = await main.newChat();
	assert.ok(fresh.id, `a new chat opens (${fresh.refused?.textEn ?? ""})`);
	await main.switchTo(files[0]);
	await expectCounts(baseline, "main back on its saved chat");
	console.log("PASS: a new chat opens after them");

	// 2. 39 chats in use plus blank chats of connected windows: a new chat still opens.
	// Each saved chat stays open because a window shows it (a lone window may release the chat it leaves).
	const viewers = [];
	async function keepOpen(file) {
		const viewer = await connect(`sealed-chat-slots-viewer-${viewers.length}`);
		await viewer.switchTo(file);
		viewers.push(viewer);
	}
	for (const file of files.slice(0, LIMIT - 1)) await keepOpen(file);
	// A new window lands on the project's latest chat; from a saved chat, new_chat gives it a blank chat of its own.
	async function blankWindow(clientId) {
		const window = await connect(clientId);
		await window.switchTo(files[0]);
		const opened = await window.newChat();
		assert.ok(opened.id, `${clientId} has a blank chat of its own (${opened.refused?.textEn ?? ""})`);
		return { window, id: opened.id };
	}
	const blanks = [];
	for (let i = 0; i < 5; i++) blanks.push((await blankWindow(`sealed-chat-slots-blank-${i}`)).window);
	// Last, so no later window lands on its blank chat (a window that leaves a chat another one shows lists it).
	const { window: returning, id: awayId } = await blankWindow("sealed-chat-slots-returning");
	await expectCounts({ open: 45, counted: 39, blank: 6 }, "39 chats in use and 6 blank ones");
	const extra = await main.newChat();
	assert.ok(extra.id, `with 39 in use and 6 blank, a new chat opens (${extra.refused?.textEn ?? ""})`);
	await expectCounts({ open: 46, counted: 39, blank: 7 }, "the new chat is blank and takes no slot");
	console.log("PASS: 39 chats in use plus 6 blank ones: a new chat still opens (blank chats take no slot)");

	// 3. 40 chats in use: the new message, the same on every route.
	await main.switchTo(files[LIMIT - 1]);
	await keepOpen(files[LIMIT - 1]);
	await expectCounts({ open: 46, counted: 40, blank: 6 }, "40 chats in use");
	const onFull = main.state.conversationId;
	const refused = await main.newChat();
	assert.equal(refused.refused?.textEn, FULL, "new chat refused with the new message");
	assert.equal(refused.refused?.text, FULL);
	assert.equal(main.state.conversationId, onFull, "the refused new chat leaves the window where it was");
	const failed = await main.switchTo(files[LIMIT], false);
	assert.equal(failed.textEn, FULL, "a 41st saved chat is refused with the same message");
	assert.equal(failed.text, FULL);
	assert.equal(main.state.conversationId, onFull);
	console.log("PASS: 40 chats in use: a new chat and a 41st saved chat are refused with the new message");

	// 4. The returning window's blank chat closes while it is away; it comes back to a fresh one.
	await returning.close();
	const gone = Date.now();
	assert.deepEqual(
		await counts(),
		{ open: 46, counted: 40, blank: 6 },
		"a window's blank chat stays while it may come back",
	);
	await expectCounts({ open: 45, counted: 40, blank: 5 }, "the sweep closed the away window's blank chat", 15_000);
	const after = Date.now() - gone;
	assert.ok(after >= IDLE_MS - 1000, `the sweep waited the idle time (closed after ${after} ms)`);
	console.log(
		`PASS: the sweep closed the away window's blank chat after ${after} ms; connected windows' blank chats stayed`,
	);
	const back = new Client("sealed-chat-slots-returning");
	clients.push(back);
	await back.connect();
	assert.notEqual(back.state.conversationId, awayId, "a fresh blank chat, not the closed one");
	await sleep(500);
	const complaints = back.events.filter(
		(e) => e.type === "switch_failed" || (e.type === "notice" && (e.level === "warning" || e.level === "error")),
	);
	assert.deepEqual(complaints, [], "coming back shows no warning or error");
	await expectCounts(
		{ open: 46, counted: 40, blank: 6 },
		"the returning window has a blank chat again, even in a full project",
	);
	for (const window of blanks) assert.ok(window.state.conversationId, "blank windows still on their chats");
	console.log("PASS: the window came back to a fresh blank chat in a full project, with no warning");
} catch (error) {
	console.error(`FAIL: ${error.message}`);
	process.exitCode = 1;
} finally {
	for (const c of clients) c.ws?.terminate();
	if (server && server.exitCode === null) {
		const ended = once(server, "exit");
		server.kill("SIGTERM");
		await Promise.race([ended, sleep(5000)]);
		if (server.exitCode === null && server.signalCode === null) {
			server.kill("SIGKILL");
			await ended;
		}
	}
	rmSync(base, { recursive: true, force: true });
}
