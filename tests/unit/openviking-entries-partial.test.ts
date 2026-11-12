/**
 * Backend #151 (blind verify #150 row 39): one piece of a listing the daemon will not give may never say the
 * store is unreachable, and may never leave the list silently short.
 *
 * Row 39: `GET /api/openviking/entries` answered `health_state: "server-unreachable"` with `entries: []` in 11
 * of 30 live loads while `:1933` answered `/health` in 1.0-6.3 ms before each of them — one of ~1700 reads of
 * one listing missed both its deadlines, and the whole panel was thrown away with it. Two further loads
 * returned 1398 and 1662 rows against 1715 around them, badged `healthy`: a short list nobody could see.
 *
 * The rule is the one the overview already obeys (spec-states.md §4, Backend #147): `/health` alone decides
 * reachability. Below that gate a read that does not answer leaves its own piece unread — the row still comes
 * back with that piece null — and the listing says so with `entries_partial` + `unread_count`.
 *
 * (e) is the same principle one field over (row 3 tail): `auxiliary.resource_sync.pending_syncs_count` was `0`
 * while `status` was `"missing"` — a count for a file that was never read.
 *
 * Backend #153 keeps every row of that rule and conforms its arithmetic to spec `2500874d` §3a, which landed
 * after this suite: both fields are on every answer, and `unread_count` counts **read units** (all-or-nothing
 * listing reads), so a stalled L0 abstract nulls its row's field without making the list short. The cases are
 * unchanged; what each one must observe is the spec's. Case (e)'s source file is `rollout-state.json`, the only
 * file a `wt land` sync ever writes — `resource-sync-state.json` never existed and its reader is deleted.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createOpenVikingClient,
	ISOLATED_AGENT_MEMORY_ABSTRACT,
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
		taskId: "backend#151",
		uri: "viking://session/151",
		action: "session_commit",
		summary: "task #151 commit",
	},
];

/** The shared row whose L0 is not in the listing: its abstract is one `/api/v1/content/abstract` read. */
const SHARED_URI = "viking://user/default/memories/preferences/backend_code.md";
/** The response shape, in order: both declaring fields are always there, whatever happened below (§3a). */
const COMPLETE_KEYS = ["panel_updated_at", "health_state", "stale_badge", "entries_partial", "unread_count", "entries"];
/** 1 repo tree + 1 shared memory + one file per role, as the fake daemon serves them. */
const ALL_ROWS = 2 + OPENVIKING_ROLES.length;

/** Every assertion row 39 breaks: a listing under an answering `/health` is readable, never empty, never down. */
function expectReadableListing(res: OpenVikingEntriesResponse): void {
	expect(res.health_state).not.toBe("server-unreachable");
	expect(res.entries.length).toBeGreaterThan(0);
}

/** (f) The one invariant: a list shorter than a complete one says so, in the response itself. */
function expectShortListSaysSo(res: OpenVikingEntriesResponse, completeRows: number): void {
	// §3a: a short list is one with rows missing. A row that shipped with a null field is not one.
	if (res.entries.length < completeRows) {
		expect(res.entries_partial).toBe(true);
		expect(res.unread_count).toBeGreaterThan(0);
	}
	expect(res.entries_partial).toBe(res.unread_count > 0);
}

describe("a piece of a listing the daemon will not give (Backend #151)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const stateDir = (files: Record<string, object> = {}) => {
		const dir = mkdtempSync(join(tmpdir(), "ov-entries-partial-"));
		dirs.push(dir);
		writeFileSync(join(dir, "metrics.jsonl"), jsonl(METRICS));
		writeFileSync(join(dir, "memory-changelog.jsonl"), jsonl(CHANGELOG));
		for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(value));
		return dir;
	};
	/** One client = one server process, with its own transport and a pinned clock. */
	const setup = (files: Record<string, object> = {}) => {
		const fake = daemon("up");
		const client = createOpenVikingClient({
			stateDir: stateDir(files),
			fetchImpl: fake.fetchImpl,
			timeoutMs: 50,
			now: () => NOW,
		});
		return { fake, client };
	};

	// (a) row 39's own case: one L0 abstract read stalls past both attempts while /health and every listing answer.
	it("returns every readable row, flagged, when one abstract read is past both deadlines", async () => {
		const { fake, client } = setup();
		fake.state.hangContentMatching = "backend_code.md";

		const res = await client.getEntries({ scope: "all" });

		// The defect: server-unreachable with 0 rows while /health answered in milliseconds.
		expectReadableListing(res);
		expect(res.health_state).toBe("healthy");
		expect(res.stale_badge).toBeNull();
		expect(res.entries).toHaveLength(ALL_ROWS);
		// The row whose piece was not read is returned with that piece unmeasured, never dropped.
		const shared = res.entries.find((e) => e.canonical_uri === SHARED_URI);
		expect(shared).toBeDefined();
		expect(shared?.l0_abstract).toBeNull();
		// ...and no row is missing, so the list is not short: the stalled read was inside a row that shipped (§3a).
		expect(res.entries_partial).toBe(false);
		expect(res.unread_count).toBe(0);
		// Every other row is whole: the stalled read cost its own abstract and nothing else.
		expect(res.entries.find((e) => e.scope === "resources")?.l0_abstract).toBe("pi-web-ui L0 abstract");
		expect(res.entries.filter((e) => e.scope === "agent")).toHaveLength(OPENVIKING_ROLES.length);
		for (const e of res.entries.filter((e) => e.scope === "agent")) {
			expect(e.l0_abstract).toBe(ISOLATED_AGENT_MEMORY_ABSTRACT);
		}
	});

	// (a2) the same read rejected (503) instead of stalled: one answer, one rule.
	it("returns every readable row, flagged, when one abstract read is refused", async () => {
		const { fake, client } = setup();
		fake.state.errorContentMatching = "backend_code.md";

		const res = await client.getEntries({ scope: "all" });

		expectReadableListing(res);
		expect(res.entries).toHaveLength(ALL_ROWS);
		expect(res.entries.find((e) => e.canonical_uri === SHARED_URI)?.l0_abstract).toBeNull();
		expect(res.entries_partial).toBe(false);
		expect(res.unread_count).toBe(0);
	});

	// (b) one listing failing: the other scopes still come back, and the short scope is declared.
	it("keeps the other scopes when one role's listing fails, and says the list is short", async () => {
		const { fake, client } = setup();
		fake.state.errorLsRoles = ["qa"];

		const res = await client.getEntries({ scope: "all" });

		expectReadableListing(res);
		expect(res.health_state).toBe("healthy");
		expect(res.entries).toHaveLength(ALL_ROWS - 1);
		expect(res.entries.some((e) => e.role === "qa")).toBe(false);
		expect(res.entries.filter((e) => e.scope === "agent")).toHaveLength(OPENVIKING_ROLES.length - 1);
		expect(res.entries_partial).toBe(true);
		expect(res.unread_count).toBe(1);
	});

	// (b2) a listing below a shared root: the rows above it stay, the rows below it are declared missing.
	it("keeps the rows a failed shared sub-listing does not hide, and says the list is short", async () => {
		const { fake, client } = setup();
		fake.state.errorLsMatching = "/default/memories/preferences";

		const res = await client.getEntries({ scope: "all" });

		expectReadableListing(res);
		expect(res.entries.some((e) => e.canonical_uri === SHARED_URI)).toBe(false);
		expect(res.entries).toHaveLength(ALL_ROWS - 1);
		expect(res.entries.find((e) => e.scope === "resources")).toBeDefined();
		expect(res.entries.filter((e) => e.scope === "agent")).toHaveLength(OPENVIKING_ROLES.length);
		expect(res.entries_partial).toBe(true);
		expect(res.unread_count).toBe(1);
	});

	// (c) R-FAIL is untouched: only /health decides that the store is unreachable.
	it("keeps R-FAIL when /health fails: unreachable with no entries", async () => {
		for (const mode of ["down", "hang", "unhealthy"] as const) {
			const fake = daemon(mode);
			const client = createOpenVikingClient({
				stateDir: stateDir(),
				fetchImpl: fake.fetchImpl,
				timeoutMs: 50,
				now: () => NOW,
			});

			const res = await client.getEntries({ scope: "all" });

			expect(res).toMatchObject({ health_state: "server-unreachable", stale_badge: null, entries: [] });
			expect(Object.keys(res)).toEqual(COMPLETE_KEYS);
			// Not one read unit of the scope answered, and the answer says exactly that (§3a).
			expect(res.entries_partial).toBe(true);
			expect(res.unread_count).toBe(2 + OPENVIKING_ROLES.length);
		}
	});

	// (d) a listing that read everything says so: both fields present, flag false, count 0.
	it("declares a complete listing complete: entries_partial false, unread_count 0, same keys", async () => {
		const { client } = setup();

		const res = await client.getEntries({ scope: "all" });

		expect(res.health_state).toBe("healthy");
		expect(res.entries).toHaveLength(ALL_ROWS);
		expect(Object.keys(res)).toEqual(COMPLETE_KEYS);
		expect(res.entries_partial).toBe(false);
		expect(res.unread_count).toBe(0);
		expect(res.entries.every((e) => e.l0_abstract !== null)).toBe(true);
	});

	// (e) row 3 tail: a count for a file that was never read is no count at all.
	it("reports pending_syncs_count null while rollout-state.json is absent, and a figure once it is there", async () => {
		const { client } = setup();

		const missing = (await client.getOverview()).auxiliary.resource_sync;

		expect(missing.status).toBe("missing");
		expect(missing.pending_syncs_count).toBeNull();
		expect(missing.synced_at).toBeNull();
		expect(missing.repos_synced).toBeNull();

		const present = setup({
			"rollout-state.json": {
				stage: "phase2-live",
				updated_at: minutesAgo(5),
				pending_wt_land_syncs: [
					{ project: "p", repoRoot: "/tmp/p", changedPaths: ["a.md"], failedAt: minutesAgo(4), error: "boom" },
				],
			},
		});
		const read = (await present.client.getOverview()).auxiliary.resource_sync;

		expect(read.status).toBe("pending");
		expect(read.pending_syncs_count).toBe(1);
		// Nothing writes either, so neither is ever a figure (spec 2500874d G5).
		expect(read.repos_synced).toBeNull();
		expect(read.synced_at).toBeNull();
	});

	// (f) the invariant itself: over every failure this daemon can produce, a short list is impossible unflagged.
	it("never returns a short list without saying so, and never reports unreachable while /health answers", async () => {
		const cases: [string, (s: ReturnType<typeof daemon>["state"]) => void][] = [
			["one stalled abstract", (s) => (s.hangContentMatching = "backend_code.md")],
			["one refused abstract", (s) => (s.errorContentMatching = "backend_code.md")],
			["one role listing refused", (s) => (s.errorLsRoles = ["qa"])],
			["five role listings refused", (s) => (s.errorLsRoles = ["design", "docs", "marketing", "qa", "temper"])],
			["one shared sub-listing refused", (s) => (s.errorLsMatching = "/default/memories/preferences")],
			["every listing refused", (s) => (s.failAllLs = true)],
			["one stalled listing", (s) => (s.hangLsMatching = "viking://resources")],
			[
				"a stalled abstract and a refused role listing together",
				(s) => {
					s.hangContentMatching = "backend_code.md";
					s.errorLsRoles = ["ops"];
				},
			],
		];

		for (const [name, breakIt] of cases) {
			const { fake, client } = setup();
			breakIt(fake.state);

			const res = await client.getEntries({ scope: "all" });

			expect(`${name}: ${res.health_state}`).not.toContain("server-unreachable");
			expectShortListSaysSo(res, ALL_ROWS);
			// Every answer carries both fields, in the one shape (§3a).
			expect(`${name}: ${Object.keys(res).join(",")}`).toBe(`${name}: ${COMPLETE_KEYS.join(",")}`);
			// A list missing rows is flagged; a complete one is not.
			expect(`${name}: ${res.entries_partial}`).toBe(`${name}: ${res.entries.length < ALL_ROWS}`);
		}
	});
});
