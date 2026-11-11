/**
 * Backend #142 (#138 rows 13/20): the memory walker lists every file at any depth. The `:1933` 0.5.4 daemon's
 * `fs/ls?recursive=true` stops 3 levels below the listed folder, so dated `events/YYYY/MM/DD/*.md` files were missed;
 * this fake daemon does the same, while a plain `fs/ls` lists one level. A failed listing anywhere makes the tree fail
 * (never a partial count shown as complete).
 */
import { describe, expect, it } from "vitest";
import { OpenVikingDaemonHttp, OpenVikingDaemonRequestError } from "../../server/openviking/daemon-http.js";
import { walkMemoryTree, walkRoleTree } from "../../server/openviking/memory-tree.js";

const ROOT = "viking://user/default/memories";
const FILES = [
	"profile.md",
	"preferences/backend_code.md",
	"entities/rollcall/status.md",
	"events/2026/summary.md",
	"events/2026/11/01/e1.md",
	"events/2026/11/01/e2.md",
	"events/2026/11/02/deep/e3.md",
];
/** Like 0.5.4: a recursive listing returns descendants at most this many levels below the listed folder. */
const RECURSIVE_LEVEL_CAP = 3;

function treeDaemon(
	root: string,
	files: readonly string[],
	failUri?: string,
	failWith: { code: string; status: number } = { code: "INTERNAL", status: 500 },
) {
	const paths = new Set<string>();
	for (const f of files) {
		const parts = f.split("/");
		for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join("/"));
	}
	const isFile = (p: string) => files.includes(p);
	const below = (dir: string) => [...paths].filter((p) => dir === "" || p.startsWith(`${dir}/`));
	const levels = (dir: string, p: string) => p.split("/").length - (dir === "" ? 0 : dir.split("/").length);
	let inFlight = 0;
	const stats = { maxInFlight: 0, listings: [] as string[] };
	const fetchImpl: typeof fetch = async (input) => {
		const url = new URL(String(input));
		const uri = url.searchParams.get("uri") ?? "";
		stats.listings.push(uri);
		inFlight++;
		stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
		await new Promise((r) => setTimeout(r, 1));
		inFlight--;
		if (uri === failUri) {
			return new Response(JSON.stringify({ status: "error", error: { code: failWith.code, message: "boom" } }), {
				status: failWith.status,
			});
		}
		const dir = uri === root ? "" : uri.slice(root.length + 1);
		const cap = url.searchParams.get("recursive") === "true" ? RECURSIVE_LEVEL_CAP : 1;
		const result = below(dir)
			.filter((p) => levels(dir, p) >= 1 && levels(dir, p) <= cap)
			.map((p) => ({ uri: `${root}/${p}`, isDir: !isFile(p), size: 1, modTime: null, abstract: "" }));
		return new Response(JSON.stringify({ status: "ok", result }), { headers: { "Content-Type": "application/json" } });
	};
	return { http: new OpenVikingDaemonHttp("http://fake:1933", 2000, fetchImpl, () => 0), stats };
}

describe("walkMemoryTree reaches every depth (Backend #142)", () => {
	it("lists files at depths 1-5 with every folder listed once and no recursive listing", async () => {
		const { http, stats } = treeDaemon(ROOT, FILES);
		const files = await walkMemoryTree(http, ROOT, {});
		expect(files.map((f) => f.relPath).sort()).toEqual([...FILES].sort());
		expect(files.filter((f) => f.category === "events")).toHaveLength(4);
		expect(files.find((f) => f.relPath === "profile.md")?.category).toBe("root");
		const listed = stats.listings;
		expect(new Set(listed).size).toBe(listed.length);
		expect(listed.sort()).toEqual(
			[
				"",
				"/preferences",
				"/entities",
				"/entities/rollcall",
				"/events",
				"/events/2026",
				"/events/2026/11",
				"/events/2026/11/01",
				"/events/2026/11/02",
				"/events/2026/11/02/deep",
			]
				.map((p) => `${ROOT}${p}`)
				.sort(),
		);
	});

	it("keeps listings in flight bounded on a wide folder", async () => {
		const wide = Array.from({ length: 40 }, (_, i) => `events/2026/11/${String(i).padStart(2, "0")}/e.md`);
		const { http, stats } = treeDaemon(ROOT, wide);
		expect(await walkMemoryTree(http, ROOT, {})).toHaveLength(40);
		expect(stats.maxInFlight).toBeLessThanOrEqual(8);
	});

	it("one failed deep sub-listing fails the whole tree; the role's reading is unmeasured, not absent", async () => {
		const failing = `${ROOT}/events/2026/11/02`;
		await expect(walkMemoryTree(treeDaemon(ROOT, FILES, failing).http, ROOT, {})).rejects.toBeInstanceOf(
			OpenVikingDaemonRequestError,
		);
		const roleRoot = "viking://user/qa/memories";
		const { http } = treeDaemon(roleRoot, ["cases/a.md", "events/2026/11/01/e.md"], `${roleRoot}/events/2026/11/01`);
		// Backend #149: a listing the daemon failed is a read that did not happen, never "this role has no folder".
		// Backend #151: the rows it did read come back with the reading, for a listing that declares the shortfall.
		expect(await walkRoleTree(http, "qa")).toEqual({
			state: "unmeasured",
			files: [expect.objectContaining({ relPath: "cases/a.md", category: "cases" })],
			unreadListings: 1,
		});
	});

	it("reads a role's root NOT_FOUND as an absent folder, and a measured tree as its files (Backend #149)", async () => {
		const roleRoot = "viking://user/qa/memories";
		const present = treeDaemon(roleRoot, ["cases/a.md", "instructions/preferences.md"]);
		expect(await walkRoleTree(present.http, "qa")).toEqual({
			state: "measured",
			files: expect.arrayContaining([expect.objectContaining({ relPath: "cases/a.md", category: "cases" })]),
		});

		const absent = treeDaemon(roleRoot, ["cases/a.md"], roleRoot, { code: "NOT_FOUND", status: 404 });
		expect(await walkRoleTree(absent.http, "qa")).toEqual({ state: "absent" });

		// The same root listing, failed for any other daemon reason: unmeasured, with no row read below it.
		const busy = treeDaemon(roleRoot, ["cases/a.md"], roleRoot, { code: "UNAVAILABLE", status: 503 });
		expect(await walkRoleTree(busy.http, "qa")).toEqual({ state: "unmeasured", files: [], unreadListings: 1 });
	});
});
