/**
 * phone-connection E2E (no tokens): a chat on an Android phone keeps updating (mobile-fixes).
 *
 * An emulated Android phone (Chrome 412×915, touch, CPU 2× slower; tests/lib/phone.mjs) follows a
 * long reply of a stand-in model through a slow mobile-data link (about 1.6 Mbit/s, 150–300 ms;
 * tests/lib/slow-link.mjs) that can also go silent without closing, like a connection that died.
 * Checks:
 *  1. After the tab was in the background, the phone slept (Chrome froze the page), or the network
 *     was gone, the chat catches up within 5 s of coming back, without a reload; also after a short
 *     trip to the background (the page asks the server and gets no answer).
 *  2. A connection that dies silently while the chat is on screen is replaced: the chat catches up
 *     within 9 s of the silence starting (5 s of silence means dead), and "Reconnecting…" shows
 *     meanwhile and goes away after.
 *  3. A long reply on the slow link shows steadily to the end, on one connection (no reconnects).
 *  4. Opening a chat of big messages on a very slow link (64 kbit/s: one message takes many seconds,
 *     with nothing else getting through) doesn't make the page think the connection died: no
 *     reconnect loop, and the chat opens. A reply in it then shows to the end on the same link.
 *
 * PI_PHONE_ONLY=hidden,sleep,offline,silent,stream,big runs only those parts.
 *
 * Usage: npm run build && scripts/sealed.sh node tests/phone-connection-test.mjs
 * Only timing facts are read; the only chat text is the made-up seeded chat and stand-in replies.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { launchBrowser, openPhone, PHONE_412 } from "./lib/phone.mjs";
import { hookSocket, openChatOnPage, seedChat, startPhoneServer } from "./lib/phone-chat.mjs";
import { installTimers, measureCatchup, measureStream, stopReply } from "./lib/phone-checks.mjs";

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}

const kit = await startPhoneServer({ name: "phone-connection", exchanges: 30 });
// A chat of big messages: what opens with it is about 300k characters (a real chat's tail is often
// bigger), about 90 KB on the wire: 10 s or more on the very slow link.
const big = seedChat(kit.sessionsDir, kit.workCwd, {
	id: "01a0f000-0000-7000-8000-00000000b002",
	exchanges: 60,
	bulky: 5000,
	name: "big",
});
// PI_PHONE_ONLY=offline,silent,stream,big: only those parts (for looking into a failure).
const only = process.env.PI_PHONE_ONLY?.split(",");
const wanted = (part) => !only || only.includes(part);
const chatUrl = (file) => `${kit.link.http}/?chat=${encodeURIComponent(file)}`;
const browser = await launchBrowser();

/** A phone showing the seeded chat. */
async function phoneOnChat({ slow = true } = {}) {
	kit.link.setSpeed(slow ? {} : null);
	const phone = await openPhone(browser, { size: PHONE_412, cpu: 2 });
	await hookSocket(phone.page);
	await installTimers(phone.page);
	await phone.page.goto(kit.link.http);
	await phone.page.evaluate(() => sessionStorage.setItem("__phoneMarker", ""));
	await phone.page.goto(chatUrl(kit.seeded.file));
	await phone.page.waitForFunction(() => window.__phoneT?.chat != null && window.__phoneT?.ws != null, null, {
		timeout: 120_000,
	});
	await sleep(1000);
	return phone;
}

/** After a check: wait until the page is connected and hearing the server again. */
async function settle(phone) {
	await phone.page
		.waitForFunction(() => window.__ws?.readyState === 1 && window.__lastFrameAt > Date.now() - 4000, null, {
			timeout: 30_000,
		})
		.catch(() => {});
	await stopReply(phone.page);
	await sleep(1000);
}

try {
	// ── 1 + 2. Catching up ─────────────────────────────────────────────────────────────────
	{
		const phone = await phoneOnChat();
		const cases = [
			{ scenario: "hidden", awayMs: 8000, limitMs: 5000, what: "after the tab was in the background" },
			{ scenario: "hidden", awayMs: 1500, limitMs: 5000, what: "after a short trip to the background" },
			{ scenario: "sleep", awayMs: 8000, limitMs: 5000, what: "after the phone slept" },
			{ scenario: "offline", awayMs: 8000, limitMs: 5000, what: "after the network was gone" },
			// Last: a silence nothing explains makes the next connection more patient for a while.
			{ scenario: "silent", awayMs: 0, limitMs: 9000, what: "after the connection died silently" },
		];
		for (const c of cases) {
			if (!wanted(c.scenario)) continue;
			const r = await measureCatchup(kit, phone, c.scenario, { awayMs: c.awayMs, limitMs: 30_000 });
			const detail =
				r.error ??
				`${r.catchupMs ?? "never"} ms, ${r.newSockets} new connection(s), note ${r.reconnectingNote ? "shown" : "not shown"}`;
			check(
				`the chat catches up ${c.what} (within ${c.limitMs / 1000} s)`,
				r.catchupMs != null && r.catchupMs <= c.limitMs,
				detail,
			);
			if (c.scenario === "silent" || c.scenario === "offline") {
				check(`"Reconnecting…" shows ${c.what}`, r.reconnectingNote === true, detail);
			}
			if (r.catchupMs != null) check(`"Reconnecting…" is gone once caught up ${c.what}`, r.noteGone === true, detail);
			await settle(phone);
		}
		await phone.close();
	}

	// ── 3. A long reply on the slow link ────────────────────────────────────────────────────
	if (wanted("stream")) {
		const phone = await phoneOnChat();
		const s = await measureStream(kit, phone, { lines: 800, everyMs: 25 });
		const detail = `first line ${s.firstLineMs} ms, longest pause ${s.maxGapMs} ms, end ${s.endLagMs} ms after the model, ${s.newSockets} reconnect(s)`;
		check("a long reply on the slow link shows to the end", s.complete, detail);
		check("... without reconnecting", s.newSockets === 0, detail);
		check("... without freezing (no pause over 3 s while it streams)", s.maxGapMs < 3000, detail);
		await phone.close();
	}

	// ── 4. A big chat on a very slow link ───────────────────────────────────────────────────
	if (wanted("big")) {
		const phone = await phoneOnChat({ slow: false });
		const { page } = phone;
		kit.link.setSpeed({ downKbps: 64, upKbps: 64, rttMs: [200, 400] });
		const sizes = () =>
			page.evaluate(() => ({
				sockets: window.__sockets,
				hints: window.__frameBytes?.frame_hint ?? 0,
				snapshotChars: window.__frameBytes?.snapshot ?? 0,
			}));
		const before = await sizes();
		const down0 = kit.link.stats().down;
		const t0 = Date.now();
		const opened = await openChatOnPage(page, big.file, 240_000)
			.then(() => true)
			.catch((e) => String(e?.message ?? e));
		const tookMs = Date.now() - t0;
		const after = await sizes();
		const detail =
			`${tookMs} ms, ${Math.round((after.snapshotChars - before.snapshotChars) / 1000)}k characters, ` +
			`${Math.round((kit.link.stats().down - down0) / 1024)} KB on the wire, ${after.sockets - before.sockets} new connection(s)`;
		check("a big chat opens on a very slow link", opened === true, opened === true ? detail : `${opened}; ${detail}`);
		check("... on the same connection (no reconnect loop)", after.sockets === before.sockets, detail);
		// Longer than the silence that means "dead": only the announcement kept the connection.
		check(
			"... announced as big, so the long wait isn't taken for a dead connection",
			after.hints > before.hints && tookMs > 7000,
			detail,
		);
		// Then a reply in that chat, still on the very slow link: the updates keep coming.
		if (opened === true) {
			const s = await measureStream(kit, phone, { lines: 60, everyMs: 50, limitMs: 120_000 });
			const sd = `first line ${s.firstLineMs} ms, longest pause ${s.maxGapMs} ms, end ${s.endLagMs} ms after the model, ${s.newSockets} reconnect(s)`;
			check(
				"a reply in the big chat on the very slow link shows to the end, on the same connection",
				s.complete && s.newSockets === 0,
				sd,
			);
		}
		kit.link.setSpeed(null);
		await phone.close();
	}
} catch (e) {
	check("the test ran to the end", false, e?.stack ?? String(e));
} finally {
	await browser.close().catch(() => {});
	await kit.link.close().catch(() => {});
	await kit.srv.stop().catch(() => {});
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall phone connection checks passed");
process.exit(failures ? 1 : 0);
