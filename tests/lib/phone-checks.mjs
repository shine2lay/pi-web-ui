/**
 * phone-checks.mjs: the phone measurements, shared by the phone tests (tests/phone-*-test.mjs) and
 * the before/after report (tests/tools/phone-measure.mjs). Every result is a layout or timing fact;
 * the only chat text read is the made-up text of the seeded chat and the stand-in model.
 */
import { linesSentNow, newReplyTag, streamState } from "./phone-chat.mjs";
import { tapTargets } from "./phone.mjs";

export const TA = ".inputbox textarea";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Before the first goto: marks when the page's chat can be used (window.__phoneT, ms since the
 *  navigation started): composer (the message box shows and takes input), chat (the chat's newest
 *  message shows: the seeded chat's last marker, or any message when there is no marker), ws (the
 *  socket is open), fcp (first paint with content). */
export async function installTimers(page) {
	await page.addInitScript(() => {
		const T = (window.__phoneT = {});
		const mark = (k) => {
			if (T[k] == null) T[k] = Math.round(performance.now());
		};
		const marker = sessionStorage.getItem("__phoneMarker") || "";
		const check = () => {
			const ta = document.querySelector(".inputbox textarea");
			if (ta && !ta.disabled && ta.offsetHeight > 0) mark("composer");
			const list = document.querySelector(".messages");
			if (list) {
				const msgs = list.querySelectorAll(".msg.msg-assistant, .msg.msg-user");
				const last = msgs[msgs.length - 1];
				const busy = document.querySelector(".switch-overlay:not(.switch-overlay-preview)");
				if (last && !busy && (marker ? last.textContent.includes(marker) : true)) mark("chat");
			}
			if (window.__ws?.readyState === 1) mark("ws");
			if (T.chat == null || T.composer == null || T.ws == null) setTimeout(check, 25);
		};
		setTimeout(check, 0);
		try {
			new PerformanceObserver((list) => {
				for (const e of list.getEntries()) if (e.name === "first-contentful-paint") T.fcp = Math.round(e.startTime);
			}).observe({ type: "paint", buffered: true });
		} catch {
			/* no paint timing */
		}
	});
}

/**
 * Open the app at `url` (e.g. "/?chat=<file>": straight into a chat) and time it until the chat can
 * be used. The page must already be on the app (same origin). cold: empty caches first.
 */
export async function measureLoad(
	kit,
	phone,
	{ url, marker = "", cold = false, settleMs = 2500, fullWaitMs = 180_000 } = {},
) {
	const { page, cdp } = phone;
	await page.evaluate((m) => sessionStorage.setItem("__phoneMarker", m), marker);
	if (cold) {
		await page.evaluate(async () => {
			for (const r of (await navigator.serviceWorker?.getRegistrations?.()) ?? []) await r.unregister();
			if (typeof caches !== "undefined") for (const k of await caches.keys()) await caches.delete(k);
		});
		await cdp.send("Network.clearBrowserCache");
	}
	await cdp.send("Network.enable");
	const files = new Map();
	const onReq = (e) => files.set(e.requestId, { url: e.request.url, bytes: 0, cached: false });
	const onResp = (e) => {
		const f = files.get(e.requestId);
		if (f) f.cached = Boolean(e.response.fromDiskCache || e.response.fromServiceWorker || e.response.fromPrefetchCache);
	};
	const onServed = (e) => {
		const f = files.get(e.requestId);
		if (f) f.cached = true;
	};
	const onDone = (e) => {
		const f = files.get(e.requestId);
		if (f) f.bytes = e.encodedDataLength;
	};
	cdp.on("Network.requestWillBeSent", onReq);
	cdp.on("Network.responseReceived", onResp);
	cdp.on("Network.requestServedFromCache", onServed);
	cdp.on("Network.loadingFinished", onDone);
	const before = kit.link.stats();
	await page.goto(url, { waitUntil: "commit" });
	await page.waitForFunction(
		() => window.__phoneT?.chat != null && window.__phoneT?.composer != null && window.__phoneT?.ws != null,
		null,
		{
			timeout: 180_000,
			polling: 100,
		},
	);
	const t = await page.evaluate(() => ({ ...window.__phoneT }));
	const atUsable = kit.link.stats();
	// The full chat (switch_done) may come after the first look at it (switch_preview).
	await page
		.waitForFunction(() => window.__frameAt?.switch_done != null, null, { timeout: fullWaitMs, polling: 100 })
		.catch(() => {});
	const frames = await page.evaluate(() => ({ ...(window.__frameAt ?? {}) }));
	const socket = await page.evaluate(() => ({
		sockets: window.__sockets ?? null,
		// kilobytes per message type (type names and sizes only)
		kbByType: Object.fromEntries(Object.entries(window.__frameBytes ?? {}).map(([k, v]) => [k, Math.round(v / 1024)])),
	}));
	await sleep(settleMs); // what loads right after still costs bytes
	const after = kit.link.stats();
	cdp.off("Network.requestWillBeSent", onReq);
	cdp.off("Network.responseReceived", onResp);
	cdp.off("Network.requestServedFromCache", onServed);
	cdp.off("Network.loadingFinished", onDone);
	const list = [...files.values()]
		.filter((f) => /^https?:/.test(f.url))
		.map((f) => ({ file: new URL(f.url).pathname.replace(/^\/assets\//, ""), bytes: f.bytes, cached: f.cached }));
	return {
		usableMs: Math.max(t.chat, t.composer, t.ws),
		chatMs: t.chat,
		composerMs: t.composer,
		wsMs: t.ws,
		fcpMs: t.fcp ?? null,
		previewMs: frames.switch_preview ?? null,
		fullChatMs: frames.switch_done ?? null,
		...socket,
		bytesDownToUsable: atUsable.down - before.down,
		bytesDown: after.down - before.down,
		files: list,
		terminalLoaded: list.some((f) => /xterm|TerminalPanel/i.test(f.file) && !f.cached),
	};
}

/** The highest "Line NNNN" of the stand-in model's streamed reply `tag` that the page shows (1e6 once
 *  its end shows; 0 while the page's latest reply is another one). */
export function visibleLine(page, tag) {
	return page.evaluate((tag) => {
		const msgs = document.querySelectorAll(".messages .msg.msg-assistant");
		const last = msgs[msgs.length - 1];
		if (!last) return 0;
		const text = last.textContent;
		if (!text.includes(` ${tag}:`) && !text.includes(`STREAM-DONE ${tag}`)) return 0;
		if (text.includes(`STREAM-DONE ${tag}`)) return 1e6;
		const at = text.lastIndexOf("Line ");
		if (at < 0) return 0;
		const n = Number(text.slice(at + 5, at + 9));
		return Number.isFinite(n) ? n : 0;
	}, tag);
}

/** Ask the stand-in model for a streamed reply (lines every everyMs); returns its tag. */
async function askForStream(page, lines, everyMs) {
	const tag = newReplyTag();
	await page.evaluate((tag) => {
		window.__streamTag = tag;
		window.__streamDoneAt = 0;
	}, tag);
	await sendFromPhone(page, `STREAM-${lines}-${everyMs}-${tag} please`);
	return tag;
}

/** Send a message from the phone's message box (Send button: Enter adds a line on phones). */
export async function sendFromPhone(page, text) {
	await page.locator(TA).fill(text);
	await page.locator(".btn.send").click();
}

/** Stop the model if it is still answering, and wait until the chat is idle. */
export async function stopReply(page) {
	for (let i = 0; i < 100; i++) {
		const stop = page.locator(".btn.stop");
		if ((await stop.count()) === 0) return;
		await stop
			.first()
			.click()
			.catch(() => {});
		await sleep(300);
	}
}

/** Is a "Reconnecting…" note on screen (anywhere)? */
export function reconnectingShown(page) {
	return page.evaluate(() => {
		for (const el of document.querySelectorAll("body *")) {
			if (el.children.length) continue;
			if (!/Reconnecting|Connecting/i.test(el.textContent || "")) continue;
			const r = el.getBoundingClientRect();
			if (
				r.width > 0 &&
				r.height > 0 &&
				r.bottom > 0 &&
				r.top < window.innerHeight &&
				getComputedStyle(el).visibility !== "hidden"
			)
				return true;
		}
		return false;
	});
}

/**
 * The chat is following a long reply; the connection gets lost (how: scenario) and comes back.
 * Returns how long after coming back the chat showed what the model had sent by then (catchupMs),
 * whether "Reconnecting…" showed meanwhile, and how many new sockets the page opened.
 *   silent:  the link goes quiet while the page is on screen (there is no "coming back": the time
 *            counts from the moment it went quiet, and the chat must show newer lines);
 *   sleep:   the phone sleeps (hidden + frozen) and the link dies meanwhile; then it wakes;
 *   hidden:  the tab is in the background and the link dies meanwhile; then the tab comes back;
 *   offline: the network goes away (the browser knows: offline) and comes back.
 */
export async function measureCatchup(
	kit,
	phone,
	scenario,
	{ awayMs = 15_000, limitMs = 90_000, lines = 1200, everyMs = 100 } = {},
) {
	const { page, context } = phone;
	// A reply from before must be over first (the message box only sends when the chat is idle).
	await stopReply(page);
	await page
		.locator(".btn.send")
		.first()
		.waitFor({ state: "visible", timeout: 30_000 })
		.catch(() => {});
	const streamBefore = streamState.startedAt;
	const tag = await askForStream(page, lines, everyMs);
	const t0 = Date.now();
	// Wait for THIS reply: the stand-in model started it and the page shows its first lines.
	while (streamState.startedAt === streamBefore || (await visibleLine(page, tag)) < 20) {
		if (Date.now() - t0 > 60_000) {
			// What the page was doing (states and message types only, no chat text).
			const state = await page.evaluate(() => ({
				ws: window.__ws?.readyState,
				sockets: window.__sockets,
				quietMs: Date.now() - (window.__lastFrameAt || 0),
				stop: document.querySelectorAll(".btn.stop").length,
				send: document.querySelectorAll(".btn.send").length,
				boxEmpty: (document.querySelector(".inputbox textarea")?.value ?? "") === "",
				lastTypes: (window.__frames || []).slice(-12).map((f) => (/^\{"type":"([a-z_]+)"/.exec(f) || [])[1] || "?"),
			}));
			const modelStarted = streamState.startedAt !== streamBefore;
			const shown = { line: await visibleLine(page, tag) };
			return {
				scenario,
				error: `the streamed reply never showed (model started: ${modelStarted}, ${JSON.stringify({ ...shown, ...state })})`,
			};
		}
		await sleep(100);
	}
	const socketsBefore = await page.evaluate(() => window.__sockets);
	let target;
	let back;
	if (scenario === "silent") {
		kit.link.silence();
		back = Date.now();
		target = linesSentNow() + 1;
	} else {
		if (scenario === "sleep") {
			kit.link.silence();
			await phone.sleep();
		} else if (scenario === "hidden") {
			await phone.setHidden(true);
			kit.link.silence();
		} else if (scenario === "offline") {
			kit.link.offline(true);
			await context.setOffline(true);
		}
		await sleep(awayMs);
		if (scenario === "sleep") {
			await phone.wake();
		} else if (scenario === "hidden") {
			await phone.setHidden(false);
		} else if (scenario === "offline") {
			kit.link.offline(false);
			await context.setOffline(false);
		}
		back = Date.now();
		target = linesSentNow();
	}
	let note = false;
	let catchupMs = null;
	while (Date.now() - back < limitMs) {
		if (!note && (await reconnectingShown(page))) note = true;
		if ((await visibleLine(page, tag)) >= target) {
			catchupMs = Date.now() - back;
			break;
		}
		await sleep(100);
	}
	const sockets = (await page.evaluate(() => window.__sockets)) - socketsBefore;
	// Once caught up the note must go away again.
	let noteGone = null;
	if (catchupMs != null) {
		const until = Date.now() + 5000;
		while (Date.now() < until && (await reconnectingShown(page))) await sleep(100);
		noteGone = !(await reconnectingShown(page));
	}
	await stopReply(page);
	return { scenario, catchupMs, limitMs, reconnectingNote: note, noteGone, newSockets: sockets, target };
}

/**
 * A long reply on the slow link: how smoothly it shows. maxGapMs: the longest time the page showed no
 * new line while the model was still sending; endLagMs: how long after the model finished the page
 * showed the end; complete: the page shows the whole reply; newSockets: reconnects meanwhile.
 */
export async function measureStream(kit, phone, { lines = 600, everyMs = 50, limitMs = 180_000 } = {}) {
	const { page } = phone;
	// A reply from before must be over first, and only THIS reply counts (an earlier one has lines too).
	await stopReply(page);
	const streamBefore = streamState.startedAt;
	const socketsBefore = await page.evaluate(() => window.__sockets);
	const typesBefore = await page.evaluate(() => ({ ...(window.__frameBytes ?? {}) }));
	const bytesBefore = kit.link.stats().down;
	const tag = await askForStream(page, lines, everyMs);
	const t0 = Date.now();
	let last = 0;
	let lastChange = Date.now();
	let maxGapMs = 0;
	let firstAt = null;
	let doneAt = null;
	const started = () => streamState.startedAt !== streamBefore;
	const modelEndsAt = () => (started() && linesSentNow() >= lines ? Date.now() : null);
	let modelEnd = null;
	while (Date.now() - t0 < limitMs) {
		const n = started() ? await visibleLine(page, tag) : 0;
		const now = Date.now();
		if (n > last) {
			if (firstAt == null) firstAt = now - t0;
			// Only while the model is still sending does a pause count as a freeze.
			if (last > 0 && (modelEnd == null || lastChange < modelEnd)) maxGapMs = Math.max(maxGapMs, now - lastChange);
			last = n;
			lastChange = now;
		}
		modelEnd = modelEnd ?? modelEndsAt();
		if (n >= 1e6) {
			doneAt = now;
			break;
		}
		await sleep(100);
	}
	const sockets = (await page.evaluate(() => window.__sockets)) - socketsBefore;
	// Where the end's lag is: getting to the page (link, server) or showing it (the page).
	const endArrivedAt = await page.evaluate(() => window.__streamDoneAt || 0);
	const typesAfter = await page.evaluate(() => ({ ...(window.__frameBytes ?? {}) }));
	const frameBytes = {};
	for (const [k, v] of Object.entries(typesAfter)) {
		const d = v - (typesBefore[k] ?? 0);
		if (d > 0) frameBytes[k] = d;
	}
	await stopReply(page);
	return {
		lines,
		everyMs,
		modelStarted: started(),
		firstLineMs: firstAt,
		maxGapMs,
		complete: doneAt != null,
		endLagMs: doneAt != null && modelEnd != null ? doneAt - modelEnd : null,
		endArrivedMs: endArrivedAt && modelEnd != null ? endArrivedAt - modelEnd : null,
		endShownAfterArrivalMs: endArrivedAt && doneAt != null ? doneAt - endArrivedAt : null,
		newSockets: sockets,
		bytesDown: kit.link.stats().down - bytesBefore,
		frameBytes,
	};
}

/** Tap targets on the chat screen, in the ⋯ menu and in the chats drawer. */
export async function measureTargets(phone, { shots = "" } = {}) {
	const { page } = phone;
	const main = [".btn.send"];
	const res = {};
	res.chat = await tapTargets(
		page,
		[".topbar", ".quick-row", ".inputbox", ".statusbar", ".goal-bar, [class*='goal-pill']"],
		{
			mainSelectors: main,
		},
	);
	res.messageActions = await tapTargets(page, [".messages .msg:last-of-type"], {});
	if (shots) await page.screenshot({ path: `${shots}-chat.png` });
	const more = page.locator(".plugin-topbar-more > button").first();
	if ((await more.count()) > 0 && (await more.isVisible())) {
		await more.click();
		await sleep(400);
		res.moreMenu = await tapTargets(page, [".plugin-topbar-menu"], {});
		if (shots) await page.screenshot({ path: `${shots}-more.png` });
		await page.keyboard.press("Escape");
		if ((await more.getAttribute("aria-expanded")) === "true") await more.click();
		await sleep(200);
	}
	const history = page.locator(".topbar button.panel-toggle").first();
	if ((await history.count()) > 0 && (await history.isVisible())) {
		await history.click();
		await sleep(500);
		res.drawer = await tapTargets(page, [".panel-drawer.drawer-left.open"], {});
		if (shots) await page.screenshot({ path: `${shots}-drawer.png` });
		await closeDrawers(page);
	}
	const summary = {};
	for (const [k, v] of Object.entries(res)) {
		summary[k] = {
			count: v.targets.length,
			small: v.targets.filter((t) => t.w < 44 || t.h < 44).map((t) => `${t.name} ${t.w}x${t.h}`),
			mainSmall: v.targets.filter((t) => t.main && (t.w < 48 || t.h < 48)).map((t) => `${t.name} ${t.w}x${t.h}`),
			overlaps: v.overlaps.map((p) => p.join(" / ")),
			cut: v.cut,
		};
	}
	return { summary, raw: res };
}

/** Close any open side drawer (Escape, then a tap on the dimmed area beside it). */
export async function closeDrawers(page) {
	for (let i = 0; i < 4; i++) {
		if ((await page.locator(".panel-drawer.open").count()) === 0) return;
		await page.keyboard.press("Escape");
		await sleep(250);
		if ((await page.locator(".panel-drawer.open").count()) === 0) return;
		const left = (await page.locator(".panel-drawer.drawer-left.open").count()) > 0;
		const { width, height } = page.viewportSize();
		await page.mouse.click(left ? width - 8 : 8, Math.round(height / 2));
		await sleep(350);
	}
}

/** Where things are with the on-screen keyboard up, then while a message grows line by line. */
export async function measureKeyboard(phone, { shots = "" } = {}) {
	const { page } = phone;
	const ta = page.locator(TA);
	await ta.click();
	await ta.fill("");
	const geo = () =>
		page.evaluate((sel) => {
			const r = (q) => {
				const el = document.querySelector(q);
				if (!el) return null;
				const b = el.getBoundingClientRect();
				return {
					top: Math.round(b.top),
					bottom: Math.round(b.bottom),
					left: Math.round(b.left),
					right: Math.round(b.right),
				};
			};
			const list = document.querySelector(".messages");
			const scroller = list
				? list.scrollHeight > list.clientHeight
					? list
					: (list.closest("[class*='scroll']") ?? list)
				: null;
			return {
				vh: window.innerHeight,
				vw: window.innerWidth,
				docScroll: Math.round(document.scrollingElement.scrollTop),
				topbar: r(".topbar"),
				composer: r(".inputbox"),
				textarea: r(sel),
				send: r(".btn.send"),
				fromBottom: scroller ? Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) : null,
			};
		}, TA);
	const before = await geo();
	await phone.keyboard.show();
	await sleep(600);
	const up = await geo();
	if (shots) await page.screenshot({ path: `${shots}-keyboard.png` });
	const visible = (b, g) => b && b.top >= 0 && b.bottom <= g.vh && b.left >= 0 && b.right <= g.vw;
	const growth = [];
	for (let i = 1; i <= 7; i++) {
		await phone.typeLikeAndroid(`line ${i} of a message that grows`);
		if (i < 7) await page.keyboard.press("Enter");
		await sleep(250);
		const g = await geo();
		growth.push({
			line: i,
			topbarTop: g.topbar?.top,
			docScroll: g.docScroll,
			composerVisible: visible(g.composer, g),
			sendVisible: visible(g.send, g),
			fromBottom: g.fromBottom,
		});
	}
	if (shots) await page.screenshot({ path: `${shots}-keyboard-typed.png` });
	const value = await ta.inputValue();
	await ta.fill("");
	await phone.keyboard.hide();
	await sleep(300);
	// Keyboard down, then up again: the chat must still be following (the keyboard going down pulls
	// the list back, which must not read as the user scrolling up).
	await phone.keyboard.show();
	await sleep(600);
	const again = await geo();
	await phone.keyboard.hide();
	await sleep(300);
	return {
		before: { fromBottom: before.fromBottom },
		upAgain: { fromBottom: again.fromBottom },
		keyboardUp: {
			composerVisible: visible(up.composer, up),
			sendVisible: visible(up.send, up),
			topbarTop: up.topbar?.top,
			docScroll: up.docScroll,
			fromBottom: up.fromBottom,
		},
		growth,
		enterAddsLine: value.split("\n").length === 7,
	};
}

/** The / and @ menu above the message box: open?, how many rows, and whether it fits on screen. */
function menuState(page) {
	return page.evaluate(() => {
		const m = document.querySelector(".slash-menu");
		if (!m) return { open: false };
		const r = m.getBoundingClientRect();
		return {
			open: true,
			items: m.querySelectorAll(".slash-item").length,
			onScreen: r.top >= 0 && r.bottom <= window.innerHeight + 0.5 && r.left >= 0 && r.right <= window.innerWidth + 0.5,
		};
	});
}

/** The menu's state once it opened (the @ menu waits for the server's file search), or closed after `ms`. */
async function openedMenuState(page, ms = 8_000) {
	const until = Date.now() + ms;
	let s = await menuState(page);
	while (!s.open && Date.now() < until) {
		await new Promise((r) => setTimeout(r, 100));
		s = await menuState(page);
	}
	return s;
}

/** Android-style typing (IME composition, word by word): plain, in the middle, in the / and @ menus. */
export async function measureTyping(phone) {
	const { page } = phone;
	const ta = page.locator(TA);
	const res = {};
	const state = () => ta.evaluate((el) => ({ value: el.value, caret: el.selectionStart, end: el.selectionEnd }));
	await ta.click();
	await ta.fill("");
	await phone.typeLikeAndroid("hello world from the phone");
	res.plain = await state();
	res.plainOk = res.plain.value === "hello world from the phone" && res.plain.caret === res.plain.value.length;
	// In the middle: after "hello ".
	await ta.evaluate((el) => el.setSelectionRange(6, 6));
	await phone.typeLikeAndroid("big ");
	res.middle = await state();
	res.middleOk = res.middle.value === "hello big world from the phone" && res.middle.caret === 10;
	// Slash menu.
	await ta.fill("");
	await phone.typeLikeAndroid("/comp");
	res.slash = await state();
	res.slashMenu = await openedMenuState(page);
	res.slashOk = res.slash.value === "/comp" && res.slash.caret === 5;
	await page.keyboard.press("Escape");
	// Mention menu.
	await ta.fill("");
	await phone.typeLikeAndroid("look at @src");
	res.mention = await state();
	res.mentionMenu = await openedMenuState(page);
	res.mentionOk = res.mention.value === "look at @src" && res.mention.caret === 12;
	await page.keyboard.press("Escape");
	await ta.fill("");
	return res;
}
