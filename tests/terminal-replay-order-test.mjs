/* #597 / H-TERM-REPLAY-QUEUE-1: actual TermXterm + native xterm in isolated Chromium.
 * No PTY, app server, user profile, model, accounts or real session data.
 * Old control is the unaltered #594 component loaded directly from the pinned git object.
 * scripts/sealed.sh node tests/terminal-replay-order-test.mjs [--unit]
 * --unit includes the required .tsx test without changing the repository's .ts-only config.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const BASE = "c41a3bf975013bf2e4bd2f162815e8c4445353e2";
const COMPONENT = "web/src/components/TermXterm.tsx";
const ORIGINAL = execFileSync("git", ["show", `${BASE}:${COMPONENT}`], { cwd: REPO, encoding: "utf8" });
assert.match(ORIGINAL, /replaced = true;\s*term\.reset\(\);\s*term\.write\(stripExitBanner\(data\)\.clean\)/);
const oldHash = createHash("sha256").update(ORIGINAL).digest("hex");
const require = createRequire(import.meta.url);
const GATE = "\x1b[?997z";

async function unit() {
	const { startVitest } = await import("vitest/node");
	const files = [
		"tests/unit/terminal-replay-order.test.tsx",
		"tests/unit/durable-command-admission.test.ts",
		"tests/unit/scm-commit-history.test.ts",
		"tests/unit/scm-quote.test.ts",
		"tests/unit/scm-history-filter.test.ts",
		"tests/unit/scm-sidebar.test.ts",
		"tests/unit/term-touch.test.ts",
	];
	const ctx = await startVitest(
		files,
		{ root: REPO, config: join(REPO, "vitest.config.ts"), run: true, watch: false, maxWorkers: 2 },
		{ test: { include: ["tests/unit/**/*.test.{ts,tsx}"] } },
	);
	try {
		assert.equal(ctx.state.getFiles().length, files.length, "all focused files, including the .tsx suite, must run");
		assert.equal(ctx.state.getCountOfFailedTests(), 0);
		assert.equal(ctx.state.getUnhandledErrors().length, 0);
		assert.ok(ctx.state.getFiles().every((file) => file.result?.state === "pass"));
	} finally {
		await ctx.close();
	}
}

async function native() {
	const entry = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { TermXterm } from "./web/src/components/TermXterm";
import { TermXterm as OldTermXterm } from "old:TermXterm";
import { LanguageProvider } from "./web/src/i18n";
import { setAppSend } from "./web/src/app-globals";
window.__terminals = [];
const root = createRoot(document.getElementById("root"));
let current; let epoch = 0;
function render() {
  const View = current.mode === "old" ? OldTermXterm : TermXterm;
  flushSync(() => root.render(<LanguageProvider><View key={epoch} {...current.props}/></LanguageProvider>));
}
function lines(term) {
  const buffer = term.buffer.active;
  const result = Array.from({length: buffer.length}, (_, i) => buffer.getLine(i).translateToString(true));
  while (result.at(-1) === "") result.pop();
  return result;
}
function mount(mode = "fixed", options = {}) {
  flushSync(() => root.render(null)); epoch++;
  const host = { writers: [], attaches: [], wire: [], unregisters: 0 };
  const register = (cid, tid, writer) => {
    host.writers.push({cid, tid, writer});
    return () => { host.unregisters++; };
  };
  const attach = (intent, replace) => {
    const term = window.__terminals.at(-1);
    const record = { intent, replace, term, writer: host.writers.at(-1).writer, frozen: Object.isFrozen(intent), gateEntered: false, released: false };
    host.attaches.push(record);
    term.parser.registerCsiHandler({prefix: "?", final: "z"}, () => {
      record.gateEntered = true;
      return new Promise(resolve => { record.release = () => { record.released = true; resolve(true); }; });
    });
    if (options.kind === "throw") throw new Error("synthetic unavailable");
    if (options.kind === "reject") return Promise.reject(new Error("synthetic unavailable"));
    if (options.kind === "sync") { replace("SYNC-NOT-OWNED"); return true; }
    if (options.kind === "void") return;
    return new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
  };
  setAppSend(message => { host.wire.push(structuredClone(message)); return true; });
  current = { mode, host, props: {
    conversationId: options.kind === "conversation" ? "" : "fixture-conversation-a",
    sessionId: options.kind === "session" ? undefined : "fixture-session-a",
    terminalId: options.kind === "terminal" ? "" : "fixture-terminal-a",
    cwd: "/synthetic/workspace", title: "synthetic display only", command: {name: "synthetic metadata", command: "NEVER_EXECUTE"},
    active: true, running: options.stopped ? false : true, exitCode: 7,
    register, onAttachTerminal: options.kind === "missing" ? undefined : attach
  }};
  render();
}
window.fixture = {
  mount,
  report() {
    const term = window.__terminals.at(-1);
    return {
      state: document.querySelector(".term-xterm")?.dataset.attachState,
      disabled: term.options.disableStdin,
      lines: lines(term),
      wire: current.host.wire,
      attaches: current.host.attaches.map(r => ({intent: r.intent, frozen: r.frozen, gateEntered: r.gateEntered, released: r.released})),
      writers: current.host.writers.map(r => ({cid: r.cid, tid: r.tid})),
      unregisters: current.host.unregisters,
      rendererCount: window.__terminals.length,
      local: Object.keys(localStorage), session: Object.keys(sessionStorage),
      normalBuffer: term.buffer.active === term.buffer.normal
    };
  },
  sequence(index, options) {
    const r = current.host.attaches[index];
    for (const data of options.prefix || []) r.writer.write(data);
    if (Object.hasOwn(options, "snapshot")) r.replace(options.snapshot);
    for (const data of options.tails || []) r.writer.write(data);
    if (options.duplicate) r.replace("WRONG-REPLACEMENT");
    if (options.settle !== false) {
      if (options.reject) r.reject(new Error("synthetic refusal"));
      else r.resolve(Object.hasOwn(options, "result") ? options.result : true);
    }
  },
  settle(index, value = true) { current.host.attaches[index].resolve(value); },
  release(index) { current.host.attaches[index].release(); },
  async drain(index = current.host.attaches.length - 1) {
    // This is xterm's actual completion callback, never invoked by the fixture.
    await new Promise(resolve => current.host.attaches[index].term.write("", resolve));
  },
  async frames() { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); },
  patch(patch) { Object.assign(current.props, patch); render(); },
  unmount() { flushSync(() => root.render(null)); },
  remount() { flushSync(() => root.render(null)); epoch++; render(); },
  stale(index) {
    const r = current.host.attaches[index];
    r.replace("STALE-REPLACEMENT"); r.writer.write("STALE-WRITER"); r.writer.dispose(); r.resolve(true);
  },
  dispose(index) { current.host.attaches[index].writer.dispose(); },
  metadata() { Object.assign(current.props, {title: "new metadata", cwd: "/synthetic/metadata", command: {name: "new metadata", command: "STILL_NEVER_EXECUTE"}}); render(); }
};
mount();
`;
	const built = await build({
		stdin: { contents: entry, resolveDir: REPO, sourcefile: "terminal-replay-order-fixture.tsx", loader: "tsx" },
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		jsx: "automatic",
		loader: { ".css": "empty" },
		define: { "process.env.NODE_ENV": '"development"' },
		plugins: [
			{
				name: "pinned-source-and-native-terminal-observer",
				setup(builder) {
					builder.onResolve({ filter: /^old:TermXterm$/ }, () => ({ path: COMPONENT, namespace: "pinned-old" }));
					builder.onLoad({ filter: /.*/, namespace: "pinned-old" }, () => ({
						contents: ORIGINAL,
						loader: "tsx",
						resolveDir: join(REPO, "web/src/components"),
					}));
					builder.onResolve({ filter: /^@xterm\/xterm$/ }, () => ({
						path: "native-observer",
						namespace: "native-observer",
					}));
					builder.onLoad({ filter: /.*/, namespace: "native-observer" }, () => ({
						// Observe actual native instances; never override write/reset/parser/completion.
						contents: `import { Terminal as NativeTerminal } from ${JSON.stringify(require.resolve("@xterm/xterm"))}; export class Terminal extends NativeTerminal { constructor(options) { super({...options, allowProposedApi: true}); window.__terminals.push(this); } }`,
						loader: "js",
						resolveDir: REPO,
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
				'<!doctype html><html lang="en"><meta charset="utf-8"><title>Isolated replay fixture</title><style>#root{width:960px;height:480px}.term-xterm{height:100%}</style><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
			);
	});
	let browser;
	let checks = 0;
	const oldEvidence = {};
	try {
		assert.ok(CHROME_PATH, "native proof needs isolated Chromium");
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		assert.ok(server.address().port >= 8900);
		const origin = `http://127.0.0.1:${server.address().port}`;
		browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
		const page = await browser.newPage();
		const errors = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.route("**/*", (route) =>
			route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort(),
		);
		await page.goto(origin);
		await page.waitForFunction(() => !!window.fixture);
		const report = () => page.evaluate(() => window.fixture.report());
		const mount = async (options = {}, mode = "fixed") => {
			await page.evaluate(({ mode, options }) => window.fixture.mount(mode, options), { mode, options });
			await page.evaluate(() => window.fixture.frames());
			await page.waitForFunction(
				() => window.fixture.report().attaches.length > 0 || window.fixture.report().state === "unavailable",
			);
		};
		const sequence = (options, index = 0) =>
			page.evaluate(({ index, options }) => window.fixture.sequence(index, options), { index, options });
		const drain = (index = 0) => page.evaluate((index) => window.fixture.drain(index), index);
		const release = (index = 0) => page.evaluate((index) => window.fixture.release(index), index);
		const gated = (index = 0) =>
			page.waitForFunction((index) => window.fixture.report().attaches[index]?.gateEntered, index);
		const exact = async (expected, state = "attached") => {
			const r = await report();
			assert.deepEqual(r.lines, expected);
			assert.equal(r.state, state);
			assert.equal(r.disabled, state !== "attached");
			assert.equal(r.normalBuffer, true);
			assert.deepEqual(r.local, []);
			assert.deepEqual(r.session, []);
			assert.equal(
				r.wire.filter((m) => ["terminal_create", "run_command", "terminal_kill"].includes(m.type)).length,
				0,
			);
			checks += 7;
			return r;
		};
		const blocked = async () => {
			const before = await report();
			assert.equal(before.state, "pending");
			assert.equal(before.disabled, true);
			await page.locator(".xterm-helper-textarea").press("Enter");
			await page.evaluate(() => {
				window.fixture.patch({ active: false });
				window.fixture.patch({ active: true });
			});
			await page.evaluate(() => window.fixture.frames());
			assert.deepEqual((await report()).wire, []);
			checks += 3;
		};

		// Genuine old implementation, same turn, actual pending native writes.
		await mount({}, "old");
		await sequence({ prefix: ["LIVE-A"], snapshot: "HISTORY\r\nLIVE-A", tails: ["\r\nTAIL-1", "\r\nTAIL-2"] });
		await drain();
		let r = await report();
		assert.deepEqual(r.lines, ["LIVE-AHISTORY", "LIVE-A", "TAIL-1", "TAIL-2"]);
		assert.notDeepEqual(r.lines, ["HISTORY", "LIVE-A", "TAIL-1", "TAIL-2"]);
		oldEvidence.pendingPrefix = r.lines;
		checks += 2;
		await mount({}, "old");
		await sequence({ prefix: ["LIVE-A"], snapshot: `HISTORY\r\n${GATE}LIVE-A`, tails: ["\r\nTAIL"] });
		await gated();
		r = await report();
		assert.equal(r.state, "attached");
		assert.equal(r.disabled, false);
		assert.ok(r.wire.some((m) => m.type === "terminal_resize"));
		oldEvidence.prematureAttach = { state: r.state, disabled: r.disabled, bufferWhileBlocked: r.lines };
		checks += 3;
		await release();
		await drain();

		// Same known input against the corrected actual component.
		await mount();
		await sequence({
			prefix: ["LIVE-A"],
			snapshot: "HISTORY\r\nLIVE-A",
			tails: ["\r\nTAIL-1", "\r\nTAIL-2"],
			duplicate: true,
		});
		await drain();
		r = await exact(["HISTORY", "LIVE-A", "TAIL-1", "TAIL-2"]);
		assert.equal(r.attaches[0].frozen, true);
		assert.deepEqual(r.attaches[0].intent, {
			conversationId: "fixture-conversation-a",
			sessionId: "fixture-session-a",
			terminalId: "fixture-terminal-a",
			cols: r.attaches[0].intent.cols,
			rows: r.attaches[0].intent.rows,
			viewId: r.attaches[0].intent.viewId,
		});
		assert.ok(r.attaches[0].intent.cols > 0 && r.attaches[0].intent.rows > 0 && r.attaches[0].intent.viewId);
		checks += 3;
		await page.evaluate(() => window.fixture.metadata());
		assert.equal((await report()).attaches.length, 1);
		checks++;

		// A real asynchronous parser handler holds replay, not a guessed delay or mocked write.
		await mount();
		await sequence({ prefix: ["LIVE-A"], snapshot: `HISTORY\r\n${GATE}LIVE-A`, tails: ["\r\nTAIL-1", "\r\nTAIL-2"] });
		await gated();
		await blocked();
		await release();
		await drain();
		await exact(["HISTORY", "LIVE-A", "TAIL-1", "TAIL-2"]);
		await page.locator(".xterm-helper-textarea").press("Enter");
		r = await report();
		assert.equal(r.wire.filter((m) => m.type === "terminal_input").length, 1);
		assert.ok(r.wire.some((m) => m.type === "terminal_resize"));
		checks += 2;

		// Parser-completed replay does not substitute for host ownership.
		await mount();
		await sequence({ prefix: ["OLD"], snapshot: `HISTORY${GATE}`, tails: ["\r\nTAIL"], settle: false });
		await gated();
		await release();
		await drain();
		await blocked();
		await page.evaluate(() => window.fixture.settle(0, true));
		await exact(["HISTORY", "TAIL"]);

		// Parser/decoder state is discarded only at the snapshot boundary, never at later chunks.
		for (const prefix of ["\x1b[31", "\x1b]0;old-title", "\x1bP$qold-dcs", "\x1b(0q", "\x1b[?1049hALT", "\ud83e"]) {
			await mount();
			await sequence({
				prefix: [prefix],
				snapshot: "HISTORY 🦊漢字\r\nLINE-2",
				tails: [
					"\r\nTAIL-\ud83e",
					"\udd8a-漢字",
					"\r",
					"\nLAST-\x1b[3",
					"1mRED\x1b[0m",
					"\x1b]0;new-title",
					"\x07\r\nFIN",
				],
			});
			await drain();
			await exact(["HISTORY 🦊漢字", "LINE-2", "TAIL-🦊-漢字", "LAST-RED", "FIN"]);
		}
		await mount();
		await sequence({
			prefix: Array.from({ length: 128 }, (_, i) => `OLD-${i}\r\n`),
			snapshot: "HISTORY\r\nLIVE-A",
			tails: Array.from({ length: 180 }, (_, i) => `\r\nTAIL-${i}`),
		});
		await drain();
		await exact(["HISTORY", "LIVE-A", ...Array.from({ length: 180 }, (_, i) => `TAIL-${i}`)]);
		await mount();
		await sequence({ prefix: ["OLD"], snapshot: "", tails: ["TAIL"] });
		await drain();
		await exact(["TAIL"]);
		await mount();
		await sequence({ prefix: ["OLD"], snapshot: "" });
		await drain();
		await exact([]);

		// Both result orderings must remain read-only for every nonliteral result.
		for (const value of [false, null, 1, "true", { attached: true }, "reject"]) {
			await mount();
			await sequence({ snapshot: `RETAINED${GATE}`, result: value, reject: value === "reject" });
			await gated();
			r = await report();
			assert.equal(r.state, "unavailable");
			assert.equal(r.disabled, true);
			assert.deepEqual(r.wire, []);
			checks += 3;
			await release();
			await drain();
			await exact(["RETAINED"], "unavailable");
		}
		await mount();
		await sequence({ result: true }); // No actual replacement, including no fake empty replay.
		r = await report();
		assert.equal(r.state, "unavailable");
		assert.equal(r.disabled, true);
		assert.deepEqual(r.wire, []);
		await page.evaluate(() => window.fixture.sequence(0, { snapshot: "LATE-REPLAY", settle: false }));
		await drain();
		await exact([], "unavailable");
		checks += 3;

		for (const kind of ["missing", "session", "conversation", "terminal", "throw", "reject", "sync", "void"]) {
			await mount({ kind });
			await page.waitForFunction(() => window.fixture.report().state === "unavailable");
			r = await report();
			assert.equal(r.disabled, true);
			await page.locator(".xterm-helper-textarea").press("Enter");
			assert.deepEqual((await report()).wire, []);
			assert.equal(r.attaches.length, ["missing", "session", "conversation", "terminal"].includes(kind) ? 0 : 1);
			checks += 3;
		}

		// New view must work before the old held parser/result completes; old work cannot hold it hostage.
		for (const kind of ["remount", "session", "conversation", "terminal", "aba"]) {
			await mount();
			await sequence({ snapshot: `OLD${GATE}`, tails: ["OLD-TAIL"], settle: false });
			await gated();
			const oldView = (await report()).attaches[0].intent.viewId;
			await page.evaluate((kind) => {
				if (kind === "remount") window.fixture.remount();
				else if (kind === "session") window.fixture.patch({ sessionId: "fixture-session-b" });
				else if (kind === "terminal") window.fixture.patch({ terminalId: "fixture-terminal-b" });
				else {
					window.fixture.patch({ conversationId: "fixture-conversation-b" });
					if (kind === "aba") window.fixture.patch({ conversationId: "fixture-conversation-a" });
				}
			}, kind);
			await page.evaluate(() => window.fixture.frames());
			await page.waitForFunction(() => window.fixture.report().attaches.length === 2);
			r = await report();
			assert.notEqual(r.attaches[1].intent.viewId, oldView);
			assert.equal(r.state, "pending");
			assert.deepEqual(r.wire, []);
			checks += 3;
			await sequence({ snapshot: "NEW-HISTORY", tails: ["\r\nNEW-TAIL"] }, 1);
			await drain(1);
			await exact(["NEW-HISTORY", "NEW-TAIL"]);
			await page.evaluate(() => {
				window.fixture.stale(0);
				window.fixture.release(0);
			});
			await drain(1);
			await exact(["NEW-HISTORY", "NEW-TAIL"]);
		}
		await mount();
		await sequence({ snapshot: `OLD${GATE}` });
		await gated();
		await page.evaluate(() => {
			window.fixture.dispose(0);
			window.fixture.stale(0);
			window.fixture.release(0);
		});
		await page.waitForFunction(() => window.fixture.report().state === "unavailable");
		r = await report();
		assert.deepEqual(r.wire, []);
		assert.equal(r.state, "unavailable");
		checks += 2;

		for (const kind of ["stopped", "before-replay", "during-replay"]) {
			await mount({ stopped: kind === "stopped" });
			if (kind === "before-replay") await page.evaluate(() => window.fixture.patch({ running: false }));
			await sequence({
				prefix: ["OLD"],
				snapshot: `HISTORY\r\n${GATE}LIVE-A`,
				tails: kind === "during-replay" ? ["\r\nTAIL"] : [],
			});
			await gated();
			if (kind === "during-replay") await page.evaluate(() => window.fixture.patch({ running: false }));
			await release();
			await drain();
			await exact(["HISTORY", "LIVE-A", ...(kind === "during-replay" ? ["TAIL"] : []), "[Process exited with code 7]"]);
		}
		await mount({ stopped: true });
		await sequence({ snapshot: "HISTORY\r\n[pi-term-exit:7]\r\n" });
		await drain();
		await exact(["HISTORY", "", "[Process exited with code 7]"]);
		await mount({ stopped: true });
		await sequence({ snapshot: "HISTORY\x1b]0;unfinished-title" });
		await drain();
		await exact(["HISTORY", "[Process exited with code 7]"]);

		assert.deepEqual(errors, []);
		checks++;
		console.log(
			JSON.stringify(
				{
					result: "HIT",
					hypothesis: "H-TERM-REPLAY-QUEUE-1",
					nativeChecks: checks,
					oldSource: { commit: BASE, path: COMPONENT, sha256: oldHash },
					oldEvidence,
					actualNativeWriteResetOverridden: false,
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
}

if (process.argv.includes("--unit")) await unit();
else await native();
