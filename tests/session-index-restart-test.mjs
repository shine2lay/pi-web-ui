/* session-index E2E (zero tokens): after a restart, Recent chats and History are complete within 2 s of
 * a window reconnecting, and they are the same rows as before the restart.
 *
 * Before the session index every window re-read every transcript in full after a restart (pi's
 * SessionManager.listAll, twice per window), all windows at once, so the saved chats showed up late.
 * Now the server keeps a saved index of the chat files (<dataDir>/session-index.json) and sends the
 * list when a window attaches.
 *  1. 40 saved chats in two projects (four of them 25 MB each) → Recent chats (15) and History (40);
 *     the index is saved.
 *  2. The server is killed and started again; three windows reload at the same time. Each one shows
 *     the full Recent chats and History within 2 s of its connection opening, the same as before.
 *  3. The restarted server read no transcript in full (its first listing came from the saved index).
 * Usage: npm run build && node tests/session-index-restart-test.mjs   (SESSIONINDEX_DEBUG=1: timings) */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { freeTcpPort } from "./lib/port-utils.mjs";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const PORT = await freeTcpPort();
const ROOT_URL = `http://localhost:${PORT}/`;
const REPO = fileURLToPath(new URL("..", import.meta.url));
const DEBUG = process.env.SESSIONINDEX_DEBUG === "1";
const base = mkdtempSync(join(tmpdir(), "piweb-sessionindex-"));
const workdir = join(base, "work");
const otherProject = join(base, "other-project");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, otherProject, dataDir, agentDir]) mkdirSync(d, { recursive: true });
const INDEX_FILE = join(dataDir, "session-index.json");
const LIMIT_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
	if (!ok) failures++;
	console.log(`  ${ok ? "✓" : "✗ FAIL:"} ${name}${extra ? `  (${extra})` : ""}`);
};
async function waitFor(pred, timeoutMs, what) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (await pred()) return true;
		await sleep(50);
	}
	if (what) console.log(`  … gave up waiting for ${what} after ${timeoutMs}ms`);
	return false;
}

// ---- saved chats (pi's transcript format, in pi's default session folders) -------------------------
const sessionDirOf = (cwd) =>
	join(
		agentDir,
		"sessions",
		`--${resolve(cwd)
			.replace(/^[/\\]/, "")
			.replace(/[/\\:]/g, "-")}--`,
	);
const iso = (ms) => new Date(ms).toISOString();
const fileStamp = (ms) => iso(ms).replace(/[:.]/g, "-");
let seq = 0;
const id = () => `e${(++seq).toString(36).padStart(6, "0")}`;
function writeChat(i, cwd, at, bigMb = 0) {
	const dir = sessionDirOf(cwd);
	mkdirSync(dir, { recursive: true });
	const sid = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
	const file = join(dir, `${fileStamp(at)}_${sid}.jsonl`);
	let t = at;
	let parent = null;
	const entry = (e) => {
		const full = { ...e, id: id(), parentId: parent, timestamp: iso((t += 1000)) };
		parent = full.id;
		return JSON.stringify(full);
	};
	const msg = (role, text) =>
		entry({
			type: "message",
			message:
				role === "user"
					? { role, content: [{ type: "text", text }], timestamp: t + 1000 }
					: {
							role,
							content: [{ type: "text", text }],
							api: "x",
							provider: "x",
							model: "x",
							stopReason: "stop",
							timestamp: t + 1000,
						},
		});
	const lines = [JSON.stringify({ type: "session", version: 3, id: sid, timestamp: iso(at), cwd })];
	const turns = 1 + (i % 4);
	for (let k = 0; k < turns; k++) {
		lines.push(msg("user", `saved chat ${i} question ${k}`));
		lines.push(msg("assistant", `answer ${k} for chat ${i}`));
	}
	if (i % 5 === 0) lines.push(entry({ type: "session_info", name: `Named chat ${i}` }));
	writeFileSync(file, `${lines.join("\n")}\n`);
	if (bigMb > 0) {
		// A big chat: an image-heavy turn (what made the real transcripts 1.4 GB).
		const blob = "A".repeat(1 << 20);
		for (let m = 0; m < bigMb; m++) {
			appendFileSync(
				file,
				`${entry({ type: "message", message: { role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "image", data: blob, mimeType: "image/png" }], isError: false, timestamp: t } })}\n`,
			);
		}
	}
}
const now = Date.now();
for (let i = 1; i <= 40; i++) {
	const at = now - (41 - i) * 3 * 3600_000; // one every 3 hours, oldest first
	writeChat(i, i % 3 === 0 ? otherProject : workdir, at, i % 10 === 0 ? 25 : 0);
}

// ---- server (killed and started again on the same port and data folder) ----------------------------
let server = null;
let serverLog = "";
let startLogAt = 0;
function startServer() {
	startLogAt = serverLog.length;
	server = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
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
	server.stdout.on("data", (d) => (serverLog += d));
	server.stderr.on("data", (d) => (serverLog += d));
}
function stopServer() {
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
}
process.on("exit", stopServer);
const serverUp = async () => {
	try {
		return (await fetch(ROOT_URL)).ok;
	} catch {
		return false;
	}
};

/** One window: remembers when each of its WebSockets opened. */
async function openWindow(browser) {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	const win = { page, wsOpened: [] };
	page.on("websocket", () => win.wsOpened.push(Date.now()));
	return win;
}
/** What the window shows: every Recent chats row and every History row (their text and tooltip). */
const lists = (page) =>
	page.evaluate(() => {
		const rows = (sel) =>
			[...document.querySelectorAll(sel)].map((b) => `${b.getAttribute("title") ?? ""} | ${b.textContent ?? ""}`);
		return {
			recent: rows(".lp-section-convs .session-item"),
			history: rows(".lp-section-sessions .session-item"),
		};
	});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** The first row where two windows' lists differ, for a failing check's detail. */
const firstDiff = (a, b) => {
	for (const key of ["recent", "history"]) {
		const n = Math.max(a?.[key]?.length ?? 0, b?.[key]?.length ?? 0);
		for (let i = 0; i < n; i++) {
			if (a?.[key]?.[i] !== b?.[key]?.[i])
				return `${key}[${i}]: "${a?.[key]?.[i] ?? "(none)"}" vs "${b?.[key]?.[i] ?? "(none)"}"`;
		}
	}
	return "";
};

let browser = null;
try {
	startServer();
	if (!(await waitFor(serverUp, 30000, "the server"))) throw new Error("server did not start");
	browser = await chromium.launch({ executablePath: CHROME_PATH });

	console.log("1. saved chats show in Recent chats and History; the index is saved");
	const wins = [await openWindow(browser), await openWindow(browser), await openWindow(browser)];
	await Promise.all(wins.map((w) => w.page.goto(ROOT_URL)));
	let before = null;
	// Recent chats: the 15 newest saved chats (PI_WEB_UI_RECENT_LIMIT's default), plus the chat the window
	// opened (the newest one, live), plus the window's own blank chat if it shows one.
	const savedRecent = (l) => l.recent.filter((r) => /saved chat|Named chat/.test(r));
	await waitFor(
		async () => {
			before = await lists(wins[0].page);
			return before.history.length === 40 && savedRecent(before).length >= 15;
		},
		60000,
		"the lists before the restart",
	);
	if (DEBUG) for (const r of before.recent) console.log(`    recent: ${r}`);
	check("History lists all 40 saved chats", before.history.length === 40, `rows=${before.history.length}`);
	check(
		"Recent chats lists at least the newest 15 saved chats",
		savedRecent(before).length >= 15 && savedRecent(before).length <= 16,
		`rows=${savedRecent(before).length}`,
	);
	check(
		"Recent chats' saved rows are History's newest 15",
		savedRecent(before).every((r, i) => (before.history[i] ?? "").includes(r.split(" — ")[0])),
	);
	check(
		"History is newest first and names the named chats",
		before.history[0]?.includes("Named chat 40") && before.history.at(-1)?.includes("saved chat 1 question 0"),
	);
	for (const w of wins.slice(1)) {
		const shown = await lists(w.page);
		check("every window shows the same lists", same(shown, before), firstDiff(shown, before));
	}
	check("the index is saved", await waitFor(() => existsSync(INDEX_FILE), 10000, "the saved index"));
	await sleep(500);

	console.log("2. after a restart three windows reconnect at once: full lists within 2 s");
	stopServer();
	await waitFor(async () => !(await serverUp()), 10000, "the server to go down");
	startServer();
	if (!(await waitFor(serverUp, 30000, "the server to come back"))) throw new Error("server did not restart");
	const opened = wins.map((w) => w.wsOpened.length);
	await Promise.all(wins.map((w) => w.page.reload({ waitUntil: "commit" })));
	const results = await Promise.all(
		wins.map(async (w, i) => {
			await waitFor(() => w.wsOpened.length > opened[i], 20000, `window ${i + 1}'s connection`);
			const connectedAt = w.wsOpened.at(-1);
			let shown = null;
			const ok = await waitFor(
				async () => {
					shown = await lists(w.page);
					return same(shown, before);
				},
				20000,
				`window ${i + 1}'s full lists`,
			);
			return { ok, ms: Date.now() - connectedAt, shown };
		}),
	);
	results.forEach((r, i) => {
		check(
			`window ${i + 1}: Recent chats and History match the lists before the restart`,
			r.ok,
			r.ok ? "" : `recent ${r.shown?.recent.length}, history ${r.shown?.history.length}; ${firstDiff(r.shown, before)}`,
		);
		check(`window ${i + 1}: complete within ${LIMIT_MS} ms of reconnecting`, r.ok && r.ms <= LIMIT_MS, `${r.ms} ms`);
	});

	console.log("3. the restarted server listed from the saved index");
	const log = serverLog.slice(startLogAt);
	const line = log.split("\n").find((l) => l.includes("[session-index] first listing"));
	if (DEBUG) console.log(`  ${line ?? "(no first-listing line)"}`);
	check(
		"it read no transcript in full",
		/\b0 read in full, 0 read from where they stopped/.test(line ?? ""),
		line ?? "no line",
	);
	check(
		"all 40 chats came from the saved index",
		/40 chats/.test(line ?? "") && /40 unchanged/.test(line ?? ""),
		line ?? "",
	);
} catch (e) {
	failures++;
	console.log(`  ✗ FAIL: ${e?.stack ?? e}`);
} finally {
	await browser?.close();
	stopServer();
}

if (failures) {
	console.log(`\n${failures} check(s) failed. Server log tail:\n${serverLog.split("\n").slice(-30).join("\n")}`);
	process.exit(1);
}
console.log("\nall session-index restart checks passed");
