/* roles-asks-read (Ops #268, docs/roles-asks-read.md): a role with 12 started task chats and an open dialog
 * in its 11th. The server reads every started chat (up to 40 per role) and says so per role (allChatsRead);
 * the Roles page lists that ask as waiting on the owner, and its status pill says Live, not "Asks
 * unconfirmed: some roles not read". Without the fix the server read 8 chats: the ask was missing and the
 * pill said unconfirmed. Real server, fake model, Chrome; no live data or paid model. The fake model never
 * inspects a request body. Output is fixed labels and counts only, never chat text or model inputs.
 * Run after build: scripts/sealed.sh node tests/roles-asks-read-test.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";
if (!process.env.PI_SEALED) throw new Error("Run with scripts/sealed.sh");
if (!CHROME_PATH) throw new Error("Chrome is required");

const STARTED = 12;
/** The started chat (1-based) whose model opens the dialog: past the 8 an older server read. */
const ASKING = 11;
const QUESTION = "Fixture question in the eleventh task chat: alpha or beta?";
const UNCONFIRMED = "Asks unconfirmed";
const now = Date.now();
let home, identities, work;
const chats = [];
let asked = false,
	failures = 0,
	pageErrors = 0;
const check = (name, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
	if (!ok) failures++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms = 30000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return true;
		await sleep(100);
	}
	return false;
}
function seed({ root, agentDir, workdir }) {
	const settings = join(agentDir, "settings.json");
	writeFileSync(
		settings,
		JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), compaction: { enabled: false } }),
	);
	const sessions = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(sessions, { recursive: true });
	const idOf = (n) => `01a0f000-0000-7000-8000-${String(n).padStart(12, "0")}`;
	const fileOf = (n) => join(sessions, `2026-10-19T00-00-${String(n).padStart(2, "0")}-000Z_${idOf(n)}.jsonl`);
	function transcript(file, id, ops) {
		let parentId = null;
		const lines = [{ type: "session", version: 3, id, timestamp: new Date(now).toISOString(), cwd: workdir }];
		const append = (entry) => {
			const row = { id: `f${lines.length}`, parentId, timestamp: new Date(now).toISOString(), ...entry };
			lines.push(row);
			parentId = row.id;
		};
		append({ type: "model_change", provider: "mock", modelId: "mock-model" });
		for (const op of ops) append({ type: "custom", customType: "queue", data: { v: 1, ts: now, ...op } });
		writeFileSync(file, `${lines.map((row) => JSON.stringify(row)).join("\n")}\n`);
	}
	for (let i = 1; i <= STARTED; i++) {
		const file = fileOf(i + 1);
		transcript(file, idOf(i + 1), []);
		chats.push(file);
	}
	home = fileOf(1);
	const plan = (i) => ({
		title: `Fixture task ${i}`,
		goal: "Fixture",
		doneWhen: "Never",
		decided: "Fixture only",
		steps: "Wait",
		verify: "None",
		mustNot: "Touch live state",
	});
	const ops = [{ op: "lanes", n: STARTED }];
	for (let i = 1; i <= STARTED; i++)
		ops.push({ op: "add", id: i, plan: plan(i), standalone: true, touches: [`fixture-${i}`] });
	ops.push({ op: "run" });
	for (let i = 1; i <= STARTED; i++) {
		ops.push({ op: "start", id: i, lane: true });
		ops.push({ op: "chat", id: i, file: chats[i - 1], title: `Fixture task chat ${i}` });
	}
	transcript(home, idOf(1), ops);
	identities = join(root, "identities");
	work = join(agentDir, "work");
	mkdirSync(join(identities, "design"), { recursive: true });
	writeFileSync(
		join(identities, "design", "identity.json"),
		JSON.stringify({ id: "design", title: "Fixture Design", homeChat: home }),
	);
	writeFileSync(join(identities, "design", "about.md"), "# Fixture Design\n");
	writeFileSync(join(identities, "design", "notebook.md"), "");
}
const srv = await ownServer({
	name: "roles-asks-read",
	prepare: seed,
	mock: ({ sideRequest, toolResult }) => {
		if (sideRequest) return "Fixture";
		if (toolResult) return "Fixture operation finished.";
		if (asked) return "Fixture idle.";
		asked = true;
		return {
			tool: "ask_user_question",
			args: {
				questions: [
					{
						id: "pick",
						header: "Fixture task #11",
						question: QUESTION,
						options: [{ label: "alpha" }, { label: "beta" }],
					},
				],
			},
		};
	},
	env: {
		PI_WEB_TOKEN: "",
		PI_IDENTITY_REINDEX: "0",
		get PI_IDENTITY_DIR() {
			return identities;
		},
		get PI_WORK_DIR() {
			return work;
		},
	},
});
let browser, socket;
const hardStop = setTimeout(() => {
	console.error("FAIL bounded fixture timeout");
	process.exitCode = 1;
	void srv.stop();
}, 180000);
hardStop.unref();
const state = {};
let roles = null;
const send = (message) => socket.send(JSON.stringify(message));
try {
	socket = new WebSocket(srv.ws);
	socket.on("message", (data) => {
		const msg = JSON.parse(String(data));
		// Project app metadata only. Never keep any model request or chat content.
		if (msg.type === "snapshot" || msg.type === "snapshot_delta") {
			for (const key of ["sessionFile", "conversationId"]) if (key in msg.state) state[key] = msg.state[key];
		}
		if (msg.type === "roles") roles = msg.overview;
	});
	await new Promise((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	send({ type: "hello", clientId: "roles-asks-read-fixture", locale: "en" });
	if (!(await until(() => state.conversationId))) throw new Error("fixture did not start");
	send({ type: "roles_watch", full: true });
	if (!(await until(() => roles?.roles?.length === 1))) throw new Error("fixture roster unavailable");
	const design = () => roles.roles[0];
	check(`the role has ${STARTED} started task chats`, design().queue?.active?.length === STARTED);
	check(
		"before any dialog: every started chat read, nothing waits",
		design().allChatsRead === true && roles.asks.length === 0,
	);

	// The 11th started chat's model asks the owner; the dialog stays open.
	const asking = chats[ASKING - 1];
	send({ type: "switch_session", path: asking });
	if (!(await until(() => state.sessionFile === asking))) throw new Error("fixture task chat did not open");
	send({ type: "prompt", text: "Fixture prompt" });
	const listed = await until(() => roles?.asks?.some((a) => a.kind === "question"));
	check("the 11th chat's open dialog is listed", listed);
	const ask = roles.asks.find((a) => a.kind === "question");
	check("it is listed for its role", ask?.role === "design");
	check("and for its own chat, the 11th task's", ask?.chat?.file === asking && ask.chat.where === ASKING);
	check("and can be answered from the page", typeof ask?.askId === "string" && typeof ask.text === "string");
	check("the server says every started chat was read", design().allChatsRead === true);

	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
	const page = await context.newPage();
	page.on("pageerror", () => {
		pageErrors++;
	});
	const opened = Date.now();
	await page.goto(`${srv.http}/?view=roles`);
	const frame = page.frameLocator('iframe[title="Roles"]');
	await frame.locator('button[aria-haspopup="dialog"]').first().waitFor();
	const pill = frame.locator('header [role="status"]');
	const you = frame.getByText("1 waiting on you", { exact: true }).first();
	await you.waitFor({ timeout: 15000 }).catch(() => {});
	check("the page counts the ask as waiting on you", await you.isVisible());
	// The live check's moment: the status words 10 s after opening.
	await sleep(Math.max(0, opened + 10000 - Date.now()));
	const words = await pill.innerText();
	check("10 s after opening the status pill says Live", words.startsWith("Live"));
	check("and never that asks are unconfirmed", !words.includes(UNCONFIRMED));
	await frame.getByRole("button", { name: "You: open your decisions, questions and spending" }).click();
	const panel = frame.locator('[role="region"]');
	const row = panel
		.locator("p")
		.filter({ hasText: ask?.text ?? QUESTION })
		.locator("..");
	await row
		.first()
		.waitFor({ timeout: 10000 })
		.catch(() => {});
	check(
		"your list shows the 11th chat's question with its Answer button",
		(await row.count()) >= 1 && (await row.getByRole("button", { name: "Answer", exact: true }).count()) >= 1,
	);
	check("no page errors", pageErrors === 0);
} catch (error) {
	console.error(`FAIL ${error instanceof Error ? error.message : "fixture error"}`);
	failures++;
} finally {
	clearTimeout(hardStop);
	socket?.close();
	await browser?.close().catch(() => {});
	await srv.stop();
}
console.log(failures ? `roles-asks-read: ${failures} failed` : "roles-asks-read: all passed");
process.exitCode = failures ? 1 : 0;
