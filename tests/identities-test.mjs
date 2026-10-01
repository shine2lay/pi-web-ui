/* identities E2E (no tokens): chat identities (pi-identity) in the page.
 *
 * The real pi-identity extension is loaded through settings.json `packages` (PI_IDENTITY_PKG, default
 * ~/projects/pi-identity). Its identities live in a temp folder (PI_IDENTITY_DIR): temper, RollCall and
 * ops/tooling. A mock OpenAI-compatible model answers every chat. Checks:
 *  - a blank chat offers the picker (None, then each identity), None picked;
 *  - picking temper runs pi-identity's `/identity temper` in that chat: the header and the chat's row show
 *    the temper tag, and the first message reaches the model with temper's about page;
 *  - the next new chat starts with None again (nothing remembered); RollCall picked there works the same;
 *  - the tags survive a reload, and the History rows of the saved chats show them too;
 *  - the chat menu (right-click a row -> Identity) sets ops/tooling, and None from the History row clears it;
 *  - Settings -> Identities lists the three with their notebook size against the cap; a notebook opens,
 *    an edit is saved to the file; a notebook over its cap can't be saved and the file stays as it was;
 *    about.md saves too; a home chat shows as a link by its title and opens that chat;
 *  - phone: "+" gives a blank chat with the picker; ops/tooling picked shows the header tag and the row tag;
 *    the header tag's menu clears it; Settings -> Identities is there too.
 * Never prints what goes to the model (rule 11): only whether each identity's about page was in it.
 * Usage: npm run build && node tests/identities-test.mjs
 *        (IDENT_SHOT=/tmp/ident saves screenshots /tmp/ident-desktop-picker.png, ...-phone-settings.png)
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { freeTcpPort } from "./lib/port-utils.mjs";
import { revealTopbarItem, SETTINGS_CHIP } from "./lib/topbar.mjs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
const base = mkdtempSync(join(tmpdir(), "piweb-identities-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
const idDir = join(base, "identities");
for (const d of [workdir, dataDir, agentDir, idDir]) mkdirSync(d, { recursive: true });

const NOTEBOOK_CAP = 8000;
/** Marks in each about page: the mock says whether a chat's requests carried them (and nothing else). */
const ABOUT_MARK = { temper: "temper-about-5f3a", rollcall: "rollcall-about-9c1e" };
const IDENTITIES = {
	temper: {
		json: { id: "temper", title: "temper", folder: workdir },
		about: `# temper\nYou work on the temper workflow engine (${ABOUT_MARK.temper}).\n`,
		notebook:
			"## Queue\n- #decision Tasks that share a touch run one after another.\n" +
			"- #lesson Check a run's gate before restarting the engine.\n",
	},
	rollcall: {
		json: { id: "rollcall", title: "RollCall" },
		about: `# RollCall\nYou work on the RollCall app (${ABOUT_MARK.rollcall}).\n`,
		notebook: "- #fact The roll call opens at nine.\n",
	},
	ops: {
		json: { id: "ops", title: "ops/tooling" },
		about: "# ops/tooling\nYou look after the tools and the server.\n",
		notebook: "",
	},
};
const identityFile = (id, name) => join(idDir, id, name);
function writeIdentityJson(id, extra = {}) {
	writeFileSync(identityFile(id, "identity.json"), JSON.stringify({ ...IDENTITIES[id].json, ...extra }, null, "\t"));
}
for (const [id, def] of Object.entries(IDENTITIES)) {
	mkdirSync(join(idDir, id));
	writeIdentityJson(id);
	writeFileSync(identityFile(id, "about.md"), def.about);
	writeFileSync(identityFile(id, "notebook.md"), def.notebook);
}

const MODEL_ID = "identities-mock";
/** The chats the test sends to, told apart by their prompt. */
const CHATS = {
	T: { prompt: "Tidy up the task queue", title: "Tidy the task queue", answer: "Done: the task queue is tidy." },
	R: {
		prompt: "Plan the roll call for Monday",
		title: "Monday roll call",
		answer: "Done: Monday's roll call is planned.",
	},
};

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
		await sleep(200);
	}
	return false;
}

// ---- mock provider ---------------------------------------------------------
const chunk = (model, delta, finish = null) => ({
	id: "identities-mock",
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
/** Which chat a request belongs to: the newest user message that starts with one of the prompts. */
function chatOf(history) {
	for (let i = history.length - 1; i >= 0; i--) {
		const x = history[i];
		if (x.role !== "user") continue;
		const text = typeof x.content === "string" ? x.content : (x.content ?? []).map((p) => p.text ?? "").join("");
		for (const [k, c] of Object.entries(CHATS)) if (text.startsWith(c.prompt)) return k;
	}
	return undefined;
}
/** Whether a chat's model requests carried an identity's about page: aboutSeen[chat][identity]. */
const aboutSeen = { T: {}, R: {} };
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
	const k = chatOf(history);
	// Side requests (the title) carry no tools.
	if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
		const text = JSON.stringify(history);
		const t = Object.values(CHATS).find((c) => text.includes(c.prompt))?.title ?? "Other chat";
		await sse(res, [chunk(m, { content: t }), chunk(m, {}, "stop")]);
		return;
	}
	if (k) {
		const text = JSON.stringify(history);
		for (const [id, mark] of Object.entries(ABOUT_MARK)) if (text.includes(mark)) aboutSeen[k][id] = true;
		if (process.env.IDENT_DEBUG)
			console.log(
				`  [mock] chat=${k} roles=${history.map((x) => x.role).join(",")} header=${text.includes("## Identity:")} sys=${JSON.stringify(payload.system ?? null).length}`,
			);
	}
	await sleep(300);
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
		// pi-identity and the server both read the identities from here; no memory reindex after a save.
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

// ---- browser ---------------------------------------------------------------
let browser;
const pageErrors = [];
const SHOT = process.env.IDENT_SHOT;
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
async function send(page, text) {
	const ta = page.locator(".inputbox textarea");
	await ta.fill(text);
	await ta.press("Enter");
}
const TITLE = { T: /Tidy up the task queue|Tidy the task queue/, R: /Plan the roll call|Monday roll call/ };
const runningRow = (page, k) => page.locator(".lp-section-convs .lp-row", { hasText: TITLE[k] }).first();
const historyRow = (page, k) => page.locator(".lp-section-sessions .lp-row", { hasText: TITLE[k] }).first();
/** The identity a row's tag shows: its id (data-identity) and text; null = no tag. Read in one go: a tag
 *  that goes away between two reads would make the second one wait for it. */
async function rowTag(row) {
	const tags = await row
		.locator(".identity-tag")
		.evaluateAll((els) => els.map((el) => ({ id: el.getAttribute("data-identity"), text: el.textContent?.trim() })));
	return tags[0] ?? null;
}
const headerTag = (page) => page.locator(".chat-header .identity-tag-btn");
async function headerTagId(page) {
	const ids = await headerTag(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-identity")));
	return ids[0] ?? null;
}
/** The picker's chips as shown: [data-identity, text, pressed]. */
async function chips(page) {
	return page
		.locator(".identity-picker .identity-chip")
		.evaluateAll((els) =>
			els.map((el) => [el.dataset.identity, el.textContent?.trim(), el.getAttribute("aria-checked")]),
		);
}
const pressedChip = async (page) => (await chips(page)).find((c) => c[2] === "true")?.[0] ?? null;
async function newChat(page) {
	await page.locator(".lp-new-chat-action").click();
	await waitFor(async () => (await page.locator(".messages .msg").count()) === 0, 10000);
	await page.locator(".inputbox textarea").waitFor({ timeout: 10000 });
}
/** Right-click a row, open "Identity" and pick `label` in its submenu. */
async function pickFromMenu(page, row, label) {
	await row.locator(".session-item").click({ button: "right" });
	const item = page.locator('.ctx-menu .ctx-menu-item[aria-label="Identity"]').first();
	await item.waitFor({ timeout: 5000 });
	await item.hover();
	const sub = page.locator(`.ctx-menu-sub .ctx-menu-item[aria-label="${label}"]`).first();
	if ((await sub.count()) === 0) await item.click();
	await sub.waitFor({ timeout: 5000 });
	await sub.click();
}
async function openSettingsPage(page) {
	await (await revealTopbarItem(page, SETTINGS_CHIP)).click();
	await page.locator(".settings-modal").waitFor({ timeout: 10000 });
	await page.locator('.settings-tab[data-tab="identities"]').click();
	await page.locator(".identities-settings").waitFor({ timeout: 10000 });
}
async function closeSettings(page) {
	await page.locator(".settings-modal .modal-close").first().click();
	await waitFor(async () => (await page.locator(".settings-modal").count()) === 0, 5000);
}
const settingsRow = (page, id) => page.locator(`.identity-row[data-identity="${id}"]`);
const editorText = (page) => page.locator(".identity-editor textarea.identity-editor-text");
const editorNote = (page) => page.locator(".identity-editor .identity-editor-note");
const bytes = (s) => Buffer.byteLength(s);
const fmt = (n) => n.toLocaleString("en-US");
/** The session file a chat was saved in (the chat's prompt is in it). */
function sessionFileOf(k) {
	const root = join(agentDir, "sessions");
	const files = [];
	const walk = (dir) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (e.isDirectory()) walk(join(dir, e.name));
			else if (e.name.endsWith(".jsonl")) files.push(join(dir, e.name));
		}
	};
	if (existsSync(root)) walk(root);
	return files.find((f) => readFileSync(f, "utf8").includes(CHATS[k].prompt));
}

try {
	await waitServer();
	browser = await chromium.launch({ executablePath: CHROME_PATH });

	console.log("desktop: a blank chat offers the picker");
	const W = await openWindow("identities-desktop");
	check(
		"the picker shows None and each identity, None picked",
		await waitFor(async () => (await chips(W)).length === 4, 15000),
		JSON.stringify(await chips(W)),
	);
	check(
		"...in order: None, then the identities by id, with their titles",
		JSON.stringify((await chips(W)).map((c) => [c[0], c[1]])) ===
			JSON.stringify([
				["none", "None"],
				["ops", "ops/tooling"],
				["rollcall", "RollCall"],
				["temper", "temper"],
			]),
	);
	check("None is picked in a new chat", (await pressedChip(W)) === "none", String(await pressedChip(W)));
	check("a chat with no identity has no header tag", (await headerTagId(W)) === null);

	console.log("desktop: start a chat as temper");
	await W.locator('.identity-picker .identity-chip[data-identity="temper"]').click();
	check(
		"the header shows the temper tag",
		await waitFor(async () => (await headerTagId(W)) === "temper", 10000),
		String(await headerTagId(W)),
	);
	check("the header tag shows the title", (await headerTag(W).first().textContent())?.includes("temper") === true);
	check("the temper chip is picked", (await pressedChip(W)) === "temper");
	await send(W, CHATS.T.prompt);
	check("the chat answered", await waitFor(async () => (await messagesText(W)).includes(CHATS.T.answer), 20000));
	check("the first message reached the model with temper's about page", aboutSeen.T.temper === true);
	check("...and not another identity's", !aboutSeen.T.rollcall);
	check(
		"the chat's row shows the temper tag",
		await waitFor(async () => (await rowTag(runningRow(W, "T")))?.id === "temper", 10000),
		JSON.stringify(await rowTag(runningRow(W, "T"))),
	);
	check("the row tag shows the title", (await rowTag(runningRow(W, "T")))?.text === "temper");

	console.log("desktop: the next new chat starts with None");
	await newChat(W);
	check(
		"the new chat's picker has None picked",
		await waitFor(async () => (await pressedChip(W)) === "none", 10000),
		String(await pressedChip(W)),
	);
	check("the new chat has no header tag", (await headerTagId(W)) === null);
	await W.locator('.identity-picker .identity-chip[data-identity="rollcall"]').click();
	check(
		"RollCall picked: the header shows its tag",
		await waitFor(async () => (await headerTagId(W)) === "rollcall", 10000),
	);
	await send(W, CHATS.R.prompt);
	check(
		"the RollCall chat answered",
		await waitFor(async () => (await messagesText(W)).includes(CHATS.R.answer), 20000),
	);
	check("it reached the model with RollCall's about page", aboutSeen.R.rollcall === true && !aboutSeen.R.temper);
	check(
		"its row shows the RollCall tag",
		await waitFor(async () => (await rowTag(runningRow(W, "R")))?.text === "RollCall", 10000),
	);
	check("the temper chat's row keeps its tag", (await rowTag(runningRow(W, "T")))?.id === "temper");
	await newChat(W);
	await waitFor(async () => (await pressedChip(W)) === "none", 10000);
	await shot(W, "desktop-picker");

	console.log("desktop: the tags survive a reload; History shows them");
	await runningRow(W, "T").locator(".session-item").click();
	await waitFor(async () => (await messagesText(W)).includes(CHATS.T.answer), 10000);
	await W.reload();
	await W.locator(".inputbox textarea").waitFor({ timeout: 20000 });
	check(
		"after a reload the header still shows temper",
		await waitFor(async () => (await headerTagId(W)) === "temper", 15000),
		String(await headerTagId(W)),
	);
	check(
		"after a reload the rows keep their tags",
		await waitFor(
			async () =>
				(await rowTag(runningRow(W, "T")))?.id === "temper" && (await rowTag(runningRow(W, "R")))?.id === "rollcall",
			10000,
		),
	);
	check(
		"History rows show the tags",
		await waitFor(
			async () =>
				(await rowTag(historyRow(W, "T")))?.id === "temper" && (await rowTag(historyRow(W, "R")))?.id === "rollcall",
			15000,
		),
		JSON.stringify([await rowTag(historyRow(W, "T")), await rowTag(historyRow(W, "R"))]),
	);
	await shot(W, "desktop-labels");

	console.log("desktop: the chat menu sets and clears");
	await pickFromMenu(W, runningRow(W, "T"), "ops/tooling");
	check(
		"Identity -> ops/tooling on a running row: its tag and the header change",
		await waitFor(
			async () => (await rowTag(runningRow(W, "T")))?.id === "ops" && (await headerTagId(W)) === "ops",
			10000,
		),
		JSON.stringify(await rowTag(runningRow(W, "T"))),
	);
	check(
		"...and its History row follows",
		await waitFor(async () => (await rowTag(historyRow(W, "T")))?.id === "ops", 15000),
		JSON.stringify(await rowTag(historyRow(W, "T"))),
	);
	await pickFromMenu(W, historyRow(W, "T"), "None");
	check(
		"Identity -> None on its History row clears it everywhere",
		await waitFor(
			async () =>
				(await rowTag(runningRow(W, "T"))) === null &&
				(await rowTag(historyRow(W, "T"))) === null &&
				(await headerTagId(W)) === null,
			15000,
		),
		JSON.stringify([await rowTag(runningRow(W, "T")), await rowTag(historyRow(W, "T")), await headerTagId(W)]),
	);
	check("the RollCall chat keeps its tag", (await rowTag(runningRow(W, "R")))?.id === "rollcall");

	console.log("desktop: Settings -> Identities");
	await openSettingsPage(W);
	check(
		"lists the three identities",
		await waitFor(async () => (await W.locator(".identity-row").count()) === 3, 10000),
		String(await W.locator(".identity-row").count()),
	);
	const temperSize = bytes(IDENTITIES.temper.notebook);
	const sizeText = () => settingsRow(W, "temper").locator(".identity-notebook-size").textContent();
	check(
		"temper's notebook size against the cap",
		(await sizeText())?.includes(`${fmt(temperSize)} / ${fmt(NOTEBOOK_CAP)}`) === true,
		String(await sizeText()),
	);
	check(
		"no home chat yet: says so",
		(await settingsRow(W, "rollcall").locator(".identity-home-link").count()) === 0 &&
			(await settingsRow(W, "rollcall").locator(".identity-muted").count()) === 1,
	);
	await settingsRow(W, "temper").locator('.identity-open-btn[data-file="notebook"]').click();
	check(
		"the notebook opens with the file's text",
		await waitFor(async () => (await editorText(W).inputValue()) === IDENTITIES.temper.notebook, 10000),
	);
	const edited = `${IDENTITIES.temper.notebook}- #lesson Settings saves the whole notebook at once.\n`;
	await editorText(W).fill(edited);
	check("an edit says it's unsaved", (await editorNote(W).textContent())?.includes("Unsaved") === true);
	await W.locator(".identity-editor .identity-save").click();
	check(
		"Save: the page says it's saved",
		await waitFor(async () => (await editorNote(W).textContent()) === "Saved.", 10000),
		String(await editorNote(W).textContent()),
	);
	check("...and the file has the edit", readFileSync(identityFile("temper", "notebook.md"), "utf8") === edited);
	check(
		"...written whole, no temp file left",
		JSON.stringify(readdirSync(join(idDir, "temper")).sort()) ===
			JSON.stringify(["about.md", "identity.json", "notebook.md"]),
	);
	check(
		"the list shows the new size",
		await waitFor(async () => (await sizeText())?.includes(`${fmt(bytes(edited))} / `) === true, 10000),
		String(await sizeText()),
	);
	await shot(W, "desktop-settings");
	await editorText(W).fill("x".repeat(NOTEBOOK_CAP + 1));
	check("over the cap: Save is off", await W.locator(".identity-editor .identity-save").isDisabled());
	check("...and the page says how much to cut", (await W.locator(".identity-editor-over").count()) === 1);
	await editorText(W).press("Control+s");
	await sleep(1000);
	check(
		"...Ctrl+S doesn't save it either: the file stays",
		readFileSync(identityFile("temper", "notebook.md"), "utf8") === edited,
	);
	await W.locator(".identity-editor .identity-reload").click();
	check(
		"Reload brings back the saved text",
		await waitFor(async () => (await editorText(W).inputValue()) === edited, 10000),
	);
	await settingsRow(W, "rollcall").locator('.identity-open-btn[data-file="about"]').click();
	check(
		"about.md opens with the file's text",
		await waitFor(async () => (await editorText(W).inputValue()) === IDENTITIES.rollcall.about, 10000),
	);
	const about = `${IDENTITIES.rollcall.about}Keep the roll call short.\n`;
	await editorText(W).fill(about);
	await W.locator(".identity-editor .identity-save").click();
	check(
		"about.md saves to the file",
		await waitFor(async () => readFileSync(identityFile("rollcall", "about.md"), "utf8") === about, 10000),
	);
	// A home chat: RollCall's home is the RollCall chat. Reopening the page reads identity.json again.
	const rollcallFile = sessionFileOf("R");
	check("the RollCall chat was saved", !!rollcallFile);
	if (rollcallFile) writeIdentityJson("rollcall", { homeChat: rollcallFile });
	await W.locator('.settings-tab:not([data-tab="identities"])').first().click();
	await W.locator('.settings-tab[data-tab="identities"]').click();
	const homeLink = settingsRow(W, "rollcall").locator(".identity-home-link");
	check(
		"the home chat shows as a link with the chat's title",
		await waitFor(async () => TITLE.R.test((await homeLink.textContent()) ?? ""), 10000),
		String(await homeLink.textContent().catch(() => null)),
	);
	await homeLink.click();
	check(
		"the link opens that chat and closes Settings",
		await waitFor(
			async () =>
				(await W.locator(".settings-modal").count()) === 0 && (await messagesText(W)).includes(CHATS.R.answer),
			10000,
		),
	);

	console.log("phone: new chat with the picker");
	const P = await openWindow("identities-phone", true);
	await (await revealTopbarItem(P, "button.chip.newchat:not(.ephemeral-chat-btn)")).click();
	check(
		"'+' gives a blank chat with the picker, None picked",
		await waitFor(async () => (await chips(P)).length === 4 && (await pressedChip(P)) === "none", 15000),
		JSON.stringify(await chips(P)),
	);
	await shot(P, "phone-picker");
	await P.locator('.identity-picker .identity-chip[data-identity="ops"]').tap();
	check(
		"ops/tooling picked: the header shows its tag",
		await waitFor(async () => (await headerTagId(P)) === "ops", 10000),
		String(await headerTagId(P)),
	);
	await shot(P, "phone-label");
	await P.locator('button.panel-toggle[aria-label="History"]').first().tap();
	check(
		"the chat list shows the tags on a phone too",
		await waitFor(async () => (await rowTag(runningRow(P, "R")))?.id === "rollcall", 10000),
		JSON.stringify(await rowTag(runningRow(P, "R"))),
	);
	await shot(P, "phone-list");
	// Close the drawer: its backdrop, off to the right of the panel (the panel's resize edge sits over the rest).
	await P.click(".drawer-backdrop", { position: { x: 380, y: 422 } });
	await waitFor(async () => (await P.locator(".drawer-backdrop").count()) === 0, 5000);
	await headerTag(P).first().tap();
	const none = P.locator('.ctx-menu .ctx-menu-item[aria-label="None"]').first();
	check("the header tag opens the identity menu", await waitFor(async () => (await none.count()) > 0, 5000));
	await none.tap();
	check(
		"None there clears it: no header tag, the picker has None",
		await waitFor(async () => (await headerTagId(P)) === null && (await pressedChip(P)) === "none", 10000),
	);
	await openSettingsPage(P);
	check(
		"Settings -> Identities on a phone lists the three",
		await waitFor(async () => (await P.locator(".identity-row").count()) === 3, 10000),
	);
	await shot(P, "phone-settings");
	await closeSettings(P);

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
	console.log(`\n${failures} check(s) failed. Server log tail:\n${serverLog.split("\n").slice(-30).join("\n")}`);
	process.exit(1);
}
console.log("\nall identities checks passed");
