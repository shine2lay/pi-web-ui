/** Queue profile coverage: isolated HOME, fake providers and stub child launches. Never sends a model request. */
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
const base = mkdtempSync(join(tmpdir(), "piweb-profiles-"));
const agent = join(base, "agent"),
	cwd = join(base, "work"),
	data = join(base, "data");
for (const d of [agent, cwd, data]) mkdirSync(d, { recursive: true });
const shots = process.env.QUEUE_PROFILES_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const port = 40000 + Math.floor(Math.random() * 12000);
const fixture = join(agent, "fixture.ts");
writeFileSync(
	fixture,
	`
import queue from ${JSON.stringify(join(pkg, "index.ts"))};
import { prepareLaunch } from ${JSON.stringify(join(repo, "dist/server/queue-profile.js"))};
let serial = 0;
export default function(pi) {
  const key = Symbol.for("pi-web-ui.queue-host"), h = globalThis[key];
  if (!h?.fixture) globalThis[key] = { ...h, fixture: true, profiles: 1,
    startChat: async (o) => {
      let model, thinking = "off", speed = "standard";
      const l = await prepareLaunch(o.launch, {
        selectModel: async (id) => {
          if (id === "gone/m") { const e = new Error("Model unavailable: gone/m"); e.name = "QueueLaunchRefused"; throw e; }
          const full = id || "fixture/plain", slash = full.indexOf("/");
          model = { provider: full.slice(0, slash), id: full.slice(slash + 1), reasoning: full !== "fixture/plain", thinkingLevelMap: { xhigh: "xhigh", max: "xhigh" } };
        }, model: () => model, thinking: () => thinking, preferredThinking: () => model.reasoning ? "medium" : "off",
        setThinking: (v) => { thinking = v; }, speed: () => speed, setSpeed: (v) => { speed = v; },
        record: (l) => { if (!o.onPrepared?.(l)) throw new Error("Launch was superseded"); },
      });
      return { sessionFile: ${JSON.stringify(base)} + "/child-" + (++serial) + ".jsonl" };
    }, chatState: async () => ({ state: "working" }),
  };
  const tools = new Map();
  queue(new Proxy(pi, { get(target, key) {
    if (key === "registerTool") return tool => { tools.set(tool.name, tool); return target.registerTool(tool); };
    return target[key];
  }}));
  const plan = { title: "Check the sample page", goal: "Keep the sample page readable on phones",
    done_when: "The fixture page fits a phone screen", decided: "Only the isolated sample page; no real tasks",
    steps: "1. Inspect the sample\\n2. Check the narrow layout\\n3. Report the result",
    verify: "Check the fixture at both sizes", must_not: "Change any real queue or call a model", touches: [] };
  pi.registerCommand("fixture", { description: "Isolated queue profile fixture", handler: async (line, ctx) => {
    const [action, arg] = line.trim().split(/\\s+/);
    if (action === "add" || action === "override" || action === "invalid" || action === "update" || action === "clear") {
      const p = { ...plan, ...(action === "override" ? { thinking: "low" } : {}), ...(action === "invalid" ? { model: "gone/m" } : {}),
        ...(action === "update" ? { id: Number(arg), speed: "standard" } : {}), ...(action === "clear" ? { id: Number(arg), speed: null } : {}) };
      try { await tools.get("queue_add").execute("fixture", p, undefined, undefined, ctx); }
      catch { pi.appendEntry("fixture-result", { refused: true }); }
    } else if (action === "assigned") {
      pi.appendEntry("queue", { v: 1, op: "assigned", id: 99, plan: { title: "Assigned fixture" }, from: { file: "/fixture/parent" }, ts: Date.now() });
    }
  }});
}
`,
);
let modelCalls = 0;
const noModel = createServer((req, res) => {
	modelCalls++;
	req.resume();
	res.writeHead(503).end();
});
await new Promise((r) => noModel.listen(0, "127.0.0.1", r));
const providers = {},
	auth = {};
for (const [provider, id, name, reasoning] of [
	["fixture", "plain", "Fixture Plain", false],
	["openai-codex", "gpt-6-astra", "Fixture Astra", true],
	["anthropic", "profile-plain", "Fixture Claude", false],
]) {
	auth[provider] = { type: "api_key", key: "fixture-only" };
	providers[provider] = {
		apiKey: "fixture-only",
		api: "openai-completions",
		baseUrl: `http://127.0.0.1:${noModel.address().port}/v1`,
		models: [
			{
				id,
				name,
				reasoning,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 10000,
				maxTokens: 1000,
			},
		],
	};
}
writeFileSync(join(agent, "auth.json"), JSON.stringify(auth));
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers }));
writeFileSync(
	join(agent, "settings.json"),
	JSON.stringify({ defaultProvider: "fixture", defaultModel: "plain", extensions: [fixture] }),
);
let child, browser;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function start() {
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
}
async function stop() {
	if (!child || child.exitCode !== null) return;
	const exited = new Promise((r) => child.once("exit", r));
	process.kill(-child.pid, "SIGTERM");
	const timer = setTimeout(() => {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {}
	}, 5000);
	await exited;
	clearTimeout(timer);
}
async function up() {
	for (let i = 0; i < 150; i++) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
		} catch {}
		await sleep(200);
	}
	throw new Error("Fixture server did not start");
}
async function wire(page, msg) {
	await page.evaluate((m) => window.__ws.send(JSON.stringify(m)), msg);
}
const command = (page, text) => wire(page, { type: "prompt", text });
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
async function openPage(phone = false) {
	const ctx = await browser.newContext({
		viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 960 },
		isMobile: phone,
		hasTouch: phone,
	});
	await ctx.addInitScript(() => {
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
						if (["snapshot", "snapshot_delta", "state"].includes(m.type)) {
							window.__queue = {
								...window.__queue,
								...Object.fromEntries(
									Object.entries(m.state || {}).filter(([k]) =>
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
	const page = await ctx.newPage();
	await page.goto(`http://127.0.0.1:${port}/`);
	await page.waitForFunction(() => window.__queue?.taskQueue?.available, null, { timeout: 60000 });
	const old = (await state(page)).taskQueue;
	if (old.profile || old.tasks.length) {
		await wire(page, { type: "new_chat" });
		await page.waitForFunction((id) => window.__queue?.taskQueue?.queueId !== id, old.queueId);
	}
	await panel(page, phone);
	return page;
}
async function set(page, label, field, value, id) {
	if (label === "Queue defaults") label = "Defaults";
	await page
		.getByRole("combobox", { name: `${label} ${field}`, exact: true })
		.filter({ visible: true })
		.selectOption(value);
	await page.waitForFunction(
		({ field, value, id }) => {
			const q = window.__queue?.taskQueue,
				p = id ? q?.tasks.find((t) => t.id === id)?.profile : q?.profile;
			return (
				(p?.[field.toLowerCase()] ?? "") === value &&
				[...document.querySelectorAll(".queue-profile-editor select")].some((s) => !s.disabled)
			);
		},
		{ field, value, id },
	);
}
async function defaults(page) {
	const d = page.locator(".queue-defaults").filter({ visible: true });
	if ((await d.getAttribute("open")) === null) await d.locator("summary").click();
}
async function expand(page, id) {
	const q = page.locator(`.task-queue-task[data-task-id="${id}"]`).filter({ visible: true });
	if (!(await page.locator(`[data-profile-task="${id}"]`).filter({ visible: true }).count()))
		await q.locator(".task-queue-title").click();
}
async function add(page, action = "add", n) {
	// On phones the queue drawer covers the chat's plan-approval dialog. Use the ordinary
	// backdrop to return to the chat, approve there, then reopen the same queue.
	const phoneDrawer = await page.locator(".drawer-right.open").count();
	if (phoneDrawer) await page.locator(".drawer-backdrop").click({ position: { x: 3, y: 100 } });
	const count = (await state(page)).taskQueue.tasks.length;
	await command(page, `/fixture ${action}${n ? ` ${n}` : ""}`);
	await page.locator(".dialog-inline").waitFor();
	assert.match(await page.locator(".dialog-inline").innerText(), /Starts with:/);
	await page.locator(".dialog-inline .dialog-actions .btn.primary").click();
	if (!n) await page.waitForFunction((count) => window.__queue?.taskQueue?.tasks.length === count + 1, count);
	else await page.locator(".dialog-inline").waitFor({ state: "hidden" });
	if (phoneDrawer) {
		await panel(page, true);
		await defaults(page);
	}
}
async function shot(page, name) {
	const p = page.locator(".task-queue-panel").filter({ visible: true });
	const layout = await p.evaluate((el) => ({
		width: el.clientWidth,
		overflow: el.scrollWidth > el.clientWidth,
		pageOverflow: document.documentElement.scrollWidth > innerWidth,
	}));
	assert.equal(layout.overflow, false, `${name}: panel fits`);
	assert.equal(layout.pageOverflow, false, `${name}: page fits`);
	if (shots) await p.screenshot({ path: join(shots, `${name}.png`) });
}
try {
	assert.ok(existsSync(join(pkg, "index.ts")));
	start();
	await up();
	browser = await chromium.launch({ executablePath: CHROME_PATH });
	const a = await openPage();
	await defaults(a);
	const modelOptions = a.getByRole("combobox", { name: "Defaults Model", exact: true }).locator("option");
	await modelOptions.filter({ hasText: "Fixture Astra" }).waitFor({ state: "attached" });
	assert.ok(
		(await modelOptions.evaluateAll((opts) => opts.map((o) => o.value))).includes("openai-codex/gpt-6-astra"),
		"queue model editor uses the authenticated fixture catalog",
	);
	assert.equal((await state(a)).taskQueue.profile, undefined);
	await set(a, "Queue defaults", "Model", "openai-codex/gpt-6-astra");
	await set(a, "Queue defaults", "Thinking", "high");
	await set(a, "Queue defaults", "Speed", "fast");
	const empty = await state(a);
	assert.ok(existsSync(empty.sessionFile), "empty configured queue persists without a model turn");
	await add(a);
	await add(a, "override");
	await expand(a, 2);
	const inherited = a.locator('[data-profile-task="2"]').filter({ visible: true });
	assert.ok(await inherited.locator('[data-source="queue"]').count());
	assert.ok(await inherited.locator('[data-source="task"]').count());
	await set(a, "Queue defaults", "Thinking", "medium");
	assert.equal((await state(a)).taskQueue.tasks[1].profile.thinking, "low");
	await set(a, "Task override", "Speed", "standard", 2);
	await shot(a, "desktop-defaults-override");
	await set(a, "Task override", "Speed", "", 2);
	await set(a, "Task override", "Thinking", "", 2);
	assert.equal((await state(a)).taskQueue.tasks[1].profile, undefined);
	await add(a, "update", 2);
	assert.equal((await state(a)).taskQueue.tasks[1].profile.speed, "standard");
	await add(a, "clear", 2);
	assert.equal((await state(a)).taskQueue.tasks[1].profile, undefined);
	// Unsupported combinations remain explicit and visibly invalid, never silently downgraded.
	await set(a, "Queue defaults", "Model", "anthropic/profile-plain");
	assert.ok(await a.getByRole("alert").filter({ visible: true }).count());
	assert.equal(
		await a.getByRole("combobox", { name: "Defaults Speed", exact: true }).locator('option[value="ultrafast"]').count(),
		0,
	);
	await set(a, "Queue defaults", "Thinking", "off");
	await set(a, "Queue defaults", "Speed", "standard");
	await set(a, "Queue defaults", "Model", "openai-codex/gpt-6-astra");
	await set(a, "Queue defaults", "Thinking", "high");
	await set(a, "Queue defaults", "Speed", "ultrafast");
	// One simulated launch: captured requested settings and started-task controls freeze.
	await command(a, "/queue lanes 1");
	await command(a, "/queue start");
	await a.waitForFunction(() => window.__queue?.taskQueue?.tasks[0]?.chat);
	const launch = (await state(a)).taskQueue.tasks[0].launch;
	assert.equal(launch.speed, "ultrafast");
	assert.equal(launch.thinking, "high");
	await command(a, "/queue stop");
	await set(a, "Queue defaults", "Speed", "standard");
	await set(a, "Queue defaults", "Thinking", "low");
	assert.deepEqual((await state(a)).taskQueue.tasks[0].launch, launch);
	await expand(a, 1);
	assert.equal(await a.locator('[data-profile-task="1"] .queue-profile-editor').count(), 0);
	assert.ok(await a.locator('[data-profile-task="1"] .task-queue-open-chat').count());
	// Separate clients/queues, bad queue/task fences, and ordinary settings remain untouched.
	const b = await openPage();
	const other = await state(b);
	assert.equal(other.taskQueue.profile, undefined);
	for (const bad of [
		{ conversationId: empty.conversationId, queueId: other.taskQueue.queueId },
		{ conversationId: other.conversationId, queueId: empty.taskQueue.queueId },
		{},
	])
		await wire(b, { type: "task_queue_command", action: "defaults", profile: { speed: "fast" }, ...bad });
	await command(b, "/queue owner-setting forged");
	await wire(b, { type: "get_state" });
	await sleep(200);
	assert.equal((await state(b)).taskQueue.profile, undefined);
	const file = (await state(a)).sessionFile;
	await stop();
	start();
	await up();
	await a.reload();
	await a.waitForFunction(() => window.__queue?.taskQueue?.available, null, { timeout: 60000 });
	await wire(a, { type: "switch_session", path: file });
	await a.waitForFunction(() => window.__queue?.taskQueue?.tasks.length === 2);
	assert.equal((await state(a)).taskQueue.profile.speed, "standard");
	assert.deepEqual((await state(a)).taskQueue.tasks[0].launch, launch);
	const phone = await openPage(true);
	await defaults(phone);
	await set(phone, "Queue defaults", "Model", "openai-codex/gpt-6-astra");
	await set(phone, "Queue defaults", "Thinking", "medium");
	await set(phone, "Queue defaults", "Speed", "fast");
	await add(phone, "override");
	await expand(phone, 1);
	await shot(phone, "phone-defaults-override");
	await phone.setViewportSize({ width: 320, height: 744 });
	await shot(phone, "phone-320-inheritance");
	assert.equal(await phone.locator(".drawer-right.open").count(), 1);
	await command(b, "/fixture assigned");
	await b.waitForFunction(() => !!window.__queue?.taskQueue?.from);
	assert.equal(await b.locator(".queue-defaults").count(), 0);
	assert.equal(modelCalls, 0, "zero provider requests");
	console.log(
		"PASS: queue defaults, independent overrides/clears, effective sources, pending propagation, unsupported capabilities, launch freeze, owner/queue isolation, persistence and desktop/phone/320px controls; zero model calls",
	);
} finally {
	if (browser) await browser.close();
	await stop();
	noModel.closeAllConnections();
	await new Promise((r) => noModel.close(r));
	rmSync(base, { recursive: true, force: true });
}
