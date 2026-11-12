/**
 * Backend #155 (architecture ruling rm-8e4a1631): `GET /api/openviking/entries` serves a background snapshot.
 *
 * Live on 0e2095de every request fanned out ~1860 `:1933` reads: median 21 s, p90 61 s, max 81 s per load. The
 * listing is now built in the background — at server start and once per `15m` cadence, never two builds at once —
 * and a request answers from the latest finished build: `panel_updated_at` is when it finished, the `scope`/`role`
 * filters slice it, and `entries_partial`/`unread_count` describe that build (spec 2500874d §3a, unchanged).
 * `/health` stays live per request and alone decides `server-unreachable`; `?uri=` stays a live single read; a
 * failed build keeps the last good snapshot, whose age shows as `"> 15m"` past the cadence (the #149 rule).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenVikingDaemonHttp } from "../../server/openviking/daemon-http.js";
import { buildEntries } from "../../server/openviking/entries.js";
import { type OpenVikingEntriesBuild, OpenVikingEntriesSnapshot } from "../../server/openviking/entries-snapshot.js";
import {
	createOpenVikingClient,
	ENTRIES_CADENCE_MS,
	handleOpenVikingEntriesRequest,
	OPENVIKING_ROLES,
	resolveOpenVikingStatePaths,
} from "../../server/openviking/index.js";
import { type DaemonCall, daemon, minutesAgo, NOW } from "./openviking-daemon-fake.js";

const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const METRICS = [{ timestamp: minutesAgo(2), event: "turn_start", mode: "lead", role: "backend", l0_hit_count: 1 }];
const SHARED_URI = "viking://user/default/memories/preferences/backend_code.md";
const ALL_ROWS = 2 + OPENVIKING_ROLES.length;
const UNITS_ALL = 2 + OPENVIKING_ROLES.length;
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** The reads a listing build makes; `/health` is the one read a request still makes live. */
const listingReads = (calls: DaemonCall[]) =>
	calls.filter((c) => c.url.pathname === "/api/v1/fs/ls" || c.url.pathname.startsWith("/api/v1/content/"));
const listingsOf = (calls: DaemonCall[], uri: string) =>
	calls.filter((c) => c.url.pathname === "/api/v1/fs/ls" && c.url.searchParams.get("uri") === uri);

describe("/entries serves a background snapshot (Backend #155)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		vi.useRealTimers();
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	/** One client = one server process; its clock moves 1 ms per daemon call, so a build ends after it starts. */
	const setup = () => {
		const dir = mkdtempSync(join(tmpdir(), "ov-entries-snapshot-"));
		dirs.push(dir);
		writeFileSync(join(dir, "metrics.jsonl"), jsonl(METRICS));
		writeFileSync(join(dir, "memory-changelog.jsonl"), "");
		const fake = daemon("up");
		const clock = { t: NOW };
		const fetchImpl: typeof fetch = (input, init) => {
			clock.t += 1;
			return fake.fetchImpl(input, init);
		};
		const client = createOpenVikingClient({ stateDir: dir, fetchImpl, timeoutMs: 50, now: () => clock.t });
		return { fake, clock, client };
	};

	it("(a) two concurrent cold requests share one listing build", async () => {
		const { fake, client } = setup();

		const [all, again, qa] = await Promise.all([
			client.getEntries({ scope: "all" }),
			client.getEntries({ scope: "all" }),
			client.getEntries({ scope: "agent", role: "qa" }),
		]);

		expect(listingsOf(fake.calls, "viking://resources")).toHaveLength(1);
		expect(listingsOf(fake.calls, "viking://user/qa/memories")).toHaveLength(1);
		expect(all.entries).toHaveLength(ALL_ROWS);
		expect(again.entries).toEqual(all.entries);
		expect(qa.entries.map((e) => e.role)).toEqual(["qa"]);
		expect(all.panel_updated_at).toBe(qa.panel_updated_at);
	});

	it("(b) a request after the first build answers in under 1 s with no listing read, stamped with the build", async () => {
		const { fake, clock, client } = setup();
		await client.getEntries({ scope: "all" });
		const builtAt = clock.t;
		const readsAfterBuild = listingReads(fake.calls).length;
		clock.t += 5 * MIN;

		const started = performance.now();
		const res = await client.getEntries({ scope: "all" });
		const elapsedMs = performance.now() - started;

		expect(elapsedMs).toBeLessThan(1_000);
		expect(listingReads(fake.calls)).toHaveLength(readsAfterBuild);
		expect(fake.calls.at(-1)?.url.pathname).toBe("/health");
		expect(res.panel_updated_at).toBe(iso(builtAt));
		expect(res).toMatchObject({ health_state: "healthy", stale_badge: null, entries_partial: false });
		expect(res.entries).toHaveLength(ALL_ROWS);
	});

	it("(c) scope and role filters slice the snapshot, with no build of their own", async () => {
		const { fake, client } = setup();
		fake.state.errorLsRoles = ["qa"];
		const all = await client.getEntries({ scope: "all" });
		expect(all).toMatchObject({ entries_partial: true, unread_count: 1 });
		const reads = listingReads(fake.calls).length;
		fake.state.errorLsRoles = [];

		const resources = await client.getEntries({ scope: "resources" });
		const user = await client.getEntries({ scope: "user" });
		const agent = await client.getEntries({ scope: "agent" });
		const ops = await client.getEntries({ scope: "agent", role: "ops" });
		const qa = await client.getEntries({ scope: "agent", role: "qa" });
		const allOps = await client.getEntries({ scope: "all", role: "ops" });

		expect(listingReads(fake.calls)).toHaveLength(reads);
		expect(resources.entries.map((e) => e.scope)).toEqual(["resources"]);
		expect(user.entries.map((e) => e.canonical_uri)).toEqual([SHARED_URI]);
		expect(agent.entries).toHaveLength(OPENVIKING_ROLES.length - 1);
		expect(ops.entries.map((e) => e.role)).toEqual(["ops"]);
		expect(allOps.entries.map((e) => e.scope)).toEqual(["resources", "user", "agent"]);
		// Each slice declares the unread units of its own scope only (§3a): qa's tree is the one unit unread.
		for (const [res, unread] of [
			[resources, 0],
			[user, 0],
			[agent, 1],
			[ops, 0],
			[qa, 1],
			[allOps, 0],
		] as const) {
			expect(res.unread_count).toBe(unread);
			expect(res.entries_partial).toBe(unread > 0);
		}
		expect(qa.entries).toHaveLength(0);
	});

	it("(d) a failed build keeps the last good snapshot, badged '> 15m' once it is past the cadence", async () => {
		const { fake, clock, client } = setup();
		await client.getEntries({ scope: "all" });
		const builtAt = clock.t;

		// A build whose listings all fail is partial, and never replaces a complete snapshot.
		clock.t += 5 * MIN;
		fake.state.failAllLs = true;
		await client.refreshEntries();
		// A build that finds `/health` refused is a failed build.
		fake.state.mode = "down";
		await client.refreshEntries();
		fake.state.mode = "up";

		const inCadence = await client.getEntries({ scope: "all" });
		expect(inCadence).toMatchObject({
			panel_updated_at: iso(builtAt),
			health_state: "healthy",
			stale_badge: null,
			entries_partial: false,
			unread_count: 0,
		});
		expect(inCadence.entries).toHaveLength(ALL_ROWS);

		clock.t += ENTRIES_CADENCE_MS;
		await client.refreshEntries();
		const pastCadence = await client.getEntries({ scope: "all" });
		expect(pastCadence).toMatchObject({
			panel_updated_at: iso(builtAt),
			health_state: "stale",
			stale_badge: "> 15m",
			entries_partial: false,
		});
		expect(pastCadence.entries).toHaveLength(ALL_ROWS);

		// The next good build replaces it, and the badge clears.
		fake.state.failAllLs = false;
		await client.refreshEntries();
		const rebuilt = await client.getEntries({ scope: "all" });
		expect(Date.parse(rebuilt.panel_updated_at)).toBeGreaterThan(builtAt);
		expect(rebuilt).toMatchObject({ health_state: "healthy", stale_badge: null });
	});

	it("(e) /health refused is R-FAIL whatever the snapshot holds; back up, the snapshot answers again", async () => {
		const { fake, clock, client } = setup();
		await client.getEntries({ scope: "all" });
		const builtAt = clock.t;
		const reads = listingReads(fake.calls).length;

		fake.state.mode = "down";
		const down = await client.getEntries({ scope: "all" });
		expect(down).toMatchObject({ health_state: "server-unreachable", stale_badge: null, entries: [] });
		expect(down).toMatchObject({ entries_partial: true, unread_count: UNITS_ALL });
		expect(await client.getEntries({ scope: "agent", role: "qa" })).toMatchObject({ unread_count: 1 });

		fake.state.mode = "up";
		const back = await client.getEntries({ scope: "all" });
		expect(back.panel_updated_at).toBe(iso(builtAt));
		expect(back.entries).toHaveLength(ALL_ROWS);
		expect(listingReads(fake.calls)).toHaveLength(reads);
	});

	it("(f) ?uri= is a live single read that neither builds nor touches the snapshot", async () => {
		const { fake, clock, client } = setup();
		await client.getEntries({ scope: "all" });
		const builtAt = clock.t;
		const before = fake.calls.length;

		const one = await client.getEntries({ uri: SHARED_URI });
		const detailListings = fake.calls.slice(before).filter((c) => c.url.pathname === "/api/v1/fs/ls");
		expect(detailListings.map((c) => c.url.searchParams.get("uri"))).toEqual([
			"viking://user/default/memories/preferences",
		]);
		expect(one.entries.map((e) => e.canonical_uri)).toEqual([SHARED_URI]);

		// Live: the daemon now refuses that listing, so the detail read fails...
		fake.state.errorLsMatching = "/default/memories/preferences";
		const failed = await handleOpenVikingEntriesRequest(client, { uri: SHARED_URI }, "GET");
		expect(failed.status).toBeGreaterThanOrEqual(400);
		// ...while the list still answers from the snapshot, with no read of its own.
		const reads = listingReads(fake.calls).length;
		const list = await client.getEntries({ scope: "all" });
		expect(listingReads(fake.calls)).toHaveLength(reads);
		expect(list.panel_updated_at).toBe(iso(builtAt));
		expect(list.entries.some((e) => e.canonical_uri === SHARED_URI)).toBe(true);
	});

	it("(g) the cadence timer starts one build per tick and never overlaps two", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		let builds = 0;
		let running = 0;
		let maxRunning = 0;
		const finish: (() => void)[] = [];
		const build = (): Promise<OpenVikingEntriesBuild> => {
			builds += 1;
			running += 1;
			maxRunning = Math.max(maxRunning, running);
			return new Promise((resolve) =>
				finish.push(() => {
					running -= 1;
					resolve({ entries: [], unread_units: new Set(), finished_at_ms: builds });
				}),
			);
		};
		const flush = () => new Promise((r) => setTimeout(r, 0));
		const snapshot = new OpenVikingEntriesSnapshot(build);

		snapshot.start(ENTRIES_CADENCE_MS);
		snapshot.start(ENTRIES_CADENCE_MS);
		expect(builds).toBe(1);
		// A request before the first build finishes joins it.
		const early = snapshot.read();
		// A tick while the start build still runs joins it, never a second build.
		vi.advanceTimersByTime(ENTRIES_CADENCE_MS);
		expect(builds).toBe(1);
		finish.shift()?.();
		expect((await early)?.finished_at_ms).toBe(1);

		vi.advanceTimersByTime(ENTRIES_CADENCE_MS);
		expect(builds).toBe(2);
		vi.advanceTimersByTime(ENTRIES_CADENCE_MS - 1);
		expect(builds).toBe(2);
		finish.shift()?.();
		await flush();
		vi.advanceTimersByTime(1);
		expect(builds).toBe(3);
		finish.shift()?.();
		await flush();
		expect(maxRunning).toBe(1);
		expect((await snapshot.read())?.finished_at_ms).toBe(3);

		snapshot.stop();
		vi.advanceTimersByTime(3 * ENTRIES_CADENCE_MS);
		expect(builds).toBe(3);
	});
});

/**
 * Backend #157 (QA #136 F5): the next build starts every cadence and its finish time becomes `panel_updated_at`,
 * so for the whole of every build the held snapshot is past one cadence. While a build runs the list reads stale
 * only past 2 cadences (`30m`); with none running it stays 1 cadence (`15m`), so a failed or hung build still
 * shows `"> 15m"`.
 */
describe("/entries is not stale while its next build runs (Backend #157)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const ENTRY = {
		uri: "viking://resources/pi-web-ui/README.md",
		canonical_uri: "viking://resources/pi-web-ui/README.md",
		title: "README.md",
		category: "repository",
		scope: "resources",
		layer: "layer1_shared",
		role: null,
		layers: ["L0"],
		l0_abstract: null,
		l1_overview: null,
		l2_content: null,
		updated_at: null,
		provenance: null,
	} as const satisfies OpenVikingEntriesBuild["entries"][number];

	/** A fake clock and a fake builder: the first build finishes at once, each later one when the test settles it. */
	const setup = async () => {
		const dir = mkdtempSync(join(tmpdir(), "ov-entries-rebuild-"));
		dirs.push(dir);
		const clock = { t: NOW };
		const pending: ((next: OpenVikingEntriesBuild | null) => void)[] = [];
		let builds = 0;
		const snapshot = new OpenVikingEntriesSnapshot(() => {
			builds += 1;
			if (builds === 1) return Promise.resolve({ entries: [ENTRY], unread_units: new Set(), finished_at_ms: NOW });
			return new Promise((resolve) => pending.push(resolve));
		});
		await snapshot.refresh();
		const http = new OpenVikingDaemonHttp("http://127.0.0.1:1933", 50, daemon("up").fetchImpl, () => clock.t);
		const paths = resolveOpenVikingStatePaths(dir);
		const list = () => buildEntries(http, snapshot, paths, { scope: "all" }, () => clock.t);
		return { clock, snapshot, pending, list };
	};

	it("(a) 16m old with the next build running -> healthy, no badge", async () => {
		const { clock, snapshot, pending, list } = await setup();
		clock.t = NOW + 16 * MIN;
		const rebuild = snapshot.refresh();

		const res = await list();

		expect(pending).toHaveLength(1);
		expect(res).toMatchObject({ panel_updated_at: iso(NOW), health_state: "healthy", stale_badge: null });
		expect(res.entries).toEqual([ENTRY]);
		pending.shift()?.(null);
		await rebuild;
	});

	it("(b) the build failed and the held one is 16m old -> '> 15m'", async () => {
		const { clock, snapshot, pending, list } = await setup();
		clock.t = NOW + 16 * MIN;
		const rebuild = snapshot.refresh();
		pending.shift()?.(null);
		await rebuild;

		const res = await list();

		expect(res).toMatchObject({ panel_updated_at: iso(NOW), health_state: "stale", stale_badge: "> 15m" });
		expect(res.entries).toEqual([ENTRY]);
	});

	it("(c) the next build still running at 31m -> '> 15m'", async () => {
		const { clock, snapshot, pending, list } = await setup();
		clock.t = NOW + 15 * MIN + 1;
		const rebuild = snapshot.refresh();
		clock.t = NOW + 31 * MIN;

		const res = await list();

		expect(pending).toHaveLength(1);
		expect(res).toMatchObject({ panel_updated_at: iso(NOW), health_state: "stale", stale_badge: "> 15m" });
		pending.shift()?.(null);
		await rebuild;
	});
});
