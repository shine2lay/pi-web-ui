/* Ops #586: actual store + actual NotebookPanel, isolated same-origin browser fixture.
 * No application server, user profile/data, model, real WS, recovery journal or replay.
 * scripts/sealed.sh node tests/durable-notebook-admission-test.mjs
 * Baseline controls bundle the real two files from BASE, not a stand-in implementation. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const BASE = "4f32b06e2d2f8dec63a4258ac6575ba2cbac7b92";
const root = fileURLToPath(new URL("..", import.meta.url));
assert.ok(CHROME_PATH, "BLOCKED: configure isolated Chromium (PI_WEB_CHROME); never use a live profile");
const baseline = new Map(
	["web/src/notebook-state.ts", "web/src/components/NotebookPanel.tsx"].map((path) => [
		join(root, path),
		execFileSync("git", ["show", `${BASE}:${path}`], { cwd: root, encoding: "utf8" }),
	]),
);
const entry = `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { LanguageProvider } from "./web/src/i18n";
import { NotebookPanel } from "./web/src/components/NotebookPanel";
import * as store from "./web/src/notebook-state";
import { setAppAdmit } from "./web/src/app-admit";
import { setAppSend } from "./web/src/app-globals";
let root;
const requests = [], calls = [], pending = [];
const flush = (fn) => flushSync(fn);
const isSave = (m) => m.type === "identity_file_save" || m.type === "identity_note_save";
const fixture = {
 store, requests, calls, pending, transport: true,
 reset() { if (root) { flush(() => root.unmount()); root = undefined; } store.resetNotebookState(); requests.length = calls.length = pending.length = 0; fixture.transport = true; },
 mount(id = "ops") { if (!root) root = createRoot(document.getElementById("root")); flush(() => root.render(<LanguageProvider><NotebookPanel key={id} identity={{id, title:id}} /></LanguageProvider>)); },
 unmount() { if (root) { flush(() => root.unmount()); root = undefined; } },
 ready(id = "ops", text = "base\\n", hash = "base-h") { flush(() => store.receiveNotebook({type:"identity_notebook",id,text,hash,cap:4_000_000,memory:{index:"[fixture]",indexSize:9,indexFull:9,indexBudget:2000,hidden:0,over:false,sent:20,cap:8000,tokens:5,rulesCap:4_000_000,rulesSize:5,counts:{notes:2,digests:0,outdated:0,rules:1},notesVersion:"v1"}})); flush(() => store.receiveNotesFound({type:"identity_notes_found",id,query:"",hits:["n1","n2"].map(ref=>({ref,date:"2026-01-01",topic:"fixture",flags:[],summary:ref,preview:"",size:10,score:1})),total:2})); },
 read(patch = {}) { const m = requests.findLast(m => m.type === "identity_note_get"); if (!m) throw Error("no read request"); flush(() => store.receiveNote({type:"identity_note",id:m.id,ref:m.ref,reqId:m.reqId,text:"note-base\\n",hash:"note-h",editable:true,...patch})); },
 lastSave() { return calls.at(-1) ?? requests.findLast(isSave); },
 ack(patch = {}, message = fixture.lastSave()) { if (!message) throw Error("no original save"); const payload = message.type === "identity_file_save" ? {type:"identity_file_saved",id:message.id,file:message.file,ref:message.ref,reqId:message.reqId,ok:true,hash:"saved-h"} : {type:"identity_note_saved",id:message.id,ref:message.ref,reqId:message.reqId,ok:true,hash:"saved-note-h"}; flush(() => { if (payload.type === "identity_file_saved") store.receiveNotebookSaved({...payload,...patch}); else store.receiveNoteSaved({...payload,...patch}); }); },
 async settle(index = 0, value = true) { const p = pending[index]; if (!p) throw Error("no pending admission"); if (value === "reject") p.reject(Error("uncertain dispatch")); else p.resolve(value); await Promise.resolve(); await Promise.resolve(); },
 doubleSave() { const editor = document.querySelector("textarea.notebook-editor"); const button = document.querySelector("button.notebook-save"); editor.dispatchEvent(new KeyboardEvent("keydown",{key:"s",ctrlKey:true,bubbles:true,cancelable:true})); button.click(); },
 flush,
};
setAppSend(message => { requests.push(structuredClone(message)); if (fixture.transport === "throw") throw Error("uncertain transport"); return fixture.transport; });
setAppAdmit(message => { calls.push(structuredClone(message)); return new Promise((resolve,reject) => pending.push({resolve,reject})); });
window.fixture = fixture;
`;
async function bundle(old) {
	const result = await build({
		absWorkingDir: root,
		stdin: { contents: entry, resolveDir: root, loader: "jsx" },
		bundle: true,
		format: "esm",
		platform: "browser",
		write: false,
		jsx: "automatic",
		define: { "process.env.NODE_ENV": '"test"', "import.meta.env.DEV": "false" },
		plugins: old
			? [
					{
						name: "real-baseline-files",
						setup(builder) {
							builder.onLoad({ filter: /(?:notebook-state\.ts|NotebookPanel\.tsx)$/ }, (args) => {
								const contents = baseline.get(args.path);
								return contents === undefined
									? undefined
									: { contents, loader: args.path.endsWith("tsx") ? "tsx" : "ts" };
							});
						},
					},
				]
			: [],
	});
	return result.outputFiles[0].text;
}
const [source, oldSource] = await Promise.all([bundle(false), bundle(true)]);
const server = createServer((req, res) => {
	if (req.url === "/fixture.js" || req.url === "/baseline.js") {
		res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
		res.end(req.url === "/baseline.js" ? oldSource : source);
	} else {
		res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
		res.end(
			`<!doctype html><title>Synthetic notebook admission fixture</title><style>body{font:16px sans-serif;max-width:960px;margin:24px}textarea{display:block;width:90%;height:200px}button{margin:5px;padding:6px}.notebook-raw{white-space:pre-wrap}</style><div id="root"></div><script type="module" src="${req.url === "/baseline" ? "/baseline.js" : "/fixture.js"}"></script>`,
		);
	}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
let browser;
let checks = 0;
const errors = [];
const pass = (name) => {
	checks++;
	console.log(`PASS ${name}`);
};
const A = "authored-A\n完整 é 🌈\n";
const B = "newer-B\n kept completely é 🌈\n";
async function setup(page, kind) {
	await page.evaluate(() => {
		const f = window.fixture;
		f.reset();
		f.mount();
		f.ready();
	});
	if (kind === "note") {
		await page.locator('.notebook-note-row[data-ref="n1"]').click();
		await page.evaluate(() => window.fixture.read());
		await page.locator(".notebook-note-edit").click();
	} else await page.locator(".notebook-edit").click();
	return page.locator("textarea.notebook-editor");
}
async function pendingCount(page, count) {
	await page.waitForFunction((n) => window.fixture.calls.length === n, count);
}
async function notSaving(page) {
	await page.waitForFunction(() => {
		const n = window.fixture.store.getNotebook();
		return n && !n.saving && n.notes.open?.busy !== "save";
	});
}
async function kept(page, text) {
	await page.waitForFunction((text) => document.querySelector("textarea.notebook-editor")?.value === text, text);
	assert.equal(await page.locator("textarea.notebook-editor").inputValue(), text);
}
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
	const context = await browser.newContext({ serviceWorkers: "block" });
	const page = await context.newPage();
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/*", (route) =>
		route
			.request()
			.url()
			.startsWith(origin + "/")
			? route.continue()
			: route.abort(),
	);
	await page.goto(origin);
	await page.waitForFunction(() => !!window.fixture);

	for (const kind of ["notebook", "note"]) {
		for (const outcome of [false, "reject", "committed-false"]) {
			const editor = await setup(page, kind);
			await editor.fill(A);
			await page.evaluate(() => window.fixture.doubleSave());
			await pendingCount(page, 1);
			await kept(page, A);
			assert.equal(
				await page
					.locator(".notebook-note")
					.filter({ hasText: /^Saved\./ })
					.count(),
				0,
			);
			await editor.fill(B);
			await page.evaluate(async (outcome) => {
				const f = window.fixture;
				if (outcome === "committed-false") f.checkpoint = structuredClone(f.calls[0]);
				await f.settle(0, outcome === "committed-false" ? false : outcome);
			}, outcome);
			await notSaving(page);
			await kept(page, B);
			assert.match(await page.locator('[role="status"]').last().innerText(), /outcome unknown/);
			const snapshot = await page.evaluate(() => ({
				calls: window.fixture.calls,
				requests: window.fixture.requests,
				attempts: window.fixture.store.getNotebookSaveAttempts(),
				checkpoint: window.fixture.checkpoint,
			}));
			assert.equal(snapshot.calls[0].text, A);
			assert.equal(snapshot.calls[0].id, "ops");
			assert.equal(snapshot.calls[0].baseHash, kind === "notebook" ? "base-h" : "note-h");
			assert.equal(snapshot.attempts[0].message.text, A);
			assert.equal(
				snapshot.requests.filter((m) => m.type === "identity_file_save" || m.type === "identity_note_save").length,
				0,
			);
			if (outcome === "committed-false") assert.deepEqual(snapshot.checkpoint, snapshot.calls[0]);
			await page.evaluate(() => window.fixture.ack());
			await kept(page, B);
			pass(`${kind}: deferred ${outcome}, same-turn Ctrl-S + click, full A/B retained, no fallback/eager Saved`);
		}

		for (const aba of [false, true]) {
			const editor = await setup(page, kind);
			await editor.fill(A);
			await editor.press("Control+s");
			await pendingCount(page, 1);
			await editor.fill(B);
			if (aba) await editor.fill(A);
			await page.evaluate(async () => window.fixture.settle(0, true));
			await kept(page, aba ? A : B);
			await page.evaluate(() => {
				window.fixture.ack({ reqId: undefined });
				window.fixture.ack({ reqId: "old" });
				window.fixture.ack({ id: "other" });
				window.fixture.ack({ ref: "other" });
			});
			await kept(page, aba ? A : B);
			const waiting = await page.evaluate(() => {
				const n = window.fixture.store.getNotebook();
				return n.saving || n.notes.open?.busy === "save";
			});
			assert.equal(waiting, true);
			await page.evaluate(() => window.fixture.ack());
			await notSaving(page);
			await kept(page, aba ? A : B);
			const baselineText = await page.evaluate((kind) => {
				const n = window.fixture.store.getNotebook();
				return kind === "notebook" ? n.text : n.notes.open.text;
			}, kind);
			assert.equal(baselineText, A);
			if (kind === "note") {
				await page.evaluate(() => window.fixture.read({ text: "canonical-A", hash: "saved-note-h" }));
				await kept(page, aba ? A : B);
			}
			pass(
				`${kind}: exact ACK alone moves A baseline, ${aba ? "A→B→A" : "B"} survives mismatched/no-echo and canonical read`,
			);
		}

		const editor = await setup(page, kind);
		await editor.fill(A);
		await page.locator("button.notebook-save").click();
		await pendingCount(page, 1);
		await page.evaluate(() => window.fixture.ack());
		await kept(page, A);
		assert.equal(
			await page
				.locator(".notebook-note")
				.filter({ hasText: /^Saved\./ })
				.count(),
			0,
		);
		await page.evaluate(async () => window.fixture.settle(0, true));
		await notSaving(page);
		await page.locator("textarea.notebook-editor").waitFor({ state: "detached" });
		assert.equal(
			await page
				.locator(".notebook-note")
				.filter({ hasText: /^Saved\./ })
				.count(),
			1,
		);
		pass(`${kind}: early real ACK buffered; unchanged submitted edit closes only after literal true`);

		const e = await setup(page, kind);
		await e.fill(A);
		await e.press("Control+s");
		await pendingCount(page, 1);
		await e.fill(B);
		await page.evaluate(() => {
			const f = window.fixture;
			f.oldSave = structuredClone(f.calls[0]);
			f.unmount();
			f.mount("other");
			f.ready("other");
		});
		await page.locator(".notebook-edit").click();
		await page.locator("textarea").fill("other-resource-C");
		await page.evaluate(async () => {
			const f = window.fixture;
			await f.settle(0, false);
			f.ack({}, f.oldSave);
		});
		await kept(page, "other-resource-C");
		await page.evaluate(() => {
			const f = window.fixture;
			f.unmount();
			f.mount();
			f.ready();
		});
		if (kind === "note") {
			await page.locator('.notebook-note-row[data-ref="n1"]').click();
			await page.evaluate(() => window.fixture.read());
		}
		await kept(page, B);
		await page.locator("textarea").press("Control+s");
		await pendingCount(page, 2);
		await page.evaluate(async () => {
			const f = window.fixture;
			await f.settle(1, true);
			f.ack({}, f.oldSave);
			f.ack({ ok: false, code: "io" }, f.oldSave);
		});
		await kept(page, B);
		await page.evaluate(() => window.fixture.ack());
		await notSaving(page);
		await page.locator("textarea.notebook-editor").waitFor({ state: "detached" });
		pass(`${kind}: unmount/identity switch/same-resource reopen, late old success/error cannot finish newer operation`);
	}

	await setup(page, "notebook");
	await page.locator("textarea").fill(A);
	await page.evaluate(() => window.fixture.ready("ops", "external", "external-h"));
	await page.locator("textarea").press("Control+s");
	await page.locator(".notebook-save-mine").click();
	await pendingCount(page, 1);
	assert.equal(await page.evaluate(() => window.fixture.calls[0].baseHash), "external-h");
	await page.locator("textarea").fill(B);
	await page.evaluate(async () => window.fixture.settle(0, false));
	await notSaving(page);
	await kept(page, B);
	pass("notebook: conflict-save captures selected base and never clears later typing on false admission");

	await setup(page, "notebook");
	const long = "完整 é 🌈\n".repeat(18_000) + "end\n";
	// Preserve the full fixture without spending the native keyboard path on 18,000 combining-mark lines.
	// The browser's own value setter + input still invokes the actual panel's React onChange handler.
	await page.evaluate((text) => {
		const editor = document.querySelector("textarea.notebook-editor");
		const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
		window.fixture.flush(() => {
			setter.call(editor, text);
			editor.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}, long);
	assert.equal(await page.evaluate(() => window.fixture.store.getNotebook().draft.text), long);
	await page.locator("textarea").press("Control+s");
	await pendingCount(page, 1);
	assert.equal(await page.evaluate(() => window.fixture.calls[0].text), long);
	await page.evaluate(async () => window.fixture.settle(0, false));
	await notSaving(page);
	await kept(page, long);
	pass("notebook: complete long attachment-independent Unicode text, no preview truncation");

	await setup(page, "note");
	await page.locator(".notebook-note-cancel").click();
	await page.locator(".notebook-note-delete").click();
	await page.evaluate(() => {
		window.fixture.transport = false;
	});
	await page.locator(".notebook-note-delete-yes").click();
	assert.equal(await page.locator(".notebook-delete-confirm").count(), 1);
	assert.match(await page.locator(".notebook-open").innerText(), /Delete outcome unknown/);
	await page.evaluate(() => {
		window.fixture.transport = "throw";
	});
	await page.locator(".notebook-note-delete-yes").click();
	assert.equal(await page.locator(".notebook-delete-confirm").count(), 1);
	await page.evaluate(() => {
		window.fixture.transport = true;
	});
	await page.locator(".notebook-note-delete-yes").click();
	assert.equal(await page.locator(".notebook-delete-confirm").count(), 1);
	await page.evaluate(() => {
		const f = window.fixture;
		const m = f.requests.findLast((m) => m.type === "identity_note_delete");
		f.flush(() =>
			f.store.receiveNoteSaved({
				type: "identity_note_saved",
				id: m.id,
				ref: m.ref,
				reqId: "old-save",
				ok: true,
				deleted: true,
			}),
		);
	});
	assert.equal(await page.locator(".notebook-delete-confirm").count(), 1);
	await page.evaluate(() => {
		const f = window.fixture;
		const m = f.requests.findLast((m) => m.type === "identity_note_delete");
		f.flush(() =>
			f.store.receiveNoteSaved({
				type: "identity_note_saved",
				id: m.id,
				ref: m.ref,
				reqId: m.reqId,
				ok: true,
				deleted: true,
			}),
		);
	});
	await page.locator(".notebook-open").waitFor({ state: "detached" });
	assert.equal(await page.evaluate(() => window.fixture.calls.length), 0);
	pass(
		"reads/watch/search/delete journal nothing; delete false/throw preserves confirm; transport true/old save ACK cannot close it",
	);

	// Genuine behavioral reds: bundle original store/panel, use their real bool sender and success effects.
	await page.goto(origin + "/baseline");
	await page.waitForFunction(() => !!window.fixture);
	for (const kind of ["notebook", "note"]) {
		const editor = await setup(page, kind);
		await editor.fill(A);
		await page.locator("button.notebook-save").click();
		await editor.fill(B);
		assert.equal(await page.evaluate(() => window.fixture.calls.length), 0); // original code bypasses installed deferred admission
		const eager = await page.evaluate((kind) => {
			const n = window.fixture.store.getNotebook();
			return kind === "notebook" ? n.saving : n.notes.open.busy === "save";
		}, kind);
		assert.equal(eager, true);
		await page.evaluate(() => window.fixture.ack());
		await page.locator("textarea.notebook-editor").waitFor({ state: "detached" });
		assert.equal(await page.locator("textarea.notebook-editor").count(), 0); // old real success effect erased newer B
		pass(`BASELINE RED ${kind}: original bool transport bypasses admission, original real success effect erases B`);
	}
	assert.deepEqual(errors, [], "no browser runtime errors");
	console.log(
		`PASS ${checks} actual-panel/store native cases, including two genuine baseline behavioral reds; no live data/models`,
	);
} finally {
	await browser?.close();
	await new Promise((resolve) => server.close(resolve));
}
