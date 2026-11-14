/**
 * R-OWNER-INTERIM-1 (spec-explorer-owner.md, architecture rm-b489fae6), backend #162: until the passkey owner session
 * deploys (backend #165) the read routes serve only what `/api/openviking/entries` already shows without a session.
 * The server's own gate (`ownerCheckPending`): every write refused; a read passes only when every root whose
 * content it would show is a shared root. tree/roots: all 17 rows with counts, `recent[]` from shared roots only.
 */
import type { Request } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { OPENVIKING_EXPLORER_ROOTS, ownerCheckPending } from "../../server/openviking/index.js";
import { NOW } from "./openviking-daemon-fake.js";
import { explorerHarness, q, type ExplorerHarness } from "./openviking-explorer-harness.js";

const SHARED = ["viking://resources", "viking://user/default/memories"];
const QA_ROOT = "viking://user/qa/memories";
const QA_NOTE = `${QA_ROOT}/cases/c1.md`;
const NOTE = "viking://user/default/memories/preferences/backend_code.md";
const req = {} as Request;

let h: ExplorerHarness | null = null;
afterEach(async () => {
	await h?.close();
	h = null;
});
const start = async () => {
	h = await explorerHarness({ gate: "production" });
	return h;
};
const expectOwnerOnly = (reply: { status: number; body: any }) => {
	expect(reply.status).toBe(403);
	expect(reply.body.error.code).toBe("OWNER_ONLY");
};

describe("owner gate: ownerCheckPending (R-OWNER-INTERIM-1)", () => {
	it("refuses every write", () => {
		expect(ownerCheckPending(req, { kind: "write" })).toBe(false);
	});

	it("passes a read of shared roots only, and a counts-only read", () => {
		expect(ownerCheckPending(req, { kind: "read", roots: [] })).toBe(true);
		expect(ownerCheckPending(req, { kind: "read", roots: SHARED })).toBe(true);
		expect(ownerCheckPending(req, { kind: "read", roots: [SHARED[0], QA_ROOT] })).toBe(false);
		for (const root of OPENVIKING_EXPLORER_ROOTS.filter((r) => r.role !== null)) {
			expect(ownerCheckPending(req, { kind: "read", roots: [root.uri] })).toBe(false);
		}
	});
});

describe("read routes with the production gate", () => {
	it("tree/roots: 17 rows with counts; recent[] holds no role-root uri", async () => {
		const x = await start();
		// The newest files are in role roots: an interim recent[] must still skip them.
		for (let i = 0; i < 14; i++) x.fake.store.put(`viking://user/ops/memories/events/e${i}.md`, `e${i}`, NOW - i);
		const { status, body } = await x.call("GET", "/api/openviking/tree/roots");
		expect(status).toBe(200);
		expect(body.roots).toHaveLength(17);
		expect(body.roots.every((r: any) => r.read === true && typeof r.notes === "number")).toBe(true);
		expect(body.notes_total).toBe(body.roots.reduce((n: number, r: any) => n + r.notes, 0));
		expect(body.recent.map((r: any) => r.uri).sort()).toEqual(
			[NOTE, "viking://resources/pi-web-ui/README.md", "viking://user/default/memories/entities/pi-web-ui.md"].sort(),
		);
		expect(body.recent.every((r: any) => SHARED.includes(r.root))).toBe(true);
	});

	it("tree, note and search on a role root: 403 OWNER_ONLY, nothing sent", async () => {
		const x = await start();
		expectOwnerOnly(await x.call("GET", `/api/openviking/tree?uri=${q(QA_ROOT)}`));
		expectOwnerOnly(await x.call("GET", `/api/openviking/tree?uri=${q(`${QA_ROOT}/cases`)}`));
		expectOwnerOnly(await x.call("GET", `/api/openviking/note?uri=${q(QA_NOTE)}&level=full`));
		expectOwnerOnly(await x.call("POST", "/api/openviking/search", { mode: "meaning", query: "q", roots: [QA_ROOT] }));
		expectOwnerOnly(
			await x.call("POST", "/api/openviking/search", { mode: "exact", query: "q", roots: [...SHARED, QA_ROOT] }),
		);
		expect(x.fake.calls).toEqual([]);
	});

	it("tree, note and search on the shared roots: 200", async () => {
		const x = await start();
		x.fake.state.findHits.push({ uri: NOTE, score: 0.5, abstract: "money" });
		const tree = await x.call("GET", `/api/openviking/tree?uri=${q("viking://user/default/memories")}`);
		expect(tree.status).toBe(200);
		const note = await x.call("GET", `/api/openviking/note?uri=${q(NOTE)}&level=full`);
		expect([note.status, note.body.text]).toEqual([200, "Money in integer minor units.\n"]);
		const meaning = await x.call("POST", "/api/openviking/search", { mode: "meaning", query: "money", roots: SHARED });
		expect([meaning.status, meaning.body.hits.map((hit: any) => hit.uri)]).toEqual([200, [NOTE]]);
		const exact = await x.call("POST", "/api/openviking/search", { mode: "exact", query: "money", roots: SHARED });
		expect([exact.status, exact.body.hits.map((hit: any) => hit.uri)]).toEqual([200, [NOTE]]);
	});
});
