/* Actual-app W2 recovery proof. Fresh Chromium + ownServer only. Never inspect a model request,
 * prompt/tool envelope or model result. The fastfail provider is unreachable; only app-level
 * metadata, known synthetic inputs and our own recovery export/native user count are observed. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { build } from "esbuild";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const out = process.env.PI_WEB_FIXTURE_OUT || `/tmp/durable-core-recovery-${Date.now()}`;
mkdirSync(out, { recursive: true });
// Use the ACTUAL read-only public codec, never guess private carrier text/ID prefixes.
const readerSource = join(repo, "web/src/pending-recovery-coordinator.ts");
const bundled = await build({
	entryPoints: [readerSource],
	bundle: true,
	write: false,
	format: "esm",
	platform: "browser",
	target: "es2022",
	logLevel: "silent",
});
const readerModule = join(out, "artifact-reader.mjs");
writeFileSync(readerModule, bundled.outputFiles[0].contents);
const { readPendingRecoveryArtifact } = await import(pathToFileURL(readerModule).href);
const cases = ["reload-clone", "quota", "abort", "envelope"];
const selected = process.env.PI_WEB_RECOVERY_CASES?.split(",") || cases;
assert.ok(
	selected.every((name) => cases.includes(name)),
	"unknown isolated case",
);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const bytes = Buffer.from("Complete native fixture file 雪🙂\n".repeat(60_000));
const companion = Buffer.from("Second original attachment Ω\n");
const names = ["complete-雪.txt", "second-Ω.txt"];
const inputs = [bytes, companion].map((buffer, i) => ({ name: names[i], mimeType: "text/plain", buffer }));
assert.ok(bytes.toString("base64").length > 1_500_000, "fixed input crosses the existing legacy boundary");
const result = {
	fixtureOnly: true,
	liveModelCalls: 0,
	frozenProductionPin: false,
	build: {
		server: sha(readFileSync(join(repo, "dist/server/index.js"))),
		webIndex: sha(readFileSync(join(repo, "web/dist/index.html"))),
		readerSource: sha(readFileSync(readerSource)),
		readerBundle: sha(bundled.outputFiles[0].contents),
	},
	assertions: [],
	cases: [],
};
function check(name, condition) {
	assert.ok(condition, name);
	result.assertions.push(name);
}
const server = await ownServer({ name: "durable-core-recovery", model: "fastfail" });
let browser;
const trackers = new WeakMap();
async function context() {
	const ctx = await browser.newContext({
		viewport: { width: 1440, height: 1000 },
		locale: "en-US",
		timezoneId: "UTC",
		acceptDownloads: true,
	});
	await ctx.addInitScript(() => {
		localStorage.setItem("pi-web-ui:lang", "en");
		window.fixtureFault = "none";
		window.fixtureFaultCounts = { quota: 0, putSuccess: 0, abort: 0, envelope: 0 };
		const put = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function (...args) {
			const target = this.transaction.db.name === "pi-web-pending-recovery-v1" && this.transaction.mode === "readwrite";
			if (target && window.fixtureFault === "quota") {
				window.fixtureFaultCounts.quota++;
				throw new DOMException("Synthetic native quota refusal", "QuotaExceededError");
			}
			const request = put.apply(this, args);
			if (target && window.fixtureFault === "abort") {
				const tx = this.transaction;
				request.addEventListener(
					"success",
					() => {
						window.fixtureFaultCounts.putSuccess++;
						try {
							tx.abort();
							window.fixtureFaultCounts.abort++;
						} catch {
							/* not counted as an abort */
						}
					},
					{ once: true },
				);
			}
			return request;
		};
		const set = Storage.prototype.setItem;
		Storage.prototype.setItem = function (key, value) {
			if (
				this === localStorage &&
				String(key).startsWith("pi-web-pending-owner-envelope-v1:") &&
				window.fixtureFault === "envelope"
			) {
				window.fixtureFaultCounts.envelope++;
				throw new DOMException("Synthetic envelope publication refusal", "QuotaExceededError");
			}
			return set.call(this, key, value);
		};
	});
	return ctx;
}
async function wirePage(page) {
	const tracker = { prompts: [], statuses: [], connections: 0, initialized: 0, metadata: null, pageErrors: 0 };
	trackers.set(page, tracker);
	page.on("pageerror", () => {
		tracker.pageErrors++;
	});
	await page.routeWebSocket(/\/ws(\?|$)/, (socket) => {
		tracker.connections++;
		const upstream = socket.connectToServer();
		socket.onMessage((raw) => {
			const frame = JSON.parse(String(raw));
			if (frame.type === "prompt") tracker.prompts.push(frame);
			if (frame.type === "prompt_status") tracker.statuses.push({ ids: frame.ids, reqId: frame.reqId });
			upstream.send(raw);
		});
		upstream.onMessage((raw) => {
			const frame = JSON.parse(String(raw));
			if (frame.type === "session_initialized") tracker.initialized++;
			if (frame.type === "snapshot")
				tracker.metadata = { sessionId: frame.state.sessionId, sessionFile: frame.state.sessionFile };
			socket.send(raw);
		});
	});
}
async function boot(page) {
	if (page.url() === "about:blank") await page.goto(server.http);
	await page.locator(".inputbox textarea").waitFor();
	await page.waitForFunction(() => {
		const box = document.querySelector(".inputbox textarea");
		return (
			box &&
			!box.disabled &&
			!/initializing|Connecting/.test(box.placeholder) &&
			!!sessionStorage.getItem("pi-web-pending-owner-v1")
		);
	});
	assert.ok(trackers.get(page)?.metadata?.sessionId, "actual native session is bound");
}
async function attach(page, text) {
	await page.locator('.inputbox input[type="file"]').setInputFiles(inputs);
	for (const name of names) await page.locator(".attach-chip.file").filter({ hasText: name }).waitFor();
	await page.locator(".inputbox textarea").fill(text);
}
async function owner(page) {
	return page.evaluate(() => sessionStorage.getItem("pi-web-pending-owner-v1"));
}
async function recordSummary(page, text) {
	const body = await page.evaluate(async () => {
		const ownerId = sessionStorage.getItem("pi-web-pending-owner-v1");
		const db = await new Promise((resolve, reject) => {
			const request = indexedDB.open("pi-web-pending-recovery-v1", 1);
			request.onerror = () => reject(new Error("native recovery read failed"));
			request.onupgradeneeded = () => {
				request.transaction.abort();
				reject(new Error("native recovery DB did not exist"));
			};
			request.onsuccess = () => resolve(request.result);
		});
		const records = await new Promise((resolve, reject) => {
			const tx = db.transaction("sends", "readonly");
			const get = tx.objectStore("sends").index("ownerId").getAll(ownerId);
			let rows;
			get.onsuccess = () => {
				rows = get.result;
			};
			tx.oncomplete = () => resolve(rows);
			tx.onabort = () => reject(new Error("native recovery read aborted"));
		});
		db.close();
		return {
			format: "pi-web-pending-recovery-export",
			version: 1,
			ownerId,
			records,
			envelope: localStorage.getItem(`pi-web-pending-owner-envelope-v1:${ownerId}`),
			legacyEnvelope: null,
		};
	});
	const decoded = await readPendingRecoveryArtifact(JSON.stringify({ ...body, checksum: sha(JSON.stringify(body)) }));
	const found = decoded.work.filter((work) => work.kind === "prompt" && work.pending.text === text);
	if (found.length !== 1) return { matches: found.length };
	const work = found[0];
	const value = work.pending;
	return {
		matches: found.length,
		id: value.id,
		sessionId: value.sessionId,
		owner: body.ownerId,
		digest: sha(JSON.stringify(decoded.artifact.records)),
		contentDigest: sha(JSON.stringify(work)),
		integrity: decoded.complete,
		createdAt: value.createdAt,
		complete:
			decoded.complete &&
			value.attachments?.length === inputs.length &&
			value.attachments.every(
				(a, i) =>
					a.fileData === inputs[i].buffer.toString("base64") && a.name === names[i] && a.mimeType === "text/plain",
			),
	};
}
async function inspectExport(page, text, original) {
	const panel = page.locator(".pending-recovery");
	await panel.waitFor();
	await panel.locator("summary").click();
	const retained = panel.locator(`[data-recovery-id="${original.id}"]`);
	await retained.waitFor();
	check(
		"actual coordinator exposes a complete decoded original after reload",
		(await retained.getAttribute("data-recovery-complete")) === "true",
	);
	const downloading = page.waitForEvent("download");
	await panel.getByRole("button", { name: "Export complete recovery", exact: true }).click();
	const download = await downloading;
	const artifact = JSON.parse(readFileSync(await download.path(), "utf8"));
	const { checksum, ...body } = artifact;
	check("complete exported artifact passes its exact content checksum", checksum === sha(JSON.stringify(body)));
	const decoded = await readPendingRecoveryArtifact(JSON.stringify(artifact));
	const selected = decoded.work.filter((work) => work.kind === "prompt" && work.pending.text === text);
	check(
		"actual app exports one intact selected original",
		decoded.complete &&
			selected.length === 1 &&
			sha(JSON.stringify(decoded.artifact.records)) === original.digest &&
			sha(JSON.stringify(selected[0])) === original.contentDigest,
	);
	const payload = selected[0].pending;
	check(
		"actual app export retains complete attachment bytes, order, names, MIME and original text",
		payload.text === text &&
			payload.attachments.length === inputs.length &&
			payload.attachments.every(
				(a, i) =>
					a.fileData === inputs[i].buffer.toString("base64") && a.name === names[i] && a.mimeType === "text/plain",
			),
	);
	check(
		"actual app export retains original owner/session/prompt identity",
		artifact.ownerId === original.owner && payload.id === original.id && payload.sessionId === original.sessionId,
	);
}
function nativeUserCount(tracker, text) {
	return readFileSync(tracker.metadata.sessionFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter(
			(row) =>
				row.type === "message" &&
				row.message?.role === "user" &&
				row.message.content?.some((block) => block.type === "text" && block.text === text),
		).length;
}
async function accepted(page, text) {
	await page.locator(".inputbox textarea").press("Enter");
	await page.waitForFunction(() => document.querySelector(".inputbox textarea")?.value === "");
	await page.waitForFunction(() => !document.querySelector(".btn.stop"));
	const tracker = trackers.get(page);
	check(
		"one complete prompt crosses the real native app boundary",
		tracker.prompts.length === 1 && tracker.prompts[0].text === text,
	);
	const summary = await recordSummary(page, text);
	check(
		"native IDB contains exact full attachments above the legacy size boundary",
		summary.matches === 1 && summary.complete && summary.integrity,
	);
	check(
		"native IDB identity matches the real outgoing prompt",
		summary.id === tracker.prompts[0].id &&
			summary.sessionId === tracker.prompts[0].forSession &&
			summary.contentDigest === tracker.prompts[0].recovery.contentDigest &&
			summary.owner === (await owner(page)),
	);
	check(
		"one corresponding user record persists in the temporary native transcript",
		nativeUserCount(tracker, text) === 1,
	);
	return summary;
}
async function reloadAndExport(page, text, original, expectedPrompts) {
	const tracker = trackers.get(page);
	const initialized = tracker.initialized;
	await page.reload();
	await boot(page);
	check("reload reuses the actual tab owner", (await owner(page)) === original.owner);
	await inspectExport(page, text, original);
	// Export/readback is an actual recovery-completion barrier, not a sleep guessing startup timing.
	const after = await recordSummary(page, text);
	check(
		"ordinary reload does not mutate or consume original records",
		after.complete &&
			after.digest === original.digest &&
			after.id === original.id &&
			after.createdAt === original.createdAt,
	);
	check(
		"reload completes actual native initialization without replay",
		tracker.initialized > initialized && tracker.prompts.length === expectedPrompts,
	);
}
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	for (const name of selected) {
		const ctx = await context();
		try {
			const page = await ctx.newPage();
			await wirePage(page);
			await boot(page);
			const text = `  ${name}: complete authored original 雪🙂\ntrailing spaces  \n`;
			await attach(page, text);
			if (name === "reload-clone") {
				const original = await accepted(page, text);
				await reloadAndExport(page, text, original, 1);
				check("accepted work still exists exactly once after reload", nativeUserCount(trackers.get(page), text) === 1);
				const opened = ctx.waitForEvent("page");
				// A real blank opener clone lets us install observation BEFORE its application loads.
				await page.evaluate(() => window.open("about:blank", "native-recovery-clone"));
				const popup = await opened;
				await wirePage(popup);
				await boot(popup);
				check(
					"real opener clone has the original recovery token",
					(await popup.evaluate(() => !!window.opener)) && (await owner(popup)) === original.owner,
				);
				const cloneText = "  cloned-owner draft stays editable 雪  ";
				await attach(popup, cloneText);
				await popup.locator(".inputbox textarea").press("Enter");
				await popup.getByText(/Send is not confirmed\. Your draft and attachments have been kept\./).waitFor();
				check(
					"active-owner clone refuses publication and keeps full editable source",
					trackers.get(popup).prompts.length === 0 &&
						(await popup.locator(".inputbox textarea").inputValue()) === cloneText,
				);
				for (const fileName of names)
					check(
						"clone retains its unaccepted editable attachments",
						await popup.locator(".attach-chip.file").filter({ hasText: fileName }).isVisible(),
					);
				check(
					"clone conflict cannot mutate another tab's complete records",
					(await recordSummary(popup, text)).digest === original.digest,
				);
				await popup.close();
				check(
					"original owner and all bytes remain reachable after clone closes",
					(await recordSummary(page, text)).complete && (await owner(page)) === original.owner,
				);
			} else {
				await page.evaluate((mode) => {
					window.fixtureFault = mode;
				}, name);
				await page.locator(".inputbox textarea").press("Enter");
				await page.getByText(/Send is not confirmed\. Your draft and attachments have been kept\./).waitFor();
				const tracker = trackers.get(page);
				check(
					`${name}: failure precedes wire and destructive text clear`,
					tracker.prompts.length === 0 && (await page.locator(".inputbox textarea").inputValue()) === text,
				);
				for (const fileName of names)
					check(
						`${name}: editable attachment remains visible`,
						await page.locator(".attach-chip.file").filter({ hasText: fileName }).isVisible(),
					);
				const counts = await page.evaluate(() => window.fixtureFaultCounts);
				if (name === "envelope") {
					check("envelope fault actually occurred after the native commit", counts.envelope > 0);
					const original = await recordSummary(page, text);
					check(
						"committed-but-unpublished payload retains exact bytes and identity",
						original.matches === 1 && original.complete && original.integrity && original.owner === (await owner(page)),
					);
					await reloadAndExport(page, text, original, 0);
					check(
						"orphan discovery/status does not silently submit the unsent original",
						nativeUserCount(tracker, text) === 0,
					);
				} else {
					check(
						`${name}: real native fault was reached`,
						name === "quota" ? counts.quota > 0 : counts.putSuccess > 0 && counts.abort > 0,
					);
					check(
						`${name}: an aborted write is not a partial committed success`,
						(await recordSummary(page, text)).matches === 0,
					);
					await page.evaluate(() => {
						window.fixtureFault = "none";
					});
					await accepted(page, text);
					check(
						`${name}: explicit later submit uses the retained complete editable bytes`,
						tracker.prompts.length === 1,
					);
				}
			}
			check(
				`${name}: no unhandled browser page errors`,
				[...ctx.pages()].every((p) => (trackers.get(p)?.pageErrors ?? 0) === 0),
			);
			result.cases.push(name);
		} finally {
			await ctx.close();
		}
	}
	console.log(
		`PASS isolated actual-app recovery: ${result.assertions.length} assertions; ${result.cases.length} cases; zero live models/chats`,
	);
} catch (error) {
	result.failure = String(error?.message || error);
	throw error;
} finally {
	rmSync(readerModule, { force: true });
	writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
	await browser?.close();
	await server.stop();
	rmSync(server.root, { recursive: true, force: true });
	console.log(`Fixture evidence: ${out}`);
}
