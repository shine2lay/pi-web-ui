/* nonblocking-ask (Ops #1088, QA #243 D3): on a small phone the question's answers show above its footer.
 *
 * The real app on its own sealed server (tests/lib/own-server.mjs, a stand-in model asks one question), opened at
 * 320x568 in light and dark, as the question pops up (`dialog`) and after Later then the bar's Answer
 * (`reopened`). Each must show the first answer option whole, below the card's top and above the sticky footer
 * (`.dialog-nav`), with at least 120 px of the question visible above that footer. The harness page of
 * question-later-ui-check.mjs can't show this: it lacks the app's header, goal pill and composer, which take the
 * height (QA saw ~25 px of question on the real app; the harness measured 228 px).
 * Saves each view @2x, then runs ui-check (320/390/1440, light + dark) on the real app's popped-up question.
 *
 * Usage: npm run build && scripts/sealed.sh node tests/question-phone-fit-test.mjs [out-dir]
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";

const OUT = process.argv[2] ?? "/tmp/question-phone-fit";
const PHONE = { width: 320, height: 568 };
const MIN_QUESTION_VIEW = 120;
mkdirSync(OUT, { recursive: true });

// QA #243's card: a header, a two-line question and two answers with descriptions.
function mockReply({ lastUser, toolResult, sideRequest }) {
	if (sideRequest) return "Title";
	if (toolResult) return "POSTED";
	if (!/QA-ASK/.test(lastUser)) return "ok";
	const question = {
		id: "when",
		header: "Release timing",
		question: "Should the release go out tonight or wait for the morning window when nobody is trading?",
		options: [
			{ label: "Tonight", description: "Ship now; nobody is online." },
			{ label: "Morning", description: "Wait for the quiet window." },
		],
	};
	return { tool: "ask_user_question", args: { questions: [question] } };
}

async function until(fn, ms = 20000) {
	const t0 = Date.now();
	let v = await fn();
	while (!v && Date.now() - t0 < ms) {
		await sleep(100);
		v = await fn();
	}
	return v;
}

async function askOnce(srv) {
	const ws = new WebSocket(srv.ws, { headers: { origin: `http://localhost:${srv.port}` } });
	await new Promise((ok, bad) => {
		ws.once("open", ok);
		ws.once("error", bad);
	});
	const send = (m) => ws.send(JSON.stringify(m));
	send({ type: "hello", clientId: "phone-fit", locale: "en" });
	await sleep(1000);
	send({ type: "set_model", modelId: "mock/mock-model" });
	await sleep(500);
	send({ type: "new_chat" });
	await sleep(400);
	send({ type: "prompt", text: "QA-ASK fit" });
	const store = join(srv.dataDir, "pending-questions.json");
	const rec = await until(() => existsSync(store) && JSON.parse(readFileSync(store, "utf8")).records?.[0]);
	ws.close();
	if (!rec?.sessionFile) throw new Error("the stand-in model's question never reached pending-questions.json");
	return rec.sessionFile;
}

async function measure(page) {
	return page.evaluate(() => {
		const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect().toJSON() ?? null;
		return {
			dialog: rect(".dialog-inline"),
			firstOption: rect(".dialog-inline .question-option"),
			nav: rect(".dialog-inline .dialog-nav"),
		};
	});
}

const srv = await ownServer({ name: "question-phone-fit", mock: mockReply });
let failed = 0;
const rows = [];
try {
	const chat = await askOnce(srv);
	const url = `http://127.0.0.1:${srv.port}/?chat=${encodeURIComponent(chat)}`;
	// ui-check first: once Later was pressed the question opens as the bar, not popped up.
	const run = await new Promise((done) =>
		execFile(
			"ui-check",
			[url, "--out-dir", join(OUT, "ui-check-app"), "--json"],
			// ui-check's Python Playwright lives in the user's own site-packages, which the sealed temp HOME hides.
			{
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
				env: { ...process.env, PYTHONUSERBASE: `${userInfo().homedir}/.local` },
			},
			(error, stdout, stderr) => done({ status: error ? (error.code ?? 1) : 0, stdout, stderr }),
		),
	);
	writeFileSync(join(OUT, "ui-check-app.json"), run.stdout || run.stderr);
	console.log(
		`${run.status === 0 ? "✓" : "✗ FAIL"} ui-check 320/390/1440 light + dark on the app's question: exit ${run.status}`,
	);
	if (run.status !== 0) {
		failed++;
		console.log((run.stdout || run.stderr).slice(0, 4000));
	}
	const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	try {
		for (const state of ["dialog", "reopened"]) {
			for (const colorScheme of ["light", "dark"]) {
				const page = await browser.newPage({ viewport: PHONE, colorScheme, deviceScaleFactor: 2 });
				// The app keeps its own theme (dark by default): light is the Flow Light theme, as the owner would pick it.
				if (colorScheme === "light")
					await page.addInitScript(() => localStorage.setItem("pi-web-ui:theme", "flow-light"));
				await page.goto(url);
				await page.waitForSelector(".dialog-inline .question-option, .question-later-answer", { timeout: 20000 });
				if (state === "reopened") {
					// Kept for later by the previous view already: the bar shows; else press Later first.
					if (await page.$(".dialog-inline .dialog-later")) await page.click(".dialog-inline .dialog-later");
					await page.click(".question-later-answer", { timeout: 10000 });
					await page.waitForSelector(".dialog-inline .question-option", { timeout: 10000 });
				}
				await sleep(400); // the card's slide-up
				const { dialog, firstOption, nav } = await measure(page);
				await page.screenshot({ path: join(OUT, `${state}-320x568-${colorScheme}@2x.png`) });
				await page.close();
				const top = Math.max(dialog?.top ?? 0, 0);
				const questionView = nav ? Math.round(nav.top - top) : 0;
				const ok =
					!!(dialog && firstOption && nav) &&
					firstOption.top >= top &&
					firstOption.bottom <= nav.top &&
					nav.bottom <= PHONE.height &&
					questionView >= MIN_QUESTION_VIEW;
				const row = {
					state,
					colorScheme,
					firstOption: firstOption && [Math.round(firstOption.top), Math.round(firstOption.bottom)],
					navTop: nav && Math.round(nav.top),
					questionView,
					ok,
				};
				rows.push(row);
				console.log(
					`${ok ? "✓" : "✗ FAIL"} ${state} 320x568 ${colorScheme}: first option ${row.firstOption?.join("-")}, footer top ${row.navTop}, question view ${questionView}px`,
				);
				if (!ok) failed++;
			}
		}
	} finally {
		await browser.close();
	}
} catch (e) {
	failed++;
	console.log(`✗ FAIL ${String(e?.stack ?? e)}`);
} finally {
	writeFileSync(join(OUT, "phone-fit.json"), `${JSON.stringify(rows, null, 2)}\n`);
	await srv.stop();
}
console.log(failed ? `✗ ${failed} check(s) failed` : "✓ question-phone-fit: all checks passed");
process.exit(failed ? 1 : 0);
