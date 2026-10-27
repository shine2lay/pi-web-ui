/* Real App + useChat + RolesView (BoardForm / BoardCloseForm) + recovery-board.ts +
 * native IndexedDB pi-web-board-drafts-v1 (#598/#599). Synthetic inputs and ownServer only;
 * no model request bodies, real profiles, or real sessions are inspected. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { build } from "esbuild";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const out = process.env.PI_WEB_FIXTURE_OUT || `/tmp/durable-board-host-${Date.now()}`;
mkdirSync(out, { recursive: true });
const result = { fixtureOnly: true, liveModelCalls: 0, assertions: [], cases: [] };
const check = (label, condition) => {
	assert.ok(condition, label);
	result.assertions.push(label);
};

const readerBundle = await build({
	entryPoints: [join(repo, "web/src/board-draft-store.ts")],
	bundle: true,
	write: false,
	format: "esm",
	platform: "browser",
	target: "es2022",
	logLevel: "silent",
});
const readerModuleUrl = `data:text/javascript;base64,${Buffer.from(readerBundle.outputFiles[0].contents).toString("base64")}`;

const hostHarness = `
import React from "react";
import { createRoot } from "react-dom/client";
import { initAuthToken } from "./web/src/auth-token";
import { LanguageProvider } from "./web/src/i18n";
import { useChat } from "./web/src/use-chat";
import { BoardView } from "./web/src/components/RolesView";

initAuthToken();

const boardData = {
	posts: [
		{
			id: "bp-fixture-1",
			at: Date.now() - 60000,
			from: "owner",
			kind: "news",
			to: "all",
			title: "Existing fixture post",
			text: "Existing fixture body",
			reads: {},
			done: {},
		},
	],
};

function Harness() {
	const chat = useChat();
	return (
		<LanguageProvider>
			<div data-testid="board-host-ready" data-session-id={chat.sessionId || ""} data-ready={String(chat.ready)}>
				<BoardView board={boardData} roleIds={["ops", "qa"]} now={Date.now()} focus={null} />
			</div>
		</LanguageProvider>
	);
}

createRoot(document.getElementById("root")).render(<Harness />);
`;

const harnessBundle = await build({
	stdin: {
		contents: hostHarness,
		loader: "tsx",
		resolveDir: repo,
		sourcefile: "durable-board-host-harness.tsx",
	},
	bundle: true,
	write: false,
	format: "esm",
	platform: "browser",
	target: "es2022",
	jsx: "automatic",
	loader: { ".css": "empty" },
	define: { "process.env.NODE_ENV": '"production"' },
	logLevel: "silent",
});
const harnessJs = Buffer.from(harnessBundle.outputFiles[0].contents).toString("utf8");
const harnessHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Board Host Proof</title></head><body><div id="root"></div><script type="module" src="/__board-host-harness.js"></script></body></html>`;

const server = await ownServer({ name: "durable-board-host", model: "fastfail" });
let browser;

async function exportBoardStore(page) {
	return page.evaluate(async (modUrl) => {
		const mod = await import(modUrl);
		return await mod.inspectBoardDrafts(mod.createBoardDraftIndexedDB(window.indexedDB));
	}, readerModuleUrl);
}

async function setup() {
	const context = await browser.newContext({
		viewport: { width: 1440, height: 1000 },
		locale: "en-US",
	});
	await context.addInitScript(() => {
		localStorage.setItem("pi-web-ui:lang", "en");
		window.fixtureBoardIdbAbort = false;
		const origPut = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function (...args) {
			const req = origPut.apply(this, args);
			if (window.fixtureBoardIdbAbort && this.name === "authored-board-drafts" && this.transaction) {
				this.transaction.abort();
			}
			return req;
		};
	});
	const page = await context.newPage();
	const wire = {
		boardPosts: [],
		boardCloses: [],
		errors: [],
		sessionId: "",
		socketInitialized: false,
		socket: null,
		upstream: null,
		holdBoardWire: true,
	};
	page.on("pageerror", (error) => wire.errors.push(String(error)));
	await page.route(/\/assets\/index-.*\.js(\?|$)/, (route) =>
		route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: harnessJs }),
	);
	await page.routeWebSocket(/\/ws(\?|$)/, (socket) => {
		const upstream = socket.connectToServer();
		wire.socket = socket;
		wire.upstream = upstream;
		wire.sessionId = "";
		wire.socketInitialized = false;
		socket.onMessage((raw) => {
			const message = JSON.parse(String(raw));
			if (message.type === "board_post") {
				wire.boardPosts.push(message);
				if (wire.holdBoardWire) return;
			}
			if (message.type === "board_close") {
				wire.boardCloses.push(message);
				if (wire.holdBoardWire) return;
			}
			upstream.send(raw);
		});
		upstream.onMessage((raw) => {
			const message = JSON.parse(String(raw));
			if (message.type === "snapshot") wire.sessionId = message.state.sessionId;
			if (message.type === "session_initialized") wire.socketInitialized = true;
			socket.send(raw);
		});
	});
	const boot = async () => {
		await page.locator(".rv-board").waitFor();
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const hasLock = await page.evaluate(async () => {
				const ownerId = sessionStorage.getItem("pi-web-pending-owner-v1");
				if (!ownerId || !navigator.locks?.query) return false;
				const locks = await navigator.locks.query();
				return (locks.held ?? []).some((l) => l.name === `pi-web-pending-owner-lock-v1:${ownerId}`);
			});
			if (hasLock && wire.sessionId && wire.socketInitialized) break;
			await new Promise((r) => setTimeout(r, 25));
		}
		assert.ok(wire.sessionId && wire.socketInitialized);
	};
	const openBoard = async () => {
		await page.locator(".rv-board").waitFor();
	};
	async function reloadAndBoot() {
		wire.socket = null;
		wire.helloCount = 0;
		wire.boardGetCount = 0;
		await page.reload();
		await boot();
	}

	await page.goto(server.http);
	await boot();
	return { context, page, wire, boot, reloadAndBoot, openBoard };
}

try {
	browser = await chromium.launch({
		executablePath: CHROME_PATH,
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage"],
	});

	// Case 1: BoardForm post checkpoints full untrimmed title/text + inactive picked roles to pi-web-board-drafts-v1 before wire, does not auto-replay on reload, and restores recovered draft via useChat -> restoreBoardDraft.
	{
		const { context, page, wire, reloadAndBoot, openBoard } = await setup();
		await openBoard();
		await page.locator(".rv-bbar button", { hasText: "New post" }).click();
		const form = page.locator("form.rv-bform");
		await form.waitFor();
		await form.locator('input[name="rv-bkind"][value="order"]').check();
		await form.locator('input[name="rv-bto"]').nth(1).check();
		await form.locator('.rv-broles input[type="checkbox"][value="qa"]').check();
		await form.locator('input[name="rv-bto"]').nth(0).check();
		await form.locator('input[name="title"]').fill("  Board host title 雪  ");
		await form.locator('textarea[name="text"]').fill("  Board host body 雪\nsecond line  ");
		await form.locator('button[type="submit"]').click();

		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline && wire.boardPosts.length < 1) {
			await new Promise((r) => setTimeout(r, 25));
		}
		check("BoardForm dispatched one canonical board_post on wire", wire.boardPosts.length === 1);
		check(
			"canonical wire board_post trimmed title/text and sent to='all'",
			wire.boardPosts[0].kind === "order" &&
				wire.boardPosts[0].to === "all" &&
				wire.boardPosts[0].title === "Board host title 雪" &&
				wire.boardPosts[0].text === "Board host body 雪\nsecond line" &&
				typeof wire.boardPosts[0].reqId === "string",
		);

		const exported = await exportBoardStore(page);
		check(
			"pi-authored-board-drafts-v1 stores complete unretired board_post source with untrimmed fields and inactive picked roles",
			exported.status === "ready" &&
				exported.unknown.length === 0 &&
				exported.records.length === 1 &&
				exported.records[0].retired === false &&
				exported.records[0].current.form.type === "board_post" &&
				exported.records[0].current.form.title === "  Board host title 雪  " &&
				exported.records[0].current.form.text === "  Board host body 雪\nsecond line  " &&
				exported.records[0].current.form.toAll === true &&
				JSON.stringify(exported.records[0].current.form.picked) === JSON.stringify(["qa"]) &&
				exported.records[0].submitted.length === 1 &&
				exported.records[0].submitted[0].form.type === "board_post" &&
				exported.records[0].submitted[0].form.title === "  Board host title 雪  ",
		);

		// Reload page while board_post is unconfirmed: verify zero replay and automatic restoration into BoardForm recoveries list.
		await reloadAndBoot();
		check("page reload does not auto-replay unconfirmed board_post", wire.boardPosts.length === 1);
		await openBoard();
		await page.locator(".rv-bbar button", { hasText: "New post" }).click();
		const postForm = page.locator("form.rv-bform");
		await postForm.locator('[data-testid="board-post-recoveries"]').waitFor();
		await postForm.locator('[data-testid^="board-post-restore-"]').first().click();
		check(
			"restoring recovered board_post populates exact untrimmed title, text, and kind without sending",
			(await postForm.locator('input[name="title"]').inputValue()) === "  Board host title 雪  " &&
				(await postForm.locator('textarea[name="text"]').inputValue()) === "  Board host body 雪\nsecond line  " &&
				(await postForm.locator('input[name="rv-bkind"][value="order"]').isChecked()) === true &&
				(await postForm.locator('input[name="rv-bto"]').nth(0).isChecked()) === true &&
				wire.boardPosts.length === 1,
		);
		await postForm.locator('input[name="rv-bto"]').nth(1).check();
		check(
			"restored board_post preserved inactive picked=['qa'] across reload",
			(await postForm.locator('.rv-broles input[type="checkbox"][value="qa"]').isChecked()) === true &&
				(await postForm.locator('.rv-broles input[type="checkbox"][value="ops"]').isChecked()) === false,
		);
		check("Case 1 has no page errors", wire.errors.length === 0);
		result.cases.push({ kind: "board-post-checkpoint-reload-restore" });
		await context.close();
	}

	// Case 2: BoardCloseForm checkpoints untrimmed close note before wire and retires the draft only on matching ok:true board_result.
	{
		const { context, page, wire, reloadAndBoot, openBoard } = await setup();
		await openBoard();
		await page.locator(".rv-bposts article button", { hasText: "Close" }).click();
		const closeForm = page.locator("form.rv-bclose");
		await closeForm.waitFor();
		await closeForm.locator('input[name="note"]').fill("  pause lifted 雪  ");
		await closeForm.locator('button[type="submit"]').click();

		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline && wire.boardCloses.length < 1) {
			await new Promise((r) => setTimeout(r, 25));
		}
		check("BoardCloseForm dispatched one canonical board_close on wire", wire.boardCloses.length === 1);
		const reqId = wire.boardCloses[0].reqId;
		check(
			"canonical wire board_close trimmed note and preserved post id",
			wire.boardCloses[0].id === "bp-fixture-1" &&
				wire.boardCloses[0].note === "pause lifted 雪" &&
				typeof reqId === "string",
		);

		const beforeResult = await exportBoardStore(page);
		check(
			"board_close draft is stored unretired with untrimmed note before board_result",
			beforeResult.status === "ready" &&
				beforeResult.unknown.length === 0 &&
				beforeResult.records.length === 1 &&
				beforeResult.records[0].retired === false &&
				beforeResult.records[0].current.form.type === "board_close" &&
				beforeResult.records[0].current.form.id === "bp-fixture-1" &&
				beforeResult.records[0].current.form.note === "  pause lifted 雪  ",
		);

		// Deliver matching ok:true board_result from server and wait for retirement marker in pi-authored-board-drafts-v1.
		wire.socket.send(
			JSON.stringify({
				type: "board_result",
				reqId,
				op: "close",
				ok: true,
				id: "bp-fixture-1",
			}),
		);
		const retireDeadline = Date.now() + 10_000;
		let afterResult = null;
		while (Date.now() < retireDeadline) {
			afterResult = await exportBoardStore(page);
			if (afterResult.records.length === 1 && afterResult.records[0].retired === true) break;
			await new Promise((r) => setTimeout(r, 25));
		}
		check(
			"matching ok:true board_result marks the board_close draft retired in pi-authored-board-drafts-v1",
			Boolean(
				afterResult &&
				afterResult.status === "ready" &&
				afterResult.unknown.length === 0 &&
				afterResult.records.length === 1 &&
				afterResult.records[0].retired === true,
			),
		);

		// Reload page: verify retired board_close draft does not resurface in BoardCloseForm recoveries.
		await reloadAndBoot();
		await openBoard();
		await page.locator(".rv-bposts article button", { hasText: "Close" }).click();
		await page.locator("form.rv-bclose").waitFor();
		check(
			"retired board_close draft is not resurfaced after page reload",
			(await page.locator('[data-testid="board-close-recoveries-bp-fixture-1"]').count()) === 0,
		);
		check("Case 2 has no page errors", wire.errors.length === 0);
		result.cases.push({ kind: "board-close-retire" });
		await context.close();
	}

	// Case 3: IndexedDB abort during boardSource.saveSubmitted refuses admission before wire and keeps BoardForm open with full untrimmed input.
	{
		const { context, page, wire, openBoard } = await setup();
		await openBoard();
		await page.locator(".rv-bbar button", { hasText: "New post" }).click();
		const form = page.locator("form.rv-bform");
		await form.waitFor();
		await form.locator('input[name="title"]').fill("  Faulted board title 雪  ");
		await form.locator('textarea[name="text"]').fill("  Faulted board body 雪  ");
		await page.evaluate(() => {
			window.fixtureBoardIdbAbort = true;
		});
		await form.locator('button[type="submit"]').click();
		await form.locator(".rv-berr").waitFor();
		check("IDB abort during board_post checkpoint sends zero board_post frames on wire", wire.boardPosts.length === 0);
		check(
			"BoardForm stays open with full untrimmed title and text after checkpoint failure",
			(await form.locator('input[name="title"]').inputValue()) === "  Faulted board title 雪  " &&
				(await form.locator('textarea[name="text"]').inputValue()) === "  Faulted board body 雪  ",
		);
		check("Case 3 has no page errors", wire.errors.length === 0);
		result.cases.push({ kind: "board-post-idb-abort" });
		await context.close();
	}

	writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
	console.log(`PASS ${result.assertions.length} actual board host assertions: ${out}`);
} catch (error) {
	writeFileSync(join(out, "result.json"), JSON.stringify({ ...result, error: String(error) }, null, 2));
	throw error;
} finally {
	await browser?.close();
	await server.stop();
}
