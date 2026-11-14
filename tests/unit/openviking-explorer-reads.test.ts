/**
 * Memory Explorer read routes (backend #162): what the acceptance file does not pin — other methods, paging refusals,
 * recent[] ties, the not-ready mark only on abstracts, exact-search truncation and a folder too big to count
 * (served with null counts and `counts_reason: "truncated"`, architecture a979afb3).
 */
import { afterEach, describe, expect, it } from "vitest";
import { textWithReason } from "../../server/openviking/explorer-daemon.js";
import { recentNotes, treeRootRow } from "../../server/openviking/explorer-tree-read.js";
import { OPENVIKING_EXPLORER_ROOTS } from "../../server/openviking/index.js";
import { NOW } from "./openviking-daemon-fake.js";
import { explorerHarness, q, type ExplorerHarness } from "./openviking-explorer-harness.js";

const QA_ROOT = "viking://user/qa/memories";
const PREFS = "viking://user/default/memories/preferences";

let h: ExplorerHarness | null = null;
afterEach(async () => {
	await h?.close();
	h = null;
});
const start = async () => {
	h = await explorerHarness();
	return h;
};

describe("read routes: methods and paging", () => {
	it("answers 405 with Allow for a method the route does not take", async () => {
		const x = await start();
		for (const [method, path, allow] of [
			["POST", "/api/openviking/tree/roots", "GET"],
			["PUT", `/api/openviking/tree?uri=${q(PREFS)}`, "GET"],
			["GET", "/api/openviking/search", "POST"],
		] as const) {
			const reply = await x.call(method, path);
			expect([reply.status, reply.body.error.code, reply.body.error.details.allowed]).toEqual([
				405,
				"METHOD_NOT_ALLOWED",
				[allow],
			]);
		}
		expect(x.fake.calls).toEqual([]);
	});

	it("refuses a negative or non-integer offset; an offset past the end answers no children", async () => {
		const x = await start();
		for (const offset of ["-1", "1.5", "x"]) {
			const reply = await x.call("GET", `/api/openviking/tree?uri=${q(PREFS)}&offset=${offset}`);
			expect([reply.status, reply.body.error.code]).toEqual([400, "INVALID_ARGUMENT"]);
		}
		const past = await x.call("GET", `/api/openviking/tree?uri=${q(PREFS)}&offset=99`);
		expect([past.status, past.body.total, past.body.children]).toEqual([200, 1, []]);
	});

	it("a folder too big to count still serves its level: null counts, counts_reason truncated, never a short count", async () => {
		const x = await start();
		for (let i = 0; i < 20_000; i++) x.fake.store.put(`${QA_ROOT}/cases/n${i}.md`, "x");
		const reply = await x.call("GET", `/api/openviking/tree?uri=${q(QA_ROOT)}`);
		expect(reply.status).toBe(200);
		expect(reply.body).toMatchObject({ notes: null, folders: null, counts_reason: "truncated", last_change: null });
		const cases = reply.body.children.find((c: any) => c.name === "cases");
		expect(cases).toMatchObject({ is_folder: true, notes: null });
	});

	it("a folder counted in full has counts_reason null", async () => {
		const x = await start();
		const reply = await x.call("GET", `/api/openviking/tree?uri=${q(PREFS)}`);
		expect(reply.status).toBe(200);
		expect(reply.body.counts_reason).toBeNull();
		expect(typeof reply.body.notes).toBe("number");
		expect(typeof reply.body.folders).toBe("number");
	});
});

describe("read routes: exact search truncation", () => {
	it("is truncated when a root had more matches than the limit", async () => {
		const x = await start();
		for (let i = 0; i < 5; i++) x.fake.store.put(`${QA_ROOT}/cases/m${i}.md`, "money\n");
		const reply = await x.call("POST", "/api/openviking/search", {
			mode: "exact",
			query: "money",
			roots: [QA_ROOT],
			limit: 3,
		});
		expect([reply.status, reply.body.total, reply.body.truncated]).toEqual([200, 3, true]);
		const all = await x.call("POST", "/api/openviking/search", { mode: "exact", query: "money", roots: [QA_ROOT] });
		expect([all.body.total, all.body.truncated]).toEqual([5, false]);
	});
});

describe("tree readers", () => {
	const qa = OPENVIKING_EXPLORER_ROOTS.find((r) => r.uri === QA_ROOT)!;
	const file = (uri: string, ms: number) => ({
		uri,
		isDir: false,
		size: 1,
		modTime: new Date(ms).toISOString(),
		abstract: null,
	});

	it("an unread or truncated root has null counts; an absent one counts 0", () => {
		expect(treeRootRow(qa, null)).toMatchObject({ read: false, notes: null, folders: null, kinds: null });
		expect(treeRootRow(qa, { state: "truncated" })).toMatchObject({ read: false, notes: null });
		expect(treeRootRow(qa, { state: "absent" })).toMatchObject({ read: true, notes: 0, folders: 0 });
	});

	it("recent[] orders equal times by uri and skips roots the request may not show", () => {
		const walks = OPENVIKING_EXPLORER_ROOTS.map((r) =>
			r.uri === QA_ROOT
				? { state: "read" as const, items: [file(`${QA_ROOT}/cases/b.md`, NOW), file(`${QA_ROOT}/cases/a.md`, NOW)] }
				: null,
		);
		expect(recentNotes(walks, () => true).map((r) => r.uri)).toEqual([
			`${QA_ROOT}/cases/a.md`,
			`${QA_ROOT}/cases/b.md`,
		]);
		expect(recentNotes(walks, (root) => root !== QA_ROOT)).toEqual([]);
	});

	it("the not-ready mark is a reason on abstracts only; a note's own text is never replaced", () => {
		const mark = "# viking://x [Directory abstract is not ready]";
		expect(textWithReason(mark)).toEqual({ text: null, reason: "not_ready" });
		expect(textWithReason(mark, false)).toEqual({ text: mark, reason: null });
		expect(textWithReason("  ")).toEqual({ text: null, reason: "none" });
	});
});
