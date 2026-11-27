// @vitest-environment jsdom
/**
 * Memory Explorer, the leaf link (v2 §5l.17 + §5l clarification, Frontend #365): `/?view=openviking&uri=<canonical
 * leaf>` opens that note on first load and reload, with Architecture -> Specialists -> slug already open, no tap.
 * The real page (MemoryExplorerPage) runs against the real explorer routes (explorerHarness over the daemon fake), so
 * the server's uri check stays the authority: an alias, traversal, outside or malformed uri is refused there and the
 * page shows its normal error, never another note. A late answer for the linked note never replaces where the owner
 * went next. M-113 (setup-file lock under a specialist root) is proved here through the page as well.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryExplorerPage } from "../../web/src/components/MemoryExplorerPage.js";
import type { OwnerWebAuthn } from "../../web/src/memory-explorer/owner-session.js";
import { memoryCase } from "../lib/department-specialists-memory-cases.js";
import { byRole, click, flush, oneByRole, text } from "./memory-explorer/explorer-dom.js";
import { type ExplorerHarness, explorerHarness } from "./openviking-explorer-harness.js";

const ARCH = "viking://user/architecture/memories";
const SPEC = `${ARCH}/specialists`;
const NOTEBOOKS = `${ARCH}/notebook/specialists`;
const SRE_MEMORY = `${SPEC}/sre-1/gotcha/deploy/m-1.md`;
const SRE_ARCHIVE = `${SPEC}/sre-1/archive/2026-11-12-run.md`;
const DBA_MEMORY = `${SPEC}/dba-2/gotcha/deploy/m-1.md`;
/** nb-3 has a notebook and nothing under specialists/. */
const NB_ONLY = `${NOTEBOOKS}/nb-3.md`;

// Labels read through the pi-identity the host installs: install this machine's checkout for this file.
const sharedAgentDir = process.env.PI_CODING_AGENT_DIR;
beforeAll(() => {
	const agentDir = mkdtempSync(join(tmpdir(), "ov-agent-"));
	const peer = process.env.PI_IDENTITY_PEER ?? "/home/shinelay/projects/pi-identity";
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [peer] }));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterAll(() => {
	if (sharedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = sharedAgentDir;
});

const webauthn: OwnerWebAuthn = {
	register: vi.fn(async () => ({ id: "n" })),
	authenticate: vi.fn(async () => ({ id: "c" })),
};

interface Served {
	x: ExplorerHarness;
	fetch(input: string, init?: RequestInit): Promise<Response>;
	/** The `uri` of every note read the page sent, as the server received it (decoded once by URLSearchParams). */
	noteUris(): string[];
	/** Hold note reads (default) or a tree listing until the returned release is called. */
	hold(uri: string, kind?: "note" | "tree"): () => void;
}

const harnesses: ExplorerHarness[] = [];
async function served(): Promise<Served> {
	const x = await explorerHarness();
	harnesses.push(x);
	x.fake.store.put(SRE_MEMORY, "SRE memory text\n");
	x.fake.store.put(SRE_ARCHIVE, "SRE archive text\n");
	x.fake.store.put(`${NOTEBOOKS}/sre-1.md`, "SRE notebook text\n");
	x.fake.store.put(DBA_MEMORY, "DBA memory text\n");
	x.fake.store.put(NB_ONLY, "NB notebook text\n");
	const sent: URL[] = [];
	const held = new Map<string, Promise<void>>();
	return {
		x,
		async fetch(input, init) {
			const url = new URL(input, x.base);
			sent.push(url);
			const kind = url.pathname.endsWith("/note") ? "note" : url.pathname.endsWith("/tree") ? "tree" : null;
			const wait = kind ? held.get(`${kind}:${url.searchParams.get("uri") ?? ""}`) : undefined;
			const res = await fetch(url, init);
			if (wait) await wait;
			return res;
		},
		noteUris: () => sent.filter((u) => u.pathname.endsWith("/note")).map((u) => u.searchParams.get("uri") ?? ""),
		hold(uri, kind = "note") {
			let release = () => {};
			held.set(`${kind}:${uri}`, new Promise<void>((r) => (release = r)));
			return () => release();
		},
	};
}

let mounted: { container: HTMLElement; root: Root } | null = null;
function unmount(): void {
	if (!mounted) return;
	const { root, container } = mounted;
	act(() => root.unmount());
	container.remove();
	mounted = null;
}
afterEach(async () => {
	unmount();
	sessionStorage.clear();
	window.history.replaceState(null, "", "/");
	await Promise.all(harnesses.splice(0).map((x) => x.close()));
});

/** Loads the page as a browser opening `/?view=openviking&uri=<raw>` (raw: the query value as typed in the link). */
async function openLink(server: Served, raw: string): Promise<HTMLElement> {
	window.history.replaceState(null, "", `/?view=openviking&uri=${raw}`);
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () =>
		root.render(createElement(MemoryExplorerPage, { active: true, fetch: server.fetch, webauthn })),
	);
	await settled();
	return container;
}
const link = (uri: string) => encodeURIComponent(uri);
/** Real HTTP answers arrive between act() turns: flush until the page stops asking. */
async function settled(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await flush();
		await act(() => new Promise((r) => setTimeout(r, 15)));
	}
}

const tree = (page: HTMLElement) => oneByRole(page, "navigation", "Where memory keeps things");
const reader = (page: HTMLElement) => oneByRole(page, "region", "What you're looking at");
/** The tree's toggle for a row, by the name it reads (`Open <name>` / `Close <name>`), or null. */
const toggleOf = (page: HTMLElement, name: string) =>
	byRole(tree(page), "button").find(
		(b) =>
			/^(Open|Close) /.test(b.getAttribute("aria-label") ?? "") &&
			b.getAttribute("aria-label")?.slice(6).trim() === name,
	) ?? null;
const isOpen = (page: HTMLElement, name: string) => toggleOf(page, name)?.getAttribute("aria-expanded") === "true";
const current = (page: HTMLElement) =>
	[...tree(page).querySelectorAll('[data-tree-row][aria-current="true"]')].map((r) => text(r));

describe("leaf link: opens the note with its place in the tree open (§5l.17)", () => {
	it("a memory leaf: the note reads, Architecture -> Specialists -> sre-1 open with no tap; reload does it again", async () => {
		const server = await served();
		let page = await openLink(server, link(SRE_MEMORY));
		expect(text(reader(page))).toContain("SRE memory text");
		for (const row of ["Architecture", "Specialists", "sre-1"]) expect(isOpen(page, row), row).toBe(true);
		expect(isOpen(page, "dba-2")).toBe(false);
		expect(server.noteUris()).toContain(SRE_MEMORY);

		unmount();
		page = await openLink(server, link(SRE_MEMORY));
		expect(text(reader(page))).toContain("SRE memory text");
		for (const row of ["Architecture", "Specialists", "sre-1"]) expect(isOpen(page, row), row).toBe(true);
	});

	it("each leaf kind: notebook (marked current), archive, and a notebook-only slug", async () => {
		const server = await served();
		let page = await openLink(server, link(`${NOTEBOOKS}/sre-1.md`));
		expect(text(reader(page))).toContain("SRE notebook text");
		for (const row of ["Architecture", "Specialists", "sre-1"]) expect(isOpen(page, row), row).toBe(true);
		expect(current(page)).toEqual(["Notebook"]);

		unmount();
		page = await openLink(server, link(SRE_ARCHIVE));
		expect(text(reader(page))).toContain("SRE archive text");
		for (const row of ["Architecture", "Specialists", "sre-1"]) expect(isOpen(page, row), row).toBe(true);

		unmount();
		page = await openLink(server, link(NB_ONLY));
		expect(text(reader(page))).toContain("NB notebook text");
		for (const row of ["Architecture", "Specialists", "nb-3"]) expect(isOpen(page, row), row).toBe(true);
		expect(isOpen(page, "sre-1")).toBe(false);
	});

	it("the query is decoded once: an escaped `%2e%2e` stays literal text and is never read as `..`", async () => {
		const server = await served();
		const literal = `${SPEC}/sre-1/%2e%2e/m-1.md`;
		const page = await openLink(server, link(literal));
		expect(server.noteUris()).toContain(literal);
		expect(server.noteUris().every((u) => !u.split("/").includes(".."))).toBe(true);
		expect(text(reader(page))).toMatch(/isn't in memory any more|Couldn't open this note/);
	});
});

describe("leaf link: refusals and missing notes keep the normal states (the server decides)", () => {
	it("a missing leaf: `This note isn't in memory any more`, its ancestry still open, no other note shown", async () => {
		const server = await served();
		const page = await openLink(server, link(`${SPEC}/sre-1/gotcha/deploy/gone.md`));
		expect(text(reader(page))).toContain("This note isn't in memory any more");
		for (const row of ["Architecture", "Specialists", "sre-1"]) expect(isOpen(page, row), row).toBe(true);
		expect(text(reader(page))).not.toMatch(/SRE (memory|archive|notebook) text/);
	});

	it("M-113 page: a setup file under a specialist root is refused by the server; the page shows its setup-file state", async () => {
		const c = memoryCase("M-113");
		const uri = c.input.uri as string;
		const server = await served();
		server.x.fake.store.put(uri, "who I am\n");
		const page = await openLink(server, link(uri));
		expect(server.noteUris()).toContain(uri);
		const r = await server.x.call("GET", `/api/openviking/note?uri=${link(uri)}&level=full`);
		expect({ status: r.status, code: r.body.error.code }).toEqual({ status: 403, code: c.expect.code });
		// The reader's existing setup-file state (frozen), never the file's text.
		expect(text(reader(page))).toContain(
			"It is managed with the department's settings, so it isn't shown or changed here.",
		);
		expect(text(reader(page))).not.toContain("who I am");
		for (const row of ["Architecture", "Specialists", "sre-1"]) expect(isOpen(page, row), row).toBe(true);
	});

	it("a traversal or an unknown department: the server refuses it and the page shows its error", async () => {
		const cases: Array<[uri: string, code: string]> = [
			[`${SPEC}/sre-1/../../../../ops/memories/x.md`, "URI_INVALID"],
			["viking://user/nobody/memories/x.md", "URI_OUTSIDE_ROOTS"],
		];
		for (const [uri, code] of cases) {
			const server = await served();
			server.x.fake.store.put("viking://user/ops/memories/x.md", "OPS secret\n");
			const page = await openLink(server, link(uri));
			expect(server.noteUris(), uri).toContain(uri);
			const r = await server.x.call("GET", `/api/openviking/note?uri=${link(uri)}&level=full`);
			expect(r.body.error.code, uri).toBe(code);
			expect(text(reader(page)), uri).toContain("Couldn't open this note");
			expect(text(page), uri).not.toMatch(/OPS secret|SRE (memory|archive|notebook) text/);
			unmount();
		}
	});

	it("an alias, an outside place, another site or a malformed escape: the start opens, no note is read; the server refuses them too", async () => {
		const cases: Array<[raw: string, code: string | null]> = [
			[link(memoryCase("M-112").input.uri as string), "URI_OUTSIDE_ROOTS"],
			[link("viking://user/memories/gotcha/x.md"), "URI_OUTSIDE_ROOTS"],
			[link("https://example.com/x.md"), "URI_INVALID"],
			["%E0%A4%A", null],
		];
		for (const [raw, code] of cases) {
			const server = await served();
			const page = await openLink(server, raw);
			const asked = new URLSearchParams(`uri=${raw}`).get("uri") ?? "";
			// Only the start's own reads (the shared place's overview): the link's uri is never asked for.
			expect(server.noteUris(), raw).not.toContain(asked);
			expect(
				server.noteUris().every((u) => u === "viking://user/default/memories"),
				raw,
			).toBe(true);
			expect(text(reader(page)), raw).toContain("Changed most recently");
			expect(isOpen(page, "Specialists"), raw).toBe(false);
			if (code) {
				const r = await server.x.call("GET", `/api/openviking/note?uri=${link(asked)}&level=full`);
				expect(r.body.error.code, raw).toBe(code);
			}
			unmount();
		}
	});

	it("a read error (memory fails the read): the error state with Try again, the tree kept", async () => {
		const server = await served();
		const failing: Served = {
			...server,
			fetch: (input, init) =>
				new URL(input, server.x.base).pathname.endsWith("/note")
					? Promise.resolve(
							new Response(JSON.stringify({ error: { code: "MEMORY_ERROR", message: "boom" } }), {
								status: 502,
								headers: { "Content-Type": "application/json" },
							}),
						)
					: server.fetch(input, init),
		};
		const page = await openLink(failing, link(SRE_MEMORY));
		expect(text(reader(page))).toContain("Couldn't open this note");
		expect(byRole(reader(page), "button", "Try again")).toHaveLength(1);
		for (const row of ["Architecture", "Specialists", "sre-1"]) expect(isOpen(page, row), row).toBe(true);
	});
});

describe("leaf link: a late answer never wins (§5l clarification)", () => {
	it("the owner opens another note while the linked one is still loading: the late answer is dropped", async () => {
		const server = await served();
		const release = server.hold(SRE_MEMORY);
		const releaseTree = server.hold(ARCH, "tree");
		try {
			const page = await openLink(server, link(SRE_MEMORY));
			expect(text(reader(page))).not.toContain("SRE memory text");
			// The note reader exists before its separately fetched navigation. Force the ordering from the failed gate.
			expect(toggleOf(page, "sre-1")).toBeNull();
			releaseTree();
			// Await the actual navigation target, not openLink's fixed pause. The normal hang guard stays unchanged.
			const nb = await vi.waitFor(async () => {
				await flush();
				const sre = toggleOf(page, "sre-1")?.closest("li");
				if (!sre) throw new Error("sre-1 navigation is still loading");
				const notebook = byRole(sre, "button").find((b) => text(b) === "Notebook");
				if (!notebook) throw new Error("Notebook navigation is still loading");
				expect(notebook.hasAttribute("disabled")).toBe(false);
				return notebook;
			});
			await click(nb);
			await vi.waitFor(async () => {
				await flush();
				expect(text(reader(page))).toContain("SRE notebook text");
			});
			release();
			await settled();
			expect(text(reader(page))).toContain("SRE notebook text");
			expect(text(reader(page))).not.toContain("SRE memory text");
		} finally {
			releaseTree();
			release();
		}
	});

	it("leaving the tab takes the link off the address, so a later visit opens the start, not the old note", async () => {
		const server = await served();
		await openLink(server, link(SRE_MEMORY));
		const { root } = mounted as { root: Root };
		await act(async () =>
			root.render(createElement(MemoryExplorerPage, { active: false, fetch: server.fetch, webauthn })),
		);
		const url = new URL(window.location.href);
		expect(url.searchParams.get("uri")).toBeNull();
		expect(url.searchParams.get("view")).toBeNull();
	});
});
