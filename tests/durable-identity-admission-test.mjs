/* Isolated NATIVE IdentitiesSettings + real store + #585 registry, no app server/model/profile/data.
 * Run: node tests/durable-identity-admission-test.mjs
 * Old-code red control: node tests/durable-identity-admission-test.mjs --baseline
 * --baseline bundles exactly the two callers from #585's parent pin, in memory, and requires the
 * false-success and hash-remount tests to fail for those behaviors (not for missing new APIs).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const baseline = process.argv.includes("--baseline");
const BASE = "4f32b06e2d2f8dec63a4258ac6575ba2cbac7b92";
const CONFIG = '{"id":"fixture","fakeCredential":"NOT-A-REAL-SECRET","goals":[],"workMode":"request-only"}';
const browserHome = mkdtempSync(join(tmpdir(), "identity-admission-browser-"));
let browser;
let server;
let passed = 0;
const errors = [];
const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { LanguageProvider } from './web/src/i18n';
import { IdentitiesSettings } from './web/src/components/IdentitiesSettings';
import * as store from './web/src/identity-state';
import { setAppAdmit } from './web/src/app-admit';
import { setAppSend } from './web/src/app-globals';
const config = ${JSON.stringify(CONFIG)};
const actions = [];
let behavior = 'true', pending, genericCalls = 0, journalSentinelCalls = 0;
function reply(index = actions.length - 1, patch = {}) {
 const msg = actions[index];
 if (!msg) throw new Error('fixture expected a captured action');
 if (msg.type === 'identity_file_save') store.receiveIdentitySaved({ type: 'identity_file_saved', id: msg.id, file: msg.file,
  reqId: msg.reqId, ok: true, hash: 'persisted-' + index, ...patch });
 else store.receiveIdentityDraftDone({ type: 'identity_draft_done', id: msg.id, action: msg.type.slice('identity_draft_'.length),
  reqId: msg.reqId, ok: true, hash: 'persisted-' + index, ...patch });
}
function result(msg, generic) {
 actions.push({ ...msg });
 if (behavior === 'committed-then-failed') { reply(); throw new Error('synthetic failure after captured result'); }
 if (behavior === 'throw') throw new Error('synthetic handler failure');
 if (behavior === 'deferred' && generic) return new Promise((resolve, reject) => { pending = { resolve, reject }; });
 if (behavior === 'reject' && generic) return Promise.reject(new Error('synthetic rejected admission'));
 if (behavior === 'promise' && !generic) return Promise.resolve(true);
 return behavior === 'truthy' ? 1 : behavior !== 'false';
}
setAppAdmit((msg) => { genericCalls++; journalSentinelCalls++; return result(msg, true); });
setAppSend((msg) => {
 if (msg.type === 'identity_file_save' || ['identity_draft_save', 'identity_draft_accept', 'identity_draft_discard'].includes(msg.type))
  return result(msg, false);
 return true;
});
store.receiveIdentities({ type: 'identities', identities: ['fixture', 'other'].map((id) => ({ id, title: id,
 aboutSize: 6, notebookSize: 6, notebookCap: 6000, promptFile: 'prompt.md', promptSize: 6,
 skills: [], ownSkills: 0, toolLimits: 'none', configProblems: [], rules: { workMode: 'request-only', goals: [] },
 draft: { aboutSize: 6, promptSize: 6, fields: [] } })), problems: [] });
const root = createRoot(document.getElementById('root'));
flushSync(() => root.render(<LanguageProvider><IdentitiesSettings sessions={[]} onOpenChat={() => {}} /></LanguageProvider>));
window.__identity = {
 behavior(value) { behavior = value; },
 settle(value) { if (!pending) throw new Error('no deferred admission'); pending.resolve(value); pending = undefined; },
 reject() { if (!pending) throw new Error('no deferred admission'); pending.reject(new Error('synthetic rejection')); pending = undefined; },
 load(file = 'about', id = 'fixture') { store.receiveIdentityFile({ type: 'identity_file', id, file,
  text: file === 'config' ? config : 'disk-0', hash: 'base-' + file }); },
 loadDraft(id = 'fixture') { store.receiveIdentityDraft({ type: 'identity_draft', id, hash: 'draft-0',
  about: 'about-0', currentAbout: 'before', prompt: 'prompt-0', config }); },
 reply,
 directFileSave(text) { return store.saveOpenIdentityFile(text); },
 snap() { return { file: store.getIdentityFile(), draft: store.getIdentityDraft(), actions,
  genericCalls, journalSentinelCalls }; }
};
`;

async function check(name, action) {
	await action();
	passed++;
	console.log(`  ✓ ${name}`);
}
async function expectedOldFailure(name, action) {
	let failed = false;
	try {
		await action();
	} catch (error) {
		if (!(error instanceof assert.AssertionError)) throw error;
		failed = true;
	}
	assert.equal(failed, true, `old-code control must fail: ${name}`);
	passed++;
	console.log(`  ✓ old-code red control: ${name}`);
}

try {
	const bundled = await build({
		stdin: { contents: harness, loader: "jsx", resolveDir: REPO, sourcefile: "identity-native-harness.jsx" },
		bundle: true,
		write: false,
		format: "esm",
		jsx: "automatic",
		define: { "process.env.NODE_ENV": '"production"' },
		plugins: baseline
			? [
					{
						name: "old-callers-only",
						setup(plugin) {
							plugin.onLoad(
								{ filter: /\/web\/src\/(identity-state\.ts|components\/IdentitiesSettings\.tsx)$/ },
								({ path }) => ({
									contents: execFileSync("git", ["-C", REPO, "show", `${BASE}:${path.slice(REPO.length)}`], {
										encoding: "utf8",
									}),
									loader: path.endsWith("tsx") ? "tsx" : "ts",
									resolveDir: join(path, ".."),
								}),
							);
						},
					},
				]
			: [],
	});
	const code = bundled.outputFiles[0].contents;
	server = createServer((req, res) => {
		if (req.url === "/harness.js") {
			res.setHeader("content-type", "text/javascript");
			res.end(code);
		} else {
			res.setHeader("content-type", "text/html");
			res.end(
				'<!doctype html><html><body><main id="root"></main><script type="module" src="/harness.js"></script></body></html>',
			);
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	browser = await chromium.launch({
		executablePath: CHROME_PATH,
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
		env: { ...process.env, HOME: browserHome },
	});
	const page = await browser.newPage();
	page.setDefaultTimeout(10_000);
	page.on("pageerror", (error) => errors.push(error.message));
	const url = `http://127.0.0.1:${server.address().port}/`;
	const row = page.locator('[data-identity="fixture"].identity-row');
	const fileInput = row.locator("textarea.identity-editor-text");
	const snap = () => page.evaluate(() => window.__identity.snap());
	async function reset() {
		await page.goto(url);
		await page.waitForFunction(() => !!window.__identity);
	}
	async function behavior(value) {
		await page.evaluate((v) => window.__identity.behavior(v), value);
	}
	async function openFile(name = "about") {
		await row.locator(`.identity-open-btn[data-file="${name}"]`).click();
		await page.evaluate((f) => window.__identity.load(f), name);
		await fileInput.waitFor();
	}
	async function openDraft() {
		await row.locator(".identity-draft-btn").click();
		await page.evaluate(() => window.__identity.loadDraft());
		await row.locator(".identity-draft-prompt").waitFor();
	}
	async function ack(index = 0, patch = {}) {
		await page.evaluate(({ i, p }) => window.__identity.reply(i, p), { i: index, p: patch });
	}
	async function fileText(text) {
		await page.waitForFunction(
			(value) =>
				document.querySelector('.identity-row[data-identity="fixture"] textarea.identity-editor-text')?.value === value,
			text,
		);
	}

	if (baseline) {
		await check("baseline is the actual old caller, not absent-API stubs", async () => {
			await reset();
			await openFile();
			assert.equal(await page.evaluate(() => typeof window.__identity.directFileSave), "function");
		});
		await expectedOldFailure("store reports true despite refused appSend", async () => {
			await behavior("false");
			assert.equal(await page.evaluate(() => window.__identity.directFileSave("A")), false);
		});
		await expectedOldFailure("A's hash ACK remounts the textarea and loses newer B", async () => {
			await reset();
			await openFile();
			await fileInput.fill("A");
			await row.locator(".identity-save").click();
			await fileInput.fill("B");
			await ack();
			await page.waitForFunction(() => window.__identity.snap().file?.saving === false);
			assert.equal(await fileInput.inputValue(), "B");
		});
	} else {
		for (const name of ["about", "notebook", "prompt"])
			await check(`${name}: deferred admission, duplicate guard, stable DOM and A baseline/B draft`, async () => {
				await reset();
				await openFile(name);
				await behavior("deferred");
				await fileInput.fill("A");
				await page.evaluate(() => {
					window.__originalNode = document.querySelector("textarea.identity-editor-text");
					const button = document.querySelector(".identity-save");
					button.click();
					button.click();
				});
				assert.equal((await snap()).actions.length, 1);
				assert.equal((await snap()).genericCalls, 1);
				await fileInput.fill("B");
				await ack();
				assert.equal((await snap()).file.text, "disk-0");
				await page.evaluate(() => window.__identity.settle(true));
				await fileText("B");
				await page.waitForFunction(() => window.__identity.snap().file?.saving === false);
				assert.equal((await snap()).file.text, "A");
				assert.equal(
					await page.evaluate(() => window.__originalNode === document.querySelector("textarea.identity-editor-text")),
					true,
				);
				assert.match(await row.locator('[role="status"]').innerText(), /unsaved/i);
			});

		for (const outcome of ["false", "reject", "throw", "truthy", "committed-then-failed"])
			await check(`native file: ${outcome} keeps complete authored text without fallback`, async () => {
				await reset();
				await openFile();
				await behavior(outcome);
				await fileInput.fill("A\ncomplete original\n");
				await row.locator(".identity-save").click();
				await page.waitForFunction(() => window.__identity.snap().file?.saving === false);
				assert.equal(await fileInput.inputValue(), "A\ncomplete original\n");
				assert.equal((await snap()).file.saved.ok, false);
				assert.equal((await snap()).file.text, "disk-0");
				assert.equal((await snap()).actions.length, 1);
				assert.equal((await snap()).genericCalls, 1);
				await row.locator(".identity-close").click();
				await openFile();
				assert.equal(await fileInput.inputValue(), "A\ncomplete original\n");
			});

		await check("old/no-echo success/error and same-file reopen never clear the current native editor", async () => {
			await reset();
			await openFile();
			await fileInput.fill("A");
			await row.locator(".identity-save").click();
			await fileInput.fill("B");
			for (const ok of [true, false]) {
				await ack(0, { ok, reqId: undefined });
				await ack(0, { ok, reqId: "stale" });
			}
			assert.equal((await snap()).file.saving, true);
			assert.equal(await fileInput.inputValue(), "B");
			await row.locator(".identity-close").click();
			await openFile();
			await fileInput.fill("C-reopened");
			await row.locator(".identity-save").click();
			await ack(0);
			assert.equal((await snap()).file.saving, true);
			assert.equal(await fileInput.inputValue(), "C-reopened");
			await ack(1);
			assert.equal((await snap()).file.text, "C-reopened");
		});

		await check("native A→B→A retains revision and DOM rather than hash remount", async () => {
			await reset();
			await openFile();
			await fileInput.fill("A");
			await row.locator(".identity-save").click();
			await page.evaluate(() => {
				window.__originalNode = document.querySelector("textarea.identity-editor-text");
			});
			await fileInput.fill("B");
			await fileInput.fill("A");
			await ack();
			assert.equal((await snap()).file.editText, "A");
			assert.equal((await snap()).file.revision, 3);
			assert.equal(
				await page.evaluate(() => window.__originalNode === document.querySelector("textarea.identity-editor-text")),
				true,
			);
			assert.match(await row.locator('[role="status"]').innerText(), /unsaved/i);
		});

		for (const outcome of ["false", "throw", "promise", "committed-then-failed"])
			await check(`native raw config ${outcome}: zero generic/journal boundary calls`, async () => {
				await reset();
				await openFile("config");
				await behavior(outcome);
				await fileInput.fill(`${CONFIG}\n `);
				await row.locator(".identity-save").click();
				await page.waitForFunction(() => window.__identity.snap().file?.saving === false);
				assert.equal(await fileInput.inputValue(), `${CONFIG}\n `);
				assert.equal((await snap()).genericCalls, 0);
				assert.equal((await snap()).journalSentinelCalls, 0);
				assert.equal((await snap()).file.saved.ok, false);
			});

		await check(
			"native OwnerFieldsEditor retains full options/inactive goals on refusal and newer B on A ACK",
			async () => {
				await reset();
				await row.locator(".identity-owner-change").click();
				await page.evaluate(() => window.__identity.load("config"));
				const form = row.locator(".identity-owner-form");
				await form.locator('input[value="self-start"]').check();
				await form.locator(".identity-owner-add").click();
				const inputs = form.locator(".identity-owner-goal input");
				for (const [index, value] of ["goal-A", "scope-A", "2026-10-26", "2026-12-31"].entries())
					await inputs.nth(index).fill(value);
				await behavior("false");
				await form.locator(".identity-save").click();
				assert.equal(await inputs.nth(0).inputValue(), "goal-A");
				assert.equal((await snap()).file.ownerForm.goals[0].endsAt, "2026-12-31");
				await behavior("true");
				await form.locator(".identity-save").click();
				await inputs.nth(0).fill("goal-B");
				await ack(1);
				assert.equal(await inputs.nth(0).inputValue(), "goal-B");
				assert.match((await snap()).file.text, /goal-A/);
				assert.equal((await snap()).genericCalls, 0);
				assert.equal((await snap()).journalSentinelCalls, 0);
				await form.locator('input[name$="-goals"]').first().check();
				await form.locator(".identity-close").click();
				await row.locator(".identity-owner-change").click();
				await page.evaluate(() => window.__identity.load("config"));
				assert.equal((await snap()).file.ownerForm.ownGoals, false);
				await form.locator('input[name$="-goals"]').nth(1).check();
				assert.equal(await inputs.nth(0).inputValue(), "goal-B");
			},
		);

		for (const action of ["save", "accept", "discard"]) {
			await check(`native draft ${action}: retains B on A ACK, no authority/generic fallback`, async () => {
				await reset();
				await openDraft();
				const about = row.locator(".identity-draft-about");
				const prompt = row.locator(".identity-draft-prompt");
				const config = row.locator(".identity-draft-config");
				await about.fill("about-A");
				await prompt.fill("prompt-A");
				await config.fill(`${CONFIG} `);
				await row.locator(`.identity-draft-${action}`).click();
				await about.fill("about-B");
				await prompt.fill("prompt-B");
				await config.fill(`${CONFIG}\nB`);
				for (const ok of [true, false]) await ack(0, { ok, reqId: undefined });
				assert.equal((await snap()).draft.busy, action);
				await ack();
				assert.equal(await about.inputValue(), "about-B");
				assert.equal(await prompt.inputValue(), "prompt-B");
				assert.equal(await config.inputValue(), `${CONFIG}\nB`);
				assert.equal((await snap()).genericCalls, 0);
				assert.equal((await snap()).journalSentinelCalls, 0);
				if (action === "save") assert.equal((await snap()).draft.prompt, "prompt-A");
				assert.match(await row.locator(".identity-draft-note").innerText(), /unsaved/i);
			});
			for (const outcome of ["false", "throw", "committed-then-failed"])
				await check(`native draft ${action}/${outcome} preserves all complete form fields`, async () => {
					await reset();
					await openDraft();
					await behavior(outcome);
					await row.locator(".identity-draft-about").fill("about-authored");
					await row.locator(".identity-draft-prompt").fill("prompt-authored");
					await row.locator(".identity-draft-config").fill(`${CONFIG} `);
					await row.locator(`.identity-draft-${action}`).click();
					assert.equal((await snap()).draft.done.ok, false);
					assert.equal(await row.locator(".identity-draft-config").inputValue(), `${CONFIG} `);
					await row.locator(".identity-close").click();
					await openDraft();
					assert.equal(await row.locator(".identity-draft-about").inputValue(), "about-authored");
					assert.equal(await row.locator(".identity-draft-prompt").inputValue(), "prompt-authored");
					assert.equal((await snap()).genericCalls, 0);
					assert.equal((await snap()).journalSentinelCalls, 0);
				});
		}
	}
	assert.deepEqual(errors, [], "no browser exceptions");
	console.log(
		`PASS: ${passed} ${baseline ? "old-code controls" : "native editor cases"}; no app server, real identity writes, model, or user browser profile`,
	);
} finally {
	await browser?.close();
	if (server) await new Promise((resolve) => server.close(resolve));
	rmSync(browserHome, { recursive: true, force: true });
}
