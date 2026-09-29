/**
 * chat-open-speed — a chat shows its newest messages before it has finished opening.
 *
 * Opening a big chat used to take seconds: the server repaired the file, read it with the SDK and
 * started every add-on before the browser saw anything. Now one read of the file comes first and
 * its newest messages go out at once as a read-only preview (`switch_preview`); the normal open
 * carries on behind it and its snapshot replaces the preview.
 *
 * Over the socket:
 *   1. a healthy chat previews first: switch_preview arrives before the snapshot and before
 *      switch_done, and its messages are the SAME ids, window start, question index and picture
 *      URLs as the snapshot's — that is what makes the swap invisible;
 *   2. a chat with a branch and a rewind previews the branch it is actually on;
 *   3. a chat whose last answer was cut off mid tool call gets no preview (it needs repairing) and
 *      opens the old way, correctly;
 *   4. a file that is not a chat at all gets no preview and fails with the usual error;
 *   5. a message written for another chat is refused rather than dropped into the open one.
 *
 * In the browser (the snapshot and switch_done frames are held back so the preview can be seen):
 *   6. the newest messages show while the chat is still opening, a message written then waits as
 *      "sending" and goes out once the chat is ready, and the messages already on screen are not
 *      rebuilt when the snapshot lands (no jump);
 *   7. leaving the chat before it opened marks that message as not sent, and it never reaches the
 *      chat's file.
 *
 * Zero tokens: a stand-in model. Usage: node tests/chat-open-preview-test.mjs   (after npm run build)
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`  ${ok ? "✓" : "✗ FAIL:"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

const sessionsDir = mkdtempSync(join(tmpdir(), "pi-web-open-preview-sessions-"));
const workCwd = mkdtempSync(join(tmpdir(), "pi-web-open-preview-cwd-"));
mkdirSync(sessionsDir, { recursive: true });

// ---- seeding ---------------------------------------------------------------
const stamp = (i) => new Date(Date.UTC(2026, 8, 1, 0, 0, i % 60, i % 1000)).toISOString();

const userLine = (id, parentId, text, i) => ({
	type: "message",
	id,
	parentId,
	timestamp: stamp(i),
	message: { role: "user", content: [{ type: "text", text }], timestamp: stamp(i) },
});

const assistantLine = (id, parentId, text, i, extra = []) => ({
	type: "message",
	id,
	parentId,
	timestamp: stamp(i),
	message: {
		role: "assistant",
		content: [{ type: "text", text }, ...extra],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: stamp(i),
	},
});

/** Writes a chat file the way the SDK lays them out, and returns its path. */
function writeChat(sessionId, lines) {
	const file = join(sessionsDir, `2026-09-01T00-00-00-000Z_${sessionId}.jsonl`);
	const header = { type: "session", version: 3, id: sessionId, timestamp: stamp(0), cwd: workCwd };
	writeFileSync(file, [header, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n");
	return file;
}

/** A chat with `pairs` question/answer pairs; the answers are padded so the file is a few MB. */
function seedBigChat(sessionId, pairs, padBytes = 1200) {
	const pad = "x".repeat(padBytes);
	const lines = [];
	let parentId = null;
	for (let i = 0; i < pairs; i++) {
		const u = `u${String(i).padStart(4, "0")}`;
		const a = `a${String(i).padStart(4, "0")}`;
		lines.push(userLine(u, parentId, `question ${i}`, i));
		lines.push(assistantLine(a, u, `answer ${i} ${pad}`, i));
		parentId = a;
	}
	return writeChat(sessionId, lines);
}

const BIG = "01a0c000-0000-7000-8000-0000000000b1";
const BIG2 = "01a0c000-0000-7000-8000-0000000000b2";
const BIG3 = "01a0c000-0000-7000-8000-0000000000b6";
const BRANCHED = "01a0c000-0000-7000-8000-0000000000b3";
const CUTOFF = "01a0c000-0000-7000-8000-0000000000b4";
const RUBBISH = "01a0c000-0000-7000-8000-0000000000b5";

const bigFile = seedBigChat(BIG, 900);
// The two the browser opens are never opened over the socket: a chat that is already open shows up
// as a recent chat, not as a history row.
const big2File = seedBigChat(BIG2, 900);
const big3File = seedBigChat(BIG3, 900);

// A chat that was branched (two answers to the same question) and then rewound: the last line's
// own chain is the only one that counts.
const branchedFile = writeChat(BRANCHED, [
	userLine("m1", null, "first question", 1),
	assistantLine("m2", "m1", "first answer", 2),
	userLine("m3", "m2", "second question", 3),
	assistantLine("m4a", "m3", "answer on the branch nobody kept", 4),
	assistantLine("m4b", "m3", "answer on the branch that stayed", 5),
	userLine("m5", "m4b", "third question, then a rewind", 6),
	assistantLine("m6", "m5", "answer that was rewound away", 7),
	// rewind: carry on from m5's parent chain again
	assistantLine("m7", "m4b", "the answer after the rewind", 8),
	userLine("m8", "m7", "last question", 9),
]);

// A chat whose last answer was cut off mid tool call: nothing answered the tool call, so the file
// needs the repairing path and gets no preview.
const cutoffFile = writeChat(CUTOFF, [
	userLine("m1", null, "please run something", 1),
	assistantLine("m2", "m1", "running it", 2, [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }]),
]);

// Written only for its own check and removed again: a file that is not a chat makes the history
// listing itself fail, which would hide every chat from the left panel during the browser part.
const rubbishFile = join(sessionsDir, `2026-09-01T00-00-00-000Z_${RUBBISH}.jsonl`);

// ---- server ----------------------------------------------------------------
const srv = await ownServer({
	name: "chat-open-preview",
	mock: ({ sideRequest, lastUser }) =>
		sideRequest ? "Seeded chat" : `REPLY:${(lastUser ?? "").trim().split(/\s+/).slice(0, 2).join(" ")}`,
	env: { PI_CODING_AGENT_SESSION_DIR: sessionsDir, PI_WEB_CWD: workCwd },
});

// ---- socket client ---------------------------------------------------------
class Client {
	constructor(ws) {
		this.ws = ws;
		this.all = [];
		ws.on("message", (data) => {
			const m = JSON.parse(data.toString());
			m.__at = Date.now();
			this.all.push(m);
		});
	}
	send(m) {
		this.ws.send(JSON.stringify(m));
	}
	/** Waits for a frame, and returns it with the position it arrived at. */
	async waitFor(type, predicate = () => true, timeout = 30000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			const i = this.all.findIndex((m) => m.type === type && predicate(m));
			if (i >= 0) return { ...this.all[i], __i: i };
			await sleep(20);
		}
		throw new Error(`timeout waiting for ${type}`);
	}
	has(type, predicate = () => true) {
		return this.all.some((m) => m.type === type && predicate(m));
	}
}

async function connect(clientId) {
	const ws = new WebSocket(srv.ws);
	const c = new Client(ws);
	await new Promise((res, rej) => {
		ws.once("open", res);
		ws.once("error", rej);
	});
	c.send({ type: "hello", clientId, locale: "en" });
	await c.waitFor("ready");
	return c;
}

const ids = (msgs) => (msgs ?? []).map((m) => m.id).join(",");
const textOf = (m) =>
	(m.content ?? [])
		.map((b) => (typeof b?.text === "string" ? b.text : ""))
		.join(" ")
		.slice(0, 60);
const textsOf = (msgs) => (msgs ?? []).map((m) => `${m.role}:${textOf(m)}`).join("|");

let browser = null;
try {
	// ================= 1. a healthy chat previews first =======================
	const c = await connect("open-preview-ws");
	const t0 = Date.now();
	c.send({ type: "switch_session", path: bigFile });
	const preview = await c.waitFor("switch_preview", (m) => m.state?.sessionFile === bigFile);
	const previewMs = preview.__at - t0;
	const snap = await c.waitFor("snapshot", (m) => m.state?.sessionFile === bigFile && m.state?.messages?.length);
	const done = await c.waitFor("switch_done");
	const snapMs = snap.__at - t0;

	check(
		"the preview arrives before the snapshot",
		preview.__i < snap.__i,
		`preview ${previewMs} ms, snapshot ${snapMs} ms`,
	);
	check("the preview arrives before switch_done", preview.__i < done.__i);
	check(
		"the preview shows the newest messages",
		(preview.state.messages ?? []).length === (snap.state.messages ?? []).length,
		`${(preview.state.messages ?? []).length} vs ${(snap.state.messages ?? []).length}`,
	);
	check(
		"the preview's messages have the same ids as the snapshot's",
		ids(preview.state.messages) === ids(snap.state.messages),
	);
	check("the preview's messages say the same thing", textsOf(preview.state.messages) === textsOf(snap.state.messages));
	check(
		"the preview's window starts where the snapshot's does",
		preview.state.messagesStart === snap.state.messagesStart,
		`${preview.state.messagesStart} vs ${snap.state.messagesStart}`,
	);
	check(
		"the preview carries the same question index",
		JSON.stringify(preview.state.questionIndex) === JSON.stringify(snap.state.questionIndex),
	);
	check(
		"the preview carries the same earlier exchanges",
		JSON.stringify(preview.state.exchanges ?? null) === JSON.stringify(snap.state.exchanges ?? null),
	);
	check("the preview is marked as not a chat you can write to yet", preview.state.conversationId === "");
	check("the open finished for real", (snap.state.conversationId ?? "") !== "");

	// ================= 2. a branch and a rewind ==============================
	c.all.length = 0;
	c.send({ type: "switch_session", path: branchedFile });
	const bPreview = await c.waitFor("switch_preview", (m) => m.state?.sessionFile === branchedFile);
	const bSnap = await c.waitFor("snapshot", (m) => m.state?.sessionFile === branchedFile && m.state?.messages?.length);
	check(
		"a branched, rewound chat previews the same messages it opens with",
		textsOf(bPreview.state.messages) === textsOf(bSnap.state.messages),
	);
	check("the preview leaves out the branch nobody kept", !textsOf(bPreview.state.messages).includes("nobody kept"));
	check("the preview leaves out what was rewound away", !textsOf(bPreview.state.messages).includes("rewound away"));
	check("the preview has the answer after the rewind", textsOf(bPreview.state.messages).includes("after the rewind"));

	// ================= 3. a chat that needs repairing ========================
	c.all.length = 0;
	c.send({ type: "switch_session", path: cutoffFile });
	const cSnap = await c.waitFor("snapshot", (m) => m.state?.sessionFile === cutoffFile && m.state?.messages?.length);
	check(
		"a chat cut off mid tool call gets no preview",
		!c.has("switch_preview", (m) => m.state?.sessionFile === cutoffFile),
	);
	check(
		"it still opens, the old way",
		(cSnap.state.messages ?? []).length >= 2,
		`${(cSnap.state.messages ?? []).length} messages`,
	);

	// ================= 4. a file that is not a chat ==========================
	writeFileSync(rubbishFile, "this is not a chat file at all\n");
	c.all.length = 0;
	c.send({ type: "switch_session", path: rubbishFile });
	const failed = await c.waitFor("switch_failed");
	check(
		"a file that is not a chat gets no preview",
		!c.has("switch_preview", (m) => m.state?.sessionFile === rubbishFile),
	);
	check(
		"it fails the usual way, with a reason",
		typeof failed.error === "string" && failed.error.length > 0,
		failed.error,
	);
	rmSync(rubbishFile, { force: true });

	// ================= 5. a message written for another chat =================
	c.all.length = 0;
	c.send({ type: "switch_session", path: bigFile });
	await c.waitFor("switch_done");
	c.all.length = 0;
	c.send({
		type: "prompt",
		id: "p-wrong-chat",
		text: "this belongs somewhere else",
		forSession: "01a0dead-0000-7000-8000-00000000dead",
	});
	const ack = await c.waitFor("prompt_ack", (m) => m.id === "p-wrong-chat");
	check("a message written for another chat is refused", ack.ok === false, ack.reason ?? "");
	check(
		"and the person is told why",
		c.has("notice", (m) => m.level === "error"),
	);
	await sleep(300);
	check("it does not land in the open chat", !readFileSync(bigFile, "utf8").includes("this belongs somewhere else"));
	// The history list has to carry the seeded chats, or the browser part below cannot open one.
	c.all.length = 0;
	c.send({ type: "list_sessions" });
	const listed = await c.waitFor("sessions");
	const listedPaths = (listed.sessions ?? []).map((s) => s.path);
	check(
		"the seeded chats are in the history list",
		listedPaths.includes(big2File) && listedPaths.includes(big3File),
		`${listedPaths.length} listed`,
	);
	c.ws.close();

	// ================= the browser ===========================================
	browser = await chromium.launch({ executablePath: CHROME_PATH, args: ["--no-sandbox"] });
	const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
	// Hold the snapshot and switch_done frames back so the preview can be seen and written in.
	await ctx.addInitScript(() => {
		window.__held = [];
		window.__holding = false;
		window.__sent = [];
		const Native = window.WebSocket;
		window.WebSocket = class extends Native {
			constructor(...args) {
				super(...args);
				this.__app = null;
				super.onmessage = (ev) => {
					let type = "";
					try {
						const m = JSON.parse(ev.data);
						type = m.type;
						if (type === "sessions") window.__sessions = (m.sessions ?? []).map((s) => s.path);
					} catch {
						/* not json */
					}
					if (window.__holding && (type === "snapshot" || type === "snapshot_delta" || type === "switch_done")) {
						window.__held.push(ev);
						return;
					}
					this.__app?.call(this, ev);
				};
				const send = this.send.bind(this);
				this.send = (data) => {
					try {
						const m = JSON.parse(data);
						window.__sent.push(m);
						(window.__sentAll = window.__sentAll ?? []).push(m.type);
					} catch {
						/* not json */
					}
					return send(data);
				};
				window.__release = () => {
					window.__holding = false;
					const q = window.__held.splice(0);
					for (const ev of q) this.__app?.call(this, ev);
					return q.length;
				};
			}
			get onmessage() {
				return this.__app;
			}
			set onmessage(fn) {
				this.__app = fn;
			}
		};
	});
	const page = await ctx.newPage();
	const pageErrors = [];
	page.on("pageerror", (e) => pageErrors.push(String(e)));
	page.on("console", (m) => {
		if (m.type() === "error") pageErrors.push(m.text());
	});
	await page.goto(srv.http, { waitUntil: "domcontentloaded" });
	await page.locator(".inputbox textarea").waitFor({ timeout: 30000 });
	// Open and close the global search once: that asks the server for the chat list, which fills the
	// history section of the left panel.
	await page.locator(".chip", { hasText: "Search" }).first().click();
	await page.waitForFunction(() => Array.isArray(window.__sessions) && window.__sessions.length > 0, null, {
		timeout: 30000,
	});
	await page.keyboard.press("Escape");

	/** Clicks the chat's row in the history list. */
	const openFromHistory = async (file) => {
		try {
			await page.waitForFunction(
				(path) => [...document.querySelectorAll("button.session-item")].some((b) => b.title === path),
				file,
				{ timeout: 30000 },
			);
		} catch (err) {
			const info = await page.evaluate(() => ({
				titles: [...document.querySelectorAll("button.session-item")].map((b) => b.title),
				frame: window.__sessions ?? null,
				header: document.querySelector(".lp-section-sessions .lp-section-title")?.textContent ?? "",
				sent: window.__sentAll ?? null,
			}));
			throw new Error(`no history row for ${file}; ${JSON.stringify({ ...info, errors: pageErrors.slice(0, 5) })}`, {
				cause: err,
			});
		}
		await page.evaluate((path) => {
			const row = [...document.querySelectorAll("button.session-item")].find((b) => b.title === path);
			row?.click();
		}, file);
	};

	// ---- 6. the preview shows, a message written then waits, nothing is rebuilt ----
	// Start from an empty chat, so the messages that appear can only be the one being opened.
	const emptyChat = async () => {
		await page.locator(".lp-new-chat-action").click();
		await page.waitForFunction(() => document.querySelectorAll(".messages .msg").length === 0, null, {
			timeout: 30000,
		});
	};
	await emptyChat();
	await page.evaluate(() => {
		window.__holding = true;
		window.__held.length = 0;
		window.__sent.length = 0;
	});
	const clickedAt = Date.now();
	await openFromHistory(big3File);
	await page.locator(".messages .msg").first().waitFor({ timeout: 30000 });
	const shownMs = Date.now() - clickedAt;
	const previewState = await page.evaluate(() => ({
		msgs: document.querySelectorAll(".messages .msg").length,
		overlayPreview: !!document.querySelector('.switch-overlay[data-switch-preview="1"]'),
		heldBack: window.__held.length,
		lastText: ([...document.querySelectorAll(".messages .msg")].at(-1)?.textContent ?? "").slice(0, 60),
	}));
	check(
		"the newest messages show while the chat is still opening",
		previewState.msgs > 0,
		`${previewState.msgs} messages in ${shownMs} ms`,
	);
	check("they are marked as a preview, not the open chat", previewState.overlayPreview);
	check(
		"the real snapshot had not reached the page yet",
		previewState.heldBack > 0,
		`${previewState.heldBack} frames held`,
	);
	check("the preview ends on the newest answer", previewState.lastText.includes("answer 899"), previewState.lastText);
	check(
		"the preview is the chat that was clicked, not the one before it",
		previewState.msgs > 0 && previewState.overlayPreview,
	);

	// Tag the rows on screen: if the snapshot rebuilt them, the tag would be gone (a visible jump).
	await page.evaluate(() => {
		document.querySelectorAll(".messages .msg").forEach((el, i) => {
			el.dataset.e2eTag = `tag${i}`;
		});
		const list = document.querySelector(".messages");
		window.__scrollBefore = list ? list.scrollTop : 0;
	});

	await page.locator(".inputbox textarea").fill("PENDING-DURING-LOAD");
	await page.locator(".inputbox textarea").press("Enter");
	await page.locator('.msg-pending[data-pending-status="sending"]').waitFor({ timeout: 10000 });
	const heldSend = await page.evaluate(() => window.__sent.filter((m) => m.type === "prompt").length);
	check("a message written while the chat opens waits, marked as sending", true);
	check("it is not sent while the chat is still opening", heldSend === 0, `${heldSend} prompts sent`);

	const released = await page.evaluate(() => window.__release());
	check("the snapshot reaches the page when released", released > 0, `${released} frames`);
	await page.waitForFunction(
		() => document.querySelectorAll('.msg-pending[data-pending-status="sending"]').length === 0,
		null,
		{
			timeout: 30000,
		},
	);
	const afterSwap = await page.evaluate(() => ({
		sentPrompts: window.__sent.filter((m) => m.type === "prompt").map((m) => m.text),
		keptTags: [...document.querySelectorAll(".messages .msg")].filter((el) => el.dataset.e2eTag).length,
		overlay: !!document.querySelector(".switch-overlay"),
	}));
	check(
		"the message goes out once the chat is ready",
		afterSwap.sentPrompts.includes("PENDING-DURING-LOAD"),
		afterSwap.sentPrompts.join(","),
	);
	check(
		"the messages already on screen are not rebuilt (no jump)",
		afterSwap.keptTags > 0,
		`${afterSwap.keptTags} rows kept`,
	);
	check("the overlay is gone once the chat is open", !afterSwap.overlay);
	await page.waitForFunction(() => document.body.innerText.includes("REPLY:"), null, { timeout: 30000 });
	check("the chat answers it", true);

	// ---- 7. leaving the chat before it opened ----
	await emptyChat();
	await page.evaluate(() => {
		window.__holding = true;
		window.__held.length = 0;
		window.__sent.length = 0;
	});
	await openFromHistory(big2File);
	await page.locator(".messages .msg").first().waitFor({ timeout: 30000 });
	await page.locator(".inputbox textarea").fill("LEFT-BEFORE-IT-OPENED");
	await page.locator(".inputbox textarea").press("Enter");
	await page.locator('.msg-pending[data-pending-status="sending"]').waitFor({ timeout: 10000 });
	await page.locator(".lp-new-chat-action").click();
	await page.evaluate(() => window.__release());
	await sleep(1000);
	const afterLeaving = await page.evaluate(() => window.__sent.filter((m) => m.type === "prompt").map((m) => m.text));
	check(
		"a message left behind is not sent to the chat that opened later",
		!afterLeaving.includes("LEFT-BEFORE-IT-OPENED"),
		afterLeaving.join(","),
	);
	check("and it never reaches the chat's file", !readFileSync(big2File, "utf8").includes("LEFT-BEFORE-IT-OPENED"));
} catch (err) {
	console.error(err);
	failures++;
} finally {
	if (browser) await browser.close().catch(() => {});
	await srv.stop().catch(() => {});
}

console.log(failures === 0 ? "\nchat-open-preview: all good" : `\nchat-open-preview: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
