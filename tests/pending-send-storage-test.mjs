/* Ops #578: native IndexedDB exact-content reload and interrupted transaction proof.
 * Isolated static HTTP origin + fresh headless Chromium context; no app, real chat, profile or model.
 * Usage: scripts/sealed.sh node tests/pending-send-storage-test.mjs
 * Missing Chrome is a failure (not a silently successful SKIP). No shared runner modification. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

assert.ok(CHROME_PATH, "BLOCKED: install/configure isolated test Chromium (PI_WEB_CHROME); do not use a live profile");
const root = fileURLToPath(new URL("..", import.meta.url));
const bundled = await build({
	absWorkingDir: root,
	entryPoints: ["web/src/pending-send-storage.ts"],
	bundle: true,
	format: "esm",
	platform: "browser",
	write: false,
});
const moduleSource = bundled.outputFiles[0].text;
const fixtureBytes = Buffer.from([0, 255, 1, 2, 3]);
const server = createServer((req, res) => {
	if (req.url === "/recovery.js") {
		res.writeHead(200, { "content-type": "text/javascript" });
		res.end(moduleSource);
	} else if (req.url === "/fixture.bin") {
		res.writeHead(200, { "content-type": "application/octet-stream" });
		res.end(fixtureBytes);
	} else {
		res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
		res.end(
			'<!doctype html><title>Synthetic pending recovery fixture</title><script type="module">import * as recovery from "/recovery.js"; window.recovery = recovery;</script>',
		);
	}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string" && address.port >= 8900);
const origin = `http://127.0.0.1:${address.port}`;
let browser;
const pageErrors = [];
const exact = (actual, expected, message) => assert.ok(isDeepStrictEqual(actual, expected), message);
const restored = (list) => list.map((p) => (p.status === "sending" ? { ...p, needsCheck: true } : p));
const pending = (overrides = {}) => ({
	id: "original-prompt-🧪",
	conversationId: "c1",
	sessionId: "stable-session-一",
	text: "完整\r\nmessage é 🌈",
	queue: true,
	createdAt: 123456,
	status: "sending",
	sameTextBefore: ["before"],
	queueBase: 2,
	anchorId: "anchor",
	whileWorking: true,
	...overrides,
});
const image = Buffer.from(Array.from({ length: 1_200_003 }, (_, i) => i % 256)).toString("base64");
const file = Buffer.from(Array.from({ length: 1_200_003 }, (_, i) => 255 - (i % 256))).toString("base64");
const large = pending({
	text: "",
	attachments: [
		{ path: "", imageData: image, mimeType: "image/png", name: "图-一.png", size: 1_200_003 },
		{ path: "", fileData: file, mimeType: "application/octet-stream", name: "über-零.bin", size: 1_200_003 },
		{ path: "blob:synthetic-only", imageData: image, mimeType: "image/webp", name: "图-二.webp", size: 1_200_003 },
		{ path: "", fileData: "AP8BAgM=", mimeType: "application/octet-stream", name: "tiny-\n.bin", size: 5 },
	],
});
async function freshPage(context, owner) {
	const page = await context.newPage();
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto(origin);
	await page.waitForFunction(() => !!window.recovery);
	await page.evaluate((ownerId) => {
		window.ownerId = ownerId;
	}, owner);
	return page;
}
async function save(page, list) {
	await page.evaluate((list) => window.recovery.createPendingSendStorage({ ownerId: window.ownerId }).save(list), list);
}
async function restore(page) {
	return page.evaluate(() => window.recovery.createPendingSendStorage({ ownerId: window.ownerId }).restore());
}
async function reload(page, ownerId) {
	await page.reload();
	await page.waitForFunction(() => !!window.recovery);
	await page.evaluate((id) => {
		window.ownerId = id;
	}, ownerId);
}
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
	const context = await browser.newContext();
	const smallPage = await freshPage(context, "small-tab");
	const small = pending({
		id: "small",
		attachments: [{ path: "", imageData: "AP8BAgM=", mimeType: "image/png", name: "small.png", size: 5 }],
	});
	await save(smallPage, [small]);
	assert.ok(await smallPage.evaluate(() => Array.isArray(JSON.parse(sessionStorage.getItem("pi-web-pending-sends")))));
	await reload(smallPage, "small-tab");
	exact(
		await restore(smallPage),
		{ pending: restored([small]), blocked: [], issues: [], complete: true },
		"small legacy-shaped envelope exact reload",
	);
	console.log("PASS native small payload and legacy-shaped envelope across reload");

	const page = await freshPage(context, "large-tab");
	await save(page, [large]);
	const manifest = await page.evaluate(() => sessionStorage.getItem("pi-web-pending-sends"));
	assert.ok(manifest.length < 1500000 && !manifest.includes(image));
	await reload(page, "large-tab");
	exact(
		await restore(page),
		{ pending: restored([large]), blocked: [], issues: [], complete: true },
		"all image/file bytes, Unicode metadata, order and identity survive native reload",
	);
	exact((await restore(smallPage)).pending, restored([small]), "another tab's IDB payload not consumed");
	const retry = { ...large, conversationId: "c-renumbered", status: "failed", reason: "reconnect" };
	await save(page, [retry]);
	await reload(page, "large-tab");
	exact(
		(await restore(page)).pending,
		[retry],
		"same stable ID/body and attachment order survive retry and chat renumbering",
	);
	console.log("PASS native large image/file bytes, identity/order, reload/retry and tab isolation");

	for (const mode of ["abort-after-request-success", "quota"]) {
		const failurePage = await freshPage(context, mode);
		const old = pending({ id: "already-committed", text: "retain this" });
		await save(failurePage, [old]);
		const failure = await failurePage.evaluate(
			async ({ list, mode }) => {
				const original = IDBObjectStore.prototype.put;
				let successfulRequests = 0;
				const before = sessionStorage.getItem("pi-web-pending-sends");
				IDBObjectStore.prototype.put = function (...args) {
					if (mode === "quota") throw new DOMException("Synthetic quota rejection", "QuotaExceededError");
					const request = original.apply(this, args);
					request.addEventListener(
						"success",
						() => {
							successfulRequests++;
							this.transaction.abort();
						},
						{ once: true },
					);
					return request;
				};
				try {
					await window.recovery.createPendingSendStorage({ ownerId: window.ownerId }).save(list);
					return { incorrectlySucceeded: true };
				} catch (error) {
					return {
						rejected: error.name === "PendingSendStorageError",
						payloadCommitted: error.payloadCommitted,
						successfulRequests,
						unchangedEnvelope: before === sessionStorage.getItem("pi-web-pending-sends"),
					};
				} finally {
					IDBObjectStore.prototype.put = original;
				}
			},
			{ list: [old, { ...large, id: "uncommitted-new-send" }], mode },
		);
		assert.equal(failure.rejected, true);
		assert.equal(failure.payloadCommitted, false);
		assert.equal(failure.unchangedEnvelope, true);
		if (mode === "abort-after-request-success")
			assert.ok(failure.successfulRequests > 0, "request succeeds but transaction abort must still fail save");
		await reload(failurePage, mode);
		exact(
			(await restore(failurePage)).pending,
			restored([old]),
			`${mode} rolls back entire native batch; no partial send/references`,
		);
		console.log(`PASS native ${mode}: explicit failure, unchanged envelope, full transaction rollback`);
	}

	const envelopePage = await freshPage(context, "envelope-interrupted");
	const envelopeError = await envelopePage.evaluate(async (p) => {
		const storage = {
			getItem: (key) => sessionStorage.getItem(key),
			setItem: () => {
				throw new DOMException("Synthetic disabled/quota envelope", "QuotaExceededError");
			},
		};
		try {
			await window.recovery.createPendingSendStorage({ ownerId: window.ownerId, storage }).save([p]);
			return false;
		} catch (error) {
			return (
				error.code === "envelope" &&
				error.payloadCommitted === true &&
				sessionStorage.getItem("pi-web-pending-sends") === null
			);
		}
	}, large);
	assert.equal(envelopeError, true);
	await reload(envelopePage, "envelope-interrupted");
	exact(
		(await restore(envelopePage)).pending,
		restored([large]),
		"native orphan commit discoverable after interruption before envelope publication",
	);
	const disabled = await envelopePage.evaluate(async (p) => {
		const original = JSON.stringify(p);
		try {
			await window.recovery.createPendingSendStorage({ ownerId: window.ownerId, indexedDB: null }).save([p]);
			return false;
		} catch (error) {
			return error.code === "unavailable" && !error.payloadCommitted && JSON.stringify(p) === original;
		}
	}, large);
	assert.equal(disabled, true);
	console.log(
		"PASS native committed payload rediscovery after envelope failure, and explicit disabled-storage failure",
	);

	const missingPage = await freshPage(context, "missing-payload");
	await save(missingPage, [large]);
	const missing = await missingPage.evaluate(async () => {
		const before = sessionStorage.getItem("pi-web-pending-sends");
		const key = JSON.parse(before).keys[0];
		await new Promise((resolve, reject) => {
			const request = indexedDB.open(window.recovery.PENDING_RECOVERY_DB, 1);
			request.onsuccess = () => {
				const db = request.result;
				const tx = db.transaction("sends", "readwrite");
				tx.objectStore("sends").delete(key); // Explicit synthetic missing-payload fixture only.
				tx.oncomplete = () => {
					db.close();
					resolve();
				};
				tx.onabort = () => {
					db.close();
					reject(tx.error);
				};
			};
			request.onerror = () => reject(request.error);
		});
		const result = await window.recovery.createPendingSendStorage({ ownerId: window.ownerId }).restore();
		return {
			missing: !result.complete && result.issues[0]?.code === "missing" && result.pending.length === 0,
			unchangedSource: before === sessionStorage.getItem("pi-web-pending-sends"),
		};
	});
	exact(missing, { missing: true, unchangedSource: true }, "unresolved native reference is explicit and retained");
	console.log("PASS missing native payload is explicit; unresolved source manifest retained");

	const referencePage = await freshPage(context, "verified-reference");
	const reference = pending({
		attachments: [
			{ path: "", uploadPath: "/fixture.bin", mimeType: "application/octet-stream", name: "durable-零.bin", size: 5 },
		],
	});
	const verified = await referencePage.evaluate(async (p) => {
		const verifyReference = async (a) => {
			const response = await fetch(a.uploadPath);
			return response.ok && JSON.stringify([...new Uint8Array(await response.arrayBuffer())]) === "[0,255,1,2,3]";
		};
		const api = window.recovery.createPendingSendStorage({ ownerId: window.ownerId, verifyReference });
		await api.save([p]);
		return api.restore();
	}, reference);
	exact(verified.pending, restored([reference]), "genuine resolvable external upload retains all metadata");
	const unverified = await restore(referencePage);
	assert.equal(unverified.complete, false);
	exact(
		unverified.blocked,
		restored([reference]),
		"unverified reference retains complete blocked source instead of stripped pending",
	);
	console.log(
		"PASS external reference verified against actual fixture bytes; unverified source remains blocked and intact",
	);

	await page.evaluate(
		async (p) => window.recovery.createPendingSendStorage({ ownerId: window.ownerId }).release(p, "acknowledged"),
		retry,
	);
	await reload(page, "large-tab");
	exact((await restore(page)).pending, [], "committed ack cleanup suppresses stale envelope reference across reload");
	const resurrected = await page.evaluate(async (p) => {
		try {
			await window.recovery.createPendingSendStorage({ ownerId: window.ownerId }).save([p]);
			return true;
		} catch (error) {
			return error.code !== "released";
		}
	}, large);
	assert.equal(resurrected, false);
	exact((await restore(smallPage)).pending, restored([small]), "ack cleanup cannot consume another tab's pending work");
	console.log("PASS native acknowledged cleanup, stale-write suppression and unrelated-tab retention");
	exact(pageErrors, [], "no uncaught page errors");
	console.log("PASS pending-send-storage browser proof (synthetic origin only; not integrated send/clear proof)");
} finally {
	await browser?.close();
	await new Promise((resolve) => server.close(resolve));
}
