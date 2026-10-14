/**
 * reconnect-trace E2E (no tokens, nothing sent to Telegram; Ops #157): each "Reconnecting…" episode
 * leaves a record in the server's connection log (<data>/conn-events.jsonl), matched to the server's
 * own measurements.
 *
 * The test's own server (tests/lib/own-server.mjs; no plugins, so no notice can leave it) and a
 * desktop page in headless Chrome. Checks:
 *  1. The page's own connect is logged (an "open" line for a browser socket), and so are the
 *     server's event-loop samples.
 *  2. A stalled server (SIGSTOP for 7 s, then SIGCONT: like a main thread busy for 7 s, the socket
 *     stays open): "Reconnecting…" shows; once the page is back, the log holds its record of it (a
 *     silence cause), placed on the server's clock over the stall, with a measured event-loop delay of
 *     at least 6 s; the socket the page dropped is logged closed with its close code; with no explicit
 *     notice opt-in it stays silent; the stall watcher writes the stall whole.
 *     (The 7 s SIGSTOP is also covered by the event-loop histogram, so it can't show the histogram's
 *     hole; tests/unit/conn-events.test.ts "real timers" does, with its control.)
 *  3. A server restart (the socket is closed under the page): the page's record has the close code,
 *     and the new server marks the episode as begun before it started.
 *  4. Metadata only: every string in every line is a fixed kind, an id, a hash or a cause.
 *  5. The off switch (<data>/conn-trace.json {"enabled": false}): another stall (13 s, past the
 *     page's doubled patience) shows the note but leaves nothing in the log.
 *  6. Runtime master-off -> silent capture sends a flag to the existing socket (no reconnect),
 *     resumes bounded sampling and still never submits a notice.
 * On code without the capture (the control), checks 1-3 fail: no log is written.
 *
 * Usage: npm run build && scripts/sealed.sh node tests/reconnect-trace-test.mjs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";
import { reconnectingShown } from "./lib/phone-checks.mjs";

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}

/** Wait until fn() gives something truthy (returned), or null after ms. */
async function until(fn, ms, every = 200) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const v = await fn();
		if (v) return v;
		await sleep(every);
	}
	return null;
}

if (!CHROME_PATH) {
	console.log("FAIL no Chrome for the test (set PI_WEB_CHROME)");
	process.exit(1);
}

const srv = await ownServer({ name: "reconnect-trace" });
const LOG = join(srv.dataDir, "conn-events.jsonl");
const lines = () =>
	existsSync(LOG)
		? readFileSync(LOG, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];

/** Stop the server for ms (SIGSTOP, then SIGCONT), watching for the note meanwhile. */
async function stall(page, ms) {
	const pid = srv.pid();
	const t0 = Date.now();
	let shown = false;
	process.kill(pid, "SIGSTOP");
	try {
		while (Date.now() - t0 < ms) {
			if (await reconnectingShown(page)) shown = true;
			await sleep(250);
		}
	} finally {
		process.kill(pid, "SIGCONT");
	}
	return { t0, t1: Date.now(), shown };
}

const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
try {
	const page = await (await browser.newContext()).newPage();
	const captureFlags = [];
	let socketCount = 0;
	page.on("websocket", (socket) => {
		socketCount++;
		socket.on("framereceived", ({ payload }) => {
			try {
				const msg = JSON.parse(String(payload));
				if (msg.type === "conn_trace_config" && typeof msg.on === "boolean") captureFlags.push(msg.on);
			} catch {
				/* only this boolean-only metadata frame is retained */
			}
		});
	});
	await page.goto(srv.http);

	// 1. The page's own connect, and the loop samples.
	const open = await until(() => lines().find((l) => l.kind === "open" && l.browser === true), 30_000);
	check(
		"the page's own connect is logged",
		!!open,
		open ? `socket ${open.conn}, hello after ${open.helloMs} ms` : "no open line",
	);
	const loop = await until(() => lines().find((l) => l.kind === "loop"), 15_000);
	check(
		"the server logs its event-loop delay every 10 s",
		!!loop && typeof loop.maxMs === "number" && typeof loop.p99Ms === "number",
		loop
			? `window ${loop.windowMs} ms, p99 ${loop.p99Ms} ms, max ${loop.maxMs} ms, cpu ${loop.cpuMs} ms`
			: "no loop line",
	);
	const calm = await until(async () => !(await reconnectingShown(page)), 15_000);
	check("the page is connected before the stall", !!calm);
	await sleep(3_000);

	// 2. A 7 s stall: the socket stays open, no frames come.
	const s = await stall(page, 7_000);
	check('"Reconnecting…" shows while the server is stalled', s.shown);
	const b = await until(() => lines().find((l) => l.kind === "banner" && !l.srvRestart), 30_000);
	check("the page's record of it reaches the log", !!b, b ? `cause ${b.reason}, ${b.durMs} ms` : "no banner line");
	if (b) {
		check(
			"its cause is the silence (no frames for 5 s or more)",
			["silence", "probe"].includes(b.reason) && b.quietMs >= 4_500,
			`reason ${b.reason}, quiet ${b.quietMs} ms, allowed ${b.allowedMs} ms`,
		);
		check(
			"it is placed on the server's clock over the stall",
			b.srvStart >= s.t0 - 2_500 && b.srvStart <= s.t1 + 500 && b.srvEnd >= s.t1 - 500,
			`stall ${s.t0}..${s.t1}, episode ${b.srvStart}..${b.srvEnd}`,
		);
		check(
			"the server measured an event-loop delay of at least 6 s over it",
			typeof b.loopMaxMs === "number" && b.loopMaxMs >= 6_000,
			`loopMaxMs ${b.loopMaxMs}, from ${b.loopSamples} sample(s)`,
		);
		const st = lines().find((l) => l.kind === "stall" && l.ms >= 6_000 && l.from <= s.t1 && l.t >= s.t0);
		check(
			"the stall watcher wrote the stall whole (at least 6 s, over the stop), and the record carries it",
			!!st && typeof b.stallMaxMs === "number" && b.stallMaxMs >= 6_000,
			st ? `stall ${st.ms} ms from ${st.from} to ${st.t}; record stallMaxMs ${b.stallMaxMs}` : "no stall line over it",
		);
		const dropped = await until(() => lines().find((l) => l.kind === "close" && l.conn === b.conn), 10_000);
		check(
			"the socket the page dropped is logged closed, with its close code",
			!!dropped && Number.isInteger(dropped.code),
			dropped ? `code ${dropped.code}, lived ${dropped.livedMs} ms` : `no close line for ${b.conn}`,
		);
		check(
			"missing notice opt-in is silent while the real episode is captured",
			!lines().some((l) => l.kind === "notice"),
			"no notice submission",
		);
	}

	// 3. A restart closes the socket under the page.
	await until(async () => !(await reconnectingShown(page)), 15_000);
	await sleep(2_000);
	await srv.restart();
	const r = await until(() => lines().find((l) => l.kind === "banner" && l.srvRestart), 30_000);
	check(
		"a restart's close is recorded with its close code, as begun before the new server",
		!!r && r.reason === "close" && Number.isInteger(r.closeCode),
		r
			? `reason ${r.reason}, code ${r.closeCode}, ${r.durMs} ms, then ${r.then ?? "-"}`
			: "no banner line after the restart",
	);

	// 4. Metadata only.
	const allowed = {
		kind: /^(loop|open|close|banner|notice|stall)$/,
		conn: /^[a-f0-9]{12}$/,
		via: /^[a-f0-9]{12}$/,
		client: /^[a-f0-9]{12}$/,
		ep: /^[a-z0-9]{8,32}$/,
		reason: /^[a-z_]+$/,
		then: /^[a-z_]+$/,
		id: /^cn-[a-f0-9]{16}$/,
		notice: /^(event|summary)$/,
	};
	const all = lines();
	const odd = [];
	for (const l of all)
		for (const [k, v] of Object.entries(l)) {
			if (v === null || typeof v === "number" || typeof v === "boolean") continue;
			if (typeof v !== "string" || !allowed[k]?.test(v)) odd.push(`${l.kind}.${k}`);
		}
	check(
		"every line holds metadata only",
		all.length > 0 && odd.length === 0,
		`${all.length} lines${odd.length ? `; odd: ${odd.join(", ")}` : ""}`,
	);

	// 5. The off switch.
	await until(async () => !(await reconnectingShown(page)), 15_000);
	writeFileSync(join(srv.dataDir, "conn-trace.json"), JSON.stringify({ enabled: false }));
	await sleep(11_000); // the switch is read every 3 s, the sampler looks every 10 s
	check("master-off reaches the existing page as a capture-only flag", captureFlags.at(-1) === false);
	const before = lines().length;
	// 13 s: the first stall doubled the page's patience (conn-health: 10 s of silence allowed now).
	const s2 = await stall(page, 13_000);
	await until(async () => !(await reconnectingShown(page)), 30_000);
	await sleep(5_000);
	const after = lines().length;
	check(
		"switched off, another stall leaves nothing (no record, no socket or loop lines)",
		s2.shown && after === before,
		`note shown ${s2.shown}, lines ${before} -> ${after}`,
	);

	// 6. Restore tracking silently, on the socket that connected while master-off.
	const socketsBeforeRestore = socketCount;
	const loopsBeforeRestore = lines().filter((l) => l.kind === "loop").length;
	writeFileSync(join(srv.dataDir, "conn-trace.json"), JSON.stringify({ enabled: true, notices: false }));
	await until(() => captureFlags.at(-1) === true, 10_000);
	await until(() => lines().filter((l) => l.kind === "loop").length > loopsBeforeRestore, 25_000);
	check(
		"silent capture flag reaches the same socket without a reconnect",
		captureFlags.at(-1) === true && socketCount === socketsBeforeRestore,
		`flag ${captureFlags.at(-1)}, sockets ${socketsBeforeRestore} -> ${socketCount}`,
	);
	check(
		"silent runtime capture resumes sampling without notice submissions",
		lines().filter((l) => l.kind === "loop").length > loopsBeforeRestore && !lines().some((l) => l.kind === "notice"),
	);
} catch (err) {
	console.log(`FAIL the test broke: ${err?.stack ?? err}`);
	failures++;
} finally {
	await browser.close().catch(() => {});
	await srv.stop();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
