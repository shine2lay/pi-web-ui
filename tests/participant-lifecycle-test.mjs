// Passive Team recovery against a real, sealed host. No model or real conversations.
// node tests/run-sealed.mjs --no-build participant-lifecycle
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { ownServer } from "./lib/own-server.mjs";

const sessions = new Map();
let idsDir;
let pluginDir;
const roles = ["product", "design", "architecture", "qa"];
const required = roles.map((role) => ({ sessionId: randomUUID(), role }));
const capacity = Array.from({ length: 17 }, () => ({ sessionId: randomUUID(), role: "qa" }));
const wrong = { sessionId: randomUUID(), role: "qa" };
const missing = { sessionId: randomUUID(), role: "qa" };
const corrupt = { sessionId: randomUUID(), role: "qa" };

function seed(agentDir, cwd, target, role = target.role, broken = false) {
	const dir = join(agentDir, "sessions", "fixture");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `2026-10-02T00-00-00-000Z_${target.sessionId}.jsonl`);
	const timestamp = "2026-10-02T00:00:00.000Z";
	const rows = [
		{ type: "session", version: 3, id: target.sessionId, timestamp, cwd },
		{
			type: "custom",
			id: "identity",
			parentId: null,
			timestamp,
			customType: "identity",
			data: { v: 1, id: role, via: "owner" },
		},
		{
			type: "message",
			id: "question",
			parentId: "identity",
			timestamp,
			message: { role: "user", content: [{ type: "text", text: "Sealed fixture" }], timestamp: 1 },
		},
		{
			type: "message",
			id: "answer",
			parentId: broken ? "answer" : "question",
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Fixture reply" }],
				api: "openai-completions",
				provider: "fixture",
				model: "fixture",
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
	writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
	sessions.set(target.sessionId, path);
}

async function until(fn, label, timeout = 60_000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const value = await fn();
		if (value) return value;
		await sleep(50);
	}
	throw new Error(`Timed out: ${label}`);
}

const env = { PI_WEB_PLUGIN_CATALOG_URL: "off", PI_IDENTITY_DIR: "" };
const server = await ownServer({
	name: "participant-lifecycle",
	model: "none",
	env,
	prepare({ root, dataDir, agentDir, workdir }) {
		idsDir = join(root, "identities");
		// The host and the test both get this isolated identity directory, never the owner's.
		env.PI_IDENTITY_DIR = idsDir;
		for (const role of roles) {
			const dir = join(idsDir, role);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "identity.json"), JSON.stringify({ id: role, title: role, folder: workdir }));
		}
		for (const target of [...required, ...capacity]) seed(agentDir, workdir, target);
		seed(agentDir, workdir, wrong, "design");
		seed(agentDir, workdir, corrupt, "qa", true);
		const noTurn = join(root, "no-turn.mjs");
		writeFileSync(
			noTurn,
			`export default function(pi) {
  const forbidden = () => { globalThis.__participantTurns = (globalThis.__participantTurns || 0) + 1; throw new Error("Passive recovery attempted a model turn or identity write"); };
  pi.on("before_agent_start", forbidden);
  // Production routes require the identity extension; expose its command but forbid invoking it.
  pi.registerCommand("identity", { description: "Sealed identity fixture", handler: forbidden });
}`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: [], extensions: [noTurn], retry: { enabled: false } }),
		);
		pluginDir = join(dataDir, "plugins", "participant-fixture");
		mkdirSync(pluginDir, { recursive: true });
		writeFileSync(join(pluginDir, "targets.json"), JSON.stringify(required));
		writeFileSync(
			join(pluginDir, "manifest.json"),
			JSON.stringify({
				id: "participant-fixture",
				name: "Participant fixture",
				apiVersion: 2,
				permissions: ["http", "participants"],
			}),
		);
		writeFileSync(
			join(pluginDir, "index.mjs"),
			`
import { readFileSync, writeFileSync } from "node:fs";
const file = new URL("./targets.json", import.meta.url);
export default { activate(host) {
  const lease = host.retainParticipantRoutes(() => JSON.parse(readFileSync(file, "utf8")));
  const state = () => ({ routes: host.participantRoutes(), turns: globalThis.__participantTurns || 0 });
  host.route("GET", "/state", (_req, res) => res.json(state()));
  host.route("POST", "/refresh", async (_req, res) => { await lease.refresh(); res.json(state()); });
  host.route("POST", "/targets", async (req, res) => { writeFileSync(file, JSON.stringify(req.body.targets)); await lease.refresh(); res.json(state()); });
  host.route("POST", "/dispose", (_req, res) => { lease.dispose(); res.json(state()); });
  void lease.refresh();
} };
`,
		);
	},
});

const clients = [];
async function api(path, body) {
	const res = await fetch(`${server.http}/plugins-api/participant-fixture/${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { "Content-Type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	assert.equal(res.status, 200, `fixture endpoint ${path}`);
	return res.json();
}
async function open(name) {
	const socket = new WebSocket(server.ws);
	const client = { socket, state: null, notices: [], switches: [] };
	socket.on("message", (raw) => {
		const m = JSON.parse(String(raw));
		if (m.type === "snapshot") client.state = m.state;
		if (m.type === "snapshot_delta" && client.state?.conversationId === m.conversationId)
			client.state = { ...client.state, ...m.state };
		if (m.type === "notice") client.notices.push(m);
		if (m.type === "switch_done") client.switches.push(m);
	});
	await new Promise((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	socket.send(JSON.stringify({ type: "hello", clientId: name }));
	await until(() => client.state?.conversationId, "browser session initialized");
	clients.push(client);
	return client;
}
async function awaitPlugin() {
	// This host activates installed plugins on UI attach, not merely on HTTP listen.
	await until(
		async () => (await fetch(`${server.http}/plugins-api/participant-fixture/state`)).ok,
		"installed participant plugin activated",
	);
}
const send = (client, message) => client.socket.send(JSON.stringify(message));
const contains = (state, targets) =>
	targets.every((t) => state.routes.some((r) => r.sessionId === t.sessionId && r.role === t.role));

try {
	const a = await open("participant-browser-a");
	await awaitPlugin();
	await api("refresh", {});
	assert(contains(await api("state"), required), "activation restored the four exact assignments");
	console.log("PASS: unopened assigned sessions become reachable without opening their chats");
	const b = await open("participant-browser-b");
	const target = required[2];
	send(a, { type: "switch_session", path: sessions.get(target.sessionId) });
	send(b, { type: "switch_session", path: sessions.get(target.sessionId) });
	await until(
		() => a.state?.sessionId === target.sessionId && b.state?.sessionId === target.sessionId,
		"both browsers opened Architecture",
	);
	assert.equal(a.state.conversationId, b.state.conversationId);
	const conversationId = a.state.conversationId;
	send(a, { type: "new_chat" });
	send(b, { type: "new_chat" });
	await until(
		() => a.state?.conversationId !== conversationId && b.state?.conversationId !== conversationId,
		"both browsers navigated away",
	);
	assert(contains(await api("refresh", {}), required));
	send(a, { type: "dismiss_conversation", id: conversationId, force: true });
	await until(
		() => a.notices.some((n) => /bound Team participant/.test(n.textEn || n.text)),
		"assigned worker dismissal is refused",
	);
	assert(contains(await api("state"), required));
	console.log("PASS: navigation and dismissal preserve assigned workers with one shared runtime");

	const untouched = a.state.conversationId;
	const invalid = await api("targets", { targets: [...required, wrong, missing, corrupt] });
	assert(contains(invalid, required));
	assert(!invalid.routes.some((r) => [wrong.sessionId, missing.sessionId, corrupt.sessionId].includes(r.sessionId)));
	assert.equal(a.state.conversationId, untouched);
	assert.equal(invalid.turns, 0);
	console.log("PASS: missing, mismatched and corrupt sessions fail closed without stealing browser focus");

	const racing = api("targets", { targets: [...required, capacity[0]] });
	send(a, { type: "switch_session", path: sessions.get(capacity[0].sessionId) });
	send(b, { type: "switch_session", path: sessions.get(capacity[0].sessionId) });
	await racing;
	await until(
		() => a.state?.sessionId === capacity[0].sessionId && b.state?.sessionId === capacity[0].sessionId,
		"cold open raced with recovery",
	);
	assert.equal(a.state.conversationId, b.state.conversationId);
	console.log("PASS: simultaneous browser opens and background recovery use one runtime");

	const full = await api("targets", { targets: [...required, ...capacity] });
	assert(full.routes.length <= 16, "open-chat capacity is respected");
	assert(full.routes.filter((r) => capacity.some((c) => c.sessionId === r.sessionId)).length < capacity.length);
	assert.equal(full.turns, 0);
	console.log("PASS: passive recovery respects the per-project open-chat limit");

	await api("targets", { targets: required });
	for (const client of clients) client.socket.close();
	await server.restart();
	await open("participant-browser-after-restart");
	await awaitPlugin();
	await until(
		async () => contains(await api("state"), required),
		"restart recovered bound sessions without role navigation",
	);
	assert.equal((await api("state")).turns, 0);
	for (const target of required) {
		const rows = readFileSync(sessions.get(target.sessionId), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(rows[0].id, target.sessionId);
		assert.equal(rows.filter((r) => r.type === "message").length, 2);
	}
	console.log("PASS: restart restores exact identities without adding a message or starting a model turn");
	await api("dispose", {});
	const released = await open("released-lease-browser");
	send(released, { type: "switch_session", path: sessions.get(required[3].sessionId) });
	await until(() => released.state?.sessionId === required[3].sessionId, "open released participant");
	const releasedId = released.state.conversationId;
	send(released, { type: "new_chat" });
	await until(() => released.state?.conversationId !== releasedId, "navigate off released participant");
	send(released, { type: "dismiss_conversation", id: releasedId, force: true });
	await until(
		async () => !(await api("state")).routes.some((r) => r.sessionId === required[3].sessionId),
		"disposed lease no longer pins worker",
	);
	console.log("PASS: unloading the lease releases its retention without deleting the saved chat");
} catch (error) {
	console.error("Sealed participant state:", JSON.stringify(await api("state").catch(() => null)));
	console.error("Sealed host errors:", server.stderr());
	throw error;
} finally {
	for (const client of clients) client.socket.close();
	await server.stop();
	rmSync(server.root, { recursive: true, force: true });
}
