/**
 * Memory Explorer: the slice acceptance tests, written by the seam task (backend #161, rule 18 Task 1) from
 * `.temper/features/openviking-dashboard/spec-explorer{,-writes,-build}.md` (architecture #541) before either
 * slice is built. Each test is named for its slice and marked `todo` so the suite stays green while it fails;
 * the slice that builds it removes `TODO` and turns it green, and may never weaken or delete an assertion.
 *   reads:  G2 tree, G3 note, G4 search, the owner check and the uri rule on read routes.
 *   writes: G5 edit, G6 delete, undo, G7 change record and /audit.
 * Every refusal code of explorer-types.ts is named in at least one test title. No live daemon call anywhere.
 */
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
	EXPLORER_UNDO_WINDOW_MS,
	escapeRegex,
	OPENVIKING_EXPLORER_ROOTS,
	OPENVIKING_ROLES,
} from "../../server/openviking/index.js";
import { NOW } from "./openviking-daemon-fake.js";
import { eventually, explorerHarness, q, settle, sha256, type ExplorerHarness } from "./openviking-explorer-harness.js";

const TODO = { todo: true };
const NOTE = "viking://user/default/memories/preferences/backend_code.md";
const PREFS = "viking://user/default/memories/preferences";
const IDENTITY = "viking://user/backend/memories/identity.md";
const SOUL = "viking://user/backend/memories/Soul.MD";
const QA_ROOT = "viking://user/qa/memories";
const ALL_ROOTS = OPENVIKING_EXPLORER_ROOTS.map((r) => r.uri);
const NOT_READY = "[Directory abstract is not ready]";

let h: ExplorerHarness | null = null;
async function start(opts: Parameters<typeof explorerHarness>[0] = {}): Promise<ExplorerHarness> {
	h = await explorerHarness(opts);
	return h;
}
afterEach(async () => {
	await h?.close();
	h = null;
});

/** The store's mod_time as the routes must report it: whole seconds (gap D2), ISO with ms. */
const storeModTime = (x: ExplorerHarness, uri: string) =>
	new Date(Math.floor((x.fake.store.nodes.get(uri)?.modTimeMs ?? NaN) / 1000) * 1000).toISOString();
const expectRefusal = (reply: { status: number; body: any }, status: number, code: string) => {
	expect(reply.status).toBe(status);
	expect(reply.body.error.code).toBe(code);
	expect(typeof reply.body.error.message).toBe("string");
};
const edit = (x: ExplorerHarness, uri: string, content: string, opened = storeModTime(x, uri)) =>
	x.call("PUT", "/api/openviking/note", { uri, content, opened_mod_time: opened });

// ---------------------------------------------------------------- reads

describe("reads: owner check and uri rule", () => {
	it("reads: 403 OWNER_ONLY on every read route with a deny gate, before any daemon call", TODO, async () => {
		const x = await start({ gate: "deny" });
		for (const [method, path, body] of [
			["GET", "/api/openviking/tree/roots"],
			["GET", `/api/openviking/tree?uri=${q(PREFS)}`],
			["GET", `/api/openviking/note?uri=${q(NOTE)}&level=full`],
			["POST", "/api/openviking/search", { mode: "meaning", query: "money", roots: ALL_ROOTS }],
		] as const) {
			expectRefusal(await x.call(method, path, body), 403, "OWNER_ONLY");
		}
		expect(x.fake.calls).toEqual([]);
	});

	it("reads: 400 URI_INVALID and 400 URI_OUTSIDE_ROOTS on tree and note, nothing sent", TODO, async () => {
		const x = await start();
		expectRefusal(
			await x.call("GET", `/api/openviking/tree?uri=${q("viking://resources/a/../b")}`),
			400,
			"URI_INVALID",
		);
		expectRefusal(
			await x.call("GET", `/api/openviking/note?uri=${q("viking://resources//b")}&level=full`),
			400,
			"URI_INVALID",
		);
		expectRefusal(
			await x.call("GET", `/api/openviking/note?uri=${q("viking://agent/memories/cases/c1.md")}&level=full`),
			400,
			"URI_OUTSIDE_ROOTS",
		);
		expectRefusal(
			await x.call("GET", `/api/openviking/tree?uri=${q("viking://user/memories/preferences")}`),
			400,
			"URI_OUTSIDE_ROOTS",
		);
		expect(x.fake.calls.filter((c) => c.url.pathname !== "/health")).toEqual([]);
	});

	it("reads: 503 MEMORY_UNREACHABLE on tree, note and search when /health is down", TODO, async () => {
		for (const mode of ["down", "unhealthy"] as const) {
			const x = await start({ mode });
			expectRefusal(await x.call("GET", `/api/openviking/tree?uri=${q(PREFS)}`), 503, "MEMORY_UNREACHABLE");
			expectRefusal(await x.call("GET", `/api/openviking/note?uri=${q(NOTE)}&level=full`), 503, "MEMORY_UNREACHABLE");
			const search = await x.call("POST", "/api/openviking/search", {
				mode: "exact",
				query: "money",
				roots: ALL_ROOTS,
			});
			expectRefusal(search, 503, "MEMORY_UNREACHABLE");
			await x.close();
			h = null;
		}
	});
});

describe("reads: G2 tree", () => {
	it("reads: tree/roots answers the 17 roots in constant order with counts and kinds", TODO, async () => {
		const x = await start();
		const { status, body } = await x.call("GET", "/api/openviking/tree/roots");
		expect(status).toBe(200);
		expect(body.roots.map((r: any) => [r.uri, r.group, r.role])).toEqual(
			OPENVIKING_EXPLORER_ROOTS.map((r) => [r.uri, r.group, r.role]),
		);
		const row = (uri: string) => body.roots.find((r: any) => r.uri === uri);
		const kinds = (k: object) => ({ rule: 0, case: 0, fact: 0, event: 0, document: 0, other: 0, ...k });
		expect(row("viking://resources")).toMatchObject({
			read: true,
			notes: 1,
			folders: 1,
			kinds: kinds({ document: 1 }),
		});
		expect(row("viking://user/default/memories")).toMatchObject({
			read: true,
			notes: 2,
			folders: 2,
			kinds: kinds({ rule: 1, fact: 1 }),
		});
		expect(row("viking://user/backend/memories")).toMatchObject({
			read: true,
			notes: 3,
			folders: 1,
			kinds: kinds({ case: 1, other: 2 }),
		});
		expect(row(QA_ROOT)).toMatchObject({ read: true, notes: 1, folders: 1, kinds: kinds({ case: 1 }) });
		expect(body).toMatchObject({
			notes_total: 1 + 2 + 3 + (OPENVIKING_ROLES.length - 1),
			unread_count: 0,
			roots_partial: false,
		});
		expect(body.health_state).not.toBe("server-unreachable");
		const walks = x.daemonCalls("/api/v1/fs/tree");
		expect(walks.map((c) => c.url.searchParams.get("uri")).sort()).toEqual([...ALL_ROOTS].sort());
		for (const c of walks) {
			expect(Object.fromEntries(c.url.searchParams)).toMatchObject({
				include_abstract: "false",
				level_limit: "32",
				node_limit: "20000",
			});
		}
	});

	it(
		"reads: tree/roots keeps an unread root with null counts, NOT_FOUND root reads 0, notes_total null",
		TODO,
		async () => {
			const x = await start();
			x.fake.state.failures.push({ path: "/api/v1/fs/tree", uri: QA_ROOT, status: 503, code: "UNAVAILABLE" });
			for (const k of x.fake.store.nodes.keys()) if (k.startsWith("viking://user/coo/memories")) x.fake.store.remove(k);
			const { body } = await x.call("GET", "/api/openviking/tree/roots");
			expect(body.roots).toHaveLength(17);
			expect(body.roots.find((r: any) => r.uri === QA_ROOT)).toMatchObject({
				read: false,
				notes: null,
				folders: null,
				kinds: null,
			});
			expect(body.roots.find((r: any) => r.role === "coo")).toMatchObject({ read: true, notes: 0, folders: 0 });
			expect(body).toMatchObject({ notes_total: null, unread_count: 1, roots_partial: true });
		},
	);

	it("reads: tree/roots counts a root whose walk hits node_limit as unread, never short", TODO, async () => {
		const x = await start();
		for (let i = 0; i < 20_000; i++) x.fake.store.put(`viking://user/data/memories/cases/n${i}.md`, "x");
		const { body } = await x.call("GET", "/api/openviking/tree/roots");
		expect(body.roots.find((r: any) => r.role === "data")).toMatchObject({ read: false, notes: null, folders: null });
		expect(body).toMatchObject({ notes_total: null, unread_count: 1, roots_partial: true });
	});

	it("reads: tree/roots recent is the 12 newest files over read roots, locked ones flagged", TODO, async () => {
		const x = await start();
		for (let i = 0; i < 14; i++)
			x.fake.store.put(`viking://user/ops/memories/events/e${i}.md`, `event ${i}`, NOW - (20 - i) * 1000);
		x.fake.store.put(IDENTITY, "backend identity", NOW - 500);
		x.fake.store.put(`${QA_ROOT}/cases/newest-but-unread.md`, "unread", NOW);
		x.fake.state.failures.push({ path: "/api/v1/fs/tree", uri: QA_ROOT, status: 503, code: "UNAVAILABLE" });
		const { body } = await x.call("GET", "/api/openviking/tree/roots");
		expect(body.recent).toHaveLength(12);
		expect(body.recent[0]).toEqual({
			uri: IDENTITY,
			root: "viking://user/backend/memories",
			kind: "other",
			size: 16,
			mod_time: storeModTime(x, IDENTITY),
			locked: true,
		});
		expect(body.recent.slice(1).map((r: any) => r.uri)).toEqual(
			Array.from({ length: 11 }, (_, i) => `viking://user/ops/memories/events/e${13 - i}.md`),
		);
		expect(body.recent.slice(1).every((r: any) => r.kind === "event" && r.locked === false)).toBe(true);
	});

	it(
		"reads: tree on a file is 400 NOT_A_FOLDER; limit outside 1-200 is 400; paging by offset/limit",
		TODO,
		async () => {
			const x = await start();
			expectRefusal(await x.call("GET", `/api/openviking/tree?uri=${q(NOTE)}`), 400, "NOT_A_FOLDER");
			for (const limit of ["0", "201", "x"]) {
				expect((await x.call("GET", `/api/openviking/tree?uri=${q(PREFS)}&limit=${limit}`)).status).toBe(400);
			}
			for (let i = 0; i < 35; i++) x.fake.store.put(`${PREFS}/p${i}.md`, `p${i}`, NOW - i * 1000);
			const first = await x.call("GET", `/api/openviking/tree?uri=${q(PREFS)}`);
			expect(first.status).toBe(200);
			expect(first.body.total).toBe(36);
			expect(first.body.children).toHaveLength(30);
			expect(first.body.children[0].uri).toBe(`${PREFS}/p0.md`);
			const rest = await x.call("GET", `/api/openviking/tree?uri=${q(PREFS)}&offset=30&limit=200`);
			expect(rest.body.children).toHaveLength(6);
		},
	);

	it("reads: tree abstract_reason is not_ready / none / locked, never placeholder text", TODO, async () => {
		const x = await start();
		x.fake.store.folder("viking://user/default/memories/entities", "Entities L0");
		x.fake.store.folder("viking://user/default/memories/events", "");
		x.fake.store.put("viking://user/default/memories/events/e1.md", "e1");
		x.fake.store.put("viking://user/default/memories/identity.md", "shared identity");
		const { status, body } = await x.call("GET", `/api/openviking/tree?uri=${q("viking://user/default/memories")}`);
		expect(status).toBe(200);
		expect(JSON.stringify(body)).not.toContain(NOT_READY);
		const child = (name: string) => body.children.find((c: any) => c.name === name);
		expect(child("preferences")).toMatchObject({
			is_folder: true,
			kind: "rule",
			notes: 1,
			abstract: null,
			abstract_reason: "not_ready",
			locked: false,
		});
		expect(child("entities")).toMatchObject({
			is_folder: true,
			kind: "fact",
			notes: 1,
			abstract: "Entities L0",
			abstract_reason: null,
		});
		expect(child("events")).toMatchObject({ is_folder: true, abstract: null, abstract_reason: "none" });
		expect(child("identity.md")).toMatchObject({
			is_folder: false,
			notes: null,
			abstract: null,
			abstract_reason: "locked",
			locked: true,
		});
		expect(body).toMatchObject({
			uri: "viking://user/default/memories",
			root: "viking://user/default/memories",
			abstract: "viking://user/default/memories abstract",
			abstract_reason: null,
		});
		const times = body.children.map((c: any) => Date.parse(c.mod_time));
		expect(times).toEqual([...times].sort((a, b) => b - a));
	});
});

describe("reads: G3 note", () => {
	it("reads: note 400 LEVEL_INVALID, 400 NOT_A_FILE for full on a folder", TODO, async () => {
		const x = await start();
		expectRefusal(await x.call("GET", `/api/openviking/note?uri=${q(NOTE)}&level=L2`), 400, "LEVEL_INVALID");
		expectRefusal(await x.call("GET", `/api/openviking/note?uri=${q(NOTE)}`), 400, "LEVEL_INVALID");
		expectRefusal(await x.call("GET", `/api/openviking/note?uri=${q(PREFS)}&level=full`), 400, "NOT_A_FILE");
	});

	it(
		"reads: note full is the file's text; abstract/overview of a file are its folder's, text_of says so (D1)",
		TODO,
		async () => {
			const x = await start();
			x.fake.store.folder(PREFS, "Preferences L0", "Preferences L1");
			const full = await x.call("GET", `/api/openviking/note?uri=${q(NOTE)}&level=full`);
			expect(full.body).toMatchObject({
				uri: NOTE,
				root: "viking://user/default/memories",
				kind: "rule",
				is_folder: false,
				size: 30,
				mod_time: storeModTime(x, NOTE),
				level: "full",
				text: "Money in integer minor units.\n",
				text_reason: null,
				text_of: NOTE,
			});
			const abstract = await x.call("GET", `/api/openviking/note?uri=${q(NOTE)}&level=abstract`);
			expect(abstract.body).toMatchObject({ level: "abstract", text: "Preferences L0", text_of: PREFS });
			const overview = await x.call("GET", `/api/openviking/note?uri=${q(NOTE)}&level=overview`);
			expect(overview.body).toMatchObject({ level: "overview", text: "Preferences L1", text_of: PREFS });
			x.fake.store.folder(PREFS);
			const notReady = await x.call("GET", `/api/openviking/note?uri=${q(PREFS)}&level=abstract`);
			expect(notReady.body).toMatchObject({ is_folder: true, text: null, text_reason: "not_ready", text_of: PREFS });
			// fs/stat backs every note read.
			const statted = x.daemonCalls("/api/v1/fs/stat").map((c) => c.url.searchParams.get("uri"));
			expect(statted.filter((u) => u === NOTE).length).toBeGreaterThanOrEqual(3);
			expect(statted).toContain(PREFS);
		},
	);

	it("reads: note last_write is the newest changelog line for the uri, else null", TODO, async () => {
		const x = await start();
		x.seedChangelog([
			{
				timestamp: "2026-11-10T01:00:00.000Z",
				action: "add",
				source: "lead_direct",
				role: "backend",
				task_id: 7,
				uri: NOTE,
				summary: "a",
			},
			{
				timestamp: "2026-11-11T01:00:00.000Z",
				action: "update",
				source: "queue_done",
				role: "qa",
				task_id: "qa #9",
				uri: NOTE,
				summary: "b",
			},
			{
				timestamp: "2026-11-11T02:00:00.000Z",
				action: "update",
				source: "lead_direct",
				role: "ops",
				task_id: null,
				uri: `${NOTE}x`,
				summary: "c",
			},
		]);
		const note = await x.call("GET", `/api/openviking/note?uri=${q(NOTE)}&level=full`);
		expect(note.body.last_write).toEqual({
			role: "qa",
			source: "queue_done",
			task_id: "qa #9",
			ts: "2026-11-11T01:00:00.000Z",
		});
		const other = await x.call(
			"GET",
			`/api/openviking/note?uri=${q("viking://resources/pi-web-ui/README.md")}&level=full`,
		);
		expect(other.body.last_write).toBeNull();
	});

	it("reads: note 403 SETUP_FILE_LOCKED on identity.md / soul.md in any case, no content read", TODO, async () => {
		const x = await start();
		for (const uri of [IDENTITY, SOUL]) {
			for (const level of ["abstract", "overview", "full"]) {
				expectRefusal(
					await x.call("GET", `/api/openviking/note?uri=${q(uri)}&level=${level}`),
					403,
					"SETUP_FILE_LOCKED",
				);
			}
		}
		expect(x.fake.calls.filter((c) => c.url.pathname.startsWith("/api/v1/content/"))).toEqual([]);
	});

	it("reads: note 404 NOT_FOUND for a missing uri, 502 MEMORY_ERROR for another daemon failure", TODO, async () => {
		const x = await start();
		expectRefusal(
			await x.call("GET", `/api/openviking/note?uri=${q(`${PREFS}/missing.md`)}&level=full`),
			404,
			"NOT_FOUND",
		);
		expectRefusal(await x.call("GET", `/api/openviking/tree?uri=${q(`${PREFS}/missing`)}`), 404, "NOT_FOUND");
		x.fake.state.failures.push({ path: "/api/v1/fs/stat", status: 500, code: "INTERNAL" });
		expectRefusal(await x.call("GET", `/api/openviking/note?uri=${q(NOTE)}&level=full`), 502, "MEMORY_ERROR");
	});
});

describe("reads: G4 search", () => {
	const search = (x: ExplorerHarness, body: object) => x.call("POST", "/api/openviking/search", body);

	it("reads: search 400 ROOT_UNKNOWN for a root that is not exactly one of the 17", TODO, async () => {
		const x = await start();
		for (const roots of [["viking://agent/memories"], [`${QA_ROOT}/cases`], [QA_ROOT, "viking://user/memories"]]) {
			expectRefusal(await search(x, { mode: "meaning", query: "money", roots }), 400, "ROOT_UNKNOWN");
		}
		expect(x.daemonCalls("/api/v1/search/find")).toEqual([]);
	});

	it("reads: search 400 SEARCH_INVALID for mode, query, roots and limit outside the contract", TODO, async () => {
		const x = await start();
		const good = { mode: "meaning", query: "money", roots: [QA_ROOT], limit: 12 };
		for (const bad of [
			{ mode: "fuzzy" },
			{ query: "" },
			{ query: "   " },
			{ query: "x".repeat(501) },
			{ roots: [] },
			{ roots: QA_ROOT },
			{ limit: 0 },
			{ limit: 201 },
			{ limit: 1.5 },
		]) {
			expectRefusal(await search(x, { ...good, ...bad }), 400, "SEARCH_INVALID");
		}
		expect((await search(x, { ...good, query: ` ${"x".repeat(500)} ` })).status).toBe(200);
	});

	it("reads: meaning search is one find; relative = score / max computed server-side; stat per uri", TODO, async () => {
		const x = await start();
		x.fake.state.findHits.push(
			{ uri: NOTE, score: 0.8, abstract: "money rule" },
			{ uri: "viking://resources/pi-web-ui/README.md", score: 0.4, abstract: "readme" },
			{ uri: `${QA_ROOT}/cases/c1.md`, score: 0.2, abstract: "qa case" },
		);
		x.fake.state.failures.push({
			path: "/api/v1/fs/stat",
			uri: `${QA_ROOT}/cases/c1.md`,
			status: 503,
			code: "UNAVAILABLE",
		});
		const { status, body } = await search(x, { mode: "meaning", query: "money", roots: ALL_ROOTS });
		expect(status).toBe(200);
		const finds = x.daemonCalls("/api/v1/search/find");
		expect(finds).toHaveLength(1);
		expect(finds[0].body).toMatchObject({ query: "money", target_uri: ALL_ROOTS, limit: 12 });
		expect(body.hits.map((hit: any) => [hit.uri, hit.score, hit.relative])).toEqual([
			[NOTE, 0.8, 1],
			["viking://resources/pi-web-ui/README.md", 0.4, 0.5],
			[`${QA_ROOT}/cases/c1.md`, 0.2, 0.25],
		]);
		expect(body.hits[0]).toMatchObject({
			root: "viking://user/default/memories",
			kind: "rule",
			abstract: "money rule",
			line_number: null,
			line_text: null,
			size: 30,
			mod_time: storeModTime(x, NOTE),
		});
		expect(body.hits[1].kind).toBe("document");
		expect(body.hits[2]).toMatchObject({ size: null, mod_time: null });
		expect(body).toMatchObject({
			mode: "meaning",
			query: "money",
			total: 3,
			results_partial: false,
			unread_count: 0,
			unread_roots: [],
			locked_hidden_count: 0,
		});
	});

	it("reads: exact search greps each root with the query regex-escaped, case-insensitive", TODO, async () => {
		const x = await start();
		x.fake.store.put(`${QA_ROOT}/cases/literal.md`, "first line\nsee A.B(c here\n");
		x.fake.store.put(`${QA_ROOT}/cases/regex.md`, "aXb(c only matches as a regex\n");
		const query = "a.b(c";
		const { status, body } = await search(x, { mode: "exact", query, roots: [QA_ROOT, "viking://resources"] });
		expect(status).toBe(200);
		const greps = x.daemonCalls("/api/v1/search/grep");
		expect(greps).toHaveLength(2);
		expect(greps.map((c) => c.body)).toEqual(
			expect.arrayContaining([
				{ uri: QA_ROOT, pattern: escapeRegex(query), case_insensitive: true, node_limit: 50 },
				{ uri: "viking://resources", pattern: escapeRegex(query), case_insensitive: true, node_limit: 50 },
			]),
		);
		expect(body.hits).toEqual([
			{
				uri: `${QA_ROOT}/cases/literal.md`,
				root: QA_ROOT,
				kind: "case",
				score: null,
				relative: null,
				abstract: null,
				line_number: 2,
				line_text: "see A.B(c here",
				size: 26,
				mod_time: storeModTime(x, `${QA_ROOT}/cases/literal.md`),
			},
		]);
	});

	it(
		"reads: a failed grep root is in unread_roots and results_partial; a failed find is 502 MEMORY_ERROR",
		TODO,
		async () => {
			const x = await start();
			x.fake.store.put(`${QA_ROOT}/cases/money.md`, "money\n");
			x.fake.state.failures.push({
				path: "/api/v1/search/grep",
				uri: "viking://resources",
				status: 503,
				code: "UNAVAILABLE",
			});
			const exact = await search(x, { mode: "exact", query: "money", roots: [QA_ROOT, "viking://resources"] });
			expect(exact.status).toBe(200);
			expect(exact.body).toMatchObject({
				results_partial: true,
				unread_count: 1,
				unread_roots: ["viking://resources"],
			});
			expect(exact.body.hits.map((hit: any) => hit.uri)).toEqual([`${QA_ROOT}/cases/money.md`]);
			x.fake.state.failures.push({ path: "/api/v1/search/find", status: 500, code: "INTERNAL" });
			expectRefusal(await search(x, { mode: "meaning", query: "money", roots: ALL_ROOTS }), 502, "MEMORY_ERROR");
		},
	);

	it("reads: search drops locked hits and counts them in locked_hidden_count", TODO, async () => {
		const x = await start();
		x.fake.state.findHits.push(
			{ uri: IDENTITY, score: 0.9, abstract: "identity" },
			{ uri: NOTE, score: 0.3, abstract: "rule" },
		);
		const meaning = await search(x, { mode: "meaning", query: "who", roots: ALL_ROOTS });
		expect(meaning.body.hits.map((hit: any) => [hit.uri, hit.relative])).toEqual([[NOTE, 1]]);
		expect(meaning.body.locked_hidden_count).toBe(1);
		const exact = await search(x, { mode: "exact", query: "backend", roots: ["viking://user/backend/memories"] });
		expect(exact.body.hits.map((hit: any) => hit.uri)).toEqual(["viking://user/backend/memories/cases/c1.md"]);
		expect(exact.body.locked_hidden_count).toBe(2);
		expect(JSON.stringify([meaning.body, exact.body])).not.toMatch(/identity\.md|soul\.md/i);
	});
});

// ---------------------------------------------------------------- writes

describe("writes: owner check, uri rule, lock", () => {
	it(
		"writes: 403 OWNER_ONLY on edit, delete and undo with a deny gate; nothing sent, nothing logged",
		TODO,
		async () => {
			const x = await start({ gate: "deny" });
			expectRefusal(
				await x.call("PUT", "/api/openviking/note", {
					uri: NOTE,
					content: "x",
					opened_mod_time: new Date(NOW).toISOString(),
				}),
				403,
				"OWNER_ONLY",
			);
			expectRefusal(await x.call("DELETE", `/api/openviking/note?uri=${q(NOTE)}`), 403, "OWNER_ONLY");
			expectRefusal(await x.call("POST", "/api/openviking/undo", { operation_id: "op-1-00000000" }), 403, "OWNER_ONLY");
			expect(x.fake.calls).toEqual([]);
			expect(x.changelog()).toEqual([]);
		},
	);

	it(
		"writes: 400 URI_INVALID / URI_OUTSIDE_ROOTS and 403 SETUP_FILE_LOCKED on edit and delete, store untouched",
		TODO,
		async () => {
			const x = await start();
			const opened = new Date(NOW).toISOString();
			expectRefusal(
				await x.call("PUT", "/api/openviking/note", {
					uri: "viking://resources/../x",
					content: "x",
					opened_mod_time: opened,
				}),
				400,
				"URI_INVALID",
			);
			expectRefusal(
				await x.call("DELETE", `/api/openviking/note?uri=${q("viking://agent/memories/cases/c1.md")}`),
				400,
				"URI_OUTSIDE_ROOTS",
			);
			for (const uri of [IDENTITY, SOUL]) {
				expectRefusal(
					await x.call("PUT", "/api/openviking/note", { uri, content: "x", opened_mod_time: storeModTime(x, uri) }),
					403,
					"SETUP_FILE_LOCKED",
				);
				expectRefusal(await x.call("DELETE", `/api/openviking/note?uri=${q(uri)}`), 403, "SETUP_FILE_LOCKED");
			}
			x.fake.clock.advance(EXPLORER_UNDO_WINDOW_MS + 1);
			await settle();
			expect(x.daemonCalls("/api/v1/content/write")).toEqual([]);
			expect(x.daemonCalls("/api/v1/fs", "DELETE")).toEqual([]);
			expect(x.changelog()).toEqual([]);
		},
	);
});

describe("writes: G5 edit", () => {
	it("writes: edit 413 CONTENT_TOO_LARGE over 1 MiB of UTF-8, 400 EDIT_INVALID for a bad body", TODO, async () => {
		const x = await start();
		expectRefusal(await edit(x, NOTE, "é".repeat(524_289)), 413, "CONTENT_TOO_LARGE");
		for (const body of [
			{ uri: NOTE, content: "x" },
			{ uri: NOTE, content: "x", opened_mod_time: "yesterday" },
			{ uri: NOTE, content: 42, opened_mod_time: storeModTime(x, NOTE) },
		]) {
			expectRefusal(await x.call("PUT", "/api/openviking/note", body), 400, "EDIT_INVALID");
		}
		expect(x.daemonCalls("/api/v1/content/write")).toEqual([]);
		expect((await edit(x, NOTE, "a".repeat(1024 * 1024))).status).toBe(200);
	});

	it("writes: edit 409 NOTE_CHANGED when mod_time differs as ms; nothing written, nothing logged", TODO, async () => {
		const x = await start();
		const current = storeModTime(x, NOTE);
		const later = new Date(Date.parse(current) + 1).toISOString();
		const reply = await edit(x, NOTE, "new text", later);
		expectRefusal(reply, 409, "NOTE_CHANGED");
		expect(reply.body.error.details).toEqual({ current_mod_time: current });
		expect(x.daemonCalls("/api/v1/content/write")).toEqual([]);
		expect(x.fake.store.nodes.get(NOTE)?.content).toBe("Money in integer minor units.\n");
		expect(x.changelog()).toEqual([]);
		// Same instant written without ms is the same mod_time.
		expect((await edit(x, NOTE, "new text", current.replace(".000Z", "Z"))).status).toBe(200);
	});

	it("writes: edit with the same text is 200 changed:false, no write, no line", TODO, async () => {
		const x = await start();
		const reply = await edit(x, NOTE, "Money in integer minor units.\n");
		expect(reply).toEqual({ status: 200, body: { changed: false } });
		expect(x.daemonCalls("/api/v1/content/write")).toEqual([]);
		expect(x.changelog()).toEqual([]);
	});

	it("writes: edit applies now, writes replace/manual, appends one owner_edit line", TODO, async () => {
		const x = await start();
		const before = "Money in integer minor units.\n";
		const reply = await edit(x, NOTE, "Money in cents.\n");
		expect(reply.status).toBe(200);
		expect(reply.body).toEqual({
			operation_id: expect.stringMatching(/^op-\d+-[0-9a-f]{8}$/),
			uri: NOTE,
			changed: true,
			mod_time: storeModTime(x, NOTE),
			undo_until: new Date(NOW + EXPLORER_UNDO_WINDOW_MS).toISOString(),
			before_sha256: sha256(before),
			after_sha256: sha256("Money in cents.\n"),
			audit_recorded: true,
		});
		const writes = x.daemonCalls("/api/v1/content/write", "POST");
		expect(writes).toHaveLength(1);
		expect(writes[0].body).toMatchObject({
			uri: NOTE,
			content: "Money in cents.\n",
			mode: "replace",
			edit_source: "manual",
		});
		expect(
			Object.keys(writes[0].body as object).every((k) => ["uri", "content", "mode", "wait", "edit_source"].includes(k)),
		).toBe(true);
		expect(x.changelog()).toEqual([
			expect.objectContaining({
				role: "owner",
				source: "owner_explorer",
				action: "owner_edit",
				operation_id: reply.body.operation_id,
				uri: NOTE,
				outcome: "applied",
				undo_of: null,
				before_sha256: sha256(before),
				after_sha256: sha256("Money in cents.\n"),
				diff: null,
				task_id: null,
				session_id: null,
			}),
		]);
	});

	it("writes: edit 502 MEMORY_WRITE_FAILED when the store refuses; nothing logged", TODO, async () => {
		const x = await start();
		x.fake.state.failures.push({ path: "/api/v1/content/write", status: 500, code: "INTERNAL" });
		expectRefusal(await edit(x, NOTE, "Money in cents.\n"), 502, "MEMORY_WRITE_FAILED");
		expect(x.changelog()).toEqual([]);
	});

	it("writes: a failed changelog append answers audit_recorded:false and the change stands", TODO, async () => {
		const x = await start();
		mkdirSync(x.changelogPath);
		const reply = await edit(x, NOTE, "Money in cents.\n");
		expect(reply.status).toBe(200);
		expect(reply.body).toMatchObject({ changed: true, audit_recorded: false });
		expect(x.fake.store.nodes.get(NOTE)?.content).toBe("Money in cents.\n");
	});
});

describe("writes: G6 delete", () => {
	it("writes: delete a folder is 400 FOLDER_DELETE_REFUSED; a missing note 404 NOT_FOUND", TODO, async () => {
		const x = await start();
		expectRefusal(await x.call("DELETE", `/api/openviking/note?uri=${q(PREFS)}`), 400, "FOLDER_DELETE_REFUSED");
		expectRefusal(await x.call("DELETE", `/api/openviking/note?uri=${q(`${PREFS}/missing.md`)}`), 404, "NOT_FOUND");
		x.fake.clock.advance(EXPLORER_UNDO_WINDOW_MS + 1);
		await settle();
		expect(x.daemonCalls("/api/v1/fs", "DELETE")).toEqual([]);
	});

	it(
		"writes: delete is held 10 000 ms, then exactly one DELETE recursive=false and an owner_delete applied line",
		TODO,
		async () => {
			const x = await start();
			const reply = await x.call("DELETE", `/api/openviking/note?uri=${q(NOTE)}`);
			expect(reply).toEqual({
				status: 202,
				body: {
					operation_id: expect.stringMatching(/^op-\d+-[0-9a-f]{8}$/),
					uri: NOTE,
					state: "pending",
					applies_at: new Date(NOW + EXPLORER_UNDO_WINDOW_MS).toISOString(),
				},
			});
			x.fake.clock.advance(EXPLORER_UNDO_WINDOW_MS - 1);
			await settle();
			expect(x.daemonCalls("/api/v1/fs", "DELETE")).toEqual([]);
			expect(x.changelog()).toEqual([]);
			x.fake.clock.advance(1);
			await eventually(() => expect(x.changelog()).toHaveLength(1));
			const deletes = x.daemonCalls("/api/v1/fs", "DELETE");
			expect(deletes).toHaveLength(1);
			expect(Object.fromEntries(deletes[0].url.searchParams)).toMatchObject({ uri: NOTE, recursive: "false" });
			expect(x.fake.store.nodes.has(NOTE)).toBe(false);
			expect(x.changelog()[0]).toMatchObject({
				action: "owner_delete",
				operation_id: reply.body.operation_id,
				outcome: "applied",
				after_sha256: null,
			});
		},
	);

	it("writes: a store error when the window closes is owner_delete failed", TODO, async () => {
		const x = await start();
		x.fake.state.failures.push({ path: "/api/v1/fs", method: "DELETE", status: 500, code: "INTERNAL" });
		const reply = await x.call("DELETE", `/api/openviking/note?uri=${q(NOTE)}`);
		x.fake.clock.advance(EXPLORER_UNDO_WINDOW_MS);
		await eventually(() => expect(x.changelog()).toHaveLength(1));
		expect(x.changelog()[0]).toMatchObject({
			action: "owner_delete",
			operation_id: reply.body.operation_id,
			outcome: "failed",
		});
		expect(x.fake.store.nodes.has(NOTE)).toBe(true);
	});

	it("writes: 409 DELETE_PENDING on an edit or a second delete of a uri with a pending delete", TODO, async () => {
		const x = await start();
		const pending = await x.call("DELETE", `/api/openviking/note?uri=${q(NOTE)}`);
		const again = await x.call("DELETE", `/api/openviking/note?uri=${q(NOTE)}`);
		expectRefusal(again, 409, "DELETE_PENDING");
		expect(again.body.error.details).toEqual({ operation_id: pending.body.operation_id });
		const editing = await edit(x, NOTE, "Money in cents.\n");
		expectRefusal(editing, 409, "DELETE_PENDING");
		expect(editing.body.error.details).toEqual({ operation_id: pending.body.operation_id });
		expect(x.daemonCalls("/api/v1/content/write")).toEqual([]);
	});

	it(
		"writes: the shutdown hook ends a pending delete as owner_delete not_applied_restart, nothing deleted",
		TODO,
		async () => {
			const x = await start();
			const pending = await x.call("DELETE", `/api/openviking/note?uri=${q(NOTE)}`);
			await x.shutdown();
			x.fake.clock.advance(EXPLORER_UNDO_WINDOW_MS + 1);
			await settle();
			expect(x.daemonCalls("/api/v1/fs", "DELETE")).toEqual([]);
			expect(x.changelog()).toEqual([
				expect.objectContaining({
					action: "owner_delete",
					operation_id: pending.body.operation_id,
					outcome: "not_applied_restart",
				}),
			]);
		},
	);
});

describe("writes: undo", () => {
	const undo = (x: ExplorerHarness, operation_id: unknown) => x.call("POST", "/api/openviking/undo", { operation_id });

	it("writes: undo a delete cancels it: owner_undo then owner_delete cancelled, no store call", TODO, async () => {
		const x = await start();
		const pending = await x.call("DELETE", `/api/openviking/note?uri=${q(NOTE)}`);
		const id = pending.body.operation_id;
		expect(await undo(x, id)).toEqual({ status: 200, body: { operation_id: id, state: "cancelled" } });
		x.fake.clock.advance(EXPLORER_UNDO_WINDOW_MS + 1);
		await settle();
		expect(x.daemonCalls("/api/v1/fs", "DELETE")).toEqual([]);
		expect(x.fake.store.nodes.has(NOTE)).toBe(true);
		expect(x.changelog().map((l) => [l.action, l.operation_id, l.outcome, l.undo_of])).toEqual([
			["owner_undo", id, "applied", "delete"],
			["owner_delete", id, "cancelled", null],
		]);
	});

	it("writes: undo an edit writes back the pre-edit text and appends owner_undo applied", TODO, async () => {
		const x = await start();
		const before = "Money in integer minor units.\n";
		const edited = await edit(x, NOTE, "Money in cents.\n");
		x.fake.clock.advance(2_000);
		const reply = await undo(x, edited.body.operation_id);
		expect(reply).toEqual({
			status: 200,
			body: { operation_id: edited.body.operation_id, state: "undone", mod_time: storeModTime(x, NOTE) },
		});
		expect(x.fake.store.nodes.get(NOTE)?.content).toBe(before);
		const writes = x.daemonCalls("/api/v1/content/write", "POST");
		expect(writes.map((c) => (c.body as { content: string }).content)).toEqual(["Money in cents.\n", before]);
		expect(x.changelog().map((l) => [l.action, l.outcome, l.undo_of])).toEqual([
			["owner_edit", "applied", null],
			["owner_undo", "applied", "edit"],
		]);
	});

	it(
		"writes: undo an edit is 409 UNDO_REFUSED when the note changed since; owner_undo refused, nothing written",
		TODO,
		async () => {
			const x = await start();
			const edited = await edit(x, NOTE, "Money in cents.\n");
			x.fake.store.put(NOTE, "someone else wrote this\n", NOW + 3_000);
			const reply = await undo(x, edited.body.operation_id);
			expectRefusal(reply, 409, "UNDO_REFUSED");
			expect(reply.body.error.details).toEqual({ current_mod_time: storeModTime(x, NOTE) });
			expect(x.daemonCalls("/api/v1/content/write", "POST")).toHaveLength(1);
			expect(x.fake.store.nodes.get(NOTE)?.content).toBe("someone else wrote this\n");
			expect(x.changelog().map((l) => [l.action, l.outcome, l.undo_of])).toEqual([
				["owner_edit", "applied", null],
				["owner_undo", "refused", "edit"],
			]);
		},
	);

	it(
		"writes: undo after the window or after the operation ended is 410 UNDO_WINDOW_CLOSED with its state",
		TODO,
		async () => {
			const x = await start();
			const edited = await edit(x, NOTE, "Money in cents.\n");
			x.fake.clock.advance(EXPLORER_UNDO_WINDOW_MS + 1);
			const late = await undo(x, edited.body.operation_id);
			expectRefusal(late, 410, "UNDO_WINDOW_CLOSED");
			expect(late.body.error.details).toHaveProperty("state");
			const deleted = await x.call("DELETE", `/api/openviking/note?uri=${q("viking://resources/pi-web-ui/README.md")}`);
			x.fake.clock.advance(EXPLORER_UNDO_WINDOW_MS);
			await eventually(() => expect(x.changelog().some((l) => l.action === "owner_delete")).toBe(true));
			const applied = await undo(x, deleted.body.operation_id);
			expectRefusal(applied, 410, "UNDO_WINDOW_CLOSED");
			expect(applied.body.error.details).toEqual({ state: "applied" });
			const second = await edit(x, NOTE, "Money in euros.\n");
			expect((await undo(x, second.body.operation_id)).status).toBe(200);
			const twice = await undo(x, second.body.operation_id);
			expectRefusal(twice, 410, "UNDO_WINDOW_CLOSED");
			expect(twice.body.error.details).toEqual({ state: "undone" });
		},
	);

	it("writes: undo an unknown operation id is 404 OPERATION_UNKNOWN", TODO, async () => {
		const x = await start();
		for (const id of ["op-1794631805120-3f9a1c2e", "not-an-id", 42]) {
			expectRefusal(await undo(x, id), 404, "OPERATION_UNKNOWN");
		}
		expect(x.changelog()).toEqual([]);
	});
});

describe("writes: G7 change record and /audit", () => {
	it("writes: changelog lines carry sha256 only, never the note text; file is 0600", TODO, async () => {
		const x = await start();
		const secret = "SECRET-NOTE-TEXT-7f3a";
		x.fake.store.put(`${QA_ROOT}/cases/s.md`, `old ${secret} old\n`);
		const edited = await edit(x, `${QA_ROOT}/cases/s.md`, `new ${secret} new\n`);
		await x.call("POST", "/api/openviking/undo", { operation_id: edited.body.operation_id });
		await x.call("DELETE", `/api/openviking/note?uri=${q(`${QA_ROOT}/cases/s.md`)}`);
		x.fake.clock.advance(EXPLORER_UNDO_WINDOW_MS);
		await eventually(() => expect(x.changelog()).toHaveLength(3));
		const raw = readFileSync(x.changelogPath, "utf8");
		expect(raw).not.toContain(secret);
		for (const line of x.changelog()) {
			for (const field of ["before_sha256", "after_sha256"]) {
				expect(line[field] === null || /^[0-9a-f]{64}$/.test(String(line[field]))).toBe(true);
			}
			expect(line.diff).toBeNull();
		}
		expect(statSync(x.changelogPath).mode & 0o777).toBe(0o600);
	});

	it(
		"writes: /audit shows owner_edit / owner_delete with operation_id, outcome, derived undone; owner_only filters",
		TODO,
		async () => {
			const x = await start();
			x.seedChangelog([
				{
					timestamp: new Date(NOW - 60_000).toISOString(),
					action: "update",
					source: "lead_direct",
					role: "qa",
					uri: `${QA_ROOT}/cases/c1.md`,
					summary: "qa wrote",
				},
			]);
			const undone = await edit(x, NOTE, "Money in cents.\n");
			await x.call("POST", "/api/openviking/undo", { operation_id: undone.body.operation_id });
			const kept = await edit(x, "viking://resources/pi-web-ui/README.md", "# readme v2\n");
			const deleted = await x.call("DELETE", `/api/openviking/note?uri=${q(`${QA_ROOT}/cases/c1.md`)}`);
			x.fake.clock.advance(EXPLORER_UNDO_WINDOW_MS);
			await eventually(() => expect(x.changelog().some((l) => l.action === "owner_delete")).toBe(true));
			const all = await x.call("GET", "/api/openviking/audit?limit=50");
			expect(all.status).toBe(200);
			const byOp = (id: string) => all.body.events.filter((e: any) => e.operation_id === id);
			expect(byOp(undone.body.operation_id)).toEqual([
				expect.objectContaining({ action: "owner_edit", outcome: "applied", undone: true }),
			]);
			expect(byOp(kept.body.operation_id)).toEqual([
				expect.objectContaining({ action: "owner_edit", outcome: "applied", undone: false }),
			]);
			expect(byOp(deleted.body.operation_id)).toEqual([
				expect.objectContaining({ action: "owner_delete", outcome: "applied", undone: false }),
			]);
			expect(all.body.events.some((e: any) => e.action === "owner_undo" || e.raw_action === "owner_undo")).toBe(false);
			expect(all.body.events.find((e: any) => e.source === "lead_direct")).toMatchObject({
				operation_id: null,
				outcome: null,
				undone: null,
			});
			const mine = await x.call("GET", "/api/openviking/audit?limit=50&owner_only=true");
			expect(mine.body.events.map((e: any) => e.action).sort()).toEqual(["owner_delete", "owner_edit", "owner_edit"]);
		},
	);

	// Live now (the current /overview already holds it); the writes slice must keep it green.
	it("writes: owner lines never count as session commits, promotions or rejections in /overview", async () => {
		const x = await start();
		const line = (action: string, uri: string, extra: object = {}) => ({
			timestamp: new Date(NOW - 60_000).toISOString(),
			role: "owner",
			source: "owner_explorer",
			action,
			operation_id: "op-1-0000000a",
			uri,
			outcome: "applied",
			undo_of: null,
			before_sha256: null,
			after_sha256: null,
			summary: "owner edited a note: 1 -> 2 bytes",
			diff: null,
			task_id: null,
			session_id: null,
			...extra,
		});
		x.seedChangelog([
			line("owner_edit", "viking://session/s1"),
			line("owner_edit", NOTE),
			line("owner_delete", "viking://resources/pi-web-ui/README.md"),
			line("owner_undo", `${QA_ROOT}/cases/c1.md`, { undo_of: "edit" }),
		]);
		const { status, body } = await x.call("GET", "/api/openviking/overview");
		expect(status).toBe(200);
		expect(body.changelog).toMatchObject({ session_commits_24h: 0, promotions_24h: 0, rejected_24h: 0 });
	});
});
