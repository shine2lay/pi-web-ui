#!/usr/bin/env node
/** Synthetic native-browser caller proof. No app/server/model or real filesystem operations. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPONENT = path.join(ROOT, "web/src/components/FilePreview.tsx");
const BASELINE = "4f32b06e2d2f8dec63a4258ac6575ba2cbac7b92";
const BASELINE_BLOB = "7d9eb253c8a0687b3f995e9f76add37e80393562";
const oldSource = execFileSync("git", ["show", `${BASELINE}:web/src/components/FilePreview.tsx`], { cwd: ROOT });
assert.equal(createHash("sha1").update(`blob ${oldSource.length}\0`).update(oldSource).digest("hex"), BASELINE_BLOB);
const ORIGINAL = "  original α\nlast line\n";
const A = "  submitted A 😀\nwhole body\n";
const B = "  later B\nnot submitted\n";
const BINDING = { resourceId: "resolved-1", workspaceId: "workspace-1", sessionId: "session-1", openId: "open-1" };
const source = await readFile(COMPONENT, "utf8");

async function bundle(componentSource) {
	const result = await build({
		stdin: {
			resolveDir: ROOT,
			loader: "tsx",
			contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { FilePreview } from ${JSON.stringify(COMPONENT)};
import { setAppSend } from ${JSON.stringify(path.join(ROOT, "web/src/app-globals.ts"))};
let root, props, sent = [], transport = "true", closes = 0, attachments = [];
const render = () => flushSync(() => root.render(React.createElement(FilePreview, props)));
window.fixture = {
 mount(options = {}) {
  if (root) flushSync(() => root.unmount());
  sent = []; closes = 0; attachments = []; transport = "true";
  setAppSend(message => {
   sent.push(structuredClone(message));
   if (message.type !== "write_file") return true;
   if (transport === "throw") throw new Error("synthetic transport failure");
   return transport !== "false";
  });
  props = { file: { path: "notes.txt", name: "notes.txt" }, content: null,
   binding: ${JSON.stringify(BINDING)}, onClose: () => { closes++; },
   onAddLines: (...args) => attachments.push(args), onAttach: (...args) => attachments.push(args), ...options };
  root = createRoot(document.getElementById("root")); render();
 },
 update(partial) { props = { ...props, ...partial }; render(); },
 unmount() { flushSync(() => root.unmount()); root = null; },
 requests: () => structuredClone(sent),
 transport: mode => { transport = mode; },
 closes: () => closes,
 attachments: () => structuredClone(attachments),
};`,
		},
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		target: "es2022",
		jsx: "automatic",
		define: { "process.env.NODE_ENV": '"development"' },
		plugins: [
			{
				name: "only-peripheral-stubs-and-exact-component-source",
				setup(builder) {
					builder.onLoad({ filter: /[/\\]components[/\\]FilePreview\.tsx$/ }, () => ({
						contents: componentSource,
						loader: "tsx",
						resolveDir: path.dirname(COMPONENT),
					}));
					builder.onResolve({ filter: /^\.\.\/(use-chat|i18n)$/ }, ({ path: module }) => ({
						path: module,
						namespace: "peripheral",
					}));
					builder.onResolve({ filter: /^\.\/Markdown$/ }, () => ({ path: "Markdown", namespace: "peripheral" }));
					builder.onLoad({ filter: /.*/, namespace: "peripheral" }, ({ path: module }) => ({
						contents:
							module === "../use-chat"
								? 'export const getClientId = () => "synthetic-client";'
								: module === "../i18n"
									? "export const useT = () => key => key;"
									: "export const Markdown = ({text}) => text;",
					}));
				},
			},
		],
	});
	return result.outputFiles[0].text;
}
function body(text = ORIGINAL, filePath = "notes.txt") {
	return {
		path: filePath,
		name: filePath,
		text,
		binary: false,
		truncated: false,
		kind: "text",
		lines: 2,
		size: Buffer.byteLength(text),
	};
}
function reply(request, text = request.text ?? ORIGINAL) {
	const { reqId, purpose, lifetime, revision } = request;
	return {
		...body(text, request.path),
		reqId,
		purpose,
		lifetime,
		revision,
		// Fixed synthetic server resolution, never inferred by the component.
		binding: request.binding
			? { ...request.binding, resourceId: request.binding.resourceId ?? "resolved-1" }
			: undefined,
		writeSucceeded: request.type === "write_file",
		complete: true,
	};
}

const [currentBundle, oldBundle] = await Promise.all([bundle(source), bundle(oldSource.toString("utf8"))]);
assert.ok(CHROME_PATH, "Install/configure isolated test Chromium with PI_WEB_CHROME; never use a live profile");
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
const results = [];
async function run(name, action, code = currentBundle) {
	const context = await browser.newContext();
	const page = await context.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("dialog", (dialog) => dialog.accept());
	// Every URL is intercepted. This browser can neither read real app state nor write files.
	await page.route("**/*", (route) =>
		route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div>' }),
	);
	await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
	await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
	await page.goto("https://durable-file-preview.invalid/");
	await page.addScriptTag({ content: code });
	const requests = () => page.evaluate(() => window.fixture.requests());
	const update = (partial) => page.evaluate((value) => window.fixture.update(value), partial);
	const mount = async (props = {}) => {
		await page.evaluate((options) => window.fixture.mount(options), props);
		await page.waitForFunction(() => window.fixture.requests().length > 0);
	};
	const deliver = (content) => update({ content });
	const load = async (text = ORIGINAL) => deliver(reply((await requests()).at(-1), text));
	const edit = async (text = A) => {
		await page.locator(".fp-attach.edit").click();
		await page.locator(".fp-editor").fill(text);
	};
	const save = async () => {
		await page.locator(".fp-editor").press("Control+s");
		return (await requests()).filter((r) => r.type === "write_file").at(-1);
	};
	const draft = async (text = B) => {
		assert.equal(await page.locator(".fp-editor").inputValue(), text, `${name}: full draft`);
		assert.equal(await page.locator(".fp-path").textContent(), "notes.txt", `${name}: path`);
	};
	const baseline = async (text) => {
		await page.locator(".fp-actions .btn:not(.primary)").click();
		assert.equal(await page.locator(".fp-editor").count(), 0);
		await page.locator(".fp-attach.edit").click();
		await draft(text);
	};
	try {
		await mount();
		await action({ page, requests, update, mount, deliver, load, edit, save, draft, baseline });
		assert.deepEqual(errors, [], `${name}: uncaught browser errors`);
		results.push(name);
		console.log(`PASS ${name}`);
	} finally {
		await context.close();
	}
}

try {
	const sameNativeLossScenario = async (c, old) => {
		await c.load();
		await c.edit();
		const write = await c.save();
		assert.equal(write.text, A);
		assert.equal(write.path, "notes.txt");
		await c.page.locator(".fp-editor").fill(B);
		await c.deliver(body("old same-path read\n"));
		if (old) {
			assert.equal(await c.page.locator(".fp-editor").count(), 0, "genuine old component must prematurely close");
			await c.page.locator(".fp-attach.edit").click();
			await c.draft("old same-path read\n");
		} else {
			await c.draft();
			await c.baseline(ORIGINAL);
		}
	};
	await run(
		"old-source control genuinely loses B on same-path read",
		(c) => sameNativeLossScenario(c, true),
		oldBundle,
	);
	await run("identical native scenario retains B and original baseline", (c) => sameNativeLossScenario(c, false));

	await run("initial reads require their own original binding and purpose", async (c) => {
		const read = (await c.requests())[0];
		for (const content of [body(), { ...reply(read), purpose: "write", writeSucceeded: true, complete: true }]) {
			await c.deliver(content);
			assert.equal(await c.page.locator(".fp-attach.edit").count(), 0);
		}
		await c.load();
		await c.edit();
		await c.deliver(reply(read, "stale initial read\n"));
		await c.draft(A);
		await c.baseline(ORIGINAL);
	});

	const corruptions = [
		["missing request", (c) => ({ ...c, reqId: undefined })],
		["wrong request", (c) => ({ ...c, reqId: "other" })],
		["read instead of write", (c) => ({ ...c, purpose: "read" })],
		["no target binding", (c) => ({ ...c, binding: undefined })],
		...["resourceId", "workspaceId", "sessionId", "openId"].map((field) => [
			`wrong ${field}`,
			(c) => ({ ...c, binding: { ...BINDING, [field]: "other" } }),
		]),
		...["lifetime", "revision"].map((field) => [
			`wrong ${field}`,
			(c) => ({ ...c, [field]: field === "revision" ? 99 : "old" }),
		]),
		["write error", (c) => ({ ...c, writeSucceeded: false })],
		["missing write success", (c) => ({ ...c, writeSucceeded: undefined })],
		["incomplete", (c) => ({ ...c, complete: false })],
		["missing complete flag", (c) => ({ ...c, complete: undefined })],
		["wrong path", (c) => ({ ...c, path: "other.txt" })],
		["nontext", (c) => ({ ...c, kind: "none" })],
		["truncated", (c) => ({ ...c, truncated: true })],
		["binary", (c) => ({ ...c, binary: true })],
		["partial body", (c) => ({ ...c, text: c.text.slice(1) })],
	];
	for (const [name, corrupt] of corruptions) {
		await run(`${name} cannot close, replace or confirm`, async (c) => {
			await c.load();
			await c.edit();
			const write = await c.save();
			await c.page.locator(".fp-editor").fill(B);
			await c.deliver(corrupt(reply(write)));
			await c.draft();
			assert.equal(await c.page.locator(".fp-actions .primary").isDisabled(), true);
			await c.page.clock.runFor(5000);
			await c.draft();
			assert.equal(await c.page.locator('[role="alert"]').textContent(), "saveResultUnknown");
			assert.equal((await c.requests()).filter((r) => r.type === "write_file").length, 1);
			await c.baseline(ORIGINAL);
		});
	}

	for (const hasSession of [true, false]) {
		await run(`authorized resource bootstrap; native session present=${hasSession}`, async (c) => {
			const initial = {
				workspaceId: BINDING.workspaceId,
				openId: "bootstrap-open",
				...(hasSession ? { sessionId: BINDING.sessionId } : {}),
			};
			await c.mount({ binding: initial });
			assert.equal((await c.requests())[0].binding.resourceId, undefined);
			await c.load();
			await c.edit();
			const write = await c.save();
			assert.deepEqual(write.binding, { ...initial, resourceId: "resolved-1" });
			await c.deliver(reply(write));
			assert.equal(await c.page.locator(".fp-editor").count(), 0);
		});
	}
	await run("missing context is preview-only, no fabricated write authority", async (c) => {
		await c.mount({ binding: undefined });
		await c.deliver(body());
		assert.equal(await c.page.locator(".fp-attach.edit").isDisabled(), true);
		assert.equal(await c.page.locator(".fp-editor").count(), 0);
		assert.equal((await c.requests()).filter((r) => r.type === "write_file").length, 0);
	});
	for (const field of ["resource", "complete"]) {
		await run(`initial read missing ${field} remains preview-only`, async (c) => {
			await c.mount({ binding: { workspaceId: BINDING.workspaceId, openId: "bootstrap-open" } });
			const content = reply((await c.requests())[0]);
			if (field === "resource") content.binding.resourceId = undefined;
			else content.complete = false;
			await c.deliver(content);
			assert.equal(await c.page.locator(".fp-attach.edit").isDisabled(), true);
			assert.equal((await c.requests()).filter((r) => r.type === "write_file").length, 0);
		});
	}

	for (const mode of ["false", "throw"]) {
		await run(`transport ${mode} retains originals without retry`, async (c) => {
			await c.load();
			await c.edit();
			await c.page.evaluate((value) => window.fixture.transport(value), mode);
			const write = await c.save();
			assert.equal(write.text, A);
			await c.draft(A);
			await c.page.locator(".fp-editor").fill(B);
			await c.draft();
			assert.equal(await c.page.locator('[role="alert"]').textContent(), "saveResultUnknown");
			await c.baseline(ORIGINAL);
		});
		await run(`transport ${mode} retains the submitted original for a qualified late result`, async (c) => {
			await c.load();
			await c.edit();
			await c.page.evaluate((value) => window.fixture.transport(value), mode);
			const write = await c.save();
			await c.page.locator(".fp-editor").fill(B);
			await c.deliver(reply(write));
			await c.draft();
			assert.equal(await c.page.locator('[role="alert"]').count(), 0);
			await c.baseline(A);
		});
	}

	await run("exact unchanged save closes; duplicate cannot affect re-entered editor", async (c) => {
		await c.load();
		await c.edit();
		const write = await c.save();
		await c.save();
		assert.equal((await c.requests()).filter((r) => r.type === "write_file").length, 1);
		await c.deliver(reply(write));
		assert.equal(await c.page.locator(".fp-editor").count(), 0);
		await c.edit(B);
		await c.deliver(reply(write));
		await c.draft();
		await c.baseline(A);
	});

	for (const last of [B, A]) {
		await run(
			`qualified save only advances baseline; newer revision survives (${last === A ? "text ABA" : "B"})`,
			async (c) => {
				await c.load();
				await c.edit();
				const write = await c.save();
				await c.page.locator(".fp-editor").fill(B);
				if (last === A) await c.page.locator(".fp-editor").fill(A);
				await c.deliver(reply(write));
				await c.draft(last);
				await c.baseline(A);
			},
		);
	}

	for (const last of [A, B]) {
		await run(`timeout followed by its own qualified result: ${last === A ? "unchanged" : "newer B"}`, async (c) => {
			await c.load();
			await c.edit();
			const write = await c.save();
			await c.page.clock.runFor(5000);
			await c.draft(A);
			assert.equal(await c.page.locator('[role="alert"]').textContent(), "saveResultUnknown");
			assert.equal((await c.requests()).filter((r) => r.type === "write_file").length, 1);
			if (last === B) await c.page.locator(".fp-editor").fill(B);
			await c.deliver(reply(write));
			if (last === A) {
				assert.equal(await c.page.locator(".fp-editor").count(), 0);
				await c.page.locator(".fp-attach.edit").click();
				await c.draft(A);
			} else {
				await c.draft();
				await c.baseline(A);
			}
		});
	}

	for (const order of ["older-first", "newer-first"]) {
		await run(`timeout and manual concurrent writes: ${order}`, async (c) => {
			await c.load();
			await c.edit();
			const first = await c.save();
			await c.page.clock.runFor(5000);
			await c.draft(A);
			assert.equal(await c.page.locator('[role="alert"]').textContent(), "saveResultUnknown");
			await c.page.locator(".fp-editor").fill(B);
			const second = await c.save();
			assert.notEqual(first.reqId, second.reqId);
			if (order === "older-first") {
				await c.deliver(reply(first));
				await c.draft();
				assert.equal(await c.page.locator(".fp-actions .primary").isDisabled(), true);
				await c.deliver(reply(second));
			} else {
				await c.deliver(reply(second));
				await c.deliver(reply(first));
			}
			assert.equal(await c.page.locator(".fp-editor").count(), 0);
			await c.page.locator(".fp-attach.edit").click();
			await c.draft();
		});
	}

	for (const field of ["path", "resourceId", "workspaceId", "sessionId", "openId", "unmount"]) {
		await run(`${field} ABA isolates old request and current draft`, async (c) => {
			await c.load();
			await c.edit();
			const oldRead = (await c.requests())[0];
			const write = await c.save();
			if (field === "unmount") {
				await c.page.evaluate(() => window.fixture.unmount());
				await c.mount();
			} else if (field === "path") {
				await c.update({ file: { path: "other.txt", name: "other.txt" }, content: null });
				await c.update({ file: { path: "notes.txt", name: "notes.txt" } });
			} else {
				await c.update({ binding: { ...BINDING, [field]: "other" }, content: null });
				await c.update({ binding: { ...BINDING } });
			}
			const read = (await c.requests()).at(-1);
			assert.notEqual(read.lifetime, oldRead.lifetime);
			await c.deliver(reply(oldRead));
			assert.equal(await c.page.locator(".fp-attach.edit").count(), 0);
			await c.deliver(reply(write));
			assert.equal(await c.page.locator(".fp-attach.edit").count(), 0);
			await c.deliver(reply(read, "new baseline\n"));
			await c.edit(B);
			await c.deliver(reply(write));
			await c.draft();
			await c.baseline("new baseline\n");
		});
	}

	await run("native close and same-file reopen reject old read/write completions", async (c) => {
		await c.load();
		await c.edit();
		const oldRead = (await c.requests())[0];
		const write = await c.save();
		await c.page.locator(".fp-close").click();
		assert.equal(await c.page.evaluate(() => window.fixture.closes()), 1);
		await c.mount({ binding: { ...BINDING, openId: "same-file-reopened" } });
		const read = (await c.requests())[0];
		await c.deliver(reply(oldRead));
		await c.deliver(reply(write));
		assert.equal(await c.page.locator(".fp-attach.edit").count(), 0);
		await c.deliver(reply(read));
		await c.edit(B);
		await c.deliver(reply(write));
		await c.draft();
		await c.baseline(ORIGINAL);
	});

	await run("cancel and same-file re-edit never reuses editor ownership", async (c) => {
		await c.load();
		await c.edit();
		const first = await c.save();
		await c.page.locator(".fp-actions .btn:not(.primary)").click();
		await c.edit();
		const second = await c.save();
		assert.notEqual(first.lifetime, second.lifetime);
		await c.deliver(reply(first));
		await c.draft(A);
		await c.deliver(reply(second));
		assert.equal(await c.page.locator(".fp-editor").count(), 0);
	});

	await run("discard confirmation, attachment lines and HTML script opt-in remain", async (c) => {
		await c.load();
		await c.page.locator(".fp-line").first().click();
		await c.page.locator(".fp-actions .primary").click();
		assert.deepEqual(await c.page.evaluate(() => window.fixture.attachments()), [["notes.txt", "notes.txt", 1, 1]]);
		await c.edit();
		c.page.removeAllListeners("dialog");
		c.page.on("dialog", (dialog) => dialog.dismiss());
		await c.page.locator(".fp-close").click();
		await c.page.locator(".fp-actions .btn:not(.primary)").click();
		await c.draft(A);
		assert.equal(await c.page.evaluate(() => window.fixture.closes()), 0);
		await c.update({ file: { path: "sample.html", name: "sample.html" }, content: null });
		await c.load("<p>synthetic</p>");
		assert.equal(await c.page.locator("iframe").getAttribute("sandbox"), "");
		await c.page.locator(".fp-html-js").click();
		assert.equal(await c.page.locator("iframe").getAttribute("sandbox"), "allow-scripts");
		await c.update({ binding: { ...BINDING, openId: "html-reopen" }, content: null });
		await c.load("<p>synthetic</p>");
		assert.equal(await c.page.locator("iframe").getAttribute("sandbox"), "");
	});

	console.log(
		JSON.stringify(
			{
				outcome: "HIT",
				checks: results.length,
				baseline: BASELINE,
				baselineBlob: BASELINE_BLOB,
				currentSourceSha256: createHash("sha256").update(source).digest("hex"),
				evidence:
					"synthetic real-component caller only; not host binding, filesystem persistence, recovery or deployment",
			},
			null,
			2,
		),
	);
} finally {
	await browser.close();
}
