/* Real Board forms + store + #585, synthetic isolated native browser only.
 * --baseline loads both original source files verbatim, adding exports only.
 * No app/model server, real browser profile, post, close, role or chat is used. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const BASE = "4f32b06e2d2f8dec63a4258ac6575ba2cbac7b92";
const baseline = process.argv.includes("--baseline");
const home = mkdtempSync(join(tmpdir(), "board-admission-browser-"));
let server,
	browser,
	passed = 0;
const errors = [];
const harness = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {LanguageProvider} from './web/src/i18n';
import {BoardForm,BoardCloseForm} from './web/src/components/RolesView';
import * as store from './web/src/roles-state';
import {setAppAdmit} from './web/src/app-admit';
import {setAppSend} from './web/src/app-globals';
const calls=[],sent=[],done=[];
let mode='pending',pending,shown=true,version=0,kind='post',id='bp-fixture-A';
const root=createRoot(document.getElementById('root'));
setAppSend(message=>{sent.push(message);return true;});
setAppAdmit(message=>{
 calls.push({message,source:store.getBoardAdmissionSource?.(message)});
 if(mode==='pending')return new Promise((resolve,reject)=>{pending={resolve,reject};});
 if(mode==='reject')return Promise.reject(new Error('synthetic rejection'));
 if(mode==='throw')throw new Error('synthetic throw');
 return Promise.resolve(mode==='true'?true:mode==='truthy'?{ok:true}:false);
});
function render(){flushSync(()=>root.render(<LanguageProvider>{shown?(kind==='post'?
 <BoardForm key={version} roleIds={['qa','ops','temper']} onDone={value=>{done.push(value);shown=false;render();}}/>:
 <BoardCloseForm key={version} post={{id,kind:'news',title:'Fixture',text:'Fixture',to:['all'],at:1,from:'owner',sent:{},read:{},done:{}}}
 onDone={value=>{done.push(value);shown=false;render();}}/>):null}</LanguageProvider>));}
render();
window.__board={
 open(next='post'){kind=next;shown=true;version++;render();},
 target(value){id=value;render();},
 unmount(){shown=false;render();},
 mode(value){mode=value;if(value==='unbound')setAppAdmit(null);},
 settle(value,reject=false){if(!pending)throw new Error('no pending admission');const old=pending;pending=undefined;
  if(reject)old.reject(Object.assign(new Error('late synthetic rejection'),{payloadCommitted:true}));else old.resolve(value);},
 result(patch={}){const message=(calls.at(-1)?.message??sent.at(-1));if(!message)throw new Error('no request');
  store.receiveBoardResult({type:'board_result',reqId:message.reqId,op:message.type==='board_post'?'post':'close',ok:true,
   id:message.type==='board_close'?message.id:'bp-created',direct:['ops'],later:['qa'],...patch});},
 restore(source){return store.restoreBoardDraft?.(source)??false;},
 snap(){return {calls,sent,done,recoveries:store.getBoardDraftRecoveries?.()??[]};}
};
`;
const post = {
	kind: "order",
	toAll: true,
	picked: ["temper", "ops"],
	title: "  Title é 🌈  ",
	text: "  keep é 🌈\nsecond line\t  ",
};
const note = "  close é 🌈\t  ";
async function check(name, run) {
	await run();
	passed++;
	console.log(`  ✓ ${name}`);
}
try {
	assert.ok(CHROME_PATH, "Install Chrome/set PI_WEB_CHROME; native proof must not silently skip");
	const bundled = await build({
		stdin: { contents: harness, loader: "jsx", resolveDir: REPO, sourcefile: "board-native-harness.jsx" },
		bundle: true,
		write: false,
		format: "esm",
		jsx: "automatic",
		logLevel: "silent",
		loader: { ".css": "empty" },
		define: { "process.env.NODE_ENV": '"production"' },
		plugins: baseline
			? [
					{
						name: "genuine-original-board",
						setup(plugin) {
							plugin.onLoad({ filter: /\/web\/src\/(components\/RolesView\.tsx|roles-state\.ts)$/ }, ({ path }) => {
								const relative = path.slice(REPO.length);
								const original = execFileSync("git", ["-C", REPO, "show", `${BASE}:${relative}`], { encoding: "utf8" });
								return {
									contents:
										original + (relative.endsWith("RolesView.tsx") ? "\nexport {BoardForm,BoardCloseForm};\n" : ""),
									loader: "tsx",
									resolveDir: dirname(path),
								};
							});
						},
					},
				]
			: [],
	});
	server = createServer((req, res) => {
		res.setHeader("content-type", req.url === "/fixture.js" ? "text/javascript" : "text/html");
		res.end(
			req.url === "/fixture.js"
				? bundled.outputFiles[0].contents
				: '<!doctype html><html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
		);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	browser = await chromium.launch({
		executablePath: CHROME_PATH,
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
		env: { ...process.env, HOME: home },
	});
	const page = await browser.newPage();
	page.setDefaultTimeout(10_000);
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	const url = `http://127.0.0.1:${server.address().port}/`;
	const form = page.locator("form");
	const snap = () => page.evaluate(() => window.__board.snap());
	async function reset(kind = "post", mode = "pending") {
		await page.goto(url);
		await page.waitForFunction(() => !!window.__board);
		await page.evaluate(
			({ k, m }) => {
				window.__board.mode(m);
				if (k !== "post") window.__board.open(k);
			},
			{ k: kind, m: mode },
		);
	}
	async function fill(kind = "post") {
		if (kind === "close") {
			await form.locator('[name="note"]').fill(note);
			return;
		}
		await form.locator('[name="rv-bkind"][value="order"]').check();
		await form.locator('[name="rv-bto"]').nth(1).check();
		await form.locator('input[type="checkbox"][value="temper"]').check();
		await form.locator('input[type="checkbox"][value="ops"]').check();
		await form.locator('[name="rv-bto"]').nth(0).check();
		await form.locator('[name="title"]').fill(post.title);
		await form.locator('[name="text"]').fill(post.text);
	}
	const submit = () => form.locator('button[type="submit"]').click();
	const result = (patch = {}) => page.evaluate((p) => window.__board.result(p), patch);
	const settle = (value = true, reject = false) =>
		page.evaluate(({ v, r }) => window.__board.settle(v, r), { v: value, r: reject });
	async function retained(kind = "post", value = kind === "post" ? post.text : note) {
		assert.equal(await form.count(), 1, "same submitted/newer editor remains");
		assert.equal(await form.locator(`[name="${kind === "post" ? "text" : "note"}"]`).inputValue(), value);
	}
	async function originals(kind = "post") {
		const s = await snap();
		const a = s.recoveries.flatMap((r) => r.attempts);
		assert.equal(a.length, 1);
		assert.deepEqual(
			a[0].source.form,
			kind === "post" ? { type: "board_post", ...post } : { type: "board_close", id: "bp-fixture-A", note },
		);
		assert.ok(a[0].reqId);
		const submitted = s.recoveries.find((r) => r.current.editorId === a[0].source.editorId);
		assert.ok(submitted, "original attempt belongs to its actual editor, not a record's array position");
		if (s.calls.length) {
			assert.equal(a[0].reqId, s.calls[0].message.reqId);
			assert.deepEqual(a[0].source, s.calls[0].source);
		}
		return { ...s, submitted };
	}
	if (baseline) {
		for (const kind of ["post", "close"])
			await check(`genuine old ${kind}: editable newer draft lost on late actual success`, async () => {
				await reset(kind);
				await fill(kind);
				await submit();
				assert.equal((await snap()).calls.length, 0, "real original uses appSend");
				const field = form.locator(`[name="${kind === "post" ? "text" : "note"}"]`);
				await field.fill("newer B must not disappear");
				assert.equal(await field.inputValue(), "newer B must not disappear");
				await result();
				await page.waitForFunction(() => !document.querySelector("form"));
				let lost = false;
				try {
					await retained(kind, "newer B must not disappear");
				} catch (error) {
					if (!(error instanceof assert.AssertionError)) throw error;
					lost = true;
				}
				assert.equal(lost, true, "the identical full retention assertion must fail on original source");
				await page.evaluate((k) => window.__board.open(k), kind);
				assert.equal(
					await form.locator(`[name="${kind === "post" ? "text" : "note"}"]`).inputValue(),
					"",
					"newer authored value was actually discarded",
				);
			});
	} else {
		for (const kind of ["post", "close"]) {
			for (const mode of ["false", "unbound", "reject", "throw", "truthy"]) {
				await check(`${kind}: ${mode} admission retains full raw source and editor`, async () => {
					await reset(kind, mode);
					await fill(kind);
					await submit();
					await form.locator('[role="alert"]').waitFor();
					await retained(kind);
					const s = await originals(kind);
					assert.equal(s.done.length, 0);
					assert.equal(s.sent.length, 0, "no fallback or authority send");
				});
			}
			await check(`${kind}: admission true is not actual posted/closed result`, async () => {
				await reset(kind, "true");
				await fill(kind);
				await submit();
				await retained(kind);
				await originals(kind);
				assert.equal((await snap()).done.length, 0);
				await result();
				await page.waitForFunction(() => !document.querySelector("form"));
				assert.equal((await snap()).done.length, 1);
			});
			for (const accepted of [true, false])
				await check(
					`${kind}: early genuine result awaits ${accepted ? "successful" : "failed"} admission`,
					async () => {
						await reset(kind);
						await fill(kind);
						await submit();
						await result();
						await retained(kind);
						assert.equal((await snap()).done.length, 0);
						await settle(accepted);
						if (accepted) await page.waitForFunction(() => !document.querySelector("form"));
						else {
							await form.locator('[role="alert"]').waitFor();
							await retained(kind);
						}
					},
				);
			await check(`${kind}: early actual success cannot outrun a rejected admission`, async () => {
				await reset(kind);
				await fill(kind);
				await submit();
				await result();
				await settle(false, true);
				await form.locator('[role="alert"]').waitFor();
				await retained(kind);
				await originals(kind);
				assert.equal((await snap()).done.length, 0);
			});
			await check(`${kind}: real answer deadline retains newer draft and unknown warning`, async () => {
				await reset(kind, "true");
				await fill(kind);
				await submit();
				await form.locator(`[name="${kind === "post" ? "text" : "note"}"]`).fill("newer after timeout");
				await form.locator('[role="alert"]').waitFor({ timeout: 30_000 });
				assert.match(
					await form.locator('[role="alert"]').textContent(),
					/no answer from the server: look at the board before trying again/,
				);
				await result();
				await retained(kind, "newer after timeout");
				await originals(kind);
				assert.equal((await snap()).calls.length, 1);
				assert.equal((await snap()).done.length, 0);
			});
			for (const change of ["B", "ABA"])
				await check(`${kind}: ${change} edit survives matching actual success`, async () => {
					await reset(kind);
					await fill(kind);
					await submit();
					const field = form.locator(`[name="${kind === "post" ? "text" : "note"}"]`);
					await field.fill("B draft");
					if (change === "ABA") await field.fill(kind === "post" ? post.text : note);
					await settle();
					await result();
					await retained(kind, change === "B" ? "B draft" : kind === "post" ? post.text : note);
					const s = await originals(kind);
					assert.equal(s.done.length, 0);
					assert.ok(s.submitted.current.revision > s.submitted.attempts[0].source.revision);
				});
			await check(`${kind}: missing/wrong request and wrong operation cannot complete editor`, async () => {
				await reset(kind, "true");
				await fill(kind);
				await submit();
				for (const patch of [
					{ reqId: undefined },
					{ reqId: "stale-request" },
					{ op: kind === "post" ? "close" : "post" },
					{ id: "" },
					{ id: undefined },
				]) {
					await result(patch);
					await retained(kind);
				}
				if (kind === "close") {
					await result({ id: "bp-other" });
					await retained(kind);
				}
				await result();
				await page.waitForFunction(() => !document.querySelector("form"));
				const n = (await snap()).done.length;
				await result();
				assert.equal((await snap()).done.length, n, "duplicate result has no authority");
			});
			await check(`${kind}: duplicate native submissions dispatch once`, async () => {
				await reset(kind);
				await fill(kind);
				await form.evaluate((el) => {
					el.requestSubmit();
					el.requestSubmit();
				});
				assert.equal((await snap()).calls.length, 1);
				await originals(kind);
				await settle(false);
				await retained(kind);
			});
			await check(`${kind}: unmount/reopen invalidates old result without losing originals`, async () => {
				await reset(kind);
				await fill(kind);
				await submit();
				await page.evaluate((k) => {
					window.__board.unmount();
					window.__board.open(k);
				}, kind);
				await form.locator(`[name="${kind === "post" ? "text" : "note"}"]`).fill("reopened B");
				await settle();
				await result();
				await retained(kind, "reopened B");
				await originals(kind);
				assert.equal((await snap()).done.length, 0);
			});
			await check(`${kind}: genuine server failure retains draft; explicit retry is separate`, async () => {
				await reset(kind, "true");
				await fill(kind);
				await submit();
				await result({ ok: false, id: undefined, error: "synthetic authority refusal" });
				await form.locator('[role="alert"]').waitFor();
				await retained(kind);
				await originals(kind);
				assert.equal((await snap()).calls.length, 1);
				await submit();
				assert.equal((await snap()).calls.length, 2);
				await result();
				await page.waitForFunction(() => !document.querySelector("form"));
			});
		}
		await check("post: exact sorted target packet retains independent inactive/raw source", async () => {
			await reset("post", "false");
			await fill();
			await form.locator('[name="rv-bto"]').nth(1).check();
			await submit();
			await form.locator('[role="alert"]').waitFor();
			const s = await snap();
			assert.deepEqual(s.calls[0].message, {
				type: "board_post",
				kind: "order",
				to: ["ops", "temper"],
				title: post.title.trim(),
				text: post.text.trim(),
				reqId: s.calls[0].message.reqId,
			});
			assert.deepEqual(s.calls[0].source.form, { type: "board_post", ...post, toAll: false });
			assert.equal(await page.evaluate(() => Object.isFrozen(window.__board.snap().calls[0].message.to)), true);
		});
		await check("close: whitespace-only note remains source data and wire omits it", async () => {
			await reset("close", "false");
			await form.locator('[name="note"]').fill(" \t ");
			await submit();
			await form.locator('[role="alert"]').waitFor();
			const s = await snap();
			assert.equal(s.calls[0].source.form.note, " \t ");
			assert.equal(s.calls[0].message.note, undefined);
			assert.equal(s.done.length, 0);
		});
		await check("post: kind and inactive recipient ABA invalidate old close authority", async () => {
			await reset();
			await fill();
			await submit();
			await form.locator('[name="rv-bkind"][value="news"]').check();
			await form.locator('[name="rv-bkind"][value="order"]').check();
			await form.locator('[name="rv-bto"]').nth(1).check();
			await form.locator('input[type="checkbox"][value="qa"]').check();
			await form.locator('[name="rv-bto"]').nth(0).check();
			await settle();
			await result();
			await retained();
			await originals();
			const s = await snap();
			assert.deepEqual(s.recoveries[0].current.form.picked, ["temper", "ops", "qa"]);
			assert.equal(s.done.length, 0);
		});
		await check("close: target A-B-A cannot reuse old ownership", async () => {
			await reset("close");
			await fill("close");
			await submit();
			await page.evaluate(() => window.__board.target("bp-B"));
			await page.evaluate(() => window.__board.target("bp-fixture-A"));
			await form.locator('[name="note"]').fill("reopened target note");
			await settle();
			await result();
			await retained("close", "reopened target note");
			assert.equal((await snap()).done.length, 0);
			await originals("close");
		});
		for (const kind of ["post", "close"])
			await check(`${kind}: look-only restore retains full raw original with zero replay`, async () => {
				await reset(kind, "false");
				await fill(kind);
				await submit();
				await form.locator('[role="alert"]').waitFor();
				const source = (await originals(kind)).submitted.attempts[0].source;
				await reset(kind);
				assert.equal(await page.evaluate((s) => window.__board.restore(s), source), true);
				const s = await snap();
				assert.equal(s.calls.length, 0);
				assert.equal(s.sent.length, 0);
				assert.equal(s.done.length, 0);
				assert.deepEqual(s.recoveries.find((r) => r.current.editorId === source.editorId).restoredSources, [source]);
			});
	}
	assert.deepEqual(errors, [], "no native browser console/page exception");
	console.log(`${passed} ${baseline ? "genuine baseline loss controls" : "native Board cases"} passed`);
} finally {
	if (browser) await browser.close();
	if (server) await new Promise((resolve) => server.close(resolve));
	rmSync(home, { recursive: true, force: true });
}
