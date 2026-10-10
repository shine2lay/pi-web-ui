/** No model or tokens: exercise the real queue extension through a test-only command bridge.
 * Isolated HOME/data/session files; the host's child launcher is replaced in THIS test server only.
 * No request bodies, prompts, tool lists or tool results are printed. Screenshots contain only the panel.
 * PI_QUEUE_PKG selects the extension checkout; PI_TEST_APP_REPO may select an installed app build.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const repo = process.env.PI_TEST_APP_REPO || fileURLToPath(new URL("..", import.meta.url));
const pkg = process.env.PI_QUEUE_PKG || join(userInfo().homedir, "projects/pi-queue");
const base = mkdtempSync(join(tmpdir(), "piweb-autonomy-"));
const agent = join(base, "agent"),
	cwd = join(base, "work"),
	data = join(base, "data");
for (const d of [agent, cwd, data]) mkdirSync(d, { recursive: true });
const shots = process.env.QUEUE_AUTONOMY_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const port = 40000 + Math.floor(Math.random() * 12000);
const fixture = join(agent, "fixture.ts");
writeFileSync(
	fixture,
	`
import queue from ${JSON.stringify(join(pkg, "index.ts"))};
let serial = 0;
export default function(pi) {
  const key = Symbol.for("pi-web-ui.queue-host");
  const h = globalThis[key];
  if (!h?.fixture) globalThis[key] = { ...h, fixture: true,
    startChat: async () => ({ sessionFile: ${JSON.stringify(base)} + "/child-" + (++serial) + ".jsonl" }),
    chatState: async () => ({ state: "working" }),
  };
  const tools = new Map();
  queue(new Proxy(pi, { get(target, key) {
    if (key === "registerTool") return tool => { tools.set(tool.name, tool); return target.registerTool(tool); };
    return target[key];
  }}));
  const plan = { title: "Check the sample page", goal: "Keep the sample page readable on phones",
    done_when: "The fixture page fits a phone screen", decided: "Only the isolated sample page; no real tasks",
    steps: "1. Inspect the sample\\n2. Check the narrow layout\\n3. Report the result",
    verify: "Check the fixture layout at both sizes", must_not: "Change any real queue or call a model", touches: [] };
  // Each update changes the goal: a plan change that changes nothing saves nothing (pi-queue #92), so it asks nothing.
  let updates = 0;
  pi.registerCommand("fixture", { description: "Isolated queue fixture", handler: async (line, ctx) => {
    const [action, number] = line.trim().split(/\\s+/);
    if (action === "add" || action === "update" || action === "incomplete") {
      const p = { ...plan, ...(action === "update" ? { id: Number(number), goal: plan.goal + " (change " + (++updates) + ")" } : {}), ...(action === "incomplete" ? { goal: "TBD" } : {}) };
      try { await tools.get("queue_add").execute("fixture", p, undefined, undefined, ctx); }
      catch { pi.appendEntry("fixture-result", { refused: true }); }
    } else if (action === "finish") {
      pi.appendEntry("queue", { v: 1, op: "done", id: Number(number), summary: "Fixture finished", ts: Date.now() });
    } else if (action === "assigned") {
      pi.appendEntry("queue", { v: 1, op: "assigned", id: 99, plan: { title: "Assigned fixture" }, from: { file: "/fixture/parent.jsonl" }, ts: Date.now() });
    }
  }});
}
`,
);
// A configured, fail-closed local model avoids the initial account-setup modal.
// Count requests only; never inspect or log any model-bound data.
let modelCalls = 0;
const noModel = createServer((req, res) => {
	modelCalls++;
	req.resume();
	res.writeHead(503).end();
});
await new Promise((resolve) => noModel.listen(0, "127.0.0.1", resolve));
writeFileSync(join(agent, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture-only" } }));
writeFileSync(
	join(agent, "models.json"),
	JSON.stringify({
		providers: {
			fixture: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${noModel.address().port}/v1`,
				models: [
					{
						id: "fixture",
						name: "Fixture",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 10000,
						maxTokens: 1000,
					},
				],
			},
		},
	}),
);
writeFileSync(
	join(agent, "settings.json"),
	JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", extensions: [fixture] }),
);
let child, browser;
const start = () => {
	child = spawn(process.execPath, [join(repo, "dist/server/index.js")], {
		cwd: repo,
		env: {
			...process.env,
			PI_WEB_PORT: String(port),
			PI_WEB_CWD: cwd,
			PI_WEB_DATA_DIR: data,
			PI_CODING_AGENT_DIR: agent,
			PI_WEB_TOKEN: "",
			PI_WEB_SDK: "bundled",
		},
		stdio: "ignore",
		detached: true,
	});
};
const stop = async () => {
	if (!child || child.exitCode !== null) return;
	const exited = new Promise((r) => child.once("exit", r));
	process.kill(-child.pid, "SIGTERM");
	const deadline = setTimeout(() => {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {}
	}, 5000);
	await exited;
	clearTimeout(deadline);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function up() {
	for (let i = 0; i < 150; i++) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
		} catch {}
		await sleep(200);
	}
	throw new Error("fixture server did not start");
}
async function openPage(phone = false) {
	const context = await browser.newContext({
		viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 960 },
		isMobile: phone,
		hasTouch: phone,
	});
	await context.addInitScript(() => {
		localStorage.setItem("pi-web-ui:lang", "en");
		localStorage.setItem("pi-web-ui:right-panel-collapsed", "0");
		const Orig = window.WebSocket;
		window.WebSocket = class extends Orig {
			constructor(...args) {
				super(...args);
				if (!String(args[0]).includes("/ws")) return;
				window.__ws = this;
				this.addEventListener("message", ({ data }) => {
					try {
						const m = JSON.parse(data);
						if (m.type === "snapshot" || m.type === "snapshot_delta" || m.type === "state") {
							const s = m.state || {};
							window.__queue = {
								...window.__queue,
								...Object.fromEntries(
									Object.entries(s).filter(([k]) =>
										["taskQueue", "sessionFile", "conversationId", "sessionId"].includes(k),
									),
								),
							};
						}
					} catch {}
				});
			}
		};
	});
	const page = await context.newPage();
	await page.goto(`http://127.0.0.1:${port}/`);
	await page.waitForFunction(() => window.__queue?.taskQueue?.available === true, null, { timeout: 60000 });
	const previous = (await state(page)).taskQueue;
	// The app deliberately reuses a truly blank chat; a saved/armed queue is not blank.
	if (previous.autoApprove || previous.autoStart || previous.tasks.length) {
		await wire(page, { type: "new_chat" });
		await page.waitForFunction(
			(id) => window.__queue?.taskQueue?.queueId && window.__queue.taskQueue.queueId !== id,
			previous.queueId,
		);
	}
	await panel(page, phone);
	return page;
}
async function wire(page, msg) {
	await page.evaluate((m) => window.__ws.send(JSON.stringify(m)), msg);
}
async function command(page, text) {
	await wire(page, { type: "prompt", text });
}
const state = (page) => page.evaluate(() => window.__queue);
async function panel(page, phone = false) {
	if (phone && !(await page.locator(".drawer-right.open").count())) {
		const toggle = page.locator("button.panel-toggle.has-label");
		if (!(await toggle.isVisible())) await page.locator(".topbar-overflow-btn").click();
		await toggle.click();
		await page.locator(".drawer-right.open").waitFor();
	}
	const parent = page.locator(phone ? ".drawer-right.open" : ".panel-right");
	await parent.locator(".slot-tab", { hasText: "Queue" }).first().click();
	await parent.locator(".task-queue-panel").waitFor();
}
async function toggle(page, name, value) {
	const button = page.getByRole("switch", { name, exact: true }).filter({ visible: true });
	if ((await button.getAttribute("aria-checked")) !== String(value)) await button.click();
	await page.waitForFunction(
		({ name, value }) =>
			[...document.querySelectorAll('[role="switch"]')].some(
				(b) => b.getAttribute("aria-label") === name && b.getAttribute("aria-checked") === String(value) && !b.disabled,
			),
		{ name, value },
	);
}
async function tasks(page, count) {
	await page.waitForFunction((n) => window.__queue?.taskQueue?.tasks.length === n, count);
}
async function compactControls(page, name) {
	await page.evaluate(() => document.fonts.ready);
	const empty = page.locator(".task-queue-empty").filter({ visible: true });
	if (await empty.count())
		assert.equal(await empty.innerText(), "The queue is empty.", `${name}: no empty-state tutorial`);
	const layout = await page
		.locator(".task-queue-autonomy")
		.filter({ visible: true })
		.evaluate((row) => {
			const bounds = row.getBoundingClientRect();
			return {
				text: row.innerText.replace(/\s+/g, " ").trim(),
				height: bounds.height,
				overflow: row.scrollWidth > row.clientWidth,
				buttons: [...row.querySelectorAll('[role="switch"]')].map((button) => {
					const box = button.getBoundingClientRect();
					return { y: box.y, width: box.width, height: box.height, overflow: button.scrollWidth > button.clientWidth };
				}),
			};
		});
	assert.match(layout.text, /^Auto approve (On|Off) Auto start (On|Off)$/, `${name}: only labels and states`);
	assert.equal(layout.buttons.length, 2, `${name}: both switches`);
	assert.ok(layout.height <= 48, `${name}: one compact row (${layout.height}px)`);
	assert.ok(Math.abs(layout.buttons[0].y - layout.buttons[1].y) < 1, `${name}: switches sit side by side`);
	assert.equal(layout.overflow, false, `${name}: no horizontal overflow`);
	for (const button of layout.buttons) {
		assert.ok(button.width >= 44 && button.height >= 44, `${name}: 44px touch target`);
		assert.equal(button.overflow, false, `${name}: labels fit their buttons`);
	}
}
async function shot(page, name) {
	await compactControls(page, name);
	if (shots)
		await page
			.locator(".task-queue-panel")
			.filter({ visible: true })
			.screenshot({ path: join(shots, `${name}.png`) });
}
try {
	assert.ok(existsSync(join(pkg, "index.ts")), "queue checkout exists");
	start();
	await up();
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const a = await openPage();
	assert.deepEqual([(await state(a)).taskQueue.autoApprove, (await state(a)).taskQueue.autoStart], [false, false]);
	await shot(a, "desktop-off");
	await toggle(a, "Auto approve", true);
	await toggle(a, "Auto start", true);
	await shot(a, "desktop-on");
	const original = await state(a);
	// Even without a chat message, New chat must not reuse an opted-in queue.
	await wire(a, { type: "new_chat" });
	await a.waitForFunction((id) => window.__queue?.taskQueue?.queueId !== id, original.taskQueue.queueId);
	assert.deepEqual([(await state(a)).taskQueue.autoApprove, (await state(a)).taskQueue.autoStart], [false, false]);
	await wire(a, { type: "switch_session", path: original.sessionFile });
	await a.waitForFunction(() => window.__queue?.taskQueue?.autoApprove === true);
	const b = await openPage();
	assert.deepEqual([(await state(b)).taskQueue.autoApprove, (await state(b)).taskQueue.autoStart], [false, false]);
	assert.notEqual((await state(b)).taskQueue.queueId, original.taskQueue.queueId);
	assert.ok(existsSync(original.sessionFile), "empty opted-in queue is persisted before any model turn");
	await a.reload();
	// This app intentionally makes a new client on reload; explicitly reopen the same queue.
	await a.waitForFunction(() => window.__queue?.taskQueue?.available === true);
	await wire(a, { type: "switch_session", path: original.sessionFile });
	await a.waitForFunction(() => window.__queue?.taskQueue?.autoApprove === true);
	await panel(a);
	await command(a, "/fixture incomplete");
	await wire(a, { type: "get_state" });
	assert.equal((await state(a)).taskQueue.tasks.length, 0);
	await command(a, "/fixture add");
	await tasks(a, 1);
	await a.waitForFunction(() => window.__queue.taskQueue.tasks[0]?.status === "working");
	assert.equal((await state(a)).taskQueue.tasks[0].approval, "auto");
	assert.equal(await a.locator(".dialog-inline").count(), 0);
	await command(a, "/fixture finish 1");
	await command(a, "/queue lanes 2");
	await a.waitForFunction(() => window.__queue.taskQueue.pausedReason === "finished");
	await command(a, "/fixture add");
	await tasks(a, 2);
	await a.waitForFunction(() => window.__queue.taskQueue.tasks[1]?.status === "working");
	await command(a, "/queue stop");
	await a.waitForFunction(() => window.__queue.taskQueue.autoStart === false);
	await command(a, "/fixture add");
	await tasks(a, 3);
	assert.equal((await state(a)).taskQueue.tasks[2].status, "ready");
	await command(a, "/fixture update 3");
	assert.equal(await a.locator(".dialog-inline").count(), 0);
	await toggle(a, "Auto approve", false);
	await command(a, "/fixture update 3");
	await a.locator(".dialog-inline").waitFor();
	await a.locator(".dialog-inline .dialog-actions .btn.primary").click();
	await a.waitForFunction(() => window.__queue.taskQueue.tasks[2].approval === "dialog");
	const other = await state(b);
	for (const bad of [
		{ conversationId: original.conversationId, queueId: other.taskQueue.queueId, value: true },
		{ conversationId: other.conversationId, queueId: original.taskQueue.queueId, value: true },
		{ value: true },
		{ conversationId: other.conversationId, queueId: other.taskQueue.queueId, value: "true" },
	])
		await wire(b, { type: "task_queue_command", action: "autoApprove", ...bad });
	await command(b, "/queue owner-setting guessed");
	await wire(b, { type: "get_state" });
	await sleep(250);
	assert.equal((await state(b)).taskQueue.autoApprove, false);
	await command(b, "/fixture add");
	await b.locator(".dialog-inline").waitFor();
	await b.locator(".dialog-inline .dialog-actions .btn:not(.primary)").click();
	assert.equal((await state(b)).taskQueue.tasks.length, 0);
	// Restart only the isolated fixture server; Stop must survive it.
	const file = (await state(a)).sessionFile;
	await stop();
	start();
	await up();
	await a.reload();
	await a.waitForFunction(() => window.__queue?.taskQueue?.available, null, { timeout: 60000 });
	await wire(a, { type: "switch_session", path: file });
	await a.waitForFunction(() => window.__queue?.taskQueue?.tasks.length === 3);
	assert.deepEqual([(await state(a)).taskQueue.autoApprove, (await state(a)).taskQueue.autoStart], [false, false]);
	assert.equal((await state(a)).taskQueue.pausedReason, "user");
	await command(a, "/fixture add");
	await a.locator(".dialog-inline").waitFor();
	await a.locator(".dialog-inline .dialog-actions .btn.primary").click();
	await tasks(a, 4);
	assert.equal((await state(a)).taskQueue.tasks[3].status, "ready");
	const phone = await openPage(true);
	await phone.setViewportSize({ width: 320, height: 744 });
	await compactControls(phone, "phone-320px");
	await phone.setViewportSize({ width: 390, height: 844 });
	await shot(phone, "phone-off");
	await toggle(phone, "Auto approve", true);
	await toggle(phone, "Auto start", true);
	await shot(phone, "phone-on");
	assert.equal(await phone.locator(".drawer-right.open").count(), 1, "setting changes keep the drawer open");
	await toggle(phone, "Auto start", false);
	await toggle(phone, "Auto approve", false);
	await command(phone, "/fixture assigned");
	await phone.waitForFunction(() => !!window.__queue?.taskQueue?.from);
	assert.equal(await phone.getByRole("switch").count(), 0, "task chat has no autonomy controls");
	assert.equal(modelCalls, 0, "fixture never calls a model");
	console.log(
		"PASS: compact desktop/phone switches including 320px layout and touch targets, owner fences, independent queues, approval on/off, empty rearm, Stop, reload and restart; zero model calls",
	);
} finally {
	if (browser) await browser.close();
	await stop();
	noModel.closeAllConnections();
	await new Promise((resolve) => noModel.close(resolve));
	rmSync(base, { recursive: true, force: true });
}
