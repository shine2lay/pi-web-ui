/**
 * company-team-capacity: sixteen saved role chats can stay open, the seventeenth
 * is refused non-destructively, and existing exemptions/recovery still work.
 * No model/provider or prompt: only disposable saved transcripts and normal WS operations.
 * Run through tests/run-sealed.mjs after building.
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

const PORT = 9126;
const LIMIT = 16; // Deliberate contract, independent of the production constant.
const repo = fileURLToPath(new URL("..", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-web-conversation-capacity-"));
const work = join(base, "work");
const otherWork = join(base, "other-work");
const data = join(base, "data");
const agent = join(base, "agent");
const sessions = join(base, "sessions");
for (const path of [work, otherWork, data, agent, sessions]) mkdirSync(path, { recursive: true });

function seed(index, cwd = work) {
	const id = `01a0c000-0000-7000-8000-${String(index).padStart(12, "0")}`;
	const timestamp = "2026-10-02T00:00:00.000Z";
	const rows = [
		{ type: "session", version: 3, id, timestamp, cwd },
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
	const file = join(sessions, `2026-10-02T00-00-00-000Z_${id}.jsonl`);
	writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	return file;
}

async function waitFor(predicate, label) {
	const end = Date.now() + 30_000;
	while (Date.now() < end) {
		if (await predicate()) return;
		await sleep(25);
	}
	throw new Error(`Timed out: ${label}`);
}

let server;
let ws;
let state;
const events = [];
const viewers = new Map();
// Browsers viewing each role keep its runtime open under the existing lifecycle.
// A lone browser merely browsing history is allowed to release the old idle chat.
async function keepOpen(file) {
	const viewer = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	viewers.set(file, viewer);
	let opened = false;
	viewer.on("message", (raw) => {
		const message = JSON.parse(raw.toString());
		if (message.type === "switch_done" && message.target?.path === file) opened = true;
	});
	await once(viewer, "open");
	viewer.send(JSON.stringify({ type: "hello", clientId: `capacity-viewer-${viewers.size}` }));
	viewer.send(JSON.stringify({ type: "switch_session", path: file }));
	await waitFor(() => opened, "role viewer");
}
// Retain only UI metadata, never settings, tools, model requests or message bodies.
function observe(raw) {
	const message = JSON.parse(raw.toString());
	if (message.type === "snapshot" || message.type === "snapshot_delta") {
		state = {
			conversationId: message.state?.conversationId ?? state?.conversationId,
			sessionFile: message.state?.sessionFile ?? state?.sessionFile,
			isEphemeral: message.state?.isEphemeral ?? state?.isEphemeral,
		};
	} else if (["switch_done", "switch_failed", "notice", "ready"].includes(message.type)) {
		events.push({ type: message.type, target: message.target, text: message.text, textEn: message.textEn });
	}
}
const send = (message) => ws.send(JSON.stringify(message));
async function switchTo(path, succeeds = true) {
	const start = events.length;
	send({ type: "switch_session", path });
	await waitFor(
		() =>
			events
				.slice(start)
				.some((event) => /^(switch_done|switch_failed)$/.test(event.type) && event.target?.path === path),
		"history switch receipt",
	);
	const receipt = events
		.slice(start)
		.find((event) => /^(switch_done|switch_failed)$/.test(event.type) && event.target?.path === path);
	assert.equal(receipt.type, succeeds ? "switch_done" : "switch_failed");
	if (succeeds) assert.equal(state.sessionFile, path);
}

try {
	assert.equal(await portUp(PORT), false, "isolated port must be free");
	const files = Array.from({ length: LIMIT + 1 }, (_, index) => seed(index + 1));
	const other = seed(100, otherWork);
	server = spawn(process.execPath, ["dist/server/index.js"], {
		cwd: repo,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: data,
			PI_WEB_CWD: work,
			PI_CODING_AGENT_DIR: agent,
			PI_CODING_AGENT_SESSION_DIR: sessions,
		},
		stdio: "ignore",
	});
	await waitFor(() => portUp(PORT), "isolated server");
	ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	ws.on("message", observe);
	await once(ws, "open");
	send({ type: "hello", clientId: "sealed-company-capacity" });
	await waitFor(() => state?.conversationId, "initial blank chat");

	const ids = new Map();
	for (const file of files.slice(0, LIMIT)) {
		await switchTo(file);
		ids.set(file, state.conversationId);
		await keepOpen(file);
	}
	assert.equal(new Set(ids.values()).size, LIMIT);
	console.log("PASS: sixteen distinct saved chats opened without a model call");

	const atLimit = state.conversationId;
	await switchTo(files[LIMIT], false);
	assert.equal(state.conversationId, atLimit, "refused history open preserves the current chat");
	const mark = events.length;
	send({ type: "new_chat" });
	await waitFor(
		() =>
			events
				.slice(mark)
				.some(
					(event) => event.type === "notice" && /max open conversations \(16\)/.test(event.textEn ?? event.text ?? ""),
				),
		"new-chat cap notice",
	);
	assert.equal(state.conversationId, atLimit);
	console.log("PASS: history and new-chat routes refuse the seventeenth without displacement");

	for (const file of files.slice(0, LIMIT)) {
		await switchTo(file);
		assert.equal(state.conversationId, ids.get(file), "reopen reuses its runtime at capacity");
	}
	console.log("PASS: all sixteen runtimes survive; reopening does not duplicate them");

	send({ type: "new_chat", ephemeral: true });
	await waitFor(() => state?.isEphemeral === true, "ephemeral exemption");
	await switchTo(files[0]);
	assert.equal(state.conversationId, ids.get(files[0]));
	await switchTo(other);
	await switchTo(files[0]);
	assert.equal(state.conversationId, ids.get(files[0]));
	console.log("PASS: ephemeral chat exemption and separate project capacity are unchanged");

	const secondViewer = viewers.get(files[1]);
	const closed = once(secondViewer, "close");
	secondViewer.close();
	await closed;
	send({ type: "dismiss_conversation", id: ids.get(files[1]) });
	await switchTo(files[LIMIT]);
	assert.ok(![...ids.values()].includes(state.conversationId));
	await switchTo(files[0]);
	assert.equal(state.conversationId, ids.get(files[0]));
	console.log("PASS: releasing one slot allows a safe retry without replacing another chat");
} catch (error) {
	console.error(`FAIL: ${error.message}`);
	process.exitCode = 1;
} finally {
	for (const viewer of viewers.values()) viewer.terminate();
	ws?.terminate();
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
