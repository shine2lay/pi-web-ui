/* Actual App, one full-payload admission and native PTY. All inputs/files belong
 * to ownServer's isolated workspace; never read a model request or real chat. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";
const out = process.env.PI_WEB_FIXTURE_OUT || `/tmp/durable-terminal-host-${Date.now()}`;
mkdirSync(out, { recursive: true });
const result = {
	fixtureOnly: true,
	liveModelCalls: 0,
	assertions: [],
	diagnostic: { commands: 0, dispositions: [], notices: [], errors: [] },
};
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
const deadline = (promise, what) =>
	Promise.race([
		promise,
		new Promise((_, reject) => {
			const timer = setTimeout(() => reject(new Error(`Fixture did not observe ${what}`)), 15000);
			timer.unref();
		}),
	]);
const command = {
	name: "W2 exact once",
	command:
		'  node -e \'require("fs").appendFileSync("command-count.txt","once\\n");process.stdout.write("OWNED-OUTPUT-SNOW\\n")\'; exit  ',
	cwd: "${pwd}",
};
const server = await ownServer({
	name: "durable-terminal-host",
	model: "fastfail",
	prepare({ workdir }) {
		mkdirSync(join(workdir, ".pi"), { recursive: true });
		writeFileSync(join(workdir, ".pi/commands.json"), JSON.stringify({ commands: [command] }));
	},
});
let browser, page;
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
	await context.addInitScript(() => localStorage.setItem("pi-web-ui:lang", "en"));
	page = await context.newPage();
	let pageErrors = 0,
		promptCount = 0,
		upstream,
		commandFrame,
		initialized = deferred(),
		exited = deferred(),
		attached = deferred(),
		duplicate = deferred();
	const actions = [],
		views = [];
	let liveOutput = "";
	page.on("pageerror", (error) => {
		pageErrors++;
		result.diagnostic.errors.push(String(error));
	});
	await page.routeWebSocket(/\/ws(\?|$)/, (socket) => {
		upstream = socket.connectToServer();
		const owner = upstream;
		socket.onMessage((raw) => {
			const m = JSON.parse(String(raw));
			if (m.type === "prompt") promptCount++;
			if (m.type === "run_command") {
				result.diagnostic.commands++;
				actions.push(m);
				commandFrame = String(raw);
			}
			owner.send(raw);
		});
		owner.onMessage((raw) => {
			const m = JSON.parse(String(raw));
			if (m.type === "session_initialized") initialized.resolve();
			if (m.type === "notice") result.diagnostic.notices.push(m.text);
			if (m.type === "command_disposition") result.diagnostic.dispositions.push({ reason: m.reason, status: m.status });
			if (m.type === "terminal_output") liveOutput += m.data;
			if (m.type === "terminal_exit") exited.resolve(m);
			if (m.type === "terminal_view") {
				views.push(m);
				if (m.terminalId === actions[0]?.terminalId || m.reqId === "fixture-missing") attached.resolve(m);
			}
			if (m.type === "command_disposition" && m.reason === "command-already-owned") duplicate.resolve(m);
			socket.send(raw);
		});
	});
	await page.goto(server.http);
	await deadline(initialized.promise, "startup");
	await page.waitForFunction(() => !!sessionStorage.getItem("pi-web-pending-owner-v1"));
	await page.getByRole("tab", { name: "Terminal", exact: true }).click();
	const button = page.locator(".cmd-item").filter({ hasText: command.name }).locator(".cmd-run");
	await button.waitFor();
	await button.click();
	await deadline(exited.promise, "single native command exit");
	const firstView = await deadline(attached.promise, "actual first view replay");
	await page.locator('[data-attach-state="attached"]').waitFor();
	check("actual UI command has one wire owner", actions.length === 1);
	check(
		"complete original command preserves exact whitespace/options",
		actions[0].original.command.command === command.command && actions[0].original.command.cwd === command.cwd,
	);
	check(
		"wire and original are bound to same real context",
		actions[0].original.sessionId === actions[0].recovery.sessionId &&
			actions[0].original.conversationId === actions[0].conversationId &&
			actions[0].original.workspaceCwd === server.workdir,
	);
	check("one native command side effect", readFileSync(join(server.workdir, "command-count.txt"), "utf8") === "once\n");
	result.diagnostic.viewSummary = views.map((view) => ({
		originalTarget: view.terminalId === actions[0]?.terminalId,
		available: view.available,
		reason: view.reason,
		bytes: view.data?.length,
		containsOutput: view.data?.includes("OWNED-OUTPUT-SNOW"),
	}));
	result.diagnostic.outputLength = liveOutput.length;
	result.diagnostic.outputObserved = liveOutput.includes("OWNED-OUTPUT-SNOW");
	check(
		"mount receives existing-only view and native output",
		firstView.available && (firstView.data + liveOutput).includes("OWNED-OUTPUT-SNOW"),
	);
	upstream.send(commandFrame);
	const duplicateReply = await deadline(duplicate.promise, "duplicate ownership refusal");
	check(
		"duplicate wire is uncertainty not execution or release",
		duplicateReply.status === "uncertain" &&
			duplicateReply.persistence === "unknown" &&
			duplicateReply.releaseClientCopy === false,
	);
	check(
		"duplicate request cannot rerun native command",
		readFileSync(join(server.workdir, "command-count.txt"), "utf8") === "once\n",
	);
	initialized = deferred();
	attached = deferred();
	await page.reload();
	await deadline(initialized.promise, "reload startup");
	await page.getByRole("tab", { name: "Terminal", exact: true }).click();
	const remount = await deadline(attached.promise, "reload existing terminal replay");
	await page.locator('[data-attach-state="attached"]').waitFor();
	check(
		"reload restores full existing output without another command",
		remount.available && remount.data.includes("OWNED-OUTPUT-SNOW") && actions.length === 1,
	);
	check(
		"reload does not duplicate native effect",
		readFileSync(join(server.workdir, "command-count.txt"), "utf8") === "once\n",
	);
	attached = deferred();
	upstream.send(
		JSON.stringify({
			type: "terminal_attach",
			reqId: "fixture-missing",
			viewId: "fixture-view",
			conversationId: actions[0].conversationId,
			sessionId: actions[0].original.sessionId,
			terminalId: "unknown-fixture-terminal",
			cols: 80,
			rows: 24,
		}),
	);
	const missing = await deadline(attached.promise, "missing output refusal");
	check("missing output is unavailable, never recreated", missing.available === false && missing.reason === "missing");
	check(
		"missing view and remount leave original bytes unchanged",
		readFileSync(join(server.workdir, "command-count.txt"), "utf8") === "once\n",
	);
	check("no model action or browser error", promptCount === 0 && pageErrors === 0);
	await page.screenshot({ path: join(out, "terminal.png") });
	writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
	console.log(JSON.stringify({ pass: true, assertions: result.assertions.length, out }));
} catch (error) {
	result.diagnostic.commandState = await page?.locator(".terminal-view").getAttribute("data-command-state");
	console.error(result.diagnostic);
	console.error(error);
	writeFileSync(join(out, "failure.json"), JSON.stringify({ ...result, error: String(error) }, null, 2));
	throw error;
} finally {
	await browser?.close();
	await server.stop();
	rmSync(server.root, { recursive: true, force: true });
}
