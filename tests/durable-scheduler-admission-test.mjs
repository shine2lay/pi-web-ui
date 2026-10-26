/* Native SchedulerPanel + #585 registry, isolated HTML only: no app/scheduler/model server.
 * Run: node tests/durable-scheduler-admission-test.mjs
 * Genuine old-component red controls: node tests/durable-scheduler-admission-test.mjs --baseline
 * The old-source bundle is loaded verbatim by git object id, not synthesized by breaking new code.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const BASE = "4f32b06e2d2f8dec63a4258ac6575ba2cbac7b92";
const baseline = process.argv.includes("--baseline");
const home = mkdtempSync(join(tmpdir(), "scheduler-admission-browser-"));
let server, browser;
let passed = 0;
const errors = [];
const harness = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { LanguageProvider } from './web/src/i18n';
import * as panel from './web/src/components/SchedulerPanel';
import { setAppAdmit } from './web/src/app-admit';
import { setAppSend } from './web/src/app-globals';
const calls = [], sent = [], confirmations = [];
let mode = 'false', pending, allowDelete = false;
const tasks = ['task-a', 'task-b'].map((id) => ({ id, name: 'Existing ' + id,
 description: 'Disk description', cwd: '/synthetic/task-cwd', kind: 'cron', spec: '0 9 * * *',
 prompt: 'Disk prompt', model: 'fixture/a', thinkingLevel: 'high', catchUp: 'once', enabled: false,
 conversationId: '', sessionFile: '', oneShot: false, createdAt: 1, updatedAt: 2, nextFire: null,
 lastRun: null, running: false, history: [{ at: 1, ok: true, durationMs: 100 }, { at: 2, ok: false, durationMs: 200 }] }));
let props = { cwd: '/synthetic/workspace-A', tasks, models: [
 { provider: 'fixture', id: 'a', label: 'Fixture A' }, { provider: 'fixture', id: 'b', label: 'Fixture B' }] };
setAppSend((message) => { sent.push(message); return false; });
setAppAdmit((message) => {
 const source = panel.getSchedulerAdmissionSource?.(message);
 calls.push({ message, source });
 if (mode === 'pending') return new Promise((resolve, reject) => { pending = { resolve, reject }; });
 if (mode === 'reject') return Promise.reject(new Error('synthetic refusal'));
 if (mode === 'committed') return Promise.reject(Object.assign(new Error('synthetic post-checkpoint failure'), { payloadCommitted: true }));
 if (mode === 'throw') throw new Error('synthetic synchronous failure');
 return Promise.resolve(mode === 'true' ? true : mode === 'truthy' ? { ok: true } : mode === 'undefined' ? undefined : false);
});
window.confirm = (text) => { confirmations.push(text); return allowDelete; };
const root = createRoot(document.getElementById('root'));
function render(next = {}) { props = { ...props, ...next }; flushSync(() => root.render(<LanguageProvider><panel.SchedulerPanel {...props} /></LanguageProvider>)); }
render();
window.__scheduler = {
 mode(value) { mode = value; },
 settle(value, reject = false) { if (!pending) throw new Error('expected deferred admission');
  const old = pending; pending = undefined; if (reject) old.reject(Object.assign(new Error('synthetic late failure'), { payloadCommitted: true })); else old.resolve(value); },
 render,
 restore(source) { return panel.restoreSchedulerDraft?.(source) ?? false; },
 unmount() { flushSync(() => root.render(null)); },
 allowDelete(value) { allowDelete = value; },
 running() { render({ tasks: props.tasks.map((task, index) => index === 0 ? { ...task, running: true } : task) }); },
 snap() { return { calls, sent, confirmations, recoveries: panel.getSchedulerDraftRecoveries?.() ?? [] }; }
};
`;
function form(id = "", patch = {}) {
	return {
		id,
		name: "  Task é 🌈  ",
		description: "  authored description\t ",
		cwd: " /synthetic/authored path/ ",
		kind: "cron",
		cron: " 7 8 * * 2 ",
		preset: "custom",
		intervalMinutes: "60",
		prompt: "  keep é 🌈\nsecond line\t  ",
		model: "fixture/b",
		thinkingLevel: "medium",
		catchUp: false,
		...patch,
	};
}
function taskFor(f) {
	return {
		...(f.id ? { id: f.id } : {}),
		name: f.name,
		description: f.description,
		cwd: f.cwd,
		kind: f.kind,
		spec: f.kind === "cron" ? f.cron : String(Math.max(1, Math.floor(Number(f.intervalMinutes) || 0)) * 60000),
		prompt: f.prompt,
		model: f.model,
		thinkingLevel: f.thinkingLevel,
		catchUp: f.catchUp ? "once" : "skip",
	};
}
async function check(name, action) {
	await action();
	passed++;
	console.log(`  ✓ ${name}`);
}

try {
	assert.ok(CHROME_PATH, "Install Chrome or set PI_WEB_CHROME; browser proof must not silently skip");
	const bundled = await build({
		stdin: { contents: harness, loader: "jsx", resolveDir: REPO, sourcefile: "scheduler-native-harness.jsx" },
		bundle: true,
		write: false,
		format: "esm",
		jsx: "automatic",
		logLevel: "silent",
		define: { "process.env.NODE_ENV": '"production"' },
		plugins: baseline
			? [
					{
						name: "genuine-old-component",
						setup(plugin) {
							plugin.onLoad({ filter: /\/web\/src\/components\/SchedulerPanel\.tsx$/ }, ({ path }) => ({
								contents: execFileSync("git", ["-C", REPO, "show", `${BASE}:web/src/components/SchedulerPanel.tsx`], {
									encoding: "utf8",
								}),
								loader: "tsx",
								resolveDir: dirname(path),
							}));
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
				: '<!doctype html><html><body><main id="root"></main><script type="module" src="/fixture.js"></script></body></html>',
		);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	assert.ok(server.address().port >= 8900);
	browser = await chromium.launch({
		executablePath: CHROME_PATH,
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
		env: { ...process.env, HOME: home },
	});
	const page = await browser.newPage();
	page.setDefaultTimeout(10_000);
	page.on("pageerror", (error) => errors.push(error.message));
	const url = `http://127.0.0.1:${server.address().port}/`;
	const modal = page.locator(".modal");
	const snap = () => page.evaluate(() => window.__scheduler.snap());
	async function reset(mode = "false") {
		await page.goto(url);
		await page.waitForFunction(() => !!window.__scheduler);
		await page.evaluate((v) => window.__scheduler.mode(v), mode);
	}
	async function open(id = "") {
		if (id)
			await page
				.locator(".scheduler-item")
				.nth(id === "task-a" ? 0 : 1)
				.locator('button[title="Edit"]')
				.click();
		else await page.locator(".set-section-title .set-save-btn").click();
		await modal.waitFor();
	}
	async function fill(f) {
		if (baseline) {
			const inputs = modal.locator("input.set-input");
			await inputs.nth(0).fill(f.name);
			await inputs.nth(1).fill(f.description);
			await inputs.nth(2).fill(f.cwd);
			await modal.locator("select").nth(0).selectOption(f.kind);
			await modal.locator("select").nth(1).selectOption("custom");
			await inputs.nth(3).fill(f.cron);
			await modal.locator("textarea").fill(f.prompt);
			await modal.locator("select").nth(2).selectOption(f.model);
			await modal.locator("select").nth(3).selectOption(f.thinkingLevel);
			await modal.locator('input[type="checkbox"]').setChecked(f.catchUp);
			return;
		}
		for (const key of ["name", "description", "cwd", "prompt"]) await modal.locator(`[name="${key}"]`).fill(f[key]);
		for (const key of ["kind", "model", "thinkingLevel"]) await modal.locator(`[name="${key}"]`).selectOption(f[key]);
		await modal.locator('[name="catchUp"]').setChecked(f.catchUp);
		if (f.kind === "cron") {
			await modal.locator('[name="preset"]').selectOption(f.preset);
			if (f.preset === "custom") await modal.locator('[name="cron"]').fill(f.cron);
		} else await modal.locator('[name="intervalMinutes"]').fill(f.intervalMinutes);
	}
	const submit = () => modal.locator(".scheduler-foot .primary").click();
	const close = () => modal.locator(".modal-close").click();
	async function values(f) {
		assert.equal(await modal.count(), 1, "complete authored form must remain open");
		for (const key of ["name", "description", "cwd", "prompt", "model", "thinkingLevel", "kind"])
			assert.equal(await modal.locator(`[name="${key}"]`).inputValue(), f[key], key);
		assert.equal(await modal.locator('[name="catchUp"]').isChecked(), f.catchUp);
		if (f.kind === "cron") {
			assert.equal(await modal.locator('[name="preset"]').inputValue(), f.preset);
			if (f.preset === "custom") assert.equal(await modal.locator('[name="cron"]').inputValue(), f.cron);
		} else assert.equal(await modal.locator('[name="intervalMinutes"]').inputValue(), f.intervalMinutes);
	}
	async function phase(value) {
		await page.waitForFunction((v) => !!document.querySelector(`[data-scheduler-admission="${v}"]`), value);
	}
	async function settle(value, reject = false) {
		await page.evaluate(({ v, r }) => window.__scheduler.settle(v, r), { v: value, r: reject });
		await phase(reject || value !== true ? "unconfirmed" : "admitted");
	}
	function captured(s, f) {
		assert.deepEqual(s.calls[0].message, { type: "schedule_save", task: taskFor(f) });
		assert.deepEqual(s.calls[0].source.form, f);
		assert.equal(s.calls[0].source.workspace, "/synthetic/workspace-A");
		assert.equal(s.calls[0].source.taskId, f.id || null);
		assert.equal(s.calls[0].message.task.enabled, undefined);
		assert.equal(s.calls[0].message.task.conversationId, undefined);
		assert.equal(s.calls[0].message.task.sessionFile, undefined);
	}

	if (baseline) {
		for (const id of ["", "task-a"])
			await check(`genuine old ${id || "new"} component drops complete draft on refused appSend`, async () => {
				await reset();
				await open(id);
				const f = form(id);
				await fill(f);
				await submit();
				const s = await snap();
				assert.equal(s.calls.length, 0);
				assert.equal(s.sent.filter((m) => m.type === "schedule_save").length, 1);
				assert.equal(await modal.count(), 0, "old source must actually close on refusal");
				let preservationFailed = false;
				try {
					assert.equal(await modal.count(), 1, "keep complete authored form on refusal");
				} catch (error) {
					if (!(error instanceof assert.AssertionError)) throw error;
					preservationFailed = true;
				}
				assert.equal(
					preservationFailed,
					true,
					"the same preservation condition must fail against the original component",
				);
				await open(id);
				assert.notEqual(
					await modal.locator("textarea").inputValue(),
					f.prompt,
					"reopen must demonstrate actual loss, not merely a hidden form",
				);
			});
	} else {
		for (const id of ["", "task-a"]) {
			for (const outcome of ["false", "truthy", "undefined", "reject", "committed", "throw"])
				await check(`${id || "new"}: exact complete fields/original retained after ${outcome}`, async () => {
					await reset(outcome);
					await open(id);
					const f = form(id);
					await fill(f);
					await submit();
					await phase("unconfirmed");
					await values(f);
					const s = await snap();
					captured(s, f);
					assert.deepEqual(s.recoveries[0].current, f);
					assert.deepEqual(s.recoveries[0].attempts[0].source.form, f);
					assert.deepEqual(
						s.sent.map((m) => m.type),
						["schedule_list"],
					);
					assert.match(await modal.locator('[role="status"]').innerText(), /not confirmed.*before saving again/s);
				});
			await check(
				`${id || "new"}: unchanged exact true closes only after local admission, never claims server success`,
				async () => {
					await reset("pending");
					await open(id);
					const f = form(id);
					await fill(f);
					await submit();
					await phase("pending");
					await values(f);
					await settle(true);
					assert.equal(await modal.count(), 0);
					const s = await snap();
					captured(s, f);
					assert.deepEqual(s.recoveries[0].current, f);
					assert.equal(s.recoveries[0].attempts[0].phase, "admitted");
					assert.match(
						await page.locator("[data-scheduler-recovery]").textContent(),
						/server save, enablement and execution are not confirmed/,
					);
					await open(id);
					await values(f);
					assert.equal((await snap()).calls.length, 1);
				},
			);
		}
		for (const kind of ["preset", "interval"])
			await check(`${kind}: explicit spec conversion, empty option values and catchUp once preserved`, async () => {
				await reset();
				await open("task-a");
				const f = form("task-a", {
					description: "",
					model: "",
					thinkingLevel: "",
					catchUp: true,
					...(kind === "preset"
						? { preset: "0 9 * * 1-5", cron: "0 9 * * 1-5" }
						: { kind: "interval", intervalMinutes: "2.9", preset: "0 9 * * *", cron: "0 9 * * *" }),
				});
				await fill(f);
				await submit();
				await phase("unconfirmed");
				await values(f);
				captured(await snap(), f);
			});
		for (const aba of [false, true])
			await check(`newer text/options ${aba ? "ABA" : "B"} cannot be cleared by late true`, async () => {
				await reset("pending");
				await open();
				const f = form();
				await fill(f);
				await submit();
				const newer = {
					...f,
					name: "Task B",
					prompt: "newer B\n  ",
					model: "fixture/a",
					thinkingLevel: "high",
					catchUp: true,
				};
				await fill(newer);
				if (aba) await fill(f);
				await settle(true);
				await values(aba ? f : newer);
				const s = await snap();
				captured(s, f);
				assert.deepEqual(s.recoveries[0].current, aba ? f : newer);
			});
		for (const result of [true, false, "reject"])
			await check(
				`close/reopen same task: late ${result} cannot close restored form or duplicate dispatch`,
				async () => {
					await reset("pending");
					await open("task-a");
					const f = form("task-a");
					await fill(f);
					await submit();
					await modal.locator(".scheduler-foot .primary").evaluate((b) => {
						b.click();
						b.click();
					});
					await close();
					await open("task-a");
					await values(f);
					assert.equal(await modal.locator(".scheduler-foot .primary").isDisabled(), true);
					await settle(result === "reject" ? false : result, result === "reject");
					await values(f);
					assert.equal((await snap()).calls.length, 1);
				},
			);
		for (const [first, next] of [
			["", "task-a"],
			["task-a", ""],
			["task-a", "task-b"],
		])
			await check(
				`switch ${first || "new"} -> ${next || "new"}: late completion leaves both complete drafts`,
				async () => {
					await reset("pending");
					await open(first);
					const f = form(first);
					await fill(f);
					await submit();
					await close();
					await open(next);
					const newer = form(next, { prompt: "Other task draft" });
					await fill(newer);
					await settle(true);
					await values(newer);
					const s = await snap();
					captured(s, f);
					assert.deepEqual(s.recoveries.find((r) => r.current.id === first).current, f);
				},
			);
		await check("workspace A-B-A and component navigation retain current/original without replay", async () => {
			await reset("pending");
			await open("task-a");
			const f = form("task-a");
			await fill(f);
			await submit();
			const newer = { ...f, prompt: "newer before navigation" };
			await fill(newer);
			await page.evaluate(() => window.__scheduler.render({ cwd: "/synthetic/workspace-B" }));
			assert.equal(await modal.count(), 0);
			await open();
			const b = form("", { prompt: "workspace B task" });
			await fill(b);
			await page.evaluate(() => {
				window.__scheduler.unmount();
				window.__scheduler.render({ cwd: "/synthetic/workspace-A" });
			});
			assert.equal(await modal.count(), 0);
			await open("task-a");
			await settle(true);
			await values(newer);
			const s = await snap();
			captured(s, f);
			assert.deepEqual(s.recoveries.find((r) => r.workspace === "/synthetic/workspace-A").current, newer);
			assert.deepEqual(s.recoveries.find((r) => r.workspace === "/synthetic/workspace-B").current, b);
			assert.deepEqual(
				s.sent.map((m) => m.type),
				["schedule_list", "schedule_list"],
			);
			assert.equal(s.calls.length, 1);
		});
		await check(
			"list/history/toggle/run/delete stay synchronous; delete confirm and running guard remain",
			async () => {
				await reset();
				const row = page.locator(".scheduler-item").first();
				await row.locator(".scheduler-link").click();
				assert.equal(await row.locator(".scheduler-history").count(), 1);
				await row.locator(".set-switch").click();
				await row.locator('button[title="Run now"]').click();
				await row.locator('button[title="Delete"]').click();
				let s = await snap();
				assert.deepEqual(
					s.sent.map((m) => m.type),
					["schedule_list", "schedule_toggle", "schedule_run"],
				);
				assert.equal(s.confirmations.length, 1);
				await page.evaluate(() => window.__scheduler.allowDelete(true));
				await row.locator('button[title="Delete"]').click();
				s = await snap();
				assert.equal(s.sent.at(-1).type, "schedule_delete");
				assert.equal(s.confirmations.length, 2);
				assert.equal(s.calls.length, 0);
				await page.evaluate(() => window.__scheduler.running());
				assert.equal(await row.locator('button[title="Run now"]').isDisabled(), true);
			},
		);
		for (const id of ["", "task-a"])
			await check(
				`fresh-page ${id || "new"} original restore is editable only on explicit review, no activation`,
				async () => {
					await reset();
					await open(id);
					const f = form(id);
					await fill(f);
					await submit();
					await phase("unconfirmed");
					const source = (await snap()).calls[0].source;
					// A fresh isolated page loses all module memory; the host supplies only
					// this known synthetic recovered source, not a scheduler/task mutation.
					await reset();
					assert.equal((await snap()).recoveries.length, 0);
					await page.evaluate(() => window.__scheduler.render({ tasks: [] }));
					assert.equal(await page.evaluate((s) => window.__scheduler.restore(s), source), true);
					assert.equal(await modal.count(), 0);
					const restored = await snap();
					assert.deepEqual(restored.recoveries[0].restoredSources, [source]);
					assert.deepEqual(restored.recoveries[0].current, f);
					assert.equal(restored.calls.length, 0);
					assert.deepEqual(
						restored.sent.map((m) => m.type),
						["schedule_list"],
					);
					await page.locator("[data-scheduler-recovery] > summary").click();
					await page.locator(`[data-scheduler-review="${id}"] > button`).click();
					await values(f);
					assert.match(await modal.textContent(), /No task was created, enabled or run/);
					assert.deepEqual((await snap()).sent, restored.sent);
					assert.equal((await snap()).calls.length, 0);
				},
			);
		await check("restored originals cannot overwrite newer edits, another task or source identity", async () => {
			await reset();
			await open();
			const newer = form("", { prompt: "newer current B" });
			await fill(newer);
			const source = {
				workspace: "/synthetic/workspace-A",
				taskId: null,
				formId: "synthetic-archived-form",
				revision: 7,
				form: form(),
			};
			assert.equal(await page.evaluate((s) => window.__scheduler.restore(s), source), true);
			assert.equal(await page.evaluate((s) => window.__scheduler.restore(s), source), true);
			await values(newer);
			const conflicting = { ...source, form: { ...source.form, prompt: "same identity, different bytes" } };
			assert.equal(await page.evaluate((s) => window.__scheduler.restore(s), conflicting), false);
			const other = { ...source, taskId: "task-a", formId: "other-form", form: form("task-a") };
			assert.equal(await page.evaluate((s) => window.__scheduler.restore(s), other), true);
			await values(newer);
			const s = await snap();
			assert.deepEqual(s.recoveries.find((r) => r.current.id === "").current, newer);
			assert.deepEqual(s.recoveries.find((r) => r.current.id === "").restoredSources, [source]);
			assert.deepEqual(s.recoveries.find((r) => r.current.id === "task-a").current, other.form);
			assert.equal(s.calls.length, 0);
			assert.deepEqual(
				s.sent.map((m) => m.type),
				["schedule_list"],
			);
		});
		await check("invalid/incomplete recovered sources are refused without mutation or dispatch", async () => {
			await reset();
			const source = {
				workspace: "/synthetic/workspace-A",
				taskId: null,
				formId: "synthetic-form",
				revision: 7,
				form: form(),
			};
			for (const invalid of [
				{ ...source, taskId: "mismatched" },
				{ ...source, revision: -1 },
				{ ...source, conversationId: "fabricated" },
				{ ...source, form: { ...source.form, catchUp: "once" } },
				{ ...source, form: { ...source.form, enabled: true } },
			])
				assert.equal(await page.evaluate((s) => window.__scheduler.restore(s), invalid), false);
			for (const key of Object.keys(source.form)) {
				const missing = { ...source.form };
				delete missing[key];
				assert.equal(await page.evaluate((s) => window.__scheduler.restore(s), { ...source, form: missing }), false);
			}
			const s = await snap();
			assert.deepEqual(s.recoveries, []);
			assert.equal(s.calls.length, 0);
			assert.deepEqual(
				s.sent.map((m) => m.type),
				["schedule_list"],
			);
		});
		await check("recovery display and reopen do not create, enable or run a task", async () => {
			await reset();
			await open();
			const f = form();
			await fill(f);
			await submit();
			await phase("unconfirmed");
			await close();
			const before = await snap();
			await page.locator("[data-scheduler-recovery] summary").click();
			await open();
			await values(f);
			const after = await snap();
			assert.deepEqual(after.calls, before.calls);
			assert.deepEqual(after.sent, before.sent);
		});
	}
	assert.deepEqual(errors, []);
	console.log(
		`PASS: ${passed} ${baseline ? "genuine original-component loss controls" : "native scheduler admission cases"}; no real scheduler/model/profile used`,
	);
} finally {
	await browser?.close();
	if (server) await new Promise((resolve) => server.close(resolve));
	rmSync(home, { recursive: true, force: true });
}
