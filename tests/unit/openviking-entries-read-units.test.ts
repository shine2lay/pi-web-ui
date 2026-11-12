/**
 * Backend #153 — `/api/openviking/entries` and `auxiliary.resource_sync` against spec `2500874d`
 * (`.temper/features/openviking-dashboard/spec.md` §3a and the field table).
 *
 * §3a fixes what a short list is and how it is declared, which #151 shipped differently:
 * - a **read unit** is one all-or-nothing listing read — the `resources` root, the shared
 *   `user/default/memories` walk, one per role tree in scope (`scope=all` without `role`: `2 + 15 = 17`);
 * - `unread_count` counts the units that did not answer, and `entries_partial` is exactly `unread_count > 0`;
 *   **both fields are always present**, on every answer, including `?uri=` and a failed `/health`;
 * - a root the daemon answers `NOT_FOUND` for is **absent**, not unread: `0` rows, nothing counted;
 * - a failed read *inside* a returned row is **not** a unit: it nulls that field (`l0_abstract: null`) and the
 *   row still ships, so the list is not short.
 *
 * The field table fixes `auxiliary.resource_sync` on `rollout-state.json`'s `pending_wt_land_syncs`:
 * `pending_syncs_count` = that array's length, `null` only when the file is absent or unreadable (never `0`,
 * which means "looked and none pending"), and `synced_at`/`repos_synced` stay `null` because nothing writes
 * them. `resource-sync-state.json` never existed — no writer in any repo — so its reader is deleted (Rule 23).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createOpenVikingClient,
	handleOpenVikingEntriesRequest,
	OPENVIKING_ROLES,
	type OpenVikingEntriesResponse,
} from "../../server/openviking/index.js";
import { daemon, minutesAgo, NOW } from "./openviking-daemon-fake.js";

const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const METRICS = [{ timestamp: minutesAgo(2), event: "turn_start", mode: "lead", role: "backend", l0_hit_count: 1 }];
const CHANGELOG = [
	{
		timestamp: minutesAgo(3),
		source: "queue_done",
		role: "backend",
		taskId: "backend#153",
		uri: "viking://session/153",
		action: "session_commit",
		summary: "task #153 commit",
	},
];

/** Spec §3a: the response declares these two in every answer, in this place, whatever happened below. */
const RESPONSE_KEYS = ["panel_updated_at", "health_state", "stale_badge", "entries_partial", "unread_count", "entries"];
/** `scope=all` without `role`: the `resources` root + the shared memories walk + one per role tree. */
const UNITS_ALL = 2 + OPENVIKING_ROLES.length;
/** The fake daemon's complete listing: 1 repo tree + 1 shared memory file + one file per role. */
const ALL_ROWS = 2 + OPENVIKING_ROLES.length;
const SHARED_URI = "viking://user/default/memories/preferences/backend_code.md";

/** The biconditional of §3a, asserted on every answer this suite produces. */
function expectDeclaresItsUnits(res: OpenVikingEntriesResponse, unread: number): void {
	expect(Object.keys(res)).toEqual(RESPONSE_KEYS);
	expect(res.unread_count).toBe(unread);
	expect(res.entries_partial).toBe(unread > 0);
}

describe("entries read units and resource sync state (Backend #153, spec 2500874d)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const stateDir = (files: Record<string, object | string> = {}) => {
		const dir = mkdtempSync(join(tmpdir(), "ov-read-units-"));
		dirs.push(dir);
		writeFileSync(join(dir, "metrics.jsonl"), jsonl(METRICS));
		writeFileSync(join(dir, "memory-changelog.jsonl"), jsonl(CHANGELOG));
		for (const [name, value] of Object.entries(files)) {
			writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
		}
		return dir;
	};
	const setup = (files: Record<string, object | string> = {}, mode: Parameters<typeof daemon>[0] = "up") => {
		const fake = daemon(mode);
		const client = createOpenVikingClient({
			stateDir: stateDir(files),
			fetchImpl: fake.fetchImpl,
			timeoutMs: 50,
			now: () => NOW,
		});
		return { fake, client };
	};

	// (a) Three role trees the daemon will not read: three units, and the twelve that read are all still there.
	it("(a) counts one unit per role tree that did not answer, and ships every tree that did", async () => {
		const { fake, client } = setup();
		fake.state.errorLsRoles = ["design", "ops", "qa"];

		const res = await client.getEntries({ scope: "all" });

		expect(res.health_state).toBe("healthy");
		expectDeclaresItsUnits(res, 3);
		const agentRoles = res.entries.filter((e) => e.scope === "agent").map((e) => e.role);
		expect(agentRoles.sort()).toEqual(OPENVIKING_ROLES.filter((r) => !fake.state.errorLsRoles.includes(r)).sort());
		expect(agentRoles).toHaveLength(OPENVIKING_ROLES.length - 3);
		expect(res.entries.find((e) => e.scope === "resources")).toBeDefined();
		expect(res.entries.find((e) => e.canonical_uri === SHARED_URI)).toBeDefined();
	});

	// (b) A read inside a row is not a unit: the row ships with that one field null and the list is not short.
	it("(b) nulls one field for a failed L0 abstract read without counting a unit", async () => {
		for (const breakIt of [
			(s: ReturnType<typeof daemon>["state"]) => (s.hangContentMatching = "backend_code.md"),
			(s: ReturnType<typeof daemon>["state"]) => (s.errorContentMatching = "backend_code.md"),
		]) {
			const { fake, client } = setup();
			breakIt(fake.state);

			const res = await client.getEntries({ scope: "all" });

			expect(res.health_state).toBe("healthy");
			expect(res.entries).toHaveLength(ALL_ROWS);
			expect(res.entries.find((e) => e.canonical_uri === SHARED_URI)?.l0_abstract).toBeNull();
			// No row is missing, so the list is not short: the unit answered.
			expectDeclaresItsUnits(res, 0);
		}
	});

	// (c) NOT_FOUND is the daemon answering "there is no such folder": absent, not unread.
	it("(c) reads a NOT_FOUND root as absent: no rows, no unit counted", async () => {
		const roleAbsent = setup();
		roleAbsent.fake.state.absentRoles = ["qa"];
		const withoutQa = await roleAbsent.client.getEntries({ scope: "all" });

		expect(withoutQa.health_state).toBe("healthy");
		expect(withoutQa.entries.some((e) => e.role === "qa")).toBe(false);
		expectDeclaresItsUnits(withoutQa, 0);

		const rootAbsent = setup();
		rootAbsent.fake.state.absentLsMatching = "viking://resources";
		const withoutRepos = await rootAbsent.client.getEntries({ scope: "all" });

		expect(withoutRepos.entries.some((e) => e.scope === "resources")).toBe(false);
		expectDeclaresItsUnits(withoutRepos, 0);
	});

	// (d) `?uri=` is not a listing: one entry or an HTTP error, never a partial 200.
	it("(d) answers ?uri= with entries_partial false and unread_count 0, or an HTTP error", async () => {
		const { fake, client } = setup();

		const one = await client.getEntries({ uri: SHARED_URI });
		expect(one.entries).toHaveLength(1);
		expectDeclaresItsUnits(one, 0);

		for (const [query, status] of [
			[{ uri: "viking://agent/memories/cases/c1.md", role: "qa", tier: "L1" }, 403],
			[{ uri: "viking://user/default/memories/preferences/nope.md" }, 404],
		] as const) {
			const res = await handleOpenVikingEntriesRequest(client, query, "GET");
			expect(res.status).toBe(status);
		}

		// A listing read that fails under `?uri=` is still an error, never a short 200.
		fake.state.errorLsMatching = "/default/memories/preferences";
		const failed = await handleOpenVikingEntriesRequest(client, { uri: SHARED_URI }, "GET");
		expect(failed.status).toBeGreaterThanOrEqual(400);
	});

	// (e) The biconditional over a matrix, including `/health` down: every unit in scope is unread.
	it("(e) keeps entries_partial === (unread_count > 0) over every case, /health down included", async () => {
		const cases: [string, number, (s: ReturnType<typeof daemon>["state"]) => void][] = [
			["complete listing", 0, () => {}],
			["one stalled abstract", 0, (s) => (s.hangContentMatching = "backend_code.md")],
			["one absent role", 0, (s) => (s.absentRoles = ["qa"])],
			["one role listing refused", 1, (s) => (s.errorLsRoles = ["qa"])],
			["the shared walk refused", 1, (s) => (s.errorLsMatching = "viking://user/default/memories")],
			["five role listings refused", 5, (s) => (s.errorLsRoles = ["design", "docs", "marketing", "qa", "temper"])],
			["every listing refused", UNITS_ALL, (s) => (s.failAllLs = true)],
			["the resources root stalled", 1, (s) => (s.hangLsMatching = "viking://resources")],
		];

		for (const [name, unread, breakIt] of cases) {
			const { fake, client } = setup();
			breakIt(fake.state);

			const res = await client.getEntries({ scope: "all" });

			expect(`${name}: ${res.health_state}`).not.toContain("server-unreachable");
			expect(`${name}: ${res.unread_count}`).toBe(`${name}: ${unread}`);
			expectDeclaresItsUnits(res, unread);
		}

		for (const mode of ["down", "hang", "unhealthy"] as const) {
			const { client } = setup({}, mode);
			const res = await client.getEntries({ scope: "all" });

			expect(res).toMatchObject({ health_state: "server-unreachable", stale_badge: null, entries: [] });
			// Nothing in scope was listed, so every unit of the scope is unread (§3a).
			expectDeclaresItsUnits(res, UNITS_ALL);
		}

		const narrow = setup({}, "down");
		expectDeclaresItsUnits(await narrow.client.getEntries({ scope: "agent", role: "qa" }), 1);
		expectDeclaresItsUnits(await narrow.client.getEntries({ scope: "resources" }), 1);
	});

	// (f) An all-or-nothing unit stays one unit however many of its sub-listings failed — and is never silent.
	it("(f) counts a walk with several failed sub-listings as one unit, never a silent short list", async () => {
		const shared = setup();
		shared.fake.state.extraSharedDirs = ["entities", "events"];
		// The root answers; all three folders below it do not.
		shared.fake.state.errorLsMatching = "viking://user/default/memories/";
		const sharedRes = await shared.client.getEntries({ scope: "all" });

		expect(sharedRes.health_state).toBe("healthy");
		expect(sharedRes.entries.filter((e) => e.scope === "user")).toHaveLength(0);
		expectDeclaresItsUnits(sharedRes, 1);

		const role = setup();
		role.fake.state.extraRoleDirs = ["events"];
		role.fake.state.errorLsMatching = "viking://user/qa/memories/";
		const roleRes = await role.client.getEntries({ scope: "agent", role: "qa" });

		expect(roleRes.health_state).not.toBe("server-unreachable");
		expect(roleRes.entries).toHaveLength(0);
		// `walkRoleTree` reads this tree as `unmeasured`: its rows are short, and the answer says so.
		expectDeclaresItsUnits(roleRes, 1);
	});

	// (g) `auxiliary.resource_sync` reads `rollout-state.json`'s `pending_wt_land_syncs` and nothing else.
	it("(g) counts pending_wt_land_syncs, and only an unread rollout-state.json is missing", async () => {
		const sync = (project: string) => ({
			project,
			repoRoot: `/home/shinelay/projects/${project}`,
			changedPaths: [".temper/core/map.md"],
			failedAt: minutesAgo(4),
			error: "sync deferred",
		});
		const cases: [string, Record<string, object | string>, number | null, string][] = [
			["empty list", { "rollout-state.json": { pending_wt_land_syncs: [] } }, 0, "ok"],
			[
				"two pending",
				{ "rollout-state.json": { pending_wt_land_syncs: [sync("rollcall"), sync("pi-web-ui")] } },
				2,
				"pending",
			],
			["file absent", {}, null, "missing"],
			["file unparseable", { "rollout-state.json": "{not json" }, null, "missing"],
		];

		for (const [name, files, count, status] of cases) {
			const { client } = setup(files);

			const resourceSync = (await client.getOverview()).auxiliary.resource_sync;

			expect(`${name}: ${resourceSync.pending_syncs_count}`).toBe(`${name}: ${count}`);
			expect(`${name}: ${resourceSync.status}`).toBe(`${name}: ${status}`);
			// Nothing writes a resource-sync time or a repo count, so neither is ever a figure (spec G5).
			expect(resourceSync.synced_at).toBeNull();
			expect(resourceSync.repos_synced).toBeNull();
		}
	});

	// (h) Rule 23: the reader of a file nothing ever wrote is gone, with no fallback left behind.
	it("(h) keeps no reference to resource-sync-state.json anywhere under server/", () => {
		const root = new URL("../../server/", import.meta.url).pathname;
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				if (e.isDirectory()) walk(join(dir, e.name));
				else if (e.name.endsWith(".ts")) files.push(join(dir, e.name));
			}
		};
		walk(root);

		const hits = files.filter((f) =>
			/resource-sync-state|resourceSyncState|readResourceSyncState/.test(readFileSync(f, "utf8")),
		);

		expect(hits).toEqual([]);
		expect(files.length).toBeGreaterThan(10);
	});
});
