/* Isolated native proof of retained readers, not a production pin or live-data migration.
 * Actual purpose stores seed known synthetic work AFTER asset installation. The real
 * authenticated static route stays usable after app requests are blocked/server restart.
 * No model, SDK request inspection, app auto-replay or live browser profile is used. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { ownServer } from "./lib/own-server.mjs";
import { installReaders, readerAssets, verifyReaders } from "../scripts/pending-recovery-reader.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = process.env.PI_WEB_FIXTURE_OUT || `/tmp/durable-retained-readers-${Date.now()}`;
mkdirSync(output, { recursive: true });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const report = { fixtureOnly: true, productionPinned: false, modelCalls: 0, assertions: [], sources: {} };
const check = (name, value) => {
	assert.ok(value, name);
	report.assertions.push(name);
};
async function bundle(path) {
	const compiled = await build({
		entryPoints: [join(root, path)],
		bundle: true,
		write: false,
		format: "esm",
		platform: "browser",
		target: "es2022",
		logLevel: "silent",
		metafile: true,
	});
	for (const input of Object.keys(compiled.metafile.inputs)) {
		const absolute = fileURLToPath(new URL(input, `file://${process.cwd()}/`));
		report.sources[input] = hash(readFileSync(absolute));
	}
	return Buffer.from(compiled.outputFiles[0].contents).toString("utf8");
}
const coreCode = await bundle("web/src/pending-recovery-coordinator.ts");
const pluginCode = await bundle("web/src/plugin-start-checkpoint.ts");
const composerCode = await bundle("web/src/composer-checkpoint.ts");
const schedulerCode = await bundle("web/src/scheduler-draft-store.ts");
const boardCode = await bundle("web/src/board-draft-store.ts");
const core = await import(`data:text/javascript;base64,${Buffer.from(coreCode).toString("base64")}`);
const plugin = await import(`data:text/javascript;base64,${Buffer.from(pluginCode).toString("base64")}`);
const pendingHtml = core.createPendingRecoveryReaderHtml(coreCode);
const pluginHtml = plugin.createPluginStartReaderHtml(pluginCode);
const extraFiles = {};
for (const [kind, page, entry, src] of [
	[
		"composer",
		"web/composer-checkpoint-recovery.html",
		"web/src/composer-checkpoint-reader.ts",
		"/src/composer-checkpoint-reader.ts",
	],
	[
		"scheduler",
		"web/scheduler-draft-recovery.html",
		"web/src/scheduler-draft-reader.ts",
		"./src/scheduler-draft-reader.ts",
	],
	["board", "web/board-draft-recovery.html", "web/src/board-draft-reader.ts", "./src/board-draft-reader.ts"],
]) {
	const template = readFileSync(join(root, page), "utf8");
	report.sources[page] = hash(template);
	const needle = `<script type="module" src="${src}"></script>`;
	assert.equal(template.split(needle).length, 2);
	extraFiles[`${kind}.html`] = template.replace(needle, `<script type="module" src="./${kind}.mjs"></script>`);
	extraFiles[`${kind}.mjs`] = await bundle(entry);
}
// Synthetic revision values identify this fixture, not checked release commits. The
// production buildPinnedReaders path still refuses ANY uncommitted source dependency.
const oldAssets = readerAssets({
	pendingHtml,
	pluginHtml,
	revision: "1".repeat(40),
	sources: { fixture: true, ...report.sources },
});
const assets = readerAssets({
	pendingHtml,
	pluginHtml,
	revision: "2".repeat(40),
	sources: { fixture: true, ...report.sources },
	extraFiles,
});
const token = `fixture-only-${randomUUID()}`;
const largeBytes = Buffer.from("Full synthetic retained bytes 雪🙂\n".repeat(50_000));
const fileData = largeBytes.toString("base64");
assert.ok(fileData.length > 1_500_000);
const prompt = {
	id: "pending-original",
	conversationId: "fixture-conversation",
	sessionId: "fixture-session",
	text: "  exact retained question 雪\n",
	queue: false,
	attachments: [{ path: "", name: "original-雪.txt", mimeType: "text/plain", fileData, size: largeBytes.length }],
	sameTextBefore: [],
	queueBase: 0,
	createdAt: 1700000000000,
	status: "sending",
};
const scheduler = {
	workspace: "/fixture/workspace",
	taskId: null,
	formId: "fixture-form",
	revision: 1,
	form: {
		id: "",
		name: "  exact name 雪 ",
		description: " original\ndescription ",
		cwd: " /fixture/task-cwd/ ",
		kind: "interval",
		cron: " 8 9 * * 2 ",
		preset: "custom",
		intervalMinutes: " 002.50 ",
		prompt: "  exact scheduled prompt\n",
		model: "fixture/model",
		thinkingLevel: "raw-thinking",
		catchUp: false,
	},
};
const composer = {
	kind: "pi-web-ui/composer-checkpoint",
	version: 1,
	purpose: "composer-injection",
	recordId: "fixture-composer-record",
	createdAt: 1700000000001,
	binding: {
		ownerId: "fixture-owner",
		composerId: "fixture-composer",
		conversationId: "fixture-conversation",
		sessionId: "fixture-session",
		revision: 7,
	},
	nextRevision: 8,
	source: { text: "  existing draft\n", attachments: [] },
	incoming: {
		text: " incoming 雪\n",
		attachments: [{ path: "", name: "small.txt", fileData: "ZXhhY3QgYnl0ZXM=", mimeType: "text/plain", size: 11 }],
	},
	effective: {
		text: "  existing draft\n incoming 雪\n",
		attachments: [{ path: "", name: "small.txt", fileData: "ZXhhY3QgYnl0ZXM=", mimeType: "text/plain", size: 11 }],
	},
};
const startOptions = {
	prompt: "  original plugin prompt 雪\n",
	newChat: false,
	cwd: " /fixture/plugin/ ",
	model: undefined,
};
const board = {
	editorId: "fixture-board-editor",
	revision: 2,
	form: {
		type: "board_post",
		kind: "order",
		toAll: true,
		picked: ["qa", "ops"],
		title: "  exact board title 雪 ",
		text: "  exact board body\nline two  ",
	},
};
let installed;
const server = await ownServer({
	name: "durable-retained-readers",
	model: "none",
	env: { PI_WEB_TOKEN: token },
	prepare: async ({ dataDir }) => {
		await installReaders(dataDir, oldAssets);
		installed = await installReaders(dataDir, assets);
		writeFileSync(join(dataDir, "original-session.jsonl"), '{"synthetic":"exact original 雪"}\n');
		const dir = join(dataDir, "plugins", "fixture-reader-seed", "client");
		mkdirSync(dir, { recursive: true });
		for (const [name, code] of Object.entries({
			core: coreCode,
			plugin: pluginCode,
			composer: composerCode,
			scheduler: schedulerCode,
			board: boardCode,
		}))
			writeFileSync(join(dir, `${name}.mjs`), code);
		writeFileSync(
			join(dir, "index.html"),
			'<!doctype html><title>Isolated purpose-store seed</title><script type="module" src="./seed.mjs"></script>',
		);
		writeFileSync(
			join(dir, "seed.mjs"),
			`import * as core from './core.mjs'; import * as plugin from './plugin.mjs'; import * as composer from './composer.mjs'; import * as scheduler from './scheduler.mjs'; import * as board from './board.mjs';
		window.fixture = {
		 async seed(input) {
		  const c=core.createPendingRecoveryCoordinator(); const started=await c.start(); if(started.state!=='ready') throw Error('owner unavailable');
		  const prepared=await c.prepare({kind:'prompt',pending:input.prompt}); if(!prepared.ok) throw Error('full core checkpoint failed');
		  const opened=await plugin.openPluginStartCheckpoint({ownerId:started.ownerId,getSource:()=>({ownerId:started.ownerId,conversationId:'fixture-conversation',sessionId:'fixture-session',pluginId:'fixture'})});
		  if(!opened.ok) throw Error('plugin owner unavailable');
		  const p=opened.owner.checkpoint(input.startOptions,{intentId:'fixture-intent',promptId:'fixture-start-prompt'}); if(!p.ok) throw Error('plugin checkpoint failed');
		  const cc=composer.createComposerCheckpointStore({storage:localStorage,enabled:true,owns:binding=>JSON.stringify(binding)===JSON.stringify(input.composer.binding)}).checkpoint(input.composer); if(!cc.ok) throw Error('composer checkpoint failed '+cc.code);
		  const s=scheduler.createSchedulerDraftStore(scheduler.createSchedulerDraftIndexedDB(indexedDB)); let record=await s.create(input.scheduler); record=await s.retainSubmitted(record,input.scheduler);
		  const b=board.createBoardDraftStore(board.createBoardDraftIndexedDB(indexedDB)); let boardRecord=await b.create(input.board); boardRecord=await b.retainSubmitted(boardRecord,input.board);
		  const ownerId=started.ownerId; await c.close(); opened.owner.close(); return {ownerId,pluginIntent:p.intent,schedulerRecord:record,boardRecord};
		 },
		 async snapshot() {
		  const data={local:Object.fromEntries(Object.keys(localStorage).sort().map(key=>[key,localStorage.getItem(key)])),databases:{}};
		  for(const info of (await indexedDB.databases()).sort((a,b)=>a.name.localeCompare(b.name))) {
		   const db=await new Promise((ok,bad)=>{const r=indexedDB.open(info.name);r.onsuccess=()=>ok(r.result);r.onerror=()=>bad(r.error);r.onupgradeneeded=()=>{r.transaction.abort();bad(Error('unexpected missing database'));};});
		   const stores={}; for(const name of [...db.objectStoreNames].sort()) stores[name]=await new Promise((ok,bad)=>{const tx=db.transaction(name,'readonly'),s=tx.objectStore(name),k=s.getAllKeys(),v=s.getAll();tx.oncomplete=()=>ok({keys:k.result,values:v.result});tx.onabort=()=>bad(tx.error);});
		   db.close();data.databases[info.name]=stores;
		  } return data;
		 }
		};`,
		);
	},
});
const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
const contexts = [];
const errors = [];
const sideEffects = [];
async function context() {
	const ctx = await browser.newContext({ acceptDownloads: true });
	contexts.push(ctx);
	ctx.on("page", (page) => {
		page.on("pageerror", (error) => errors.push(error.message));
		page.on("websocket", (socket) => sideEffects.push(`ws:${new URL(socket.url()).pathname}`));
	});
	ctx.on("request", (request) => {
		if (request.method() !== "GET") sideEffects.push(request.method());
	});
	await ctx.route("**/*", (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/rollback-legacy-ui") {
			return route.fulfill({
				status: 200,
				contentType: "text/html; charset=utf-8",
				body: '<!doctype html><title>Legacy pre-W2 UI</title><script>window.legacyBooted = { pendingSession: sessionStorage.getItem("pi-web-pending-sends"), origin: location.origin };</script>',
			});
		}
		return path === "/" || path.startsWith("/assets/") || path.startsWith("/src/") ? route.abort() : route.continue();
	});
	return ctx;
}
const url = (name) => `${server.http}/plugins/pi-web-pending-recovery/client/${assets.manifest.version}/${name}`;
const seedUrl = `${server.http}/plugins/fixture-reader-seed/client/index.html`;
async function open(ctx, path) {
	const page = await ctx.newPage();
	await page.goto(`${path}?token=${encodeURIComponent(token)}`);
	return page;
}
async function download(page, selector) {
	const ready = page.waitForEvent("download");
	await page.locator(selector).click();
	return readFileSync(await (await ready).path(), "utf8");
}
async function jsonOutput(page, selector, predicate) {
	await page.waitForFunction(
		({ selector, condition }) => {
			try {
				return Function("x", `return (${condition})(x)`)(JSON.parse(document.querySelector(selector).textContent));
			} catch {
				return false;
			}
		},
		{ selector, condition: predicate.toString() },
	);
	return JSON.parse(await page.locator(selector).textContent());
}
try {
	check(
		"all immutable assets verify through actual retained catalogue",
		(await verifyReaders(server.dataDir)).versions.length === 2,
	);
	check("unauthenticated retained index is refused", (await fetch(`${server.http}${installed.url}`)).status === 401);
	for (const name of [
		"pending.html",
		"plugin-start.html",
		"composer.html",
		"composer.mjs",
		"scheduler.html",
		"scheduler.mjs",
		"board.html",
		"board.mjs",
	])
		check(`unauthenticated ${name} is refused`, (await fetch(url(name))).status === 401);
	const ctx = await context();
	const seed = await open(ctx, seedUrl);
	await seed.waitForFunction(() => !!window.fixture);
	const seeded = await seed.evaluate((input) => window.fixture.seed(input), {
		prompt,
		scheduler,
		board,
		composer,
		startOptions,
	});
	const original = await seed.evaluate(() => window.fixture.snapshot());
	check(
		"complete work was created after both retained versions were installed",
		!!seeded.ownerId &&
			original.databases["pi-web-pending-recovery-v1"] &&
			original.databases["pi-authored-scheduler-drafts-v1"] &&
			original.databases["pi-authored-board-drafts-v1"],
	);
	await server.restart();
	check(
		"server restart retains original exact JSONL canary",
		readFileSync(join(server.dataDir, "original-session.jsonl"), "utf8") === '{"synthetic":"exact original 雪"}\n',
	);
	const legacyPage = await open(ctx, `${server.http}/rollback-legacy-ui`);
	const legacyBooted = await legacyPage.evaluate(() => window.legacyBooted);
	check(
		"simulated pre-W2 rollback UI boots on same origin without deleting W2 recovery stores",
		legacyBooted?.origin === server.http,
	);
	await legacyPage.close();
	const nav = await open(ctx, `${server.http}${installed.url}`);
	for (const name of ["pending.html", "plugin-start.html", "composer.html", "scheduler.html", "board.html"])
		check(
			`retained index links ${name} without app bundle`,
			(await nav.locator(`a[href="./${assets.manifest.version}/${name}"]`).count()) === 1,
		);
	check(
		"older reader version remains reachable",
		(
			await ctx.request.get(
				`${server.http}/plugins/pi-web-pending-recovery/client/${oldAssets.manifest.version}/pending.html`,
			)
		).ok(),
	);
	const pending = await open(ctx, url("pending.html"));
	await pending.locator("#catalog").click();
	await pending.locator("#owners button").filter({ hasText: seeded.ownerId }).click();
	const recovered = await jsonOutput(pending, "#output", (x) => x.state === "ready" && x.entries?.length === 1);
	assert.deepEqual(recovered.entries[0].prepared.work, { kind: "prompt", pending: prompt });
	check("core reader recovers exact original full bytes/identity after restart without app", true);
	const artifact = await download(pending, "#export");
	const decoded = await core.readPendingRecoveryArtifact(artifact);
	assert.deepEqual(decoded.work, [{ kind: "prompt", pending: prompt }]);
	check(
		"export is integrity checked and includes oversized attachment exactly",
		decoded.complete && decoded.work[0].pending.attachments[0].fileData === fileData,
	);
	await pending.close();
	const pluginPage = await open(ctx, url("plugin-start.html"));
	const pluginCatalogue = await jsonOutput(pluginPage, "#plugin-start-catalogue", (x) => x.entries?.length > 0);
	const pluginExport = await download(pluginPage, "#plugin-start-export");
	assert.deepEqual(plugin.readPluginStartExport(pluginExport), pluginCatalogue);
	assert.deepEqual(pluginCatalogue.entries.find((entry) => entry.intent)?.intent, seeded.pluginIntent);
	check("plugin-start reader preserves immutable exact original options through restart", pluginCatalogue.complete);
	const composerPage = await open(ctx, url("composer.html"));
	await composerPage.locator('[data-action="read"]').click();
	const composerExport = JSON.parse(await download(composerPage, '[data-action="export"]'));
	assert.deepEqual(composerExport.inspection.entries[0].record, composer);
	check(
		"composer reader preserves source/incoming/effective and attachment bytes under original CSP",
		composerExport.inspection.ok,
	);
	const schedulerPage = await open(ctx, url("scheduler.html"));
	await schedulerPage.locator('[data-scheduler-reader-status="ready"]').waitFor();
	const schedulerSection = schedulerPage
		.locator("section")
		.filter({ has: schedulerPage.locator("h2", { hasText: "Record 1" }) });
	const schedulerRead = JSON.parse(await schedulerSection.locator("pre").textContent());
	assert.deepEqual(schedulerRead, seeded.schedulerRecord);
	check("scheduler reader preserves exact current AND submitted form including inactive fields", true);
	const boardPage = await open(ctx, url("board.html"));
	await boardPage.locator('[data-board-reader-status="ready"]').waitFor();
	const boardSection = boardPage.locator("section").filter({ has: boardPage.locator("h2", { hasText: "Record 1" }) });
	const boardRead = JSON.parse(await boardSection.locator("pre").textContent());
	assert.deepEqual(boardRead, seeded.boardRecord);
	check("board reader preserves exact current AND submitted form including inactive picked order and kind", true);
	const after = await seed.evaluate(() => window.fixture.snapshot());
	assert.deepEqual(after, original);
	check("every original localStorage and IDB row remains byte-for-byte unchanged by inspection/export", true);
	const restoredCtx = await context();
	const restoredPage = await open(restoredCtx, url("pending.html"));
	await restoredPage
		.locator("#artifact")
		.setInputFiles({ name: "retained.json", mimeType: "application/json", buffer: Buffer.from(artifact) });
	await restoredPage.locator("#inspect").click();
	await jsonOutput(restoredPage, "#output", (x) => x.complete === true);
	await restoredPage.locator("#restore").click();
	await jsonOutput(restoredPage, "#output", (x) => x.state === "ready" && x.entries?.length === 1);
	const restored = await core.readPendingRecoveryArtifact(await download(restoredPage, "#export"));
	assert.deepEqual(restored.work, decoded.work);
	check("separate fresh profile on SAME origin explicitly restores full checksum-checked artifact", restored.complete);
	check(
		"look-only/explicit restore readers never open a socket or issue a mutation HTTP request",
		sideEffects.length === 0,
	);
	check("actual standalone modules have no page/CSP runtime failures", errors.length === 0);
	check(
		"reader catalogue and immutable hashes still verify after restart/restore",
		(await verifyReaders(server.dataDir)).versions.length === 2,
	);
	check("no task/scheduler publication was created", !existsSync(join(server.dataDir, "scheduler-tasks.json")));
	report.status = "passed";
} catch (error) {
	report.status = "failed";
	report.error = error.message;
	throw error;
} finally {
	report.pageErrors = errors;
	report.sideEffects = sideEffects;
	writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2));
	await Promise.all(contexts.map((ctx) => ctx.close()));
	await browser.close();
	await server.stop();
	rmSync(server.root, { recursive: true, force: true });
	console.log(`retained readers: ${report.status}; ${report.assertions.length} checks; ${output}/result.json`);
}
