/* role-message-fold E2E (no tokens: a stand-in model that is never called).
 *
 * The owner, 2026-10-06: "Make the agent to agent messages collapsed by default, right now It can take
 * too much space and its not relevant to me most of the time". A seeded chat holds role messages of
 * every shape: a question, a request and an FYI the server's store confirms, a 6 am report request and
 * a reply it doesn't (shown from their first line), a broken header, the queue's "[Queue] …" message, an
 * owner message, and two message_role calls (one sent, one held) next to a bash call.
 *  1. Every role message is one folded row (a button, aria-expanded false): who it is from, its kind and
 *     its first words as plain text; no header line, no hint line, no Markdown, and words deep in the
 *     body aren't on the page. The broken header, the queue's message and the owner's stay as they are.
 *  2. A click opens one (the card, Markdown drawn, focus on its fold button); Enter folds it again and
 *     opens it again. It stays open when the page goes to another chat and back.
 *  3. Ctrl+F finds a word inside a folded message and opens it; closing the search folds it back.
 *  4. message_role cards are folded with the tool-details switch on (a bash card next to them is open):
 *     "To temper · reply to rm-… · first words" and the id it was sent (or held) under. A click opens one.
 *  5. axe finds nothing serious or critical in the rows and cards; targets are big enough; nothing
 *     scrolls sideways; dark and white, desktop and phone (screenshots with ROLE_FOLD_SHOT=<dir>).
 *  6. No line of the transcripts changed and no message was added (opening a chat may only add the
 *     SDK's thinking-level entry), the model was never called, and the page logged no error.
 * Usage: npm run build && node tests/role-message-fold-test.mjs
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { roleMessageText, sha1 } from "../dist/server/role-messages.js";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";

const AXE = process.env.PI_AXE_JS ?? join(userInfo().homedir, "temper-ai/configs/design/bin/vendor/axe-4.13.0.min.js");
const SHOTS = process.env.ROLE_FOLD_SHOT || "";

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures += 1;
}
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
async function waitFor(fn, timeout = 15_000, step = 100) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		try {
			const v = await fn();
			if (v) return v;
		} catch {
			/* not yet */
		}
		await sleep(step);
	}
	return null;
}

// ---- the seeded chats ------------------------------------------------------------------------------------
const NOW = Date.now() - 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
let seq = 0;
let clock = NOW;
const eid = () => `f${(++seq).toString(16).padStart(7, "0")}`;
const tick = () => (clock += 1000);
const msg = (message) => {
	const ts = tick();
	return { type: "message", id: eid(), timestamp: iso(ts), message: { ...message, timestamp: ts } };
};
const user = (text) => msg({ role: "user", content: [{ type: "text", text }] });
const assistant = (content, stopReason = "stop") =>
	msg({
		role: "assistant",
		content: typeof content === "string" ? [{ type: "text", text: content }] : content,
		api: "openai-completions",
		provider: "mock",
		model: "mock-model",
		usage,
		stopReason,
	});
const toolResult = (toolCallId, toolName, text, details) =>
	msg({
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		...(details ? { details } : {}),
		isError: false,
	});
const fyiEntry = (text) => {
	const ts = tick();
	return {
		type: "custom_message",
		customType: "role-message",
		content: [{ type: "text", text }],
		display: true,
		id: eid(),
		timestamp: iso(ts),
	};
};

const LONG =
	"Here is the longer part of the message, which goes on for a while so that it can't fit in the one line of the folded row, whatever the screen.";
const Q = {
	id: "rm-0000a001",
	from: { role: "temper", title: "Temper engine", chat: "home chat" },
	kind: "question",
	text: `Can you check the **queue page** deploy for me? ${LONG}\n\nThe word ZEBRAQUARTZ is deep inside, so only the open card or a search shows it.`,
};
const FYI = {
	id: "rm-0000a003",
	from: { role: "architecture", title: "System architecture", chat: "Queue #12" },
	kind: "fyi",
	text: `The land check for #50 passed with no conditions. ${LONG}`,
};
const REQ = {
	id: "rm-0000a004",
	from: { role: "ops", title: "ops/tooling", chat: `chat "Fold role messages"` },
	kind: "request",
	text: `Please restart the box browser after lunch. ${LONG}`,
};
const REPORT = {
	id: "rm-0000a005",
	from: { role: "app", title: "the app", chat: "home chat" },
	kind: "report",
	report: { date: "2026-10-06" },
	text: `Write your 6 am report for yesterday. ${LONG}`,
};
const REPLY = {
	id: "rm-0000a006",
	from: { role: "qa", title: "QA", chat: "home chat" },
	kind: "reply",
	replyTo: "rm-0000a009",
	text: `Yes, the screenshots are in. ${LONG}`,
};
const BROKEN = "[Role message rm-0000a007 from qa (QA), sent from its home chat\n\nA header that never closed.";
const QUEUE = "[Queue] Task #4: Build the thing\n\nThe plan as approved.";
const STAMPED = [Q, FYI, REQ];
const ROWS = [Q, FYI, REQ, REPORT, REPLY];

const MR_SENT = {
	to: "temper",
	kind: "reply",
	replyTo: "rm-0000a001",
	text: "Checked it: the queue page deploy is fine, nothing to do.",
};
const MR_HELD = { to: "qa", kind: "question", text: "Are the screenshots in yet? Need them for the land check." };

let chatFile = "";
let otherFile = "";
let sessionsDir = "";
function seed({ dataDir, agentDir, workdir }) {
	sessionsDir = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(sessionsDir, { recursive: true });
	const sid = "01a0f075-0000-7000-8000-00000000f075";
	chatFile = join(sessionsDir, `2026-10-06T10-00-00-000Z_${sid}.jsonl`);
	const lines = [
		user("Owner here: please keep an eye on the deploys today."),
		assistant("Will do."),
		user(roleMessageText(Q)),
		assistant(
			[
				{ type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "echo CONTROL-BASH" } },
				{ type: "toolCall", id: "call-mr1", name: "message_role", arguments: MR_SENT },
				{ type: "toolCall", id: "call-mr2", name: "message_role", arguments: MR_HELD },
			],
			"toolUse",
		),
		toolResult("call-bash", "bash", "CONTROL-BASH"),
		toolResult("call-mr1", "message_role", "Sent rm-0000a002 (reply to temper). It goes to temper's home chat.", {
			id: "rm-0000a002",
			to: "temper",
			kind: "reply",
			chain: 2,
			state: "waiting",
		}),
		toolResult("call-mr2", "message_role", "Held rm-0000a008 (question to qa): the owner has paused role messages.", {
			id: "rm-0000a008",
			to: "qa",
			kind: "question",
			chain: 2,
			state: "held",
		}),
		assistant("Answered temper."),
		fyiEntry(roleMessageText(FYI)),
		user(roleMessageText(REQ)),
		assistant("Done."),
		user(roleMessageText(REPORT)),
		assistant("Report written."),
		user(roleMessageText(REPLY)),
		assistant("Thanks."),
		user(BROKEN),
		assistant("That one came in broken."),
		user(QUEUE),
		assistant("Queued task done."),
	];
	writeChat(chatFile, sid, workdir, lines);
	const sid2 = "01a0f075-0000-7000-8000-00000000f076";
	otherFile = join(sessionsDir, `2026-10-06T09-00-00-000Z_${sid2}.jsonl`);
	writeChat(otherFile, sid2, workdir, [user("A second chat."), assistant("Hello.")]);
	// The store confirms three of them (same chat, same text), like messages it delivered itself.
	const records = STAMPED.map((r, i) => ({
		id: r.id,
		at: NOW + i,
		from: { ...r.from, file: join(sessionsDir, "elsewhere.jsonl") },
		to: { role: "coo", title: "COO" },
		kind: r.kind,
		chain: 1,
		text: r.text,
		state: "delivered",
		target: chatFile,
		targetChat: "home chat",
		scanFrom: 0,
		hash: sha1(roleMessageText(r)),
		sends: 1,
		attempts: 0,
		deliveredAt: NOW + 1000 + i,
	}));
	writeFileSync(join(dataDir, "role-messages.json"), JSON.stringify({ v: 1, paused: false, messages: records }));
}
function writeChat(path, sessionId, cwd, lines) {
	let parent = null;
	const chained = lines.map((l) => {
		const out = { ...l, parentId: parent };
		parent = l.id;
		return out;
	});
	const head = { type: "session", version: 3, id: sessionId, timestamp: iso(NOW - 1000), cwd };
	writeFileSync(path, `${[head, ...chained].map((l) => JSON.stringify(l)).join("\n")}\n`);
}

let modelCalls = 0;
const srv = await ownServer({
	name: "role-message-fold",
	verbose: !!process.env.ROLE_FOLD_DEBUG,
	mock: () => {
		modelCalls += 1;
		return "ok";
	},
	prepare: seed,
});
const before = { chat: sha(chatFile), other: sha(otherFile) };
const beforeText = { chat: readFileSync(chatFile, "utf8"), other: readFileSync(otherFile, "utf8") };

// ---- the browser -----------------------------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const pageErrors = [];
async function openPage({ width, height, phone = false, theme = null }) {
	const context = await browser.newContext({
		viewport: { width, height },
		deviceScaleFactor: 1,
		isMobile: phone,
		hasTouch: phone,
		locale: "en-US",
	});
	await context.addInitScript((t) => {
		localStorage.setItem("pi-web-ui:lang", "en");
		if (t) localStorage.setItem("pi-web-ui:theme", t);
		else localStorage.removeItem("pi-web-ui:theme");
		const Orig = window.WebSocket;
		window.WebSocket = class extends Orig {
			constructor(...a) {
				super(...a);
				window.__ws = this;
			}
		};
	}, theme);
	const page = await context.newPage();
	page.on("pageerror", (e) => pageErrors.push(String(e)));
	page.on("console", (m) => {
		if (m.type() === "error" && !/favicon|Failed to load resource/i.test(m.text())) pageErrors.push(m.text());
	});
	await page.goto(`${srv.http}/?chat=${encodeURIComponent(chatFile)}`);
	await page.waitForSelector(".messages .rolemsg-row", { timeout: 30_000 });
	await waitFor(() =>
		page.evaluate((n) => document.querySelectorAll(".messages .rolemsg-row").length >= n, ROWS.length),
	);
	await page.evaluate(() => document.fonts?.ready);
	return { context, page };
}
const rowSel = (id) => `.messages .rolemsg-row[data-role-message="${id}"]`;
const cardSel = (id) => `.messages .rolemsg-card[data-role-message="${id}"]`;
const listText = (page) => page.evaluate(() => document.querySelector(".messages")?.innerText ?? "");
/** Opens the folded steps of every exchange (the message_role calls sit inside one). */
async function openSteps(page) {
	await page.evaluate(() => {
		for (const h of document.querySelectorAll('.messages .xfold-head[aria-expanded="false"]')) h.click();
	});
	await waitFor(() => page.evaluate(() => document.querySelectorAll(".messages .toolcall").length >= 3));
}
const toolCard = (page, name, n = 0) =>
	page.evaluate(
		({ name, n }) => {
			const cards = [...document.querySelectorAll(".messages .toolcall")].filter(
				(c) => c.querySelector(".toolcall-name")?.textContent === name,
			);
			const c = cards[n];
			if (!c) return null;
			const nameEl = c.querySelector(".toolcall-name");
			return {
				nameCut: nameEl.scrollWidth > nameEl.clientWidth + 1,
				expanded: c.querySelector(".toolcall-head")?.getAttribute("aria-expanded"),
				line: c.querySelector(".toolcall-rolemsg")?.textContent ?? "",
				sent: c.querySelector(".toolcall-rolemsg-id")?.textContent ?? "",
				text: c.innerText,
			};
		},
		{ name, n },
	);
async function runAxe(page) {
	if (!existsSync(AXE)) return { error: `axe-core not found at ${AXE} (set PI_AXE_JS)` };
	await page.addScriptTag({ path: AXE });
	return page.evaluate(async () => {
		const include = [...document.querySelectorAll(".messages .rolemsg-row, .messages .rolemsg-card")];
		const r = await window.axe.run(include, {
			runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
			resultTypes: ["violations"],
		});
		return {
			bad: r.violations
				.filter((v) => v.impact === "serious" || v.impact === "critical")
				.map(
					(v) =>
						`${v.id}: ${v.nodes
							.slice(0, 3)
							.map((n) => n.target.join(" "))
							.join(", ")}`,
				),
		};
	});
}
async function shot(page, name, showSel = null) {
	if (!SHOTS) return;
	if (showSel) await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "center" }), showSel);
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}
/** Sizes: every row's button, overflow sideways. */
const measure = (page) =>
	page.evaluate(() => {
		const btns = [...document.querySelectorAll(".messages .rolemsg-row-btn")];
		const root = document.querySelector(".messages");
		return {
			minHeight: Math.min(...btns.map((b) => b.getBoundingClientRect().height)),
			oneLine: btns.every((b) => {
				const p = b.querySelector(".rolemsg-row-preview");
				return !p || p.scrollHeight <= p.clientHeight + 1;
			}),
			overflowX: Math.max(root.scrollWidth - root.clientWidth, document.documentElement.scrollWidth - innerWidth),
		};
	});

// =========================================================================================================
// 1. Desktop, dark: folded rows
// =========================================================================================================
const { context: deskCtx, page } = await openPage({ width: 1280, height: 900 });
{
	const rows = await page.evaluate(() =>
		[...document.querySelectorAll(".messages .rolemsg-row")].map((r) => ({
			id: r.getAttribute("data-role-message"),
			cls: r.className,
			expanded: r.querySelector("button")?.getAttribute("aria-expanded"),
			from: r.querySelector(".rolemsg-row-from")?.textContent ?? "",
			kind: r.querySelector(".rolemsg-row-kind")?.textContent ?? "",
			preview: r.querySelector(".rolemsg-row-preview")?.textContent ?? "",
			strong: r.querySelectorAll("strong, em, code, a").length,
		})),
	);
	check(
		"every role message is one folded row",
		rows.length === ROWS.length && ROWS.every((m) => rows.some((r) => r.id === m.id)),
		JSON.stringify(rows.map((r) => r.id)),
	);
	check(
		"each row is a button with aria-expanded false",
		rows.every((r) => r.expanded === "false"),
		JSON.stringify(rows.map((r) => r.expanded)),
	);
	const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
	check(
		"question row: from temper, kind, first words in plain text",
		byId[Q.id]?.from === "From temper" &&
			byId[Q.id]?.kind === "question" &&
			byId[Q.id]?.preview.startsWith("Can you check the queue page deploy"),
		JSON.stringify(byId[Q.id]),
	);
	check(
		"FYI added without a turn folds too",
		byId[FYI.id]?.from === "From architecture" && byId[FYI.id]?.kind === "fyi",
		JSON.stringify(byId[FYI.id]),
	);
	check(
		"request row",
		byId[REQ.id]?.kind === "request" && byId[REQ.id]?.preview.startsWith("Please restart"),
		JSON.stringify(byId[REQ.id]),
	);
	check(
		"6 am report request row",
		byId[REPORT.id]?.from === "From the app" && byId[REPORT.id]?.kind === "6 am report \u00b7 2026-10-06",
		JSON.stringify(byId[REPORT.id]),
	);
	check(
		"reply row names what it answers",
		byId[REPLY.id]?.kind === "reply to rm-0000a009" && byId[REPLY.id]?.from === "From qa",
		JSON.stringify(byId[REPLY.id]),
	);
	check(
		"stamped rows read as confirmed, unconfirmed ones are marked",
		!byId[Q.id]?.cls.includes("rolemsg-unstamped") &&
			byId[REPLY.id]?.cls.includes("rolemsg-unstamped") &&
			byId[REPORT.id]?.cls.includes("rolemsg-unstamped"),
		JSON.stringify(rows.map((r) => r.cls)),
	);
	check(
		"no Markdown is drawn in a folded row",
		rows.every((r) => r.strong === 0),
	);
	const text = await listText(page);
	check("words deep in a folded body aren't on the page", !text.includes("ZEBRAQUARTZ"));
	check(
		"no hint line on the page",
		!text.includes("(A request:") && !text.includes("(An FYI from another role") && !text.includes("Answer it once"),
	);
	check(
		"no header line of a folded message on the page",
		!text.includes("[Role message rm-0000a001") && !text.includes("[Role message rm-0000a006"),
	);
	check(
		"a broken header stays a plain message",
		text.includes("[Role message rm-0000a007") && !(await page.$(rowSel("rm-0000a007"))),
	);
	check(
		"the queue's message and the owner's stay as they are",
		text.includes("[Queue] Task #4: Build the thing") && text.includes("Owner here: please keep an eye"),
	);
	const m = await measure(page);
	check(
		"rows are one line, at least 24 px high, nothing scrolls sideways",
		m.oneLine && m.minHeight >= 24 && m.overflowX <= 1,
		JSON.stringify(m),
	);
	await shot(page, "desktop-dark-folded", rowSel(Q.id));
}

// =========================================================================================================
// 2. Open with a click, fold and open with Enter; it stays open across a chat switch
// =========================================================================================================
{
	await page.click(`${rowSel(Q.id)} button`);
	const opened = await waitFor(() => page.$(cardSel(Q.id)));
	const card = opened
		? await page.evaluate((sel) => {
				const c = document.querySelector(sel);
				const b = c.querySelector("button.rolemsg-fold");
				return {
					expanded: b?.getAttribute("aria-expanded"),
					focused: document.activeElement === b,
					strong: c.querySelector(".rolemsg-body strong")?.textContent ?? "",
					text: c.innerText,
				};
			}, cardSel(Q.id))
		: null;
	check(
		"a click opens the message",
		!!card && card.expanded === "true" && card.text.includes("ZEBRAQUARTZ"),
		JSON.stringify(card),
	);
	check("open, its Markdown is drawn", card?.strong === "queue page", card?.strong);
	check("focus moves to the fold button", card?.focused === true);
	check("the other rows stay folded", (await page.$$(".messages .rolemsg-row")).length === ROWS.length - 1);
	await page.keyboard.press("Enter");
	const folded = await waitFor(() => page.$(rowSel(Q.id)));
	const focusRow = await page.evaluate(
		(sel) => document.activeElement === document.querySelector(`${sel} button`),
		rowSel(Q.id),
	);
	check("Enter folds it again, focus on its row", !!folded && !(await page.$(cardSel(Q.id))) && focusRow);
	await page.keyboard.press("Enter");
	check("Enter opens it again", !!(await waitFor(() => page.$(cardSel(Q.id)))));
	// Off to another chat and back: still open (while the page is open).
	const viaWs = (path) =>
		page.evaluate((p) => window.__ws.send(JSON.stringify({ type: "switch_session", path: p })), path);
	await viaWs(otherFile);
	await waitFor(
		async () => (await listText(page)).includes("A second chat.") && !(await page.$(".messages .rolemsg-row")),
	);
	await viaWs(chatFile);
	await waitFor(() => page.$(".messages .rolemsg-row"));
	check(
		"it stays open after going to another chat and back",
		!!(await waitFor(() => page.$(cardSel(Q.id)), 5000)) &&
			(await page.$$(".messages .rolemsg-row")).length === ROWS.length - 1,
	);
	await page.click(`${cardSel(Q.id)} button.rolemsg-fold`);
	check("a click on its head folds it", !!(await waitFor(() => page.$(rowSel(Q.id)))));
}

// =========================================================================================================
// 3. Ctrl+F finds words inside a folded message and opens it
// =========================================================================================================
{
	await page.evaluate(() => document.activeElement?.blur?.());
	await page.keyboard.press("Control+f");
	const input = await waitFor(() => page.$(".search-bar .search-input"));
	check("Ctrl+F opens the search bar", !!input);
	await page.keyboard.type("ZEBRAQUARTZ");
	const count = await waitFor(async () => {
		const t = await page.evaluate(() => document.querySelector(".search-bar .search-count")?.textContent ?? "");
		return /^1\/1$/.test(t) ? t : null;
	}, 8000);
	check("the search finds the word inside the folded message", count === "1/1", count ?? "no count");
	const shown = await page.evaluate((sel) => {
		const c = document.querySelector(sel);
		return !!c && c.innerText.includes("ZEBRAQUARTZ");
	}, cardSel(Q.id));
	check("and opens that message while it searches", shown);
	await shot(page, "desktop-dark-search", cardSel(Q.id));
	await page.keyboard.press("Escape");
	await waitFor(async () => !(await page.$(".search-bar")));
	check(
		"closing the search folds it back",
		!!(await waitFor(() => page.$(rowSel(Q.id)))) && !(await page.$(cardSel(Q.id))),
	);
}

// =========================================================================================================
// 4. message_role cards are folded with the tool-details switch on
// =========================================================================================================
{
	await openSteps(page);
	const bash = await toolCard(page, "bash");
	check(
		"the tool-details switch is on: the bash card shows its details",
		bash?.expanded === "true",
		JSON.stringify(bash),
	);
	const sent = await toolCard(page, "message_role", 0);
	check("a message_role card is folded anyway", sent?.expanded === "false", JSON.stringify(sent));
	check(
		"its line: to whom, the kind, the first words",
		sent?.line === `To temper \u00b7 reply to rm-0000a001 \u00b7 ${MR_SENT.text}`,
		sent?.line,
	);
	check("and the id it went out under", sent?.sent === "Sent rm-0000a002", sent?.sent);
	check("the tool's name isn't cut", sent?.nameCut === false, JSON.stringify(sent));
	const held = await toolCard(page, "message_role", 1);
	check(
		"a held one says so",
		held?.expanded === "false" &&
			held?.sent === "Held rm-0000a008" &&
			held?.line.startsWith("To qa \u00b7 question \u00b7 Are the screenshots"),
		JSON.stringify(held),
	);
	await shot(page, "desktop-dark-message-role");
	await page.evaluate(() => {
		const c = [...document.querySelectorAll(".messages .toolcall")].find(
			(x) => x.querySelector(".toolcall-name")?.textContent === "message_role",
		);
		c?.querySelector(".toolcall-head")?.click();
	});
	const open = await waitFor(async () => {
		const c = await toolCard(page, "message_role", 0);
		return c?.expanded === "true" ? c : null;
	});
	check("a click opens it", !!open && open.text.includes("nothing to do") && open.line === "", JSON.stringify(open));
	const axe = await runAxe(page);
	check(
		"desktop dark: axe finds nothing serious or critical",
		!axe.error && axe.bad.length === 0,
		axe.error ?? axe.bad.join("; "),
	);
}
await deskCtx.close();

// =========================================================================================================
// 5. White, and phones
// =========================================================================================================
for (const [tag, opts] of [
	["desktop-white", { width: 1280, height: 900, theme: "white" }],
	["phone-dark", { width: 390, height: 844, phone: true }],
	["phone-white", { width: 390, height: 844, phone: true, theme: "white" }],
]) {
	const { context, page: p } = await openPage(opts);
	const m = await measure(p);
	const minTarget = opts.phone ? 44 : 24;
	check(
		`${tag}: rows one line, targets at least ${minTarget} px, nothing sideways`,
		m.oneLine && m.minHeight >= minTarget && m.overflowX <= 1,
		JSON.stringify(m),
	);
	await shot(p, `${tag}-folded`, rowSel(FYI.id));
	await p.click(`${rowSel(REQ.id)} button`);
	await waitFor(() => p.$(cardSel(REQ.id)));
	await shot(p, `${tag}-open`, cardSel(REQ.id));
	const axe = await runAxe(p);
	check(
		`${tag}: axe finds nothing serious or critical`,
		!axe.error && axe.bad.length === 0,
		axe.error ?? axe.bad.join("; "),
	);
	await context.close();
}

// =========================================================================================================
// 6. Nothing changed underneath
// =========================================================================================================
await browser.close();
{
	const changed = [
		["chat", chatFile],
		["other", otherFile],
	]
		.filter(([k, f]) => sha(f) !== before[k])
		.flatMap(([k, f]) => {
			// Opening a chat may add the SDK's own settings entries (thinking level, model) at its end: that
			// is the app opening it, not the page. Every line that was there stays exactly as it was.
			const now = readFileSync(f, "utf8");
			if (!now.startsWith(beforeText[k])) return [`${k}: an existing line changed`];
			const added = now.slice(beforeText[k].length).split("\n").filter(Boolean);
			const odd = added.filter((l) => !/^\{"type":"(thinking_level_change|model_change)"/.test(l));
			return odd.map((l) => `${k}: added ${l.slice(0, 200)}`);
		});
	check("no line of the transcripts changed, and no message was added", changed.length === 0, changed.join(" || "));
}
check("the model was never called", modelCalls === 0, String(modelCalls));
check("the page logged no error", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
await srv.stop();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
