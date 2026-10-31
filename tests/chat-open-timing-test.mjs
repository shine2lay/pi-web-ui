/**
 * chat-open-timing (Ops #690): a real browser's chat opens each write one content-free "chatopen" row
 * to the server's connection log, with the page's marks joined to the server's.
 *
 * Own server, three made-up chats, a stand-in model (zero tokens), headless Chrome:
 *   1. a desktop window opens two chats from the history list: one row each, done, with paint, frame,
 *      done and server times, not loaded before, device desktop, marked as a test browser;
 *   2. a second socket opens the first chat again: the window let it go when it moved on (an idle
 *      chat is unloaded on switching away), so its row says loadedBefore false; then the second chat,
 *      which the window still shows: loadedBefore true; both rows name their chat by the same hash;
 *   3. a phone-like window (touch, mobile, Android) opens the third chat: device phone;
 *   4. every open the pages asked for has exactly one row (by the page's open id);
 *   5. the log holds no message text, title, chat folder, work folder or session id;
 *   6. scripts/chat-open-stats.mjs reads the rows and leaves them all out of the owner's numbers
 *      (test browsers and the bare socket), counted.
 *
 * Usage: node tests/run-sealed.mjs chat-open-timing-test   (after npm run build)
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { ownServer } from "./lib/own-server.mjs";
import { seedChat } from "./lib/phone-chat.mjs";
import { ANDROID_UA, launchBrowser } from "./lib/phone.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`  ${ok ? "✓" : "✗ FAIL:"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
};

const TITLE = "Chat-Open-Timing-Made-Up-Title";
const sessionsDir = mkdtempSync(join(tmpdir(), "chat-open-timing-sessions-"));
const chats = {};
const srv = await ownServer({
	name: "chat-open-timing",
	mock: ({ sideRequest }) => (sideRequest ? TITLE : "ok"),
	env: { PI_CODING_AGENT_SESSION_DIR: sessionsDir },
	prepare: async ({ workdir }) => {
		chats.a = seedChat(sessionsDir, workdir, { id: "01a0f000-0000-7000-8000-0000000690a1", exchanges: 30 });
		chats.b = seedChat(sessionsDir, workdir, { id: "01a0f000-0000-7000-8000-0000000690b2", exchanges: 30 });
		chats.c = seedChat(sessionsDir, workdir, { id: "01a0f000-0000-7000-8000-0000000690c3", exchanges: 30 });
	},
});
const logFile = join(srv.dataDir, "conn-events.jsonl");

/** The chatopen rows written so far. */
function rows() {
	let text = "";
	try {
		text = readFileSync(logFile, "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter((l) => l.includes('"chatopen"'))
		.map((l) => JSON.parse(l));
}

async function waitForRows(n, timeoutMs = 60_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		const r = rows();
		if (r.length >= n) return r;
		await sleep(100);
	}
	throw new Error(`waited ${timeoutMs} ms for ${n} chatopen rows, have ${rows().length}`);
}

/** A window of the app: records the open ids its switch requests carry (only the ids). */
async function openWindow(browser, contextOptions) {
	const ctx = await browser.newContext(contextOptions);
	await ctx.addInitScript(() => {
		window.__opens = [];
		const send = WebSocket.prototype.send;
		WebSocket.prototype.send = function (data) {
			try {
				const m = JSON.parse(data);
				if (m.type === "switch_session" || m.type === "switch_conversation") window.__opens.push(m.open ?? null);
			} catch {
				/* not json */
			}
			return send.call(this, data);
		};
	});
	const page = await ctx.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await page.goto(srv.http, { waitUntil: "domcontentloaded" });
	await page.locator(".inputbox textarea").waitFor({ timeout: 60_000 });
	// Opening and closing the global search asks the server for the chat list (the history section).
	await page.locator(".chip", { hasText: "Search" }).first().click();
	await page.waitForFunction(() => document.querySelectorAll("button.session-item").length > 0, null, {
		timeout: 60_000,
	});
	await page.keyboard.press("Escape");
	/** Clicks the chat's row in the history list and waits for its messages. */
	const openFromHistory = async (file) => {
		await page.waitForFunction(
			(path) => [...document.querySelectorAll("button.session-item")].some((b) => b.title === path),
			file,
			{ timeout: 60_000 },
		);
		await page.evaluate((path) => {
			[...document.querySelectorAll("button.session-item")].find((b) => b.title === path)?.click();
		}, file);
		await page.locator(".messages .msg").first().waitFor({ timeout: 60_000 });
	};
	const opens = () => page.evaluate(() => window.__opens.slice());
	return { ctx, page, errors, openFromHistory, opens };
}

let browser = null;
let exitCode = 0;
try {
	browser = await launchBrowser({ args: ["--no-sandbox"] });

	// ---- 1. desktop: two chats, not loaded before ------------------------------
	const desk = await openWindow(browser, { viewport: { width: 1400, height: 900 } });
	await desk.openFromHistory(chats.a.file);
	const [rowA] = await waitForRows(1);
	await desk.openFromHistory(chats.b.file);
	const rowB = (await waitForRows(2))[1];
	for (const [name, r] of [
		["first chat", rowA],
		["second chat", rowB],
	]) {
		check(
			`${name}: one done row with the page's and the server's times`,
			r.outcome === "done" &&
				r.ok === true &&
				typeof r.toPaintMs === "number" &&
				typeof r.toFirstFrameMs === "number" &&
				r.toPaintMs >= r.toFirstFrameMs &&
				typeof r.toDoneMs === "number" &&
				typeof r.startToRequestMs === "number" &&
				typeof r.serverMs === "number" &&
				typeof r.loadMs === "number" &&
				typeof r.load1 === "number",
			`paint ${r.toPaintMs} ms, first frame ${r.toFirstFrameMs} ms, done ${r.toDoneMs} ms, server ${r.serverMs} ms, load ${r.loadMs} ms, via ${r.via}`,
		);
		check(
			`${name}: not loaded before, desktop, a test browser, visible`,
			r.loadedBefore === false &&
				r.device === "desktop" &&
				r.automated === true &&
				r.visible === true &&
				r.browser === true &&
				r.target === "session",
		);
		check(
			`${name}: counts and a hashed chat key`,
			Number.isInteger(r.msgs) && r.msgs > 0 && r.sentMsgs > 0 && r.sentMsgs <= r.msgs && /^[a-f0-9]{12}$/.test(r.chat),
			`msgs ${r.msgs}, sent ${r.sentMsgs}, ${r.snapshotChars} chars`,
		);
	}
	check("the two chats have different keys", rowA.chat !== rowB.chat);

	// ---- 2. a second socket opens both chats again: unloaded, then loaded --------
	const ws = new WebSocket(srv.ws);
	const frames = [];
	ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
	await new Promise((res, rej) => {
		ws.once("open", res);
		ws.once("error", rej);
	});
	ws.send(JSON.stringify({ type: "hello", clientId: "chat-open-timing-socket", locale: "en" }));
	const waitFrame = async (pred, timeoutMs = 60_000) => {
		const t0 = Date.now();
		while (Date.now() - t0 < timeoutMs) {
			if (frames.some(pred)) return;
			await sleep(20);
		}
		throw new Error("timeout waiting for a frame");
	};
	await waitFrame((m) => m.type === "ready");
	/** Opens a chat on the bare socket and reports it like a page would; returns its row. */
	const openOnSocket = async (file, open, rowsBefore) => {
		frames.length = 0;
		ws.send(JSON.stringify({ type: "switch_session", path: file, open }));
		await waitFrame((m) => m.type === "switch_done" || m.type === "switch_failed");
		ws.send(
			JSON.stringify({
				type: "chat_open",
				open,
				outcome: "done",
				via: "auto",
				device: "desktop",
				visible: true,
				cached: false,
				automated: true,
				toDoneMs: 5,
			}),
		);
		return (await waitForRows(rowsBefore + 1)).find((r) => r.open === open);
	};
	const rowA2 = await openOnSocket(chats.a.file, "0690aaaabbbbcccc", 2);
	check(
		"the first chat again, after the window let it go: loadedBefore false, same chat key",
		rowA2?.loadedBefore === false && rowA2?.chat === rowA.chat && rowA2?.msgs === rowA.msgs && rowA2?.browser === false,
		JSON.stringify({ loadedBefore: rowA2?.loadedBefore, ok: rowA2?.ok, serverMs: rowA2?.serverMs }),
	);
	const rowB2 = await openOnSocket(chats.b.file, "0690bbbbccccdddd", 3);
	check(
		"the second chat, still shown in the window: loadedBefore true, same chat key",
		rowB2?.loadedBefore === true && rowB2?.chat === rowB.chat && rowB2?.msgs === rowB.msgs && rowB2?.ok === true,
		JSON.stringify({
			loadedBefore: rowB2?.loadedBefore,
			ok: rowB2?.ok,
			serverMs: rowB2?.serverMs,
			loadMs: rowB2?.loadMs,
		}),
	);
	ws.close();

	// ---- 3. a phone-like window ------------------------------------------------
	const phone = await openWindow(browser, {
		viewport: { width: 1400, height: 900 },
		isMobile: true,
		hasTouch: true,
		userAgent: ANDROID_UA,
	});
	await phone.openFromHistory(chats.c.file);
	const all = await waitForRows(5);
	const rowC = all.find((r) => r.device === "phone");
	check(
		"the phone-like window's open says device phone",
		rowC?.outcome === "done" && typeof rowC?.toPaintMs === "number",
		`paint ${rowC?.toPaintMs} ms`,
	);

	// ---- 4. one row per open -----------------------------------------------------
	await sleep(500);
	const final = rows();
	const pageOpens = [...(await desk.opens()), ...(await phone.opens())];
	const rowOpens = final.map((r) => r.open);
	check(
		"every open the pages asked for has exactly one row",
		pageOpens.length === 3 &&
			pageOpens.every((id) => typeof id === "string" && rowOpens.filter((o) => o === id).length === 1) &&
			final.length === pageOpens.length + 2,
		`pages sent ${pageOpens.length} opens, ${final.length} rows`,
	);

	// ---- 5. no content -------------------------------------------------------------
	const text = readFileSync(logFile, "utf8");
	const leaks = [
		"Seeded",
		"seeded",
		"question",
		TITLE,
		sessionsDir,
		srv.workdir,
		"sessions",
		chats.a.id,
		chats.b.id,
		chats.c.id,
		"chat-open-timing-socket",
	].filter((s) => text.includes(s));
	check("the log holds no message text, title, folder, path or session id", leaks.length === 0, leaks.join(", "));
	check(
		"no page errors",
		desk.errors.length + phone.errors.length === 0,
		[...desk.errors, ...phone.errors].join(" | "),
	);

	// ---- 6. the summarizer ---------------------------------------------------------
	const run = spawnSync(process.execPath, ["scripts/chat-open-stats.mjs", "--dir", srv.dataDir, "--json"], {
		encoding: "utf8",
	});
	const s = run.status === 0 ? JSON.parse(run.stdout) : null;
	check(
		"chat-open-stats reads the rows and leaves test browsers and the bare socket out, counted",
		s?.rows === 5 && s?.counted === 0 && s?.excluded?.["test browser"] === 3 && s?.excluded?.["not a browser"] === 2,
		JSON.stringify(s?.excluded ?? run.stderr),
	);
} catch (err) {
	console.error(err);
	failures++;
} finally {
	await browser?.close().catch(() => {});
	await srv.stop();
	rmSync(sessionsDir, { recursive: true, force: true });
	exitCode = failures === 0 ? 0 : 1;
}
console.log(failures === 0 ? "\nchat-open-timing: all good" : `\nchat-open-timing: ${failures} failed`);
process.exit(exitCode);
