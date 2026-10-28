/* sidebar-no-tldr E2E (no tokens; Ops #621, owner 2026-10-28 m77387): the left list shows no TL;DR line under a
 * chat's name; a loaded chat's row keeps "N messages" (the open chat "Current") while its TL;DR lines arrive.
 * Until Ops #621 (tldr-sidebar) the row showed the chat's newest line instead; the chat's TL;DR tab still does.
 *
 * The real pi-tldr extension is loaded through settings.json `packages` (PI_TLDR_PKG, default
 * ~/projects/pi-tldr). A mock OpenAI-compatible model runs four chats, told apart by their prompt:
 *   A posts 3 lines, spaced out (the second is long, the third needs you), then answers;
 *   B posts no line; C posts one line; D answers at once.
 * Window 1 starts A, C and B one after the other and stays on D, so A, B and C run in the background.
 * Window 2 opens on a new chat, before A's second line. Checks:
 *  - while A and C post their lines, no row in either window ever shows one, without a reload; every
 *    row keeps its count ("Current" for the open chat) and one height;
 *  - the lines did land: window 1 opens A and its TL;DR tab shows all three, the needs-you one
 *    highlighted, while window 2's row for A keeps its count;
 *  - tldr-answered: window 1 replies in A. The TL;DR tab drops the needs-you highlight as soon as the
 *    reply lands, while A is still working on it (the line itself stays).
 * Usage: npm run build && node tests/tldr-sidebar-test.mjs    (SIDEBAR_DEBUG=1 prints the mock's requests;
 *        SIDEBAR_SHOT=/tmp/x.png saves window 1 once the lines are in, plus x-left.png of the left list)
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const MOCK_PORT = PORT + 1;
const REPO = fileURLToPath(new URL("..", import.meta.url));
// The account's home (userInfo), not HOME: a sealed test run has a temp HOME.
const PI_TLDR = process.env.PI_TLDR_PKG ?? join(userInfo().homedir, "projects", "pi-tldr");
if (!existsSync(join(PI_TLDR, "package.json"))) {
	console.log(`✗ FAIL: pi-tldr not found at ${PI_TLDR} (set PI_TLDR_PKG)`);
	process.exit(1);
}
const base = mkdtempSync(join(tmpdir(), "piweb-sidebar-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });

const MODEL_ID = "sidebar-mock";
const A1 = "Looking into why the login fails";
const A2 =
	"Found it: the session token expires after five minutes because the refresh timer counts seconds " +
	"where the server expects milliseconds, so every open tab logs out early";
const A3 = "Need your OK to delete the old login branch";
const C1 = "Tests pass, writing the summary";
/** Each chat: its title, the lines it posts in order, how long the mock waits before each (ms),
 *  and how long before the answer. */
const CHATS = {
	A: {
		title: "Alpha chat",
		steps: [
			{ args: { text: A1 }, gap: 3000 },
			{ args: { text: A2 }, gap: 8000 },
			{ args: { text: A3, needs_you: true }, gap: 5000 },
		],
		answerGap: 800,
	},
	B: { title: "Bravo chat", steps: [], answerGap: 3000 },
	C: { title: "Charlie chat", steps: [{ args: { text: C1 }, gap: 3000 }], answerGap: 800 },
	D: { title: "Delta chat", steps: [], answerGap: 300 },
};
const prompt = (k) => `SIDEBAR-${k} fix the login`;
const answer = (k) => `SIDEBAR-${k}-ANSWER done.`;
/** The user's answer to A's needs-you line; the mock takes its time over it, so the checks see A still running. */
const REPLY = "Yes, delete the old login branch";
const REPLY_GAP = 6000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`  ${ok ? "✓" : "✗ FAIL:"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};
async function waitFor(fn, ms) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await fn()) return true;
		await sleep(200);
	}
	return false;
}

// ---- mock provider ---------------------------------------------------------
const chunk = (model, delta, finish = null) => ({
	id: "sidebar-mock",
	object: "chat.completion.chunk",
	created: Math.floor(Date.now() / 1000),
	model,
	choices: [{ index: 0, delta, finish_reason: finish }],
});
async function sse(res, chunks) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
}
/** The chat a request belongs to: the newest prompt that started a chat ("SIDEBAR-X fix the login") and
 *  its index. pi-web-ui adds user messages of its own (the "other runs" reminder names the other chats),
 *  so only a message that starts with a prompt counts. */
function promptOf(history) {
	for (let i = history.length - 1; i >= 0; i--) {
		const x = history[i];
		if (x.role !== "user") continue;
		const text = typeof x.content === "string" ? x.content : (x.content ?? []).map((p) => p.text ?? "").join("");
		const m = text.match(/^SIDEBAR-([ABCD]) fix the login/);
		if (m) return { k: m[1], at: i };
	}
	return { k: undefined, at: -1 };
}
let tldrOffered = false;
/** When the mock sent each tldr call: sentAt[chat][step]. */
const sentAt = { A: [], B: [], C: [], D: [] };
const mock = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${MOCK_PORT}`);
	if (url.pathname.endsWith("/models")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model" }] }));
		return;
	}
	if (!url.pathname.endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	for await (const c of req) body += c;
	const payload = JSON.parse(body || "{}");
	const m = payload.model;
	const history = payload.messages ?? [];
	// Side requests (the title) carry no tools.
	if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
		const k = promptOf(history).k ?? JSON.stringify(history).match(/SIDEBAR-([ABCD]) fix the login/)?.[1];
		await sse(res, [chunk(m, { content: k ? CHATS[k].title : "Other chat" }), chunk(m, {}, "stop")]);
		return;
	}
	const names = payload.tools.map((t) => t.function?.name ?? t.name);
	if (names.includes("tldr")) tldrOffered = true;
	const { k: found, at } = promptOf(history);
	const k = found ?? "D";
	const results = history.slice(at + 1).filter((x) => x.role === "tool").length;
	if (process.env.SIDEBAR_DEBUG) {
		console.log(`    [mock] chat ${k}: tools=${names.length} results=${results}`);
	}
	const step = CHATS[k].steps[results];
	if (step && names.includes("tldr")) {
		await sleep(step.gap);
		const call = { index: 0, id: `call_${k}_${results}`, type: "function" };
		call.function = { name: "tldr", arguments: JSON.stringify(step.args) };
		sentAt[k][results] = Date.now();
		await sse(res, [chunk(m, { tool_calls: [call] }), chunk(m, {}, "tool_calls")]);
		return;
	}
	const lastUser = [...history].reverse().find((x) => x.role === "user");
	const lastText =
		typeof lastUser?.content === "string"
			? lastUser.content
			: (lastUser?.content ?? []).map((p) => p.text ?? "").join("");
	await sleep(lastText.includes(REPLY) ? REPLY_GAP : CHATS[k].answerGap);
	await sse(res, [chunk(m, { content: answer(k) }), chunk(m, {}, "stop")]);
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "mock-key",
				models: [{ id: MODEL_ID, name: "Mock", input: ["text"], contextWindow: 200000, maxTokens: 4096 }],
			},
		},
	}),
);
writeFileSync(
	join(agentDir, "settings.json"),
	JSON.stringify({ defaultProvider: "mock", defaultModel: MODEL_ID, packages: [PI_TLDR] }),
);

// ---- server ----------------------------------------------------------------
const server = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
	cwd: REPO,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: workdir,
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_TOKEN: "",
	},
	stdio: ["ignore", "pipe", "pipe"],
	detached: true,
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
process.on("exit", () => {
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
});

async function waitServer() {
	for (let i = 0; i < 150; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(200);
	}
	throw new Error("server did not start");
}

// ---- browser ---------------------------------------------------------------
let browser;
const pageErrors = [];
const messagesText = (page) => page.evaluate(() => document.querySelector(".messages")?.innerText ?? "");
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
	// Ready to send: a message sent while the page's session still initializes is refused with a notice,
	// and the composer then empties when the session binds, so A never started (Ops #621).
	await page.waitForFunction(
		() => {
			const input = document.querySelector(".inputbox textarea");
			return !!input && !input.disabled && !/initializing/i.test(input.placeholder);
		},
		undefined,
		{ timeout: 20000 },
	);
	// Marks this page load: still there at the end = the window never reloaded.
	await page.evaluate(() => {
		window.__sidebarLoad = 1;
	});
	return page;
}
async function send(page, text) {
	const ta = page.locator(".inputbox textarea");
	await ta.fill(text);
	await ta.press("Enter");
}
const TITLE = {
	A: /SIDEBAR-A|Alpha chat/,
	B: /SIDEBAR-B|Bravo chat/,
	C: /SIDEBAR-C|Charlie chat/,
	D: /SIDEBAR-D|Delta chat/,
};
const row = (page, k) => page.locator(".lp-row", { hasText: TITLE[k] }).first();
/** The text of the row's second line (under the name). */
async function subText(page, k) {
	const loc = row(page, k).locator(".session-sub").first();
	return (await loc.count()) === 0 ? null : ((await loc.textContent()) ?? "");
}
const rowHeight = async (page, k) => (await row(page, k).locator(".session-item").boundingBox())?.height ?? -1;
const COUNT = /^\d+ messages?$/;
/** Start chat k in the page's current (blank) chat and wait until its row runs. */
async function start(page, k) {
	await send(page, prompt(k));
	return waitFor(async () => (await row(page, k).locator(".conv-dot.conv-running").count()) > 0, 15000);
}
async function newChat(page) {
	await page.locator(".lp-new-chat-action").click();
	await waitFor(async () => !/SIDEBAR-/.test(await messagesText(page)), 10000);
	await page.locator(".inputbox textarea").waitFor({ timeout: 10000 });
}
/** SIDEBAR_DEBUG: print the left list as shown. */
async function dumpRows(page, label) {
	if (!process.env.SIDEBAR_DEBUG) return;
	const rows = await page.evaluate(() =>
		[...document.querySelectorAll(".lp-row")].map((r) => r.innerText.replace(/\s+/g, " ").trim()),
	);
	console.log(`    [rows ${label}] ${JSON.stringify(rows)}`);
	console.log(`    [messages ${label}] ${JSON.stringify((await messagesText(page)).slice(0, 200))}`);
}

try {
	await waitServer();
	browser = await chromium.launch({ executablePath: CHROME_PATH });

	console.log("window 1: start A, C and B, then stay on D");
	const W1 = await openWindow("sidebar-window-1");
	check("A runs", await start(W1, "A"));
	await dumpRows(W1, "after A");
	await newChat(W1);
	await dumpRows(W1, "new chat 1");
	check("C runs", await start(W1, "C"));
	await dumpRows(W1, "after C");
	await newChat(W1);
	check("B runs", await start(W1, "B"));
	await dumpRows(W1, "after B");
	await newChat(W1);
	await dumpRows(W1, "new chat 3");
	await send(W1, prompt("D"));
	check("D answered", await waitFor(async () => (await messagesText(W1)).includes(answer("D")), 15000));
	await dumpRows(W1, "after D");
	check("the tldr tool was offered to the model (pi-tldr loaded)", tldrOffered);

	console.log("window 2: opens on a new chat");
	const W2 = await openWindow("sidebar-window-2");
	await newChat(W2);
	check("window 2 was ready before A's line 2 was sent", sentAt.A[1] === undefined);

	console.log("A's and C's lines arrive while other chats are open: no row shows them");
	/** Every TL;DR line a row in either window showed while the lines arrived (sidebar-no-tldr: none). */
	const shownLines = new Set();
	const sampleRows = async () => {
		for (const page of [W1, W2]) {
			const rows = await page.evaluate(() =>
				[...document.querySelectorAll(".panel-left .lp-row")].map((r) => r.textContent ?? ""),
			);
			for (const text of rows) for (const line of [A1, A2, A3, C1]) if (text.includes(line)) shownLines.add(line);
		}
	};
	const running = async (k) => (await row(W1, k).locator(".conv-dot.conv-running").count()) > 0;
	check(
		"A and C posted their lines and finished",
		await waitFor(async () => {
			await sampleRows();
			return sentAt.A.length === 3 && sentAt.C.length === 1 && !(await running("A")) && !(await running("C"));
		}, 40000),
		`A sent ${sentAt.A.length} lines, C ${sentAt.C.length}`,
	);
	await sampleRows();
	check("no row in either window showed a TL;DR line meanwhile", shownLines.size === 0, [...shownLines].join(" | "));
	for (const [name, page] of [
		["window 1", W1],
		["window 2", W2],
	]) {
		for (const k of ["A", "B", "C"])
			check(
				`${name}: ${k}'s row shows its message count`,
				COUNT.test((await subText(page, k)) ?? ""),
				String(await subText(page, k)),
			);
	}
	check(
		"window 1: the open chat D says Current",
		(await subText(W1, "D")) === "Current",
		String(await subText(W1, "D")),
	);
	const heights = await Promise.all(["A", "B", "C", "D"].map((k) => rowHeight(W1, k)));
	check(
		"rows keep one height (count and current rows)",
		heights.every((h) => h > 0 && Math.abs(h - heights[0]) < 0.5),
		JSON.stringify(heights),
	);

	if (process.env.SIDEBAR_SHOT) {
		await W1.locator(".lp-row").first().hover(); // park the mouse away from A's row
		await W1.screenshot({ path: process.env.SIDEBAR_SHOT });
		await W1.locator(".panel-left").screenshot({ path: process.env.SIDEBAR_SHOT.replace(/\.png$/, "-left.png") });
	}

	console.log("window 1: open A; its TL;DR tab has the lines");
	await row(W1, "A").locator(".session-item").click();
	check(
		"window 1: the open chat A says Current",
		await waitFor(async () => (await subText(W1, "A")) === "Current", 10000),
		String(await subText(W1, "A")),
	);
	await W1.locator(".panel-right .slot-tab", { hasText: "TL;DR" }).first().click();
	const tabTexts = () => W1.locator(".tldr-panel .tldr-text").allTextContents();
	check(
		"window 1: A's TL;DR tab shows its three lines",
		await waitFor(async () => {
			const texts = await tabTexts();
			return [A1, A2, A3].every((l) => texts.includes(l));
		}, 10000),
		JSON.stringify(await tabTexts()),
	);
	check(
		"window 2: A's row still shows its count",
		COUNT.test((await subText(W2, "A")) ?? ""),
		String(await subText(W2, "A")),
	);
	await sampleRows();
	check("still no row showed a TL;DR line", shownLines.size === 0, [...shownLines].join(" | "));

	console.log("window 1: reply in A (tldr-answered)");
	const tabNeedsYou = () => W1.locator(".tldr-panel .tldr-line.needs-you").count();
	const tabBadges = () => W1.locator(".tldr-panel .tldr-badge").count();
	check(
		"window 1: before the reply, the TL;DR tab highlights line 3",
		(await tabNeedsYou()) === 1 && (await tabBadges()) === 1,
	);
	await send(W1, REPLY);
	const sentReply = Date.now();
	const dropped = await waitFor(async () => (await tabNeedsYou()) === 0 && (await tabBadges()) === 0, 4000);
	const droppedAfter = Date.now() - sentReply;
	check(
		"window 1: the TL;DR tab drops the highlight and badge once the reply lands, and keeps the line",
		dropped && (await W1.locator(".tldr-panel .tldr-text", { hasText: A3 }).count()) === 1,
		`${await tabNeedsYou()} highlighted`,
	);
	check(
		"...while A was still working on the reply (not only at the end of the run)",
		dropped && droppedAfter < REPLY_GAP - 1000 && (await row(W2, "A").locator(".conv-dot.conv-running").count()) > 0,
		dropped ? `${droppedAfter} ms` : "never dropped",
	);
	check(
		"A answered the reply",
		await waitFor(async () => (await row(W2, "A").locator(".conv-dot.conv-running").count()) === 0, REPLY_GAP + 8000),
	);
	check(
		"window 2: after the run, A's row still shows its count",
		COUNT.test((await subText(W2, "A")) ?? ""),
		String(await subText(W2, "A")),
	);
	await sampleRows();
	check("no row showed a TL;DR line at any point", shownLines.size === 0, [...shownLines].join(" | "));
	for (const [name, page] of [
		["window 1", W1],
		["window 2", W2],
	]) {
		check(`${name} never reloaded`, (await page.evaluate(() => window.__sidebarLoad)) === 1);
	}
	check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (e) {
	failures++;
	console.log(`  ✗ FAIL: ${e?.stack ?? e}`);
} finally {
	await browser?.close();
	mock.close();
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
}

if (failures) {
	console.log(`\n${failures} check(s) failed. Server log tail:\n${serverLog.split("\n").slice(-30).join("\n")}`);
	process.exit(1);
}
console.log("\nall tldr-sidebar checks passed");
