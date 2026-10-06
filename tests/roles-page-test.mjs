/* roles-page E2E (no tokens): the Roles page (roles-overview patch) in a sealed server and headless Chrome.
 *
 * A sealed server (TZ America/Los_Angeles, its own HOME, data, agent, state and identities folders) with
 * a stand-in model that must never be called. Fourteen synthetic roles with saved (closed) chats:
 * TL;DR lines, two distinct asks in one home chat, a queue with a stuck task (its question copied into
 * the home chat), a task asking its main chat, tasks on hold and blocked, a stopped queue, a busy task,
 * 6 am reports of about 300, 1,200 and 4,000 characters (role-reports' runs.json and role-message store),
 * a failed and a "not active" report, an open request, and thinking, tool and prompt text that must never
 * reach the page. Then six more roles (20), and last two home chats the page must refuse (one behind a
 * symlink to a file outside, one behind ".."): the density bars are for the page as it normally is.
 * Checks, in the dark and the White theme, at 390x844 (phone) and 1440x900 (desktop), the roles as tiles:
 *  1. the top bar's Roles tab and its count; ?view=roles opens the page;
 *  2. two fixed groups, alphabetical; status words (Needs you > Busy > Paused > Idle > Nothing yet);
 *  3. "Waiting on you": every distinct owner ask oldest first, the copied task ask once, the task that
 *     asks its main chat not at all; the tiles' newest line and queue words (never cut); a tile opens
 *     the role's panel: TL;DR, queue counts, the two Architecture goals from the rules, the full report
 *     or why there is none;
 *  4. density: all 14 tiles fully on the desktop's first screen, >= 6 on the phone's; no sideways
 *     overflow at 320, 390, 768, 769 and 1440; full reports in the panel and in the reports view;
 *  5. WCAG AA text contrast, icons 3:1, targets (phone 44 px, desktop 24 px), axe-core with no serious
 *     or critical finding, a visible focus ring all the way through, no pulse under reduced motion;
 *  6. the panel closes with Escape, its close button and a click beside it, focus back on the tile;
 *  7. navigation opens the existing chat at the item (TL;DR line, task, report) and the same chat again
 *     the second time; "About & rules" opens Settings at that role;
 *  8. the owner's form saves only workMode (other keys and their order kept) through the hash-checked
 *     save, and refuses when the file changed meanwhile; nothing is written before Save;
 *  9. a new TL;DR line reaches the open page by itself; a server restart shows "Not live" and the page
 *     comes back; 20 roles fit the same way;
 * 10. refused home chats: the note names those roles, what could be read still shows;
 * 11. the page never got thinking, tool, prompt or out-of-folder text; the model was never called;
 *     no chat was opened or written by looking; the role-message store kept its records.
 * Never prints what goes to a model (rule 11). Screenshots only with ROLES_SHOT=<dir> (fixture shots).
 * Usage: npm run build && node tests/roles-page-test.mjs   (ROLES_DEBUG=1: server output)
 * axe-core: PI_AXE_JS, else ~/temper-ai/configs/design/bin/vendor/axe-4.13.0.min.js.
 */
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";

const AXE = process.env.PI_AXE_JS ?? join(userInfo().homedir, "temper-ai/configs/design/bin/vendor/axe-4.13.0.min.js");
const SHOTS = process.env.ROLES_SHOT || "";
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

// ---- times ---------------------------------------------------------------------------------------------
const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
function pacificDay(back) {
	const today = new Intl.DateTimeFormat("en-CA", {
		timeZone: TZ,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(NOW));
	const [y, m, d] = today.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d - back)).toISOString().slice(0, 10);
}
const D1 = pacificDay(1);
const RUN_AT = NOW - 2 * HOUR;

// ---- the saved chats -------------------------------------------------------------------------------------
const ROLES = [
	["architecture", "System architecture"],
	["backend", "Backend engineering"],
	["data", "Data & analytics"],
	["design", "Design"],
	["docs", "Docs"],
	["frontend", "Frontend engineering"],
	["marketing", "Product marketing"],
	["ops", "Ops/tooling"],
	["product", "Product management"],
	["qa", "QA"],
	["rollcall", "RollCall"],
	["security", "Security"],
	["systems", "System engineering"],
	["temper", "Temper"],
];
const SELF = ["design", "product", "qa"];
const EXTRA = ["zeta-one", "zeta-two", "zeta-three", "zeta-four", "zeta-five", "zeta-six"];
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
let seq = 0;
const eid = () => (++seq).toString(16).padStart(8, "0");
const iso = (ms) => new Date(ms).toISOString();
const user = (text, ts) => ({
	type: "message",
	id: eid(),
	timestamp: iso(ts),
	message: { role: "user", content: [{ type: "text", text }], timestamp: ts },
});
const assistant = (text, ts, before = [], stopReason = "stop") => ({
	type: "message",
	id: eid(),
	timestamp: iso(ts),
	message: {
		role: "assistant",
		content: [...before, { type: "text", text }],
		api: "openai-completions",
		provider: "mock",
		model: "mock-model",
		usage,
		stopReason,
		timestamp: ts,
	},
});
const toolResult = (text, ts) => ({
	type: "message",
	id: eid(),
	timestamp: iso(ts),
	message: {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: ts,
	},
});
const tldr = (text, ts, extra = {}) => ({
	type: "custom",
	customType: "tldr",
	data: { v: 1, text, needsYou: false, ts, ...extra },
	id: eid(),
	timestamp: iso(ts),
});
const needs = (text, ts, extra = {}) => tldr(text, ts, { needsYou: true, ...extra });
const q = (op, ts = NOW - 2 * DAY) => ({
	type: "custom",
	customType: "queue",
	data: { v: 1, ts, ...op },
	id: eid(),
	timestamp: iso(ts),
});
const plan = (title) => ({ title, goal: "g", doneWhen: "d", decided: "x", steps: "s", verify: "v", mustNot: "m" });
const opening = (who) => [user(`${who} home starts`, NOW - 3 * DAY), assistant("ok", NOW - 3 * DAY + 1000)];

/** A transcript: the header, then the lines chained by parentId (the app reads its branch). */
function writeChat(path, sessionId, cwd, lines) {
	let parent = null;
	const chained = lines.map((l) => {
		const out = { ...l, parentId: parent };
		parent = l.id;
		return out;
	});
	const headLine = { type: "session", version: 3, id: sessionId, timestamp: iso(NOW - 3 * DAY), cwd };
	writeFileSync(path, `${[headLine, ...chained].map((l) => JSON.stringify(l)).join("\n")}\n`);
	// Like a real transcript, the file was last written with its newest line (the page's "last activity").
	const newest = Math.max(...[headLine, ...lines].map((l) => Date.parse(l.timestamp) || 0));
	utimesSync(path, newest / 1000, newest / 1000);
}
/** Bytes of a transcript up to (not including) line `k` of `lines` (for the report's scanFrom). */
function bytesBefore(sessionId, cwd, lines, k) {
	let parent = null;
	let n = Buffer.byteLength(
		`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: iso(NOW - 3 * DAY), cwd })}\n`,
	);
	for (let i = 0; i < k; i++) {
		n += Buffer.byteLength(`${JSON.stringify({ ...lines[i], parentId: parent })}\n`);
		parent = lines[i].id;
	}
	return n;
}

function reportText(role, chars) {
	const filler = (seed, n) => {
		const words = `${seed} measured the change against the plan and wrote down what moved and why `;
		let s = "";
		while (s.length < n) s += words;
		return s.slice(0, n).trim();
	};
	const each = Math.max(40, Math.floor((chars - 80) / 4));
	return [
		"## Goal or hypothesis",
		`${role} goal: ${filler("The team", each - 12)}`,
		"## Done yesterday",
		filler("We", each),
		"## Learned",
		filler("It", each),
		"## Next",
		`${filler("Next we", each - 20)} END-OF-${role.toUpperCase()}-REPORT`,
	].join("\n");
}

const files = {};
const reportsAt = {};
let idDir = "";
let rmFile = "";
let stateDir = "";
let sessionsDir = "";
let outsideFile = "";
function seed({ root, dataDir, workdir, agentDir }) {
	sessionsDir = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(sessionsDir, { recursive: true });
	let n = 0;
	const newChat = () => {
		n += 1;
		const id = `01a0f000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
		return { id, path: join(sessionsDir, `2026-10-01T10-00-00-000Z_${id}.jsonl`) };
	};
	const chat = (key, lines) => {
		const c = newChat();
		writeChat(c.path, c.id, workdir, lines);
		files[key] = c.path;
		return c;
	};
	const withReport = (key, role, chars, rmId, before) => {
		const c = newChat();
		const lines = [
			...before,
			user(
				`[Role message ${rmId} from the app · 6 am report · ${D1}]\nPlease write your 6 am report for ${D1}.`,
				RUN_AT + 1000,
			),
			assistant(reportText(role, chars), RUN_AT + 2 * MIN),
		];
		const scanFrom = bytesBefore(c.id, workdir, lines, before.length);
		writeChat(c.path, c.id, workdir, lines);
		files[key] = c.path;
		reportsAt[role] = { scanFrom, chars: reportText(role, chars).length };
	};

	// Task chats first (the home chats' queues name them).
	chat("ops3", [...opening("ops task 3"), needs("Which backup bucket should I use?", NOW - 2 * HOUR)]);
	chat("ops4", [...opening("ops task 4"), needs("Which job name do you want?", NOW - HOUR)]);
	chat("temper20", [...opening("temper task 20"), tldr("Wrote the run viewer page", NOW - 5 * MIN)]);

	chat("architecture", [
		...opening("architecture"),
		assistant(
			"Let me look.",
			NOW - 2 * DAY,
			[
				{ type: "thinking", thinking: "CANARY-THINK private reasoning" },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo CANARY-TOOL" } },
			],
			"toolUse",
		),
		toolResult("CANARY-RESULT tool output", NOW - 2 * DAY + 1000),
		assistant("Done.", NOW - 2 * DAY + 2000),
		{
			type: "custom",
			customType: "identity",
			data: { v: 1, id: "architecture", note: "CANARY-PROMPT" },
			id: eid(),
			timestamp: iso(NOW - 2 * DAY),
		},
		{
			type: "custom_message",
			customType: "role-message",
			content: [{ type: "text", text: "CANARY-NOTE" }],
			display: true,
			id: eid(),
			timestamp: iso(NOW - 2 * DAY),
		},
		tldr("Read the design notes", NOW - 5 * HOUR),
		// real lines run 80-130 characters; the tiles must fit with them, not only with short ones
		tldr(
			"Checked the plan for the Roles page: the land-check trial is moving, 9 of 12 runs done and the verdicts right so far",
			NOW - 40 * MIN,
		),
	]);
	chat("backend", [
		...opening("backend"),
		q({ op: "run" }),
		q({ op: "add", id: 7, plan: plan("Speed up the build") }),
		q({ op: "start", id: 7, lane: true }),
		q({ op: "wait", id: 7, what: "CI", check: "true", everyMs: 120_000, until: NOW + DAY }, NOW - 3 * HOUR),
		q({ op: "add", id: 8, plan: plan("Retry the cache") }),
		q({ op: "start", id: 8, lane: true }),
		q({ op: "block", id: 8, need: "a design review" }, NOW - 4 * HOUR),
		q({ op: "add", id: 9, plan: plan("Clean old branches") }),
		tldr(
			"Waiting for CI on the build change; the cache retry is blocked on a design review, and the old branches wait their turn",
			NOW - 3 * HOUR,
		),
	]);
	chat("data", [...opening("data"), tldr("Looked at last week's numbers", NOW - 2 * DAY)]);
	withReport("design", "design", 1200, "rm-0000d001", [
		...opening("design"),
		tldr(
			"Drafted the onboarding screens, then caught up on tonight's backlog by adding Design's key to a few more lab tools",
			NOW - HOUR,
		),
	]);
	chat("frontend", [
		...opening("frontend"),
		q({ op: "run" }),
		q({ op: "add", id: 1, plan: plan("Planted-bug check") }),
		q({ op: "start", id: 1, lane: true }),
		// a real block reason can be a paragraph; a tile shows only "Blocked", the panel all of it
		q(
			{
				op: "block",
				id: 1,
				need: "the owner's or a role's request to resume; on 2026-10-04 the owner chose to keep it paused under rule 14, and if resumed it starts at planted case P2 with the base and P1 test copies still up",
			},
			NOW - 20 * HOUR,
		),
		tldr("Fixed the settings layout", NOW - 5 * HOUR),
	]);
	chat("marketing", [
		...opening("marketing"),
		tldr("Wrote two launch headlines", NOW - 10 * HOUR),
		needs("Which headline should the launch post use?", NOW - 9 * HOUR),
		needs("Approve the pricing page copy?", NOW - 25 * MIN),
	]);
	chat("ops", [
		...opening("ops"),
		q({ op: "run" }),
		q({ op: "add", id: 3, plan: plan("Rotate the backup keys") }),
		q({ op: "start", id: 3, lane: true }),
		q({ op: "chat", id: 3, file: files.ops3, title: "Rotate the backup keys" }),
		q({ op: "stuck", id: 3, question: "Which backup bucket should I use?" }, NOW - 2 * HOUR),
		q({ op: "add", id: 4, plan: plan("Tidy the scheduler") }),
		q({ op: "start", id: 4, lane: true }),
		q({ op: "chat", id: 4, file: files.ops4, title: "Tidy the scheduler" }),
		q({ op: "ask", id: 4, n: 1, question: "Which job name do you want?", ts: NOW - HOUR }, NOW - HOUR),
		q({ op: "add", id: 5, plan: plan("Update the docs") }),
		needs("Which backup bucket should I use?", NOW - 2 * HOUR, {
			chat: { file: files.ops3, title: "Rotate the backup keys" },
		}),
		needs("Which job name do you want?", NOW - HOUR, { chat: { file: files.ops4, title: "Tidy the scheduler" } }),
	]);
	withReport("product", "product", 4000, "rm-0000d002", [
		...opening("product"),
		q({ op: "run" }),
		q({ op: "add", id: 30, plan: plan("Repeatable early-screen scores") }),
		q({ op: "start", id: 30, lane: true }),
		q(
			{
				op: "wait",
				id: 30,
				what: "screen repeat run B finishing (about 50 min), then the scoreboard check",
				check: "true",
				everyMs: 120_000,
				until: NOW + DAY,
			},
			NOW - HOUR,
		),
		q({ op: "add", id: 31, plan: plan("Critic checks from research") }),
		q({ op: "add", id: 32, plan: plan("Scoreboard for the early screen") }),
		tldr(
			"Sizing the next experiment: run one of three finished and passed every check, starting run two next",
			NOW - 20 * MIN,
		),
	]);
	withReport("qa", "qa", 300, "rm-0000d003", [...opening("qa"), tldr("Ran the checkout checks", NOW - 6 * HOUR)]);
	chat("rollcall", [
		...opening("rollcall"),
		q({ op: "run" }),
		q({ op: "add", id: 11, plan: plan("Re-run the paper week") }),
		q({ op: "add", id: 12, plan: plan("Check the fills") }),
		q({ op: "pause", reason: "user" }, NOW - DAY),
		tldr("Paused the queue for the weekend", NOW - DAY),
	]);
	const temperLines = [...opening("temper"), q({ op: "run" })];
	for (let i = 1; i <= 15; i++) {
		temperLines.push(
			q({ op: "add", id: i, plan: plan(`Old task ${i}`) }),
			q({ op: "start", id: i, lane: true }),
			q({ op: "done", id: i, summary: "ok" }),
		);
	}
	chat("temper", [
		...temperLines,
		q({ op: "add", id: 20, plan: plan("Ship the run viewer") }),
		q({ op: "start", id: 20, lane: true }),
		q({ op: "chat", id: 20, file: files.temper20, title: "Ship the run viewer" }),
		q({ op: "add", id: 21, plan: plan("Add run filters") }),
		q({ op: "add", id: 22, plan: plan("Write the viewer docs") }),
		tldr("Building the run viewer", NOW - 10 * MIN),
	]);
	// security: its home chat path goes through ".." (refused); systems: a symlink to a file outside.
	chat("securityReal", [...opening("security"), tldr("CANARY-TRAVERSAL line", NOW - MIN)]);
	// (written as a string: join() would tidy the ".." away before identity.json gets it)
	files.security = `${sessionsDir}/sub/../${files.securityReal.slice(sessionsDir.length + 1)}`;
	mkdirSync(join(root, "outside"), { recursive: true });
	outsideFile = join(root, "outside", "secret.jsonl");
	writeChat(outsideFile, "01a0f000-0000-7000-8000-0000000000ff", workdir, [
		...opening("outside"),
		tldr("CANARY-SECRET leaked", NOW - MIN),
	]);
	files.systems = join(sessionsDir, "2026-10-01T10-00-00-000Z_01a0f000-0000-7000-8000-0000000000fe.jsonl");
	symlinkSync(outsideFile, files.systems);

	// The roles.
	idDir = join(root, "identities");
	for (const [id, title] of ROLES) {
		// (security and systems get their refused home chats later, in section 7: the bars above are for the
		// page as it normally is, without the "could not be read fully" note)
		const json = { id, title, ...(["docs", "security", "systems"].includes(id) ? {} : { homeChat: files[id] }) };
		mkdirSync(join(idDir, id), { recursive: true });
		writeFileSync(join(idDir, id, "identity.json"), `${JSON.stringify(json, null, "\t")}\n`);
		writeFileSync(
			join(idDir, id, "about.md"),
			`# ${title}\n\n**Focus:** ${title.toLowerCase()} for the test company.\n`,
		);
		writeFileSync(join(idDir, id, "notebook.md"), "CANARY-NOTEBOOK rules\n");
	}

	// role-reports: yesterday's run, and the scheduler's job.
	stateDir = join(root, "state");
	mkdirSync(join(stateDir, "role-reports"), { recursive: true });
	writeFileSync(
		join(stateDir, "role-reports", "runs.json"),
		JSON.stringify({
			runs: [
				{
					date: D1,
					at: RUN_AT,
					active: { design: {}, product: {}, qa: {}, frontend: {} },
					inactive: ["data"],
					skipped: {},
					sent: {
						design: { id: "rm-0000d001" },
						product: { id: "rm-0000d002" },
						qa: { id: "rm-0000d003" },
						frontend: { error: "the chat couldn't be opened" },
					},
				},
			],
		}),
	);
	mkdirSync(join(root, ".pi-scheduler"), { recursive: true });
	writeFileSync(
		join(root, ".pi-scheduler", "jobs.json"),
		JSON.stringify({
			jobs: [
				{
					id: "j1",
					name: "6 am reports",
					type: "command",
					target: "role-reports run",
					enabled: true,
					nextRunAt: NOW + 20 * HOUR,
				},
			],
		}),
	);

	// The role-message store: three answered report requests, one open request, one answered request.
	const app = { role: "app", title: "the app", chat: "", file: "" };
	const report = (id, role, title) => ({
		id,
		at: RUN_AT,
		from: app,
		to: { role, title },
		kind: "report",
		chain: 1,
		text: `Please write your 6 am report for ${D1}.`,
		state: "replied",
		target: files[role],
		targetChat: "home chat",
		scanFrom: reportsAt[role].scanFrom,
		sends: 1,
		attempts: 0,
		deliveredAt: RUN_AT + 1000,
		report: {
			date: D1,
			reply: { at: RUN_AT + 3 * MIN, answered: true, headings: true, missing: [], chars: reportsAt[role].chars },
		},
	});
	rmFile = join(dataDir, "role-messages.json");
	writeFileSync(
		rmFile,
		JSON.stringify({
			v: 1,
			paused: false,
			messages: [
				report("rm-0000d001", "design", "Design"),
				report("rm-0000d002", "product", "Product management"),
				report("rm-0000d003", "qa", "QA"),
				{
					id: "rm-0000e001",
					at: NOW - 30 * MIN,
					from: { role: "product", title: "Product management", chat: "home chat", file: files.product },
					to: { role: "security", title: "Security" },
					kind: "request",
					chain: 1,
					text: "Please check the new login flow for leaks.\nDetails follow.",
					state: "delivered",
					target: files.securityReal,
					targetChat: "home chat",
					sends: 1,
					attempts: 0,
					deliveredAt: NOW - 29 * MIN,
				},
				{
					id: "rm-0000e002",
					at: NOW - 3 * DAY,
					from: { role: "ops", title: "Ops/tooling", chat: "home chat", file: files.ops },
					to: { role: "marketing", title: "Product marketing" },
					kind: "request",
					chain: 1,
					text: "An old request, already answered.",
					state: "replied",
					target: files.marketing,
					targetChat: "home chat",
					sends: 1,
					attempts: 0,
					deliveredAt: NOW - 3 * DAY,
					replyId: "rm-0000e003",
				},
			],
		}),
	);
}

let modelCalls = 0;
const srv = await ownServer({
	name: "roles-page",
	verbose: !!process.env.ROLES_DEBUG,
	mock: () => {
		modelCalls += 1;
		return "ok";
	},
	prepare: seed,
	env: {
		TZ,
		get HOME() {
			return join(idDir, "..");
		},
		get XDG_STATE_HOME() {
			return stateDir;
		},
		get PI_IDENTITY_DIR() {
			return idDir;
		},
		get PI_MEMORY_DIR() {
			return join(idDir, "..", "memory");
		},
		PI_IDENTITY_REINDEX: "0",
	},
});

const watched = Object.fromEntries(
	[
		// (not marketing, ops and qa: navigation opens them; not architecture: the live check writes to it)
		"product",
		"data",
		"frontend",
		"rollcall",
		"temper",
		"backend",
		"ops3",
		"ops4",
		"temper20",
	].map((k) => [k, sha(files[k])]),
);
const identityHashes = Object.fromEntries(ROLES.map(([id]) => [id, sha(join(idDir, id, "identity.json"))]));

// ---- the browser -----------------------------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const frames = { roles: [], all: 0 };
let lastSnapshot = null;
function listen(page) {
	page.on("websocket", (ws) => {
		ws.on("framereceived", ({ payload }) => {
			if (typeof payload !== "string" || payload[0] !== "{") return;
			frames.all += 1;
			if (payload.startsWith('{"type":"roles"'))
				frames.roles.push({ at: Date.now(), size: payload.length, text: payload });
			else if (payload.startsWith('{"type":"snapshot"')) {
				try {
					const m = JSON.parse(payload);
					lastSnapshot = { at: Date.now(), sessionFile: m.state?.sessionFile, conversationId: m.state?.conversationId };
				} catch {
					/* not it */
				}
			}
		});
	});
}
async function openPage({
	width,
	height,
	phone = false,
	theme = null,
	reducedMotion = "no-preference",
	storage = null,
}) {
	const context = await browser.newContext({
		viewport: { width, height },
		deviceScaleFactor: 1,
		isMobile: phone,
		hasTouch: phone,
		reducedMotion,
		locale: "en-US",
		...(storage ? { storageState: storage } : {}),
	});
	await context.addInitScript((t) => {
		localStorage.setItem("pi-web-ui:lang", "en");
		if (t) localStorage.setItem("pi-web-ui:theme", t);
		else localStorage.removeItem("pi-web-ui:theme");
	}, theme);
	const page = await context.newPage();
	listen(page);
	await page.goto(`${srv.http}/?view=roles`);
	await page.waitForSelector(".roles-view [data-role-id]", { timeout: 30_000 });
	await waitFor(
		() => page.evaluate(() => document.querySelectorAll(".roles-view [data-role-id]").length >= 14),
		15_000,
	);
	await page.evaluate(() => document.fonts?.ready);
	await sleep(300);
	return { context, page };
}
async function shot(page, name) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Everything measured on the Roles page as it is on screen. */
const MEASURE = () => {
	const root = document.querySelector(".roles-view");
	// "The first screen": the page scrolled to its top (rows scrolled away above must not count).
	if (root) root.scrollTop = 0;
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
		if (!vis(el)) continue;
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
	const iconFails = [];
	for (const svg of root.querySelectorAll("svg.rv-ic")) {
		if (!vis(svg) || svg.closest("[aria-hidden='true'] [aria-hidden='true']")) continue;
		const fg = parse(getComputedStyle(svg).color);
		const bg = bgOf(svg.parentElement);
		const r = ratio(over(fg, bg), bg);
		if (r < 3) iconFails.push(`${label(svg.parentElement)} ${r.toFixed(2)}`);
	}
	const narrow = innerWidth <= 768;
	const small = [];
	for (const el of root.querySelectorAll("a[href], button")) {
		if (!vis(el)) continue;
		const b = el.getBoundingClientRect();
		const w = Math.round(b.width);
		const h = Math.round(b.height);
		if (w < 24 || h < 24 || (narrow && (w < 44 || h < 44))) small.push(`${label(el)} ${w}x${h}`);
	}
	const statusNoWord = [];
	for (const el of root.querySelectorAll(".rv-st")) {
		if (!vis(el)) continue;
		if (!el.querySelector("svg") || !el.textContent.trim()) statusNoWord.push(label(el));
	}
	const clipped = [];
	for (const el of root.querySelectorAll(".rv-tq, .rv-tname, .rv-st, .rv-wbtn b")) {
		if (!vis(el)) continue;
		if (el.scrollWidth > el.clientWidth + 1) clipped.push(label(el));
	}
	const rows = [...root.querySelectorAll(".rv-tile")].filter(vis);
	const heightOf = (sel) => Math.round(root.querySelector(sel)?.getBoundingClientRect().height ?? 0);
	// Where the room goes (shown when a density check fails): first tile's top, tile heights, strip, header.
	const layout = `first tile at ${Math.round(rows[0]?.getBoundingClientRect().top ?? 0)}px; tiles ${rows
		.slice(0, 9)
		.map((e) => Math.round(e.getBoundingClientRect().height))
		.join(
			"/",
		)}; strip ${heightOf(".rv-strip")}; header ${heightOf(".rv-phead")}; group heading ${heightOf(".rv-grp")}; scroll box ends at ${Math.round(root.getBoundingClientRect().bottom)}px`;
	return {
		layout,
		textFails,
		iconFails,
		small,
		statusNoWord,
		clipped,
		rows: rows.length,
		// Fully on the first screen, measured as the approved boards were (CHECKS.md: the window's height).
		fullRows: rows.filter((e) => e.getBoundingClientRect().bottom <= innerHeight + 0.5).length,
		// The app's own status bar (shared by every view, not in the boards) covers the window's bottom:
		// rows fully above it, for the receipt.
		fullRowsAboveBar: rows.filter((e) => e.getBoundingClientRect().bottom <= root.getBoundingClientRect().bottom + 0.5)
			.length,
		screens: +(root.scrollHeight / innerHeight).toFixed(2),
		overflowX: Math.max(root.scrollWidth - root.clientWidth, document.documentElement.scrollWidth - innerWidth),
	};
};

async function runAxe(page) {
	if (!existsSync(AXE)) return { error: `axe-core not found at ${AXE} (set PI_AXE_JS)` };
	await page.addScriptTag({ path: AXE });
	return page.evaluate(async () => {
		const r = await window.axe.run(document.querySelector(".roles-view"), {
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
								// color-contrast: the colours axe measured, to tell a real failure from a layering one
								const d = n.any?.[0]?.data;
								const c = d?.fgColor ? ` (${d.fgColor} on ${d.bgColor}, ${d.contrastRatio}:1)` : "";
								return `${n.target.join(" ")}${c}`;
							})
							.join(", ")}`,
				),
			other: r.violations.filter((v) => v.impact !== "serious" && v.impact !== "critical").map((v) => v.id),
		};
	});
}

async function focusWalk(page, steps = 24) {
	await page.evaluate(() => document.querySelector("#rv-title")?.focus());
	const without = [];
	let inside = 0;
	for (let i = 0; i < steps; i++) {
		await page.keyboard.press("Tab");
		const f = await page.evaluate(() => {
			const a = document.activeElement;
			if (!a || !a.closest(".roles-view")) return null;
			const cs = getComputedStyle(a);
			return {
				el: `${a.className} "${(a.textContent || "").trim().slice(0, 30)}"`,
				ring: cs.boxShadow !== "none" || (cs.outlineStyle !== "none" && Number.parseFloat(cs.outlineWidth) > 0),
			};
		});
		if (!f) continue;
		inside += 1;
		if (!f.ring) without.push(f.el);
	}
	return { inside, without };
}

const rowText = (page, id) =>
	page.evaluate((r) => document.querySelector(`.roles-view [data-role-id="${r}"]`)?.textContent ?? "", id);

/** Opens a role's panel from its tile; returns the panel's text. */
async function openPanel(page, id) {
	await page.click(`.roles-view [data-role-id="${id}"] .rv-tbtn`);
	await waitFor(() =>
		page.evaluate(
			(r) => document.querySelector(".roles-view dialog.rv-drawer[open] #rv-d-title")?.textContent === r,
			id,
		),
	);
	// its opening slide has ended (only the panel's own animation: a busy role's pulse never ends)
	await waitFor(() =>
		page.evaluate(() =>
			(document.querySelector(".roles-view dialog.rv-drawer")?.getAnimations() ?? []).every(
				(a) => a.playState === "finished",
			),
		),
	);
	return page.evaluate(() => document.querySelector(".roles-view dialog.rv-drawer")?.textContent ?? "");
}

async function closePanel(page) {
	await page.keyboard.press("Escape");
	await waitFor(() => page.evaluate(() => !document.querySelector(".roles-view dialog.rv-drawer")));
}
const statusOfRow = (page, id) =>
	page.evaluate(
		(r) => document.querySelector(`.roles-view [data-role-id="${r}"] .rv-st`)?.textContent?.trim() ?? "",
		id,
	);

/** The shared visual and accessibility checks for one page and width. */
async function visualChecks(page, tag, { phone }) {
	const m = await page.evaluate(MEASURE);
	check(`${tag}: text contrast AA everywhere`, m.textFails.length === 0, m.textFails.slice(0, 4).join("; "));
	check(`${tag}: status and control icons at least 3:1`, m.iconFails.length === 0, m.iconFails.slice(0, 4).join("; "));
	check(`${tag}: every target at least ${phone ? 44 : 24} px`, m.small.length === 0, m.small.slice(0, 4).join("; "));
	check(`${tag}: every status has an icon and a word`, m.statusNoWord.length === 0, m.statusNoWord.join("; "));
	check(`${tag}: counts are never cut`, m.clipped.length === 0, m.clipped.join("; "));
	check(`${tag}: nothing scrolls sideways`, m.overflowX <= 1, `${m.overflowX}px`);
	const axe = await runAxe(page);
	check(
		`${tag}: axe finds nothing serious or critical`,
		!axe.error && axe.bad.length === 0,
		axe.error ?? axe.bad.join("; "),
	);
	return m;
}

// =========================================================================================================
// 1. Desktop, dark
// =========================================================================================================
const desk = await openPage({ width: 1440, height: 900 });
{
	const { page } = desk;
	const tab = await page.evaluate(() => {
		const b = document.querySelector(".tb-tab.roles-tab");
		return b
			? {
					label: b.getAttribute("aria-label"),
					badge: b.querySelector(".roles-badge")?.textContent,
					on: b.getAttribute("aria-selected"),
				}
			: null;
	});
	check(
		"desktop: the top bar has Roles with the number waiting on you",
		tab?.badge === "3" && tab?.on === "true",
		JSON.stringify(tab),
	);
	check("desktop: the tab says it in words", tab?.label === "Roles, 3 waiting on you", tab?.label ?? "");

	const head = await page.evaluate(() => document.querySelector(".roles-view .rv-sum")?.textContent ?? "");
	check("desktop: summary counts roles, busy and paused", head === "14 roles · 1 busy · 1 paused", head);
	const groups = await page.evaluate(() =>
		[...document.querySelectorAll(".roles-view .rv-grp")].map((h) => h.textContent),
	);
	check(
		"desktop: two fixed groups",
		JSON.stringify(groups) === JSON.stringify(["Start their own work · 3", "Work on request · 11"]),
		JSON.stringify(groups),
	);
	const order = await page.evaluate(() =>
		[...document.querySelectorAll(".roles-view .rv-tile")].map((r) => r.dataset.roleId),
	);
	const want = [...SELF, ...ROLES.map(([id]) => id).filter((id) => !SELF.includes(id))];
	check("desktop: alphabetical inside each group", JSON.stringify(order) === JSON.stringify(want), order.join(","));

	const statuses = {};
	for (const [id] of ROLES) statuses[id] = await statusOfRow(page, id);
	const wantStatus = {
		marketing: "Needs you",
		ops: "Needs you",
		temper: "Busy",
		rollcall: "Paused",
		docs: "Nothing yet",
		security: "Nothing yet",
		systems: "Nothing yet",
		architecture: "Idle",
		backend: "Idle",
		data: "Idle",
		design: "Idle",
		frontend: "Idle",
		product: "Idle",
		qa: "Idle",
	};
	const wrongStatus = Object.entries(wantStatus).filter(([id, s]) => statuses[id] !== s);
	check(
		"desktop: each role's status word (needs you > busy > paused > idle > nothing yet)",
		wrongStatus.length === 0,
		JSON.stringify(wrongStatus.map(([id]) => [id, statuses[id]])),
	);

	const strip = await page.evaluate(() => ({
		head: document.querySelector(".roles-view .rv-wbtn b")?.textContent,
		open: document.querySelector(".roles-view .rv-wbtn")?.getAttribute("aria-expanded"),
		items: [...document.querySelectorAll(".roles-view .rv-witem")].map((a) => ({
			who: a.querySelector(".rv-w1")?.textContent?.trim(),
			ask: a.querySelector(".rv-wask")?.textContent?.trim(),
			href: a.getAttribute("href"),
		})),
	}));
	check(
		"desktop: the strip is open and counts three asks",
		strip.head === "Waiting on you (3)" && strip.open === "true",
		JSON.stringify(strip.head),
	);
	const asks = strip.items.map((i) => i.ask);
	check(
		"desktop: every distinct ask, oldest first; the copied task ask once; a task asking its main chat not at all",
		JSON.stringify(asks) ===
			JSON.stringify([
				"Which headline should the launch post use?",
				"Which backup bucket should I use?",
				"Approve the pricing page copy?",
			]),
		JSON.stringify(asks),
	);
	check(
		"desktop: asks say where and how long (home chat 9h, task #3 2h, home chat 25m)",
		/^marketing.*Home chat · 9h/.test(strip.items[0]?.who ?? "") &&
			/^ops.*Task #3 · 2h/.test(strip.items[1]?.who ?? "") &&
			/^marketing.*Home chat · 25m/.test(strip.items[2]?.who ?? ""),
		strip.items.map((i) => i.who).join(" | "),
	);
	check(
		"desktop: an ask links to its chat and item",
		/[?&]chat=/.test(strip.items[1]?.href ?? "") && /focus=task%3A3/.test(strip.items[1]?.href ?? ""),
		strip.items[1]?.href ?? "",
	);

	// A tile names its first task in the order needs you, working, asking, on hold, and counts the rest;
	// its panel lists every active task with its word.
	const ops = await rowText(page, "ops");
	check(
		"desktop: a tile's queue words name the task that needs you first and count the other",
		ops.includes("#3 Needs you") && ops.includes("+1 active") && !ops.includes("Asking its main chat"),
		ops.slice(0, 300),
	);
	const opsPanel = await openPanel(page, "ops");
	check(
		"desktop: the panel lists every active task, the one asking its main chat as such",
		opsPanel.includes("Rotate the backup keys") &&
			opsPanel.includes("Asking its main chat") &&
			opsPanel.includes("Tidy the scheduler"),
		opsPanel.slice(0, 400),
	);
	await closePanel(page);
	// A tile names a hold in a word; what it waits on (a paragraph, on real data) is in the panel.
	const tileQueues = await page.evaluate(() =>
		Object.fromEntries(
			["backend", "frontend", "product"].map((id) => [
				id,
				document.querySelector(`.roles-view [data-role-id="${id}"] .rv-tq`)?.textContent?.trim() ?? "",
			]),
		),
	);
	check(
		"desktop: a tile names a hold in a word, without what it waits on",
		/^#[78] (On hold|Blocked) · \+1 active · 1 queued$/.test(tileQueues.backend) &&
			tileQueues.frontend === "#1 Blocked" &&
			tileQueues.product === "#30 On hold · 2 queued",
		JSON.stringify(tileQueues),
	);
	const backendPanel = await openPanel(page, "backend");
	await closePanel(page);
	const frontendPanel = await openPanel(page, "frontend");
	await closePanel(page);
	check(
		"desktop: the panel says what each hold waits on, in full",
		backendPanel.includes("On hold: waits on CI") &&
			backendPanel.includes("Blocked: a design review") &&
			frontendPanel.includes("Blocked: the owner's or a role's request to resume") &&
			frontendPanel.includes("base and P1 test copies still up"),
		`${backendPanel.slice(0, 300)} | ${frontendPanel.slice(0, 300)}`,
	);
	const temper = await rowText(page, "temper");
	check("desktop: a tile counts the queued tasks", temper.includes("2 queued"), temper.slice(0, 300));
	const temperPanel = await openPanel(page, "temper");
	await closePanel(page);
	check(
		"desktop: the panel counts the queue in full",
		temperPanel.includes("2 queued · 15 done"),
		temperPanel.slice(0, 300),
	);
	check(
		"desktop: the newest line comes from the task chat; the panel tags it with the task",
		temper.includes("Wrote the run viewer page") && temperPanel.includes("· #20 Wrote the run viewer page"),
		`${temper.slice(0, 200)} | ${temperPanel.slice(0, 300)}`,
	);
	const arch = await openPanel(page, "architecture");
	await closePanel(page);
	check(
		"desktop: Architecture's two goals from the rules, by name, in its panel",
		arch.includes("Team in Temper") && arch.includes("Land check workflow (#23)"),
		arch.slice(0, 300),
	);
	const security = await rowText(page, "security");
	check(
		"desktop: an open request shows as the role's work",
		security.includes("Please check the new login flow"),
		security.slice(0, 200),
	);
	const design = await openPanel(page, "design");
	await closePanel(page);
	check(
		"desktop: the panel's 6 am report by day and goal",
		design.includes("6 am report · ") && design.includes("design goal:"),
		design.slice(0, 300),
	);
	const data = await openPanel(page, "data");
	await closePanel(page);
	const frontend = await openPanel(page, "frontend");
	await closePanel(page);
	const docs = await openPanel(page, "docs");
	await closePanel(page);
	check(
		"desktop: why there is no report (not active, failed, not asked)",
		data.includes("not active yesterday") &&
			frontend.includes("Couldn't ask for the report") &&
			docs.includes("Not asked for 6 am reports"),
		[data, frontend, docs].map((s) => s.slice(0, 120)).join(" | "),
	);
	const m = await visualChecks(page, "desktop dark", { phone: false });
	check(
		"desktop dark: all 14 tiles fully on the first 1440x900 screen, above the app's status bar",
		m.rows === 14 && m.fullRowsAboveBar === 14,
		`${m.fullRowsAboveBar} of ${m.rows} above the bar, ${m.fullRows} on the window (${m.layout})`,
	);
	console.log(
		`  (desktop dark: ${m.fullRows} tiles on the window, ${m.fullRowsAboveBar} above the app's status bar; ${m.screens} screens; ${m.layout})`,
	);
	await shot(page, "desktop-dark");

	const walk = await focusWalk(page);
	check(
		"desktop: a visible focus ring all the way through",
		walk.inside >= 10 && walk.without.length === 0,
		`${walk.inside} / ${walk.without.join("; ")}`,
	);

	// A tile opens its role's panel: the whole 4,000-character report, nothing cut.
	await openPanel(page, "product");
	const full = await page.evaluate(() => {
		const d = document.querySelector(".roles-view dialog.rv-drawer[open]");
		const dds = [...(d?.querySelectorAll("dd") ?? [])];
		return {
			title: d?.querySelector("#rv-d-title")?.textContent,
			modal: d?.matches(":modal") ?? false,
			focus: document.activeElement?.classList.contains("rv-dclose") ?? false,
			headings: [...(d?.querySelectorAll("dt") ?? [])].map((x) => x.textContent),
			chars: dds.reduce((n, x) => n + x.textContent.length, 0),
			end: d?.textContent?.includes("END-OF-PRODUCT-REPORT"),
			cut: dds.filter((x) => x.scrollHeight > x.clientHeight + 1).length,
		};
	});
	check(
		"desktop: a tile opens its role's panel, focus on its close button",
		full.title === "product" && full.modal && full.focus,
		JSON.stringify({ title: full.title, modal: full.modal, focus: full.focus }),
	);
	check(
		"desktop: the full report under its four headings, nothing cut",
		JSON.stringify(full.headings) === JSON.stringify(["Goal or hypothesis", "Done yesterday", "Learned", "Next"]) &&
			full.end &&
			full.cut === 0 &&
			full.chars > 3500,
		JSON.stringify({ headings: full.headings, chars: full.chars, end: full.end, cut: full.cut }),
	);
	await shot(page, "desktop-dark-open");
	await visualChecks(page, "desktop dark, panel open", { phone: false });

	// The panel closes with Escape, its close button and a click beside it; focus goes back to the tile.
	const backOn = (id) =>
		page.evaluate(
			(r) =>
				!document.querySelector(".roles-view dialog.rv-drawer") &&
				document.activeElement === document.querySelector(`.roles-view [data-role-id="${r}"] .rv-tbtn`),
			id,
		);
	await page.keyboard.press("Escape");
	check("desktop: Escape closes the panel, focus back on the tile", !!(await waitFor(() => backOn("product"))));
	await page.focus('.roles-view [data-role-id="qa"] .rv-tbtn');
	await page.keyboard.press("Enter");
	const qaOpen = await waitFor(() =>
		page.evaluate(() => document.querySelector(".roles-view dialog.rv-drawer #rv-d-title")?.textContent === "qa"),
	);
	check("desktop: Enter on a tile opens its panel", !!qaOpen);
	await page.click(".roles-view .rv-dclose");
	check("desktop: the close button closes the panel, focus back on the tile", !!(await waitFor(() => backOn("qa"))));
	await openPanel(page, "qa");
	await page.mouse.click(200, 450);
	check("desktop: a click beside the panel closes it", !!(await waitFor(() => backOn("qa"))));

	// Reduced motion: the busy pulse runs, and stops when the person asks for less motion.
	const pulse = await page.evaluate(() => {
		const p = document.querySelector('.roles-view [data-role-id="temper"] .rv-pulse');
		return p ? getComputedStyle(p).animationName : null;
	});
	check("desktop: the busy pulse runs", !!pulse && pulse !== "none", String(pulse));
}

// Reduced motion in a context of its own.
{
	const calm = await openPage({ width: 1440, height: 900, reducedMotion: "reduce" });
	const pulse = await calm.page.evaluate(() => {
		const p = document.querySelector('.roles-view [data-role-id="temper"] .rv-pulse');
		return p ? getComputedStyle(p).animationName : "none";
	});
	check("reduced motion: no pulse", pulse === "none", pulse);
	await calm.context.close();
}

// =========================================================================================================
// 2. Navigation (desktop): the existing chat at the item; the same chat the second time
// =========================================================================================================
{
	const { page } = desk;
	const before = Date.now();
	await page.click(".roles-view .rv-witem >> nth=0");
	const first = await waitFor(
		() => lastSnapshot && lastSnapshot.at >= before && lastSnapshot.sessionFile === files.marketing && lastSnapshot,
	);
	check("navigation: the oldest ask opens the marketing home chat", !!first, JSON.stringify(lastSnapshot));
	const shownChat = await waitFor(() => page.evaluate(() => document.body.innerText.includes("marketing home starts")));
	check("navigation: the chat view shows that chat", !!shownChat);
	const focused = await waitFor(() =>
		page.evaluate(() =>
			document.querySelector(".tldr-focus")?.textContent?.includes("Which headline should the launch post use?"),
		),
	);
	check("navigation: its TL;DR line is shown and marked", !!focused);

	await page.click(".tb-tab.roles-tab");
	await page.waitForSelector(".roles-view .rv-witem");
	const taskAt = Date.now();
	await page.click(".roles-view .rv-witem >> nth=1");
	const opsChat = await waitFor(
		() => lastSnapshot && lastSnapshot.at >= taskAt && lastSnapshot.sessionFile === files.ops && lastSnapshot,
	);
	check("navigation: a task's ask opens its queue's home chat", !!opsChat, JSON.stringify(lastSnapshot));
	const taskFocus = await waitFor(() =>
		page.evaluate(() => !!document.querySelector('[data-task-id="3"].task-queue-focus')),
	);
	check("navigation: the queue shows that task, marked", !!taskFocus);

	// Back to marketing from another chat: the same transcript again, no new chat. (The app lets an idle
	// chat go when you switch away, so its runtime id may be new; the chat itself is the same file.)
	const chatsBefore = readdirSync(sessionsDir).filter((n) => n.endsWith(".jsonl")).length;
	await page.click(".tb-tab.roles-tab");
	await page.waitForSelector(".roles-view .rv-witem");
	const again = Date.now();
	await page.click(".roles-view .rv-witem >> nth=0");
	const second = await waitFor(
		() => lastSnapshot && lastSnapshot.at >= again && lastSnapshot.sessionFile === files.marketing && lastSnapshot,
	);
	const chatsAfter = readdirSync(sessionsDir).filter((n) => n.endsWith(".jsonl")).length;
	const shownAgain = await waitFor(() =>
		page.evaluate(() => document.body.innerText.includes("marketing home starts")),
	);
	check(
		"navigation: the same chat again, not a new one",
		!!second && !!first && !!shownAgain && chatsAfter === chatsBefore,
		`${second?.sessionFile === files.marketing} ${chatsBefore} -> ${chatsAfter}`,
	);

	// The report: "Report in chat" in the role's panel opens the chat the answer is in.
	await page.click(".tb-tab.roles-tab");
	await openPanel(page, "qa");
	const repAt = Date.now();
	await page.click(".roles-view .rv-drawer .rv-racts .rv-act");
	const qaChat = await waitFor(
		() => lastSnapshot && lastSnapshot.at >= repAt && lastSnapshot.sessionFile === files.qa && lastSnapshot,
	);
	check("navigation: Report in chat opens the chat with the report", !!qaChat, JSON.stringify(lastSnapshot));

	check(
		"navigation: the panel closed on the way",
		await page.evaluate(() => !document.querySelector(".roles-view dialog.rv-drawer")),
	);

	// About & rules (in the role's panel): Settings at that role.
	await page.click(".tb-tab.roles-tab");
	await openPanel(page, "backend");
	await page.click(".roles-view .rv-drawer .rv-dhead button.rv-act");
	const marked = await waitFor(() =>
		page.evaluate(() => !!document.querySelector('[data-identity="backend"].identity-row-marked')),
	);
	check("navigation: About & rules opens Settings at the role", !!marked);
	const ownerLine = await page.evaluate(
		() =>
			document.querySelector('[data-identity="backend"] .identity-owner-line[data-field="workMode"]')?.textContent ??
			"",
	);
	check(
		"settings: the work mode comes from the rules until the owner sets it",
		/from the rules/i.test(ownerLine),
		ownerLine,
	);
	const archGoals = await page.evaluate(
		() =>
			document.querySelector('[data-identity="architecture"] .identity-owner-line[data-field="goals"]')?.textContent ??
			"",
	);
	check(
		"settings: Architecture's two goals, from the rules",
		archGoals.includes("Team in Temper") && archGoals.includes("Land check workflow (#23)"),
		archGoals,
	);

	// Nothing written before Save.
	const same = ROLES.every(([id]) => sha(join(idDir, id, "identity.json")) === identityHashes[id]);
	check("settings: looking wrote no identity file", same);

	// The owner's form: only workMode changes; other keys and their order stay.
	await page.click('[data-identity="backend"] .identity-owner-change');
	await page.waitForSelector('[data-identity="backend"] .identity-owner-form input[value="self-start"]');
	await page.check('[data-identity="backend"] .identity-owner-form input[value="self-start"]');
	await page.click('[data-identity="backend"] .identity-owner-form .identity-save');
	const saved = await waitFor(() => {
		try {
			return JSON.parse(readFileSync(join(idDir, "backend", "identity.json"), "utf8")).workMode === "self-start";
		} catch {
			return false;
		}
	});
	const after = JSON.parse(readFileSync(join(idDir, "backend", "identity.json"), "utf8"));
	check(
		"settings: Save writes workMode and keeps the rest in its order",
		!!saved &&
			JSON.stringify(Object.keys(after)) === JSON.stringify(["id", "title", "homeChat", "workMode"]) &&
			after.homeChat === files.backend,
		JSON.stringify(after),
	);
	const others = ROLES.filter(([id]) => id !== "backend").every(
		([id]) => sha(join(idDir, id, "identity.json")) === identityHashes[id],
	);
	check("settings: no other role's file changed", others);

	// A file changed meanwhile: refused, the outside change kept.
	await page.click('[data-identity="data"] .identity-owner-change');
	await page.waitForSelector('[data-identity="data"] .identity-owner-form input[value="self-start"]');
	await page.check('[data-identity="data"] .identity-owner-form input[value="self-start"]');
	const dataFile = join(idDir, "data", "identity.json");
	const edited = { ...JSON.parse(readFileSync(dataFile, "utf8")), title: "Data & analytics (edited elsewhere)" };
	writeFileSync(dataFile, `${JSON.stringify(edited, null, "\t")}\n`);
	await page.click('[data-identity="data"] .identity-owner-form .identity-save');
	// (the note says "Unsaved changes" until the answer comes)
	const refused = await waitFor(() =>
		page.evaluate(() => {
			const note = document.querySelector('[data-identity="data"] .identity-editor-note')?.textContent ?? "";
			return /changed after you opened it/.test(note) ? note : "";
		}),
	);
	const dataNow = JSON.parse(readFileSync(dataFile, "utf8"));
	check(
		"settings: a file changed meanwhile is not overwritten",
		/changed after you opened it/.test(refused ?? "") &&
			dataNow.title.endsWith("(edited elsewhere)") &&
			!("workMode" in dataNow),
		`${refused} ${JSON.stringify(dataNow)}`,
	);
	// Close the form and Settings (Settings has no Escape key).
	await page.click('[data-identity="data"] .identity-owner-form .identity-close');
	await page.click(".modal-backdrop .modal-close >> nth=0");
	await waitFor(() => page.evaluate(() => !document.querySelector(".modal-backdrop")));

	// The page follows the owner's save: backend now starts its own work.
	await page.evaluate(() => document.querySelector(".tb-tab.roles-tab")?.click());
	const moved = await waitFor(() =>
		page.evaluate(() => document.querySelector(".roles-view .rv-grp")?.textContent === "Start their own work · 4"),
	);
	check("settings: the Roles page follows the owner's save", !!moved);

	// Back as seeded (an edit outside the app): the bars below are for the page as it normally is.
	writeFileSync(
		join(idDir, "backend", "identity.json"),
		`${JSON.stringify({ id: "backend", title: "Backend engineering", homeChat: files.backend }, null, "\t")}\n`,
	);
	const back = await waitFor(() =>
		page.evaluate(() => document.querySelector(".roles-view .rv-grp")?.textContent === "Start their own work · 3"),
	);
	check("settings: an outside edit back to the rules moves the role back", !!back);
}

// =========================================================================================================
// 3. Live: a new line arrives by itself; a restart shows "not live" and the page comes back
// =========================================================================================================
{
	const { page } = desk;
	const lastLine = JSON.parse(readFileSync(files.architecture, "utf8").trim().split("\n").at(-1));
	const fresh = { ...tldr("Fresh line from the plan review", Date.now()), parentId: lastLine.id };
	const sent = Date.now();
	appendFileSync(files.architecture, `${JSON.stringify(fresh)}\n`);
	const arrived = await waitFor(
		async () => (await rowText(page, "architecture")).includes("Fresh line from the plan review"),
		15_000,
	);
	check("live: a new TL;DR line reaches the open page by itself", !!arrived, `${Date.now() - sent} ms`);
	if (arrived) console.log(`  (arrived after ${Date.now() - sent} ms)`);

	const restart = srv.restart();
	const stale = await waitFor(
		() =>
			page.evaluate(() =>
				document.querySelector(".roles-view .rv-note[role='status']")?.textContent?.includes("Not live"),
			),
		20_000,
		100,
	);
	await restart;
	const restartedAt = Date.now();
	check("live: a lost connection shows Not live, with the last update", !!stale);
	const back = await waitFor(
		() =>
			page.evaluate(
				() => ![...document.querySelectorAll(".roles-view .rv-note")].some((n) => n.textContent.includes("Not live")),
			),
		30_000,
	);
	check("live: the page comes back after the restart", !!back);
	// The new server only sends the roles to a page that asks for them again.
	const fresher = await waitFor(() => frames.roles.some((f) => f.at >= restartedAt), 15_000);
	check("live: it asks for the roles again on the new connection", !!fresher);
}

// Quiet: while nothing changes, few and bounded pushes.
{
	const n0 = frames.roles.length;
	await sleep(8000);
	const pushed = frames.roles.slice(n0);
	const biggest = Math.max(0, ...frames.roles.map((f) => f.size));
	check("bounds: no pushes while nothing changes (8 s)", pushed.length <= 1, `${pushed.length}`);
	check("bounds: a full page update stays under 256 KB", biggest < 256 * 1024, `${biggest}`);
	console.log(`  (roles pushes: ${frames.roles.length}, biggest ${biggest} bytes)`);
}

// =========================================================================================================
// 4. Phone, dark: tiles, strip folded, the panel full screen, reports view
// =========================================================================================================
const phone = await openPage({ width: 390, height: 844, phone: true });
{
	const { page } = phone;
	const tab = await page.evaluate(() => !!document.querySelector(".tb-tab.roles-tab .roles-badge"));
	check("phone: Roles with its count in the top bar", tab);
	const cards = await page.evaluate(() =>
		[...document.querySelectorAll(".roles-view .rv-tile")].map((r) => r.dataset.roleId),
	);
	check("phone: one tile per role", cards.length === 14, `${cards.length}`);
	const folded = await page.evaluate(() => ({
		open: document.querySelector(".roles-view .rv-wbtn")?.getAttribute("aria-expanded"),
		prev: document.querySelector(".roles-view .rv-wprev")?.textContent,
	}));
	check(
		"phone: the strip starts folded, with the oldest ask",
		folded.open === "false" &&
			(folded.prev ?? "").includes("marketing") &&
			(folded.prev ?? "").includes("Which headline"),
		JSON.stringify(folded),
	);
	const m = await visualChecks(page, "phone dark", { phone: true });
	check(
		"phone dark: at least 6 tiles fully on the first 390x844 screen",
		m.fullRows >= 6,
		`${m.fullRows} (${m.layout})`,
	);
	console.log(`  (phone dark: ${m.fullRows} tiles on the window; ${m.screens} screens; ${m.layout})`);
	await shot(page, "phone-dark");

	// A tile opens the role's panel over the whole screen; the close button brings the tile back.
	const panel = await openPanel(page, "design");
	const wide = await page.evaluate(
		() => document.querySelector(".roles-view dialog.rv-drawer")?.getBoundingClientRect().width ?? 0,
	);
	check("phone: the panel covers the screen", wide >= 389, `${wide}`);
	check(
		"phone: the panel has TL;DR, queue and report",
		panel.includes("TL;DR") && panel.includes("Queue") && panel.includes("6 am report"),
		panel.slice(0, 200),
	);
	await shot(page, "phone-dark-open");
	await visualChecks(page, "phone dark, panel open", { phone: true });
	await page.click(".roles-view .rv-dclose");
	const closed = await waitFor(() =>
		page.evaluate(
			() =>
				!document.querySelector(".roles-view dialog.rv-drawer") &&
				document.activeElement === document.querySelector('.roles-view [data-role-id="design"] .rv-tbtn'),
		),
	);
	check("phone: the close button closes the panel, focus back on the tile", !!closed);

	for (const width of [320, 768]) {
		await page.setViewportSize({ width, height: 844 });
		await sleep(250);
		const w = await page.evaluate(MEASURE);
		check(`phone ${width}: nothing scrolls sideways`, w.overflowX <= 1, `${w.overflowX}`);
		check(`phone ${width}: counts are never cut`, w.clipped.length === 0, w.clipped.join("; "));
	}
	await page.setViewportSize({ width: 769, height: 900 });
	await sleep(250);
	const w769 = await page.evaluate(MEASURE);
	check("desktop 769: nothing scrolls sideways", w769.overflowX <= 1, `${w769.overflowX}`);
	check("desktop 769: counts are never cut", w769.clipped.length === 0, w769.clipped.join("; "));
	await page.setViewportSize({ width: 390, height: 844 });
	await sleep(250);

	// The 6 am reports only.
	const sw = await page.evaluate(() =>
		[...document.querySelectorAll(".roles-view .rv-switch button")].map((b) => b.textContent),
	);
	check(
		"phone: the switch counts today's reports",
		JSON.stringify(sw) === JSON.stringify(["Now", "6 am reports (3)"]),
		JSON.stringify(sw),
	);
	await page.click(".roles-view .rv-switch button >> nth=1");
	const reports = await waitFor(() =>
		page.evaluate(() => [...document.querySelectorAll(".roles-view .rv-r6")].map((r) => r.dataset.roleId)),
	);
	check(
		"phone: the reports view lists the roles in the job",
		JSON.stringify(reports) === JSON.stringify(["design", "product", "qa", "data", "frontend"]),
		JSON.stringify(reports),
	);
	await page.click('.roles-view .rv-r6[data-role-id="product"] .rv-acts button');
	const whole = await waitFor(() =>
		page.evaluate(() =>
			document
				.querySelector('.roles-view .rv-r6[data-role-id="product"]')
				?.textContent?.includes("END-OF-PRODUCT-REPORT"),
		),
	);
	check("phone: Show full report opens the whole report in place", !!whole);
	const mr = await visualChecks(page, "phone reports", { phone: true });
	check("phone reports: nothing scrolls sideways", mr.overflowX <= 1);
	await shot(page, "phone-dark-reports");
}

// =========================================================================================================
// 5. White theme, phone and desktop
// =========================================================================================================
for (const [w, h, isPhone] of [
	[390, 844, true],
	[1440, 900, false],
]) {
	const light = await openPage({ width: w, height: h, phone: isPhone, theme: "white" });
	const themed = await light.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
	check(`white ${w}: the White theme is on`, /rgb\(25[0-5], 25[0-5], 25[0-5]\)/.test(themed), themed);
	const m = await visualChecks(light.page, `white ${w}`, { phone: isPhone });
	if (isPhone)
		check("white 390: at least 6 tiles fully on the first screen", m.fullRows >= 6, `${m.fullRows} (${m.layout})`);
	else {
		check(
			"white 1440: all 14 tiles fully on the first screen, above the app's status bar",
			m.rows === 14 && m.fullRowsAboveBar === 14,
			`${m.fullRowsAboveBar} of ${m.rows} above the bar, ${m.fullRows} on the window (${m.layout})`,
		);
		console.log(`  (white 1440: ${m.fullRows} tiles on the window, ${m.fullRowsAboveBar} above the status bar)`);
	}
	await shot(light.page, `${isPhone ? "phone" : "desktop"}-white`);
	await light.context.close();
}

// =========================================================================================================
// 6. Twenty roles
// =========================================================================================================
{
	for (const id of EXTRA) {
		mkdirSync(join(idDir, id), { recursive: true });
		writeFileSync(
			join(idDir, id, "identity.json"),
			`${JSON.stringify({ id, title: `Zeta ${id.slice(5)}` }, null, "\t")}\n`,
		);
		writeFileSync(join(idDir, id, "about.md"), `# Zeta\n\n**Focus:** extra role.\n`);
	}
	const { page } = desk;
	await page.setViewportSize({ width: 1440, height: 900 });
	const twenty = await waitFor(
		() => page.evaluate(() => document.querySelectorAll(".roles-view .rv-tile").length === 20),
		20_000,
	);
	check("20 roles: they appear by themselves", !!twenty);
	const order = await page.evaluate(() =>
		[...document.querySelectorAll(".roles-view .rv-tile")].map((r) => r.dataset.roleId),
	);
	const groupB = order.slice(3);
	check(
		"20 roles: still alphabetical in their groups",
		JSON.stringify(groupB) === JSON.stringify([...groupB].sort()) && order.slice(0, 3).join() === "design,product,qa",
		order.join(","),
	);
	// The measure is for the page as it opens: no panel open.
	if (await page.$(".roles-view dialog.rv-drawer")) await closePanel(page);
	await sleep(200);
	const m = await page.evaluate(MEASURE);
	check("20 roles desktop: at least 14 fully on the first screen", m.fullRows >= 14, `${m.fullRows} (${m.layout})`);
	check("20 roles desktop: nothing scrolls sideways", m.overflowX <= 1, `${m.overflowX}`);
	console.log(`  (20 roles: ${m.screens} desktop screens)`);
	await shot(page, "desktop-dark-20");
	const p = phone.page;
	await waitFor(() => p.evaluate(() => document.querySelectorAll(".roles-view [data-role-id]").length === 20), 20_000);
	await p.click(".roles-view .rv-switch button >> nth=0");
	const pm = await p.evaluate(MEASURE);
	check(
		"20 roles phone: one tile each, nothing sideways",
		pm.rows === 20 && pm.overflowX <= 1,
		`${pm.rows} ${pm.overflowX}`,
	);
}

// =========================================================================================================
// 7. Partial: home chats the page must refuse (a path through "..", a link to a file outside)
// =========================================================================================================
{
	for (const id of ["security", "systems"]) {
		const file = join(idDir, id, "identity.json");
		const json = { ...JSON.parse(readFileSync(file, "utf8")), homeChat: files[id] };
		writeFileSync(file, `${JSON.stringify(json, null, "\t")}\n`);
	}
	const { page } = desk;
	const note = await waitFor(async () => {
		const text = await page.evaluate(() =>
			[...document.querySelectorAll(".roles-view .rv-note")].map((n) => n.textContent).join(" | "),
		);
		return text.includes("2 roles could not be read fully (security, systems)") ? text : "";
	}, 20_000);
	check("partial: the roles read only in part are named", !!note, note ?? "");
	const security = await rowText(page, "security");
	check(
		"partial: what could be read still shows (the open request)",
		security.includes("Please check the new login flow"),
		security.slice(0, 200),
	);
	await shot(page, "desktop-dark-partial");
}

// =========================================================================================================
// 8. What the page never got, and what looking never did
// =========================================================================================================
{
	const leaks = [
		"CANARY-THINK",
		"CANARY-TOOL",
		"CANARY-RESULT",
		"CANARY-PROMPT",
		"CANARY-NOTE",
		"CANARY-SECRET",
		"CANARY-TRAVERSAL",
		"CANARY-NOTEBOOK",
	].filter((c) => frames.roles.some((f) => f.text.includes(c)));
	check(
		"never sent: thinking, tool calls and results, prompts, notebooks, out-of-folder chats",
		leaks.length === 0,
		leaks.join(", "),
	);
	check(
		"never sent: raw entries",
		!frames.roles.some((f) => f.text.includes('"customType"') || f.text.includes('"parentId"')),
	);
	check("the model was never called", modelCalls === 0, `${modelCalls}`);
	const untouched = Object.entries(watched).filter(([k, h]) => sha(files[k]) !== h);
	check("looking wrote to no chat (not opened ones)", untouched.length === 0, untouched.map(([k]) => k).join(", "));
	const busy = await fetch(`${srv.http}/api/busy`).then((r) => r.json());
	check("nothing is running", Array.isArray(busy.busy) && busy.busy.length === 0, JSON.stringify(busy));
	const store = JSON.parse(readFileSync(rmFile, "utf8"));
	const ids = (store.messages ?? []).map((m) => `${m.id}:${m.state}`).sort();
	check(
		"the role-message store kept its records",
		JSON.stringify(ids) ===
			JSON.stringify([
				"rm-0000d001:replied",
				"rm-0000d002:replied",
				"rm-0000d003:replied",
				"rm-0000e001:delivered",
				"rm-0000e002:replied",
			]),
		ids.join(","),
	);
	check(
		"the outside file stayed outside",
		statSync(outsideFile).size > 0 && readFileSync(outsideFile, "utf8").includes("CANARY-SECRET"),
	);
}

await browser.close();
await srv.stop();
console.log(failures ? `\n${failures} check(s) failed` : "\nall roles-page checks passed");
process.exit(failures ? 1 : 0);
