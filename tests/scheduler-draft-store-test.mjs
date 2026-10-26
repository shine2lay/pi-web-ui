/* Synthetic-origin IndexedDB + fresh-reader proof. No app, scheduler, SDK, live
 * server, user profile, account or model. Run: node tests/scheduler-draft-store-test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const FROZEN_BASELINE = "18c0844bba5b2f899bb0565c518d500f69b843f5";
// This negative control runs these same assertions with the immutable old store.
// It must fail for the observed hidden/overwritten undefined row, not setup failure.
const baselineControl = process.argv.includes("--baseline-control");
const storePlugins = baselineControl
	? [
			{
				name: "frozen-scheduler-store",
				setup(build) {
					build.onLoad({ filter: /[/\\]scheduler-draft-store\.ts$/ }, () => ({
						contents: execFileSync("git", ["show", `${FROZEN_BASELINE}:web/src/scheduler-draft-store.ts`], {
							cwd: REPO,
							encoding: "utf8",
						}),
						loader: "ts",
					}));
				},
			},
		]
	: [];
const home = mkdtempSync(join(tmpdir(), "scheduler-draft-storage-"));
let server, browser;
let passed = 0;
const errors = [];
const harness = `
import * as api from './web/src/scheduler-draft-store';
import * as panel from './web/src/components/SchedulerPanel';
import { setAppSend } from './web/src/app-globals';
import { setAppAdmit } from './web/src/app-admit';
const sent = [], admitted = [];
setAppSend(message => { sent.push(message); return false; });
setAppAdmit(async message => { admitted.push(message); return false; });
const native = api.createSchedulerDraftIndexedDB(indexedDB);
const readOnly = api.createSchedulerDraftStore(api.createSchedulerDraftIndexedDB(indexedDB, { existingOnly: true }));
let mode = 'normal', held, release;
let requests = 0, completions = 0, nextTransactionId = 0;
const reads = [], transactionIds = new WeakMap();
for (const method of ['get', 'count']) {
 const original = IDBObjectStore.prototype[method];
 IDBObjectStore.prototype[method] = function(key) {
  const tx = this.transaction;
  if (!transactionIds.has(tx)) transactionIds.set(tx, ++nextTransactionId);
  reads.push({ method, key, mode: tx.mode, transaction: transactionIds.get(tx) });
  return original.call(this, key);
 };
}
const put = IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put = function(...args) {
 if (mode === 'quota') throw new DOMException('synthetic quota', 'QuotaExceededError');
 const request = put.apply(this, args), tx = this.transaction, selected = mode;
 request.addEventListener('success', () => { requests++; if (selected === 'abort') tx.abort(); });
 tx.addEventListener('complete', () => completions++, { once: true });
 return request;
};
const storage = {
 ...native,
 async read(key) {
  if (mode === 'readback-fail') throw new Error('synthetic readback access failure');
  const result = await native.read(key);
  return mode === 'readback-mismatch' && result ? { ...result, recordId: 'wrong-readback-record' } : result;
 },
 async swap(...args) {
  await native.swap(...args);
  if (mode === 'committed-fail') throw new Error('synthetic boundary failure after commit');
 }
};
const store = api.createSchedulerDraftStore(storage);
async function report(promise) {
 try { return { ok: true, value: await promise }; }
 catch(error) { return { ok: false, code: error.code, completed: error.transactionCompleted, name: error.name }; }
}
window.__draft = {
 api, store, sent, admitted,
 mode(value) { mode = value; },
 metrics() { return { requests, completions, sent, admitted }; },
 readTrace() { return reads.slice(); },
 create(source) { return report(store.create(source)); },
 update(expected, source) { return report(store.updateCurrent(expected, source)); },
 submitted(expected, source) { return report(store.retainSubmitted(expected, source)); },
 retire(expected) { return report(store.retire(expected)); },
 load(source) { return report(store.load(source)); },
 readOnlyLoad(source) { return report(readOnly.load(source)); },
 inspect() { return report(store.inspect()); },
 startHeld(expected, source) {
  const gate = new Promise(resolve => { release = resolve; });
  const late = api.createSchedulerDraftStore({ ...native, async swap(...args) { await gate; return native.swap(...args); } });
  held = report(late.updateCurrent(expected, source));
 },
 async releaseHeld() { release(); return held; },
 restore(source) { return panel.restoreSchedulerDraft(source); },
 memory() { return panel.getSchedulerDraftRecoveries(); },
 async raw(key, value) {
  const request = indexedDB.open(api.SCHEDULER_DRAFT_DATABASE, 1);
  await new Promise((ok,bad) => { request.onsuccess=ok; request.onerror=bad; });
  const database = request.result;
  await new Promise((ok,bad) => {
   const tx = database.transaction(api.SCHEDULER_DRAFT_OBJECT_STORE, 'readwrite');
   tx.objectStore(api.SCHEDULER_DRAFT_OBJECT_STORE).put(value, key);
   tx.oncomplete=ok; tx.onabort=bad;
  });
  database.close();
 },
 async rawProbe(key) {
  const request = indexedDB.open(api.SCHEDULER_DRAFT_DATABASE, 1);
  await new Promise((ok,bad) => { request.onsuccess=ok; request.onerror=bad; });
  const database = request.result;
  try {
   return await new Promise((ok,bad) => {
    const tx = database.transaction(api.SCHEDULER_DRAFT_OBJECT_STORE, 'readonly');
    const rows = tx.objectStore(api.SCHEDULER_DRAFT_OBJECT_STORE);
    const value = rows.get(key), presence = rows.count(key);
    tx.oncomplete = () => ok({ present: presence.result === 1, value: value.result });
    tx.onabort = bad;
   });
  } finally { database.close(); }
 },
 async rawSnapshot() { return JSON.stringify((await native.scan()).rows); },
 async missingProbe(name) {
  const before = await indexedDB.databases();
  const result = await api.createSchedulerDraftStore(api.createSchedulerDraftIndexedDB(indexedDB, {existingOnly:true,databaseName:name})).inspect();
  return { before, result, after: await indexedDB.databases() };
 }
};
`;
function source(formId = "form-A", revision = 1, patch = {}) {
	return {
		workspace: "/synthetic/owner é 🌈",
		taskId: null,
		formId,
		revision,
		form: {
			id: "",
			name: "  é 🌈\t task  ",
			description: " raw\ndescription ",
			cwd: " /synthetic/different-execution-cwd/ ",
			kind: "interval",
			cron: " 7 8 * * 2 \t",
			preset: "custom",
			intervalMinutes: " 00.25e+2 ",
			prompt: " line1\nline2 é 🌈\t ",
			model: "fixture/raw-model",
			thinkingLevel: "raw-thinking",
			catchUp: false,
		},
		...patch,
	};
}
async function check(name, action) {
	await action();
	passed++;
	console.log(`  ✓ ${name}`);
}
function must(result) {
	assert.equal(result.ok, true, JSON.stringify(result));
	return result.value;
}
function refused(result, code) {
	assert.equal(result.ok, false, "a failed check must never count as confirmation");
	if (code) assert.equal(result.code, code);
}
try {
	assert.ok(CHROME_PATH, "Chrome is required; native storage proof cannot silently skip");
	const fixture = await build({
		stdin: { contents: harness, loader: "js", resolveDir: REPO, sourcefile: "scheduler-storage-fixture.js" },
		bundle: true,
		write: false,
		format: "esm",
		jsx: "automatic",
		logLevel: "silent",
		plugins: storePlugins,
		define: { "process.env.NODE_ENV": '"production"' },
	});
	const reader = await build({
		entryPoints: [join(REPO, "web/src/scheduler-draft-reader.ts")],
		bundle: true,
		write: false,
		format: "esm",
		metafile: true,
		logLevel: "silent",
		plugins: storePlugins,
	});
	assert.deepEqual(
		Object.keys(reader.metafile.inputs)
			.map((name) => name.split("/").pop())
			.sort(),
		["scheduler-draft-reader.ts", "scheduler-draft-store.ts"],
	);
	const html = readFileSync(join(REPO, "web/scheduler-draft-recovery.html"), "utf8").replace(
		"./src/scheduler-draft-reader.ts",
		"/reader.js",
	);
	server = createServer((req, res) => {
		res.setHeader("content-type", req.url?.endsWith(".js") ? "text/javascript" : "text/html");
		if (req.url === "/fixture.js") res.end(fixture.outputFiles[0].contents);
		else if (req.url === "/reader.js") res.end(reader.outputFiles[0].contents);
		else if (req.url === "/scheduler-draft-recovery.html") res.end(html);
		else
			res.end(
				'<!doctype html><html><body><main>Isolated synthetic fixture</main><script type="module" src="/fixture.js"></script></body></html>',
			);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	assert.ok(server.address().port >= 8900);
	const url = `http://127.0.0.1:${server.address().port}`;
	browser = await chromium.launch({
		executablePath: CHROME_PATH,
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
		env: { ...process.env, HOME: home },
	});
	const context = await browser.newContext({ acceptDownloads: true });
	await context.addInitScript(() => {
		window.__storageWatch = { writes: 0, schemas: 0, actions: 0 };
		for (const key of ["put", "add", "delete", "clear"]) {
			const original = IDBObjectStore.prototype[key];
			IDBObjectStore.prototype[key] = function (...args) {
				window.__storageWatch.writes++;
				return original.apply(this, args);
			};
		}
		for (const key of ["createObjectStore", "deleteObjectStore"]) {
			const original = IDBDatabase.prototype[key];
			IDBDatabase.prototype[key] = function (...args) {
				window.__storageWatch.schemas++;
				return original.apply(this, args);
			};
		}
		window.fetch = () => {
			window.__storageWatch.actions++;
			throw new Error("No fixture fetch allowed");
		};
		window.WebSocket = class {
			constructor() {
				window.__storageWatch.actions++;
				throw new Error("No fixture socket allowed");
			}
		};
	});
	context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
	const page = await context.newPage();
	async function reload() {
		await page.goto(url);
		await page.waitForFunction(() => !!window.__draft);
	}
	const create = (s) => page.evaluate((value) => window.__draft.create(value), s);
	const load = (s) => page.evaluate((value) => window.__draft.load(value), s);
	const readOnlyLoad = (s) => page.evaluate((value) => window.__draft.readOnlyLoad(value), s);
	const rawProbe = (key) => page.evaluate((value) => window.__draft.rawProbe(value), key);
	const update = (r, s) => page.evaluate(([record, value]) => window.__draft.update(record, value), [r, s]);
	const submit = (r, s) => page.evaluate(([record, value]) => window.__draft.submitted(record, value), [r, s]);
	const retire = (r) => page.evaluate((record) => window.__draft.retire(record), r);
	const mode = (value) => page.evaluate((next) => window.__draft.mode(next), value);
	await reload();
	await check("genuine #590 page-memory-only control loses the complete source on reload", async () => {
		const a = source("memory-only");
		assert.equal(await page.evaluate((s) => window.__draft.restore(s), a), true);
		assert.deepEqual((await page.evaluate(() => window.__draft.memory()))[0].current, a.form);
		await reload();
		assert.deepEqual(await page.evaluate(() => window.__draft.memory()), []);
		assert.equal(must(await page.evaluate(() => window.__draft.inspect())).status, "missing");
	});
	await check("missing existing-only reader commits no schema or database", async () => {
		const result = await page.evaluate(() => window.__draft.missingProbe("synthetic-absent-reader"));
		assert.equal(result.result.status, "missing");
		assert.deepEqual(result.before, result.after);
	});
	await check("genuinely absent native key loads as absent, creates and keeps valid exact CAS", async () => {
		const a = source("presence-absent-control");
		assert.equal(must(await load(a)), undefined);
		assert.equal(must(await readOnlyLoad(a)), undefined);
		const first = must(await create(a));
		const key = JSON.stringify([a.workspace, a.taskId, a.formId]);
		assert.deepEqual(await rawProbe(key), { present: true, value: first });
		refused(await create(a), "conflict");
		const b = { ...a, revision: 2, form: { ...a.form, prompt: "valid presence CAS" } };
		const next = must(await update(first, b));
		assert.deepEqual(next.current, b);
		refused(await update(first, { ...a, revision: 3 }), "conflict");
		assert.deepEqual(must(await readOnlyLoad(a)), next);
	});
	await check("present undefined is corrupt, never absent or replaceable, and raw export retains it", async () => {
		const a = source("presence-undefined");
		const key = JSON.stringify([a.workspace, a.taskId, a.formId]);
		await page.evaluate(([k, v]) => window.__draft.raw(k, v), [key, undefined]);
		const before = await rawProbe(key);
		assert.deepEqual(before, { present: true, value: undefined });
		const inspected = must(await page.evaluate(() => window.__draft.inspect()));
		assert.equal(inspected.status, "corrupt");
		assert.deepEqual(inspected.unknown, [{ key, value: undefined }]);
		const metrics = await page.evaluate(() => window.__draft.metrics());
		const traceStart = (await page.evaluate(() => window.__draft.readTrace())).length;
		const loaded = await load(a);
		const readOnlyLoaded = await readOnlyLoad(a);
		const created = await create(a);
		const typedReads = (await page.evaluate(() => window.__draft.readTrace())).slice(traceStart);
		const after = await rawProbe(key);
		if (baselineControl)
			console.log(
				"Frozen native key-presence evidence:",
				JSON.stringify({
					pin: FROZEN_BASELINE,
					beforePresent: before.present,
					beforeUndefined: before.value === undefined,
					loadOk: loaded.ok,
					loadAbsent: loaded.ok && loaded.value === undefined,
					readOnlyLoadAbsent: readOnlyLoaded.ok && readOnlyLoaded.value === undefined,
					createOk: created.ok,
					afterPresent: after.present,
					afterUndefined: after.value === undefined,
				}),
			);
		refused(created, "invalid-record"); // frozen #596 really replaces the unknown row here
		assert.equal(created.completed, false);
		refused(loaded, "invalid-record");
		refused(readOnlyLoaded, "invalid-record");
		assert.deepEqual(after, before);
		assert.deepEqual(await page.evaluate(() => window.__draft.metrics()), metrics);
		const transactions = Map.groupBy(typedReads, (read) => read.transaction);
		assert.equal(transactions.size, 3, "two loads and one refused create each own one native transaction");
		assert.deepEqual(
			[...transactions.values()].map((reads) => reads[0].mode),
			["readonly", "readonly", "readwrite"],
		);
		for (const reads of transactions.values()) {
			assert.deepEqual(
				reads.map((read) => read.method),
				["get", "count"],
			);
			assert.ok(
				reads.every((read) => read.key === key),
				"presence uses the same exact key, not a preflight",
			);
		}
		assert.deepEqual(must(await page.evaluate(() => window.__draft.inspect())), inspected);
		await reload();
		assert.deepEqual(await rawProbe(key), before);
		refused(await readOnlyLoad(a), "invalid-record");
		const readerPage = await context.newPage();
		try {
			await readerPage.goto(`${url}/scheduler-draft-recovery.html`);
			await readerPage.waitForSelector('[data-scheduler-reader-status="corrupt"]');
			const section = readerPage.locator("section").filter({ hasText: a.formId });
			const download = readerPage.waitForEvent("download");
			await section.getByRole("button", { name: /^Export RAW UNKNOWN / }).click();
			const exported = JSON.parse(readFileSync(await (await download).path(), "utf8"));
			assert.equal(exported.format, "scheduler-purpose-store-raw-graph-v1");
			assert.deepEqual(exported.row.entries, [
				["key", key],
				["value", { type: "undefined", value: "undefined" }],
			]);
			assert.deepEqual(await readerPage.evaluate(() => window.__storageWatch), { writes: 0, schemas: 0, actions: 0 });
		} finally {
			await readerPage.close();
		}
		assert.deepEqual(await rawProbe(key), before);
	});
	for (const [label, value] of [
		["null", null],
		["false", false],
		["zero", 0],
		["empty", ""],
		["foreign", { purpose: "future", schemaVersion: 900 }],
	])
		await check(`other corrupt native value ${label} stays present and untouched`, async () => {
			const a = source(`presence-${label}`);
			const key = JSON.stringify([a.workspace, a.taskId, a.formId]);
			await page.evaluate(([k, v]) => window.__draft.raw(k, v), [key, value]);
			const before = await rawProbe(key);
			assert.deepEqual(before, { present: true, value });
			refused(await readOnlyLoad(a), "invalid-record");
			refused(await create(a), "invalid-record");
			assert.deepEqual(await rawProbe(key), before);
			const inspection = must(await page.evaluate(() => window.__draft.inspect()));
			assert.equal(inspection.status, "corrupt");
			assert.deepEqual(
				inspection.unknown.find((row) => row.key === key),
				{ key, value },
			);
		});
	for (const taskId of [null, "task-a"])
		for (const kind of ["cron", "interval"])
			await check(`exact ${taskId ?? "new"}/${kind} all12 raw fields survive real reload`, async () => {
				const base = source(`reload-${taskId}-${kind}`);
				const a = { ...base, taskId, form: { ...base.form, id: taskId ?? "", kind, catchUp: true } };
				const record = must(await create(a));
				assert.deepEqual(record.current, a);
				await reload();
				assert.deepEqual(must(await load(a)), record);
			});
	await check("empty clears preserve inactive cron/preset/minutes rather than normalized command fields", async () => {
		const a = source("empty-clears");
		const form = { ...a.form };
		for (const key of Object.keys(form)) if (!["kind", "preset", "catchUp"].includes(key)) form[key] = "";
		a.form = form;
		const record = must(await create(a));
		await reload();
		assert.deepEqual(must(await load(a)), record);
	});
	let readerRecord;
	await check("submitted A remains immutable beside newer current B; fresh CAS adds exact original once", async () => {
		const a = source("reader-record");
		const first = must(await create(a));
		const b = { ...a, revision: 2, form: { ...a.form, prompt: "current B é 🌈", name: "", description: "" } };
		const current = must(await update(first, b));
		refused(await submit(first, a), "conflict");
		readerRecord = must(await submit(must(await load(a)), a));
		assert.deepEqual(readerRecord.current, b);
		assert.deepEqual(readerRecord.submitted, [a]);
		assert.deepEqual(must(await submit(readerRecord, a)), readerRecord);
		refused(
			await submit(readerRecord, { ...a, form: { ...a.form, prompt: "different bytes same revision" } }),
			"conflict",
		);
		assert.equal(readerRecord.version, current.version + 1);
		await reload();
		assert.deepEqual(must(await load(a)), readerRecord);
	});
	await check("genuine A/B/ABA and stale retirement cannot change newer B or an incarnation", async () => {
		const a = source("ABA");
		const first = must(await create(a));
		const b = must(await update(first, { ...a, revision: 2, form: { ...a.form, prompt: "B" } }));
		const aba = must(await update(b, { ...a, revision: 3 }));
		refused(await update(first, { ...a, revision: 99999 }), "conflict");
		refused(await retire(first), "conflict");
		assert.deepEqual(must(await load(a)), aba);
		await page.evaluate(
			([key, value]) => window.__draft.raw(key, value),
			[JSON.stringify([a.workspace, a.taskId, a.formId]), { ...aba, recordId: "other-incarnation" }],
		);
		refused(await retire(aba), "conflict");
	});
	await check("delayed old A cannot overwrite already confirmed B", async () => {
		const a = source("late-A");
		const first = must(await create(a));
		await page.evaluate(([r, s]) => window.__draft.startHeld(r, s), [first, { ...a, revision: 2 }]);
		const b = must(await update(first, { ...a, revision: 3, form: { ...a.form, prompt: "B before A completes" } }));
		refused(await page.evaluate(() => window.__draft.releaseHeld()), "conflict");
		assert.deepEqual(must(await load(a)), b);
	});
	await check("two independent pages serialize same-record competing transactions", async () => {
		const a = source("two-pages");
		const first = must(await create(a));
		const other = await context.newPage();
		await other.goto(url);
		await other.waitForFunction(() => !!window.__draft);
		const results = await Promise.all([
			update(first, { ...a, revision: 2, form: { ...a.form, prompt: "page one" } }),
			other.evaluate(
				([r, s]) => window.__draft.update(r, s),
				[first, { ...a, revision: 2, form: { ...a.form, prompt: "page two" } }],
			),
		]);
		assert.equal(results.filter((r) => r.ok).length, 1);
		assert.equal(results.filter((r) => !r.ok && r.code === "conflict").length, 1);
		assert.deepEqual(must(await load(a)), results.find((r) => r.ok).value);
		await other.close();
	});
	await check("workspace/form/task fences reject larger claimed revision, never execution cwd ownership", async () => {
		const a = source("ownership");
		const record = must(await create(a));
		for (const patch of [
			{ workspace: a.form.cwd },
			{ formId: "different-form" },
			{ taskId: "different-task", form: { ...a.form, id: "different-task" } },
		])
			refused(await update(record, { ...a, revision: 9999, ...patch }), "conflict");
		assert.deepEqual(must(await load(a)), record);
	});
	await check("native put SUCCESS then transaction ABORT leaves prior recoverable bytes intact", async () => {
		const a = source("native-abort");
		const prior = must(await create(a));
		const before = await page.evaluate(() => window.__draft.metrics());
		await mode("abort");
		const failed = await update(prior, { ...a, revision: 2 });
		refused(failed, "transaction-failed");
		assert.equal(failed.completed, false);
		const after = await page.evaluate(() => window.__draft.metrics());
		assert.equal(after.requests, before.requests + 1);
		assert.equal(after.completions, before.completions);
		await mode("normal");
		assert.deepEqual(must(await load(a)), prior);
		await reload();
		assert.deepEqual(must(await load(a)), prior);
	});
	await check("quota refusal is explicit and preserves prior record", async () => {
		const a = source("quota");
		const prior = must(await create(a));
		await mode("quota");
		refused(await update(prior, { ...a, revision: 2 }));
		await mode("normal");
		assert.deepEqual(must(await load(a)), prior);
	});
	for (const [failure, code, completed] of [
		["readback-fail", "readback-failed", true],
		["readback-mismatch", "readback-mismatch", true],
		["committed-fail", "transaction-failed", "unknown"],
	])
		await check(`${failure}: uncertain committed bytes remain recoverable after reload`, async () => {
			const a = source(failure);
			const prior = must(await create(a));
			const b = { ...a, revision: 2, form: { ...a.form, prompt: "committed but NOT confirmed" } };
			await mode(failure);
			const result = await update(prior, b);
			refused(result, code);
			assert.equal(result.completed, completed);
			await reload();
			assert.deepEqual(must(await load(a)).current, b);
		});
	await check("exact retirement is a retained marker, never removes original or current bytes", async () => {
		const marker = must(await retire(readerRecord));
		assert.deepEqual(marker, { ...readerRecord, retired: true, version: readerRecord.version + 1 });
		readerRecord = marker;
		await reload();
		assert.deepEqual(must(await load(marker.current)), marker);
		refused(await update(marker, { ...marker.current, revision: 999 }), "retired");
	});
	await check("strict source/record rejection leaves original storage unmodified", async () => {
		const before = await page.evaluate(() => window.__draft.rawSnapshot());
		const a = source("invalid");
		for (const patch of [
			{ revision: -1 },
			{ taskId: "mismatch" },
			{ extra: true },
			{ form: { ...a.form, preset: "unknown" } },
		])
			refused(await create({ ...a, ...patch }), "invalid-source");
		assert.equal(await page.evaluate(() => window.__draft.rawSnapshot()), before);
	});
	await check(
		"standalone entry exports exact complete sources and visibly exports raw unknown rows without writes",
		async () => {
			await page.evaluate(() =>
				window.__draft.raw("synthetic-unknown-row", {
					purpose: "future-or-corrupt",
					schemaVersion: 900,
					raw: "<img src=x onerror=alert(1)>",
					inactive: " 00.00 ",
				}),
			);
			const before = await page.evaluate(() => window.__draft.rawSnapshot());
			const readerPage = await context.newPage();
			await readerPage.goto(`${url}/scheduler-draft-recovery.html`);
			await readerPage.waitForSelector('[data-scheduler-reader-status="corrupt"]');
			assert.equal(await readerPage.locator("img").count(), 0);
			assert.ok((await readerPage.locator("main").innerText()).includes("<img src=x onerror=alert(1)>"));
			assert.ok((await readerPage.locator("main").innerText()).includes("RETIREMENT MARKER"));
			const pres = await readerPage.locator("pre").allTextContents();
			assert.ok(
				pres.some((text) => {
					try {
						return JSON.stringify(JSON.parse(text)) === JSON.stringify(readerRecord.current);
					} catch {
						return false;
					}
				}),
			);
			assert.ok(
				pres.some((text) => {
					try {
						return JSON.stringify(JSON.parse(text)) === JSON.stringify(readerRecord.submitted[0]);
					} catch {
						return false;
					}
				}),
			);
			const rawButton = readerPage
				.locator("section")
				.filter({ hasText: "synthetic-unknown-row" })
				.getByRole("button", { name: /^Export RAW UNKNOWN / });
			const rawDownload = readerPage.waitForEvent("download");
			await rawButton.click();
			const rawText = readFileSync(await (await rawDownload).path(), "utf8");
			assert.ok(rawText.includes("<img src=x onerror=alert(1)>"));
			assert.ok(rawText.includes(" 00.00 "));
			const currentSection = readerPage
				.locator("section")
				.filter({ has: readerPage.locator("h2", { hasText: /^Current / }) });
			let target;
			for (const section of await currentSection.all()) {
				if (
					JSON.stringify(JSON.parse(await section.locator("pre").textContent())) ===
					JSON.stringify(readerRecord.current)
				)
					target = section;
			}
			assert.ok(target, "explicit current-source export must be independently discoverable");
			const currentDownload = readerPage.waitForEvent("download");
			await target.getByRole("button").click();
			assert.deepEqual(JSON.parse(readFileSync(await (await currentDownload).path(), "utf8")), readerRecord.current);
			assert.deepEqual(await readerPage.evaluate(() => window.__storageWatch), { writes: 0, schemas: 0, actions: 0 });
			assert.equal(await page.evaluate(() => window.__draft.rawSnapshot()), before);
			await readerPage.reload();
			await readerPage.waitForSelector('[data-scheduler-reader-status="corrupt"]');
			assert.deepEqual(await readerPage.evaluate(() => window.__storageWatch), { writes: 0, schemas: 0, actions: 0 });
			await readerPage.close();
		},
	);
	await check(
		"fresh #590 LOOK-ONLY restore compatibility retains current B and original A, sends nothing",
		async () => {
			await reload();
			assert.deepEqual(await page.evaluate(() => window.__draft.memory()), []);
			assert.equal(await page.evaluate((s) => window.__draft.restore(s), readerRecord.current), true);
			assert.equal(await page.evaluate((s) => window.__draft.restore(s), readerRecord.submitted[0]), true);
			const recovery = (await page.evaluate(() => window.__draft.memory()))[0];
			assert.deepEqual(recovery.current, readerRecord.current.form);
			assert.deepEqual(recovery.restoredSources, [readerRecord.current, ...readerRecord.submitted]);
			const metrics = await page.evaluate(() => window.__draft.metrics());
			assert.deepEqual(metrics.sent, []);
			assert.deepEqual(metrics.admitted, []);
		},
	);
	assert.deepEqual(errors, [], "fixture browser must have no unhandled errors");
	console.log(`PASS ${passed} isolated native scheduler storage/reader cases; real IndexedDB, no schedule actions.`);
} finally {
	await browser?.close();
	if (server) await new Promise((resolve) => server.close(resolve));
	rmSync(home, { recursive: true, force: true });
}
