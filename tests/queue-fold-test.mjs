/* queue-fold E2E (Ops #267; no tokens: a stand-in model that is never called).
 *
 * The owner, 2026-10-19: "i also want queue reports in chat collapsed by default"; which ones: "queue
 * reports, by plugin". A seeded chat holds the owner's message (it mentions [Queue] mid-text), a task's
 * plan as pi-queue starts it, 10 "[Queue] …" report cards and 10 queue notes (queue-report, queue-wait,
 * queue-paused), all in pi-queue's own wording, each long enough to fill several lines when open.
 *  1. Every report is one folded row ("Queue" and its first line, cut to fit), at most 2 text lines high,
 *     and nothing deep inside one is on the page. The plan, the owner's message and the replies stay
 *     open; no other message folds.
 *  2. Ctrl+F finds a word deep inside a folded card, and one inside a folded note, and opens that report.
 *  3. A click opens a report (with the Collapse button); Collapse folds it again; Enter opens one too.
 *  4. Phone: rows stay one line and nothing scrolls sideways.
 *  5. No line of the transcript changed and no message was added (opening a chat may only add the SDK's
 *     own settings entries), the model was never called, and the page logged no error.
 * Usage: npm run build && node tests/queue-fold-test.mjs   (screenshots with QUEUE_FOLD_SHOT=<dir>)
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";

const SHOTS = process.env.QUEUE_FOLD_SHOT || "";

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

// ---- the seeded chat -------------------------------------------------------------------------------------
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
const assistant = (text) =>
	msg({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "mock",
		model: "mock-model",
		usage,
		stopReason: "stop",
	});
/** A note the queue plugin posts (pi.sendMessage with display on): a custom message. */
const note = (customType, text) => {
	const ts = tick();
	return {
		type: "custom_message",
		customType,
		content: [{ type: "text", text }],
		display: true,
		id: eid(),
		timestamp: iso(ts),
	};
};

/** Every report's long tail: TAILMARK is on the page only while a report is open. */
const LONG =
	"Here is the longer part of the report, which goes on for a while so that it can't fit in one line of the chat, whatever the screen. TAILMARK\n\n- one more point\n- and another one";
const OWNER = "Owner here: the [Queue] cards fill my screen, please make them smaller.";
const PLAN = [
	"[Queue] Task #267: Fold the queue reports",
	`You're working on this task in a chat of its own, started by the queue in the chat "Ops lead". The user planned it there and approved the plan. Work it through to the end without stopping to ask, unless only the user can decide something.`,
	"**Goal:** Queue reports stop filling the chat.\n\n**Done when:**\n\n- Each one shows as one line.",
	"Other queued tasks may be running at the same time in other chats, so:",
	"When it's finished and checked, call queue_done with a short summary, then give the result. PLANENDMARK",
].join("\n\n");
// pi-queue's report cards (queue.ts; the lines are noted in tests/unit/queue-report-fold.test.ts).
const CARDS = [
	`[Queue] Task #2 (Add a timing check) is done in its chat "Add a timing check": Timing check added; tests pass.\n\n${LONG}`,
	`[Queue] 2 tasks are done in their chats:\n- Task #3 (Tidy the README) in "Tidy the README": tidied.\n- Task #4 (Fix the link) in "Fix the link": fixed.\n\n${LONG}`,
	`[Queue] Task #5 (Ship the build) is on hold in its chat "Ship the build", waiting on "temper restart".\n\n${LONG}`,
	`[Queue] Task #6 (Land the fix) is blocked in its chat "Land the fix": temper #38. The queue pokes it when that's over.\n\n${LONG}`,
	`[Queue] Lead: task #8 in "Design lead" asks (question 1 of at most 3) [k1a2b3c4d]: Draw the icons\n\nThe question: which size? ${LONG}\n\nThe word ZEBRAQUARTZ is deep inside.\n\nReply with queue_reply.`,
	`[Queue] Ops: task #9 in "Design lead" stopped and its chat can't be reached [k5e6f7a8b]: Draw the icons\n\nWhat happened: ${LONG}`,
	`[Queue] Reminder 1 of 3 for temper (rule 24) [l1a2b3c4d]: task #10 (Wire the gate) in the queue of "Ops lead" has waited 1h 5m (since 19:02) for a go-ahead.\n\n${LONG}`,
	`[Queue] temper's lead's decision ("Temper engine") on task #11's question "Which port?":\n\nUse 8080. ${LONG}`,
	`[Queue] Task #13 (Pick a name) needs the user in its chat "Pick a name": Which name?\n\n${LONG}`,
	`[Queue] Task #14 was dropped by Ops: covered by #15. Stop working on it: finish the step you're on, don't start new runs, workflows or wake-ups, and cancel wake-ups you scheduled. Then end your turn with one line on where you stopped.\n\n${LONG}`,
];
// The queue's notes (index.ts; pi-web-ui's own queue-paused, server/role-messages.ts).
const NOTES = [
	[
		"queue-report",
		`[Queue] Task #2 (Add a timing check) is done in its chat "Add a timing check": Timing check added.\n\n${LONG}`,
	],
	["queue-report", `[Queue] Task #3 (Tidy the README) started in its chat "Tidy the README".\n\n${LONG}`],
	[
		"queue-report",
		`[Queue] Task #4 (Fix the link) is on hold in its chat "Fix the link", waiting on "deploy".\n\n${LONG}\n\nOKAPIGLYPH sits deep inside this note.`,
	],
	["queue-report", `[Queue] Task #5 (Ship the build) is blocked in its chat "Ship the build": temper #38.\n\n${LONG}`],
	["queue-report", `[Queue] Task #6 (Land the fix): the queue poked it out of its block.\n\n${LONG}`],
	[
		"queue-report",
		`[Queue] Task #7 (Build the thing) is done in its chat "Build the thing": it built the thing.\n\n${LONG}`,
	],
	["queue-wait", `[Queue] Task #22 (Pick a port) needs the user: Which port?\n\n${LONG}`],
	[
		"queue-wait",
		`[Queue] Task #23: no lead answered its block, so its question went to the owner with the whole record (owner, 2026-10-16): Go ahead?\n\nWait for his answer; it comes here as your next message. ${LONG}`,
	],
	["queue-wait", `[Queue] Task #24 (Draw the icons) is on hold, waiting on "design review".\n\n${LONG}`],
	[
		"queue-paused",
		`[Role message rm-0000a001 from temper (Temper engine), sent from its home chat · question]\n\nCan you check? ${LONG}\n\n(This came while the owner had this task paused, so it started no turn.)`,
	],
];
/** The folded row's words: the first line without "[Queue] ", spaces collapsed, cut at 90 characters. */
function rowLine(text) {
	const first = (text.split("\n").find((l) => l.trim()) ?? "")
		.replace(/^\s*\[Queue\]\s*/, "")
		.replace(/\s+/g, " ")
		.trim();
	return first.length > 90 ? `${first.slice(0, 90)}…` : first;
}

let chatFile = "";
function seed({ agentDir, workdir }) {
	const sessionsDir = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(sessionsDir, { recursive: true });
	const sid = "01a0f267-0000-7000-8000-00000000f267";
	chatFile = join(sessionsDir, `2026-10-19T10-00-00-000Z_${sid}.jsonl`);
	const owner = user(OWNER);
	const plan = user(PLAN);
	const replies = [assistant("Will do."), assistant("Starting on the plan.")];
	const lines = [owner, replies[0], plan, replies[1]];
	// Each card, then a note: no reply between them, so no note hides in a turn's folded steps (24 messages,
	// under the 30 at which old messages start folding too: only the queue's reports fold here).
	for (let i = 0; i < 10; i++) lines.push(user(CARDS[i]), note(NOTES[i][0], NOTES[i][1]));
	writeChat(chatFile, sid, workdir, lines);
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
	name: "queue-fold",
	verbose: !!process.env.QUEUE_FOLD_DEBUG,
	mock: () => {
		modelCalls += 1;
		return "ok";
	},
	prepare: seed,
});
const before = sha(chatFile);
const beforeText = readFileSync(chatFile, "utf8");
/** Each report's folded line: cards first, then notes (each one different, so it names its row). */
const LINES = { cards: CARDS.map(rowLine), notes: NOTES.map(([, text]) => rowLine(text)) };
const ALL_LINES = [...LINES.cards, ...LINES.notes];
const REPORTS = ALL_LINES.length;
/** The words that name the messages that stay open. */
const MARK = { owner: "make them smaller", plan: "PLANENDMARK", replies: ["Will do.", "Starting on the plan."] };

// ---- the browser -----------------------------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const pageErrors = [];
async function openPage({ width, height, phone = false }) {
	const context = await browser.newContext({
		viewport: { width, height },
		deviceScaleFactor: 1,
		isMobile: phone,
		hasTouch: phone,
		locale: "en-US",
	});
	await context.addInitScript(() => localStorage.setItem("pi-web-ui:lang", "en"));
	const page = await context.newPage();
	page.on("pageerror", (e) => pageErrors.push(String(e)));
	page.on("console", (m) => {
		if (m.type() === "error" && !/favicon|Failed to load resource/i.test(m.text())) pageErrors.push(m.text());
	});
	await page.goto(`${srv.http}/?chat=${encodeURIComponent(chatFile)}`);
	await page.waitForSelector(".messages .msg-collapsed", { timeout: 30_000 });
	await waitFor(() =>
		page.evaluate((n) => document.querySelectorAll(".messages .msg-collapsed[data-queue-fold]").length >= n, REPORTS),
	);
	await page.evaluate(() => document.fonts?.ready);
	return { context, page };
}
const rowSel = (id) => `.messages .msg-collapsed[data-msg-id="${id}"]`;
const cardSel = (id) => `.messages .msg[data-msg-id="${id}"]`;
const listText = (page) => page.evaluate(() => document.querySelector(".messages")?.innerText ?? "");
/** The page's own message ids (the app numbers messages itself), found by their words: a folded report by
 *  its row's line, an open message by a word in it. */
const pageIds = (page) =>
	page.evaluate(
		({ lines, mark }) => {
			const rowId = (line) =>
				[...document.querySelectorAll(".messages .msg-collapsed[data-queue-fold]")]
					.find((r) => (r.querySelector(".msg-collapsed-preview")?.textContent ?? "") === line)
					?.getAttribute("data-msg-id") ?? "";
			const msgId = (word) =>
				[...document.querySelectorAll(".messages .msg")]
					.find((m) => m.innerText.includes(word))
					?.getAttribute("data-msg-id") ?? "";
			return {
				cards: lines.cards.map(rowId),
				notes: lines.notes.map(rowId),
				owner: msgId(mark.owner),
				plan: msgId(mark.plan),
				replies: mark.replies.map(msgId),
			};
		},
		{ lines: LINES, mark: MARK },
	);
async function shot(page, name) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}
/** Every folded row: id, words, height; the chat's text line height (from the owner's message). */
const rows = (page) =>
	page.evaluate(() => {
		const textEl = [...document.querySelectorAll(".messages .msg *")].find(
			(el) => el.children.length === 0 && el.textContent.includes("Owner here"),
		);
		const cs = textEl ? getComputedStyle(textEl) : null;
		const lh = !cs ? 0 : cs.lineHeight === "normal" ? parseFloat(cs.fontSize) * 1.2 : parseFloat(cs.lineHeight);
		const root = document.querySelector(".messages");
		return {
			lineHeight: lh,
			overflowX: Math.max(root.scrollWidth - root.clientWidth, document.documentElement.scrollWidth - innerWidth),
			list: [...document.querySelectorAll(".messages .msg-collapsed")].map((r) => {
				r.scrollIntoView({ block: "center" });
				const p = r.querySelector(".msg-collapsed-preview");
				return {
					id: r.getAttribute("data-msg-id"),
					queue: r.hasAttribute("data-queue-fold"),
					label: r.querySelector(".msg-collapsed-role")?.textContent ?? "",
					line: p?.textContent ?? "",
					height: r.getBoundingClientRect().height,
					oneLine: !p || p.scrollHeight <= p.clientHeight + 1,
				};
			}),
		};
	});

// =========================================================================================================
// 1. Desktop: every report is one folded row; the plan and everything else stays open
// =========================================================================================================
const { context: deskCtx, page } = await openPage({ width: 1280, height: 900 });
const ids = await pageIds(page);
{
	check("the fixture: every report's line is different", new Set(ALL_LINES).size === REPORTS);
	const r = await rows(page);
	const queueRows = r.list.filter((x) => x.queue);
	const found = [...ids.cards, ...ids.notes];
	check(
		"every queue report is a folded row (10 cards, 10 notes)",
		queueRows.length === REPORTS && found.every(Boolean) && new Set(found).size === REPORTS,
		`${queueRows.length} rows, ${found.filter(Boolean).length} found by their line`,
	);
	check(
		"no other message folds",
		r.list.every((x) => x.queue),
		r.list
			.filter((x) => !x.queue)
			.map((x) => x.id)
			.join(", "),
	);
	check(
		'each row reads "Queue" and its first line, cut to fit',
		queueRows.every((x) => x.label === "Queue" && ALL_LINES.includes(x.line)),
		queueRows
			.filter((x) => x.label !== "Queue" || !ALL_LINES.includes(x.line))
			.map((x) => `${x.label} | ${x.line}`)
			.slice(0, 3)
			.join(" || "),
	);
	const tallest = Math.max(...queueRows.map((x) => x.height));
	check(
		"each row is at most 2 text lines high",
		r.lineHeight > 0 && tallest <= 2 * r.lineHeight + 0.5 && queueRows.every((x) => x.oneLine),
		`tallest ${tallest}px, text line ${r.lineHeight}px`,
	);
	console.log(`  rows ${queueRows.length}, tallest ${tallest}px, text line ${r.lineHeight}px`);
	const text = await listText(page);
	check(
		"nothing deep inside a folded report is on the page",
		!text.includes("TAILMARK") && !text.includes("ZEBRAQUARTZ") && !text.includes("OKAPIGLYPH"),
	);
	const plan = await page.evaluate(
		(s) => {
			const c = s ? document.querySelector(s) : null;
			return c ? { text: c.innerText, collapseBtn: !!c.querySelector(".msg-collapse-btn") } : null;
		},
		ids.plan && cardSel(ids.plan),
	);
	check(
		"the task's plan is fully open",
		!!plan &&
			plan.text.includes("PLANENDMARK") &&
			plan.text.includes("Queue reports stop filling the chat") &&
			!plan.collapseBtn,
	);
	check("the owner's message that mentions [Queue] stays open", !!ids.owner && text.includes(MARK.owner));
	check("the replies stay open", ids.replies.every(Boolean));
	await shot(page, "desktop-folded");
}

// =========================================================================================================
// 2. Ctrl+F finds words deep inside a folded card and a folded note, and opens them
// =========================================================================================================
{
	const card = ids.cards[4];
	const noteId = ids.notes[2];
	await page.evaluate(() => document.activeElement?.blur?.());
	await page.keyboard.press("Control+f");
	const input = await waitFor(() => page.$(".search-bar .search-input"));
	check("Ctrl+F opens the search bar", !!input);
	const search = async (word, id) => {
		await input.fill("");
		await page.keyboard.type(word);
		const count = await waitFor(async () => {
			const t = await page.evaluate(() => document.querySelector(".search-bar .search-count")?.textContent ?? "");
			return /^1\/1$/.test(t) ? t : null;
		}, 8000);
		const shown = await waitFor(
			() =>
				page.evaluate(
					({ sel, word }) => {
						const c = document.querySelector(sel);
						return !!c && c.innerText.includes(word);
					},
					{ sel: cardSel(id), word },
				),
			8000,
		);
		return { count, shown: !!shown };
	};
	const inCard = await search("ZEBRAQUARTZ", card);
	check("the search finds a word inside a folded card", inCard.count === "1/1", inCard.count ?? "no count");
	check("and opens that card", inCard.shown);
	const inNote = await search("OKAPIGLYPH", noteId);
	check("the search finds a word inside a folded note", inNote.count === "1/1", inNote.count ?? "no count");
	check("and opens that note", inNote.shown);
	await shot(page, "desktop-search");
	await page.keyboard.press("Escape");
	await waitFor(async () => !(await page.$(".search-bar")));
	check(
		"what the search opened stays open, like other opened rows",
		!!(await page.$(cardSel(card))) && !!(await page.$(cardSel(noteId))) && !(await page.$(rowSel(card))),
	);
	// Fold them again for the next part.
	for (const id of [card, noteId]) await page.click(`${cardSel(id)} .msg-collapse-btn`);
	check(
		"Collapse folds them again",
		!!(await waitFor(async () => (await page.$(rowSel(card))) && (await page.$(rowSel(noteId))))),
	);
}

// =========================================================================================================
// 3. A click opens a report and Collapse folds it again; Enter opens one too
// =========================================================================================================
{
	const card = ids.cards[2];
	await page.click(rowSel(card));
	const open = await waitFor(() =>
		page.evaluate((sel) => {
			const c = document.querySelector(sel);
			return c && c.innerText.includes("TAILMARK") ? { btn: !!c.querySelector(".msg-collapse-btn") } : null;
		}, cardSel(card)),
	);
	check("one click opens a report, whole", !!open);
	check("an open report has the Collapse button", !!open?.btn);
	const noteId = ids.notes[6];
	await page.click(rowSel(noteId));
	await waitFor(() => page.$(cardSel(noteId)));
	check("it stays open while another one opens", !!(await page.$(cardSel(card))) && !!(await page.$(cardSel(noteId))));
	await shot(page, "desktop-open");
	await page.click(`${cardSel(card)} .msg-collapse-btn`);
	check(
		"a second click (Collapse) folds it again",
		!!(await waitFor(() => page.$(rowSel(card)))) && !(await page.$(cardSel(card))),
	);
	await page.click(`${cardSel(noteId)} .msg-collapse-btn`);
	await waitFor(() => page.$(rowSel(noteId)));
	await page.focus(rowSel(ids.notes[0]));
	await page.keyboard.press("Enter");
	check("Enter on a focused row opens it", !!(await waitFor(() => page.$(cardSel(ids.notes[0])))));
	const folded = await page.evaluate(
		() => document.querySelectorAll(".messages .msg-collapsed[data-queue-fold]").length,
	);
	check("the others stay folded", folded === REPORTS - 1, String(folded));
}
await deskCtx.close();

// =========================================================================================================
// 4. Phone: one line each, nothing sideways
// =========================================================================================================
{
	const { context, page: phone } = await openPage({ width: 390, height: 844, phone: true });
	const r = await rows(phone);
	const queueRows = r.list.filter((x) => x.queue);
	const tallest = Math.max(...queueRows.map((x) => x.height));
	check(
		"phone: every report folded, each one line, at most 2 text lines high",
		queueRows.length === REPORTS &&
			queueRows.every((x) => x.oneLine) &&
			r.lineHeight > 0 &&
			tallest <= 2 * r.lineHeight + 0.5,
		`${queueRows.length} rows, tallest ${tallest}px, text line ${r.lineHeight}px`,
	);
	check("phone: nothing scrolls sideways", r.overflowX <= 1, `${r.overflowX}px`);
	await shot(phone, "phone-folded");
	await context.close();
}

// =========================================================================================================
// 5. Nothing changed underneath
// =========================================================================================================
await browser.close();
{
	let changed = [];
	if (sha(chatFile) !== before) {
		// Opening a chat may add the SDK's own settings entries (thinking level, model) at its end: that is the
		// app opening it, not the page. Every line that was there stays exactly as it was.
		const now = readFileSync(chatFile, "utf8");
		if (!now.startsWith(beforeText)) changed = ["an existing line changed"];
		else
			changed = now
				.slice(beforeText.length)
				.split("\n")
				.filter(Boolean)
				.filter((l) => !/^\{"type":"(thinking_level_change|model_change)"/.test(l))
				.map((l) => `added ${l.slice(0, 120)}`);
	}
	check("no line of the transcript changed, and no message was added", changed.length === 0, changed.join(" || "));
}
check("the model was never called", modelCalls === 0, String(modelCalls));
check("the page logged no error", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
await srv.stop();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
