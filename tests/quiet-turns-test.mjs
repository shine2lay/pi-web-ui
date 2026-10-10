/* quiet-turns E2E (task #96; no tokens: a stand-in model that only answers the live turns).
 *
 * The owner, 2026-10-10 (via COO rm-37872561): "in alot of chat, i see response to agent's message, like
 * i see an actual output to me in chat, i dont need anything to see, the response should be sent to the
 * agent only if needed or just don't respond at all".
 *
 * A seeded chat holds a turn of every kind:
 *  - quiet (another agent began it): a role request, a Board order, a role question whose turn asks the
 *    owner a question (ask_user_question), and two role messages joined in one run;
 *  - in full: the owner's own turn, a reply that answers a question asked for the owner (forOwner), the
 *    app's 6 am report request, a morning brief, a role request the owner joined mid-turn, an FYI read
 *    with the owner's next message;
 *  - by the owner's switches (off by default): a finished queue task waking its main chat, a stall-check
 *    poke, a scheduled wake-up.
 * Checks:
 *  1. Each quiet turn is ONE closed row (the #75 row plus what the turn sent: "→ replied to temper",
 *     "→ acked bp-…", "→ nothing sent"); none of its text, thinking or tool cards shows outside it; the
 *     second message of the joined run has no row of its own. The ask_user_question card stays in sight.
 *  2. Everything the owner reads stays in full.
 *  3. Opening a row shows the turn as before; folding it hides it again.
 *  4. The three switches (server settings) fold the three kinds; off again, they show in full.
 *  5. Live: a turn a role message begins leaves no "done" sound and no green light on its chat; an owner
 *     turn still does both.
 *  6. axe finds nothing serious or critical, rows are one line, targets are big enough and nothing
 *     scrolls sideways, desktop and phone, dark and white (screenshots with QUIET_SHOT=<dir>).
 *  7. No line of the seeded transcript changed, and the page logged no error.
 * Usage: npm run build && node tests/quiet-turns-test.mjs
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { boardOrderText } from "../dist/server/role-board.js";
import { roleMessageText, sha1 } from "../dist/server/role-messages.js";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";

const AXE = process.env.PI_AXE_JS ?? join(userInfo().homedir, "temper-ai/configs/design/bin/vendor/axe-4.13.0.min.js");
const SHOTS = process.env.QUIET_SHOT || "";

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
const thinkingText = (thinking, text) => [
	{ type: "thinking", thinking },
	{ type: "text", text },
];
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
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

const from = (role, title) => ({ role, title, chat: "home chat" });
const REQ = {
	id: "rm-0000a001",
	from: from("temper", "Temper engine"),
	kind: "request",
	text: "Please check the deploy log for #12.",
};
const ASKQ = {
	id: "rm-0000a002",
	from: from("qa", "QA"),
	kind: "question",
	text: "Which colour should the owner's dashboard use?",
};
const RA = {
	id: "rm-0000a003",
	from: from("design", "Design"),
	kind: "request",
	text: "Please look at the new Roles page shots.",
};
const RB = {
	id: "rm-0000a004",
	from: from("frontend", "Frontend"),
	kind: "fyi",
	text: "The shots are in the usual folder.",
};
const ORIGINAL = {
	id: "rm-0000a005",
	from: from("ops", "ops/tooling"),
	kind: "question",
	text: "Owner asks: is the backup green?",
};
const FORO = {
	id: "rm-0000a006",
	from: from("systems", "System engineering"),
	kind: "reply",
	replyTo: ORIGINAL.id,
	text: "Yes, last night's backup is green.",
};
const REPORT = {
	id: "rm-0000a007",
	from: { role: "app", title: "the app", chat: "home chat" },
	kind: "report",
	report: { date: "2026-10-09" },
	text: "Write your 6 am report for yesterday.",
};
const JOIN = {
	id: "rm-0000a008",
	from: from("product", "Product management"),
	kind: "request",
	text: "Please add a row for the scan run.",
};
const STALL = {
	id: "rm-0000a009",
	from: from("coo", "COO"),
	kind: "question",
	text: "[Stall check] Task #3 has been quiet for an hour: is it stuck?",
};
const FYI = {
	id: "rm-0000a00a",
	from: from("architecture", "System architecture"),
	kind: "fyi",
	text: "The land check for #50 passed.",
};
const ORDER = {
	id: "bp-0000b001",
	at: NOW,
	from: "owner",
	via: "product",
	kind: "order",
	to: ["ops"],
	title: "Re-arrange your queue now",
	text: "One own-initiative focus; requested work stays.",
	ownerWords: "Owner in Product's home chat: focus on one thing at a time",
};
const QUEUE_WAKE = '[Queue] Task #7 (Build the thing) is done in its chat "Build the thing": it built the thing.';
const SCHEDULED = "[Scheduled task nightly-check] Check the backups and report.";
const BRIEF = "Morning brief: three things happened overnight, all fine.";

const text = {
	REQ: roleMessageText(REQ),
	ASKQ: roleMessageText(ASKQ),
	RA: roleMessageText(RA),
	RB: roleMessageText(RB),
	FORO: roleMessageText(FORO, { ownerAnswer: true }),
	REPORT: roleMessageText(REPORT),
	JOIN: roleMessageText(JOIN),
	STALL: roleMessageText(STALL),
	FYI: roleMessageText(FYI),
	ORDER: boardOrderText(ORDER),
};

let chatFile = "";
let liveFile = "";
let sessionsDir = "";
function seed({ dataDir, agentDir, workdir }) {
	sessionsDir = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(sessionsDir, { recursive: true });
	const sid = "01a0f096-0000-7000-8000-00000000f096";
	chatFile = join(sessionsDir, `2026-10-10T10-00-00-000Z_${sid}.jsonl`);
	const lines = [
		// in full: the owner's own turn
		user("OWNER-ASK: please keep an eye on the deploys today."),
		assistant("OWNER-ANSWER-VISIBLE: will do."),
		// quiet: a role request, answered with message_role
		user(text.REQ),
		assistant(
			[
				{ type: "thinking", thinking: "QUIET-THINKING-REQ" },
				call("c-req-bash", "bash", { command: "echo QUIET-BASH-REQ" }),
				call("c-req-mr", "message_role", { to: "temper", kind: "reply", replyTo: REQ.id, text: "The log is clean." }),
			],
			"toolUse",
		),
		toolResult("c-req-bash", "bash", "QUIET-BASH-REQ"),
		toolResult("c-req-mr", "message_role", "Sent rm-0000c001 (reply to temper).", {
			id: "rm-0000c001",
			to: "temper",
			kind: "reply",
			chain: 2,
			state: "waiting",
		}),
		assistant("QUIET-REQ-TEXT: replied to temper, nothing for the owner."),
		// quiet: a Board order, acked
		user(text.ORDER),
		assistant([call("c-ord", "board", { action: "ack", id: ORDER.id, note: "Nothing to hold." })], "toolUse"),
		toolResult("c-ord", "board", "Acked bp-0000b001."),
		assistant("QUIET-BOARD-TEXT: acked the order."),
		// in full: a reply answering a question asked for the owner
		user(text.FORO),
		assistant("FOROWNER-ANSWER-VISIBLE: the backup is green."),
		// in full: the 6 am report request
		user(text.REPORT),
		assistant("REPORT-VISIBLE: yesterday went fine."),
		// in full: the morning brief (a plugin's message)
		user(BRIEF),
		assistant("BRIEF-VISIBLE: noted."),
		// quiet, but its question to the owner stays in sight
		user(text.ASKQ),
		assistant(
			[
				call("c-ask", "ask_user_question", {
					questions: [{ id: "colour", question: "ASK-OWNER-VISIBLE: which colour for the dashboard?" }],
				}),
			],
			"toolUse",
		),
		toolResult("c-ask", "ask_user_question", "The owner picked blue."),
		assistant(thinkingText("QUIET-THINKING-ASK", "QUIET-ASK-TEXT: the owner picked blue.")),
		// quiet: two role messages joined in one run
		user(text.RA),
		assistant(
			[call("c-ra", "message_role", { to: "design", kind: "reply", replyTo: RA.id, text: "Looked: fine." })],
			"toolUse",
		),
		toolResult("c-ra", "message_role", "Sent rm-0000c002 (reply to design).", {
			id: "rm-0000c002",
			to: "design",
			kind: "reply",
			chain: 2,
			state: "waiting",
		}),
		user(text.RB),
		assistant("QUIET-JOINED-TEXT: both handled."),
		// in full: a role request the owner joined mid-turn
		user(text.JOIN),
		assistant([call("c-join", "bash", { command: "echo working" })], "toolUse"),
		toolResult("c-join", "bash", "working"),
		user("OWNER-JOINED: and tell me when it's done."),
		assistant("JOINED-TEXT-VISIBLE: done, here it is."),
		// by switch: a finished queue task waking its main chat
		user(QUEUE_WAKE),
		assistant("QUEUE-WAKE-TEXT: noted task #7."),
		// by switch: a stall-check poke
		user(text.STALL),
		assistant("STALL-TEXT: not stuck."),
		// by switch: a scheduled wake-up
		user(SCHEDULED),
		assistant("SCHEDULED-TEXT: backups fine."),
		// in full: an FYI read with the owner's next message
		fyiEntry(text.FYI),
		user("OWNER-AFTER-FYI: what's new?"),
		assistant("FYI-OWNER-VISIBLE: architecture says #50's land check passed."),
	];
	writeChat(chatFile, sid, workdir, lines);
	const sid2 = "01a0f096-0000-7000-8000-00000000f097";
	liveFile = join(sessionsDir, `2026-10-10T09-00-00-000Z_${sid2}.jsonl`);
	writeChat(liveFile, sid2, workdir, [user("A second chat."), assistant("Hello.")]);
	const sid3 = "01a0f096-0000-7000-8000-00000000f098";
	const thirdFile = join(sessionsDir, `2026-10-10T08-00-00-000Z_${sid3}.jsonl`);
	writeChat(thirdFile, sid3, workdir, [user("A third chat."), assistant("Hi.")]);
	// The store confirms the messages it delivered to this chat (same text); the original question was
	// asked for the owner, so its answer is stamped forOwner.
	const delivered = [
		[REQ, text.REQ],
		[ASKQ, text.ASKQ],
		[RA, text.RA],
		[RB, text.RB],
		[FORO, text.FORO],
		[JOIN, text.JOIN],
		[STALL, text.STALL],
		[FYI, text.FYI],
	];
	const records = delivered.map(([r, t], i) => ({
		id: r.id,
		at: NOW + i,
		from: { ...r.from, file: join(sessionsDir, "elsewhere.jsonl") },
		to: { role: "ops", title: "ops/tooling" },
		kind: r.kind,
		...(r.replyTo ? { replyTo: r.replyTo } : {}),
		chain: 1,
		text: r.text,
		state: "delivered",
		target: chatFile,
		targetChat: "home chat",
		scanFrom: 0,
		hash: sha1(t),
		sends: 1,
		attempts: 0,
		deliveredAt: NOW + 1000 + i,
	}));
	records.unshift({
		id: ORIGINAL.id,
		at: NOW - 10,
		from: { ...ORIGINAL.from, file: chatFile },
		to: { role: "systems", title: "System engineering" },
		kind: "question",
		chain: 1,
		text: ORIGINAL.text,
		forOwner: true,
		ownerIds: ["owner-q-1"],
		state: "delivered",
		target: join(sessionsDir, "elsewhere.jsonl"),
		targetChat: "home chat",
		scanFrom: 0,
		hash: sha1(roleMessageText(ORIGINAL)),
		sends: 1,
		attempts: 0,
		deliveredAt: NOW - 5,
	});
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
	name: "quiet-turns",
	verbose: !!process.env.QUIET_DEBUG,
	mock: async ({ lastUser, sideRequest }) => {
		if (sideRequest) return "Chat";
		modelCalls += 1;
		if (lastUser.includes("SLOWMARK")) await sleep(3000);
		return "LIVE-REPLY-TEXT";
	},
	prepare: seed,
});
const before = sha(chatFile);
const beforeText = readFileSync(chatFile, "utf8");

// ---- the browser -----------------------------------------------------------------------------------------
/** Stands in for AudioContext: each sound's notes, in order (done = 880 then 587 Hz). */
const AUDIO_RECORDER = () => {
	const cues = [];
	window.__cues = cues;
	let group = null;
	const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} };
	class FakeOscillator {
		type = "sine";
		frequency = { value: 0 };
		connect() {}
		disconnect() {}
		start() {
			if (!group) {
				group = [];
				cues.push({ at: Date.now(), freqs: group });
				queueMicrotask(() => {
					group = null;
				});
			}
			group.push(Math.round(this.frequency.value));
		}
		stop() {}
	}
	class FakeAudioContext {
		state = "running";
		currentTime = 0;
		destination = {};
		resume() {
			return Promise.resolve();
		}
		createOscillator() {
			return new FakeOscillator();
		}
		createGain() {
			return { gain: param, connect() {}, disconnect() {} };
		}
	}
	window.AudioContext = FakeAudioContext;
	window.webkitAudioContext = FakeAudioContext;
};
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const pageErrors = [];
async function openPage({ width, height, phone = false, theme = null, file = chatFile }) {
	const context = await browser.newContext({
		viewport: { width, height },
		deviceScaleFactor: 1,
		isMobile: phone,
		hasTouch: phone,
		locale: "en-US",
	});
	await context.addInitScript(AUDIO_RECORDER);
	await context.addInitScript((t) => {
		localStorage.setItem("pi-web-ui:lang", "en");
		if (t) localStorage.setItem("pi-web-ui:theme", t);
		else localStorage.removeItem("pi-web-ui:theme");
		const Orig = window.WebSocket;
		window.WebSocket = class extends Orig {
			constructor(...a) {
				super(...a);
				window.__ws = this;
				this.addEventListener("message", (e) => {
					try {
						const m = JSON.parse(e.data);
						if (m.type === "conversations") window.__convs = m.conversations;
						if (m.state?.exchanges || m.exchanges) (window.__ex ??= []).push(m.state?.exchanges ?? m.exchanges);
						if (m.state?.messages) window.__msgs = m.state.messages.map((x) => x.id);
					} catch {
						/* not JSON */
					}
				});
			}
		};
	}, theme);
	const page = await context.newPage();
	page.on("pageerror", (e) => pageErrors.push(String(e)));
	page.on("console", (m) => {
		if (m.type() === "error" && !/favicon|Failed to load resource/i.test(m.text())) pageErrors.push(m.text());
	});
	await page.goto(`${srv.http}/?chat=${encodeURIComponent(file)}`);
	await page.waitForSelector(".messages .msg, .messages .rolemsg-row", { timeout: 30_000 });
	await page.evaluate(() => document.fonts?.ready);
	return { context, page };
}
const rowSel = (id) => `.messages .rolemsg-row[data-role-message="${id}"]`;
const cardSel = (id) => `.messages .rolemsg-card[data-role-message="${id}"]`;
/** The chat's text top to bottom: the list mounts only what is near the screen, so scroll through it. */
const scan = (page) =>
	page.evaluate(async () => {
		const root = document.querySelector(".messages");
		if (!root) return { text: "", roles: {} };
		const keep = root.scrollTop;
		const parts = [];
		const roles = {};
		for (let y = 0; ; y += Math.max(200, root.clientHeight / 2)) {
			root.scrollTop = y;
			await new Promise((r) => setTimeout(r, 120));
			parts.push(root.innerText);
			for (const e of root.querySelectorAll("[data-role-message]")) {
				const id = e.getAttribute("data-role-message");
				(roles[id] ??= []).includes(e.className) || roles[id].push(e.className);
			}
			if (root.scrollTop + root.clientHeight >= root.scrollHeight - 2) break;
		}
		root.scrollTop = keep;
		return { text: parts.join("\n"), roles };
	});
const listText = async (page) => (await scan(page)).text;
const quietRows = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll(".messages .quiet-turn-row")].map((r) => ({
			id: r.getAttribute("data-role-message") ?? "",
			cls: r.className,
			expanded: r.querySelector("button")?.getAttribute("aria-expanded"),
			turn: r.querySelector(".rolemsg-row-turn")?.textContent ?? "",
			from: r.querySelector(".rolemsg-row-from")?.textContent ?? "",
		})),
	);
const toolNames = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll(".messages .toolcall .toolcall-name")].map((n) => n.textContent ?? ""),
	);
const setSwitches = async (page, on) => {
	await page.evaluate(
		(v) =>
			window.__ws.send(
				JSON.stringify({ type: "set_settings", quietQueueWakes: v, quietStallPokes: v, quietScheduledWakes: v }),
			),
		on,
	);
};
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
const measure = (page) =>
	page.evaluate(() => {
		const btns = [...document.querySelectorAll(".messages .quiet-turn-row .rolemsg-row-btn")];
		const root = document.querySelector(".messages");
		return {
			rows: btns.length,
			minHeight: Math.min(...btns.map((b) => b.getBoundingClientRect().height)),
			oneLine: btns.every((b) => b.getBoundingClientRect().height <= 60),
			turnShown: btns.every((b) => {
				const s = b.querySelector(".rolemsg-row-turn");
				return !!s && s.getBoundingClientRect().width > 20;
			}),
			overflowX: Math.max(root.scrollWidth - root.clientWidth, document.documentElement.scrollWidth - innerWidth),
		};
	});

const QUIET_TEXTS = [
	"QUIET-REQ-TEXT",
	"QUIET-BOARD-TEXT",
	"QUIET-ASK-TEXT",
	"QUIET-JOINED-TEXT",
	"QUIET-THINKING-REQ",
	"QUIET-THINKING-ASK",
	"QUIET-BASH-REQ",
];
const FULL_TEXTS = [
	"OWNER-ANSWER-VISIBLE",
	"FOROWNER-ANSWER-VISIBLE",
	"REPORT-VISIBLE",
	"BRIEF-VISIBLE",
	"JOINED-TEXT-VISIBLE",
	"OWNER-JOINED",
	"FYI-OWNER-VISIBLE",
];
const SWITCH_TEXTS = ["QUEUE-WAKE-TEXT", "STALL-TEXT", "SCHEDULED-TEXT"];

// =========================================================================================================
// 1-2. Desktop, dark: quiet turns are one closed row each; the rest in full
// =========================================================================================================
const { context: deskCtx, page } = await openPage({ width: 1280, height: 900 });
{
	await waitFor(async () => (await quietRows(page)).length >= 4);
	const rows = await quietRows(page);
	const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
	check(
		"four quiet turns, one row each (request, Board order, question, joined pair)",
		rows.length === 4 &&
			[REQ.id, ASKQ.id, RA.id].every((id) => byId[id]) &&
			rows.some((r) => r.cls.includes("rolemsg-board-order") || r.id === ORDER.id || r.turn.includes("acked")),
		JSON.stringify(rows),
	);
	check(
		"every quiet row is closed",
		rows.every((r) => r.expanded === "false"),
		JSON.stringify(rows.map((r) => r.expanded)),
	);
	check("request row says what the turn sent", byId[REQ.id]?.turn === "\u2192 replied to temper", byId[REQ.id]?.turn);
	const orderRow = rows.find((r) => r.turn.includes("acked"));
	check(
		"Board order row says it acked the order",
		orderRow?.turn === `\u2192 acked ${ORDER.id}`,
		JSON.stringify(orderRow),
	);
	check("question row: nothing sent", byId[ASKQ.id]?.turn === "\u2192 nothing sent", byId[ASKQ.id]?.turn);
	check(
		"joined run: one row, from the first message",
		byId[RA.id]?.turn === "\u2192 replied to design" && !(await page.$(rowSel(RB.id))),
		JSON.stringify(byId[RA.id]),
	);
	const all = await listText(page);
	const leaked = QUIET_TEXTS.filter((s) => all.includes(s));
	check(
		"no text, thinking or tool output of a quiet turn shows outside its row",
		leaked.length === 0,
		leaked.join(", "),
	);
	const tools = await toolNames(page);
	check(
		"no tool card of a quiet turn outside its row, but its question to the owner stays",
		!tools.includes("message_role") && !tools.includes("board") && tools.includes("ask_user_question"),
		JSON.stringify(tools),
	);
	check("the owner's question in a quiet turn stays in sight", all.includes("ASK-OWNER-VISIBLE"));
	const missing = FULL_TEXTS.filter((s) => !all.includes(s));
	if (process.env.QUIET_DUMP)
		console.log(
			JSON.stringify(
				await page.evaluate(() => ({
					ex: (window.__ex ?? []).map((l) =>
						l.map((d) => ({
							i: d.index,
							e: d.end,
							h: d.head.map((m) => m.id),
							a: d.after.map((m) => m.id),
							ans: d.answers.map((m) => m.id),
							q: d.quiet,
						})),
					),
					msgs: window.__msgs,
				})),
			),
		);
	check(
		"the owner's turns, forOwner answers, the report and the brief show in full",
		missing.length === 0,
		`${missing.join(", ")} :: ${all.replace(/\s+/g, " ").slice(0, 1500)}`,
	);
	const missingSw = SWITCH_TEXTS.filter((s) => !all.includes(s));
	check(
		"switches off: queue wake-ups, stall pokes and scheduled wake-ups show in full",
		missingSw.length === 0,
		missingSw.join(", "),
	);
	const { roles } = await scan(page);
	const foro = roles[FORO.id] ?? [];
	const rep = roles[REPORT.id] ?? [];
	check(
		"forOwner reply and report keep their #75 row or card but aren't quiet",
		foro.length > 0 && rep.length > 0 && ![...foro, ...rep].some((c) => c.includes("quiet-turn")),
		JSON.stringify({ foro, rep }),
	);
	await shot(page, "desktop-dark-folded", rowSel(REQ.id));
}

// =========================================================================================================
// 3. Opening a row shows the turn as before; folding hides it again
// =========================================================================================================
{
	await page.click(`${rowSel(REQ.id)} button`);
	const opened = await waitFor(
		async () => (await listText(page)).includes("QUIET-REQ-TEXT") && (await page.$(cardSel(REQ.id))),
	);
	check("a click opens the turn: the message and the turn's answer", !!opened);
	const tools = await waitFor(async () => {
		await page.evaluate(() => {
			for (const h of document.querySelectorAll('.messages .xfold-head[aria-expanded="false"]')) h.click();
		});
		const t = await toolNames(page);
		return t.includes("bash") ? t : null;
	});
	check("opened, its tool cards are there as before", !!tools, JSON.stringify(tools));
	check("the other quiet rows stay closed", (await quietRows(page)).length === 3);
	await shot(page, "desktop-dark-open", cardSel(REQ.id));
	await page.click(`${cardSel(REQ.id)} button.rolemsg-fold`);
	const back = await waitFor(
		async () => !(await listText(page)).includes("QUIET-REQ-TEXT") && (await page.$(rowSel(REQ.id))),
	);
	check("folding it hides the turn again", !!back);
	const orderBtn = await page.$(
		".messages .quiet-turn-row.rolemsg-board-order button, .messages .quiet-turn-row[data-role-message='bp-0000b001'] button",
	);
	if (orderBtn) await orderBtn.click();
	check(
		"the Board order row opens its turn too",
		!!orderBtn && !!(await waitFor(async () => (await listText(page)).includes("QUIET-BOARD-TEXT"))),
	);
	const axe = await runAxe(page);
	check(
		"desktop dark: axe finds nothing serious or critical",
		!axe.error && axe.bad.length === 0,
		axe.error ?? axe.bad.join("; "),
	);
	const m = await measure(page);
	check(
		"rows one line, at least 24 px, the turn words shown, nothing sideways",
		m.oneLine && m.minHeight >= 24 && m.turnShown && m.overflowX <= 1,
		JSON.stringify(m),
	);
}

// =========================================================================================================
// 4. The owner's switches fold the three kinds
// =========================================================================================================
{
	await setSwitches(page, true);
	const folded = await waitFor(async () => {
		const t = await listText(page);
		return SWITCH_TEXTS.every((s) => !t.includes(s)) ? t : null;
	});
	check("switches on: the three kinds are folded", !!folded);
	const rows = await quietRows(page);
	check(
		"a queue-wake row, a scheduled row and the stall poke's role row",
		rows.some((r) => r.cls.includes("quiet-turn-queue-wake")) &&
			rows.some((r) => r.cls.includes("quiet-turn-scheduled")) &&
			rows.some((r) => r.id === STALL.id),
		JSON.stringify(rows),
	);
	const qw = await page.$(".messages .quiet-turn-queue-wake button");
	await qw?.click();
	const open = await waitFor(
		async () =>
			(await listText(page)).includes("QUEUE-WAKE-TEXT") &&
			(await page.$(".messages .quiet-turn-queue-wake.quiet-turn-open")),
	);
	check("a queue-wake row opens its turn, with a head that folds it again", !!open);
	await shot(page, "desktop-dark-switches", ".messages .quiet-turn-queue-wake");
	await page.click(".messages .quiet-turn-queue-wake.quiet-turn-open button");
	check("and folds again", !!(await waitFor(async () => !(await listText(page)).includes("QUEUE-WAKE-TEXT"))));
	await setSwitches(page, false);
	const back = await waitFor(async () => {
		const t = await listText(page);
		return SWITCH_TEXTS.every((s) => t.includes(s)) ? t : null;
	});
	check("switches off again: they show in full", !!back);
}
await deskCtx.close();

// =========================================================================================================
// 5. Live: no "done" sound and no green light for a turn a role message began
// =========================================================================================================
{
	const { context, page: p } = await openPage({ width: 1280, height: 900, file: liveFile });
	const doneCues = () => p.evaluate(() => window.__cues.filter((c) => c.freqs.join(",") === "880,587").length);
	const prompt = (t) => p.evaluate((x) => window.__ws.send(JSON.stringify({ type: "prompt", text: x })), t);
	const live = {
		id: "rm-0000e001",
		from: from("temper", "Temper engine"),
		kind: "request",
		text: "Please do the live thing.",
	};
	await prompt(roleMessageText(live));
	await waitFor(() => p.$(rowSel(live.id)), 20_000);
	const settled = await waitFor(async () => {
		const r = (await quietRows(p)).find((x) => x.id === live.id);
		return r && !r.turn.includes("working") ? r : null;
	}, 20_000);
	check(
		"live: a turn a role message began folds into its row",
		settled?.turn === "\u2192 nothing sent",
		JSON.stringify(settled),
	);
	check("live: its reply isn't shown", !(await listText(p)).includes("LIVE-REPLY-TEXT"));
	await sleep(4000); // done-settle waits a moment before the cue
	check("live: no done sound for it", (await doneCues()) === 0, String(await doneCues()));
	const row = await p.evaluate((f) => (window.__convs ?? []).find((c) => c.sessionPath === f), liveFile);
	check(
		"live: its chat row says the last turn was quiet",
		row?.quietRun === true,
		JSON.stringify(row && { quietRun: row.quietRun }),
	);
	// Owner turn: sounds as before.
	await prompt("LIVE-OWNER: hello there");
	await waitFor(async () => (await listText(p)).includes("LIVE-REPLY-TEXT"), 20_000);
	const cue = await waitFor(async () => ((await doneCues()) >= 1 ? true : null), 10_000);
	check("live: an owner turn still sounds done", !!cue);
	const row2 = await p.evaluate((f) => (window.__convs ?? []).find((c) => c.sessionPath === f), liveFile);
	check("live: and its row isn't marked quiet", !row2?.quietRun, JSON.stringify(row2 && { quietRun: row2.quietRun }));
	// Green light: a quiet turn that ends while the owner is in another chat doesn't light it.
	const switchTo = (f) => p.evaluate((x) => window.__ws.send(JSON.stringify({ type: "switch_session", path: x })), f);
	const slow = { id: "rm-0000e002", from: from("qa", "QA"), kind: "question", text: "SLOWMARK: is it there?" };
	await prompt(roleMessageText(slow));
	await waitFor(() => p.$(rowSel(slow.id)), 20_000);
	await switchTo(chatFile);
	await waitFor(async () => (await listText(p)).includes("OWNER-ANSWER-VISIBLE"), 20_000);
	const after = await waitFor(async () => {
		const r = await p.evaluate((f) => (window.__convs ?? []).find((c) => c.sessionPath === f), liveFile);
		return r && !r.isStreaming && r.quietRun ? r : null;
	}, 20_000);
	check(
		"live: a quiet turn that ends in the background lights no green light",
		!!after && !after.waiting,
		JSON.stringify(after && { waiting: after.waiting, quietRun: after.quietRun }),
	);
	const slowOwner = "SLOWMARK LIVE-OWNER-2: one more";
	await switchTo(liveFile);
	await waitFor(async () => (await listText(p)).includes("LIVE-OWNER"), 20_000);
	await prompt(slowOwner);
	await sleep(500);
	await switchTo(chatFile);
	const lit = await waitFor(async () => {
		const r = await p.evaluate((f) => (window.__convs ?? []).find((c) => c.sessionPath === f), liveFile);
		return r?.waiting ? r : null;
	}, 20_000);
	check("live: an owner turn that ends in the background still lights it", !!lit);
	await context.close();
}

// =========================================================================================================
// 6. White, and phones
// =========================================================================================================
for (const [tag, opts] of [
	["desktop-white", { width: 1280, height: 900, theme: "white" }],
	["phone-dark", { width: 390, height: 844, phone: true }],
	["phone-white", { width: 390, height: 844, phone: true, theme: "white" }],
]) {
	const { context, page: p } = await openPage(opts);
	await waitFor(async () => (await quietRows(p)).length >= 4);
	const m = await measure(p);
	const minTarget = opts.phone ? 44 : 24;
	check(`${tag}: four quiet rows`, m.rows === 4, String(m.rows));
	check(
		`${tag}: rows one line, targets at least ${minTarget} px, the turn words shown, nothing sideways`,
		m.oneLine && m.minHeight >= minTarget && m.turnShown && m.overflowX <= 1,
		JSON.stringify(m),
	);
	const t = await listText(p);
	check(
		`${tag}: quiet text hidden, the owner's in full`,
		QUIET_TEXTS.every((s) => !t.includes(s)) && FULL_TEXTS.every((s) => t.includes(s)),
	);
	await shot(p, `${tag}-folded`, rowSel(REQ.id));
	await p.click(`${rowSel(ASKQ.id)} button`);
	check(`${tag}: a row opens`, !!(await waitFor(async () => (await listText(p)).includes("QUIET-ASK-TEXT"))));
	await shot(p, `${tag}-open`, cardSel(ASKQ.id));
	const axe = await runAxe(p);
	check(
		`${tag}: axe finds nothing serious or critical`,
		!axe.error && axe.bad.length === 0,
		axe.error ?? axe.bad.join("; "),
	);
	await context.close();
}

// =========================================================================================================
// 7. Nothing changed underneath
// =========================================================================================================
await browser.close();
{
	let problem = "";
	if (sha(chatFile) !== before) {
		const now = readFileSync(chatFile, "utf8");
		if (!now.startsWith(beforeText)) problem = "an existing line changed";
		else {
			const added = now.slice(beforeText.length).split("\n").filter(Boolean);
			const odd = added.filter((l) => !/^\{"type":"(thinking_level_change|model_change)"/.test(l));
			if (odd.length) problem = `added ${odd[0].slice(0, 200)}`;
		}
	}
	check("no line of the seeded transcript changed, and no message was added", !problem, problem);
}
check("the model answered only the live turns", modelCalls >= 3 && modelCalls <= 8, String(modelCalls));
check("the page logged no error", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
await srv.stop();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
