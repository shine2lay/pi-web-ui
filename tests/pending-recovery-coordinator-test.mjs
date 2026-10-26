/* Ops #579: isolated native IDB/Web Locks + standalone rollback reader. No app/profile/model.
 * scripts/sealed.sh node tests/pending-recovery-coordinator-test.mjs
 * Synthetic ephemeral origin only. Missing Chromium is a blocker, not a successful skip. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

assert.ok(CHROME_PATH, "BLOCKED: configure isolated test Chromium (PI_WEB_CHROME); never use a live profile");
const root = fileURLToPath(new URL("..", import.meta.url));
const bundle = await build({
	absWorkingDir: root,
	entryPoints: ["web/src/pending-recovery-coordinator.ts"],
	bundle: true,
	format: "esm",
	platform: "browser",
	write: false,
});
const source = bundle.outputFiles[0].text;
let reader = "";
let appAvailable = true;
const fixtureBytes = Buffer.from([0, 255, 1, 2, 3]);
const server = createServer((req, res) => {
	if (req.url === "/coordinator.js") {
		res.writeHead(appAvailable ? 200 : 410, { "content-type": "text/javascript" });
		res.end(appAvailable ? source : "removed app bundle");
	} else if (req.url === "/reader.html") {
		res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
		res.end(reader);
	} else if (req.url === "/fixture.bin") {
		res.writeHead(200, { "content-type": "application/octet-stream" });
		res.end(fixtureBytes);
	} else {
		res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
		res.end(
			'<!doctype html><title>Synthetic coordinator fixture</title><script type="module">import * as recovery from "/coordinator.js"; window.recovery = recovery;</script>',
		);
	}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string" && address.port >= 8900);
const origin = `http://127.0.0.1:${address.port}`;
const errors = [];
const bytes = Buffer.from(Array.from({ length: 1_200_003 }, (_, i) => i % 256)).toString("base64");
const prompt = (id = "p-original") => ({
	kind: "prompt",
	pending: {
		id,
		conversationId: "c-original",
		sessionId: "session-一",
		text: "完整\r\n é 🌈",
		queue: true,
		createdAt: 42,
		status: "sending",
		sameTextBefore: ["before"],
		queueBase: 2,
		attachments: [
			{ path: "blob:old-inline", imageData: bytes, name: "图.png", size: 1_200_003, mimeType: "image/png" },
			{ path: "", fileData: "AP8BAgM=", name: "零\n.bin", mimeType: "application/octet-stream", size: 5 },
		],
	},
});
const command = (id = "opaque-original") => ({
	kind: "command",
	id,
	conversationId: "c-original",
	sessionId: "session-一",
	createdAt: 43,
	payload: '{ "type":"prompt", "text":"/opaque \\u4e00", "arbitrary":[0,false] }\r\n',
});
let browser;
async function pageFor(context, owner) {
	const page = await context.newPage();
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto(origin);
	await page.waitForFunction(() => !!window.recovery);
	const state = await page.evaluate(async (owner) => {
		window.api = window.recovery.createPendingRecoveryCoordinator({ newOwnerId: () => owner });
		return window.api.start();
	}, owner);
	assert.equal(state.state, "ready", `fresh owner ${owner} starts ready`);
	return page;
}
const prepare = (page, work) => page.evaluate((work) => window.api.prepare(work), work);
const list = (page) => page.evaluate(() => window.api.snapshot().entries.map((e) => e.prepared.work));
const reload = async (page) => {
	await page.reload();
	await page.waitForFunction(() => !!window.recovery);
	return page.evaluate(async () => {
		window.api = window.recovery.createPendingRecoveryCoordinator();
		return window.api.start();
	});
};
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
	const context = await browser.newContext();
	const main = await pageFor(context, "reload-owner");
	reader = await main.evaluate((source) => window.recovery.createPendingRecoveryReaderHtml(source), source);
	const original = prompt();
	assert.equal((await prepare(main, original)).dispatch, "first-send");
	assert.equal((await prepare(main, command())).ok, true);
	const restored = await reload(main);
	assert.equal(restored.ownerId, "reload-owner");
	assert.equal(restored.state, "ready");
	assert.deepEqual(
		await list(main),
		[original, command()],
		"exact large attachment bytes, Unicode metadata, IDs, session and opaque payload across actual reload",
	);
	assert.equal(
		(await prepare(main, original)).dispatch,
		"status-required",
		"reloaded work never grants automatic replay",
	);
	console.log("PASS native reload-stable ownership, large exact bytes, opaque payload, status-required retry");

	// A real opener clones sessionStorage. Set target=_blank/open with no noopener only in this isolated fixture.
	const popupPromise = main.waitForEvent("popup");
	await main.evaluate((url) => window.open(url), origin);
	const cloned = await popupPromise;
	cloned.on("pageerror", (e) => errors.push(e.message));
	await cloned.waitForFunction(() => !!window.recovery);
	const cloneState = await cloned.evaluate(async () => {
		window.api = window.recovery.createPendingRecoveryCoordinator();
		return {
			token: sessionStorage.getItem(window.recovery.PENDING_OWNER_KEY),
			start: await window.api.start(),
			prepare: await window.api.prepare({
				kind: "command",
				id: "clone",
				sessionId: "s",
				conversationId: "c",
				createdAt: 1,
				payload: "original",
			}),
		};
	});
	assert.equal(cloneState.token, "reload-owner");
	assert.equal(cloneState.start.state, "conflict");
	assert.equal(cloneState.prepare.ok, false);
	assert.deepEqual(await list(main), [original, command()], "clone cannot consume or replace original set");
	await cloned.close();
	console.log("PASS native cloned sessionStorage + active Web Lock collision refuses mutation");

	const orphanOwner = "orphan-original-closed";
	const originalTab = await pageFor(context, orphanOwner);
	const orphanCommand = command("orphan-command");
	await prepare(originalTab, orphanCommand);
	await originalTab.close(); // No coordinator.close; document destruction must release its lifetime Web Lock.
	const finder = await context.newPage();
	finder.on("pageerror", (e) => errors.push(e.message));
	await finder.goto(origin);
	await finder.waitForFunction(() => !!window.recovery);
	const recovered = await finder.evaluate(async (ownerId) => {
		const catalog = await window.recovery.catalogPendingRecovery();
		window.api = window.recovery.createPendingRecoveryCoordinator();
		return { catalog, snapshot: await window.api.start({ recoverOwnerId: ownerId }) };
	}, orphanOwner);
	assert.ok(recovered.catalog.owners.some((o) => o.ownerId === orphanOwner && o.active === false));
	assert.equal(recovered.snapshot.state, "ready");
	assert.deepEqual(await list(finder), [orphanCommand]);
	console.log("PASS native closed-original orphan discovery and explicit recovery without timeout/token copying");

	const ordering = await pageFor(context, "await-ordering");
	const fixed = prompt("await-original");
	const captured = await ordering.evaluate(async (work) => {
		const api = window.recovery.createPendingRecoveryCoordinator; // Work below uses a verifier await before native commit.
		await window.api.close();
		let entered;
		const began = new Promise((r) => {
			entered = r;
		});
		let release;
		const wait = new Promise((r) => {
			release = r;
		});
		window.api = api({
			verifyReference: async (a, p) => {
				entered();
				await wait;
				const response = await fetch(a.uploadPath);
				const data = [...new Uint8Array(await response.arrayBuffer())];
				return response.ok && p.sessionId === "session-一" && a.size === 5 && JSON.stringify(data) === "[0,255,1,2,3]";
			},
		});
		await window.api.start();
		work.pending.attachments.push({ path: "", uploadPath: "/fixture.bin", name: "durable.bin", size: 5 });
		const expected = structuredClone(work);
		let send = 0,
			clear = 0;
		const saving = window.api.prepare(work).then((r) => {
			if (r.ok && r.dispatch === "first-send") {
				send++;
				clear++;
			}
			return r;
		});
		await began;
		work.pending.sessionId = "new-active-session";
		work.pending.text = "new composer";
		work.pending.attachments[0].imageData = "changed";
		const before = { send, clear };
		release();
		const result = await saving;
		return { before, result, send, clear, expected };
	}, fixed);
	assert.deepEqual(captured.before, { send: 0, clear: 0 });
	assert.equal(captured.send, 1);
	assert.equal(captured.clear, 1);
	assert.deepEqual(captured.result.prepared.work, captured.expected);
	assert.equal(captured.result.prepared.sessionId, "session-一");
	console.log(
		"PASS native commit-before-dispatch harness, immutable original session/body and actual external reference resolution",
	);

	for (const mode of ["abort-after-put", "payload-quota", "envelope-quota", "envelope-security"]) {
		const page = await pageFor(context, mode);
		await prepare(page, command("previous"));
		const work = prompt(`new-${mode}`);
		const result = await page.evaluate(
			async ({ mode, work }) => {
				const originalPut = IDBObjectStore.prototype.put;
				const originalSet = Storage.prototype.setItem;
				let successful = 0,
					send = 0,
					clear = 0;
				IDBObjectStore.prototype.put = function (...args) {
					if (mode === "payload-quota") throw new DOMException("Synthetic quota", "QuotaExceededError");
					const request = originalPut.apply(this, args);
					if (mode === "abort-after-put")
						request.addEventListener(
							"success",
							() => {
								successful++;
								this.transaction.abort();
							},
							{ once: true },
						);
					return request;
				};
				Storage.prototype.setItem = function (key, value) {
					if (key.startsWith(window.recovery.PENDING_OWNER_ENVELOPE_PREFIX) && mode.startsWith("envelope-"))
						throw new DOMException(
							"Synthetic envelope rejection",
							mode === "envelope-security" ? "SecurityError" : "QuotaExceededError",
						);
					return originalSet.call(this, key, value);
				};
				try {
					const result = await window.api.prepare(work);
					if (result.ok) {
						send++;
						clear++;
					}
					return { result, successful, send, clear };
				} finally {
					IDBObjectStore.prototype.put = originalPut;
					Storage.prototype.setItem = originalSet;
				}
			},
			{ mode, work },
		);
		assert.equal(result.result.ok, false);
		assert.equal(result.send, 0);
		assert.equal(result.clear, 0);
		assert.equal(result.result.payloadCommitted, mode.startsWith("envelope-"));
		assert.deepEqual(result.result.work, work);
		if (mode === "abort-after-put")
			assert.ok(result.successful > 0, "must abort after native put succeeds, not merely before starting");
		if (mode.startsWith("envelope-"))
			await page.addInitScript(() => {
				window.restoreWrites = 0;
				const transaction = IDBDatabase.prototype.transaction;
				IDBDatabase.prototype.transaction = function (...args) {
					if (args[1] === "readwrite") window.restoreWrites++;
					return transaction.apply(this, args);
				};
				const set = Storage.prototype.setItem;
				Storage.prototype.setItem = function (key, value) {
					if (key.startsWith("pi-web-pending-owner-envelope-v1:") || key === "pi-web-pending-owner-v1")
						throw new DOMException("Ongoing synthetic write-only storage denial", "QuotaExceededError");
					return set.call(this, key, value);
				};
			});
		assert.equal((await reload(page)).state, "ready");
		if (mode.startsWith("envelope-")) {
			assert.equal(await page.evaluate(() => window.restoreWrites), 0);
			assert.equal(
				await page.evaluate(
					async () => (await window.recovery.readPendingRecoveryArtifact(await window.api.exportArtifact())).complete,
				),
				true,
			);
		}
		assert.deepEqual(
			await list(page),
			// #578 restores in original createdAt order (prompt 42 precedes command 43), not envelope insertion order.
			mode.startsWith("envelope-") ? [work, command("previous")] : [command("previous")],
		);
		console.log(`PASS native ${mode}: honest commit status, no harness send/clear, exact retained work after reload`);
		await page.close();
	}

	const interrupted = await pageFor(context, "boundary-interruption");
	await interrupted.evaluate(() => {
		const original = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function (...args) {
			const request = original.apply(this, args);
			request.addEventListener(
				"success",
				() => {
					this.transaction.abort();
				},
				{ once: true },
			);
			return request;
		};
		// Never awaits/clears; actual reload immediately below destroys this document at an uncertain boundary.
		void window.api.prepare({
			kind: "command",
			id: "interrupted",
			conversationId: "c",
			sessionId: "s",
			createdAt: 1,
			payload: "unchanged opaque",
		});
	});
	assert.equal((await reload(interrupted)).state, "ready");
	assert.deepEqual(await list(interrupted), [], "precommit destruction/abort never invents a recovered send");
	console.log("PASS document interruption before completed payload commit never authorizes or invents a send");

	const broken = await pageFor(context, "corrupt-source");
	const beforeBroken = command("retain-corruption");
	await prepare(broken, beforeBroken);
	await broken.evaluate(() =>
		localStorage.setItem(`${window.recovery.PENDING_OWNER_ENVELOPE_PREFIX}corrupt-source`, '{"unrecognized":true}'),
	);
	const brokenRaw = await broken.evaluate(() =>
		localStorage.getItem(`${window.recovery.PENDING_OWNER_ENVELOPE_PREFIX}corrupt-source`),
	);
	assert.equal((await reload(broken)).state, "incomplete");
	assert.equal((await prepare(broken, command("new"))).ok, false);
	assert.equal(
		await broken.evaluate(() => localStorage.getItem(`${window.recovery.PENDING_OWNER_ENVELOPE_PREFIX}corrupt-source`)),
		brokenRaw,
	);
	const corruptArtifact = await broken.evaluate(() => window.api.exportArtifact());
	assert.equal(
		await broken.evaluate(
			async (text) => (await window.recovery.readPendingRecoveryArtifact(text)).complete,
			corruptArtifact,
		),
		false,
	);
	console.log("PASS native incomplete source refuses writes and remains exportable without overwrite");

	const ambiguous = await pageFor(context, "ambiguous-sources");
	await prepare(ambiguous, command("native-source"));
	const legacySource = JSON.stringify([prompt("legacy-unseen").pending]);
	await ambiguous.evaluate((raw) => sessionStorage.setItem("pi-web-pending-sends", raw), legacySource);
	assert.equal((await reload(ambiguous)).state, "conflict");
	assert.equal((await prepare(ambiguous, command("not-authorized"))).ok, false);
	const rawConflict = await ambiguous.evaluate(async () => JSON.parse(await window.api.exportArtifact()));
	assert.equal(rawConflict.legacyEnvelope, legacySource);
	assert.ok(rawConflict.envelope);
	assert.equal(rawConflict.records.length, 1);
	assert.equal(
		await ambiguous.evaluate(
			async (raw) => (await window.recovery.readPendingRecoveryArtifact(JSON.stringify(raw))).complete,
			rawConflict,
		),
		false,
	);
	console.log("PASS native ambiguous setup refuses all mutation yet exports both full raw sources for repair");

	const lifecycle = await pageFor(context, "lifecycle");
	const item = (await prepare(lifecycle, command())).prepared;
	const authority = await lifecycle.evaluate(async (item) => {
		const observed = [];
		for (const kind of ["volatile", "unknown", "negative", "text-match"])
			observed.push(await window.api.observe({ kind }));
		observed.push(await window.api.observe({ kind: "persisted", identity: item, proof: { ok: true } }));
		const returned = await window.api.returnToComposer(item);
		return { observed, returned, size: window.api.snapshot().entries.length };
	}, item);
	assert.ok(authority.observed.every((r) => r.released === false));
	assert.deepEqual(authority.returned, command());
	assert.equal(authority.size, 1);
	const badDiscard = await lifecycle.evaluate(
		(item) => window.api.discard({ intent: "discard", identity: { ...item, sessionId: "other" } }),
		item,
	);
	assert.equal(badDiscard.released, false);
	assert.equal(
		(await lifecycle.evaluate((identity) => window.api.discard({ intent: "discard", identity }), item)).released,
		true,
	);
	assert.deepEqual((await reload(lifecycle)).entries, []);
	console.log(
		"PASS native volatile/unknown/text and × retention; explicit matching discard, reload and no resurrection",
	);

	const persisted = await pageFor(context, "persisted-proof");
	await persisted.evaluate(async () => {
		await window.api.close();
		window.api = window.recovery.createPendingRecoveryCoordinator({
			verifyPersisted: async (proof, item) => proof?.fixtureReceipt === `durable:${item.sessionId}:${item.id}`,
		});
		await window.api.start();
	});
	const pitem = (await prepare(persisted, command("persisted"))).prepared;
	assert.equal(
		(
			await persisted.evaluate(
				(item) =>
					window.api.observe({
						kind: "persisted",
						identity: { ...item, contentDigest: "0".repeat(64) },
						proof: { fixtureReceipt: `durable:${item.sessionId}:${item.id}` },
					}),
				pitem,
			)
		).released,
		false,
	);
	assert.equal(
		(
			await persisted.evaluate(
				(identity) =>
					window.api.observe({
						kind: "persisted",
						identity,
						proof: { fixtureReceipt: `durable:${identity.sessionId}:${identity.id}` },
					}),
				pitem,
			)
		).released,
		true,
	);
	assert.deepEqual((await reload(persisted)).entries, []);
	console.log("PASS native exact matching persistence-verifier seam (synthetic receipt, not real server proof)");

	const artifact = await main.evaluate(() => window.api.exportArtifact());
	await main.close();
	appAvailable = false; // Rollback removes the current app bundle; self-contained reader must still work.
	const rollback = await context.newPage();
	rollback.on("pageerror", (e) => errors.push(e.message));
	let appRequests = 0;
	rollback.on("request", (r) => {
		if (r.url().endsWith("/coordinator.js")) appRequests++;
	});
	await rollback.goto(`${origin}/reader.html`);
	await rollback.getByRole("button", { name: "Find retained owners" }).click();
	await rollback.waitForFunction(() => document.getElementById("output").textContent.includes('"complete": true'));
	await rollback.getByRole("button", { name: "reload-owner — explicitly recover", exact: true }).click();
	await rollback.waitForFunction(() => document.getElementById("output").textContent.includes('"state": "ready"'));
	const readerSnapshot = await rollback.locator("#output").textContent();
	assert.deepEqual(
		JSON.parse(readerSnapshot).entries.map((e) => e.prepared.work),
		[original, command()],
	);
	const downloadPromise = rollback.waitForEvent("download");
	await rollback.getByRole("button", { name: "Export selected owner" }).click();
	const download = await downloadPromise;
	const stream = await download.createReadStream();
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	const readerArtifact = Buffer.concat(chunks).toString();
	assert.equal(JSON.parse(readerArtifact).ownerId, "reload-owner");
	assert.deepEqual(JSON.parse(readerArtifact).records, JSON.parse(artifact).records);
	assert.equal(appRequests, 0, "reader does not request the unavailable app bundle");
	await rollback.close();
	console.log(
		"PASS independent same-origin rollback HTML reads/discovers and exports exact IDB with app bundle unavailable",
	);

	// Import the exported artifact using only the reader in a genuinely empty isolated origin context.
	const cleanContext = await browser.newContext();
	const importer = await cleanContext.newPage();
	importer.on("pageerror", (e) => errors.push(e.message));
	await importer.goto(`${origin}/reader.html`);
	await importer
		.locator("#artifact")
		.setInputFiles({ name: "recovery.json", mimeType: "application/json", buffer: Buffer.from(readerArtifact) });
	await importer.getByRole("button", { name: "Read artifact", exact: true }).click();
	await importer.waitForFunction(() => document.getElementById("output").textContent.includes('"complete": true'));
	assert.deepEqual(JSON.parse(await importer.locator("#output").textContent()).work, [original, command()]);
	await importer.getByRole("button", { name: "Restore inspected artifact" }).click();
	await importer.waitForFunction(() => JSON.parse(document.getElementById("output").textContent).entries?.length === 2);
	assert.deepEqual(
		JSON.parse(await importer.locator("#output").textContent()).entries.map((e) => e.prepared.work),
		[original, command()],
	);
	const altered = JSON.parse(readerArtifact);
	altered.records[0].payload += " ";
	await importer.locator("#artifact").setInputFiles({
		name: "corrupt.json",
		mimeType: "application/json",
		buffer: Buffer.from(JSON.stringify(altered)),
	});
	await importer.getByRole("button", { name: "Read artifact", exact: true }).click();
	await importer.waitForFunction(() => document.getElementById("output").textContent.includes("checksum mismatch"));
	await importer.getByRole("button", { name: "Restore inspected artifact" }).click();
	await importer.waitForFunction(() => document.getElementById("output").textContent.includes("checksum mismatch"));
	await importer.getByRole("button", { name: "Find retained owners" }).click();
	await importer.waitForFunction(() => document.getElementById("output").textContent.includes('"owners"'));
	assert.equal(JSON.parse(await importer.locator("#output").textContent()).complete, true);
	await cleanContext.close();
	console.log(
		"PASS standalone artifact exact inspect/restore into empty native IDB with no app; corrupted artifact refuses mutation",
	);
	assert.deepEqual(errors, [], "no uncaught browser errors");
	console.log(
		"PASS coordinator native-browser module proof; not #570 UI/host losslessness, backup or deployment proof",
	);
} finally {
	await browser?.close();
	await new Promise((resolve) => server.close(resolve));
}
