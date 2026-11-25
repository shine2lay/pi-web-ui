/* Questionnaire E2E test: boots the compiled server, opens the built UI in
 * headless Chromium, and drives an ask_user_question round-trip through
 * the browser dialog bridge:
 *
 *   1. prompt the agent to call ask_user_question
 *   2. the .dialog-inline panel must appear above the input (styling + options)
 *   3. the call returns as it posts (non-blocking, Ops #1087); clicking an option closes the panel and the answer
 *      wakes the chat as a new message
 *   4. a second round is kept for later with Escape (nothing cancelled): the one-line bar shows, the chat stays
 *      usable, Answer reopens it, and an explicit Cancel question tells the chat it was cancelled
 *
 * The agent is the stand-in model (tests/lib/mock-model.mjs), so no real model is called: it
 * answers "1+1" and "继续吗" prompts with the ask_user_question call a real model would make, and a
 * tool result with a short text. The server is the test's own (tests/lib/own-server.mjs), with
 * temp data, agent and work folders.
 * Run:  npm run build && node tests/questionnaire-test.mjs */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";
import { chromium } from "playwright-core";

const srv = await ownServer({
	name: "questionnaire-test",
	mock: ({ lastUser, toolResult, sideRequest }) => {
		if (sideRequest) return "问卷测试";
		if (toolResult) return "问题已发出。";
		// The answer (or a cancel) wakes the chat as a new message (Ops #1087).
		if (lastUser.startsWith("Cancelled prompt")) return "知道你取消了。";
		if (lastUser.includes("answered your question")) return "收到你的回答。";
		if (lastUser.includes("1+1")) {
			return {
				tool: "ask_user_question",
				args: {
					questions: [
						{
							id: "q1",
							question: "测试问题：1+1 等于几？",
							options: [{ label: "等于 2" }, { label: "等于 3" }],
						},
					],
				},
			};
		}
		if (lastUser.includes("继续吗")) {
			return {
				tool: "ask_user_question",
				args: {
					questions: [
						{
							id: "q2",
							question: "测试问题：继续吗？",
							options: [{ label: "继续" }, { label: "停下" }],
						},
					],
				},
			};
		}
		return "好的。";
	},
});
process.on("exit", () => {
	void srv.stop();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};

/** Wait until the agent finishes streaming (send button replaces the stop button). */
async function waitIdle(page, timeout = 60_000) {
	for (let i = 0; i < timeout / 500; i++) {
		const sendBtn = await page.locator(".btn.send").count();
		if (sendBtn > 0) {
			// Let the tail of the run (final text, queue drain) settle.
			await sleep(1500);
			return true;
		}
		await sleep(500);
	}
	return false;
}

/** Send a prompt via the chat input. */
async function sendPrompt(page, text) {
	await page.fill(".inputbox textarea", text);
	await page.keyboard.press("Enter");
}

/** Wait for the nth ask_user_question tool call to finish with the status label `want`; e.g. 完成.
 * Our fork folds a finished exchange into one row (exchange-fold, web/src/components/ExchangeFoldRow.tsx:
 * "2 轮 · 1 次工具调用"), which hides its tool calls; open the last fold to see them. */
async function waitToolDone(page, { nth, want }, timeout = 60_000) {
	const tc = page.locator('.toolcall:has(.toolcall-name:text-is("ask_user_question"))');
	for (let i = 0; i < timeout / 500 && (await tc.count()) < nth; i++) {
		const closedFold = page.locator(".xfold:not(.open) .xfold-head");
		if ((await closedFold.count()) > 0) await closedFold.last().click();
		await sleep(500);
	}
	const call = tc.nth(nth - 1);
	await call.waitFor({ state: "visible", timeout });
	await call.locator(".toolcall-status").waitFor({ state: "visible", timeout });
	// The status is an icon now; its label (aria-label) says "完成" (done) or "出错" (error) plus the duration.
	let status = "";
	for (let i = 0; i < timeout / 500; i++) {
		status =
			(await call
				.locator(".toolcall-status")
				.getAttribute("aria-label")
				.catch(() => "")) ?? "";
		if (status.startsWith(want)) return true;
		await sleep(500);
	}
	console.log(`  [debug] tool call ${nth} status: ${status}`);
	return false;
}

let page = null;
async function main() {
	const browser = await chromium.launch({
		executablePath: CHROME_PATH,
	});
	page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	const consoleErrors = [];
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	page.on("pageerror", (e) => consoleErrors.push(String(e)));

	await page.goto(`${srv.http}/`);
	await page.waitForSelector(".boot-wait", { state: "hidden", timeout: 60000 });
	await page.waitForSelector(".topbar", { timeout: 5000 });
	console.log("app booted");

	// -- Round 1: answer the questionnaire -----------------------------------
	console.log("round 1: answering the questionnaire…");
	await sendPrompt(
		page,
		"请立即调用 ask_user_question 工具问我一个问题：「测试问题：1+1 等于几？」并给出两个选项：「等于 2」和「等于 3」。调用后等待我的回答，不要做其他事。",
	);

	// The inline panel must appear above the input (styling + options).
	await page.waitForSelector(".dialog-inline", {
		state: "visible",
		timeout: 60_000,
	});
	check("inline dialog panel appears", true);

	// ask_user_question is built into the server now and has its own panel
	// (web/src/components/DshQuestionDialog.tsx). The old checks were written for the generic
	// extension dialog (.dialog-title, .dialog-option rows plus a "Type something." row that an
	// extension appended); the built-in panel shows the question in .question-head, one
	// .question-option row per option, and a separate custom-answer input.
	const title = await page.locator(".dialog-inline .question-head").textContent();
	check("dialog shows the question", title?.includes("1+1") ?? false);

	const optCount = await page.locator(".dialog-inline .question-option").count();
	check("dialog shows the 2 options", optCount === 2);
	const opts = await page.locator(".dialog-inline .question-option").allTextContents();
	check(
		"options carry the model's labels",
		opts.some((t) => t.includes("等于 2")) && opts.some((t) => t.includes("等于 3")),
	);
	check("custom-answer input present", (await page.locator(".dialog-inline .question-custom").count()) === 1);
	if (optCount !== 2) {
		console.log(
			"[debug] dialog content:",
			await page
				.locator(".dialog-inline")
				.innerText()
				.catch(() => "<none>"),
		);
	}

	// Non-modal: the panel must live inside the chat main column, sit above
	// the input box, and leave the message list visible.
	const mainPanel = page.locator(".main .dialog-inline");
	check("panel is inside the chat main column", (await mainPanel.count()) === 1);
	const panelBox = await page.locator(".dialog-inline").boundingBox();
	const inputBox = await page.locator(".inputbox").boundingBox();
	const listBox = await page
		.locator(".messages")
		.boundingBox()
		.catch(() => null);
	check("panel sits above the input box", !!panelBox && !!inputBox && panelBox.y + panelBox.height <= inputBox.y + 2);
	check("message list stays visible while asking", !!listBox && listBox.height > 0);

	// Non-blocking: the call already returned and the turn ended while the panel still waits for the answer.
	check("tool completed as it posted (non-blocking)", await waitToolDone(page, { nth: 1, want: "Done" }));
	check("agent idle while the question waits", await waitIdle(page));
	check("panel still waits", (await page.locator(".dialog-inline").count()) === 1);
	// Click the first option -> panel closes, the answer wakes the chat.
	await page.locator(".dialog-inline .question-option").first().click();
	await page.waitForSelector(".dialog-inline", {
		state: "detached",
		timeout: 10_000,
	});
	check("panel closes after answering", true);
	const userGot = (re) =>
		srv.mock.requests.some((r) =>
			(r.messages ?? []).some((m) => m.role === "user" && re.test(JSON.stringify(m.content ?? ""))),
		);
	let answered = false;
	for (let i = 0; i < 40 && !answered; i++) {
		answered = userGot(/answered your question[\s\S]*等于 2/);
		if (!answered) await sleep(500);
	}
	check("the answer woke the chat as a new message with the chosen answer", answered);
	check("agent idle after round 1", await waitIdle(page));
	console.log("round 1 done\n");

	// -- Round 2: keep it for later with Escape, reopen it, cancel it ----------
	console.log("round 2: keeping it for later with Escape…");
	await sendPrompt(
		page,
		"请再次调用 ask_user_question 工具问我一个问题（不要用文字回复，必须调用工具）：「测试问题：继续吗？」给出两个选项：「继续」和「停下」。调用后等待我的回答，不要做其他事。",
	);
	await page.waitForSelector(".dialog-inline", {
		state: "visible",
		timeout: 60_000,
	});
	check("second dialog appears", true);

	await page.keyboard.press("Escape");
	await page.waitForSelector(".dialog-inline", {
		state: "detached",
		timeout: 10_000,
	});
	check("panel closes on Escape", true);
	// Escape keeps it for later (Shine m104353): nothing is cancelled, the chat's one-line bar offers it.
	const bar = page.locator(".question-later-bar");
	await bar.waitFor({ state: "visible", timeout: 10_000 });
	check("the saved-for-later bar shows its question", ((await bar.textContent()) ?? "").includes("继续吗"));
	check("tool completed as it posted", await waitToolDone(page, { nth: 2, want: "Done" }));
	await sleep(1000);
	check("Escape cancelled nothing", !userGot(/Cancelled prompt/));
	// The chat stays usable while the question is kept for later.
	const before = srv.mock.requests.length;
	await sendPrompt(page, "先聊点别的");
	check("the chat stays usable", (await waitIdle(page)) && srv.mock.requests.length > before);
	check("the bar stays until it is answered", await bar.isVisible());
	// Answer reopens it right there; an explicit Cancel question cancels it.
	await page.locator(".question-later-bar .question-later-answer").click();
	await page.waitForSelector(".dialog-inline", { state: "visible", timeout: 10_000 });
	check("Answer reopens the question in the chat", true);
	await page.locator(".dialog-inline .dialog-dismiss-inline").click();
	await page.waitForSelector(".dialog-inline", { state: "detached", timeout: 10_000 });
	await bar.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
	check("Cancel question closes it and the bar", (await bar.count()) === 0);
	let cancelSeen = false;
	for (let i = 0; i < 40 && !cancelSeen; i++) {
		cancelSeen = userGot(/Cancelled prompt/);
		if (!cancelSeen) await sleep(500);
	}
	check("the model heard the question was cancelled", cancelSeen);
	console.log("round 2 done\n");

	// -- Summary -------------------------------------------------------------
	if (consoleErrors.length > 0) {
		console.log("console errors:", consoleErrors.slice(0, 5));
	}
	console.log(`\n${passed} checks passed`);
	await browser.close();
	await srv.stop();
	process.exit(process.exitCode ?? 0);
}

main().catch(async (err) => {
	console.error("test crashed:", err);
	if (page) {
		const toolcalls = await page
			.locator(".toolcall")
			.count()
			.catch(() => -1);
		const text = await page
			.locator(".messages")
			.innerText()
			.catch(() => "<none>");
		console.error(`[debug] .toolcall count=${toolcalls}; messages:\n${text.slice(0, 1500)}`);
	}
	await srv.stop();
	process.exit(1);
});
