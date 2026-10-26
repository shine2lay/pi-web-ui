/* #592: isolated native Chromium, real RightPanel -> TaskQueuePanel, no app server or model.
 * Two loss controls load genuinely old components from the pinned git object, not a reimplementation.
 * Run: scripts/sealed.sh node tests/durable-queue-answer-test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const BASE = "4f32b06e2d2f8dec63a4258ac6575ba2cbac7b92";
const WORDS = "  Synthetic browser answer: keep  both spaces.  ";
const QUESTION = "Which synthetic fixture option?";
const CHOICES = ["  Synthetic first option  ", "Synthetic second option"];
const DETAIL = "## Synthetic context\n\nKeep **all** the evidence.";
const BINDING = {
	conversationId: "synthetic-conversation-a",
	queueId: "synthetic-queue-a",
	taskId: 7,
	questionId: "synthetic-host-occurrence-a",
	question: QUESTION,
	choices: CHOICES,
	detail: DETAIL,
};
const components = join(REPO, "web/src/components");
const originals = new Map(
	["RightPanel", "TaskQueuePanel"].map((name) => [
		name,
		execFileSync("git", ["show", `${BASE}:web/src/components/${name}.tsx`], { cwd: REPO, encoding: "utf8" }),
	]),
);
// Guard the control's premise without replacing its behavior with a hand-written mock.
assert.match(originals.get("TaskQueuePanel"), /setSent\(true\);\s*setText\(""\);\s*onAnswer\(task.id, words\)/);
assert.match(originals.get("RightPanel"), /panelSend\(\{ type: "task_queue_answer"/);

const entry = `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { RightPanel } from "./web/src/components/RightPanel";
import { RightPanel as OldRightPanel } from "old:RightPanel";
import { LanguageProvider } from "./web/src/i18n";
const ORIGINAL = ${JSON.stringify(BINDING)};
const root = createRoot(document.getElementById("root"));
let epoch = 0;
let current;
const clone = value => structuredClone(value);
function render() {
  const C = current.mode === "old" ? OldRightPanel : RightPanel;
  flushSync(() => root.render(<LanguageProvider><C key={epoch} {...current.props} /></LanguageProvider>));
}
function mount(mode = "fixed", options = {}) {
  flushSync(() => root.render(null));
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem("pi-web-ui:rightpanel:tab", "queue");
  epoch++;
  const host = { requests: [], dispatches: [], pending: [], frozen: [] };
  const binding = clone(ORIGINAL);
  const task = {
    id: 7, status: "stuck", addedAt: 1, question: binding.question, choices: [...binding.choices], detail: binding.detail,
    plan: { title: "Synthetic browser task", goal: "", doneWhen: "", decided: "", steps: "", verify: "", mustNot: "" }
  };
  const onResult = request => {
    host.requests.push(request);
    host.frozen.push(Object.isFrozen(request) && Object.isFrozen(request.binding) && Object.isFrozen(request.binding.choices));
    if (options.syncTrue) return true; // Deliberately invalid transport-only callback: must not count.
    return new Promise((resolve, reject) => host.pending.push({ resolve, reject }));
  };
  const props = {
    files: null, filesReady: false, fileChanged: null, widgets: [], statuses: [],
    panelSend: message => { host.dispatches.push(clone(message)); return options.transport !== false; },
    onAttach() {}, onPreview() {}, onNotice() {},
    tldrConversationId: binding.conversationId,
    taskQueue: { queueId: binding.queueId, available: true, running: false, tasks: [task] },
    taskQueueAnswerBindings: options.unbound ? [] : [binding],
    onTaskQueueAnswerResult: options.unsupported ? undefined : onResult
  };
  if (options.paused) props.taskQueue.hold = { at: 2, why: "Synthetic owner pause" };
  if (options.unavailable) props.taskQueue.available = false;
  if (options.readyTask) props.taskQueue.tasks.push({ ...task, id: 8, status: "ready" });
  current = { mode, props, host };
  render();
}
window.fixture = {
  mount,
  report() {
    return {
      requests: current.host.requests, dispatches: current.host.dispatches, frozen: current.host.frozen,
      storage: JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })
    };
  },
  async settle(value, index = 0, reject = false) {
    if (reject) current.host.pending[index].reject(new Error("synthetic result unavailable"));
    else current.host.pending[index].resolve(value);
    await Promise.resolve(); await Promise.resolve();
  },
  refresh() {
    current.props = { ...current.props, taskQueue: clone(current.props.taskQueue), taskQueueAnswerBindings: clone(current.props.taskQueueAnswerBindings) };
    current.props.taskQueue.running = !current.props.taskQueue.running;
    render();
  },
  change(kind) {
    const p = current.props;
    const b = clone(ORIGINAL);
    const q = clone(p.taskQueue);
    if (kind === "conversation") p.tldrConversationId = b.conversationId = "synthetic-conversation-b";
    if (kind === "queue") q.queueId = b.queueId = "synthetic-queue-b";
    if (kind === "task") q.tasks[0].id = b.taskId = 8;
    if (kind === "occurrence") b.questionId = "synthetic-host-occurrence-b";
    if (kind === "question") q.tasks[0].question = b.question = "A different synthetic question";
    if (kind === "choices") q.tasks[0].choices = b.choices = [...b.choices].reverse();
    if (kind === "detail") q.tasks[0].detail = b.detail = "New synthetic context";
    p.taskQueue = q;
    p.taskQueueAnswerBindings = [b];
    render();
  },
  unmount() { flushSync(() => root.render(null)); },
  reopen() { render(); },
  doubleSubmit() {
    const form = document.querySelector(".task-queue-answer-form");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }
};
mount();
`;

const built = await build({
	stdin: { contents: entry, resolveDir: REPO, sourcefile: "durable-queue-answer-fixture.tsx", loader: "tsx" },
	bundle: true,
	write: false,
	format: "iife",
	platform: "browser",
	jsx: "automatic",
	// Behavior-only fixture: the real Markdown tree imports KaTeX styles/fonts.
	// Keep component logic intact without turning this inline bundle into a visual build.
	loader: { ".css": "empty" },
	define: { "process.env.NODE_ENV": '"development"' },
	plugins: [
		{
			name: "pinned-real-old-queue-components",
			setup(builder) {
				builder.onResolve({ filter: /^old:/ }, (args) => ({ path: args.path.slice(4), namespace: "old-queue" }));
				builder.onResolve({ filter: /^\.\/TaskQueuePanel$/ }, (args) =>
					args.namespace === "old-queue" ? { path: "TaskQueuePanel", namespace: "old-queue" } : undefined,
				);
				builder.onLoad({ filter: /.*/, namespace: "old-queue" }, (args) => ({
					contents: originals.get(args.path),
					loader: "tsx",
					resolveDir: components,
				}));
			},
		},
	],
});
const script = built.outputFiles[0].text;
const server = createServer((req, res) => {
	if (req.url === "/fixture.js") {
		res.writeHead(200, { "content-type": "text/javascript" }).end(script);
		return;
	}
	res
		.writeHead(200, { "content-type": "text/html" })
		.end(
			`<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic queue answer fixture</title><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
		);
});
let browser;
let count = 0;
try {
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = server.address().port;
	assert.ok(port >= 8900, "fixture must not occupy a live application port");
	const origin = `http://127.0.0.1:${port}`;
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
	const page = await browser.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/*", (route) =>
		route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort(),
	);
	await page.goto(origin);
	await page.waitForFunction(() => !!window.fixture);
	const editor = page.locator(".task-queue-answer-input");
	const send = page.locator(".task-queue-answer-send");
	const mount = (options = {}, mode = "fixed") =>
		page.evaluate(({ mode, options }) => window.fixture.mount(mode, options), { mode, options });
	const report = () => page.evaluate(() => window.fixture.report());
	const submit = async (words = WORDS) => {
		await editor.fill(words);
		await editor.press("Enter");
	};
	const checkState = async (expected, words) => {
		assert.equal(await page.locator(".task-queue-answer").getAttribute("data-answer-state"), expected);
		assert.equal(await editor.inputValue(), words);
		assert.equal(await editor.isEditable(), true);
	};
	const settle = async (value, index = 0, reject = false) => {
		await page.evaluate(({ value, index, reject }) => window.fixture.settle(value, index, reject), {
			value,
			index,
			reject,
		});
		await page.waitForFunction(() => document.querySelector(".task-queue-answer")?.dataset.answerState !== "pending");
	};
	const pass = (name) => {
		count++;
		console.log(`PASS ${name}`);
	};

	for (const transport of [false, true]) {
		await mount({ transport }, "old");
		await submit();
		// This is the old real StuckAnswer AND the old real RightPanel's void callback.
		assert.equal(await editor.inputValue(), "", "baseline must genuinely reproduce premature loss");
		assert.equal(await editor.isDisabled(), true);
		assert.deepEqual((await report()).dispatches, [
			{ type: "task_queue_answer", conversationId: BINDING.conversationId, taskId: 7, text: WORDS.trim() },
		]);
		assert.deepEqual((await report()).requests, []);
		pass(`genuine baseline loses words before result, transport=${transport}`);
	}

	for (const result of [false, undefined, null, "true", true, "reject"]) {
		await mount();
		await submit();
		await checkState("pending", WORDS);
		assert.equal(await send.isDisabled(), true);
		assert.deepEqual((await report()).requests, [{ binding: BINDING, text: WORDS }]);
		assert.deepEqual((await report()).frozen, [true]);
		assert.deepEqual((await report()).dispatches, []);
		await page.evaluate(() => window.fixture.refresh());
		await checkState("pending", WORDS);
		await settle(result, 0, result === "reject");
		await checkState(result === true ? "applied" : "unconfirmed", result === true ? "" : WORDS);
		assert.equal((await report()).requests.length, 1);
		assert.ok(!(await report()).storage.includes(WORDS), "consent payload cannot enter local/session storage");
		pass(`genuine callback result ${String(result)}`);
	}

	await mount({ syncTrue: true });
	await submit();
	await checkState("unconfirmed", WORDS);
	pass("synchronous transport true is not an applied-result promise");

	for (const newer of ["Newer browser draft", WORDS]) {
		await mount();
		await submit();
		await editor.fill("Intervening browser edit");
		await editor.fill(newer);
		await settle(true);
		await checkState("applied", newer);
		pass(`newer/ABA revision survives ${newer === WORDS ? "ABA" : "new text"}`);
	}

	await mount();
	await editor.fill(CHOICES[0]);
	await page.locator(".task-queue-choice").first().click();
	await checkState("pending", CHOICES[0]);
	assert.deepEqual((await report()).requests, [{ binding: BINDING, text: CHOICES[0] }]);
	await settle(true);
	await checkState("applied", CHOICES[0]);
	pass("choice preserves exact choice whitespace and never erases typed draft");

	for (const options of [{ unbound: true }, { unsupported: true }]) {
		await mount(options);
		await submit();
		assert.equal(await editor.inputValue(), WORDS);
		assert.equal(await send.isDisabled(), true);
		assert.deepEqual((await report()).requests, []);
		assert.deepEqual((await report()).dispatches, []);
		pass(`missing support cannot fall back: ${JSON.stringify(options)}`);
	}

	for (const kind of ["conversation", "queue", "task", "occurrence", "question", "choices", "detail"]) {
		await mount();
		await submit();
		await page.evaluate((kind) => window.fixture.change(kind), kind);
		await editor.fill("Current browser editor");
		await editor.press("Enter");
		const requests = (await report()).requests;
		assert.equal(requests.length, 2);
		assert.deepEqual(requests[0], { binding: BINDING, text: WORDS });
		assert.equal(requests[1].text, "Current browser editor");
		if (kind === "conversation") assert.equal(requests[1].binding.conversationId, "synthetic-conversation-b");
		if (kind === "queue") assert.equal(requests[1].binding.queueId, "synthetic-queue-b");
		if (kind === "task") assert.equal(requests[1].binding.taskId, 8);
		if (kind === "occurrence") assert.equal(requests[1].binding.questionId, "synthetic-host-occurrence-b");
		await page.evaluate(() => window.fixture.settle(true, 0));
		await checkState("pending", "Current browser editor");
		await settle(false, 1);
		await checkState("unconfirmed", "Current browser editor");
		pass(`stale ${kind} result cannot clean or retarget`);
	}

	await mount();
	await submit();
	await page.evaluate(() => window.fixture.change("occurrence"));
	await page.evaluate(() => window.fixture.change("original"));
	await editor.fill(WORDS);
	await settle(true);
	await checkState("idle", WORDS);
	pass("question occurrence A→B→A cannot revive cleanup");

	await mount();
	await editor.fill(WORDS);
	await page.evaluate(() => window.fixture.doubleSubmit());
	assert.equal((await report()).requests.length, 1);
	await settle(false);
	await editor.press("Enter");
	assert.equal((await report()).requests.length, 2);
	await settle(false, 1);
	pass("same-tick duplicate blocked; explicit retry only");

	for (const close of ["tab", "unmount"]) {
		await mount();
		await submit();
		if (close === "tab") {
			await page.getByRole("tab", { name: "Files", exact: true }).click();
			assert.equal(await editor.count(), 0);
			await page.getByRole("tab", { name: "Queue", exact: true }).click();
		} else {
			await page.evaluate(() => window.fixture.unmount());
			assert.equal(await editor.count(), 0);
			await page.evaluate(() => window.fixture.reopen());
		}
		await editor.fill("Reopened browser draft");
		await settle(true);
		await checkState("idle", "Reopened browser draft");
		assert.equal((await report()).requests.length, 1);
		pass(`${close}/reopen ignores old result`);
	}

	for (const options of [{ paused: true }, { unavailable: true }]) {
		await mount(options);
		assert.equal(await editor.count(), 0);
		assert.deepEqual((await report()).requests, []);
		assert.deepEqual((await report()).dispatches, []);
		pass(`existing restriction preserved: ${JSON.stringify(options)}`);
	}

	await mount({ readyTask: true });
	assert.equal(await page.locator(".task-queue-question-detail").getAttribute("open"), "");
	assert.ok((await page.locator(".task-queue-question-detail").innerText()).includes("Keep all the evidence."));
	await page.locator(".task-queue-remove").click();
	assert.deepEqual((await report()).dispatches, []);
	await page.locator(".task-queue-remove-no").click();
	assert.deepEqual((await report()).dispatches, []);
	await page.locator(".task-queue-remove").click();
	await page.locator(".task-queue-remove-yes").click();
	assert.deepEqual((await report()).dispatches, [
		{ type: "task_queue_command", action: "remove", id: 8, conversationId: BINDING.conversationId },
	]);
	pass("question package and existing synchronous confirmed controls preserved");
	assert.deepEqual(errors, []);
	console.log(
		`H-QUEUE-ANSWER-RESULT-1 HIT: ${count} native-browser cases, including 2 genuine baseline loss controls.`,
	);
} finally {
	await browser?.close();
	await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
