/**
 * Freeze/reconnect regression test.
 *
 * Scenario (mirrors the reported bug):
 *   1. server up → page connects
 *   2. server killed → page must stay responsive, reconnect attempts must be
 *      bounded (exponential backoff), and at most ONE socket in flight at a time
 *   3. server restarted → page must auto-recover and complete a prompt round-trip
 *
 * Any page freeze (blocked main thread) or connection flood fails the test.
 * Runs on a dedicated port (8899) to avoid stray processes.
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp, freePort } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { execSync, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockModel, writeMockModelConfig } from "./lib/mock-model.mjs";
// fileURLToPath: URL.pathname 在 Windows 下是 /E:/... 形式，直接当 cwd 会失败
const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));

const HEADLESS = CHROME_PATH;
const PORT = 8899;
const URL = `http://localhost:${PORT}`;
const PROJ = REPO_ROOT;

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

// A stand-in model on this machine (tests never call the real model), and the server's own pi
// folder and client state (kept across the restart below), never the real ones.
const mock = await startMockModel(({ sideRequest }) => (sideRequest ? "Title" : "recovered"));
mock.unref();
const agentDir = mkdtempSync(join(tmpdir(), "pi-freeze-agent-"));
writeMockModelConfig(agentDir, mock.port);
const dataDir = mkdtempSync(join(tmpdir(), "pi-freeze-data-"));

let server = null;
/** The server's error output (last 4000 characters), shown when a check fails. */
let serverErr = "";
async function startServer() {
	server = spawn("node", ["dist/server/index.js"], {
		cwd: PROJ,
		env: { ...process.env, PI_WEB_PORT: String(PORT), PI_CODING_AGENT_DIR: agentDir, PI_WEB_DATA_DIR: dataDir },
		stdio: ["ignore", "ignore", "pipe"],
	});
	server.stderr.on("data", (d) => {
		serverErr = (serverErr + d).slice(-4000);
	});
	// Wait until the port actually listens (or the process died).
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		try {
			if (!(await portUp(PORT))) throw new Error("port not up");
			return true;
		} catch {
			/* not up yet */
		}
	}
	return false;
}
async function stopServer() {
	if (server) {
		try {
			server.kill("SIGKILL");
		} catch {
			/* noop */
		}
		server = null;
	}
	// Wait until the port is actually free.
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		try {
			if (!(await portUp(PORT))) throw new Error("port not up");
		} catch {
			return; // free
		}
	}
	console.error("⚠ port did not free — killing stragglers");
	try {
		await freePort(PORT);
	} catch {
		/* noop */
	}
}

// Build first so web/dist is fresh.
try {
	if (!process.env.PI_TEST_PREBUILT) execSync("npm run build", { cwd: PROJ, stdio: "ignore" });
} catch (err) {
	console.error("build failed:", err.message);
	process.exit(1);
}
await stopServer();
if (!(await startServer())) {
	console.error("server failed to start");
	process.exit(1);
}

const browser = await chromium.launch({ executablePath: HEADLESS });
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
	if (m.type() === "error") pageErrors.push(`console: ${m.text()}`);
});

// Connection-refused errors during the deliberate downtime are expected;
// anything else (e.g. "Insufficient resources", JS exceptions) is a failure.
const isExpectedError = (text) => text.includes("ERR_CONNECTION_REFUSED") || text.includes("Connection reset");

// Instrument WebSocket before app code runs: count instances / active sockets.
await page.addInitScript(() => {
	window.__wsCount = { created: 0, active: 0, maxActive: 0, closed: 0 };
	// For a failure report: which socket sent/received which message types, and when it opened/closed
	// (types and times only).
	window.__wsLog = [];
	const log = (s) => {
		window.__wsLog.push(`${Math.round(performance.now())} ${s}`);
		if (window.__wsLog.length > 400) window.__wsLog.splice(0, 100);
	};
	const typeOf = (d) => (typeof d === "string" ? (/"type":"([^"]+)"/.exec(d)?.[1] ?? "?") : "bin");
	const Orig = window.WebSocket;
	window.WebSocket = class extends Orig {
		constructor(...args) {
			super(...args);
			const n = ++window.__wsCount.created;
			window.__wsCount.active++;
			window.__wsCount.maxActive = Math.max(window.__wsCount.maxActive, window.__wsCount.active);
			log(`#${n} new`);
			this.addEventListener("open", () => log(`#${n} open`));
			this.addEventListener("message", (e) => {
				const t = typeOf(e.data);
				if (t !== "heartbeat") log(`#${n} got ${t}`);
				// The newest socket that has delivered a full chat snapshot (see "prompt round-trip").
				if (t === "snapshot") window.__snapshotSocket = n;
			});
			this.addEventListener("close", () => {
				window.__wsCount.active--;
				window.__wsCount.closed++;
				log(`#${n} close`);
			});
			this.addEventListener("error", () => {});
			this.__n = n;
		}
		send(data) {
			log(`#${this.__n} sent ${typeOf(data)}`);
			return super.send(data);
		}
	};
});

await page.goto(URL);
const connected = await page
	// The connection label moved to the footer as .status-conn-label (upstream FooterBar).
	.waitForFunction(() => document.querySelector(".status-conn-label")?.textContent?.includes("Connected"), {
		timeout: 15000,
	})
	.then(() => true)
	.catch(() => false);
check("initial connect", connected);

// ---- kill the server: page must stay responsive with bounded reconnects ----
await stopServer();
await sleep(1200);
const responsive1 = await page
	.evaluate(() => {
		const start = performance.now();
		let x = 0;
		for (let i = 0; i < 2_000_000; i++) x += i;
		return { ms: performance.now() - start };
	})
	.catch(() => null);
check("page responsive with server down", !!responsive1 && responsive1.ms < 3000, JSON.stringify(responsive1));

// Give the client a few backoff attempts (~1s+2s+4s) to prove boundedness.
await sleep(9000);
const c1 = await page.evaluate(() => window.__wsCount);
check("at most one socket in flight at a time", c1.maxActive <= 1, JSON.stringify(c1));
check("bounded reconnect attempts while down", c1.created <= 6, `created=${c1.created}`);
check("page still responsive after 9s of downtime", (await page.evaluate(() => 40 + 2)) === 42);

// ---- restart the server: must auto-recover ----
if (!(await startServer())) {
	check("server restarted", false, "start failed");
} else {
	check("server restarted", true);
}
const recovered = await page
	.waitForFunction(() => document.querySelector(".status-conn-label")?.textContent?.includes("Connected"), {
		timeout: 25000,
	})
	.then(() => true)
	.catch(() => false);
check("auto-reconnect after server restart", recovered);

// ---- prompt round-trip after recovery ----
// Type and send like a user (Playwright fills the box and presses Enter), then wait for the
// stand-in model's answer. The old way set the textarea's value from page script and clicked the
// send button by its title: React never saw that text, so the click sent nothing.
// "Connected" shows as soon as the new socket opens, before the chat's snapshot arrives. After a
// server restart that snapshot brings a new session for this empty chat, and switching session
// clears the box (what was typed is kept as the old session's draft). On a loaded machine the test
// typed in that gap and pressed Enter on an empty box, so: wait for the new socket's snapshot, let
// the page settle, and type again if the box was still cleared.
await page
	.waitForFunction(() => window.__snapshotSocket === window.__wsCount.created, null, { timeout: 15000 })
	.catch(() => {});
const box = page.locator("textarea").first();
const prompt = "Reply with exactly: recovered";
for (let i = 0; i < 3; i++) {
	await box.fill(prompt);
	await sleep(300);
	if ((await box.inputValue()) === prompt) break;
}
await box.press("Enter");
const reply = await page
	.waitForFunction(
		() => {
			const msgs = [...document.querySelectorAll('.msg[data-role="assistant"]')];
			const text = msgs[msgs.length - 1]?.textContent ?? "";
			return text.includes("recovered") ? text.trim().slice(0, 120) : null;
		},
		null,
		{ timeout: 60000 },
	)
	.then((h) => h.jsonValue())
	.catch(() => null);
check(
	"prompt round-trip after recovery",
	!!reply,
	reply
		? JSON.stringify(reply.slice(0, 60))
		: JSON.stringify(
				await page.evaluate(() =>
					[...document.querySelectorAll(".msg")]
						.slice(-3)
						.map((m) => `${m.getAttribute("data-role")}: ${m.textContent.trim().slice(0, 80)}`),
				),
			),
);
if (!reply) {
	// What the page showed, whether the model was asked at all, and what the server said.
	const seen = await page
		.evaluate(() => ({
			box: document.querySelector("textarea")?.value ?? null,
			text: document.body.innerText.replace(/\s+/g, " ").slice(0, 800),
		}))
		.catch((e) => ({ error: String(e) }));
	console.log(`  page: ${JSON.stringify(seen)}`);
	const sockets = await page
		.evaluate(() => ({ count: window.__wsCount, log: window.__wsLog.slice(-80) }))
		.catch(() => null);
	console.log(`  sockets: ${JSON.stringify(sockets?.count)}`);
	for (const line of sockets?.log ?? []) console.log(`    ${line}`);
	console.log(`  model requests: ${mock.requests.length}`);
	console.log(`  server stderr: ${serverErr.slice(-1500) || "(none)"}`);
}

check(
	"no unexpected page errors",
	pageErrors.filter((e) => !isExpectedError(e)).length === 0,
	pageErrors
		.filter((e) => !isExpectedError(e))
		.slice(0, 3)
		.join(" | "),
);

await browser.close();
await stopServer();
console.log(failures === 0 ? "\nALL FREEZE TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
