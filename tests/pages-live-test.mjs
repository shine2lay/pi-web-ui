/**
 * pages-live E2E (Ops #244, H-PAGES-LIVE-2 in docs/pages-live.md; no tokens, no live data): the Roles page
 * after coming back to its tab.
 *
 * The test's own server (tests/lib/own-server.mjs) with one fixture role, and headless Chrome. Each run is
 * its own browser context behind its own small TCP proxy (so the test can cut that page's socket):
 *  1. Roles open and live ("Live · updated …").
 *  2. The tab is hidden and frozen (like a phone screen going off or a background tab), and its socket
 *     is cut while it is frozen (the close the connection log shows as 1006).
 *  3. After PAGES_LIVE_HIDDEN_MS (60 s), the tab is resumed and shown. From then on the page is sampled
 *     every 100 ms: the status pill's words and colour, the app's "Reconnecting…" note, and whether the
 *     owner's asks still say "unknown".
 * Measured: time to fresh data on screen (the pill says Live again), and whether a red or amber pill or the
 * note showed first. Runs start PAGES_LIVE_STAGGER_MS apart and overlap, so 10 take about 2.5 minutes.
 *
 * Checks: every run fresh within 8 s; p90 within 3 s; no red or amber pill and no note in a run that was
 * fresh within 8 s; the owner's asks never shown as known before the pill is Live; the connection log's
 * records of these returns carry view "roles" and shownMs.
 * On code without pages-live (the control), the pill turns red at once and stays unconfirmed until the
 * server's 30 s heartbeat, and the log has no view or shownMs.
 *
 * Usage: npm run build && node tests/run-sealed.mjs --no-build pages-live-test
 *   PAGES_LIVE_OUT=<file.jsonl>: also write each run's numbers there.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";
import { reconnectingShown } from "./lib/phone-checks.mjs";

const RUNS = Number(process.env.PAGES_LIVE_RUNS ?? 10);
const HIDDEN_MS = Number(process.env.PAGES_LIVE_HIDDEN_MS ?? 60_000);
const STAGGER_MS = Number(process.env.PAGES_LIVE_STAGGER_MS ?? 7_000);
/** How long after coming back a run keeps looking (past the server's 30 s heartbeat, for the control). */
const WINDOW_MS = 40_000;
const GRACE_MS = 8_000;
const OUT = process.env.PAGES_LIVE_OUT;

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}
async function until(fn, ms, every = 200) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const v = await fn();
		if (v) return v;
		await sleep(every);
	}
	return null;
}
/** Nearest-rank percentile. */
function pct(values, p) {
	const s = [...values].sort((a, b) => a - b);
	return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null;
}

if (!CHROME_PATH) {
	console.log("FAIL no Chrome for the test (set PI_WEB_CHROME)");
	process.exit(1);
}

let identities;
let work;
function seed({ root, agentDir, workdir }) {
	const sessions = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(sessions, { recursive: true });
	const home = join(sessions, "2026-10-18T12-00-00-000Z_01a0f000-0000-7000-8000-000000000001.jsonl");
	const at = new Date().toISOString();
	const lines = [
		{ type: "session", version: 3, id: "01a0f000-0000-7000-8000-000000000001", timestamp: at, cwd: workdir },
		{ type: "model_change", id: "f1", parentId: null, timestamp: at, provider: "mock", modelId: "mock-model" },
	];
	writeFileSync(home, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	identities = join(root, "identities");
	work = join(agentDir, "work");
	mkdirSync(work, { recursive: true });
	mkdirSync(join(identities, "ops"), { recursive: true });
	writeFileSync(
		join(identities, "ops", "identity.json"),
		JSON.stringify({ id: "ops", title: "Fixture Ops", homeChat: home }),
	);
	writeFileSync(join(identities, "ops", "about.md"), "# Fixture Ops\n");
	writeFileSync(join(identities, "ops", "notebook.md"), "");
}

/** A plain TCP proxy whose open connections the test can cut, like a network dropping them, and which can
 *  refuse new ones meanwhile (no network: the hidden page can't reconnect). */
async function cutLink(target) {
	const pairs = new Set();
	let refusing = false;
	const server = createServer((client) => {
		if (refusing) {
			client.destroy();
			return;
		}
		const up = connect(target, "127.0.0.1");
		const pair = { client, up };
		pairs.add(pair);
		const drop = () => {
			client.destroy();
			up.destroy();
			pairs.delete(pair);
		};
		for (const s of [client, up]) {
			s.on("error", drop);
			s.on("close", drop);
		}
		client.pipe(up);
		up.pipe(client);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		http: `http://127.0.0.1:${port}`,
		refuse(on) {
			refusing = on;
		},
		cut() {
			for (const p of [...pairs]) {
				p.client.destroy();
				p.up.destroy();
			}
			pairs.clear();
		},
		close: () =>
			new Promise((resolve) => {
				for (const p of pairs) {
					p.client.destroy();
					p.up.destroy();
				}
				server.close(() => resolve());
			}),
	};
}

/** The pill's words and colour and whether the asks say unknown (read from the host; the frame runs no script). */
function look(page) {
	return page.evaluate(() => {
		const doc = document.querySelector('iframe[title="Roles"]')?.contentDocument;
		const el = doc?.querySelector('header [role="status"]');
		const body = doc?.body?.innerText ?? "";
		return {
			text: el?.textContent ?? null,
			color: el?.style.color ?? "",
			unknown: /current (?:total|asks)[^\n]*unknown/i.test(body),
		};
	});
}
const RED = /255,\s*138,\s*128|#ff8a80/i;
const AMBER = /240,\s*185,\s*90|#f0b95a/i;
const live = (s) => typeof s?.text === "string" && s.text.startsWith("Live ·");

async function setHidden(page, hidden) {
	await page.evaluate((h) => {
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
		Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
		document.dispatchEvent(new Event("visibilitychange"));
	}, hidden);
}

const srv = await ownServer({
	name: "pages-live",
	prepare: seed,
	mock: () => "unused",
	env: {
		PI_WEB_TOKEN: "",
		PI_IDENTITY_REINDEX: "0",
		get PI_IDENTITY_DIR() {
			return identities;
		},
		get PI_WORK_DIR() {
			return work;
		},
	},
});
const LOG = join(srv.dataDir, "conn-events.jsonl");
const logLines = () =>
	existsSync(LOG)
		? readFileSync(LOG, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];

const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
let pageErrors = 0;

async function oneRun(i) {
	await sleep(i * STAGGER_MS);
	const link = await cutLink(srv.port);
	const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "en-US" });
	await context.addInitScript(() => localStorage.setItem("pi-web-ui:lang", "en"));
	const page = await context.newPage();
	page.on("pageerror", (err) => {
		// The app's own errors (our code), first line only, the first few.
		if (pageErrors++ < 3)
			console.log(
				`page error run ${i}: ${String(err?.message ?? err)
					.split("\n")[0]
					.slice(0, 300)}`,
			);
	});
	const cdp = await context.newCDPSession(page);
	// Each socket: when it opened, the checkedAt of its first overview, and when a newer check reached it (the
	// page's own rule for current data: roles-state lookedAgain). Only these numbers are kept from a frame.
	const sockets = [];
	page.on("websocket", (ws) => {
		const s = { openedAt: Date.now(), firstAt: null, confirmedAt: null, closedAt: null, port: new URL(ws.url()).port };
		sockets.push(s);
		ws.on("close", () => {
			s.closedAt = Date.now();
		});
		ws.on("framereceived", ({ payload }) => {
			if (typeof payload !== "string" || !payload.startsWith('{"type":"roles"')) return;
			let m;
			try {
				m = JSON.parse(payload);
			} catch {
				return;
			}
			const at = typeof m.checkedAt === "number" ? m.checkedAt : m.overview?.at;
			if (typeof at !== "number") return;
			if (s.firstAt === null) {
				if (m.overview) s.firstAt = at;
			} else if (at > s.firstAt && s.confirmedAt === null) s.confirmedAt = Date.now();
		});
	});
	try {
		await page.goto(`${link.http}/?view=roles`);
		const ready = await until(async () => live(await look(page)), 90_000);
		if (!ready) return { run: i, error: `never live before hiding (pill: ${(await look(page)).text})` };
		await sleep(2_000);
		await setHidden(page, true);
		// Frozen where Chrome honours it (headless may keep running timers); either way the socket is cut and
		// no new one can open until just before the tab comes back.
		await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
		link.refuse(true);
		link.cut();
		await sleep(HIDDEN_MS);
		link.refuse(false);
		const back = Date.now();
		await cdp.send("Page.setWebLifecycleState", { state: "active" });
		const t0 = Date.now();
		await setHidden(page, false);
		const seen = [];
		let freshMs = null;
		let alarm = null;
		let note = false;
		let falseAllClear = false;
		// Until the page notices the cut socket, it still shows its screen from before (Live): measured, not judged.
		let oldLiveMs = null;
		let noticed = false;
		while (Date.now() - t0 < WINDOW_MS) {
			const s = await look(page);
			const ms = Date.now() - t0;
			const n = await reconnectingShown(page);
			if (n && process.env.PAGES_LIVE_DEBUG && note === false)
				console.log(
					`debug note run ${i}: ${await page.evaluate(() => {
						const out = [];
						for (const el of document.querySelectorAll("body *")) {
							if (el.children.length || !/Reconnecting|Connecting/i.test(el.textContent || "")) continue;
							const r = el.getBoundingClientRect();
							if (r.width > 0 && r.height > 0)
								out.push(`${el.tagName}.${el.className} "${el.textContent}" parent ${el.parentElement?.className}`);
						}
						return out.join(" | ");
					})}`,
				);
			if (!seen.includes(s.text)) seen.push(s.text);
			const confirmed = sockets.some((k) => k.openedAt >= back && k.confirmedAt !== null);
			if (live(s) && confirmed) {
				freshMs = ms;
				break;
			}
			if (live(s) && !noticed) oldLiveMs = ms;
			else noticed = true;
			if (!alarm && (RED.test(s.color) || AMBER.test(s.color))) alarm = { ms, text: s.text };
			if (n && !note) note = ms;
			if (!live(s) && !s.unknown) falseAllClear = true;
			await sleep(100);
		}
		const next = sockets.find((k) => k.openedAt >= back && k.firstAt !== null);
		if (process.env.PAGES_LIVE_DEBUG)
			console.log(
				`debug run ${i}: link ${link.http}; sockets ${JSON.stringify(sockets.map((k) => ({ ...k, openedAt: k.openedAt - t0, closedAt: k.closedAt && k.closedAt - t0 })))}`,
			);
		// Let the page finish the episode and send its trace record before the context goes.
		await sleep(4_000);
		return {
			run: i,
			freshMs,
			newSocketMs: next ? next.openedAt - t0 : null,
			confirmedMs: next?.confirmedAt ? next.confirmedAt - t0 : null,
			oldLiveMs,
			alarm,
			noteMs: note === false ? null : note,
			falseAllClear,
			seen,
		};
	} catch (err) {
		return { run: i, error: String(err?.message ?? err) };
	} finally {
		await context.close().catch(() => {});
		await link.close();
	}
}

let results = [];
try {
	results = await Promise.all(Array.from({ length: RUNS }, (_, i) => oneRun(i)));
	for (const r of results) {
		console.log(`run ${r.run}: ${JSON.stringify(r)}`);
		if (OUT) appendFileSync(OUT, `${JSON.stringify({ at: new Date().toISOString(), hiddenMs: HIDDEN_MS, ...r })}\n`);
	}
	const ok = results.filter((r) => !r.error);
	check("every run was live before it was hidden", ok.length === RUNS, `${ok.length} of ${RUNS}`);
	const fresh = ok.map((r) => (r.freshMs === null ? Infinity : r.freshMs));
	const summary = {
		runs: ok.length,
		p50: pct(fresh, 50),
		p90: pct(fresh, 90),
		max: pct(fresh, 100),
		alarms: ok.filter((r) => r.alarm).length,
		notes: ok.filter((r) => r.noteMs !== null).length,
	};
	console.log(`summary: ${JSON.stringify(summary)}`);
	if (OUT) appendFileSync(OUT, `${JSON.stringify({ summary, hiddenMs: HIDDEN_MS })}\n`);
	check(
		"every run shows fresh Roles data within 8 s of coming back",
		ok.length > 0 && fresh.every((ms) => ms <= GRACE_MS),
		`fresh after ${fresh.map((ms) => (ms === Infinity ? "never" : `${ms} ms`)).join(", ")}`,
	);
	check("fresh Roles data within 3 s p90", summary.p90 !== null && summary.p90 <= 3_000, `p90 ${summary.p90} ms`);
	const calmWhenFresh = ok.filter((r) => r.freshMs !== null && r.freshMs <= GRACE_MS);
	check(
		"no red or amber pill and no Reconnecting note before fresh data came back within 8 s",
		calmWhenFresh.length > 0 && calmWhenFresh.every((r) => !r.alarm && r.noteMs === null),
		calmWhenFresh
			.filter((r) => r.alarm || r.noteMs !== null)
			.map((r) => `run ${r.run}: ${r.alarm ? `"${r.alarm.text}" at ${r.alarm.ms} ms` : ""} ${r.noteMs ?? ""}`)
			.join("; "),
	);
	check(
		"the owner's asks are never shown as known while the pill isn't Live",
		ok.every((r) => !r.falseAllClear),
		ok
			.filter((r) => r.falseAllClear)
			.map((r) => `run ${r.run}`)
			.join(", "),
	);
	// The trace: each return leaves a record whose episode ended on the Roles view, with shownMs.
	await sleep(3_000);
	const banners = logLines().filter((l) => l.kind === "banner");
	const roles = banners.filter((l) => l.view === "roles" && typeof l.shownMs === "number" && l.endVisible === true);
	check(
		"the connection log records each return with view roles and shownMs",
		roles.length >= ok.length,
		`${roles.length} of ${banners.length} records (${banners.map((l) => `${l.reason}/${l.view ?? "-"}`).join(", ")}); shownMs ${roles.map((l) => l.shownMs).join(", ")}`,
	);
	// The cut socket's close is the cause on record (the connection log's evidence depends on it).
	check(
		"each of those records keeps its cause: the socket's close",
		roles.length > 0 && roles.every((l) => l.reason === "close"),
		roles.map((l) => `${l.reason}${l.closeCode ? ` ${l.closeCode}` : ""}`).join(", "),
	);
	if (OUT)
		appendFileSync(
			OUT,
			`${JSON.stringify({ trace: roles.map((l) => ({ reason: l.reason, durMs: l.durMs, shownMs: l.shownMs })) })}\n`,
		);
	check("no page errors", pageErrors === 0, `${pageErrors}`);
} catch (err) {
	console.log(`FAIL the test broke: ${err?.stack ?? err}`);
	failures++;
} finally {
	await browser.close().catch(() => {});
	await srv.stop();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
