/**
 * R-OWNER-READ-1 (spec-explorer-owner.md; Security rm-8841fede), backend #166, replacing #162's interim rule: every
 * read needs the passkey owner session, shared roots included. The server's gate with no owner check wired
 * (`ownerCheckMissing`) refuses every read and every write. tree/roots asks the gate per root for `recent[]`, so a
 * gate that passes some roots only never leaks a file name from the others.
 */
import type { Request } from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
	OPENVIKING_EXPLORER_ROOTS,
	type OpenVikingOwnerGate,
	ownerCheckMissing,
} from "../../server/openviking/index.js";
import { NOW } from "./openviking-daemon-fake.js";
import { explorerHarness, q, type ExplorerHarness } from "./openviking-explorer-harness.js";

const SHARED = ["viking://resources", "viking://user/default/memories"];
const QA_ROOT = "viking://user/qa/memories";
const QA_NOTE = `${QA_ROOT}/cases/c1.md`;
const NOTE = "viking://user/default/memories/preferences/backend_code.md";
const req = {} as Request;

/** A gate that passes counts and the shared roots only (to prove `recent[]` follows the gate root by root). */
const sharedOnly: OpenVikingOwnerGate = (_req, access) =>
	access.kind === "read" && access.roots.every((root) => SHARED.includes(root));

let h: ExplorerHarness | null = null;
afterEach(async () => {
	await h?.close();
	h = null;
});
const start = async (gate: "production" | OpenVikingOwnerGate) => {
	h = await explorerHarness({ gate });
	return h;
};
const expectOwnerOnly = (reply: { status: number; body: any }) => {
	expect(reply.status).toBe(403);
	expect(reply.body.error.code).toBe("OWNER_ONLY");
};

describe("owner gate with no owner check wired: ownerCheckMissing (R-OWNER-READ-1)", () => {
	it("refuses every write", () => {
		expect(ownerCheckMissing(req, { kind: "write", op: { method: "POST", operation_id: "op-1-00000000" } })).toBe(
			false,
		);
	});

	it("refuses every read: counts only, shared roots and each role root", () => {
		expect(ownerCheckMissing(req, { kind: "read", roots: [] })).toBe(false);
		expect(ownerCheckMissing(req, { kind: "read", roots: SHARED })).toBe(false);
		for (const root of OPENVIKING_EXPLORER_ROOTS) {
			expect(ownerCheckMissing(req, { kind: "read", roots: [root.uri] })).toBe(false);
		}
	});
});

describe("read routes with the production default gate", () => {
	it("tree/roots, and tree, note and search on a role root or a shared root: 403 OWNER_ONLY, nothing sent", async () => {
		const x = await start("production");
		expectOwnerOnly(await x.call("GET", "/api/openviking/tree/roots"));
		expectOwnerOnly(await x.call("GET", `/api/openviking/tree?uri=${q(QA_ROOT)}`));
		expectOwnerOnly(await x.call("GET", `/api/openviking/tree?uri=${q(`${QA_ROOT}/cases`)}`));
		expectOwnerOnly(await x.call("GET", `/api/openviking/note?uri=${q(QA_NOTE)}&level=full`));
		expectOwnerOnly(await x.call("POST", "/api/openviking/search", { mode: "meaning", query: "q", roots: [QA_ROOT] }));
		expectOwnerOnly(
			await x.call("POST", "/api/openviking/search", { mode: "exact", query: "q", roots: [...SHARED, QA_ROOT] }),
		);
		expectOwnerOnly(await x.call("GET", `/api/openviking/tree?uri=${q("viking://user/default/memories")}`));
		expectOwnerOnly(await x.call("GET", `/api/openviking/note?uri=${q(NOTE)}&level=full`));
		expectOwnerOnly(await x.call("POST", "/api/openviking/search", { mode: "exact", query: "money", roots: SHARED }));
		expect(x.fake.calls).toEqual([]);
	});
});

describe("read routes ask the gate per root", () => {
	it("tree/roots: 17 rows with counts; recent[] holds no uri from a root the gate refuses", async () => {
		const x = await start(sharedOnly);
		// The newest files are in role roots: recent[] must still skip them.
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

	it("tree, note and search on a root the gate refuses: 403 OWNER_ONLY, nothing sent", async () => {
		const x = await start(sharedOnly);
		expectOwnerOnly(await x.call("GET", `/api/openviking/tree?uri=${q(QA_ROOT)}`));
		expectOwnerOnly(await x.call("GET", `/api/openviking/note?uri=${q(QA_NOTE)}&level=full`));
		expectOwnerOnly(
			await x.call("POST", "/api/openviking/search", { mode: "exact", query: "q", roots: [...SHARED, QA_ROOT] }),
		);
		expect(x.fake.calls).toEqual([]);
	});

	it("the owner gate runs before the setup-file lock: identity.md under a refused root is OWNER_ONLY, under a passed one SETUP_FILE_LOCKED", async () => {
		const x = await start(sharedOnly);
		expectOwnerOnly(await x.call("GET", `/api/openviking/note?uri=${q(`${QA_ROOT}/identity.md`)}&level=full`));
		const shared = await x.call(
			"GET",
			`/api/openviking/note?uri=${q("viking://user/default/memories/identity.md")}&level=full`,
		);
		expect([shared.status, shared.body.error.code]).toEqual([403, "SETUP_FILE_LOCKED"]);
		expect(x.fake.calls).toEqual([]);
	});

	it("tree, note and search on roots the gate passes: 200", async () => {
		const x = await start(sharedOnly);
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
