/** Isolated native Chromium + actual React components. Synthetic state only:
 * no app server, real profiles/chats, WebSocket, models or host checkpoint.
 * The old component is loaded verbatim from #585's base pin, not a bug sketch.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PIN = "4f32b06e2d2f8dec63a4258ac6575ba2cbac7b92";
const oldSource = execFileSync("git", ["show", `${PIN}:web/src/components/GoalBar.tsx`], {
	cwd: ROOT,
	encoding: "utf8",
});
const RAW = "  Browser exact Ω requirement\t  ";
const MODEL = "fixture/reviewer";
const bundle = await build({
	absWorkingDir: ROOT,
	bundle: true,
	write: false,
	format: "esm",
	jsx: "automatic",
	define: { "process.env.NODE_ENV": '"development"' },
	stdin: {
		resolveDir: ROOT,
		sourcefile: "durable-goal-fixture.tsx",
		loader: "tsx",
		contents: `
import { createRoot } from "react-dom/client";
import { GoalBar } from "./web/src/components/GoalBar";
import { GoalBar as OldGoalBar } from "old-goalbar";
import { LanguageProvider } from "./web/src/i18n";
import { setAppSend, setAppGlobals } from "./web/src/app-globals";
import { setAppAdmit } from "./web/src/app-admit";
const goal = {
  conversationId: null, goal: null, reviewModel: "fixture/reviewer", maxRounds: 7, locked: true,
  reviewing: false, round: 0, status: "", verdict: "pending",
  wizard: {active:false, draft:"", model:null, step:0, maxSteps:6, status:""}
};
const models = [
  {id:"fixture/reviewer",name:"Fixture reviewer",provider:"fixture",contextWindow:1000,reasoning:false,vision:false},
  {id:"fixture/other",name:"Other reviewer",provider:"fixture",contextWindow:1000,reasoning:false,vision:false}
];
let root, props, Component, release, reject;
const live = [], admitted = [];
function mount() { if (!root) root = createRoot(document.querySelector("#root")); paint(); }
function paint() { root?.render(<LanguageProvider><Component {...props}/></LanguageProvider>); }
function unmount() { root?.unmount(); root = null; }
window.fixture = {
  live, admitted,
  reset(variant, target, mode = "pending", emptyModels = false) {
    unmount(); live.length = admitted.length = 0; release = reject = null;
    Component = variant === "old" ? OldGoalBar : GoalBar;
    props = {goal, models: emptyModels ? [] : models, modelsLoading:false, activeConversationId:target};
    setAppGlobals({engine:"pi"});
    setAppSend(msg => { live.push(structuredClone(msg)); return false; });
    setAppAdmit(msg => {
      admitted.push(structuredClone(msg));
      if (mode === "false") return Promise.resolve(false);
      if (mode === "truthy") return Promise.resolve({accepted:true});
      if (mode === "true") return Promise.resolve(true);
      if (mode === "reject" || mode === "committed-reject")
        return Promise.reject(Object.assign(new Error("synthetic uncertainty"), {payloadCommitted:mode === "committed-reject"}));
      return new Promise((yes, no) => {release = yes; reject = no;});
    });
    mount();
  },
  target(id) {props = {...props,activeConversationId:id}; paint();},
  prefs() {props = {...props,goal:{...goal,reviewModel:"fixture/other",maxRounds:99,locked:false}}; paint();},
  active(wizard = false) {props = {...props,goal:{...goal,conversationId:props.activeConversationId,
    goal: wizard ? null : "Existing synthetic goal", wizard:{...goal.wizard,active:wizard,draft:"Existing wizard"}}}; paint();},
  idle() {props = {...props,goal}; paint();},
  settle(value) {release(value);},
  fail() {reject(Object.assign(new Error("synthetic uncertainty"), {payloadCommitted:true}));},
  unmount, mount,
};
`,
	},
	plugins: [
		{
			name: "pinned-real-old-goalbar",
			setup(plugin) {
				plugin.onResolve({ filter: /^old-goalbar$/ }, () => ({ path: "GoalBar.tsx", namespace: "pinned-old" }));
				plugin.onLoad({ filter: /.*/, namespace: "pinned-old" }, () => ({
					contents: oldSource,
					loader: "tsx",
					resolveDir: `${ROOT}/web/src/components`,
				}));
			},
		},
	],
});
const html = `<!doctype html><meta charset="utf-8"><title>Synthetic GoalBar admission</title>
<style>body{font:16px system-ui;margin:40px;max-width:1000px}.goalbar-row,.goalbar-opts{display:flex;gap:8px;margin:12px 0}
.goalbar-input{min-width:450px}.dd-menu{display:flex;gap:8px}button,input{font:inherit}details{margin:12px 0}textarea{font:14px monospace}</style>
<div id="root"></div><script type="module" src="/fixture.js"></script>`;
const server = createServer((req, res) => {
	if (req.url === "/fixture.js") {
		res.setHeader("Content-Type", "text/javascript");
		res.end(bundle.outputFiles[0].text);
	} else if (req.url === "/") {
		res.setHeader("Content-Type", "text/html; charset=utf-8");
		res.end(html);
	} else {
		res.statusCode = 404;
		res.end();
	}
});
let browser;
let checks = 0;
let losses = 0;
try {
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
	const page = await browser.newPage(); // fresh temporary context; never the owner's browser
	const errors = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.route("**/*", (route) =>
		route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort(),
	);
	await page.goto(origin);
	await page.waitForFunction(() => !!window.fixture);
	let serial = 0;
	const call = (name, ...args) => page.evaluate(({ name, args }) => window.fixture[name](...args), { name, args });
	const input = page.locator(".goalbar-input");
	const rounds = page.locator('input[type="number"]');
	const start = (kind) => page.locator(kind === "set_goal" ? ".goalbar-btn:not(.wizard)" : ".goalbar-btn.wizard");
	const snapshot = () =>
		page.evaluate(() => ({
			live: window.fixture.live,
			admitted: window.fixture.admitted,
			originals: Array.from(document.querySelectorAll(".goalbar-admission textarea"), (el) => JSON.parse(el.value)),
		}));
	async function open() {
		if (!(await input.count())) await page.locator(".goalbar-hint").click();
		await input.waitFor();
	}
	async function setup(variant, mode = "pending", emptyModels = false) {
		const target = `synthetic-${++serial}`;
		await call("reset", variant, target, mode, emptyModels);
		await page.locator(".goalbar-hint").waitFor();
		await open();
		await input.fill(RAW);
		return target;
	}
	const expected = (kind, target, value = RAW) => ({
		type: kind,
		...(kind === "set_goal" ? { goal: value, reviewModel: MODEL } : { text: value, wizardModel: MODEL }),
		maxRounds: 7,
		locked: true,
		conversationId: target,
	});
	async function stateIs(state) {
		await page.locator(`.goalbar-admission [data-admission-state="${state}"]`).waitFor();
	}
	async function retained(kind, target, value = RAW) {
		assert.equal(await input.inputValue(), value);
		assert.equal(await rounds.inputValue(), "7");
		const data = await snapshot();
		assert.deepEqual(data.admitted, [expected(kind, target)]);
		assert.deepEqual(data.originals, [expected(kind, target)]);
		checks++;
	}

	for (const kind of ["set_goal", "start_goal_wizard"]) {
		// A real prior component, real native input/click, and real appSend false.
		// These observations contradict the preservation assertions below.
		await setup("old", "false");
		await start(kind).click();
		assert.equal(await input.inputValue(), "");
		assert.deepEqual((await snapshot()).live, [
			{
				type: kind,
				...(kind === "set_goal" ? { goal: RAW.trim(), reviewModel: MODEL } : { text: RAW.trim(), wizardModel: MODEL }),
				maxRounds: 7,
				locked: true,
			},
		]);
		assert.deepEqual((await snapshot()).admitted, []);
		losses++;

		for (const mode of ["false", "truthy", "reject", "committed-reject"]) {
			const target = await setup("new", mode);
			await start(kind).click();
			await stateIs(mode.includes("reject") ? "uncertain" : "refused");
			await retained(kind, target);
			assert.deepEqual((await snapshot()).live, []);
			await call("unmount");
			await call("mount");
			await input.waitFor();
			await retained(kind, target); // recovery is visible, no auto-start
		}
		{
			const target = await setup("new", "true");
			await start(kind).click();
			await stateIs("admitted");
			assert.equal(await input.inputValue(), "");
			assert.deepEqual((await snapshot()).originals, [expected(kind, target)]);
			checks++;
		}
		{
			const target = await setup("new");
			await start(kind).click();
			await stateIs("pending");
			await input.press("Enter");
			await input.press("Enter");
			// Native disabled buttons cannot be clicked; Enter still exercises the guard.
			assert.equal(await start("set_goal").isDisabled(), true);
			assert.equal(await start("start_goal_wizard").isDisabled(), true);
			await retained(kind, target);
			await call("prefs");
			await retained(kind, target);
			await call("settle", true);
			await stateIs("admitted");
			assert.equal(await input.inputValue(), "");
			checks++;
		}
		for (const editKind of ["text", "text ABA", "rounds ABA", "model ABA", "lock ABA", "collapse ABA"]) {
			const target = await setup("new");
			await start(kind).click();
			await stateIs("pending");
			if (editKind.startsWith("text")) {
				await input.fill("Newer browser draft");
				if (editKind.endsWith("ABA")) await input.fill(RAW);
			} else if (editKind === "rounds ABA") {
				await rounds.fill("11");
				await rounds.fill("7");
			} else if (editKind === "model ABA") {
				await page.locator(".dropdown > button").click();
				await page.locator(".dd-item").filter({ hasText: "Other reviewer" }).click();
				await page.locator(".dropdown > button").click();
				await page.locator(".dd-item").filter({ hasText: "Fixture reviewer" }).click();
			} else if (editKind === "lock ABA") {
				await page.locator('.goalbar-row button[title^="Locked"]').click();
				await page.locator('.goalbar-row button[title^="This turn"]').click();
			} else {
				await page.locator('.goalbar-row button[title="Cancel"]').click();
				await open();
			}
			await call("settle", true);
			await stateIs("admitted");
			await retained(kind, target, editKind === "text" ? "Newer browser draft" : RAW);
		}
		for (const result of ["true", "false", "reject"]) {
			const target = await setup("new");
			await start(kind).click();
			await stateIs("pending");
			await call("target", `${target}-B`);
			await open();
			assert.equal(await input.inputValue(), "");
			await input.fill("Independent B draft");
			await call("target", target);
			await input.waitFor();
			await retained(kind, target);
			if (result === "reject") await call("fail");
			else await call("settle", result === "true");
			await stateIs(result === "true" ? "admitted" : result === "false" ? "refused" : "uncertain");
			await retained(kind, target);
			await call("target", `${target}-B`);
			await input.waitFor();
			assert.equal(await input.inputValue(), "Independent B draft");
			checks++;
		}
		for (const settleBeforeMount of [true, false]) {
			const target = await setup("new");
			await start(kind).click();
			await stateIs("pending");
			await call("unmount");
			if (settleBeforeMount) await call("settle", true);
			await call("mount");
			await input.waitFor();
			if (!settleBeforeMount) {
				await input.press("Enter");
				await call("settle", true);
			}
			await stateIs("admitted");
			await retained(kind, target);
		}
		for (const wizard of [false, true]) {
			const target = await setup("new");
			await start(kind).click();
			await stateIs("pending");
			await call("active", wizard);
			await page.locator(".goalbar-active").waitFor();
			await call("idle");
			await input.waitFor();
			await call("settle", true);
			await stateIs("admitted");
			await retained(kind, target);
		}
	}
	// Explicit live read/control witnesses; no generic admission or replay.
	await setup("new", "pending", true);
	await page.locator(".dropdown > button").click();
	await page.locator(".dd-refresh").click();
	await page.locator(".dd-item").click();
	await page.locator('.goalbar-row button[title^="Locked"]').click();
	await rounds.fill("9");
	await rounds.press("Enter");
	await call("active");
	await page.locator(".goalbar-x").click();
	const controls = await snapshot();
	assert.deepEqual(controls.admitted, []);
	assert.deepEqual(
		new Set(controls.live.map((msg) => msg.type)),
		new Set(["list_models", "set_goal_prefs", "clear_goal"]),
	);
	await call("idle");
	await input.waitFor();
	assert.equal(await input.inputValue(), RAW);
	checks++;
	assert.deepEqual(errors, []);
	console.log(
		`H-GOAL-ADMISSION-1 browser HIT: ${checks} complete-intent/UI checks; ${losses} genuine pinned-old loss controls; no page errors.`,
	);
} finally {
	await browser?.close();
	await new Promise((resolve) => server.close(resolve));
}
