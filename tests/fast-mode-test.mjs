/* Sealed browser speed checks. Mock traffic is never printed: only tier, app-state and count assertions.
 * FAST_SHOT saves desktop/phone selector and fallback screenshots. No live model or real chats. */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { ownServer } from "./lib/own-server.mjs";
const SHOT = process.env.FAST_SHOT ?? "";
const TA = ".inputbox textarea",
	CHIP = ".composer-tools .fast-chip",
	MENU = ".composer-tools .speed-menu";
const tiers = new Map();
let toolsOffered = 0;
const srv = await ownServer({
	name: "chat-speed",
	mock: ({ payload, lastUser, sideRequest, toolResult }) => {
		if (sideRequest) return "Speed test";
		const token = lastUser.match(/FM-[A-Z0-9]+/)?.[0] ?? "";
		const tier = typeof payload.service_tier === "string" ? payload.service_tier : null;
		if (!tiers.has(token)) tiers.set(token, []);
		tiers.get(token).push(tier);
		if (token === "FM-TOOL" && !toolResult) {
			toolsOffered++;
			return { tool: "bash", args: { command: "true" } };
		}
		if ((token.startsWith("FM-REFUSE") || token === "FM-TOOL") && tier)
			return {
				httpStatus: 400,
				error: { message: "Unsupported service_tier ultrafast", type: "invalid_request_error", param: "service_tier" },
			};
		if (token === "FM-SLOW") return { text: `ANSWER ${token}`, stream: { everyMs: 150, pieceChars: 1 } };
		return `ANSWER ${token}`;
	},
	prepare: async ({ agentDir }) => {
		const path = join(agentDir, "models.json"),
			cfg = JSON.parse(readFileSync(path, "utf8")),
			base = Object.values(cfg.providers)[0];
		const model = (id, name) => ({ id, name, input: ["text"], contextWindow: 32000, maxTokens: 4096 });
		cfg.providers = {
			"openai-codex": { ...base, models: [model("gpt-6-astra", "Mock Astra"), model("gpt-5.6-sol", "Mock Sol")] },
			anthropic: { ...base, models: [model("claude-mock", "Mock Claude")] },
		};
		writeFileSync(path, JSON.stringify(cfg));
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ "openai-codex": { type: "api_key", key: "mock" }, anthropic: { type: "api_key", key: "mock" } }),
		);
		const settingsPath = join(agentDir, "settings.json"),
			settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
		writeFileSync(
			settingsPath,
			JSON.stringify({
				...settings,
				defaultProvider: "openai-codex",
				defaultModel: "gpt-6-astra",
				toolApprovalEnabled: false,
			}),
		);
	},
});
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
// Track only sanitized app state; this does not inspect model-bound traffic.
await context.addInitScript(() => {
	const Native = window.WebSocket;
	window.WebSocket = class extends Native {
		constructor(...args) {
			super(...args);
			window.speedSocket = this;
			this.addEventListener("message", (event) => {
				try {
					const msg = JSON.parse(event.data);
					if (msg.type === "snapshot" || msg.type === "snapshot_delta") {
						const s = msg.state;
						if (!s) return;
						window.speedState = {
							...window.speedState,
							...(s.conversationId ? { id: s.conversationId } : {}),
							...(Object.hasOwn(s, "fastMode") ? { speed: s.fastMode } : {}),
							...(Object.hasOwn(s, "isStreaming") ? { streaming: s.isStreaming } : {}),
						};
					}
				} catch {
					/* non-state frame */
				}
			});
		}
	};
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", () => errors.push(true));
let failures = 0;
function check(name, ok) {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
	if (!ok) failures++;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 15000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await fn()) return true;
		await wait(75);
	}
	return false;
}
const state = (p = page) => p.evaluate(() => window.speedState ?? {});
const saved = async (mode, p = page) => until(async () => (await state(p)).speed?.mode === mode);
const idle = (p = page) => until(async () => (await state(p)).streaming === false, 30000);
async function openMenu(p = page) {
	if (!(await p.locator(MENU).count())) await p.locator(CHIP).click();
}
async function choose(mode, p = page) {
	await openMenu(p);
	await p.locator(`${MENU} input[value="${mode}"]`).click();
	check(`saved ${mode}`, await saved(mode, p));
	await p.keyboard.press("Escape");
}
async function send(token, p = page) {
	await p.locator(TA).fill(`hello ${token}`);
	await p.keyboard.press("Enter");
	check(
		`answer ${token}`,
		await until(async () => (await p.locator(".messages").textContent()).includes(`ANSWER ${token}`), 30000),
	);
	await idle(p);
}
function tierCheck(token, expected) {
	check(`tier dispatch ${token}`, JSON.stringify(tiers.get(token)) === JSON.stringify(expected));
}
async function shot(name, p = page) {
	if (SHOT) await p.screenshot({ path: `${SHOT}-${name}.png` });
}
async function model(name, p = page) {
	await p.locator(".composer-tools .chip:has(.chip-model)").first().click();
	await p.locator(".dd-menu-model .dd-model-name", { hasText: name }).first().click();
	await until(async () => (await p.locator(".composer-tools .chip-model").textContent()) === name);
}
async function wire(mode, id, p = page) {
	await p.evaluate(
		({ mode, id }) => window.speedSocket.send(JSON.stringify({ type: "set_fast_mode", mode, conversationId: id })),
		{ mode, id },
	);
}
try {
	await page.goto(srv.http);
	await page.waitForSelector(TA);
	check("new Astra chat starts Standard", await saved("standard"));
	await openMenu();
	check("three accessible speed choices", (await page.locator(`${MENU} input[type=radio]`).count()) === 3);
	check(
		"usage and eligibility help",
		await page
			.locator(MENU)
			.evaluate((el) => ["2.5×", "8×", "6×", "Pro $500", "unconfirmed"].every((text) => el.textContent.includes(text))),
	);
	await shot("desktop-standard");
	await page.keyboard.press("Escape");
	check("Escape restores focus", await page.locator(CHIP).evaluate((el) => document.activeElement === el));
	await send("FM-STANDARD");
	tierCheck("FM-STANDARD", [null]);
	await choose("fast");
	await send("FM-FAST");
	tierCheck("FM-FAST", ["priority"]);
	await choose("ultrafast");
	await send("FM-ULTRA");
	tierCheck("FM-ULTRA", ["ultrafast"]);
	check("request is not called confirmed", (await state()).speed?.confirmedMode === undefined);
	await openMenu();
	await shot("desktop-ultrafast");
	await page.keyboard.press("Escape");
	const firstId = (await state()).id;
	await wire("standard", "stale-id");
	await wait(250);
	check("stale conversation cannot change speed", (await state()).speed?.mode === "ultrafast");
	await wire("nonsense", firstId);
	await wait(250);
	check("invalid wire mode cannot change speed", (await state()).speed?.mode === "ultrafast");
	await page.locator(TA).fill("hello FM-SLOW");
	await page.keyboard.press("Enter");
	check("stream started", await until(async () => (await state()).streaming === true));
	check("selector disabled during streaming", await page.locator(CHIP).isDisabled());
	await wire("standard", firstId);
	await idle();
	check("server also refuses mid-stream change", (await state()).speed?.mode === "ultrafast");

	await page.reload();
	await page.waitForSelector(TA);
	check("reload preserves Ultrafast", await saved("ultrafast"));
	await srv.restart();
	await page.reload();
	await page.waitForSelector(TA);
	if (!(await saved("ultrafast"))) {
		const rows = page.locator(".lp-row .session-item");
		for (let i = 0; i < (await rows.count()); i++) {
			await rows.nth(i).click();
			if (await until(async () => (await state()).speed?.mode === "ultrafast", 2000)) break;
		}
	}
	check("reopen after server restart preserves choice", (await state()).speed?.mode === "ultrafast");
	await send("FM-REOPEN");
	tierCheck("FM-REOPEN", ["ultrafast"]);
	await send("FM-REFUSE1");
	tierCheck("FM-REFUSE1", ["ultrafast", null]);
	check(
		"refused mode remains saved with effective Standard",
		(await state()).speed?.mode === "ultrafast" && (await state()).speed?.effective === "standard",
	);
	check(
		"one user bubble and one answer, no displayed refusal",
		await page.evaluate(() => {
			const text = document.querySelector(".messages")?.textContent ?? "";
			return (
				[...document.querySelectorAll(".msg-user")].filter((el) => el.textContent.includes("FM-REFUSE1")).length ===
					1 &&
				(text.match(/ANSWER FM-REFUSE1/g) ?? []).length === 1 &&
				!text.includes("Unsupported service_tier")
			);
		}),
	);
	check(
		"temporary Standard is visible on closed selector",
		(await page.locator(CHIP).textContent()).includes("Standard · now"),
	);
	await openMenu();
	check(
		"fallback reason shown",
		(await page.locator(`${MENU} [role=status]`).textContent()).includes("refused Ultrafast"),
	);
	await shot("desktop-fallback");
	await page.keyboard.press("Escape");
	await send("FM-COOL");
	tierCheck("FM-COOL", [null]);
	await choose("standard");
	await choose("ultrafast");
	await send("FM-TOOL");
	tierCheck("FM-TOOL", ["ultrafast", "ultrafast", null]);
	check("completed tool not replayed", toolsOffered === 1);
	await choose("standard");
	await choose("ultrafast");
	await model("Mock Sol");
	check("Astra choice does not leak into Sol", (await state()).speed?.effective === "standard");
	await openMenu();
	check("Sol only offers Standard/Fast", (await page.locator(`${MENU} input`).count()) === 2);
	await page.keyboard.press("Escape");
	await send("FM-SOL");
	tierCheck("FM-SOL", [null]);
	await model("Mock Claude");
	check("no selector on Claude", await until(async () => (await page.locator(CHIP).count()) === 0));
	await send("FM-CLAUDE");
	tierCheck("FM-CLAUDE", [null]);
	await model("Mock Astra");
	check("returning to Astra restores saved Ultrafast", await saved("ultrafast"));
	await page.locator(".lp-new-chat-action").click();
	check("another chat starts Standard", await saved("standard"));
	await send("FM-NEW");
	tierCheck("FM-NEW", [null]);

	const phone = await context.newPage();
	await phone.setViewportSize({ width: 390, height: 844 });
	phone.on("pageerror", () => errors.push(true));
	await phone.goto(srv.http);
	await phone.waitForSelector(TA);
	const desktopId = (await state()).id;
	await phone.evaluate(() => window.speedSocket.send(JSON.stringify({ type: "new_chat" })));
	check("phone uses a distinct disposable chat", await until(async () => (await state(phone)).id !== desktopId));
	check("phone starts Standard", await saved("standard", phone));
	const box = await phone.locator(CHIP).boundingBox();
	check("phone selector finger-sized", box?.width >= 44 && box?.height >= 44);
	await openMenu(phone);
	await shot("phone-standard", phone);
	check(
		"phone panel stays on screen",
		await phone.locator(MENU).evaluate((el) => {
			const r = el.getBoundingClientRect();
			return r.x >= 0 && r.right <= innerWidth && r.top >= 0;
		}),
	);
	await phone.keyboard.press("Escape");
	await choose("ultrafast", phone);
	check("phone choice leaves other chat Standard", (await state()).speed?.mode === "standard");
	await send("FM-ISOLATED");
	tierCheck("FM-ISOLATED", [null]);
	await send("FM-REFUSEPHONE", phone);
	tierCheck("FM-REFUSEPHONE", ["ultrafast", null]);
	await openMenu(phone);
	await shot("phone-fallback", phone);
	check(
		"phone composer never overflows",
		await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
	);
	await phone.close();
	check("no page errors", errors.length === 0);
} catch (e) {
	failures++;
	console.log(`FAIL browser step: ${String(e.message).split("\n")[0]}`);
} finally {
	await browser.close();
	await srv.stop();
	await srv.mock?.close();
	rmSync(srv.root, { recursive: true, force: true });
}
console.log(failures ? `${failures} speed checks failed` : "All speed checks passed");
process.exit(failures ? 1 : 0);
