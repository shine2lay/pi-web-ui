/* tldr-sidebar E2E (no tokens): the left list shows each loaded chat's newest TL;DR line under its name,
 * in place of "N messages".
 *
 * The real pi-tldr extension is loaded through settings.json `packages` (PI_TLDR_PKG, default
 * ~/projects/pi-tldr). A mock OpenAI-compatible model runs four chats, told apart by their prompt:
 *   A posts 3 lines, spaced out (the second is long, the third needs you), then answers;
 *   B posts no line; C posts one line; D answers at once.
 * Window 1 starts A, C and B one after the other and stays on D, so A, B and C run in the background.
 * Window 2 opens on a new chat. Checks:
 *  - A's row shows each new line live, in both windows, without a reload; window 2 gets line 2 before
 *    line 3 is sent (pushed to every window as it lands, not only when the run ends);
 *  - the line is cut to one line with an ellipsis, the full text is on hover, rows keep their height;
 *  - a needs-you line is highlighted (same highlight as the TL;DR tab); a normal line is not;
 *  - a chat with no lines (B) keeps "N messages"; the open chat keeps "Current", even with a line;
 *  - window 1 folds A's newest line in the TL;DR tab: window 2's row goes back to "N messages" live
 *    (the older line 2 never shows); opening it again brings the line back.
 * Usage: npm run build && node tests/tldr-sidebar-test.mjs    (SIDEBAR_DEBUG=1 prints the mock's requests;
 *        SIDEBAR_SHOT=/tmp/x.png saves window 1 with the lines, plus x-left.png of the left list)
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const MOCK_PORT = PORT + 1;
const REPO = fileURLToPath(new URL("..", import.meta.url));
const PI_TLDR = process.env.PI_TLDR_PKG ?? join(homedir(), "projects", "pi-tldr");
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
	await sleep(CHATS[k].answerGap);
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
/** The row's second line (under the name): text, classes, hover title, whether it is cut, its look. */
async function sub(page, k) {
	const loc = row(page, k).locator(".session-sub").first();
	if ((await loc.count()) === 0) return null;
	return loc.evaluate((el) => {
		const cs = getComputedStyle(el);
		return {
			text: el.textContent ?? "",
			cls: el.className,
			title: el.getAttribute("title"),
			cut: el.scrollWidth > el.clientWidth,
			ellipsis: cs.textOverflow === "ellipsis" && cs.whiteSpace === "nowrap",
			bg: cs.backgroundColor,
		};
	});
}
const subText = async (page, k) => (await sub(page, k))?.text ?? null;
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
const transparent = (bg) => bg === "rgba(0, 0, 0, 0)" || bg === "transparent";

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

	console.log("A's lines arrive while other chats are open");
	check(
		"window 1: A's row shows line 1 live",
		await waitFor(async () => (await subText(W1, "A")) === A1, 15000),
		JSON.stringify(await sub(W1, "A")),
	);
	check(
		"window 1: C's row shows its line live",
		await waitFor(async () => (await subText(W1, "C")) === C1, 15000),
		JSON.stringify(await sub(W1, "C")),
	);
	for (const [name, page] of [
		["window 1", W1],
		["window 2", W2],
	]) {
		check(
			`${name}: A's row shows line 2 live`,
			await waitFor(async () => (await subText(page, "A")) === A2, 15000),
			JSON.stringify(await sub(page, "A")),
		);
	}
	check("window 2 got line 2 before line 3 was sent", sentAt.A[2] === undefined);
	const s2 = await sub(W1, "A");
	check("line 2 is cut to one line with an ellipsis", !!s2?.cut && !!s2?.ellipsis, JSON.stringify(s2));
	check("hovering shows the full text", s2?.title === A2, s2?.title ?? "");
	check("a normal line is not highlighted", s2?.cls === "session-sub tldr-sub" && transparent(s2?.bg), s2?.cls);
	const heights = await Promise.all(["A", "B", "C", "D"].map((k) => rowHeight(W1, k)));
	check(
		"rows keep their height (line, count and current rows)",
		heights.every((h) => h > 0 && Math.abs(h - heights[0]) < 0.5),
		JSON.stringify(heights),
	);

	for (const [name, page] of [
		["window 1", W1],
		["window 2", W2],
	]) {
		check(
			`${name}: A's row shows line 3 live`,
			await waitFor(async () => (await subText(page, "A")) === A3, 15000),
			JSON.stringify(await sub(page, "A")),
		);
		const s3 = await sub(page, "A");
		check(
			`${name}: the needs-you line is highlighted`,
			/\bneeds-you\b/.test(s3?.cls ?? "") && !transparent(s3?.bg),
			JSON.stringify(s3),
		);
		check(`${name}: C's row shows its line, not highlighted`, (await sub(page, "C"))?.cls === "session-sub tldr-sub");
		check(
			`${name}: B posted no line and keeps the count`,
			COUNT.test((await subText(page, "B")) ?? ""),
			String(await subText(page, "B")),
		);
	}
	check(
		"window 1: the open chat D says Current",
		(await subText(W1, "D")) === "Current",
		String(await subText(W1, "D")),
	);
	check(
		"A and C finished",
		await waitFor(
			async () =>
				(await row(W1, "A").locator(".conv-dot.conv-running").count()) === 0 &&
				(await row(W1, "C").locator(".conv-dot.conv-running").count()) === 0,
			15000,
		),
	);
	check("A's row keeps line 3 after the run ends", (await subText(W2, "A")) === A3, String(await subText(W2, "A")));
	if (process.env.SIDEBAR_SHOT) {
		await W1.locator(".lp-row").first().hover(); // park the mouse away from A's row
		await W1.screenshot({ path: process.env.SIDEBAR_SHOT });
		await W1.locator(".panel-left").screenshot({ path: process.env.SIDEBAR_SHOT.replace(/\.png$/, "-left.png") });
	}

	console.log("window 1: open A and fold its newest line");
	await row(W1, "A").locator(".session-item").click();
	check(
		"window 1: the open chat A says Current, even with an unseen line",
		await waitFor(async () => (await subText(W1, "A")) === "Current", 10000),
		String(await subText(W1, "A")),
	);
	check("window 2: A's row still shows line 3", (await subText(W2, "A")) === A3);
	await W1.locator(".panel-right .slot-tab", { hasText: "TL;DR" }).first().click();
	await W1.locator(".tldr-panel .tldr-line").first().waitFor({ timeout: 10000 });
	await W1.locator(".tldr-panel .tldr-line").first().locator(".tldr-fold").click();
	check(
		"window 2: A's row goes back to the count, live",
		await waitFor(async () => COUNT.test((await subText(W2, "A")) ?? ""), 5000),
		String(await subText(W2, "A")),
	);
	check("window 2: the older line 2 does not show instead", (await subText(W2, "A")) !== A2);
	await W1.locator(".tldr-panel .tldr-unfold").click();
	check(
		"window 2: opening it again brings line 3 back, live",
		await waitFor(async () => (await subText(W2, "A")) === A3, 5000),
		String(await subText(W2, "A")),
	);
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
