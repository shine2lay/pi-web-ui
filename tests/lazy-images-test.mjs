/* lazy-images E2E (no tokens): pictures reach the page as placeholders and load when they come near
 * the screen.
 *
 * A seeded chat holds 30 big pictures (real PNGs of noise, about 30 MB): each of its 15 questions has a
 * pasted picture, and each answer takes a screenshot (a tool result). The last screenshot is 2.5 MB,
 * over the old inline cap, so before this patch it showed only as "[image result]". The server runs
 * with PI_WEB_TOKEN set, so pictures must load through the same password check as everything else,
 * and with a 40-message window (the newest 10 questions).
 *  1. Opening the chat sends a small snapshot: every picture is a placeholder with its type, bytes,
 *     width and height, and no picture data. The question list still covers all 15 questions.
 *  2. Only the pictures near the screen are fetched. A gray box of the picture's own size holds the
 *     place of the others; scrolling up fetches each of them once, and nothing jumps when it loads.
 *  3. Enlarging the big screenshot shows the full 1200x700 picture.
 *  4. "Load older" brings earlier questions whose pictures load when scrolled to.
 *  5. The picture endpoint: exact bytes and headers; 401 without the password; 404 for a fingerprint
 *     that matches no picture; 400 for a malformed address; a path trick finds nothing; a picture whose
 *     message id changed (rewind, fork) is still found by its fingerprint.
 *  6. Jumping to the first question (outside the window) from a fresh page shows its picture.
 *  7. A screenshot that arrives while a reply is still running (the model reads a PNG) shows up before
 *     the reply ends.
 *  8. The seeded session file is unchanged, and neither the server nor the page logged an error.
 * Usage: npm run build && node tests/lazy-images-test.mjs [port]
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { crc32, deflateSync } from "node:zlib";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const PORT = Number(process.argv[2] || 8975);
const MOCK_PORT = PORT + 1;
const TOKEN = "lazy-images-test-token";
const WINDOW = 40;
const EXCHANGES = 15;
/** How long the mock model takes to finish the reply after the screenshot, so the check can see it. */
const SLOW_MS = 6000;
const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-lazy-")));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
const sessionsDir = join(base, "sessions");
for (const d of [workdir, dataDir, agentDir, sessionsDir]) mkdirSync(d, { recursive: true });

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✓" : "✗ FAIL:"} ${name}${detail ? ` (${detail})` : ""}`);
	if (!ok) failures += 1;
}
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// ---- pictures -------------------------------------------------------------------------------------
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngChunk(type, data) {
	const head = Buffer.alloc(4);
	head.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body) >>> 0);
	return Buffer.concat([head, body, crc]);
}
/** A real PNG of noise: it decodes in the browser and doesn't compress, so it stays big. */
function noisePng(width, height) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // RGB
	const row = width * 3 + 1;
	const raw = randomBytes(row * height);
	for (let y = 0; y < height; y++) raw[y * row] = 0; // filter: none
	return Buffer.concat([
		PNG_SIG,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw, { level: 0 })),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}
/** The v in a picture's address: the same fingerprint the server computes (server/image-meta.ts). */
const versionOf = (b64) => createHash("sha1").update(b64, "latin1").digest("base64url").slice(0, 16);
const vOf = (addr) => new URL(addr, "http://x").searchParams.get("v");
/** An address without the password and retry counter, to count fetches per picture. */
function addrKey(addr) {
	const u = new URL(addr, "http://x");
	u.searchParams.delete("token");
	u.searchParams.delete("retry");
	return u.pathname + u.search;
}

/** Every seeded picture by its fingerprint. */
const pictures = new Map();
function picture(kind, k, [width, height]) {
	const bytes = noisePng(width, height);
	const b64 = bytes.toString("base64");
	pictures.set(versionOf(b64), { kind, k, width, height, bytes: bytes.length, sha: sha256(bytes) });
	return { type: "image", data: b64, mimeType: "image/png" };
}
const userSize = (k) => [640 + 8 * k, 400 + 4 * k];
const shotSize = (k) => (k === EXCHANGES - 1 ? [1200, 700] : [720 + 4 * k, 450]);

// ---- the seeded chat --------------------------------------------------------------------------------
const SESSION_ID = "01a0d000-0000-7000-8000-00000000f00d";
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function seedChat() {
	const t0 = Date.now() - 3_600_000;
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: SESSION_ID,
			timestamp: new Date(t0).toISOString(),
			cwd: workdir,
		}),
	];
	let parentId = null;
	let i = 0;
	const push = (message) => {
		const id = `e${String(i).padStart(4, "0")}`;
		const ts = t0 + i * 1000;
		const entry = {
			type: "message",
			id,
			parentId,
			timestamp: new Date(ts).toISOString(),
			message: { ...message, timestamp: ts },
		};
		lines.push(JSON.stringify(entry));
		parentId = id;
		i += 1;
	};
	const assistant = (content, stopReason) => ({
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-8",
		usage,
		stopReason,
	});
	for (let k = 0; k < EXCHANGES; k++) {
		push({ role: "user", content: [{ type: "text", text: `question ${k}` }, picture("user", k, userSize(k))] });
		push(
			assistant(
				[
					{ type: "text", text: `taking screenshot ${k}` },
					{ type: "toolCall", id: `call_${k}`, name: "web_shot", arguments: {} },
				],
				"toolUse",
			),
		);
		push({
			role: "toolResult",
			toolCallId: `call_${k}`,
			toolName: "web_shot",
			content: [{ type: "text", text: `shot ${k}` }, picture("shot", k, shotSize(k))],
			isError: false,
		});
		push(assistant([{ type: "text", text: `answer ${k}` }], "stop"));
	}
	const file = join(sessionsDir, `2026-09-26T00-00-00-000Z_${SESSION_ID}.jsonl`);
	writeFileSync(file, lines.join("\n") + "\n");
	return file;
}

// ---- mock Anthropic Messages API: reads shot.png, then answers slowly ----------------------------------
let mockFinishedAt = 0;
const mock = createServer(async (req, res) => {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	let payload;
	try {
		payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		res.writeHead(400).end("bad json");
		return;
	}
	const turn = Array.isArray(payload.tools) && payload.tools.length > 0;
	const last = payload.messages?.at(-1);
	const toolDone = Array.isArray(last?.content) && last.content.some((b) => b?.type === "tool_result");
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	ev("message_start", {
		message: {
			id: `msg_${Date.now()}`,
			type: "message",
			role: "assistant",
			model: payload.model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 1 },
		},
	});
	if (turn && !toolDone) {
		ev("content_block_start", {
			index: 0,
			content_block: { type: "tool_use", id: "toolu_lazy_1", name: "read", input: {} },
		});
		ev("content_block_delta", {
			index: 0,
			delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: "shot.png" }) },
		});
		ev("content_block_stop", { index: 0 });
		ev("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } });
	} else {
		const text = turn ? "answer to QS-SHOT: I see the picture" : "Mock title";
		ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
		ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: text.slice(0, 6) } });
		if (turn) await sleep(SLOW_MS);
		ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: text.slice(6) } });
		ev("content_block_stop", { index: 0 });
		ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
		if (turn) mockFinishedAt = Date.now();
	}
	ev("message_stop", {});
	res.end();
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "lazy-test" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "anthropic-messages",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "lazy-test",
				models: [
					{
						id: "lazy-mock",
						name: "Lazy Mock",
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
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "mock", defaultModel: "lazy-mock" }));
writeFileSync(join(workdir, "shot.png"), noisePng(400, 300));

const seeded = seedChat();
const seededLen = readFileSync(seeded).length;
const seededSha = sha256(readFileSync(seeded));
const seededBytes = [...pictures.values()].reduce((a, p) => a + p.bytes, 0);
console.log(`seeded ${pictures.size} pictures, ${mb(seededBytes)} (session file ${mb(readFileSync(seeded).length)})`);

// ---- server --------------------------------------------------------------------------------------------
const repoRoot = realpathSync(new URL("../", import.meta.url));
const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: repoRoot,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CODING_AGENT_SESSION_DIR: sessionsDir,
		PI_WEB_MESSAGE_WINDOW: String(WINDOW),
		PI_WEB_TOKEN: TOKEN,
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});
let serverLog = "";
const keepLog = (d) => {
	serverLog = (serverLog + d).slice(-20000);
};
server.stdout.on("data", keepLog);
server.stderr.on("data", keepLog);

async function waitFor(fn, timeout = 20000, step = 100) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		try {
			const v = await fn();
			if (v) return v;
		} catch {
			/* not yet */
		}
		await sleep(step);
	}
	return null;
}

// ---- page helpers ----------------------------------------------------------------------------------------
const pageErrors = [];
/** slowPictures: every picture answer waits this long, so a picture on its way can be seen. */
async function openPage(browser, slowPictures = 0) {
	const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
	const page = await ctx.newPage();
	/** Picture requests, in order. */
	const fetched = [];
	page.on("request", (r) => {
		if (r.url().includes("/api/chat-image/")) fetched.push(r.url());
	});
	if (slowPictures > 0) {
		await page.route("**/api/chat-image/**", async (route) => {
			await sleep(slowPictures);
			await route.continue().catch(() => {});
		});
	}
	page.on("pageerror", (e) => pageErrors.push(String(e)));
	await page.addInitScript(() => {
		const Orig = window.WebSocket;
		window.__frames = [];
		window.WebSocket = class extends Orig {
			constructor(...a) {
				super(...a);
				window.__ws = this;
				this.addEventListener("message", (ev) => {
					if (typeof ev.data === "string") window.__frames.push(ev.data);
				});
			}
		};
	});
	await page.goto(`http://127.0.0.1:${PORT}/?token=${TOKEN}`);
	await page.waitForFunction(() => window.__frames?.some((f) => f.startsWith('{"type":"snapshot"')), null, {
		timeout: 60000,
	});
	return { ctx, page, fetched };
}

/** Opens a chat through the page's own socket and returns the text of its newest full snapshot. A page
 *  that already shows the chat (a new page adopts the chat open elsewhere) gets no second snapshot. */
function openChat(page, file) {
	return page.evaluate(async (path) => {
		const from = window.__frames.length;
		window.__ws.send(JSON.stringify({ type: "switch_session", path }));
		const needle = JSON.stringify(path).slice(1, -1);
		for (let i = 0; i < 1200; i++) {
			const after = window.__frames.slice(from);
			const failed = after.find((f) => f.startsWith('{"type":"switch_failed"'));
			if (failed) throw new Error(`the chat didn't open: ${failed.slice(0, 300)}`);
			if (after.some((f) => f.startsWith('{"type":"switch_done"'))) {
				const snap = window.__frames.findLast((f) => f.startsWith('{"type":"snapshot"') && f.includes(needle));
				if (snap) return snap;
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		const types = window.__frames.slice(from).map((f) => f.slice(0, 40));
		throw new Error(`no snapshot for the seeded chat; frames since the switch: ${types.join(" | ")}`);
	}, file);
}

/** Opens every folded exchange drawn on the page. Older steps of an open exchange show as one-line
 *  rows (the collapsed view, with a picture count); those are opened too. Returns what it opened. */
function unfoldAll(page) {
	return page.evaluate(() => {
		const heads = [...document.querySelectorAll('.messages .xfold-head[aria-expanded="false"]')];
		for (const h of heads) h.click();
		const rows = [...document.querySelectorAll(".messages .msg-collapsed")];
		const chips = rows.flatMap((r) => [...r.querySelectorAll(".msg-collapsed-chip")].map((c) => c.textContent ?? ""));
		for (const r of rows) r.click();
		return { heads: heads.length, rows: rows.length, chips };
	});
}

/** Waits for the first frame of one of the types after frame number `from`, and returns its text. */
function frameAfter(page, from, types) {
	return page.evaluate(
		async ({ from, types }) => {
			for (let i = 0; i < 600; i++) {
				for (let j = from; j < window.__frames.length; j++) {
					const f = window.__frames[j];
					if (types.some((t) => f.startsWith(`{"type":"${t}"`))) return f;
				}
				await new Promise((r) => setTimeout(r, 50));
			}
			return null;
		},
		{ from, types },
	);
}

/** The chat's pictures in the page: address, waiting or loaded, natural and shown size, distance from view. */
function domPictures(page) {
	return page.evaluate(() => {
		const box = document.querySelector(".messages");
		if (!box) return [];
		const view = box.getBoundingClientRect();
		return [...box.querySelectorAll("img")]
			.map((img) => ({ img, addr: img.getAttribute("data-src") ?? img.getAttribute("src") ?? "" }))
			.filter((x) => x.addr.includes("/api/chat-image/"))
			.map(({ img, addr }) => {
				const r = img.getBoundingClientRect();
				const pending = img.classList.contains("chat-image-pending");
				return {
					addr,
					pending,
					loaded: !pending && img.complete && img.naturalWidth > 0,
					nw: img.naturalWidth,
					nh: img.naturalHeight,
					w: Math.round(r.width),
					h: Math.round(r.height),
					fromView: Math.round(Math.max(view.top - r.bottom, r.top - view.bottom, 0)),
				};
			});
	});
}

/** Scrolls the chat a screen at a time to the top or bottom; `each` runs after every step. */
async function scrollChat(page, where, each) {
	for (let i = 0; i < 400; i++) {
		const done = await page.evaluate((w) => {
			const box = document.querySelector(".messages");
			if (!box) return true;
			const max = box.scrollHeight - box.clientHeight;
			if (w === "top" ? box.scrollTop <= 0 : box.scrollTop >= max - 1) return true;
			box.scrollTop = w === "top" ? Math.max(0, box.scrollTop - 500) : Math.min(max, box.scrollTop + 500);
			return false;
		}, where);
		await sleep(150);
		if (each) await each();
		if (done) return;
	}
}

const imagesIn = (messages) =>
	(messages ?? []).flatMap((m) => (m.content ?? []).filter((b) => b.type === "image").map((b) => ({ ...b, of: m.id })));

let browser = null;
const watchdog = setTimeout(() => {
	console.log("✗ FAIL: the test took longer than 6 minutes");
	server.kill("SIGKILL");
	process.exit(1);
}, 360_000);
try {
	const up = await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok, 30000);
	if (!up) throw new Error(`server did not start on ${PORT}: ${serverLog.slice(-1500)}`);
	browser = await chromium.launch({ executablePath: CHROME_PATH || undefined });

	// ---- 1. the snapshot ------------------------------------------------------------------------------------
	const first = await openPage(browser, 900);
	const { page, fetched } = first;
	const snapText = await openChat(page, seeded);
	const snap = JSON.parse(snapText);
	const msgs = snap.state?.messages ?? [];
	const winImgs = imagesIn(msgs);
	const winBytes = winImgs.reduce((a, b) => a + (pictures.get(vOf(b.url ?? ""))?.bytes ?? 0), 0);
	const snapBytes = Buffer.byteLength(snapText);
	check(
		"opening the chat sends a small snapshot",
		snapBytes < 150_000,
		`${kb(snapBytes)} for ${winImgs.length} pictures of ${mb(winBytes)}`,
	);
	check("the snapshot holds no picture data", !snapText.includes("data:image") && !snapText.includes('"dataUrl"'));
	check(
		"the window's 20 pictures are placeholders",
		winImgs.length === 20 && winImgs.every((b) => typeof b.url === "string" && b.url.startsWith("/api/chat-image/")),
		`${winImgs.length}`,
	);
	check(
		"each placeholder carries the picture's type, bytes, width and height",
		winImgs.length > 0 &&
			winImgs.every((b) => {
				const p = pictures.get(vOf(b.url));
				return p && b.mimeType === "image/png" && b.bytes === p.bytes && b.width === p.width && b.height === p.height;
			}),
	);
	check(
		"the 2.5 MB screenshot is a placeholder too, not '[image result]'",
		winImgs.some((b) => pictures.get(vOf(b.url))?.width === 1200) && !snapText.includes("[image result]"),
	);
	check(
		"the window starts where it should",
		snap.state?.messagesStart === EXCHANGES * 4 - WINDOW,
		`${snap.state?.messagesStart}`,
	);
	const qi = snap.state?.questionIndex ?? [];
	check(
		"the question list covers all 15 questions, with their places in the whole chat",
		qi.length === EXCHANGES && qi.every((q, k) => q.index === 4 * k && q.text === `question ${k}`),
		qi.map((q) => q.index).join(","),
	);

	// ---- 2. only near pictures load; scrolling up loads the rest --------------------------------------------
	await page.waitForSelector(".messages [data-msg-id]", { timeout: 30000 });
	await sleep(2500);
	const atOpen = await domPictures(page);
	const fetchedAtOpen = new Set(fetched.map(addrKey));
	check(
		"only the pictures near the screen are fetched when the chat opens",
		fetchedAtOpen.size >= 1 && fetchedAtOpen.size < winImgs.length,
		`${fetchedAtOpen.size} of ${winImgs.length}`,
	);
	const inView = atOpen.filter((p) => p.fromView === 0);
	check(
		"the pictures on screen show",
		inView.length > 0 && inView.every((p) => p.loaded),
		`${inView.filter((p) => p.loaded).length}/${inView.length} on screen loaded`,
	);
	const onScreen = inView.find((p) => p.loaded);
	const onScreenPic = onScreen && pictures.get(vOf(onScreen.addr));
	check(
		"a shown picture is the real one at full size",
		!!onScreenPic && onScreen.nw === onScreenPic.width && onScreen.nh === onScreenPic.height,
		onScreen ? `${onScreen.nw}x${onScreen.nh}` : "none",
	);

	// Finished exchanges show folded; open them on the way up so their screenshots are drawn too.
	// Scroll like a person, a step and a pause: the chat draws far messages once scrolling rests.
	/** A picture on its way, seen while scrolling, and the same picture once it has arrived. */
	let probe = null;
	let probeAfter = null;
	let unfolded = 0;
	let rowsOpened = 0;
	const rowChips = [];
	const eachStep = async () => {
		const u = await unfoldAll(page);
		unfolded += u.heads;
		rowsOpened += u.rows;
		rowChips.push(...u.chips);
		await sleep(350);
		if (probe) return;
		const w = (await domPictures(page)).find((p) => p.pending && p.nw > 0 && p.h > 0 && p.fromView < 400);
		if (!w) return;
		probe = w;
		probeAfter = await waitFor(async () => {
			const now = (await domPictures(page)).find((p) => addrKey(p.addr) === addrKey(w.addr));
			return now?.loaded ? now : null;
		}, 8000);
	};
	await eachStep();
	await scrollChat(page, "top", eachStep);
	await sleep(2500);
	check("the window's exchanges could be opened", unfolded >= 10, `${unfolded} opened`);
	const probePic = probe && pictures.get(vOf(probe.addr));
	check(
		"a picture on its way shows as a gray box of its own size",
		!!probePic && probe.nw === probePic.width && probe.nh === probePic.height,
		probe ? `box ${probe.nw}x${probe.nh}, picture ${probePic?.width}x${probePic?.height}` : "no waiting picture seen",
	);
	const winKeys = new Set(winImgs.map((b) => addrKey(b.url)));
	const fetchedKeys = fetched.map(addrKey);
	const fetchedWin = new Set(fetchedKeys.filter((k) => winKeys.has(k)));
	const missing = winImgs
		.filter((b) => !fetchedWin.has(addrKey(b.url)))
		.map((b) => pictures.get(vOf(b.url)))
		.map((p) => `${p?.kind} ${p?.k}`);
	check(
		"scrolling up fetches every picture of the window",
		fetchedWin.size === winKeys.size,
		`${fetchedWin.size} of ${winKeys.size}${missing.length ? `; not fetched: ${missing.join(", ")}` : ""}`,
	);
	// Steps older than the newest 15 messages show as one-line rows (the collapsed view); opened, their
	// screenshots load like any other.
	const behindRows = winImgs.filter((b) => {
		const p = pictures.get(vOf(b.url));
		return p?.kind === "shot" && p.k <= 10;
	});
	check(
		"screenshots behind collapsed rows load once the rows are opened",
		rowsOpened > 0 && behindRows.length > 0 && behindRows.every((b) => fetchedWin.has(addrKey(b.url))),
		`${rowsOpened} rows opened (${[...new Set(rowChips)].join(" / ")}), ${behindRows.length} screenshots behind them`,
	);
	const counts = new Map();
	for (const k of fetchedKeys) counts.set(k, (counts.get(k) ?? 0) + 1);
	check(
		"no picture is fetched over and over",
		[...counts.values()].every((n) => n <= 2),
		`max ${Math.max(0, ...counts.values())} fetches of one picture, ${fetchedKeys.length} in all`,
	);
	if (probe) {
		const after = probeAfter;
		check(
			"nothing jumps when the picture arrives (its box keeps its size)",
			!!after && Math.abs(after.w - probe.w) <= 1 && Math.abs(after.h - probe.h) <= 1,
			after ? `${probe.w}x${probe.h} -> ${after.w}x${after.h}` : "it didn't arrive within 8 s",
		);
	}

	// ---- 3. enlarge -------------------------------------------------------------------------------------------
	await scrollChat(page, "bottom");
	await unfoldAll(page);
	await sleep(1000);
	const clicked = await page.evaluate(() => {
		const b = [...document.querySelectorAll(".messages button.toolcall-image")].at(-1);
		b?.click();
		return !!b;
	});
	const big = clicked
		? await waitFor(
				() =>
					page.evaluate(() => {
						const i = document.querySelector(".img-lightbox img");
						return i && i.complete && i.naturalWidth > 0 ? { w: i.naturalWidth, h: i.naturalHeight } : null;
					}),
				15000,
			)
		: null;
	check(
		"enlarging the big screenshot shows the full 1200x700 picture",
		big?.w === 1200 && big?.h === 700,
		big ? `${big.w}x${big.h}` : clicked ? "no picture in the enlarge view" : "no screenshot button",
	);
	await page.keyboard.press("Escape");
	await page.evaluate(() => document.querySelector(".img-lightbox")?.click());

	// ---- 4. Load older --------------------------------------------------------------------------------------
	await scrollChat(page, "top");
	const olderFrom = await page.evaluate(() => window.__frames.length);
	const olderLabel = await page.evaluate(() => {
		const b = document.querySelector(".load-older button");
		b?.click();
		return b?.textContent ?? null;
	});
	check("the chat offers to load older messages", !!olderLabel, olderLabel ?? "");
	const olderText = await frameAfter(page, olderFrom, ["older_messages", "older_exchanges"]);
	const older = olderText ? JSON.parse(olderText) : null;
	const olderImgs = older
		? older.type === "older_messages"
			? imagesIn(older.messages)
			: imagesIn((older.exchanges ?? []).flatMap((d) => [...(d.head ?? []), ...(d.answers ?? [])]))
		: [];
	check(
		"older messages carry placeholders too",
		olderImgs.length > 0 && olderImgs.every((b) => typeof b.url === "string" && !b.dataUrl),
		`${older?.type ?? "no answer"}: ${olderImgs.length} pictures, ${kb(olderText ? Buffer.byteLength(olderText) : 0)}`,
	);
	await sleep(800);
	await scrollChat(page, "top");
	await sleep(2500);
	const olderKeys = new Set(olderImgs.map((b) => addrKey(b.url)));
	const olderShown = (await domPictures(page)).filter((p) => olderKeys.has(addrKey(p.addr)) && p.loaded);
	check(
		"pictures of the older messages load when scrolled to",
		olderShown.length > 0 && olderShown.every((p) => pictures.get(vOf(p.addr))?.width === p.nw),
		`${olderShown.length} shown`,
	);

	// ---- 5. the picture endpoint ------------------------------------------------------------------------------
	const sample = winImgs[0];
	const samplePic = pictures.get(vOf(sample.url));
	const get = (path, withToken = true) =>
		fetch(`http://127.0.0.1:${PORT}${path}`, withToken ? { headers: { "x-pi-token": TOKEN } } : {});
	const res = await get(sample.url);
	const body = Buffer.from(await res.arrayBuffer());
	check(
		"the endpoint sends the exact picture",
		res.status === 200 && body.length === samplePic.bytes && sha256(body) === samplePic.sha,
		`${res.status}, ${body.length} bytes`,
	);
	check(
		"...with its type, length and a long private cache, sandboxed",
		res.headers.get("content-type") === "image/png" &&
			res.headers.get("content-length") === String(samplePic.bytes) &&
			res.headers.get("cache-control") === "private, max-age=31536000, immutable" &&
			res.headers.get("content-security-policy") === "sandbox" &&
			res.headers.get("x-content-type-options") === "nosniff",
		[...res.headers].map(([k, v]) => `${k}: ${v}`).join("; "),
	);
	check("no password -> 401", (await get(sample.url, false)).status === 401);
	const [, , , sid, mid, n] = sample.url.split("?")[0].split("/");
	const v = vOf(sample.url);
	const nobody = "A".repeat(16);
	const status = async (path) => (await get(path)).status;
	check(
		"a fingerprint that matches no picture -> 404",
		(await status(`/api/chat-image/${sid}/${mid}/${n}?v=${nobody}`)) === 404,
	);
	check("an unknown chat -> 404", (await status(`/api/chat-image/nope/${mid}/${n}?v=${nobody}`)) === 404);
	check(
		"a picture number that isn't a number -> 400",
		(await status(`/api/chat-image/${sid}/${mid}/x?v=${v}`)) === 400,
	);
	check("a malformed fingerprint -> 400", (await status(`/api/chat-image/${sid}/${mid}/${n}?v=short`)) === 400);
	check("no fingerprint -> 400", (await status(`/api/chat-image/${sid}/${mid}/${n}`)) === 400);
	check("an over-long id -> 400", (await status(`/api/chat-image/${sid}/${"m".repeat(400)}/${n}?v=${v}`)) === 400);
	const trick = await get(`/api/chat-image/..%2F..%2F..%2Fetc%2Fpasswd/x/0?v=${nobody}`);
	const trickText = await trick.text();
	check("a path trick finds nothing", trick.status === 404 && !trickText.includes("root:"), `${trick.status}`);
	const moved = await get(`/api/chat-image/${sid}/u-0-0/7?v=${v}`);
	const movedBody = Buffer.from(await moved.arrayBuffer());
	check(
		"a picture whose message id changed (rewind, fork) is still found by its fingerprint",
		moved.status === 200 && sha256(movedBody) === samplePic.sha,
		`${moved.status}`,
	);

	// ---- 6. jump to the first question from a fresh page ---------------------------------------------------------
	const second = await openPage(browser);
	await openChat(second.page, seeded);
	await second.page.waitForSelector(".messages [data-msg-id]", { timeout: 30000 });
	await sleep(1500);
	const q0 = qi[0];
	// The rail shows the questions around the reading place; its "+N" above them moves up.
	let railHit = false;
	for (let i = 0; i < 12 && !railHit; i++) {
		railHit = await second.page.evaluate((label) => {
			const b = [...document.querySelectorAll(".qn-bar, .qn-list-item")].find((x) =>
				(x.getAttribute("aria-label") ?? "").startsWith(label),
			);
			if (b) {
				b.click();
				return true;
			}
			document.querySelector(".qn-rail .qn-more:not(.empty)")?.click();
			return false;
		}, "1. question 0");
		if (!railHit) await sleep(1500);
	}
	check("the question rail reaches the first question", railHit);
	const q0Pic = [...pictures.values()].find((p) => p.kind === "user" && p.k === 0);
	const jumped = await waitFor(
		() =>
			second.page.evaluate(
				({ id, width }) => {
					const el = document.querySelector(`[data-msg-id="${id}"]`);
					const img = el && [...el.querySelectorAll("img")].find((i) => !i.classList.contains("chat-image-pending"));
					return img && img.complete && img.naturalWidth === width;
				},
				{ id: q0?.id, width: q0Pic.width },
			),
		20000,
	);
	check("jumping to the first question (outside the window) shows its picture", !!jumped);

	// ---- 7. a screenshot that arrives while the reply runs ------------------------------------------------------------
	const sp = second.page;
	const newFrom = await sp.evaluate(() => window.__frames.length);
	await sp.evaluate(() => window.__ws.send(JSON.stringify({ type: "new_chat" })));
	const fresh = await waitFor(
		() =>
			sp.evaluate((from) => {
				for (let j = from; j < window.__frames.length; j++) {
					const f = window.__frames[j];
					if (f.startsWith('{"type":"snapshot"') && JSON.parse(f).state?.messages?.length === 0) return true;
				}
				return false;
			}, newFrom),
		20000,
	);
	check("a new chat opens", !!fresh);
	await sp.evaluate(() => window.__ws.send(JSON.stringify({ type: "set_model", modelId: "mock/lazy-mock" })));
	await sleep(500);
	await sp.evaluate(() => window.__ws.send(JSON.stringify({ type: "prompt", text: "QS-SHOT please read shot.png" })));
	// The running exchange shows folded too; open it to see its steps.
	const shotShown = await waitFor(
		async () => {
			await unfoldAll(sp);
			return sp.evaluate(() =>
				[...document.querySelectorAll(".messages .toolcall-images img")].some(
					(i) => !i.classList.contains("chat-image-pending") && i.complete && i.naturalWidth === 400,
				),
			);
		},
		30000,
		250,
	);
	const stillRunning = mockFinishedAt === 0;
	check("a screenshot that arrives while the reply runs shows up before the reply ends", !!shotShown && stillRunning);
	const answered = await waitFor(
		() => sp.evaluate(() => document.querySelector(".messages")?.textContent?.includes("answer to QS-SHOT")),
		30000,
	);
	check("...and the reply finishes normally", !!answered);

	// ---- 8. nothing changed, nothing failed ----------------------------------------------------------------------------
	// Opening a chat may add pi's own bookkeeping lines (a thinking-level line); the messages stay as written.
	const nowFile = readFileSync(seeded);
	const added = nowFile
		.subarray(seededLen)
		.toString("utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l).type;
			} catch {
				return "unreadable";
			}
		});
	check(
		"the seeded session file is unchanged",
		nowFile.length >= seededLen &&
			sha256(nowFile.subarray(0, seededLen)) === seededSha &&
			added.every((type) => type !== "message" && type !== "unreadable"),
		added.length > 0 ? `pi added: ${added.join(", ")}` : "nothing added",
	);
	check("the server logged no picture errors", !/\[chat-image\] failed|unhandled/i.test(serverLog));
	check("the pages had no errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
	await first.ctx.close();
	await second.ctx.close();
} catch (err) {
	console.log(`✗ FAIL: ${err instanceof Error ? err.stack : err}`);
	console.log(serverLog.slice(-3000));
	failures += 1;
} finally {
	clearTimeout(watchdog);
	await browser?.close();
	server.kill("SIGTERM");
	mock.close();
}
console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
