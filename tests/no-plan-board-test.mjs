/**
 * no-plan-board (fork patch, PATCHES.md): the Task Plan Board above the message box and the AI's
 * `plan_update` tool that filled it are gone. A server of its own with a stand-in model (tests never
 * call a real model) and one saved chat from before the removal, whose history has two `plan_update`
 * calls and their results:
 *  1. a new chat: the model is offered no `plan_update` tool and no instruction to use one, the
 *     page shows no board (desktop and phone width), and Settings' tool list has no switch for it.
 *     The test only counts what the model was sent; it never prints it.
 *  2. the page ignores a plan: a state message that still carries one (as the old server sent it)
 *     and the old `plan_updated` message leave no board, no plan text and no page error.
 *  3. the old chat opens: its question and answer show, both `plan_update` calls show as ordinary
 *     tool calls, and the chat carries on with a new question.
 *
 * Usage: npm run build && node tests/no-plan-board-test.mjs
 *        PLAN_SHOT=/tmp/np saves screenshots /tmp/np-*.png (chat and Settings, desktop and phone)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { textOf } from "./lib/mock-model.mjs";
import { ownServer } from "./lib/own-server.mjs";
import { revealTopbarItem, SETTINGS_CHIP } from "./lib/topbar.mjs";

const OLD_TOOL = "plan_update";
const SHOT = process.env.PLAN_SHOT ?? "";
let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✓" : "✗ FAIL:"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures += 1;
}

// ---- the stand-in model: answers "answer to <marker>" and counts what it was offered ---------------
const seen = { turns: 0, offeredPlanTool: 0, toldToPlan: 0, offeredBash: 0 };
function respond({ payload, sideRequest, lastUser }) {
	if (sideRequest) return "Mock title";
	seen.turns += 1;
	const names = (payload.tools ?? []).map((t) => t.function?.name ?? t.name);
	if (names.includes(OLD_TOOL)) seen.offeredPlanTool += 1;
	if (names.includes("bash")) seen.offeredBash += 1;
	const system = (payload.messages ?? []).filter((m) => m.role === "system" || m.role === "developer");
	if (system.some((m) => textOf(m).includes(OLD_TOOL))) seen.toldToPlan += 1;
	return `answer to ${lastUser.match(/Q[A-Z]-\d+/)?.[0] ?? "none"}`;
}

// ---- the saved chat from before: a question, two plan_update calls with results, an answer --------
let oldChat = "";
function seedOldChat({ agentDir, workdir }) {
	const sessionDir = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(sessionDir, { recursive: true });
	const id = "01a0f000-0000-7000-8000-00000000b0a2";
	let ts = Date.parse("2026-09-29T10:00:00.000Z");
	const lines = [
		{ type: "session", version: 3, id, timestamp: new Date(ts).toISOString(), cwd: workdir },
		{
			type: "model_change",
			id: "mc",
			parentId: null,
			timestamp: new Date(ts).toISOString(),
			provider: "mock",
			modelId: "mock-model",
		},
	];
	let parentId = "mc";
	const push = (message) => {
		ts += 1000;
		const entryId = `e${lines.length}`;
		lines.push({
			type: "message",
			id: entryId,
			parentId,
			timestamp: new Date(ts).toISOString(),
			message: { ...message, timestamp: ts },
		});
		parentId = entryId;
	};
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const assistant = (content, stopReason) => ({
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "mock",
		model: "mock-model",
		usage,
		stopReason,
	});
	const planCall = (callId, done) => ({
		type: "toolCall",
		id: callId,
		name: OLD_TOOL,
		arguments: {
			steps: [
				{ id: "1", title: "Pack the boxes", status: "done" },
				{ id: "2", title: "Load the van", status: done ? "done" : "in_progress" },
			],
			activeStepId: done ? undefined : "2",
		},
	});
	const planResult = (callId, text) => ({
		role: "toolResult",
		toolCallId: callId,
		toolName: OLD_TOOL,
		content: [{ type: "text", text }],
		isError: false,
	});
	push({ role: "user", content: [{ type: "text", text: "QO-1 plan the move" }] });
	push(assistant([{ type: "text", text: "Planning it." }, planCall("call_plan_1", false)], "toolUse"));
	push(planResult("call_plan_1", "Plan updated: 1/2 done"));
	push(assistant([planCall("call_plan_2", true)], "toolUse"));
	push(planResult("call_plan_2", "Plan updated: 2/2 done"));
	push(assistant([{ type: "text", text: "answer to QO-1: packed and loaded." }], "stop"));
	oldChat = join(sessionDir, `2026-09-29T10-00-00-000Z_${id}.jsonl`);
	writeFileSync(oldChat, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

/** What the page shows of the removed board, and whether the message box is there. */
const boardState = (page) =>
	page.evaluate(() => ({
		boards: document.querySelectorAll(".plan-board, .plan-board-row").length,
		boardTitle: /Task Plan Board|Plan Mode/i.test(document.body.innerText),
		injectedSteps: document.body.innerText.includes("QX-STEP"),
		composer: Boolean(document.querySelector("textarea")?.getClientRects().length),
	}));
const noBoard = (s) => s.boards === 0 && !s.boardTitle && !s.injectedSteps;

async function shot(page, name) {
	if (!SHOT) return;
	await page.screenshot({ path: `${SHOT}-${name}.png` });
	console.log(`    screenshot: ${SHOT}-${name}.png`);
}

/** Open Settings > Tools, note the names of the tool switches, take a picture, close it again. */
async function settingsToolNames(page, shotName) {
	await (await revealTopbarItem(page, SETTINGS_CHIP)).click();
	await page.locator(".settings-modal").first().waitFor({ timeout: 15000 });
	await page
		.locator(".settings-tab")
		.filter({ hasText: /^\s*Tools\s*\d*\s*$/ })
		.first()
		.click();
	await page.locator(".settings-modal .set-row-name", { hasText: "claim_files" }).first().waitFor({ timeout: 10000 });
	const names = await page.$$eval(".settings-modal .set-row-name", (els) =>
		els.map((e) => e.textContent?.trim() ?? ""),
	);
	if (SHOT) {
		// The plan switch used to sit between claim_files and patch: show that stretch.
		await page
			.locator(".settings-modal .set-row-name", { hasText: "claim_files" })
			.first()
			.evaluate((el) => el.scrollIntoView({ block: "center" }));
		await sleep(400);
		await shot(page, shotName);
	}
	await page.locator(".settings-modal .modal-close").first().click();
	await page.waitForFunction(() => !document.querySelector(".settings-modal"), null, { timeout: 10000 });
	return names;
}

async function ask(page, text, marker) {
	await page.locator("textarea").first().fill(text);
	await page.keyboard.press("Enter");
	return page
		.waitForFunction((m) => document.body.innerText.includes(`answer to ${m}`), marker, { timeout: 30000 })
		.then(() => true)
		.catch(() => false);
}

let browser = null;
const srv = await ownServer({ name: "no-plan-board", mock: respond, prepare: seedOldChat });
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
	const pageErrors = [];
	page.on("pageerror", (e) => pageErrors.push(String(e)));
	// Hold on to the page's own socket: it opens the saved chat without a model call, and hands the page
	// a message as if the server had sent it. Keep the last full state the server sent.
	await page.addInitScript(() => {
		localStorage.setItem("pi-web-ui:lang", "en");
		const Orig = window.WebSocket;
		window.WebSocket = class extends Orig {
			constructor(...args) {
				super(...args);
				window.__piWs = this;
				this.addEventListener("message", (e) => {
					try {
						const m = JSON.parse(e.data);
						if (m.type === "snapshot" && e.isTrusted) {
							window.__lastSnapshot = m;
							window.__snapshots = (window.__snapshots ?? 0) + 1;
						}
					} catch {
						/* not JSON */
					}
				});
			}
		};
	});
	await page.goto(srv.http);
	await page.waitForSelector("textarea", { timeout: 60000 });
	await page.waitForFunction(() => window.__piWs?.readyState === 1 && window.__lastSnapshot, null, { timeout: 20000 });

	// 1. A new chat: no plan tool for the model, no board on the page. The page opens on the latest
	// saved chat (the old one), so start a new chat from the left panel first.
	await page.locator(".lp-new-chat-action").first().click();
	const fresh = await page
		.waitForFunction(() => !document.body.innerText.includes("answer to QO-1"), null, { timeout: 15000 })
		.then(() => true)
		.catch(() => false);
	check("a new chat opens, without the old chat's messages", fresh);
	check("the new chat gets an answer", await ask(page, "QN-1 hello", "QN-1"));
	check("the model was asked (with tools) at least once", seen.turns >= 1 && seen.offeredBash === seen.turns);
	check("the model is not offered the plan_update tool", seen.offeredPlanTool === 0, `${seen.offeredPlanTool} time(s)`);
	check("the model is not told to use plan_update", seen.toldToPlan === 0, `${seen.toldToPlan} time(s)`);
	let s = await boardState(page);
	check("desktop: no board, the message box is there", noBoard(s) && s.composer, JSON.stringify(s));
	await shot(page, "desktop-chat");
	await page.setViewportSize({ width: 390, height: 844 });
	await sleep(500);
	s = await boardState(page);
	check("phone: no board, the message box is there", noBoard(s) && s.composer, JSON.stringify(s));
	await shot(page, "phone-chat");
	await page.setViewportSize({ width: 1300, height: 900 });
	await sleep(300);

	// Settings' tool list: the other tools are there, the plan tool's switch is not.
	const names = await settingsToolNames(page, "desktop-settings-tools");
	check(
		"Settings lists the tool switches",
		["claim_files", "patch", "compact_context"].every((n) => names.some((x) => x.startsWith(n))),
		`${names.length} rows`,
	);
	check("Settings has no switch for plan_update", !names.some((x) => x.includes(OLD_TOOL)));
	if (SHOT) {
		await page.setViewportSize({ width: 390, height: 844 });
		await sleep(500);
		const phoneNames = await settingsToolNames(page, "phone-settings-tools");
		check("phone: Settings has no switch for plan_update", !phoneNames.some((x) => x.includes(OLD_TOOL)));
		await page.setViewportSize({ width: 1300, height: 900 });
		await sleep(300);
	}

	// 2. A state message that still carries a plan, and the old plan message: nothing shows. Start from
	// a fresh full state, so the handed-in one only adds the plan.
	const before = await page.evaluate(() => {
		window.__piWs.send(JSON.stringify({ type: "get_state" }));
		return window.__snapshots;
	});
	await page.waitForFunction((n) => window.__snapshots > n, before, { timeout: 10000 });
	const handed = await page.evaluate(() => {
		const plan = {
			steps: [
				{ id: "1", title: "QX-STEP one", status: "in_progress" },
				{ id: "2", title: "QX-STEP two", status: "pending" },
			],
			activeStepId: "1",
			updatedAt: Date.now(),
		};
		const ws = window.__piWs;
		if (typeof ws.onmessage !== "function") return false;
		const { reuse: _reuse, ...snap } = window.__lastSnapshot;
		const hand = (m) => ws.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(m) }));
		hand({ ...snap, state: { ...snap.state, plan } });
		hand({ type: "plan_updated", plan });
		return true;
	});
	check("the page took the handed-in messages", handed);
	await sleep(800);
	s = await boardState(page);
	check("a state carrying a plan shows no board and no plan steps", noBoard(s) && s.composer, JSON.stringify(s));
	check("no page errors so far", pageErrors.length === 0, pageErrors.join(" | "));

	// 3. The old chat opens; its plan_update calls show as ordinary tool calls; it carries on.
	await page.evaluate((path) => window.__piWs.send(JSON.stringify({ type: "switch_session", path })), oldChat);
	const opened = await page
		.waitForFunction(() => document.body.innerText.includes("answer to QO-1"), null, { timeout: 20000 })
		.then(() => true)
		.catch(() => false);
	check("the old chat opens with its answer", opened);
	check(
		"its question shows",
		await page.evaluate(() => Boolean(document.querySelector(".messages")?.innerText.includes("QO-1 plan the move"))),
	);
	const fold = page.locator(".xfold-head").last();
	if ((await fold.count()) > 0 && (await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
	const calls = await page
		.waitForFunction(
			(name) =>
				[...document.querySelectorAll(".toolcall .toolcall-name")].filter((n) => n.textContent?.trim() === name).length,
			OLD_TOOL,
			{ timeout: 10000 },
		)
		.then((h) => h.jsonValue())
		.catch(() => 0);
	check("both old plan_update calls show as ordinary tool calls", calls === 2, `${calls} shown`);
	await shot(page, "desktop-old-chat");
	s = await boardState(page);
	check("the old chat shows no board", s.boards === 0 && !s.boardTitle, JSON.stringify(s));
	const turnsBefore = seen.turns;
	check("the old chat carries on with a new question", await ask(page, "QO-2 still there?", "QO-2"));
	check(
		"the model is offered no plan_update tool there either",
		seen.turns > turnsBefore && seen.offeredPlanTool === 0 && seen.toldToPlan === 0,
		JSON.stringify({ turns: seen.turns - turnsBefore, offered: seen.offeredPlanTool, told: seen.toldToPlan }),
	);
	check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (err) {
	console.log(`✗ FAIL: ${err instanceof Error ? err.message : String(err)}`);
	failures += 1;
} finally {
	await browser?.close().catch(() => {});
	await srv.stop();
	await srv.mock?.close();
}
console.log(failures > 0 ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures > 0 ? 1 : 0);
