/* rewind-to-here E2E (no tokens): every message's "Rewind to here", and the plain-words
 * "this chat is too big to send" card with its "Go back there" button.
 *
 * A mock Anthropic Messages API plays the model. It records every request body and refuses any
 * body over 32 MB with the same 413 request_too_large Anthropic sends. A tiny extension cancels
 * compaction, like billion-context-pi does, so an oversized chat stays stuck the way it did live.
 *
 * Part A (browser): a small chat of three questions.
 *  - every user and assistant message has "Rewind to here";
 *  - rewinding from the first answer asks first ("The 4 messages after this…"), then drops the
 *    later questions from the chat, adds the automatic summary, and keeps every entry in the file;
 *  - the next request carries the kept part and the summary, never the skipped questions;
 *  - rewinding from a question puts its text back into the message box;
 *  - "Rewind to here" is disabled while a reply is running.
 * Part B (WebSocket, then browser): a chat that piles up 3.5 MB pictures until a request is 413'd.
 *  - rewind_to while a reply runs is refused;
 *  - the snapshot carries the card data: size, picture count, the 32 MB limit, the raw error and a
 *    suggestion that keeps at most 24 MB;
 *  - in the browser the card says it in plain words, keeps the raw error under details, and its
 *    button rewinds; the next message is sent without the skipped pictures and gets an answer.
 * Usage: npm run build && node tests/rewind-to-here-test.mjs [port]
 *        (REWIND_SHOT=/tmp/rewind.png saves rewind-confirm.png and rewind-card.png next to it)
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { CHROME_PATH } from "./lib/chrome.mjs";

const PORT = Number(process.argv[2] || 8971);
const MOCK_PORT = PORT + 1;
const LIMIT = 32 * 1024 * 1024;
const FIT = 24 * 1024 * 1024;
const SLOW_MS = 4000;
const IMAGE_BYTES = Math.round(3.5 * 1024 * 1024);
const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-rewind-")));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir, join(agentDir, "extensions")]) mkdirSync(d, { recursive: true });

// ---- mock Anthropic Messages API ---------------------------------------------------------------
/** @type {{kind: "turn"|"summary"|"other", bytes: number, text: string, images: number, status: number}[]} */
const requests = [];
function walk(value, acc) {
	if (Array.isArray(value)) {
		for (const v of value) walk(v, acc);
		return;
	}
	if (!value || typeof value !== "object") return;
	if (value.type === "image") {
		acc.images += 1;
		return;
	}
	if (value.type === "text" && typeof value.text === "string") acc.texts.push(value.text);
	if (typeof value.content === "string") acc.texts.push(value.content);
	for (const [k, v] of Object.entries(value)) if (k !== "text" && v && typeof v === "object") walk(v, acc);
}
const mock = createServer(async (req, res) => {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	const raw = Buffer.concat(chunks);
	let payload;
	try {
		payload = JSON.parse(raw.toString("utf8"));
	} catch {
		res.writeHead(400).end("bad json");
		return;
	}
	const acc = { texts: [], images: 0 };
	walk(payload.messages, acc);
	const text = acc.texts.join("\n");
	const summary = /summarization assistant/i.test(JSON.stringify(payload.system ?? ""));
	const kind = summary ? "summary" : Array.isArray(payload.tools) && payload.tools.length > 0 ? "turn" : "other";
	const rec = { kind, bytes: raw.length, text, images: acc.images, status: 200 };
	requests.push(rec);
	if (raw.length > LIMIT) {
		rec.status = 413;
		res.writeHead(413, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				type: "error",
				error: { type: "request_too_large", message: "Request exceeds the maximum size" },
			}),
		);
		return;
	}
	const markers = text.match(/\bQ[AB]-[A-Z0-9-]+/g) ?? [];
	const last = markers.at(-1) ?? "none";
	const reply =
		kind === "summary"
			? `SKIPPED-SUMMARY-${requests.filter((r) => r.kind === "summary").length}: the user asked a few more things`
			: kind === "turn"
				? `answer to ${last}`
				: "Mock title";
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	ev("message_start", {
		message: {
			id: `msg_${requests.length}`,
			type: "message",
			role: "assistant",
			model: payload.model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 100, output_tokens: 1 },
		},
	});
	ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply.slice(0, 7) } });
	if (kind === "turn" && last.includes("SLOW")) await sleep(SLOW_MS);
	ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply.slice(7) } });
	ev("content_block_stop", { index: 0 });
	ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
	ev("message_stop", {});
	res.end();
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));
const lastTurn = () => [...requests].reverse().find((r) => r.kind === "turn");

// ---- agent dir: the mock model, and compaction cancelled like billion-context-pi -----------------
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "rewind-test" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "anthropic-messages",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "rewind-test",
				models: [
					{
						id: "rewind-mock",
						name: "Rewind Mock",
						input: ["text", "image"],
						contextWindow: 1000000,
						maxTokens: 4096,
						reasoning: false,
					},
				],
			},
		},
	}),
);
writeFileSync(
	join(agentDir, "settings.json"),
	JSON.stringify({ defaultProvider: "mock", defaultModel: "rewind-mock" }),
);
writeFileSync(
	join(agentDir, "extensions", "no-compact.ts"),
	`export default function (pi: any) {\n\tpi.on("session_before_compact", async () => ({ cancel: true }));\n}\n`,
);

// Pictures for part B: a PNG signature and then incompressible bytes, 3.5 MB each.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function picture(name) {
	writeFileSync(join(workdir, name), Buffer.concat([PNG_SIG, randomBytes(IMAGE_BYTES - PNG_SIG.length)]));
	return { path: name, name, mode: "inline" };
}

const repoRoot = realpathSync(new URL("../", import.meta.url));
const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: repoRoot,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});
let serverLog = "";
const keepLog = (d) => {
	serverLog = (serverLog + d).slice(-8000);
};
server.stdout.on("data", keepLog);
server.stderr.on("data", keepLog);

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✓" : "✗ FAIL:"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures += 1;
}
async function waitFor(fn, timeout = 20000, step = 100) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		try {
			if (await fn()) return true;
		} catch {
			/* not yet */
		}
		await sleep(step);
	}
	return false;
}
async function waitForPort(port, timeout = 20000) {
	const up = await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok, timeout);
	if (!up) throw new Error(`server did not start on ${port}`);
}

/** The session file that holds a marker (pi keeps sessions under the agent dir). */
function sessionFileWith(marker) {
	const root = join(agentDir, "sessions");
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop();
		let names = [];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const n of names) {
			const p = join(dir, n);
			if (statSync(p).isDirectory()) stack.push(p);
			else if (n.endsWith(".jsonl") && readFileSync(p, "utf8").includes(marker)) return p;
		}
	}
	return null;
}
const entriesOf = (file) =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));

// ---- WebSocket client (part B) -------------------------------------------------------------------
class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		this.state = null;
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			if (message.type === "snapshot") this.state = message.state;
			else if (message.type === "snapshot_delta") {
				if (this.state?.rev === message.baseRev && message.conversationId === this.state.conversationId) {
					// A delta carries the light fields in state and only the new tail of messages in appended.
					const messages = [...(this.state.messages ?? []), ...(message.appended ?? [])];
					this.state = { ...this.state, ...message.state, messages };
				} else if (!this.resyncing) {
					// A gap (the server drops snapshots while the socket is backed up): ask for the full
					// state again, the way the page does.
					this.resyncing = setTimeout(() => {
						this.resyncing = null;
						this.send({ type: "get_state" });
					}, 300);
				}
			} else this.received.push(message);
		});
	}
	static async connect(clientId) {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		await new Promise((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		const client = new Client(ws);
		client.send({ type: "hello", clientId, locale: "en" });
		await client.waitForType("ready");
		await client.waitForState((s) => Boolean(s.conversationId));
		return client;
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	async waitForType(type, predicate = () => true, timeout = 20000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			const i = this.received.findIndex((m) => m.type === type && predicate(m));
			if (i >= 0) return this.received.splice(i, 1)[0];
			await sleep(50);
		}
		throw new Error(`timeout waiting for ${type}`);
	}
	async waitForState(predicate, timeout = 30000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && predicate(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error(`timeout waiting for state (isStreaming ${this.state?.isStreaming})`);
	}
}
const textOf = (m) =>
	(m.content ?? [])
		.map((b) => (b.type === "text" ? b.text : ""))
		.join("")
		.trim();
const hasAnswer = (s, marker) =>
	s.messages.some((m) => m.role === "assistant" && textOf(m).includes(`answer to ${marker}`));

// ---- browser helpers -------------------------------------------------------------------------------
let browser;
const pageErrors = [];
async function openWindow(clientId) {
	const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
	await ctx.addInitScript((id) => {
		localStorage.setItem("pi-web-client-id", id);
		localStorage.setItem("pi-web-ui:lang", "en");
	}, clientId);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => pageErrors.push(`${clientId}: ${e}`));
	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".topbar", { timeout: 60000 });
	await page.locator(".inputbox textarea").waitFor({ timeout: 20000 });
	return page;
}
async function send(page, text) {
	const ta = page.locator(".inputbox textarea");
	await ta.fill(text);
	await ta.press("Enter");
}
const messagesText = (page) => page.evaluate(() => document.querySelector(".messages")?.innerText ?? "");
const waitText = (page, text, timeout = 20000) =>
	waitFor(async () => (await messagesText(page)).includes(text), timeout);
const bubble = (page, role, text) => page.locator(`.msg.msg-${role}`, { hasText: text }).first();
async function openRewind(page, role, text) {
	const b = bubble(page, role, text);
	await b.hover();
	await b.locator(".msg-action-rewind").first().click();
	const bar = b.locator(".msg-rewind-confirm");
	await bar.waitFor({ timeout: 5000 });
	return { bubble: b, bar };
}
const shotPath = (suffix) => process.env.REWIND_SHOT?.replace(/[^/]*$/, `rewind-${suffix}.png`);

try {
	await waitForPort(PORT);
	browser = await chromium.launch({ executablePath: CHROME_PATH });

	// ======== Part A ========
	console.log("part A: a small chat, then rewind from an answer and from a question");
	const A = await openWindow("rewind-a");
	for (const q of ["QA-ONE alpha", "QA-TWO beta", "QA-THREE gamma"]) {
		await send(A, q);
		const marker = q.split(" ")[0];
		if (!(await waitText(A, `answer to ${marker}`))) throw new Error(`no answer to ${marker}`);
	}
	await sleep(500);
	const counts = await A.evaluate(() => ({
		messages: document.querySelectorAll(".messages .msg.msg-user, .messages .msg.msg-assistant").length,
		rewinds: document.querySelectorAll(
			".messages .msg.msg-user .msg-action-rewind, .messages .msg.msg-assistant .msg-action-rewind",
		).length,
	}));
	check(
		"every question and answer has “Rewind to here”",
		counts.messages === 6 && counts.rewinds === 6,
		JSON.stringify(counts),
	);

	const file = sessionFileWith("QA-THREE gamma");
	check("the chat's session file is found", !!file);
	const idsBefore = new Set(entriesOf(file).map((e) => e.id));

	const first = await openRewind(A, "assistant", "answer to QA-ONE");
	const askText = await first.bar.innerText();
	check(
		"the confirm bar says how many messages drop out, that they stay saved, and that a summary is added",
		/The 4 messages after this/.test(askText) && /stay saved/.test(askText) && /summary/.test(askText),
		askText,
	);
	const shotConfirm = shotPath("confirm");
	if (shotConfirm) await A.locator(".messages").screenshot({ path: shotConfirm });
	await first.bar.locator(".msg-rewind-yes").click();
	const rewound = await waitFor(async () => {
		const t = await messagesText(A);
		return t.includes("SKIPPED-SUMMARY-1") && !t.includes("QA-TWO") && !t.includes("QA-THREE");
	});
	check(
		"after the rewind the later questions are gone from the chat and the summary shows",
		rewound,
		await messagesText(A),
	);
	check(
		"the chat still shows the kept question and answer",
		(await messagesText(A)).includes("QA-ONE alpha") && (await messagesText(A)).includes("answer to QA-ONE"),
	);
	const entries = entriesOf(file);
	const idsAfter = new Set(entries.map((e) => e.id));
	check(
		"nothing was deleted from the session file",
		[...idsBefore].every((id) => idsAfter.has(id)),
	);
	check(
		"the skipped questions are still in the file",
		readFileSync(file, "utf8").includes("QA-TWO beta") && readFileSync(file, "utf8").includes("QA-THREE gamma"),
	);
	const summaryEntry = entries.find((e) => e.type === "branch_summary");
	check(
		"a branch summary entry was added with the summary text",
		!!summaryEntry && String(summaryEntry.summary ?? "").includes("SKIPPED-SUMMARY-1"),
		JSON.stringify(summaryEntry ?? null).slice(0, 200),
	);

	await send(A, "QA-FOUR delta");
	check("the next question gets an answer", await waitText(A, "answer to QA-FOUR"));
	const t4 = lastTurn();
	check(
		"the next request carries the kept part and the summary",
		!!t4 && t4.text.includes("QA-ONE alpha") && t4.text.includes("SKIPPED-SUMMARY-1") && t4.text.includes("QA-FOUR"),
		t4?.text.slice(0, 300),
	);
	check(
		"the next request carries none of the skipped questions",
		!!t4 && !t4.text.includes("QA-TWO") && !t4.text.includes("QA-THREE"),
		t4?.text.slice(0, 300),
	);

	const second = await openRewind(A, "user", "QA-FOUR delta");
	const askUser = await second.bar.innerText();
	check(
		"rewinding from a question says it goes back to before it and its text returns to the box",
		/before this question/.test(askUser) && /\(2 in all\)/.test(askUser) && /message box/.test(askUser),
		askUser,
	);
	await second.bar.locator(".msg-rewind-yes").click();
	const back = await waitFor(async () => {
		const box = await A.locator(".inputbox textarea").inputValue();
		const t = await messagesText(A);
		return box.trim() === "QA-FOUR delta" && !t.includes("answer to QA-FOUR") && t.includes("SKIPPED-SUMMARY-2");
	});
	check(
		"the question's text is back in the message box and it left the chat",
		back,
		`box=${JSON.stringify(await A.locator(".inputbox textarea").inputValue())}`,
	);

	await A.locator(".inputbox textarea").fill("");
	await send(A, "QA-SLOW hold on");
	const runningSeen = await waitFor(async () => {
		const btn = bubble(A, "assistant", "answer to QA-ONE").locator(".msg-action-rewind").first();
		return (await btn.isDisabled()) === true;
	}, 3000);
	check("“Rewind to here” is disabled while a reply is running", runningSeen);
	check("the slow reply finishes", await waitText(A, "answer to QA-SLOW", 20000));
	const enabledAgain = await waitFor(async () => {
		const btn = bubble(A, "assistant", "answer to QA-ONE").locator(".msg-action-rewind").first();
		return (await btn.isDisabled()) === false;
	}, 5000);
	check("…and enabled again once it stops", enabledAgain);

	// ======== Part B ========
	console.log("part B: pile up pictures until the provider refuses the request");
	const B = await Client.connect("rewind-b");
	B.send({ type: "new_chat" });
	await B.waitForState((s) => s.messages.length === 0);
	B.send({ type: "set_model", modelId: "mock/rewind-mock" });
	await B.waitForState((s) => s.model?.id === "rewind-mock");

	B.send({ type: "prompt", text: "QB-SLOW warm up" });
	const running = await B.waitForState((s) => s.isStreaming && s.messages.some((m) => m.role === "user"));
	const someUser = running.messages.find((m) => m.role === "user");
	B.send({ type: "rewind_to", messageId: someUser.id });
	const refused = await B.waitForType("rewind_done");
	check("rewind_to while a reply runs is refused", refused.ok === false, JSON.stringify(refused));
	await B.waitForState((s) => !s.isStreaming && hasAnswer(s, "QB-SLOW"));

	const turns = [
		["QB-ONE first pictures", 2],
		["QB-TWO more pictures", 2],
		["QB-THREE even more", 2],
		["QB-FOUR one too many", 1],
	];
	for (const [text, n] of turns) {
		const marker = text.split(" ")[0];
		const attachments = Array.from({ length: n }, (_, i) => picture(`${marker.toLowerCase()}-${i + 1}.png`));
		B.send({ type: "prompt", text, attachments });
		if (marker === "QB-FOUR") break;
		await B.waitForState((s) => !s.isStreaming && hasAnswer(s, marker), 60000);
	}
	const stuck = await B.waitForState((s) => !!s.tooBig && !s.isStreaming && !s.compaction, 60000);
	const tb = stuck.tooBig;
	const refusedReq = [...requests].reverse().find((r) => r.kind === "turn");
	check(
		"the provider refused the oversized request (413)",
		refusedReq?.status === 413 && refusedReq.bytes > LIMIT,
		`${refusedReq?.status} ${refusedReq?.bytes}`,
	);
	check("the card data says it is a size problem", tb.kind === "bytes", tb.kind);
	check("…with the picture count", tb.images === 7, String(tb.images));
	check("…the size of what would be sent", tb.bytes > 7 * IMAGE_BYTES * (4 / 3), String(tb.bytes));
	check("…the 32 MB limit", tb.limitBytes === LIMIT, String(tb.limitBytes));
	check("…and the raw error", /request_too_large/.test(tb.errorText), tb.errorText);
	check(
		"…and a place to go back to that keeps at most 24 MB",
		!!tb.suggest && tb.suggest.keepBytes <= FIT && tb.suggest.keepImages === 4 && /QB-TWO/.test(tb.suggest.text),
		JSON.stringify(tb.suggest),
	);
	const fileB = sessionFileWith("QB-FOUR one too many");
	const idsBeforeB = new Set(entriesOf(fileB).map((e) => e.id));
	const imagesInFile = (f) => (readFileSync(f, "utf8").match(/"type":"image"/g) ?? []).length;
	const fileImagesBefore = imagesInFile(fileB);
	B.ws.close();
	await sleep(300);

	console.log("part B: the card in the browser");
	const P = await openWindow("rewind-b");
	const card = P.locator(".too-big-card");
	const cardUp = await waitFor(async () => await card.isVisible(), 30000);
	check("the browser shows the too-big card", cardUp);
	const cardText = cardUp ? await card.innerText() : "";
	check(
		"the card says the size, the picture count and the limit in plain words",
		/too big to send/.test(cardText) && /33 MB, with 7 pictures/.test(cardText) && /at most 32 MB/.test(cardText),
		cardText,
	);
	check(
		"the card offers to go back and says what that skips",
		/go back to “answer to QB-TWO/.test(cardText) && /with 4 pictures/.test(cardText),
		cardText,
	);
	check(
		"the raw error stays under details",
		(await card.locator("details summary").innerText()).includes("Details") &&
			(await card.locator("details pre").textContent()).includes("request_too_large"),
	);
	const shotCard = shotPath("card");
	if (shotCard) await card.screenshot({ path: shotCard });

	await card.locator(".too-big-go").click();
	const wentBack = await waitFor(async () => {
		const t = await messagesText(P);
		return !(await card.isVisible()) && !t.includes("QB-THREE") && !t.includes("QB-FOUR") && /SKIPPED-SUMMARY/.test(t);
	}, 30000);
	check("the button rewinds: the card and the piled-up part are gone, a summary is added", wentBack);
	await send(P, "QB-FIVE after going back");
	check("the next message succeeds", await waitText(P, "answer to QB-FIVE", 30000));
	const t5 = lastTurn();
	check(
		"it was sent without the skipped pictures and questions",
		!!t5 &&
			t5.status === 200 &&
			t5.images === 4 &&
			t5.bytes < FIT + 1024 * 1024 &&
			!t5.text.includes("QB-THREE") &&
			!t5.text.includes("QB-FOUR"),
		t5 && `${t5.status} ${t5.images} pictures ${t5.bytes} bytes`,
	);
	const idsAfterB = new Set(entriesOf(fileB).map((e) => e.id));
	check(
		"nothing was deleted from the big chat's file",
		[...idsBeforeB].every((id) => idsAfterB.has(id)),
	);
	check(
		"every picture is still in the big chat's file",
		imagesInFile(fileB) >= fileImagesBefore,
		String(fileImagesBefore),
	);
	check(
		"no summary request carried a picture",
		requests.filter((r) => r.kind === "summary").every((r) => r.images === 0 && r.bytes < LIMIT),
	);
	check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (err) {
	failures += 1;
	console.error("✗ FAIL:", err?.stack ?? err);
	console.error("server log tail:\n" + serverLog.slice(-3000));
	console.error(
		"mock requests:\n" +
			requests.map((r) => `  ${r.kind} ${r.status} ${r.bytes} bytes ${r.images} pictures`).join("\n"),
	);
} finally {
	await browser?.close().catch(() => {});
	server.kill("SIGTERM");
	mock.close();
}

if (failures > 0) {
	console.log(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\n✅ REWIND-TO-HERE CHECKS PASSED");
process.exit(0);
