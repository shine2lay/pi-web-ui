/* Ops #584: isolated native Web Locks/localStorage + independently retained reader.
 * scripts/sealed.sh node tests/plugin-start-checkpoint-test.mjs
 * No app server, real profile, real chat, model, deployment or storage migration. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

assert.ok(CHROME_PATH, "BLOCKED: isolated Chromium required (PI_WEB_CHROME); never use a live profile");
const root = fileURLToPath(new URL("..", import.meta.url));
const bundled = await Promise.all(
	["plugin-start-checkpoint", "plugin-host"].map((name) =>
		build({
			absWorkingDir: root,
			entryPoints: [`web/src/${name}.ts`],
			bundle: true,
			format: "esm",
			platform: "browser",
			write: false,
		}),
	),
);
const source = bundled[0].outputFiles[0].text;
const legacySource = bundled[1].outputFiles[0].text;
const independent = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
let reader = "";
let appAvailable = true;
const server = createServer((req, res) => {
	if (req.url === "/checkpoint.js" || req.url === "/legacy-host.js") {
		res.writeHead(appAvailable ? 200 : 410, { "content-type": "text/javascript" });
		res.end(
			appAvailable ? (req.url === "/checkpoint.js" ? source : legacySource) : "app bundle removed for rollback proof",
		);
	} else if (req.url === "/retained-reader.html") {
		res.writeHead(200, {
			"content-type": "text/html",
			"cache-control": "no-store",
			"content-security-policy":
				"default-src 'none'; script-src 'unsafe-inline' blob:; object-src 'none'; base-uri 'none'",
		});
		res.end(reader);
	} else {
		res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
		res.end(
			'<!doctype html><title>Isolated plugin checkpoint fixture</title><script type="module">import * as checkpoint from "/checkpoint.js"; import * as legacy from "/legacy-host.js"; window.checkpoint=checkpoint; window.legacy=legacy;</script>',
		);
	}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string" && address.port >= 8900);
const origin = `http://127.0.0.1:${address.port}`;
const original = {
	prompt: " \t完整\r\n é 🌈\u0000\ud800 <img src=x onerror='window.readerInjected=true'> \n",
	newChat: false,
	cwd: " /原始/dir\n ",
	model: " provider/model \t",
};
const errors = [];
let browser;
async function pageFor(context, owner) {
	const page = await context.newPage();
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto(origin);
	await page.waitForFunction(() => !!window.checkpoint && !!window.legacy);
	await page.evaluate((owner) => {
		sessionStorage.setItem("synthetic-plugin-source-owner", owner);
	}, owner);
	const opened = await open(page);
	assert.equal(opened.ok, true);
	return page;
}
async function open(page) {
	return page.evaluate(async () => {
		window.binding = {
			ownerId: sessionStorage.getItem("synthetic-plugin-source-owner"),
			sessionId: "stable-session",
			conversationId: "source-conversation",
			pluginId: "synthetic-plugin",
		};
		const opened = await window.checkpoint.openPluginStartCheckpoint({
			ownerId: window.binding.ownerId,
			getSource: () => window.binding,
		});
		window.owner = opened.ok ? opened.owner : null;
		return { ok: opened.ok, code: opened.code, generation: opened.ok ? opened.owner.generation : null };
	});
}
const capture = (page, options, intentId, promptId) =>
	page.evaluate(({ options, intentId, promptId }) => window.owner.checkpoint(options, { intentId, promptId }), {
		options,
		intentId,
		promptId,
	});
const catalogue = (page) => page.evaluate(() => window.checkpoint.catalogPluginStarts());
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
	const context = await browser.newContext({ acceptDownloads: true });
	const main = await pageFor(context, "native-original-owner");
	assert.deepEqual(
		await main.evaluate(() => ({
			secure: isSecureContext,
			locks: typeof navigator.locks.request,
			storage: localStorage.constructor.name,
		})),
		{ secure: true, locks: "function", storage: "Storage" },
	);
	reader = await main.evaluate((source) => window.checkpoint.createPluginStartReaderHtml(source), source);
	console.log("PASS native secure-origin Web Locks/localStorage with separate initialized lifetime ownership");

	const behavioral = await main.evaluate(async (original) => {
		const oldEffects = [];
		const oldHost = window.legacy.createPluginHostApi({
			send: (msg) => {
				oldEffects.push(msg.type);
				return true;
			},
			isReady: () => true,
			setView: () => {},
			getCwd: () => "",
			getWorkspaceRoots: () => [],
			listSessions: () => [],
			getConversationId: () => "c",
			isConversationBlank: () => true,
		});
		const oldBoolean = oldHost.startChat({ prompt: original.prompt, newChat: false });
		const legacySaved = window.checkpoint.catalogPluginStarts().entries.length;
		const effects = [];
		window.adapter = window.checkpoint.createPluginStartAdapter(window.owner, {
			validate: () => true,
			continueIntent: (intent, permit) => {
				effects.push({
					valid: permit.valid(),
					intent,
					stored: window.checkpoint.catalogPluginStarts().entries.some((e) => e.kind === "begin"),
				});
				return new Promise((_resolve, reject) => {
					window.rejectContinuation = reject;
				});
			},
		});
		const input = { ...original };
		const guardedBoolean = window.adapter.startChat(input);
		const immediate = {
			effects: effects.length,
			catalogue: window.checkpoint.catalogPluginStarts(),
			type: typeof guardedBoolean,
		};
		input.prompt = "MUTATED";
		input.cwd = "MUTATED";
		input.model = "MUTATED";
		input.newChat = true;
		for (let i = 0; i < 8; i++) await Promise.resolve();
		return {
			oldBoolean,
			oldEffects,
			legacySaved,
			guardedBoolean,
			immediate,
			effects,
			accepted: window.adapter.lastResult(),
		};
	}, original);
	assert.equal(behavioral.oldBoolean, true);
	assert.deepEqual(behavioral.oldEffects, ["prompt"]);
	assert.equal(
		behavioral.legacySaved,
		0,
		"genuine behavioral red: actual old host accepted/effected without saving original",
	);
	assert.equal(behavioral.guardedBoolean, true);
	assert.equal(behavioral.immediate.type, "boolean");
	assert.equal(behavioral.immediate.effects, 0);
	assert.equal(
		behavioral.immediate.catalogue.entries.length,
		1,
		"full native checkpoint is readable in the accepting tick",
	);
	assert.equal(behavioral.effects.length, 1);
	assert.equal(behavioral.effects[0].valid, true);
	assert.equal(behavioral.effects[0].stored, true);
	assert.deepEqual(independent.pluginStartOriginalOptions(behavioral.accepted.intent), original);
	assert.deepEqual(behavioral.effects[0].intent, behavioral.accepted.intent);
	assert.equal(behavioral.accepted.intent.source.sessionId, "stable-session");
	console.log(
		"PASS actual old-host true-before-save behavioral red versus guarded actual boolean + full write/readback before any effect",
	);
	console.log(
		"PASS exact Unicode/CRLF/whitespace/options/source/prompt IDs and immutable capture across input mutation",
	);

	const rejected = await main.evaluate(async () => {
		window.rejectContinuation(new Error("synthetic delayed async admission rejection"));
		for (let i = 0; i < 8; i++) await Promise.resolve();
		return { issues: window.adapter.issues(), catalogue: window.checkpoint.catalogPluginStarts() };
	});
	assert.equal(rejected.issues[0].code, "continuation-failed");
	assert.equal(rejected.catalogue.entries.find((e) => e.kind === "intent").state, "recovery-required");
	assert.equal(rejected.catalogue.entries.find((e) => e.kind === "intent").possibleEffects, true);
	console.log(
		"PASS delayed asynchronous rejection retains full original and explicit possible-effect uncertainty, no replay or retirement",
	);

	const presence = await main.evaluate(() => {
		const variants = [
			{ prompt: "explicit undefined", newChat: undefined, cwd: undefined, model: undefined },
			{ prompt: "absent" },
			{ prompt: "empty false", newChat: false, cwd: "", model: "" },
			{ prompt: "true whitespace", newChat: true, cwd: " \t", model: " \r\n" },
		];
		return variants.map((input, i) => {
			const r = window.owner.checkpoint(input, { intentId: `presence-${i}`, promptId: `presence-p-${i}` });
			return {
				ok: r.ok,
				restored: r.ok ? window.checkpoint.pluginStartOriginalOptions(r.intent) : null,
				expected: input,
			};
		});
	});
	for (const item of presence) {
		assert.equal(item.ok, true);
		assert.deepEqual(item.restored, item.expected);
	}
	console.log("PASS native absent/explicit undefined/false/true/empty/whitespace option semantics");

	const beforeClone = (await catalogue(main)).entries;
	const popupPromise = main.waitForEvent("popup");
	await main.evaluate((origin) => window.open(origin), origin);
	const clone = await popupPromise;
	clone.on("pageerror", (e) => errors.push(e.message));
	await clone.waitForFunction(() => !!window.checkpoint);
	assert.equal(
		await clone.evaluate(() => sessionStorage.getItem("synthetic-plugin-source-owner")),
		"native-original-owner",
	);
	assert.deepEqual(await open(clone), { ok: false, code: "owner-conflict", generation: null });
	assert.deepEqual((await catalogue(main)).entries, beforeClone);
	await clone.close();
	console.log("PASS actual opener clone/session owner collision refuses mutation without changing any original");

	const bigText = " \r\n" + "一🌈".repeat(180_001) + "\n ";
	const large = await capture(main, { ...original, prompt: bigText }, "large-original", "large-prompt");
	assert.equal(large.ok, true);
	assert.equal(large.intent.original.prompt, bigText);
	const quota = await main.evaluate(() => {
		const before = window.checkpoint.exportPluginStarts();
		const result = window.owner.checkpoint(
			{ prompt: "Q".repeat(8_000_000), newChat: false },
			{ intentId: "real-quota", promptId: "real-quota-prompt" },
		);
		return { result, identical: before === window.checkpoint.exportPluginStarts() };
	});
	assert.equal(quota.result.ok, false);
	assert.equal(quota.result.code, "storage-failed");
	assert.equal(quota.result.sourceRetained, true);
	assert.equal(quota.identical, true);
	console.log(
		"PASS native large exact original and genuine browser quota refusal, no eviction/overwrite/clear permission",
	);

	const originalGeneration = behavioral.accepted.intent.source.generation;
	await main.reload();
	await main.waitForFunction(() => !!window.checkpoint);
	const reopened = await open(main);
	assert.equal(reopened.ok, true);
	assert.notEqual(reopened.generation, originalGeneration);
	const reloaded = await main.evaluate(
		(identity) => ({ catalogue: window.checkpoint.catalogPluginStarts(), begin: window.owner.begin(identity) }),
		behavioral.accepted.identity,
	);
	assert.equal(reloaded.begin.ok, false);
	assert.equal(reloaded.begin.code, "recovery-required");
	assert.equal(
		reloaded.catalogue.entries.find((e) => e.intent?.intentId === "large-original").intent.original.prompt,
		bigText,
	);
	assert.deepEqual(
		independent.pluginStartOriginalOptions(
			reloaded.catalogue.entries.find((e) => e.intent?.intentId === behavioral.accepted.intent.intentId).intent,
		),
		original,
	);
	console.log(
		"PASS actual reload keeps exact full intent/IDs, releases lifetime lock, changes generation and refuses recovered begin",
	);

	const unhanded = await pageFor(context, "closed-unhanded-owner");
	const unhandedResult = await capture(unhanded, original, "unhanded-full-intent", "unhanded-stable-prompt");
	assert.equal(unhandedResult.ok, true);
	await unhanded.close(); // Actual document destruction, no api.close() and no memory transfer.
	const finder = await pageFor(context, "closed-unhanded-owner");
	const found = (await catalogue(finder)).entries.find((e) => e.intent?.intentId === "unhanded-full-intent");
	assert.deepEqual(found.intent, unhandedResult.intent);
	assert.equal(found.state, "recovery-required");
	assert.equal(found.possibleEffects, false);
	assert.equal((await finder.evaluate((identity) => window.owner.begin(identity), unhandedResult.identity)).ok, false);
	console.log(
		"PASS actual source tab closure/reopen: still-unhanded original discovered independently, no resume permission",
	);

	const drift = await capture(finder, { prompt: "original drift source", newChat: false }, "drift", "drift-prompt");
	const drifted = await finder.evaluate((identity) => {
		window.binding.sessionId = "new-session";
		return window.owner.begin(identity);
	}, drift.identity);
	assert.equal(drifted.ok, false);
	assert.equal(drifted.code, "source-mismatch");
	await finder.evaluate(() => {
		window.binding.sessionId = "stable-session";
	});
	const cleanup = await finder.evaluate(async (identity) => {
		const wrong = await window.owner.retire({
			kind: "discard",
			identity: { ...identity, serialized: identity.serialized + " " },
		});
		const noVerifier = await window.owner.retire({
			kind: "persisted",
			identity,
			proof: "socket-ack-is-not-persistence",
		});
		const exactDiscard = await window.owner.retire({ kind: "discard", identity });
		return { wrong, noVerifier, exactDiscard, retained: localStorage.getItem(identity.key) === identity.serialized };
	}, drift.identity);
	assert.equal(cleanup.wrong.ok, false);
	assert.equal(cleanup.noVerifier.ok, false);
	assert.equal(cleanup.exactDiscard.ok, true);
	assert.equal(cleanup.retained, true);
	const stale = await finder.evaluate(() => {
		window.owner.close();
		return window.owner.checkpoint({ prompt: "closed" });
	});
	assert.equal(stale.ok, false);
	assert.equal(stale.code, "closed");
	console.log("PASS native source binding, stale lease and exact authorized retirement; raw original never deleted");

	const corruptKey = independent.PLUGIN_START_PREFIX + JSON.stringify(["intent", "unknown-owner", "future-version"]);
	const corruptRaw = '{ "format":"pi-web-plugin-start", "version":99, "raw":"KEEP original future bytes" }\r\n';
	await main.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: corruptKey, raw: corruptRaw });
	await main.close();
	await finder.close();
	appAvailable = false; // No checkpoint.js, plugin-host.js or app entry available for the independent viewer.
	const viewer = await context.newPage();
	viewer.on("pageerror", (e) => errors.push(e.message));
	const requests = [];
	viewer.on("request", (request) => requests.push(request.url()));
	await viewer.goto(`${origin}/retained-reader.html`);
	await viewer.waitForFunction(() => window.pluginStartReaderReady === true);
	const recovered = await viewer.evaluate(() => ({
		catalogue: window.pluginStartCatalogue,
		attacked: !!window.readerInjected,
	}));
	assert.equal(recovered.attacked, false);
	assert.equal(
		recovered.catalogue.complete,
		false,
		"unknown future format is visible, not silently treated as complete",
	);
	assert.deepEqual(
		recovered.catalogue.entries.find((e) => e.intent?.intentId === "unhanded-full-intent").intent,
		unhandedResult.intent,
	);
	assert.equal(recovered.catalogue.entries.find((e) => e.key === corruptKey).raw, corruptRaw);
	assert.equal(
		recovered.catalogue.entries.find((e) => e.intent?.intentId === "large-original").intent.original.prompt,
		bigText,
	);
	assert.equal(
		requests.some((url) => url.endsWith("/checkpoint.js") || url.endsWith("/legacy-host.js")),
		false,
	);
	console.log(
		"PASS independently loaded same-origin self-contained rollback viewer under inline/Blob CSP after all source tabs closed and app bundles removed",
	);
	console.log(
		"PASS reader preserves unknown/corrupt raw originals, exact large/Unicode work, safe textContent and no replay",
	);

	const downloadPromise = viewer.waitForEvent("download");
	await viewer.locator("#plugin-start-export").click();
	const download = await downloadPromise;
	assert.equal(download.suggestedFilename(), "plugin-start-recovery.json");
	const exported = await viewer.locator("#plugin-start-artifact").textContent();
	const inspected = independent.readPluginStartExport(exported);
	assert.deepEqual(
		inspected.entries.find((e) => e.intent?.intentId === "unhanded-full-intent").intent,
		unhandedResult.intent,
	);
	assert.equal(inspected.entries.find((e) => e.key === corruptKey).raw, corruptRaw);
	assert.equal(inspected.entries.find((e) => e.intent?.intentId === "large-original").intent.original.prompt, bigText);
	const unchanged = await viewer.evaluate(({ key, raw }) => localStorage.getItem(key) === raw, {
		key: unhandedResult.identity.key,
		raw: unhandedResult.identity.serialized,
	});
	assert.equal(unchanged, true);
	assert.equal(await viewer.evaluate(() => typeof window.owner), "undefined");
	assert.deepEqual(errors, []);
	console.log(
		"PASS independent exported artifact reader preserves full unhanded originals/IDs/source and future raw bytes; reader performed no writes/effects",
	);
	await context.close();
} finally {
	await browser?.close();
	await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
