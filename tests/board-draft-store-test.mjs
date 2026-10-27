/* Synthetic-origin IndexedDB + fresh-reader proof for Board authored drafts (#598).
 * No app server, Temper, live browser profile, account or model.
 * Run: node tests/board-draft-store-test.mjs
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
const PINNED_OLD_COMMIT = "a875d2bc676a2ee90ade541b0d7fbfb4db364c74";
const PINNED_OLD_READER_BLOB = "c4c554243e509b97a79e8489efabbb4608e688ec";
const home = mkdtempSync(join(tmpdir(), "board-draft-storage-"));
let server, browser;
let serveFixtureBundle = true;
let passed = 0;
const errors = [];

const TYPED_ARRAY_CTORS = {
	"[object Int8Array]": Int8Array,
	"[object Uint8Array]": Uint8Array,
	"[object Uint8ClampedArray]": Uint8ClampedArray,
	"[object Int16Array]": Int16Array,
	"[object Uint16Array]": Uint16Array,
	"[object Int32Array]": Int32Array,
	"[object Uint32Array]": Uint32Array,
	"[object Float32Array]": Float32Array,
	"[object Float64Array]": Float64Array,
	"[object BigInt64Array]": BigInt64Array,
	"[object BigUint64Array]": BigUint64Array,
};

function reconstructRawBoardGraph(exportedText) {
	const parsed = JSON.parse(exportedText);
	assert.equal(parsed.format, "board-purpose-store-raw-graph-v1");
	const byId = new Map();

	function decode(node) {
		if (node === null || typeof node === "string" || typeof node === "boolean" || typeof node === "number") {
			return node;
		}
		if (typeof node !== "object") {
			throw new Error("Invalid non-object node in raw graph");
		}
		if ("reference" in node) {
			if (typeof node.reference !== "number" || !byId.has(node.reference)) {
				throw new Error(`Unresolved graph reference: ${String(node.reference)}`);
			}
			return byId.get(node.reference);
		}
		if (!("id" in node)) {
			if (node.type === "undefined" && node.value === "undefined") return undefined;
			if (node.type === "bigint" && typeof node.value === "string") return BigInt(node.value);
			if (node.type === "number" && typeof node.value === "string") {
				if (node.value === "-0") return -0;
				if (node.value === "NaN") return NaN;
				if (node.value === "Infinity") return Infinity;
				if (node.value === "-Infinity") return -Infinity;
			}
			throw new Error(`Unsupported primitive wrapper tag: ${JSON.stringify(node)}`);
		}
		const { id, type } = node;
		if (typeof id !== "number" || typeof type !== "string" || byId.has(id)) {
			throw new Error(`Invalid or duplicate object node id: ${String(id)}`);
		}
		if (type === "Date") {
			const date = new Date(decode(node.milliseconds));
			byId.set(id, date);
			return date;
		}
		if (type === "RegExp") {
			const regex = new RegExp(node.source, node.flags);
			byId.set(id, regex);
			return regex;
		}
		if (type === "ArrayBuffer") {
			assert.ok(Array.isArray(node.bytes), "ArrayBuffer node must carry bytes");
			const ab = new Uint8Array(node.bytes).buffer;
			byId.set(id, ab);
			return ab;
		}
		if (type === "[object DataView]" || type in TYPED_ARRAY_CTORS) {
			if (!("buffer" in node) || typeof node.byteOffset !== "number" || typeof node.byteLength !== "number") {
				throw new Error("Binary view node is missing backing buffer or byteOffset/byteLength metadata");
			}
			const backing = decode(node.buffer);
			if (!(backing instanceof ArrayBuffer)) {
				throw new Error("Binary view buffer did not reconstruct to an ArrayBuffer");
			}
			if (type === "[object DataView]") {
				const view = new DataView(backing, node.byteOffset, node.byteLength);
				byId.set(id, view);
				return view;
			}
			const Ctor = TYPED_ARRAY_CTORS[type];
			if (node.byteLength % Ctor.BYTES_PER_ELEMENT !== 0) {
				throw new Error(`Invalid byteLength ${node.byteLength} for ${type}`);
			}
			const view = new Ctor(backing, node.byteOffset, node.byteLength / Ctor.BYTES_PER_ELEMENT);
			byId.set(id, view);
			return view;
		}
		if (type === "Blob" || type === "File") {
			const bytes = new Uint8Array(node.bytes);
			const value = new Blob([bytes], { type: node.mime });
			byId.set(id, value);
			return value;
		}
		if (type === "Map") {
			const map = new Map();
			byId.set(id, map);
			for (const [k, v] of node.entries) map.set(decode(k), decode(v));
			return map;
		}
		if (type === "Set") {
			const set = new Set();
			byId.set(id, set);
			for (const item of node.entries) set.add(decode(item));
			return set;
		}
		if (type === "Array") {
			const arr = [];
			byId.set(id, arr);
			for (const [k, v] of node.entries) arr[k] = decode(v);
			return arr;
		}
		const obj = {};
		byId.set(id, obj);
		for (const [k, v] of node.entries) obj[k] = decode(v);
		return obj;
	}

	return decode(parsed.row);
}

function extractExportedValueNode(exportedText) {
	const parsed = JSON.parse(exportedText);
	assert.equal(parsed.format, "board-purpose-store-raw-graph-v1");
	return parsed.row.entries.find(([k]) => k === "value")[1];
}

function verifyEqualVisiblePairOracle(exportA, exportB) {
	if (JSON.stringify(extractExportedValueNode(exportA)) === JSON.stringify(extractExportedValueNode(exportB))) {
		throw new Error("Equal-visible views over unequal backing buffers collapsed into identical exported value nodes");
	}
	const rowA = reconstructRawBoardGraph(exportA).value;
	const rowB = reconstructRawBoardGraph(exportB).value;
	assert.ok(rowA.view instanceof Uint8Array);
	assert.ok(rowB.view instanceof Uint8Array);
	assert.deepEqual([...rowA.view], [7, 8]);
	assert.deepEqual([...rowB.view], [7, 8]);
	assert.equal(rowA.view.byteOffset, 1);
	assert.equal(rowA.view.byteLength, 2);
	assert.equal(rowB.view.byteOffset, 1);
	assert.equal(rowB.view.byteLength, 2);
	assert.deepEqual([...new Uint8Array(rowA.view.buffer)], [1, 7, 8, 4]);
	assert.deepEqual([...new Uint8Array(rowB.view.buffer)], [9, 7, 8, 6, 5]);
}

function verifySharedBinaryGraphOracle(exportedText) {
	const value = reconstructRawBoardGraph(exportedText).value;
	assert.ok(value.backing instanceof ArrayBuffer);
	assert.deepEqual([...new Uint8Array(value.backing)], [10, 20, 30, 40, 50, 60, 70, 80]);
	assert.ok(value.slicedUint8 instanceof Uint8Array);
	assert.equal(value.slicedUint8.byteOffset, 2);
	assert.equal(value.slicedUint8.byteLength, 3);
	assert.deepEqual([...value.slicedUint8], [30, 40, 50]);
	assert.ok(value.dataView instanceof DataView);
	assert.equal(value.dataView.byteOffset, 1);
	assert.equal(value.dataView.byteLength, 5);
	assert.deepEqual(
		[...new Uint8Array(value.dataView.buffer, value.dataView.byteOffset, value.dataView.byteLength)],
		[20, 30, 40, 50, 60],
	);
	assert.ok(value.sharedUint16 instanceof Uint16Array);
	assert.equal(value.sharedUint16.byteOffset, 2);
	assert.equal(value.sharedUint16.byteLength, 4);
	assert.equal(value.sharedUint16.length, 2);
	assert.equal(value.slicedUint8.buffer, value.dataView.buffer);
	assert.equal(value.slicedUint8.buffer, value.sharedUint16.buffer);
	assert.equal(value.slicedUint8.buffer, value.backing);
	assert.equal(value.slicedAlias, value.slicedUint8);
	assert.equal(value.self, value);
	assert.equal(Object.is(value.nan, NaN), true);
	assert.equal(Object.is(value.inf, Infinity), true);
	assert.equal(Object.is(value.negativeZero, -0), true);
	assert.equal(value.big, 42n);
	assert.equal("missing" in value && value.missing === undefined, true);
	assert.equal(value.date.getTime(), 1700000000000);
	assert.equal(value.re.source, "board-\\d+");
	assert.equal(value.re.flags, "gi");
	assert.equal(value.map.get("k"), "v");
	assert.equal(value.set.has("s1"), true);
}

const harness = `
import * as api from './web/src/board-draft-store';
import { exportRawBoardDraftRow } from './web/src/board-draft-reader';
import * as board from './web/src/roles-state';
import { setAppSend } from './web/src/app-globals';
import { setAppAdmit } from './web/src/app-admit';
const sent = [], admitted = [];
setAppSend(message => { sent.push(message); return false; });
setAppAdmit(async message => {
 admitted.push({ message, source: board.getBoardAdmissionSource(message) });
 return false;
});
const native = api.createBoardDraftIndexedDB(indexedDB);
const readOnly = api.createBoardDraftStore(api.createBoardDraftIndexedDB(indexedDB, { existingOnly: true }));
let mode = 'normal', held, release;
let requests = 0, completions = 0, nextTransactionId = 0;
const reads = [], transactions = [], transactionIds = new WeakMap();
const openTransaction = IDBDatabase.prototype.transaction;
IDBDatabase.prototype.transaction = function(storeNames, txMode, options) {
 const tx = openTransaction.call(this, storeNames, txMode, options);
 const id = ++nextTransactionId;
 transactionIds.set(tx, id);
 transactions.push({ id, mode: txMode, durability: options?.durability ?? tx.durability ?? null });
 return tx;
};
for (const method of ['get', 'count']) {
 const original = IDBObjectStore.prototype[method];
 IDBObjectStore.prototype[method] = function(key) {
  const tx = this.transaction;
  if (!transactionIds.has(tx)) transactionIds.set(tx, ++nextTransactionId);
  reads.push({ method, key, mode: tx.mode, durability: tx.durability ?? null, transaction: transactionIds.get(tx) });
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
const store = api.createBoardDraftStore(storage);
async function report(promise) {
 try { return { ok: true, value: await promise }; }
 catch(error) { return { ok: false, code: error.code, completed: error.transactionCompleted, name: error.name }; }
}
window.__draft = {
 api, store, sent, admitted,
 mode(value) { mode = value; },
 metrics() { return { requests, completions, sent, admitted }; },
 readTrace() { return reads.slice(); },
 txTrace() { return transactions.slice(); },
 create(source, submitted) { return report(store.create(source, submitted)); },
 update(expected, source) { return report(store.updateCurrent(expected, source)); },
 submitted(expected, source) { return report(store.retainSubmitted(expected, source)); },
 retire(expected) { return report(store.retire(expected)); },
 load(source) { return report(store.load(source)); },
 readOnlyLoad(source) { return report(readOnly.load(source)); },
 inspect() { return report(store.inspect()); },
 startHeld(expected, source) {
  const gate = new Promise(resolve => { release = resolve; });
  const late = api.createBoardDraftStore({ ...native, async swap(...args) { await gate; return native.swap(...args); } });
  held = report(late.updateCurrent(expected, source));
 },
 async releaseHeld() { release(); return held; },
 createCallerDraft(form) { return board.createBoardDraft(form); },
 reviseCallerDraft(source, form) { return board.reviseBoardDraft(source, form); },
 async submitCallerDraft(source) {
  const f = source.form;
  const wire = f.type === 'board_post'
   ? { type: f.type, kind: f.kind, to: f.toAll ? 'all' : [...f.picked].sort(), title: f.title.trim(), text: f.text.trim() }
   : { type: f.type, id: f.id, ...(f.note.trim() ? { note: f.note.trim() } : {}) };
  return board.boardRequest(wire, source, 50);
 },
 restore(source) { return board.restoreBoardDraft(source); },
 memory() { return board.getBoardDraftRecoveries(); },
 async raw(key, value) {
  const request = indexedDB.open(api.BOARD_DRAFT_DATABASE, 1);
  request.onupgradeneeded = () => {
   if (!request.result.objectStoreNames.contains(api.BOARD_DRAFT_OBJECT_STORE))
    request.result.createObjectStore(api.BOARD_DRAFT_OBJECT_STORE);
  };
  await new Promise((ok,bad) => { request.onsuccess=ok; request.onerror=bad; });
  const database = request.result;
  await new Promise((ok,bad) => {
   const tx = database.transaction(api.BOARD_DRAFT_OBJECT_STORE, 'readwrite');
   tx.objectStore(api.BOARD_DRAFT_OBJECT_STORE).put(value, key);
   tx.oncomplete=ok; tx.onabort=bad;
  });
  database.close();
 },
 async rawProbe(key) {
  const request = indexedDB.open(api.BOARD_DRAFT_DATABASE, 1);
  await new Promise((ok,bad) => { request.onsuccess=ok; request.onerror=bad; });
  const database = request.result;
  try {
   return await new Promise((ok,bad) => {
    const tx = database.transaction(api.BOARD_DRAFT_OBJECT_STORE, 'readonly');
    const rows = tx.objectStore(api.BOARD_DRAFT_OBJECT_STORE);
    const value = rows.get(key), presence = rows.count(key);
    tx.oncomplete = () => ok({ present: presence.result === 1, value: value.result });
    tx.onabort = bad;
   });
  } finally { database.close(); }
 },
 async rawSnapshot() {
  const rows = (await native.scan()).rows;
  return JSON.stringify(await Promise.all(rows.map(row => exportRawBoardDraftRow(row))));
 },
 async seedBinaryRows() {
  await this.raw('raw-equal-visible-a', {
   view: new Uint8Array(new Uint8Array([1, 7, 8, 4]).buffer, 1, 2),
  });
  await this.raw('raw-equal-visible-b', {
   view: new Uint8Array(new Uint8Array([9, 7, 8, 6, 5]).buffer, 1, 2),
  });
  const shared1 = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]).buffer;
  const sliced1 = new Uint8Array(shared1, 2, 3);
  const viewFirst = {
   slicedUint8: sliced1,
   dataView: new DataView(shared1, 1, 5),
   sharedUint16: new Uint16Array(shared1, 2, 2),
   backing: shared1,
   slicedAlias: sliced1,
   nan: NaN,
   inf: Infinity,
   negativeZero: -0,
   big: 42n,
   missing: undefined,
   date: new Date(1700000000000),
   re: /board-\\d+/gi,
   map: new Map([['k', 'v']]),
   set: new Set(['s1']),
  };
  viewFirst.self = viewFirst;
  await this.raw('raw-shared-binary-view-first', viewFirst);
  const shared2 = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]).buffer;
  const sliced2 = new Uint8Array(shared2, 2, 3);
  const backingFirst = {
   backing: shared2,
   slicedUint8: sliced2,
   dataView: new DataView(shared2, 1, 5),
   sharedUint16: new Uint16Array(shared2, 2, 2),
   slicedAlias: sliced2,
   nan: NaN,
   inf: Infinity,
   negativeZero: -0,
   big: 42n,
   missing: undefined,
   date: new Date(1700000000000),
   re: /board-\\d+/gi,
   map: new Map([['k', 'v']]),
   set: new Set(['s1']),
  };
  backingFirst.self = backingFirst;
  await this.raw('raw-shared-binary-backing-first', backingFirst);
 },
 async probeBinaryRows() {
  const equalA = (await this.rawProbe('raw-equal-visible-a')).value;
  const equalB = (await this.rawProbe('raw-equal-visible-b')).value;
  const shared = (await this.rawProbe('raw-shared-binary-view-first')).value;
  return {
   equalA: {
    visible: [...equalA.view],
    backing: [...new Uint8Array(equalA.view.buffer)],
    byteOffset: equalA.view.byteOffset,
    byteLength: equalA.view.byteLength,
   },
   equalB: {
    visible: [...equalB.view],
    backing: [...new Uint8Array(equalB.view.buffer)],
    byteOffset: equalB.view.byteOffset,
    byteLength: equalB.view.byteLength,
   },
   shared: {
    backing: [...new Uint8Array(shared.backing)],
    slicedVisible: [...shared.slicedUint8],
    slicedOffset: shared.slicedUint8.byteOffset,
    slicedLength: shared.slicedUint8.byteLength,
    dataViewOffset: shared.dataView.byteOffset,
    dataViewLength: shared.dataView.byteLength,
    uint16Offset: shared.sharedUint16.byteOffset,
    uint16ByteLength: shared.sharedUint16.byteLength,
    sameBuffer:
     shared.slicedUint8.buffer === shared.dataView.buffer &&
     shared.slicedUint8.buffer === shared.sharedUint16.buffer &&
     shared.slicedUint8.buffer === shared.backing,
    sameAlias: shared.slicedAlias === shared.slicedUint8,
    sameSelf: shared.self === shared,
   },
  };
 },
 async missingProbe(name) {
  const before = await indexedDB.databases();
  const result = await api.createBoardDraftStore(api.createBoardDraftIndexedDB(indexedDB, {existingOnly:true,databaseName:name})).inspect();
  return { before, result, after: await indexedDB.databases() };
 }
};
`;

function postSource(editorId = "editor-post-A", revision = 1, patch = {}) {
	return {
		editorId,
		revision,
		form: {
			type: "board_post",
			kind: "order",
			toAll: true,
			picked: ["temper", "ops", "qa"],
			title: "  Title é 🌈\t ",
			text: " line1\nline2 é 🌈\t ",
		},
		...patch,
	};
}

function closeSource(editorId = "editor-close-A", revision = 1, patch = {}) {
	return {
		editorId,
		revision,
		form: {
			type: "board_close",
			id: "bp-fixture-A",
			note: "  pause lifted é 🌈\t ",
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
		stdin: { contents: harness, loader: "js", resolveDir: REPO, sourcefile: "board-storage-fixture.js" },
		bundle: true,
		write: false,
		format: "esm",
		jsx: "automatic",
		logLevel: "silent",
		define: { "process.env.NODE_ENV": '"production"' },
	});
	const reader = await build({
		entryPoints: [join(REPO, "web/src/board-draft-reader.ts")],
		bundle: true,
		write: false,
		format: "esm",
		metafile: true,
		logLevel: "silent",
	});
	assert.deepEqual(
		Object.keys(reader.metafile.inputs)
			.map((name) => name.split("/").pop())
			.sort(),
		["board-draft-reader.ts", "board-draft-store.ts"],
	);
	const oldReaderBlob = execFileSync("git", ["rev-parse", `${PINNED_OLD_COMMIT}:web/src/board-draft-reader.ts`], {
		cwd: REPO,
		encoding: "utf8",
	}).trim();
	assert.equal(oldReaderBlob, PINNED_OLD_READER_BLOB);
	const oldReaderSource = execFileSync("git", ["show", `${PINNED_OLD_COMMIT}:web/src/board-draft-reader.ts`], {
		cwd: REPO,
		encoding: "utf8",
	});
	const oldReader = await build({
		stdin: {
			contents: oldReaderSource,
			loader: "ts",
			resolveDir: join(REPO, "web/src"),
			sourcefile: "board-draft-reader-a875d2bc.ts",
		},
		bundle: true,
		write: false,
		format: "esm",
		logLevel: "silent",
	});
	const rawRecoveryHtml = readFileSync(join(REPO, "web/board-draft-recovery.html"), "utf8");
	const html = rawRecoveryHtml.replace("./src/board-draft-reader.ts", "/reader.js");
	const oldHtml = rawRecoveryHtml.replace("./src/board-draft-reader.ts", "/reader-old.js");
	server = createServer((req, res) => {
		if (req.url === "/fixture.js") {
			if (!serveFixtureBundle) {
				res.statusCode = 404;
				res.end("app bundle absent");
				return;
			}
			res.setHeader("content-type", "text/javascript");
			res.end(fixture.outputFiles[0].contents);
		} else if (req.url === "/reader.js") {
			res.setHeader("content-type", "text/javascript");
			res.end(reader.outputFiles[0].contents);
		} else if (req.url === "/reader-old.js") {
			res.setHeader("content-type", "text/javascript");
			res.end(oldReader.outputFiles[0].contents);
		} else if (req.url === "/board-draft-recovery.html") {
			res.setHeader("content-type", "text/html");
			res.end(html);
		} else if (req.url === "/board-draft-recovery-old.html") {
			res.setHeader("content-type", "text/html");
			res.end(oldHtml);
		} else {
			res.setHeader("content-type", "text/html");
			res.end(
				'<!doctype html><html><body><main>Isolated synthetic Board fixture</main><script type="module" src="/fixture.js"></script></body></html>',
			);
		}
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
	const create = (s, sub) => page.evaluate(([value, submitted]) => window.__draft.create(value, submitted), [s, sub]);
	const load = (s) => page.evaluate((value) => window.__draft.load(value), s);
	const readOnlyLoad = (s) => page.evaluate((value) => window.__draft.readOnlyLoad(value), s);
	const rawProbe = (key) => page.evaluate((value) => window.__draft.rawProbe(value), key);
	const update = (r, s) => page.evaluate(([record, value]) => window.__draft.update(record, value), [r, s]);
	const submit = (r, s) => page.evaluate(([record, value]) => window.__draft.submitted(record, value), [r, s]);
	const retire = (r) => page.evaluate((record) => window.__draft.retire(record), r);
	const mode = (value) => page.evaluate((next) => window.__draft.mode(next), value);
	await reload();

	await check(
		"genuine #593 accepted Board caller keeps complete source and lossy wire only in page memory and loses both on reload",
		async () => {
			const created = await page.evaluate(async () => {
				const a = window.__draft.createCallerDraft({
					type: "board_post",
					kind: "order",
					toAll: true,
					picked: ["temper", "ops"],
					title: "  Title é 🌈  ",
					text: "  Body é 🌈\t ",
				});
				const res = await window.__draft.submitCallerDraft(a);
				const b = window.__draft.reviseCallerDraft(a, {
					...a.form,
					title: "  Edited B after submit  ",
				});
				return {
					a,
					b,
					res,
					admitted: window.__draft.admitted,
					memory: window.__draft.memory(),
				};
			});
			// Outbound wire stripped raw whitespace and omitted inactive picked when toAll=true
			assert.deepEqual(created.admitted[0].message, {
				type: "board_post",
				kind: "order",
				to: "all",
				title: "Title é 🌈",
				text: "Body é 🌈",
				reqId: created.admitted[0].message.reqId,
			});
			// Complete raw source was captured on the original message and in page memory before reload
			assert.deepEqual(created.admitted[0].source, created.a);
			assert.equal(created.memory.length, 1);
			assert.deepEqual(created.memory[0].current, created.b);
			assert.deepEqual(created.memory[0].attempts[0].source, created.a);
			// After reload, accepted #593 page memory is empty and no durable DB exists yet
			await reload();
			assert.deepEqual(await page.evaluate(() => window.__draft.memory()), []);
			assert.equal(must(await page.evaluate(() => window.__draft.inspect())).status, "missing");
		},
	);

	await check("missing existing-only reader commits no schema or database", async () => {
		const result = await page.evaluate(() => window.__draft.missingProbe("synthetic-absent-board-reader"));
		assert.equal(result.result.status, "missing");
		assert.deepEqual(result.before, result.after);
	});

	await check(
		"genuinely absent native key loads as absent, creates with strict durability and keeps valid exact CAS",
		async () => {
			const a = postSource("presence-absent-control");
			assert.equal(must(await load(a)), undefined);
			assert.equal(must(await readOnlyLoad(a)), undefined);
			const txBefore = (await page.evaluate(() => window.__draft.txTrace())).length;
			const first = must(await create(a));
			const txRecent = (await page.evaluate(() => window.__draft.txTrace())).slice(txBefore);
			assert.ok(
				txRecent.some((tx) => tx.mode === "readwrite" && tx.durability === "strict"),
				"readwrite transaction must request strict durability",
			);
			assert.deepEqual(await rawProbe(a.editorId), { present: true, value: first });
			refused(await create(a), "conflict");
			const b = { ...a, revision: 2, form: { ...a.form, text: "valid presence CAS" } };
			const next = must(await update(first, b));
			assert.deepEqual(next.current, b);
			refused(await update(first, { ...a, revision: 3 }), "conflict");
			assert.deepEqual(must(await readOnlyLoad(a)), next);
		},
	);

	await check(
		"atomic create persists initial current plus initial submitted original in one native transaction",
		async () => {
			const a0 = closeSource("atomic-create-close", 0, {
				form: { type: "board_close", id: "bp-atomic-1", note: "" },
			});
			const b1 = closeSource("atomic-create-close", 1, {
				form: { type: "board_close", id: "bp-atomic-1", note: "  edited after submit  " },
			});
			const beforeMetrics = await page.evaluate(() => window.__draft.metrics());
			const record = must(await create(b1, [a0]));
			const afterMetrics = await page.evaluate(() => window.__draft.metrics());
			assert.equal(afterMetrics.requests, beforeMetrics.requests + 1);
			assert.equal(afterMetrics.completions, beforeMetrics.completions + 1);
			assert.equal(record.version, 0);
			assert.deepEqual(record.current, b1);
			assert.deepEqual(record.submitted, [a0]);
			await reload();
			assert.deepEqual(must(await load(a0)), record);
		},
	);

	await check("present undefined is corrupt, never absent or replaceable, and raw export retains it", async () => {
		const a = postSource("presence-undefined");
		const key = a.editorId;
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
		refused(created, "invalid-record");
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
				reads.every((read) => read.key === key && read.durability === "strict"),
				"presence uses the same exact key and strict transaction",
			);
		}
		assert.deepEqual(must(await page.evaluate(() => window.__draft.inspect())), inspected);
		await reload();
		assert.deepEqual(await rawProbe(key), before);
		refused(await readOnlyLoad(a), "invalid-record");
		const readerPage = await context.newPage();
		try {
			await readerPage.goto(`${url}/board-draft-recovery.html`);
			await readerPage.waitForSelector('[data-board-reader-status="corrupt"]');
			const section = readerPage.locator("section").filter({ hasText: a.editorId });
			const download = readerPage.waitForEvent("download");
			await section.getByRole("button", { name: /^Export RAW UNKNOWN / }).click();
			const exported = JSON.parse(readFileSync(await (await download).path(), "utf8"));
			assert.equal(exported.format, "board-purpose-store-raw-graph-v1");
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
			const a = postSource(`presence-${label}`);
			const key = a.editorId;
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

	for (const kind of ["news", "order"])
		for (const toAll of [true, false])
			await check(
				`exact board_post (${kind}, toAll=${toAll}) with inactive/ordered picked survives reload`,
				async () => {
					const base = postSource(`reload-post-${kind}-${toAll}`);
					const a = { ...base, form: { ...base.form, kind, toAll, picked: ["qa", "temper", "ops"] } };
					const record = must(await create(a));
					assert.deepEqual(record.current, a);
					await reload();
					assert.deepEqual(must(await load(a)), record);
				},
			);

	await check("exact board_close with raw whitespace and empty note survives real reload", async () => {
		const a = closeSource("reload-close-whitespace");
		const b = closeSource("reload-close-empty", 0, { form: { type: "board_close", id: "bp-empty", note: "" } });
		const recA = must(await create(a));
		const recB = must(await create(b));
		await reload();
		assert.deepEqual(must(await load(a)), recA);
		assert.deepEqual(must(await load(b)), recB);
	});

	await check("empty clears on board_post preserve inactive picked order and kind across reload", async () => {
		const a = postSource("empty-clears", 1, {
			form: {
				type: "board_post",
				kind: "order",
				toAll: true,
				picked: ["temper", "ops"],
				title: "",
				text: "",
			},
		});
		const record = must(await create(a));
		await reload();
		assert.deepEqual(must(await load(a)), record);
	});

	let readerRecord;
	await check("submitted A remains immutable beside newer current B; fresh CAS adds exact original once", async () => {
		const a = postSource("reader-record");
		const first = must(await create(a));
		const b = {
			...a,
			revision: 2,
			form: { ...a.form, kind: "news", toAll: false, picked: ["ops", "temper"], title: "", text: "current B é 🌈" },
		};
		const current = must(await update(first, b));
		refused(await submit(first, a), "conflict");
		readerRecord = must(await submit(must(await load(a)), a));
		assert.deepEqual(readerRecord.current, b);
		assert.deepEqual(readerRecord.submitted, [a]);
		assert.deepEqual(must(await submit(readerRecord, a)), readerRecord);
		refused(
			await submit(readerRecord, { ...a, form: { ...a.form, text: "different bytes same revision" } }),
			"conflict",
		);
		assert.equal(readerRecord.version, current.version + 1);
		await reload();
		assert.deepEqual(must(await load(a)), readerRecord);
	});

	await check("genuine A/B/ABA and stale retirement cannot change newer B or an incarnation", async () => {
		const a = closeSource("ABA");
		const first = must(await create(a));
		const b = must(await update(first, { ...a, revision: 2, form: { ...a.form, note: "B" } }));
		const aba = must(await update(b, { ...a, revision: 3 }));
		refused(await update(first, { ...a, revision: 99999 }), "conflict");
		refused(await retire(first), "conflict");
		assert.deepEqual(must(await load(a)), aba);
		await page.evaluate(
			([key, value]) => window.__draft.raw(key, value),
			[a.editorId, { ...aba, recordId: "other-incarnation" }],
		);
		refused(await retire(aba), "conflict");
	});

	await check("delayed old A cannot overwrite already confirmed B", async () => {
		const a = postSource("late-A");
		const first = must(await create(a));
		await page.evaluate(([r, s]) => window.__draft.startHeld(r, s), [first, { ...a, revision: 2 }]);
		const b = must(await update(first, { ...a, revision: 3, form: { ...a.form, text: "B before A completes" } }));
		refused(await page.evaluate(() => window.__draft.releaseHeld()), "conflict");
		assert.deepEqual(must(await load(a)), b);
	});

	await check("two independent pages serialize same-record competing transactions", async () => {
		const a = postSource("two-pages");
		const first = must(await create(a));
		const other = await context.newPage();
		await other.goto(url);
		await other.waitForFunction(() => !!window.__draft);
		const results = await Promise.all([
			update(first, { ...a, revision: 2, form: { ...a.form, text: "page one" } }),
			other.evaluate(
				([r, s]) => window.__draft.update(r, s),
				[first, { ...a, revision: 2, form: { ...a.form, text: "page two" } }],
			),
		]);
		assert.equal(results.filter((r) => r.ok).length, 1);
		assert.equal(results.filter((r) => !r.ok && r.code === "conflict").length, 1);
		assert.deepEqual(must(await load(a)), results.find((r) => r.ok).value);
		await other.close();
	});

	await check(
		"editorId and target (post vs close and close post id) fences reject larger claimed revisions",
		async () => {
			const a = closeSource("target-ownership");
			const record = must(await create(a));
			for (const candidate of [
				closeSource("different-editor", 9999),
				postSource(a.editorId, 9999),
				closeSource(a.editorId, 9999, { form: { type: "board_close", id: "bp-different-target", note: "x" } }),
			]) {
				refused(await update(record, candidate), "conflict");
				refused(await submit(record, { ...candidate, revision: 1 }), "conflict");
			}
			refused(
				await load(closeSource(a.editorId, 1, { form: { type: "board_close", id: "bp-different-target", note: "x" } })),
				"conflict",
			);
			assert.deepEqual(must(await load(a)), record);
		},
	);

	await check("native put SUCCESS then transaction ABORT leaves prior recoverable bytes intact", async () => {
		const a = postSource("native-abort");
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
		const a = postSource("quota");
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
			const a = postSource(failure);
			const prior = must(await create(a));
			const b = { ...a, revision: 2, form: { ...a.form, text: "committed but NOT confirmed" } };
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
		const a = postSource("invalid");
		for (const patch of [
			{ revision: -1 },
			{ editorId: "" },
			{ ownerWords: "forbidden" },
			{ form: { ...a.form, kind: "invalid-kind" } },
		])
			refused(await create({ ...a, ...patch }), "invalid-source");
		assert.equal(await page.evaluate(() => window.__draft.rawSnapshot()), before);
	});

	await check(
		"standalone entry operates when the app bundle is absent, exports exact complete sources and visibly exports raw unknown rows without writes",
		async () => {
			await page.evaluate(() =>
				window.__draft.raw("synthetic-unknown-board-row", {
					purpose: "future-or-corrupt",
					schemaVersion: 900,
					raw: "<img src=x onerror=alert(1)>",
					inactive: "  preserve raw  ",
				}),
			);
			const before = await page.evaluate(() => window.__draft.rawSnapshot());
			serveFixtureBundle = false;
			const readerPage = await context.newPage();
			try {
				const absentResponse = await fetch(`${url}/fixture.js`);
				assert.equal(absentResponse.status, 404, "app bundle must be absent while standalone reader runs");
				await readerPage.goto(`${url}/board-draft-recovery.html`);
				await readerPage.waitForSelector('[data-board-reader-status="corrupt"]');
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
					.filter({ hasText: "synthetic-unknown-board-row" })
					.getByRole("button", { name: /^Export RAW UNKNOWN / });
				const rawDownload = readerPage.waitForEvent("download");
				await rawButton.click();
				const rawText = readFileSync(await (await rawDownload).path(), "utf8");
				assert.ok(rawText.includes("<img src=x onerror=alert(1)>"));
				assert.ok(rawText.includes("  preserve raw  "));
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
				const submittedSection = readerPage
					.locator("section")
					.filter({ has: readerPage.locator("h2", { hasText: /^Submitted original / }) });
				let submittedTarget;
				for (const section of await submittedSection.all()) {
					if (
						JSON.stringify(JSON.parse(await section.locator("pre").textContent())) ===
						JSON.stringify(readerRecord.submitted[0])
					)
						submittedTarget = section;
				}
				assert.ok(submittedTarget, "explicit submitted-source export must be independently discoverable");
				const submittedDownload = readerPage.waitForEvent("download");
				await submittedTarget.getByRole("button").click();
				assert.deepEqual(
					JSON.parse(readFileSync(await (await submittedDownload).path(), "utf8")),
					readerRecord.submitted[0],
				);
				assert.deepEqual(await readerPage.evaluate(() => window.__storageWatch), { writes: 0, schemas: 0, actions: 0 });
				assert.equal(await page.evaluate(() => window.__draft.rawSnapshot()), before);
				await readerPage.reload();
				await readerPage.waitForSelector('[data-board-reader-status="corrupt"]');
				assert.deepEqual(await readerPage.evaluate(() => window.__storageWatch), { writes: 0, schemas: 0, actions: 0 });
			} finally {
				serveFixtureBundle = true;
				await readerPage.close();
			}
		},
	);

	await check(
		"standalone reader downloads preserve full backing buffers, view offsets/lengths and shared-buffer topology after native IndexedDB round trip while app bundle is absent",
		async () => {
			await page.evaluate(() => window.__draft.seedBinaryRows());
			await reload();
			const beforeBinaryProbe = await page.evaluate(() => window.__draft.probeBinaryRows());
			assert.deepEqual(beforeBinaryProbe, {
				equalA: { visible: [7, 8], backing: [1, 7, 8, 4], byteOffset: 1, byteLength: 2 },
				equalB: { visible: [7, 8], backing: [9, 7, 8, 6, 5], byteOffset: 1, byteLength: 2 },
				shared: {
					backing: [10, 20, 30, 40, 50, 60, 70, 80],
					slicedVisible: [30, 40, 50],
					slicedOffset: 2,
					slicedLength: 3,
					dataViewOffset: 1,
					dataViewLength: 5,
					uint16Offset: 2,
					uint16ByteLength: 4,
					sameBuffer: true,
					sameAlias: true,
					sameSelf: true,
				},
			});
			const beforeSnapshot = await page.evaluate(() => window.__draft.rawSnapshot());
			serveFixtureBundle = false;
			const readerPage = await context.newPage();
			try {
				const absentResponse = await fetch(`${url}/fixture.js`);
				assert.equal(absentResponse.status, 404, "app bundle must be absent while standalone reader runs");
				await readerPage.goto(`${url}/board-draft-recovery.html`);
				await readerPage.waitForSelector('[data-board-reader-status="corrupt"]');

				async function downloadRawRow(pageInstance, key) {
					const button = pageInstance
						.locator("section")
						.filter({ hasText: key })
						.getByRole("button", { name: /^Export RAW UNKNOWN / });
					const downloadPromise = pageInstance.waitForEvent("download");
					await button.click();
					return readFileSync(await (await downloadPromise).path(), "utf8");
				}

				const downloadEqualA = await downloadRawRow(readerPage, "raw-equal-visible-a");
				const downloadEqualB = await downloadRawRow(readerPage, "raw-equal-visible-b");
				verifyEqualVisiblePairOracle(downloadEqualA, downloadEqualB);

				const downloadSharedViewFirst = await downloadRawRow(readerPage, "raw-shared-binary-view-first");
				const downloadSharedBackingFirst = await downloadRawRow(readerPage, "raw-shared-binary-backing-first");
				verifySharedBinaryGraphOracle(downloadSharedViewFirst);
				verifySharedBinaryGraphOracle(downloadSharedBackingFirst);

				assert.deepEqual(await readerPage.evaluate(() => window.__storageWatch), { writes: 0, schemas: 0, actions: 0 });
			} finally {
				serveFixtureBundle = true;
				await readerPage.close();
			}
			assert.deepEqual(await page.evaluate(() => window.__draft.probeBinaryRows()), beforeBinaryProbe);
			assert.equal(await page.evaluate(() => window.__draft.rawSnapshot()), beforeSnapshot);
		},
	);

	await check(
		"negative control: genuine pinned a875d2bc standalone reader loads and downloads valid JSON from the same native IndexedDB rows with app bundle absent, but fails equal-visible and shared-buffer preservation oracles",
		async () => {
			const beforeBinaryProbe = await page.evaluate(() => window.__draft.probeBinaryRows());
			serveFixtureBundle = false;
			const oldReaderPage = await context.newPage();
			try {
				const absentResponse = await fetch(`${url}/fixture.js`);
				assert.equal(absentResponse.status, 404, "app bundle must be absent while old standalone reader runs");
				await oldReaderPage.goto(`${url}/board-draft-recovery-old.html`);
				await oldReaderPage.waitForSelector('[data-board-reader-status="corrupt"]');

				async function downloadOldRawRow(key) {
					const button = oldReaderPage
						.locator("section")
						.filter({ hasText: key })
						.getByRole("button", { name: /^Export RAW UNKNOWN / });
					const downloadPromise = oldReaderPage.waitForEvent("download");
					await button.click();
					return readFileSync(await (await downloadPromise).path(), "utf8");
				}

				const oldEqualA = await downloadOldRawRow("raw-equal-visible-a");
				const oldEqualB = await downloadOldRawRow("raw-equal-visible-b");
				const oldShared = await downloadOldRawRow("raw-shared-binary-view-first");

				// Old standalone reader succeeded in loading, scanning IndexedDB, and downloading valid raw-graph JSON
				assert.equal(JSON.parse(oldEqualA).format, "board-purpose-store-raw-graph-v1");
				assert.equal(JSON.parse(oldEqualB).format, "board-purpose-store-raw-graph-v1");
				assert.equal(JSON.parse(oldShared).format, "board-purpose-store-raw-graph-v1");

				// Yet the old standalone reader collapsed both unequal backing buffers into identical value subgraphs
				assert.deepEqual(extractExportedValueNode(oldEqualA), extractExportedValueNode(oldEqualB));
				assert.throws(
					() => verifyEqualVisiblePairOracle(oldEqualA, oldEqualB),
					/collapsed into identical exported value nodes/,
				);
				assert.throws(
					() => verifySharedBinaryGraphOracle(oldShared),
					/missing backing buffer or byteOffset\/byteLength metadata/,
				);
				assert.deepEqual(await oldReaderPage.evaluate(() => window.__storageWatch), {
					writes: 0,
					schemas: 0,
					actions: 0,
				});
			} finally {
				serveFixtureBundle = true;
				await oldReaderPage.close();
			}
			assert.deepEqual(await page.evaluate(() => window.__draft.probeBinaryRows()), beforeBinaryProbe);
		},
	);

	await check(
		"fresh #593 LOOK-ONLY restore compatibility retains current B and original A, sends nothing",
		async () => {
			await reload();
			assert.deepEqual(await page.evaluate(() => window.__draft.memory()), []);
			assert.equal(await page.evaluate((s) => window.__draft.restore(s), readerRecord.current), true);
			assert.equal(await page.evaluate((s) => window.__draft.restore(s), readerRecord.submitted[0]), true);
			const recovery = (await page.evaluate(() => window.__draft.memory()))[0];
			assert.deepEqual(recovery.current, readerRecord.current);
			assert.deepEqual(recovery.restoredSources, [readerRecord.current, ...readerRecord.submitted]);
			const metrics = await page.evaluate(() => window.__draft.metrics());
			assert.deepEqual(metrics.sent, []);
			assert.deepEqual(metrics.admitted, []);
		},
	);

	assert.deepEqual(errors, [], "fixture browser must have no unhandled errors");
	console.log(`PASS ${passed} isolated native Board storage/reader cases; real IndexedDB, no board actions.`);
} finally {
	await browser?.close();
	if (server) await new Promise((resolve) => server.close(resolve));
	rmSync(home, { recursive: true, force: true });
}
