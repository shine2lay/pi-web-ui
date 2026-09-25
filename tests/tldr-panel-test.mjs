/* tldr-panel E2E (no tokens): the right panel's TL;DR tab shows the lines the agent posts with pi-tldr.
 *
 * The real pi-tldr extension is loaded through settings.json `packages` (PI_TLDR_PKG, default
 * ~/projects/pi-tldr). A mock OpenAI-compatible model calls the `tldr` tool three times, spaced out,
 * then answers. Checks:
 *  - the `tldr` tool is offered to the model inside pi-web-ui (the extension loaded, hasUI);
 *  - window A (TL;DR tab open) sees each line arrive live, newest first, without a reload;
 *  - window B opens mid-run on the same chat and gets the last line live too (viewer path);
 *  - the needs-you line is highlighted with a badge;
 *  - after a reload the lines are still there (read back from the session);
 *  - a new chat shows the empty state; switching back brings the lines back.
 * Usage: npm run build && node tests/tldr-panel-test.mjs    (TLDR_DEBUG=1 prints the mock's requests;
 *        TLDR_SHOT=/tmp/x.png saves a screenshot of window A with all 3 lines, plus x-panel.png)
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
const base = mkdtempSync(join(tmpdir(), "piweb-tldr-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });

const MODEL_ID = "tldr-mock";
const QUESTION = "TLDR-RUN fix the login";
const ANSWER = "TLDR-ANSWER all done.";
/** The lines the mock posts, in order, and how long it waits before each call (ms). */
const STEPS = [
	{ args: { text: "Looking into why the login fails" }, gap: 1500 },
	{ args: { text: "Found it: the session token expires too early" }, gap: 1500 },
	{ args: { text: "Need your OK to delete the old login branch", needs_you: true }, gap: 7000 },
];

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
	id: "tldr-mock",
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
let tldrOffered = false;
/** When the mock sent each tldr call (index = step). */
const stepSentAt = [];
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
		await sse(res, [chunk(m, { content: "TL;DR chat" }), chunk(m, {}, "stop")]);
		return;
	}
	const names = payload.tools.map((t) => t.function?.name ?? t.name);
	if (names.includes("tldr")) tldrOffered = true;
	let lastUser = -1;
	history.forEach((x, i) => {
		if (x.role === "user") lastUser = i;
	});
	const results = history.slice(lastUser + 1).filter((x) => x.role === "tool").length;
	if (process.env.TLDR_DEBUG) console.log(`    [mock] request: tools=${names.join(",")} results=${results}`);
	const step = STEPS[results];
	if (step && names.includes("tldr")) {
		await sleep(step.gap);
		const call = { index: 0, id: `call_tldr_${results}`, type: "function" };
		call.function = { name: "tldr", arguments: JSON.stringify(step.args) };
		stepSentAt[results] = Date.now();
		await sse(res, [chunk(m, { tool_calls: [call] }), chunk(m, {}, "tool_calls")]);
		return;
	}
	await sleep(800);
	await sse(res, [chunk(m, { content: ANSWER }), chunk(m, {}, "stop")]);
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
/** The TL;DR tab's lines as shown, top to bottom. */
const tldrTexts = (page) =>
	page.evaluate(() => [...document.querySelectorAll(".tldr-panel .tldr-text")].map((e) => e.textContent));
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
async function openTldrTab(page) {
	await page.locator(".panel-right .slot-tab", { hasText: "TL;DR" }).first().click();
	await page.locator(".tldr-panel").waitFor({ timeout: 5000 });
}
async function send(page, text) {
	const ta = page.locator(".inputbox textarea");
	await ta.fill(text);
	await ta.press("Enter");
}
const chatRow = (page) => page.locator(".lp-row", { hasText: /TLDR-RUN|TL;DR chat/ }).first();

try {
	await waitServer();
	browser = await chromium.launch({ executablePath: CHROME_PATH });

	console.log("window A: TL;DR tab before any run");
	const A = await openWindow("tldr-window-a");
	await openTldrTab(A);
	check("a fresh chat shows the empty state", (await A.locator(".tldr-panel .tldr-empty").count()) === 1);

	console.log("window A: run the chat; lines arrive live");
	await send(A, QUESTION);
	check(
		"line 1 shows up live",
		await waitFor(async () => (await tldrTexts(A)).length === 1, 20000),
		JSON.stringify(await tldrTexts(A)),
	);
	check("the tldr tool was offered to the model (pi-tldr loaded in pi-web-ui)", tldrOffered);
	check("line 2 shows up live", await waitFor(async () => (await tldrTexts(A)).length === 2, 10000));
	check(
		"newest first",
		JSON.stringify(await tldrTexts(A)) === JSON.stringify([STEPS[1].args.text, STEPS[0].args.text]),
		JSON.stringify(await tldrTexts(A)),
	);

	console.log("window B: open the same chat mid-run");
	const B = await openWindow("tldr-window-b");
	await chatRow(B).click();
	await openTldrTab(B);
	check(
		"window B shows the 2 lines so far",
		await waitFor(async () => (await tldrTexts(B)).length === 2, 10000),
		JSON.stringify(await tldrTexts(B)),
	);
	check("window B was ready before line 3 was sent", stepSentAt[2] === undefined);

	check("line 3 shows up live in A", await waitFor(async () => (await tldrTexts(A)).length === 3, 20000));
	check("line 3 shows up live in B", await waitFor(async () => (await tldrTexts(B)).length === 3, 10000));
	for (const [name, page] of [
		["A", A],
		["B", B],
	]) {
		const first = page.locator(".tldr-panel .tldr-line").first();
		check(
			`${name}: the needs-you line is on top and highlighted`,
			(await first.getAttribute("class")) === "tldr-line needs-you",
		);
		check(
			`${name}: it has the badge`,
			((await first.locator(".tldr-badge").textContent()) ?? "").trim() === "Needs you",
		);
		check(`${name}: only that line is highlighted`, (await page.locator(".tldr-panel .needs-you").count()) === 1);
	}
	check("the run answered", await waitFor(async () => (await messagesText(A)).includes("TLDR-ANSWER"), 20000));
	if (process.env.TLDR_SHOT) {
		await A.screenshot({ path: process.env.TLDR_SHOT });
		await A.locator(".panel-right").screenshot({ path: process.env.TLDR_SHOT.replace(/\.png$/, "-panel.png") });
	}

	console.log("window A: reload");
	await A.reload();
	await A.waitForSelector(".topbar", { timeout: 60000 });
	await A.locator(".tldr-panel").waitFor({ timeout: 10000 }); // the tab choice is remembered
	check(
		"after a reload the 3 lines are back, newest first",
		await waitFor(
			async () =>
				JSON.stringify(await tldrTexts(A)) ===
				JSON.stringify([STEPS[2].args.text, STEPS[1].args.text, STEPS[0].args.text]),
			10000,
		),
		JSON.stringify(await tldrTexts(A)),
	);

	console.log("window A: new chat, then back");
	await A.locator(".lp-new-chat-action").click();
	check(
		"a new chat shows the empty state",
		await waitFor(async () => (await A.locator(".tldr-panel .tldr-empty").count()) === 1, 10000),
	);
	await chatRow(A).click();
	check("switching back brings the lines back", await waitFor(async () => (await tldrTexts(A)).length === 3, 10000));
	check("window B still shows 3 lines", (await tldrTexts(B)).length === 3);
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
console.log("\nall tldr-panel checks passed");
