/* Reduced Roles, real route -> existing watch/reader/wire/store -> closed consumer.
 * Sealed ownServer + synthetic saved chats + headless Chrome, no model turn or live application.
 * One happy-path journey first, then theme/width/a11y/limits and disconnected cached values.
 * roles-needs-you (task #200): task names and plain-word states, "Needs you" from the real reader,
 * Open buttons that switch to the right existing chat, a roster problem or a lost connection that
 * says "can't tell" (never an all-clear), and a server restart that shows the same items once.
 * Only `state.sessionFile` is read from snapshot frames, to see which chat a button opened.
 * The unchanged full wire intentionally still carries legacy content; only the new subtree is closed.
 * Never inspect/print model request bodies. Only scalar provider/watch/cleanup counts leave the rig.
 * Run after fresh build: scripts/sealed.sh node tests/roles-page-test.mjs
 * Fixture-only screenshots: ROLES_SHOT=<private-directory>. Missing Chrome/axe is FAIL, not pass/skip.
 */
import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";

const AXE = process.env.PI_AXE_JS ?? join(userInfo().homedir, "temper-ai/configs/design/bin/vendor/axe-4.13.0.min.js");
const SHOTS = process.env.ROLES_SHOT || "";
if (!process.env.PI_SEALED) throw new Error("Run with scripts/sealed.sh");
if (!CHROME_PATH || !existsSync(AXE)) throw new Error("Chrome and axe are mandatory for this receipt");
let failures = 0;
let checks = 0;
function check(name, ok) {
	checks++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
	if (!ok) failures++;
}
async function until(fn, timeout = 20_000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await fn()) return true;
		await sleep(150);
	}
	return false;
}
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const NOW = Date.parse("2026-10-15T12:00:00Z");
let seq = 0;
const line = (op) => ({
	type: "custom",
	customType: "queue",
	id: `fixture-${++seq}`,
	timestamp: new Date(NOW).toISOString(),
	data: { v: 1, ts: NOW, ...op },
});
// Task titles are shown now (as plain text); every other plan part stays a canary.
const plan = {
	goal: "CANARY-GOAL",
	doneWhen: "CANARY-DONE",
	decided: "CANARY-PLAN",
	steps: "CANARY-STEPS",
	verify: "CANARY-VERIFY",
	mustNot: "CANARY-LIMIT",
};
// Task 101's name looks like HTML (shown as text); task 102's holds a bidi control (falls back to "Task #102").
const HTML_TITLE = "<img src=x onerror=alert(1)> & <b>bold</b>";
const BIDI_TITLE = "Fixture\u202etask 102";
const planFor = (id) => ({
	...plan,
	title: id === 101 ? HTML_TITLE : id === 102 ? BIDI_TITLE : `Fixture task ${id}`,
});
const NEEDS_LINE = "Need you: approve the fixture plan";
const QUESTION = "Pick option A or B?";
const LATEST = "Ran the fixture checks";
let identities;
let taskChat;
let linked;
let sessions;
let outside;
let store;
let home;
let providerCalls = 0;
const files = [];
const originals = new Map();
function transcript(file, id, cwd, records) {
	let parentId = null;
	const lines = [{ type: "session", version: 3, id, timestamp: new Date(NOW).toISOString(), cwd }];
	for (const record of records) {
		lines.push({ ...record, parentId });
		parentId = record.id;
	}
	writeFileSync(file, `${lines.map((record) => JSON.stringify(record)).join("\n")}\n`);
	files.push(file);
}
function identity(id, title, homeChat) {
	const dir = join(identities, id);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "identity.json");
	writeFileSync(file, JSON.stringify({ id, title, ...(homeChat ? { homeChat } : {}) }));
	files.push(file);
	const notebook = join(dir, "notebook.md");
	writeFileSync(notebook, "CANARY-NOTEBOOK");
	files.push(notebook);
}
function seed({ root, dataDir, agentDir, workdir }) {
	identities = join(root, "identities");
	sessions = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(sessions, { recursive: true });
	home = join(sessions, "2026-10-15T12-00-00-000Z_01a0f000-0000-7000-8000-000000000001.jsonl");
	// The unchanged shell opens its initial saved chat. Seed its existing SDK metadata so
	// this read-only journey can keep byte-exact transcript assertions, not ignore writes.
	const metadata = () => [
		{
			type: "model_change",
			id: "fixture-model",
			timestamp: new Date(NOW).toISOString(),
			provider: "mock",
			modelId: "mock-model",
		},
		{
			type: "thinking_level_change",
			id: "fixture-thinking",
			timestamp: new Date(NOW).toISOString(),
			thinkingLevel: "off",
		},
	];
	const records = [...metadata(), line({ op: "run" })];
	// Task 1 works in a chat of its own; task 2 waits on a decision; 3-22 work; 101-121 wait to start.
	taskChat = join(sessions, "2026-10-15T12-00-01-000Z_01a0f000-0000-7000-8000-000000000002.jsonl");
	records.push(
		line({ op: "add", id: 1, plan: planFor(1) }),
		line({ op: "start", id: 1, lane: true }),
		line({ op: "chat", id: 1, file: taskChat, title: "Queue #1" }),
		line({ op: "add", id: 2, plan: planFor(2) }),
		line({ op: "start", id: 2, lane: true }),
		line({ op: "stuck", id: 2, question: QUESTION }),
	);
	for (let id = 3; id <= 22; id++) {
		records.push(line({ op: "add", id, plan: planFor(id) }), line({ op: "start", id, lane: true }));
	}
	for (let id = 101; id <= 121; id++) records.push(line({ op: "add", id, plan: planFor(id) }));
	records.push({
		type: "custom",
		customType: "tldr",
		id: "fixture-needs",
		timestamp: new Date(NOW).toISOString(),
		data: { v: 1, text: NEEDS_LINE, ts: NOW, needsYou: true },
	});
	records.push({
		type: "custom",
		customType: "tldr",
		id: "fixture-tldr",
		timestamp: new Date(NOW).toISOString(),
		data: { v: 1, text: "CANARY-TLDR https://private.invalid/path", ts: NOW, needsYou: false },
	});
	// Non-content privacy canaries; nothing here is sent to a model.
	records.push({
		type: "custom",
		customType: "identity",
		id: "fixture-identity",
		timestamp: new Date(NOW).toISOString(),
		data: { v: 1, id: "frontend", note: "CANARY-PROMPT" },
	});
	records.push({
		type: "message",
		id: "fixture-assistant",
		timestamp: new Date(NOW).toISOString(),
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "CANARY-THINKING" },
				{ type: "toolCall", id: "tool-fixture", name: "CANARY-TOOL", arguments: {} },
			],
		},
	});
	records.push({
		type: "message",
		id: "fixture-result",
		timestamp: new Date(NOW).toISOString(),
		message: {
			role: "toolResult",
			toolCallId: "tool-fixture",
			toolName: "CANARY-TOOL",
			content: [{ type: "text", text: "CANARY-RESULT" }],
		},
	});
	transcript(home, "01a0f000-0000-7000-8000-000000000001", workdir, records);
	// The links open this chat, so it is a real one with a message: the SDK treats a chat without any as
	// new and writes its model and thinking level into it on every open.
	transcript(taskChat, "01a0f000-0000-7000-8000-000000000002", workdir, [
		...metadata(),
		{
			type: "message",
			id: "fixture-task-reply",
			timestamp: new Date(NOW).toISOString(),
			message: { role: "assistant", content: [{ type: "text", text: "Fixture task chat reply" }] },
		},
		{
			type: "custom",
			customType: "tldr",
			id: "fixture-latest",
			timestamp: new Date(NOW).toISOString(),
			data: { v: 1, text: LATEST, ts: NOW, needsYou: false },
		},
	]);
	identity("frontend", "Frontend engineering", home);
	identity("ops", "Ops/tooling", null);
	mkdirSync(join(root, "outside"), { recursive: true });
	outside = join(root, "outside", "private.jsonl");
	transcript(outside, "outside", workdir, [
		{
			type: "custom",
			customType: "tldr",
			id: "outside-line",
			timestamp: new Date(NOW).toISOString(),
			data: { v: 1, text: "CANARY-OUTSIDE", ts: NOW },
		},
	]);
	linked = join(sessions, "linked.jsonl");
	symlinkSync(outside, linked);
	// The Security and Systems roles (refused home chats) join after the clean journey.
	// Preserve the previous harness's future report-job fixture: no catch-up report/model turn.
	mkdirSync(join(root, ".pi-scheduler"), { recursive: true });
	const jobs = join(root, ".pi-scheduler", "jobs.json");
	writeFileSync(
		jobs,
		JSON.stringify({
			jobs: [
				{
					id: "j1",
					name: "6 am reports",
					type: "command",
					target: "role-reports run",
					enabled: true,
					nextRunAt: NOW + 20 * 3_600_000,
				},
			],
		}),
	);
	files.push(jobs);
	store = join(dataDir, "role-messages.json");
	writeFileSync(store, JSON.stringify({ v: 1, paused: false, messages: [] }));
	files.push(store);
	for (const file of files) originals.set(file, sha(file));
}

const srv = await ownServer({
	name: "roles-page",
	prepare: seed,
	mock: () => {
		providerCalls++;
		return "unused";
	},
	env: {
		TZ: "America/Los_Angeles",
		get HOME() {
			return join(identities, "..");
		},
		get PI_IDENTITY_DIR() {
			return identities;
		},
		get XDG_STATE_HOME() {
			return join(identities, "..", "state");
		},
		get PI_MEMORY_DIR() {
			return join(identities, "..", "memory");
		},
		PI_IDENTITY_REINDEX: "0",
	},
});
let browser;
const watches = [];
let receivedOverviews = 0;
let consoleCanary = false;
let readerPrivacyLeak = false;
let readerRawEntriesLeak = false;
let pageErrors = 0;
const destinations = new Set();
let lastSnapshot = null;
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	console.log(`Browser ${browser.version()}; Node ${process.version}; sealed=${!!process.env.PI_SEALED}`);
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
	await context.addInitScript(() => localStorage.setItem("pi-web-ui:lang", "en"));
	const page = await context.newPage();
	page.on("console", (message) => {
		if (message.text().includes("CANARY-")) consoleCanary = true;
	});
	page.on("pageerror", () => {
		pageErrors++;
	});
	page.on("request", (request) => {
		destinations.add(new URL(request.url()).origin);
	});
	page.on("websocket", (ws) => {
		ws.on("framesent", ({ payload }) => {
			if (typeof payload !== "string") return;
			const value = JSON.parse(payload);
			if (value.type === "roles_watch") watches.push(value.full ? "full" : "count");
			if (value.type === "roles_unwatch") watches.push("off");
		});
		ws.on("framereceived", ({ payload }) => {
			// Which chat a snapshot is for (state.sessionFile), and nothing else of it.
			if (typeof payload === "string" && payload.startsWith('{"type":"snapshot"')) {
				try {
					lastSnapshot = { at: Date.now(), sessionFile: JSON.parse(payload).state?.sessionFile };
				} catch {
					/* not a whole frame */
				}
			}
			// Read only a fixture Roles envelope to count real reader/wire delivery. Never retain its body.
			if (typeof payload === "string" && payload.startsWith('{"type":"roles"')) {
				const value = JSON.parse(payload);
				if (value.overview) receivedOverviews++;
				if (/CANARY-(THINKING|TOOL|RESULT|PROMPT|NOTEBOOK|OUTSIDE)/.test(payload)) readerPrivacyLeak = true;
				if (payload.includes('"customType"') || payload.includes('"parentId"')) readerRawEntriesLeak = true;
			}
		});
	});
	await page.goto(`${srv.http}/?view=roles#r-frontend`);
	await page.locator(".roles-useful-card").first().waitFor({ timeout: 30_000 });
	const frontend = page
		.locator(".roles-useful-card")
		.filter({ has: page.getByRole("heading", { name: "Frontend engineering", exact: true }) });
	const needs = page.locator(".roles-useful-needs");
	const asks = needs.locator(".roles-useful-ask");
	const textOf = async (locator) => (await locator.textContent()) ?? "";
	const taskRow = (name) =>
		frontend
			.locator(".roles-useful-task")
			.filter({ has: page.locator("q.roles-useful-agent").filter({ hasText: new RegExp(`^${name}$`) }) });
	check("happy path: real reader/wire/store reaches Roles", receivedOverviews > 0 && (await frontend.count()) === 1);
	check(
		"needs you: the needs-you line and the stuck task's question, once each, with role and age",
		(await until(async () => (await asks.count()) === 2)) &&
			(await textOf(needs.locator("h2"))) === "Needs you (2)" &&
			(await asks.filter({ hasText: NEEDS_LINE }).count()) === 1 &&
			(await asks.filter({ hasText: QUESTION }).count()) === 1 &&
			(await asks.allTextContents()).every((row) => row.includes("Frontend engineering") && row.includes("waiting ")),
	);
	// The first update after a watch may be the server's replay of an old look, so the page can tell only
	// once the server has looked again (its heartbeat comes within 30 s, or a changed update sooner).
	const canTell = () => until(async () => !(await textOf(needs)).includes("Can't tell"), 45_000);
	check(
		"needs you: current and complete -> neither can't-tell nor an all-clear while items wait",
		(await canTell()) && (await needs.locator(".roles-useful-clear").count()) === 0,
	);
	check(
		"needs you: says what it covers",
		(await textOf(needs)).includes(
			"Checks only: needs-you lines, task questions passed to you, open dialogs in role chats.",
		),
	);
	const row1 = taskRow("Fixture task 1");
	check(
		"tasks: a started task shows #N name, plain-word state, newest line and Open chat",
		(await row1.count()) === 1 &&
			(await textOf(row1.locator(".roles-useful-task-name"))) === "#1 Fixture task 1" &&
			(await textOf(row1.locator(".roles-useful-task-state"))) === "working" &&
			(await textOf(row1.locator(".roles-useful-meta"))) === `Latest: ${LATEST}` &&
			(await row1.getByRole("button", { name: "Open chat for task #1", exact: true }).count()) === 1,
	);
	const row2 = taskRow("Fixture task 2");
	check(
		"tasks: a stuck task reads 'needs a decision' and links to its queue",
		(await textOf(row2.locator(".roles-useful-task-state"))) === "needs a decision" &&
			(await row2.getByRole("button", { name: "Open queue for task #2", exact: true }).count()) === 1,
	);
	const row103 = taskRow("Fixture task 103");
	check(
		"tasks: a task waiting to start reads 'ready' and links to its queue",
		(await textOf(row103.locator(".roles-useful-task-state"))) === "ready" &&
			(await row103.getByRole("button", { name: "Open queue for task #103", exact: true }).count()) === 1,
	);
	check(
		"counts: reported numbers, zero included, when the queue was read cleanly",
		(await frontend.locator("h3").allTextContents()).join("|") === "Started (22)|Waiting to start (21)" &&
			(await textOf(frontend)).includes("Done, still in the queue: 0"),
	);
	check(
		"caps: 20 started + 20 waiting rows, with the reported totals",
		(await frontend.locator(".roles-useful-task").count()) === 40 &&
			(await textOf(frontend)).includes("Showing 20 of 22.") &&
			(await textOf(frontend)).includes("Showing 20 of 21."),
	);
	const opsCard = page
		.locator(".roles-useful-card")
		.filter({ has: page.getByRole("heading", { name: "Ops/tooling", exact: true }) });
	check(
		"a role without a queue says so, with no counts",
		(await textOf(opsCard)).includes("No queue reported") && (await opsCard.locator("h3").count()) === 0,
	);
	check(
		"agent text: plain text nodes in quote elements only; HTML-looking names stay text",
		await page.locator(".roles-useful").evaluate((node, html) => {
			const quotes = [...node.querySelectorAll("q")];
			return (
				quotes.length > 0 &&
				quotes.every(
					(q) => q.className === "roles-useful-agent" && q.children.length === 0 && q.attributes.length === 1,
				) &&
				quotes.some((q) => q.textContent === html)
			);
		}, HTML_TITLE),
	);
	check(
		"agent text: a name with a bidi control shows as Task #N, never partly",
		(await frontend
			.locator(".roles-useful-task-name")
			.filter({ hasText: /^Task #102$/ })
			.count()) === 1 && !(await page.locator(".roles-useful").evaluate((node) => node.outerHTML)).includes("\u202e"),
	);
	check(
		"controls: Open buttons only; no links, fields, images, titles, data attributes or dialogs",
		(await page
			.locator(
				".roles-useful a, .roles-useful [href], .roles-useful input, .roles-useful select, .roles-useful textarea, .roles-useful svg, .roles-useful img, .roles-useful [title], .roles-useful [data-role-id], .roles-useful [role=dialog]",
			)
			.count()) === 0 &&
			(await page
				.locator(".roles-useful button")
				.evaluateAll(
					(buttons) =>
						buttons.length > 0 &&
						buttons.every(
							(b) => b.className === "roles-useful-open" && b.type === "button" && /^Open\b/.test(b.textContent ?? ""),
						),
				)),
	);
	check(
		"happy path: no excluded canary in any new DOM/aria/data/title text",
		!(await page.locator(".roles-useful").evaluate((node) => node.outerHTML)).includes("CANARY-"),
	);
	const nav = page.locator(".tb-tab.roles-tab");
	await nav.focus();
	check(
		"happy path: existing navigation target >=24px and keyboard focus visible",
		await nav.evaluate((node) => {
			const box = node.getBoundingClientRect();
			const style = getComputedStyle(node);
			return (
				document.activeElement === node &&
				box.width >= 24 &&
				box.height >= 24 &&
				(style.outlineStyle !== "none" || style.boxShadow !== "none")
			);
		}),
	);
	await page.locator('.tb-tab[role="tab"]').first().focus();
	await page.keyboard.press("Enter");
	check(
		"happy path: leave lowers full watch to existing count/off",
		await until(() => watches.at(-1) === "count" || watches.at(-1) === "off"),
	);
	await nav.focus();
	await page.keyboard.press("Enter");
	check(
		"happy path: return restores exactly one full watch",
		(await until(() => watches.at(-1) === "full")) && watches.filter((value) => value === "full").length === 2,
	);
	check(
		"happy path: read-only journey leaves all fixture chats/identities/store unchanged",
		[...originals].every(([file, hash]) => sha(file) === hash),
	);
	// Links: each Open goes through openFromRoles to an existing chat; the next snapshot names it.
	// Every open below switches away from the chat that is open, so a fresh snapshot must come.
	const openFrom = async (button, file) => {
		const at = Date.now();
		await button.click();
		return until(() => lastSnapshot !== null && lastSnapshot.at >= at && lastSnapshot.sessionFile === file);
	};
	const backToRoles = async () => {
		await page.locator(".tb-tab.roles-tab").click();
		await page.locator(".roles-useful-card").first().waitFor();
	};
	// The item a link asks for is marked for 2.5 s (FOCUS_FLASH_MS); record every mark as it happens.
	const watchMarks = () =>
		page.evaluate(() => {
			const seen = { tasks: [], lines: [] };
			const note = (node) => {
				if (!(node instanceof HTMLElement)) return;
				if (node.classList.contains("task-queue-focus")) seen.tasks.push(node.getAttribute("data-task-id"));
				if (node.classList.contains("tldr-focus")) seen.lines.push(node.textContent ?? "");
			};
			window.__rolesMarkObserver?.disconnect();
			const observer = new MutationObserver((records) => {
				for (const record of records) {
					if (record.type === "attributes") note(record.target);
					for (const node of record.addedNodes) {
						note(node);
						if (node instanceof HTMLElement)
							for (const inner of node.querySelectorAll(".task-queue-focus, .tldr-focus")) note(inner);
					}
				}
			});
			observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
			window.__rolesMarkObserver = observer;
			window.__rolesMarks = seen;
		});
	const markedTask = (id) => until(() => page.evaluate((want) => window.__rolesMarks.tasks.includes(want), String(id)));
	const markedLine = (text) =>
		until(() => page.evaluate((want) => window.__rolesMarks.lines.some((line) => line.includes(want)), text));
	const openTaskChat = async () => {
		await backToRoles();
		return openFrom(row1.getByRole("button", { name: "Open chat for task #1", exact: true }), taskChat);
	};
	// A failed open (the chat unreadable for a moment) says so in fixed words: never the server's reason
	// ("EACCES: permission denied, open '<path>'") or the file's name. Then Retry opens it.
	chmodSync(taskChat, 0o000);
	await row1.getByRole("button", { name: "Open chat for task #1", exact: true }).click();
	const failed = page.locator('.switch-overlay[data-switch-state="error"]');
	// The overlay names the chat by its list title (here the list's "(no messages)", since the fixture chat
	// has no message) or "this chat"; never by its file. The unit tests cover the "this chat" fallback.
	const failedTitle = async () => /\u201c([^\u201d]*)\u201d/.exec(await textOf(failed))?.[1] ?? null;
	check(
		"links: a failed open shows fixed words, with no part of the chat's path",
		(await until(async () => (await failed.count()) === 1)) &&
			["this chat", "(no messages)"].includes(await failedTitle()) &&
			(await textOf(failed)).includes("The chat couldn't be opened. Try again, or open it from the chat list.") &&
			(await failed.evaluate(
				(node, parts) => parts.every((part) => !node.outerHTML.includes(part)),
				[taskChat, basename(taskChat), "jsonl", "EACCES"],
			)) &&
			!(await page.evaluate(() => /EACCES|permission denied/.test(document.body.innerText))),
	);
	chmodSync(taskChat, 0o644);
	check(
		"links: Retry then opens the started task's own chat",
		await openFrom(failed.getByRole("button", { name: "Retry", exact: true }), taskChat),
	);
	await backToRoles();
	await watchMarks();
	check(
		"links: a needs-you line's Open opens its role's home chat at that line",
		(await openFrom(asks.filter({ hasText: NEEDS_LINE }).getByRole("button"), home)) && (await markedLine(NEEDS_LINE)),
	);
	check("links: a started task's Open chat opens its own chat", await openTaskChat());
	await backToRoles();
	await watchMarks();
	check(
		"links: a task question's Open opens its queue's chat at the task",
		(await openFrom(asks.filter({ hasText: QUESTION }).getByRole("button"), home)) && (await markedTask(2)),
	);
	check("links: back to the task's chat once more", await openTaskChat());
	await backToRoles();
	await watchMarks();
	check(
		"links: a waiting task's Open queue opens its queue at the task",
		(await openFrom(row103.getByRole("button"), home)) && (await markedTask(103)),
	);
	await page.evaluate(() => window.__rolesMarkObserver?.disconnect());
	await backToRoles();
	check(
		"links: opening chats changed none of them and started no model turn",
		[...originals].every(([file, hash]) => sha(file) === hash) && providerCalls === 0,
	);

	const scrollRegion = page.getByRole("region", { name: "Roles", exact: true });
	await scrollRegion.focus();
	await page.keyboard.press("PageDown");
	check(
		"read-only text region is keyboard reachable and scrollable",
		await until(() => scrollRegion.evaluate((node) => document.activeElement === node && node.scrollTop > 0)),
	);
	await scrollRegion.evaluate((node) => {
		node.scrollTop = 0;
	});
	await page.addScriptTag({ path: AXE });
	for (const theme of ["dark", "white"]) {
		// Existing theme event/storage semantics, no production settings mutation.
		if (theme === "white") {
			await context.addInitScript(() => localStorage.setItem("pi-web-ui:theme", "white"));
			await page.goto(`${srv.http}/?view=roles`);
			await page.locator(".roles-useful-card").first().waitFor();
			await page.addScriptTag({ path: AXE });
		}
		// Same state in every look (and every screenshot): the server has looked again since the watch.
		check(`${theme}: the page can tell again after its new watch`, await canTell());
		for (const width of [320, 390, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			await sleep(200);
			const layout = await page.locator(".roles-useful").evaluate((node) => {
				const style = getComputedStyle(node);
				const grid = getComputedStyle(node.querySelector(".roles-useful-grid"));
				const bad = [...node.querySelectorAll("*")].some((child) => {
					const css = getComputedStyle(child);
					return css.fontFamily !== style.fontFamily || css.animationName !== "none";
				});
				return {
					overflow: node.scrollWidth > node.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1,
					font: style.fontFamily,
					body: style.fontSize,
					heading: getComputedStyle(node.querySelector("h1")).fontSize,
					note: getComputedStyle(node.querySelector(".roles-useful-note")).fontSize,
					padding: style.paddingLeft,
					columns: grid.gridTemplateColumns.split(" ").length,
					background: style.backgroundColor,
					bad,
				};
			});
			check(`${theme}/${width}: no horizontal overflow`, !layout.overflow);
			check(
				`${theme}/${width}: approved system font and 20/15/13px type`,
				layout.font.startsWith("system-ui") &&
					!layout.bad &&
					layout.body === "15px" &&
					layout.heading === "20px" &&
					layout.note === "13px",
			);
			check(
				`${theme}/${width}: approved padding and columns`,
				layout.padding === (width <= 768 ? "16px" : "32px") && layout.columns === (width <= 768 ? 1 : 2),
			);
			if (theme === "white")
				check(`white/${width}: actual light palette`, /rgb\(25[0-5], 25[0-5], 25[0-5]\)/.test(layout.background));
			const serious = await page.evaluate(async () => {
				const result = await window.axe.run(document.querySelector(".roles-useful"), {
					runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
				});
				return result.violations
					.filter((value) => value.impact === "serious" || value.impact === "critical")
					.map((value) => value.id);
			});
			check(`${theme}/${width}: no serious/critical axe findings`, serious.length === 0);
			if (serious.length) console.log(`AXE rule IDs only: ${serious.join(",")}`);
			if (SHOTS && width !== 320) {
				mkdirSync(SHOTS, { recursive: true });
				await page.screenshot({ path: join(SHOTS, `roles-${theme}-${width}.png`) });
			}
		}
	}
	// Restart: task 1 finishes meanwhile (its row goes); the same asks come back once each.
	const beforeHome = sha(home);
	appendFileSync(
		home,
		`${JSON.stringify({ ...line({ op: "done", id: 1, summary: "CANARY-SUMMARY" }), parentId: "fixture-result" })}\n`,
	);
	check("test fixture writes are tracked separately from read-only app", sha(home) !== beforeHome);
	await srv.stop();
	check(
		"disconnected: can't tell (never an all-clear); last received items stay, marked",
		(await until(async () =>
			(await textOf(page.locator(".roles-useful header"))).includes("Not connected — showing the last update received"),
		)) &&
			(await textOf(needs)).includes("Can't tell right now: this page isn't getting live updates.") &&
			(await needs.locator(".roles-useful-clear").count()) === 0 &&
			(await asks.count()) === 2 &&
			(await page.locator(".roles-useful-stale").count()) === 1,
	);
	await srv.restart();
	check(
		"restart + reconnect: the same items again, once each; the finished task's row is gone",
		(await until(
			async () =>
				(await textOf(page.locator(".roles-useful header p"))) === "Connected" &&
				!(await textOf(needs)).includes("Can't tell") &&
				(await taskRow("Fixture task 1").count()) === 0,
			60_000,
		)) &&
			(await asks.count()) === 2 &&
			(await asks.filter({ hasText: NEEDS_LINE }).count()) === 1 &&
			(await asks.filter({ hasText: QUESTION }).count()) === 1 &&
			(await textOf(frontend)).includes("Done, still in the queue: 1") &&
			(await page.locator(".roles-useful-stale").count()) === 0 &&
			!(await page.locator(".roles-useful").evaluate((node) => node.outerHTML)).includes("CANARY-"),
	);
	// Roles whose home chat the server refuses: outside the sessions folder, or an unnormalised '..' path.
	identity("security", "Security", linked);
	identity("systems", "Systems", `${sessions}/sub/../${home.slice(sessions.length + 1)}`);
	const security = page
		.locator(".roles-useful-card")
		.filter({ has: page.getByRole("heading", { name: "Security", exact: true }) });
	check(
		"a role that couldn't be read: can't tell, the role is marked, its counts couldn't read",
		(await until(
			async () =>
				(await security.count()) === 1 &&
				(await textOf(needs)).includes("Can't tell right now: some roles, tasks or chats couldn't be read."),
		)) &&
			(await textOf(security)).includes("Some of this role's data couldn't be read.") &&
			(await textOf(security)).includes("couldn't read") &&
			(await needs.locator(".roles-useful-clear").count()) === 0,
	);
	// Received source can be incomplete before it reaches the consumer. Still only 64 displayed roles.
	for (let i = 0; i < 61; i++) identity(`z-role-${i}`, i === 0 ? "L".repeat(121) : `Configured role ${i}`, null);
	check(
		"65 received roles -> 64 bounded cards with a plain omission note",
		(await until(async () => (await page.locator(".roles-useful-card").count()) === 64)) &&
			(await textOf(page.locator(".roles-useful"))).includes("Some roles couldn't be shown."),
	);
	check(
		"a long configured label is clipped with a note; the full label is never in the page",
		(await textOf(page.locator(".roles-useful"))).includes("Name shortened to 120 characters.") &&
			!(await page.locator(".roles-useful").evaluate((node) => node.outerHTML)).includes("L".repeat(121)),
	);
	check("model/provider callbacks remain uncalled (scalar only)", providerCalls === 0);
	check("no excluded canary logged by page", !consoleCanary);
	check("existing reader suppresses thinking/tool/prompt/notebook/outside content", !readerPrivacyLeak);
	check("no raw transcript entries sent by existing reader", !readerRawEntriesLeak);
	check(
		"no session file created by looking or opening",
		readdirSync(sessions).filter((name) => name.endsWith(".jsonl")).length === 3,
	);
	const busy = await fetch(`${srv.http}/api/busy`).then((response) => response.json());
	check("no running chat/model worker", Array.isArray(busy.busy) && busy.busy.length === 0);
	check("no browser runtime errors", pageErrors === 0);
	check(
		"no new network destination",
		[...destinations].every((origin) => origin === srv.http),
	);
	check(
		"all original non-mutated fixture files unchanged",
		[...originals].every(([file, hash]) => file === home || sha(file) === hash),
	);
	check(
		"fixture outside file remains outside and unrendered",
		existsSync(outside) &&
			!(await page.locator(".roles-useful").evaluate((node) => node.outerHTML)).includes("CANARY-OUTSIDE"),
	);
} catch (error) {
	// Error message/stack from our test only; never dump page data, WS bodies or mock request objects.
	console.error(error instanceof Error ? error.stack : "browser harness failed");
	failures++;
} finally {
	if (browser) await browser.close();
	await srv.stop();
	await srv.mock?.close();
	rmSync(srv.root, { recursive: true, force: true });
	check("cleanup: isolated fixture root removed", !existsSync(srv.root));
}
console.log(
	`roles-page: ${checks} checks; ${failures} failures; provider calls ${providerCalls}; no intentional skips`,
);
process.exitCode = failures ? 1 : 0;
