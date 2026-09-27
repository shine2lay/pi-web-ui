/* wake-reopen E2E (no tokens): a scheduled wake-up whose chat isn't open reopens that chat.
 *
 * This happened for real (2026-09-27): an install restarted pi-web-ui, which reopens only the chats
 * that were working. An idle chat had a wake-up due a few minutes later. The wake-up found its chat
 * closed and was handed to the most recently active chat of the same project: someone else's
 * conversation, which then got a task that wasn't its own.
 *
 * A sealed server with a mock model:
 *   1. Chat BOUND schedules a wake-up (a task bound to its transcript); chat OTHER is used after it,
 *      so OTHER is the project's most recently active chat.
 *   2. The server restarts. Both chats were idle, so neither is reopened.
 *   3. The wake-up fires (Run now): BOUND is reopened and gets it, and answers; OTHER gets nothing.
 *      Every window hears that it was reopened. The task follows the reopened chat (its new id).
 *   4. It fires again with BOUND now open: delivered straight to it, no second copy of the chat.
 *   5. A wake-up whose transcript is gone still falls back as before: to the project's active chat,
 *      with the notice saying so.
 *
 * Usage: npm run build:server && node tests/wake-reopen-test.mjs   (WAKE_DEBUG=1: server output)
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { textOf } from "./lib/mock-model.mjs";
import { ownServer } from "./lib/own-server.mjs";

const srv = await ownServer({
	name: "wake-reopen",
	verbose: !!process.env.WAKE_DEBUG,
	mock: ({ lastUser }) => {
		const tag = /WAKE-\d+/.exec(lastUser)?.[0];
		return tag ? `woke up for ${tag}` : "hi";
	},
});

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✓" : "✗ FAIL:"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures += 1;
}
async function waitFor(fn, timeout = 30000, step = 100) {
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
	notices() {
		return this.received.filter((m) => m.type === "notice").map((m) => m.textEn ?? m.text ?? "");
	}
	tasks() {
		return this.received.filter((m) => m.type === "scheduler_tasks").at(-1)?.tasks ?? [];
	}
	close() {
		try {
			this.ws.close();
		} catch {
			/* gone */
		}
	}
}

const userTexts = (file) => {
	try {
		return readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
			.filter((e) => e.type === "message")
			.map((e) => ({ role: e.message?.role, text: textOf(e.message) }));
	} catch {
		return [];
	}
};
const count = (file, re, role = "user") => userTexts(file).filter((m) => m.role === role && re.test(m.text)).length;

/** A new chat in window w with one quick exchange; returns its id and transcript. */
async function newChat(w, first) {
	const before = w.state.conversationId;
	w.send({ type: "new_chat" });
	await waitFor(() => w.state.conversationId !== before && (w.state.messages?.length ?? 0) === 0, 15000, 50);
	w.send({ type: "prompt", text: first });
	const file = await waitFor(
		() =>
			w.state.isStreaming === false &&
			w.state.sessionFile &&
			existsSync(w.state.sessionFile) &&
			userTexts(w.state.sessionFile).some((m) => m.role === "assistant")
				? w.state.sessionFile
				: null,
		20000,
		50,
	);
	if (!file) throw new Error(`chat "${first}" never got its answer`);
	return { id: w.state.conversationId, file };
}

try {
	// 1. Two chats; OTHER is the most recently active one.
	const w1 = await Client.connect("wake-w1");
	const bound = await newChat(w1, "BOUND chat, it schedules a check-in");
	w1.send({
		type: "schedule_save",
		task: {
			id: "wake-bound",
			name: "bound check-in",
			cwd: srv.workdir,
			kind: "interval",
			spec: 3_600_000,
			prompt: "WAKE-1 check on the job",
			conversationId: bound.id,
			sessionFile: bound.file,
		},
	});
	const other = await newChat(w1, "OTHER chat, used last");
	check("two chats with their own transcripts", bound.file !== other.file);
	w1.close();

	// 2. Restart: both chats were idle, so neither is reopened.
	await srv.restart();
	const w2 = await Client.connect("wake-w2");
	w2.send({ type: "schedule_list" });
	const saved = await waitFor(() => w2.tasks().find((t) => t.id === "wake-bound"), 10000);
	check("the task survived the restart, bound to BOUND's transcript", saved?.sessionFile === bound.file);

	// 3. The wake-up fires: BOUND is reopened and gets it; OTHER gets nothing.
	w2.send({ type: "schedule_run", id: "wake-bound" });
	const answered = await waitFor(
		() => count(bound.file, /WAKE-1/) === 1 && count(bound.file, /woke up for WAKE-1/, "assistant") === 1,
		30000,
	);
	check("BOUND was reopened, got its wake-up and answered", !!answered, JSON.stringify(userTexts(bound.file)));
	check("OTHER got nothing", count(other.file, /WAKE-/) === 0, JSON.stringify(userTexts(other.file)));
	check(
		"the window hears that the chat was reopened",
		!!(await waitFor(() => w2.notices().some((t) => /its chat wasn't open, so it was reopened/.test(t)), 10000)),
		JSON.stringify(w2.notices()),
	);
	check("no fallback notice", !w2.notices().some((t) => /moved to the project's active conversation/.test(t)));
	w2.send({ type: "schedule_list" });
	const rebound = await waitFor(() => {
		const t = w2.tasks().find((x) => x.id === "wake-bound");
		return t && t.conversationId && t.conversationId !== bound.id ? t : null;
	}, 10000);
	check("the task follows the reopened chat (new id, same transcript)", rebound?.sessionFile === bound.file);
	const listed = await waitFor(() => {
		const convs = w2.received.filter((m) => m.type === "conversations").at(-1)?.conversations ?? [];
		return convs.some((c) => c.id === rebound?.conversationId) ? true : null;
	}, 10000);
	const lastList = () =>
		(w2.received.filter((m) => m.type === "conversations").at(-1)?.conversations ?? []).map((c) => ({
			id: c.id,
			title: c.title,
			sessionFile: c.sessionFile,
		}));
	check(
		"the reopened chat shows up in the running list of the open window",
		!!listed,
		JSON.stringify({ want: rebound?.conversationId, got: lastList() }),
	);
	const w3 = await Client.connect("wake-w3");
	const fresh = await waitFor(() => {
		const convs = w3.received.filter((m) => m.type === "conversations").at(-1)?.conversations ?? [];
		return convs.some((c) => c.id === rebound?.conversationId) ? true : null;
	}, 5000);
	check("a window opened later lists it too", !!fresh);
	w3.close();

	// 4. Again, now that BOUND is open: straight to it, no second copy.
	const reopenNotices = w2.notices().filter((t) => /was reopened/.test(t)).length;
	w2.send({ type: "schedule_run", id: "wake-bound" });
	check(
		"the second wake-up goes straight to the open chat",
		!!(await waitFor(() => count(bound.file, /woke up for WAKE-1/, "assistant") === 2, 30000)),
		JSON.stringify(userTexts(bound.file)),
	);
	await sleep(500);
	check("not reopened a second time", w2.notices().filter((t) => /was reopened/.test(t)).length === reopenNotices);
	check("OTHER still got nothing", count(other.file, /WAKE-/) === 0);

	// 5. A wake-up whose transcript is gone falls back as before (the project's active chat).
	w2.send({
		type: "schedule_save",
		task: {
			id: "wake-gone",
			name: "gone check-in",
			cwd: srv.workdir,
			kind: "interval",
			spec: 3_600_000,
			prompt: "WAKE-3 check on the job",
			conversationId: "c-gone",
			sessionFile: join(srv.agentDir, "sessions", "gone.jsonl"),
		},
	});
	await waitFor(() => (w2.send({ type: "schedule_list" }), w2.tasks().some((t) => t.id === "wake-gone")), 10000, 300);
	w2.send({ type: "schedule_run", id: "wake-gone" });
	check(
		"a gone transcript still falls back to the project's active chat, and says so",
		!!(await waitFor(() => w2.notices().some((t) => /moved to the project's active conversation/.test(t)), 30000)),
		JSON.stringify(w2.notices()),
	);
	w2.close();
} catch (err) {
	check("test ran to the end", false, err?.stack ?? String(err));
} finally {
	await srv.stop();
}

console.log(failures === 0 ? "\nwake-reopen: all checks passed" : `\nwake-reopen: ${failures} check(s) failed`);
if (failures > 0 && !process.env.WAKE_DEBUG) console.log(srv.stderr().slice(-3000));
process.exit(failures === 0 ? 0 : 1);
