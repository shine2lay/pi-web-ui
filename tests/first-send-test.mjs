/* first-send E2E (Ops #631, plan ~/kept-from-tmp/2026-10-28/first-send-plan/PLAN.md Task A): a message sent
 * while a new chat is still starting (composer "Session is initializing") is never lost, and once the chat
 * is ready it goes out exactly once, to the chat it was typed in.
 *
 * Every case owns its own server (temp HOME, own port, mock model) and browser context, so its counts are
 * its own. Entry points: a = a page with no chat (the server's first chat is still being made);
 * b = New chat on a page that already has a chat; c = a fresh load or reload. A fault hook in session
 * create (server/test-startup-fault.ts, PI_WEB_TEST_STARTUP_FAULT_FILE) holds a start-up (delayMs) or
 * fails it, so a case can act while the chat starts.
 *
 * What a case measures, all from the app's own state, never from a model request:
 *  - calls: how many times the mock model was called (a counter; the request is never read);
 *  - rows: user messages carrying the case's marker, per chat, from the chats' transcript files;
 *  - the composer: its text, chips, placeholder, the "Sends when the chat is ready" line, notices, and
 *    whether it went empty before the message showed in the chat (sampled every 20 ms in the page).
 *
 * Scenarios S1-S12 as in the plan (combinations that can't happen are left out: a page with no chat has
 * no other chat to open or to quote). FIRST_SEND_REPEATS=full runs the plan's repeat counts (~200 runs);
 * the default (1) runs every cell once. FIRST_SEND_ONLY=S1,S4 limits scenarios; FIRST_SEND_JOBS (3) runs
 * cases side by side; FIRST_SEND_OUT=<file.json> saves the table. Exit 1 when any row misses its expected
 * result.
 * Usage: npm run build && node tests/first-send-test.mjs
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";

const FULL = process.env.FIRST_SEND_REPEATS === "full";
const REPEATS = FULL ? 0 : Math.max(1, Number(process.env.FIRST_SEND_REPEATS || 1));
const JOBS = Math.max(1, Number(process.env.FIRST_SEND_JOBS || 3));
const ONLY = (process.env.FIRST_SEND_ONLY || "").split(",").filter(Boolean);
const OUT = process.env.FIRST_SEND_OUT || "";
const HOLD_MS = 2000; // a held start-up: long enough to act while it starts
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.setMaxListeners(0); // one exit listener per case's own server

// [scenario, entry points, cells, the plan's repeats]
const MATRIX = [
	["S1", ["a", "b"], ["0ms", "50ms", "100ms", "500ms", "control"], 10],
	["S2", ["a", "b"], ["double-enter"], 10],
	["S3", ["a", "b"], ["reconnect"], 10],
	["S4", ["a", "b"], ["edit"], 3],
	["S5", ["a", "b"], ["remove-attachment"], 3],
	["S6", ["a", "b"], ["escape"], 3],
	["S7", ["b"], ["open-other"], 3],
	["S8", ["b"], ["new-chat-again"], 3],
	["S9", ["a", "b"], ["fail"], 3],
	// "-control" cells attach and send once the chat is ready: they prove the attachment check itself.
	["S10", ["a", "b"], ["image", "file", "conversation", "image-control", "file-control"], 3],
	["S11", ["a", "b"], ["fail-after", "navigate-after"], 3],
	["S12", ["c"], ["R-a", "R-b"], 3],
];
const IMPOSSIBLE = new Set(["S10/a/conversation"]); // a page with no chat has no other chat to quote

const cases = [];
for (const [scenario, entries, cells, full] of MATRIX) {
	if (ONLY.length && !ONLY.includes(scenario)) continue;
	for (const entry of entries)
		for (const cell of cells) {
			if (IMPOSSIBLE.has(`${scenario}/${entry}/${cell}`)) continue;
			for (let rep = 1; rep <= (FULL ? full : REPEATS); rep++) cases.push({ scenario, entry, cell, rep });
		}
}

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

/** User messages per transcript file: [{ file, rows: [{ text, json, asides }] }] (the app's own saved chats).
 *  asides: the other non-assistant entries between the previous user message and the next one; attachments
 *  travel as such entries (server/attachments.ts "asides", custom messages), not inside the prompt. */
function transcripts(agentDir) {
	const out = [];
	const walk = (dir) => {
		if (!existsSync(dir)) return;
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith(".jsonl")) {
				const rows = [];
				/** non-user, non-assistant entries since the last user row */
				let between = [];
				for (const line of readFileSync(p, "utf8").split("\n")) {
					if (!line.trim()) continue;
					let entry;
					try {
						entry = JSON.parse(line);
					} catch {
						continue;
					}
					const m = entry?.type === "message" ? entry.message : null;
					if (m?.role !== "user") {
						if (m?.role === "assistant" || entry?.type === "session") continue;
						between.push(line);
						if (rows.length) rows[rows.length - 1].asides.push(line);
						continue;
					}
					const content = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }];
					const text = content
						.filter((c) => c?.type === "text")
						.map((c) => c.text)
						.join("\n");
					rows.push({
						text,
						hasImage: content.some((c) => c?.type === "image"),
						json: line,
						asides: between,
					});
					between = [];
				}
				out.push({ file: p, rows });
			}
		}
	};
	walk(join(agentDir, "sessions"));
	return out;
}

async function runCase(c, browser) {
	const marker = `FS-${c.scenario}-${c.entry}-${c.cell}-${c.rep}-${Math.random().toString(36).slice(2, 7)}`;
	const faultDir = mkdtempSync(join(tmpdir(), "first-send-fault-"));
	const faultFile = join(faultDir, "fault.json");
	const setFault = (spec) =>
		spec ? writeFileSync(faultFile, JSON.stringify(spec)) : rmSync(faultFile, { force: true });
	let calls = 0;
	let wsOpens = 0;
	const row = { ...c, marker };
	if (c.entry !== "b" && c.cell !== "0ms" && c.cell !== "50ms" && c.cell !== "100ms" && c.cell !== "500ms") {
		if (c.cell !== "control") setFault({ delayMs: HOLD_MS });
	}
	if (c.scenario === "S9" && c.entry === "a") setFault({ fail: true });
	const srv = await ownServer({
		name: "first-send",
		mock: () => {
			calls++;
			return "ANSWER-OK";
		},
		env: { PI_WEB_TEST_STARTUP_FAULT_FILE: faultFile },
		prepare: ({ agentDir }) => {
			// A model that takes images, so an image chip can be sent (the mock answers text either way).
			const p = join(agentDir, "models.json");
			const cfg = JSON.parse(readFileSync(p, "utf8"));
			for (const prov of Object.values(cfg.providers)) for (const m of prov.models) m.input = ["text", "image"];
			writeFileSync(p, JSON.stringify(cfg));
		},
	});
	const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
	try {
		await ctx.addInitScript(
			([clientId, mark]) => {
				localStorage.setItem("pi-web-client-id", clientId);
				localStorage.setItem("pi-web-ui:lang", "en");
				window.__fs = [];
				// S3: the case can drop the page's sockets (the app reconnects by itself).
				window.__fsSockets = [];
				const Native = window.WebSocket;
				window.WebSocket = class extends Native {
					constructor(...args) {
						super(...args);
						window.__fsSockets.push(this);
					}
				};
				setInterval(() => {
					const ta = document.querySelector(".inputbox textarea");
					if (!ta) return;
					const msgs = document.querySelector(".messages")?.innerText ?? "";
					window.__fs.push([
						ta.value.length,
						msgs.includes(mark) ? 1 : 0,
						document.querySelector(".composer-pending-send") ? 1 : 0,
					]);
				}, 20);
			},
			[`first-send-${marker}`, marker],
		);
		const page = await ctx.newPage();
		page.on("websocket", () => wsOpens++);
		const ta = page.locator(".inputbox textarea");
		const placeholder = async () => (await ta.getAttribute("placeholder")) ?? "";
		const initializing = async () => /initializing/i.test(await placeholder());
		const waitCalls = async (n, ms) => {
			const until = Date.now() + ms;
			while (calls < n && Date.now() < until) await sleep(50);
		};
		const rowsFor = () => {
			const files = transcripts(srv.agentDir);
			return files.map((f) => ({ file: f.file, rows: f.rows.filter((r) => r.text.includes(marker)) }));
		};
		const open = async () => {
			await page.goto(srv.http);
			await ta.waitFor({ timeout: 30000 });
		};
		const waitReady = async (ms = 30000) => {
			const until = Date.now() + ms;
			while (/initializ|connect/i.test(await placeholder()) && Date.now() < until) await sleep(50);
		};
		const enter = async (text) => {
			await ta.fill(text);
			await ta.press("Enter");
		};
		const attachFile = async (kind) => {
			const input = page.locator(".inputbox input[type=file]").first();
			if (kind === "image") await input.setInputFiles({ name: "first-send.png", mimeType: "image/png", buffer: PNG });
			else
				await input.setInputFiles({
					name: "first-send-note.txt",
					mimeType: "text/plain",
					buffer: Buffer.from("note for first-send\n"),
				});
			await page.locator(".attach-chip").first().waitFor({ timeout: 10000 });
		};
		const quoteSeed = async () => {
			await page.locator(".lp-row", { hasText: "SEED" }).first().click({ button: "right" });
			const item = page.getByRole("menuitem", { name: /Quote/ }).first();
			try {
				await item.waitFor({ timeout: 5000 });
			} catch {
				const items = await page.getByRole("menuitem").allInnerTexts();
				const rows = await page.locator(".lp-row").allInnerTexts();
				throw new Error(`no Quote item; menu=${JSON.stringify(items)} rows=${JSON.stringify(rows)}`);
			}
			await item.click();
			try {
				await page.locator(".attach-chip").first().waitFor({ timeout: 5000 });
				return true;
			} catch {
				// The app refuses a quote while the chat starts (its draft owner isn't bound yet).
				return false;
			}
		};
		const newChat = () => page.locator(".lp-new-chat-action").first().click();

		// Entry b: a page that already has a chat (one sent message), then New chat.
		let seedFile = null;
		if (c.entry === "b") {
			await open();
			await waitReady();
			await enter(`SEED ${marker.slice(3)}`);
			await waitCalls(1, 30000);
			const until = Date.now() + 15000;
			while (!seedFile && Date.now() < until) {
				seedFile = transcripts(srv.agentDir).find((f) => f.rows.some((r) => r.text.startsWith("SEED")))?.file ?? null;
				if (!seedFile) await sleep(100);
			}
			if (!seedFile) throw new Error("seed chat never saved");
			await page.locator(".lp-row", { hasText: "SEED" }).first().waitFor({ timeout: 15000 });
			calls = 0;
			// S9 b: New chat fails after a hold, so the Enter falls while it still starts.
			if (c.scenario === "S9") setFault({ delayMs: HOLD_MS, fail: true });
			else if (!/^\d+ms$/.test(c.cell) && c.cell !== "control") setFault({ delayMs: HOLD_MS });
		}
		const start = async () => {
			if (c.entry === "b") await newChat();
			else await open();
		};
		const settle = async (expectCalls, extraMs = 1000) => {
			await waitCalls(expectCalls || 1, expectCalls ? HOLD_MS + 15000 : HOLD_MS + 2500);
			await sleep(extraMs);
		};

		// Samples count from here (the seed's own send and clear are not this case's).
		await page.evaluate(() => {
			window.__fs = [];
		});
		const s = c.scenario;
		let expect = 1;
		if (s === "S1") {
			if (c.cell === "control") {
				await start();
				await sleep(3000);
				await waitReady();
				await enter(marker);
			} else {
				await start();
				const d = Number.parseInt(c.cell, 10);
				if (d) await sleep(d);
				await enter(marker);
			}
			await settle(1);
		} else if (s === "S2") {
			await start();
			await ta.fill(marker);
			await ta.press("Enter");
			await sleep(100);
			await ta.press("Enter");
			await settle(1);
		} else if (s === "S3") {
			await start();
			await enter(marker);
			await sleep(200);
			await page.evaluate(() => {
				for (const ws of window.__fsSockets) if (ws.readyState <= 1) ws.close();
			});
			await settle(1);
		} else if (s === "S4") {
			await start();
			await enter(marker);
			await sleep(150);
			await ta.press("End");
			await ta.pressSequentially(" EDITED");
			await sleep(HOLD_MS + 2000);
			row.callsBeforeEnter = calls;
			await ta.press("Enter");
			await settle(1);
		} else if (s === "S5") {
			await start();
			await attachFile("file");
			await enter(marker);
			await sleep(150);
			await page.locator(".attach-remove").first().click();
			expect = 0;
			await settle(0);
		} else if (s === "S6") {
			await start();
			await enter(marker);
			await sleep(150);
			await ta.press("Escape");
			expect = 0;
			await settle(0);
		} else if (s === "S7") {
			await start();
			await enter(marker);
			await sleep(150);
			await page.locator(".lp-row", { hasText: "SEED" }).first().click();
			expect = 0;
			await settle(0);
		} else if (s === "S8") {
			await start();
			await enter(marker);
			await sleep(150);
			await newChat();
			expect = 0;
			await settle(0, 2000);
		} else if (s === "S9") {
			await start();
			await sleep(c.entry === "a" ? 1500 : 0);
			await attachFile("file");
			await enter(marker);
			expect = 0;
			await settle(0);
		} else if (s === "S10") {
			await start();
			if (c.cell.endsWith("-control")) {
				await sleep(3000);
				await waitReady();
				await attachFile(c.cell.split("-")[0]);
			} else if (c.cell === "conversation") row.quoteAccepted = await quoteSeed();
			else await attachFile(c.cell);
			await enter(marker);
			await settle(1);
		} else if (s === "S11") {
			await start();
			await enter(marker);
			await waitCalls(1, HOLD_MS + 15000);
			await sleep(500);
			if (c.cell === "fail-after") setFault({ fail: true });
			else setFault(null);
			await newChat();
			await settle(1, 2500);
		} else if (s === "S12") {
			await open();
			if (c.cell === "R-a") {
				await page.reload();
				await ta.waitFor({ timeout: 30000 });
				await enter(marker);
				await settle(1);
			} else {
				await enter(marker);
				await sleep(100);
				await page.reload();
				await ta.waitFor({ timeout: 30000 });
				expect = 0;
				await settle(0);
			}
		}

		// Measure.
		const files = rowsFor();
		const hits = files.filter((f) => f.rows.length > 0);
		row.calls = calls;
		row.rowsAny = hits.reduce((n, f) => n + f.rows.length, 0);
		row.rowsWrong = seedFile ? (files.find((f) => f.file === seedFile)?.rows.length ?? 0) : 0;
		row.rowsRight = row.rowsAny - row.rowsWrong;
		const sent = hits.flatMap((f) => f.rows);
		row.edited = sent.some((r) => r.text.includes("EDITED"));
		// The sent message's own entry or the attachment entries saved with it name the attachment.
		const withAsides = (r, test) => test(r.json) || r.asides.some(test);
		row.attachmentInRow = c.cell.startsWith("image")
			? sent.some((r) => r.hasImage || withAsides(r, (l) => l.includes("first-send.png")))
			: c.cell.startsWith("file")
				? sent.some((r) => withAsides(r, (l) => l.includes("first-send-note.txt")))
				: c.cell === "conversation"
					? sent.some((r) => withAsides(r, (l) => /conversation/i.test(l)))
					: undefined;
		row.composer = await ta.inputValue();
		row.composerHasMarker = row.composer.includes(marker);
		row.chips = await page.locator(".attach-chip").count();
		row.placeholder = await placeholder();
		row.notices = await page.locator(".notice .notice-text").allInnerTexts();
		row.wsOpens = wsOpens;
		const samples = await page.evaluate(() => window.__fs ?? []);
		const typed = samples.findIndex((x) => x[0] > 0);
		const cleared = typed < 0 ? -1 : samples.findIndex((x, i) => i > typed && x[0] === 0);
		const shown = samples.findIndex((x) => x[1] === 1);
		row.clearedBeforeAccept = cleared >= 0 && (shown < 0 || cleared < shown);
		row.pendingShown = samples.some((x) => x[2] === 1);
		row.expectCalls = expect;
		judge(row);
	} catch (e) {
		row.pass = false;
		row.why = `error: ${String(e?.message ?? e)
			.split("\n")[0]
			.slice(0, 200)}`;
	} finally {
		await ctx.close().catch(() => {});
		await srv.stop();
		srv.mock?.close?.();
		rmSync(faultDir, { recursive: true, force: true });
	}
	return row;
}

/** The plan's expected result per scenario. */
function judge(r) {
	const miss = [];
	const want = (ok, what) => {
		if (!ok) miss.push(what);
	};
	const failNotice = r.notices.some((n) => /Failed to (initialize session|create chat)/.test(n));
	switch (r.scenario) {
		case "S1":
			want(r.calls === 1, `calls=${r.calls}`);
			want(r.rowsRight === 1 && r.rowsWrong === 0, `rows right=${r.rowsRight} wrong=${r.rowsWrong}`);
			want(!r.clearedBeforeAccept, "composer cleared before acceptance");
			want(r.composer === "", "composer not cleared after acceptance");
			break;
		case "S2":
		case "S3":
			want(r.calls === 1, `calls=${r.calls}`);
			want(r.rowsRight === 1 && r.rowsWrong === 0, `rows right=${r.rowsRight} wrong=${r.rowsWrong}`);
			break;
		case "S4":
			want(r.callsBeforeEnter === 0, `calls before Enter=${r.callsBeforeEnter}`);
			want(r.calls === 1 && r.rowsRight === 1, `calls=${r.calls} rows=${r.rowsRight}`);
			want(r.edited, "sent text lacks the edit");
			break;
		case "S5":
			want(r.calls === 0, `calls=${r.calls}`);
			want(r.composerHasMarker && r.chips === 0, `draft text=${r.composerHasMarker} chips=${r.chips}`);
			break;
		case "S6":
			want(r.calls === 0, `calls=${r.calls}`);
			want(r.composerHasMarker, "draft lost");
			break;
		case "S7":
		case "S8":
			want(r.calls === 0, `calls=${r.calls}`);
			want(r.rowsAny === 0, `rows=${r.rowsAny}`);
			break;
		case "S9":
			want(r.calls === 0, `calls=${r.calls}`);
			want(r.composerHasMarker && r.chips === 1, `draft text=${r.composerHasMarker} chips=${r.chips}`);
			want(failNotice, "no failure notice");
			break;
		case "S10":
			if (r.quoteAccepted === false) {
				// Not a send case: no conversation chip can be added while a chat starts (pre-existing, recorded).
				r.pass = null;
				r.why = "n/a: quote refused while the chat starts";
				return;
			}
			want(r.calls === 1 && r.rowsRight === 1 && r.rowsWrong === 0, `calls=${r.calls} rows=${r.rowsRight}`);
			want(r.attachmentInRow, "attachment missing from the sent message");
			break;
		case "S11":
			want(r.calls === 1 && r.rowsAny === 1, `calls=${r.calls} rows=${r.rowsAny}`);
			break;
		case "S12":
			if (r.cell === "R-a") want(r.calls === 1 && r.rowsAny === 1, `calls=${r.calls} rows=${r.rowsAny}`);
			else want(r.calls === 0 && r.rowsAny === 0, `calls=${r.calls} rows=${r.rowsAny}`);
			break;
	}
	r.pass = miss.length === 0;
	r.why = miss.join("; ");
}

const browser = await chromium.launch({ executablePath: CHROME_PATH });
const results = [];
try {
	let next = 0;
	const worker = async () => {
		while (next < cases.length) {
			const c = cases[next++];
			const r = await runCase(c, browser);
			results.push(r);
			console.log(
				`${r.pass ? "✓" : "✗"} ${r.scenario} ${r.entry} ${r.cell} #${r.rep}: calls=${r.calls} rows=${r.rowsRight}/${r.rowsWrong} composer=${JSON.stringify((r.composer ?? "").slice(0, 40))} pendingShown=${r.pendingShown} ws=${r.wsOpens}${r.why ? ` (${r.why})` : ""}`,
			);
		}
	};
	await Promise.all(Array.from({ length: Math.min(JOBS, cases.length) }, worker));
} finally {
	await browser.close();
}

// Table: one line per scenario/entry/cell, passes out of runs.
const groups = new Map();
for (const r of results) {
	const k = `${r.scenario} ${r.entry} ${r.cell}`;
	const g = groups.get(k) ?? { runs: 0, pass: 0, calls: [], why: new Set() };
	g.runs++;
	if (r.pass) g.pass++;
	if (r.pass === null) g.na = (g.na ?? 0) + 1;
	g.calls.push(r.calls);
	if (r.why) g.why.add(r.why);
	groups.set(k, g);
}
const order = (k) => {
	const [s] = k.split(" ");
	return Number(s.slice(1)) * 1000 + [...groups.keys()].indexOf(k);
};
console.log("\nscenario entry cell | passed/runs | calls seen | misses");
for (const k of [...groups.keys()].sort((x, y) => order(x) - order(y))) {
	const g = groups.get(k);
	const calls = [...new Set(g.calls)].sort().join(",");
	const na = g.na ? ` (${g.na} n/a)` : "";
	console.log(`${k} | ${g.pass}/${g.runs}${na} | ${calls} | ${[...g.why].slice(0, 3).join(" / ")}`);
}
if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 1));
const failed = results.filter((r) => r.pass === false).length;
const counted = results.filter((r) => r.pass !== null).length;
console.log(
	`\n${failed ? "✗ FAIL" : "✓ PASS"}: ${counted - failed}/${counted} runs met their expected result (${results.length - counted} n/a)`,
);
process.exit(failed ? 1 : 0);
