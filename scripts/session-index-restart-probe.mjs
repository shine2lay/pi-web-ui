#!/usr/bin/env node
/* session-index: how fast History and Recent chats come back after a pi-web-ui restart, measured live.
 * Prints counts and times only — never a title, a first message or any chat content.
 *
 * Start it OUTSIDE pi-web-ui's service (a restart would stop it otherwise), before the restart:
 *   systemd-run --user --unit=session-index-probe --same-dir --collect \
 *     node scripts/session-index-restart-probe.mjs [--ws ws://127.0.0.1:8787/ws] [--wait-min 90]
 * then restart (pi-web-deploy). Results: `journalctl --user -u session-index-probe` and
 * ~/.cache/pi/session-index-probe/result.txt.
 *
 * It connects like a page (a websocket, hello, then list_sessions as the page's panel asks), notes how many
 * History rows the server sends, waits for the restart to close the connection, reconnects as soon as the
 * server listens again, and times the reconnect → the full list (as many rows as before the restart).
 * Its client id is a carry-on one (like pi-web-deploy's checks): it starts on a blank chat, takes over no
 * window's chat and doesn't wait at the carry-on gate (which a real window does, while the cut-off chats
 * reopen: that wait is not the list's). Then it reads the server's own count of chat files read in full. */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : dflt;
};
const WS = opt("--ws", "ws://127.0.0.1:8787/ws");
const WAIT_MIN = Number(opt("--wait-min", "90"));
const UNIT = opt("--server-unit", "pi-web-ui.service");
const CLIENT_ID = "carry-on:session-index-probe";
const LIMIT_S = 2;
const outDir = join(homedir(), ".cache", "pi", "session-index-probe");
mkdirSync(outDir, { recursive: true });
const lines = [];
const say = (s) => {
	const line = `${new Date().toISOString()} ${s}`;
	lines.push(line);
	console.log(line);
	writeFileSync(join(outDir, "result.txt"), `${lines.join("\n")}\n`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open a socket, say hello like the page, ask for the list. Resolves once open (or rejects). */
function connect(onRows, onClose) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(WS);
		let opened = false;
		ws.addEventListener("open", () => {
			opened = true;
			const at = performance.now();
			ws.send(JSON.stringify({ type: "hello", clientId: CLIENT_ID, locale: "en" }));
			ws.send(JSON.stringify({ type: "list_sessions" }));
			resolve({ ws, at });
		});
		ws.addEventListener("message", (ev) => {
			let m;
			try {
				m = JSON.parse(String(ev.data));
			} catch {
				return;
			}
			if (m.type === "sessions" && Array.isArray(m.sessions)) onRows(m.sessions.length, performance.now());
		});
		ws.addEventListener("close", () => {
			if (!opened) reject(new Error("closed before opening"));
			else onClose(performance.now());
		});
		ws.addEventListener("error", () => {
			if (!opened) reject(new Error("can't connect"));
		});
	});
}

// 1. Before the restart: how many rows the full list has.
let before = 0;
let closedAt = null;
const first = await connect(
	(n) => {
		before = Math.max(before, n);
	},
	(t) => {
		closedAt = t;
	},
);
for (let i = 0; i < 300 && before === 0; i++) await sleep(100);
if (before === 0) {
	say("FAIL: no list from the server before the restart");
	process.exit(1);
}
say(`before the restart: History has ${before} rows; waiting up to ${WAIT_MIN} min for the restart`);
const waitedFrom = Date.now();
while (closedAt === null) {
	if (Date.now() - waitedFrom > WAIT_MIN * 60_000) {
		say("FAIL: no restart came");
		first.ws.close();
		process.exit(1);
	}
	await sleep(200);
}
const restartWall = new Date();
say("the connection closed (restart)");

// 2. Reconnect as soon as the server listens again; time the reconnect → the full list.
let full = null;
let firstRows = null;
let again = null;
while (!again) {
	try {
		again = await connect(
			(n, t) => {
				if (firstRows === null) firstRows = { n, t };
				if (full === null && n >= before) full = { n, t };
			},
			() => {},
		);
	} catch {
		await sleep(100);
		if (performance.now() - closedAt > 10 * 60_000) {
			say("FAIL: the server didn't come back within 10 min");
			process.exit(1);
		}
	}
}
say(`reconnected ${((again.at - closedAt) / 1000).toFixed(1)} s after the connection closed`);
const t0 = again.at;
while (full === null && performance.now() - t0 < 60_000) await sleep(20);
let ok = false;
if (full) {
	const s = (full.t - t0) / 1000;
	ok = s <= LIMIT_S;
	say(
		`${ok ? "OK" : "SLOW"}: the full list (${full.n} rows) came ${s.toFixed(2)} s after reconnecting (limit ${LIMIT_S} s)`,
	);
} else {
	say(`FAIL: no full list within 60 s (first list: ${firstRows ? `${firstRows.n} rows` : "none"})`);
}
again.ws.close();

// 3. The server's own count: how its first listing after the start went (counts only).
await sleep(1000);
try {
	// Epoch seconds ("@<s>"): an ISO time without a zone would be read as local time.
	const since = `@${Math.floor((restartWall.getTime() - 5000) / 1000)}`;
	const log = execFileSync("journalctl", ["--user", "-u", UNIT, "--since", since, "-o", "cat", "--no-pager"], {
		encoding: "utf8",
		maxBuffer: 64 << 20,
	});
	const line = log.split("\n").find((l) => l.includes("[session-index] first listing"));
	const m = line?.match(/(\d+) read in full/);
	say(line ? `server: ${line.slice(line.indexOf("[session-index]"))}` : "server: no first-listing line found");
	if (m) say(`chat files read in full by the restarted server: ${m[1]}`);
} catch (e) {
	say(`server log not readable: ${e.message}`);
}
process.exit(ok ? 0 : 1);
