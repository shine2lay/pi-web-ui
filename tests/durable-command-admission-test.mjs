/* #594 / H-COMMAND-OWNERSHIP-1: native Chromium, actual components + actual xterm.
 * Transport and host owner are inert recording boundaries: no app server, PTY, shell or model.
 * Loss/duplicate controls load all three genuine old components from one pinned git object.
 * Run: scripts/sealed.sh node tests/durable-command-admission-test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const BASE = "4f32b06e2d2f8dec63a4258ac6575ba2cbac7b92";
const RAW = '  Synthetic browser commit: \\"quoted\\" `tag` $cash \\ path  ';
const CMD = {
	name: "  Synthetic browser command  ",
	command: "  synthetic-command --literal  ",
	cwd: "${pwd}/fixture",
};
const components = join(REPO, "web/src/components");
const originals = new Map(
	["SCMPanel", "TerminalPanel", "TermXterm"].map((name) => [
		name,
		execFileSync("git", ["show", `${BASE}:web/src/components/${name}.tsx`], { cwd: REPO, encoding: "utf8" }),
	]),
);
assert.match(originals.get("SCMPanel"), /terminal.restart\(existing.id\);\s*appSend\(/);
assert.match(originals.get("SCMPanel"), /setCommitHistory\(rememberCommitMessage\(msg\)\);\s*setCommitMsg\(""\)/);
assert.match(originals.get("TermXterm"), /if \(command\) \{\s*appSend\(\{\s*type: "run_command"/);

const entry = `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ScmPanel } from "./web/src/components/SCMPanel";
import { TerminalPanel } from "./web/src/components/TerminalPanel";
import { ScmPanel as OldScmPanel } from "old:SCMPanel";
import { TerminalPanel as OldTerminalPanel } from "old:TerminalPanel";
import { LanguageProvider } from "./web/src/i18n";
import { setAppSend } from "./web/src/app-globals";
const COMMAND = ${JSON.stringify(CMD)};
const root = createRoot(document.getElementById("root"));
let current; let epoch = 0; let ownerScope = false;
const copy = value => structuredClone(value);
function render() {
  const S = current.mode === "old" ? OldScmPanel : ScmPanel;
  const T = current.mode === "old" ? OldTerminalPanel : TerminalPanel;
  flushSync(() => root.render(<LanguageProvider><div key={epoch}><S {...current.props} active={false}/><T {...current.props}/></div></LanguageProvider>));
}
function mount(mode = "fixed", options = {}) {
  flushSync(() => root.render(null)); epoch++;
  localStorage.clear(); sessionStorage.clear();
  const host = { requests: [], frozen: [], pending: [], events: [], wire: [], output: {}, processes: {}, attaches: [], attachPending: [] };
  const chat = { ready: true, status: "open", activeConversationId: "fixture-conversation-a", state: { conversationId: "fixture-conversation-a", sessionId: "fixture-session-a", cwd: "/synthetic/workspace-a" }, commands: [copy(COMMAND)], terminals: [], scmDirty: 0, scmData: null };
  if (options.existing) chat.terminals.push({ id: "fixture-terminal-a", conversationId: "fixture-conversation-a", title: options.terminalTitle || "git commit", cwd: "/synthetic/workspace-a", cols: 113, rows: 39, running: !options.dead, exitCode: options.dead ? 9 : null, command: { name: "synthetic previous", command: "synthetic-previous", cwd: "old" } });
  if (options.foreign && chat.terminals[0]) chat.terminals[0][options.foreign === "conversation" ? "conversationId" : "cwd"] = options.foreign === "conversation" ? "fixture-foreign" : "/synthetic/foreign";
  if (options.noCwd) delete chat.commands[0].cwd;
  if (options.emptyCwd) chat.commands[0].cwd = "";
  if (options.mismatch) chat.activeConversationId = "fixture-incoherent";
  const event = (type, data = {}) => host.events.push({ type, by: ownerScope ? "owner" : "component", ...copy(data) });
  const terminal = {
    create(meta) { event("create", { meta }); chat.terminals.push(copy(meta)); render(); },
    restart(id) { event("restart", { id }); host.processes[id] = (host.processes[id] || 0) + 1; chat.terminals = chat.terminals.map(t => t.id === id ? { ...t, running: true, exitCode: null } : t); render(); },
    select(id) { event("select", { id }); chat.terminalActiveId = id; render(); },
    close(id) { event("close", { id }); chat.terminals = chat.terminals.filter(t => t.id !== id); render(); },
    register(conversationId, id, writer) { host.output[id] = writer; return () => { delete host.output[id]; }; }
  };
  setAppSend(message => {
    host.wire.push({ by: ownerScope ? "owner" : "component", message: copy(message) });
    if (message.type === "run_command") event("dispatch", { message });
    return options.transport === true;
  });
  const callback = request => {
    host.requests.push(request); event("request", { request });
    host.frozen.push([request, request.command, request.terminal, request.commitSource].filter(Boolean).every(Object.isFrozen));
    if (options.sync) return true;
    if (options.void) return undefined;
    if (options.throw) throw new Error("synthetic ownership unavailable");
    return new Promise((resolve, reject) => host.pending.push({ resolve, reject, request }));
  };
  const onAttachTerminal = (request, replaceOutput) => {
    host.attaches.push({ request, frozen: Object.isFrozen(request) });
    if (options.attachDeferred) return new Promise((resolve, reject) => host.attachPending.push({ request, replaceOutput, resolve, reject }));
    if (options.attachReject) return Promise.reject(new Error("synthetic attach unavailable"));
    if (!options.attachNoReplay) replaceOutput(options.retainedOutput || "");
    return Promise.resolve(!options.attachFalse);
  };
  current = { mode, options, props: { chat, terminal, onCommandIntent: options.unsupported ? undefined : callback, onAttachTerminal: options.attachUnsupported ? undefined : onAttachTerminal, onSwitchToTerminal() { event("view"); } }, host };
  render();
}
window.fixture = {
  mount,
  async frames() { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); },
  report() { return { requests: current.host.requests, frozen: current.host.frozen, wire: current.host.wire, events: current.host.events, processes: current.host.processes, history: localStorage.getItem("scm-commit-history"), local: Object.keys(localStorage), session: Object.keys(sessionStorage), attaches: current.host.attaches, attachStates: [...document.querySelectorAll(".term-xterm")].map(e => e.dataset.attachState) }; },
  async attach(index, value, text = "", reject = false) {
    const p = current.host.attachPending[index];
    p.replaceOutput(text);
    if (reject) p.reject(new Error("synthetic attach unavailable")); else p.resolve(value);
    await Promise.resolve(); await Promise.resolve();
  },
  async settle(value, reject = false, dispatch = false) {
    const pending = current.host.pending[0];
    if (dispatch) {
      ownerScope = true;
      const r = pending.request;
      current.host.events.push({ type: "checkpoint", by: "owner", requestId: r.requestId });
      if (r.terminal.mode === "existing") current.props.terminal.restart(r.terminal.id);
      else current.props.terminal.create({ id: r.terminal.id, conversationId: r.conversationId, title: r.terminal.title, cwd: r.terminal.cwd, cols: r.terminal.cols, rows: r.terminal.rows, command: copy(r.command), running: true, exitCode: null });
      current.host.events.push({ type: "dispatch", by: "owner", requestId: r.requestId });
      ownerScope = false;
    }
    if (reject) pending.reject(new Error("synthetic ownership rejected")); else pending.resolve(value);
    await Promise.resolve(); await Promise.resolve();
  },
  change(kind) {
    const c = current.props.chat;
    if (kind === "conversation") { c.activeConversationId = "fixture-conversation-b"; c.state = { ...c.state, conversationId: c.activeConversationId }; }
    if (kind === "workspace") c.state = { ...c.state, cwd: "/synthetic/workspace-b" };
    if (kind === "session") c.state = { ...c.state, sessionId: "fixture-session-b" };
    if (kind === "restore") { c.activeConversationId = "fixture-conversation-a"; c.state = { ...c.state, conversationId: c.activeConversationId, sessionId: "fixture-session-a", cwd: "/synthetic/workspace-a" }; }
    if (kind === "command") c.commands[0].command = "synthetic newer command settings";
    render();
  },
  remount() { flushSync(() => root.render(null)); epoch++; render(); },
  output(text) { Object.values(current.host.output)[0]?.write(text); },
  commit(times = 2) { const b = document.querySelector(".scm-view .btn.primary"); for (let i = 0; i < times; i++) b.click(); },
  forgetEvents() { current.host.events.length = 0; current.host.wire.length = 0; },
  async shell() { const buttons = [...document.querySelectorAll(".terminal-view button")]; buttons.find(b => b.title === "New terminal").click(); await this.frames(); }
};
mount();
`;
const built = await build({
	stdin: { contents: entry, resolveDir: REPO, sourcefile: "durable-command-admission-fixture.tsx", loader: "tsx" },
	bundle: true,
	write: false,
	format: "iife",
	platform: "browser",
	jsx: "automatic",
	loader: { ".css": "empty" },
	define: { "process.env.NODE_ENV": '"development"' },
	plugins: [
		{
			name: "genuine-pinned-command-components",
			setup(builder) {
				builder.onResolve({ filter: /^old:/ }, (args) => ({ path: args.path.slice(4), namespace: "old-command" }));
				builder.onResolve({ filter: /^\.\/TermXterm$/ }, (args) =>
					args.namespace === "old-command" ? { path: "TermXterm", namespace: "old-command" } : undefined,
				);
				builder.onLoad({ filter: /.*/, namespace: "old-command" }, (args) => ({
					contents: originals.get(args.path),
					loader: "tsx",
					resolveDir: components,
				}));
			},
		},
	],
});
const server = createServer((req, res) => {
	if (req.url === "/fixture.js")
		return res.writeHead(200, { "content-type": "text/javascript" }).end(built.outputFiles[0].text);
	res
		.writeHead(200, { "content-type": "text/html" })
		.end(
			'<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic command owner</title><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
		);
});
let browser;
let checks = 0;
try {
	assert.ok(CHROME_PATH, "native proof needs isolated Chromium");
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = server.address().port;
	assert.ok(port >= 8900);
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
	const editor = page.locator(".scm-commit-input");
	const frames = () => page.evaluate(() => window.fixture.frames());
	const report = () => page.evaluate(() => window.fixture.report());
	const mount = async (options = {}, mode = "fixed") => {
		await page.evaluate(({ options, mode }) => window.fixture.mount(mode, options), { options, mode });
		await frames();
	};
	const submit = async (times = 2) => {
		await editor.fill(RAW);
		await page.evaluate((times) => window.fixture.commit(times), times);
		await frames();
	};
	const settle = async (value, reject = false, dispatch = false) => {
		await page.evaluate(({ value, reject, dispatch }) => window.fixture.settle(value, reject, dispatch), {
			value,
			reject,
			dispatch,
		});
		await frames();
	};
	const processEvents = (r) =>
		r.events.filter((e) => ["restart", "create", "select", "view", "dispatch"].includes(e.type));
	const keep = async () => {
		const r = await report();
		assert.equal(await editor.inputValue(), RAW);
		assert.equal(r.history, null);
		assert.deepEqual(processEvents(r), []);
		checks += 3;
		return r;
	};

	for (const options of [
		{ existing: true },
		{ existing: true, dead: true },
		{},
		{ existing: true, foreign: "conversation" },
		{ existing: true, foreign: "workspace" },
	]) {
		await mount(options);
		await submit();
		const r = await keep();
		assert.equal(r.requests.length, 1);
		assert.deepEqual(r.frozen, [true]);
		const request = r.requests[0];
		assert.equal(request.commitSource.text, RAW);
		assert.equal(request.commitSource.revision, 1);
		assert.equal(request.conversationId, "fixture-conversation-a");
		assert.equal(request.sessionId, "fixture-session-a");
		assert.equal(request.workspaceCwd, "/synthetic/workspace-a");
		assert.equal(request.command.name, "git commit");
		assert.equal(request.command.cwd, "${pwd}");
		const expectedCommand = `git commit -m "${RAW.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "\\`").replace(/\$/g, "\\$")}"`;
		assert.equal(request.command.command, expectedCommand);
		const reused = options.existing && !options.foreign;
		assert.equal(request.terminal.mode, reused ? "existing" : "new");
		assert.equal(request.terminal.cwd, "/synthetic/workspace-a");
		assert.equal(request.terminal.cols, reused ? 113 : 80);
		assert.equal(request.terminal.rows, reused ? 39 : 24);
		assert.equal(request.terminal.id === "fixture-terminal-a", !!reused);
		checks += 15;
		await settle(false);
		await keep();
	}
	for (const value of [undefined, null, "true", 1, { owned: true }]) {
		await mount({ existing: true });
		await submit();
		await settle(value);
		await keep();
	}
	for (const options of [{ unsupported: true }, { sync: true }, { void: true }, { throw: true }, { mismatch: true }]) {
		await mount({ existing: true, ...options });
		await submit();
		await keep();
		if (options.unsupported || options.mismatch) {
			assert.equal((await report()).requests.length, 0);
			checks++;
		}
	}
	await mount({ existing: true });
	await submit();
	await settle(false, true);
	await keep();

	for (const existing of [false, true]) {
		await mount({ existing });
		await submit();
		await settle(true, false, true);
		const r = await report();
		assert.equal(await editor.inputValue(), "");
		assert.deepEqual(JSON.parse(r.history), [RAW.trim()]);
		assert.deepEqual(
			r.events.map((e) => e.type),
			["request", "checkpoint", existing ? "restart" : "create", "dispatch", "select", "view"],
		);
		assert.equal(r.events.filter((e) => e.type === "dispatch").length, 1);
		assert.equal(r.events.find((e) => e.type === "dispatch").by, "owner");
		assert.equal(r.wire.filter((e) => e.message.type === "run_command").length, 0);
		checks += 6;
		await page.evaluate(() => window.fixture.remount());
		await frames();
		assert.equal((await report()).events.filter((e) => e.type === "dispatch").length, 1);
		checks++;
	}
	for (const kind of ["edit", "aba", "conversation", "workspace", "session", "target-aba", "remount"]) {
		await mount();
		await submit();
		let expected = RAW;
		if (kind === "edit" || kind === "aba") {
			await editor.fill("synthetic newer browser draft");
			expected = "synthetic newer browser draft";
		}
		if (kind === "aba") {
			await editor.fill(RAW);
			expected = RAW;
		}
		if (["conversation", "workspace", "session", "target-aba"].includes(kind)) {
			await page.evaluate((kind) => window.fixture.change(kind === "target-aba" ? "conversation" : kind), kind);
			if (kind === "target-aba") await page.evaluate(() => window.fixture.change("restore"));
		}
		if (kind === "remount") {
			await page.evaluate(() => window.fixture.remount());
			await editor.fill("synthetic new mount draft");
			expected = "synthetic new mount draft";
		}
		await settle(true);
		const r = await report();
		assert.equal(await editor.inputValue(), expected);
		assert.equal(r.history, null);
		checks += 2;
		if (!["edit", "aba"].includes(kind)) {
			assert.deepEqual(processEvents(r), []);
			checks++;
		}
	}
	for (const options of [
		{},
		{ noCwd: true },
		{ emptyCwd: true },
		{ existing: true, terminalTitle: CMD.name },
		{ existing: true, dead: true, terminalTitle: CMD.name },
	]) {
		await mount(options);
		await page.evaluate(() => {
			document.querySelector(".cmd-run").click();
			document.querySelector(".cmd-main").click();
		});
		const r = await report();
		assert.equal(r.requests.length, 1);
		assert.equal(r.requests[0].source, "terminal");
		const cmd = { ...CMD };
		if (options.noCwd) delete cmd.cwd;
		if (options.emptyCwd) cmd.cwd = "";
		assert.deepEqual(r.requests[0].command, cmd);
		assert.equal(r.requests[0].commitSource, undefined);
		assert.deepEqual(processEvents(r), []);
		checks += 5;
		await page.evaluate(() => window.fixture.change("command"));
		assert.deepEqual((await report()).requests[0].command, cmd);
		checks++;
		await settle(false);
		assert.deepEqual(processEvents(await report()), []);
		checks++;
	}
	await mount({ existing: true });
	await page.evaluate(() => window.fixture.output("synthetic visible output"));
	await frames();
	assert.ok((await page.locator(".xterm-screen").innerText()).includes("synthetic visible output"));
	checks++;
	await page.locator(".xterm-helper-textarea").pressSequentially("synthetic PTY input");
	await page.locator(".xterm-helper-textarea").press("Enter");
	await frames();
	assert.ok((await report()).wire.some((e) => e.message.type === "terminal_input"));
	assert.ok((await report()).wire.some((e) => e.message.type === "terminal_resize"));
	checks += 2;
	await page.locator(".term-tab-rename").click();
	await page.locator(".term-tab-rename-input").fill("Synthetic browser rename");
	await page.locator(".term-tab-rename-input").press("Enter");
	await page.locator(".term-tab-close:not(.term-tab-rename)").click();
	let io = await report();
	assert.ok(io.wire.some((e) => e.message.type === "rename_terminal"));
	assert.ok(io.wire.some((e) => e.message.type === "terminal_kill"));
	assert.equal(io.requests.length, 0);
	checks += 3;
	await mount({ transport: true });
	await page.evaluate(() => window.fixture.shell());
	io = await report();
	assert.equal(io.wire.filter((e) => e.message.type === "terminal_create").length, 1);
	const shell = io.wire.find((e) => e.message.type === "terminal_create").message;
	assert.equal(shell.locale, "en");
	assert.equal(shell.agentBash, undefined);
	assert.equal(io.requests.length, 0);
	assert.deepEqual(io.local, []);
	assert.deepEqual(io.session, []);
	checks += 6;

	// Native attach-only contracts: registration is NOT an attachment receipt.
	for (const options of [
		{ attachUnsupported: true },
		{ attachFalse: true },
		{ attachReject: true },
		{ attachNoReplay: true },
		{ attachDeferred: true },
	]) {
		await mount({ existing: true, ...options });
		const r = await report();
		assert.deepEqual(r.attachStates, [options.attachDeferred ? "pending" : "unavailable"]);
		await page.locator(".xterm-helper-textarea").press("Enter");
		await frames();
		assert.equal(
			(await report()).wire.filter((e) =>
				["terminal_input", "terminal_create", "run_command", "terminal_kill"].includes(e.message.type),
			).length,
			0,
		);
		checks += 2;
		if (!options.attachUnsupported) {
			assert.equal(r.attaches.length, 1);
			assert.equal(r.attaches[0].frozen, true);
			assert.equal(r.attaches[0].request.conversationId, "fixture-conversation-a");
			assert.equal(r.attaches[0].request.sessionId, "fixture-session-a");
			assert.equal(r.attaches[0].request.terminalId, "fixture-terminal-a");
			checks += 5;
		}
	}
	for (const kind of ["remount", "session", "conversation"]) {
		await mount({ existing: true, attachDeferred: true });
		if (kind === "remount") await page.evaluate(() => window.fixture.remount());
		else await page.evaluate((kind) => window.fixture.change(kind), kind);
		await frames();
		await page.evaluate(() => window.fixture.attach(0, true, "SYNTHETIC_STALE_REPLAY"));
		await frames();
		assert.ok(!(await page.locator(".xterm-screen").innerText()).includes("SYNTHETIC_STALE_REPLAY"));
		assert.equal(
			(await report()).wire.filter((e) => ["terminal_input", "run_command", "terminal_create"].includes(e.message.type))
				.length,
			0,
		);
		checks += 2;
		if (kind !== "conversation") {
			const before = await report();
			assert.equal(before.attaches.length, 2);
			assert.notEqual(before.attaches[0].request.viewId, before.attaches[1].request.viewId);
			await page.evaluate(() => window.fixture.attach(1, true, "SYNTHETIC_CURRENT_REPLAY"));
			await frames();
			assert.ok((await page.locator(".xterm-screen").innerText()).includes("SYNTHETIC_CURRENT_REPLAY"));
			assert.deepEqual((await report()).attachStates, ["attached"]);
			checks += 4;
		}
	}

	// Actual baseline loss controls, including a transport-accepted send that still has no ownership result.
	for (const transport of [false, true]) {
		await mount({ existing: true, transport }, "old");
		await page.evaluate(() => window.fixture.forgetEvents());
		await submit(1);
		const r = await report();
		assert.equal(await editor.inputValue(), "");
		assert.deepEqual(JSON.parse(r.history), [RAW.trim()]);
		assert.equal(r.requests.length, 0);
		assert.ok(r.events.some((e) => e.type === "restart"));
		assert.equal(r.wire.filter((e) => e.message.type === "run_command").length, 1);
		checks += 5;
		await page.evaluate(() => window.fixture.remount());
		await frames();
		assert.equal((await report()).wire.filter((e) => e.message.type === "run_command").length, 2);
		checks++;
	}
	await mount({ existing: true }, "old");
	await page.evaluate(() => window.fixture.forgetEvents());
	await submit(2);
	assert.equal((await report()).wire.filter((e) => e.message.type === "run_command").length, 2);
	checks++;
	await mount({}, "old");
	await submit(1);
	assert.equal((await report()).wire.filter((e) => e.message.type === "run_command").length, 1);
	await page.evaluate(() => window.fixture.remount());
	await frames();
	assert.equal((await report()).wire.filter((e) => e.message.type === "run_command").length, 2);
	checks += 2;
	assert.deepEqual(errors, []);
	checks++;
	const hashes = Object.fromEntries(
		[...originals].map(([name, source]) => [name, createHash("sha256").update(source).digest("hex")]),
	);
	console.log(
		JSON.stringify(
			{
				result: "HIT",
				hypothesis: "H-COMMAND-OWNERSHIP-1",
				nativeChecks: checks,
				baseline: BASE,
				oldSourceSha256: hashes,
				realHostPersistenceProved: false,
				ptyOrModelCalls: 0,
			},
			null,
			2,
		),
	);
} finally {
	await browser?.close();
	await new Promise((resolve) => server.close(resolve));
}
