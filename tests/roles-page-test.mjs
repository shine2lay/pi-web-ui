/* Reduced Roles, real route -> existing watch/reader/wire/store -> closed consumer.
 * Sealed ownServer + synthetic saved chats + headless Chrome, no model turn or live application.
 * One happy-path journey first, then theme/width/a11y/limits and disconnected cached values.
 * The unchanged full wire intentionally still carries legacy content; only the new subtree is closed.
 * Never inspect/print model request bodies. Only scalar provider/watch/cleanup counts leave the rig.
 * Run after fresh build: scripts/sealed.sh node tests/roles-page-test.mjs
 * Fixture-only screenshots: ROLES_SHOT=<private-directory>. Missing Chrome/axe is FAIL, not pass/skip.
 */
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
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
const plan = {
	title: "CANARY-TASK-TITLE",
	goal: "CANARY-GOAL",
	doneWhen: "CANARY-DONE",
	decided: "CANARY-PLAN",
	steps: "CANARY-STEPS",
	verify: "CANARY-VERIFY",
	mustNot: "CANARY-LIMIT",
};
let identities;
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
	const records = [line({ op: "run" })];
	for (let id = 1; id <= 21; id++) {
		records.push(line({ op: "add", id, plan }), line({ op: "start", id, lane: true }));
	}
	for (let id = 101; id <= 121; id++) records.push(line({ op: "add", id, plan }));
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
	const linked = join(sessions, "linked.jsonl");
	symlinkSync(outside, linked);
	identity("security", "Security", linked);
	// Existing non-content path safeguards: unnormalised '..' must remain refused too.
	identity("systems", "Systems", `${sessions}/sub/../${home.slice(sessions.length + 1)}`);
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
	check("happy path: real reader/wire/store reaches Roles", receivedOverviews > 0 && (await frontend.count()) === 1);
	check(
		"happy path: fixed task label and reported status",
		(await frontend.textContent()).includes("Task #1 — Reported status: working"),
	);
	check(
		"happy path: source counts preserved before producer/consumer caps",
		(await frontend.locator("dd").allTextContents()).slice(-3).join(",") === "21,21,Not established",
	);
	check("happy path: 20 active + 20 queued displayed", (await frontend.getByRole("listitem").count()) === 40);
	check(
		"happy path: caps do not certify an exact missing total",
		(await frontend.textContent()).includes("Not all reported records are shown; completeness remains unknown"),
	);
	check(
		"happy path: unknown roster member/home problem stays unavailable",
		(
			await page
				.locator(".roles-useful-card")
				.filter({ has: page.getByRole("heading", { name: "Security", exact: true }) })
				.textContent()
		).includes("Unavailable"),
	);
	check(
		"happy path: no controls, rich content, hidden links or decorative assets in reduced subtree",
		(await page
			.locator(
				".roles-useful a, .roles-useful button, .roles-useful input, .roles-useful svg, .roles-useful img, .roles-useful [title], .roles-useful [data-role-id], .roles-useful [role=dialog]",
			)
			.count()) === 0,
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

	await page.addScriptTag({ path: AXE });
	for (const theme of ["dark", "white"]) {
		// Existing theme event/storage semantics, no production settings mutation.
		if (theme === "white") {
			await context.addInitScript(() => localStorage.setItem("pi-web-ui:theme", "white"));
			await page.reload();
			await page.locator(".roles-useful-card").first().waitFor();
			await page.addScriptTag({ path: AXE });
		}
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
				return result.violations.filter((value) => value.impact === "serious" || value.impact === "critical").length;
			});
			check(`${theme}/${width}: no serious/critical axe findings`, serious === 0);
			if (SHOTS && width !== 320) {
				mkdirSync(SHOTS, { recursive: true });
				await page.screenshot({ path: join(SHOTS, `roles-${theme}-${width}.png`) });
			}
		}
	}
	// Received source can be incomplete before it reaches the consumer. Still only 64 displayed roles.
	for (let i = 0; i < 61; i++) identity(`z-role-${i}`, i === 0 ? "L".repeat(121) : `Configured role ${i}`, null);
	check(
		"65 received roles -> 64 bounded cards with neutral omission",
		(await until(async () => (await page.locator(".roles-useful-card").count()) === 64)) &&
			(await page.locator(".roles-useful").textContent()).includes("Some received role rows were omitted"),
	);
	check(
		"real configured long label has explicit clipping, no hidden full label",
		(await page.locator(".roles-useful").textContent()).includes("Configured label truncated") &&
			!(await page.locator(".roles-useful").evaluate((node) => node.outerHTML)).includes("L".repeat(121)),
	);
	// Replace the home transcript in this test rig; old records must disappear rather than accumulate.
	const beforeHome = sha(home);
	appendFileSync(
		home,
		`${JSON.stringify({ ...line({ op: "done", id: 1, summary: "CANARY-SUMMARY" }), parentId: null })}\n`,
	);
	check("test fixture writes are tracked separately from read-only app", sha(home) !== beforeHome);
	await srv.stop();
	check(
		"disconnected page keeps only cached/unverified reported values",
		await until(async () =>
			(await page.locator(".roles-useful").textContent()).includes(
				"Not live — cached reported values; source freshness unverified",
			),
		),
	);
	await srv.restart();
	check(
		"reconnect does not certify a fresh native read",
		(await until(async () =>
			(await page.locator(".roles-useful").textContent()).includes("source freshness unverified"),
		)) && !(await page.locator(".roles-useful").textContent()).includes("native verified"),
	);
	check("model/provider callbacks remain uncalled (scalar only)", providerCalls === 0);
	check("no excluded canary logged by page", !consoleCanary);
	check("existing reader suppresses thinking/tool/prompt/notebook/outside content", !readerPrivacyLeak);
	check("no raw transcript entries sent by existing reader", !readerRawEntriesLeak);
	check(
		"no chat opened/created by looking",
		readdirSync(sessions).filter((name) => name.endsWith(".jsonl")).length === 2,
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
