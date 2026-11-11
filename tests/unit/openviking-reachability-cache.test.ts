/**
 * Backend #147 (blind verify #144 row 33): the dashboard reports the daemon down only when `/health` fails.
 *
 * Since the level-by-level walker (#142) one overview cost ~85 `:1933` GETs, and any one of them missing its
 * deadline returned the all-null UNREACHABLE snapshot: the page said `Offline` while `curl :1933/health` answered
 * in ~1 ms. Contract (spec-states.md §4): `error` = `/health` fails. So reachability is `/health`'s alone, a read
 * that fails nulls only the fields it feeds, and the store-count walk is held in this process at the observer
 * cadence (one shared refresh, never a figure older than the age bound).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createOpenVikingClient,
	MEMORY_TREE_MAX_SERVE_AGE_MS,
	OPENVIKING_ROLES,
	OVERVIEW_OBSERVER_CADENCE_MS,
	type OpenVikingOverviewResponse,
} from "../../server/openviking/index.js";
import { daemon, minutesAgo, NOW, type DaemonMode } from "./openviking-daemon-fake.js";

const iso = (ms: number) => new Date(ms).toISOString();
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
/** The fake daemon answers on microtasks; one macrotask is enough for a refresh started in the background. */
const settle = () => new Promise((r) => setTimeout(r, 20));

const METRICS = [
	{
		timestamp: minutesAgo(2),
		event: "turn_start",
		mode: "lead",
		role: "backend",
		l0_hit_count: 1,
		injected_tokens_est: 200,
	},
];
const CHANGELOG = [
	{
		timestamp: minutesAgo(3),
		source: "queue_done",
		role: "backend",
		taskId: "backend#147",
		uri: "viking://session/147",
		action: "session_commit",
		summary: "task #147 commit",
	},
];

const lsCalls = (fake: ReturnType<typeof daemon>) => fake.calls.filter((c) => c.url.pathname === "/api/v1/fs/ls");
const allNull = (counts: Record<string, number | null>) => Object.values(counts).every((v) => v === null);

describe("Offline only when /health fails, and the memory walk is cached (Backend #147)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	/** One client = one server process: its own transport, its own held tree, its own pinned clock. */
	const setup = (mode: DaemonMode = "up") => {
		const dir = mkdtempSync(join(tmpdir(), "ov-reach-"));
		dirs.push(dir);
		writeFileSync(join(dir, "metrics.jsonl"), jsonl(METRICS));
		writeFileSync(join(dir, "memory-changelog.jsonl"), jsonl(CHANGELOG));
		const fake = daemon(mode);
		const clock = { t: NOW };
		const client = createOpenVikingClient({
			stateDir: dir,
			fetchImpl: fake.fetchImpl,
			timeoutMs: 50,
			now: () => clock.t,
		});
		return { fake, clock, client };
	};

	// (a)
	it("/health ok with one fs/ls past its deadline: live, never Offline, only the tree-fed counts null", async () => {
		const { fake, client } = setup("up");
		fake.state.hangLsMatching = "viking://user/ops/memories";

		const o = await client.getOverview();

		expect(o.screen_state).not.toBe("error");
		expect(["live", "stale"]).toContain(o.screen_state);
		expect(o.health_state).not.toBe("server-unreachable");
		expect(o.observer.mode_label).toBe("Active");
		expect(o.observer.health_state).not.toBe("server-unreachable");
		// The hung listing feeds the personal layer only: unmeasured there, untouched everywhere else.
		expect(o.observer.role_memory_folder_count).toBeNull();
		expect(allNull(o.observer.store_counts.layer2_personal)).toBe(true);
		expect(o.observer.store_counts.layer1_shared.repo_trees_count).toBe(1);
		expect(o.observer.store_counts.layer1_shared.craft_preference_domains_count).toBe(1);
		expect(o.observer.daemon_bind).toBe("127.0.0.1:1933");
		expect(o.observer.last_reachable_at).toBe(iso(NOW));
		expect(o.observer.checked_at).toBe(iso(NOW));
		expect(o.metrics.turns_sampled_24h).toBe(1);
		expect(o.changelog.session_commits_24h).toBe(1);
	});

	// (b)
	it("/health failing keeps R-FAIL: every :1933 field null, screen_state error, JSONL panels still counted", async () => {
		for (const mode of ["down", "hang", "unhealthy"] as const) {
			const { client } = setup(mode);
			const o = await client.getOverview();

			expect(o).toMatchObject({ screen_state: "error", health_state: "server-unreachable" });
			expect(o.observer).toMatchObject({
				mode_label: "Offline",
				health_state: "server-unreachable",
				stale_badge: null,
				role_memory_folder_count: null,
				queue_depth: null,
				retrieval_latency_avg_ms: null,
				retrieval_hit_rate_pct: null,
				last_reachable_at: null,
			});
			expect(allNull(o.observer.store_counts.layer1_shared)).toBe(true);
			expect(allNull(o.observer.store_counts.layer2_personal)).toBe(true);
			expect(o.metrics.turns_sampled_24h).toBe(1);
			expect(o.changelog.session_commits_24h).toBe(1);
			expect(o.changelog.last_event_at).toBe(minutesAgo(3));
		}
	});

	// (c)
	it("never claims unreachable with a last_reachable_at later than its own checked_at (#144 fingerprint)", async () => {
		const holds = (o: OpenVikingOverviewResponse) =>
			o.observer.health_state !== "server-unreachable" ||
			o.observer.last_reachable_at === null ||
			Date.parse(o.observer.last_reachable_at) <= Date.parse(o.observer.checked_at);

		// The #144 shape on a real clock: /health answers ok inside the same request a listing hangs in.
		const hung = setup("up");
		hung.fake.state.hangLsMatching = "viking://user/ops/memories";
		const real = createOpenVikingClient({
			stateDir: mkdtempSync(join(tmpdir(), "ov-reach-real-")),
			fetchImpl: hung.fake.fetchImpl,
			timeoutMs: 50,
		});
		dirs.push(real.stateDir);
		for (const o of [await real.getOverview(), await hung.client.getOverview()]) expect(holds(o)).toBe(true);
		for (const mode of ["down", "hang", "unhealthy"] as const) {
			const { client } = setup(mode);
			expect(holds(await client.getOverview())).toBe(true);
		}

		// Asserted, not merely unreachable in practice: the impossible pair fails loudly instead of being served.
		const back = setup("up");
		back.clock.t = NOW + 10 * 60_000;
		await back.client.getOverview();
		back.fake.state.mode = "down";
		back.clock.t = NOW;
		await expect(back.client.getOverview()).rejects.toThrow(/unreachable/i);
	});

	// (d)
	it("two concurrent overviews on a cold cache make exactly one walk, and answer the same counts", async () => {
		const solo = setup("up");
		await solo.client.getOverview();
		const oneWalk = lsCalls(solo.fake).length;
		expect(oneWalk).toBeGreaterThan(10);

		const pair = setup("up");
		const [a, b] = await Promise.all([pair.client.getOverview(), pair.client.getOverview()]);

		expect(lsCalls(pair.fake)).toHaveLength(oneWalk);
		expect(a.observer.store_counts).toEqual(b.observer.store_counts);
		expect(a.observer.role_memory_folder_count).toBe(OPENVIKING_ROLES.length);
		expect(b.observer.role_memory_folder_count).toBe(OPENVIKING_ROLES.length);
	});

	// (e)
	it("a second overview inside the cadence makes no fs/ls call: /health + /observer/system only", async () => {
		const { fake, clock, client } = setup("up");
		await client.getOverview();
		const before = fake.calls.length;

		clock.t = NOW + OVERVIEW_OBSERVER_CADENCE_MS;
		const warm = await client.getOverview();

		const fresh = fake.calls.slice(before);
		expect(fresh.filter((c) => c.url.pathname === "/api/v1/fs/ls")).toHaveLength(0);
		expect(fresh.map((c) => c.url.pathname).sort()).toEqual(["/api/v1/observer/system", "/health"]);
		expect(warm.observer.role_memory_folder_count).toBe(OPENVIKING_ROLES.length);
		expect(warm.observer.store_counts.layer1_shared.repo_trees_count).toBe(1);
	});

	// (f)
	it("a tree past the age bound answers null counts, never the old figures; a stale one inside it still answers", async () => {
		const { fake, clock, client } = setup("up");
		expect((await client.getOverview()).observer.store_counts.layer1_shared.repo_trees_count).toBe(1);

		// Older than the cadence but inside the bound: the last good tree answers while one refresh runs.
		clock.t = NOW + OVERVIEW_OBSERVER_CADENCE_MS + 1;
		const held = await client.getOverview();
		expect(held.observer.role_memory_folder_count).toBe(OPENVIKING_ROLES.length);
		await settle();

		// Past the bound: no figure is served, because an old count shown as current is a false figure.
		const stamped = clock.t;
		clock.t = stamped + MEMORY_TREE_MAX_SERVE_AGE_MS + 1;
		const tooOld = await client.getOverview();
		expect(tooOld.screen_state).not.toBe("error");
		expect(tooOld.observer.mode_label).toBe("Active");
		expect(tooOld.observer.role_memory_folder_count).toBeNull();
		expect(allNull(tooOld.observer.store_counts.layer1_shared)).toBe(true);
		expect(allNull(tooOld.observer.store_counts.layer2_personal)).toBe(true);

		// And it is not a dead end: the refresh that request started answers the next one.
		await settle();
		const refreshed = await client.getOverview();
		expect(refreshed.observer.role_memory_folder_count).toBe(OPENVIKING_ROLES.length);
		expect(refreshed.observer.store_counts.layer1_shared.repo_trees_count).toBe(1);
		expect(lsCalls(fake).length).toBeGreaterThan(0);
	});
});
