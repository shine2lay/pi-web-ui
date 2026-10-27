/* Actual App + native socket + FilesService. Only temporary authored files; no model requests. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";
const out = process.env.PI_WEB_FIXTURE_OUT || `/tmp/durable-file-host-${Date.now()}`;
mkdirSync(out, { recursive: true });
const result = { fixtureOnly: true, liveModelCalls: 0, assertions: [] };
const check = (name, value) => {
	assert.ok(value, name);
	result.assertions.push(name);
};
const sha = (value) => createHash("sha256").update(value).digest("hex");
const original = "  original temporary file 雪🙂\nsecond line\n";
const first = "  authored A Ω\n".repeat(2000);
const newer = "  newer complete B 雪🙂\n".repeat(3000);
const server = await ownServer({
	name: "durable-file-host",
	model: "fastfail",
	prepare({ root, workdir }) {
		writeFileSync(join(workdir, "draft.txt"), original);
		mkdirSync(join(root, "other"));
		writeFileSync(join(root, "other", "draft.txt"), "OTHER MUST STAY\n");
	},
});
let browser;
const deadline = (promise, what) =>
	Promise.race([
		promise,
		new Promise((_, reject) => {
			const timer = setTimeout(() => reject(new Error(`Fixture did not observe ${what}`)), 15000);
			timer.unref();
		}),
	]);
const deferred = () => {
	let resolve;
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve };
};
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
	await context.addInitScript(() => localStorage.setItem("pi-web-ui:lang", "en"));
	const page = await context.newPage();
	let errors = 0,
		prompts = 0,
		metadata,
		transport,
		upstream,
		lastRead,
		held = null,
		holdWrites = false;
	let writeReply = deferred(),
		nextSnapshot = deferred(),
		expectedWorkspace = "";
	const reads = [],
		writes = [];
	page.on("pageerror", () => {
		errors++;
	});
	await page.routeWebSocket(/\/ws(\?|$)/, (socket) => {
		transport = socket;
		upstream = socket.connectToServer();
		socket.onMessage((raw) => {
			const m = JSON.parse(String(raw));
			if (m.type === "prompt") prompts++;
			if (m.type === "read_file") reads.push(m);
			if (m.type === "write_file") writes.push(m);
			upstream.send(raw);
		});
		upstream.onMessage((raw) => {
			const m = JSON.parse(String(raw));
			if (m.type === "snapshot") {
				metadata = { sessionId: m.state.sessionId, cwd: m.state.cwd };
				if (metadata.cwd === expectedWorkspace) nextSnapshot.resolve(metadata);
			}
			if (m.type === "file_content" && m.path === "draft.txt") {
				if (m.purpose === "read") lastRead = m;
				if (m.purpose === "write") {
					if (holdWrites) held = raw;
					else socket.send(raw);
					writeReply.resolve(m);
					return;
				}
			}
			socket.send(raw);
		});
	});
	await page.goto(server.http);
	await page.waitForFunction(() => {
		const input = document.querySelector(".inputbox textarea");
		return input && !input.disabled && !!sessionStorage.getItem("pi-web-pending-owner-v1");
	});
	const row = page.locator('.panel-right .file-item.file[data-path="draft.txt"] .file-name');
	await row.waitFor();
	await row.click();
	await page.locator(".fp-attach.edit:not([disabled])").waitFor();
	check("actual server resolved initial full read", lastRead?.complete === true && lastRead.text === original);
	check(
		"App bound original workspace and real session",
		lastRead.binding.workspaceId === server.workdir && lastRead.binding.sessionId === metadata.sessionId,
	);
	check(
		"App binding is bootstrap-only; server supplies resource",
		reads[0].binding.resourceId === undefined && /^file:[a-f0-9]{64}$/.test(lastRead.binding.resourceId),
	);
	const firstRead = structuredClone(lastRead);
	await page.locator(".fp-attach.edit").click();
	await page.locator(".fp-editor").fill(first);
	holdWrites = true;
	writeReply = deferred();
	await page.locator(".fp-editor").press("Control+s");
	const actualWrite = await deadline(writeReply.promise, "actual first write result");
	check(
		"actual file updated to exact submitted A before UI acknowledgement",
		readFileSync(join(server.workdir, "draft.txt"), "utf8") === first,
	);
	check(
		"write result is exact, complete and operation-correlated",
		actualWrite.writeSucceeded === true &&
			actualWrite.complete === true &&
			actualWrite.reqId === writes[0].reqId &&
			actualWrite.lifetime === writes[0].lifetime &&
			actualWrite.text === first &&
			actualWrite.purpose === "write",
	);
	check("request carried server-resolved target", writes[0].binding.resourceId === firstRead.binding.resourceId);
	await page.locator(".fp-editor").fill(newer);
	transport.send(JSON.stringify(firstRead));
	await page.evaluate(() => new Promise(requestAnimationFrame));
	check("stale same-path read cannot replace newer editor", (await page.locator(".fp-editor").inputValue()) === newer);
	transport.send(held);
	held = null;
	holdWrites = false;
	await page.evaluate(() => new Promise(requestAnimationFrame));
	check("late successful A write cannot clear newer B", (await page.locator(".fp-editor").inputValue()) === newer);
	writeReply = deferred();
	await page.locator(".fp-editor").press("Control+s");
	const actualSecond = await deadline(writeReply.promise, "second write result");
	await page.locator(".fp-editor").waitFor({ state: "detached" });
	check(
		"unchanged B closes only after real second success",
		actualSecond.writeSucceeded === true && readFileSync(join(server.workdir, "draft.txt"), "utf8") === newer,
	);
	await page.locator(".fp-close").click();
	await row.click();
	await page.locator(".fp-attach.edit:not([disabled])").waitFor();
	check("reopen has a new genuine open lifetime", reads.at(-1).binding.openId !== reads[0].binding.openId);
	await page.locator(".fp-attach.edit").click();
	const retained = " original open must not follow workspace switch ";
	await page.locator(".fp-editor").fill(retained);
	nextSnapshot = deferred();
	expectedWorkspace = join(server.root, "other");
	upstream.send(JSON.stringify({ type: "set_cwd", path: expectedWorkspace }));
	await deadline(nextSnapshot.promise, "changed workspace snapshot");
	await page.evaluate(() => new Promise(requestAnimationFrame));
	const count = writes.length;
	await page.locator(".fp-editor").press("Control+s");
	await page.evaluate(() => new Promise(requestAnimationFrame));
	check("old open cannot publish after context switch", writes.length === count);
	check(
		"refused old-open write keeps complete editable draft",
		(await page.locator(".fp-editor").inputValue()) === retained,
	);
	check(
		"different workspace file is untouched",
		readFileSync(join(server.root, "other", "draft.txt"), "utf8") === "OTHER MUST STAY\n",
	);
	check("original saved file also remains intact", readFileSync(join(server.workdir, "draft.txt"), "utf8") === newer);
	check("no model prompt or page error", prompts === 0 && errors === 0);
	result.contentHashes = { original: sha(original), first: sha(first), newer: sha(newer) };
	await page.screenshot({ path: join(out, "retained-file-draft.png") });
	result.passed = true;
} catch (error) {
	result.passed = false;
	result.error = String(error);
	process.exitCode = 1;
} finally {
	await browser?.close();
	await server.stop();
	rmSync(server.root, { recursive: true, force: true });
	writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
	console.log(`${result.passed ? "PASS" : "FAIL"} ${result.assertions.length} actual file-host assertions; ${out}`);
	if (!result.passed) console.error(result.error);
}
