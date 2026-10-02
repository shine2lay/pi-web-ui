/* identity-config E2E (no tokens): a role's settings, prompt, skills and waiting drafts in
 * Settings -> Identities.
 *
 * Two roles in a temp identities folder (PI_IDENTITY_DIR): alpha (a prompt, one skill of its own) and
 * beta (a broken "tools" field). Drafts wait for both in role-drafts/ next to it; a shared role skill sits
 * in the agent folder's role-skills/. No model is asked anything. Checks:
 *  - each row shows its prompt, skills and tool limits; beta's broken part is listed, the rest works;
 *    "Draft waiting" shows on both rows and in the header;
 *  - alpha's settings editor refuses settings pi-identity wouldn't read (each reason listed, the file
 *    unchanged, the server log says so); good settings save, and the row shows the new limits;
 *  - alpha's draft opens with its prompt, settings and reasons; accepting it with an edited prompt
 *    writes the prompt (the old one kept in archive/) and merges the settings into identity.json; the
 *    draft moves to role-drafts/.old/; the row shows the new limits and skills;
 *  - beta's draft is refused (its settings are wrong: reasons listed, nothing written), then discarded.
 * Usage: npm run build && node tests/identity-config-test.mjs   (ROLECFG_SHOT=/tmp/rc saves screenshots)
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { freeTcpPort } from "./lib/port-utils.mjs";
import { revealTopbarItem, SETTINGS_CHIP } from "./lib/topbar.mjs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const PORT = await freeTcpPort();
const MOCK_PORT = await freeTcpPort();
const REPO = fileURLToPath(new URL("..", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "piweb-rolecfg-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
const memDir = join(base, "memory");
const idDir = join(memDir, "identities");
const draftsRoot = join(memDir, "role-drafts");
for (const d of [workdir, dataDir, agentDir, idDir, draftsRoot]) mkdirSync(d, { recursive: true });

const write = (path, text) => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
};
const read = (path) => readFileSync(path, "utf8");
const hashOf = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const roleFile = (id, name) => join(idDir, id, name);

// ---- the roles, their drafts and a shared skill ----------------------------
const ALPHA_PROMPT = "You are alpha. Work in small, checked steps.\n";
write(roleFile("alpha", "identity.json"), `${JSON.stringify({ id: "alpha", title: "Alpha" }, null, "\t")}\n`);
write(roleFile("alpha", "about.md"), "# Alpha\nLooks after the alpha things.\n");
write(roleFile("alpha", "notebook.md"), "- #fact Alpha keeps one line.\n");
write(roleFile("alpha", "prompt.md"), ALPHA_PROMPT);
write(
	roleFile("alpha", join("skills", "own-skill", "SKILL.md")),
	"---\nname: own-skill\ndescription: How alpha checks its own work.\n---\n# own-skill\nCheck it twice.\n",
);
const BETA_JSON = `${JSON.stringify({ id: "beta", title: "Beta", tools: { deny: "bash" } }, null, "\t")}\n`;
write(roleFile("beta", "identity.json"), BETA_JSON);
write(roleFile("beta", "about.md"), "# Beta\nLooks after the beta things.\n");
write(roleFile("beta", "notebook.md"), "");

write(
	join(agentDir, "role-skills", "team-skill", "SKILL.md"),
	"---\nname: team-skill\ndescription: How every role runs a round.\n---\n# team-skill\nPlan, do, check.\n",
);

const DRAFT_PROMPT = "You are alpha, drafted. Say what you checked and how.\n";
const DRAFT_CONFIG = `${JSON.stringify({ tools: { deny: ["subagents", "browser"] }, skills: { shared: ["team-skill"] } }, null, "\t")}\n`;
write(join(draftsRoot, "alpha", "prompt.md"), DRAFT_PROMPT);
write(join(draftsRoot, "alpha", "config.json"), DRAFT_CONFIG);
write(join(draftsRoot, "alpha", "notes.md"), "No subagents: alpha's work is small.\n");
write(join(draftsRoot, "beta", "prompt.md"), "You are beta.\n");
write(join(draftsRoot, "beta", "config.json"), `${JSON.stringify({ skills: { own: "yes" } })}\n`);

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

// ---- a mock model (never asked here; the server only needs one to start) ----
const MODEL_ID = "rolecfg-mock";
const mock = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${MOCK_PORT}`);
	if (url.pathname.endsWith("/models")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model" }] }));
		return;
	}
	res.writeHead(404).end();
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
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "mock", defaultModel: MODEL_ID }));

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
const SHOT = process.env.ROLECFG_SHOT;
async function shot(page, name) {
	if (!SHOT) return;
	await sleep(300);
	await page.screenshot({ path: `${SHOT}-${name}.png`, fullPage: true });
}
async function openWindow(clientId) {
	const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
	await ctx.addInitScript((id) => {
		localStorage.setItem("pi-web-client-id", id);
		localStorage.setItem("pi-web-ui:lang", "en");
	}, clientId);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => pageErrors.push(`${clientId}: ${e}`));
	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".topbar", { timeout: 60000 });
	return page;
}
async function openSettingsPage(page) {
	await (await revealTopbarItem(page, SETTINGS_CHIP)).click();
	await page.locator(".settings-modal").waitFor({ timeout: 10000 });
	await page.locator('.settings-tab[data-tab="identities"]').click();
	await page.locator(".identities-settings").waitFor({ timeout: 10000 });
}
const row = (page, id) => page.locator(`.identity-row[data-identity="${id}"]`);
const textOf = async (loc) => ((await loc.count()) ? ((await loc.first().textContent()) ?? "") : "");
const editorText = (page) => page.locator(".identity-editor textarea.identity-editor-text");
const editorNote = (page) => page.locator(".identity-editor .identity-editor-note");
const draftBox = (page, id) => page.locator(`.identity-draft[data-identity="${id}"]`);
const draftNote = (page, id) => draftBox(page, id).locator(".identity-draft-note");
const problemsOf = async (loc) => (await loc.allTextContents()).map((s) => s.trim());
const oldDrafts = () => (existsSync(join(draftsRoot, ".old")) ? readdirSync(join(draftsRoot, ".old")) : []);

try {
	await waitServer();
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const W = await openWindow("rolecfg-desktop");
	await openSettingsPage(W);

	console.log("the rows: prompt, skills, tool limits, problems, drafts");
	check(
		"lists both roles",
		await waitFor(async () => (await W.locator(".identity-row").count()) === 2, 10000),
		String(await W.locator(".identity-row").count()),
	);
	check(
		"alpha's prompt and its size",
		(await textOf(row(W, "alpha").locator(".identity-role-prompt"))).includes(
			`prompt.md, ${Buffer.byteLength(ALPHA_PROMPT)} bytes`,
		),
		await textOf(row(W, "alpha").locator(".identity-role-prompt")),
	);
	check(
		"alpha's own skill is listed",
		(await row(W, "alpha").locator(".identity-role-skill").allTextContents()).some((s) => s.includes("own-skill")),
	);
	check(
		"alpha has no tool limits yet",
		(await textOf(row(W, "alpha").locator(".identity-role-tools"))).endsWith(": none"),
		await textOf(row(W, "alpha").locator(".identity-role-tools")),
	);
	const betaProblems = await problemsOf(row(W, "beta").locator(".identity-config-problems li"));
	check(
		"beta's broken tool limits are listed",
		betaProblems.some((p) => p.includes('"tools.deny" must be a list of tool names')),
		betaProblems.join(" | "),
	);
	check(
		"...and left out: beta runs without limits",
		(await textOf(row(W, "beta").locator(".identity-role-tools"))).endsWith(": none"),
	);
	check(
		"the server log names beta's broken part",
		await waitFor(async () => serverLog.includes("[identities] beta's settings:"), 5000),
	);
	check(
		"both rows say a draft is waiting",
		(await row(W, "alpha").locator(".identity-draft-badge").count()) === 1 &&
			(await row(W, "beta").locator(".identity-draft-badge").count()) === 1,
	);
	check(
		"the header counts two drafts",
		(await W.locator('.identity-drafts-count[data-count="2"]').count()) === 1,
		await textOf(W.locator(".identity-drafts-count")),
	);
	await shot(W, "rows");

	console.log("alpha's settings: a bad config is refused, a good one saves");
	const alphaJson = roleFile("alpha", "identity.json");
	const hashBefore = hashOf(alphaJson);
	await row(W, "alpha").locator('.identity-open-btn[data-file="config"]').click();
	check(
		"the settings editor opens with identity.json",
		await waitFor(async () => (await editorText(W).inputValue()) === read(alphaJson), 10000),
	);
	const bad = `${JSON.stringify({ id: "alpha", title: "Alpha", tools: { deny: "bash" }, colour: "red" }, null, "\t")}\n`;
	await editorText(W).fill(bad);
	await W.locator(".identity-editor .identity-save").click();
	check(
		"refused: the page says so",
		await waitFor(
			async () => (await editorNote(W).textContent()) === "Not saved: pi-identity would refuse these settings.",
			10000,
		),
		String(await editorNote(W).textContent()),
	);
	const refused = await problemsOf(W.locator(".identity-editor .identity-editor-problems li"));
	check(
		"...with each reason",
		refused.some((p) => p.includes('unknown field "colour"')) &&
			refused.some((p) => p.includes('"tools.deny" must be a list of tool names')),
		refused.join(" | "),
	);
	check("...and identity.json is unchanged", hashOf(alphaJson) === hashBefore);
	check("...and the server log says so", serverLog.includes("[identities] refused the owner's alpha settings:"));
	const good = `${JSON.stringify({ id: "alpha", title: "Alpha", tools: { deny: ["web"] } }, null, "\t")}\n`;
	await editorText(W).fill(good);
	await W.locator(".identity-editor .identity-save").click();
	check(
		"good settings save",
		await waitFor(async () => (await editorNote(W).textContent()) === "Saved.", 10000),
		String(await editorNote(W).textContent()),
	);
	check("...into identity.json", read(alphaJson) === good);
	check(
		"...and the row shows the new limits",
		await waitFor(
			async () => (await textOf(row(W, "alpha").locator(".identity-role-tools"))).endsWith(": deny web"),
			10000,
		),
		await textOf(row(W, "alpha").locator(".identity-role-tools")),
	);
	await W.locator(".identity-editor .identity-close").click();

	console.log("alpha's draft: view, edit, accept");
	await row(W, "alpha").locator(".identity-draft-btn").click();
	check(
		"the draft opens with its prompt",
		await waitFor(
			async () => (await draftBox(W, "alpha").locator(".identity-draft-prompt").inputValue()) === DRAFT_PROMPT,
			10000,
		),
	);
	check(
		"...its settings",
		(await draftBox(W, "alpha").locator(".identity-draft-config").inputValue()) === DRAFT_CONFIG,
	);
	check("...and why", (await textOf(draftBox(W, "alpha").locator(".identity-draft-notes"))).includes("No subagents"));
	await shot(W, "draft");
	const editedPrompt = `${DRAFT_PROMPT}Edited by the owner.\n`;
	await draftBox(W, "alpha").locator(".identity-draft-prompt").fill(editedPrompt);
	await draftBox(W, "alpha").locator(".identity-draft-accept").click();
	check(
		"accepted: the page says so",
		await waitFor(
			async () =>
				(await draftNote(W, "alpha").textContent()) === "Accepted: the role's chats use it from their next start.",
			10000,
		),
		String(await draftNote(W, "alpha").textContent()),
	);
	check("the edited prompt is the role's prompt now", read(roleFile("alpha", "prompt.md")) === editedPrompt);
	const archived = existsSync(join(idDir, "alpha", "archive")) ? readdirSync(join(idDir, "alpha", "archive")) : [];
	check(
		"...the old one is kept in archive/",
		archived.length === 1 && read(join(idDir, "alpha", "archive", archived[0])) === ALPHA_PROMPT,
		archived.join(", "),
	);
	const merged = JSON.parse(read(alphaJson));
	check(
		"the suggested settings are merged into identity.json",
		merged.id === "alpha" &&
			merged.title === "Alpha" &&
			JSON.stringify(merged.tools) === JSON.stringify({ deny: ["subagents", "browser"] }) &&
			JSON.stringify(merged.skills) === JSON.stringify({ shared: ["team-skill"] }),
		JSON.stringify(merged),
	);
	check(
		"the draft moved to role-drafts/.old/",
		!existsSync(join(draftsRoot, "alpha")) &&
			oldDrafts().some((n) => n.startsWith("alpha-") && n.endsWith("-accepted")),
		oldDrafts().join(", "),
	);
	check(
		"the row shows the new limits",
		await waitFor(
			async () => (await textOf(row(W, "alpha").locator(".identity-role-tools"))).endsWith(": deny subagents, browser"),
			10000,
		),
		await textOf(row(W, "alpha").locator(".identity-role-tools")),
	);
	const skills = await row(W, "alpha").locator(".identity-role-skill").allTextContents();
	check(
		"...its own and the shared skill",
		skills.some((s) => s.includes("own-skill")) && skills.some((s) => s.includes("team-skill (shared)")),
		skills.join(" | "),
	);
	check("...and no draft waiting", (await row(W, "alpha").locator(".identity-draft-badge").count()) === 0);
	check(
		"the server log says what was accepted",
		serverLog.includes("[identities] the owner accepted the draft for alpha: its prompt into prompt.md;") &&
			serverLog.includes("into identity.json"),
	);
	await draftBox(W, "alpha").locator(".identity-close").click();

	console.log("beta's draft: refused, then discarded");
	await row(W, "beta").locator(".identity-draft-btn").click();
	await draftBox(W, "beta").locator(".identity-draft-prompt").waitFor({ timeout: 10000 });
	await draftBox(W, "beta").locator(".identity-draft-accept").click();
	check(
		"accept refused: the page says so",
		await waitFor(
			async () => (await draftNote(W, "beta").textContent()) === "Not saved: pi-identity would refuse these settings.",
			10000,
		),
		String(await draftNote(W, "beta").textContent()),
	);
	const draftProblems = await problemsOf(draftBox(W, "beta").locator(".identity-editor-problems li"));
	check(
		"...with the reason",
		draftProblems.some((p) => p.includes('"skills.own" must be true or false')),
		draftProblems.join(" | "),
	);
	check(
		"...nothing written: beta's identity.json and folder as they were",
		read(roleFile("beta", "identity.json")) === BETA_JSON && !existsSync(roleFile("beta", "prompt.md")),
	);
	check("...the draft still waits", existsSync(join(draftsRoot, "beta", "config.json")));
	check("...and the server log says so", serverLog.includes("[identities] refused the draft for beta:"));
	await draftBox(W, "beta").locator(".identity-draft-discard").click();
	check(
		"discarded: the page says so",
		await waitFor(
			async () => (await draftNote(W, "beta").textContent()) === "Discarded (kept in role-drafts/.old/).",
			10000,
		),
		String(await draftNote(W, "beta").textContent()),
	);
	check(
		"...and the draft is kept in role-drafts/.old/",
		!existsSync(join(draftsRoot, "beta")) && oldDrafts().some((n) => n.startsWith("beta-") && n.endsWith("-discarded")),
		oldDrafts().join(", "),
	);
	check(
		"no drafts waiting now",
		await waitFor(async () => (await W.locator(".identity-drafts-count").count()) === 0, 10000),
	);
	check(
		"the server log says it was discarded",
		serverLog.includes("[identities] the owner discarded the draft for beta"),
	);
	await shot(W, "after");

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
console.log("\nall identity-config checks passed");
