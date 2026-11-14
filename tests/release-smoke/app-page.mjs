/**
 * The app in a headless Chrome window, for the release smoke tests.
 *
 * Every window's socket says hello with a fixed "carry-on:" client id (the server treats that prefix as
 * a background client: it starts on a blank chat of its own, never adopts a chat someone has open and
 * never marks a chat read). The page keeps protocol facts only: socket readiness, the running list
 * (ids and paths), new_chat answers, and its current chat's snapshot (kept up to date from deltas).
 * Ported from Ops's pi-web-check (agent-tools lib/pi-web-check.mjs), which did the live checks before.
 */
import { existsSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { holds, unsure, waitFor } from "./harness.mjs";

const INLINE_PICTURE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]{200}/gi;

/** Chrome for the smoke tests; missing Chrome is "unsure", not a pi-web-ui failure. */
export async function launchBrowser() {
	let chromium;
	let executablePath;
	try {
		({ chromium } = await import("playwright-core"));
		({ CHROME_PATH: executablePath } = await import("../lib/chrome.mjs"));
	} catch (err) {
		throw unsure(`playwright-core isn't installed here: ${err.message}`);
	}
	if (!executablePath) throw unsure("no headless Chrome found (set PI_WEB_CHROME)");
	try {
		// The browser outlives a stop signal so the check in progress can still close its chat (harness.mjs).
		return await chromium.launch({ executablePath, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
	} catch (err) {
		throw unsure(`headless Chrome didn't start: ${err.message}`);
	}
}

function pageScript({ clientId, inlinePattern }) {
	try {
		localStorage.setItem("pi-web-ui:lang", "en");
	} catch {}
	const s = (window.__smoke = {
		sockets: [],
		ready: false,
		attached: false,
		lists: 0,
		conversations: [],
		newChats: Object.create(null),
		state: null,
		want: null,
		wantSnap: null,
		paging: { outstanding: 0, answers: 0 },
	});
	const PAGING_REQUESTS = ["load_older", "load_earlier_messages", "load_folded", "load_exchanges"];
	const PAGING_ANSWERS = ["older_messages", "earlier_messages", "folded_messages", "older_exchanges"];
	const Orig = window.WebSocket;
	const send = Orig.prototype.send;
	Orig.prototype.send = function (data) {
		if (typeof data === "string") {
			try {
				const m = JSON.parse(data);
				if (m?.type === "hello") data = JSON.stringify({ ...m, clientId });
				if (PAGING_REQUESTS.includes(m?.type)) s.paging.outstanding++;
			} catch {}
		}
		return send.call(this, data);
	};
	window.WebSocket = class extends Orig {
		constructor(...a) {
			super(...a);
			if (!/\/ws(\?|$)/.test(String(a[0]))) return;
			s.sockets.push(this);
			this.addEventListener("message", (ev) => {
				const raw = String(ev.data);
				let m;
				try {
					m = JSON.parse(raw);
				} catch {
					return;
				}
				if (PAGING_ANSWERS.includes(m.type)) {
					s.paging.answers++;
					s.paging.outstanding = Math.max(0, s.paging.outstanding - 1);
				}
				if (m.type === "ready") {
					s.ready = true;
					s.attached = false;
				} else if (m.type === "session_initialized") s.attached = true;
				else if (m.type === "conversations" && Array.isArray(m.conversations)) {
					s.conversations = m.conversations.map((c) => ({
						id: c.id,
						sessionPath: c.sessionPath ?? null,
						live: c.live !== false,
					}));
					s.lists++;
				} else if (m.type === "new_chat_result" && typeof m.reqId === "string") s.newChats[m.reqId] = m.ok === true;
				else if (m.type === "snapshot") {
					s.state = m.state ?? null;
					const st = s.state ?? {};
					if (!s.wantSnap && s.want && st.sessionFile === s.want && Array.isArray(st.messages)) {
						s.wantSnap = { len: raw.length, inline: (raw.match(new RegExp(inlinePattern, "gi")) || []).length };
					}
				} else if (m.type === "snapshot_delta") {
					const st = s.state;
					if (st && st.rev === m.baseRev && m.conversationId === st.conversationId) {
						s.state = { ...st, ...m.state, messages: [...(st.messages ?? []), ...(m.appended ?? [])] };
					} else {
						const ws = s.sockets.filter((x) => x.readyState === 1).pop();
						ws?.send(JSON.stringify({ type: "get_state" }));
					}
				}
			});
		}
	};
}

/** Send a protocol message on the page's open socket; false when it has none. */
export function pageSend(page, msg) {
	return page.evaluate((m) => {
		const ws = window.__smoke.sockets.filter((x) => x.readyState === 1).pop();
		if (!ws) return false;
		ws.send(JSON.stringify(m));
		return true;
	}, msg);
}

/** Read the page's protocol facts (window.__smoke) through fn. */
export const smokeState = (page, fn, arg) => page.evaluate(fn, arg);

/**
 * Open `url` in a new window whose socket uses `clientId`; resolves once the socket says ready (and,
 * with attached, once the server has attached the window and takes its commands).
 */
export async function openApp(browser, url, clientId, { readyMs, attached = false }) {
	const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
	await ctx.addInitScript(pageScript, { clientId, inlinePattern: INLINE_PICTURE.source });
	const page = await ctx.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e?.message ?? e).slice(0, 160)));
	const pictureStatuses = [];
	page.on("response", (r) => {
		if (r.url().includes("/api/chat-image/")) pictureStatuses.push(r.status());
	});
	const opened = { ctx, page, errors, pictureStatuses };
	try {
		const res = await page.goto(url, { timeout: readyMs, waitUntil: "domcontentloaded" });
		if (!res || res.status() >= 400) throw new Error(`${url} answered ${res ? res.status() : "nothing"}`);
		await page.waitForSelector(".topbar", { timeout: readyMs }).catch(() => {
			throw new Error(`the page never drew its top bar within ${Math.round(readyMs / 1000)} s`);
		});
		await waitFor(
			() => page.evaluate(() => window.__smoke.ready && window.__smoke.sockets.some((x) => x.readyState === 1)),
			readyMs,
			"ready from the page's socket",
		);
		if (attached) {
			await waitFor(
				() => page.evaluate(() => window.__smoke.attached && window.__smoke.sockets.some((x) => x.readyState === 1)),
				readyMs,
				"attach from the server (session_initialized)",
			);
		}
		return opened;
	} catch (err) {
		await ctx.close().catch(() => {});
		throw err;
	}
}

/**
 * After its window has closed, make sure the blank chat it parked on left no folder behind: the server
 * keeps an empty ephemeral-sessions/<id> folder for some closed blank chats. Conversation ids are never
 * reused while the server runs, so the folder is this run's; only an empty one is removed.
 */
export async function removeParkedFolder(agentDir, conv, notes) {
	if (!conv) return;
	const dir = join(agentDir, "ephemeral-sessions", conv);
	await holds(() => !existsSync(dir), 2_000, 250);
	if (!existsSync(dir)) return;
	if (readdirSync(dir).length) {
		notes.push(`the blank chat it parked on (${conv}) still has files; left them`);
		return;
	}
	try {
		rmdirSync(dir);
	} catch (err) {
		if (err.code === "ENOENT") return; // the server removed it meanwhile
		throw err;
	}
	notes.push(`the server left the parked blank chat's empty folder (${conv}); removed it`);
}

/**
 * Move the window off its chat to a new blank throwaway chat, so the chat it leaves closes by itself
 * without marking any other chat read (pi-web-check's parkOnBlankChat, Ops #706/#714).
 * Returns { moved: true } or { moved: false, why }; the blank chat's id goes into `parked`.
 */
export async function parkOnBlankChat(page, { stillOn, waitMs, parked }) {
	const reqId = `release-smoke-park-${Date.now()}`;
	const sent = await pageSend(page, { type: "new_chat", ephemeral: true, reqId });
	const answer = () => page.evaluate((id) => window.__smoke.newChats[id] ?? null, reqId);
	const answered = sent && (await holds(async () => (await answer()) !== null, waitMs));
	const accepted = answered && (await answer()) === true;
	const moved = accepted && (await holds(async () => !(await stillOn()), 10_000));
	if (moved) {
		const conv = await page.evaluate(() => window.__smoke.state?.conversationId ?? null);
		if (conv) parked.push(conv);
		return { moved: true };
	}
	return {
		moved: false,
		why: !sent
			? "no open socket"
			: !answered
				? "no answer"
				: !accepted
					? "the server refused"
					: "it still showed the chat",
	};
}
