/**
 * Memory Explorer, specialists nested under their department (Frontend #364; Architecture #597 v2 §5l.15-5l.17,
 * R-V2-SPMEM-20): cases M-106..M-113 of the pinned specialist-memory cases, through the real explorer routes over the
 * daemon fake. Case -> test map: explorer-specialists-cases.md. Store listings and configs are the cases' fixtures.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { explorerKindOf, explorerKindSegmentOf, explorerPrincipalOf } from "../../server/openviking/explorer-rules.js";
import type { OwnerWriteOp } from "../../server/openviking/owner-session-types.js";
import { OPENVIKING_EXPLORER_ROOTS } from "../../server/openviking/memory-tree.js";
import { explorerUri, memoryCase, resolved } from "../lib/department-specialists-memory-cases.js";
import { NOW } from "./openviking-daemon-fake.js";
import { type ExplorerHarness, explorerHarness, q } from "./openviking-explorer-harness.js";
import { FakePasskey } from "./openviking-owner-fakes.js";
import { expectOwnerOnly, type OwnerHarness, ownerHarness, PI_RP } from "./openviking-owner-harness.js";

const ARCH = "viking://user/architecture/memories";
const archRoot = OPENVIKING_EXPLORER_ROOTS.find((r) => r.uri === ARCH);
if (!archRoot) throw new Error("architecture root missing");
const ARCH_ROOT = archRoot;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
	await Promise.all(open.splice(0).map((x) => x.close()));
});

/** pi-identity's identities folder with one specialist.json per configured slug (Phase 1's shape). */
function identitiesWith(dept: string, configs: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "ov-identities-"));
	for (const [slug, status] of Object.entries(configs)) {
		const folder = join(dir, dept, "specialists", slug);
		mkdirSync(folder, { recursive: true });
		const config = { v: 1, id: slug, title: `Specialist ${slug}`, status, tools: { allow: ["read"] } };
		writeFileSync(join(folder, "specialist.json"), `${JSON.stringify(config, null, 2)}\n`);
	}
	return dir;
}

/** The explorer over a store seeded from a tree case: one item per `spec_listing` slug, one notebook per listed one. */
async function treeCase(id: string): Promise<ExplorerHarness> {
	const input = memoryCase(id).input as {
		dept: string;
		spec_listing: string[];
		notebook_listing: string[];
		configs: Record<string, string>;
	};
	const x = await explorerHarness({ identitiesDir: identitiesWith(input.dept, input.configs) });
	open.push(x);
	const base = `viking://user/${input.dept}/memories`;
	for (const slug of input.spec_listing) x.fake.store.put(`${base}/specialists/${slug}/gotcha/deploy/m-1.md`, "m1\n");
	for (const slug of input.notebook_listing) x.fake.store.put(`${base}/notebook/specialists/${slug}.md`, "notes\n");
	return x;
}

/** The case's node fields from the answer: slug, label and the three canonical URIs. */
const caseFields = (slugs: Array<Record<string, unknown>>) =>
	slugs.map((s) => ({ slug: s.slug, label: s.label, notebook: s.notebook, memories: s.memories, archive: s.archive }));
const expectedNodes = (id: string) =>
	(resolved(memoryCase(id).expect.nodes) as Array<Record<string, unknown>>).map((n) => ({
		...n,
		memories: explorerUri(n.memories as string),
		archive: explorerUri(n.archive as string),
	}));

describe("tree: a department root shows its Specialists node (R-V2-SPMEM-20, §5l.15)", () => {
	it("M-106: slugs are the union of specialists/ and notebook/specialists/; labels from config; URL query is no authority", async () => {
		const c = memoryCase("M-106");
		const x = await treeCase("M-106");
		const query = c.input.query as Record<string, string>;
		const extra = Object.entries(query)
			.map(([k, v]) => `&${k}=${encodeURIComponent(v)}`)
			.join("");
		const r = await x.call("GET", `/api/openviking/tree?uri=${q(ARCH)}${extra}`);
		expect(r.status).toBe(200);
		expect(r.body.specialists).not.toBeNull();
		expect(r.body.specialists.uri).toBe(`${ARCH}/specialists`);
		expect(r.body.specialists.read).toBe(true);
		expect(caseFields(r.body.specialists.slugs)).toEqual(expectedNodes("M-106"));
		const [db2, sre1] = r.body.specialists.slugs;
		expect(db2).toMatchObject({ principal: "architecture/db-2", has_notebook: true, has_memories: false, notes: 0 });
		expect(sre1).toMatchObject({ principal: "architecture/sre-1", has_notebook: true, has_memories: true, notes: 1 });
		for (const word of c.private ?? []) expect(JSON.stringify(r.body)).not.toContain(word);
		// The one count is untouched: the root's notes still include the specialist files (R-EXPLORER-COUNT-1).
		const roots = await x.call("GET", "/api/openviking/tree/roots");
		expect(roots.body.roots).toHaveLength(17);
	});

	it("M-107: no slug in either listing -> no Specialists node", async () => {
		const x = await treeCase("M-107");
		const r = await x.call("GET", `/api/openviking/tree?uri=${q(ARCH)}`);
		expect(r.status).toBe(200);
		expect(memoryCase("M-107").expect).toMatchObject({ specialists_node: false, nodes: [] });
		expect(r.body.specialists).toBeNull();
	});

	it("M-108: a slug root without a config is listed and labelled `no config`, never hidden", async () => {
		const x = await treeCase("M-108");
		const r = await x.call("GET", `/api/openviking/tree?uri=${q(ARCH)}`);
		expect(r.status).toBe(200);
		expect(caseFields(r.body.specialists.slugs)).toEqual(expectedNodes("M-108"));
		expect(r.body.specialists.slugs[0]).toMatchObject({ has_notebook: false, has_memories: true });
	});

	it("only a department root answers the node; other folders keep `specialists: null`", async () => {
		const x = await treeCase("M-106");
		for (const uri of ["viking://user/default/memories", `${ARCH}/specialists`, `${ARCH}/notebook`]) {
			const r = await x.call("GET", `/api/openviking/tree?uri=${q(uri)}`);
			expect(r.status, uri).toBe(200);
			expect(r.body.specialists, uri).toBeNull();
		}
	});

	it("a malformed path under specialists/ stays listed with kind other (never hidden, §5l.15)", async () => {
		const x = await treeCase("M-106");
		x.fake.store.put(`${ARCH}/specialists/Bad_Name/x.md`, "bad\n");
		x.fake.store.put(`${ARCH}/specialists/readme.md`, "stray\n");
		x.fake.store.put(`${ARCH}/specialists/sre-1/instructions/i.md`, "not a layout folder\n");
		const r = await x.call("GET", `/api/openviking/tree?uri=${q(ARCH)}`);
		const others = r.body.specialists.others as Array<{ uri: string; name: string; kind: string }>;
		expect(others.map((o) => [o.name, o.kind]).sort()).toEqual([
			["Bad_Name", "other"],
			["readme.md", "other"],
		]);
		expect(r.body.specialists.slugs.map((s: { slug: string }) => s.slug)).toEqual(["db-2", "sre-1"]);
		const slugRoot = await x.call("GET", `/api/openviking/tree?uri=${q(`${ARCH}/specialists/sre-1`)}`);
		const kinds = Object.fromEntries(
			(slugRoot.body.children as Array<{ name: string; kind: string }>).map((ch) => [ch.name, ch.kind]),
		);
		expect(kinds).toEqual({ gotcha: "other", instructions: "other" });
	});

	it("read error: a listing that fails keeps the node with read false and counts null (§5l.17)", async () => {
		const x = await treeCase("M-106");
		x.fake.state.failures.push({
			path: "/api/v1/fs/tree",
			uri: `${ARCH}/specialists`,
			status: 500,
			code: "INTERNAL",
		});
		const r = await x.call("GET", `/api/openviking/tree?uri=${q(ARCH)}`);
		expect(r.status).toBe(200);
		expect(r.body.specialists).toMatchObject({ read: false });
		for (const s of r.body.specialists.slugs) expect(s.notes).toBeNull();
	});
});

describe("reads: principal and kind from the URI (§5l.15-5l.16)", () => {
	it("M-109: the owner view reads a specialist archive; principal from the URI, kind from the slug root", async () => {
		const c = memoryCase("M-109");
		const uri = resolved(c.input.uri as string);
		const x = await explorerHarness();
		open.push(x);
		x.fake.store.put(uri, "summary\n");
		const r = await x.call("GET", `/api/openviking/note?uri=${q(uri)}&level=full`);
		expect(r.status).toBe(200);
		expect(r.body.principal).toBe(c.expect.principal);
		expect(explorerKindSegmentOf(uri, ARCH_ROOT)).toBe(c.expect.kind_segment);
		expect(r.body.kind).toBe(explorerKindOf(uri, ARCH_ROOT));
	});

	it("kind: under specialists/<slug>/ the first segment below the slug root decides, one table", () => {
		const slugRoot = `${ARCH}/specialists/sre-1`;
		expect(explorerKindOf(`${slugRoot}/preferences/t/m.md`, ARCH_ROOT)).toBe("rule");
		expect(explorerKindOf(`${slugRoot}/cases/t/m.md`, ARCH_ROOT)).toBe("case");
		expect(explorerKindOf(`${slugRoot}/archive/c1/f-1/summary.md`, ARCH_ROOT)).toBe("other");
		expect(explorerKindSegmentOf(`${slugRoot}/_ejected/cases/t/m.md`, ARCH_ROOT)).toBe("_ejected");
		// Malformed slug: the department rule reads `specialists`, kind other, never hidden.
		expect(explorerKindSegmentOf(`${ARCH}/specialists/Bad_Name/cases/m.md`, ARCH_ROOT)).toBe("specialists");
		expect(explorerKindOf(`${ARCH}/specialists/Bad_Name/cases/m.md`, ARCH_ROOT)).toBe("other");
		expect(explorerKindOf(`${ARCH}/cases/c1.md`, ARCH_ROOT)).toBe("case");
	});

	it("principal: <d> or <d>/<slug> from the URI alone; shared and projects have none", () => {
		const shared = OPENVIKING_EXPLORER_ROOTS.find((r) => r.group === "shared");
		const projects = OPENVIKING_EXPLORER_ROOTS.find((r) => r.group === "projects");
		if (!shared || !projects) throw new Error("roots missing");
		expect(explorerPrincipalOf(`${ARCH}/specialists/sre-1/gotcha/d/m.md`, ARCH_ROOT)).toBe("architecture/sre-1");
		expect(explorerPrincipalOf(`${ARCH}/cases/c1.md`, ARCH_ROOT)).toBe("architecture");
		expect(explorerPrincipalOf(`${ARCH}/specialists/Bad_Name/m.md`, ARCH_ROOT)).toBe("architecture");
		expect(explorerPrincipalOf(`${shared.uri}/preferences/x.md`, shared)).toBeNull();
		expect(explorerPrincipalOf(`${projects.uri}/pi-web-ui/README.md`, projects)).toBeNull();
	});

	it("search: each hit carries its principal from its URI, never from note metadata (§5l.16)", async () => {
		const x = await explorerHarness();
		open.push(x);
		const si = resolved("@SI");
		x.fake.store.put(si, "---\nprincipal: backend/forged\n---\nbody\n");
		x.fake.state.findHits.push(
			{ uri: si, score: 0.9, abstract: "deploy gotcha" },
			{ uri: `${ARCH}/cases/c1.md`, score: 0.5, abstract: "case" },
		);
		const r = await x.call("POST", "/api/openviking/search", { mode: "meaning", query: "deploy", roots: [ARCH] });
		expect(r.status).toBe(200);
		const principals = Object.fromEntries(
			(r.body.hits as Array<{ uri: string; principal: string | null }>).map((h) => [h.uri, h.principal]),
		);
		expect(principals).toEqual({ [si]: "architecture/sre-1", [`${ARCH}/cases/c1.md`]: "architecture" });
	});

	it("M-112: an alias is no Explorer URI -> 400 URI_OUTSIDE_ROOTS", async () => {
		const c = memoryCase("M-112");
		const x = await explorerHarness();
		open.push(x);
		const r = await x.call("GET", `/api/openviking/note?uri=${q(c.input.uri as string)}&level=full`);
		expect({ status: r.status, code: r.body.error.code }).toEqual({ status: 400, code: c.expect.code });
	});

	it("M-113: the setup-file lock holds under a specialist root -> 403 SETUP_FILE_LOCKED", async () => {
		const c = memoryCase("M-113");
		const x = await explorerHarness();
		open.push(x);
		const uri = c.input.uri as string;
		x.fake.store.put(uri, "who I am\n");
		const r = await x.call("GET", `/api/openviking/note?uri=${q(uri)}&level=full`);
		expect({ status: r.status, code: r.body.error.code }).toEqual({ status: 403, code: c.expect.code });
	});
});

describe("writes: the same owner gates, no principal stamp, no hygiene (§5l.16)", () => {
	const OPENED_MS = NOW - 300_000;
	const OPENED = new Date(OPENED_MS).toISOString();
	const harnesses: OwnerHarness[] = [];
	afterEach(async () => {
		await Promise.all(harnesses.splice(0).map((x) => x.close()));
	});
	async function enrolled(uri: string) {
		const x = await ownerHarness();
		harnesses.push(x);
		x.fake.store.put(uri, "before\n", OPENED_MS);
		const passkey = new FakePasskey(PI_RP.rpID);
		await x.owned(passkey);
		const raw = JSON.stringify({ uri, content: "after\n", opened_mod_time: OPENED });
		const op: OwnerWriteOp = { method: "PUT", uri, opened_mod_time: OPENED, body_sha256: sha256(raw) };
		return { x, passkey, raw, op };
	}

	it("M-110: an edit with its own passkey assertion applies as written; principal from the URI", async () => {
		const c = memoryCase("M-110");
		const uri = resolved(c.input.uri as string);
		const { x, passkey, raw, op } = await enrolled(uri);
		const before = x.fake.calls.length;
		const r = await x.write("PUT", "/api/openviking/note", { assertion: await x.assertion(passkey, op), rawBody: raw });
		expect(r.status).toBe(200);
		// stamps_principal false: the store holds exactly the owner's text.
		expect(x.fake.store.nodes.get(uri)?.content).toBe("after\n");
		// hygiene_triggered false: one write to this uri, no move, delete or other write.
		const changing = x.fake.calls
			.slice(before)
			.filter((call) => call.method === "DELETE" || /\/(content\/write|fs\/mv)$/.test(call.url.pathname));
		expect(changing.map((call) => call.url.pathname)).toEqual(["/api/v1/content/write"]);
		const line = x.changelog().at(-1) ?? {};
		expect(Object.keys(line)).not.toContain("principal");
		expect(Object.keys(line)).not.toContain("specialist");
		const read = await x.call("GET", `/api/openviking/note?uri=${q(uri)}&level=full`);
		expect(read.status).toBe(200);
		expect((read.body as { principal: string }).principal).toBe(c.expect.principal);
		expect(explorerKindSegmentOf(uri, ARCH_ROOT)).toBe(c.expect.kind_segment);
		expect(c.expect).toMatchObject({ stamps_principal: false, hygiene_triggered: false });
	});

	it("M-111: the same edit without an assertion -> 403 OWNER_ONLY, nothing written", async () => {
		const c = memoryCase("M-111");
		const uri = resolved(c.input.uri as string);
		const { x, raw } = await enrolled(uri);
		expectOwnerOnly(await x.write("PUT", "/api/openviking/note", { rawBody: raw }));
		expect(x.fake.store.nodes.get(uri)?.content).toBe("before\n");
		expect(c.expect.code).toBe("OWNER_ONLY");
	});
});
