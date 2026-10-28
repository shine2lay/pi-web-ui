/* Real App / public boolean window.__piWebUiHost.startChat + native localStorage checkpoint
 * (#584) + PluginStartRecoveryPanel. All inputs/files/contexts are synthetic; no model
 * request bodies, real profiles, or real sessions are inspected. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";

const out = process.env.PI_WEB_FIXTURE_OUT || `/tmp/durable-plugin-start-host-${Date.now()}`;
mkdirSync(out, { recursive: true });
const result = { fixtureOnly: true, liveModelCalls: 0, assertions: [], cases: [] };
const check = (label, condition) => {
	assert.ok(condition, label);
	result.assertions.push(label);
};

const prefix = "pi-web-plugin-start-v1:";
const server = await ownServer({ name: "durable-plugin-start-host", model: "fastfail" });
let browser;

async function records(page, kindPrefix = prefix) {
	return page.evaluate(
		(pfx) =>
			Object.keys(localStorage)
				.filter((key) => key.startsWith(pfx))
				.map((key) => ({ key, raw: localStorage.getItem(key) }))
				.sort((a, b) => a.key.localeCompare(b.key)),
		kindPrefix,
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
		window.fixtureIdbAbort = false;
		const set = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			const isIntent = this === localStorage && String(key).startsWith('pi-web-plugin-start-v1:["intent",');
			if (isIntent && window.fixtureFault === "quota") {
				window.fixtureFaultCount++;
				throw new DOMException("synthetic quota", "QuotaExceededError");
			}
			const r = set.call(this, key, value);
			if (isIntent && window.fixtureFault === "after-set") {
				window.fixtureFaultCount++;
				throw new Error("synthetic interruption after intent commit");
			}
			return r;
		};
		const origPut = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function (...args) {
			const req = origPut.apply(this, args);
			if (window.fixtureIdbAbort && this.transaction) {
				window.fixtureIdbAbort = false;
				this.transaction.abort();
			}
			return req;
		};
	});
	const page = await context.newPage();
	const wire = {
		prompts: 0,
		newChats: 0,
		setCwds: 0,
		setModels: 0,
		errors: [],
		initialized: 0,
		sessionId: "",
		socket: null,
		upstream: null,
		dropPrompts: false,
	};
	page.on("pageerror", (error) => wire.errors.push(String(error)));
	await page.routeWebSocket(/\/ws(\?|$)/, (socket) => {
		const upstream = socket.connectToServer();
		wire.socket = socket;
		wire.upstream = upstream;
		wire.sessionId = "";
		wire.socketInitialized = false;
		socket.onMessage((raw) => {
			const message = JSON.parse(String(raw));
			if (message.type === "new_chat") wire.newChats++;
			if (message.type === "set_cwd") wire.setCwds++;
			if (message.type === "set_model") wire.setModels++;
			if (message.type === "prompt") {
				wire.prompts++;
				if (wire.dropPrompts) return;
			}
			upstream.send(raw);
		});
		upstream.onMessage((raw) => {
			const message = JSON.parse(String(raw));
			if (message.type === "snapshot") wire.sessionId = message.state.sessionId;
			if (message.type === "session_initialized") {
				wire.initialized++;
				wire.socketInitialized = true;
			}
			socket.send(raw);
		});
	});
	const boot = async () => {
		await page.locator(".inputbox textarea").waitFor();
		await page.locator('button[aria-label="Tool Inspector"]:not([disabled])').waitFor();
		await page.waitForFunction(() =>
			Boolean(
				window.__piWebUiHost?.startChat &&
				sessionStorage.getItem("pi-web-pending-owner-v1") &&
				document.querySelector(".status-conn.ok") &&
				document.querySelector('button[aria-label="Tool Inspector"]:not([disabled])'),
			),
		);
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const hasLock = await page.evaluate(async () => {
				const ownerId = sessionStorage.getItem("pi-web-pending-owner-v1");
				if (!ownerId || !navigator.locks?.query) return false;
				const locks = await navigator.locks.query();
				return (locks.held ?? []).some((l) => l.name === `pi-web-plugin-start-owner-v1:${ownerId}`);
			});
			if (hasLock && wire.sessionId && wire.socketInitialized) break;
			await new Promise((r) => setTimeout(r, 25));
		}
		assert.ok(wire.sessionId && wire.socketInitialized);
	};
	// ?recovery=1: the recovery panels (#611) and the Tool Inspector button this test waits on (Ops #621) show only
	// with it (web/src/url-flags.ts); page.reload() keeps it.
	await page.goto(`${server.http}/?recovery=1`);
	await boot();
	return { context, page, wire, boot };
}

try {
	browser = await chromium.launch({
		executablePath: CHROME_PATH,
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
	});

	// Case 1: Accepted startChat checkpoints full original untrimmed options before true, mutating caller input after true has no effect, reload does not auto-replay, and PluginStartRecoveryPanel restores untrimmed prompt + exports raw JSON.
	{
		const { context, page, wire, boot } = await setup();
		const sourceSessionId = wire.sessionId;
		const admitted = await page.evaluate(() => {
			const opts = {
				prompt: "  exact startChat prompt **雪**\n",
				newChat: true,
				cwd: undefined,
			};
			const ok = window.__piWebUiHost.startChat(opts);
			opts.prompt = "caller mutated after synchronous return";
			opts.newChat = false;
			opts.cwd = "/mutated";
			return ok;
		});
		check("public startChat returns exact synchronous true after checkpoint", admitted === true);
		const intentRows = await records(page, `${prefix}["intent",`);
		const beginRows = await records(page, `${prefix}["begin",`);
		check(
			"one complete native intent and begin marker exist immediately after true",
			intentRows.length === 1 && beginRows.length === 1,
		);
		const intent = JSON.parse(intentRows[0].raw);
		check(
			"stored intent preserves exact untrimmed prompt and option presence metadata despite caller mutation",
			intent.original.prompt === "  exact startChat prompt **雪**\n" &&
				intent.original.newChat?.presence === "value" &&
				intent.original.newChat?.value === true &&
				intent.original.cwd?.presence === "undefined" &&
				intent.original.model?.presence === "absent" &&
				intent.effective.prompt === "exact startChat prompt **雪**" &&
				intent.source.sessionId === sourceSessionId,
		);

		const sendDeadline = Date.now() + 10_000;
		while (Date.now() < sendDeadline && (wire.newChats < 1 || wire.prompts < 1)) {
			await new Promise((r) => setTimeout(r, 25));
		}
		if (wire.newChats !== 1 || wire.prompts !== 1) {
			const debug = await page.evaluate(() => ({
				panel: document.querySelector('[data-testid="plugin-start-recovery-panel"]')?.textContent ?? null,
			}));
			console.error("startChat wire debug:", wire, debug);
		}
		check("accepted startChat dispatched one new_chat and one prompt", wire.newChats === 1 && wire.prompts === 1);
		const targetSessionId = wire.sessionId;
		check("new_chat preserved valid target session binding for prompt admission", Boolean(targetSessionId));

		// Reload the page: verify zero automatic replay of new_chat or prompt!
		await page.reload();
		await boot();
		check("page reload does not re-execute startChat new_chat or prompt", wire.newChats === 1 && wire.prompts === 1);

		const panel = page.locator('[data-testid="plugin-start-recovery-panel"]');
		await panel.waitFor();
		await panel.locator("summary").click();
		const restoreBtn = panel.locator(
			`[data-plugin-start-intent="${intent.intentId}"] [data-testid="plugin-start-restore"]`,
		);
		await restoreBtn.waitFor();
		await restoreBtn.click();
		await page.locator('[data-testid="plugin-start-recovery-status"]').waitFor();
		await page.waitForFunction(
			() => document.querySelector(".inputbox textarea")?.value === "  exact startChat prompt **雪**\n",
			null,
			{ timeout: 5_000 },
		);
		check(
			"explicit recovery restores exact untrimmed original prompt to composer without sending",
			(await page.locator(".inputbox textarea").inputValue()) === "  exact startChat prompt **雪**\n" &&
				wire.newChats === 1 &&
				wire.prompts === 1,
		);

		const pendingDownload = page.waitForEvent("download");
		await panel.locator('[data-testid="plugin-start-export"]').click();
		const download = await pendingDownload;
		const exported = JSON.parse(readFileSync(await download.path(), "utf8"));
		check(
			"PluginStartRecoveryPanel exports complete raw localStorage intent and begin records",
			exported.format === "pi-web-plugin-start-export" &&
				exported.complete === true &&
				exported.records.some((e) => e.key === intentRows[0].key && e.raw === intentRows[0].raw),
		);
		check("native accepted/reload/restore startChat has no page errors", wire.errors.length === 0);
		await page.screenshot({ path: join(out, "plugin-start-recovery.png"), fullPage: false });
		result.cases.push({
			kind: "success-reload-restore-export",
			intentSha256: createHash("sha256").update(intentRows[0].raw).digest("hex"),
		});
		await context.close();
	}

	// Case 2: Storage faults (quota before commit, throw after setItem) refuse synchronous startChat without dispatching new_chat or prompt.
	for (const fault of ["quota", "after-set"]) {
		const { context, page, wire } = await setup();
		await page.locator(".inputbox textarea").fill("keep existing composer draft  ");
		await page.evaluate((f) => {
			window.fixtureFault = f;
		}, fault);
		const admitted = await page.evaluate(() =>
			window.__piWebUiHost.startChat({
				prompt: "  faulted startChat prompt  ",
				newChat: true,
			}),
		);
		check(
			`${fault}: synchronous startChat refuses on storage fault`,
			admitted === false && (await page.evaluate(() => window.fixtureFaultCount)) > 0,
		);
		check(
			`${fault}: zero new_chat or prompt wire effects after checkpoint failure`,
			wire.newChats === 0 && wire.prompts === 0,
		);
		check(
			`${fault}: existing composer draft remains untouched`,
			(await page.locator(".inputbox textarea").inputValue()) === "keep existing composer draft  ",
		);
		const savedIntents = await records(page, `${prefix}["intent",`);
		const savedBegins = await records(page, `${prefix}["begin",`);
		check(
			`${fault}: correct localStorage state and zero begin markers`,
			(fault === "quota" ? savedIntents.length === 0 : savedIntents.length === 1) && savedBegins.length === 0,
		);
		await page.locator('[data-testid="plugin-start-recovery-panel"]').waitFor();
		check(`${fault}: failure surfaced in PluginStartRecoveryPanel with no page errors`, wire.errors.length === 0);
		result.cases.push({ kind: fault });
		await context.close();
	}

	// Case 3: Post-checkpoint async continuation failure (IDB prompt admission aborts after synchronous checkpoint+begin) keeps synchronous true, sends zero prompts, retains intent+begin in localStorage, surfaces continuation-failed in PluginStartRecoveryPanel, and allows explicit composer restore.
	{
		const { context, page, wire } = await setup();
		await page.locator(".inputbox textarea").fill("");
		await page.evaluate(() => {
			window.fixtureIdbAbort = true;
		});
		const admitted = await page.evaluate(() =>
			window.__piWebUiHost.startChat({
				prompt: "  continuation interrupted prompt 雪\nsecond line  ",
				newChat: true,
			}),
		);
		check("post-checkpoint continuation failure returns synchronous true", admitted === true);
		const panel = page.locator('[data-testid="plugin-start-recovery-panel"]');
		await panel.waitFor();
		await panel.locator("summary").click();
		await panel.locator('[data-testid="plugin-start-runtime-issue"]').waitFor();
		check("post-checkpoint continuation failure sent zero prompts", wire.prompts === 0);
		const savedIntents = await records(page, `${prefix}["intent",`);
		const savedBegins = await records(page, `${prefix}["begin",`);
		check(
			"post-checkpoint continuation failure retained both intent and begin records",
			savedIntents.length === 1 && savedBegins.length === 1,
		);
		await panel.locator('[data-testid="plugin-start-restore"]').click();
		await page.locator('[data-testid="plugin-start-recovery-status"]').waitFor();
		await page.waitForFunction(
			() =>
				document.querySelector(".inputbox textarea")?.value === "  continuation interrupted prompt 雪\nsecond line  ",
			null,
			{ timeout: 5_000 },
		);
		const restoredVal = await page.locator(".inputbox textarea").inputValue();
		check(
			"post-checkpoint continuation failure allows explicit restore of exact untrimmed prompt into composer",
			restoredVal === "  continuation interrupted prompt 雪\nsecond line  " && wire.prompts === 0,
		);
		check("post-checkpoint continuation failure has no page errors", wire.errors.length === 0);
		result.cases.push({ kind: "post-checkpoint-continuation-failure" });
		await context.close();
	}
	writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
	console.log(`PASS ${result.assertions.length} actual plugin startChat host assertions: ${out}`);
} catch (error) {
	writeFileSync(join(out, "result.json"), JSON.stringify({ ...result, error: String(error) }, null, 2));
	throw error;
} finally {
	await browser?.close();
	await server.stop();
}
