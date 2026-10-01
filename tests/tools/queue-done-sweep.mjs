/* queue-done-hidden, once: takes the chats of queued tasks that finished (or were removed) before the
 * patch out of Recent chats, as the patch does for every task that finishes from now on.
 *
 *  - Read only on chats: it finds every chat that holds a queue (a transcript with pi-queue entries
 *    that isn't a task's own chat), replays that queue with pi-queue's own replayTranscript, and lists
 *    the chats of its done and removed tasks. No chat file is written, moved or deleted.
 *  - Each of those that isn't open right now gets the Recent chats tombstone through the app's own ✕
 *    action (remove_recent_chat) over a socket. Opening one later brings it back, like any chat.
 *  - It prints counts and the queue chats' names, never what a chat says.
 *
 * Usage: node tests/tools/queue-done-sweep.mjs [--apply] [--port=8787] [--sessions=<dir>]
 *          [--data=<pi-web-ui data dir>] [--queue=<pi-queue checkout>]
 *        Without --apply it's a dry run: it says what it would take out.
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

const arg = (name, fallback) => {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
};
const APPLY = process.argv.includes("--apply");
const PORT = Number(arg("port", "8787"));
const SESSIONS = resolve(arg("sessions", join(homedir(), ".pi", "agent", "sessions")));
const STATE = join(resolve(arg("data", join(homedir(), ".pi-web-ui"))), "client-state.json");
const PI_QUEUE = resolve(arg("queue", process.env.PI_QUEUE_PKG ?? join(homedir(), "projects", "pi-queue")));
/** ClientStateStore.removeRecent keeps this many tombstones (newest first). */
const TOMBSTONE_CAP = 500;

const { replayTranscript } = await import(pathToFileURL(join(PI_QUEUE, "queue.ts")).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (fn()) return;
		await sleep(100);
	}
	throw new Error(`timed out: ${what}`);
}

function* transcripts(dir) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* transcripts(p);
		else if (e.isFile() && e.name.endsWith(".jsonl")) yield p;
	}
}

/** A transcript's queue entries (their lines) and its name, read line by line. */
async function queueLinesOf(file) {
	const lines = [];
	let name = "";
	const rl = createInterface({
		input: createReadStream(file, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of rl) {
		if (line.includes('"customType":"queue"')) lines.push(line);
		else if (line.includes('"type":"session_info"')) {
			try {
				name = JSON.parse(line).name || name;
			} catch {
				// half-written: skip it
			}
		}
	}
	return { lines, name };
}

/** The Recent chats tombstones now (read only). */
const tombstones = () => {
	try {
		return new Set((JSON.parse(readFileSync(STATE, "utf8")).__settings__?.recentRemoved ?? []).map((p) => resolve(p)));
	} catch {
		return new Set();
	}
};

// ---- 1. every queue's finished task chats ----------------------------------------------------------
const homes = [];
const owner = new Map(); // task chat file -> its queue chat (each task chat belongs to one queue)
let scanned = 0;
for (const file of transcripts(SESSIONS)) {
	scanned++;
	const { lines, name } = await queueLinesOf(file);
	if (!lines.length) continue;
	const q = replayTranscript(lines.join("\n"));
	if (q.from || !q.tasks.length) continue; // a task's own chat, or no queue
	const home = { name: name || basename(file), tasks: q.tasks.length, finished: [] };
	for (const t of q.tasks) {
		if ((t.status !== "done" && t.status !== "removed") || !t.chat?.file) continue;
		const chat = resolve(t.chat.file);
		if (owner.has(chat)) continue;
		owner.set(chat, home);
		home.finished.push(chat);
	}
	homes.push(home);
}

// ---- 2. what the chat list shows now ----------------------------------------------------------------
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const st = { ready: false, closed: false, convs: null, sessions: null, error: "" };
// A carry-on: client starts on a blank chat of its own. A plain new client would take over the chat
// open last in the server's folder (reload-adopt), as if someone had looked at it.
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId: "carry-on:queue-done-sweep" })));
ws.on("close", () => (st.closed = true));
ws.on("error", (e) => {
	st.closed = true;
	st.error = String(e);
});
ws.on("message", (raw) => {
	let m;
	try {
		m = JSON.parse(String(raw));
	} catch {
		return;
	}
	if (m.type === "ready") st.ready = true;
	if (m.type === "conversations") st.convs = m.conversations ?? [];
	if (m.type === "sessions") st.sessions = m.sessions ?? [];
});
const send = (o) => ws.send(JSON.stringify(o));
/** The chat list once the saved chats are read again: its running chats and its Recent chats. */
async function chatList() {
	st.sessions = null;
	send({ type: "list_sessions" });
	await until(() => st.sessions !== null || st.closed, 60000, "the saved chats");
	if (st.closed) throw new Error(`the socket closed ${st.error}`);
	await sleep(1500); // the chat list follows the saved chats (and their identity tags)
	const live = new Set();
	const recent = new Set();
	for (const c of st.convs ?? []) {
		if (c.live === false && c.sessionPath) recent.add(resolve(c.sessionPath));
		else if (c.sessionFile) live.add(resolve(c.sessionFile));
	}
	return { live, recent };
}

try {
	await until(() => st.ready || st.closed, 20000, "the app's socket");
	if (st.closed) throw new Error(`couldn't reach pi-web-ui on port ${PORT} ${st.error}`);
	const before = await chatList();
	const out = tombstones();
	const outBefore = out.size;
	const plan = [];
	for (const home of homes) {
		home.counts = { missing: 0, open: 0, already: 0, take: 0, showing: 0 };
		for (const chat of home.finished) {
			if (!existsSync(chat)) home.counts.missing++;
			else if (before.live.has(chat)) home.counts.open++;
			else if (out.has(chat)) home.counts.already++;
			else {
				home.counts.take++;
				if (before.recent.has(chat)) home.counts.showing++;
				plan.push(chat);
			}
		}
	}
	// Oldest first, so the newest ends up at the front of the tombstone list (it keeps the newest 500).
	plan.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
	const showingBefore = [...owner.keys()].filter((f) => before.recent.has(f)).length;

	console.log(`${scanned} chats read; ${homes.length} hold a queue; ${owner.size} finished task chats.`);
	for (const h of homes) {
		const c = h.counts;
		console.log(
			`- "${h.name}": ${h.tasks} tasks, ${h.finished.length} finished in chats of their own: ` +
				`${APPLY ? "taken out" : "to take out"} ${c.take} (${c.showing} of them showing in Recent chats), ` +
				`already out ${c.already}, open now (left alone) ${c.open}, transcript gone ${c.missing}`,
		);
	}
	console.log(`Recent chats showed ${showingBefore} finished task chats before.`);
	if (outBefore + plan.length > TOMBSTONE_CAP)
		console.log(
			`! ${outBefore} + ${plan.length} tombstones pass the cap of ${TOMBSTONE_CAP}: the oldest would drop out.`,
		);

	if (APPLY) {
		for (const chat of plan) send({ type: "remove_recent_chat", path: chat });
		await until(() => plan.every((f) => tombstones().has(f)) || st.closed, 30000, "the tombstones");
		const after = await chatList();
		const showingAfter = [...owner.keys()].filter((f) => after.recent.has(f)).length;
		const outAfter = tombstones();
		console.log(`Took out ${plan.filter((f) => outAfter.has(f)).length} of ${plan.length}.`);
		console.log(
			`Recent chats show ${showingAfter} finished task chats now; ${after.recent.size} rows in Recent chats.`,
		);
		console.log(`Tombstones: ${outBefore} before, ${outAfter.size} now.`);
	} else {
		console.log(`Dry run: ${plan.length} would be taken out. Run again with --apply.`);
	}
} finally {
	ws.close();
}
