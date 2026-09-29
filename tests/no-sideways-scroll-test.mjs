/**
 * no-sideways-scroll E2E (no tokens): the whole window never scrolls sideways.
 *
 * Something wider than the window (a long unbroken line, a long link, a wide code block or table, a
 * wide picture, a long path in a tool result, a long chat title, a long notice, side panels dragged
 * wide on a big screen) pushed the page wider, so the whole window got a horizontal scroll bar. This
 * test fills a chat and the workspace with all of those and looks at the page at window widths 1920,
 * 1440, 1280, 1024 and 768 and on a phone (390), with the side panels open, closed and dragged to
 * their widest, in the chat, terminal, git and files views. In every state:
 *  1. Nothing reaches past the window's right edge and the page can't be scrolled sideways
 *     (tests/lib/overflow-finder.mjs: the page's own guard doesn't count, so a new culprit fails here
 *     even though the guard keeps the window still).
 *  2. Wide things stay reachable: long lines and links wrap, code blocks, tables and tool output
 *     scroll inside their own box, and pictures fit.
 *  3. A long notice wraps inside the window.
 *  4. Menus that open near the right edge (extra folders, a file's context menu, the top bar's "more"
 *     menu, the slash menu) stay inside the window, so all of their buttons can be clicked.
 *
 * Usage: npm run build && scripts/sealed.sh node tests/no-sideways-scroll-test.mjs
 *   (sealed.sh passes variables only through `env`: scripts/sealed.sh env PI_OVERFLOW_ONLY=390 node …)
 *   PI_OVERFLOW_REPORT=1        list what overflows in every state and don't fail (for hunting)
 *   PI_OVERFLOW_SHOTS=<folder>  save a screenshot of every state (…-overflow.png when it overflows)
 *   PI_OVERFLOW_ONLY=1024,390   only these window widths
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { deflateSync, crc32 } from "node:zlib";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { describeOverflow, findOverflow } from "./lib/overflow-finder.mjs";
import { ownServer } from "./lib/own-server.mjs";
import { waitForStablePage } from "./lib/page-stability.mjs";
import { revealTopbarItem } from "./lib/topbar.mjs";

const REPORT = !!process.env.PI_OVERFLOW_REPORT;
const SHOTS = process.env.PI_OVERFLOW_SHOTS || "";
const ONLY = (process.env.PI_OVERFLOW_ONLY || "")
	.split(",")
	.map((s) => Number(s.trim()))
	.filter(Boolean);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "✓" : REPORT ? "·" : "✗ FAIL:"} ${name}${detail && !ok ? `\n${detail}` : ""}`);
	if (!ok && !REPORT) failures += 1;
}

// ---- wide content ----------------------------------------------------------------------------------
const LONG_WORD = `unbroken${"x".repeat(400)}end`;
const LONG_LINK = `https://example.com/${"a-long-path-segment/".repeat(24)}page?query=${"q".repeat(80)}`;
const LONG_PATH = `/home/someone/projects/${"a-folder-with-a-long-name/".repeat(10)}and-a-file-with-a-long-name.ts`;
const WIDE_CODE_LINE = `const wide = [${Array.from({ length: 60 }, (_, i) => `"item-${i}"`).join(", ")}];`;
const WIDE_TABLE = [
	`| ${Array.from({ length: 14 }, (_, i) => `Column number ${i} with a long header`).join(" | ")} |`,
	`|${" --- |".repeat(14)}`,
	...Array.from(
		{ length: 3 },
		(_, r) => `| ${Array.from({ length: 14 }, (_, i) => `cell-${r}-${i}-${"w".repeat(30)}`).join(" | ")} |`,
	),
].join("\n");
const WIDE_MATH = `$$\n${Array.from({ length: 90 }, (_, i) => `x_{${i}}`).join(" + ")}\n$$`;
const LONG_TITLE_WORDS = `A chat title that goes on and on ${"and on ".repeat(30)}until the end`;
const LONG_TITLE_UNBROKEN = `AChatTitleWithoutAnySpaces${"Unbroken".repeat(30)}`;
const LONG_CWD_NAME = `the-project-folder-with-a-rather-long-name-${"z".repeat(60)}`;
const LONG_FILE_NAME = `a-file-with-a-ridiculously-long-name-that-no-side-panel-can-show-on-one-line-${"f".repeat(90)}.ts`;
const LONG_DIR_NAME = `a-folder-with-an-extremely-long-name-${"d".repeat(120)}`;
const LONG_COMMAND_NAME = `a-terminal-command-with-a-long-name-${"c".repeat(80)}`;
const LONG_NOTICE = `A notice with a long unbroken word: ${LONG_WORD} and a long link ${LONG_LINK}`;

/** A real PNG, `width`×`height`, of stripes (compressed, so it stays small). */
function stripesPng(width, height) {
	const chunk = (type, data) => {
		const head = Buffer.alloc(4);
		head.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body) >>> 0);
		return Buffer.concat([head, body, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // RGB
	const row = width * 3 + 1;
	const raw = Buffer.alloc(row * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const on = Math.floor(x / 40) % 2 === 0;
			raw[y * row + 1 + x * 3] = on ? 90 : 30;
			raw[y * row + 2 + x * 3] = on ? 140 : 60;
			raw[y * row + 3 + x * 3] = on ? 220 : 90;
		}
	}
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const WIDE_PICTURE = { type: "image", data: stripesPng(3000, 200).toString("base64"), mimeType: "image/png" };

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (content, stopReason = "stop") => ({
	role: "assistant",
	content,
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-opus-4-8",
	usage,
	stopReason,
});
const toolResult = (id, name, content) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	content,
	isError: false,
});

/** Writes a chat file into pi's sessions folder for `cwd`; returns its path. */
function writeChat(agentDir, cwd, n, name, messages) {
	const dir = join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
	mkdirSync(dir, { recursive: true });
	const id = `0199a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
	const t0 = Date.now() - 3_600_000 + n * 60_000;
	const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(t0).toISOString(), cwd })];
	let parentId = null;
	messages.forEach((message, i) => {
		const entryId = `e${n}x${String(i).padStart(4, "0")}`;
		const ts = t0 + i * 1000;
		lines.push(
			JSON.stringify({
				type: "message",
				id: entryId,
				parentId,
				timestamp: new Date(ts).toISOString(),
				message: { ...message, timestamp: ts },
			}),
		);
		parentId = entryId;
	});
	lines.push(
		JSON.stringify({
			type: "session_info",
			id: `i${n}`,
			parentId,
			timestamp: new Date(t0 + 50_000).toISOString(),
			name,
		}),
	);
	const file = join(dir, `2026-09-29T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`);
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

function seedWideChat(agentDir, cwd) {
	const markdown = [
		`# A heading with an unbroken word ${LONG_WORD}`,
		`A paragraph with a very long unbroken word: ${LONG_WORD}`,
		`A long link: ${LONG_LINK}`,
		`The same as a link with text: [a link](${LONG_LINK}), and a path: ${LONG_PATH}`,
		`Inline code: \`${LONG_WORD}\``,
		"```ts",
		WIDE_CODE_LINE,
		WIDE_CODE_LINE,
		"```",
		"A plain code block:",
		"```",
		LONG_WORD,
		"```",
		WIDE_TABLE,
		`> A quote with ${LONG_WORD}`,
		`- A list item with ${LONG_WORD}`,
		`  - A nested list item with ${LONG_LINK}`,
		WIDE_MATH,
		`Inline math: $${Array.from({ length: 50 }, (_, i) => `y_{${i}}`).join("+")}$`,
	].join("\n\n");
	const calls = [
		{ type: "toolCall", id: "call_read", name: "read", arguments: { path: LONG_PATH } },
		{
			type: "toolCall",
			id: "call_bash",
			name: "bash",
			arguments: { command: `ls -la ${LONG_PATH} && grep -n ${LONG_WORD} ${LONG_PATH}` },
		},
		{
			type: "toolCall",
			id: "call_edit",
			name: "edit",
			arguments: {
				path: LONG_PATH,
				edits: [{ oldText: WIDE_CODE_LINE, newText: `${WIDE_CODE_LINE} // ${LONG_WORD}` }],
			},
		},
		{
			type: "toolCall",
			id: "call_write",
			name: "write",
			arguments: { path: LONG_PATH, content: `${WIDE_CODE_LINE}\n${LONG_WORD}\n` },
		},
		{
			type: "toolCall",
			id: "call_grep",
			name: "grep",
			arguments: { pattern: LONG_WORD.slice(0, 80), path: LONG_PATH },
		},
		{ type: "toolCall", id: "call_shot", name: "browser_screenshot", arguments: { url: LONG_LINK } },
	];
	return writeChat(agentDir, cwd, 1, `${LONG_TITLE_WORDS} ${LONG_WORD}`, [
		{
			role: "user",
			content: [
				{
					type: "text",
					text: `A question with a very long unbroken line:\n${LONG_WORD}\nand a long link ${LONG_LINK}\nand a path ${LONG_PATH}`,
				},
				WIDE_PICTURE,
			],
		},
		assistant(
			[
				{ type: "thinking", thinking: `Thinking about ${LONG_WORD} and ${LONG_LINK}` },
				{ type: "text", text: `Looking at ${LONG_PATH}` },
				...calls,
			],
			"toolUse",
		),
		toolResult("call_read", "read", [{ type: "text", text: `${WIDE_CODE_LINE}\n${LONG_WORD}\n${LONG_PATH}\n` }]),
		toolResult("call_bash", "bash", [
			{
				type: "text",
				text: `-rw-r--r-- 1 someone someone 1234 Sep 29 00:00 ${LONG_PATH}\n${LONG_PATH}:12:${LONG_WORD}\n`,
			},
		]),
		toolResult("call_edit", "edit", [{ type: "text", text: `Successfully replaced 1 block(s) in ${LONG_PATH}.` }]),
		toolResult("call_write", "write", [{ type: "text", text: `Successfully wrote to ${LONG_PATH}` }]),
		toolResult("call_grep", "grep", [
			{ type: "text", text: `${LONG_PATH}:12: ${LONG_WORD}\n${LONG_PATH}:13: ${WIDE_CODE_LINE}` },
		]),
		toolResult("call_shot", "browser_screenshot", [{ type: "text", text: `Screenshot of ${LONG_LINK}` }, WIDE_PICTURE]),
		assistant([{ type: "text", text: markdown }]),
		{ role: "user", content: [{ type: "text", text: `Thanks. One more long line: ${LONG_WORD}` }] },
		assistant([{ type: "text", text: `You're welcome. ${LONG_LINK}\n\n${WIDE_TABLE}` }]),
	]);
}

function seedTitleChats(agentDir, cwd) {
	const titles = [
		LONG_TITLE_UNBROKEN,
		LONG_TITLE_WORDS,
		`${LONG_TITLE_UNBROKEN} ${LONG_TITLE_WORDS}`,
		`Short title then ${LONG_WORD}`,
		`A title with a link ${LONG_LINK}`,
	];
	titles.forEach((title, i) =>
		writeChat(agentDir, cwd, 10 + i, title, [
			{ role: "user", content: [{ type: "text", text: `${title}\n${LONG_WORD}` }] },
			assistant([{ type: "text", text: `Answer ${i}: ${LONG_WORD}` }]),
		]),
	);
}

function seedWorkspace(cwd) {
	mkdirSync(join(cwd, LONG_DIR_NAME), { recursive: true });
	writeFileSync(join(cwd, LONG_FILE_NAME), `${WIDE_CODE_LINE}\n${LONG_WORD}\n`);
	writeFileSync(join(cwd, "wide-lines.txt"), `${LONG_WORD.repeat(4)}\n${WIDE_CODE_LINE}\n`);
	writeFileSync(join(cwd, LONG_DIR_NAME, `${LONG_FILE_NAME}.md`), `# ${LONG_WORD}\n\n${WIDE_TABLE}\n`);
	const git = (...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
	git("init", "-q", "-b", "main");
	git("add", "-A");
	git(
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"-q",
		"-m",
		`A commit subject that is far too long ${LONG_WORD}`,
	);
	// Changes for the git view: a wide line in a long-named file, and a new file in a long-named folder.
	writeFileSync(join(cwd, LONG_FILE_NAME), `${WIDE_CODE_LINE}\n${LONG_WORD}\n${LONG_WORD}${LONG_WORD}\n`);
	writeFileSync(join(cwd, LONG_DIR_NAME, `new-${LONG_FILE_NAME}`), `${LONG_WORD}\n`);
}

// ---- the server ------------------------------------------------------------------------------------
// The project folder has a long name too (it shows in the top bar and lists). ownServer passes `env`
// to the server when it starts, after `prepare`, so prepare can still point it at that folder.
const env = {};
let wideChat = "";
const srv = await ownServer({
	name: "no-sideways",
	env,
	prepare: ({ workdir, agentDir }) => {
		const cwd = join(workdir, LONG_CWD_NAME);
		mkdirSync(cwd, { recursive: true });
		env.PI_WEB_CWD = cwd;
		seedWorkspace(cwd);
		seedTitleChats(agentDir, cwd);
		wideChat = seedWideChat(agentDir, cwd);
	},
});

// ---- the page --------------------------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: CHROME_PATH || undefined });
const pageErrors = [];

/** Panel widths and folds before the page loads (the app reads them once, when it starts). */
function panelScript({ collapsed, width }) {
	try {
		localStorage.setItem("pi-web-ui:left-panel-collapsed", collapsed ? "1" : "0");
		localStorage.setItem("pi-web-ui:right-panel-collapsed", collapsed ? "1" : "0");
		localStorage.setItem("pi-web-ui:left-panel-width", String(width));
		localStorage.setItem("pi-web-ui:right-panel-width", String(width));
	} catch {}
	const Orig = window.WebSocket;
	window.__frames = [];
	window.WebSocket = class extends Orig {
		constructor(...a) {
			super(...a);
			if (!/\/ws(\?|$)/.test(String(a[0]))) return;
			window.__ws = this;
			this.addEventListener("message", (ev) => {
				if (typeof ev.data === "string") window.__frames.push(ev.data.slice(0, 40));
			});
		}
	};
}

async function openPage(vp, panels) {
	const ctx = await browser.newContext({
		viewport: { width: vp.width, height: vp.height },
		deviceScaleFactor: vp.phone ? 3 : 1,
		isMobile: !!vp.phone,
		hasTouch: !!vp.phone,
	});
	await ctx.addInitScript(panelScript, panels);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => pageErrors.push(String(e?.message ?? e).slice(0, 200)));
	await page.goto(`${srv.http}/`);
	await waitForStablePage(page);
	await page.waitForFunction(() => window.__frames?.some((f) => f.startsWith('{"type":"snapshot"')), null, {
		timeout: 60_000,
	});
	await openWideChat(page);
	return { ctx, page };
}

/** Opens the seeded wide chat through the page's own socket and unfolds everything in it. */
async function openWideChat(page) {
	await page.evaluate((path) => {
		window.__frames.length = 0;
		window.__ws.send(JSON.stringify({ type: "switch_session", path }));
	}, wideChat);
	await page.waitForFunction(() => window.__frames.some((f) => f.startsWith('{"type":"switch_done"')), null, {
		timeout: 30_000,
	});
	await page.waitForSelector(".messages .msg", { state: "attached", timeout: 30_000 });
	await unfold(page);
}

/** Opens folded exchanges, one-line rows, thinking and tool cards, so all the wide content shows. */
async function unfold(page) {
	for (let round = 0; round < 4; round++) {
		const clicked = await page.evaluate(() => {
			let n = 0;
			for (const h of document.querySelectorAll('.messages .xfold-head[aria-expanded="false"]')) {
				h.click();
				n++;
			}
			for (const r of document.querySelectorAll(".messages .msg-collapsed")) {
				r.click();
				n++;
			}
			for (const card of document.querySelectorAll(".messages .toolcall, .messages .thinking")) {
				const head = card.querySelector(".toolcall-head, .thinking-head, .chead");
				const body = card.querySelector(".toolcall-body, .thinking-body, .cbody");
				if (head && !body) {
					head.click();
					n++;
				}
			}
			return n;
		});
		if (!clicked) break;
		await sleep(300);
	}
	await sleep(300);
}

async function settle(page, ms = 400) {
	await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
	await sleep(ms);
}

let stateCount = 0;
/**
 * Look at the page in one state: nothing past the window's edge, the big lists don't scroll
 * sideways either, and (with `content`) the wide content is reachable; `inner`: wide boxes in this
 * view that must scroll inside themselves (or wrap).
 */
async function look(page, name, { content = false, inner = "" } = {}) {
	await settle(page);
	stateCount += 1;
	const r = await findOverflow(page);
	check(`${name}: nothing past the window's edge`, r.ok, r.ok ? "" : describeOverflow(r));
	const lists = await listsScrollingSideways(page);
	const why = [];
	for (const sel of lists) why.push(describeOverflow(await findOverflow(page, { within: sel, liftGuard: false })));
	check(`${name}: the chat list and side panels don't scroll sideways`, lists.length === 0, why.join("\n"));
	if (content) {
		const bad = await unreachable(page);
		check(
			`${name}: wide content wraps or scrolls in its own box`,
			bad.length === 0,
			bad.map((b) => `  ${b}`).join("\n"),
		);
	}
	if (inner) {
		const s = await innerScroll(page, inner);
		check(
			`${name}: wide boxes scroll inside themselves (${s.wide} wider than their box)`,
			s.bad.length === 0,
			s.bad.map((b) => `  ${b}`).join("\n"),
		);
	}
	if (SHOTS)
		await page.screenshot({ path: join(SHOTS, `${name.replace(/[^a-z0-9]+/gi, "-")}${r.ok ? "" : "-overflow"}.png`) });
	return r;
}

/** The big lists: they scroll up and down, never sideways (a wide line scrolls in its own box). */
const LISTS = [
	".messages",
	".panel-body",
	".panel-sessions",
	".lp-section-body",
	".panel-widgets",
	".tldr-panel",
	".task-queue-panel",
	".scm-files-list",
	".scm-history-list",
];
/** The selectors of the lists (first match of each) that are wider inside than their box. */
function listsScrollingSideways(page) {
	return page.evaluate(
		(sels) =>
			sels.filter((sel) => {
				const el = document.querySelector(sel);
				return el && el.getClientRects().length && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1;
			}),
		LISTS,
	);
}

/**
 * Wide boxes matching `selector` that are wider than their box: each must scroll sideways inside
 * itself or a box of its own (not the page, not one of the big lists).
 */
function innerScroll(page, selector) {
	return page.evaluate(
		({ sel, lists }) => {
			const out = [];
			let wide = 0;
			const isList = (el) => lists.some((l) => el.matches(l));
			const desc = (el) =>
				`${el.tagName.toLowerCase()}${[...el.classList]
					.slice(0, 3)
					.map((c) => `.${c}`)
					.join("")}`;
			for (const el of document.querySelectorAll(sel)) {
				if (!el.getClientRects().length || el.clientWidth === 0) continue;
				if (el.scrollWidth <= el.clientWidth + 1) continue; // fits, or wraps
				wide += 1;
				let box = null;
				for (let a = el; a && a !== document.body && !isList(a); a = a.parentElement) {
					const o = getComputedStyle(a).overflowX;
					if (o === "auto" || o === "scroll") {
						box = a;
						break;
					}
				}
				if (!box) {
					out.push(
						`${desc(el)}: ${el.scrollWidth}px of content in ${el.clientWidth}px, and no box of its own scrolls it`,
					);
					continue;
				}
				const before = box.scrollLeft;
				box.scrollLeft = before + 60;
				const moved = box.scrollLeft !== before;
				box.scrollLeft = before;
				if (!moved)
					out.push(`${desc(el)}: ${desc(box)} (overflow-x ${getComputedStyle(box).overflowX}) doesn't scroll sideways`);
			}
			return { wide, bad: [...new Set(out)].slice(0, 10) };
		},
		{ sel: selector, lists: LISTS },
	);
}

/**
 * The guard: even with something far too wide in the page (in the app, or absolutely placed on the
 * page itself), the window can't be scrolled sideways, and inner boxes still scroll.
 */
async function guardHolds(page, name) {
	const probes = {
		"a wide box in the app": { parent: ".app", css: "width: 5000px; height: 2px; flex: none;" },
		"a wide box placed on the page itself": {
			parent: "body",
			css: "position: absolute; left: 0; top: 0; width: 5000px; height: 2px;",
		},
		"a wide fixed box": { parent: "body", css: "position: fixed; left: 0; top: 0; width: 5000px; height: 2px;" },
	};
	for (const [what, probe] of Object.entries(probes)) {
		const r = await page.evaluate(({ parent, css }) => {
			const el = document.createElement("div");
			el.style.cssText = css;
			document.querySelector(parent).appendChild(el);
			const se = document.scrollingElement || document.documentElement;
			window.scrollTo(1e6, window.scrollY);
			const scrolled = window.scrollX;
			window.scrollTo(0, window.scrollY);
			const res = { window: document.documentElement.clientWidth, doc: se.scrollWidth, scrolled };
			el.remove();
			return res;
		}, probe);
		check(
			`${name}: with ${what} far too wide, the window still can't scroll sideways`,
			r.scrolled === 0 && r.doc <= r.window + 1,
			`  window ${r.window}px, page ${r.doc}px, scrolled ${r.scrolled}px`,
		);
	}
}

/**
 * The seeded wide things that can't be reached: cut off by a box that hides its overflow, or wider
 * than their box with nothing to scroll. Layout facts only.
 */
function unreachable(page) {
	return page.evaluate(() => {
		const out = [];
		const desc = (el) =>
			`${el.tagName.toLowerCase()}${[...el.classList]
				.slice(0, 3)
				.map((c) => `.${c}`)
				.join("")}`;
		/** The nearest box around `el` that doesn't let its content spill. */
		const holder = (el) => {
			for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
				const s = getComputedStyle(a);
				if (s.overflowX !== "visible") return { box: a, how: s.overflowX };
			}
			return null;
		};
		const reach = (el, what) => {
			const r = el.getBoundingClientRect();
			if (!r.width) return;
			const h = holder(el);
			if (!h) return;
			const hr = h.box.getBoundingClientRect();
			// Its own text wider than itself, with nothing to scroll it.
			const s = getComputedStyle(el);
			if (s.overflowX === "visible" && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
				if (h.how === "hidden" || h.how === "clip")
					out.push(
						`${what}: ${desc(el)} is ${el.scrollWidth}px of content in ${el.clientWidth}px, cut by ${desc(h.box)} (overflow-x ${h.how})`,
					);
			}
			if (r.right > hr.right + 1 && (h.how === "hidden" || h.how === "clip")) {
				out.push(
					`${what}: ${desc(el)} ends ${Math.round(r.right - hr.right)}px past ${desc(h.box)} (overflow-x ${h.how})`,
				);
			}
			if (
				(s.overflowX === "hidden" || s.overflowX === "clip") &&
				el.scrollWidth > el.clientWidth + 1 &&
				s.textOverflow !== "ellipsis"
			) {
				out.push(
					`${what}: ${desc(el)} hides ${el.scrollWidth - el.clientWidth}px of its content (overflow-x ${s.overflowX})`,
				);
			}
		};
		const all = (sel, what) => {
			for (const el of document.querySelectorAll(sel)) reach(el, what);
		};
		all(".messages .md p, .messages .md li, .messages .md h1, .messages .md blockquote", "text");
		all(".messages .md pre", "code block");
		all(".messages .md table", "table");
		all(".messages .md .katex-display", "math");
		all(".messages img", "picture");
		all(".messages .toolcall pre, .messages .toolcall code", "tool output");
		all(".messages .msg-user .msg-body, .messages .msg-user p", "question");
		return [...new Set(out)].slice(0, 20);
	});
}

async function gotoView(page, label, waitFor) {
	const tab = await revealTopbarItem(page, `[role="tab"]:has-text("${label}")`);
	await tab.click();
	await page.waitForSelector(waitFor, { timeout: 15_000 });
	await settle(page, 600);
}

/** Terminal: a command with a long name, run once so its tab (with that name) opens. */
let commandMade = false;
async function terminalStates(page, prefix) {
	await gotoView(page, "Terminal", ".terminal-view");
	if (!commandMade) {
		commandMade = true;
		try {
			await page.click(".term-commands .panel-new", { timeout: 5000 });
			await page.fill("#cmd-name", LONG_COMMAND_NAME);
			await page.fill("#cmd-command", `echo ${LONG_WORD}`);
			await page.click(".cmd-form-actions .btn.primary");
			await sleep(500);
		} catch (e) {
			console.log(`  (couldn't add the terminal command: ${String(e?.message ?? e).split("\n")[0]})`);
		}
	}
	try {
		const run = page
			.locator(".cmd-item", { hasText: LONG_COMMAND_NAME.slice(0, 30) })
			.locator(".cmd-run")
			.first();
		if (await run.isVisible({ timeout: 2000 }).catch(() => false)) {
			await run.click();
			await page.waitForSelector(".term-tab", { timeout: 8000 });
			await sleep(800);
		}
	} catch {
		/* the list may be folded away on a narrow window */
	}
	await look(page, `${prefix} terminal`);
}

async function gitStates(page, prefix) {
	await gotoView(page, "Git", ".scm-view");
	await page.waitForSelector(".scm-file-path", { timeout: 20_000 }).catch(() => {});
	await look(page, `${prefix} git`);
	const file = page.locator(".scm-file-path").first();
	if (await file.isVisible().catch(() => false)) {
		await file.click();
		await page.waitForSelector(".scm-diff-pre, .scm-diff-body", { timeout: 10_000 }).catch(() => {});
		await look(page, `${prefix} git diff`, { inner: ".scm-diff-pre, .scm-diff-body" });
	}
	const history = page.locator(".scm-view-tabs button").nth(1);
	if (await history.isVisible().catch(() => false)) {
		await history.click();
		await page.waitForSelector(".scm-history-list", { timeout: 10_000 }).catch(() => {});
		await look(page, `${prefix} git history`);
	}
}

/** The files tab: a long-named file opened in the preview. */
async function filePreviewState(page, prefix) {
	const file = page.locator(`.file-item.file[data-path*="${LONG_FILE_NAME.slice(0, 40)}"] .file-name`).first();
	if (!(await file.isVisible({ timeout: 5000 }).catch(() => false))) {
		check(`${prefix} files: the long-named file is listed`, false);
		return;
	}
	await file.click();
	await page.waitForSelector(".fp-overlay", { timeout: 10_000 }).catch(() => {});
	await sleep(600);
	await look(page, `${prefix} file preview`, { inner: ".fp-overlay pre, .fp-code, .fp-code-text" });
	await page.keyboard.press("Escape");
	await sleep(300);
}

async function noticeState(page, prefix) {
	await page.evaluate((text) => {
		window.__ws.dispatchEvent(
			new MessageEvent("message", { data: JSON.stringify({ type: "notice", level: "error", text }) }),
		);
	}, LONG_NOTICE);
	await page.waitForSelector(".notice", { timeout: 5000 }).catch(() => {});
	const r = await look(page, `${prefix} long notice`);
	const cut = r.fixed.filter((f) => f.el.includes("notice"));
	check(
		`${prefix} long notice: it wraps inside the window`,
		cut.length === 0,
		cut.length ? describeOverflow({ ...r, starts: [], wide: [], shifted: [], fixed: cut }, { fixed: true }) : "",
	);
	await page.evaluate(() => {
		for (const b of document.querySelectorAll(".notice .notice-close")) b.click();
	});
}

/** An open menu stays inside the window: the page is clipped at its edge, so a part past it is out of reach. */
async function menuInside(page, name, selector) {
	const box = await page
		.locator(selector)
		.first()
		.evaluate((el) => {
			const r = el.getBoundingClientRect();
			return { left: Math.round(r.left), right: Math.round(r.right), window: document.documentElement.clientWidth };
		})
		.catch(() => null);
	if (!box) return check(`${name}: it opened`, false);
	check(
		`${name}: all of it is inside the window`,
		box.left >= 0 && box.right <= box.window,
		`left ${box.left}, right ${box.right}, window ${box.window}`,
	);
}

const shows = (locator, timeout = 5000) =>
	locator.waitFor({ state: "visible", timeout }).then(
		() => true,
		() => false,
	);

/** The menus that open near the window's right edge, each open once. */
async function menuStates(page, prefix, { roots = true, files = true, topbar = true, composer = true } = {}) {
	// The extra-folders menu in the files tab's path bar (it shows once there is an extra folder).
	const setRoots = (list) =>
		page.evaluate((r) => window.__ws.send(JSON.stringify({ type: "set_workspace_roots", roots: r })), list);
	if (roots) await setRoots([join(env.PI_WEB_CWD, LONG_DIR_NAME)]);
	const trigger = page.locator(".root-picker-trigger:visible").first();
	if (!roots) {
		/* not in this state */
	} else if (await shows(trigger, 8000)) {
		await trigger.click();
		await shows(page.locator(".root-picker-menu"));
		await look(page, `${prefix} extra-folders menu`);
		await menuInside(page, `${prefix} extra-folders menu`, ".root-picker-menu");
		// Its remove button sits at the menu's right end: a real click at that spot removes the folder.
		const remove = await page.locator(".root-picker-menu .root-picker-remove").first().boundingBox();
		if (remove) await page.mouse.click(remove.x + remove.width / 2, remove.y + remove.height / 2);
		check(
			`${prefix} extra-folders menu: its remove button can be clicked`,
			await page
				.locator(".root-picker-trigger")
				.first()
				.waitFor({ state: "detached", timeout: 8000 })
				.then(
					() => true,
					() => false,
				),
		);
		if ((await page.locator(".root-picker-trigger").count()) > 0) {
			await page.keyboard.press("Escape");
			await setRoots([]);
			await sleep(500);
		}
	} else check(`${prefix} extra-folders menu: its button shows`, false);
	// The context menu of a file in the files tab.
	const file = page.locator(".file-item.file .file-name:visible").first();
	if (!files) {
		/* not in this state */
	} else if (await shows(file)) {
		await file.click({ button: "right" });
		await shows(page.locator(".ctx-menu"));
		await look(page, `${prefix} file context menu`);
		await menuInside(page, `${prefix} file context menu`, ".ctx-menu");
		await page.keyboard.press("Escape");
		await page
			.locator(".ctx-menu")
			.first()
			.waitFor({ state: "detached", timeout: 3000 })
			.catch(() => {});
	} else check(`${prefix} file context menu: a file is listed`, false);
	// The top bar's "more" menu, when some buttons don't fit.
	const more = page.locator(".plugin-topbar-more > button:visible").first();
	if (topbar && (await more.isVisible().catch(() => false))) {
		await more.click();
		await shows(page.locator(".plugin-topbar-menu"));
		await look(page, `${prefix} top-bar more menu`);
		await menuInside(page, `${prefix} top-bar more menu`, ".plugin-topbar-menu");
		await page.keyboard.press("Escape");
		await sleep(200);
	}
	// The slash-command menu above the composer.
	if (composer) {
		const input = page.locator(".inputbox textarea").first();
		await input.fill("/");
		if (await shows(page.locator(".slash-menu"))) {
			await look(page, `${prefix} slash menu`);
			await menuInside(page, `${prefix} slash menu`, ".slash-menu");
		} else check(`${prefix} slash menu: it opened`, false);
		await input.fill("");
		await sleep(200);
	}
}

/** In the chat: code blocks, tables, maths and tool output. */
const CHAT_INNER = ".messages .md pre, .messages .md table, .messages .katex-display, .messages .toolcall pre";

const VIEWPORTS = [
	{ width: 1920, height: 1080 },
	{ width: 1440, height: 900 },
	{ width: 1280, height: 800 },
	{ width: 1024, height: 768 },
	{ width: 768, height: 1024, mobile: true },
	{ width: 390, height: 844, mobile: true, phone: true },
].filter((vp) => !ONLY.length || ONLY.includes(vp.width));

try {
	for (const vp of VIEWPORTS) {
		const at = `${vp.width}`;
		console.log(`\n— ${vp.width}×${vp.height}${vp.phone ? " (phone)" : ""}`);
		if (!vp.mobile) {
			// Side panels open (default widths): chat, files, notice, terminal, git.
			{
				const { ctx, page } = await openPage(vp, { collapsed: false, width: 240 });
				await look(page, `${at} panels open chat`, { content: true, inner: CHAT_INNER });
				await guardHolds(page, `${at} panels open chat`);
				await filePreviewState(page, `${at} panels open`);
				await noticeState(page, `${at} panels open`);
				await menuStates(page, `${at} panels open`);
				await terminalStates(page, `${at} panels open`);
				await gitStates(page, `${at} panels open`);
				await gotoView(page, "Chat", ".messages");
				// Closed with the fold buttons, then open again with the rails.
				await page.click(".panel-left .panel-collapse-btn");
				await page.click(".panel-right .panel-collapse-btn");
				await look(page, `${at} panels closed chat`, { content: true, inner: CHAT_INNER });
				await page.click(".panel-rail-left");
				await page.click(".panel-rail-right");
				await look(page, `${at} panels reopened chat`);
				await ctx.close();
			}
			// Side panels dragged to their widest (a wide screen's widths on a smaller window).
			{
				const { ctx, page } = await openPage(vp, { collapsed: false, width: 520 });
				await look(page, `${at} wide panels chat`, { content: true, inner: CHAT_INNER });
				await menuStates(page, `${at} wide panels`);
				await filePreviewState(page, `${at} wide panels`);
				await ctx.close();
			}
		} else {
			const { ctx, page } = await openPage(vp, { collapsed: false, width: 240 });
			await look(page, `${at} chat`, { content: true, inner: CHAT_INNER });
			await guardHolds(page, `${at} chat`);
			await menuStates(page, at, { roots: false, files: false });
			await noticeState(page, at);
			// The side panels are drawers here.
			const left = await revealTopbarItem(page, "button.panel-toggle:not(.has-label)");
			await left.click();
			await page.waitForSelector(".drawer-left.open", { timeout: 5000 });
			await look(page, `${at} history drawer`);
			await page.click(".drawer-backdrop", { position: { x: vp.width - 10, y: vp.height / 2 } });
			await sleep(300);
			const right = await revealTopbarItem(page, "button.panel-toggle.has-label");
			await right.click();
			await page.waitForSelector(".drawer-right.open", { timeout: 5000 });
			await look(page, `${at} files drawer`);
			await menuStates(page, `${at} files drawer`, { files: false, topbar: false, composer: false });
			// Removing that folder is an action in the drawer, and actions close it (App's panelSend): open it again.
			if ((await page.locator(".drawer-right.open").count()) === 0) {
				await sleep(300);
				await (await revealTopbarItem(page, "button.panel-toggle.has-label")).click();
				await page.waitForSelector(".drawer-right.open", { timeout: 5000 });
			}
			await sleep(400);
			await menuStates(page, `${at} files drawer`, { roots: false, topbar: false, composer: false });
			await filePreviewState(page, at);
			if (
				await page
					.locator(".drawer-backdrop")
					.isVisible()
					.catch(() => false)
			) {
				await page.click(".drawer-backdrop", { position: { x: 10, y: vp.height / 2 } });
				await sleep(300);
			}
			await terminalStates(page, at);
			await gitStates(page, at);
			await gotoView(page, "Chat", ".messages");
			await look(page, `${at} back to chat`);
			await ctx.close();
		}
	}
	check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 5).join("\n"));
} catch (e) {
	console.log(`✗ FAIL: the test stopped: ${e?.stack ?? e}`);
	failures += 1;
} finally {
	await browser.close().catch(() => {});
	await srv.stop();
}

console.log(`\n${stateCount} states looked at`);
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
