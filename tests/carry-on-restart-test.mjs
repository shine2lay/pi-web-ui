/* carry-on E2E (no tokens): pi-web-ui restarts right away, and the chats it cut off carry on.
 *
 * A mock OpenAI-compatible model plays the agent in six chats of a sealed test server:
 *   IDLE   answered and finished before the restart          → must get nothing
 *   STOP   stopped by the user before the restart            → must get nothing
 *   REPLY  writing a long reply when the server goes down
 *   CMD    running a bash command (`sleep 60`)
 *   ASK    waiting for the user's answer (ask_user_question)
 *   QUEUE  working on pi-queue task #1 of 2 (the real pi-queue, PI_QUEUE_PKG, default ~/projects/pi-queue)
 * Each busy chat, told to carry on, keeps working (the mock makes it busy again), so the next
 * restart cuts it off again.
 *
 *   1. planned restart (SIGTERM, with pi-web-deploy's restart-reason.json): the 4 busy chats each
 *      get the carry-on note with the reason and their own step; the queue carries on (task #1 done,
 *      #2 starts); a window that connects hears it; the list of working chats is live.
 *   2. crash (kill -9): the notes say it crashed; the cut-off count goes up (the queue chat's
 *      starts again, because its task #1 finished in between).
 *   3. planned restart without a reason: REPLY, CMD and ASK are now cut off for the 3rd time in a
 *      row: no note, a notice instead (loop guard); QUEUE (2nd time) gets its note.
 *   IDLE and STOP never get anything.
 *
 * Usage: npm run build:server && node tests/carry-on-restart-test.mjs [port]   (CARRY_DEBUG=1: server log)
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = Number(process.argv[2] || 30000 + Math.floor(Math.random() * 10000));
const MOCK_PORT = PORT + 1;
// The account's home (userInfo), not HOME: a sealed test run has a temp HOME.
const PI_QUEUE = process.env.PI_QUEUE_PKG ?? join(userInfo().homedir, "projects", "pi-queue");
if (!existsSync(join(PI_QUEUE, "package.json"))) {
	console.log(`✗ FAIL: pi-queue not found at ${PI_QUEUE} (set PI_QUEUE_PKG)`);
	process.exit(1);
}
const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-carry-on-")));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });
const NOTE = "pi-web-ui restarted at";

// ---------------------------------------------------------------------------
// The mock model
// ---------------------------------------------------------------------------

const textOf = (m) =>
	typeof m?.content === "string"
		? m.content
		: (m?.content
				?.filter?.((p) => p.type === "text")
				.map((p) => p.text)
				.join(" ") ?? "");

const mock = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	const payload = JSON.parse(body);
	const msgs = payload.messages ?? [];
	// (pi-web-ui adds a "Parallel-work notice" to the context when other chats of the project run.)
	const users = msgs
		.filter((m) => m.role === "user")
		.map(textOf)
		.filter((t) => !/parallel-work|并行|System reminder: \d+ other run/i.test(t));
	const first = users.find((t) => /^(IDLE|STOP|REPLY|CMD|ASK|QUEUE)-CHAT/.test(t)) ?? "";
	const last = msgs.at(-1);
	const lastUser = users.at(-1) ?? "";
	let closed = false;
	res.on("close", () => {
		closed = true;
	});
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const chunk = (delta, finish = null) =>
		res.write(
			`data: ${JSON.stringify({ id: "carry", object: "chat.completion.chunk", created: Date.now(), model: payload.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
		);
	const end = () => {
		if (closed) return;
		res.write("data: [DONE]\n\n");
		res.end();
	};
	const say = (text) => {
		chunk({ content: text });
		chunk({}, "stop");
		end();
	};
	const slow = async (tag, seconds = 90) => {
		for (let i = 0; i < seconds * 2 && !closed; i++) {
			chunk({ content: `${tag} ${i} ` });
			await sleep(500);
		}
		if (!closed) {
			chunk({}, "stop");
			end();
		}
	};
	const call = (name, args) => {
		const id = `call_${randomBytes(4).toString("hex")}`;
		chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
		chunk({}, "tool_calls");
		end();
	};
	const ask = () =>
		call("ask_user_question", {
			questions: [{ id: "pick", question: "Which one?", options: [{ label: "A" }, { label: "B" }] }],
		});
	const queueTask = Number(
		/\[Queue\] Task #(\d+)/.exec([...users].reverse().find((t) => t.includes("[Queue] Task #")) ?? "")?.[1] ?? 0,
	);

	if (last?.role === "tool") {
		// A tool finished: say so and end the turn.
		return say(`tool done (${first.slice(0, 9)})`);
	}
	// The first message of each chat gets a quick answer, so its transcript is on disk
	// (pi writes a chat's file once it has an answer).
	if (users.length <= 1) return say("hi");
	if (lastUser.startsWith(NOTE)) {
		// Told to carry on: pick the step back up (and stay busy for the next restart).
		if (first.startsWith("REPLY")) return slow("still writing");
		if (first.startsWith("CMD")) return call("bash", { command: "sleep 60" });
		if (first.startsWith("ASK")) return ask();
		if (first.startsWith("QUEUE")) {
			if (queueTask === 1) return call("queue_done", { summary: "Task one is finished after the restart." });
			return slow(`queue task ${queueTask}`);
		}
		return say("carried on");
	}
	if (lastUser.includes("[Queue] Task #")) return slow(`queue task ${queueTask}`);
	if (first.startsWith("REPLY")) return slow("writing");
	if (first.startsWith("STOP")) return slow("stoppable");
	if (first.startsWith("CMD")) return call("bash", { command: "sleep 60" });
	if (first.startsWith("ASK")) return ask();
	return say("hi");
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ main: { type: "api_key", key: "carry-on-test" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "carry-on-test",
				models: [{ id: "carry-mock", name: "Carry Mock", input: ["text"], contextWindow: 64000, maxTokens: 4096 }],
			},
		},
	}),
);
writeFileSync(
	join(agentDir, "settings.json"),
	JSON.stringify({ defaultProvider: "main", defaultModel: "carry-mock", packages: [PI_QUEUE] }),
);

// ---------------------------------------------------------------------------
// The server under test
// ---------------------------------------------------------------------------

const repoRoot = realpathSync(new URL("../", import.meta.url));
let server = null;
let serverLog = "";
function startServer() {
	const child = spawn(process.execPath, ["dist/server/index.js"], {
		cwd: repoRoot,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: workdir,
			PI_CODING_AGENT_DIR: agentDir,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const log = (d) => {
		serverLog = (serverLog + d).slice(-20000);
		if (process.env.CARRY_DEBUG) process.stderr.write(d);
	};
	child.stdout.on("data", log);
	child.stderr.on("data", log);
	server = child;
	return child;
}
async function stopServer(signal) {
	const child = server;
	server = null;
	if (!child || child.exitCode !== null) return;
	const gone = new Promise((r) => child.once("exit", r));
	child.kill(signal);
	await Promise.race([gone, sleep(15000)]);
}
async function waitForPort(timeout = 20000) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		try {
			if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return;
		} catch {
			/* starting */
		}
		await sleep(100);
	}
	throw new Error(`server did not start on ${PORT}`);
}

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✓" : "✗ FAIL:"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures += 1;
}
async function waitFor(fn, timeout = 30000, step = 200) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const v = await fn();
		if (v) return v;
		await sleep(step);
	}
	return null;
}

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
				} else if (!this.resyncing) {
					this.resyncing = setTimeout(() => {
						this.resyncing = null;
						this.send({ type: "get_state" });
					}, 300);
				}
			}
		});
	}
	static async connect(clientId) {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		await new Promise((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		const client = new Client(ws);
		client.send({ type: "hello", clientId });
		if (!(await waitFor(() => client.received.some((m) => m.type === "ready"), 40000, 50))) throw new Error("no ready");
		if (!(await waitFor(() => client.state?.conversationId, 15000, 50))) throw new Error("no snapshot");
		return client;
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	notices() {
		return this.received.filter((m) => m.type === "notice").map((m) => m.textEn ?? m.text ?? "");
	}
	close() {
		try {
			this.ws.close();
		} catch {
			/* gone */
		}
	}
}

// ---------------------------------------------------------------------------
// Transcripts and the list of working chats
// ---------------------------------------------------------------------------

function entries(file) {
	try {
		return readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}
const userTexts = (file) =>
	entries(file)
		.filter((e) => e.type === "message" && e.message?.role === "user")
		.map((e) => textOf(e.message));
const notes = (file) => userTexts(file).filter((t) => t.startsWith(NOTE));
const runningList = () => {
	try {
		return JSON.parse(readFileSync(join(dataDir, "running-chats.json"), "utf8"));
	} catch {
		return null;
	}
};
const runningEntry = (file) => runningList()?.chats?.find((c) => c.sessionFile === file);

/** Open a new chat in its own window and have a first quick exchange; returns the window and transcript. */
async function newChat(name) {
	const w = await Client.connect(`carry-${name}-${randomBytes(3).toString("hex")}`);
	const before = w.state.conversationId;
	w.send({ type: "new_chat" });
	await waitFor(() => w.state.conversationId !== before && (w.state.messages?.length ?? 0) === 0, 15000, 50);
	w.send({ type: "prompt", text: `${name.toUpperCase()}-CHAT hello` });
	const file = await waitFor(
		() =>
			w.state.isStreaming === false &&
			w.state.sessionFile &&
			existsSync(w.state.sessionFile) &&
			entries(w.state.sessionFile).some((e) => e.message?.role === "assistant")
				? w.state.sessionFile
				: null,
		20000,
		50,
	);
	if (!file) {
		const s = w.state ?? {};
		const seen = w.received
			.map((m) => m.type)
			.slice(-15)
			.join(",");
		throw new Error(
			`${name}: no transcript (conv ${s.conversationId}, file ${s.sessionFile}, streaming ${s.isStreaming}, ${s.messages?.length} messages; last: ${seen}; notices ${JSON.stringify(w.notices())})`,
		);
	}
	return { w, file };
}
/** Send the chat's second message, which makes it busy. */
async function goBusy(chat) {
	chat.w.send({ type: "prompt", text: "go" });
	if (!(await waitFor(() => chat.w.state.isStreaming === true && userTexts(chat.file).length >= 1, 15000, 50)))
		throw new Error("not busy");
}

const plan = (title) => ({
	title,
	goal: "Show that a queue carries on after a pi-web-ui restart",
	doneWhen: "The task is marked done after the carry-on note",
	decided: "Nothing to decide; this is a test",
	steps: "1. Work on it\n2. Finish it",
	verify: "The E2E checks the transcript",
	mustNot: "Touch real chats",
});
function appendQueueOps(file, ops) {
	const lines = readFileSync(file, "utf8").trim().split("\n");
	let parent = JSON.parse(lines.at(-1)).id;
	for (const op of ops) {
		const id = randomBytes(4).toString("hex");
		appendFileSync(
			file,
			`${JSON.stringify({ type: "custom", customType: "queue", data: { v: 1, ts: Date.now(), ...op }, id, parentId: parent, timestamp: new Date().toISOString() })}\n`,
		);
		parent = id;
	}
}

const clients = [];
try {
	startServer();
	await waitForPort();

	console.log("setup: six chats, four of them busy");
	const idle = await newChat("idle");
	clients.push(idle.w);
	check("IDLE answered and is idle", idle.w.state.isStreaming === false && userTexts(idle.file).length === 1);

	const stop = await newChat("stop");
	clients.push(stop.w);
	await goBusy(stop);
	await waitFor(() => runningEntry(stop.file), 10000, 50);
	await sleep(800);
	stop.w.send({ type: "abort" });
	check(
		"STOP was stopped by the user",
		Boolean(await waitFor(() => stop.w.state.isStreaming === false && !runningEntry(stop.file), 15000)),
	);

	const reply = await newChat("reply");
	clients.push(reply.w);
	await goBusy(reply);
	const cmd = await newChat("cmd");
	clients.push(cmd.w);
	await goBusy(cmd);
	const askc = await newChat("ask");
	clients.push(askc.w);
	await goBusy(askc);

	// The queue chat: a first exchange, then (closed) two tasks written into its transcript,
	// then reopened and started.
	const queue = await newChat("queue");
	clients.push(queue.w);
	queue.w.send({ type: "new_chat" });
	await sleep(1000);
	appendQueueOps(queue.file, [
		{ op: "add", id: 1, plan: plan("Queue task one") },
		{ op: "add", id: 2, plan: plan("Queue task two") },
	]);
	queue.w.send({ type: "switch_session", path: queue.file });
	await waitFor(() => queue.w.state.sessionFile === queue.file, 15000, 50);
	queue.w.send({ type: "prompt", text: "/queue start" });
	check(
		"the queue started task #1",
		Boolean(await waitFor(() => userTexts(queue.file).some((t) => t.includes("[Queue] Task #1")), 20000)),
	);

	const busy = { reply, cmd, ask: askc, queue };
	const listed = await waitFor(() => {
		const l = runningList();
		const files = new Set((l?.chats ?? []).map((c) => c.sessionFile));
		const ok =
			Object.values(busy).every((c) => files.has(c.file)) &&
			runningEntry(cmd.file)?.tools?.some((t) => t.name === "bash" && t.detail === "sleep 60") &&
			runningEntry(askc.file)?.tools?.some((t) => t.name === "ask_user_question");
		return ok ? l : null;
	}, 30000);
	check(
		"the live list has the 4 busy chats, with the command and the question as their steps",
		Boolean(listed),
		JSON.stringify(runningList()),
	);
	check("the live list leaves out the idle and the stopped chat", !runningEntry(idle.file) && !runningEntry(stop.file));
	const quietLines = { idle: entries(idle.file).length, stop: entries(stop.file).length };

	// ---------------------------------------------------------------- 1. planned restart
	console.log("1. planned restart (SIGTERM, with pi-web-deploy's reason)");
	for (const c of clients) c.close();
	clients.length = 0;
	writeFileSync(
		join(dataDir, "restart-reason.json"),
		JSON.stringify({ reason: "test restart one", at: new Date().toISOString() }),
	);
	await stopServer("SIGTERM");
	const frozen = runningList();
	check(
		"shutdown froze the list: the 4 chats it cut off stay, marked as a planned stop",
		Boolean(frozen?.shutdown) && Object.values(busy).every((c) => frozen.chats.some((x) => x.sessionFile === c.file)),
		JSON.stringify(frozen),
	);
	startServer();
	await waitForPort();
	const got1 = await waitFor(() => Object.values(busy).every((c) => notes(c.file).length === 1), 40000);
	check(
		"each busy chat got one carry-on note",
		Boolean(got1),
		Object.entries(busy)
			.map(([k, c]) => `${k}:${notes(c.file).length}`)
			.join(" "),
	);
	const n1 = Object.fromEntries(Object.entries(busy).map(([k, c]) => [k, notes(c.file)[0] ?? ""]));
	const noteShape =
		/^pi-web-ui restarted at \d\d:\d\d \(test restart one\)\. You were in the middle of .+; it was cut off\. Check where it stopped and carry on\.$/;
	check(
		"the notes say when and why (pi-web-deploy's reason)",
		Object.values(n1).every((t) => noteShape.test(t)),
		JSON.stringify(n1),
	);
	check("REPLY: cut off writing a reply", n1.reply.includes("in the middle of writing a reply;"), n1.reply);
	check(
		"CMD: cut off running its command",
		n1.cmd.includes("in the middle of running the bash command `sleep 60`;"),
		n1.cmd,
	);
	check(
		"ASK: cut off asking, told to ask again",
		n1.ask.includes("asking the user a question (ask_user_question)") && n1.ask.includes("ask it again"),
		n1.ask,
	);
	check("QUEUE: cut off writing its task's reply", n1.queue.includes("in the middle of writing a reply;"), n1.queue);
	const w1 = await Client.connect(`carry-window-${randomBytes(3).toString("hex")}`);
	clients.push(w1);
	check(
		"a window that connects hears that 4 chats carry on",
		Boolean(
			await waitFor(
				() => w1.notices().some((t) => t.includes("restarted (test restart one)") && t.includes("4 chat(s)")),
				10000,
			),
		),
		JSON.stringify(w1.notices()),
	);
	check(
		"the queue carried on: task #1 done, task #2 started",
		Boolean(await waitFor(() => userTexts(queue.file).some((t) => t.includes("[Queue] Task #2")), 30000)),
	);
	const busyAgain = await waitFor(() => {
		const l = runningList();
		const ok =
			l &&
			!l.shutdown &&
			runningEntry(reply.file)?.cutoffs === 1 &&
			runningEntry(cmd.file)?.cutoffs === 1 &&
			runningEntry(cmd.file)?.tools?.some((t) => t.name === "bash") &&
			runningEntry(askc.file)?.cutoffs === 1 &&
			runningEntry(askc.file)?.tools?.some((t) => t.name === "ask_user_question") &&
			runningEntry(queue.file)?.cutoffs === 0 &&
			!runningEntry(queue.file)?.awaiting;
		return ok ? l : null;
	}, 30000);
	check(
		"the chats carry on (working again; cut off once; the queue's new task counts from zero)",
		Boolean(busyAgain),
		JSON.stringify(runningList()),
	);
	check(
		"the idle and the stopped chat got nothing",
		entries(idle.file).length === quietLines.idle && entries(stop.file).length === quietLines.stop,
	);

	// ---------------------------------------------------------------- 2. crash
	console.log("2. crash (kill -9)");
	for (const c of clients) c.close();
	clients.length = 0;
	await stopServer("SIGKILL");
	check("a crash leaves no shutdown mark", !runningList()?.shutdown);
	startServer();
	await waitForPort();
	const got2 = await waitFor(
		() =>
			notes(reply.file).length === 2 &&
			notes(cmd.file).length === 2 &&
			notes(askc.file).length === 2 &&
			notes(queue.file).length === 2,
		40000,
	);
	check(
		"each busy chat got its next note",
		Boolean(got2),
		Object.entries(busy)
			.map(([k, c]) => `${k}:${notes(c.file).length}`)
			.join(" "),
	);
	const n2 = Object.fromEntries(Object.entries(busy).map(([k, c]) => [k, notes(c.file)[1] ?? ""]));
	check(
		"the notes say it crashed",
		Object.values(n2).every((t) => t.includes("(it crashed or was killed). You were in the middle of")),
		JSON.stringify(n2),
	);
	check("CMD: the redone command was cut off again", n2.cmd.includes("running the bash command `sleep 60`"), n2.cmd);
	check("QUEUE: cut off in task #2's reply", n2.queue.includes("writing a reply"), n2.queue);
	const counted = await waitFor(
		() =>
			runningEntry(reply.file)?.cutoffs === 2 &&
			runningEntry(cmd.file)?.cutoffs === 2 &&
			runningEntry(askc.file)?.cutoffs === 2 &&
			runningEntry(queue.file)?.cutoffs === 1 &&
			runningEntry(cmd.file)?.tools?.some((t) => t.name === "bash") &&
			runningEntry(askc.file)?.tools?.some((t) => t.name === "ask_user_question"),
		30000,
	);
	check("working again, cut off twice in a row (the queue chat once)", Boolean(counted), JSON.stringify(runningList()));
	check(
		"the idle and the stopped chat still got nothing",
		entries(idle.file).length === quietLines.idle && entries(stop.file).length === quietLines.stop,
	);

	// ---------------------------------------------------------------- 3. the loop guard
	console.log("3. planned restart without a reason: the 3rd cut-off in a row");
	await stopServer("SIGTERM");
	startServer();
	await waitForPort();
	const w3 = await Client.connect(`carry-window-${randomBytes(3).toString("hex")}`);
	clients.push(w3);
	check(
		'QUEUE (cut off twice) got its note, saying "a restart"',
		Boolean(await waitFor(() => notes(queue.file).length === 3, 40000)) &&
			notes(queue.file)[2].includes("(a restart)."),
		notes(queue.file).at(-1),
	);
	const guardNotices = await waitFor(() => {
		const n = w3.notices().filter((t) => t.includes("was cut off by 3 restarts in a row"));
		return n.length === 3 ? n : null;
	}, 10000);
	check(
		"REPLY, CMD and ASK (3rd time): a notice each instead of a note",
		Boolean(guardNotices),
		JSON.stringify(w3.notices()),
	);
	await sleep(2000);
	check(
		"...and no third note",
		notes(reply.file).length === 2 && notes(cmd.file).length === 2 && notes(askc.file).length === 2,
		`${notes(reply.file).length} ${notes(cmd.file).length} ${notes(askc.file).length}`,
	);
	check(
		"the list keeps only the queue chat",
		(runningList()?.chats ?? []).map((c) => c.sessionFile).join() === queue.file,
		JSON.stringify(runningList()),
	);
	check(
		"the idle and the stopped chat never got anything",
		entries(idle.file).length === quietLines.idle && entries(stop.file).length === quietLines.stop,
	);
} catch (err) {
	console.log(`✗ FAIL: ${err.stack ?? err}`);
	failures += 1;
} finally {
	for (const c of clients) c.close();
	await stopServer("SIGTERM");
	mock.close();
	if (failures > 0) console.log(`--- server log (tail) ---\n${serverLog.slice(-6000)}`);
	else rmSync(base, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED (data kept in ${base})`);
process.exit(failures === 0 ? 0 : 1);
