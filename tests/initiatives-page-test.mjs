/* initiatives-page E2E (no tokens): the Initiatives tab's Decisions section (initiatives-page patch, task #84)
 * in a sealed server and headless Chrome.
 *
 * A sealed server (TZ America/Los_Angeles, its own HOME, data and agent folders) with a stand-in model that
 * must never be called, and the decision reader switched off. Fixtures in <data>/decisions/: kept records
 * in the shapes of the real ones (an auto-approved plan, a plan he approved in a dialog, his dialog pick
 * with a rider inside it, a Board order relayed by COO, a role's message), decisions filed under two
 * initiatives and one Unfiled, a change, owner fields given and not given, and one quote that isn't in
 * its record word for word. Checks, in the dark and the White theme, at 390x844 (phone) and 1440x900:
 *  1. the top bar's Initiatives tab opens the page, and ?view=initiatives does too;
 *  2. the list: each initiative with its counts, how many lack impact and carry a credit flag; Unfiled;
 *  3. every card shows the writer and the approval as two separate labels (never one merged "who");
 *     "you" only where his own record holds the point: his pick, his order's words, a plan he approved
 *     ("Ops proposed, you approved"); a role's wording that says he decided is flagged on the card, a
 *     rider inside his pick is flagged with the role that chose it, and a quote not found word for word;
 *  4. an order card shows "Your words" and "COO's text" as two labelled parts;
 *  5. the three owner fields show their text (and who gave it) or "not given"; a change sits under its
 *     decision with its type chip and its own two labels;
 *  6. a source opens the record in a window (Escape closes it, focus back on the button); "Open the
 *     chat" opens the existing chat (no new chat);
 *  7. the reader's state shows (switched off);
 *  8. WCAG AA text contrast, targets (phone 44 px, desktop 24 px), no sideways overflow, axe-core with no
 *     serious or critical finding, a visible focus ring all the way through;
 *  9. looking changes nothing: decisions.json and records.jsonl keep their bytes; the model was never called.
 * Never prints what goes to a model (rule 11). Screenshots only with INITIATIVES_SHOT=<dir> (fixture shots).
 * Usage: npm run build && node tests/initiatives-page-test.mjs   (INITIATIVES_DEBUG=1: server output)
 * axe-core: PI_AXE_JS, else ~/temper-ai/configs/design/bin/vendor/axe-4.13.0.min.js.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";

const AXE = process.env.PI_AXE_JS ?? join(userInfo().homedir, "temper-ai/configs/design/bin/vendor/axe-4.13.0.min.js");
const SHOTS = process.env.INITIATIVES_SHOT || "";
const TZ = "America/Los_Angeles";
if (!CHROME_PATH) {
	console.log("✗ FAIL: no Chrome (set PI_WEB_CHROME)");
	process.exit(1);
}

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✓" : "✗ FAIL:"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures += 1;
}
async function waitFor(fn, timeout = 20_000, step = 150) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const v = await fn();
		if (v) return v;
		await sleep(step);
	}
	return null;
}
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

// ---- fixtures ------------------------------------------------------------------------------------------
const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
let seq = 0;
const eid = () => (++seq).toString(16).padStart(8, "0");

const CHAT_ID = "01a0f000-0000-7000-8000-0000000000a1";
const CHAT_NAME = `2026-10-05T10-00-00-000Z_${CHAT_ID}.jsonl`;
const OPS_CHAT_ID = "01a0f000-0000-7000-8000-0000000000a2";
const OPS_CHAT_NAME = `2026-10-05T11-00-00-000Z_${OPS_CHAT_ID}.jsonl`;

const T = {
	plan: NOW - 3 * DAY,
	answer: NOW - 2 * DAY,
	order: NOW - 1 * DAY - 3 * HOUR,
	message: NOW - 1 * DAY,
	dialogPlan: NOW - 20 * HOUR,
	odd: NOW - 10 * HOUR,
};

const base = { v: 1, how: "live", seen: 0 };
const RECORDS = [
	{
		...base,
		id: "dr-e2e-plan",
		source: "plan",
		at: T.plan,
		seen: T.plan,
		from: "architecture",
		ref: `${CHAT_NAME}:3`,
		file: CHAT_NAME,
		chat: "architecture",
		task: 16,
		op: "add",
		approval: "auto",
		initiative: "team-in-temper",
		plan: {
			title: "First team trial",
			goal: "Run the first team trial on a scratch project.",
			decided: "Members take turns one at a time.\nThe owner already decided that reviews happen weekly.",
			steps: "1. Build the members.\n2. Run the scratch project.",
			verify: "The trial finishes.",
		},
	},
	{
		...base,
		id: "dr-e2e-answer",
		source: "answer",
		at: T.answer,
		seen: T.answer,
		from: "owner",
		to: "temper",
		ref: "ask:toolu_e2e",
		ask: "question",
		chat: "temper",
		initiative: "team-in-temper",
		questions: [
			{
				id: "slice",
				question: "How should the first slice be built?",
				options: [
					{
						label: "Two tasks (recommended)",
						description: "A: messages and inboxes. B: the leader loop. Members take turns one at a time at first.",
					},
					{ label: "One task", description: "Same work as a single queue task." },
				],
				picked: ["Two tasks (recommended)"],
			},
		],
	},
	{
		...base,
		id: "dr-e2e-order",
		source: "board",
		at: T.order,
		seen: T.order,
		from: "owner",
		to: ["ops", "temper"],
		ref: "bp-e2e-order",
		kind: "order",
		initiative: "team-in-temper",
		title: "Make the team dashboard reachable over Tailscale",
		text: "Coordinate the Standee work with Temper. Keep it tailnet-only, with access controls.",
		ownerWords: 'Owner in COO\'s chat: "make it available over tailscale, give it a name i can resolve"',
		via: "coo",
	},
	{
		...base,
		id: "dr-e2e-message",
		source: "message",
		at: T.message,
		seen: T.message,
		from: "product",
		to: "ops",
		ref: "rm-e2e-lanes",
		kind: "fyi",
		text: "From today the queue keeps four lanes, so four tasks can run side by side.",
	},
	{
		...base,
		id: "dr-e2e-dialog-plan",
		source: "plan",
		at: T.dialogPlan,
		seen: T.dialogPlan,
		from: "ops",
		ref: `${OPS_CHAT_NAME}:3`,
		file: OPS_CHAT_NAME,
		chat: "ops",
		task: 40,
		op: "add",
		approval: "dialog",
		initiative: "pi-tools",
		plan: { title: "Nightly backups", decided: "Backups run every night at 04:30.", verify: "A restore works." },
	},
	{
		...base,
		id: "dr-e2e-odd",
		source: "message",
		at: T.odd,
		seen: T.odd,
		from: "ops",
		to: "data",
		ref: "rm-e2e-odd",
		kind: "fyi",
		initiative: "pi-tools",
		text: "The scheduler moved to the new box.",
	},
];

const src = (record, at, quotes, extra = {}) => ({
	record,
	ref: RECORDS.find((r) => r.id === record).ref,
	at,
	quotes,
	by: "reader",
	...extra,
});
const DECISIONS = {
	v: 1,
	next: 20,
	decisions: [
		{
			id: "d1",
			initiative: "team-in-temper",
			filedBy: "tag",
			title: "Members take turns one at a time",
			what: "Team members take turns one at a time, not in parallel.",
			at: T.plan,
			sources: [src("dr-e2e-plan", T.plan, ["Members take turns one at a time"])],
			changes: [
				{
					id: "c1",
					type: "re-recorded",
					what: "One-at-a-time turns came back inside the slice option he picked.",
					at: T.answer,
					sources: [src("dr-e2e-answer", T.answer, ["Members take turns one at a time at first"], { part: "rider" })],
					by: "reader",
				},
			],
			by: "reader",
		},
		{
			id: "d2",
			initiative: "team-in-temper",
			filedBy: "tag",
			title: "Reviews happen weekly",
			what: "Team reviews happen once a week.",
			at: T.plan + 1000,
			sources: [src("dr-e2e-plan", T.plan, ["reviews happen weekly"], { claimsOwner: true })],
			changes: [],
			by: "reader",
		},
		{
			id: "d3",
			initiative: "team-in-temper",
			filedBy: "tag",
			title: "Build the first slice as two tasks",
			what: "Messages and inboxes first, then the leader loop.",
			at: T.answer,
			impact: { text: "Two approvals instead of one.", by: "reader", record: "dr-e2e-answer", at: T.answer },
			sources: [src("dr-e2e-answer", T.answer, ["Two tasks (recommended)"], { part: "main" })],
			changes: [],
			by: "reader",
		},
		{
			id: "d4",
			initiative: "team-in-temper",
			filedBy: "tag",
			title: "Dashboard reachable over Tailscale",
			what: "The team dashboard is reachable over Tailscale with a name he can resolve.",
			at: T.order,
			sources: [src("dr-e2e-order", T.order, ["make it available over tailscale"])],
			changes: [],
			by: "reader",
		},
		{
			id: "d5",
			initiative: "team-in-temper",
			filedBy: "tag",
			title: "Dashboard stays tailnet-only",
			what: "No public Internet exposure; access controls on.",
			at: T.order + 1000,
			sources: [src("dr-e2e-order", T.order, ["Keep it tailnet-only, with access controls"])],
			changes: [],
			by: "reader",
		},
		{
			id: "d6",
			initiative: null,
			filedBy: "",
			title: "The queue keeps four lanes",
			what: "Four queued tasks can run side by side.",
			at: T.message,
			impact: { text: "Four chats at once use more of the Claude quota.", by: "role:product", at: T.message + HOUR },
			sources: [src("dr-e2e-message", T.message, ["the queue keeps four lanes"])],
			changes: [],
			by: "reader",
		},
		{
			id: "d7",
			initiative: "pi-tools",
			filedBy: "tag",
			title: "Backups every night at 04:30",
			what: "The nightly backup runs at 04:30.",
			at: T.dialogPlan,
			until: { text: "Until the off-site copy is in place.", by: "role:ops", at: T.dialogPlan + HOUR },
			sources: [src("dr-e2e-dialog-plan", T.dialogPlan, ["Backups run every night at 04:30"])],
			changes: [],
			by: "reader",
		},
		{
			id: "d8",
			initiative: "pi-tools",
			filedBy: "tag",
			title: "The scheduler runs on the new box",
			what: "Scheduled jobs moved.",
			at: T.odd,
			sources: [src("dr-e2e-odd", T.odd, ["the owner moved the scheduler himself"])],
			changes: [],
			by: "reader",
		},
	],
};
const INITIATIVES = [
	{ id: "team-in-temper", name: "Team in Temper", markers: ["re:team in temper"], lead: null },
	{ id: "pi-tools", name: "Pi tools", markers: ["re:pi tools"], lead: null },
];

let chatPath = "";
let opsChatPath = "";
let decisionsFile = "";
let recordsFile = "";

function writeChat(path, sessionId, cwd, texts, at) {
	let parent = null;
	const lines = texts.map(([role, text], i) => {
		const ts = at + i * 1000;
		const id = eid();
		const l = {
			type: "message",
			id,
			parentId: parent,
			timestamp: iso(ts),
			message:
				role === "user"
					? { role: "user", content: [{ type: "text", text }], timestamp: ts }
					: {
							role: "assistant",
							content: [{ type: "text", text }],
							api: "openai-completions",
							provider: "mock",
							model: "mock-model",
							usage: {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 2,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: ts,
						},
		};
		parent = id;
		return l;
	});
	const head = { type: "session", version: 3, id: sessionId, timestamp: iso(at - 1000), cwd };
	writeFileSync(path, `${[head, ...lines].map((l) => JSON.stringify(l)).join("\n")}\n`);
	const last = (at + texts.length * 1000) / 1000;
	utimesSync(path, last, last);
}

function seed({ dataDir, workdir, agentDir }) {
	const sessionsDir = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(sessionsDir, { recursive: true });
	chatPath = join(sessionsDir, CHAT_NAME);
	opsChatPath = join(sessionsDir, OPS_CHAT_NAME);
	writeChat(
		chatPath,
		CHAT_ID,
		workdir,
		[
			["user", "Plan the first team trial."],
			["assistant", "Queued as task 16: members take turns one at a time."],
		],
		T.plan - 5 * MIN,
	);
	writeChat(
		opsChatPath,
		OPS_CHAT_ID,
		workdir,
		[
			["user", "Plan the nightly backups."],
			["assistant", "Planned: backups run every night at 04:30."],
		],
		T.dialogPlan - 5 * MIN,
	);
	const dir = join(dataDir, "decisions");
	mkdirSync(dir, { recursive: true });
	recordsFile = join(dir, "records.jsonl");
	decisionsFile = join(dir, "decisions.json");
	writeFileSync(recordsFile, `${RECORDS.map((r) => JSON.stringify(r)).join("\n")}\n`);
	writeFileSync(decisionsFile, `${JSON.stringify(DECISIONS, null, "\t")}\n`);
	writeFileSync(join(dir, "initiatives.json"), `${JSON.stringify(INITIATIVES, null, "\t")}\n`);
	// The reader stays off: the stand-in model must never be called.
	writeFileSync(
		join(dir, "settings.json"),
		`${JSON.stringify({ enabled: false, readFrom: "2026-10-03" }, null, "\t")}\n`,
	);
}

let modelCalls = 0;
const srv = await ownServer({
	name: "initiatives-page",
	verbose: !!process.env.INITIATIVES_DEBUG,
	mock: () => {
		modelCalls += 1;
		return "ok";
	},
	prepare: seed,
	env: { TZ },
});
const before = {
	decisions: sha(decisionsFile),
	records: sha(recordsFile),
	chatBytes: readFileSync(chatPath),
	opsBytes: readFileSync(opsChatPath),
};

// ---- the browser -----------------------------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
let lastSnapshot = null;
function listen(page) {
	page.on("websocket", (ws) => {
		ws.on("framereceived", ({ payload }) => {
			if (typeof payload !== "string" || !payload.startsWith('{"type":"snapshot"')) return;
			try {
				const m = JSON.parse(payload);
				lastSnapshot = { at: Date.now(), sessionFile: m.state?.sessionFile };
			} catch {
				/* not it */
			}
		});
	});
}
async function openPage({ width, height, phone = false, theme = null, path = "/?view=initiatives" }) {
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
	}, theme);
	const page = await context.newPage();
	listen(page);
	await page.goto(`${srv.http}${path}`);
	return { context, page };
}
async function waitCards(page, n = 1) {
	await page.waitForSelector(".initiatives-view .iv-card", { timeout: 30_000 });
	await waitFor(
		() => page.evaluate((k) => document.querySelectorAll(".initiatives-view .iv-card").length >= k, n),
		10_000,
	);
	await page.evaluate(() => document.fonts?.ready);
	await sleep(300);
}
async function shot(page, name) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}

/** The cards as text facts: title -> writer, approval, you, flags, order parts, fields, changes. */
const CARDS = () =>
	Object.fromEntries(
		[...document.querySelectorAll(".initiatives-view .iv-card")].map((c) => {
			const own = (sel) => [...c.querySelectorAll(sel)].filter((e) => !e.closest(".iv-change"));
			const txt = (e) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
			return [
				txt(c.querySelector(".iv-dtitle")),
				{
					writers: own(".iv-writer").map(txt),
					approvals: own(".iv-approval").map(txt),
					you: own(".iv-you").map(txt),
					flags: own(".iv-flag").map(txt),
					flagged: c.classList.contains("iv-flagged"),
					parts: own(".iv-part").map((p) => ({
						label: txt(p.querySelector(".iv-plabel")),
						text: txt(p.querySelector(".iv-ptext")),
					})),
					fields: own(".iv-field").map(txt),
					changes: [...c.querySelectorAll(".iv-change")].map((ch) => ({
						type: txt(ch.querySelector(".iv-type")),
						writers: [...ch.querySelectorAll(".iv-writer")].map(txt),
						approvals: [...ch.querySelectorAll(".iv-approval")].map(txt),
						flags: [...ch.querySelectorAll(".iv-flag")].map(txt),
					})),
					sources: c.querySelectorAll(".iv-src").length,
				},
			];
		}),
	);

/** Contrast, targets, clipping and sideways overflow on the page as it is on screen. */
const MEASURE = () => {
	const root = document.querySelector(".initiatives-view");
	const parse = (s) => {
		const m = s.match(/rgba?\(([^)]+)\)/);
		if (!m) return null;
		const p = m[1]
			.split(/[ ,/]+/)
			.filter(Boolean)
			.map(Number);
		return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
	};
	const over = (top, bot) => ({
		r: top.r * top.a + bot.r * (1 - top.a),
		g: top.g * top.a + bot.g * (1 - top.a),
		b: top.b * top.a + bot.b * (1 - top.a),
		a: 1,
	});
	const bgOf = (el) => {
		const layers = [];
		for (let e = el; e; e = e.parentElement) {
			const c = parse(getComputedStyle(e).backgroundColor);
			if (c && c.a > 0) {
				layers.push(c);
				if (c.a >= 1) break;
			}
		}
		let bg = { r: 255, g: 255, b: 255, a: 1 };
		for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
		return bg;
	};
	const lum = (c) => {
		const f = (v) => {
			v /= 255;
			return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
		};
		return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
	};
	const ratio = (a, b) => {
		const x = lum(a);
		const y = lum(b);
		return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
	};
	const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
	const label = (e) =>
		`${e.tagName.toLowerCase()}.${String(e.className?.baseVal ?? e.className)
			.trim()
			.split(/\s+/)
			.join(".")} "${(e.textContent || "").trim().slice(0, 40)}"`;
	const textFails = [];
	for (const el of root.querySelectorAll("*")) {
		if (!vis(el) || el.closest(".iv-sr")) continue;
		if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
		const cs = getComputedStyle(el);
		const fg0 = parse(cs.color);
		const bg = bgOf(el);
		const fg = over({ ...fg0, a: fg0.a * Number.parseFloat(cs.opacity || "1") }, bg);
		const r = ratio(fg, bg);
		const px = Number.parseFloat(cs.fontSize);
		const large = px >= 24 || (Number.parseInt(cs.fontWeight, 10) >= 700 && px >= 18.66);
		if (r < (large ? 3 : 4.5)) textFails.push(`${label(el)} ${r.toFixed(2)}`);
	}
	const narrow = innerWidth <= 768;
	const small = [];
	for (const el of root.querySelectorAll("a[href], button, summary")) {
		if (!vis(el)) continue;
		if (el.closest("p, li") && getComputedStyle(el).display === "inline") continue;
		const b = el.getBoundingClientRect();
		const w = Math.round(b.width);
		const h = Math.round(b.height);
		if (w < 24 || h < 24 || (narrow && h < 44)) small.push(`${label(el)} ${w}x${h}`);
	}
	const clipped = [];
	for (const el of root.querySelectorAll(".iv-chip, .iv-type, .iv-flag, .iv-rname, .iv-dtitle")) {
		if (!vis(el)) continue;
		if (el.scrollWidth > el.clientWidth + 1) clipped.push(label(el));
	}
	return {
		textFails,
		small,
		clipped,
		overflowX: Math.max(root.scrollWidth - root.clientWidth, document.documentElement.scrollWidth - innerWidth),
	};
};

async function runAxe(page) {
	if (!existsSync(AXE)) return { error: `axe-core not found at ${AXE} (set PI_AXE_JS)` };
	await page.addScriptTag({ path: AXE });
	return page.evaluate(async () => {
		const r = await window.axe.run(document.querySelector(".initiatives-view"), {
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
							.map((n) => {
								const d = n.any?.[0]?.data;
								const c = d?.fgColor ? ` (${d.fgColor} on ${d.bgColor}, ${d.contrastRatio}:1)` : "";
								return `${n.target.join(" ")}${c}`;
							})
							.join(", ")}`,
				),
		};
	});
}

async function focusWalk(page, steps = 30) {
	await page.evaluate(() => {
		const first = document.querySelector(".initiatives-view .iv-row");
		first?.focus();
	});
	const without = [];
	let inside = 0;
	for (let i = 0; i < steps; i++) {
		const f = await page.evaluate(() => {
			const a = document.activeElement;
			if (!a || !a.closest(".initiatives-view")) return null;
			const cs = getComputedStyle(a);
			return {
				el: `${a.className} "${(a.textContent || "").trim().slice(0, 30)}"`,
				ring: cs.boxShadow !== "none" || (cs.outlineStyle !== "none" && Number.parseFloat(cs.outlineWidth) > 0),
			};
		});
		if (f) {
			inside += 1;
			if (!f.ring) without.push(f.el);
		}
		await page.keyboard.press("Tab");
	}
	return { inside, without };
}

async function visualChecks(page, tag, { phone }) {
	const m = await page.evaluate(MEASURE);
	check(`${tag}: text contrast WCAG AA`, m.textFails.length === 0, m.textFails.slice(0, 5).join("; "));
	check(`${tag}: targets ${phone ? "44" : "24"} px`, m.small.length === 0, m.small.slice(0, 5).join("; "));
	check(`${tag}: no label cut off`, m.clipped.length === 0, m.clipped.slice(0, 5).join("; "));
	check(`${tag}: no sideways overflow`, m.overflowX <= 1, `${m.overflowX}px`);
	const axe = await runAxe(page);
	check(
		`${tag}: axe-core, no serious or critical finding`,
		!axe.error && axe.bad.length === 0,
		axe.error ?? axe.bad.join(" | "),
	);
}

async function selectInitiative(page, name) {
	await page.evaluate((n) => {
		const row = [...document.querySelectorAll(".initiatives-view .iv-row")].find(
			(r) => r.querySelector(".iv-rname")?.textContent?.trim() === n,
		);
		row?.click();
	}, name);
	await waitFor(
		() =>
			page.evaluate(
				(n) =>
					document.querySelector(".initiatives-view .iv-row.iv-current .iv-rname")?.textContent?.trim() === n &&
					document.querySelector(".initiatives-view .iv-iname")?.textContent?.trim() === n,
				name,
			),
		10_000,
	);
	await sleep(250);
}

try {
	// ---- 1. the tab -------------------------------------------------------------------------------------
	const desk = await openPage({ width: 1440, height: 900, path: "/" });
	let page = desk.page;
	await page.waitForSelector(".initiatives-tab", { timeout: 30_000 });
	check("top bar has the Initiatives tab", (await page.textContent(".initiatives-tab"))?.trim() === "Initiatives");
	await page.click(".initiatives-tab");
	await waitCards(page, 5);
	check(
		"the tab opens the Initiatives page",
		await page.evaluate(() => !!document.querySelector(".initiatives-pane .initiatives-view")),
	);
	const linked = await openPage({ width: 1440, height: 900 });
	await waitCards(linked.page, 5);
	check(
		"?view=initiatives opens it too",
		await linked.page.evaluate(() => !!document.querySelector(".initiatives-view .iv-card")),
	);
	await linked.context.close();

	// ---- 2. the list --------------------------------------------------------------------------------------
	const rows = await page.evaluate(() =>
		[...document.querySelectorAll(".initiatives-view .iv-row")].map((r) => ({
			name: r.querySelector(".iv-rname")?.textContent?.trim(),
			text: r.textContent.replace(/\s+/g, " ").trim(),
			current: r.getAttribute("aria-current"),
		})),
	);
	check(
		"list: Team in Temper, Pi tools, Unfiled",
		JSON.stringify(rows.map((r) => r.name)) === JSON.stringify(["Team in Temper", "Pi tools", "Unfiled"]),
		JSON.stringify(rows.map((r) => r.name)),
	);
	const team = rows.find((r) => r.name === "Team in Temper");
	check(
		"list: the first initiative is open (aria-current)",
		team?.current === "true" || team?.current === "page",
		team?.current,
	);
	check("list: counts decisions and changes", /5 decisions · 1 change(?!s)/.test(team?.text ?? ""), team?.text);
	// Entries without impact: decisions d1 d2 d4 d5 and the change c1 (d3 has one).
	check(
		"list: how many entries lack impact for you",
		/(^|\D)5 without impact for you/.test(team?.text ?? ""),
		team?.text,
	);
	check("list: how many carry a credit flag", /\d+ with a credit flag/.test(team?.text ?? ""), team?.text);

	// ---- 3-5. the cards -------------------------------------------------------------------------------------
	const cards = await page.evaluate(CARDS);
	const titles = Object.keys(cards);
	check(
		"cards: newest first",
		JSON.stringify(titles) ===
			JSON.stringify([
				"Dashboard stays tailnet-only",
				"Dashboard reachable over Tailscale",
				// newest activity first: d1's change (with d3's record) is newer than d2
				"Build the first slice as two tasks",
				"Members take turns one at a time",
				"Reviews happen weekly",
			]),
		JSON.stringify(titles),
	);
	const merged = titles.filter((k) => cards[k].writers.length !== 1 || cards[k].approvals.length !== 1);
	check(
		"every card: one writer label and one approval label, side by side (no merged who)",
		merged.length === 0,
		merged.join(", "),
	);

	const turns = cards["Members take turns one at a time"];
	check(
		"auto-approved plan: 'Architecture · auto-approved plan', not you, no flag",
		turns?.writers[0] === "Written by: Architecture" &&
			turns.approvals[0] === "Approval: auto-approved plan (you didn't see it)" &&
			turns.you.length === 0 &&
			turns.flags.length === 0,
		JSON.stringify(turns),
	);
	const ch = turns?.changes[0];
	check(
		"change beneath its decision: type chip, its own two labels, rider flagged with the role that chose it (E01)",
		turns?.changes.length === 1 &&
			ch.type === "Re-recorded as yours" &&
			ch.writers[0] === "Written by: Temper" &&
			ch.approvals[0] === "Approval: your pick in a dialog" &&
			ch.flags.includes("Temper's choice, inside the option you picked"),
		JSON.stringify(ch),
	);

	const weekly = cards["Reviews happen weekly"];
	check(
		"a role's wording that says you decided: not you, flagged on the card (E02)",
		weekly?.you.length === 0 && weekly.flagged && weekly.flags.includes("A role says you decided; not in your words"),
		JSON.stringify(weekly),
	);

	const slice = cards["Build the first slice as two tasks"];
	check(
		"his pick: 'You decided: your pick', written by You",
		slice?.writers[0] === "Written by: You" &&
			slice.approvals[0] === "Approval: your pick in a dialog" &&
			slice.you.some((y) => y.includes("You decided: your pick")) &&
			slice.flags.length === 0,
		JSON.stringify(slice),
	);
	check(
		"owner fields: given text with who gave it, or 'not given'",
		slice?.fields.some((f) => f.startsWith("Impact for you") && f.includes("Two approvals instead of one.")) &&
			slice.fields.some((f) => f.startsWith("Other options and their cost") && f.includes("not given")) &&
			slice.fields.some((f) => f.startsWith("Until when") && f.includes("not given")),
		JSON.stringify(slice?.fields),
	);

	const tailscale = cards["Dashboard reachable over Tailscale"];
	const tailnet = cards["Dashboard stays tailnet-only"];
	check(
		"order, point in his words: 'You decided: in your words'",
		tailscale?.writers[0] === "Written by: You" &&
			tailscale.approvals[0] === "Approval: your order" &&
			tailscale.you.some((y) => y.includes("in your words")) &&
			tailscale.flags.length === 0,
		JSON.stringify(tailscale),
	);
	check(
		"order card: 'Your words' and 'COO's text' as two labelled parts",
		tailnet?.parts.length === 2 &&
			tailnet.parts[0].label === "Your words" &&
			tailnet.parts[0].text.includes("make it available over tailscale") &&
			tailnet.parts[1].label === "COO's text" &&
			tailnet.parts[1].text.includes("Keep it tailnet-only"),
		JSON.stringify(tailnet?.parts),
	);
	check(
		"order, point only in the relayer's text: written by COO, flagged, not you (E60)",
		tailnet?.writers[0] === "Written by: COO" &&
			tailnet.approvals[0] === "Approval: your order" &&
			tailnet.you.length === 0 &&
			tailnet.flags.includes("A role says you decided; not in your words"),
		JSON.stringify(tailnet),
	);
	await shot(page, "desktop-dark-team");

	// ---- 6. a source opens; the chat opens -----------------------------------------------------------------
	// The decision's own first source (not its change's).
	const openerSel = '[data-e2e="opener"]';
	await page.evaluate(() => {
		const card = document.querySelector('.iv-card[aria-labelledby="iv-d-d1"]');
		const btn = [...(card?.querySelectorAll(".iv-src") ?? [])].find((b) => !b.closest(".iv-change"));
		btn?.setAttribute("data-e2e", "opener");
	});
	await page.locator(openerSel).first().click();
	const dlg = await waitFor(
		() =>
			page.evaluate(() => {
				const d = document.querySelector("dialog.iv-dialog");
				if (!d?.open) return null;
				const body = d.querySelector(".iv-record")?.textContent ?? "";
				return body.includes("Members take turns one at a time")
					? { body, chat: !!d.querySelector(".iv-primary") }
					: null;
			}),
		10_000,
	);
	check("a source opens its record in a window", !!dlg, "no dialog with the plan's text");
	check("the window offers 'Open the chat' for a chat that still exists", dlg?.chat === true);
	await shot(page, "desktop-dark-source");
	await page.keyboard.press("Escape");
	const back = await waitFor(
		() =>
			page.evaluate(
				() =>
					!document.querySelector("dialog.iv-dialog")?.open &&
					document.activeElement?.classList.contains("iv-src") &&
					document.activeElement.closest('[aria-labelledby="iv-d-d1"]') !== null,
			),
		5_000,
	);
	check("Escape closes it, focus back on its source button", !!back);
	await page.locator(openerSel).first().click();
	await page.waitForSelector("dialog.iv-dialog[open] .iv-primary", { timeout: 10_000 });
	const clickedAt = Date.now();
	await page.click("dialog.iv-dialog[open] .iv-primary");
	const opened = await waitFor(
		() => lastSnapshot && lastSnapshot.at >= clickedAt && lastSnapshot.sessionFile === chatPath && lastSnapshot,
		15_000,
	);
	check("'Open the chat' opens the existing chat", !!opened, lastSnapshot?.sessionFile ?? "no snapshot");

	// ---- the other initiative and Unfiled -------------------------------------------------------------------
	await page.goto(`${srv.http}/?view=initiatives`);
	await waitCards(page, 5);
	await selectInitiative(page, "Pi tools");
	const pi = await page.evaluate(CARDS);
	const backups = pi["Backups every night at 04:30"];
	check(
		"plan he approved in a dialog: 'Ops proposed, you approved'",
		backups?.writers[0] === "Written by: Ops" &&
			backups.approvals[0] === "Approval: plan you approved in a dialog" &&
			backups.you.some((y) => y.includes("Ops proposed, you approved")),
		JSON.stringify(backups),
	);
	check(
		"'Until when' given by a role shows who gave it",
		backups?.fields.some(
			(f) => f.startsWith("Until when") && f.includes("Until the off-site copy") && f.includes("given by Ops"),
		),
		JSON.stringify(backups?.fields),
	);
	const odd = pi["The scheduler runs on the new box"];
	check(
		"a quote not in its record word for word is flagged, never you",
		odd?.you.length === 0 && odd.flags.includes("The quote isn't in the record word for word"),
		JSON.stringify(odd),
	);
	await selectInitiative(page, "Unfiled");
	const unf = await page.evaluate(CARDS);
	const lanes = unf["The queue keeps four lanes"];
	check(
		"Unfiled: a role's message, 'Product · message', impact given by Product",
		lanes?.writers[0] === "Written by: Product" &&
			lanes.approvals[0] === "Approval: message" &&
			lanes.fields.some((f) => f.startsWith("Impact for you") && f.includes("given by Product")),
		JSON.stringify(lanes),
	);

	// ---- 7. the reader's state ------------------------------------------------------------------------------
	check(
		"the reader's state shows (switched off)",
		await page.evaluate(() =>
			(document.querySelector(".initiatives-view .iv-reader")?.textContent ?? "").includes("switched off"),
		),
	);
	await desk.context.close();

	// ---- 8. looks: desktop and phone, dark and White ---------------------------------------------------------
	for (const [w, h, phone] of [
		[1440, 900, false],
		[390, 844, true],
	]) {
		for (const theme of [null, "white"]) {
			const tag = `${phone ? "phone" : "desktop"} ${theme ?? "dark"}`;
			const v = await openPage({ width: w, height: h, phone, theme });
			await waitCards(v.page, 5);
			await visualChecks(v.page, tag, { phone });
			if (!phone && !theme) {
				const walk = await focusWalk(v.page);
				check(`${tag}: keyboard reaches the page`, walk.inside >= 10, `${walk.inside} stops`);
				check(
					`${tag}: visible focus ring all the way through`,
					walk.without.length === 0,
					walk.without.slice(0, 4).join("; "),
				);
			}
			if (phone) {
				const card = await v.page.evaluate(() => {
					const c = document.querySelector(".initiatives-view .iv-card");
					const b = c?.getBoundingClientRect();
					return b ? { left: b.left, right: b.right } : null;
				});
				check(
					`${tag}: cards fit the phone's width`,
					!!card && card.left >= 0 && card.right <= 390.5,
					JSON.stringify(card),
				);
			}
			await shot(v.page, `${phone ? "phone" : "desktop"}-${theme ?? "dark"}`);
			await v.context.close();
		}
	}

	// ---- 9. looking changed nothing ---------------------------------------------------------------------------
	check("decisions.json kept its bytes", sha(decisionsFile) === before.decisions);
	check("records.jsonl kept its bytes", sha(recordsFile) === before.records);
	// Opening a chat lets the app add its own lines to it; the lines already there must stay as they were.
	check(
		"the opened chat kept its lines",
		readFileSync(chatPath).subarray(0, before.chatBytes.length).equals(before.chatBytes),
	);
	check(
		"the other chat kept its lines",
		readFileSync(opsChatPath).subarray(0, before.opsBytes.length).equals(before.opsBytes),
	);
	check("the model was never called", modelCalls === 0, `${modelCalls} calls`);
} catch (err) {
	check("no unexpected error", false, err?.stack ?? String(err));
} finally {
	await browser.close().catch(() => {});
	await srv.stop();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall initiatives-page checks passed");
process.exit(failures ? 1 : 0);
