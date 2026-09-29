/* optimistic-send E2E (no tokens): a sent message shows in the chat at once, faded with
 * "Sending…", and the server's copy takes its place when it arrives.
 *
 * A test add-on makes pi's "before the AI starts" step (before_agent_start) wait 3 s, the way
 * pi-memory's search can; before optimistic-send the message only showed after that step. A mock
 * model answers every message. One page, one server of its own.
 * Checks:
 *  - plain send: the faded copy shows in under 200 ms with "Sending…" and "working" after it, and
 *    stays while the add-on runs; the server's copy then takes its place: never two copies, never
 *    none, same place and size;
 *  - a slash command (/name) gets no faded copy;
 *  - a picture and a file: the faded copy shows them at once; the chat never shows them twice;
 *  - while the AI works: the message shows at once, looking queued, and the server's queued copy
 *    takes its place; it reaches the chat once;
 *  - two quick sends: both show at once, in order, "working" after the second; each reaches the
 *    chat once, in order;
 *  - refused (the server is draining): "Not sent" with the reason, Retry and ×; Retry sends it once;
 *  - ×: the message leaves the chat, its text and file go back to the input box;
 *  - switching chats while one is sending: the other chat shows nothing of it; back in its own
 *    chat it is still "Sending…" and then arrives once;
 *  - reload while sending: the faded copy is back after the reload and turns into the real one;
 *  - the server restarts before the message reached the chat: "Not sent", and Retry sends it once;
 *  - no page errors.
 * Usage: npm run build && node tests/optimistic-send-test.mjs
 *        OPTIMISTIC_SHOT=/tmp/opt saves /tmp/opt-sending.png and /tmp/opt-not-sent.png
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { ownServer } from "./lib/own-server.mjs";

const HOOK_MS = 3000;
const ANSWER_MS = 400;
const SHOT = process.env.OPTIMISTIC_SHOT ?? "";
const TA = ".inputbox textarea";
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`  ${ok ? "✓" : "✗ FAIL:"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};
async function waitFor(fn, ms, step = 100) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await fn()) return true;
		await sleep(step);
	}
	return false;
}

// ---- the mock model: answers each message by its token; a HOLD message waits for the test ----
const held = [];
const releaseHeld = () => {
	for (const r of held.splice(0)) r();
};
const tokenOf = (text) => text.match(/OPT-[A-Z0-9-]+/)?.[0] ?? "";

// ---- the slow add-on: before_agent_start waits HOOK_MS, or until the test drops a file ----------
const extensionSource = (releaseDir) => `import { existsSync } from "node:fs";
import { join } from "node:path";

/** optimistic-send test: pi's "before the AI starts" step takes a while, like pi-memory's search. */
export default function (pi: any) {
	pi.on("before_agent_start", async (event: any) => {
		const text = String(event?.prompt ?? "");
		const hold = text.match(/LONGHOOK-(\\w+)/);
		if (hold) {
			const flag = join(${JSON.stringify(releaseDir)}, "release-" + hold[1]);
			const until = Date.now() + 90_000;
			while (!existsSync(flag) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
			return;
		}
		await new Promise((r) => setTimeout(r, ${HOOK_MS}));
	});
}
`;

const srv = await ownServer({
	name: "optimistic-send",
	mock: async ({ lastUser, sideRequest }) => {
		if (sideRequest) return "Optimistic chat";
		if (lastUser.includes("HOLD")) {
			await new Promise((r) => held.push(r));
			return "Held reply.";
		}
		// A real model takes a moment to answer, so the server's copy first shows with the AI working,
		// as in real use (an instant answer could land in the same frame).
		await sleep(ANSWER_MS);
		return `ANSWER for ${tokenOf(lastUser) || "something"}.`;
	},
	prepare: async ({ agentDir, workdir }) => {
		// Pictures: the stand-in model takes images too.
		const modelsPath = join(agentDir, "models.json");
		const cfg = JSON.parse(readFileSync(modelsPath, "utf8"));
		for (const p of Object.values(cfg.providers)) for (const m of p.models) m.input = ["text", "image"];
		writeFileSync(modelsPath, JSON.stringify(cfg));
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(join(agentDir, "extensions", "slow-start.ts"), extensionSource(workdir));
	},
});
const release = (name) => writeFileSync(join(srv.workdir, `release-${name}`), "go");

/** The server's control socket (quiesce = "about to restart, no new messages"). */
function control(cmd) {
	const path = join(srv.dataDir, "pi-web-ui.sock");
	return new Promise((resolvePromise) => {
		const sock = createConnection(path);
		let done = false;
		const finish = (v) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			sock.destroy();
			resolvePromise(v);
		};
		const timer = setTimeout(() => finish(null), 3000);
		let buf = "";
		sock.on("connect", () => sock.write(JSON.stringify({ cmd }) + "\n"));
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				try {
					finish(JSON.parse(buf.slice(0, nl)));
				} catch {
					finish(null);
				}
			}
		});
		sock.on("error", () => finish(null));
		sock.on("close", () => finish(null));
	});
}

const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e?.message ?? e)));

/**
 * Watches the chat, frame by frame, for the given tokens: when a faded copy first shows (and how it
 * looks), when the server's copy first shows, the most copies at once, frames with none after the
 * first, and where the bubble sits just before and just after the swap. Enter presses are noted too.
 */
async function track(tokens, extra = {}) {
	await page.evaluate(
		({ tokens, extra }) => {
			const w = window;
			if (w.__opt) w.__opt.running = false;
			const st = { running: true, enterAt: [], tokens: {}, extra: {} };
			for (const t of tokens)
				st.tokens[t] = {
					firstPend: null,
					firstReal: null,
					maxN: 0,
					gaps: 0,
					lastPendTop: null,
					firstRealTop: null,
					lastPendH: null,
					firstRealH: null,
					look: null,
				};
			for (const [k, sel] of Object.entries(extra)) st.extra[k] = { sel, first: null, maxN: 0, gaps: 0 };
			document.addEventListener(
				"keydown",
				(e) => {
					if (e.key === "Enter") st.enterAt.push(performance.now());
				},
				true,
			);
			const list = () => document.querySelector(".messages");
			const topOf = (el) => {
				const box = list();
				return box ? Math.round(el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop) : 0;
			};
			const tick = () => {
				if (!st.running) return;
				const now = performance.now();
				const all = [...document.querySelectorAll(".messages .msg-user")];
				for (const t of tokens) {
					const s = st.tokens[t];
					const mine = all.filter((el) => (el.textContent || "").includes(t));
					const pend = mine.filter((el) => el.classList.contains("msg-pending"));
					const real = mine.filter((el) => !el.classList.contains("msg-pending"));
					s.maxN = Math.max(s.maxN, mine.length);
					if ((s.firstPend !== null || s.firstReal !== null) && mine.length === 0) s.gaps++;
					if (pend.length > 0) {
						const el = pend[0];
						if (s.firstPend === null) {
							s.firstPend = now;
							const fold = document.querySelector(`[data-fold-key="pending:${el.dataset.pendingId}"]`);
							const body = el.querySelector(".msg-body");
							s.look = {
								tag: el.querySelector(".pending-tag")?.textContent ?? null,
								opacity: body ? Number(getComputedStyle(body).opacity) : 1,
								queued: el.classList.contains("msg-queued"),
								workingAfter: !!fold && !!(el.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING),
								imgs: el.querySelectorAll(".msg-pending-img").length,
								files: el.querySelectorAll(".msg-pending-file").length,
							};
						}
						if (s.firstReal === null) {
							s.lastPendTop = topOf(el);
							s.lastPendH = Math.round(el.getBoundingClientRect().height);
						}
					}
					if (real.length > 0 && s.firstReal === null) {
						s.firstReal = now;
						s.firstRealTop = topOf(real[0]);
						s.firstRealH = Math.round(real[0].getBoundingClientRect().height);
					}
				}
				for (const x of Object.values(st.extra)) {
					const n = document.querySelectorAll(x.sel).length;
					x.maxN = Math.max(x.maxN, n);
					if (x.first !== null && n === 0) x.gaps++;
					if (n > 0 && x.first === null) x.first = now;
				}
				requestAnimationFrame(tick);
			};
			w.__opt = st;
			requestAnimationFrame(tick);
		},
		{ tokens, extra },
	);
}
const tracked = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__opt)));
const stopTracking = () => page.evaluate(() => window.__opt && (window.__opt.running = false));
/** From the Enter press just before the faded copy showed to that frame, in ms. */
function showDelay(st, token) {
	const s = st.tokens[token];
	if (s.firstPend === null) return Infinity;
	const presses = st.enterAt.filter((t) => t <= s.firstPend);
	return presses.length ? Math.round(s.firstPend - presses.at(-1)) : Infinity;
}
/** The server's copy showed where the faded copy was, just as tall (then nothing below moves either). */
const samePlace = (s) =>
	s.lastPendTop !== null &&
	s.firstRealTop !== null &&
	Math.abs(s.firstRealTop - s.lastPendTop) <= 2 &&
	Math.abs(s.firstRealH - s.lastPendH) <= 2;
const placeNote = (s) => `top ${s.lastPendTop} → ${s.firstRealTop}, height ${s.lastPendH} → ${s.firstRealH}`;
/** Bubbles in the chat with this text: [faded copies, server copies]. */
const bubbles = (token) =>
	page.evaluate((t) => {
		const all = [...document.querySelectorAll(".messages .msg-user")].filter((el) =>
			(el.textContent || "").includes(t),
		);
		return [
			all.filter((el) => el.classList.contains("msg-pending")).length,
			all.filter((el) => !el.classList.contains("msg-pending")).length,
		];
	}, token);
const messagesText = () => page.evaluate(() => document.querySelector(".messages")?.textContent ?? "");
const idle = () => waitFor(async () => (await page.locator(".btn.stop").count()) === 0, 30_000);
const answered = (token) => waitFor(async () => (await messagesText()).includes(`ANSWER for ${token}`), 30_000);
async function send(text) {
	await page.locator(TA).fill(text);
	await page.keyboard.press("Enter");
}
async function shot(name) {
	if (!SHOT) return;
	await page.locator(".messages").screenshot({ path: `${SHOT}-${name}.png` });
	console.log(`    screenshot: ${SHOT}-${name}.png`);
}
const openChat = async (name) => {
	await page.locator(".lp-row", { hasText: name }).first().locator(".session-item").first().click();
};

try {
	await page.goto(srv.http);
	await page.waitForSelector(TA, { timeout: 30_000 });
	await sleep(500);

	// ---- 1. a plain message ------------------------------------------------------------------
	console.log("1. a plain message while the add-on's step takes 3 s");
	await track(["OPT-PLAIN"]);
	await page.locator(TA).focus();
	await send("OPT-PLAIN hello there");
	await page.waitForSelector(".msg-pending", { timeout: 2000 }).catch(() => {});
	await shot("sending");
	await waitFor(async () => (await tracked()).tokens["OPT-PLAIN"].firstReal !== null, 30_000);
	let st = await tracked();
	let s = st.tokens["OPT-PLAIN"];
	const plainDelay = showDelay(st, "OPT-PLAIN");
	console.log(`    Send → visible: ${plainDelay} ms; faded for ${Math.round(s.firstReal - s.firstPend)} ms`);
	check("the message shows in under 200 ms", plainDelay < 200, `${plainDelay} ms`);
	check('…with "Sending…"', s.look?.tag === "Sending…", String(s.look?.tag));
	check("…faded", (s.look?.opacity ?? 1) < 0.9, String(s.look?.opacity));
	check('…and "working" right after it', s.look?.workingAfter === true);
	check(
		"the faded copy stays while the add-on runs (≥ 2.5 s)",
		s.firstReal !== null && s.firstReal - s.firstPend >= 2500,
		`${Math.round(s.firstReal - s.firstPend)} ms`,
	);
	check("never two copies at once", s.maxN === 1, `max ${s.maxN}`);
	check("never none in between", s.gaps === 0, `${s.gaps} frame(s)`);
	check("the server's copy takes its place without a jump, at the same size", samePlace(s), placeNote(s));
	check("the answer comes", await answered("OPT-PLAIN"));
	await idle();
	await stopTracking();
	check("one copy in the chat, none faded", JSON.stringify(await bubbles("OPT-PLAIN")) === "[0,1]");

	// ---- 2. a slash command -------------------------------------------------------------------
	console.log("2. a slash command");
	await page.evaluate(() => {
		window.__pendSeen = 0;
		const mo = new MutationObserver(() => {
			if (document.querySelector(".msg-pending")) window.__pendSeen++;
		});
		mo.observe(document.body, { childList: true, subtree: true });
		window.__pendMo = mo;
	});
	await send("/name Alpha");
	const named = await waitFor(async () => (await page.locator(".lp-row", { hasText: "Alpha" }).count()) > 0, 15_000);
	await sleep(300);
	const pendSeen = await page.evaluate(() => {
		window.__pendMo?.disconnect();
		return window.__pendSeen;
	});
	check("/name ran (the chat is called Alpha)", named);
	check("…and got no faded copy", pendSeen === 0, `${pendSeen}`);

	// ---- 3. a picture and a file ----------------------------------------------------------------
	console.log("3. a picture and a file");
	writeFileSync(join(srv.workdir, "opt-pic.png"), Buffer.from(PNG_B64, "base64"));
	writeFileSync(join(srv.workdir, "opt-notes.txt"), "some notes for the optimistic test\n");
	await page.locator('.inputbox input[type="file"]').setInputFiles(join(srv.workdir, "opt-pic.png"));
	await page.waitForSelector(".attach-chip.image", { timeout: 8000 });
	await page.locator('.inputbox input[type="file"]').setInputFiles(join(srv.workdir, "opt-notes.txt"));
	await page.waitForSelector(".attach-chip.file", { timeout: 8000 });
	await track(["OPT-FILES"], {
		pic: '.messages .msg-pending-img[alt="opt-pic.png"], .messages .attachcard-name',
	});
	await page.locator(TA).fill("OPT-FILES look at these");
	await page.keyboard.press("Enter");
	await sleep(1500);
	await shot("files-sending");
	await waitFor(async () => (await tracked()).tokens["OPT-FILES"].firstReal !== null, 30_000);
	await shot("files-sent");
	st = await tracked();
	s = st.tokens["OPT-FILES"];
	const filesDelay = showDelay(st, "OPT-FILES");
	check("the message with a picture and a file shows in under 200 ms", filesDelay < 200, `${filesDelay} ms`);
	check("…showing the picture and the file at once", s.look?.imgs === 1 && s.look?.files === 1, JSON.stringify(s.look));
	check("never two copies of the text", s.maxN === 1 && s.gaps === 0, `max ${s.maxN}, gaps ${s.gaps}`);
	check("the server's copy takes its place without a jump, at the same size", samePlace(s), placeNote(s));
	check("the answer comes", await answered("OPT-FILES"));
	await idle();
	await stopTracking();
	const cards = await page.evaluate(() =>
		[...document.querySelectorAll(".messages .attachcard-name")].map((el) => (el.textContent || "").trim()),
	);
	check(
		"the chat shows the picture and the file once each",
		cards.filter((n) => n.includes("opt-pic.png")).length === 1 &&
			cards.filter((n) => n.includes("opt-notes.txt")).length === 1,
		JSON.stringify(cards),
	);
	check("no faded copy left", (await page.locator(".msg-pending").count()) === 0);

	// ---- 4. while the AI works --------------------------------------------------------------------
	console.log("4. a message sent while the AI works");
	await send("OPT-HOLD please take your time HOLD");
	check("the AI is working", await waitFor(async () => (await page.locator(".btn.stop").count()) > 0, 20_000));
	check("…on the held message", await waitFor(async () => held.length > 0, 20_000));
	await track(["OPT-WHILE"]);
	await send("OPT-WHILE one more thing");
	await waitFor(async () => (await tracked()).tokens["OPT-WHILE"].firstReal !== null, 20_000);
	st = await tracked();
	s = st.tokens["OPT-WHILE"];
	const whileDelay = showDelay(st, "OPT-WHILE");
	check("it shows in under 200 ms", whileDelay < 200, `${whileDelay} ms`);
	check("…looking queued", s.look?.queued === true);
	check(
		"the server's queued copy takes its place: never two, never none",
		s.maxN === 1 && s.gaps === 0,
		`max ${s.maxN}, gaps ${s.gaps}`,
	);
	await stopTracking();
	releaseHeld();
	check("the answer to it comes", await answered("OPT-WHILE"));
	await idle();
	check(
		"it is in the chat once",
		JSON.stringify(await bubbles("OPT-WHILE")) === "[0,1]",
		JSON.stringify(await bubbles("OPT-WHILE")),
	);

	// ---- 5. two quick sends -------------------------------------------------------------------------
	console.log("5. two quick sends");
	await track(["OPT-QUICK-A", "OPT-QUICK-B"]);
	await send("OPT-QUICK-A first");
	await send("OPT-QUICK-B second");
	await waitFor(async () => {
		const t = (await tracked()).tokens;
		return t["OPT-QUICK-A"].firstPend !== null && t["OPT-QUICK-B"].firstPend !== null;
	}, 3000);
	const quickOrder = await page.evaluate(() => {
		const pend = [...document.querySelectorAll(".messages .msg-pending")];
		const folds = [...document.querySelectorAll('.messages [data-fold-key^="pending:"]')];
		const a = pend.find((el) => el.textContent.includes("OPT-QUICK-A"));
		const b = pend.find((el) => el.textContent.includes("OPT-QUICK-B"));
		return {
			both: !!a && !!b,
			aFirst: !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING),
			folds: folds.length,
			foldAfterB:
				folds.length === 1 && !!b && !!(b.compareDocumentPosition(folds[0]) & Node.DOCUMENT_POSITION_FOLLOWING),
		};
	});
	st = await tracked();
	check(
		"both show at once",
		showDelay(st, "OPT-QUICK-A") < 200 && showDelay(st, "OPT-QUICK-B") < 200,
		`${showDelay(st, "OPT-QUICK-A")} / ${showDelay(st, "OPT-QUICK-B")} ms`,
	);
	check(
		'…in the order sent, with one "working" after the second',
		quickOrder.aFirst && quickOrder.foldAfterB,
		JSON.stringify(quickOrder),
	);
	check("the answers come", (await answered("OPT-QUICK-A")) && (await answered("OPT-QUICK-B")));
	await idle();
	st = await tracked();
	await stopTracking();
	for (const k of ["OPT-QUICK-A", "OPT-QUICK-B"]) {
		const q = st.tokens[k];
		check(`${k}: never two copies, never none`, q.maxN === 1 && q.gaps === 0, `max ${q.maxN}, gaps ${q.gaps}`);
	}
	const quickFinal = await page.evaluate(() => {
		const users = [...document.querySelectorAll(".messages .msg-user:not(.msg-pending)")].map(
			(el) => el.textContent || "",
		);
		return {
			a: users.filter((t) => t.includes("OPT-QUICK-A")).length,
			b: users.filter((t) => t.includes("OPT-QUICK-B")).length,
			order: users.findIndex((t) => t.includes("OPT-QUICK-A")) < users.findIndex((t) => t.includes("OPT-QUICK-B")),
		};
	});
	check(
		"each is in the chat once, in order",
		quickFinal.a === 1 && quickFinal.b === 1 && quickFinal.order,
		JSON.stringify(quickFinal),
	);

	// ---- 6. refused: "Not sent", then Retry ------------------------------------------------------
	console.log("6. refused while the server is draining");
	check("server drains", (await control("quiesce"))?.ok === true);
	await send("OPT-REFUSED try me later");
	const failedShown = await waitFor(
		async () => (await page.locator('.msg-pending[data-pending-status="failed"]').count()) === 1,
		10_000,
	);
	check('the message stays, marked "Not sent"', failedShown);
	const failedLook = await page.evaluate(() => {
		const el = document.querySelector('.msg-pending[data-pending-status="failed"]');
		return {
			text: el?.textContent?.includes("OPT-REFUSED") ?? false,
			tag: el?.querySelector(".pending-tag")?.textContent ?? null,
			reason: el?.querySelector(".msg-pending-reason")?.textContent ?? "",
			retry: !!el?.querySelector(".msg-pending-retry"),
			remove: !!el?.querySelector(".msg-pending-remove"),
		};
	});
	check(
		"…with its text and the reason",
		failedLook.text && failedLook.tag === "Not sent" && /restart/.test(failedLook.reason),
		JSON.stringify(failedLook),
	);
	check("…and Retry and ×", failedLook.retry && failedLook.remove);
	await shot("not-sent");
	check("server takes messages again", (await control("unquiesce"))?.ok === true);
	await track(["OPT-REFUSED"]);
	await page.locator(".msg-pending-retry").click();
	check(
		'Retry: "Sending…" again',
		await waitFor(
			async () => (await page.locator('.msg-pending[data-pending-status="sending"]').count()) === 1,
			3000,
			20,
		),
	);
	check("the answer comes", await answered("OPT-REFUSED"));
	await idle();
	st = await tracked();
	await stopTracking();
	s = st.tokens["OPT-REFUSED"];
	check("it reached the chat once, swapped in place", s.maxN === 1 && s.gaps === 0, `max ${s.maxN}, gaps ${s.gaps}`);
	check(
		"…and is there once",
		JSON.stringify(await bubbles("OPT-REFUSED")) === "[0,1]",
		JSON.stringify(await bubbles("OPT-REFUSED")),
	);

	// ---- 7. × puts the text and the file back ----------------------------------------------------
	console.log("7. × on a message that wasn't sent");
	check("server drains", (await control("quiesce"))?.ok === true);
	await page.locator('.inputbox input[type="file"]').setInputFiles(join(srv.workdir, "opt-notes.txt"));
	await page.waitForSelector(".attach-chip.file", { timeout: 8000 });
	await send("OPT-REMOVE bring me back");
	check(
		'"Not sent"',
		await waitFor(async () => (await page.locator('.msg-pending[data-pending-status="failed"]').count()) === 1, 10_000),
	);
	check(
		"the input box was emptied when it was sent",
		(await page.locator(TA).inputValue()) === "" && (await page.locator(".attach-chip").count()) === 0,
	);
	await page.locator(".msg-pending-remove").click();
	check(
		"× takes it out of the chat",
		await waitFor(async () => (await page.locator(".msg-pending").count()) === 0, 3000, 20),
	);
	check(
		"…and puts the text back in the input box",
		await waitFor(async () => (await page.locator(TA).inputValue()) === "OPT-REMOVE bring me back", 3000, 20),
		await page.locator(TA).inputValue(),
	);
	check("…with its file", (await page.locator(".attach-chip.file", { hasText: "opt-notes.txt" }).count()) === 1);
	check("server takes messages again", (await control("unquiesce"))?.ok === true);
	await page.locator(TA).fill("");
	while ((await page.locator(".attach-chip .attach-remove").count()) > 0)
		await page.locator(".attach-chip .attach-remove").first().click();

	// ---- 8. switching chats while one is sending ------------------------------------------------
	console.log("8. switching chats while a message is on its way");
	await send("OPT-SWITCH sent then left LONGHOOK-switch");
	check("it shows at once", await waitFor(async () => (await bubbles("OPT-SWITCH"))[0] === 1, 2000, 20));
	await page.locator(".lp-new-chat-action").click();
	check("a new chat opens", await waitFor(async () => !(await messagesText()).includes("OPT-PLAIN"), 10_000));
	await sleep(500);
	check("the new chat shows nothing of it", JSON.stringify(await bubbles("OPT-SWITCH")) === "[0,0]");
	await openChat("Alpha");
	check("back in Alpha", await waitFor(async () => (await messagesText()).includes("OPT-PLAIN"), 10_000));
	check(
		'it is still there, "Sending…"',
		await waitFor(
			async () =>
				(await page.locator('.msg-pending[data-pending-status="sending"]', { hasText: "OPT-SWITCH" }).count()) === 1,
			5000,
		),
	);
	await track(["OPT-SWITCH"]);
	release("switch");
	check("the answer comes", await answered("OPT-SWITCH"));
	await idle();
	st = await tracked();
	await stopTracking();
	s = st.tokens["OPT-SWITCH"];
	check("it arrived in place: never two, never none", s.maxN === 1 && s.gaps === 0, `max ${s.maxN}, gaps ${s.gaps}`);
	check(
		"…and is there once",
		JSON.stringify(await bubbles("OPT-SWITCH")) === "[0,1]",
		JSON.stringify(await bubbles("OPT-SWITCH")),
	);

	// ---- 9. reload while sending --------------------------------------------------------------------
	console.log("9. reload while a message is on its way");
	await send("OPT-RELOAD still here after a reload LONGHOOK-reload");
	check("it shows at once", await waitFor(async () => (await bubbles("OPT-RELOAD"))[0] === 1, 2000, 20));
	await page.reload();
	await page.waitForSelector(TA, { timeout: 30_000 });
	check(
		"after the reload the chat is Alpha",
		await waitFor(async () => (await messagesText()).includes("OPT-PLAIN"), 15_000),
	);
	check(
		'…and the message is still there, "Sending…"',
		await waitFor(
			async () =>
				(await page.locator('.msg-pending[data-pending-status="sending"]', { hasText: "OPT-RELOAD" }).count()) === 1,
			5000,
		),
	);
	await track(["OPT-RELOAD"]);
	release("reload");
	check("the answer comes", await answered("OPT-RELOAD"));
	await idle();
	st = await tracked();
	await stopTracking();
	s = st.tokens["OPT-RELOAD"];
	check("it arrived in place: never two, never none", s.maxN === 1 && s.gaps === 0, `max ${s.maxN}, gaps ${s.gaps}`);
	check(
		"…and is there once",
		JSON.stringify(await bubbles("OPT-RELOAD")) === "[0,1]",
		JSON.stringify(await bubbles("OPT-RELOAD")),
	);

	// ---- 10. the server restarts before the message reached the chat ---------------------------
	console.log("10. the server restarts before the message reached the chat");
	await send("OPT-LOST gone with the restart LONGHOOK-lost");
	check("it shows at once", await waitFor(async () => (await bubbles("OPT-LOST"))[0] === 1, 2000, 20));
	await sleep(300);
	await srv.restart();
	release("lost"); // the next try goes straight through
	await waitFor(async () => (await page.locator(".lp-row", { hasText: "Alpha" }).count()) > 0, 30_000);
	await sleep(1000);
	if (!(await messagesText()).includes("OPT-PLAIN")) await openChat("Alpha");
	check("Alpha is open again", await waitFor(async () => (await messagesText()).includes("OPT-PLAIN"), 20_000));
	check(
		'the message is marked "Not sent"',
		await waitFor(
			async () =>
				(await page.locator('.msg-pending[data-pending-status="failed"]', { hasText: "OPT-LOST" }).count()) === 1,
			20_000,
		),
	);
	await track(["OPT-LOST"]);
	await page.locator(".msg-pending-retry").click();
	check("Retry: the answer comes", await answered("OPT-LOST"));
	await idle();
	st = await tracked();
	await stopTracking();
	s = st.tokens["OPT-LOST"];
	check("it arrived in place: never two, never none", s.maxN === 1 && s.gaps === 0, `max ${s.maxN}, gaps ${s.gaps}`);
	check(
		"…and is there once",
		JSON.stringify(await bubbles("OPT-LOST")) === "[0,1]",
		JSON.stringify(await bubbles("OPT-LOST")),
	);

	check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (e) {
	console.log(`✗ FAIL: ${e?.stack ?? e}`);
	failures++;
} finally {
	releaseHeld();
	await browser.close().catch(() => {});
	await srv.stop();
	await srv.mock?.close?.();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
