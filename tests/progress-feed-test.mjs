/* progress-feed E2E (no tokens): the Initiatives tab's Progress section (progress-feed patch, task #85) in a
 * sealed server, headless Chrome, a scripted model and the real pi-identity.
 *
 * A sealed server (TZ America/Los_Angeles) with fake roles in a temp identities folder: architecture (home
 * chat A) and temper (home chat B), both saved transcripts, so both start closed. Fixtures in
 * <data>/decisions/: Team in Temper (in the feed's setting, its lead not yet stored, so it gets the owner's
 * own pick) and Pi tools (not in the setting); his dialog answer and a Board order COO relayed (its
 * ownerWords don't say "tailnet-only": Data's E60 case) with a decision each; the reader's labels off
 * (feedReaderCheck false), so only code checks updates and no model is asked to read. Checks:
 *  1. Team in Temper: Progress sits above Decisions; "Lead: Architecture · Set by you, Oct 9" (the seeded
 *     pick); "Not in any update yet: 2 decisions"; Pi tools shows "Progress: off";
 *  2. the picker: "No lead" -> "No lead yet" and no Ask button; Architecture again -> "Set by you, <today>",
 *     stored with by "owner" and source "page";
 *  3. Ask: the poke reaches A only, from the Initiatives page, naming the owner's request and the tool; while
 *     it's open the page says "Asked Architecture at hh:mm, no update yet";
 *  4. A posts with initiative_update: the update shows (writer, its fields, "not given"), its sources one
 *     click away, the faithful credit passes and "You decided to keep it tailnet-only…" is flagged "Not in
 *     its sources" (found by a script); every decision is in an update; the list row shows the lead;
 *  5. nothing was poked for Pi tools, and B got nothing;
 *  6. WCAG AA text contrast, targets, no sideways overflow, axe-core with no serious or critical finding, in
 *     dark and White, at 1440x900 and 390x844.
 * Never prints what goes to the model (rule 11). Screenshots only with PROGRESS_SHOT=<dir>.
 * Usage: npm run build && node tests/progress-feed-test.mjs   (PROGRESS_DEBUG=1: server output)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { textOf } from "./lib/mock-model.mjs";
import { ownServer } from "./lib/own-server.mjs";

const PI_IDENTITY = process.env.PI_IDENTITY_PKG ?? join(userInfo().homedir, "projects", "pi-identity");
const AXE = process.env.PI_AXE_JS ?? join(userInfo().homedir, "temper-ai/configs/design/bin/vendor/axe-4.13.0.min.js");
const SHOTS = process.env.PROGRESS_SHOT || "";
const TZ = "America/Los_Angeles";
if (!CHROME_PATH) {
	console.log("✗ FAIL: no Chrome (set PI_WEB_CHROME)");
	process.exit(1);
}
if (!existsSync(join(PI_IDENTITY, "package.json"))) {
	console.log(`✗ FAIL: pi-identity not found at ${PI_IDENTITY} (set PI_IDENTITY_PKG)`);
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

// ---- fixtures ------------------------------------------------------------------------------------------
const NOW = Date.now();
const HOUR = 3_600_000;
const T = { answer: NOW - 30 * HOUR, order: NOW - 20 * HOUR, other: NOW - 10 * HOUR };
const TIT = "team-in-temper";
const base = { v: 1, how: "live" };
const RECORDS = [
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
		initiative: TIT,
		questions: [
			{
				id: "slice",
				question: "How should the first slice be built?",
				options: [
					{ label: "Two tasks (recommended)", description: "A: messages and inboxes. B: the leader loop." },
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
		initiative: TIT,
		title: "Send the owner a link to the Team page",
		text: "Give the owner a link to the Team page to watch the run; keep it tailnet-only, with access controls.",
		ownerWords: 'Owner to COO: "send me the link to the team page so i can watch the run"',
		via: "coo",
	},
	{
		...base,
		id: "dr-e2e-other",
		source: "message",
		at: T.other,
		seen: T.other,
		from: "ops",
		to: "data",
		ref: "rm-e2e-other",
		kind: "fyi",
		initiative: "pi-tools",
		text: "The scheduler moved to the new box.",
	},
];
const src = (record, at, quotes) => ({
	record,
	ref: RECORDS.find((r) => r.id === record).ref,
	at,
	quotes,
	by: "reader",
});
const DECISIONS = {
	v: 1,
	next: 10,
	decisions: [
		{
			id: "d1",
			initiative: TIT,
			filedBy: "tag",
			title: "Build the first slice as two tasks",
			what: "Messages and inboxes first, then the leader loop.",
			at: T.answer,
			sources: [src("dr-e2e-answer", T.answer, ["Two tasks (recommended)"])],
			changes: [],
			by: "reader",
		},
		{
			id: "d2",
			initiative: TIT,
			filedBy: "tag",
			title: "The Team page link stays tailnet-only",
			what: "The link works on the tailnet only, with access controls.",
			at: T.order,
			sources: [src("dr-e2e-order", T.order, ["keep it tailnet-only, with access controls"])],
			changes: [],
			by: "reader",
		},
		{
			id: "d3",
			initiative: "pi-tools",
			filedBy: "tag",
			title: "The scheduler runs on the new box",
			what: "Scheduled jobs moved.",
			at: T.other,
			sources: [src("dr-e2e-other", T.other, ["The scheduler moved to the new box"])],
			changes: [],
			by: "reader",
		},
	],
};
const INITIATIVES = [
	{ id: TIT, name: "Team in Temper", markers: ["re:team in temper"], lead: null },
	{ id: "pi-tools", name: "Pi tools", markers: ["re:pi tools"], lead: null },
];
/** The daily ask 12 hours from now, so it never comes round during the test. */
const dailyAt = (() => {
	const d = new Date(NOW + 12 * HOUR);
	const hm = new Intl.DateTimeFormat("en-GB", {
		timeZone: TZ,
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(d);
	return hm.replace(/^24:/, "00:");
})();

// ---- the scripted model ----------------------------------------------------------------------------------
const POKE_HEAD = /^\[Role message (rm-[0-9a-f]{8}) from the Initiatives page · progress update · Team in Temper\]/;
const POST = {
	action: "post",
	initiative: TIT,
	changed:
		"You picked building the first slice as two tasks. You decided to keep it tailnet-only with access controls.",
	next: "Build the messages and inboxes first.",
	needs_you: "",
	sources: ["dr-e2e-answer", "dr-e2e-order", "d1", "d2"],
};
const seen = { pokes: [], postResult: null, calls: 0 };
let release = null;
const gate = new Promise((r) => {
	release = r;
});
async function reply({ payload, lastUser, toolResult, sideRequest }) {
	seen.calls += 1;
	if (sideRequest) return "Chat";
	if (toolResult) {
		seen.postResult = String(toolResult.content ?? "");
		return "Posted.";
	}
	const users = (Array.isArray(payload.messages) ? payload.messages : []).filter((m) => m.role === "user");
	const last = users.length > 0 ? textOf(users.at(-1)) : lastUser;
	const head = POKE_HEAD.exec(last);
	if (!head) return "ok";
	// Booleans only: what the poke says is never printed (rule 11).
	seen.pokes.push({
		id: head[1],
		ownerRequest: last.includes("rm-ba07e068"),
		tool: last.includes("initiative_update"),
		holdsOnly: /say only what the linked records hold/i.test(last),
		unlinked: last.includes("d1") && last.includes("d2"),
		otherInitiative: last.includes("dr-e2e-other") || last.includes("d3 "),
	});
	await gate; // the page shows the open ask until the test lets the lead answer
	return { tool: "initiative_update", args: POST };
}

// ---- the saved chats and the roles ------------------------------------------------------------------------
const files = {};
let idDir = "";
let decisionsDir = "";
function seed({ root, agentDir, workdir, dataDir }) {
	const settingsFile = join(agentDir, "settings.json");
	const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {};
	settings.packages = [PI_IDENTITY];
	writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
	const dir = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(dir, { recursive: true });
	const file = (n) => join(dir, `2026-10-01T10-0${n}-00-000Z_01a0f000-0000-7000-8000-0000000000d${n}.jsonl`);
	files.A = file(1);
	files.B = file(2);
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const write = (path, roleId) => {
		const ts = Date.parse("2026-10-01T10:00:00.000Z");
		const id = path.match(/_([^_]+)\.jsonl$/)?.[1];
		const at = (n) => new Date(ts + n * 1000).toISOString();
		const lines = [
			{ type: "session", version: 3, id, timestamp: at(0), cwd: workdir },
			{ type: "model_change", id: "mc", parentId: null, timestamp: at(0), provider: "mock", modelId: "mock-model" },
			{
				type: "custom",
				customType: "identity",
				id: "e2",
				parentId: "mc",
				timestamp: at(1),
				data: { v: 1, id: roleId, via: "command" },
			},
			{
				type: "message",
				id: "e3",
				parentId: "e2",
				timestamp: at(2),
				message: { role: "user", content: [{ type: "text", text: `${roleId} home starts` }], timestamp: ts + 2000 },
			},
			{
				type: "message",
				id: "e4",
				parentId: "e3",
				timestamp: at(3),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: "openai-completions",
					provider: "mock",
					model: "mock-model",
					usage,
					stopReason: "stop",
					timestamp: ts + 3000,
				},
			},
		];
		writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	};
	write(files.A, "architecture");
	write(files.B, "temper");
	idDir = join(root, "identities");
	const role = (id, json) => {
		mkdirSync(join(idDir, id), { recursive: true });
		writeFileSync(join(idDir, id, "identity.json"), JSON.stringify({ id, ...json }, null, "\t"));
		writeFileSync(join(idDir, id, "about.md"), `# ${json.title}\n\n**Focus:** ${id} things.\n`);
		writeFileSync(join(idDir, id, "notebook.md"), "");
	};
	role("architecture", { title: "Architecture", homeChat: files.A });
	role("temper", { title: "Temper", homeChat: files.B });

	decisionsDir = join(dataDir, "decisions");
	mkdirSync(decisionsDir, { recursive: true });
	writeFileSync(join(decisionsDir, "records.jsonl"), `${RECORDS.map((r) => JSON.stringify(r)).join("\n")}\n`);
	writeFileSync(join(decisionsDir, "decisions.json"), `${JSON.stringify(DECISIONS, null, "\t")}\n`);
	writeFileSync(join(decisionsDir, "initiatives.json"), `${JSON.stringify(INITIATIVES, null, "\t")}\n`);
	writeFileSync(
		join(decisionsDir, "settings.json"),
		`${JSON.stringify(
			{ enabled: false, readFrom: "2026-10-03", feedInitiatives: [TIT], feedReaderCheck: false, dailyAt: dailyAt },
			null,
			"\t",
		)}\n`,
	);
}

const srv = await ownServer({
	name: "progress-feed",
	verbose: !!process.env.PROGRESS_DEBUG,
	mock: reply,
	prepare: seed,
	env: {
		TZ,
		get PI_IDENTITY_DIR() {
			return idDir;
		},
		PI_IDENTITY_REINDEX: "0",
	},
});

// ---- the browser -----------------------------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
async function openPage({ width, height, phone = false, theme = null }) {
	const context = await browser.newContext({
		viewport: { width, height },
		deviceScaleFactor: 1,
		isMobile: phone,
		hasTouch: phone,
		locale: "en-US",
		timezoneId: TZ,
	});
	await context.addInitScript((t) => {
		localStorage.setItem("pi-web-ui:lang", "en");
		if (t) localStorage.setItem("pi-web-ui:theme", t);
		else localStorage.removeItem("pi-web-ui:theme");
	}, theme);
	const page = await context.newPage();
	await page.goto(`${srv.http}/?view=initiatives`);
	await page.waitForSelector(".initiatives-view .iv-row", { timeout: 30_000 });
	await page.evaluate(() => document.fonts?.ready);
	return { context, page };
}
async function shot(page, name) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}
async function selectInitiative(page, name) {
	await page.evaluate((n) => {
		const row = [...document.querySelectorAll(".initiatives-view .iv-row")].find(
			(r) => r.querySelector(".iv-rname")?.textContent?.trim() === n,
		);
		row?.click();
	}, name);
	await waitFor(
		() => page.evaluate((n) => document.querySelector(".initiatives-view .iv-iname")?.textContent?.trim() === n, name),
		10_000,
	);
	await sleep(250);
}
const txt = (page, sel) =>
	page.evaluate((s) => (document.querySelector(s)?.textContent ?? "").replace(/\s+/g, " ").trim(), sel);
const has = (page, sel) => page.evaluate((s) => !!document.querySelector(s), sel);
const pokesIn = (file) =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.includes("from the Initiatives page · progress update")).length;
const stored = () => JSON.parse(readFileSync(join(decisionsDir, "initiatives.json"), "utf8"));
const storedTit = () => {
	const s = stored();
	return (Array.isArray(s) ? s : (s.initiatives ?? [])).find((i) => i.id === TIT);
};

// The contrast, target and overflow measure from the initiatives-page test, for the Progress section too.
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
	for (const el of root.querySelectorAll("a[href], button, summary, select")) {
		if (!vis(el)) continue;
		if (el.closest("p, li") && getComputedStyle(el).display === "inline") continue;
		const b = el.getBoundingClientRect();
		const w = Math.round(b.width);
		const h = Math.round(b.height);
		if (w < 24 || h < 24 || (narrow && h < 44)) small.push(`${label(el)} ${w}x${h}`);
	}
	return {
		textFails,
		small,
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
							.map((n) => n.target.join(" "))
							.join(", ")}`,
				),
		};
	});
}

try {
	const desk = await openPage({ width: 1440, height: 900 });
	const page = desk.page;
	await selectInitiative(page, "Team in Temper");

	// ---- 1. Team in Temper's Progress, the seeded lead, Pi tools off -------------------------------------
	await page.waitForSelector(".initiatives-view .iv-progress", { timeout: 20_000 });
	check(
		"Progress sits above Decisions",
		await page.evaluate(() => {
			const p = document.querySelector(".initiatives-view .iv-progress");
			const d = [...document.querySelectorAll(".initiatives-view h3")].find((h) =>
				/^Decisions/.test(h.textContent.trim()),
			);
			return !!p && !!d && !!(p.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING);
		}),
	);
	check("its heading is Progress", (await txt(page, ".iv-progress h3")) === "Progress");
	const leadLine = await txt(page, ".iv-leadbox .iv-lead");
	check(
		"the seeded lead: Architecture, Set by you, Oct 9",
		leadLine === "Lead: Architecture · Set by you, Oct 9",
		leadLine,
	);
	const seeded = storedTit();
	check(
		"stored as his pick: by owner, the dialog's record",
		seeded?.lead === "architecture" && seeded?.leadSet?.by === "owner" && seeded?.leadSet?.source === "dr-2941468511bb",
		JSON.stringify(seeded),
	);
	const unl = await txt(page, ".iv-progress .iv-unlinked");
	check("Not in any update yet: 2 decisions", unl.startsWith("Not in any update yet: 2 decisions"), unl);
	check("the Ask button shows", await has(page, ".iv-pstatus .iv-btn.iv-primary"));
	await selectInitiative(page, "Pi tools");
	check("Pi tools: Progress: off", (await txt(page, ".iv-progress.iv-off h3")) === "Progress: off");
	// He may pick a lead for any initiative; with Progress off nothing is asked for it.
	check("Pi tools: its lead picker, no lead", (await txt(page, ".iv-leadbox .iv-lead")) === "No lead");
	check("Pi tools: no Ask button", !(await has(page, ".iv-pstatus")));
	await selectInitiative(page, "Team in Temper");

	// ---- 2. the picker -----------------------------------------------------------------------------------
	await page.selectOption(".iv-leadform select", "");
	await page.click(".iv-leadform button[type=submit]");
	await waitFor(() => has(page, ".iv-nolead"), 10_000);
	check("No lead -> No lead yet", (await txt(page, ".iv-nolead h4")) === "No lead yet");
	check("No lead -> no Ask button", !(await has(page, ".iv-pstatus .iv-btn.iv-primary")));
	check(
		"cleared in the store, by the owner",
		storedTit()?.lead == null && storedTit()?.leadSet?.by === "owner",
		JSON.stringify(storedTit()),
	);
	await page.selectOption(".iv-leadform select", "architecture");
	await page.click(".iv-leadform button[type=submit]");
	await waitFor(() => has(page, ".iv-pstatus .iv-btn.iv-primary"), 10_000);
	const today = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" }).format(new Date());
	const leadAgain = await txt(page, ".iv-leadbox .iv-lead");
	check("Architecture again: Set by you, today", leadAgain === `Lead: Architecture · Set by you, ${today}`, leadAgain);
	const set = storedTit();
	check(
		"stored: lead architecture, by owner, source page",
		set?.lead === "architecture" && set?.leadSet?.by === "owner" && set?.leadSet?.source === "page",
		JSON.stringify(set),
	);
	check("no poke sent by setting a lead", pokesIn(files.A) === 0 && seen.pokes.length === 0);

	// ---- 3. Ask -------------------------------------------------------------------------------------------
	await page.click(".iv-pstatus .iv-btn.iv-primary");
	const asked = await waitFor(async () => {
		const s = await txt(page, ".iv-pstatus .iv-asked");
		return /^Asked Architecture at \d{1,2}:\d{2}/.test(s) ? s : null;
	}, 20_000);
	check("the page shows the open ask", !!asked, asked ?? (await txt(page, ".iv-pstatus")));
	await waitFor(() => seen.pokes.length > 0, 30_000);
	const poke = seen.pokes[0];
	check("the poke reached Architecture's home chat", !!poke && pokesIn(files.A) === 1, `${seen.pokes.length} seen`);
	check("it names the owner's request (rm-ba07e068)", !!poke?.ownerRequest);
	check("it says to post with initiative_update, only what the records hold", !!poke?.tool && !!poke?.holdsOnly);
	check("it lists the unlinked decisions", !!poke?.unlinked);
	check("it lists nothing from Pi tools", poke && !poke.otherInitiative);
	await shot(page, "asked-desktop");

	// ---- 4. the lead posts ----------------------------------------------------------------------------------
	release();
	await waitFor(() => has(page, ".iv-updates .iv-update"), 30_000);
	check(
		"the post was accepted",
		!!seen.postResult && !/the lead is|refused|isn't/i.test(seen.postResult),
		seen.postResult ?? "none",
	);
	const card = await page.evaluate(() => {
		const c = document.querySelector(".iv-updates .iv-update");
		const t = (e) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
		return c
			? {
					head: t(c.querySelector(".iv-uhead")),
					fields: [...c.querySelectorAll(".iv-ufields dt")].map((dt) => `${t(dt)}=${t(dt.nextElementSibling)}`),
					flagged: c.classList.contains("iv-flagged"),
					flagLabel: t(c.querySelector(".iv-uflags .iv-plabel")),
					flags: [...c.querySelectorAll(".iv-uflags .iv-flag")].map(t),
					sources: c.querySelectorAll(".iv-sources .iv-src").length,
				}
			: null;
	});
	check("the update shows its writer", !!card && card.head.includes("Architecture"), JSON.stringify(card?.head));
	check(
		"What changed, What's next, Needs you",
		!!card &&
			card.fields.some((f) => f.startsWith("What changed=") && f.includes("two tasks")) &&
			card.fields.some((f) => f.startsWith("What's next=") && f.includes("messages and inboxes")) &&
			card.fields.some((f) => f.startsWith("Needs you=")),
		JSON.stringify(card?.fields),
	);
	check(
		"impact, options and until say not given",
		!!card &&
			["Impact for you", "Other options", "Until"].every((k) =>
				card.fields.some((f) => f.startsWith(k) && /not given/i.test(f)),
			),
		JSON.stringify(card?.fields),
	);
	check(
		"the E60 claim is flagged, not in its sources, found by a script",
		!!card &&
			card.flagged &&
			card.flagLabel === "Not in its sources" &&
			card.flags.length === 1 &&
			card.flags[0].includes("tailnet-only") &&
			card.flags[0].includes("found by a script"),
		JSON.stringify(card),
	);
	check("the faithful credit is not flagged", !!card && !card.flags.some((f) => f.includes("two tasks")));
	check("its sources are one click away", !!card && card.sources >= 2, `${card?.sources}`);
	await page.click(".iv-updates .iv-update .iv-sources .iv-src");
	const opened = await waitFor(
		() =>
			page.evaluate(() =>
				document.querySelector("dialog.iv-dialog")?.open
					? (document.querySelector(".iv-record")?.textContent ?? "")
					: null,
			),
		10_000,
	);
	check("a source opens its record in a window", !!opened && opened.length > 0);
	await page.keyboard.press("Escape");
	await waitFor(() => page.evaluate(() => !document.querySelector("dialog.iv-dialog")?.open), 5_000);
	const all = await txt(page, ".iv-pstatus");
	check(
		"every decision is in an update; the ask closed",
		all.includes("Every decision and change is in an update.") && !all.includes("Asked"),
		all,
	);
	const row = await page.evaluate(() => {
		const r = [...document.querySelectorAll(".initiatives-view .iv-row")].find(
			(x) => x.querySelector(".iv-rname")?.textContent?.trim() === "Team in Temper",
		);
		return (r?.textContent ?? "").replace(/\s+/g, " ").trim();
	});
	check("the list row shows the lead and the last update", row.includes("Architecture") && /update/i.test(row), row);
	await shot(page, "posted-desktop");

	// ---- 5. nothing else was poked -------------------------------------------------------------------------
	await sleep(1500);
	check("one poke in all", seen.pokes.length === 1 && pokesIn(files.A) === 1, `${seen.pokes.length}`);
	check("Temper's home chat got nothing", pokesIn(files.B) === 0);
	await desk.context.close();

	// ---- 6. looks: desktop and phone, dark and White ---------------------------------------------------------
	for (const [w, h, phone] of [
		[1440, 900, false],
		[390, 844, true],
	]) {
		for (const theme of [null, "white"]) {
			const tag = `${phone ? "phone" : "desktop"} ${theme ?? "dark"}`;
			const v = await openPage({ width: w, height: h, phone, theme });
			await selectInitiative(v.page, "Team in Temper");
			await v.page.waitForSelector(".iv-updates .iv-update", { timeout: 20_000 });
			const m = await v.page.evaluate(MEASURE);
			check(`${tag}: text contrast WCAG AA`, m.textFails.length === 0, m.textFails.slice(0, 5).join("; "));
			check(`${tag}: targets ${phone ? "44" : "24"} px`, m.small.length === 0, m.small.slice(0, 5).join("; "));
			check(`${tag}: no sideways overflow`, m.overflowX <= 1, `${m.overflowX}px`);
			const axe = await runAxe(v.page);
			check(
				`${tag}: axe-core, no serious or critical finding`,
				!axe.error && axe.bad.length === 0,
				axe.error ?? axe.bad.join(" | "),
			);
			await shot(v.page, `${phone ? "phone" : "desktop"}-${theme ?? "dark"}`);
			await v.context.close();
		}
	}
} catch (err) {
	check("no unexpected error", false, err?.stack ?? String(err));
} finally {
	release?.();
	await browser.close().catch(() => {});
	await srv.stop();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall progress-feed checks passed");
process.exit(failures ? 1 : 0);
