/** Isolated native-storage proof: no app/server, model, live profile, chats or reference reads.
 * Run: scripts/sealed.sh node tests/composer-checkpoint-test.mjs
 * Builds the standalone HTML with Vite and the helper + actual memory-only bridge with esbuild.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { build as bundle } from "esbuild";
import { build as viteBuild } from "vite";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = await mkdtemp(join(tmpdir(), "pi-composer-checkpoint-"));
const outDir = join(base, "static");
let server;
let browser;
let checks = 0;
const passed = (name) => {
	checks++;
	console.log(`✓ ${name}`);
};
const equal = (actual, expected, name) => {
	assert(isDeepStrictEqual(actual, expected), name);
};
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

try {
	const built = await viteBuild({
		configFile: false,
		root: join(repo, "web"),
		base: "/",
		logLevel: "warn",
		build: { outDir, emptyOutDir: true, rollupOptions: { input: join(repo, "web/composer-checkpoint-recovery.html") } },
	});
	const outputs = (Array.isArray(built) ? built : [built]).flatMap((result) => result.output);
	const readerModules = outputs.filter((o) => o.type === "chunk").flatMap((o) => Object.keys(o.modules));
	assert(readerModules.some((id) => id.endsWith("/composer-checkpoint-reader.ts")));
	assert(
		readerModules.every((id) => !/node_modules|App\.tsx|plugin-host|composer-bridge|composer-draft/.test(id)),
		"reader must be independent of App/SDK/host runtime",
	);
	const bundled = await bundle({
		entryPoints: {
			"fixture-checkpoint": join(repo, "web/src/composer-checkpoint.ts"),
			"fixture-baseline": join(repo, "web/src/composer-bridge.ts"),
		},
		outdir: outDir,
		bundle: true,
		format: "esm",
		platform: "browser",
		metafile: true,
		logLevel: "silent",
	});
	assert(Object.keys(bundled.metafile.inputs).every((id) => !id.includes("node_modules")));
	passed("standalone reader build has no App, SDK or host runtime dependency");

	server = createServer(async (request, response) => {
		try {
			const pathname = new URL(request.url, "http://fixture.invalid").pathname;
			const file = resolve(outDir, `.${pathname === "/" ? "/composer-checkpoint-recovery.html" : pathname}`);
			if (!file.startsWith(outDir + "/")) throw new Error("outside fixture");
			response.setHeader("Content-Type", `${mime[extname(file)] ?? "application/octet-stream"}; charset=utf-8`);
			response.setHeader("Cache-Control", "no-store");
			response.end(await readFile(file));
		} catch {
			response.writeHead(404).end("Synthetic fixture resource missing");
		}
	});
	await new Promise((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolveListen);
	});
	const origin = `http://127.0.0.1:${server.address().port}`;
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: "block" });
	const requests = [];
	const errors = [];
	context.on("request", (request) => requests.push(request.url()));
	context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
	await context.route("**/*", (route) => {
		const url = route.request().url();
		if (url.startsWith(origin + "/") || url.startsWith("blob:")) return route.continue();
		return route.abort("blockedbyclient");
	});
	await context.addInitScript(() => {
		window.__storageCalls = { writes: 0, deletes: 0, reads: 0 };
		for (const [method, counter] of [
			["setItem", "writes"],
			["removeItem", "deletes"],
			["clear", "deletes"],
			["getItem", "reads"],
		]) {
			const original = Storage.prototype[method];
			Storage.prototype[method] = function (...args) {
				window.__storageCalls[counter]++;
				return original.apply(this, args);
			};
		}
	});
	let page = await context.newPage();
	await page.goto(origin + "/composer-checkpoint-recovery.html");
	await page.locator("button[data-action=read]").waitFor();
	equal(
		await page.evaluate(() => window.__storageCalls),
		{ writes: 0, deletes: 0, reads: 0 },
		"entry must not read/write automatically",
	);
	passed("reader is inert until explicit Read");

	// Real old bridge, real memory sinks, no synthetic model or app connection.
	const baseline = await page.evaluate(async () => {
		const bridge = await import("/fixture-baseline.js");
		window.__memoryOnlyDraft = { text: "", attachments: [] };
		bridge.registerDraftSink((text) => {
			window.__memoryOnlyDraft.text = text;
		});
		bridge.registerAttachmentSink((attachments) => {
			window.__memoryOnlyDraft.attachments = attachments;
		});
		const payload = {
			text: "accepted memory-only",
			attachments: [{ path: "", name: "tiny.bin", fileData: "AA==", size: 1 }],
		};
		return { accepted: bridge.composeToComposer(payload), draft: window.__memoryOnlyDraft, payload };
	});
	assert.equal(baseline.accepted, true);
	equal(baseline.draft, baseline.payload, "actual bridge accepted exact memory sinks");
	await page.reload();
	await page.locator("button[data-action=read]").waitFor();
	assert.equal(await page.evaluate(() => window.__memoryOnlyDraft), undefined);
	await page.locator("button[data-action=read]").click();
	assert.match(await page.locator("[role=status]").textContent(), /^0 stored entries/);
	passed("genuine in-memory-only compose returns true but loses its accepted draft on reload (baseline loss control)");

	const big = Buffer.alloc(1_125_003, 0x97).toString("base64");
	assert(big.length > 1_500_000);
	const source = {
		text: " user \t\r\n e\u0301 漢字 😀\u0000\ud800 X \udfff \n",
		attachments: [
			{
				path: "/synthetic/original",
				name: " keep ",
				mode: "reference",
				isDir: false,
				lines: { start: 1, end: 3 },
				key: "original",
			},
		],
	};
	const incoming = {
		text: '\n<script>globalThis.injected = true</script>\n{"kind":"pi-web-ui/composer-checkpoint","version":1}\t ',
		attachments: [
			{ path: "", name: "large.png", imageData: big, mimeType: "image/png", size: 1_125_003, key: "large-image" },
			{
				path: "",
				name: "binary.bin",
				fileData: "AP8BAg==",
				mimeType: "application/octet-stream",
				size: 4,
				key: "small-file",
			},
			{
				path: "https://reference-only.invalid/do-not-fetch?x=1#opaque",
				name: "<img src=evil onerror=evil()>",
				mode: "page",
				key: "page",
				isDir: false,
			},
			{
				path: "",
				name: "conversation",
				mode: "conversation",
				conversationId: "opaque-other-CID",
				sessionPath: "/never/read/chat.jsonl",
				key: "conversation",
			},
			{
				path: "/never/read/directory",
				name: "directory",
				mode: "lines",
				isDir: true,
				lines: { start: 2, end: 5 },
				conversationId: "opaque",
				sessionPath: "opaque/history",
				mimeType: "text/plain",
				size: 17,
				key: "full-metadata",
			},
		],
	};
	const expected = {
		kind: "pi-web-ui/composer-checkpoint",
		version: 1,
		purpose: "composer-injection",
		recordId: "native-synthetic-injection",
		createdAt: 1780000000000,
		binding: {
			ownerId: "native-original-owner",
			composerId: "native-original-composer",
			conversationId: "native-original-CID",
			sessionId: "native-original-SID",
			revision: 7,
		},
		nextRevision: 8,
		source,
		incoming,
		effective: { text: source.text + incoming.text, attachments: [...source.attachments, ...incoming.attachments] },
	};
	const result = await page.evaluate(async (input) => {
		const module = await import("/fixture-checkpoint.js");
		const expectedBinding = { ...input.binding };
		const store = module.createComposerCheckpointStore({
			storage: localStorage,
			enabled: true,
			owns: (binding) => JSON.stringify(binding) === JSON.stringify(expectedBinding),
		});
		const result = store.checkpoint(input);
		input.source.text = "mutated after call";
		input.incoming.attachments[0].imageData = "AAAA";
		input.effective.attachments[0].lines.start = 999;
		return {
			result,
			hasThen: "then" in result,
			frozen: result.ok && Object.isFrozen(result.record.effective.attachments[0].lines),
			mutate: result.ok && Reflect.set(result.record.effective, "text", "must fail"),
		};
	}, expected);
	assert.equal(result.result.ok, true, "ordinary checkpoint must accept with real native storage");
	equal(result.result.record, expected, "complete source/incoming/effective bytes and metadata, not lengths/hashes");
	assert.equal(result.hasThen, false);
	assert.equal(result.frozen, true);
	assert.equal(result.mutate, false);
	passed(
		"native synchronous acceptance retains exact original/effective data and multiple inline attachments above old boundary",
	);

	const failures = await page.evaluate(async (binding) => {
		const module = await import("/fixture-checkpoint.js");
		const snapshot = () =>
			Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
				.sort()
				.map((key) => [key, localStorage.getItem(key)]);
		const outputs = [];
		for (const mode of ["quota", "unavailable", "partial", "throw-after-write", "readback-throws", "ownership-loss"]) {
			const before = snapshot();
			let wrote = false;
			let ownsCalls = 0;
			const storage = {
				get length() {
					return localStorage.length;
				},
				key: (i) => localStorage.key(i),
				getItem(key) {
					if (wrote && mode === "readback-throws") throw new Error("synthetic readback unavailable");
					return localStorage.getItem(key);
				},
				setItem(key, raw) {
					if (mode === "unavailable") throw new DOMException("synthetic storage denial", "SecurityError");
					localStorage.setItem(key, mode === "partial" ? raw.slice(0, -2) : raw);
					wrote = true;
					if (mode === "throw-after-write") throw new Error("synthetic committed then failed");
				},
			};
			const record = {
				kind: "pi-web-ui/composer-checkpoint",
				version: 1,
				purpose: "composer-injection",
				recordId: `native-${mode}`,
				createdAt: 1780000000001,
				binding,
				nextRevision: binding.revision + 1,
				source: { text: "source", attachments: [] },
				incoming: { text: mode === "quota" ? "Q".repeat(6_000_000) : "injected" },
				effective: { text: mode === "quota" ? "Q".repeat(6_000_000) : "source\ninjected", attachments: [] },
			};
			const store = module.createComposerCheckpointStore({
				storage,
				enabled: true,
				owns: () => mode !== "ownership-loss" || ++ownsCalls === 1,
			});
			const result = store.checkpoint(record);
			// Full original byte comparisons inside the browser; no hash/length-only preservation test.
			const originalsPreserved = before.every(([key, raw]) => localStorage.getItem(key) === raw);
			outputs.push({ mode, ok: result.ok, committed: result.payloadCommitted, code: result.code, originalsPreserved });
		}
		return outputs;
	}, expected.binding);
	for (const failure of failures) {
		assert.equal(failure.ok, false, `${failure.mode} cannot accept`);
		assert.equal(failure.originalsPreserved, true, `${failure.mode} must preserve every original exact value`);
	}
	assert.equal(failures.find((f) => f.mode === "quota").code, "write-failed");
	assert.equal(failures.find((f) => f.mode === "throw-after-write").committed, true);
	assert.equal(failures.find((f) => f.mode === "ownership-loss").committed, true);
	passed(
		"native quota plus injected unavailable/partial/committed-then-failed/readback/ownership failures refuse without damaging originals",
	);

	const seeded = await page.evaluate(async (binding) => {
		const module = await import("/fixture-checkpoint.js");
		const record = {
			kind: "pi-web-ui/composer-checkpoint",
			version: 1,
			purpose: "composer-injection",
			recordId: "retired-original",
			createdAt: 1780000000002,
			binding,
			nextRevision: binding.revision + 1,
			source: { text: "complete original", attachments: [] },
			incoming: { text: "addition" },
			effective: { text: "complete original\naddition", attachments: [] },
		};
		const store = module.createComposerCheckpointStore({ storage: localStorage, enabled: true, owns: () => true });
		const accepted = store.checkpoint(record);
		const stale = structuredClone(record);
		stale.binding.revision++;
		stale.nextRevision++;
		const before = localStorage.getItem(module.composerCheckpointKey(record));
		const staleResult = store.retire(stale);
		const retired = store.retire(record);
		const preserved = localStorage.getItem(module.composerCheckpointKey(record)) === before;
		const unknownKey = module.COMPOSER_CHECKPOINT_PREFIX + "future:v99:opaque";
		localStorage.setItem(unknownKey, "<script>globalThis.injected = true</script> unknown original");
		const corruptKey = module.COMPOSER_CHECKPOINT_PREFIX + "record:v1:malformed";
		localStorage.setItem(corruptKey, "{malformed raw original");
		return {
			accepted: accepted.ok,
			stale: staleResult.ok,
			retired: retired.ok,
			preserved,
			record,
			original: before,
			unknownKey,
			corruptKey,
		};
	}, expected.binding);
	assert(seeded.accepted && !seeded.stale && seeded.retired && seeded.preserved);
	passed("native stale retirement refuses and deliberate retirement appends full marker without removing original");

	// Actual reload after acceptance, then another fresh document/module: no shared in-memory store.
	await page.reload();
	await page.locator("button[data-action=read]").waitFor();
	await page.close();
	page = await context.newPage();
	await page.goto(origin + "/composer-checkpoint-recovery.html");
	await page.locator("button[data-action=read]").waitFor();
	equal(
		await page.evaluate(() => window.__storageCalls),
		{ writes: 0, deletes: 0, reads: 0 },
		"fresh standalone reader is inert",
	);
	const rawBefore = await page.evaluate(() =>
		Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
			.sort()
			.map((key) => [key, localStorage.getItem(key)]),
	);
	await page.locator("button[data-action=read]").click();
	const domEntries = await page
		.locator("article pre")
		.evaluateAll((nodes) => nodes.map((node) => JSON.parse(node.textContent)));
	equal(
		domEntries.find((e) => e.record?.recordId === expected.recordId).record,
		expected,
		"fresh independent reader recovers complete native record after reload",
	);
	const retired = domEntries.find((e) => e.record?.recordId === seeded.record.recordId);
	assert.equal(retired.status, "retired");
	equal(retired.record, seeded.record, "retired record remains complete");
	assert.equal(retired.raw, seeded.original);
	assert.equal(
		domEntries.find((e) => e.key === seeded.unknownKey).raw,
		"<script>globalThis.injected = true</script> unknown original",
	);
	assert.equal(domEntries.find((e) => e.key === seeded.corruptKey).raw, "{malformed raw original");
	assert.equal(await page.locator("article script, article img, article iframe").count(), 0);
	assert.equal(await page.evaluate(() => window.injected), undefined);
	passed(
		"fresh native reader renders exact complete active/retired/unknown/corrupt data as text, never HTML or a carrier",
	);

	const [download] = await Promise.all([
		page.waitForEvent("download"),
		page.locator("button[data-action=export]").click(),
	]);
	const exportPath = join(base, "inspection.json");
	await download.saveAs(exportPath);
	const exported = JSON.parse(await readFile(exportPath, "utf8"));
	equal(exported.inspection.entries, domEntries, "download exports every full raw original and complete decoded field");
	const rawAfter = await page.evaluate(() =>
		Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
			.sort()
			.map((key) => [key, localStorage.getItem(key)]),
	);
	equal(rawAfter, rawBefore, "reader/export cannot write, prune, retire or delete");
	equal(
		await page.evaluate(() => ({ writes: window.__storageCalls.writes, deletes: window.__storageCalls.deletes })),
		{ writes: 0, deletes: 0 },
		"reader has zero storage mutations",
	);
	passed("explicit download exports full originals; reader and export make zero native storage mutations");

	assert(
		requests.every((url) => url.startsWith(origin + "/") || url.startsWith("blob:")),
		"no external/reference network access",
	);
	assert(
		requests.every(
			(url) =>
				!url.includes("/never/read") && !url.includes("reference-only.invalid") && !/\/api\/|\/ws(?:\?|$)/.test(url),
		),
		"no reference, socket or app traffic",
	);
	equal(errors, [], "no native page errors");
	passed("no reference fetch, page/conversation authority, App connection, send, replay or page errors");
	await context.close();
	console.log(
		`Composer checkpoint: ${checks} native/build checks passed. This is module/reader proof, not integrated sink-order proof.`,
	);
} finally {
	if (browser) await browser.close();
	if (server) await new Promise((resolveClose) => server.close(resolveClose));
	await rm(base, { recursive: true, force: true });
}
