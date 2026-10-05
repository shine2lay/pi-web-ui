/* role-reports E2E (no tokens): the app's 6 am report request, through the control socket.
 *
 * A sealed server (TZ America/Los_Angeles) with a scripted model and the real pi-identity
 * (PI_IDENTITY_PKG, default ~/projects/pi-identity). Fake roles in a temp identities folder: alpha (home
 * chat A), beta (home chat B), gamma (no home chat). A and B are saved transcripts, so both start closed.
 * Checks:
 *  1. an agent can't send one: message_role with kind "report" stores nothing; the control socket
 *     refuses role_report without the app token and with a wrong one (and logs it);
 *  2. a closed chat: beta's home chat is woken, gets the request card ("6 am report · <date>", the
 *     server's stamp: from the app) and answers; message_role can't reply to the request;
 *  3. a busy chat: alpha's request lands only after its running turn, which ends whole;
 *  4. the receipt: role_reports lists one receipt per role (delivered, then replied with the four
 *     headings and a length), with no text; the store keeps none of the answers' text; Settings lists them;
 *  5. a retry: asking again for the same role and day returns the first request, before and after a
 *     restart, and nothing is sent twice;
 *  6. a restart while a request is held (paused): kept, delivered once after the resume, and not again
 *     after another restart.
 * Never prints what goes to the model (rule 11).
 * Usage: npm run build && node tests/role-reports-test.mjs   (ROLEREPORT_DEBUG=1: server output)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { textOf } from "./lib/mock-model.mjs";
import { ownServer } from "./lib/own-server.mjs";

const PI_IDENTITY = process.env.PI_IDENTITY_PKG ?? join(userInfo().homedir, "projects", "pi-identity");
if (!existsSync(join(PI_IDENTITY, "package.json"))) {
	console.log(`✗ FAIL: pi-identity not found at ${PI_IDENTITY} (set PI_IDENTITY_PKG)`);
	process.exit(1);
}
const TZ = "America/Los_Angeles";

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

/** YYYY-MM-DD in Pacific time, `back` days before today. */
function pacificDay(back) {
	const today = new Intl.DateTimeFormat("en-CA", {
		timeZone: TZ,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date());
	const [y, m, d] = today.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d - back)).toISOString().slice(0, 10);
}
const D1 = pacificDay(1);
const D2 = pacificDay(2);

// ---- the scripted model ------------------------------------------------------------------------------
const SLOW_TEXT = `SLOW-ANSWER ${"lorem ipsum dolor sit amet ".repeat(12)}END-OF-SLOW`;
const REPORT_HEAD = /^\[Role message (rm-[0-9a-f]{8}) from the app · 6 am report · (\d{4}-\d{2}-\d{2})\]/;
const reportText = (date) =>
	[
		"## Goal or hypothesis",
		`Check the morning report for ${date}. REPORT-MARK`,
		"## Done yesterday",
		"Built and tested it.",
		"## Learned",
		"Metadata was enough.",
		"## Next",
		"Watch the first real morning.",
	].join("\n");
function decide({ payload, lastUser, toolResult, sideRequest }) {
	if (sideRequest) return "Chat";
	const users = (Array.isArray(payload.messages) ? payload.messages : []).filter(
		(m) => m.role === "user" && !/^\(System reminder/.test(textOf(m)),
	);
	const last = users.length > 0 ? textOf(users.at(-1)) : lastUser;
	if (toolResult) return `TOOL RESULT: ${toolResult.content}`;
	const rep = REPORT_HEAD.exec(last);
	if (rep) return reportText(rep[2]);
	if (last.startsWith("SEND ")) return { tool: "message_role", args: JSON.parse(last.slice("SEND ".length)) };
	if (last.startsWith("SLOW")) return { text: SLOW_TEXT, stream: { everyMs: 60, pieceChars: 8 } };
	return "ok";
}
function reply(ctx) {
	const out = decide(ctx);
	if (process.env.ROLEREPORT_DEBUG) {
		const head = /^\[Role message (rm-[0-9a-f]{8})/.exec(ctx.lastUser)?.[1];
		const what = typeof out === "string" ? `text ${out.slice(0, 12)}` : out?.tool ? `tool ${out.tool}` : "stream";
		console.log(`[mock] ${head ?? "-"} side=${ctx.sideRequest} result=${!!ctx.toolResult} -> ${what}`);
	}
	return out;
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
	const write = (path, roleId) => {
		const ts = Date.parse("2026-10-01T10:00:00.000Z");
		const id = path.match(/_([^_]+)\.jsonl$/)?.[1];
		const at = (n) => new Date(ts + n * 1000).toISOString();
		const lines = [
			{ type: "session", version: 3, id, timestamp: at(0), cwd: workdir },
			{ type: "model_change", id: "mc", parentId: null, timestamp: at(0), provider: "mock", modelId: "mock-model" },
			{
				type: "custom",
				customType: "identity",
				id: "e2",
				parentId: "mc",
				timestamp: at(1),
				data: { v: 1, id: roleId, via: "command" },
			},
			{
				type: "message",
				id: "e3",
				parentId: "e2",
				timestamp: at(2),
				message: { role: "user", content: [{ type: "text", text: `${roleId} home starts` }], timestamp: ts + 2000 },
			},
			{
				type: "message",
				id: "e4",
				parentId: "e3",
				timestamp: at(3),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: "openai-completions",
					provider: "mock",
					model: "mock-model",
					usage,
					stopReason: "stop",
					timestamp: ts + 3000,
				},
			},
		];
		writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	};
	write(files.A, "alpha");
	write(files.B, "beta");
	idDir = join(root, "identities");
	const role = (id, json) => {
		mkdirSync(join(idDir, id), { recursive: true });
		writeFileSync(join(idDir, id, "identity.json"), JSON.stringify({ id, ...json }, null, "\t"));
		writeFileSync(join(idDir, id, "about.md"), `# ${json.title}\n\n**Focus:** ${id} things.\n`);
		writeFileSync(join(idDir, id, "notebook.md"), "");
	};
	role("alpha", { title: "Alpha desk", homeChat: files.A });
	role("beta", { title: "Beta desk", homeChat: files.B });
	role("gamma", { title: "Gamma lab" });
}

const srv = await ownServer({
	name: "role-reports",
	verbose: !!process.env.ROLEREPORT_DEBUG,
	stdout: true,
	mock: reply,
	prepare: seed,
	env: {
		TZ,
		get PI_IDENTITY_DIR() {
			return idDir;
		},
		PI_IDENTITY_REINDEX: "0",
	},
});

// ---- the control socket ------------------------------------------------------------------------------
function control(req) {
	return new Promise((resolve) => {
		const c = createConnection(join(srv.dataDir, "pi-web-ui.sock"));
		let buf = "";
		const timer = setTimeout(() => {
			c.destroy();
			resolve(null);
		}, 5000);
		c.on("connect", () => c.write(`${JSON.stringify(req)}\n`));
		c.on("data", (d) => {
			buf += d.toString();
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				clearTimeout(timer);
				c.destroy();
				try {
					resolve(JSON.parse(buf.slice(0, nl)));
				} catch {
					resolve(null);
				}
			}
		});
		c.on("error", () => {
			clearTimeout(timer);
			resolve(null);
		});
	});
}
const token = () => readFileSync(join(srv.dataDir, "app-token"), "utf8").trim();
const ask = (role, date, extra = {}) => control({ cmd: "role_report", token: token(), role, date, ...extra });
const receipts = async (date) => (await control({ cmd: "role_reports", date }))?.receipts ?? [];

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
	async pause(paused) {
		const n = this.received.length;
		this.send({ type: "role_messages_pause", paused });
		const msg = await waitFor(() => this.received.slice(n).find((m) => m.type === "role_messages"), 10000, 50);
		return msg?.paused === paused;
	}
	close() {
		try {
			this.ws.close();
		} catch {
			/* gone */
		}
	}
}

function entries(file) {
	try {
		return readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
			.filter((e) => e.type === "message")
			.map((e) => ({ role: e.message?.role, text: textOf(e.message), stopReason: e.message?.stopReason }));
	} catch {
		return [];
	}
}
const requestsIn = (file, id) =>
	entries(file).filter((m) => m.role === "user" && m.text.startsWith(`[Role message ${id} `));
const toolResultsIn = (file) =>
	entries(file)
		.filter((m) => m.role === "toolResult")
		.map((m) => m.text);
const answeredIn = (file, id) => {
	const all = entries(file);
	const i = all.findIndex((m) => m.role === "user" && m.text.startsWith(`[Role message ${id} `));
	return i >= 0 && all.slice(i + 1).some((m) => m.role === "assistant" && m.text.includes("REPORT-MARK"));
};
const storeText = () => readFileSync(join(srv.dataDir, "role-messages.json"), "utf8");

let w;
let w2;
try {
	w = await Client.connect("rolereport-w");

	// 1. An agent can't send one.
	await w.open(files.A);
	await w.prompt(`SEND ${JSON.stringify({ to: "beta", kind: "report", text: "Write your report now." })}`);
	check(
		"message_role with kind report stores nothing",
		!/"kind":"report"/.test(existsSync(join(srv.dataDir, "role-messages.json")) ? storeText() : ""),
	);
	const noToken = await control({ cmd: "role_report", role: "beta", date: D1 });
	const wrongToken = await control({ cmd: "role_report", token: "0".repeat(64), role: "beta", date: D1 });
	check(
		"the control socket refuses role_report without the app token, and with a wrong one",
		noToken?.ok === false && wrongToken?.ok === false && /only the app's report job/.test(String(wrongToken?.error)),
		JSON.stringify({ noToken, wrongToken }),
	);
	const serverLog = () => `${srv.stdout()}\n${srv.stderr()}`;
	check(
		"the refusals are in the server log (never the token)",
		/refused a report request for beta/.test(serverLog()) && !serverLog().includes(token()),
	);
	check("nothing was asked", (await receipts()).length === 0);

	// 2. A closed chat is woken and answers.
	const betaAsk = await ask("beta", D1, { activity: { messages: 5, chats: 1, queue: 2, log: 1 } });
	check(
		"the app's job asks beta for its report",
		betaAsk?.ok === true && betaAsk.existing === false,
		JSON.stringify(betaAsk),
	);
	const betaId = betaAsk?.receipt?.id;
	const betaDone = await waitFor(() => answeredIn(files.B, betaId), 60000);
	check("beta's closed home chat is woken, gets the request and answers", !!betaDone);
	const req = requestsIn(files.B, betaId)[0]?.text ?? "";
	check(
		"the request names the day and the four headings",
		req.startsWith(`[Role message ${betaId} from the app · 6 am report · ${D1}]`) &&
			["## Goal or hypothesis", "## Done yesterday", "## Learned", "## Next"].every((h) => req.split("\n").includes(h)),
	);
	w2 = await Client.connect("rolereport-w2");
	await w2.open(files.B);
	const card = [...(w2.state.messages ?? [])].reverse().find((m) => m.roleMessage?.id === betaId)?.roleMessage;
	check(
		"the card is the server's: the app's 6 am report for that day",
		card?.kind === "report" && card?.from === "app" && card?.reportDate === D1,
		JSON.stringify(card ? { kind: card.kind, from: card.from, reportDate: card.reportDate } : null),
	);
	await w2.prompt(`SEND ${JSON.stringify({ to: "alpha", kind: "reply", replyTo: betaId, text: "my report" })}`);
	check(
		"message_role can't reply to the request",
		toolResultsIn(files.B).some((t) => t.includes("6 am report request")),
	);

	// 3. A busy chat gets it only after its running turn.
	w.send({ type: "prompt", text: "SLOW turn" });
	await waitFor(() => w.state.isStreaming === true, 10000, 50);
	const alphaAsk = await ask("alpha", D1);
	const alphaId = alphaAsk?.receipt?.id;
	check("the app's job asks alpha (busy) for its report", alphaAsk?.ok === true && !!alphaId);
	const alphaDone = await waitFor(() => answeredIn(files.A, alphaId), 60000);
	const aAll = entries(files.A);
	const slowAt = aAll.findIndex((m) => m.role === "assistant" && m.text.startsWith("SLOW-ANSWER"));
	const reqAt = aAll.findIndex((m) => m.role === "user" && m.text.startsWith(`[Role message ${alphaId} `));
	check(
		"a busy chat gets the request only after its running turn, which ends whole",
		!!alphaDone &&
			slowAt >= 0 &&
			reqAt > slowAt &&
			aAll[slowAt].text === SLOW_TEXT &&
			aAll[slowAt].stopReason === "stop",
		`slow at ${slowAt}, request at ${reqAt}`,
	);

	// 4. The receipts.
	const final = await waitFor(async () => {
		const list = await receipts(D1);
		return list.length === 2 && list.every((r) => r.reply) ? list : null;
	}, 30000);
	const byRole = Object.fromEntries((final ?? []).map((r) => [r.role, r]));
	check(
		"the receipts: one per role, replied with the four headings",
		["alpha", "beta"].every(
			(r) => byRole[r]?.state === "replied" && byRole[r]?.reply?.headings === true && byRole[r]?.reply?.chars > 100,
		),
		JSON.stringify(final),
	);
	check(
		"the receipts carry no text",
		!!final && !JSON.stringify(final).includes("REPORT-MARK") && !JSON.stringify(final).includes("Goal or"),
	);
	check("the store keeps none of the answers' text", !storeText().includes("REPORT-MARK"));
	const rows = (await w2.roleMessages()).messages.filter((r) => r.kind === "report");
	check(
		"Settings lists both as the app's reports, with the check",
		rows.length === 2 && rows.every((r) => r.from === "app" && r.report?.date === D1 && r.report?.headings === true),
		JSON.stringify(rows.map((r) => ({ from: r.from, state: r.state, report: r.report }))),
	);
	check(
		"the server log says so (and never the token)",
		/beta's report for \d{4}-\d{2}-\d{2}: answered with the four headings/.test(serverLog()) &&
			!serverLog().includes(token()),
	);
	check("gamma (no home chat) is refused", (await ask("gamma", D1))?.ok === false);

	// 5. A retry: the same request back, before and after a restart; nothing sent twice.
	const retry = await ask("beta", D1);
	check(
		"asking again returns the first request",
		retry?.ok === true && retry.existing === true && retry.receipt?.id === betaId,
	);
	w.close();
	w2.close();
	await srv.restart();
	const retry2 = await ask("beta", D1);
	check("and after a restart too", retry2?.ok === true && retry2.existing === true && retry2.receipt?.id === betaId);
	await sleep(6000);
	check(
		"nothing was sent twice",
		requestsIn(files.B, betaId).length === 1 &&
			requestsIn(files.A, alphaId).length === 1 &&
			(await receipts(D1)).length === 2,
	);

	// 6. A restart while a request is held.
	w = await Client.connect("rolereport-w3");
	check("the owner pauses role messages", await w.pause(true));
	const held = await ask("beta", D2);
	const heldId = held?.receipt?.id;
	check("a request while paused is taken and held", held?.ok === true && held.paused === true && !!heldId);
	await sleep(4000);
	check("held: not delivered", requestsIn(files.B, heldId).length === 0);
	w.close();
	await srv.restart();
	w = await Client.connect("rolereport-w4");
	await sleep(4000);
	check(
		"a restart keeps it held",
		requestsIn(files.B, heldId).length === 0 && (await receipts(D2))[0]?.state === "waiting",
	);
	check("the owner resumes", await w.pause(false));
	const resumed = await waitFor(() => answeredIn(files.B, heldId), 60000);
	await sleep(6000);
	check("resuming delivers it exactly once", !!resumed && requestsIn(files.B, heldId).length === 1);
	w.close();
	await srv.restart();
	await sleep(8000);
	const again = await receipts(D2);
	check(
		"another restart doesn't deliver it again",
		requestsIn(files.B, heldId).length === 1 && again.length === 1 && again[0].state === "replied",
		JSON.stringify(again),
	);
} catch (err) {
	console.log(`✗ FAIL: ${err instanceof Error ? err.stack : String(err)}`);
	failures += 1;
} finally {
	w?.close();
	w2?.close();
	await srv.stop();
}
if (failures > 0) {
	try {
		const store = JSON.parse(storeText());
		console.log(`store: paused ${store.paused}`);
		for (const m of store.messages ?? []) {
			console.log(
				`  ${m.id} ${m.kind} ${m.from?.role}->${m.to?.role} ${m.state} sends ${m.sends} to ${m.targetChat ?? "-"} report ${JSON.stringify(m.report ?? null)}${m.error ? ` error: ${m.error}` : ""}`,
			);
		}
	} catch (err) {
		console.log(`store: unreadable (${err instanceof Error ? err.message : String(err)})`);
	}
}
console.log(failures === 0 ? "role-reports: all passed" : `role-reports: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
