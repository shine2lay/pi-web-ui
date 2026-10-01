/**
 * adaptive-math (fork patch, PATCHES.md): prices in a reply read as normal text, real formulas still
 * render. A server of its own with a stand-in model (tests never call a real model) that types a reply
 * holding the owner's AVGO prices, more price shapes, and four real formulas ($x^2$, \(a_i\), a $$
 * block and a \[ \] block), a piece at a time like a real model:
 *  1. while it streams, no formula ever shows that isn't one of the four (a formula that hasn't closed
 *     yet stays text, so nothing flickers into math and back) and KaTeX never reports an error;
 *  2. once it is done: exactly the four formulas render (two as display blocks), no KaTeX sits inside
 *     the price text, the bold around the prices is intact and the sentences read word for word;
 *  3. the user's own bubble follows the same rules (its prices stay text, its formula renders);
 *  4. the reply's copy button copies the original text, dollars and all.
 *
 * Usage: npm run build && node tests/adaptive-math-test.mjs
 *        MATH_SHOT=/tmp/am saves a screenshot /tmp/am-reply.png
 */
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";

const SHOT = process.env.MATH_SHOT ?? "";
let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✓" : "✗ FAIL:"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures += 1;
}

const REPLY = [
	"Take AVGO, where your $230 call is deep in the money:",
	"- **Now:** the stock is $353.55 and the call is $166.82, so the position is worth $186.73 a share.",
	"- **The gain:** $43.27 a share, $4,327 in all.",
	"",
	"So the net per day of **$85.49** is the $101.85 a day, between $100-$200 or $5/$10, about $2bn or $5M, $1,200.50 in all.",
	"",
	"The area is $x^2$ and the index is \\(a_i\\), while it costs $5 and $10.",
	"",
	"$$",
	"\\frac{a}{b} = c",
	"$$",
	"",
	"\\[",
	"E = mc^2",
	"\\]",
	"",
	"Done: QM-1.",
].join("\n");
const FORMULAS = ["x^2", "a_i", "\\frac{a}{b} = c", "E = mc^2"];
const PROMPT = "QM-1 my budget is $5 and $10, and $y^2$ is the curve";

function respond({ sideRequest }) {
	if (sideRequest) return "Mock title";
	return { text: REPLY, stream: { everyMs: 25, pieceChars: 9 } };
}

/** The page's formulas and price text, as one snapshot. */
const mathState = (page) =>
	page.evaluate(() => {
		const tex = (root) =>
			[...root.querySelectorAll(".katex annotation")].map((a) => a.textContent ?? "").filter(Boolean);
		const reply = [...document.querySelectorAll(".msg.msg-assistant")].at(-1);
		const user = [...document.querySelectorAll(".msg.msg-user")].at(-1);
		const priceBlocks = reply
			? [...reply.querySelectorAll("li, p")].filter((el) => /\$\d/.test(el.textContent ?? ""))
			: [];
		return {
			replyTex: reply ? tex(reply) : [],
			replyDisplays: reply ? reply.querySelectorAll(".katex-display").length : 0,
			userTex: user ? tex(user) : [],
			errors: document.querySelectorAll(".katex-error").length,
			pricesWithKatex: priceBlocks
				.filter((el) => el.querySelector(".katex") && !/area is/.test(el.textContent ?? ""))
				.map((el) => (el.textContent ?? "").slice(0, 60)),
			replyText: reply?.innerText ?? "",
			userText: user?.innerText ?? "",
			strongs: reply ? [...reply.querySelectorAll("strong")].map((s) => s.textContent) : [],
			done: (reply?.innerText ?? "").includes("Done: QM-1."),
		};
	});

let browser = null;
const srv = await ownServer({ name: "adaptive-math", mock: respond });
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
	const pageErrors = [];
	page.on("pageerror", (e) => pageErrors.push(String(e)));
	await page.goto(srv.http);
	await page.waitForSelector(".inputbox textarea", { timeout: 60000 });
	await sleep(500);

	// 1. Send, then watch the reply arrive.
	await page.locator(".inputbox textarea").first().fill(PROMPT);
	await page.keyboard.press("Enter");
	const seenTex = new Set();
	let maxErrors = 0;
	const pricesEverWithKatex = new Set();
	const deadline = Date.now() + 60000;
	let state = await mathState(page);
	while (Date.now() < deadline) {
		state = await mathState(page);
		for (const t of state.replyTex) seenTex.add(t);
		for (const p of state.pricesWithKatex) pricesEverWithKatex.add(p);
		maxErrors = Math.max(maxErrors, state.errors);
		if (state.done && state.replyTex.length === FORMULAS.length) break;
		await sleep(30);
	}
	// Let the final one-shot render (and any late KaTeX) settle, then look again.
	await sleep(800);
	state = await mathState(page);
	for (const t of state.replyTex) seenTex.add(t);
	check("the reply arrived", state.done);
	check(
		"while streaming, only the four real formulas ever rendered (an open one stays text)",
		[...seenTex].every((t) => FORMULAS.includes(t)),
		JSON.stringify([...seenTex]),
	);
	check("KaTeX never reported an error", maxErrors === 0 && state.errors === 0, `${maxErrors}`);
	check(
		"no price text ever held KaTeX, while streaming or after",
		pricesEverWithKatex.size === 0 && state.pricesWithKatex.length === 0,
		JSON.stringify([...pricesEverWithKatex, ...state.pricesWithKatex]),
	);

	// 2. The finished reply.
	check(
		"exactly the four formulas render",
		JSON.stringify(state.replyTex) === JSON.stringify(FORMULAS),
		JSON.stringify(state.replyTex),
	);
	check("the $$ block and the \\[ \\] block are display formulas", state.replyDisplays === 2, `${state.replyDisplays}`);
	for (const sentence of [
		"Now: the stock is $353.55 and the call is $166.82, so the position is worth $186.73 a share.",
		"The gain: $43.27 a share, $4,327 in all.",
		"So the net per day of $85.49 is the $101.85 a day, between $100-$200 or $5/$10, about $2bn or $5M, $1,200.50 in all.",
		"while it costs $5 and $10.",
	]) {
		check(`reads word for word: ${sentence.slice(0, 50)}…`, state.replyText.includes(sentence));
	}
	check(
		"the bold around the prices is intact",
		["Now:", "The gain:", "$85.49"].every((s) => state.strongs.includes(s)),
		JSON.stringify(state.strongs),
	);

	// 3. The user's bubble.
	check(
		"the user's bubble: its formula renders, its prices don't",
		JSON.stringify(state.userTex) === '["y^2"]',
		JSON.stringify(state.userTex),
	);
	check("the user's bubble reads its prices as written", state.userText.includes("my budget is $5 and $10, and"));

	if (SHOT) {
		await page.screenshot({ path: `${SHOT}-reply.png` });
		console.log(`    screenshot: ${SHOT}-reply.png`);
	}

	// 4. Copy gives the original text.
	await page.evaluate(() => {
		window.__copied = null;
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: async (t) => void (window.__copied = t), write: async () => {} },
		});
	});
	const reply = page.locator(".msg.msg-assistant").last();
	await reply.hover();
	await reply.locator(".msg-text-copy").first().click({ force: true });
	const copied = await page
		.waitForFunction(() => window.__copied, null, { timeout: 5000 })
		.then((h) => h.jsonValue())
		.catch(() => null);
	check(
		"the copy button copies the original text",
		copied === REPLY,
		copied === null ? "nothing copied" : JSON.stringify(copied).slice(0, 120),
	);
	check("no page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
} catch (e) {
	console.log(`✗ FAIL: ${e?.stack ?? e}`);
	failures += 1;
} finally {
	await browser?.close().catch(() => {});
	await srv.stop();
	await srv.mock?.close();
}
console.log(failures > 0 ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures > 0 ? 1 : 0);
