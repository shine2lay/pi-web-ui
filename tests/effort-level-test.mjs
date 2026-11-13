/**
 * effort-level-button (PATCHES.md; ops #876 acceptance test, built by ops task 2b): the composer's "Department
 * effort level" button beside today's model and Effort menus. Owner, Ops home chat 2026-11-13 (m93253): "I need a
 * button to change the effort per chat based on that department's table . So I can choose effort for the leads
 * without going to the actual model selector"; "A new button beside it", "Lead and task chats", "Until you change it".
 *
 * Sealed (rule 29): a server of its own (tests/lib/own-server.mjs) in a temp HOME with pi-queue loaded from its
 * checkout (PI_QUEUE_PKG, default ~/projects/pi-queue), a fixture Ops table, ban list and model menu in its own
 * agent folder, and models that can't be reached (no model is ever called: nothing here sends a prompt). Roles:
 * ops (a home chat and one task chat its queue started) and a plain chat of no role.
 *
 *  1. ops's home chat: the button shows "Extra high" (the table's lead tier), aria-label "Department effort level";
 *     its menu: header "Ops table", five rows "Max · …" to "Low · …", ✓ and "(default)" on Extra high, last
 *     item "Back to department default";
 *  2. picking High switches the model menu's shown model to the High row's model; the button shows "High";
 *  3. after a reload the chat is still on High (the pick is kept until changed);
 *  4. "Back to department default" restores Extra high and its model;
 *  5. the task chat shows the button with its task's tier as default; the plain chat shows no button;
 *  6. 320px: the button and its menu fit (no overflow, no overlap with the model and Effort chips).
 *  7. axe finds nothing serious or critical in the open menu, in dark and in White (ops #878's live look: White's
 *     faint "(default)" on the checked row was 4.24:1).
 *
 * Until ops task 2b builds it every step fails with "effort levels: not built (ops task 2b)". Task 2b may extend
 * the fixture setup but never weakens or deletes a check.
 *
 * Usage: npm run build && node tests/effort-level-test.mjs   (EFFORT_SHOT=/tmp/el saves /tmp/el-*.png)
 * EFFORT_HOLD=<file>: after the checks, write the page addresses of the three chats (JSON) there and keep the
 * server up until that file is deleted, so ui-check can look at each one (`?chat=<chat file>`).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { noRetries } from "./lib/mock-model.mjs";
import { describeOverflow, findOverflow } from "./lib/overflow-finder.mjs";
import { ownServer } from "./lib/own-server.mjs";

const NOT_BUILT = "effort levels: not built (ops task 2b)";
const PKG = process.env.PI_QUEUE_PKG || join(userInfo().homedir, "projects/pi-queue");
const SHOT = process.env.EFFORT_SHOT ?? "";
const BUTTON = '[aria-label="Department effort level"]';
const MODEL_CHIP = ".composer-tools .chip-model";
let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✓" : "✗ FAIL:"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures += 1;
}
if (!existsSync(CHROME_PATH)) {
	console.log(`SKIP: no Chrome at ${CHROME_PATH}`);
	process.exit(0);
}
if (!existsSync(join(PKG, "model-effort-level.ts"))) {
	console.log(`✗ FAIL: pi-queue at ${PKG} has no effort-level seam (set PI_QUEUE_PKG)`);
	process.exit(1);
}

// ---- the fixture: Ops' table, the ban list, a model menu, models that can't be reached ---------------------
const TABLE = {
	v: 1,
	department: "ops",
	everyday: "high",
	lead: "xhigh",
	order: ["anthropic", "antigravity", "openai"],
	// Every column needs a cell and every row order lists each column once (pi-queue model-table.ts; "none" when
	// there's no clean option).
	rows: {
		max: { anthropic: "claude-fable-5-2@xhigh *", antigravity: "none", openai: "gpt-6-astra@xhigh" },
		xhigh: { anthropic: "claude-fable-5-2@high *", antigravity: "none", openai: "gpt-6-astra@high" },
		high: { anthropic: "claude-opus-5-5@high *", antigravity: "none", openai: "gpt-6-astra@medium" },
		medium: {
			anthropic: "claude-sonnet-5-5@medium",
			antigravity: "none",
			openai: "gpt-6.1-sol@high *",
			order: ["openai", "anthropic", "antigravity"],
		},
		low: {
			anthropic: "claude-haiku-5-5@low",
			antigravity: "none",
			openai: "gpt-6.1-sol@low *",
			order: ["openai", "anthropic", "antigravity"],
		},
	},
	floors: [{ tags: ["spec"], min: "high" }],
	exclusions: [],
	tagOrders: [],
	lowJobs: [{ tag: "rename", what: "mechanical rename followed by its test run" }],
	bans: [],
};
const MODELS = {
	anthropic: [
		["claude-fable-5-2", "Claude Fable 5.2"],
		["claude-opus-5-5", "Claude Opus 5.5"],
		["claude-sonnet-5-5", "Claude Sonnet 5.5"],
		["claude-haiku-5-5", "Claude Haiku 5.5"],
	],
	"openai-codex": [
		["gpt-6-astra", "GPT-6 Astra"],
		["gpt-6.1-sol", "GPT-6.1 Sol"],
	],
};
const DEFAULT_NAME = "Claude Fable 5.2";
const HIGH_NAME = "Claude Opus 5.5";

function unreachableModels(agentDir) {
	mkdirSync(agentDir, { recursive: true });
	noRetries(agentDir);
	const providers = {};
	const auth = {};
	for (const [p, ms] of Object.entries(MODELS)) {
		auth[p] = { type: "api_key", key: "dummy" };
		providers[p] = {
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:1",
			apiKey: "dummy",
			models: ms.map(([id, name]) => ({
				id,
				name,
				reasoning: true,
				input: ["text"],
				contextWindow: 32000,
				maxTokens: 4096,
			})),
		};
	}
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify(auth));
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers }));
}

const T = { ops: "Ops lead", task: "Queue #5: Tidy the logs", plain: "A plain chat" };
const files = {};
let idDir = "";
let home = "";
function seed({ root, agentDir, workdir }) {
	home = join(root, "home");
	mkdirSync(home, { recursive: true });
	const settingsFile = join(agentDir, "settings.json");
	writeFileSync(
		settingsFile,
		JSON.stringify({
			retry: { enabled: false },
			defaultProvider: "anthropic",
			defaultModel: "claude-fable-5-2",
			defaultThinkingLevel: "high",
			extensions: [join(PKG, "index.ts")],
		}),
	);
	mkdirSync(join(agentDir, "model-routing", "tables"), { recursive: true });
	writeFileSync(join(agentDir, "model-routing", "tables", "ops.json"), JSON.stringify(TABLE));
	writeFileSync(join(agentDir, "model-bans.json"), JSON.stringify({ v: 1, bans: [] }));
	const store = Object.fromEntries(
		Object.entries(MODELS).map(([p, ms]) => [
			p,
			{ models: ms.map(([id, name]) => ({ id, name, reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } })) },
		]),
	);
	writeFileSync(join(agentDir, "models-store.json"), JSON.stringify(store));

	const dir = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(dir, { recursive: true });
	const file = (n) => join(dir, `2026-11-13T10-0${n}-00-000Z_01a0f000-0000-7000-8000-00000000090${n}.jsonl`);
	files.ops = file(1);
	files.task = file(2);
	files.plain = file(3);
	const plan = (title) => ({ title, goal: "g", doneWhen: "d", decided: "-", steps: "-", verify: "-", mustNot: "-" });
	const write = (path, start, name, items) => {
		let ts = Date.parse(start);
		const id = path.match(/_([^_]+)\.jsonl$/)?.[1];
		const at = () => new Date(ts).toISOString();
		const lines = [
			{ type: "session", version: 3, id, timestamp: at(), cwd: workdir },
			{
				type: "model_change",
				id: "mc",
				parentId: null,
				timestamp: at(),
				provider: "anthropic",
				modelId: "claude-fable-5-2",
			},
			{ type: "thinking_level_change", id: "tl", parentId: "mc", timestamp: at(), thinkingLevel: "high" },
		];
		let parentId = "tl";
		for (const item of items) {
			ts += 1000;
			const base = { id: `e${lines.length}`, parentId, timestamp: at() };
			lines.push(
				item.queue
					? { type: "custom", customType: "queue", ...base, data: { v: 1, ts, ...item.queue } }
					: { type: "message", ...base, message: { ...item.message, timestamp: ts } },
			);
			parentId = base.id;
		}
		lines.push({ type: "session_info", id: "name", parentId, timestamp: new Date(ts + 1000).toISOString(), name });
		writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	};
	const user = (text) => ({ message: { role: "user", content: [{ type: "text", text }] } });
	write(files.ops, "2026-11-13T10:01:00.000Z", T.ops, [
		user("EFFORT-OPS plan"),
		{ queue: { op: "add", id: 5, plan: plan("Tidy the logs"), touches: ["logs"], tier: "medium" } },
		{ queue: { op: "start", id: 5, lane: true } },
		{ queue: { op: "chat", id: 5, file: files.task, title: T.task } },
	]);
	write(files.task, "2026-11-13T10:02:00.000Z", T.task, [
		{
			queue: {
				op: "assigned",
				id: 5,
				tier: "medium",
				plan: plan("Tidy the logs"),
				touches: ["logs"],
				from: { file: files.ops, title: T.ops },
			},
		},
		user("EFFORT-TASK [Queue] Task #5"),
	]);
	write(files.plain, "2026-11-13T10:03:00.000Z", T.plain, [user("EFFORT-PLAIN hello")]);

	idDir = join(agentDir, "memory", "identities");
	mkdirSync(join(idDir, "ops"), { recursive: true });
	writeFileSync(join(idDir, "ops", "identity.json"), JSON.stringify({ id: "ops", title: "Ops", homeChat: files.ops }));
	writeFileSync(join(idDir, "ops", "about.md"), "# Ops\n\n**Focus:** tools for the test company.\n");
	writeFileSync(join(idDir, "ops", "notebook.md"), "rules\n");
}

// ---- the page ---------------------------------------------------------------------------------------------
const srv = await ownServer({
	name: "effort-level",
	model: unreachableModels,
	prepare: seed,
	env: {
		get HOME() {
			return home;
		},
		get PI_IDENTITY_DIR() {
			return idDir;
		},
		PI_IDENTITY_REINDEX: "0",
	},
});
const pageErrors = [];
let browser;

async function until(fn, timeout = 8000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await fn().catch(() => false)) return true;
		await new Promise((r) => setTimeout(r, 75));
	}
	return false;
}
async function openPage(width = 1440, theme = null) {
	const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
	await ctx.addInitScript((t) => {
		localStorage.setItem("pi-web-ui:lang", "en");
		if (t) localStorage.setItem("pi-web-ui:theme", t);
	}, theme);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => pageErrors.push(String(e)));
	await page.goto(srv.http);
	await page.waitForSelector(".topbar", { timeout: 60_000 });
	await page.locator(".inputbox textarea").waitFor({ timeout: 20_000 });
	return page;
}
/** Open a saved chat through search (Ctrl+K), as the owner would; wait for its first message. */
async function openChat(page, title, marker) {
	await page.keyboard.press("Control+k");
	await page.waitForSelector(".gs-modal", { timeout: 5000 });
	await page.fill(".gs-input-row input", title);
	await page.locator(".gs-item", { hasText: title }).first().click();
	await until(async () => (await page.locator(".messages").textContent()).includes(marker), 15_000);
}
/** The button's text, or null when it isn't shown. */
const buttonText = async (page) =>
	(await page.locator(BUTTON).count()) ? ((await page.locator(BUTTON).first().textContent()) ?? "").trim() : null;
const modelShown = async (page) => ((await page.locator(MODEL_CHIP).first().textContent()) ?? "").trim();
async function openMenu(page) {
	await page.locator(BUTTON).first().click();
	await page.locator('[role="menu"][aria-label="Department effort level"]').waitFor({ timeout: 3000 });
}
const menuRows = (page) =>
	page.locator('[role="menu"][aria-label="Department effort level"] [role="menuitemradio"]').allTextContents();
async function pick(page, label) {
	await openMenu(page);
	await page
		// The row whose level IS `label` ("High" must not match "Max · … @ xhigh").
		.locator('[role="menu"][aria-label="Department effort level"] [role="menuitemradio"]', {
			hasText: new RegExp(`^${label} · `),
		})
		.first()
		.click();
}
async function backToDefault(page) {
	await openMenu(page);
	await page
		.locator('[role="menu"][aria-label="Department effort level"] [role="menuitem"]', {
			hasText: "Back to department default",
		})
		.click();
}
const shot = async (page, name) => SHOT && (await page.screenshot({ path: `${SHOT}-${name}@2x.png`, scale: "device" }));
const AXE = process.env.PI_AXE_JS ?? join(userInfo().homedir, "temper-ai/configs/design/bin/vendor/axe-4.13.0.min.js");
async function menuAxe(page) {
	if (!existsSync(AXE)) return { error: `axe-core not found at ${AXE} (set PI_AXE_JS)` };
	await page.addScriptTag({ path: AXE });
	return page.evaluate(async () => {
		const menu = document.querySelector('[role="menu"][aria-label="Department effort level"]');
		const r = await window.axe.run(menu, { resultTypes: ["violations"] });
		const at = (n) =>
			`${n.target.join(" ")}${n.any?.[0]?.data?.contrastRatio ? ` ${n.any[0].data.contrastRatio}:1` : ""}`;
		return {
			bad: r.violations
				.filter((v) => v.impact === "serious" || v.impact === "critical")
				.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map(at).join(", ")}`),
		};
	});
}
const notBuilt = (detail) => `${NOT_BUILT}${detail ? `; ${detail}` : ""}`;

async function holdForLooks() {
	const hold = process.env.EFFORT_HOLD;
	if (!hold) return;
	const at = (f) => `${srv.http}/?chat=${encodeURIComponent(f)}`;
	writeFileSync(hold, JSON.stringify({ ops: at(files.ops), task: at(files.task), plain: at(files.plain) }));
	console.log(`holding the server for looks until ${hold} is deleted`);
	while (existsSync(hold)) await new Promise((r) => setTimeout(r, 500));
}

try {
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await openPage();

	// ---- 1. a lead's home chat ---------------------------------------------------------------------------------
	await openChat(page, T.ops, "EFFORT-OPS");
	const shown = await until(async () => (await buttonText(page)) === "Extra high");
	check(
		'ops\'s home chat shows the button with its lead tier, "Extra high"',
		shown,
		notBuilt(`button: ${await buttonText(page)}`),
	);
	if (shown) {
		await openMenu(page);
		const head = await page
			.locator('[role="menu"][aria-label="Department effort level"] .effort-menu-head')
			.textContent()
			.catch(() => "");
		check("the menu's header names the department's table", head?.trim() === "Ops table", String(head));
		const rows = await menuRows(page);
		check(
			'five rows, Max to Low, each "<level> · <model> @ <thinking>"',
			rows.length === 5 &&
				["Max", "Extra high", "High", "Medium", "Low"].every((l, i) => rows[i]?.startsWith(`${l} · `)) &&
				rows[1]?.includes("Fable 5.2 @ high") &&
				rows[2]?.includes("Opus 5.5 @ high"),
			JSON.stringify(rows),
		);
		check(
			"✓ and (default) on Extra high only",
			rows[1]?.includes("✓") && rows[1]?.includes("(default)") && rows.filter((r) => r.includes("✓")).length === 1,
			JSON.stringify(rows),
		);
		check("Low notes it is raised for a lead (not a named low job)", /raised to Medium/.test(rows[4] ?? ""), rows[4]);
		const items = await page
			.locator(
				'[role="menu"][aria-label="Department effort level"] [role="menuitem"], [role="menu"][aria-label="Department effort level"] [role="menuitemradio"]',
			)
			.allTextContents();
		check(
			'the last item is "Back to department default"',
			items.at(-1)?.trim() === "Back to department default",
			JSON.stringify(items),
		);
		await shot(page, "lead-menu");
		await page.keyboard.press("Escape");
	}

	// ---- 2. picking High switches the model menu's shown model -------------------------------------------------
	check(
		"before the pick the model menu shows the lead tier's model",
		(await modelShown(page)) === DEFAULT_NAME,
		await modelShown(page),
	);
	if (shown) await pick(page, "High");
	check(
		"picking High switches the model menu's shown model to the High row's",
		shown && (await until(async () => (await modelShown(page)) === HIGH_NAME)),
		notBuilt(`model: ${await modelShown(page)}`),
	);
	check(
		'the button now shows "High"',
		(await buttonText(page)) === "High",
		notBuilt(`button: ${await buttonText(page)}`),
	);

	// ---- 3. survives a reload ----------------------------------------------------------------------------------
	await page.reload();
	await page.locator(".inputbox textarea").waitFor({ timeout: 20_000 });
	await openChat(page, T.ops, "EFFORT-OPS");
	check(
		"after a reload the chat is still on High (kept until changed)",
		(await until(async () => (await buttonText(page)) === "High")) && (await modelShown(page)) === HIGH_NAME,
		notBuilt(`button: ${await buttonText(page)}, model: ${await modelShown(page)}`),
	);

	// ---- 4. back to the department default ---------------------------------------------------------------------
	if ((await buttonText(page)) !== null) await backToDefault(page);
	check(
		'"Back to department default" restores Extra high and its model',
		(await until(async () => (await buttonText(page)) === "Extra high")) &&
			(await until(async () => (await modelShown(page)) === DEFAULT_NAME)),
		notBuilt(`button: ${await buttonText(page)}, model: ${await modelShown(page)}`),
	);

	// ---- 5. a task chat shows it; a plain chat doesn't ---------------------------------------------------------
	await openChat(page, T.task, "EFFORT-TASK");
	check(
		'the task chat shows the button at its task\'s tier, "Medium"',
		await until(async () => (await buttonText(page)) === "Medium"),
		notBuilt(`button: ${await buttonText(page)}`),
	);
	await openChat(page, T.plain, "EFFORT-PLAIN");
	await until(async () => (await buttonText(page)) === null, 3000);
	check(
		"a plain chat (no role, no table) shows no button",
		(await buttonText(page)) === null,
		`button: ${await buttonText(page)}`,
	);
	await shot(page, "plain");

	// ---- 6. 320px ------------------------------------------------------------------------------------------------
	const narrow = await openPage(320);
	await openChat(narrow, T.ops, "EFFORT-OPS");
	const there = await until(async () => (await buttonText(narrow)) !== null);
	check("at 320px the button is shown", there, notBuilt());
	if (there) {
		const boxes = await narrow.evaluate((sel) => {
			const r = (el) => el?.getBoundingClientRect();
			const b = r(document.querySelector(sel));
			const others = [...document.querySelectorAll(".composer-tools .chip")]
				.filter((c) => !c.matches(sel) && !c.contains(document.querySelector(sel)))
				.map(r);
			const hit = others.filter(
				(o) => o && b && o.left < b.right && b.left < o.right && o.top < b.bottom && b.top < o.bottom,
			);
			return { inside: Boolean(b) && b.left >= 0 && b.right <= window.innerWidth, overlaps: hit.length };
		}, BUTTON);
		check(
			"at 320px the button fits and overlaps no other composer chip",
			boxes.inside && boxes.overlaps === 0,
			JSON.stringify(boxes),
		);
		await openMenu(narrow);
		const over = await findOverflow(narrow);
		check(
			"at 320px the open menu causes no overflow",
			over.ok && over.fixed.length === 0,
			describeOverflow(over, { fixed: true }),
		);
		await shot(narrow, "320-menu");
	}

	// ---- 7. the open menu is readable (axe, dark and White) ------------------------------------------------------
	for (const theme of [null, "white"]) {
		const tag = theme ?? "dark";
		const p = await openPage(1440, theme);
		await openChat(p, T.ops, "EFFORT-OPS");
		if (!(await until(async () => (await buttonText(p)) !== null))) {
			check(`${tag}: axe finds nothing serious or critical in the open menu`, false, notBuilt());
			continue;
		}
		await openMenu(p);
		const axe = await menuAxe(p);
		check(
			`${tag}: axe finds nothing serious or critical in the open menu`,
			!axe.error && axe.bad.length === 0,
			axe.error ?? axe.bad.join("; "),
		);
		await shot(p, `menu-${tag}`);
	}
	// ---- 8. a link straight to the chat (reload, a ?chat= link): the page's first ask must not be refused ----------
	// The window opens its last chat first, then the link's; asking while the server is still replaying the
	// page's startup commands got the ask refused ("A startup command was not processed") and no button.
	for (let round = 1; round <= 3; round++) {
		const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await ctx.addInitScript(() => localStorage.setItem("pi-web-ui:lang", "en"));
		const p = await ctx.newPage();
		p.on("pageerror", (e) => pageErrors.push(String(e)));
		const refused = [];
		p.on("websocket", (ws) =>
			ws.on("framereceived", ({ payload }) => {
				if (String(payload).includes("A startup command was not processed")) refused.push(round);
			}),
		);
		// Round 1 lands on the plain chat first, so the link's chat is a switch.
		await p.goto(`${srv.http}/?chat=${encodeURIComponent(round === 1 ? files.plain : files.task)}`);
		await p.goto(`${srv.http}/?chat=${encodeURIComponent(files.ops)}`);
		const ok = await until(async () => (await buttonText(p)) === "Extra high", 15_000);
		check(
			`link straight to ops's home chat (round ${round}): the button shows, no ask refused`,
			ok && refused.length === 0,
			`button: ${await buttonText(p)}; refused notices: ${refused.length}`,
		);
		await ctx.close();
	}
	check("no page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
} catch (e) {
	check("the test ran to the end", false, String(e?.stack ?? e).slice(0, 500));
} finally {
	await browser?.close().catch(() => {});
	await holdForLooks();
	await srv.stop();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
