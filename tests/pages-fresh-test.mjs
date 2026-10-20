/**
 * pages-fresh E2E (Ops #245, H-PAGES-FRESH-1 in docs/pages-fresh.md; no tokens, no live data): the Roles and
 * Initiatives pages answered at once from the copy the server keeps fresh in the background.
 *
 * The test's own server (tests/lib/own-server.mjs) with one fixture role and one fixture initiative, and
 * headless Chrome. It waits for the server's first background round (PAGES_FRESH_MS after its start), then:
 *  1. Opens: each page is opened OPENS times, one after the other, each in its own browser context (no window
 *     watches in between, so only the refresher keeps the copies fresh), all with one window id. Measured: the
 *     first data on the page's socket (Roles: its first overview; Initiatives: both its work page and its
 *     decisions page), from the page's watch and from navigation start, and how old the overview and the work
 *     page were when their watch was sent. The server's own loop records (its CPU, loop delay, the machine's
 *     load) are printed beside them.
 *  2. Tab return: the Initiatives page open and current; the tab hidden and frozen, its socket cut, for
 *     HIDDEN_MS (60 s); then shown, and sampled every 100 ms: fresh data (a new socket's work page and
 *     decisions page both arrived), the app's "Reconnecting…" note, and the initiative still on screen. Runs
 *     start STAGGER_MS apart and overlap.
 *
 * Checks: first data within 1 s p90 of the page's watch, per page (from navigation start it is printed, not
 * checked: the page's own load and socket come before the watch, and they are as slow as the machine is busy,
 * with or without pages-fresh; docs/pages-fresh.md); every work page answered from a page made before its watch and
 * at most COPY_MAX_MS old, and every first overview at most COPY_MAX_MS old; on return, fresh within 3 s p90
 * and within 8 s each, no note before that, the page never blank meanwhile, and the connection log records
 * each return with view "initiatives" and shownMs.
 * Without pages-fresh a work-page watch was answered by a look made after it (work-page.ts kept no page), so
 * there the copy check fails.
 *
 * Usage: npm run build && node tests/run-sealed.mjs --no-build pages-fresh-test
 *   PAGES_FRESH_OUT=<file.jsonl>: also write each open's and each return's numbers there.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";
import { reconnectingShown } from "./lib/phone-checks.mjs";

/** server/pages-fresh.ts PAGES_FRESH_MS: the first round runs this long after the server starts. */
const PAGES_FRESH_MS = 15_000;
const OPENS = Number(process.env.PAGES_FRESH_OPENS ?? 10);
const RUNS = Number(process.env.PAGES_FRESH_RUNS ?? 10);
const HIDDEN_MS = Number(process.env.PAGES_FRESH_HIDDEN_MS ?? 60_000);
const STAGGER_MS = Number(process.env.PAGES_FRESH_STAGGER_MS ?? 7_000);
/** One round's age plus slack: a kept copy is never older than this when the refresher runs. */
const COPY_MAX_MS = 20_000;
const FIRST_DATA_P90_MS = 1_000;
const FRESH_P90_MS = 3_000;
const GRACE_MS = 8_000;
const WINDOW_MS = 20_000;
const OUT = process.env.PAGES_FRESH_OUT;
const INITIATIVE = "Fixture plan";

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}
async function until(fn, ms, every = 100) {
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
const out = (o) => OUT && appendFileSync(OUT, `${JSON.stringify({ at: new Date().toISOString(), ...o })}\n`);

if (!CHROME_PATH) {
	console.log("FAIL no Chrome for the test (set PI_WEB_CHROME)");
	process.exit(1);
}

let identities;
let work;
function seed({ root, agentDir, workdir }) {
	const sessions = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(sessions, { recursive: true });
	const home = join(sessions, "2026-10-19T12-00-00-000Z_01a0f000-0000-7000-8000-000000000002.jsonl");
	const at = new Date().toISOString();
	const lines = [
		{ type: "session", version: 3, id: "01a0f000-0000-7000-8000-000000000002", timestamp: at, cwd: workdir },
		{ type: "model_change", id: "f1", parentId: null, timestamp: at, provider: "mock", modelId: "mock-model" },
	];
	writeFileSync(home, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	identities = join(root, "identities");
	work = join(agentDir, "work");
	mkdirSync(work, { recursive: true });
	const ts = Date.now() - 3_600_000;
	writeFileSync(
		join(work, "events.jsonl"),
		`${JSON.stringify({
			v: 1,
			seq: 1,
			ts,
			by: "owner",
			op: "initiative.create",
			id: "fixture-plan",
			name: INITIATIVE,
			outcome: "Pages open at once",
			doneWhen: ["First data within 1 s"],
			lead: "ops",
		})}\n`,
	);
	mkdirSync(join(identities, "ops"), { recursive: true });
	writeFileSync(
		join(identities, "ops", "identity.json"),
		JSON.stringify({ id: "ops", title: "Fixture Ops", homeChat: home }),
	);
	writeFileSync(join(identities, "ops", "about.md"), "# Fixture Ops\n");
	writeFileSync(join(identities, "ops", "notebook.md"), "");
}

/** A plain TCP proxy whose open connections the test can cut, and which can refuse new ones meanwhile. */
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

/** The frame's type, read from its start (only these frames are parsed). */
function typeOf(payload) {
	if (typeof payload !== "string" || !payload.startsWith('{"type":"')) return null;
	const end = payload.indexOf('"', 9);
	return end > 9 ? payload.slice(9, end) : null;
}

/** Each socket of a page: when it opened, when each watch was first sent, and when each page's data first
 *  came, with the time the server made it. Only these numbers are kept from a frame. */
function trackSockets(page) {
	const sockets = [];
	page.on("websocket", (ws) => {
		const s = { openedAt: Date.now(), sent: {}, got: {} };
		sockets.push(s);
		ws.on("framesent", ({ payload }) => {
			const type = typeOf(payload);
			if (type?.endsWith("_watch") && !(type in s.sent)) s.sent[type] = Date.now();
			// The top bar's roles_watch asks only for the count; the Roles page's own asks for the whole overview.
			if (type === "roles_watch" && !("roles_full" in s.sent) && /"full":\s*true/.test(payload))
				s.sent.roles_full = Date.now();
		});
		ws.on("framereceived", ({ payload }) => {
			const type = typeOf(payload);
			if (type !== "roles" && type !== "work_page" && type !== "initiatives") return;
			if (type in s.got) return;
			let m;
			try {
				m = JSON.parse(payload);
			} catch {
				return;
			}
			if (type === "roles" && m.overview)
				s.got.roles = { at: Date.now(), made: typeof m.checkedAt === "number" ? m.checkedAt : m.overview.at };
			else if (type !== "roles" && m.page)
				s.got[type] = { at: Date.now(), made: typeof m.page.at === "number" ? m.page.at : null };
		});
	});
	return sockets;
}
const initiativesIn = (s) => s.got.work_page && s.got.initiatives;

/** The initiative's name on the Initiatives page (read from the host; the frame runs no script). */
function initiativeShown(page) {
	return page.evaluate((name) => {
		const doc = document.querySelector('iframe[title="Initiatives"]')?.contentDocument;
		return (doc?.body?.innerText ?? "").includes(name);
	}, INITIATIVE);
}

async function setHidden(page, hidden) {
	await page.evaluate((h) => {
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
		Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
		document.dispatchEvent(new Event("visibilitychange"));
	}, hidden);
}

const srv = await ownServer({
	name: "pages-fresh",
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
const startedAt = Date.now();
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
/** The opens' one window id, as the live look's (skill pi-web-ui-live-look): a fresh context would otherwise be
 *  a new window each time, each leaving a blank chat in the server. */
const OPEN_CLIENT_ID = "carry-on:pages-fresh-test-open";
async function newPage(label, clientId) {
	const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "en-US" });
	await context.addInitScript(() => localStorage.setItem("pi-web-ui:lang", "en"));
	if (clientId)
		await context.addInitScript((id) => {
			const send = WebSocket.prototype.send;
			WebSocket.prototype.send = function (data) {
				try {
					const m = JSON.parse(data);
					if (m?.type === "hello") data = JSON.stringify({ ...m, clientId: id });
				} catch {
					/* not a message of the app's */
				}
				return send.call(this, data);
			};
		}, clientId);
	const page = await context.newPage();
	page.on("pageerror", (err) => {
		if (pageErrors++ < 3)
			console.log(
				`page error ${label}: ${String(err?.message ?? err)
					.split("\n")[0]
					.slice(0, 300)}`,
			);
	});
	return { context, page };
}

/** One open of a page: first data from navigation start, and how old its data was when the watch went. */
async function oneOpen(view, i) {
	const { context, page } = await newPage(`${view} open ${i}`, OPEN_CLIENT_ID);
	const sockets = trackSockets(page);
	try {
		const t0 = Date.now();
		await page.goto(`${srv.http}/?view=${view}`, { waitUntil: "domcontentloaded" });
		const s = await until(() => sockets.find((k) => (view === "roles" ? k.got.roles : initiativesIn(k))), 15_000, 20);
		if (!s) return { view, i, error: "no data within 15 s" };
		// Where the time went: the page's load and its socket (openMs), the app's start until it asked (watchMs).
		const parts = (watch) => ({ openMs: s.openedAt - t0, watchMs: watch - t0 });
		if (view === "roles") {
			const watch = s.sent.roles_full ?? s.sent.roles_watch;
			return {
				view,
				i,
				...parts(watch),
				firstDataMs: s.got.roles.at - t0,
				fromWatchMs: s.got.roles.at - watch,
				answerMs: s.got.roles.at - watch,
				ageMs: watch - s.got.roles.made,
			};
		}
		const watch = s.sent.work_page_watch;
		return {
			view,
			i,
			...parts(watch),
			firstDataMs: Math.max(s.got.work_page.at, s.got.initiatives.at) - t0,
			fromWatchMs:
				Math.max(s.got.work_page.at, s.got.initiatives.at) - Math.min(watch, s.sent.initiatives_watch ?? watch),
			answerMs: s.got.work_page.at - watch,
			ageMs: watch - s.got.work_page.made,
			shown: await until(() => initiativeShown(page), 5_000),
		};
	} catch (err) {
		return { view, i, error: String(err?.message ?? err) };
	} finally {
		await context.close().catch(() => {});
	}
}

/** One return to the Initiatives tab after HIDDEN_MS hidden, frozen and cut off. */
async function oneReturn(i) {
	await sleep(i * STAGGER_MS);
	const link = await cutLink(srv.port);
	const { context, page } = await newPage(`return ${i}`);
	const cdp = await context.newCDPSession(page);
	const sockets = trackSockets(page);
	try {
		await page.goto(`${link.http}/?view=initiatives`);
		const ready = await until(async () => sockets.some(initiativesIn) && (await initiativeShown(page)), 60_000, 200);
		if (!ready) return { run: i, error: "never showed the initiative before hiding" };
		await sleep(2_000);
		await setHidden(page, true);
		await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
		link.refuse(true);
		link.cut();
		await sleep(HIDDEN_MS);
		link.refuse(false);
		const back = Date.now();
		await cdp.send("Page.setWebLifecycleState", { state: "active" });
		const t0 = Date.now();
		await setHidden(page, false);
		let freshMs = null;
		let noteMs = null;
		let goneMs = null;
		while (Date.now() - t0 < WINDOW_MS) {
			const ms = Date.now() - t0;
			if (noteMs === null && (await reconnectingShown(page))) noteMs = ms;
			if (goneMs === null && !(await initiativeShown(page))) goneMs = ms;
			if (sockets.some((k) => k.openedAt >= back && initiativesIn(k))) {
				freshMs = ms;
				break;
			}
			await sleep(100);
		}
		const next = sockets.find((k) => k.openedAt >= back && initiativesIn(k));
		// Let the page end the episode and send its trace record before the context goes.
		await sleep(4_000);
		return {
			run: i,
			freshMs,
			newSocketMs: next ? next.openedAt - t0 : null,
			answerMs: next?.sent.work_page_watch ? next.got.work_page.at - next.sent.work_page_watch : null,
			noteMs,
			goneMs,
		};
	} catch (err) {
		return { run: i, error: String(err?.message ?? err) };
	} finally {
		await context.close().catch(() => {});
		await link.close();
	}
}

try {
	// The first background round runs PAGES_FRESH_MS after the start; give it time to finish.
	await sleep(Math.max(0, startedAt + PAGES_FRESH_MS + 3_000 - Date.now()));

	// 1. Opens, one at a time, alternating pages, so they fall at different points of the 15 s cycle.
	const opens = [];
	for (let i = 0; i < OPENS; i++) {
		for (const view of ["roles", "initiatives"]) {
			const r = { atMs: Date.now() - startedAt, ...(await oneOpen(view, i)) };
			opens.push(r);
			console.log(`open ${view} ${i}: ${JSON.stringify(r)}`);
			out({ part: "open", ...r });
			await sleep(1_500);
		}
	}
	// Where the server's own time went meanwhile: its loop records (10 s windows: its CPU, loop delay, GC).
	for (const l of logLines().filter((l) => l.kind === "loop"))
		console.log(
			`server loop at ${((l.t - startedAt) / 1000).toFixed(1)} s: cpu ${l.cpuMs} ms, p99 ${l.p99Ms} ms, max ${l.maxMs} ms, gc ${l.gcN}, load ${l.load1}`,
		);
	const loads = logLines()
		.filter((l) => l.kind === "loop")
		.map((l) => l.load1);
	for (const view of ["roles", "initiatives"]) {
		const ok = opens.filter((r) => r.view === view && !r.error);
		const fromWatch = ok.map((r) => r.fromWatchMs);
		const nav = ok.map((r) => r.firstDataMs);
		const summary = {
			view,
			opens: ok.length,
			p50: pct(fromWatch, 50),
			p90: pct(fromWatch, 90),
			max: pct(fromWatch, 100),
			nav: { p50: pct(nav, 50), p90: pct(nav, 90), max: pct(nav, 100) },
			load: loads.length ? [Math.min(...loads), Math.max(...loads)] : null,
		};
		console.log(`summary opens: ${JSON.stringify(summary)}`);
		out({ part: "open-summary", ...summary });
		check(`every ${view} open got its data`, ok.length === OPENS, `${ok.length} of ${OPENS}`);
		check(
			`${view}: first data within 1 s p90 of its watch (${OPENS} opens)`,
			ok.length > 0 && summary.p90 <= FIRST_DATA_P90_MS,
			`p50 ${summary.p50} ms, p90 ${summary.p90} ms, max ${summary.max} ms; from navigation start (not checked) ` +
				`p50 ${summary.nav.p50} ms, p90 ${summary.nav.p90} ms, max ${summary.nav.max} ms; machine load ${summary.load?.join("-")}`,
		);
	}
	const work = opens.filter((r) => r.view === "initiatives" && !r.error);
	check(
		`every Initiatives open was answered from the kept work page: made before its watch, at most ${COPY_MAX_MS / 1000} s old`,
		work.length > 0 && work.every((r) => r.ageMs > 0 && r.ageMs <= COPY_MAX_MS),
		`ages ${work.map((r) => r.ageMs).join(", ")} ms; answered after ${work.map((r) => r.answerMs).join(", ")} ms`,
	);
	check(
		"every Initiatives open showed the initiative",
		work.length > 0 && work.every((r) => r.shown),
		work
			.filter((r) => !r.shown)
			.map((r) => `open ${r.i}`)
			.join(", "),
	);
	const roles = opens.filter((r) => r.view === "roles" && !r.error);
	check(
		`every Roles open's first overview was at most ${COPY_MAX_MS / 1000} s old`,
		roles.length > 0 && roles.every((r) => r.ageMs <= COPY_MAX_MS),
		`ages ${roles.map((r) => r.ageMs).join(", ")} ms; answered after ${roles.map((r) => r.answerMs).join(", ")} ms`,
	);

	// 2. Returns to the Initiatives tab.
	const returns = await Promise.all(Array.from({ length: RUNS }, (_, i) => oneReturn(i)));
	for (const r of returns) {
		console.log(`return ${r.run}: ${JSON.stringify(r)}`);
		out({ part: "return", hiddenMs: HIDDEN_MS, ...r });
	}
	const ok = returns.filter((r) => !r.error);
	check("every return run showed the initiative before it was hidden", ok.length === RUNS, `${ok.length} of ${RUNS}`);
	const fresh = ok.map((r) => (r.freshMs === null ? Infinity : r.freshMs));
	const summary = { runs: ok.length, p50: pct(fresh, 50), p90: pct(fresh, 90), max: pct(fresh, 100) };
	console.log(`summary returns: ${JSON.stringify(summary)}`);
	out({ part: "return-summary", hiddenMs: HIDDEN_MS, ...summary });
	check(
		"every return shows fresh Initiatives data within 8 s",
		ok.length > 0 && fresh.every((ms) => ms <= GRACE_MS),
		`fresh after ${fresh.map((ms) => (ms === Infinity ? "never" : `${ms} ms`)).join(", ")}`,
	);
	check(
		"fresh Initiatives data within 3 s p90",
		summary.p90 !== null && summary.p90 <= FRESH_P90_MS,
		`p90 ${summary.p90} ms`,
	);
	check(
		"no Reconnecting note before fresh data came back",
		ok.length > 0 && ok.every((r) => r.noteMs === null),
		ok
			.filter((r) => r.noteMs !== null)
			.map((r) => `run ${r.run}: note at ${r.noteMs} ms`)
			.join("; "),
	);
	check(
		"the page kept the initiative on screen until fresh data came",
		ok.length > 0 && ok.every((r) => r.goneMs === null),
		ok
			.filter((r) => r.goneMs !== null)
			.map((r) => `run ${r.run}: gone at ${r.goneMs} ms`)
			.join("; "),
	);
	// The trace: each return leaves a record whose episode ended on the Initiatives view, with shownMs.
	await sleep(3_000);
	const banners = logLines().filter((l) => l.kind === "banner");
	const traced = banners.filter(
		(l) => l.view === "initiatives" && typeof l.shownMs === "number" && l.endVisible === true,
	);
	check(
		"the connection log records each return with view initiatives and shownMs",
		traced.length >= ok.length,
		`${traced.length} of ${banners.length} records (${banners.map((l) => `${l.reason}/${l.view ?? "-"}`).join(", ")}); shownMs ${traced.map((l) => l.shownMs).join(", ")}`,
	);
	out({ part: "trace", records: traced.map((l) => ({ reason: l.reason, durMs: l.durMs, shownMs: l.shownMs })) });
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
