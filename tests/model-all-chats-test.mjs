// Sealed, model-free browser proof. Only app state is observed; never model traffic.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";
import { revealTopbarItem } from "./lib/topbar.mjs";
import { ClientStateStore } from "../dist/server/client-state.js";

const ALPHA = "all-chats-fixture/alpha",
	BETA = "all-chats-fixture/beta";
const MENU = ".dd-menu-model";
const CHIP = ".composer-tools .chip:has(.chip-model)";
const shots =
	process.env.MODEL_ALL_SHOT_DIR ??
	(process.env.PI_SEALED_REAL_AGENT_DIR
		? join(
				resolve(process.env.PI_SEALED_REAL_AGENT_DIR, "../.."),
				"kept-from-tmp",
				new Date().toISOString().slice(0, 10),
				"model-all-chats/screenshots",
			)
		: join(process.cwd(), "tests/scratch/model-all-chats"));
const fixtures = [];
let calls = 0;
// A tripwire only. No model output, payload, or transport is used by this test.
const tripwire = createServer((_req, res) => {
	calls++;
	res.writeHead(500);
	res.end();
});
await new Promise((r) => tripwire.listen(0, "127.0.0.1", r));
const modelPort = tripwire.address().port;
const server = await ownServer({
	name: "model-all-chats",
	model: "none",
	env: { PI_WEB_PLUGIN_CATALOG_URL: "off", PI_IDENTITY_DIR: "" },
	prepare: async ({ agentDir, dataDir, workdir }) => {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"all-chats-fixture": {
						baseUrl: `http://127.0.0.1:${modelPort}/v1`,
						api: "openai-completions",
						apiKey: "fixture-only",
						models: ["alpha", "beta"].map((id) => ({
							id,
							name: `Fixture ${id === "alpha" ? "Alpha" : "Beta"}`,
							input: ["text"],
							contextWindow: 32000,
							maxTokens: 4096,
							reasoning: false,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						})),
					},
				},
			}),
		);
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ "all-chats-fixture": { type: "api_key", key: "fixture-only" } }),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "all-chats-fixture",
				defaultModel: "alpha",
				packages: [],
				extensions: [],
				toolApprovalEnabled: false,
			}),
		);
		new ClientStateStore(join(dataDir, "client-state.json")).saveDefaultModel(ALPHA);
		// SDK-owned fixture creation, not direct transcript edits. These are the ONLY saved chats in the temp home.
		const sessionDir = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
		for (const name of ["Open fixture A", "Open fixture B", "Saved fixture C"]) {
			const sm = SessionManager.create(workdir, sessionDir);
			sm.appendModelChange("all-chats-fixture", "alpha");
			sm.appendMessage({ role: "user", content: name, timestamp: Date.now() });
			sm.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "Sealed fixture, no model call." }],
				api: "openai-completions",
				provider: "all-chats-fixture",
				model: "alpha",
				stopReason: "stop",
				timestamp: Date.now(),
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			sm.appendSessionInfo(name);
			fixtures.push({ id: sm.getSessionId(), path: sm.getSessionFile() });
		}
	},
});
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const contexts = [];
const errors = [];
async function page() {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
	contexts.push(ctx);
	await ctx.addInitScript(() => {
		const Native = window.WebSocket;
		window.WebSocket = class extends Native {
			constructor(...args) {
				super(...args);
				window.modelTestSocket = this;
				this.addEventListener("message", (ev) => {
					try {
						const msg = JSON.parse(ev.data);
						if (msg.type === "snapshot" || msg.type === "snapshot_delta") {
							const s = msg.state;
							if (s?.conversationId) window.modelTestId = s.conversationId;
							if (s?.sessionId) window.modelTestSession = s.sessionId;
						}
						if (msg.type === "default_model") window.modelTestDefault = msg.modelId;
						if (msg.type === "notice") window.modelTestNotice = msg.textEn ?? msg.text;
					} catch {
						/* non-state frame */
					}
				});
			}
		};
	});
	const p = await ctx.newPage();
	p.on("pageerror", () => errors.push(true));
	await p.goto(server.http);
	await p.waitForSelector(".inputbox textarea", { timeout: 30000 });
	await p.waitForFunction(() => window.modelTestSocket?.readyState === 1 && window.modelTestId);
	return p;
}
const check = (name, ok) => {
	assert.ok(ok, name);
	console.log(`PASS ${name}`);
};
async function wire(p, msg) {
	await p.evaluate((m) => window.modelTestSocket.send(JSON.stringify(m)), msg);
}
async function open(p, fixture) {
	await wire(p, { type: "switch_session", path: fixture.path });
	await p.waitForFunction((id) => window.modelTestSession === id, fixture.id, { timeout: 20000 });
}
async function menu(p) {
	if (!(await p.locator(MENU).count())) await (await revealTopbarItem(p, CHIP)).click();
	await p.locator(MENU).waitFor({ state: "visible" });
}
async function choose(p, name) {
	await menu(p);
	await p
		.locator(`${MENU} .dd-model-name`)
		.filter({ hasText: new RegExp(`^${name}$`) })
		.click();
	await modelIs(p, name);
}
async function modelIs(p, name) {
	await p.waitForFunction(
		(n) => [...document.querySelectorAll(".composer-tools .chip-model")].some((e) => e.textContent === n),
		name,
	);
}
const state = () => new ClientStateStore(join(server.dataDir, "client-state.json"));
let failed = false;
try {
	const a = await page(),
		b = await page();
	await open(a, fixtures[0]);
	await open(b, fixtures[1]);
	await modelIs(a, "Fixture Alpha");
	await modelIs(b, "Fixture Alpha");
	const savedBefore = readFileSync(fixtures[2].path, "utf8");
	await choose(a, "Fixture Beta");
	await menu(a);
	check(
		"visible buttons replace row stars",
		(await a.locator(`${MENU} .dd-star-btn`).count()) === 0 &&
			(await a.getByRole("button", { name: "Make default", exact: true }).isVisible()),
	);
	await a.getByRole("button", { name: "All chats", exact: true }).click();
	check(
		"confirmation is one question with Switch and Cancel",
		(await a.getByRole("alertdialog").innerText()) === "Switch all chats to Fixture Beta?\nSwitch\nCancel",
	);
	await a.getByRole("button", { name: "Cancel", exact: true }).click();
	check("cancel saves no press", state().getAllChatsModel() === undefined);
	await a.getByRole("button", { name: "All chats", exact: true }).click();
	await a.getByRole("button", { name: "Switch", exact: true }).click();
	await modelIs(a, "Fixture Beta");
	await modelIs(b, "Fixture Beta");
	check("both open chats use this chat's model", true);
	await a.waitForFunction(() => /\d+ open chats switched/.test(window.modelTestNotice ?? ""));
	check("notice gives the open-chat switch count", true);
	check("saved transcript is not edited by the press", readFileSync(fixtures[2].path, "utf8") === savedBefore);
	check("all chats preserves the app default", state().getDefaultModel() === ALPHA);
	await menu(a);
	check(
		"existing default banner unchanged",
		(await a.locator(`${MENU} .dd-default-banner`).innerText()).includes("alpha"),
	);
	await a.keyboard.press("Escape");
	const c = await page();
	await open(c, fixtures[2]);
	await modelIs(c, "Fixture Beta");
	check("saved chat switches through normal open", true);
	await choose(b, "Fixture Alpha");
	check("manual pick changes open chat", true);
	await b.reload();
	await b.waitForSelector(".inputbox textarea");
	// New windows restore the app's most recently opened saved chat (C).
	// Reopen B explicitly so this assertion checks B's choice, not C's.
	await open(b, fixtures[1]);
	await modelIs(b, "Fixture Alpha");
	check("a pick after the press survives reload", true);
	const fresh = await page();
	await wire(fresh, { type: "new_chat" });
	await modelIs(fresh, "Fixture Alpha");
	check("new chats keep the old default", true);
	await menu(a);
	await a.getByRole("button", { name: "Make default", exact: true }).click();
	await a.waitForFunction((m) => window.modelTestDefault === m, BETA);
	check(
		"Make default sets existing star banner",
		(await a.locator(`${MENU} .dd-default-banner`).innerText()).includes("beta"),
	);
	check(
		"Make default hidden for current default",
		(await a.getByRole("button", { name: "Make default", exact: true }).count()) === 0,
	);
	await a.locator(`${MENU} .dd-default-banner-clear`).click();
	await a.waitForFunction(() => window.modelTestDefault === null);
	check("clear still removes default banner", (await a.locator(`${MENU} .dd-default-banner`).count()) === 0);
	// Dismiss the three tested notices before capturing the menu itself.
	while (await a.locator(".notice-close").count()) await a.locator(".notice-close").first().click();

	for (const width of [320, 390, 1440]) {
		await a.keyboard.press("Escape");
		await a.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
		await menu(a);
		check(
			`footer visible and page fits at ${width}`,
			(await a.getByRole("button", { name: "All chats", exact: true }).isVisible()) &&
				(await a.getByRole("button", { name: "Make default", exact: true }).isVisible()) &&
				(await a.evaluate(() => {
					const menu = document.querySelector(".dd-menu-model"),
						box = menu.getBoundingClientRect();
					return (
						document.documentElement.scrollWidth <= innerWidth + 1 && box.left >= -1 && box.right <= innerWidth + 1
					);
				})),
		);
		check(
			`actions are not covered by the send control at ${width}`,
			await a.evaluate(() =>
				[...document.querySelectorAll(".dd-model-actions > button")].every((button) => {
					const b = button.getBoundingClientRect();
					return [0.1, 0.5, 0.9].every((part) =>
						button.contains(document.elementFromPoint(b.left + b.width * part, b.top + b.height / 2)),
					);
				}),
			),
		);
		if (shots) {
			mkdirSync(shots, { recursive: true });
			await a.screenshot({ path: join(shots, `model-menu-${width}.png`) });
		}
		await a.getByRole("button", { name: "All chats", exact: true }).click();
		check(
			`compact confirmation fits at ${width}`,
			(await a.getByRole("button", { name: "Switch", exact: true }).isVisible()) &&
				(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)),
		);
		if (shots) await a.screenshot({ path: join(shots, `model-confirm-${width}.png`) });
		await a.getByRole("button", { name: "Cancel", exact: true }).click();
	}
	// This remains the SAME temp SDK home. Restart proves the dated record and later pick are durable.
	await server.restart();
	await b.reload();
	await b.waitForSelector(".inputbox textarea");
	await open(b, fixtures[1]);
	await modelIs(b, "Fixture Alpha");
	await c.reload();
	await c.waitForSelector(".inputbox textarea");
	await open(c, fixtures[2]);
	await modelIs(c, "Fixture Beta");
	check("restart retains bulk choice without overriding later manual choice", true);
	check("zero model calls and browser errors", calls === 0 && errors.length === 0);
} catch (err) {
	failed = true;
	console.error(`FAIL ${err.stack ?? err.message}`);
	if (shots) {
		mkdirSync(shots, { recursive: true });
		for (const [i, ctx] of contexts.entries())
			if (ctx.pages()[0])
				await ctx
					.pages()[0]
					.screenshot({ path: join(shots, `failure-${i}.png`) })
					.catch(() => {});
	}
} finally {
	await browser.close();
	await server.stop();
	await new Promise((r) => tripwire.close(r));
	rmSync(server.root, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
