/* Real App/public boolean composer + native localStorage. All inputs/files/contexts are
 * synthetic; no model request bodies, real profiles, or real sessions are inspected. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";

const out = process.env.PI_WEB_FIXTURE_OUT || `/tmp/durable-composer-host-${Date.now()}`;
mkdirSync(out, { recursive: true });
const result = { fixtureOnly: true, liveModelCalls: 0, assertions: [], cases: [] };
const check = (label, condition) => {
	assert.ok(condition, label);
	result.assertions.push(label);
};
const fileData = Buffer.from("native composer full file 雪🙂\n".repeat(5000)).toString("base64");
const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVZ0AAAAASUVORK5CYII=";
const incoming = {
	text: "  exact injected Markdown **雪**\n",
	attachments: [
		{
			path: "",
			name: "complete-雪.txt",
			fileData,
			mimeType: "text/plain",
			size: Buffer.from(fileData, "base64").length,
			key: "incoming-file",
		},
		{ path: "", name: "one-pixel.png", imageData, mimeType: "image/png", key: "incoming-image" },
		{ path: "https://fixture.example", name: "already authorized reference", mode: "page" },
	],
};
const prefix = "pi-web-ui:composer-checkpoint:record:v1:";
const server = await ownServer({ name: "durable-composer-host", model: "fastfail" });
let browser;
async function records(page) {
	return page.evaluate(
		(prefix) =>
			Object.keys(localStorage)
				.filter((key) => key.startsWith(prefix))
				.map((key) => ({ key, raw: localStorage.getItem(key) }))
				.sort((a, b) => a.key.localeCompare(b.key)),
		prefix,
	);
}
async function setup() {
	const context = await browser.newContext({
		viewport: { width: 1440, height: 1000 },
		locale: "en-US",
		acceptDownloads: true,
	});
	await context.addInitScript(() => {
		localStorage.setItem("pi-web-ui:lang", "en");
		window.fixtureFault = "none";
		window.fixtureFaultCount = 0;
		const set = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			const target = this === localStorage && String(key).startsWith("pi-web-ui:composer-checkpoint:record:v1:");
			if (target && window.fixtureFault === "quota") {
				window.fixtureFaultCount++;
				throw new DOMException("synthetic quota", "QuotaExceededError");
			}
			const result = set.call(this, key, value);
			if (target && window.fixtureFault === "after-set") {
				window.fixtureFaultCount++;
				throw new Error("synthetic interruption after commit");
			}
			if (target && window.fixtureFault === "edit") {
				window.fixtureFaultCount++;
				const field = document.querySelector(".inputbox textarea");
				Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(
					field,
					"newer edit during checkpoint",
				);
				field.dispatchEvent(new Event("input", { bubbles: true }));
			}
			return result;
		};
	});
	const page = await context.newPage();
	const wire = { prompts: 0, errors: [], initialized: 0, sessionId: "", socket: null, upstream: null, offline: false };
	page.on("pageerror", (error) => wire.errors.push(String(error)));
	await page.routeWebSocket(/\/ws(\?|$)/, (socket) => {
		if (wire.offline) {
			socket.close({ code: 1001, reason: "synthetic offline" });
			return;
		}
		const upstream = socket.connectToServer();
		wire.socket = socket;
		wire.upstream = upstream;
		socket.onMessage((raw) => {
			const message = JSON.parse(String(raw));
			if (message.type === "prompt") wire.prompts++;
			upstream.send(raw);
		});
		upstream.onMessage((raw) => {
			const message = JSON.parse(String(raw));
			if (message.type === "snapshot") wire.sessionId = message.state.sessionId;
			if (message.type === "session_initialized") wire.initialized++;
			socket.send(raw);
		});
	});
	const boot = async () => {
		await page.locator(".inputbox textarea").waitFor();
		await page.waitForFunction(
			() =>
				!!window.__piWebUiHost?.compose &&
				!!sessionStorage.getItem("pi-web-pending-owner-v1") &&
				document.querySelector(".status-conn.ok"),
		);
		assert.ok(wire.sessionId && wire.initialized);
	};
	await page.goto(server.http);
	await boot();
	return { context, page, wire, boot };
}
async function setSource(page) {
	await page
		.locator('.inputbox input[type="file"]')
		.setInputFiles({ name: "source.txt", mimeType: "text/plain", buffer: Buffer.from("original source attachment") });
	await page.locator(".attach-chip").filter({ hasText: "source.txt" }).waitFor();
	await page.locator(".inputbox textarea").fill("original source trailing  \n");
}
try {
	browser = await chromium.launch({
		executablePath: CHROME_PATH,
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
	});
	{
		const { context, page, wire, boot } = await setup();
		await setSource(page);
		const beforeText = await page.locator(".inputbox textarea").inputValue();
		const admitted = await page.evaluate((payload) => window.__piWebUiHost.compose(payload), incoming);
		if (admitted !== true)
			console.error({
				notices: await page.locator(".notice").allTextContents(),
				saved: (await records(page)).length,
				errors: wire.errors,
			});
		check("public compose returns exact synchronous true", admitted === true);
		await page.locator(".attach-chip").filter({ hasText: "complete-雪.txt" }).waitFor();
		const saved = await records(page);
		check("one complete native checkpoint exists before accepted placement", saved.length === 1);
		const record = JSON.parse(saved[0].raw);
		assert.deepEqual(record.incoming, incoming);
		check(
			"original source words and attachment bytes retained",
			record.source.text === beforeText &&
				record.source.attachments[0].fileData === Buffer.from("original source attachment").toString("base64"),
		);
		assert.equal(await page.locator(".inputbox textarea").inputValue(), record.effective.text);
		check(
			"both full sink halves match native checkpoint",
			(await page.locator(".attach-chip").count()) === record.effective.attachments.length,
		);
		check("compose never sends a prompt", wire.prompts === 0);
		const sessionId = wire.sessionId;
		await page.reload();
		await boot();
		check(
			"reload returns to the same native session without replay",
			wire.sessionId === sessionId && wire.prompts === 0,
		);
		assert.deepEqual(await records(page), saved);
		await page.locator(".composer-recovery > summary").click();
		const row = page.locator(`[data-composer-record="${record.recordId}"]`);
		await row.getByRole("button", { name: "Restore this composer draft", exact: true }).click();
		await page.locator(".attach-chip").filter({ hasText: "complete-雪.txt" }).waitFor();
		check(
			"explicit reload recovery restores full editable text once, not duplicated L1 text",
			(await page.locator(".inputbox textarea").inputValue()) === record.effective.text,
		);
		check(
			"explicit recovery restores all original attachment chips",
			(await page.locator(".attach-chip").count()) === record.effective.attachments.length,
		);
		const after = await records(page);
		assert.ok(after.some((item) => item.key === saved[0].key && item.raw === saved[0].raw));
		check("restoration retains immutable original and sends nothing", wire.prompts === 0 && after.length === 2);
		const pendingDownload = page.waitForEvent("download");
		await page.getByRole("button", { name: "Export complete composer originals", exact: true }).click();
		const download = await pendingDownload;
		const exported = JSON.parse(readFileSync(await download.path(), "utf8"));
		assert.ok(exported.entries.some((entry) => entry.raw === saved[0].raw));
		check(
			"App exports complete original raw record and exact embedded bytes",
			exported.entries.some((entry) => entry.record?.incoming?.attachments?.[0]?.fileData === fileData),
		);
		wire.offline = true;
		wire.socket.close({ code: 1001, reason: "synthetic offline" });
		wire.upstream.close();
		await page.locator(".status-conn:not(.ok)").waitFor();
		const offline = await page.evaluate(() => window.__piWebUiHost.compose({ text: "offline local addition" }));
		check("known original composer remains safely usable offline", offline === true);
		check("offline injection does not send or restart the session", wire.prompts === 0);
		check("native accepted/recovered composer has no page errors", wire.errors.length === 0);
		await page.screenshot({ path: join(out, "composer.png"), fullPage: false });
		result.cases.push({
			kind: "success-reload-offline",
			originalSha256: createHash("sha256").update(saved[0].raw).digest("hex"),
		});
		await context.close();
	}
	for (const fault of ["quota", "after-set", "edit"]) {
		const { context, page, wire } = await setup();
		await setSource(page);
		const sourceText = await page.locator(".inputbox textarea").inputValue();
		await page.evaluate((fault) => {
			window.fixtureFault = fault;
		}, fault);
		const admitted = await page.evaluate((payload) => window.__piWebUiHost.compose(payload), incoming);
		check(
			`${fault}: native fault exercised and public boolean refuses`,
			admitted === false && (await page.evaluate(() => window.fixtureFaultCount)) > 0,
		);
		check(
			`${fault}: source or newer edit remains fully editable`,
			(await page.locator(".inputbox textarea").inputValue()) ===
				(fault === "edit" ? "newer edit during checkpoint" : sourceText),
		);
		check(
			`${fault}: attachment source kept, no partial incoming placement`,
			(await page.locator(".attach-chip").count()) === 1 &&
				(await page.locator(".attach-chip").filter({ hasText: "source.txt" }).count()) === 1,
		);
		const saved = await records(page);
		check(
			`${fault}: correct immutable checkpoint outcome`,
			fault === "quota" ? saved.length === 0 : saved.length === 1,
		);
		if (fault !== "quota") {
			const original = JSON.parse(saved[0].raw);
			assert.deepEqual(original.incoming, incoming);
			assert.equal(original.source.text, sourceText);
		}
		check(
			`${fault}: failure visible without dispatch or page crash`,
			(await page.locator("body").innerText()).includes("Composer checkpoint") &&
				wire.prompts === 0 &&
				wire.errors.length === 0,
		);
		result.cases.push({ kind: fault });
		await context.close();
	}
	writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
	console.log(`PASS ${result.assertions.length} actual composer assertions: ${out}`);
} catch (error) {
	writeFileSync(join(out, "result.json"), JSON.stringify({ ...result, error: String(error) }, null, 2));
	throw error;
} finally {
	await browser?.close();
	await server.stop();
}
