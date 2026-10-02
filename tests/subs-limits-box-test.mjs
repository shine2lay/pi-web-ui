/* subs-limits-box E2E (no tokens, no real accounts): the Limits box at the bottom of the left panel.
 *
 * A stand-in for pi-multi-pass is put in the agent's extensions folder: when a chat loads it, it puts
 * the version 1 hook on globalThis (Symbol.for("pi-multi-pass.limits")), and its check() writes the
 * readings file (<agent dir>/multi-pass-quota/subs-limits.json) whole, like the real one. Its accounts:
 * three Claude, one ChatGPT, and one on the chat's own provider (for the "this chat" mark). Checks:
 *  - before the first press the box says "Not checked yet";
 *  - the refresh button spins at once and stops when the check is over; every account gets a row, in
 *    order, with its plan, who, "% used" with a bar and "resets in …" per window (5-hour, weekly, then
 *    per-model), "checked just now"; colors: plain under 75%, amber from 75%, red from 90% or limited;
 *    a limited account is marked; the open chat's account is marked;
 *  - a second window shows the same rows without pressing, and spins too when the first presses;
 *  - a failed account keeps its last numbers and says why ("timed out"), the others are fresh;
 *  - a write of the file from elsewhere (a command-line pi) shows up in the box by itself;
 *  - the fold is remembered over a reload; the readings survive a server restart;
 *  - phone: the side drawer has the box under History, with every row and a tappable refresh.
 * Usage: npm run build && node tests/subs-limits-box-test.mjs
 *        (SUBS_SHOT=/tmp/subs saves /tmp/subs-desktop.png and /tmp/subs-phone.png of the box)
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, openPhone, PHONE_412 } from "./lib/phone.mjs";
import { ownServer } from "./lib/own-server.mjs";

const SHOT = process.env.SUBS_SHOT ?? "";
let failed = 0;
const check = (name, ok, extra = "") => {
	if (!ok) failed++;
	console.log(`  ${ok ? "✓" : "✗ FAIL:"} ${name}${extra ? " — " + extra : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000, every = 100) {
	const end = Date.now() + ms;
	for (;;) {
		try {
			const v = await fn();
			if (v) return v;
		} catch {
			/* not yet */
		}
		if (Date.now() > end) return false;
		await sleep(every);
	}
}

/** The stand-in for pi-multi-pass (TypeScript, loaded by pi like any extension). */
const fakeMultiPass = (
	file,
	workdir,
) => `import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const KEY = Symbol.for("pi-multi-pass.limits");
const FILE = ${JSON.stringify(file)};
const WORK = ${JSON.stringify(workdir)};
const HOUR = 3600;

function read(): any {
	try {
		return JSON.parse(readFileSync(FILE, "utf8"));
	} catch {
		return undefined;
	}
}

function windows(now: number, used5: number, used7: number, extra: any[] = []) {
	const s = Math.floor(now / 1000);
	return [
		{ key: "7d", label: "Weekly", usedPercent: used7, resetAt: s + 4 * 24 * HOUR + 2 * HOUR, ...(used7 >= 100 ? { limited: true } : {}) },
		{ key: "5h", label: "5-hour", usedPercent: used5, resetAt: s + 3 * HOUR + 20 * 60 },
		...extra,
	];
}

function accounts(now: number, previous: any, failClaude3: boolean) {
	const fresh = (row: any) => ({ ...row, checkedAt: now, triedAt: now, source: "check" });
	const rows = [
		fresh({ provider: "anthropic", base: "anthropic", number: 1, name: "Claude 1", plan: "Max", email: "one@example.com", windows: windows(now, 12, 100), limited: true }),
		fresh({ provider: "anthropic-2", base: "anthropic", number: 2, name: "Claude 2", plan: "Max", label: "work", email: "two@example.com",
			windows: windows(now, 80, 40, [{ key: "7d:opus", label: "Weekly · Opus", usedPercent: 20, resetAt: Math.floor(now / 1000) + 50 * HOUR }]) }),
		fresh({ provider: "anthropic-3", base: "anthropic", number: 3, name: "Claude 3", plan: "Pro", email: "three@example.com", windows: windows(now, 5, 92) }),
		fresh({ provider: "openai-codex", base: "openai-codex", number: 1, name: "ChatGPT 1", plan: "Plus", email: "gpt@example.com", windows: windows(now, 3, 10) }),
		fresh({ provider: "fastfail", base: "fastfail", number: 1, name: "Test 1", windows: windows(now, 1, 2) }),
	];
	if (failClaude3) {
		const before = previous?.accounts?.find((a: any) => a.provider === "anthropic-3");
		rows[2] = { ...before, triedAt: now, failure: { reason: "timeout", text: "timed out", at: now } };
	}
	return rows;
}

export default function (pi: any) {
	const g = globalThis as any;
	let channel = g[KEY];
	if (!channel) {
		channel = { v: 1, listeners: new Set() };
		g[KEY] = channel;
	}
	let running: Promise<any> | undefined;
	const emit = (event: any) => {
		for (const l of channel.listeners) {
			try {
				l(event);
			} catch {}
		}
	};
	channel.api = {
		file: FILE,
		readings: read,
		checking: () => running !== undefined,
		check() {
			if (running) return running;
			const p = (async () => {
				await new Promise((r) => setTimeout(r, 1500));
				const now = Date.now();
				const readings = { version: 1, updatedAt: now, checkedAt: now, accounts: accounts(now, read(), existsSync(join(WORK, "fail-claude-3"))) };
				mkdirSync(dirname(FILE), { recursive: true });
				writeFileSync(FILE + ".tmp", JSON.stringify(readings));
				renameSync(FILE + ".tmp", FILE);
				return readings;
			})();
			running = p;
			emit({ checking: true });
			p.then(
				(readings) => {
					running = undefined;
					emit({ checking: false, readings });
				},
				() => {
					running = undefined;
					emit({ checking: false });
				},
			);
			return p;
		},
	};
	writeFileSync(join(WORK, "fake-multi-pass-loaded"), "1");
	pi.on("session_start", async () => {});
}
`;

let srv;
let browser;
try {
	srv = await ownServer({
		name: "subs-limits-box-test",
		prepare: async ({ agentDir, workdir }) => {
			mkdirSync(join(agentDir, "extensions"), { recursive: true });
			const file = join(agentDir, "multi-pass-quota", "subs-limits.json");
			writeFileSync(join(agentDir, "extensions", "fake-multi-pass.ts"), fakeMultiPass(file, workdir));
		},
	});
	const FILE = join(srv.agentDir, "multi-pass-quota", "subs-limits.json");
	browser = await launchBrowser();
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
	const page = await ctx.newPage();
	await page.goto(srv.http + "/");

	const box = (p) => p.locator(".lp-section-limits");
	const rows = (p) => box(p).locator(".lp-limit-row");
	const row = (p, provider) => box(p).locator(`.lp-limit-row[data-provider="${provider}"]`);
	const refreshBtn = (p) => box(p).locator(".lp-limits-refresh");

	console.log("desktop: before the first press");
	check("the Limits box is under History", await until(() => box(page).isVisible()));
	const order = await page.evaluate(() =>
		[...document.querySelectorAll(".lp-panel > .lp-section")].map((el) => el.className),
	);
	check(
		"it's the last section, after History",
		/lp-section-limits/.test(order.at(-1) ?? "") && order.some((c) => /lp-section-sessions/.test(c)),
		order.join(" | "),
	);
	check("header reads Limits", (await box(page).locator(".lp-section-title-text").textContent())?.trim() === "Limits");
	check("says Not checked yet", await until(() => box(page).getByText("Not checked yet").isVisible()));

	// The stand-in loads with the first chat's extensions.
	let loaded = await until(() => existsSync(join(srv.workdir, "fake-multi-pass-loaded")), 15_000);
	if (!loaded) {
		await page.locator(".inputbox textarea").fill("hello");
		await page.keyboard.press("Enter");
		loaded = await until(() => existsSync(join(srv.workdir, "fake-multi-pass-loaded")), 15_000);
	}
	check("a chat loaded the stand-in for pi-multi-pass", !!loaded);

	console.log("desktop: the first refresh");
	await refreshBtn(page).click();
	check(
		"the button spins at once",
		await until(() => refreshBtn(page).evaluate((b) => b.classList.contains("spinning")), 1000, 20),
	);
	check("every account gets a row", await until(async () => (await rows(page).count()) === 5, 10_000));
	check(
		"the spinner stops when the check is over",
		await until(async () => !(await refreshBtn(page).evaluate((b) => b.classList.contains("spinning"))), 5000),
	);
	const names = await rows(page).locator(".lp-limit-name").allInnerTexts();
	check(
		"rows in pi-multi-pass's order",
		names.join(",") === "Claude 1,Claude 2,Claude 3,ChatGPT 1,Test 1",
		names.join(","),
	);
	const c2 = row(page, "anthropic-2");
	check(
		"plan and who are shown",
		(await c2.locator(".lp-limit-plan").innerText()) === "Max" &&
			(await c2.locator(".lp-limit-who").innerText()) === "work",
	);
	const labels = await c2.locator(".lp-limit-wlabel").allInnerTexts();
	check("5-hour, then weekly, then per-model", labels.join(",") === "5-hour,Weekly,Weekly · Opus", labels.join(","));
	const c2text = await c2.innerText();
	check(
		"% used and resets in …",
		/80% used/.test(c2text) && /resets in 3h (19|20)m/.test(c2text) && /resets in 4d [12]h/.test(c2text),
		c2text.replace(/\n/g, " / "),
	);
	check("checked just now", /checked just now/.test(c2text));
	check(
		"amber from 75%",
		(await c2.locator(".lp-limit-window").first().getAttribute("class"))?.includes("lp-limit-warn"),
	);
	check(
		"plain under 75%",
		(await c2.locator(".lp-limit-window").nth(1).getAttribute("class"))?.includes("lp-limit-ok"),
	);
	const c3week = row(page, "anthropic-3").locator(".lp-limit-window").nth(1);
	check("red from 90%", (await c3week.getAttribute("class"))?.includes("lp-limit-bad"));
	const c1 = row(page, "anthropic");
	check(
		"a limited account is marked, its week in red",
		(await c1.locator(".lp-limit-badge").innerText()) === "Limited" &&
			(await c1.locator(".lp-limit-window").nth(1).getAttribute("class"))?.includes("lp-limit-bad"),
	);
	const width = await c1
		.locator(".lp-limit-window")
		.nth(1)
		.locator(".lp-limit-fill")
		.evaluate((el) => el.style.width);
	check("the bar shows how much is used", width === "100%", width);
	check(
		"the open chat's account is marked",
		(await row(page, "fastfail").locator(".lp-limit-current").count()) === 1 &&
			(await box(page).locator(".lp-limit-current").count()) === 1,
	);
	if (SHOT) await box(page).screenshot({ path: `${SHOT}-desktop.png` });

	console.log("two windows");
	const page2 = await ctx.newPage();
	await page2.goto(srv.http + "/");
	check(
		"a second window shows the same rows without pressing",
		await until(async () => (await rows(page2).count()) === 5),
	);
	writeFileSync(join(srv.workdir, "fail-claude-3"), "1");
	await refreshBtn(page).click();
	check(
		"the other window spins too",
		await until(() => refreshBtn(page2).evaluate((b) => b.classList.contains("spinning")), 3000, 20),
	);
	await until(async () => (await row(page, "anthropic-3").locator(".lp-limit-failure").count()) === 1, 10_000);
	const c3 = await row(page, "anthropic-3").innerText();
	check("a failed account says why", /timed out/.test(c3), c3.replace(/\n/g, " / "));
	check("... and keeps its last numbers", /92% used/.test(c3) && /5% used/.test(c3) && /checked/.test(c3));
	check("the others are fresh", !(await row(page, "anthropic-2").locator(".lp-limit-failure").count()));
	check(
		"both windows show the failure",
		await until(async () => /timed out/.test(await row(page2, "anthropic-3").innerText())),
	);
	await page2.close();

	console.log("a write from elsewhere");
	const data = JSON.parse(readFileSync(FILE, "utf8"));
	data.accounts[0].windows = data.accounts[0].windows.map((w) => (w.key === "5h" ? { ...w, usedPercent: 55 } : w));
	data.accounts[0].checkedAt = Date.now();
	data.accounts[0].source = "reply";
	writeFileSync(FILE + ".x", JSON.stringify(data));
	renameSync(FILE + ".x", FILE);
	check(
		"shows up by itself",
		await until(async () => /55% used/.test(await row(page, "anthropic").innerText()), 15_000),
	);

	console.log("fold and restart");
	await box(page).locator(".lp-section-title").click();
	check("folds", await until(() => box(page).evaluate((el) => el.classList.contains("collapsed"))));
	await page.reload();
	await until(() => box(page).isVisible());
	check("the fold is remembered", await box(page).evaluate((el) => el.classList.contains("collapsed")));
	await box(page).locator(".lp-section-title").click();
	check("unfolds", await until(async () => (await rows(page).count()) === 5));
	await srv.restart();
	await page.reload();
	check("readings survive a restart", await until(async () => (await rows(page).count()) === 5, 15_000));
	check("... with their failure", /timed out/.test(await row(page, "anthropic-3").innerText()));

	console.log("phone");
	const phone = await openPhone(browser, { size: PHONE_412 });
	await phone.page.goto(srv.http + "/");
	const toggle = phone.page.locator(".topbar button.panel-toggle").first();
	await until(() => toggle.isVisible(), 15_000);
	await toggle.click();
	const drawer = phone.page.locator(".panel-drawer.drawer-left.open");
	check("the drawer has the box", await until(() => drawer.locator(".lp-section-limits").isVisible(), 5000));
	check("with every row", await until(async () => (await drawer.locator(".lp-limit-row").count()) === 5, 10_000));
	const btn = drawer.locator(".lp-limits-refresh");
	const bb = await btn.boundingBox();
	check(
		"the refresh button is big enough to tap",
		!!bb && bb.width >= 40 && bb.height >= 40,
		bb ? `${bb.width}x${bb.height}` : "none",
	);
	await btn.tap();
	check("a tap checks again", await until(() => btn.evaluate((b) => b.classList.contains("spinning")), 3000, 20));
	await until(async () => !(await btn.evaluate((b) => b.classList.contains("spinning"))), 10_000);
	await drawer.locator(".lp-section-limits").scrollIntoViewIfNeeded();
	if (SHOT) await drawer.screenshot({ path: `${SHOT}-phone.png` });
	await phone.close();
} catch (e) {
	failed++;
	console.log(`  ✗ FAIL: ${e?.stack ?? e}`);
} finally {
	await browser?.close().catch(() => {});
	await srv?.stop().catch(() => {});
}
console.log(failed ? `\n✗ ${failed} check(s) failed` : "\n✓ subs-limits-box: all checks passed");
process.exit(failed ? 1 : 0);
