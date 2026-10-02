/* identity-notebook-tab E2E (no tokens): the right panel's Notebook tab, and chats reading the current notebook.
 *
 * The real pi-identity extension is loaded through settings.json `packages` (PI_IDENTITY_PKG, default
 * ~/projects/pi-identity). Its identities live in a temp folder (PI_IDENTITY_DIR), its archive in a temp
 * memory folder (PI_MEMORY_DIR). A mock OpenAI-compatible model answers every chat. Checks:
 *  - a chat with no identity has no Notebook tab; picking temper brings it, showing temper's rules as raw
 *    text (identity-notes: the AI's own format, no markdown view) with their size against the rules' cap;
 *  - a change made outside the page (a rename-replace, like pi-identity's notebook tool) shows in the tab
 *    within seconds;
 *  - the chat's next reply gets the whole changed notebook once (its request carries the change, and the
 *    server log has pi-identity's line, without the notebook's text); the reply after that gets no second
 *    note;
 *  - Edit -> Save writes the file; the line it took out is in the archive; the server logs the save; the
 *    chat's next reply gets the edited notebook;
 *  - the notebook changing while you edit: the tab warns at once, Save doesn't overwrite, "Load the new
 *    version" loads it, "Save mine anyway" saves yours (the lines it drops are archived);
 *  - a notebook over the cap can't be saved; the About page link opens Settings -> Identities;
 *  - a new chat without an identity has no tab; back in the temper chat it's there again;
 *  - phone: the side panel drawer has the tab; a change shows live there too; Edit opens the editor.
 *  - identity-notes: the chat records a note through pi-identity's notebook tool; the tab's notes list, the
 *    index and the "sent" size (characters, estimated tokens) follow by themselves; search finds it and an
 *    old archive line (marked old, opens read-only); open shows it raw; Edit saves it (the old text goes
 *    to removed.md); Delete takes it out (to removed.md too) and the tab says so.
 * Never prints what goes to the model (rule 11): only how often a mark was in it.
 * Usage: npm run build && node tests/identity-notebook-test.mjs
 *        (NB_SHOT=/tmp/nb saves /tmp/nb-desktop-view.png, -desktop-edit, -desktop-conflict, -phone-view, -phone-edit)
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { freeTcpPort } from "./lib/port-utils.mjs";
import { revealTopbarItem } from "./lib/topbar.mjs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const PORT = await freeTcpPort();
const MOCK_PORT = await freeTcpPort();
const REPO = fileURLToPath(new URL("..", import.meta.url));
// The account's home (userInfo), not HOME: a sealed test run has a temp HOME.
const PI_IDENTITY = process.env.PI_IDENTITY_PKG ?? join(userInfo().homedir, "projects", "pi-identity");
if (!existsSync(join(PI_IDENTITY, "package.json"))) {
	console.log(`✗ FAIL: pi-identity not found at ${PI_IDENTITY} (set PI_IDENTITY_PKG)`);
	process.exit(1);
}
const base = mkdtempSync(join(tmpdir(), "piweb-notebook-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
const memDir = join(base, "memory");
const idDir = join(memDir, "identities");
for (const d of [workdir, dataDir, agentDir, idDir]) mkdirSync(d, { recursive: true });

const NOTEBOOK_CAP = 8000;
/** identity-notes: what the rules may hold: the cap minus the notes index's budget (2,000). */
const RULES_CAP = 6000;
const LESSON = "- #lesson Check a run's gate before restarting the engine.";
const START_NOTEBOOK = `## Queue\n- #decision Tasks that share a touch run **one after another**.\n${LESSON}\n`;
/** Marks put into the notebook along the way: the mock counts how often each reached the model. */
const MARK = {
	outside: "nb-outside-4b1d",
	edit: "nb-edit-91c0",
	conflict: "nb-conflict-3e77",
	conflict2: "nb-conflict-5a20",
	phone: "nb-phone-c4d8",
	note: "nb-note-7f31",
};
/** identity-notes: the note the mock model records through the notebook tool. */
const RECORD = {
	topic: "queue",
	summary: `Queue lanes default to 3 (${MARK.note})`,
	detail: "Set with /queue lanes <n>; shareable touches live in ~/.pi/agent/pi-queue.json.",
};
const ARCHIVE_LINE = "- #fact The ARCHIVEWORD line, from before the split into rules and notes.";
const IDENTITIES = {
	temper: {
		json: { id: "temper", title: "temper", folder: workdir },
		about: "# temper\nYou work on the temper workflow engine.\n",
		notebook: START_NOTEBOOK,
	},
	ops: {
		json: { id: "ops", title: "ops/tooling" },
		about: "# ops/tooling\nYou look after the tools and the server.\n",
		notebook: "",
	},
};
const notebookFile = (id) => join(idDir, id, "notebook.md");
// identity-notebook-tab: the lines a save takes out are kept in the role's own folder (private to it).
const archiveFile = (id) => join(idDir, id, "removed.md");
for (const [id, def] of Object.entries(IDENTITIES)) {
	mkdirSync(join(idDir, id));
	writeFileSync(join(idDir, id, "identity.json"), JSON.stringify(def.json, null, "\t"));
	writeFileSync(join(idDir, id, "about.md"), def.about);
	writeFileSync(notebookFile(id), def.notebook);
}
// identity-notes: an old archive (the weekly tidy-up's copy): searchable, marked old, read-only.
mkdirSync(join(idDir, "temper", "archive"));
writeFileSync(join(idDir, "temper", "archive", "notebook-2026-09-27.md"), `# old notebook\n${ARCHIVE_LINE}\n`);
const noteFile = (id, note) => join(idDir, id, "notes", `${note}.md`);
/** Change the notebook the way pi-identity's notebook tool does: a temp file, then rename. */
function replaceNotebook(id, text) {
	const tmp = `${notebookFile(id)}.tmp-test`;
	writeFileSync(tmp, text);
	renameSync(tmp, notebookFile(id));
}
const readNotebook = (id) => readFileSync(notebookFile(id), "utf8");

const MODEL_ID = "notebook-mock";
/** The prompts the test sends, all in the temper chat but told apart by their text. */
const CHATS = {
	T: { prompt: "Tidy up the task queue", title: "Tidy the task queue", answer: "Done: the task queue is tidy." },
	T2: { prompt: "Second round for the queue", answer: "Done: second round." },
	T3: { prompt: "Third round for the queue", answer: "Done: third round." },
	T4: { prompt: "Fourth round for the queue", answer: "Done: fourth round." },
	R: { prompt: "Record the queue finding", answer: "Recorded the finding." },
};
/** identity-notes: whether the record call's result said it was recorded (a yes/no, never its text). */
let recordOk = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`  ${ok ? "✓" : "✗ FAIL:"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};
async function waitFor(fn, ms) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await fn().catch(() => false)) return true;
		await sleep(150);
	}
	return false;
}

// ---- mock provider ---------------------------------------------------------
const chunk = (model, delta, finish = null) => ({
	id: "notebook-mock",
	object: "chat.completion.chunk",
	created: Math.floor(Date.now() / 1000),
	model,
	choices: [{ index: 0, delta, finish_reason: finish }],
});
async function sse(res, chunks) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
}
const userText = (x) =>
	typeof x.content === "string" ? x.content : (x.content ?? []).map((p) => p.text ?? "").join("");
/** Which prompt a request answers: the newest user message that starts with one of them (the notebook
 *  note, which comes after the prompt, starts with none). */
function promptOf(history) {
	for (let i = history.length - 1; i >= 0; i--) {
		const x = history[i];
		if (x.role !== "user") continue;
		const text = userText(x);
		for (const [k, c] of Object.entries(CHATS)) if (text.startsWith(c.prompt)) return k;
	}
	return undefined;
}
/** marks[prompt][mark] = how often the mark was in that prompt's request (the last one). */
const marks = {};
const mock = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${MOCK_PORT}`);
	if (url.pathname.endsWith("/models")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model" }] }));
		return;
	}
	if (!url.pathname.endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	for await (const c of req) body += c;
	const payload = JSON.parse(body || "{}");
	const m = payload.model;
	const history = payload.messages ?? [];
	// Side requests (the title) carry no tools.
	if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
		await sse(res, [chunk(m, { content: CHATS.T.title }), chunk(m, {}, "stop")]);
		return;
	}
	const k = promptOf(history);
	if (k) {
		const text = JSON.stringify(history);
		marks[k] = Object.fromEntries(Object.entries(MARK).map(([name, mark]) => [name, text.split(mark).length - 1]));
	}
	// identity-notes: the R chat calls the notebook tool to record a note, then answers.
	if (k === "R") {
		const last = history[history.length - 1];
		if (last?.role !== "tool") {
			const call = { index: 0, id: "call_record_1", type: "function" };
			call.function = { name: "notebook", arguments: JSON.stringify({ action: "record", ...RECORD }) };
			await sse(res, [chunk(m, { tool_calls: [call] }), chunk(m, {}, "tool_calls")]);
			return;
		}
		recordOk = /^Recorded n\d+ \[queue\]/.test(userText(last));
	}
	await sleep(200);
	await sse(res, [chunk(m, { content: k ? CHATS[k].answer : "Done." }), chunk(m, {}, "stop")]);
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "mock-key",
				models: [{ id: MODEL_ID, name: "Mock", input: ["text"], contextWindow: 200000, maxTokens: 4096 }],
			},
		},
	}),
);
writeFileSync(
	join(agentDir, "settings.json"),
	JSON.stringify({ defaultProvider: "mock", defaultModel: MODEL_ID, packages: [PI_IDENTITY] }),
);

// ---- server ----------------------------------------------------------------
const server = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
	cwd: REPO,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: workdir,
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_TOKEN: "",
		// pi-identity and the server read the identities from PI_IDENTITY_DIR; removed lines go to <id>/removed.md.
		PI_MEMORY_DIR: memDir,
		PI_IDENTITY_DIR: idDir,
		PI_IDENTITY_REINDEX: "0",
	},
	stdio: ["ignore", "pipe", "pipe"],
	detached: true,
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
process.on("exit", () => {
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
});
async function waitServer() {
	for (let i = 0; i < 150; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(200);
	}
	throw new Error("server did not start");
}
const outsideLogLines = () =>
	serverLog.split("\n").filter((l) => /\[pi-identity\] temper notebook changed outside this chat/.test(l));

// ---- browser ---------------------------------------------------------------
let browser;
const pageErrors = [];
const SHOT = process.env.NB_SHOT;
async function shot(page, name) {
	if (!SHOT) return;
	await sleep(300);
	await page.screenshot({ path: `${SHOT}-${name}.png` });
}
const messagesText = (page) => page.evaluate(() => document.querySelector(".messages")?.innerText ?? "");
async function openWindow(clientId, phone = false) {
	const ctx = await browser.newContext(
		phone
			? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
			: { viewport: { width: 1400, height: 900 } },
	);
	await ctx.addInitScript((id) => {
		localStorage.setItem("pi-web-client-id", id);
		localStorage.setItem("pi-web-ui:lang", "en");
	}, clientId);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => pageErrors.push(`${clientId}: ${e}`));
	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".topbar", { timeout: 60000 });
	await page.locator(".inputbox textarea").waitFor({ timeout: 20000 });
	return page;
}
async function send(page, k) {
	const ta = page.locator(".inputbox textarea");
	await ta.fill(CHATS[k].prompt);
	await ta.press("Enter");
	return waitFor(async () => (await messagesText(page)).includes(CHATS[k].answer), 20000);
}
async function newChat(page) {
	await page.locator(".lp-new-chat-action").click();
	await waitFor(async () => (await page.locator(".messages .msg").count()) === 0, 10000);
	await page.locator(".inputbox textarea").waitFor({ timeout: 10000 });
}
const headerTagId = async (page) =>
	(
		await page.locator(".chat-header .identity-tag-btn").evaluateAll((els) => els.map((el) => el.dataset.identity))
	)[0] ?? null;
const pressedChip = async (page) =>
	(
		await page
			.locator('.identity-picker .identity-chip[aria-checked="true"]')
			.evaluateAll((els) => els.map((el) => el.dataset.identity))
	)[0] ?? null;
/** The right panel's tab labels, as shown. */
const tabLabels = (page) =>
	page.locator(".panel-right .slot-tab").evaluateAll((els) => els.map((el) => el.textContent?.trim() ?? ""));
const notebookTab = (page) => page.locator(".panel-right .slot-tab", { hasText: "Notebook" }).first();
const panel = (page) => page.locator(".notebook-panel");
const panelStatus = async (page) =>
	(await panel(page)
		.getAttribute("data-status")
		.catch(() => null)) ?? null;
const viewText = (page) => page.locator(".notebook-rules").innerText();
const editor = (page) => page.locator("textarea.notebook-editor");
const fmt = (n) => n.toLocaleString("en-US");
const bytes = (s) => Buffer.byteLength(s);
async function openNotebookTab(page) {
	await notebookTab(page).click();
	await waitFor(async () => (await panelStatus(page)) === "ready", 10000);
}

try {
	await waitServer();
	browser = await chromium.launch({ executablePath: CHROME_PATH });

	console.log("desktop: the tab comes with an identity");
	const W = await openWindow("notebook-desktop");
	await waitFor(async () => (await pressedChip(W)) === "none", 15000);
	check(
		"a chat with no identity has no Notebook tab",
		!(await tabLabels(W)).includes("Notebook"),
		JSON.stringify(await tabLabels(W)),
	);
	await W.locator('.identity-picker .identity-chip[data-identity="temper"]').click();
	await waitFor(async () => (await headerTagId(W)) === "temper", 10000);
	check(
		"temper picked: the Notebook tab shows next to TL;DR and Queue",
		await waitFor(async () => (await tabLabels(W)).includes("Notebook"), 10000),
		JSON.stringify(await tabLabels(W)),
	);
	const boxes = await W.locator(".panel-right").evaluate((panelEl) => {
		const box = (el) => el.getBoundingClientRect().toJSON();
		return {
			panel: box(panelEl),
			button: panelEl.querySelector(".panel-collapse-btn") ? box(panelEl.querySelector(".panel-collapse-btn")) : null,
			tabs: [...panelEl.querySelectorAll(".slot-tabs-bar [role=tab]")].map(box),
		};
	});
	check(
		"at the default width every tab shows whole, none under the collapse button",
		boxes.tabs.length === 4 &&
			boxes.tabs.every(
				(b) =>
					b.left >= boxes.panel.left &&
					b.right <= boxes.panel.right &&
					!(boxes.button && b.right > boxes.button.left && b.top < boxes.button.bottom),
			),
		JSON.stringify(boxes.tabs.map((b) => [Math.round(b.left), Math.round(b.right), Math.round(b.top)])),
	);
	check("the chat answered", await send(W, "T"));
	await openNotebookTab(W);
	check("the tab shows the notebook", (await panelStatus(W)) === "ready", String(await panelStatus(W)));
	check(
		"...as raw text, the way the AI writes it (no markdown view)",
		(await viewText(W)).includes("## Queue") &&
			(await viewText(W)).includes("**one after another**") &&
			(await W.locator(".notebook-panel h2").count()) === 0,
	);
	const sizeText = async () => (await W.locator(".notebook-size").textContent())?.trim() ?? "";
	check(
		"...with their size against the rules' cap (the notebook's minus the index's)",
		(await sizeText()) === `${fmt(bytes(START_NOTEBOOK))} / ${fmt(RULES_CAP)}`,
		await sizeText(),
	);
	const sentOf = async (page) => ({
		sent: Number(await page.locator(".notebook-sent").getAttribute("data-sent")),
		tokens: Number(await page.locator(".notebook-sent").getAttribute("data-tokens")),
	});
	check(
		"...and what's sent with every message, in characters and estimated tokens",
		JSON.stringify(await sentOf(W)) ===
			JSON.stringify({ sent: bytes(START_NOTEBOOK), tokens: Math.round(bytes(START_NOTEBOOK) / 3.6) }),
		JSON.stringify(await sentOf(W)),
	);
	await shot(W, "desktop-view");

	console.log("desktop: a change made elsewhere shows within seconds");
	const outsideText = `${START_NOTEBOOK}- #fact The gate opens at noon (${MARK.outside}).\n`;
	const t0 = Date.now();
	replaceNotebook("temper", outsideText);
	const appeared = await waitFor(async () => (await viewText(W)).includes("The gate opens at noon"), 8000);
	const took = Date.now() - t0;
	check("the tab shows the change by itself", appeared);
	check("...within a few seconds", appeared && took < 5000, `${took} ms`);
	check(
		"...and the new size",
		(await sizeText()) === `${fmt(bytes(outsideText))} / ${fmt(RULES_CAP)}`,
		await sizeText(),
	);

	console.log("desktop: the chat's next reply gets the changed notebook, once");
	check("the chat answered again", await send(W, "T2"));
	check(
		"its request carried the change (the whole notebook, one note)",
		marks.T2?.outside === 1,
		JSON.stringify(marks.T2),
	);
	check("the server log says so, once", outsideLogLines().length === 1, String(outsideLogLines().length));
	check(
		"...without the notebook's text",
		outsideLogLines().every((l) => !l.includes(MARK.outside) && !l.includes("gate opens")),
	);
	check(
		"the next reply gets no second note",
		(await send(W, "T3")) && marks.T3?.outside === 1,
		JSON.stringify(marks.T3),
	);
	check("...and no second log line", outsideLogLines().length === 1, String(outsideLogLines().length));

	console.log("desktop: edit and save in the tab");
	await W.locator(".notebook-edit").click();
	check("Edit opens the editor with the notebook", (await editor(W).inputValue()) === outsideText);
	const edited = outsideText.replace(`${LESSON}\n`, "") + `- #fact Edited in the tab (${MARK.edit}).\n`;
	await editor(W).fill(edited);
	await shot(W, "desktop-edit");
	await W.locator(".notebook-save").click();
	check(
		"Save writes the file and goes back to the view",
		await waitFor(async () => readNotebook("temper") === edited && (await panelStatus(W)) === "ready", 10000),
		String(await panelStatus(W)),
	);
	check("the view shows the edit", (await viewText(W)).includes("Edited in the tab"));
	check(
		"it says Saved.",
		await waitFor(
			async () => ((await W.locator(".notebook-actions .notebook-note").first().textContent()) ?? "").includes("Saved"),
			3000,
		),
	);
	check(
		"the line it took out is in the role's removed.md",
		existsSync(archiveFile("temper")) && readFileSync(archiveFile("temper"), "utf8").includes(LESSON),
	);
	check(
		"the server logged the save",
		/\[identities\] the owner saved the temper notebook: \d+ characters, 1 removed or changed line archived/.test(
			serverLog,
		),
	);
	check(
		"the chat's next reply gets the edited notebook",
		(await send(W, "T4")) && marks.T4?.edit === 1,
		JSON.stringify(marks.T4),
	);

	console.log("desktop: the notebook changes while you edit");
	await W.locator(".notebook-edit").click();
	const mine = `${edited}- #fact My draft line.\n`;
	await editor(W).fill(mine);
	const theirs = `${edited}- #fact A chat wrote this meanwhile (${MARK.conflict}).\n`;
	replaceNotebook("temper", theirs);
	check(
		"the tab warns at once",
		await waitFor(async () => (await W.locator(".notebook-conflict").count()) === 1, 8000),
	);
	check("...and keeps the draft", (await editor(W).inputValue()) === mine);
	await W.locator(".notebook-save").click();
	check(
		"Save doesn't overwrite: it offers to load the new version or save yours",
		await waitFor(
			async () =>
				(await W.locator(".notebook-load-new").count()) === 1 && (await W.locator(".notebook-save-mine").count()) === 1,
			5000,
		),
	);
	check("...and says why", ((await W.locator(".notebook-conflict").textContent()) ?? "").includes("Not saved"));
	await sleep(500);
	check("the file keeps the chat's change", readNotebook("temper") === theirs);
	await shot(W, "desktop-conflict");
	await W.locator(".notebook-load-new").click();
	check(
		"Load the new version puts it in the editor, the warning gone",
		(await editor(W).inputValue()) === theirs && (await W.locator(".notebook-conflict").count()) === 0,
	);
	await W.locator(".notebook-cancel").click();
	await waitFor(async () => (await panelStatus(W)) === "ready", 5000);

	await W.locator(".notebook-edit").click();
	const mine2 = `${edited}- #fact My second draft.\n`;
	await editor(W).fill(mine2);
	const theirs2 = `${theirs}- #fact Another chat line (${MARK.conflict2}).\n`;
	replaceNotebook("temper", theirs2);
	await waitFor(async () => (await W.locator(".notebook-conflict").count()) === 1, 8000);
	await W.locator(".notebook-save").click();
	await W.locator(".notebook-save-mine").waitFor({ timeout: 5000 });
	await W.locator(".notebook-save-mine").click();
	check(
		"Save mine anyway saves your version",
		await waitFor(async () => readNotebook("temper") === mine2 && (await panelStatus(W)) === "ready", 10000),
	);
	check(
		"...and the chat lines it dropped are in the archive",
		readFileSync(archiveFile("temper"), "utf8").includes(MARK.conflict2) &&
			readFileSync(archiveFile("temper"), "utf8").includes(MARK.conflict),
	);

	console.log("desktop: over the cap");
	await W.locator(".notebook-edit").click();
	await editor(W).fill("x".repeat(RULES_CAP + 1));
	check(
		"rules over their cap can't be saved, and the tab says so",
		(await W.locator(".notebook-save").isDisabled()) &&
			(await W.locator(".notebook-over").count()) === 1 &&
			(await W.locator(".notebook-size.over").count()) === 1,
	);
	await W.locator(".notebook-cancel").click();
	check("the file stays as it was", readNotebook("temper") === mine2);

	console.log("desktop: the About page link");
	await W.locator(".notebook-about-link").click();
	check(
		"it opens Settings -> Identities",
		await waitFor(async () => (await W.locator(".identities-settings").count()) === 1, 10000),
	);
	await W.locator(".settings-modal .modal-close").first().click();
	await waitFor(async () => (await W.locator(".settings-modal").count()) === 0, 5000);

	console.log("desktop: identity-notes, the role's notes");
	await openNotebookTab(W);
	const rows = () => W.locator(".notebook-notes .notebook-note-row");
	const rowRefs = () => rows().evaluateAll((els) => els.map((el) => el.dataset.ref));
	check(
		"no notes yet: the tab says so",
		await waitFor(async () => (await W.locator(".notebook-notes-none").count()) === 1, 5000),
	);
	check("the chat records a note with the notebook tool", await send(W, "R"));
	check("...and the tool said it was recorded", recordOk === true, String(recordOk));
	check("...as a file in the role's notes folder", existsSync(noteFile("temper", "n1")));
	check(
		"the notes list shows it by itself",
		await waitFor(async () => JSON.stringify(await rowRefs()) === '["n1"]', 8000),
		JSON.stringify(await rowRefs().catch(() => [])),
	);
	const indexText = async () =>
		(await W.locator(".notebook-index")
			.textContent()
			.catch(() => "")) ?? "";
	check(
		"...and the index has its line, under its topic",
		await waitFor(async () => (await indexText()) === `[queue]\nn1 ${RECORD.summary}`, 5000),
	);
	const rulesNow = bytes(readNotebook("temper"));
	const expectSent = rulesNow + bytes(`[queue]\nn1 ${RECORD.summary}`);
	check(
		"...and what's sent grows by the index line (characters and tokens)",
		JSON.stringify(await sentOf(W)) === JSON.stringify({ sent: expectSent, tokens: Math.round(expectSent / 3.6) }),
		JSON.stringify(await sentOf(W)),
	);

	/** The list's answer for query q, once it's in: the rows' refs. */
	const searched = async (q) => {
		const list = W.locator(`ul.notebook-notes[data-query="${q}"][data-status="ready"]`);
		return (await list.count()) === 1 ? rowRefs() : null;
	};
	const search = async (q) => {
		await W.locator(".notebook-search-input").fill(q);
		await W.locator(".notebook-search-btn").click();
	};
	await search("lanes");
	check(
		"search finds it by a word of its summary",
		await waitFor(async () => JSON.stringify(await searched("lanes")) === '["n1"]', 5000),
		JSON.stringify(await searched("lanes")),
	);
	await search("ARCHIVEWORD");
	const archiveRef = "archive/notebook-2026-09-27.md:2";
	check(
		"...and an old archive line, marked old",
		await waitFor(
			async () =>
				JSON.stringify(await searched("ARCHIVEWORD")) === JSON.stringify([archiveRef]) &&
				((await rows().first().textContent()) ?? "").includes("(old)"),
			5000,
		),
		JSON.stringify(await searched("ARCHIVEWORD")),
	);
	await rows().first().click();
	check(
		"the archive line opens read-only",
		(await waitFor(async () => (await W.locator(`.notebook-open[data-ref="${archiveRef}"]`).count()) === 1, 5000)) &&
			((await W.locator(".notebook-note-text").textContent()) ?? "").includes("ARCHIVEWORD") &&
			(await W.locator(".notebook-note-edit").count()) === 0 &&
			(await W.locator(".notebook-note-delete").count()) === 0,
	);
	await W.locator(".notebook-note-close").click();
	await W.locator(".notebook-search-all").click();
	await waitFor(async () => JSON.stringify(await rowRefs()) === '["n1"]', 5000);
	await rows().first().click();
	check(
		"the note opens whole, as raw text",
		(await waitFor(async () => (await W.locator('.notebook-open[data-ref="n1"]').count()) === 1, 5000)) &&
			((await W.locator(".notebook-note-text").textContent()) ?? "") === readFileSync(noteFile("temper", "n1"), "utf8"),
	);
	await W.locator(".notebook-note-edit").click();
	const noteEditor = W.locator("textarea.notebook-note-editor");
	const before = await noteEditor.inputValue();
	const NEW_SUMMARY = `Queue lanes: 3 by default, /queue lanes <n> (${MARK.note})`;
	await noteEditor.fill(before.replace(`summary: ${RECORD.summary}`, `summary: ${NEW_SUMMARY}`));
	await W.locator(".notebook-note-save").click();
	check(
		"Edit -> Save writes the note",
		await waitFor(async () => readFileSync(noteFile("temper", "n1"), "utf8").includes(`summary: ${NEW_SUMMARY}`), 5000),
	);
	check(
		"...keeps the old text in removed.md",
		existsSync(archiveFile("temper")) &&
			readFileSync(archiveFile("temper"), "utf8").includes("note n1 replaced by the owner (pi-web-ui)") &&
			readFileSync(archiveFile("temper"), "utf8").includes(`summary: ${RECORD.summary}`),
	);
	check(
		"...and the index follows",
		await waitFor(async () => (await indexText()) === `[queue]\nn1 ${NEW_SUMMARY}`, 5000),
	);
	await shot(W, "desktop-notes");
	await waitFor(async () => (await W.locator(".notebook-note-delete").count()) === 1, 5000);
	await W.locator(".notebook-note-delete").click();
	await W.locator(".notebook-note-delete-yes").click();
	check("Delete takes the note out", await waitFor(async () => !existsSync(noteFile("temper", "n1")), 5000));
	check(
		"...into removed.md",
		readFileSync(archiveFile("temper"), "utf8").includes("note n1 deleted by the owner (pi-web-ui)"),
	);
	check(
		"...and the tab says so; the list and the index are empty again",
		(await waitFor(
			async () =>
				(
					(await W.locator(".notebook-note-deleted")
						.textContent()
						.catch(() => "")) ?? ""
				).includes("n1 deleted"),
			5000,
		)) &&
			(await waitFor(async () => (await W.locator(".notebook-notes-none").count()) === 1, 5000)) &&
			(await waitFor(async () => (await W.locator(".notebook-index").count()) === 0, 5000)),
	);

	console.log("desktop: a chat without an identity");
	await newChat(W);
	await waitFor(async () => (await pressedChip(W)) === "none", 10000);
	check(
		"a new chat with None has no Notebook tab",
		await waitFor(async () => !(await tabLabels(W)).includes("Notebook"), 5000),
		JSON.stringify(await tabLabels(W)),
	);
	await W.locator(".lp-section-convs .lp-row", { hasText: /Tidy/ }).first().locator(".session-item").click();
	await waitFor(async () => (await messagesText(W)).includes(CHATS.T4.answer), 10000);
	check(
		"back in the temper chat the tab is there again",
		await waitFor(async () => (await tabLabels(W)).includes("Notebook"), 10000),
	);
	await openNotebookTab(W);
	check("...showing the saved notebook", (await viewText(W)).includes("My second draft"));

	console.log("phone: the side panel drawer");
	const P = await openWindow("notebook-phone", true);
	await P.locator('button.panel-toggle[aria-label="History"]').first().tap();
	const row = P.locator(".lp-section-convs .lp-row", { hasText: /Tidy/ }).first();
	await row.waitFor({ timeout: 10000 });
	await row.locator(".session-item").tap();
	await waitFor(async () => (await messagesText(P)).includes(CHATS.T4.answer), 10000);
	// Close the history drawer if it stayed open: its backdrop, off to the right of the panel.
	if ((await P.locator(".drawer-backdrop").count()) > 0) {
		await P.click(".drawer-backdrop", { position: { x: 380, y: 422 } });
		await waitFor(async () => (await P.locator(".drawer-backdrop").count()) === 0, 5000);
	}
	await (await revealTopbarItem(P, "button.panel-toggle.has-label")).click();
	await P.waitForSelector(".drawer-right.open", { timeout: 5000 });
	await P.locator(".drawer-right .slot-tab", { hasText: "Notebook" }).first().tap();
	check(
		"the drawer has the Notebook tab with the notebook",
		(await waitFor(async () => (await panelStatus(P)) === "ready", 10000)) &&
			(await viewText(P)).includes("My second draft"),
	);
	replaceNotebook("temper", `${mine2}- #fact Seen on the phone (${MARK.phone}).\n`);
	check(
		"a change shows there live too",
		await waitFor(async () => (await viewText(P)).includes("Seen on the phone"), 8000),
	);
	check(
		"...and in the desktop window",
		await waitFor(async () => (await viewText(W)).includes("Seen on the phone"), 8000),
	);
	await shot(P, "phone-view");
	await P.locator(".notebook-edit").tap();
	check("Edit opens the editor on a phone", (await editor(P).count()) === 1 && (await editor(P).isVisible()));
	await shot(P, "phone-edit");
	await P.locator(".notebook-cancel").tap();

	check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (e) {
	failures++;
	console.log(`  ✗ FAIL: ${e?.stack ?? e}`);
} finally {
	await browser?.close();
	mock.close();
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
}

if (failures) {
	// The log tail, without pi-identity's own lines' details: they hold no notebook text anyway.
	console.log(`\n${failures} check(s) failed. Server log tail:\n${serverLog.split("\n").slice(-30).join("\n")}`);
	process.exit(1);
}
console.log("\nall identity-notebook checks passed");
