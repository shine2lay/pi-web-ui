/* Ops #588: real Message/MessageList, isolated Chromium, synthetic inputs only.
 * scripts/sealed.sh node tests/durable-message-edit-test.mjs
 * No live app/server/profile/model. Missing browser or pinned old source fails loudly. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

assert.ok(CHROME_PATH, "BLOCKED: isolated Chromium is required; never use the owner's profile");
const root = fileURLToPath(new URL("..", import.meta.url));
const base = "48cec10e20ecc3870f0e2422fb990160c00e215d";
// Behavioral negative control: compile and mount the actual unchanged pre-fix component.
const oldSource = execFileSync("git", ["-C", root, "show", `${base}:web/src/components/Message.tsx`], {
	encoding: "utf8",
});
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=";
const authored = "  keep é 🌈\nsecond line\t  ";
const atts = [
	{ path: "", imageData: png, mimeType: "image/png", name: "像.png", size: 68 },
	{
		path: "",
		imageUrl: "/api/chat-image?conversationId=c-a&sessionId=s-a&id=image-a",
		mimeType: "image/png",
		name: "lazy.png",
		size: 19,
	},
	{ path: "", uploadPath: "uploads/original.bin", name: "zero.bin", size: 0, mimeType: "application/octet-stream" },
	{ path: "", fileData: "AAEC/w==", name: "raw.bin", mimeType: "application/octet-stream", size: 4 },
	{ path: "src/one.ts", mode: "reference", name: "reference" },
	{ path: "src/two.ts", mode: "lines", lines: { start: 2, end: 9 }, name: "lines" },
	{ path: "https://example.invalid", mode: "page", name: "Granted page" },
	{
		path: "",
		mode: "conversation",
		conversationId: "c-quoted",
		sessionPath: "/synthetic/quoted.jsonl",
		name: "Quoted",
	},
	{ path: "legacy.txt", mode: "inline" },
];
const entry = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Message } from "./web/src/components/Message";
import { MessageList } from "./web/src/components/MessageList";
import { Message as LegacyMessage } from "legacy:message";
import { LanguageProvider } from "./web/src/i18n";
import { getContextMenu } from "./web/src/context-menu-state";
const atts = ${JSON.stringify(atts)};
const question = (id = "u-a", text = "original question") => ({ id, role: "user", content: [{type:"text",text}] });
let root, props, calls = [], legacyCalls = 0, pending = [], options = {};
function callback(mode) {
  if (mode === "missing") return undefined;
  return (id, text, attachments) => {
    calls.push(structuredClone({id, text, attachments}));
    if (mode === "throw") throw new Error("synthetic attachment resolution failure");
    return new Promise((resolve, reject) => pending.push({resolve, reject}));
  };
}
function render() {
  const Component = options.legacy ? LegacyMessage : options.list ? MessageList : Message;
  flushSync(() => root.render(createElement(LanguageProvider, null, createElement(Component, props))));
}
window.fixture = {
  mount(config = {}) {
    if (root) flushSync(() => root.unmount());
    document.querySelector("#root").replaceChildren();
    root = createRoot(document.querySelector("#root")); calls = []; legacyCalls = 0; pending = []; options = config;
    const onEditAdmit = callback(config.mode);
    const common = { onEditAdmit, editContextKey: "parent-c-a/s-a/g1", onEdit: () => { legacyCalls++; }, toolStatuses: new Map(), liveOutputs: new Map() };
    props = config.list ? {
      ...common,
      state: {clientId:"synthetic",cwd:"/synthetic",conversationId:"c-a",sessionId:"s-a",rev:1,messages:[question()],streamingMessage:null,isStreaming:false,model:null,thinkingLevel:"off",availableThinkingLevels:[],queue:{steering:[],followUp:[]}}
    } : { ...common, message: question("u-a", config.originalText ?? "original question"), toolResults:new Map(),streaming:false,isLast:true,questionAttachments:structuredClone(atts) };
    if (config.noBinding) delete props.editContextKey;
    render();
  },
  patch(patch) { props = {...props, ...patch}; render(); },
  changeSession(sessionId) { props = {...props, state: {...props.state, sessionId}}; render(); },
  unmount() { flushSync(() => root.unmount()); root = null; },
  result(value, reject = false) { const operation = pending.shift(); if (!operation) throw new Error("no pending admission"); if (reject) operation.reject(new Error("synthetic image load failure")); else operation.resolve(value); },
  calls() { return {calls, legacyCalls}; },
  directTwice() {
    document.querySelector(".msg").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true}));
    const menu = getContextMenu(); const entry = menu.entries.find(e => e.id === "host:msg-ctx-reask");
    menu.onHostAction(entry, menu.target); menu.onHostAction(entry, menu.target);
  },
  duplicate() {
    const input = document.querySelector("textarea"); const button = document.querySelector(".msg-editor-actions .primary");
    input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true}));
    input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",metaKey:true,bubbles:true}));
    button.click();
  }
};
window.fixtureReady = true;
`;
const bundle = await build({
	absWorkingDir: root,
	stdin: { contents: entry, resolveDir: root, sourcefile: "durable-message-fixture.tsx", loader: "tsx" },
	bundle: true,
	format: "esm",
	platform: "browser",
	write: false,
	jsx: "automatic",
	define: { "process.env.NODE_ENV": '"production"' },
	loader: { ".css": "empty" },
	plugins: [
		{
			name: "actual-pinned-old-message",
			setup(b) {
				b.onResolve({ filter: /^legacy:message$/ }, () => ({ path: "old-message.tsx", namespace: "negative" }));
				b.onLoad({ filter: /.*/, namespace: "negative" }, () => ({
					contents: oldSource,
					loader: "tsx",
					resolveDir: dirname(join(root, "web/src/components/Message.tsx")),
				}));
			},
		},
	],
});
const server = createServer((req, res) => {
	if (req.url === "/fixture.js") {
		res.writeHead(200, { "content-type": "text/javascript" });
		res.end(bundle.outputFiles[0].text);
	} else if (req.url?.startsWith("/api/chat-image?")) {
		res.writeHead(200, { "content-type": "image/png" });
		res.end(Buffer.from(png, "base64"));
	} else if (req.url === "/") {
		res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
		res.end(
			'<!doctype html><title>Synthetic Message admission</title><div id="root"></div><script type="module" src="/fixture.js"></script>',
		);
	} else {
		res.writeHead(404);
		res.end();
	}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string" && address.port >= 8900);
const origin = `http://127.0.0.1:${address.port}`;
const errors = [];
let browser;
let assertions = 0;
try {
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
	const context = await browser.newContext();
	await context.route("**/*", (route) =>
		route.request().url().startsWith(`${origin}/`) || route.request().url().startsWith("data:")
			? route.continue()
			: route.abort(),
	);
	const page = await context.newPage();
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(origin);
	await page.waitForFunction(() => window.fixtureReady);
	const mount = (config = {}) => page.evaluate((config) => window.fixture.mount(config), config);
	const open = () => page.locator('button[title^="Edit this question"]').click();
	const fill = (text = authored) => page.locator("textarea.msg-editor-input").fill(text);
	const submit = () => page.locator(".msg-editor-actions .primary").click();
	const result = async (value, reject = false) => {
		await page.evaluate(({ value, reject }) => window.fixture.result(value, reject), { value, reject });
		await page.waitForFunction(() => !document.querySelector('[data-edit-admission="pending"]'));
	};
	const kept = async (text = authored, count = atts.length) => {
		assert.equal(await page.locator("textarea.msg-editor-input").inputValue(), text);
		assert.equal(await page.locator(".msg-editor-img").count(), count);
		assertions++;
	};
	const oneOriginal = async () => {
		const state = await page.evaluate(() => window.fixture.calls());
		assert.deepEqual(state, { calls: [{ id: "u-a", text: authored, attachments: atts }], legacyCalls: 0 });
		assert.equal(await page.locator("[data-edit-admission] pre").textContent(), authored);
		assert.equal(await page.locator("[data-edit-admission] li").count(), atts.length);
		assertions++;
	};

	await mount({ legacy: true });
	await open();
	await fill();
	await submit();
	assert.equal(await page.locator("textarea").count(), 0);
	assert.equal((await page.evaluate(() => window.fixture.calls())).legacyCalls, 1);
	console.log("PASS negative control: actual pinned old component closes immediately after a void callback");

	await mount({ mode: "missing" });
	await open();
	await fill();
	await submit();
	await kept();
	assert.deepEqual(await page.evaluate(() => window.fixture.calls()), { calls: [], legacyCalls: 0 });
	assert.match(await page.locator("[data-edit-admission]").textContent(), /nothing was submitted/);
	console.log(
		"PASS new component: missing explicit callback keeps exact text and all attachment forms; no void fallback",
	);

	await mount();
	await open();
	await fill();
	await page.evaluate(() => window.fixture.duplicate());
	await kept();
	await oneOriginal();
	await fill("  newer exact text\n ");
	await page.locator(".msg-editor-img-remove").first().click();
	await result(false);
	await kept("  newer exact text\n ", atts.length - 1);
	await oneOriginal();
	console.log(
		"PASS pending lazy-resolution-style delay, duplicate Enter/click lock, false result retains submitted original and newer draft",
	);

	for (const kind of ["success", "false", "reject", "nontrue", "throw"]) {
		await mount({ mode: kind === "throw" ? "throw" : "deferred" });
		await open();
		await fill();
		if (kind === "throw") await page.evaluate(() => window.fixture.duplicate());
		else await submit();
		if (kind !== "throw") {
			await kept();
			await oneOriginal();
			await result(kind === "success" ? true : kind === "nontrue" ? "true" : false, kind === "reject");
		}
		if (kind === "success") assert.equal(await page.locator("textarea").count(), 0);
		else {
			await kept();
			await oneOriginal();
			assert.match(await page.locator("[data-edit-admission]").textContent(), /not confirmed/);
		}
	}
	console.log(
		"PASS only resolved literal true closes unchanged editor; rejection/throw/nontrue preserve every original reference",
	);

	await mount();
	await open();
	await fill();
	await submit();
	await fill("B");
	await fill();
	await result(true);
	await kept();
	await mount();
	await open();
	await fill();
	await submit();
	await page.locator(".msg-editor-actions .chip:not(.primary)").click();
	await open();
	await fill("same-ID reopened");
	await result(true);
	await kept("same-ID reopened");
	console.log("PASS revision A-B-A and same-message reopen survive earlier successful admission");

	for (const target of ["message", "context ABA", "session ABA"]) {
		await mount({ list: target === "session ABA" });
		await open();
		await fill();
		await submit();
		if (target === "message")
			await page.evaluate(() =>
				window.fixture.patch({
					message: { id: "u-b", role: "user", content: [{ type: "text", text: "other question" }] },
				}),
			);
		else if (target === "context ABA") {
			await page.evaluate(() => window.fixture.patch({ editContextKey: "parent-b/g2" }));
			await page.evaluate(() => window.fixture.patch({ editContextKey: "parent-c-a/s-a/g1" }));
		} else {
			await page.evaluate(() => window.fixture.changeSession("s-b"));
			await page.evaluate(() => window.fixture.changeSession("s-a"));
		}
		assert.equal(await page.locator("textarea").inputValue(), authored);
		await page.locator(".msg-editor-actions .chip:not(.primary)").click();
		await open();
		await fill("new target draft");
		await result(true);
		await kept("new target draft", target === "session ABA" ? 0 : atts.length);
	}
	console.log("PASS message retarget, parent-generation A-B-A and actual MessageList session A-B-A fence old cleanup");

	await mount({ originalText: authored, mode: "throw" });
	await page.evaluate(() => window.fixture.directTwice());
	await oneOriginal();
	assert.match(await page.locator("[data-edit-admission]").textContent(), /not confirmed/);

	await mount({ originalText: authored });
	await page.evaluate(() => window.fixture.directTwice());
	await oneOriginal();
	await open();
	await fill("opened during direct reask");
	await result(false);
	await kept("opened during direct reask");
	await mount({ noBinding: true });
	await open();
	await fill();
	await submit();
	await kept();
	assert.equal((await page.evaluate(() => window.fixture.calls())).calls.length, 0);
	console.log(
		"PASS direct context reask is once-only and retains complete original; missing genuine generation refuses admission",
	);

	await mount();
	await open();
	await fill();
	await page.locator(".msg-editor").evaluate((el) => {
		const transfer = new DataTransfer();
		transfer.items.add(new File([new Uint8Array([0, 255, 1])], "new.bin", { type: "application/octet-stream" }));
		el.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
	});
	await page.waitForFunction(() => document.querySelectorAll(".msg-editor-img").length === 10);
	await submit();
	const dropped = (await page.evaluate(() => window.fixture.calls())).calls[0].attachments;
	assert.deepEqual(dropped, [
		...atts,
		{ path: "", fileData: "AP8B", name: "new.bin", size: 3, mimeType: "application/octet-stream" },
	]);
	await result(false);
	await kept(authored, atts.length + 1);
	console.log(
		"PASS native FileReader adds exact bytes/metadata before admission; failure retains new and original attachments",
	);

	await mount();
	await open();
	await fill();
	await submit();
	await page.evaluate(() => window.fixture.unmount());
	assert.equal(await page.locator("textarea").count(), 0);
	await result(true); // Pending ownership still exists in the parent; detached UI cannot clear anything.
	await mount();
	await open();
	await fill("new mount");
	await kept("new mount");
	assert.deepEqual(errors, [], "actual browser component runtime errors");
	console.log(
		`PASS ${assertions} preservation assertions, actual pre-fix negative control, no page errors; callback slice only`,
	);
} finally {
	if (browser) await browser.close();
	await new Promise((resolve) => server.close(resolve));
}
