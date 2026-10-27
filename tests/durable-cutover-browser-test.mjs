/* W2 cross-module browser fixture. Only ownServer's temporary chats, unreachable fastfail model,
 * and a fresh browser. The delayed first binding is injected at the browser WS boundary, not a
 * claim about live initialization speed. Never inspect model-bound requests, prompts or tools. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";

const out = process.env.PI_WEB_FIXTURE_OUT || `/tmp/durable-w2-browser-${Date.now()}`;
// Optional separately-built reviewed classic distribution; never change the live extension.
const bcpFixture = process.env.PI_WEB_BCP_FIXTURE;
mkdirSync(out, { recursive: true });
let file;
let fixtureId;
let fixturePaths;
function seedHistory({ agentDir, workdir }) {
	const sessionDir = join(agentDir, "sessions", `--${workdir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	const manager = SessionManager.create(workdir, sessionDir);
	for (let i = 0; i < 122; i++) {
		manager.appendMessage({
			role: i % 2 === 0 ? "user" : "assistant",
			content: [
				{
					type: "text",
					text:
						i === 121
							? "Quote fixture text.\n\n[[action:suggest:Fixture follow-up|FIXTURE FOLLOW UP]]"
							: `Fixture message ${i}.`,
				},
			],
			timestamp: 1_700_000_000_000 + i,
			...(i % 2
				? {
						api: "openai-completions",
						provider: "fastfail",
						model: "fastfail",
						stopReason: "stop",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					}
				: {}),
		});
	}
	manager.appendSessionInfo("W2 browser fixture");
	file = manager.getSessionFile();
	fixtureId = manager.getSessionId();
}
const server = await ownServer({
	name: "durable-w2-browser",
	model: "fastfail",
	env: { PI_WEB_HISTORY_WINDOW: "6", PI_WEB_MESSAGE_WINDOW: "6", PI_WEB_EXCHANGE_DIGESTS: "0" },
	prepare: async (paths) => {
		fixturePaths = paths;
		if (bcpFixture) {
			const settingsFile = join(paths.agentDir, "settings.json");
			const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
			writeFileSync(settingsFile, JSON.stringify({ ...settings, packages: [bcpFixture] }));
		}
	},
});
let browser;
const result = { fixtureOnly: true, liveModelCalls: 0, assertions: [], screenshots: [] };
const check = (name, condition) => {
	assert.ok(condition, name);
	result.assertions.push(name);
};
const deferred = () => {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
};
async function observed(promise, name) {
	let timeout;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timeout = setTimeout(() => reject(new Error(`Fixture did not observe ${name}`)), 30_000);
			}),
		]);
	} finally {
		clearTimeout(timeout);
	}
}
async function quote(page, text) {
	const node = page.getByText(text, { exact: true });
	await node.scrollIntoViewIfNeeded();
	await node.dispatchEvent("pointerdown", { button: 0 });
	await node.evaluate((element) => {
		const range = document.createRange();
		range.selectNodeContents(element);
		const selection = window.getSelection();
		selection.removeAllRanges();
		selection.addRange(range);
		document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
	});
	await page.locator(".quote-selection-button").click();
}
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const context = await browser.newContext({
		viewport: { width: 1440, height: 1000 },
		locale: "en-US",
		timezoneId: "UTC",
	});
	await context.addInitScript(() => {
		localStorage.setItem("pi-web-ui:lang", "en");
		localStorage.setItem("pi-web-ui:theme", "flow-light");
		const Native = window.WebSocket;
		window.WebSocket = class extends Native {
			constructor(...args) {
				super(...args);
				window.fixtureSocket = this;
			}
		};
	});
	let pageErrors = 0;
	let readyCount = 0;
	let connections = 0;
	let bindingHeld = true;
	let sentPreview = false;
	const held = [];
	const initialized = deferred();
	const prompted = deferred();
	const accepted = deferred();
	const opened = deferred();
	const pageReplies = [];
	const pageRequests = [];
	const prompts = [];
	let peer;
	let firstBinding;
	let latestState;
	let heldPage;
	let waitingForPage = deferred();
	await context.routeWebSocket(/\/ws(\?|$)/, (socket) => {
		connections++;
		peer = socket;
		const upstream = socket.connectToServer();
		socket.onMessage((raw) => {
			const frame = JSON.parse(String(raw));
			if (frame.type === "prompt") {
				prompts.push(frame);
				prompted.resolve();
			}
			if (frame.type === "load_earlier_messages") pageRequests.push(frame);
			upstream.send(raw);
		});
		upstream.onMessage((raw) => {
			const frame = JSON.parse(String(raw));
			if (frame.type === "ready") readyCount++;
			if (frame.type === "prompt_ack" && frame.id === prompts[0]?.id) accepted.resolve(frame);
			if (frame.type === "snapshot") {
				latestState = frame.state;
				if (bindingHeld) {
					held.push(raw);
					if (!sentPreview && frame.state.sessionId) {
						sentPreview = true;
						firstBinding = raw;
						socket.send(
							JSON.stringify({
								...frame,
								state: {
									...frame.state,
									sessionId: "",
									messagesStart: 0,
									messages: [
										{
											id: "provisional-fixture",
											role: "assistant",
											content: [{ type: "text", text: "Provisional quote fixture." }],
										},
									],
								},
							}),
						);
						initialized.resolve();
					}
					return;
				}
				if (frame.state.sessionId === fixtureId) opened.resolve();
			}
			if (frame.type === "snapshot_delta" && bindingHeld) {
				held.push(raw);
				return;
			}
			if (frame.type === "earlier_messages") {
				pageReplies.push(frame);
				// Scroll-to-top may request before the explicit click. Hold it too.
				heldPage = raw;
				waitingForPage.resolve();
				return;
			}
			socket.send(raw);
		});
	});
	const page = await context.newPage();
	page.on("pageerror", () => {
		pageErrors++;
	});
	await page.goto(server.http);
	await observed(initialized.promise, "provisional first binding");
	const composer = page.locator(".inputbox textarea");
	await quote(page, "Provisional quote fixture.");
	check("unbound composeToComposer is refused before a host UUID binds (#595)", (await composer.inputValue()) === "");
	const draft = "> Provisional quote fixture.\n\nTyped pre-binding fixture.";
	const initializingPlaceholder = await composer.getAttribute("placeholder");
	await composer.fill(draft);
	check("composer is editable before a host UUID binds", (await composer.inputValue()) === draft);
	await composer.press("Enter");
	check("pre-binding submit does not send a prompt", prompts.length === 0);
	bindingHeld = false;
	for (const raw of held) peer.send(raw);
	await page.waitForFunction((before) => {
		const input = document.querySelector(".inputbox textarea");
		return input && !input.disabled && input.placeholder !== before;
	}, initializingPlaceholder);
	check("binding preserves the entire typed and quoted draft", (await composer.inputValue()) === draft);
	check("binding alone does not submit an unaccepted draft", prompts.length === 0);
	await composer.press("Enter");
	await observed(prompted.promise, "explicit first bound send");
	// Re-delivery of the original binding must not send the accepted draft again.
	peer.send(firstBinding);
	const acknowledgment = await observed(accepted.promise, "temporary user's prompt_ack");
	check("the exact submitted send is acknowledged as accepted", acknowledgment.ok === true);
	await page.waitForFunction(() => document.querySelector(".inputbox textarea")?.value === "");
	check("typed and quoted pre-binding draft sends exactly once", prompts.length === 1 && prompts[0].text === draft);
	const firstSessionFile = latestState.sessionFile;
	await page.waitForFunction(() => !document.querySelector(".btn.stop"));
	const ownMessages = readFileSync(firstSessionFile, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	check(
		"exactly one accepted user message is saved in the temporary native transcript",
		ownMessages.filter(
			(row) =>
				row.type === "message" &&
				row.message.role === "user" &&
				row.message.content.some((block) => block.type === "text" && block.text === draft),
		).length === 1,
	);
	// Only create history after the initial send, so auto-resume cannot mix these two fixtures.
	seedHistory(fixturePaths);
	const originalHistory = readFileSync(file, "utf8");
	check(
		"the fixed history fixture is independent from the draft's native transcript",
		file !== firstSessionFile && fixtureId !== latestState.sessionId,
	);
	await page.evaluate((path) => window.fixtureSocket.send(JSON.stringify({ type: "switch_session", path })), file);
	await observed(opened.promise, "seeded fixture snapshot");
	await page.getByText("Quote fixture text.", { exact: true }).waitFor();
	check(
		"initial native snapshot is budgeted at its absolute boundary",
		latestState.messagesStart === 116 && latestState.messages.length === 6,
	);
	const initialTail = latestState.messages;
	check(
		"suggestion chip is rendered without raw markup",
		(await page.getByRole("button", { name: "Fixture follow-up", exact: true }).count()) === 1,
	);
	check(
		"a suggestion label does not leak its marker into the transcript",
		!(await page.locator(".messages").innerText()).includes("[[action:suggest:"),
	);
	await quote(page, "Quote fixture text.");
	check(
		"Select-to-quote uses the actual rendered transcript",
		(await composer.inputValue()).includes("> Quote fixture text."),
	);
	await composer.fill("");
	await page.waitForFunction(() =>
		[...document.styleSheets].some((sheet) => sheet.href?.includes("flow-light") && sheet.cssRules.length > 0),
	);
	await page.evaluate(() => document.fonts.ready);
	check("flow-light stylesheet loads in the built page", true);

	for (const expectedStart of [86, 56, 26, 0]) {
		const button = page.locator(".load-older button");
		await button.scrollIntoViewIfNeeded();
		const anchor = await page.evaluate(() => {
			const list = document.querySelector(".messages");
			const node = [...list.querySelectorAll("[data-msg-id]")].find(
				(element) => element.getBoundingClientRect().bottom > list.getBoundingClientRect().top,
			);
			return { id: node.getAttribute("data-msg-id"), y: node.getBoundingClientRect().top };
		});
		await button.click();
		await observed(waitingForPage.promise, "engine fallback page");
		await button.click();
		const reply = pageReplies.at(-1);
		const request = pageRequests.at(-1);
		result.pages ??= [];
		result.pages.push({
			beforeIndex: request?.beforeIndex,
			limit: request?.limit,
			start: reply.historyStart,
			count: reply.messages.length,
			sessionMatches: reply.sessionId === fixtureId,
		});
		check(
			`fallback page ${expectedStart} has positioned, session-bound metadata`,
			reply.historyStart === expectedStart && reply.sessionId === fixtureId,
		);
		const pageToRelease = heldPage;
		heldPage = undefined;
		waitingForPage = deferred();
		peer.send(pageToRelease);
		await page.waitForFunction(
			(id) =>
				[...document.querySelectorAll("[data-msg-id]")].some((element) => element.getAttribute("data-msg-id") === id),
			reply.messages[0].id,
		);
		await page.waitForFunction(({ id, y }) => {
			const node = [...document.querySelectorAll("[data-msg-id]")].find(
				(element) => element.getAttribute("data-msg-id") === id,
			);
			return node && Math.abs(node.getBoundingClientRect().top - y) < 2;
		}, anchor);
		check(`prepend ${expectedStart} preserves the visible message anchor`, true);
	}
	check(
		"four pages are ordered and each pending request is sent once",
		pageRequests.length === 4 && pageReplies.length === 4,
	);
	check(
		"all earlier history is reachable without a reconnect",
		(await page.locator(".load-older button").count()) === 0,
	);
	const reconstructed = [...pageReplies.toReversed().flatMap((reply) => reply.messages), ...initialTail];
	assert.deepEqual(
		reconstructed.map((message) => ({
			role: message.role,
			text: message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join(""),
		})),
		Array.from({ length: 122 }, (_, i) => ({
			role: i % 2 === 0 ? "user" : "assistant",
			text:
				i === 121
					? "Quote fixture text.\n\n[[action:suggest:Fixture follow-up|FIXTURE FOLLOW UP]]"
					: `Fixture message ${i}.`,
		})),
	);
	check("paging reconstructs every known message's complete content and order", true);
	check(
		"paging preserves every original native JSONL byte and relationship",
		readFileSync(file, "utf8").startsWith(originalHistory),
	);
	await page.getByRole("button", { name: "Tool Inspector", exact: true }).click();
	const readSwitch = page.getByRole("switch", { name: "Enable read", exact: true });
	await readSwitch.waitFor();
	check("Tool Inspector mounts against a real temporary native runtime", await readSwitch.isChecked());
	if (bcpFixture) {
		check(
			"reviewed classic BCP compress is callable in the current native host",
			await page.getByRole("switch", { name: "Enable compress", exact: true }).isChecked(),
		);
		check(
			"reviewed classic BCP decompress is callable in the current native host",
			await page.getByRole("switch", { name: "Enable decompress", exact: true }).isChecked(),
		);
	}
	await readSwitch.uncheck();
	await page.waitForFunction(
		() =>
			document.querySelector(".pti-content")?.getAttribute("aria-busy") === "false" &&
			document.querySelector('[aria-label="Enable read"]')?.checked === false,
	);
	check("tool override is saved through the host-mounted HTTP route", true);
	const inspectorShot = join(out, "tool-inspector.png");
	await page.screenshot({ path: inspectorShot });
	result.screenshots.push(inspectorShot);
	await page.locator(".pti-close").click();
	const historyShot = join(out, "history.png");
	await page.screenshot({ path: historyShot });
	result.screenshots.push(historyShot);
	check("the whole fixture stays on one WebSocket handshake", connections === 1 && readyCount === 1);
	check("no browser page errors", pageErrors === 0);
	console.log(`PASS W2 isolated browser fixture: ${result.assertions.length} assertions; zero live models/chats`);
} catch (error) {
	result.failure = String(error?.message || error);
	throw error;
} finally {
	writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
	await browser?.close();
	await server.stop();
	rmSync(server.root, { recursive: true, force: true });
	console.log(`Fixture evidence: ${out}`);
}
