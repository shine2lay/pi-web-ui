/* board E2E (no tokens): the roles' shared board (task #76).
 *
 * The owner on Telegram, 2026-10-06 ~12:25 PDT (COO's request rm-ef861b36): "Lets create a message board
 * that everyone can check, instead of poking the same message to all roles that needs to read it. Have one
 * place where the roles can read it. Unless its a direct requests. Those should go directly." And ~12:35
 * (rm-c4989975): "If the role has something waiting then the message should go directly to them. Because
 * something needs to poke it to wake its session otherwise general info should be put in the message board".
 *
 * A sealed server with a scripted model and the real pi-identity (PI_IDENTITY_PKG, default
 * ~/projects/pi-identity). Three fake roles: alpha (home chat A, with an open task in its queue), beta
 * (home chat B, nothing waiting but a running turn) and gamma (home chat C, nothing waiting). Every chat
 * starts closed. Checks:
 *  1. the owner posts an order to the three from the Roles page's Board view: A gets exactly one direct
 *     "[Board order]" turn; B's running turn gets exactly one steer and no new turn; C gets nothing (its
 *     transcript is untouched); the card says who got it directly and how, and "Done 0/3";
 *  2. news to the same roles, posted while B runs a turn, starts no turn and steers nothing;
 *  3. C's next turn has exactly one "[Board]" note, with the order (and its ack line) and the news; the
 *     board tool is offered in role chats and not in a chat without a role;
 *  4. gamma acks the order with the board tool: the card shows its tick and note ("Done 1/3");
 *     roles_overview lists the order for the roles not done; alpha's panel lists it;
 *  5. the owner closes the order: each chat that saw it gets "ended" once, at its next turn only;
 *  6. the chat view folds the note and the direct order to one row each;
 *  7. screenshots dark and white, desktop and phone; axe finds nothing serious or critical; no sideways
 *     overflow; no page errors.
 * Never prints what goes to the model (rule 11).
 * Usage: npm run build && node tests/board-test.mjs
 *   BOARD_DEBUG=1: server output and one line per model request; BOARD_SHOT=<dir>: screenshots.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { textOf } from "./lib/mock-model.mjs";
import { ownServer } from "./lib/own-server.mjs";

// The account's home (userInfo), not HOME: a sealed run has a temp HOME.
const PI_IDENTITY = process.env.PI_IDENTITY_PKG ?? join(userInfo().homedir, "projects", "pi-identity");
if (!existsSync(join(PI_IDENTITY, "package.json"))) {
	console.log(`✗ FAIL: pi-identity not found at ${PI_IDENTITY} (set PI_IDENTITY_PKG)`);
	process.exit(1);
}
const AXE = process.env.PI_AXE_JS ?? join(userInfo().homedir, "temper-ai/configs/design/bin/vendor/axe-4.13.0.min.js");
const SHOTS = process.env.BOARD_SHOT || "";
const DEBUG = !!process.env.BOARD_DEBUG;

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✓" : "✗ FAIL:"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures += 1;
}
async function waitFor(fn, timeout = 30_000, step = 150) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const v = await fn();
		if (v) return v;
		await sleep(step);
	}
	return null;
}
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

// ---- the scripted model ------------------------------------------------------------------------------
const SLOW_TEXT = `SLOW-ANSWER ${"lorem ipsum dolor sit amet ".repeat(48)}END-OF-SLOW`;
const ORDER_HEAD = /^\[Board order (bp-[0-9a-f]{8}) /;
/** What the requests carried (booleans only). */
const seen = { noRoleBoardTool: null, noRoleMessageRole: null, roleBoardTool: null };
const MARKS = ["NOROLE", "SLOW-1", "SLOW-2", "HELLO-C", "ACK", "OVERVIEW", "AFTER-CLOSE"];
function reply(ctx) {
	// The app adds "(System reminder: …)" after a prompt while another chat in the folder runs, and a role
	// chat's turn-start "[Board]" note after its prompt: the test's own message is the last one before them.
	const users = (Array.isArray(ctx.payload.messages) ? ctx.payload.messages : []).filter((m) => {
		if (m.role !== "user") return false;
		const t = textOf(m);
		return !/^\(System reminder/.test(t) && !t.startsWith("[Board] ");
	});
	ctx = { ...ctx, lastUser: users.length > 0 ? textOf(users.at(-1)) : ctx.lastUser };
	const out = decide(ctx);
	if (DEBUG) {
		const head = ORDER_HEAD.exec(ctx.lastUser)?.[1];
		const marks = MARKS.filter((m) => ctx.lastUser.includes(m));
		const what = typeof out === "string" ? `text ${out.slice(0, 18)}` : out?.tool ? `tool ${out.tool}` : "stream";
		console.log(
			`[mock] ${new Date().toISOString().slice(11, 23)} ${head ? `order ${head} ` : ""}${marks.join("+") || "-"} msgs=${ctx.payload.messages?.length ?? 0} side=${ctx.sideRequest} result=${!!ctx.toolResult} -> ${what}`,
		);
	}
	return out;
}
function decide({ payload, lastUser, toolResult, sideRequest }) {
	if (sideRequest) return "Chat";
	const tools = (Array.isArray(payload.tools) ? payload.tools : []).map((t) => t.function?.name ?? t.name);
	if (toolResult) return "done";
	if (lastUser.startsWith("NOROLE")) {
		seen.noRoleBoardTool = tools.includes("board");
		seen.noRoleMessageRole = tools.includes("message_role");
	}
	if (lastUser.startsWith("HELLO-C")) seen.roleBoardTool = tools.includes("board");
	const order = ORDER_HEAD.exec(lastUser);
	if (order) return `noted board order ${order[1]}`;
	if (lastUser.startsWith("SLOW")) return { text: SLOW_TEXT, stream: { everyMs: 40, pieceChars: 6 } };
	const ack = /^ACK (bp-[0-9a-f]{8}) ([\s\S]+)$/.exec(lastUser);
	if (ack) return { tool: "board", args: { action: "ack", id: ack[1], note: ack[2] } };
	if (lastUser === "OVERVIEW") return { tool: "roles_overview", args: {} };
	const one = /^OVERVIEW (\S+)$/.exec(lastUser);
	if (one) return { tool: "roles_overview", args: { role: one[1] } };
	return "ok";
}

// ---- the saved chats and the roles -------------------------------------------------------------------
const files = {};
let idDir = "";
function seed({ root, agentDir, workdir }) {
	const settingsFile = join(agentDir, "settings.json");
	const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {};
	settings.packages = [PI_IDENTITY];
	writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

	const dir = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(dir, { recursive: true });
	const file = (n) => join(dir, `2026-10-06T10-0${n}-00-000Z_01a0f000-0000-7000-8000-0000000000c${n}.jsonl`);
	files.A = file(1);
	files.B = file(2);
	files.C = file(3);
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const write = (path, items) => {
		let ts = Date.now() - 3_600_000;
		const id = path.match(/_([^_]+)\.jsonl$/)?.[1];
		const lines = [
			{ type: "session", version: 3, id, timestamp: new Date(ts).toISOString(), cwd: workdir },
			{
				type: "model_change",
				id: "mc",
				parentId: null,
				timestamp: new Date(ts).toISOString(),
				provider: "mock",
				modelId: "mock-model",
			},
		];
		let parentId = "mc";
		for (const item of items) {
			ts += 1000;
			const base = { id: `e${lines.length}`, parentId, timestamp: new Date(ts).toISOString() };
			if (item.queue) lines.push({ type: "custom", customType: "queue", ...base, data: { v: 1, ts, ...item.queue } });
			else if (item.identity) {
				lines.push({
					type: "custom",
					customType: "identity",
					...base,
					data: { v: 1, id: item.identity, via: "command" },
				});
			} else if (item.user) {
				lines.push({
					type: "message",
					...base,
					message: { role: "user", content: [{ type: "text", text: item.user }], timestamp: ts },
				});
			} else {
				lines.push({
					type: "message",
					...base,
					message: {
						role: "assistant",
						content: [{ type: "text", text: item.assistant }],
						api: "openai-completions",
						provider: "mock",
						model: "mock-model",
						usage,
						stopReason: "stop",
						timestamp: ts,
					},
				});
			}
			parentId = base.id;
		}
		writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	};
	const plan = {
		title: "Tidy the docs",
		goal: "-",
		doneWhen: "-",
		decided: "-",
		steps: "-",
		verify: "-",
		mustNot: "-",
	};
	// alpha: an open task in its queue (ready, not started) -> "has something waiting".
	write(files.A, [
		{ identity: "alpha" },
		{ queue: { op: "add", id: 3, plan } },
		{ user: "alpha home starts" },
		{ assistant: "ok" },
	]);
	write(files.B, [{ identity: "beta" }, { user: "beta home starts" }, { assistant: "ok" }]);
	write(files.C, [{ identity: "gamma" }, { user: "gamma home starts" }, { assistant: "ok" }]);

	idDir = join(root, "identities");
	const role = (id, json, about) => {
		mkdirSync(join(idDir, id), { recursive: true });
		writeFileSync(join(idDir, id, "identity.json"), JSON.stringify({ id, ...json }, null, "\t"));
		writeFileSync(join(idDir, id, "about.md"), about);
		writeFileSync(join(idDir, id, "notebook.md"), "");
	};
	role("alpha", { title: "Alpha desk", homeChat: files.A }, "# Alpha desk\n\n**Focus:** the alpha checks.\n");
	role("beta", { title: "Beta desk", homeChat: files.B }, "# Beta desk\n\n**Focus:** the beta answers.\n");
	role("gamma", { title: "Gamma lab", homeChat: files.C }, "# Gamma lab\n\n**Focus:** the gamma trials.\n");
}

const srv = await ownServer({
	name: "board",
	verbose: DEBUG,
	mock: reply,
	prepare: seed,
	env: {
		get PI_IDENTITY_DIR() {
			return idDir;
		},
		PI_IDENTITY_REINDEX: "0",
	},
});

// ---- a window (a socket of its own) ---------------------------------------------------------------
class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		this.state = null;
		/** Every change of the open chat's isStreaming, in order (true: a turn started; false: it ended). */
		this.flips = [];
		ws.on("message", (data) => {
			const message = JSON.parse(data.toString());
			this.received.push(message);
			const was = this.state?.isStreaming;
			if (message.type === "snapshot") this.state = message.state;
			else if (message.type === "snapshot_delta") {
				if (this.state?.rev === message.baseRev && message.conversationId === this.state.conversationId) {
					const messages = [...(this.state.messages ?? []), ...(message.appended ?? [])];
					this.state = { ...this.state, ...message.state, messages };
				} else this.send({ type: "get_state" });
			}
			if (this.state && was !== undefined && this.state.isStreaming !== was) this.flips.push(this.state.isStreaming);
		});
	}
	static async connect(name) {
		const ws = new WebSocket(srv.ws);
		await new Promise((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		const client = new Client(ws);
		client.send({ type: "hello", clientId: `${name}-${Date.now()}` });
		if (!(await waitFor(() => client.received.some((m) => m.type === "ready"), 40_000, 50)))
			throw new Error("no ready");
		if (!(await waitFor(() => client.state?.conversationId, 15_000, 50))) throw new Error("no snapshot");
		return client;
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	async open(file) {
		this.send({ type: "switch_session", path: file });
		if (!(await waitFor(() => this.state?.sessionFile === file && this.state.isStreaming === false, 20_000))) {
			throw new Error(`couldn't open ${file}`);
		}
		this.flips = [];
	}
	/** Opens a new, empty chat (a window starts on the newest chat, which here has a role). */
	async newChat() {
		const before = this.state?.conversationId;
		this.send({ type: "new_chat" });
		const ok = await waitFor(
			() => this.state?.conversationId !== before && (this.state?.messages?.length ?? 0) === 0,
			15_000,
		);
		if (!ok) throw new Error("no new chat");
	}
	/** Sends a prompt to the open chat and waits for its turn to end (a new answer in the transcript). */
	async prompt(text, timeout = 30_000) {
		const file = this.state.sessionFile;
		const before = file ? entries(file).length : 0;
		this.send({ type: "prompt", text });
		const done = await waitFor(() => {
			const f = this.state.sessionFile;
			if (!f || this.state.isStreaming !== false) return false;
			const after = entries(f);
			return (
				after.length > before && after.at(-1)?.role === "assistant" && after.slice(before).some((m) => m.text === text)
			);
		}, timeout);
		if (!done) throw new Error(`no answer to "${text.slice(0, 40)}"`);
	}
	/** Starts a turn without waiting for it to end; resolves once it runs. */
	async start(text) {
		this.send({ type: "prompt", text });
		if (!(await waitFor(() => this.state?.isStreaming === true, 15_000, 20)))
			throw new Error(`"${text}" never started`);
	}
	close() {
		try {
			this.ws.close();
		} catch {
			/* gone */
		}
	}
}

/** The transcript as lines (JSON). */
function lines(file) {
	try {
		return readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}
/** The transcript's messages: { role, text }. */
const entries = (file) =>
	lines(file)
		.filter((e) => e.type === "message")
		.map((e) => ({ role: e.message?.role, text: textOf(e.message) }));
/** The board's turn-start notes in a transcript (custom messages "board"): their texts. */
const boardNotes = (file) =>
	lines(file)
		.filter((e) => e.type === "custom_message" && e.customType === "board")
		.map((e) => textOf(e));
/** The orders the board sent to a chat directly (a turn, or a steer into a running one). */
const ordersIn = (file, id) =>
	entries(file).filter((m) => m.role === "user" && m.text.startsWith(`[Board order ${id} `)).length;
/** The chat's own user messages (not the app's "(System reminder: …)" about other runs in the folder). */
const userCount = (file) =>
	entries(file).filter((m) => m.role === "user" && !m.text.startsWith("(System reminder")).length;
const toolResults = (file) =>
	entries(file)
		.filter((m) => m.role === "toolResult")
		.map((m) => m.text);

// ---- the browser -----------------------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const pageErrors = [];
async function openPage({ width, height, phone = false, theme = null }, path = "/?view=roles") {
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
	page.on("pageerror", (e) => pageErrors.push(String(e)));
	page.on("console", (m) => {
		if (m.type() === "error" && !/favicon|Failed to load resource/i.test(m.text())) pageErrors.push(m.text());
	});
	await page.goto(`${srv.http}${path}`);
	return { context, page };
}
/** Opens the Roles page's Board view. */
async function openBoard(size) {
	const { context, page } = await openPage(size);
	await page.waitForSelector(".roles-view [data-role-id]", { timeout: 30_000 });
	await page.waitForSelector(".roles-view .rv-switch button:nth-child(3)", { timeout: 15_000 });
	await page.click(".roles-view .rv-switch button:nth-child(3)");
	await page.waitForSelector(".roles-view .rv-board", { timeout: 10_000 });
	await page.evaluate(() => document.fonts?.ready);
	return { context, page };
}
const cardSel = (id) => `.rv-board .rv-bpost[data-post-id="${id}"]`;
const cardText = (page, id) =>
	page.evaluate((s) => document.querySelector(s)?.innerText.replace(/\s+/g, " ") ?? "", cardSel(id));
const markText = (page, id, role) =>
	page.evaluate(
		([s, r]) => document.querySelector(`${s} .rv-bmark[data-role="${r}"]`)?.innerText.replace(/\s+/g, " ") ?? "",
		[cardSel(id), role],
	);
const saidText = (page) => page.evaluate(() => document.querySelector(".rv-board .rv-bsaid")?.textContent ?? "");
/** Writes and sends a post from the Board view; returns the status line once it says "Posted". */
async function post(page, { kind, to, title, text }) {
	await page.click(".rv-board .rv-bbar .rv-act");
	await page.waitForSelector(".rv-board .rv-bform", { timeout: 5000 });
	await page.check(`.rv-bform input[name="rv-bkind"][value="${kind}"]`);
	await page.check('.rv-bform input[name="rv-bto"] >> nth=1');
	for (const role of to) await page.check(`.rv-bform .rv-broles input[value="${role}"]`);
	await page.fill('.rv-bform input[name="title"]', title);
	await page.fill('.rv-bform textarea[name="text"]', text);
	await page.click(".rv-bform .rv-bprimary");
	const said = await waitFor(async () => {
		const s = await saidText(page);
		return s.startsWith("Posted ") ? s : null;
	}, 15_000);
	if (!said) throw new Error(`"${title}" wasn't posted`);
	return said;
}
async function runAxe(page, sel = ".roles-view") {
	if (!existsSync(AXE)) return { error: `axe-core not found at ${AXE} (set PI_AXE_JS)` };
	await page.addScriptTag({ path: AXE });
	return page.evaluate(async (s) => {
		const r = await window.axe.run(document.querySelector(s), {
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
	}, sel);
}
async function shot(page, name) {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}
const overflowX = (page) =>
	page.evaluate(() => {
		const root = document.querySelector(".roles-view");
		return Math.max(
			(root?.scrollWidth ?? 0) - (root?.clientWidth ?? 0),
			document.documentElement.scrollWidth - innerWidth,
		);
	});

let wB;
let wC;
let w0;
let desk;
try {
	// =====================================================================================================
	// 0. A chat without a role isn't offered the board tool.
	w0 = await Client.connect("board-w0");
	const shaA = sha(files.A);
	const shaB = sha(files.B);
	const shaC = sha(files.C);
	await w0.newChat();
	await w0.prompt("NOROLE hello");
	check(
		"the chat without a role is a new one (no role chat touched)",
		![files.A, files.B, files.C].includes(w0.state.sessionFile) &&
			sha(files.A) === shaA &&
			sha(files.B) === shaB &&
			sha(files.C) === shaC,
	);
	check(
		"a chat without a role isn't offered the board tool",
		seen.noRoleBoardTool === false,
		`board ${seen.noRoleBoardTool}, message_role ${seen.noRoleMessageRole}`,
	);

	wB = await Client.connect("board-wb");
	await wB.open(files.B);
	wC = await Client.connect("board-wc");
	const shaC0 = sha(files.C);
	const aUsers0 = userCount(files.A);

	// =====================================================================================================
	// 1. The owner posts an order to alpha, beta and gamma from the Board view.
	desk = await openBoard({ width: 1280, height: 900 });
	const page = desk.page;
	check(
		"the Roles page has a Board switch, with no open posts yet",
		(await page.textContent(".roles-view .rv-switch button:nth-child(3)"))?.trim() === "Board (0)" &&
			(await page.textContent(".rv-board"))?.includes("No open posts."),
	);
	await shot(page, "board-empty-desktop-dark");

	// beta's home chat is mid-turn (nothing else waits on beta); alpha has an open task; gamma nothing.
	await wB.start("SLOW-1 a long answer");
	const said1 = await post(page, {
		kind: "order",
		to: ["alpha", "beta", "gamma"],
		title: "Pause new work",
		text: "Finish what you have; **start nothing new** until I say so.",
	});
	const O1 = /Posted (bp-[0-9a-f]{8})/.exec(said1)?.[1] ?? "";
	check(
		"posting the order says it went straight to the roles with something waiting (alpha, beta)",
		!!O1 && said1.includes("Sent straight to alpha, beta, which had something waiting"),
		said1,
	);

	// beta: one steer into the running turn; the turn goes on to its end, and no new turn starts.
	const bDone = await waitFor(
		() => wB.state.isStreaming === false && entries(files.B).at(-1)?.text === `noted board order ${O1}`,
		40_000,
	);
	check("beta's running turn got the order as a steer and answered it in the same turn", !!bDone);
	check("beta got exactly one steer", ordersIn(files.B, O1) === 1, `${ordersIn(files.B, O1)}`);
	check(
		"no new turn started in beta's chat (one start, one end)",
		JSON.stringify(wB.flips) === "[true,false]",
		JSON.stringify(wB.flips),
	);
	// alpha: exactly one direct turn in its idle home chat (opened in the background).
	const aDone = await waitFor(() => entries(files.A).at(-1)?.text === `noted board order ${O1}`, 40_000);
	check("alpha's idle home chat got the order as a turn of its own", !!aDone);
	await sleep(7000); // two more passes of the board's loop: nothing is sent twice
	check("alpha got exactly one direct turn", ordersIn(files.A, O1) === 1, `${ordersIn(files.A, O1)}`);
	check(
		"the direct turn added only the order to alpha's chat (no board note: it already has the order)",
		userCount(files.A) === aUsers0 + 1 && boardNotes(files.A).length === 0,
		`${userCount(files.A) - aUsers0} ${boardNotes(files.A).length}`,
	);
	check("beta's chat got nothing more", ordersIn(files.B, O1) === 1 && wB.flips.length === 2);
	check("gamma (nothing waiting) got no turn, no steer, nothing in its chat", sha(files.C) === shaC0);

	const marksOk = await waitFor(async () => {
		const a = await markText(page, O1, "alpha");
		return a.includes("got it directly, as a turn in its home chat") ? a : null;
	}, 15_000);
	check("the card marks alpha as reached by a turn in its home chat", !!marksOk, await markText(page, O1, "alpha"));
	check(
		"the card marks beta as reached in its running turn",
		(await markText(page, O1, "beta")).includes("got it directly, in its running turn"),
		await markText(page, O1, "beta"),
	);
	check(
		"the card marks gamma as on the board, not read yet",
		(await markText(page, O1, "gamma")).includes("on the board, not read yet"),
		await markText(page, O1, "gamma"),
	);
	const card1 = await cardText(page, O1);
	check(
		"the card: kind, title, from, to, the text as Markdown, Done 0/3, 2 got it directly",
		card1.includes("Order") &&
			card1.includes("Pause new work") &&
			card1.includes("From owner · to alpha, beta, gamma") &&
			card1.includes("Done 0/3") &&
			card1.includes("2 got it directly") &&
			(await page.evaluate((s) => !!document.querySelector(`${s} strong`), cardSel(O1))),
		card1,
	);
	check(
		"the Board switch counts the open post",
		(await page.textContent(".roles-view .rv-switch button:nth-child(3)"))?.trim() === "Board (1)",
	);

	// =====================================================================================================
	// 2. News to the same roles, posted while beta runs a turn: no steer, no turn, for anyone.
	const aUsers1 = userCount(files.A);
	const bUsers1 = userCount(files.B);
	await wB.start("SLOW-2 another long answer");
	const said2 = await post(page, {
		kind: "news",
		to: ["alpha", "beta", "gamma"],
		title: "Deploy at 15:00",
		text: "FYI: the app restarts at 15:00 for a few seconds.",
	});
	const N1 = /Posted (bp-[0-9a-f]{8})/.exec(said2)?.[1] ?? "";
	check("posting news says it wakes nobody", !!N1 && said2.includes("News wakes nobody"), said2);
	await waitFor(
		() => wB.state.isStreaming === false && entries(files.B).at(-1)?.text.startsWith("SLOW-ANSWER"),
		40_000,
	);
	await sleep(7000);
	check(
		"news steered nothing into beta's running turn",
		ordersIn(files.B, N1) === 0 && userCount(files.B) === bUsers1 + 1,
	);
	check(
		"news started no turn in beta's chat",
		JSON.stringify(wB.flips) === "[true,false,true,false]",
		JSON.stringify(wB.flips),
	);
	check("news started no turn in alpha's chat", userCount(files.A) === aUsers1);
	check("news left gamma's chat untouched", sha(files.C) === shaC0);
	check("no board note in beta's chat (it had nothing new it hadn't got)", boardNotes(files.B).length === 0);
	check("the news card counts who read it (nobody yet)", (await cardText(page, N1)).includes("Read by 0/3"));

	// =====================================================================================================
	// 3. gamma's next turn: one "[Board]" note with the order and the news.
	await wC.open(files.C);
	await wC.prompt("HELLO-C");
	const notesC = boardNotes(files.C);
	check("gamma's next turn has exactly one board note", notesC.length === 1, `${notesC.length}`);
	const n0 = notesC[0] ?? "";
	check(
		"the note: two new posts, the order first and in full, with its ack line, then the news",
		n0.startsWith("[Board] 2 new posts") &&
			n0.indexOf(O1) > 0 &&
			n0.indexOf(N1) > n0.indexOf(O1) &&
			n0.includes("start nothing new") &&
			n0.includes(`board ack ${O1} "<what you did>"`),
	);
	check("gamma got the order only on the board (no direct order in its chat)", ordersIn(files.C, O1) === 0);
	check("the board tool is offered in a role chat", seen.roleBoardTool === true, `${seen.roleBoardTool}`);
	const readOk = await waitFor(async () => (await markText(page, O1, "gamma")).includes("on the board, read"), 10_000);
	check("the card shows gamma read the order on the board", !!readOk, await markText(page, O1, "gamma"));
	check("the news card counts gamma's read", (await cardText(page, N1)).includes("Read by 1/3"));

	// =====================================================================================================
	// 4. gamma marks the order done; roles_overview and alpha's panel list it for the rest.
	await wC.prompt(`ACK ${O1} Paused my queue; nothing new started.`);
	check(
		"the board tool's ack says it's marked and nothing goes to the poster",
		toolResults(files.C).some((t) => t.startsWith(`Marked ${O1} done for gamma.`) && t.includes("Nothing is sent")),
		toolResults(files.C).at(-1),
	);
	check("no new board note at the ack's turn", boardNotes(files.C).length === 1);
	const doneOk = await waitFor(async () => (await cardText(page, O1)).includes("Done 1/3"), 10_000);
	const gm = await markText(page, O1, "gamma");
	check(
		"the card shows gamma's tick and note, and Done 1/3",
		!!doneOk &&
			gm.includes("done ") &&
			gm.includes("Paused my queue; nothing new started.") &&
			(await page.evaluate((s) => !!document.querySelector(`${s} .rv-bmark.done[data-role="gamma"]`), cardSel(O1))),
		gm,
	);
	await shot(page, "board-desktop-dark");

	await wC.prompt("OVERVIEW");
	const all = toolResults(files.C).at(-1) ?? "";
	check(
		"roles_overview (all roles) lists the open order and who hasn't done it",
		all.includes("Board: 1 open order; 1 news post in the last 3 days.") &&
			all.includes(`- ${O1} "Pause new work" from owner,`) &&
			all.includes("done 1/3; not done: alpha, beta"),
	);
	await wC.prompt("OVERVIEW alpha");
	const one = toolResults(files.C).at(-1) ?? "";
	check(
		"roles_overview for alpha lists the order it hasn't marked done",
		one.includes("Board orders it hasn't marked done (1):") && one.includes(`- ${O1} "Pause new work" from owner,`),
	);
	await wC.prompt("OVERVIEW gamma");
	check(
		"roles_overview for gamma (done) lists no open order",
		!(toolResults(files.C).at(-1) ?? "").includes("Board orders it hasn't marked done"),
	);

	await page.click(".roles-view .rv-switch button:nth-child(1)");
	await page.click('.roles-view [data-role-id="alpha"] .rv-tbtn');
	const panel = await waitFor(
		() =>
			page.evaluate(() => {
				const d = document.querySelector(".roles-view dialog.rv-drawer[open]");
				return d?.querySelector("#rv-d-title")?.textContent === "alpha" ? d.innerText : null;
			}),
		10_000,
	);
	check(
		"alpha's panel lists its open order not done",
		!!panel && panel.includes("Open orders not done (1)") && panel.includes("Pause new work"),
		panel?.slice(0, 200),
	);
	await waitFor(() =>
		page.evaluate(() =>
			(document.querySelector(".roles-view dialog.rv-drawer")?.getAnimations() ?? []).every(
				(a) => a.playState === "finished",
			),
		),
	);
	await shot(page, "panel-desktop-dark");
	// The order in the panel opens the Board view at that post.
	await page.click(".roles-view dialog.rv-drawer[open] .rv-bord");
	const focused = await waitFor(
		() => page.evaluate((s) => document.activeElement === document.querySelector(s), cardSel(O1)),
		10_000,
	);
	check("the order in a role's panel opens the Board view at that post", !!focused);

	// =====================================================================================================
	// 5. The owner closes the order: "ended", once, in each chat that saw it, at its next turn.
	await page.click(`${cardSel(O1)} .rv-acts .rv-act`);
	await page.fill(`${cardSel(O1)} form.rv-bclose input[name="note"]`, "pause lifted");
	await page.click(`${cardSel(O1)} form.rv-bclose .rv-bprimary`);
	const closedHead = await waitFor(
		() => page.evaluate(() => document.querySelector(".rv-board .rv-bclosedh button")?.textContent ?? null),
		10_000,
	);
	check("the closed post moves to Closed posts (1)", closedHead?.includes("Closed posts (1)"), closedHead ?? "");
	await page.click(".rv-board .rv-bclosedh button");
	const end = await waitFor(
		() => page.evaluate((s) => document.querySelector(`${s} .rv-bend`)?.textContent ?? null, cardSel(O1)),
		5000,
	);
	check("the closed card says who closed it and why", /^Closed .+ by owner: pause lifted$/.test(end ?? ""), end ?? "");

	await wC.prompt("AFTER-CLOSE-1");
	const notesC2 = boardNotes(files.C);
	check(
		"gamma's next turn: one note that the order ended",
		notesC2.length === 2 &&
			notesC2[1].startsWith("[Board] 1 post ended") &&
			notesC2[1].includes(`Ended: order ${O1}`) &&
			notesC2[1].includes("pause lifted"),
		notesC2[1]?.split("\n")[0],
	);
	await wC.prompt("AFTER-CLOSE-2");
	check("gamma's turn after that has no note (ended shows once)", boardNotes(files.C).length === 2);
	await wB.prompt("AFTER-CLOSE-B1");
	const notesB = boardNotes(files.B);
	check(
		"beta's next turn: the news it hadn't seen, and the order it got directly as ended",
		notesB.length === 1 &&
			notesB[0].startsWith("[Board] 1 new post, 1 ended") &&
			notesB[0].includes(N1) &&
			notesB[0].includes(`Ended: order ${O1}`),
		notesB[0]?.split("\n")[0],
	);
	await wB.prompt("AFTER-CLOSE-B2");
	check("beta's turn after that has no note", boardNotes(files.B).length === 1);

	// =====================================================================================================
	// 6. The chat view folds the note and the direct order to one row each.
	{
		const { context, page: p } = await openPage({ width: 1280, height: 900 }, `/?chat=${encodeURIComponent(files.C)}`);
		// The newest note (the chat opens at its end; older ones may be out of the drawn window).
		const row = await waitFor(
			() =>
				p.evaluate(
					() =>
						[...document.querySelectorAll(".messages .rolemsg-row.rolemsg-board")]
							.at(-1)
							?.innerText.replace(/\s+/g, " ") ?? null,
				),
			30_000,
		);
		const raw = await p.evaluate(() => document.querySelector(".messages")?.innerText.includes("[Board] ") ?? true);
		check(
			"gamma's chat shows the board note as one folded row, not hidden in the turn and not unfolded",
			!!row && row.includes("From the board") && row.includes("1 post ended") && !raw,
			row ?? "",
		);
		await shot(p, "chat-notes-desktop-dark");
		await context.close();
	}
	{
		const { context, page: p } = await openPage({ width: 1280, height: 900 }, `/?chat=${encodeURIComponent(files.A)}`);
		const row = await waitFor(
			() =>
				p.evaluate(
					(id) =>
						document.querySelector(`.messages .rolemsg-row.rolemsg-board-order[data-role-message="${id}"]`)?.innerText,
					O1,
				),
			30_000,
		);
		check(
			"alpha's chat folds the direct order to one row: from owner, title and first words",
			!!row && row.includes("From owner") && row.includes("Pause new work: Finish what you have"),
			row ?? "",
		);
		await shot(p, "chat-order-desktop-dark");
		await context.close();
	}

	// =====================================================================================================
	// 7. Looks: dark and white, desktop and phone; axe; no sideways overflow.
	await page.click(".rv-board .rv-bbar .rv-act");
	await page.waitForSelector(".rv-board .rv-bform");
	await page.check('.rv-bform input[name="rv-bkind"][value="order"]');
	await page.check('.rv-bform input[name="rv-bto"] >> nth=1');
	await shot(page, "form-desktop-dark");
	const axeForm = await runAxe(page);
	check(
		"axe: nothing serious or critical with the form open",
		!axeForm.error && axeForm.bad.length === 0,
		axeForm.error ?? axeForm.bad.join("; "),
	);
	await desk.context.close();
	desk = null;

	for (const [name, size] of [
		["desktop-dark", { width: 1280, height: 900 }],
		["desktop-white", { width: 1280, height: 900, theme: "white" }],
		["phone-dark", { width: 390, height: 844, phone: true }],
		["phone-white", { width: 390, height: 844, phone: true, theme: "white" }],
	]) {
		const { context, page: p } = await openBoard(size);
		await p.waitForSelector(cardSel(N1));
		await p.click(".rv-board .rv-bclosedh button");
		await p.waitForSelector(cardSel(O1));
		await shot(p, `board-${name}`);
		const axe = await runAxe(p);
		check(
			`axe: nothing serious or critical on the Board view (${name})`,
			!axe.error && axe.bad.length === 0,
			axe.error ?? axe.bad.join("; "),
		);
		const over = await overflowX(p);
		check(`no sideways overflow (${name})`, over <= 1, `${over}px`);
		await context.close();
	}
	check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (err) {
	check("the run finished", false, (err && err.stack) || String(err));
	if (DEBUG) console.log(srv.stderr?.().slice(-4000));
} finally {
	for (const c of [w0, wB, wC]) c?.close();
	await desk?.context.close().catch(() => {});
	await browser.close().catch(() => {});
	await srv.stop();
}
console.log(failures === 0 ? "\nAll board checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
