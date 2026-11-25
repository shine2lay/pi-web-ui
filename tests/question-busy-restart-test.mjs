/* nonblocking-ask (Ops #1088, QA #243 D1 + D2) E2E, no tokens: an owner's answer to ask_user_question reaches its
 * chat exactly once, as his message ("[From: <name>]" first for the model, `sentBy` in the transcript), even when
 * pi-web-ui restarts or crashes while that answer waits behind a busy turn.
 *
 * A stand-in model plays the agent on the test's own sealed server (tests/lib/own-server.mjs). Per case: the chat
 * asks (`QA-ASK <tag>`), then starts a slow reply (`QA-SLOW 30`, ~30 s); the owner answers while it runs; then
 *   restart                  graceful restart (SIGTERM) while the answer waits behind the slow turn
 *   crash                    kill -9 of the server's process group at the same point
 *   restart-after-turn-ends  control: the slow turn ends and the answer is taken before the restart
 *   wai                      Wai's own card, answered by Wai on an idle chat: from=Wai, sentBy Wai
 *   cancel                   Shine cancels his card on an idle chat: from=Shine, kind=cancelled
 * Each must end with exactly one wake line in the transcript, one woken reply from the model naming the owner, the
 * transcript's wake marked `sentBy.name` = the owner, and the card gone from pending-questions.json.
 * QA's repro of the same (qa-lab qa_busy_restart.mjs) gave wakeLines 0 on restart and crash before this fix.
 *
 * Usage: npm run build && scripts/sealed.sh node tests/question-busy-restart-test.mjs [out.json]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { ownServer } from "./lib/own-server.mjs";

const OUT = process.argv[2];
const OWNERS = {
	Shine: { "tailscale-user-login": "aungshine@gmail.com", "tailscale-user-name": "Shine" },
	Wai: { "tailscale-user-login": "sayswai@gmail.com", "tailscale-user-name": "Wai" },
};
const PEOPLE = { "aungshine@gmail.com": { name: "Shine", owner: true }, "sayswai@gmail.com": { name: "Wai" } };
const WAKE_RE = /answered your question|Cancelled prompt|About your question/;

function mockReply({ lastUser, toolResult, sideRequest }) {
	if (sideRequest) return "Title";
	if (toolResult) return `POSTED ${/QA-ASK (\w+)/.exec(lastUser)?.[1] ?? "none"}`;
	if (WAKE_RE.test(lastUser)) {
		const from = /^\[From: ([^\]]+)\]/m.exec(lastUser)?.[1] ?? "none";
		const kind = /Cancelled prompt/.test(lastUser) ? "cancelled" : "answered";
		return `WOKE from=${from} kind=${kind} tag=${/QTAG-(\w+)/.exec(lastUser)?.[1] ?? "none"}`;
	}
	let m = /QA-ASK (\w+)/.exec(lastUser);
	if (m) {
		const question = {
			id: "pick",
			header: `QTAG-${m[1]}`,
			question: `Pick one for QTAG-${m[1]}?`,
			options: [{ label: "Alpha" }, { label: "Beta" }],
		};
		return { tool: "ask_user_question", args: { questions: [question] } };
	}
	m = /QA-SLOW (\d+)/.exec(lastUser);
	if (m) return { text: `SLOW ${"z".repeat(Number(m[1]) * 20)}`, stream: { everyMs: 100, pieceChars: 2 } };
	return `REPLY to: ${lastUser.replace(/\s+/g, " ").slice(0, 80)}`;
}

async function until(fn, ms = 20000, every = 100) {
	const t0 = Date.now();
	let v = await fn();
	while (!v && Date.now() - t0 < ms) {
		await sleep(every);
		v = await fn();
	}
	return v;
}

const lines = (file) => (file && existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
const isWake = (l, tag) => l.includes(`QTAG-${tag}`) && WAKE_RE.test(l) && !l.includes('"role":"assistant"');
const wakeLines = (file, tag) => lines(file).filter((l) => isWake(l, tag));
const assistantLines = (file, needle) =>
	lines(file).filter((l) => l.includes('"role":"assistant"') && l.includes(needle)).length;

function storeRecords(srv) {
	const f = join(srv.dataDir, "pending-questions.json");
	return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).records ?? []) : [];
}
const recordOf = (srv, tag) => storeRecords(srv).find((r) => JSON.stringify(r.questions).includes(`QTAG-${tag}`));

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		this.state = null;
		ws.on("message", (data) => {
			const m = JSON.parse(data.toString());
			this.received.push(m);
			if (m.type === "snapshot") this.state = m.state;
			else if (m.type === "snapshot_delta") {
				if (this.state && this.state.rev === m.baseRev)
					this.state = { ...this.state, ...m.state, messages: [...this.state.messages, ...(m.appended ?? [])] };
				else this.send({ type: "get_state" });
			}
		});
	}
	send(m) {
		this.ws.send(JSON.stringify(m));
	}
	async waitFor(type, pred = () => true, ms = 30000) {
		const m = await until(() => this.received.find((x) => x.type === type && pred(x)), ms, 50);
		if (!m) throw new Error(`timeout waiting for ${type}`);
		return m;
	}
	async waitState(pred, ms = 30000) {
		const s = await until(() => this.state && pred(this.state) && this.state, ms, 50);
		if (!s) throw new Error("timeout waiting for the chat's state");
		return s;
	}
	assistantText() {
		return (this.state?.messages ?? [])
			.filter((m) => m.role === "assistant")
			.flatMap((m) => m.content ?? [])
			.map((b) => b.text ?? "")
			.join("\n");
	}
	close() {
		try {
			this.ws.close();
		} catch {
			/* closed */
		}
	}
}

async function connect(srv, owner, clientId) {
	// A browser-like socket (the page's Origin): only those carry a sender identity.
	const headers = { origin: `http://localhost:${srv.port}`, ...OWNERS[owner] };
	const ws = new WebSocket(srv.ws, { headers });
	await new Promise((ok, bad) => {
		ws.once("open", ok);
		ws.once("error", bad);
	});
	const c = new Client(ws);
	c.send({ type: "hello", clientId, locale: "en" });
	await c.waitFor("ready");
	await c.waitFor("snapshot");
	c.send({ type: "set_model", modelId: "mock/mock-model" });
	await c.waitState((s) => s.model?.id === "mock-model", 15000);
	return c;
}

async function crash(srv) {
	try {
		process.kill(-srv.pid(), "SIGKILL");
	} catch {
		/* gone */
	}
	await until(async () => {
		try {
			await fetch(`http://127.0.0.1:${srv.port}/api/health`);
			return false;
		} catch {
			return true;
		}
	}, 10000);
}

const srv = await ownServer({
	name: "question-busy-restart",
	mock: mockReply,
	prepare: async ({ dataDir }) => writeFileSync(join(dataDir, "people.json"), JSON.stringify(PEOPLE, null, 2)),
});
const results = [];
let failed = 0;
function check(name, ok, observed) {
	console.log(`${ok ? "✓" : "✗ FAIL"} ${name}${observed === undefined ? "" : ` — ${JSON.stringify(observed)}`}`);
	if (!ok) failed++;
}

try {
	for (const how of ["restart", "crash", "restart-after-turn-ends", "wai", "cancel"]) {
		const owner = how === "wai" ? "Wai" : "Shine";
		const c = await connect(srv, owner, `busy-restart-${how}`);
		c.send({ type: "new_chat" });
		await sleep(400);
		const tag = `x${how.replace(/\W/g, "")}`;
		c.send({ type: "prompt", text: `QA-ASK ${tag}` });
		await c.waitState((s) => !s.isStreaming && c.assistantText().includes(`POSTED ${tag}`), 15000);
		const rec = recordOf(srv, tag);
		const pending = await c.waitFor("question_pending", (m) => JSON.stringify(m.questions).includes(`QTAG-${tag}`));
		const busy = !["wai", "cancel"].includes(how);
		if (busy) {
			c.send({ type: "prompt", text: "QA-SLOW 30" });
			await c.waitState((s) => s.isStreaming, 10000);
		}
		if (how === "cancel") c.send({ type: "question_answer", id: pending.id, answers: [], cancelled: true });
		else c.send({ type: "question_answer", id: pending.id, answers: [{ id: "pick", selected: ["Alpha"] }] });
		await sleep(800);
		const storeWhileBusy = recordOf(srv, tag)?.state ?? "gone";
		if (how === "restart-after-turn-ends") await until(() => assistantLines(rec.sessionFile, `tag=${tag}`) >= 1, 60000);
		c.close();
		if (how === "crash") await crash(srv);
		if (busy) await srv.restart();
		await until(() => assistantLines(rec.sessionFile, `tag=${tag}`) >= 1, 60000);
		await sleep(busy ? 3000 : 1000);
		const wakes = wakeLines(rec.sessionFile, tag);
		const sentBy = wakes[0] ? (JSON.parse(wakes[0]).message?.sentBy ?? null) : null;
		const woke = lines(rec.sessionFile).filter((l) => l.includes('"role":"assistant"') && l.includes(`tag=${tag}`));
		const from = /WOKE from=(\S+) kind=(\S+)/.exec(woke[0] ?? "");
		const row = {
			how,
			storeWhileBusy,
			storeAfter: recordOf(srv, tag)?.state ?? "gone",
			wakeLines: wakes.length,
			wokeReplies: woke.length,
			from: from?.[1] ?? null,
			kind: from?.[2] ?? null,
			sentBy: sentBy?.name ?? null,
		};
		results.push(row);
		check(`${how}: exactly one wake in the transcript`, row.wakeLines === 1, row.wakeLines);
		check(`${how}: exactly one woken reply`, row.wokeReplies === 1, row.wokeReplies);
		check(`${how}: the model saw [From: ${owner}] first`, row.from === owner, row.from);
		check(`${how}: the transcript's wake has sentBy ${owner}`, row.sentBy === owner, row.sentBy);
		check(
			`${how}: ${how === "cancel" ? "cancelled" : "answered"}`,
			row.kind === (how === "cancel" ? "cancelled" : "answered"),
			row.kind,
		);
		check(`${how}: the card left pending-questions.json`, row.storeAfter === "gone", row.storeAfter);
		if (busy && how !== "restart-after-turn-ends")
			check(
				`${how}: still delivering on disk while it waits behind the busy turn`,
				storeWhileBusy === "delivering",
				storeWhileBusy,
			);
	}
} catch (e) {
	failed++;
	console.log(`✗ FAIL ${String(e?.stack ?? e)}`);
} finally {
	if (OUT) writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
	await srv.stop();
}
console.log(failed ? `✗ ${failed} check(s) failed` : "✓ question-busy-restart: all checks passed");
process.exit(failed ? 1 : 0);
