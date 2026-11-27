// @vitest-environment jsdom
/**
 * Memory Explorer, v2 §5l.15-5l.17 (Architecture #597, R-V2-SPMEM-20): the page side of a department's Specialists
 * node. Written failing-first by Frontend #364 (the server seam, tests/unit/openviking-explorer-specialists.test.ts);
 * Frontend's Task 2 makes them pass by turning `notBuilt(` into `it(`, never by deleting or weakening a case.
 *
 * The page runs on its real HTTP client against a fake server that answers the server's own typed contract
 * (explorer-types.ts), so the cases bind to what the server sends and what the owner perceives (roles, names, text),
 * never to the web's internal types or CSS. The frozen-markup cases are live `it` now and must stay green (rule 38).
 */
import { createHash } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	OpenVikingExplorerKindCounts,
	OpenVikingSearchHit,
	OpenVikingSpecialistsNode,
	OpenVikingTreeChild,
	OpenVikingTreeFolderResponse,
	OpenVikingTreeRootsResponse,
} from "../../server/openviking/explorer-types.js";
import { MemoryExplorerPage } from "../../web/src/components/MemoryExplorerPage.js";
import type { OwnerWebAuthn } from "../../web/src/memory-explorer/owner-session.js";
import { byRole, click, flush, oneByRole, text, typeInto } from "./memory-explorer/explorer-dom.js";

/** Task 2 turns these into `it`. Skipped meanwhile, so the land gate stays green while they are unbuilt. */
const notBuilt = it.skip;

const AT = "2026-11-14T01:21:00.000Z";
const SHARED = "viking://user/default/memories";
const ARCH = "viking://user/architecture/memories";
const OPS = "viking://user/ops/memories";
const SPEC = `${ARCH}/specialists`;
const NOTEBOOKS = `${ARCH}/notebook/specialists`;
const SRE = `${SPEC}/sre-1`;
const SRE_NOTE = `${SRE}/archive/2026-11-12-run.md`;
/** An untrusted child name from the store (Security SP5): must reach the page as text only. */
const HOSTILE = `<img src=x onerror="window.__pwned=1">`;
const KINDS: OpenVikingExplorerKindCounts = { rule: 1, case: 0, fact: 0, event: 0, document: 0, other: 0 };

const slugRow = (
	slug: string,
	label: "retired" | "no config" | null,
	notebook: boolean,
	memories: boolean,
	notes: number | null,
) => ({
	slug,
	principal: `architecture/${slug}`,
	label,
	notebook: `${NOTEBOOKS}/${slug}.md`,
	memories: `${SPEC}/${slug}`,
	archive: `${SPEC}/${slug}/archive`,
	has_notebook: notebook,
	has_memories: memories,
	notes,
});

/** §5l.15: sre-1 active with both places, dba-2 memories only (no config), ret-3 notebook only (retired, no notes). */
const NODE: OpenVikingSpecialistsNode = {
	uri: SPEC,
	read: true,
	slugs: [
		slugRow("dba-2", "no config", false, true, 2),
		slugRow("ret-3", "retired", true, false, 0),
		slugRow("sre-1", null, true, true, 3),
	],
	others: [{ uri: `${SPEC}/${encodeURIComponent(HOSTILE)}`, name: HOSTILE, is_folder: false, kind: "other" }],
};
const UNREAD_NODE: OpenVikingSpecialistsNode = { uri: SPEC, read: false, slugs: [], others: [] };

const child = (uri: string, isFolder: boolean, notes: number | null): OpenVikingTreeChild => ({
	uri,
	name: uri.slice(uri.lastIndexOf("/") + 1),
	is_folder: isFolder,
	kind: "other",
	size: isFolder ? null : 40,
	mod_time: AT,
	notes: isFolder ? notes : null,
	abstract: null,
	abstract_reason: "none",
	locked: false,
});

function folder(
	uri: string,
	children: OpenVikingTreeChild[],
	specialists: OpenVikingSpecialistsNode | null,
): OpenVikingTreeFolderResponse {
	return {
		uri,
		root: uri.startsWith(ARCH) ? ARCH : uri.startsWith(OPS) ? OPS : SHARED,
		notes: children.length,
		folders: children.filter((c) => c.is_folder).length,
		last_change: AT,
		abstract: null,
		abstract_reason: "none",
		counts_reason: null,
		total: children.length,
		children,
		specialists,
	} as OpenVikingTreeFolderResponse;
}

const root = (uri: string, group: "shared" | "department", role: string | null, notes: number) => ({
	uri,
	group,
	role,
	read: true,
	notes,
	folders: 2,
	kinds: KINDS,
});

const ROOTS = {
	checked_at: AT,
	health_state: "healthy",
	notes_total: 12,
	unread_count: 0,
	roots_partial: false,
	roots: [
		root(SHARED, "shared", null, 1),
		root(ARCH, "department", "architecture", 9),
		root(OPS, "department", "ops", 2),
	],
	recent: [{ uri: `${SHARED}/preferences/ui.md`, root: SHARED, kind: "rule", size: 40, mod_time: AT, locked: false }],
} as unknown as OpenVikingTreeRootsResponse;

const hit = (uri: string, root: string, principal: string | null): OpenVikingSearchHit => ({
	uri,
	root,
	kind: "other",
	principal,
	score: 0.8,
	relative: 1,
	abstract: "deploy steps",
	line_number: null,
	line_text: null,
	size: 40,
	mod_time: AT,
});

/** Every listing the store gives; a uri the page asks for that is not here was built by the page, not the server. */
function fakeServer(options: { node?: OpenVikingSpecialistsNode | null } = {}) {
	const node = options.node === undefined ? NODE : options.node;
	const trees: Record<string, OpenVikingTreeFolderResponse> = {
		[SHARED]: folder(SHARED, [child(`${SHARED}/preferences`, true, 1)], null),
		// The store has a `specialists/` folder only when the node has something in it.
		[ARCH]: folder(
			ARCH,
			[...(node ? [child(SPEC, true, 5)] : []), child(`${ARCH}/notebook`, true, 2), child(`${ARCH}/cases`, true, 2)],
			node,
		),
		[OPS]: folder(OPS, [child(`${OPS}/cases`, true, 2)], null),
		[`${SRE}`]: folder(SRE, [child(`${SRE}/preferences`, true, 1), child(`${SRE}/_ejected`, true, 1)], null),
		[`${SRE}/archive`]: folder(`${SRE}/archive`, [child(SRE_NOTE, false, null)], null),
		[`${SPEC}/dba-2`]: folder(`${SPEC}/dba-2`, [child(`${SPEC}/dba-2/cases`, true, 2)], null),
		[`${SPEC}/dba-2/archive`]: folder(`${SPEC}/dba-2/archive`, [], null),
	};
	const notes: Record<string, string> = {
		[`${NOTEBOOKS}/sre-1.md`]: "SRE notebook text",
		[`${NOTEBOOKS}/ret-3.md`]: "Retired notebook",
	};
	const sent: URL[] = [];
	const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
		const url = new URL(input, "http://pi.test");
		const path = url.pathname.replace(/^.*\/api\/openviking/, "");
		const key = `${init.method ?? "GET"} ${path}`;
		sent.push(url);
		const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
		const missing = () => answer(404, { error: { code: "NOT_FOUND", message: "not found" } });
		const uri = url.searchParams.get("uri") ?? "";
		switch (key) {
			case "GET /overview":
				return answer(200, {
					health_state: "healthy",
					observer: { checked_at: AT, last_commit_at: AT, last_reachable_at: AT },
				});
			case "GET /tree/roots":
				return answer(200, ROOTS);
			case "GET /audit":
				return answer(200, {
					panel_updated_at: AT,
					health_state: "healthy",
					stale_badge: null,
					events: [],
					owner_events: "included",
				});
			case "GET /owner/passkeys":
				return answer(200, { rp_id: "pi.test", passkeys: [] });
			case "GET /tree":
				return uri in trees ? answer(200, trees[uri]) : missing();
			case "GET /note": {
				if (!(uri in notes)) return missing();
				return answer(200, {
					uri,
					root: ARCH,
					kind: "other",
					principal: `architecture/${uri.slice(NOTEBOOKS.length + 1, -3)}`,
					is_folder: false,
					size: 40,
					mod_time: AT,
					level: url.searchParams.get("level"),
					text: notes[uri],
					text_reason: null,
					text_of: uri,
					last_write: null,
				});
			}
			case "POST /search":
				return answer(200, {
					mode: "meaning",
					query: "deploy",
					checked_at: AT,
					total: 2,
					truncated: false,
					results_partial: false,
					unread_count: 0,
					unread_roots: [],
					locked_hidden_count: 0,
					hits: [hit(SRE_NOTE, ARCH, "architecture/sre-1"), hit(`${ARCH}/cases/c1.md`, ARCH, "architecture")],
				});
		}
		return missing();
	});
	/** The `?uri=` of every tree and note read the page sent. */
	const askedUris = () =>
		sent.filter((u) => /\/(tree|note)$/.test(u.pathname)).map((u) => u.searchParams.get("uri") ?? "");
	return { fetch, sent, askedUris, served: new Set([...Object.keys(trees), ...Object.keys(notes)]) };
}

const webauthn: OwnerWebAuthn = {
	register: vi.fn(async () => ({ id: "n" })),
	authenticate: vi.fn(async () => ({ id: "c" })),
};

let mounted: { container: HTMLElement; root: Root } | null = null;
afterEach(() => {
	if (mounted) {
		const { root: r, container } = mounted;
		act(() => r.unmount());
		container.remove();
	}
	mounted = null;
	sessionStorage.clear();
});

async function mountPage(server: ReturnType<typeof fakeServer>): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const r = createRoot(container);
	mounted = { container, root: r };
	await act(async () => r.render(createElement(MemoryExplorerPage, { active: true, fetch: server.fetch, webauthn })));
	await flush();
	return container;
}

const tree = (page: HTMLElement) => oneByRole(page, "navigation", "Where memory keeps things");
/** The `<li>` of a tree row whose toggle is named `Open|Close <name>`. */
const rowOf = (page: HTMLElement, name: string | RegExp) => {
	const toggle = byRole(tree(page), "button").find((b) => {
		const label = b.getAttribute("aria-label") ?? "";
		return typeof name === "string" ? label === `Open ${name}` || label === `Close ${name}` : name.test(label);
	});
	return (toggle?.closest("li") ?? null) as HTMLElement | null;
};
async function expand(page: HTMLElement, name: string | RegExp): Promise<HTMLElement> {
	const row = rowOf(page, name);
	if (!row) throw new Error(`no tree row ${String(name)}`);
	const toggle = byRole(row, "button").find((b) => /^Open /.test(b.getAttribute("aria-label") ?? ""));
	if (toggle) await click(toggle);
	await flush();
	return rowOf(page, name) as HTMLElement;
}
/** A slug's child (Notebook, Memories, Archive), by its visible name. */
const placeIn = (slug: HTMLElement, name: string) =>
	byRole(slug, "button").find((b) => text(b).startsWith(name)) ?? null;

describe("tree: a department's Specialists node (§5l.15)", () => {
	notBuilt(
		"M-106 page: Specialists node under the department, slugs in order, each with Notebook, Memories, Archive",
		async () => {
			const page = await mountPage(fakeServer());
			const arch = await expand(page, "Architecture");
			const node = await expand(page, "Specialists");
			expect(arch.contains(node)).toBe(true);
			// The raw `specialists` folder is not listed a second time beside the node.
			expect(byRole(arch, "button").filter((b) => b.getAttribute("data-folder") === SPEC)).toHaveLength(0);
			const slugs = ["dba-2", "ret-3", "sre-1"].map((s) => rowOf(page, s));
			expect(slugs.every((s) => s !== null && node.contains(s))).toBe(true);
			for (const slug of ["dba-2", "ret-3", "sre-1"]) {
				const row = await expand(page, slug);
				for (const place of ["Notebook", "Memories", "Archive"])
					expect(placeIn(row, place), `${slug} ${place}`).toBeTruthy();
			}
		},
	);

	// Holds today (no node is drawn yet); live now so Task 2 keeps it.
	it("M-107 page: no slug -> no Specialists node anywhere in that department", async () => {
		const page = await mountPage(fakeServer({ node: null }));
		const arch = await expand(page, "Architecture");
		const ops = await expand(page, "Ops");
		expect(text(arch)).not.toMatch(/Specialists/);
		expect(text(ops)).not.toMatch(/Specialists/);
		expect(rowOf(page, "Specialists")).toBeNull();
	});

	notBuilt(
		"M-108 page: labels `retired` and `no config` show as text; the active slug has none; none is hidden",
		async () => {
			const page = await mountPage(fakeServer());
			await expand(page, "Architecture");
			await expand(page, "Specialists");
			const own = (slug: string) => text((rowOf(page, slug) as HTMLElement).querySelector("[data-tree-row]"));
			expect(own("ret-3")).toContain("retired");
			expect(own("dba-2")).toContain("no config");
			expect(own("sre-1")).not.toMatch(/retired|no config/);
		},
	);

	notBuilt(
		"one-sided slug: the missing place is shown empty, never hidden; a slug with 0 notes says `no notes yet`",
		async () => {
			const page = await mountPage(fakeServer());
			await expand(page, "Architecture");
			await expand(page, "Specialists");
			const dba = await expand(page, "dba-2");
			expect(placeIn(dba, "Notebook")).toBeTruthy();
			expect(text(dba)).toMatch(/empty/i);
			const ret = await expand(page, "ret-3");
			expect(text(ret.querySelector("[data-tree-row]"))).toContain("no notes yet");
		},
	);

	notBuilt("read error: the node is kept, its count says `not counted`, never 0 (§5l.17)", async () => {
		const page = await mountPage(fakeServer({ node: UNREAD_NODE }));
		await expand(page, "Architecture");
		const node = rowOf(page, "Specialists");
		expect(node).not.toBeNull();
		const own = text((node as HTMLElement).querySelector("[data-tree-row]"));
		expect(own).toContain("not counted");
		expect(own).not.toMatch(/\b0\b/);
	});

	notBuilt(
		"SP5: an untrusted child name renders as text, never markup; it is listed (kind other), not hidden",
		async () => {
			const page = await mountPage(fakeServer());
			await expand(page, "Architecture");
			await expand(page, "Specialists");
			expect(text(tree(page))).toContain(HOSTILE);
			expect(page.querySelector("img")).toBeNull();
			expect((window as { __pwned?: number }).__pwned).toBeUndefined();
		},
	);
});

describe("links: only the canonical ?uri= the server sent (§5l.15, SP5)", () => {
	notBuilt("Notebook, Memories and Archive read exactly the server's uris; no uri is built from a slug", async () => {
		const server = fakeServer();
		const page = await mountPage(server);
		await expand(page, "Architecture");
		await expand(page, "Specialists");
		const sre = await expand(page, "sre-1");
		await click(placeIn(sre, "Notebook") as HTMLElement);
		await flush();
		expect(text(page)).toContain("SRE notebook text");
		expect(server.askedUris()).toContain(`${NOTEBOOKS}/sre-1.md`);
		await click(placeIn(rowOf(page, "sre-1") as HTMLElement, "Memories") as HTMLElement);
		await flush();
		expect(server.askedUris()).toContain(SRE);
		await click(placeIn(rowOf(page, "sre-1") as HTMLElement, "Archive") as HTMLElement);
		await flush();
		expect(server.askedUris()).toContain(`${SRE}/archive`);
		// Every read named a uri the server listed (or a root): nothing made up from slug, role or principal text.
		const known = new Set([...server.served, ...ROOTS.roots.map((r) => r.uri)]);
		expect(server.askedUris().filter((u) => !known.has(u))).toEqual([]);
		// The query carries the uri alone: no slug, role or principal parameter.
		for (const u of server.sent)
			for (const k of u.searchParams.keys()) expect(["uri", "level", "offset", "limit"]).toContain(k);
	});
});

describe("search: each hit shows its principal from the server (§5l.16)", () => {
	notBuilt("a hit under a specialist shows `architecture/sre-1`; a department hit shows `architecture`", async () => {
		const page = await mountPage(fakeServer());
		const find = oneByRole(page, "region", "Search memory");
		await typeInto(oneByRole(find, "searchbox") as HTMLInputElement, "deploy");
		await click(oneByRole(find, "button", "Search"));
		await flush();
		const hitRow = (uri: string) =>
			byRole(page, "button").find((b) => b.getAttribute("data-note") === uri) as HTMLElement;
		expect(text(hitRow(SRE_NOTE))).toContain("architecture/sre-1");
		expect(text(hitRow(`${ARCH}/cases/c1.md`))).toContain("architecture");
		expect(text(hitRow(`${ARCH}/cases/c1.md`))).not.toContain("architecture/");
		// No specialist-only search scope is added.
		const scopes = byRole(find, "option").map((o) => text(o));
		expect(scopes.some((s) => /specialist|sre-1/i.test(s))).toBe(false);
	});
});

/** The frozen parts' markup (rule 38): equal with and without a Specialists node, and pinned to today's build. */
async function frozenMarkup(server: ReturnType<typeof fakeServer>) {
	const page = await mountPage(server);
	await expand(page, "Architecture");
	const groups = byRole(tree(page), "region").filter((s) => !/department/i.test(accessibleOf(s)));
	const parts = {
		health: oneByRole(page, "status").outerHTML,
		find: oneByRole(page, "region", "Search memory").outerHTML,
		otherGroups: groups.map((g) => g.outerHTML).join("\n"),
		departmentRootRow: ((rowOf(page, "Architecture") as HTMLElement).querySelector("[data-tree-row]") as HTMLElement)
			.outerHTML,
	};
	act(() => (mounted as { root: Root }).root.unmount());
	(mounted as { container: HTMLElement }).container.remove();
	mounted = null;
	return parts;
}
function accessibleOf(section: HTMLElement): string {
	const id = section.getAttribute("aria-labelledby");
	return id ? text(section.ownerDocument.getElementById(id)) : "";
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const FROZEN_SHA = {
	departmentRootRow: "c35e5f4e699d5c76",
	find: "b9f22bc0964f5742",
	health: "0aca8a8509fa4a67",
	otherGroups: "f1f8b21c8b3f0e4f",
};

describe("frozen components stay unchanged (rule 38, §5l.15 Changed/Frozen)", () => {
	it("health line, search box, the other groups and the department root's own row: same markup with or without specialists, pinned", async () => {
		// Only Date is faked: the health line reads the clock ("min ago") and the local zone, and promises must still run.
		const zone = process.env.TZ;
		process.env.TZ = "UTC";
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.parse(AT) + 4 * 60_000);
		try {
			const withNode = await frozenMarkup(fakeServer());
			const without = await frozenMarkup(fakeServer({ node: null }));
			expect(withNode).toEqual(without);
			// Today's markup (frontend #364, before Task 2). A change here is drift on a Frozen part: rule 38 needs the
			// owner's approval of that redesign, not a new hash.
			expect(Object.fromEntries(Object.entries(withNode).map(([k, v]) => [k, sha(v)]))).toEqual(FROZEN_SHA);
		} finally {
			vi.useRealTimers();
			if (zone === undefined) delete process.env.TZ;
			else process.env.TZ = zone;
		}
	});
});
