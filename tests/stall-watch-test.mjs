/* stall-watch E2E (no tokens): pi-queue's watchdog wakes a task's chat that stopped while its task
 * was still being worked on, and makes the task "needs you" when it can't.
 *
 * A sealed test server with the real pi-queue (PI_QUEUE_PKG, default ~/projects/pi-queue), a mock
 * OpenAI-compatible model, pi-queue.json `stalledAfterMinutes` 0.02 (1.2 s) and PI_QUEUE_TEST_FAST=1
 * (the watchdog looks every second). A queue chat starts three tasks, each in a chat of its own; each
 * task's chat keeps working (a long command). Then pi-web-ui crashes (kill -9), and while it is down:
 *   ONE    drops out of the list of working chats (the carry-on won't reopen it: it just stopped);
 *   TWO    already has two crashes in a row (this one is its 3rd: the carry-on leaves it alone);
 *   THREE  stays as it is (the carry-on reopens it and it carries on).
 * After the restart:
 *   - the carry-on carries THREE on and leaves TWO alone, and the server opens the queue chat (no
 *     window shows it) so that its watchdog looks after the tasks;
 *   - ONE: closed and quiet, so it is woken once with the watchdog's note; told so, it finishes its
 *     task, and the queue shows #1 done; the queue chat and the TL;DR say it was woken;
 *   - TWO: the server won't wake a chat the carry-on left alone at this start, so the wake is
 *     recorded as one that didn't get there; still stopped after the wait, the task becomes "needs
 *     you" in its own chat (choices "Carry on" and "Remove it") and the queue follows; answering
 *     "Carry on" there makes it carry on and finish;
 *   - THREE: working the whole time, never woken.
 *
 * Usage: npm run build:server && node tests/stall-watch-test.mjs [port]   (STALL_DEBUG=1: server log)
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
const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-stall-watch-")));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });
/** How the watchdog's note starts (pi-queue's STALL_NOTE). */
const WAKE = "[Queue] This chat stopped while its task was still being worked on";
const CARRY_ON_NOTE = "pi-web-ui restarted at";

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
	const first = users[0] ?? "";
	const lastUser = (users.at(-1) ?? "").trim();
	const last = msgs.at(-1);
	let closed = false;
	res.on("close", () => {
		closed = true;
	});
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const chunk = (delta, finish = null) =>
		res.write(
			`data: ${JSON.stringify({ id: "stall", object: "chat.completion.chunk", created: Date.now(), model: payload.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
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
	const call = (name, args) => {
		const id = `call_${randomBytes(4).toString("hex")}`;
		chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
		chunk({}, "tool_calls");
		end();
	};
	const kick = /^\[Queue\] Task #(\d+): /.exec(first);
	const id = Number(kick?.[1] ?? 0);
	const lastCall = [...msgs].reverse().find((m) => m.role === "assistant" && m.tool_calls?.length)?.tool_calls?.[0]
		?.function?.name;
	if (last?.role === "tool") {
		// Woken: a short look first (so the queue records the wake before the task is done), then finish.
		if (kick && lastCall === "bash" && lastUser.startsWith(WAKE))
			return call("queue_done", { summary: `Task ${id} finished after the queue woke its chat.` });
		return say("tool done");
	}
	// The queue chat (and anything else): a quick answer.
	if (!kick) return say("hi");
	if (last?.role === "user" && lastUser.startsWith(WAKE)) return call("bash", { command: "sleep 3" });
	if (last?.role === "user" && /^carry on\b/i.test(lastUser))
		return call("queue_done", { summary: `Task ${id} finished after the user said carry on.` });
	// The task's first message, or the carry-on note after the restart: a long command keeps it working
	// (a tool call is an answer, so the chat's transcript is on disk).
	return call("bash", { command: "sleep 150" });
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ main: { type: "api_key", key: "stall-watch-test" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "stall-watch-test",
				models: [{ id: "stall-mock", name: "Stall Mock", input: ["text"], contextWindow: 64000, maxTokens: 4096 }],
			},
		},
	}),
);
writeFileSync(
	join(agentDir, "settings.json"),
	JSON.stringify({ defaultProvider: "main", defaultModel: "stall-mock", packages: [PI_QUEUE] }),
);
// 0.02 minutes = 1.2 s (PI_QUEUE_TEST_FAST allows that little).
writeFileSync(join(agentDir, "pi-queue.json"), JSON.stringify({ stalledAfterMinutes: 0.02 }));

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
			PI_QUEUE_TEST_FAST: "1",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const log = (d) => {
		serverLog += d;
		if (process.env.STALL_DEBUG) process.stderr.write(d);
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
	close() {
		try {
			this.ws.close();
		} catch {
			/* gone */
		}
	}
}

// ---------------------------------------------------------------------------
// Transcripts, the queue's records and the list of working chats
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
const wakes = (file) => userTexts(file).filter((t) => t.startsWith(WAKE));
const carryOnNotes = (file) => userTexts(file).filter((t) => t.startsWith(CARRY_ON_NOTE));
/** The queue's records in a chat's transcript. */
const queueOps = (file) =>
	entries(file)
		.filter((e) => e.type === "custom" && e.customType === "queue")
		.map((e) => e.data);
const hasOp = (file, op, id, more = () => true) => queueOps(file).some((o) => o.op === op && o.id === id && more(o));
/** The task chats the queue started: task id → transcript. */
const taskChats = (queueFile) =>
	new Map(
		queueOps(queueFile)
			.filter((o) => o.op === "chat")
			.map((o) => [o.id, o.file]),
	);
/** What the queue told its chat (its notes) and the TL;DR lines it wrote. */
const reports = (file) =>
	entries(file)
		.filter((e) => e.customType === "queue-report")
		.map((e) => (typeof e.content === "string" ? e.content : textOf(e)));
const tldrs = (file) =>
	entries(file)
		.filter((e) => e.type === "custom" && e.customType === "tldr")
		.map((e) => e.data?.text ?? "");
const runningList = () => {
	try {
		return JSON.parse(readFileSync(join(dataDir, "running-chats.json"), "utf8"));
	} catch {
		return null;
	}
};
const runningEntry = (file) => runningList()?.chats?.find((c) => c.sessionFile === file);

const plan = (title) => ({
	title,
	goal: "Show that the queue's watchdog looks after a task chat that stopped",
	doneWhen: "The task is marked done after its chat carries on",
	decided: "Nothing to decide; this is a test",
	steps: "1. Work on it\n2. Finish it",
	verify: "The E2E checks the transcripts",
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

	console.log("setup: a queue chat starts three tasks, each in a chat of its own");
	const w = await Client.connect(`stall-${randomBytes(3).toString("hex")}`);
	clients.push(w);
	const before = w.state.conversationId;
	w.send({ type: "new_chat" });
	await waitFor(() => w.state.conversationId !== before && (w.state.messages?.length ?? 0) === 0, 15000, 50);
	w.send({ type: "prompt", text: "QUEUE-CHAT hello" });
	const queueFile = await waitFor(
		() =>
			w.state.isStreaming === false &&
			w.state.sessionFile &&
			entries(w.state.sessionFile).some((e) => e.message?.role === "assistant")
				? w.state.sessionFile
				: null,
		20000,
		50,
	);
	if (!queueFile) throw new Error("the queue chat has no transcript");
	w.send({ type: "new_chat" });
	await sleep(1000);
	appendQueueOps(queueFile, [
		{ op: "lanes", n: 3 },
		{ op: "add", id: 1, plan: plan("Stall task one"), touches: ["stall-one"] },
		{ op: "add", id: 2, plan: plan("Stall task two"), touches: ["stall-two"] },
		{ op: "add", id: 3, plan: plan("Stall task three"), touches: ["stall-three"] },
	]);
	w.send({ type: "switch_session", path: queueFile });
	await waitFor(() => w.state.sessionFile === queueFile, 15000, 50);
	w.send({ type: "prompt", text: "/queue start" });
	const started = await waitFor(() => {
		const m = taskChats(queueFile);
		return m.size === 3 && [...m.values()].every((f) => existsSync(f)) ? m : null;
	}, 40000);
	check(
		"the queue started the three tasks, each in a chat of its own",
		Boolean(started),
		JSON.stringify(queueOps(queueFile)),
	);
	if (!started) throw new Error("no task chats");
	const [one, two, three] = [1, 2, 3].map((id) => started.get(id));
	const working = await waitFor(
		() =>
			[one, two, three].every((f) => {
				const e = runningEntry(f);
				return e && !e.awaiting && e.tools?.some((t) => t.name === "bash");
			}),
		30000,
	);
	check("all three task chats are working (a long command each)", Boolean(working), JSON.stringify(runningList()));
	const linked = await waitFor(() => {
		try {
			const t = readFileSync(join(dataDir, "client-state.json"), "utf8");
			return t.includes('"queueHomes"') && [one, two, three].every((f) => t.includes(f));
		} catch {
			return false;
		}
	}, 20000);
	check("the server keeps the links from the task chats to the queue chat", Boolean(linked));

	// ---------------------------------------------------------------- the crash
	console.log("crash (kill -9); while it's down ONE drops out of the list, TWO has crashed twice already");
	for (const c of clients) c.close();
	clients.length = 0;
	await stopServer("SIGKILL");
	const list = runningList();
	list.chats = list.chats
		.filter((c) => c.sessionFile !== one)
		.map((c) => (c.sessionFile === two ? { ...c, cutoffs: 2, crashes: 2 } : c));
	writeFileSync(join(dataDir, "running-chats.json"), JSON.stringify(list));
	startServer();
	await waitForPort();

	const carryLine = await waitFor(() => serverLog.split("\n").find((l) => l.includes("[carry-on] restarted")), 20000);
	check(
		"the carry-on carries THREE on and leaves TWO alone (its 3rd crash in a row)",
		Boolean(carryLine) &&
			carryLine.includes('carrying on 1 chat(s): "Queue #3: Stall task three" (cut off 1x: a crash)') &&
			carryLine.includes('left alone: "Queue #2: Stall task two" (cut off 3x in a row: all crashes)'),
		carryLine ?? "no line",
	);
	check(
		"THREE got its carry-on note",
		Boolean(await waitFor(() => carryOnNotes(three).length === 1, 20000)),
		String(carryOnNotes(three).length),
	);
	check(
		"the server opened the queue chat, so its watchdog runs",
		Boolean(await waitFor(() => serverLog.includes("[stall-watch] opened 1 of 1 queue chat(s)"), 20000)),
		serverLog
			.split("\n")
			.filter((l) => l.includes("[stall-watch]"))
			.join(" | "),
	);

	// ---------------------------------------------------------------- ONE: woken once, carries on
	check(
		"ONE (closed, quiet): woken with the watchdog's note",
		Boolean(await waitFor(() => wakes(one).length === 1, 20000)),
		String(wakes(one).length),
	);
	check(
		"...and logged",
		Boolean(await waitFor(() => serverLog.includes("[pi-queue] watchdog: task #1's chat had stopped; woke it"), 10000)),
	);
	check(
		"told so, it finished its task: the queue shows #1 done",
		Boolean(await waitFor(() => hasOp(queueFile, "done", 1), 20000)),
		JSON.stringify(queueOps(queueFile).filter((o) => o.id === 1)),
	);
	check(
		"the queue chat says it woke #1's chat, so does the TL;DR",
		reports(queueFile).some(
			(t) =>
				t.startsWith('[Queue] Task #1 (Stall task one): its chat "Queue #1: Stall task one" stopped at ') &&
				t.endsWith("The queue woke it to carry on."),
		) && tldrs(queueFile).includes("Task #1's chat had stopped; the queue woke it to carry on"),
		JSON.stringify({ reports: reports(queueFile), tldr: tldrs(queueFile) }),
	);

	// ---------------------------------------------------------------- TWO: can't be woken → needs you
	check(
		"TWO: the server won't wake a chat the carry-on left alone",
		Boolean(
			await waitFor(() => serverLog.includes(`[stall-watch] not waking ${two}: the carry-on left it alone`), 20000),
		),
	);
	check(
		"...so the queue records a wake that didn't get there",
		serverLog.includes("[pi-queue] watchdog: task #2's chat had stopped; couldn't wake it") &&
			hasOp(queueFile, "woke", 2, (o) => o.ok === false),
	);
	const asked = await waitFor(
		() =>
			hasOp(
				two,
				"stuck",
				2,
				(o) =>
					o.stalled === true &&
					JSON.stringify(o.choices) === JSON.stringify(["Carry on", "Remove it"]) &&
					o.question?.startsWith("This task's chat stopped"),
			) && hasOp(queueFile, "stuck", 2, (o) => o.stalled === true),
		20000,
	);
	check(
		'still stopped after the wait: "needs you" in its chat (Carry on / Remove it), and the queue follows',
		Boolean(asked),
		JSON.stringify({
			own: queueOps(two).filter((o) => o.op !== "assigned"),
			queue: queueOps(queueFile).filter((o) => o.id === 2),
		}),
	);
	check(
		"...logged",
		serverLog.includes("[pi-queue] watchdog: task #2's chat stopped again after the wake; marking it needs you"),
	);
	check("TWO never got the watchdog's note", wakes(two).length === 0, String(wakes(two).length));
	const firstLook = serverLog.split("\n").find((l) => l.includes("[pi-queue] watchdog in "));
	check(
		"the watchdog's first look: 3 task chats, #3 working; woke #1, couldn't wake #2",
		/looked at 3 task chat\(s\) \(.*#3 working.*\); woke #1; couldn't wake #2/.test(firstLook ?? ""),
		firstLook ?? "no line",
	);

	console.log('the user answers TWO\'s question: "Carry on"');
	const w2 = await Client.connect(`stall-two-${randomBytes(3).toString("hex")}`);
	clients.push(w2);
	w2.send({ type: "switch_session", path: two });
	await waitFor(() => w2.state.sessionFile === two, 15000, 50);
	w2.send({ type: "prompt", text: "Carry on" });
	check(
		"TWO carried on and finished: the queue shows #2 done",
		Boolean(await waitFor(() => hasOp(queueFile, "done", 2), 30000)),
		JSON.stringify(queueOps(queueFile).filter((o) => o.id === 2)),
	);

	// ---------------------------------------------------------------- THREE: working, never woken
	await sleep(2500);
	check("ONE was woken once only", wakes(one).length === 1, String(wakes(one).length));
	check(
		"THREE (working the whole time) was never woken, and its task is still being worked on",
		wakes(three).length === 0 &&
			!queueOps(queueFile).some((o) => o.id === 3 && ["done", "stuck", "woke", "wait"].includes(o.op)) &&
			Boolean(runningEntry(three)),
		JSON.stringify({ wakes: wakes(three).length, ops: queueOps(queueFile).filter((o) => o.id === 3) }),
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
