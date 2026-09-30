/* fast-mode E2E (no tokens): the "⚡ Fast" button of ChatGPT chats.
 *
 * A mock model plays two providers: ChatGPT sign-in (openai-codex, model gpt-5.6-sol, a fast-mode
 * model) and Claude (anthropic). The test never prints what the page sends to the model; it only
 * checks whether each request carried the fast tier.
 * Checks:
 *  - a ChatGPT chat on a fast-mode model shows the button, off, with its tip; its requests carry no tier;
 *  - on: highlighted, and the chat's requests carry service_tier "priority";
 *  - the choice survives a page reload and a server restart;
 *  - ChatGPT refuses fast mode (HTTP 400): the reply still comes (once, at normal speed, no error
 *    left in the chat, the message not sent twice); the button says "Normal speed for now" with the
 *    reason in its tip; the next message goes at normal speed; off-and-on tries fast again;
 *  - a Claude model: no button, no tier (even with the chat's fast on); back on ChatGPT the button
 *    is back, still on;
 *  - a new chat starts off;
 *  - a phone: the button is in the message box's tool row, finger-sized, and works;
 *  - no page errors.
 * Usage: npm run build && node tests/fast-mode-test.mjs
 *        FAST_SHOT=/tmp/fast saves screenshots /tmp/fast-*.png
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { ownServer } from "./lib/own-server.mjs";

const SHOT = process.env.FAST_SHOT ?? "";
const TA = ".inputbox textarea";
const CHIP = ".composer-tools .fast-chip";
const TIP = "Fast mode: faster replies; uses your ChatGPT plan's limits 2.5\u00d7 quicker";
const REASON = "ChatGPT refused fast mode (HTTP 400)";
const REFUSAL_TEXT = "Unsupported value: 'service_tier' does not support 'priority' with this model.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`  ${ok ? "✓" : "✗ FAIL:"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};
async function waitFor(fn, ms, step = 100) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await fn()) return true;
		await sleep(step);
	}
	return false;
}

// ---- the mock model: notes whether each request carried the fast tier (never the request itself) ----
const tokenOf = (text) => text.match(/FM-[A-Z0-9]+/)?.[0] ?? "";
/** token → the tier of each request made for it (null = none), in order. */
const tiers = new Map();
const srv = await ownServer({
	name: "fast-mode",
	mock: ({ payload, lastUser, sideRequest }) => {
		if (sideRequest) return "Fast mode chat";
		const token = tokenOf(lastUser);
		const tier = typeof payload.service_tier === "string" ? payload.service_tier : null;
		if (!tiers.has(token)) tiers.set(token, []);
		tiers.get(token).push(tier);
		if (token.startsWith("FM-REFUSE") && tier)
			return {
				httpStatus: 400,
				error: {
					message: REFUSAL_TEXT,
					type: "invalid_request_error",
					param: "service_tier",
					code: "unsupported_value",
				},
			};
		return `ANSWER for ${token || "something"}.`;
	},
	prepare: async ({ agentDir }) => {
		// Two providers on the mock: ChatGPT sign-in with a fast-mode model, and Claude.
		const modelsPath = join(agentDir, "models.json");
		const cfg = JSON.parse(readFileSync(modelsPath, "utf8"));
		const base = Object.values(cfg.providers)[0];
		const model = (id, name) => ({ id, name, input: ["text"], contextWindow: 32000, maxTokens: 4096 });
		cfg.providers = {
			"openai-codex": { ...base, models: [model("gpt-5.6-sol", "Mock Sol")] },
			anthropic: { ...base, models: [model("claude-mock", "Mock Claude")] },
		};
		writeFileSync(modelsPath, JSON.stringify(cfg));
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({
				"openai-codex": { type: "api_key", key: "mock" },
				anthropic: { type: "api_key", key: "mock" },
			}),
		);
		const settingsPath = join(agentDir, "settings.json");
		const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
		writeFileSync(
			settingsPath,
			JSON.stringify({ ...settings, defaultProvider: "openai-codex", defaultModel: "gpt-5.6-sol" }, null, 2),
		);
	},
});

const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e?.message ?? e)));

const messagesText = (p = page) => p.evaluate(() => document.querySelector(".messages")?.textContent ?? "");
const answered = (token, p = page) =>
	waitFor(async () => (await messagesText(p)).includes(`ANSWER for ${token}`), 30_000);
const idle = (p = page) => waitFor(async () => (await p.locator(".btn.stop").count()) === 0, 30_000);
async function send(text, p = page) {
	await p.locator(TA).fill(text);
	await p.keyboard.press("Enter");
}
/** The button as the page shows it (null = no button). */
function chipState(p = page) {
	return p.evaluate((sel) => {
		const el = document.querySelector(sel);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return {
			on: el.classList.contains("on"),
			cooling: el.classList.contains("cooling"),
			pressed: el.getAttribute("aria-pressed"),
			tip: el.getAttribute("data-tip") ?? "",
			text: el.textContent ?? "",
			visible: r.width > 0 && r.height > 0,
			w: Math.round(r.width),
			h: Math.round(r.height),
		};
	}, CHIP);
}
const modelName = (p = page) =>
	p.evaluate(() => document.querySelector(".composer-tools .chip-model")?.textContent ?? "");
async function pickModel(name, p = page) {
	// The chip itself: on a phone its name is hidden (icon-only chips).
	await p.locator(".composer-tools .chip:has(.chip-model)").first().click();
	await p.locator(".dd-menu-model .dd-model-name", { hasText: name }).first().click();
	return waitFor(async () => (await modelName(p)) === name, 10_000);
}
const userBubbles = (token, p = page) =>
	p.evaluate(
		(t) =>
			[...document.querySelectorAll(".messages .msg-user")].filter((el) => (el.textContent || "").includes(t)).length,
		token,
	);
async function shot(name, p = page, opts = {}) {
	if (!SHOT) return;
	await p.screenshot({ path: `${SHOT}-${name}.png`, ...opts });
	console.log(`    screenshot: ${SHOT}-${name}.png`);
}
/** A picture of the message box with the tip bubble above the button. */
async function tipShot(name, p = page) {
	if (!SHOT) return;
	await p.locator(CHIP).hover();
	await sleep(400);
	const box = await p.locator(".inputbox").boundingBox();
	const vp = p.viewportSize();
	const y = Math.max(0, box.y - 90);
	await shot(name, p, {
		clip: {
			x: Math.max(0, box.x - 10),
			y,
			width: Math.min(vp.width, box.width + 20),
			height: Math.min(vp.height - y, box.height + 100),
		},
	});
	await p.mouse.move(5, 5);
}

try {
	await page.goto(srv.http);
	await page.waitForSelector(TA, { timeout: 30_000 });

	// ---- 1. a ChatGPT chat on a fast-mode model: the button, off -------------------------------
	console.log("1. a ChatGPT chat on a fast-mode model");
	check(
		"the chat is on the ChatGPT model",
		await waitFor(async () => (await modelName()) === "Mock Sol", 15_000),
		await modelName(),
	);
	check("the ⚡ Fast button shows", await waitFor(async () => (await chipState())?.visible === true, 10_000));
	let st = await chipState();
	check("it starts off", st?.on === false && st?.pressed === "false", JSON.stringify(st));
	check("its tip", st?.tip === TIP, st?.tip);
	check("it says Fast with the ⚡", !!st && st.text.includes("\u26a1") && st.text.includes("Fast"), st?.text);
	await shot("desktop-off");
	await tipShot("desktop-tip");
	await send("hello FM-OFF1");
	check("answered", await answered("FM-OFF1"));
	check(
		"off: the request went at normal speed",
		JSON.stringify(tiers.get("FM-OFF1")) === "[null]",
		JSON.stringify(tiers.get("FM-OFF1")),
	);
	await idle();

	// ---- 2. on ---------------------------------------------------------------------------------
	console.log("2. turned on");
	await page.locator(CHIP).click();
	check("highlighted", await waitFor(async () => (await chipState())?.on === true, 5000));
	st = await chipState();
	check("pressed, same tip", st?.pressed === "true" && st?.tip === TIP && !st?.cooling, JSON.stringify(st));
	await shot("desktop-on");
	await send("hello FM-ON1");
	check("answered", await answered("FM-ON1"));
	check(
		'on: the request carried service_tier "priority"',
		JSON.stringify(tiers.get("FM-ON1")) === '["priority"]',
		JSON.stringify(tiers.get("FM-ON1")),
	);
	await idle();

	// ---- 3. remembered: reload, server restart ------------------------------------------------
	console.log("3. remembered through a reload and a restart");
	await page.reload();
	await page.waitForSelector(TA, { timeout: 30_000 });
	check(
		"after a reload: still on",
		await waitFor(async () => (await chipState())?.on === true, 15_000),
		JSON.stringify(await chipState()),
	);
	await srv.restart();
	await page.reload();
	await page.waitForSelector(TA, { timeout: 30_000 });
	if (!(await waitFor(async () => (await messagesText()).includes("FM-ON1"), 8000))) {
		const rows = page.locator(".lp-row .session-item");
		for (let i = 0; i < (await rows.count()); i++) {
			await rows.nth(i).click();
			if (await waitFor(async () => (await messagesText()).includes("FM-ON1"), 3000)) break;
		}
	}
	check("the chat is open again", (await messagesText()).includes("FM-ON1"));
	check(
		"after a server restart: still on",
		await waitFor(async () => (await chipState())?.on === true, 15_000),
		JSON.stringify(await chipState()),
	);
	await send("again FM-ON3");
	check("answered", await answered("FM-ON3"));
	check(
		"still sent fast after the restart",
		JSON.stringify(tiers.get("FM-ON3")) === '["priority"]',
		JSON.stringify(tiers.get("FM-ON3")),
	);
	await idle();

	// ---- 4. ChatGPT refuses fast mode -----------------------------------------------------------
	console.log("4. ChatGPT refuses fast mode");
	await send("please FM-REFUSE1");
	check("the reply still comes", await answered("FM-REFUSE1"));
	await idle();
	check(
		"one refused fast request, then one at normal speed",
		JSON.stringify(tiers.get("FM-REFUSE1")) === '["priority",null]',
		JSON.stringify(tiers.get("FM-REFUSE1")),
	);
	check("the message shows once", (await userBubbles("FM-REFUSE1")) === 1, String(await userBubbles("FM-REFUSE1")));
	check("one answer", ((await messagesText()).match(/ANSWER for FM-REFUSE1/g) ?? []).length === 1);
	check("no error left in the chat", !(await messagesText()).includes("Unsupported value"));
	st = await chipState();
	check(
		'the button: "Normal speed for now", dimmed',
		!!st?.on && !!st?.cooling && st.text.includes("Normal speed for now"),
		JSON.stringify(st),
	);
	check("its tip gives the reason", !!st?.tip.includes(REASON) && st.tip.includes(TIP), st?.tip);
	await shot("desktop-cooling");
	await tipShot("desktop-cooling-tip");
	await send("next FM-COOL1");
	check("answered", await answered("FM-COOL1"));
	check(
		"while cooling down: normal speed",
		JSON.stringify(tiers.get("FM-COOL1")) === "[null]",
		JSON.stringify(tiers.get("FM-COOL1")),
	);
	await idle();
	// Off and on again: tries fast right away.
	await page.locator(CHIP).click();
	check("off", await waitFor(async () => (await chipState())?.on === false, 5000));
	check("off clears the notice", (await chipState())?.cooling === false);
	await page.locator(CHIP).click();
	check(
		"on again, not cooling",
		await waitFor(async () => {
			const s = await chipState();
			return s?.on === true && s.cooling === false;
		}, 5000),
	);
	await send("and FM-ON2");
	check("answered", await answered("FM-ON2"));
	check(
		"fast again right away",
		JSON.stringify(tiers.get("FM-ON2")) === '["priority"]',
		JSON.stringify(tiers.get("FM-ON2")),
	);
	await idle();

	// ---- 5. Claude: no button, never the tier ---------------------------------------------------
	console.log("5. Claude");
	check("switched to Claude", await pickModel("Mock Claude"));
	check("no button on Claude", await waitFor(async () => (await chipState()) === null, 5000));
	await shot("desktop-claude");
	await send("hi FM-CLAUDE1");
	check("answered", await answered("FM-CLAUDE1"));
	check(
		"Claude's request carried no tier",
		JSON.stringify(tiers.get("FM-CLAUDE1")) === "[null]",
		JSON.stringify(tiers.get("FM-CLAUDE1")),
	);
	await idle();
	check("back on ChatGPT", await pickModel("Mock Sol"));
	check(
		"the button is back, still on",
		await waitFor(async () => (await chipState())?.on === true, 5000),
		JSON.stringify(await chipState()),
	);

	// ---- 6. a new chat starts off -----------------------------------------------------------------
	console.log("6. a new chat");
	await page.locator(".lp-new-chat-action").click();
	check("new chat opened", await waitFor(async () => !(await messagesText()).includes("FM-ON1"), 10_000));
	check(
		"on the ChatGPT model",
		await waitFor(async () => (await modelName()) === "Mock Sol", 10_000),
		await modelName(),
	);
	check(
		"its button starts off",
		await waitFor(async () => (await chipState())?.on === false, 10_000),
		JSON.stringify(await chipState()),
	);
	await send("new FM-NEW1");
	check("answered", await answered("FM-NEW1"));
	check("at normal speed", JSON.stringify(tiers.get("FM-NEW1")) === "[null]", JSON.stringify(tiers.get("FM-NEW1")));
	await idle();

	// ---- 7. a phone ------------------------------------------------------------------------------
	console.log("7. a phone");
	const phone = await browser.newPage({
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
		deviceScaleFactor: 2,
	});
	phone.on("pageerror", (e) => pageErrors.push(String(e?.message ?? e)));
	await phone.goto(srv.http);
	await phone.waitForSelector(TA, { timeout: 30_000 });
	check("the button shows on a phone", await waitFor(async () => (await chipState(phone))?.visible === true, 15_000));
	st = await chipState(phone);
	check("finger-sized (44 px)", !!st && st.w >= 44 && st.h >= 44, `${st?.w}×${st?.h}`);
	check("off in this new chat", st?.on === false, JSON.stringify(st));
	await shot("phone-off", phone);
	await phone.locator(CHIP).tap();
	check("a tap turns it on", await waitFor(async () => (await chipState(phone))?.on === true, 5000));
	await shot("phone-on", phone);
	await tipShot("phone-tip", phone);
	await send("phone FM-PHONE1", phone);
	check("answered", await answered("FM-PHONE1", phone));
	check("sent fast", JSON.stringify(tiers.get("FM-PHONE1")) === '["priority"]', JSON.stringify(tiers.get("FM-PHONE1")));
	await idle(phone);
	check("switched to Claude on the phone", await pickModel("Mock Claude", phone));
	check("no button on Claude", await waitFor(async () => (await chipState(phone)) === null, 5000));
	await shot("phone-claude", phone);
	await phone.close();

	check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (e) {
	failures++;
	console.log(`  ✗ FAIL: ${e?.stack ?? e}`);
} finally {
	await browser.close();
	await srv.stop();
	await srv.mock?.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll fast-mode checks passed");
process.exit(failures ? 1 : 0);
